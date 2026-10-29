// The Volatility page's two small curves: the smile (IV by strike, moneyness or delta) and the term structure (ATM IV
// by expiry). Purpose-built SVG, no chart library: the owner's chart engine is for price/time charts, not these.
//
// smileSvg(data, opts) -> <svg> with .mark(strike) to move the shared highlight without a rebuild.
// termSvg(rows, opts)  -> <svg>.
// Both are rebuilt only when their inputs change (vol.js memoises by chain identity and settings).
import { DASH, formatFixed, formatInt, formatPercent } from "./format.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const r1 = (v) => Math.round(v * 10) / 10;
function s(tag, attrs, ...children) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== undefined && v !== null && v !== false) e.setAttribute(k, String(v));
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

/** Round axis values (1, 2, 2.5 or 5 × 10^n) covering [lo, hi] (as payoff.js; copied so the files stay independent). */
function niceTicks(lo, hi, count) {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / Math.max(1, count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

/** Delta-axis ticks: [x, label]; x = 1 − call delta, so puts sit on the left as on the strike axis. */
const DELTA_TICKS = [[0.1, "10Δ P"], [0.25, "25Δ P"], [0.5, "50Δ"], [0.75, "25Δ C"], [0.9, "10Δ C"]];

/** Where a point sits on the chosen axis (null when it has no position there). */
export function smileX(p, axis) {
  if (axis === "m") return p.m;
  if (axis === "delta") return p.callDelta === null || p.callDelta === undefined ? null : 1 - p.callDelta;
  return p.strike;
}

/**
 * The smile.
 * @param {{ points: object[], markers: { F?: object, lo?: object, hi?: object, spot?: object }, compare?: { points: object[], label: string }|null,
 *   step: number|null }} data  markers are { strike, m, delta } positions (delta already 1 − call delta)
 * @param {{ x: "strike"|"m"|"delta", series: { otm: boolean, ce: boolean, pe: boolean }, width: number, height: number, coarse?: boolean,
 *   label: string, onPick?: (strike: number|null, how: "hover"|"tap"|"leave") => void, empty?: string }} o
 */
export function smileSvg(data, o) {
  const W = Math.max(240, Math.round(o.width));
  const H = Math.max(160, Math.round(o.height));
  const L = 40;
  const R = 14;
  const T = 14;
  const B = 24;
  const svg = s("svg", { class: "vol-svg smile", viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": o.label });
  const axis = o.x;
  const pts = (data.points ?? []).filter((p) => smileX(p, axis) !== null);
  const val = (p, k) => (k === "otm" ? p.otm?.iv ?? null : p[k]?.iv ?? null);
  const keys = ["otm", "ce", "pe"].filter((k) => o.series[k]);
  const comp = (data.compare?.points ?? []).filter((p) => p.otm && smileX(p, axis) !== null);
  const ys = [...pts.flatMap((p) => keys.map((k) => val(p, k))), ...comp.map((p) => p.otm.iv)].filter((v) => v !== null);
  if (!ys.length) {
    svg.append(s("text", { x: W / 2, y: H / 2, class: "vol-svg-empty", "text-anchor": "middle" }, o.empty ?? "No IV to plot"));
    svg.mark = () => {};
    return svg;
  }
  const xs = [...pts, ...comp].map((p) => smileX(p, axis));
  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  if (axis === "delta") {
    x0 = Math.min(x0, 0.05);
    x1 = Math.max(x1, 0.95);
  }
  if (x1 === x0) x1 = x0 + 1;
  const yt0 = niceTicks(Math.min(...ys) - 1, Math.max(...ys) + 1, 5);
  const y0 = Math.min(yt0[0], Math.min(...ys) - 1);
  const y1 = Math.max(yt0[yt0.length - 1], Math.max(...ys) + 1);
  const X = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R);
  const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const plotB = H - B;

  // Grid and axes.
  const grid = s("g", { class: "grid" });
  for (const v of yt0.filter((v) => v >= y0 && v <= y1)) {
    grid.append(s("line", { x1: L, x2: W - R, y1: r1(Y(v)), y2: r1(Y(v)) }), s("text", { x: L - 6, y: r1(Y(v) + 3.5), class: "axis", "text-anchor": "end" }, `${formatInt(v)}%`));
  }
  const xticks =
    axis === "delta"
      ? DELTA_TICKS.filter(([v]) => v >= x0 && v <= x1)
      : niceTicks(x0, x1, Math.max(3, Math.min(8, Math.floor((W - L - R) / 80))))
          .filter((v) => v > x0 && v < x1)
          .map((v) => [v, axis === "m" ? `${v > 0 ? "+" : ""}${formatInt(v)}%` : formatInt(v)]);
  for (const [v, t] of xticks) grid.append(s("text", { x: r1(X(v)), y: H - 7, class: "axis", "text-anchor": "middle" }, t));
  svg.append(grid);

  // ±1σ band, spot, F.
  const mk = data.markers ?? {};
  const at = (m) => (m ? (axis === "m" ? m.m : axis === "delta" ? m.delta : m.strike) : null);
  const lo = at(mk.lo);
  const hi = at(mk.hi);
  if (lo !== null && hi !== null && Number.isFinite(lo) && Number.isFinite(hi)) {
    const a = Math.max(x0, Math.min(lo, hi));
    const b = Math.min(x1, Math.max(lo, hi));
    if (b > a) svg.append(s("rect", { class: "band", x: r1(X(a)), y: T, width: r1(X(b) - X(a)), height: plotB - T }), s("text", { class: "band-label", x: r1(X(b) - 4), y: T + 10, "text-anchor": "end" }, "±1σ"));
  }
  const vline = (m, cls, label, anchor) => {
    const v = at(m);
    if (v === null || !Number.isFinite(v) || v < x0 || v > x1) return;
    svg.append(s("line", { class: cls, x1: r1(X(v)), x2: r1(X(v)), y1: T, y2: plotB }));
    if (label) svg.append(s("text", { class: `${cls}-label`, x: r1(X(v) + (anchor === "end" ? -4 : 4)), y: plotB - 5, "text-anchor": anchor ?? "start" }, label));
  };
  vline(mk.spot, "spot-line", mk.spot ? "Spot" : null, "end");
  vline(mk.F, "f-line", mk.F ? `F ${formatInt(mk.F.strike)}` : null);

  // Lines: no join across an out point gap of more than 2 strikes.
  const step = data.step ?? null;
  const path = (list, key) => {
    let d = "";
    let prev = null;
    for (const p of list) {
      const v = val(p, key);
      if (v === null) continue;
      const gapTooBig = prev && step ? p.strike - prev.strike > 2 * step + 1e-9 : false;
      d += `${!prev || gapTooBig ? "M" : "L"}${r1(X(smileX(p, axis)))} ${r1(Y(v))}`;
      prev = p;
    }
    return d;
  };
  const endLabel = (list, key, text, cls) => {
    const last = [...list].reverse().find((p) => val(p, key) !== null);
    if (!last) return null;
    const x = X(smileX(last, axis));
    return s("text", { class: `end-label ${cls}`, x: r1(Math.min(x, W - R) - 2), y: r1(Y(val(last, key)) - 6), "text-anchor": "end" }, text);
  };
  if (comp.length) {
    svg.append(s("path", { class: "series compare", d: path(comp, "otm") }));
    const lab = endLabel(comp, "otm", data.compare.label, "compare");
    if (lab) svg.append(lab);
  }
  const NAMES = { otm: "OTM", ce: "CE", pe: "PE" };
  const multi = keys.length > 1;
  for (const k of keys) {
    svg.append(s("path", { class: `series ${k}`, d: path(pts, k) }));
    if (multi || comp.length) {
      const lab = endLabel(pts, k, NAMES[k], k);
      if (lab) svg.append(lab);
    }
  }
  // Points: filled when priced from a tight mid, hollow from a wide quote or the LTP. Out points are not drawn.
  const r = o.coarse ? 3.5 : 2.5;
  const dots = s("g", { class: "dots" });
  for (const k of keys) {
    for (const p of pts) {
      const v = val(p, k);
      if (v === null) continue;
      const q = k === "otm" ? p.otm.q : p[k].q;
      dots.append(s("circle", { class: `dot ${k}${q === "mid" ? "" : " hollow"}`, cx: r1(X(smileX(p, axis))), cy: r1(Y(v)), r }));
    }
  }
  svg.append(dots);

  // The shared highlight (a ring and a vertical hairline), moved by .mark().
  const hlLine = s("line", { class: "hl-line", y1: T, y2: plotB, visibility: "hidden" });
  const hlRing = s("circle", { class: "hl-ring", r: r + 3, visibility: "hidden" });
  svg.append(hlLine, hlRing);
  svg.mark = (strike) => {
    const p = strike === null || strike === undefined ? null : pts.find((q) => q.strike === strike);
    const key = p ? keys.find((k) => val(p, k) !== null) : null;
    if (!p || !key) {
      hlLine.setAttribute("visibility", "hidden");
      hlRing.setAttribute("visibility", "hidden");
      return;
    }
    const x = r1(X(smileX(p, axis)));
    hlLine.setAttribute("x1", x);
    hlLine.setAttribute("x2", x);
    hlRing.setAttribute("cx", x);
    hlRing.setAttribute("cy", r1(Y(val(p, key))));
    hlLine.setAttribute("visibility", "visible");
    hlRing.setAttribute("visibility", "visible");
  };

  // Pointer: the nearest point by x.
  if (o.onPick) {
    const drawn = pts.filter((p) => keys.some((k) => val(p, k) !== null));
    const nearest = (e) => {
      const box = svg.getBoundingClientRect();
      if (!box.width || !drawn.length) return null;
      const vx = ((e.clientX - box.left) / box.width) * W;
      let best = null;
      let bd = Infinity;
      for (const p of drawn) {
        const d = Math.abs(X(smileX(p, axis)) - vx);
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      return best?.strike ?? null;
    };
    svg.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse") o.onPick(nearest(e), "hover");
    });
    svg.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "mouse") o.onPick(null, "leave");
    });
    svg.addEventListener("click", (e) => o.onPick(nearest(e), "tap"));
  }
  return svg;
}

/**
 * The term structure: ATM IV against √DTE (weeklies do not bunch), short dates under the points.
 * @param {{ expiry: string, days: number, atmIv: number|null, dim: boolean, monthly: boolean, skew?: object, label: string }[]} rows
 * @param {{ selected: string|null, wings: boolean, width: number, height: number, coarse?: boolean, label: string,
 *   onPick?: (expiry: string) => void }} o
 */
export function termSvg(rows, o) {
  const W = Math.max(220, Math.round(o.width));
  const H = Math.max(150, Math.round(o.height));
  const L = 40;
  const R = 18;
  const T = 16;
  const B = 26;
  const svg = s("svg", { class: "vol-svg term", viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": o.label });
  const use = rows.filter((r) => r.atmIv !== null && r.days !== null);
  if (!use.length) {
    svg.append(s("text", { x: W / 2, y: H / 2, class: "vol-svg-empty", "text-anchor": "middle" }, "Loading expiries…"));
    return svg;
  }
  const wing = (r, k) => (o.wings ? r.skew?.[k]?.iv ?? null : null);
  const ys = use.flatMap((r) => [r.atmIv, wing(r, "put25"), wing(r, "call25")]).filter((v) => v !== null);
  const sx = use.map((r) => Math.sqrt(Math.max(r.days, 0)));
  let x0 = Math.min(...sx);
  let x1 = Math.max(...sx);
  const pad = (x1 - x0) * 0.06 || 0.5;
  x0 = Math.max(0, x0 - pad);
  x1 += pad;
  const yt = niceTicks(Math.min(...ys) - 1, Math.max(...ys) + 1, 5);
  const y0 = Math.min(yt[0], Math.min(...ys) - 1);
  const y1 = Math.max(yt[yt.length - 1], Math.max(...ys) + 1);
  const X = (d) => L + ((Math.sqrt(Math.max(d, 0)) - x0) / (x1 - x0)) * (W - L - R);
  const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const grid = s("g", { class: "grid" });
  for (const v of yt.filter((v) => v >= y0 && v <= y1)) grid.append(s("line", { x1: L, x2: W - R, y1: r1(Y(v)), y2: r1(Y(v)) }), s("text", { x: L - 6, y: r1(Y(v) + 3.5), class: "axis", "text-anchor": "end" }, `${formatInt(v)}%`));
  // Date labels, skipping any that would touch the previous one.
  let lastX = -Infinity;
  for (const r of use) {
    const x = X(r.days);
    if (x - lastX < 38) continue;
    lastX = x;
    grid.append(s("text", { x: r1(x), y: H - 8, class: "axis", "text-anchor": "middle" }, r.label));
  }
  svg.append(grid);
  const line = (k, cls) => {
    const d = use
      .map((r) => [r, k === "atm" ? r.atmIv : wing(r, k)])
      .filter(([, v]) => v !== null)
      .map(([r, v], i) => `${i ? "L" : "M"}${r1(X(r.days))} ${r1(Y(v))}`)
      .join("");
    if (d) svg.append(s("path", { class: `series ${cls}`, d }));
  };
  if (o.wings) {
    line("put25", "wing put");
    line("call25", "wing call");
    const lastP = [...use].reverse().find((r) => wing(r, "put25") !== null);
    const lastC = [...use].reverse().find((r) => wing(r, "call25") !== null);
    if (lastP) svg.append(s("text", { class: "end-label", x: r1(X(lastP.days) - 4), y: r1(Y(wing(lastP, "put25")) - 6), "text-anchor": "end" }, "25Δ P"));
    if (lastC) svg.append(s("text", { class: "end-label", x: r1(X(lastC.days) - 4), y: r1(Y(wing(lastC, "call25")) + 13), "text-anchor": "end" }, "25Δ C"));
  }
  line("atm", "otm");
  const rad = o.coarse ? 4.5 : 3.5;
  for (const r of use) {
    const cx = r1(X(r.days));
    const cy = r1(Y(r.atmIv));
    const g = s("g", { class: `term-pt${r.expiry === o.selected ? " sel" : ""}`, "data-expiry": r.expiry });
    g.append(s("title", {}, `${r.label}: ATM IV ${formatPercent(r.atmIv, 1)}${r.dim ? " (expiry day)" : ""}`));
    if (r.expiry === o.selected) g.append(s("circle", { class: "ring", cx, cy, r: rad + 4 }));
    g.append(s("circle", { class: `dot otm${r.dim ? " hollow" : ""}`, cx, cy, r: rad }));
    if (r.monthly) g.append(s("text", { class: "m-tag", x: cx, y: r1(cy - rad - 5), "text-anchor": "middle" }, "M"));
    // A generous invisible target for pointers and fingers.
    g.append(s("circle", { class: "hit", cx, cy, r: o.coarse ? 22 : 14 }));
    svg.append(g);
  }
  if (use.length === 1) svg.append(s("text", { x: W / 2, y: T + 12, class: "vol-svg-empty", "text-anchor": "middle" }, "Needs 2 expiries for a curve"));
  if (o.onPick) {
    svg.addEventListener("click", (e) => {
      const g = e.target instanceof Element ? e.target.closest(".term-pt") : null;
      if (g?.dataset.expiry) o.onPick(g.dataset.expiry);
    });
  }
  return svg;
}

/** The smile's aria-label sentence. */
export function smileLabel({ expiryLabel, atmIv, rr25, n }) {
  const rr = rr25 === null || rr25 === undefined ? "not available" : `${rr25 >= 0 ? "plus" : "minus"} ${formatFixed(Math.abs(rr25), 1)} points`;
  return `Smile for ${expiryLabel}: ATM IV ${atmIv === null ? DASH : formatPercent(atmIv, 1)}, 25-delta put minus call ${rr}, ${formatInt(n)} strikes`;
}
