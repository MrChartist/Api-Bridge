/**
 * Background gate (docs/spec/README.md §3.1 F0, conflict C12). The ONE check every scheduled background REST job
 * makes before each broker call: recorder REST source, vol capture and snapshot, fno sweep, exposure REST fallback,
 * alerts poll, readiness probe. Users always go first: background work may use at most `share` of every window, and
 * `share` can never be more than 50 % (BRD §7.2).
 *
 * Rule: allow(accountId, endpointClass, { share = 0.5, cost = 1 }) is true only if, for EVERY window covering the
 * class (the class bucket and each group bucket that lists it; per second, minute, hour, day ...),
 *     remaining − cost ≥ ceil((1 − share) × limit)
 * and the class is not backing off after an upstream throttle. So a background call never leaves a window with less
 * than (1 − share) of its limit, i.e. never below 50 % at the default.
 *
 * The gate takes no budget. The caller then schedules the call itself at `priority: "background"` (the scheduler
 * still enforces the broker limits). A job with a stricter limiter of its own (the recorder) keeps it on top.
 *
 *   const gate = createBackgroundGate({ scheduler: deps.scheduler });
 *   if (!gate.allow(acc, "optionChain")) return later(gate.waitMs(acc, "optionChain"));
 *   await deps.scheduler.schedule({ accountId: acc, endpointClass: "optionChain", priority: "background" }, fn);
 */

/** Background work never gets more than half of any window (BRD §7.2). */
export const MAX_BACKGROUND_SHARE = 0.5;
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

function clampShare(share) {
  const n = Number(share);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_BACKGROUND_SHARE);
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
    /** The full decision (for status pages and logs). */
    check(accountId, endpointClass, opts = {}) {
      return gateDecision(view(accountId, endpointClass), opts);
    },
  });
}
