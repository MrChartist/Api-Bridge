import { describe, expect, it } from "vitest";
import { BridgeError } from "../core/errors.mjs";
import { createFakeMarketData } from "../market/fake.mjs";
import { derivDepthRoutes, eventMove, forwardVols, impliedForward, ivAtDelta, rrBf, smileInDelta } from "./derivDepth.mjs";

const EXP_A = "2026-11-24";
const EXP_B = "2026-12-24"; // 30 days after A
const NOW = Date.parse(`${EXP_A}T15:30:00+05:30`) - 30 * 86_400_000; // A is exactly 30 days out, B exactly 60
const ctxFor = (query = "") => ({ query: new URLSearchParams(query), requestId: "r1", principal: { kind: "local" }, requireAccountAccess: () => {} });
const find = (routes, path) => routes.find((r) => r[1] === path)[3];
const noNaN = (v) => {
  const bad = [];
  (function walk(x, p) {
    if (typeof x === "number" && !Number.isFinite(x)) bad.push(p);
    else if (x && typeof x === "object") for (const [k, y] of Object.entries(x)) walk(y, `${p}.${k}`);
  })(v, "$");
  return bad;
};
const leg = (o) => ({ symbol: "x", ltp: 10, bid: 0, ask: 0, oi: 1, oiChange: 0, volume: 1, iv: null, delta: null, gamma: null, theta: null, vega: null, greeksSource: null, ...o });
const setup = (build = () => {}) => {
  const md = createFakeMarketData();
  md.setExpiries("NIFTY", [EXP_A, EXP_B]);
  build(md);
  return { md, routes: derivDepthRoutes({ marketData: md, now: () => NOW }) };
};
/** Flat-ATM chain: ATM straddle legs at strike 100 with the given IV (percent). */
const atmChain = (iv) => ({ underlyingLtp: 100, lotSize: 1, rows: [{ strike: 100, ce: leg({ iv, delta: 0.5 }), pe: leg({ iv, delta: -0.5 }) }] });

describe("forward curve from put-call parity", () => {
  // Build prices from a known carry c = 5 %: F = S e^{cT}; C - P = (F - K) e^{-rT}.
  const S = 100;
  const r = 0.065;
  const T = 30 / 365;
  const F = S * Math.exp(0.05 * T);
  const rowFor = (K, P) => ({ strike: K, ce: leg({ ltp: P + (F - K) * Math.exp(-r * T) }), pe: leg({ ltp: P }) });
  const chain = { underlyingLtp: S, rows: [rowFor(98, 2), rowFor(100, 3.2), rowFor(102, 4.9), rowFor(110, 11)] };

  it("recovers the forward, carry and implied dividend yield", () => {
    const f = impliedForward(chain, 30, r);
    expect(f.forward).toBeCloseTo(F, 1);
    expect(f.carryPct).toBeCloseTo(5, 0);
    expect(f.impliedDividendYieldPct).toBeCloseTo(1.5, 0);
    expect(f.strikesUsed).toEqual([100, 98, 102]);
    expect(f.quality).toBe("ok");
    expect(f.basis).toBeCloseTo(F - S, 1);
  });
  it("hand check at one strike: F = K + (C - P) e^{rT}", () => {
    // C = 3.5, P = 2.9 at K = 100, r = 6.5 %, T = 30/365: F = 100 + 0.6 x e^{0.0053425} = 100.60321
    const f = impliedForward({ underlyingLtp: 100, rows: [{ strike: 100, ce: leg({ ltp: 3.5 }), pe: leg({ ltp: 2.9 }) }] }, 30, 0.065);
    expect(f.forward).toBeCloseTo(100 + 0.6 * Math.exp(0.065 * 30 / 365), 2);
    expect(f.forward).toBeCloseTo(100.6032, 3);
  });
  it("uses mid when bid and ask exist", () => {
    const f = impliedForward({ underlyingLtp: 100, rows: [{ strike: 100, ce: leg({ ltp: 9, bid: 3.4, ask: 3.6 }), pe: leg({ ltp: 9, bid: 2.8, ask: 3 }) }] }, 30, 0.065);
    expect(f.forward).toBeCloseTo(100.6032, 3);
  });
  it("thin or near-expiry data gives nulls with a reason", () => {
    expect(impliedForward({ underlyingLtp: 100, rows: [{ strike: 100, ce: leg({ ltp: 3 }), pe: leg({ ltp: null }) }] }, 30, 0.065)).toMatchObject({ forward: null, reason: expect.stringMatching(/both/) });
    expect(impliedForward(chain, 0.2, 0.065)).toMatchObject({ forward: null, reason: expect.stringMatching(/half a day/) });
    expect(impliedForward({ underlyingLtp: null, rows: [] }, 30, 0.065).forward).toBeNull();
  });
  it("route returns one entry per expiry and survives a failing chain", async () => {
    const { routes, md } = setup((m) => {
      m.setChain("NIFTY", EXP_A, chain);
    });
    void md;
    const r = await find(routes, "/v1/analytics/forward-curve")(ctxFor("underlying=nifty&expiries=2"));
    expect(r.data.underlying).toBe("NIFTY");
    expect(r.data.curve).toHaveLength(2);
    expect(r.data.curve[0].forward).toBeCloseTo(F, 1);
    // EXP_B has no fake chain or price: reported as unavailable with an error, not thrown
    expect(r.data.curve[1].forward).toBeNull();
    expect(r.errors).toHaveLength(1);
    expect(noNaN(r)).toEqual([]);
    await expect(find(routes, "/v1/analytics/forward-curve")(ctxFor(""))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(find(routes, "/v1/analytics/forward-curve")(ctxFor("underlying=NIFTY&expiries=99"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("risk reversal and butterfly in delta space", () => {
  // call-equivalent delta -> IV: .10 18.5, .20 18, .30 18.5, .40 19, .50 20, .60 21, .70 22, .80 24, .90 27, .95 30
  const calls = [[100, 0.5, 20], [102, 0.4, 19], [104, 0.3, 18.5], [106, 0.2, 18], [108, 0.1, 18.5]];
  const puts = [[98, -0.4, 21], [96, -0.3, 22], [94, -0.2, 24], [92, -0.1, 27], [90, -0.05, 30]];
  const rows = [
    ...calls.map(([strike, delta, iv]) => ({ strike, ce: leg({ iv, delta }), pe: null })),
    ...puts.map(([strike, delta, iv]) => ({ strike, ce: null, pe: leg({ iv, delta }) })),
  ].sort((a, b) => a.strike - b.strike);

  it("interpolates the 25 and 10 delta wings by hand", async () => {
    // 25d call: halfway between .30 (18.5) and .20 (18) = 18.25. 25d put (call delta .75): halfway .70 (22) and .80 (24) = 23.
    // RR = 18.25 - 23 = -4.75. BF = (18.25 + 23) / 2 - 20 = 0.625.
    const { routes } = setup((m) => m.setChain("NIFTY", EXP_A, { underlyingLtp: 100, lotSize: 1, rows }));
    const r = await find(routes, "/v1/analytics/rr-bf")(ctxFor(`underlying=NIFTY&expiry=${EXP_A}`));
    expect(r.data.requested).toMatchObject({ delta: 25, callIvPct: 18.25, putIvPct: 23, atmIvPct: 20, riskReversal: -4.75, butterfly: 0.625 });
    const d10 = r.data.deltas.find((d) => d.delta === 10);
    expect(d10).toMatchObject({ callIvPct: 18.5, putIvPct: 27, riskReversal: -8.5, butterfly: 2.75 });
    expect(r.data.deltas.map((d) => d.delta)).toEqual([25, 10]);
    expect(r.data.smilePoints).toBe(10);
    expect(noNaN(r)).toEqual([]);
  });
  it("accepts another delta and never extrapolates past the smile", async () => {
    const { routes } = setup((m) => m.setChain("NIFTY", EXP_A, { underlyingLtp: 100, lotSize: 1, rows }));
    const r = await find(routes, "/v1/analytics/rr-bf")(ctxFor(`underlying=NIFTY&expiry=${EXP_A}&delta=5`));
    expect(r.data.requestedDelta).toBe(5);
    // 5-delta call needs call delta .05 but the lowest point is .10: null
    expect(r.data.requested.riskReversal).toBeNull();
    expect(r.data.requested.reason).toMatch(/does not reach/);
    expect(r.data.deltas.map((d) => d.delta)).toEqual([25, 10, 5]);
  });
  it("is null when data is too thin", async () => {
    const { routes } = setup((m) => m.setChain("NIFTY", EXP_A, { underlyingLtp: 100, lotSize: 1, rows: rows.slice(0, 3) }));
    const r = await find(routes, "/v1/analytics/rr-bf")(ctxFor(`underlying=NIFTY&expiry=${EXP_A}`));
    expect(r.data.deltas.every((d) => d.riskReversal === null && d.butterfly === null)).toBe(true);
    expect(r.data.requested.reason).toMatch(/usable smile points/);
  });
  it("falls back to Black-Scholes delta when the chain has none", () => {
    const pts = smileInDelta({ underlyingLtp: 100, atmStrike: 100, rows: [{ strike: 100, ce: leg({ iv: 20 }), pe: null }, { strike: 96, ce: null, pe: leg({ iv: 22 }) }] }, 30, 0.065);
    expect(pts).toHaveLength(2);
    expect(pts[0].strike).toBe(100); // ATM call, delta a little above 0.5
    expect(pts[0].delta).toBeGreaterThan(0.5);
    expect(pts[0].delta).toBeLessThan(0.6);
    expect(pts[1].strike).toBe(96); // 96 put: call-equivalent delta well above 0.5
    expect(pts[1].delta).toBeGreaterThan(0.7);
    expect(ivAtDelta([{ delta: 0.2, iv: 10 }, { delta: 0.4, iv: 20 }], 0.3)).toBeCloseTo(15, 9);
    expect(ivAtDelta([{ delta: 0.2, iv: 10 }, { delta: 0.4, iv: 20 }], 0.5)).toBeNull();
    expect(rrBf([], 25).riskReversal).toBeNull();
  });
  it("validates", async () => {
    const { routes } = setup();
    await expect(find(routes, "/v1/analytics/rr-bf")(ctxFor("underlying=NIFTY"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(find(routes, "/v1/analytics/rr-bf")(ctxFor(`underlying=NIFTY&expiry=${EXP_A}&delta=60`))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

// Log returns alternate +1 % / -1 %, so every even-length window has mean 0 and sample sd = 0.01 sqrt(n/(n-1)).
function altCandles(n, start = 100) {
  const out = [];
  let c = start;
  for (let i = 0; i <= n; i++) {
    if (i > 0) c *= Math.exp(i % 2 ? 0.01 : -0.01);
    out.push({ time: 1_700_000_000 + i * 86_400, open: c, high: c, low: c, close: c, volume: 1 });
  }
  return out;
}

describe("vol cone, VRP and forward vol", () => {
  const hvOf = (n) => R2(0.01 * Math.sqrt(n / (n - 1)) * Math.sqrt(252) * 100);
  const R2 = (v) => Math.round(v * 100) / 100;
  const build = (ivA, ivB) => (m) => {
    m.setCandles("NSE:NIFTY", "1d", altCandles(300));
    m.setChain("NIFTY", EXP_A, atmChain(ivA));
    m.setChain("NIFTY", EXP_B, atmChain(ivB));
  };
  it("percentiles collapse on a constant-vol series and match the closed form", async () => {
    const { routes } = setup(build(20, 22));
    const r = await find(routes, "/v1/analytics/vol-cone")(ctxFor("underlying=NIFTY&days=300"));
    expect(r.data.cone.map((c) => c.tenorDays)).toEqual([10, 20, 30, 60, 90]);
    for (const c of r.data.cone) {
      expect(c.current).toBeCloseTo(hvOf(c.tenorDays), 2);
      expect(c.min).toBe(c.max);
      expect(c.p50).toBeCloseTo(c.current, 2);
      expect(c.position).toBe("mid");
      expect(c.samples).toBeGreaterThanOrEqual(20);
    }
    expect(hvOf(10)).toBeCloseTo(16.73, 2);
  });
  it("VRP is ATM IV minus HV of the closest tenor", async () => {
    const { routes } = setup(build(20, 22));
    const r = await find(routes, "/v1/analytics/vol-cone")(ctxFor("underlying=NIFTY&days=300"));
    expect(r.data.vrp.expiry).toBe(EXP_A);
    expect(r.data.vrp.hvTenorDays).toBe(30);
    expect(r.data.vrp.atmIvPct).toBe(20);
    expect(r.data.vrp.spreadPts).toBeCloseTo(20 - hvOf(30), 1);
    expect(r.data.vrp.ratio).toBeCloseTo(20 / hvOf(30), 2);
  });
  it("forward vol: sigma_fwd^2 = (s2^2 T2 - s1^2 T1) / (T2 - T1)", async () => {
    // 20 % at 30d, 22 % at 60d: (0.0484 x 60 - 0.04 x 30) / 30 = 0.0568 -> 23.83 %
    const { routes } = setup(build(20, 22));
    const r = await find(routes, "/v1/analytics/vol-cone")(ctxFor("underlying=NIFTY&days=300"));
    expect(r.data.forwardVol).toHaveLength(1);
    expect(r.data.forwardVol[0].forwardVolPct).toBeCloseTo(Math.sqrt(0.0568) * 100, 2);
    expect(r.data.forwardVol[0].forwardVolPct).toBeCloseTo(23.83, 2);
    expect(noNaN(r)).toEqual([]);
  });
  it("inverted term structure has no forward vol", () => {
    const f = forwardVols([{ expiry: "a", dte: 30, atmIv: 30 }, { expiry: "b", dte: 60, atmIv: 20 }]);
    expect(f[0].forwardVolPct).toBeNull();
    expect(f[0].reason).toMatch(/inverted/);
    expect(forwardVols([{ expiry: "a", dte: 30, atmIv: null }, { expiry: "b", dte: 60, atmIv: 20 }])[0].forwardVolPct).toBeNull();
  });
  it("short history leaves the cone null with a reason", async () => {
    const { routes } = setup((m) => {
      m.setCandles("NSE:NIFTY", "1d", altCandles(40));
      m.setChain("NIFTY", EXP_A, atmChain(20));
      m.setChain("NIFTY", EXP_B, atmChain(22));
    });
    const r = await find(routes, "/v1/analytics/vol-cone")(ctxFor("underlying=NIFTY&days=120"));
    const c90 = r.data.cone.find((c) => c.tenorDays === 90);
    expect(c90.p50).toBeNull();
    expect(c90.reason).toMatch(/rolling windows/);
    expect(r.data.cone.find((c) => c.tenorDays === 10).p50).not.toBeNull();
    expect(noNaN(r)).toEqual([]);
  });
});

describe("event vol", () => {
  const build = (ivA, ivB) => (m) => {
    m.setChain("NIFTY", EXP_A, atmChain(ivA));
    m.setChain("NIFTY", EXP_B, atmChain(ivB));
    m.setCandles("NSE:NIFTY", "1d", altCandles(60));
  };
  it("event between two expiries, baseline = pre-event IV, by hand", async () => {
    // s1 = 20 % (T1 = 30/365), s2 = 22 % (T2 = 60/365). Event variance = (0.0484 - 0.04) x 60/365 = 0.00138082; sd = 3.716 %.
    const { routes } = setup(build(20, 22));
    const r = await find(routes, "/v1/analytics/event-vol")(ctxFor("underlying=NIFTY&event=2026-12-04"));
    const ev = (0.0484 - 0.04) * (60 / 365);
    expect(r.data.preEventExpiry.expiry).toBe(EXP_A);
    expect(r.data.postEventExpiry.expiry).toBe(EXP_B);
    expect(r.data.baseline.volPct).toBe(20);
    expect(r.data.eventVariance).toBeCloseTo(ev, 6);
    expect(r.data.impliedEventMovePct).toBeCloseTo(Math.sqrt(ev) * 100, 2);
    expect(r.data.impliedEventMovePct).toBeCloseTo(3.716, 2);
    expect(r.data.expectedAbsMovePct).toBeCloseTo(Math.sqrt(ev) * Math.sqrt(2 / Math.PI) * 100, 2);
    expect(r.data.impliedEventMovePoints).toBeCloseTo(3.72, 1);
    expect(r.data.postEventExpiry.totalVariance).toBeCloseTo(0.0484 * (60 / 365), 6);
  });
  it("an explicit baseline and an event before the first expiry", async () => {
    // No pre-event expiry: (0.2^2 - 0.15^2) x 30/365 = 0.00143836; sd = 3.793 %.
    const { routes } = setup(build(20, 22));
    const r = await find(routes, "/v1/analytics/event-vol")(ctxFor("underlying=NIFTY&event=2026-11-10&baselineVolPct=15"));
    expect(r.data.preEventExpiry).toBeNull();
    expect(r.data.postEventExpiry.expiry).toBe(EXP_A);
    expect(r.data.baseline.source).toBe("request");
    expect(r.data.impliedEventMovePct).toBeCloseTo(Math.sqrt((0.04 - 0.0225) * (30 / 365)) * 100, 2);
    expect(r.data.impliedEventMovePct).toBeCloseTo(3.793, 2);
  });
  it("without a pre-event expiry the baseline falls back to HV20", async () => {
    const { routes } = setup(build(20, 22));
    const r = await find(routes, "/v1/analytics/event-vol")(ctxFor("underlying=NIFTY&event=2026-11-10"));
    expect(r.data.baseline.source).toMatch(/HV20/);
    expect(r.data.baseline.volPct).toBeCloseTo(16.29, 1);
    expect(r.data.impliedEventMovePct).toBeGreaterThan(0);
  });
  it("no premium, no expiry after the event, bad dates", async () => {
    const flat = setup(build(20, 19));
    const r = await find(flat.routes, "/v1/analytics/event-vol")(ctxFor("underlying=NIFTY&event=2026-12-04"));
    expect(r.data.impliedEventMovePct).toBeNull();
    expect(r.data.reason).toMatch(/no event premium/);
    const late = await find(flat.routes, "/v1/analytics/event-vol")(ctxFor("underlying=NIFTY&event=2027-01-15"));
    expect(late.data.impliedEventMovePct).toBeNull();
    expect(late.data.reason).toMatch(/No listed expiry/);
    for (const q of ["underlying=NIFTY", "underlying=NIFTY&event=2026-02-30", "underlying=NIFTY&event=2026-01-01", "underlying=NIFTY&event=2030-01-01", `underlying=NIFTY&event=2026-12-04&baselineVolPct=0`]) {
      await expect(find(flat.routes, "/v1/analytics/event-vol")(ctxFor(q))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });
  it("eventMove is null when variance is not above baseline", () => {
    expect(eventMove({ s1: 20, T1: 0.1, s2: 19, T2: 0.2, baseline: 20, spot: 100 }).impliedEventMovePct).toBeNull();
    expect(eventMove({ s1: 0, T1: 0, s2: 20, T2: 0.1, baseline: 15, spot: 100 }).impliedEventMovePct).toBeCloseTo(Math.sqrt((0.04 - 0.0225) * 0.1) * 100, 2);
  });
});

describe("errors and route table", () => {
  it("raw errors become INTERNAL without leaking", async () => {
    const md = { expiries: async () => { throw new TypeError("secret detail"); } };
    const routes = derivDepthRoutes({ marketData: md, now: () => NOW });
    const err = await find(routes, "/v1/analytics/forward-curve")(ctxFor("underlying=NIFTY")).catch((e) => e);
    expect(err).toBeInstanceOf(BridgeError);
    expect(err.code).toBe("INTERNAL");
    expect(String(err.message)).not.toMatch(/secret/);
  });
  it("lists four read routes", () => {
    expect(derivDepthRoutes({}).map((r) => r.slice(0, 3))).toEqual([
      ["GET", "/v1/analytics/forward-curve", { scope: "read" }],
      ["GET", "/v1/analytics/rr-bf", { scope: "read" }],
      ["GET", "/v1/analytics/vol-cone", { scope: "read" }],
      ["GET", "/v1/analytics/event-vol", { scope: "read" }],
    ]);
  });
});
