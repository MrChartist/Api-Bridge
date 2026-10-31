// Ported from MrChartist/scanner src/components/patterns/lite-chart, <commit c2ac504> (crisp.ts, candles.ts,
// pattern-lite-geometry.ts, level-labels.ts) and src/domains/charting/services/timeAxis{Scan,Ticks,Format}.ts (the
// tick rules, simplified to IST). The scanner code is the owner's own; all rights reserved.
//
// chart-lite-core.js: the pure half of the dashboard's light chart engine (chart-lite.js draws it). Geometry, device
// pixel snapping, candle grouping and paths, scales, price ticks and the time axis planner. No DOM, no fetch, no clock:
// everything comes in as arguments, so node vitest covers it (chart-lite-core.test.mjs).
//
// Crispness (from the scanner): a 1px stroke centred on a whole CSS pixel straddles two device pixels and renders as a
// soft 2px smear. Every horizontal, vertical and box edge here is snapped to the DEVICE pixel grid instead, bodies are
// an odd number of device pixels wide so the one-device-pixel wick sits in their centre, and the SVG is sized to a
// whole number of device pixels (chart-lite.js), so nothing is ever resampled. Diagonals are left to anti-aliasing.
//
// Y-domains cover every value about to be drawn (candle wicks, lines, levels, bands): nothing is clamped to the plot
// edge, which would draw a level exactly where the series maximum sits (the scanner's "misleading chart" rule).

import { priceScale } from "./chart-pro-core.js";

// ── Device pixels (crisp.ts) ──

/** Round a CSS-pixel coordinate to the nearest device pixel. */
export const snap = (v, dpr) => Math.round(v * dpr) / dpr;

/** Position for a line of `widthCss` so both its edges fall on device-pixel boundaries. */
export function crisp(v, dpr, widthCss = 1) {
  const wDev = Math.max(1, Math.round(widthCss * dpr));
  return (Math.round(v * dpr - wDev / 2) + wDev / 2) / dpr;
}

/** Hairline width: one DEVICE pixel, expressed in CSS pixels. */
export const hairline = (dpr) => 1 / Math.max(1, dpr);

/** A whole number of device pixels, never more than `css`: the SVG is then drawn 1:1. */
export const deviceFloor = (css, dpr) => (css > 0 ? Math.floor(css * dpr) / dpr : 0);

/** A coordinate as path text: three decimals at most, no exponent. Not a displayed figure. */
export const n3 = (v) => String(Math.round(v * 1000) / 1000);

/**
 * Rough advance width of a short label in Chartist Sans Flex with tabular figures (the scanner's estimate, measured
 * with fontTools for type system phase 2). Used where nothing can be measured, and to size gutters and capsules.
 */
export function estimateWidth(text, fontPx = 12, weight = 500) {
  let em = 0;
  for (const ch of String(text)) {
    if (/[0-9]/.test(ch)) em += 0.62;
    else if (ch === "." || ch === "," || ch === " " || ch === ":" || ch === "·") em += 0.3;
    else if (ch === "₹" || ch === "%" || ch === "+" || ch === "−" || ch === "σ" || ch === "±") em += 0.62;
    else if (ch === "-") em += 0.36;
    else if (/[A-Z]/.test(ch)) em += 0.68;
    else em += 0.53;
  }
  return em * fontPx * (weight >= 600 ? 1.04 : 1);
}

/**
 * Nudge a column of labels apart so none overlap, keeping each as close to its true y as the others allow and the
 * whole stack inside [min, max].
 */
export function spreadLabels(items, gap, min, max) {
  const out = items.map((it) => ({ ...it, ly: it.y })).sort((a, b) => a.ly - b.ly);
  for (let i = 0; i < out.length; i++) out[i].ly = Math.max(out[i].ly, i === 0 ? min : out[i - 1].ly + gap);
  for (let i = out.length - 1; i >= 0; i--) out[i].ly = Math.min(out[i].ly, i === out.length - 1 ? max : out[i + 1].ly - gap);
  // The backward pass can push the top item above `min` when the stack is taller than the room; clamping again keeps
  // it on screen at the cost of a tighter gap, which beats clipping.
  for (const o of out) o.ly = Math.max(min, Math.min(max, o.ly));
  return out;
}

// ── Candles (candles.ts) ──

/**
 * Collapse candles [from, to] into at most `maxBars` bars. A window wider than the chart can show is aggregated the
 * way a chart does it (open of the first candle, close of the last, true extremes), never by dropping candles, which
 * would delete real highs and lows. Each candle carries `i`, its index in the chart's shared time axis.
 */
export function groupBars(series, from, to, maxBars) {
  const count = to - from + 1;
  const step = Math.max(1, Math.ceil(count / Math.max(1, maxBars)));
  const bars = [];
  for (let start = from; start <= to; start += step) {
    const end = Math.min(to, start + step - 1);
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    for (let i = start; i <= end; i++) {
      high = Math.max(high, series[i].high);
      low = Math.min(low, series[i].low);
      volume += series[i].volume || 0;
    }
    const open = series[start].open;
    const close = series[end].close;
    const a = series[start].i ?? start;
    const b = series[end].i ?? end;
    bars.push({ center: (a + b) / 2, open, high, low, close, volume, up: close >= open });
  }
  return { bars, step };
}

/** Body width in device pixels for a slot: about two thirds of it, always odd, so the wick sits in its centre. */
function bodyDevWidth(slot, dpr) {
  const slotDev = slot * dpr;
  let w = Math.max(1, Math.floor(slotDev * 0.64));
  if (w % 2 === 0) w += 1;
  if (w > slotDev - 1 && w > 1) w -= 2;
  return Math.max(1, w);
}

/** The x of a bar centre on a device-pixel centre (so a one-device-pixel wick is sharp). */
const centreX = (x, dpr) => (Math.round(x * dpr - 0.5) + 0.5) / dpr;

/**
 * Four paths (up bodies, down bodies, up wicks, down wicks) rather than hundreds of elements. `slot` is the CSS-pixel
 * width one drawn bar owns.
 */
export function candlePaths(bars, xOf, yOf, slot, dpr) {
  const w = bodyDevWidth(slot, dpr) / dpr;
  const hair = 1 / dpr;
  const out = { upBody: "", downBody: "", upWick: "", downWick: "" };
  for (const b of bars) {
    const cx = centreX(xOf(b.center), dpr);
    const left = cx - w / 2;
    const yTop = snap(yOf(Math.max(b.open, b.close)), dpr);
    const yBot = snap(yOf(Math.min(b.open, b.close)), dpr);
    const h = Math.max(hair, yBot - yTop);
    const body = `M${n3(left)} ${n3(yTop)}h${n3(w)}v${n3(h)}h${n3(-w)}z`;
    const wick = `M${n3(cx)} ${n3(snap(yOf(b.high), dpr))}V${n3(snap(yOf(b.low), dpr))}`;
    if (b.up) {
      out.upBody += body;
      out.upWick += wick;
    } else {
      out.downBody += body;
      out.downWick += wick;
    }
  }
  return out;
}

/**
 * OHLC bars (the "Bars" chart type): a vertical high-low stroke with the open ticked left and the close right, as two
 * paths (up, down) drawn with a one-device-pixel stroke.
 */
export function ohlcPaths(bars, xOf, yOf, slot, dpr) {
  const arm = Math.max(1 / dpr, Math.min(6, (bodyDevWidth(slot, dpr) / dpr) / 2));
  const out = { up: "", down: "" };
  for (const b of bars) {
    const cx = centreX(xOf(b.center), dpr);
    const yo = crisp(yOf(b.open), dpr);
    const yc = crisp(yOf(b.close), dpr);
    const d = `M${n3(cx)} ${n3(snap(yOf(b.high), dpr))}V${n3(snap(yOf(b.low), dpr))}M${n3(cx - arm)} ${n3(yo)}H${n3(cx)}M${n3(cx)} ${n3(yc)}H${n3(cx + arm)}`;
    if (b.up) out.up += d;
    else out.down += d;
  }
  return out;
}

/** Volume as two paths (up / down), bars no wider than their candle body and snapped to the grid. */
export function volumePaths(bars, xOf, band, slot, dpr) {
  const maxVol = Math.max(0, ...bars.map((b) => b.volume || 0));
  const out = { up: "", down: "" };
  if (maxVol <= 0) return out;
  const w = bodyDevWidth(slot, dpr) / dpr;
  const bandH = band.bottom - band.top;
  for (const b of bars) {
    if (!(b.volume > 0)) continue;
    const cx = centreX(xOf(b.center), dpr);
    const h = Math.max(1 / dpr, snap((b.volume / maxVol) * bandH, dpr));
    const rect = `M${n3(cx - w / 2)} ${n3(band.bottom - h)}h${n3(w)}v${n3(h)}h${n3(-w)}z`;
    if (b.up) out.up += rect;
    else out.down += rect;
  }
  return out;
}

/**
 * A histogram from a zero line: points [{ i, v, tone? }]. Returns one path per tone ("pos", "neg" for a signed series,
 * or the series' own tone), every edge on the device grid.
 */
export function histogramPaths(points, xOf, yOf, slot, dpr, { signed = false, tone = "spot" } = {}) {
  const w = bodyDevWidth(slot, dpr) / dpr;
  const y0 = snap(yOf(0), dpr);
  const out = {};
  for (const p of points) {
    if (!Number.isFinite(p.v)) continue;
    const cx = centreX(xOf(p.i), dpr);
    const y = snap(yOf(p.v), dpr);
    const top = Math.min(y, y0);
    const h = Math.max(1 / dpr, Math.abs(y - y0));
    const key = p.tone ?? (signed ? (p.v < 0 ? "neg" : "pos") : tone);
    out[key] = (out[key] ?? "") + `M${n3(cx - w / 2)} ${n3(top)}h${n3(w)}v${n3(h)}h${n3(-w)}z`;
  }
  return out;
}

/** A polyline through [{ i, v, gap? }]; a missing value (null, NaN) or a point marked `gap` starts a new line. */
export function linePath(points, xOf, yOf) {
  let d = "";
  let pen = false;
  for (const p of points) {
    if (!Number.isFinite(p.v)) {
      pen = false;
      continue;
    }
    if (p.gap) pen = false;
    d += `${pen ? "L" : "M"}${n3(xOf(p.i))} ${n3(yOf(p.v))}`;
    pen = true;
  }
  return d;
}

/** Closed areas from a line down (or up) to `baseY`, one sub-path per unbroken run. */
export function areaPath(points, xOf, yOf, baseY) {
  let d = "";
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      d += `M${n3(xOf(run[0].i))} ${n3(baseY)}`;
      for (const p of run) d += `L${n3(xOf(p.i))} ${n3(yOf(p.v))}`;
      d += `L${n3(xOf(run[run.length - 1].i))} ${n3(baseY)}Z`;
    }
    run = [];
  };
  for (const p of points) {
    if (Number.isFinite(p.v)) run.push(p);
    else flush();
  }
  flush();
  return d;
}

/** A band between two lines [{ i, lo, hi }] (a ±σ envelope), one closed path per unbroken run. */
export function bandPath(points, xOf, yOf) {
  let d = "";
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      d += run.map((p, k) => `${k ? "L" : "M"}${n3(xOf(p.i))} ${n3(yOf(p.hi))}`).join("");
      for (let k = run.length - 1; k >= 0; k--) d += `L${n3(xOf(run[k].i))} ${n3(yOf(run[k].lo))}`;
      d += "Z";
    }
    run = [];
  };
  for (const p of points) {
    if (Number.isFinite(p.lo) && Number.isFinite(p.hi)) run.push(p);
    else flush();
  }
  flush();
  return d;
}

/** Split a series at zero crossings so a signed area (P&L) fills green above zero and red below: { pos, neg }. */
export function splitSigned(pts) {
  const out = [];
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k];
    const q = pts[k - 1];
    if (q && Number.isFinite(q.v) && Number.isFinite(p.v) && q.v * p.v < 0) out.push({ i: q.i + ((p.i - q.i) * q.v) / (q.v - p.v), v: 0 });
    out.push(p);
  }
  const part = (keep) => out.map((p) => ({ i: p.i, v: Number.isFinite(p.v) && (p.v === 0 || keep(p.v)) ? p.v : NaN }));
  return { pos: part((v) => v > 0), neg: part((v) => v < 0) };
}

// ── Scales ──

/** "Nice" round tick values inside [lo, hi], about `count` of them (1, 2, 2.5 or 5 × a power of ten). */
export function niceTicks(lo, hi, count = 5) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi === lo) return [lo];
  const raw = (hi - lo) / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(raw));
  // The nice step nearest the raw one (on a log scale), so the count lands close to the one asked for.
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).reduce((best, s) => (Math.abs(Math.log(s / raw)) < Math.abs(Math.log(best / raw)) ? s : best));
  const out = [];
  const first = Math.ceil(lo / step - 1e-9) * step;
  for (let v = first; v <= hi + step * 1e-9 && out.length < 50; v += step) out.push(Math.round(v / step) * step);
  // Strip float noise (0.30000000000000004): round to the step's own decimals.
  const dp = Math.max(0, -Math.floor(Math.log10(step)) + 2);
  return out.map((v) => Math.round(v * 10 ** dp) / 10 ** dp + 0); // + 0 turns −0 into 0
}

/** The decimals a tick step needs to tell its ticks apart (0 for 100s, 1 for 0.5, 2 for 0.05). */
export function tickDecimals(ticks) {
  if (ticks.length < 2) return 2;
  const step = Math.abs(ticks[1] - ticks[0]);
  if (!(step > 0)) return 2;
  return Math.max(0, Math.min(4, Math.ceil(-Math.log10(step) - 1e-9)));
}

/**
 * The y-domain of a pane: every value about to be drawn, a 6 % margin, and a small band for flat data. `include`
 * values (a zero line, a 50 % reference) are always in view.
 */
export function paneDomain(values, { include = [], margin = 0.06 } = {}) {
  const usable = [...values, ...include].filter((v) => Number.isFinite(v));
  if (!usable.length) return null;
  let lo = Math.min(...usable);
  let hi = Math.max(...usable);
  if (!(hi > lo)) {
    const pad = Math.abs(lo) * 0.02 || 1;
    lo -= pad;
    hi += pad;
  }
  const m = (hi - lo) * margin;
  return { lo: lo - m, hi: hi + m };
}

// ── The model: a spec's series on one shared time axis ──

const TYPES = new Set(["candles", "line", "area", "bars", "level", "marker", "band"]);
const finite = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));

/**
 * Normalise a chart spec into a model on one shared, sorted time axis (the union of every series' times; x is the
 * index on it, so nights, weekends and holidays take no room, as on a trading chart).
 *
 * Spec: { label, panes?: [{ id, weight?, include?, label? }], series: [...] } where each series is
 *   { id?, type: "candles", pane?, data: [{ t, open, high, low, close, volume? }], volume?: bool }
 *   { id?, type: "line" | "area" | "bars", pane?, data: [{ t, v, tone? }], tone?, dash?, baseline?, signed? }
 *   { id?, type: "level", pane?, value, label?, tone?, dash?, fit? }
 *   { id?, type: "band", pane?, lo, hi, data?: [{ t, lo, hi }], tone?, label? }
 *   { id?, type: "marker", t, label?, tone? }
 * `t` is epoch ms. Unknown types and series without usable data are dropped.
 */
export function buildModel(spec) {
  const series = (spec?.series ?? []).filter((s) => s && TYPES.has(s.type)).map((s, k) => ({ ...s, id: s.id ?? `s${k}` }));
  const paneIds = (spec?.panes ?? []).map((p) => p.id);
  const firstPane = paneIds[0] ?? "main";
  const tset = new Set();
  for (const s of series) {
    if (!s.pane) s.pane = firstPane;
    if (s.type === "marker") {
      if (Number.isFinite(finite(s.t))) tset.add(Number(s.t));
      continue;
    }
    for (const p of s.data ?? []) if (Number.isFinite(finite(p?.t))) tset.add(Number(p.t));
  }
  const times = [...tset].sort((a, b) => a - b);
  const at = new Map(times.map((t, i) => [t, i]));
  for (const s of series) {
    if (s.type === "candles") {
      s.pts = (s.data ?? [])
        .filter((c) => at.has(Number(c?.t)) && [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(finite(v))))
        .map((c) => ({ i: at.get(Number(c.t)), t: Number(c.t), open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: Number.isFinite(finite(c.volume)) ? +c.volume : 0 }))
        .sort((a, b) => a.i - b.i);
    } else if (s.type === "line" || s.type === "area" || s.type === "bars") {
      s.pts = (s.data ?? []).filter((p) => at.has(Number(p?.t))).map((p) => ({ i: at.get(Number(p.t)), t: Number(p.t), v: finite(p.v), tone: p.tone })).sort((a, b) => a.i - b.i);
    } else if (s.type === "band" && Array.isArray(s.data)) {
      s.pts = s.data.filter((p) => at.has(Number(p?.t))).map((p) => ({ i: at.get(Number(p.t)), lo: finite(p.lo), hi: finite(p.hi) })).sort((a, b) => a.i - b.i);
    } else if (s.type === "marker") {
      s.i = at.get(Number(s.t)) ?? null;
    }
  }
  const live = series.filter((s) => {
    if (s.type === "level") return Number.isFinite(finite(s.value));
    if (s.type === "band") return s.pts ? s.pts.length > 0 : Number.isFinite(finite(s.lo)) && Number.isFinite(finite(s.hi));
    if (s.type === "marker") return s.i !== null;
    return s.pts.some((p) => (s.type === "candles" ? true : Number.isFinite(p.v)));
  });
  // Panes: the ones named in the spec that hold a series, then any a series names that the spec did not.
  const used = new Set(live.map((s) => s.pane));
  const panes = (spec?.panes ?? []).filter((p) => used.has(p.id)).map((p) => ({ weight: 1, ...p }));
  for (const id of used) if (!panes.some((p) => p.id === id) && live.some((s) => s.pane === id && s.type !== "marker")) panes.push({ id, weight: 1 });
  if (!panes.length && live.length) panes.push({ id: firstPane, weight: 1 });
  const hasData = live.some((s) => s.type === "candles" || s.type === "line" || s.type === "area" || s.type === "bars");
  return { times, series: live, panes, hasData, kind: spec?.kind ?? axisKind(times) };
}

/** Every value a pane will draw, for its domain; with `range` [a, b], only the bars on screen count. */
export function paneValues(model, paneId, range = null) {
  const vals = [];
  const include = [];
  const a = range ? range[0] : -Infinity;
  const b = range ? range[1] : Infinity;
  const on = (p) => p.i >= a && p.i <= b;
  for (const s of model.series) {
    if (s.pane !== paneId) continue;
    if (s.type === "candles") {
      for (const c of s.pts) if (on(c)) vals.push(c.high, c.low);
    } else if (s.type === "line" || s.type === "area") {
      for (const p of s.pts) if (on(p)) vals.push(p.v);
      if (s.type === "area" && Number.isFinite(finite(s.baseline))) include.push(Number(s.baseline));
      if (s.signed) include.push(0);
    } else if (s.type === "bars") {
      for (const p of s.pts) if (on(p)) vals.push(p.v);
      include.push(0);
    } else if (s.type === "level" && s.fit !== false) vals.push(Number(s.value));
    else if (s.type === "band") {
      if (s.pts) {
        for (const p of s.pts) if (on(p)) vals.push(p.lo, p.hi);
      } else if (s.fit !== false) vals.push(Number(s.lo), Number(s.hi));
    }
  }
  return { vals, include };
}

// ── Layout ──

/** Fixed margins around the plot. `bottom` holds the time axis labels. */
export const LC_PAD = Object.freeze({ left: 8, top: 10, bottom: 24, gap: 14 });
/** Height of the volume strip under a candle pane, when one is drawn. */
export const VOLUME_BAND = 26;
/** Narrowest slot one candle may own before neighbours are merged into one bar. */
export const MIN_SLOT = 3.2;
/** Level capsule geometry (level-labels.ts). */
export const CAPSULE_H = 18;
export const CAPSULE_GAP = 4;
export const CAPSULE_PAD = 7;
export const AXIS_FONT = 12;
/** Strip above a labelled pane's data. */
export const PANE_LABEL_H = 16;

/**
 * Vertical layout: the panes stacked by weight between the top pad and the time axis, each with its domain, scale
 * and price ticks. Width-independent, so the right gutter can be sized from these ticks before the x layout.
 * `o.range` [a, b]: only these bars set the domains (a zoomed view). `o.scale` { pane, mode: "linear"|"log"|
 * "percent", base }: the price scale of one pane (chart-pro-core.js priceScale). Each pane gets `vOf(y)` too.
 */
export function layoutPanes(model, height, o = {}) {
  const top0 = LC_PAD.top;
  const bottom0 = height - LC_PAD.bottom;
  const n = model.panes.length;
  const room = bottom0 - top0 - LC_PAD.gap * Math.max(0, n - 1);
  const total = model.panes.reduce((a, p) => a + (Number(p.weight) > 0 ? Number(p.weight) : 1), 0) || 1;
  let y = top0;
  const out = [];
  for (const p of model.panes) {
    const h = (room * (Number(p.weight) > 0 ? Number(p.weight) : 1)) / total;
    // A labelled pane keeps a strip for its label above the data, so the label never sits on a line.
    const labelTop = y;
    const top = y + (p.label ? PANE_LABEL_H : 0);
    const bottom = y + h;
    y = bottom + LC_PAD.gap;
    const hasVol = !o.noVolume && model.series.some((s) => s.pane === p.id && s.type === "candles" && s.volume && s.pts.some((c) => c.volume > 0));
    const volH = hasVol && h > 120 ? VOLUME_BAND : 0;
    const priceBottom = bottom - volH;
    const { vals, include } = paneValues(model, p.id, o.range ?? null);
    const dom = paneDomain(vals, { include: [...include, ...(p.include ?? [])] });
    if (!dom || priceBottom - top < 16) {
      out.push({ ...p, labelTop, top, bottom, priceBottom, lo: null, hi: null, yOf: () => NaN, vOf: () => NaN, ticks: [], volumeBand: null });
      continue;
    }
    const { lo, hi } = dom;
    const count = Math.max(2, Math.min(6, Math.floor((priceBottom - top) / 34)));
    const sc = o.scale && o.scale.pane === p.id && o.scale.mode !== "linear" ? priceScale(o.scale.mode, lo, hi, top, priceBottom, o.scale.base, count) : null;
    const yOf = sc ? sc.yOf : (v) => top + (1 - (v - lo) / (hi - lo)) * (priceBottom - top);
    const vOf = sc ? sc.vOf : (yy) => lo + (1 - (yy - top) / (priceBottom - top)) * (hi - lo);
    const ticks = sc?.ticks ?? niceTicks(lo, hi, count);
    out.push({ ...p, labelTop, top, bottom, priceBottom, lo, hi, yOf, vOf, scaleMode: sc?.mode ?? "linear", scaleBase: sc?.base ?? null, ticks: ticks.filter((v) => v >= lo && v <= hi), volumeBand: volH ? { top: priceBottom + 4, bottom } : null });
  }
  return out;
}

/**
 * Horizontal layout over the shared time axis: bar `i` sits in the middle of its slot, so the first and last are not
 * clipped. With a view { from, to } (fractional bar indices, chart-pro-core.js) only those slots fill the width.
 * Null when there is not enough room to draw honestly.
 */
export function layoutX(model, width, gutterRight, view = null) {
  const left = LC_PAD.left;
  const right = width - gutterRight;
  const count = model.times.length;
  if (count < 1 || right - left < 40) return null;
  const from = view ? view.from : 0;
  const slots = view ? Math.max(1, view.to - view.from + 1) : count;
  const slot = (right - left) / slots;
  const xOf = (i) => left + (i - from + 0.5) * slot;
  const iOf = (x) => (x - left) / slot - 0.5 + from;
  const indexAt = (x) => Math.max(0, Math.min(count - 1, Math.round(iOf(x))));
  return { left, right, slot, xOf, iOf, indexAt, count, from, to: from + slots - 1 };
}

/** Width of the right gutter: the widest price tick or level capsule, plus the lead and a clear edge. */
export function gutterFor(tickTexts, capsuleTexts) {
  const tick = Math.max(0, ...tickTexts.map((t) => estimateWidth(t, AXIS_FONT, 500)));
  const cap = Math.max(0, ...capsuleTexts.map((t) => estimateWidth(t, AXIS_FONT, 600) + CAPSULE_PAD * 2));
  return Math.ceil(Math.max(tick + 14, cap + 10, 36));
}

/** The point of a series nearest index `i` (exact match only for candles and bars; lines read their own point). */
export function valueAt(series, i) {
  if (!series.pts) return null;
  let lo = 0;
  let hi = series.pts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = series.pts[mid];
    if (p.i === i) return p;
    if (p.i < i) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

// ── Time axis (timeAxisScan.ts, timeAxisTicks.ts, timeAxisFormat.ts), in IST ──

const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad2 = (v) => (v < 10 ? `0${v}` : String(v));

/** Calendar fields of an instant in IST (fixed +05:30, no DST): { year, month 1-12, day, minute of day, dayNum }. */
export function istFields(ms) {
  if (!Number.isFinite(ms)) return null;
  const local = ms + IST_MS;
  const d = new Date(local);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), minute: d.getUTCHours() * 60 + d.getUTCMinutes(), dayNum: Math.floor(local / DAY_MS), weekday: d.getUTCDay() };
}

/** Bar granularity from the spacing of the times: the median gap decides. */
export function axisKind(times) {
  if (times.length < 2) return "daily";
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  gaps.sort((a, b) => a - b);
  const med = gaps[Math.floor(gaps.length / 2)];
  if (med < 20 * 3_600_000) return "intraday";
  if (med < 4 * DAY_MS) return "daily";
  if (med < 20 * DAY_MS) return "weekly";
  return "monthly";
}

const tickTime = (minute) => `${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`;
const tickDate = (f) => `${f.day} ${MONTHS[f.month - 1]}`;

/** The crosshair's stamp: "Tue 29 Sep 2026 10:15" intraday, "Tue 29 Sep 2026" daily, "Sep 2026" monthly. */
export function formatStamp(ms, kind) {
  const f = istFields(ms);
  if (!f) return "";
  if (kind === "monthly") return `${MONTHS[f.month - 1]} ${f.year}`;
  const stamp = `${WEEKDAYS[f.weekday]} ${pad2(f.day)} ${MONTHS[f.month - 1]} ${f.year}`;
  return kind === "intraday" ? `${stamp} ${tickTime(f.minute)}` : stamp;
}

/** Monday-based week id of a day number (1970-01-01 was a Thursday). */
const weekKey = (dayNum) => dayNum - ((((dayNum + 4) % 7) + 7 + 6) % 7);
const ym = (f) => f.year * 12 + f.month;

// Every ladder runs COARSE to FINE; the planner keeps the finest rung whose ticks still fit.
const RUNGS = {
  year: [10, 5, 2, 1].map((step) => ({ id: `y${step}`, key: (f) => Math.floor(f.year / step) })),
  month: [
    { id: "m6", key: (f) => f.year * 2 + Math.floor((f.month - 1) / 6) },
    { id: "m3", key: (f) => f.year * 4 + Math.floor((f.month - 1) / 3) },
    { id: "m1", key: ym },
  ],
  // Day-of-month cuts: 15th, 10th / 20th, Mondays, every day. Never the 30th (it sits next to a month boundary).
  day: [
    { id: "d15", key: (f) => ym(f) * 10 + (f.day >= 15 ? 1 : 0) },
    { id: "d10", key: (f) => ym(f) * 10 + (f.day >= 20 ? 2 : f.day >= 10 ? 1 : 0) },
    { id: "week", key: (f) => weekKey(f.dayNum) },
    { id: "day", key: (f) => f.dayNum },
  ],
  time: [120, 60, 30, 15, 5].map((step) => ({ id: `t${step}`, key: (f) => f.dayNum * 1500 + Math.floor(f.minute / step) })),
};

function rungsFor(kind) {
  return {
    time: kind === "intraday" ? RUNGS.time : [],
    day: kind === "intraday" || kind === "daily" ? RUNGS.day : kind === "weekly" ? RUNGS.day.filter((r) => r.id === "day") : [],
    month: RUNGS.month,
    year: RUNGS.year,
  };
}

const WEIGHT = { 1: 500, 2: 600, 3: 600, 4: 600 };

/**
 * Which labels the time axis prints, and where (the scanner's three passes, in IST):
 *  1. CADENCE: per calendar axis (time of day, day of month, month, year) keep the finest rung whose ticks still have
 *     room for their own text. Rungs are periods, so a holiday moves a tick to the next real bar.
 *  2. HIERARCHY: a tick's text is decided by the coarsest boundary it crosses (a new year prints the year, a new
 *     month the month, a new session the date, anything else the time or day number).
 *  3. LAYOUT: strongest first, then the label owning more bars; one that would touch a placed neighbour is dropped,
 *     and one whose bar is inside the plot but whose text would overhang an edge slides inward.
 * @param {{ times: number[], xOf: (i: number) => number, left: number, right: number, kind: string,
 *   measure?: (text: string, weight: number) => number, minGap?: number, cadencePad?: number, edgePad?: number }} o
 * @returns {Array<{ index: number, x: number, textX: number, text: string, level: 1|2|3|4, width: number }>}
 */
export function planTimeTicks(o) {
  const times = o.times ?? [];
  const N = times.length;
  if (!N || !(o.right > o.left)) return [];
  const measure = o.measure ?? ((t, w) => estimateWidth(t, AXIS_FONT, w));
  const gap = o.minGap ?? 12;
  const pad = o.cadencePad ?? 26;
  const edge = o.edgePad ?? 2;
  const kind = o.kind ?? axisKind(times);
  const F = times.map(istFields);
  const span = o.right - o.left;
  const ladders = rungsFor(kind);
  const sample = { time: "20:45", day: kind === "intraday" ? "29 Sep" : "29", month: "Sep", year: "2026" };
  const boundaries = (rung, mark) => {
    let count = 0;
    for (let j = 0; j < N; j++) {
      if (!F[j] || (j > 0 && (!F[j - 1] || rung.key(F[j]) === rung.key(F[j - 1])))) continue;
      count++;
      if (mark) mark[j] = 1;
    }
    return count;
  };
  const flagged = new Uint8Array(N);
  const dayFlag = new Uint8Array(N);
  let dayRung = false;
  for (const axis of ["time", "day", "month", "year"]) {
    const need = measure(sample[axis], axis === "time" || (axis === "day" && kind !== "intraday") ? 500 : 600) + pad;
    let pick = null;
    for (const rung of ladders[axis]) {
      const c = boundaries(rung);
      if (c > 0 && span / c < need) break;
      pick = rung;
    }
    if (!pick) continue;
    boundaries(pick, flagged);
    if (axis === "day") {
      boundaries(pick, dayFlag);
      dayRung = true;
    }
  }
  const cands = [];
  for (let j = 0; j < N; j++) {
    if (!flagged[j] || !F[j]) continue;
    const f = F[j];
    const p = j > 0 ? F[j - 1] : null;
    const first = j === 0;
    const yc = first ? kind !== "intraday" : p.year !== f.year;
    const mc = yc || (!first && p.month !== f.month);
    const dc = first || p.dayNum !== f.dayNum;
    let text;
    let level;
    if (yc) {
      text = String(f.year);
      level = 4;
    } else if (mc) {
      text = kind === "intraday" && dayRung ? tickDate(f) : MONTHS[f.month - 1];
      level = 3;
    } else if (dc && kind === "intraday" && dayFlag[j]) {
      text = tickDate(f);
      level = 2;
    } else if (kind === "intraday") {
      text = tickTime(f.minute);
      level = 1;
    } else {
      text = String(f.day);
      level = 1;
    }
    cands.push({ j, x: o.xOf(j), text, level, w: measure(text, WEIGHT[level]), owns: 0 });
  }
  // Bars each label owns: from it to the next label of the same or a higher level.
  const next = [N, N, N, N, N];
  for (let k = cands.length - 1; k >= 0; k--) {
    const c = cands[k];
    let end = N;
    for (let l = c.level; l <= 4; l++) end = Math.min(end, next[l]);
    c.owns = end - c.j;
    for (let l = 1; l <= c.level; l++) next[l] = c.j;
  }
  cands.sort((a, b) => b.level - a.level || b.owns - a.owns || a.j - b.j);
  const placed = [];
  const kept = [];
  for (const c of cands) {
    if (!(c.x >= o.left && c.x <= o.right) || c.w > span - 2 * edge) continue;
    let shift = 0;
    const l0 = c.x - c.w / 2;
    const r0 = c.x + c.w / 2;
    if (l0 < o.left + edge) shift = o.left + edge - l0;
    else if (r0 > o.right - edge) shift = o.right - edge - r0;
    const l = l0 + shift;
    const r = r0 + shift;
    if (placed.some((q) => l < q.r + gap && r > q.l - gap)) continue;
    placed.push({ l, r });
    kept.push({ index: c.j, x: c.x, textX: c.x + shift, text: c.text, level: c.level, width: c.w });
  }
  return kept.sort((a, b) => a.index - b.index);
}

/**
 * Level capsules for one pane, placed in the right gutter and nudged apart: [{ id, y (true), ly (placed), text, off }].
 * Price-axis ticks closer than a capsule's half height to a placed capsule are dropped by the caller (`hideTicks`).
 */
export function placeCapsules(levels, pane) {
  // A level kept off the scale (fit: false) is not drawn at the edge as if it were there: its capsule is pinned to
  // the edge it lies beyond with an arrow, and it has no ray (`off`).
  const items = levels
    .map((l) => {
      const v = Number(l.value);
      const off = v > pane.hi ? "above" : v < pane.lo ? "below" : null;
      const y = off === "above" ? pane.top : off === "below" ? pane.priceBottom : pane.yOf(v);
      return { ...l, y, off, text: off ? `${l.text} ${off === "above" ? "\u2191" : "\u2193"}` : l.text };
    })
    .filter((l) => Number.isFinite(l.y));
  return spreadLabels(items, CAPSULE_H + CAPSULE_GAP, pane.top + CAPSULE_H / 2, pane.priceBottom - CAPSULE_H / 2);
}

/** Price ticks that a capsule does not cover. */
export function hideTicks(ticks, pane, capsules) {
  return ticks.filter((v) => {
    const y = pane.yOf(v);
    return y >= pane.top + 6 && y <= pane.priceBottom - 2 && !capsules.some((c) => Math.abs(c.ly - y) < CAPSULE_H / 2 + 6);
  });
}
