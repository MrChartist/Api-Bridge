import { describe, expect, it } from "vitest";
import { AMIBROKER_EOD_COLUMNS, AMIBROKER_INTRADAY_COLUMNS, CHAIN_COLUMNS, amibrokerRows, amibrokerTicker, asOfCell, chainRecords, fitRows, formatNumber, guardCell, historyRows } from "./xl.mjs";
import { istAt } from "./__fixtures__/fakes.mjs";

describe("formatNumber", () => {
  it.each([
    [25012.35, "25012.35"],
    [100, "100"],
    [-3.5, "-3.5"],
    [0.1 + 0.2, "0.3"],
    [88.1234, "88.1234"],
    [1e-7, "0.0000001"],
    [123456789012, "123456789012"],
  ])("%s -> %s", (n, s) => expect(formatNumber(n)).toBe(s));
  it("null for non-numbers", () => {
    for (const v of [null, undefined, NaN, Infinity, "12"]) expect(formatNumber(v)).toBeNull();
  });
});

describe("guardCell", () => {
  it("prefixes text that a spreadsheet would evaluate", () => {
    for (const s of ["=HYPERLINK(\"x\")", "+cmd", "-2+3", "@SUM(A1)", "\tx", "\rx"]) expect(guardCell(s)).toBe(`'${s}`);
  });
  it("leaves numbers, numeric text and safe text alone", () => {
    for (const v of [12, -3, "-3.5", "NSE:M&M", null, true]) expect(guardCell(v)).toBe(v);
  });
});

describe("amibrokerTicker", () => {
  it.each([
    ["NSE:RELIANCE", "RELIANCE"],
    ["NSE:M&M", "M&M"],
    ["NFO:NIFTY-2026-10-27-FUT", "NIFTY-2026-10-27-FUT"],
    ["BSE:RELIANCE", "RELIANCE.BSE"],
    ["BFO:SENSEX-2026-10-30-82500-PE", "SENSEX-2026-10-30-82500-PE.BFO"],
    ["MCX:CRUDEOIL-2026-11-19-FUT", "CRUDEOIL-2026-11-19-FUT"],
  ])("%s -> %s (never a colon: AmiBroker stores symbols as file names)", (c, t) => {
    expect(amibrokerTicker(c)).toBe(t);
    expect(amibrokerTicker(c)).not.toContain(":");
  });
});

describe("rows", () => {
  const t = istAt("2026-10-16", 9, 15);
  const candles = [{ time: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, oi: 7 }];
  it("standard intraday rows carry IST date-times; daily rows carry the IST date", () => {
    expect(historyRows(candles, "5m")).toEqual([["2026-10-16 09:15:00", 1, 2, 0.5, 1.5, 10, 7]]);
    expect(historyRows([{ ...candles[0], time: istAt("2026-10-16"), oi: undefined }], "1d")).toEqual([["2026-10-16", 1, 2, 0.5, 1.5, 10, null]]);
  });
  it("AmiBroker rows match the shipped column layouts", () => {
    const intraday = amibrokerRows(candles, "5m", "NIFTY");
    expect(intraday[0]).toHaveLength(AMIBROKER_INTRADAY_COLUMNS.length);
    expect(intraday[0]).toEqual(["NIFTY", "2026-10-16", "09:15:00", 1, 2, 0.5, 1.5, 10, 7]);
    const eod = amibrokerRows(candles, "1d", "NIFTY");
    expect(eod[0]).toHaveLength(AMIBROKER_EOD_COLUMNS.length);
    expect(eod[0]).toEqual(["NIFTY", "2026-10-16", 1, 2, 0.5, 1.5, 10, 7]);
  });
  it("asOfCell converts ISO with offset to IST text", () => {
    expect(asOfCell("2026-10-16T09:30:00Z")).toBe("2026-10-16 15:00:00");
    expect(asOfCell("2026-10-16T15:00:00+05:30")).toBe("2026-10-16 15:00:00");
    expect(asOfCell(undefined)).toBeNull();
  });
});

describe("chainRecords", () => {
  it("flattens one row per strike with every column", () => {
    const chain = {
      underlying: "NIFTY",
      expiry: "2026-10-27",
      underlyingLtp: 25010,
      atmStrike: 25000,
      lotSize: 75,
      rows: [{ strike: 25000, ce: { symbol: "NFO:NIFTY-2026-10-27-25000-CE", ltp: 10, bid: null, ask: 11, oi: 5, oiChange: 1, volume: 2, iv: 12, delta: 0.5, gamma: 0.1, theta: -1, vega: 2 }, pe: null }],
      freshness: { source: "cache", asOf: "2026-10-16T15:00:00+05:30", ageMs: 1, stale: true },
    };
    const [r] = chainRecords(chain);
    expect(Object.keys(r)).toEqual(CHAIN_COLUMNS);
    expect(r).toMatchObject({ strike: 25000, atm: true, ce_ltp: 10, ce_bid: null, ce_oi_change: 1, pe_ltp: null, underlying_ltp: 25010, lot_size: 75, as_of: "2026-10-16 15:00:00", source: "cache", stale: true });
  });
});

describe("fitRows", () => {
  const rows = Array.from({ length: 10 }, (_, i) => i);
  it("returns everything when it fits", () => {
    expect(fitRows(5, rows, () => 10, 1000, (_r, i) => i)).toEqual({ rows, truncated: false });
  });
  it("keeps the best-ranked rows in original order", () => {
    const r = fitRows(5, rows, () => 10, 45, (_r, i) => -i); // newest first: room for 4
    expect(r).toEqual({ rows: [6, 7, 8, 9], truncated: true });
    const atm = fitRows(0, rows, () => 10, 30, (x) => Math.abs(x - 4));
    expect(atm.rows).toEqual([3, 4, 5]);
  });
});
