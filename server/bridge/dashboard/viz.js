// Shared data-visualisation pieces for the Options pages (docs/design/foundation.md §4 and §10.2): legend, bars, heat
// cells, SVG helpers, the spot / ATM contrast pill and a pointer + touch + keyboard scrubber. The colours, motion and
// sizes live in app.css (section 3c); the maths (seqStep, divStep, niceTicks, scaleRange) in options.js. Nothing here
// formats a number: callers pass text built with format.js.
import { h } from "./app.js";

const NS = "http://www.w3.org/2000/svg";
const SERIES = new Set(["call", "put", "pos", "neg", "iv", "spot", "today", "warn", "hv"]);

/** An SVG element with attributes (null / undefined skipped) and children. */
export function svgEl(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.setAttribute("class", String(v));
    else el.setAttribute(k, String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}

/**
 * A legend row above a plot: [{ label, token: "call"|"put"|"pos"|"neg"|"iv"|"spot"|"today"|"warn"|"hv",
 * kind: "swatch"|"line"|"dash"|"hatch", on?, onToggle? }]. With onToggle the item is a toggle button (off = 35 %).
 * Order calls before puts and positive before negative.
 */
export function legend(items, { label = "Legend" } = {}) {
  const ul = h("ul", { class: "dv-legend", "aria-label": label });
  for (const it of items ?? []) {
    if (!it) continue;
    const kind = ["line", "dash", "hatch"].includes(it.kind) ? it.kind : "swatch";
    const key = h("span", { class: `dv-key ${kind === "swatch" ? "" : kind}`.trim(), "aria-hidden": "true", "data-dv": SERIES.has(it.token) ? it.token : undefined });
    if (typeof it.onToggle === "function") {
      const b = h("button", { type: "button", "aria-pressed": String(it.on !== false) }, key, it.label);
      b.addEventListener("click", () => {
        const on = b.getAttribute("aria-pressed") !== "true";
        b.setAttribute("aria-pressed", String(on));
        it.onToggle(on);
      });
      ul.append(h("li", {}, b));
    } else ul.append(h("li", {}, key, h("span", {}, it.label)));
  }
  return ul;
}

/** The bar fraction for a value: 0 for zero / missing, at least 2 % (a visible sliver) for any non-zero value. */
export function barFraction(value, max) {
  const v = Math.abs(Number(value));
  const m = Math.abs(Number(max));
  if (!Number.isFinite(v) || !Number.isFinite(m) || v === 0 || m === 0) return 0;
  return Math.max(0.02, Math.min(1, v / m));
}

/**
 * A horizontal bar: <span class="dv-bar" data-dv="call">, length --v (0..1) as a scale so a refresh resizes it from
 * the old value. `decrease` draws the hatched outline mark (OI removed / unwinding); `rtl` grows it from the right.
 * Update an existing one with setBar(el, value, max).
 */
export function hbar({ value, max, side = "call", decrease = false, rtl = false, label = null } = {}) {
  const el = h("span", { class: `dv-bar${decrease ? " dec" : ""}${rtl ? " rtl" : ""}`, "data-dv": SERIES.has(side) ? side : "call", "aria-hidden": label ? undefined : "true", role: label ? "img" : undefined, "aria-label": label ?? undefined });
  setBar(el, value, max);
  return el;
}
export function setBar(el, value, max) {
  const v = String(Math.round(barFraction(value, max) * 1000) / 1000);
  if (el.style.getPropertyValue("--v") !== v) el.style.setProperty("--v", v);
  return el;
}

/** Paint a cell on the sequential (1..5) or diverging (−3..3) scale; null clears it (the cell then shows "--"). */
export function heatCell(el, step, kind = "seq") {
  const attr = kind === "div" ? "div" : "seq";
  const other = attr === "div" ? "seq" : "div";
  if (other in el.dataset) delete el.dataset[other];
  if (step === null || step === undefined || !Number.isFinite(Number(step))) {
    if (attr in el.dataset) delete el.dataset[attr];
    return el;
  }
  const s = String(Math.trunc(Number(step)));
  if (el.dataset[attr] !== s) el.dataset[attr] = s;
  el.classList.add("dv-heat");
  return el;
}

/**
 * The spot / ATM marker label on an SVG chart: a contrast pill (--sel-bg / --sel-fg) centred on x, clamped inside
 * [0, width]. Returns the <g>; update it with the same call on a refresh (it moves, its text changes).
 */
export function spotPill(svg, x, label, { y = 2, width = null, g = null } = {}) {
  const text = String(label ?? "");
  const w = Math.round(text.length * 6.4 + 14);
  const W = width ?? Number(svg.viewBox?.baseVal?.width) ?? 0;
  const left = W ? Math.max(0, Math.min(W - w, x - w / 2)) : x - w / 2;
  const grp = g ?? svgEl("g", { class: "dv-pill", "aria-hidden": "true" }, svgEl("rect", { rx: 9, ry: 9, height: 18 }), svgEl("text", { "text-anchor": "middle", "dominant-baseline": "central" }));
  const [rect, t] = grp.children;
  rect.setAttribute("x", String(left));
  rect.setAttribute("y", String(y));
  rect.setAttribute("width", String(w));
  t.setAttribute("x", String(left + w / 2));
  t.setAttribute("y", String(y + 9.5));
  if (t.textContent !== text) t.textContent = text;
  if (!grp.parentNode) svg.append(grp);
  return grp;
}

/**
 * A crosshair over a chart that follows the pointer (mouse, pen, touch) and the keyboard, with a tooltip that a click
 * or tap pins (Esc unpins). `host` is the positioned box that holds the chart. `steps` = number of x positions (a
 * number or a function); `at(i)` returns { x: px from the host's left, content: Node | string | Node[] } or null.
 * Keys: ← → one step, Shift + ← → ten, Home / End. Returns { set(i), clear(), destroy(), get index() }.
 */
export function scrubber(host, { steps, at, label = "Chart: use the arrow keys to read values" } = {}) {
  const count = () => Math.max(0, Math.floor(typeof steps === "function" ? steps() : steps) || 0);
  const cross = h("span", { class: "dv-cross", hidden: true, "aria-hidden": "true" });
  const tip = h("div", { class: "dv-tip", hidden: true, role: "status", "aria-live": "polite" });
  host.classList.add("dv-scrub");
  if (!host.hasAttribute("tabindex")) host.tabIndex = 0;
  host.setAttribute("aria-label", label);
  host.append(cross, tip);
  let index = -1;
  let pinned = false;
  function show(i) {
    const n = count();
    if (!n) return clear();
    index = Math.max(0, Math.min(n - 1, i));
    const r = at?.(index);
    if (!r) return clear();
    cross.hidden = false;
    tip.hidden = false;
    cross.style.setProperty("--x", `${Math.round(r.x)}px`);
    tip.replaceChildren(...[r.content].flat().filter((c) => c !== null && c !== undefined));
    // Keep the tooltip inside the host: right of the line, or left of it near the right edge.
    const W = host.clientWidth;
    const tw = tip.offsetWidth || 160;
    const tx = r.x + 12 + tw > W ? Math.max(0, r.x - 12 - tw) : r.x + 12;
    tip.style.setProperty("--tx", `${Math.round(tx)}px`);
  }
  function clear() {
    index = -1;
    pinned = false;
    cross.hidden = true;
    tip.hidden = true;
    tip.classList.remove("pinned");
  }
  const fromEvent = (e) => {
    const b = host.getBoundingClientRect();
    const n = count();
    if (!b.width || n < 1) return -1;
    return Math.round(((e.clientX - b.left) / b.width) * (n - 1));
  };
  const onMove = (e) => {
    if (pinned) return;
    show(fromEvent(e));
  };
  const onLeave = () => {
    if (!pinned) clear();
  };
  const onDown = (e) => {
    const i = fromEvent(e);
    if (pinned && i === index) {
      pinned = false;
      tip.classList.remove("pinned");
      return;
    }
    show(i);
    pinned = true;
    tip.classList.add("pinned");
  };
  const onKey = (e) => {
    const n = count();
    if (!n) return;
    const step = e.shiftKey ? 10 : 1;
    let i = index < 0 ? Math.floor(n / 2) : index;
    if (e.key === "ArrowRight") i += step;
    else if (e.key === "ArrowLeft") i -= step;
    else if (e.key === "Home") i = 0;
    else if (e.key === "End") i = n - 1;
    else if (e.key === "Escape" && index >= 0) {
      e.preventDefault();
      e.stopPropagation();
      return clear();
    } else return;
    e.preventDefault();
    e.stopPropagation();
    show(i);
  };
  host.addEventListener("pointermove", onMove);
  host.addEventListener("pointerleave", onLeave);
  host.addEventListener("pointerdown", onDown);
  host.addEventListener("keydown", onKey);
  host.addEventListener("blur", onLeave);
  return {
    set: (i) => show(i),
    clear,
    get index() {
      return index;
    },
    destroy() {
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("keydown", onKey);
      host.removeEventListener("blur", onLeave);
      cross.remove();
      tip.remove();
      host.classList.remove("dv-scrub");
    },
  };
}
