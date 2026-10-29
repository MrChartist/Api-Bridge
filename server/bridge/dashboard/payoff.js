// The strategy payoff chart (docs/design/strategy.md §4): the only code that knows SVG for it. It draws a view built
// from O.payoffModel (pure, tested) and patches the same nodes on every update, so a slider can redraw it every frame.
// Back to front: plot, ±2σ / ±1σ bands with bottom labels, grid, gradient profit / loss areas, the distribution ribbon,
// the zero line, max profit / loss guides with right-edge pills, per-leg and saved overlays, the mid and target curves,
// the expiry curve split by sign, strike markers, the spot contrast pill, breakeven rings with their pills below the
// axis, the crosshair and a floating tooltip. A model change morphs (360 ms) unless the user prefers reduced motion;
// slider drags and live ticks patch in place. When the owner's chart engine arrives it replaces drawPayoff() only.
//
// drawPayoff(host, { onPin, onMarker, heights }) -> { update(view, { animate }), empty({ text, sub, action }), pin(price),
//   highlight(id), highlightMarker(id), tools, destroy() }
//   The Positions page (positions.md §4.8) shares it: a view may also carry `now` (the T+0 curve, solid), `hedge` (the
//   after-hedge curve, dotted), `here` ({ x, y }: the you-are-here dot, eased on ticks), `prob: "below"`, `ariaLabel`
//   and its own `labels.now` / `labels.hedge`.
//   Fine pointer: the card follows the pointer, click pins. Coarse pointer: tap / drag pins and the card docks at the
//   top of the plot. Keyboard: ← → one strike step (Shift: 5), Esc unpins.
import { h, keyHint, touchWord } from "./app.js";
import { DASH, formatCompact, formatFixed, formatInt, formatRupee, formatSigned, isFigure } from "./format.js";
import * as O from "./options.js";
import { lineReveal, reducedMotion } from "./motion.js";

const { niceTicks } = O;

const SVG_NS = "http://www.w3.org/2000/svg";
const r1 = (v) => Math.round(v * 10) / 10;
function s(tag, attrs, ...children) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== undefined && v !== null && v !== false) e.setAttribute(k, String(v));
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
const set = (el, attrs) => {
  for (const [k, v] of Object.entries(attrs)) {
    const val = v === null || v === undefined ? null : String(v);
    if (val === null) el.removeAttribute(k);
    else if (el.getAttribute(k) !== val) el.setAttribute(k, val);
  }
};
const text = (el, t) => {
  if (el.textContent !== t) el.textContent = t;
};

/** Round axis values (options.js; re-exported for positions.js). */
export { niceTicks };

/** Rupees with a sign (a true minus, U+2212) and no decimals; a lakh and above in Indian compact form (₹6.02L). */
export function money(v, { signed = true } = {}) {
  if (!isFigure(v)) return DASH;
  const n = Math.round(Number(v));
  const body = Math.abs(n) >= 1e5 ? `₹${formatCompact(Math.abs(n))}` : formatRupee(Math.abs(n), 0);
  return n > 0 && signed ? `+${body}` : n < 0 ? `\u2212${body}` : body;
}
/** The same with the gain / loss colour. */
export const moneyEl = (v, opts) => h("span", { class: isFigure(v) && Math.round(v) > 0 ? "up" : isFigure(v) && Math.round(v) < 0 ? "down" : undefined }, money(v, opts));
/** Axis rupees: "+₹5K", "-₹10K", "0". */
const axisMoney = (v) => (Math.abs(v) < 1e-9 ? "0" : `${v > 0 ? "+" : "\u2212"}₹${formatCompact(Math.abs(v)).replace(/\.0(?=[KLC])/, "")}`);

/**
 * Price ticks: about one per 90 px of plot (at least 4), on a multiple of the strike step when one fits
 * (50 → 100, 200, 250, 400 …), else round numbers.
 */
function xTicks(lo, hi, plotW, unit) {
  const want = Math.max(4, Math.floor(plotW / 90));
  if (unit > 0 && hi > lo) {
    for (const m of [1, 2, 4, 5, 8, 10, 20, 25, 40, 50, 100, 200, 250, 500, 1000]) {
      const st = unit * m;
      const a = Math.ceil(lo / st);
      const b = Math.floor(hi / st);
      if (b - a + 1 <= want) return Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => (a + i) * st);
    }
  }
  return niceTicks(lo, hi, want);
}
const mq = (q) => typeof matchMedia === "function" && matchMedia(q).matches;
const coarse = () => mq("(pointer: coarse)");
/** 340 px on desktop, 280 on tablet, 232 on phone (§3); a page may pass its own [desktop, tablet, phone]. */
const heightsFor = (hs) => (mq("(max-width: 719px)") ? hs[2] : mq("(max-width: 1023px)") ? hs[1] : hs[0]);
const ease = (t) => 1 - (1 - t) ** 3;
const MORPH_MS = 360;
const HINT_KEY = "mcb.payoff.hinted";
const hinted = () => {
  try {
    return sessionStorage.getItem(HINT_KEY) === "1";
  } catch {
    return true;
  }
};
const markHinted = () => {
  try {
    sessionStorage.setItem(HINT_KEY, "1");
  } catch {
    /* fine without storage */
  }
};

/**
 * @param {HTMLElement} host
 * @param {{ onPin?: (price: number|null) => void }} [opts]
 */
export function drawPayoff(host, { onPin, onMarker, heights = [340, 280, 232] } = {}) {
  const heightFor = () => heightsFor(heights);
  let v = null; // the view being shown (the tween target)
  let d = null; // what is drawn this frame (v, or an in-between during a morph)
  let W = 720;
  let H = 340;
  let L = 56;
  const R = 12;
  const T = 26;
  const B = 56;
  let pinned = null;
  let hover = null;
  let tween = 0;
  let hiMarker = null;
  let hereShown = false;
  const id = `po${Math.random().toString(36).slice(2, 7)}`;
  const clipUp = s("rect", { x: 0, y: 0, width: 0, height: 0 });
  const clipDn = s("rect", { x: 0, y: 0, width: 0, height: 0 });
  const clipPlot = s("rect", { x: 0, y: 0, width: 0, height: 0 });
  const ribbonClip = s("clipPath", { id: `${id}-pz` });
  const stop = (cls, off) => s("stop", { class: cls, offset: off });
  const gPos = s("linearGradient", { id: `${id}-gp`, gradientUnits: "userSpaceOnUse", x1: 0, x2: 0, y1: 0, y2: 1 }, stop("gp-0", "0"), stop("gp-1", "1"));
  const gNeg = s("linearGradient", { id: `${id}-gn`, gradientUnits: "userSpaceOnUse", x1: 0, x2: 0, y1: 0, y2: 1 }, stop("gn-0", "0"), stop("gn-1", "1"));
  const plotBg = s("rect", { class: "plot-bg", rx: 8 });
  const band2 = s("rect", { class: "band2", visibility: "hidden" });
  const band1 = s("rect", { class: "band1", visibility: "hidden" });
  const bandLabels = s("g", { class: "band-lbl" });
  const grid = s("g", { class: "grid-g" });
  const xAxis = s("g", { class: "x-axis" });
  const areaUp = s("path", { class: "area-up", fill: `url(#${id}-gp)`, "clip-path": `url(#${id}-up)` });
  const areaDn = s("path", { class: "area-dn", fill: `url(#${id}-gn)`, "clip-path": `url(#${id}-dn)` });
  // An inline style outranks any stylesheet fill on .area-up / .area-dn, so the gradients always apply.
  areaUp.style.fill = `url(#${id}-gp)`;
  areaDn.style.fill = `url(#${id}-gn)`;
  const ribbon = s("path", { class: "ribbon" });
  const ribbonPos = s("path", { class: "ribbon-pos", "clip-path": `url(#${id}-pz)` });
  const zero = s("line", { class: "zero" });
  const guideMax = s("line", { class: "guide max" });
  const guideMin = s("line", { class: "guide min" });
  const pill = (cls) => {
    const g = s("g", { class: `cpill ${cls}` });
    const bg = s("rect", { rx: 9, height: 18, class: "cp-bg" });
    const r = s("rect", { rx: 9, height: 18 });
    const t = s("text", { "text-anchor": "middle" });
    g.append(bg, r, t);
    return { g, bg, r, t };
  };
  const pMax = pill("pos");
  const pMin = pill("neg");
  const pSpot = pill("spot");
  const clipNote = s("text", { class: "clip-note", "text-anchor": "middle" });
  const legsG = s("g", { class: "leg-lines", "clip-path": `url(#${id}-plot)` });
  const cmpLine = s("path", { class: "cmp-line", "clip-path": `url(#${id}-plot)` });
  const lineM = s("path", { class: "line-mid", "clip-path": `url(#${id}-plot)` });
  const lineT = s("path", { class: "line-target", "clip-path": `url(#${id}-plot)` });
  const lineN = s("path", { class: "line-now", "clip-path": `url(#${id}-plot)`, visibility: "hidden" });
  const lineH = s("path", { class: "line-hedge", "clip-path": `url(#${id}-plot)`, visibility: "hidden" });
  const here = s("circle", { r: 4.5, cx: 0, cy: 0, class: "here-dot", visibility: "hidden" });
  const lineEUp = s("path", { class: "line-exp up", "clip-path": `url(#${id}-up)` });
  const lineEDn = s("path", { class: "line-exp dn", "clip-path": `url(#${id}-dn)` });
  const marks = s("g", { class: "strike-marks" });
  const spotLine = s("line", { class: "spot-line" });
  const beDots = s("g", { class: "be-dots" });
  const bePills = s("g", { class: "be-pills" });
  const cross = s("line", { class: "cross", visibility: "hidden" });
  const dotE = s("circle", { r: 4, class: "dot-exp", visibility: "hidden" });
  const dotT = s("circle", { r: 4, class: "dot-target", visibility: "hidden" });
  const dotN = s("circle", { r: 4, class: "dot-now", visibility: "hidden" });
  const svg = s(
    "svg",
    { class: "payoff-svg", role: "img", tabindex: "0", focusable: "true" },
    s("defs", {}, s("clipPath", { id: `${id}-up` }, clipUp), s("clipPath", { id: `${id}-dn` }, clipDn), s("clipPath", { id: `${id}-plot` }, clipPlot), ribbonClip, gPos, gNeg),
    plotBg,
    band2,
    band1,
    grid,
    areaUp,
    areaDn,
    ribbon,
    ribbonPos,
    zero,
    guideMax,
    guideMin,
    legsG,
    cmpLine,
    lineM,
    lineT,
    lineH,
    lineEUp,
    lineEDn,
    lineN,
    bandLabels,
    xAxis,
    marks,
    spotLine,
    pSpot.g,
    beDots,
    bePills,
    pMax.g,
    pMin.g,
    clipNote,
    here,
    cross,
    dotE,
    dotT,
    dotN,
  );
  // Legend (swatches drawn with the chart's own classes, so they always match) and a slot for the page's controls.
  const swatch = (...kids) => s("svg", { class: "lg-sw", viewBox: "0 0 16 10", width: 16, height: 10, "aria-hidden": "true" }, ...kids);
  const lgItem = (sw, label) => {
    const t = h("span", { class: "lg-t" }, label);
    return { el: h("span", { class: "lg-i" }, sw, t), t };
  };
  const lgExp = lgItem(swatch(s("line", { class: "line-exp up", x1: 0, x2: 8, y1: 4, y2: 4 }), s("line", { class: "line-exp dn", x1: 8, x2: 16, y1: 6, y2: 6 })), "Expiry");
  const lgT = lgItem(swatch(s("line", { class: "line-target", x1: 0, x2: 16, y1: 5, y2: 5 })), "Target");
  const lgM = lgItem(swatch(s("line", { class: "line-mid", x1: 0, x2: 16, y1: 5, y2: 5 })), "Mid-date");
  const lgB1 = lgItem(swatch(s("rect", { class: "band1 sw-band", x: 2, y: 1, width: 12, height: 8, rx: 1.5 })), "±1σ");
  const lgB2 = lgItem(swatch(s("rect", { class: "band2 sw-band", x: 2, y: 1, width: 12, height: 8, rx: 1.5 })), "±2σ");
  const lgC = lgItem(swatch(s("line", { class: "cmp-line", x1: 0, x2: 16, y1: 5, y2: 5 })), "Saved");
  const lgN = lgItem(swatch(s("line", { class: "line-now", x1: 0, x2: 16, y1: 5, y2: 5 })), "Now");
  const lgH = lgItem(swatch(s("line", { class: "line-hedge", x1: 1, x2: 15, y1: 5, y2: 5 })), "After hedge");
  lgN.el.hidden = true;
  lgH.el.hidden = true;
  const legend = h("span", { class: "legend" }, lgN.el, lgT.el, lgM.el, lgExp.el, lgB1.el, lgB2.el, lgH.el, lgC.el);
  const tools = h("span", { class: "payoff-tools" });
  const headEl = h("div", { class: "payoff-head" }, legend, tools);
  // Tooltip card
  const tipPrice = h("strong", {});
  const tipMove = h("span", { class: "tip-move" });
  const tipRows = h("div", { class: "tip-rows" });
  const tipX = h("button", { type: "button", class: "tip-x", "aria-label": "Unpin", onclick: () => setPin(null) }, "×");
  const tip = h("div", { class: "payoff-tip", "aria-hidden": "true" }, h("div", { class: "tip-head" }, tipPrice, tipMove, tipX), tipRows);
  const hint = h("span", { class: "payoff-hint", "aria-hidden": "true" });
  const plotWrap = h("div", { class: "payoff-plot" }, svg, tip, hint);
  // Empty: a ghost iron condor, a line of text and an optional action (§6.1).
  const ghostText = h("strong", {});
  const ghostSub = h("span", { class: "ghost-sub" });
  const empty = h(
    "div",
    { class: "payoff-empty", hidden: true },
    s("svg", { class: "ghost-svg", viewBox: "0 0 600 200", preserveAspectRatio: "none", "aria-hidden": "true" }, s("rect", { class: "ghost-band", x: 210, y: 0, width: 180, height: 200 }), s("line", { class: "ghost-zero", x1: 0, x2: 600, y1: 110, y2: 110 }), s("polyline", { class: "ghost-line", points: "0,170 150,170 220,70 380,70 450,170 600,170" })),
    h("div", { class: "ghost-copy" }, ghostText, ghostSub),
  );
  const live = h("div", { class: "sr-only", "aria-live": "off" });
  host.replaceChildren(headEl, plotWrap, empty, live);

  const X = (p) => L + ((p - d.lo) / (d.hi - d.lo)) * (W - L - R);
  const ky = () => (d.yScale ?? 1);
  const Y = (val) => T + ((d.yMax - val) / (d.yMax - d.yMin)) * (H - T - B);
  const P = (px) => d.lo + ((Math.max(L, Math.min(W - R, px)) - L) / (W - L - R)) * (d.hi - d.lo);
  const path = (vals, xs = d.xs) => vals.map((val, i) => (val === null ? "" : `${i === 0 || vals[i - 1] === null ? "M" : "L"}${r1(X(xs[i]))},${r1(Y(Math.max(d.yMin - (d.yMax - d.yMin), Math.min(d.yMax + (d.yMax - d.yMin), val))))}`)).join("");
  /** A value at price p by linear interpolation of a sampled curve. */
  const atOn = (xs, vals, p) => {
    if (!vals) return null;
    let i = 1;
    while (i < xs.length - 1 && xs[i] < p) i += 1;
    const a = vals[i - 1];
    const b = vals[i];
    if (a === null || b === null) return null;
    const t = xs[i] === xs[i - 1] ? 0 : (p - xs[i - 1]) / (xs[i] - xs[i - 1]);
    return a + (b - a) * Math.max(0, Math.min(1, t));
  };
  const at = (vals, p) => atOn(v.xs, vals, p);
  const step = () => {
    const ks = v?.chainStrikes?.length ? v.chainStrikes : v?.strikes ?? [];
    const gaps = ks.slice(1).map((k, i) => k - ks[i]).filter((x) => x > 0);
    return gaps.length ? Math.min(...gaps) : Math.max(1, Math.round((v.hi - v.lo) / 60));
  };

  function sizeOf() {
    W = Math.max(280, Math.round(plotWrap.clientWidth || host.clientWidth || 720));
    H = heightFor();
    L = W < 480 ? 46 : 56;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", String(W));
    svg.setAttribute("height", String(H));
  }

  // ── Painting one frame ──
  let gridKey = "";
  let gridEls = [];
  function paintGrid() {
    const k = ky();
    let yt = niceTicks(v.yMin * k, v.yMax * k, 5);
    if (yt.length < 3) yt = niceTicks(v.yMin * k, v.yMax * k, 8);
    const key = `${yt.join(",")}|${v.yMode}`;
    if (key !== gridKey) {
      // Labels cross-fade: the old group fades out, the new one fades in (CSS; none under reduced motion).
      const old = gridKey ? grid.cloneNode(true) : null;
      gridKey = key;
      gridEls = yt.map((t) => ({ t, line: s("line", { class: "grid" }), label: s("text", { class: "axis", "text-anchor": "end" }, v.yMode === "pct" ? `${formatSigned(t, Math.abs(t) < 10 && t % 1 ? 1 : 0)}%`.replace(/^\+0%$/, "0") : axisMoney(t)) }));
      grid.replaceChildren(...gridEls.flatMap((g) => [g.line, g.label]));
      if (old && !reducedMotion()) {
        old.classList.add("grid-out");
        grid.parentNode.insertBefore(old, grid);
        grid.classList.remove("grid-in");
        void grid.getBBox?.();
        grid.classList.add("grid-in");
        setTimeout(() => old.remove(), 140);
      }
    }
    for (const g of gridEls) {
      const y = r1(Y(g.t / k));
      set(g.line, { x1: L, x2: W - R, y1: y, y2: y, visibility: y < T - 1 || y > H - B + 1 ? "hidden" : "visible" });
      set(g.label, { x: L - 8, y: r1(y + 3.5), visibility: y < T - 1 || y > H - B + 1 ? "hidden" : "visible" });
    }
  }
  function paintX() {
    const xt = xTicks(d.lo, d.hi, W - L - R, step()).filter((p) => p > d.lo && p < d.hi);
    const key = `${W}|${xt.join(",")}|${r1(d.lo)}|${r1(d.hi)}`;
    if (xAxis.__sig === key) return;
    xAxis.__sig = key;
    xAxis.replaceChildren(s("line", { class: "x-base", x1: L, x2: W - R, y1: H - B, y2: H - B }), ...xt.map((p) => s("text", { x: r1(X(p)), y: H - B + 24, class: "axis", "text-anchor": "middle" }, formatInt(p))));
  }
  function paintPill(p, x, y, label, { anchor = "middle", show = true } = {}) {
    if (!show) return set(p.g, { visibility: "hidden" });
    text(p.t, label);
    const w = Math.max(28, Math.round(label.length * 6.1 + 14));
    const left = anchor === "end" ? x - w : anchor === "start" ? x : x - w / 2;
    const cl = Math.max(L, Math.min(W - R - w, left));
    set(p.r, { x: r1(cl), y: r1(y - 9), width: w });
    set(p.bg, { x: r1(cl), y: r1(y - 9), width: w });
    set(p.t, { x: r1(cl + w / 2), y: r1(y + 3.6) });
    set(p.g, { visibility: "visible" });
  }
  /** How many drawn curves (and horizontal guide lines, px) pass through the box [x0, x1] × [y0, y1] (3 px margin)? */
  function hitsCurve(x0, x1, y0, y1, lines = []) {
    const curves = [d.expiry, d.target, d.mid, d.now].filter(Boolean);
    const p0 = P(x0);
    const p1 = P(x1);
    let n = lines.filter((ly) => ly >= y0 - 3 && ly <= y1 + 3).length;
    for (const vals of curves) {
      const ys = [atOn(d.xs, vals, p0), atOn(d.xs, vals, p1)];
      d.xs.forEach((q, i) => (q > p0 && q < p1 ? ys.push(vals[i]) : null));
      const px = ys.filter((val) => val !== null).map((val) => Y(Math.max(d.yMin, Math.min(d.yMax, val))));
      if (!px.length) continue;
      if (Math.max(...px) >= y0 - 3 && Math.min(...px) <= y1 + 3) n += 1;
    }
    return n;
  }
  /**
   * A Max pill beside its guide, never on a curve: tried right edge on its own side of the guide (above for max,
   * below for min), then the other side, then the left edge; the first box clear of every curve wins.
   */
  function placeGuidePill(p, gy, label, dir, bottom) {
    const w = Math.max(28, Math.round(label.length * 6.1 + 14));
    const top = T + 10;
    const spots = [];
    for (const edge of ["end", "start"]) for (const side of [dir, -dir]) spots.push({ edge, y: gy + side * 19 });
    const ok = spots.filter((c) => c.y >= top && c.y <= bottom);
    const box = (c) => (c.edge === "end" ? [W - R - 4 - w, W - R - 4] : [L + 4, L + 4 + w]);
    // The first clear spot; when none is clear, the one crossed by the fewest curves (the pill is opaque anyway).
    const scored = ok.map((c) => ({ c, n: hitsCurve(...box(c), c.y - 9, c.y + 9) }));
    const best = scored.find((q) => q.n === 0) ?? scored.reduce((a, q) => (q.n < a.n ? q : a), scored[0] ?? { n: 0 });
    const pick = best?.c ?? { edge: "end", y: Math.max(top, Math.min(bottom, gy + dir * 19)) };
    paintPill(p, pick.edge === "end" ? W - R - 4 : L + 4, pick.y, label, { anchor: pick.edge });
  }
  /** The first-visit hint goes in a corner of the plot that no curve or pill crosses. */
  function placeHint() {
    if (hint.hidden) return;
    const hw = hint.offsetWidth || 180;
    const hh = 22;
    const ys = [H - B - hh - 26, T + 6, T + 30, (T + H - B - hh) / 2];
    const corners = [L + 8, W - R - hw - 8].flatMap((x0) => ys.map((y0) => [x0, y0]));
    const lines = [guideMax, guideMin, zero].filter((g) => g.getAttribute("visibility") !== "hidden").map((g) => Number(g.getAttribute("y1"))).filter(Number.isFinite);
    const pills = [pMax, pMin].filter((q) => q.g.getAttribute("visibility") === "visible").map((q) => [Number(q.r.getAttribute("x")), Number(q.r.getAttribute("y"))]);
    const overPill = (x0, y0) => pills.some(([px, py]) => px < x0 + hw && px + 100 > x0 && py < y0 + hh && py + 18 > y0);
    const cost = ([x0, y0]) => hitsCurve(x0, x0 + hw, y0, y0 + hh, lines) + (overPill(x0, y0) ? 5 : 0);
    const free = corners.reduce((a, c) => (cost(c) < cost(a) ? c : a), corners[0]);
    hint.style.left = `${Math.round(free[0])}px`;
    hint.style.top = `${Math.round(free[1])}px`;
  }
  function paint() {
    if (!d) return;
    const plotW = W - L - R;
    const zy = Math.max(T, Math.min(H - B, Y(0)));
    set(plotBg, { x: L, y: T, width: plotW, height: H - T - B });
    set(clipPlot, { x: L, y: T, width: plotW, height: H - T - B });
    set(clipUp, { x: L, y: T, width: plotW, height: Math.max(0, zy - T) });
    set(clipDn, { x: L, y: zy, width: plotW, height: Math.max(0, H - B - zy) });
    // Gradients: strongest at the extreme, fading to zero at the zero line.
    const topV = Math.max(0, ...d.expiry);
    set(gPos, { y1: r1(Y(Math.min(d.yMax, topV))), y2: r1(zy) });
    set(gNeg, { y1: r1(zy), y2: r1(Y(Math.max(d.yMin, Math.min(0, ...d.expiry)))) });
    const band = (el, b) => {
      if (!b) return set(el, { visibility: "hidden" });
      const a = X(Math.max(d.lo, b[0]));
      const z = X(Math.min(d.hi, b[1]));
      set(el, { visibility: z > a ? "visible" : "hidden", x: r1(a), y: T, width: r1(Math.max(0, z - a)), height: H - T - B });
    };
    band(band2, d.band2);
    band(band1, d.band1);
    paintGrid();
    paintX();
    // Band labels at the bottom of the plot, inside the ±1σ edges; hidden when they would collide.
    const bl = d.band1 ? [[`−1σ ${formatInt(d.band1[0])}`, X(d.band1[0]) + 4, "start"], [`+1σ ${formatInt(d.band1[1])}`, X(d.band1[1]) - 4, "end"]] : [];
    const blKey = bl.map((x) => `${x[0]}${r1(x[1])}`).join("|");
    if (bandLabels.__sig !== blKey) {
      bandLabels.__sig = blKey;
      const room = bl.length === 2 ? bl[1][1] - bl[0][1] > (bl[0][0].length + bl[1][0].length) * 6 + 12 : false;
      bandLabels.replaceChildren(...(room ? bl.filter((b) => b[1] > L + 2 && b[1] < W - R - 2).map(([t, x, a]) => s("text", { x: r1(x), y: H - B - 6, class: "band-text", "text-anchor": a }, t)) : []));
    }
    const xs = d.xs;
    const area = `M${r1(X(xs[0]))},${r1(zy)}${d.expiry.map((val, i) => `L${r1(X(xs[i]))},${r1(Y(Math.max(d.yMin - 1e9, val)))}`).join("")}L${r1(X(xs[xs.length - 1]))},${r1(zy)}Z`;
    set(areaUp, { d: area });
    set(areaDn, { d: area });
    // Distribution ribbon along the bottom 18 % of the plot; the part over profitable prices tinted.
    if (d.density && d.showDist) {
      const base = H - B;
      const hgt = (H - T - B) * 0.18;
      const rp = `M${r1(X(xs[0]))},${base}${d.density.map((q, i) => `L${r1(X(xs[i]))},${r1(base - q * hgt)}`).join("")}L${r1(X(xs[xs.length - 1]))},${base}Z`;
      set(ribbon, { d: rp, visibility: "visible" });
      set(ribbonPos, { d: rp, visibility: "visible" });
      const pz = (d.profitIntervals ?? []).map(([a, b]) => [Math.max(d.lo, a), Math.min(d.hi, b)]).filter(([a, b]) => b > a);
      const pk = pz.map(([a, b]) => `${r1(X(a))}-${r1(X(b))}`).join();
      if (ribbonClip.__sig !== pk) {
        ribbonClip.__sig = pk;
        ribbonClip.replaceChildren(...pz.map(([a, b]) => s("rect", { x: r1(X(a)), y: T, width: r1(X(b) - X(a)), height: H - T - B })));
      }
    } else {
      set(ribbon, { visibility: "hidden" });
      set(ribbonPos, { visibility: "hidden" });
    }
    set(zero, { x1: L, x2: W - R, y1: r1(zy), y2: r1(zy) });
    // Max profit / loss guides and pills.
    const st = d.stats;
    const mp = st?.locked === null || st?.locked === undefined ? st?.maxProfit : null;
    const ml = st?.locked === null || st?.locked === undefined ? st?.maxLoss : null;
    const inY = (val) => val !== null && val !== undefined && val <= d.yMax && val >= d.yMin;
    const sfx = d.approx ? " ≈" : "";
    const pillBottom = H - B - (bandLabels.childNodes.length ? 24 : 12);
    if (mp !== null && mp !== undefined && mp > 0 && inY(mp)) {
      set(guideMax, { x1: L, x2: W - R, y1: r1(Y(mp)), y2: r1(Y(mp)), visibility: "visible" });
      placeGuidePill(pMax, Y(mp), `Max ${money(mp)}${sfx}`, -1, pillBottom);
    } else {
      set(guideMax, { visibility: "hidden" });
      paintPill(pMax, W - R - 4, T + 10, st && mp === null && st.maxProfit === null ? "↗ Unlimited" : "", { anchor: "end", show: Boolean(st && st.maxProfit === null) });
    }
    const lossBelow = ml !== null && ml !== undefined && ml < 0;
    if (lossBelow && inY(ml)) {
      set(guideMin, { x1: L, x2: W - R, y1: r1(Y(ml)), y2: r1(Y(ml)), visibility: "visible" });
      placeGuidePill(pMin, Y(ml), `Max ${money(ml)}${sfx}`, 1, pillBottom);
    } else {
      set(guideMin, { visibility: "hidden" });
      const unl = st && st.maxLoss === null;
      paintPill(pMin, W - R - 4, H - B - 24, unl ? "↘ Unlimited" : lossBelow ? `Max ${money(ml)} ▾` : "", { anchor: "end", show: Boolean(unl || lossBelow) });
    }
    // Clamp arrow: a far tail clipped at the plot edge.
    // The clamp arrow only when no Max pill already names the clipped value.
    const pillSays = d.clip && ((d.clip.side === "low" && st && st.maxLoss !== null) || (d.clip.side === "high" && st && st.maxProfit !== null));
    if (d.clip && !pillSays && d.clip.at >= d.lo && d.clip.at <= d.hi) {
      const cx = Math.max(L + 60, Math.min(W - R - 120, X(d.clip.at)));
      set(clipNote, { x: r1(cx), y: d.clip.side === "low" ? H - B - 26 : T + 14, visibility: "visible" });
      text(clipNote, `${d.clip.side === "low" ? "▼" : "▲"} ${money(d.clip.value)} at ${formatInt(d.clip.at)}`);
    } else set(clipNote, { visibility: "hidden" });
    // Overlays: per-leg payoffs and a saved strategy.
    const pl = d.perLeg ?? [];
    if (legsG.childNodes.length !== pl.length) legsG.replaceChildren(...pl.map(() => s("path", {})));
    pl.forEach((leg, i) => set(legsG.childNodes[i], { d: path(leg.vals), class: `leg-line ${leg.right === "PE" ? "put" : leg.right === "CE" ? "call" : "fut"} ${leg.side === "SELL" ? "sell" : "buy"}${d.highlight ? (d.highlight === leg.id ? " hi" : " lo") : ""}`, "data-id": leg.id }));
    set(cmpLine, { d: d.compare ? path(d.compare.vals) : "", visibility: d.compare ? "visible" : "hidden" });
    set(lineM, { d: d.mid ? path(d.mid) : "", visibility: d.mid ? "visible" : "hidden" });
    set(lineT, { d: d.target ? path(d.target) : "", visibility: d.target ? "visible" : "hidden" });
    set(lineN, { d: d.now ? path(d.now) : "", visibility: d.now ? "visible" : "hidden" });
    set(lineH, { d: d.hedge ? path(d.hedge) : "", visibility: d.hedge ? "visible" : "hidden" });
    // You are here: (spot, P&L now), moved with a transform so a live tick eases it (CSS; jumps under reduced motion).
    if (d.here && isFigure(d.here.x) && isFigure(d.here.y) && d.here.x >= d.lo && d.here.x <= d.hi) {
      const hy = Y(Math.max(d.yMin, Math.min(d.yMax, d.here.y)));
      here.style.transform = `translate(${r1(X(d.here.x))}px, ${r1(hy)}px)`;
      set(here, { visibility: "visible", class: `here-dot${hereShown ? " ease" : ""}` });
      if (!hereShown) setTimeout(() => (hereShown = true), 0);
    } else {
      set(here, { visibility: "hidden", class: "here-dot" });
      hereShown = false;
    }
    const pe = path(d.expiry);
    set(lineEUp, { d: pe });
    set(lineEDn, { d: pe });
    // Strike markers on the baseline: triangles by right (call / put colour), filled = buy, outline = sell.
    const mk = d.markers ?? [];
    const mkKey = `${W}|${H}|${r1(d.lo)}|${r1(d.hi)}|${mk.map((m) => `${m.kind}${m.right}${m.side}${m.strike ?? m.price}${m.title}${m.id ?? ""}`).join(",")}`;
    if (marks.__sig !== mkKey) {
      marks.__sig = mkKey;
      const seen = new Map();
      marks.replaceChildren(
        ...mk
          .filter((m) => (m.kind === "FUT" ? m.price : m.strike) >= d.lo && (m.kind === "FUT" ? m.price : m.strike) <= d.hi)
          .map((m) => {
            const p = m.kind === "FUT" ? m.price : m.strike;
            const n = seen.get(p) ?? 0;
            seen.set(p, n + 1);
            const x = r1(X(p));
            const y = H - B + 2 + n * 8;
            const el =
              m.kind === "FUT"
                ? s("rect", { x: x - 3, y: y + 1, width: 6, height: 6, class: `mk fut ${m.side === "SELL" ? "sell" : "buy"}`, "data-id": m.id ?? "" })
                : s("path", { d: `M${x - 4.5},${y + 7.5}L${x},${y}L${x + 4.5},${y + 7.5}Z`, class: `mk ${m.right === "CE" ? "call" : "put"} ${m.side === "SELL" ? "sell" : "buy"}`, "data-id": m.id ?? "" });
            el.append(s("title", {}, m.title ?? ""));
            if (hiMarker && m.id === hiMarker) el.classList.add("hi");
            return el;
          }),
      );
    }
    // Spot: a thin solid line and a contrast pill at the top.
    const sx = X(d.spot);
    const spotIn = d.spot >= d.lo && d.spot <= d.hi;
    set(spotLine, { x1: r1(sx), x2: r1(sx), y1: T, y2: H - B, visibility: spotIn ? "visible" : "hidden" });
    paintPill(pSpot, sx, T - 13, formatFixed(d.spot, 1), { show: spotIn });
    // Breakevens: rings on the zero line; labels in a pill row below the axis (never on a curve).
    const bes = (d.breakevens ?? []).filter((b) => b > d.lo && b < d.hi);
    const beKey = `${W}|${bes.map((b) => r1(X(b))).join(",")}|${r1(zy)}`;
    if (beDots.__sig !== beKey) {
      beDots.__sig = beKey;
      beDots.replaceChildren(...bes.map((b) => s("circle", { cx: r1(X(b)), cy: r1(zy), r: 3.5, class: "be-dot" })));
      const items = bes.map((b) => {
        const pct = d.spot ? ((b - d.spot) / d.spot) * 100 : null;
        const t = W < 480 ? formatInt(b) : `${formatInt(b)} (${formatSigned(pct, 1)}%)`;
        return { x: X(b), w: t.length * 6.1 + 18, text: t };
      });
      const placed = O.placeLabels(items, { gap: 6, maxShift: 30, lo: L, hi: W - R, prefix: "" });
      bePills.replaceChildren(
        ...placed.map((p) => {
          const label = `BE ${p.text}`;
          const w = Math.round(label.length * 6.1 + 14);
          const x = Math.max(L, Math.min(W - R - w, p.x - w / 2));
          return s("g", { class: "cpill bep" }, s("rect", { x: r1(x), y: H - 19, width: w, height: 17, rx: 8.5 }), s("text", { x: r1(x + w / 2), y: H - 6.8, "text-anchor": "middle" }, label));
        }),
      );
    }
    placeHint();
    showCross(pinned ?? hover);
  }

  function summaryLabel() {
    const st = v.stats;
    if (!st) return "Payoff chart";
    const mp = st.maxProfit === null ? "unlimited" : money(st.maxProfit, { signed: false });
    const ml = st.maxLoss === null ? "unlimited" : money(st.maxLoss, { signed: false });
    const be = st.breakevens.length ? `breakevens ${st.breakevens.map((b) => formatInt(Math.round(b))).join(" and ")}` : "no breakeven";
    return `Payoff at expiry: max profit ${mp}, max loss ${ml}, ${be}. The hero figures and the P&L table have the same numbers.`;
  }

  // ── Crosshair and tooltip ──
  let tipRowsSig = "";
  function showCross(p) {
    if (!d || p === null || p === undefined || !v) {
      for (const el of [cross, dotE, dotT, dotN]) el.setAttribute("visibility", "hidden");
      tip.classList.remove("on", "pinned");
      return;
    }
    const ve = atOn(d.xs, d.expiry, p);
    const vt = atOn(d.xs, d.target, p);
    const vm = atOn(d.xs, d.mid, p);
    const vn = atOn(d.xs, d.now, p);
    const vh = atOn(d.xs, d.hedge, p);
    const cx = r1(X(p));
    set(cross, { x1: cx, x2: cx, y1: T, y2: H - B, visibility: "visible" });
    const clampY = (val) => r1(Y(Math.max(d.yMin, Math.min(d.yMax, val))));
    if (ve === null) dotE.setAttribute("visibility", "hidden");
    else set(dotE, { cx, cy: clampY(ve), visibility: "visible", class: `dot-exp ${ve >= 0 ? "pos" : "neg"}` });
    if (vt === null) dotT.setAttribute("visibility", "hidden");
    else set(dotT, { cx, cy: clampY(vt), visibility: "visible" });
    if (vn === null) dotN.setAttribute("visibility", "hidden");
    else set(dotN, { cx, cy: clampY(vn), visibility: "visible" });
    // The card: price, move and σ; the curves; P(close above).
    const pct = v.spot ? ((p - v.spot) / v.spot) * 100 : null;
    const z = O.sigmaZ(p, v.forward, v.ivPct, v.horizon);
    text(tipPrice, formatInt(p));
    text(tipMove, `${formatSigned(pct, 1)}%${isFigure(z) ? ` · ${formatSigned(z, 1)}σ` : ""}`);
    const below = v.prob === "below";
    const above = below ? O.probBelow(p, v.forward, v.horizon, v.ivPct) : O.probAbove(p, v.forward, v.horizon, v.ivPct);
    const docked = coarse();
    const short = (t) => (docked ? String(t).replace(/ \(.*\)$/, "") : t);
    const rows = [
      vn !== null ? ["now", short(v.labels?.now ?? "Now"), vn] : null,
      vt !== null ? ["target", short(v.labels?.target ?? "Target"), vt] : null,
      vm !== null ? ["mid", short(v.labels?.mid ?? "Mid-date"), vm] : null,
      ["expiry", v.labels?.expiryShort ?? "Expiry", ve],
      vh !== null ? ["hedge", short(v.labels?.hedge ?? "Hedged"), vh] : null,
      v.compare ? ["cmp", v.compare.label, atOn(d.xs, d.compare.vals, p)] : null,
    ].filter(Boolean);
    const sig = rows.map((r) => `${r[0]}:${r[1]}`).join() + (above !== null ? `|p${docked}${below}` : "");
    if (tipRowsSig !== sig) {
      tipRowsSig = sig;
      tipRows.replaceChildren(...rows.map((r) => h("div", { class: `tip-row ${r[0]}` }, h("span", { class: "tip-k" }, h("i", { class: `tip-sw ${r[0]}` }), r[1]), h("span", { class: "tip-v" }))), ...(above !== null ? [h("div", { class: "tip-row prob" }, h("span", { class: "tip-k", title: below ? "Chance of closing below this price" : "Chance of closing above this price" }, docked ? (below ? "P↓" : "P↑") : below ? "P(close below)" : "P(close above)"), h("span", { class: "tip-v" }))] : []));
    }
    rows.forEach((r, i) => {
      const cell = tipRows.children[i].lastChild;
      text(cell, money(r[2]));
      cell.className = `tip-v ${r[2] > 0.5 ? "up" : r[2] < -0.5 ? "down" : ""}`.trim();
    });
    if (above !== null) text(tipRows.lastChild.lastChild, `${formatInt(Math.round(above * 100))}%`);
    tip.classList.add("on");
    tip.classList.toggle("pinned", pinned !== null);
    tip.classList.toggle("docked", docked);
    if (!docked) {
      const rect = svg.getBoundingClientRect();
      const sc = rect.width ? rect.width / W : 1;
      const tw = tip.offsetWidth || 180;
      const th = tip.offsetHeight || 90;
      let left = cx * sc + 14;
      if (left + tw > rect.width - 4) left = cx * sc - tw - 14;
      const yy = Math.min(H - B, Math.max(T, ve === null ? T : clampY(ve))) * sc;
      let top = yy - th - 12;
      if (top < 4) top = yy + 14;
      tip.style.transform = `translate(${Math.round(Math.max(4, left))}px, ${Math.round(Math.max(4, Math.min(rect.height - th - 4, top)))}px)`;
    } else tip.style.transform = "";
    live.textContent = `${formatInt(p)}: ${vn !== null ? `now ${money(vn)}, ` : ""}expiry ${money(ve)}${vt !== null ? `, target ${money(vt)}` : ""}`;
  }
  function setPin(p) {
    pinned = p;
    showCross(pinned ?? hover);
    onPin?.(pinned);
  }

  const priceAt = (e) => {
    const r = svg.getBoundingClientRect();
    return P(((e.clientX - r.left) / r.width) * W);
  };
  const dropHint = () => {
    if (!hint.hidden) {
      hint.hidden = true;
      markHinted();
    }
  };
  let dragging = false;
  svg.addEventListener("pointermove", (e) => {
    if (!v) return;
    if (e.pointerType === "mouse" && pinned === null) {
      hover = priceAt(e);
      dropHint();
      showCross(hover);
    } else if (dragging) setPin(priceAt(e));
  });
  svg.addEventListener("pointerleave", () => {
    hover = null;
    if (pinned === null) showCross(null);
  });
  svg.addEventListener("pointerdown", (e) => {
    if (!v || e.pointerType === "mouse") return;
    dragging = true;
    dropHint();
    setPin(priceAt(e));
  });
  const stopDrag = () => (dragging = false);
  svg.addEventListener("pointerup", stopDrag);
  svg.addEventListener("pointercancel", stopDrag);
  svg.addEventListener("click", (e) => {
    if (!v || e.pointerType !== "mouse") return;
    setPin(pinned === null ? priceAt(e) : null);
    if (pinned === null) showCross(priceAt(e));
  });
  marks.addEventListener("pointerover", (e) => {
    const m = e.target.closest?.(".mk");
    if (m) onMarker?.(m.getAttribute("data-id") || null);
  });
  marks.addEventListener("pointerout", (e) => {
    if (e.target.closest?.(".mk")) onMarker?.(null);
  });
  const outside = (e) => {
    if (pinned !== null && !plotWrap.contains(e.target) && e.pointerType !== "mouse" && !e.target.closest?.(".scen-grid, .sg-card")) setPin(null);
  };
  document.addEventListener("pointerdown", outside, true);
  svg.addEventListener("keydown", (e) => {
    if (!v) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const base = pinned ?? v.spot;
      setPin(Math.max(v.lo, Math.min(v.hi, base + (e.key === "ArrowRight" ? 1 : -1) * step() * (e.shiftKey || e.altKey ? 5 : 1))));
    } else if (e.key === "Escape" && pinned !== null) {
      e.preventDefault();
      e.stopPropagation();
      setPin(null);
    }
  });

  // ── Morph (§4.5): resample the drawn curves onto the new xs and tween values and ranges together ──
  function startMorph(from, to) {
    cancelAnimationFrame(tween);
    const rs = (vals) => (vals ? to.xs.map((p) => atOn(from.xs, vals, p)) : null);
    const a = { lo: from.lo, hi: from.hi, yMin: from.yMin, yMax: from.yMax, expiry: rs(from.expiry), target: rs(from.target), mid: rs(from.mid), density: rs(from.density), now: rs(from.now), hedge: rs(from.hedge) };
    const t0 = performance.now();
    const lerp = (x, y, t) => x + (y - x) * t;
    const lerpA = (x, y, t) => (x && y ? y.map((val, i) => (val === null || x[i] === null ? val : lerp(x[i], val, t))) : y);
    const frame = (now) => {
      const t = ease(Math.min(1, (now - t0) / MORPH_MS));
      d = { ...to, lo: lerp(a.lo, to.lo, t), hi: lerp(a.hi, to.hi, t), yMin: lerp(a.yMin, to.yMin, t), yMax: lerp(a.yMax, to.yMax, t), expiry: lerpA(a.expiry, to.expiry, t), target: lerpA(a.target, to.target, t), mid: lerpA(a.mid, to.mid, t), density: lerpA(a.density, to.density, t), now: lerpA(a.now, to.now, t), hedge: lerpA(a.hedge, to.hedge, t) };
      paint();
      if (t < 1) tween = requestAnimationFrame(frame);
      else {
        tween = 0;
        d = v;
        paint();
      }
    };
    tween = requestAnimationFrame(frame);
  }
  /** First legs: the expiry line draws itself, the areas fade in and the markers pop, staggered. */
  function drawIn() {
    lineReveal([lineEUp, lineEDn, lineN], [areaUp, areaDn, ribbon, ribbonPos]);
    if (reducedMotion()) return;
    [...marks.childNodes].forEach((m, i) => m.animate?.([{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "scale(1)" }], { duration: 240, delay: 120 + i * 30, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "backwards" }));
  }

  const ro =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          const w = Math.round(plotWrap.clientWidth);
          if (w && (w !== W || heightFor() !== H)) {
            sizeOf();
            xAxis.__sig = beDots.__sig = marks.__sig = bandLabels.__sig = ribbonClip.__sig = "";
            gridKey = "";
            if (d) paint();
          }
        })
      : null;
  ro?.observe(host);
  sizeOf();

  return {
    tools,
    /** @param {object} view payoffModel output plus markers, perLeg, compare, labels, showDist, yMode, yScale, highlight */
    update(view, { animate = false } = {}) {
      const prev = d;
      const wasEmpty = !v;
      v = view;
      plotWrap.hidden = false;
      headEl.hidden = false;
      empty.hidden = true;
      if (Math.round(plotWrap.clientWidth) && (Math.round(plotWrap.clientWidth) !== W || heightFor() !== H)) {
        sizeOf();
        xAxis.__sig = beDots.__sig = marks.__sig = bandLabels.__sig = "";
        gridKey = "";
      }
      if (pinned !== null && (pinned < v.lo || pinned > v.hi)) pinned = null;
      lgT.el.hidden = !v.target;
      lgM.el.hidden = !v.mid;
      lgB1.el.hidden = !v.band1;
      lgB2.el.hidden = !v.band2;
      lgC.el.hidden = !v.compare;
      lgN.el.hidden = !v.now;
      lgExp.el.hidden = Boolean(v.hideExpiry);
      svg.classList.toggle("no-exp", Boolean(v.hideExpiry));
      lgH.el.hidden = !v.hedge;
      text(lgN.t, v.labels?.now ?? "Now");
      text(lgH.t, v.labels?.hedge ?? "After hedge");
      text(lgExp.t, v.labels?.expiry ?? "Expiry");
      text(lgT.t, v.labels?.target ?? "Target");
      text(lgM.t, v.labels?.mid ?? "Mid-date");
      text(lgC.t, v.compare?.label ?? "Saved");
      const hadT = Boolean(prev?.target);
      const hadM = Boolean(prev?.mid);
      if (animate && prev && !wasEmpty && !reducedMotion() && typeof requestAnimationFrame === "function") startMorph(prev, v);
      else {
        cancelAnimationFrame(tween);
        tween = 0;
        d = v;
        paint();
      }
      if (wasEmpty) {
        drawIn();
        hint.hidden = hinted();
        hint.textContent = coarse() ? `${touchWord()} or drag to read P&L` : `Hover to read P&L${keyHint(" · ← → on the chart")}`;
        if (d) placeHint();
      } else if (!tween && !reducedMotion()) {
        if (v.target && !hadT && prev) lineReveal(lineT);
        if (v.mid && !hadM && prev) lineReveal(lineM);
      }
      const label = v.ariaLabel ?? summaryLabel();
      if (svg.getAttribute("aria-label") !== label) svg.setAttribute("aria-label", label);
    },
    /** Nothing to draw: a ghost payoff with a line of text and an optional action (a node). */
    empty({ text: t = "", sub = null, action = null } = {}) {
      cancelAnimationFrame(tween);
      v = null;
      d = null;
      pinned = null;
      plotWrap.hidden = true;
      headEl.hidden = true;
      empty.hidden = false;
      empty.style.height = `${heightFor()}px`;
      ghostText.textContent = t;
      ghostSub.replaceChildren(...[sub, action].filter(Boolean));
      tip.classList.remove("on");
    },
    /** Pin the crosshair at a price (a grid cell, a suggestion's target), or unpin with null. */
    pin(p) {
      if (!v) return;
      pinned = p === null || p === undefined ? null : Math.max(v.lo, Math.min(v.hi, p));
      showCross(pinned ?? hover);
    },
    /** Ring one strike marker (a hovered leg row), or none with null. */
    highlightMarker(mid) {
      hiMarker = mid ?? null;
      for (const m of marks.childNodes) m.classList?.toggle("hi", Boolean(hiMarker) && m.getAttribute("data-id") === hiMarker);
    },
    highlight(legId) {
      if (!v || v.highlight === legId) return;
      v.highlight = legId;
      if (d && d !== v) d.highlight = legId;
      if (!tween && d) paint();
    },
    destroy() {
      cancelAnimationFrame(tween);
      ro?.disconnect();
      document.removeEventListener("pointerdown", outside, true);
    },
  };
}
