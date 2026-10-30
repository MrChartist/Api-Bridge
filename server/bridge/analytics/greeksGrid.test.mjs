import { describe, expect, it } from "vitest";
import { greeksGrid, greeksGridRoutes, straddleHistory, straddleSummary, syntheticFutures } from "./greeksGrid.mjs";
import { createFakeMarketData } from "../market/fake.mjs";

const leg = (ltp, g = {}) => ({ symbol: "x", ltp, oi: 1, iv: 15, delta: 0.5, gamma: 0.001, theta: -5, vega: 2, ...g });
const chain = {
  underlying: "NIFTY",
  expiry: "2026-10-27",
  underlyingLtp: 25000,
  atmStrike: 25000,
  rows: [
    { strike: 24950, ce: leg(110, { gamma: 0.002, vega: 3, iv: 14 }), pe: leg(55, { gamma: 0.002, vega: 3, iv: 16 }) },
    { strike: 25000, ce: leg(80, { gamma: 0.004, vega: 5 }), pe: leg(75, { gamma: 0.004, vega: 5 }) },
    { strike: 25050, ce: leg(55, { gamma: 0.001, vega: 1 }), pe: null },
  ],
};
const ctx = (query) => ({ query: new URLSearchParams(query), requestId: "r1", principal: { kind: "local" }, requireAccountAccess() {} });

describe("pure functions", () => {
  it("greeksGrid totals and peaks", () => {
    const g = greeksGrid(chain);
    expect(g.totals.ce.gamma).toBe(0.007);
    expect(g.totals.pe.vega).toBe(8);
    expect(g.totals.ce.avgIv).toBe(14.67);
    expect(g.peakGammaStrike).toBe(25000);
    expect(g.peakVega.ce).toEqual({ strike: 25000, value: 5 });
    expect(g.strikes[2].pe.delta).toBeNull();
  });
  it("syntheticFutures uses parity and skips strikes without both legs", () => {
    const s = syntheticFutures(chain, { future: 25010 });
    expect(s.strikes.map((x) => x.strike)).toEqual([24950, 25000]);
    expect(s.strikes[0].synthetic).toBe(25005);
    expect(s.strikes[1].synthetic).toBe(25005);
    expect(s.strikes[0].vsSpot).toBe(5);
    expect(s.strikes[0].arbitrageGap).toBe(-5);
    expect(s.strikes[0].direction).toBe("buy-synthetic");
    expect(s.referenceSource).toBe("future");
    expect(syntheticFutures(chain).referenceSource).toBe("spot");
  });
  it("straddleHistory joins on time", () => {
    const h = straddleHistory([{ time: 1, close: 10 }, { time: 2, close: 12 }, { time: 3, close: 9 }], [{ time: 2, close: 8 }, { time: 3, close: 7 }, { time: 4, close: 1 }]);
    expect(h).toEqual([{ time: 2, ce: 12, pe: 8, straddle: 20 }, { time: 3, ce: 9, pe: 7, straddle: 16 }]);
  });
  it("straddleSummary computes change and implied move", () => {
    const s = straddleSummary(chain, [{ time: 1, ce: 70, pe: 70, straddle: 140 }]);
    expect(s.premium).toBe(155);
    expect(s.changePct).toBe(10.71);
    expect(s.impliedMovePct).toBe(0.62);
    expect(s.upperBreakeven).toBe(25155);
    expect(straddleSummary({ rows: [] }).premium).toBeNull();
  });
});

describe("routes", () => {
  const sym = (k, r) => `NFO:NIFTY-2026-10-27-${k}-${r}`;
  function setup() {
    const md = createFakeMarketData({ prices: { "NSE:NIFTY": 25000, "NFO:NIFTY-2026-10-27-FUT": 25012 } });
    md.setChain("NIFTY", "2026-10-27", { underlyingLtp: 25000, lotSize: 75, rows: chain.rows.map((r) => ({ ...r, ce: { ...r.ce, symbol: sym(r.strike, "CE") }, pe: r.pe && { ...r.pe, symbol: sym(r.strike, "PE") } })) });
    md.setCandles(sym(25000, "CE"), "5m", [{ time: 100, close: 70 }, { time: 200, close: 75 }].map((c) => ({ open: c.close, high: c.close, low: c.close, volume: 1, ...c })));
    md.setCandles(sym(25000, "PE"), "5m", [{ time: 100, close: 60 }, { time: 200, close: 70 }].map((c) => ({ open: c.close, high: c.close, low: c.close, volume: 1, ...c })));
    const routes = Object.fromEntries(greeksGridRoutes({ marketData: md }).map(([m, p, o, h]) => [p, { m, o, h }]));
    return { md, routes };
  }
  it("exposes three read GET routes", () => {
    const { routes } = setup();
    expect(Object.keys(routes).sort()).toEqual(["/v1/analytics/greeks-grid", "/v1/analytics/straddle", "/v1/analytics/synthetic"]);
    for (const r of Object.values(routes)) expect([r.m, r.o]).toEqual(["GET", { scope: "read" }]);
  });
  it("greeks-grid", async () => {
    const { routes } = setup();
    const r = await routes["/v1/analytics/greeks-grid"].h(ctx("underlying=nifty&expiry=2026-10-27"));
    expect(r.data.peakGammaStrike).toBe(25000);
    expect(r.meta.requestId).toBe("r1");
  });
  it("synthetic uses the futures quote", async () => {
    const { routes } = setup();
    const r = await routes["/v1/analytics/synthetic"].h(ctx("underlying=NIFTY&expiry=2026-10-27"));
    expect(r.data.future).toBe(25012);
    expect(r.data.strikes[1].arbitrageGap).toBe(-7);
  });
  it("synthetic falls back to spot when futures quote fails", async () => {
    const { md, routes } = setup();
    md.fail("NFO:NIFTY-2026-10-27-FUT");
    const r = await routes["/v1/analytics/synthetic"].h(ctx("underlying=NIFTY&expiry=2026-10-27"));
    expect(r.data.referenceSource).toBe("spot");
    expect(r.errors).toHaveLength(1);
  });
  it("straddle joins candle history", async () => {
    const { md, routes } = setup();
    const r = await routes["/v1/analytics/straddle"].h(ctx("underlying=NIFTY&expiry=2026-10-27&countback=10"));
    expect(r.data.history.map((h) => h.straddle)).toEqual([130, 145]);
    expect(r.data.premium).toBe(155);
    expect(r.data.changePct).toBe(19.23);
    expect(md.calls.filter((c) => c[0] === "history")[0][1]).toMatchObject({ interval: "5m", countback: 10 });
  });
  it("validates params", async () => {
    const { routes } = setup();
    const h = routes["/v1/analytics/straddle"].h;
    await expect(h(ctx("underlying=NIFTY&expiry=bad"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(h(ctx("underlying=NIFTY&expiry=2026-10-27&interval=2m"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(h(ctx("underlying=NIFTY&expiry=2026-10-27&countback=0"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(routes["/v1/analytics/greeks-grid"].h(ctx("expiry=2026-10-27"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
