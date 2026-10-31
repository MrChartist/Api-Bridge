import { describe, expect, it } from "vitest";
import { bsVanna, bsCharm, greekExposure, exposureAcrossExpiries, oiMatrix, exposureRoutes, SESSION_POINTS, gexSession, snapshotChain, snapshotExposure, thinEvenly } from "./exposure.mjs";
import { gammaExposure } from "./math.mjs";
import { computeGreeks } from "../../lib/blackScholes.mjs";
import { createFakeMarketData } from "../market/fake.mjs";

const leg = (o = {}) => ({ symbol: "x", ltp: 50, oi: 100, iv: 15, delta: 0.5, gamma: 0.001, ...o });
const chain = (rows, extra = {}) => ({ underlying: "NIFTY", expiry: "2026-11-03", underlyingLtp: 25000, lotSize: 75, units: "lots", atmStrike: 25000, rows, ...extra });
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
  it("exposes four read GETs", () => {
    const { routes } = setup();
    expect(Object.keys(routes).sort()).toEqual(["/v1/analytics/exposure", "/v1/analytics/exposure/expiries", "/v1/analytics/exposure/session", "/v1/analytics/oi-explorer"]);
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

// ── Through the session (gexSession, snapshotChain, the session route) ──

/** A recorder snapshot (stored shape): Calls heavy above `spot`, Puts heavy below, IV 14 % flat. */
function snapAt(slot, spot, { n = 41, step = 50, putScale = 1 } = {}) {
  const atm = Math.round(spot / step) * step;
  const k = Array.from({ length: n }, (_, i) => atm + (i - (n - 1) / 2) * step);
  return {
    slot,
    ts: slot + 2000,
    spot,
    fwd: spot + 20,
    t: 5 / 365,
    atm,
    k,
    ce: { oi: k.map((x) => (x >= atm ? 200_000 : 40_000)), iv: k.map(() => 14) },
    pe: { oi: k.map((x) => (x <= atm ? 200_000 * putScale : 40_000)), iv: k.map(() => 14) },
  };
}

describe("snapshotChain", () => {
  it("builds a units chain with gamma at spot, and declines a snapshot without spot or time", () => {
    const s = snapAt(Date.parse("2026-10-30T04:00:00Z"), 25000);
    const { chain, days } = snapshotChain(s);
    expect(days).toBeCloseTo(5, 6);
    expect(chain.units).toBe("units");
    expect(chain.underlyingLtp).toBe(25000);
    const row = chain.rows.find((r) => r.strike === 25000);
    expect(row.ce.gamma).toBeCloseTo(computeGreeks({ spot: 25000, strike: 25000, daysToExpiry: 5, type: "CE", vol: 0.14 }).gamma, 12);
    expect(snapshotChain({ ...s, spot: null })).toBeNull();
    expect(snapshotChain({ ...s, t: 0 })).toBeNull();
  });
  it("leaves out a leg without OI, and keeps one without IV unpriced (never a zero gamma counted)", () => {
    const s = snapAt(1, 25000);
    s.ce.oi[0] = 0;
    s.pe.iv[1] = null;
    const { chain } = snapshotChain(s);
    expect(chain.rows[0].ce).toBeNull();
    expect(chain.rows[1].pe).toEqual({ oi: 200_000, iv: null, gamma: null });
  });
});

describe("gexSession", () => {
  const t0 = Date.parse("2026-10-30T03:45:00Z");
  const snaps = Array.from({ length: 6 }, (_, i) => snapAt(t0 + i * 300_000, 25000 + i * 30, { putScale: 1 + i * 0.3 }));
  it("gives one point per reading, oldest first, agreeing with the single-reading figures", () => {
    const s = gexSession([...snaps].reverse());
    expect(s.points.map((p) => p.t)).toEqual(snaps.map((x) => x.slot));
    const last = snapshotExposure(snaps[5]);
    expect(s.points[5].net).toBe(last.profile.net);
    expect(s.points[5].callWall).toBe(last.profile.callWall);
    expect(s.points[5].putWall).toBe(last.profile.putWall);
    expect(s.points[5].verdict).toBe(last.profile.verdict);
    // The coarser scan still lands on the same flip (bisection does the rest).
    if (last.profile.flip !== null) expect(Math.abs(s.points[5].flip - last.profile.flip)).toBeLessThan(0.5);
    expect(s.ladder).toEqual({ first: 41, last: 41 });
    expect(s.points[0].gross).toBeGreaterThan(Math.abs(s.points[0].net));
  });
  it("puts on more Put gamma as the Puts grow (net falls)", () => {
    const s = gexSession(snaps);
    expect(s.points[5].net).toBeLessThan(s.points[0].net);
  });
  it("skips a reading it cannot price, and is empty for none", () => {
    expect(gexSession([{ ...snaps[0], spot: null }, snaps[1]]).points).toHaveLength(1);
    expect(gexSession([])).toEqual({ points: [], ladder: null });
  });
  it("works a full session of readings quickly", () => {
    const many = Array.from({ length: SESSION_POINTS }, (_, i) => snapAt(t0 + i * 180_000, 25000 + Math.sin(i / 9) * 120));
    const start = performance.now();
    expect(gexSession(many).points).toHaveLength(SESSION_POINTS);
    expect(performance.now() - start).toBeLessThan(4000);
  });
});

describe("thinEvenly", () => {
  it("keeps short lists and thins long ones evenly, first and last kept", () => {
    expect(thinEvenly([1, 2, 3], 5)).toEqual([1, 2, 3]);
    const out = thinEvenly(Array.from({ length: 300 }, (_, i) => i), 120);
    expect(out).toHaveLength(120);
    expect(out[0]).toBe(0);
    expect(out.at(-1)).toBe(299);
    expect(thinEvenly(null)).toEqual([]);
  });
});

describe("GET /v1/analytics/exposure/session", () => {
  const ctx = (q) => ({ query: new URLSearchParams(q), requestId: "r1", principal: { kind: "local" }, requireAccountAccess() {} });
  const now = Date.parse("2026-10-30T06:00:00Z");
  const t0 = Date.parse("2026-10-30T03:45:00Z");
  const day = Array.from({ length: 5 }, (_, i) => snapAt(t0 + i * 300_000, 25000 + i * 10));
  const prev = [snapAt(t0 - 86_400_000, 24800)];
  const recorder = {
    calls: [],
    async snapshots(q) {
      this.calls.push(q);
      const all = [...prev, ...day].filter((s) => s.slot >= q.fromMs && s.slot <= q.toMs);
      return { snapshots: all, unavailable: all.length ? null : { reason: "not-recorded-yet", detail: "x" } };
    },
  };
  const route = (deps) => exposureRoutes({ marketData: {}, now: () => now, ...deps }).find((r) => r[1] === "/v1/analytics/exposure/session")[3];
  it("answers today's series, and the full reading nearest `at` for the replay", async () => {
    const r = await route({ recorder })(ctx(`underlying=nifty&expiry=2026-11-03&at=${t0 + 610_000}`));
    expect(r.data.day).toBe("2026-10-30");
    expect(r.data.points).toHaveLength(5);
    expect(r.data.reading.t).toBe(t0 + 600_000);
    expect(r.data.reading.profile.curve.length).toBeGreaterThan(10);
    expect(r.data.reading.strikes).toHaveLength(41);
    expect(recorder.calls[0]).toMatchObject({ underlying: "NIFTY", expiry: "2026-11-03", every: 5, fields: ["oi", "iv"] });
  });
  it("falls back to the latest earlier session, never mixing days", async () => {
    const empty = {
      async snapshots(q) {
        return { snapshots: prev.filter((s) => s.slot >= q.fromMs && s.slot <= q.toMs), unavailable: null };
      },
    };
    const r = await route({ recorder: empty })(ctx("underlying=NIFTY&expiry=2026-11-03"));
    expect(r.data.day).toBe("2026-10-29");
    expect(r.data.points).toHaveLength(1);
    expect(r.data.reading).toBeUndefined();
  });
  it("says so without a recorder, and checks its query", async () => {
    const r = await route({})(ctx("underlying=NIFTY&expiry=2026-11-03"));
    expect(r.data.points).toEqual([]);
    expect(r.data.unavailable.reason).toBe("no-recorder");
    await expect(route({ recorder })(ctx("underlying=NIFTY&expiry=bad"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(route({ recorder })(ctx("underlying=NIFTY&expiry=2026-11-03&every=99"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(route({ recorder })(ctx("underlying=NIFTY&expiry=2026-11-03&at=soon"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
