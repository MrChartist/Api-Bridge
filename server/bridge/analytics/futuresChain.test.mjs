import { describe, expect, it } from "vitest";
import { createFakeMarketData } from "../market/fake.mjs";
import { NEAR_FUTURES, futuresChainRoutes, seriesStats } from "./futuresChain.mjs";

const iso = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
// Futures are monthly, so each expiry sits mid-month in its own month (10 and 40 days ahead could share a month,
// e.g. 1 and 31 January, and the route would keep only the later one).
const midMonth = (ahead) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + ahead, 15)).toISOString().slice(0, 10);
};
const E1 = midMonth(1);
const E2 = midMonth(2);
const E3 = midMonth(3);

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

  it("adds the instrument master's futures when the option expiries stop before them (weekly-only option lists)", async () => {
    const md = createFakeMarketData();
    md.setExpiries("NIFTY", [E1]);
    md.setQuote("NSE:NIFTY", { ltp: 25000 });
    md.setQuote(`NFO:NIFTY-${E1}-FUT`, { ltp: 25050 });
    md.setQuote(`NFO:NIFTY-${E2}-FUT`, { ltp: 25150 });
    const symbols = { search: async (q) => ({ items: q.kind === "FUT" ? [E1, E2].map((expiry) => ({ underlying: "NIFTY", expiry })).concat([{ underlying: "NIFTYNXT50", expiry: E3 }]) : [] }) };
    const h = Object.fromEntries(futuresChainRoutes({ marketData: md, symbols }).map(([, path, , fn]) => [path, fn]));
    const r = await h["/v1/analytics/futures"]({ query: new URLSearchParams("underlying=NIFTY"), requestId: "r", requireAccountAccess() {} });
    expect(r.data.futures.map((f) => f.expiry)).toEqual([E1, E2]);
    expect(r.data.rollCostPct).toBe(0.399);
    expect(r.data.calendarSpreads).toHaveLength(1);
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

describe("futures: ?wait=near does not wait for the far months", () => {
  /** The fake market data, with quotes for a far future held until `release()` (a cold broker read). */
  function slowFar() {
    const { md } = setup();
    md.setQuote(`NFO:NIFTY-${E3}-FUT`, { ltp: 25250, oi: 600, volume: 100 });
    let release;
    const gate = new Promise((r) => (release = r));
    const asked = [];
    const marketData = {
      ...md,
      expiries: md.expiries,
      async quotes(list, opts) {
        asked.push([...list]);
        if (list.includes(`NFO:NIFTY-${E3}-FUT`)) await gate;
        return md.quotes(list, opts);
      },
    };
    const h = Object.fromEntries(futuresChainRoutes({ marketData }).map(([, path, , fn]) => [path, fn]));
    const ctx = (query) => ({ query: new URLSearchParams(query), requestId: "r1", requireAccountAccess() {} });
    return { h, ctx, release, asked };
  }

  it("answers with the near months and marks the far one pending; the default waits for every month", async () => {
    expect(NEAR_FUTURES).toBe(2);
    const { h, ctx, release, asked } = slowFar();
    const near = await h["/v1/analytics/futures"](ctx("underlying=NIFTY&expiries=3&wait=near"));
    expect(near.data.futures.map((f) => [f.expiry, f.ltp, f.pending ?? false])).toEqual([[E1, 25050, false], [E2, 25150, false], [E3, null, true]]);
    expect(near.data.futures[2]).toMatchObject({ basis: null, annualisedPct: null });
    expect(near.data.calendarSpreads[1].spread).toBeNull();
    expect(near.errors).toEqual([]);
    expect(asked).toEqual([[`NFO:NIFTY-${E3}-FUT`], ["NSE:NIFTY", `NFO:NIFTY-${E1}-FUT`, `NFO:NIFTY-${E2}-FUT`]]);
    const full = h["/v1/analytics/futures"](ctx("underlying=NIFTY&expiries=3"));
    release();
    const r = await full;
    expect(r.data.futures.map((f) => [f.expiry, f.ltp, f.pending ?? false])).toEqual([[E1, 25050, false], [E2, 25150, false], [E3, 25250, false]]);
    expect(r.data.calendarSpreads[1].spread).toBe(100);
  });

  it("uses a far quote that is already there, and changes nothing with two or fewer months", async () => {
    const { h, ctx, release } = slowFar();
    release();
    const r = await h["/v1/analytics/futures"](ctx("underlying=NIFTY&expiries=3&wait=near"));
    expect(r.data.futures.map((f) => f.pending ?? false)).toEqual([false, false, false]);
    expect(r.data.futures[2].ltp).toBe(25250);
    const two = await h["/v1/analytics/futures"](ctx("underlying=NIFTY&expiries=2&wait=near"));
    expect(two.data.futures.map((f) => f.ltp)).toEqual([25050, 25150]);
    await expect(h["/v1/analytics/futures"](ctx("underlying=NIFTY&wait=later"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
