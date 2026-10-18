import { describe, expect, it } from "vitest";
import {
  detectFormat,
  formatSymbol,
  isCanonicalSymbol,
  normaliseStrike,
  parseOpenAlgo,
  parseSymbol,
  parseTradingView,
  toOpenAlgo,
  toTradingView,
} from "./symbolFormat.mjs";

describe("canonical symbols", () => {
  it.each([
    ["NSE:RELIANCE", { exchange: "NSE", kind: "EQ", underlying: "RELIANCE", expiry: null, strike: null, right: null }],
    ["NSE:NIFTY", { exchange: "NSE", kind: "INDEX", underlying: "NIFTY" }],
    ["BSE:SENSEX", { exchange: "BSE", kind: "INDEX", underlying: "SENSEX" }],
    ["NSE:BAJAJ-AUTO", { kind: "EQ", underlying: "BAJAJ-AUTO" }],
    ["NSE:M&M", { kind: "EQ", underlying: "M&M" }],
    ["NFO:NIFTY-2026-10-27-FUT", { exchange: "NFO", kind: "FUT", underlying: "NIFTY", expiry: "2026-10-27", strike: null }],
    ["NFO:NIFTY-2026-10-27-25000-CE", { exchange: "NFO", kind: "OPT", strike: 25000, right: "CE" }],
    ["BFO:SENSEX-2026-10-30-82500-PE", { exchange: "BFO", kind: "OPT", strike: 82500, right: "PE" }],
    ["NFO:VEDL-2026-10-27-292.5-CE", { kind: "OPT", strike: 292.5 }],
    ["NFO:BAJAJ-AUTO-2026-10-27-9000-CE", { underlying: "BAJAJ-AUTO", strike: 9000 }],
    ["MCX:CRUDEOIL-2026-11-19-FUT", { exchange: "MCX", kind: "FUT" }],
    ["CDS:USDINR-2026-10-29-83.25-CE", { exchange: "CDS", strike: 83.25 }],
  ])("parses %s and round-trips", (s, expected) => {
    const p = parseSymbol(s);
    expect(p).toMatchObject(expected);
    expect(p.canonical).toBe(s);
    expect(formatSymbol(p)).toBe(s);
    expect(isCanonicalSymbol(s)).toBe(true);
  });

  it("lenient input: case, spaces and the venue form for derivatives", () => {
    expect(parseSymbol("  nse:reliance ").canonical).toBe("NSE:RELIANCE");
    expect(parseSymbol("NSE:NIFTY-2026-10-27-25000-CE").canonical).toBe("NFO:NIFTY-2026-10-27-25000-CE");
    expect(parseSymbol("BSE:SENSEX-2026-10-30-FUT").canonical).toBe("BFO:SENSEX-2026-10-30-FUT");
    expect(parseSymbol("NFO:NIFTY-2026-10-27-25000.0-CE").canonical).toBe("NFO:NIFTY-2026-10-27-25000-CE");
  });

  it("strict mode refuses non-canonical spellings", () => {
    expect(isCanonicalSymbol("nse:reliance")).toBe(false);
    expect(isCanonicalSymbol("NSE:NIFTY-2026-10-27-FUT")).toBe(false);
    expect(isCanonicalSymbol("NFO:NIFTY-2026-10-27-25000.0-CE")).toBe(false);
    expect(() => parseSymbol("NFO:NIFTY-2026-10-27-025000-CE", { lenient: false })).toThrow(/canonical form/);
  });

  it.each([
    "",
    "RELIANCE",
    "XYZ:RELIANCE",
    "NFO:RELIANCE",
    "NSE:NIFTY-2026-02-30-FUT",
    "NFO:NIFTY-26-10-27-FUT",
    "NFO:NIFTY-2026-10-27-0-CE",
    "NFO:NIFTY-2026-10-27-25000-XE",
    "NSE:-BAD",
    "NSE:BAD-",
    "NSE:RELIANCE/../x",
    `NSE:${"A".repeat(70)}`,
  ])("rejects %s", (s) => {
    expect(() => parseSymbol(s)).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("formatSymbol enforces exchange/kind rules", () => {
    expect(() => formatSymbol({ exchange: "NFO", underlying: "RELIANCE", kind: "EQ" })).toThrow(/cash/);
    expect(() => formatSymbol({ exchange: "NSE", underlying: "NIFTY", kind: "FUT", expiry: "2026-10-27" })).toThrow(/Derivatives/);
    expect(() => formatSymbol({ exchange: "NFO", underlying: "NIFTY", kind: "OPT", expiry: "2026-10-27", strike: 25000, right: "C" })).toThrow(/CE or PE/);
    expect(formatSymbol({ exchange: "nfo", underlying: "nifty", expiry: "2026-10-27", strike: "25000", right: "pe" })).toBe("NFO:NIFTY-2026-10-27-25000-PE");
  });

  it("normalises strikes", () => {
    expect(normaliseStrike(25000)).toBe("25000");
    expect(normaliseStrike(292.5)).toBe("292.5");
    expect(normaliseStrike("83.2500")).toBe("83.25");
    expect(() => normaliseStrike(0)).toThrow();
    expect(() => normaliseStrike(1.123456)).toThrow(/4 decimal/);
    expect(() => normaliseStrike(Number.NaN)).toThrow();
  });
});

describe("TradingView aliases", () => {
  it("maps cash and index tickers directly", () => {
    expect(parseTradingView("NSE:RELIANCE").canonical).toBe("NSE:RELIANCE");
    expect(parseTradingView("nse:nifty")).toMatchObject({ canonical: "NSE:NIFTY", kind: "INDEX" });
  });

  it("leaves continuous futures for SymbolService to resolve", () => {
    expect(parseTradingView("NSE:NIFTY1!")).toEqual({ canonical: null, exchange: "NFO", underlying: "NIFTY", kind: "FUT", continuous: 1 });
  });

  it("parses option tickers and formats them back", () => {
    const p = parseTradingView("NSE:NIFTY261027C25000");
    expect(p.canonical).toBe("NFO:NIFTY-2026-10-27-25000-CE");
    expect(toTradingView(p.canonical)).toBe("NSE:NIFTY261027C25000");
    expect(toTradingView("NSE:SBIN")).toBe("NSE:SBIN");
    expect(toTradingView("NFO:NIFTY-2026-10-27-FUT")).toBeNull();
  });

  it("round-trips TradingView's '_' spelling of '-' and '&' (NSE:M_M, NSE:BAJAJ_AUTO)", () => {
    expect(toTradingView("NSE:M&M")).toBe("NSE:M_M");
    expect(parseTradingView("NSE:M_M").canonical).toBe("NSE:M&M");
    expect(toTradingView("NSE:BAJAJ-AUTO")).toBe("NSE:BAJAJ_AUTO");
    expect(parseTradingView("NSE:BAJAJ_AUTO").canonical).toBe("NSE:BAJAJ-AUTO");
    expect(parseTradingView("NSE:M_MFIN").canonical).toBe("NSE:M&MFIN");
    expect(parseTradingView("NSE:M&M").canonical).toBe("NSE:M&M");
    for (const c of ["NSE:M&M", "NSE:BAJAJ-AUTO", "NSE:J&KBANK", "NSE:RELIANCE"]) expect(parseTradingView(toTradingView(c)).canonical).toBe(c);
    const opt = parseTradingView("NSE:M_M261027C3000");
    expect(opt.underlying).toBe("M&M");
    expect(toTradingView(opt.canonical)).toBe("NSE:M_M261027C3000");
  });

  it("maps index names TradingView spells differently (needs verification)", () => {
    expect(parseTradingView("NSE:CNXFINANCE")).toMatchObject({ canonical: "NSE:FINNIFTY", kind: "INDEX" });
    expect(toTradingView("NSE:FINNIFTY")).toBe("NSE:CNXFINANCE");
    expect(parseTradingView("NSE:NIFTY_MID_SELECT").canonical).toBe("NSE:MIDCPNIFTY");
    expect(toTradingView("NSE:MIDCPNIFTY")).toBe("NSE:NIFTY_MID_SELECT");
  });

  it("rejects junk", () => {
    expect(() => parseTradingView("NIFTY")).toThrow();
    expect(() => parseTradingView("FOO:NIFTY")).toThrow();
  });
});

describe("OpenAlgo-style aliases (format only)", () => {
  it.each([
    ["NIFTY27OCT2625000CE", "NFO", "NFO:NIFTY-2026-10-27-25000-CE"],
    ["NIFTY27OCT26FUT", "NFO", "NFO:NIFTY-2026-10-27-FUT"],
    ["VEDL27OCT26292.5CE", "NFO", "NFO:VEDL-2026-10-27-292.5-CE"],
    ["SENSEX30OCT2682500PE", "BFO", "BFO:SENSEX-2026-10-30-82500-PE"],
    ["RELIANCE", "NSE", "NSE:RELIANCE"],
    ["NIFTY", "NSE_INDEX", "NSE:NIFTY"],
  ])("%s on %s -> %s and back", (sym, ex, canonical) => {
    expect(parseOpenAlgo(sym, ex).canonical).toBe(canonical);
    const back = toOpenAlgo(canonical);
    expect(parseOpenAlgo(back.symbol, back.exchange).canonical).toBe(canonical);
  });

  it("rejects unknown exchanges", () => {
    expect(() => parseOpenAlgo("NIFTY", "NASDAQ")).toThrow(/Unknown exchange/);
  });
});

describe("detectFormat", () => {
  it("tells formats apart", () => {
    expect(detectFormat("NFO:NIFTY-2026-10-27-FUT")).toBe("canonical");
    expect(detectFormat("NSE:NIFTY1!")).toBe("tradingview");
    expect(detectFormat("NSE:NIFTY261027C25000")).toBe("tradingview");
    expect(detectFormat("NIFTY27OCT26FUT", "NFO")).toBe("openalgo");
    expect(detectFormat("??")).toBe("unknown");
  });
});
