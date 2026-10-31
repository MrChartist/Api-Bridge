/**
 * Sliding-window order-rate limiter, per account (stream S9). Place, modify and cancel all take a slot, because
 * exchanges and brokers count every order action against the per-second threshold (needs verification per broker).
 *
 * A rate of R orders per second allows N = max(1, floor(R)) actions in any window of W = N / R seconds. For whole
 * numbers that is simply "R in any 1 s"; for R = 2.5 it is 2 in any 800 ms; for R = 0.5 it is 1 in any 2 s. A
 * sliding window (not a fixed one) means no burst of 2N across a second boundary.
 *
 * In memory only: after a restart the window starts empty, which can at most allow one window's worth again.
 */

/**
 * @param {number} ratePerSecond  > 0
 * @returns {{ n: number, windowMs: number }}
 */
export function windowFor(ratePerSecond) {
  const r = Number(ratePerSecond);
  if (!(r > 0) || !Number.isFinite(r)) return { n: 1, windowMs: 1000 };
  const n = Math.max(1, Math.floor(r));
  return { n, windowMs: Math.ceil((n / r) * 1000) };
}

/**
 * @returns {{ acquire(accountId: string, ratePerSecond: number, nowMs: number): { ok: boolean, retryAfterMs: number, count: number, n: number },
 *   peek(accountId: string, ratePerSecond: number, nowMs: number): { ok: boolean, retryAfterMs: number, count: number, n: number },
 *   countLastSecond(accountId: string, nowMs: number): number }}
 */
export function createOrderRateWindow() {
  /** @type {Map<string, number[]>} accountId -> action timestamps (ascending), last few seconds only */
  const stamps = new Map();
  const KEEP_MS = 10_000;

  const prune = (accountId, nowMs) => {
    const list = stamps.get(accountId);
    if (!list) return [];
    while (list.length && list[0] <= nowMs - KEEP_MS) list.shift();
    if (!list.length) stamps.delete(accountId);
    return list;
  };

  const look = (accountId, ratePerSecond, nowMs) => {
    const { n, windowMs } = windowFor(ratePerSecond);
    const list = prune(accountId, nowMs);
    const inWindow = list.filter((t) => t > nowMs - windowMs);
    if (inWindow.length < n) return { ok: true, retryAfterMs: 0, count: inWindow.length, n };
    // The (count - n + 1)-th oldest stamp in the window must leave it before another action fits.
    const blocker = inWindow[inWindow.length - n];
    return { ok: false, retryAfterMs: Math.max(1, blocker + windowMs - nowMs), count: inWindow.length, n };
  };

  return {
    acquire(accountId, ratePerSecond, nowMs) {
      const v = look(accountId, ratePerSecond, nowMs);
      if (v.ok) {
        if (!stamps.has(accountId)) stamps.set(accountId, []);
        stamps.get(accountId).push(nowMs);
        return { ...v, count: v.count + 1 };
      }
      return v;
    },
    peek: look,
    countLastSecond(accountId, nowMs) {
      return prune(accountId, nowMs).filter((t) => t > nowMs - 1000).length;
    },
  };
}
