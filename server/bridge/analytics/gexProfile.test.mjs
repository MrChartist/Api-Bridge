import { describe, expect, it } from "vitest";
import { FLIP_RANGE, gexProfile, gexVerdict, ladderCross, netGexAt, profileLegs } from "./gexProfile.mjs";
import { greekExposure } from "./exposure.mjs";
import { computeGreeks } from "../../lib/blackScholes.mjs";

const DAYS = 7;
/** A chain whose legs carry the gamma computeGreeks gives at spot, so the bars and the re-priced curve agree. */
function chainOf(spot, rows, extra = {}) {
  const leg = (strike, oi, iv, type) => (oi ? { symbol: `${strike}${type}`, ltp: 10, oi, iv, delta: 0, gamma: computeGreeks({ spot, strike, daysToExpiry: DAYS, type, vol: iv / 100 }).gamma } : null);
  return { underlying: "NIFTY", expiry: "2026-11-03", underlyingLtp: spot, lotSize: 65, rows: rows.map(([k, c, p, iv = 15]) => ({ strike: k, ce: leg(k, c, iv, "CE"), pe: leg(k, p, iv, "PE") })), ...extra };
}
const profileOf = (chain) => gexProfile(chain, { days: DAYS, strikes: greekExposure(chain, { days: DAYS }).strikes });

// Puts heavy below 25000, calls heavy above: the book is put-led (negative) low and call-led (positive) high.
const book = (spot) =>
  chainOf(spot, [
    [24600, 1000, 90000],
    [24700, 2000, 120000],
    [24800, 5000, 150000],
    [24900, 20000, 100000],
    [25000, 60000, 60000],
    [25100, 100000, 20000],
    [25200, 150000, 5000],
    [25300, 120000, 2000],
    [25400, 90000, 1000],
  ]);

describe("profileLegs", () => {
  it("keeps legs with OI and IV, as fractions, scaled by the lot only for a chain in lots", () => {
    const c = chainOf(25000, [[25000, 10, 20, 16], [25100, 0, 0]]);
    expect(profileLegs(c)).toEqual([{ strike: 25000, callOi: 10, putOi: 20, callIv: 0.16, putIv: 0.16 }]);
    expect(profileLegs({ ...c, units: "lots" })[0].callOi).toBe(650);
  });
  it("is empty for a chain without rows", () => {
    expect(profileLegs(null)).toEqual([]);
  });
});

describe("netGexAt", () => {
  it("matches the formula γ × (call OI − put OI) × P² × 0.01 for one strike", () => {
    const legs = [{ strike: 25000, callOi: 300, putOi: 100, callIv: 0.15, putIv: 0.15 }];
    const g = computeGreeks({ spot: 25100, strike: 25000, daysToExpiry: DAYS, type: "CE", vol: 0.15 }).gamma;
    expect(netGexAt(legs, 25100, { days: DAYS })).toBeCloseTo(g * 200 * 25100 * 25100 * 0.01, 6);
  });
  it("is null at a price of 0, and 0 with no legs", () => {
    expect(netGexAt([], 25000, { days: DAYS })).toBe(0);
    expect(netGexAt([], 0, { days: DAYS })).toBeNull();
  });
});

describe("ladderCross", () => {
  it("interpolates where the running total changes sign", () => {
    // running: -100, -50, +50 -> crosses between 200 and 300 halfway
    expect(ladderCross([{ strike: 100, netGex: -100 }, { strike: 200, netGex: 50 }, { strike: 300, netGex: 100 }], 250)).toBe(250);
  });
  it("is null when the running total never crosses", () => {
    expect(ladderCross([{ strike: 100, netGex: 5 }, { strike: 200, netGex: 5 }], 150)).toBeNull();
  });
});

describe("gexVerdict", () => {
  it("names a side only from a 10% lean", () => {
    expect(gexVerdict(100, 0.2)).toBe("dampens");
    expect(gexVerdict(-100, 0.1)).toBe("amplifies");
    expect(gexVerdict(-100, 0.0999)).toBe("balanced");
    expect(gexVerdict(null, null)).toBe("unmeasured");
  });
});

describe("gexProfile", () => {
  it("solves a flip between the put-heavy and call-heavy strikes, where the curve changes sign", () => {
    const p = profileOf(book(25000));
    expect(p.flip).toBeGreaterThan(24700);
    expect(p.flip).toBeLessThan(25300);
    // The curve is re-priced: net at the flip is ~0, below it negative, above it positive.
    const legs = profileLegs(book(25000));
    expect(Math.abs(netGexAt(legs, p.flip, { days: DAYS }))).toBeLessThan(Math.abs(netGexAt(legs, p.flip + 100, { days: DAYS })) / 100);
    expect(netGexAt(legs, p.flip - 150, { days: DAYS })).toBeLessThan(0);
    expect(netGexAt(legs, p.flip + 150, { days: DAYS })).toBeGreaterThan(0);
    expect(p.distanceToFlip).toBeCloseTo(25000 - p.flip, 1);
    expect(p.flipRange).toEqual([25000 * (1 - FLIP_RANGE), 25000 * (1 + FLIP_RANGE)]);
    expect(p.curve.length).toBe(121);
    expect(p.curve[0].price).toBe(24600);
    expect(p.curve.at(-1).price).toBe(25400);
  });

  it("puts the call wall above spot and the put wall below it, never both on the ATM strike", () => {
    const p = profileOf(book(25000));
    expect(p.callWall).toBeGreaterThan(25000);
    expect(p.putWall).toBeLessThan(25000);
    expect(p.heaviest).not.toBeNull();
  });

  it("reads the regime at spot and the verdict from the lean", () => {
    const high = profileOf(book(25250));
    expect(high.regimeAtSpot).toBe("positive");
    expect(high.verdict).toBe("dampens");
    expect(high.lean).toBeGreaterThanOrEqual(0.1);
    const low = profileOf(book(24750));
    expect(low.regimeAtSpot).toBe("negative");
    expect(low.verdict).toBe("amplifies");
  });

  it("says balanced when calls and puts cancel", () => {
    const p = profileOf(chainOf(25000, [[24900, 1000, 1000], [25000, 1000, 1000], [25100, 1000, 1000]]));
    expect(p.verdict).toBe("balanced");
    expect(p.lean).toBeLessThan(0.1);
  });

  it("gives no flip when the book never changes sign in range", () => {
    const p = profileOf(chainOf(25000, [[24900, 5000, 0], [25000, 5000, 0], [25100, 5000, 0]]));
    expect(p.flip).toBeNull();
    expect(p.distanceToFlip).toBeNull();
    expect(p.verdict).toBe("dampens");
  });

  it("is unmeasured with no spot or no usable legs, and never NaN", () => {
    const none = gexProfile({ underlyingLtp: 0, rows: [] }, { days: DAYS, strikes: [] });
    expect(none.verdict).toBe("unmeasured");
    expect(none.flip).toBeNull();
    expect(none.curve).toEqual([]);
    expect(JSON.stringify(profileOf(book(25000)))).not.toMatch(/NaN|Infinity/);
  });
});
