import { describe, expect, it } from "vitest";
import { adjustmentFactor, inferNonStandard, modalStrikeStep, normaliseAction, previewAdjustment, roundToTick } from "./corporateActions.mjs";

describe("§6.1 worked examples", () => {
  it("1. bonus 1:1 (RELIANCE, ex 28 Oct 2024): AF 2, lot 250 -> 500, strikes 2,800/2,820/2,830 -> 1,400/1,410/1,415", () => {
    const p = previewAdjustment({ type: "bonus", ratio: { new: 1, held: 1 }, lot: 250, strikes: [2800, 2820, 2830] });
    expect(p.factor).toBe(2);
    expect(p.lotAfter).toBe(500);
    expect(p.nonStandardLot).toBe(false);
    expect(p.strikes).toEqual([
      { before: 2800, after: 1400 },
      { before: 2820, after: 1410 },
      { before: 2830, after: 1415 },
    ]);
  });

  it("2. split FV 10 -> 2: AF 5, lot 375 -> 1,875, strikes 2,410/2,415 -> 482/483", () => {
    const p = previewAdjustment({ type: "split", fv: { from: 10, to: 2 }, lot: 375, strikes: [2410, 2415] });
    expect(p.factor).toBe(5);
    expect(p.lotAfter).toBe(1875);
    expect(p.strikes.map((s) => s.after)).toEqual([482, 483]);
  });

  it("3. rights 1:5 at 100, cum 250: TERP 225, AF 1.1111, strikes 260/250 -> 234/225, lot 1,000 -> 1,111 (non-standard)", () => {
    const p = previewAdjustment({ type: "rights", ratio: { new: 1, held: 5 }, subscriptionPrice: 100, cumPrice: 250, lot: 1000, strikes: [240, 250, 260], strikeTick: 0.05 });
    expect(p).toMatchObject({ factor: 1.111111, terp: 225, lotAfter: 1111, lotExact: 1111.111, nonStandardLot: true });
    expect(p.strikes).toEqual([
      { before: 240, after: 216 },
      { before: 250, after: 225 },
      { before: 260, after: 234 },
    ]);
    expect(p.method).toMatch(/needs verification/);
  });

  it("4. dividend 40 on cum 1,000 (4 % >= 2 %): strike 1,000 -> 960, lot unchanged; below the threshold nothing moves", () => {
    const p = previewAdjustment({ type: "dividend", dividend: 40, cumPrice: 1000, lot: 500, strikes: [1000] });
    expect(p).toMatchObject({ adjusted: true, lotAfter: 500, factor: null });
    expect(p.strikes).toEqual([{ before: 1000, after: 960 }]);
    const small = previewAdjustment({ type: "dividend", dividend: 10, cumPrice: 1000, lot: 500, strikes: [1000] });
    expect(small.adjusted).toBe(false);
    expect(small.strikes[0].after).toBe(1000);
  });
});

describe("rounding", () => {
  it("rounds to the tick in paise, half away from zero", () => {
    expect(roundToTick(100.025)).toBe(100.05);
    expect(roundToTick(100.024)).toBe(100);
    expect(roundToTick(216.0000000001)).toBe(216);
    expect(roundToTick(0.1 + 0.2, 0.05)).toBe(0.3);
    expect(roundToTick(1234.5, 1)).toBe(1235);
  });
  it("consolidation gives a factor below 1", () => {
    expect(adjustmentFactor({ type: "consolidation", fv: { from: 1, to: 10 } }).factor).toBe(0.1);
  });
});

describe("invalid input is refused", () => {
  it.each([
    [{ type: "bonus", ratio: { new: 0, held: 1 } }],
    [{ type: "bonus", ratio: { new: 1.5, held: 1 } }],
    [{ type: "split", fv: { from: 2, to: 10 } }],
    [{ type: "rights", ratio: { new: 1, held: 5 }, subscriptionPrice: 300, cumPrice: 250 }],
    [{ type: "merger" }],
  ])("%j", (a) => {
    expect(() => previewAdjustment(a)).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
  it("the stored factor is computed, never taken from input", () => {
    const n = normaliseAction({ symbol: "abc", type: "bonus", ratio: { new: 1, held: 1 }, exDate: "2026-11-04", factor: 99 }, { origin: "user", verified: true });
    expect(n).toMatchObject({ symbol: "ABC", factor: 2, origin: "user", verified: true, id: "ca_ABC_2026-11-04_bonus" });
  });
});

describe("§6.2 non-standard inference", () => {
  const contracts = [
    ...[2400, 2405, 2410, 2415, 2420].map((k) => ({ canonical: `NFO:XYZ-2026-11-24-${k}-CE`, underlying: "XYZ", expiry: "2026-11-24", strike: k, lotSize: 375 })),
    { canonical: "NFO:XYZ-2026-11-24-482-CE", underlying: "XYZ", expiry: "2026-11-24", strike: 482, lotSize: 1875 },
    { canonical: "NFO:XYZ-2026-11-24-483-CE", underlying: "XYZ", expiry: "2026-11-24", strike: 483, lotSize: 1875 },
  ];
  it("flags the lot mismatch and the off-grid strikes", () => {
    expect(modalStrikeStep(contracts.map((c) => c.strike))).toBe(5);
    const flagged = inferNonStandard(contracts, () => 375);
    expect(flagged.map((f) => f.strike)).toEqual([482, 483]);
    expect(flagged[0]).toMatchObject({ lotMismatch: true, offGrid: true, standardLot: 375, lot: 1875, quality: "inferred", text: "Probably adjusted for a corporate action" });
  });
  it("standard contracts are not flagged", () => {
    expect(inferNonStandard(contracts.slice(0, 5), () => 375)).toEqual([]);
  });
});
