import { describe, expect, it } from "vitest";
import { canonicalIndexName, cleanStrike, extractIsin, kindFromInstrumentType, mapContractRow } from "./aliases.mjs";
import { freezeEntryFor, INDEX_FREEZE_QUANTITIES } from "./freezeQuantities.mjs";
import { istDay, istTimeOnDay, toIstIso } from "./ist.mjs";

const row = (over) => ({ token: "1", exchange: "NSE", tradingSymbol: "X", underlying: "X", instrumentType: "EQ", expiry: null, strike: null, optionType: null, lotSize: 1, tickSize: 0.05, ...over });

describe("index names", () => {
  it.each([
    ["NIFTY 50", "NIFTY"],
    ["Nifty 50", "NIFTY"],
    ["NIFTY BANK", "BANKNIFTY"],
    ["NIFTY  FIN SERVICE", "FINNIFTY"],
    ["NIFTY MID SELECT", "MIDCPNIFTY"],
    ["NIFTY NEXT 50", "NIFTYNXT50"],
    ["INDIA VIX", "INDIAVIX"],
    ["S&P BSE SENSEX", "SENSEX"],
    ["SENSEX", "SENSEX"],
    ["NIFTY IT", "NIFTYIT"],
    ["Nifty Pharma", "NIFTYPHARMA"],
  ])("%s -> %s", (name, expected) => {
    expect(canonicalIndexName(name)).toBe(expected);
  });

  it("gives null when nothing usable remains", () => {
    expect(canonicalIndexName("")).toBeNull();
    expect(canonicalIndexName("   ")).toBeNull();
    expect(canonicalIndexName("()")).toBeNull();
  });
});

describe("mapContractRow", () => {
  it("maps Zerodha's 'NIFTY 50' index row to NSE:NIFTY", () => {
    expect(mapContractRow(row({ token: "256265", tradingSymbol: "NIFTY 50", underlying: "NIFTY 50", instrumentType: "INDEX" }))).toMatchObject({
      canonical: "NSE:NIFTY",
      kind: "INDEX",
      underlying: "NIFTY",
      ref: { token: "256265", exchange: "NSE", tradingSymbol: "NIFTY 50" },
    });
  });

  it("strips the -EQ series tag and reads an ISIN from an Upstox-style key", () => {
    const m = mapContractRow(row({ token: "NSE_EQ|INE002A01018", tradingSymbol: "RELIANCE-EQ", underlying: "RELIANCE-EQ", tickSize: 0.1 }));
    expect(m).toMatchObject({ canonical: "NSE:RELIANCE", kind: "EQ", isin: "INE002A01018", tickSize: 0.1 });
  });

  it("keeps names with '-' and '&'", () => {
    expect(mapContractRow(row({ underlying: "BAJAJ-AUTO" })).canonical).toBe("NSE:BAJAJ-AUTO");
    expect(mapContractRow(row({ underlying: "M&M" })).canonical).toBe("NSE:M&M");
  });

  it("maps futures and options, moving a venue-tagged derivative to its segment", () => {
    expect(mapContractRow(row({ exchange: "NFO", underlying: "BANKNIFTY", instrumentType: "FUTIDX", expiry: "2026-10-27", lotSize: 30, tickSize: 0.2 }))).toMatchObject({
      canonical: "NFO:BANKNIFTY-2026-10-27-FUT",
      lotSize: 30,
    });
    const opt = mapContractRow(row({ exchange: "BSE", underlying: "SENSEX", instrumentType: "OPTIDX", expiry: "2026-10-22", strike: 82000, optionType: "CE", lotSize: 20 }));
    expect(opt).toMatchObject({ canonical: "BFO:SENSEX-2026-10-22-82000-CE", exchange: "BFO", ref: { exchange: "BSE" } });
  });

  it("cleans float noise from strikes", () => {
    const m = mapContractRow(row({ exchange: "NFO", underlying: "VEDL", instrumentType: "OPTSTK", expiry: "2026-10-27", strike: 292.50000000001, optionType: "CE", lotSize: 1150 }));
    expect(m.canonical).toBe("NFO:VEDL-2026-10-27-292.5-CE");
    expect(cleanStrike("83.2500")).toBe(83.25);
    expect(cleanStrike(0)).toBeNull();
  });

  it("returns null lot/tick sizes for unusable values instead of guessing", () => {
    const m = mapContractRow(row({ lotSize: 0, tickSize: -1 }));
    expect(m.lotSize).toBeNull();
    expect(m.tickSize).toBeNull();
    expect(mapContractRow(row({ lotSize: 1.5 })).lotSize).toBeNull();
  });

  it("uses optional master fields (name, freezeQty, isin)", () => {
    expect(mapContractRow(row({ name: " Reliance Industries ", isin: "ine002a01018" }))).toMatchObject({ name: "Reliance Industries", isin: "INE002A01018" });
    expect(mapContractRow(row({ exchange: "NFO", underlying: "NIFTY", instrumentType: "FUTIDX", expiry: "2026-10-27", freezeQty: 1755 })).freezeQty).toBe(1755);
  });

  it.each([
    [{ token: "" }, /no token/],
    [{ exchange: "NCDEX" }, /unknown exchange/],
    [{ instrumentType: "BOND" }, /instrumentType/],
    [{ exchange: "MCX", instrumentType: "INDEX" }, /index on MCX/],
    [{ exchange: "NFO", instrumentType: "EQ" }, /cash row/],
    [{ exchange: "NFO", instrumentType: "FUTIDX", expiry: "27-10-2026" }, /ISO expiry/],
    [{ exchange: "NFO", instrumentType: "OPTIDX", expiry: "2026-10-27", strike: 25000, optionType: "XX" }, /strike or CE\/PE/],
    [{ underlying: "BAD NAME!" }, /unusable underlying/],
  ])("skips unusable rows %#", (over, reason) => {
    const m = mapContractRow(row(over));
    expect(m).toHaveProperty("skip");
    expect(m.skip).toMatch(reason);
  });

  it("knows the instrument types", () => {
    expect(["INDEX", "EQ", "FUTIDX", "FUTSTK", "FUTCOM", "OPTIDX", "OPTSTK", "OPTFUT", "x"].map(kindFromInstrumentType)).toEqual(["INDEX", "EQ", "FUT", "FUT", "FUT", "OPT", "OPT", "OPT", null]);
    expect(extractIsin({ token: "2885" })).toBeNull();
  });
});

describe("freeze list", () => {
  it("covers index derivatives only and is marked unverified", () => {
    expect(freezeEntryFor({ exchange: "NFO", kind: "OPT", underlying: "NIFTY" })).toMatchObject({ freezeQty: expect.any(Number), verified: false });
    expect(freezeEntryFor({ exchange: "NFO", kind: "OPT", underlying: "RELIANCE" })).toBeNull();
    expect(freezeEntryFor({ exchange: "NSE", kind: "INDEX", underlying: "NIFTY" })).toBeNull();
    for (const e of Object.values(INDEX_FREEZE_QUANTITIES)) {
      expect(e.verified).toBe(false);
      expect(e.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("IST helpers", () => {
  it("rolls the day at IST midnight, not UTC", () => {
    expect(istDay(Date.parse("2026-10-17T18:29:59Z"))).toBe("2026-10-17");
    expect(istDay(Date.parse("2026-10-17T18:30:00Z"))).toBe("2026-10-18");
  });

  it("finds HH:MM IST on the same IST day", () => {
    const at = Date.parse("2026-10-18T01:00:00+05:30");
    expect(istTimeOnDay(at, "08:30")).toBe(Date.parse("2026-10-18T08:30:00+05:30"));
    expect(() => istTimeOnDay(at, "8:30")).toThrow();
    expect(toIstIso(Date.parse("2026-10-18T03:45:00Z"))).toBe("2026-10-18T09:15:00.000+05:30");
  });
});
