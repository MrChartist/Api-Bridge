/** The Option Screener's ready-made scans (option-scans.js): scans, facts, readings, cautions, search, saved scans. */
import { describe, expect, it } from "vitest";
import * as SC from "./option-scans.js";
import { checkSource } from "./copyRules.mjs";
import { readFileSync } from "node:fs";

/** A contract record as screens.js chainRecords builds it (only the fields the scans read). */
const rec = (o = {}) => ({ kind: "contract", key: o.key ?? "k", underlying: "NIFTY", right: "CE", strike: 25000, lot: 75, ltp: 46, changePct: 15, oi: 1500 * 75, oiChange: 300 * 75, oiLots: 1500, oiChangeLots: 300, volume: 900 * 75, volLots: 900, turnover: 3e6, volOiRel: 1.2, spread: 2, days: 5, tag: "LB", ...o });

describe("the thirteen scans", () => {
  it("has four families and thirteen scans, each with a plain question, a sort and a side", () => {
    expect(SC.SCAN_FAMILIES.map((f) => f.id)).toEqual(["price", "oi", "buildup", "volume"]);
    expect(SC.CONTRACT_SCANS).toHaveLength(13);
    expect(new Set(SC.SCAN_IDS).size).toBe(13);
    expect(SC.scansOf("price").map((s) => s.id)).toEqual(["gainers", "losers"]);
    expect(SC.scansOf("oi")).toHaveLength(4);
    expect(SC.scansOf("buildup")).toHaveLength(4);
    expect(SC.scansOf("volume")).toHaveLength(3);
    for (const s of SC.CONTRACT_SCANS) {
      expect(s.plain.length, s.id).toBeGreaterThan(10);
      expect(["asc", "desc"]).toContain(s.sort.dir);
      expect(["up", "down", "flow"]).toContain(s.side);
    }
    expect(SC.scanById("nope").id).toBe(SC.DEFAULT_SCAN);
    expect(SC.familyOf("long-unwinding")).toBe("buildup");
  });
  it("price scans need a real starting premium", () => {
    // 46 after +15%: started at 40.
    expect(SC.meetsScan(rec(), "gainers")).toBe(true);
    expect(SC.meetsScan(rec(), "losers")).toBe(false);
    expect(SC.meetsScan(rec({ ltp: 0.9, changePct: 2900 }), "gainers")).toBe(false); // started at 3 paise
    expect(SC.meetsScan(rec({ ltp: 30, changePct: -25 }), "losers")).toBe(true);
    expect(SC.meetsScan(rec({ changePct: null }), "gainers")).toBe(false);
  });
  it("OI scans: lots added or closed, and percent only from a 50-lot base", () => {
    expect(SC.meetsScan(rec(), "oi-gainers")).toBe(true);
    expect(SC.meetsScan(rec({ oiChange: -10 * 75, oiChangeLots: -10 }), "oi-losers")).toBe(true);
    expect(SC.meetsScan(rec(), "oi-pct-gainers")).toBe(true);
    // 2 lots to 60 lots: +2900% on a tiny base is left out.
    const tiny = rec({ oi: 60 * 75, oiChange: 58 * 75, oiLots: 60, oiChangeLots: 58 });
    expect(SC.scanFacts(tiny).oiPct).toBeNull();
    expect(SC.meetsScan(tiny, "oi-pct-gainers")).toBe(false);
    expect(SC.meetsScan(tiny, "oi-gainers")).toBe(true);
    expect(SC.meetsScan(rec({ oi: 900 * 75, oiChange: -300 * 75 }), "oi-pct-losers")).toBe(true);
  });
  it("build-up scans follow the tag; volume scans read turnover, the chain's median and the starting OI", () => {
    expect(SC.CONTRACT_SCANS.filter((s) => s.family === "buildup" && SC.meetsScan(rec({ tag: "SC" }), s.id)).map((s) => s.id)).toEqual(["short-covering"]);
    expect(SC.meetsScan(rec({ tag: null }), "long-buildup")).toBe(false);
    expect(SC.meetsScan(rec(), "most-active")).toBe(true);
    expect(SC.meetsScan(rec({ turnover: null }), "most-active")).toBe(false);
    expect(SC.meetsScan(rec(), "volume-surge")).toBe(false);
    expect(SC.meetsScan(rec({ volOiRel: 3 }), "volume-surge")).toBe(true);
    // 900 lots traded on 1200 open at the start: 0.75×.
    expect(SC.scanFacts(rec()).volStartOi).toBeCloseTo(0.75, 6);
    expect(SC.meetsScan(rec(), "volume-over-oi")).toBe(false);
    expect(SC.meetsScan(rec({ volLots: 2400 }), "volume-over-oi")).toBe(true);
  });
  it("counts every scan over the same rows", () => {
    const rows = [rec({ key: "a" }), rec({ key: "b", changePct: -20, ltp: 20, tag: "LU", oiChange: -100 * 75, oiChangeLots: -100 }), rec({ key: "c", tag: "SB", changePct: -5, ltp: 9.5 })];
    const c = SC.scanCounts(rows);
    expect(Object.keys(c)).toEqual([...SC.SCAN_IDS]);
    expect(c.gainers).toBe(1);
    expect(c.losers).toBe(2);
    expect(c["long-buildup"]).toBe(1);
    expect(c["long-unwinding"]).toBe(1);
    expect(c["most-active"]).toBe(3);
    expect(SC.scanCounts(null).gainers).toBe(0);
  });
});

describe("facts and readings", () => {
  it("works out where the premium and the OI started, never inventing a 0", () => {
    const f = SC.scanFacts(rec());
    expect(f.prevPrice).toBeCloseTo(40, 6);
    expect(f.startOiLots).toBe(1200);
    expect(f.oiPct).toBeCloseTo(25, 6);
    const none = SC.scanFacts(rec({ ltp: null, oi: null }));
    expect(none.prevPrice).toBeNull();
    expect(none.startOiLots).toBeNull();
    expect(SC.scanFacts(null).oiPct).toBeNull();
    expect(SC.scanFacts(rec({ oi: 40 * 75, oiChange: 40 * 75 })).oiNew).toBe(true);
  });
  it("reads a row in plain words for its scan", () => {
    expect(SC.scanReading(rec(), "gainers")).toEqual({ text: "Premium up 15.0% from ₹40.00 · positions added", caution: "", tone: "pos" });
    expect(SC.scanReading(rec(), "oi-gainers").text).toBe("300 lots added (+25.0%) · premium +15.0%");
    expect(SC.scanReading(rec({ tag: "SB" }), "short-buildup").text).toBe("Positions added as the premium fell · 300 lots");
    expect(SC.scanReading(rec({ volOiRel: 3.26 }), "volume-surge").text).toBe("3.3× its chain's usual turnover · positions added as the premium rose");
    expect(SC.scanReading(rec({ changePct: null, oiChangeLots: null, tag: null }), "gainers").text).toBe("–");
    expect(SC.scanReading(null, "gainers").text).toBe("");
    expect(SC.rowReading(rec({ tag: "SC" }))).toBe("Positions closed as the premium rose");
    expect(SC.rowReading(rec({ tag: null, changePct: -3 }))).toBe("Premium down 3.0%, no clear OI pattern");
    expect(SC.rowReading(rec({ tag: null, changePct: 0, volLots: 12 }))).toBe("12 lots traded, premium flat");
    expect(SC.rowReading(rec({ tag: null, changePct: null, volLots: null }))).toBe("");
    expect(SC.patternText("CH")).toBe("");
  });
  it("names the traps: small base, opened from zero, wide quote, thin trade, expiry day", () => {
    expect(SC.cautions(rec())).toEqual([]);
    expect(SC.cautions(rec({ oi: 10 * 75, oiChange: 8 * 75, spread: 9, volLots: 3, days: 0.2 }))).toEqual(["Small base", "Wide quote", "Thin trade", "Expiry day"]);
    expect(SC.cautions(rec({ oi: 40 * 75, oiChange: 40 * 75 }))).toEqual(["Opened from zero"]);
    expect(SC.cautions(null)).toEqual([]);
  });
  it("chance worthless: a call below its strike, a put above it; never a certainty in text", () => {
    const pb = (x) => (x >= 25000 ? 0.85 : 0.1);
    expect(SC.chanceWorthless("CE", 25000, pb)).toBe(0.85);
    expect(SC.chanceWorthless("PE", 25000, pb)).toBeCloseTo(0.15, 9);
    expect(SC.chanceWorthless("CE", null, pb)).toBeNull();
    expect(SC.chanceWorthless("CE", 25000, () => null)).toBeNull();
    expect(SC.worthlessText(0.852)).toBe("85.2%");
    expect(SC.worthlessText(0.99991)).toBe("> 99.9%");
    expect(SC.worthlessText(0.0001)).toBe("< 0.1%");
    expect(SC.worthlessText(null)).toBe("–");
  });
});

describe("symbol search", () => {
  const known = ["NIFTY", "BANKNIFTY", "FINNIFTY", "TCS"];
  it("a whole symbol is that underlying alone; part of one finds every match; empty is everything", () => {
    expect(SC.symbolMatch("nifty", "NIFTY", known)).toBe(true);
    expect(SC.symbolMatch("nifty", "BANKNIFTY", known)).toBe(false);
    expect(SC.symbolMatch("nif", "BANKNIFTY", known)).toBe(true);
    expect(SC.symbolMatch("  ", "TCS", known)).toBe(true);
    expect(SC.symbolMatch("INFY", "TCS", known)).toBe(false);
  });
});

describe("saved scans", () => {
  const cfg = { preset: "scans", filters: { scans: { scan: "losers", side: "PE", turnoverMin: 1e6 }, sell: { pop: 65 } }, sort: { scans: { by: "changePct", dir: "asc" } } };
  it("saves, replaces by name (any case), keeps the newest first and caps the list", () => {
    let { list, entry } = SC.addSavedScan([], { name: "  Put losers ", preset: "scans", filters: cfg.filters.scans, sort: cfg.sort.scans }, 10);
    expect(entry).toMatchObject({ name: "Put losers", preset: "scans", sort: { by: "changePct", dir: "asc" }, at: 10 });
    expect(list).toHaveLength(1);
    ({ list } = SC.addSavedScan(list, { name: "put LOSERS", preset: "scans", filters: { scan: "gainers" }, sort: null }, 20));
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(entry.id);
    expect(list[0].filters).toEqual({ scan: "gainers" });
    for (let i = 0; i < 20; i++) ({ list } = SC.addSavedScan(list, { name: `S${i}`, preset: "sell", filters: {} }, 100 + i));
    expect(list).toHaveLength(SC.SAVED_MAX);
    expect(list[0].name).toBe("S19");
    expect(SC.addSavedScan(list, { name: "  ", preset: "sell", filters: {} }).entry).toBeNull();
  });
  it("drops bad stored entries and duplicate names", () => {
    const out = SC.normaliseSavedScans([null, 5, { name: "", preset: "scans" }, { name: "A", preset: 3 }, { id: "x", name: "A", preset: "scans", filters: [], sort: { by: "x", dir: "up" }, at: 2 }, { name: "a", preset: "sell", at: 1 }]);
    expect(out).toEqual([{ id: "x", name: "A", preset: "scans", filters: {}, sort: null, at: 2 }]);
    expect(SC.normaliseSavedScans("nope")).toEqual([]);
  });
  it("opens a saved scan as a config patch, and knows which one is in use", () => {
    const { list, entry } = SC.addSavedScan([], { name: "Put losers", preset: "scans", filters: cfg.filters.scans, sort: cfg.sort.scans }, 1);
    const patch = SC.savedScanPatch({ preset: "sell", filters: { sell: { pop: 65 }, scans: { scan: "gainers", liq: 3 } }, sort: {} }, entry);
    expect(patch.preset).toBe("scans");
    expect(patch.filters.scans).toEqual({ scan: "losers", side: "PE", turnoverMin: 1e6, liq: 3 });
    expect(patch.filters.sell).toEqual({ pop: 65 });
    expect(patch.sort.scans).toEqual({ by: "changePct", dir: "asc" });
    expect(SC.savedScanPatch(cfg, null)).toBeNull();
    expect(SC.activeSavedScan(cfg, list)).toBe(entry.id);
    expect(SC.activeSavedScan({ ...cfg, sort: { scans: { by: "turnover", dir: "desc" } } }, list)).toBeNull();
    expect(SC.activeSavedScan({ ...cfg, preset: "sell" }, list)).toBeNull();
    expect(SC.removeSavedScan(list, entry.id)).toEqual([]);
  });
  it("suggests a name that is not taken", () => {
    expect(SC.suggestScanName("Top gainers", [], "CE")).toBe("Top gainers · CE");
    expect(SC.suggestScanName("Top gainers", [{ name: "Top gainers" }, { name: "top gainers 2" }])).toBe("Top gainers 3");
    expect(SC.suggestScanName("", [])).toBe("My scan");
  });
});

describe("neutral copy", () => {
  it("the scan copy never advises", () => {
    expect(checkSource(readFileSync(new URL("./option-scans.js", import.meta.url), "utf8"))).toEqual([]);
  });
});
