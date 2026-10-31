/** The desk's symbol search (symbol-search.js): ranking, the matched letters, the recent list. Pure helpers only. */
import { describe, expect, it } from "vitest";

const { RECENT_MAX, highlightParts, pushRecent, rankSymbols, readRecent } = await import("./symbol-search.js");

const ITEMS = [
  { symbol: "NIFTY", kind: "index" },
  { symbol: "BANKNIFTY", kind: "index" },
  { symbol: "FINNIFTY", kind: "index" },
  { symbol: "MIDCPNIFTY", kind: "index" },
  { symbol: "SENSEX", kind: "index" },
  { symbol: "NIFTYNXT", kind: "stock" },
  { symbol: "NMDC", kind: "stock" },
  { symbol: "INFY", kind: "stock" },
];

describe("symbol search", () => {
  it("ranks the exact symbol, then prefixes, then a match inside; indices first within a tier", () => {
    expect(rankSymbols(ITEMS, "nif").map((i) => i.symbol)).toEqual(["NIFTY", "NIFTYNXT", "FINNIFTY", "BANKNIFTY", "MIDCPNIFTY"]);
    expect(rankSymbols(ITEMS, "NIFTY").map((i) => i.symbol)[0]).toBe("NIFTY");
    // Same tier and kind: the shorter symbol first.
    expect(rankSymbols(ITEMS, "n").map((i) => i.symbol).slice(0, 3)).toEqual(["NIFTY", "NMDC", "NIFTYNXT"]);
    expect(rankSymbols(ITEMS, "zzz")).toEqual([]);
  });
  it("keeps the given order for an empty query", () => {
    expect(rankSymbols(ITEMS, "  ").map((i) => i.symbol)).toEqual(ITEMS.map((i) => i.symbol));
    expect(rankSymbols(null, "n")).toEqual([]);
  });
  it("marks the first match, in any case", () => {
    expect(highlightParts("BANKNIFTY", "nif")).toEqual([["BANK", false], ["NIF", true], ["TY", false]]);
    expect(highlightParts("NIFTY", "nifty")).toEqual([["NIFTY", true]]);
    expect(highlightParts("NIFTY", "")).toEqual([["NIFTY", false]]);
    expect(highlightParts("NIFTY", "x")).toEqual([["NIFTY", false]]);
  });
  it("keeps the last picks newest first, once each, at most ten", () => {
    expect(pushRecent(["A", "B"], "b")).toEqual(["B", "A"]);
    expect(pushRecent([], "NIFTY")).toEqual(["NIFTY"]);
    const many = Array.from({ length: 12 }, (_, i) => `S${i}`);
    expect(pushRecent(many, "NEW")).toHaveLength(RECENT_MAX);
    expect(pushRecent(["A"], "bad symbol!")).toEqual(["A"]);
  });
  it("reads only symbols back from storage, and survives a broken or blocked store", () => {
    const store = (v) => ({ get: () => v, set() {} });
    expect(readRecent(store(JSON.stringify(["NIFTY", 3, "x y", "RELIANCE"])))).toEqual(["NIFTY", "RELIANCE"]);
    expect(readRecent(store("{"))).toEqual([]);
    expect(readRecent(store(null))).toEqual([]);
    expect(readRecent({ get: () => { throw new Error("blocked"); } })).toEqual([]);
  });
});
