/**
 * Test helpers published by stream S3 for every stream's tests.
 *
 * 1. createManualClock(): a fake clock with timers. Pass it as deps.clock (or createApp({ clock })) and drive time
 *    with `await clock.advance(ms)`; the real scheduler uses its setTimeout/clearTimeout, so tests never sleep.
 *
 *      const clock = createManualClock();
 *      const scheduler = createScheduler({ config, logger, bus, clock, accounts });
 *      const p = scheduler.schedule({ accountId: "z1", endpointClass: "quote" }, fetchQuote);
 *      await clock.advance(1000);
 *
 * 2. createFakeScheduler(): an in-memory Scheduler that satisfies SERVICE_CONTRACTS.scheduler with no limits at all.
 *    It runs fn at once, records every call, coalesces by coalesceKey like the real one, emits
 *    "account.session_rejected" on session errors (when given a bus) and can be told to throttle a class:
 *
 *      const scheduler = createFakeScheduler({ bus });
 *      await scheduler.schedule({ accountId: "dhan-main", endpointClass: "quote", coalesceKey: "q:NSE:RELIANCE" }, fn);
 *      scheduler.calls        // [{ accountId, endpointClass, priority, coalesceKey, cost }]
 *      scheduler.throttle("dhan-main", "quote", 2000);   // schedule() now rejects UPSTREAM_RATE_LIMITED for 2 s
 *      scheduler.savings      // what recordSaving() reported
 */
import { ENDPOINT_CLASSES, PRIORITIES } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { resolvePolicy } from "./policy.mjs";
import { SAVING_KINDS, isSessionError } from "./scheduler.mjs";

/** 2026-10-19 09:30 IST, a Monday in market hours. */
export const DEFAULT_FAKE_START = Date.UTC(2026, 9, 19, 4, 0, 0);

/** Let every pending promise callback run (one macrotask turn drains the microtask queue). */
export function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * @param {number} [start] epoch ms
 * @returns {{ now(): number, setTimeout(fn: Function, ms: number): object, clearTimeout(h: object): void,
 *   advance(ms: number): Promise<void>, set(ms: number): Promise<void>, flush(): Promise<void>, pending(): number }}
 */
export function createManualClock(start = DEFAULT_FAKE_START) {
  let t = start;
  let seq = 0;
  /** @type {Array<{ id: number, at: number, fn: Function, cleared: boolean }>} */
  let timers = [];

  const nextDue = (limit) => {
    let best = null;
    for (const tm of timers) if (!tm.cleared && tm.at <= limit && (!best || tm.at < best.at || (tm.at === best.at && tm.id < best.id))) best = tm;
    return best;
  };

  const clock = {
    now: () => t,
    setTimeout(fn, ms = 0) {
      const h = { id: ++seq, at: t + Math.max(0, Number(ms) || 0), fn, cleared: false, unref() {}, ref() {} };
      timers.push(h);
      return h;
    },
    clearTimeout(h) {
      if (h) h.cleared = true;
      timers = timers.filter((x) => !x.cleared);
    },
    /** Move time forward, firing due timers in order (and letting promises settle after each). */
    async advance(ms) {
      const target = t + Math.max(0, ms);
      await flushMicrotasks();
      for (;;) {
        const due = nextDue(target);
        if (!due) break;
        t = Math.max(t, due.at);
        due.cleared = true;
        timers = timers.filter((x) => !x.cleared);
        due.fn();
        await flushMicrotasks();
      }
      t = target;
      await flushMicrotasks();
    },
    /** Jump to an absolute time (forwards only). */
    async set(ms) {
      await clock.advance(Math.max(0, ms - t));
    },
    flush: flushMicrotasks,
    pending: () => timers.filter((x) => !x.cleared).length,
  };
  return clock;
}

/**
 * @param {{ bus?: { emit: Function }, policies?: Record<string, object>, accountBroker?: (accountId: string) => string }} [opts]
 *   accountBroker: maps an account id to a broker id for the session_rejected event (default: the id's prefix before "-").
 */
export function createFakeScheduler({ bus, policies, accountBroker = (id) => String(id).split("-")[0] } = {}) {
  const calls = [];
  const inflight = new Map();
  const throttled = new Map();
  const savings = { servedFromStream: 0, servedFromCache: 0, coalesced: 0, batched: 0 };
  const now = () => Date.now();
  const tkey = (a, c) => `${a}\u0000${c}`;
  const throttleLeft = (a, c) => Math.max(0, (throttled.get(tkey(a, c)) ?? 0) - now());

  const fake = {
    calls,
    savings,
    async schedule(opts, fn) {
      const { accountId, endpointClass, coalesceKey } = opts ?? {};
      if (typeof accountId !== "string" || !accountId) throw new TypeError("An accountId is required.");
      if (!ENDPOINT_CLASSES.includes(endpointClass)) throw new TypeError(`Unknown endpoint class "${endpointClass}"`);
      if (opts.priority != null && !PRIORITIES.includes(opts.priority)) throw new TypeError(`Unknown priority "${opts.priority}"`);
      if (opts.signal?.aborted) throw opts.signal.reason ?? new DOMException("aborted", "AbortError");
      const key = endpointClass !== "order" && coalesceKey ? coalesceKey : null;
      if (key && inflight.has(key)) {
        savings.coalesced += 1;
        return inflight.get(key);
      }
      const left = throttleLeft(accountId, endpointClass);
      if (left > 0) throw new BridgeError("UPSTREAM_RATE_LIMITED", `Throttled in the fake scheduler for ${left} ms.`, { retryAfterMs: left });
      calls.push({ accountId, endpointClass, priority: endpointClass === "order" ? "order" : opts.priority ?? "interactive", coalesceKey: coalesceKey ?? null, cost: opts.cost ?? 1 });
      const run = (async () => {
        try {
          return await fn({ signal: opts.signal ?? new AbortController().signal, accountId, endpointClass });
        } catch (err) {
          if (isSessionError(err)) bus?.emit("account.session_rejected", { accountId, broker: accountBroker(accountId), code: err?.code ?? "SESSION_EXPIRED" });
          throw err;
        } finally {
          if (key) inflight.delete(key);
        }
      })();
      if (key) inflight.set(key, run);
      return run;
    },
    tryAcquire(accountId, endpointClass) {
      const left = throttleLeft(accountId, endpointClass);
      return left > 0 ? { ok: false, retryAfterMs: left } : { ok: true, retryAfterMs: 0 };
    },
    headroom(accountId, endpointClass) {
      const left = throttleLeft(accountId, endpointClass);
      return left > 0 ? { remaining: 0, limit: 1, resetMs: left } : { remaining: 1000, limit: 1000, resetMs: 0 };
    },
    pickAccount({ candidates = [], endpointClass } = {}) {
      return candidates.find((c) => throttleLeft(c, endpointClass) === 0) ?? candidates[0] ?? null;
    },
    noteUpstreamThrottle(accountId, endpointClass, retryAfterMs = 1000) {
      fake.throttle(accountId, endpointClass, retryAfterMs);
      bus?.emit("limits.throttled", { accountId, endpointClass, retryAfterMs, upstream: true });
    },
    policyFor(brokerId) {
      return resolvePolicy(brokerId, {}, policies);
    },
    usage() {
      return { accounts: [], savings: { ...savings } };
    },
    checkClient() {
      return { ok: true, retryAfterMs: 0, headers: {} };
    },
    // Test helpers
    recordSaving(kind, count = 1) {
      const field = SAVING_KINDS[kind];
      if (field) savings[field] += count;
    },
    throttle(accountId, endpointClass, ms) {
      throttled.set(tkey(accountId, endpointClass), now() + ms);
    },
    reset() {
      calls.length = 0;
      throttled.clear();
      for (const k of Object.keys(savings)) savings[k] = 0;
    },
  };
  return fake;
}
