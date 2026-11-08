// Motion for the dashboard: springs, gestures and keyed live patching. No library (it reads only format.js for numbers).
//
// Importing this file never touches window or document, so Node can test every pure part:
//  - spring maths:      springParams, springAt, settleTime, springToLinear (the generator of the --spring-* tokens),
//                       spring(name) -> { duration, easing } for CSS and the Web Animations API
//  - Spring class:      closed-form damped spring (frame-rate independent), retargeting with velocity inheritance, one
//                       shared rAF loop for every running spring, stops when settled, cancellable
//  - gesture logic:     project, rubber, fitVelocity, lockAxis, settleTarget, shouldDismiss (pure)
//  - gestures:          sheetDrag (bottom sheets), swipeDismiss (toasts, rows), trackSelection (the sliding thumb)
//  - live data:         patchList (keyed in-place patching), countTo (tabular counters), setText / setAttr / setClass,
//                       flip (list insert / remove / reorder), viewTransition (with a plain fallback)
//  - page and chrome:   sheetIn / sheetOut, bannerIn / bannerOut, pageLeave / pageEnter / animatePage, shake, pulse
//
// Rules every helper follows:
//  - Transform and opacity only (the individual properties `translate` and `scale`, which compose with any `transform`
//    the stylesheet sets). `will-change` only while something moves.
//  - Reduced motion: no spatial motion, no view transitions, counters snap. Gestures still track the finger 1:1; on
//    release the element settles with a short ease-out instead of a spring.
//  - Every promise resolves (animations have a safety cap, because background tabs pause animation frames), and
//    nothing is ever left hidden or displaced.

import { formatNumber } from "./format.js";

// ── Environment ──

export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const isEl = (x) => typeof Element !== "undefined" && x instanceof Element;
const done = () => Promise.resolve();
/** True when animations should run: a real DOM with the Web Animations API, and no preference for reduced motion. */
const live = () => typeof document !== "undefined" && typeof Element !== "undefined" && typeof Element.prototype.animate === "function" && !reducedMotion();
/** True when sheets are bottom sheets (phones, below 720px: see app.css dialog.sheet). */
const bottomSheet = () => typeof matchMedia === "function" && matchMedia("(max-width: 719px)").matches;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Keep `<html data-motion="reduce">` in step with the system setting (CSS can key on it). Idempotent. */
export function watchReducedMotion() {
  if (typeof matchMedia !== "function" || typeof document === "undefined" || watchReducedMotion.on) return;
  watchReducedMotion.on = true;
  const mq = matchMedia("(prefers-reduced-motion: reduce)");
  const sync = () => {
    if (mq.matches) document.documentElement.dataset.motion = "reduce";
    else delete document.documentElement.dataset.motion;
  };
  mq.addEventListener?.("change", sync);
  sync();
}

// ── Spring maths (pure) ──

/** Mass 1. `response` is the period of the undamped spring in seconds; `bounce` runs -1..1 (0 is critical damping). */
export function springParams(response, bounce = 0) {
  const w0 = (2 * Math.PI) / response;
  const zeta = bounce >= 0 ? 1 - bounce : 1 / (1 + bounce);
  return { w0, zeta, stiffness: w0 * w0, damping: 2 * zeta * w0 };
}

/** Step response 0 -> 1 at time t (seconds), initial velocity v0 in units per second. Closed form for all three regimes. */
export function springAt(t, { w0, zeta }, v0 = 0) {
  const e = Math.exp(-zeta * w0 * t);
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - e * (Math.cos(wd * t) + ((zeta * w0 - v0) / wd) * Math.sin(wd * t));
  }
  if (zeta === 1) return 1 - e * (1 + (w0 - v0) * t);
  const s = w0 * Math.sqrt(zeta * zeta - 1);
  const r1 = -zeta * w0 + s;
  const r2 = -zeta * w0 - s;
  const a = (-v0 - r2) / (r1 - r2);
  return 1 - (a * Math.exp(r1 * t) + (1 - a) * Math.exp(r2 * t));
}

/** The last instant (to 1 ms) at which the step response is still further than `eps` from 1. */
export function settleTime(p, eps = 0.002, v0 = 0) {
  let last = 0;
  for (let ms = 0; ms < 10000; ms++) if (Math.abs(springAt(ms / 1000, p, v0) - 1) > eps) last = ms;
  return (last + 1) / 1000;
}

/**
 * The spring as a CSS `linear()` easing: sample the closed form 240 times a second until it settles, thin the samples with
 * Ramer-Douglas-Peucker so linear interpolation stays within `tol` of the curve, print 3-decimal values at 1-decimal
 * percentages. Returns the string, the settle time and the error measured on what is printed.
 */
export function springToLinear(response, bounce = 0, { eps = 0.002, tol = 0.0015, dp = 3 } = {}) {
  const p = springParams(response, bounce);
  const T = settleTime(p, eps);
  const N = Math.max(60, Math.ceil(T * 240));
  const pts = Array.from({ length: N + 1 }, (_, i) => [i / N, i === N ? 1 : springAt((i / N) * T, p)]);
  const keep = new Array(N + 1).fill(false);
  keep[0] = keep[N] = true;
  const rdp = (a, b) => {
    let worst = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const y = pts[a][1] + ((pts[b][1] - pts[a][1]) * (pts[i][0] - pts[a][0])) / (pts[b][0] - pts[a][0]);
      const d = Math.abs(pts[i][1] - y);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tol && at > 0) {
      keep[at] = true;
      rdp(a, at);
      rdp(at, b);
    }
  };
  rdp(0, N);
  const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
  const stops = pts.filter((_, i) => keep[i]).map(([x, y], i, all) => [i === 0 ? 0 : i === all.length - 1 ? 100 : round(x * 100, 1), i === 0 ? 0 : i === all.length - 1 ? 1 : round(y, dp)]);
  const css = `linear(${stops.map(([x, y], i) => (i === 0 ? "0" : i === stops.length - 1 ? "1" : `${y} ${x}%`)).join(", ")})`;
  // The error of what is printed (rounded stops, interpolated linearly), against the exact curve, on a 1 ms grid.
  let maxErr = 0;
  let j = 0;
  const steps = Math.round(T * 1000);
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * 100;
    while (j < stops.length - 2 && stops[j + 1][0] <= x) j++;
    const [x0, y0] = stops[j];
    const [x1, y1] = stops[j + 1];
    const y = x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    maxErr = Math.max(maxErr, Math.abs(y - (i === steps ? 1 : springAt(i / 1000, p))));
  }
  const peak = Math.max(...pts.map((q) => q[1]));
  return { css, durationMs: Math.round(T * 1000), stops: stops.length, maxErr, overshootPct: Math.max(0, (peak - 1) * 100), ...p };
}

/** Peak overshoot of an under-damped step response, as a fraction of the travel (0 when not under-damped). */
export const overshootOf = (zeta) => (zeta < 1 ? Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta)) : 0);

/**
 * The tokens. response (s) and bounce set the feel; the CSS duration is the settle time. Overshoot above 1 % only on
 * small things a finger can hold (thumb, switch); never on anything anchored to a screen edge.
 */
export const SPRINGS = {
  brisk: { response: 0.22, bounce: 0 }, // small reveals, chips, disclosure
  smooth: { response: 0.5, bounce: 0 }, // layout moves, FLIP
  sheet: { response: 0.42, bounce: 0.08 }, // bottom sheet present, detent change (no visible overshoot)
  snappy: { response: 0.35, bounce: 0.15 }, // popover, toast in, desktop modal
  thumb: { response: 0.3, bounce: 0.2 }, // segmented thumb, tab pill
  bouncy: { response: 0.5, bounce: 0.3 }, // rare, celebratory
  gentle: { response: 0.7, bounce: 0 }, // large surfaces
};
const FALLBACK_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const supportsLinear = () => typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("transition-timing-function", "linear(0, 1)");
const cache = new Map();

/**
 * `{ duration, easing }` for a token (brisk, smooth, sheet, snappy, thumb, bouncy, gentle): `duration` in ms is the settle
 * time, `easing` a `linear()` string (a plain decelerating bezier where `linear()` is not supported). An unknown name gives
 * `smooth`. Pass both to `el.animate(frames, spring("snappy"))`.
 */
export function spring(name = "smooth") {
  const key = Object.hasOwn(SPRINGS, name) ? name : "smooth";
  let entry = cache.get(key);
  if (!entry) {
    const { response, bounce } = SPRINGS[key];
    const g = springToLinear(response, bounce);
    entry = { duration: g.durationMs, linear: g.css, response, bounce };
    cache.set(key, entry);
  }
  return { duration: entry.duration, easing: supportsLinear() ? entry.linear : FALLBACK_EASE, response: entry.response, bounce: entry.bounce };
}

// ── The shared frame loop ──

let frames = {
  raf: (f) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(f) : setTimeout(() => f(frames.now()), 16)),
  caf: (id) => (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id)),
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
};
const jobs = new Set();
let rafId = 0;
/** Tests: replace the frame source (`{ raf, caf, now }`) and drop whatever was running. Pass nothing to restore the browser's. */
export function _setFrameSource(src) {
  const browser = {
    raf: (f) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(f) : setTimeout(() => f(frames.now()), 16)),
    caf: (id) => (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id)),
    now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  };
  if (rafId) frames.caf(rafId);
  jobs.clear();
  rafId = 0;
  frames = src ?? browser;
}
let lastTick = 0;
/** How many springs are running (for tests and for asserting the loop stops). */
export const runningSprings = () => jobs.size;

function tick(now) {
  const dt = clamp((now - lastTick) / 1000, 0, 0.05); // a stalled tab must not fling anything
  lastTick = now;
  for (const s of [...jobs]) s._frame(dt);
  rafId = jobs.size ? frames.raf(tick) : 0;
}
function join(s) {
  jobs.add(s);
  if (!rafId) {
    lastTick = frames.now();
    rafId = frames.raf(tick);
  }
}

// ── Spring (retargetable, closed form) ──

/**
 * A damped spring on one number. Units are yours (px, 0..1, a count). Closed form, so the result does not depend on the
 * frame rate. `retarget(target, velocity)` keeps the live position and velocity (or takes a gesture's release velocity),
 * `grab()` stops it where it is (a finger caught a moving element), `to()` retargets and runs it on the shared frame
 * loop until it settles. With reduced motion `to()` glides 120 ms ease-out instead of springing.
 */
export class Spring {
  /** @param {number} value  @param {string | { response?: number, bounce?: number, precision?: number }} spec a token name or numbers */
  constructor(value = 0, spec = "smooth") {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.t = 0;
    this.x0 = 0;
    this.v0 = 0;
    this.precision = 0.05;
    this._tween = null;
    this._onUpdate = null;
    this._onDone = null;
    this.setSpec(spec);
  }

  /** Change the physics (for the next retarget). */
  setSpec(spec) {
    const s = typeof spec === "string" ? (SPRINGS[spec] ?? SPRINGS.smooth) : { ...SPRINGS.smooth, ...spec };
    this.response = s.response;
    this.bounce = s.bounce;
    if (typeof spec === "object" && spec.precision) this.precision = spec.precision;
    Object.assign(this, springParams(this.response, this.bounce));
    return this;
  }

  /** Advance by dt seconds (capped at 50 ms) and return the value. */
  step(dt) {
    dt = clamp(dt, 0, 0.05);
    this.t += dt;
    if (this._tween) {
      const tw = this._tween;
      tw.t = Math.min(tw.dur, tw.t + dt);
      const k = tw.t / tw.dur;
      const e = 1 - (1 - k) ** 3;
      this.value = tw.from + (tw.to - tw.from) * e;
      this.velocity = 0;
      if (tw.t >= tw.dur) this.value = this.target;
      return this.value;
    }
    const { w0, zeta, x0, v0, t } = this;
    const e = Math.exp(-zeta * w0 * t);
    let y;
    let dy;
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      const c = Math.cos(wd * t);
      const s = Math.sin(wd * t);
      const B = (v0 + zeta * w0 * x0) / wd;
      y = e * (x0 * c + B * s);
      dy = e * (-zeta * w0 * (x0 * c + B * s) + wd * (-x0 * s + B * c));
    } else if (zeta === 1) {
      const B = v0 + w0 * x0;
      y = e * (x0 + B * t);
      dy = e * (B - w0 * (x0 + B * t));
    } else {
      const s = w0 * Math.sqrt(zeta * zeta - 1);
      const r1 = -zeta * w0 + s;
      const r2 = -zeta * w0 - s;
      const a = (v0 - r2 * x0) / (r1 - r2);
      const b = x0 - a;
      y = a * Math.exp(r1 * t) + b * Math.exp(r2 * t);
      dy = a * r1 * Math.exp(r1 * t) + b * r2 * Math.exp(r2 * t);
    }
    this.value = this.target + y;
    this.velocity = dy;
    return this.value;
  }

  /** Aim at a new target from where it is, keeping its velocity unless one is given (a gesture's, in units per second). */
  retarget(target, velocity = this.velocity) {
    this._tween = null;
    this.x0 = this.value - target;
    this.v0 = velocity;
    this.target = target;
    this.t = 0;
    return this;
  }

  /** Stop in place: value stays, velocity zero. */
  grab() {
    this.cancel();
    this._tween = null;
    this.target = this.value;
    this.x0 = 0;
    this.v0 = 0;
    this.velocity = 0;
    this.t = 0;
    return this;
  }

  /** Jump to a value at rest. */
  set(value) {
    this.cancel();
    this._tween = null;
    this.value = this.target = value;
    this.x0 = this.v0 = this.velocity = this.t = 0;
    return this;
  }

  atRest() {
    return Math.abs(this.value - this.target) < this.precision && Math.abs(this.velocity) < this.precision * 10;
  }

  get running() {
    return jobs.has(this);
  }

  /** Retarget and run on the shared loop. `onUpdate(value, velocity)` writes the DOM; the promise resolves when it settles (or is cancelled). */
  to(target, { velocity, spec, onUpdate, onDone } = {}) {
    if (spec) this.setSpec(spec);
    this._onUpdate = onUpdate ?? this._onUpdate;
    return new Promise((resolve) => {
      const prev = this._onDone;
      this._onDone = () => {
        prev?.();
        onDone?.();
        resolve();
      };
      if (reducedMotion()) {
        this._tween = { from: this.value, to: target, t: 0, dur: 0.12 };
        this.target = target;
        this.velocity = 0;
      } else this.retarget(target, velocity);
      join(this);
    });
  }

  /** Stop running (the value stays where it is) and resolve whoever waits. */
  cancel() {
    if (!jobs.delete(this)) return this;
    const fin = this._onDone;
    this._onDone = null;
    fin?.();
    return this;
  }

  _frame(dt) {
    this.step(dt);
    if (this.atRest() || (this._tween && this._tween.t >= this._tween.dur)) {
      this.value = this.target;
      this.velocity = 0;
      this._tween = null;
      jobs.delete(this);
      this._onUpdate?.(this.value, 0);
      const fin = this._onDone;
      this._onDone = null;
      fin?.();
      return;
    }
    this._onUpdate?.(this.value, this.velocity);
  }
}

// ── Gesture logic (pure) ──

/** Where a velocity (px/s) would coast to: `rate` 0.99 for sheets and rows (short throws), 0.998 for free carousels. */
export const project = (v, rate = 0.99) => ((v / 1000) * rate) / (1 - rate);

/** Resistance past an edge: `x` raw distance beyond it, `d` the length that bounds the stretch, `c` the stiffness. */
export const rubber = (x, d, c = 0.55) => (x <= 0 || d <= 0 ? 0 : (1 - 1 / ((x * c) / d + 1)) * d);

/**
 * Velocity in px/s from pointer samples `{ t (ms), x, y }`: least-squares slope over the last 100 ms. A finger that has
 * paused (last sample older than 60 ms) is at rest.
 */
export function fitVelocity(samples, now) {
  const s = samples.filter((p) => now - p.t <= 100);
  if (s.length < 2 || now - s[s.length - 1].t > 60) return { x: 0, y: 0 };
  const t0 = s[0].t;
  const n = s.length;
  let st = 0;
  let sx = 0;
  let sy = 0;
  let stt = 0;
  let stx = 0;
  let sty = 0;
  for (const p of s) {
    const t = (p.t - t0) / 1000;
    st += t;
    sx += p.x;
    sy += p.y;
    stt += t * t;
    stx += t * p.x;
    sty += t * p.y;
  }
  const d = n * stt - st * st;
  return d ? { x: (n * stx - st * sx) / d, y: (n * sty - st * sy) / d } : { x: 0, y: 0 };
}

/**
 * Axis lock: nothing until the finger has moved `slop` px (8 touch, 3 mouse), then the dominant axis when it leads by
 * 1.5x, else "none" (not a drag on this axis: give the gesture back).
 * @returns {"wait" | "x" | "y" | "none"}
 */
export function lockAxis(dx, dy, slop = 8, ratio = 1.5) {
  if (Math.hypot(dx, dy) < slop) return "wait";
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ay >= ax * ratio) return "y";
  if (ax >= ay * ratio) return "x";
  return "none";
}

/**
 * Where a released sheet comes to rest. `rests` are the resting offsets from the top of the open sheet, ascending, the
 * last one being closed. An unmistakable flick (over 600 px/s) wins one step in its direction; otherwise the nearest rest
 * to where the thrown sheet would land (projection), and a small slow drag snaps back to where it started.
 * @returns {{ index: number, dismiss: boolean }}
 */
export function settleTarget(y, vy, rests, { from = 0, flick = 600, snapDrag = 0.1, snapSpeed = 250 } = {}) {
  const last = rests.length - 1;
  const closed = rests[last];
  let index;
  if (Math.abs(vy) > flick) {
    if (vy > 0) {
      const i = rests.findIndex((r) => r > y + 0.5);
      index = i < 0 ? last : i;
    } else {
      const i = rests.findLastIndex((r) => r < y - 0.5);
      index = i < 0 ? 0 : i;
    }
  } else if (Math.abs(vy) < snapSpeed && Math.abs(y - rests[from]) < snapDrag * closed) {
    index = from;
  } else {
    const p = y + project(vy, 0.99);
    index = 0;
    for (let i = 1; i <= last; i++) if (Math.abs(rests[i] - p) < Math.abs(rests[index] - p)) index = i;
  }
  return { index, dismiss: index === last };
}

/** Swipe-away rule for toasts and rows: past `distance` px, or thrown faster than `speed` px/s in the direction of travel. */
export function shouldDismiss(offset, velocity, { distance = 60, speed = 500 } = {}) {
  if (Math.abs(offset) >= distance) return true;
  return Math.abs(velocity) >= speed && (offset === 0 || Math.sign(velocity) === Math.sign(offset));
}

// ── Writing helpers for live regions (set only when changed; nothing is rebuilt) ──

/** Set text only when it differs (keeps the text node, so selection and screen-reader position survive). */
export function setText(el, text) {
  if (!el) return false;
  const s = String(text ?? "");
  const n = el.firstChild;
  if (n && n.nodeType === 3 && !n.nextSibling) {
    if (n.data === s) return false;
    n.data = s;
    return true;
  }
  if (el.textContent === s) return false;
  el.textContent = s;
  return true;
}
/** Set an attribute only when it differs; `null`, `undefined` and `false` remove it. */
export function setAttr(el, name, value) {
  if (!el) return false;
  if (value === null || value === undefined || value === false) {
    if (!el.hasAttribute(name)) return false;
    el.removeAttribute(name);
    return true;
  }
  const s = value === true ? "" : String(value);
  if (el.getAttribute(name) === s) return false;
  el.setAttribute(name, s);
  return true;
}
/** Toggle a class only when needed. */
export function setClass(el, cls, on) {
  if (!el) return false;
  if (el.classList.contains(cls) === Boolean(on)) return false;
  el.classList.toggle(cls, Boolean(on));
  return true;
}

// ── patchList: keyed in-place patching ──

/** Indices (into `seq`) of a longest strictly increasing subsequence. */
function lis(seq) {
  const prev = new Array(seq.length).fill(-1);
  const tails = [];
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = [];
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) out.push(k);
  return out.reverse();
}

/**
 * Plan a keyed patch (pure). Given the keys now in the DOM and the keys wanted, say what to remove, add and move, moving as
 * few kept items as possible (the kept items that already read in the wanted order stay where they are).
 * @returns {{ remove: string[], add: string[], move: string[], stay: string[], changed: boolean }}
 */
export function planPatch(prevKeys, nextKeys) {
  const want = new Set(nextKeys);
  const had = new Set(prevKeys);
  const remove = prevKeys.filter((k) => !want.has(k));
  const add = nextKeys.filter((k) => !had.has(k));
  const kept = prevKeys.filter((k) => want.has(k));
  const at = new Map(nextKeys.map((k, i) => [k, i]));
  const keepIdx = new Set(lis(kept.map((k) => at.get(k))));
  const stay = kept.filter((_, i) => keepIdx.has(i));
  const move = kept.filter((_, i) => !keepIdx.has(i));
  return { remove, add, move, stay, changed: remove.length + add.length + move.length > 0 };
}

const keyOf = (el) => el?.dataset?.key;
const isLive = (el) => keyOf(el) !== undefined && el.dataset.leaving === undefined;

/**
 * Keep `container` showing `items`, patching the DOM instead of rebuilding it. Each item's element is found by its key
 * (`data-key`); `render(item, existing)` either builds a new element (`existing` is null) or updates `existing` in place and
 * returns it (it may return a different element to replace it). Elements that did not change are not touched, so focus,
 * scroll position, open `<details>`, text selection and running transitions all survive a 1.5 s poll. New items fade and
 * scale in, removed ones fade out and their siblings slide into the gap, reordered ones FLIP, all only when something
 * structural changed (a poll that only changes values reads no layout and animates nothing here).
 * Children without a `data-key` are left where they are.
 * @template T
 * @param {HTMLElement} container
 * @param {T[]} items
 * @param {(item: T, index: number) => string | number} keyFn
 * @param {(item: T, existing: HTMLElement | null) => HTMLElement} render
 * @param {{ animate?: boolean, initial?: boolean, before?: Node | null }} [opts]  `animate: false` skips enter/exit/FLIP;
 *   `initial: true` animates the first fill too (it is still, by default); `before` appends new items before that node
 * @returns {{ added: number, removed: number, moved: number, kept: number }}
 */
export function patchList(container, items, keyFn, render, { animate = true, initial = false, before = null } = {}) {
  const current = Array.from(container.children).filter(isLive);
  const byKey = new Map(current.map((el) => [keyOf(el), el]));
  const keys = items.map((it, i) => String(keyFn(it, i)));
  const plan = planPatch(
    current.map(keyOf),
    keys,
  );
  const animating = animate && live() && (current.length > 0 || initial);
  const first = animating && plan.changed ? snapshot(current) : null;
  const last = current[current.length - 1];
  const anchor = last ? last.nextSibling : before;

  // Update or create each element (in item order), remembering focus when an element is replaced.
  const nodes = new Map();
  items.forEach((it, i) => {
    const k = keys[i];
    const had = byKey.get(k) ?? null;
    let el = render(it, had);
    if (!el) return;
    if (had && el !== had) {
      const focused = typeof document !== "undefined" && had.contains?.(document.activeElement);
      had.replaceWith(el);
      if (focused) el.focus?.({ preventScroll: true });
    }
    el.dataset.key = k;
    nodes.set(k, el);
  });

  // Leaving elements: faded out (or removed at once), never matched again.
  for (const k of plan.remove) {
    const el = byKey.get(k);
    if (animating) leave(container, el);
    else el.remove();
  }

  // Place what is new or out of order before the next element that stays put; the rest is not touched.
  const stay = new Set(plan.stay);
  let next = anchor;
  for (let i = keys.length - 1; i >= 0; i--) {
    const el = nodes.get(keys[i]);
    if (!el) continue;
    if (stay.has(keys[i]) && el.parentNode === container) {
      next = el;
      continue;
    }
    container.insertBefore(el, next);
    next = el;
  }

  if (animating && plan.changed) {
    const added = new Set(plan.add);
    playEnter(plan.add.map((k) => nodes.get(k)).filter(Boolean));
    if (first && current.length + plan.add.length <= 100) playFlip(first, [...nodes].filter(([k]) => !added.has(k)).map(([, el]) => el));
  }
  return { added: plan.add.length, removed: plan.remove.length, moved: plan.move.length, kept: plan.stay.length };
}

const snapshot = (els) => new Map(els.slice(0, 60).map((el) => [el, el.getBoundingClientRect()]));

/** FLIP: slide each element from where it was (`first`) to where it is now. Reads before writes. */
function playFlip(first, els) {
  const moved = [];
  for (const el of els) {
    const a = first.get(el);
    if (!a) continue;
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) moved.push([el, dx, dy]);
  }
  const sp = spring("smooth");
  for (const [el, dx, dy] of moved) {
    for (const an of el.getAnimations?.() ?? []) if (an.id === "mc-flip") an.cancel();
    const an = el.animate({ translate: [`${dx}px ${dy}px`, "0px 0px"] }, { duration: sp.duration, easing: sp.easing });
    an.id = "mc-flip";
  }
}

function playEnter(els) {
  for (const el of els) el.animate({ opacity: [0, 1], scale: [0.97, 1] }, { duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
}

/** Fade a removed element out in place (it stays in the flow, inert), then take it out and let its siblings slide up. */
function leave(container, el) {
  el.dataset.leaving = "";
  el.setAttribute("aria-hidden", "true");
  el.inert = true;
  const finish = () => {
    if (!el.isConnected) return;
    flip(container, () => el.remove());
  };
  try {
    const an = el.animate({ opacity: [1, 0], scale: [1, 0.97] }, { duration: 160, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" });
    an.finished.then(finish, finish);
    setTimeout(finish, 400);
  } catch {
    finish();
  }
}

/**
 * FLIP around a DOM change: measure, run `mutate()`, then slide whatever moved from its old place and fade new keyed
 * children in. Measures at most the first 60 keyed children; more than 100 changes cross-fade instead. Under reduced motion
 * it just mutates. Returns a promise that resolves when the motion is over.
 */
export function flip(container, mutate, { key = (el) => el.dataset?.key, max = 60 } = {}) {
  if (!live() || !isEl(container)) {
    mutate();
    return done();
  }
  const kids = () => Array.from(container.children).filter((el) => key(el) !== undefined && el.dataset.leaving === undefined);
  const first = new Map(kids().slice(0, max).map((el) => [key(el), el.getBoundingClientRect()]));
  mutate();
  const now = kids();
  const moved = [];
  for (const el of now) {
    const a = first.get(key(el));
    if (!a) {
      moved.push([el, 0, 0, true]);
      continue;
    }
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) moved.push([el, dx, dy, false]);
  }
  const sp = spring("smooth");
  const all = [];
  for (const [el, dx, dy, enter] of moved) {
    if (moved.length > 100) {
      all.push(el.animate({ opacity: [0, 1] }, { duration: 150 }).finished);
      continue;
    }
    const an = enter ? el.animate({ opacity: [0, 1], scale: [0.97, 1] }, { duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }) : el.animate({ translate: [`${dx}px ${dy}px`, "0px 0px"] }, { duration: sp.duration, easing: sp.easing });
    all.push(an.finished);
  }
  return Promise.allSettled(all).then(() => {});
}

// ── countTo ──

/** The house number format (format.js: no grouping, true minus sign) with a fixed number of decimals. */
const plainNumber = (n, decimals = 0) => formatNumber(n, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

function writeText(el, s) {
  const n = el.firstChild;
  if (n && n.nodeType === 3 && !n.nextSibling) {
    if (n.data !== s) n.data = s;
  } else if (el.textContent !== s) el.textContent = s;
}

/**
 * Show a number in `el` and move it to `value`: tabular figures (class `mc-count`, app.css) so the digits never jitter,
 * written into one text node. A change smaller than `threshold` (0.5 % of the number) is written at once; a bigger one runs
 * a spring (`response` 0.35, no bounce) that retargets from the number being shown, so a counter hit twice never restarts.
 * With reduced motion, without a DOM, or with `animate: false`, the value snaps. The first call shows the value at once
 * unless `from` is given (a reveal from that number).
 * @param {HTMLElement} el
 * @param {number} value
 * @param {{ format?: (n: number) => string, decimals?: number, from?: number, threshold?: number, animate?: boolean, response?: number }} [opts]
 * @returns {Promise<void>} resolves when it shows the final value
 */
export function countTo(el, value, { format, decimals = 0, from, threshold = 0.005, animate = true, response = 0.35 } = {}) {
  const fmt = format ?? ((n) => plainNumber(n, decimals));
  const scale = 10 ** decimals;
  const round = (n) => Math.round(n * scale) / scale;
  let st = el.__count;
  if (!st) {
    st = el.__count = { target: Number.NaN, sp: null, shown: "" };
    el.classList?.add("mc-count");
  }
  const show = (n) => {
    const s = fmt(round(n));
    if (s !== st.shown) {
      st.shown = s;
      writeText(el, s);
    }
  };
  if (!Number.isFinite(value)) {
    st.sp?.set(0);
    st.target = Number.NaN;
    st.shown = String(value);
    writeText(el, st.shown);
    return done();
  }
  const firstShow = !Number.isFinite(st.target);
  const prev = firstShow ? (from ?? value) : st.target;
  const shownNow = st.sp ? st.sp.value : prev;
  st.target = value;
  const small = Math.abs(value - shownNow) / Math.max(Math.abs(shownNow), 1) < threshold;
  if (!animate || !live() || small || value === shownNow) {
    st.sp?.set(value);
    show(value);
    return done();
  }
  st.sp ??= new Spring(shownNow, { response, bounce: 0, precision: 0.5 / scale });
  st.sp.value = shownNow;
  return st.sp
    .to(value, {
      spec: { response, bounce: 0, precision: 0.5 / scale },
      onUpdate: (v) => show(v),
    })
    .then(() => show(st.target));
}
/** Stop a counter where it is and show its target. */
countTo.settle = (el) => {
  const st = el.__count;
  if (!st) return;
  st.sp?.cancel();
  if (Number.isFinite(st.target)) writeText(el, st.shown);
};

// ── View transitions ──

/**
 * Run a DOM update inside a same-document view transition when the browser has them and motion is allowed; otherwise just
 * run it. `names` maps elements to a `view-transition-name` for the duration (cleared afterwards, so bfcache never keeps
 * one). Never rejects; resolves when the transition is over.
 * @param {() => void | Promise<void>} update
 * @param {{ type?: string, names?: Map<Element, string> | Array<[Element, string]> }} [opts]
 */
export function viewTransition(update, { type, names = [] } = {}) {
  const plain = () => {
    try {
      return Promise.resolve(update());
    } catch (e) {
      return Promise.reject(e);
    }
  };
  if (typeof document === "undefined" || reducedMotion() || typeof document.startViewTransition !== "function" || document.visibilityState === "hidden") return plain();
  const pairs = [...names];
  for (const [el, name] of pairs) el.style.viewTransitionName = name;
  const clear = () => {
    for (const [el] of pairs) el.style.viewTransitionName = "";
  };
  let t;
  try {
    t = type ? document.startViewTransition({ update, types: [type] }) : document.startViewTransition(update);
  } catch {
    t = document.startViewTransition(update);
  }
  return t.finished.then(clear, clear);
}

// ── Sliding selection (segmented thumb, tab pill, nav indicator) ──

/**
 * Keep an indicator element under the selected item of a container: the container is `position: relative`, the indicator
 * absolutely positioned at the top left; this writes `translate` and `width` (and with `axes: "xy"`, `height`) from the
 * item's offset box. Each number is its own spring, so changing the selection while the thumb is moving keeps its
 * velocity. The first placement is instant; a ResizeObserver re-measures without animating. With `drag`, a touch or pen
 * dragging the thumb moves it 1:1 (rubber-banded beyond the ends) and releases to the segment nearest to where it would
 * land; `onCommit(item)` is called then.
 * @param {HTMLElement} container
 * @param {{ indicator: HTMLElement, items: () => HTMLElement[], current: () => HTMLElement | null | undefined, axes?: "x" | "xy", spec?: string, drag?: false | { onCommit: (el: HTMLElement) => void, onPeek?: (el: HTMLElement | null) => void } }} o
 */
export function trackSelection(container, { indicator, items, current, axes = "x", spec = "thumb", drag = false }) {
  const xy = axes === "xy";
  const sp = { x: new Spring(0, spec), y: new Spring(0, spec), w: new Spring(0, spec), h: new Spring(0, spec) };
  const keys = xy ? ["x", "y", "w", "h"] : ["x", "w"];
  let placed = false;
  let dragging = false;
  const write = () => {
    indicator.style.translate = `${sp.x.value}px ${xy ? sp.y.value : 0}px`;
    indicator.style.width = `${sp.w.value}px`;
    if (xy) indicator.style.height = `${sp.h.value}px`;
  };
  const rectOf = (el) => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
  const measure = () => {
    const el = current();
    if (!el || !container.isConnected || !el.offsetWidth) return null;
    return rectOf(el);
  };
  const update = ({ animate = true, velocity = 0 } = {}) => {
    const r = measure();
    if (!r) return;
    indicator.dataset.placed = "";
    if (!placed || !animate || !live() || dragging) {
      for (const k of keys) sp[k].set(r[k]);
      write();
      placed = true;
      if (!dragging) indicator.style.willChange = "";
      return;
    }
    indicator.style.willChange = "translate, width";
    let pending = keys.length;
    for (const k of keys) {
      sp[k]
        .to(r[k], { velocity: k === "x" ? velocity : undefined, onUpdate: write })
        .then(() => {
          if (--pending === 0) indicator.style.willChange = "";
        });
    }
  };
  let ro = null;
  if (typeof ResizeObserver === "function") {
    ro = new ResizeObserver(() => {
      if (container.isConnected && !dragging) update({ animate: false });
    });
    ro.observe(container);
  }

  if (drag) {
    let id = null;
    let startX = 0;
    let startY = 0;
    let x0 = 0;
    let locked = false;
    let buf = [];
    let peek = null;
    const onDown = (e) => {
      if (e.pointerType === "mouse" || id !== null || e.button > 0) return;
      const r = measure();
      if (!r) return;
      const b = container.getBoundingClientRect();
      const px = e.clientX - b.left + container.scrollLeft;
      if (px < r.x - 4 || px > r.x + r.w + 4) return; // a tap elsewhere is a click, handled by the button
      id = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      locked = false;
      buf = [{ t: e.timeStamp, x: e.clientX, y: e.clientY }];
    };
    const onMove = (e) => {
      if (e.pointerId !== id) return;
      for (const p of e.getCoalescedEvents?.() ?? [e]) buf.push({ t: p.timeStamp, x: p.clientX, y: p.clientY });
      while (buf.length > 2 && e.timeStamp - buf[0].t > 100) buf.shift();
      if (!locked) {
        const axis = lockAxis(e.clientX - startX, e.clientY - startY, 6);
        if (axis === "wait") return;
        if (axis !== "x") {
          id = null;
          return;
        }
        locked = dragging = true;
        for (const k of keys) sp[k].grab();
        x0 = sp.x.value;
        startX = e.clientX;
        container.setPointerCapture?.(e.pointerId);
        indicator.style.willChange = "translate, width";
        container.dataset.dragging = "";
      }
      const list = items().filter((el) => el.offsetWidth);
      const lo = Math.min(...list.map((el) => el.offsetLeft));
      const hi = Math.max(...list.map((el) => el.offsetLeft + el.offsetWidth)) - sp.w.value;
      let x = x0 + (e.clientX - startX);
      if (x < lo) x = lo - rubber(lo - x, sp.w.value, 0.35);
      else if (x > hi) x = hi + rubber(x - hi, sp.w.value, 0.35);
      sp.x.value = x;
      write();
      const centre = x + sp.w.value / 2;
      const over = list.find((el) => centre >= el.offsetLeft && centre <= el.offsetLeft + el.offsetWidth) ?? null;
      if (over !== peek) drag.onPeek?.((peek = over));
    };
    const onEnd = (e, cancelled) => {
      if (e.pointerId !== id) return;
      id = null;
      if (!locked) return;
      locked = false;
      container.releasePointerCapture?.(e.pointerId);
      delete container.dataset.dragging;
      const vx = cancelled ? 0 : fitVelocity(buf, e.timeStamp).x;
      const list = items().filter((el) => el.offsetWidth);
      const land = sp.x.value + sp.w.value / 2 + (cancelled ? 0 : project(vx, 0.99));
      const pick = list.reduce((best, el) => (Math.abs(el.offsetLeft + el.offsetWidth / 2 - land) < Math.abs(best.offsetLeft + best.offsetWidth / 2 - land) ? el : best), list[0]);
      dragging = false;
      drag.onPeek?.(null);
      peek = null;
      // The click that follows a drag must not pick the segment under the finger.
      const swallow = (ev) => ev.stopImmediatePropagation();
      container.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => container.removeEventListener("click", swallow, { capture: true }), 0);
      drag.onCommit(pick);
      update({ velocity: vx }); // same selection: spring back with the release velocity
    };
    container.addEventListener("pointerdown", onDown);
    container.addEventListener("pointermove", onMove);
    container.addEventListener("pointerup", (e) => onEnd(e, false));
    container.addEventListener("pointercancel", (e) => onEnd(e, true));
  }

  return {
    update,
    /** Place at once (a hidden panel that became visible). */
    jump: () => update({ animate: false }),
    destroy() {
      ro?.disconnect();
      for (const k of keys) sp[k].cancel();
    },
  };
}

// ── Bottom sheet ──

/**
 * Make a bottom sheet draggable. The sheet is `position: fixed; bottom: 0` and as tall as its largest detent; every resting
 * place is a `translate` offset (0 = open, `closed` = off screen), so the content never reflows while it moves. A spring
 * (`sheet`) drives present and detent changes; a finger drives it 1:1 (rubber-banded above the top detent); release
 * decides by projection with the 600 px/s flick rule (settleTarget) and hands the release velocity to the spring.
 * Scroll hand-off: the grabber and head drag with Pointer Events (`touch-action: none` in CSS); the scrolling body drags
 * only while it is scrolled to the top and the finger moves down, through a non-passive touch listener that stops the
 * browser's own pan at that moment. Mouse users drag from the grabber and head only.
 *
 * @param {HTMLElement} el  the sheet
 * @param {{ handle?: string, scroller?: string, detents?: Array<number>, initial?: number, canDismiss?: () => boolean, onDismiss?: (v: { velocity: number }) => boolean | void, onDetent?: (i: number) => void }} [opts]
 *   `detents`: visible heights in px (or fractions below 1 of the sheet's height), largest first; default the whole sheet.
 *   `onDismiss` returns false when the dismissal was refused (the sheet springs back).
 */
export function sheetDrag(el, opts = {}) {
  const { handle = ".sheet-grabber, .sheet-head, .pop-head", scroller = ".dialog-body", detents = null, initial = 0, onDismiss, onDetent } = opts;
  const y = new Spring(0, "sheet");
  y.precision = 0.1;
  let H = 0;
  let rests = [0, 0];
  let idx = initial;
  let tracking = null;
  let pendingV = 0;
  const closedOf = () => rests[rests.length - 1];

  const measure = () => {
    H = el.offsetHeight;
    const hs = (detents ?? [H]).map((d) => (d <= 1 ? d * H : d)).filter((d) => d > 0 && d <= H);
    const ys = [...new Set((hs.length ? hs : [H]).map((d) => Math.round(H - d)))].sort((a, b) => a - b);
    rests = [...ys, H + 8];
  };
  const write = (v = y.value) => {
    const c = closedOf();
    el.style.translate = v === 0 ? "" : `0px ${v}px`;
    el.style.setProperty("--sheet-p", String(clamp(1 - v / c, 0, 1)));
  };
  const will = (on) => (el.style.willChange = on ? "translate" : "");
  const settled = () => {
    will(false);
    delete el.dataset.dragging;
  };

  const api = {
    get y() {
      return y.value;
    },
    get velocity() {
      return y.velocity;
    },
    get detent() {
      return idx;
    },
    spring: y,
    /** Spring in from below to the initial detent. */
    present() {
      measure();
      idx = Math.min(initial, rests.length - 2);
      y.set(closedOf());
      write();
      will(true);
      return y.to(rests[idx], { spec: "sheet", velocity: 0, onUpdate: (v) => write(clamp(v, rests[0], closedOf())) }).then(() => {
        write(rests[idx]);
        settled();
        onDetent?.(idx);
      });
    },
    /** Spring to a detent (or closed with -1). */
    snapTo(i, velocity = 0) {
      if (!rests.length || H === 0) measure();
      const at = i < 0 ? rests.length - 1 : clamp(i, 0, rests.length - 2);
      if (i >= 0) idx = at;
      will(true);
      const lo = Math.min(rests[0], y.value);
      return y.to(rests[at], { spec: i < 0 ? { response: 0.3, bounce: 0 } : "sheet", velocity, onUpdate: (v) => write(clamp(v, lo, closedOf())) }).then(() => {
        write(rests[at]);
        settled();
        if (i >= 0) onDetent?.(idx);
      });
    },
    /** Out: a response-0.30 spring to closed with the velocity the sheet already has (or `velocity`). */
    dismiss({ velocity } = {}) {
      return api.snapTo(-1, velocity ?? (pendingV || y.velocity)).then(() => (pendingV = 0));
    },
    /** Stop any motion, drop the inline styles. */
    reset() {
      y.cancel();
      y.set(0);
      el.style.translate = "";
      el.style.removeProperty("--sheet-p");
      settled();
    },
    destroy() {
      api.reset();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    },
  };

  const begin = (clientY, t) => {
    if (!rests.length || H === 0 || !el.offsetHeight) measure();
    y.grab();
    will(true);
    el.dataset.dragging = "";
    tracking = { startY: clientY, y0: y.value, buf: [{ t, x: 0, y: clientY }], from: idx };
  };
  const moveTo = (clientY, t) => {
    tracking.buf.push({ t, x: 0, y: clientY });
    while (tracking.buf.length > 2 && t - tracking.buf[0].t > 100) tracking.buf.shift();
    const raw = tracking.y0 + (clientY - tracking.startY);
    const top = rests[0];
    const v = raw < top ? top - rubber(top - raw, Math.min(0.2 * (typeof innerHeight === "number" ? innerHeight : 800), 120)) : Math.min(raw, closedOf());
    y.value = v;
    write(v);
  };
  const release = (t, cancelled) => {
    const { buf, from } = tracking;
    tracking = null;
    const vy = cancelled ? 0 : fitVelocity(buf, t).y;
    const d = settleTarget(y.value, vy, rests, { from });
    if (d.dismiss) {
      pendingV = vy;
      if (opts.canDismiss?.() === false || onDismiss?.({ velocity: vy }) === false) {
        pendingV = 0;
        api.snapTo(from, vy);
      }
      return;
    }
    api.snapTo(d.index, vy);
  };

  // Pointer path: grabber and head (touch-action: none in CSS), any pointer type.
  let slopOrigin = null;
  const onDown = (e) => {
    if (e.button > 0 || tracking || slopOrigin) return;
    const t = e.target;
    if (!t.closest?.(handle) || t.closest?.("button, a, input, select, textarea")) return;
    slopOrigin = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, touch: e.pointerType !== "mouse" };
  };
  const onMove = (e) => {
    if (slopOrigin && e.pointerId === slopOrigin.id && !tracking) {
      const a = lockAxis(e.clientX - slopOrigin.x, e.clientY - slopOrigin.y, slopOrigin.touch ? 8 : 3, 1);
      if (a === "wait") return;
      const o = slopOrigin;
      slopOrigin = null;
      if (a === "x" || a === "none") return;
      el.setPointerCapture?.(e.pointerId);
      begin(e.clientY, e.timeStamp);
      tracking.id = e.pointerId;
    }
    if (tracking?.id === e.pointerId) for (const p of e.getCoalescedEvents?.() ?? [e]) moveTo(p.clientY, p.timeStamp);
  };
  const onUp = (e) => {
    if (slopOrigin?.id === e.pointerId) slopOrigin = null;
    if (tracking?.id === e.pointerId) {
      try {
        el.releasePointerCapture?.(e.pointerId);
      } catch {
        /* already released */
      }
      release(e.timeStamp, false);
    }
  };
  const onCancel = (e) => {
    if (slopOrigin?.id === e.pointerId) slopOrigin = null;
    if (tracking?.id === e.pointerId) release(e.timeStamp, true);
  };
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onCancel);

  // Touch hand-off from the scrolling body: passive start, non-passive move.
  let touch = null;
  const scrollerOf = (t) => t.closest?.(scroller);
  const onTouchStart = (e) => {
    if (tracking || e.touches.length !== 1) return (touch = null);
    const sc = scrollerOf(e.target);
    if (!sc || e.target.closest?.(handle)) return (touch = null);
    touch = { sc, y: e.touches[0].clientY, x: e.touches[0].clientX, t: e.timeStamp, on: false };
  };
  const onTouchMove = (e) => {
    if (!touch) return;
    const p = e.touches[0];
    if (!touch.on) {
      const dy = p.clientY - touch.y;
      const atTop = touch.sc.scrollTop <= 0;
      const expandable = idx > 0;
      if (!atTop || Math.abs(dy) < 6 || Math.abs(p.clientX - touch.x) > Math.abs(dy)) return;
      if (dy < 0 && !expandable) return;
      if (e.cancelable) e.preventDefault();
      touch.on = true;
      begin(p.clientY, e.timeStamp);
      tracking.id = "touch";
    } else if (e.cancelable) e.preventDefault();
    moveTo(p.clientY, e.timeStamp);
  };
  const onTouchEnd = (e) => {
    if (touch?.on && tracking?.id === "touch") release(e.timeStamp, e.type === "touchcancel");
    touch = null;
  };
  el.addEventListener("touchstart", onTouchStart, { passive: true });
  el.addEventListener("touchmove", onTouchMove, { passive: false });
  el.addEventListener("touchend", onTouchEnd);
  el.addEventListener("touchcancel", onTouchEnd);

  return api;
}

/**
 * Swipe an element away along one axis (toasts, rows): it follows the finger 1:1 (`touch-action: pan-x` or `pan-y` in CSS
 * leaves the other axis to the browser), resists with a rubber band against the wrong direction, and past 60 px or 500 px/s
 * it is thrown out (`onDismiss`), else it springs back. `directions` (an array, or a function read at each pointer-down)
 * limits which way counts.
 * @param {HTMLElement} el
 * @param {{ axis?: "x" | "y", directions?: Array<-1 | 1>, onDismiss: (v: { velocity: number, direction: number }) => void, onStart?: () => void, onEnd?: () => void }} o
 */
export function swipeDismiss(el, { axis = "x", directions: dirs = [-1, 1], onDismiss, onStart, onEnd }) {
  let directions = typeof dirs === "function" ? dirs() : dirs;
  const sp = new Spring(0, { response: 0.3, bounce: 0.1, precision: 0.2 });
  let id = null;
  let start = 0;
  let startOther = 0;
  let locked = false;
  let buf = [];
  const write = (v = sp.value) => {
    el.style.translate = axis === "x" ? `${v}px 0px` : `0px ${v}px`;
    el.style.opacity = String(clamp(1 - Math.abs(v) / (axis === "x" ? 320 : 160), 0.35, 1));
  };
  const reset = () => {
    el.style.translate = "";
    el.style.opacity = "";
    el.style.willChange = "";
    delete el.dataset.swiping;
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.button > 0 || id !== null || e.target.closest?.("button, a, input, select, textarea")) return;
    directions = typeof dirs === "function" ? dirs() : dirs;
    id = e.pointerId;
    start = axis === "x" ? e.clientX : e.clientY;
    startOther = axis === "x" ? e.clientY : e.clientX;
    locked = false;
    buf = [{ t: e.timeStamp, x: e.clientX, y: e.clientY }];
  });
  el.addEventListener("pointermove", (e) => {
    if (e.pointerId !== id) return;
    const pos = axis === "x" ? e.clientX : e.clientY;
    buf.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
    while (buf.length > 2 && e.timeStamp - buf[0].t > 100) buf.shift();
    if (!locked) {
      const dx = axis === "x" ? pos - start : e.clientX - startOther;
      const dy = axis === "x" ? e.clientY - startOther : pos - start;
      const a = lockAxis(dx, dy, e.pointerType === "mouse" ? 3 : 8);
      if (a === "wait") return;
      if (a !== axis) {
        id = null;
        return;
      }
      locked = true;
      sp.grab();
      sp.value = 0;
      el.setPointerCapture?.(e.pointerId);
      el.style.willChange = "translate, opacity";
      el.dataset.swiping = "";
      onStart?.();
      start = pos;
    }
    let d = pos - start;
    if (!directions.includes(Math.sign(d) || 1)) d = rubber(Math.abs(d), 80) * Math.sign(d);
    sp.value = d;
    write(d);
  });
  const end = (e, cancelled) => {
    if (e.pointerId !== id) return;
    id = null;
    if (!locked) return;
    locked = false;
    try {
      el.releasePointerCapture?.(e.pointerId);
    } catch {
      /* released */
    }
    const f = fitVelocity(buf, e.timeStamp);
    const v = cancelled ? 0 : axis === "x" ? f.x : f.y;
    const dir = Math.sign(sp.value) || Math.sign(v);
    if (!cancelled && directions.includes(dir) && shouldDismiss(sp.value, v)) {
      sp.to(dir * (axis === "x" ? el.offsetWidth : el.offsetHeight) * 1.2, { spec: { response: 0.25, bounce: 0 }, velocity: v, onUpdate: write }).then(() => {
        onDismiss({ velocity: v, direction: dir });
        reset();
        onEnd?.();
      });
      return;
    }
    sp.to(0, { velocity: v, onUpdate: write }).then(() => {
      reset();
      onEnd?.();
    });
  };
  el.addEventListener("pointerup", (e) => end(e, false));
  el.addEventListener("pointercancel", (e) => end(e, true));
  return { reset: () => (sp.set(0), reset()) };
}

// ── Sheets (modal dialogs) ──

const SHEETS = new WeakMap();
const EASE_OUT = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const EASE_EXIT = "cubic-bezier(0.4, 0, 1, 1)";

/** A promise-returning `el.animate` that never rejects and resolves at the latest after `cap` ms (background tabs pause frames). */
function play(el, keyframes, options, { cap = 1200 } = {}) {
  let anim;
  try {
    anim = el.animate(keyframes, options);
  } catch {
    return { anim: null, done: done() };
  }
  let timer;
  const capped = new Promise((r) => (timer = setTimeout(r, cap)));
  const finished = anim.finished.then(
    () => {},
    () => {},
  );
  return { anim, done: Promise.race([finished, capped]).then(() => clearTimeout(timer)) };
}

/** The drag controller of a phone sheet (<dialog>), made once per element and wired to the Cancel event so Esc, X, backdrop and swipe all close the same way. */
function sheetOf(d) {
  let c = SHEETS.get(d);
  if (c) return c;
  c = sheetDrag(d, {
    onDismiss: ({ velocity }) => {
      c.pendingV = velocity;
      const ev = new Event("cancel", { cancelable: true });
      d.dispatchEvent(ev);
      if (ev.defaultPrevented) return "closing" in d.dataset; // modal(): it runs sheetOut itself, or refused
      sheetOut(d, d).then(() => d.close()); // nobody listens: close it here
      return true;
    },
  });
  d.addEventListener("close", () => c.reset());
  SHEETS.set(d, c);
  return c;
}

/**
 * Sheet in. On a phone the panel springs up from the bottom edge (`sheet` spring: it settles at rest with no overshoot, so
 * it never lifts off the edge) and can then be dragged; from 720px up it scales 0.96 to 1 from the centre with a small
 * spring. The backdrop fades either way. `backdrop` is an element, or the <dialog> itself (then its ::backdrop).
 */
export function sheetIn(backdrop, panel) {
  if (typeof document === "undefined") return done();
  const reduce = reducedMotion();
  if (isEl(panel) && panel.tagName === "DIALOG" && bottomSheet()) {
    const c = sheetOf(panel);
    if (reduce) {
      c.reset();
      return done();
    }
    return c.present();
  }
  if (!live()) return done();
  const jobs = [fadeBackdrop(backdrop, panel, [0, 1], 200)];
  if (isEl(panel)) {
    const sp = spring("snappy");
    jobs.push(play(panel, { opacity: [0, 1], scale: [0.96, 1] }, { duration: sp.duration, easing: sp.easing }).done);
  }
  return Promise.all(jobs).then(() => {});
}

/**
 * Sheet out (resolves within a safety cap, at once with reduced motion) so the caller can close the dialog. On a phone: a
 * response-0.30 spring to the bottom edge that carries on at the velocity the sheet already has (a flick keeps going; a tap
 * on X starts from rest). On desktop a 120 ms fade, no scale.
 */
export function sheetOut(backdrop, panel) {
  if (typeof document === "undefined") return done();
  if (isEl(panel) && panel.tagName === "DIALOG" && bottomSheet()) {
    const c = sheetOf(panel);
    if (reducedMotion()) return done();
    let timer;
    const cap = new Promise((r) => (timer = setTimeout(r, 520)));
    return Promise.race([c.dismiss(), cap]).then(() => clearTimeout(timer));
  }
  if (!live()) return done();
  const jobs = [fadeBackdrop(backdrop, panel, [1, 0], 120, true)];
  let exit = null;
  if (isEl(panel)) {
    for (const a of panel.getAnimations()) a.cancel(); // an unfinished sheetIn
    const r = play(panel, { opacity: [1, 0] }, { duration: 120, easing: EASE_EXIT, fill: "forwards" }, { cap: 200 });
    exit = r.anim;
    jobs.push(r.done);
  }
  let timer;
  const cap = new Promise((r) => (timer = setTimeout(r, 200)));
  return Promise.race([Promise.all(jobs), cap]).then(() => {
    clearTimeout(timer);
    setTimeout(() => exit?.cancel(), 0);
  });
}

function fadeBackdrop(backdrop, panel, opacity, ms, hold = false) {
  if (!isEl(backdrop)) return done();
  const opts = { duration: ms, easing: "ease-out", fill: hold ? "forwards" : "none" };
  // A <dialog> passed as its own backdrop: fade ::backdrop (pseudo-elements need the pseudoElement option).
  if (backdrop === panel || backdrop.tagName === "DIALOG") {
    const r = play(backdrop, { opacity }, { ...opts, pseudoElement: "::backdrop" }, { cap: ms + 100 });
    if (hold) r.done.then(() => setTimeout(() => r.anim?.cancel(), 0));
    return r.done;
  }
  return play(backdrop, { opacity }, opts, { cap: ms + 100 }).done;
}

// ── Banners (toasts) ──

/**
 * Toast in: 12 px from the edge it sits on with the `snappy` spring while it fades in over 120 ms. `from` is "up" (the toast
 * sits at the top), "down" or, when omitted, worked out from where it is.
 */
export function bannerIn(el, from) {
  if (!live() || !isEl(el)) return done();
  const r = el.getBoundingClientRect();
  const dir = from ?? (r.top < (window.innerHeight || 0) / 2 ? "up" : "down");
  const sp = spring("snappy");
  return Promise.all([play(el, { opacity: [0, 1] }, { duration: 120, easing: "ease-out" }).done, play(el, { translate: [dir === "up" ? "0px -12px" : "0px 12px", "0px 0px"] }, { duration: sp.duration, easing: sp.easing }).done]).then(() => {});
}

/** Toast out: a 180 ms fade (no movement). Resolves when done; the caller then hides the element. */
export function bannerOut(el) {
  if (!live() || !isEl(el) || el.hidden) return done();
  const r = play(el, { opacity: [1, 0] }, { duration: 180, easing: EASE_EXIT, fill: "forwards" }, { cap: 260 });
  return r.done.then(() => setTimeout(() => r.anim?.cancel(), 0));
}

// ── Small feedback ──

/** The "wrong password" shake. */
export function shake(el) {
  if (!live() || !isEl(el)) return done();
  return play(el, { translate: ["0px 0px", "-8px 0px", "7px 0px", "-5px 0px", "3px 0px", "0px 0px"] }, { duration: 380, easing: "ease-in-out" }).done;
}

/**
 * A subtle breathing pulse for live indicators. Returns { stop() }; the element stays fully visible after stop.
 * A CSS animation of opacity and transform only (`.dv-breathe`, app.css) on its own compositor layer: no JS frame loop
 * and no repaint of the page under it. Paused while the tab is hidden, none under reduced motion (both in app.css).
 */
export function pulse(el) {
  if (!isEl(el)) return { stop() {}, finished: done() };
  watchHidden();
  el.classList.add("dv-breathe");
  return {
    finished: done(),
    stop() {
      el.classList.remove("dv-breathe");
    },
  };
}
let hiddenWatched = false;
/** `:root.tab-hidden` while the tab is in the background: the endless CSS animations pause on it (app.css). */
function watchHidden() {
  if (hiddenWatched || typeof document === "undefined") return;
  hiddenWatched = true;
  const sync = () => document.documentElement.classList.toggle("tab-hidden", document.hidden);
  document.addEventListener("visibilitychange", sync);
  sync();
}

/**
 * The previous toast, left behind as a non-interactive copy when a new one takes its place: it slides away from the edge
 * (one toast height and 8 px per newer toast), shrinks a little and fades, and is gone after `hold` ms. At most two copies
 * stay, so three toasts are ever visible. Returns the copy (or null without motion).
 */
const GHOSTS = [];
export function stackGhost(el, { hold = 2200 } = {}) {
  if (!live() || !isEl(el) || el.hidden) return null;
  const r = el.getBoundingClientRect();
  if (!r.width) return null;
  const src = [...el.querySelectorAll(".toast-live")].find((n) => n.textContent.trim());
  if (!src) return null;
  const away = r.top + r.height / 2 < (window.innerHeight || 0) / 2 ? 1 : -1; // a top toast's old ones go down, a bottom one's go up
  const step = (r.height + 8) * away;
  const body = src.cloneNode(true);
  for (const n of [body, ...body.querySelectorAll("*")]) for (const a of ["role", "aria-live", "aria-atomic", "id"]) n.removeAttribute?.(a);
  const g = document.createElement("div");
  g.className = "toast toast-ghost";
  g.dataset.tone = el.dataset.tone ?? "ok";
  g.setAttribute("aria-hidden", "true");
  g.inert = true;
  g.append(body);
  g.style.cssText = `position:fixed;margin:0;inset:${r.top}px auto auto ${r.left}px;width:${r.width}px;transform:none;pointer-events:none`;
  (el.parentNode ?? document.body).append(g);
  try {
    g.setAttribute("popover", "manual");
    g.showPopover?.();
  } catch {
    /* no popover support: the fixed layer still shows it */
  }
  // Older copies move one slot further; the third and beyond leave.
  for (const [i, old] of [...GHOSTS].reverse().entries()) {
    if (i >= 1) {
      old.remove();
      GHOSTS.splice(GHOSTS.indexOf(old), 1);
      continue;
    }
    const k = (old.__slot ?? 1) + 1;
    const from = old.__slot ?? 1;
    old.__slot = k;
    const sp = spring("snappy");
    old.animate({ translate: [`0px ${step * from}px`, `0px ${step * k}px`], scale: [1 - 0.04 * from, 1 - 0.04 * k], opacity: [0.9, 0.75] }, { duration: sp.duration, easing: sp.easing, fill: "forwards" });
  }
  g.__slot = 1;
  GHOSTS.push(g);
  const sp = spring("snappy");
  g.animate({ translate: ["0px 0px", `0px ${step}px`], scale: [1, 0.96], opacity: [1, 0.9] }, { duration: sp.duration, easing: sp.easing, fill: "forwards" });
  const gone = () => {
    const i = GHOSTS.indexOf(g);
    if (i >= 0) GHOSTS.splice(i, 1);
    g.remove();
  };
  setTimeout(() => {
    if (!g.isConnected) return;
    const fade = g.animate({ opacity: [0.8, 0] }, { duration: 160, easing: EASE_EXIT, fill: "forwards" });
    fade.finished.then(gone, gone);
    setTimeout(gone, 400);
  }, hold);
  return g;
}

// ── Pull to refresh (touch, phones) ──

/**
 * Pull-to-refresh for `target` (the page): only for touch, only at the top of the page, only for a first move downward.
 * The page follows the finger with a rubber band (`d` = 160 px), an arrow turns over as it arms at 72 px; released armed, the
 * page holds 56 px while `refresh()` runs (at least 500 ms, so it reads as an answer), then springs back and `onDone()` is
 * called (announce "Updated"). Released unarmed, it springs back with the release velocity. With reduced motion the page
 * does not move and a "Refreshing" line shows for the same time. A non-passive touchmove stops the browser's own pull
 * only while this gesture owns the finger.
 * @param {{ target: HTMLElement, indicator: HTMLElement, refresh: () => Promise<unknown> | unknown, enabled?: () => boolean, onDone?: () => void }} o
 */
export function installPullToRefresh({ target, indicator, refresh, enabled = () => true, onDone }) {
  if (typeof document === "undefined" || !target || !indicator || target.__ptr) return;
  target.__ptr = true;
  const ARM = 72;
  const HOLD = 56;
  const sp = new Spring(0, { response: 0.4, bounce: 0.05, precision: 0.2 });
  let t0 = null;
  let busy = false;
  const scroller = () => document.scrollingElement ?? document.documentElement;
  const write = (v) => {
    const reduce = reducedMotion();
    target.style.translate = reduce || v === 0 ? "" : `0px ${v}px`;
    indicator.style.translate = reduce ? "" : `0px ${Math.min(v, ARM + 24) - 44}px`;
    indicator.style.opacity = String(clamp(v / 40, 0, 1));
    indicator.dataset.armed = v >= ARM ? "1" : "";
    indicator.style.setProperty("--ptr-turn", `${clamp(v / ARM, 0, 1) * 180}deg`);
  };
  const reset = () => {
    target.style.translate = "";
    target.style.willChange = "";
    indicator.style.opacity = "0";
    indicator.style.translate = "";
    delete indicator.dataset.armed;
    delete indicator.dataset.busy;
    delete indicator.dataset.active;
  };
  target.addEventListener(
    "touchstart",
    (e) => {
      if (busy || e.touches.length !== 1 || !enabled() || scroller().scrollTop > 0 || document.querySelector("dialog[open]")) return (t0 = null);
      sp.grab();
      t0 = { y: e.touches[0].clientY, x: e.touches[0].clientX, on: false, buf: [] };
    },
    { passive: true },
  );
  target.addEventListener(
    "touchmove",
    (e) => {
      if (!t0 || busy) return;
      const p = e.touches[0];
      const dy = p.clientY - t0.y;
      if (!t0.on) {
        if (Math.abs(dy) < 8 || Math.abs(p.clientX - t0.x) > Math.abs(dy)) return;
        if (dy < 0 || scroller().scrollTop > 0) return (t0 = null);
        t0.on = true;
        t0.y = p.clientY;
        target.style.willChange = "translate";
        indicator.dataset.active = "1";
      }
      if (e.cancelable) e.preventDefault();
      t0.buf.push({ t: e.timeStamp, x: 0, y: p.clientY });
      while (t0.buf.length > 2 && e.timeStamp - t0.buf[0].t > 100) t0.buf.shift();
      sp.value = rubber(p.clientY - t0.y, 160);
      write(sp.value);
    },
    { passive: false },
  );
  const end = async (e) => {
    const s = t0;
    t0 = null;
    if (!s?.on) return;
    const armed = sp.value >= ARM && e.type !== "touchcancel";
    if (!armed) {
      const v = e.type === "touchcancel" ? 0 : fitVelocity(s.buf, e.timeStamp).y;
      await sp.to(0, { velocity: v * 0.3, onUpdate: write });
      reset();
      return;
    }
    busy = true;
    indicator.dataset.busy = "1";
    const started = frames.now();
    sp.to(HOLD, { velocity: 0, onUpdate: write });
    try {
      await refresh();
    } catch {
      /* the page shows its own error */
    }
    await new Promise((r) => setTimeout(r, Math.max(0, 500 - (frames.now() - started))));
    await sp.to(0, { velocity: 0, onUpdate: write });
    reset();
    busy = false;
    onDone?.();
  };
  target.addEventListener("touchend", end);
  target.addEventListener("touchcancel", end);
}

// ── Pages ──

/** The things worth staggering in a page: descend through single wrappers to the first level with siblings. */
function pageItems(container) {
  let items = [...container.children];
  for (let depth = 0; depth < 3 && items.length === 1 && items[0].children.length > 1; depth++) items = [...items[0].children];
  return items.filter((el) => !el.hidden);
}

let hint = null;
let lastNavAt = 0;
/** Tell the next page enter which way it travels: `{ axis: "x", dir: 1 | -1 }` for sub-tabs (shared axis), nothing for a fade-through. */
export function navigationHint(h) {
  hint = h ?? null;
}

/**
 * Fade-through for a new page: its first four blocks fade in over 160 ms and rise 6 px, 20 ms apart (240 ms at most). Sub-tabs
 * use a shared axis instead: a 16 px slide along X in the direction of travel, 180 ms, no stagger.
 */
export function pageEnter(container, { axis = "y", dir = 1 } = {}) {
  if (!live() || !isEl(container)) return done();
  const x = axis === "x";
  const items = x ? [container] : pageItems(container).slice(0, 4);
  return Promise.all(items.map((el, i) => play(el, { opacity: [0, 1], translate: [x ? `${16 * dir}px 0px` : "0px 6px", "0px 0px"] }, { duration: x ? 180 : 160, delay: x ? 0 : i * 20, easing: EASE_OUT, fill: "backwards" }, { cap: 400 }).done)).then(() => {});
}

/**
 * The old page going out: 90 ms fade (and an 8 px slide along X for sub-tabs). Resolves when it is over, with the container
 * already restored, so the caller can swap its content in the next line. Skipped (resolves at once) when the last
 * navigation was under 400 ms ago (rapid tabbing), with reduced motion, or when there is nothing to fade.
 */
export function pageLeave(container, { axis = "y", dir = 1 } = {}) {
  if (!live() || !isEl(container) || !container.children.length) return done();
  if (frames.now() - lastNavAt < 400) return done();
  const r = play(container, { opacity: [1, 0], translate: ["0px 0px", axis === "x" ? `${-8 * dir}px 0px` : "0px 0px"] }, { duration: 90, easing: EASE_EXIT, fill: "forwards" }, { cap: 160 });
  return r.done.then(() => r.anim?.cancel());
}

const routeOf = () => (typeof location !== "undefined" ? (location.hash.replace(/^#\/?/, "").split("?")[0] || "home").toLowerCase() : "");
const lastRoute = new WeakMap(); // container -> route last animated

/** True while the container shows only the loading skeleton (or nothing). */
const isPlaceholder = (root) => root.children.length === 0 || (root.children.length === 1 && root.firstElementChild.matches(".page-skeleton, p.muted"));

/**
 * Entrance for a freshly rendered page. Runs only when the route differs from the last one animated in this container (first
 * render or navigation); re-renders of the same page (auto-refresh, the Reload button) stay still. `force: true` animates regardless.
 */
export function animatePage(root, { force = false } = {}) {
  if (!isEl(root) || isPlaceholder(root)) return done();
  const route = routeOf();
  if (!force && lastRoute.get(root) === route) return done();
  lastRoute.set(root, route);
  const h = hint;
  hint = null;
  lastNavAt = frames.now();
  return pageEnter(root, h ?? {});
}

/** Watch #content so pages animate without views.js calling anything. Call once at start-up. */
export function installAutoAnimations({ content = "content" } = {}) {
  watchReducedMotion();
  if (typeof document === "undefined" || typeof MutationObserver !== "function" || document.__mcbAuto) return;
  document.__mcbAuto = true;
  const c = document.getElementById(content);
  if (c) new MutationObserver(() => animatePage(c)).observe(c, { childList: true });
}
