/**
 * Background gate. The ONE check every scheduled background REST job makes before each broker call (for example
 * vol capture and the readiness probe). Users always go first: background work may use at most `share` of every window, and
 * `share` is 50 % unless the owner raised it, and can never be more than 80 %.
 *
 * Rule: allow(accountId, endpointClass, { share = 0.5, cost = 1 }) is true only if, for EVERY window covering the
 * class (the class bucket and each group bucket that lists it; per second, minute, hour, day ...),
 *     remaining − cost ≥ ceil((1 − share) × limit)
 * and the class is not backing off after an upstream throttle. So a background call never leaves a window with less
 * than (1 − share) of its limit, i.e. never below 50 % at the default.
 *
 * The gate takes no budget and counts work already queued on the buckets. The caller then schedules the call itself
 * at `priority: "background"` WITH `backgroundShare` (the same share), so the scheduler re-checks the floor at the
 * moment it takes the budget: several jobs that pass allow() in the same tick, or user work queued ahead, can never
 * push a window below the floor. A job with a stricter limiter of its own (the recorder) keeps it on top.
 *
 *   const gate = createBackgroundGate({ scheduler: deps.scheduler });
 *   if (!gate.allow(acc, "optionChain")) return later(gate.waitMs(acc, "optionChain"));
 *   await deps.scheduler.schedule({ accountId: acc, endpointClass: "optionChain", priority: "background", backgroundShare: MAX_BACKGROUND_SHARE }, fn);
 */

/** The default share: background work gets half of any window. */
export const MAX_BACKGROUND_SHARE = 0.5;
/** The most a caller may ask for (downloads and recordings let the owner raise their share to 80 %); anything above is cut. */
export const MAX_BACKGROUND_SHARE_CEILING = 0.8;
/** Retry hint when a window is full but reports no reset time. */
const FALLBACK_WAIT_MS = 1000;

/**
 * Pure decision over a set of windows.
 * @param {{ windows: Array<{ bucket?: string, window: string, limit: number, remaining: number, resetMs: number }>, backoffMs?: number }} view
 * @param {{ share?: number, cost?: number }} [opts]
 * @returns {{ ok: boolean, waitMs: number, binding: { bucket?: string, window: string, remaining: number, floor: number } | null }}
 *   waitMs: 0 when ok; else when to look again (the largest reset among the windows that refuse, or the back-off).
 */
export function gateDecision(view, { share = MAX_BACKGROUND_SHARE, cost = 1 } = {}) {
  const s = clampShare(share);
  const c = normaliseCost(cost);
  const backoff = Math.max(0, Number(view?.backoffMs) || 0);
  let waitMs = backoff;
  let binding = null;
  let ok = backoff === 0;
  for (const w of view?.windows ?? []) {
    if (!Number.isFinite(w.limit)) continue; // paper accounts: no broker window
    const floor = Math.ceil((1 - s) * w.limit);
    if (w.remaining - c >= floor) continue;
    ok = false;
    waitMs = Math.max(waitMs, w.resetMs > 0 ? w.resetMs : FALLBACK_WAIT_MS);
    if (!binding || w.remaining - floor < binding.remaining - binding.floor) binding = { bucket: w.bucket, window: w.window, remaining: w.remaining, floor };
  }
  if (!ok && waitMs === 0) waitMs = FALLBACK_WAIT_MS;
  return { ok, waitMs: ok ? 0 : Math.ceil(waitMs), binding };
}

/** Windows this short may be used up by a guaranteed background call (floorDecision): only the per-second ones. */
const SHORT_WINDOWS = new Set(["1s"]);

/**
 * The guaranteed share (pure). On a broker whose class allows 1 call a second, `gateDecision` never says yes: the floor
 * of a 1-call window is the whole window. A job that must still run now and then (the Live events REST fallback) may
 * then take ONE call when every per-second window is completely free (nothing used, nothing queued, no back-off),
 * while every longer window (minute, hour, day) still keeps its usual floor. The caller decides how rarely (seconds
 * between such calls) and only while nobody is using the broker; the scheduler still enforces every published limit.
 * @returns {{ ok: boolean, waitMs: number }}
 */
export function floorDecision(view, { share = MAX_BACKGROUND_SHARE, cost = 1 } = {}) {
  const s = clampShare(share);
  const c = normaliseCost(cost);
  const backoff = Math.max(0, Number(view?.backoffMs) || 0);
  let waitMs = backoff;
  let ok = backoff === 0;
  for (const w of view?.windows ?? []) {
    if (!Number.isFinite(w.limit)) continue;
    const floor = SHORT_WINDOWS.has(w.window) ? 0 : Math.ceil((1 - s) * w.limit);
    // A short window must also be empty: a guaranteed call never shares a second with anyone's call.
    const free = SHORT_WINDOWS.has(w.window) ? w.remaining >= w.limit : true;
    if (free && w.remaining - c >= floor) continue;
    ok = false;
    waitMs = Math.max(waitMs, w.resetMs > 0 ? w.resetMs : FALLBACK_WAIT_MS);
  }
  if (!ok && waitMs === 0) waitMs = FALLBACK_WAIT_MS;
  return { ok, waitMs: ok ? 0 : Math.ceil(waitMs) };
}

function clampShare(share) {
  const n = Number(share);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_BACKGROUND_SHARE_CEILING);
}

function normaliseCost(cost) {
  const n = Number(cost);
  if (!Number.isFinite(n) || n < 1) throw new TypeError("cost must be a number ≥ 1");
  return Math.ceil(n);
}

/**
 * @param {{ scheduler: { headroom(accountId: string, endpointClass: string): { remaining: number, limit: number, resetMs: number },
 *   headroomWindows?: (accountId: string, endpointClass: string) => { windows: any[], backoffMs: number } } }} deps
 */
export function createBackgroundGate({ scheduler }) {
  if (!scheduler || typeof scheduler.headroom !== "function") throw new TypeError("createBackgroundGate needs a scheduler");
  /** Every window when the scheduler can list them; else the binding window from the contract's headroom(). */
  const view = (accountId, endpointClass) => {
    if (typeof scheduler.headroomWindows === "function") return scheduler.headroomWindows(accountId, endpointClass);
    const h = scheduler.headroom(accountId, endpointClass);
    return { windows: [{ bucket: endpointClass, window: "binding", limit: h.limit, remaining: h.remaining, resetMs: h.resetMs }], backoffMs: 0 };
  };
  return Object.freeze({
    /** True when a background call of `cost` keeps every window at or above (1 − share) of its limit. */
    allow(accountId, endpointClass, opts = {}) {
      return gateDecision(view(accountId, endpointClass), opts).ok;
    },
    /** 0 when allow() would say yes now; else ms until it is worth asking again. */
    waitMs(accountId, endpointClass, opts = {}) {
      return gateDecision(view(accountId, endpointClass), opts).waitMs;
    },
    /** The guaranteed share (floorDecision): one call now uses no second anyone else is using. */
    allowFloor(accountId, endpointClass, opts = {}) {
      return floorDecision(view(accountId, endpointClass), opts).ok;
    },
    /** The full decision (for status pages and logs). */
    check(accountId, endpointClass, opts = {}) {
      return gateDecision(view(accountId, endpointClass), opts);
    },
  });
}
