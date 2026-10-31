/**
 * compute.mjs: the core's studies through the Bridge's job format. Values are checked two ways:
 *  - against the core's own kernel (server/vendor/chartist-core/kernel, the public `@chartist/core/kernel` entry: the
 *    same functions the owner's chart draws with), which proves the settings, alignment and warm-up trimming;
 *  - against textbook definitions written here (SMA, EMA seeded with the SMA, Wilder RSI, Bollinger with the population
 *    deviation), which proves the compiled copy computes what the names say.
 */
import { describe, expect, it } from "vitest";
import * as kernel from "../../vendor/chartist-core/kernel/index.js";
import { BridgeError } from "../core/errors.mjs";
import { MAX_STUDIES, catalogue, dailyInput, istYmd, planJob, runJob } from "./compute.mjs";
import { makeCandles } from "./__fixtures__/candles.mjs";

const C = makeCandles(400);
const close = C.map((c) => c.close);
const high = C.map((c) => c.high);
const low = C.map((c) => c.low);

const closeTo = (got, want, digits = 9) => {
  expect(got.length).toBe(want.length);
  got.forEach((g, i) => {
    const w = want[i];
    if (w === null || w === undefined || !Number.isFinite(w)) expect(g, `index ${i}`).toBeNull();
    else expect(g, `index ${i}`).toBeCloseTo(w, digits);
  });
};
const seriesOf = (r, key) => {
  const s = r.series.find((x) => x.key === key);
  expect(s, key).toBeDefined();
  return s.values;
};
const code = (fn) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BridgeError);
    return err.code;
  }
  throw new Error("did not throw");
};

// Textbook definitions.
function sma(v, n) {
  return v.map((_, i) => (i < n - 1 ? null : v.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n));
}
function ema(v, n) {
  const k = 2 / (n + 1);
  const out = new Array(v.length).fill(null);
  let e = v.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = e;
  for (let i = n; i < v.length; i += 1) out[i] = e = v[i] * k + e * (1 - k);
  return out;
}
function rsi(v, n) {
  const out = new Array(v.length).fill(null);
  let g = 0;
  let l = 0;
  for (let i = 1; i <= n; i += 1) {
    const d = v[i] - v[i - 1];
    g += Math.max(d, 0);
    l += Math.max(-d, 0);
  }
  g /= n;
  l /= n;
  out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < v.length; i += 1) {
    const d = v[i] - v[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
function bollinger(v, n, k) {
  return v.map((_, i) => {
    if (i < n - 1) return null;
    const w = v.slice(i - n + 1, i + 1);
    const m = w.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n);
    return { upper: m + k * sd, mid: m, lower: m - k * sd };
  });
}

describe("catalogue", () => {
  const cat = catalogue();
  it("lists the core's 88 studies (80 available) and 24 patterns", () => {
    expect(cat.studies).toHaveLength(88);
    expect(cat.studies.filter((s) => s.available)).toHaveLength(80);
    expect(cat.patterns).toHaveLength(24);
    for (const id of ["sma", "ema", "rsi", "bb", "supertrend", "macd", "vwap", "ichimoku"]) expect(cat.studies.find((s) => s.id === id)?.available, id).toBe(true);
  });
  it("gives settings with ranges and defaults, outputs and pane", () => {
    const bb = cat.studies.find((s) => s.id === "bb");
    expect(bb.pane).toBe("price");
    expect(bb.params).toEqual([
      { name: "length", type: "int", min: 2, max: 5000, default: 20 },
      { name: "k", type: "number", min: 0.1, max: 10, default: 2 },
      { name: "src", type: "source", values: ["close", "open", "high", "low", "volume", "hl2", "hlc3", "ohlc4"], default: "close" },
    ]);
    expect(bb.outputs.map((o) => o.name)).toEqual(["upper", "mid", "lower"]);
    const st = cat.studies.find((s) => s.id === "supertrend");
    expect(st.outputs).toEqual([{ name: "value", type: "float" }, { name: "direction", type: "int" }]);
    expect(cat.studies.find((s) => s.id === "rsi").pane).toBe("panel");
    const pivot = cat.studies.find((s) => s.id === "pivot");
    expect(pivot.available).toBe(false);
    expect(pivot.reason.length).toBeGreaterThan(10);
  });
});

describe("studies match the core's kernel and the textbook", () => {
  const job = {
    studies: [
      { id: "sma", params: { length: 20 }, key: "sma20" },
      { id: "ema", params: { length: 9 }, key: "ema9" },
      { id: "rsi", params: { length: 14 }, key: "rsi" },
      { id: "bb", params: { length: 20, k: 2 }, key: "bb" },
      { id: "supertrend", params: { period: 10, mult: 3 }, key: "st" },
    ],
  };
  const r = runJob(job, C);

  it("aligns every series to the candles", () => {
    expect(r.time).toEqual(C.map((c) => c.time));
    for (const s of r.series) expect(s.values, s.key).toHaveLength(C.length);
    expect(r.series.map((s) => s.key)).toEqual(["sma20.value", "ema9.value", "rsi.value", "bb.upper", "bb.mid", "bb.lower", "st.value", "st.direction"]);
    expect(r.series.find((s) => s.key === "bb.upper").pane).toBe("price");
    expect(r.series.find((s) => s.key === "rsi.value").pane).toBe("panel");
    expect(r.series.find((s) => s.key === "st.direction").type).toBe("int");
  });

  it("sma, ema, rsi and bollinger equal the kernel and the textbook", () => {
    closeTo(seriesOf(r, "sma20.value"), kernel.calcSMA(close, 20));
    closeTo(seriesOf(r, "sma20.value"), sma(close, 20));
    closeTo(seriesOf(r, "ema9.value"), kernel.calcEMA(close, 9));
    closeTo(seriesOf(r, "ema9.value"), ema(close, 9));
    closeTo(seriesOf(r, "rsi.value"), kernel.calcRSI(close, 14));
    closeTo(seriesOf(r, "rsi.value"), rsi(close, 14), 7);
    const kb = kernel.calcBB(close, 20, 2);
    const tb = bollinger(close, 20, 2);
    for (const f of ["upper", "mid", "lower"]) {
      closeTo(seriesOf(r, `bb.${f}`), kb.map((x) => x?.[f] ?? null));
      closeTo(seriesOf(r, `bb.${f}`), tb.map((x) => x?.[f] ?? null), 7);
    }
  });

  it("supertrend equals the kernel where the line exists", () => {
    const ks = kernel.calcSuperTrend(high, low, close, 10, 3);
    const v = seriesOf(r, "st.value");
    const d = seriesOf(r, "st.direction");
    closeTo(v, ks.map((x) => x?.value ?? null));
    let defined = 0;
    v.forEach((x, i) => {
      if (x === null) expect(d[i]).toBeNull();
      else {
        defined += 1;
        expect(Math.abs(d[i])).toBe(1);
        expect(d[i]).toBe(ks[i].direction);
      }
    });
    expect(defined).toBeGreaterThan(300);
  });

  it("keeps only the candles from `from` on, computed with the earlier ones", () => {
    const cut = runJob(job, C, { from: 100 });
    expect(cut.time).toEqual(C.slice(100).map((c) => c.time));
    expect(seriesOf(cut, "sma20.value")).toEqual(seriesOf(r, "sma20.value").slice(100));
    expect(seriesOf(cut, "sma20.value")[0]).not.toBeNull();
  });

  it("settings and src= reach the core", () => {
    const x = runJob({ studies: [{ id: "sma", params: { length: 5, src: "hl2" } }] }, C);
    closeTo(seriesOf(x, "sma0.value"), sma(C.map((c) => (c.high + c.low) / 2), 5));
    const m = runJob({ studies: [{ id: "macd" }] }, C);
    expect(m.series.map((s) => s.key)).toEqual(["macd0.macd", "macd0.signal", "macd0.hist"]);
    expect(m.studies[0].params).toEqual({ fast: 12, slow: 26, signal: 9, src: "close" });
  });

  it("plans the warm-up from the core's own plan", () => {
    expect(planJob({ studies: [{ id: "sma", params: { length: 50 } }] }).warmBars).toBe(49);
    expect(planJob({ studies: [{ id: "sma", params: { length: 50 } }, { id: "rsi", params: { length: 200 } }] }).warmBars).toBeGreaterThanOrEqual(200);
  });
});

describe("patterns", () => {
  it("give a marker on each candle where the kernel finds the pattern", () => {
    const r = runJob({ patterns: "all" }, C);
    expect(r.series).toEqual([]);
    expect(r.markers.length).toBeGreaterThan(5);
    const kc = C.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
    for (const id of ["doji", "bullish_engulfing", "bearish_engulfing", "inside_bar"]) {
      const camel = id.replace(/_([a-z])/g, (_m, ch) => ch.toUpperCase());
      const want = kernel.calcCandlePattern(kc, camel).flatMap((v, i) => (v === 1 ? [C[i].time] : []));
      expect(r.markers.filter((m) => m.pattern === id).map((m) => m.time), id).toEqual(want);
    }
    const bull = r.markers.find((m) => m.bias === "bullish");
    if (bull) {
      const c = C.find((x) => x.time === bull.time);
      expect(bull).toMatchObject({ position: "below", price: c.low, shape: "triangle_up" });
    }
  });
});

describe("scripts", () => {
  const src = `@indicator(name="Trend", overlay=True)
def f(n: int = input(20, min=2, max=100)):
    fast = ta.ema(close, 10)
    slow = ta.sma(close, n)
    plot(fast, "Fast", color=color.blue)
    plot(slow, "Slow")
    fill(fast, slow)
    mark(ta.crossover(fast, slow), where="below", shape="triangle_up", text="Up")
`;
  it("plots, fills and markers come back in the same shape as studies", () => {
    const r = runJob({ script: src, inputs: { n: 30 } }, C);
    expect(r.script).toMatchObject({ name: "Trend", overlay: true });
    expect(r.script.irHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.series.map((s) => [s.key, s.label, s.pane, s.style])).toEqual([
      ["p1", "Fast", "price", "line"],
      ["p2", "Slow", "price", "line"],
    ]);
    expect(r.series[0].color).toBe("blue");
    closeTo(r.series[1].values, sma(close, 30));
    expect(r.fills).toEqual([{ key: "f1", between: ["p1", "p2"] }]);
    expect(r.markers.length).toBeGreaterThan(0);
    for (const m of r.markers) expect(m).toMatchObject({ key: "p3", position: "below", shape: "triangle_up", text: "Up" });
  });

  it("a script's problems carry the core's code and line", () => {
    try {
      runJob({ script: "plot(ta.sma(close, 20)\n" }, C);
      throw new Error("no error");
    } catch (err) {
      expect(err.code).toBe("VALIDATION_FAILED");
      expect(err.errors[0].message).toMatch(/^E-[A-Z-]+ line 1:/);
    }
    expect(code(() => runJob({ script: '@screener()\ndef s():\n    return close > 1\n' }, C))).toBe("VALIDATION_FAILED");
    expect(code(() => runJob({ script: src, inputs: { n: 1000 } }, C))).toBe("VALIDATION_FAILED");
  });

  it("a script that needs data the Bridge does not pass is refused, not guessed", () => {
    expect(code(() => runJob({ script: 'plot(close / bench.close, "Rel")\n' }, C))).toMatch(/CAPABILITY_UNSUPPORTED|VALIDATION_FAILED/);
  });
});

describe("limits and refusals", () => {
  it("refuses unknown studies, settings and out-of-range or non-number values before writing any script", () => {
    expect(code(() => runJob({ studies: [{ id: "nope" }] }, C))).toBe("VALIDATION_FAILED");
    expect(code(() => runJob({ studies: [{ id: "pivot" }] }, C))).toBe("VALIDATION_FAILED");
    expect(code(() => runJob({ studies: [{ id: "sma", params: { len: 5 } }] }, C))).toBe("VALIDATION_FAILED");
    expect(code(() => runJob({ studies: [{ id: "sma", params: { length: 501 } }] }, C))).toBe("VALIDATION_FAILED");
    expect(code(() => runJob({ studies: [{ id: "sma", params: { length: 2.5 } }] }, C))).toBe("VALIDATION_FAILED");
    expect(code(() => runJob({ studies: [{ id: "sma", params: { length: '5)\nplot(volume, "x"' } }] }, C))).toBe("VALIDATION_FAILED");
    expect(code(() => runJob({ studies: [{ id: "envelope", params: { ma_type: 'sma")\nplot(1' } }] }, C))).toBe("VALIDATION_FAILED");
    expect(code(() => runJob({ studies: [{ id: "sma", params: { src: "close * 2" } }] }, C))).toBe("VALIDATION_FAILED");
    expect(code(() => runJob({ patterns: ["hanging_man"] }, C))).toBe("VALIDATION_FAILED");
    expect(code(() => runJob({ studies: [{ id: "sma" }], script: "plot(close, \"c\")\n" }, C))).toBe("VALIDATION_FAILED");
    expect(code(() => runJob({}, C))).toBe("VALIDATION_FAILED");
  });

  it(`at most ${MAX_STUDIES} studies, and a script within the core's size limit`, () => {
    const many = Array.from({ length: MAX_STUDIES + 1 }, () => ({ id: "sma" }));
    expect(code(() => runJob({ studies: many }, C))).toBe("COMPUTE_LIMIT");
    expect(code(() => runJob({ script: `${"# x\n".repeat(3500)}plot(close, "c")\n` }, C))).toBe("COMPUTE_LIMIT");
  });

  it("the core's run budget stops a request that would touch too many values", () => {
    expect(code(() => runJob({ studies: [{ id: "sma" }, { id: "rsi" }] }, C, { budget: 500 }))).toBe("COMPUTE_LIMIT");
    expect(code(() => runJob({ script: 'plot(ta.sma(close, 50), "s")\n' }, C, { budget: 401 }))).toBe("COMPUTE_LIMIT");
  });

  it("refuses intraday candles (two on one date)", () => {
    const intraday = [C[0], { ...C[0], time: C[0].time + 300 }];
    expect(code(() => dailyInput(intraday))).toBe("CAPABILITY_UNSUPPORTED");
    expect(istYmd(C[0].time)).toBe(20260105);
  });
});
