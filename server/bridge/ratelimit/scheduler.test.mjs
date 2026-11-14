/**
 * Scheduler acceptance tests on a fake clock: no sleeps, no network, stub broker calls.
 */
import { describe, expect, it } from "vitest";
import { SessionRequiredError } from "../../brokers/contract.mjs";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { SERVICE_CONTRACTS, assertService } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { TOPICS, createEventBus } from "../core/eventBus.mjs";
import { createLogger } from "../core/logger.mjs";
import { createManualClock } from "./fake.mjs";
import { createScheduler, isSessionError, isThrottleError, recordSaving, retryAfterFrom } from "./scheduler.mjs";
import { IST_OFFSET_MS } from "./tokenBucket.mjs";

const v = (spec) => ({ ...spec, verified: true, source: "https://example.test/limits" });

/** A small policy table for tests that need a specific shape. */
const TEST_POLICIES = Object.freeze({
  shared: { brokerId: "shared", limits: { order: v({ perSecond: 1 }), quote: v({ perSecond: 1 }) }, groups: { all: { classes: ["order", "quote"], ...v({ perSecond: 1 }) } }, maxQuoteBatch: 1, feed: {}, pooling: "unknown" },
  roomy: { brokerId: "roomy", limits: { quote: v({ perSecond: 1000 }), history: v({ perSecond: 1000 }), order: v({ perSecond: 10 }) }, groups: {}, maxQuoteBatch: 1, feed: {}, pooling: "unknown" },
  daily: { brokerId: "daily", limits: { quote: v({ perSecond: 10, perDay: 3 }) }, groups: {}, maxQuoteBatch: 1, feed: {}, pooling: "unknown" },
});

function setup({ accounts = [{ id: "z1", broker: "zerodha" }], ratelimit = {}, policies, start, random = () => 0, accountsOnBus = true } = {}) {
  const clock = createManualClock(start);
  const logger = createLogger({ level: "silent" });
  const bus = createEventBus({ logger, topics: TOPICS });
  const events = [];
  for (const topic of ["limits.throttled", "account.session_rejected"]) bus.on(topic, (p) => events.push({ topic, ...p }));
  // accountsOnBus false: the account manager does not hear the scheduler's events, so it cannot echo a rejection back as a status change.
  const accountsSvc = createFakeAccountManager({ accounts, ...(accountsOnBus ? { bus } : {}) });
  // `random` fixes the 0-250 ms back-off jitter (0 by default) so delays are exact; the jitter has its own tests.
  const s = createScheduler({ config: { ratelimit }, logger, bus, clock, accounts: accountsSvc }, { random, ...(policies ? { policies } : {}) });
  /** Broker-call recorder: start times per (account, class). */
  const starts = [];
  const call = (accountId, endpointClass, opts = {}, result = "ok") =>
    s.schedule({ accountId, endpointClass, ...opts }, async () => {
      starts.push({ accountId, endpointClass, t: clock.now(), tag: opts.tag });
      return typeof result === "function" ? result() : result;
    });
  return { clock, bus, events, accounts: accountsSvc, s, starts, call };
}

/** Largest number of starts in any interval shorter than windowMs. */
function maxInWindow(times, windowMs) {
  const s = [...times].sort((a, b) => a - b);
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < s.length; hi++) {
    while (s[hi] - s[lo] >= windowMs) lo += 1;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

async function drain(clock, promises, stepMs = 1000, maxSteps = 100_000) {
  let done = false;
  Promise.allSettled(promises).then(() => {
    done = true;
  });
  for (let i = 0; i < maxSteps && !done; i++) await clock.advance(stepMs);
  expect(done).toBe(true);
  return Promise.allSettled(promises);
}

describe("contract", () => {
  it("implements every Scheduler method", () => {
    const { s } = setup();
    expect(() => assertService("scheduler", s)).not.toThrow();
    for (const m of SERVICE_CONTRACTS.scheduler.methods) expect(typeof s[m]).toBe("function");
  });

  it("validates its inputs", async () => {
    const { s } = setup();
    await expect(s.schedule({ accountId: "z1", endpointClass: "quotes" }, async () => 1)).rejects.toThrow(/Unknown endpoint class/);
    await expect(s.schedule({ accountId: "", endpointClass: "quote" }, async () => 1)).rejects.toThrow(/accountId/);
    await expect(s.schedule({ accountId: "z1", endpointClass: "quote", priority: "urgent" }, async () => 1)).rejects.toThrow(/Unknown priority/);
    await expect(s.schedule({ accountId: "z1", endpointClass: "quote", cost: 0 }, async () => 1)).rejects.toThrow(/cost/);
    await expect(s.schedule({ accountId: "z1", endpointClass: "quote" })).rejects.toThrow(/function/);
    await expect(s.schedule({ accountId: "nobody", endpointClass: "quote" }, async () => 1)).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
    expect(() => s.tryAcquire("z1", "nope")).toThrow(TypeError);
  });

  it("classifies broker errors", () => {
    expect(isSessionError(new SessionRequiredError())).toBe(true);
    expect(isSessionError({ code: "UPSTREAM_AUTH" })).toBe(true);
    expect(isSessionError(new BridgeError("SESSION_EXPIRED"))).toBe(true);
    expect(isSessionError({ code: "UPSTREAM_ERROR" })).toBe(false);
    expect(isThrottleError({ code: "UPSTREAM_RATE_LIMIT" })).toBe(true);
    expect(isThrottleError(new BridgeError("UPSTREAM_RATE_LIMITED"))).toBe(true);
    expect(isThrottleError({ statusCode: 429 })).toBe(true);
    expect(isThrottleError({ code: "UPSTREAM_ERROR" })).toBe(false);
    expect(retryAfterFrom({ retryAfterMs: 2500 })).toBe(2500);
    expect(retryAfterFrom({ retryAfter: 3 })).toBe(3000);
    expect(retryAfterFrom({})).toBeUndefined();
  });
});

describe("acceptance: no window is ever exceeded", () => {
  it("holds Zerodha quotes to 1 a second under a 1,000-request burst", async () => {
    const { clock, call, starts } = setup();
    const ps = Array.from({ length: 1000 }, () => call("z1", "quote", { priority: "background", maxWaitMs: 3_600_000 }));
    const results = await drain(clock, ps, 5000);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(starts).toHaveLength(1000);
    expect(maxInWindow(starts.map((x) => x.t), 1000)).toBe(1);
  });

  it("holds every Dhan order window (10/s, 250/min, 1,000/hour) under a 1,000-order burst", async () => {
    const { clock, call, starts } = setup({ accounts: [{ id: "d1", broker: "dhan" }] });
    const ps = Array.from({ length: 1000 }, () => call("d1", "order", { maxWaitMs: 3_600_000 }));
    await drain(clock, ps, 10_000);
    const times = starts.map((x) => x.t);
    expect(times).toHaveLength(1000);
    expect(maxInWindow(times, 1000)).toBeLessThanOrEqual(10);
    expect(maxInWindow(times, 60_000)).toBeLessThanOrEqual(250);
    expect(maxInWindow(times, 3_600_000)).toBeLessThanOrEqual(1000);
  });

  it("holds a shared group budget across classes (Fyers data APIs: 5/s and 50/min for quote + history together)", async () => {
    const { clock, call, starts } = setup({ accounts: [{ id: "f1", broker: "fyers" }] });
    const ps = Array.from({ length: 300 }, (_, i) => call("f1", i % 2 ? "quote" : "history", { priority: "background", maxWaitMs: 3_600_000 }));
    await drain(clock, ps, 5000);
    const times = starts.map((x) => x.t);
    expect(times).toHaveLength(300);
    expect(maxInWindow(times, 1000)).toBeLessThanOrEqual(5);
    expect(maxInWindow(times, 60_000)).toBeLessThanOrEqual(50);
  });

  it("reserves budget for a call that makes several upstream requests (cost)", async () => {
    const { clock, call, starts } = setup();
    const t0 = clock.now();
    const big = call("z1", "history", { cost: 7 }); // Zerodha history 3/s: 3 now, 3 after 1.1 s, 1 after 2.2 s
    const next = call("z1", "history");
    await clock.advance(2199);
    expect(starts.map((x) => x.t - t0)).toEqual([0]);
    await clock.advance(1);
    await Promise.all([big, next]);
    expect(starts.map((x) => x.t - t0)).toEqual([0, 2200]);
  });

  it("enforces IST daily caps and resets them at midnight IST", async () => {
    const midnight = Date.UTC(2026, 9, 20) - IST_OFFSET_MS;
    const { clock, call, starts } = setup({ accounts: [{ id: "a1", broker: "daily" }], policies: TEST_POLICIES, start: midnight - 10_000 });
    const ps = Array.from({ length: 4 }, () => call("a1", "quote", { maxWaitMs: 60_000 }));
    await clock.advance(9_999);
    expect(starts).toHaveLength(3);
    await clock.advance(1);
    await Promise.all(ps);
    expect(starts[3].t).toBe(midnight);
  });
});

describe("acceptance: priorities", () => {
  it("starts an order queued behind 500 reads before the next read", async () => {
    const { clock, call, starts } = setup({ accounts: [{ id: "s1", broker: "shared" }], policies: TEST_POLICIES });
    const reads = Array.from({ length: 500 }, () => call("s1", "quote", { priority: "interactive", maxWaitMs: 3_600_000 }));
    const order = call("s1", "order", { tag: "order" });
    await clock.advance(2000);
    await order;
    expect(starts[0].endpointClass).toBe("quote");
    expect(starts[1]).toMatchObject({ endpointClass: "order", tag: "order" });
    expect(starts[1].t - starts[0].t).toBeLessThanOrEqual(1100);
    void reads;
  });

  it("does not starve background work under sustained interactive load", async () => {
    const { clock, call, starts } = setup();
    const t0 = clock.now();
    const inter = [];
    for (let i = 0; i < 5; i++) inter.push(call("z1", "quote", { tag: `early-${i}`, maxWaitMs: 3_600_000 }));
    const bg = call("z1", "quote", { priority: "background", tag: "bg", maxWaitMs: 3_600_000 });
    // Two new interactive requests every second for a minute: more than the 1/s budget can serve.
    for (let sec = 0; sec < 60; sec++) {
      inter.push(call("z1", "quote", { tag: `late-${sec}-a`, maxWaitMs: 3_600_000 }), call("z1", "quote", { tag: `late-${sec}-b`, maxWaitMs: 3_600_000 }));
      await clock.advance(1000);
    }
    await bg;
    const bgStart = starts.find((x) => x.tag === "bg");
    expect(bgStart.t - t0).toBeLessThan(15_000);
    // Interactive work that arrived after the background request still waited behind it once it had aged.
    expect(starts.some((x) => x.tag?.startsWith("late-") && x.t > bgStart.t)).toBe(true);
  });

  it("serves live before interactive and caps a read's priority below orders", async () => {
    const { clock, call, starts } = setup();
    call("z1", "quote", { tag: "first" });
    call("z1", "quote", { tag: "inter" });
    call("z1", "quote", { priority: "order", tag: "claims-order" }); // becomes "live"
    await clock.advance(3000);
    expect(starts.map((x) => x.tag)).toEqual(["first", "claims-order", "inter"]);
  });

  it("a read that names priority \"order\" is capped at live: it queues behind a real order that arrived after it", async () => {
    const { clock, call, starts } = setup({ accounts: [{ id: "s1", broker: "shared" }], policies: TEST_POLICIES });
    call("s1", "quote", { tag: "first" }); // takes the shared 1 a second; everything after waits for it
    call("s1", "quote", { priority: "order", tag: "read-claiming-order" }); // arrives first
    call("s1", "order", { tag: "real-order" }); // arrives second, but is the only one that is an order
    await clock.advance(5000);
    expect(starts.map((x) => x.tag)).toEqual(["first", "real-order", "read-claiming-order"]);
  });

  it("limits concurrent reads per account but never holds back orders", async () => {
    const { clock, s } = setup({ accounts: [{ id: "r1", broker: "roomy" }], policies: TEST_POLICIES, ratelimit: { maxInFlightPerAccount: 2 } });
    const release = [];
    let running = 0;
    const slow = () => new Promise((r) => release.push(r)).finally(() => (running -= 1));
    const reads = Array.from({ length: 5 }, () =>
      s.schedule({ accountId: "r1", endpointClass: "quote" }, () => {
        running += 1;
        return slow();
      }),
    );
    let orderRan = false;
    const order = s.schedule({ accountId: "r1", endpointClass: "order" }, async () => (orderRan = true));
    await clock.advance(10);
    expect(running).toBe(2);
    await order;
    expect(orderRan).toBe(true);
    while (release.length) {
      release.shift()("done");
      await clock.advance(1);
    }
    await expect(Promise.all(reads)).resolves.toHaveLength(5);
  });
});

describe("acceptance: coalescing", () => {
  it("makes one broker call for 50 identical concurrent reads", async () => {
    const { clock, s } = setup();
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return { ltp: 2850.5 };
    };
    const ps = Array.from({ length: 50 }, () => s.schedule({ accountId: "z1", endpointClass: "quote", coalesceKey: "quote:z1:NSE:RELIANCE" }, fn));
    await clock.advance(10);
    const results = await Promise.all(ps);
    expect(calls).toBe(1);
    expect(results.every((r) => r.ltp === 2850.5)).toBe(true);
    expect(s.usage().savings.coalesced).toBe(49);
    // After it settles, the same key makes a fresh call.
    await clock.advance(1100);
    await s.schedule({ accountId: "z1", endpointClass: "quote", coalesceKey: "quote:z1:NSE:RELIANCE" }, fn);
    expect(calls).toBe(2);
  });

  it("shares one error between coalesced callers, unchanged", async () => {
    const { clock, s } = setup();
    const boom = new Error("broker down");
    const ps = Array.from({ length: 3 }, () => s.schedule({ accountId: "z1", endpointClass: "history", coalesceKey: "h" }, async () => Promise.reject(boom)));
    const checks = ps.map((p) => expect(p).rejects.toBe(boom));
    await clock.advance(1);
    await Promise.all(checks);
  });

  it("never coalesces orders", async () => {
    const { clock, s } = setup();
    let n = 0;
    const ps = [1, 2].map(() => s.schedule({ accountId: "z1", endpointClass: "order", coalesceKey: "same" }, async () => ++n));
    await clock.advance(10);
    expect(await Promise.all(ps)).toEqual([1, 2]);
  });

  it("starts a fresh call for a caller who joins after every earlier waiter aborted a started call", async () => {
    const { clock, s } = setup();
    let runs = 0;
    const slow = ({ signal }) =>
      new Promise((resolve, reject) => {
        runs += 1;
        const n = runs;
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        clock.setTimeout(() => resolve(`data${n}`), 200);
      });
    const ac = new AbortController();
    const a = s.schedule({ accountId: "z1", endpointClass: "quote", coalesceKey: "k-abort", signal: ac.signal }, slow);
    const aDone = expect(a).rejects.toMatchObject({ name: "AbortError" });
    await clock.advance(1);
    expect(runs).toBe(1);
    ac.abort();
    // B joins in the same tick, before the aborted run has settled.
    const b = s.schedule({ accountId: "z1", endpointClass: "quote", coalesceKey: "k-abort" }, slow);
    await aDone;
    await clock.advance(1000);
    await clock.advance(1000);
    await expect(b).resolves.toBe("data2");
    expect(runs).toBe(2);
  });

  it("promotes a waiting shared call when a more urgent caller joins", async () => {
    const { clock, call, starts, s } = setup();
    call("z1", "quote", { tag: "first" });
    call("z1", "quote", { tag: "inter" });
    const bg = s.schedule({ accountId: "z1", endpointClass: "quote", priority: "background", coalesceKey: "k" }, async () => starts.push({ tag: "shared", t: clock.now() }));
    const live = s.schedule({ accountId: "z1", endpointClass: "quote", priority: "live", coalesceKey: "k" }, async () => "never runs");
    await clock.advance(3000);
    await Promise.all([bg, live]);
    expect(starts.map((x) => x.tag)).toEqual(["first", "shared", "inter"]);
  });
});

describe("acceptance: upstream throttling and sessions", () => {
  it("pauses only the throttled account and class, honouring Retry-After", async () => {
    const { clock, s, call, starts, events } = setup({ accounts: [{ id: "z1", broker: "zerodha" }, { id: "z2", broker: "zerodha" }] });
    const err = Object.assign(new Error("Too many requests"), { code: "UPSTREAM_RATE_LIMIT", retryAfterMs: 5000 });
    const t0 = clock.now();
    const first = expect(s.schedule({ accountId: "z1", endpointClass: "quote" }, async () => Promise.reject(err))).rejects.toBe(err);
    await clock.advance(1);
    await first;
    expect(events).toContainEqual({ topic: "limits.throttled", accountId: "z1", endpointClass: "quote", retryAfterMs: 5000, upstream: true });
    const z1quote = call("z1", "quote", { tag: "z1q" });
    const z1hist = call("z1", "history", { tag: "z1h" });
    const z2quote = call("z2", "quote", { tag: "z2q" });
    await clock.advance(10);
    await Promise.all([z1hist, z2quote]);
    expect(starts.map((x) => x.tag).sort()).toEqual(["z1h", "z2q"]);
    expect(s.headroom("z1", "quote")).toMatchObject({ remaining: 0 });
    await clock.advance(5000);
    await z1quote;
    expect(starts.find((x) => x.tag === "z1q").t - t0).toBeGreaterThanOrEqual(5000);
  });

  it("backs off exponentially when the broker gives no Retry-After", () => {
    const { s, clock } = setup();
    s.noteUpstreamThrottle("z1", "quote");
    expect(s.tryAcquire("z1", "quote").retryAfterMs).toBe(1000);
    s.noteUpstreamThrottle("z1", "quote");
    expect(s.tryAcquire("z1", "quote").retryAfterMs).toBe(2000);
    s.noteUpstreamThrottle("z1", "quote");
    expect(s.tryAcquire("z1", "quote").retryAfterMs).toBe(4000);
    void clock;
  });

  it("emits account.session_rejected on a session error and rethrows it unchanged", async () => {
    const { clock, s, events } = setup({ accounts: [{ id: "z1", broker: "zerodha" }, { id: "z2", broker: "zerodha" }] });
    const err = new SessionRequiredError();
    const p = expect(s.schedule({ accountId: "z1", endpointClass: "portfolio" }, async () => Promise.reject(err))).rejects.toBe(err);
    await clock.advance(1);
    await p;
    expect(events).toContainEqual({ topic: "account.session_rejected", accountId: "z1", broker: "zerodha", code: "SESSION_LOGIN_REQUIRED" });
    // The account is out of pooled routing until it reconnects.
    expect(s.pickAccount({ candidates: ["z1", "z2"], endpointClass: "quote" })).toBe("z2");
  });
});

describe("a rejected broker session", () => {
  // The fake account manager normally hears the rejection on the bus and reports the account as unhealthy itself, which would
  // hide the scheduler's own record. These tests take it off the bus and make its view of the account always "connected":
  // only the scheduler's own record of the rejection can then keep the account out of pooled routing.
  const blind = (accounts) => {
    accounts.status = () => ({ state: "connected" });
    return accounts;
  };

  it("takes the account out of pooled routing on its own record, and a new login puts it back", async () => {
    const { clock, s, accounts, bus } = setup({ accounts: [{ id: "z1", broker: "zerodha" }, { id: "z2", broker: "zerodha" }], accountsOnBus: false });
    blind(accounts);
    expect(s.pickAccount({ candidates: ["z1", "z2"], endpointClass: "quote" })).toBe("z1"); // the baseline: z1 first
    const p = expect(s.schedule({ accountId: "z1", endpointClass: "portfolio" }, async () => Promise.reject(new SessionRequiredError()))).rejects.toBeInstanceOf(SessionRequiredError);
    await clock.advance(1);
    await p;
    expect(s.pickAccount({ candidates: ["z1", "z2"], endpointClass: "quote" })).toBe("z2");
    expect(s.pickAccount({ candidates: ["z1"], endpointClass: "quote" })).toBeNull(); // nothing healthy to pool on
    bus.emit("account.status", { accountId: "z1", session: "connected" });
    await clock.advance(1);
    expect(s.pickAccount({ candidates: ["z1", "z2"], endpointClass: "quote" })).toBe("z1");
  });

  it("a throttle or an ordinary failure does not mark the session rejected", async () => {
    const { clock, s, accounts } = setup({ accounts: [{ id: "z1", broker: "zerodha" }, { id: "z2", broker: "zerodha" }], accountsOnBus: false });
    blind(accounts);
    const p = expect(s.schedule({ accountId: "z1", endpointClass: "portfolio" }, async () => Promise.reject(Object.assign(new Error("boom"), { code: "UPSTREAM_ERROR" })))).rejects.toThrow("boom");
    await clock.advance(1);
    await p;
    expect(s.pickAccount({ candidates: ["z1", "z2"], endpointClass: "quote" })).toBe("z1");
  });
});

describe("deadlines and aborts", () => {
  it("refuses up front when a request could not start before its deadline", async () => {
    const { s, call } = setup();
    const ps = Array.from({ length: 15 }, () => call("z1", "quote")); // interactive: 10 s default wait at 1/s
    const all = Promise.allSettled(ps);
    const settled = await Promise.allSettled(ps.slice(-3));
    void all;
    for (const r of settled) {
      expect(r.status).toBe("rejected");
      expect(r.reason).toMatchObject({ code: "UPSTREAM_RATE_LIMITED", status: 429 });
      expect(r.reason.retryAfterMs).toBeGreaterThan(10_000);
      expect(r.reason.message).toMatch(/zerodha quote budget for account z1 is fully used/);
    }
    expect(s.usage().accounts[0].classes.quote.refusedToday).toBeGreaterThanOrEqual(3);
  });

  it("refuses a queued request whose deadline passes while it waits", async () => {
    const { clock, s, call, events } = setup();
    call("z1", "quote");
    const p = expect(call("z1", "quote", { maxWaitMs: 2000 })).rejects.toMatchObject({ code: "UPSTREAM_RATE_LIMITED" });
    s.noteUpstreamThrottle("z1", "quote", 30_000);
    await clock.advance(2000);
    await p;
    expect(events.some((e) => e.topic === "limits.throttled" && e.upstream === false)).toBe(true);
  });

  it("refuses requests that can never fit in a day", async () => {
    const { call } = setup({ accounts: [{ id: "a1", broker: "daily" }], policies: TEST_POLICIES });
    await expect(call("a1", "quote", { cost: 4 })).rejects.toMatchObject({ code: "UPSTREAM_RATE_LIMITED", message: expect.stringMatching(/whole day/) });
  });

  it("refuses requests beyond the per-account queue bound", async () => {
    const { s, call } = setup({ ratelimit: { queue: { maxQueuedPerAccount: 2 } } });
    const ok = [call("z1", "quote"), call("z1", "quote"), call("z1", "quote")]; // one runs, two wait
    await expect(call("z1", "quote")).rejects.toMatchObject({ code: "UPSTREAM_RATE_LIMITED", message: expect.stringMatching(/2 requests are already waiting/) });
    s.stop();
    await Promise.allSettled(ok);
  });

  it("removes an aborted request from the queue without calling the broker", async () => {
    const { clock, s, call } = setup();
    call("z1", "quote");
    const ac = new AbortController();
    let ran = false;
    const p = s.schedule({ accountId: "z1", endpointClass: "quote", signal: ac.signal }, async () => (ran = true));
    expect(s.usage().accounts[0].classes.quote.queued).toBe(1);
    ac.abort(new Error("client went away"));
    await expect(p).rejects.toThrow("client went away");
    expect(s.usage().accounts[0].classes.quote.queued).toBe(0);
    await clock.advance(5000);
    expect(ran).toBe(false);
    await expect(s.schedule({ accountId: "z1", endpointClass: "quote", signal: ac.signal }, async () => 1)).rejects.toThrow("client went away");
  });

  it("keeps a shared call alive while any waiter remains, and withdraws it when all leave", async () => {
    const { clock, s, call } = setup();
    call("z1", "quote");
    const a = new AbortController();
    const b = new AbortController();
    let runs = 0;
    const fn = async () => ++runs;
    const pa = s.schedule({ accountId: "z1", endpointClass: "quote", coalesceKey: "x", signal: a.signal }, fn);
    const pb = s.schedule({ accountId: "z1", endpointClass: "quote", coalesceKey: "x" }, fn);
    a.abort();
    await expect(pa).rejects.toMatchObject({ name: "AbortError" });
    await clock.advance(1200);
    await expect(pb).resolves.toBe(1);

    const c = new AbortController();
    const d = new AbortController();
    const pc = s.schedule({ accountId: "z1", endpointClass: "quote", coalesceKey: "y", signal: c.signal }, fn);
    const pd = s.schedule({ accountId: "z1", endpointClass: "quote", coalesceKey: "y", signal: d.signal }, fn);
    call("z1", "quote"); // occupy nothing extra; y is queued behind the budget
    c.abort();
    d.abort();
    await Promise.allSettled([pc, pd]);
    await clock.advance(5000);
    expect(runs).toBe(1);
  });
});

describe("tryAcquire, headroom and pickAccount", () => {
  it("takes budget immediately when free, and never jumps the queue", async () => {
    const { clock, s, call } = setup();
    expect(s.headroom("z1", "quote")).toEqual({ remaining: 1, limit: 1, resetMs: 0 });
    expect(s.tryAcquire("z1", "quote")).toEqual({ ok: true, retryAfterMs: 0 });
    const r = s.tryAcquire("z1", "quote");
    expect(r.ok).toBe(false);
    expect(r.retryAfterMs).toBe(1100);
    expect(s.headroom("z1", "quote")).toMatchObject({ remaining: 0, limit: 1, resetMs: 1100 });
    const queued = call("z1", "quote");
    await clock.advance(1100);
    await queued;
    expect(s.tryAcquire("z1", "history").ok).toBe(true);
  });

  it("refuses tryAcquire while requests wait on the same budget, even when the windows have room", async () => {
    const { clock, s } = setup({ accounts: [{ id: "r1", broker: "roomy" }], policies: TEST_POLICIES, ratelimit: { maxInFlightPerAccount: 1 } });
    let release;
    const slow = s.schedule({ accountId: "r1", endpointClass: "quote" }, () => new Promise((r) => (release = r)));
    const waiting = s.schedule({ accountId: "r1", endpointClass: "quote" }, async () => "second");
    await clock.advance(1);
    expect(s.headroom("r1", "quote").remaining).toBeGreaterThan(900);
    expect(s.tryAcquire("r1", "quote")).toMatchObject({ ok: false });
    release("first");
    await clock.advance(1);
    await expect(Promise.all([slow, waiting])).resolves.toEqual(["first", "second"]);
    expect(s.tryAcquire("r1", "quote").ok).toBe(true);
  });

  it("picks the healthy candidate with the most headroom, then the one not backing off", async () => {
    const { s, accounts } = setup({ accounts: [{ id: "a", broker: "zerodha" }, { id: "b", broker: "zerodha" }, { id: "c", broker: "zerodha" }] });
    expect(s.pickAccount({ candidates: ["a", "b"], endpointClass: "quote" })).toBe("a");
    s.tryAcquire("a", "quote");
    expect(s.pickAccount({ candidates: ["a", "b"], endpointClass: "quote" })).toBe("b");
    s.noteUpstreamThrottle("b", "quote", 10_000);
    expect(s.pickAccount({ candidates: ["a", "b"], endpointClass: "quote" })).toBe("a");
    accounts.setState("c", "expired");
    expect(s.pickAccount({ candidates: ["c"], endpointClass: "quote" })).toBeNull();
    expect(s.pickAccount({ candidates: [], endpointClass: "quote" })).toBeNull();
    expect(s.pickAccount({ candidates: ["ghost", "a"], endpointClass: "quote" })).toBe("a");
  });

  it("brings an account back into routing when it reconnects", async () => {
    const { clock, s, accounts } = setup({ accounts: [{ id: "a", broker: "zerodha" }] });
    const p = expect(s.schedule({ accountId: "a", endpointClass: "quote" }, async () => Promise.reject(new SessionRequiredError()))).rejects.toBeInstanceOf(SessionRequiredError);
    await clock.advance(1);
    await p;
    expect(s.pickAccount({ candidates: ["a"], endpointClass: "quote" })).toBeNull();
    accounts.setState("a", "connected");
    await clock.advance(1);
    expect(s.pickAccount({ candidates: ["a"], endpointClass: "quote" })).toBe("a");
  });

  it("treats paper accounts as unlimited", async () => {
    const { clock, s } = setup({ accounts: [{ id: "paper", broker: "paper" }] });
    expect(s.headroom("paper", "quote")).toMatchObject({ remaining: Infinity, limit: Infinity });
    const ps = Array.from({ length: 100 }, () => s.schedule({ accountId: "paper", endpointClass: "quote" }, async () => 1));
    await clock.advance(1);
    await expect(Promise.all(ps)).resolves.toHaveLength(100);
    expect(s.usage().accounts).toEqual([]);
  });
});

describe("policies, usage and savings", () => {
  it("serves effective policies, lowered by config, and conservative defaults for unknown brokers", () => {
    const { s } = setup({ ratelimit: { brokers: { zerodha: { limits: { history: { perSecond: 1 } } } }, accounts: { z1: { limits: { order: { perSecond: 2 } } } } } });
    expect(s.policyFor("zerodha").limits.history).toMatchObject({ perSecond: 1, lowered: true });
    expect(s.policyFor("zerodha").limits.order.perSecond).toBe(10);
    expect(s.accountPolicy("z1").limits.order.perSecond).toBe(2);
    expect(s.policyFor("acme")).toMatchObject({ known: false, pooling: "unknown" });
    expect(() => s.policyFor("")).toThrow(TypeError);
  });

  it("reports used, limit, queued and reset per class plus today's savings", async () => {
    const { clock, s, call } = setup();
    call("z1", "quote");
    call("z1", "quote");
    recordSaving("stream", 3);
    recordSaving("cache");
    s.recordSaving("batched", 2);
    expect(s.recordSaving("nonsense")).toBe(false);
    await clock.advance(1);
    const u = s.usage();
    expect(u.accounts).toHaveLength(1);
    expect(u.accounts[0]).toMatchObject({ accountId: "z1", broker: "zerodha", healthy: true });
    expect(u.accounts[0].classes.quote).toMatchObject({ used: 1, limit: 1, queued: 1, window: "1s", callsToday: 1 });
    expect(u.savings).toMatchObject({ servedFromStream: 3, servedFromCache: 1, coalesced: 0, batched: 2 });
    expect(u.generatedAt).toMatch(/\+05:30$/);
    // Savings reset at IST midnight.
    const nextMidnight = Date.UTC(2026, 9, 20) - IST_OFFSET_MS;
    await clock.set(nextMidnight);
    expect(s.usage().savings.servedFromStream).toBe(0);
  });
});

describe("lifecycle", () => {
  it("refuses queued and new work after stop()", async () => {
    const { s, call } = setup();
    call("z1", "quote").catch(() => {});
    const waiting = call("z1", "quote");
    s.stop();
    await expect(waiting).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE" });
    await expect(call("z1", "quote")).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE" });
    s.stop(); // idempotent
  });

  it("works with real timers when the clock has none", async () => {
    const accountsSvc = createFakeAccountManager({ accounts: [{ id: "r1", broker: "roomy" }] });
    const s = createScheduler({ config: {}, logger: createLogger({ level: "silent" }), clock: { now: () => Date.now() }, accounts: accountsSvc }, { policies: TEST_POLICIES });
    await expect(s.schedule({ accountId: "r1", endpointClass: "quote" }, async () => "ok")).resolves.toBe("ok");
    s.stop();
  });
});
