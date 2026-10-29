/**
 * dashboard/oi-series.js reference values (docs/spec/p1-01-recorder.md §6.8–6.10). P1-7 adds its own cases here.
 */
import { describe, expect, it } from "vitest";
import { fromColumns, largestOi, maxPain, pcr } from "./oi-series.js";

/** §6.9 table, OI in thousands of units. */
const K = [24900, 25000, 25100, 25200, 25300];
const CE = [20, 45, 80, 120, 180];
const PE = [140, 110, 90, 50, 25];
const rows = K.map((strike, i) => ({ strike, ce: { oi: CE[i] * 1000, volume: null }, pe: { oi: PE[i] * 1000, volume: null } }));

describe("pcr (§6.8)", () => {
  it("Σ PE / Σ CE over strikes with both sides: 415 / 445 = 0.933", () => {
    const r = pcr(rows);
    expect(r.pcrOi).toBeCloseTo(0.93258, 4);
    expect(Math.round(r.pcrOi * 1000) / 1000).toBe(0.933);
    expect(r).toMatchObject({ ceOi: 445_000, peOi: 415_000, strikes: 5, pcrVol: null });
  });
  it("skips strikes where one side is missing; null without calls", () => {
    const r = pcr([...rows, { strike: 25400, ce: { oi: 999_000 }, pe: null }]);
    expect(r.pcrOi).toBeCloseTo(415 / 445, 6);
    expect(pcr([]).pcrOi).toBeNull();
    expect(pcr([{ strike: 1, ce: { oi: 0, volume: 0 }, pe: { oi: 5, volume: 2 } }])).toMatchObject({ pcrOi: null, pcrVol: null });
  });
  it("volume ratio uses its own pairs", () => {
    const r = pcr([
      { strike: 1, ce: { oi: null, volume: 100 }, pe: { oi: 10, volume: 150 } },
      { strike: 2, ce: { oi: 20, volume: 300 }, pe: { oi: 30, volume: null } },
    ]);
    expect(r.pcrVol).toBe(1.5);
    expect(r.pcrOi).toBe(1.5);
  });
});

describe("maxPain (§6.9)", () => {
  it("finds 25,100 with pain 18,500 (thousands)", () => {
    const r = maxPain(rows);
    expect(r).toEqual({ strike: 25100, pain: 18_500 * 1000 });
  });
  it("pain at each strike matches the table", () => {
    const pain = (S) => K.reduce((s, k, i) => s + CE[i] * Math.max(0, S - k) + PE[i] * Math.max(0, k - S), 0);
    expect(K.map(pain)).toEqual([54_000, 28_500, 18_500, 25_500, 49_500]);
  });
  it("ties go to the strike nearer the forward", () => {
    const sym = [
      { strike: 100, ce: { oi: 10 }, pe: { oi: 10 } },
      { strike: 110, ce: { oi: 10 }, pe: { oi: 10 } },
    ];
    expect(maxPain(sym, { forward: 108 }).strike).toBe(110);
    expect(maxPain(sym, { forward: 101 }).strike).toBe(100);
    expect(maxPain(sym).strike).toBe(100);
    expect(maxPain([])).toBeNull();
  });
});

describe("largestOi (§6.10)", () => {
  it("largest call OI and largest put OI", () => {
    expect(largestOi(rows)).toEqual({ call: { strike: 25300, oi: 180_000 }, put: { strike: 24900, oi: 140_000 } });
  });
  it("ties go nearer the forward", () => {
    const t = [
      { strike: 100, ce: { oi: 50 }, pe: { oi: 7 } },
      { strike: 120, ce: { oi: 50 }, pe: { oi: 7 } },
    ];
    expect(largestOi(t, { forward: 115 })).toEqual({ call: { strike: 120, oi: 50 }, put: { strike: 120, oi: 7 } });
    expect(largestOi(t, { forward: 104 }).call.strike).toBe(100);
    expect(largestOi([])).toEqual({ call: null, put: null });
  });
});

describe("fromColumns", () => {
  it("turns a columnar snapshot into chain rows, keeping nulls", () => {
    const r = fromColumns({ k: [1, 2], ce: { oi: [10, null], vol: [5, 6] }, pe: { oi: [3, 4], vol: [null, 1] } });
    expect(r).toEqual([
      { strike: 1, ce: { oi: 10, volume: 5 }, pe: { oi: 3, volume: null } },
      { strike: 2, ce: { oi: null, volume: 6 }, pe: { oi: 4, volume: 1 } },
    ]);
  });
});
