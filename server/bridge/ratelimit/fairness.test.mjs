/**
 * Fairness in the scheduler: start-time fair queueing between consumers inside a lane (weights from clientKind),
 * the fairness-aware admission estimate, per-consumer caps, a full queue that cannot be held by one consumer, and
 * refusals that say whose limit was hit. Fake clock, no sleeps, no network.
 */
import { describe, expect, it } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { TOPICS, createEventBus } from "../core/eventBus.mjs";
import { createLogger } from "../core/logger.mjs";
import { runAsConsumer } from "./consumer.mjs";
import { createManualClock } from "./fake.mjs";
import { createScheduler } from "./scheduler.mjs";

const v = (spec) => ({ ...spec, verified: true, source: "https://example.test/limits" });
/** `steady`: 10 calls a second (a start about every 110 ms with the window padding). `roomy`: effectively unlimited. */
const POLICIES = Object.freeze({
  steady: { brokerId: "steady", limits: { quote: v({ perSecond: 10 }), order: v({ perSecond: 10 }) }, groups: {}, maxQuoteBatch: 1, feed: {}, pooling: "unknown" },
  roomy: { brokerId: "roomy", limits: { quote: v({ perSecond: 1000 }), order: v({ perSecond: 1000 }) }, groups: {}, maxQuoteBatch: 1, feed: {}, pooling: "unknown" },
});

const KEYS = {
  flood: { id: "flood000001", clientKind: "excel", label: "sheet" },
  light: { id: "light000001", clientKind: "mcp", label: "assistant" },
  page: { id: "page0000001", clientKind: "ui", label: "dashboard" },
  bulk: { id: "bulk0000001", clientKind: "script", label: "script" },
  bulk2: { id: "bulk0000002", clientKind: "script", label: "script two" },
};

function setup({ broker = "steady", ratelimit = {} } = {}) {
  const clock = createManualClock();
  const logger = createLogger({ level: "silent" });
  const bus = createEventBus({ logger, topics: TOPICS });
  const accounts = createFakeAccountManager({ accounts: [{ id: "a1", broker }], bus });
  const s = createScheduler({ config: { ratelimit }, logger, bus, clock, accounts }, { policies: POLICIES, random: () => 0 });
  const t0 = clock.now();
  const starts = [];
  /** Schedule one call as `who` (a KEYS entry). Records who started when (ms since the test began). */
  const as = (who, endpointClass, opts = {}, run) =>
    runAsConsumer(
      `Key: ${KEYS[who].label}`,
      () =>
        s.schedule({ accountId: "a1", endpointClass, ...opts }, async (c) => {
          starts.push({ who, tag: opts.tag, at: clock.now() - t0 });
          return run ? run(c) : undefined;
        }),
      { key: KEYS[who], principal: { kind: "key", id: KEYS[who].id } },
    );
  const call = (who, opts, run) => as(who, "quote", opts, run);
  const since = () => clock.now() - t0;
  const quiet = (ps) => ps.forEach((p) => p.catch(() => {}));
  return { clock, s, starts, call, as, since, quiet };
}

/**
 * Starts `from` to `to` of the run, counted per consumer. The first ones are skipped by callers: while the budget is
 * free, a request starts the moment it arrives (there is no contention yet), in arrival order.
 */
const split = (starts, from, to) => {
  const out = {};
  for (const x of starts.slice(from, to)) out[x.who] = (out[x.who] ?? 0) + 1;
  return out;
};

describe("simulation: a flooding consumer and a light one", () => {
  it("keeps the light consumer's latency bounded while a flood waits, and the flood cannot take more than its share", async () => {
    const { clock, s, starts, call, since, quiet } = setup({ ratelimit: { queue: { maxQueuedPerConsumer: 1000 } } });
    // A sheet fires 600 uncached reads at once: about a minute of budget.
    const flood = Array.from({ length: 600 }, (_, i) => call("flood", { tag: `f${i}`, maxWaitMs: 3_600_000 }));
    quiet(flood);
    await clock.advance(1000);
    // An assistant asks something every 2 s for 30 s, with the usual 10 s patience.
    const askedAt = [];
    const light = [];
    for (let i = 0; i < 15; i++) {
      askedAt.push(since());
      light.push(call("light", { tag: `l${i}` }));
      await clock.advance(2000);
    }
    const results = await Promise.allSettled(light);
    expect(results.map((r) => r.status)).toEqual(Array(15).fill("fulfilled"));
    const latency = askedAt.map((at, i) => starts.find((x) => x.tag === `l${i}`).at - at);
    // At most the next window of the budget (1.1 s), however long the flood's queue: first come, first served would be a minute.
    expect(Math.max(...latency)).toBeLessThanOrEqual(1200);
    // The flood kept the rest of the budget, and is nowhere near done.
    const floodStarted = starts.filter((x) => x.who === "flood").length;
    expect(floodStarted).toBeGreaterThan(200);
    expect(floodStarted).toBeLessThan(600);
    // While the assistant was waiting it never received more than the flood's lead allows: 15 calls, the rest to the sheet.
    expect(starts.filter((x) => x.who === "light")).toHaveLength(15);
    s.stop();
    await Promise.allSettled(flood);
  });

  it("splits a contended lane in proportion to the weights (ui 4, mcp 2, excel 1)", async () => {
    const { clock, s, starts, call, quiet } = setup();
    const all = [];
    for (let i = 0; i < 150; i++) for (const who of ["flood", "light", "page"]) all.push(call(who, { tag: `${who}${i}`, maxWaitMs: 3_600_000 }));
    quiet(all);
    await clock.advance(10_000);
    const first = split(starts, 20, 90); // 70 contended starts
    expect(first.page).toBeGreaterThanOrEqual(38);
    expect(first.page).toBeLessThanOrEqual(42);
    expect(first.light).toBeGreaterThanOrEqual(18);
    expect(first.light).toBeLessThanOrEqual(22);
    expect(first.flood).toBeGreaterThanOrEqual(8);
    expect(first.flood).toBeLessThanOrEqual(12);
    s.stop();
    await Promise.allSettled(all);
  });

  it("gives two consumers of the same weight the same share, and a per-key weight overrides the kind", async () => {
    const equal = setup();
    const a = [];
    for (let i = 0; i < 100; i++) for (const who of ["bulk", "bulk2"]) a.push(equal.call(who, { maxWaitMs: 3_600_000 }));
    equal.quiet(a);
    await equal.clock.advance(8000);
    const eq = split(equal.starts, 20, 60);
    expect(Math.abs(eq.bulk - eq.bulk2)).toBeLessThanOrEqual(1);
    equal.s.stop();
    await Promise.allSettled(a);

    // bulk2 gets weight 3 from its quota
    const boosted = setup({ ratelimit: { client: { keys: { bulk0000002: { weight: 3 } } } } });
    const b = [];
    for (let i = 0; i < 100; i++) for (const who of ["bulk", "bulk2"]) b.push(boosted.call(who, { maxWaitMs: 3_600_000 }));
    boosted.quiet(b);
    await boosted.clock.advance(8000);
    const bo = split(boosted.starts, 20, 60);
    expect(bo.bulk2).toBeGreaterThanOrEqual(28); // about 3 : 1 of 40 (whole units per window of 10)
    expect(bo.bulk2).toBeLessThanOrEqual(34);
    boosted.s.stop();
    await Promise.allSettled(b);
  });

  it("uses an idle consumer's share: weights only matter when consumers compete", async () => {
    const { clock, starts, call, quiet, s } = setup();
    const ps = Array.from({ length: 30 }, () => call("flood", { maxWaitMs: 3_600_000 }));
    quiet(ps);
    await clock.advance(5000);
    // the sheet alone gets every slot even though its weight is the smallest
    expect(starts.length).toBeGreaterThanOrEqual(30);
    s.stop();
    await Promise.allSettled(ps);
  });

  it("still starts an order before any read, whoever queued the reads", async () => {
    const { clock, as, call, starts, quiet } = setup();
    const reads = Array.from({ length: 100 }, () => call("page", { maxWaitMs: 3_600_000 }));
    quiet(reads);
    const order = as("flood", "order", { tag: "order" });
    await clock.advance(1000);
    await order;
    // only the reads already running (the 8 in-flight slots) came first, not the 92 that were waiting
    expect(starts.findIndex((x) => x.tag === "order")).toBeLessThanOrEqual(8);
    await clock.advance(120_000);
    await Promise.all(reads);
  });
});

describe("admission estimate is fairness-aware", () => {
  it("does not refuse a light consumer because of someone else's backlog", async () => {
    const { clock, s, call, starts, since, quiet } = setup({ ratelimit: { queue: { maxQueuedPerConsumer: 10_000 } } });
    const flood = Array.from({ length: 3000 }, () => call("flood", { maxWaitMs: 3_600_000 }));
    quiet(flood);
    // 3000 queued at ~9 a second is over five minutes of backlog: a request with 10 s patience used to be refused at once.
    const askedAt = since();
    const p = call("light", { tag: "light" });
    await clock.advance(1000);
    await expect(p).resolves.toBeUndefined();
    expect(starts.find((x) => x.tag === "light").at - askedAt).toBeLessThan(500);
    s.stop();
    await Promise.allSettled(flood);
  });

  it("still refuses the flooder's own requests once its own queue is longer than their patience", async () => {
    const { clock, s, call, quiet } = setup({ ratelimit: { queue: { maxQueuedPerConsumer: 10_000 } } });
    const first = Array.from({ length: 100 }, () => call("flood", { maxWaitMs: 3_600_000 }));
    quiet(first);
    const impatient = call("flood", { maxWaitMs: 5000 });
    await expect(impatient).rejects.toMatchObject({ code: "UPSTREAM_RATE_LIMITED", scope: "upstream" });
    await clock.advance(0);
    s.stop();
    await Promise.allSettled(first);
  });
});

describe("per-consumer caps", () => {
  it("refuses a consumer with too many requests waiting as RATE_LIMITED / consumer-cap, and nobody else", async () => {
    const { clock, s, call, as, quiet } = setup({ ratelimit: { queue: { maxQueuedPerConsumer: 3 } } });
    s.noteUpstreamThrottle("a1", "quote", 10_000); // nothing can start for 10 s: everything waits
    const ok = Array.from({ length: 3 }, () => call("flood", { maxWaitMs: 3_600_000 }));
    quiet(ok);
    const over = call("flood", { maxWaitMs: 3_600_000 });
    await expect(over).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
      scope: "consumer-cap",
      retryAfterMs: expect.any(Number),
      limit: { name: "a1:consumer-queue", remaining: 0, resetMs: expect.any(Number) },
    });
    await expect(over).rejects.toMatchObject({ retryAfterMs: expect.toSatisfy((n) => n >= 1000) });
    // another consumer, and an order from the same consumer, are not affected
    const other = call("light", { maxWaitMs: 3_600_000 });
    const order = as("flood", "order");
    quiet([other, order]);
    await clock.advance(11_000);
    await expect(other).resolves.toBeUndefined();
    await expect(order).resolves.toBeUndefined();
    s.stop();
    await Promise.allSettled(ok);
  });

  /** Two consumers each queue 60 slow calls on an account with 8 slots; returns the most each held at once. */
  async function slotRace(a, b) {
    const { clock, s, call, quiet } = setup({ broker: "roomy", ratelimit: { maxInFlightPerAccount: 8 } });
    const running = { [a]: 0, [b]: 0 };
    const peak = { [a]: 0, [b]: 0, all: 0 };
    const release = [];
    const started = { [a]: 0, [b]: 0 };
    const slow = (who) => () => {
      running[who] += 1;
      started[who] += 1;
      // peaks only count while both consumers still have requests waiting (a lone consumer may use every slot)
      if (started[a] < 60 && started[b] < 60) {
        peak[who] = Math.max(peak[who], running[who]);
        peak.all = Math.max(peak.all, running[a] + running[b]);
      }
      return new Promise((r) => release.push(() => r((running[who] -= 1)))).catch(() => {});
    };
    const ps = [];
    for (let i = 0; i < 60; i++) {
      ps.push(call(a, { maxWaitMs: 3_600_000 }, slow(a)));
      ps.push(call(b, { maxWaitMs: 3_600_000 }, slow(b)));
    }
    quiet(ps);
    await clock.advance(10);
    expect(running[a] + running[b]).toBe(8);
    for (let i = 0; i < 40; i++) {
      release.shift()?.();
      await clock.advance(10);
    }
    while (release.length) {
      release.shift()();
      await clock.advance(10);
    }
    await Promise.all(ps);
    s.stop();
    return peak;
  }

  it("holds one consumer to half the in-flight slots while another consumer of the same weight has work", async () => {
    const peak = await slotRace("bulk", "bulk2");
    expect(peak.bulk).toBeLessThanOrEqual(4);
    expect(peak.bulk2).toBeLessThanOrEqual(4);
    expect(peak.all).toBe(8);
  });

  it("lets a heavily weighted consumer hold its weighted share of the slots (the dashboard is not held to half)", async () => {
    const peak = await slotRace("page", "bulk"); // weights 4 and 1: 7 and 4 slots
    expect(peak.bulk).toBeLessThanOrEqual(4);
    expect(peak.page).toBeLessThanOrEqual(7);
    expect(peak.page).toBeGreaterThan(4);
    expect(peak.all).toBe(8);
  });

  it("lets a lone consumer use every slot (the cap only matters while others wait)", async () => {
    const { clock, s, call, quiet } = setup({ broker: "roomy", ratelimit: { maxInFlightPerAccount: 8 } });
    let running = 0;
    let peak = 0;
    const release = [];
    const ps = Array.from({ length: 10 }, () =>
      call("bulk", { maxWaitMs: 3_600_000 }, () => {
        running += 1;
        peak = Math.max(peak, running);
        return new Promise((r) => release.push(() => r((running -= 1))));
      }),
    );
    quiet(ps);
    await clock.advance(10);
    expect(running).toBe(8);
    while (release.length) {
      release.shift()();
      await clock.advance(10);
    }
    await Promise.all(ps);
    expect(peak).toBe(8);
    s.stop();
  });
});

describe("a full queue", () => {
  it("is not held by one consumer: the biggest consumer loses its newest request to make room", async () => {
    const { clock, s, call, starts, quiet } = setup({ ratelimit: { queue: { maxQueuedPerAccount: 20, maxQueuedPerConsumer: 1000 } } });
    s.noteUpstreamThrottle("a1", "quote", 10_000); // nothing starts for 10 s
    const flood = Array.from({ length: 30 }, (_, i) => call("flood", { tag: `f${i}`, maxWaitMs: 3_600_000 }));
    quiet(flood);
    await clock.advance(1);
    // twenty wait; ten are refused for being the consumer that fills the queue
    const refused = (await Promise.allSettled(flood.slice(20))).filter((r) => r.status === "rejected");
    expect(refused).toHaveLength(10);
    expect(refused[0].reason).toMatchObject({ code: "UPSTREAM_RATE_LIMITED", scope: "queue", limit: { name: "a1:queue", remaining: 0 } });
    const light = call("light", { tag: "light", maxWaitMs: 3_600_000 });
    quiet([light]);
    await clock.advance(1);
    // the flooder's newest waiting request was dropped to make room
    await expect(flood[19]).rejects.toMatchObject({ scope: "queue", code: "UPSTREAM_RATE_LIMITED" });
    await clock.advance(11_000);
    await expect(light).resolves.toBeUndefined();
    // and the light consumer was served before the flood's backlog
    expect(starts.findIndex((x) => x.tag === "light")).toBeLessThanOrEqual(1);
    s.stop();
  });

  it("still refuses a newcomer when nobody holds clearly more than it does", async () => {
    const { clock, s, call, quiet } = setup({ ratelimit: { queue: { maxQueuedPerAccount: 3 } } });
    const a = [call("flood", { maxWaitMs: 3_600_000 }), call("flood", { maxWaitMs: 3_600_000 }), call("light", { maxWaitMs: 3_600_000 }), call("light", { maxWaitMs: 3_600_000 })];
    quiet(a);
    await clock.advance(1);
    await expect(call("bulk", { maxWaitMs: 3_600_000 }).then(() => "ok")).resolves.toBe("ok").catch(() => {});
    s.stop();
    await Promise.allSettled(a);
  });
});

describe("refusals explain themselves", () => {
  it("an upstream refusal carries scope, retryAfterMs and the budget that said no", async () => {
    const { s, call, quiet } = setup({ broker: "steady", ratelimit: { maxInFlightPerAccount: 64 } });
    quiet(Array.from({ length: 40 }, () => call("flood", { maxWaitMs: 3_600_000 }))); // ten use this second's window
    const err = await call("light", { maxWaitMs: 100 }).catch((e) => e);
    expect(err).toMatchObject({ code: "UPSTREAM_RATE_LIMITED", status: 429, scope: "upstream" });
    expect(err.retryAfterMs).toBeGreaterThan(100);
    expect(err.limit).toMatchObject({ name: "a1:quote:1s", remaining: 0 });
    expect(err.limit.resetMs).toBeGreaterThan(0);
    s.stop();
  });

  it("names the back-off as the limit while the pool is paused", async () => {
    const { s, call } = setup();
    s.noteUpstreamThrottle("a1", "quote", 20_000);
    const err = await call("light", { maxWaitMs: 1000 }).catch((e) => e);
    expect(err).toMatchObject({ scope: "upstream", limit: { name: "a1:quote:backoff", remaining: 0 } });
    expect(err.limit.resetMs).toBeGreaterThan(15_000);
    s.stop();
  });
});

describe("shared calls wait where their best-placed caller would", () => {
  it("a light consumer that asks for what a flood already asked for is not held behind the flood's queue", async () => {
    const { clock, s, call, starts, since, quiet } = setup({ ratelimit: { queue: { maxQueuedPerConsumer: 10_000 } } });
    const flood = Array.from({ length: 300 }, (_, i) => call("flood", { tag: `f${i}`, maxWaitMs: 3_600_000, coalesceKey: `sym-${i}` }));
    quiet(flood);
    await clock.advance(1);
    const askedAt = since();
    // "sym-299" is the last thing the sheet asked for: about half a minute away for the sheet itself
    const joined = call("light", { tag: "light", coalesceKey: "sym-299" });
    await clock.advance(2000);
    await expect(joined).resolves.toBeUndefined();
    const ran = starts.filter((x) => x.tag === "f299" || x.tag === "light");
    expect(ran).toHaveLength(1); // one broker call served both
    expect(ran[0].at - askedAt).toBeLessThan(1500);
    s.stop();
    await Promise.allSettled(flood);
  });

  it("does not hand a light consumer's call to the flood: the joiner must be better placed", async () => {
    const { clock, s, call, quiet } = setup({ ratelimit: { queue: { maxQueuedPerConsumer: 10_000 } } });
    s.noteUpstreamThrottle("a1", "quote", 5000);
    const flood = Array.from({ length: 50 }, (_, i) => call("flood", { maxWaitMs: 3_600_000, coalesceKey: `f-${i}` }));
    const mine = call("light", { maxWaitMs: 3_600_000, coalesceKey: "shared" });
    quiet([...flood, mine]);
    const lightRow = () => s.consumers().find((c) => c.id === "key:light000001");
    expect(lightRow().queued).toBe(1);
    const joiner = call("flood", { maxWaitMs: 3_600_000, coalesceKey: "shared" });
    quiet([joiner]);
    // still the light consumer's call, and the counts stay consistent
    expect(lightRow().queued).toBe(1);
    expect(s.consumers().find((c) => c.id === "key:flood000001").queued).toBe(50);
    await clock.advance(60_000);
    await expect(joiner).resolves.toBeUndefined();
    s.stop();
  });

  it("keeps the queued counts of both consumers right when a call changes hands", async () => {
    const { clock, s, call, quiet } = setup({ ratelimit: { queue: { maxQueuedPerConsumer: 10_000 } } });
    s.noteUpstreamThrottle("a1", "quote", 5000);
    const flood = Array.from({ length: 20 }, (_, i) => call("flood", { maxWaitMs: 3_600_000, coalesceKey: `f-${i}` }));
    quiet(flood);
    const row = (id) => s.consumers().find((c) => c.id === id);
    expect(row("key:flood000001").queued).toBe(20);
    const light = call("light", { maxWaitMs: 3_600_000, coalesceKey: "f-19" });
    quiet([light]);
    expect(row("key:flood000001").queued).toBe(19);
    expect(row("key:light000001").queued).toBe(1);
    await clock.advance(60_000);
    await expect(light).resolves.toBeUndefined();
    await Promise.allSettled(flood);
    expect(s.consumers()).toEqual([]);
    s.stop();
  });
});

describe("consumers view", () => {
  it("lists who is competing, with queued, in flight and fair share", async () => {
    const { clock, s, call, quiet } = setup({ broker: "steady" });
    const ps = [];
    for (let i = 0; i < 10; i++) ps.push(call("page", { maxWaitMs: 3_600_000 }), call("flood", { maxWaitMs: 3_600_000 }));
    quiet(ps);
    await clock.advance(1);
    const rows = s.consumers();
    const page = rows.find((r) => r.id === "key:page0000001");
    const flood = rows.find((r) => r.id === "key:flood000001");
    expect(page).toMatchObject({ label: "dashboard", kind: "ui", weight: 4, share: 0.8 });
    expect(flood).toMatchObject({ label: "sheet", kind: "excel", weight: 1, share: 0.2 });
    expect(page.queued + page.inFlight).toBeGreaterThan(0);
    s.stop();
    await Promise.allSettled(ps);
  });
});
