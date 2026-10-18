import { describe, expect, it } from "vitest";
import { createInstrumentStore, editDistance, nameScore, parseSearchText } from "./instrumentStore.mjs";
import { loadMaster } from "./__fixtures__/helpers.mjs";

const TODAY = "2026-10-18";
const eq = (token, underlying, over = {}) => ({ token, exchange: "NSE", tradingSymbol: underlying, underlying, instrumentType: "EQ", expiry: null, strike: null, optionType: null, lotSize: 1, tickSize: 0.05, ...over });
const opt = (token, underlying, expiry, strike, right, over = {}) => ({ token, exchange: "NFO", tradingSymbol: `${underlying}${strike}${right}`, underlying, instrumentType: "OPTIDX", expiry, strike, optionType: right, lotSize: 65, tickSize: 0.05, ...over });
const fut = (token, underlying, expiry, over = {}) => ({ token, exchange: "NFO", tradingSymbol: `${underlying}FUT${expiry}`, underlying, instrumentType: "FUTIDX", expiry, strike: null, optionType: null, lotSize: 65, tickSize: 0.1, ...over });

function storeWith(masters, order) {
  const s = createInstrumentStore();
  if (order) s.setBrokerOrder(order);
  for (const [b, rows] of Object.entries(masters)) s.setMaster(b, rows, { source: "test", day: TODAY }, TODAY);
  return s;
}

describe("merge across brokers", () => {
  it("one record per canonical symbol with a ref per broker", () => {
    const s = storeWith({ dhan: loadMaster("dhan"), zerodha: loadMaster("zerodha"), upstox: loadMaster("upstox"), angelone: loadMaster("angelone"), fyers: loadMaster("fyers") });
    const rec = s.get("NFO:NIFTY-2026-10-27-25000-CE", TODAY);
    expect(Object.keys(rec.refs).sort()).toEqual(["angelone", "dhan", "fyers", "upstox", "zerodha"]);
    expect(rec.refs.zerodha).toEqual({ token: "12010242", exchange: "NFO", tradingSymbol: "NIFTY26OCT25000CE" });
    expect(rec.refs.upstox.token).toBe("NSE_FO|51440");
    expect(rec).toMatchObject({ lotSize: 65, tickSize: 0.05, freezeQtySource: "exchange-list" });
    // Zerodha "NIFTY 50" and Upstox/Dhan "NIFTY" are the same index.
    expect(Object.keys(s.get("NSE:NIFTY", TODAY).refs).sort()).toEqual(["dhan", "upstox", "zerodha"]);
    // ISIN only from Upstox's key, merged into the shared record.
    expect(s.get("NSE:RELIANCE", TODAY)).toMatchObject({ isin: "INE002A01018", kind: "EQ" });
    expect(s.conflicts()).toEqual([]);
  });

  it("lot size comes from the first broker in order; a disagreement is recorded, never averaged", () => {
    const s = storeWith({ b: [fut("2", "NIFTY", "2026-10-27", { lotSize: 75 })], a: [fut("1", "NIFTY", "2026-10-27", { lotSize: 65 })] }, ["a", "b"]);
    expect(s.get("NFO:NIFTY-2026-10-27-FUT", TODAY).lotSize).toBe(65);
    expect(s.conflicts()).toEqual([{ canonical: "NFO:NIFTY-2026-10-27-FUT", field: "lotSize", values: { a: 65, b: 75 } }]);
  });

  it("tick size takes the coarser value; freeze quantity the smaller master value", () => {
    const s = storeWith({ a: [fut("1", "NIFTY", "2026-10-27", { tickSize: 0.05, freezeQty: 1800 })], b: [fut("2", "NIFTY", "2026-10-27", { tickSize: 0.1, freezeQty: 1755 })] }, ["a", "b"]);
    expect(s.get("NFO:NIFTY-2026-10-27-FUT", TODAY)).toMatchObject({ tickSize: 0.1, freezeQty: 1755, freezeQtySource: "master" });
  });

  it("corrects the kind of a cash symbol from the master (index vs equity)", () => {
    const s = storeWith({ a: [eq("26008", "NIFTY IT", { instrumentType: "INDEX" })] });
    expect(s.get("NSE:NIFTYIT", TODAY)).toMatchObject({ kind: "INDEX", underlying: "NIFTYIT" });
  });

  it("keeps a lot-size-less instrument for token mapping but out of search", () => {
    const s = storeWith({ a: [fut("9", "NIFTY", "2026-10-27", { lotSize: 0 })] });
    expect(s.get("NFO:NIFTY-2026-10-27-FUT", TODAY).lotSize).toBeNull();
    expect(s.byToken("a", "9")).toEqual(["NFO:NIFTY-2026-10-27-FUT"]);
    expect(s.search({ q: "nifty" }, TODAY)).toEqual([]);
    expect(s.futuresExpiries("NFO", "NIFTY", TODAY)).toEqual([]);
  });

  it("finds a derivative row tagged NSE by the broker under its canonical segment NFO too", () => {
    const s = storeWith({ a: [opt("43210", "NIFTY", "2026-10-27", 25000, "CE", { exchange: "NSE", tradingSymbol: "NIFTY26OCT25000CE" })] });
    const c = "NFO:NIFTY-2026-10-27-25000-CE";
    expect(s.get(c, TODAY).refs.a.exchange).toBe("NSE"); // the adapter still gets its own exchange code
    expect(s.byToken("a", "43210", "NSE")).toEqual([c]);
    expect(s.byToken("a", "43210", "NFO")).toEqual([c]);
    expect(s.byTradingSymbol("a", "NIFTY26OCT25000CE", "NFO")).toEqual([c]);
  });

  it("never lets a canonical-segment alias shadow a row that really is on that exchange", () => {
    const real = opt("777", "NIFTY", "2026-10-27", 25100, "CE");
    const tagged = opt("777", "BANKNIFTY", "2026-10-28", 56000, "PE", { exchange: "NSE", tradingSymbol: "BN56000PE" });
    for (const rows of [[real, tagged], [tagged, real]]) {
      const s = storeWith({ a: rows });
      expect(s.byToken("a", "777", "NFO")).toEqual(["NFO:NIFTY-2026-10-27-25100-CE"]);
      expect(s.byToken("a", "777", "NSE")).toEqual(["NFO:BANKNIFTY-2026-10-28-56000-PE"]);
    }
  });

  it("counts skipped, expired and duplicate rows", () => {
    const st = createInstrumentStore().setMaster("a", [eq("1", "A"), eq("1b", "A"), { token: "x", exchange: "XX" }, fut("2", "NIFTY", "2026-10-17")], {}, TODAY);
    expect(st).toMatchObject({ rows: 4, instruments: 1, duplicates: 1, skipped: 1, expired: 1 });
  });
});

describe("expiry", () => {
  it("drops expired contracts at build and refuses them at lookup after the day rolls", () => {
    const s = storeWith({ a: [fut("1", "NIFTY", "2026-10-20"), fut("2", "NIFTY", "2026-10-27"), opt("3", "NIFTY", "2026-10-17", 25000, "CE")] });
    expect(s.get("NFO:NIFTY-2026-10-17-25000-CE", TODAY)).toBeNull();
    expect(s.get("NFO:NIFTY-2026-10-20-FUT", "2026-10-20")).not.toBeNull(); // expiry day itself is live
    expect(s.get("NFO:NIFTY-2026-10-20-FUT", "2026-10-21")).toBeNull();
    expect(s.isExpired("NFO:NIFTY-2026-10-20-FUT", "2026-10-21")).toBe(true);
    expect(s.futuresExpiries("NFO", "NIFTY", "2026-10-21")).toEqual(["2026-10-27"]);
    const v = s.version();
    s.ensureDay("2026-10-21");
    expect(s.version()).toBe(v + 1);
    expect(s.byToken("a", "1")).toEqual([]); // reused tokens cannot point at an expired contract
  });
});

describe("token and trading-symbol indexes", () => {
  it("disambiguates with the exchange", () => {
    const s = storeWith({ z: [eq("500325", "RELIANCE", { exchange: "BSE" }), eq("500325", "OTHER")] });
    expect(s.byToken("z", "500325").sort()).toEqual(["BSE:RELIANCE", "NSE:OTHER"]);
    expect(s.byToken("z", "500325", "bse")).toEqual(["BSE:RELIANCE"]);
    expect(s.byTradingSymbol("z", "reliance")).toEqual(["BSE:RELIANCE"]);
    expect(s.byTradingSymbol("z", "RELIANCE", "NSE")).toEqual([]);
    expect(s.byToken("nobody", "1")).toEqual([]);
  });

  it("removes a broker", () => {
    const s = storeWith({ a: [eq("1", "A")], b: [eq("2", "A")] });
    expect(s.removeMaster("a", TODAY)).toBe(true);
    expect(Object.keys(s.get("NSE:A", TODAY).refs)).toEqual(["b"]);
    expect(s.removeMaster("a", TODAY)).toBe(false);
  });
});

describe("search", () => {
  const s = storeWith({
    a: [
      eq("1", "NIFTY", { instrumentType: "INDEX" }),
      eq("2", "NIFTY IT", { instrumentType: "INDEX" }),
      eq("3", "RELIANCE", { name: "Reliance Industries" }),
      eq("4", "RELIANCE", { exchange: "BSE" }),
      eq("5", "BANKNIFTY", { instrumentType: "INDEX" }),
      fut("6", "NIFTY", "2026-11-24"),
      fut("7", "NIFTY", "2026-10-27"),
      fut("8", "BANKNIFTY", "2026-10-27", { lotSize: 30 }),
      opt("9", "NIFTY", "2026-10-27", 25000, "CE"),
      opt("10", "NIFTY", "2026-10-27", 25000, "PE"),
      opt("11", "NIFTY", "2026-10-20", 25000, "CE"),
      opt("12", "NIFTY", "2026-10-20", 24950, "CE"),
      fut("13", "RELIANCE", "2026-10-27", { lotSize: 500, instrumentType: "FUTSTK" }),
    ],
  });
  const syms = (q, extra = {}) => s.search({ q, ...extra }, TODAY).map((r) => r.canonical);

  it("puts the exact underlying's spot first, then other spot names, then derivatives by expiry", () => {
    expect(syms("nifty").slice(0, 5)).toEqual(["NSE:NIFTY", "NSE:NIFTYIT", "NFO:NIFTY-2026-10-27-FUT", "NFO:NIFTY-2026-11-24-FUT", "NFO:NIFTY-2026-10-20-24950-CE"]);
  });

  it("understands strike, right, kind, month and exchange words", () => {
    expect(syms("nifty 25000 ce")).toEqual(["NFO:NIFTY-2026-10-20-25000-CE", "NFO:NIFTY-2026-10-27-25000-CE"]);
    expect(syms("banknifty fut")).toEqual(["NFO:BANKNIFTY-2026-10-27-FUT"]);
    expect(syms("nifty fut nov")).toEqual(["NFO:NIFTY-2026-11-24-FUT"]);
    expect(syms("reliance bse")).toEqual(["BSE:RELIANCE"]);
    expect(syms("nifty put")).toEqual(["NFO:NIFTY-2026-10-27-25000-PE"]);
    expect(syms("NFO:NIFTY 2026-10-27 25000")).toEqual(["NFO:NIFTY-2026-10-27-25000-CE", "NFO:NIFTY-2026-10-27-25000-PE"]);
  });

  it("folds multi-word index names and tolerates typos", () => {
    expect(syms("nifty 50")[0]).toBe("NSE:NIFTY");
    expect(syms("nifty bank")[0]).toBe("NSE:BANKNIFTY");
    expect(syms("relaince")[0]).toBe("NSE:RELIANCE");
    expect(syms("industries")[0]).toBe("NSE:RELIANCE"); // display name
    expect(syms("zzzz")).toEqual([]);
  });

  it("applies explicit filters and lifts an exact symbol to the top", () => {
    // BANKNIFTY contains "NIFTY" (substring match), so it follows the exact-name futures.
    expect(syms("nifty", { kind: "FUT", exchange: "NFO" })).toEqual(["NFO:NIFTY-2026-10-27-FUT", "NFO:NIFTY-2026-11-24-FUT", "NFO:BANKNIFTY-2026-10-27-FUT"]);
    expect(syms("nifty", { underlying: "banknifty" })).toEqual(["NSE:BANKNIFTY", "NFO:BANKNIFTY-2026-10-27-FUT"]);
    expect(syms("nifty", { expiry: "2026-10-20" })).toEqual(["NFO:NIFTY-2026-10-20-24950-CE", "NFO:NIFTY-2026-10-20-25000-CE"]);
    expect(s.search({ q: "nifty", exact: "NFO:NIFTY-2026-11-24-FUT" }, TODAY)[0].canonical).toBe("NFO:NIFTY-2026-11-24-FUT");
  });
});

describe("text helpers", () => {
  it("parses search text", () => {
    expect(parseSearchText("nifty 25000 ce")).toMatchObject({ names: ["NIFTY"], strike: 25000, right: "CE", kind: "OPT" });
    expect(parseSearchText("NIFTY FIN SERVICE fut")).toMatchObject({ names: ["FINNIFTY"], kind: "FUT" });
    expect(parseSearchText("reliance oct")).toMatchObject({ names: ["RELIANCE"], month: 10 });
  });

  it("scores names and bounds edit distance", () => {
    expect(editDistance("RELAINCE", "RELIANCE")).toBe(2);
    expect(editDistance("A", "ABCDEFG", 2)).toBe(3);
    expect(nameScore("NIFTY", "NIFTY")).toBe(100);
    expect(nameScore("NIF", "NIFTY")).toBe(70);
    expect(nameScore("FTY", "NIFTY")).toBe(40);
    expect(nameScore("RELIANC", "RELIANCE")).toBe(70);
    expect(nameScore("RELAINCE", "RELIANCE")).toBe(20);
    expect(nameScore("XYZ", "NIFTY")).toBe(0);
  });
});
