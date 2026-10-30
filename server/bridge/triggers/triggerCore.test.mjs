import { describe, expect, it } from "vitest";
import { crossed, legProblems, legWords, opFor, reduceOnlyQty, step, toTick, trail } from "./triggerCore.mjs";

const leg = (op, trigger, extra = {}) => ({ op, trigger, order: { side: "SELL", quantity: 65 }, ...extra });

describe("trigger core", () => {
  it("rounds to the tick without float noise", () => {
    expect(toTick(121.33, 0.05, "down")).toBe(121.3);
    expect(toTick(121.31, 0.05, "up")).toBe(121.35);
    expect(toTick(0.1 + 0.2, 0.05)).toBe(0.3);
  });

  it("puts a trigger above or below the price, never at it", () => {
    expect(opFor(110, 120)).toBe("below");
    expect(opFor(130, 120)).toBe("above");
    expect(opFor(120, 120)).toBeNull();
  });

  it("fires inclusive and on a gap through", () => {
    expect(crossed(leg("below", 100), 100)).toBe(true);
    expect(crossed(leg("below", 100), 60)).toBe(true);
    expect(crossed(leg("below", 100), 100.05)).toBe(false);
    expect(crossed(leg("above", 100), 140)).toBe(true);
  });

  it("an OCO fires the leg that was touched", () => {
    const t = { legs: [leg("below", 90), leg("above", 110)] };
    expect(step(t, 100).fire).toBeNull();
    expect(step(t, 111).fire).toBe(1);
    expect(step(t, 89).fire).toBe(0);
  });

  it("trails by points or percent and only tightens", () => {
    const long = { legs: [leg("below", 90, { trail: { points: 10 } })] };
    expect(trail(long, 105)).toBe(true);
    expect(long.legs[0].trigger).toBe(95);
    expect(trail(long, 98)).toBe(false);
    expect(long.legs[0].trigger).toBe(95);
    const short = { legs: [{ ...leg("above", 120), trail: { pct: 10 } }] };
    trail(short, 100);
    expect(short.legs[0].trigger).toBe(110);
    trail(short, 104);
    expect(short.legs[0].trigger).toBe(110);
  });

  it("checks legs in plain words", () => {
    expect(legProblems("oco", [leg("below", 90)], 100)[0].message).toMatch(/two legs/);
    expect(legProblems("single", [leg("below", 110)], 100)[0].message).toMatch(/already at or below/);
    expect(legProblems("oco", [leg("below", 90), leg("below", 80)], 100)[0].message).toMatch(/one leg above/);
    expect(legProblems("oco", [leg("below", 90), { ...leg("above", 110), order: { side: "BUY", quantity: 65 } }], 100)[0].message).toMatch(/same side/);
    expect(legProblems("single", [leg("below", 90, { trail: { pct: 60 } })], 100)[0].message).toMatch(/50 or less/);
    expect(legProblems("oco", [leg("below", 90), leg("above", 110)], 100)).toEqual([]);
    expect(legProblems("single", [leg("below", 110)], null)).toEqual([]);
  });

  it("says a leg in words", () => {
    expect(legWords(leg("below", 98.5, { trail: { points: 5 } }))).toBe("Sell when LTP ≤ 98.5 (trails 5 points)");
  });

  it("reduce-only never sends more than is held or across zero", () => {
    expect(reduceOnlyQty(130, "SELL", 65)).toEqual({ quantity: 65, reason: null });
    expect(reduceOnlyQty(65, "SELL", 0).reason).toMatch(/already closed/);
    expect(reduceOnlyQty(65, "SELL", -65).reason).toMatch(/add to it/);
    expect(reduceOnlyQty(65, "BUY", -195)).toEqual({ quantity: 65, reason: null });
    expect(reduceOnlyQty(65, "SELL", null).quantity).toBe(0);
  });
});
