/**
 * capture.mjs (docs/spec/p1-03-pricing-vol.md §2.3, §6.3–6.8, §9.1): chains → S2 rows. A chain priced with Black-76 at
 * a flat 13 % gives back the forward, ATM IV 13 and a flat smile; flags (WIDE_ATM, ONE_SIDED_ATM, FORWARD_SPOT, THIN,
 * EXPIRY_DAY); the summary's cm30 on three clocks equals the §6.2 conversions; front roll; expiry choice; S9 rows; a
 * recorder snapshot read as a chain; and frozen demo chains.
 */
import { describe, expect, it } from "vitest";
import { black76, volTime } from "../dashboard/pricing.js";
import { demoChainAt, demoClockContext, ivLevel, smileVol, DEMO_UNDERLYINGS } from "../demo/demoAdapter.mjs";
import { buildClockContext } from "./context.mjs";
import { chainFromSnapshot, chooseExpiries, cm30Of, cmTargetDate, expiryRow, frontOf, hvOf, ivOnClock, missedRow, predictionRows, summaryRow } from "./capture.mjs";

const IST = (s) => Date.parse(`${s}+05:30`);
const ctx = buildClockContext({ settings: null, session: { open: "09:15", close: "15:30" }, rate: { value: 0.065, quality: "default" } });

/** A chain priced at a flat σ on the clock: bid/ask one tick around the discounted Black-76 price. */
function flatChain({ spot = 25120, expiry = "2026-11-03", t = IST("2026-10-29T15:25:00"), sigma = 13, step = 50, each = 30, spread = 0.1, oneSided = [] } = {}) {
  const vt = volTime(ctx, t, expiry);
  const df = Math.exp(-0.065 * vt.Tcal);
  const F = spot / df;
  const centre = Math.round(spot / step) * step;
  const rows = [];
  for (let i = -each; i <= each; i += 1) {
    const k = centre + i * step;
    const leg = (right) => {
      const p = df * black76(F, k, vt.T, sigma, right);
      if (oneSided.includes(`${k}${right}`)) return { ltp: p, bid: 0, ask: p + spread };
      return { ltp: p, bid: Math.max(0.05, p - spread / 2), ask: p + spread / 2 };
    };
    rows.push({ strike: k, ce: leg("CE"), pe: leg("PE") });
  }
  return { chain: { underlying: "NIFTY", expiry, underlyingLtp: spot, rows }, F, vt, t };
}

describe("expiryRow", () => {
  it("recovers the forward, ATM IV and a flat smile from a flat 13 % chain", () => {
    const { chain, F, vt, t } = flatChain();
    const row = expiryRow(chain, ctx, t, "2026-11-03", { underlying: "NIFTY", exchange: "NFO", kind: "weekly", capturedAt: "2026-10-29T15:25:03.000+05:30", accountId: "acc-1", broker: "dhan" });
    expect(row.forward).toBeCloseTo(F, 0);
    expect(row.forwardSource).toBe("parity");
    expect(row.forwardStrikes).toBe(5);
    expect(row.atmIv).toBeCloseTo(13, 1);
    for (const v of Object.values(row.iv)) if (v !== null) expect(v).toBeCloseTo(13, 0);
    expect(row.iv.p25).not.toBeNull();
    expect(row.iv.c25).not.toBeNull();
    expect(Math.abs(row.rr25)).toBeLessThan(0.1);
    expect(row.rr25).toBe(-row.putSkew25 || 0);
    expect(row.clock).toMatchObject({ version: "vt1", mode: "weighted" });
    expect(row.clock.T).toBeCloseTo(vt.T, 8);
    expect(row.tv).toBeCloseTo((row.atmIv / 100) ** 2 * vt.T, 9);
    expect(row.band1[0]).toBeLessThan(row.forward);
    expect(row.band1[1]).toBeGreaterThan(row.forward);
    expect(row.eam).toBeCloseTo(Math.sqrt(2 / Math.PI) * (row.atmIv / 100) * row.forward * Math.sqrt(vt.T), 0);
    expect(row.flags).toEqual([]);
    expect(row).toMatchObject({ v: 1, date: "2026-10-29", quality: "live", accountId: "acc-1", broker: "dhan", strikes: 61 });
  });

  it("rr25 = −putSkew25 and bf25 on a skewed chain", () => {
    const { chain, t } = flatChain();
    // Add a put skew: raise every put below the forward by 10 %.
    for (const r of chain.rows) if (r.strike < 25000 && r.pe) for (const k of ["ltp", "bid", "ask"]) r.pe[k] *= 1.1;
    const row = expiryRow(chain, ctx, t, "2026-11-03");
    expect(row.rr25).toBeLessThan(0);
    expect(row.putSkew25).toBe(-row.rr25);
    expect(row.bf25).toBeGreaterThan(0);
  });

  it("flags WIDE_ATM, ONE_SIDED_ATM, FORWARD_SPOT, THIN and EXPIRY_DAY", () => {
    const wide = flatChain({ spread: 40 });
    expect(expiryRow(wide.chain, ctx, wide.t, "2026-11-03").flags).toContain("WIDE_ATM");
    const one = flatChain({ oneSided: ["25150CE", "25150PE"] });
    expect(expiryRow(one.chain, ctx, one.t, "2026-11-03").flags).toContain("ONE_SIDED_ATM");
    const spotOnly = flatChain();
    for (const r of spotOnly.chain.rows) r.pe.bid = 0;
    const s = expiryRow(spotOnly.chain, ctx, spotOnly.t, "2026-11-03");
    expect(s.forwardSource).toBe("spot");
    expect(s.flags).toContain("FORWARD_SPOT");
    const thin = flatChain({ each: 1 });
    expect(expiryRow(thin.chain, ctx, thin.t, "2026-11-03").flags).toContain("THIN");
    const ex = flatChain({ t: IST("2026-11-03T14:00:00") });
    const exRow = expiryRow(ex.chain, ctx, ex.t, "2026-11-03");
    expect(exRow.flags).toContain("EXPIRY_DAY");
    expect(exRow.atmIv).toBeCloseTo(13, 0);
    // After the settlement there is no time left: no row.
    expect(expiryRow(ex.chain, ctx, IST("2026-11-03T15:31:00"), "2026-11-03")).toBeNull();
  });

  it("reads frozen demo chains back to the demo smile", () => {
    const t = IST("2026-10-29T15:25:00");
    const dctx = { ...demoClockContext("NFO"), rate: { value: 0.065 } };
    const u = DEMO_UNDERLYINGS.find((x) => x.symbol === "NIFTY");
    const chain = demoChainAt("NIFTY", "2026-11-17", t, 30);
    const row = expiryRow(chain, dctx, t, "2026-11-17", { underlying: "NIFTY" });
    const want = 100 * smileVol(u, chain.underlyingLtp, row.forward, row.clock.T, ivLevel("NIFTY", t));
    expect(Math.abs(row.atmIv - want)).toBeLessThan(0.3);
    expect(row.flags.filter((f) => f !== "THIN")).toEqual([]);
  });
});

describe("summary, cm30 and the front expiry", () => {
  const t = IST("2026-10-29T15:25:00");
  const rows = ["2026-11-03", "2026-11-17", "2026-12-01"].map((e, i) => {
    const { chain } = flatChain({ expiry: e, sigma: 12 + i * 0.5, t });
    return expiryRow(chain, ctx, t, e, { underlying: "NIFTY" });
  });

  it("cm30 interpolates total variance and equals the §6.2 conversion on each clock", () => {
    const cm = cm30Of(rows, ctx, t);
    expect(cm.targetDate).toBe("2026-11-27");
    expect(cm.method).toBe("interpolated");
    expect(cm.expiries).toEqual(["2026-11-17", "2026-12-01"]);
    expect(cm.weighted).toBeGreaterThan(12.4);
    expect(cm.weighted).toBeLessThan(13.1);
    // Calendar and trading cm30 are the weighted total variance read on those clocks.
    const star = volTime(ctx, t, cm.targetDate);
    const tvStar = (cm.weighted / 100) ** 2 * star.Tw;
    expect(cm.calendar).toBeCloseTo(Math.sqrt(tvStar / star.Tcal) * 100, 1);
    expect(cm.trading).toBeCloseTo(Math.sqrt(tvStar / star.Ttd) * 100, 1);
    // ivOnClock converts one row exactly.
    expect(ivOnClock(rows[1], "calendar")).toBeCloseTo(Math.sqrt(rows[1].tv / rows[1].clock.Tcal) * 100, 9);
  });

  it("worked example 6: σ₁ 12.6 %, σ₂ 12.9 % → cm30 12.86 % weighted, 13.10 % calendar", () => {
    const at = IST("2026-10-29T15:25:00");
    const row = (expiry, iv) => {
      const v = volTime(ctx, at, expiry);
      return { expiry, atmIv: iv, tv: (iv / 100) ** 2 * v.T, clock: { T: v.T, Tw: v.Tw, Ttd: v.Ttd, Tcal: v.Tcal } };
    };
    const cm = cm30Of([row("2026-11-17", 12.6), row("2026-12-01", 12.9)], ctx, at);
    expect(cm.weighted).toBeCloseTo(12.86, 2);
    expect(cm.calendar).toBeCloseTo(13.1, 2);
    // Only one side of the target: flat from it.
    expect(cm30Of([row("2026-12-01", 12.9)], ctx, at)).toMatchObject({ weighted: 12.9, method: "flat-extrapolated" });
    expect(cm30Of([], ctx, at).method).toBe("unavailable");
  });

  it("the summary row: front, roll, HV, ivHv20; missed rows", () => {
    const bars = Array.from({ length: 70 }, (_, i) => ({ open: 25000 + i, high: 25100 + i, low: 24900 + i, close: 25000 + (i % 2 ? 60 : -60) + i }));
    const hv = hvOf(bars, "broker");
    expect(hv.cc20).toBeGreaterThan(0);
    expect(hv.park20).toBeGreaterThan(0);
    const s = summaryRow({ underlying: "NIFTY", rows, ctx, now: t, vix: { value: 13.4, close: null, source: "broker" }, hv, spotClose: null, prevFront: "2026-10-27" });
    expect(s).toMatchObject({ v: 1, underlying: "NIFTY", date: "2026-10-29", quality: "live", missed: false, front: { expiry: "2026-11-03", roll: true } });
    expect(s.ivHv20).toBeCloseTo(s.cm30.weighted / hv.cc20, 2);
    // On its own expiry day the front rolls to the next expiry.
    expect(frontOf(rows, "2026-11-03").expiry).toBe("2026-11-17");
    expect(missedRow("NIFTY", "2026-10-20", "BRIDGE_OFF")).toEqual({ v: 1, underlying: "NIFTY", date: "2026-10-20", missed: true, reason: "BRIDGE_OFF", quality: null });
  });

  it("predictions: band1, band2, eam and pItmBand per expiry row", () => {
    const p = predictionRows(rows[0], { ts: "2026-10-29T15:25:03+05:30", strikes: rows[0] ? flatChain().chain.rows.map((r) => r.strike) : [] });
    expect(p.map((r) => r.metric)).toEqual(["band1", "band2", "eam", "pItmBand"]);
    expect(p[0]).toMatchObject({ v: 1, id: "p_NIFTY_2026-11-03_2026-10-29T15:25_band1", modelVersion: "b76-vt1", outcome: null, prediction: { p: 0.6827 } });
    expect(p[3].prediction.pPut).toBeGreaterThan(0.1);
    expect(p[3].prediction.pPut).toBeLessThan(0.25);
  });
});

describe("expiry choice and recorder snapshots", () => {
  it("keeps the nearest expiries and always the pair around the 30-day target", () => {
    const listed = ["2026-10-29", "2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24", "2026-12-01", "2026-12-29", "2027-03-30"];
    const target = cmTargetDate(ctx, "2026-10-29");
    expect(target).toBe("2026-11-27");
    expect(chooseExpiries(listed, { today: "2026-10-29", target })).toEqual(["2026-10-29", "2026-11-03", "2026-11-24", "2026-12-01"]);
    expect(chooseExpiries(listed, { today: "2026-10-29", target, maxPerUnderlying: 2 })).toEqual(["2026-11-24", "2026-12-01"]);
    // A Saturday target rolls back to Friday; a holiday Friday rolls to Thursday.
    const hctx = buildClockContext({ settings: null, session: { open: "09:15", close: "15:30" }, holidays: ["2026-11-27"] });
    expect(cmTargetDate(hctx, "2026-10-29")).toBe("2026-11-26");
  });

  it("reads a columnar recorder snapshot as a chain", () => {
    const snap = { u: "NIFTY", x: "2026-11-03", spot: 25120, atm: 25100, k: [25050, 25100], ce: { ltp: [120, 90], bid: [119, 89], ask: [121, 91], oi: [1, 2], vol: [3, 4] }, pe: { ltp: [40, 60], bid: [null, 59], ask: [null, 61], oi: [5, 6], vol: [7, 8] } };
    expect(chainFromSnapshot(snap)).toEqual({
      underlying: "NIFTY",
      expiry: "2026-11-03",
      underlyingLtp: 25120,
      atmStrike: 25100,
      rows: [
        { strike: 25050, ce: { ltp: 120, bid: 119, ask: 121, oi: 1, volume: 3 }, pe: { ltp: 40, bid: null, ask: null, oi: 5, volume: 7 } },
        { strike: 25100, ce: { ltp: 90, bid: 89, ask: 91, oi: 2, volume: 4 }, pe: { ltp: 60, bid: 59, ask: 61, oi: 6, volume: 8 } },
      ],
    });
    expect(chainFromSnapshot(null)).toBeNull();
  });
});
