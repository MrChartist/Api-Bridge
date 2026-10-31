// OI Analysis › Strike history and Expiry day: the pure readings behind their heroes (analyticsTime.js,
// analyticsMore.js).
import { describe, expect, it } from "vitest";
import { strikeReading } from "./analyticsTime.js";
import { expiryLimits, expirySentence } from "./analyticsMore.js";

const at = (hm) => `2026-10-30T${hm}:00.000+05:30`;

describe("strikeReading", () => {
  const rows = [
    { time: at("09:15"), ceOi: 100e3, peOi: 200e3 },
    { time: at("09:20"), ceOi: 110e3, peOi: 205e3 },
    { time: at("09:25"), ceOi: 90e3, peOi: 260e3 },
    { time: at("09:30"), ceOi: 95e3, peOi: 250e3 },
  ];
  it("reads the day in the OI change view's words, with the strike's ratio then and now", () => {
    const r = strikeReading(rows);
    expect(r).toMatchObject({ word: "Puts added, calls cut", tone: "pos" });
    expect(r.ce.change).toBe(-5e3);
    expect(r.pe.change).toBe(50e3);
    expect(r.pcrFirst).toBe(2);
    expect(r.pcrNow).toBeCloseTo(250 / 95);
  });
  it("finds the biggest single step between two readings", () => {
    expect(strikeReading(rows).peak).toEqual({ time: at("09:25"), side: "pe", d: 55e3 });
  });
  it("is null without readings, and skips gaps", () => {
    expect(strikeReading([])).toBeNull();
    const r = strikeReading([{ time: at("09:15"), ceOi: 100, peOi: null }, { time: at("09:20"), ceOi: 120, peOi: 50 }]);
    expect(r.peak).toEqual({ time: at("09:20"), side: "ce", d: 20 });
    // The first ratio comes from the first reading with both sides, not a call from one minute over a put from another.
    expect(r.pcrFirst).toBeCloseTo(50 / 120);
  });
});

describe("expiry day", () => {
  it("keeps the flag limits in range, else the defaults", () => {
    expect(expiryLimits(null)).toEqual({ maxPainPct: 0.5, decayPct: 50 });
    expect(expiryLimits({ maxPainPct: 1.2, decayPct: 70 })).toEqual({ maxPainPct: 1.2, decayPct: 70 });
    expect(expiryLimits({ maxPainPct: -1, decayPct: 140 })).toEqual({ maxPainPct: 0.5, decayPct: 50 });
  });
  it("places spot against max pain and the straddle's range in one sentence", () => {
    const d = { spot: 24974.65, maxPain: { strike: 24850, spotDistance: 124.65, spotDistancePct: 0.5016 }, straddle: { lowerBreakeven: 24563.1, upperBreakeven: 25336.9 }, gamma: { regime: "positive" } };
    expect(expirySentence(d)).toBe("Spot is 125 pts (0.50%) above max pain 24850, inside the 24563–25337 range the ATM straddle prices in. Gamma is positive: dealer hedging tends to damp moves.");
    expect(expirySentence({ spot: 100, maxPain: { strike: 110, spotDistance: -10, spotDistancePct: -9.09 }, straddle: { lowerBreakeven: 101, upperBreakeven: 120 }, gamma: { regime: "negative" } })).toBe("Spot is 10 pts (9.09%) below max pain 110, outside the 101–120 range the ATM straddle prices in. Gamma is negative: dealer hedging tends to add to moves.");
    expect(expirySentence({})).toBe("The digest has no price or levels yet.");
  });
});
