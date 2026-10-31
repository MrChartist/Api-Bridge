/**
 * The F&O underlying list (docs/spec/p1-06-stocks.md §2.7, §6.1, §6.12, §9.1): reference universe ∩ masters; masters
 * fallback; missingAtBroker; strike step (incl. tie and < 3 strikes); settlement from the instrument kind; ban join
 * incl. available false; nonStandard from inferred actions and adjusted contracts; ranking.
 */
import { describe, expect, it } from "vitest";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { parseFnoConfig } from "./config.mjs";
import { banOf, createUniverse, hasWeekly, mergeUniverse, modalLot, rankUnderlyings, settlementOf, strikeStepOf } from "./universe.mjs";

const NOW = Date.parse("2026-11-19T10:00:00+05:30");
const opts = (u, e, strikes, lot, extra = {}) => strikes.flatMap((k) => ["CE", "PE"].map((r) => ({ symbol: `NFO:${u}-${e}-${k}-${r}`, lotSize: extra[k] ?? lot, tickSize: 0.05 })));
const INSTRUMENTS = [
  { symbol: "NSE:NIFTY", lotSize: 1, tickSize: 0.05, name: "Nifty 50" },
  { symbol: "NSE:BANKNIFTY", lotSize: 1, tickSize: 0.05, name: "Nifty Bank" },
  { symbol: "NSE:RELIANCE", lotSize: 1, tickSize: 0.1, name: "Reliance Industries" },
  { symbol: "NSE:SBIN", lotSize: 1, tickSize: 0.05, name: "State Bank of India" },
  { symbol: "NSE:HDFCBANK", lotSize: 1, tickSize: 0.05, name: "HDFC Bank" },
  { symbol: "NFO:NIFTY-2026-11-24-FUT", lotSize: 65, tickSize: 0.1 },
  { symbol: "NFO:BANKNIFTY-2026-11-24-FUT", lotSize: 30, tickSize: 0.1 },
  { symbol: "NFO:RELIANCE-2026-11-23-FUT", lotSize: 500, tickSize: 0.1 },
  { symbol: "NFO:SBIN-2026-11-23-FUT", lotSize: 750, tickSize: 0.05 },
  { symbol: "NFO:HDFCBANK-2026-11-23-FUT", lotSize: 550, tickSize: 0.05 },
  ...opts("NIFTY", "2026-11-24", [25900, 25950, 26000, 26050], 65),
  ...opts("NIFTY", "2026-12-01", [25900, 26000, 26100], 65),
  ...opts("BANKNIFTY", "2026-11-24", [56000, 56100, 56200], 30),
  // RELIANCE: the off-grid 1410 strike carries an adjusted lot (§6.1 example)
  ...opts("RELIANCE", "2026-11-23", [1360, 1380, 1400, 1410, 1420, 1440, 1460], 500, { 1410: 2500 }),
  ...opts("SBIN", "2026-11-23", [862.5, 865, 867.5, 870], 750),
];

function refStub({ coverage = "recorded", ban = {}, inferred = [] } = {}) {
  return {
    universe: () => (coverage === "recorded" ? { coverage, knownSince: "2026-10-29", source: "NSE fo_mktlots", items: [{ symbol: "NIFTY", kind: "index" }, { symbol: "RELIANCE", kind: "stock" }, { symbol: "SBIN", kind: "stock" }, { symbol: "GONEINC", kind: "stock" }] } : { coverage: "not-recorded", items: [], available: false }),
    lotFor: async (u, e) => ({ lot: u === "SBIN" ? 750 : u === "RELIANCE" ? 500 : 65, effectiveFrom: null }),
    freezeFor: async () => ({ freezeQty: null }),
    banStatus: (u) => ban[u] ?? { available: true, inBan: false, mwplPct: 40, band: "normal", forDate: "2026-11-19", asOf: "2026-11-18" },
    corporateActions: () => inferred,
    events: async () => [{ kind: "corporate-action", underlying: "SBIN" }],
  };
}

const build = (reference, cfgRaw = {}) => {
  const symbols = createFakeSymbolService({ instruments: INSTRUMENTS, today: "2026-11-19" });
  return createUniverse({ reference, symbols, clock: { now: () => NOW }, cfg: parseFnoConfig(cfgRaw) });
};

describe("pure helpers", () => {
  it("strike step: modal gap, smaller on a tie, null under 3 strikes (§6.1)", () => {
    expect(strikeStepOf([1360, 1380, 1400, 1410, 1420, 1440, 1460])).toBe(20);
    expect(strikeStepOf([162.5, 165, 167.5, 170])).toBe(2.5);
    expect(strikeStepOf([100, 110, 130, 150, 160])).toBe(10);
    expect(strikeStepOf([100, 120])).toBeNull();
  });
  it("settlement from kind; modal lot; weekly from listed expiries", () => {
    expect([settlementOf("stock"), settlementOf("index")]).toEqual(["physical", "cash"]);
    expect(modalLot([{ lotSize: 500 }, { lotSize: 500 }, { lotSize: 2500 }])).toBe(500);
    expect(hasWeekly(["2026-11-24", "2026-12-29", "2027-01-26"])).toBe(false);
    expect(hasWeekly(["2026-11-17", "2026-11-24"])).toBe(true);
    expect(hasWeekly(["2026-11-24", "2026-12-01"])).toBe(true);
  });
  it("mergeUniverse: reference ∩ masters, missingAtBroker; masters fallback", () => {
    const masters = new Map([
      ["NIFTY", { kind: "index", hasOptions: true }],
      ["RELIANCE", { kind: "stock" }],
      ["SBIN", { kind: "stock" }],
      ["HDFCBANK", { kind: "stock" }],
    ]);
    expect(mergeUniverse({ coverage: "recorded", items: [{ symbol: "RELIANCE", kind: "stock" }, { symbol: "GONE", kind: "stock" }] }, masters)).toEqual({ source: "reference", stocks: ["RELIANCE"], indices: ["NIFTY"], missingAtBroker: ["GONE"] });
    expect(mergeUniverse({ coverage: "not-recorded", items: [] }, masters)).toMatchObject({ source: "masters", stocks: ["HDFCBANK", "RELIANCE", "SBIN"] });
  });
  it("ban object: null for indices; available false when not recorded", () => {
    expect(banOf("index", { inBan: true })).toBeNull();
    expect(banOf("stock", { available: false, reason: "SOURCE_OFF" })).toEqual({ available: false, reason: "SOURCE_OFF" });
    expect(banOf("stock", { available: true, inBan: true, mwplPct: 96.2, band: "ban", forDate: "2026-11-19", asOf: "2026-11-18" })).toMatchObject({ inBan: true, band: "ban" });
  });
});

describe("createUniverse", () => {
  it("lists indices (weekly first) and reference stocks listed at this broker, with contract facts", async () => {
    const u = build(refStub({ ban: { SBIN: { available: true, inBan: true, mwplPct: 96.2, band: "ban", forDate: "2026-11-19", asOf: "2026-11-18" } } }));
    const l = await u.list();
    expect(l.items.map((i) => i.underlying)).toEqual(["NIFTY", "BANKNIFTY", "RELIANCE", "SBIN"]);
    expect(l.counts).toEqual({ index: 2, stock: 2, inBan: 1, missingAtBroker: 1 });
    expect(l.source.universe).toBe("reference:fo_mktlots");
    const rel = l.items.find((i) => i.underlying === "RELIANCE");
    expect(rel).toMatchObject({ kind: "stock", settlement: "physical", spot: "NSE:RELIANCE", lot: 500, strikeStep: 20, tickSize: 0.05, weekly: false, nonStandard: true });
    const sbin = l.items.find((i) => i.underlying === "SBIN");
    expect(sbin).toMatchObject({ strikeStep: 2.5, events: 1, ban: { inBan: true, mwplPct: 96.2, band: "ban" } });
    const nifty = l.items.find((i) => i.underlying === "NIFTY");
    expect(nifty).toMatchObject({ kind: "index", settlement: "cash", ban: null, weekly: true, strikeStep: 50 });
    expect((await u.detail("RELIANCE")).facts.adjusted).toEqual([
      { symbol: "NFO:RELIANCE-2026-11-23-1410-CE", lot: 2500, reason: "lot differs from the series lot 500 (inferred)" },
      { symbol: "NFO:RELIANCE-2026-11-23-1410-PE", lot: 2500, reason: "lot differs from the series lot 500 (inferred)" },
    ]);
    await expect(u.detail("NOPE")).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND" });
  });

  it("falls back to the masters when the reference universe is not recorded, and says so", async () => {
    const u = build(refStub({ coverage: "off", ban: { RELIANCE: { available: false, reason: "SOURCE_OFF" } } }));
    const l = await u.list({ kind: "stock" });
    expect(l.source).toMatchObject({ universe: "masters", note: "membership history not recorded" });
    expect(l.items.map((i) => i.underlying)).toEqual(["HDFCBANK", "RELIANCE", "SBIN"]);
    expect(l.items.find((i) => i.underlying === "RELIANCE").ban).toEqual({ available: false, reason: "SOURCE_OFF" });
    // HDFCBANK has futures but no options listed: no strike step
    expect(l.items.find((i) => i.underlying === "HDFCBANK").strikeStep).toBeNull();
  });

  it("underlyings named like an exchange word (BSE Ltd, MCX Ltd) keep their spot, options and strike step", async () => {
    const instruments = [
      ...INSTRUMENTS,
      { symbol: "NSE:BSE", lotSize: 1, tickSize: 0.1, name: "BSE Limited" },
      { symbol: "NSE:MCX", lotSize: 1, tickSize: 0.1, name: "Multi Commodity Exchange" },
      { symbol: "NFO:BSE-2026-11-23-FUT", lotSize: 375, tickSize: 0.1 },
      { symbol: "NFO:MCX-2026-11-23-FUT", lotSize: 125, tickSize: 0.1 },
      ...opts("BSE", "2026-11-23", [2500, 2550, 2600, 2650], 375),
      ...opts("MCX", "2026-11-23", [9000, 9100, 9200, 9300], 125),
    ];
    const symbols = createFakeSymbolService({ instruments, today: "2026-11-19" });
    const u = createUniverse({ reference: refStub({ coverage: "off" }), symbols, clock: { now: () => NOW }, cfg: parseFnoConfig({}) });
    const items = (await u.list({ kind: "stock" })).items;
    expect(items.find((i) => i.underlying === "BSE")).toMatchObject({ kind: "stock", spot: "NSE:BSE", strikeStep: 50 });
    expect(items.find((i) => i.underlying === "MCX")).toMatchObject({ kind: "stock", spot: "NSE:MCX", strikeStep: 100 });
    expect((await u.facts("BSE")).expiries).toEqual(["2026-11-23"]);
  });

  it("nonStandard from an inferred corporate action", async () => {
    const u = build(refStub({ inferred: [{ symbol: "SBIN", origin: "inferred", nonStandard: true }] }));
    expect((await u.list()).items.find((i) => i.underlying === "SBIN").nonStandard).toBe(true);
  });
});

describe("rankUnderlyings (§6.12)", () => {
  const list = [
    { underlying: "NIFTY", name: "NIFTY 50", kind: "index" },
    { underlying: "BANKNIFTY", name: "NIFTY BANK", kind: "index" },
    { underlying: "BANKEX", name: "S&P BSE BANKEX", kind: "index" },
    { underlying: "AXISBANK", name: "Axis Bank", kind: "stock" },
    { underlying: "HDFCBANK", name: "HDFC Bank", kind: "stock" },
    { underlying: "ICICIBANK", name: "ICICI Bank", kind: "stock" },
    { underlying: "KOTAKBANK", name: "Kotak Mahindra Bank", kind: "stock" },
    { underlying: "SBIN", name: "State Bank of India", kind: "stock" },
    { underlying: "RELIANCE", name: "Reliance Industries", kind: "stock" },
    { underlying: "INFY", name: "Infosys", kind: "stock" },
  ];
  const names = (q, o) => rankUnderlyings(list, q, o).map((i) => i.underlying);
  it("rel → RELIANCE first; infy → INFY; relaince → RELIANCE (fuzzy)", () => {
    expect(names("rel")[0]).toBe("RELIANCE");
    expect(names("infy")).toEqual(["INFY"]);
    expect(names("relaince")).toEqual(["RELIANCE"]);
  });
  it("bank: indices first among prefix matches, then symbols containing it (alphabetical), then names", () => {
    expect(names("bank")).toEqual(["BANKEX", "BANKNIFTY", "AXISBANK", "HDFCBANK", "ICICIBANK", "KOTAKBANK", "SBIN"]);
  });
  it("ties: positions then recent", () => {
    expect(names("a", { held: ["HDFCBANK"] }).slice(0, 1)).toEqual(["AXISBANK"]);
    expect(names("bank", { recent: ["KOTAKBANK"] }).slice(2, 4)).toEqual(["KOTAKBANK", "AXISBANK"]);
  });
});
