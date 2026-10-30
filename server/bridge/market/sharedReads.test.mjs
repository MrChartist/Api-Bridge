/**
 * One broker read serves every consumer (docs/perf/README.md): pages, the events engine, the recorder and API tools
 * watching the same underlying share one cache, one in-flight call and one stream subscription. These tests count
 * real broker calls through the REAL scheduler (Dhan policy: one option chain every second, 20 a minute) on a
 * manual clock, for the scenarios a trader actually has open.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { runAsConsumer } from "../ratelimit/consumer.mjs";
import { createManualClock } from "../ratelimit/fake.mjs";
import { createScheduler } from "../ratelimit/scheduler.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { T0, instrumentSpecs, stubAdapter, stubStreamHub } from "./__fixtures__/helpers.mjs";
import { createMarketDataService } from "./marketDataService.mjs";

const EXPIRY = "2026-10-27";
const LEGS = [24800, 24900, 25000, 25100, 25200].flatMap((k) => ["CE", "PE"].map((r) => `NFO:NIFTY-${EXPIRY}-${k}-${r}`));
let stops = [];
afterEach(() => {
  for (const s of stops) s();
  stops = [];
});

function setup({ streamHub = stubStreamHub() } = {}) {
  const clock = createManualClock(T0);
  const bus = createEventBus({ logger: createNullLogger() });
  const base = stubAdapter("dhan");
  const calls = { chain: 0, quotes: 0 };
  const adapter = {
    ...base,
    async fetchOptionChain(...a) {
      calls.chain += 1;
      return base.fetchOptionChain(...a);
    },
    async fetchQuotes(...a) {
      calls.quotes += 1;
      return base.fetchQuotes(...a);
    },
  };
  const specs = instrumentSpecs().map((s) => ({ ...s, refs: { dhan: s.refs.dhan } }));
  const accounts = createFakeAccountManager({ accounts: [{ id: "dhan-main", broker: "dhan", adapter, creds: { clientId: "1", accessToken: "t" } }], bus });
  const scheduler = createScheduler({ config: {}, logger: createNullLogger(), bus, clock, accounts });
  stops.push(() => scheduler.stop?.());
  const md = createMarketDataService({ config: { market: {} }, logger: createNullLogger(), bus, clock, paths: {}, brokers: {}, accounts, scheduler, symbols: createFakeSymbolService({ instruments: specs }), streamHub });
  return { md, clock, scheduler, calls };
}

const chainRead = (md, opts = {}) => md.optionChain({ underlying: "NIFTY", expiry: EXPIRY, strikes: 2, ivModel: "legacy-bs-spot" }, opts);

/** Run `consumers` (each { everyMs, phaseMs, read }) for `seconds`; returns every result. */
async function run(clock, consumers, seconds) {
  const out = [];
  for (let t = 0; t < seconds * 1000; t += 100) {
    for (const c of consumers) {
      if (t >= c.phaseMs && (t - c.phaseMs) % c.everyMs === 0) out.push(c.read().then((r) => r, (e) => ({ thrown: e })));
    }
    await clock.advance(100);
  }
  await clock.advance(5000);
  return Promise.all(out);
}

describe("three pages and the events engine watching NIFTY", () => {
  it("cost one broker chain call per freshness window, not one per page (3N)", async () => {
    const { md, clock, calls } = setup();
    const pages = ["Option Chain", "OI Analysis", "Strategy"].map((name, i) => ({ everyMs: 3000, phaseMs: i * 1000, read: () => runAsConsumer(`Dashboard · ${name}`, () => chainRead(md)) }));
    const events = { everyMs: 5000, phaseMs: 500, read: () => runAsConsumer("Live events", () => md.quotes(["NSE:NIFTY", ...LEGS], { priority: "background" })) };
    const results = await run(clock, [...pages, events], 30);
    expect(results.every((r) => !r.thrown)).toBe(true);
    // 3 pages x 10 polls = 30 chain reads. Sharing the 3 s cache makes it one call per window: at most 11.
    const reads = 30;
    expect(calls.chain).toBeLessThanOrEqual(11);
    expect(calls.chain).toBeLessThan(reads / 2);
    // The events engine's 6 polls of 11 symbols are one batched quote call each at most.
    expect(calls.quotes).toBeLessThanOrEqual(6);
  });

  it("cost one call in total once the legs stream (stream-first chain)", async () => {
    let clockRef = null;
    const tick = (symbol, ltp, oi) => ({ symbol, ltp, bid: ltp - 0.5, ask: ltp + 0.5, oi, volume: 10, close: ltp - 2, open: null, high: null, low: null, exchangeTs: null, get receivedAt() { return clockRef.now(); }, accountId: "dhan-main", broker: "dhan" });
    const ticks = Object.fromEntries([["NSE:NIFTY", tick("NSE:NIFTY", 25012.5, null)], ...LEGS.map((s, i) => [s, tick(s, 50 + i, 1200 + i)])]);
    const hub = stubStreamHub({ ticks, live: Object.keys(ticks) });
    const { md, clock, calls } = setup({ streamHub: hub });
    clockRef = clock;
    const pages = [0, 1000, 2000].map((phaseMs) => ({ everyMs: 3000, phaseMs, read: () => chainRead(md) }));
    const results = await run(clock, pages, 30);
    expect(results.every((r) => !r.thrown)).toBe(true);
    // The first read fetches the day's base chain (previous OI); every later read is built from ticks.
    expect(calls.chain).toBe(1);
    const last = results.at(-1);
    expect(last.freshness.source).toBe("stream");
    const atm = last.rows.find((r) => r.strike === 25000);
    expect(atm.ce.ltp).toBe(ticks[`NFO:NIFTY-${EXPIRY}-25000-CE`].ltp);
    // OI change = tick OI minus the previous-day OI the broker chain implied (1000 OI, 900 previous).
    expect(atm.ce.oiChange).toBe(ticks[`NFO:NIFTY-${EXPIRY}-25000-CE`].oi - 900);
  });

  it("fall back to the broker when one leg of the window has no fresh tick", async () => {
    let clockRef = null;
    const tick = (symbol, ltp) => ({ symbol, ltp, bid: null, ask: null, oi: 1000, volume: 1, close: null, open: null, high: null, low: null, exchangeTs: null, get receivedAt() { return clockRef.now(); }, accountId: "dhan-main", broker: "dhan" });
    const live = ["NSE:NIFTY", ...LEGS.slice(1)];
    const hub = stubStreamHub({ ticks: Object.fromEntries(live.map((s) => [s, tick(s, s === "NSE:NIFTY" ? 25012.5 : 60)])), live });
    const { md, clock, calls } = setup({ streamHub: hub });
    clockRef = clock;
    await (async () => {
      const p = chainRead(md);
      await clock.advance(50);
      await p;
    })();
    await clock.advance(4000);
    const p = chainRead(md);
    await clock.advance(50);
    const r = await p;
    expect(r.freshness.source).toBe("broker");
    expect(calls.chain).toBe(2);
  });
});

describe("in-flight and stale-while-revalidate", () => {
  it("ten identical reads at once make one call", async () => {
    const { md, clock, calls } = setup();
    const all = Promise.all(Array.from({ length: 10 }, () => chainRead(md)));
    await clock.advance(100);
    const out = await all;
    expect(out).toHaveLength(10);
    expect(calls.chain).toBe(1);
  });

  it("answers at once from an older value, labelled, and refreshes it once", async () => {
    const { md, clock, calls } = setup();
    const first = chainRead(md);
    await clock.advance(50);
    await first;
    await clock.advance(10_000); // older than the 3 s target, inside the 60 s stale limit
    const swr = await Promise.race([chainRead(md, { staleWhileRevalidate: true }), new Promise((r) => setTimeout(() => r("waited"), 50))]);
    expect(swr).not.toBe("waited");
    expect(swr.freshness).toMatchObject({ source: "cache", stale: true, revalidating: true });
    const again = await chainRead(md, { staleWhileRevalidate: true });
    expect(again.freshness.revalidating).toBe(true);
    await clock.advance(200);
    expect(calls.chain).toBe(2); // the first read and one refresh, however many swr readers asked
    const fresh = chainRead(md);
    await clock.advance(10);
    expect((await fresh).freshness).toMatchObject({ source: "cache", stale: false });
    expect(calls.chain).toBe(2);
  });
});

describe("who used the budget", () => {
  it("credits calls to the consumer that made them and joins to the ones that shared", async () => {
    const { md, clock, scheduler, calls } = setup();
    const a = runAsConsumer("Dashboard · Option Chain", () => chainRead(md));
    const b = runAsConsumer("Key: Excel sheet", () => chainRead(md));
    await clock.advance(100);
    await Promise.all([a, b]);
    expect(calls.chain).toBe(1);
    const u = scheduler.usage({ series: true });
    const byName = Object.fromEntries(u.consumers.map((c) => [c.name, c]));
    expect(byName["Dashboard · Option Chain"].calls).toBe(1);
    expect(byName["Key: Excel sheet"].calls).toBe(0);
    expect(byName["Key: Excel sheet"].saved).toBeGreaterThanOrEqual(1);
    const acct = u.accounts.find((x) => x.accountId === "dhan-main");
    expect(acct.series.classes.chain.reduce((n, x) => n + x, 0)).toBe(1);
    expect(acct.series.classes.chain).toHaveLength(acct.series.seconds);
    const w = acct.classes.chain.windows;
    expect(w.some((x) => x.window === "1s" && x.used === 1)).toBe(true);
  });
});
