// PR 17's watchlist helpers that stay in analytics (the lists themselves moved to server/bridge/watchlists, whose
// aliases.test.mjs covers the /v1/analytics/watchlists routes).
import { describe, expect, it } from "vitest";
import { createFakeMarketData } from "../market/fake.mjs";
import { QUOTE_CHUNK, normaliseSymbol, quotesFor } from "./watchlist.mjs";

describe("normaliseSymbol", () => {
  it("reads a bare name as NSE (BSE for the BSE indices) and names the field on a bad symbol", () => {
    expect(normaliseSymbol("reliance", "s.0")).toBe("NSE:RELIANCE");
    expect(normaliseSymbol("NSE:NIFTY", "s.0")).toBe("NSE:NIFTY");
    expect(() => normaliseSymbol("", "symbols.2")).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
});

describe("quotesFor", () => {
  it("returns day fields in list order, with per-symbol errors and freshness", async () => {
    const md = createFakeMarketData({});
    md.setQuote("NSE:HDFCBANK", { ltp: 1700, close: 1680, high: 1710, low: 1675, open: 1685, volume: 5_000_000, oi: 0 });
    md.setQuote("NSE:SBIN", { ltp: 800, close: 810, high: 812, low: 795, volume: 9_000_000 });
    md.fail("NSE:INFY", "UPSTREAM_ERROR");
    const r = await quotesFor(md, ["NSE:SBIN", "NSE:INFY", "NSE:HDFCBANK", "NSE:NOPRICE"]);
    expect(r.items.map((i) => i.symbol)).toEqual(["NSE:SBIN", "NSE:HDFCBANK"]);
    expect(r.items[1]).toMatchObject({ ltp: 1700, change: 20, dayHigh: 1710, dayLow: 1675, volume: 5_000_000, prevClose: 1680 });
    expect(r.errors.map((e) => [e.symbol, e.code])).toEqual([["NSE:INFY", "UPSTREAM_ERROR"], ["NSE:NOPRICE", "SYMBOL_NOT_FOUND"]]);
    expect(r.stale).toBe(false);
  });

  it("batches into chunks, and a failed chunk only fills errors", async () => {
    const md = createFakeMarketData({});
    const syms = Array.from({ length: QUOTE_CHUNK + 10 }, (_, i) => `NSE:S${i}`);
    for (const s of syms) md.setQuote(s, { ltp: 10 });
    const r = await quotesFor(md, syms);
    expect(r.items).toHaveLength(syms.length);
    expect(md.calls.filter((c) => c[0] === "quotes").map((c) => c[1].length)).toEqual([QUOTE_CHUNK, 10]);
    const orig = md.quotes;
    let n = 0;
    md.quotes = async (...a) => {
      if (n++ === 1) throw new Error("boom with secrets");
      return orig(...a);
    };
    const r2 = await quotesFor(md, syms);
    expect(r2.items).toHaveLength(QUOTE_CHUNK);
    expect(r2.errors[0]).toEqual({ symbol: syms[QUOTE_CHUNK], code: "INTERNAL", message: "The quote read failed." });
  });
});
