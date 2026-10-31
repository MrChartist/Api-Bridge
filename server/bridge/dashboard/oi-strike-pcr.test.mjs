// OI Analysis › By strike › Strike PCR: the pure model (oi-strike-pcr.js).
import { describe, expect, it } from "vitest";

const { ratioOf, ratioText, strikePcrLine, strikePcrModel } = await import("./oi-strike-pcr.js");
const { DASH } = await import("./format.js");

const row = (strike, ce, pe, ref = [null, null]) => ({ strike, ce: { oi: ce, ref: ref[0] }, pe: { oi: pe, ref: ref[1] } });

describe("ratioOf and ratioText", () => {
  it("divides puts by calls, with ∞ and 0 for an empty side and a dash for nothing", () => {
    expect(ratioOf(100, 250)).toEqual({ v: 2.5, kind: "ratio" });
    expect(ratioOf(0, 250)).toEqual({ v: Infinity, kind: "inf" });
    expect(ratioOf(100, 0)).toEqual({ v: 0, kind: "zero" });
    expect(ratioOf(0, 0).kind).toBe("none");
    expect(ratioOf(null, 10).kind).toBe("none");
    expect(ratioText(ratioOf(100, 250))).toBe("2.50");
    expect(ratioText(ratioOf(100, 1154))).toBe("11.5");
    expect(ratioText(ratioOf(1, 250))).toBe("250");
    expect(ratioText(ratioOf(0, 5))).toBe("∞");
    expect(ratioText(ratioOf(5, 0))).toBe("0");
    expect(ratioText(ratioOf(null, 0))).toBe(DASH);
  });
});

describe("strikePcrModel", () => {
  const rows = [row(90, 10, 300), row(95, 100, 240, [100, 300]), row(100, 200, 180), row(105, 300, 60), row(110, 400, 2), row(115, 0, 0)];
  const m = strikePcrModel(rows, { atm: 100, near: 1 });
  it("fits the decades the readings need (at least 0.1 to 10)", () => {
    expect(m.lo).toBe(-3);
    expect(m.hi).toBe(2);
    expect(strikePcrModel([row(100, 100, 120)]).lo).toBe(-1);
    expect(strikePcrModel([row(100, 100, 120)]).hi).toBe(1);
  });
  it("flags only the extremes for a printed figure", () => {
    expect(m.rows.filter((r) => r.extreme).map((r) => r.strike)).toEqual([90, 110]);
  });
  it("keeps the ratio at the window start beside the one now", () => {
    expect(m.rows[1].was.v).toBe(3);
    expect(m.rows[1].now.v).toBeCloseTo(2.4);
  });
  it("names the most put-heavy and call-heavy strikes near the money, and counts each kind", () => {
    expect(m.putHeavy.strike).toBe(95);
    expect(m.callHeavy.strike).toBe(105);
    expect(m.puts).toBe(2);
    expect(m.calls).toBe(3);
    expect(strikePcrLine(m)).toBe("2 put-heavy, 3 call-heavy · most put-heavy near the money 95 (2.40) · most call-heavy 105 (0.20)");
  });
  it("names no put-heavy strike when every one near the money is call-heavy", () => {
    const c = strikePcrModel([row(95, 100, 50), row(100, 100, 80)], { atm: 100 });
    expect(c.putHeavy).toBeNull();
    expect(c.callHeavy.strike).toBe(95);
    expect(strikePcrLine(strikePcrModel([]))).toBe("No strikes to read");
  });
});
