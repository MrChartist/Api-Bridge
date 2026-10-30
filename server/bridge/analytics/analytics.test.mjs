import { describe, expect, it } from "vitest";
import { futuresBasis, gammaExposure, ivSkew, maxPain, oiAnalysis, positionSize, strategyPayoff } from "./math.mjs";
import { createAnalyticsRoutes } from "./routes.mjs";
import { createFakeMarketData } from "../market/fake.mjs";

const leg = (oi, extra = {}) => ({ symbol: "x", oi, oiChange: 0, volume: 0, iv: 15, gamma: 0.001, ...extra });
const chain = {
  underlying: "NIFTY",
  expiry: "2026-10-27",
  underlyingLtp: 25000,
  atmStrike: 25000,
  lotSize: 75,
  rows: [
    { strike: 24900, ce: leg(100, { oiChange: 10, volume: 5, iv: 14 }), pe: leg(500, { oiChange: 40, volume: 20, iv: 18 }) },
    { strike: 25000, ce: leg(300, { oiChange: 30, volume: 10, iv: 15 }), pe: leg(300, { oiChange: 20, volume: 10, iv: 15 }) },
    { strike: 25100, ce: leg(600, { oiChange: 60, volume: 40, iv: 13 }), pe: leg(100, { oiChange: 5, volume: 5, iv: 14 }) },
  ],
};

describe("oiAnalysis", () => {
  it("computes PCR, max pain, support and resistance", () => {
    const r = oiAnalysis(chain);
    expect(r.totals.ceOi).toBe(1000);
    expect(r.totals.peOi).toBe(900);
    expect(r.pcrOi).toBe(0.9);
    expect(r.pcrVolume).toBe(0.636);
    expect(r.resistance[0]).toEqual({ strike: 25100, value: 600 });
    expect(r.support[0]).toEqual({ strike: 24900, value: 500 });
    expect(r.maxPain).toBe(25000);
  });
  it("gives null ratios for an empty chain", () => {
    const r = oiAnalysis({ rows: [] });
    expect(r.pcrOi).toBeNull();
    expect(r.maxPain).toBeNull();
  });
  it("maxPain picks the cheapest settlement", () => {
    expect(maxPain(chain.rows)).toBe(25000);
  });
});

describe("gammaExposure", () => {
  it("signs calls positive and puts negative", () => {
    const g = gammaExposure(chain);
    expect(g.strikes[0].callGex).toBeGreaterThan(0);
    expect(g.strikes[0].putGex).toBeLessThan(0);
    expect(g.netGex).toBe(g.strikes.reduce((t, s) => t + s.netGex, 0));
    expect(["positive", "negative", "neutral"]).toContain(g.regime);
  });
});

describe("ivSkew", () => {
  it("reads ATM IV and the risk reversal", () => {
    const s = ivSkew(chain, { width: 1 });
    expect(s.atmIv).toBe(15);
    expect(s.putStrike).toBe(24900);
    expect(s.callStrike).toBe(25100);
    expect(s.riskReversal).toBe(5);
    expect(s.skew).toBe("put-heavy");
  });
});

describe("strategyPayoff", () => {
  const bullCall = [
    { type: "CE", side: "buy", strike: 100, price: 6, lots: 1, lotSize: 1 },
    { type: "CE", side: "sell", strike: 110, price: 2, lots: 1, lotSize: 1 },
  ];
  it("finds a bounded spread's max profit, loss and break-even", () => {
    const r = strategyPayoff(bullCall, { spot: 105, from: 80, to: 130, step: 1 });
    expect(r.maxProfit).toBe(6);
    expect(r.maxLoss).toBe(-4);
    expect(r.breakevens).toEqual([104]);
    expect(r.netPremium).toBe(-4);
  });
  it("flags an unbounded short call", () => {
    const r = strategyPayoff([{ type: "CE", side: "sell", strike: 100, price: 5, lots: 1, lotSize: 1 }], { from: 80, to: 130, step: 1 });
    expect(r.unboundedLoss).toBe(true);
    expect(r.maxLoss).toBeNull();
    expect(r.maxProfit).toBe(5);
  });
});

describe("positionSize and futuresBasis", () => {
  it("sizes lots from the risk budget", () => {
    const r = positionSize({ capital: 1_000_000, riskPct: 1, entry: 100, stop: 90, lotSize: 50 });
    expect(r.riskAmount).toBe(10000);
    expect(r.lots).toBe(20);
    expect(r.capitalAtRisk).toBe(10000);
    expect(r.direction).toBe("long");
  });
  it("returns zero lots when entry equals stop", () => {
    expect(positionSize({ capital: 1, riskPct: 1, entry: 5, stop: 5 }).lots).toBe(0);
  });
  it("annualises the basis", () => {
    const b = futuresBasis({ spot: 25000, future: 25100, daysToExpiry: 30 });
    expect(b.basis).toBe(100);
    expect(b.basisPct).toBe(0.4);
    expect(b.annualisedPct).toBe(4.87);
    expect(b.state).toBe("contango");
  });
});

describe("analytics routes", () => {
  const md = createFakeMarketData({ prices: { "NSE:NIFTY": 25010 } });
  const routes = createAnalyticsRoutes({ marketData: md });
  const ctx = (query = "", body) => ({ query: new URLSearchParams(query), body, requestId: "r1", principal: { kind: "local" }, requireAccountAccess() {} });

  it("serves OI for a fake chain", async () => {
    const r = await routes.oi(ctx("underlying=NIFTY&expiry=2026-10-27&strikes=3"));
    expect(r.data.underlying).toBe("NIFTY");
    expect(r.meta.freshness).toBeTruthy();
  });
  it("rejects a bad expiry", async () => {
    await expect(routes.gex(ctx("underlying=NIFTY&expiry=27-10-2026"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("calculates Greeks from IV and recovers IV from the price", async () => {
    const a = await routes.greeks(ctx("spot=25000&strike=25000&type=CE&days=10&iv=15"));
    expect(a.data.delta).toBeGreaterThan(0.4);
    const b = await routes.greeks(ctx(`spot=25000&strike=25000&type=CE&days=10&price=${a.data.price}`));
    expect(b.data.ivPct).toBeCloseTo(15, 1);
  });
  it("needs exactly one of iv and price", async () => {
    await expect(routes.greeks(ctx("spot=1&strike=1&type=CE&days=1"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("validates the payoff and position-size bodies", async () => {
    await expect(routes.payoff(ctx("", { legs: [{ type: "CE", side: "buy", price: 1 }] }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(routes.positionSize(ctx("", { capital: -1 }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const ok = await routes.positionSize(ctx("", { capital: 100000, riskPct: 2, entry: 200, stop: 180 }));
    expect(ok.data.lots).toBe(100);
  });
});
