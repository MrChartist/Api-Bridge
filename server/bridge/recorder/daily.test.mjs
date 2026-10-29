/**
 * Daily S3 maths (docs/spec/p1-01-recorder.md §6.8–6.11): PCR 0.933, max pain 25,100, largest OI ties, ΔOI with and
 * without the previous day, futures basis 97.6 and 5.45 %.
 */
import { describe, expect, it } from "vitest";
import { dailyRow, daysBetween, futuresBasis, oiChanges } from "./daily.mjs";

const K = [24900, 25000, 25100, 25200, 25300];
/** §6.9 table, OI in units (thousands × 1,000). */
const snap = (ce, pe, extra = {}) => ({
  v: 1,
  kind: "snap",
  u: "NIFTY",
  x: "2026-11-03",
  slot: Date.parse("2026-10-29T15:29:00+05:30"),
  quality: "live",
  spot: 25162.4,
  fwd: 25181.0,
  atm: 25200,
  straddle: 268.2,
  k: K,
  ce: { oi: ce.map((v) => v * 1000), vol: [10, 20, 30, 40, 50] },
  pe: { oi: pe.map((v) => v * 1000), vol: [60, 50, 40, 30, 20] },
  ...extra,
});
const today = snap([20, 45, 80, 120, 180], [140, 110, 90, 50, 25]);

describe("dailyRow", () => {
  it("§6.8 PCR 0.933 and §6.9 max pain 25,100 over recorded strikes", () => {
    const r = dailyRow({ date: "2026-10-29", last: today });
    expect(r).toMatchObject({ v: 1, date: "2026-10-29", u: "NIFTY", x: "2026-11-03", source: "recorder", quality: "live", pcrOi: 0.933, pcrVol: 1.333, maxPain: 25100, strikesCovered: 5, ceOi: 445_000, peOi: 415_000, gex: null, zeroGamma: null });
    expect(r.largestCallOi).toEqual({ k: 25300, oi: 180_000 });
    expect(r.largestPutOi).toEqual({ k: 24900, oi: 140_000 });
    expect(r.asOfSlot).toBe(today.slot);
  });
  it("largest OI ties go nearer the forward", () => {
    const tie = snap([200, 10, 10, 10, 200], [5, 5, 5, 5, 5]);
    expect(dailyRow({ date: "2026-10-29", last: tie }).largestCallOi.k).toBe(25300);
    expect(dailyRow({ date: "2026-10-29", last: { ...tie, fwd: 24950 } }).largestCallOi.k).toBe(24900);
  });
  it("ΔOI against the previous recorded day: top adds and cuts", () => {
    const prev = snap([25, 40, 60, 120, 150], [100, 120, 90, 55, 25]);
    const r = dailyRow({ date: "2026-10-29", last: today, prevLast: prev });
    expect(r.dOiBasis).toBe("prev-recorded");
    expect(r.topAdds).toEqual([
      { k: 24900, r: "PE", dOi: 40_000 },
      { k: 25300, r: "CE", dOi: 30_000 },
      { k: 25100, r: "CE", dOi: 20_000 },
      { k: 25000, r: "CE", dOi: 5_000 },
    ]);
    expect(r.topCuts).toEqual([
      { k: 25000, r: "PE", dOi: -10_000 },
      { k: 24900, r: "CE", dOi: -5_000 },
      { k: 25200, r: "PE", dOi: -5_000 },
    ]);
  });
  it("without the previous day: broker previous-close change, else none", () => {
    const b = dailyRow({ date: "2026-10-29", last: today, brokerOiChange: { ce: [0, 0, 7500, 0, -1500], pe: [null, null, null, null, null] } });
    expect(b.dOiBasis).toBe("broker-prev-close");
    expect(b.topAdds).toEqual([{ k: 25100, r: "CE", dOi: 7500 }]);
    expect(b.topCuts).toEqual([{ k: 25300, r: "CE", dOi: -1500 }]);
    const n = dailyRow({ date: "2026-10-29", last: today });
    expect(n).toMatchObject({ dOiBasis: "none", topAdds: [], topCuts: [] });
  });
  it("only strikes present on both days are compared", () => {
    const prev = { ...snap([1, 1, 1, 1, 1], [1, 1, 1, 1, 1]), k: [25000, 25100, 25200, 25300, 25400] };
    expect(oiChanges(today, prev).map((c) => c.k)).not.toContain(24900);
  });
});

describe("futures basis and rollover (§6.11)", () => {
  it("fut 25,260.0, spot 25,162.4, 26 days → basis 97.6, annualised 5.45 %", () => {
    const f = futuresBasis({ date: "2026-10-29", spot: 25162.4, futures: [{ x: "2026-11-24", ltp: 25260.0, oi: 14_812_500 }, { x: "2026-12-29", ltp: 25400, oi: 3_337_500 }] });
    expect(daysBetween("2026-10-29", "2026-11-24")).toBe(26);
    expect(f).toEqual({ x: "2026-11-24", ltp: 25260, oi: 14_812_500, basis: 97.6, basisAnnPct: 5.45, rolloverPct: 18.4 });
  });
  it("rollover null when the next month's OI is missing; null without spot or futures", () => {
    expect(futuresBasis({ date: "2026-10-29", spot: 25162.4, futures: [{ x: "2026-11-24", ltp: 25260, oi: 100 }] }).rolloverPct).toBeNull();
    expect(futuresBasis({ date: "2026-10-29", spot: null, futures: [{ x: "2026-11-24", ltp: 25260, oi: 100 }] })).toBeNull();
    expect(futuresBasis({ date: "2026-10-29", spot: 1, futures: [] })).toBeNull();
  });
  it("the S3 row carries it from the underlying line", () => {
    const r = dailyRow({ date: "2026-10-29", last: today, und: { spot: 25162.4, fut: [{ x: "2026-11-24", ltp: 25260, oi: 10 }] }, counts: { slots: 375, gapSlots: 2, partialSlots: 1 } });
    expect(r.fut).toMatchObject({ basis: 97.6, basisAnnPct: 5.45 });
    expect(r).toMatchObject({ slots: 375, gapSlots: 2, partialSlots: 1 });
  });
});
