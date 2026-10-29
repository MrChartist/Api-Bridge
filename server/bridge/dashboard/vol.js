// The Volatility page (#/vol): how expensive volatility is, where it is rich along strikes (smile, skew) and along time
// (term structure), and how big a move each expiry prices. desk.js owns the toolbar, the selected chain and the timer;
// this file owns the panels, the other expiries' chains, futures quotes and daily history. Every IV here is recomputed
// with Black-76 on the parity forward (options.js); the broker's IVs are not used.
import { alertBox, api, emptyState, h, icon, optional, toast } from "./app.js";
import { DASH, formatFixed, formatInt, formatPercent, formatRupee, formatSigned, isFigure } from "./format.js";
import * as O from "./options.js";
import { smileLabel, smileSvg, termSvg } from "./vol-curves.js";
import { segmented } from "./views.js";

const num = (v) => (isFigure(v) ? Number(v) : null);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MON = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
const IST_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
const WEEKDAY = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", weekday: "short" });
const weekday = (e) => (ISO_DAY.test(e ?? "") ? WEEKDAY.format(new Date(`${e}T00:00:00Z`)) : "");
const dayMon = (e) => (ISO_DAY.test(e ?? "") ? DAY_MON.format(new Date(`${e}T00:00:00Z`)) : String(e ?? ""));
const MQ_PHONE = "(max-width: 719px)";
const MQ_NARROW = "(max-width: 1099px)";
const MQ_COARSE = "(pointer: coarse)";
const media = (q) => (typeof matchMedia === "function" ? matchMedia(q).matches : false);
const TERM_STRIKES = 40; // strikes each side of ATM, at least
const TERM_STRIKES_MAX = 80;
const CONCURRENCY = 2;
const FUT_EVERY = 5;
const HISTORY_TTL = 30 * 60_000;
const BSE = new Set(["SENSEX", "BANKEX"]);
const indexSymbol = (u) => `${BSE.has(u) ? "BSE" : "NSE"}:${u}`;
const futSymbol = (u, e) => `${BSE.has(u) ? "BFO" : "NFO"}:${u}-${e}-FUT`;
const pts = (v) => (num(v) === null ? DASH : `${formatSigned(v, 1)} pts`);
const NARROW = "Chain too narrow for this delta";

// ── Settings (desk prefs → vol) ──

/**
 * The per-expiry table's columns: id, header, whether it is on by default, and the cell ({ t, s?, title? }) from a
 * TermRow (O.termRow) plus { fwd } (forward vol from the previous expiry). Pure (no DOM), so tests read it.
 */
export const VOL_TERM_COLUMNS = Object.freeze([
  { id: "dte", header: "DTE", def: true, cell: (r) => ({ t: formatFixed(r.days, r.days !== null && r.days < 3 ? 1 : 0), title: r.dim ? "Expiry day" : "Calendar days to 15:30 IST" }) },
  { id: "atmIv", header: "ATM IV", def: true, cell: (r) => ({ t: formatPercent(r.atmIv, 1), title: r.atmIv === null ? "No usable ATM quotes" : "Linear in strike at the forward" }) },
  { id: "straddle", header: "Straddle", def: true, cell: (r) => ({ t: formatFixed(r.straddle, 2), s: r.straddlePct === null ? "" : `${formatFixed(r.straddlePct, 2)}%` }) },
  { id: "move", header: "1σ move", def: true, cell: (r) => ({ t: r.move === null ? DASH : `±${formatInt(r.move)}`, s: r.movePct === null ? "" : `${formatFixed(r.movePct, 2)}%` }) },
  { id: "range", header: "1σ range", def: true, cell: (r) => ({ t: r.lo === null ? DASH : `${formatInt(r.lo)}–${formatInt(r.hi)}` }) },
  { id: "rr25", header: "25Δ RR (P−C)", def: true, cell: (r) => (r.rr25 === null ? { t: "n/a", title: NARROW } : { t: pts(r.rr25), title: "25-delta put IV minus 25-delta call IV" }) },
  { id: "bf25", header: "25Δ fly", def: true, cell: (r) => (r.bf25 === null ? { t: "n/a", title: NARROW } : { t: pts(r.bf25), title: "Mean of the 25-delta put and call IV, minus ATM IV" }) },
  { id: "fwdVol", header: "Fwd vol", def: true, cell: (r, c) => (c?.fwd?.inverted ? { t: "Inverted", title: "Total variance falls between these expiries: calendar check" } : { t: formatPercent(c?.fwd?.vol ?? null, 1), title: "Forward vol from the previous expiry" }) },
  { id: "perDay", header: "₹/lot a day", def: true, cell: (r) => ({ t: formatRupee(r.perDay, 0), title: r.lot ? "Straddle ₹ a lot ÷ days left (a theta proxy for comparing tenors)" : "Lot size not known" }) },
  { id: "atmStrike", header: "ATM", cell: (r) => ({ t: formatInt(r.atmStrike) }) },
  { id: "ceIv", header: "CE IV", cell: (r) => ({ t: formatPercent(r.ceIv, 1) }) },
  { id: "peIv", header: "PE IV", cell: (r) => ({ t: formatPercent(r.peIv, 1) }) },
  { id: "rupee", header: "Straddle ₹/lot", cell: (r) => ({ t: formatRupee(r.rupee, 0) }) },
  { id: "be", header: "Breakevens", cell: (r) => ({ t: r.beLo === null ? DASH : `${formatInt(r.beLo)}–${formatInt(r.beHi)}` }) },
  { id: "ratio", header: "Straddle ÷ 1σ", cell: (r) => ({ t: formatFixed(r.ratio, 2), title: "Log-normal theory gives about 0.80" }) },
  { id: "rr10", header: "10Δ RR", cell: (r) => (r.rr10 === null ? { t: "n/a", title: NARROW } : { t: pts(r.rr10) }) },
  { id: "fwd", header: "Forward", cell: (r) => ({ t: formatFixed(r.F, 1), s: r.basis === null ? "" : `basis ${formatSigned(r.basis, 1)}`, title: r.source === "spot" ? "F = spot (no two-sided ATM quotes)" : "Put-call parity forward" }) },
  { id: "carry", header: "Carry %/yr", cell: (r) => ({ t: formatFixed(r.carryPct, 2) }) },
  { id: "futGap", header: "Fut − F", cell: (r) => (r.futGap === null ? { t: DASH, title: "No future for this expiry" } : { t: formatSigned(r.futGap, 1) }) },
  {
    id: "hedge",
    header: "Put %",
    head: (cfg) => `Put ${formatInt(cfg.hedgePct)}%`,
    cell: (r) => (r.hedge ? { t: formatFixed(r.hedge.pts, 2), s: `${formatFixed(r.hedge.annualPct, 1)}% a yr`, title: `${formatInt(r.hedge.strike)} PE: ${formatFixed(r.hedge.pctF, r.hedge.pctF < 0.01 ? 3 : 2)}% of the forward` } : { t: "n/a", title: "Strike not in the loaded chain" }),
  },
]);
const COL_IDS = VOL_TERM_COLUMNS.map((c) => c.id);
const colOf = (id) => VOL_TERM_COLUMNS.find((c) => c.id === id);

export const VOL_DEFAULTS = Object.freeze({
  x: "strike",
  series: Object.freeze({ otm: true, ce: false, pe: false, wings: false }),
  range: "20",
  compare: "none",
  tab: "smile",
  cols: Object.freeze(VOL_TERM_COLUMNS.filter((c) => c.def).map((c) => c.id)),
  expiries: 6,
  hedgePct: 97,
  basis: "mid",
  rate: 6.5,
  bidAsk: false,
});

/** The Volatility page's saved settings, validated: bad values fall back to the defaults, unknown columns are dropped. */
export function volConfig(saved) {
  const d = VOL_DEFAULTS;
  const s = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  const pick = (v, list, def) => (list.includes(v) ? v : def);
  const ser = s.series && typeof s.series === "object" && !Array.isArray(s.series) ? s.series : {};
  const bool = (v, def) => (typeof v === "boolean" ? v : def);
  const cols = Array.isArray(s.cols) ? s.cols.filter((k, i, a) => COL_IDS.includes(k) && a.indexOf(k) === i) : [...d.cols];
  const rate = num(s.rate);
  return {
    x: pick(s.x, ["strike", "m", "delta"], d.x),
    series: { otm: bool(ser.otm, d.series.otm), ce: bool(ser.ce, d.series.ce), pe: bool(ser.pe, d.series.pe), wings: bool(ser.wings, d.series.wings) },
    range: pick(s.range, ["10", "20", "all"], d.range),
    compare: pick(s.compare, ["none", "next", "monthly"], d.compare),
    tab: pick(s.tab, ["smile", "term"], d.tab),
    cols: cols.length ? cols : [...d.cols],
    expiries: pick(s.expiries, [4, 6, 8, 12], d.expiries),
    hedgePct: pick(s.hedgePct, [95, 97, 99], d.hedgePct),
    basis: pick(s.basis, ["mid", "ltp"], d.basis),
    rate: rate !== null && rate >= 0 && rate <= 15 ? rate : d.rate,
    bidAsk: bool(s.bidAsk, d.bidAsk),
  };
}

const KEY_HINTS = [[["[", "]"], "expiry"], [["J", "K"], "strike"], [["G"], "ATM"], [["X"], "x-axis"], [["C"], "compare"], [["P"], "pause"], [["R"], "refresh"], [["Esc"], "clear"]];
const X_AXES = [["strike", "Strike"], ["m", "Mny %"], ["delta", "Delta"]];
const COMPARES = [["none", "Compare: none"], ["next", "Next expiry"], ["monthly", "Monthly"]];
const RANGES = [["10", "ATM ±10"], ["20", "ATM ±20"], ["all", "All loaded"]];
const historyCache = new Map(); // underlying -> { closes, at, error }

/**
 * @param {{ st: object, save: () => void, selectExpiry: (e: string) => void, refresh: () => void, retry: () => void }} o
 */
export function createVolPage({ st, save, selectExpiry, retry }) {
  const cfg = () => st.vol;
  const cache = new Map(); // expiry -> { chain, at, asOf, error, loading }
  const rowMemo = new WeakMap(); // chain -> { sig, row }
  const queue = [];
  let active = 0;
  let volSeq = 0;
  let destroyed = false;
  let closePop = null; // closes the open Customise popover
  let ticks = 0;
  let futQuotes = new Map();
  let hvMemo = { closes: null };
  let arbMemo = { chain: null };
  let hl = null; // highlighted strike (keyboard, tap)
  let hover = null; // hovered strike (mouse)
  let openDetail = null; // expiry whose detail row is open
  let drawTimer = 0;
  let last = null; // the last model drawn
  let atmScrolled = "";
  let liveAt = 0;
  let liveTimer = 0;
  const debug = (() => {
    try {
      return Boolean(localStorage.getItem("mcb.debug"));
    } catch {
      return false;
    }
  })();
  if (debug) window.__volDrawMs = [];
  const dev = () => ({ phone: media(MQ_PHONE), narrow: media(MQ_NARROW), coarse: media(MQ_COARSE) });

  // ── KPI strip (built once, patched) ──
  const TILES = [
    ["fwd", "Forward"],
    ["iv", "ATM IV"],
    ["move", "1σ move"],
    ["straddle", "Straddle"],
    ["rr", "25Δ RR (P−C)"],
    ["bf", "25Δ fly"],
    ["hv", "HV20"],
    ["rank", "IV rank"],
  ];
  const tiles = new Map(
    TILES.map(([k, label]) => {
      const el = h("div", { class: `desk-stat vol-t-${k}`, role: "group", "aria-label": label }, h("span", { class: "label" }, label), h("span", { class: "value" }, DASH), h("span", { class: "sub" }, " "));
      return [k, { el, value: el.children[1], sub: el.children[2], sig: "" }];
    }),
  );
  function setTile(k, { value = DASH, sub = "", title = "", aria = null, cls = "" } = {}) {
    const t = tiles.get(k);
    const sig = JSON.stringify([value, sub, title, aria, cls]);
    if (t.sig === sig) return;
    t.sig = sig;
    t.value.textContent = value;
    // Line breaks fall only between the "·" segments, never inside a figure or a range.
    if (sub && sub.includes(" · ")) t.sub.replaceChildren(...sub.split(" · ").flatMap((seg, i) => [i ? " · " : null, h("span", { class: "seg" }, seg)].filter(Boolean)));
    else t.sub.textContent = sub || " ";
    t.el.title = title;
    t.el.setAttribute("aria-label", aria ?? `${TILES.find((x) => x[0] === k)[1]}: ${value}`);
    t.el.className = `desk-stat vol-t-${k}${cls ? ` ${cls}` : ""}`;
  }
  const kpiEl = h("section", { class: "desk-panel vol-kpi", "data-panel": "vol-kpi", "aria-label": "Volatility summary" }, h("div", { class: "desk-stats vol-tiles" }, [...tiles.values()].map((t) => t.el)));

  // ── Curves: smile and term ──
  const xSeg = segmented("Smile x-axis", X_AXES, cfg().x);
  xSeg.classList.add("vol-x");
  xSeg.addEventListener("change", () => xSeg.value !== cfg().x && setCfg({ x: xSeg.value }));
  const seriesBox = (k, label) => {
    const i = h("input", { type: "checkbox", checked: cfg().series[k] });
    i.addEventListener("change", () => setCfg({ series: { ...cfg().series, [k]: i.checked } }));
    return h("label", { class: "vol-check" }, i, label);
  };
  const seriesMenu = h("details", { class: "vol-menu" }, h("summary", { class: "small", "aria-label": "Series to draw" }, "Series"), h("div", { class: "vol-menu-body" }, seriesBox("otm", "OTM composite (solid)"), seriesBox("ce", "CE IV (dashed)"), seriesBox("pe", "PE IV (dotted)")));
  // The menu closes on Escape and on a press anywhere outside it, as the other desk popovers do.
  const menuOutside = (e) => !seriesMenu.contains(e.target) && closeMenu();
  function closeMenu(refocus = false) {
    if (!seriesMenu.open) return false;
    seriesMenu.open = false;
    if (refocus) seriesMenu.querySelector("summary")?.focus();
    return true;
  }
  seriesMenu.addEventListener("toggle", () => {
    if (seriesMenu.open) document.addEventListener("pointerdown", menuOutside, true);
    else document.removeEventListener("pointerdown", menuOutside, true);
  });
  seriesMenu.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !seriesMenu.open) return;
    e.preventDefault();
    e.stopPropagation();
    closeMenu(true);
  });
  const rangeSel = h("select", { "aria-label": "Strikes shown", class: "vol-range" }, RANGES.map(([v, t]) => h("option", { value: v, selected: v === cfg().range }, t)));
  rangeSel.addEventListener("change", () => setCfg({ range: rangeSel.value }));
  const compareSel = h("select", { "aria-label": "Compare with", class: "vol-compare" }, COMPARES.map(([v, t]) => h("option", { value: v, selected: v === cfg().compare }, t)));
  compareSel.addEventListener("change", () => setCompare(compareSel.value));
  const tabSeg = segmented("Curve", [["smile", "Smile"], ["term", "Term"]], cfg().tab);
  tabSeg.classList.add("vol-tab");
  tabSeg.addEventListener("change", () => tabSeg.value !== cfg().tab && setCfg({ tab: tabSeg.value }));
  const wingsBtn = h("button", { type: "button", class: "small vol-wings", "aria-pressed": String(cfg().series.wings), title: "Add the 25-delta put and call IV per expiry" }, "25Δ P / C");
  wingsBtn.addEventListener("click", () => setCfg({ series: { ...cfg().series, wings: !cfg().series.wings } }));
  const smileTitle = h("span", { class: "vol-sub" });
  const readout = h("p", { class: "vol-readout" }, " ");
  const live = h("p", { class: "sr-only", "aria-live": "polite" });
  const smileBanner = h("div", { class: "vol-banners" });
  const smileHost = h("div", { class: "vol-plot smile-plot" });
  const shapeEl = h("span", { class: "vol-sub" });
  const termReadout = h("p", { class: "vol-readout" }, " ");
  const termHost = h("div", { class: "vol-plot term-plot" });
  const curvesMsg = h("div", { class: "vol-msg", hidden: true });
  const smileBox = h(
    "div",
    { class: "vol-curve vol-smile" },
    h("div", { class: "vol-curve-head" }, h("div", { class: "vol-title" }, h("strong", {}, "Smile"), smileTitle), h("div", { class: "vol-ctl" }, xSeg, seriesMenu, rangeSel, compareSel)),
    readout,
    smileBanner,
    smileHost,
  );
  const termBox = h("div", { class: "vol-curve vol-termc" }, h("div", { class: "vol-curve-head" }, h("div", { class: "vol-title" }, h("strong", {}, "Term structure"), shapeEl), h("div", { class: "vol-ctl" }, wingsBtn)), termReadout, termHost);
  const curvesEl = h(
    "section",
    { class: "desk-panel vol-curves", "data-panel": "vol-curves", "aria-label": "Smile and term structure" },
    h("div", { class: "vol-tabbar" }, tabSeg),
    curvesMsg,
    h("div", { class: "vol-curve-grid" }, smileBox, termBox),
    live,
  );

  // ── Per-expiry table ──
  const gearBtn = h("button", { type: "button", class: "small gear-btn", "aria-haspopup": "dialog", "aria-expanded": "false", title: "Columns, expiries, hedge put, prices and rate" }, icon("sliders"), h("span", { class: "gear-label" }, "Customise"));
  gearBtn.addEventListener("click", () => openCustomise());
  let termHint = null;
  const termHead = h("thead");
  const termBody = h("tbody");
  const termTable = h("table", { class: "vol-table vol-term-table" }, termHead, termBody);
  const termFoot = h("p", { class: "vol-foot" });
  const termEl = h(
    "section",
    { class: "desk-panel vol-term", "data-panel": "vol-term", "aria-label": "Expiries" },
    h("div", { class: "panel-head" }, h("div", { class: "vol-title" }, h("strong", {}, "Expiries"), (termHint = h("span", { class: "vol-sub" }, "Click a row to select it"))), gearBtn),
    h("div", { class: "table-wrap vol-term-wrap" }, termTable),
    termFoot,
  );
  termTable.addEventListener("click", onTermClick);
  termTable.addEventListener("keydown", onTermKey);

  // ── Strikes table ──
  const strikeSeg = segmented("Strike columns", [["otm", "OTM"], ["cepe", "CE/PE"]], "otm");
  strikeSeg.classList.add("vol-strike-seg");
  strikeSeg.addEventListener("change", () => {
    strikesEl.classList.toggle("show-cepe", strikeSeg.value === "cepe");
  });
  const bidAskBtn = h("button", { type: "button", class: "small vol-bidask", "aria-pressed": String(cfg().bidAsk), title: "Show the IV at the bid and at the ask" }, "Bid/ask IV");
  bidAskBtn.addEventListener("click", () => setCfg({ bidAsk: !cfg().bidAsk }));
  const strikesSub = h("span", { class: "vol-sub" });
  const strikesHead = h("thead");
  const strikesBody = h("tbody");
  const strikesTable = h("table", { class: "vol-table vol-strikes-table" }, strikesHead, strikesBody);
  const strikesWrap = h("div", { class: "vol-strikes-wrap" }, strikesTable);
  const keysEl = h("div", { class: "desk-keys vol-keys" }, KEY_HINTS.map(([keys, label]) => h("span", { class: "kbd-pair" }, h("span", { class: "kbd-group" }, keys.map((k) => h("kbd", {}, k))), label)));
  const strikesEl = h(
    "section",
    { class: "desk-panel vol-strikes", "data-panel": "vol-strikes", "aria-label": "IV by strike" },
    h("div", { class: "panel-head" }, h("div", { class: "vol-title" }, h("strong", {}, "Strikes"), strikesSub), h("div", { class: "vol-ctl" }, strikeSeg, bidAskBtn)),
    strikesWrap,
    keysEl,
  );
  strikesTable.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    const tr = e.target instanceof Element ? e.target.closest("tr[data-k]") : null;
    if (tr) setHover(Number(tr.dataset.k));
  });
  strikesTable.addEventListener("pointerleave", () => setHover(null));
  strikesTable.addEventListener("click", (e) => {
    const tr = e.target instanceof Element ? e.target.closest("tr[data-k]") : null;
    if (tr) setHl(Number(tr.dataset.k));
  });

  // ── Read + arbitrage ──
  const readBody = h("div", { class: "vol-personas" });
  const arbBody = h("div", { class: "vol-arb" });
  const readEl = h(
    "section",
    { class: "desk-panel vol-read", "data-panel": "vol-read", "aria-label": "Read and arbitrage checks" },
    h("div", { class: "vol-read-grid" }, h("div", { class: "vol-read-col" }, h("div", { class: "panel-head" }, h("div", { class: "vol-title" }, h("strong", {}, "Read"), h("span", { class: "vol-sub" }, "By trader type"))), readBody), h("div", { class: "vol-read-col" }, h("div", { class: "panel-head" }, h("div", { class: "vol-title" }, h("strong", {}, "Arbitrage checks"), h("span", { class: "vol-sub" }, "At bid/ask, this expiry"))), arbBody)),
  );

  // ── Chart engine slot (ATM IV and HV20 over time: the owner's engine plugs in here) ──
  const historyEl = h(
    "section",
    { class: "desk-panel vol-history", "data-panel": "vol-history", "aria-label": "ATM IV and HV20 over time" },
    h("div", { class: "panel-head" }, h("div", { class: "vol-title" }, h("strong", {}, "ATM IV and HV20 over time"), h("span", { class: "vol-sub" }, "Chart engine slot"))),
    h("div", { class: "vol-slot", role: "img", "aria-label": "Chart engine slot: ATM IV and HV20 over time" }, h("span", { class: "vol-slot-kicker" }, "Chart engine slot"), h("span", {}, "Will show the daily ATM IV of the front expiry against 20-day realised vol")),
  );

  // ── Methodology ──
  const methodAge = h("li", {});
  const methodSrc = h("li", {});
  const methodEl = h(
    "section",
    { class: "desk-panel vol-method", "data-panel": "vol-method", "aria-label": "Methodology" },
    h(
      "details",
      { class: "vol-details" },
      h("summary", {}, h("strong", {}, "Methodology and data quality")),
      h(
        "ul",
        { class: "vol-method-list" },
        h("li", {}, "Time: calendar days to 15:30 IST ÷ 365 (calendar-day vol), floored at 0.25 day for IV and delta."),
        h("li", { class: "vol-rate-line" }, ""),
        h("li", {}, "Forward: the median of K + (C − P)·e^(rT) over the 3 two-sided strikes nearest spot."),
        h("li", {}, "IV: Black-76 on that forward, from the bid–ask mid. LTP only when there is no two-sided quote (hollow points)."),
        h("li", {}, "Broker and server IVs are not used here, so figures can differ from the Option Chain's IV column."),
        h("li", {}, "ATM IV: linear in strike at the forward. Deltas: Black-76 forward deltas at each strike's own OTM IV."),
        h("li", {}, "Risk reversal sign: put minus call (Deribit and CME quote call minus put)."),
        h("li", {}, "HV: daily log returns of completed sessions, sample stdev, √252 (trading days, while IV uses calendar days)."),
        h("li", {}, "IV rank and IV percentile: unavailable. They need a stored daily ATM IV, which the Bridge does not record yet."),
        methodSrc,
        methodAge,
      ),
    ),
  );

  // ── Settings ──
  function setCfg(patch) {
    st.vol = volConfig({ ...cfg(), ...patch });
    save();
    syncControls();
    enqueueMissing();
    draw();
  }
  function setCompare(v) {
    if (v !== "none" && cfg().x === "strike") {
      toast("Compare uses moneyness");
      return setCfg({ compare: v, x: "m" });
    }
    setCfg({ compare: v });
  }
  function syncControls() {
    const c = cfg();
    if (xSeg.value !== c.x) xSeg.value = c.x;
    if (tabSeg.value !== c.tab) tabSeg.value = c.tab;
    rangeSel.value = c.range;
    compareSel.value = c.compare;
    wingsBtn.setAttribute("aria-pressed", String(c.series.wings));
    bidAskBtn.setAttribute("aria-pressed", String(c.bidAsk));
    for (const [k, i] of [["otm", 0], ["ce", 1], ["pe", 2]]) {
      const box = seriesMenu.querySelectorAll("input")[i];
      if (box && box.checked !== c.series[k]) box.checked = c.series[k];
    }
    curvesEl.classList.toggle("tab-term", c.tab === "term");
  }
  syncControls();

  function openCustomise() {
    if (closePop) return closePop();
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
    const body = h("div", { class: "pop-body" });
    const render = () => {
      const c = cfg();
      const on = c.cols;
      const off = COL_IDS.filter((k) => !on.includes(k));
      const move = (k, d) => {
        const a = [...on];
        const i = a.indexOf(k);
        const j = i + d;
        if (j < 0 || j >= a.length) return;
        [a[i], a[j]] = [a[j], a[i]];
        setCfg({ cols: a });
        render();
        body.querySelector(`[data-col="${k}"] [data-dir="${d}"]`)?.focus();
      };
      const row = (k, isOn) => {
        const col = colOf(k);
        const label = col.head ? col.head(c) : col.header;
        const box = h("input", { type: "checkbox", checked: isOn });
        box.addEventListener("change", () => {
          const next = isOn ? on.filter((x) => x !== k) : [...on, k];
          if (next.length) setCfg({ cols: next });
          render();
        });
        return h(
          "div",
          { class: `col-row ${isOn ? "on" : ""}`.trim(), "data-col": k },
          h("span", { class: "grip" }),
          h("label", { class: "col-check" }, box, h("span", {}, label)),
          isOn
            ? h(
                "span",
                { class: "col-move" },
                h("button", { type: "button", class: "icon-btn tiny", "data-dir": "-1", "aria-label": `Move ${label} left`, disabled: on.indexOf(k) === 0, onclick: () => move(k, -1) }, icon("up")),
                h("button", { type: "button", class: "icon-btn tiny", "data-dir": "1", "aria-label": `Move ${label} right`, disabled: on.indexOf(k) === on.length - 1, onclick: () => move(k, 1) }, icon("down")),
              )
            : null,
        );
      };
      const seg = (label, opts, value, onPick) => {
        const sg = segmented(label, opts, value);
        sg.addEventListener("change", () => onPick(sg.value));
        return sg;
      };
      const rate = h("input", { type: "number", min: "0", max: "15", step: "0.25", value: String(c.rate), inputmode: "decimal", "aria-label": "Rate, percent a year", class: "vol-rate" });
      rate.addEventListener("change", () => {
        const v = Number(rate.value);
        if (rate.value !== "" && Number.isFinite(v) && v >= 0 && v <= 15) setCfg({ rate: v });
        else rate.value = String(cfg().rate);
      });
      body.replaceChildren(
        h("section", {}, h("h3", {}, "Expiries loaded ", h("small", {}, "from the nearest")), seg("Expiries loaded", [[4, "4"], [6, "6"], [8, "8"], [12, "12"]].map(([v, t]) => [String(v), t]), String(c.expiries), (v) => setCfg({ expiries: Number(v) }))),
        h("section", {}, h("h3", {}, "Hedge put ", h("small", {}, "strike as % of the forward")), seg("Hedge put", [["95", "95%"], ["97", "97%"], ["99", "99%"]], String(c.hedgePct), (v) => setCfg({ hedgePct: Number(v) }))),
        h("section", {}, h("h3", {}, "Prices ", h("small", {}, "LTP to compare; mids are the default")), seg("Prices", [["mid", "Mid"], ["ltp", "LTP"]], c.basis, (v) => setCfg({ basis: v }))),
        h("section", {}, h("label", { class: "vol-rate-row" }, h("span", {}, "Rate ", h("small", {}, "% a year, for discounting and the forward")), rate)),
        h("section", {}, h("h3", {}, "Columns ", h("small", {}, "Expiry is always first · ↑ ↓ reorder")), h("div", { class: "col-list" }, on.map((k) => row(k, true)), off.map((k) => row(k, false)))),
      );
    };
    const pop = h(
      "div",
      { class: "popover customise vol-pop", role: "dialog", "aria-label": "Customise the Volatility page" },
      h(
        "div",
        { class: "pop-head" },
        h("strong", {}, "Customise"),
        h("button", { type: "button", class: "small plain reset", onclick: () => { st.vol = volConfig({ x: cfg().x, tab: cfg().tab, series: cfg().series, range: cfg().range, compare: cfg().compare, bidAsk: cfg().bidAsk }); setCfg({}); render(); } }, icon("refresh"), "Reset"),
        h("button", { type: "button", class: "icon-btn tiny", "aria-label": "Close", onclick: () => close() }, icon("close")),
      ),
      body,
    );
    // The popover floats over the page (the panel clips its children): fixed, beside the gear, kept on screen.
    // Phones get the shared bottom sheet from the CSS.
    function place() {
      if (!gearBtn.isConnected) return close(false);
      if (media(MQ_PHONE)) {
        for (const k of ["top", "bottom", "left", "maxHeight"]) pop.style[k] = "";
        return;
      }
      const b = gearBtn.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const w = Math.min(360, vw - 32);
      pop.style.left = `${Math.round(Math.max(16, Math.min(b.right - w, vw - w - 16)))}px`;
      const below = vh - b.bottom - 22;
      const above = b.top - 22;
      if (below >= 360 || below >= above) {
        pop.style.top = `${Math.round(Math.max(16, b.bottom + 6))}px`;
        pop.style.bottom = "";
        pop.style.maxHeight = `${Math.round(Math.max(200, Math.min(680, below)))}px`;
      } else {
        pop.style.top = "";
        pop.style.bottom = `${Math.round(vh - b.top + 6)}px`;
        pop.style.maxHeight = `${Math.round(Math.min(680, above))}px`;
      }
    }
    pop.classList.add("vol-pop-float");
    closePop = () => close();
    render();
    gearBtn.setAttribute("aria-expanded", "true");
    document.body.append(pop);
    place();
    pop.querySelector("button, input")?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    setTimeout(() => {
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", esc, true);
    });
  }

  // ── Data: the other expiries' chains, futures, history ──
  /** The expiries in the term table: the nearest N, plus the selected one when it is further out. */
  function termList() {
    const list = st.expiries.slice(0, cfg().expiries);
    if (st.expiry && st.expiries.includes(st.expiry) && !list.includes(st.expiry)) list.push(st.expiry);
    return list;
  }
  function enqueue(list) {
    if (destroyed) return;
    for (const e of list) {
      const ent = cache.get(e);
      if (queue.includes(e) || ent?.loading) continue;
      queue.push(e);
    }
    pump();
  }
  function pump() {
    while (!destroyed && active < CONCURRENCY && queue.length) {
      const e = queue.shift();
      active += 1;
      loadTerm(e).finally(() => {
        active -= 1;
        pump();
      });
    }
  }
  async function loadTerm(e) {
    const seq = volSeq;
    const u = st.underlying;
    const ent = cache.get(e) ?? { chain: null, at: 0, asOf: null, error: null, loading: false };
    ent.loading = true;
    cache.set(e, ent);
    requestDraw();
    try {
      const r = await api(`/v1/optionchain?underlying=${encodeURIComponent(u)}&expiry=${encodeURIComponent(e)}&strikes=${termStrikes(e)}&greeks=false`);
      if (seq !== volSeq) return;
      ent.chain = r.data.data;
      ent.asOf = r.data.data?.freshness?.asOf ?? r.data.meta?.freshness?.asOf ?? null;
      ent.error = null;
    } catch (err) {
      if (seq !== volSeq) return;
      ent.error = err;
    } finally {
      if (seq === volSeq) {
        ent.loading = false;
        ent.at = Date.now();
        requestDraw();
      }
    }
  }
  /**
   * Strikes each side of ATM for a term chain: enough to reach the 25-delta wings, sized from the expected move
   * (2.2·σ√T of the forward, at the nearest loaded expiry's ATM IV, else 20%), between 40 and 80.
   */
  function termStrikes(e) {
    const ref = selectedChain();
    const steps = (ref?.rows ?? []).map((r) => num(r.strike)).filter((k) => k !== null).sort((a, b) => a - b);
    let step = null;
    for (let i = 1; i < steps.length; i++) if (steps[i] > steps[i - 1] && (step === null || steps[i] - steps[i - 1] < step)) step = steps[i] - steps[i - 1];
    const F = num(ref?.underlyingLtp);
    const days = O.timeToExpiry(e).days;
    if (!step || !F || days === null) return TERM_STRIKES;
    let iv = null;
    for (const x of termList()) {
      const c = x === st.expiry ? ref : cache.get(x)?.chain;
      const row = c ? rowMemo.get(c)?.row : null;
      if (row?.atmIv) iv = row.atmIv;
      if (x === e) break;
    }
    const need = Math.ceil((2.2 * F * ((iv ?? 20) / 100) * Math.sqrt(days / 365)) / step);
    return Math.max(TERM_STRIKES, Math.min(TERM_STRIKES_MAX, need));
  }
  /** Load every term expiry not loaded yet (never the selected one: desk.js keeps that fresh). */
  function enqueueMissing() {
    if (!st.expiries.length) return;
    enqueue(termList().filter((e) => e !== st.expiry && !cache.has(e)));
  }
  async function loadFutures() {
    const u = st.underlying;
    const seq = volSeq;
    const syms = termList().map((e) => futSymbol(u, e));
    if (!syms.length) return;
    const r = await optional(api(`/v1/quotes?symbols=${encodeURIComponent(syms.join(","))}`));
    if (seq !== volSeq || r.error) return;
    const m = new Map();
    for (const q of r.data?.data ?? []) if (q?.symbol) m.set(q.symbol, q);
    futQuotes = m;
    requestDraw();
  }
  async function loadHistory() {
    const u = st.underlying;
    const have = historyCache.get(u);
    if (have && (have.loading || Date.now() - have.at < HISTORY_TTL)) return;
    historyCache.set(u, { closes: have?.closes ?? null, at: have?.at ?? 0, error: null, loading: true });
    const r = await optional(api(`/v1/history?symbol=${encodeURIComponent(indexSymbol(u))}&interval=1d&countback=300`));
    const candles = r.data?.data?.candles ?? [];
    // A final candle dated today (IST) is a session still trading: realised vol counts completed sessions only.
    const today = IST_DAY.format(new Date());
    const done = candles.filter((c, i) => !(i === candles.length - 1 && IST_DAY.format(new Date(Number(c.time) * 1000)) === today));
    historyCache.set(u, { closes: r.error ? null : done.map((c) => num(c.close)).filter((v) => v !== null), at: Date.now(), error: r.error ?? null, loading: false });
    requestDraw();
  }

  // ── The model of one draw ──
  function rowFor(chain) {
    const c = cfg();
    const fut = futQuotes.get(futSymbol(chain.underlying ?? st.underlying, chain.expiry)) ?? null;
    const futKey = fut ? `${fut.bid}|${fut.ask}|${fut.ltp}` : "";
    const monthly = O.isMonthly(chain.expiry, st.expiries);
    const sig = `${c.rate}|${c.basis}|${c.hedgePct}|${monthly}|${futKey}`;
    const hit = rowMemo.get(chain);
    if (hit && hit.sig === sig) return hit.row;
    const row = O.termRow(chain, { rate: c.rate / 100, basis: c.basis, hedgePct: c.hedgePct, monthly, fut });
    rowMemo.set(chain, { sig, row });
    return row;
  }
  function selectedChain() {
    const c = st.chain;
    return c && c.expiry === st.expiry && (c.underlying ?? st.underlying) === st.underlying ? c : null;
  }
  function model() {
    const chain = selectedChain();
    const sel = chain ? rowFor(chain) : null;
    const items = termList().map((e) => {
      if (e === st.expiry) return { e, row: sel, status: sel ? "ok" : st.error ? "error" : "loading", asOf: st.freshness?.asOf ?? null, sel: true };
      const ent = cache.get(e);
      if (ent?.chain) return { e, row: rowFor(ent.chain), status: "ok", asOf: ent.asOf, at: ent.at };
      return { e, row: null, status: ent?.error ? "error" : "loading" };
    });
    // Forward vol from the previous loaded, non-expiry-day row.
    let prev = null;
    for (const it of items) {
      if (!it.row) continue;
      it.fwd = prev ? O.forwardVol(prev, it.row) : null;
      if (!it.row.dim) prev = it.row;
    }
    const rows = items.filter((it) => it.row).map((it) => it.row);
    const shape = O.termShape(rows);
    const hist = historyCache.get(st.underlying);
    const closes = hist?.closes ?? null;
    if (closes && hvMemo.closes !== closes) hvMemo = { closes, hv20: O.realisedVol(closes, 20), hv10: O.realisedVol(closes, 10), hvp: O.hvPercentile(closes, 20, 252) };
    const { hv20, hv10, hvp } = closes ? hvMemo : { hv20: null, hv10: null, hvp: null };
    const T = sel ? Math.max(sel.years ?? 0, 0.25 / 365) : null;
    const df = T !== null ? Math.exp((-cfg().rate / 100) * T) : 1;
    const two = (leg) => ["mid", "wide"].includes(O.legPrice(leg).q);
    const twoSided = chain ? chain.rows.some((r) => two(r.ce) || two(r.pe)) : false;
    // The checks rerun only when a bid or ask (or the term IVs) changed, not on every new chain object.
    const quotes = chain ? chain.rows.map((x) => `${x.strike}:${x.ce?.bid},${x.ce?.ask},${x.pe?.bid},${x.pe?.ask}`).join(";") : "";
    const arbSig = `${cfg().rate}|${T === null ? "" : Math.round(T * 8760)}|${chain?.expiry}|${twoSided}|${rows.map((r) => `${r.expiry}:${r.atmIv === null ? "" : Math.round(r.atmIv * 100)}`).join()}|${quotes}`;
    if (arbSig !== arbMemo.sig) arbMemo = { chain, sig: arbSig, hits: chain && twoSided ? O.arbChecks(chain, { df, term: rows }) : null };
    const hits = arbMemo.hits;
    return { chain, sel, items, rows, shape, hv20, hv10, hvp, hist, df, T, twoSided, hits };
  }

  /** "· 1 loading · 2 couldn't load" for the term rows not drawn yet. */
  function pendingText(items) {
    const n = (k) => items.filter((it) => it.status === k).length;
    const ld = n("loading");
    const er = n("error");
    return `${ld ? ` · ${formatInt(ld)} loading` : ""}${er ? ` · ${formatInt(er)} couldn't load` : ""}`;
  }

  // ── Draw ──
  function requestDraw() {
    if (drawTimer) return;
    drawTimer = setTimeout(() => {
      drawTimer = 0;
      if (kpiEl.isConnected) draw();
    }, 30);
  }
  function draw() {
    const t0 = performance.now();
    const parts = [];
    const lap = (name, fn) => {
      const a = performance.now();
      fn();
      if (debug) parts.push([name, Math.round((performance.now() - a) * 100) / 100]);
    };
    let m = null;
    lap("model", () => (m = model()));
    last = m;
    // No expiries at all: one empty state in the curves panel, nothing else.
    const none = !st.expiries.length && Boolean(st.empty);
    for (const el of [kpiEl, termEl, strikesEl, readEl, historyEl, methodEl]) if (el.hidden !== none) el.hidden = none;
    curvesEl.classList.toggle("no-exp", none);
    lap("kpi", () => drawKpi(m));
    lap("curves", () => drawCurves(m));
    lap("term", () => drawTermTable(m));
    lap("strikes", () => drawStrikes(m));
    lap("read", () => drawRead(m));
    lap("method", () => drawMethod(m));
    if (debug) window.__volParts = parts;
    const ms = performance.now() - t0;
    if (debug) {
      window.__volDrawMs.push(ms);
      if (ms > (window.__volWorst?.ms ?? 0)) window.__volWorst = { ms, parts };
      if (window.__volDrawMs.length > 50) window.__volDrawMs.shift();
    }
    return ms;
  }

  function drawKpi(m) {
    const r = m.sel;
    if (!r) {
      for (const [k] of TILES) if (k !== "rank") setTile(k, {});
      drawRank();
      return;
    }
    setTile("fwd", {
      value: formatFixed(r.F, 1),
      sub: r.source === "spot" ? "F = spot (no two-sided ATM quotes)" : `Spot ${formatFixed(r.spot, 1)} · basis ${formatSigned(r.basis, 1)}`,
      title: "Put-call parity forward: median of K + (C − P)·e^(rT) over the 3 two-sided strikes nearest spot",
    });
    setTile("iv", { value: formatPercent(r.atmIv, 1), sub: `CE ${formatFixed(r.ceIv, 1)} · PE ${formatFixed(r.peIv, 1)}`, title: r.atmIv === null ? "No usable ATM quotes" : `ATM IV linear in strike at the forward; CE and PE at the ${formatInt(r.atmStrike)} strike` });
    setTile("move", {
      value: r.move === null ? DASH : `±${formatInt(r.move)}`,
      sub: r.move === null ? "" : `${formatPercent(r.movePct, 2)} · ${formatInt(r.lo)}–${formatInt(r.hi)}`,
      title: "Log-normal 1σ to expiry at ATM IV: about 68% of outcomes land inside",
    });
    setTile("straddle", {
      value: formatFixed(r.straddle, 2),
      sub: r.straddle === null ? "" : `${formatRupee(r.rupee, 0)} a lot · ÷1σ ${formatFixed(r.ratio, 2)}`,
      title: `ATM (${formatInt(r.atmStrike)}) call + put. Straddle ÷ 1σ move is about 0.80 in log-normal theory`,
    });
    const rr = r.rr25;
    setTile("rr", {
      value: rr === null ? "n/a" : pts(rr),
      sub: rr === null ? "Chain too narrow for 25Δ" : rr >= 0.5 ? "Puts richer" : rr <= -0.5 ? "Calls richer" : "Balanced",
      title: "25-delta risk reversal, put minus call (Deribit and CME quote call minus put)",
      aria: rr === null ? "25-delta risk reversal: not available, chain too narrow" : `25-delta risk reversal, put minus call, ${rr >= 0 ? "plus" : "minus"} ${formatFixed(Math.abs(rr), 1)} vol points: ${rr >= 0.5 ? "puts richer" : rr <= -0.5 ? "calls richer" : "balanced"}`,
    });
    const bf = r.bf25;
    setTile("bf", {
      value: bf === null ? "n/a" : pts(bf),
      sub: bf === null ? "Chain too narrow for 25Δ" : bf > 0.3 ? "Wings over ATM" : "Flat smile",
      title: "25-delta butterfly: mean of the 25-delta put and call IV, minus ATM IV",
      aria: bf === null ? "25-delta fly: not available" : `25-delta fly ${bf >= 0 ? "plus" : "minus"} ${formatFixed(Math.abs(bf), 1)} vol points`,
    });
    if (m.hv20 === null) setTile("hv", { sub: m.hist?.loading && !m.hist?.closes ? "Loading daily history…" : "No daily history from this broker", title: "20-day realised vol of the index" });
    else {
      const vrp = r.atmIv === null ? null : r.atmIv - m.hv20;
      const sub = `IV − HV ${formatSigned(vrp, 1)} · pctl ${m.hvp ? formatInt(m.hvp.pct) : "n/a"}`;
      setTile("hv", {
        value: formatPercent(m.hv20, 1),
        sub,
        title: `20-day realised vol (HV10 ${formatPercent(m.hv10, 1)}). The percentile is of realised, not implied, vol${m.hvp ? ` over ${formatInt(m.hvp.count)} sessions` : ": needs 120 sessions"}`,
        aria: `HV20 ${formatPercent(m.hv20, 1)}, IV minus HV ${formatSigned(vrp, 1)} vol points, realised percentile ${m.hvp ? formatInt(m.hvp.pct) : "not available"}`,
      });
    }
    drawRank();
  }
  function drawRank() {
    setTile("rank", { value: "Unavailable", sub: "Needs 252 days of IV history", cls: "na", title: "IV rank and IV percentile need a stored daily ATM IV. The Bridge does not record one yet.", aria: "IV rank: unavailable. Needs 252 days of stored IV history" });
  }

  // Curves.
  let smileSig = "";
  let termSig = "";
  let smileEl = null;
  function drawCurves(m) {
    const d = dev();
    if (!m.chain) {
      curvesMsg.hidden = false;
      const sig = `${st.error ? "e" : st.empty ? "x" : "l"}|${st.error?.message ?? ""}`;
      if (curvesMsg.__sig !== sig) {
        curvesMsg.__sig = sig;
        curvesMsg.replaceChildren(
          st.error
            ? h("div", { class: "desk-pad stack" }, alertBox(st.error), h("div", {}, h("button", { type: "button", class: "small", onclick: () => retry() }, icon("refresh"), "Retry")))
            : st.empty
              ? emptyState("clock", "No expiries", st.empty)
              : h("p", { class: "muted vol-loading" }, "Loading the chain…"),
        );
      }
      smileHost.replaceChildren();
      smileSig = "";
      smileEl = null;
      text(smileTitle, "");
      text(readout, " ");
    } else curvesMsg.hidden = true;
    curvesEl.classList.toggle("no-chain", !m.chain);
    const r = m.sel;
    if (r) {
      text(smileTitle, `${dayMon(r.expiry)} · ${r.dim ? "expiry day" : O.timeToExpiry(r.expiry).label}`);
      // Banners: no live bid/ask; expiry day.
      const banners = [];
      if (!m.twoSided) banners.push("No live bid/ask: IVs use last traded prices (hollow points)");
      if (r.dim) banners.push("Expiry day: IV is unstable in the final hours");
      const bsig = banners.join("|");
      if (smileBanner.__sig !== bsig) {
        smileBanner.__sig = bsig;
        smileBanner.replaceChildren(...banners.map((b) => h("p", { class: "vol-banner" }, icon("info"), b)));
      }
      const pts0 = rangePoints(r);
      const cmp = compareRow(m);
      const width = boxW(smileHost, 640);
      const height = d.phone ? 200 : d.narrow ? 240 : 280;
      const c = cfg();
      const T = Math.max(r.years ?? 0, 0.25 / 365);
      const pos = (K) => (K === null || K === undefined || !r.F ? null : { strike: K, m: (K / r.F - 1) * 100, delta: r.atmIv ? 1 - (O.b76Delta(r.F, K, T, r.atmIv, "CE") ?? 0.5) : null });
      const steps = r.points.map((p) => p.strike);
      const step = steps.length > 1 ? Math.min(...steps.slice(1).map((k, i) => k - steps[i])) : null;
      const cmpPts = cmp ? cmp.points.filter((p) => inRange(p, cmp)) : null;
      // Rebuilt only when what is drawn changes (to 0.01 vol point / 0.1 index point), not on every chain object.
      const q = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
      const pt = (p) => [p.strike, q(p.m), q(p.otm?.iv), p.otm?.q, q(p.ce?.iv), p.ce?.q, q(p.pe?.iv), p.pe?.q, q(p.callDelta)];
      const sig = JSON.stringify([c.x, c.series, c.range, width, height, d.coarse, r.expiry, step, q(r.F), q(r.lo), q(r.hi), q(r.spot), q(r.atmIv), q(r.rr25), pts0.map(pt), cmp ? [cmp.expiry, cmpPts.map(pt)] : null]);
      if (sig !== smileSig || !smileEl) {
        smileSig = sig;
        const markers = { F: pos(r.F), lo: pos(r.lo), hi: pos(r.hi), spot: r.spot !== null && step && Math.abs(r.F - r.spot) >= step / 2 ? pos(r.spot) : null };
        smileEl = smileSvg(
          { points: pts0, markers, step, compare: cmp ? { points: cmpPts, label: dayMon(cmp.expiry) } : null },
          { x: c.x, series: c.series, width, height, coarse: d.coarse, label: smileLabel({ expiryLabel: dayMon(r.expiry), atmIv: r.atmIv, rr25: r.rr25, n: pts0.length }), onPick: pickFromSmile, empty: "No usable IV in this range" },
        );
        smileHost.replaceChildren(smileEl);
      }
      paintHighlight(false);
    }
    // Term curve.
    const loaded = m.items.filter((it) => it.row);
    const sh = m.shape;
    text(shapeEl, sh.kind === "insufficient" ? sh.label : `${sh.label} · ${formatSigned(sh.slope, 1)} pts`);
    const selRow = m.sel;
    text(termReadout, selRow ? `${dayMon(selRow.expiry)} · ATM IV ${formatPercent(selRow.atmIv, 1)} · 1σ ±${formatInt(selRow.move)}${pendingText(m.items)}` : " ");
    const allFailed = !loaded.length && m.items.length > 0 && m.items.every((it) => it.status === "error");
    const tw = boxW(termHost, 420);
    const th = d.phone ? 200 : d.narrow ? 240 : 280;
    const tsig = JSON.stringify([allFailed, loaded.map((it) => [it.e, it.row.atmIv, it.row.days !== null ? Math.round(it.row.days * 10) : null, it.row.skew.put25?.iv ?? null, it.row.skew.call25?.iv ?? null]), st.expiry, cfg().series.wings, tw, th, d.coarse]);
    if (tsig !== termSig) {
      termSig = tsig;
      termHost.replaceChildren(
        termSvg(
          loaded.map((it) => ({ ...it.row, label: dayMon(it.e) })),
          {
            selected: st.expiry,
            empty: allFailed ? "Couldn't load the chains" : "Loading expiries…",
            wings: cfg().series.wings,
            width: tw,
            height: th,
            coarse: d.coarse,
            label: `Term structure: ATM IV across ${formatInt(loaded.length)} expiries, ${sh.label}`,
            onPick: (e) => e !== st.expiry && selectExpiry(e),
          },
        ),
      );
    }
  }
  /** The strikes in the range setting (ATM ±10 / ±20 / all), by index around the ATM strike. */
  function rangePoints(r) {
    const p = r.points;
    if (cfg().range === "all") return p;
    const n = Number(cfg().range);
    const i = p.findIndex((x) => x.strike === r.atmStrike);
    return i < 0 ? p : p.slice(Math.max(0, i - n), i + n + 1);
  }
  /** A compare row's point is shown when its moneyness sits inside the selected expiry's range. */
  function inRange(p) {
    const r = last?.sel;
    if (!r) return true;
    const pr = rangePoints(r);
    if (!pr.length) return true;
    const lo = pr[0].m - 0.05;
    const hi = pr[pr.length - 1].m + 0.05;
    return p.m >= lo && p.m <= hi;
  }
  function compareRow(m) {
    const c = cfg().compare;
    if (c === "none") return null;
    const list = m.items;
    const i = list.findIndex((it) => it.e === st.expiry);
    let it = null;
    if (c === "next") it = list.slice(i + 1).find((x) => x.row) ?? null;
    else it = list.find((x) => x.row && x.e !== st.expiry && x.row.monthly) ?? null;
    return it?.row ?? null;
  }

  // Highlight shared by the smile and the strikes table.
  function setHover(k) {
    if (hover === k) return;
    hover = k;
    paintHighlight(false);
  }
  function setHl(k, scroll = false) {
    hl = k;
    paintHighlight(scroll);
  }
  function pickFromSmile(k, how) {
    if (how === "hover") return setHover(k);
    if (how === "leave") return setHover(null);
    if (k !== null) setHl(k, true);
  }
  function paintHighlight(scroll) {
    const r = last?.sel;
    const k = hover ?? hl;
    smileEl?.mark?.(k);
    for (const tr of strikesBody.querySelectorAll("tr.hl")) if (Number(tr.dataset.k) !== k) tr.classList.remove("hl");
    const row = k === null ? null : strikesBody.querySelector(`tr[data-k="${k}"]`);
    if (row && !row.classList.contains("hl")) row.classList.add("hl");
    if (scroll && row) scrollRow(row);
    // Readout: the highlighted strike, else ATM.
    const p = r ? r.points.find((x) => x.strike === (k ?? r.atmStrike)) : null;
    const t = p
      ? `${formatInt(p.strike)}${k === null ? " ATM" : ""} · Mny ${formatSigned(p.m, 1)}% · OTM ${formatPercent(p.otm?.iv ?? null, 1)} · CE ${formatFixed(p.ce?.iv ?? null, 1)} · PE ${formatFixed(p.pe?.iv ?? null, 1)} · |Δ| ${formatFixed(p.otm?.delta === null || p.otm?.delta === undefined ? null : Math.abs(p.otm.delta), 2)}`
      : " ";
    text(readout, t);
    // Screen readers: at most one announcement every 500 ms.
    clearTimeout(liveTimer);
    const announce = () => {
      liveAt = Date.now();
      text(live, t.trim());
    };
    if (k !== null) {
      const wait = 500 - (Date.now() - liveAt);
      if (wait <= 0) announce();
      else liveTimer = setTimeout(announce, wait);
    }
  }
  function scrollRow(row) {
    const box = strikesWrap.getBoundingClientRect();
    const rb = row.getBoundingClientRect();
    const headH = strikesHead.getBoundingClientRect().height || 30;
    if (rb.top < box.top + headH || rb.bottom > box.bottom) strikesWrap.scrollTop += rb.top - box.top - headH - (box.height - headH) / 2 + rb.height / 2;
  }

  // Term table: rows keyed by expiry, built when the row set changes, patched cell by cell after.
  function shownCols() {
    const d = dev();
    const cols = cfg().cols;
    return d.phone ? cols.slice(0, 4) : d.narrow ? cols.slice(0, 8) : cols;
  }
  function detailMode() {
    return dev().narrow;
  }
  let termStruct = "";
  const termRows = new Map(); // expiry -> { tr, cells: Map(id -> td), detail, lead }
  function drawTermTable(m) {
    const c = cfg();
    const cols = shownCols();
    const dm = detailMode();
    const struct = JSON.stringify([m.items.map((it) => [it.e, it.status === "ok" ? "ok" : it.status]), cols, dm, c.hedgePct]);
    if (struct !== termStruct) {
      termStruct = struct;
      buildTermTable(m, cols, dm);
    }
    for (const it of m.items) {
      const rec = termRows.get(it.e);
      if (!rec) continue;
      const sel = it.e === st.expiry;
      rec.tr.classList.toggle("sel", sel);
      if (sel) rec.tr.setAttribute("aria-current", "true");
      else rec.tr.removeAttribute("aria-current");
      rec.tr.classList.toggle("dim", Boolean(it.row?.dim));
      if (!it.row) continue;
      const thin = it.row.quality !== null && it.row.quality !== undefined && it.row.quality < 0.5;
      if (rec.thin && rec.thin.hidden === thin) rec.thin.hidden = !thin;
      for (const id of cols) patchCell(rec.cells.get(id), colOf(id).cell(it.row, it));
      if (rec.detail) {
        const open = openDetail === it.e;
        rec.detail.hidden = !open;
        rec.tr.setAttribute("aria-expanded", String(open));
        if (open) {
          for (const [id, dd] of rec.dcells) patchCell(dd, colOf(id).cell(it.row, it));
        }
      }
    }
    text(termHint, dm ? "Tap a row for every figure" : "Click a row to select it");
    const n = m.items.filter((it) => it.row).length;
    text(termFoot, st.expiries.length ? `${formatInt(n)} of ${formatInt(st.expiries.length)} expiries${n ? ` · shape ${m.shape.label}` : ""}${pendingText(m.items)}` : "");
  }
  function buildTermTable(m, cols, dm) {
    const c = cfg();
    termHead.replaceChildren(
      h(
        "tr",
        {},
        h("th", { scope: "col", class: "lead" }, "Expiry"),
        cols.map((id) => {
          const col = colOf(id);
          return h("th", { scope: "col", class: "num" }, col.head ? col.head(c) : col.header);
        }),
        dm ? h("th", { scope: "col", class: "act" }, h("span", { class: "pal-sr-only" }, "Select")) : null,
      ),
    );
    termRows.clear();
    const span = cols.length + 1 + (dm ? 1 : 0);
    const out = [];
    for (const it of m.items) {
      const monthly = O.isMonthly(it.e, st.expiries);
      const lead = h("th", { scope: "row", class: "lead" }, h("span", { class: "vol-exp" }, h("span", { class: "vol-bar", "aria-hidden": "true" }), h("strong", {}, dayMon(it.e)), h("span", { class: "wd" }, weekday(it.e)), monthly ? h("span", { class: "m-tag", title: "Monthly expiry" }, "M") : null, h("span", { class: "thin-tag", hidden: true, title: "Thin quotes: under half of ATM ±10 strikes have a tight two-sided quote" }, "Thin")));
      const detailId = `vol-d-${it.e}`;
      const rest = COL_IDS.filter((id) => !cols.includes(id));
      const hasDetail = it.status === "ok" && rest.length > 0;
      const tr = h("tr", { "data-e": it.e, tabindex: "0", class: it.status !== "ok" ? "pending" : undefined, "aria-controls": hasDetail ? detailId : undefined, "aria-expanded": hasDetail ? "false" : undefined, title: hasDetail && !dm ? "Enter selects · Space shows the other figures" : undefined });
      const cells = new Map();
      if (it.status === "ok") {
        tr.append(lead);
        for (const id of cols) {
          const td = h("td", { class: "num", "data-col": id });
          cells.set(id, td);
          tr.append(td);
        }
        if (dm) tr.append(h("td", { class: "act" }, h("button", { type: "button", class: "small vol-select", "data-select": it.e, "aria-label": `Select ${dayMon(it.e)}`, title: "Make this the selected expiry" }, icon("check"), h("span", { class: "vol-select-t" }, "Select"))));
      } else {
        tr.append(
          lead,
          h(
            "td",
            { colspan: String(span - 1), class: "vol-status" },
            it.status === "error" ? h("span", { class: "vol-err" }, "Couldn't load · ", h("button", { type: "button", class: "small plain vol-retry", "data-retry": it.e }, icon("refresh"), "Retry")) : h("span", { class: "muted" }, "Loading…"),
          ),
        );
      }
      const rec = { tr, cells, detail: null, dcells: new Map(), thin: lead.querySelector(".thin-tag") };
      out.push(tr);
      if (hasDetail) {
        const dl = h(
          "dl",
          { class: "vol-detail-grid" },
          rest.map((id) => {
            const col = colOf(id);
            const dd = h("dd", {});
            rec.dcells.set(id, dd);
            return h("div", {}, h("dt", {}, col.head ? col.head(c) : col.header), dd);
          }),
        );
        rec.detail = h("tr", { class: "vol-detail", id: detailId, hidden: true }, h("td", { colspan: String(span) }, dl));
        out.push(rec.detail);
      }
      termRows.set(it.e, rec);
    }
    termBody.replaceChildren(...out);
  }
  function patchCell(td, v) {
    if (!td) return;
    const sig = `${v.t}|${v.s ?? ""}|${v.title ?? ""}`;
    if (td.__sig === sig) return;
    td.__sig = sig;
    td.replaceChildren(v.s ? h("span", { class: "two" }, h("span", {}, v.t), h("small", {}, v.s)) : v.t);
    if (v.title) td.title = v.title;
    else td.removeAttribute("title");
    td.classList.toggle("na", v.t === "n/a" || v.t === DASH);
  }
  function onTermClick(e) {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const retryBtn = t.closest("[data-retry]");
    if (retryBtn) {
      const ex = retryBtn.dataset.retry;
      if (ex === st.expiry) return retry();
      const ent = cache.get(ex);
      if (ent) ent.error = null;
      enqueue([ex]);
      return;
    }
    const selBtn = t.closest("[data-select]");
    if (selBtn) return selectExpiry(selBtn.dataset.select);
    const tr = t.closest("tr[data-e]");
    if (!tr || tr.classList.contains("pending")) return;
    if (detailMode()) toggleDetail(tr.dataset.e);
    else if (tr.dataset.e !== st.expiry) selectExpiry(tr.dataset.e);
  }
  function onTermKey(e) {
    const tr = e.target instanceof Element ? e.target.closest("tr[data-e]") : null;
    if (!tr || e.target !== tr) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (tr.dataset.e !== st.expiry) selectExpiry(tr.dataset.e);
    } else if (e.key === " ") {
      e.preventDefault();
      if (termRows.get(tr.dataset.e)?.detail) toggleDetail(tr.dataset.e);
    }
  }
  function toggleDetail(ex) {
    openDetail = openDetail === ex ? null : ex;
    if (last) drawTermTable(last);
  }

  // Strikes table: keyed by strike; rebuilt when the strike set or the columns change, patched after.
  let strikesStruct = "";
  const strikeRows = new Map(); // strike -> { tr, cells }
  const STRIKE_COLS = [
    ["k", "Strike", ""],
    ["m", "Mny %", "c-wide"],
    ["ce", "CE IV", "c-cepe"],
    ["pe", "PE IV", "c-cepe"],
    ["otm", "OTM IV", "c-otm"],
    ["vs", "vs ATM", "c-otm"],
    ["d", "|Δ|", "c-otm"],
    ["sp", "Spread %", "c-wide"],
    ["flag", "Flag", ""],
  ];
  function drawStrikes(m) {
    const r = m.sel;
    if (!r) {
      if (strikesStruct !== "none") {
        strikesStruct = "none";
        strikesHead.replaceChildren();
        strikesBody.replaceChildren();
        strikeRows.clear();
      }
      text(strikesSub, "");
      return;
    }
    const list = rangePoints(r);
    const firstAbove = list.find((p) => p.strike >= r.F)?.strike ?? null;
    const struct = JSON.stringify([r.expiry, list.map((p) => p.strike), r.atmStrike, firstAbove]);
    if (struct !== strikesStruct) {
      strikesStruct = struct;
      strikesHead.replaceChildren(h("tr", {}, STRIKE_COLS.map(([k, label, cls]) => h("th", { scope: "col", class: `${k === "k" || k === "flag" ? "" : "num "}${cls}`.trim() || undefined }, label))));
      strikeRows.clear();
      strikesBody.replaceChildren(
        ...list.map((p) => {
          const cells = new Map(STRIKE_COLS.map(([k, , cls]) => [k, h(k === "k" ? "th" : "td", { class: `${k === "k" ? "k" : k === "flag" ? "flag" : "num"} ${cls}`.trim(), scope: k === "k" ? "row" : undefined })]));
          const tr = h("tr", { "data-k": String(p.strike), class: [p.strike === r.atmStrike ? "atm" : "", p.strike === firstAbove ? "f-above" : ""].filter(Boolean).join(" ") || undefined }, [...cells.values()]);
          strikeRows.set(p.strike, { tr, cells });
          return tr;
        }),
      );
      if (atmScrolled !== `${st.underlying}|${r.expiry}`) {
        atmScrolled = `${st.underlying}|${r.expiry}`;
        const atm = strikeRows.get(r.atmStrike)?.tr;
        if (atm) requestAnimationFrame(() => atm.isConnected && scrollRow(atm));
      }
    }
    const sk = r.skew;
    const tags = new Map();
    const tag = (x, label) => x && tags.set(x.strike, [...(tags.get(x.strike) ?? []), label]);
    tag(sk.put25, "25Δ P");
    tag(sk.call25, "25Δ C");
    tag(sk.put10, "10Δ P");
    tag(sk.call10, "10Δ C");
    const ba = cfg().bidAsk;
    const ivCell = (leg) => (ba ? (leg && (leg.bidIv !== null || leg.askIv !== null) ? `${formatFixed(leg.bidIv, 1)}–${formatFixed(leg.askIv, 1)}` : DASH) : formatFixed(leg?.iv ?? null, 1));
    const OUT = { tick: "tick floor", intrinsic: "below intrinsic", range: "IV out of range", noquote: "no quote" };
    for (const p of list) {
      const rec = strikeRows.get(p.strike);
      if (!rec) continue;
      const otmLeg = p.strike < r.F ? p.pe : p.ce;
      const flags = [];
      if (p.otm?.q === "ltp") flags.push(["◦ LTP", "Priced from the last trade: no two-sided quote"]);
      if (p.otm?.q === "wide") flags.push(["W", "Wide: bid–ask spread over 10% of mid"]);
      if (p.gap) flags.push(["⇄", "CE and PE IV bands do not overlap: a parity gap"]);
      if (p.out) flags.push([OUT[p.out], `Not drawn: ${OUT[p.out]}`]);
      const t = tags.get(p.strike) ?? [];
      const set = (k, v, title, key) => {
        const td = rec.cells.get(k);
        const sig = `${key ?? v}|${title ?? ""}`;
        if (td.__sig === sig) return;
        td.__sig = sig;
        if (typeof v === "function") td.replaceChildren(...v());
        else td.textContent = v;
        if (title) td.title = title;
        else td.removeAttribute("title");
      };
      const isAtm = p.strike === r.atmStrike;
      set("k", () => [h("span", { class: "vol-k" }, formatInt(p.strike)), isAtm ? h("span", { class: "vol-chip atm" }, "ATM") : null, ...t.map((x) => h("span", { class: "vol-chip" }, x))].filter(Boolean), undefined, `${isAtm}|${t.join()}`);
      set("m", formatSigned(p.m, 1));
      set("ce", ivCell(p.ce), ba ? "IV at the bid – IV at the ask" : undefined);
      set("pe", ivCell(p.pe), ba ? "IV at the bid – IV at the ask" : undefined);
      set("otm", formatFixed(p.otm?.iv ?? null, 1), p.otm ? `${p.otm.side.toUpperCase()} side` : undefined);
      set("vs", p.otm && r.atmIv !== null ? formatSigned(p.otm.iv - r.atmIv, 1) : DASH);
      set("d", formatFixed(p.otm?.delta === null || p.otm?.delta === undefined ? null : Math.abs(p.otm.delta), 2));
      set("sp", formatFixed(O.spreadPct(otmLeg ? rawLeg(r, p.strike, p.strike < r.F ? "pe" : "ce") : null), 1));
      set("flag", () => flags.map(([f, title]) => h("span", { class: "vol-flag", title }, f)), undefined, flags.map((f) => f[0]).join("|"));
      rec.tr.classList.toggle("out", Boolean(p.out));
    }
    text(strikesSub, `${dayMon(r.expiry)} · ${formatInt(list.length)} strikes · IV % recomputed`);
    paintHighlight(false);
  }
  /** The raw chain leg behind a point (for the spread). */
  function rawLeg(r, strike, side) {
    const chain = last?.chain;
    return chain?.rows.find((x) => x.strike === strike)?.[side] ?? null;
  }

  // Read and arbitrage.
  function drawRead(m) {
    const r = m.sel;
    if (!r) {
      const sig = st.error ? "error" : "none";
      if (readBody.__sig !== sig) {
        readBody.__sig = sig;
        readBody.replaceChildren(
          st.error
            ? h("p", { class: "vol-note vol-err-line" }, "Couldn't load the chain. ", h("button", { type: "button", class: "small plain vol-retry", onclick: () => retry() }, icon("refresh"), "Retry"))
            : h("p", { class: "vol-note" }, "Waiting for the chain."),
        );
        arbBody.replaceChildren();
        arbBody.__sig = "";
      }
      return;
    }
    const near = (v) => (v === null ? null : r.points.reduce((b, p) => (b === null || Math.abs(p.strike - v) < Math.abs(b - v) ? p.strike : b), null));
    const hedges = m.items.filter((it) => it.row?.hedge && !it.row.dim);
    const cheapest = hedges.length ? hedges.reduce((b, it) => (it.row.hedge.annualPct < b.row.hedge.annualPct ? it : b)) : null;
    const inversions = [];
    let prev = null;
    for (const it of m.items) {
      if (!it.row) continue;
      if (it.fwd?.inverted && prev) inversions.push({ from: dayMon(prev.e), to: dayMon(it.e) });
      if (!it.row.dim) prev = it;
    }
    const hits = m.hits ? m.hits.filter((x) => x.kind !== "Calendar variance") : null;
    const lines = O.volRead({
      atmIv: r.atmIv,
      hv20: m.hv20,
      vrp: r.atmIv !== null && m.hv20 !== null ? r.atmIv - m.hv20 : null,
      rr25: r.rr25,
      wingPut16: r.skew.wingPut16,
      wingCall16: r.skew.wingCall16,
      straddle: r.straddle,
      straddlePct: r.straddlePct,
      move: r.move,
      movePct: r.movePct,
      ratio: r.ratio,
      lo: r.lo,
      hi: r.hi,
      emDown: near(r.lo),
      emUp: near(r.hi),
      shape: m.shape.kind,
      inversions,
      hedge: r.hedge,
      cheapestHedge: cheapest ? { expiry: cheapest.e, label: dayMon(cheapest.e), annualPct: cheapest.row.hedge.annualPct } : null,
      expiry: r.expiry,
      hits: hits ? hits.length : null,
      gapCount: r.points.filter((p) => p.gap).length,
      futGaps: m.items.filter((it) => it.row && it.row.futGap !== null).map((it) => ({ label: dayMon(it.e), futGap: it.row.futGap, F: it.row.F })),
      days: r.days,
      expiryLabel: dayMon(r.expiry),
    });
    const phone = dev().phone;
    const sig = JSON.stringify([lines, phone]);
    if (readBody.__sig !== sig) {
      readBody.__sig = sig;
      const footer = lines.find((p) => p.persona === "Note");
      readBody.replaceChildren(
        ...lines
          .filter((p) => p.persona !== "Note")
          .map((p) =>
            h(
              "details",
              { class: "vol-persona", open: !phone || undefined },
              h(
                "summary",
                {},
                h("strong", {}, p.persona),
                phone && p.lines[0] ? h("span", { class: "vol-first" }, p.lines[0]) : null,
                phone && p.lines.length > 1 ? h("span", { class: "vol-more", "aria-label": `${formatInt(p.lines.length - 1)} more` }, `+${formatInt(p.lines.length - 1)}`) : null,
                phone && p.lines.length > 1 ? h("span", { class: "vol-chev", "aria-hidden": "true" }, icon("chevron")) : null,
              ),
              p.lines.length ? h("ul", {}, (phone ? p.lines.slice(1) : p.lines).map((l) => h("li", {}, l))) : h("p", { class: "vol-note" }, "Nothing to add from current prices."),
            ),
          ),
        h("p", { class: "vol-note vol-foot-note" }, footer.lines[0]),
      );
    }
    // Arbitrage: the top 8 hits, then calendar inversions; the footer says what is not included.
    const lot = r.lot;
    const legText = (l) => `${l.side === "BUY" ? "Buy" : "Sell"} ${l.qty ? `${formatInt(l.qty)}× ` : ""}${formatInt(l.strike)} ${l.right} @ ${formatFixed(l.price, 2)}`;
    const arbLines = !m.twoSided
      ? [h("p", { class: "vol-note" }, "Needs live bid/ask: these checks use executable prices only.")]
      : hits && hits.length
        ? [
            h(
              "ol",
              { class: "vol-hits" },
              hits.slice(0, 8).map((x) => h("li", {}, h("strong", {}, x.kind), ` · ${x.legs.map(legText).join(" · ")} · edge ${formatFixed(x.edge, 2)} pts${lot ? ` · ${formatRupee(x.edge * lot, 0)} a lot` : ""}${x.note ? ` · ${x.note}` : ""}`)),
            ),
          ]
        : [h("p", { class: "vol-note" }, `No executable violations at bid/ask across ${formatInt(m.hits?.strikes ?? 0)} strikes (verticals, flies, boxes).`)];
    const cal = inversions.map((x) => h("p", { class: "vol-note" }, h("strong", {}, "Calendar variance"), ` · total variance falls from ${x.from} to ${x.to} (model-based, informational)`));
    const asig = JSON.stringify([m.twoSided, hits?.map((x) => [x.kind, x.edge, x.legs.map((l) => l.strike)]), inversions, m.hits?.strikes, lot]);
    if (arbBody.__sig !== asig) {
      arbBody.__sig = asig;
      arbBody.replaceChildren(...arbLines, ...cal, h("p", { class: "vol-note vol-foot-note" }, "Gross of brokerage, STT (0.15% of sell premium; 0.15% of intrinsic on exercised ITM) and exchange charges. Quotes can move before you trade."));
    }
  }

  function drawMethod(m) {
    text(methodEl.querySelector(".vol-rate-line"), `Rate: ${formatFixed(cfg().rate, 2)}% a year (the server default is 6.5%), for discounting and the parity forward. Prices: ${cfg().basis === "mid" ? "bid–ask mid" : "last traded (set in Customise)"}.`);
    const r = m.sel;
    text(methodSrc, r ? (r.source === "spot" ? "Forward for the selected expiry: spot (no two-sided ATM quotes)." : `Forward for the selected expiry: parity, ${formatFixed(r.F, 1)}.`) : "Forward: waiting for the chain.");
    const now = Date.now();
    const age = (iso) => {
      const t = iso ? Date.parse(iso) : NaN;
      return Number.isFinite(t) ? Math.max(0, (now - t) / 1000) : null;
    };
    const sa = age(st.freshness?.asOf);
    const ages = m.items.filter((it) => !it.sel && it.row).map((it) => (it.at ? (now - it.at) / 1000 : null)).filter((v) => v !== null);
    text(methodAge, `Data age: selected chain ${sa === null ? DASH : `${formatInt(sa)} s`} old${ages.length ? ` · term rows ${formatInt(Math.min(...ages))}–${formatInt(Math.max(...ages))} s old` : ""}. HV: ${m.hist?.closes ? `${formatInt(m.hist.closes.length)} daily closes` : "no daily history"}.`);
  }

  // ── Keyboard ──
  function moveHl(d) {
    const r = last?.sel;
    if (!r) return false;
    const list = rangePoints(r).map((p) => p.strike);
    const i = list.indexOf(hl ?? r.atmStrike);
    const j = Math.max(0, Math.min(list.length - 1, (i < 0 ? list.indexOf(r.atmStrike) : i) + d));
    setHl(list[j], true);
    return true;
  }
  function onKey(e) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === "[" || k === "]") {
      const i = st.expiries.indexOf(st.expiry);
      const j = i + (k === "]" ? 1 : -1);
      if (i >= 0 && j >= 0 && j < st.expiries.length) selectExpiry(st.expiries[j]);
      return true;
    }
    if (k === "j" || (k === "ArrowDown" && hl !== null)) return moveHl(1);
    if (k === "k" || (k === "ArrowUp" && hl !== null)) return moveHl(-1);
    if (k === "g") return setHl(last?.sel?.atmStrike ?? null, true), true;
    if (k === "x") {
      const i = X_AXES.findIndex((a) => a[0] === cfg().x);
      const next = X_AXES[(i + 1) % X_AXES.length][0];
      if (next === "strike" && cfg().compare !== "none") return setCfg({ x: next, compare: "none" }), true;
      return setCfg({ x: next }), true;
    }
    if (k === "c") {
      const i = COMPARES.findIndex((a) => a[0] === cfg().compare);
      return setCompare(COMPARES[(i + 1) % COMPARES.length][0]), true;
    }
    if (k === "t") {
      if (!dev().phone) return false;
      return setCfg({ tab: cfg().tab === "smile" ? "term" : "smile" }), true;
    }
    if (k === "Escape") {
      if (closeMenu(true)) return true;
      if (hl === null && openDetail === null) return false;
      hl = null;
      openDetail = null;
      paintHighlight(false);
      if (last) drawTermTable(last);
      return true;
    }
    return false;
  }

  // Plot widths come from a ResizeObserver, so a draw never forces a synchronous layout; a width change redraws.
  const widths = new Map();
  function boxW(el, fallback) {
    let w = widths.get(el);
    if (w === undefined) {
      w = el.clientWidth;
      if (w) widths.set(el, w);
    }
    return w || fallback;
  }
  const ro =
    typeof ResizeObserver === "function"
      ? new ResizeObserver((entries) => {
          let changed = false;
          for (const en of entries) {
            const w = Math.round(en.contentRect.width);
            if (w && Math.abs(w - (widths.get(en.target) ?? 0)) > 4) {
              widths.set(en.target, w);
              changed = true;
            }
          }
          if (changed && last) requestDraw();
        })
      : null;
  ro?.observe(smileHost);
  ro?.observe(termHost);

  const phoneOrder = media(MQ_PHONE);
  return {
    panels: phoneOrder ? [kpiEl, curvesEl, termEl, readEl, strikesEl, historyEl, methodEl] : [kpiEl, curvesEl, termEl, strikesEl, readEl, historyEl, methodEl],
    root: curvesEl,
    draw,
    onKey,
    /** Each refresh tick: one stale term expiry (oldest first), futures every 5th tick, history when it is old. */
    tick() {
      ticks += 1;
      enqueueMissing();
      if (!active && !queue.length) {
        const oldest = termList()
          .filter((e) => e !== st.expiry && cache.get(e)?.chain && !cache.get(e).error && !cache.get(e).loading)
          .sort((a, b) => cache.get(a).at - cache.get(b).at)[0];
        if (oldest) enqueue([oldest]);
      }
      if (ticks % FUT_EVERY === 1) loadFutures();
      loadHistory();
      return Promise.resolve();
    },
    /** A new underlying (clear everything) or a new selected expiry (keep the other expiries). */
    reset({ underlying = false } = {}) {
      hl = null;
      hover = null;
      openDetail = null;
      if (underlying) {
        volSeq += 1;
        cache.clear();
        queue.length = 0;
        futQuotes = new Map();
        termStruct = "";
      } else {
        // A new selected expiry: the outgoing chain becomes a term row (desk.js has already set st.expiry), and any
        // term expiry still missing loads now rather than on the next tick (there is none while Live is paused).
        const out = st.chain;
        if (out?.expiry && out.expiry !== st.expiry && (out.underlying ?? st.underlying) === st.underlying) {
          cache.set(out.expiry, { chain: out, at: Date.now(), asOf: st.freshness?.asOf ?? null, error: null, loading: false });
        }
        enqueueMissing();
      }
      strikesStruct = "";
      smileSig = "";
      if (kpiEl.isConnected) draw();
    },
    /** The expiry list is known: start loading the term expiries (2 at a time). */
    expiriesLoaded() {
      enqueueMissing();
      loadFutures();
      loadHistory();
    },
    destroy() {
      destroyed = true;
      queue.length = 0;
      ro?.disconnect();
      clearTimeout(drawTimer);
      clearTimeout(liveTimer);
      volSeq += 1;
      closePop?.();
      closeMenu();
      document.removeEventListener("pointerdown", menuOutside, true);
    },
  };
}

function text(el, t) {
  if (el && el.textContent !== t) el.textContent = t;
}
