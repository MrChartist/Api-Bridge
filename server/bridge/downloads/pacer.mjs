/**
 * The bulk budget share. Downloads are background work: they may use at most `share` of what an account's broker
 * allows (default 0.3, never more than 0.5), they never take what a live read, an order check or another key needs, and
 * they stop while the account is backing off after a broker throttle.
 *
 * How the share is kept (scheduler.headroomWindows() lists every window of the account's history budget):
 *  - the per-second window is PACED: one call every 1 / (share x per-second limit) seconds across all jobs, so a broker
 *    that allows 5 calls a second sees at most 1.5. (A "floor" on a window of 1 to 5 calls cannot work: ceil(0.7 x 3) is 3.)
 *  - every longer window (minute, hour, day) keeps a floor: a call is made only while at least (1 - share) of that
 *    window's limit would still be free afterwards, so live use and other keys always keep the rest of the minute and the day;
 *  - while the class backs off (AIMD) nothing is sent.
 * The call itself is then scheduled at priority "background", the lowest, so any live read that arrives ahead of it in
 * the queue goes first.
 *
 * acquire() only WAITS; it takes no budget (the scheduler does when the call runs), and several jobs asking at once are
 * serialised per account so they cannot all pass the same check.
 */

const SHORT_WINDOWS = new Set(["1s", "second"]);
/** Never wait in one slice longer than this, so a cancel or a pause is noticed quickly. */
const SLICE_MS = 5000;

/** Hard ceiling of the share: background work never gets more than half. */
export const MAX_SHARE = 0.5;

/** Pure decision. @returns {{ ok: boolean, waitMs: number, window: string | null, paceMs: number }} */
export function decide(view, share, cost = 1) {
  const s = Math.min(Math.max(Number(share) || 0, 0), MAX_SHARE);
  let waitMs = Math.max(0, Number(view?.backoffMs) || 0);
  let window = waitMs > 0 ? "backoff" : null;
  let paceMs = 0;
  for (const w of view?.windows ?? []) {
    if (!Number.isFinite(w.limit) || w.limit <= 0) continue;
    if (SHORT_WINDOWS.has(w.window)) {
      // paced: our own rate is share x limit; the window must also have room right now
      if (s > 0) paceMs = Math.max(paceMs, Math.ceil(1000 / (s * w.limit)));
      if (w.remaining - cost < 0) {
        waitMs = Math.max(waitMs, w.resetMs > 0 ? w.resetMs : 250);
        window ??= w.window;
      }
      continue;
    }
    const floor = Math.ceil((1 - s) * w.limit);
    if (w.remaining - cost >= floor) continue;
    const wait = w.resetMs > 0 ? w.resetMs : 1000;
    if (wait > waitMs || window === null) window = w.window;
    waitMs = Math.max(waitMs, wait);
  }
  return { ok: waitMs === 0, waitMs: Math.ceil(waitMs), window, paceMs };
}

/**
 * @param {{ scheduler: any, share: () => number, now?: () => number, sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }} o
 *   share: read on every call, so a changed config applies at once.
 */
export function createPacer({ scheduler, share, now = () => Date.now(), sleep = defaultSleep }) {
  /** account|class -> time the next call may start (pacing) */
  const nextAt = new Map();
  /** account|class -> tail of the serialising chain */
  const chains = new Map();

  const view = (accountId, cls) => {
    if (typeof scheduler?.headroomWindows === "function") return scheduler.headroomWindows(accountId, cls);
    if (typeof scheduler?.headroom === "function") {
      const h = scheduler.headroom(accountId, cls);
      return { windows: [{ bucket: cls, window: "binding", limit: h.limit, remaining: h.remaining, resetMs: h.resetMs }], backoffMs: 0 };
    }
    return { windows: [], backoffMs: 0 };
  };

  async function waitTurn(accountId, cls, { signal, onWait }) {
    const key = `${accountId}|${cls}`;
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const d = decide(view(accountId, cls), share());
      const t = now();
      const paced = Math.max(0, (nextAt.get(key) ?? 0) - t);
      const wait = Math.max(d.waitMs, paced);
      if (wait <= 0) {
        // reserve the slot: the next call is at least paceMs later
        nextAt.set(key, t + d.paceMs);
        return;
      }
      const reason = d.waitMs > 0 ? (d.window === "backoff" ? "backoff" : "budget") : "pace";
      onWait?.({ reason, waitMs: wait, window: d.window });
      await sleep(Math.min(wait, SLICE_MS), signal);
    }
  }

  return {
    /**
     * Wait until a bulk call may start on (account, class).
     * @param {string} accountId
     * @param {string} cls endpoint class ("history")
     * @param {{ signal?: AbortSignal, onWait?: (w: { reason: "pace"|"budget"|"backoff", waitMs: number, window: string | null }) => void }} [opts]
     */
    acquire(accountId, cls = "history", opts = {}) {
      const key = `${accountId}|${cls}`;
      const prev = chains.get(key) ?? Promise.resolve();
      const run = prev.catch(() => {}).then(() => waitTurn(accountId, cls, opts));
      chains.set(key, run);
      // do not keep a settled chain alive
      run.then(
        () => chains.get(key) === run && chains.delete(key),
        () => chains.get(key) === run && chains.delete(key),
      );
      return run;
    },
    /** Calls a second the share allows on this account's history budget (for estimates); Infinity when unlimited. */
    callsPerSecond(accountId, cls = "history") {
      const s = Math.min(Math.max(Number(share()) || 0, 0), MAX_SHARE);
      let rate = Infinity;
      for (const w of view(accountId, cls).windows) {
        if (!Number.isFinite(w.limit) || w.limit <= 0) continue;
        if (SHORT_WINDOWS.has(w.window)) rate = Math.min(rate, s * w.limit);
      }
      return rate;
    },
  };
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const t = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
