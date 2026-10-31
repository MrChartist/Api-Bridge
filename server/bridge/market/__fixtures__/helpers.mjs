/**
 * Test fixtures for stream S5: a counting stub broker adapter, a stub StreamHub, an instrument list with refs for two
 * brokers, and a builder that wires the real MarketDataService to the published fakes of S1 (accounts), S3
 * (scheduler, manual clock) and S4 (symbols). No network, no disk, no sleeps.
 */
import { notImplementedService } from "../../core/contracts.mjs";
import { createEventBus } from "../../core/eventBus.mjs";
import { createNullLogger } from "../../core/logger.mjs";
import { createFakeAccountManager } from "../../accounts/fake.mjs";
import { createFakeScheduler, createManualClock } from "../../ratelimit/fake.mjs";
import { createFakeSymbolService } from "../../symbols/fake.mjs";
import { createMarketDataService } from "../marketDataService.mjs";

/** 2026-10-19 09:30 IST (Monday, market open). */
export const T0 = Date.UTC(2026, 9, 19, 4, 0, 0);

const strikes = [24800, 24900, 25000, 25100, 25200];

/** Fifty liquid-looking stock symbols for call-counting tests. */
export const FIFTY = Array.from({ length: 50 }, (_, i) => `NSE:STK${String(i + 1).padStart(2, "0")}`);

/** Instrument specs (symbols/fake.mjs rowsFromSpecs format) with refs for brokers "zerodha" and "dhan". */
export function instrumentSpecs() {
  const specs = [
    { symbol: "NSE:NIFTY", lotSize: 1, tickSize: 0.05 },
    { symbol: "BSE:SENSEX", lotSize: 1, tickSize: 0.01 },
    { symbol: "NSE:RELIANCE", lotSize: 1, tickSize: 0.1 },
    { symbol: "NSE:INFY", lotSize: 1, tickSize: 0.05 },
    { symbol: "NSE:M&M", lotSize: 1, tickSize: 0.05 },
    { symbol: "NFO:NIFTY-2026-10-27-FUT", lotSize: 65, tickSize: 0.1 },
    ...strikes.flatMap((k) => ["CE", "PE"].map((r) => ({ symbol: `NFO:NIFTY-2026-10-27-${k}-${r}`, lotSize: 65, tickSize: 0.05 }))),
    { symbol: "NFO:NIFTY-2026-11-24-25000-CE", lotSize: 65, tickSize: 0.05 },
    ...FIFTY.map((symbol) => ({ symbol, lotSize: 1, tickSize: 0.05 })),
  ];
  return specs.map((s, i) => ({ ...s, refs: { zerodha: { token: `Z${i + 1}` }, dhan: { token: `D${i + 1}` } } }));
}

/** Deterministic price for a token (Z12 / D12 -> same price). */
export function priceForToken(token) {
  const n = Number(String(token).replace(/\D/g, ""));
  return 100 + n * 10;
}

/**
 * A counting stub adapter on the strict contract. Every method records its call; override any with `overrides`.
 * @param {string} id broker id
 * @param {{ capabilities?: object, overrides?: Record<string, Function>, chain?: object, expiries?: string[], candles?: (req) => object[] }} [opts]
 */
export function stubAdapter(id, { capabilities, overrides = {}, chain, expiries = ["2026-10-20", "2026-10-27", "2026-11-24"], candles } = {}) {
  const calls = [];
  const adapter = {
    id,
    credentialFields: ["apiKey", "accessToken"],
    capabilities: capabilities ?? {
      auth: { kind: "apiKeyToken" },
      testConnection: true,
      expiries: true,
      optionChain: { greeks: "broker" },
      ltp: true,
      quotes: true,
      depth: true,
      historical: { intervals: ["1m", "5m", "15m", "60m", "1d"] },
    },
    calls,
    async testConnection() {
      return { status: "success", message: "ok" };
    },
    async fetchQuotes(creds, refs) {
      calls.push(["fetchQuotes", refs.map((r) => r.token)]);
      return {
        status: "success",
        data: refs.map((r) => {
          const ltp = priceForToken(r.token);
          return { token: r.token, exchange: r.exchange, ltp, open: ltp - 1, high: ltp + 2, low: ltp - 3, close: ltp - 5, volume: 1000, oi: null, bid: ltp - 0.05, ask: ltp + 0.05 };
        }),
      };
    },
    async fetchLTP(creds, symbol) {
      calls.push(["fetchLTP", symbol]);
      return { status: "success", data: { last_price: symbol === "NIFTY" ? 25012.5 : 1234.5 } };
    },
    async fetchDepth(creds, ref) {
      calls.push(["fetchDepth", ref.token]);
      return {
        status: "success",
        data: {
          bids: [{ price: 99, qty: 10, orders: 2 }, { price: 100, qty: 5, orders: 1 }],
          asks: [{ price: 101.5, qty: 3, orders: null }, { price: 101, qty: 7, orders: 1 }],
        },
      };
    },
    async fetchHistorical(creds, req) {
      calls.push(["fetchHistorical", { ...req, instrument: { ...req.instrument } }]);
      return { status: "success", data: candles ? candles(req) : [] };
    },
    async fetchExpiryList(creds, symbol) {
      calls.push(["fetchExpiryList", symbol]);
      return { status: "success", data: expiries };
    },
    async fetchOptionChain(creds, symbol, expiry) {
      calls.push(["fetchOptionChain", symbol, expiry]);
      return chain ?? defaultChain();
    },
    ...overrides,
  };
  return adapter;
}

/** A small Dhan-shaped chain around 25,012.5 (broker greeks on CE legs, none on PE legs). */
export function defaultChain() {
  const oc = {};
  for (const k of strikes) {
    oc[`${k}.000000`] = {
      ce: { last_price: Math.max(1, 25012.5 - k) + 60, oi: 1000, previous_oi: 900, volume: 50, implied_volatility: 13.5, greeks: { delta: 0.5, gamma: 0.001, theta: -10, vega: 12 }, top_bid_price: 70, top_ask_price: 71 },
      pe: { last_price: Math.max(1, k - 25012.5) + 60, oi: 2000, oi_chg: 150, volume: 80, bid_price: 60, ask_price: 61 },
    };
  }
  return { status: "success", data: { oc, last_price: 25012.5 } };
}

/**
 * Stub StreamHub: `live` symbols with their ticks. Mutate `ticks` / `live` in a test to simulate the feed.
 * @param {{ ticks?: Record<string, object>, live?: string[] }} [opts]
 */
export function stubStreamHub({ ticks = {}, live = [] } = {}) {
  const state = { ticks: new Map(Object.entries(ticks)), live: new Set(live) };
  return {
    ...notImplementedService("streamHub"),
    lastTick: (s) => state.ticks.get(s) ?? null,
    isLive: (s) => state.live.has(s),
    state,
  };
}

/**
 * Wire the real MarketDataService to fakes.
 * @param {{ accounts?: object[], policies?: object, scheduler?: object, streamHub?: object, market?: object, clock?: object,
 *   symbols?: object, adapters?: Record<string, object> }} [opts]
 */
export function buildMarket(opts = {}) {
  const clock = opts.clock ?? createManualClock(T0);
  const bus = createEventBus({ logger: createNullLogger() });
  const zerodha = opts.adapters?.zerodha ?? stubAdapter("zerodha");
  const dhan = opts.adapters?.dhan ?? stubAdapter("dhan");
  const accounts =
    opts.accountManager ??
    createFakeAccountManager({
      accounts: opts.accounts ?? [
        { id: "zerodha-main", broker: "zerodha", adapter: zerodha, creds: { apiKey: "k", accessToken: "t" } },
        { id: "dhan-main", broker: "dhan", adapter: dhan, creds: { clientId: "1", accessToken: "t" } },
      ],
      bus,
      policies: opts.policies ?? {},
    });
  const scheduler = opts.scheduler ?? createFakeScheduler({ bus });
  const symbols = opts.symbols ?? createFakeSymbolService({ instruments: instrumentSpecs() });
  const streamHub = opts.streamHub ?? stubStreamHub();
  const deps = {
    config: { market: opts.market ?? {} },
    logger: opts.logger ?? createNullLogger(),
    bus,
    clock,
    paths: {},
    brokers: {},
    accounts,
    scheduler,
    symbols,
    streamHub,
    ...(opts.reference ? { reference: opts.reference } : {}),
  };
  const md = createMarketDataService(deps);
  /** Advance the manual clock past the batch window and wait for `p`. */
  const settle = async (p, ms = 30) => {
    if (typeof clock.advance === "function") await clock.advance(ms);
    return p;
  };
  return { md, clock, bus, accounts, scheduler, symbols, streamHub, zerodha, dhan, settle, deps };
}
