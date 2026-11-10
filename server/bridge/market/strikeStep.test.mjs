import { describe, expect, it } from "vitest";
import { strikeStepOf } from "./chain.mjs";
import { stepOfStrikes } from "../library/strikes.mjs";

const range = (from, to, step) => {
  const out = [];
  for (let k = from; k <= to; k += step) out.push(k);
  return out;
};

describe("strike step near the money", () => {
  // 50-point strikes near the money (24000-26000), 100-point strikes everywhere else (20000-30000): the whole-ladder
  // mode is 100, the step a trader sees near the price is 50.
  const ladder = [...new Set([...range(20000, 30000, 100), ...range(24000, 26000, 50)])].sort((a, b) => a - b);

  it("without a spot it is the most common gap of the whole ladder, as before", () => {
    expect(strikeStepOf(ladder)).toBe(100);
    expect(strikeStepOf([1360, 1380, 1400, 1410, 1420, 1440, 1460])).toBe(20);
    expect(strikeStepOf([100, 200])).toBeNull();
  });

  it("with a spot it is read from the 10 strikes each side of the one nearest the price", () => {
    expect(strikeStepOf(ladder, { spot: 25012 })).toBe(50);
    expect(stepOfStrikes(ladder, 25012)).toBe(50);
    // Far from the dense region the step is the outer one.
    expect(strikeStepOf(ladder, { spot: 21000 })).toBe(100);
  });

  it("an even ladder is unchanged by the spot, and a short ladder uses all its strikes", () => {
    const even = range(24000, 26000, 50);
    expect(strikeStepOf(even, { spot: 25012 })).toBe(50);
    expect(strikeStepOf([100, 150, 200, 250], { spot: 180 })).toBe(50);
    expect(strikeStepOf(ladder, { spot: null })).toBe(100);
    expect(strikeStepOf(ladder, { spot: -1 })).toBe(100);
  });
});
