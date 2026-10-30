// Analytics pages: option chain, OI and PCR, gamma exposure, IV skew and surface, strategy payoff, calculators.
//
// Everything here talks to this Bridge only (GET /v1/optionchain, /v1/expiries, /v1/analytics/*, POST payoff and
// position-size) and draws with inline SVG built by the DOM (no libraries, no style attributes, so the dashboard's
// CSP `style-src 'self'` holds). Colours come from classes in app.css, which use the theme tokens, so light and dark
// both work. The maths that decides geometry (scales, bar and line layout, request building) is pure and exported for
// analyticsViews.test.mjs; only the functions further down touch the DOM.
//
// views.js adds the pages with analyticsPages(() => helpers); the helpers (segmented control, labelled field, the
// error display) live in views.js and are handed in lazily so this file never imports views.js.
import { api, app, emptyState, h, icon, istTime, pill, table } from "./app.js";
import { DASH, formatFixed, formatInt, formatNumber, formatSigned, isFigure } from "./format.js";
import { UNDERLYING_CHIPS, isFormPage, nowShowing, workspace } from "./workspace.js";

// ───────────────────────── pure helpers ─────────────────────────

/** "Live stream · 2s old" style label for a Freshness object, with a tone for the pill. Missing → "Freshness unknown". */
export function freshnessLabel(f) {
  if (!f || typeof f !== "object") return { text: "Freshness unknown", tone: "warn" };
  const source = { stream: "Live stream", cache: "Cache", broker: "Broker", paper: "Paper", backup: f.provider ? `Backup (${f.provider})` : "Backup source" }[f.source] ?? String(f.source ?? "Unknown source");
  const age = Number(f.ageMs);
  let ageText = "";
  if (Number.isFinite(age) && age >= 0) ageText = age < 1000 ? "just now" : age < 60_000 ? `${formatInt(age / 1000)}s old` : age < 3_600_000 ? `${formatInt(age / 60_000)} min old` : `${formatInt(age / 3_600_000)} h old`;
  const text = [source, ageText, f.stale ? "stale" : ""].filter(Boolean).join(" · ");
  return { text, tone: f.stale || f.source === "backup" ? "warn" : f.source === "stream" ? "ok" : "info" };
}

/** Indian-style short number: 1.25 Cr, 4.5 L, 12.3k, 800. Missing → "--". */
export function compact(value) {
  if (!isFigure(value)) return DASH;
  const n = Number(value);
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const f = (v, dp) => formatNumber(v, { maximumFractionDigits: dp });
  if (a >= 1e7) return `${sign}${f(a / 1e7, 2)} Cr`;
  if (a >= 1e5) return `${sign}${f(a / 1e5, 2)} L`;
  if (a >= 1e3) return `${sign}${f(a / 1e3, 1)}k`;
  return `${sign}${f(a, 0)}`;
}

/** A "nice" axis: round bounds around [min, max] and about `count` evenly spaced ticks. */
export function niceScale(min, max, count = 5) {
  let lo = Number(min);
  let hi = Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: 0, max: 1, step: 0.2, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] };
  if (lo === hi) {
    const pad = Math.abs(lo) * 0.1 || 1;
    lo -= pad;
    hi += pad;
  }
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const frac = raw / mag;
  const step = (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10) * mag;
  const nmin = Math.floor(lo / step) * step;
  const nmax = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = nmin; v <= nmax + step / 2; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
  return { min: nmin, max: nmax, step, ticks };
}

/** A linear map from a domain to a range (a flat domain maps to the middle). */
export const linear = (d0, d1, r0, r1) => (v) => (d1 === d0 ? (r0 + r1) / 2 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0));

const r1 = (v) => Math.round(v * 10) / 10;

/** Width of one character of a 10.5px bold chart tag, used to reserve room for it. */
export const TAG_CHAR_W = 6.6;

/**
 * Horizontal bars per strike, drawn from a zero line (so calls and puts, or positive and negative exposure, sit on
 * opposite sides). `items`: [{ label, bars: [{ value, cls, title }], tag? }] in display order. `group` stacks the bars of a
 * row one above the other (two series on the same side). Returns the geometry.
 */
export function divergingLayout(items, { width = 640, rowH = 22, labelW = 56, tagW = 0, topPad = 6, axisH = 24, absAxis = false, group = false, tickFormat } = {}) {
  const w = Math.max(240, width);
  const max = Math.max(0, ...items.flatMap((i) => i.bars.map((b) => Math.abs(Number(b.value) || 0))));
  const hasNeg = items.some((i) => i.bars.some((b) => Number(b.value) < 0));
  const hasPos = items.some((i) => i.bars.some((b) => Number(b.value) > 0));
  const scale = niceScale(hasNeg ? -max : 0, hasPos || !hasNeg ? max : 0, 4);
  // Keep the zero line in the middle when both signs exist: the larger side decides both bounds.
  const lo = hasNeg && hasPos ? -Math.max(Math.abs(scale.min), scale.max) : scale.min;
  const hi = hasNeg && hasPos ? Math.max(Math.abs(scale.min), scale.max) : scale.max;
  // The tag column (Max pain, ATM, Flip) is reserved to the right of the plot and sized to the longest tag, so a tag can
  // never sit over the end of a bar.
  const tagLen = Math.max(0, ...items.map((i) => (i.tag ? String(i.tag).length : 0)));
  const tagCol = Math.max(tagW, tagLen ? Math.ceil(tagLen * TAG_CHAR_W + 12) : 12);
  const plotL = labelW;
  const plotR = w - tagCol;
  const x = linear(lo, hi, plotL, plotR);
  const x0 = x(0);
  const nBars = Math.max(1, ...items.map((i) => i.bars.length));
  // Side by side (call and put on opposite sides of zero) share one line; grouped bars (two series on the same side) stack.
  const slots = group ? nBars : 1;
  const bh = group ? Math.max(3, Math.floor((rowH * 0.84 - (slots - 1) * 2) / slots)) : Math.max(4, Math.round(rowH * 0.62));
  const rows = items.map((it, i) => {
    const y = topPad + i * rowH;
    return {
      y,
      label: it.label,
      tag: it.tag ?? null,
      band: it.band ?? null,
      bars: it.bars.map((b, k) => {
        const v = Number(b.value) || 0;
        const xv = x(v);
        const by = group ? y + (rowH - (slots * bh + (slots - 1) * 2)) / 2 + k * (bh + 2) : y + (rowH - bh) / 2;
        return { x: r1(Math.min(x0, xv)), y: r1(by), w: r1(Math.abs(xv - x0)), h: bh, cls: b.cls, title: b.title, value: v };
      }),
    };
  });
  const ticks = niceScale(lo, hi, 4).ticks.filter((t) => t >= lo - 1e-9 && t <= hi + 1e-9).map((t) => ({ x: r1(x(t)), label: tickFormat ? tickFormat(absAxis ? Math.abs(t) : t) : compact(absAxis ? Math.abs(t) : t), value: t }));
  return { width: w, height: topPad + items.length * rowH + axisH, plotL, plotR, tagX: w - 4, tagW: tagCol, x0: r1(x0), rowH, labelW, rows, ticks, bottom: topPad + items.length * rowH };
}

/**
 * Line chart geometry. `series`: [{ id, label, cls, dash?, points: [{ x, y }] }] (y null/NaN = a gap). Returns paths
 * plus nice axes. `xTicks` caps the number of x labels so a phone does not overprint them.
 */
export function lineLayout(series, { width = 640, height, padL = 44, padR = 14, padT = 12, padB = 28, yDecimals = 1 } = {}) {
  const w = Math.max(240, width);
  const hgt = height ?? Math.round(Math.min(340, Math.max(220, w * 0.5)));
  const pts = series.flatMap((s) => s.points.filter((p) => isFigure(p.y) && isFigure(p.x)));
  const xs = pts.map((p) => Number(p.x));
  const ys = pts.map((p) => Number(p.y));
  const xmin = Math.min(...xs);
  const xmax = Math.max(...xs);
  const ysc = niceScale(Math.min(...ys), Math.max(...ys), 4);
  const x = linear(xmin, xmax, padL, w - padR);
  const y = linear(ysc.min, ysc.max, hgt - padB, padT);
  const maxLabels = Math.max(2, Math.floor((w - padL - padR) / 64));
  const uniq = [...new Set(xs)].sort((a, b) => a - b);
  const every = Math.max(1, Math.ceil(uniq.length / maxLabels));
  const xTicks = uniq.filter((_, i) => i % every === 0).map((v) => ({ x: r1(x(v)), label: formatInt(v), value: v }));
  const paths = series.map((s) => {
    let d = "";
    let pen = false;
    const dots = [];
    for (const p of s.points) {
      if (!isFigure(p.x) || !isFigure(p.y)) {
        pen = false;
        continue;
      }
      const px = r1(x(Number(p.x)));
      const py = r1(y(Number(p.y)));
      d += `${pen ? "L" : "M"}${px} ${py}`;
      pen = true;
      dots.push({ x: px, y: py, title: `${s.label}: strike ${formatInt(p.x)}, ${formatFixed(p.y, yDecimals)}%` });
    }
    return { id: s.id, label: s.label, cls: s.cls, dash: s.dash ?? null, d, dots };
  });
  return {
    width: w,
    height: hgt,
    padL,
    padR,
    padT,
    padB,
    x: (v) => r1(x(v)),
    y: (v) => r1(y(v)),
    xTicks,
    yTicks: ysc.ticks.map((t) => ({ y: r1(y(t)), label: formatFixed(t, yDecimals), value: t })),
    paths,
    empty: pts.length === 0,
  };
}

/** Payoff chart geometry from a curve [{ price, pnl }]: line, profit and loss area (clipped at zero), axes, markers. */
export function payoffLayout(curve, { width = 640, height, breakevens = [], spot } = {}) {
  const w = Math.max(240, width);
  const hgt = height ?? Math.round(Math.min(340, Math.max(220, w * 0.5)));
  const padL = 56;
  const padR = 14;
  const padT = 14;
  const padB = 28;
  const prices = curve.map((c) => c.price);
  const pnls = curve.map((c) => c.pnl);
  const ysc = niceScale(Math.min(0, ...pnls), Math.max(0, ...pnls), 4);
  const xmin = Math.min(...prices);
  const xmax = Math.max(...prices);
  const x = linear(xmin, xmax, padL, w - padR);
  const y = linear(ysc.min, ysc.max, hgt - padB, padT);
  const zeroY = r1(y(0));
  const line = curve.map((c, i) => `${i ? "L" : "M"}${r1(x(c.price))} ${r1(y(c.pnl))}`).join("");
  const area = curve.length ? `${line}L${r1(x(xmax))} ${zeroY}L${r1(x(xmin))} ${zeroY}Z` : "";
  const nx = niceScale(xmin, xmax, Math.max(2, Math.floor((w - padL - padR) / 80)));
  return {
    width: w,
    height: hgt,
    padL,
    padR,
    padT,
    padB,
    zeroY,
    line,
    area,
    plotRight: w - padR,
    plotBottom: hgt - padB,
    xTicks: nx.ticks.filter((t) => t >= xmin - 1e-9 && t <= xmax + 1e-9).map((t) => ({ x: r1(x(t)), label: formatInt(t) })),
    yTicks: ysc.ticks.map((t) => ({ y: r1(y(t)), label: compact(t), value: t })),
    breakevens: breakevens.filter((b) => b >= xmin && b <= xmax).map((b) => ({ x: r1(x(b)), y: zeroY, value: b })),
    spot: isFigure(spot) && Number(spot) >= xmin && Number(spot) <= xmax ? { x: r1(x(Number(spot))), value: Number(spot) } : null,
  };
}

/** One number from an input's text: null when empty or not a finite number. */
export function readNumber(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
const isWhole = (n) => Number.isInteger(n);

/**
 * Turn the leg editor's text fields into the POST /v1/analytics/payoff body, or the list of problems to show.
 * @param {{ type: string, side: string, strike: string, price: string, lots: string, lotSize: string }[]} legs
 * @param {string} [spotText]
 */
export function legsToBody(legs, spotText = "") {
  const errors = [];
  const out = [];
  if (!legs.length) errors.push({ leg: -1, field: "legs", message: "Add at least one leg." });
  if (legs.length > 12) errors.push({ leg: -1, field: "legs", message: "A strategy can have at most 12 legs." });
  legs.forEach((l, i) => {
    const n = i + 1;
    const leg = { type: l.type, side: l.side };
    if (l.type !== "FUT") {
      const strike = readNumber(l.strike);
      if (strike === null || strike <= 0) errors.push({ leg: i, field: "strike", message: `Leg ${n}: strike must be a number above 0.` });
      else leg.strike = strike;
    }
    const price = readNumber(l.price);
    if (price === null || price < 0) errors.push({ leg: i, field: "price", message: `Leg ${n}: ${l.type === "FUT" ? "entry price" : "price"} must be 0 or more.` });
    else leg.price = price;
    const lots = readNumber(l.lots ?? "1");
    if (lots === null || !isWhole(lots) || lots < 1) errors.push({ leg: i, field: "lots", message: `Leg ${n}: lots must be a whole number, 1 or more.` });
    else leg.lots = lots;
    const lotSize = readNumber(l.lotSize ?? "1");
    if (lotSize === null || !isWhole(lotSize) || lotSize < 1) errors.push({ leg: i, field: "lotSize", message: `Leg ${n}: lot size must be a whole number, 1 or more.` });
    else leg.lotSize = lotSize;
    out.push(leg);
  });
  const body = { legs: out };
  if (String(spotText).trim()) {
    const spot = readNumber(spotText);
    if (spot === null || spot <= 0) errors.push({ leg: -1, field: "spot", message: "Spot must be a number above 0 (or leave it empty)." });
    else body.spot = spot;
  }
  return errors.length ? { ok: false, errors } : { ok: true, body };
}

/**
 * Ready-made strategies from a loaded chain (strike steps from ATM, prices from each option's last price).
 * Returns { legs } or { error }. `legs` use the editor's text fields.
 */
export const PRESETS = [
  { id: "long-straddle", label: "Long straddle", legs: [["CE", "buy", 0], ["PE", "buy", 0]] },
  { id: "short-strangle", label: "Short strangle", legs: [["CE", "sell", 2], ["PE", "sell", -2]] },
  { id: "bull-call-spread", label: "Bull call spread", legs: [["CE", "buy", 0], ["CE", "sell", 2]] },
  { id: "iron-condor", label: "Iron condor", legs: [["CE", "sell", 2], ["CE", "buy", 4], ["PE", "sell", -2], ["PE", "buy", -4]] },
];
export function presetLegs(presetId, chain) {
  const preset = PRESETS.find((p) => p.id === presetId);
  const rows = [...(chain?.rows ?? [])].sort((a, b) => a.strike - b.strike);
  if (!preset || !rows.length) return { error: "There is no option chain to price this from." };
  let atm = rows.findIndex((r) => r.strike === chain.atmStrike);
  if (atm < 0 && isFigure(chain.underlyingLtp)) atm = rows.reduce((best, r, i) => (Math.abs(r.strike - chain.underlyingLtp) < Math.abs(rows[best].strike - chain.underlyingLtp) ? i : best), 0);
  if (atm < 0) atm = Math.floor(rows.length / 2);
  const legs = [];
  for (const [type, side, offset] of preset.legs) {
    const row = rows[atm + offset];
    const ltp = row?.[type.toLowerCase()]?.ltp;
    if (!row || !isFigure(ltp)) return { error: `The chain has no ${type} price at ${offset >= 0 ? "+" : ""}${offset} strikes from the money. Load more strikes or pick another strategy.` };
    legs.push({ type, side, strike: String(row.strike), price: String(ltp), lots: "1", lotSize: String(chain.lotSize ?? 1) });
  }
  return { legs };
}

/** The GET /v1/analytics/greeks query from the calculator's fields, or { ok: false, error }. */
export function greeksQuery({ spot, strike, type, days, mode, iv, price, rate }) {
  const need = (v, name, min = 0.01) => {
    const n = readNumber(v);
    return n === null || n < min ? `${name} must be a number${min > 0 ? ` of at least ${min}` : ""}.` : null;
  };
  const problem = need(spot, "Spot") ?? need(strike, "Strike") ?? need(days, "Days to expiry", 0) ?? (mode === "price" ? need(price, "Option price") : need(iv, "IV (percent)")) ?? (String(rate ?? "").trim() ? need(rate, "Rate (percent)", 0) : null);
  if (problem) return { ok: false, error: problem };
  const q = new URLSearchParams({ spot: String(readNumber(spot)), strike: String(readNumber(strike)), type: type === "PE" ? "PE" : "CE", days: String(readNumber(days)) });
  if (mode === "price") q.set("price", String(readNumber(price)));
  else q.set("iv", String(readNumber(iv)));
  if (String(rate ?? "").trim()) q.set("rate", String(readNumber(rate)));
  return { ok: true, query: q.toString() };
}

/** The POST /v1/analytics/position-size body from the calculator's fields, or { ok: false, error }. */
export function sizeBody({ capital, riskPct, entry, stop, lotSize, maxLots }) {
  const pos = (v, name) => {
    const n = readNumber(v);
    return n === null || n <= 0 ? `${name} must be a number above 0.` : null;
  };
  const problem = pos(capital, "Capital") ?? pos(riskPct, "Risk percent") ?? pos(entry, "Entry price") ?? pos(stop, "Stop price");
  if (problem) return { ok: false, error: problem };
  if (readNumber(riskPct) > 100) return { ok: false, error: "Risk percent cannot be more than 100." };
  const body = { capital: readNumber(capital), riskPct: readNumber(riskPct), entry: readNumber(entry), stop: readNumber(stop) };
  if (String(lotSize ?? "").trim()) {
    const n = readNumber(lotSize);
    if (n === null || !isWhole(n) || n < 1) return { ok: false, error: "Lot size must be a whole number, 1 or more." };
    body.lotSize = n;
  }
  if (String(maxLots ?? "").trim()) {
    const n = readNumber(maxLots);
    if (n === null || !isWhole(n) || n < 0) return { ok: false, error: "Max lots must be a whole number, 0 or more." };
    body.maxLots = n;
  }
  return { ok: true, body };
}

/** Series for the surface chart: one line per expiry (the mean of call and put IV at each strike). */
export const SURFACE_CLASSES = ["s1", "s2", "s3", "s4", "s5", "s6"];
const SURFACE_DASH = [null, "6 3", "2 3", "8 3 2 3", "1 4", "10 4"];
export function surfaceSeries(expiries) {
  return (expiries ?? []).map((e, i) => ({
    id: e.expiry,
    label: e.expiry,
    cls: SURFACE_CLASSES[i % SURFACE_CLASSES.length],
    dash: SURFACE_DASH[i % SURFACE_DASH.length],
    points: (e.points ?? []).map((p) => ({ x: p.strike, y: isFigure(p.ceIv) && isFigure(p.peIv) ? (Number(p.ceIv) + Number(p.peIv)) / 2 : isFigure(p.ceIv) ? Number(p.ceIv) : isFigure(p.peIv) ? Number(p.peIv) : null })),
  }));
}

/** Option-chain rows prepared for display: marks ATM and sorts by strike. */
export function chainRows(chain) {
  return [...(chain?.rows ?? [])].sort((a, b) => a.strike - b.strike).map((r) => ({ ...r, atm: r.strike === chain?.atmStrike }));
}

// ───────────────────────── SVG (DOM) ─────────────────────────

const SVG_NS = "http://www.w3.org/2000/svg";
/** An SVG element: attributes as given (class via "class"), children appended. No style attributes anywhere. */
export function s(tag, attrs, ...children) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== undefined && v !== null && v !== false) e.setAttribute(k, String(v));
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
export const svgRoot = (w, hgt, label) => s("svg", { class: "chart", viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, role: "img", "aria-label": label, focusable: "false" });

/** A container that redraws `build(width)` when its width changes (phone rotation, sidebar, window). */
export function chartHost(build) {
  const host = h("div", { class: "chart-host" });
  let last = 0;
  const draw = () => {
    const w = Math.max(260, Math.floor(host.clientWidth || 640));
    if (w === last) return;
    last = w;
    host.replaceChildren(build(w));
  };
  draw();
  last = 0;
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => host.isConnected && draw()).observe(host);
  return host;
}

export function legend(entries) {
  return h("ul", { class: "chart-legend", "aria-label": "Legend" }, entries.map((e) => h("li", {}, h("i", { class: `swatch ${e.cls}`, "aria-hidden": "true" }), e.label)));
}

/** Strike bars (OI butterfly, GEX): see divergingLayout. */
export function strikeBars(items, { label, absAxis = false, formatTitle, layout = {} }) {
  return chartHost((w) => {
    const L = divergingLayout(items, { width: w, absAxis, ...layout });
    const svg = svgRoot(L.width, L.height, label);
    for (const t of L.ticks) svg.append(s("line", { class: "grid-line", x1: t.x, x2: t.x, y1: 0, y2: L.bottom }), s("text", { class: "tick", x: t.x, y: L.bottom + 16, "text-anchor": "middle" }, t.label));
    for (const r of L.rows) {
      if (r.band) svg.append(s("rect", { class: `band ${r.band}`, x: 0, y: r.y, width: L.width, height: L.rowH, rx: 4 }));
      svg.append(s("text", { class: r.band ? "strike strong" : "strike", x: L.labelW - 8, y: r.y + L.rowH / 2 + 4, "text-anchor": "end" }, r.label));
      for (const b of r.bars) if (b.w > 0) svg.append(s("rect", { class: `bar ${b.cls}`, x: b.x, y: b.y, width: Math.max(1, b.w), height: b.h, rx: 2 }, s("title", {}, b.title ?? formatTitle?.(r, b))));
      if (r.tag) svg.append(s("text", { class: "tag", x: L.tagX, y: r.y + L.rowH / 2 + 4, "text-anchor": "end" }, r.tag));
    }
    svg.append(s("line", { class: "zero-line", x1: L.x0, x2: L.x0, y1: 0, y2: L.bottom }));
    return svg;
  });
}

/** Lines over a numeric x axis (strike). `marker` draws a dashed vertical line with a label. */
export function lineChart(series, { label, marker, yDecimals = 1 }) {
  return chartHost((w) => {
    const L = lineLayout(series, { width: w, yDecimals });
    const svg = svgRoot(L.width, L.height, label);
    if (L.empty) return svg;
    for (const t of L.yTicks) svg.append(s("line", { class: "grid-line", x1: L.padL, x2: L.width - L.padR, y1: t.y, y2: t.y }), s("text", { class: "tick", x: L.padL - 6, y: t.y + 4, "text-anchor": "end" }, t.label));
    for (const t of L.xTicks) svg.append(s("text", { class: "tick", x: t.x, y: L.height - 8, "text-anchor": "middle" }, t.label));
    if (marker && isFigure(marker.x)) svg.append(s("line", { class: "marker-line", x1: L.x(marker.x), x2: L.x(marker.x), y1: L.padT, y2: L.height - L.padB }), s("text", { class: "tag", x: L.x(marker.x), y: L.padT + 10, "text-anchor": "middle" }, marker.label));
    for (const p of L.paths) {
      if (p.d) svg.append(s("path", { class: `line ${p.cls}`, d: p.d, "stroke-dasharray": p.dash }));
      for (const d of p.dots) svg.append(s("circle", { class: `dot ${p.cls}`, cx: d.x, cy: d.y, r: 3 }, s("title", {}, d.title)));
    }
    return svg;
  });
}

let clipSeq = 0;
export function payoffChart(curve, { breakevens, spot, label }) {
  return chartHost((w) => {
    const L = payoffLayout(curve, { width: w, breakevens, spot });
    const svg = svgRoot(L.width, L.height, label);
    const id = `pay-clip-${++clipSeq}`;
    svg.append(
      s("defs", {}, s("clipPath", { id: `${id}-up` }, s("rect", { x: L.padL, y: 0, width: L.plotRight - L.padL, height: L.zeroY })), s("clipPath", { id: `${id}-dn` }, s("rect", { x: L.padL, y: L.zeroY, width: L.plotRight - L.padL, height: Math.max(0, L.height - L.zeroY) }))),
    );
    for (const t of L.yTicks) svg.append(s("line", { class: "grid-line", x1: L.padL, x2: L.plotRight, y1: t.y, y2: t.y }), s("text", { class: "tick", x: L.padL - 6, y: t.y + 4, "text-anchor": "end" }, t.label));
    for (const t of L.xTicks) svg.append(s("text", { class: "tick", x: t.x, y: L.height - 8, "text-anchor": "middle" }, t.label));
    svg.append(s("path", { class: "area profit", d: L.area, "clip-path": `url(#${id}-up)` }), s("path", { class: "area loss", d: L.area, "clip-path": `url(#${id}-dn)` }), s("line", { class: "zero-line", x1: L.padL, x2: L.plotRight, y1: L.zeroY, y2: L.zeroY }));
    if (L.spot) svg.append(s("line", { class: "marker-line", x1: L.spot.x, x2: L.spot.x, y1: L.padT, y2: L.plotBottom }), s("text", { class: "tag", x: L.spot.x, y: L.padT + 10, "text-anchor": "middle" }, "Spot"));
    svg.append(s("path", { class: "line payoff", d: L.line }));
    for (const b of L.breakevens) svg.append(s("circle", { class: "be-dot", cx: b.x, cy: b.y, r: 4.5 }, s("title", {}, `Break-even ${formatFixed(b.value, 2)}`)));
    return svg;
  });
}

/** A "show as table" disclosure under a chart, so the numbers are reachable without the picture. */
export function dataDisclosure(summary, columns, rows) {
  return h("details", { class: "disclosure" }, h("summary", {}, summary), h("div", { class: "card" }, table(columns, rows, h("p", { class: "muted small" }, "No data."), { mobile: "scroll" })));
}

// ───────────────────────── page scaffolding ─────────────────────────

const UNDERLYINGS = UNDERLYING_CHIPS;
const STRIKE_CHOICES = [5, 10, 15, 20, 30];
/** Legs another page (Strategies) hands to the payoff page: { legs: editor legs, spot: text } or null. Read once. */
export const handoff = { payoff: null };
/**
 * What the person last chose, shared by every analytics page and the header's context bar, and remembered across reloads
 * (workspace.js: its fields validate, persist and notify when assigned).
 */
export const selection = workspace.state;
let uid = 0;
export const nextId = (p) => `${p}-${++uid}`;
export const demoPill = () => (app.state.demo ? pill("Demo data", "demo") : null);

/** The freshness label row every data page shows (plus the demo label in demo mode). */
export function statusRow(freshness, extra) {
  const f = freshnessLabel(freshness);
  return h("div", { class: "row analytics-status" }, pill(f.text, f.tone), freshness?.asOf ? h("span", { class: "muted small" }, `as of ${istTime(freshness.asOf)} IST`) : null, demoPill(), extra ?? null);
}
/** For pages that only calculate (no market data): says so instead of a freshness. */
export const calcStatus = () => h("div", { class: "row analytics-status" }, pill("Calculated on this Bridge · no market data", "info"), demoPill());

export function tile(label, value, sub, tone) {
  return h("section", { class: "card stat" }, h("div", { class: "stat-head" }, h("span", { class: "label" }, label)), h("span", { class: tone ? `value ${tone}` : "value" }, value), sub ? h("span", { class: "sub" }, sub) : null);
}
export const tiles = (...t) => h("div", { class: "grid cols-4 stats" }, t);

/**
 * Underlying, expiry and strikes controls. `onChange()` runs after any change; `expiry()` etc. read the choice.
 * Loads the expiry list from /v1/expiries (errors go to `onError`).
 *
 * The header's context bar is the one place to choose underlying, expiry and strikes on an Analytics page, so by default
 * these three fields are kept (they hold the page's working values) but hidden, and a one-line summary says what is in
 * use. `local: true` keeps them visible for a page whose form needs an explicit target of its own (Alert rules).
 * On a form page the controls follow the bar without re-running the page: the expiry list is refreshed quietly and
 * `onContext()` (if given) runs, but `onChange` does not, so drafts and results stay as they are. Data pages are
 * redrawn by the router when the bar changes, so they need no following.
 */
export function chainControls(H, { onChange, onError, withStrikes = true, strikeChoices = STRIKE_CHOICES, local = false, onContext }) {
  const uId = nextId("an-u");
  const eId = nextId("an-e");
  const kId = nextId("an-k");
  const underlying = h("input", { id: uId, list: `${uId}-list`, value: selection.underlying, spellcheck: "false", autocomplete: "off", autocapitalize: "characters", maxlength: 30 });
  const list = h("datalist", { id: `${uId}-list` }, UNDERLYINGS.map((u) => h("option", { value: u })));
  const expiry = h("select", { id: eId }, h("option", { value: "" }, "Loading…"));
  const strikes = h("select", { id: kId }, strikeChoices.map((n) => h("option", { value: String(n), selected: n === selection.strikes }, `${n} each side`)));
  const refresh = h("button", { type: "button", class: "small", onclick: () => onChange() }, icon("refresh"), "Refresh");
  const expiryField = H.field("Expiry", expiry);
  const underlyingField = H.field("Underlying", underlying);
  const strikesField = withStrikes ? H.field("Strikes", strikes) : null;
  const loadExpiries = async ({ quiet = false } = {}) => {
    selection.underlying = underlying.value.trim().toUpperCase() || "NIFTY";
    underlying.value = selection.underlying;
    expiry.disabled = true;
    try {
      const r = await api(`/v1/expiries?underlying=${encodeURIComponent(selection.underlying)}`);
      const today = new Date().toISOString().slice(0, 10);
      const all = (r.data?.data?.expiries ?? []).filter((e) => e >= today);
      expiry.replaceChildren(...(all.length ? all.map((e) => h("option", { value: e }, e)) : [h("option", { value: "" }, "No expiries")]));
      expiry.value = all.includes(selection.expiry) ? selection.expiry : all[0] ?? "";
      selection.expiry = expiry.value;
    } catch (err) {
      expiry.replaceChildren(h("option", { value: "" }, "Unavailable"));
      selection.expiry = "";
      if (!quiet) onError?.(err);
      expiry.disabled = false;
      return false;
    }
    expiry.disabled = false;
    return true;
  };
  underlying.addEventListener("change", async () => {
    if (await loadExpiries()) onChange();
  });
  expiry.addEventListener("change", () => {
    selection.expiry = expiry.value;
    onChange();
  });
  strikes.addEventListener("change", () => {
    selection.strikes = Number(strikes.value);
    onChange();
  });
  for (const f of [underlyingField, expiryField, strikesField]) f?.classList.add("ctx-owned"); // hidden by CSS while the context bar owns them
  const summary = h("p", { class: "ctx-summary" });
  const node = h("div", { class: `form-grid analytics-controls${local ? "" : " ctx-managed"}` }, local ? null : summary, underlyingField, list, expiryField, strikesField, h("div", { class: "field" }, h("span", { class: "pal-sr-only" }, "Refresh"), refresh));
  const paintSummary = () => {
    const bits = [h("b", {}, selection.underlying)];
    if (!expiryField.hidden) bits.push(h("span", {}, selection.expiry || "no expiry"));
    if (strikesField && !strikesField.hidden) bits.push(h("span", {}, `±${selection.strikes} strikes`));
    summary.replaceChildren(...bits.flatMap((b, i) => (i ? [h("i", { "aria-hidden": "true" }, "·"), b] : [b])), h("span", { class: "ctx-summary-hint" }, "Change these in the context bar above."));
  };
  paintSummary();
  let seen = false;
  let syncing = false;
  const unsubscribe = workspace.subscribe(async (_now, changed) => {
    paintSummary(); // also while the page is still loading (the default expiry arrives before the node is attached)
    if (!node.isConnected) {
      if (seen) unsubscribe();
      return;
    }
    seen = true;
    if (syncing || !isFormPage(nowShowing.id)) return; // a data page is redrawn by the router instead
    syncing = true;
    try {
      if (changed.includes("underlying")) {
        underlying.value = selection.underlying;
        await loadExpiries({ quiet: true });
      } else if (changed.includes("expiry") && selection.expiry && expiry.value !== selection.expiry) {
        if (![...expiry.options].some((o) => o.value === selection.expiry)) expiry.append(h("option", { value: selection.expiry }, selection.expiry));
        expiry.value = selection.expiry;
      }
      if (changed.includes("strikes") && ![...strikes.options].some((o) => o.value === String(selection.strikes))) strikes.append(h("option", { value: String(selection.strikes) }, `${selection.strikes} each side`));
      strikes.value = String(selection.strikes);
      paintSummary();
      onContext?.();
    } finally {
      syncing = false;
    }
  });
  return {
    node,
    init: loadExpiries,
    values: () => ({ underlying: selection.underlying, expiry: expiry.value || selection.expiry, strikes: selection.strikes }),
    showExpiry: (on) => {
      expiryField.hidden = !on;
      paintSummary();
    },
    /** Show only the fields a page needs: { underlying, expiry, strikes } (true shows, false hides). */
    show: ({ underlying: u = true, expiry: e = true, strikes: k = true } = {}) => {
      underlyingField.hidden = !u;
      expiryField.hidden = !e;
      if (strikesField) strikesField.hidden = !k;
      paintSummary();
    },
  };
}

/**
 * The shape of every chain-based page: controls card, then a result area that shows the freshness label, the demo
 * label and the drawing, or the Bridge's error in the existing alert display.
 */
export async function chainPage(H, { endpoint, needsExpiry = true, draw, controlsExtra, strikeChoices }) {
  const out = h("div", { class: "stack", "aria-live": "polite" });
  let seq = 0;
  const load = async () => {
    const mine = ++seq;
    const v = controls.values();
    out.replaceChildren(h("p", { class: "muted" }, "Loading…"));
    try {
      if (needsExpiry && !v.expiry) {
        out.replaceChildren(emptyState("info", "No expiry to show", "This underlying has no upcoming expiry in the instrument list. Check the symbol (for example NIFTY) and try again."));
        return;
      }
      const res = await endpoint(v);
      if (mine !== seq) return;
      out.replaceChildren(...[await draw(res.data?.data, res.data?.meta?.freshness, v, res)].flat());
    } catch (err) {
      if (mine === seq) out.replaceChildren(H.errorBox(err));
    }
  };
  const controls = chainControls(H, { onChange: load, onError: (e) => out.replaceChildren(H.errorBox(e)), strikeChoices });
  const first = h("div", { class: "stack" }, h("section", { class: "card" }, h("div", { class: "card-body" }, controls.node, controlsExtra?.(controls) ?? null)), out);
  if (await controls.init()) await load();
  return first;
}

// ───────────────────────── pages ─────────────────────────

export const callPutLegend = () => legend([{ cls: "call", label: "Call (CE)" }, { cls: "put", label: "Put (PE)" }]);
export const q = (v, extra = {}) => new URLSearchParams({ underlying: v.underlying, expiry: v.expiry, strikes: String(v.strikes), ...extra }).toString();

async function renderChain(H) {
  return chainPage(H, {
    endpoint: (v) => api(`/v1/optionchain?${q(v)}`),
    draw: (chain, freshness) => {
      const rows = chainRows(chain);
      const cell = (side, f, kind) => (r) => {
        const v = r[side]?.[f];
        return kind === "int" ? compact(v) : kind === "signed" ? (isFigure(v) ? formatSigned(v, 0) : DASH) : formatFixed(v, 2);
      };
      const cols = [
        { label: "Call OI", num: true, cell: cell("ce", "oi", "int") },
        { label: "Call OI chg", num: true, cell: cell("ce", "oiChange", "signed") },
        { label: "Call IV", num: true, cell: cell("ce", "iv") },
        { label: "Call LTP", num: true, cell: cell("ce", "ltp") },
        { label: "Strike", num: true, cell: (r) => h("strong", {}, formatInt(r.strike), r.atm ? h("span", { class: "atm-flag" }, "ATM") : null) },
        { label: "Put LTP", num: true, cell: cell("pe", "ltp") },
        { label: "Put IV", num: true, cell: cell("pe", "iv") },
        { label: "Put OI chg", num: true, cell: cell("pe", "oiChange", "signed") },
        { label: "Put OI", num: true, cell: cell("pe", "oi", "int") },
      ];
      const t = table(cols, rows, emptyState("list", "No strikes", "The chain came back empty."), { mobile: "scroll" });
      for (const [i, tr] of [...(t.querySelectorAll?.("tbody tr") ?? [])].entries()) if (rows[i]?.atm) tr.classList.add("atm");
      return [
        statusRow(freshness),
        tiles(tile(`${chain.underlying} spot`, isFigure(chain.underlyingLtp) ? formatFixed(chain.underlyingLtp, 2) : DASH, "Underlying last price"), tile("ATM strike", isFigure(chain.atmStrike) ? formatInt(chain.atmStrike) : DASH, "Nearest to spot"), tile("Lot size", isFigure(chain.lotSize) ? formatInt(chain.lotSize) : DASH, "Units per lot"), tile("Expiry", chain.expiry ?? DASH, `${formatInt(rows.length)} strikes loaded`)),
        h("section", { class: "card chain" }, h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, "Option chain"), h("p", {}, "Calls on the left, puts on the right, strike in the middle. OI change and IV are shown when the data source has them."))), h("div", { class: "card-body flush" }, t)),
      ];
    },
  });
}

async function renderOi(H) {
  return chainPage(H, {
    endpoint: (v) => api(`/v1/analytics/oi?${q(v)}`),
    draw: (d, freshness) => {
      const pain = d.maxPain;
      const items = [...d.strikes]
        .sort((a, b) => b.strike - a.strike)
        .map((r) => ({
          label: formatInt(r.strike),
          band: r.strike === pain ? "pain" : r.strike === d.atmStrike ? "atm" : null,
          tag: r.strike === pain ? "Max pain" : r.strike === d.atmStrike ? "ATM" : null,
          bars: [
            { value: -r.peOi, cls: "put", title: `${formatInt(r.strike)} put OI ${formatInt(r.peOi)}` },
            { value: r.ceOi, cls: "call", title: `${formatInt(r.strike)} call OI ${formatInt(r.ceOi)}` },
          ],
        }));
      const sr = (list) => (list?.length ? list.map((x) => `${formatInt(x.strike)} (${compact(x.value)})`).join(", ") : DASH);
      return [
        statusRow(freshness),
        tiles(tile("PCR (OI)", isFigure(d.pcrOi) ? formatFixed(d.pcrOi, 2) : DASH, "Put OI divided by call OI"), tile("Max pain", isFigure(pain) ? formatInt(pain) : DASH, "Writers pay out least here"), tile("Call OI", compact(d.totals?.ceOi), `Change ${compact(d.totals?.ceOiChange)}`), tile("Put OI", compact(d.totals?.peOi), `Change ${compact(d.totals?.peOiChange)}`)),
        h(
          "section",
          { class: "card" },
          h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, "Open interest by strike"), h("p", {}, `${d.underlying} ${d.expiry}: puts extend left, calls right. The highlighted rows are max pain and the at-the-money strike.`))),
          h("div", { class: "card-body" }, callPutLegend(), strikeBars(items, { label: `Call and put open interest by strike for ${d.underlying} ${d.expiry}. Max pain ${isFigure(pain) ? formatInt(pain) : "unknown"}.`, absAxis: true })),
        ),
        h("div", { class: "grid cols-2" }, tile("Resistance (highest call OI)", sr(d.resistance), "Where call writers are concentrated"), tile("Support (highest put OI)", sr(d.support), "Where put writers are concentrated")),
        dataDisclosure("Show as a table", [{ label: "Strike", cell: (r) => h("strong", {}, formatInt(r.strike)) }, { label: "Call OI", num: true, cell: (r) => formatInt(r.ceOi) }, { label: "Put OI", num: true, cell: (r) => formatInt(r.peOi) }, { label: "Call OI chg", num: true, cell: (r) => formatSigned(r.ceOiChange, 0) }, { label: "Put OI chg", num: true, cell: (r) => formatSigned(r.peOiChange, 0) }], [...d.strikes].sort((a, b) => a.strike - b.strike)),
      ];
    },
  });
}

async function renderGex(H) {
  return chainPage(H, {
    endpoint: (v) => api(`/v1/analytics/gex?${q(v)}`),
    draw: (d, freshness) => {
      const flip = d.flipStrike;
      const items = [...d.strikes]
        .sort((a, b) => b.strike - a.strike)
        .map((r) => ({
          label: formatInt(r.strike),
          band: r.strike === flip ? "pain" : null,
          tag: r.strike === flip ? "Flip" : null,
          bars: [{ value: r.netGex, cls: r.netGex >= 0 ? "call" : "put", title: `${formatInt(r.strike)} net GEX ${compact(r.netGex)} (calls ${compact(r.callGex)}, puts ${compact(r.putGex)})` }],
        }));
      const regimeText = { positive: "Positive: dealers dampen moves", negative: "Negative: dealers amplify moves", neutral: "Neutral" }[d.regime] ?? DASH;
      return [
        statusRow(freshness),
        tiles(tile("Net GEX", compact(d.netGex), `${d.unit ?? "INR per 1% move"}`), tile("Regime", d.regime ? d.regime[0].toUpperCase() + d.regime.slice(1) : DASH, regimeText), tile("Flip strike", isFigure(flip) ? formatInt(flip) : DASH, "Where running exposure changes sign"), tile("Largest strike", isFigure(d.largestStrike) ? formatInt(d.largestStrike) : DASH, "Biggest absolute net exposure")),
        h(
          "section",
          { class: "card" },
          h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, "Net gamma exposure by strike"), h("p", {}, "Calls add, puts subtract (the usual dealer convention). The highlighted row is the flip strike."))),
          h("div", { class: "card-body" }, legend([{ cls: "call", label: "Net positive" }, { cls: "put", label: "Net negative" }]), strikeBars(items, { label: `Net gamma exposure by strike for ${d.underlying} ${d.expiry}. Flip strike ${isFigure(flip) ? formatInt(flip) : "none"}.` })),
        ),
        dataDisclosure("Show as a table", [{ label: "Strike", cell: (r) => h("strong", {}, formatInt(r.strike)) }, { label: "Call GEX", num: true, cell: (r) => compact(r.callGex) }, { label: "Put GEX", num: true, cell: (r) => compact(r.putGex) }, { label: "Net GEX", num: true, cell: (r) => compact(r.netGex) }], [...d.strikes].sort((a, b) => a.strike - b.strike)),
      ];
    },
  });
}

async function renderSkew(H) {
  const mode = H.segmented("View", [["skew", "One expiry"], ["surface", "Across expiries"]], "skew");
  const modeField = H.segField("View", mode);
  const page = await chainPage(H, {
    endpoint: (v) => (mode.value === "surface" ? api(`/v1/analytics/surface?${new URLSearchParams({ underlying: v.underlying, strikes: String(v.strikes), expiries: "4" })}`) : api(`/v1/analytics/skew?${q(v)}`)),
    needsExpiry: false,
    controlsExtra: (controls) => {
      const apply = () => controls.showExpiry(mode.value !== "surface");
      mode.addEventListener("change", apply);
      apply();
      return h("div", { class: "analytics-mode" }, modeField);
    },
    draw: (d, freshness, v) => {
      if (mode.value === "surface") {
        const slices = d.expiries ?? [];
        if (!slices.length) return [statusRow(freshness), emptyState("chart", "No expiries to draw", "The Bridge found no upcoming expiry with prices for this underlying.")];
        const series = surfaceSeries(slices);
        return [
          statusRow(freshness),
          tiles(tile("Term structure", d.termStructure ?? DASH, "Far ATM IV against near"), tile("Near ATM IV", isFigure(slices[0]?.atmIv) ? `${formatFixed(slices[0].atmIv, 2)}%` : DASH, slices[0]?.expiry ?? ""), tile("Far ATM IV", isFigure(slices.at(-1)?.atmIv) ? `${formatFixed(slices.at(-1).atmIv, 2)}%` : DASH, slices.at(-1)?.expiry ?? ""), tile("Expiries", formatInt(slices.length), "Next upcoming")),
          h("section", { class: "card" }, h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, "Implied volatility across expiries"), h("p", {}, "One line per expiry: the average of call and put IV at each strike, in percent."))), h("div", { class: "card-body" }, legend(series.map((x) => ({ cls: x.cls, label: x.label }))), lineChart(series, { label: `Implied volatility by strike for ${slices.length} expiries of ${d.underlying}` }))),
          dataDisclosure("Show as a table", [{ label: "Expiry", cell: (r) => h("strong", {}, r.expiry) }, { label: "Days", num: true, cell: (r) => formatFixed(r.daysToExpiry, 1) }, { label: "ATM IV %", num: true, cell: (r) => formatFixed(r.atmIv, 2) }, { label: "Risk reversal", num: true, cell: (r) => formatSigned(r.riskReversal, 2) }], slices),
        ];
      }
      const series = [
        { id: "ce", label: "Call IV", cls: "call", points: d.points.map((p) => ({ x: p.strike, y: p.ceIv })) },
        { id: "pe", label: "Put IV", cls: "put", dash: "6 3", points: d.points.map((p) => ({ x: p.strike, y: p.peIv })) },
      ];
      const skewWord = { "put-heavy": "Puts richer than calls", "call-heavy": "Calls richer than puts", flat: "Roughly flat" }[d.skew] ?? DASH;
      return [
        statusRow(freshness),
        tiles(tile("ATM IV", isFigure(d.atmIv) ? `${formatFixed(d.atmIv, 2)}%` : DASH, `Strike ${isFigure(d.atmStrike) ? formatInt(d.atmStrike) : DASH}`), tile("Risk reversal", isFigure(d.riskReversal) ? formatSigned(d.riskReversal, 2) : DASH, `Put IV at ${isFigure(d.putStrike) ? formatInt(d.putStrike) : DASH} minus call IV at ${isFigure(d.callStrike) ? formatInt(d.callStrike) : DASH}`), tile("Skew", d.skew ?? DASH, skewWord), tile("Expiry", d.expiry ?? DASH, d.underlying ?? "")),
        h("section", { class: "card" }, h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, "IV skew"), h("p", {}, "Implied volatility in percent by strike. The dashed vertical line is the at-the-money strike."))), h("div", { class: "card-body" }, callPutLegend(), lineChart(series, { label: `Call and put implied volatility by strike for ${d.underlying} ${d.expiry}`, marker: isFigure(d.atmStrike) ? { x: d.atmStrike, label: "ATM" } : null }))),
        dataDisclosure("Show as a table", [{ label: "Strike", cell: (r) => h("strong", {}, formatInt(r.strike)) }, { label: "Call IV %", num: true, cell: (r) => formatFixed(r.ceIv, 2) }, { label: "Put IV %", num: true, cell: (r) => formatFixed(r.peIv, 2) }], d.points),
      ];
    },
  });
  // The segmented control changes the request, so it reloads like any other control.
  mode.addEventListener("change", () => page.querySelector(".analytics-controls button")?.click());
  return page;
}

async function renderPayoff(H) {
  const legs = [];
  const blank = () => ({ type: "CE", side: "buy", strike: "", price: "", lots: "1", lotSize: "1" });
  const incoming = handoff.payoff;
  handoff.payoff = null;
  if (incoming?.legs?.length) legs.push(...incoming.legs.slice(0, 12).map((l) => ({ ...l })));
  else legs.push(blank());
  const legsBox = h("div", { class: "stack legs" });
  const out = h("div", { class: "stack", "aria-live": "polite" });
  const spot = h("input", { id: nextId("an-spot"), type: "number", inputmode: "decimal", step: "any", min: "0", placeholder: "Optional" });
  const presetNote = h("p", { class: "muted small", role: "status" });
  let ctl = null;

  const drawLegs = () => {
    legsBox.replaceChildren(
      ...legs.map((l, i) => {
        const bind = (el, key) => {
          el.addEventListener("input", () => {
            l[key] = el.value;
            if (key === "type") strike.disabled = l.type === "FUT";
          });
          return el;
        };
        const sel = (key, opts, label) => bind(h("select", { id: nextId("an-leg"), "aria-label": `Leg ${i + 1} ${label}` }, opts.map(([v, t]) => h("option", { value: v, selected: l[key] === v }, t))), key);
        const num = (key, label, props = {}) => bind(h("input", { id: nextId("an-leg"), type: "number", inputmode: "decimal", step: "any", min: "0", value: l[key], "aria-label": `Leg ${i + 1} ${label}`, ...props }), key);
        const type = sel("type", [["CE", "Call (CE)"], ["PE", "Put (PE)"], ["FUT", "Future"]], "type");
        const strike = num("strike", "strike");
        strike.disabled = l.type === "FUT";
        return h(
          "div",
          { class: "leg-row", role: "group", "aria-label": `Leg ${i + 1}` },
          H.field("Type", type),
          H.field("Side", sel("side", [["buy", "Buy"], ["sell", "Sell"]], "side")),
          H.field("Strike", strike),
          H.field("Price", num("price", "price")),
          H.field("Lots", num("lots", "lots", { step: "1", min: "1" })),
          H.field("Lot size", num("lotSize", "lot size", { step: "1", min: "1" })),
          h("button", { type: "button", class: "small leg-remove", "aria-label": `Remove leg ${i + 1}`, disabled: legs.length < 2, onclick: () => { legs.splice(i, 1); drawLegs(); } }, icon("close"), "Remove"),
        );
      }),
    );
  };

  const calculate = async () => {
    const parsed = legsToBody(legs, spot.value);
    if (!parsed.ok) {
      out.replaceChildren(H.errorBox({ title: "Check the legs", detail: parsed.errors.map((e) => e.message).join(" ") }));
      return;
    }
    out.replaceChildren(h("p", { class: "muted" }, "Calculating…"));
    try {
      const res = await api("/v1/analytics/payoff", { method: "POST", body: parsed.body });
      const d = res.data?.data ?? {};
      const curve = d.curve ?? [];
      if (!curve.length) {
        out.replaceChildren(calcStatus(), emptyState("chart", "Nothing to draw", "Give every leg a strike and a price."));
        return;
      }
      const money = (v, unbounded) => (unbounded ? "Unlimited" : isFigure(v) ? formatFixed(v, 2) : DASH);
      const credit = Number(d.netPremium) >= 0;
      out.replaceChildren(
        calcStatus(),
        tiles(
          tile("Max profit", money(d.maxProfit, d.unboundedProfit), "At expiry", d.unboundedProfit || Number(d.maxProfit) > 0 ? "up" : undefined),
          tile("Max loss", money(d.maxLoss, d.unboundedLoss), "At expiry", d.unboundedLoss || Number(d.maxLoss) < 0 ? "down" : undefined),
          tile(credit ? "Net credit" : "Net debit", isFigure(d.netPremium) ? formatFixed(Math.abs(d.netPremium), 2) : DASH, "Premium received minus paid"),
          tile("Break-evens", d.breakevens?.length ? d.breakevens.map((b) => formatFixed(b, 2)).join(", ") : "None", "Expiry prices where profit is zero"),
        ),
        h("section", { class: "card" }, h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, "Payoff at expiry"), h("p", {}, "Profit or loss in rupees against the underlying's price at expiry. Dots mark the break-evens."))), h("div", { class: "card-body" }, legend([{ cls: "profit", label: "Profit" }, { cls: "loss", label: "Loss" }]), payoffChart(curve, { breakevens: d.breakevens ?? [], spot: parsed.body.spot, label: `Strategy payoff at expiry. Max profit ${money(d.maxProfit, d.unboundedProfit)}, max loss ${money(d.maxLoss, d.unboundedLoss)}, break-evens ${d.breakevens?.length ? d.breakevens.join(", ") : "none"}.` }))),
        dataDisclosure("Show as a table", [{ label: "Price", num: true, cell: (r) => formatFixed(r.price, 2) }, { label: "Profit or loss", num: true, cell: (r) => formatSigned(r.pnl, 2) }], curve.filter((_, i) => i % 5 === 0)),
      );
    } catch (err) {
      out.replaceChildren(H.errorBox(err, { strike: "Strike", price: "Price", lots: "Lots", lotSize: "Lot size", spot: "Spot" }));
    }
  };

  const loadPreset = async (id) => {
    presetNote.textContent = "Pricing from the live chain…";
    try {
      const v = ctl.values();
      if (!v.expiry) throw new Error("There is no expiry to price from.");
      const res = await api(`/v1/optionchain?${q({ ...v, strikes: 6 })}`);
      const r = presetLegs(id, res.data?.data);
      if (r.error) {
        presetNote.textContent = r.error;
        return;
      }
      legs.splice(0, legs.length, ...r.legs);
      spot.value = String(res.data?.data?.underlyingLtp ?? "");
      presetNote.textContent = `Priced from ${v.underlying} ${v.expiry} (${freshnessLabel(res.data?.meta?.freshness).text})${app.state.demo ? ", demo data" : ""}.`;
      drawLegs();
      await calculate();
    } catch (err) {
      presetNote.textContent = "";
      out.replaceChildren(H.errorBox(err));
    }
  };

  ctl = chainControls(H, { onChange: () => {}, onError: (e) => out.replaceChildren(H.errorBox(e)), withStrikes: false });
  await ctl.init();
  if (incoming?.legs?.length) {
    spot.value = String(incoming.spot ?? "");
    presetNote.textContent = incoming.note ?? "";
  }
  drawLegs();
  const addLeg = h("button", { type: "button", class: "small", onclick: () => { if (legs.length < 12) legs.push(blank()); drawLegs(); } }, icon("plus"), "Add leg");
  const run = h("button", { type: "button", class: "primary", onclick: calculate }, icon("play"), "Draw payoff");
  if (incoming?.legs?.length) await calculate();
  return h(
    "div",
    { class: "stack" },
    h(
      "section",
      { class: "card" },
      h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, "Legs"), h("p", {}, "Build a strategy by hand, or fill it in from the live chain."))),
      h(
        "div",
        { class: "card-body stack" },
        h("div", { class: "row", role: "group", "aria-label": "Ready-made strategies" }, h("span", { class: "muted small" }, "Start from"), PRESETS.map((p) => h("button", { type: "button", class: "small example", onclick: () => loadPreset(p.id) }, p.label))),
        ctl.node,
        presetNote,
        legsBox,
        h("div", { class: "form-grid" }, H.field("Spot (for the marker)", spot, "Optional. Also sets the chart range."), h("div", { class: "field" }, h("span", { class: "pal-sr-only" }, "Actions"), h("div", { class: "row" }, addLeg, run))),
      ),
    ),
    out,
  );
}

async function renderCalculators(H) {
  const mkNum = (id, props = {}) => h("input", { id: nextId(id), type: "number", inputmode: "decimal", step: "any", ...props });
  // Greeks
  const g = { spot: mkNum("g-spot", {}), strike: mkNum("g-strike"), days: mkNum("g-days", { min: "0" }), iv: mkNum("g-iv", { min: "0" }), price: mkNum("g-price", { min: "0" }), rate: mkNum("g-rate", { min: "0", placeholder: "6.5" }) };
  const type = H.segmented("Option type", [["CE", "Call"], ["PE", "Put"]], "CE");
  const mode = H.segmented("Known value", [["iv", "I know the IV"], ["price", "I know the price"]], "iv");
  const ivField = H.field("IV (percent)", g.iv);
  const priceField = H.field("Option price", g.price);
  priceField.hidden = true;
  mode.addEventListener("change", () => {
    ivField.hidden = mode.value !== "iv";
    priceField.hidden = mode.value !== "price";
  });
  const gOut = h("div", { class: "stack", "aria-live": "polite" });
  const runG = async () => {
    const r = greeksQuery({ spot: g.spot.value, strike: g.strike.value, days: g.days.value, type: type.value, mode: mode.value, iv: g.iv.value, price: g.price.value, rate: g.rate.value });
    if (!r.ok) return gOut.replaceChildren(H.errorBox({ title: "Check the numbers", detail: r.error }));
    gOut.replaceChildren(h("p", { class: "muted" }, "Calculating…"));
    try {
      const d = (await api(`/v1/analytics/greeks?${r.query}`)).data?.data ?? {};
      gOut.replaceChildren(calcStatus(), tiles(tile("Delta", formatFixed(d.delta, 4), "Price change per 1 of spot"), tile("Gamma", formatFixed(d.gamma, 6), "Delta change per 1 of spot"), tile("Theta", formatFixed(d.theta, 4), "Per day"), tile("Vega", formatFixed(d.vega, 4), "Per 1 point of IV")), tiles(tile("IV", isFigure(d.ivPct) ? `${formatFixed(d.ivPct, 2)}%` : DASH, mode.value === "price" ? "Worked out from the price" : "As entered"), tile("Theoretical price", formatFixed(d.price, 2), "Black-Scholes"), tile("Days", formatFixed(d.daysToExpiry, 2), "To expiry"), tile("Rate", `${formatFixed(d.ratePct, 2)}%`, "Risk-free")));
    } catch (err) {
      gOut.replaceChildren(H.errorBox(err));
    }
  };
  // Position size
  const p = { capital: mkNum("p-cap", { min: "0" }), riskPct: mkNum("p-risk", { min: "0", max: "100", value: "1" }), entry: mkNum("p-entry", { min: "0" }), stop: mkNum("p-stop", { min: "0" }), lotSize: mkNum("p-lot", { step: "1", min: "1", value: "1" }), maxLots: mkNum("p-max", { step: "1", min: "0", placeholder: "No cap" }) };
  const pOut = h("div", { class: "stack", "aria-live": "polite" });
  const runP = async () => {
    const r = sizeBody(Object.fromEntries(Object.entries(p).map(([k, el]) => [k, el.value])));
    if (!r.ok) return pOut.replaceChildren(H.errorBox({ title: "Check the numbers", detail: r.error }));
    pOut.replaceChildren(h("p", { class: "muted" }, "Calculating…"));
    try {
      const d = (await api("/v1/analytics/position-size", { method: "POST", body: r.body })).data?.data ?? {};
      pOut.replaceChildren(
        calcStatus(),
        tiles(tile("Lots", formatInt(d.lots), d.note ?? (d.direction ? `A ${d.direction} trade` : "")), tile("Quantity", formatInt(d.quantity), "Units to trade"), tile("Capital at risk", isFigure(d.capitalAtRisk) ? formatFixed(d.capitalAtRisk, 2) : DASH, `Budget ${isFigure(d.riskAmount) ? formatFixed(d.riskAmount, 2) : DASH}`), tile("Notional", isFigure(d.notional) ? formatFixed(d.notional, 2) : DASH, `Risk per unit ${isFigure(d.riskPerUnit) ? formatFixed(d.riskPerUnit, 2) : DASH}`)),
      );
    } catch (err) {
      pOut.replaceChildren(H.errorBox(err));
    }
  };
  const form = (fields, onRun, label) => h("form", { class: "stack", novalidate: true, onsubmit: (e) => { e.preventDefault(); onRun(); } }, h("div", { class: "form-grid" }, fields), h("div", { class: "row" }, h("button", { type: "submit", class: "primary" }, icon("play"), label)));
  return h(
    "div",
    { class: "stack" },
    h("section", { class: "card" }, h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, "Greeks"), h("p", {}, "Black-Scholes delta, gamma, theta and vega for one option. Enter the IV, or the price to work the IV out."))), h("div", { class: "card-body stack" }, form([H.segField("Type", type), H.segField("Known value", mode), H.field("Spot", g.spot), H.field("Strike", g.strike), H.field("Days to expiry", g.days), ivField, priceField, H.field("Rate (percent)", g.rate, "Empty uses 6.5")], runG, "Calculate Greeks"), gOut)),
    h("section", { class: "card" }, h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, "Position size"), h("p", {}, "How many lots to trade so that hitting your stop loses only the share of capital you chose."))), h("div", { class: "card-body stack" }, form([H.field("Capital", p.capital), H.field("Risk per trade (percent)", p.riskPct), H.field("Entry price", p.entry), H.field("Stop price", p.stop), H.field("Lot size", p.lotSize), H.field("Max lots", p.maxLots)], runP, "Work out lots"), pOut)),
  );
}

/**
 * The Analytics page group for views.js. `getHelpers()` returns { segmented, segField, field, errorBox } and runs
 * when a page is drawn, never at import.
 */
export function analyticsPages(getHelpers) {
  const group = "Analytics";
  return [
    { id: "chain", label: "Option chain", icon: "list", tint: "blue", group, title: "Option chain", sub: "Calls, puts, OI and IV across strikes for one expiry", render: () => renderChain(getHelpers()) },
    { id: "oi", label: "OI and PCR", icon: "chart", tint: "orange", group, title: "OI and PCR", sub: "Open interest by strike, put-call ratio and max pain", render: () => renderOi(getHelpers()) },
    { id: "gex", label: "Gamma exposure", icon: "bolt", tint: "purple", group, title: "Gamma exposure", sub: "Dealer gamma by strike and the flip strike", render: () => renderGex(getHelpers()) },
    { id: "skew", label: "IV skew", icon: "activity", tint: "teal", group, title: "IV skew and surface", sub: "Implied volatility by strike and across expiries", render: () => renderSkew(getHelpers()) },
    { id: "payoff", label: "Strategy payoff", icon: "orders", tint: "indigo", group, title: "Strategy payoff", sub: "Build a multi-leg strategy and see profit, loss and break-evens at expiry", render: () => renderPayoff(getHelpers()) },
    { id: "calculators", label: "Calculators", icon: "limits", tint: "mint", group, title: "Calculators", sub: "Option Greeks and position size", render: () => renderCalculators(getHelpers()) },
  ];
}
