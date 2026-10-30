import { describe, expect, it } from "vitest";
import { PRESETS, chainContracts, parseScreenerQuery, screenerRoutes } from "./screener.mjs";
import { createFakeMarketData } from "../market/fake.mjs";

const NOW = Date.parse("2026-10-26T05:00:00Z");
const sym = (u, k, r) => `NFO:${u}-2026-10-27-${k}-${r}`;
const leg = (u, k, r, o = {}) => ({ symbol: sym(u, k, r), ltp: 50, bid: 49.5, ask: 50.5, oi: 5000, oiChange: 10, volume: 400, iv: 15, delta: r === "CE" ? 0.5 : -0.5, gamma: 0.001, theta: -5, vega: 2, ...o });
const chainFor = (u, spot) => ({
  underlyingLtp: spot,
  lotSize: 75,
  rows: [
    { strike: spot - 100, ce: leg(u, spot - 100, "CE", { ltp: 120, delta: 0.8, iv: 14, oi: 9000 }), pe: leg(u, spot - 100, "PE", { ltp: 8, delta: -0.1, iv: 25, oi: 20000, volume: 900 }) },
    { strike: spot, ce: leg(u, spot, "CE"), pe: leg(u, spot, "PE", { iv: 18 }) },
    { strike: spot + 100, ce: leg(u, spot + 100, "CE", { ltp: 6, delta: 0.1, iv: 22, bid: 5, ask: 7, oi: 30000, volume: 50 }), pe: null },
  ],
});
const ctx = (query) => ({ query: new URLSearchParams(query), requestId: "r1", principal: { kind: "local" }, requireAccountAccess() {} });

function setup() {
  const md = createFakeMarketData({ prices: { "NSE:NIFTY": 25000, "NSE:BANKNIFTY": 55000 } });
  md.setExpiries("NIFTY", ["2026-10-20", "2026-10-27", "2026-11-03"]);
  md.setExpiries("BANKNIFTY", ["2026-10-27"]);
  md.setChain("NIFTY", "2026-10-27", chainFor("NIFTY", 25000));
  md.setChain("BANKNIFTY", "2026-10-27", chainFor("BANKNIFTY", 55000));
  const [, , , screen] = screenerRoutes({ marketData: md, now: () => NOW }).find((r) => r[1] === "/v1/analytics/screener");
  return { md, run: (query) => screen(ctx(query)) };
}

describe("parseScreenerQuery", () => {
  const bad = (query) => {
    try {
      parseScreenerQuery(new URLSearchParams(query));
    } catch (e) {
      return e;
    }
    return null;
  };
  it("applies defaults", () => {
    const r = parseScreenerQuery(new URLSearchParams("underlyings=nifty, niftY"));
    expect(r).toMatchObject({ underlyings: ["NIFTY"], type: "both", moneyness: "any", sort: "oi", dir: "desc", limit: 50, filters: {} });
  });
  it.each(["minIv=NaN", "minIv=abc", "minOi=Infinity", "minDelta=1.5", "minDelta=-0.1", "maxPremium=1e3", "minDte=0x10", "limit=0", "limit=201", "limit=1.5", "type=x", "sort=foo", "dir=up", "moneyness=deep", "expiry=2026-13-45", "expiry=tomorrow"])("rejects %s", (p) => {
    const e = bad(`underlyings=NIFTY&${p}`);
    expect(e?.code).toBe("VALIDATION_FAILED");
  });
  it.each(["minDelta=0.6&maxDelta=0.5", "minIv=30&maxIv=20", "minPremium=10&maxPremium=5", "minDte=5&maxDte=2"])("rejects min > max: %s", (p) => {
    expect(bad(`underlyings=NIFTY&${p}`)?.code).toBe("VALIDATION_FAILED");
  });
  it("requires 1 to 5 underlyings", () => {
    expect(bad("")?.code).toBe("VALIDATION_FAILED");
    expect(bad("underlyings=A,B,C,D,E,F")?.code).toBe("VALIDATION_FAILED");
    expect(bad("underlyings=A,B,C,D,E")).toBeNull();
    expect(bad("underlyings=NI FTY")?.code).toBe("VALIDATION_FAILED");
  });
});

describe("computed fields", () => {
  it("computes premium, moneyness, breakeven, probItm, theta, spread, liquidity", () => {
    const { rows } = chainContracts({ ...chainFor("NIFTY", 25000), atmStrike: 25000 }, { underlying: "NIFTY", expiry: "2026-10-27", nowMs: NOW });
    const itmCall = rows.find((r) => r.strike === 24900 && r.type === "call");
    expect(itmCall).toMatchObject({ moneyness: "itm", moneynessPct: 0.4, breakeven: 25020, premiumTraded: 120 * 400 * 75, probItm: 0.8, spreadPct: 2, liquid: true });
    expect(itmCall.thetaPctPerDay).toBe(4.17);
    const otmPutLike = rows.find((r) => r.strike === 24900 && r.type === "put");
    expect(otmPutLike).toMatchObject({ moneyness: "otm", breakeven: 24892, probItm: 0.1 });
    expect(rows.find((r) => r.strike === 25000 && r.type === "put").moneyness).toBe("atm");
    const thin = rows.find((r) => r.strike === 25100);
    expect(thin.liquid).toBe(false);
    expect(thin.spreadPct).toBe(33.33);
    expect(thin.dte).toBe(1.21);
  });
  it("flags lot size assumption and nulls missing data", () => {
    const { rows } = chainContracts({ underlyingLtp: 100, lotSize: null, rows: [{ strike: 100, ce: { ltp: 5, volume: 10 }, pe: null }] }, { underlying: "X", expiry: "2026-10-27", nowMs: NOW });
    expect(rows[0]).toMatchObject({ premiumTraded: 50, premiumTradedAssumesLot1: true, delta: null, probItm: null, spreadPct: null, thetaPctPerDay: null, liquid: false });
  });
});

describe("GET /v1/analytics/screener", () => {
  it("filters, sorts, and reports matched vs returned", async () => {
    const { run } = setup();
    const r = await run("underlyings=NIFTY&type=put&sort=iv&dir=desc&limit=1");
    expect(r.data.scanned).toBe(5);
    expect(r.data.matched).toBe(2);
    expect(r.data.returned).toBe(1);
    expect(r.data.rows[0]).toMatchObject({ strike: 24900, type: "put", iv: 25 });
    expect(r.data.sources[0].expiry).toBe("2026-10-27");
    expect(r.errors).toEqual([]);
  });
  it("picks the nearest upcoming expiry, skipping expired", async () => {
    const { md, run } = setup();
    await run("underlyings=NIFTY");
    expect(md.calls.find((c) => c[0] === "optionChain")[1].expiry).toBe("2026-10-27");
  });
  it("combines underlyings and applies filters", async () => {
    const { run } = setup();
    const r = await run("underlyings=NIFTY,BANKNIFTY&moneyness=otm&maxPremium=10&minDelta=0.05&maxDelta=0.15&sort=oi&dir=desc");
    expect(r.data.rows.map((x) => `${x.underlying}:${x.strike}:${x.type}`)).toEqual(["BANKNIFTY:55100:call", "NIFTY:25100:call", "BANKNIFTY:54900:put", "NIFTY:24900:put"]);
    expect(r.data.rows.map((x) => x.oi)).toEqual([30000, 30000, 20000, 20000]);
    expect(r.data.matched).toBe(4);
  });
  it("sorts nulls last and breaks ties deterministically", async () => {
    const { run } = setup();
    const r = await run("underlyings=NIFTY&sort=delta&dir=asc");
    expect(r.data.rows.map((x) => x.probItm)).toEqual([0.1, 0.1, 0.5, 0.5, 0.8]);
    expect(r.data.rows[0]).toMatchObject({ strike: 24900, type: "put" });
  });
  it("reports per-underlying failures without failing the whole call", async () => {
    const { md, run } = setup();
    md.setExpiries("FINNIFTY", []);
    const r = await run("underlyings=NIFTY,FINNIFTY,ZZZ");
    expect(r.data.sources.map((s) => s.underlying)).toEqual(["NIFTY"]);
    expect(r.errors.map((e) => e.underlying)).toEqual(["FINNIFTY", "ZZZ"]);
    expect(r.errors[0].code).toBe("NOT_FOUND");
    expect(r.errors[1].code).toBe("SYMBOL_NOT_FOUND");
    expect(r.data.matched).toBe(5);
  });
  it("uses an explicit expiry and rejects bad filters before any read", async () => {
    const { md, run } = setup();
    await expect(run("underlyings=NIFTY&minIv=nan")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(run("underlyings=NIFTY&minDte=3&maxDte=1")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(md.calls).toHaveLength(0);
    await run("underlyings=NIFTY&expiry=2026-10-27");
    expect(md.calls.some((c) => c[0] === "expiries")).toBe(false);
  });
  it("caps limit at 200", async () => {
    const { run } = setup();
    await expect(run("underlyings=NIFTY&limit=500")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("presets", () => {
  it("returns six presets whose queries all validate and run", async () => {
    const md = createFakeMarketData({ prices: {} });
    const routes = screenerRoutes({ marketData: md });
    const [method, path, meta, handler] = routes.find((r) => r[1] === "/v1/analytics/screener/presets");
    expect([method, path, meta]).toEqual(["GET", "/v1/analytics/screener/presets", { scope: "read" }]);
    const r = await handler(ctx(""));
    expect(r.data.presets).toHaveLength(6);
    expect(PRESETS.map((p) => p.id)).toEqual(["high-iv-puts", "liquid-atm-weeklies", "cheap-otm-lottery", "high-theta-sellers", "big-oi-walls", "tight-spreads"]);
    for (const p of r.data.presets) expect(() => parseScreenerQuery(new URLSearchParams(p.query))).not.toThrow();
  });
  it("exports read-scoped route entries", () => {
    for (const e of screenerRoutes({})) expect(e[2]).toEqual({ scope: "read" });
  });
});
