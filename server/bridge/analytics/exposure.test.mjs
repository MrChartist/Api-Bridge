import { describe, expect, it } from "vitest";
import { bsVanna, bsCharm, greekExposure, exposureAcrossExpiries, oiMatrix, exposureRoutes } from "./exposure.mjs";
import { gammaExposure } from "./math.mjs";
import { computeGreeks } from "../../lib/blackScholes.mjs";
import { createFakeMarketData } from "../market/fake.mjs";

const leg = (o = {}) => ({ symbol: "x", ltp: 50, oi: 100, iv: 15, delta: 0.5, gamma: 0.001, ...o });
const chain = (rows, extra = {}) => ({ underlying: "NIFTY", expiry: "2026-11-03", underlyingLtp: 25000, lotSize: 75, atmStrike: 25000, rows, ...extra });
const base = chain([
  { strike: 24900, ce: leg({ delta: 0.7, gamma: 0.0008, oi: 200 }), pe: leg({ delta: -0.3, gamma: 0.0008, oi: 900 }) },
  { strike: 25000, ce: leg({ gamma: 0.0012, oi: 500 }), pe: leg({ delta: -0.5, gamma: 0.0012, oi: 400 }) },
  { strike: 25100, ce: leg({ delta: 0.3, gamma: 0.0008, oi: 1200 }), pe: leg({ delta: -0.7, gamma: 0.0008, oi: 100 }) },
]);

describe("vanna and charm vs finite differences", () => {
  for (const [spot, strike, vol, days] of [[25000, 25000, 0.15, 7], [25000, 25500, 0.2, 12], [25000, 24500, 0.12, 30]]) {
    for (const type of ["CE", "PE"]) {
      it(`${type} ${strike} vol ${vol} d${days}`, () => {
        const delta = (v, d) => computeGreeks({ spot, strike, daysToExpiry: d, type, vol: v }).delta;
        const h = 1e-3;
        const fdVanna = (delta(vol + h, days) - delta(vol - h, days)) / (2 * h) / 100;
        const fdCharm = (delta(vol, days - 0.01) - delta(vol, days + 0.01)) / 0.02; // delta change per day elapsed
        const v = bsVanna({ spot, strike, days, vol });
        const c = bsCharm({ spot, strike, days, vol });
        expect(Math.abs(v - fdVanna)).toBeLessThan(Math.max(1e-6, Math.abs(fdVanna) * 0.02));
        expect(Math.abs(c - fdCharm)).toBeLessThan(Math.max(1e-6, Math.abs(fdCharm) * 0.02));
      });
    }
  }
  it("degenerate inputs give 0", () => {
    expect(bsVanna({ spot: 0, strike: 1, days: 1, vol: 0.1 })).toBe(0);
    expect(bsCharm({ spot: 1, strike: 1, days: 1, vol: 0 })).toBe(0);
  });
});

describe("greekExposure", () => {
  const e = greekExposure(base, { days: 7 });
  it("gamma matches math.mjs gammaExposure", () => {
    const g = gammaExposure(base);
    expect(e.strikes.map((s) => s.netGex)).toEqual(g.strikes.map((s) => s.netGex));
    expect(e.totals.netGex).toBe(g.netGex);
    expect(e.zeroGammaLevel).toBe(g.flipStrike);
  });
  it("delta exposure uses +calls -puts x OI x lot", () => {
    expect(e.strikes[1].callDelta).toBe(0.5 * 500 * 75);
    expect(e.strikes[1].putDelta).toBe(-1 * -0.5 * 400 * 75);
    expect(e.strikes[0].netDelta).toBe(0.7 * 200 * 75 + 0.3 * 900 * 75);
  });
  it("vanna/charm sign convention and units", () => {
    const v = bsVanna({ spot: 25000, strike: 25000, days: 7, vol: 0.15 });
    expect(e.strikes[1].callVanna).toBe(Math.round(v * 500 * 75));
    expect(e.strikes[1].putVanna).toBe(Math.round(-v * 400 * 75));
  });
  it("walls and peaks", () => {
    expect(e.callWall).toBe(25100 === 25100 ? e.strikes.reduce((b, s) => (s.callGex > b.callGex ? s : b)).strike : 0);
    expect(e.putWall).toBe(24900);
    expect(e.peakStrikes.gamma).not.toBeNull();
    expect(e.skippedLegs).toBe(0);
  });
  it("skips null IV / gamma legs and never yields NaN", () => {
    const c = chain([
      { strike: 24900, ce: leg({ iv: null }), pe: leg({ gamma: null }) },
      { strike: 25000, ce: leg({ iv: NaN }), pe: leg({ oi: 0, iv: null }) },
      { strike: 25100, ce: null, pe: undefined },
    ]);
    const r = greekExposure(c, { days: 0 });
    expect(r.skippedLegs).toBe(3);
    expect(r.totals).toEqual({ netDelta: 0, netGex: 0, netVanna: 0, netCharm: 0 });
    expect(r.callWall).toBeNull();
    expect(JSON.stringify(r)).not.toMatch(/NaN|null,"strikes":\[\]x/);
    const empty = greekExposure({ rows: [] });
    expect(empty.strikes).toEqual([]);
    expect(greekExposure(chain(base.rows, { underlyingLtp: null })).skippedLegs).toBe(6);
  });
});

describe("expiries aggregate and OI matrix", () => {
  const a = greekExposure(base, { days: 3 });
  const b = greekExposure({ ...base, expiry: "2026-11-10", rows: base.rows.map((r) => ({ ...r, ce: { ...r.ce, oi: r.ce.oi * 3 } })) }, { days: 10 });
  it("shares sum to 1 and totals add", () => {
    const x = exposureAcrossExpiries([a, b]);
    expect(x.expiries.reduce((t, e) => t + e.gexShare, 0)).toBeCloseTo(1, 3);
    expect(x.totals.netGex).toBe(a.totals.netGex + b.totals.netGex);
    expect(x.strikes).toHaveLength(3);
    expect(exposureAcrossExpiries([]).expiries).toEqual([]);
  });
  it("oiMatrix totals and top cells", () => {
    const m = oiMatrix([{ expiry: "2026-11-03", chain: base }, { expiry: "2026-11-10", chain: chain([{ strike: 25000, ce: leg({ oi: 5000 }), pe: null }]) }]);
    expect(m.strikes.map((s) => s.strike)).toEqual([24900, 25000, 25100]);
    expect(m.strikes[1].callOi).toBe(5500);
    expect(m.columns[0].putOi).toBe(1400);
    expect(m.totals.callOi).toBe(6900);
    expect(m.topCells[0]).toEqual({ strike: 25000, expiry: "2026-11-10", side: "CE", oi: 5000 });
    expect(m.strikes[0].cells[1]).toMatchObject({ callOi: 0, putOi: 0 });
  });
});

describe("routes", () => {
  const ctx = (q) => ({ query: new URLSearchParams(q), requestId: "r1", principal: { kind: "local" }, requireAccountAccess() {} });
  function setup() {
    const md = createFakeMarketData({ prices: { "NSE:NIFTY": 25000 } });
    md.setExpiries("NIFTY", ["2020-01-01", "2099-01-07", "2099-01-14", "2099-01-21"]);
    for (const e of ["2099-01-07", "2099-01-14", "2099-01-21"]) md.setChain("NIFTY", e, { ...base, expiry: e });
    const routes = Object.fromEntries(exposureRoutes({ marketData: md, now: () => Date.parse("2098-12-30T04:00:00Z") }).map(([m, p, o, h]) => [p, { m, o, h }]));
    return { md, routes };
  }
  it("exposes three read GETs", () => {
    const { routes } = setup();
    expect(Object.keys(routes).sort()).toEqual(["/v1/analytics/exposure", "/v1/analytics/exposure/expiries", "/v1/analytics/oi-explorer"]);
    for (const r of Object.values(routes)) expect([r.m, r.o]).toEqual(["GET", { scope: "read" }]);
  });
  it("exposure", async () => {
    const { routes } = setup();
    const r = await routes["/v1/analytics/exposure"].h(ctx("underlying=nifty&expiry=2099-01-07"));
    expect(r.data.strikes).toHaveLength(3);
    expect(r.data.daysToExpiry).toBeGreaterThan(7);
    expect(r.meta.requestId).toBe("r1");
  });
  it("expiries skips past expiries and honours count", async () => {
    const { routes } = setup();
    const r = await routes["/v1/analytics/exposure/expiries"].h(ctx("underlying=NIFTY&expiries=2"));
    expect(r.data.expiries.map((e) => e.expiry)).toEqual(["2099-01-07", "2099-01-14"]);
  });
  it("oi-explorer defaults to up to 4 expiries", async () => {
    const { routes } = setup();
    const r = await routes["/v1/analytics/oi-explorer"].h(ctx("underlying=NIFTY"));
    expect(r.data.expiries).toHaveLength(3);
    expect(r.data.totals.callOi).toBe(3 * 1900);
  });
  it("validates", async () => {
    const { routes } = setup();
    await expect(routes["/v1/analytics/exposure"].h(ctx("underlying=NIFTY&expiry=bad"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(routes["/v1/analytics/oi-explorer"].h(ctx("underlying=NIFTY&expiries=99"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(routes["/v1/analytics/oi-explorer"].h(ctx(""))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
