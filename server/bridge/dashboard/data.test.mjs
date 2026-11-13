import { describe, expect, it } from "vitest";

globalThis.sessionStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const { MAX_SYMBOLS, candlesCsv, dataSources, defaultRange, historyPath, parseSymbols, sourcePlan, summarise } = await import("./data.js");

const acct = (o) => ({ id: "dhan-main", broker: "dhan", label: "Dhan", session: { state: "connected" }, capabilities: ["historical", "quotes", "feed"], ...o });

describe("what to collect", () => {
  it("reads symbols from any mix of commas, spaces and lines, once each, in order", () => {
    expect(parseSymbols("NSE:RELIANCE, nse:reliance\nNSE:INFY;  NSE:M&M ,, ")).toEqual(["NSE:RELIANCE", "NSE:INFY", "NSE:M&M"]);
    expect(parseSymbols("")).toEqual([]);
    expect(parseSymbols(Array.from({ length: 80 }, (_, i) => `NSE:S${i}`).join(","))).toHaveLength(MAX_SYMBOLS);
    expect(parseSymbols(`NSE:OK ${"X".repeat(65)}`)).toEqual(["NSE:OK"]);
  });
  it("starts with the last 30 days in IST", () => {
    expect(defaultRange(Date.parse("2026-11-12T20:00:00Z"))).toEqual({ from: "2026-10-14", to: "2026-11-13" });
  });
  it("builds the one API call a symbol needs", () => {
    expect(historyPath({ symbol: "NSE:M&M", interval: "1d", from: "2026-10-01", to: "2026-11-12" })).toBe("/v1/history?symbol=NSE%3AM%26M&interval=1d&from=2026-10-01&to=2026-11-12");
    expect(historyPath({ symbol: "NSE:INFY", interval: "5m", from: "a", to: "b", account: "dhan-main", format: "csv" })).toMatch(/&account=dhan-main&format=csv$/);
  });
});

describe("where it comes from", () => {
  const accounts = [{ id: "paper", broker: "paper", capabilities: ["placeOrder"] }, acct({ id: "z", label: "Zerodha", broker: "zerodha", session: { state: "expired" } }), acct({}), acct({ id: "u", label: "", broker: "upstox", capabilities: ["quotes"] })];
  it("lists the accounts that give data, connected first, with what each supplies", () => {
    const s = dataSources(accounts);
    expect(s.map((x) => [x.id, x.connected, x.history])).toEqual([["dhan-main", true, true], ["u", true, false], ["z", false, true]]);
    expect(s[0].gives).toEqual(["History", "Quotes", "Live prices"]);
    expect(s[1].label).toBe("u");
    expect(dataSources([])).toEqual([]);
  });
  it("tries the chosen source first, then the others that are connected and have history", () => {
    const s = dataSources([...accounts, acct({ id: "dhan-2", label: "Dhan 2" })]);
    expect(sourcePlan("", s)).toEqual(["", "dhan-main", "dhan-2"]);
    expect(sourcePlan("dhan-2", s)).toEqual(["dhan-2", "dhan-main"]);
    expect(sourcePlan("dhan-2", s, false)).toEqual(["dhan-2"]);
    // An account that is not connected, or has no history, is never the first choice.
    expect(sourcePlan("z", s)).toEqual(["", "dhan-main", "dhan-2"]);
    expect(sourcePlan("", [], true)).toEqual([""]);
  });
});

describe("what comes out", () => {
  const results = [
    { symbol: "NSE:RELIANCE", source: "dhan-main", candles: [{ time: 1790793000, open: 1475.4, high: 1484.8, low: 1404.7, close: 1418, volume: 126926 }, { time: 1790879400, open: 1418, high: 1423.7, low: 1406.7, close: 1423.3, volume: 184426, oi: 12 }] },
    { symbol: "NSE:NOPE", source: null, candles: [], error: "not found" },
  ];
  it("one CSV in long form, with IST times and the source of every row", () => {
    expect(candlesCsv(results.filter((r) => !r.error)).split("\n")).toEqual([
      "symbol,time,open,high,low,close,volume,oi,source",
      "NSE:RELIANCE,2026-10-01T00:00:00+05:30,1475.4,1484.8,1404.7,1418,126926,,dhan-main",
      "NSE:RELIANCE,2026-10-02T00:00:00+05:30,1418,1423.7,1406.7,1423.3,184426,12,dhan-main",
      "",
    ]);
    expect(candlesCsv([])).toBe("symbol,time,open,high,low,close,volume,oi,source\n");
  });
  it("sums a run up", () => {
    expect(summarise(results)).toEqual({ done: 1, failed: 1, candles: 2, sources: ["dhan-main"] });
    expect(summarise([])).toEqual({ done: 0, failed: 0, candles: 0, sources: [] });
  });
});
