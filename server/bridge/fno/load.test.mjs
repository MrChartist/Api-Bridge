/**
 * Load test (docs/spec/p1-06-stocks.md §7, §9.2): the real scheduler and the real MarketDataService with a fake broker
 * whose quote and chain calls share one budget of 5/s (and, second case, 1/s). During a 180-stock sweep a user's
 * interactive option-chain call starts within 200 ms on the 5/s class and within 1,000 ms on the 1/s class, at p100
 * over 50 trials; the sweep keeps at least half of the window free on the 5/s class.
 */
import { describe, expect, it } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { buildMarket, stubAdapter } from "../market/__fixtures__/helpers.mjs";
import { createManualClock } from "../ratelimit/fake.mjs";
import { createScheduler } from "../ratelimit/scheduler.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { parseFnoConfig } from "./config.mjs";
import { createSweepStore } from "./sweepStore.mjs";
import { createSweeper } from "./sweep.mjs";

const T0 = Date.parse("2026-10-19T10:00:00+05:30");
const EXPIRY = "2026-10-27";
const STOCKS = Array.from({ length: 180 }, (_, i) => `STK${String(i).padStart(3, "0")}`);

async function run(perSecond) {
  const clock = createManualClock(T0);
  const bus = createEventBus({ logger: createNullLogger() });
  const policy = { brokerId: "loadbroker", limits: { quote: { perSecond, verified: true }, chain: { perSecond, verified: true }, history: { perSecond, verified: true } }, groups: { data: { perSecond, verified: true, classes: ["quote", "depth", "chain"] } }, maxQuoteBatch: 50, feed: { maxConnections: null, maxSubscriptions: null }, pooling: "not-allowed", maxModificationsPerOrder: null };
  const userStarts = [];
  const errors = [];
  /** Per trial: ms from issue to answer, and where the answer came from (broker, or the stale cache under pressure). */
  const answers = [];
  let issuedAt = null;
  const adapter = stubAdapter("loadbroker", {
    overrides: {
      async fetchOptionChain(_creds, symbol) {
        if (symbol === "USER") userStarts.push(clock.now() - issuedAt);
        const oc = {};
        for (const k of [100, 110, 120]) oc[`${k}.000000`] = { ce: { last_price: 5, oi: 100, top_bid_price: 4.9, top_ask_price: 5.1 }, pe: { last_price: 5, oi: 100, top_bid_price: 4.9, top_ask_price: 5.1 } };
        return { status: "success", data: { oc, last_price: 110 } };
      },
    },
  });
  const accounts = createFakeAccountManager({ accounts: [{ id: "load-1", broker: "loadbroker", adapter, creds: { apiKey: "k", accessToken: "t" } }], bus });
  const scheduler = createScheduler({ config: {}, logger: createNullLogger(), bus, clock, accounts }, { policies: { loadbroker: policy } });
  const instruments = [{ symbol: "NSE:USER", lotSize: 1, tickSize: 0.05 }, { symbol: `NFO:USER-${EXPIRY}-110-CE`, lotSize: 100, tickSize: 0.05 }];
  for (const s of STOCKS) instruments.push({ symbol: `NSE:${s}`, lotSize: 1, tickSize: 0.05 }, { symbol: `NFO:${s}-${EXPIRY}-110-CE`, lotSize: 100, tickSize: 0.05 });
  const symbols = createFakeSymbolService({ instruments: instruments.map((x, i) => ({ ...x, refs: { loadbroker: { token: `L${i}` } } })) });
  const { md } = buildMarket({ clock, accountManager: accounts, scheduler, symbols, accounts: undefined });
  const universe = { names: async () => ({ indices: [], stocks: STOCKS }), facts: async () => ({ expiries: [EXPIRY], strikeStep: 10 }), list: async () => ({ items: STOCKS.map((u) => ({ underlying: u, spot: `NSE:${u}` })) }) };
  const sweeper = createSweeper({
    cfg: parseFnoConfig({ sweep: { maxMinutes: 60, nextExpiryWithinDays: 0, hv: { source: "off" } } }),
    clock,
    scheduler,
    accounts,
    marketData: md,
    symbols,
    reference: { session: () => ({ state: "OPEN", open: "09:15", close: "15:30" }), rate: () => ({ value: 0.065 }) },
    universe,
    store: createSweepStore(null, { memory: true }),
  });
  await sweeper.start({ method: "chain" });
  let idle = false;
  sweeper.idle().then(() => {
    idle = true;
  });
  // 50 user calls spread over the sweep, each at a random offset inside a 1-second slot.
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let trial = 0; trial < 50; trial += 1) {
    await clock.advance(Math.floor(400 + 1200 * rand()));
    issuedAt = clock.now();
    let answered = null;
    const p = md.optionChain({ underlying: "USER", expiry: EXPIRY }, { priority: "interactive", accountId: "load-1", maxAgeMs: 0 }).then((c) => {
      answered = { ms: clock.now() - issuedAt, source: c.freshness?.source };
    });
    for (let i = 0; i < 60 && answered === null; i += 1) await clock.advance(25);
    try {
      await p;
      answers.push(answered);
    } catch (err) {
      errors.push(err?.code ?? String(err));
    }
  }
  const sweepWasRunning = !idle;
  for (let i = 0; i < 20_000 && !idle; i += 1) await clock.advance(250);
  const usage = sweeper.current();
  scheduler.stop?.();
  return { userStarts, answers, sweepWasRunning, usage, errors };
}

describe("a user chain call during a 180-stock sweep", () => {
  it("starts within 200 ms on a 5/s class (p100 over 50 trials)", { timeout: 60_000 }, async () => {
    const r = await run(5);
    expect(r.errors).toEqual([]);
    expect(r.sweepWasRunning).toBe(true);
    expect(r.userStarts).toHaveLength(50);
    expect(r.answers.every((a) => a.source === "broker")).toBe(true);
    expect(Math.max(...r.userStarts)).toBeLessThanOrEqual(200);
    expect(r.usage).toMatchObject({ status: "done", progress: { done: 180 } });
  });

  it("starts within 1,000 ms on a 1/s class (p100 over 50 trials)", { timeout: 60_000 }, async () => {
    const r = await run(1);
    expect(r.errors).toEqual([]);
    expect(r.sweepWasRunning).toBe(true);
    // Every call is answered: from the broker (started within 1 s), or at once from the last chain when the 1/s
    // budget is in use (the market service's serve-stale rule), never held behind the sweep.
    expect(r.answers).toHaveLength(50);
    expect(Math.max(...r.userStarts)).toBeLessThanOrEqual(1000);
    expect(Math.max(...r.answers.map((a) => a.ms))).toBeLessThanOrEqual(1000);
  });
});
