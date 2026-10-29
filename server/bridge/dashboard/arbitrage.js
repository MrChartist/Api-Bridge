// The Arbitrage scanner (#/arb, PRD 06): put-call parity per strike (conversions and reversals against the same-expiry
// future), box spreads as lending / borrowing rates, and the futures term (basis, carry, calendar, roll). Everything is
// priced at the touch (bid to sell, ask to buy), after every statutory charge and brokerage, and after the cost of
// money at the user's hurdle rate. desk.js owns the toolbar, the selected chain, futures quotes and the timer; this file
// owns the figures, the scanner, the detail pane / sheet, the order preview, risk notes and the chart slot. The maths
// is in options.js (pure, tested); numbers become text only through format.js.
import { alertBox, api, copyText, emptyState, h, icon, istTime, modal, optional, toast } from "./app.js";
import { DASH, formatCompact, formatFixed, formatInt, formatPercent, formatRupee, formatSigned, isFigure } from "./format.js";
import * as O from "./options.js";
import { segmented } from "./views.js";

const num = (v) => (isFigure(v) ? Number(v) : null);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MON = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
const MON = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", month: "short" });
const dayMon = (e) => (ISO_DAY.test(e ?? "") ? DAY_MON.format(new Date(`${e}T00:00:00Z`)) : String(e ?? ""));
const mon = (e) => (ISO_DAY.test(e ?? "") ? MON.format(new Date(`${e}T00:00:00Z`)) : String(e ?? ""));
const MQ_PHONE = "(max-width: 719px)";
const MQ_NARROW = "(max-width: 1099px)";
const media = (q) => (typeof matchMedia === "function" ? matchMedia(q).matches : false);
const EXTRA_EVERY_MS = 15_000;
const BOX_ROWS_MAX = 120;
const BOX_CARDS_MAX = 30;
const optFreeze = new Map(); // underlying -> option freeze quantity (all strikes share it)
const ungroup = (t) => (t === null || t === undefined ? t : String(t).replace(/(\d),(?=\d)/g, "$1"));

/** Signed rupees, whole: "+₹624", "-₹74", "₹0". */
export function rupeeSigned(v) {
  if (!isFigure(v)) return DASH;
  const abs = formatFixed(Math.abs(Number(v)), 0);
  if (Number(abs) === 0) return "₹0";
  return `${Number(v) > 0 ? "+" : "-"}₹${abs}`;
}
/** Rupees, whole, compact from 1 lakh up ("₹3.12L"). */
const money = (v) => (!isFigure(v) ? DASH : Math.abs(v) >= 1e5 ? `${v < 0 ? "-" : ""}₹${formatCompact(Math.abs(v))}` : formatRupee(v, 0));
const pct = (v, dp = 1) => (num(v) === null ? DASH : formatPercent(v * 100, dp));
const pts = (v, dp = 2) => (num(v) === null ? DASH : `${formatSigned(v, dp)} pts`);
const KIND_NAME = { conv: "Conversion", rev: "Reversal", lbox: "Long box", sbox: "Short box", cal: "Calendar", fut: "Futures basis" };
const dots = (n) => h("span", { class: "liq", role: "img", "aria-label": n ? `Liquidity ${n} of 5` : "No quote" }, n ? [1, 2, 3, 4, 5].map((i) => h("i", { class: i <= n ? "on" : "" })) : h("span", { class: "bad-ink" }, "No quote"));
const KEY_HINTS = [[["1", "2", "3"], "tabs"], [["J", "K"], "row"], [["↵"], "detail"], [["O"], "opportunities"], [["H"], "hold"], [["+", "−"], "lots"], [["C"], "copy legs"], [["G"], "ATM"], [["P"], "pause"], [["Esc"], "clear"]];
const RISK_NOTES = [
  ["Executable only if every leg fills", " at these prices; legs are separate orders (legging risk)."],
  ["Quotes can be stale.", " Edges older than the stale limit are hidden from Best. Liquid NIFTY parity gaps are usually closed by algos within seconds; most visible edges are on illiquid strikes or stale quotes."],
  ["Index options are European and cash-settled", " at the final settlement price: no early assignment, and an index conversion has no basis mismatch at expiry."],
  ["Futures are marked to market daily:", " a locked structure still needs cash for MTM on the future."],
  ["Exercise STT:", " long ITM options held to expiry pay 0.15% of intrinsic value. Choose Close to compare."],
  ["Expiry day:", " +2% ELM on short index options and no calendar-spread margin benefit. Annualised figures are hidden on expiry day."],
  ["A short box blocks margin close to its width", " in India; it is not cheap leverage."],
  ["Charges as of 1 Apr 2026", " (STT 0.15% options sell, 0.05% futures sell); editable in Costs & filters. Verify the current statutory rates."],
  ["Tax:", " F&O gains are business income in India; this page does not compute tax."],
];
const DEMO_NOTE = ["Demo prices:", " calls and puts use different volatility smiles, so parity breaks here are artificial."];

/**
 * @param {{ st: object, save: () => void, account: () => object|null, sendOrders: (bodies: object[]) => Promise<object>,
 *   openTicket: (o: object) => Promise<unknown>, selectExpiry: (e: string) => void, retry: () => void,
 *   demo: () => boolean, onPositions: () => void }} ctx
 */
export function arbPanels(ctx) {
  const { st, save } = ctx;
  const cfg = () => st.arb;
  let sel = null; // selected row key
  let detailKind = new Map(); // parity row key -> "conv" | "rev" (the user's pick in the detail)
  let last = null; // last model
  let destroyed = false;
  let closePop = null;
  let sheet = null; // { detail, close } while the phone sheet is open
  const depth = new Map(); // symbol -> { bid, ask } top quantities
  const extra = new Map(); // expiry -> { chain, at, error }
  let extraAt = 0;
  let extraLoading = false;
  let lastAnnounce = { id: "", at: 0 };
  let ratesMemo = { key: null, rates: O.CHARGE_RATES };
  const rates = () => {
    const key = JSON.stringify(cfg().rates);
    if (ratesMemo.key !== key) ratesMemo = { key, rates: O.ratesWith(cfg().rates) };
    return ratesMemo.rates;
  };
  const setCfg = (patch) => {
    st.arb = O.arbConfig({ ...cfg(), ...patch });
    save();
    syncHead();
    draw();
  };
  const phone = () => media(MQ_PHONE);
  const narrow = () => media(MQ_NARROW);

  // ── Figures strip (built once, patched) ──
  const TILES = [
    ["spot", "Spot", false],
    ["fut", "Future", false],
    ["fwd", "Implied forward", false],
    ["carry", "Carry", false],
    ["best", "Best conv / rev", true],
    ["box", "Best box", true],
  ];
  const tiles = new Map(
    TILES.map(([k, label, btn]) => {
      const el = h("div", { class: `desk-stat arb-t-${k} skel`, ...(btn ? { role: "button", tabindex: "0" } : { role: "group" }), "aria-label": label }, h("span", { class: "label" }, label), h("span", { class: "value" }, DASH), h("span", { class: "sub" }, " "));
      if (btn) {
        const go = () => tileGo(k);
        el.addEventListener("click", go);
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            go();
          }
        });
      }
      return [k, { el, label, value: el.children[1], sub: el.children[2], sig: "", target: null }];
    }),
  );
  function setTile(k, { value = DASH, sub = "", title = "", cls = "", target = null } = {}) {
    const t = tiles.get(k);
    t.target = target;
    const sig = JSON.stringify([value, sub, title, cls]);
    if (t.sig === sig) return;
    t.sig = sig;
    t.value.textContent = value;
    t.sub.textContent = sub || " ";
    t.el.title = title;
    t.el.setAttribute("aria-label", `${t.label}: ${value}${sub ? `, ${sub}` : ""}`);
    t.el.className = `desk-stat arb-t-${k}${cls ? ` ${cls}` : ""}`;
  }
  function tileGo(k) {
    const t = tiles.get(k);
    if (!t.target) return;
    const { tab, key } = t.target;
    if (tab === "boxes" && cfg().boxMode !== "lend") st.arb = O.arbConfig({ ...cfg(), boxMode: "lend" });
    if (cfg().tab !== tab) setCfg({ tab });
    select(key, { scroll: true });
  }
  const figuresEl = h("section", { class: "desk-panel arb-figures", "data-panel": "figures", "aria-label": "Arbitrage figures" }, h("div", { class: "desk-stats arb-tiles" }, [...tiles.values()].map((t) => t.el)));

  // ── Scanner head ──
  const tabSeg = segmented("Scanner", [["parity", "Parity"], ["boxes", "Boxes"], ["futures", "Futures"]], cfg().tab);
  tabSeg.classList.add("arb-tabs");
  tabSeg.addEventListener("change", () => tabSeg.value !== cfg().tab && setCfg({ tab: tabSeg.value }));
  const lotsOut = h("output", { class: "arb-lots-n", "aria-live": "polite" });
  const lotBtn = (d) => h("button", { type: "button", class: "icon-btn tiny arb-step", "aria-label": d < 0 ? "One lot fewer" : "One lot more", onclick: () => stepLots(d) }, d < 0 ? "−" : "+");
  const lotsEl = h("div", { class: "arb-lots", role: "group", "aria-label": "Lots" }, lotBtn(-1), h("span", { class: "arb-lots-box" }, lotsOut, h("small", {}, "lots")), lotBtn(1));
  const stepLots = (d) => setCfg({ lots: Math.max(1, Math.min(100, cfg().lots + d)) });
  const holdSeg = segmented("Hold", [["expiry", "Expiry"], ["close", "Close"]], cfg().hold);
  holdSeg.classList.add("arb-hold");
  holdSeg.title = "Hold to expiry (cash-settled, exercise STT) or close before expiry at today's spreads";
  holdSeg.addEventListener("change", () => holdSeg.value !== cfg().hold && setCfg({ hold: holdSeg.value }));
  const oppsInput = h("input", { type: "checkbox", role: "switch" });
  oppsInput.addEventListener("change", () => setCfg({ onlyOpps: oppsInput.checked }));
  const oppsEl = h("label", { class: "sw-row arb-opps", title: "Only rows that clear your minimum net, liquidity and freshness (O)" }, h("span", { class: "sw-text" }, "Opportunities only"), h("span", { class: "switch" }, oppsInput, h("i", { "aria-hidden": "true" })));
  const gearBtn = h("button", { type: "button", class: "small gear-btn arb-gear", "aria-haspopup": "dialog", "aria-expanded": "false", title: "Hurdle rate, brokerage, statutory rates, filters and columns" }, icon("sliders"), h("span", { class: "gear-label" }, "Costs & filters"));
  gearBtn.addEventListener("click", () => openSettings());
  const filtersBtn = h("button", { type: "button", class: "small arb-filters-btn", "aria-haspopup": "dialog" }, icon("sliders"), "Filters");
  filtersBtn.addEventListener("click", () => openSettings());
  const chips = h("span", { class: "arb-chips" });
  const headEl = h(
    "div",
    { class: "panel-head arb-head" },
    h("div", { class: "arb-head-l" }, tabSeg, chips),
    h("div", { class: "arb-head-r" }, lotsEl, holdSeg, oppsEl, gearBtn, filtersBtn),
  );
  function syncHead() {
    const c = cfg();
    if (tabSeg.value !== c.tab) tabSeg.value = c.tab;
    if (holdSeg.value !== c.hold) holdSeg.value = c.hold;
    oppsInput.checked = c.onlyOpps;
    lotsOut.textContent = formatInt(c.lots);
    filtersBtn.classList.toggle("on", c.onlyOpps || c.hold === "close");
    filtersBtn.lastChild.textContent = c.onlyOpps ? "Filters · on" : "Filters";
  }
  syncHead();

  // ── Scanner body: notes, the table (or phone cards), keys; the detail pane beside it ──
  const noteEl = h("div", { class: "arb-notes-inline" });
  const caption = h("caption", { class: "sr-only" });
  const thead = h("thead");
  const tbody = h("tbody");
  const tableEl = h("table", { class: "arb-table" }, caption, thead, tbody);
  const wrapEl = h("div", { class: "table-wrap arb-wrap" }, tableEl);
  const cardsEl = h("ul", { class: "arb-cards", role: "listbox", "aria-label": "Scanner results" });
  const emptyEl = h("div", { class: "arb-empty", hidden: true });
  const footEl = h("p", { class: "arb-foot" });
  const keysEl = h("div", { class: "desk-keys arb-keys" }, KEY_HINTS.map(([keys, label]) => h("span", { class: "kbd-pair" }, h("span", { class: "kbd-group" }, keys.map((k) => h("kbd", {}, k))), label)));
  const live = h("p", { class: "sr-only", "aria-live": "polite" });
  const mainEl = h("div", { class: "arb-main" }, noteEl, wrapEl, cardsEl, emptyEl, footEl, keysEl);
  const paneDetail = createDetail({ pane: true });
  const paneEl = h("aside", { class: "arb-pane", "aria-label": "Selected structure" }, paneDetail.el);
  const bodyEl = h("div", { class: "arb-body" }, mainEl, paneEl);
  const scanEl = h("section", { class: "desk-panel arb-scan", "data-panel": "scanner", "aria-label": "Arbitrage scanner" }, headEl, bodyEl, live);

  tbody.addEventListener("click", (e) => {
    const tr = e.target instanceof Element ? e.target.closest("tr[data-key]") : null;
    if (tr) select(tr.dataset.key, { open: false });
  });
  tbody.addEventListener("dblclick", (e) => {
    const tr = e.target instanceof Element ? e.target.closest("tr[data-key]") : null;
    if (tr) focusDetail();
  });
  cardsEl.addEventListener("click", (e) => {
    const li = e.target instanceof Element ? e.target.closest("li[data-key]") : null;
    if (li) select(li.dataset.key, { open: true });
  });
  cardsEl.addEventListener("keydown", (e) => {
    const li = e.target instanceof Element ? e.target.closest("li[data-key]") : null;
    if (li && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      e.stopPropagation();
      select(li.dataset.key, { open: true });
    }
  });
  thead.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest("button[data-sort]") : null;
    if (b) cycleSort(b.dataset.sort);
  });

  // ── Risk notes (collapsible, state kept) and the chart engine slot ──
  const notesList = h("ol", { class: "arb-note-list" });
  const notesSummary = h("summary", {});
  const notesDetails = h("details", { class: "arb-details" }, notesSummary, notesList);
  notesDetails.addEventListener("toggle", () => {
    if (notesDetails.open !== notesOpen()) {
      st.arb = O.arbConfig({ ...cfg(), notesOpen: notesDetails.open });
      save();
    }
    drawNotesSummary();
  });
  const notesOpen = () => (cfg().notesOpen ?? !phone());
  const notesEl = h("section", { class: "desk-panel arb-notes", "data-panel": "risk-notes", "aria-label": "Risk notes" }, notesDetails);
  function drawNotes() {
    const lines = [...RISK_NOTES, ...(ctx.demo() ? [DEMO_NOTE] : [])];
    notesList.replaceChildren(...lines.map(([b, t]) => h("li", {}, h("strong", {}, b), t)));
    notesDetails.open = notesOpen();
    drawNotesSummary();
  }
  function drawNotesSummary() {
    const n = notesList.children.length;
    notesSummary.replaceChildren(h("strong", {}, "Risk notes"), h("span", { class: "arb-sub" }, notesDetails.open ? `${formatInt(n)} notes` : `${formatInt(n)} risk notes · ${phone() ? "tap" : "click"} to read`));
  }
  drawNotes();
  const chartEl = h(
    "section",
    { class: "desk-panel arb-chart", "data-panel": "chart-slot", "aria-label": "Chart engine slot" },
    h(
      "div",
      { class: "arb-slot", role: "img", "aria-label": "Chart engine slot: implied forward and box rate by strike, and the futures term structure, will draw here" },
      h("span", { class: "arb-slot-kicker" }, "Chart engine slot"),
      h("span", {}, "Implied forward and box rate by strike, and the futures term structure, will draw here"),
    ),
  );

  // ── Model: everything the page shows, from the chain, futures quotes and settings ──
  function futQuote(inst) {
    if (!inst) return null;
    const q = st.quotes.get(inst.symbol);
    return { symbol: inst.symbol, expiry: inst.expiry, lotSize: inst.lotSize, tickSize: inst.tickSize, freezeQty: inst.freezeQty, bid: num(q?.bid), ask: num(q?.ask), ltp: num(q?.ltp), asOf: q?.freshness?.asOf ?? null, quoted: Boolean(q) };
  }
  function model() {
    const c = st.chain;
    if (!c) return null;
    const conf = cfg();
    const now = Date.now();
    const days = O.timeToExpiry(c.expiry, now).days;
    const hRate = conf.hurdle / 100;
    const R = rates();
    const profile = conf.profile;
    const inst = st.futures.find((f) => f.expiry === c.expiry) ?? null;
    const fut = futQuote(inst);
    const futError = Boolean(inst) && (!fut.quoted || st.quotesError);
    const fwd = O.impliedForward(c, { rate: hRate, days, window: 5 });
    const optRate = O.optionsImpliedRate(c, { days, window: 5 });
    const memo = new Map();
    const t0 = performance.now();
    const par = O.parityRows(c, { fut: inst ? fut : null, rate: hRate, days, lots: conf.lots, profile, hold: conf.hold, window: conf.window, rates: R, futMarginPct: conf.futMarginPct / 100, fwd, memo });
    const fresh = O.staleness({ chainAsOf: st.freshness?.asOf, futAsOf: fut?.asOf ?? null, now, maxAgeMs: conf.staleSec * 1000 });
    const stale = fresh.stale || Boolean(st.freshness?.stale);
    const boxArgs = { rate: hRate, days, lots: conf.lots, profile, hold: conf.hold, window: conf.window, maxSteps: conf.boxMaxSteps, rates: R, centre: fwd?.atm ?? null, settle: par.settle, memo };
    const lendBoxes = O.boxes(c, { ...boxArgs, mode: "lend" });
    const shownBoxes = conf.boxMode === "lend" ? lendBoxes : conf.tab === "boxes" ? O.boxes(c, { ...boxArgs, mode: "borrow" }) : [];
    const spot = num(c.underlyingLtp);
    const futs = st.futures.map((f) => futQuote(f));
    const chains = new Map([...extra].filter(([, v]) => v.chain).map(([e, v]) => [e, v.chain]));
    chains.set(c.expiry, c);
    const term = O.futuresTerm(spot, futs, { now, rate: hRate, profile, rates: R, chains });
    const twoCount = c.rows.filter((r) => O.twoSided(r.ce) && O.twoSided(r.pe)).length;
    const m = {
      c,
      days,
      expiryDay: days !== null && days < 1,
      hRate,
      inst,
      fut,
      futError,
      fwd,
      optRate,
      par,
      stale,
      fresh,
      lendBoxes,
      boxes: shownBoxes,
      term,
      spot,
      oneSidedMarket: twoCount < 2,
      noFuture: !inst,
      nearestFut: st.futures.find((f) => f.expiry >= c.expiry) ?? st.futures[0] ?? null,
      nowMs: now,
    };
    m.isOpp = {
      parity: (r) => Boolean(r.best) && !stale && r.best.net >= conf.minNet && r.liq >= conf.minLiq,
      box: (b) => !stale && !b.crossed && !m.expiryDay && b.vsHurdleBp !== null && b.vsHurdleBp >= conf.minBoxBp && b.liq >= conf.minLiq,
    };
    m.computeMs = performance.now() - t0;
    return m;
  }

  /** The structure a parity row stands for in the detail: the user's pick, else the better net. */
  const parityStruct = (r) => {
    const want = detailKind.get(r.key);
    return (want === "conv" ? r.conv : want === "rev" ? r.rev : null) ?? r.best;
  };

  // ── Items per tab (filtered, sorted) ──
  function items(m) {
    const conf = cfg();
    const tab = conf.tab;
    if (tab === "parity") {
      let rows = m.par.rows.map((r) => ({ key: r.key, type: "parity", r, opp: m.isOpp.parity(r), s: parityStruct(r) }));
      if (conf.onlyOpps) rows = rows.filter((x) => x.opp);
      const s = phone() && conf.onlyOpps ? { key: "best", dir: "desc" } : conf.sort.parity;
      const val = (x) => {
        const r = x.r;
        if (s.key === "dev") return r.dev === null ? null : Math.abs(r.dev);
        if (s.key === "conv") return r.conv?.net ?? null;
        if (s.key === "rev") return r.rev?.net ?? null;
        if (s.key === "annual") return bestAnnual(r)?.v ?? null;
        if (s.key === "best") return r.best?.net ?? null;
        return r.strike;
      };
      return sortBy(rows, val, s.dir);
    }
    if (tab === "boxes") {
      let list = m.boxes.map((b) => ({ key: b.key, type: "box", b, opp: m.isOpp.box(b), s: b }));
      if (conf.onlyOpps) list = list.filter((x) => x.opp);
      const s = conf.sort.boxes;
      const val = (x) => (s.key === "rate" ? x.b.rate : s.key === "locked" ? x.b.locked : s.key === "strikes" ? x.b.k1 * 1e6 + x.b.k2 : x.b.vsHurdleBp);
      return sortBy(list, val, s.dir);
    }
    const out = [];
    m.term.futures.forEach((f, i) => {
      out.push({ key: f.key, type: "fut", f, opp: false, s: futStruct(f, m) });
      const cal = m.term.calendars[i];
      if (cal) out.push({ key: cal.key, type: "cal", cal, opp: false, s: calStruct(cal, m) });
    });
    return out;
  }
  function sortBy(list, val, dir) {
    const k = dir === "desc" ? -1 : 1;
    return [...list].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x === null || x === undefined) return y === null || y === undefined ? 0 : 1;
      if (y === null || y === undefined) return -1;
      return (x - y) * k;
    });
  }
  const bestAnnual = (r) => {
    const c = r.conv?.annual ?? null;
    const v = r.rev?.annual ?? null;
    const opts = [["conv", c], ["rev", v]].filter(([, a]) => a !== null && a > 0);
    if (!opts.length) return null;
    const [k, a] = opts.sort((x, y) => y[1] - x[1])[0];
    return { k, v: a };
  };
  /** A futures row as a structure (no orders: the future alone is an ordinary ticket). */
  const futStruct = (f, m) => ({ kind: "fut", key: f.key, f, legs: [], U: f.lot * cfg().lots, lot: f.lot, lots: cfg().lots, m });
  /** A calendar as a structure: roll a long (sell the near at its bid, buy the far at its ask). */
  function calStruct(cal, m) {
    const near = m.term.futures.find((f) => f.expiry === cal.from);
    const far = m.term.futures.find((f) => f.expiry === cal.to);
    const N = cfg().lots;
    const U = cal.lot * N;
    const instOf = (e) => st.futures.find((x) => x.expiry === e) ?? {};
    const leg = (side, f) => ({ kind: "FUT", side, symbol: f?.symbol ?? null, price: side === "BUY" ? f?.ask : f?.bid, units: U, lots: N, quote: f ? { bid: f.bid, ask: f.ask } : null, tick: num(instOf(f?.expiry).tickSize) || 0.05, exchange: O.exchangeOfSymbol(f?.symbol), expiry: f?.expiry });
    const legs = near?.twoSided && far?.twoSided ? [leg("SELL", near), leg("BUY", far)] : [];
    return { kind: "cal", key: cal.key, cal, legs, U, lot: cal.lot, lots: N };
  }

  // ── Columns ──
  const cell = (main, sub = "", o = {}) => ({ main, sub, ...o });
  const quoteCell = (q) => {
    if (!q) return cell(DASH, "", { aria: "No quote" });
    const b = num(q.bid) > 0 ? formatFixed(q.bid, 2) : DASH;
    const a = num(q.ask) > 0 ? formatFixed(q.ask, 2) : DASH;
    return cell(`${b} · ${a}`, O.spreadPct(q) === null ? "" : formatPercent(O.spreadPct(q), 1), { aria: `${b} bid, ${a} ask, spread ${formatPercent(O.spreadPct(q), 1)}` });
  };
  const netCell = (s) => (s ? cell(rupeeSigned(s.net), `${formatSigned(s.grossPts, 2)} pts`, { cls: s.net < 0 ? "neg" : "pos", aria: `Net ${rupeeSigned(s.net)}, gross ${formatSigned(s.grossPts, 2)} points` }) : cell(DASH, "", { aria: "Not executable" }));
  const PARITY_COLS = {
    strike: { head: "Strike", sort: "strike", cls: "k-col", cell: (x, m) => cell(formatInt(x.r.strike), "", { strike: true, atm: x.r.atm, opp: x.opp, stale: m.stale && Boolean(x.r.best) }) },
    call: { head: "Call bid·ask", cell: (x) => quoteCell(x.r.ce) },
    put: { head: "Put bid·ask", cell: (x) => quoteCell(x.r.pe) },
    syn: { head: "Synthetic sell·buy", title: "SynB = K + (Ca − Pb)·g, SynS = K + (Cb − Pa)·g, carried at the hurdle", cell: (x) => (x.r.synSell === null ? cell(DASH, x.r.synMid === null ? "" : `mid ${formatFixed(x.r.synMid, 1)}`, { cls: "quiet" }) : cell(`${formatFixed(x.r.synSell, 1)} · ${formatFixed(x.r.synBuy, 1)}`, `mid ${formatFixed(x.r.synMid, 1)}`)) },
    dev: {
      head: "Dev",
      sort: "dev",
      title: "Synthetic mid minus the reference (future mid, or the implied forward). Calls rich: SynS > future ask. Puts rich: SynB < future bid",
      cell: (x, m) => {
        const r = x.r;
        if (r.dev === null) return cell(DASH);
        const tag = r.tag === "callsRich" ? "Calls rich" : r.tag === "putsRich" ? "Puts rich" : "";
        return cell(formatSigned(r.dev, 1), `${formatSigned(r.devBp, 0)} bp${tag ? ` · ${tag}` : ""}`, { cls: m.oneSidedMarket || r.oneSided ? "quiet" : tag ? "tagged" : "", title: m.oneSidedMarket || r.oneSided ? "Indicative (mid)" : tag ? `${tag}: outside the bid-ask band` : "Inside the spread" });
      },
    },
    conv: { head: "Conversion", sort: "conv", title: "Sell CE at bid, buy PE at ask, buy FUT at ask. Net ₹ for your lots after financing and all charges", cell: (x) => netCell(x.r.conv) },
    rev: { head: "Reversal", sort: "rev", title: "Buy CE at ask, sell PE at bid, sell FUT at bid. Net ₹ for your lots after financing and all charges", cell: (x) => netCell(x.r.rev) },
    annual: {
      head: "Net %/yr",
      sort: "annual",
      title: "Net after charges and financing at your hurdle, per year on capital: this is return over the hurdle",
      cell: (x, m) => {
        const a = m.expiryDay ? null : bestAnnual(x.r);
        return a ? cell(pct(a.v, 1), a.k) : cell(DASH, "", { cls: "quiet" });
      },
    },
    liq: { head: "Liq", title: "1-5 from spread and volume rank; the weaker option leg", cell: (x) => cell(null, "", { liq: x.r.liq }) },
    fwdK: { head: "Implied fwd at K", cell: (x) => cell(formatFixed(x.r.synMid, 1)) },
    ivpc: { head: "IV P−C", title: "PE IV minus CE IV (broker IVs)", cell: (x) => cell(formatSigned(x.r.ivDiff, 2)) },
    oi: { head: "OI C·P", cell: (x) => cell(`${formatCompact(x.r.oiC)} · ${formatCompact(x.r.oiP)}`) },
    gross: { head: "Gross pts", cell: (x) => cell(x.r.best ? formatSigned(x.r.best.grossPts, 2) : DASH, x.r.best ? KIND_NAME[x.r.best.kind] : "") },
    charges: { head: "Charges ₹", cell: (x) => cell(x.r.best ? formatRupee(x.r.best.chargesTotal, 0) : DASH, x.r.best ? `${formatFixed(x.r.best.chargesTotal / x.r.best.U, 2)} pts` : "") },
    capital: { head: "Capital ₹", cell: (x) => cell(x.r.best ? money(x.r.best.capital) : DASH, x.r.best ? "est." : "") },
  };
  const COMPACT_PARITY = ["strike", "dev", "conv", "rev", "annual", "liq"];
  const NEEDS_FUT = new Set(["conv", "rev", "annual", "gross", "charges", "capital"]);
  const BOX_COLS = {
    strikes: { head: "Strikes", sort: "strikes", cls: "k-col", cell: (x) => cell(`${formatInt(x.b.k1)} / ${formatInt(x.b.k2)}`, `${formatInt(x.b.width)} pts`, { strike: true, opp: x.opp, crossed: x.b.crossed }) },
    price: { head: () => (cfg().boxMode === "lend" ? "Debit" : "Credit"), cell: (x) => cell(formatFixed(x.b.price, 2), formatRupee(x.b.priceRs, 0)) },
    charges: { head: "Charges", title: "All-in for the hold mode", cell: (x) => cell(formatRupee(x.b.chargesTotal, 0), `${formatFixed(x.b.chargesTotal / x.b.U, 2)} pts`) },
    locked: { head: "Locked ₹", sort: "locked", title: "Lend: W·U − D·U − charges. Borrow: Cr·U − W·U − charges (the interest you pay)", cell: (x) => cell(rupeeSigned(x.b.locked), "", { cls: x.b.locked < 0 && cfg().boxMode === "lend" ? "neg" : "" }) },
    rate: { head: "Rate %/yr", sort: "rate", title: "Net of charges, simple ACT/365", cell: (x) => cell(pct(x.b.rate, 2), x.b.grossRate === null ? "" : `gross ${pct(x.b.grossRate, 2)}`) },
    vsHurdle: { head: "vs hurdle", sort: "vsHurdle", title: "Lend: rate − hurdle. Borrow: hurdle − rate (positive = cheaper than your hurdle)", cell: (x) => cell(x.b.vsHurdleBp === null ? DASH : `${formatSigned(x.b.vsHurdleBp, 0)} bp`, "", { cls: x.b.vsHurdleBp !== null && x.b.vsHurdleBp < 0 ? "neg" : "" }) },
    capital: { head: "Capital", title: "Lend: debit + charges. Borrow: SPAN plus exposure on a short box is close to its width; verify with your broker", cell: (x) => cell(money(x.b.capital), cfg().boxMode === "lend" ? "" : "≈ width") },
    liq: { head: "Liq", cell: (x) => cell(null, "", { liq: x.b.liq }) },
  };
  const COMPACT_BOX = ["strikes", "price", "rate", "vsHurdle", "capital", "liq"];
  const FUT_COLS = {
    expiry: { head: "Expiry", cls: "k-col", cell: (x, m) => cell(dayMon(x.f.expiry), `${x.f.days === null ? DASH : formatInt(Math.max(0, x.f.days))} d · Monthly`, { strike: true, cur: x.f.expiry === m.c.expiry }) },
    bidask: { head: "Bid · Ask", cell: (x) => cell(x.f.twoSided ? `${formatFixed(x.f.bid, 2)} · ${formatFixed(x.f.ask, 2)}` : DASH, x.f.spread === null ? "" : `spread ${formatFixed(x.f.spread, 2)}`) },
    basis: { head: "Basis", cell: (x) => cell(formatSigned(x.f.basis, 2), x.f.basisPct === null ? "" : formatPercent(x.f.basisPct, 2)) },
    carry: { head: "Carry %/yr", title: "(Fm/S − 1)·365/d against your hurdle", cell: (x) => cell(pct(x.f.carry, 2), x.f.carryVsBp === null ? "" : `${formatSigned(x.f.carryVsBp, 0)} bp`) },
    fwd: {
      head: "Options fwd",
      title: "The chain's implied forward for that expiry; Fut rich if its bid is above the ATM synthetic's sell, cheap if its ask is below the synthetic's buy",
      cell: (x) => (x.f.fwd ? cell(formatFixed(x.f.fwd.forward, 2), `${formatSigned(x.f.fwdGap, 2)} pts${x.f.fwdTag ? ` · Fut ${x.f.fwdTag}` : ""}`) : cell(DASH, !st.expiries.includes(x.f.expiry) ? "no options listed" : extra.get(x.f.expiry)?.loading ? "loading" : "", { cls: "quiet" })),
    },
    long: { head: "Cheaper long", cell: (x) => cheapCell(x.f.cheaper?.long) },
    short: { head: "Cheaper short", cell: (x) => cheapCell(x.f.cheaper?.short) },
  };
  const COMPACT_FUT = ["expiry", "basis", "carry", "fwd", "long", "short"];
  const cheapCell = (c) => (c ? cell(c.pick === "future" ? "Future" : "Synthetic", `by ${formatFixed(c.diffPts, 1)} pts · ${formatRupee(c.diffPerLot, 0)}/lot`) : cell(DASH, "", { cls: "quiet" }));

  function columns(m) {
    const tab = cfg().tab;
    const compact = narrow() && !phone();
    if (tab === "parity") {
      let ids = compact ? COMPACT_PARITY : cfg().cols;
      if (m.noFuture || m.futError || m.par.lotMismatch) ids = ids.filter((k) => !NEEDS_FUT.has(k));
      return ids.map((k) => ({ id: k, ...PARITY_COLS[k] }));
    }
    if (tab === "boxes") return (compact ? COMPACT_BOX : Object.keys(BOX_COLS)).map((k) => ({ id: k, ...BOX_COLS[k] }));
    return (compact ? COMPACT_FUT : Object.keys(FUT_COLS)).map((k) => ({ id: k, ...FUT_COLS[k] }));
  }

  // ── Table: built once per structure, patched per tick ──
  let tableSig = "";
  const rowEls = new Map(); // key -> { tr, tds: Map }
  function headText(c) {
    return typeof c.head === "function" ? c.head() : c.head;
  }
  function buildHead(cols) {
    const s = cfg().sort[cfg().tab];
    thead.replaceChildren(
      h(
        "tr",
        {},
        cols.map((c) => {
          const sorted = c.sort && s?.key === c.sort;
          const label = headText(c);
          return h(
            "th",
            { scope: "col", class: `${c.cls ?? ""} ${c.id === "strike" || c.id === "strikes" || c.id === "expiry" ? "" : "num"}`.trim() || undefined, title: c.title, "aria-sort": c.sort ? (sorted ? (s.dir === "asc" ? "ascending" : "descending") : "none") : undefined },
            c.sort ? h("button", { type: "button", class: "arb-sort", "data-sort": c.sort }, label, h("span", { class: "arb-sort-i", "aria-hidden": "true" }, sorted ? (s.dir === "asc" ? "▲" : "▼") : "")) : label,
          );
        }),
      ),
    );
  }
  function cycleSort(key) {
    const tab = cfg().tab;
    const def = O.ARB_DEFAULTS.sort[tab];
    const cur = cfg().sort[tab];
    let next;
    if (cur.key !== key) next = { key, dir: "desc" };
    else if (cur.dir === "desc") next = { key, dir: "asc" };
    else next = { ...def };
    setCfg({ sort: { ...cfg().sort, [tab]: next } });
  }
  function renderCell(td, v, col) {
    const sig = JSON.stringify(v);
    if (td.__sig === sig) return;
    td.__sig = sig;
    td.className = `${col.cls ?? ""} ${col.id === "strike" || col.id === "strikes" || col.id === "expiry" ? "" : "num"} ${v.cls ?? ""}`.trim();
    if (v.title) td.title = v.title;
    else td.removeAttribute("title");
    if (v.aria) td.setAttribute("aria-label", v.aria);
    else td.removeAttribute("aria-label");
    if (v.liq !== undefined) return td.replaceChildren(dots(v.liq));
    if (v.strike) {
      const tags = [];
      if (v.atm) tags.push(h("span", { class: "arb-tag atm", title: "Nearest the implied forward (not spot)" }, "ATM"));
      if (v.cur) tags.push(h("span", { class: "arb-tag atm", title: "The expiry selected in the toolbar" }, "Selected"));
      if (v.opp) tags.push(h("span", { class: "arb-tag edge", title: "Clears your filters" }, "Edge"));
      if (v.stale) tags.push(h("span", { class: "arb-tag stale", title: "Quotes are stale" }, "Stale"));
      if (v.crossed) tags.push(h("span", { class: "arb-tag bad", title: "Almost certainly a stale or bad quote" }, "Crossed quotes"));
      return td.replaceChildren(...[h("span", { class: "arb-k" }, h("strong", {}, v.main), v.sub ? h("small", {}, v.sub) : null), tags.length ? h("span", { class: "arb-tags" }, tags.slice(0, 2)) : null].filter(Boolean));
    }
    td.replaceChildren(h("span", { class: "two" }, h("strong", {}, v.main ?? DASH), h("small", {}, v.sub || " ")));
  }
  function calCells(cal, span) {
    const pair = (l, v, t) => h("span", { class: "arb-cal-f", title: t }, h("small", {}, l), v);
    return h(
      "td",
      { colspan: String(span), class: "arb-cal" },
      h(
        "span",
        { class: "arb-cal-in" },
        h("strong", { class: "arb-cal-l" }, `${mon(cal.from)} → ${mon(cal.to)}`),
        pair("Spread buy·sell far", cal.buyFar === null ? DASH : `${formatFixed(cal.buyFar, 2)} · ${formatFixed(cal.sellFar, 2)}`),
        pair("Fwd rate", pct(cal.fwdRate, 2), "(F2m/F1m − 1)·365/(d2 − d1)"),
        pair("Fair spread", cal.fair === null ? DASH : `${formatFixed(cal.fair, 2)} (${formatSigned(cal.vsFair, 1)} ${cal.tag ?? ""})`.trim(), "F1m·(e^(h·Δd/365) − 1) at your hurdle; mid spread minus fair"),
        pair("Roll long", cal.rollLong === null ? DASH : `${formatRupee(cal.rollLong, 0)}/lot`, "Sell near at its bid, buy far at its ask, plus charges. The spread is carry you pay or receive by holding the later contract: compare it with the fair spread"),
        pair("Roll short", cal.rollShort === null ? DASH : `${formatRupee(cal.rollShort, 0)}/lot`, "Buy near at its ask, sell far at its bid, plus charges"),
      ),
    );
  }
  function drawTable(m, list) {
    const cols = columns(m);
    const sig = JSON.stringify([cfg().tab, m.c.underlying, m.c.expiry, cfg().window, cols.map((c) => c.id), cfg().boxMode, cfg().sort[cfg().tab], m.noFuture]);
    if (sig !== tableSig) {
      tableSig = sig;
      buildHead(cols);
      tbody.replaceChildren();
      rowEls.clear();
    }
    caption.textContent = cfg().tab === "parity" ? `Put-call parity by strike, ${m.c.underlying} ${dayMon(m.c.expiry)}, ${m.noFuture ? "against the implied forward" : "against the future"}` : cfg().tab === "boxes" ? `Box spreads, ${cfg().boxMode === "lend" ? "lending" : "borrowing"} rates, ${m.c.underlying} ${dayMon(m.c.expiry)}` : `${m.c.underlying} futures term structure`;
    const keep = new Set(list.map((x) => x.key));
    for (const [k, r] of rowEls) {
      if (!keep.has(k)) {
        r.tr.remove();
        rowEls.delete(k);
      }
    }
    const frag = [];
    for (const x of list) {
      let r = rowEls.get(x.key);
      if (!r) {
        const tr = h("tr", { "data-key": x.key, tabindex: "-1" });
        r = { tr, tds: new Map(), cal: null };
        rowEls.set(x.key, r);
      }
      if (x.type === "cal") {
        const s = JSON.stringify(x.cal);
        if (r.cal !== s) {
          r.cal = s;
          r.tr.replaceChildren(calCells(x.cal, cols.length));
        }
      } else {
        for (const c of cols) {
          let td = r.tds.get(c.id);
          if (!td) {
            td = h("td");
            r.tds.set(c.id, td);
            r.tr.append(td);
          }
          renderCell(td, c.cell(x, m), c);
        }
      }
      const cls = ["arb-row", x.type === "cal" ? "cal-row" : "", x.opp ? "opp" : "", m.stale && x.type !== "fut" && x.type !== "cal" ? "stale" : "", x.key === selKey() ? "sel" : "", x.type === "parity" && x.r.atm ? "atm" : "", x.type === "fut" && x.f.expiry === m.c.expiry ? "cur" : ""].filter(Boolean).join(" ");
      if (r.tr.className !== cls) r.tr.className = cls;
      r.tr.setAttribute("aria-selected", String(x.key === selKey()));
      frag.push(r.tr);
    }
    // Reorder the existing nodes only when the order changed.
    const cur = [...tbody.children];
    if (cur.length !== frag.length || cur.some((el, i) => el !== frag[i])) tbody.append(...frag);
  }

  // ── Phone cards ──
  const cardEls = new Map();
  let cardSig = "";
  function cardOf(x, m) {
    if (x.type === "parity") {
      const r = x.r;
      const s = r.best;
      const a = m.expiryDay ? null : bestAnnual(r);
      return {
        l1: `${formatInt(r.strike)}${s ? ` · ${KIND_NAME[s.kind]}` : ""}`,
        r1: s ? rupeeSigned(s.net) : r.dev === null ? DASH : `${formatSigned(r.dev, 1)} pts`,
        r1cls: s && s.net < 0 ? "neg" : "",
        l2: `Syn ${formatFixed(r.synMid, 1)} · Dev ${formatSigned(r.dev, 1)}${r.tag ? ` · ${r.tag === "callsRich" ? "Calls rich" : "Puts rich"}` : ""}`,
        r2: s ? (a ? `${pct(a.v, 1)}/yr` : DASH) : m.noFuture ? "vs implied fwd" : DASH,
        liq: r.liq,
        tags: [r.atm ? "ATM" : null, x.opp ? "Edge" : null, m.stale && s ? "Stale" : null].filter(Boolean),
      };
    }
    if (x.type === "box") {
      const b = x.b;
      return {
        l1: `${formatInt(b.k1)} / ${formatInt(b.k2)} · ${b.mode === "lend" ? "Lend" : "Borrow"}`,
        r1: pct(b.rate, 2),
        r1cls: b.vsHurdleBp !== null && b.vsHurdleBp < 0 ? "neg" : "",
        l2: `${b.mode === "lend" ? "Debit" : "Credit"} ${formatFixed(b.price, 2)} · ${money(b.capital)}`,
        r2: b.vsHurdleBp === null ? DASH : `${formatSigned(b.vsHurdleBp, 0)} bp vs hurdle`,
        liq: b.liq,
        tags: [x.opp ? "Edge" : null, b.crossed ? "Crossed quotes" : null].filter(Boolean),
      };
    }
    if (x.type === "fut") {
      const f = x.f;
      return { l1: `${dayMon(f.expiry)} · ${f.days === null ? DASH : formatInt(Math.max(0, f.days))} d`, r1: `${pct(f.carry, 2)}/yr`, r1cls: "", l2: `Basis ${formatSigned(f.basis, 2)}${f.fwdTag ? ` · Fut ${f.fwdTag}` : ""}`, r2: f.cheaper ? `Long via ${f.cheaper.long.pick}` : `${formatFixed(f.bid, 2)} · ${formatFixed(f.ask, 2)}`, liq: null, tags: f.expiry === m.c.expiry ? ["Selected"] : [] };
    }
    const c = x.cal;
    return { l1: `${mon(c.from)} → ${mon(c.to)}`, r1: `${pct(c.fwdRate, 2)}`, r1cls: "", l2: `Roll long ${c.rollLong === null ? DASH : formatRupee(c.rollLong, 0)}/lot`, r2: c.fair === null ? DASH : `fair ${formatFixed(c.fair, 1)} · ${c.tag ?? ""}`, liq: null, tags: [], cal: true };
  }
  function drawCards(m, list) {
    const sig = JSON.stringify([cfg().tab, m.c.underlying, m.c.expiry, cfg().boxMode]);
    if (sig !== cardSig) {
      cardSig = sig;
      cardsEl.replaceChildren();
      cardEls.clear();
    }
    const keep = new Set(list.map((x) => x.key));
    for (const [k, el] of cardEls) {
      if (!keep.has(k)) {
        el.remove();
        cardEls.delete(k);
      }
    }
    const order = [];
    for (const x of list) {
      let li = cardEls.get(x.key);
      if (!li) {
        li = h("li", { "data-key": x.key, role: "option", tabindex: "0" });
        cardEls.set(x.key, li);
      }
      const v = cardOf(x, m);
      const s = JSON.stringify(v);
      if (li.__sig !== s) {
        li.__sig = s;
        li.replaceChildren(
          h("span", { class: "arb-c1" }, h("strong", {}, v.l1, v.tags.map((t) => h("span", { class: `arb-tag ${t === "ATM" || t === "Selected" ? "atm" : t === "Edge" ? "edge" : t === "Stale" ? "stale" : "bad"}` }, t))), h("strong", { class: `arb-cv ${v.r1cls}` }, v.r1)),
          h("span", { class: "arb-c2" }, h("span", {}, v.l2, v.liq !== null ? [" · ", dots(v.liq)] : null), h("span", {}, v.r2)),
        );
      }
      const cls = ["arb-card", x.opp ? "opp" : "", m.stale && x.type === "parity" && x.r.best ? "stale" : "", v.cal ? "cal" : "", x.key === selKey() ? "sel" : ""].filter(Boolean).join(" ");
      if (li.className !== cls) li.className = cls;
      li.setAttribute("aria-selected", String(x.key === selKey()));
      order.push(li);
    }
    const cur = [...cardsEl.children];
    if (cur.length !== order.length || cur.some((el, i) => el !== order[i])) cardsEl.append(...order);
  }

  // ── Selection ──
  let list = [];
  const selKey = () => sel;
  const itemOf = (k) => list.find((x) => x.key === k) ?? null;
  function bestItem() {
    const opps = list.filter((x) => x.opp);
    if (cfg().tab === "parity") return [...list].filter((x) => x.r.best).sort((a, b) => b.r.best.net - a.r.best.net)[0] ?? list.find((x) => x.r.atm) ?? list[0] ?? null;
    if (cfg().tab === "boxes") return opps[0] ?? list.find((x) => !x.b.crossed) ?? list[0] ?? null;
    return list.find((x) => x.type === "fut" && x.f.expiry === last?.c.expiry) ?? list[0] ?? null;
  }
  function select(key, { open = false, scroll = false } = {}) {
    sel = key;
    draw();
    const r = rowEls.get(key);
    const card = cardEls.get(key);
    if (scroll) (phone() ? card : r?.tr)?.scrollIntoView?.({ block: "nearest" });
    if (phone() && open) openSheet();
    else if (!phone()) r?.tr.focus({ preventScroll: !scroll });
  }
  function moveSel(d) {
    if (!list.length) return;
    const i = list.findIndex((x) => x.key === sel);
    const j = Math.max(0, Math.min(list.length - 1, (i < 0 ? (d > 0 ? -1 : list.length) : i) + d));
    select(list[j].key, { scroll: true });
  }
  function focusDetail() {
    if (phone()) return openSheet();
    paneDetail.el.querySelector(".arb-d-title")?.focus();
  }

  // ── Detail (the pane on desktop / tablet, the bottom sheet on phones) ──
  function createDetail({ pane = false } = {}) {
    const title = h("h3", { class: "arb-d-title", tabindex: "-1" });
    const kindPill = h("span", { class: "arb-kind" });
    const kindSeg = h("div", { class: "arb-kind-seg" });
    const holdNote = h("p", { class: "arb-d-note" });
    const legsHost = h("div", { class: "arb-d-sec" });
    const lotsHost = h("div", { class: "arb-d-sec" });
    const wfHost = h("div", { class: "arb-d-sec" });
    const retHost = h("div", { class: "arb-d-sec" });
    const target = h("input", { type: "number", step: "0.05", min: "0", max: "100", inputmode: "decimal", class: "arb-target", "aria-label": "Target rate, percent a year" });
    const targetOut = h("output", { class: "arb-target-out" });
    const calcHost = h("div", { class: "arb-d-sec arb-calc", hidden: true }, h("h4", {}, "Target rate → limit"), h("label", { class: "arb-calc-row" }, h("span", {}, "Target rate %/yr"), target), targetOut, h("p", { class: "arb-d-fine" }, "Charges at today's quotes (approx.). Rounded to tick in the safe direction."));
    const payHost = h("p", { class: "arb-d-pay" });
    const flagsHost = h("ul", { class: "arb-flags" });
    const copyBtn = h("button", { type: "button", class: "small" }, icon("copy"), "Copy legs");
    const previewBtn = h("button", { type: "button", class: "small primary" }, "Preview orders");
    const ticketBtns = h("span", { class: "arb-d-tk" });
    const actions = h("div", { class: "arb-d-actions" }, copyBtn, ticketBtns, previewBtn);
    const msg = h("div", { class: "arb-d-msg" });
    const body = h("div", { class: "arb-d-body" }, holdNote, legsHost, lotsHost, wfHost, retHost, calcHost, payHost, flagsHost);
    const el = h("div", { class: `arb-detail${pane ? " in-pane" : ""}` }, h("div", { class: "arb-d-head" }, h("span", { class: "arb-d-eyebrow" }), title, h("div", { class: "arb-d-pills" }, kindPill, kindSeg)), msg, body, actions);
    const eyebrow = el.querySelector(".arb-d-eyebrow");
    let cur = null; // { item, s, m }
    let targetKey = null;
    const sigs = new Map();
    const put = (host, key, sig, build) => {
      if (sigs.get(key) === sig) return;
      sigs.set(key, sig);
      host.replaceChildren(...[build()].flat().filter(Boolean));
    };
    copyBtn.addEventListener("click", () => cur && copyLegs(cur.s));
    previewBtn.addEventListener("click", () => cur && openOrders(cur.s, cur.m));
    target.addEventListener("input", () => drawCalc());
    function drawCalc() {
      const s = cur?.s;
      if (!s || (s.kind !== "lbox" && s.kind !== "sbox")) return;
      const t = num(target.value);
      const L = O.boxLimit({ mode: s.mode, width: s.width, units: s.U, cin: s.cin, x: s.x, target: t === null ? null : t / 100, days: cur.m.days, tick: 0.05 });
      targetOut.textContent = L ? `${s.mode === "lend" ? "Max debit" : "Min credit"} ${formatFixed(L.limit, 2)} per unit` : cur.m.expiryDay ? "Not on expiry day" : DASH;
    }
    function update(item, m, { best = false } = {}) {
      if (!item || !m) {
        cur = null;
        el.classList.add("empty");
        eyebrow.textContent = "";
        title.textContent = m ? "Nothing to show" : "Loading…";
        kindPill.textContent = "";
        kindSeg.replaceChildren();
        msg.replaceChildren(m ? h("p", { class: "muted" }, "Pick a row to see its legs, costs and orders.") : "");
        body.hidden = true;
        actions.hidden = true;
        return;
      }
      el.classList.remove("empty");
      body.hidden = false;
      const s = item.s;
      cur = { item, s, m };
      const U = cfg().lots;
      eyebrow.textContent = best ? "Best on this tab" : "Selected";
      // Header
      if (item.type === "parity") {
        const r = item.r;
        title.textContent = `${s ? KIND_NAME[s.kind] : "Parity"} · ${m.c.underlying} ${dayMon(m.c.expiry)} ${formatInt(r.strike)} · ${formatInt(U)} lot${U === 1 ? "" : "s"}`;
        kindPill.textContent = r.conv && r.rev ? "" : s ? KIND_NAME[s.kind] : m.noFuture ? "No future" : "Not executable";
        const sigK = JSON.stringify([r.key, Boolean(r.conv), Boolean(r.rev), s?.kind]);
        if (kindSeg.__sig !== sigK) {
          kindSeg.__sig = sigK;
          if (r.conv && r.rev) {
            const seg = segmented("Structure", [["conv", "Conversion"], ["rev", "Reversal"]], s.kind);
            seg.addEventListener("change", () => {
              detailKind.set(r.key, seg.value);
              draw();
            });
            kindSeg.replaceChildren(seg);
          } else kindSeg.replaceChildren();
        }
      } else if (item.type === "box") {
        title.textContent = `${KIND_NAME[s.kind]} · ${m.c.underlying} ${dayMon(m.c.expiry)} ${formatInt(s.k1)} / ${formatInt(s.k2)} · ${formatInt(U)} lot${U === 1 ? "" : "s"}`;
        kindPill.textContent = s.mode === "lend" ? "Long box · lend" : "Short box · borrow";
        kindSeg.replaceChildren();
      } else if (item.type === "fut") {
        title.textContent = `Futures basis · ${m.c.underlying} ${dayMon(item.f.expiry)}`;
        kindPill.textContent = KIND_NAME.fut;
        kindSeg.replaceChildren();
      } else {
        title.textContent = `Calendar · ${m.c.underlying} ${mon(item.cal.from)} → ${mon(item.cal.to)} · ${formatInt(U)} lot${U === 1 ? "" : "s"}`;
        kindPill.textContent = KIND_NAME.cal;
        kindSeg.replaceChildren();
      }
      const structural = s && s.legs?.length;
      holdNote.textContent = item.type === "fut" || item.type === "cal" ? "Futures settle daily (MTM) and at the final settlement price." : cfg().hold === "close" ? "Closed before expiry at today's spreads" : "Held to expiry (cash-settled)";
      // Messages (no future, one-sided)
      const msgs = [];
      if (item.type === "parity" && !s) {
        if (m.noFuture) msgs.push(h("p", { class: "muted" }, "No listed future for this expiry: a deviation only, not executable as a futures arbitrage."));
        else if (m.futError) msgs.push(h("p", { class: "muted" }, "Futures quotes are unavailable: conversions and reversals need the future's bid and ask."));
        else if (m.par.lotMismatch) msgs.push(h("p", { class: "bad-ink" }, "The future's lot size differs from the options': conversions and reversals are off."));
        else msgs.push(h("p", { class: "muted" }, "A leg has no two-sided quote: nothing here is executable."));
        const r = item.r;
        msgs.push(kv([["Synthetic sell · buy", r.synSell === null ? DASH : `${formatFixed(r.synSell, 2)} · ${formatFixed(r.synBuy, 2)}`], ["Synthetic mid", formatFixed(r.synMid, 2)], ["Dev", r.dev === null ? DASH : `${formatSigned(r.dev, 2)} pts (${formatSigned(r.devBp, 0)} bp)`], ["Call bid · ask", quoteCell(r.ce).main], ["Put bid · ask", quoteCell(r.pe).main], ["IV P−C", formatSigned(r.ivDiff, 2)]]));
      }
      if (item.type === "fut") msgs.push(futDetail(item.f, m));
      put(msg, "msg", JSON.stringify([item.key, msgs.length ? msgs.map((x) => x.textContent) : []]), () => msgs);
      body.hidden = !structural;
      actions.hidden = !(structural || item.type === "fut");
      copyBtn.hidden = !structural;
      previewBtn.hidden = !structural;
      ticketBtns.replaceChildren();
      if (item.type === "fut" && item.f.symbol) {
        const f = item.f;
        const inst = st.futures.find((x) => x.expiry === f.expiry);
        const tk = (side) => ctx.openTicket({ kind: "FUT", side, symbol: f.symbol, quote: () => futQuote(inst), lotSize: f.lot, name: `${m.c.underlying} ${dayMon(f.expiry)} FUT`, tick: inst?.tickSize ?? 0.05, freezeQty: inst?.freezeQty ?? null, row: { strike: 0 }, right: "CE", product: "MARGIN", expiry: f.expiry });
        ticketBtns.append(h("button", { type: "button", class: "small", onclick: () => tk("BUY") }, "Buy future"), h("button", { type: "button", class: "small", onclick: () => tk("SELL") }, "Sell future"));
      }
      if (!structural) return;
      // Legs in send order, with depth and slices
      const legs = O.sendOrder(s.legs);
      const topQ = topQtyMap(s);
      put(legsHost, "legs", JSON.stringify([legs.map((l) => [l.symbol, l.side, l.price, l.units]), [...topQ], legs.map((l) => freezeOf(l))]), () => [
        h("h4", {}, "Legs ", h("small", {}, "in send order")),
        h(
          "table",
          { class: "arb-legs" },
          h("thead", {}, h("tr", {}, ["", "Contract", "Price", "Qty", "Top qty", "Slices"].map((t, i) => h("th", { scope: "col", class: i >= 2 ? "num" : undefined }, t)))),
          h(
            "tbody",
            {},
            legs.map((l) => {
              const sl = O.freezeSlices(l.units, freezeOf(l), s.lot).length;
              return h(
                "tr",
                {},
                h("td", {}, h("span", { class: `side-tag ${l.side === "BUY" ? "buy" : "sell"}`, "aria-label": l.side === "BUY" ? "Buy" : "Sell" }, l.side === "BUY" ? "B" : "S")),
                h("td", { title: legName(l, m) }, l.kind === "FUT" ? `FUT ${dayMon(l.expiry ?? m.c.expiry)}` : `${formatInt(l.strike)} ${l.right}`),
                h("td", { class: "num" }, formatFixed(l.price, 2)),
                h("td", { class: "num" }, formatInt(l.units)),
                h("td", { class: "num", title: num(topQ.get(l.symbol)) === null ? "Depth not available from this broker" : "Quantity at the touch" }, formatInt(topQ.get(l.symbol))),
                h("td", { class: "num" }, sl > 1 ? formatInt(sl) : ""),
              );
            }),
          ),
        ),
      ]);
      const maxLots = O.maxLotsAtTouch(s.legs, topQ, s.lot);
      put(lotsHost, "lots", JSON.stringify([maxLots, s.lots]), () => [
        h(
          "div",
          { class: "arb-kv" },
          h("span", {}, "Max lots at the touch"),
          h("strong", { title: maxLots === null ? "Depth not available from this broker" : "floor(min top-of-book qty ÷ lot)" }, maxLots === null ? DASH : formatInt(maxLots)),
        ),
        maxLots !== null && maxLots < s.lots ? h("p", { class: "warn-ink arb-d-fine" }, `Only ${formatInt(maxLots)} lot${maxLots === 1 ? "" : "s"} available at these prices; the rest fills worse`) : null,
      ]);
      // Waterfall / roll cost
      if (s.kind === "cal") {
        const c = s.cal;
        const charges = c.rollLong === null ? null : c.rollLong - c.buyFar * c.lot;
        put(wfHost, "wf", JSON.stringify([c.rollLong, s.lots]), () => [
          h("h4", {}, "Roll a long ", h("small", {}, "₹ per lot")),
          wfList([
            ["Spread paid (far ask − near bid)", c.buyFar === null ? null : c.buyFar * c.lot],
            ["Charges", charges],
          ], c.rollLong, "Roll cost"),
          h("p", { class: "arb-d-fine" }, `Fair spread at your hurdle ${formatFixed(c.fair, 2)} pts; mid spread ${formatFixed(c.midSpread, 2)} (${formatSigned(c.vsFair, 2)}${c.tag ? `, ${c.tag}` : ""}). Roll short ${formatRupee(c.rollShort, 0)}/lot.`),
        ]);
        retHost.replaceChildren();
        calcHost.hidden = true;
        payHost.textContent = "";
      } else {
        const w = O.waterfall(s);
        const settle = s.charges.settle;
        put(wfHost, "wf", JSON.stringify([w.lines.map((l) => l.value), w.net, settle]), () => [
          h("h4", {}, "Waterfall ", h("small", {}, `₹ for ${formatInt(s.U)} units`)),
          h(
            "dl",
            { class: "arb-wf" },
            w.lines.map((l, i) => [
              h("dt", {}, `${l.label}${l.key === "exStt" && settle !== null ? ` (est. at ${formatInt(settle)})` : ""}`),
              h("dd", { class: l.value > 0 && i > 0 ? "earn" : undefined }, rupeeSigned(l.value)),
            ]),
            h("dt", { class: "arb-wf-net" }, "= Net"),
            h("dd", { class: `arb-wf-net ${w.net < 0 ? "neg" : ""}`, "data-net": "" }, rupeeSigned(w.net)),
          ),
        ]);
        const isBox = s.kind === "lbox" || s.kind === "sbox";
        const annual = isBox ? s.rate : s.annual;
        const vs = isBox ? s.vsHurdleBp : annual === null ? null : annual * 1e4;
        put(retHost, "ret", JSON.stringify([s.breakEvenPts, s.capital, annual, vs, m.hRate, m.expiryDay]), () => [
          h("h4", {}, "Break-even and return"),
          kv([
            ["Break-even", `needs ${formatFixed(s.breakEvenPts, 2)} pts gross per unit`],
            ["Capital ≈", money(s.capital)],
            [isBox ? "Net rate %/yr" : "Net %/yr over hurdle", m.expiryDay ? "-- (expiry day)" : pct(annual, 2)],
            ["Hurdle", formatPercent(m.hRate * 100, 2)],
            [isBox ? "vs hurdle" : "Excess over hurdle", vs === null ? DASH : `${formatSigned(vs, 0)} bp`],
          ]),
          h("p", { class: "arb-d-fine" }, `Capital: ${s.capitalBasis}.${isBox ? "" : " Hedge benefit ignored (conservative)."}`),
        ]);
        calcHost.hidden = !isBox;
        if (isBox) {
          if (targetKey !== s.key) {
            targetKey = s.key;
            target.value = formatFixed(m.hRate * 100, 2);
          }
          drawCalc();
        }
        payHost.textContent = `Flat: ${rupeeSigned(w.net)} at every settlement price${cfg().hold === "close" ? " (if closed at today's spreads)" : ""}`;
      }
      // Flags
      const flags = O.arbFlags(s, flagCtx(m, s, topQ));
      put(flagsHost, "flags", JSON.stringify(flags), () => flags.map((f) => h("li", { class: f.sev }, h("span", { class: "dot", "aria-hidden": "true" }), f.text)));
    }
    return { el, update, focus: () => title.focus() };
  }
  const kv = (pairs) => h("dl", { class: "arb-kvs" }, pairs.map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
  const wfList = (pairs, total, label) => h("dl", { class: "arb-wf" }, pairs.map(([k, v]) => [h("dt", {}, k), h("dd", {}, v === null ? DASH : formatRupee(v, 0))]), h("dt", { class: "arb-wf-net" }, `= ${label}`), h("dd", { class: "arb-wf-net" }, total === null ? DASH : formatRupee(total, 0)));
  function legName(l, m) {
    if (l.kind === "FUT") return `${m.c.underlying} ${dayMon(l.expiry ?? m.c.expiry)} FUT`;
    return `${m.c.underlying} ${dayMon(m.c.expiry)} ${formatInt(l.strike)} ${l.right}`;
  }
  function futDetail(f, m) {
    const ch = f.cheaper;
    const ex = extra.get(f.expiry);
    return h(
      "div",
      {},
      kv([
        ["Bid · ask", f.twoSided ? `${formatFixed(f.bid, 2)} · ${formatFixed(f.ask, 2)}` : DASH],
        ["Basis", `${formatSigned(f.basis, 2)} pts (${formatPercent(f.basisPct, 2)})`],
        ["Carry", `${pct(f.carry, 2)}/yr (${f.carryVsBp === null ? DASH : `${formatSigned(f.carryVsBp, 0)} bp vs hurdle`})`],
        ["Options forward", f.fwd ? `${formatFixed(f.fwd.forward, 2)} (fut ${formatSigned(f.fwdGap, 2)} pts${f.fwdTag ? `, ${f.fwdTag}` : ""})` : DASH],
        ["Cheaper long", ch ? `${ch.long.pick === "future" ? "Future" : "Synthetic"} by ${formatFixed(ch.long.diffPts, 2)} pts · ${formatRupee(ch.long.diffPerLot, 0)}/lot` : DASH],
        ["Cheaper short", ch ? `${ch.short.pick === "future" ? "Future" : "Synthetic"} by ${formatFixed(ch.short.diffPts, 2)} pts · ${formatRupee(ch.short.diffPerLot, 0)}/lot` : DASH],
      ]),
      h("p", { class: "arb-d-fine" }, `Synthetic at the ATM-forward strike${ch ? ` ${formatInt(ch.strike)}` : ""}, after entry charges and exercise STT. ${f.expiry === m.c.expiry ? "This expiry's chain." : ex?.at ? `Options forward updated ${formatInt((Date.now() - ex.at) / 1000)} s ago.` : "Options forward loads every 15 s on this tab."} Cash-and-carry needs a tradable underlying (stock or ETF): LATER.`),
    );
  }
  function noFutureNote(m, short = false) {
    const monthly = m.nearestFut?.expiry;
    return h(
      "div",
      { class: "arb-callout" },
      h("p", {}, h("strong", {}, `No listed future for ${dayMon(m.c.expiry)}.`), short ? " Deviations are measured against the chain's implied forward; they are not a futures arbitrage." : " Deviations are relative to the chain's implied forward: they show which strikes are out of line, not a futures arbitrage. Pick a monthly expiry for conversions and reversals."),
      h(
        "div",
        { class: "arb-callout-btns" },
        monthly && st.expiries.includes(monthly) ? h("button", { type: "button", class: "small", onclick: () => ctx.selectExpiry(monthly) }, `Use ${dayMon(monthly)} (monthly)`) : null,
        cfg().tab === "parity" ? h("button", { type: "button", class: "small", onclick: () => setCfg({ tab: "boxes" }) }, "Boxes tab") : null,
      ),
    );
  }
  function flagCtx(m, s, topQ) {
    const freeze = new Map((s.legs ?? []).map((l) => [l.symbol, freezeOf(l)]));
    return { stale: m.stale, ageMs: m.fresh.ageMs, days: m.days, hold: cfg().hold, noFuture: m.noFuture, lotMismatch: m.par.lotMismatch && s.kind !== "lbox" && s.kind !== "sbox", topQty: topQ, freezeQty: freeze, nowMs: m.nowMs, demo: ctx.demo() };
  }
  function freezeOf(l) {
    if (l.kind === "FUT") return num(st.futures.find((f) => f.symbol === l.symbol)?.freezeQty);
    return num(optFreeze.get(st.underlying));
  }
  function topQtyMap(s) {
    const out = new Map();
    for (const l of s.legs ?? []) {
      const d = depth.get(l.symbol);
      out.set(l.symbol, d ? (l.side === "BUY" ? d.ask : d.bid) : null);
    }
    return out;
  }
  function copyLegs(s) {
    if (!s?.legs?.length) return toast("Nothing to copy for this row");
    const lines = O.sendOrder(s.legs).map((l) => `${l.side} ${l.symbol} ${formatInt(l.units)} @ ${formatFixed(l.price, 2)}`);
    const sum = s.kind === "cal" ? `${KIND_NAME.cal} roll long ${formatRupee(s.cal.rollLong, 0)}/lot` : `${KIND_NAME[s.kind]} net ${rupeeSigned(s.net)} after charges${s.kind === "lbox" || s.kind === "sbox" ? ` · ${pct(s.rate, 2)}/yr` : ""}`;
    copyText([...lines, sum].join("\n"), "Legs copied");
  }

  // ── Phone sheet ──
  function openSheet() {
    if (!last) return;
    const item = itemOf(sel) ?? bestItem();
    if (!item) return;
    sel = item.key;
    const d = createDetail();
    d.el.classList.add("in-sheet");
    const opener = cardEls.get(item.key) ?? null;
    sheet = { detail: d };
    d.update(item, last);
    modal({ title: "Structure", body: d.el, buttons: [] }).then(() => {
      sheet = null;
      if (opener?.isConnected) opener.focus();
    });
    d.focus();
  }

  // ── Order preview, then place (safety gates unchanged: every leg previewed, then POST /v1/orders) ──
  async function openOrders(s, m) {
    const a = ctx.account();
    if (!a) return toast("Choose an account that can place orders first.");
    if (!s?.legs?.length) return;
    // Freeze quantity for the option legs (one call per underlying), before slicing.
    await loadOptFreeze(s.legs.find((l) => l.kind !== "FUT")?.symbol);
    const legs = O.sendOrder(s.legs);
    const items = legs.flatMap((l) =>
      O.freezeSlices(l.units, freezeOf(l), s.lot).map((q, i, all) => ({ leg: l, qty: q, slice: i + 1, slices: all.length, price: O.roundToTick(l.price, l.tick || 0.05, l.side === "BUY" ? "buy" : "sell"), preview: null, status: "queued", error: null })),
    );
    const modeSeg = a.liveAllowedByConfig ? segmented("Mode", [["paper", "Paper"], ["live", "Live"]], "paper") : null;
    const ack = h("input", { type: "checkbox" });
    const ackRow = h("label", { class: "check live-ack", hidden: true }, ack, `I understand these are real orders to ${a.label}.`);
    const isLive = () => modeSeg?.value === "live";
    const body = (it, extraFields = {}) => ({ account: a.id, symbol: it.leg.symbol, side: it.leg.side, quantity: it.qty, product: "MARGIN", orderType: "LIMIT", price: it.price, ...(isLive() ? { mode: "live" } : {}), ...extraFields });
    const listHost = h("div", { class: "table-wrap arb-pv-wrap" });
    const blockHost = h("div", {});
    const resultHost = h("div", { class: "arb-pv-result", role: "status" });
    let phase = "confirm";
    let placeBtn = null;
    const STATUS = { queued: "Queued", sending: "Sending", sent: "Sent", failed: "Not sent", skipped: "Not sent" };
    function drawList() {
      listHost.replaceChildren(
        h(
          "table",
          { class: "desk-table arb-pv" },
          h("thead", {}, h("tr", {}, ["#", "Leg", "Qty", "Limit", "Checks"].map((t, i) => h("th", { scope: "col", class: i === 2 || i === 3 ? "num" : undefined }, t)))),
          h(
            "tbody",
            {},
            items.map((it, i) =>
              h(
                "tr",
                { class: `st-${it.status}` },
                h("td", { class: "num" }, formatInt(i + 1)),
                h("td", {}, h("span", { class: "pos-leg" }, h("span", { class: `side-tag ${it.leg.side === "BUY" ? "buy" : "sell"}` }, it.leg.side === "BUY" ? "B" : "S"), h("span", {}, h("strong", { title: legName(it.leg, m) }, it.leg.kind === "FUT" ? `FUT ${dayMon(it.leg.expiry ?? m.c.expiry)}` : `${formatInt(it.leg.strike)} ${it.leg.right}`), h("small", {}, it.slices > 1 ? `slice ${formatInt(it.slice)} of ${formatInt(it.slices)}` : it.leg.kind === "FUT" ? "future last" : i === 0 ? "least liquid first" : "option leg")))),
                h("td", { class: "num" }, formatInt(it.qty)),
                h("td", { class: "num" }, formatFixed(it.price, 2)),
                h(
                  "td",
                  {},
                  phase === "confirm"
                    ? it.preview
                      ? h("span", { class: `pv-dot ${it.preview.block ? "bad" : it.preview.warn ? "warn" : "ok"}`, "aria-label": it.preview.block ? `Blocked: ${it.preview.text}` : it.preview.text || "Checks passed", title: it.preview.text || "Checks passed" })
                      : h("span", { class: "pv-dot wait", "aria-label": "Checking" })
                    : h("span", { class: `st-chip ${it.status === "sent" ? "filled" : it.status === "failed" ? "rejected" : "queued"}` }, STATUS[it.status] ?? it.status),
                  it.preview?.block && phase === "confirm" ? h("small", { class: "block bad-text" }, "Blocked") : it.error ? h("small", { class: "block bad-text" }, ungroup(it.error)) : null,
                ),
              ),
            ),
          ),
        ),
      );
      const blocks = items.filter((it) => it.preview?.block);
      blockHost.replaceChildren(
        ...(blocks.length
          ? [
              h(
                "div",
                { class: "alert bad", role: "alert" },
                icon("warn"),
                h(
                  "div",
                  {},
                  h("strong", {}, "Nothing can be sent: a leg is blocked."),
                  h("span", { class: "detail" }, blocks.map((b) => `${legName(b.leg, m)}: ${b.preview.text}`).join(" · ")),
                  blocks.some((b) => /per-order limit/i.test(b.preview.text)) ? h("span", { class: "detail" }, "The per-order value limit is set on the Safety page. Sending the other legs alone would leave an unhedged position.") : null,
                ),
              ),
            ]
          : []),
      );
      drawPlace();
    }
    function drawPlace() {
      if (!placeBtn) return;
      const blocked = items.some((it) => it.preview?.block) || items.some((it) => !it.preview) || items.some((it) => !isFigure(it.price) || it.price <= 0);
      placeBtn.textContent = phase === "confirm" ? `Place ${formatInt(items.length)} order${items.length === 1 ? "" : "s"}${isLive() ? " · LIVE" : ""}` : "Done";
      placeBtn.className = isLive() ? "danger" : "primary";
      placeBtn.disabled = phase === "running" || (phase === "confirm" && (blocked || (isLive() && !ack.checked)));
    }
    async function previewAll() {
      let i = 0;
      const worker = async () => {
        while (i < items.length) {
          const it = items[i++];
          if (!it.leg.symbol || !isFigure(it.price)) {
            it.preview = { block: true, text: it.leg.symbol ? "No limit price" : "Contract not found" };
            continue;
          }
          const r = await optional(api("/v1/orders/preview", { method: "POST", body: body(it) }));
          if (r.error) it.preview = { block: true, text: ungroup(r.error.message) };
          else {
            const checks = r.data?.data?.checks ?? [];
            const b = checks.find((c) => c.severity === "block");
            const w = checks.find((c) => c.severity !== "block");
            it.preview = { block: Boolean(b), warn: Boolean(w), text: ungroup((b ?? w)?.message ?? "") };
          }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      if (phase === "confirm") drawList();
    }
    const modeRow = modeSeg ? h("div", { class: "field seg-field" }, h("span", {}, "Mode"), modeSeg) : h("p", { class: "arb-pv-mode" }, h("span", { class: "pill" }, "Paper"), ` ${a.label}`);
    modeSeg?.addEventListener("change", () => {
      ackRow.hidden = !isLive();
      for (const it of items) it.preview = null;
      drawList();
      previewAll();
    });
    ack.addEventListener("change", drawPlace);
    const warn = h("p", { class: "arb-pv-warn" }, icon("warn"), h("span", {}, "LIMIT orders at today's touch. Legs are separate orders, not an atomic spread. If a later leg does not fill, the earlier ones are an unhedged position."));
    const name = s.kind === "cal" ? `Calendar ${mon(s.cal.from)} → ${mon(s.cal.to)}` : s.kind === "lbox" || s.kind === "sbox" ? `${KIND_NAME[s.kind]} ${formatInt(s.k1)} / ${formatInt(s.k2)}` : `${KIND_NAME[s.kind]} ${formatInt(s.strike)}`;
    const done = modal({
      title: `Preview · ${name}`,
      body: h("div", { class: "stack arb-preview" }, modeRow, ackRow, warn, listHost, blockHost, resultHost),
      canClose: () => phase !== "running",
      buttons: [
        { label: "Cancel", cls: "plain", value: false },
        {
          label: "Place",
          cls: "primary",
          onClick: async () => {
            if (phase === "done") return "done";
            phase = "running";
            for (const it of items) it.status = "queued";
            drawList();
            const res = await ctx.sendOrders(items.map((it) => body(it)), {
              onStatus: (i, status, error) => {
                items[i].status = status;
                items[i].error = error ?? null;
                drawList();
              },
            });
            phase = "done";
            for (const [i, it] of items.entries()) if (it.status === "queued" && res.failed && i > res.failed.index) it.status = "skipped";
            drawList();
            if (res.failed) {
              const sent = items.filter((it) => it.status === "sent");
              resultHost.replaceChildren(
                h(
                  "div",
                  { class: "alert bad", role: "alert" },
                  icon("warn"),
                  h(
                    "div",
                    {},
                    h("strong", {}, `Stopped at order ${formatInt(res.failed.index + 1)}: ${ungroup(res.failed.error)}`),
                    sent.length ? h("span", { class: "detail" }, `Open risk: you are now ${sent.map((it) => `${it.leg.side === "BUY" ? "long" : "short"} ${legName(it.leg, m)} (${formatInt(it.qty)})`).join(", ")} without the hedge.`) : h("span", { class: "detail" }, "Nothing was sent."),
                  ),
                ),
                sent.length ? h("button", { type: "button", class: "small", onclick: () => ctx.onPositions() }, "Open Positions") : "",
              );
            } else {
              resultHost.replaceChildren(h("p", { class: "ok-ink" }, `${formatInt(items.length)} order${items.length === 1 ? "" : "s"} sent${isLive() ? " · LIVE" : " · paper"}. Check fills in Orders.`));
              toast(`${name}: ${formatInt(items.length)} orders sent`);
            }
            drawPlace();
            return false;
          },
        },
      ],
    });
    placeBtn = document.querySelector("#dialog .dialog-actions button:last-child");
    drawList();
    previewAll();
    await done;
  }
  async function loadOptFreeze(symbol) {
    if (!symbol || optFreeze.has(st.underlying)) return;
    const u = st.underlying;
    const r = await optional(api(`/v1/instruments/${encodeURIComponent(symbol)}`));
    const f = num(r.data?.data?.freezeQty);
    if (f !== null) optFreeze.set(u, f);
  }

  // ── Settings: the Costs & filters popover (a bottom sheet on phones) ──
  function settingsBody(render) {
    const c = cfg();
    const numField = (label, value, { step = "1", min, max, hint, onSet, wide = false }) => {
      const i = h("input", { type: "number", inputmode: "decimal", step, min, max, value: String(value), "aria-label": label });
      i.addEventListener("change", () => {
        const v = Number(i.value);
        if (i.value === "" || !Number.isFinite(v) || (min !== undefined && v < Number(min)) || (max !== undefined && v > Number(max))) return render();
        onSet(v);
        render();
      });
      return h("label", { class: `arb-field${wide ? " wide" : ""}` }, h("span", {}, label, hint ? h("small", {}, hint) : null), i);
    };
    const seg = (label, opts, value, onPick) => {
      const sg = segmented(label, opts, value);
      sg.addEventListener("change", () => {
        onPick(sg.value);
        render();
      });
      return sg;
    };
    const sw = (label, get, set, hint) => {
      const input = h("input", { type: "checkbox", role: "switch" });
      input.checked = get();
      input.addEventListener("change", () => {
        set(input.checked);
        render();
      });
      return h("label", { class: "sw-row" }, h("span", { class: "sw-text" }, label, hint ? h("small", {}, hint) : null), h("span", { class: "switch" }, input, h("i", { "aria-hidden": "true" })));
    };
    const p = c.profile;
    const setP = (patch) => setCfg({ profile: { ...cfg().profile, ...patch } });
    const model = O.BROKERAGE_MODELS.find((x) => x[0] === p.brokerage);
    const brokerSel = h("select", { "aria-label": "Brokerage model" }, O.BROKERAGE_MODELS.map(([id, label]) => h("option", { value: id, selected: id === p.brokerage }, label)));
    brokerSel.addEventListener("change", () => {
      setP({ brokerage: brokerSel.value });
      render();
    });
    const brokerFields = [];
    if (p.brokerage === "flat") brokerFields.push(numField("₹ per order", p.value, { step: "1", min: "0", onSet: (v) => setP({ value: v }) }), numField("Futures cap, % of turnover", formatFixed(p.futPct * 100, 3), { step: "0.005", min: "0", max: "5", onSet: (v) => setP({ futPct: v / 100 }) }));
    if (p.brokerage === "perLot") brokerFields.push(numField("₹ per lot", p.value, { step: "1", min: "0", onSet: (v) => setP({ value: v }) }));
    if (p.brokerage === "pct") brokerFields.push(numField("% of turnover", formatFixed(p.pct * 100, 3), { step: "0.005", min: "0", max: "5", onSet: (v) => setP({ pct: v / 100 }) }), numField("Cap, ₹ per order", p.cap, { step: "1", min: "0", onSet: (v) => setP({ cap: v }) }));
    const rateRows = O.RATE_FIELDS.map(([path, label, unit]) => {
      const cur = c.rates[path] ?? O.rateDefault(path);
      const changed = c.rates[path] !== undefined;
      return numField(`${label}${unit === "pct" ? ", %" : ""}`, unit === "pct" ? formatFixed(cur * 100, 5).replace(/0+$/, "").replace(/\.$/, "") : formatFixed(cur, 2), {
        step: "any",
        min: "0",
        hint: changed ? "edited" : undefined,
        onSet: (v) => setCfg({ rates: { ...cfg().rates, [path]: unit === "pct" ? v / 100 : v } }),
      });
    });
    const sections = [];
    if (phone()) {
      sections.push(
        h("section", {}, h("h3", {}, "Hold"), seg("Hold", [["expiry", "To expiry"], ["close", "Close before"]], c.hold, (v) => setCfg({ hold: v }))),
        h("section", {}, sw("Opportunities only", () => cfg().onlyOpps, (v) => setCfg({ onlyOpps: v }), "Rows that clear your minimum net, liquidity and freshness")),
      );
    }
    sections.push(
      h("section", {}, h("h3", {}, "Hurdle"), numField("Hurdle rate %/yr", formatFixed(c.hurdle, 2), { step: "0.05", min: "0", max: "50", hint: "Your cost of money or alternative yield: 91-day T-bill, FD or MIBOR. Simple ACT/365.", onSet: (v) => setCfg({ hurdle: v }), wide: true })),
      h(
        "section",
        {},
        h("h3", {}, "Brokerage"),
        h("label", { class: "arb-field wide" }, h("span", {}, "Model", h("small", {}, model?.[2] ?? "")), brokerSel),
        h("div", { class: "arb-fields" }, brokerFields),
        sw("Charge brokerage on exercise / assignment", () => cfg().profile.exerciseBrokerage, (v) => setP({ exerciseBrokerage: v }), "Conservative: one order's brokerage per option leg settled ITM"),
      ),
      h(
        "section",
        {},
        h(
          "details",
          { class: "arb-rates", open: Object.keys(c.rates).length > 0 },
          h("summary", {}, h("strong", {}, "Statutory rates"), h("small", {}, " · rates as of 1 Apr 2026; verify")),
          h("div", { class: "arb-fields" }, rateRows),
          h("button", { type: "button", class: "small plain reset", onclick: () => (setCfg({ rates: {} }), render()) }, icon("refresh"), "Reset to defaults"),
        ),
      ),
      h("section", {}, h("h3", {}, "Capital"), numField("Futures margin estimate %", formatFixed(c.futMarginPct, 1), { step: "0.5", min: "0", max: "100", hint: "Est.; hedge benefit ignored (conservative)", onSet: (v) => setCfg({ futMarginPct: v }), wide: true })),
      h(
        "section",
        {},
        h("h3", {}, "Filters"),
        h(
          "div",
          { class: "arb-fields" },
          numField("Minimum net ₹", formatInt(c.minNet), { step: "10", onSet: (v) => setCfg({ minNet: v }) }),
          numField("Minimum box vs hurdle, bp", formatInt(c.minBoxBp), { step: "5", onSet: (v) => setCfg({ minBoxBp: v }) }),
          numField("Minimum liquidity 0-5", formatInt(c.minLiq), { step: "1", min: "0", max: "5", onSet: (v) => setCfg({ minLiq: v }) }),
          numField("Box max width, strike steps", formatInt(c.boxMaxSteps), { step: "1", min: "1", max: "40", onSet: (v) => setCfg({ boxMaxSteps: v }) }),
        ),
        h("div", { class: "arb-seg-row" }, h("span", {}, "Stale after"), seg("Stale after", [["2", "2 s"], ["5", "5 s"], ["10", "10 s"], ["30", "30 s"]], String(c.staleSec), (v) => setCfg({ staleSec: Number(v) }))),
        h("div", { class: "arb-seg-row" }, h("span", {}, "Strikes ATM ±"), seg("Strikes ATM ±", [["5", "5"], ["10", "10"], ["20", "20"]], String(c.window), (v) => setCfg({ window: Number(v) }))),
      ),
    );
    if (!phone()) sections.push(h("section", {}, h("h3", {}, "Parity columns ", h("small", {}, narrow() ? "wide screens · drag or ↑ ↓ to reorder" : "drag or ↑ ↓ to reorder")), columnList(render)));
    return sections;
  }
  /** The parity column chooser: checkbox, drag handle and ↑/↓ (the chain Customise list pattern). */
  function columnList(render) {
    const on = cfg().cols;
    const off = O.ARB_PARITY_COLUMNS.map((c) => c[0]).filter((k) => !on.includes(k));
    const label = (k) => O.ARB_PARITY_COLUMNS.find((c) => c[0] === k)?.[1] ?? k;
    const locked = (k) => O.ARB_LOCKED_COLUMNS.includes(k);
    const move = (k, d) => {
      const a = [...on];
      const i = a.indexOf(k);
      const j = i + d;
      if (j < 1 || j >= a.length) return;
      [a[i], a[j]] = [a[j], a[i]];
      setCfg({ cols: a });
      render();
      document.querySelector(`.arb-pop [data-col="${k}"] [data-dir="${d}"]`)?.focus();
    };
    const row = (k, isOn) => {
      const box = h("input", { type: "checkbox", checked: isOn, disabled: locked(k) });
      box.addEventListener("change", () => {
        setCfg({ cols: isOn ? on.filter((x) => x !== k) : [...on, k] });
        render();
      });
      return h(
        "div",
        { class: `col-row ${isOn ? "on" : ""}`.trim(), draggable: isOn && k !== "strike" ? "true" : undefined, "data-col": k },
        isOn && k !== "strike" ? h("span", { class: "grip", "aria-hidden": "true" }, icon("grip")) : h("span", { class: "grip" }),
        h("label", { class: "col-check" }, box, h("span", {}, label(k), locked(k) ? h("small", { class: "col-scope" }, " always") : null)),
        isOn && k !== "strike"
          ? h(
              "span",
              { class: "col-move" },
              h("button", { type: "button", class: "icon-btn tiny", "data-dir": "-1", "aria-label": `Move ${label(k)} left`, disabled: on.indexOf(k) <= 1, onclick: () => move(k, -1) }, icon("up")),
              h("button", { type: "button", class: "icon-btn tiny", "data-dir": "1", "aria-label": `Move ${label(k)} right`, disabled: on.indexOf(k) === on.length - 1, onclick: () => move(k, 1) }, icon("down")),
            )
          : null,
      );
    };
    const listEl = h("div", { class: "col-list" }, on.map((k) => row(k, true)), off.map((k) => row(k, false)));
    let dragKey = null;
    listEl.addEventListener("dragstart", (e) => {
      const r = e.target.closest(".col-row.on");
      if (!r) return;
      dragKey = r.dataset.col;
      r.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", dragKey);
    });
    listEl.addEventListener("dragover", (e) => {
      if (!dragKey) return;
      e.preventDefault();
      const over = e.target.closest(".col-row.on");
      const from = listEl.querySelector(".dragging");
      if (!over || !from || over === from || over.dataset.col === "strike") return;
      const r = over.getBoundingClientRect();
      listEl.insertBefore(from, e.clientY > r.top + r.height / 2 ? over.nextSibling : over);
    });
    listEl.addEventListener("dragend", () => {
      if (!dragKey) return;
      dragKey = null;
      setCfg({ cols: [...listEl.querySelectorAll(".col-row.on")].map((r) => r.dataset.col) });
      render();
    });
    return h("div", {}, listEl, h("button", { type: "button", class: "small plain reset", onclick: () => (setCfg({ cols: [...O.ARB_DEFAULTS.cols] }), render()) }, icon("refresh"), "Reset columns"));
  }
  function openSettings() {
    if (closePop) return closePop();
    if (phone()) {
      const host = h("div", { class: "pop-body arb-pop arb-sheet-body" });
      const render = () => host.replaceChildren(...settingsBody(render));
      render();
      closePop = () => document.querySelector("#dialog .sheet-close")?.click();
      modal({ title: "Filters and costs", body: host, buttons: [{ label: "Done", cls: "primary", value: true }] }).then(() => {
        closePop = null;
        filtersBtn.focus();
      });
      return;
    }
    const bodyEl = h("div", { class: "pop-body" });
    const scrollKeep = () => bodyEl.scrollTop;
    const render = () => {
      const top = scrollKeep();
      bodyEl.replaceChildren(...settingsBody(render));
      bodyEl.scrollTop = top;
    };
    const close = (refocus = true) => {
      pop.remove();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", esc, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      closePop = null;
      gearBtn.setAttribute("aria-expanded", "false");
      if (refocus && gearBtn.isConnected) gearBtn.focus();
    };
    const outside = (e) => !pop.contains(e.target) && !gearBtn.contains(e.target) && close();
    const esc = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    const pop = h(
      "div",
      { class: "popover customise arb-pop vol-pop-float", role: "dialog", "aria-label": "Costs and filters" },
      h(
        "div",
        { class: "pop-head" },
        h("strong", {}, "Costs & filters"),
        h("button", { type: "button", class: "small plain reset", title: "Back to the default costs and filters (lots, tab and columns stay)", onclick: () => { st.arb = O.arbConfig({ tab: cfg().tab, lots: cfg().lots, hold: cfg().hold, onlyOpps: cfg().onlyOpps, boxMode: cfg().boxMode, sort: cfg().sort, cols: cfg().cols, notesOpen: cfg().notesOpen }); setCfg({}); render(); } }, icon("refresh"), "Reset"),
        h("button", { type: "button", class: "icon-btn tiny", "aria-label": "Close", onclick: () => close() }, icon("close")),
      ),
      bodyEl,
    );
    function place() {
      if (!gearBtn.isConnected) return close(false);
      const b = gearBtn.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const w = Math.min(380, vw - 32);
      pop.style.width = `${w}px`;
      pop.style.left = `${Math.round(Math.max(16, Math.min(b.right - w, vw - w - 16)))}px`;
      const below = vh - b.bottom - 22;
      const above = b.top - 22;
      if (below >= 360 || below >= above) {
        pop.style.top = `${Math.round(Math.max(16, b.bottom + 6))}px`;
        pop.style.bottom = "";
        pop.style.maxHeight = `${Math.round(Math.max(220, Math.min(720, below)))}px`;
      } else {
        pop.style.top = "";
        pop.style.bottom = `${Math.round(vh - b.top + 6)}px`;
        pop.style.maxHeight = `${Math.round(Math.min(720, above))}px`;
      }
    }
    closePop = () => close();
    render();
    gearBtn.setAttribute("aria-expanded", "true");
    document.body.append(pop);
    place();
    pop.querySelector("input, select, button")?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    setTimeout(() => {
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", esc, true);
    });
  }

  // ── Draw ──
  function drawFigures(m) {
    if (!m) {
      for (const k of tiles.keys()) {
        const t = tiles.get(k);
        t.el.classList.toggle("skel", !st.error);
        t.el.classList.toggle("dim", Boolean(st.error));
        if (st.error && st.lastOk) t.sub.textContent = `as of ${istTime(st.lastOk)}`;
      }
      return;
    }
    const S = m.spot;
    setTile("spot", { value: formatFixed(S, 2), sub: "Index · not tradable", title: "The index is not tradable: cash-and-carry needs a stock or ETF" });
    const fut = m.fut;
    if (m.noFuture) setTile("fut", { value: "No listed future", sub: m.nearestFut ? `Nearest: ${dayMon(m.nearestFut.expiry)}` : "", title: "Weekly expiries have no future. Conversions and reversals need a same-expiry future; pick a monthly expiry", cls: "muted-v" });
    else if (m.futError || !O.twoSided(fut)) setTile("fut", { value: DASH, sub: "Quote unavailable", title: "Could not load the future's bid and ask" });
    else setTile("fut", { value: `${formatFixed(fut.bid, 2)}\u2009–\u2009${formatFixed(fut.ask, 2)}`, sub: `${dayMon(fut.expiry)} · ${formatInt(m.days)} d · spread ${formatFixed(fut.ask - fut.bid, 2)}`, title: "Same-expiry future: bid – ask" });
    if (m.fwd) setTile("fwd", { value: formatFixed(m.fwd.forward, 2), sub: `band ${formatFixed(m.fwd.lo, 1)} – ${formatFixed(m.fwd.hi, 1)} · ${formatInt(m.fwd.n)} strikes`, title: "Median of K + (mid C − mid P)·e^(hT) over two-sided strikes near the money" });
    else setTile("fwd", { value: DASH, sub: "Parity unreadable (one-sided quotes)" });
    const hurdle = formatPercent(m.hRate * 100, 2);
    if (m.expiryDay) setTile("carry", { value: DASH, sub: `hurdle ${hurdle}`, title: "Annualised figures are not meaningful on expiry day" });
    else if (!m.noFuture && O.twoSided(fut) && S) {
      const carry = (((fut.bid + fut.ask) / 2 / S - 1) * 365) / m.days;
      setTile("carry", { value: `${formatPercent(carry * 100, 2)}/yr`, sub: `options ${pct(m.optRate, 2)} · hurdle ${hurdle}`, title: "Futures carry (Fm/S − 1)·365/d; options = the rate the box mids price in" });
    } else setTile("carry", { value: m.optRate === null ? DASH : `${formatPercent(m.optRate * 100, 2)}/yr`, sub: `from options · hurdle ${hurdle}`, title: "The rate the options price in (box mids), without a future" });
    // Best conversion / reversal
    if (m.noFuture || m.futError || m.par.lotMismatch) setTile("best", { value: DASH, sub: m.noFuture ? "Needs a same-expiry future" : m.par.lotMismatch ? "Lot sizes differ" : "Future quote unavailable" });
    else if (m.stale) setTile("best", { value: DASH, sub: "quotes stale", cls: "muted-v" });
    else {
      const elig = m.par.rows.filter((r) => r.best && r.liq >= cfg().minLiq).sort((a, b) => b.best.net - a.best.net);
      const b = elig[0];
      if (!b) setTile("best", { value: DASH, sub: "Nothing executable" });
      else {
        const s = b.best;
        const a = m.expiryDay ? null : s.annual;
        const pos = s.net > 0;
        setTile("best", { value: rupeeSigned(s.net), sub: `${pos ? "" : "Closest: "}${KIND_NAME[s.kind]} ${formatInt(b.strike)}${pos && a !== null ? ` · ${pct(a, 1)}/yr` : ""}`, cls: pos ? "" : "muted-v", target: { tab: "parity", key: b.key }, title: `Best net after charges and financing at ${formatInt(cfg().lots)} lot${cfg().lots === 1 ? "" : "s"}; liquidity ≥ ${formatInt(cfg().minLiq)}. Click to select` });
        announce(`best-${s.kind}-${b.strike}`, `Best ${KIND_NAME[s.kind].toLowerCase()} now ${formatInt(b.strike)}, ${s.net >= 0 ? "plus" : "minus"} ${formatRupee(Math.abs(s.net), 0)}`);
      }
    }
    if (m.stale) setTile("box", { value: DASH, sub: "quotes stale", cls: "muted-v" });
    else if (m.expiryDay) setTile("box", { value: DASH, sub: "Not on expiry day" });
    else {
      const b = m.lendBoxes.find((x) => !x.crossed && x.rate !== null && x.liq >= cfg().minLiq);
      if (!b) setTile("box", { value: DASH, sub: "No eligible box" });
      else setTile("box", { value: `${formatPercent(b.rate * 100, 2)}/yr`, sub: `Lend ${formatInt(b.k1)}/${formatInt(b.k2)} · ${formatSigned(b.vsHurdleBp, 0)} bp vs hurdle`, target: { tab: "boxes", key: b.key }, title: "Highest net long-box lending rate after charges. Click to select" });
    }
  }
  function announce(id, text) {
    const now = Date.now();
    if (id === lastAnnounce.id || now - lastAnnounce.at < 10_000) return;
    const first = !lastAnnounce.id;
    lastAnnounce = { id, at: now };
    if (!first) live.textContent = text;
  }
  function drawChips(m) {
    const out = [];
    if (m?.stale) out.push(h("span", { class: "arb-chip stale", title: "Quotes older than your stale limit, or chain and future far apart in time" }, `Stale · ${formatInt((m.fresh.ageMs ?? 0) / 1000)} s`));
    if (m?.expiryDay) out.push(h("span", { class: "expiry-chip", title: "+2% ELM on short options; annualised figures hidden" }, "Expiry day"));
    if (m && cfg().tab === "boxes") out.push(boxModeSeg());
    const sig = JSON.stringify([m?.stale, m ? formatInt((m.fresh.ageMs ?? 0) / 1000) : "", m?.expiryDay, cfg().tab, cfg().boxMode]);
    if (chips.__sig === sig) return;
    chips.__sig = sig;
    chips.replaceChildren(...out);
  }
  function boxModeSeg() {
    const seg = segmented("Box mode", [["lend", "Lend"], ["borrow", "Borrow"]], cfg().boxMode);
    seg.classList.add("arb-mode");
    seg.title = "Lend: long box (pay a debit, receive the width). Borrow: short box (receive a credit, owe the width)";
    seg.addEventListener("change", () => seg.value !== cfg().boxMode && setCfg({ boxMode: seg.value }));
    return seg;
  }
  function drawInline(m) {
    const notes = [];
    const tab = cfg().tab;
    if (tab === "parity" && m.noFuture) notes.push(noFutureNote(m));
    else if (tab === "parity" && m.futError) notes.push(h("p", { class: "arb-banner warn" }, "Could not load futures quotes: showing deviations against the implied forward."));
    if (m.oneSidedMarket) notes.push(h("p", { class: "arb-banner warn" }, "Quotes are one-sided (market closed?). Nothing is executable; figures show --. Mid-based Dev still shows, muted, as indicative."));
    if (tab === "boxes") notes.push(h("p", { class: "arb-banner info" }, cfg().boxMode === "lend" ? "Long box: pay the debit now, receive the width at expiry. Rate after charges, simple ACT/365." : "Short box: receive the credit now, owe the width at expiry. In India it blocks margin close to its width: not cheap leverage."));
    if (tab === "futures") notes.push(h("p", { class: "arb-banner info" }, `Every listed ${m.c.underlying} future; the toolbar expiry is highlighted. Options forwards for other expiries refresh every 15 s. Cash-and-carry needs a tradable underlying: LATER.`));
    const sig = JSON.stringify([tab, m.noFuture, m.futError, m.oneSidedMarket, cfg().boxMode, m.c.expiry, m.nearestFut?.expiry]);
    if (noteEl.__sig === sig) return;
    noteEl.__sig = sig;
    noteEl.replaceChildren(...notes);
  }
  function drawEmpty(m, shown) {
    const conf = cfg();
    if (shown.length || !conf.onlyOpps) {
      emptyEl.hidden = true;
      return;
    }
    emptyEl.hidden = false;
    const tab = conf.tab;
    let closest = null;
    if (tab === "parity") {
      const best = m.par.rows.filter((r) => r.best).sort((a, b) => b.best.net - a.best.net)[0];
      if (best) closest = `Closest: ${KIND_NAME[best.best.kind]} ${formatInt(best.strike)}, ${rupeeSigned(best.best.net)}${best.best.net < conf.minNet ? ` (needs ${formatFixed((conf.minNet - best.best.net) / best.best.U, 1)} pt more)` : m.stale ? " (quotes stale)" : best.liq < conf.minLiq ? " (liquidity too low)" : ""}`;
    } else if (tab === "boxes") {
      const b = m.boxes.find((x) => !x.crossed && x.vsHurdleBp !== null);
      if (b) closest = `Closest: ${formatInt(b.k1)}/${formatInt(b.k2)} at ${pct(b.rate, 2)}/yr, ${formatSigned(b.vsHurdleBp, 0)} bp vs hurdle`;
    }
    const text = tab === "boxes" ? `No box beats your hurdle by ${formatInt(conf.minBoxBp)} bp at ${formatInt(conf.lots)} lot${conf.lots === 1 ? "" : "s"}.` : `No structure clears ${formatRupee(conf.minNet, 0)} net after charges at ${formatInt(conf.lots)} lot${conf.lots === 1 ? "" : "s"}.`;
    const sig = JSON.stringify([text, closest]);
    if (emptyEl.__sig === sig) return;
    emptyEl.__sig = sig;
    emptyEl.replaceChildren(emptyState("scale", "Nothing clears your filters", text, h("div", { class: "arb-empty-x" }, closest ? h("p", { class: "arb-closest" }, closest) : null, h("button", { type: "button", class: "small", onclick: () => setCfg({ onlyOpps: false }) }, tab === "boxes" ? "Show all boxes" : "Show all strikes"))));
  }
  function shimmer() {
    if (phone()) {
      cardsEl.replaceChildren(...Array.from({ length: 8 }, () => h("li", { class: "arb-card shimmer", "aria-hidden": "true" }, h("span", { class: "sh" }), h("span", { class: "sh short" }))));
      cardSig = "";
      cardEls.clear();
    } else {
      thead.replaceChildren();
      tbody.replaceChildren(...Array.from({ length: 8 }, () => h("tr", { class: "shimmer", "aria-hidden": "true" }, h("td", {}, h("span", { class: "sh" })))));
      tableSig = "";
      rowEls.clear();
    }
  }
  let errorShown = false;
  function draw() {
    if (destroyed) return;
    syncHead();
    const isPhone = phone();
    scanEl.classList.toggle("is-phone", isPhone);
    wrapEl.hidden = isPhone;
    cardsEl.hidden = !isPhone;
    const t0 = performance.now();
    if (!st.chain) {
      last = null;
      list = [];
      drawFigures(null);
      drawChips(null);
      emptyEl.hidden = true;
      footEl.textContent = "";
      if (st.error) {
        errorShown = true;
        noteEl.__sig = "";
        noteEl.replaceChildren(h("div", { class: "desk-pad stack" }, alertBox(st.error), h("div", {}, h("button", { type: "button", class: "small", onclick: () => ctx.retry() }, icon("refresh"), "Retry"))));
        wrapEl.hidden = true;
        cardsEl.hidden = true;
      } else if (st.empty) {
        noteEl.__sig = "";
        noteEl.replaceChildren(emptyState("clock", "No expiries", st.empty));
        wrapEl.hidden = true;
        cardsEl.hidden = true;
      } else {
        noteEl.__sig = "";
        noteEl.replaceChildren();
        shimmer();
      }
      paneDetail.update(null, null);
      return;
    }
    if (errorShown) {
      errorShown = false;
      noteEl.__sig = "";
    }
    for (const t of tiles.values()) t.el.classList.remove("skel", "dim");
    const m = model();
    last = m;
    list = items(m);
    let shown = list;
    let capped = 0;
    const boxCap = isPhone ? BOX_CARDS_MAX : BOX_ROWS_MAX;
    if (cfg().tab === "boxes" && list.length > boxCap) {
      capped = list.length;
      shown = list.slice(0, boxCap);
      if (sel && !shown.some((x) => x.key === sel)) {
        const s = list.find((x) => x.key === sel);
        if (s) shown = [...shown, s];
      }
    }
    if (sel && !list.some((x) => x.key === sel)) sel = null;
    drawFigures(m);
    drawChips(m);
    drawInline(m);
    if (isPhone) drawCards(m, shown);
    else drawTable(m, shown);
    drawEmpty(m, shown);
    const conf = cfg();
    footEl.textContent =
      conf.tab === "parity"
        ? `${formatInt(shown.length)} strikes · ATM ±${formatInt(conf.window)} from the implied forward · ${conf.hold === "close" ? "closed before expiry" : "held to expiry"} · hurdle ${formatPercent(conf.hurdle, 2)}`
        : conf.tab === "boxes"
          ? `${capped ? `Best ${formatInt(boxCap)} of ${formatInt(capped)}` : formatInt(shown.length)} boxes · up to ${formatInt(conf.boxMaxSteps)} strike steps wide · hurdle ${formatPercent(conf.hurdle, 2)}`
          : `${formatInt(m.term.futures.length)} futures · roll ₹ per lot including charges`;
    // Detail: the selection, else the best of this tab (desktop / tablet pane); the open phone sheet follows the selection.
    const selItem = itemOf(sel);
    if (!isPhone) paneDetail.update(selItem ?? bestItem(), m, { best: !selItem });
    if (sheet) sheet.detail.update(selItem ?? bestItem(), m, { best: !selItem });
    st.patchMs = Math.round((performance.now() - t0) * 10) / 10;
    if (debug) console.debug(`arb tick: compute ${formatFixed(m.computeMs, 2)} ms, total ${formatFixed(performance.now() - t0, 2)} ms`);
  }
  const debug = (() => {
    try {
      return Boolean(localStorage.getItem("mcb.debug"));
    } catch {
      return false;
    }
  })();

  // ── Data this page adds per tick: depth for the visible detail's legs, other expiries' chains (Futures tab) ──
  async function tick() {
    if (destroyed) return;
    const jobs = [];
    const item = itemOf(sel) ?? (last ? bestItem() : null);
    const detailVisible = phone() ? Boolean(sheet) : true;
    if (detailVisible && item?.s?.legs?.length) {
      for (const l of item.s.legs.slice(0, 4)) {
        if (!l.symbol) continue;
        jobs.push(
          optional(api(`/v1/depth?symbol=${encodeURIComponent(l.symbol)}`)).then((r) => {
            const d = r.data?.data;
            if (d) depth.set(l.symbol, { bid: num(d.bids?.[0]?.qty), ask: num(d.asks?.[0]?.qty) });
          }),
        );
      }
      const opt = item.s.legs.find((l) => l.kind !== "FUT");
      if (opt) jobs.push(loadOptFreeze(opt.symbol));
    }
    if (cfg().tab === "futures" && !extraLoading && Date.now() - extraAt >= EXTRA_EVERY_MS) jobs.push(loadExtra());
    await Promise.all(jobs);
    if (jobs.length) draw();
  }
  async function loadExtra() {
    const u = st.underlying;
    const want = st.futures.filter((f) => f.expiry !== st.expiry && st.expiries.includes(f.expiry)).slice(0, 3);
    if (!want.length) return;
    extraLoading = true;
    for (const f of want) if (!extra.has(f.expiry)) extra.set(f.expiry, { chain: null, at: 0, loading: true });
    await Promise.all(
      want.map(async (f) => {
        const r = await optional(api(`/v1/optionchain?underlying=${encodeURIComponent(u)}&expiry=${encodeURIComponent(f.expiry)}&strikes=4&greeks=false`));
        if (u !== st.underlying) return;
        const prev = extra.get(f.expiry);
        extra.set(f.expiry, r.error ? { chain: prev?.chain ?? null, at: prev?.at ?? 0, error: r.error } : { chain: r.data?.data ?? null, at: Date.now() });
      }),
    );
    extraLoading = false;
    extraAt = Date.now();
  }

  // ── Keyboard (desk.js routes keys here while this page is on screen) ──
  function onKey(e) {
    const k = e.key;
    if (k === "1" || k === "2" || k === "3") return setCfg({ tab: ["parity", "boxes", "futures"][Number(k) - 1] }), true;
    if (k === "j" || k === "ArrowDown") return moveSel(1), true;
    if (k === "k" || k === "ArrowUp") return moveSel(-1), true;
    if (k === "Enter") {
      if (e.target instanceof Element && e.target.closest("button, a, summary, input, select")) return false;
      return focusDetail(), true;
    }
    if (k === "Escape") {
      if (closePop) return closePop(), true;
      if (sel === null) return false;
      sel = null;
      draw();
      return true;
    }
    if (k === "o") return setCfg({ onlyOpps: !cfg().onlyOpps }), true;
    if (k === "h") return setCfg({ hold: cfg().hold === "expiry" ? "close" : "expiry" }), true;
    if (k === "+" || k === "=") return stepLots(1), true;
    if (k === "-" || k === "_") return stepLots(-1), true;
    if (k === "c") {
      const item = itemOf(sel) ?? bestItem();
      return copyLegs(item?.s), true;
    }
    if (k === "g") {
      const atm = list.find((x) => x.type === "parity" && x.r.atm) ?? list.find((x) => x.type === "fut" && x.f.expiry === last?.c.expiry);
      if (atm) select(atm.key, { scroll: true });
      return true;
    }
    return false;
  }

  return {
    panels: [figuresEl, scanEl, notesEl, chartEl],
    root: scanEl,
    draw,
    tick,
    onKey,
    /** A new underlying or expiry: forget the selection, depth and (for an underlying) the other chains. */
    reset({ underlying = false } = {}) {
      sel = null;
      detailKind = new Map();
      depth.clear();
      tableSig = "";
      cardSig = "";
      lastAnnounce = { id: "", at: 0 };
      if (underlying) {
        extra.clear();
        extraAt = 0;
      }
    },
    destroy() {
      destroyed = true;
      closePop?.();
    },
  };
}
