// The Strategy Builder page (#/strategy, PRD 02). desk.js owns the toolbar, the shared state and the 3 s refresh; this
// file builds the builder once per visit and patches it on every tick: leg prices, figures, the payoff paths and the
// scenario cells change in place, so sliders, focus and scroll never reset. The maths is in options.js (pure, tested),
// drawing in payoff.js, placement in strategy-place.js. Numbers become text only through format.js.
import { api, app, h, icon, modal, optional, toast } from "./app.js";
import { DASH, formatCompact, formatFixed, formatInt, formatPercent, formatSigned, isFigure } from "./format.js";
import * as O from "./options.js";
import { drawPayoff, money, moneyEl } from "./payoff.js";
import { openPlacement } from "./strategy-place.js";
import { keepFocus, segmented } from "./views.js";

const SAVES = "mcb.dashboard.strategies";
const YEAR_MS = 365 * 86400000;
const PRIMARY = ["maxProfit", "maxLoss", "breakevens", "pop"];
const KEYS = [
  [["A"], "Add a leg: the strike picker"],
  [["[", "]"], "Shift every strike down / up one step"],
  [["⇧P"], "Place: opens the confirm sheet"],
  [["Ctrl S"], "Save this strategy"],
  [["Ctrl Z"], "Undo the last preset, clear, remove or load"],
  [["1–5"], "Preset group: Bullish … Hedge & arb"],
  [["T"], "Target-date slider"],
  [["P"], "Pause / resume live prices"],
  [["?"], "This list"],
];
const DAY = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
const WHEN = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const SAVED_AT = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const expiryText = (e) => (/^\d{4}-\d{2}-\d{2}$/.test(e ?? "") ? DAY.format(new Date(`${e}T00:00:00Z`)) : e ?? "");
const when = (ms) => WHEN.format(new Date(ms)).replace(",", "");
const media = (q) => (typeof matchMedia === "function" ? matchMedia(q).matches : false);
const isPhone = () => media("(max-width: 719px)");
const isTouch = () => media("(pointer: coarse)");
/** A leg held as a position (its entry is the average price): previews and margin use the closing side. */
const isHeld = (l) => l.entry !== undefined && l.entry !== null && l.entryTag !== "saved";
const num = (v) => (isFigure(v) ? Number(v) : null);
/** "1d 4h" / "4h 15m" / "45m" */
function span(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(m / 1440);
  const hh = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  return d ? `${d}d ${hh}h` : hh ? `${hh}h ${mm}m` : `${mm}m`;
}
const plural = (n, one, many = `${one}s`) => `${formatInt(n)} ${n === 1 ? one : many}`;

/**
 * @param {{ st: object, save: () => void, account: () => object|null, refresh: () => void, switchTo: (u: string, e: string) => Promise<void>, onPositions: () => void }} o
 */
export function createBuilder({ st, save, account, refresh, switchTo, onPositions }) {
  st.scfg = O.strategyConfig(st.scfg);
  st.whatIf = st.whatIf && typeof st.whatIf === "object" ? { target: num(st.whatIf.target), ivShift: num(st.whatIf.ivShift) ?? 0 } : { target: null, ivShift: 0 };
  const cfg = () => st.scfg;
  const wi = st.whatIf;
  const key = () => `${st.underlying}|${st.expiry}`;
  let x = null; // the desk's context for the last tick
  let priced = []; // legs with prices, from the last tick
  let R = null; // the figures, from the last draw
  let undo = null;
  let funds = { free: null, error: null };
  let pv = { sig: "", margin: null, loading: false, freeze: new Map(), failed: false };
  let pvTimer = null;
  let raf = 0;
  let range = null;
  let rangeSig = "";
  let legsSig = null;
  let chipsSig = "";
  let picker = null;
  let pop = null;
  let noChain = null; // null while loading; else why there is no chain to build on ("error" | a no-strikes message)

  // ── Draft legs (data model v2, migrated in place) ──
  function legs() {
    const k = key();
    const cur = st.baskets[k];
    const lot = num(st.chain?.lotSize);
    if (!Array.isArray(cur) || cur.some((l) => !l.id || !l.kind || (!l.lotSize && lot) || l.on === undefined)) st.baskets[k] = O.migrateLegs(cur, st.expiry, { lotSize: lot });
    return st.baskets[k];
  }
  function setLegs(next, { undoLabel = null, keepWhatIf = true } = {}) {
    if (undoLabel) undo = { key: key(), legs: structuredClone(legs()), label: undoLabel };
    st.baskets[key()] = O.migrateLegs(next, st.expiry, { lotSize: num(st.chain?.lotSize) });
    if (!keepWhatIf) {
      wi.target = null;
      wi.ivShift = 0;
    }
    save();
    changed();
    if (undoLabel) undoToast(undoLabel);
  }
  function mutate(fn, opts) {
    const next = structuredClone(legs());
    if (fn(next) === false) return;
    setLegs(next, opts);
  }
  function undoToast(label) {
    toast(h("span", { class: "toast-undo-row" }, `${label} · `, h("button", { type: "button", class: "toast-undo", onclick: () => doUndo() }, "Undo")));
  }
  function doUndo() {
    if (!undo) return toast("Nothing to undo");
    const u = undo;
    undo = null;
    st.baskets[u.key] = u.legs;
    save();
    if (u.key !== key()) {
      const [uu, ee] = u.key.split("|");
      switchTo(uu, ee);
    } else changed();
    toast(`Undone: ${u.label}`);
  }

  // ── Pricing (per tick) ──
  const fut = () => (x ? st.futures.find((f) => f.expiry >= x.c.expiry) ?? null : null);
  function quoteOf(l) {
    if (l.kind === "FUT") return l.symbol ? st.quotes.get(l.symbol) ?? null : null;
    return st.chain?.rows.find((r) => r.strike === l.strike)?.[l.right === "CE" ? "ce" : "pe"] ?? null;
  }
  function price(xx) {
    const atmIv = num(xx.sm.atmIv);
    const now = Date.now();
    return legs().map((l) => {
      const q = quoteOf(l);
      const row = l.kind === "OPT" ? xx.c.rows.find((r) => r.strike === l.strike) : null;
      const bp = l.entry !== undefined && l.entry !== null ? { price: l.entry, fallback: false } : O.basisPrice(q, l.side, cfg().basis);
      const iv = num(q?.iv);
      const lotSize = num(l.lotSize) || xx.lot;
      const symbol = q?.symbol ?? l.symbol ?? null;
      const p = {
        ...l,
        symbol,
        lotSize,
        q,
        price: bp.price,
        fallback: bp.fallback,
        iv: iv ?? atmIv,
        ivFallback: iv === null && l.kind === "OPT",
        years: O.yearsToExpiry(l.expiry ?? xx.c.expiry, now),
        inChain: l.kind === "FUT" || Boolean(row),
        spreadPct: O.spreadPct(q),
        freezeQty: pv.freeze.get(symbol) ?? null,
        label: O.legLabel(l),
      };
      if (l.kind === "FUT") {
        const f = st.futures.find((ff) => ff.symbol === l.symbol);
        p.basis0 = num(q?.ltp) !== null && xx.spot !== null ? q.ltp - xx.spot : 0;
        p.futYears = O.yearsToExpiry(l.expiry ?? f?.expiry, now);
        p.freezeQty = p.freezeQty ?? f?.freezeQty ?? null;
      }
      return p;
    });
  }

  // ── Figures (per tick, and per animation frame while a slider moves: no network) ──
  function compute() {
    const xx = x;
    const all = priced;
    const act = all.filter((l) => l.on !== false);
    const missing = act.filter((l) => l.price === null);
    const ok = act.length > 0 && missing.length === 0;
    const now = Date.now();
    const T = Math.max(0, xx.years ?? 0);
    const expMs = O.expiryCloseMs(xx.c.expiry) ?? now;
    if (wi.target !== null && wi.target <= now) wi.target = null;
    const targetMs = wi.target === null ? now : Math.min(wi.target, expMs);
    const el = Math.max(0, Math.min(T, (targetMs - now) / YEAR_MS));
    const shift = wi.ivShift;
    const lot = xx.lot;
    const ivNow = num(xx.sm.atmIv) !== null ? Math.max(1, xx.sm.atmIv + shift) : null;
    const ch = ok ? O.charges(act, O.CHARGE_RATES, { lotSize: lot }) : null;
    // Net of charges: exit charges are held inside the strikes ± 3σ, so the S = 0 / 2 × top tails cannot inflate max loss.
    const net = ok && cfg().net ? O.strategyCharges(act, O.CHARGE_RATES, { lotSize: lot, forward: xx.F, ivPct: ivNow, years: T }) : null;
    const base = { forward: xx.F, ivPct: xx.sm.atmIv, years: T, ivShift: shift, spot: xx.spot };
    const stats = ok ? O.strategyStats(act, lot, { ...base, charges: net }) : null;
    const expiryToday = O.isExpiryDay(xx.c.expiry);
    const est = ok ? O.marginEstimate(act, lot, { forward: xx.F, years: T, expiryToday }) : null;
    const acct = pv.sig === sigOf(act) ? pv.margin : null;
    const margin = acct ?? est?.required ?? null;
    const basis = xx.F !== null && xx.spot !== null ? xx.F - xx.spot : 0;
    const vt = ok && xx.spot !== null ? O.valueAt(act, xx.spot, lot, null, basis, { el, ivShift: shift }) : null;
    const atTarget = vt === null ? null : vt - (net?.entry ?? 0);
    const greeks = ok && xx.spot !== null ? O.netGreeksModel(act, xx.spot, { lotSize: lot, basis, el, ivShift: shift }) : null;
    const ev = ok ? O.expectedValue(act, lot, { forward: xx.F, ivPct: xx.sm.atmIv, years: T, ivShift: shift, charges: net }) : null;
    const ratios = O.strategyRatios({ maxProfit: stats?.maxProfit ?? null, maxLoss: stats?.maxLoss ?? null, margin, locked: stats?.locked ?? null, net: stats?.net ?? null, years: T });
    const b1 = O.sigmaBand(xx.F, ivNow, T, 1);
    const rs = act.map((l) => (l.kind === "FUT" ? "F" : l.strike)).sort().join() + `|${xx.sm.atm}|${act.length}`;
    if (rs !== rangeSig) {
      rangeSig = rs;
      range = null;
    }
    const model = ok ? O.payoffModel(act, { lotSize: lot, spot: xx.spot, forward: xx.F, years: T, el, ivShift: shift, ivPct: xx.sm.atmIv, charges: net, range }) : null;
    if (model && !range) range = { lo: model.lo, hi: model.hi };
    // Closing held legs releases margin: no shortfall check. Otherwise the account's own figure blocks, the estimate warns.
    const exit = closeMode();
    const warnings = O.strategyWarnings({ legs: act, strikes: xx.c.rows.map((r) => r.strike), stats, spot: xx.spot, band1: b1, margin: exit ? null : { required: margin, free: funds.free, source: acct !== null ? "account" : "estimate" }, live: false, expiryToday, lotSize: lot, legCount: all.length });
    return { all, act, missing, ok, T, el, expMs, targetMs, shift, lot, ch, net, stats, est, acct, margin, atTarget, greeks, ev, ratios, model, warnings, expiryToday, b1, ivNow, exit };
  }
  const sigOf = (act) => JSON.stringify([st.account, cfg().product, act.map((l) => [l.symbol, l.side, l.lots, isHeld(l)])]);

  // ── DOM: built once ──
  const ctxLine = h("span", { class: "strat-ctx" });
  const savedBtn = h("button", { type: "button", class: "small plain head-txt", onclick: () => openSaved() }, "Saved");
  const saveBtn = h("button", { type: "button", class: "small plain head-txt", title: "Save (Ctrl S)", onclick: () => openSave() }, "Save");
  const clearBtn = h("button", { type: "button", class: "small plain head-txt", onclick: () => clearAll() }, "Clear");
  const gearBtn = h("button", { type: "button", class: "small gear-btn head-txt", "aria-haspopup": "dialog", "aria-label": "Customise the builder", title: "Customise: figures, prices, charges" }, icon("sliders"), h("span", { class: "gear-label" }, "Customise"));
  const moreBtn = h("button", { type: "button", class: "icon-btn head-more", "aria-label": "More: saved, save, clear, customise", onclick: () => openHeadMenu() }, icon("more"));
  const placeBtn = h("button", { type: "button", class: "small primary head-place", onclick: () => place() }, "Place");
  gearBtn.addEventListener("click", () => openCustomise());
  const head = h("header", { class: "panel-head strat-head" }, h("div", { class: "strat-title" }, h("h2", {}, "Strategy"), ctxLine), h("div", { class: "strat-actions" }, savedBtn, saveBtn, clearBtn, gearBtn, moreBtn, placeBtn));

  // Presets
  const groupSeg = segmented("Preset group", O.PRESET_GROUPS, cfg().group);
  groupSeg.classList.add("group-seg");
  groupSeg.addEventListener("change", () => {
    if (groupSeg.value === cfg().group) return;
    setCfg({ group: groupSeg.value });
    chipsSig = "";
    drawChips();
  });
  const chips = h("div", { class: "preset-chips", role: "group", "aria-label": "Strategies in this group" });
  const presetsEl = h("div", { class: "strat-presets" }, h("div", { class: "hscroll" }, groupSeg), h("div", { class: "hscroll chips-wrap" }, chips));

  // Legs
  const legsEl = h("div", { class: "strat-legs", role: "list", "aria-label": "Legs" });
  const emptyLegs = h("p", { class: "desk-empty strat-empty" });
  const addBtn = h("button", { type: "button", class: "small tinted add-leg", "aria-haspopup": "dialog", title: "Add a leg (A)" }, icon("plus"), "Add leg");
  addBtn.addEventListener("click", () => openPicker());
  const shiftDn = h("button", { type: "button", class: "small plain step-btn", "aria-label": "Shift every strike down one step", title: "Shift strikes down ([)", onclick: () => shift(-1) }, "‹");
  const shiftUp = h("button", { type: "button", class: "small plain step-btn", "aria-label": "Shift every strike up one step", title: "Shift strikes up (])", onclick: () => shift(1) }, "›");
  const halfBtn = h("button", { type: "button", class: "small plain", "aria-label": "Halve every leg's lots", onclick: () => scale(0.5) }, "÷2");
  const dblBtn = h("button", { type: "button", class: "small plain", "aria-label": "Double every leg's lots", onclick: () => scale(2) }, "×2");
  const legCount = h("span", { class: "leg-count muted" });
  const tools = h("div", { class: "leg-tools" }, h("div", { class: "picker-anchor" }, addBtn), h("span", { class: "tool-group", role: "group", "aria-label": "Shift strikes" }, shiftDn, h("span", { class: "tool-lbl" }, "Shift"), shiftUp), h("span", { class: "tool-group", role: "group", "aria-label": "Scale lots" }, halfBtn, dblBtn), legCount);
  const build = h("div", { class: "strat-build" }, presetsEl, legsEl, emptyLegs, tools);

  // Figures
  const metricsEl = h("dl", { class: "desk-stats strat-metrics" });
  const moreFigs = h("button", { type: "button", class: "small plain more-figs", "aria-expanded": "false", onclick: () => setCfg({ moreOpen: !cfg().moreOpen }) });
  const warnEl = h("ul", { class: "ticket-checks strat-warns", "aria-label": "Warnings" });
  const chartHost = h("div", { class: "payoff strat-payoff" });
  const chart = drawPayoff(chartHost, null);
  // What-if
  const tSlider = h("input", { type: "range", min: "0", max: "0", step: "15", value: "0", class: "wi-range", "aria-label": "Target date" });
  const tLabel = h("span", { class: "wi-val" });
  const ivSlider = h("input", { type: "range", min: "-10", max: "10", step: "0.5", value: String(wi.ivShift), class: "wi-range", "aria-label": "IV shift in vol points" });
  const ivLabel = h("span", { class: "wi-val" });
  const resetWi = h("button", { type: "button", class: "small plain wi-reset", onclick: () => ((wi.target = null), (wi.ivShift = 0), (ivSlider.value = "0"), save(), drawAnalysis()) }, "Reset");
  const whatIf = h(
    "div",
    { class: "strat-whatif" },
    h("label", { class: "wi wi-t" }, h("span", { class: "wi-head" }, h("span", { class: "wi-name" }, "Target date"), tLabel), tSlider),
    h("label", { class: "wi wi-iv" }, h("span", { class: "wi-head" }, h("span", { class: "wi-name" }, "IV shift"), ivLabel), ivSlider),
    resetWi,
  );
  const note = h("p", { class: "model-note" });
  // Scenario table
  const scenSeg = segmented("Scenario moves in", [["pct", "%"], ["sigma", "σ"]], cfg().scenario);
  scenSeg.addEventListener("change", () => setCfg({ scenario: scenSeg.value }));
  const scenBody = h("tbody");
  const scenHeadT = h("th", { scope: "col", class: "num" }, "At target");
  const scenTable = h("div", { class: "table-wrap scen-wrap" }, h("table", { class: "desk-table scen-table" }, h("caption", { class: "sr-only" }, "P&L at nine prices: at the target date and at expiry"), h("thead", {}, h("tr", {}, h("th", { scope: "col", class: "num" }, "Price"), h("th", { scope: "col", class: "num c-move" }, "Move"), scenHeadT, h("th", { scope: "col", class: "num" }, "At expiry"))), scenBody));
  // The % | σ switch sits in the summary row (right-aligned before the chevron); a click on it never toggles the fold.
  const scenTools = h("span", { class: "scen-tools" }, scenSeg);
  scenTools.addEventListener("click", (e) => e.preventDefault());
  const scen = h("details", { class: "strat-scen" }, h("summary", {}, h("span", { class: "scen-title" }, "Scenarios"), h("span", { class: "scen-sub muted" }, "P&L at nine prices"), scenTools), scenTable);
  if (media("(min-width: 1280px)")) scen.open = true;
  const analysis = h("div", { class: "strat-analysis" }, metricsEl, moreFigs, warnEl, chartHost, whatIf, note, scen);
  // Sticky action bar (phone and tablet)
  const barNet = h("strong", { class: "bar-net" });
  const barSub = h("small", { class: "bar-sub" });
  const barPlace = h("button", { type: "button", class: "primary bar-place", onclick: () => place() }, "Place");
  const bar = h("div", { class: "strat-bar" }, h("div", { class: "bar-figs" }, barNet, barSub), barPlace);
  const keysEl = h("div", { class: "desk-keys strat-keys", "aria-hidden": "true" }, [["A", "add leg"], ["[ ]", "shift"], ["⇧P", "place"], ["?", "keys"]].map(([k, t]) => h("span", { class: "kbd-pair" }, h("kbd", {}, k), t)));
  const liveRegion = h("div", { class: "sr-only", "aria-live": "polite" });
  const announce = (t) => {
    liveRegion.textContent = "";
    setTimeout(() => (liveRegion.textContent = t), 30);
  };
  const panel = h("section", { class: "desk-panel strat-panel", "data-panel": "strategy", "aria-label": "Strategy builder" }, head, h("div", { class: "strat-grid" }, build, analysis), keysEl, bar, liveRegion);

  // Chart-engine slot: collapsed by default; the engine reads window.__mcbStrategyOverlay() when it arrives.
  const slotBody = h("div", { class: "chart-slot-body", hidden: true }, h("p", { class: "muted" }, "Your strikes, breakevens and ±σ will overlay here once the chart engine is connected."));
  slotBody.dataset.chartSlot = "strategy";
  const slotBtn = h("button", { type: "button", class: "chart-slot-toggle", "aria-expanded": "false" }, h("span", { class: "slot-title" }, "Price chart · chart engine slot"), h("span", { class: "muted slot-sub" }, "Your strikes, breakevens and ±σ will overlay here once the chart engine is connected."), icon("down"));
  slotBtn.addEventListener("click", () => {
    slotBody.hidden = !slotBody.hidden;
    slotBtn.setAttribute("aria-expanded", String(!slotBody.hidden));
  });
  const slot = h("section", { class: "desk-panel chart-slot", "data-panel": "price-chart", "aria-label": "Price chart (chart engine slot)" }, slotBtn, slotBody);
  window.__mcbStrategyOverlay = () => ({
    underlying: st.underlying,
    strikes: R ? [...new Set(R.act.filter((l) => l.kind === "OPT").map((l) => l.strike))] : [],
    breakevens: R?.stats?.breakevens ?? [],
    band1: R?.model?.band1 ?? null,
    band2: R?.model?.band2 ?? null,
    spot: x?.spot ?? null,
  });

  // ── Interactions ──
  function setCfg(patch) {
    st.scfg = O.strategyConfig({ ...st.scfg, ...patch });
    save();
    if ("basis" in patch && x) priced = price(x);
    if ("metrics" in patch) metricsEl.__sig = "";
    if ("product" in patch) schedulePreviews(true);
    drawAnalysis();
  }
  function applyPreset(p) {
    if (!x) return;
    const f = fut();
    if (p.needsFut && !f) return toast(`No future found for ${st.underlying}.`);
    const raw = O.presetLegs(p.id, x.c, { move: x.move, forward: x.F, fut: f ? { symbol: f.symbol, expiry: f.expiry, lotSize: f.lotSize } : null });
    if (!raw.length) return;
    const withSyms = raw.map((l) => (l.kind === "FUT" ? l : { ...l, symbol: x.c.rows.find((r) => r.strike === l.strike)?.[l.right === "CE" ? "ce" : "pe"]?.symbol ?? null, lotSize: x.lot }));
    setLegs(withSyms, { undoLabel: `${p.name} applied`, keepWhatIf: false });
    ivSlider.value = "0";
  }
  function clearAll() {
    if (!legs().length) return;
    setLegs([], { undoLabel: "Cleared" });
  }
  function shift(dir) {
    if (!x) return;
    const ks = x.c.rows.map((r) => r.strike);
    const cur = legs();
    const next = O.shiftLegs(cur, ks, dir);
    if (next === cur) return toast("A leg is at the edge of the loaded strikes");
    setLegs(next.map((l) => (l.kind === "FUT" ? l : { ...l, symbol: x.c.rows.find((r) => r.strike === l.strike)?.[l.right === "CE" ? "ce" : "pe"]?.symbol ?? null })));
    announce(`Strikes shifted ${dir > 0 ? "up" : "down"}`);
  }
  function scale(f) {
    if (f < 1 && legs().every((l) => l.lots <= 1)) return;
    mutate((ls) => ls.forEach((l) => (l.lots = Math.max(1, Math.min(10000, Math.floor(l.lots * f))))));
  }
  /** From the chain (⇧B / ⇧S, the ticket) or the picker: the same contract and side merge into one leg. */
  function addLeg(leg) {
    const cur = legs();
    const isFut = leg.kind === "FUT";
    const same = cur.find((l) => (isFut ? l.kind === "FUT" && l.symbol === leg.symbol : l.kind === "OPT" && l.strike === leg.strike && l.right === leg.right) && l.side === leg.side && (l.entry === undefined || l.entry === null));
    if (!same && cur.length >= O.MAX_LEGS) return toast(`Up to ${O.MAX_LEGS} legs`);
    mutate((ls) => {
      const s = ls.find((l) => l.id === same?.id);
      if (s) s.lots += leg.lots ?? 1;
      else ls.push({ kind: isFut ? "FUT" : "OPT", right: isFut ? null : leg.right, strike: isFut ? null : leg.strike, side: leg.side, lots: leg.lots ?? 1, symbol: leg.symbol ?? null, expiry: leg.expiry ?? st.expiry, lotSize: leg.lotSize ?? num(st.chain?.lotSize) });
    });
    const t = `${leg.side === "BUY" ? "Buy" : "Sell"} ${isFut ? `FUT ${expiryText(leg.expiry)}` : `${formatInt(leg.strike)} ${leg.right}`} added`;
    announce(t);
    return t;
  }
  function changed() {
    if (x) priced = price(x);
    schedulePreviews();
    drawAll();
  }

  // ── Legs list: rebuilt when its structure changes, patched on ticks ──
  function legRow(l, i) {
    const name = O.legLabel(l);
    const off = l.on === false;
    const on = h("input", { type: "checkbox", "aria-label": `Include ${name}` });
    on.checked = !off;
    on.addEventListener("change", () => mutate((ls) => (ls[i].on = on.checked)));
    const side = h("button", { type: "button", class: `side-tag ${l.side === "BUY" ? "buy" : "sell"}`, "aria-label": `${l.side === "BUY" ? "Buy" : "Sell"} ${name}: switch to ${l.side === "BUY" ? "sell" : "buy"}`, onclick: () => mutate((ls) => ((ls[i].side = ls[i].side === "BUY" ? "SELL" : "BUY"), delete ls[i].entry)) }, l.side === "BUY" ? "B" : "S");
    const ks = x ? x.c.rows.map((r) => r.strike) : [];
    const step = (d) => {
      const k = O.stepStrike(ks, l.strike, d);
      if (k === null) return;
      mutate((ls) => {
        ls[i].strike = k;
        ls[i].symbol = x.c.rows.find((r) => r.strike === k)?.[ls[i].right === "CE" ? "ce" : "pe"]?.symbol ?? null;
        delete ls[i].entry;
      });
    };
    const isFut = l.kind === "FUT";
    const strike = isFut
      ? h("span", { class: "leg-strike fut" }, h("span", { class: "k" }, "FUT"), h("small", {}, expiryText(l.expiry)))
      : h(
          "span",
          { class: "leg-strike" },
          h("button", { type: "button", class: "step", "aria-label": `${name}: lower strike`, disabled: !x || O.stepStrike(ks, l.strike, -1) === null, onclick: () => step(-1) }, "‹"),
          h("span", { class: "k" }, formatInt(l.strike)),
          h("button", { type: "button", class: "step", "aria-label": `${name}: higher strike`, disabled: !x || O.stepStrike(ks, l.strike, 1) === null, onclick: () => step(1) }, "›"),
        );
    const right = isFut
      ? h("span", { class: "leg-right fut" })
      : h("button", { type: "button", class: "leg-right", "aria-label": `${name}: switch to ${l.right === "CE" ? "PE" : "CE"}`, onclick: () => mutate((ls) => ((ls[i].right = ls[i].right === "CE" ? "PE" : "CE"), (ls[i].symbol = null), delete ls[i].entry)) }, l.right);
    const lotsIn = h("input", { type: "number", min: "1", max: "10000", step: "1", inputmode: "numeric", class: "lots-in", value: String(l.lots), "aria-label": `Lots for ${name}`, title: `${formatInt(l.lots * (l.lotSize || x?.lot || 1))} qty` });
    lotsIn.addEventListener("change", () => {
      const v = Math.floor(Number(lotsIn.value));
      if (v >= 1 && v <= 10000) mutate((ls) => (ls[i].lots = v));
      else lotsIn.value = String(l.lots);
    });
    const lots = h(
      "span",
      { class: "leg-lots" },
      h("button", { type: "button", class: "step", "aria-label": `One lot fewer of ${name}`, disabled: l.lots <= 1, onclick: () => mutate((ls) => (ls[i].lots = Math.max(1, ls[i].lots - 1))) }, "−"),
      lotsIn,
      h("button", { type: "button", class: "step", "aria-label": `One lot more of ${name}`, onclick: () => mutate((ls) => (ls[i].lots = Math.min(10000, ls[i].lots + 1))) }, "+"),
    );
    const more = h("button", { type: "button", class: "icon-btn leg-more", "aria-expanded": "false", "aria-label": `Edit ${name}` }, icon("more"));
    const row = h(
      "div",
      { class: `leg-row ${off ? "off" : ""}`.trim(), role: "listitem", "data-id": l.id },
      h("label", { class: "leg-on" }, on),
      side,
      h("span", { class: "leg-name" }, h("strong", {}, isFut ? "FUT" : formatInt(l.strike)), h("span", {}, isFut ? expiryText(l.expiry) : l.right)),
      strike,
      right,
      lots,
      h("span", { class: "leg-lotsx num" }, `×${formatInt(l.lots)}`),
      h("span", { class: "leg-price num" }),
      h("span", { class: "leg-iv num" }),
      h("span", { class: "leg-delta num" }),
      more,
      h("button", { type: "button", class: "leg-x", "aria-label": `Remove ${name}`, onclick: () => mutate((ls) => ls.splice(i, 1), { undoLabel: `${name} removed` }) }, icon("close"), h("span", { class: "leg-x-text" }, "Remove")),
    );
    more.addEventListener("click", () => {
      const open = !row.classList.contains("open");
      row.classList.toggle("open", open);
      more.setAttribute("aria-expanded", String(open));
    });
    row.addEventListener("click", (e) => {
      if (!isPhone() || e.target.closest("button, input, label")) return;
      more.click();
    });
    return row;
  }
  function drawLegs() {
    const ls = legs();
    const ks = x ? x.c.rows.map((r) => r.strike).join() : "";
    const sig = JSON.stringify([ls.map((l) => [l.id, l.kind, l.right, l.strike, l.side, l.lots, l.on, l.entry ?? null]), ks.length ? `${ks.slice(0, 12)}${ks.length}` : ""]);
    if (sig !== legsSig) {
      legsSig = sig;
      const openIds = new Set([...legsEl.querySelectorAll(".leg-row.open")].map((r) => r.dataset.id));
      keepFocus(legsEl, () => {
        legsEl.replaceChildren(
          ...(ls.length ? [h("div", { class: "leg-row leg-head", "aria-hidden": "true" }, h("span", {}), h("span", {}), h("span", { class: "leg-name" }, "Leg"), h("span", { class: "leg-strike" }, "Strike"), h("span", { class: "leg-right" }), h("span", { class: "leg-lots" }, "Lots"), h("span", { class: "leg-lotsx" }), h("span", { class: "leg-price num" }, "Price"), h("span", { class: "leg-iv num" }, "IV"), h("span", { class: "leg-delta num" }, "Δ"), h("span", { class: "leg-more" }), h("span", { class: "leg-x" }))] : []),
          ...ls.map((l, i) => legRow(l, i)),
        );
        for (const r of legsEl.querySelectorAll(".leg-row[data-id]")) if (openIds.has(r.dataset.id)) r.classList.add("open");
      });
      const lotsN = ls.reduce((a, l) => a + (l.on === false ? 0 : l.lots), 0);
      legCount.textContent = ls.length ? `${plural(ls.length, "leg")} · ${plural(lotsN, "lot")}` : "";
      halfBtn.disabled = !ls.length || ls.every((l) => l.lots <= 1);
      dblBtn.disabled = !ls.length;
      shiftDn.disabled = shiftUp.disabled = !ls.some((l) => l.kind === "OPT") || !x;
      addBtn.disabled = ls.length >= O.MAX_LEGS || !x;
      emptyLegs.hidden = ls.length > 0;
      requestAnimationFrame(syncStick);
      emptyLegs.textContent = isTouch() ? "Pick a strategy, or tap + Add leg." : "Pick a strategy above, add legs with + Add leg (A), or press ⇧B / ⇧S on the chain.";
    }
    // Patch prices, IV and Δ.
    for (const p of priced) {
      const row = legsEl.querySelector(`.leg-row[data-id="${CSS.escape(p.id)}"]`);
      if (!row) continue;
      const tag = p.entry !== undefined && p.entry !== null ? p.entryTag ?? "avg" : p.fallback ? "LTP" : null;
      setCell(row.querySelector(".leg-price"), `${formatFixed(p.price, 2)}|${tag}`, () => [p.price === null ? DASH : formatFixed(p.price, 2), tag ? h("small", { class: "ptag" }, tag) : null], p.price === null ? `${p.label} has no price` : null);
      const ivCell = row.querySelector(".leg-iv");
      if (p.kind === "FUT") setCell(ivCell, "fut", () => DASH);
      else setCell(ivCell, `${formatFixed(p.iv, 1)}|${p.ivFallback}`, () => (p.ivFallback ? h("em", { class: "iv-fb" }, formatFixed(p.iv, 1)) : formatFixed(p.iv, 1)), p.ivFallback ? "No IV for this strike: ATM IV used" : null);
      setCell(row.querySelector(".leg-delta"), p.kind === "FUT" ? "1" : formatFixed(p.q?.delta, 2), () => (p.kind === "FUT" ? formatFixed(1, 2) : formatFixed(p.q?.delta, 2)));
    }
  }
  function setCell(td, sig, content, title) {
    if (!td || td.__sig === sig) return;
    td.__sig = sig;
    td.replaceChildren(...[content()].flat().filter((c) => c !== null && c !== undefined));
    if (title) td.title = title;
    else td.removeAttribute("title");
  }

  /** The sticky build column only sticks while it fits the screen; a taller one scrolls with the page. */
  function syncStick() {
    build.classList.remove("no-stick");
    if (build.offsetHeight > innerHeight - 24) build.classList.add("no-stick");
  }
  addEventListener("resize", syncStick);

  // ── Preset chips ──
  function drawChips() {
    if (!x) return;
    const g = cfg().group;
    const f = fut();
    const sig = `${g}|${x.c.underlying}|${x.c.expiry}|${x.sm.atm}|${f?.symbol ?? ""}`;
    if (sig !== chipsSig) {
      chipsSig = sig;
      const list = O.PRESETS.filter((p) => p.group === g);
      chips.replaceChildren(
        ...list.map((p) => {
          const pl = O.presetLegs(p.id, x.c, { move: x.move, forward: x.F, fut: f ? { symbol: f.symbol, expiry: f.expiry, lotSize: f.lotSize } : { symbol: "FUT", expiry: null } }).map((l) => {
            const q = l.kind === "FUT" ? st.quotes.get(f?.symbol ?? "") : x.c.rows.find((r) => r.strike === l.strike)?.[l.right === "CE" ? "ce" : "pe"];
            return { ...l, price: O.mid(q) ?? (l.kind === "FUT" ? x.F : 0), basis0: 0 };
          });
          const gl = O.presetGlyph(pl, x.lot);
          const netP = O.netPremium(pl, x.lot);
          const glyph = gl ? h("span", { class: "glyph", "aria-hidden": "true" }) : null;
          if (glyph) glyph.append(svgGlyph(gl));
          const disabled = p.needsFut && !f;
          const b = h("button", { type: "button", class: "preset-chip", "data-preset": p.id, "aria-pressed": "false", disabled, title: disabled ? `No future found for ${st.underlying}.` : `${p.hint} · ${netP >= 0 ? "credit" : "debit"} ${money(Math.abs(netP), { signed: false })} · ${p.risk === "defined" ? "Defined" : "Undefined"} risk` }, glyph, h("span", {}, p.name));
          b.addEventListener("click", () => applyPreset(p));
          return b;
        }),
      );
    }
    // Active state: the draft equals the preset's legs.
    const cur = legs();
    for (const b of chips.querySelectorAll(".preset-chip")) {
      const pl = O.presetLegs(b.dataset.preset, x.c, { move: x.move, forward: x.F, fut: f ? { symbol: f.symbol, expiry: f.expiry } : null });
      const on = O.legsMatch(cur, pl);
      if (b.getAttribute("aria-pressed") !== String(on)) {
        b.setAttribute("aria-pressed", String(on));
        b.classList.toggle("on", on);
      }
    }
  }
  function svgGlyph(gl) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 32 16");
    const z = document.createElementNS(NS, "line");
    for (const [k, v] of Object.entries({ x1: 0, x2: 32, y1: gl.zero, y2: gl.zero, class: "g-zero" })) z.setAttribute(k, String(v));
    const pl = document.createElementNS(NS, "polyline");
    pl.setAttribute("points", gl.points.map(([a, b]) => `${a},${b}`).join(" "));
    pl.setAttribute("class", "g-line");
    svg.append(z, pl);
    return svg;
  }
  const activePreset = () => (x ? O.PRESETS.find((p) => O.legsMatch(legs(), O.presetLegs(p.id, x.c, { move: x.move, forward: x.F, fut: fut() ? { symbol: fut().symbol } : null }))) ?? null : null);

  // ── Figures strip ──
  const tiles = new Map();
  function tileEl(k) {
    if (!tiles.has(k)) {
      const label = h("dt", { class: "label" });
      const value = h("dd", { class: "value" });
      const sub = h("dd", { class: "sub" });
      tiles.set(k, { el: h("div", { class: `desk-stat m-${k} ${PRIMARY.includes(k) ? "primary" : "extra"}` }, label, value, sub), label, value, sub });
    }
    return tiles.get(k);
  }
  function tileData(k) {
    const r = R;
    const loading = !r && !noChain;
    const dash = { value: loading ? "…" : DASH };
    const after = cfg().net ? " after charges" : "";
    const nopx = r && r.missing.length ? `${plural(r.missing.length, "leg has", "legs have")} no price` : null;
    const st2 = r?.stats;
    const lotsN = r ? r.act.reduce((a, l) => a + l.lots, 0) : 0;
    const mixed = r && new Set(r.act.map((l) => l.lotSize)).size > 1;
    switch (k) {
      case "net": {
        const n = st2?.net;
        const label = !isFigure(n) ? "Credit / debit" : n > 0.5 ? "Credit" : n < -0.5 ? "Debit" : "Even";
        return { label, value: isFigure(n) ? money(Math.abs(n), { signed: false }) : dash.value, sub: nopx ?? (r?.act.length ? `${plural(lotsN, "lot")} · ${mixed ? `${formatInt(r.act.reduce((a, l) => a + O.legUnits(l, r.lot), 0))} qty` : `lot ${formatInt(r.lot)}`}` : "") };
      }
      case "maxProfit":
        if (st2?.locked !== null && st2?.locked !== undefined) return { label: `Locked P&L${after}`, value: moneyEl(st2.locked), sub: `Implied ${isFigure(r.ratios.implied) ? formatPercent(r.ratios.implied * 100, 1) : DASH}/yr`, title: "Riskless at expiry if every leg fills at these prices" };
        return { label: "Max profit", value: !st2 ? dash.value : st2.maxProfit === null ? h("span", { class: "up" }, "Unlimited") : moneyEl(st2.maxProfit), sub: nopx ?? (cfg().net ? "after charges" : "at expiry") };
      case "maxLoss":
        if (st2?.locked !== null && st2?.locked !== undefined) return null;
        return {
          label: "Max loss",
          value: !st2 ? dash.value : st2.maxLoss === null ? h("span", { class: "down" }, "Unlimited") : moneyEl(st2.maxLoss),
          sub: st2?.maxLoss === null && st2?.stress ? `${money(st2.stress.value)} at +2σ (${formatInt(Math.round(st2.stress.price))})` : nopx ?? (cfg().net ? "after charges" : "at expiry"),
        };
      case "breakevens": {
        const bes = st2?.breakevens ?? [];
        if (!st2) return { label: "Breakevens", value: dash.value, sub: nopx ?? "" };
        if (!bes.length) return { label: "Breakevens", value: "None", sub: st2.maxLoss !== null && st2.maxLoss >= 0 ? "never a loss" : "never a profit" };
        const show = bes.length > 4 ? bes.slice(0, 3) : bes;
        const z = (b) => O.sigmaZ(b, x.F, r.ivNow, r.T);
        return {
          label: `Breakeven${bes.length > 1 ? "s" : ""}${after}`,
          value: h("span", { class: "be-list" }, show.map((b) => h("span", { class: "be-v" }, formatInt(Math.round(b)))), bes.length > 4 ? h("span", { class: "be-v muted" }, `+${bes.length - 3}`) : null),
          sub: h("span", { class: "be-list" }, show.map((b) => h("span", { class: "be-v" }, `${formatSigned(x.spot ? ((b - x.spot) / x.spot) * 100 : null, 1)}% · ${isFigure(z(b)) ? `${formatFixed(Math.abs(z(b)), 1)}σ` : DASH}`))),
        };
      }
      case "pop":
        return { label: "Chance of profit", value: isFigure(st2?.pop) ? formatPercent(st2.pop * 100, 0) : dash.value, sub: "at expiry · IV model", title: "Probability the strategy finishes in profit, from a log-normal model at ATM IV (plus the IV shift)" };
      case "margin": {
        const free = funds.free;
        const req = r?.margin;
        const short = isFigure(req) && isFigure(free) && req > free ? req - free : null;
        const est = r?.est?.required;
        const acctFig = r?.acct !== null && r?.acct !== undefined;
        if (r?.exit) return { label: "Margin", value: acctFig ? money(r.acct, { signed: false }) : DASH, sub: "closing releases margin", title: "These orders close held legs: they release margin rather than block it." };
        const v = acctFig ? money(r.acct, { signed: false }) : isFigure(est) ? `≈ ${money(est, { signed: false })}` : pv.loading ? "…" : dash.value;
        // The account's figure (paper: per leg, no hedge benefit) says so; its shortfall is in the warnings already.
        const subParts = acctFig ? ["paper · no hedge benefit", isFigure(est) ? `hedged ≈ ${money(est, { signed: false })}` : null] : [short ? `short by ${money(short, { signed: false })}` : isFigure(free) ? `${money(free, { signed: false })} free` : null];
        subParts.splice(0, subParts.length, ...subParts.filter(Boolean));
        return {
          label: "Margin",
          value: h("span", { class: short ? "down" : undefined }, v),
          sub: subParts.join(" · "),
          title: `Paper accounts block margin per leg with no hedge benefit; exchanges give hedged baskets a large benefit. The estimate approximates SPAN + exposure; your broker's figure is final.${pv.failed ? " Account margin unavailable." : ""}`,
        };
      }
      case "atTarget": {
        const tt = r && r.el > 0 ? when(r.targetMs) : "now";
        return { label: "At target", value: isFigure(r?.atTarget) ? moneyEl(r.atTarget) : dash.value, sub: r ? `${r.el >= r.T - 1e-7 && r.el > 0 ? "at expiry" : tt} · IV ${formatSigned(wi.ivShift, 1)}` : "" };
      }
      case "rom":
        return { label: "Return on margin", value: isFigure(r?.ratios.rom) ? formatPercent(r.ratios.rom * 100, 1) : dash.value, sub: "max profit ÷ margin" };
      case "rr":
        return { label: "Reward / risk", value: isFigure(r?.ratios.rr) ? formatFixed(r.ratios.rr, 2) : dash.value, sub: "max profit ÷ max loss" };
      case "delta": {
        const d = r?.greeks?.delta;
        return { label: "Delta", value: isFigure(d) ? `${formatSigned(d / r.lot, 2)} lot` : dash.value, sub: isFigure(d) ? `${money(d)}/pt` : "model, at target" };
      }
      case "gamma": {
        const g = r?.greeks?.gamma;
        return { label: "Gamma", value: isFigure(g) && x.F ? `${formatSigned((g * x.F * 0.01) / r.lot, 2)} lot` : dash.value, sub: "Δ change per 1% move" };
      }
      case "theta": {
        const t = r?.greeks?.theta;
        return { label: "Theta", value: isFigure(t) ? moneyEl(t) : dash.value, sub: "per day · model" };
      }
      case "vega": {
        const v = r?.greeks?.vega;
        return { label: "Vega", value: isFigure(v) ? moneyEl(v) : dash.value, sub: "per vol point" };
      }
      case "ev":
        return { label: "EV at IV", value: isFigure(r?.ev) ? moneyEl(r.ev) : dash.value, sub: "model expectation", title: "Close to −(spreads + charges) by construction: options are priced at IV. Shows what the touch and charges cost you." };
      case "charges": {
        const c = r?.ch;
        const exitAt = r?.ok && x.spot !== null ? O.exitCharges(r.act, x.spot, O.CHARGE_RATES, { lotSize: r.lot }) : null;
        return { label: "Charges", value: c ? money(c.total, { signed: false }) : dash.value, sub: isFigure(exitAt) ? `+ exit ≈ ${money(exitAt, { signed: false })} at spot` : "", title: `Brokerage, STT, exchange, SEBI, stamp and GST at rates as of ${O.CHARGE_RATES.asOf}: verify with your broker` };
      }
      default:
        return null;
    }
  }
  function drawMetrics() {
    const keys = cfg().metrics;
    const sig = keys.join();
    if (metricsEl.__sig !== sig) {
      metricsEl.__sig = sig;
      metricsEl.replaceChildren(...keys.map((k) => tileEl(k).el));
    }
    for (const k of keys) {
      const t = tileEl(k);
      const d = tileData(k);
      t.el.hidden = !d;
      if (!d) continue;
      const s = JSON.stringify([d.label, nodeText(d.value), nodeText(d.sub), d.value?.className ?? "", d.title ?? ""]);
      if (t.el.__sig === s) continue;
      t.el.__sig = s;
      t.label.textContent = d.label;
      t.value.replaceChildren(d.value ?? DASH);
      t.sub.replaceChildren(d.sub ?? "");
      if (d.title) t.el.title = d.title;
      else t.el.removeAttribute("title");
    }
    const extras = keys.filter((k) => !PRIMARY.includes(k)).length;
    metricsEl.classList.toggle("collapsed", !cfg().moreOpen);
    moreFigs.hidden = !extras;
    moreFigs.textContent = cfg().moreOpen ? "Fewer figures" : `More figures (${formatInt(extras)})`;
    moreFigs.setAttribute("aria-expanded", String(cfg().moreOpen));
  }
  const nodeText = (v) => (v instanceof Node ? `${v.textContent}|${v.className ?? ""}|${[...(v.querySelectorAll?.("*") ?? [])].map((e) => e.className).join()}` : String(v ?? ""));

  function drawWarnings() {
    const w = R?.warnings ?? [];
    const all = warnEl.classList.contains("all");
    const show = all ? w : w.slice(0, 3);
    const sig = JSON.stringify([show.map((x2) => x2.text), w.length, all]);
    if (warnEl.__sig === sig) return;
    warnEl.__sig = sig;
    warnEl.hidden = !w.length;
    warnEl.replaceChildren(
      ...show.map((x2) => h("li", { class: x2.severity === "block" ? "bad" : x2.severity === "warn" ? "warn" : "info" }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", {}, x2.text))),
      ...(w.length > 3 ? [h("li", { class: "more" }, h("button", { type: "button", class: "small plain", onclick: () => (warnEl.classList.toggle("all"), (warnEl.__sig = ""), drawWarnings()) }, all ? "Show fewer" : `+${formatInt(w.length - 3)} more`))] : []),
    );
  }

  function drawWhatIf() {
    if (!R) {
      tSlider.disabled = ivSlider.disabled = true;
      return;
    }
    const now = Date.now();
    const mins = Math.max(0, Math.ceil((R.expMs - now) / 60000 / 15) * 15);
    tSlider.disabled = mins <= 0;
    ivSlider.disabled = false;
    if (tSlider.max !== String(mins)) tSlider.max = String(mins);
    // At expiry by time, not by slider value: the slider's max is rounded up to 15 minutes, the target is not.
    const atExpiry = wi.target !== null && mins > 0 && R.targetMs >= R.expMs - 60000;
    const v = wi.target === null ? 0 : atExpiry || R.expMs - wi.target <= 15 * 60000 ? mins : Math.min(mins, Math.round((wi.target - now) / 60000));
    if (document.activeElement !== tSlider || !dragging.t) tSlider.value = String(v);
    const left = R.expMs - R.targetMs;
    const txt = atExpiry ? "At expiry" : R.el <= 0 ? `Now · ${span(R.expMs - now)} left` : `T+${span(R.targetMs - now)} · ${when(R.targetMs)}`;
    tLabel.textContent = txt;
    tLabel.title = atExpiry || R.el <= 0 ? "" : `${span(left)} left to expiry`;
    tSlider.setAttribute("aria-valuetext", atExpiry || R.el <= 0 ? txt : `${txt} · ${span(left)} left`);
    const ivTxt = `IV ${formatSigned(wi.ivShift, 1)} pts · ATM ${formatPercent(R.ivNow, 1)}`;
    ivLabel.textContent = ivTxt;
    ivSlider.setAttribute("aria-valuetext", ivTxt);
    if (document.activeElement !== ivSlider) ivSlider.value = String(wi.ivShift);
    resetWi.hidden = wi.target === null && wi.ivShift === 0;
    note.textContent = R.ok
      ? `Theoretical · Black-76 on forward ${formatInt(Math.round(x.F ?? 0))} · leg IVs ${formatSigned(wi.ivShift, 1)} pts · r 0 · to 15:30 IST · skew and supply move real prices${R.net ? ` · net of charges (rates ${O.CHARGE_RATES.asOf})` : ""}`
      : "";
  }
  const dragging = { t: false };
  tSlider.addEventListener("pointerdown", () => (dragging.t = true));
  tSlider.addEventListener("pointerup", () => (dragging.t = false));
  tSlider.addEventListener("input", () => {
    const v = Number(tSlider.value);
    const max = Number(tSlider.max);
    wi.target = v <= 0 ? null : v >= max ? R?.expMs ?? null : Date.now() + v * 60000;
    scheduleAnalysis();
  });
  tSlider.addEventListener("change", () => save());
  tSlider.addEventListener("keydown", (e) => {
    if (e.key !== "PageUp" && e.key !== "PageDown") return;
    e.preventDefault();
    tSlider.value = String(Math.max(0, Math.min(Number(tSlider.max), Number(tSlider.value) + (e.key === "PageUp" ? 1440 : -1440))));
    tSlider.dispatchEvent(new Event("input"));
    save();
  });
  ivSlider.addEventListener("input", () => {
    wi.ivShift = Number(ivSlider.value);
    scheduleAnalysis();
  });
  ivSlider.addEventListener("change", () => save());

  function drawScenarios() {
    if (!R?.ok) {
      const msg = R ? (R.act.length ? "Figures need every leg priced." : "Add legs to see P&L at nine prices.") : noChain ? DASH : "…";
      scenBody.replaceChildren(h("tr", {}, h("td", { colspan: "4", class: "muted" }, msg)));
      scenBody.__sig = "";
      return;
    }
    const mode = cfg().scenario;
    if (scenSeg.value !== mode) scenSeg.value = mode;
    const levels = O.scenarioLevels(mode, { spot: x.spot, forward: x.F, ivPct: R.ivNow, years: R.T });
    const f = O.strategyPayoff(R.act, R.lot, { years: R.T, ivShift: R.shift, charges: R.net });
    const basis = x.F !== null && x.spot !== null ? x.F - x.spot : 0;
    const showTarget = R.el < R.T - 1e-7 || R.T <= 0;
    scenHeadT.textContent = R.el > 0 ? "At target" : "Now";
    const rows = levels.map((lv) => {
      const vt = O.valueAt(R.act, lv.price, R.lot, null, basis, { el: R.el, ivShift: R.shift });
      return { ...lv, target: vt === null ? null : vt - (R.net?.entry ?? 0), expiry: f(lv.price) };
    });
    if (scenBody.children.length !== rows.length || scenBody.__mode !== mode) {
      scenBody.__mode = mode;
      scenBody.replaceChildren(...rows.map((rw) => h("tr", { class: rw.k === 0 ? "zero-row" : undefined }, h("td", { class: "num c-price" }), h("td", { class: "num c-move" }), h("td", { class: "num c-t" }), h("td", { class: "num c-e" }))));
    }
    rows.forEach((rw, i) => {
      const tr = scenBody.children[i];
      const move = mode === "sigma" ? `${formatSigned(rw.k, 1)}σ` : `${formatSigned(rw.k, 1)}%`;
      setCell(tr.children[0], `${Math.round(rw.price)}|${move}`, () => [formatInt(Math.round(rw.price)), h("small", { class: "mv-sub" }, move)]);
      setCell(tr.children[1], move, () => move);
      setCell(tr.children[2], `${showTarget}|${Math.round(rw.target ?? NaN)}`, () => (showTarget && isFigure(rw.target) ? moneyEl(rw.target) : DASH));
      setCell(tr.children[3], `${Math.round(rw.expiry)}`, () => moneyEl(rw.expiry));
    });
  }

  function drawBar() {
    const n = R?.stats?.net;
    const exit = closeMode();
    barNet.textContent = !R ? (noChain ? "No chain" : "…") : !R.ok ? (R.act.length ? "Needs prices" : "No legs") : `${n > 0.5 ? "Credit" : n < -0.5 ? "Debit" : "Even"} ${money(Math.abs(n), { signed: false })}`;
    const m = R?.margin;
    const mText = !isFigure(m) ? DASH : `${R.acct === null ? "≈ " : ""}${Math.abs(m) >= 1000 ? `₹${formatCompact(m)}` : money(m, { signed: false })}`;
    barSub.textContent = R?.ok ? [exit ? null : `Margin ${mText}`, isFigure(R.stats?.pop) ? `PoP ${formatPercent(R.stats.pop * 100, 0)}` : null].filter(Boolean).join(" · ") : "";
    const nAct = R?.act.length ?? 0;
    const blockedWhy = !R ? (noChain ? "The chain is unavailable" : "Waiting for the chain") : !account() ? "Choose an account that can place orders" : !nAct ? "Add a leg first" : !R.ok ? "Every leg needs a price" : R.warnings.some((w) => w.severity === "block") ? R.warnings.find((w) => w.severity === "block").text : null;
    // Nothing placeable: a plain "Place" (disabled, with the reason as its title), never "Place 0 legs".
    const placeable = Boolean(R?.ok) && nAct > 0;
    const label = exit ? "Close these legs" : placeable ? `Place ${formatInt(nAct)}` : "Place";
    for (const b of [barPlace, placeBtn]) {
      const text = b === placeBtn && !exit && placeable ? `Place ${plural(nAct, "leg")}` : label;
      if (b.textContent !== text) b.textContent = text;
      b.disabled = Boolean(blockedWhy);
      if (blockedWhy) b.title = blockedWhy;
      else b.removeAttribute("title");
      b.classList.toggle("sell", exit);
    }
  }
  const closeMode = () => {
    const ls = legs().filter((l) => l.on !== false);
    return ls.length > 0 && ls.every((l) => l.entry !== undefined && l.entry !== null && l.entryTag !== "saved");
  };

  function drawHead() {
    const c = x?.c;
    const basisText = { touch: "prices at the touch", mid: "prices at mid", ltp: "prices at LTP" }[cfg().basis];
    ctxLine.textContent = c ? `${c.underlying} ${expiryText(c.expiry)} · lot ${formatInt(x.lot)} · ${basisText}${st.live ? "" : " · prices paused"}` : `${st.underlying}${st.expiry ? ` ${expiryText(st.expiry)}` : ""} · ${basisText}`;
    const n = readSaves().length;
    savedBtn.textContent = n ? `Saved (${formatInt(n)})` : "Saved";
    clearBtn.disabled = !legs().length;
    saveBtn.disabled = !legs().length;
  }

  function drawAnalysis() {
    raf = 0;
    if (!x) return;
    R = compute();
    drawMetrics();
    drawWarnings();
    drawWhatIf();
    drawScenarios();
    drawBar();
    if (R.model) chart.update(R.model);
    else chart.empty(!R.act.length ? (R.all.length ? "All legs are switched off." : "Your payoff appears here: pick a strategy or add a leg.") : `${R.missing.map((l) => l.label).join(", ")} ${R.missing.length === 1 ? "has" : "have"} no price, so the figures wait for one.`);
  }
  const scheduleAnalysis = () => {
    if (!raf) raf = requestAnimationFrame(drawAnalysis);
  };
  function drawAll() {
    drawHead();
    drawChips();
    drawLegs();
    drawAnalysis();
    picker?.patch();
  }

  // ── Funds and previews (never on ticks) ──
  async function loadFunds() {
    const a = account();
    if (!a) {
      funds = { free: null, error: null };
      return;
    }
    const r = await optional(api(`/v1/funds?account=${encodeURIComponent(a.id)}`));
    funds = { free: num(r.data?.data?.availableCash), error: r.error ?? null };
    if (x) drawAnalysis();
  }
  function schedulePreviews(force = false) {
    clearTimeout(pvTimer);
    pvTimer = setTimeout(() => runPreviews(force), 400);
  }
  async function runPreviews(force) {
    const a = account();
    const act = priced.filter((l) => l.on !== false && l.symbol && isFigure(l.price));
    const sig = sigOf(act);
    if (!a || !act.length) {
      pv = { ...pv, sig: "", margin: null, loading: false };
      return;
    }
    if (!force && sig === pv.sig && !pv.loading) return;
    pv.loading = true;
    // Held legs (Positions → Analyse) are previewed as the closing order: that releases margin rather than blocks it.
    const res = await Promise.all(act.map((l) => optional(api("/v1/orders/preview", { method: "POST", body: { account: a.id, symbol: l.symbol, side: isHeld(l) ? (l.side === "BUY" ? "SELL" : "BUY") : l.side, lots: l.lots, product: l.product ?? cfg().product, orderType: "LIMIT", price: l.price } }))));
    if (sigOf(priced.filter((l) => l.on !== false && l.symbol && isFigure(l.price))) !== sig) return;
    const freeze = new Map(pv.freeze);
    let total = 0;
    let all = true;
    for (const r of res) {
      const d = r.data?.data;
      if (d?.resolved?.symbol) freeze.set(d.resolved.symbol, d.resolved.freezeQty ?? null);
      if (isFigure(d?.margin?.required)) total += d.margin.required;
      else all = false;
    }
    pv = { sig, margin: all ? total : null, loading: false, freeze, failed: res.some((r) => r.error) };
    if (x) {
      priced = price(x);
      drawAnalysis();
    }
  }

  // ── Placement ──
  async function place() {
    if (!R || !x) return;
    const a = account();
    if (!a) return toast("Choose an account that can place orders first.");
    if (!R.act.length) return;
    const exit = closeMode();
    const plan = O.placementPlan(R.act, exit ? "exit" : "entry", { spot: x.spot });
    const items = plan.map((p) => {
      const l = p.leg;
      const q = quoteOf(l);
      return {
        leg: l,
        side: p.side,
        phase: p.phase,
        symbol: l.symbol,
        label: l.kind === "FUT" ? `FUT ${expiryText(l.expiry)}` : `${formatInt(l.strike)} ${l.right}`,
        lots: l.lots,
        lotSize: l.lotSize,
        price: exit ? O.basisPrice(q, p.side, "touch").price : l.price,
        product: l.product,
        quote: () => quoteOf(l),
        freezeQty: l.freezeQty,
        fut: l.kind === "FUT",
      };
    });
    const preset = activePreset();
    const title = exit ? `Close ${plural(items.length, "leg")} · ${x.c.underlying} ${expiryText(x.c.expiry)}` : `Place ${preset ? preset.name : `${formatInt(items.length)}-leg strategy`} · ${x.c.underlying} ${expiryText(x.c.expiry)}`;
    const r = await openPlacement({
      title,
      mode: exit ? "exit" : "entry",
      account: a,
      items,
      summary: exit ? null : { net: R.stats?.net ?? null, maxLoss: R.stats ? R.stats.maxLoss : undefined, margin: R.margin, marginEst: R.acct === null, free: funds.free },
      warnings: R.warnings,
      cfg: { product: cfg().product, hedgeWait: cfg().hedgeWait },
      onCfg: (patch) => setCfg(patch),
      onPositions,
      announce,
    });
    if (r.placed) {
      loadFunds();
      refresh();
    }
  }

  // ── Strike picker (A) ──
  function openPicker() {
    if (!x || picker) return picker?.focus();
    const phone = isPhone();
    const filter = h("input", { type: "search", inputmode: "decimal", class: "picker-filter", placeholder: "Strike", "aria-label": "Jump to strike", autocomplete: "off" });
    const status = h("div", { class: "sr-only", "aria-live": "polite" });
    const body = h("div", { class: "picker-body" });
    const futRow = h("div", { class: "picker-fut" });
    const rowsEl = h("div", { class: "picker-rows", role: "grid", "aria-label": "Strikes" });
    let focus = { i: -1, side: "ce" };
    const added = (t) => {
      status.textContent = t;
      announce(t);
    };
    const btn = (label, cls, onclick, aria) => h("button", { type: "button", class: `small ${cls}`, "aria-label": aria, onclick }, label);
    function build() {
      const rows = O.rowsAroundAtm(x.c, 10);
      const f = fut();
      const fq = f ? st.quotes.get(f.symbol) : null;
      futRow.hidden = !f;
      if (f) {
        futRow.replaceChildren(
          h("span", { class: "pk-name" }, h("strong", {}, "FUT"), ` ${expiryText(f.expiry)}`),
          h("span", { class: "num pk-ltp", "data-fut": "1" }, formatFixed(fq?.ltp, 2)),
          h("span", { class: "pk-btns" }, btn("B", "side-tag buy", () => added(addLeg({ kind: "FUT", side: "BUY", symbol: f.symbol, expiry: f.expiry, lotSize: f.lotSize })), `Buy FUT ${expiryText(f.expiry)}`), btn("S", "side-tag sell", () => added(addLeg({ kind: "FUT", side: "SELL", symbol: f.symbol, expiry: f.expiry, lotSize: f.lotSize })), `Sell FUT ${expiryText(f.expiry)}`)),
        );
      }
      const spot = x.spot;
      const out = [];
      rows.forEach((r, i) => {
        if (spot !== null && i > 0 && rows[i - 1].strike < spot && r.strike >= spot) out.push(h("div", { class: "pk-spot", "aria-hidden": "true" }, h("span", {}, `Spot ${formatInt(Math.round(spot))}`)));
        const add = (right, side) => () => added(addLeg({ right, strike: r.strike, side, symbol: r[right === "CE" ? "ce" : "pe"]?.symbol ?? null, lotSize: x.lot }));
        out.push(
          h(
            "div",
            { class: `pk-row ${r.strike === x.sm.atm ? "atm" : ""}`.trim(), role: "row", "data-strike": String(r.strike), "data-i": String(i) },
            h("span", { class: "num pk-ltp ce", role: "gridcell" }, formatFixed(r.ce?.ltp, 2)),
            h("span", { class: "pk-btns", role: "gridcell" }, btn("B", "side-tag buy", add("CE", "BUY"), `Buy ${formatInt(r.strike)} CE`), btn("S", "side-tag sell", add("CE", "SELL"), `Sell ${formatInt(r.strike)} CE`)),
            h("span", { class: "pk-k", role: "rowheader" }, h("strong", {}, formatInt(r.strike)), h("small", { class: "muted" }, isFigure(r.ce?.delta) ? ` ${formatFixed(r.ce.delta, 2)}` : "")),
            h("span", { class: "pk-btns", role: "gridcell" }, btn("B", "side-tag buy", add("PE", "BUY"), `Buy ${formatInt(r.strike)} PE`), btn("S", "side-tag sell", add("PE", "SELL"), `Sell ${formatInt(r.strike)} PE`)),
            h("span", { class: "num pk-ltp pe", role: "gridcell" }, formatFixed(r.pe?.ltp, 2)),
          ),
        );
      });
      rowsEl.replaceChildren(h("div", { class: "pk-head", "aria-hidden": "true" }, h("span", {}, "CE"), h("span", {}), h("span", {}, "Strike"), h("span", {}), h("span", {}, "PE")), ...out);
    }
    const rowEls = () => [...rowsEl.querySelectorAll(".pk-row")];
    const paintFocus = () => {
      rowEls().forEach((r, i) => r.classList.toggle("focus", i === focus.i));
      const r = rowEls()[focus.i];
      r?.scrollIntoView({ block: "nearest" });
      for (const s of rowsEl.querySelectorAll(".pk-row .side-on")) s.classList.remove("side-on");
      r?.querySelectorAll(".pk-btns")[focus.side === "ce" ? 0 : 1]?.classList.add("side-on");
    };
    const onKey = (e) => {
      const rs = rowEls();
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        return close();
      }
      if (e.target === filter && e.key === "Enter") {
        const n = Number(filter.value);
        if (!isFigure(n)) return;
        const strikes = rs.map((r) => Number(r.dataset.strike));
        const k = strikes.reduce((b, s2, i) => (Math.abs(s2 - n) < Math.abs(strikes[b] - n) ? i : b), 0);
        focus.i = k;
        paintFocus();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        focus.i = Math.max(0, Math.min(rs.length - 1, (focus.i < 0 ? rs.findIndex((r) => r.classList.contains("atm")) : focus.i) + (e.key === "ArrowDown" ? 1 : -1)));
        paintFocus();
        return;
      }
      // With a row highlighted, ← → and B / S act even while the Strike filter has focus (it only takes digits).
      if (e.target === filter && focus.i < 0) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        focus.side = e.key === "ArrowLeft" ? "ce" : "pe";
        paintFocus();
        return;
      }
      const k = e.key.toLowerCase();
      if ((k === "b" || k === "s") && !e.ctrlKey && !e.metaKey && !e.altKey && focus.i >= 0) {
        e.preventDefault();
        const r = rs[focus.i];
        r.querySelectorAll(".pk-btns")[focus.side === "ce" ? 0 : 1].querySelectorAll("button")[k === "b" ? 0 : 1].click();
      }
    };
    body.append(h("div", { class: "picker-top" }, filter, h("span", { class: "muted small pk-hint" }, "B / S add one lot · ↑ ↓ ← → · Esc")), futRow, rowsEl, status);
    body.addEventListener("keydown", onKey);
    build();
    let closeFn = null;
    function close() {
      closeFn?.();
    }
    picker = {
      patch() {
        for (const r of rowEls()) {
          const row = x?.c.rows.find((rr) => rr.strike === Number(r.dataset.strike));
          const [ce, pe] = [r.querySelector(".pk-ltp.ce"), r.querySelector(".pk-ltp.pe")];
          if (ce) ce.textContent = formatFixed(row?.ce?.ltp, 2);
          if (pe) pe.textContent = formatFixed(row?.pe?.ltp, 2);
        }
        const f = fut();
        const fl = futRow.querySelector(".pk-ltp");
        if (fl && f) fl.textContent = formatFixed(st.quotes.get(f.symbol)?.ltp, 2);
      },
      focus: () => filter.focus(),
      close: () => close(),
    };
    const atmIntoView = () => {
      const atm = rowsEl.querySelector(".pk-row.atm");
      if (atm) rowsEl.scrollTop = atm.offsetTop - rowsEl.clientHeight / 2 + atm.clientHeight / 2;
    };
    if (phone) {
      closeFn = () => document.querySelector("#dialog .sheet-close")?.click();
      modal({ title: `Add a leg · ${x.c.underlying} ${expiryText(x.c.expiry)}`, body }).then(() => (picker = null));
      requestAnimationFrame(atmIntoView);
      return;
    }
    const popEl = h("div", { class: "popover picker-pop", role: "dialog", "aria-label": "Add a leg" }, h("div", { class: "pop-head" }, h("strong", {}, "Add a leg"), h("button", { type: "button", class: "icon-btn tiny", "aria-label": "Close", onclick: () => close() }, icon("close"))), body);
    const outside = (e) => {
      if (!popEl.contains(e.target) && !addBtn.contains(e.target)) close();
    };
    closeFn = () => {
      popEl.remove();
      document.removeEventListener("pointerdown", outside, true);
      addBtn.setAttribute("aria-expanded", "false");
      picker = null;
      addBtn.focus();
    };
    addBtn.parentElement.append(popEl);
    addBtn.setAttribute("aria-expanded", "true");
    filter.focus({ preventScroll: true });
    // After layout: centre the ATM row, then bring the popover into view clear of the tab bar and the sticky action bar
    // (scroll-margin-bottom in the CSS).
    requestAnimationFrame(() => {
      atmIntoView();
      popEl.scrollIntoView({ block: "nearest" });
    });
    setTimeout(() => document.addEventListener("pointerdown", outside, true));
  }

  // ── Customise (gear) ──
  function openCustomise() {
    if (pop) return closePop();
    const body = h("div", { class: "pop-body" });
    const sw = (label, get, set2, hint) => {
      const input = h("input", { type: "checkbox", role: "switch" });
      input.checked = get();
      input.addEventListener("change", () => (set2(input.checked), draw()));
      return h("label", { class: "sw-row" }, h("span", { class: "sw-text" }, label, hint ? h("small", {}, hint) : null), h("span", { class: "switch" }, input, h("i", { "aria-hidden": "true" })));
    };
    const draw = () => {
      const c = cfg();
      const on = c.metrics;
      const labelOf = (k) => O.STRATEGY_METRICS.find(([m]) => m === k)?.[1] ?? k;
      const move = (k, d) => {
        const a = [...on];
        const i = a.indexOf(k);
        const j = i + d;
        if (j < 0 || j >= a.length) return;
        [a[i], a[j]] = [a[j], a[i]];
        setCfg({ metrics: a });
        draw();
      };
      const row = (k, enabled) =>
        h(
          "div",
          { class: `col-row ${enabled ? "on" : ""}`.trim(), draggable: enabled ? "true" : undefined, "data-col": k },
          enabled ? h("span", { class: "grip", "aria-hidden": "true" }, icon("grip")) : h("span", { class: "grip" }),
          h("label", { class: "col-check" }, (() => {
            const i = h("input", { type: "checkbox" });
            i.checked = enabled;
            i.addEventListener("change", () => {
              const next = enabled ? on.filter((m) => m !== k) : [...on, k];
              if (!next.length) return draw();
              setCfg({ metrics: next });
              draw();
            });
            return i;
          })(), h("span", {}, labelOf(k))),
          enabled ? h("span", { class: "col-move" }, h("button", { type: "button", class: "icon-btn tiny", "aria-label": `Move ${labelOf(k)} earlier`, disabled: on.indexOf(k) === 0, onclick: () => move(k, -1) }, icon("up")), h("button", { type: "button", class: "icon-btn tiny", "aria-label": `Move ${labelOf(k)} later`, disabled: on.indexOf(k) === on.length - 1, onclick: () => move(k, 1) }, icon("down"))) : null,
        );
      const list = h("div", { class: "col-list" }, on.map((k) => row(k, true)), O.STRATEGY_METRICS.map(([k]) => k).filter((k) => !on.includes(k)).map((k) => row(k, false)));
      let dragKey = null;
      list.addEventListener("dragstart", (e) => {
        const r = e.target.closest(".col-row.on");
        if (!r) return;
        dragKey = r.dataset.col;
        r.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", dragKey);
      });
      list.addEventListener("dragover", (e) => {
        if (!dragKey) return;
        e.preventDefault();
        const over = e.target.closest(".col-row.on");
        const from = list.querySelector(".dragging");
        if (!over || !from || over === from) return;
        const r = over.getBoundingClientRect();
        list.insertBefore(from, e.clientY > r.top + r.height / 2 ? over.nextSibling : over);
      });
      list.addEventListener("dragend", () => {
        if (!dragKey) return;
        dragKey = null;
        setCfg({ metrics: [...list.querySelectorAll(".col-row.on")].map((r) => r.dataset.col) });
        draw();
      });
      const basis = segmented("Price basis", [["touch", "Touch"], ["mid", "Mid"], ["ltp", "LTP"]], c.basis);
      basis.addEventListener("change", () => setCfg({ basis: basis.value }));
      const wait = segmented("Hedge wait", [["5", "5 s"], ["15", "15 s"], ["30", "30 s"]], String(c.hedgeWait));
      wait.addEventListener("change", () => setCfg({ hedgeWait: Number(wait.value) }));
      const prod = segmented("Product", [["INTRADAY", "Intraday"], ["MARGIN", "Carry"]], c.product);
      prod.addEventListener("change", () => setCfg({ product: prod.value }));
      body.replaceChildren(
        h("section", {}, h("h3", {}, "Figures ", h("small", {}, "drag or use the arrows to reorder")), list),
        h("section", {}, h("h3", {}, "Prices"), basis, h("p", { class: "muted small" }, "Touch: the ask to buy, the bid to sell. Missing quotes fall back to LTP.")),
        h("section", {}, h("h3", {}, "Charges"), sw("Figures after charges", () => cfg().net, (v) => setCfg({ net: v }), `Brokerage, STT and fees (rates as of ${O.CHARGE_RATES.asOf})`)),
        h("section", {}, h("h3", {}, "Placing"), h("div", { class: "pop-segs" }, h("span", { class: "muted small" }, "Product"), prod, h("span", { class: "muted small" }, "Wait for each hedge"), wait)),
      );
    };
    const popEl = h(
      "div",
      { class: "popover customise", role: "dialog", "aria-label": "Customise the builder" },
      h("div", { class: "pop-head" }, h("strong", {}, "Customise"), h("button", { type: "button", class: "small plain reset", onclick: () => { st.scfg = O.strategyConfig({ group: cfg().group }); save(); metricsEl.__sig = ""; drawAll(); draw(); } }, icon("refresh"), "Reset"), h("button", { type: "button", class: "icon-btn tiny", "aria-label": "Close", onclick: () => closePop() }, icon("close"))),
      body,
    );
    const outside = (e) => {
      if (!popEl.contains(e.target) && !gearBtn.contains(e.target) && !moreBtn.contains(e.target)) closePop();
    };
    const esc = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closePop();
      }
    };
    pop = { el: popEl, outside, esc };
    draw();
    gearBtn.setAttribute("aria-expanded", "true");
    head.append(popEl);
    // Desktop and tablet: never past the bottom of the screen (the body scrolls inside). The phone sheet is fixed.
    if (!isPhone()) popEl.style.maxHeight = `${Math.max(240, Math.round(innerHeight - popEl.getBoundingClientRect().top - 16))}px`;
    popEl.querySelector("button, input")?.focus();
    setTimeout(() => {
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", esc, true);
    });
  }
  function closePop() {
    if (!pop) return;
    pop.el.remove();
    document.removeEventListener("pointerdown", pop.outside, true);
    document.removeEventListener("keydown", pop.esc, true);
    pop = null;
    gearBtn.setAttribute("aria-expanded", "false");
  }
  function openHeadMenu() {
    modal({
      title: "Strategy",
      body: (close) =>
        h(
          "div",
          { class: "stack menu-list" },
          h("button", { type: "button", onclick: () => (close(), setTimeout(openSaved, 350)) }, savedBtn.textContent),
          h("button", { type: "button", disabled: !legs().length, onclick: () => (close(), setTimeout(openSave, 350)) }, "Save"),
          h("button", { type: "button", disabled: !legs().length, onclick: () => (close(), clearAll()) }, "Clear"),
          h("button", { type: "button", onclick: () => (close(), setTimeout(openCustomise, 350)) }, "Customise"),
        ),
    });
  }

  // ── Saves (localStorage, max 50) ──
  function readSaves() {
    try {
      return O.normaliseSaved(JSON.parse(app.local.get(SAVES) ?? "null")).items;
    } catch {
      return [];
    }
  }
  function writeSaves(items) {
    try {
      app.local.set(SAVES, JSON.stringify({ v: 1, items }));
    } catch {
      /* the page works without storage */
    }
  }
  function openSave() {
    if (!x || !legs().length) return;
    const items = readSaves();
    const preset = activePreset();
    const name = h("input", { type: "text", maxlength: "60", value: preset ? preset.name : `Custom ${formatInt(legs().length)}-leg`, "aria-label": "Name" });
    const notes = h("textarea", { maxlength: "500", rows: "3", "aria-label": "Notes", placeholder: "Notes (optional)" });
    const msg = h("p", { class: "warn-text", hidden: true });
    let replaceOk = false;
    name.addEventListener("input", () => ((replaceOk = false), (msg.hidden = true)));
    modal({
      title: "Save strategy",
      body: h("div", { class: "stack" }, h("label", { class: "field" }, h("span", {}, "Name"), name), h("label", { class: "field" }, h("span", {}, "Notes"), notes), h("p", { class: "muted small" }, "Saved in this browser with today's prices, so you can compare later."), msg),
      buttons: [
        { label: "Cancel", value: false },
        {
          label: "Save",
          cls: "primary",
          onClick: () => {
            const n = name.value.trim().slice(0, 60);
            if (!n) return false;
            const same = items.findIndex((it) => it.name.toLowerCase() === n.toLowerCase());
            if (same >= 0 && !replaceOk) {
              replaceOk = true;
              msg.hidden = false;
              msg.textContent = `"${n}" exists. Save again to replace it.`;
              return false;
            }
            if (same < 0 && items.length >= 50) {
              msg.hidden = false;
              msg.textContent = "50 strategies are saved: delete one first.";
              return false;
            }
            const entry = {
              id: same >= 0 ? items[same].id : `s${O.newLegId()}`,
              name: n,
              underlying: x.c.underlying,
              expiry: x.c.expiry,
              legs: priced.map((l) => ({ id: l.id, kind: l.kind, right: l.right, strike: l.strike, expiry: l.expiry, symbol: l.symbol, lotSize: l.lotSize, side: l.side, lots: l.lots, on: l.on, entry: l.price, ivAtSave: l.kind === "OPT" ? l.iv : null })),
              spotAtSave: x.spot,
              forwardAtSave: x.F,
              target: wi.target,
              ivShift: wi.ivShift,
              savedAt: new Date().toISOString(),
              notes: notes.value.trim().slice(0, 500),
            };
            const next = [...items];
            if (same >= 0) next[same] = entry;
            else next.unshift(entry);
            writeSaves(next);
            toast(`Saved "${n}"`);
            drawHead();
            return true;
          },
        },
      ],
    });
  }
  function sinceSaved(it) {
    if (!x || it.underlying !== x.c.underlying || it.expiry !== x.c.expiry) return null;
    let t = 0;
    for (const l of it.legs) {
      if (l.on === false) continue;
      const q = quoteOf(l);
      const exitSide = l.side === "BUY" ? "SELL" : "BUY";
      const p = O.basisPrice(q, exitSide, "touch").price;
      if (p === null || !isFigure(l.entry)) return null;
      t += (l.side === "BUY" ? 1 : -1) * (p - l.entry) * O.legUnits(l, x.lot);
    }
    return t;
  }
  function openSaved() {
    const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
    const pricesSeg = segmented("Load at", [["live", "Live prices"], ["saved", "Saved prices"]], "live");
    const listEl = h("div", { class: "saved-list" });
    const file = h("input", { type: "file", accept: "application/json,.json", class: "sr-only", "aria-label": "Import strategies from a JSON file" });
    let closeFn = null;
    const draw = () => {
      const items = readSaves();
      listEl.replaceChildren(
        ...(items.length
          ? items.map((it) => {
              const expired = it.expiry < today;
              const net = O.netPremium(it.legs.map((l) => ({ ...l, price: l.entry })), x?.lot ?? 1);
              const since = expired ? null : sinceSaved(it);
              const del = () => {
                const all = readSaves();
                writeSaves(all.filter((s2) => s2.id !== it.id));
                draw();
                drawHead();
                toast(h("span", { class: "toast-undo-row" }, `Deleted "${it.name}" · `, h("button", { type: "button", class: "toast-undo", onclick: () => (writeSaves([it, ...readSaves()].slice(0, 50)), drawHead(), toast("Restored")) }, "Undo")));
              };
              const rename = () => {
                const n = prompt("New name", it.name);
                if (!n || !n.trim()) return;
                writeSaves(readSaves().map((s2) => (s2.id === it.id ? { ...s2, name: n.trim().slice(0, 60) } : s2)));
                draw();
              };
              return h(
                "div",
                { class: `saved-row ${expired ? "expired" : ""}`.trim() },
                h(
                  "div",
                  { class: "saved-main" },
                  h("strong", {}, it.name, expired ? h("span", { class: "pill tiny" }, "Expired") : null),
                  h("small", { class: "muted" }, `${it.underlying} ${expiryText(it.expiry)} · ${plural(it.legs.length, "leg")} · ${net >= 0 ? "credit" : "debit"} ${money(Math.abs(net), { signed: false })} · saved ${SAVED_AT.format(new Date(it.savedAt))}`),
                  it.notes ? h("small", { class: "saved-notes" }, it.notes) : null,
                ),
                h("div", { class: "saved-since num" }, h("small", { class: "muted" }, "Since saved"), since === null ? h("span", { class: "muted" }, expired ? "settled" : "open to price") : moneyEl(since)),
                h(
                  "div",
                  { class: "saved-acts" },
                  h("button", { type: "button", class: "small tinted", disabled: expired, title: expired ? "This expiry has settled: the save is read-only" : undefined, onclick: () => (closeFn?.(), loadSaved(it, pricesSeg.value === "saved")) }, "Load"),
                  h("button", { type: "button", class: "small plain", onclick: rename }, "Rename"),
                  h("button", { type: "button", class: "small plain", onclick: del }, "Delete"),
                ),
              );
            })
          : [h("p", { class: "muted" }, "Nothing saved yet. Build a strategy and press Save (Ctrl S).")]),
      );
    };
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      if (!f) return;
      let parsed = null;
      try {
        parsed = JSON.parse(await f.text());
      } catch {
        return toast("That file is not JSON");
      }
      const { items, skipped } = O.normaliseSaved(parsed);
      const cur = readSaves();
      const ids = new Set(cur.map((c) => c.id));
      const room = Math.max(0, 50 - cur.length);
      const add = items.slice(0, room).map((it) => (ids.has(it.id) ? { ...it, id: `s${O.newLegId()}` } : it));
      writeSaves([...add, ...cur]);
      draw();
      drawHead();
      toast(`Imported ${formatInt(add.length)} · skipped ${formatInt(skipped + items.length - add.length)}${skipped ? " (invalid)" : ""}`);
    });
    const exportBtn = h("button", {
      type: "button",
      class: "small plain",
      onclick: () => {
        const blob = new Blob([JSON.stringify({ v: 1, items: readSaves() }, null, 2)], { type: "application/json" });
        const a = h("a", { href: URL.createObjectURL(blob), download: "strategies.json" });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      },
    }, "Export");
    const importBtn = h("button", { type: "button", class: "small plain", onclick: () => file.click() }, "Import");
    draw();
    modal({
      title: "Saved strategies",
      body: (close) => {
        closeFn = close;
        return h("div", { class: "stack" }, h("div", { class: "saved-top" }, h("span", { class: "muted small" }, "Load at"), pricesSeg), listEl, h("div", { class: "saved-foot" }, exportBtn, importBtn, file));
      },
    });
  }
  async function loadSaved(it, atSaved) {
    const ls = it.legs.map((l) => {
      const { entry, ivAtSave, ...rest } = l;
      void ivAtSave;
      return atSaved && isFigure(entry) ? { ...rest, entry, entryTag: "saved" } : rest;
    });
    undo = { key: key(), legs: structuredClone(legs()), label: `Loaded "${it.name}"` };
    const k = `${it.underlying}|${it.expiry}`;
    st.baskets[k] = O.migrateLegs(ls, it.expiry);
    wi.target = num(it.target);
    wi.ivShift = num(it.ivShift) ?? 0;
    ivSlider.value = String(wi.ivShift);
    save();
    if (k !== key()) await switchTo(it.underlying, it.expiry);
    else changed();
    undoToast(`Loaded "${it.name}"`);
  }

  function showKeys() {
    modal({ title: "Strategy builder keys", body: h("table", { class: "keys-table" }, h("tbody", {}, KEYS.map(([k, t]) => h("tr", {}, h("th", { scope: "row" }, k.map((kk) => h("kbd", {}, kk))), h("td", {}, t))))), buttons: [{ label: "Close", value: true }] });
  }

  // Ctrl/Cmd+S and Ctrl/Cmd+Z: the desk's key handler ignores modified keys, so the builder listens for these two.
  const onCtrl = (e) => {
    if (!panel.isConnected || !(e.ctrlKey || e.metaKey) || e.altKey || document.querySelector("dialog[open]")) return;
    const t = e.target;
    const typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) && t.type !== "range" && t.type !== "checkbox";
    const k = e.key.toLowerCase();
    if (k === "s") {
      e.preventDefault();
      openSave();
    } else if (k === "z" && !e.shiftKey && !typing) {
      e.preventDefault();
      doUndo();
    }
  };
  document.addEventListener("keydown", onCtrl);

  loadFunds();

  return {
    panel,
    slot,
    /** The desk's context for this tick (null while there is no chain). */
    draw(xx0, { error = null } = {}) {
      // A chain with no strikes is a loaded state, not a loading one: "--" figures and a plain reason.
      const noRows = Boolean(xx0) && !xx0.c?.rows?.length;
      const xx = noRows ? null : xx0;
      noChain = noRows ? `No strikes for ${xx0.c.underlying ?? st.underlying} ${expiryText(xx0.c.expiry ?? st.expiry)}.` : error ? "error" : null;
      x = xx;
      if (!xx) {
        R = null;
        priced = [];
        drawHead();
        drawLegs();
        drawMetrics();
        drawWarnings();
        drawWhatIf();
        drawScenarios();
        drawBar();
        chart.empty(noRows ? noChain : error ? "The chain is unavailable: retrying." : "Loading the chain…");
        return;
      }
      legs();
      priced = price(xx);
      drawAll();
      if (pv.sig !== sigOf(priced.filter((l) => l.on !== false && l.symbol && isFigure(l.price)))) schedulePreviews();
    },
    addLeg(leg) {
      return addLeg(leg);
    },
    accountChanged() {
      pv.sig = "";
      loadFunds();
      schedulePreviews(true);
    },
    onKey(e) {
      const k = e.key;
      if (k === "a" || k === "A") return openPicker(), true;
      if (k === "[" || k === "]") return shift(k === "]" ? 1 : -1), true;
      if (k === "P") return place(), true;
      if (/^[1-5]$/.test(k)) {
        groupSeg.value = O.PRESET_GROUPS[Number(k) - 1][0];
        return true;
      }
      if (k === "t" || k === "T") return tSlider.focus(), true;
      if (k === "?") return showKeys(), true;
      return false;
    },
    destroy() {
      document.removeEventListener("keydown", onCtrl);
      removeEventListener("resize", syncStick);
      clearTimeout(pvTimer);
      cancelAnimationFrame(raf);
      chart.destroy();
      closePop();
      picker?.close?.();
      picker = null;
      if (window.__mcbStrategyOverlay) delete window.__mcbStrategyOverlay;
    },
  };
}
