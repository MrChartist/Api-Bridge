// Ported from MrChartist/scanner src/components/patterns/lite-chart, <commit c2ac504> (PatternLiteChart.tsx,
// LevelLayer.tsx, useMeasuredBox.ts, useDevicePixelRatio.ts, useInView.ts). The scanner code is the owner's own; all
// rights reserved.
//
// chart-lite.js: the dashboard's light chart engine, registered as app.chartEngine (app.js loads it on the first chart
// slot, so pages without a chart never fetch it). One SVG per chart: strokes and fills take the theme's CSS variables
// by class (app.css section 18, `.lc-`), so a theme switch repaints nothing; text is real text; the SVG has role="img"
// and a summary label. Crispness: the SVG is a whole number of device pixels and every hard edge is snapped to the
// device grid (chart-lite-core.js). Geometry, scales and the time axis are pure and tested in chart-lite-core.test.mjs.
//
// Static by default: a chart draws when its data or its box changes, never on a timer. `update(spec)` and
// `addSeries(series)` redraw once on the next frame, however many calls come in. Studies (indicators from
// packages/chartist-core, later) are plain extra series: addSeries({ type: "line" | "area" | "marker", ... }).
//
// Cleanup (docs/perf/baseline.md, route-change leaks): one ResizeObserver per chart, disconnected when the chart is
// destroyed; a chart whose box has left the document destroys itself (its observer fires on removal, and every route
// change sweeps). The device pixel ratio has ONE listener for the whole page.
import { emptyState, errorState, h, icon, modal, toast } from "./app.js";
import * as C from "./chart-lite-core.js";
import * as P from "./chart-pro-core.js";
import { chartId, createPro, savedTimeframe } from "./chart-pro.js";
import { DASH, formatCompactTick, formatFixed, formatSigned, isFigure } from "./format.js";
import { legend, scrubber, svgEl } from "./viz.js";

const TONES = new Set(["call", "put", "pos", "neg", "iv", "spot", "today", "warn", "hv", "muted"]);
const toneOf = (t, d = "spot") => (TONES.has(t) ? t : d);

/** The positions [k0, k1] in a sorted point list whose bar index is within [a, b] (k1 < k0 when none). */
function ptsRange(pts, a, b) {
  let lo = 0;
  let hi = pts.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (pts[m].i < a) lo = m + 1;
    else hi = m;
  }
  const k0 = lo;
  hi = pts.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (pts[m].i <= b) lo = m + 1;
    else hi = m;
  }
  return [k0, lo - 1];
}
const slicePts = (pts, a, b) => {
  const [k0, k1] = ptsRange(pts, a, b);
  return pts.slice(k0, k1 + 1);
};
/** Decimals of a percent axis: one when its ticks are under a percent apart. */
const pctDp = (p) => (P.niceStep(((p.hi - p.lo) / p.scaleBase) * 100) < 1 ? 1 : 0);

// ── One device-pixel-ratio listener and one route sweep for every chart on the page ──
const live = new Set();
const readDpr = () => (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
let dprQuery = null;
const onDpr = () => {
  armDpr();
  for (const c of live) c.redraw();
};
function armDpr() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  dprQuery?.removeEventListener?.("change", onDpr);
  dprQuery = window.matchMedia(`(resolution: ${readDpr()}dppx)`);
  dprQuery.addEventListener?.("change", onDpr);
}
let swept = false;
function sweep() {
  for (const c of [...live]) if (!c.host.isConnected) c.destroy();
}
function armSweep() {
  if (swept || typeof window === "undefined") return;
  swept = true;
  armDpr();
  // The router swaps the page on hashchange; check once it has.
  window.addEventListener("hashchange", () => setTimeout(sweep, 0));
}

/** Charts alive on the page (tests and the perf harness read it). */
export const liveCharts = () => live.size;

/** Axis text for a pane: the caller's formatter, else compact units for big counts and the tick step's decimals. */
function axisFormat(pane, ticks) {
  if (typeof pane.format === "function") return pane.format;
  const big = ticks.some((v) => Math.abs(v) >= 1e5);
  const dp = C.tickDecimals(ticks);
  return (v) => (big ? formatCompactTick(v) : formatFixed(v, dp));
}

/** Tooltip text of a value: the series' formatter, its pane's, or two decimals. */
const tipFormat = (s, pane) => s.format ?? pane?.format ?? ((v) => (Math.abs(v) >= 1e5 ? formatCompactTick(v) : formatFixed(v, 2)));

/**
 * Create a chart in `host` (an element whose CSS gives it a height; `.lc-chart` does). Returns
 * { update(spec), addSeries(series), removeSeries(id), redraw(), destroy(), get spec, host }.
 * Options for the chart tools (chart-pro.js): `pro` (no tooltip scrubber: the tools draw their own crosshair),
 * `onDraw(geo)` after every draw. `chart.setView({ from, to })` zooms and pans, `chart.setLook({ scale, grid,
 * volume })` sets the price scale ("linear" | "log" | "percent"), the grid and the volume strip.
 * @param {HTMLElement} host
 * @param {object} spec  see chart-lite-core.js buildModel; plus label, note
 * @param {{ pro?: boolean, onDraw?: Function }} [o]
 */
let clipSeq = 0;
export function createChart(host, spec = {}, o = {}) {
  armSweep();
  sweep();
  let view = null;
  let look = { scale: "linear", grid: true, volume: true };
  const clipId = `lc-clip-${(clipSeq += 1)}`;
  let cur = { ...spec, series: [...(spec.series ?? [])] };
  let model = C.buildModel(cur);
  let raf = 0;
  let dead = false;
  let last = { w: 0, h: 0, dpr: 0 };
  let geo = null;
  host.classList.add("lc-chart");
  const setPanes = () => (host.dataset.panes = String(Math.max(1, model.panes.length)));
  setPanes();
  const svg = svgEl("svg", { class: "lc-svg", role: "img", focusable: "false" });
  const plot = h("div", { class: "lc-plot" }, svg);
  const legendHost = h("div", { class: "lc-legend" });
  const note = h("p", { class: "lc-note", hidden: true });
  const emptyHost = h("div", { class: "lc-empty", hidden: true });
  host.replaceChildren(legendHost, plot, emptyHost, note);
  const scrub = o.pro ? { clear() {}, destroy() {} } : scrubber(plot, {
    steps: () => (geo ? model.times.length : 0),
    label: `${cur.label ?? "Chart"}: use the arrow keys to read values`,
    indexAt: (x) => (geo ? geo.X.indexAt(x) : -1),
    at: (i) => (geo ? { x: geo.X.xOf(i), content: tipContent(i) } : null),
  });
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => (host.isConnected ? schedule() : chart.destroy())) : null;
  ro?.observe(plot);

  function schedule() {
    if (dead || raf) return;
    raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(draw) : setTimeout(draw, 16);
  }

  function tipContent(i) {
    const t = model.times[i];
    const rows = [h("b", {}, C.formatStamp(t, model.kind))];
    for (const s of model.series) {
      if (!s.label || s.type === "level" || s.type === "marker" || s.type === "band") continue;
      const p = C.valueAt(s, i);
      if (!p) continue;
      const pane = model.panes.find((x) => x.id === s.pane);
      const f = tipFormat(s, pane);
      if (s.type === "candles") {
        rows.push(h("div", { class: "row" }, h("span", {}, s.label), h("span", {}, `O ${f(p.open)} H ${f(p.high)}`)));
        rows.push(h("div", { class: "row" }, h("span", {}, ""), h("span", {}, `L ${f(p.low)} C ${f(p.close)}`)));
        if (s.volume && p.volume > 0) rows.push(h("div", { class: "row" }, h("span", {}, "Volume"), h("span", {}, formatCompactTick(p.volume))));
      } else if (Number.isFinite(p.v)) {
        rows.push(h("div", { class: "row" }, h("span", { class: "lc-tip-key", "data-dv": toneOf(p.tone ?? s.tone) }, s.label), h("span", {}, f(p.v))));
      }
    }
    return rows;
  }

  function summary() {
    const parts = [cur.label ?? "Chart"];
    if (model.times.length) parts.push(`${model.kind === "intraday" ? "intraday" : model.kind} from ${C.formatStamp(model.times[0], model.kind)} to ${C.formatStamp(model.times[model.times.length - 1], model.kind)}`);
    for (const s of model.series) {
      if (!s.label) continue;
      const pane = model.panes.find((x) => x.id === s.pane);
      const f = tipFormat(s, pane);
      if (s.type === "level") parts.push(`${s.label}`);
      else if (s.type === "candles" && s.pts.length) parts.push(`${s.label} last close ${f(s.pts[s.pts.length - 1].close)}`);
      else if ((s.type === "line" || s.type === "area" || s.type === "bars") && s.pts.length) {
        const lastP = [...s.pts].reverse().find((p) => Number.isFinite(p.v));
        if (lastP) parts.push(`${s.label} last ${f(lastP.v)}`);
      }
    }
    return parts.join(". ");
  }

  function drawLegend() {
    const items = model.series
      .filter((s) => s.label && s.legend !== false && s.type !== "level" && s.type !== "marker")
      .map((s) => ({ label: s.label, token: s.type === "candles" ? "pos" : toneOf(s.tone), kind: s.type === "band" || s.type === "bars" || s.type === "candles" ? "swatch" : s.dash ? "dash" : "line" }));
    const sig = JSON.stringify(items);
    if (legendHost.__sig === sig) return;
    legendHost.__sig = sig;
    legendHost.replaceChildren(items.length > 1 ? legend(items, { label: `${cur.label ?? "Chart"} legend` }) : "");
  }

  function setEmpty(e) {
    const on = Boolean(e);
    emptyHost.hidden = !on;
    plot.hidden = on;
    legendHost.hidden = on;
    if (on) emptyHost.replaceChildren(emptyState("chart", e.title ?? "Nothing to draw yet", e.text ?? "", null, { compact: true }));
  }

  function draw() {
    raf = 0;
    if (dead) return;
    const n = cur.note ?? "";
    if (note.textContent !== n) note.textContent = n;
    note.hidden = !n;
    if (cur.empty || !model.hasData) {
      geo = null;
      scrub.clear();
      setEmpty(cur.empty ?? { title: "No data yet", text: "" });
      return;
    }
    setEmpty(null);
    drawLegend();
    const dpr = readDpr();
    const W = C.deviceFloor(plot.clientWidth, dpr);
    const H = C.deviceFloor(plot.clientHeight, dpr);
    if (W < 60 || H < 60) return; // hidden or not laid out yet: the observer calls again when it is
    last = { w: W, h: H, dpr };
    const count = model.times.length;
    if (view) view = P.clampView(view, count);
    const range = view ? P.visibleRange(view, count) : [0, count - 1];
    const mainPane = model.panes[0]?.id;
    const scale = look.scale !== "linear" && mainPane ? { pane: mainPane, mode: look.scale, base: baseValue(mainPane, range[0]) } : null;
    const panes = C.layoutPanes(model, H, { range: view ? range : null, scale, noVolume: !look.volume });
    const levelsOf = (p) => model.series.filter((s) => s.type === "level" && s.pane === p.id && s.label);
    const fmts = new Map(panes.map((p) => [p.id, axisFormat(p, p.ticks)]));
    const tickTexts = panes.flatMap((p) => p.ticks.map((v) => fmts.get(p.id)(v)));
    const capsOf = new Map(panes.map((p) => [p.id, p.lo === null ? [] : C.placeCapsules(levelsOf(p).map((l) => ({ id: l.id, value: l.value, text: l.label, tone: toneOf(l.tone, "muted") })), p)]));
    const capTexts = [...capsOf.values()].flat().map((c) => c.text);
    const X = C.layoutX(model, W, C.gutterFor(tickTexts, capTexts), view);
    if (!X) return;
    geo = { X, panes, W, H, dpr, range };
    /** The points of a series that are on screen, with one either side so lines run off the edges. */
    const vis = (pts) => (view ? slicePts(pts, range[0] - 1, range[1] + 1) : pts);
    const hair = C.hairline(dpr);
    const layers = { grid: [], fill: [], marks: [], lines: [], levels: [], text: [] };
    const vt = view ? model.times.slice(range[0], range[1] + 1) : model.times;
    const timeTicks = C.planTimeTicks({ times: vt, xOf: (j) => X.xOf(j + (view ? range[0] : 0)), left: X.left, right: X.right, kind: model.kind });
    const lastPane = panes[panes.length - 1];

    for (const p of panes) {
      if (p.lo === null) continue;
      const f = p.scaleMode === "percent" ? (v) => `${formatSigned(P.pctFrom(v, p.scaleBase), pctDp(p))}%` : fmts.get(p.id);
      const caps = capsOf.get(p.id);
      // Horizontal grid and price ticks (those a capsule does not cover).
      for (const v of C.hideTicks(p.ticks, p, caps)) {
        const y = C.crisp(p.yOf(v), dpr, hair);
        layers.grid.push(svgEl("line", { class: "lc-grid", x1: C.n3(X.left), x2: C.n3(X.right), y1: C.n3(y), y2: C.n3(y), "stroke-width": C.n3(hair) }));
        layers.text.push(svgEl("text", { class: "lc-tick", x: C.n3(X.right + 6), y: C.n3(p.yOf(v) + 4) }, f(v)));
      }
      if (p.include?.includes(0) || model.series.some((s) => s.pane === p.id && (s.type === "bars" || s.signed))) {
        const y0 = C.crisp(p.yOf(0), dpr, hair);
        if (y0 >= p.top && y0 <= p.priceBottom) layers.grid.push(svgEl("line", { class: "lc-zero", x1: C.n3(X.left), x2: C.n3(X.right), y1: C.n3(y0), y2: C.n3(y0), "stroke-width": C.n3(hair) }));
      }
      // Pane label (top left), and a seam between panes.
      if (p.label) layers.text.push(svgEl("text", { class: "lc-pane-label", x: C.n3(X.left + 2), y: C.n3(p.labelTop + 12) }, p.label));
      if (p !== lastPane) {
        const ys = C.crisp(p.bottom + C.LC_PAD.gap / 2, dpr, hair);
        layers.grid.push(svgEl("line", { class: "lc-seam", x1: 0, x2: C.n3(W), y1: C.n3(ys), y2: C.n3(ys), "stroke-width": C.n3(hair) }));
      }
      for (const s of model.series) {
        if (s.pane !== p.id) continue;
        const tone = toneOf(s.tone);
        if (s.type === "band") {
          if (s.pts) layers.fill.push(svgEl("path", { class: "lc-band", "data-tone": toneOf(s.tone, "iv"), d: C.bandPath(vis(s.pts), X.xOf, p.yOf) }));
          else {
            const y1 = C.snap(p.yOf(Math.max(Number(s.lo), Number(s.hi))), dpr);
            const y2 = C.snap(p.yOf(Math.min(Number(s.lo), Number(s.hi))), dpr);
            layers.fill.push(svgEl("rect", { class: "lc-band", "data-tone": toneOf(s.tone, "iv"), "data-strength": s.strength ?? undefined, x: C.n3(X.left), y: C.n3(Math.max(p.top, y1)), width: C.n3(X.right - X.left), height: C.n3(Math.max(0, Math.min(p.priceBottom, y2) - Math.max(p.top, y1))) }));
            if (s.label && y2 - y1 > 16) layers.text.push(svgEl("text", { class: "lc-band-label", "data-tone": toneOf(s.tone, "iv"), x: C.n3(X.left + 4), y: C.n3(Math.max(p.top, y1) + 13) }, s.label));
          }
        } else if (s.type === "area") {
          const base = Number.isFinite(Number(s.baseline)) ? p.yOf(Number(s.baseline)) : p.priceBottom;
          if (s.signed) {
            const sp = C.splitSigned(vis(s.pts));
            const y0 = p.yOf(0);
            layers.fill.push(svgEl("path", { class: "lc-area", "data-tone": "pos", d: C.areaPath(sp.pos, X.xOf, p.yOf, y0) }));
            layers.fill.push(svgEl("path", { class: "lc-area", "data-tone": "neg", d: C.areaPath(sp.neg, X.xOf, p.yOf, y0) }));
            layers.lines.push(svgEl("path", { class: "lc-line", "data-tone": "pos", d: C.linePath(sp.pos, X.xOf, p.yOf) }));
            layers.lines.push(svgEl("path", { class: "lc-line", "data-tone": "neg", d: C.linePath(sp.neg, X.xOf, p.yOf) }));
          } else {
            layers.fill.push(svgEl("path", { class: "lc-area", "data-tone": tone, d: C.areaPath(vis(s.pts), X.xOf, p.yOf, base) }));
            layers.lines.push(svgEl("path", { class: "lc-line", "data-tone": tone, d: C.linePath(vis(s.pts), X.xOf, p.yOf) }));
          }
        } else if (s.type === "bars") {
          const paths = C.histogramPaths(vis(s.pts), X.xOf, p.yOf, X.slot, dpr, { signed: s.signed, tone });
          for (const [k, d] of Object.entries(paths)) layers.marks.push(svgEl("path", { class: "lc-bar", "data-tone": toneOf(k), d, "shape-rendering": "crispEdges" }));
        } else if (s.type === "candles") {
          const [k0, k1] = view ? ptsRange(s.pts, range[0], range[1]) : [0, s.pts.length - 1];
          if (k1 < k0) continue;
          const { bars, step } = C.groupBars(s.pts, k0, k1, Math.max(1, Math.floor((X.right - X.left) / C.MIN_SLOT)));
          const slot = X.slot * step;
          const g = svgEl("g", { class: "lc-candles", "data-style": s.style ?? undefined, "shape-rendering": "crispEdges" });
          if (s.style === "ohlc") {
            const op = C.ohlcPaths(bars, X.xOf, p.yOf, slot, dpr);
            g.append(svgEl("path", { class: "lc-wick lc-ohlc", "data-dir": "up", d: op.up, "stroke-width": C.n3(Math.max(hair, 1)) }), svgEl("path", { class: "lc-wick lc-ohlc", "data-dir": "down", d: op.down, "stroke-width": C.n3(Math.max(hair, 1)) }));
          } else {
            const cp = C.candlePaths(bars, X.xOf, p.yOf, slot, dpr);
            g.append(
              svgEl("path", { class: "lc-wick", "data-dir": "up", d: cp.upWick, "stroke-width": C.n3(hair) }),
              svgEl("path", { class: "lc-wick", "data-dir": "down", d: cp.downWick, "stroke-width": C.n3(hair) }),
              svgEl("path", { class: "lc-body", "data-dir": "up", d: cp.upBody, "stroke-width": s.style === "hollow" ? C.n3(Math.max(hair, 1)) : undefined }),
              svgEl("path", { class: "lc-body", "data-dir": "down", d: cp.downBody }),
            );
          }
          layers.marks.push(g);
          if (p.volumeBand) {
            const vp = C.volumePaths(bars, X.xOf, p.volumeBand, slot, dpr);
            layers.marks.push(svgEl("path", { class: "lc-vol", "data-dir": "up", d: vp.up, "shape-rendering": "crispEdges" }), svgEl("path", { class: "lc-vol", "data-dir": "down", d: vp.down, "shape-rendering": "crispEdges" }));
          }
        } else if (s.type === "line") {
          layers.lines.push(svgEl("path", { class: s.dash ? "lc-line dash" : "lc-line", "data-tone": tone, "data-weight": s.weight ?? undefined, d: C.linePath(vis(s.pts), X.xOf, p.yOf) }));
        }
      }
      // Levels: a crisp ray over the plot and a capsule in the gutter (LevelLayer.tsx), led back when nudged.
      for (const c of caps) {
        const y = C.crisp(c.y, dpr, 1);
        const lvl = model.series.find((s) => s.id === c.id);
        if (!c.off) layers.levels.push(svgEl("line", { class: lvl?.dash === false ? "lc-ray" : "lc-ray dash", "data-tone": c.tone, x1: C.n3(X.left), x2: C.n3(X.right), y1: C.n3(y), y2: C.n3(y) }));
        const w = C.estimateWidth(c.text, C.AXIS_FONT, 600) + C.CAPSULE_PAD * 2;
        const cx = Math.max(X.right + 2, Math.min(X.right + 4, W - w - 1));
        const g = svgEl("g", { class: "lc-cap", "data-tone": c.tone });
        if (!c.off && Math.abs(c.ly - c.y) > 2.5) g.append(svgEl("line", { class: "lc-cap-lead", x1: C.n3(X.right), y1: C.n3(c.y), x2: C.n3(cx), y2: C.n3(c.ly) }));
        g.append(svgEl("rect", { x: C.n3(cx), y: C.n3(c.ly - C.CAPSULE_H / 2), width: C.n3(w), height: C.CAPSULE_H, rx: C.CAPSULE_H / 2 }), svgEl("text", { x: C.n3(cx + C.CAPSULE_PAD), y: C.n3(c.ly + 4.2) }, c.text));
        layers.levels.push(g);
      }
      // Levels without a label: the ray alone.
      for (const s of model.series) {
        if (s.type !== "level" || s.pane !== p.id || s.label || !(Number(s.value) >= p.lo && Number(s.value) <= p.hi)) continue;
        const y = C.crisp(p.yOf(Number(s.value)), dpr, 1);
        layers.levels.push(svgEl("line", { class: s.dash === false ? "lc-ray" : "lc-ray dash", "data-tone": toneOf(s.tone, "muted"), x1: C.n3(X.left), x2: C.n3(X.right), y1: C.n3(y), y2: C.n3(y) }));
      }
    }
    // Vertical markers (an event, an expiry, a revision): a crisp dashed rule over every pane, its label on top.
    const top = panes[0]?.top ?? 0;
    const bottom = lastPane?.priceBottom ?? H;
    for (const s of model.series) {
      if (s.type !== "marker" || s.i < range[0] || s.i > range[1]) continue;
      const x = C.crisp(X.xOf(s.i), dpr, 1);
      layers.levels.push(svgEl("line", { class: "lc-marker", "data-tone": toneOf(s.tone, "today"), x1: C.n3(x), x2: C.n3(x), y1: C.n3(top), y2: C.n3(bottom) }));
      if (s.label) layers.text.push(svgEl("text", { class: "lc-marker-label", "data-tone": toneOf(s.tone, "today"), x: C.n3(Math.min(X.right - 4, x + 4)), y: C.n3(top + 13), "text-anchor": x + 4 + C.estimateWidth(s.label) > X.right ? "end" : "start" }, s.label));
    }
    // Time axis: the baseline, a tick and a label per planned tick, and a faint vertical grid.
    const axisY = C.crisp(bottom, dpr, hair);
    layers.grid.push(svgEl("line", { class: "lc-axis", x1: C.n3(X.left), x2: C.n3(X.right), y1: C.n3(axisY), y2: C.n3(axisY), "stroke-width": C.n3(hair) }));
    for (const t of timeTicks) {
      const x = C.crisp(t.x, dpr, hair);
      layers.grid.push(svgEl("line", { class: "lc-vgrid", "data-level": t.level, x1: C.n3(x), x2: C.n3(x), y1: C.n3(top), y2: C.n3(axisY + (t.level > 1 ? 6 : 4)), "stroke-width": C.n3(hair) }));
      layers.text.push(svgEl("text", { class: "lc-time", "data-level": t.level, x: C.n3(t.textX), y: C.n3(H - 6), "text-anchor": "middle" }, t.text));
    }
    svg.setAttribute("width", C.n3(W));
    svg.setAttribute("height", C.n3(H));
    svg.setAttribute("viewBox", `0 0 ${C.n3(W)} ${C.n3(H)}`);
    svg.setAttribute("aria-label", summary());
    svg.dataset.kind = model.kind;
    // Zoomed: marks and lines are clipped to the plot so nothing runs into the price axis.
    const clip = view ? `url(#${clipId})` : undefined;
    svg.replaceChildren(
      ...(view ? [svgEl("defs", {}, svgEl("clipPath", { id: clipId }, svgEl("rect", { x: C.n3(X.left), y: 0, width: C.n3(X.right - X.left), height: C.n3(H) })))] : []),
      svgEl("g", { class: look.grid ? "lc-l-grid" : "lc-l-grid lc-nogrid", "shape-rendering": "crispEdges" }, layers.grid),
      svgEl("g", { class: "lc-l-fill", "clip-path": clip }, layers.fill),
      svgEl("g", { class: "lc-l-marks", "clip-path": clip }, layers.marks),
      svgEl("g", { class: "lc-l-lines", "clip-path": clip }, layers.lines),
      svgEl("g", { class: "lc-l-levels" }, layers.levels),
      svgEl("g", { class: "lc-l-text", "aria-hidden": "true" }, layers.text),
    );
    o.onDraw?.(geo);
  }

  /** The percent scale's base: the first value on screen of the main pane's candles (or first line). */
  function baseValue(paneId, from) {
    const s = model.series.find((x) => x.pane === paneId && x.type === "candles") ?? model.series.find((x) => x.pane === paneId && (x.type === "line" || x.type === "area"));
    if (!s?.pts?.length) return null;
    const [k] = ptsRange(s.pts, from, Infinity);
    const p = s.pts[Math.min(k, s.pts.length - 1)];
    return s.type === "candles" ? p.close : Number.isFinite(p.v) ? p.v : null;
  }

  const chart = {
    host,
    plot,
    get spec() {
      return cur;
    },
    /** The last draw's geometry: { X, panes, W, H, dpr, range } (null before the first draw). */
    get geo() {
      return geo;
    },
    get view() {
      return view;
    },
    /** Zoom and pan: a view { from, to } in bar indices, or null for every bar. Redraws on the next frame. */
    setView(v) {
      view = v ? P.clampView(v, model.times.length) : null;
      schedule();
    },
    get look() {
      return look;
    },
    /** { scale: "linear" | "log" | "percent", grid: boolean, volume: boolean } */
    setLook(next) {
      look = { ...look, ...next };
      schedule();
    },
    get model() {
      return model;
    },
    /** Replace the chart's data (a whole spec, or { series } only). Redraws once, on the next frame. */
    update(next = {}) {
      if (dead) return chart;
      cur = { ...cur, ...next, series: [...(next.series ?? cur.series ?? [])] };
      if (!("empty" in next)) delete cur.empty;
      model = C.buildModel(cur);
      setPanes();
      schedule();
      return chart;
    },
    /** Add one series (a study: line, area, bars, marker, level or band). Returns its id. */
    addSeries(s) {
      const id = s?.id ?? `x${cur.series.length}`;
      chart.update({ series: [...cur.series.filter((x) => x.id !== id), { ...s, id }] });
      return id;
    },
    removeSeries(id) {
      chart.update({ series: cur.series.filter((x) => x.id !== id) });
    },
    /** Show an empty state in place of the plot: { title, text }. */
    empty(e) {
      cur = { ...cur, empty: e };
      schedule();
      return chart;
    },
    redraw() {
      last = { w: 0, h: 0, dpr: 0 };
      schedule();
    },
    destroy() {
      if (dead) return;
      dead = true;
      live.delete(chart);
      ro?.disconnect();
      scrub.destroy?.();
      if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
      raf = 0;
    },
    get alive() {
      return !dead;
    },
    get size() {
      return last;
    },
  };
  live.add(chart);
  schedule();
  return chart;
}

// ── Chart slots ──

/** A spec draws candles (the chart tools attach to it). */
const hasCandles = (spec) => Boolean(spec?.series?.some((s) => s?.type === "candles"));

/**
 * A chart slot (app.js chartSlot): loads its data when it comes near the viewport, shows a skeleton, an error with
 * Retry or an honest empty state, and redraws in place on `set` / `reload`. `opts`:
 *   { id?, label, data?: spec, load?: (ctx) => Promise<spec>, refreshMs?: number, expand?: boolean,
 *     symbol?: () => string|null, studies?: { symbol: () => string|null }, trade?: (side, price) => void,
 *     pro?: boolean }
 * A candle chart gets the chart tools (chart-pro.js: header, ranges and intervals, chart types, zoom, crosshair,
 * menus, drawings, indicators) unless `pro: false`. With a symbol (`symbol`, or the older `studies.symbol`) the
 * header's ranges and intervals reload the candles from /v1/history; `trade` lets the chart menu open the page's
 * order ticket prefilled at a price. The loader is called with { label, studies, interval, range }: `studies` is true
 * when a daily-only (Bridge) indicator is on and the page picks the interval; `interval` / `range` are the chosen time
 * frame (a loader that honours them sets `interval` on its spec and the slot does not fetch again).
 * A loader may return { empty: { title, text } } when there is no data source or nothing recorded yet.
 * Returns { set(spec), load(loader), reload(), destroy(), chart, pro }.
 */
export function mountSlot(box, opts = {}) {
  let loader = opts.load ?? null;
  let chart = null;
  let pro = null;
  let seen = typeof IntersectionObserver === "undefined";
  let io = null;
  let timer = 0;
  let seq = 0;
  let dead = false;
  let pending = opts.data ?? null;
  const host = h("div", { class: "lc-host" });
  // A static placeholder at the chart's height until it loads (no layout shift); it shimmers (.skel) only while a load
  // is in flight, so a chart still below the fold neither animates nor reads as a page that is loading.
  const skel = h("div", { class: "lc-skel", "aria-hidden": "true" });
  const status = h("div", { class: "lc-status" }, skel);
  // A chart in a narrow panel (the chain's sheet, the screener's pane) opens full size in the chart modal.
  const expand = opts.expand ? h("button", { type: "button", class: "small lc-expand", "aria-label": `Open ${opts.label ?? "the chart"} full size`, onclick: () => loader && openChartModal(opts.label ?? "Chart", { ...opts, load: loader }) }, icon("external"), h("span", {}, "Expand")) : null;
  const headHost = h("div", { class: "lc-tools" }, expand);
  headHost.hidden = !expand;
  box.replaceChildren(headHost, status, host);
  host.hidden = true;
  const wantPro = (spec) => opts.pro !== false && (opts.pro === true || hasCandles(spec));

  const ensure = (spec) => {
    if (chart?.alive) return chart;
    const asPro = wantPro(spec);
    chart = createChart(host, { label: opts.label }, asPro ? { pro: true, onDraw: (g) => pro?.onDraw(g) } : {});
    if (asPro) {
      pro?.destroy();
      headHost.hidden = false;
      pro = createPro({ box, head: headHost, chart, opts, reload: () => run(true), expandBtn: expand });
    }
    return chart;
  };
  function show(spec) {
    if (dead) return;
    status.hidden = true;
    host.hidden = false;
    const c = ensure(spec);
    // A new spec replaces the old one whole (no note, pane or kind left over from the last draw).
    const next = { label: opts.label, note: "", panes: undefined, kind: undefined, ...spec };
    if (pro && hasCandles(next) && !next.empty) pro.render(next);
    else c.update(next);
  }
  async function run(manual = false) {
    if (dead || !loader) return;
    if (!box.isConnected && seq > 0) return ctl.destroy();
    const my = ++seq;
    if (!status.hidden) skel.classList.add("skel");
    try {
      const tf = pro?.tf ?? (opts.pro !== false ? savedTimeframe(chartId(opts)) : null);
      const base = await loader({ label: opts.label, studies: Boolean(pro?.wantsDaily()), interval: tf?.interval ?? null, range: tf?.range ?? null });
      if (dead || my !== seq) return;
      // The tools come with the first candles, before the swap, so a remembered interval applies from the first draw.
      if (!pro && base && !base.empty && wantPro(base)) ensure(base);
      const spec = pro && base && hasCandles(base) ? await pro.timeframe(base) : base;
      if (dead || my !== seq) return;
      show(spec ?? { empty: { title: "No data", text: "" } });
    } catch (err) {
      if (dead || my !== seq) return;
      skel.classList.remove("skel");
      // Keep the last good drawing (the next refresh tries again); a change the person asked for says why it failed.
      if (chart?.alive && chart.model.hasData) return manual ? toast(`Chart not updated: ${err?.message ?? "the Bridge did not answer"}`, { tone: "warn" }) : undefined;
      host.hidden = true;
      status.hidden = false;
      status.replaceChildren(errorState(err, { onRetry: () => run() }));
    }
  }
  function start() {
    if (pending) {
      show(pending);
      pending = null;
    }
    if (loader) run();
    if (opts.refreshMs > 0 && !timer) {
      timer = setInterval(() => {
        if (!box.isConnected) return ctl.destroy();
        if (typeof document !== "undefined" && document.hidden) return;
        run();
      }, opts.refreshMs);
    }
  }
  if (seen) queueMicrotask(start);
  else {
    // Latches (useInView.ts): a chart that has loaded keeps it while scrolled away; scrolling back never refetches.
    io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        seen = true;
        io?.disconnect();
        io = null;
        start();
      },
      { rootMargin: "240px" },
    );
    io.observe(box);
  }

  const ctl = {
    get chart() {
      return chart;
    },
    /** The chart tools' public side (symbol, last price, setInterval, setRange, openIndicators), or null. */
    get pro() {
      return pro?.publicApi ?? null;
    },
    /** Draw this spec now (live data: cheap, one redraw per frame). */
    set(spec) {
      if (dead) return;
      if (!seen) pending = spec;
      else show(spec);
    },
    /** Replace the loader (a new contract, a new underlying) and load it. */
    load(fn) {
      loader = fn;
      if (seen && !dead) run();
    },
    reload() {
      if (seen && !dead) run();
    },
    destroy() {
      if (dead) return;
      dead = true;
      io?.disconnect();
      if (timer) clearInterval(timer);
      pro?.destroy();
      chart?.destroy();
    },
  };
  return ctl;
}

/** A label value as text for callers that build level labels: "Strike 26000". Kept here so callers share one rule. */
export const levelText = (name, v, dp = 0) => (isFigure(v) ? `${name} ${formatFixed(v, dp)}` : `${name} ${DASH}`);

/**
 * The chart modal: min(1100px, 92vw) by 80vh on a desktop, the whole screen on a phone, the plot filling what the
 * legend and the Indicators control leave, so the time axis under the last pane is always in view. Every pane shares
 * that one time axis and one crosshair (one SVG, one x scale). Returns the modal's promise.
 * @param {string} title
 * @param {object} opts  mountSlot options (load, studies, label); no refresh while it is open
 */
export function openChartModal(title, opts) {
  const wrap = h("div", { class: "lc-wrap" });
  const box = h("div", { class: "lc-slot", role: "group", "aria-label": opts.label ?? title }, wrap);
  const ctl = mountSlot(wrap, { ...opts, expand: false, refreshMs: 0 });
  const done = modal({ title, body: h("div", { class: "lc-expanded" }, box), buttons: [{ label: "Close", value: false }] });
  const d = typeof document !== "undefined" ? document.getElementById("dialog") : null;
  d?.classList.add("lc-chart-sheet");
  return done.finally(() => {
    d?.classList.remove("lc-chart-sheet");
    ctl.destroy();
  });
}
