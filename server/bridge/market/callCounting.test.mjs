/**
 * Market data acceptance: with a fake adapter that counts calls and the REAL ratelimit scheduler on a manual
 * clock, 20 clients polling the same 50 symbols every second cause at most the broker's quote limit of calls, and a
 * live stream tick is served with source "stream" and zero REST calls. Also checks that no one-second window ever
 * carries more calls than the policy allows, including for a broker that takes one instrument per call.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createManualClock } from "../ratelimit/fake.mjs";
import { createScheduler } from "../ratelimit/scheduler.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { FIFTY, T0, instrumentSpecs, stubAdapter, stubStreamHub } from "./__fixtures__/helpers.mjs";
import { createMarketDataService } from "./marketDataService.mjs";

const CLIENTS = 20;
const SECONDS = 10;
let stops = [];

afterEach(() => {
  for (const s of stops) s();
  stops = [];
});

/** Real scheduler + fake accounts + fake symbols + counting adapter, all on one manual clock. */
function setup({ broker = "zerodha", streamHub = stubStreamHub(), market = {} } = {}) {
  const clock = createManualClock(T0);
  const bus = createEventBus({ logger: createNullLogger() });
  const callTimes = [];
  const base = stubAdapter(broker);
  const adapter = {
    ...base,
    async fetchQuotes(creds, refs) {
      callTimes.push(clock.now());
      return base.fetchQuotes(creds, refs);
    },
  };
  const specs = instrumentSpecs().map((s) => ({ ...s, refs: { [broker]: s.refs.zerodha } }));
  const accounts = createFakeAccountManager({ accounts: [{ id: `${broker}-main`, broker, adapter, creds: { apiKey: "k", accessToken: "t" } }], bus });
  const scheduler = createScheduler({ config: {}, logger: createNullLogger(), bus, clock, accounts });
  stops.push(() => scheduler.stop?.());
  const md = createMarketDataService({
    config: { market },
    logger: createNullLogger(),
    bus,
    clock,
    paths: {},
    brokers: {},
    accounts,
    scheduler,
    symbols: createFakeSymbolService({ instruments: specs }),
    streamHub,
  });
  return { md, clock, scheduler, callTimes, accountId: `${broker}-main` };
}

/** Largest number of calls inside any window of `windowMs`. */
function maxInWindow(times, windowMs) {
  let best = 0;
  for (let i = 0; i < times.length; i += 1) {
    let n = 0;
    for (let j = i; j < times.length && times[j] - times[i] < windowMs; j += 1) n += 1;
    best = Math.max(best, n);
  }
  return best;
}

/**
 * Every second, CLIENTS clients ask for the same symbols (half at the top of the second, half 100 ms later).
 * Returns every settled result.
 */
async function poll(md, clock, kind, list) {
  const results = [];
  for (let s = 0; s < SECONDS; s += 1) {
    const batch = [];
    for (let c = 0; c < CLIENTS / 2; c += 1) batch.push(md[kind](list).then((r) => results.push(r), (e) => results.push({ thrown: e })));
    await clock.advance(100);
    for (let c = 0; c < CLIENTS / 2; c += 1) batch.push(md[kind](list).then((r) => results.push(r), (e) => results.push({ thrown: e })));
    await clock.advance(900);
  }
  await clock.advance(15_000); // let anything still queued finish or time out
  return results;
}

describe("20 clients polling 50 symbols every second", () => {
  it("stay within the broker's quote limit (Zerodha policy, batched)", async () => {
    const { md, clock, scheduler, callTimes } = setup({ broker: "zerodha" });
    const policy = scheduler.policyFor("zerodha");
    const perSecond = policy.limits.quote?.perSecond ?? 1;
    const results = await poll(md, clock, "ltp", FIFTY);

    expect(results).toHaveLength(CLIENTS * SECONDS);
    expect(results.every((r) => !r.thrown)).toBe(true);
    // every client got every symbol, with an honest freshness label
    for (const r of results) {
      expect(r.errors).toEqual([]);
      expect(r.items).toHaveLength(50);
      for (const i of r.items) expect(["broker", "cache"]).toContain(i.freshness.source);
    }
    // 200 client requests x 50 symbols = 10,000 symbol reads; the broker saw only a handful of calls
    const batches = Math.ceil(50 / policy.maxQuoteBatch);
    expect(callTimes.length).toBeLessThanOrEqual(perSecond * SECONDS);
    expect(callTimes.length).toBeLessThanOrEqual(batches * SECONDS);
    expect(maxInWindow(callTimes, 1000)).toBeLessThanOrEqual(perSecond);
    expect(md.stats().cache).toBeGreaterThan(0);
  });

  it("stay within the limit for quotes too", async () => {
    const { md, clock, scheduler, callTimes } = setup({ broker: "zerodha" });
    const perSecond = scheduler.policyFor("zerodha").limits.quote?.perSecond ?? 1;
    const results = await poll(md, clock, "quotes", FIFTY);
    expect(results.every((r) => !r.thrown && r.errors.length === 0 && r.items.length === 50)).toBe(true);
    expect(callTimes.length).toBeLessThanOrEqual(perSecond * SECONDS);
    expect(maxInWindow(callTimes, 1000)).toBeLessThanOrEqual(perSecond);
  });

  it("never exceed the limit for a broker that takes one instrument per call (stale-labelled instead)", async () => {
    const { md, clock, scheduler, callTimes } = setup({ broker: "motilal" });
    const policy = scheduler.policyFor("motilal");
    expect(policy.maxQuoteBatch).toBe(1);
    const perSecond = policy.limits.quote?.perSecond ?? 1;
    const results = await poll(md, clock, "ltp", FIFTY);
    expect(maxInWindow(callTimes, 1000)).toBeLessThanOrEqual(perSecond);
    expect(callTimes.length).toBeLessThanOrEqual(perSecond * (SECONDS + 15) + 1);
    // Symbols that could not be fetched in time are reported per item, never silently dropped.
    for (const r of results) {
      expect(r.thrown).toBeUndefined();
      expect(r.items.length + r.errors.length).toBe(50);
      for (const e of r.errors) expect(e.code).toBe("UPSTREAM_RATE_LIMITED");
    }
    const sources = new Set(results.flatMap((r) => r.items.map((i) => `${i.freshness.source}:${i.freshness.stale}`)));
    expect(sources.has("cache:true")).toBe(true); // stale-labelled values served under budget pressure
  });
});

describe("streaming first", () => {
  it("live ticks are served with source stream and cost zero REST calls", async () => {
    // A liquid feed: every symbol ticks continuously, so each tick is always just received.
    let tickClock = null;
    const ticks = Object.fromEntries(FIFTY.map((s, i) => [s, { symbol: s, ltp: 500 + i, bid: null, ask: null, bidQty: null, askQty: null, volume: null, oi: null, open: null, high: null, low: null, close: null, exchangeTs: null, get receivedAt() { return tickClock ? tickClock.now() : T0; }, accountId: "zerodha-main", broker: "zerodha" }]));
    const hub = stubStreamHub({ live: FIFTY, ticks });
    const { md, clock, scheduler, callTimes, accountId } = setup({ broker: "zerodha", streamHub: hub });
    tickClock = clock;
    const results = await poll(md, clock, "ltp", FIFTY);
    expect(callTimes).toEqual([]);
    expect(scheduler.usage().accounts.find((a) => a.accountId === accountId)?.classes?.quote?.used ?? 0).toBe(0);
    for (const r of results) {
      expect(r.items).toHaveLength(50);
      for (const i of r.items) expect(i.freshness).toMatchObject({ source: "stream", stale: false, accountId: "zerodha-main" });
    }
    expect(md.stats().stream).toBe(CLIENTS * SECONDS * 50);
  });
});
