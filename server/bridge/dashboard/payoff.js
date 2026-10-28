// The strategy payoff chart: the only code that knows SVG for it. It draws a model from O.payoffModel (pure, tested)
// and patches the same nodes on every update (paths, ticks, markers), so a slider can redraw it every frame. When the
// owner's chart engine arrives it replaces drawPayoff() without touching the maths.
//
// drawPayoff(host, model, { onPin }) -> { update(model), destroy() }
//   Fine pointer: hover reads P&L at a price. Coarse pointer: tap pins the crosshair, drag moves it (vertical page
//   scroll still works: touch-action pan-y), a tap outside unpins. Keyboard: the chart is focusable; ← / → move the
//   pinned price one strike step (Shift: 10), Esc unpins.
import { h } from "./app.js";
import { DASH, formatCompact, formatInt, formatRupee, formatSigned, isFigure } from "./format.js";

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

/** Round axis values (1, 2, 2.5 or 5 × 10^n) covering [lo, hi]. */
export function niceTicks(lo, hi, count) {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / Math.max(1, count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

/** Rupees with a sign and no decimals; long values in Indian compact form (₹1.2L). */
export function money(v, { signed = true } = {}) {
  if (!isFigure(v)) return DASH;
  const n = Math.round(Number(v));
  const plain = formatRupee(Math.abs(n), 0);
  const body = plain.length > 7 ? `₹${formatCompact(Math.abs(n))}` : plain;
  return n > 0 && signed ? `+${body}` : n < 0 ? `-${body}` : body;
}
/** The same with the gain / loss colour. */
export const moneyEl = (v, opts) => h("span", { class: isFigure(v) && Math.round(v) > 0 ? "up" : isFigure(v) && Math.round(v) < 0 ? "down" : undefined }, money(v, opts));

const coarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
const mq = (q) => typeof matchMedia === "function" && matchMedia(q).matches;
/** 300 px on desktop, 260 on tablet, 220 on phone (PRD 02 §9). */
const heightFor = () => (mq("(max-width: 719px)") ? 220 : mq("(max-width: 1099px)") ? 260 : 300);

/**
 * @param {HTMLElement} host
 * @param {object|null} model  O.payoffModel(...) or null (nothing to draw)
 * @param {{ onPin?: (price: number|null) => void, step?: number }} [opts]
 */
export function drawPayoff(host, model, { onPin } = {}) {
  let m = model;
  let W = 720;
  let H = 300;
  const L = 58;
  const R = 12;
  const T = 18;
  const B = 44;
  let pinned = null;
  let hover = null;
  const id = `po${Math.random().toString(36).slice(2, 7)}`;
  const clipUp = s("rect", { x: 0, y: 0, width: 0, height: 0 });
  const clipDn = s("rect", { x: 0, y: 0, width: 0, height: 0 });
  const band1 = s("rect", { class: "band", visibility: "hidden" });
  const band2 = s("rect", { class: "band2", visibility: "hidden" });
  const grid = s("g", { class: "grid-g" });
  const xAxis = s("g", { class: "x-axis" });
  const areaUp = s("path", { class: "area-up", "clip-path": `url(#${id}-up)` });
  const areaDn = s("path", { class: "area-dn", "clip-path": `url(#${id}-dn)` });
  const zero = s("line", { class: "zero" });
  const lineT = s("path", { class: "line-today" });
  const lineE = s("path", { class: "line-exp" });
  const spotLine = s("line", { class: "mark-spot" });
  const spotLabel = s("text", { class: "mark-label spot", "text-anchor": "middle" });
  const beG = s("g", { class: "be-g" });
  const cross = s("line", { class: "cross", visibility: "hidden" });
  const dotE = s("circle", { r: 3.5, class: "dot-exp", visibility: "hidden" });
  const dotT = s("circle", { r: 3.5, class: "dot-today", visibility: "hidden" });
  const svg = s(
    "svg",
    { class: "payoff-svg", role: "img", tabindex: "0", focusable: "true", preserveAspectRatio: "none" },
    s("defs", {}, s("clipPath", { id: `${id}-up` }, clipUp), s("clipPath", { id: `${id}-dn` }, clipDn)),
    band2,
    band1,
    grid,
    xAxis,
    areaUp,
    areaDn,
    zero,
    lineT,
    lineE,
    spotLine,
    spotLabel,
    beG,
    cross,
    dotE,
    dotT,
  );
  const readout = h("div", { class: "payoff-readout", "aria-live": "off" });
  const legend = h("span", { class: "legend" }, h("i", { class: "exp" }), "Expiry", h("span", { class: "lg-target" }, h("i", { class: "today" }), "Target"), h("span", { class: "lg-band" }, h("i", { class: "band" }), "±1σ"));
  const empty = h("p", { class: "payoff-empty muted", hidden: true });
  const headEl = h("div", { class: "payoff-head" }, legend, readout);
  host.replaceChildren(headEl, svg, empty);

  const X = (p) => L + ((p - m.lo) / (m.hi - m.lo)) * (W - L - R);
  const Y = (v) => T + ((m.yMax - v) / (m.yMax - m.yMin)) * (H - T - B);
  const P = (px) => m.lo + ((Math.max(L, Math.min(W - R, px)) - L) / (W - L - R)) * (m.hi - m.lo);
  const path = (vals) => vals.map((v, i) => (v === null ? "" : `${i === 0 || vals[i - 1] === null ? "M" : "L"}${r1(X(m.xs[i]))},${r1(Y(v))}`)).join("");
  /** P&L at a price by linear interpolation of the sampled curve (exact between kinks; strikes are samples). */
  const at = (vals, p) => {
    if (!vals) return null;
    const xs = m.xs;
    let i = 1;
    while (i < xs.length - 1 && xs[i] < p) i += 1;
    const a = vals[i - 1];
    const b = vals[i];
    if (a === null || b === null) return null;
    const t = xs[i] === xs[i - 1] ? 0 : (p - xs[i - 1]) / (xs[i] - xs[i - 1]);
    return a + (b - a) * Math.max(0, Math.min(1, t));
  };
  const step = () => {
    const ks = m?.strikes ?? [];
    const gaps = ks.slice(1).map((k, i) => k - ks[i]).filter((d) => d > 0);
    return gaps.length ? Math.min(...gaps) : Math.max(1, Math.round((m.hi - m.lo) / 60));
  };

  function sizeOf() {
    const w = Math.max(280, Math.round(host.clientWidth || 720));
    W = w;
    H = heightFor();
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", String(W));
    svg.setAttribute("height", String(H));
  }

  function paint() {
    // Nothing to draw: only the outlined placeholder shows, at the chart's own height (no blank SVG, legend or readout).
    if (!m) {
      svg.style.display = "none";
      headEl.hidden = true;
      empty.style.height = `${heightFor()}px`;
      empty.hidden = false;
      return;
    }
    svg.style.display = "";
    headEl.hidden = false;
    empty.hidden = true;
    const zy = Y(0);
    set(clipUp, { width: W, height: Math.max(0, zy) });
    set(clipDn, { y: zy, width: W, height: Math.max(0, H - zy) });
    const band = (el, b) => {
      if (!b) return set(el, { visibility: "hidden" });
      const a = X(Math.max(m.lo, b[0]));
      const z = X(Math.min(m.hi, b[1]));
      set(el, { visibility: z > a ? "visible" : "hidden", x: r1(a), y: T, width: r1(Math.max(0, z - a)), height: H - T - B });
    };
    band(band1, m.band1);
    band(band2, m.band2);
    // y grid + labels
    let yt = niceTicks(m.yMin, m.yMax, 5);
    if (yt.length < 3) yt = niceTicks(m.yMin, m.yMax, 8);
    const ysig = `${W}x${H}|${yt.join(",")}|${m.yMin}|${m.yMax}`;
    if (grid.__sig !== ysig) {
      grid.__sig = ysig;
      grid.replaceChildren(...yt.map((v) => [s("line", { x1: L, x2: W - R, y1: r1(Y(v)), y2: r1(Y(v)), class: "grid" }), s("text", { x: L - 8, y: r1(Y(v) + 3.5), class: "axis", "text-anchor": "end" }, v === 0 ? "0" : formatCompact(v))]).flat());
    }
    // x ticks: round numbers, about one per 110 px
    const xt = niceTicks(m.lo, m.hi, Math.max(4, Math.min(8, Math.floor((W - L - R) / 90)))).filter((p) => p > m.lo && p < m.hi);
    const xsig = `${W}x${H}|${xt.join(",")}|${m.lo}|${m.hi}`;
    if (xAxis.__sig !== xsig) {
      xAxis.__sig = xsig;
      xAxis.replaceChildren(...xt.map((p) => s("text", { x: r1(X(p)), y: H - 26, class: "axis", "text-anchor": "middle" }, formatInt(p))));
    }
    const area = `M${r1(X(m.xs[0]))},${r1(zy)}${m.expiry.map((v, i) => `L${r1(X(m.xs[i]))},${r1(Y(v))}`).join("")}L${r1(X(m.xs[m.xs.length - 1]))},${r1(zy)}Z`;
    set(areaUp, { d: area });
    set(areaDn, { d: area });
    set(zero, { x1: L, x2: W - R, y1: r1(zy), y2: r1(zy) });
    set(lineE, { d: path(m.expiry) });
    set(lineT, { d: m.target ? path(m.target) : "", visibility: m.target ? "visible" : "hidden" });
    legend.querySelector(".lg-target").hidden = !m.target;
    legend.querySelector(".lg-band").hidden = !m.band1;
    const sx = X(m.spot);
    set(spotLine, { x1: r1(sx), x2: r1(sx), y1: T, y2: H - B });
    set(spotLabel, { x: r1(Math.max(L + 20, Math.min(W - R - 20, sx))), y: T - 6 });
    text(spotLabel, formatInt(m.spot));
    // Breakevens: dots on zero, labels under the axis row, staggered when closer than 44 px.
    const bes = m.breakevens.filter((b) => b > m.lo && b < m.hi);
    const besig = `${W}x${H}|${bes.map((b) => Math.round(b)).join(",")}|${r1(zy)}`;
    if (beG.__sig !== besig) {
      beG.__sig = besig;
      let lastX = -Infinity;
      let lane = 0;
      beG.replaceChildren(
        ...bes.flatMap((b) => {
          const bx = X(b);
          lane = bx - lastX < 44 ? 1 - lane : 0;
          lastX = bx;
          const lx = Math.max(L + 16, Math.min(W - R - 16, bx));
          return [
            s("line", { x1: r1(bx), x2: r1(bx), y1: r1(zy), y2: H - B + 2, class: "be-tick" }),
            s("circle", { cx: r1(bx), cy: r1(zy), r: 3.5, class: "be" }),
            s("text", { x: r1(lx), y: lane ? H - 2 : H - 13, class: "mark-label be-label", "text-anchor": "middle" }, formatInt(Math.round(b))),
          ];
        }),
      );
    }
    const label = summaryLabel();
    if (svg.getAttribute("aria-label") !== label) svg.setAttribute("aria-label", label);
    showCross(pinned ?? hover);
  }

  function summaryLabel() {
    const st = m.stats;
    if (!st) return "Payoff chart";
    const mp = st.maxProfit === null ? "unlimited" : money(st.maxProfit, { signed: false });
    const ml = st.maxLoss === null ? "unlimited" : money(st.maxLoss, { signed: false });
    const be = st.breakevens.length ? `breakevens ${st.breakevens.map((b) => formatInt(Math.round(b))).join(" and ")}` : "no breakeven";
    return `Payoff at expiry: max profit ${mp}, max loss ${ml}, ${be}. The scenario table has the same figures.`;
  }

  function showCross(p) {
    if (!m || p === null || p === undefined) {
      for (const el of [cross, dotE, dotT]) el.setAttribute("visibility", "hidden");
      readout.replaceChildren(h("span", { class: "muted" }, coarse() ? "Tap the chart to read P&L at a price" : "Hover the chart to read P&L at a price"));
      return;
    }
    const ve = at(m.expiry, p);
    const vt = at(m.target, p);
    const cx = r1(X(p));
    set(cross, { x1: cx, x2: cx, y1: T, y2: H - B, visibility: "visible" });
    for (const [el, v] of [[dotE, ve], [dotT, vt]]) {
      if (v === null) el.setAttribute("visibility", "hidden");
      else set(el, { cx, cy: r1(Y(Math.max(m.yMin, Math.min(m.yMax, v)))), visibility: "visible" });
    }
    const pct = m.spot ? ((p - m.spot) / m.spot) * 100 : null;
    readout.replaceChildren(
      h("strong", {}, formatInt(Math.round(p))),
      h("span", { class: "muted" }, ` (${formatSigned(pct, 1)}%)`),
      ...(vt !== null ? [h("span", { class: "muted" }, " Target "), moneyEl(vt)] : []),
      h("span", { class: "muted" }, " Expiry "),
      moneyEl(ve),
    );
  }

  const priceAt = (e) => {
    const r = svg.getBoundingClientRect();
    return P(((e.clientX - r.left) / r.width) * W);
  };
  let dragging = false;
  svg.addEventListener("pointermove", (e) => {
    if (!m) return;
    if (e.pointerType === "mouse" && pinned === null) {
      hover = priceAt(e);
      showCross(hover);
    } else if (dragging) {
      pinned = priceAt(e);
      showCross(pinned);
      onPin?.(pinned);
    }
  });
  svg.addEventListener("pointerleave", () => {
    hover = null;
    if (pinned === null) showCross(null);
  });
  svg.addEventListener("pointerdown", (e) => {
    if (!m || e.pointerType === "mouse") return;
    dragging = true;
    pinned = priceAt(e);
    showCross(pinned);
    onPin?.(pinned);
  });
  const stopDrag = () => (dragging = false);
  svg.addEventListener("pointerup", stopDrag);
  svg.addEventListener("pointercancel", stopDrag);
  svg.addEventListener("click", (e) => {
    if (!m || e.pointerType !== "mouse") return;
    pinned = pinned === null ? priceAt(e) : null;
    showCross(pinned ?? priceAt(e));
    onPin?.(pinned);
  });
  const outside = (e) => {
    if (pinned !== null && !svg.contains(e.target) && e.pointerType !== "mouse") {
      pinned = null;
      showCross(null);
      onPin?.(null);
    }
  };
  document.addEventListener("pointerdown", outside, true);
  svg.addEventListener("keydown", (e) => {
    if (!m) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const base = pinned ?? m.spot;
      pinned = Math.max(m.lo, Math.min(m.hi, base + (e.key === "ArrowRight" ? 1 : -1) * step() * (e.shiftKey ? 10 : 1)));
      showCross(pinned);
      onPin?.(pinned);
    } else if (e.key === "Escape" && pinned !== null) {
      e.preventDefault();
      e.stopPropagation();
      pinned = null;
      showCross(null);
      onPin?.(null);
    }
  });
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
    const w = Math.round(host.clientWidth);
    if (w && w !== W) {
      sizeOf();
      grid.__sig = xAxis.__sig = beG.__sig = "";
      paint();
    }
  }) : null;
  ro?.observe(host);
  sizeOf();
  paint();

  return {
    update(model2) {
      m = model2;
      if (m && pinned !== null && (pinned < m.lo || pinned > m.hi)) pinned = null;
      if (Math.round(host.clientWidth) && Math.round(host.clientWidth) !== W) sizeOf();
      paint();
    },
    empty(msg) {
      m = null;
      empty.textContent = msg;
      paint();
    },
    destroy() {
      ro?.disconnect();
      document.removeEventListener("pointerdown", outside, true);
    },
  };
}
