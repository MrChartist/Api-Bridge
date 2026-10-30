// The Strategy Builder page (#/strategy, PRD 02 and docs/design/strategy.md round 2). desk.js owns the top line, the
// shared state and the 3 s refresh; this file builds the builder once per visit and patches it on every tick: leg
// prices, the hero figures, the payoff paths and the table cells change in place, so sliders, focus and scroll never
// reset. Legs on the left, the answer (hero + payoff + what-if) on the right. The maths is in options.js (pure,
// tested), drawing in payoff.js, placement in strategy-place.js. Numbers become text only through format.js.
import { api, app, chartSlot, errorState, h, icon, modal, optional, sheetPopover, toast } from "./app.js";
import { DASH, formatFixed, formatInt, formatPercent, formatSigned, isFigure } from "./format.js";
import * as O from "./options.js";
import { basketLotGate, demoStaleAsked, loadReference, refCharges, refSession } from "./reference.js";
import { drawPayoff, money, moneyEl } from "./payoff.js";
import { openPlacement } from "./strategy-place.js";
import { keepFocus, segmented } from "./views.js";
import { reducedMotion } from "./motion.js";
import { nextSessionUnits } from "./vol-context.js";
import { SPAN_METHOD, marginLegsOf, portfolioMargin } from "./span-margin.js";

const SAVES = "mcb.dashboard.strategies";
const NAMES = "mcb.dashboard.strategyNames";
const YEAR_MS = 365 * 86400000;
const DAY_MS = 86400000;
const NO_CHANGE = Symbol("no change");
const HERO = ["net", "maxProfit", "maxLoss", "pop", "breakevens"];
const KEYS = [
  [["A"], "Add a leg: the strike picker"],
  [["[", "]"], "Shift every strike down / up one step"],
  [["-", "="], "Size: fewer / more of the whole strategy"],
  [["Alt", "‹ ›"], "Jump a strike five steps"],
  [["E"], "Expiry menu of the focused leg"],
  [["G"], "Suggest: the target price"],
  [["1", "2", "3"], "On the chart: curves (expiry / + target / + mid-date)"],
  [["⇧P"], "Place: opens the confirm sheet"],
  [["Ctrl S"], "Save this strategy"],
  [["Ctrl Z"], "Undo the last preset, clear, remove, load or adjustment"],
  [["1–5"], "Preset group: Bullish … Hedge & arb"],
  [["T"], "Target-date slider"],
  [["P"], "Pause / resume live prices"],
  [["?"], "This list"],
];
const DAY = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
const WHEN = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const DOW = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric" });
const SAVED_AT = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const ISO_IST = (ms) => new Date(ms + 5.5 * 3600000).toISOString().slice(0, 10);
const expiryText = (e) => (/^\d{4}-\d{2}-\d{2}$/.test(e ?? "") ? DAY.format(new Date(`${e}T00:00:00Z`)) : e ?? "");
const when = (ms) => WHEN.format(new Date(ms)).replace(",", "");
const media = (q) => (typeof matchMedia === "function" ? matchMedia(q).matches : false);
const isPhone = () => media("(max-width: 719px)");
/** A leg held as a position (its entry is the average price): previews and margin use the closing side. */
const isHeld = (l) => l.entry !== undefined && l.entry !== null && l.entryTag !== "saved" && l.entryTag !== "manual";
const num = (v) => (isFigure(v) ? Number(v) : null);
const enc = encodeURIComponent;
/** "1d 4h" / "4h 15m" / "45m" */
function span(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(m / 1440);
  const hh = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  return d ? `${d}d ${hh}h` : hh ? `${hh}h ${mm}m` : `${mm}m`;
}
const plural = (n, one, many = `${one}s`) => `${formatInt(n)} ${n === 1 ? one : many}`;
/** Rupees for tight cells: ₹ + compact past 7 characters, signed when asked. */
const rupees = (v, signed = false) => money(v, { signed });
const SVGNS = "http://www.w3.org/2000/svg";
function sv(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== false) e.setAttribute(k, String(v));
  for (const c of kids.flat()) if (c) e.append(c);
  return e;
}
let glyphSeq = 0;
/** A preset's mini payoff: green above zero, red below (clipped copies), optional target tick. 32 × 16 box. */
function glyphSvg(gl, { w = 32, hgt = 16, target = null } = {}) {
  const id = `gl${(glyphSeq += 1)}`;
  const pts = gl.points.map(([a, b]) => `${a},${b}`).join(" ");
  return sv(
    "svg",
    { viewBox: "0 0 32 16", width: w, height: hgt, preserveAspectRatio: "none", class: "glyph-svg", "aria-hidden": "true" },
    sv("defs", {}, sv("clipPath", { id: `${id}u` }, sv("rect", { x: 0, y: 0, width: 32, height: gl.zero })), sv("clipPath", { id: `${id}d` }, sv("rect", { x: 0, y: gl.zero, width: 32, height: 16 - gl.zero }))),
    sv("line", { x1: 0, x2: 32, y1: gl.zero, y2: gl.zero, class: "g-zero" }),
    target !== null ? sv("line", { x1: target, x2: target, y1: 0, y2: 16, class: "g-target" }) : null,
    sv("polyline", { points: pts, class: "g-line up", "clip-path": `url(#${id}u)` }),
    sv("polyline", { points: pts, class: "g-line dn", "clip-path": `url(#${id}d)` }),
  );
}
/** x of a price inside a presetGlyph box (the same padding rule as O.presetGlyph). */
function glyphX(legs, price) {
  const ks = [...new Set(legs.filter((l) => l.kind !== "FUT").map((l) => l.strike))].sort((a, b) => a - b);
  if (!ks.length || !isFigure(price)) return null;
  const pad = Math.max((ks[ks.length - 1] - ks[0]) * 0.6, ks[0] * 0.02);
  const lo = ks[0] - pad;
  const hi = ks[ks.length - 1] + pad;
  return Math.max(0.5, Math.min(31.5, ((price - lo) / (hi - lo)) * 32));
}
/** Restart a CSS flash on an element (two alternating animation names, no reflow). */
function inkFlash(el, dir) {
  if (!el || reducedMotion()) return;
  el.classList.remove("ink-up", "ink-down");
  el.classList.add(dir > 0 ? "ink-up" : "ink-down");
  el.dataset.flash = el.dataset.flash === "a" ? "b" : "a";
}

/**
 * @param {{ st: object, save: () => void, account: () => object|null, acctPicker?: (onChange: () => void) => Node,
 *   refresh: () => void, switchTo: (u: string, e: string) => Promise<void>, onPositions: () => void }} o
 */
export function createBuilder({ st, save, account, acctPicker = null, refresh, switchTo, onPositions }) {
  st.scfg = O.strategyConfig(st.scfg);
  st.whatIf = st.whatIf && typeof st.whatIf === "object" ? { target: num(st.whatIf.target), ivShift: num(st.whatIf.ivShift) ?? 0 } : { target: null, ivShift: 0 };
  st.baskets = O.migrateBaskets(st.baskets);
  const cfg = () => st.scfg;
  const wi = st.whatIf;
  const key = () => st.underlying;
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
  let staleInfo = { error: null, lastOk: null, live: true, onRetry: null };
  let animateNext = false;
  let compareItem = null;
  let neutral = null;
  let hiLeg = null;
  let focusLegId = null;
  let openLegIds = new Set();
  const chains = new Map(); // expiry → { u, chain, at, loading, error }: the chains of later-expiry legs

  // ── Draft legs: keyed by underlying, each leg with its own expiry (§5.1) ──
  function legs() {
    if (Object.keys(st.baskets).some((k) => k.includes("|"))) st.baskets = O.migrateBaskets(st.baskets);
    const k = key();
    const cur = st.baskets[k];
    const lot = num(st.chain?.lotSize);
    if (!Array.isArray(cur) || cur.some((l) => !l.id || !l.kind || (!l.lotSize && lot) || l.on === undefined || !l.expiry)) st.baskets[k] = O.migrateLegs(cur, st.expiry, { lotSize: lot });
    return st.baskets[k];
  }
  function setLegs(next, { undoLabel = null, keepWhatIf = true, animate = true } = {}) {
    if (undoLabel) undo = { key: key(), legs: structuredClone(legs()), label: undoLabel };
    st.baskets[key()] = O.migrateLegs(next, st.expiry, { lotSize: num(st.chain?.lotSize) });
    if (!keepWhatIf) {
      wi.target = null;
      wi.ivShift = 0;
    }
    if (!st.baskets[key()].length) setName(null);
    neutral = null;
    animateNext = animate;
    save();
    changed();
    if (undoLabel) undoToast(undoLabel);
  }
  /** fn edits a copy of the legs; returning NO_CHANGE aborts (any other value, false included, commits). */
  function mutate(fn, opts) {
    const next = structuredClone(legs());
    if (fn(next) === NO_CHANGE) return;
    setLegs(next, opts);
  }
  const mutateLeg = (id, fn, opts) => mutate((ls) => {
    const l = ls.find((y) => y.id === id);
    if (!l) return NO_CHANGE;
    fn(l, ls);
    return true;
  }, opts);
  function undoToast(label) {
    toast(h("span", { class: "toast-undo-row" }, `${label} · `, h("button", { type: "button", class: "toast-undo", onclick: () => doUndo() }, "Undo")));
  }
  function doUndo() {
    if (!undo) return toast("Nothing to undo", { tone: "info" });
    const u = undo;
    undo = null;
    st.baskets[u.key] = u.legs;
    animateNext = true;
    save();
    if (u.key !== key()) switchTo(u.key, st.expiry);
    else changed();
    toast(`Undone: ${u.label}`);
  }

  // ── Draft names (auto from the structure, editable) ──
  function readNames() {
    try {
      const v = JSON.parse(app.local.get(NAMES) ?? "{}");
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }
  function setName(n) {
    const all = readNames();
    if (n) all[key()] = String(n).slice(0, 60);
    else delete all[key()];
    try {
      app.local.set(NAMES, JSON.stringify(all));
    } catch {
      /* fine without storage */
    }
  }
  const autoName = () => O.strategyName(legs());
  const draftName = () => (legs().length ? readNames()[key()] || autoName() : "New strategy");

  // ── Chains of later expiries (calendars, diagonals): fetched alongside the main one, at most 3 extra ──
  function chainFor(e) {
    if (!x) return null;
    if (!e || e === x.c.expiry) return x.c;
    const c = chains.get(e);
    return c && c.u === st.underlying ? c.chain : null;
  }
  function syncChains() {
    if (!x) return;
    const today = ISO_IST(Date.now());
    // A past expiry has no chain to fetch: its leg shows "expired" with Roll / Remove (compute()).
    const want = [...new Set(legs().filter((l) => l.kind === "OPT" && l.expiry && l.expiry !== x.c.expiry && l.expiry >= today).map((l) => l.expiry))].slice(0, 3);
    for (const [k, c] of chains) if ((!want.includes(k) && k !== sg.back) || c.u !== st.underlying) chains.delete(k);
    for (const e of want) {
      const c = chains.get(e);
      const age = c ? Date.now() - c.at : Infinity;
      // Fresh enough, failing (retry after 30 s), or paused with an answer in hand: no fetch on this tick.
      if (c?.loading || age < 2500 || (c?.error && !c.chain && age < 30000) || (c?.at && !st.live)) continue;
      fetchChain(e);
    }
  }
  async function fetchChain(e) {
    const u = st.underlying;
    const prev = chains.get(e);
    chains.set(e, { u, chain: prev?.u === u ? prev.chain : null, at: prev?.at ?? 0, loading: true, error: null });
    const r = await optional(api(`/v1/optionchain?underlying=${enc(u)}&expiry=${enc(e)}&strikes=40&greeks=true`));
    if (u !== st.underlying) return;
    const c = chains.get(e);
    if (!c) return;
    chains.set(e, { u, chain: r.data?.data ?? c.chain, at: Date.now(), loading: false, error: r.error ?? null });
    if (x) {
      priced = price(x);
      drawLegs();
      drawAnalysis();
    }
    if (sg.back === e) runSuggest();
  }
  const strikesOf = (e) => (chainFor(e)?.rows ?? []).map((r) => r.strike);
  const allStrikes = () => [...new Set([...(x?.c.rows ?? []).map((r) => r.strike), ...[...chains.values()].flatMap((c) => (c.chain?.rows ?? []).map((r) => r.strike))])];

  // ── Pricing (per tick) ──
  const fut = () => (x ? st.futures.find((f) => f.expiry >= x.c.expiry) ?? null : null);
  function quoteOf(l) {
    if (l.kind === "FUT") return l.symbol ? st.quotes.get(l.symbol) ?? null : null;
    return chainFor(l.expiry)?.rows.find((r) => r.strike === l.strike)?.[l.right === "CE" ? "ce" : "pe"] ?? null;
  }
  function price(xx) {
    const atmIv = num(xx.sm.atmIv);
    const now = Date.now();
    const today = ISO_IST(now);
    return legs().map((l) => {
      const ch = l.kind === "OPT" ? chainFor(l.expiry) : null;
      const later = l.kind === "OPT" && l.expiry && l.expiry !== xx.c.expiry ? chains.get(l.expiry) : null;
      const expired = l.kind === "OPT" && Boolean(l.expiry) && l.expiry < today;
      const q = quoteOf(l);
      const row = ch?.rows.find((r) => r.strike === l.strike) ?? null;
      const live = O.basisPrice(q, l.side, cfg().basis);
      const bp = isFigure(l.entry) ? { price: l.entry, fallback: false } : live;
      const iv = num(q?.iv);
      const lotSize = num(l.lotSize) || xx.lot;
      const symbol = q?.symbol ?? l.symbol ?? null;
      const p = {
        ...l,
        symbol,
        lotSize,
        q,
        price: bp.price,
        livePrice: live.price,
        fallback: bp.fallback,
        manual: l.entryTag === "manual" && isFigure(l.entry),
        iv: iv ?? atmIv,
        ivFallback: iv === null && l.kind === "OPT",
        years: O.yearsToExpiry(l.expiry ?? xx.c.expiry, now, refSession(st.ref).close),
        loading: l.kind === "OPT" && !ch && !expired && Boolean(later?.loading || (!later && l.expiry !== xx.c.expiry)),
        expired,
        chainError: l.kind === "OPT" && !ch && !expired && Boolean(later?.error) && !later?.loading,
        inChain: l.kind === "FUT" || Boolean(row) || !ch,
        spreadPct: O.spreadPct(q),
        freezeQty: pv.freeze.get(symbol) ?? null,
        label: O.legLabel(l),
      };
      if (l.kind === "FUT") {
        const f = st.futures.find((ff) => ff.symbol === l.symbol);
        p.basis0 = num(q?.ltp) !== null && xx.spot !== null ? q.ltp - xx.spot : 0;
        p.futYears = O.yearsToExpiry(l.expiry ?? f?.expiry, now, refSession(st.ref).close);
        p.freezeQty = p.freezeQty ?? f?.freezeQty ?? null;
      }
      return p;
    });
  }

  // ── Figures (per tick, and per animation frame while a slider moves: no network) ──
  function staleAge() {
    const t = Date.parse(staleInfo.lastOk ?? "");
    return Number.isFinite(t) ? Date.now() - t : null;
  }
  function compute() {
    const xx = x;
    const all = priced;
    const act = all.filter((l) => l.on !== false);
    const missing = act.filter((l) => l.price === null);
    const ok = act.length > 0 && missing.length === 0;
    const now = Date.now();
    const opt = act.filter((l) => l.kind === "OPT");
    const optYears = opt.map((l) => l.years).filter(isFigure);
    // T1: the first expiry among the legs (the "expiry" curve is drawn there; later legs keep their time value).
    const T = Math.max(0, optYears.length ? Math.min(...optYears) : xx.years ?? 0);
    const exps = [...new Set(opt.map((l) => l.expiry).filter(Boolean))].sort();
    const front = exps[0] ?? xx.c.expiry;
    const multi = exps.length > 1;
    const expMs = O.expiryCloseMs(front, refSession(st.ref).close) ?? now;
    if (wi.target !== null && wi.target <= now) wi.target = null;
    const targetMs = wi.target === null ? now : Math.min(wi.target, expMs);
    // Vol-time that passes before the target date (the clock: a weekend costs its weight, not two full days).
    const el = Math.max(0, Math.min(T, O.elapsedVolYears(front, now, targetMs, refSession(st.ref).close) ?? (targetMs - now) / YEAR_MS));
    const shift = wi.ivShift;
    const lot = xx.lot;
    const ivNow = num(xx.sm.atmIv) !== null ? Math.max(1, xx.sm.atmIv + shift) : null;
    const ch = ok ? O.charges(act, refCharges(st.ref), { lotSize: lot }) : null;
    // Net of charges: exit charges are held inside the strikes ± 3σ, so the S = 0 / 2 × top tails cannot inflate max loss.
    const net = ok && cfg().net ? O.strategyCharges(act, refCharges(st.ref), { lotSize: lot, forward: xx.F, ivPct: ivNow, years: T }) : null;
    const stats = ok ? O.strategyStats(act, lot, { forward: xx.F, ivPct: xx.sm.atmIv, years: T, ivShift: shift, spot: xx.spot, charges: net }) : null;
    const expiryToday = O.isExpiryDay(front);
    // One margin model everywhere (span-margin.js): the paper engine, the ticket, this line and Positions agree.
    const est = ok && xx.F ? portfolioMargin(marginLegsOf(act.map((l) => ({ ...l, units: O.legUnits(l, lot), iv: l.kind === "OPT" ? l.iv : null })), { underlying: xx.c.underlying, lotSize: lot, expiry: xx.c.expiry }), { nowMs: now, forwards: { [xx.c.underlying]: xx.F }, ivs: { [xx.c.underlying]: xx.sm.atmIv } }) : null;
    const acct = pv.sig === sigOf(act) ? pv.margin : null;
    const margin = acct ?? est?.required ?? null;
    const basis = xx.F !== null && xx.spot !== null ? xx.F - xx.spot : 0;
    const vt = ok && xx.spot !== null ? O.valueAt(act, xx.spot, lot, null, basis, { el, ivShift: shift }) : null;
    const atTarget = vt === null ? null : vt - (net?.entry ?? 0);
    const greeks = ok && xx.spot !== null ? O.netGreeksModel(act, xx.spot, { lotSize: lot, basis, el, ivShift: shift }) : null;
    const ev = ok ? O.expectedValue(act, lot, { forward: xx.F, ivPct: xx.sm.atmIv, years: T, ivShift: shift, charges: net }) : null;
    const ratios = O.strategyRatios({ maxProfit: stats?.maxProfit ?? null, maxLoss: stats?.maxLoss ?? null, margin, locked: stats?.locked ?? null, net: stats?.net ?? null, years: T });
    const b1 = O.sigmaBand(xx.F, ivNow, T, 1);
    const rs = `${act.map((l) => (l.kind === "FUT" ? "F" : `${l.strike}${l.expiry}`)).sort().join()}|${xx.sm.atm}|${act.length}`;
    if (rs !== rangeSig) {
      rangeSig = rs;
      range = null;
    }
    const model = ok ? O.payoffModel(act, { lotSize: lot, spot: xx.spot, forward: xx.F, years: T, el, ivShift: shift, ivPct: xx.sm.atmIv, charges: net, range, curves: cfg().curves }) : null;
    if (model && !range) range = { lo: model.lo, hi: model.hi };
    // Closing held legs releases margin: no shortfall check. Otherwise the account's own figure blocks, the estimate warns.
    const exit = closeMode();
    const age = staleAge();
    const stale = age !== null && age > O.STALE_MS && (staleInfo.live || staleInfo.error);
    const warnings = O.strategyWarnings({ legs: act, strikes: allStrikes(), stats, spot: xx.spot, band1: b1, margin: exit ? null : { required: margin, free: funds.free, source: acct !== null ? "account" : "estimate" }, live: false, expiryToday: expiryToday && !multi, lotSize: lot, legCount: all.length, chainAgeMs: stale ? age : null, today: ISO_IST(now), rates: refCharges(st.ref) });
    // A leg past its expiry, or whose chain failed to load, blocks with a reason and a way out (Roll / Remove).
    const dead = act.filter((l) => l.expired || l.chainError);
    if (dead.length) {
      const names = new Set(dead.map((l) => l.label));
      for (let i = warnings.length - 1; i >= 0; i -= 1) if ([...names].some((n) => warnings[i].text.startsWith(n))) warnings.splice(i, 1);
      warnings.unshift(...dead.map((l) => ({ code: "EXPIRED_LEG", severity: "block", legId: l.id, text: l.expired ? `${l.label} ${expiryText(l.expiry)} has expired` : `No chain for ${expiryText(l.expiry)}: ${l.label} has no price` })));
    }
    const pMax = model && ivNow && stats?.maxProfit !== null && stats?.maxProfit !== undefined ? O.probMaxProfit(model.xs, model.expiry, xx.F, T, ivNow) : null;
    const bes = stats?.breakevens ?? [];
    const beNear = bes.length && xx.spot !== null ? bes.reduce((b, v) => (Math.abs(v - xx.spot) < Math.abs(b - xx.spot) ? v : b), bes[0]) : null;
    const pTouch = beNear !== null && ivNow ? O.probTouch(beNear, xx.F, T, ivNow) : null;
    return { dead, all, act, missing, ok, T, el, expMs, targetMs, shift, lot, ch, net, stats, est, acct, margin, atTarget, greeks, ev, ratios, model, warnings, expiryToday, b1, ivNow, exit, front, multi, basis, pMax, beNear, pTouch, stale, age };
  }
  const sigOf = (act) => JSON.stringify([st.account, cfg().product, act.map((l) => [l.symbol, l.side, l.lots, isHeld(l)])]);

  // ── DOM: built once ──
  const nameBtn = h("button", { type: "button", class: "strat-name", title: "Rename this strategy" });
  const nameIn = h("input", { type: "text", class: "strat-name-in", maxlength: "60", "aria-label": "Strategy name", hidden: true });
  const ctxLine = h("span", { class: "strat-ctx" });
  nameBtn.addEventListener("click", () => {
    if (!legs().length) return;
    nameIn.value = draftName();
    nameBtn.hidden = true;
    nameIn.hidden = false;
    nameIn.focus();
    nameIn.select();
  });
  const endRename = (commit) => {
    if (nameIn.hidden) return;
    if (commit) setName(nameIn.value.trim() && nameIn.value.trim() !== autoName() ? nameIn.value.trim() : null);
    nameIn.hidden = true;
    nameBtn.hidden = false;
    drawHead();
  };
  nameIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") endRename(true);
    else if (e.key === "Escape") {
      e.stopPropagation();
      endRename(false);
    }
  });
  nameIn.addEventListener("blur", () => endRename(true));
  const savedBtn = h("button", { type: "button", class: "small plain head-txt", onclick: () => openSaved() }, "Saved");
  const saveBtn = h("button", { type: "button", class: "small plain head-txt", title: "Save (Ctrl S)", onclick: () => openSave() }, "Save");
  const gearBtn = h("button", { type: "button", class: "icon-btn head-gear", "aria-haspopup": "dialog", "aria-label": "Customise the builder", title: "Customise: figures, prices, charges" }, icon("sliders"));
  const moreBtn = h("button", { type: "button", class: "icon-btn head-more", "aria-haspopup": "dialog", "aria-label": "More: convert, clear, saved, customise", onclick: () => openHeadMenu() }, icon("more"));
  const placeBtn = h("button", { type: "button", class: "small primary head-place place-btn", onclick: () => place() }, "Place");
  gearBtn.addEventListener("click", () => openCustomise());
  const head = h("header", { class: "panel-head strat-head" }, h("div", { class: "strat-title" }, nameBtn, nameIn, ctxLine), h("div", { class: "strat-actions" }, savedBtn, saveBtn, gearBtn, moreBtn, placeBtn));
  const staleBar = h("div", { class: "strat-stale", hidden: true, role: "status" });

  // Presets: group control, then chips (with legs) or cards (an empty draft).
  const groupSeg = segmented("Preset group", O.PRESET_GROUPS, cfg().group);
  groupSeg.classList.add("group-seg");
  groupSeg.addEventListener("change", () => {
    if (groupSeg.value === cfg().group) return;
    setCfg({ group: groupSeg.value });
    chipsSig = "";
    drawChips();
  });
  const chips = h("div", { class: "preset-chips", role: "group", "aria-label": "Strategies in this group" });
  const presetsEl = h("section", { class: "strat-presets sx", "aria-label": "Ready-made strategies" }, h("div", { class: "hscroll" }, groupSeg), h("div", { class: "chips-wrap" }, chips));

  // Legs
  const legsEl = h("div", { class: "strat-legs sx", role: "list", "aria-label": "Legs" });
  const addBtn = h("button", { type: "button", class: "small add-leg", "aria-haspopup": "dialog", title: "Add a leg (A)" }, icon("plus"), "Add leg");
  addBtn.addEventListener("click", () => openPicker());
  const stratBtn = h("button", { type: "button", class: "small plain strat-sheet-btn", "aria-haspopup": "dialog", onclick: () => openPresetSheet(stratBtn) }, "Strategies");
  const shiftDn = h("button", { type: "button", class: "small plain step-btn", "aria-label": "Shift every strike down one step", title: "Shift strikes down ([)", onclick: () => shift(-1) }, "‹");
  const shiftUp = h("button", { type: "button", class: "small plain step-btn", "aria-label": "Shift every strike up one step", title: "Shift strikes up (])", onclick: () => shift(1) }, "›");
  const sizeDn = h("button", { type: "button", class: "small plain step-btn", "aria-label": "Smaller: one size step down", title: "Size down (-)", onclick: () => resize(-1) }, "−");
  const sizeUp = h("button", { type: "button", class: "small plain step-btn", "aria-label": "Bigger: one size step up", title: "Size up (=)", onclick: () => resize(1) }, "+");
  const sizeIn = h("input", { type: "number", min: "1", max: "10000", step: "1", inputmode: "numeric", class: "size-in", "aria-label": "Size multiplier: every leg's lots in proportion" });
  sizeIn.addEventListener("change", () => {
    const g = Math.floor(Number(sizeIn.value));
    if (g >= 1) setSize(g);
    else sizeIn.value = String(O.legsGcd(legs()));
  });
  const toolsMore = h("button", { type: "button", class: "icon-btn tools-more", "aria-haspopup": "dialog", "aria-label": "More: clear, flip, delta-neutralise", onclick: () => openToolsMenu(toolsMore) }, icon("more"));
  const legCount = h("span", { class: "leg-count" });
  const tools = h(
    "div",
    { class: "leg-tools sx" },
    h("div", { class: "picker-anchor" }, addBtn),
    stratBtn,
    h("span", { class: "tool-group", role: "group", "aria-label": "Shift strikes" }, shiftDn, h("span", { class: "tool-lbl" }, "Shift"), shiftUp),
    h("span", { class: "tool-group size-group", role: "group", "aria-label": "Size" }, h("span", { class: "tool-lbl" }, "Size"), sizeDn, h("label", { class: "size-wrap" }, sizeIn, h("span", { class: "size-x", "aria-hidden": "true" }, "×")), sizeUp),
    toolsMore,
    legCount,
  );
  const adjustEl = h("div", { class: "strat-adjust sx", hidden: true, role: "status" });

  // Risk & capital (§5.3)
  const mBar = h("div", { class: "mbar", "aria-hidden": "true" }, h("span", { class: "mb-fill" }), h("span", { class: "mb-short" }), h("span", { class: "mb-free" }));
  const mLeft = h("span", { class: "mb-l" });
  const mRight = h("span", { class: "mb-r" });
  const mSub = h("div", { class: "mb-sub" });
  const greekCell = (k, label) => {
    const value = h("span", { class: "gk-v" });
    const sub = h("span", { class: "gk-s" });
    const spark = h("span", { class: "gk-spark" });
    const b = h("button", { type: "button", class: `gk gk-${k}`, title: "Greeks across price: open the Greeks table", onclick: () => (setCfg({ table: "greeks" }), tableEl.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" })) }, h("span", { class: "gk-k" }, label), value, sub, spark);
    return { b, value, sub, spark };
  };
  const gks = { delta: greekCell("delta", "Δ Delta"), gamma: greekCell("gamma", "Γ Gamma"), theta: greekCell("theta", "Θ Theta"), vega: greekCell("vega", "ν Vega") };
  // Return and probability lines: built once, only their values are patched (focus on Charges survives every tick).
  const fig = (label, title) => {
    const b = h("b", {});
    const el = h("span", title ? { title } : {}, label, b);
    return { el, b, label: el.firstChild };
  };
  const romF = fig("ROM ");
  const rrF = fig("R:R ");
  const evF = fig("EV ", "Expected P&L under the model the options are priced with: close to −(spreads + charges) by construction");
  const popF = fig("POP ", "Model probability · uncalibrated: the chance of a profit at expiry from a log-normal model at the ATM IV. Calibration: not yet measured");
  const pMaxF = fig("P(max profit) ", "Model probability · uncalibrated: the chance the expiry price lands where the strategy makes its maximum");
  const touchF = fig("P(touch) ", "Model probability · uncalibrated: the chance the price touches the nearest breakeven before expiry, about twice the chance it closes beyond it (reflection approximation)");
  const chargesB = h("button", { type: "button", class: "link-btn", "aria-haspopup": "dialog", onclick: () => openCharges(chargesB) }, "Charges");
  const retLine = h("div", { class: "risk-line ret" }, romF.el, rrF.el, evF.el, chargesB);
  const probLine = h("div", { class: "risk-line prob" }, popF.el, pMaxF.el, touchF.el);
  /** Patch a figure's value (text node only) and its colour class. */
  const setFig = (f, t, cls = "") => {
    if (f.b.textContent !== t) f.b.textContent = t;
    if (f.b.className !== cls) f.b.className = cls;
  };
  const setText = (node, t) => {
    if (node.textContent !== t) node.textContent = t;
  };
  const riskBody = h("div", { class: "risk-body" }, h("div", { class: "risk-sec margin" }, h("div", { class: "mb-head" }, mLeft, mRight), mBar, mSub), h("div", { class: "risk-sec greeks" }, ...Object.values(gks).map((g) => g.b)), h("div", { class: "risk-sec lines" }, retLine, probLine));
  const riskToggle = h("button", { type: "button", class: "sec-toggle", "aria-expanded": String(cfg().riskOpen) }, h("span", { class: "sec-title" }, "Risk & capital"), h("span", { class: "sec-sum" }), icon("down"));
  riskToggle.addEventListener("click", () => setCfg({ riskOpen: !cfg().riskOpen }));
  const riskEl = h("section", { class: "strat-risk sx", "aria-label": "Risk and capital" }, riskToggle, riskBody);

  // Suggest (§5.7)
  const sg = { target: null, date: null, risk: "defined", maxCap: null, vol: false, job: 0, results: null, busy: false, back: null };
  const sgTarget = h("input", { type: "number", inputmode: "decimal", class: "sg-target", "aria-label": "Target price" });
  const sgDn = h("button", { type: "button", class: "small plain step-btn", "aria-label": "Target one strike lower", onclick: () => stepTarget(-1) }, "‹");
  const sgUp = h("button", { type: "button", class: "small plain step-btn", "aria-label": "Target one strike higher", onclick: () => stepTarget(1) }, "›");
  const sgRange = h("input", { type: "range", class: "sg-range wi-range", "aria-label": "Target price within ±2σ" });
  const sgQuick = h("div", { class: "sg-quick", role: "group", "aria-label": "Quick targets" });
  const sgDate = h("select", { class: "sg-date", "aria-label": "By date" });
  const sgRisk = segmented("Risk", [["defined", "Defined"], ["any", "Any"]], "defined");
  const sgCap = h("input", { type: "number", inputmode: "numeric", min: "0", class: "sg-cap", placeholder: "Any", "aria-label": "Max capital in rupees" });
  const sgVol = h("button", { type: "button", class: "small chip-btn sg-vol", "aria-pressed": "false" }, "Big move either way");
  const sgView = h("span", { class: "sg-view" });
  const sgOut = h("div", { class: "sg-out", "aria-live": "polite" });
  const sgBody = h(
    "div",
    { class: "sg-body" },
    h("div", { class: "sg-row" }, h("span", { class: "sg-k" }, "Target"), h("span", { class: "sg-tp" }, sgDn, sgTarget, sgUp), sgView),
    sgRange,
    sgQuick,
    h("div", { class: "sg-row" }, h("span", { class: "sg-k" }, "By"), sgDate, h("span", { class: "sg-k" }, "Risk"), sgRisk),
    h("div", { class: "sg-row" }, h("span", { class: "sg-k" }, "Max capital"), h("label", { class: "sg-capw" }, h("span", { "aria-hidden": "true" }, "₹"), sgCap), sgVol),
    sgOut,
  );
  const sgToggle = h("button", { type: "button", class: "sec-toggle", "aria-expanded": String(cfg().suggestOpen) }, h("span", { class: "sec-title" }, "Suggest from my view"), h("span", { class: "sec-sum" }), icon("down"));
  sgToggle.addEventListener("click", () => setCfg({ suggestOpen: !cfg().suggestOpen }));
  const suggestEl = h("section", { class: "strat-suggest sx", "aria-label": "Strategy suggestions" }, sgToggle, sgBody);

  const build = h("div", { class: "strat-build" }, presetsEl, legsEl, tools, adjustEl, riskEl, suggestEl);

  // Hero strip (§5.4)
  const heroCell = (k, label) => {
    const l = h("span", { class: "hero-k" }, label);
    const v = h("span", { class: "hero-v" });
    const s = h("span", { class: "hero-s" });
    const el = h("div", { class: `hero-c hero-${k}` }, l, v, s);
    return { el, l, v, s };
  };
  const hero = { net: heroCell("net", "Net"), maxProfit: heroCell("maxProfit", "Max profit"), maxLoss: heroCell("maxLoss", "Max loss"), pop: heroCell("pop", "POP"), breakevens: heroCell("breakevens", "Breakevens") };
  const ringArc = sv("circle", { class: "ring-arc", cx: 14, cy: 14, r: 11, "stroke-dasharray": "69.12", "stroke-dashoffset": "69.12", transform: "rotate(-90 14 14)" });
  const ring = sv("svg", { class: "pop-ring", viewBox: "0 0 28 28", width: 24, height: 24, "aria-hidden": "true" }, sv("circle", { class: "ring-track", cx: 14, cy: 14, r: 11 }), ringArc);
  // The POP ring sits inline before the value (one line: ring, figure), not in a padded corner of the cell.
  const popLine = h("span", { class: "pop-line" });
  hero.pop.v.replaceWith(popLine);
  popLine.append(ring, hero.pop.v);
  const heroEl = h("div", { class: "strat-hero sx", role: "group", "aria-label": "Key figures" }, ...HERO.map((k) => hero[k].el));
  const warnEl = h("div", { class: "strat-warns sx", "aria-label": "Warnings" });
  // Payoff
  const chartHost = h("div", { class: "payoff strat-payoff" });
  const chart = drawPayoff(chartHost, {});
  const curvesSeg = segmented("Curves on the chart", [["1", "1"], ["2", "2"], ["3", "3"]], String(cfg().curves));
  curvesSeg.classList.add("curves-seg");
  for (const [b, t] of [...curvesSeg.querySelectorAll("button")].map((b, i) => [b, ["Expiry only", "Expiry and target date", "Expiry, target and mid-date"][i]])) b.title = t;
  curvesSeg.addEventListener("change", () => setCfg({ curves: Number(curvesSeg.value) }));
  const chartMore = h("button", { type: "button", class: "icon-btn chart-more", "aria-haspopup": "dialog", "aria-label": "Chart options", onclick: () => openChartMenu() }, icon("more"));
  chart.tools.append(h("span", { class: "curves-lbl" }, "Curves"), curvesSeg, chartMore);
  // What-if: sliders (desktop, tablet) or chips that open a sheet (phone)
  const tSlider = h("input", { type: "range", min: "0", max: "0", step: "15", value: "0", class: "wi-range wi-t-range", "aria-label": "Target date" });
  const tLabel = h("span", { class: "wi-val" });
  const ivSlider = h("input", { type: "range", min: "-10", max: "10", step: "0.5", value: String(wi.ivShift), class: "wi-range", "aria-label": "IV shift in vol points" });
  const ivLabel = h("span", { class: "wi-val" });
  const resetWi = h("button", { type: "button", class: "small plain wi-reset", onclick: () => ((wi.target = null), (wi.ivShift = 0), (ivSlider.value = "0"), save(), drawAnalysis()) }, "Reset");
  const wiT = h("label", { class: "wi wi-t" }, h("span", { class: "wi-head" }, h("span", { class: "wi-name" }, "Target date"), tLabel), tSlider);
  const wiIv = h("label", { class: "wi wi-iv" }, h("span", { class: "wi-head" }, h("span", { class: "wi-name" }, "IV shift"), ivLabel), ivSlider);
  const wiChipT = h("button", { type: "button", class: "small chip-btn wi-chip", "aria-haspopup": "dialog", onclick: () => openWhatIfSheet(wiChipT) });
  const wiChipIv = h("button", { type: "button", class: "small chip-btn wi-chip", "aria-haspopup": "dialog", onclick: () => openWhatIfSheet(wiChipIv) });
  const wiChips = h("div", { class: "wi-chips" }, wiChipT, wiChipIv);
  const whatIf = h("div", { class: "strat-whatif sx" }, wiT, wiIv, resetWi, wiChips);
  const note = h("p", { class: "model-note sx" });
  const moreRow = h("div", { class: "more-figs sx", "aria-label": "More figures" });
  // P&L table (§5.2)
  const tabSeg = segmented("Table", [["spot", "By spot"], ["grid", "Grid"], ["greeks", "Greeks"]], cfg().table);
  tabSeg.classList.add("tab-seg");
  tabSeg.addEventListener("change", () => setCfg({ table: tabSeg.value }));
  const modeSeg = segmented("Price levels", [["strikes", "Strikes"], ["pct", "%"], ["sigma", "σ"]], cfg().scenario);
  modeSeg.classList.add("mode-seg");
  modeSeg.addEventListener("change", () => setCfg({ scenario: modeSeg.value }));
  const tableNote = h("span", { class: "tbl-note" });
  const tableBody = h("div", { class: "tbl-body" });
  const tableEl = h("section", { class: "strat-table sx", "aria-label": "P&L table" }, h("div", { class: "tbl-head" }, h("span", { class: "sec-title" }, "P&L"), tabSeg, modeSeg, tableNote), tableBody);
  // First load failed (no chain at all): one error card in place of the analysis.
  const errHost = h("div", { class: "strat-err sx", hidden: true });
  const analysis = h("div", { class: "strat-analysis" }, errHost, heroEl, warnEl, chartHost, whatIf, note, moreRow, tableEl);
  // Loading skeleton (§6.2): the layout's own shapes.
  const skel = h(
    "div",
    { class: "strat-skel", "aria-hidden": "true" },
    h("div", { class: "sk-hero" }, ...HERO.map(() => h("span", { class: "skel" }))),
    h("div", { class: "sk-plot skel" }, h("i"), h("i"), h("i")),
    h("div", { class: "sk-legs" }, ...[0, 1, 2, 3].map(() => h("span", { class: "skel" }))),
  );
  // Sticky action bar (phone and tablet)
  const barNet = h("strong", { class: "bar-net" });
  const barSub = h("small", { class: "bar-sub" });
  const barPlace = h("button", { type: "button", class: "primary bar-place place-btn", onclick: () => place() }, "Place");
  const bar = h("div", { class: "strat-bar" }, h("div", { class: "bar-figs" }, barNet, barSub), barPlace);
  const keysEl = h("div", { class: "desk-keys strat-keys", "aria-hidden": "true" }, [["A", "add leg"], ["[ ]", "shift"], ["- =", "size"], ["G", "suggest"], ["⇧P", "place"], ["?", "keys"]].map(([k, t]) => h("span", { class: "kbd-pair" }, h("kbd", {}, k), t)));
  const liveRegion = h("div", { class: "sr-only", "aria-live": "polite" });
  const announce = (t) => {
    liveRegion.textContent = "";
    setTimeout(() => (liveRegion.textContent = t), 30);
  };
  const grid = h("div", { class: "strat-grid" }, build, analysis, skel);
  const panel = h("section", { class: "desk-panel strat-panel is-loading", "data-panel": "strategy", "aria-label": "Strategy builder" }, staleBar, head, grid, keysEl, bar, liveRegion);

  // The price chart: no placeholder panel; once a chart engine registers, the payoff ⋯ menu offers it (a sheet with
  // the engine's slot). The engine reads window.__mcbStrategyOverlay() for the strikes, breakevens and ±σ.
  function openPriceChart() {
    const box = chartSlot("Price chart with your strikes, breakevens and ±σ");
    if (!box) return;
    box.dataset.chartSlot = "strategy";
    modal({ title: "Price chart", body: h("div", { class: "strat-price-chart" }, box), buttons: [{ label: "Close", value: false }] });
  }
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
    if ("product" in patch) schedulePreviews(true);
    if ("curves" in patch) animateNext = true;
    if ("suggestOpen" in patch && cfg().suggestOpen) runSuggest();
    drawAnalysis();
    drawBuildExtras();
  }
  const symOf = (l) => (l.kind === "FUT" ? l.symbol : chainFor(l.expiry)?.rows.find((r) => r.strike === l.strike)?.[l.right === "CE" ? "ce" : "pe"]?.symbol ?? null);
  function presetOpts() {
    const f = fut();
    return { move: x.move, forward: x.F, fut: f ? { symbol: f.symbol, expiry: f.expiry, lotSize: f.lotSize } : null, back: O.backExpiry(st.expiries ?? [], x.c.expiry) };
  }
  function applyPreset(p) {
    if (!x) return;
    if (p.needsFut && !fut()) return toast(`No future found for ${st.underlying}.`, { tone: "warn" });
    const raw = O.presetLegs(p.id, x.c, presetOpts());
    if (!raw.length) return toast(p.multi ? "No later expiry is listed for a calendar." : "This strategy needs strikes the chain does not have.", { tone: "warn" });
    const withSyms = raw.map((l) => (l.kind === "FUT" ? l : { ...l, expiry: l.expiry ?? x.c.expiry, symbol: symOf({ ...l, expiry: l.expiry ?? x.c.expiry }), lotSize: x.lot }));
    setName(null);
    setLegs(withSyms, { undoLabel: `${p.name} applied`, keepWhatIf: false });
    ivSlider.value = "0";
  }
  function clearAll() {
    if (!legs().length) return;
    setLegs([], { undoLabel: "Cleared" });
  }
  function shift(dir) {
    if (!x) return;
    const cur = legs();
    const next = cur.map((l) => {
      if (l.kind === "FUT") return l;
      const k = O.stepStrike(strikesOf(l.expiry), l.strike, dir);
      return k === null || k === l.strike ? null : { ...l, strike: k, symbol: null, entry: undefined, entryTag: undefined };
    });
    if (next.some((l) => l === null)) return toast("A leg is at the edge of the loaded strikes", { tone: "warn" });
    setLegs(next.map((l) => (l.kind === "FUT" ? l : { ...l, symbol: symOf(l) })));
    announce(`Strikes shifted ${dir > 0 ? "up" : "down"}`);
  }
  function setSize(g) {
    const cur = legs();
    if (!cur.length) return;
    const next = O.sizeLegs(cur, g);
    if (next.every((l, i) => l.lots === cur[i].lots)) return;
    setLegs(next);
    announce(`Size ${formatInt(O.legsGcd(next))}×`);
  }
  const resize = (d) => setSize(O.legsGcd(legs()) + d);
  function flipAll() {
    if (!legs().length) return;
    setLegs(O.flipSides(legs()), { undoLabel: "Sides flipped" });
  }
  /** From the chain (⇧B / ⇧S, the ticket) or the picker: the same contract and side merge into one leg. */
  function addLeg(leg) {
    const cur = legs();
    const isFut = leg.kind === "FUT";
    const exp = leg.expiry ?? st.expiry;
    const same = cur.find((l) => (isFut ? l.kind === "FUT" && l.symbol === leg.symbol : l.kind === "OPT" && l.strike === leg.strike && l.right === leg.right && l.expiry === exp) && l.side === leg.side && (l.entry === undefined || l.entry === null));
    if (!same && cur.length >= O.MAX_LEGS) return toast(`Up to ${O.MAX_LEGS} legs`, { tone: "warn" });
    mutate((ls) => {
      const s = ls.find((l) => l.id === same?.id);
      if (s) s.lots += leg.lots ?? 1;
      else ls.push({ kind: isFut ? "FUT" : "OPT", right: isFut ? null : leg.right, strike: isFut ? null : leg.strike, side: leg.side, lots: leg.lots ?? 1, symbol: leg.symbol ?? null, expiry: exp, lotSize: leg.lotSize ?? num(st.chain?.lotSize) });
    });
    const t = `${leg.side === "BUY" ? "Buy" : "Sell"} ${isFut ? `FUT ${expiryText(leg.expiry)}` : `${formatInt(leg.strike)} ${leg.right}`} added`;
    announce(t);
    return t;
  }
  function changed() {
    if (x) {
      syncChains();
      priced = price(x);
    }
    schedulePreviews();
    drawAll();
  }
  /** Step one leg's strike n listed steps (Alt: 5) on its own expiry's chain. */
  function stepLeg(id, n) {
    const l = legs().find((y) => y.id === id);
    if (!l || l.kind !== "OPT") return;
    let k = l.strike;
    for (let i = 0; i < Math.abs(n); i += 1) k = O.stepStrike(strikesOf(l.expiry), k, Math.sign(n)) ?? k;
    if (k === l.strike) return;
    mutateLeg(id, (y) => {
      y.strike = k;
      y.symbol = symOf(y);
      delete y.entry;
      delete y.entryTag;
    });
  }
  function setLegExpiry(id, e) {
    const cur = legs();
    const l = cur.find((y) => y.id === id);
    if (!l || l.expiry === e) return;
    const other = new Set(cur.filter((y) => y.id !== id && y.kind === "OPT" && y.expiry !== x?.c.expiry).map((y) => y.expiry));
    if (e !== x?.c.expiry) other.add(e);
    if (other.size > 3) return toast("Up to 3 later expiries in one strategy", { tone: "warn" });
    mutateLeg(id, (y) => {
      y.expiry = e;
      y.symbol = null;
      delete y.entry;
      delete y.entryTag;
    }, { undoLabel: `${O.legLabel(l)} to ${expiryText(e)}` });
  }

  // ── Legs list: rebuilt when its structure changes, patched on ticks ──
  /** Hold to repeat (every 120 ms after 400 ms); Alt jumps 5. Keyboard Enter / Space still step once. */
  function holdRepeat(btn, fn) {
    let t1 = 0;
    let t2 = 0;
    const stop = () => {
      clearTimeout(t1);
      clearInterval(t2);
      document.removeEventListener("pointerup", stop, true);
      document.removeEventListener("pointercancel", stop, true);
    };
    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || btn.disabled) return;
      e.preventDefault();
      const n = e.altKey ? 5 : 1;
      fn(n);
      t1 = setTimeout(() => (t2 = setInterval(() => fn(n), 120)), 400);
      document.addEventListener("pointerup", stop, true);
      document.addEventListener("pointercancel", stop, true);
    });
    btn.addEventListener("click", (e) => {
      if (e.detail === 0) fn(e.altKey ? 5 : 1);
    });
  }
  function legRow(l) {
    const name = O.legLabel(l);
    const off = l.on === false;
    const id = l.id;
    const isFut = l.kind === "FUT";
    const onBtn = h("button", { type: "button", class: `leg-on${off ? "" : " on"}`, role: "switch", "aria-checked": String(!off), "aria-label": `Include ${name}`, title: off ? "Switched off: not in the figures" : "Included", onclick: () => mutateLeg(id, (y) => { y.on = y.on === false; return true; }) }, h("i", { "aria-hidden": "true" }));
    const side = h("button", { type: "button", class: `side-tag ${l.side === "BUY" ? "buy" : "sell"}`, "aria-label": `${l.side === "BUY" ? "Buy" : "Sell"} ${name}: switch to ${l.side === "BUY" ? "sell" : "buy"}`, onclick: () => mutateLeg(id, (y) => ((y.side = y.side === "BUY" ? "SELL" : "BUY"), delete y.entry, delete y.entryTag)) }, l.side === "BUY" ? "B" : "S");
    const ks = strikesOf(l.expiry);
    let strike;
    if (isFut) strike = h("span", { class: "leg-strike fut" }, h("span", { class: "k" }, "FUT"));
    else {
      const dn = h("button", { type: "button", class: "step", "aria-label": `${name}: lower strike (Alt: 5)`, disabled: !x || O.stepStrike(ks, l.strike, -1) === null }, "‹");
      const up = h("button", { type: "button", class: "step", "aria-label": `${name}: higher strike (Alt: 5)`, disabled: !x || O.stepStrike(ks, l.strike, 1) === null }, "›");
      holdRepeat(dn, (n) => stepLeg(id, -n));
      holdRepeat(up, (n) => stepLeg(id, n));
      const k = h("button", { type: "button", class: "k", title: "Pick a strike", onclick: () => openPicker(l.strike) }, formatInt(l.strike));
      strike = h("span", { class: "leg-strike" }, dn, k, up);
    }
    const right = isFut
      ? h("span", { class: "leg-right fut" }, "FUT")
      : h("button", { type: "button", class: `leg-right ${l.right === "CE" ? "ce" : "pe"}`, "aria-label": `${name}: switch to ${l.right === "CE" ? "PE" : "CE"}`, onclick: () => mutateLeg(id, (y) => ((y.right = y.right === "CE" ? "PE" : "CE"), (y.symbol = null), delete y.entry, delete y.entryTag)) }, l.right);
    const expBtn = h("button", { type: "button", class: `leg-exp${l.expiry !== x?.c.expiry ? " other" : ""}`, "aria-haspopup": "dialog", "aria-label": `${name}: expiry ${expiryText(l.expiry)}`, disabled: isFut, onclick: () => openExpiryMenu(id, expBtn) }, expiryText(l.expiry));
    const lotsIn = h("input", { type: "number", min: "1", max: "10000", step: "1", inputmode: "numeric", class: "lots-in", value: String(l.lots), "aria-label": `Lots for ${name}`, title: `${formatInt(l.lots * (l.lotSize || x?.lot || 1))} qty` });
    lotsIn.addEventListener("change", () => {
      const v = Math.floor(Number(lotsIn.value));
      if (v >= 1 && v <= 10000) mutateLeg(id, (y) => (y.lots = v));
      else lotsIn.value = String(l.lots);
    });
    const lots = h(
      "span",
      { class: "leg-lots" },
      h("button", { type: "button", class: "step", "aria-label": `One lot fewer of ${name}`, disabled: l.lots <= 1, onclick: () => mutateLeg(id, (y) => (y.lots = Math.max(1, y.lots - 1))) }, "−"),
      lotsIn,
      h("button", { type: "button", class: "step", "aria-label": `One lot more of ${name}`, onclick: () => mutateLeg(id, (y) => (y.lots = Math.min(10000, y.lots + 1))) }, "+"),
    );
    const priceBtn = h("button", { type: "button", class: "leg-price num", title: "Click to set your own entry price" });
    priceBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      editPrice(id, priceBtn);
    });
    const more = h("button", { type: "button", class: "icon-btn leg-more", "aria-haspopup": "dialog", "aria-label": `More for ${name}: duplicate, roll, wing, remove` }, icon("more"));
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      openLegMenu(id, more);
    });
    const summary = h("span", { class: "leg-sum" }, h("strong", {}, isFut ? "FUT" : formatInt(l.strike)), isFut ? null : h("span", { class: `rt ${l.right === "CE" ? "ce" : "pe"}` }, l.right), h("span", { class: "ex" }, expiryText(l.expiry)));
    const row = h(
      "div",
      { class: `leg-row ${l.side === "BUY" ? "buy" : "sell"}${off ? " off" : ""}${openLegIds.has(id) ? " open" : ""}`, role: "listitem", "data-id": id, tabindex: "-1" },
      onBtn,
      side,
      summary,
      h("span", { class: "leg-lotsx num" }, `×${formatInt(l.lots)}`),
      strike,
      right,
      expBtn,
      lots,
      priceBtn,
      h("span", { class: "leg-iv num" }),
      h("span", { class: "leg-delta num" }),
      more,
    );
    row.addEventListener("pointerenter", () => setHi(id));
    row.addEventListener("pointerleave", () => setHi(null));
    row.addEventListener("focusin", () => (focusLegId = id));
    // Phone: a tap on the card opens its second row (‹ strike ›, CE / PE, lots, expiry).
    row.addEventListener("click", (e) => {
      if (!isPhone() || e.target.closest("button, input, label")) return;
      const open = !row.classList.contains("open");
      row.classList.toggle("open", open);
      if (open) openLegIds.add(id);
      else openLegIds.delete(id);
    });
    return row;
  }
  function setHi(id) {
    hiLeg = id;
    if (cfg().perLeg) chart.highlight(id);
  }
  function editPrice(id, btn) {
    const p = priced.find((y) => y.id === id);
    if (!p) return;
    const input = h("input", { type: "number", step: "0.05", min: "0.05", inputmode: "decimal", class: "price-in", value: isFigure(p.price) ? String(p.price) : "", "aria-label": `Entry price for ${p.label}` });
    btn.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const v = Number(input.value);
      if (commit && isFigure(input.value) && v > 0) {
        mutateLeg(id, (y) => {
          y.entry = O.roundToTick(v, 0.05);
          y.entryTag = "manual";
        });
      } else {
        legsSig = null;
        drawLegs();
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") {
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  }
  function drawLegs() {
    const ls = legs();
    const ks = x ? `${x.c.underlying}${x.c.rows.length}${x.c.rows[0]?.strike}` : "";
    const ce = [...chains.values()].map((c) => (c.chain ? 1 : 0)).join("");
    const sig = JSON.stringify([ls.map((l) => [l.id, l.kind, l.right, l.strike, l.side, l.lots, l.on, l.entry ?? null, l.expiry]), ks, ce, x?.c.expiry]);
    const empty = !ls.length;
    panel.classList.toggle("is-empty", empty);
    if (sig !== legsSig) {
      legsSig = sig;
      keepFocus(legsEl, () => {
        legsEl.replaceChildren(
          ...(ls.length ? [h("div", { class: "leg-row leg-head", "aria-hidden": "true" }, h("span", {}), h("span", {}), h("span", { class: "leg-strike" }, "Strike"), h("span", { class: "leg-right" }), h("span", { class: "leg-exp" }, "Expiry"), h("span", { class: "leg-lots" }, "Lots"), h("span", { class: "leg-price num" }, "Price"), h("span", { class: "leg-iv num" }, "IV"), h("span", { class: "leg-delta num" }, "Δ"), h("span", { class: "leg-more" }))] : []),
          ...ls.map((l) => legRow(l)),
        );
      });
      const lotsN = ls.reduce((a, l) => a + (l.on === false ? 0 : l.lots), 0);
      legCount.textContent = ls.length ? `${plural(ls.length, "leg")} · ${plural(lotsN, "lot")}` : "";
      const g = O.legsGcd(ls);
      if (document.activeElement !== sizeIn) sizeIn.value = String(g);
      sizeDn.disabled = !ls.length || g <= 1;
      sizeUp.disabled = sizeIn.disabled = !ls.length;
      shiftDn.disabled = shiftUp.disabled = !ls.some((l) => l.kind === "OPT") || !x;
      addBtn.disabled = ls.length >= O.MAX_LEGS || !x;
      requestAnimationFrame(syncStick);
    }
    // Patch prices (flash on a tick), IV and Δ.
    for (const p of priced) {
      const row = legsEl.querySelector(`.leg-row[data-id="${CSS.escape(p.id)}"]`);
      if (!row) continue;
      const pc = row.querySelector(".leg-price");
      if (pc) {
        const tag = p.manual ? "✎" : isFigure(p.entry) ? p.entryTag ?? "avg" : p.fallback ? "LTP" : null;
        const prev = num(pc.__p);
        setCell(pc, `${formatFixed(p.price, 2)}|${tag}|${p.loading}|${p.expired}|${p.chainError}|${formatFixed(p.iv, 1)}`, () => [p.price === null ? (p.expired || p.chainError ? h("span", { class: "px-dead" }, p.expired ? "Expired" : "No chain") : h("span", { class: p.loading ? "px-load" : "px-none" }, DASH)) : formatFixed(p.price, 2), tag ? h("small", { class: `ptag${p.manual ? " manual" : ""}` }, tag) : null, p.kind === "OPT" ? h("small", { class: "pt-iv" }, `IV ${formatFixed(p.iv, 1)}`) : null], p.price === null ? (p.expired ? `${p.label} ${expiryText(p.expiry)} has expired: roll or remove it` : p.chainError ? `The ${expiryText(p.expiry)} chain did not load` : p.loading ? `Loading the ${expiryText(p.expiry)} chain` : `${p.label} has no price`) : p.manual ? `Your entry price; live ${formatFixed(p.livePrice, 2)}` : "Click to set your own entry price");
        pc.classList.toggle("manual", p.manual);
        if (prev !== null && isFigure(p.price) && p.price !== prev && !p.manual) inkFlash(pc, p.price > prev ? 1 : -1);
        pc.__p = p.price;
      }
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
    else if (title === null) td.removeAttribute("title");
  }

  /**
   * The build column sticks at the top while it fits the screen; a taller one scrolls until its bottom reaches the
   * screen's bottom and sticks there, so the left column never runs out while the table scrolls on the right.
   */
  function syncStick() {
    const tall = build.offsetHeight > innerHeight - 24;
    build.classList.toggle("no-stick", tall);
    build.style.top = tall ? `${Math.round(innerHeight - build.offsetHeight - 12)}px` : "";
  }
  addEventListener("resize", syncStick);
  const buildRo = typeof ResizeObserver === "function" ? new ResizeObserver(() => syncStick()) : null;
  buildRo?.observe(build);

  // ── Presets: chips (with legs), cards (empty draft, and the phone sheet) ──
  function presetItems(g) {
    const f = fut();
    const opts = { ...presetOpts(), fut: f ? { symbol: f.symbol, expiry: f.expiry, lotSize: f.lotSize } : { symbol: "FUT", expiry: null } };
    return O.PRESETS.filter((p) => p.group === g).map((p) => {
      const pl = O.presetLegs(p.id, x.c, opts).map((l) => {
        const q = l.kind === "FUT" ? st.quotes.get(f?.symbol ?? "") : x.c.rows.find((r) => r.strike === l.strike)?.[l.right === "CE" ? "ce" : "pe"];
        return { ...l, price: O.mid(q) ?? (l.kind === "FUT" ? x.F : 0), basis0: 0, years: l.expiry && l.expiry !== x.c.expiry ? O.yearsToExpiry(l.expiry, Date.now(), refSession(st.ref).close) : x.years, iv: num(q?.iv) ?? x.sm.atmIv };
      });
      const gl = pl.length ? (p.multi ? glyphOfCurve(pl) : O.presetGlyph(pl, x.lot)) : null;
      const netP = O.netPremium(pl, x.lot);
      const disabled = (p.needsFut && !f) || !pl.length;
      return { p, gl, netP, disabled, title: disabled ? (p.multi ? "No later expiry is listed" : `No future found for ${st.underlying}.`) : `${p.hint} · ${netP >= 0 ? "credit" : "debit"} ${money(Math.abs(netP), { signed: false })} · ${p.risk === "defined" ? "Defined" : "Undefined"} risk` };
    });
  }
  /** A calendar's glyph: its first-expiry curve sampled (it is not piecewise linear). */
  function glyphOfCurve(pl) {
    const ks = pl.map((l) => l.strike).sort((a, b) => a - b);
    const pad = Math.max((ks[ks.length - 1] - ks[0]) * 0.6, ks[0] * 0.02);
    const T1 = Math.min(...pl.map((l) => l.years ?? 0));
    const f = O.strategyPayoff(pl, x.lot, { years: T1 });
    const xs = Array.from({ length: 8 }, (_, i) => ks[0] - pad + ((ks[ks.length - 1] - ks[0] + 2 * pad) * i) / 7);
    const ys = xs.map(f);
    const lo = Math.min(0, ...ys);
    const hi = Math.max(0, ...ys);
    const sp = hi - lo || 1;
    const Y = (v) => Math.round((1 + ((hi - v) / sp) * 14) * 10) / 10;
    return { points: xs.map((xx, i) => [Math.round((i / 7) * 320) / 10, Y(ys[i])]), zero: Y(0) };
  }
  function presetCard(it, onPick) {
    const b = h(
      "button",
      { type: "button", class: "preset-card", "data-preset": it.p.id, disabled: it.disabled, title: it.title },
      h("span", { class: "pc-glyph" }, it.gl ? glyphSvg(it.gl, { w: 64, hgt: 28 }) : null),
      h("span", { class: "pc-text" }, h("strong", {}, it.p.name), h("small", {}, it.p.hint)),
      h("span", { class: `pc-risk ${it.p.risk}` }, it.p.risk === "defined" ? "Defined" : "Undefined risk"),
    );
    b.addEventListener("click", () => onPick(it.p));
    return b;
  }
  function drawChips() {
    if (!x) return;
    const g = cfg().group;
    const empty = !legs().length;
    const sig = `${g}|${x.c.underlying}|${x.c.expiry}|${x.sm.atm}|${fut()?.symbol ?? ""}|${empty}|${(st.expiries ?? []).length}`;
    if (sig !== chipsSig) {
      chipsSig = sig;
      const items = presetItems(g);
      chips.className = empty ? "preset-cards" : "preset-chips";
      chips.replaceChildren(
        ...items.map((it) => {
          if (empty) return presetCard(it, applyPreset);
          const b = h("button", { type: "button", class: "preset-chip", "data-preset": it.p.id, "aria-pressed": "false", disabled: it.disabled, title: it.title }, it.gl ? h("span", { class: "glyph", "aria-hidden": "true" }, glyphSvg(it.gl)) : null, h("span", {}, it.p.name));
          b.addEventListener("click", () => applyPreset(it.p));
          return b;
        }),
      );
    }
    // Active state: the draft equals the preset's legs.
    const cur = legs();
    const opts = presetOpts();
    for (const b of chips.querySelectorAll("[data-preset]")) {
      const on = O.legsMatch(cur, O.presetLegs(b.dataset.preset, x.c, opts));
      if (b.classList.contains("on") !== on) {
        b.classList.toggle("on", on);
        if (b.hasAttribute("aria-pressed")) b.setAttribute("aria-pressed", String(on));
      }
    }
  }
  const activePreset = () => (x ? O.PRESETS.find((p) => O.legsMatch(legs(), O.presetLegs(p.id, x.c, presetOpts()))) ?? null : null);
  /** Phone (and on demand): the preset gallery in a bottom sheet. */
  function openPresetSheet(trigger) {
    if (!x) return;
    const seg = segmented("Preset group", O.PRESET_GROUPS, cfg().group);
    seg.classList.add("group-seg");
    const gridEl = h("div", { class: "preset-cards sheet-cards" });
    let handle = null;
    const fill = () => gridEl.replaceChildren(...presetItems(seg.value).map((it) => presetCard(it, (p) => (handle?.close(), applyPreset(p)))));
    seg.addEventListener("change", () => {
      setCfg({ group: seg.value });
      fill();
    });
    fill();
    handle = sheetPopover({ trigger, title: "Strategies", body: h("div", { class: "preset-sheet" }, h("div", { class: "hscroll" }, seg), gridEl), cls: "preset-pop" });
  }

  // ── Hero strip ──
  const nodeText = (v) => (v instanceof Node ? `${v.textContent}|${v.className ?? ""}` : String(v ?? ""));
  function setHero(c, value, sub, { cls = "", title = null, flash = 0 } = {}) {
    const sig = `${nodeText(value)}|${nodeText(sub)}|${cls}`;
    if (c.__sig === sig) return;
    const was = c.__sig;
    c.__sig = sig;
    c.v.replaceChildren(value ?? DASH);
    c.v.className = `hero-v ${cls}`.trim();
    c.s.replaceChildren(sub ?? "");
    if (title) c.el.title = title;
    else c.el.removeAttribute("title");
    if (was && !animateNext && flash) inkFlash(c.v, flash);
    else if (was && !reducedMotion()) {
      c.v.classList.remove("xfade");
      void c.v.offsetWidth;
      c.v.classList.add("xfade");
    }
  }
  /** "at 25957–26893", "above 26000", "below 25800 / above 27050" from the intervals at a level. */
  function intervalText(xs, vals, level, dir) {
    const test = dir > 0 ? (v) => v >= level : (v) => v <= level;
    test.level = level;
    const iv = O.intervalsWhere(xs, vals, test);
    const part = ([a, b]) => (a <= 0 && b === Infinity ? "everywhere" : a <= 0 || a <= xs[0] ? `below ${formatInt(b)}` : b === Infinity || b >= xs[xs.length - 1] ? `above ${formatInt(a)}` : Math.abs(b - a) < 1 ? `at ${formatInt(a)}` : `${formatInt(a)}–${formatInt(b)}`);
    const t = iv.slice(0, 2).map(part).join(" / ");
    return t;
  }
  function drawHero() {
    const r = R;
    const loading = !r;
    const q = (t) => h("span", { class: "quiet" }, t);
    if (loading || !r.ok) {
      const why = !r ? (noChain ? "" : "loading") : r.act.length ? `${plural(r.missing.length, "leg needs", "legs need")} a price` : "";
      for (const k of HERO) setHero(hero[k], q(DASH), k === "net" ? why : "");
      hero.maxProfit.l.textContent = "Max profit";
      ringArc.setAttribute("stroke-dashoffset", "69.12");
      return;
    }
    const s = r.stats;
    const lotsN = r.act.reduce((a, l) => a + l.lots, 0);
    const n = s.net;
    const afterCh = r.ch ? n - r.ch.total : null;
    // Figures never break inside: each sits in a nowrap span; the sub may wrap between parts ("after charges" and its
    // figure are two parts, so a narrow Net column wraps before the amount instead of running past its divider).
    const nw = (t) => h("span", { class: "nw" }, t);
    const netSub = h("span", {}, nw(plural(lotsN, "lot")), afterCh !== null && cfg().net ? [" ", nw(`· ${isPhone() ? "net" : "after charges"}`), " ", nw(rupees(afterCh))] : null);
    setHero(hero.net, `${n > 0.5 ? "Credit" : n < -0.5 ? "Debit" : "Even"} ${rupees(Math.abs(n))}`, netSub, { cls: "neutral" });
    const m = r.model;
    const sfx = s.approx ? " · sampled" : "";
    if (s.locked !== null && s.locked !== undefined) {
      hero.maxProfit.l.textContent = "Locked P&L";
      setHero(hero.maxProfit, rupees(s.locked, true), `Implied ${isFigure(r.ratios.implied) ? formatPercent(r.ratios.implied * 100, 1) : DASH}/yr`, { cls: s.locked > 0 ? "up" : "down", title: "Riskless at expiry if every leg fills at these prices" });
    } else {
      hero.maxProfit.l.textContent = "Max profit";
      setHero(hero.maxProfit, s.maxProfit === null ? "Unlimited ↗" : nw(rupees(s.maxProfit, true)), s.maxProfit === null ? "above the top strike" : `${intervalText(m.xs, m.expiry, s.maxProfit - Math.max(1, Math.abs(s.maxProfit) * 0.005), 1)}${sfx}`, { cls: s.maxProfit === null || s.maxProfit > 0 ? "up" : "down", flash: 1 });
    }
    setHero(
      hero.maxLoss,
      s.maxLoss === null ? "Unlimited ↘" : nw(rupees(s.maxLoss, true)),
      s.maxLoss === null ? (s.stress ? `${rupees(s.stress.value, true)} at +2σ (${formatInt(s.stress.price)})` : "above the top strike") : `${intervalText(m.xs, m.expiry, s.maxLoss + Math.max(1, Math.abs(s.maxLoss) * 0.005), -1) || "far from the strikes"}${sfx}`,
      { cls: s.maxLoss === null || s.maxLoss < 0 ? "down" : "up", flash: -1 },
    );
    const pop = s.pop;
    setHero(hero.pop, isFigure(pop) ? formatPercent(pop * 100, 0) : DASH, `at expiry · IV model${sfx}`, { title: "Model probability · uncalibrated: the chance the strategy finishes in profit, from a log-normal model at ATM IV (plus the IV shift) on the vol-time clock. Calibration: not yet measured" });
    const off = isFigure(pop) ? 69.12 * (1 - pop) : 69.12;
    ringArc.setAttribute("stroke-dashoffset", String(Math.round(off * 100) / 100));
    ringArc.classList.toggle("warn", isFigure(pop) && pop < 0.5);
    const bes = s.breakevens;
    hero.breakevens.l.textContent = bes.length > 1 ? "Breakevens" : "Breakeven";
    if (!bes.length) setHero(hero.breakevens, "None", s.maxLoss !== null && s.maxLoss >= 0 ? "never a loss" : "never a profit");
    else {
      const show = bes.slice(0, 3);
      const pct = (b) => `${formatSigned(x.spot ? ((b - x.spot) / x.spot) * 100 : null, 1)}%`;
      setHero(hero.breakevens, h("span", { class: `be-list${show.length > 1 ? " many" : ""}` }, show.map((b) => h("span", { class: "be-v" }, formatInt(b))), bes.length > 3 ? h("span", { class: "be-v quiet" }, `+${bes.length - 3}`) : null), h("span", { class: "be-list" }, show.map((b) => h("span", { class: "be-v" }, pct(b)))));
    }
  }

  // ── Warnings: one line, severity dot + first + "+N more" ──
  let warnOpen = false;
  /** True while the account's margin preview for the current legs has not answered yet. */
  const previewPending = () => Boolean(account()) && pv.sig !== sigOf(priced.filter((l) => l.on !== false && l.symbol && isFigure(l.price)));
  function drawWarnings() {
    const w = R?.warnings ?? [];
    const sig = JSON.stringify([w.map((x2) => x2.text), warnOpen]);
    if (warnEl.__sig === sig) return;
    // Keep the last line while the margin preview is in flight: the estimate-only list in between would collapse the
    // row for ~400 ms and bounce the chart in the middle of its morph.
    if (R?.ok && warnEl.__sig && !warnEl.hidden && previewPending()) return;
    warnEl.__sig = sig;
    warnEl.hidden = !w.length;
    const fix = (x2) =>
      x2.code === "EXPIRED_LEG" && x2.legId
        ? h(
            "span",
            { class: "warn-acts" },
            x && legs().some((l) => l.id === x2.legId && l.expiry !== x.c.expiry) ? h("button", { type: "button", class: "small plain", onclick: () => setLegExpiry(x2.legId, x.c.expiry) }, `Roll to ${expiryText(x.c.expiry)}`) : null,
            h("button", { type: "button", class: "small plain", onclick: () => mutate((ls) => ls.splice(ls.findIndex((y) => y.id === x2.legId), 1), { undoLabel: "Leg removed" }) }, "Remove"),
          )
        : null;
    const li = (x2) => h("li", { class: x2.severity === "block" ? "bad" : x2.severity === "warn" ? "warn" : "info" }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", {}, x2.text), fix(x2));
    warnEl.replaceChildren(
      ...[
        h("ul", { class: "warn-line" }, li(w[0] ?? { severity: "info", text: "" }), w.length > 1 ? h("li", { class: "more" }, h("button", { type: "button", class: "small plain", "aria-expanded": String(warnOpen), onclick: () => ((warnOpen = !warnOpen), drawWarnings()) }, warnOpen ? "Fewer" : `+${formatInt(w.length - 1)} more`, icon("down"))) : null),
        warnOpen && w.length > 1 ? h("ul", { class: "warn-rest" }, w.slice(1).map(li)) : null,
      ].filter(Boolean),
    );
  }

  // ── What-if ──
  function drawWhatIf() {
    whatIf.hidden = !R?.ok;
    note.hidden = !R?.ok;
    if (!R) {
      tSlider.disabled = ivSlider.disabled = true;
      wiChipT.disabled = wiChipIv.disabled = true;
      return;
    }
    const now = Date.now();
    const mins = Math.max(0, Math.ceil((R.expMs - now) / 60000 / 15) * 15);
    tSlider.disabled = mins <= 0;
    ivSlider.disabled = false;
    wiChipT.disabled = wiChipIv.disabled = false;
    if (tSlider.max !== String(mins)) tSlider.max = String(mins);
    // At expiry by time, not by slider value: the slider's max is rounded up to 15 minutes, the target is not.
    const atExpiry = wi.target !== null && mins > 0 && R.targetMs >= R.expMs - 60000;
    const v = wi.target === null ? 0 : atExpiry || R.expMs - wi.target <= 15 * 60000 ? mins : Math.min(mins, Math.round((wi.target - now) / 60000));
    if (document.activeElement !== tSlider || !dragging.t) tSlider.value = String(v);
    tSlider.style.setProperty("--fill", `${mins ? (Number(tSlider.value) / mins) * 100 : 0}%`);
    ivSlider.style.setProperty("--fill", `${((Number(ivSlider.value) + 10) / 20) * 100}%`);
    const left = R.expMs - R.targetMs;
    const txt = atExpiry ? "At expiry" : R.el <= 0 ? `Now · ${span(R.expMs - now)} left` : `T+${span(R.targetMs - now)} · ${when(R.targetMs)}`;
    tLabel.textContent = txt;
    tLabel.title = atExpiry || R.el <= 0 ? "" : `${span(left)} left to expiry`;
    tSlider.setAttribute("aria-valuetext", atExpiry || R.el <= 0 ? txt : `${txt} · ${span(left)} left`);
    const ivTxt = `${formatSigned(wi.ivShift, 1)} pts · ATM ${formatPercent(R.ivNow, 1)}`;
    ivLabel.textContent = ivTxt;
    ivSlider.setAttribute("aria-valuetext", ivTxt);
    if (document.activeElement !== ivSlider) ivSlider.value = String(wi.ivShift);
    wiChipT.textContent = `Target: ${atExpiry ? "Expiry" : R.el <= 0 ? "Now" : `T+${span(R.targetMs - now)}`} ▾`;
    wiChipIv.textContent = `IV ${formatSigned(wi.ivShift, 1)} ▾`;
    wiChipT.setAttribute("aria-pressed", String(wi.target !== null));
    wiChipIv.setAttribute("aria-pressed", String(wi.ivShift !== 0));
    resetWi.hidden = wi.target === null && wi.ivShift === 0;
    note.textContent = R.ok
      ? `Theoretical · Black-76 on forward ${formatInt(Math.round(x.F ?? 0))} · leg IVs ${formatSigned(wi.ivShift, 1)} pts · r 0 · to ${refSession(st.ref).close} IST${R.multi ? " · later legs keep their time value at the first expiry" : ""}${R.net ? ` · net of charges (rates ${refCharges(st.ref).asOf})` : ""}`
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
  /** Phone: the sliders in a bottom sheet with quick targets (Now, +1d, +2d, Mid, Expiry − 1h) and Reset. */
  function openWhatIfSheet(trigger) {
    if (!R) return;
    const home = whatIf;
    const now = Date.now();
    const setT = (ms) => {
      wi.target = ms;
      save();
      drawAnalysis();
    };
    const quick = h(
      "div",
      { class: "wi-quick" },
      [["Now", null], ["+1d", now + DAY_MS], ["+2d", now + 2 * DAY_MS], ["Mid", now + (R.expMs - now) / 2], ["Expiry − 1h", R.expMs - 3600000]]
        .filter(([, ms]) => ms === null || (ms > now && ms <= R.expMs))
        .map(([t, ms]) => h("button", { type: "button", class: "small chip-btn", onclick: () => setT(ms) }, t)),
    );
    const resetB = h("button", { type: "button", class: "small plain wi-sheet-reset", onclick: () => ((wi.target = null), (wi.ivShift = 0), (ivSlider.value = "0"), save(), drawAnalysis()) }, "Reset");
    const bodyEl = h("div", { class: "wi-sheet" }, wiT, quick, wiIv, resetB);
    sheetPopover({
      trigger,
      title: "What if",
      body: bodyEl,
      onClose: () => {
        home.prepend(wiT, wiIv);
      },
    });
  }

  // ── Risk & capital ──
  function spark(vals, iSpot) {
    const w = 40;
    const hh = 12;
    const fin = vals.filter(isFigure);
    if (fin.length < 2) return null;
    const lo = Math.min(...fin);
    const hi = Math.max(...fin);
    const sp = hi - lo || 1;
    const X = (i) => Math.round((i / (vals.length - 1)) * w * 10) / 10;
    const Y = (v) => Math.round((1 + ((hi - v) / sp) * (hh - 2)) * 10) / 10;
    return sv(
      "svg",
      { viewBox: `0 0 ${w} ${hh}`, width: w, height: hh, class: "spark", "aria-hidden": "true" },
      lo < 0 && hi > 0 ? sv("line", { x1: 0, x2: w, y1: Y(0), y2: Y(0), class: "sp-zero" }) : null,
      sv("polyline", { points: vals.map((v, i) => (isFigure(v) ? `${X(i)},${Y(v)}` : "")).filter(Boolean).join(" "), class: "sp-line" }),
      iSpot >= 0 && isFigure(vals[iSpot]) ? sv("circle", { cx: X(iSpot), cy: Y(vals[iSpot]), r: 1.8, class: "sp-dot" }) : null,
    );
  }
  function greekRows() {
    if (!R?.ok || !x) return null;
    const lv = levels();
    return lv.map((r) => ({ ...r, g: O.netGreeksModel(R.act, r.price, { lotSize: R.lot, basis: R.basis, el: R.el, ivShift: R.shift }) }));
  }
  /** Price rows for the tables: an even grid over the wings, breakevens and ±1σ (never only the plateau). */
  function levels() {
    const rows = isPhone() || media("(min-width: 1024px) and (max-width: 1279px)") ? 9 : 13;
    const b1 = R?.b1;
    return O.coverLevels({ strikes: allStrikes(), legStrikes: (R?.act ?? legs()).filter((l) => l.kind === "OPT").map((l) => l.strike), breakevens: R?.stats?.breakevens ?? [], spot: x.spot, band: b1 ? [b1.lo, b1.hi] : null, rows });
  }
  let chargesPop = null;
  function drawRisk() {
    const open = cfg().riskOpen || media("(min-width: 1024px)");
    riskEl.classList.toggle("closed", !open);
    riskToggle.setAttribute("aria-expanded", String(open));
    const r = R;
    const sum = riskToggle.querySelector(".sec-sum");
    if (!r?.ok) {
      riskEl.hidden = !legs().length;
      sum.textContent = "";
      for (const f of [romF, rrF, evF, popF, pMaxF, touchF]) setFig(f, DASH);
      setText(chargesB, `Charges ${DASH}`);
      return;
    }
    riskEl.hidden = false;
    // Margin vs funds: the bar is neutral (margin is not a loss); the part beyond free funds is amber.
    const req = r.exit ? null : r.margin;
    const free = funds.free;
    const total = Math.max(isFigure(req) ? req : 0, isFigure(free) ? free : 0) || 1;
    const fill = mBar.children[0];
    const short = mBar.children[1];
    const tick = mBar.children[2];
    const within = isFigure(req) ? Math.min(req, isFigure(free) ? free : req) : 0;
    fill.style.width = `${(within / total) * 100}%`;
    short.style.left = `${(within / total) * 100}%`;
    short.style.width = `${isFigure(req) && isFigure(free) && req > free ? ((req - free) / total) * 100 : 0}%`;
    tick.hidden = !isFigure(free);
    tick.style.left = `${isFigure(free) ? Math.min(100, (free / total) * 100) : 0}%`;
    const acctFig = r.acct !== null && r.acct !== undefined;
    mLeft.replaceChildren(h("span", { class: "mb-k" }, "Margin "), h("strong", {}, r.exit ? "released" : isFigure(req) ? `${acctFig ? "" : "≈ "}${rupees(req)}` : pv.loading ? "…" : DASH));
    mRight.replaceChildren(...(isFigure(free) ? [h("span", { class: "mb-k" }, "Free "), h("strong", {}, rupees(free))] : [h("span", { class: "mb-k" }, account() ? "Funds unavailable" : "No account")]));
    const est = r.est?.required;
    const sh = isFigure(req) && isFigure(free) && req > free ? req - free : null;
    const pp = pv.sig === sigOf(r.act) ? pv.paper : null;
    // The hedge benefit: what the same legs would block one by one, against the portfolio figure.
    const naked = pp ? pp.standalone : r.est?.standalone;
    const alone = pp ? pp.alone : est;
    const saves = isFigure(naked) && isFigure(alone) && naked - alone > 1 ? naked - alone : null;
    const tip = `${SPAN_METHOD} Each leg on its own would need ${isFigure(naked) ? rupees(naked) : DASH}.${pp && pp.change < pp.alone - 1 ? ` With what this paper account already holds, it adds ${rupees(Math.max(0, pp.change))}.` : ""}`;
    const what = r.exit ? "Closing these legs releases margin" : pp ? "Paper figure · hedges credited" : acctFig ? `Account figure${isFigure(est) && Math.abs(est - req) > 1 ? ` · portfolio ≈ ${rupees(est)}` : ""}` : "Portfolio estimate · SPAN-like + exposure";
    mSub.replaceChildren(
      ...[
        h("span", { title: tip }, what, " ⓘ"),
        !r.exit && saves ? h("span", { class: "mb-save-t", title: tip }, `Hedge saves ${rupees(saves)}`) : null,
        sh ? h("span", { class: "mb-short-t" }, `Short by ${rupees(sh)}`) : null,
      ].filter(Boolean),
    );
    // Greeks 4-up with sparklines across the table's prices.
    const gr = greekRows();
    const iSpot = gr ? gr.findIndex((q) => q.kind === "spot") : -1;
    const g = r.greeks;
    const setG = (c, val, sub, cls, series) => {
      c.value.textContent = val;
      c.value.className = `gk-v ${cls ?? ""}`.trim();
      c.sub.textContent = sub;
      const sig = series ? series.map((v) => (isFigure(v) ? Math.round(v * 1000) : "")).join() : "";
      if (c.spark.__sig !== sig) {
        c.spark.__sig = sig;
        c.spark.replaceChildren(...[series ? spark(series, iSpot) : null].filter(Boolean));
      }
    };
    const lot = r.lot;
    setG(gks.delta, isFigure(g?.delta) ? `${formatSigned(g.delta / lot, 2)} lot` : DASH, isFigure(g?.delta) ? `${money(g.delta)}/pt` : "", "", gr?.map((q) => (q.g ? q.g.delta / lot : null)));
    setG(gks.gamma, isFigure(g?.gamma) && x.F ? `${formatSigned((g.gamma * x.F * 0.01) / lot, 2)}` : DASH, "Δ lots per 1%", "", gr?.map((q) => (q.g ? q.g.gamma : null)));
    setG(gks.theta, isFigure(g?.theta) ? money(g.theta) : DASH, "per trading day", g?.theta > 0.5 ? "up" : g?.theta < -0.5 ? "down" : "", gr?.map((q) => (q.g ? q.g.theta : null)));
    // Θ is per trading-day unit of the vol-time clock: say how many units the next session takes (1.3 over a weekend).
    const nsu = nextSessionUnits();
    gks.theta.b.title = `Θ per trading day (one unit of the vol-time clock).${isFigure(nsu) && Math.abs(nsu - 1) > 0.05 ? ` Next session decays ${formatFixed(nsu, 1)} trading days (weekend and holiday days count at their weight).` : ""} Greeks across price: open the Greeks table`;
    setG(gks.vega, isFigure(g?.vega) ? money(g.vega) : DASH, "per vol pt", g?.vega > 0.5 ? "up" : g?.vega < -0.5 ? "down" : "", gr?.map((q) => (q.g ? q.g.vega : null)));
    // Return and probability lines.
    const rr = r.ratios.rr;
    setFig(romF, isFigure(r.ratios.rom) ? formatPercent(r.ratios.rom * 100, 1) : DASH);
    setFig(rrF, isFigure(rr) && rr > 0 ? `1 : ${formatFixed(1 / rr, 1)}` : DASH);
    setFig(evF, money(r.ev), r.ev > 0.5 ? "up" : r.ev < -0.5 ? "down" : "");
    setText(chargesB, `Charges ${r.ch ? rupees(r.ch.total) : DASH}`);
    setFig(popF, isFigure(r.stats?.pop) ? formatPercent(r.stats.pop * 100, 0) : DASH);
    // No maximum to land on when the profit is unlimited.
    setFig(pMaxF, r.stats?.maxProfit === null ? "Unlimited" : isFigure(r.pMax) ? formatPercent(r.pMax * 100, 0) : DASH);
    touchF.el.hidden = r.beNear === null;
    setText(touchF.label, r.beNear !== null ? `P(touch ${formatInt(r.beNear)}) ` : "P(touch) ");
    setFig(touchF, isFigure(r.pTouch) ? formatPercent(r.pTouch * 100, 0) : DASH);
    sum.textContent = isFigure(req) ? `${acctFig ? "" : "≈ "}${rupees(req)}${sh ? " · short" : ""}` : "";
  }
  function openCharges(trigger) {
    if (!R?.ch) return;
    const c = R.ch;
    const rows = [["Brokerage", c.brokerage], ["STT", c.stt], ["Exchange", c.txn], ["GST", c.gst], ["Stamp", c.stamp], ["SEBI", c.sebi]];
    const exitAt = x.spot !== null ? O.exitCharges(R.act, x.spot, refCharges(st.ref), { lotSize: R.lot }) : null;
    chargesPop = sheetPopover({
      trigger,
      title: "Charges to enter",
      within: build,
      body: h(
        "div",
        { class: "charges-pop" },
        h("table", { class: "keys-table charges-t" }, h("tbody", {}, rows.map(([k, v]) => h("tr", {}, h("th", { scope: "row" }, k), h("td", { class: "num" }, formatFixed(v, 2)))), h("tr", { class: "total" }, h("th", { scope: "row" }, "Total"), h("td", { class: "num" }, formatFixed(c.total, 2))))),
        h("p", { class: "muted small" }, `${isFigure(exitAt) ? `Exit at spot ≈ ${rupees(exitAt)}. ` : ""}Rates as of ${refCharges(st.ref).asOf}: verify with your broker.`),
      ),
    });
  }

  // ── More figures (the user's extra metrics, one quiet row) ──
  function extraFig(k) {
    const r = R;
    if (!r?.ok) return null;
    switch (k) {
      case "margin":
        return ["Margin", isFigure(r.margin) ? `${r.acct === null ? "≈ " : ""}${rupees(r.margin)}` : DASH, ""];
      case "atTarget":
        return [r.el > 0 ? "At target" : "Now", money(r.atTarget), r.atTarget > 0.5 ? "up" : r.atTarget < -0.5 ? "down" : ""];
      case "rom":
        return ["ROM", isFigure(r.ratios.rom) ? formatPercent(r.ratios.rom * 100, 1) : DASH, ""];
      case "rr":
        return ["Reward / risk", isFigure(r.ratios.rr) ? formatFixed(r.ratios.rr, 2) : DASH, ""];
      case "delta":
        return ["Net Δ", isFigure(r.greeks?.delta) ? `${formatSigned(r.greeks.delta / r.lot, 2)} lot` : DASH, ""];
      case "gamma":
        return ["Gamma", isFigure(r.greeks?.gamma) && x.F ? formatSigned((r.greeks.gamma * x.F * 0.01) / r.lot, 2) : DASH, ""];
      case "theta":
        return ["Theta", money(r.greeks?.theta), r.greeks?.theta > 0.5 ? "up" : r.greeks?.theta < -0.5 ? "down" : ""];
      case "vega":
        return ["Vega", money(r.greeks?.vega), ""];
      case "ev":
        return ["EV at IV", money(r.ev), r.ev > 0.5 ? "up" : r.ev < -0.5 ? "down" : ""];
      case "charges":
        return ["Charges", r.ch ? rupees(r.ch.total) : DASH, ""];
      default:
        return null;
    }
  }
  function drawMore() {
    const ks = cfg().metrics.filter((k) => !HERO.includes(k));
    const items = ks.map(extraFig).filter(Boolean);
    const sig = JSON.stringify(items);
    if (moreRow.__sig === sig) return;
    moreRow.__sig = sig;
    moreRow.hidden = !items.length;
    moreRow.replaceChildren(...items.map(([l, v, c]) => h("span", { class: "mf" }, h("span", { class: "mf-k" }, l), h("b", { class: c || undefined }, v))), h("button", { type: "button", class: "link-btn mf-edit", onclick: () => openCustomise() }, "Customise"));
  }

  // ── P&L table: by spot, price × date grid, greeks across price ──
  function drawTable() {
    const phone = isPhone();
    const tab = phone ? "spot" : cfg().table;
    if (tabSeg.value !== tab) tabSeg.value = tab;
    modeSeg.hidden = tab !== "spot";
    if (modeSeg.value !== cfg().scenario) modeSeg.value = cfg().scenario;
    tableEl.dataset.tab = tab;
    if (!R?.ok) {
      tableEl.hidden = !legs().length;
      tableNote.textContent = "";
      tableBody.replaceChildren(h("p", { class: "muted tbl-empty" }, R ? (R.act.length ? "Figures need every leg priced." : "Switch a leg on to see P&L by price.") : noChain ? DASH : "…"));
      tableBody.__sig = "";
      return;
    }
    tableEl.hidden = false;
    if (tab === "grid") return drawGrid();
    if (tab === "greeks") return drawGreeksTab();
    drawBySpot();
  }
  function rowLevels() {
    const mode = cfg().scenario;
    if (mode === "strikes") return levels();
    return O.scenarioLevels(mode, { spot: x.spot, forward: x.F, ivPct: R.ivNow, years: R.T }).map((l) => ({ price: l.price, kind: l.k === 0 ? "spot" : "strike" }));
  }
  function drawBySpot() {
    const lv = rowLevels();
    const f = O.strategyPayoff(R.act, R.lot, { years: R.T, ivShift: R.shift, charges: R.net });
    const showT = R.T > 0 && R.el < R.T - 1e-7;
    const rows = lv.map((lvl) => {
      const vt = O.valueAt(R.act, lvl.price, R.lot, null, R.basis, { el: R.el, ivShift: R.shift });
      return { ...lvl, target: vt === null ? null : vt - (R.net?.entry ?? 0), expiry: f(lvl.price), z: O.sigmaZ(lvl.price, x.F, R.ivNow, R.T) };
    });
    const maxAbs = Math.max(1, ...rows.map((rw) => Math.abs(rw.expiry)));
    tableNote.textContent = `${showT ? (R.el > 0 ? `Target ${when(R.targetMs)}` : "Target: now") : "At expiry"}${R.net ? " · net of charges" : ""}`;
    const sig = `spot|${rows.length}|${rows.map((r) => r.kind).join("")}|${showT}`;
    if (tableBody.__sig !== sig) {
      tableBody.__sig = sig;
      const th = (t, cls = "num") => h("th", { scope: "col", class: cls }, t);
      tableBody.replaceChildren(
        h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            { class: "desk-table pnl-table" },
            h("caption", { class: "sr-only" }, "P&L by spot price at the target date and at expiry"),
            h("thead", {}, h("tr", {}, th("Price"), th("Move", "num c-move"), th("σ", "num c-sig"), th(showT ? "Target" : "Now"), th("Expiry"), th("", "c-bar"))),
            h("tbody", {}, rows.map(() => h("tr", {}, h("td", { class: "num c-price" }), h("td", { class: "num c-move" }), h("td", { class: "num c-sig" }), h("td", { class: "num c-t" }), h("td", { class: "num c-e" }), h("td", { class: "c-bar" }, h("span", { class: "ebar" }, h("i", { class: "neg" }), h("i", { class: "pos" })))))),
          ),
        ),
      );
    }
    const trs = tableBody.querySelectorAll("tbody tr");
    const b1 = R.b1;
    rows.forEach((rw, i) => {
      const tr = trs[i];
      tr.className = `${rw.kind}${b1 && rw.price >= b1.lo && rw.price <= b1.hi ? " in1s" : ""}`;
      const move = x.spot ? ((rw.price - x.spot) / x.spot) * 100 : null;
      setCell(tr.children[0], `${formatInt(rw.price)}|${rw.kind}|${formatFixed(move, 1)}`, () => [rw.kind === "be" ? h("span", { class: "be-tag" }, "BE ") : null, rw.kind === "spot" ? formatFixed(rw.price, 1) : formatInt(rw.price), h("small", { class: "mv-sub" }, `${formatSigned(move, 1)}%`)]);
      setCell(tr.children[1], formatFixed(move, 1), () => `${formatSigned(move, 1)}%`);
      setCell(tr.children[2], formatFixed(rw.z, 1), () => (isFigure(rw.z) ? `${formatSigned(rw.z, 1)}σ` : DASH));
      setCell(tr.children[3], `${showT}|${Math.round(rw.target ?? NaN)}`, () => (isFigure(rw.target) ? moneyEl(rw.target) : DASH));
      setCell(tr.children[4], `${Math.round(rw.expiry)}`, () => moneyEl(rw.expiry));
      const [neg, pos] = tr.children[5].firstChild.children;
      const w = Math.min(50, (Math.abs(rw.expiry) / maxAbs) * 50);
      neg.style.width = `${rw.expiry < 0 ? w : 0}%`;
      pos.style.width = `${rw.expiry > 0 ? w : 0}%`;
    });
  }
  function drawGrid() {
    const now = Date.now();
    const dates = O.gridDates(now, R.expMs, 8);
    const lv = levels().filter((l) => l.kind !== "be");
    const f = O.strategyPayoff(R.act, R.lot, { years: R.T, ivShift: R.shift, charges: R.net });
    const entry = R.net?.entry ?? 0;
    const cells = lv.map((lvl) => dates.map((ms, j) => (j === dates.length - 1 ? f(lvl.price) : (() => {
      const v = O.valueAt(R.act, lvl.price, R.lot, null, R.basis, { el: Math.max(0, Math.min(R.T, O.elapsedVolYears(R.front, now, ms, refSession(st.ref).close) ?? (ms - now) / YEAR_MS)), ivShift: R.shift });
      return v === null ? null : v - entry;
    })())));
    const maxAbs = Math.max(1, ...cells.flat().filter(isFigure).map(Math.abs));
    let tj = 0;
    dates.forEach((ms, j) => (Math.abs(ms - R.targetMs) < Math.abs(dates[tj] - R.targetMs) ? (tj = j) : null));
    tableNote.textContent = "Tap a cell: target date + price";
    const sig = `grid|${lv.length}|${dates.length}|${lv.map((l) => l.kind).join("")}`;
    if (tableBody.__sig !== sig) {
      tableBody.__sig = sig;
      tableBody.replaceChildren(
        h(
          "div",
          { class: "table-wrap scen-grid" },
          h(
            "table",
            { class: "desk-table grid-table" },
            h("caption", { class: "sr-only" }, "P&L by price (rows) and date (columns)"),
            h("thead", {}, h("tr", {}, h("th", { scope: "col", class: "num" }, "Price"), dates.map(() => h("th", { scope: "col", class: "num gd" })))),
            h("tbody", {}, lv.map((lvl, i) => h("tr", { class: lvl.kind }, h("th", { scope: "row", class: "num" }), dates.map((ms, j) => h("td", { class: "num hc", tabindex: "0", "data-i": String(i), "data-j": String(j) }))))),
          ),
        ),
      );
      tableBody.querySelector("tbody").addEventListener("click", (e) => {
        const td = e.target.closest("td.hc");
        if (td) pickCell(Number(td.dataset.i), Number(td.dataset.j));
      });
      tableBody.querySelector("tbody").addEventListener("keydown", (e) => {
        const td = e.target.closest("td.hc");
        if (td && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          pickCell(Number(td.dataset.i), Number(td.dataset.j));
        }
      });
    }
    tableBody.__grid = { dates, lv };
    const ths = tableBody.querySelectorAll("thead th.gd");
    dates.forEach((ms, j) => {
      const t = j === 0 ? "Now" : j === dates.length - 1 ? "Expiry" : DOW.format(new Date(ms));
      if (ths[j].textContent !== t) ths[j].textContent = t;
      ths[j].classList.toggle("tcol", j === tj);
    });
    const trs = tableBody.querySelectorAll("tbody tr");
    lv.forEach((lvl, i) => {
      const tr = trs[i];
      const th = tr.firstChild;
      const pt = lvl.kind === "spot" ? formatFixed(lvl.price, 1) : formatInt(lvl.price);
      if (th.textContent !== pt) th.textContent = pt;
      cells[i].forEach((v, j) => {
        const td = tr.children[j + 1];
        const t = isFigure(v) ? money(v) : DASH;
        if (td.textContent !== t) td.textContent = t;
        const frac = isFigure(v) ? Math.min(1, Math.abs(v) / maxAbs) : 0;
        td.style.setProperty("--hx", String(Math.round(frac ** 0.7 * 1000) / 1000));
        td.className = `num hc ${v > 0.5 ? "pos" : v < -0.5 ? "neg" : ""}${j === tj ? " tcol" : ""}`;
        td.setAttribute("aria-label", `${pt} on ${j === 0 ? "now" : ths[j].textContent}: ${t}`);
      });
    });
  }
  function pickCell(i, j) {
    const gd = tableBody.__grid;
    if (!gd) return;
    const ms = gd.dates[j];
    wi.target = j === 0 ? null : j === gd.dates.length - 1 ? R.expMs : ms;
    save();
    drawAnalysis();
    chart.pin(gd.lv[i].price);
  }
  function drawGreeksTab() {
    const gr = greekRows() ?? [];
    const lot = R.lot;
    const dl = gr.map((q) => (q.g ? q.g.delta / lot : null));
    const maxD = Math.max(0.01, ...dl.filter(isFigure).map(Math.abs));
    tableNote.textContent = R.el > 0 ? `At ${when(R.targetMs)}` : "Now";
    const sig = `greeks|${gr.length}|${gr.map((r) => r.kind).join("")}`;
    if (tableBody.__sig !== sig) {
      tableBody.__sig = sig;
      const th = (t) => h("th", { scope: "col", class: "num" }, t);
      tableBody.replaceChildren(h("div", { class: "table-wrap" }, h("table", { class: "desk-table pnl-table greeks-table" }, h("caption", { class: "sr-only" }, "Net greeks across price"), h("thead", {}, h("tr", {}, th("Price"), th("Δ lots"), th(""), th("Γ per 1%"), th("Θ ₹/trading day"), th("ν ₹/pt"))), h("tbody", {}, gr.map(() => h("tr", {}, h("td", { class: "num" }), h("td", { class: "num" }), h("td", { class: "c-bar" }, h("span", { class: "ebar delta" }, h("i", { class: "neg" }), h("i", { class: "pos" }))), h("td", { class: "num" }), h("td", { class: "num" }), h("td", { class: "num" })))))));
    }
    const trs = tableBody.querySelectorAll("tbody tr");
    gr.forEach((q, i) => {
      const tr = trs[i];
      tr.className = q.kind;
      const g = q.g;
      setCell(tr.children[0], `${q.price}|${q.kind}`, () => [q.kind === "be" ? h("span", { class: "be-tag" }, "BE ") : null, q.kind === "spot" ? formatFixed(q.price, 1) : formatInt(q.price)]);
      setCell(tr.children[1], formatFixed(dl[i], 2), () => formatSigned(dl[i], 2));
      const [neg, pos] = tr.children[2].firstChild.children;
      const w = isFigure(dl[i]) ? Math.min(50, (Math.abs(dl[i]) / maxD) * 50) : 0;
      neg.style.width = `${dl[i] < 0 ? w : 0}%`;
      pos.style.width = `${dl[i] > 0 ? w : 0}%`;
      setCell(tr.children[3], formatFixed(g ? (g.gamma * q.price * 0.01) / lot : null, 3), () => formatSigned(g ? (g.gamma * q.price * 0.01) / lot : null, 2));
      setCell(tr.children[4], `${Math.round(g?.theta ?? NaN)}`, () => moneyEl(g?.theta));
      setCell(tr.children[5], `${Math.round(g?.vega ?? NaN)}`, () => moneyEl(g?.vega));
    });
  }

  // ── Sticky bar, Place buttons, head ──
  function drawBar() {
    // Phone / tablet: the sticky bar appears once there is a leg; with none, the presets are the call to action.
    if (bar.hidden !== !legs().length) bar.hidden = !legs().length;
    const n = R?.stats?.net;
    const exit = closeMode();
    barNet.textContent = !R ? (noChain ? "No chain" : "…") : !R.ok ? (R.act.length ? "Needs prices" : "No legs") : `${n > 0.5 ? "Credit" : n < -0.5 ? "Debit" : "Even"} ${rupees(Math.abs(n))}`;
    const s = R?.stats;
    barSub.textContent = R?.ok ? [s.maxLoss === null ? "Max loss unlimited" : `Max loss ${rupees(s.maxLoss, true)}`, isFigure(s.pop) ? `POP ${formatPercent(s.pop * 100, 0)}` : null].filter(Boolean).join(" · ") : "";
    const nAct = R?.act.length ?? 0;
    const blockedWhy = !R ? (noChain ? "The chain is unavailable" : "Waiting for the chain") : !account() ? "Choose an account that can place orders" : !nAct ? "Add a leg first" : R.dead.length ? R.warnings[0].text : !R.ok ? "Every leg needs a price" : R.warnings.some((w) => w.severity === "block") ? R.warnings.find((w) => w.severity === "block").text : null;
    const warned = !blockedWhy && R?.warnings.some((w) => w.severity === "warn");
    const placeable = Boolean(R?.ok) && nAct > 0;
    const label = exit ? "Close legs" : placeable ? `Place ${formatInt(nAct)}` : "Place";
    for (const b of [barPlace, placeBtn]) {
      const t = b === placeBtn && !exit && placeable ? `Place ${plural(nAct, "leg")}` : label;
      if (b.textContent !== t) b.textContent = t;
      // Only a block greys the button (aria-disabled keeps the reason reachable); a warning keeps it solid with a dot.
      b.classList.toggle("blocked", Boolean(blockedWhy));
      b.removeAttribute("aria-disabled");
      b.classList.toggle("has-warn", Boolean(warned));
      if (blockedWhy) b.title = blockedWhy;
      else if (warned) b.title = R.warnings.find((w) => w.severity === "warn").text;
      else b.removeAttribute("title");
    }
  }
  const closeMode = () => {
    const ls = legs().filter((l) => l.on !== false);
    return ls.length > 0 && ls.every((l) => isHeld(l));
  };
  function drawHead() {
    const ls = legs();
    const nm = draftName();
    if (nameBtn.textContent !== nm) nameBtn.textContent = nm;
    nameBtn.disabled = !ls.length;
    const exps = [...new Set(ls.filter((l) => l.kind === "OPT").map((l) => l.expiry))].sort().map(expiryText);
    const basisText = { touch: "at the touch", mid: "at mid", ltp: "at LTP" }[cfg().basis];
    ctxLine.textContent = ls.length ? `${plural(ls.length, "leg")} · ${exps.join(" + ") || expiryText(st.expiry)} · prices ${basisText}${st.live ? "" : " · paused"}` : `${st.underlying} ${expiryText(st.expiry)} · prices ${basisText}`;
    const n = readSaves().length;
    savedBtn.textContent = n ? `Saved ${formatInt(n)}` : "Saved";
    saveBtn.disabled = !ls.length;
  }
  function drawStale() {
    const st2 = R?.stale;
    panel.classList.toggle("is-stale", Boolean(st2));
    staleBar.hidden = !st2;
    if (st2) {
      const t = `Prices are ${formatInt(Math.round((R.age ?? 0) / 1000))} s old`;
      if (staleBar.__t !== t) {
        staleBar.__t = t;
        staleBar.replaceChildren(...[h("span", {}, t), staleInfo.onRetry ? h("button", { type: "button", class: "link-btn", onclick: () => staleInfo.onRetry() }, "Retry") : null].filter(Boolean));
      }
    }
  }

  // ── The chart's view and the analysis column ──
  function chartView() {
    const m = R.model;
    const front = R.front;
    const markers = R.act.map((l) => ({ id: l.id, kind: l.kind, right: l.right, side: l.side, strike: l.strike, price: l.kind === "FUT" ? l.price ?? x.F : null, title: `${l.side === "BUY" ? "Buy" : "Sell"} ${formatInt(l.lots)} × ${l.label}${l.kind === "OPT" && l.expiry !== front ? ` ${expiryText(l.expiry)}` : ""} @ ${formatFixed(l.price, 2)}` }));
    const perLeg = cfg().perLeg ? R.act.map((l) => ({ id: l.id, right: l.right, side: l.side, vals: m.xs.map(O.strategyPayoff([l], R.lot, { years: R.T, ivShift: R.shift })) })) : null;
    let compare = null;
    if (compareItem && compareItem.underlying === x.c.underlying) {
      const cl = compareItem.legs.filter((l) => l.on !== false && isFigure(l.entry)).map((l) => ({ ...l, price: l.entry, iv: num(l.ivAtSave) ?? x.sm.atmIv, years: O.yearsToExpiry(l.expiry ?? compareItem.expiry, Date.now(), refSession(st.ref).close), basis0: 0, futYears: 0 }));
      if (cl.length) compare = { label: `Saved: ${compareItem.name}`, vals: m.xs.map(O.strategyPayoff(cl, R.lot, { years: R.T, ivShift: R.shift })) };
    }
    const now = Date.now();
    const atExp = R.targetMs >= R.expMs - 60000;
    return {
      ...m,
      markers,
      perLeg,
      compare,
      labels: {
        expiry: R.multi ? `At ${expiryText(front)} (first expiry)` : `Expiry (${expiryText(front)})`,
        expiryShort: R.multi ? `At ${expiryText(front)}` : "Expiry",
        target: R.el <= 0 ? "Now" : atExp ? "Target (expiry)" : `Target (T+${span(R.targetMs - now)})`,
        mid: "Mid-date",
      },
      showDist: cfg().dist && !isPhone(),
      yMode: cfg().yMode === "pct" && isFigure(R.margin) && R.margin > 0 ? "pct" : "rupee",
      yScale: cfg().yMode === "pct" && isFigure(R.margin) && R.margin > 0 ? 100 / R.margin : 1,
      chainStrikes: x.c.rows.map((r) => r.strike),
      highlight: cfg().perLeg ? hiLeg : null,
    };
  }
  function drawAnalysis() {
    raf = 0;
    if (!x) return;
    R = compute();
    const animate = animateNext;
    drawHero();
    drawWarnings();
    drawWhatIf();
    drawMore();
    drawTable();
    drawRisk();
    drawBar();
    drawStale();
    if (R.model) chart.update(chartView(), { animate });
    else if (!R.act.length) {
      const sugg = h("button", { type: "button", class: "link-btn", onclick: () => openSuggest() }, "Suggest from my view →");
      chart.empty({ text: R.all.length ? "All legs are switched off" : "Pick a strategy or add a leg", sub: R.all.length ? null : h("span", {}, "or "), action: R.all.length ? null : sugg });
    } else chart.empty({ text: R.dead.length ? R.warnings[0].text : R.missing.some((l) => l.loading) ? "Loading the later expiry's prices…" : `${R.missing.map((l) => l.label).join(", ")} ${R.missing.length === 1 ? "has" : "have"} no price`, sub: h("span", {}, R.dead.length ? "Roll it to a live expiry or remove it (in the line above)." : "The figures wait for every leg's price.") });
    animateNext = false;
    if (curvesSeg.value !== String(cfg().curves)) curvesSeg.value = String(cfg().curves);
  }
  const scheduleAnalysis = () => {
    if (!raf) raf = requestAnimationFrame(drawAnalysis);
  };
  function drawBuildExtras() {
    drawAdjust();
    drawSuggestShell();
  }
  function drawAll() {
    drawHead();
    drawChips();
    drawLegs();
    drawAnalysis();
    drawBuildExtras();
    picker?.patch();
  }

  // ── Adjustments (§5.8): delta-neutralise preview, convert ──
  function proposeNeutral() {
    if (!R?.ok || !isFigure(R.greeks?.delta)) return toast("Needs priced legs", { tone: "info" });
    const f = fut();
    const atm = O.atmRow(x.c);
    const p = O.neutraliseDelta({ deltaUnits: R.greeks.delta, lot: R.lot, fut: f ? { lotSize: num(f.lotSize) || R.lot } : null, atm: atm ? { strike: atm.strike, ceDelta: atm.ce?.delta, peDelta: atm.pe?.delta } : null });
    if (!p) return toast("Already close to delta-neutral", { tone: "info" });
    neutral = { ...p, fut: f };
    drawAdjust();
  }
  function drawAdjust() {
    adjustEl.hidden = !neutral;
    if (!neutral || !R) return;
    const p = neutral;
    const what = p.kind === "FUT" ? `${p.side === "BUY" ? "Buy" : "Sell"} ${formatInt(p.lots)} FUT ${expiryText(p.fut?.expiry)}` : `${p.side === "BUY" ? "Buy" : "Sell"} ${formatInt(p.lots)} × ${formatInt(p.strike)} ${p.right}`;
    adjustEl.replaceChildren(
      icon("info"),
      h("span", { class: "adj-t" }, `Adds ${what} · Δ ${formatSigned((R.greeks?.delta ?? 0) / R.lot, 2)} → ${formatSigned(p.after / R.lot, 2)} lots`),
      h("button", { type: "button", class: "small", onclick: () => applyNeutral() }, "Apply"),
      h("button", { type: "button", class: "small plain", onclick: () => ((neutral = null), drawAdjust()) }, "Cancel"),
    );
  }
  function applyNeutral() {
    const p = neutral;
    if (!p) return;
    neutral = null;
    if (legs().length >= O.MAX_LEGS) return toast(`Up to ${O.MAX_LEGS} legs`, { tone: "warn" });
    const leg = p.kind === "FUT" ? { kind: "FUT", side: p.side, lots: p.lots, symbol: p.fut.symbol, expiry: p.fut.expiry, lotSize: p.fut.lotSize } : { kind: "OPT", right: p.right, strike: p.strike, side: p.side, lots: p.lots, expiry: x.c.expiry, symbol: symOf({ kind: "OPT", right: p.right, strike: p.strike, expiry: x.c.expiry }), lotSize: x.lot };
    mutate((ls) => ls.push(leg), { undoLabel: "Delta-neutralised" });
  }
  function convert() {
    const c = O.convertStructure(legs(), x?.c.rows.map((r) => r.strike) ?? []);
    if (!c) return;
    setName(null);
    setLegs(c.legs.map((l) => (l.kind === "FUT" ? l : { ...l, symbol: l.symbol ?? symOf(l), lotSize: l.lotSize ?? x.lot })), { undoLabel: `Converted to ${c.name}` });
  }

  // ── Menus: leg ⋯, expiry, tools ⋯, head ⋯, chart ⋯ ──
  function menu(trigger, title, items) {
    let handle = null;
    const body = h(
      "div",
      { class: "menu-list stack" },
      items.filter(Boolean).map(([label, fn, opts = {}]) => h("button", { type: "button", class: `menu-item${opts.danger ? " destructive" : ""}`, disabled: opts.disabled, title: opts.title, onclick: () => (handle?.close(), setTimeout(fn, 0)) }, label, opts.sub ? h("small", {}, opts.sub) : null)),
    );
    handle = sheetPopover({ trigger, title, body, cls: "menu-pop" });
  }
  function openLegMenu(id, trigger) {
    const l = legs().find((y) => y.id === id);
    const p = priced.find((y) => y.id === id);
    if (!l || !x) return;
    const name = O.legLabel(l);
    const ks = strikesOf(l.expiry);
    const outK = l.kind === "OPT" ? O.rollStrike(ks, l, x.spot, "out") : null;
    const inK = l.kind === "OPT" ? O.rollStrike(ks, l, x.spot, "in") : null;
    const nx = l.kind === "OPT" ? O.nextExpiry(st.expiries ?? [], l.expiry) : null;
    const pxOf = (k) => {
      const q = chainFor(l.expiry)?.rows.find((r) => r.strike === k)?.[l.right === "CE" ? "ce" : "pe"];
      return O.mid(q) ?? num(q?.ltp);
    };
    const wing = l.kind === "OPT" && l.side === "SELL" ? O.wingStrike(ks, { ...l, price: p?.price }, pxOf) : null;
    const roll = (k) => mutateLeg(id, (y) => ((y.strike = k), (y.symbol = symOf({ ...y, strike: k })), delete y.entry, delete y.entryTag), { undoLabel: `${name} rolled to ${formatInt(k)}` });
    menu(trigger, `${l.side === "BUY" ? "Buy" : "Sell"} ${name} · ${expiryText(l.expiry)}`, [
      [l.on === false ? "Switch on" : "Switch off", () => mutateLeg(id, (y) => (y.on = y.on === false)), { sub: l.on === false ? "back in the figures" : "keeps the leg, leaves it out of the figures" }],
      ["Duplicate", () => (legs().length >= O.MAX_LEGS ? toast(`Up to ${O.MAX_LEGS} legs`, { tone: "warn" }) : mutate((ls) => ls.splice(ls.findIndex((y) => y.id === id) + 1, 0, { ...structuredClone(l), id: undefined }), { undoLabel: `${name} duplicated` }))],
      l.kind === "OPT" ? ["Roll strike out", () => roll(outK), { disabled: outK === null, sub: outK !== null ? `to ${formatInt(outK)}, away from spot` : "at the edge" }] : null,
      l.kind === "OPT" ? ["Roll strike in", () => roll(inK), { disabled: inK === null, sub: inK !== null ? `to ${formatInt(inK)}, towards spot` : "at spot" }] : null,
      l.kind === "OPT" ? ["Roll to next expiry", () => setLegExpiry(id, nx), { disabled: !nx, sub: nx ? `same strike, ${expiryText(nx)}` : "no later expiry" }] : null,
      wing !== null ? ["Add wing", () => mutate((ls) => ls.push({ kind: "OPT", right: l.right, strike: wing, side: "BUY", lots: l.lots, expiry: l.expiry, symbol: symOf({ ...l, strike: wing }), lotSize: l.lotSize }), { undoLabel: `Wing ${formatInt(wing)} ${l.right} added` }), { sub: `buy ${formatInt(wing)} ${l.right}: caps the risk` }] : null,
      p?.manual ? ["Reset to live price", () => mutateLeg(id, (y) => (delete y.entry, delete y.entryTag)), { sub: `live ${formatFixed(p.livePrice, 2)}` }] : null,
      isHeld(l) ? ["Close leg", () => mutate((ls) => (ls.forEach((y) => (y.on = y.id === id)), true), { undoLabel: `Only ${name} kept on` }), { sub: "switches the others off: Place closes it" }] : null,
      ["Remove", () => mutate((ls) => ls.splice(ls.findIndex((y) => y.id === id), 1), { undoLabel: `${name} removed` }), { danger: true }],
    ]);
  }
  function openExpiryMenu(id, trigger) {
    const l = legs().find((y) => y.id === id);
    if (!l) return;
    const ex = (st.expiries ?? []).filter((e) => e >= (x?.c.expiry ?? "")).slice(0, 6);
    menu(
      trigger,
      `Expiry for ${O.legLabel(l)}`,
      ex.map((e) => {
        const t = O.expiryTag(e, st.expiries);
        return [`${expiryText(e)} · ${t.days}${t.monthly ? " · M" : ""}${e === l.expiry ? " ✓" : ""}`, () => setLegExpiry(id, e), { disabled: e === l.expiry }];
      }),
    );
  }
  function openToolsMenu(trigger) {
    const ls = legs();
    menu(trigger, "Strategy tools", [
      ["Flip all sides", flipAll, { disabled: !ls.length, sub: "buy ↔ sell: the debit mirror of a credit" }],
      ["Delta-neutralise", proposeNeutral, { disabled: !ls.length, sub: fut() ? "with futures" : "with ATM options" }],
      ["Clear", clearAll, { disabled: !ls.length, danger: true }],
    ]);
  }
  function openHeadMenu() {
    const ls = legs();
    const conv = x ? O.convertStructure(ls, x.c.rows.map((r) => r.strike)) : null;
    menu(moreBtn, "Strategy", [
      conv ? [`Convert to ${conv.name}`, convert, { sub: "add wings: defined risk" }] : null,
      ["Rename", () => nameBtn.click(), { disabled: !ls.length }],
      [savedBtn.textContent, openSaved],
      ["Save", openSave, { disabled: !ls.length }],
      ["Flip all sides", flipAll, { disabled: !ls.length }],
      ["Delta-neutralise", proposeNeutral, { disabled: !ls.length }],
      ["Customise", openCustomise],
      ["Keys", showKeys],
      ["Clear", clearAll, { disabled: !ls.length, danger: true }],
    ]);
  }
  function openChartMenu() {
    const c = cfg();
    const sw = (label, on, fn, hint) => {
      const input = h("input", { type: "checkbox", role: "switch" });
      input.checked = on;
      input.addEventListener("change", () => fn(input.checked));
      return h("label", { class: "sw-row" }, h("span", { class: "sw-text" }, label, hint ? h("small", {}, hint) : null), h("span", { class: "switch" }, input, h("i", { "aria-hidden": "true" })));
    };
    const ySeg = segmented("Y axis", [["rupee", "₹"], ["pct", "% of margin"]], c.yMode);
    ySeg.addEventListener("change", () => setCfg({ yMode: ySeg.value }));
    sheetPopover({
      trigger: chartMore,
      title: "Chart",
      cls: "chart-pop",
      body: h(
        "div",
        { class: "pop-body" },
        sw("Show distribution", c.dist, (v) => setCfg({ dist: v }), "Where the price may land, profit zone tinted"),
        sw("Show per-leg payoffs", c.perLeg, (v) => setCfg({ perLeg: v }), "Each leg's expiry P&L; hover a leg to pick it out"),
        h("div", { class: "pop-segs" }, h("span", { class: "muted small" }, "Y axis"), ySeg),
        compareItem ? h("button", { type: "button", class: "small plain", onclick: () => ((compareItem = null), drawAnalysis()) }, `Stop comparing "${compareItem.name}"`) : null,
        app.chartEngine ? h("button", { type: "button", class: "small plain", onclick: () => openPriceChart() }, "Price chart with your strikes") : null,
      ),
    });
  }

  // ── Suggest (§5.7) ──
  function openSuggest() {
    if (!cfg().suggestOpen) setCfg({ suggestOpen: true });
    requestAnimationFrame(() => {
      suggestEl.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
      sgTarget.focus({ preventScroll: true });
    });
  }
  let sgSig = "";
  function drawSuggestShell() {
    const open = cfg().suggestOpen;
    suggestEl.classList.toggle("closed", !open);
    sgToggle.setAttribute("aria-expanded", String(open));
    if (!x) return;
    const ex = (st.expiries ?? []).filter((e) => e >= x.c.expiry).slice(0, 6);
    const exSig = ex.join();
    if (sgDate.__sig !== exSig) {
      sgDate.__sig = exSig;
      sgDate.replaceChildren(...ex.map((e) => h("option", { value: e }, `${expiryText(e)} · ${O.expiryTag(e, st.expiries).days}`)));
    }
    if (!sg.date || !ex.includes(sg.date)) sg.date = x.c.expiry;
    if (sgDate.value !== sg.date) sgDate.value = sg.date;
    if (sg.target === null) sg.target = Math.round(x.spot ?? x.F);
    const mv = x.move ?? x.spot * 0.01;
    const lo = Math.round(x.spot - 2 * mv);
    const hi = Math.round(x.spot + 2 * mv);
    sgRange.min = String(lo);
    sgRange.max = String(hi);
    sgRange.step = "1";
    if (document.activeElement !== sgRange) sgRange.value = String(sg.target);
    sgRange.style.setProperty("--fill", `${Math.max(0, Math.min(100, ((sg.target - lo) / Math.max(1, hi - lo)) * 100))}%`);
    if (document.activeElement !== sgTarget) sgTarget.value = String(sg.target);
    const qs = `${Math.round(x.spot)}|${Math.round(mv)}`;
    if (sgQuick.__sig !== qs) {
      sgQuick.__sig = qs;
      sgQuick.replaceChildren(...[[-1, "−1σ"], [-0.5, "−½σ"], [0, "Spot"], [0.5, "+½σ"], [1, "+1σ"]].map(([k, t]) => h("button", { type: "button", class: "small chip-btn", "data-k": String(k), onclick: () => setTarget(Math.round(x.spot + k * mv)) }, t)));
    }
    for (const b of sgQuick.children) b.setAttribute("aria-pressed", String(Math.round(x.spot + Number(b.dataset.k) * mv) === sg.target));
    const view = sg.vol ? "vol" : O.inferView(sg.target, x.spot, mv);
    const vt = { bull: "Bullish view", bear: "Bearish view", neutral: "Neutral view", vol: "Big move view" }[view];
    if (sgView.textContent !== vt) sgView.textContent = vt;
    sgView.dataset.view = view;
    sgToggle.querySelector(".sec-sum").textContent = open ? "" : "target · date · risk";
    const sig = `${open}|${sg.target}|${sg.date}|${sg.risk}|${sg.maxCap}|${sg.vol}|${x.c.underlying}|${x.c.expiry}`;
    if (open && sig !== sgSig) {
      sgSig = sig;
      runSuggest();
    }
  }
  function setTarget(v) {
    if (!isFigure(v)) return;
    sg.target = Math.round(Number(v));
    drawSuggestShell();
  }
  function stepTarget(d) {
    const ks = x?.c.rows.map((r) => r.strike) ?? [];
    const near = ks.reduce((b, k) => (Math.abs(k - sg.target) < Math.abs(b - sg.target) ? k : b), ks[0]);
    setTarget(near === sg.target || (d > 0 ? near < sg.target : near > sg.target) ? O.stepStrike(ks, near, d) ?? near : near);
  }
  sgTarget.addEventListener("change", () => setTarget(sgTarget.value));
  sgRange.addEventListener("input", () => setTarget(sgRange.value));
  sgDate.addEventListener("change", () => {
    sg.date = sgDate.value;
    drawSuggestShell();
  });
  sgRisk.addEventListener("change", () => {
    sg.risk = sgRisk.value;
    drawSuggestShell();
  });
  sgCap.addEventListener("change", () => {
    sg.maxCap = isFigure(sgCap.value) && Number(sgCap.value) > 0 ? Number(sgCap.value) : null;
    drawSuggestShell();
  });
  sgVol.addEventListener("click", () => {
    sg.vol = !sg.vol;
    sgVol.setAttribute("aria-pressed", String(sg.vol));
    drawSuggestShell();
  });
  const idle = (fn) => (typeof requestIdleCallback === "function" ? requestIdleCallback(fn, { timeout: 120 }) : setTimeout(fn, 0));
  /** Candidates in idle chunks of 50 (cancelled by a newer run), then the top 6 cards. */
  function runSuggest() {
    if (!x || !cfg().suggestOpen) return;
    const job = (sg.job += 1);
    const front = x.c.expiry;
    const later = sg.date && sg.date !== front;
    sg.back = later ? sg.date : null;
    let backChain = null;
    if (later) {
      backChain = chainFor(sg.date);
      if (!backChain) {
        sgOut.replaceChildren(h("p", { class: "muted small" }, `Loading the ${expiryText(sg.date)} chain…`));
        if (!chains.get(sg.date)?.loading) fetchChain(sg.date);
        return;
      }
    }
    const mv = x.move ?? x.spot * 0.01;
    const cands = O.suggestCandidates(x.c, { target: sg.target, spot: x.spot, forward: x.F, move: mv, group: sg.vol ? "vol" : null, back: sg.back });
    const ctx = { chain: x.c, backChain, lot: x.lot, forward: x.F, spot: x.spot, ivPct: x.sm.atmIv, years: Math.max(1 / 8760, x.years ?? 0), backYears: later ? O.yearsToExpiry(sg.date, Date.now(), refSession(st.ref).close) : null, el: Math.max(1 / 8760, x.years ?? 0), target: sg.target };
    sg.busy = true;
    sgOut.classList.add("busy");
    const scored = [];
    let i = 0;
    const chunk = () => {
      if (job !== sg.job) return;
      for (const end = Math.min(cands.length, i + 50); i < end; i += 1) scored.push(O.scoreCandidate(cands[i], ctx));
      if (i < cands.length) return idle(chunk);
      sg.busy = false;
      sgOut.classList.remove("busy");
      drawSuggestions(O.rankSuggestions(scored, { risk: sg.risk, maxCapital: sg.maxCap, top: 6 }), ctx);
    };
    idle(chunk);
  }
  function drawSuggestions(top, ctx) {
    if (!top.length) {
      sgOut.replaceChildren(h("p", { class: "sg-none" }, `Nothing makes money at ${formatInt(sg.target)} by ${expiryText(sg.date)}${sg.maxCap ? ` within ${rupees(sg.maxCap)}` : ""}. Try a later date${sg.maxCap ? " or more capital" : ""}${sg.risk === "defined" ? ", or Any risk" : ""}.`));
      return;
    }
    sgOut.replaceChildren(
      h(
        "div",
        { class: "sg-cards" },
        top.map((c, idx) => {
          const gl = c.legs.some((l) => l.expiry && l.expiry !== x.c.expiry) ? glyphOfCurve(c.legs.map((l) => ({ ...l, basis0: 0 }))) : O.presetGlyph(c.legs, ctx.lot);
          const ks = [...new Set(c.legs.map((l) => l.strike))].sort((a, b) => a - b);
          const card = h(
            "button",
            { type: "button", class: "sg-card", title: "Load into the builder (Undo in the toast)" },
            h("span", { class: "pc-glyph" }, gl ? glyphSvg(gl, { w: 64, hgt: 28, target: glyphX(c.legs, sg.target) }) : null),
            h("strong", { class: "sg-name", title: `${c.name} ${ks.map((k) => formatInt(k)).join(" / ")}` }, `${c.name} `, h("span", { class: "sg-k" }, ks.map((k) => formatInt(k)).join(" / "))),
            h("span", { class: "sg-pnl up", title: "P&L at the target price and date" }, money(c.pnlT)),
            h("small", { class: "sg-meta" }, `at target · max loss ${c.maxLoss === null ? "unlimited" : money(c.maxLoss)} · POP ${isFigure(c.pop) ? formatPercent(c.pop * 100, 0) : DASH} · ${rupees(c.capital)} capital`),
          );
          card.addEventListener("click", () => loadSuggestion(c));
          if (!reducedMotion()) card.style.setProperty("--i", String(idx));
          return card;
        }),
      ),
    );
  }
  function loadSuggestion(c) {
    const legsIn = c.legs.map((l) => ({ kind: "OPT", right: l.right, strike: l.strike, side: l.side, lots: l.lots, expiry: l.expiry ?? x.c.expiry, symbol: symOf({ ...l, kind: "OPT", expiry: l.expiry ?? x.c.expiry }), lotSize: x.lot }));
    setName(null);
    // The target date jumps to the first expiry (the date the suggestion was scored at); the crosshair pins at the target.
    wi.target = O.expiryCloseMs(x.c.expiry, refSession(st.ref).close);
    setLegs(legsIn, { undoLabel: `${c.name} loaded` });
    requestAnimationFrame(() => chart.pin(sg.target));
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
    const res = await Promise.all(act.map((l) => optional(api("/v1/orders/preview", { method: "POST", body: { account: a.id, symbol: l.symbol, side: isHeld(l) ? (l.side === "BUY" ? "SELL" : "BUY") : l.side, lots: l.lots, product: l.product ?? cfg().product, orderType: "LIMIT", price: l.manual ? l.livePrice ?? l.price : l.price } }))));
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
    // Paper: one basket call, so hedges between the legs (and with what the account holds) are credited.
    let paper = null;
    if (a.broker === "paper" && all) {
      const r = await optional(api(`/v1/paper/accounts/${enc(a.id)}/margin`, { method: "POST", body: { legs: act.map((l) => ({ symbol: l.symbol, side: isHeld(l) ? (l.side === "BUY" ? "SELL" : "BUY") : l.side, lots: l.lots, ...(isFigure(l.price) && l.price > 0 ? { price: l.manual ? l.livePrice ?? l.price : l.price } : {}) })) } }));
      if (sigOf(priced.filter((l) => l.on !== false && l.symbol && isFigure(l.price))) !== sig) return;
      paper = r.data?.data ?? null;
    }
    pv = { sig, margin: paper ? Math.max(0, paper.change) : all ? total : null, paper, loading: false, freeze, failed: res.some((r) => r.error) };
    if (x) {
      priced = price(x);
      drawAnalysis();
    }
  }

  // ── Placement ──
  async function place() {
    if (!R || !x) return;
    const a = account();
    if (!a) return toast("Choose an account that can place orders first.", { tone: "warn" });
    if (!R.act.length) return;
    // A block still opens the sheet (Confirm disabled, the reason listed, the account switchable there); only legs
    // without a price stop here, since there is nothing to send.
    if (!R.ok) return toast(R.dead.length ? R.warnings[0].text : "Every leg needs a price", { tone: "warn" });
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
        label: l.kind === "FUT" ? `FUT ${expiryText(l.expiry)}` : `${formatInt(l.strike)} ${l.right}${l.expiry !== x.c.expiry ? ` ${expiryText(l.expiry)}` : ""}`,
        lots: l.lots,
        lotSize: l.lotSize,
        // Your own entry price feeds the figures; the order still goes at the live limit unless edited in the sheet.
        price: exit ? O.basisPrice(q, p.side, "touch").price : l.manual ? l.livePrice ?? l.price : l.price,
        product: l.product,
        quote: () => quoteOf(l),
        freezeQty: l.freezeQty,
        fut: l.kind === "FUT",
      };
    });
    const title = exit ? `Close ${plural(items.length, "leg")} · ${x.c.underlying}` : `Place ${draftName()} · ${x.c.underlying}`;
    // Like the desk ticket, nothing is placed before the reference bundle has resolved (a fallback counts: it asks for
    // the lot-size confirmation); the bundle is read here when the page has not got it yet.
    let ref = st.ref;
    if (!ref || ref.underlying !== x.c.underlying) {
      toast("Reading contract data");
      ref = await loadReference(x.c.underlying, { demoStale: Boolean(app.state.demo) && demoStaleAsked() });
      if (!R || !x) return;
    }
    const gateLegs = items.map((it) => ({ lotSize: it.lotSize ?? x.lot, expiry: it.leg?.expiry ?? x.c.expiry }));
    const r = await openPlacement({
      title,
      mode: exit ? "exit" : "entry",
      account: a,
      accountRow: acctPicker ? (reopen) => acctPicker(reopen, { badge: false }) : null,
      items,
      summary: exit ? null : { net: R.stats?.net ?? null, maxLoss: R.stats ? R.stats.maxLoss : undefined, margin: R.margin, marginEst: R.acct === null, free: funds.free },
      warnings: R.warnings,
      // Stale or conflicting reference lots: one confirmation for the whole basket that names every distinct lot
      // (docs/spec/p1-02-reference.md §5.4); a leg's LOT_SIZE_STALE preview opens it too.
      lotGate: basketLotGate(ref, gateLegs),
      lotGateFor: (checks) => basketLotGate(ref, gateLegs, { server: checks }),
      cfg: { product: cfg().product, hedgeWait: cfg().hedgeWait },
      onCfg: (patch) => setCfg(patch),
      onPositions,
      announce,
    });
    if (r.reopen) {
      // The account changed in the sheet: fresh funds and margin first, so the reopened sheet checks the new account.
      clearTimeout(pvTimer);
      await Promise.all([loadFunds(), runPreviews(true)]);
      place();
      return;
    }
    if (r.placed) {
      loadFunds();
      refresh();
    }
  }

  // ── Strike picker (A) ──
  function openPicker(focusStrike = null) {
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
    function buildRows() {
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
        const add = (right, side) => () => added(addLeg({ right, strike: r.strike, side, symbol: r[right === "CE" ? "ce" : "pe"]?.symbol ?? null, lotSize: x.lot, expiry: x.c.expiry }));
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
      rowsEl.replaceChildren(h("div", { class: "pk-head", "aria-hidden": "true" }, h("span", { class: "ce" }, "CE"), h("span", {}), h("span", {}, "Strike"), h("span", {}), h("span", { class: "pe" }, "PE")), ...out);
    }
    const rowEls = () => [...rowsEl.querySelectorAll(".pk-row")];
    const paintFocus = () => {
      rowEls().forEach((r, i) => r.classList.toggle("focus", i === focus.i));
      const r = rowEls()[focus.i];
      r?.scrollIntoView({ block: "nearest" });
      for (const s2 of rowsEl.querySelectorAll(".pk-row .side-on")) s2.classList.remove("side-on");
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
        focus.i = strikes.reduce((b, s2, i) => (Math.abs(s2 - n) < Math.abs(strikes[b] - n) ? i : b), 0);
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
        rs[focus.i].querySelectorAll(".pk-btns")[focus.side === "ce" ? 0 : 1].querySelectorAll("button")[k === "b" ? 0 : 1].click();
      }
    };
    body.append(h("div", { class: "picker-top" }, filter, h("span", { class: "muted small pk-hint" }, "B / S add one lot · ↑ ↓ ← → · Esc")), futRow, rowsEl, status);
    body.addEventListener("keydown", onKey);
    buildRows();
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
    const intoView = () => {
      const target = (focusStrike !== null && rowsEl.querySelector(`.pk-row[data-strike="${focusStrike}"]`)) || rowsEl.querySelector(".pk-row.atm");
      if (target) rowsEl.scrollTop = target.offsetTop - rowsEl.clientHeight / 2 + target.clientHeight / 2;
      if (focusStrike !== null && target) {
        focus.i = rowEls().indexOf(target);
        paintFocus();
      }
    };
    if (phone) {
      closeFn = () => document.querySelector("#dialog .sheet-close")?.click();
      modal({ title: `Add a leg · ${x.c.underlying} ${expiryText(x.c.expiry)}`, body }).then(() => (picker = null));
      requestAnimationFrame(intoView);
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
    // After layout: centre the ATM (or the asked) row, then bring the popover into view clear of the sticky bars.
    requestAnimationFrame(() => {
      intoView();
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
      const on = c.metrics.filter((k) => !HERO.includes(k));
      const pool = O.STRATEGY_METRICS.map(([k]) => k).filter((k) => !HERO.includes(k));
      const labelOf = (k) => O.STRATEGY_METRICS.find(([m]) => m === k)?.[1] ?? k;
      const setOn = (list) => setCfg({ metrics: [...HERO.filter((k) => c.metrics.includes(k)), ...list].length ? [...c.metrics.filter((k) => HERO.includes(k)), ...list] : ["net"] });
      const move = (k, d) => {
        const a = [...on];
        const i = a.indexOf(k);
        const j = i + d;
        if (j < 0 || j >= a.length) return;
        [a[i], a[j]] = [a[j], a[i]];
        setOn(a);
        draw();
      };
      const row = (k, enabled) =>
        h(
          "div",
          { class: `col-row ${enabled ? "on" : ""}`.trim(), "data-col": k },
          h("label", { class: "col-check" }, (() => {
            const i = h("input", { type: "checkbox" });
            i.checked = enabled;
            i.addEventListener("change", () => {
              setOn(enabled ? on.filter((m) => m !== k) : [...on, k]);
              draw();
            });
            return i;
          })(), h("span", {}, labelOf(k))),
          enabled ? h("span", { class: "col-move" }, h("button", { type: "button", class: "icon-btn tiny reorder", "aria-label": `Move ${labelOf(k)} earlier`, disabled: on.indexOf(k) === 0, onclick: () => move(k, -1) }, icon("up")), h("button", { type: "button", class: "icon-btn tiny reorder", "aria-label": `Move ${labelOf(k)} later`, disabled: on.indexOf(k) === on.length - 1, onclick: () => move(k, 1) }, icon("down"))) : null,
        );
      const list = h("div", { class: "col-list" }, on.map((k) => row(k, true)), pool.filter((k) => !on.includes(k)).map((k) => row(k, false)));
      const basis = segmented("Price basis", [["touch", "Touch"], ["mid", "Mid"], ["ltp", "LTP"]], c.basis);
      basis.addEventListener("change", () => setCfg({ basis: basis.value }));
      const wait = segmented("Hedge wait", [["5", "5 s"], ["15", "15 s"], ["30", "30 s"]], String(c.hedgeWait));
      wait.addEventListener("change", () => setCfg({ hedgeWait: Number(wait.value) }));
      const prod = segmented("Product", [["INTRADAY", "Intraday"], ["MARGIN", "Carry"]], c.product);
      prod.addEventListener("change", () => setCfg({ product: prod.value }));
      body.replaceChildren(
        h("section", {}, h("h3", {}, "More figures ", h("small", {}, "a quiet row under the chart")), list),
        h("section", {}, h("h3", {}, "Prices"), basis, h("p", { class: "muted small" }, "Touch: the ask to buy, the bid to sell. Missing quotes fall back to LTP.")),
        h("section", {}, h("h3", {}, "Charges"), sw("Figures after charges", () => cfg().net, (v) => setCfg({ net: v }), `Brokerage, STT and fees (rates as of ${refCharges(st.ref).asOf})`)),
        h("section", {}, h("h3", {}, "Placing"), h("div", { class: "pop-segs" }, h("span", { class: "muted small" }, "Product"), prod, h("span", { class: "muted small" }, "Wait for each hedge"), wait)),
      );
    };
    const popEl = h(
      "div",
      { class: "popover customise", role: "dialog", "aria-label": "Customise the builder" },
      h("div", { class: "pop-head" }, h("strong", {}, "Customise"), h("button", { type: "button", class: "small plain reset", onclick: () => { st.scfg = O.strategyConfig({ group: cfg().group }); save(); drawAll(); draw(); } }, icon("refresh"), "Reset"), h("button", { type: "button", class: "icon-btn tiny", "aria-label": "Close", onclick: () => closePop() }, icon("close"))),
      body,
    );
    const outside = (e) => {
      if (!popEl.contains(e.target) && !gearBtn.contains(e.target) && !moreBtn.contains(e.target) && !e.target.closest?.(".menu-pop, #dialog")) closePop();
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
    const name = h("input", { type: "text", maxlength: "60", value: draftName(), "aria-label": "Name" });
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
              expiry: R?.front ?? x.c.expiry,
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
    if (!x || it.underlying !== x.c.underlying) return null;
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
    const today = ISO_IST(Date.now());
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
              const pl = it.legs.map((l) => ({ ...l, price: l.entry }));
              const net = O.netPremium(pl, x?.lot ?? 1);
              const since = expired ? null : sinceSaved(it);
              const gl = O.presetGlyph(pl, x?.lot ?? 1);
              const del = () => {
                writeSaves(readSaves().filter((s2) => s2.id !== it.id));
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
              const comparing = compareItem?.id === it.id;
              return h(
                "div",
                { class: `saved-row ${expired ? "expired" : ""}`.trim() },
                h("span", { class: "pc-glyph saved-glyph" }, gl ? glyphSvg(gl, { w: 48, hgt: 22 }) : null),
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
                  h("button", { type: "button", class: "small", disabled: expired, title: expired ? "This expiry has settled: the save is read-only" : undefined, onclick: () => (closeFn?.(), loadSaved(it, pricesSeg.value === "saved")) }, "Load"),
                  h("button", { type: "button", class: "small plain", "aria-pressed": String(comparing), disabled: !x || it.underlying !== x.c.underlying, title: "Draw its expiry curve over the chart", onclick: () => ((compareItem = comparing ? null : it), draw(), drawAnalysis()) }, comparing ? "Comparing" : "Compare"),
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
        return toast("That file is not JSON", { tone: "error" });
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
      return { ...rest, expiry: rest.expiry ?? it.expiry, ...(atSaved && isFigure(entry) ? { entry, entryTag: "saved" } : {}) };
    });
    undo = { key: key(), legs: structuredClone(legs()), label: `Loaded "${it.name}"` };
    st.baskets[it.underlying] = O.migrateLegs(ls, it.expiry);
    setName(it.name);
    wi.target = num(it.target);
    wi.ivShift = num(it.ivShift) ?? 0;
    ivSlider.value = String(wi.ivShift);
    animateNext = true;
    save();
    if (it.underlying !== key()) await switchTo(it.underlying, st.expiry);
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
  drawSuggestShell();

  return {
    panel,
    /** The desk's context for this tick (null while there is no chain); `stale` = the last refresh's error. */
    draw(xx0, { error = null, onRetry = null, stale = null, lastOk = null, live = true } = {}) {
      // A chain with no strikes is a loaded state, not a loading one: "--" figures and a plain reason.
      const noRows = Boolean(xx0) && !xx0.c?.rows?.length;
      const xx = noRows ? null : xx0;
      noChain = noRows ? `No strikes for ${xx0.c.underlying ?? st.underlying} ${expiryText(xx0.c.expiry ?? st.expiry)}.` : error ? "error" : null;
      const firstData = !x && Boolean(xx);
      if (x && xx && x.c.underlying !== xx.c.underlying) {
        chains.clear();
        compareItem = null;
        chipsSig = "";
      }
      x = xx;
      staleInfo = { error: stale, lastOk, live, onRetry: onRetry ?? staleInfo.onRetry };
      panel.classList.toggle("is-loading", !xx && !noRows && !error);
      const failed = !xx && !noRows && Boolean(error);
      analysis.classList.toggle("has-err", failed);
      errHost.hidden = !failed;
      if (failed) errHost.replaceChildren(errorState(error, { onRetry }));
      else if (errHost.firstChild) errHost.replaceChildren();
      if (!xx) {
        R = null;
        priced = [];
        drawHead();
        drawLegs();
        drawHero();
        drawWarnings();
        drawWhatIf();
        drawTable();
        drawRisk();
        drawBar();
        chart.empty({ text: noRows ? noChain : error ? "The chain is unavailable: retrying." : "Waiting for the chain" });
        return;
      }
      legs();
      syncChains();
      priced = price(xx);
      if (firstData) animateNext = true;
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
      const onChart = document.activeElement?.classList?.contains("payoff-svg");
      if (onChart && /^[123]$/.test(k)) return setCfg({ curves: Number(k) }), true;
      if (k === "a" || k === "A") return openPicker(), true;
      if (k === "[" || k === "]") return shift(k === "]" ? 1 : -1), true;
      if (k === "-" || k === "_") return resize(-1), true;
      if (k === "=" || k === "+") return resize(1), true;
      if (k === "g" || k === "G") return openSuggest(), true;
      if (k === "e" || k === "E") {
        const btn = focusLegId && legsEl.querySelector(`.leg-row[data-id="${CSS.escape(focusLegId)}"] .leg-exp`);
        if (btn && !btn.disabled) btn.click();
        return true;
      }
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
      buildRo?.disconnect();
      clearTimeout(pvTimer);
      cancelAnimationFrame(raf);
      sg.job += 1;
      chart.destroy();
      closePop();
      chargesPop?.close?.();
      picker?.close?.();
      picker = null;
      if (window.__mcbStrategyOverlay) delete window.__mcbStrategyOverlay;
    },
  };
}
