import { describe, expect, it } from "vitest";
import { createFakeMarketData } from "../market/fake.mjs";
import { futuresChainRoutes, seriesStats } from "./futuresChain.mjs";

const iso = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const E1 = iso(10);
const E2 = iso(40);
const E3 = iso(70);

function setup() {
  const md = createFakeMarketData();
  md.setExpiries("NIFTY", [iso(-5), E1, E2, E3]);
  md.setQuote("NSE:NIFTY", { ltp: 25000 });
  md.setQuote(`NFO:NIFTY-${E1}-FUT`, { ltp: 25050, oi: 1000, volume: 500 });
  md.setQuote(`NFO:NIFTY-${E2}-FUT`, { ltp: 25150, oi: 800, volume: 300 });
  const routes = futuresChainRoutes({ marketData: md });
  const h = Object.fromEntries(routes.map(([, path, , fn]) => [path, fn]));
  const ctx = (query) => ({ query: new URLSearchParams(query), requestId: "r1", requireAccountAccess() {} });
  return { md, routes, h, ctx };
}

describe("futuresChainRoutes", () => {
  it("exports read-scope GET routes", () => {
    const { routes } = setup();
    expect(routes.map((r) => r.slice(0, 3))).toEqual([
      ["GET", "/v1/analytics/futures", { scope: "read" }],
      ["GET", "/v1/analytics/basis-history", { scope: "read" }],
    ]);
  });

  it("returns futures, spreads and roll cost; missing quotes go in errors", async () => {
    const { h, ctx } = setup();
    const r = await h["/v1/analytics/futures"](ctx("underlying=nifty&expiries=3"));
    expect(r.data.futures.map((f) => f.expiry)).toEqual([E1, E2, E3]);
    expect(r.data.futures[0]).toMatchObject({ ltp: 25050, oi: 1000, volume: 500, basis: 50, state: "contango" });
    expect(r.data.futures[0].annualisedPct).toBeGreaterThan(0);
    expect(r.data.futures[2].ltp).toBeNull();
    expect(r.errors).toHaveLength(1);
    expect(r.data.calendarSpreads[0]).toMatchObject({ near: E1, far: E2, spread: 100, spreadPct: 0.399 });
    expect(r.data.calendarSpreads[1].spread).toBeNull();
    expect(r.data.rollCostPct).toBe(0.399);
    expect(r.meta.requestId).toBe("r1");
  });

  it("validates input", async () => {
    const { h, ctx } = setup();
    await expect(h["/v1/analytics/futures"](ctx(""))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(h["/v1/analytics/futures"](ctx("underlying=NIFTY&expiries=9"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(h["/v1/analytics/basis-history"](ctx("underlying=NIFTY"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(h["/v1/analytics/basis-history"](ctx(`underlying=NIFTY&expiry=${E1}&interval=2d`))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("joins candles on time and computes stats", async () => {
    const { md, h, ctx } = setup();
    const c = (time, close) => ({ time, open: close, high: close, low: close, close, volume: 1 });
    md.setCandles(`NFO:NIFTY-${E1}-FUT`, "1d", [c(1, 100), c(2, 110), c(3, 120), c(4, 999)]);
    md.setCandles("NSE:NIFTY", "1d", [c(1, 98), c(2, 100), c(3, 100)]);
    const r = await h["/v1/analytics/basis-history"](ctx(`underlying=NIFTY&expiry=${E1}`));
    expect(r.data.series.map((p) => p.basis)).toEqual([2, 10, 20]);
    expect(r.data.series[0].basisPct).toBe(2.041);
    expect(r.data.basis).toMatchObject({ count: 3, min: 2, max: 20, latest: 20 });
    expect(r.data.basis.mean).toBeCloseTo(10.6667, 3);
    expect(r.data.basis.zScore).toBeGreaterThan(1);
    expect(r.errors).toEqual([]);
  });

  it("reports a failed leg in errors", async () => {
    const { h, ctx } = setup();
    const r = await h["/v1/analytics/basis-history"](ctx(`underlying=NIFTY&expiry=${E1}`));
    expect(r.data.series).toEqual([]);
    expect(r.errors).toHaveLength(2);
    expect(r.data.basis.zScore).toBeNull();
  });

  it("seriesStats handles flat and tiny series", () => {
    expect(seriesStats([5, 5, 5]).zScore).toBeNull();
    expect(seriesStats([]).count).toBe(0);
  });
});
