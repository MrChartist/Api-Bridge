/**
 * MarketDataService (S5) against the published fakes: read path (stream -> cache -> batched broker call), pinned and
 * pooled routing, stale labelling under budget pressure, per-item errors, depth, history chunking, expiries and
 * option chains. No network; the manual clock drives every timer.
 */
import { describe, expect, it } from "vitest";
import { SERVICE_CONTRACTS, assertService } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createFakeScheduler } from "../ratelimit/fake.mjs";
import { FIFTY, T0, buildMarket, priceForToken, stubAdapter, stubStreamHub } from "./__fixtures__/helpers.mjs";

const quoteCalls = (adapter) => adapter.calls.filter((c) => c[0] === "fetchQuotes");

describe("contract", () => {
  it("exposes exactly the contract methods (plus diagnostics)", () => {
    const { md } = buildMarket();
    expect(() => assertService("marketData", md)).not.toThrow();
    for (const m of SERVICE_CONTRACTS.marketData.methods) expect(typeof md[m]).toBe("function");
  });
});

describe("ltp and quotes read path", () => {
  it("batches concurrent requests into one broker call and labels freshness", async () => {
    const { md, zerodha, settle, scheduler } = buildMarket();
    const a = md.ltp(["NSE:RELIANCE", "NSE:INFY"]);
    const b = md.ltp(["nse:infy", "NSE:NIFTY"]);
    await settle();
    const [ra, rb] = await Promise.all([a, b]);
    expect(quoteCalls(zerodha)).toHaveLength(1);
    expect(quoteCalls(zerodha)[0][1].sort()).toEqual(["Z1", "Z3", "Z4"].sort());
    expect(scheduler.calls).toHaveLength(1);
    expect(scheduler.calls[0]).toMatchObject({ accountId: "zerodha-main", endpointClass: "quote", priority: "interactive" });
    expect(ra.errors).toEqual([]);
    expect(ra.items.map((i) => i.symbol)).toEqual(["NSE:RELIANCE", "NSE:INFY"]);
    expect(ra.items[0]).toEqual({
      symbol: "NSE:RELIANCE",
      ltp: priceForToken("Z3"),
      freshness: { source: "broker", asOf: expect.stringMatching(/\+05:30$/), ageMs: 0, stale: false, accountId: "zerodha-main", broker: "zerodha" },
    });
    expect(rb.items.map((i) => i.symbol)).toEqual(["NSE:INFY", "NSE:NIFTY"]);
    expect(md.stats().coalesced).toBeGreaterThanOrEqual(1);
  });

  it("serves from the freshness cache within maxAgeMs and refetches after it", async () => {
    const { md, zerodha, settle, clock } = buildMarket();
    await settle(md.quotes(["NSE:RELIANCE"]));
    await clock.advance(500);
    const cached = await md.quotes(["NSE:RELIANCE"]);
    expect(quoteCalls(zerodha)).toHaveLength(1);
    expect(cached.items[0].freshness).toMatchObject({ source: "cache", stale: false });
    expect(cached.items[0].freshness.ageMs).toBeGreaterThanOrEqual(500);
    // maxAgeMs 0 forces a live read
    const live = await settle(md.quotes(["NSE:RELIANCE"], { maxAgeMs: 0 }));
    expect(quoteCalls(zerodha)).toHaveLength(2);
    expect(live.items[0].freshness.source).toBe("broker");
    // older than the quote default (2 s) -> refetch
    await clock.advance(2500);
    await settle(md.quotes(["NSE:RELIANCE"]));
    expect(quoteCalls(zerodha)).toHaveLength(3);
  });

  it("normalises quotes into the OpenAPI shape with change and changePct", async () => {
    const { md, settle } = buildMarket();
    const r = await settle(md.quotes(["NSE:RELIANCE"]));
    const p = priceForToken("Z3");
    expect(r.items[0]).toMatchObject({ symbol: "NSE:RELIANCE", ltp: p, open: p - 1, high: p + 2, low: p - 3, close: p - 5, change: 5, volume: 1000, oi: null, bid: p - 0.05, ask: p + 0.05, bidQty: null, askQty: null });
    expect(r.items[0].changePct).toBeCloseTo((5 / (p - 5)) * 100, 3);
  });

  it("puts bad symbols in errors[] without failing the batch", async () => {
    const { md, settle } = buildMarket();
    const r = await settle(md.ltp(["NSE:RELIANCE", "NOT A SYMBOL", "NSE:UNKNOWNCO", "NSE:RELIANCE"]));
    expect(r.items.map((i) => i.symbol)).toEqual(["NSE:RELIANCE"]);
    const codes = Object.fromEntries(r.errors.map((e) => [e.symbol, e.code]));
    expect(codes["NOT A SYMBOL"]).toBe("VALIDATION_FAILED");
    expect(codes["NSE:UNKNOWNCO"]).toBe("SYMBOL_NOT_FOUND");
  });

  it("maps adapter errors per chunk and keeps other symbols", async () => {
    const z = stubAdapter("zerodha", {
      overrides: {
        async fetchQuotes(creds, refs) {
          const err = new Error("Kite said no");
          err.code = "UPSTREAM_ERROR";
          if (refs.some((r) => r.token === "Z4")) throw err;
          return { status: "success", data: refs.map((r) => ({ token: r.token, exchange: r.exchange, ltp: 10, open: null, high: null, low: null, close: null, volume: null, oi: null, bid: null, ask: null })) };
        },
      },
    });
    // maxQuoteBatch 1 so each symbol is its own chunk
    const { md, settle, scheduler } = buildMarket({ adapters: { zerodha: z } });
    const realPolicy = scheduler.policyFor;
    scheduler.policyFor = (id) => ({ ...realPolicy(id), maxQuoteBatch: 1 });
    const r = await settle(md.ltp(["NSE:RELIANCE", "NSE:INFY"]));
    expect(z.calls).toEqual([]); // overridden fetchQuotes records nothing; two chunks ran
    expect(scheduler.calls).toHaveLength(2);
    expect(r.items.map((i) => i.symbol)).toEqual(["NSE:RELIANCE"]);
    expect(r.errors).toEqual([{ symbol: "NSE:INFY", code: "UPSTREAM_ERROR", message: "Kite said no" }]);
  });

  it("reports a missing price as UPSTREAM_ERROR for that symbol", async () => {
    const z = stubAdapter("zerodha", { overrides: { fetchQuotes: async () => ({ status: "success", data: [] }) } });
    const { md, settle } = buildMarket({ adapters: { zerodha: z } });
    const r = await settle(md.ltp(["NSE:RELIANCE"]));
    expect(r.items).toEqual([]);
    expect(r.errors[0]).toMatchObject({ symbol: "NSE:RELIANCE", code: "UPSTREAM_ERROR" });
  });

  it("validates the symbol list and options", async () => {
    const { md } = buildMarket();
    await expect(md.ltp([])).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(md.ltp(Array.from({ length: 201 }, () => "NSE:RELIANCE"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(md.ltp(["NSE:RELIANCE"], { maxAgeMs: -1 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(md.ltp(["NSE:RELIANCE"], { accountId: "nope" })).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });

  it("falls back to fetchLTP for brokers without a quotes API (indices and stocks only)", async () => {
    const noQuotes = stubAdapter("zerodha", { capabilities: { auth: { kind: "apiKeyToken" }, testConnection: true, expiries: true, optionChain: { greeks: "computed" }, ltp: true } });
    const { md, settle } = buildMarket({ accounts: [{ id: "z1", broker: "zerodha", adapter: noQuotes, creds: { apiKey: "k" } }] });
    const r = await settle(md.ltp(["NSE:NIFTY", "NFO:NIFTY-2026-10-27-FUT"]));
    expect(r.items).toEqual([{ symbol: "NSE:NIFTY", ltp: 25012.5, freshness: expect.objectContaining({ source: "broker", accountId: "z1" }) }]);
    expect(r.errors[0]).toMatchObject({ symbol: "NFO:NIFTY-2026-10-27-FUT", code: "CAPABILITY_UNSUPPORTED" });
    expect(noQuotes.calls).toEqual([["fetchLTP", "NIFTY"]]);
    // an LTP-only value cannot answer a quotes request
    const q = await settle(md.quotes(["NSE:NIFTY"]));
    expect(q.errors[0]).toMatchObject({ code: "BROKER_UNAVAILABLE" });
  });

  it("refuses BSE stocks on the LTP-only path instead of returning the NSE price", async () => {
    const noQuotes = stubAdapter("zerodha", { capabilities: { auth: { kind: "apiKeyToken" }, testConnection: true, expiries: true, optionChain: { greeks: "computed" }, ltp: true } });
    const { md, settle } = buildMarket({ accounts: [{ id: "z1", broker: "zerodha", adapter: noQuotes, creds: { apiKey: "k" } }] });
    const r = await settle(md.ltp(["BSE:RELIANCE"]));
    expect(r.items).toEqual([]);
    expect(r.errors[0]).toMatchObject({ symbol: "BSE:RELIANCE", code: "CAPABILITY_UNSUPPORTED" });
    expect(noQuotes.calls).toEqual([]);
  });

  it("says no account can serve when nothing is connected", async () => {
    const { md, settle, accounts } = buildMarket();
    accounts.setState("zerodha-main", "expired");
    accounts.setState("dhan-main", "expired");
    const r = await settle(md.ltp(["NSE:RELIANCE"]));
    expect(r.errors[0]).toMatchObject({ code: "BROKER_UNAVAILABLE" });
  });
});

describe("streaming first", () => {
  it("serves a live tick with source stream and zero REST calls", async () => {
    const hub = stubStreamHub({
      live: ["NSE:RELIANCE"],
      ticks: { "NSE:RELIANCE": { symbol: "NSE:RELIANCE", ltp: 1401.2, bid: 1401.1, ask: 1401.3, bidQty: 10, askQty: 4, volume: 9000, oi: null, open: 1390, high: 1405, low: 1388, close: 1395, exchangeTs: null, receivedAt: T0 - 1500, accountId: "dhan-main", broker: "dhan" } },
    });
    const { md, zerodha, dhan, scheduler } = buildMarket({ streamHub: hub });
    const r = await md.quotes(["NSE:RELIANCE"]);
    expect(scheduler.calls).toHaveLength(0);
    expect(zerodha.calls).toHaveLength(0);
    expect(dhan.calls).toHaveLength(0);
    expect(r.items[0]).toMatchObject({ symbol: "NSE:RELIANCE", ltp: 1401.2, change: 6.2, freshness: { source: "stream", ageMs: 1500, stale: false, accountId: "dhan-main", broker: "dhan" } });
    expect(md.stats().stream).toBe(1);
  });

  it("never labels an old stream tick fresh: a tick older than the target falls through to the broker", async () => {
    // Illiquid strike or after the close: the feed is connected but the last tick is minutes old.
    const hub = stubStreamHub({
      live: ["NSE:RELIANCE"],
      ticks: { "NSE:RELIANCE": { symbol: "NSE:RELIANCE", ltp: 1300, bid: 1299, ask: 1301, bidQty: 1, askQty: 1, volume: 1, oi: null, open: 1, high: 1, low: 1, close: 1, exchangeTs: null, receivedAt: T0 - 600_000, accountId: "dhan-main", broker: "dhan" } },
    });
    const { md, settle, scheduler } = buildMarket({ streamHub: hub });
    const r = await settle(md.quotes(["NSE:RELIANCE"]));
    expect(scheduler.calls.length).toBeGreaterThan(0);
    expect(r.items[0].freshness.source).not.toBe("stream");
  });

  it("ignores a tick when the symbol is not live, and an LTP-only tick for quotes", async () => {
    const tick = { symbol: "NSE:INFY", ltp: 1500, bid: null, ask: null, bidQty: null, askQty: null, volume: null, oi: null, open: null, high: null, low: null, close: null, exchangeTs: null, receivedAt: T0, accountId: "zerodha-main", broker: "zerodha" };
    const hub = stubStreamHub({ ticks: { "NSE:INFY": tick } });
    const { md, settle, scheduler, clock } = buildMarket({ streamHub: hub });
    await settle(md.ltp(["NSE:INFY"]));
    expect(scheduler.calls).toHaveLength(1);
    hub.state.live.add("NSE:INFY");
    tick.receivedAt = clock.now();
    const ltp = await md.ltp(["NSE:INFY"], { maxAgeMs: 0 });
    expect(ltp.items[0]).toMatchObject({ ltp: 1500, freshness: { source: "stream" } });
    const q = await settle(md.quotes(["NSE:INFY"], { maxAgeMs: 0 }));
    expect(q.items[0].freshness.source).toBe("broker");
  });

  it("pinned reads accept stream ticks only from the pinned account", async () => {
    const hub = stubStreamHub({ live: ["NSE:RELIANCE"], ticks: { "NSE:RELIANCE": { ltp: 1, receivedAt: T0, accountId: "dhan-main", broker: "dhan" } } });
    const { md, settle } = buildMarket({ streamHub: hub });
    const r = await settle(md.ltp(["NSE:RELIANCE"], { accountId: "zerodha-main" }));
    expect(r.items[0].freshness).toMatchObject({ source: "broker", accountId: "zerodha-main" });
  });

  it("can be switched off in config", async () => {
    const hub = stubStreamHub({ live: ["NSE:RELIANCE"], ticks: { "NSE:RELIANCE": { ltp: 1, receivedAt: T0, accountId: "dhan-main", broker: "dhan" } } });
    const { md, settle } = buildMarket({ streamHub: hub, market: { streamFirst: false } });
    const r = await settle(md.ltp(["NSE:RELIANCE"]));
    expect(r.items[0].freshness.source).toBe("broker");
  });
});

describe("pinned and pooled routing", () => {
  it("unpooled: every read goes to the first connected capable account", async () => {
    const { md, settle, zerodha, dhan } = buildMarket();
    await settle(md.ltp(["NSE:RELIANCE"]));
    expect(quoteCalls(zerodha)).toHaveLength(1);
    expect(quoteCalls(dhan)).toHaveLength(0);
  });

  it("pinned: the read stays on that account and ignores other accounts' cache", async () => {
    const { md, settle, zerodha, dhan } = buildMarket();
    await settle(md.ltp(["NSE:RELIANCE"]));
    const r = await settle(md.ltp(["NSE:RELIANCE"], { accountId: "dhan-main" }));
    expect(quoteCalls(dhan)).toHaveLength(1);
    expect(dhan.calls[0][1]).toEqual(["D3"]);
    expect(r.items[0].freshness).toMatchObject({ source: "broker", accountId: "dhan-main", broker: "dhan" });
    expect(quoteCalls(zerodha)).toHaveLength(1);
  });

  it("pooled: the scheduler picks among accounts whose broker policy allows pooling", async () => {
    const policies = { zerodha: { pooling: "allowed" }, dhan: { pooling: "allowed" } };
    const { md, settle, zerodha, dhan, scheduler, deps } = buildMarket({
      policies,
      accounts: [
        { id: "zerodha-main", broker: "zerodha", pooling: true, adapter: stubAdapter("zerodha"), creds: { apiKey: "k" } },
        { id: "dhan-main", broker: "dhan", pooling: true, adapter: stubAdapter("dhan"), creds: { clientId: "1" } },
      ],
    });
    void zerodha;
    void dhan;
    scheduler.throttle("zerodha-main", "quote", 60_000);
    const r = await settle(md.ltp(["NSE:RELIANCE"]));
    expect(r.items[0].freshness.accountId).toBe("dhan-main");
    expect(deps.accounts.calls.some((c) => c[0] === "marketDataCandidates" && c[1].capability === "quotes")).toBe(true);
  });

  it("pooled: a many-symbol read is split over the pooled accounts in batch-sized chunks", async () => {
    const policies = { zerodha: { pooling: "allowed", maxQuoteBatch: 10 }, dhan: { pooling: "allowed", maxQuoteBatch: 10 } };
    const zerodha = stubAdapter("zerodha");
    const dhan = stubAdapter("dhan");
    const { md, settle } = buildMarket({
      policies,
      scheduler: createFakeScheduler({ policies }),
      accounts: [
        { id: "zerodha-main", broker: "zerodha", pooling: true, adapter: zerodha, creds: { apiKey: "k" } },
        { id: "dhan-main", broker: "dhan", pooling: true, adapter: dhan, creds: { clientId: "1" } },
      ],
    });
    const r = await settle(md.quotes(FIFTY.slice(0, 40)));
    expect(r.errors).toEqual([]);
    expect(r.items).toHaveLength(40);
    const zSymbols = quoteCalls(zerodha).flatMap((c) => c[1]).length;
    const dSymbols = quoteCalls(dhan).flatMap((c) => c[1]).length;
    expect(zSymbols + dSymbols).toBe(40);
    expect(zSymbols).toBe(20);
    expect(dSymbols).toBe(20);
    const used = new Set(r.items.map((i) => i.freshness.accountId));
    expect([...used].sort()).toEqual(["dhan-main", "zerodha-main"]);
  });

  it("pooled: an account in broker back-off gets no share of the split", async () => {
    const policies = { zerodha: { pooling: "allowed", maxQuoteBatch: 10 }, dhan: { pooling: "allowed", maxQuoteBatch: 10 } };
    const zerodha = stubAdapter("zerodha");
    const dhan = stubAdapter("dhan");
    const { md, settle, scheduler } = buildMarket({
      policies,
      scheduler: createFakeScheduler({ policies }),
      accounts: [
        { id: "zerodha-main", broker: "zerodha", pooling: true, adapter: zerodha, creds: { apiKey: "k" } },
        { id: "dhan-main", broker: "dhan", pooling: true, adapter: dhan, creds: { clientId: "1" } },
      ],
    });
    scheduler.throttle("zerodha-main", "quote", 60_000);
    const r = await settle(md.quotes(FIFTY.slice(0, 30)));
    expect(r.items).toHaveLength(30);
    expect(quoteCalls(zerodha)).toHaveLength(0);
    expect(new Set(r.items.map((i) => i.freshness.accountId))).toEqual(new Set(["dhan-main"]));
  });

  it("refuses a pinned account that lacks the capability", async () => {
    const depthless = stubAdapter("dhan", { capabilities: { auth: { kind: "apiKeyToken" }, ltp: true, quotes: true, expiries: true, optionChain: { greeks: "broker" } } });
    const { md } = buildMarket({ adapters: { dhan: depthless } });
    await expect(md.depth("NSE:RELIANCE", { accountId: "dhan-main" })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
  });
});

describe("stale labelling under budget pressure", () => {
  it("serves the cached value with stale:true when the account is throttled", async () => {
    const { md, settle, clock, scheduler, zerodha } = buildMarket();
    await settle(md.quotes(["NSE:RELIANCE"]));
    await clock.advance(5000);
    scheduler.throttle("zerodha-main", "quote", 10_000);
    const r = await settle(md.quotes(["NSE:RELIANCE"]));
    expect(quoteCalls(zerodha)).toHaveLength(1);
    expect(r.errors).toEqual([]);
    expect(r.items[0].freshness).toMatchObject({ source: "cache", stale: true, accountId: "zerodha-main" });
    expect(r.items[0].freshness.ageMs).toBeGreaterThanOrEqual(5000);
    expect(md.stats().stale).toBe(1);
  });

  it("falls back to stale when the scheduler refuses the call", async () => {
    const { md, settle, clock, scheduler } = buildMarket();
    await settle(md.ltp(["NSE:RELIANCE"]));
    await clock.advance(3000);
    const realSchedule = scheduler.schedule;
    let seenWait;
    scheduler.schedule = async (opts) => {
      seenWait = opts.maxWaitMs;
      throw new BridgeError("UPSTREAM_RATE_LIMITED", "budget gone", { retryAfterMs: 900 });
    };
    scheduler.headroom = () => ({ remaining: 5, limit: 5, resetMs: 0 });
    const r = await settle(md.ltp(["NSE:RELIANCE"]));
    scheduler.schedule = realSchedule;
    expect(seenWait).toBe(250);
    expect(r.items[0].freshness).toMatchObject({ source: "cache", stale: true });
  });

  it("returns the error when there is nothing cached, or the cache is too old", async () => {
    const { md, settle, clock, scheduler } = buildMarket({ market: { stale: { maxStaleMs: 10_000 } } });
    scheduler.throttle("zerodha-main", "quote", 120_000);
    const none = await settle(md.ltp(["NSE:RELIANCE"]));
    expect(none.errors[0]).toMatchObject({ code: "UPSTREAM_RATE_LIMITED" });
    scheduler.reset();
    await settle(md.ltp(["NSE:RELIANCE"]));
    await clock.advance(11_000);
    scheduler.throttle("zerodha-main", "quote", 120_000);
    const old = await settle(md.ltp(["NSE:RELIANCE"]));
    expect(old.errors[0]).toMatchObject({ code: "UPSTREAM_RATE_LIMITED" });
  });

  it("never serves stale values when disabled", async () => {
    const { md, settle, clock, scheduler } = buildMarket({ market: { stale: { enabled: false } } });
    await settle(md.ltp(["NSE:RELIANCE"]));
    await clock.advance(3000);
    scheduler.throttle("zerodha-main", "quote", 60_000);
    const r = await settle(md.ltp(["NSE:RELIANCE"]));
    expect(r.errors[0]).toMatchObject({ code: "UPSTREAM_RATE_LIMITED" });
  });

  it("never serves depth older than 5 s", async () => {
    const { md, clock, scheduler } = buildMarket();
    await md.depth("NSE:RELIANCE");
    await clock.advance(3000);
    scheduler.throttle("zerodha-main", "depth", 60_000);
    const s = await md.depth("NSE:RELIANCE");
    expect(s.freshness).toMatchObject({ source: "cache", stale: true });
    await clock.advance(2500);
    await expect(md.depth("NSE:RELIANCE")).rejects.toMatchObject({ code: "UPSTREAM_RATE_LIMITED" });
  });
});

describe("depth", () => {
  it("normalises and sorts levels, caches for the depth target", async () => {
    const { md, zerodha, scheduler } = buildMarket();
    const d = await md.depth("NSE:RELIANCE");
    expect(d).toEqual({
      symbol: "NSE:RELIANCE",
      bids: [{ price: 100, qty: 5, orders: 1 }, { price: 99, qty: 10, orders: 2 }],
      asks: [{ price: 101, qty: 7, orders: 1 }, { price: 101.5, qty: 3, orders: null }],
      freshness: expect.objectContaining({ source: "broker", accountId: "zerodha-main" }),
    });
    expect(scheduler.calls[0]).toMatchObject({ endpointClass: "depth", coalesceKey: "depth:zerodha-main:NSE:RELIANCE" });
    const again = await md.depth("NSE:RELIANCE");
    expect(again.freshness.source).toBe("cache");
    expect(zerodha.calls.filter((c) => c[0] === "fetchDepth")).toHaveLength(1);
  });
});

describe("history", () => {
  const minuteCandles = (req) => {
    // one candle per 5 minutes from 09:15 to 15:25 IST for each day in [from, to]
    const out = [];
    const day0 = Date.parse(`${req.from.slice(0, 10)}T00:00:00+05:30`);
    const day1 = Date.parse(`${req.to.slice(0, 10)}T00:00:00+05:30`);
    for (let d = day0; d <= day1; d += 86_400_000) {
      const wd = new Date(d + 19_800_000).getUTCDay();
      if (wd === 0 || wd === 6) continue;
      for (let m = 555; m < 930; m += 5) {
        const t = (d + m * 60_000) / 1000;
        out.push({ time: t, open: 100, high: 101 + (m % 7), low: 99, close: 100.5, volume: 10 });
      }
    }
    return out;
  };

  it("chart refreshes with a moving `to` hit the cache instead of refetching", async () => {
    const z = stubAdapter("zerodha", { candles: minuteCandles });
    const { md, clock } = buildMarket({ adapters: { zerodha: z } });
    const nowSec = Math.floor(clock.now() / 1000);
    const from = nowSec - 3 * 86_400;
    await md.history({ symbol: "NSE:NIFTY", interval: "5m", from, to: nowSec + 120 });
    const fetches = z.calls.filter((c) => c[0] === "fetchHistorical").length;
    // Chart-style refreshes a few seconds later: `to` and `from` move slightly, still inside one step.
    if (typeof clock.advance === "function") await clock.advance(5000);
    const again = await md.history({ symbol: "NSE:NIFTY", interval: "5m", from: from + 5, to: nowSec + 125 });
    expect(z.calls.filter((c) => c[0] === "fetchHistorical").length).toBe(fetches);
    expect(again.freshness.source).toBe("cache");
  });

  it("fetches one chunk, filters to the range and labels freshness", async () => {
    const z = stubAdapter("zerodha", { candles: minuteCandles });
    const { md, scheduler } = buildMarket({ adapters: { zerodha: z } });
    const r = await md.history({ symbol: "NSE:NIFTY", interval: "5m", from: "2026-10-16T09:15", to: "2026-10-16T10:00" });
    // The fetch covers the whole 5-minute step that `to` falls in (so later requests in the same step hit the cache).
    expect(z.calls).toEqual([["fetchHistorical", { instrument: { token: "Z1", exchange: "NSE" }, interval: "5m", from: "2026-10-16 09:15", to: "2026-10-16 10:04" }]]);
    expect(scheduler.calls[0]).toMatchObject({ endpointClass: "history" });
    expect(r.candles).toHaveLength(10);
    expect(r.candles[0].time).toBe(Date.parse("2026-10-16T09:15:00+05:30") / 1000);
    expect(r.partial).toBe(false);
    expect(r.freshness).toMatchObject({ source: "broker", accountId: "zerodha-main" });
  });

  it("aggregates 10m from 5m candles aligned to 09:15 IST", async () => {
    const z = stubAdapter("zerodha", { candles: minuteCandles });
    const { md } = buildMarket({ adapters: { zerodha: z } });
    const r = await md.history({ symbol: "NSE:NIFTY", interval: "10m", from: "2026-10-16T09:15", to: "2026-10-16T10:14" });
    expect(z.calls[0][1].interval).toBe("5m");
    expect(r.candles).toHaveLength(6);
    expect(r.candles[1]).toMatchObject({ time: Date.parse("2026-10-16T09:25:00+05:30") / 1000, volume: 20 });
  });

  it("splits long ranges into broker-sized chunks, merges and de-duplicates", async () => {
    const z = stubAdapter("zerodha", { candles: minuteCandles });
    const { md } = buildMarket({ adapters: { zerodha: z }, market: { history: { maxSpanDays: { intraday: 2 } } } });
    const r = await md.history({ symbol: "NSE:NIFTY", interval: "5m", from: "2026-10-12", to: "2026-10-16" });
    const hist = z.calls.filter((c) => c[0] === "fetchHistorical");
    expect(hist).toHaveLength(3);
    expect(r.candles).toHaveLength(5 * 75);
    const times = r.candles.map((c) => c.time);
    expect(new Set(times).size).toBe(times.length);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("sets partial when a chunk fails or the chunk cap is hit", async () => {
    let n = 0;
    const z = stubAdapter("zerodha", {
      overrides: {
        async fetchHistorical(creds, req) {
          n += 1;
          if (n === 2) throw Object.assign(new Error("boom"), { code: "UPSTREAM_ERROR" });
          return { status: "success", data: minuteCandles(req) };
        },
      },
    });
    const { md } = buildMarket({ adapters: { zerodha: z }, market: { history: { maxSpanDays: { intraday: 1 } } } });
    const r = await md.history({ symbol: "NSE:NIFTY", interval: "5m", from: "2026-10-14", to: "2026-10-16" });
    expect(r.partial).toBe(true);
    expect(r.candles.length).toBe(2 * 75);

    const z2 = stubAdapter("zerodha", { candles: minuteCandles });
    const capped = buildMarket({ adapters: { zerodha: z2 }, market: { history: { maxSpanDays: { intraday: 1 }, maxChunks: 2 } } });
    const r2 = await capped.md.history({ symbol: "NSE:NIFTY", interval: "5m", from: "2026-10-12", to: "2026-10-16" });
    expect(r2.partial).toBe(true);
    expect(z2.calls).toHaveLength(2);
    expect(r2.candles[0].time).toBe(Date.parse("2026-10-15T09:15:00+05:30") / 1000);
  });

  it("throws when every chunk fails", async () => {
    const z = stubAdapter("zerodha", { overrides: { fetchHistorical: async () => { throw Object.assign(new Error("throttled"), { code: "UPSTREAM_RATE_LIMIT" }); } } });
    const { md } = buildMarket({ adapters: { zerodha: z } });
    await expect(md.history({ symbol: "NSE:NIFTY", interval: "1d", from: "2026-10-01" })).rejects.toMatchObject({ code: "UPSTREAM_RATE_LIMITED", broker: { id: "zerodha" } });
  });

  it("countback returns the last N bars; 1w is built from daily candles", async () => {
    const daily = (req) => {
      const out = [];
      for (let d = Date.parse(`${req.from}T00:00:00+05:30`); d <= Date.parse(`${req.to}T00:00:00+05:30`); d += 86_400_000) {
        const wd = new Date(d + 19_800_000).getUTCDay();
        if (wd !== 0 && wd !== 6) out.push({ time: d / 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 });
      }
      return out;
    };
    const z = stubAdapter("zerodha", { candles: daily });
    const { md } = buildMarket({ adapters: { zerodha: z } });
    const r = await md.history({ symbol: "NSE:NIFTY", interval: "1d", countback: 10 });
    expect(r.candles).toHaveLength(10);
    expect(r.candles.at(-1).time).toBe(Date.parse("2026-10-19T00:00:00+05:30") / 1000);
    const w = await md.history({ symbol: "NSE:NIFTY", interval: "1w", from: "2026-09-28", to: "2026-10-16" });
    expect(z.calls.at(-1)[1].interval).toBe("1d");
    expect(w.candles).toHaveLength(3);
    expect(w.candles[0]).toMatchObject({ volume: 500, open: 1, close: 1.5 });
  });

  it("caches results and validates input", async () => {
    const z = stubAdapter("zerodha", { candles: minuteCandles });
    const { md } = buildMarket({ adapters: { zerodha: z } });
    await md.history({ symbol: "NSE:NIFTY", interval: "5m", from: "2026-10-16" });
    const again = await md.history({ symbol: "NSE:NIFTY", interval: "5m", from: "2026-10-16" });
    expect(again.freshness.source).toBe("cache");
    expect(z.calls).toHaveLength(1);
    await expect(md.history({ symbol: "NSE:NIFTY", interval: "2m", from: "2026-10-16" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(md.history({ symbol: "NSE:NIFTY", interval: "5m" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(md.history({ symbol: "NSE:NIFTY", interval: "5m", from: "2026-10-17", to: "2026-10-16" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(md.history({ symbol: "NSE:NIFTY", interval: "3m", from: "2026-10-16" })).resolves.toBeTruthy(); // built from 1m
  });

  it("refuses intervals and segments the broker cannot supply", async () => {
    const z = stubAdapter("zerodha", { capabilities: { auth: { kind: "apiKeyToken" }, quotes: true, ltp: true, expiries: true, optionChain: { greeks: "broker" }, historical: { intervals: ["1m"], segments: ["NFO"] } } });
    const { md } = buildMarket({ accounts: [{ id: "z", broker: "zerodha", adapter: z }] });
    await expect(md.history({ symbol: "NSE:NIFTY", interval: "1m", from: "2026-10-16" })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    await expect(md.history({ symbol: "NFO:NIFTY-2026-10-27-FUT", interval: "1d", from: "2026-10-16" })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
  });
});

describe("expiries", () => {
  it("returns upcoming ISO expiries from the broker and caches them", async () => {
    const { md, zerodha, scheduler } = buildMarket();
    const r = await md.expiries("nifty");
    expect(r).toEqual({ underlying: "NIFTY", expiries: ["2026-10-20", "2026-10-27", "2026-11-24"], freshness: expect.objectContaining({ source: "broker", accountId: "zerodha-main" }) });
    expect(zerodha.calls).toEqual([["fetchExpiryList", "NIFTY"]]);
    expect(scheduler.calls[0]).toMatchObject({ endpointClass: "chain" });
    const again = await md.expiries("NSE:NIFTY");
    expect(again.freshness.source).toBe("cache");
    expect(zerodha.calls).toHaveLength(1);
  });

  it("drops past expiries and falls back to the instrument master when the broker fails", async () => {
    const z = stubAdapter("zerodha", { overrides: { fetchExpiryList: async () => { throw Object.assign(new Error("down"), { code: "UPSTREAM_ERROR" }); } } });
    const { md } = buildMarket({ adapters: { zerodha: z } });
    const r = await md.expiries("NIFTY");
    expect(r.expiries).toEqual(["2026-10-27", "2026-11-24"]);
    expect(r.freshness).toMatchObject({ source: "cache", accountId: null });
  });

  it("with an exchange named, never caches another segment's broker expiries under it", async () => {
    // fetchExpiryList takes no exchange: the broker answers with NFO dates even when BFO was asked for.
    const { md } = buildMarket();
    const bfo = await md.expiries("NIFTY", { exchange: "BFO" }).catch((e) => e);
    // The master has no BFO NIFTY contracts, so the answer is not cached under BFO ...
    if (!(bfo instanceof Error)) expect(bfo.freshness.source).toBe("broker");
    // ... and an NFO request still sees only dates the master lists for NFO.
    const nfo = await md.expiries("NIFTY", { exchange: "NFO" });
    expect(nfo.expiries).toEqual(["2026-10-27", "2026-11-24"]);
    const again = await md.expiries("NIFTY", { exchange: "BFO" }).catch((e) => e);
    if (!(again instanceof Error)) expect(again.freshness.source).not.toBe("cache");
  });

  it("validates underlying and exchange", async () => {
    const { md } = buildMarket();
    await expect(md.expiries("NIFTY 50!")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(md.expiries("NIFTY", { exchange: "NSE" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("option chain", () => {
  it("uses the broker chain: canonical leg symbols, broker greeks, computed where missing", async () => {
    const { md, scheduler } = buildMarket();
    const c = await md.optionChain({ underlying: "NIFTY", expiry: "2026-10-27" });
    expect(scheduler.calls[0]).toMatchObject({ endpointClass: "chain", coalesceKey: "chain:zerodha-main:NIFTY:2026-10-27" });
    expect(c).toMatchObject({ underlying: "NIFTY", expiry: "2026-10-27", underlyingLtp: 25012.5, atmStrike: 25000, lotSize: 65 });
    expect(c.rows.map((r) => r.strike)).toEqual([24800, 24900, 25000, 25100, 25200]);
    const atm = c.rows[2];
    expect(atm.ce).toMatchObject({ symbol: "NFO:NIFTY-2026-10-27-25000-CE", iv: 13.5, delta: 0.5, greeksSource: "broker", oi: 1000, oiChange: 100, bid: 70, ask: 71 });
    expect(atm.pe.symbol).toBe("NFO:NIFTY-2026-10-27-25000-PE");
    expect(atm.pe.greeksSource).toBe("computed");
    expect(atm.pe.iv).toBeGreaterThan(0);
    expect(atm.pe.delta).toBeLessThan(0);
    expect(atm.pe.oiChange).toBe(150);
    expect(c.freshness).toMatchObject({ source: "broker", accountId: "zerodha-main" });
  });

  it("computed Greeks use the reference rate; the deprecated market.chain.riskFreeRate override wins and warns once", async () => {
    const pe = async (opts) => (await buildMarket(opts).md.optionChain({ underlying: "NIFTY", expiry: "2026-10-27" })).rows[2].pe;
    const fakeRef = (value) => ({ rate: () => ({ value, asOf: "2026-10-28", source: "test", quality: "user", stale: false }) });
    const low = await pe({ reference: fakeRef(0) });
    const high = await pe({ reference: fakeRef(0.25) });
    expect(low.greeksSource).toBe("computed");
    expect(high.iv).not.toBe(low.iv);
    const warns = [];
    const logger = { ...createNullLogger(), warn: (msg) => warns.push(msg), child() { return this; } };
    const overridden = await pe({ reference: fakeRef(0), market: { chain: { riskFreeRate: 0.25 } }, logger });
    expect(overridden.iv).toBe(high.iv);
    expect(warns.filter((w) => /deprecated/.test(w))).toHaveLength(1);
    const fallback = await pe({});
    const dflt = await pe({ reference: fakeRef(0.065) });
    expect(fallback.iv).toBe(dflt.iv);
  });

  it("trims to N strikes each side of ATM and strips greeks when asked", async () => {
    const { md } = buildMarket();
    const c = await md.optionChain({ underlying: "NIFTY", expiry: "2026-10-27", strikes: 1, greeks: false });
    expect(c.rows.map((r) => r.strike)).toEqual([24900, 25000, 25100]);
    expect(c.rows[1].ce).toMatchObject({ delta: null, gamma: null, theta: null, vega: null, greeksSource: null, iv: 13.5 });
  });

  it("builds the chain from the master plus quotes when the source is 'built'", async () => {
    const { md, settle, zerodha } = buildMarket({ market: { chain: { source: "built" } } });
    const c = await settle(md.optionChain({ underlying: "NIFTY", expiry: "2026-10-27" }), 60);
    expect(zerodha.calls.some((x) => x[0] === "fetchOptionChain")).toBe(false);
    expect(c.rows).toHaveLength(5);
    expect(c.underlyingLtp).toBe(priceForToken("Z1"));
    expect(c.rows[0].ce).toMatchObject({ symbol: "NFO:NIFTY-2026-10-27-24800-CE", oiChange: null });
    expect(["computed", null]).toContain(c.rows[0].ce.greeksSource);
    expect(c.lotSize).toBe(65);
  });

  it("caches the chain and serves stale under pressure", async () => {
    const { md, scheduler, clock, zerodha } = buildMarket();
    await md.optionChain({ underlying: "NIFTY", expiry: "2026-10-27" });
    const hit = await md.optionChain({ underlying: "NIFTY", expiry: "2026-10-27", strikes: 1 });
    expect(hit.freshness.source).toBe("cache");
    expect(hit.rows).toHaveLength(3);
    await clock.advance(10_000);
    scheduler.throttle("zerodha-main", "chain", 60_000);
    const stale = await md.optionChain({ underlying: "NIFTY", expiry: "2026-10-27" });
    expect(stale.freshness).toMatchObject({ source: "cache", stale: true });
    expect(zerodha.calls.filter((x) => x[0] === "fetchOptionChain")).toHaveLength(1);
  });

  it("a Greeks-off read reuses a fresh chain read with Greeks (Greeks stripped, no broker call)", async () => {
    const { md, zerodha } = buildMarket();
    await md.optionChain({ underlying: "NIFTY", expiry: "2026-10-27" });
    const off = await md.optionChain({ underlying: "NIFTY", expiry: "2026-10-27", greeks: false });
    expect(off.freshness.source).toBe("cache");
    expect(off.rows[2].ce).toMatchObject({ delta: null, gamma: null, greeksSource: null, oi: 1000 });
    expect(zerodha.calls.filter((x) => x[0] === "fetchOptionChain")).toHaveLength(1);
  });

  it("reports an empty chain as SYMBOL_NOT_FOUND", async () => {
    const z = stubAdapter("zerodha", { chain: { status: "success", data: { oc: {}, last_price: 0 } } });
    const { md } = buildMarket({ adapters: { zerodha: z } });
    await expect(md.optionChain({ underlying: "NIFTY", expiry: "2026-10-27" })).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND" });
  });
});

describe("secrets", () => {
  it("never puts credentials in cache keys, results or scheduler options", async () => {
    const { md, settle, scheduler } = buildMarket({
      accounts: [{ id: "zerodha-main", broker: "zerodha", adapter: stubAdapter("zerodha"), creds: { apiKey: "SECRET-KEY-123", accessToken: "SECRET-TOKEN-456" } }],
    });
    const r = await settle(md.quotes(FIFTY.slice(0, 5)));
    const text = JSON.stringify([r, scheduler.calls, [...Array(0)]]);
    expect(text).not.toMatch(/SECRET/);
    for (const k of ["q|NSE:STK01"]) expect(JSON.stringify(md.cache.peek(k))).not.toMatch(/SECRET/);
  });
});
