import { describe, expect, it } from "vitest";
import { classifyBuildUp, createOiSnapshotStore, oiChange, oiSpurts, oiTrackerRoutes, snapshotFromChain } from "./oiTracker.mjs";
import { createFakeMarketData } from "../market/fake.mjs";

const leg = (oi, ltp) => ({ oi, ltp });
const chainOf = (rows, spot = 25000) => ({ underlying: "NIFTY", expiry: "2026-10-27", underlyingLtp: spot, rows: rows.map(([strike, ce, pe]) => ({ strike, ce, pe })) });
const MIN = 60_000;

describe("classifyBuildUp", () => {
  it("maps price and OI direction", () => {
    expect(classifyBuildUp(1, 10)).toBe("long_build_up");
    expect(classifyBuildUp(-1, 10)).toBe("short_build_up");
    expect(classifyBuildUp(-1, -10)).toBe("long_unwinding");
    expect(classifyBuildUp(1, -10)).toBe("short_covering");
    expect(classifyBuildUp(0, 10)).toBeNull();
    expect(classifyBuildUp(null, 10)).toBeNull();
  });
});

describe("snapshot store", () => {
  it("is bounded per key and overall, and merges rapid reads", () => {
    let t = 0;
    const store = createOiSnapshotStore({ clock: { now: () => t }, maxSnapshots: 3, maxKeys: 2, minIntervalMs: 1000 });
    const c = chainOf([[25000, leg(1, 1), leg(1, 1)]]);
    for (let i = 0; i < 5; i++) {
      t = i * 2000;
      store.record("nifty", "e", c);
    }
    expect(store.snapshots("NIFTY", "e")).toHaveLength(3);
    t += 10;
    store.record("NIFTY", "e", c);
    expect(store.snapshots("NIFTY", "e")).toHaveLength(3);
    store.record("A", "e", c);
    store.record("B", "e", c);
    expect(store.snapshots("NIFTY", "e")).toHaveLength(0);
  });
});

describe("oiChange", () => {
  const s = (ts, rows) => snapshotFromChain(chainOf(rows), ts);
  const snaps = [
    s(0, [[25000, leg(1000, 100), leg(1000, 100)], [25100, leg(500, 50), leg(500, 80)]]),
    s(10 * MIN, [[25000, leg(1100, 110), leg(1000, 100)], [25100, leg(500, 50), leg(500, 80)]]),
    s(20 * MIN, [[25000, leg(1200, 120), leg(900, 110)], [25100, leg(600, 40), leg(400, 70)]]),
  ];
  it("classifies against the snapshot at the window start", () => {
    const r = oiChange(snaps, { windowMs: 20 * MIN });
    expect(r.windowCovered).toBe(true);
    expect(r.from).toBe(0);
    const row = (strike, side) => r.rows.find((x) => x.strike === strike && x.side === side);
    expect(row(25000, "CE")).toMatchObject({ oiChange: 200, oiChangePct: 20, priceChange: 20, buildUp: "long_build_up" });
    expect(row(25000, "PE")).toMatchObject({ oiChange: -100, buildUp: "short_covering" });
    expect(row(25100, "CE")).toMatchObject({ buildUp: "short_build_up" });
    expect(row(25100, "PE")).toMatchObject({ buildUp: "long_unwinding" });
    expect(r.rows[0].oiChange).toBe(200);
    expect(r.totals).toEqual({ ceOiChange: 300, peOiChange: -200, netOiChange: -500 });
  });
  it("uses a shorter window and flags partial coverage", () => {
    expect(oiChange(snaps, { windowMs: 10 * MIN }).from).toBe(10 * MIN);
    const r = oiChange(snaps, { windowMs: 60 * MIN, top: 2 });
    expect(r.windowCovered).toBe(false);
    expect(r.from).toBe(0);
    expect(r.rows).toHaveLength(2);
  });
  it("returns no rows with fewer than two snapshots", () => {
    expect(oiChange(snaps.slice(0, 1)).rows).toEqual([]);
    expect(oiChange([]).rows).toEqual([]);
  });
});

describe("oiSpurts", () => {
  const s = (ts, ce1, ce2) => snapshotFromChain(chainOf([[25000, leg(ce1, 100), leg(100, 1)], [25100, leg(ce2, 50), leg(100, 1)]]), ts);
  const snaps = [s(0, 1000, 1000), s(5 * MIN, 1010, 1100), s(10 * MIN, 1020, 1200), s(15 * MIN, 1500, 1330)];
  it("ranks the biggest jump against baseline", () => {
    const r = oiSpurts(snaps, { minChangePct: 5 });
    expect(r.baselineIntervals).toBe(2);
    expect(r.spurts).toHaveLength(2);
    expect(r.spurts[0]).toMatchObject({ strike: 25000, side: "CE", oiChange: 480, baselineAvgChange: 10, multiple: 48 });
    expect(r.spurts[1]).toMatchObject({ strike: 25100, side: "CE", multiple: 1.3 });
  });
  it("filters by minChangePct and top", () => {
    expect(oiSpurts(snaps, { minChangePct: 20 }).spurts.map((x) => x.strike)).toEqual([25000]);
    expect(oiSpurts(snaps, { minChangePct: 0, top: 1 }).spurts).toHaveLength(1);
  });
  it("works on two snapshots without a baseline", () => {
    const r = oiSpurts(snaps.slice(2), { minChangePct: 5 });
    expect(r.spurts[0].multiple).toBeNull();
    expect(r.spurts[0].strike).toBe(25000);
  });
});

describe("oiTrackerRoutes", () => {
  let t = 1_000_000;
  const md = createFakeMarketData({ prices: { "NSE:NIFTY": 25010 } });
  const routes = oiTrackerRoutes({ marketData: md, clock: { now: () => t } });
  const ctx = (query = "") => ({ query: new URLSearchParams(query), requestId: "r1", principal: { kind: "local" }, requireAccountAccess() {} });
  const get = (path) => routes.find((r) => r[1] === path);

  it("declares read-scope GET routes", () => {
    expect(routes.map((r) => [r[0], r[1], r[2]])).toEqual([
      ["GET", "/v1/analytics/oi-change", { scope: "read" }],
      ["GET", "/v1/analytics/oi-spurts", { scope: "read" }],
    ]);
  });
  it("serves data and meta, building history across calls", async () => {
    const q = "underlying=NIFTY&expiry=2026-10-27&strikes=3";
    const a = await get("/v1/analytics/oi-change")[3](ctx(q));
    expect(a.data.snapshots).toBe(1);
    expect(a.meta.requestId).toBe("r1");
    t += 5 * MIN;
    const b = await get("/v1/analytics/oi-change")[3](ctx(`${q}&windowMin=5`));
    expect(b.data.snapshots).toBe(2);
    expect(b.data.underlying).toBe("NIFTY");
    expect(b.meta.freshness).toBeTruthy();
    const c = await get("/v1/analytics/oi-spurts")[3](ctx(q));
    expect(Array.isArray(c.data.spurts)).toBe(true);
  });
  it("rejects bad input", async () => {
    const h = get("/v1/analytics/oi-change")[3];
    await expect(h(ctx("expiry=2026-10-27"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(h(ctx("underlying=NIFTY&expiry=27-10-2026"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(h(ctx("underlying=NIFTY&expiry=2026-10-27&windowMin=0"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(get("/v1/analytics/oi-spurts")[3](ctx("underlying=NIFTY&expiry=2026-10-27&top=abc"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
