/**
 * Live events on real brokers (events/feed.mjs): the universe rides the shared stream hub, and REST is only for what
 * the stream cannot answer. These tests count real broker quote calls through the REAL scheduler (Arrow policy: market
 * data 10 a second, so the background gate lets a 25 % share through; on a 1-a-second quote API it never does) and
 * the real market data service on a manual clock, for a 50-stock universe over a few minutes:
 *  - every stock ticking: no quote call at all;
 *  - quiet stocks (no trade) on a feed that is ticking: still none (no tick on a live subscription = no trade);
 *  - stocks the hub refused, or a feed that went silent: one batched background call per poll round, no more.
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
import { createLiveFeed } from "./feed.mjs";
import { createEventStore } from "./store.mjs";

let stops = [];
afterEach(() => {
  for (const s of stops) s();
  stops = [];
});

const QUIET = FIFTY.slice(40); // ten stocks that stop trading after their first tick

function setup({ unknown = [], events = {} } = {}) {
  const clock = createManualClock(T0);
  const bus = createEventBus({ logger: createNullLogger() });
  const base = stubAdapter("arrow");
  const calls = { quotes: 0, symbols: 0 };
  const adapter = {
    ...base,
    async fetchQuotes(creds, refs) {
      calls.quotes += 1;
      calls.symbols += refs.length;
      return base.fetchQuotes(creds, refs);
    },
  };
  const specs = instrumentSpecs().map((s) => ({ ...s, refs: { arrow: s.refs.dhan } }));
  const accounts = createFakeAccountManager({ accounts: [{ id: "arrow-main", broker: "arrow", adapter, creds: { apiKey: "k", accessToken: "t" } }], bus });
  const scheduler = createScheduler({ config: {}, logger: createNullLogger(), bus, clock, accounts });
  stops.push(() => scheduler.stop?.());
  const hub = createFakeStreamHub({ bus, clock, unknown, accountId: "arrow-main", broker: "arrow" });
  const symbols = createFakeSymbolService({ instruments: specs });
  const marketData = createMarketDataService({ config: { market: {} }, logger: createNullLogger(), bus, clock, paths: {}, brokers: {}, accounts, scheduler, symbols, streamHub: hub });
  const cfg = parseEventsConfig({ futures: false, ...events });
  const store = createEventStore({ dir: null, clock });
  const engine = createEventsEngine({ clock, bus, store, selection: { universes: ["TEST"] } });
  // History (previous-day context) is its own class and not counted here; the stub answers it with no candles.
  const deps = { config: { scanner: { universes: { TEST: FIFTY } } }, clock, bus, marketData, streamHub: hub, accounts, scheduler, symbols };
  const feed = createLiveFeed({ engine, deps, cfg, store, logger: createNullLogger() });
  stops.push(() => feed.stop());
  return { clock, hub, feed, calls };
}

/** Run `seconds` of market: every symbol in `ticking()` ticks each second; a poll round every 15 s (pollSeconds). */
async function market(t, seconds, ticking) {
  for (let s = 1; s <= seconds; s += 1) {
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
