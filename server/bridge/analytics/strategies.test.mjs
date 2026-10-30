import { describe, expect, it } from "vitest";
import { createFakeMarketData } from "../market/fake.mjs";
import { buildTemplate, findStrategies, probabilityOfProfit, strategyRoutes, TEMPLATES } from "./strategies.mjs";

const EXP = "2099-12-31";
const leg = (strike, right, spot, iv = 15) => {
  const intr = right === "CE" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  const ltp = Math.round((intr + 150 * Math.exp(-Math.abs(strike - spot) / 150)) * 100) / 100;
  return { symbol: `NFO:NIFTY-${EXP}-${strike}-${right}`, ltp, bid: ltp - 0.5, ask: ltp + 0.5, oi: 1, iv };
};
const chain = (spot = 25000) => ({
  underlyingLtp: spot, lotSize: 75,
  rows: Array.from({ length: 15 }, (_, i) => 24650 + i * 50).map((k) => ({ strike: k, ce: leg(k, "CE", spot), pe: leg(k, "PE", spot) })),
});
const setup = () => {
  const md = createFakeMarketData({ prices: { "NSE:NIFTY": 25000 } });
  md.setChain("NIFTY", EXP, chain());
  const routes = Object.fromEntries(strategyRoutes({ marketData: md }).map(([, p, , h]) => [p.split("/").pop(), h]));
  const ctx = (q = "") => ({ query: new URLSearchParams(q), requestId: "r1", principal: { kind: "local" }, requireAccountAccess() {} });
  return { md, routes, ctx };
};

describe("buildTemplate", () => {
  const c = { ...chain(), atmStrike: 25000 };
  it("builds a short straddle at ATM with lot size from the chain", () => {
    const b = buildTemplate(c, "short_straddle");
    expect(b.legs.map((l) => [l.type, l.side, l.strike, l.lotSize])).toEqual([["CE", "sell", 25000, 75], ["PE", "sell", 25000, 75]]);
  });
  it("iron condor uses offset and width in strikes", () => {
    const b = buildTemplate(c, "iron_condor", { offset: 2, width: 1 });
    expect(b.legs.map((l) => l.strike)).toEqual([24850, 24900, 25100, 25150]);
  });
  it("butterfly sells two body lots", () => {
    const b = buildTemplate(c, "butterfly", { width: 2 });
    expect(b.legs.map((l) => [l.strike, l.lots])).toEqual([[24900, 1], [25000, 2], [25100, 1]]);
  });
  it("reports a strike that falls off the chain", () => {
    expect(buildTemplate(c, "iron_condor", { offset: 6, width: 6 }).error).toMatch(/not on the chain/);
  });
  it("FUT templates use the future price", () => {
    const b = buildTemplate(c, "covered_call", { futurePrice: 25040 });
    expect(b.legs[0]).toMatchObject({ type: "FUT", price: 25040 });
  });
  it("every template builds on a wide chain", () => {
    for (const t of TEMPLATES) expect(buildTemplate(c, t).error).toBeUndefined();
  });
});

describe("probabilityOfProfit", () => {
  it("is about one half for profit above spot and null without IV", () => {
    const curve = [];
    for (let p = 15000; p <= 35000; p += 50) curve.push({ price: p, pnl: p - 25000 });
    expect(probabilityOfProfit(curve, { spot: 25000, ivPct: 15, days: 30 })).toBeGreaterThan(0.45);
    expect(probabilityOfProfit(curve, { spot: 25000, ivPct: 15, days: 30 })).toBeLessThan(0.55);
    expect(probabilityOfProfit(curve, { spot: 25000, ivPct: null, days: 30 })).toBeNull();
  });
});

describe("findStrategies", () => {
  const c = { ...chain(), atmStrike: 25000 };
  it("flags unbounded risk and ranks neutral candidates", () => {
    const r = findStrategies(c, { view: "neutral", days: 30, limit: 100 });
    expect(r.results.length).toBeGreaterThan(3);
    expect(r.results[0].rank).toBe(1);
    expect(r.results.find((x) => x.template === "short_straddle").unboundedRisk).toBe(true);
    expect(r.results.find((x) => x.template === "iron_condor").unboundedRisk).toBe(false);
    for (let i = 1; i < r.results.length; i++) expect(r.results[i - 1].score).toBeGreaterThanOrEqual(r.results[i].score);
  });
  it("a loss budget drops unbounded and over-budget strategies", () => {
    const r = findStrategies(c, { view: "neutral", days: 30, maxLoss: 3000 });
    expect(r.excluded).toBeGreaterThan(0);
    for (const x of r.results) {
      expect(x.unboundedRisk).toBe(false);
      expect(Math.abs(x.maxLoss)).toBeLessThanOrEqual(3000);
    }
  });
  it("volatile view gives long vol with unbounded profit and bounded loss", () => {
    const r = findStrategies(c, { view: "volatile", days: 30 });
    expect(r.results.every((x) => x.unboundedProfit && !x.unboundedRisk && x.maxLoss < 0)).toBe(true);
  });
  it("long future strategies are bounded at spot zero, not flagged unbounded", () => {
    const r = findStrategies(c, { view: "bullish", days: 30 });
    const pp = r.results.find((x) => x.template === "protective_put");
    expect(pp.unboundedRisk).toBe(false);
  });
});

describe("routes", () => {
  it("lists templates", async () => {
    const { routes, ctx } = setup();
    const r = await routes.strategies(ctx());
    expect(r.data.templates.map((t) => t.id)).toContain("iron_condor");
    expect(r.data.views).toContain("rangebound");
  });
  it("builds a bull call spread with payoff", async () => {
    const { routes, ctx } = setup();
    const r = await routes.build(ctx(`underlying=NIFTY&expiry=${EXP}&template=bull_call_spread&width=2`));
    expect(r.data.legs).toHaveLength(2);
    expect(r.data.maxProfit).toBeGreaterThan(0);
    expect(r.data.maxLoss).toBeLessThan(0);
    expect(r.data.probabilityOfProfit).toBeGreaterThan(0);
    expect(r.meta.requestId).toBe("r1");
  });
  it("finds strategies within a budget", async () => {
    const { routes, ctx, md } = setup();
    const r = await routes.find(ctx(`underlying=NIFTY&expiry=${EXP}&view=rangebound&maxLoss=20000`));
    expect(r.data.results.length).toBeGreaterThan(0);
    expect(r.data.results.every((x) => !x.unboundedRisk)).toBe(true);
    expect(md.calls.every(([name]) => ["optionChain", "quotes"].includes(name))).toBe(true);
  });
  it("rejects bad input", async () => {
    const { routes, ctx } = setup();
    await expect(routes.build(ctx(`underlying=NIFTY&expiry=${EXP}&template=nope`))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(routes.find(ctx(`underlying=NIFTY&expiry=${EXP}&view=sideways`))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(routes.find(ctx(`underlying=NIFTY&expiry=${EXP}&view=neutral&maxLoss=-5`))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(routes.build(ctx(`underlying=NIFTY&expiry=bad&template=iron_condor`))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(routes.build(ctx(`underlying=NIFTY&expiry=${EXP}&template=iron_condor&offset=9&width=9`))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

it("registers read-scope GET routes only", () => {
  for (const [m, p, o] of strategyRoutes({ marketData: {} })) {
    expect(m).toBe("GET");
    expect(p).toMatch(/^\/v1\/analytics\/strategies/);
    expect(o).toEqual({ scope: "read" });
  }
});
