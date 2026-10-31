import { describe, expect, it } from "vitest";
import { createDemoAdapter } from "../demo/demoAdapter.mjs";
import { createFakeMarketData } from "../market/fake.mjs";
import { depthLevelsParam } from "../market/routes.mjs";
import { LARGE_MULTIPLE, depthProfile, depthProfileRoutes } from "./depthProfile.mjs";

const book = {
  bids: [
    { price: 99.9, qty: 100, orders: 2 },
    { price: 100, qty: 200, orders: 4 },
    { price: 99.8, qty: 1500, orders: 3 },
    { price: 99.7, qty: 150, orders: 1 },
    { price: -1, qty: 10 },
  ],
  asks: [
    { price: 100.2, qty: 120, orders: 1 },
    { price: 100.1, qty: 100, orders: 2 },
    { price: 100.3, qty: 180, orders: 3 },
  ],
};

describe("depthProfile", () => {
  it("sorts each side, runs the totals and finds large levels", () => {
    const p = depthProfile(book);
    expect(p.levels).toEqual({ bids: 4, asks: 3 });
    expect(p.bids.map((b) => b.price)).toEqual([100, 99.9, 99.8, 99.7]);
    expect(p.asks.map((a) => a.price)).toEqual([100.1, 100.2, 100.3]);
    expect(p.bids.map((b) => b.cum)).toEqual([200, 300, 1800, 1950]);
    expect(p.bids[3].cumShare).toBe(1);
    expect(p).toMatchObject({ bestBid: 100, bestAsk: 100.1, spread: 0.1, mid: 100.05 });
    expect(p.spreadBps).toBeCloseTo((0.1 / 100.05) * 10_000, 2);
    // Microprice leans to the side with less size at the touch (200 bid vs 100 ask -> nearer the ask).
    expect(p.microprice).toBeCloseTo((100.1 * 200 + 100 * 100) / 300, 4);
    expect(p.totals).toEqual({ bidQty: 1950, askQty: 400, bidOrders: 10, askOrders: 6 });
    expect(p.imbalance).toBeCloseTo((1950 - 400) / 2350, 4);
    // Median of all seven levels is 150, so 1500 (>= 3 x 150) is large and nothing else is.
    expect(p.medianLevelQty).toBe(150);
    expect(p.largeMultiple).toBe(LARGE_MULTIPLE);
    expect(p.bids.filter((b) => b.large).map((b) => b.price)).toEqual([99.8]);
    expect(p.walls.bids[0]).toMatchObject({ price: 99.8, qty: 1500, level: 3 });
    expect(p.bids[2].share).toBe(1);
    expect(p.bids[0].avgOrder).toBe(50);
    expect(p.bids[0].distanceBps).toBeLessThan(0);
    expect(p.asks[0].distanceBps).toBeGreaterThan(0);
  });

  it("copes with an empty or one-sided book", () => {
    const e = depthProfile({});
    expect(e).toMatchObject({ levels: { bids: 0, asks: 0 }, bestBid: null, bestAsk: null, mid: null, spread: null, imbalance: null, microprice: null });
    const one = depthProfile({ bids: [{ price: 10, qty: 5, orders: null }] });
    expect(one).toMatchObject({ bestBid: 10, bestAsk: null, mid: 10, imbalance: 1, spread: null });
    expect(one.totals.bidOrders).toBeNull();
  });
});

describe("levels", () => {
  it("accepts 5, 20 or 200 only", () => {
    expect(depthLevelsParam(new URLSearchParams(""))).toBeUndefined();
    expect(depthLevelsParam(new URLSearchParams("levels=200"))).toBe(200);
    expect(() => depthLevelsParam(new URLSearchParams("levels=50"))).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("the demo adapter answers the depth asked for", async () => {
    const demo = createDemoAdapter({ now: () => Date.parse("2026-10-30T05:00:00Z") });
    const ref = { token: "DM-RELIANCE", exchange: "NSE" };
    const r5 = await demo.fetchDepth({}, ref);
    expect(r5.data.bids).toHaveLength(5);
    const r20 = await demo.fetchDepth({}, ref, { levels: 20 });
    expect(r20.data.asks).toHaveLength(20);
    const r200 = await demo.fetchDepth({}, ref, { levels: 200 });
    expect(r200.data.asks).toHaveLength(200);
    // Asks rise and bids fall away from the touch.
    const asks = r200.data.asks.map((l) => l.price);
    expect(asks.every((p, i) => i === 0 || p >= asks[i - 1])).toBe(true);
    expect(r200.data.bids.every((l) => l.price > 0 && l.qty > 0)).toBe(true);
  });
});

describe("GET /v1/analytics/depth-profile", () => {
  it("reads depth once through marketData with the levels hint", async () => {
    const md = createFakeMarketData({});
    md.setDepth("NSE:RELIANCE", book);
    const [[method, path, options, handler]] = depthProfileRoutes({ marketData: md });
    expect([method, path, options]).toEqual(["GET", "/v1/analytics/depth-profile", { scope: "read" }]);
    const r = await handler({ requestId: "r", query: new URLSearchParams("symbol=NSE:RELIANCE&levels=20"), principal: { kind: "local" } });
    expect(r.data).toMatchObject({ symbol: "NSE:RELIANCE", requestedLevels: 20, levels: { bids: 4, asks: 3 } });
    const calls = md.calls.filter((c) => c[0] === "depth");
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toMatchObject({ levels: 20 });
    await expect(handler({ requestId: "r", query: new URLSearchParams(""), principal: { kind: "local" } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
