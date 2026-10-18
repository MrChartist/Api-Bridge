import { describe, expect, it } from "vitest";
import { parseIntegrationsConfig } from "./config.mjs";
import { describe as describeInstrument, historyBody, priceFormat, quoteValues, resolutionToInterval, shortName, symbolInfo, toUdfBars, udfConfig } from "./udf.mjs";
import { istAt } from "./__fixtures__/fakes.mjs";

const cfg = parseIntegrationsConfig({});
const ALL = cfg.udf.supportedResolutions;

describe("resolutionToInterval", () => {
  it("maps every UDF resolution", () => {
    expect(["1", "3", "5", "10", "15", "30", "60", "1D", "1W", "1M"].map((r) => resolutionToInterval(r, ALL))).toEqual(["1m", "3m", "5m", "10m", "15m", "30m", "60m", "1d", "1w", "1M"]);
  });
  it("accepts the short D/W/M spellings", () => {
    expect(resolutionToInterval("D", ALL)).toBe("1d");
    expect(resolutionToInterval("d", ALL)).toBe("1d");
    expect(resolutionToInterval("1d", ALL)).toBe("1d");
    expect(resolutionToInterval("W", ALL)).toBe("1w");
    expect(resolutionToInterval("M", ALL)).toBe("1M");
  });
  it("refuses unsupported or unconfigured resolutions", () => {
    expect(() => resolutionToInterval("240", ALL)).toThrow(/not supported/);
    expect(() => resolutionToInterval("1S", ALL)).toThrow(/not supported/);
    expect(() => resolutionToInterval("", ALL)).toThrow(/not supported/);
    expect(() => resolutionToInterval("m", ALL)).toThrow(/not supported/); // lower-case m is never a month
    expect(() => resolutionToInterval("1", ["5", "1D"])).toThrow(/Use one of 5, 1D/);
  });
});

describe("priceFormat", () => {
  it.each([
    [0.05, 5, 100],
    [0.1, 1, 10],
    [0.01, 1, 100],
    [1, 1, 1],
    [0.0025, 25, 10000],
    [0.25, 25, 100],
    [5, 5, 1],
  ])("tick %s -> minmov %s / pricescale %s", (tick, minmov, pricescale) => {
    expect(priceFormat(tick)).toEqual({ minmov, pricescale });
  });
  it("falls back for nonsense ticks", () => {
    expect(priceFormat(0)).toEqual({ minmov: 1, pricescale: 100 });
    expect(priceFormat(NaN)).toEqual({ minmov: 1, pricescale: 100 });
  });
});

describe("symbolInfo", () => {
  const base = { exchange: "NFO", kind: "OPT", underlying: "NIFTY", expiry: "2026-10-27", strike: 25000, right: "CE", name: null, lotSize: 75, tickSize: 0.05, freezeQty: 1800, isin: null, refs: {} };
  it("builds LibrarySymbolInfo with IST session and tick-derived price format", () => {
    const info = symbolInfo({ ...base, canonical: "NFO:NIFTY-2026-10-27-25000-CE" }, cfg.udf, istAt("2026-10-16", 15));
    expect(info).toMatchObject({
      name: "NIFTY-2026-10-27-25000-CE",
      ticker: "NFO:NIFTY-2026-10-27-25000-CE",
      description: "NIFTY 27 Oct 2026 25000 CE",
      type: "option",
      session: "0915-1530",
      timezone: "Asia/Kolkata",
      exchange: "NFO",
      minmov: 5,
      pricescale: 100,
      has_intraday: true,
      has_daily: true,
      has_weekly_and_monthly: true,
      intraday_multipliers: ["1", "3", "5", "10", "15", "30", "60"],
      currency_code: "INR",
      lot_size: 75,
      expired: false,
      expiration_date: istAt("2026-10-27", 15, 30),
    });
  });
  it("marks expired contracts and uses configured sessions", () => {
    const c = parseIntegrationsConfig({ udf: { sessions: { MCX: "0900-2355" } } });
    const info = symbolInfo({ ...base, exchange: "MCX", kind: "FUT", underlying: "CRUDEOIL", strike: null, right: null, tickSize: 1, canonical: "MCX:CRUDEOIL-2026-10-19-FUT", expiry: "2026-10-19" }, c.udf, istAt("2026-10-20"));
    expect(info.session).toBe("0900-2355");
    expect(info.expired).toBe(true);
    expect(info.type).toBe("futures");
    expect(info.description).toBe("CRUDEOIL 19 Oct 2026 FUT");
  });
  it("indices plot OHLC only and use the master name", () => {
    const info = symbolInfo({ ...base, canonical: "NSE:NIFTY", exchange: "NSE", kind: "INDEX", expiry: null, strike: null, right: null, name: "NIFTY 50" }, cfg.udf, 0);
    expect(info).toMatchObject({ type: "index", visible_plots_set: "ohlc", description: "NIFTY 50", name: "NIFTY" });
    expect(info.expired).toBeUndefined();
  });
  it("follows the configured resolutions", () => {
    const c = parseIntegrationsConfig({ udf: { supportedResolutions: ["1D", "1W"] } });
    const info = symbolInfo({ ...base, canonical: "NSE:NIFTY", exchange: "NSE", kind: "INDEX", expiry: null }, c.udf, 0);
    expect(info.has_intraday).toBe(false);
    expect(info.has_weekly_and_monthly).toBe(true);
    expect(info.supported_resolutions).toEqual(["1D", "1W"]);
  });
});

describe("toUdfBars", () => {
  const c = (time, close = 1) => ({ time, open: 1, high: 2, low: 0.5, close, volume: 10 });
  it("keeps [from, to) for intraday", () => {
    const t0 = istAt("2026-10-16", 9, 15);
    const bars = toUdfBars([c(t0), c(t0 + 300), c(t0 + 600)], { interval: "5m", from: t0, to: t0 + 600 });
    expect(bars.map((b) => b.time)).toEqual([t0, t0 + 300]);
  });
  it("countback wins over from and counts back from to", () => {
    const t0 = istAt("2026-10-16", 9, 15);
    const bars = toUdfBars([c(t0), c(t0 + 300), c(t0 + 600), c(t0 + 900)], { interval: "5m", from: t0 + 900, to: t0 + 900, countback: 2 });
    expect(bars.map((b) => b.time)).toEqual([t0 + 300, t0 + 600]);
  });
  it("restamps daily bars at 00:00 UTC of the IST date (from IST midnight or 09:15)", () => {
    const bars = toUdfBars([c(istAt("2026-10-15")), c(istAt("2026-10-16", 9, 15))], { interval: "1d", from: 0, to: Date.UTC(2026, 9, 17) / 1000 });
    expect(bars.map((b) => b.time)).toEqual([Date.UTC(2026, 9, 15) / 1000, Date.UTC(2026, 9, 16) / 1000]);
  });
  it("de-duplicates bars that land on the same date and sorts", () => {
    const bars = toUdfBars([c(istAt("2026-10-16", 9, 15), 2), c(istAt("2026-10-15")), c(istAt("2026-10-16"), 3)], { interval: "1d", from: 0, to: 2e9 });
    expect(bars.map((b) => b.close)).toEqual([1, 3]);
  });
});

describe("bodies", () => {
  it("historyBody uses column arrays and no_data when empty", () => {
    expect(historyBody([])).toEqual({ s: "no_data" });
    expect(historyBody([{ time: 1, open: 2, high: 3, low: 1, close: 2.5, volume: undefined }])).toEqual({ s: "ok", t: [1], o: [2], h: [3], l: [1], c: [2.5], v: [0] });
  });
  it("quoteValues maps fields and drops nulls", () => {
    const v = quoteValues({ symbol: "NSE:NIFTY", ltp: 25000, change: 10, changePct: 0.04, open: 1, high: 2, low: 0, close: 24990, volume: null, bid: null, ask: 25000.1 });
    expect(v).toEqual({ short_name: "NIFTY", exchange: "NSE", description: "NSE:NIFTY", lp: 25000, ch: 10, chp: 0.04, open_price: 1, high_price: 2, low_price: 0, prev_close_price: 24990, ask: 25000.1 });
  });
  it("udfConfig advertises search, time and the configured resolutions", () => {
    const c = udfConfig(cfg.udf);
    expect(c).toMatchObject({ supports_search: true, supports_group_request: false, supports_time: true, supports_marks: false });
    expect(c.supported_resolutions).toEqual(ALL);
    expect(c.exchanges.map((e) => e.value)).toEqual(["", "NSE", "BSE", "NFO", "BFO", "MCX", "CDS"]);
  });
  it("names", () => {
    expect(shortName("NSE:M&M")).toBe("M&M");
    expect(describeInstrument({ underlying: "VEDL", expiry: "2026-10-27", kind: "OPT", strike: 292.5, right: "PE" })).toBe("VEDL 27 Oct 2026 292.5 PE");
  });
});
