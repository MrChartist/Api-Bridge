// The Volatility page (#/vol): how expensive volatility is, where it is rich along strikes (smile, skew) and along time
// (term structure, IV surface), and how big a move each expiry prices. desk.js owns the toolbar, the selected chain and
// the timer; this file owns the panels, the other expiries' chains, futures quotes and daily history. Every IV here is
// recomputed with Black-76 on the parity forward (options.js); the broker's IVs are not used.
// Round 2 (docs/design/vol.md): foundation colours, persistent animated curves, tooltips and scrub, the IV surface,
// heat cells and micro-visuals. Nothing on this page marks demo data (the toolbar's one indicator does).
import { api, chartSlot, emptyState, errorState, h, icon, optional, sheetPopover, toast } from "./app.js";
import { DASH, formatFixed, formatInt, formatPercent, formatRupee, formatSigned, isFigure } from "./format.js";
import { countUp, flashValue, reducedMotion, stopCount } from "./motion.js";
import * as O from "./options.js";
import { plotSkeleton, smileChart, smileLabel, termChart } from "./vol-curves.js";
import { edgeFades, segmented } from "./views.js";
import { heatCell, svgEl } from "./viz.js";
import { rateText, refRate, refSession } from "./reference.js";
import { clockNote } from "./vol-context.js";
import { explainBox } from "./explain.js";
import { explainVol } from "./explain-core.js";

const num = (v) => (isFigure(v) ? Number(v) : null);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MON = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
const IST_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
const WEEKDAY = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", weekday: "short" });
const weekday = (e) => (ISO_DAY.test(e ?? "") ? WEEKDAY.format(new Date(`${e}T00:00:00Z`)) : "");
const dayMon = (e) => (ISO_DAY.test(e ?? "") ? DAY_MON.format(new Date(`${e}T00:00:00Z`)) : String(e ?? ""));
const MQ_PHONE = "(max-width: 719px)";
const MQ_NARROW = "(max-width: 1023px)";
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
const minus = (t) => String(t).replace(/^-/, "−");
const NARROW = "Chain too narrow for this delta";
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// ── Settings (desk prefs → vol) ──

/**
 * The per-expiry table's columns: id, header, whether it is on by default, and the cell ({ t, s?, title? }) from a
 * TermRow (O.termRow) plus { fwd } (forward vol from the previous expiry). Pure (no DOM), so tests read it. The
 * "curve" column draws a sparkline of the expiry's smile (vol.js paints it; the text is the fallback).
 */
export const VOL_TERM_COLUMNS = Object.freeze([
  { id: "dte", header: "DTE", def: true, cell: (r) => ({ t: formatFixed(r.days, r.days !== null && r.days < 3 ? 1 : 0), title: r.dim ? "Expiry day" : "Calendar days to 15:30 IST" }) },
  { id: "atmIv", header: "ATM IV", def: true, cell: (r) => ({ t: formatPercent(r.atmIv, 1), title: r.atmIv === null ? "No usable ATM quotes" : "Linear in strike at the forward" }) },
  { id: "curve", header: "Curve", def: true, cell: (r) => ({ t: DASH, title: r.points?.length ? "OTM smile across ±2σ (one IV scale for every row)" : "No smile" }) },
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
  series: Object.freeze({ otm: true, ce: false, pe: false, wings: false, hv: true, ba: false, oi: false }),
  range: "20",
  compare: "none",
  tab: "smile",
  surf: Object.freeze({ mode: "delta", vsAtm: false }),
  cols: Object.freeze(VOL_TERM_COLUMNS.filter((c) => c.def).map((c) => c.id)),
  expiries: 6,
  hedgePct: 97,
  basis: "mid",
  // null = the reference rate (Market calendar, docs/spec/p1-02-reference.md §5.6); a number (% a year) overrides it.
  rate: null,
  bidAsk: false,
});

/** The Volatility page's saved settings, validated: bad values fall back to the defaults, unknown columns are dropped. */
export function volConfig(saved) {
  const d = VOL_DEFAULTS;
  const s = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  const pick = (v, list, def) => (list.includes(v) ? v : def);
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const ser = obj(s.series);
  const sf = obj(s.surf);
  const bool = (v, def) => (typeof v === "boolean" ? v : def);
  const cols = Array.isArray(s.cols) ? s.cols.filter((k, i, a) => COL_IDS.includes(k) && a.indexOf(k) === i) : [...d.cols];
  // Saves before the reference rate (no rateV) stored the old built-in 6.5 as if chosen: they follow the reference now.
  const rate = s.rateV !== 2 && num(s.rate) === 6.5 ? null : num(s.rate);
  return {
    x: pick(s.x, ["strike", "m", "delta"], d.x),
    series: Object.fromEntries(Object.keys(d.series).map((k) => [k, bool(ser[k], d.series[k])])),
    range: pick(s.range, ["10", "20", "all"], d.range),
    compare: pick(s.compare, ["none", "next", "monthly"], d.compare),
    tab: pick(s.tab, ["smile", "term", "surface"], d.tab),
    surf: { mode: pick(sf.mode, ["delta", "mny"], d.surf.mode), vsAtm: bool(sf.vsAtm, d.surf.vsAtm) },
    cols: cols.length ? cols : [...d.cols],
    expiries: pick(s.expiries, [4, 6, 8, 12], d.expiries),
    hedgePct: pick(s.hedgePct, [95, 97, 99], d.hedgePct),
    basis: pick(s.basis, ["mid", "ltp"], d.basis),
    rate: rate !== null && rate >= 0 && rate <= 15 ? rate : d.rate,
    rateV: 2,
    bidAsk: bool(s.bidAsk, d.bidAsk),
  };
}

/**
 * The IV surface's columns for a mode and device: [{ id, label, kind: "put"|"call"|"atm"|"mny", d (signed delta) | m }].
 * Delta: 11 on desktop (10Δ … 35Δ each side + ATM), 9 on tablets (no 15Δ), 5 on phones. Moneyness: −6 … +6 %
 * (phones −4 … +4). Pure.
 */
export function surfaceColumns(mode, device = "desktop") {
  if (mode === "mny") {
    const ms = device === "phone" ? [-4, -2, 0, 2, 4] : [-6, -4, -2, -1, 0, 1, 2, 4, 6];
    return ms.map((m) => ({ id: `m${m}`, label: m === 0 ? "0%" : `${m > 0 ? "+" : "−"}${formatInt(Math.abs(m))}%`, kind: m === 0 ? "atm" : "mny", m, side: m < 0 ? "put" : m > 0 ? "call" : "atm" }));
  }
  const ds = device === "phone" ? [10, 25] : device === "tablet" ? [10, 20, 25, 35] : [10, 15, 20, 25, 35];
  const put = ds.map((d) => ({ id: `p${d}`, label: `${formatInt(d)}ΔP`, kind: "put", d: -d / 100, side: "put" }));
  const call = [...ds].reverse().map((d) => ({ id: `c${d}`, label: `${formatInt(d)}ΔC`, kind: "call", d: d / 100, side: "call" }));
  return [...put, { id: "atm", label: "ATM", kind: "atm", side: "atm" }, ...call];
}

const KEY_HINTS = [[["[", "]"], "expiry"], [["J", "K"], "strike"], [["←", "→"], "on the smile"], [["G"], "ATM"], [["X"], "x-axis"], [["C"], "compare"], [["P"], "pause"], [["R"], "refresh"], [["Esc"], "clear"]];
const X_AXES = [["strike", "Strike"], ["m", "Mny %"], ["delta", "Δ"]];
const RANGES = [["10", "ATM ±10"], ["20", "ATM ±20"], ["all", "All loaded"]];
const historyCache = new Map(); // underlying -> { closes, at, error }

/** A small sparkline <svg> of a smile ({ m, iv }[]) on a shared IV scale: violet line, a fg tick at the forward. */
function sparkSvg(list, { w, h: ht, lo, hi, mlo, mhi }) {
  const svg = svgEl("svg", { class: "vol-spark", viewBox: `0 0 ${w} ${ht}`, width: w, height: ht, "aria-hidden": "true" });
  if (!list.length || !(hi > lo) || !(mhi > mlo)) return svg;
  const X = (m) => 1 + ((m - mlo) / (mhi - mlo)) * (w - 2);
  const Y = (v) => 2 + (1 - (v - lo) / (hi - lo)) * (ht - 4);
  const d = list.map((p, i) => `${i ? "L" : "M"}${Math.round(X(p.m) * 10) / 10} ${Math.round(Y(p.iv) * 10) / 10}`).join("");
  const fx = Math.round(X(0) * 10) / 10;
  svg.append(svgEl("line", { class: "f", x1: fx, x2: fx, y1: 1, y2: ht - 1 }), svgEl("path", { d }));
  return svg;
}

/**
 * @param {{ st: object, save: () => void, selectExpiry: (e: string) => void, refresh: () => void, retry: () => void }} o
 */
export function createVolPage({ st, save, selectExpiry, retry }) {
  const cfg = () => st.vol;
  /** The rate in % a year: the user's override, else the reference rate (refRate of the page's bundle). */
  const ratePct = () => cfg().rate ?? refRate(st.ref).value * 100;
  const cache = new Map(); // expiry -> { chain, at, asOf, error, loading }
  const rowMemo = new WeakMap(); // chain -> { sig, row }
  const queue = [];
  let active = 0;
  let volSeq = 0;
  let destroyed = false;
  let closePop = null; // closes the open Customise popover
  let optsPop = null; // the phone "Chart options" sheet
  let ticks = 0;
  let futQuotes = new Map();
  let hvMemo = { closes: null };
  let arbMemo = { chain: null };
  let hl = null; // pinned strike (keyboard, tap, scrub end)
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
  const device = () => (media(MQ_PHONE) ? "phone" : media(MQ_NARROW) ? "tablet" : "desktop");

  // ── KPI strip (built once, patched; micro-visuals under the values) ──
  const TILES = [
    ["fwd", "Forward", null],
    ["iv", "ATM IV", "pos"],
    ["move", "1σ move", "range"],
    ["straddle", "Straddle", null],
    ["rr", "25Δ RR (P−C)", "cz"],
    ["bf", "25Δ fly", null],
    ["hv", "IV − HV20", "two"],
    ["rank", "IV rank", null],
  ];
  /** A 4 px micro-visual track: segments and markers are full-width layers moved with transforms (they animate). */
  function microVisual(kind) {
    if (!kind) return null;
    const el = h("span", { class: `vol-mv mv-${kind}`, "aria-hidden": "true" });
    const parts = {};
    const layer = (name, cls) => {
      const x = h("i", { class: cls });
      el.append(x);
      parts[name] = x;
    };
    if (kind === "cz") layer("mid", "mid");
    if (kind === "range" || kind === "cz" || kind === "two") layer("seg", "seg");
    if (kind === "range") layer("f", "mk f");
    if (kind === "pos") layer("m", "mk iv");
    if (kind === "two") {
      layer("hv", "mk hv");
      layer("iv", "mk iv");
    }
    el.__parts = parts;
    return el;
  }
  const seg = (el, a, b) => {
    if (!el) return;
    const lo = clamp01(Math.min(a, b));
    const w = Math.max(0.004, clamp01(Math.max(a, b)) - lo);
    const t = `translateX(${Math.round(lo * 1000) / 10}%) scaleX(${Math.round(w * 1000) / 1000})`;
    if (el.style.transform !== t) el.style.transform = t;
  };
  const emptyMv = (el, on) => {
    if (!el) return;
    if (on && !("empty" in el.dataset)) el.dataset.empty = "";
    else if (!on && "empty" in el.dataset) delete el.dataset.empty;
  };
  const mk = (el, a) => {
    if (!el) return;
    const t = `translateX(${Math.round(clamp01(a) * 1000) / 10}%)`;
    if (el.style.transform !== t) el.style.transform = t;
  };
  const tiles = new Map(
    TILES.map(([k, label, mv]) => {
      const valueEl = h("span", { class: "value" }, DASH);
      const mvEl = microVisual(mv);
      const sub = h("span", { class: "sub" }, " ");
      const el = h("div", { class: `desk-stat vol-t-${k}`, role: "group", "aria-label": label }, h("span", { class: "label" }, label), valueEl, mvEl, sub);
      return [k, { el, value: valueEl, sub, mv: mvEl, sig: "", num: null, painted: false }];
    }),
  );
  function setTile(k, { value = DASH, sub = "", title = "", aria = null, cls = "", tone = "", n = null, fmt = null } = {}) {
    const t = tiles.get(k);
    const sig = JSON.stringify([value, sub, title, aria, cls, tone]);
    if (t.sig === sig) return;
    t.sig = sig;
    // First paint counts up; a later change flashes (green up, red down) instead.
    if (n !== null && fmt && !t.painted && !reducedMotion()) countUp(t.value, 0, n, fmt, value);
    else {
      stopCount(t.value);
      if (t.value.textContent !== value) t.value.textContent = value;
      if (n !== null && t.num !== null && n !== t.num && t.painted) flashValue(t.value, n > t.num ? "up" : "down");
    }
    if (n !== null) {
      t.num = n;
      t.painted = true;
    }
    // A narrow tile wraps between parts; the dot stays at the end of the first line, never leading the next.
    if (sub && sub.includes(" · ")) t.sub.replaceChildren(...sub.split(" · ").map((sg, i, all) => h("span", { class: "seg" }, i < all.length - 1 ? `${sg} ·` : sg)));
    else t.sub.textContent = sub || " ";
    if (sub) t.sub.title = sub;
    else t.sub.removeAttribute("title");
    t.el.title = title;
    t.el.setAttribute("aria-label", aria ?? `${TILES.find((x) => x[0] === k)[1]}: ${value}`);
    t.el.className = `desk-stat vol-t-${k}${cls ? ` ${cls}` : ""}`;
    t.value.className = `value${tone ? ` ${tone}` : ""}`;
  }
  const tilesRow = h("div", { class: "desk-stats vol-tiles" }, [...tiles.values()].map((t) => t.el));
  const explain = explainBox("vol");
  const kpiEl = h("section", { class: "desk-panel vol-kpi", "data-panel": "vol-kpi", "aria-label": "Volatility summary" }, tilesRow, explain.el);
  // IV rank for the explanation: the vol service's memory summary (no broker call), once per underlying.
  const rankMemo = new Map();
  function rankOf(u) {
    if (!u) return null;
    if (!rankMemo.has(u)) {
      rankMemo.set(u, null);
      optional(api(`/v1/vol/summary?underlyings=${encodeURIComponent(u)}`)).then((r) => {
        const it = r.data?.data?.items?.[0];
        if (it?.available) rankMemo.set(u, { ivr: it.ivr ?? null, ivp: it.ivp ?? null });
      });
    }
    return rankMemo.get(u);
  }
  // Phones scroll the tiles sideways: a fade shows only on a side with more tiles (its size settles once mounted).
  edgeFades(tilesRow);

  // ── Curves: smile and term (one capsule on phones: Smile | Term | Surface) ──
  const xSeg = segmented("Smile x-axis", X_AXES, cfg().x);
  xSeg.classList.add("vol-x");
  xSeg.addEventListener("change", () => xSeg.value !== cfg().x && setX(xSeg.value));
  const SERIES_MENU = [["otm", "OTM composite"], ["ce", "CE IV"], ["pe", "PE IV"], ["ba", "Bid/ask band"], ["oi", "OI strip"]];
  const seriesBox = (k, label) => {
    const i = h("input", { type: "checkbox", checked: cfg().series[k], "data-k": k });
    i.addEventListener("change", () => setSeries(k, i.checked));
    return h("label", { class: "vol-check" }, i, label);
  };
  const seriesMenu = h("details", { class: "vol-menu" }, h("summary", { class: "small", "aria-label": "Series to draw" }, "Series"), h("div", { class: "vol-menu-body" }, SERIES_MENU.map(([k, t]) => seriesBox(k, t))));
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
  // The compare select's closed label is "Compare" or "vs 10 Nov" (short, never clipped).
  const compareSel = h("select", { "aria-label": "Compare with", class: "vol-compare" }, h("option", { value: "none" }, "Compare"), h("option", { value: "next" }, "Next expiry"), h("option", { value: "monthly" }, "Monthly"));
  compareSel.value = cfg().compare;
  compareSel.addEventListener("change", () => setCompare(compareSel.value));
  const tabSeg = segmented("Curve", [["smile", "Smile"], ["term", "Term"], ["surface", "Surface"]], cfg().tab);
  tabSeg.classList.add("vol-tab");
  tabSeg.addEventListener("change", () => tabSeg.value !== cfg().tab && setCfg({ tab: tabSeg.value }));
  const moreBtn = h("button", { type: "button", class: "icon-btn vol-more-btn", "aria-label": "Chart options", "aria-haspopup": "dialog", "aria-expanded": "false" }, icon("more"));
  moreBtn.addEventListener("click", () => openChartOptions());
  const chip = (cls, label, title, on, onClick) => {
    const b = h("button", { type: "button", class: `small chip-btn multi ${cls}`, "aria-pressed": String(on), title }, label);
    b.addEventListener("click", onClick);
    return b;
  };
  const wingsBtn = chip("vol-wings", "25Δ wings", "Add the 25-delta put and call IV per expiry", cfg().series.wings, () => setSeries("wings", !cfg().series.wings));
  const hvBtn = chip("vol-hv", "HV20", "20-day realised vol as a reference line", cfg().series.hv, () => setSeries("hv", !cfg().series.hv));
  const smileTitle = h("span", { class: "vol-sub" });
  const live = h("p", { class: "sr-only", "aria-live": "polite" });
  const chartKeys = h("p", { class: "sr-only", id: "vol-chart-keys" }, "Left and right arrows step through the points, Home and End jump to the ends, Enter selects, Escape clears.");
  const smileLegend = h("div", { class: "vol-legend-row" });
  const smileHost = h("div", { class: "vol-plot smile-plot" });
  const smileSkel = h("div", { class: "vol-skel-host", hidden: true });
  const smileDock = h("div", { class: "vol-dock", "aria-hidden": "true" });
  const shapeEl = h("span", { class: "vol-sub vol-shape" });
  const termLegend = h("div", { class: "vol-legend-row" });
  const termHost = h("div", { class: "vol-plot term-plot" });
  const termDock = h("div", { class: "vol-dock", "aria-hidden": "true" });
  const curvesMsg = h("div", { class: "vol-msg", hidden: true });
  const surfSlot = h("div", { class: "vol-surf-slot" });
  const smileBox = h(
    "div",
    { class: "vol-curve vol-smile" },
    h("div", { class: "vol-curve-head" }, h("div", { class: "vol-title" }, h("strong", {}, "Smile"), smileTitle), h("div", { class: "vol-ctl" }, xSeg, seriesMenu, rangeSel, compareSel)),
    smileLegend,
    smileHost,
    smileDock,
  );
  smileHost.append(smileSkel);
  const termBox = h("div", { class: "vol-curve vol-termc" }, h("div", { class: "vol-curve-head" }, h("div", { class: "vol-title" }, h("strong", {}, "Term structure"), shapeEl), h("div", { class: "vol-ctl" }, wingsBtn, hvBtn)), termLegend, termHost, termDock);
  const curvesEl = h(
    "section",
    { class: "desk-panel vol-curves", "data-panel": "vol-curves", "aria-label": "Smile and term structure" },
    h("div", { class: "vol-tabbar" }, tabSeg, moreBtn),
    curvesMsg,
    h("div", { class: "vol-curve-grid" }, smileBox, termBox, surfSlot),
    live,
    chartKeys,
  );
  const smile = smileChart(smileHost, { label: "Smile" });
  const term = termChart(termHost, { label: "Term structure" });
  for (const c of [smile, term]) c.svg.setAttribute("aria-describedby", "vol-chart-keys");

  // ── IV surface: expiries × delta (or moneyness) buckets, sequential violet heat or "vs ATM" diverging ──
  const surfModeSeg = segmented("Surface columns", [["delta", "Δ"], ["mny", "Mny %"]], cfg().surf.mode);
  surfModeSeg.classList.add("vol-surf-mode");
  surfModeSeg.addEventListener("change", () => surfModeSeg.value !== cfg().surf.mode && setCfg({ surf: { ...cfg().surf, mode: surfModeSeg.value } }));
  const vsAtmBtn = chip("vol-vsatm", "vs ATM", "Show each cell as IV minus that expiry's ATM IV", cfg().surf.vsAtm, () => setCfg({ surf: { ...cfg().surf, vsAtm: !cfg().surf.vsAtm } }));
  const surfSub = h("span", { class: "vol-sub" });
  const surfHead = h("thead");
  const surfBody = h("tbody");
  const surfTable = h("table", { class: "vol-table vol-surf-table" }, surfHead, surfBody);
  const surfTip = h("div", { class: "vol-tip vol-surf-tip", "aria-hidden": "true" });
  const surfWrap = h("div", { class: "vol-surf-wrap" }, surfTable, surfTip);
  const surfLegend = h("div", { class: "vol-ramp" });
  const surfCtl = h("div", { class: "vol-ctl vol-surf-ctl" }, surfModeSeg, vsAtmBtn);
  const surfBox = h("div", { class: "vol-surf-box" }, surfWrap, surfLegend);
  const surfHeadEl = h("div", { class: "panel-head" }, h("div", { class: "vol-title" }, h("strong", {}, "IV surface"), surfSub), surfCtl);
  const surfaceEl = h("section", { class: "desk-panel vol-surface", "data-panel": "vol-surface", "aria-label": "IV surface" }, surfHeadEl, surfBox);
  surfTable.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const retryBtn = t?.closest("[data-retry]");
    if (retryBtn) return retryTerm(retryBtn.dataset.retry);
    const tr = t?.closest("tr[data-e]");
    if (tr && !tr.classList.contains("pending") && tr.dataset.e !== st.expiry) selectExpiry(tr.dataset.e);
  });
  surfTable.addEventListener("keydown", (e) => {
    const tr = e.target instanceof Element ? e.target.closest("tr[data-e]") : null;
    if (!tr || e.target !== tr || e.key !== "Enter") return;
    e.preventDefault();
    if (tr.dataset.e !== st.expiry) selectExpiry(tr.dataset.e);
  });
  surfTable.addEventListener("pointerover", (e) => surfHover(e.target instanceof Element ? e.target.closest("td[data-c]") : null));
  surfTable.addEventListener("pointerleave", () => surfHover(null));

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
  // Bid/ask IV in the table switches the smile's bid/ask band on with it (and off again).
  bidAskBtn.addEventListener("click", () => setCfg({ bidAsk: !cfg().bidAsk, series: { ...cfg().series, ba: !cfg().bidAsk } }));
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
    if (tr) setHl(Number(tr.dataset.k) === hl ? null : Number(tr.dataset.k));
  });
  // A press outside the smile and the strikes table lets go of a pinned strike.
  const outsidePin = (e) => {
    if (hl === null || !(e.target instanceof Node)) return;
    if (smileHost.contains(e.target) || strikesTable.contains(e.target) || smileDock.contains(e.target)) return;
    setHl(null);
  };
  document.addEventListener("pointerdown", outsidePin, true);

  // ── Read + arbitrage ──
  const readBody = h("div", { class: "vol-personas" });
  const arbBody = h("div", { class: "vol-arb" });
  const readEl = h(
    "section",
    { class: "desk-panel vol-read", "data-panel": "vol-read", "aria-label": "Read and arbitrage checks" },
    h("div", { class: "vol-read-grid" }, h("div", { class: "vol-read-col" }, h("div", { class: "panel-head" }, h("div", { class: "vol-title" }, h("strong", {}, "Read"), h("span", { class: "vol-sub" }, "By trader type"))), readBody), h("div", { class: "vol-read-col" }, h("div", { class: "panel-head" }, h("div", { class: "vol-title" }, h("strong", {}, "Arbitrage checks"), h("span", { class: "vol-sub" }, "At bid/ask, this expiry"))), arbBody)),
  );

  // ── Chart engine slot (ATM IV and HV20 over time: the owner's engine plugs in here). No engine, no panel. ──
  const historySlot = chartSlot("ATM IV and HV20 over time", "Will show the daily ATM IV of the front expiry against 20-day realised vol");
  const historyEl = historySlot
    ? h(
        "section",
        { class: "desk-panel vol-history", "data-panel": "vol-history", "aria-label": "ATM IV and HV20 over time" },
        h("div", { class: "panel-head" }, h("div", { class: "vol-title" }, h("strong", {}, "ATM IV and HV20 over time"), h("span", { class: "vol-sub" }, "Chart engine slot"))),
        historySlot,
      )
    : null;

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
        h("li", { class: "vol-clock-line" }, clockNote().join(" ")),
        h("li", { class: "vol-rate-line" }, ""),
        h("li", {}, "Forward: the median of K + (C − P)·e^(r·T_cal) over the 5 two-sided strikes nearest the forward (T_cal: calendar time)."),
        h("li", {}, "IV: Black-76 on that forward, from the bid–ask mid. LTP only when there is no two-sided quote (hollow points)."),
        h("li", {}, "Broker IVs are not used. The Option Chain's IV column comes from the same Black-76 engine on the same clock (ivModel=b76-forward), so the two agree."),
        h("li", {}, "ATM IV: linear in strike at the forward. Deltas: Black-76 forward deltas at each strike's own OTM IV."),
        h("li", {}, "IV surface: delta columns read the OTM smile at that forward delta; moneyness columns are linear in K/F."),
        h("li", {}, "Risk reversal sign: put minus call (Deribit and CME quote call minus put)."),
        h("li", {}, "HV: daily log returns of completed sessions, sample stdev, √252 (trading days)."),
        h("li", {}, "IV rank: (current − lowest) ÷ (highest − lowest) × 100 over the lookback. IV percentile: the share of days in the lookback with IV below current. Basis: 30-day constant-maturity ATM IV from the Bridge's daily vol store (GET /v1/vol/rank)."),
        h("li", {}, "Probabilities (bands, chance figures) are model values; calibration: not yet measured."),
        methodSrc,
        methodAge,
      ),
    ),
  );

  // ── Settings ──
  let axisBeforeCompare = null;
  function setCfg(patch) {
    st.vol = volConfig({ ...cfg(), ...patch });
    save();
    syncControls();
    enqueueMissing();
    draw();
  }
  function setSeries(k, on) {
    setCfg({ series: { ...cfg().series, [k]: on } });
  }
  function setX(x) {
    axisBeforeCompare = null;
    if (x === "strike" && cfg().compare !== "none") return setCfg({ x, compare: "none" });
    setCfg({ x });
  }
  // Compare is drawn in moneyness (two expiries share no strikes' meaning). A forced Strike → Mny % switch is named
  // in the legend and undone when Compare goes back to none.
  function setCompare(v) {
    if (v !== "none" && cfg().x === "strike") {
      axisBeforeCompare = "strike";
      toast("Compare uses Mny %");
      return setCfg({ compare: v, x: "m" });
    }
    if (v === "none" && axisBeforeCompare && cfg().x === "m") {
      const x = axisBeforeCompare;
      axisBeforeCompare = null;
      return setCfg({ compare: v, x });
    }
    setCfg({ compare: v });
  }
  function syncControls() {
    const c = cfg();
    if (xSeg.value !== c.x) xSeg.value = c.x;
    if (tabSeg.value !== c.tab) tabSeg.value = c.tab;
    if (surfModeSeg.value !== c.surf.mode) surfModeSeg.value = c.surf.mode;
    rangeSel.value = c.range;
    compareSel.value = c.compare;
    wingsBtn.setAttribute("aria-pressed", String(c.series.wings));
    hvBtn.setAttribute("aria-pressed", String(c.series.hv));
    vsAtmBtn.setAttribute("aria-pressed", String(c.surf.vsAtm));
    bidAskBtn.setAttribute("aria-pressed", String(c.bidAsk));
    for (const box of seriesMenu.querySelectorAll("input[data-k]")) if (box.checked !== c.series[box.dataset.k]) box.checked = c.series[box.dataset.k];
    curvesEl.classList.toggle("tab-term", c.tab === "term");
    curvesEl.classList.toggle("tab-surface", c.tab === "surface");
  }
  syncControls();

  /** Phones: every smile / term control in one sheet, so the curves head is a single capsule bar. */
  function openChartOptions() {
    if (optsPop) return optsPop.close();
    const body = h("div", { class: "vol-opts" });
    const render = () => {
      const c = cfg();
      const seg = (label, opts, value, onPick) => {
        const sg = segmented(label, opts, value);
        sg.addEventListener("change", () => {
          onPick(sg.value);
          render();
        });
        return h("section", {}, h("h3", {}, label), sg);
      };
      const sw = (label, on, onToggle, sub = "") => {
        const i = h("input", { type: "checkbox", checked: on });
        i.addEventListener("change", () => {
          onToggle(i.checked);
          render();
        });
        return h("label", { class: "vol-check" }, i, h("span", {}, label, sub ? h("small", {}, sub) : null));
      };
      // Rebuilding drops the focused control: put focus back on the same control (same order every render), so a
      // keyboard or switch user stays inside the sheet.
      const ctl = () => [...body.querySelectorAll("button, input")];
      const fi = body.contains(document.activeElement) ? ctl().indexOf(document.activeElement) : -1;
      body.replaceChildren(
        seg("Smile x-axis", X_AXES, c.x, (v) => setX(v)),
        h("section", {}, h("h3", {}, "Series"), SERIES_MENU.map(([k, t]) => sw(t, c.series[k], (on) => setSeries(k, on)))),
        seg("Strikes", [["10", "±10"], ["20", "±20"], ["all", "All"]], c.range, (v) => setCfg({ range: v })),
        seg("Compare", [["none", "None"], ["next", "Next"], ["monthly", "Monthly"]], c.compare, (v) => setCompare(v)),
        h("section", {}, h("h3", {}, "Term structure"), sw("25Δ wings", c.series.wings, (on) => setSeries("wings", on), "Put and call 25-delta IV per expiry"), sw("HV20 line", c.series.hv, (on) => setSeries("hv", on), "20-day realised vol")),
      );
      if (fi >= 0) {
        const list = ctl();
        // A segmented control's focus belongs on its selected button (the arrow keys moved the selection).
        const el = list[fi];
        const grp = el?.closest(".segmented");
        (grp?.querySelector('button[aria-checked="true"], button[aria-pressed="true"], button.on') ?? el)?.focus();
      }
    };
    render();
    moreBtn.setAttribute("aria-expanded", "true");
    optsPop = sheetPopover({ trigger: moreBtn, title: "Chart options", body, cls: "vol-opts-sheet", onClose: () => (optsPop = null) });
  }

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
      // Empty = the reference rate (its value is the placeholder); a number overrides it for this page only.
      const rate = h("input", { type: "number", min: "0", max: "15", step: "0.25", value: c.rate === null ? "" : String(c.rate), placeholder: formatFixed(refRate(st.ref).value * 100, 2), inputmode: "decimal", "aria-label": "Rate, percent a year (empty: the reference rate)", class: "vol-rate" });
      rate.addEventListener("change", () => {
        const v = Number(rate.value);
        if (rate.value === "") setCfg({ rate: null });
        else if (Number.isFinite(v) && v >= 0 && v <= 15) setCfg({ rate: v });
        else rate.value = cfg().rate === null ? "" : String(cfg().rate);
      });
      body.replaceChildren(
        h("section", {}, h("h3", {}, "Expiries loaded ", h("small", {}, "from the nearest")), seg("Expiries loaded", [[4, "4"], [6, "6"], [8, "8"], [12, "12"]].map(([v, t]) => [String(v), t]), String(c.expiries), (v) => setCfg({ expiries: Number(v) }))),
        h("section", {}, h("h3", {}, "Hedge put ", h("small", {}, "strike as % of the forward")), seg("Hedge put", [["95", "95%"], ["97", "97%"], ["99", "99%"]], String(c.hedgePct), (v) => setCfg({ hedgePct: Number(v) }))),
        h("section", {}, h("h3", {}, "Prices ", h("small", {}, "LTP to compare; mids are the default")), seg("Prices", [["mid", "Mid"], ["ltp", "LTP"]], c.basis, (v) => setCfg({ basis: v }))),
        h("section", {}, h("label", { class: "vol-rate-row" }, h("span", {}, "Rate ", h("small", {}, "% a year, for discounting and the forward; empty uses the Market calendar rate")), rate)),
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
        h("button", { type: "button", class: "small plain reset", onclick: () => { st.vol = volConfig({ x: cfg().x, tab: cfg().tab, series: cfg().series, range: cfg().range, compare: cfg().compare, bidAsk: cfg().bidAsk, surf: cfg().surf }); setCfg({}); render(); } }, icon("refresh"), "Reset"),
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
  function retryTerm(ex) {
    if (ex === st.expiry) return retry();
    const ent = cache.get(ex);
    if (ent) ent.error = null;
    enqueue([ex]);
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
    const days = O.timeToExpiry(e, Date.now(), refSession(st.ref).close).days;
    if (!step || !F || days === null) return TERM_STRIKES;
    let iv = null;
    for (const x of termList()) {
      const c = x === st.expiry ? ref : cache.get(x)?.chain;
      const row = c ? rowMemo.get(c)?.row : null;
      if (row?.atmIv) iv = row.atmIv;
      if (x === e) break;
    }
    const need = Math.ceil((2.2 * F * ((iv ?? 20) / 100) * Math.sqrt(Math.max(0, O.yearsToExpiry(e, Date.now(), refSession(st.ref).close) ?? 0))) / step);
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
    const sig = `${ratePct()}|${refSession(st.ref).close}|${c.basis}|${c.hedgePct}|${monthly}|${futKey}`;
    const hit = rowMemo.get(chain);
    if (hit && hit.sig === sig) return hit.row;
    const row = O.termRow(chain, { rate: ratePct() / 100, basis: c.basis, hedgePct: c.hedgePct, monthly, fut, close: refSession(st.ref).close });
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
    // Discounting is interest: calendar time (Tcal), not the vol-time T.
    const T = sel ? Math.max(sel.years ?? 0, 0) : null;
    const Tcal = sel ? (sel.Tcal ?? 0) : null;
    const df = Tcal !== null ? Math.exp((-ratePct() / 100) * Tcal) : 1;
    const two = (leg) => ["mid", "wide"].includes(O.legPrice(leg).q);
    const twoSided = chain ? chain.rows.some((r) => two(r.ce) || two(r.pe)) : false;
    // The checks rerun only when a bid or ask (or the term IVs) changed, not on every new chain object.
    const quotes = chain ? chain.rows.map((x) => `${x.strike}:${x.ce?.bid},${x.ce?.ask},${x.pe?.bid},${x.pe?.ask}`).join(";") : "";
    const arbSig = `${ratePct()}|${T === null ? "" : Math.round(T * 8760)}|${chain?.expiry}|${twoSided}|${rows.map((r) => `${r.expiry}:${r.atmIv === null ? "" : Math.round(r.atmIv * 100)}`).join()}|${quotes}`;
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
  const dteText = (e) => O.expiryTag(e, st.expiries).days;

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
    for (const el of [kpiEl, surfaceEl, termEl, strikesEl, readEl, historyEl, methodEl]) if (el && el.hidden !== none) el.hidden = none;
    curvesEl.classList.toggle("no-exp", none);
    lap("kpi", () => drawKpi(m));
    lap("curves", () => drawCurves(m));
    lap("surface", () => drawSurface(m));
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
    kpiEl.classList.toggle("loading", !r);
    if (!r) {
      for (const [k] of TILES) if (k !== "rank") setTile(k, { cls: "skel-t" });
      drawRank();
      return;
    }
    setTile("fwd", {
      value: formatFixed(r.F, 1),
      sub: r.source === "spot" ? "F = spot (no two-sided ATM quotes)" : `Spot ${formatFixed(r.spot, 1)} · basis ${formatSigned(r.basis, 1)}`,
      title: "Put-call parity forward: median of K + (C − P)·e^(rT) over the 3 two-sided strikes nearest spot",
    });
    setTile("iv", { value: formatPercent(r.atmIv, 1), sub: `CE ${formatFixed(r.ceIv, 1)} · PE ${formatFixed(r.peIv, 1)}`, tone: "ink-iv", n: r.atmIv, fmt: (v) => formatPercent(v, 1), title: r.atmIv === null ? "No usable ATM quotes" : `ATM IV linear in strike at the forward; CE and PE at the ${formatInt(r.atmStrike)} strike. The marker places it between the lowest and highest ATM IV of the loaded expiries` });
    const ivs = m.rows.map((x) => x.atmIv).filter((v) => v !== null);
    const lo = Math.min(...ivs);
    const hi = Math.max(...ivs);
    const ivMv = tiles.get("iv").mv.__parts;
    mk(ivMv.m, r.atmIv === null || !(hi > lo) ? 0.5 : (r.atmIv - lo) / (hi - lo));
    setTile("move", {
      value: r.move === null ? DASH : `±${formatInt(r.move)}`,
      sub: r.move === null ? "" : `${formatPercent(r.movePct, 2)} · ${formatInt(r.lo)}–${formatInt(r.hi)}`,
      n: r.move,
      fmt: (v) => `±${formatInt(v)}`,
      title: "Log-normal 1σ to expiry at ATM IV: about 68% of outcomes land inside. The bar is the strikes in range, the band the 1σ range, the tick the forward",
    });
    const pr = rangePoints(r);
    const k0 = pr[0]?.strike ?? null;
    const k1 = pr[pr.length - 1]?.strike ?? null;
    const mv = tiles.get("move").mv.__parts;
    // No range: hide the layers (data-empty) rather than leave another expiry's segment on screen.
    const moveOk = k0 !== null && k1 > k0 && r.lo !== null;
    emptyMv(tiles.get("move").mv, !moveOk);
    if (moveOk) {
      seg(mv.seg, (r.lo - k0) / (k1 - k0), (r.hi - k0) / (k1 - k0));
      mk(mv.f, (r.F - k0) / (k1 - k0));
    }
    setTile("straddle", {
      value: formatFixed(r.straddle, 2),
      sub: r.straddle === null ? "" : `${formatRupee(r.rupee, 0)} a lot · ÷1σ ${formatFixed(r.ratio, 2)}`,
      n: r.straddle,
      fmt: (v) => formatFixed(v, 2),
      title: `ATM (${formatInt(r.atmStrike)}) call + put. Straddle ÷ 1σ move is about 0.80 in log-normal theory`,
    });
    const rr = r.rr25;
    setTile("rr", {
      value: rr === null ? "n/a" : pts(rr),
      sub: rr === null ? "Chain too narrow for 25Δ" : rr >= 0.5 ? "Puts richer" : rr <= -0.5 ? "Calls richer" : "Balanced",
      tone: rr === null ? "" : rr >= 0.5 ? "ink-put" : rr <= -0.5 ? "ink-call" : "",
      n: rr,
      title: "25-delta risk reversal, put minus call (Deribit and CME quote call minus put). The bar runs from the centre: left in the put colour, right in the call colour (±3 pts)",
      aria: rr === null ? "25-delta risk reversal: not available, chain too narrow" : `25-delta risk reversal, put minus call, ${rr >= 0 ? "plus" : "minus"} ${formatFixed(Math.abs(rr), 1)} vol points: ${rr >= 0.5 ? "puts richer" : rr <= -0.5 ? "calls richer" : "balanced"}`,
    });
    const czp = tiles.get("rr").mv.__parts;
    const rrf = rr === null ? 0 : Math.max(-1, Math.min(1, rr / 3));
    // Puts richer (RR > 0) leans left in the put colour; calls richer leans right.
    seg(czp.seg, 0.5, 0.5 - rrf / 2);
    tiles.get("rr").mv.dataset.side = rrf > 0 ? "put" : rrf < 0 ? "call" : "";
    const bf = r.bf25;
    setTile("bf", {
      value: bf === null ? "n/a" : pts(bf),
      sub: bf === null ? "Chain too narrow for 25Δ" : bf > 0.3 ? "Wings over ATM" : "Flat smile",
      title: "25-delta butterfly: mean of the 25-delta put and call IV, minus ATM IV",
      aria: bf === null ? "25-delta fly: not available" : `25-delta fly ${bf >= 0 ? "plus" : "minus"} ${formatFixed(Math.abs(bf), 1)} vol points`,
    });
    emptyMv(tiles.get("hv").mv, m.hv20 === null);
    if (m.hv20 === null) setTile("hv", { sub: m.hist?.loading && !m.hist?.closes ? "Loading daily history…" : "No daily history from this broker", title: "ATM IV minus 20-day realised vol of the index" });
    else {
      const vrp = r.atmIv === null ? null : r.atmIv - m.hv20;
      const step = vrp === null ? null : O.divStep(vrp, 10);
      setTile("hv", {
        value: vrp === null ? DASH : pts(vrp),
        sub: `HV20 ${formatPercent(m.hv20, 1)} · pctl ${m.hvp ? formatInt(m.hvp.pct) : "n/a"}`,
        tone: step === null || Math.abs(step) < 2 ? "" : step > 0 ? "ink-pos" : "ink-neg",
        n: vrp,
        title: `ATM IV minus 20-day realised vol (HV10 ${formatPercent(m.hv10, 1)}): positive means options price more movement than the index has shown. The bar marks HV20 (grey) and ATM IV (violet). The percentile is of realised, not implied, vol${m.hvp ? ` over ${formatInt(m.hvp.count)} sessions` : ": needs 120 sessions"}`,
        aria: `IV minus HV20 ${formatSigned(vrp, 1)} vol points, HV20 ${formatPercent(m.hv20, 1)}, realised percentile ${m.hvp ? formatInt(m.hvp.pct) : "not available"}`,
      });
      const tp = tiles.get("hv").mv.__parts;
      const top = Math.max(m.hv20, r.atmIv ?? 0) + 5;
      const a = m.hv20 / top;
      const b = (r.atmIv ?? m.hv20) / top;
      mk(tp.hv, a);
      mk(tp.iv, b);
      seg(tp.seg, a, b);
      tiles.get("hv").mv.dataset.lead = (r.atmIv ?? 0) >= m.hv20 ? "iv" : "hv";
    }
    drawRank();
    const rk = rankOf(m.chain?.underlying ?? null);
    explain.set(explainVol({ atmIv: r.atmIv, hv20: m.hv20, ivr: rk?.ivr ?? null, ivp: rk?.ivp ?? null, put25: r.skew?.put25?.iv ?? null, call25: r.skew?.call25?.iv ?? null, term: (m.rows ?? []).filter((x) => !x.dim) }));
  }
  function drawRank() {
    setTile("rank", { value: "Unavailable", sub: "Needs 252 days of IV history", cls: "na", title: "IV rank and IV percentile need a stored daily ATM IV. The Bridge does not record one yet.", aria: "IV rank: unavailable. Needs 252 days of stored IV history" });
  }

  // ── Legends (F§4.5): chips toggle a series (off = 35 %); swatches explain the rest ──
  function legendRow(host, items) {
    const sig = JSON.stringify(items.map((it) => [it.id, it.label, it.on, it.kind, it.dv, it.note]));
    if (host.__sig === sig) return;
    host.__sig = sig;
    const ul = h("ul", { class: "dv-legend vol-legend" });
    for (const it of items) {
      const key = it.kind === "dots" ? h("span", { class: "vol-key-dots", "aria-hidden": "true" }, h("i", { "data-dv": "put" }), h("i", { "data-dv": "call" })) : h("span", { class: `dv-key ${it.kind ?? ""} vk-${it.id}`.trim(), "aria-hidden": "true", "data-dv": it.dv });
      if (it.note) {
        ul.append(h("li", { class: "vol-legend-note" }, it.label));
        continue;
      }
      if (it.toggle) {
        const b = h("button", { type: "button", "aria-pressed": String(it.on !== false), title: `${it.on === false ? "Show" : "Hide"} ${it.label}` }, key, it.label);
        b.addEventListener("click", () => it.toggle(it.on === false));
        ul.append(h("li", {}, b));
      } else ul.append(h("li", { title: it.title }, key, h("span", {}, it.label)));
    }
    host.replaceChildren(ul);
    edgeFades(host);
  }

  // ── Curves ──
  let smileSig = "";
  let termSig = "";
  function drawCurves(m) {
    const d = dev();
    const c = cfg();
    const loading = !m.chain && !st.error && !st.empty;
    if (!m.chain && !loading) {
      curvesMsg.hidden = false;
      const sig = `${st.error ? "e" : "x"}|${st.error?.message ?? ""}`;
      if (curvesMsg.__sig !== sig) {
        curvesMsg.__sig = sig;
        curvesMsg.replaceChildren(st.error ? errorState(st.error, { onRetry: () => retry() }) : emptyState("clock", "No expiries", st.empty, null, { compact: true }));
      }
    } else curvesMsg.hidden = true;
    curvesEl.classList.toggle("no-chain", !m.chain);
    curvesEl.classList.toggle("loading", loading);
    const height = d.phone ? 220 : d.narrow ? 300 : 320;
    // Loading: a skeleton plot and legend at the final height (no jump when the curve lands).
    if (loading) {
      if (smileSkel.hidden || smileSkel.__h !== height) {
        smileSkel.__h = height;
        smileSkel.replaceChildren(plotSkeleton(height));
        smileSkel.hidden = false;
      }
      legendRow(smileLegend, [1, 2, 3].map((i) => ({ id: `sk${i}`, label: "", note: true })));
      smileLegend.classList.add("skel-legend");
      text(smileTitle, "");
    } else {
      smileSkel.hidden = true;
      smileLegend.classList.remove("skel-legend");
    }
    const r = m.sel;
    const cmp = r ? compareRow(m) : null;
    syncCompareLabels(m);
    if (r) {
      text(smileTitle, `${dayMon(r.expiry)} · ${r.dim ? "expiry day" : O.timeToExpiry(r.expiry, Date.now(), refSession(st.ref).close).label}${d.phone ? ` · ATM ${formatPercent(r.atmIv, 1)}` : ` · ${formatInt(rangePoints(r).length)} strikes`}`);
      const banners = [];
      if (!m.twoSided) banners.push("No live bid/ask: IVs from last traded prices");
      if (r.dim) banners.push("Expiry day: IV is unstable in the final hours");
      const pts0 = rangePoints(r);
      const width = boxW(smileHost, 640);
      const T = Math.max(r.years ?? 0, 0);
      // On the Δ axis a marker sits where the curve's own points do: interpolate the loaded (strike, call delta) pairs
      // (each at its strike's own IV); the ATM-IV delta is only the fallback outside the loaded strikes.
      const dPairs = r.points.filter((p) => p.callDelta !== null && p.callDelta !== undefined).map((p) => [p.strike, p.callDelta]).sort((a, b) => a[0] - b[0]);
      const deltaAt = (K) => {
        for (let i = 1; i < dPairs.length; i++) {
          const [ka, da] = dPairs[i - 1];
          const [kb, db] = dPairs[i];
          if (K >= ka && K <= kb) return kb === ka ? da : da + ((db - da) * (K - ka)) / (kb - ka);
        }
        return r.atmIv ? O.b76Delta(r.F, K, T, r.atmIv, "CE") ?? 0.5 : null;
      };
      const pos = (K) => {
        if (K === null || K === undefined || !r.F) return null;
        const cd = deltaAt(K);
        return { strike: K, m: (K / r.F - 1) * 100, delta: cd === null ? null : 1 - cd };
      };
      const steps = r.points.map((p) => p.strike);
      const step = steps.length > 1 ? Math.min(...steps.slice(1).map((k, i) => k - steps[i])) : null;
      const cmpPts = cmp ? cmp.points.filter((p) => inRange(p)) : null;
      const two = O.twoSigma(r.F, r.atmIv, r.years);
      const showSpot = r.spot !== null && step && Math.abs(r.F - r.spot) >= step / 2;
      const markers = { F: pos(r.F), lo: pos(r.lo), hi: pos(r.hi), lo2: two ? pos(two.lo) : null, hi2: two ? pos(two.hi) : null, spot: showSpot ? pos(r.spot) : null };
      const sk = r.skew;
      const skewTicks = [[sk.put10, "10ΔP", "put"], [sk.put25, "25ΔP", "put"], [sk.call25, "25ΔC", "call"], [sk.call10, "10ΔC", "call"]].filter(([x]) => x).map(([x, label, side]) => ({ pos: pos(x.strike), label, side }));
      const oi = c.series.oi && m.chain ? m.chain.rows.filter((x) => pts0.some((p) => p.strike === x.strike)).map((x) => ({ strike: x.strike, ce: num(x.ce?.oi) ?? 0, pe: num(x.pe?.oi) ?? 0 })) : null;
      // Smaller than 0.01 vol point or 0.1 index point does not count as a change (no tween for nothing).
      const q = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
      const qp = (p) => ({ strike: p.strike, m: q(p.m), callDelta: q(p.callDelta), otm: p.otm ? { side: p.otm.side, iv: q(p.otm.iv), q: p.otm.q } : null, ce: p.ce ? { iv: q(p.ce.iv), q: p.ce.q, bidIv: q(p.ce.bidIv), askIv: q(p.ce.askIv) } : null, pe: p.pe ? { iv: q(p.pe.iv), q: p.pe.q, bidIv: q(p.pe.bidIv), askIv: q(p.pe.askIv) } : null });
      const qm = (x) => (x ? { strike: q(x.strike), m: q(x.m), delta: q(x.delta) } : null);
      const data = {
        key: `${st.underlying}|${r.expiry}`,
        points: pts0.map(qp),
        step,
        atmStrike: r.atmStrike,
        markers: Object.fromEntries(Object.entries(markers).map(([k, v]) => [k, qm(v)])),
        pills: {
          atm: `ATM ${formatInt(r.atmStrike)} · ${showSpot ? formatPercent(r.atmIv, 1) : `${formatPercent(r.atmIv, 1)} · F≈S`}`,
          spot: showSpot ? `Spot ${formatFixed(r.spot, 1)}` : null,
          f: `F ${formatFixed(r.F, 1)}`,
          band: r.lo === null ? "±1σ" : `±1σ ${formatInt(r.lo)}–${formatInt(r.hi)}`,
        },
        skewTicks: skewTicks.map((t) => ({ ...t, pos: qm(t.pos) })),
        compare: cmp ? { points: cmpPts.map(qp), label: dayMon(cmp.expiry) } : null,
        oi,
      };
      const opts = { x: c.x, series: { otm: c.series.otm, ce: c.series.ce, pe: c.series.pe, ba: c.series.ba && m.twoSided, oi: c.series.oi }, width, height, coarse: d.coarse, docked: d.phone, dock: smileDock, label: smileLabel({ expiryLabel: dayMon(r.expiry), atmIv: r.atmIv, rr25: r.rr25, n: pts0.length }), empty: "No usable IV in this range", banners, onPick: pickFromSmile, tip: smileTip };
      const sig = JSON.stringify([data, { ...opts, onPick: 0, tip: 0, dock: 0 }]);
      if (sig !== smileSig) {
        smileSig = sig;
        smile.update(data, opts);
      }
      paintHighlight(false);
      // Legend: OTM / CE / PE toggles, the parity note when CE and PE sit on the OTM line, the bands and the dot sides.
      const coincide = c.series.ce && c.series.pe && pts0.every((p) => !p.otm || ((p.ce?.iv === null || p.ce?.iv === undefined || Math.abs(p.ce.iv - p.otm.iv) <= 0.1) && (p.pe?.iv === null || p.pe?.iv === undefined || Math.abs(p.pe.iv - p.otm.iv) <= 0.1)));
      const items = [
        { id: "otm", label: "OTM IV", kind: "line", dv: "iv", on: c.series.otm, toggle: (on) => setSeries("otm", on) },
        { id: "ce", label: "CE", kind: "dash", dv: "call", on: c.series.ce, toggle: (on) => setSeries("ce", on) },
        { id: "pe", label: "PE", kind: "dot", dv: "put", on: c.series.pe, toggle: (on) => setSeries("pe", on) },
        coincide ? { id: "parity", label: "CE ≈ PE (parity holds)", note: true } : null,
        cmp ? { id: "cmp", label: `vs ${dayMon(cmp.expiry)}`, kind: "dash", dv: "hv" } : null,
        cmp && axisBeforeCompare ? { id: "cmpaxis", label: "Compare uses Mny %", note: true } : null,
        { id: "band", label: "±1σ / ±2σ", kind: "band" },
        { id: "dots", label: "put / call priced", kind: "dots" },
        c.series.ba ? { id: "ba", label: m.twoSided ? "Bid/ask" : "Bid/ask (needs live quotes)", kind: "ribbon", dv: "iv", on: true, toggle: (on) => setSeries("ba", on) } : null,
        c.series.oi ? { id: "oi", label: "OI CE / PE", kind: "oi", on: true, toggle: (on) => setSeries("oi", on) } : null,
        r.skew.put25 ? null : { id: "narrow", label: "25Δ outside loaded strikes", note: true },
      ].filter(Boolean);
      legendRow(smileLegend, items);
    } else if (!loading) {
      text(smileTitle, "");
    }
    // Term curve.
    const loaded = m.items.filter((it) => it.row);
    const sh = m.shape;
    text(shapeEl, sh.kind === "insufficient" ? sh.label : `${sh.label} · ${formatSigned(sh.slope, 1)} pts`);
    shapeEl.classList.toggle("ink-warn", sh.kind === "backwardation");
    const allFailed = !loaded.length && m.items.length > 0 && m.items.every((it) => it.status === "error");
    const tw = boxW(termHost, 420);
    const th = d.phone ? 200 : d.narrow ? 200 : 320;
    const rows = m.items.map((it) => {
      const days = it.row?.days ?? O.timeToExpiry(it.e, Date.now(), refSession(st.ref).close).days;
      return it.row
        ? { expiry: it.e, days: Math.round(days * 100) / 100, atmIv: it.row.atmIv === null ? null : Math.round(it.row.atmIv * 100) / 100, dim: Boolean(it.row.dim), monthly: Boolean(it.row.monthly), skew: { put25: it.row.skew.put25 ? { iv: Math.round(it.row.skew.put25.iv * 100) / 100 } : null, call25: it.row.skew.call25 ? { iv: Math.round(it.row.skew.call25.iv * 100) / 100 } : null }, label: dayMon(it.e), dte: dteText(it.e), fwd: it.fwd ? { vol: it.fwd.vol === null ? null : Math.round(it.fwd.vol * 10) / 10, inverted: it.fwd.inverted } : null }
        : { expiry: it.e, days, atmIv: null, pending: it.status === "loading", label: dayMon(it.e), dte: dteText(it.e), monthly: O.isMonthly(it.e, st.expiries) };
    });
    const hvShown = c.series.hv && m.hv20 !== null;
    const topts = {
      selected: st.expiry,
      empty: allFailed ? "Couldn't load the chains" : "Loading expiries…",
      wings: c.series.wings,
      hv: m.hv20 === null ? null : Math.round(m.hv20 * 100) / 100,
      showHv: c.series.hv,
      width: tw,
      height: th,
      coarse: d.coarse,
      docked: d.phone,
      dock: termDock,
      label: `Term structure: ATM IV across ${formatInt(loaded.length)} expiries, ${sh.label}${pendingText(m.items)}`,
      onPick: (e) => e !== st.expiry && selectExpiry(e),
      tip: termTip,
      announce: (t) => text(live, t),
    };
    const tsig = JSON.stringify([rows, { ...topts, onPick: 0, tip: 0, dock: 0, announce: 0 }]);
    if (tsig !== termSig) {
      termSig = tsig;
      term.update(rows, topts);
    }
    legendRow(termLegend, [
      { id: "atm", label: "ATM IV", kind: "line", dv: "iv" },
      c.series.wings ? { id: "p25", label: "25ΔP", kind: "dot", dv: "put", on: true, toggle: (on) => setSeries("wings", on) } : null,
      c.series.wings ? { id: "c25", label: "25ΔC", kind: "dot", dv: "call", on: true, toggle: (on) => setSeries("wings", on) } : null,
      hvShown ? { id: "hv", label: "HV20", kind: "dash", dv: "hv", on: true, toggle: (on) => setSeries("hv", on) } : null,
      loaded.length > 1 ? { id: "fv", label: "fv = forward vol", note: true } : null,
    ].filter(Boolean));
    placeSurface();
  }
  /** Compare options read "vs 10 Nov" when that expiry is known (the select's closed label stays short). */
  function syncCompareLabels(m) {
    const i = m.items.findIndex((it) => it.e === st.expiry);
    const next = m.items.slice(i + 1).find((x) => x.row) ?? null;
    const mon = m.items.find((x) => x.row && x.e !== st.expiry && x.row.monthly) ?? null;
    const set = (v, t) => {
      const opt = compareSel.querySelector(`option[value="${v}"]`);
      if (opt && opt.textContent !== t) opt.textContent = t;
    };
    set("next", next ? `vs ${dayMon(next.e)}` : "Next expiry");
    set("monthly", mon ? `vs ${dayMon(mon.e)} (M)` : "Monthly");
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
  /** The 25Δ / 10Δ tags at a strike. */
  function tagsAt(k) {
    const sk = last?.sel?.skew;
    if (!sk) return [];
    return [[sk.put25, "25ΔP", "put"], [sk.call25, "25ΔC", "call"], [sk.put10, "10ΔP", "put"], [sk.call10, "10ΔC", "call"]].filter(([x]) => x && x.strike === k).map(([, t, side]) => [t, side]);
  }

  // Tooltip content (series values in their inks; the phone dock gets the same rows in two lines).
  const ink = (cls, t) => h("span", { class: cls }, t);
  function smileTip(p0, { cmpIv = null, atm = false } = {}) {
    const r = last?.sel;
    // The chart holds rounded copies; read the full point (deltas, prices) from the model.
    const p = r?.points.find((x) => x.strike === p0.strike) ?? p0;
    const iv = p.otm?.iv ?? null;
    const vs = iv !== null && r?.atmIv !== null && r?.atmIv !== undefined ? iv - r.atmIv : null;
    const tags = tagsAt(p.strike);
    const sideLeg = p.otm ? p[p.otm.side] : null;
    const two = sideLeg && sideLeg.bidIv !== null && sideLeg.askIv !== null && sideLeg.bidIv !== undefined && sideLeg.askIv !== undefined;
    const sideCls = p.otm?.side === "pe" ? "ink-put" : "ink-call";
    const dAbs = p.otm?.delta === null || p.otm?.delta === undefined ? null : Math.abs(p.otm.delta);
    const cmp0 = last ? compareRow(last) : null;
    if (dev().phone) {
      // The docked card: two fixed lines (no layout jump while scrubbing).
      return [
        h("div", { class: "dock-l" }, h("span", { class: "dock-k" }, h("b", {}, formatInt(p.strike)), atm ? h("span", { class: "tip-atm" }, "ATM") : null, ` · ${minus(formatSigned(p.m, 1))}%`, ...tags.map(([t, side]) => h("span", { class: `vol-chip ${side}` }, t))), h("span", {}, "OTM ", ink("ink-iv strong", formatPercent(iv, 1)))),
        h("div", { class: "dock-l sub" }, h("span", {}, "vs ATM ", h("b", {}, minus(formatSigned(vs, 1))), " · CE ", ink("ink-call", formatFixed(p.ce?.iv ?? null, 1)), " · PE ", ink("ink-put", formatFixed(p.pe?.iv ?? null, 1))), h("span", {}, cmp0 && cmpIv !== null ? `${dayMon(cmp0.expiry)} ${formatFixed(cmpIv, 1)}` : `|Δ| ${formatFixed(dAbs, 2)}`)),
      ];
    }
    const rows = [
      h("div", { class: "tip-h" }, h("b", {}, formatInt(p.strike)), atm ? h("span", { class: "tip-atm" }, "ATM") : null, ` · Mny ${minus(formatSigned(p.m, 1))}%`, ...tags.map(([t, side]) => h("span", { class: `vol-chip ${side}` }, t))),
      h("div", { class: "row" }, h("span", {}, "OTM IV ", ink("ink-iv strong", formatPercent(iv, 1))), h("span", {}, "vs ATM ", h("b", {}, minus(formatSigned(vs, 1))))),
      h("div", { class: "row" }, h("span", {}, "CE ", ink("ink-call", formatFixed(p.ce?.iv ?? null, 1)), " · PE ", ink("ink-put", formatFixed(p.pe?.iv ?? null, 1))), h("span", {}, "|Δ| ", formatFixed(dAbs, 2))),
    ];
    if (two) rows.push(h("div", { class: "row" }, h("span", {}, "Bid/ask IV"), h("span", {}, `${formatFixed(sideLeg.bidIv, 1)} – ${formatFixed(sideLeg.askIv, 1)}`)));
    if (sideLeg?.price !== null && sideLeg?.price !== undefined) rows.push(h("div", { class: "row" }, h("span", {}, "Prem"), ink(sideCls, `${formatFixed(sideLeg.price, 2)} (${p.otm.side.toUpperCase()})`)));
    if (cmp0 && cmpIv !== null) rows.push(h("div", { class: "row cmp" }, h("span", {}, dayMon(cmp0.expiry)), h("span", {}, `${formatPercent(cmpIv, 1)} (${minus(formatSigned(iv === null ? null : cmpIv - iv, 1))})`)));
    return rows;
  }
  function termTip(row) {
    const it = last?.items.find((x) => x.e === row.expiry);
    const r = it?.row;
    if (!r) return [h("div", { class: "tip-h" }, h("b", {}, row.label), ` · ${row.dte}`)];
    return [
      h("div", { class: "tip-h" }, h("b", {}, dayMon(r.expiry)), ` · ${dteText(r.expiry)}`, r.monthly ? h("span", { class: "tip-atm" }, "M") : null, r.expiry === st.expiry ? h("span", { class: "tip-sel" }, "selected") : null),
      h("div", { class: "row" }, h("span", {}, "ATM IV"), ink("ink-iv strong", formatPercent(r.atmIv, 1))),
      h("div", { class: "row" }, h("span", {}, "25ΔP ", ink("ink-put", formatFixed(r.skew.put25?.iv ?? null, 1)), " · 25ΔC ", ink("ink-call", formatFixed(r.skew.call25?.iv ?? null, 1)))),
      h("div", { class: "row" }, h("span", {}, "Fwd vol"), it.fwd?.inverted ? ink("ink-warn", "Inverted") : h("span", {}, formatPercent(it.fwd?.vol ?? null, 1))),
      h("div", { class: "row" }, h("span", {}, "1σ"), h("span", {}, r.move === null ? DASH : `±${formatInt(r.move)} (${formatPercent(r.movePct, 2)})`)),
    ];
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
    if (how === "unpin") return setHl(null);
    if (how === "tap") {
      if (k === null) return;
      return setHl(k === hl ? null : k, true);
    }
    if (k !== null) {
      hover = null;
      setHl(k, true);
    }
  }
  function paintHighlight(scroll) {
    const r = last?.sel;
    const k = hover ?? hl;
    smile.mark(k);
    for (const tr of strikesBody.querySelectorAll("tr.hl")) if (Number(tr.dataset.k) !== k) tr.classList.remove("hl");
    const row = k === null ? null : strikesBody.querySelector(`tr[data-k="${k}"]`);
    if (row && !row.classList.contains("hl")) row.classList.add("hl");
    if (scroll && row) scrollRow(row);
    // Screen readers: the highlighted strike, at most one announcement every 500 ms.
    const p = r && k !== null ? r.points.find((x) => x.strike === k) : null;
    const t = p ? `${formatInt(p.strike)}: moneyness ${formatSigned(p.m, 1)}%, OTM IV ${formatPercent(p.otm?.iv ?? null, 1)}, CE ${formatFixed(p.ce?.iv ?? null, 1)}, PE ${formatFixed(p.pe?.iv ?? null, 1)}` : "";
    clearTimeout(liveTimer);
    const announce = () => {
      liveAt = Date.now();
      text(live, t);
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

  // ── IV surface ──
  /** Phones show the surface under the curves capsule's Surface tab; wider screens in its own panel. */
  function placeSurface() {
    const phone = dev().phone;
    if (phone && surfBox.parentNode !== surfSlot) surfSlot.append(surfCtl, surfBox);
    else if (!phone && surfBox.parentNode !== surfaceEl) {
      surfHeadEl.append(surfCtl);
      surfaceEl.append(surfBox);
    }
  }
  let surfStruct = "";
  const surfRows = new Map(); // expiry -> { tr, cells: Map(colId -> td) }
  let surfCols = [];
  function drawSurface(m) {
    const c = cfg();
    const dv = device();
    surfCols = surfaceColumns(c.surf.mode, dv);
    const vsAtm = c.surf.vsAtm;
    text(surfSub, `${c.surf.mode === "delta" ? "Expiries × delta" : "Expiries × moneyness"} · ${vsAtm ? "pts over ATM" : "IV %"}`);
    const struct = JSON.stringify([m.items.map((it) => [it.e, it.status === "ok" ? "ok" : it.status]), surfCols.map((x) => x.id)]);
    if (struct !== surfStruct) {
      surfStruct = struct;
      surfHead.replaceChildren(h("tr", {}, h("th", { scope: "col", class: "lead" }, "Expiry"), surfCols.map((col) => h("th", { scope: "col", class: `num s-${col.side}`, "data-c": col.id }, col.label))));
      surfRows.clear();
      surfBody.replaceChildren(
        ...m.items.map((it) => {
          const monthly = O.isMonthly(it.e, st.expiries);
          const lead = h("th", { scope: "row", class: "lead" }, h("span", { class: "vol-exp" }, h("strong", {}, dayMon(it.e)), h("span", { class: "wd" }, dteText(it.e)), monthly ? h("span", { class: "m-tag", title: "Monthly expiry" }, "M") : null));
          const cells = new Map();
          const tr = h("tr", { "data-e": it.e, tabindex: it.status === "ok" ? "0" : undefined, class: it.status !== "ok" ? "pending" : undefined }, lead);
          if (it.status === "ok") {
            for (const col of surfCols) {
              const td = h("td", { class: "num", "data-c": col.id });
              cells.set(col.id, td);
              tr.append(td);
            }
          } else if (it.status === "error") {
            tr.append(h("td", { colspan: String(surfCols.length), class: "vol-status" }, h("span", { class: "vol-err" }, "Couldn't load · ", h("button", { type: "button", class: "small plain vol-retry", "data-retry": it.e }, icon("refresh"), "Retry"))));
          } else for (const col of surfCols) tr.append(h("td", { class: "num", "data-c": col.id }, h("span", { class: "skel vol-cell-skel" })));
          surfRows.set(it.e, { tr, cells });
          return tr;
        }),
      );
    }
    // Values, then one colour scale across every cell on screen (5th–95th percentile).
    const vals = [];
    for (const it of m.items) {
      if (!it.row) continue;
      const r = it.row;
      for (const col of surfCols) {
        let iv = null;
        let K = null;
        if (col.kind === "atm" && c.surf.mode === "delta") {
          iv = r.atmIv;
          K = r.atmStrike;
        } else if (col.kind === "put" || col.kind === "call") {
          const x = O.ivAtDelta(r.points, col.d);
          iv = x?.iv ?? null;
          K = x?.strike ?? null;
        } else {
          iv = O.ivAtMny(r.points, col.m);
          K = r.F ? r.F * (1 + col.m / 100) : null;
        }
        const v = iv === null ? null : vsAtm ? (r.atmIv === null ? null : iv - r.atmIv) : iv;
        vals.push({ e: it.e, col, iv, v, K, atm: r.atmIv, dim: r.dim });
      }
    }
    const nums = vals.map((x) => x.v).filter((v) => v !== null);
    const sc = O.scaleRange(nums);
    surfTable.classList.toggle("ivdiv", vsAtm);
    surfLegend.classList.toggle("ivdiv", vsAtm);
    for (const x of vals) {
      const td = surfRows.get(x.e)?.cells.get(x.col.id);
      if (!td) continue;
      const t = x.v === null ? DASH : vsAtm ? minus(formatSigned(x.v, 1)) : formatFixed(x.v, 1);
      if (td.textContent !== t) td.textContent = t;
      td.classList.toggle("na", x.v === null);
      const step = x.v === null ? null : vsAtm ? O.divStep(x.v, sc.m) : O.seqStep(x.v, sc.lo, sc.hi);
      heatCell(td, step, vsAtm ? "div" : "seq");
      td.__info = x;
      const title = x.v === null ? `Chain too narrow for ${x.col.label}` : null;
      if (title) td.title = title;
      else td.removeAttribute("title");
    }
    for (const [e, rec] of surfRows) {
      const sel = e === st.expiry;
      rec.tr.classList.toggle("sel", sel);
      if (sel) rec.tr.setAttribute("aria-current", "true");
      else rec.tr.removeAttribute("aria-current");
      rec.tr.classList.toggle("dim", Boolean(m.items.find((it) => it.e === e)?.row?.dim));
    }
    // Legend ramp: 5 sequential steps or 7 diverging steps, with the range they cover.
    const lsig = JSON.stringify([vsAtm, sc.lo === null ? null : Math.round(sc.lo * 10), sc.hi === null ? null : Math.round(sc.hi * 10), sc.m === null ? null : Math.round(sc.m * 10)]);
    if (surfLegend.__sig !== lsig) {
      surfLegend.__sig = lsig;
      const sw = vsAtm ? [-3, -2, -1, 0, 1, 2, 3].map((s) => h("i", { "data-div": String(s) })) : [1, 2, 3, 4, 5].map((s) => h("i", { "data-seq": String(s) }));
      const lo = vsAtm ? (sc.m === null ? DASH : `${minus(formatSigned(-sc.m, 1))}`) : formatPercent(sc.lo, 1);
      const hi = vsAtm ? (sc.m === null ? DASH : `${formatSigned(sc.m, 1)} pts`) : formatPercent(sc.hi, 1);
      surfLegend.replaceChildren(h("span", { class: "vol-ramp-l" }, vsAtm ? "Cheaper than ATM" : "Cheaper"), h("span", { class: "vol-ramp-t" }, lo), h("span", { class: "vol-ramp-sw", "aria-hidden": "true" }, sw), h("span", { class: "vol-ramp-t" }, hi), h("span", { class: "vol-ramp-l" }, vsAtm ? "Richer than ATM" : "Richer"));
    }
    surfaceEl.classList.toggle("loading", !m.items.some((it) => it.row));
  }
  function surfHover(td) {
    for (const el of surfTable.querySelectorAll(".hc")) el.classList.remove("hc");
    const x = td?.__info;
    if (!x || x.v === null) {
      surfTip.classList.remove("on");
      return;
    }
    surfHead.querySelector(`th[data-c="${x.col.id}"]`)?.classList.add("hc");
    td.closest("tr")?.querySelector("th")?.classList.add("hc");
    const vs = x.iv !== null && x.atm !== null ? x.iv - x.atm : null;
    surfTip.replaceChildren(
      h("div", { class: "tip-h" }, h("b", {}, dayMon(x.e)), ` · ${x.col.label}`),
      h("div", { class: "row" }, h("span", {}, "IV"), ink("ink-iv strong", formatPercent(x.iv, 1))),
      h("div", { class: "row" }, h("span", {}, "vs ATM"), h("b", {}, `${minus(formatSigned(vs, 1))} pts`)),
      h("div", { class: "row" }, h("span", {}, "Strike"), h("span", {}, x.K === null ? DASH : `${x.col.kind === "mny" || x.col.kind === "atm" ? "≈ " : ""}${formatInt(x.K)}`)),
    );
    surfTip.classList.add("on");
    const wb = surfWrap.getBoundingClientRect();
    const cb = td.getBoundingClientRect();
    const tw = surfTip.offsetWidth || 160;
    let left = cb.right - wb.left + surfWrap.scrollLeft + 6;
    if (left + tw > surfWrap.scrollLeft + wb.width) left = cb.left - wb.left + surfWrap.scrollLeft - tw - 6;
    surfTip.style.transform = `translate(${Math.round(Math.max(0, left))}px, ${Math.round(cb.top - wb.top + surfWrap.scrollTop)}px)`;
  }

  // ── Term table: rows keyed by expiry, built when the row set changes, patched cell by cell after ──
  function shownCols() {
    const d = dev();
    const cols = cfg().cols;
    return d.phone ? cols.filter((k) => k !== "curve").slice(0, 4) : d.narrow ? cols.slice(0, 8) : cols;
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
    // Shared scales: ATM IV heat across the loaded rows, one IV scale for the sparklines, one track for the 1σ bars.
    const loaded = m.items.filter((it) => it.row);
    const ivs = loaded.map((it) => it.row.atmIv).filter((v) => v !== null);
    const ivLo = ivs.length ? Math.min(...ivs) : null;
    const ivHi = ivs.length ? Math.max(...ivs) : null;
    const sparks = new Map();
    for (const it of loaded) {
      const r = it.row;
      const half = r.atmIv !== null && r.years !== null ? 2 * (r.atmIv / 100) * Math.sqrt(Math.max(r.years, O.tradingDayYears())) * 100 : null;
      sparks.set(it.e, { list: O.smileSpark(r.points, { n: 24, half }), half });
    }
    const sIv = [...sparks.values()].flatMap((x) => x.list.map((p) => p.iv));
    const sLo = sIv.length ? Math.min(...sIv) : null;
    const sHi = sIv.length ? Math.max(...sIv) : null;
    const rLo = Math.min(...loaded.map((it) => it.row.lo).filter((v) => v !== null));
    const rHi = Math.max(...loaded.map((it) => it.row.hi).filter((v) => v !== null));
    const extras = (id, td, it, big = false) => {
      if (!td) return;
      const r = it.row;
      if (id === "atmIv") heatCell(td, r.atmIv === null ? null : O.seqStep(r.atmIv, ivLo, ivHi), "seq");
      if (id === "rr25") {
        td.classList.toggle("ink-put", r.rr25 !== null && r.rr25 >= 0.5);
        td.classList.toggle("ink-call", r.rr25 !== null && r.rr25 <= -0.5);
      }
      if (id === "fwdVol") td.classList.toggle("vol-inv", Boolean(it.fwd?.inverted));
      if (id === "range" && !(r.lo !== null && rHi > rLo)) td.querySelector(".vol-mv")?.remove();
      else if (id === "range") {
        let bar = td.querySelector(".vol-mv");
        if (!bar) {
          bar = microVisual("range");
          td.append(bar);
        }
        seg(bar.__parts.seg, (r.lo - rLo) / (rHi - rLo), (r.hi - rLo) / (rHi - rLo));
        mk(bar.__parts.f, (r.F - rLo) / (rHi - rLo));
      }
      if (id === "curve") {
        const sp = sparks.get(it.e);
        const w = big ? 160 : 64;
        const ht = big ? 40 : 18;
        const ssig = JSON.stringify([w, sp?.list.map((p) => [Math.round(p.m * 100), Math.round(p.iv * 100)]), sLo, sHi]);
        if (td.__spark === ssig) return;
        td.__spark = ssig;
        if (!sp || sp.list.length < 2 || sLo === null) return void td.replaceChildren(DASH);
        const half = sp.half ?? Math.max(...sp.list.map((p) => Math.abs(p.m)));
        td.replaceChildren(sparkSvg(sp.list, { w, h: ht, lo: sLo - 0.2, hi: sHi + 0.2, mlo: -half, mhi: half }));
        td.__sig = "";
      }
    };
    for (const it of m.items) {
      const rec = termRows.get(it.e);
      if (!rec) continue;
      const sel = it.e === st.expiry;
      rec.tr.classList.toggle("sel", sel);
      if (sel) rec.tr.setAttribute("aria-current", "true");
      else rec.tr.removeAttribute("aria-current");
      const sb = rec.tr.querySelector("button.vol-select");
      if (sb && sb.getAttribute("aria-pressed") !== String(sel)) sb.setAttribute("aria-pressed", String(sel));
      rec.tr.classList.toggle("dim", Boolean(it.row?.dim));
      if (!it.row) continue;
      const thin = it.row.quality !== null && it.row.quality !== undefined && it.row.quality < 0.5;
      if (rec.thin && rec.thin.hidden === thin) rec.thin.hidden = !thin;
      for (const id of cols) {
        if (id !== "curve") patchCell(rec.cells.get(id), colOf(id).cell(it.row, it));
        extras(id, rec.cells.get(id), it);
      }
      if (rec.detail) {
        const open = openDetail === it.e;
        rec.detail.hidden = !open;
        rec.tr.setAttribute("aria-expanded", String(open));
        if (open) {
          for (const [id, dd] of rec.dcells) {
            if (id !== "curve") patchCell(dd, colOf(id).cell(it.row, it));
            extras(id, dd, it, true);
          }
        }
      }
    }
    text(termHint, dm ? "Tap a row for every figure" : "Click a row to select it");
    const n = loaded.length;
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
          return h("th", { scope: "col", class: id === "curve" ? "c-curve" : "num" }, col.head ? col.head(c) : col.header);
        }),
        dm ? h("th", { scope: "col", class: "act" }, h("span", { class: "pal-sr-only" }, "Select")) : null,
      ),
    );
    termRows.clear();
    const span = cols.length + 1 + (dm ? 1 : 0);
    const out = [];
    for (const it of m.items) {
      const monthly = O.isMonthly(it.e, st.expiries);
      const lead = h("th", { scope: "row", class: "lead" }, h("span", { class: "vol-exp" }, h("strong", {}, dayMon(it.e)), h("span", { class: "wd" }, weekday(it.e)), monthly ? h("span", { class: "m-tag", title: "Monthly expiry" }, "M") : null, h("span", { class: "thin-tag", hidden: true, title: "Thin quotes: under half of ATM ±10 strikes have a tight two-sided quote" }, "Thin")));
      const detailId = `vol-d-${it.e}`;
      const rest = COL_IDS.filter((id) => !cols.includes(id));
      const hasDetail = it.status === "ok" && rest.length > 0;
      const tr = h("tr", { "data-e": it.e, tabindex: "0", class: it.status !== "ok" ? "pending" : undefined, "aria-controls": hasDetail ? detailId : undefined, "aria-expanded": hasDetail ? "false" : undefined, title: hasDetail && !dm ? "Enter selects · Space shows the other figures" : undefined });
      const cells = new Map();
      if (it.status === "ok") {
        tr.append(lead);
        for (const id of cols) {
          const td = h("td", { class: id === "curve" ? "c-curve" : "num", "data-col": id });
          cells.set(id, td);
          tr.append(td);
        }
        if (dm) tr.append(h("td", { class: "act" }, h("button", { type: "button", class: "vol-select", "data-select": it.e, "aria-pressed": String(it.e === st.expiry), "aria-label": `Select ${dayMon(it.e)}`, title: "Make this the selected expiry" }, h("span", { class: "vol-sel-dot" }, icon("check")))));
      } else {
        tr.append(
          lead,
          h(
            "td",
            { colspan: String(span - 1), class: "vol-status" },
            it.status === "error" ? h("span", { class: "vol-err" }, "Couldn't load · ", h("button", { type: "button", class: "small plain vol-retry", "data-retry": it.e }, icon("refresh"), "Retry")) : h("span", { class: "skel vol-row-skel" }),
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
            const dd = h("dd", { class: id === "curve" ? "c-curve" : undefined });
            rec.dcells.set(id, dd);
            return h("div", { class: id === "curve" ? "d-curve" : undefined }, h("dt", {}, col.head ? col.head(c) : col.header), dd);
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
    const bar = td.querySelector(":scope > .vol-mv");
    td.replaceChildren(v.s ? h("span", { class: "two" }, h("span", {}, v.t), h("small", {}, v.s)) : v.t);
    if (bar) td.append(bar);
    if (v.title) td.title = v.title;
    else td.removeAttribute("title");
    td.classList.toggle("na", v.t === "n/a" || v.t === DASH);
  }
  function onTermClick(e) {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const retryBtn = t.closest("[data-retry]");
    if (retryBtn) return retryTerm(retryBtn.dataset.retry);
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

  // ── Strikes table: keyed by strike; rebuilt when the strike set or the columns change, patched after ──
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
    ["flag", "Flag", "c-flag"],
  ];
  function drawStrikes(m) {
    const r = m.sel;
    if (!r) {
      if (strikesStruct !== "none") {
        strikesStruct = "none";
        strikesHead.replaceChildren();
        strikesBody.replaceChildren(...Array.from({ length: 8 }, () => h("tr", { class: "skel-tr" }, h("td", { colspan: "9" }, h("span", { class: "skel vol-row-skel" })))));
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
      strikesHead.replaceChildren(h("tr", {}, STRIKE_COLS.map(([k, label, cls]) => h("th", { scope: "col", class: `${k === "k" || k === "flag" ? "" : "num "}${cls}${k === "ce" ? " ink-call" : k === "pe" ? " ink-put" : ""}`.trim() || undefined }, label))));
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
    const ba = cfg().bidAsk;
    // Shared scales over the shown range: OTM IV heat, the vs-ATM bars, the bid/ask IV track.
    const otmIvs = list.map((p) => p.otm?.iv ?? null).filter((v) => v !== null);
    const sc = O.scaleRange(otmIvs);
    const vsAbs = list.map((p) => (p.otm && r.atmIv !== null ? Math.abs(p.otm.iv - r.atmIv) : null)).filter((v) => v !== null);
    const vsMax = Math.max(0.5, O.percentileOf(vsAbs, 0.95) ?? 0.5);
    const baVals = list.flatMap((p) => [p.ce?.bidIv, p.ce?.askIv, p.pe?.bidIv, p.pe?.askIv]).filter((v) => v !== null && v !== undefined && v > 0 && v < 300);
    const baLo = baVals.length ? Math.min(...baVals) : null;
    const baHi = baVals.length ? Math.max(...baVals) : null;
    const OUT = { tick: "tick floor", intrinsic: "below intrinsic", range: "IV out of range", noquote: "no quote" };
    let anyFlag = false;
    for (const p of list) {
      const rec = strikeRows.get(p.strike);
      if (!rec) continue;
      const otmLeg = p.strike < r.F ? p.pe : p.ce;
      const flags = [];
      if (p.otm?.q === "ltp") flags.push(["LTP", "Priced from the last trade: no two-sided quote"]);
      if (p.otm?.q === "wide") flags.push(["Wide", "Wide: bid–ask spread over 10% of mid"]);
      if (p.gap) flags.push(["Gap", "CE and PE IV bands do not overlap: a parity gap"]);
      if (p.out) flags.push([OUT[p.out], `Not drawn: ${OUT[p.out]}`]);
      if (flags.length) anyFlag = true;
      const t = tagsAt(p.strike);
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
      // A parity gap: the warn dot before the strike (the row dims in CSS); no edge stripe.
      const gapDot = p.gap ? h("span", { class: "vol-warn-dot", title: "CE and PE IV bands do not overlap: a parity gap" }) : null;
      set("k", () => [gapDot, h("span", { class: "vol-k" }, formatInt(p.strike)), ...t.map(([x, side]) => h("span", { class: `vol-chip ${side}` }, x))].filter(Boolean), undefined, `${isAtm}|${Boolean(p.gap)}|${t.map((x) => x[0]).join()}`);
      set("m", minus(formatSigned(p.m, 1)));
      const baCell = (leg, side) => () => {
        if (!leg || leg.bidIv === null || leg.askIv === null || leg.bidIv === undefined || leg.askIv === undefined || baLo === null || !(baHi > baLo)) return [DASH];
        const bar = h("span", { class: `vol-ba ${side}`, "aria-hidden": "true" }, h("i", { class: "seg" }), h("i", { class: "mid" }));
        const a = (leg.bidIv - baLo) / (baHi - baLo);
        const b = (leg.askIv - baLo) / (baHi - baLo);
        seg(bar.children[0], a, b);
        mk(bar.children[1], leg.iv === null ? (a + b) / 2 : (leg.iv - baLo) / (baHi - baLo));
        const wide = leg.iv && leg.askIv - leg.bidIv > 0.1 * leg.iv;
        return [h("span", { class: "vol-ba-t" }, wide ? h("span", { class: "vol-warn-dot", title: "Bid–ask IV spread over 10% of the IV" }) : null, `${formatFixed(leg.bidIv, 1)}–${formatFixed(leg.askIv, 1)}`), bar];
      };
      const baTitle = (leg) => (leg ? `IV at the bid ${formatFixed(leg.bidIv, 1)} – IV at the ask ${formatFixed(leg.askIv, 1)}` : undefined);
      if (ba) {
        set("ce", baCell(p.ce, "call"), baTitle(p.ce), `ba|${p.ce?.bidIv}|${p.ce?.askIv}|${p.ce?.iv}|${baLo}|${baHi}`);
        set("pe", baCell(p.pe, "put"), baTitle(p.pe), `ba|${p.pe?.bidIv}|${p.pe?.askIv}|${p.pe?.iv}|${baLo}|${baHi}`);
      } else {
        set("ce", formatFixed(p.ce?.iv ?? null, 1));
        set("pe", formatFixed(p.pe?.iv ?? null, 1));
      }
      for (const k of ["ce", "pe"]) rec.cells.get(k).classList.toggle("ba", ba);
      const otd = rec.cells.get("otm");
      set("otm", formatFixed(p.otm?.iv ?? null, 1), p.otm ? `${p.otm.side.toUpperCase()} side` : undefined);
      heatCell(otd, p.otm ? O.seqStep(p.otm.iv, sc.lo, sc.hi) : null, "seq");
      const vs = p.otm && r.atmIv !== null ? p.otm.iv - r.atmIv : null;
      set(
        "vs",
        () => {
          const bar = h("span", { class: "vol-cz", "aria-hidden": "true" }, h("i", { class: "mid" }), h("i", { class: "seg" }));
          if (vs !== null) seg(bar.children[1], 0.5, 0.5 + Math.max(-1, Math.min(1, vs / vsMax)) / 2);
          return [h("span", { class: "vol-cz-t" }, vs === null ? DASH : minus(formatSigned(vs, 1))), bar];
        },
        undefined,
        `${vs === null ? "" : Math.round(vs * 100)}|${Math.round(vsMax * 100)}`,
      );
      set("d", formatFixed(p.otm?.delta === null || p.otm?.delta === undefined ? null : Math.abs(p.otm.delta), 2));
      set("sp", formatFixed(O.spreadPct(otmLeg ? rawLeg(r, p.strike, p.strike < r.F ? "pe" : "ce") : null), 1));
      set("flag", () => flags.map(([f, title]) => h("span", { class: "vol-flag", title }, f)), undefined, flags.map((f) => f[0]).join("|"));
      rec.tr.classList.toggle("out", Boolean(p.out));
      rec.tr.classList.toggle("gap", Boolean(p.gap));
    }
    strikesTable.classList.toggle("no-flag", !anyFlag);
    text(strikesSub, `${dayMon(r.expiry)} · ${formatInt(list.length)} strikes · IV % recomputed`);
    paintHighlight(false);
  }
  /** The raw chain leg behind a point (for the spread). */
  function rawLeg(r, strike, side) {
    const chain = last?.chain;
    return chain?.rows.find((x) => x.strike === strike)?.[side] ?? null;
  }

  // ── Read and arbitrage ──
  const PERSONA_ICON = { Buyer: "bolt", Seller: "wallet", Hedger: "safety", Arbitrageur: "scale" };
  function drawRead(m) {
    const r = m.sel;
    if (!r) {
      const sig = st.error ? "error" : "none";
      if (readBody.__sig !== sig) {
        readBody.__sig = sig;
        readBody.replaceChildren(
          st.error
            ? h("p", { class: "vol-note vol-err-line" }, "Couldn't load the chain. ", h("button", { type: "button", class: "small plain vol-retry", onclick: () => retry() }, icon("refresh"), "Retry"))
            : h("div", { class: "vol-read-skel" }, [1, 2, 3].map(() => h("span", { class: "skel vol-row-skel" }))),
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
                h("span", { class: "vol-persona-ic", "aria-hidden": "true" }, icon(PERSONA_ICON[p.persona] ?? "info")),
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
    // Arbitrage: the top 8 hits (warn dots), then calendar inversions; the footer says what is not included.
    const lot = r.lot;
    const legText = (l) => `${l.side === "BUY" ? "Buy" : "Sell"} ${l.qty ? `${formatInt(l.qty)}× ` : ""}${formatInt(l.strike)} ${l.right} @ ${formatFixed(l.price, 2)}`;
    const arbLines = !m.twoSided
      ? [h("p", { class: "vol-note vol-arb-line" }, h("span", { class: "vol-warn-dot", "aria-hidden": "true" }), "Needs live bid/ask: these checks use executable prices only.")]
      : hits && hits.length
        ? [
            h(
              "ol",
              { class: "vol-hits" },
              hits.slice(0, 8).map((x) => h("li", {}, h("span", { class: "vol-warn-dot", "aria-hidden": "true" }), h("strong", {}, x.kind), ` · ${x.legs.map(legText).join(" · ")} · edge ${formatFixed(x.edge, 2)} pts${lot ? ` · ${formatRupee(x.edge * lot, 0)} a lot` : ""}${x.note ? ` · ${x.note}` : ""}`)),
            ),
          ]
        : [h("p", { class: "vol-note vol-arb-line vol-ok" }, h("span", { class: "vol-ok-ic", "aria-hidden": "true" }, icon("check")), `No executable violations at bid/ask across ${formatInt(m.hits?.strikes ?? 0)} strikes (verticals, flies, boxes).`)];
    const cal = inversions.map((x) => h("p", { class: "vol-note vol-arb-line" }, h("span", { class: "vol-warn-dot", "aria-hidden": "true" }), h("strong", {}, "Calendar variance"), ` · total variance falls from ${x.from} to ${x.to} (model-based, informational)`));
    // What was checked, one chip per family: a count of hits (warn) or a check (clean). Calendar is model-based.
    const fam = [
      ["Verticals", (k) => /vertical/i.test(k)],
      ["Butterflies", (k) => /butterfly/i.test(k)],
      ["Boxes", (k) => /^box/i.test(k)],
    ];
    const checks = m.twoSided
      ? h(
          "ul",
          { class: "vol-checks", "aria-label": "Checks run" },
          fam.map(([label, test]) => {
            const n = (hits ?? []).filter((x) => test(x.kind)).length;
            return h("li", { class: n ? "warn" : "ok" }, h("span", { class: "vol-chk-ic", "aria-hidden": "true" }, n ? formatInt(n) : icon("check")), label, h("span", { class: "sr-only" }, n ? `: ${formatInt(n)} found` : ": none"));
          }),
          h("li", { class: inversions.length ? "warn" : "ok" }, h("span", { class: "vol-chk-ic", "aria-hidden": "true" }, inversions.length ? formatInt(inversions.length) : icon("check")), "Calendar", h("span", { class: "sr-only" }, inversions.length ? `: ${formatInt(inversions.length)} inverted` : ": none")),
        )
      : null;
    const asig = JSON.stringify([m.twoSided, hits?.map((x) => [x.kind, x.edge, x.legs.map((l) => l.strike)]), inversions, m.hits?.strikes, lot]);
    if (arbBody.__sig !== asig) {
      arbBody.__sig = asig;
      arbBody.replaceChildren(...[checks, ...arbLines, ...cal].filter(Boolean), h("p", { class: "vol-note vol-foot-note" }, "Gross of brokerage, STT (0.15% of sell premium; 0.15% of intrinsic on exercised ITM) and exchange charges. Quotes can move before you trade."));
    }
  }

  function drawMethod(m) {
    text(methodEl.querySelector(".vol-clock-line"), clockNote().join(" "));
    text(methodEl.querySelector(".vol-rate-line"), `Rate: ${cfg().rate === null ? rateText(st.ref) : `${formatFixed(cfg().rate, 2)} % a year (set on this page; the reference rate is ${rateText(st.ref)})`}, for discounting and the parity forward. Prices: ${cfg().basis === "mid" ? "bid–ask mid" : "last traded (set in Customise)"}.`);
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
      return setX(X_AXES[(i + 1) % X_AXES.length][0]), true;
    }
    if (k === "c") {
      const list = ["none", "next", "monthly"];
      return setCompare(list[(list.indexOf(cfg().compare) + 1) % list.length]), true;
    }
    if (k === "t") {
      if (!dev().phone) return false;
      const tabs = ["smile", "term", "surface"];
      return setCfg({ tab: tabs[(tabs.indexOf(cfg().tab) + 1) % tabs.length] }), true;
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
    panels: (phoneOrder ? [kpiEl, curvesEl, surfaceEl, termEl, readEl, strikesEl, historyEl, methodEl] : [kpiEl, curvesEl, surfaceEl, termEl, strikesEl, readEl, historyEl, methodEl]).filter(Boolean),
    root: curvesEl,
    draw,
    onKey,
    /** A new reference bundle (rate, session close): rows recompute on the next draw (their memo keys carry both). */
    refChanged() {
      requestDraw();
    },
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
        surfStruct = "";
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
      optsPop?.close();
      closeMenu();
      smile.destroy();
      term.destroy();
      document.removeEventListener("pointerdown", menuOutside, true);
      document.removeEventListener("pointerdown", outsidePin, true);
    },
  };
}

function text(el, t) {
  if (el && el.textContent !== t) el.textContent = t;
}
