// OI Analysis › By strike › Strike PCR: put OI over call OI at each strike of the band, on a log axis around 1.00
// (each rule ten times the one below), green where puts outweigh calls and red where calls do. A ratio of two standing
// counts at one strike: the window does not move it (the hover says how it read at the window's start). Only the
// extremes print a figure (10 or more, 0.1 or less, or a side with nothing); every strike's exact ratio is on hover.
//
// The chart shares the By strike page's band, spot, ATM and selection (oi.js hands it the rows it draws). The view
// switch (OI bars | Strike PCR) is remembered in this browser. Pure model first (tested), then the drawing.
import { h } from "./app.js";
import { DASH, formatCompact, formatFixed, formatInt, isFigure } from "./format.js";
import { segmented } from "./views.js";
import { svgEl } from "./viz.js";

const num = (v) => (isFigure(v) ? Number(v) : null);
const VIEW_KEY = "mcb.dashboard.oi.chartView";
/** The chart is rebuilt at most this often (the page's live ticks arrive many times a second). */
const PAINT_MS = 500;

/** A strike's ratio: { v, kind } — "ratio", "inf" (puts, no calls), "zero" (calls, no puts) or "none" (neither). */
export function ratioOf(ce, pe) {
  const c = num(ce);
  const p = num(pe);
  if (c === null || p === null) return { v: null, kind: "none" };
  if (c > 0) return p > 0 ? { v: p / c, kind: "ratio" } : { v: 0, kind: "zero" };
  return p > 0 ? { v: Infinity, kind: "inf" } : { v: null, kind: "none" };
}

/** The ratio as printed: two decimals under 10, one to 100, none above; ∞ and 0 for an empty side. */
export function ratioText(r) {
  if (!r || r.kind === "none") return DASH;
  if (r.kind === "inf") return "∞";
  if (r.kind === "zero") return "0";
  return formatFixed(r.v, r.v >= 100 ? 0 : r.v >= 10 ? 1 : 2);
}

/**
 * The view's model (pure). `rows`: [{ strike, ce: { oi, ref }, pe: { oi, ref } }] in strike order (`ref` the OI at the
 * window's start, or null). Returns rows with `now` and `was` ratios and `extreme`, the decades the axis needs (at
 * least 0.1 to 10, at most 0.001 to 1000; a pinned reading rides the end rail), and the reading near the money:
 * the most put-heavy and most call-heavy strike within `near` strikes of ATM (finite ratios only) and how many of the
 * band's strikes are put-heavy (1.00 or more) and call-heavy.
 */
export function strikePcrModel(rows, { atm = null, near = 5 } = {}) {
  const out = (rows ?? []).map((r) => {
    const now = ratioOf(r.ce?.oi, r.pe?.oi);
    const was = ratioOf(r.ce?.ref, r.pe?.ref);
    const extreme = now.kind === "inf" || now.kind === "zero" || (now.kind === "ratio" && (now.v >= 10 || now.v <= 0.1));
    return { strike: Number(r.strike), ce: num(r.ce?.oi), pe: num(r.pe?.oi), now, was, extreme };
  });
  const finite = out.filter((r) => r.now.kind === "ratio").map((r) => Math.log10(r.now.v));
  const lo = Math.max(-3, Math.min(-1, Math.floor(Math.min(0, ...finite))));
  const hi = Math.min(3, Math.max(1, Math.ceil(Math.max(0, ...finite))));
  const ai = out.findIndex((r) => r.strike === atm);
  const nearRows = out.filter((r, i) => r.now.kind === "ratio" && (ai < 0 || Math.abs(i - ai) <= near));
  const pick = (better) => nearRows.reduce((b, r) => (!b || better(r.now.v, b.now.v) ? r : b), null);
  const putHeavy = pick((a, b) => a > b);
  const callHeavy = pick((a, b) => a < b);
  const counted = out.filter((r) => r.now.kind !== "none");
  return {
    rows: out,
    lo,
    hi,
    putHeavy: putHeavy && putHeavy.now.v >= 1 ? putHeavy : null,
    callHeavy: callHeavy && callHeavy.now.v < 1 ? callHeavy : null,
    puts: counted.filter((r) => r.now.v >= 1).length,
    calls: counted.filter((r) => r.now.v < 1).length,
  };
}

/** The reading in one line, for the chart's head. */
export function strikePcrLine(m) {
  if (!m?.rows?.length) return "No strikes to read";
  const parts = [];
  if (m.putHeavy) parts.push(`most put-heavy near the money ${formatInt(m.putHeavy.strike)} (${ratioText(m.putHeavy.now)})`);
  if (m.callHeavy) parts.push(`most call-heavy ${formatInt(m.callHeavy.strike)} (${ratioText(m.callHeavy.now)})`);
  const lead = `${formatInt(m.puts)} put-heavy, ${formatInt(m.calls)} call-heavy`;
  return parts.length ? `${lead} · ${parts.join(" · ")}` : lead;
}

/** The view switch's saved value: "bars" (the OI profile) or "pcr". A blocked store means "bars". */
export function savedView() {
  try {
    return localStorage.getItem(VIEW_KEY) === "pcr" ? "pcr" : "bars";
  } catch {
    return "bars";
  }
}
function saveView(v) {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* private window: the choice lasts this page only */
  }
}

/**
 * The chart: { el, toggle, legend, line, draw(input), select(k), get on }. `onView(view)` is told when the switch
 * changes; `onPick(strike)` when a column is clicked. `draw` takes { rows, atm, spot, winLabel } and only builds
 * while the view is on (the last input is kept and drawn when it is switched on).
 */
export function createStrikePcr({ onView, onPick }) {
  const box = h("div", { class: "oi-spcr-box" });
  const line = h("span", { class: "oi-spcr-line" });
  const el = h("div", { class: "oi-prof oi-spcr", role: "figure", "aria-label": "Strike PCR: put OI over call OI at each strike" }, h("div", { class: "oi-spcr-head" }, line), box);
  const toggle = segmented("Chart", [["bars", "OI bars"], ["pcr", "Strike PCR"]], savedView());
  toggle.classList.add("oi-chart-view");
  const legend = h(
    "ul",
    { class: "dv-legend oi-spcr-legend", "aria-label": "Strike PCR legend" },
    h("li", {}, h("span", { class: "oi-spcr-key pos", "aria-hidden": "true" }), "Put-heavy, 1.00 or more"),
    h("li", {}, h("span", { class: "oi-spcr-key neg", "aria-hidden": "true" }), "Call-heavy"),
    h("li", { class: "oi-spcr-note" }, "Log scale: each rule is 10× the one below"),
  );
  let view = savedView();
  let input = null;
  let sel = null;
  let lastW = 0;
  toggle.addEventListener("change", () => {
    if (toggle.value === view) return;
    view = toggle.value;
    saveView(view);
    sync();
    onView?.(view);
    if (view === "pcr") paint();
  });
  const sync = () => {
    el.hidden = view !== "pcr";
  };
  sync();

  // Live ticks reach the page often: the chart is rebuilt at most every PAINT_MS, and only when what it draws changed.
  let drawnSig = "";
  let queued = 0;
  let paintedAt = 0;
  function paint() {
    if (view !== "pcr" || !input || queued) return;
    const wait = Math.max(0, paintedAt + PAINT_MS - Date.now());
    queued = setTimeout(() => {
      queued = 0;
      paintedAt = Date.now();
      paintNow();
    }, wait);
  }
  function paintNow() {
    if (view !== "pcr" || !input) return;
    const W = Math.max(280, Math.floor(box.clientWidth || 640));
    const H = Math.max(180, Math.floor(box.clientHeight || 220));
    const sig = `${W}|${H}|${sel}|${input.atm}|${Math.round(num(input.spot) ?? 0)}|${input.winLabel ?? ""}|${(input.rows ?? []).map((r) => `${r.strike}:${r.ce?.oi}:${r.pe?.oi}:${r.ce?.ref}:${r.pe?.ref}`).join(",")}`;
    if (sig === drawnSig) return;
    drawnSig = sig;
    lastW = W;
    const m = strikePcrModel(input.rows, { atm: input.atm });
    if (line.textContent !== strikePcrLine(m)) line.textContent = strikePcrLine(m);
    const pad = { l: 44, r: 10, t: 18, b: 24 };
    const n = m.rows.length;
    const svg = svgEl("svg", { class: "oi-spcr-svg", width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Strike PCR, ${strikePcrLine(m)}` });
    if (!n) return box.replaceChildren(svg);
    const slot = (W - pad.l - pad.r) / n;
    const Y = (lg) => pad.t + ((m.hi - lg) / (m.hi - m.lo)) * (H - pad.t - pad.b);
    const y1 = Y(0);
    // Decade rules, 1.00 strongest; the end ticks carry ≥ / ≤ when a reading is pinned to the rail.
    const pinnedHi = m.rows.some((r) => r.now.kind === "inf" || (r.now.kind === "ratio" && Math.log10(r.now.v) > m.hi));
    const pinnedLo = m.rows.some((r) => r.now.kind === "zero" || (r.now.kind === "ratio" && Math.log10(r.now.v) < m.lo));
    for (let d = m.lo; d <= m.hi; d += 1) {
      const y = Y(d);
      const v = 10 ** d;
      const txt = `${d === m.hi && pinnedHi ? "≥" : d === m.lo && pinnedLo ? "≤" : ""}${formatFixed(v, d >= 2 ? 0 : d >= 0 ? 2 - d : Math.min(3, -d))}`;
      svg.append(svgEl("line", { class: d === 0 ? "oi-spcr-one" : "oi-spcr-rule", x1: pad.l, x2: W - pad.r, y1: y, y2: y }), svgEl("text", { class: d === 0 ? "oi-spcr-tick one" : "oi-spcr-tick", x: pad.l - 6, y: y + 4, "text-anchor": "end" }, txt));
    }
    const every = Math.max(1, Math.ceil(48 / slot));
    const ai = m.rows.findIndex((r) => r.strike === input.atm);
    m.rows.forEach((r, i) => {
      const x = pad.l + i * slot;
      const g = svgEl("g", { class: `oi-spcr-col${r.strike === input.atm ? " atm" : ""}${r.strike === sel ? " sel" : ""}`, "data-k": String(r.strike) });
      if (r.strike === input.atm || r.strike === sel) g.append(svgEl("rect", { class: "oi-spcr-band", x, y: pad.t, width: slot, height: H - pad.t - pad.b, rx: 4 }));
      if (r.now.kind !== "none") {
        const lg = r.now.kind === "inf" ? m.hi : r.now.kind === "zero" ? m.lo : Math.max(m.lo, Math.min(m.hi, Math.log10(r.now.v)));
        const y = Y(lg);
        const bw = Math.max(2, Math.min(18, slot * 0.62));
        const up = r.now.v >= 1;
        g.append(svgEl("rect", { class: `oi-spcr-bar ${up ? "pos" : "neg"}${r.now.kind !== "ratio" ? " pinned" : ""}`, x: x + (slot - bw) / 2, y: Math.min(y, y1), width: bw, height: Math.max(1, Math.abs(y - y1)), rx: 2 }));
        // The ratio at the window's start: a short rule across the column.
        if (r.was.kind === "ratio" && input.winLabel) {
          const yw = Y(Math.max(m.lo, Math.min(m.hi, Math.log10(r.was.v))));
          g.append(svgEl("line", { class: "oi-spcr-was", x1: x + (slot - bw) / 2 - 2, x2: x + (slot + bw) / 2 + 2, y1: yw, y2: yw }));
        }
        if (r.extreme) g.append(svgEl("text", { class: `oi-spcr-fig ${up ? "pos" : "neg"}`, x: x + slot / 2, y: up ? y - 4 : y + 13, "text-anchor": "middle" }, ratioText(r.now)));
      }
      const was = r.was.kind !== "none" && input.winLabel ? ` · ${ratioText(r.was)} at the window start (${input.winLabel})` : "";
      const q = (v) => (v === null ? DASH : typeof input.fmt === "function" ? `${input.fmt(v)}${input.unit ? ` ${input.unit}` : ""}` : formatCompact(v));
      g.append(svgEl("rect", { class: "oi-spcr-hit", x, y: 0, width: slot, height: H, fill: "transparent" }, svgEl("title", {}, `${formatInt(r.strike)}: puts ${q(r.pe)} ÷ calls ${q(r.ce)} = ${ratioText(r.now)}${r.now.kind === "ratio" ? (r.now.v >= 1 ? " (put-heavy)" : " (call-heavy)") : ""}${was}`)));
      if ((i - Math.max(0, ai)) % every === 0) g.append(svgEl("text", { class: `oi-spcr-k${i === ai ? " atm" : ""}`, x: x + slot / 2, y: H - 6, "text-anchor": "middle" }, formatInt(r.strike)));
      svg.append(g);
    });
    // Spot between the strikes either side of it.
    const s = num(input.spot);
    const j = s === null ? -1 : m.rows.findIndex((r) => r.strike > s);
    if (j > 0) {
      const a = m.rows[j - 1].strike;
      const b = m.rows[j].strike;
      const sx = pad.l + (j - 1) * slot + slot / 2 + ((s - a) / (b - a)) * slot;
      svg.append(svgEl("line", { class: "oi-spcr-spot", x1: sx, x2: sx, y1: pad.t - 6, y2: H - pad.b }), svgEl("text", { class: "oi-spcr-spot-t", x: sx, y: pad.t - 8, "text-anchor": "middle" }, `Spot ${formatFixed(s, 0)}`));
    }
    box.replaceChildren(svg);
  }
  box.addEventListener("click", (ev) => {
    const g = ev.target instanceof Element ? ev.target.closest("[data-k]") : null;
    if (g) onPick?.(Number(g.getAttribute("data-k")));
  });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => box.isConnected && Math.floor(box.clientWidth) !== lastW && paint()).observe(box);
  return {
    el,
    toggle,
    legend,
    line,
    get on() {
      return view === "pcr";
    },
    /** @param {{ rows: Array<object>, atm: number|null, spot: number|null, winLabel?: string, fmt?: (v: number) => string, unit?: string }} next */
    draw(next) {
      input = next;
      paint();
    },
    select(k) {
      if (sel === k) return;
      sel = k;
      paint();
    },
  };
}
