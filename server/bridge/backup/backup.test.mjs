/**
 * Backup data sources (stream S12): Yahoo and NSE response parsing, provider order, pacing, the circuit breaker, and
 * MarketDataService falling back only for unpinned reads that allow it, always labelled source "backup".
 * No network: providers get a stub fetch or are replaced with stubs.
 */
import { describe, expect, it } from "vitest";
import { createMarketDataService } from "../market/marketDataService.mjs";
import { buildMarket, T0 } from "../market/__fixtures__/helpers.mjs";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { createBackupDataService } from "./backupService.mjs";
import { createHttpClient } from "./httpClient.mjs";
import { chainFromV3, createNseProvider, equityFields, indexFields, isoToNseDate, nseDateToIso } from "./providers/nse.mjs";
import { createYahooProvider, parseCandles, parseQuote, yahooTicker } from "./providers/yahoo.mjs";

const yahooChart = ({ price = 2950.5, prev = 2900, time = T0 / 1000 - 60, timestamps = [], quote = {} } = {}) => ({
  chart: {
    result: [
      {
        meta: { regularMarketPrice: price, previousClose: prev, regularMarketDayHigh: 2960, regularMarketDayLow: 2890, regularMarketVolume: 123456, regularMarketTime: time },
        timestamp: timestamps,
        indicators: { quote: [{ open: [2901], high: [2960], low: [2890], close: [price], volume: [123456], ...quote }] },
      },
    ],
    error: null,
  },
});

function stubFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init.headers });
    for (const [re, reply] of routes) {
      if (re.test(url)) {
        const r = typeof reply === "function" ? reply(url) : reply;
        const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
        return new Response(body, { status: r.status ?? 200, headers: r.headers ?? {} });
      }
    }
    return new Response("{}", { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

describe("Yahoo provider", () => {
  it("maps canonical symbols to Yahoo tickers and refuses derivatives", () => {
    expect(yahooTicker("NSE:RELIANCE")).toBe("RELIANCE.NS");
    expect(yahooTicker("BSE:RELIANCE")).toBe("RELIANCE.BO");
    expect(yahooTicker("NSE:M&M")).toBe("M&M.NS");
    expect(yahooTicker("NSE:NIFTY")).toBe("^NSEI");
    expect(yahooTicker("NSE:BANKNIFTY")).toBe("^NSEBANK");
    expect(yahooTicker("BSE:SENSEX")).toBe("^BSESN");
    expect(yahooTicker("NFO:NIFTY-2026-10-27-25000-CE")).toBeNull();
    expect(yahooTicker("NFO:NIFTY-2026-10-27-FUT")).toBeNull();
  });

  it("parses a quote with Yahoo's own market time", () => {
    const q = parseQuote(yahooChart(), "RELIANCE.NS");
    expect(q.fields).toMatchObject({ ltp: 2950.5, open: 2901, high: 2960, low: 2890, close: 2900, volume: 123456, bid: null });
    expect(q.at).toBe(T0 - 60_000);
  });

  it("turns chart.error into SYMBOL_NOT_FOUND", () => {
    expect(() => parseQuote({ chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } }, "XYZ.NS")).toThrow(
      expect.objectContaining({ code: "SYMBOL_NOT_FOUND" }),
    );
  });

  it("stamps daily candles at IST midnight and drops null bars", () => {
    // 2026-10-19 09:15 IST and 2026-10-20 09:15 IST
    const t1 = Date.UTC(2026, 9, 19, 3, 45) / 1000;
    const t2 = Date.UTC(2026, 9, 20, 3, 45) / 1000;
    const json = yahooChart({ timestamps: [t1, t2], quote: { open: [10, null], high: [12, 13], low: [9, 9], close: [11, 12], volume: [100, 200] } });
    const c = parseCandles(json, "X.NS", "1d");
    expect(c).toEqual([{ time: Date.UTC(2026, 9, 18, 18, 30) / 1000, open: 10, high: 12, low: 9, close: 11, volume: 100 }]);
  });

  it("sends a browser User-Agent and asks the chart endpoint", async () => {
    const fetchImpl = stubFetch([[/v8\/finance\/chart\/RELIANCE\.NS/, { body: yahooChart() }]]);
    const y = createYahooProvider({ http: createHttpClient({ fetchImpl, provider: "Yahoo Finance" }), now: () => T0 });
    const q = await y.quote("NSE:RELIANCE");
    expect(q.fields.ltp).toBe(2950.5);
    expect(fetchImpl.calls[0].headers["User-Agent"]).toMatch(/Mozilla/);
  });

  it("clamps 1m history to Yahoo's lookback and marks it partial", async () => {
    const fetchImpl = stubFetch([[/chart/, { body: yahooChart({ timestamps: [] }) }]]);
    const y = createYahooProvider({ http: createHttpClient({ fetchImpl, provider: "Yahoo Finance" }), now: () => T0 });
    const r = await y.history("NSE:INFY", "1m", T0 - 90 * 86_400_000, T0);
    expect(r.partial).toBe(true);
    // 29 days in 7-day requests
    expect(fetchImpl.calls).toHaveLength(5);
  });
});

describe("NSE provider", () => {
  it("converts NSE dates both ways", () => {
    expect(nseDateToIso("27-Oct-2026")).toBe("2026-10-27");
    expect(nseDateToIso("3-Nov-2026")).toBe("2026-11-03");
    expect(nseDateToIso("bad")).toBeNull();
    expect(isoToNseDate("2026-10-27")).toBe("27-Oct-2026");
  });

  it("reads index and equity quote shapes", () => {
    expect(indexFields({ index: "NIFTY 50", last: 25010.5, open: 24950, high: 25050, low: 24900, previousClose: 24980 })).toMatchObject({ ltp: 25010.5, close: 24980 });
    const eq = equityFields({
      equityResponse: [{ orderBook: { lastPrice: 1500, buyPrice1: 1499.9, sellPrice1: 1500.1, buyQuantity1: 10, sellQuantity1: 5 }, metaData: { open: 1490, dayHigh: 1510, dayLow: 1488, previousClose: 1495 }, tradeInfo: { totalTradedVolume: 999 } }],
    });
    expect(eq).toMatchObject({ ltp: 1500, bid: 1499.9, ask: 1500.1, open: 1490, high: 1510, low: 1488, close: 1495, volume: 999 });
  });

  it("builds chain rows from option-chain-v3 and keeps only the asked expiry", () => {
    const json = {
      records: {
        underlyingValue: 25010,
        data: [
          { strikePrice: 25000, expiryDates: "27-Oct-2026", CE: { lastPrice: 120, openInterest: 1000, changeinOpenInterest: 50, totalTradedVolume: 7000, impliedVolatility: 12.5, buyPrice1: 119, sellPrice1: 121 }, PE: { lastPrice: 110, impliedVolatility: 0 } },
          { strikePrice: 25100, expiryDates: "03-Nov-2026", CE: { lastPrice: 80 } },
        ],
      },
    };
    const r = chainFromV3(json, { underlying: "NIFTY", expiry: "2026-10-27" });
    expect(r.underlyingLtp).toBe(25010);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].ce).toMatchObject({ ltp: 120, bid: 119, ask: 121, oi: 1000, oiChange: 50, volume: 7000, iv: 12.5 });
    expect(r.rows[0].pe.iv).toBeNull();
  });

  it("finds an index in allIndices and retries once with fresh cookies after a refusal", async () => {
    let refused = false;
    const fetchImpl = stubFetch([
      [/nseindia\.com\/$/, { body: "<html>", headers: { "set-cookie": "nsit=abc; Path=/" } }],
      [
        /allIndices/,
        () => {
          if (!refused) {
            refused = true;
            return { status: 403, body: "{}" };
          }
          return { body: { data: [{ index: "NIFTY BANK", last: 56000, previousClose: 55500 }] } };
        },
      ],
    ]);
    const nse = createNseProvider({ http: createHttpClient({ fetchImpl, provider: "NSE India" }), now: () => T0 });
    const q = await nse.quote("NSE:BANKNIFTY");
    expect(q.fields).toMatchObject({ ltp: 56000, close: 55500 });
    const api = fetchImpl.calls.filter((c) => /allIndices/.test(c.url));
    expect(api).toHaveLength(2);
    expect(api[1].headers.Cookie).toContain("nsit=abc");
    expect(api[1].headers.Referer).toMatch(/^https:\/\/www\.nseindia\.com\//);
  });
});

/** A provider stub that records calls. */
function stubProvider(id, { quote, fail, history, covers } = {}) {
  const calls = [];
  return {
    id,
    name: id,
    covers: covers ?? { quotes: ["INDEX", "EQ"], history: ["INDEX", "EQ"], optionChain: id === "nse" },
    supports: () => true,
    calls,
    async quote(sym) {
      calls.push(["quote", sym]);
      if (fail) throw fail;
      return { fields: { ltp: quote ?? 100, open: null, high: null, low: null, close: 99, volume: null, oi: null, bid: null, ask: null }, at: T0 - 5000 };
    },
    async history(sym, base, fromMs, toMs) {
      calls.push(["history", sym, base]);
      if (fail) throw fail;
      return history ?? { candles: [{ time: Math.floor(fromMs / 1000) + 3600, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }], partial: false };
    },
    async expiries() {
      calls.push(["expiries"]);
      return ["2026-10-27", "2026-11-03"];
    },
    async optionChain(u, expiry) {
      calls.push(["optionChain", u, expiry]);
      return { rows: [{ strike: 25000, ce: { ltp: 120, bid: 119, ask: 121, oi: 10, oiChange: 1, volume: 5, iv: null }, pe: null }], underlyingLtp: 25010, at: T0 - 1000 };
    },
  };
}

function service({ backup = {}, providers, clock } = {}) {
  let t = T0;
  const c = clock ?? { now: () => t };
  const svc = createBackupDataService({
    config: { backup: { enabled: true, ...backup } },
    logger: undefined,
    clock: c,
    providers,
    sleep: async (ms) => {
      t += ms;
    },
  });
  return { svc, advance: (ms) => (t += ms) };
}

describe("BackupDataService", () => {
  it("is off unless enabled, and always off in demo mode", async () => {
    const off = createBackupDataService({ config: {}, clock: { now: () => T0 }, providers: { yahoo: stubProvider("yahoo") } });
    await expect(off.quotes(["NSE:RELIANCE"])).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    const demo = createBackupDataService({ config: { demo: true, backup: { enabled: true } }, clock: { now: () => T0 }, providers: { yahoo: stubProvider("yahoo") } });
    expect(demo.status().enabled).toBe(false);
    expect(demo.autoFallback()).toBe(false);
  });

  it("tries providers in the configured order per kind and caches quotes", async () => {
    const yahoo = stubProvider("yahoo", { quote: 1 });
    const nse = stubProvider("nse", { quote: 2 });
    const { svc, advance } = service({ providers: { yahoo, nse } });
    const r = await svc.quotes(["NSE:RELIANCE", "NSE:NIFTY"]);
    expect(r.items.map((i) => [i.symbol, i.provider, i.fields.ltp])).toEqual([
      ["NSE:RELIANCE", "yahoo", 1],
      ["NSE:NIFTY", "nse", 2],
    ]);
    await svc.quotes(["NSE:RELIANCE"]);
    expect(yahoo.calls).toHaveLength(1);
    advance(20_000);
    await svc.quotes(["NSE:RELIANCE"]);
    expect(yahoo.calls).toHaveLength(2);
  });

  it("falls through to the next provider, and pauses a provider after repeated failures", async () => {
    const { BridgeError } = await import("../core/errors.mjs");
    const yahoo = stubProvider("yahoo", { fail: new BridgeError("UPSTREAM_ERROR", "blocked") });
    const nse = stubProvider("nse", { quote: 7 });
    const { svc } = service({ providers: { yahoo, nse }, backup: { cacheMs: 0, breaker: { failures: 2, cooldownMs: 60_000 } } });
    for (let i = 0; i < 3; i += 1) {
      const r = await svc.quotes(["NSE:INFY"]);
      expect(r.items[0]).toMatchObject({ provider: "nse" });
    }
    expect(yahoo.calls).toHaveLength(2); // third read skipped the paused provider
    const st = svc.status().providers.find((p) => p.id === "yahoo");
    expect(st.paused).toBe(true);
    expect(st.lastError.code).toBe("UPSTREAM_ERROR");
  });

  it("paces calls to a provider (no bursts)", async () => {
    const yahoo = stubProvider("yahoo");
    let t = T0;
    const waits = [];
    const svc = createBackupDataService({
      config: { backup: { enabled: true, cacheMs: 0, providers: { yahoo: { perSecond: 2 }, nse: { enabled: false } } } },
      clock: { now: () => t },
      providers: { yahoo, nse: stubProvider("nse") },
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await svc.quotes(["NSE:A1", "NSE:A2", "NSE:A3"]);
    expect(waits).toEqual([500, 1000]);
    t += 5000;
    expect(svc.status().providers[0].calls).toBe(3);
  });

  it("builds 3m candles from Yahoo's 1m bars", async () => {
    const start = Date.UTC(2026, 9, 19, 3, 45) / 1000;
    const bars = Array.from({ length: 6 }, (_, i) => ({ time: start + i * 60, open: 10 + i, high: 11 + i, low: 9 + i, close: 10.5 + i, volume: 100 }));
    const yahoo = stubProvider("yahoo", { history: { candles: bars, partial: false } });
    const { svc } = service({ providers: { yahoo, nse: stubProvider("nse") } });
    const r = await svc.history({ symbol: "NSE:INFY", interval: "3m", fromMs: start * 1000, toMs: (start + 600) * 1000 });
    expect(yahoo.calls[0]).toEqual(["history", "NSE:INFY", "1m"]);
    expect(r.candles).toHaveLength(2);
    expect(r.candles[0]).toMatchObject({ time: start, open: 10, high: 13, low: 9, close: 12.5, volume: 300 });
  });
});

describe("MarketDataService falls back to backup sources", () => {
  function noBrokerMarket(backupData) {
    const accounts = createFakeAccountManager({ accounts: [] });
    const m = buildMarket({ accountManager: accounts });
    const md = createMarketDataService({ ...m.deps, accounts, backupData });
    return { ...m, md };
  }

  it("serves an unpinned read with allowBackup, labelled source backup", async () => {
    const { svc } = service({ providers: { yahoo: stubProvider("yahoo", { quote: 321 }), nse: stubProvider("nse", { quote: 25000 }) } });
    const { md } = noBrokerMarket(svc);
    const r = await md.quotes(["NSE:RELIANCE", "NFO:NIFTY-2026-10-27-FUT"], { allowBackup: true });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ symbol: "NSE:RELIANCE", ltp: 321 });
    // No backup source has Indian futures: the broker's error stands.
    expect(r.errors).toEqual([expect.objectContaining({ symbol: "NFO:NIFTY-2026-10-27-FUT", code: "BROKER_UNAVAILABLE" })]);
    expect(r.items[0].freshness).toMatchObject({ source: "backup", provider: "yahoo", accountId: null, broker: null, stale: true });
    expect(r.items[0].freshness.ageMs).toBe(5000);
  });

  it("never falls back without allowBackup (orders, paper and safety reads)", async () => {
    const yahoo = stubProvider("yahoo");
    const { svc } = service({ providers: { yahoo, nse: stubProvider("nse") } });
    const { md } = noBrokerMarket(svc);
    const r = await md.ltp(["NSE:RELIANCE"]);
    expect(r.items).toEqual([]);
    expect(r.errors[0].code).toBe("BROKER_UNAVAILABLE");
    expect(yahoo.calls).toHaveLength(0);
  });

  it("never falls back for a pinned read", async () => {
    const yahoo = stubProvider("yahoo");
    const { svc } = service({ providers: { yahoo, nse: stubProvider("nse") } });
    const m = buildMarket();
    const md = createMarketDataService({ ...m.deps, backupData: svc });
    m.scheduler.throttle("zerodha-main", "quote", 60_000);
    const r = await m.settle(md.ltp(["NSE:RELIANCE"], { accountId: "zerodha-main", allowBackup: true }));
    expect(r.items).toEqual([]);
    expect(yahoo.calls).toHaveLength(0);
  });

  it("history and option chains fall back too", async () => {
    const nse = stubProvider("nse");
    const { svc } = service({ providers: { yahoo: stubProvider("yahoo"), nse } });
    const { md } = noBrokerMarket(svc);
    const h = await md.history({ symbol: "NSE:INFY", interval: "1d", countback: 5 }, { allowBackup: true });
    expect(h.freshness).toMatchObject({ source: "backup", provider: "yahoo" });
    const chain = await md.optionChain({ underlying: "NIFTY", expiry: "2026-10-27" }, { allowBackup: true });
    expect(chain.freshness).toMatchObject({ source: "backup", provider: "nse" });
    expect(chain.underlyingLtp).toBe(25010);
    expect(chain.rows[0].ce.symbol).toBe("NFO:NIFTY-2026-10-27-25000-CE");
    expect(chain.rows[0].ce.greeksSource).toBe("computed");
    const ex = await md.expiries("BANKNIFTY", { allowBackup: true });
    expect(ex.expiries).toEqual(["2026-10-27", "2026-11-03"]);
  });
});
