// The Volatility page's two curves: the smile (IV by strike, moneyness or delta) and the term structure (ATM IV by
// expiry). Purpose-built SVG, no chart library: the owner's chart engine is for price/time charts, not these.
//
// smileChart(host) / termChart(host) are persistent: the layers are built once and update() patches them, so a refresh,
// a range or series change, an axis change or a new expiry animates (docs/design/vol.md §4.0, §8) instead of snapping.
// smileSvg / termSvg stay as one-shot wrappers (create + update once) for callers that want a detached <svg>.
// Colours are foundation tokens only (app.css §12v): violet IV, call blue / put orange, the contrast ATM pill.
import { DASH, formatFixed, formatInt, formatPercent } from "./format.js";
import { lineReveal, reducedMotion } from "./motion.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const r1 = (v) => Math.round(v * 10) / 10;
const minus = (t) => String(t).replace(/^-/, "−");
function s(tag, attrs, ...children) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== undefined && v !== null && v !== false) e.setAttribute(k, String(v));
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
function hd(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
/** Set an attribute only when it changes (a refresh that changes nothing touches nothing). */
function setA(el, k, v) {
  if (v === null || v === undefined) {
    if (el.hasAttribute(k)) el.removeAttribute(k);
    return;
  }
  const t = String(v);
  if (el.getAttribute(k) !== t) el.setAttribute(k, t);
}
function setT(el, t) {
  if (el.textContent !== t) el.textContent = t;
}
function setStyle(el, k, v) {
  if (el.style[k] !== v) el.style[k] = v;
}
const show = (el, on) => setA(el, "visibility", on ? null : "hidden");

/** Round axis values (1, 2, 2.5 or 5 × 10^n) covering [lo, hi]. */
function niceTicks(lo, hi, count) {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / Math.max(1, count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : Math.round(v / step) * step);
  out.step = step;
  return out;
}
/** Decimals that print a tick step exactly (2.5 -> 1, 0.25 -> 2, 5 -> 0). */
function stepDecimals(step) {
  for (let d = 0; d < 4; d++) {
    const x = step * 10 ** d;
    if (Math.abs(x - Math.round(x)) < 1e-6) return d;
  }
  return 4;
}
/** IV axis: padding max(1 vol pt, 8 % of the span) above and below, 4–6 ticks. */
function ivAxis(ys) {
  const a = Math.min(...ys);
  const b = Math.max(...ys);
  const pad = Math.max(1, (b - a) * 0.08);
  const lo = a - pad;
  const hi = b + pad;
  const t = niceTicks(lo, hi, 5);
  const dp = stepDecimals(t.step);
  return { ticks: t.filter((v) => v >= lo - 1e-9 && v <= hi + 1e-9), y0: lo, y1: hi, label: (v) => `${formatFixed(v, dp)}%` };
}

// ── Motion: a cubic-bezier tween in pixel space, matched by key (docs/design/vol.md §8) ──

function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const fx = (t) => ((ax * t + bx) * t + cx) * t;
  const dfx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const d = dfx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= (fx(t) - x) / d;
    }
    t = Math.max(0, Math.min(1, t));
    return ((ay * t + by) * t + cy) * t;
  };
}
const EASE_STD = bezier(0.2, 0, 0, 1);
export const DUR = Object.freeze({ d1: 120, d2: 200, d3: 320, d4: 600 });
const raf = (fn) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : setTimeout(() => fn(Date.now()), 16));
const caf = (id) => (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id));
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * Interpolate series of keyed points: `from` / `to` are { name: [{ k, x, y, brk? }] }. A point in `to` without a match
 * in `from` starts at its target; the result keeps `to`'s order and breaks. Pure.
 */
export function lerpSeries(from, to, t) {
  const out = {};
  for (const [name, list] of Object.entries(to)) {
    const prev = new Map((from?.[name] ?? []).map((p) => [p.k, p]));
    out[name] = list.map((p) => {
      const q = prev.get(p.k);
      return q ? { ...p, x: q.x + (p.x - q.x) * t, y: q.y + (p.y - q.y) * t } : p;
    });
  }
  return out;
}

/**
 * Tween keyed series from → to over `ms` with the standard easing, calling onFrame(state) each frame and once more at
 * the end with `to` itself. Reduced motion or ms ≤ 0: one synchronous onFrame(to). Returns { cancel(), current() }.
 */
export function tweenPoints(from, to, ms, onFrame) {
  let state = from ?? to;
  if (!from || ms <= 0 || reducedMotion()) {
    onFrame(to);
    return { cancel() {}, current: () => to };
  }
  const t0 = now();
  let id = 0;
  let done = false;
  const step = () => {
    const k = Math.min(1, (now() - t0) / ms);
    state = k >= 1 ? to : lerpSeries(from, to, EASE_STD(k));
    onFrame(state);
    if (k < 1) id = raf(step);
    else done = true;
  };
  step();
  return {
    cancel() {
      if (!done) caf(id);
      done = true;
    },
    current: () => state,
  };
}

/** First-draw reveal (motion.js lineReveal); the fade class comes off afterwards so a later re-display never replays it. */
function reveal(lines, areas) {
  lineReveal(lines, areas);
  setTimeout(() => {
    for (const el of [...lines, ...areas]) el.classList.remove("dv-area-in");
  }, DUR.d1 + DUR.d3 + 80);
}

/** Path data for keyed points, a new sub-path at every break. */
function pathD(list) {
  let d = "";
  list.forEach((p, i) => (d += `${!i || p.brk ? "M" : "L"}${r1(p.x)} ${r1(p.y)}`));
  return d;
}
/** The area under each sub-path down to `base`. */
function areaD(list, base) {
  let d = "";
  let seg = [];
  const flush = () => {
    if (seg.length > 1) d += `M${r1(seg[0].x)} ${r1(base)}${seg.map((p) => `L${r1(p.x)} ${r1(p.y)}`).join("")}L${r1(seg[seg.length - 1].x)} ${r1(base)}Z`;
    seg = [];
  };
  for (const p of list) {
    if (p.brk) flush();
    seg.push(p);
  }
  flush();
  return d;
}
/** The band between two keyed series (bid IV below, ask IV above), broken wherever either side is missing. */
function ribbonD(lower, upper) {
  const lo = new Map(lower.map((p) => [p.k, p]));
  let d = "";
  let seg = [];
  const flush = () => {
    if (seg.length > 1) d += `M${seg.map(([u]) => `${r1(u.x)} ${r1(u.y)}`).join("L")}L${[...seg].reverse().map(([, l]) => `${r1(l.x)} ${r1(l.y)}`).join("L")}Z`;
    seg = [];
  };
  for (const u of upper) {
    const l = lo.get(u.k);
    if (u.brk || !l) flush();
    if (l) seg.push([u, l]);
  }
  flush();
  return d;
}

/**
 * Direct labels in a right-hand gutter: [{ y, text, cls, px, py }] pushed apart to `gap` px inside [top, bottom]. When
 * the OTM / CE / PE ends sit within `gap` of each other they merge into one label ("OTM · CE · PE"). Pure layout.
 */
export function layoutEndLabels(list, { top, bottom, gap = 11 }) {
  let ls = list.filter(Boolean).map((l) => ({ ...l, ly: l.y }));
  const trio = ls.filter((l) => ["otm", "ce", "pe"].includes(l.cls));
  if (trio.length > 1 && Math.max(...trio.map((l) => l.y)) - Math.min(...trio.map((l) => l.y)) < gap) {
    const keep = trio.find((l) => l.cls === "otm") ?? trio[0];
    ls = [...ls.filter((l) => !trio.includes(l)), { ...keep, cls: "merged", text: trio.map((l) => l.text).join(" · ") }];
  }
  ls.sort((a, b) => a.ly - b.ly);
  for (let i = 0; i < ls.length; i++) ls[i].ly = Math.max(ls[i].ly, top, i ? ls[i - 1].ly + gap : -Infinity);
  const over = ls.length ? ls[ls.length - 1].ly - bottom : 0;
  if (over > 0) {
    ls[ls.length - 1].ly -= over;
    for (let i = ls.length - 2; i >= 0; i--) ls[i].ly = Math.min(ls[i].ly, ls[i + 1].ly - gap);
  }
  return ls;
}

/** Delta-axis ticks: [x, label]; x = 1 − call delta, so puts sit on the left as on the strike axis. */
const DELTA_TICKS = [[0.1, "10ΔP"], [0.25, "25ΔP"], [0.5, "50Δ"], [0.75, "25ΔC"], [0.9, "10ΔC"]];

/** Where a point sits on the chosen axis (null when it has no position there). */
export function smileX(p, axis) {
  if (axis === "m") return p.m;
  if (axis === "delta") return p.callDelta === null || p.callDelta === undefined ? null : 1 - p.callDelta;
  return p.strike;
}

/** Text width estimate (px) for the 11 px numeric face; measured when the node is laid out. */
function textW(t, el) {
  try {
    const w = el?.getComputedTextLength?.();
    if (w) return w;
  } catch {
    /* not laid out */
  }
  return String(t).length * 6.3;
}

/** A pill: <g> with a rect and centred text, moved with a transform (so it slides). Returns the g. */
function pillNode(cls) {
  return s("g", { class: `vol-pill ${cls}`, "aria-hidden": "true" }, s("rect", { rx: 9, ry: 9, height: 18, y: 0 }), s("text", { "text-anchor": "middle", y: 12.5 }));
}
/** Place a pill centred on x at y, clamped to [lo, hi]; returns [left, right]. */
function placePill(g, x, y, text, lo, hi) {
  const [rect, t] = g.children;
  setT(t, text);
  const w = Math.round(textW(text, t) + 14);
  const left = Math.max(lo, Math.min(hi - w, x - w / 2));
  setA(rect, "width", w);
  setA(t, "x", r1(w / 2));
  setStyle(g, "transform", `translate(${r1(left)}px, ${r1(y)}px)`);
  return [left, left + w];
}

/** Position the floating tooltip beside (sx, sy) in SVG units, flipped left near the right edge, kept in the plot. */
function placeTip(tip, svg, W, sx, sy, { left, right, top, bottom }) {
  const hb = tip.parentNode?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
  const sb = svg.getBoundingClientRect();
  const k = sb.width && W ? sb.width / W : 1;
  const ox = sb.left - hb.left;
  const oy = sb.top - hb.top;
  const tw = tip.offsetWidth || 180;
  const th = tip.offsetHeight || 80;
  let x = ox + sx * k + 12;
  if (x + tw > ox + right * k) x = ox + sx * k - 12 - tw;
  x = Math.max(ox + left * k - 36, x);
  let y = oy + sy * k - th / 2;
  y = Math.max(oy + top * k, Math.min(oy + bottom * k - th, y));
  setStyle(tip, "transform", `translate(${Math.round(x)}px, ${Math.round(y)}px)`);
}

/**
 * Pointer, touch and keyboard plumbing shared by both charts. nearest(svgX) -> index | null. Mouse moves hover; a touch
 * drag of more than 8 px sideways scrubs (vertical drags still scroll the page: touch-action pan-y); a tap or click
 * picks; arrow keys step (Shift ×10), Home / End, Enter picks, Esc clears.
 */
function wirePointer(svg, W, { nearest, count, current, onHover, onLeave, onPick, onScrubEnd, onKey }) {
  let touch = null;
  let swallowClick = false;
  const svgX = (e) => {
    const b = svg.getBoundingClientRect();
    return b.width ? ((e.clientX - b.left) / b.width) * W() : null;
  };
  const at = (e) => {
    const x = svgX(e);
    return x === null ? null : nearest(x);
  };
  svg.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") {
      if (!touch || touch.id !== e.pointerId) return;
      const dx = e.clientX - touch.x;
      const dy = e.clientY - touch.y;
      if (!touch.scrub && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
        touch.scrub = true;
        try {
          svg.setPointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
      }
      if (touch.scrub) onHover(at(e), "scrub");
      return;
    }
    onHover(at(e), "hover");
  });
  svg.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") touch = { id: e.pointerId, x: e.clientX, y: e.clientY, scrub: false };
  });
  const endTouch = (e, cancel) => {
    if (!touch || touch.id !== e.pointerId) return;
    if (touch.scrub && !cancel) {
      swallowClick = true;
      setTimeout(() => (swallowClick = false), 400);
      onScrubEnd(at(e));
    }
    touch = null;
  };
  svg.addEventListener("pointerup", (e) => endTouch(e, false));
  svg.addEventListener("pointercancel", (e) => endTouch(e, true));
  svg.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse") onLeave();
  });
  svg.addEventListener("click", (e) => {
    if (swallowClick) return;
    onPick(at(e));
  });
  svg.addEventListener("keydown", (e) => {
    const n = count();
    if (!n) return;
    let i = current();
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") i = (i < 0 ? Math.floor(n / 2) : i + (e.key === "ArrowRight" ? step : -step));
    else if (e.key === "Home") i = 0;
    else if (e.key === "End") i = n - 1;
    else if (e.key === "Enter" || e.key === " ") {
      if (i < 0) return;
      e.preventDefault();
      e.stopPropagation();
      return onKey(i, "pin");
    } else if (e.key === "Escape") {
      if (i < 0) return;
      e.preventDefault();
      e.stopPropagation();
      return onKey(-1, "clear");
    } else return;
    e.preventDefault();
    e.stopPropagation();
    onKey(Math.max(0, Math.min(n - 1, i)), "move");
  });
}

// ── The smile ──

let gid = 0;
const SERIES_NAMES = { otm: "OTM", ce: "CE", pe: "PE" };

/**
 * The persistent smile chart in `host` (a positioned box).
 * update(data, o): data = { key, points, step, atmStrike, markers: { F, lo, hi, lo2, hi2, spot } (each { strike, m,
 *   delta }), pills: { atm, spot, f, band }, skewTicks: [{ pos, label, side }], compare: { points, label } | null,
 *   oi: [{ strike, ce, pe }] | null }
 * o = { x, series: { otm, ce, pe, ba, oi }, width, height, coarse, docked, dock, label, empty, banners: string[],
 *   onPick(strike, how), tip(point, { cmpIv }) -> Node[] }
 * Returns { svg, update, mark(strike), destroy() }.
 */
export function smileChart(host, init = {}) {
  const id = ++gid;
  const svg = s("svg", { class: "vol-svg smile", role: "img", tabindex: "0", focusable: "true", "aria-label": init.label ?? "Smile" });
  const grad = s("linearGradient", { id: `vol-ivf-${id}`, x1: 0, x2: 0, y1: 0, y2: 1, gradientUnits: "userSpaceOnUse" }, s("stop", { class: "ivf-a", offset: "0" }), s("stop", { class: "ivf-b", offset: "1" }));
  const band2 = s("rect", { class: "band2", x: 0, width: 1 });
  const band = s("rect", { class: "band", x: 0, width: 1 });
  const edgeL = s("line", { class: "band-edge", x1: 0, x2: 0 });
  const edgeR = s("line", { class: "band-edge", x1: 0, x2: 0 });
  const bandLabel = s("text", { class: "band-label", "text-anchor": "start" });
  const gGrid = s("g", { class: "grid" });
  const gX = s("g", { class: "xaxis" });
  const yTitle = s("text", { class: "axis-title", x: 4, y: 12 }, "IV %");
  const gSkew = s("g", { class: "skew-ticks" });
  const area = s("path", { class: "area", fill: `url(#vol-ivf-${id})` });
  const ribbon = s("path", { class: "ribbon" });
  const P = { cmp: s("path", { class: "series compare" }), ce: s("path", { class: "series ce" }), pe: s("path", { class: "series pe" }), otm: s("path", { class: "series otm" }) };
  const gDots = s("g", { class: "dots" });
  const dotG = { ce: s("g", { class: "dots-ce" }), pe: s("g", { class: "dots-pe" }), otm: s("g", { class: "dots-otm" }) };
  gDots.append(dotG.ce, dotG.pe, dotG.otm);
  const fLine = s("line", { class: "f-line" });
  const fLabel = s("text", { class: "f-label", "text-anchor": "start" });
  const spotLine = s("line", { class: "spot-line" });
  const atmPill = pillNode("atm");
  const spotPill = pillNode("spot");
  const gOi = s("g", { class: "oi-strip" });
  const gLabels = s("g", { class: "end-labels" });
  const hlV = s("line", { class: "hl-line" });
  const hlH = s("line", { class: "hl-line" });
  const hlRing = s("circle", { class: "hl-ring" });
  const yChip = pillNode("ychip");
  const empty = s("text", { class: "vol-svg-empty", "text-anchor": "middle" });
  svg.append(s("defs", {}, grad), band2, band, edgeL, edgeR, gGrid, gX, yTitle, area, ribbon, P.cmp, P.ce, P.pe, P.otm, gDots, gSkew, fLine, spotLine, fLabel, bandLabel, gOi, gLabels, hlV, hlH, hlRing, yChip, atmPill, spotPill, empty);
  const tip = hd("div", "vol-tip");
  tip.setAttribute("aria-hidden", "true");
  const banners = hd("div", "vol-plot-banners");
  host.append(svg, tip, banners);

  let G = null; // the target geometry of the last update
  let O = init;
  let sig = "";
  let shown = null; // the series as drawn now (mid-tween included)
  let tw = null;
  let marked = null;
  let destroyed = false;
  const yTicks = new Map(); // value -> g
  const xLabels = new Map(); // key -> text
  const dots = new Map(); // series:k -> circle
  const labels = new Map(); // cls -> text

  function frame(st) {
    shown = st;
    if (!G) return;
    for (const k of ["cmp", "ce", "pe", "otm"]) setA(P[k], "d", st[k]?.length ? pathD(st[k]) : null);
    setA(area, "d", st.otm?.length ? areaD(st.otm, G.plotB) : null);
    setA(ribbon, "d", st.ask?.length && st.bid?.length ? ribbonD(st.bid, st.ask) : null);
    for (const name of ["otm", "ce", "pe"]) {
      for (const p of st[name] ?? []) {
        const c = dots.get(`${name}:${p.k}`);
        if (!c) continue;
        setA(c, "cx", r1(p.x));
        setA(c, "cy", r1(p.y));
      }
    }
  }

  function layout(data, o) {
    const W = Math.max(240, Math.round(o.width));
    const H = Math.max(160, Math.round(o.height));
    const axis = o.x;
    const on = o.series ?? {};
    const keys = ["otm", "ce", "pe"].filter((k) => on[k]);
    const pts = (data.points ?? []).filter((p) => smileX(p, axis) !== null);
    const val = (p, k) => (k === "otm" ? p.otm?.iv ?? null : p[k]?.iv ?? null);
    const comp = (data.compare?.points ?? []).filter((p) => p.otm && smileX(p, axis) !== null);
    const baOn = Boolean(on.ba);
    const baLeg = (p) => (p.otm ? p[p.otm.side] : null);
    const ys = [...pts.flatMap((p) => keys.map((k) => val(p, k))), ...comp.map((p) => p.otm.iv), ...(baOn ? pts.flatMap((p) => [baLeg(p)?.bidIv, baLeg(p)?.askIv]) : [])].filter((v) => v !== null && v !== undefined && v > 0 && v < 300);
    const oiOn = Boolean(on.oi) && Array.isArray(data.oi) && data.oi.length > 0;
    const labelled = keys.length > 1 || comp.length > 0;
    const L = 40;
    const R = labelled ? 44 : 14;
    const T = 26;
    const B = 24 + (oiOn ? 30 : 0);
    const plotB = H - B;
    if (!ys.length) return { W, H, L, R, T, B, plotB, ok: false };
    const xs = [...pts, ...comp].map((p) => smileX(p, axis));
    let x0 = Math.min(...xs);
    let x1 = Math.max(...xs);
    if (axis === "delta") {
      x0 = Math.min(x0, 0.05);
      x1 = Math.max(x1, 0.95);
    }
    if (x1 === x0) x1 = x0 + 1;
    const ya = ivAxis(ys);
    const X = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R);
    const Y = (v) => T + (1 - (v - ya.y0) / (ya.y1 - ya.y0)) * (plotB - T);
    const step = data.step ?? null;
    const series = (list, get, sKey = (p) => p.strike) => {
      const out = [];
      let prev = null;
      for (const p of list) {
        const v = get(p);
        if (v === null || v === undefined || !(v > 0)) {
          continue;
        }
        const gap = Boolean(prev && step && p.strike - prev.strike > 2 * step + 1e-9);
        out.push({ k: sKey(p), x: X(smileX(p, axis)), y: Y(v), brk: !prev || gap });
        prev = p;
      }
      return out;
    };
    const st = {};
    for (const k of ["otm", "ce", "pe"]) st[k] = on[k] ? series(pts, (p) => val(p, k)) : [];
    st.cmp = comp.length ? series(comp, (p) => p.otm.iv) : [];
    st.bid = baOn ? series(pts, (p) => baLeg(p)?.bidIv) : [];
    st.ask = baOn ? series(pts, (p) => baLeg(p)?.askIv) : [];
    // X ticks: 4–9 by width; the Delta axis has fixed ticks.
    const n = Math.max(4, Math.min(9, Math.floor((W - L - R) / 70)));
    const xt = axis === "delta" ? null : niceTicks(x0, x1, n);
    const xdp = xt ? stepDecimals(xt.step) : 0;
    const xticks =
      axis === "delta"
        ? DELTA_TICKS.filter(([v]) => v >= x0 && v <= x1)
        : xt.filter((v) => v > x0 && v < x1).map((v) => [v, axis === "m" ? `${v > 0 ? "+" : ""}${minus(formatFixed(v, xdp))}%` : formatFixed(v, xdp)]);
    const at = (m) => (m ? (axis === "m" ? m.m : axis === "delta" ? m.delta : m.strike) : null);
    const byK = new Map(pts.map((p) => [p.strike, p]));
    return { W, H, L, R, T, B, plotB, ok: true, axis, keys, pts, comp, X, Y, x0, x1, ya, st, xticks, at, labelled, oiOn, byK, val };
  }

  function update(data, o) {
    if (destroyed) return false;
    const nsig = JSON.stringify([data, { ...o, onPick: null, tip: null, dock: null }]);
    if (nsig === sig) return false;
    sig = nsig;
    const prevG = G;
    O = o;
    G = layout(data, o);
    G.data = data;
    const { W, H, L, R, T, plotB } = G;
    setA(svg, "viewBox", `0 0 ${W} ${H}`);
    setA(svg, "width", W);
    setA(svg, "height", H);
    setA(svg, "aria-label", o.label);
    const reduced = reducedMotion();
    svg.classList.toggle("anim", Boolean(prevG?.ok) && !reduced);
    // Banners inside the plot top (no live bid / ask, expiry day).
    const bsig = (o.banners ?? []).join("|");
    if (banners.__sig !== bsig) {
      banners.__sig = bsig;
      banners.replaceChildren(...(o.banners ?? []).map((b) => Object.assign(hd("p", "vol-plot-banner"), { textContent: b })));
    }
    banners.style.top = `${Math.round(T + 4)}px`;
    if (!G.ok) {
      for (const el of [band, band2, edgeL, edgeR, bandLabel, fLine, fLabel, spotLine, atmPill, spotPill, area, ribbon, yTitle, ...Object.values(P)]) show(el, false);
      gGrid.replaceChildren();
      gX.replaceChildren();
      for (const g of Object.values(dotG)) g.replaceChildren();
      gSkew.replaceChildren();
      gOi.replaceChildren();
      gLabels.replaceChildren();
      yTicks.clear();
      xLabels.clear();
      dots.clear();
      labels.clear();
      setT(empty, o.empty ?? "No IV to plot");
      setA(empty, "x", W / 2);
      setA(empty, "y", H / 2);
      show(empty, true);
      shown = null;
      tw?.cancel();
      mark(null);
      return true;
    }
    show(empty, false);
    for (const el of [area, ribbon, yTitle, ...Object.values(P)]) show(el, true);
    const { X, Y, ya, at } = G;

    // Y grid + ticks, keyed by value: they slide to the new scale (CSS transform transition) and fade in / out.
    const keep = new Set();
    for (const v of ya.ticks) {
      const key = formatFixed(v, 3);
      keep.add(key);
      let g = yTicks.get(key);
      if (!g) {
        g = s("g", { class: "ytick" }, s("line", { x1: L, y1: 0, y2: 0 }), s("text", { class: "axis", x: L - 6, y: 3.5, "text-anchor": "end" }));
        if (svg.classList.contains("anim") && prevG?.ok) {
          // Enter from where the old scale had it, then slide.
          const oy = prevG.Y(v);
          g.style.transform = `translateY(${r1(Math.max(T - 10, Math.min(plotB + 10, oy)))}px)`;
          g.style.opacity = "0";
          gGrid.append(g);
          void g.getBoundingClientRect();
        } else gGrid.append(g);
        yTicks.set(key, g);
      }
      setA(g.children[0], "x1", L);
      setA(g.children[0], "x2", W - R);
      setA(g.children[1], "x", L - 6);
      setT(g.children[1], ya.label(v));
      setStyle(g, "transform", `translateY(${r1(Y(v))}px)`);
      setStyle(g, "opacity", "1");
    }
    for (const [key, g] of yTicks) {
      if (keep.has(key)) continue;
      yTicks.delete(key);
      const v = Number(key);
      if (svg.classList.contains("anim")) {
        g.style.transform = `translateY(${r1(Math.max(T - 10, Math.min(plotB + 10, Y(v))))}px)`;
        g.style.opacity = "0";
        setTimeout(() => g.remove(), DUR.d3 + 20);
      } else g.remove();
    }

    // X labels keyed by axis + text: an axis change cross-fades (old out, new in).
    const xkeep = new Set();
    for (const [v, t] of G.xticks) {
      const key = `${G.axis}|${t}`;
      xkeep.add(key);
      let el = xLabels.get(key);
      if (!el) {
        el = s("text", { class: "axis xlab", y: 0, "text-anchor": "middle" }, t);
        if (svg.classList.contains("anim")) {
          el.style.opacity = "0";
          el.style.transform = `translate(${r1(X(v))}px, ${r1(plotB + 17)}px)`;
          gX.append(el);
          void el.getBoundingClientRect();
        } else gX.append(el);
        xLabels.set(key, el);
      }
      setStyle(el, "transform", `translate(${r1(X(v))}px, ${r1(plotB + 17)}px)`);
      setStyle(el, "opacity", "1");
    }
    for (const [key, el] of xLabels) {
      if (xkeep.has(key)) continue;
      xLabels.delete(key);
      if (svg.classList.contains("anim")) {
        el.classList.add("out");
        el.style.opacity = "0";
        setTimeout(() => el.remove(), DUR.d1 + 40);
      } else el.remove();
    }

    // ±1σ / ±2σ bands, F line, spot, pills.
    const mk = data.markers ?? {};
    const span = (a, b) => {
      const pa = at(a);
      const pb = at(b);
      if (pa === null || pb === null || !Number.isFinite(pa) || !Number.isFinite(pb)) return null;
      const lo = Math.max(G.x0, Math.min(pa, pb));
      const hi = Math.min(G.x1, Math.max(pa, pb));
      return hi > lo ? [X(lo), X(hi)] : null;
    };
    const placeBand = (rect, sp) => {
      show(rect, Boolean(sp));
      if (!sp) return;
      setA(rect, "y", T);
      setA(rect, "height", r1(plotB - T));
      setStyle(rect, "transform", `translateX(${r1(sp[0])}px) scaleX(${r1(Math.max(0.5, sp[1] - sp[0]))})`);
    };
    const b1 = span(mk.lo, mk.hi);
    placeBand(band, b1);
    placeBand(band2, span(mk.lo2, mk.hi2));
    for (const [el, xx] of [[edgeL, b1?.[0]], [edgeR, b1?.[1]]]) {
      show(el, xx !== undefined);
      if (xx === undefined) continue;
      setA(el, "y1", T);
      setA(el, "y2", plotB);
      setStyle(el, "transform", `translateX(${r1(xx)}px)`);
    }
    show(bandLabel, Boolean(b1));
    if (b1) {
      const full = data.pills?.band ?? "±1σ";
      const fits = textW(full, null) + 8 <= b1[1] - b1[0];
      setT(bandLabel, fits ? full : "±1σ");
      setStyle(bandLabel, "transform", `translate(${r1(b1[0] + 5)}px, ${r1(T + 12)}px)`);
    }
    const fx = at(mk.F);
    const fOk = fx !== null && Number.isFinite(fx) && fx >= G.x0 && fx <= G.x1;
    show(fLine, fOk);
    show(fLabel, fOk && Boolean(data.pills?.f));
    show(atmPill, fOk && Boolean(data.pills?.atm));
    let atmSpan = null;
    if (fOk) {
      const x = X(fx);
      setA(fLine, "y1", T - 4);
      setA(fLine, "y2", plotB);
      setStyle(fLine, "transform", `translateX(${r1(x)}px)`);
      setT(fLabel, data.pills?.f ?? "");
      const fw = textW(data.pills?.f ?? "", fLabel);
      const right = x + 4 + fw < W - R;
      const fa = right ? x + 4 : x - 4 - fw;
      const hit = G.axis !== "delta" && (data.skewTicks ?? []).some((t) => {
        const v = at(t.pos);
        if (v === null || !Number.isFinite(v)) return false;
        const sx = X(v);
        return sx + 16 > fa - 2 && sx - 16 < fa + fw + 2;
      });
      // A 25Δ / 10Δ label under it wins (the ATM pill and the Forward tile still give F).
      if (hit) show(fLabel, false);
      setA(fLabel, "text-anchor", right ? "start" : "end");
      setStyle(fLabel, "transform", `translate(${r1(right ? x + 4 : x - 4)}px, ${r1(plotB - 5)}px)`);
      if (data.pills?.atm) atmSpan = placePill(atmPill, x, 2, data.pills.atm, 2, W - 2);
    }
    const sx = at(mk.spot);
    const sOk = sx !== null && Number.isFinite(sx) && sx >= G.x0 && sx <= G.x1 && Boolean(data.pills?.spot);
    show(spotLine, sOk);
    show(spotPill, sOk);
    if (sOk) {
      const x = X(sx);
      setA(spotLine, "y1", T - 4);
      setA(spotLine, "y2", plotB);
      setStyle(spotLine, "transform", `translateX(${r1(x)}px)`);
      const [a, b] = placePill(spotPill, x, 2, data.pills.spot, 2, W - 2);
      // Collides with the ATM pill: drop one row.
      if (atmSpan && a < atmSpan[1] + 4 && b > atmSpan[0] - 4) placePill(spotPill, x, 22, data.pills.spot, 2, W - 2);
    }

    // 25Δ / 10Δ ticks on the Strike and Mny axes (the Delta axis has them as its ticks).
    const sk = G.axis === "delta" ? [] : (data.skewTicks ?? []).filter((t) => {
      const v = at(t.pos);
      return v !== null && Number.isFinite(v) && v >= G.x0 && v <= G.x1;
    });
    const sksig = JSON.stringify(sk.map((t) => [t.label, r1(X(at(t.pos)))]).concat([plotB]));
    if (gSkew.__sig !== sksig) {
      gSkew.__sig = sksig;
      gSkew.replaceChildren(
        ...sk.map((t) => {
          const x = r1(X(at(t.pos)));
          return s("g", { class: `skew ${t.side}` }, s("line", { x1: x, x2: x, y1: plotB, y2: plotB - 6 }), s("text", { x, y: plotB - 9, "text-anchor": "middle" }, t.label));
        }),
      );
    }

    // OI strip under the x axis: calls up, puts down from a midline, the largest at full strength.
    const oisig = G.oiOn ? JSON.stringify([G.axis, W, H, data.oi]) : "";
    if (gOi.__sig !== oisig) {
      gOi.__sig = oisig;
      const kids = [];
      if (G.oiOn) {
        const mid = plotB + 24 + 15;
        const rows = data.oi.filter((r) => G.byK.has(r.strike));
        const max = Math.max(1, ...rows.flatMap((r) => [r.ce ?? 0, r.pe ?? 0]));
        const xsx = rows.map((r) => X(smileX(G.byK.get(r.strike), G.axis))).sort((a, b) => a - b);
        let gap = Infinity;
        for (let i = 1; i < xsx.length; i++) gap = Math.min(gap, xsx[i] - xsx[i - 1]);
        const bw = Math.max(1.5, Math.min(8, (Number.isFinite(gap) ? gap : 10) * 0.6));
        const maxCe = Math.max(0, ...rows.map((r) => r.ce ?? 0));
        const maxPe = Math.max(0, ...rows.map((r) => r.pe ?? 0));
        kids.push(s("line", { class: "oi-mid", x1: L, x2: W - R, y1: mid, y2: mid }));
        for (const r of rows) {
          const x = X(smileX(G.byK.get(r.strike), G.axis));
          const hc = r.ce > 0 ? Math.max(1, (r.ce / max) * 13) : 0;
          const hp = r.pe > 0 ? Math.max(1, (r.pe / max) * 13) : 0;
          if (hc) kids.push(s("rect", { class: `oi-bar call${r.ce === maxCe ? " max" : ""}`, x: r1(x - bw / 2), y: r1(mid - hc), width: r1(bw), height: r1(hc), rx: 1 }));
          if (hp) kids.push(s("rect", { class: `oi-bar put${r.pe === maxPe ? " max" : ""}`, x: r1(x - bw / 2), y: mid, width: r1(bw), height: r1(hp), rx: 1 }));
        }
        kids.push(s("text", { class: "oi-cap", x: 4, y: mid - 3 }, "OI CE"), s("text", { class: "oi-cap", x: 4, y: mid + 9 }, "PE"));
      }
      gOi.replaceChildren(...kids);
    }

    // Gradient under the OTM line: from the curve's top to the plot bottom.
    const tops = G.st.otm.map((p) => p.y);
    setA(grad, "y1", r1(tops.length ? Math.min(...tops) : T));
    setA(grad, "y2", r1(plotB));

    // Dots: OTM filled by its pricing side (put left of F, call right), hollow from a wide quote or the LTP.
    const r = o.coarse ? 3.5 : 2.5;
    const dkeep = new Set();
    for (const k of ["otm", "ce", "pe"]) {
      for (const p of G.pts) {
        const v = G.val(p, k);
        if (v === null || !G.keys.includes(k) || !(v > 0)) continue;
        const key = `${k}:${p.strike}`;
        dkeep.add(key);
        let c = dots.get(key);
        if (!c) {
          c = s("circle", {});
          dotG[k].append(c);
          dots.set(key, c);
        }
        const q = k === "otm" ? p.otm.q : p[k].q;
        const side = k === "otm" ? (p.otm.side === "pe" ? "put" : "call") : k === "ce" ? "call" : "put";
        setA(c, "class", `dot ${k} ${side}${q === "mid" ? "" : " hollow"}`);
        setA(c, "r", k === "otm" ? r : r - 0.5);
      }
    }
    for (const [key, c] of dots) if (!dkeep.has(key)) (c.remove(), dots.delete(key));

    // End labels in each series' ink, pushed apart (merged when the three lines coincide).
    const ends = [];
    if (G.labelled) {
      const endOf = (name, text, cls) => {
        const list = G.st[name];
        const last = list?.[list.length - 1];
        return last ? { y: last.y, py: last.y, px: last.x, text, cls } : null;
      };
      if (G.st.cmp.length) ends.push(endOf("cmp", data.compare?.label ?? "", "compare"));
      for (const k of G.keys) ends.push(endOf(k, SERIES_NAMES[k], k));
    }
    const laid = layoutEndLabels(ends, { top: T + 4, bottom: plotB - 4 });
    const lkeep = new Set();
    for (const l of laid) {
      lkeep.add(l.cls);
      let t = labels.get(l.cls);
      if (!t) {
        t = s("text", { class: `end-label ${l.cls}`, y: 0 });
        gLabels.append(t);
        labels.set(l.cls, t);
      }
      setT(t, l.text);
      setStyle(t, "transform", `translate(${r1(W - R + 6)}px, ${r1(l.ly + 3.5)}px)`);
    }
    for (const [cls, t] of labels) if (!lkeep.has(cls)) (t.remove(), labels.delete(cls));

    // Series: tween from what is on screen, cross-fade + reveal on a new expiry, reveal on the first draw.
    tw?.cancel();
    const kind = !prevG?.ok || !shown ? "first" : prevG.data?.key !== data.key ? "swap" : "morph";
    if (kind === "morph" && !reduced) {
      tw = tweenPoints(shown, G.st, DUR.d3, frame);
    } else {
      if (kind === "swap" && !reduced && P.otm.getAttribute("d")) {
        const ghost = s("path", { class: "series otm ghost", d: P.otm.getAttribute("d") });
        svg.insertBefore(ghost, P.otm);
        setTimeout(() => ghost.remove(), DUR.d2 + 60);
      }
      tw = null;
      frame(G.st);
      if (kind !== "morph" && !reduced) {
        reveal([P.otm], [area, ribbon]);
        gDots.classList.remove("pop");
        let i = 0;
        for (const p of G.st.otm) dots.get(`otm:${p.k}`)?.style.setProperty("--i", String(i++));
        void gDots.getBoundingClientRect();
        gDots.classList.add("pop");
        setTimeout(() => gDots.classList.remove("pop"), DUR.d4);
      }
    }
    mark(marked);
    return true;
  }

  /** The value a hover reads: the OTM IV (else CE, else PE) at the strike. */
  function readAt(k) {
    const p = G?.byK?.get(k);
    if (!p) return null;
    const key = G.keys.find((x) => G.val(p, x) !== null && G.val(p, x) > 0);
    return key ? { p, key, v: G.val(p, key) } : null;
  }
  /** The compare expiry's OTM IV at this point's x (linear in the current unit), or null outside its range. */
  function compareAt(p) {
    if (!G?.comp?.length) return null;
    const x = smileX(p, G.axis);
    const list = G.comp.map((c) => [smileX(c, G.axis), c.otm.iv]).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < list.length; i++) {
      const [xa, va] = list[i - 1];
      const [xb, vb] = list[i];
      if (x < xa || x > xb) continue;
      return xb === xa ? va : va + ((vb - va) * (x - xa)) / (xb - xa);
    }
    return null;
  }

  /** Move the shared highlight (crosshair, ring, y chip, tooltip) to `strike`; null hides it. */
  function mark(strike) {
    marked = strike ?? null;
    const hit = G?.ok && marked !== null ? readAt(marked) : null;
    for (const el of [hlV, hlH, hlRing, yChip]) show(el, Boolean(hit));
    const docked = Boolean(O.docked && O.dock);
    if (!hit) {
      tip.classList.remove("on");
      if (docked) {
        const atm = G?.ok ? readAt(G.data?.atmStrike) : null;
        const sigD = atm ? `atm|${atm.p.strike}|${r1(atm.v)}` : "none";
        if (O.dock.__sig !== sigD) {
          O.dock.__sig = sigD;
          O.dock.replaceChildren(...(atm && O.tip ? O.tip(atm.p, { cmpIv: compareAt(atm.p), atm: true }) : []));
        }
      }
      return;
    }
    const { W, R, L, T, plotB } = G;
    const x = G.X(smileX(hit.p, G.axis));
    const y = G.Y(hit.v);
    setA(hlV, "x1", r1(x));
    setA(hlV, "x2", r1(x));
    setA(hlV, "y1", T);
    setA(hlV, "y2", plotB);
    setA(hlH, "x1", L);
    setA(hlH, "x2", W - R);
    setA(hlH, "y1", r1(y));
    setA(hlH, "y2", r1(y));
    setA(hlRing, "cx", r1(x));
    setA(hlRing, "cy", r1(y));
    setA(hlRing, "r", (O.coarse ? 3.5 : 2.5) + 3);
    const [, rt] = placePill(yChip, 0, y - 9, formatPercent(hit.v, 1), 1, W);
    // Keep the chip in the y-axis gutter: right-aligned to the plot's left edge.
    const w = rt - 1;
    setStyle(yChip, "transform", `translate(${r1(Math.max(1, L - 2 - w))}px, ${r1(y - 9)}px)`);
    const content = O.tip ? O.tip(hit.p, { cmpIv: compareAt(hit.p) }) : [];
    const csig = `${hit.p.strike}|${r1(hit.v)}|${G.axis}|${G.data?.key}|${r1(compareAt(hit.p) ?? -1)}|${JSON.stringify(O.series)}`;
    if (docked) {
      if (O.dock.__sig !== csig) {
        O.dock.__sig = csig;
        O.dock.replaceChildren(...content);
      }
      tip.classList.remove("on");
      return;
    }
    if (tip.__sig !== csig) {
      tip.__sig = csig;
      tip.replaceChildren(...content);
    }
    tip.classList.add("on");
    placeTip(tip, svg, W, x, y, { left: L, right: W - R, top: T, bottom: plotB });
  }

  const order = () => (G?.ok ? G.pts.filter((p) => readAt(p.strike)).map((p) => p.strike) : []);
  wirePointer(svg, () => G?.W ?? 1, {
    nearest(vx) {
      if (!G?.ok) return null;
      let best = null;
      let bd = Infinity;
      for (const k of order()) {
        const d = Math.abs(G.X(smileX(G.byK.get(k), G.axis)) - vx);
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      return best;
    },
    count: () => order().length,
    current: () => order().indexOf(marked),
    onHover: (k) => O.onPick?.(k, "hover"),
    onLeave: () => O.onPick?.(null, "leave"),
    onPick: (k) => O.onPick?.(k, "tap"),
    onScrubEnd: (k) => O.onPick?.(k, "pin"),
    onKey: (i, how) => O.onPick?.(how === "clear" ? null : order()[i] ?? null, how === "clear" ? "unpin" : how === "pin" ? "pin" : "key"),
  });

  return {
    svg,
    update,
    mark,
    get geometry() {
      return G;
    },
    destroy() {
      destroyed = true;
      tw?.cancel();
      svg.remove();
      tip.remove();
      banners.remove();
    },
  };
}

/** One-shot smile: a detached <svg> with .mark(strike) (create + update once). */
export function smileSvg(data, o) {
  const host = document.createElement("div");
  const c = smileChart(host, o);
  c.update(data, o);
  c.svg.mark = (k) => c.mark(k);
  return c.svg;
}

// ── The term structure ──

/**
 * The persistent term chart: ATM IV against √DTE (weeklies do not bunch).
 * update(rows, o): rows = [{ expiry, days, atmIv, dim, monthly, skew, label, dte, fwd: { vol, inverted } | null,
 *   pending? }] (pending rows have no IV yet: hollow ticks on the axis)
 * o = { selected, wings, hv (number|null), showHv, width, height, coarse, docked, dock, label, empty,
 *   onPick(expiry), tip(row) -> Node[] }
 */
export function termChart(host, init = {}) {
  const id = ++gid;
  const svg = s("svg", { class: "vol-svg term", role: "img", tabindex: "0", focusable: "true", "aria-label": init.label ?? "Term structure" });
  const grad = s("linearGradient", { id: `vol-tvf-${id}`, x1: 0, x2: 0, y1: 0, y2: 1, gradientUnits: "userSpaceOnUse" }, s("stop", { class: "ivf-a", offset: "0" }), s("stop", { class: "ivf-b", offset: "1" }));
  const gGrid = s("g", { class: "grid" });
  const gX = s("g", { class: "xaxis" });
  const yTitle = s("text", { class: "axis-title", x: 4, y: 12 }, "IV %");
  const area = s("path", { class: "area", fill: `url(#vol-tvf-${id})` });
  const hvLine = s("line", { class: "hv-line" });
  const hvLabel = s("text", { class: "hv-label", "text-anchor": "end" });
  const P = { put25: s("path", { class: "series wing put" }), call25: s("path", { class: "series wing call" }), atm: s("path", { class: "series otm" }) };
  const gInv = s("g", { class: "inv" });
  const gFwd = s("g", { class: "fwd" });
  const gDots = s("g", { class: "dots" });
  const gLabels = s("g", { class: "end-labels" });
  const ring = s("circle", { class: "sel-ring", cx: 0, cy: 0 });
  const ringG = s("g", { class: "sel-ring-g" }, ring);
  const selPill = pillNode("sel");
  const hlV = s("line", { class: "hl-line" });
  const hlRing = s("circle", { class: "hl-ring" });
  const msg = s("text", { class: "vol-svg-empty", "text-anchor": "middle" });
  svg.append(s("defs", {}, grad), gGrid, gX, yTitle, area, hvLine, hvLabel, gInv, P.put25, P.call25, P.atm, gFwd, gDots, gLabels, hlV, hlRing, ringG, selPill, msg);
  const tip = hd("div", "vol-tip");
  tip.setAttribute("aria-hidden", "true");
  host.append(svg, tip);

  let G = null;
  let O = init;
  let sig = "";
  let shown = null;
  let tw = null;
  let hover = -1;
  let destroyed = false;
  const yTicks = new Map();
  const dots = new Map();

  function frame(st) {
    shown = st;
    if (!G) return;
    for (const k of ["put25", "call25", "atm"]) setA(P[k], "d", st[k]?.length > 1 ? pathD(st[k]) : null);
    setA(area, "d", st.atm?.length > 1 ? areaD(st.atm, G.plotB) : null);
    for (const k of ["put25", "call25", "atm"]) {
      for (const p of st[k] ?? []) {
        const c = dots.get(`${k}:${p.k}`);
        if (!c) continue;
        setA(c, "cx", r1(p.x));
        setA(c, "cy", r1(p.y));
      }
    }
  }

  function layout(rows, o) {
    const W = Math.max(220, Math.round(o.width));
    const H = Math.max(150, Math.round(o.height));
    const use = rows.filter((r) => !r.pending && r.atmIv !== null && r.days !== null);
    const pending = rows.filter((r) => r.pending && r.days !== null);
    const wing = (r, k) => (o.wings ? r.skew?.[k]?.iv ?? null : null);
    const hv = o.showHv && o.hv !== null && o.hv !== undefined && Number.isFinite(o.hv) ? o.hv : null;
    const L = 40;
    const R = o.wings || hv !== null ? 56 : 18;
    const T = 26;
    const B = 34;
    const plotB = H - B;
    if (!use.length) return { W, H, L, R, T, B, plotB, ok: false, pending };
    const cy = use.flatMap((r) => [r.atmIv, wing(r, "put25"), wing(r, "call25")]).filter((v) => v !== null && v !== undefined);
    // HV20 far from the curves (over 4 vol points beyond them) does not stretch the axis: its line pins to the edge.
    const hvIn = hv !== null && hv >= Math.min(...cy) - 4 && hv <= Math.max(...cy) + 4;
    const ys = hvIn ? [...cy, hv] : cy;
    const sx = [...use, ...pending].map((r) => Math.sqrt(Math.max(r.days, 0)));
    let x0 = Math.min(...sx);
    let x1 = Math.max(...sx);
    const pad = (x1 - x0) * 0.06 || 0.5;
    x0 = Math.max(0, x0 - pad);
    x1 += pad;
    const ya = ivAxis(ys);
    const X = (d) => L + ((Math.sqrt(Math.max(d, 0)) - x0) / (x1 - x0)) * (W - L - R);
    const Y = (v) => T + (1 - (v - ya.y0) / (ya.y1 - ya.y0)) * (plotB - T);
    const st = {};
    for (const k of ["put25", "call25"]) st[k] = use.filter((r) => wing(r, k) !== null).map((r, i) => ({ k: r.expiry, x: X(r.days), y: Y(wing(r, k)), brk: i === 0 }));
    st.atm = use.map((r, i) => ({ k: r.expiry, x: X(r.days), y: Y(r.atmIv), brk: i === 0 }));
    return { W, H, L, R, T, B, plotB, ok: true, use, pending, X, Y, ya, st, hv, hvOff: hv === null || hvIn ? 0 : hv > ya.y1 ? 1 : -1, wing };
  }

  function update(rows, o) {
    if (destroyed) return false;
    const nsig = JSON.stringify([rows, { ...o, onPick: null, tip: null, dock: null }]);
    if (nsig === sig) return false;
    sig = nsig;
    const prevG = G;
    O = o;
    G = layout(rows, o);
    const { W, H, L, R, T, plotB } = G;
    setA(svg, "viewBox", `0 0 ${W} ${H}`);
    setA(svg, "width", W);
    setA(svg, "height", H);
    setA(svg, "aria-label", o.label);
    const reduced = reducedMotion();
    svg.classList.toggle("anim", Boolean(prevG?.ok) && !reduced);
    // Axis: date, then "5d" (and M for the monthly) under it; pending expiries as hollow ticks.
    const all = [...(G.use ?? []), ...(G.pending ?? [])].sort((a, b) => a.days - b.days);
    const xsig = JSON.stringify([W, H, G.ok, all.map((r) => [r.expiry, r.pending ? 1 : 0, r.dim ? 1 : 0, Math.round(r.days * 10)])]);
    if (gX.__sig !== xsig) {
      gX.__sig = xsig;
      const kids = [];
      if (G.ok) {
        let lastX = -Infinity;
        for (const r of all) {
          const x = G.X(r.days);
          if (r.pending) kids.push(s("circle", { class: "pend", cx: r1(x), cy: r1(plotB), r: 3 }));
          if (x - lastX < 40) continue;
          lastX = x;
          kids.push(
            s("text", { class: `axis${r.pending ? " pend-l" : ""}`, x: r1(x), y: plotB + 15, "text-anchor": "middle" }, r.label),
            s("text", { class: "axis dte", x: r1(x), y: plotB + 27, "text-anchor": "middle" }, r.dte ?? "", r.monthly ? s("tspan", { class: "m-tag", dx: 3 }, "M") : null),
          );
        }
      }
      gX.replaceChildren(...kids);
    }
    if (!G.ok) {
      for (const el of [area, hvLine, hvLabel, ringG, selPill, yTitle, hlV, hlRing, ...Object.values(P)]) show(el, false);
      gGrid.replaceChildren();
      gDots.replaceChildren();
      gFwd.replaceChildren();
      gInv.replaceChildren();
      gLabels.replaceChildren();
      yTicks.clear();
      dots.clear();
      setT(msg, o.empty ?? "Loading expiries…");
      setA(msg, "x", W / 2);
      setA(msg, "y", H / 2);
      show(msg, true);
      shown = null;
      tw?.cancel();
      tip.classList.remove("on");
      return true;
    }
    for (const el of [area, yTitle, ...Object.values(P)]) show(el, true);
    const { X, Y, ya } = G;
    if (G.use.length === 1) {
      setT(msg, "Needs 2 expiries for a curve");
      setA(msg, "x", r1((L + W - R) / 2));
      setA(msg, "y", T + 14);
      show(msg, true);
    } else show(msg, false);

    // Y ticks (same keyed slide as the smile).
    const keep = new Set();
    for (const v of ya.ticks) {
      const key = formatFixed(v, 3);
      keep.add(key);
      let g = yTicks.get(key);
      if (!g) {
        g = s("g", { class: "ytick" }, s("line", { x1: L, y1: 0, y2: 0 }), s("text", { class: "axis", x: L - 6, y: 3.5, "text-anchor": "end" }));
        g.style.opacity = svg.classList.contains("anim") ? "0" : "1";
        if (svg.classList.contains("anim") && prevG?.ok) g.style.transform = `translateY(${r1(Math.max(T - 10, Math.min(plotB + 10, prevG.Y(v))))}px)`;
        gGrid.append(g);
        if (svg.classList.contains("anim")) void g.getBoundingClientRect();
        yTicks.set(key, g);
      }
      setA(g.children[0], "x2", W - R);
      setT(g.children[1], ya.label(v));
      setStyle(g, "transform", `translateY(${r1(Y(v))}px)`);
      setStyle(g, "opacity", "1");
    }
    for (const [key, g] of yTicks) {
      if (keep.has(key)) continue;
      yTicks.delete(key);
      if (svg.classList.contains("anim")) {
        g.style.opacity = "0";
        setTimeout(() => g.remove(), DUR.d3 + 20);
      } else g.remove();
    }

    // HV20 reference: the gap between the curve and this line is the variance risk premium.
    show(hvLine, G.hv !== null);
    show(hvLabel, G.hv !== null);
    if (G.hv !== null) {
      setA(hvLine, "x1", L);
      setA(hvLine, "x2", W - R);
      setA(hvLine, "y1", 0);
      setA(hvLine, "y2", 0);
      const hy = G.hvOff > 0 ? T + 2 : G.hvOff < 0 ? plotB - 2 : Y(G.hv);
      setStyle(hvLine, "transform", `translateY(${r1(hy)}px)`);
      hvLine.classList.toggle("off", G.hvOff !== 0);
      setT(hvLabel, `HV20 ${formatPercent(G.hv, 1)}${G.hvOff > 0 ? " ↑" : G.hvOff < 0 ? " ↓" : ""}`);
      setStyle(hvLabel, "transform", `translate(${r1(W - 2)}px, ${r1(hy + (G.hvOff > 0 ? 12 : 3.5))}px)`);
    }

    // Forward vol per segment; an inverted pair (total variance falls) draws in the warn colour.
    const fsig = JSON.stringify([W, H, ya.y0, ya.y1, G.use.map((r) => [r.expiry, r.fwd?.vol ?? null, r.fwd?.inverted ?? false, r.atmIv])]);
    if (gFwd.__sig !== fsig) {
      gFwd.__sig = fsig;
      const lab = [];
      const inv = [];
      for (let i = 1; i < G.use.length; i++) {
        const a = G.use[i - 1];
        const b = G.use[i];
        const ax = X(a.days);
        const bx = X(b.days);
        const ay = Y(a.atmIv);
        const by = Y(b.atmIv);
        if (b.fwd?.inverted) inv.push(s("line", { class: "inv-seg", x1: r1(ax), y1: r1(ay), x2: r1(bx), y2: r1(by) }));
        const t = b.fwd?.inverted ? "inv" : b.fwd?.vol !== null && b.fwd?.vol !== undefined ? `fv ${formatFixed(b.fwd.vol, 1)}` : null;
        if (!t || bx - ax < 34) continue;
        lab.push(s("text", { class: `fwd-l${b.fwd?.inverted ? " inv" : ""}`, x: r1((ax + bx) / 2), y: r1((ay + by) / 2 - 8), "text-anchor": "middle" }, t));
      }
      gInv.replaceChildren(...inv);
      gFwd.replaceChildren(...lab);
    }

    // Dots: ATM violet (hollow on expiry day), wings in their side colours.
    const rad = o.coarse ? 4.5 : 3.5;
    const dkeep = new Set();
    for (const k of ["put25", "call25", "atm"]) {
      for (const r of G.use) {
        if (k !== "atm" && G.wing(r, k) === null) continue;
        const key = `${k}:${r.expiry}`;
        dkeep.add(key);
        let c = dots.get(key);
        if (!c) {
          c = s("circle", {});
          gDots.append(c);
          dots.set(key, c);
        }
        setA(c, "class", k === "atm" ? `dot otm${r.dim ? " hollow" : ""}` : `dot wing ${k === "put25" ? "put" : "call"}`);
        setA(c, "r", k === "atm" ? rad : 2.5);
      }
    }
    for (const [key, c] of dots) if (!dkeep.has(key)) (c.remove(), dots.delete(key));

    // End labels for the wings.
    const ends = [];
    if (o.wings) {
      for (const [k, text, cls] of [["put25", "25ΔP", "put"], ["call25", "25ΔC", "call"]]) {
        const last = G.st[k][G.st[k].length - 1];
        if (last) ends.push({ y: last.y, py: last.y, px: last.x, text, cls });
      }
    }
    const lsig = JSON.stringify([W, ends.map((e) => [e.text, r1(e.y)])]);
    if (gLabels.__sig !== lsig) {
      gLabels.__sig = lsig;
      gLabels.replaceChildren(...layoutEndLabels(ends, { top: T + 4, bottom: plotB - 4 }).map((l) => s("text", { class: `end-label ${l.cls}`, x: r1(W - R + 8), y: r1(l.ly + 3.5) }, l.text)));
    }

    // Gradient + series (tween on refresh, reveal on the first draw).
    const tops = G.st.atm.map((p) => p.y);
    setA(grad, "y1", r1(Math.min(...tops)));
    setA(grad, "y2", r1(plotB));
    tw?.cancel();
    if (prevG?.ok && shown && !reduced) tw = tweenPoints(shown, G.st, DUR.d3, frame);
    else {
      frame(G.st);
      if (!prevG?.ok && !reduced) reveal([P.atm], [area]);
    }

    // Selected expiry: a ring (slides to the new point, then settles) and an IV contrast pill above it.
    const sel = G.use.find((r) => r.expiry === o.selected) ?? null;
    show(ringG, Boolean(sel));
    show(selPill, Boolean(sel));
    if (sel) {
      const x = X(sel.days);
      const y = Y(sel.atmIv);
      setA(ring, "r", rad + 4);
      const moved = ring.__e && ring.__e !== sel.expiry;
      ring.__e = sel.expiry;
      setStyle(ringG, "transform", `translate(${r1(x)}px, ${r1(y)}px)`);
      if (moved && !reduced) {
        ring.classList.remove("settle");
        void ring.getBoundingClientRect();
        ring.classList.add("settle");
      }
      placePill(selPill, x, Math.max(2, y - rad - 26), formatPercent(sel.atmIv, 1), 2, W - 2);
    }
    setHover(hover);
    return true;
  }

  function setHover(i) {
    hover = G?.ok && i >= 0 && i < G.use.length ? i : -1;
    const r = hover >= 0 ? G.use[hover] : null;
    show(hlV, Boolean(r));
    show(hlRing, Boolean(r));
    const docked = Boolean(O.docked && O.dock);
    const target = r ?? (docked && G?.ok ? G.use.find((x) => x.expiry === O.selected) ?? null : null);
    const content = target && O.tip ? O.tip(target) : [];
    const csig = target ? `${target.expiry}|${r1(target.atmIv)}|${target.fwd?.vol ?? ""}|${O.wings}` : "none";
    if (docked) {
      if (O.dock.__sig !== csig) {
        O.dock.__sig = csig;
        O.dock.replaceChildren(...content);
      }
      tip.classList.remove("on");
    }
    if (!r) {
      tip.classList.remove("on");
      return;
    }
    const x = G.X(r.days);
    const y = G.Y(r.atmIv);
    setA(hlV, "x1", r1(x));
    setA(hlV, "x2", r1(x));
    setA(hlV, "y1", G.T);
    setA(hlV, "y2", G.plotB);
    setA(hlRing, "cx", r1(x));
    setA(hlRing, "cy", r1(y));
    setA(hlRing, "r", (O.coarse ? 4.5 : 3.5) + 3);
    if (docked) return;
    if (tip.__sig !== csig) {
      tip.__sig = csig;
      tip.replaceChildren(...content);
    }
    tip.classList.add("on");
    placeTip(tip, svg, G.W, x, y, { left: G.L, right: G.W - G.R, top: G.T, bottom: G.plotB });
  }

  wirePointer(svg, () => G?.W ?? 1, {
    nearest(vx) {
      if (!G?.ok) return null;
      let best = -1;
      let bd = Infinity;
      G.use.forEach((r, i) => {
        const d = Math.abs(G.X(r.days) - vx);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      return best;
    },
    count: () => (G?.ok ? G.use.length : 0),
    current: () => (hover >= 0 ? hover : G?.ok ? G.use.findIndex((r) => r.expiry === O.selected) : -1),
    onHover: (i) => setHover(i ?? -1),
    onLeave: () => setHover(-1),
    onPick: (i) => {
      const r = G?.ok && i !== null && i >= 0 ? G.use[i] : null;
      if (r) O.onPick?.(r.expiry);
    },
    onScrubEnd: (i) => setHover(i ?? -1),
    onKey: (i, how) => {
      if (how === "clear") return setHover(-1);
      if (how === "pin") {
        const r = G.use[i];
        if (r) O.onPick?.(r.expiry);
        return;
      }
      setHover(i);
    },
  });

  return {
    svg,
    update,
    destroy() {
      destroyed = true;
      tw?.cancel();
      svg.remove();
      tip.remove();
    },
  };
}

/** One-shot term structure: a detached <svg> (create + update once). */
export function termSvg(rows, o) {
  const host = document.createElement("div");
  const c = termChart(host, o);
  c.update(rows, o);
  return c.svg;
}

/** A loading placeholder at the plot's final height: four shimmer gridlines and a curve-shaped shimmer. */
export function plotSkeleton(height) {
  const el = hd("div", "vol-skel");
  el.style.height = `${Math.round(height)}px`;
  el.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 4; i++) el.append(hd("i", "skel vol-skel-line"));
  el.append(hd("b", "skel vol-skel-curve"));
  return el;
}

/** The smile's aria-label sentence. */
export function smileLabel({ expiryLabel, atmIv, rr25, n }) {
  const rr = rr25 === null || rr25 === undefined ? "not available" : `${rr25 >= 0 ? "plus" : "minus"} ${formatFixed(Math.abs(rr25), 1)} points`;
  return `Smile for ${expiryLabel}: ATM IV ${atmIv === null ? DASH : formatPercent(atmIv, 1)}, 25-delta put minus call ${rr}, ${formatInt(n)} strikes`;
}
