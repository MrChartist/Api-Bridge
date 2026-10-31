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
import { api, emptyState, errorState, h, icon, modal, store, toast } from "./app.js";
import * as C from "./chart-lite-core.js";
import { MAX_STUDIES, studyList, studyRequest, withStudies } from "./chart-specs.js";
import { DASH, formatCompactTick, formatFixed, isFigure } from "./format.js";
import { legend, scrubber, svgEl } from "./viz.js";

const TONES = new Set(["call", "put", "pos", "neg", "iv", "spot", "today", "warn", "hv", "muted"]);
const toneOf = (t, d = "spot") => (TONES.has(t) ? t : d);

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
 * @param {HTMLElement} host
 * @param {object} spec  see chart-lite-core.js buildModel; plus label, note
 */
export function createChart(host, spec = {}) {
  armSweep();
  sweep();
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
  const scrub = scrubber(plot, {
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
    const panes = C.layoutPanes(model, H);
    const levelsOf = (p) => model.series.filter((s) => s.type === "level" && s.pane === p.id && s.label);
    const fmts = new Map(panes.map((p) => [p.id, axisFormat(p, p.ticks)]));
    const tickTexts = panes.flatMap((p) => p.ticks.map((v) => fmts.get(p.id)(v)));
    const capsOf = new Map(panes.map((p) => [p.id, p.lo === null ? [] : C.placeCapsules(levelsOf(p).map((l) => ({ id: l.id, value: l.value, text: l.label, tone: toneOf(l.tone, "muted") })), p)]));
    const capTexts = [...capsOf.values()].flat().map((c) => c.text);
    const X = C.layoutX(model, W, C.gutterFor(tickTexts, capTexts));
    if (!X) return;
    geo = { X, panes };
    const hair = C.hairline(dpr);
    const layers = { grid: [], fill: [], marks: [], lines: [], levels: [], text: [] };
    const timeTicks = C.planTimeTicks({ times: model.times, xOf: X.xOf, left: X.left, right: X.right, kind: model.kind });
    const lastPane = panes[panes.length - 1];

    for (const p of panes) {
      if (p.lo === null) continue;
      const f = fmts.get(p.id);
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
          if (s.pts) layers.fill.push(svgEl("path", { class: "lc-band", "data-tone": toneOf(s.tone, "iv"), d: C.bandPath(s.pts, X.xOf, p.yOf) }));
          else {
            const y1 = C.snap(p.yOf(Math.max(Number(s.lo), Number(s.hi))), dpr);
            const y2 = C.snap(p.yOf(Math.min(Number(s.lo), Number(s.hi))), dpr);
            layers.fill.push(svgEl("rect", { class: "lc-band", "data-tone": toneOf(s.tone, "iv"), "data-strength": s.strength ?? undefined, x: C.n3(X.left), y: C.n3(Math.max(p.top, y1)), width: C.n3(X.right - X.left), height: C.n3(Math.max(0, Math.min(p.priceBottom, y2) - Math.max(p.top, y1))) }));
            if (s.label && y2 - y1 > 16) layers.text.push(svgEl("text", { class: "lc-band-label", "data-tone": toneOf(s.tone, "iv"), x: C.n3(X.left + 4), y: C.n3(Math.max(p.top, y1) + 13) }, s.label));
          }
        } else if (s.type === "area") {
          const base = Number.isFinite(Number(s.baseline)) ? p.yOf(Number(s.baseline)) : p.priceBottom;
          if (s.signed) {
            const sp = C.splitSigned(s.pts);
            const y0 = p.yOf(0);
            layers.fill.push(svgEl("path", { class: "lc-area", "data-tone": "pos", d: C.areaPath(sp.pos, X.xOf, p.yOf, y0) }));
            layers.fill.push(svgEl("path", { class: "lc-area", "data-tone": "neg", d: C.areaPath(sp.neg, X.xOf, p.yOf, y0) }));
            layers.lines.push(svgEl("path", { class: "lc-line", "data-tone": "pos", d: C.linePath(sp.pos, X.xOf, p.yOf) }));
            layers.lines.push(svgEl("path", { class: "lc-line", "data-tone": "neg", d: C.linePath(sp.neg, X.xOf, p.yOf) }));
          } else {
            layers.fill.push(svgEl("path", { class: "lc-area", "data-tone": tone, d: C.areaPath(s.pts, X.xOf, p.yOf, base) }));
            layers.lines.push(svgEl("path", { class: "lc-line", "data-tone": tone, d: C.linePath(s.pts, X.xOf, p.yOf) }));
          }
        } else if (s.type === "bars") {
          const paths = C.histogramPaths(s.pts, X.xOf, p.yOf, X.slot, dpr, { signed: s.signed, tone });
          for (const [k, d] of Object.entries(paths)) layers.marks.push(svgEl("path", { class: "lc-bar", "data-tone": toneOf(k), d, "shape-rendering": "crispEdges" }));
        } else if (s.type === "candles") {
          const { bars, step } = C.groupBars(s.pts, 0, s.pts.length - 1, Math.max(1, Math.floor((X.right - X.left) / C.MIN_SLOT)));
          const slot = X.slot * step;
          const cp = C.candlePaths(bars, X.xOf, p.yOf, slot, dpr);
          const g = svgEl("g", { class: "lc-candles", "shape-rendering": "crispEdges" });
          g.append(
            svgEl("path", { class: "lc-wick", "data-dir": "up", d: cp.upWick, "stroke-width": C.n3(hair) }),
            svgEl("path", { class: "lc-wick", "data-dir": "down", d: cp.downWick, "stroke-width": C.n3(hair) }),
            svgEl("path", { class: "lc-body", "data-dir": "up", d: cp.upBody }),
            svgEl("path", { class: "lc-body", "data-dir": "down", d: cp.downBody }),
          );
          layers.marks.push(g);
          if (p.volumeBand) {
            const vp = C.volumePaths(bars, X.xOf, p.volumeBand, slot, dpr);
            layers.marks.push(svgEl("path", { class: "lc-vol", "data-dir": "up", d: vp.up, "shape-rendering": "crispEdges" }), svgEl("path", { class: "lc-vol", "data-dir": "down", d: vp.down, "shape-rendering": "crispEdges" }));
          }
        } else if (s.type === "line") {
          layers.lines.push(svgEl("path", { class: s.dash ? "lc-line dash" : "lc-line", "data-tone": tone, "data-weight": s.weight ?? undefined, d: C.linePath(s.pts, X.xOf, p.yOf) }));
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
      if (s.type !== "marker") continue;
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
    svg.replaceChildren(
      svgEl("g", { class: "lc-l-grid", "shape-rendering": "crispEdges" }, layers.grid),
      svgEl("g", { class: "lc-l-fill" }, layers.fill),
      svgEl("g", { class: "lc-l-marks" }, layers.marks),
      svgEl("g", { class: "lc-l-lines" }, layers.lines),
      svgEl("g", { class: "lc-l-levels" }, layers.levels),
      svgEl("g", { class: "lc-l-text", "aria-hidden": "true" }, layers.text),
    );
  }

  const chart = {
    host,
    get spec() {
      return cur;
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

// ── Indicators: the ChartistScript studies (GET /v1/studies, POST /v1/studies/compute), on candle charts ──
// Lazy: the catalogue is read the first time the picker opens, and nothing is computed until a study is on. The ids on
// are remembered in this browser (one list for every candle chart), at most MAX_STUDIES.
const STUDY_SLOT = "mcb.dashboard.studies";
const prefs = store("local");
const activeStudies = () => studyList(prefs.get(STUDY_SLOT));
let catalogue = null;
const loadCatalogue = () => (catalogue ??= api("/v1/studies").then((r) => (r.data?.data?.studies ?? []).filter((x) => x.available)).catch((e) => ((catalogue = null), Promise.reject(e))));
const computed = new Map();
/** One compute per symbol, studies and length for 5 minutes (a daily study moves once a day). */
function computeStudies(req) {
  const key = JSON.stringify(req);
  const hit = computed.get(key);
  if (hit && Date.now() - hit.at < 300_000) return hit.p;
  const p = api("/v1/studies/compute", { method: "POST", body: req }).then((r) => r.data?.data ?? null);
  p.catch(() => computed.delete(key));
  if (computed.size > 40) computed.clear();
  computed.set(key, { at: Date.now(), p });
  return p;
}

/**
 * The "Indicators" button and its picker, an inline panel in the slot (a popover would sit under the strategy's modal
 * and the chain's sheet, which make the rest of the page inert). `onChange(ids)` runs after the list changes.
 */
let pickerSeq = 0;
function studiesControl(label, onChange) {
  const count = h("span", { class: "lc-count" });
  const panelId = `lc-ind-${(pickerSeq += 1)}`;
  const btn = h("button", { type: "button", class: "small lc-ind-btn", "aria-expanded": "false", "aria-controls": panelId }, icon("chart"), h("span", {}, "Indicators"), count);
  const onList = h("div", { class: "lc-ind-on", "aria-live": "polite" });
  const search = h("input", { type: "search", class: "lc-ind-search", placeholder: "Search indicators", "aria-label": `Search indicators for ${label}`, autocomplete: "off" });
  const list = h("div", { class: "lc-ind-list", role: "group", "aria-label": "Indicators to add" });
  const panel = h("div", { class: "lc-ind-panel", id: panelId, hidden: true }, h("p", { class: "lc-ind-note" }, `Daily candles. Up to ${MAX_STUDIES}, remembered in this browser.`), onList, search, list);
  let all = null;
  const paint = () => {
    const n = activeStudies().length;
    count.textContent = n ? String(n) : "";
    count.hidden = !n;
    btn.setAttribute("aria-label", n ? `Indicators: ${n} on` : "Indicators");
  };
  const set = (ids) => {
    prefs.set(STUDY_SLOT, JSON.stringify(studyList(ids)));
    paint();
    draw();
    onChange(activeStudies());
  };
  function draw() {
    const on = activeStudies();
    onList.replaceChildren(
      ...(on.length
        ? on.map((id) => h("button", { type: "button", class: "chip-btn lc-ind-chip", "aria-label": `Remove ${id}`, onclick: () => set(on.filter((x) => x !== id)) }, h("span", {}, id), icon("close")))
        : [h("span", { class: "lc-ind-note" }, "None on")]),
    );
    if (!all) return;
    const q = search.value.trim().toLowerCase();
    const full = on.length >= MAX_STUDIES;
    const rows = all.filter((x) => !on.includes(x.id) && (!q || x.id.includes(q) || String(x.summary ?? "").toLowerCase().includes(q)));
    const item = (x) => h("button", { type: "button", class: "lc-ind-item", disabled: full, title: x.summary ?? "", onclick: () => set([...activeStudies(), x.id]) }, h("b", {}, x.id), h("span", {}, String(x.summary ?? "").split(/[.;(]/)[0]));
    const group = (title, items) => (items.length ? [h("p", { class: "lc-ind-head" }, title), ...items.map(item)] : []);
    list.replaceChildren(
      ...(full ? [h("p", { class: "lc-ind-note" }, `${MAX_STUDIES} on: remove one to add another.`)] : []),
      ...group("On the price", rows.filter((x) => x.pane === "price")),
      ...group("Below the chart", rows.filter((x) => x.pane !== "price")),
      ...(rows.length ? [] : [h("p", { class: "lc-ind-note" }, "No match")]),
    );
  }
  const open = async (on) => {
    panel.hidden = !on;
    btn.setAttribute("aria-expanded", String(on));
    if (!on) return;
    draw();
    search.focus({ preventScroll: true });
    if (all) return;
    list.replaceChildren(h("p", { class: "lc-ind-note", role: "status" }, "Loading the list"));
    try {
      all = await loadCatalogue();
      draw();
    } catch (err) {
      list.replaceChildren(errorState(err, { onRetry: () => open(true) }));
    }
  };
  btn.addEventListener("click", () => open(panel.hidden));
  search.addEventListener("input", draw);
  panel.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    open(false);
    btn.focus();
  });
  paint();
  return { el: btn, panel, paint };
}

/**
 * A chart slot (app.js chartSlot): loads its data when it comes near the viewport, shows a skeleton, an error with
 * Retry or an honest empty state, and redraws in place on `set` / `reload`. `opts`:
 *   { label, data?: spec, load?: ({ studies }) => Promise<spec>, refreshMs?: number,
 *     studies?: { symbol: () => string|null, interval?: "1d" } }
 * A loader may return { empty: { title, text } } when there is no data source or nothing recorded yet. With `studies`,
 * an Indicators control sits above a candle chart; the loader is told whether any are on (`studies: true`), since
 * studies read daily candles only.
 * Returns { set(spec), load(loader), reload(), destroy(), chart }.
 */
export function mountSlot(box, opts = {}) {
  let loader = opts.load ?? null;
  let chart = null;
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
  const control = opts.studies ? studiesControl(opts.label ?? "chart", () => run()) : null;
  // A chart in a narrow panel (the chain's sheet, the screener's pane) opens full size in the chart modal.
  const expand = opts.expand ? h("button", { type: "button", class: "small lc-expand", "aria-label": `Open ${opts.label ?? "the chart"} full size`, onclick: () => loader && openChartModal(opts.label ?? "Chart", { ...opts, load: loader }) }, icon("external"), h("span", {}, "Expand")) : null;
  const tools = control || expand ? [h("div", { class: "lc-tools" }, expand, control?.el), ...(control ? [control.panel] : [])] : [];
  box.replaceChildren(...tools, status, host);
  host.hidden = true;
  /** The loader's spec with the indicators on laid over it (a failed compute keeps the chart and says so). */
  async function studied(spec) {
    const ids = control ? activeStudies() : [];
    const candles = spec?.series?.find((x) => x.type === "candles");
    const symbol = opts.studies?.symbol?.();
    if (!ids.length || !candles?.data?.length || !symbol) return spec;
    try {
      return withStudies(spec, await computeStudies(studyRequest({ symbol, interval: opts.studies.interval ?? "1d", bars: candles.data.length, ids })));
    } catch (err) {
      toast(`Indicators not drawn: ${err?.message ?? "the Bridge did not answer"}`, { tone: "warn" });
      return spec;
    }
  }

  const ensure = () => {
    if (!chart || !chart.alive) chart = createChart(host, { label: opts.label });
    return chart;
  };
  function show(spec) {
    if (dead) return;
    status.hidden = true;
    host.hidden = false;
    const c = ensure();
    // A new spec replaces the old one whole (no note, pane or kind left over from the last draw).
    c.update({ label: opts.label, note: "", panes: undefined, kind: undefined, ...spec });
  }
  async function run() {
    if (dead || !loader) return;
    if (!box.isConnected && seq > 0) return ctl.destroy();
    const my = ++seq;
    if (!status.hidden) skel.classList.add("skel");
    try {
      const base = await loader({ label: opts.label, studies: Boolean(control) && activeStudies().length > 0 });
      const spec = await studied(base);
      if (dead || my !== seq) return;
      show(spec ?? { empty: { title: "No data", text: "" } });
    } catch (err) {
      if (dead || my !== seq) return;
      skel.classList.remove("skel");
      if (chart?.alive && chart.model.hasData) return; // keep the last good drawing; the next refresh tries again
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
