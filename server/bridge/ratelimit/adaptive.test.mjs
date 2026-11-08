/**
 * Adaptive upstream budgets: a 429 backs off the whole shared pool of its account (with jitter), the pool's scale
 * follows AIMD below the policy ceiling (x0.5 per episode, floor 0.25, +0.05 per clean minute, frozen after three
 * episodes in an hour), and the current factor is reported per pool. Fake clock, no sleeps, no network.
 */
import { describe, expect, it } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { TOPICS, createEventBus } from "../core/eventBus.mjs";
import { createLogger } from "../core/logger.mjs";
import { createManualClock } from "./fake.mjs";
import { createScheduler } from "./scheduler.mjs";

const v = (spec) => ({ ...spec, verified: true, source: "https://example.test/limits" });
const POLICIES = Object.freeze({
  /** quote + order share a 1 a second group budget */
  shared: { brokerId: "shared", limits: { order: v({ perSecond: 1 }), quote: v({ perSecond: 1 }), history: v({ perSecond: 1 }) }, groups: { all: { classes: ["order", "quote"], ...v({ perSecond: 1 }) } }, maxQuoteBatch: 1, feed: {}, pooling: "unknown" },
  /** three separate classes, no group */
  split: { brokerId: "split", limits: { quote: v({ perSecond: 10 }), history: v({ perSecond: 10 }), depth: v({ perSecond: 10 }) }, groups: {}, maxQuoteBatch: 1, feed: {}, pooling: "unknown" },
  /** a window per minute too, so a scale below 1 changes whole units */
  wide: { brokerId: "wide", limits: { quote: v({ perSecond: 10, perMinute: 100 }) }, groups: {}, maxQuoteBatch: 1, feed: {}, pooling: "unknown" },
});

function setup({ accounts = [{ id: "s1", broker: "shared" }], random = () => 0 } = {}) {
  const clock = createManualClock();
  const logger = createLogger({ level: "silent" });
  const warnings = [];
  const noisy = { ...logger, child: () => noisy, warn: (msg, data) => warnings.push({ msg, ...data }) };
  const bus = createEventBus({ logger, topics: TOPICS });
  const acc = createFakeAccountManager({ accounts, bus });
  const s = createScheduler({ config: { ratelimit: {} }, logger: noisy, bus, clock, accounts: acc }, { policies: POLICIES, random });
  const pool = (accountId, name) => s.pools().find((p) => p.accountId === accountId && p.group === `${accountId}/${name}`);
  return { clock, s, warnings, pool };
}

describe("a 429 backs off the whole shared pool", () => {
  it("pauses every class that shares a group bucket with the throttled one", () => {
    const { s } = setup();
    s.noteUpstreamThrottle("s1", "quote", 4000);
    expect(s.tryAcquire("s1", "quote")).toMatchObject({ ok: false, retryAfterMs: 4000 });
    expect(s.tryAcquire("s1", "order")).toMatchObject({ ok: false, retryAfterMs: 4000 });
    // history is its own budget on this broker: it keeps going
    expect(s.tryAcquire("s1", "history")).toEqual({ ok: true, retryAfterMs: 0 });
    expect(s.headroomWindows("s1", "order").backoffMs).toBe(4000);
  });

  it("leaves classes without a shared budget alone (back-off is per pool)", () => {
    const { s } = setup({ accounts: [{ id: "p1", broker: "split" }] });
    s.noteUpstreamThrottle("p1", "quote", 3000);
    expect(s.tryAcquire("p1", "quote").ok).toBe(false);
    expect(s.tryAcquire("p1", "history")).toEqual({ ok: true, retryAfterMs: 0 });
    expect(s.tryAcquire("p1", "depth")).toEqual({ ok: true, retryAfterMs: 0 });
  });

  it("holds queued work of the sibling class until the pause ends", async () => {
    const { clock, s } = setup();
    const starts = [];
    const t0 = clock.now();
    s.noteUpstreamThrottle("s1", "quote", 3000);
    const p = s.schedule({ accountId: "s1", endpointClass: "order" }, async () => starts.push(clock.now() - t0));
    await clock.advance(2999);
    expect(starts).toEqual([]);
    await clock.advance(1);
    await p;
    expect(starts[0]).toBe(3000);
  });

  it("does not touch other accounts", () => {
    const { s } = setup({ accounts: [{ id: "s1", broker: "shared" }, { id: "s2", broker: "shared" }] });
    s.noteUpstreamThrottle("s1", "quote", 4000);
    expect(s.tryAcquire("s2", "quote")).toEqual({ ok: true, retryAfterMs: 0 });
  });
});

describe("back-off jitter", () => {
  it("adds 0 to 250 ms and never goes before Retry-After", () => {
    for (const [r, extra] of [[0, 0], [0.5, 125], [0.999, 249]]) {
      const { s } = setup({ random: () => r });
      s.noteUpstreamThrottle("s1", "quote", 2000);
      expect(s.tryAcquire("s1", "quote").retryAfterMs).toBe(2000 + extra);
    }
    const { s } = setup({ random: Math.random });
    for (let i = 0; i < 50; i++) {
      const a = setup({ random: Math.random });
      a.s.noteUpstreamThrottle("s1", "quote", 3000);
      const wait = a.s.tryAcquire("s1", "quote").retryAfterMs;
      expect(wait).toBeGreaterThanOrEqual(3000);
      expect(wait).toBeLessThan(3250);
    }
    void s;
  });

  it("jitters the exponential default too", () => {
    const { s } = setup({ random: () => 0.8 });
    s.noteUpstreamThrottle("s1", "quote");
    expect(s.tryAcquire("s1", "quote").retryAfterMs).toBe(1000 + 200);
  });

  it("keeps the exponential streak, and does not reset it for a call that ends during the pause", async () => {
    const { clock, s } = setup({ accounts: [{ id: "p1", broker: "split" }] });
    let finish;
    const slow = s.schedule({ accountId: "p1", endpointClass: "quote" }, () => new Promise((r) => (finish = r)));
    await clock.advance(1);
    s.noteUpstreamThrottle("p1", "quote");
    finish("ok");
    await slow;
    s.noteUpstreamThrottle("p1", "quote");
    expect(s.tryAcquire("p1", "quote").retryAfterMs).toBe(2000);
    // a call that succeeds after the pause resets the streak
    await clock.advance(2000);
    await s.schedule({ accountId: "p1", endpointClass: "quote" }, async () => 1);
    s.noteUpstreamThrottle("p1", "quote");
    expect(s.tryAcquire("p1", "quote").retryAfterMs).toBe(1000);
  });
});

describe("AIMD below the policy ceiling", () => {
  /** Run one successful call so the pool saw traffic in this minute. */
  const traffic = (s) => s.schedule({ accountId: "w1", endpointClass: "quote" }, async () => 1);
  const wide = () => setup({ accounts: [{ id: "w1", broker: "wide" }] });

  it("starts at 1 and halves once per throttle episode, never below 0.25", async () => {
    const { clock, s, pool } = wide();
    expect(pool("w1", "quote")).toMatchObject({ backoffFactor: 1, ceiling: 1, frozen: false });
    // Ten calls fail together: one episode.
    for (let i = 0; i < 10; i++) s.noteUpstreamThrottle("w1", "quote", 2000);
    expect(pool("w1", "quote").backoffFactor).toBe(0.5);
    await clock.advance(2000);
    s.noteUpstreamThrottle("w1", "quote", 2000);
    expect(pool("w1", "quote").backoffFactor).toBe(0.25);
    await clock.advance(2000);
    s.noteUpstreamThrottle("w1", "quote", 2000);
    expect(pool("w1", "quote").backoffFactor).toBe(0.25);
  });

  it("lowers the sub-day windows to the scale and never raises them above the policy", async () => {
    const { clock, s, pool } = wide();
    expect(s.headroom("w1", "quote").limit).toBe(10);
    s.noteUpstreamThrottle("w1", "quote", 1000);
    await clock.advance(1000);
    expect(pool("w1", "quote")).toMatchObject({ backoffFactor: 0.5, limit: 5 });
    const win = s.headroomWindows("w1", "quote").windows;
    expect(win.map((w) => [w.window, w.limit])).toEqual([["1s", 5], ["1m", 50]]);
    for (let i = 0; i < 40; i++) {
      await clock.advance(60_000);
      await traffic(s);
      await clock.advance(60_000);
      expect(s.headroom("w1", "quote").limit).toBeLessThanOrEqual(10);
    }
    expect(pool("w1", "quote").backoffFactor).toBe(1);
    expect(s.headroom("w1", "quote").limit).toBe(10);
  });

  it("recovers 0.05 per clean minute that had traffic, and not for idle minutes", async () => {
    const { clock, s, pool } = wide();
    s.noteUpstreamThrottle("w1", "quote", 1000);
    await clock.advance(1000);
    expect(pool("w1", "quote").backoffFactor).toBe(0.5);
    // idle for ten minutes: nothing to learn from
    await clock.advance(600_000);
    expect(pool("w1", "quote").backoffFactor).toBe(0.5);
    await traffic(s);
    await clock.advance(60_000);
    expect(pool("w1", "quote").backoffFactor).toBe(0.55);
    await traffic(s);
    await clock.advance(60_000);
    expect(pool("w1", "quote").backoffFactor).toBe(0.6);
    // a new throttle restarts the clean-minute count
    s.noteUpstreamThrottle("w1", "quote", 1000);
    expect(pool("w1", "quote").backoffFactor).toBe(0.3);
  });

  it("freezes the ceiling at 0.8 x the value before the drop after three episodes within an hour, for 24 hours, and warns", async () => {
    const { clock, s, pool, warnings } = wide();
    const episode = async () => {
      s.noteUpstreamThrottle("w1", "quote", 1000);
      await clock.advance(1000);
    };
    const climb = async (minutes) => {
      for (let i = 0; i < minutes; i++) {
        await traffic(s);
        await clock.advance(60_000);
      }
    };
    await episode(); // 1 -> 0.5
    await climb(6); // 0.5 -> 0.8
    expect(pool("w1", "quote").backoffFactor).toBe(0.8);
    await episode(); // 0.8 -> 0.4
    await climb(4); // 0.4 -> 0.6
    expect(pool("w1", "quote").backoffFactor).toBe(0.6);
    const tooHigh = () => warnings.filter((w) => /looks too high/.test(w.msg));
    expect(tooHigh()).toEqual([]);
    await episode(); // 0.6 -> 0.3 and the third episode within the hour: ceiling 0.8 x 0.6
    expect(pool("w1", "quote")).toMatchObject({ backoffFactor: 0.3, ceiling: 0.48, frozen: true, episodesLastHour: 3 });
    expect(tooHigh()).toHaveLength(1);
    expect(tooHigh()[0]).toMatchObject({ accountId: "w1", pool: "quote", ceiling: 0.48 });
    await climb(20);
    expect(pool("w1", "quote").backoffFactor).toBe(0.48);
    // after 24 hours the freeze lifts and recovery continues towards the policy figure
    await clock.advance(24 * 3_600_000);
    await climb(3);
    expect(pool("w1", "quote")).toMatchObject({ ceiling: 1, frozen: false });
    expect(pool("w1", "quote").backoffFactor).toBeGreaterThan(0.48);
  });

  it("slows a 1 a second budget by stretching its window (the floor of one unit would change nothing)", async () => {
    const { clock, s } = setup();
    const starts = [];
    s.noteUpstreamThrottle("s1", "history", 1000); // history is 1/s on its own: scale 0.5 -> one call per 2 s
    await clock.advance(1000);
    const t0 = clock.now();
    const ps = Array.from({ length: 4 }, () => s.schedule({ accountId: "s1", endpointClass: "history", maxWaitMs: 3_600_000 }, async () => starts.push(clock.now() - t0)));
    await clock.advance(20_000);
    await Promise.all(ps);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(2000);
  });
});

describe("explain: pools", () => {
  it("lists one pool per budget group with the factor, ceiling and spare share", async () => {
    const { clock, s } = setup({ accounts: [{ id: "s1", broker: "shared" }, { id: "w1", broker: "wide" }] });
    s.noteUpstreamThrottle("s1", "order", 1000);
    await clock.advance(1);
    const pools = s.pools();
    const all = pools.find((p) => p.group === "s1/all");
    expect(all).toMatchObject({ accountId: "s1", broker: "shared", accounts: ["s1"], backoffFactor: 0.5, ceiling: 1, frozen: false });
    expect([...all.classes].sort()).toEqual(["order", "quote"]);
    expect(all.backoffMs).toBeGreaterThan(0);
    expect(all.spare).toBeGreaterThanOrEqual(0);
    expect(pools.find((p) => p.group === "s1/history")).toMatchObject({ backoffFactor: 1, backoffMs: 0, spare: 1 });
    expect(pools.find((p) => p.group === "w1/quote")).toMatchObject({ backoffFactor: 1, limit: 10 });
    expect(s.pools({ accountIds: ["w1"] }).every((p) => p.accountId === "w1")).toBe(true);
  });
});
