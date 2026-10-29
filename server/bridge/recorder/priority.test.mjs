/**
 * The 200 ms criterion (docs/spec/p1-01-recorder.md §5.1 rules 3–5, §9, §12): with the REAL scheduler on a manual
 * clock and a broker policy of chain 4/s and 120/min, the recorder's REST source saturates its budget for 10
 * simulated minutes while 200 user option-chain requests at interactive priority arrive at random instants. Every
 * user request starts within 200 ms of being asked, and the recorder never takes more than half of any window. With a
 * 1/s policy the planner puts zero chains on REST.
 */
import { describe, expect, it } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { TOPICS, createEventBus } from "../core/eventBus.mjs";
import { createLogger } from "../core/logger.mjs";
import { createManualClock } from "../ratelimit/fake.mjs";
import { resolvePolicy } from "../ratelimit/policy.mjs";
import { createScheduler } from "../ratelimit/scheduler.mjs";
import { createRecorderBudget } from "./budget.mjs";
import { parseRecorderConfig } from "./config.mjs";
import { feedCapFor, fullAvailability, planRecording } from "./plan.mjs";
import { createRestSource } from "./restSource.mjs";

const v = (spec) => ({ ...spec, verified: true, source: "https://example.test/limits" });
const POLICIES = Object.freeze({
  tbroker: { brokerId: "tbroker", limits: { chain: v({ perSecond: 4, perMinute: 120 }) }, groups: {}, maxQuoteBatch: 1, feed: {}, pooling: "unknown" },
  slow: { brokerId: "slow", limits: { chain: v({ perSecond: 1, perMinute: 60 }) }, groups: {}, maxQuoteBatch: 1, feed: {}, pooling: "unknown" },
});

/** Deterministic PRNG. */
const rng = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

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

describe("user chain requests are never delayed by more than 200 ms by the recorder", () => {
  it("200 interactive requests over 10 minutes of a saturated recorder", async () => {
    const clock = createManualClock(Date.parse("2026-10-19T10:00:00+05:30"));
    const logger = createLogger({ level: "silent" });
    const bus = createEventBus({ logger, topics: TOPICS });
    const accounts = createFakeAccountManager({ accounts: [{ id: "t-1", broker: "tbroker" }], bus });
    const scheduler = createScheduler({ config: { ratelimit: {} }, logger, bus, clock, accounts }, { policies: POLICIES });
    const recorderStarts = [];
    const userDelays = [];
    const allStarts = [];
    // The marketData seam: a broker chain call scheduled exactly as marketDataService.brokerChain does.
    const marketData = {
      optionChain: (_p, o) =>
        scheduler.schedule({ accountId: o.accountId, endpointClass: "chain", priority: o.priority, maxWaitMs: o.maxWaitMs, backgroundShare: o.backgroundShare }, async () => {
          recorderStarts.push(clock.now());
          allStarts.push(clock.now());
          return { rows: [], underlyingLtp: 25000, freshness: { asOf: new Date(clock.now()).toISOString(), source: "broker", accountId: "t-1", broker: "tbroker" } };
        }),
    };
    const rest = createRestSource({ marketData, scheduler });
    const budget = createRecorderBudget({ policy: scheduler.policyFor("tbroker"), endpointClass: "chain", share: 0.5, clock });
    const rand = rng(7);
    const t0 = clock.now();
    const end = t0 + 10 * 60_000;
    let nextRecorder = t0;
    let nextUser = t0 + 500;
    const promises = [];
    let users = 0;
    let gaps = 0;
    while (clock.now() < end) {
      const t = clock.now();
      if (t >= nextRecorder) {
        // The recorder tries far more often than its budget allows: it is saturated.
        promises.push(rest.read({ accountId: "t-1", underlying: "NIFTY", expiry: "2026-10-27", strikes: 40, endpointClass: "chain", share: 0.5, budget }).then((r) => (r.ok ? null : (gaps += 1))));
        nextRecorder = t + 100;
      }
      if (t >= nextUser && users < 200) {
        users += 1;
        const askedAt = t;
        promises.push(
          scheduler.schedule({ accountId: "t-1", endpointClass: "chain", priority: "interactive" }, async () => {
            userDelays.push(clock.now() - askedAt);
            allStarts.push(clock.now());
            return "ok";
          }),
        );
        nextUser = t + 500 + Math.floor(rand() * 4500);
      }
      await clock.advance(25);
    }
    for (let i = 0; i < 400; i++) await clock.advance(25);
    await Promise.allSettled(promises);
    expect(users).toBe(200);
    expect(userDelays).toHaveLength(200);
    expect(Math.max(...userDelays)).toBeLessThanOrEqual(200);
    // Saturated: the shared gate keeps every window at or above half free, so the recorder gets what the users leave
    // of that half (about 40 of 60 a minute here), and never more than half of any window.
    expect(recorderStarts.length).toBeGreaterThan(350);
    expect(maxInWindow(recorderStarts, 1000)).toBeLessThanOrEqual(2);
    expect(maxInWindow(recorderStarts, 60_000)).toBeLessThanOrEqual(60);
    expect(maxInWindow(allStarts, 1000)).toBeLessThanOrEqual(4);
    expect(gaps).toBeGreaterThan(0); // refused attempts become budget gaps, never queued behind users
    scheduler.stop();
  }, 60_000);

  it("with a 1 request/s chain class the planner puts zero chains on REST", () => {
    const cfg = parseRecorderConfig({});
    const policy = resolvePolicy("slow", {}, POLICIES);
    const plan = planRecording({ cfg, account: { id: "s-1", broker: "slow" }, policy, feedCap: feedCapFor(policy, false), available: fullAvailability(cfg) });
    expect(plan.chains.filter((c) => c.source === "rest")).toHaveLength(0);
    expect(plan.capacity.rest.allowed).toBe(false);
  });
});
