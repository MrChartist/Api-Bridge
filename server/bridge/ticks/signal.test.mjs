import { describe, expect, it } from "vitest";
import { compareRuns, valuesEqual } from "./compare.mjs";
import { createSignalRunner } from "./runner.mjs";
import { asof, compensatedSum, defineSignal, deltaOf, ema, imbalance, logReturn, microprice, mid, spread, windowExtremes, windowSum } from "./signal.mjs";

const lcg = (seed) => () => ((seed = (seed * 48271) % 2147483647) / 2147483647);

describe("windowSum", () => {
  it("matches a brute-force window on irregular times, including ties", () => {
    const rnd = lcg(3);
    const w = windowSum({ spanMs: 1000 });
    const pts = [];
    let t = 0;
    for (let i = 0; i < 3000; i += 1) {
      t += Math.floor(rnd() * 120) * (rnd() > 0.3 ? 1 : 0);
      const x = (rnd() - 0.5) * 1e4;
      w.push(t, x);
      pts.push([t, x]);
      const inWin = pts.filter(([pt]) => pt > t - 1000);
      expect(w.count(t)).toBe(inWin.length);
      expect(w.sum(t)).toBeCloseTo(inWin.reduce((s, [, v]) => s + v, 0), 6);
    }
    expect(w.count(t + 1000)).toBe(0);
    expect(w.sum(t + 1000)).toBe(0);
    expect(w.mean(t + 1000)).toBeNull();
  });

  it("does not drift over a long session", () => {
    const w = windowSum({ spanMs: 10 });
    for (let i = 0; i < 200_000; i += 1) w.push(i, i % 2 ? 0.1 : 1e8);
    // The window holds 10 points: 5 x 1e8 + 5 x 0.1. A plain running sum would be off by far more than this.
    expect(Math.abs(w.sum(199_999) - (5e8 + 0.5))).toBeLessThan(1e-6);
  });

  it("variance is the population variance", () => {
    const w = windowSum({ spanMs: 100 });
    [2, 4, 4, 4, 5, 5, 7, 9].forEach((x, i) => w.push(i, x));
    expect(w.mean(7)).toBe(5);
    expect(w.variance(7)).toBeCloseTo(4, 12);
  });

  it("compensatedSum keeps the small values a plain sum loses", () => {
    const s = compensatedSum();
    s.add(1e16);
    for (let i = 0; i < 10; i += 1) s.add(1);
    s.sub(1e16);
    expect(s.value()).toBe(10);
  });
});

describe("windowExtremes", () => {
  it("matches brute force", () => {
    const rnd = lcg(11);
    const w = windowExtremes({ spanMs: 50 });
    const pts = [];
    for (let t = 0; t < 2000; t += 1 + Math.floor(rnd() * 5)) {
      const x = Math.floor(rnd() * 100);
      w.push(t, x);
      pts.push([t, x]);
      const inWin = pts.filter(([pt]) => pt > t - 50).map(([, v]) => v);
      expect(w.max(t)).toBe(Math.max(...inWin));
      expect(w.min(t)).toBe(Math.min(...inWin));
    }
  });
});

describe("ema", () => {
  it("weighs by elapsed event time: one half-life moves half way", () => {
    const e = ema({ halfLifeMs: 1000 });
    expect(e.push(0, 10)).toBe(10);
    expect(e.push(1000, 20)).toBe(15);
    expect(e.push(1000, 25)).toBe(15); // no time passed: no weight
    expect(e.push(1000, Number.NaN)).toBe(15);
  });
});

describe("asof", () => {
  it("returns the latest value at or before the time, within the tolerance", () => {
    const a = asof({ toleranceMs: 100 });
    expect(a.get("X", 0)).toBeNull();
    a.set("X", 1000, 1);
    a.set("X", 1000, 2); // same time: the later one (by seq) wins
    expect(a.get("X", 1000)).toBe(2);
    expect(a.get("X", 1100)).toBe(2);
    expect(a.get("X", 1101)).toBeNull();
    expect(a.get("X", 999)).toBeNull(); // never a value from the future
    expect(a.entry("X")).toEqual({ time: 1000, value: 2 });
  });
});

describe("deltaOf and features", () => {
  it("turns cumulative volume into per-tick volume, and refuses resets", () => {
    const d = deltaOf();
    expect(d("A", 100)).toBeNull();
    expect(d("A", 150)).toBe(50);
    expect(d("B", 7)).toBeNull();
    expect(d("A", 20)).toBeNull(); // a new day
    expect(d("A", 25)).toBe(5);
  });

  it("book features say null without a sane two-sided quote", () => {
    const t = { bid: 99, ask: 101, bidQty: 300, askQty: 100 };
    expect(mid(t)).toBe(100);
    expect(spread(t)).toBe(2);
    expect(microprice(t)).toBe(100.5);
    expect(imbalance(t)).toBe(0.5);
    expect(mid({ bid: 101, ask: 99 })).toBeNull();
    expect(microprice({ bid: 99, ask: 101 })).toBeNull();
    expect(logReturn(100, 110)).toBeCloseTo(Math.log(1.1), 15);
    expect(logReturn(0, 1)).toBeNull();
  });
});

describe("defineSignal and the runner", () => {
  it("validates the definition", () => {
    expect(() => defineSignal({ symbols: ["NSE:A"], create: () => () => 1 })).toThrow(/name/);
    expect(() => defineSignal({ name: "x", symbols: [], create: () => () => 1 })).toThrow(/symbols/);
    expect(() => defineSignal({ name: "x", symbols: ["NSE:A"], create: () => () => 1, time: "wall" })).toThrow(/time/);
  });

  it("gives each run fresh state, skips other symbols, and snapshots object outputs", () => {
    const sig = defineSignal({
      name: "count",
      symbols: ["NSE:A"],
      create() {
        const state = { n: 0 };
        return () => {
          state.n += 1;
          return state;
        };
      },
    });
    const r1 = createSignalRunner(sig);
    r1.push({ symbol: "NSE:A", receivedAt: 1 });
    r1.push({ symbol: "NSE:B", receivedAt: 2 });
    r1.push({ symbol: "NSE:A", receivedAt: 3 });
    expect(r1.outputs.map((o) => o.value.n)).toEqual([1, 2]); // not [2, 2]: the first output was copied
    const r2 = createSignalRunner(sig);
    expect(r2.push({ symbol: "NSE:A", receivedAt: 1 }).value.n).toBe(1);
    expect(r1.stats()).toEqual({ ticks: 2, produced: 2 });
  });

  it("can run on exchange time, skipping ticks that lack it", () => {
    const sig = defineSignal({ name: "x", symbols: ["NSE:A"], time: "exchangeTs", create: () => (_t, { time }) => time });
    const r = createSignalRunner(sig);
    expect(r.push({ symbol: "NSE:A", receivedAt: 5, exchangeTs: null })).toBeNull();
    expect(r.push({ symbol: "NSE:A", receivedAt: 5, exchangeTs: 3 }).value).toBe(3);
  });
});

describe("compareRuns", () => {
  const out = (n, time, symbol, value) => ({ n, time, symbol, value });
  const base = [out(1, 10, "A", 1), out(2, 10, "A", 2), out(3, 11, "B", { x: [1, 2] }), out(4, 12, "A", Number.NaN)];

  it("says identical when every output matches", () => {
    expect(compareRuns(base, structuredClone(base))).toMatchObject({ identical: true, compared: 4, equal: 4 });
  });

  it("classifies value, missing, extra and order differences and finds the first", () => {
    const live = [out(1, 10, "A", 1), out(2, 11, "B", { x: [1, 3] }), out(3, 10, "A", 2), out(4, 13, "C", 0)];
    const c = compareRuns(base, live);
    expect(c).toMatchObject({ identical: false, value: 1, missing: 1, extra: 1, order: 1 });
    expect(c.firstDivergence).toMatchObject({ kind: "order", time: 11, symbol: "B" });
    expect(c.summary).toMatch(/^Not identical: 1 different values, 1 missing, 1 extra, 1 out of order/);
  });

  it("a tolerance accepts small numeric differences only", () => {
    expect(valuesEqual(1, 1 + 1e-12)).toBe(false);
    expect(valuesEqual(1, 1 + 1e-12, 1e-9)).toBe(true);
    expect(valuesEqual(0, -0)).toBe(true);
    expect(valuesEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(valuesEqual([1], { 0: 1 })).toBe(false);
    expect(valuesEqual(null, 0)).toBe(false);
  });
});
