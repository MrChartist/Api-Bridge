/**
 * Live events on real brokers (events/feed.mjs): the universe rides the shared stream hub, and REST is only for what
 * the stream cannot answer. These tests count real broker quote calls through the REAL scheduler (Arrow policy: market
 * data 10 a second, so the background gate lets a 25 % share through; on a 1-a-second quote API it never does) and
 * the real market data service on a manual clock, for a 50-stock universe over a few minutes:
 *  - every stock ticking: no quote call at all;
 *  - quiet stocks (no trade) on a feed that is ticking: still none (no tick on a live subscription = no trade);
 *  - stocks the hub refused, or a feed that went silent: one batched background call per poll round, no more;
 *  - the same on Dhan's policy (market quote 1 a second, where the share never fits): the guaranteed share, one
 *    batched call at most every `restEverySeconds` while nobody uses the broker, never two in one second, none while
 *    a person is reading quotes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createManualClock } from "../ratelimit/fake.mjs";
import { createScheduler } from "../ratelimit/scheduler.mjs";
import { createFakeStreamHub } from "../stream/fake.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { FIFTY, T0, instrumentSpecs, stubAdapter } from "../market/__fixtures__/helpers.mjs";
import { createMarketDataService } from "../market/marketDataService.mjs";
import { parseEventsConfig } from "./config.mjs";
import { createEventsEngine } from "./engine.mjs";
import { IDLE_MS, createLiveFeed } from "./feed.mjs";
import { listJobs } from "../ratelimit/jobs.mjs";
import { createEventStore } from "./store.mjs";

let stops = [];
afterEach(() => {
  for (const s of stops) s();
  stops = [];
});

const QUIET = FIFTY.slice(40); // ten stocks that stop trading after their first tick

function setup({ unknown = [], events = {}, broker = "arrow" } = {}) {
  const clock = createManualClock(T0);
  const bus = createEventBus({ logger: createNullLogger() });
  const base = stubAdapter(broker);
  const calls = { quotes: 0, symbols: 0, at: [] };
  const adapter = {
    ...base,
    async fetchQuotes(creds, refs) {
      calls.quotes += 1;
      calls.symbols += refs.length;
      calls.at.push(clock.now());
      return base.fetchQuotes(creds, refs);
    },
  };
  const specs = instrumentSpecs().map((s) => ({ ...s, refs: { [broker]: s.refs.dhan } }));
  const account = `${broker}-main`;
  const accounts = createFakeAccountManager({ accounts: [{ id: account, broker, adapter, creds: { apiKey: "k", accessToken: "t" } }], bus });
  const scheduler = createScheduler({ config: {}, logger: createNullLogger(), bus, clock, accounts });
  stops.push(() => scheduler.stop?.());
  const hub = createFakeStreamHub({ bus, clock, unknown, accountId: account, broker });
  const symbols = createFakeSymbolService({ instruments: specs });
  const marketData = createMarketDataService({ config: { market: {} }, logger: createNullLogger(), bus, clock, paths: {}, brokers: {}, accounts, scheduler, symbols, streamHub: hub });
  const cfg = parseEventsConfig({ futures: false, ...events });
  const store = createEventStore({ dir: null, clock });
  const engine = createEventsEngine({ clock, bus, store, selection: { universes: ["TEST"] } });
  // History (previous-day context) is its own class and not counted here; the stub answers it with no candles.
  const deps = { config: { scanner: { universes: { TEST: FIFTY } } }, clock, bus, marketData, streamHub: hub, accounts, scheduler, symbols };
  const feed = createLiveFeed({ engine, deps, cfg, store, logger: createNullLogger() });
  stops.push(() => feed.stop());
  return { clock, hub, feed, calls, scheduler, account };
}

/** Run `seconds` of market: every symbol in `ticking()` ticks each second; a poll round every 15 s (pollSeconds).
 *  `each(s)` runs first in every second (a person reading quotes, say). */
async function market(t, seconds, ticking, each = null) {
  for (let s = 1; s <= seconds; s += 1) {
    if (each) await each(s);
    for (const sym of ticking(s)) t.hub.pushTick({ symbol: sym, ltp: 100 + s / 10, bid: 100, ask: 100.1, volume: 1000 + s });
    if (s % 15 === 0) {
      const p = t.feed.poll();
      for (let i = 0; i < 20; i += 1) await t.clock.advance(50);
      await p;
    }
    await t.clock.advance(1000);
  }
}

describe("live events: the universe streams; REST only for what the stream cannot answer", () => {
  it("makes no quote call while every stock ticks", async () => {
    const t = setup();
    await t.feed.refresh();
    await market(t, 180, () => FIFTY);
    expect(t.calls.quotes).toBe(0);
    expect(t.feed.status().stream.held).toBe(50);
  });

  it("makes no quote call for quiet stocks on a feed that is ticking (no tick = no trade)", async () => {
    const t = setup();
    await t.feed.refresh();
    // Each quiet stock ticks once (the subscription snapshot), then never again; the rest tick every second.
    await market(t, 180, (s) => (s === 1 ? FIFTY : FIFTY.filter((x) => !QUIET.includes(x))));
    expect(t.calls.quotes).toBe(0);
    expect(t.feed.restWanted()).toEqual({ want: [], quiet: QUIET.length });
    expect(t.feed.status().rest.quiet).toBe(QUIET.length);
  });

  it("before this change the same minutes polled the quiet stocks by REST (quietMaxMs 0 keeps that behaviour)", async () => {
    const t = setup({ events: { quietMaxMs: 0 } });
    await t.feed.refresh();
    await market(t, 180, (s) => (s === 1 ? FIFTY : FIFTY.filter((x) => !QUIET.includes(x))));
    // Twelve poll rounds; from the second (no tick for 20 s) the ten quiet stocks are read in one batched call, each
    // answer serving the next round from the cache (maxAgeMs = staleAfterMs): about one call every 30 s.
    expect(t.calls.quotes).toBeGreaterThanOrEqual(5);
    expect(t.calls.quotes).toBeLessThanOrEqual(12);
  });

  it("reads quiet stocks again once they pass quietMaxMs", async () => {
    const t = setup({ events: { quietMaxMs: 60_000 } });
    await t.feed.refresh();
    await market(t, 180, (s) => (s === 1 ? FIFTY : FIFTY.filter((x) => !QUIET.includes(x))));
    // Quiet up to 60 s; after that one batched read per round (the REST answer does not count as a tick).
    expect(t.calls.quotes).toBeGreaterThan(0);
    expect(t.calls.quotes).toBeLessThanOrEqual(9);
  });

  it("polls only the stocks the hub refused, one batched call per round", async () => {
    const refused = FIFTY.slice(0, 5);
    const t = setup({ unknown: refused });
    await t.feed.refresh();
    expect(t.feed.status().stream.rejected).toBe(5);
    await market(t, 180, () => FIFTY.filter((x) => !refused.includes(x)));
    // 12 rounds; the refused five never tick, so they (and only they) are read in one call about every 30 s.
    expect(t.calls.quotes).toBeLessThanOrEqual(12);
    expect(t.calls.symbols).toBeLessThanOrEqual(12 * refused.length);
    expect(t.calls.quotes).toBeGreaterThanOrEqual(5);
  });

  describe("on a 1-call-a-second quote API (Dhan policy: market quote 1/s)", () => {
    const refused = FIFTY.slice(0, 5);
    const run = async (events, person = null) => {
      const t = setup({ broker: "dhan", unknown: refused, events });
      await t.feed.refresh();
      await market(t, 180, () => FIFTY.filter((x) => !refused.includes(x)), person ? (s) => person(t, s) : null);
      return t;
    };

    it("without the guaranteed share the fallback never runs (the share never fits a 1-call window)", async () => {
      const t = await run({ restEverySeconds: 0 });
      expect(t.calls.quotes).toBe(0);
      expect(t.feed.status().rest.refused).toBeGreaterThan(0);
    });

    it("the guaranteed share reads the refused stocks in one batched call per period, never two in a second", async () => {
      const t = await run({ restEverySeconds: 10 });
      // 12 poll rounds of 15 s; each may make one guaranteed call (the period is 10 s), each answer is cached for
      // staleAfterMs, so the refused five are read about every 30 s, as on a broker where the share fits.
      expect(t.calls.quotes).toBeGreaterThanOrEqual(5);
      expect(t.calls.quotes).toBeLessThanOrEqual(12);
      expect(t.calls.symbols).toBeLessThanOrEqual(t.calls.quotes * refused.length);
      for (let i = 1; i < t.calls.at.length; i += 1) expect(t.calls.at[i] - t.calls.at[i - 1]).toBeGreaterThanOrEqual(10_000);
      // Every one of them went through the guaranteed share (a read the cache answered makes no call).
      expect(t.feed.status().rest.floorCalls).toBeGreaterThanOrEqual(t.calls.quotes);
      // The budget panel shows it as a job.
      expect(listJobs().find((j) => j.id === "events-rest")).toMatchObject({ label: "Live events by REST", total: refused.length });
    });

    it("takes no guaranteed call while a person is using the broker", async () => {
      // An interactive quote read every 5 s (inside IDLE_MS): the fallback waits, users first.
      expect(IDLE_MS).toBeGreaterThan(5000);
      const t = await run({ restEverySeconds: 10 }, async (x, s) => {
        if (s % 5 === 0) await x.scheduler.schedule({ accountId: x.account, endpointClass: "quote", priority: "interactive" }, async () => null);
      });
      expect(t.calls.quotes).toBe(0);
      expect(listJobs().find((j) => j.id === "events-rest")).toMatchObject({ paused: true, done: 0 });
    });
  });

  it("falls back to REST for the whole universe when the feed goes silent", async () => {
    const t = setup();
    await t.feed.refresh();
    await market(t, 30, () => FIFTY);
    expect(t.calls.quotes).toBe(0);
    t.hub.setConnected(false);
    await market(t, 60, () => []);
    expect(t.calls.quotes).toBeGreaterThan(0);
    expect(t.calls.symbols).toBeGreaterThanOrEqual(50);
  });
});
