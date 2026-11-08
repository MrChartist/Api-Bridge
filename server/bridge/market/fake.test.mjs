/**
 * The published in-memory MarketDataService (fake.mjs) other modules test against: contract shape, deterministic
 * data, per-item errors, call recording.
 */
import { describe, expect, it } from "vitest";
import { assertService } from "../core/contracts.mjs";
import { createFakeMarketData } from "./fake.mjs";

const clock = { now: () => Date.parse("2026-10-19T10:00:00+05:30") };

describe("createFakeMarketData", () => {
  it("satisfies the contract", () => {
    expect(() => assertService("marketData", createFakeMarketData())).not.toThrow();
  });

  it("answers ltp and quotes with Freshness, per-item errors and recorded calls", async () => {
    const md = createFakeMarketData({ prices: { "NSE:NIFTY": 25010, "nse:reliance": 1400 }, clock });
    md.setQuote("NSE:INFY", { ltp: 1500, close: 1480, bid: 1499.9, ask: 1500.1 });
    md.fail("NSE:RELIANCE", "UPSTREAM_RATE_LIMITED");
    const r = await md.ltp(["NSE:NIFTY", "NSE:RELIANCE", "NSE:TCS", "bad sym", "NSE:NIFTY"], { maxAgeMs: 0 });
    expect(r.items).toEqual([{ symbol: "NSE:NIFTY", ltp: 25010, freshness: { source: "broker", asOf: "2026-10-19T10:00:00.000+05:30", ageMs: 0, stale: false, accountId: "fake-1", broker: "fake" } }]);
    expect(r.errors.map((e) => [e.symbol, e.code])).toEqual([
      ["NSE:RELIANCE", "UPSTREAM_RATE_LIMITED"],
      ["NSE:TCS", "SYMBOL_NOT_FOUND"],
      ["bad sym", "VALIDATION_FAILED"],
    ]);
    const q = await md.quotes(["NSE:INFY"]);
    expect(q.items[0]).toMatchObject({ symbol: "NSE:INFY", ltp: 1500, change: 20, bid: 1499.9 });
    expect(md.calls[0]).toEqual(["ltp", ["NSE:NIFTY", "NSE:RELIANCE", "NSE:TCS", "bad sym", "NSE:NIFTY"], { maxAgeMs: 0 }]);
    md.setPrice("NSE:INFY", 1510);
    expect((await md.quotes(["NSE:INFY"])).items[0]).toMatchObject({ ltp: 1510, close: 1480 });
  });

  it("derives depth, serves set candles, expiries and chains", async () => {
    const md = createFakeMarketData({ prices: { "NSE:NIFTY": 25012 }, clock, source: "paper", accountId: null, broker: null });
    const d = await md.depth("NSE:NIFTY");
    expect(d).toMatchObject({ symbol: "NSE:NIFTY", bids: [{ price: 25012, qty: 100, orders: null }], freshness: { source: "paper", accountId: null } });
    md.setDepth("NSE:NIFTY", { bids: [{ price: 1, qty: 2 }], asks: [{ price: 3, qty: 4 }] });
    expect((await md.depth("NSE:NIFTY")).asks).toEqual([{ price: 3, qty: 4, orders: null }]);

    const t0 = Date.parse("2026-10-16T00:00:00+05:30") / 1000;
    md.setCandles("NSE:NIFTY", "1d", [1, 0, 2].map((i) => ({ time: t0 + i * 86_400, open: 1, high: 2, low: 0, close: 1, volume: 1 })));
    const h = await md.history({ symbol: "NSE:NIFTY", interval: "1d", countback: 2 });
    expect(h.candles.map((c) => c.time)).toEqual([t0 + 86_400, t0 + 2 * 86_400]);
    expect(h.partial).toBe(false);
    expect((await md.history({ symbol: "NSE:NIFTY", interval: "1d", from: "2026-10-17", to: "2026-10-17" })).candles).toHaveLength(1);
    await expect(md.history({ symbol: "NSE:NIFTY", interval: "5m", countback: 1 })).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND" });

    md.setExpiries("nifty", ["2026-10-27", "2026-10-20"]);
    expect((await md.expiries("NIFTY")).expiries).toEqual(["2026-10-20", "2026-10-27"]);
    await expect(md.expiries("BANKNIFTY")).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND" });

    const c = await md.optionChain({ underlying: "NIFTY", expiry: "2026-10-27", strikes: 2, greeks: false });
    expect(c).toMatchObject({ underlying: "NIFTY", underlyingLtp: 25012, atmStrike: 25000 });
    expect(c.rows.map((r) => r.strike)).toEqual([24900, 24950, 25000, 25050, 25100]);
    expect(c.rows[2].ce.symbol).toBe("NFO:NIFTY-2026-10-27-25000-CE");
    await expect(md.optionChain({ underlying: "SENSEX", expiry: "2026-10-22" })).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND" });
  });
});
