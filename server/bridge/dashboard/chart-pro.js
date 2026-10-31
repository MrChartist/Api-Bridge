// chart-pro.js: the chart tools on every candle chart (chart-lite.js mountSlot attaches them). A header with the
// symbol, the hovered candle's OHLC and change, quick ranges, the interval and chart type; zoom and pan (wheel, drag,
// pinch); a crosshair with price and time labels, synced (with the interval) across the charts on the page; a
// right-click menu and a + on the price axis (buy or sell at a price through the page's own order ticket, an alert,
// copy, a horizontal line); drawing tools with their own toolbars, kept per symbol in this browser; indicators from a
// searchable library ("/") with a legend, settings and per-chart memory; chart settings (scale, grid, volume, sync).
//
// Cheap by design: the chart redraws only when its data, size or view changes (one frame however many calls come
// in); the crosshair, the header and the legend values are patched in place on pointer moves (text and attributes
// only); drawings redraw on the same frame as the chart or while one is being dragged. The maths is pure and tested
// in chart-pro-core.test.mjs. Orders: the menu only OPENS the page's order ticket, prefilled; the person confirms
// there, paper by default. Alerts only notify.
import { api, copyText, h, store, toast } from "./app.js";
import * as C from "./chart-lite-core.js";
import * as P from "./chart-pro-core.js";
import { STUDY_TONES, candlesOf, withStudies } from "./chart-specs.js";
import { DASH, formatCompact, formatFixed, formatSigned, formatSignedPercent, formatSignedRupee, isFigure } from "./format.js";
import { svgEl } from "./viz.js";

const prefs = store("local");
const readJson = (key, fallback) => {
  try {
    const v = JSON.parse(prefs.get(key) ?? "null");
    return v ?? fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (key, v) => {
  try {
    prefs.set(key, JSON.stringify(v));
  } catch {
    /* storage full or blocked: the chart still works for this visit */
  }
};

const SYNC_KEY = "mcb.chart.sync";
const OLD_STUDIES = "mcb.dashboard.studies";
const MAX_ON = 8;
const DRAW_TONES = Object.freeze(["spot", "call", "put", "iv", "warn", "today", "pos", "neg"]);
const TONE_NAMES = { spot: "Ink", call: "Blue", put: "Orange", iv: "Violet", warn: "Amber", today: "Sky", pos: "Green", neg: "Red", hv: "Grey" };
const price2 = (v) => (isFigure(v) ? formatFixed(v, 2) : DASH);

/** The time frame a chart slot remembers ({ interval, range } or null = the page's own). */
export const savedTimeframe = (id) => (id ? readJson(`mcb.chart.tf.${id}`, null) : null);
/** The key a chart remembers its settings under: the slot id, else its label. */
export const chartId = (opts) => opts.id ?? String(opts.label ?? "chart").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);

// Small stroked icons for the tools (static strings).
const GLYPH = {
  cursor: '<path d="M6 3l12 9-5.5 1.2L16 20l-2.6 1.2-3-6.6L6 18z"/>',
  trend: '<path d="M4 19 20 5"/><circle cx="4" cy="19" r="1.6"/><circle cx="20" cy="5" r="1.6"/>',
  ray: '<path d="M4 18 21 7"/><circle cx="4" cy="18" r="1.6"/><circle cx="11" cy="13.5" r="1.6"/>',
  hline: '<path d="M3 12h18"/><circle cx="12" cy="12" r="1.6"/>',
  channel: '<path d="M3 15 17 5M7 20 21 10"/>',
  fib: '<path d="M4 5h16M4 9.5h16M4 13h16M4 19h16"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="1.5"/>',
  long: '<rect x="5" y="4" width="14" height="8" rx="1"/><path d="M5 12h14"/><rect x="5" y="12" width="14" height="6" rx="1"/><path d="m9 8 3-2 3 2"/>',
  short: '<rect x="5" y="12" width="14" height="8" rx="1"/><path d="M5 12h14"/><rect x="5" y="6" width="14" height="6" rx="1"/><path d="m9 16 3 2 3-2"/>',
  text: '<path d="M5 6h14M12 6v13"/>',
  measure: '<path d="M4 20 20 4"/><path d="m7 17 2 2M10 14l2 2M13 11l2 2M16 8l2 2"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  pencil: '<path d="m4 20 1-4L16 5l3 3L8 19z"/>',
  fx: '<path d="M10 4c-2 0-3 1-3 3v13M4 10h6"/><path d="m13 11 7 8M20 11l-7 8"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  candles: '<path d="M7 3v18M17 3v18"/><rect x="5" y="7" width="4" height="8" rx="1"/><rect x="15" y="9" width="4" height="6" rx="1"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v5h5"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  dash: '<path d="M3 12h4M10 12h4M17 12h4"/>',
  chev: '<path d="m7 10 5 5 5-5"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
};
function glyph(name) {
  const s = svgEl("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false", class: "lcp-glyph" });
  s.innerHTML = GLYPH[name] ?? "";
  return s;
}

const TOOLS = [
  ["trend", "Trend line", "Alt+T"],
  ["ray", "Ray", ""],
  ["hline", "Horizontal line", "Alt+H"],
  ["channel", "Parallel channel", ""],
  ["fib", "Fibonacci retracement", "Alt+F"],
  ["rect", "Rectangle", ""],
  ["long", "Long position", ""],
  ["short", "Short position", ""],
  ["text", "Text", ""],
  ["measure", "Measure", ""],
];

// ── Page-wide: every chart with tools, the active one (keys), crosshair and interval sync ──
const charts = new Set();
let active = null;
let keysArmed = false;
const syncOn = () => prefs.get(SYNC_KEY) !== "off";
function armKeys() {
  if (keysArmed || typeof document === "undefined") return;
  keysArmed = true;
  // Window, capture phase: ahead of the palette and the chain's own "/" (document listeners).
  window.addEventListener("keydown", (e) => {
    const c = active;
    if (!c || !c.alive || !c.box.isConnected) return;
    const t = /** @type {HTMLElement} */ (e.target);
    if (t?.closest?.("input, textarea, select, [contenteditable='true'], [contenteditable='']")) return;
    if (!c.engaged()) return;
    c.key(e);
    // Handled here (/ opens the indicators, not the palette; Alt+T draws): the page-wide shortcuts never see it.
    if (e.defaultPrevented) e.stopPropagation();
  }, true);
}

// ── Floating panels (menus, the library, settings) in the top layer, inside an open dialog when the chart is ──
let openPanel = null;
function floatPanel(anchor, content, { cls = "", label = "", onClose = null, at = null } = {}) {
  openPanel?.close();
  const el = h("div", { class: `lcp-pop ${cls}`.trim(), role: "dialog", "aria-label": label || undefined, tabindex: "-1" }, content);
  const host = anchor?.closest?.("dialog[open]") ?? document.body;
  const usePopover = typeof el.showPopover === "function";
  if (usePopover) el.setAttribute("popover", "manual");
  host.append(el);
  if (usePopover) el.showPopover();
  const place = () => {
    const r = at ?? anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = at ? r.x : r.left;
    let y = at ? r.y : r.bottom + 6;
    if (x + w > vw - 8) x = Math.max(8, vw - w - 8);
    if (y + hgt > vh - 8) y = Math.max(8, (at ? r.y : r.top - 6) - hgt);
    el.style.setProperty("--pop-x", `${Math.round(x)}px`);
    el.style.setProperty("--pop-y", `${Math.round(y)}px`);
  };
  place();
  let closed = false;
  const onDown = (e) => {
    if (!el.contains(/** @type {Node} */ (e.target)) && !(anchor && anchor.contains?.(/** @type {Node} */ (e.target)))) close();
  };
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
    anchor?.focus?.({ preventScroll: true });
  };
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("pointerdown", onDown, true);
    el.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", close);
    if (openPanel === api_) openPanel = null;
    el.remove();
    onClose?.();
  }
  setTimeout(() => document.addEventListener("pointerdown", onDown, true), 0);
  el.addEventListener("keydown", onKey);
  window.addEventListener("resize", close);
  const api_ = { el, close, place };
  openPanel = api_;
  return api_;
}

/** A menu of rows: [{ label, hint?, tone?, checked?, disabled?, onClick } | "sep" | { head }]. */
function menuPanel(anchor, rows, opts = {}) {
  const list = h("div", { class: "lcp-menu", role: "menu" });
  let p = null;
  for (const r of rows) {
    if (!r) continue;
    if (r === "sep") list.append(h("div", { class: "lcp-sep", role: "separator" }));
    else if (r.head) list.append(h("p", { class: "lcp-menu-head" }, r.head));
    else {
      const b = h(
        "button",
        { type: "button", class: "lcp-menu-item", role: r.checked === undefined ? "menuitem" : "menuitemradio", "aria-checked": r.checked === undefined ? undefined : String(Boolean(r.checked)), "data-tone": r.tone ?? undefined, disabled: r.disabled || undefined, title: r.title ?? undefined },
        h("span", { class: "lcp-check", "aria-hidden": "true" }, r.checked ? glyph("check") : null),
        h("span", { class: "lcp-menu-label" }, r.label),
        r.hint ? h("kbd", { class: "lcp-kbd" }, r.hint) : null,
      );
      b.addEventListener("click", () => {
        p?.close();
        r.onClick?.();
      });
      list.append(b);
    }
  }
  p = floatPanel(anchor, list, { cls: "lcp-pop-menu", ...opts });
  const first = list.querySelector("button:not(:disabled)");
  first?.focus({ preventScroll: true, focusVisible: false });
  list.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...list.querySelectorAll("button:not(:disabled)")];
    const k = items.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    items[(k + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  });
  return p;
}

// ── The Bridge's own studies (daily candles): catalogue and computes, shared by every chart ──
let catalogue = null;
const loadCatalogue = () => (catalogue ??= api("/v1/studies").then((r) => (r.data?.data?.studies ?? []).filter((x) => x.available)).catch((e) => ((catalogue = null), Promise.reject(e))));
const computed = new Map();
function computeBridge(req) {
  const key = JSON.stringify(req);
  const hit = computed.get(key);
  if (hit && Date.now() - hit.at < 300_000) return hit.p;
  const p = api("/v1/studies/compute", { method: "POST", body: req }).then((r) => r.data?.data ?? null);
  p.catch(() => computed.delete(key));
  if (computed.size > 40) computed.clear();
  computed.set(key, { at: Date.now(), p });
  return p;
}

/** A spot symbol (NSE:NIFTY, BSE:SENSEX) whose price a market alert can watch: its underlying, else null. */
export function alertUnderlying(symbol) {
  const m = /^(NSE|BSE):([A-Z0-9&_]{1,30})$/.exec(String(symbol ?? ""));
  return m ? m[2] : null;
}

/**
 * Attach the tools to a chart slot. `chart` is chart-lite.js createChart's (made with { pro: true, onDraw }),
 * `head` the element the header goes in, `opts` the slot's options ({ id, label, symbol?, studies?, trade?, expand }).
 * `reload()` asks the slot to load again (a new interval). Returns the controller chart-lite.js drives.
 */
export function createPro({ box, head, chart, opts, reload, expandBtn = null }) {
  armKeys();
  const id = chartId(opts);
  const symbolOf = () => opts.symbol?.() ?? opts.studies?.symbol?.() ?? null;
  const lookKey = `mcb.chart.look.${id}`;
  const studyKey = `mcb.chart.studies.${id}`;
  let look = { type: "candles", scale: "linear", grid: true, volume: true, ...readJson(lookKey, {}) };
  let tf = savedTimeframe(id);
  let studies = readJson(studyKey, null);
  if (!Array.isArray(studies)) {
    // First visit since per-chart studies: the indicators the old picker remembered for every chart.
    studies = readJson(OLD_STUDIES, []).filter((x) => typeof x === "string").slice(0, 4).map((sid, k) => ({ uid: `u${k}${Date.now().toString(36)}`, id: sid, src: P.localStudy(sid) ? "local" : "bridge", params: {} }));
  }
  studies = studies.filter((s) => s && typeof s.id === "string" && typeof s.uid === "string").slice(0, MAX_ON);
  let alive = true;
  let base = null; // the page's spec, as loaded
  let candles = []; // the candles as loaded (raw)
  let shown = []; // the candles as drawn (Heikin Ashi, Renko)
  let candleSeries = null;
  let interval = null;
  let dataKey = "";
  let follow = true;
  let geo = null;
  let hoverI = -1;
  let hoverY = null;
  let pointerIn = false;
  let lastFocus = 0;
  let drawMode = false;
  let tool = null;
  let draft = null;
  let measure = null;
  let selected = null;
  let drawings = [];
  let drawKey = "";
  let bridgeNote = "";
  let bridgeResult = null;
  let bridgeFor = "";
  let rafOver = 0;

  // ── Header ──
  const nameEl = h("b", { class: "lcp-name" });
  const ivEl = h("span", { class: "lcp-iv" });
  const ohlc = {};
  const cell = (k) => (ohlc[k] = h("span", { class: "lcp-v" }, DASH));
  const ohlcEl = h(
    "div",
    { class: "lcp-ohlc", "aria-hidden": "true" },
    h("span", { class: "lcp-k" }, "O"), cell("o"),
    h("span", { class: "lcp-k" }, "H"), cell("h"),
    h("span", { class: "lcp-k" }, "L"), cell("l"),
    h("span", { class: "lcp-k" }, "C"), cell("c"),
    cell("chg"),
    h("span", { class: "lcp-k lcp-volk" }, "Vol"), cell("vol"),
  );
  const live = h("span", { class: "sr-only", "aria-live": "polite" });
  const rangeBtns = P.RANGES.map((r) => h("button", { type: "button", class: "chip-btn lcp-chip", "aria-pressed": "false", "aria-label": `Show ${r.name}`, "data-range": r.id, onclick: () => setTimeframe({ range: r.id }, true) }, r.id));
  const ranges = h("div", { class: "lcp-ranges", role: "group", "aria-label": "Quick ranges" }, rangeBtns);
  const ivBtn = h("button", { type: "button", class: "small lcp-btn", "aria-haspopup": "menu", "aria-label": "Interval and range" }, h("span", { class: "lcp-btn-text" }, "5m"), glyph("chev"));
  const typeBtn = h("button", { type: "button", class: "small lcp-btn lcp-icon", "aria-haspopup": "menu", "aria-label": "Chart type", title: "Chart type" }, glyph("candles"));
  const indCount = h("span", { class: "lc-count", hidden: true });
  const indBtn = h("button", { type: "button", class: "small lcp-btn", "aria-haspopup": "dialog", title: "Indicators (/)" }, glyph("fx"), h("span", { class: "lcp-btn-text lcp-ind-text" }, "Indicators"), indCount);
  const drawBtn = h("button", { type: "button", class: "chip-btn lcp-btn lcp-icon", "aria-pressed": "false", "aria-label": "Drawing tools", title: "Drawing tools" }, glyph("pencil"));
  const resetBtn = h("button", { type: "button", class: "small lcp-btn lcp-icon", "aria-label": "Reset the view", title: "Reset the view (double-click the chart)", hidden: true }, glyph("reset"));
  const moreBtn = h("button", { type: "button", class: "small lcp-btn lcp-icon", "aria-haspopup": "menu", "aria-label": "Chart settings", title: "Chart settings" }, glyph("gear"));
  const controls = h("div", { class: "lcp-ctl" }, ranges, ivBtn, typeBtn, indBtn, drawBtn, resetBtn, moreBtn, expandBtn);
  head.replaceChildren(h("div", { class: "lcp-head" }, h("div", { class: "lcp-id" }, h("div", { class: "lcp-title" }, nameEl, ivEl), ohlcEl), controls), live);

  // ── Over the plot: legend, the overlay SVG (drawings, crosshair, labels), the + on the axis, the tool bar ──
  const plot = chart.plot;
  const legendEl = h("div", { class: "lcp-legend", role: "list", "aria-label": "Indicators on this chart" });
  const over = svgEl("svg", { class: "lc-svg lcp-over", "aria-hidden": "true" });
  const gDraw = svgEl("g", { class: "lcp-drawings" });
  const gMeasure = svgEl("g", { class: "lcp-measure" });
  const vLine = svgEl("line", { class: "lcp-cross" });
  const hLine = svgEl("line", { class: "lcp-cross" });
  const pTag = svgEl("g", { class: "lcp-tag" }, svgEl("rect", { rx: 4, height: 18 }), svgEl("text", {}));
  const tTag = svgEl("g", { class: "lcp-tag" }, svgEl("rect", { rx: 4, height: 18 }), svgEl("text", { "text-anchor": "middle" }));
  const lastTag = svgEl("g", { class: "lcp-last" }, svgEl("line", {}), svgEl("rect", { rx: 4, height: 18 }), svgEl("text", {}));
  const gCross = svgEl("g", { class: "lcp-crossg", visibility: "hidden" }, vLine, hLine, pTag, tTag);
  over.append(gDraw, gMeasure, lastTag, gCross);
  const plus = h("button", { type: "button", class: "lcp-plus", hidden: true, "aria-label": "Actions at this price", title: "Actions at this price" }, "+");
  const toolBtns = TOOLS.map(([t, name, key]) => h("button", { type: "button", class: "chip-btn lcp-tool", "aria-pressed": "false", "data-tool": t, "aria-label": key ? `${name} (${key})` : name, title: key ? `${name} · ${key}` : name, onclick: () => pickTool(tool === t ? null : t) }, glyph(t)));
  const clearBtn = h("button", { type: "button", class: "plain lcp-tool", "aria-label": "Remove every drawing on this symbol", title: "Remove all drawings", onclick: () => confirmClear(clearBtn) }, glyph("trash"));
  const toolbar = h("div", { class: "lcp-toolbar", role: "toolbar", "aria-label": "Drawing tools", hidden: true }, toolBtns, h("span", { class: "lcp-tsep" }), clearBtn);
  const mini = h("div", { class: "lcp-mini", role: "toolbar", "aria-label": "Selected drawing", hidden: true });
  const hint = h("p", { class: "lcp-hint", hidden: true });
  plot.classList.add("lcp-plot");
  plot.tabIndex = 0;
  plot.setAttribute("role", "application");
  plot.setAttribute("aria-label", `${opts.label ?? "Chart"}: arrow keys move the crosshair, plus and minus zoom, slash opens indicators`);
  plot.append(over, legendEl, plus, toolbar, mini, hint);
  box.classList.add("lcp");

  // ── Spec: chart type, studies, volume ──
  const ownPane = (s) => `ls:${s.uid}`;
  function typed(spec) {
    const c = spec.series.find((s) => s.type === "candles");
    if (!c) return spec;
    const t = P.typedCandles(c.data, look.type);
    shown = t.data;
    const series = spec.series.map((s) => {
      if (s !== c) return s;
      if (t.line) return { id: c.id, type: t.line, pane: c.pane, label: c.label, tone: "spot", data: t.data.map((k) => ({ t: k.t, v: k.close })), format: c.format, legend: false };
      return { ...c, data: t.data, style: t.style, volume: c.volume && look.type !== "renko" };
    });
    return { ...spec, series, kind: look.type === "renko" ? "intraday" : spec.kind };
  }

  function studySeries(spec) {
    const out = [];
    const panes = [];
    const notes = [];
    const pricePane = candleSeries?.pane ?? spec.panes?.[0]?.id ?? "price";
    const daily = P.isDailyInterval(interval ?? "") || (interval === null && C.axisKind(candles.map((c) => c.t)) !== "intraday");
    if (look.type === "renko") return { out, panes, notes: studies.length ? ["Indicators are hidden on Renko: its bricks are not time bars."] : [] };
    studies.forEach((st, k) => {
      if (st.hidden) return;
      const tone0 = st.tone ?? STUDY_TONES[k % STUDY_TONES.length];
      if (st.src === "local") {
        const def = P.localStudy(st.id);
        const r = P.runLocalStudy(st.id, candles, st.params, { daily });
        st._note = r.note ?? "";
        if (!def || !r.outputs.length) return;
        const own = def.pane === "panel" || st.pane === "own";
        const pane = own ? ownPane(st) : pricePane;
        if (own) panes.push({ id: pane, weight: 0.7, label: P.studyTitle(st.id, P.studyParams(def.params, st.params), def.params), include: r.include });
        r.outputs.forEach((o, j) => {
          const sid = `${pane}:${st.uid}:${o.key}`;
          const tone = o.tone ?? (j === 0 || o.kind === "band" ? tone0 : STUDY_TONES[(k + j) % STUDY_TONES.length]);
          if (o.kind === "band") out.unshift({ id: sid, type: "band", pane, tone, legend: false, data: candles.map((c, i) => ({ t: c.t, lo: o.lo[i], hi: o.hi[i] })) });
          else if (o.kind === "bars") out.push({ id: sid, type: "bars", pane, label: o.label, tone, signed: o.signed, legend: false, data: candles.map((c, i) => ({ t: c.t, v: o.values[i], tone: o.tones?.[i] })) });
          else out.push({ id: sid, type: "line", pane, label: o.label, tone, dash: o.dash, weight: st.width === "normal" ? undefined : "thin", legend: false, data: candles.map((c, i) => ({ t: c.t, v: o.values[i], gap: o.gap?.[i] || undefined })) });
        });
        for (const v of r.levels ?? []) out.push({ id: `${pane}:${st.uid}:lvl${v}`, type: "level", pane, value: v, tone: "muted" });
      }
    });
    // The Bridge's studies: daily candles only; computed once and laid over by chart-specs.js withStudies.
    const bridge = studies.filter((s) => s.src === "bridge" && !s.hidden);
    if (bridge.length && !daily) notes.push(`${bridge.map((s) => s.id.toUpperCase()).join(", ")}: daily candles only. Pick 1D to see ${bridge.length > 1 ? "them" : "it"}.`);
    return { out, panes, notes };
  }

  function compose() {
    if (!base) return null;
    const spec = typed(base);
    const { out, panes, notes } = studySeries(spec);
    let next = { ...spec, series: [...spec.series, ...out], panes: [...(spec.panes ?? [{ id: candleSeries?.pane ?? "price" }]), ...panes] };
    if (bridgeResult && bridgeFor === bridgeKey() && look.type !== "renko") {
      next = withStudies(next, bridgeResult);
      next.series = next.series.map((s) => (String(s.id).startsWith("st:") ? { ...s, legend: false } : s));
    }
    // The candles keep most of the room: at least twice a study pane's.
    const main = next.panes[0];
    if (main && next.panes.length > 1) next.panes = [{ ...main, weight: Math.max(Number(main.weight) || 1, 2.2) }, ...next.panes.slice(1)];
    const note = [base.note, ...notes, bridgeNote].filter(Boolean).join(" ");
    return { ...next, note };
  }

  const bridgeKey = () => JSON.stringify([symbolOf(), interval, candles.length, studies.filter((s) => s.src === "bridge" && !s.hidden).map((s) => [s.uid, s.id, s.params])]);
  async function runBridge() {
    const on = studies.filter((s) => s.src === "bridge" && !s.hidden);
    const symbol = symbolOf();
    const daily = P.isDailyInterval(interval ?? "") || (interval === null && C.axisKind(candles.map((c) => c.t)) !== "intraday");
    if (!on.length || !symbol || !daily || !candles.length) {
      bridgeResult = null;
      bridgeNote = "";
      return;
    }
    const key = bridgeKey();
    if (bridgeFor === key && bridgeResult) return;
    const req = { symbol, interval: interval && P.isDailyInterval(interval) ? interval : "1d", countback: Math.max(1, Math.min(2000, candles.length)), studies: on.map((s) => ({ id: s.id, key: `b${s.uid.replace(/[^A-Za-z0-9]/g, "").slice(0, 30)}`, ...(s.params && Object.keys(s.params).length ? { params: s.params } : {}) })) };
    try {
      const r = await computeBridge(req);
      if (!alive) return;
      bridgeResult = r;
      bridgeFor = key;
      bridgeNote = r?.partial ? "Indicators: not enough history to warm every study up." : "";
      paint();
    } catch (err) {
      bridgeNote = `Indicators not drawn: ${err?.message ?? "the Bridge did not answer"}.`;
      paint();
    }
  }

  function paint() {
    const spec = compose();
    if (!spec) return;
    chart.update(spec);
    paintLegend();
    paintCount();
  }

  // ── Render a new spec from the slot ──
  function render(spec) {
    base = spec;
    candleSeries = spec.series?.find((s) => s.type === "candles") ?? null;
    candles = candleSeries?.data ?? [];
    interval = spec.interval ?? tf?.interval ?? P.guessInterval(candles.map((c) => c.t));
    const name = candleSeries?.label ?? opts.label ?? "";
    if (nameEl.textContent !== name) nameEl.textContent = name;
    const ivText = P.intervalInfo(interval)?.label ?? "";
    ivEl.textContent = ivText;
    ivBtn.querySelector(".lcp-btn-text").textContent = tf?.range ?? (ivText || "Interval");
    for (const b of rangeBtns) b.setAttribute("aria-pressed", String(tf?.range === b.dataset.range));
    const sym = symbolOf();
    ivBtn.disabled = !sym;
    ivBtn.title = sym ? "Interval and range" : "This chart's data comes from the page: its interval is fixed";
    ranges.hidden = !sym;
    // An option contract's chart says which contract it is, so Shift+B / Shift+S over it (one-tap.js) know what to trade.
    if (sym && /^(NFO|BFO):.+(CE|PE)$/.test(sym)) box.dataset.tradeSymbol = sym;
    else delete box.dataset.tradeSymbol;
    // Drawings belong to the symbol (or to this chart when it has none).
    const dk = `mcb.chart.draw.${sym ?? `slot:${id}`}`;
    if (dk !== drawKey) {
      drawKey = dk;
      drawings = P.cleanDrawings(prefs.get(dk));
      selected = null;
    }
    // A new symbol, interval or chart type opens at its default view; live updates keep the view (and follow the
    // last bar when it was in view).
    const key = `${name}|${interval}|${look.type}`;
    const prevCount = chart.model?.times?.length ?? 0;
    const prevView = chart.view;
    paint();
    const count = chart.model.times.length;
    if (key !== dataKey || !prevView) {
      hideCross(false);
      dataKey = key;
      follow = true;
      resetView();
    } else if (follow && count > prevCount && prevView) chart.setView({ from: prevView.from + (count - prevCount), to: prevView.to + (count - prevCount) });
    runBridge();
  }

  function defaultView() {
    const count = chart.model.times.length;
    const w = Math.max(200, plot.clientWidth || 600);
    const fit = Math.max(40, Math.floor((w - 70) / 6));
    if (tf?.range) {
      const from = P.rangeStart(chart.model.times, tf.range);
      return { from, to: count - 1 + Math.max(2, (count - from) * 0.04) };
    }
    const v = P.initialView(count, fit);
    return { from: v.from, to: v.to + Math.max(2, (v.to - v.from) * 0.04) };
  }
  function resetView() {
    chart.setView(defaultView());
    follow = true;
    resetBtn.hidden = true;
  }
  function setView(v) {
    const count = chart.model.times.length;
    const nv = P.clampView(v, count);
    chart.setView(nv);
    follow = nv.to >= count - 1;
    resetBtn.hidden = false;
  }

  // ── Time frame ──
  function setTimeframe(next, fromUser = false, fromSync = false) {
    if (!symbolOf()) return;
    tf = next && (next.range || next.interval) ? { interval: next.range ? P.rangeInfo(next.range).interval : next.interval, range: next.range ?? null } : null;
    writeJson(`mcb.chart.tf.${id}`, tf);
    if (fromUser) live.textContent = tf?.range ? `Showing ${P.rangeInfo(tf.range).name}` : `Interval ${P.intervalInfo(tf?.interval)?.name ?? "default"}`;
    dataKey = "";
    reload();
    if (fromUser && !fromSync && syncOn()) for (const c of charts) if (c !== self && c.alive && c.hasSymbol()) c.syncTimeframe(tf);
  }

  /** The page's spec with its candles swapped for the chosen time frame's (levels and bands kept). */
  async function timeframe(spec) {
    const sym = symbolOf();
    const c = spec?.series?.find((s) => s.type === "candles");
    if (!tf || !sym || !c || spec.interval === tf.interval) return spec;
    const q = P.historyParams(tf);
    const r = await api(`/v1/history?symbol=${encodeURIComponent(sym)}&interval=${q.interval}&countback=${q.countback}`);
    const data = candlesOf(r.data?.data);
    if (!data.length) return { ...spec, empty: { title: `No ${P.intervalInfo(q.interval)?.name ?? q.interval} candles for this symbol`, text: "The broker has no history at this interval. Pick another interval." } };
    const label = String(spec.label ?? "").replace(/(daily|5-minute|\w+-minute) candles/, `${P.intervalInfo(q.interval)?.name ?? q.interval} candles`);
    return { ...spec, label, interval: q.interval, kind: undefined, series: spec.series.map((s) => (s === c ? { ...c, data } : s)) };
  }

  // ── Header readout ──
  const setText = (el, t) => {
    if (el.textContent !== t) el.textContent = t;
  };
  function readout(i) {
    const k = i >= 0 ? i : (chart.model?.times?.length ?? 0) - 1;
    const s = chart.model?.series?.find((x) => x.type === "candles") ?? null;
    const p = s ? C.valueAt(s, k) : null;
    if (!p) {
      for (const key of ["o", "h", "l", "c", "chg", "vol"]) setText(ohlc[key], DASH);
      ohlc.chg.removeAttribute("data-dir");
      return;
    }
    const f = s.format ?? price2;
    setText(ohlc.o, f(p.open));
    setText(ohlc.h, f(p.high));
    setText(ohlc.l, f(p.low));
    setText(ohlc.c, f(p.close));
    // Change against the previous candle's close (the open for the first one).
    const prev = C.valueAt(s, k - 1);
    const ref = prev ? prev.close : p.open;
    const d = p.close - ref;
    setText(ohlc.chg, `${formatSigned(d, 2)} (${formatSignedPercent(ref ? (d / ref) * 100 : NaN, 2)})`);
    ohlc.chg.dataset.dir = d > 0 ? "up" : d < 0 ? "down" : "flat";
    setText(ohlc.vol, p.volume > 0 ? formatCompact(p.volume) : DASH);
  }

  // ── Legend ──
  function paintCount() {
    indCount.textContent = studies.length ? String(studies.length) : "";
    indCount.hidden = !studies.length;
    indBtn.setAttribute("aria-label", studies.length ? `Indicators: ${studies.length} on` : "Indicators");
  }
  const legendVals = [];
  function paintLegend() {
    legendVals.length = 0;
    const rows = studies.map((st) => {
      const def = st.src === "local" ? P.localStudy(st.id) : null;
      const title = def ? P.studyTitle(st.id, P.studyParams(def.params, st.params), def.params) : `${st.id.toUpperCase()}${Object.values(st.params ?? {}).length ? ` ${Object.values(st.params).join(" ")}` : ""}`;
      const vals = h("span", { class: "lcp-lvals" });
      const ids = (chart.model?.series ?? []).filter((s) => (st.src === "local" ? String(s.id).includes(`:${st.uid}:`) : String(s.id).startsWith(`st:b${st.uid.replace(/[^A-Za-z0-9]/g, "").slice(0, 30)}.`)) && (s.type === "line" || s.type === "bars"));
      legendVals.push({ el: vals, series: ids, last: "" });
      const note = st._note || (st.src === "bridge" && !(P.isDailyInterval(interval ?? "") || C.axisKind(candles.map((c) => c.t)) !== "intraday") ? "daily only" : "");
      return h(
        "div",
        { class: "lcp-lrow", role: "listitem", "data-hidden": st.hidden ? "" : undefined },
        h("button", { type: "button", class: "plain lcp-lname", "aria-label": `${title} settings`, onclick: (e) => openSettings(st, e.currentTarget) }, title),
        note ? h("span", { class: "lcp-lnote" }, note) : vals,
        h(
          "span",
          { class: "lcp-lacts" },
          h("button", { type: "button", class: "plain lcp-lbtn", "aria-label": st.hidden ? `Show ${title}` : `Hide ${title}`, "aria-pressed": String(!st.hidden), onclick: () => patchStudy(st, { hidden: !st.hidden }) }, glyph("eye")),
          h("button", { type: "button", class: "plain lcp-lbtn", "aria-label": `${title} settings`, onclick: (e) => openSettings(st, e.currentTarget) }, glyph("gear")),
          h("button", { type: "button", class: "plain lcp-lbtn", "aria-label": `Remove ${title}`, onclick: () => removeStudy(st) }, glyph("close")),
        ),
      );
    });
    legendEl.replaceChildren(...rows);
    legendEl.hidden = !rows.length;
    legendValues(hoverI);
  }
  function legendValues(i) {
    const k = i >= 0 ? i : (chart.model?.times?.length ?? 0) - 1;
    for (const L of legendVals) {
      const parts = [];
      for (const s of L.series) {
        const p = C.valueAt(s, k);
        if (p && Number.isFinite(p.v)) parts.push(Math.abs(p.v) >= 1e5 ? formatCompact(p.v) : formatFixed(p.v, 2));
      }
      const t = parts.length ? parts.join("  ") : DASH;
      if (t !== L.last) {
        L.last = t;
        L.el.textContent = t;
      }
    }
  }

  // ── Studies: add, change, remove ──
  const saveStudies = () => writeJson(studyKey, studies.map(({ _note, ...s }) => s));
  function addStudy(sid, src) {
    if (studies.length >= MAX_ON) return toast(`At most ${MAX_ON} indicators on one chart`, { tone: "warn" });
    studies.push({ uid: `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, id: sid, src, params: {} });
    saveStudies();
    bridgeFor = "";
    if (src === "bridge" && !P.isDailyInterval(interval ?? "") && C.axisKind(candles.map((c) => c.t)) === "intraday") toast(`${sid.toUpperCase()} reads daily candles: pick 1D to see it`, { tone: "info" });
    paint();
    runBridge();
  }
  function patchStudy(st, patch) {
    Object.assign(st, patch);
    saveStudies();
    if ("params" in patch || "hidden" in patch) bridgeFor = "";
    paint();
    runBridge();
  }
  function removeStudy(st) {
    studies = studies.filter((x) => x !== st);
    saveStudies();
    paint();
  }

  // ── The library ("/") ──
  async function openLibrary(anchor = indBtn) {
    const search = h("input", { type: "search", class: "lcp-search", placeholder: "Search indicators", "aria-label": "Search indicators", autocomplete: "off" });
    const list = h("div", { class: "lcp-lib-list" });
    const body = h("div", { class: "lcp-lib" }, h("div", { class: "lcp-lib-head" }, h("h3", {}, "Indicators"), h("span", { class: "lcp-sub" }, `${studies.length} of ${MAX_ON} on`)), search, list);
    const p = floatPanel(anchor, body, { cls: "lcp-pop-lib", label: "Indicators" });
    search.focus({ preventScroll: true });
    let bridge = [];
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const match = (id, name, cat) => !q || id.includes(q) || name.toLowerCase().includes(q) || cat.toLowerCase().includes(q);
      const rows = [];
      for (const s of P.LOCAL_STUDIES) if (match(s.id, s.name, s.cat)) rows.push({ id: s.id, name: s.name, cat: s.cat, src: "local", tag: s.needs === "intraday" ? "Intraday" : "" });
      for (const s of bridge) if (!P.localStudy(s.id) && match(s.id, String(s.summary ?? ""), P.studyCategory(s.id))) rows.push({ id: s.id, name: String(s.summary ?? s.id).split(/[.;:(]/)[0], cat: P.studyCategory(s.id), src: "bridge", tag: "Daily" });
      const groups = P.STUDY_CATEGORIES.map((c) => [c, rows.filter((r) => r.cat === c)]).filter(([, r]) => r.length);
      const on = studies.length
        ? [h("p", { class: "lcp-menu-head" }, "On this chart"), ...studies.map((st) => h("div", { class: "lcp-lib-on" }, h("span", {}, st.id.toUpperCase()), h("button", { type: "button", class: "plain lcp-lbtn", "aria-label": `${st.id} settings`, onclick: (e) => (p.close(), openSettings(st, indBtn)) }, glyph("gear")), h("button", { type: "button", class: "plain lcp-lbtn", "aria-label": `Remove ${st.id}`, onclick: () => (removeStudy(st), draw()) }, glyph("close"))))]
        : [];
      list.replaceChildren(
        ...(q ? [] : on),
        ...groups.flatMap(([c, r]) => [
          h("p", { class: "lcp-menu-head" }, c),
          ...r.map((x) => h("button", { type: "button", class: "lcp-menu-item lcp-lib-item", disabled: studies.length >= MAX_ON || undefined, onclick: () => (addStudy(x.id, x.src), draw()) }, h("span", { class: "lcp-menu-label" }, x.name), h("span", { class: "lcp-lib-id" }, x.id), x.tag ? h("span", { class: "lcp-tag-chip" }, x.tag) : null)),
        ]),
        ...(rows.length ? [] : [h("p", { class: "lcp-sub lcp-pad" }, "No match")]),
      );
      body.querySelector(".lcp-sub").textContent = `${studies.length} of ${MAX_ON} on`;
      p.place();
    };
    search.addEventListener("input", draw);
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") list.querySelector(".lcp-lib-item:not(:disabled)")?.click();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        list.querySelector("button:not(:disabled)")?.focus();
      }
    });
    draw();
    try {
      bridge = await loadCatalogue();
      draw();
    } catch {
      /* the browser studies still work */
    }
  }

  // ── A study's settings: Inputs and Style ──
  async function openSettings(st, anchor) {
    let defs = st.src === "local" ? P.localStudy(st.id)?.params ?? [] : [];
    if (st.src === "bridge") {
      try {
        defs = (await loadCatalogue()).find((x) => x.id === st.id)?.params ?? [];
      } catch {
        defs = [];
      }
    }
    const vals = P.studyParams(defs, st.params);
    const tabIn = h("button", { type: "button", class: "chip-btn", "aria-pressed": "true" }, "Inputs");
    const tabSt = h("button", { type: "button", class: "chip-btn", "aria-pressed": "false" }, "Style");
    const inputs = h("div", { class: "lcp-form" });
    const style = h("div", { class: "lcp-form", hidden: true });
    const apply = (patch) => patchStudy(st, patch);
    for (const d of defs) {
      let el;
      if (d.type === "int" || d.type === "number") {
        el = h("input", { type: "number", inputmode: "decimal", min: d.min ?? undefined, max: d.max ?? undefined, step: d.type === "int" ? "1" : "any", value: String(vals[d.name]) });
        el.addEventListener("change", () => {
          const next = P.studyParams(defs, { ...st.params, [d.name]: Number(el.value) });
          el.value = String(next[d.name]);
          apply({ params: { ...st.params, [d.name]: next[d.name] } });
        });
      } else if (d.type === "choice" || d.type === "source") {
        el = h("select", {}, (d.values ?? []).map((v) => h("option", { value: v }, v)));
        el.value = vals[d.name];
        el.addEventListener("change", () => apply({ params: { ...st.params, [d.name]: el.value } }));
      } else continue;
      inputs.append(h("label", { class: "field lcp-field" }, h("span", {}, d.name[0].toUpperCase() + d.name.slice(1)), el));
    }
    if (!inputs.childElementCount) inputs.append(h("p", { class: "lcp-sub" }, "No settings."));
    const swatches = h("div", { class: "lcp-swatches", role: "radiogroup", "aria-label": "Colour" }, STUDY_TONES.map((t) => h("button", { type: "button", class: "lcp-swatch", role: "radio", "data-tone": t, "aria-checked": String((st.tone ?? "") === t), "aria-label": TONE_NAMES[t] ?? t, onclick: () => (apply({ tone: t }), swatches.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.tone === t)))) })));
    const widthSeg = h("div", { class: "lcp-seg", role: "group", "aria-label": "Line width" }, ["thin", "normal"].map((w) => h("button", { type: "button", class: "chip-btn", "aria-pressed": String((st.width ?? "thin") === w), onclick: (e) => (apply({ width: w }), widthSeg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget)))) }, w === "thin" ? "Thin" : "Normal")));
    style.append(h("div", { class: "field lcp-field" }, h("span", {}, "Colour"), swatches), h("div", { class: "field lcp-field" }, h("span", {}, "Line"), widthSeg));
    const def = st.src === "local" ? P.localStudy(st.id) : null;
    if (def?.pane === "price") {
      const placeSeg = h("div", { class: "lcp-seg", role: "group", "aria-label": "Placement" }, [["price", "On the price"], ["own", "Own pane"]].map(([v, t]) => h("button", { type: "button", class: "chip-btn", "aria-pressed": String((st.pane ?? "price") === v), onclick: (e) => (apply({ pane: v }), placeSeg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget)))) }, t)));
      style.append(h("div", { class: "field lcp-field" }, h("span", {}, "Placement"), placeSeg));
    }
    const tab = (on) => {
      tabIn.setAttribute("aria-pressed", String(on === "in"));
      tabSt.setAttribute("aria-pressed", String(on === "st"));
      inputs.hidden = on !== "in";
      style.hidden = on !== "st";
      p.place();
    };
    tabIn.addEventListener("click", () => tab("in"));
    tabSt.addEventListener("click", () => tab("st"));
    const defaults = h("button", { type: "button", class: "small", onclick: () => (apply({ params: {}, tone: undefined, width: undefined, pane: undefined }), p.close()) }, "Defaults");
    const done = h("button", { type: "button", class: "small primary", onclick: () => p.close() }, "Done");
    const title = def ? def.name : st.id.toUpperCase();
    const p = floatPanel(anchor, h("div", { class: "lcp-settings" }, h("div", { class: "lcp-lib-head" }, h("h3", {}, title), st.src === "bridge" ? h("span", { class: "lcp-tag-chip" }, "Daily") : null), h("div", { class: "lcp-seg lcp-tabs", role: "group", "aria-label": "Settings" }, tabIn, tabSt), inputs, style, h("div", { class: "lcp-actions" }, defaults, done)), { cls: "lcp-pop-settings", label: `${title} settings` });
    (inputs.querySelector("input, select") ?? done).focus({ preventScroll: true });
  }

  // ── Menus in the header ──
  ivBtn.addEventListener("click", () => {
    const cur = tf?.interval ?? interval;
    menuPanel(ivBtn, [
      { head: "Range" },
      ...P.RANGES.map((r) => ({ label: r.name, checked: tf?.range === r.id, onClick: () => setTimeframe({ range: r.id }, true) })),
      "sep",
      { head: "Interval" },
      ...P.INTERVALS.map((x) => ({ label: x.name, checked: !tf?.range && cur === x.id, onClick: () => setTimeframe({ interval: x.id }, true) })),
      ...(tf ? ["sep", { label: "The page's own", onClick: () => setTimeframe(null, true) }] : []),
    ], { label: "Interval and range" });
  });
  typeBtn.addEventListener("click", () => menuPanel(typeBtn, P.CHART_TYPES.map((t) => ({ label: t.name, checked: look.type === t.id, onClick: () => setLook({ type: t.id }) })), { label: "Chart type" }));
  indBtn.addEventListener("click", () => openLibrary(indBtn));
  drawBtn.addEventListener("click", () => setDrawMode(!drawMode));
  resetBtn.addEventListener("click", () => resetView());
  moreBtn.addEventListener("click", () =>
    menuPanel(moreBtn, [
      { head: "Price scale" },
      { label: "Regular", checked: look.scale === "linear", onClick: () => setLook({ scale: "linear" }) },
      { label: "Logarithmic", checked: look.scale === "log", onClick: () => setLook({ scale: "log" }) },
      { label: "Percent from the first bar", checked: look.scale === "percent", onClick: () => setLook({ scale: "percent" }) },
      "sep",
      { label: "Grid", checked: look.grid, onClick: () => setLook({ grid: !look.grid }) },
      { label: "Volume under the candles", checked: look.volume, onClick: () => setLook({ volume: !look.volume }) },
      { label: "Sync crosshair and interval", checked: syncOn(), onClick: () => prefs.set(SYNC_KEY, syncOn() ? "off" : "on") },
      "sep",
      { label: "Reset the view", hint: "Dbl-click", onClick: () => resetView() },
      { label: "Remove all drawings", disabled: !drawings.length, onClick: () => confirmClear(moreBtn) },
    ], { label: "Chart settings" }),
  );
  function setLook(patch) {
    look = { ...look, ...patch };
    writeJson(lookKey, look);
    chart.setLook({ scale: look.scale, grid: look.grid, volume: look.volume });
    if ("type" in patch) {
      dataKey = "";
      if (base) render(base);
    }
  }
  chart.setLook({ scale: look.scale, grid: look.grid, volume: look.volume });

  // ── Geometry helpers ──
  const main = () => geo?.panes?.[0] ?? null;
  const times = () => chart.model?.times ?? [];
  const toPt = (q) => ({ i: P.indexOfTime(times(), q.t), p: q.p });
  const fromPt = (q) => ({ t: P.timeOfIndex(times(), q.i), p: q.p });
  const X = (i) => geo.X.xOf(i);
  const Y = (p) => main().yOf(p);
  const local = (e) => {
    const r = over.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const inMain = (y) => {
    const m = main();
    return m && m.lo !== null && y >= m.top && y <= m.priceBottom;
  };
  const priceFmt = () => candleSeries?.format ?? price2;

  // ── Overlay: last price tag, crosshair, drawings ──
  function onDraw(g) {
    geo = g;
    over.setAttribute("width", C.n3(g.W));
    over.setAttribute("height", C.n3(g.H));
    over.setAttribute("viewBox", `0 0 ${C.n3(g.W)} ${C.n3(g.H)}`);
    paintLast();
    paintDrawings();
    if (hoverI >= 0) crossAt(hoverI, hoverY, false);
    else readout(-1);
    legendValues(hoverI);
  }
  function tag(gEl, x, y, text, w = null) {
    const [rect, txt] = gEl.querySelectorAll("rect, text");
    const tw = w ?? C.estimateWidth(text, 12, 600) + 12;
    rect.setAttribute("x", C.n3(x));
    rect.setAttribute("y", C.n3(y - 9));
    rect.setAttribute("width", C.n3(tw));
    if (txt.textContent !== text) txt.textContent = text;
    txt.setAttribute("x", C.n3(txt.getAttribute("text-anchor") === "middle" ? x + tw / 2 : x + 6));
    txt.setAttribute("y", C.n3(y + 4));
  }
  function paintLast() {
    const m = main();
    const s = chart.model?.series?.find((x) => x.type === "candles");
    const p = s?.pts?.[s.pts.length - 1];
    if (!m || m.lo === null || !p || !geo) return lastTag.setAttribute("visibility", "hidden");
    const y = m.yOf(p.close);
    if (!(y >= m.top && y <= m.priceBottom)) return lastTag.setAttribute("visibility", "hidden");
    lastTag.setAttribute("visibility", "visible");
    lastTag.dataset.dir = p.close >= p.open ? "up" : "down";
    const ln = lastTag.querySelector("line");
    const yy = C.crisp(y, geo.dpr, 1);
    ln.setAttribute("x1", C.n3(geo.X.left));
    ln.setAttribute("x2", C.n3(geo.X.right));
    ln.setAttribute("y1", C.n3(yy));
    ln.setAttribute("y2", C.n3(yy));
    tag(lastTag, geo.X.right + 2, y, priceFmt()(p.close), geo.W - geo.X.right - 3);
  }
  function crossAt(i, y, broadcast = true) {
    if (!geo || i < 0) return hideCross(broadcast);
    hoverI = i;
    hoverY = y;
    const x = C.crisp(geo.X.xOf(i), geo.dpr, 1);
    const top = geo.panes[0]?.top ?? 0;
    const last = geo.panes[geo.panes.length - 1];
    const bottom = last?.bottom ?? geo.H;
    gCross.setAttribute("visibility", "visible");
    vLine.setAttribute("x1", C.n3(x));
    vLine.setAttribute("x2", C.n3(x));
    vLine.setAttribute("y1", C.n3(top));
    vLine.setAttribute("y2", C.n3(bottom));
    const pane = y === null ? null : geo.panes.find((p) => p.lo !== null && y >= p.top && y <= p.priceBottom);
    if (pane) {
      const yy = C.crisp(y, geo.dpr, 1);
      hLine.setAttribute("visibility", "visible");
      pTag.setAttribute("visibility", "visible");
      hLine.setAttribute("x1", C.n3(geo.X.left));
      hLine.setAttribute("x2", C.n3(geo.X.right));
      hLine.setAttribute("y1", C.n3(yy));
      hLine.setAttribute("y2", C.n3(yy));
      const v = pane.vOf(y);
      const text = pane === geo.panes[0] ? priceFmt()(v) : Math.abs(v) >= 1e5 ? formatCompact(v) : formatFixed(v, 2);
      tag(pTag, geo.X.right + 2, y, text, geo.W - geo.X.right - 3);
      const onMain = pane === geo.panes[0];
      plus.hidden = !onMain || !pointerIn;
      if (onMain) {
        plus.style.setProperty("--px", `${Math.round(geo.X.right - 22)}px`);
        plus.style.setProperty("--py", `${Math.round(y - 10)}px`);
      }
    } else {
      hLine.setAttribute("visibility", "hidden");
      pTag.setAttribute("visibility", "hidden");
      plus.hidden = true;
    }
    const t = times()[i];
    const stamp = C.formatStamp(t, chart.model.kind);
    const tw = C.estimateWidth(stamp, 12, 600) + 14;
    tag(tTag, Math.max(geo.X.left, Math.min(geo.X.right - tw, x - tw / 2)), geo.H - 11, stamp, tw);
    readout(i);
    legendValues(i);
    if (broadcast && syncOn()) for (const c of charts) if (c !== self && c.alive) c.syncCross(t);
  }
  function hideCross(broadcast = true) {
    hoverI = -1;
    hoverY = null;
    gCross.setAttribute("visibility", "hidden");
    plus.hidden = true;
    readout(-1);
    legendValues(-1);
    if (broadcast && syncOn()) for (const c of charts) if (c !== self && c.alive) c.syncCross(null);
  }

  // Drawings: SVG built from the stored points each time the chart or a drawing changes (a handful of elements).
  function scheduleOver() {
    if (rafOver) return;
    rafOver = requestAnimationFrame(() => {
      rafOver = 0;
      paintDrawings();
    });
  }
  function paintDrawings() {
    const m = main();
    if (!geo || !m || m.lo === null) return gDraw.replaceChildren();
    const W = geo.X.right;
    const els = [];
    const all = draft ? [...drawings, draft] : drawings;
    for (const d of all) els.push(drawingEl(d, W, d === draft));
    gDraw.replaceChildren(...els);
    paintMeasure();
    paintMini();
  }
  function drawingEl(d, W, isDraft) {
    const pts = d.pts.map(toPt);
    const xs = pts.map((q) => X(q.i));
    const ys = pts.map((q) => Y(q.p));
    const g = svgEl("g", { class: "lcp-d", "data-tone": d.tone ?? (d.type === "long" || d.type === "short" ? undefined : "today"), "data-sel": d.id === selected ? "" : undefined, "data-dash": d.dash ? "" : undefined });
    const line = (x1, y1, x2, y2, cls = "lcp-dl") => svgEl("line", { class: cls, x1: C.n3(x1), y1: C.n3(y1), x2: C.n3(x2), y2: C.n3(y2) });
    const label = (x, y, text, cls = "lcp-dt", anchor = "start") => svgEl("text", { class: cls, x: C.n3(x), y: C.n3(y), "text-anchor": anchor }, text);
    const f = priceFmt();
    switch (d.type) {
      case "trend":
        if (pts.length > 1) g.append(line(xs[0], ys[0], xs[1], ys[1]));
        break;
      case "ray":
        if (pts.length > 1) {
          const e = P.rayTo(xs[0], ys[0], xs[1], ys[1], W);
          g.append(line(xs[0], ys[0], e.x, e.y));
        }
        break;
      case "hline": {
        const y = C.crisp(ys[0], geo.dpr, 1);
        g.append(line(geo.X.left, y, W, y), label(W - 4, y - 5, f(pts[0].p), "lcp-dt", "end"));
        break;
      }
      case "channel":
        if (pts.length > 1) {
          g.append(line(xs[0], ys[0], xs[1], ys[1]));
          if (pts.length > 2) {
            const off = P.channelOffset(pts[0], pts[1], pts[2]);
            const y0 = Y(pts[0].p + off);
            const y1 = Y(pts[1].p + off);
            g.append(svgEl("path", { class: "lcp-dfill", d: `M${C.n3(xs[0])} ${C.n3(ys[0])}L${C.n3(xs[1])} ${C.n3(ys[1])}L${C.n3(xs[1])} ${C.n3(y1)}L${C.n3(xs[0])} ${C.n3(y0)}Z` }), line(xs[0], y0, xs[1], y1));
          }
        }
        break;
      case "fib":
        if (pts.length > 1) {
          const x0 = Math.min(xs[0], xs[1]);
          const x1 = Math.max(xs[0], xs[1], x0 + 40);
          g.append(line(xs[0], ys[0], xs[1], ys[1], "lcp-dl lcp-dthin"));
          for (const l of P.fibLevels(pts[0].p, pts[1].p)) {
            const y = C.crisp(Y(l.price), geo.dpr, 1);
            g.append(line(x0, y, x1, y), label(x0 + 4, y - 4, `${formatFixed(l.r, 3)}  ${f(l.price)}`));
          }
        }
        break;
      case "rect":
        if (pts.length > 1) g.append(svgEl("rect", { class: "lcp-dfill lcp-dl", x: C.n3(Math.min(xs[0], xs[1])), y: C.n3(Math.min(ys[0], ys[1])), width: C.n3(Math.abs(xs[1] - xs[0])), height: C.n3(Math.abs(ys[1] - ys[0])) }));
        break;
      case "long":
      case "short": {
        if (pts.length < 4) break;
        const x0 = Math.min(xs[0], xs[1]);
        const x1 = Math.max(xs[0], xs[1]);
        const m = P.positionMath({ side: d.type, entry: pts[0].p, target: pts[2].p, stop: pts[3].p, qty: d.qty ?? 1 });
        const zone = (y1, y2, tone) => svgEl("rect", { class: "lcp-zone", "data-tone": tone, x: C.n3(x0), y: C.n3(Math.min(y1, y2)), width: C.n3(x1 - x0), height: C.n3(Math.abs(y2 - y1)) });
        g.append(zone(ys[0], ys[2], "pos"), zone(ys[0], ys[3], "neg"), line(x0, ys[0], x1, ys[0], "lcp-dl lcp-entry"));
        const up = d.type === "long";
        const tgtY = ys[2] + (up ? -6 : 14);
        const stpY = ys[3] + (up ? 14 : -6);
        g.append(
          label(x0 + 4, tgtY, `Target ${f(pts[2].p)}  ${formatSigned(m.reward, 2)} (${formatSignedPercent(m.pctTarget, 2)})${d.qty ? `  ${formatSignedRupee(m.pnlTarget, 0)}` : ""}`, "lcp-dt", "start"),
          label(x0 + 4, stpY, `Stop ${f(pts[3].p)}  ${formatSigned(-m.risk, 2)} (${formatSignedPercent(m.pctStop, 2)})${d.qty ? `  ${formatSignedRupee(m.pnlStop, 0)}` : ""}`, "lcp-dt", "start"),
          label(x1 - 4, ys[0] + (up ? 14 : -6), `${up ? "Long" : "Short"} ${f(pts[0].p)}  R:R ${m.valid ? formatFixed(m.rr, 2) : DASH}`, "lcp-dt lcp-dt-strong", "end"),
        );
        g.querySelectorAll(".lcp-dt").forEach((t, k) => k < 2 && t.setAttribute("data-tone", k === 0 ? "pos" : "neg"));
        break;
      }
      case "text":
        g.append(label(xs[0], ys[0], d.text || "Text", "lcp-dt lcp-dtext"));
        break;
      default:
        break;
    }
    if (!isDraft && d.id === selected && d.type !== "hline") for (let k = 0; k < pts.length; k++) g.append(svgEl("circle", { class: "lcp-handle", cx: C.n3(xs[k]), cy: C.n3(ys[k]), r: 4.5 }));
    return g;
  }
  function paintMeasure() {
    if (!measure || measure.pts.length < 2 || !main()) return gMeasure.replaceChildren();
    const [a, b] = measure.pts;
    const xa = X(a.i);
    const xb = X(b.i);
    const ya = Y(a.p);
    const yb = Y(b.p);
    const m = P.measureMath(a, b);
    const tone = m.change > 0 ? "pos" : m.change < 0 ? "neg" : "spot";
    const text = `${formatSigned(m.change, 2)} (${formatSignedPercent(m.pct, 2)})  ${m.bars} bars`;
    const w = C.estimateWidth(text, 12, 600) + 14;
    const lx = Math.max(geo.X.left, Math.min(geo.X.right - w, (xa + xb) / 2 - w / 2));
    const ly = Math.min(ya, yb) - 26 < (main()?.top ?? 0) ? Math.max(ya, yb) + 8 : Math.min(ya, yb) - 26;
    gMeasure.replaceChildren(
      svgEl("rect", { class: "lcp-zone", "data-tone": tone, x: C.n3(Math.min(xa, xb)), y: C.n3(Math.min(ya, yb)), width: C.n3(Math.abs(xb - xa)), height: C.n3(Math.abs(yb - ya)) }),
      svgEl("g", { class: "lcp-mtag", "data-tone": tone }, svgEl("rect", { x: C.n3(lx), y: C.n3(ly), width: C.n3(w), height: 20, rx: 10 }), svgEl("text", { x: C.n3(lx + w / 2), y: C.n3(ly + 14), "text-anchor": "middle" }, text)),
    );
  }

  // ── Selected drawing: its own small toolbar ──
  function paintMini() {
    const d = drawings.find((x) => x.id === selected);
    if (!d || !geo || !main()) {
      mini.hidden = true;
      return;
    }
    const pts = d.pts.map(toPt);
    const xs = pts.map((q) => X(q.i));
    const ys = pts.map((q) => Y(q.p));
    const x = Math.max(geo.X.left + 4, Math.min(geo.X.right - 230, (Math.min(...xs) + Math.max(...xs)) / 2 - 110));
    const y = Math.max(4, Math.min(...ys) - (d.type === "long" || d.type === "short" ? 58 : 44));
    if (mini.__for !== `${d.id}|${d.tone}|${d.dash}|${d.qty}`) {
      mini.__for = `${d.id}|${d.tone}|${d.dash}|${d.qty}`;
      const tones = d.type === "long" || d.type === "short" ? [] : DRAW_TONES.map((t) => h("button", { type: "button", class: "lcp-swatch", role: "radio", "data-tone": t, "aria-checked": String((d.tone ?? "today") === t), "aria-label": TONE_NAMES[t] ?? t, onclick: () => editDrawing(d, { tone: t }) }));
      const qty = d.type === "long" || d.type === "short" ? h("label", { class: "lcp-qty" }, h("span", {}, "Qty"), h("input", { type: "number", min: "1", step: "1", inputmode: "numeric", value: String(d.qty ?? ""), placeholder: "1", "aria-label": "Quantity for the P&L", onchange: (e) => editDrawing(d, { qty: Math.max(1, Math.round(Number(e.currentTarget.value) || 1)) }) })) : null;
      mini.replaceChildren(...[
        ...(tones.length ? [h("div", { class: "lcp-swatches", role: "radiogroup", "aria-label": "Colour" }, tones)] : []),
        qty,
        d.type === "text" ? h("button", { type: "button", class: "plain lcp-tool", "aria-label": "Edit the text", onclick: () => editText(d) }, glyph("pencil")) : null,
        d.type === "long" || d.type === "short" ? null : h("button", { type: "button", class: "chip-btn lcp-tool", "aria-pressed": String(Boolean(d.dash)), "aria-label": "Dashed line", onclick: () => editDrawing(d, { dash: !d.dash }) }, glyph("dash")),
        h("button", { type: "button", class: "plain lcp-tool", "aria-label": "Delete this drawing (Delete)", title: "Delete", onclick: () => deleteSelected() }, glyph("trash")),
      ].filter(Boolean));
    }
    mini.hidden = false;
    mini.style.setProperty("--mx", `${Math.round(x)}px`);
    mini.style.setProperty("--my", `${Math.round(y)}px`);
  }
  const saveDrawings = () => writeJson(drawKey, drawings.map(({ id: did, type, pts, tone, dash, text, qty }) => ({ id: did, type, pts, tone, dash, text, qty })));
  function editDrawing(d, patch) {
    Object.assign(d, patch);
    saveDrawings();
    mini.__for = "";
    scheduleOver();
  }
  function deleteSelected() {
    if (!selected) return false;
    drawings = drawings.filter((d) => d.id !== selected);
    selected = null;
    saveDrawings();
    scheduleOver();
    live.textContent = "Drawing deleted";
    return true;
  }
  function confirmClear(anchor) {
    if (!drawings.length) return toast("No drawings on this symbol", { tone: "info" });
    const yes = h("button", { type: "button", class: "small primary", onclick: () => (p.close(), (drawings = []), (selected = null), saveDrawings(), scheduleOver(), toast("Drawings removed")) }, `Remove ${drawings.length}`);
    const p = floatPanel(anchor, h("div", { class: "lcp-settings" }, h("p", { class: "lcp-sub" }, `Remove every drawing on ${nameEl.textContent || "this symbol"}? This cannot be undone.`), h("div", { class: "lcp-actions" }, h("button", { type: "button", class: "small", onclick: () => p.close() }, "Cancel"), yes)), { label: "Remove all drawings" });
    yes.focus({ preventScroll: true });
  }
  function editText(d, isNew = false) {
    const input = h("input", { type: "text", maxlength: "120", value: d.text ?? "", "aria-label": "Text", placeholder: "Type a note" });
    const at = geo ? (() => {
      const r = over.getBoundingClientRect();
      return { x: r.left + X(toPt(d.pts[0]).i), y: r.top + Y(d.pts[0].p) + 10 };
    })() : null;
    const done = () => {
      const t = input.value.trim();
      p.close();
      if (!t && isNew) {
        drawings = drawings.filter((x) => x !== d);
        selected = null;
      } else editDrawing(d, { text: t || d.text || "Text" });
      saveDrawings();
      scheduleOver();
    };
    const p = floatPanel(plot, h("div", { class: "lcp-settings" }, h("label", { class: "field lcp-field" }, h("span", {}, "Text"), input), h("div", { class: "lcp-actions" }, h("button", { type: "button", class: "small primary", onclick: done }, "Done"))), { label: "Text", at });
    input.addEventListener("keydown", (e) => e.key === "Enter" && done());
    input.focus({ preventScroll: true });
  }

  // ── Drawing mode and tools ──
  function setDrawMode(on) {
    drawMode = on;
    drawBtn.setAttribute("aria-pressed", String(on));
    toolbar.hidden = !on;
    if (!on) pickTool(null);
  }
  function pickTool(t) {
    tool = t;
    draft = null;
    if (t && !drawMode) setDrawMode(true);
    for (const b of toolBtns) b.setAttribute("aria-pressed", String(b.dataset.tool === t));
    plot.classList.toggle("lcp-placing", Boolean(t));
    hint.hidden = !t;
    if (t) hint.textContent = { trend: "Click two points", ray: "Click where it starts, then its direction", hline: "Click a price", channel: "Click two points, then the width", fib: "Click the swing start, then its end", rect: "Click two corners", long: "Click the entry", short: "Click the entry", text: "Click where the note goes", measure: "Click two points" }[t];
    if (t !== "measure") measure = null;
    scheduleOver();
  }
  /** A point under the pointer: the nearest bar, the price snapped to its O/H/L/C when close (magnet). */
  function pointAt(x, y) {
    const i = Math.round(geo.X.iOf(x));
    const s = chart.model.series.find((q) => q.type === "candles");
    const c = s ? C.valueAt(s, i) : null;
    return { i, p: P.magnet(main().vOf(y), c, Y, 6) };
  }
  function place(x, y, dragEnd = false) {
    if (!geo || !inMain(y)) return;
    const q = pointAt(x, y);
    if (tool === "measure") {
      if (!measure || measure.pts.length >= 2) measure = { pts: [q, q] };
      else {
        measure.pts[1] = q;
        measure.done = true;
        pickTool(null);
        measure = { pts: measure.pts, done: true };
      }
      return scheduleOver();
    }
    const need = P.TOOL_POINTS[tool];
    if (!draft) {
      draft = { id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, type: tool, pts: [fromPt(q)], tone: undefined };
      if (tool === "long" || tool === "short") {
        const m = main();
        const dflt = P.positionDefaults(tool, q.p, m.hi - m.lo);
        const right = q.i + Math.max(8, (geo.X.to - geo.X.from) * 0.18);
        draft.pts = [fromPt(q), fromPt({ i: right, p: q.p }), fromPt({ i: q.i, p: dflt.target }), fromPt({ i: q.i, p: dflt.stop })];
      } else if (need > 1) draft.pts.push(fromPt(q));
    } else if (!dragEnd || draft.pts.length <= need) {
      draft.pts[draft.pts.length - 1] = fromPt(q);
      if (draft.pts.length < need) draft.pts.push(fromPt(q));
      else draft._done = true;
    }
    if (draft.pts.length >= need && (need === 1 || draft._done || tool === "long" || tool === "short")) finishDraft();
    scheduleOver();
  }
  function finishDraft() {
    const d = draft;
    draft = null;
    delete d._done;
    drawings.push(d);
    selected = d.id;
    saveDrawings();
    const t = tool;
    pickTool(null);
    live.textContent = `${TOOLS.find((x) => x[0] === t)?.[1] ?? "Drawing"} added`;
    if (t === "text") editText(d, true);
  }

  // ── Pointer: crosshair, pan, pinch, place, select and drag ──
  const pointers = new Map();
  let gesture = null;
  over.addEventListener("pointerenter", () => {
    pointerIn = true;
    active = self;
  });
  over.addEventListener("pointerleave", (e) => {
    if (e.relatedTarget === plus || mini.contains(/** @type {Node} */ (e.relatedTarget))) return;
    pointerIn = false;
    if (!gesture) hideCross();
  });
  plus.addEventListener("pointerleave", (e) => {
    if (e.relatedTarget !== over) {
      pointerIn = false;
      hideCross();
    }
  });
  over.addEventListener("pointermove", (e) => {
    if (!geo) return;
    const { x, y } = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x, y });
    if (gesture?.kind === "pinch" && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      setView(P.zoomView(gesture.view, gesture.dist / dist, geo.X.iOf((a.x + b.x) / 2), times().length));
      return;
    }
    if (gesture?.kind === "pan") {
      const dx = x - gesture.x;
      if (Math.abs(dx) > 2) gesture.moved = true;
      setView(P.panView(gesture.view, -dx / geo.X.slot, times().length));
    } else if (gesture?.kind === "drag") {
      dragTo(x, y);
    } else if (draft && tool) {
      const q = pointAt(x, y);
      draft.pts[draft.pts.length - 1] = fromPt(q);
      if (tool === "channel" && draft.pts.length === 3) draft.pts[2] = fromPt(q);
      scheduleOver();
    } else if (tool === "measure" && measure && !measure.done) {
      measure.pts[1] = pointAt(x, y);
      scheduleOver();
    }
    crossAt(geo.X.indexAt(x), y);
    if (!tool && !gesture) {
      const hit = inMain(y) ? P.hitTest(drawings.map((d) => ({ ...d, pts: d.pts.map(toPt) })), x, y, X, Y, geo.X.right) : null;
      plot.classList.toggle("lcp-over-drawing", Boolean(hit));
    }
  });
  over.addEventListener("pointerdown", (e) => {
    if (!geo) return;
    lastFocus = Date.now();
    active = self;
    plot.focus({ preventScroll: true });
    const { x, y } = local(e);
    if (e.button === 2) return;
    pointers.set(e.pointerId, { x, y });
    over.setPointerCapture?.(e.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = { kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, view: chart.view ?? defaultView() };
      draft = null;
      return;
    }
    if (tool) {
      gesture = { kind: "place", x, y };
      place(x, y);
      return;
    }
    if (measure?.done) {
      measure = null;
      scheduleOver();
    }
    const hit = inMain(y) ? P.hitTest(drawings.map((d) => ({ ...d, pts: d.pts.map(toPt) })), x, y, X, Y, geo.X.right) : null;
    if (hit) {
      selected = hit.id;
      const d = drawings.find((q) => q.id === hit.id);
      gesture = { kind: "drag", id: hit.id, handle: hit.handle, start: pointAt(x, y), orig: d.pts.map(toPt), moved: false };
      mini.__for = "";
      scheduleOver();
      return;
    }
    if (selected) {
      selected = null;
      scheduleOver();
    }
    gesture = { kind: "pan", x, view: chart.view ?? defaultView(), moved: false };
    plot.classList.add("lcp-panning");
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (gesture?.kind === "place" && tool && draft) {
      const { x, y } = local(e);
      if (Math.hypot(x - gesture.x, y - gesture.y) > 6) place(x, y, true);
    }
    if (gesture?.kind === "drag" && gesture.moved) saveDrawings();
    if (pointers.size === 0) {
      gesture = null;
      plot.classList.remove("lcp-panning");
    }
  };
  over.addEventListener("pointerup", endPointer);
  over.addEventListener("pointercancel", endPointer);
  over.addEventListener("dblclick", (e) => {
    const { y } = local(e);
    const hit = geo && inMain(y) ? P.hitTest(drawings.map((d) => ({ ...d, pts: d.pts.map(toPt) })), local(e).x, y, X, Y, geo.X.right) : null;
    const d = hit ? drawings.find((q) => q.id === hit.id) : null;
    if (d?.type === "text") return editText(d);
    if (!tool) resetView();
  });
  function dragTo(x, y) {
    const g = gesture;
    const d = drawings.find((q) => q.id === g.id);
    if (!d) return;
    const now = pointAt(x, y);
    const di = now.i - g.start.i;
    const dp = main().vOf(y) - main().vOf(Y(g.start.p));
    g.moved = true;
    let pts = g.orig.map((q) => ({ ...q }));
    if (g.handle < 0) pts = pts.map((q) => ({ i: q.i + di, p: q.p + dp }));
    else if (d.type === "long" || d.type === "short") {
      // entry (0) moves the whole tool's anchor; 1 is the right edge; 2 the target; 3 the stop.
      if (g.handle === 0) pts = pts.map((q, k) => ({ i: k === 1 ? q.i + di : q.i + di, p: k === 2 || k === 3 ? q.p : now.p }));
      else if (g.handle === 1) pts[1] = { i: now.i, p: pts[0].p };
      else pts[g.handle] = { i: pts[0].i, p: now.p };
    } else pts[g.handle] = now;
    d.pts = pts.map(fromPt);
    scheduleOver();
  }
  over.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!geo) return;
    const { x, y } = local(e);
    const pane = geo.panes.find((p) => p.lo !== null && y >= p.top && y <= p.priceBottom);
    const v = pane === geo.panes[0] ? pane.vOf(y) : null;
    openMenu(v, { x: e.clientX, y: e.clientY });
  });
  plus.addEventListener("click", (e) => {
    const m = main();
    if (!m || hoverY === null) return;
    const r = plus.getBoundingClientRect();
    openMenu(m.vOf(hoverY), { x: r.left - 200, y: r.bottom + 4 });
    e.stopPropagation();
  });
  over.addEventListener(
    "wheel",
    (e) => {
      if (!geo) return;
      // Zoom only when the chart is engaged (clicked, or a pinch / Ctrl wheel), so the page still scrolls past it.
      const engaged = e.ctrlKey || e.metaKey || box.contains(document.activeElement) || box.closest(".lc-expanded");
      if (!engaged && Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      const { x } = local(e);
      const count = times().length;
      const v = chart.view ?? defaultView();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) setView(P.panView(v, ((e.shiftKey ? e.deltaY : e.deltaX) / geo.X.slot) * 0.6, count));
      else setView(P.zoomView(v, Math.exp(Math.max(-0.5, Math.min(0.5, e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)))), geo.X.iOf(x), count));
    },
    { passive: false },
  );
  plot.addEventListener("focus", () => (active = self));

  // ── The right-click menu and the + on the price axis ──
  function openMenu(price, at) {
    const f = priceFmt();
    const ok = isFigure(price);
    const sym = symbolOf();
    const und = alertUnderlying(sym);
    const rows = [];
    if (ok && typeof opts.trade === "function") {
      rows.push({ label: `Buy at ${f(price)}`, tone: "pos", onClick: () => opts.trade("BUY", roundTick(price)) });
      rows.push({ label: `Sell at ${f(price)}`, tone: "neg", onClick: () => opts.trade("SELL", roundTick(price)) });
      rows.push("sep");
    }
    if (ok) {
      rows.push({ label: `Alert at ${f(price)}`, disabled: !und, title: und ? undefined : "Price alerts watch index and stock prices; this chart is a contract", onClick: () => alertAt(price, at) });
      rows.push({ label: `Copy ${f(price)}`, onClick: () => copyText(formatFixed(price, 2).replace(/[^0-9.\-−]/g, "").replace("−", "-"), "Price copied") });
      rows.push({ label: "Horizontal line here", hint: "Alt+H", onClick: () => addHLine(price) });
      rows.push("sep");
    }
    rows.push({ label: "Indicators", hint: "/", onClick: () => openLibrary(indBtn) });
    rows.push({ label: drawMode ? "Hide drawing tools" : "Drawing tools", onClick: () => setDrawMode(!drawMode) });
    if (chart.view) rows.push({ label: "Reset the view", onClick: () => resetView() });
    if (drawings.length) rows.push({ label: "Remove all drawings", onClick: () => confirmClear(moreBtn) });
    menuPanel(plot, rows, { label: ok ? `At ${f(price)}` : "Chart", at });
  }
  const roundTick = (v) => Math.round(v / 0.05) * 0.05;
  function addHLine(price) {
    const d = { id: `d${Date.now().toString(36)}`, type: "hline", pts: [{ t: times()[times().length - 1] ?? 0, p: price }], tone: undefined };
    drawings.push(d);
    selected = d.id;
    saveDrawings();
    scheduleOver();
  }
  function alertAt(price, at) {
    const und = alertUnderlying(symbolOf());
    if (!und) return;
    const lastClose = chart.model.series.find((s) => s.type === "candles")?.pts?.at(-1)?.close;
    let op = isFigure(lastClose) ? (price > lastClose ? "above" : "below") : "either";
    // Direction keeps its colour when chosen too: upward in the gain colour, downward in the loss colour.
    const mark = () => seg.querySelectorAll("button").forEach((b) => (b.setAttribute("aria-pressed", String(b.dataset.op === op)), b.toggleAttribute("data-on", b.dataset.op === op)));
    const seg = h("div", { class: "lcp-seg", role: "group", "aria-label": "Crossing" }, [["above", "Upward", "up"], ["below", "Downward", "down"], ["either", "Either way", ""]].map(([v, t, dir]) => h("button", { type: "button", class: "small lcp-dirbtn", "data-op": v, "data-dir": dir || undefined, onclick: () => ((op = v), mark()) }, t)));
    mark();
    const err = h("p", { class: "field-msg", role: "alert" });
    const create = h("button", { type: "button", class: "small primary" }, "Create alert");
    const p = floatPanel(plot, h("div", { class: "lcp-settings" }, h("div", { class: "lcp-lib-head" }, h("h3", {}, `${und} crosses ${priceFmt()(price)}`)), seg, h("p", { class: "lcp-sub" }, "Checked on the Bridge every minute in market hours, with this page closed too. Alerts only notify: nothing is bought or sold."), err, h("div", { class: "lcp-actions" }, h("button", { type: "button", class: "small", onclick: () => p.close() }, "Cancel"), create)), { label: "New price alert", at });
    create.addEventListener("click", async () => {
      create.disabled = true;
      try {
        const r = await api("/v1/alerts/market", { method: "POST", body: { name: `${und} crosses ${formatFixed(price, 2)}${op === "either" ? "" : op === "above" ? " upward" : " downward"}`, underlying: und, metric: "spot_cross", value: Math.round(price * 100) / 100, op, everyMinutes: 1, marketHoursOnly: true, enabled: true } });
        p.close();
        toast(`Alert on: ${r.data?.data?.name ?? `${und} crosses ${priceFmt()(price)}`}`);
        import("./alerts.js").then((m) => m.alertsChanged?.()).catch(() => {});
      } catch (x) {
        err.textContent = x?.message ?? "Could not create the alert.";
        create.disabled = false;
      }
    });
    create.focus({ preventScroll: true });
  }

  // ── Keys (when this chart is the one in use) ──
  function key(e) {
    const k = e.key;
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const t = { t: "trend", h: "hline", f: "fib" }[(e.code?.startsWith("Key") ? e.code.slice(3) : k).toLowerCase()];
      if (t) {
        e.preventDefault();
        pickTool(t);
      }
      return;
    }
    if (e.ctrlKey || e.metaKey) return;
    if (k === "/") {
      e.preventDefault();
      openLibrary(indBtn);
    } else if (k === "Escape") {
      if (tool || draft || measure || selected) {
        e.preventDefault();
        draft = null;
        measure = null;
        selected = null;
        pickTool(null);
      }
    } else if ((k === "Delete" || k === "Backspace") && selected) {
      e.preventDefault();
      deleteSelected();
    } else if (document.activeElement === plot) {
      const count = times().length;
      const v = chart.view ?? defaultView();
      if (k === "ArrowLeft" || k === "ArrowRight") {
        e.preventDefault();
        if (e.shiftKey) setView(P.panView(v, (k === "ArrowLeft" ? -1 : 1) * Math.max(1, (v.to - v.from) / 8), count));
        else {
          const i = Math.max(0, Math.min(count - 1, (hoverI >= 0 ? hoverI : count - 1) + (k === "ArrowLeft" ? -1 : 1)));
          crossAt(i, null);
          const s = chart.model.series.find((q) => q.type === "candles");
          const p = s ? C.valueAt(s, i) : null;
          if (p) live.textContent = `${C.formatStamp(times()[i], chart.model.kind)}: open ${priceFmt()(p.open)}, high ${priceFmt()(p.high)}, low ${priceFmt()(p.low)}, close ${priceFmt()(p.close)}`;
        }
      } else if (k === "+" || k === "=" || k === "-") {
        e.preventDefault();
        setView(P.zoomView(v, k === "-" ? 1.25 : 0.8, hoverI >= 0 ? hoverI : v.to, count));
      } else if (k === "0" || k === "Home") {
        e.preventDefault();
        resetView();
      }
    }
  }

  const self = {
    box,
    get alive() {
      return alive;
    },
    engaged: () => pointerIn || box.contains(document.activeElement) || Date.now() - lastFocus < 4000,
    key,
    hasSymbol: () => Boolean(symbolOf()),
    syncCross(t) {
      if (!geo || !alive || !box.isConnected) return;
      if (t === null) {
        if (!pointerIn) hideCross(false);
        return;
      }
      const i = P.nearestIndex(times(), t);
      if (i < 0) return hideCross(false);
      crossAt(i, null, false);
    },
    syncTimeframe(next) {
      if (!symbolOf()) return;
      setTimeframe(next, true, true);
    },
    render,
    timeframe,
    onDraw,
    /** True when a Bridge study is on and the page picks its own interval: the loader should read daily candles. */
    wantsDaily: () => !tf && studies.some((s) => s.src === "bridge" && !s.hidden),
    get tf() {
      return tf;
    },
    /** For other modules (shortcuts, workspaces): the symbol, the last price and the controls. */
    get publicApi() {
      return {
        symbol: symbolOf(),
        get interval() {
          return interval;
        },
        get last() {
          return chart.model?.series?.find((s) => s.type === "candles")?.pts?.at(-1)?.close ?? null;
        },
        setInterval: (iv) => setTimeframe({ interval: iv }, true),
        setRange: (r) => setTimeframe({ range: r }, true),
        openIndicators: () => openLibrary(indBtn),
        resetView,
        trade: typeof opts.trade === "function" ? (side) => opts.trade(side, null) : null,
      };
    },
    destroy() {
      alive = false;
      charts.delete(self);
      if (active === self) active = null;
      if (rafOver) cancelAnimationFrame(rafOver);
      openPanel?.close();
    },
  };
  charts.add(self);
  paintCount();
  return self;
}
