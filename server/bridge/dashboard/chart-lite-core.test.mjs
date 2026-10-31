// Ported from MrChartist/scanner src/components/patterns/lite-chart, <commit c2ac504> (crisp.test.ts,
// pattern-lite-geometry.test.ts), plus the dashboard's scales, model and time-axis tests. The scanner code is the
// owner's own; all rights reserved.
import { describe, expect, it } from "vitest";
import * as C from "./chart-lite-core.js";

const DAY = 86_400_000;
const IST = 330 * 60_000;
/** Epoch ms of an IST wall time. */
const ist = (y, mo, d, hh = 0, mm = 0) => Date.UTC(y, mo - 1, d, hh, mm) - IST;

describe("device-pixel snapping (crisp.test.ts)", () => {
  it("snaps to the device grid at every density", () => {
    expect(C.snap(10.4, 1)).toBe(10);
    expect(C.snap(10.4, 2)).toBe(10.5);
    expect(C.snap(10.4, 3)).toBeCloseTo(10.3333, 3);
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      const v = C.snap(37.37, dpr) * dpr;
      expect(Math.abs(v - Math.round(v))).toBeLessThan(1e-9);
    }
  });

  it("places a 1 CSS px line so both its edges sit on device-pixel boundaries", () => {
    for (const dpr of [1, 2, 3]) {
      for (const y of [10, 10.2, 10.5, 10.9]) {
        const c = C.crisp(y, dpr, 1);
        const top = c * dpr - Math.round(dpr) / 2;
        expect(Math.abs(top - Math.round(top))).toBeLessThan(1e-9);
      }
    }
  });

  it("a hairline is exactly one device pixel, and the box a whole number of them", () => {
    expect(C.hairline(1)).toBe(1);
    expect(C.hairline(2)).toBe(0.5);
    expect(C.hairline(0.5)).toBe(1);
    for (const dpr of [1, 1.25, 2, 3]) {
      const w = C.deviceFloor(333.7, dpr);
      expect(w).toBeLessThanOrEqual(333.7);
      expect(Math.abs(w * dpr - Math.round(w * dpr))).toBeLessThan(1e-9);
    }
    expect(C.deviceFloor(0, 2)).toBe(0);
  });
});

describe("text width estimate", () => {
  it("grows with the string and stays in a sane range for a price tag", () => {
    expect(C.estimateWidth("Strike 26000", 12)).toBeGreaterThan(C.estimateWidth("BE 97", 12));
    const w = C.estimateWidth("Strike 26000", 12, 600);
    expect(w).toBeGreaterThan(55);
    expect(w).toBeLessThan(100);
  });
});

describe("spreadLabels and capsules (crisp.test.ts)", () => {
  it("keeps a clear gap between capsules that share a price", () => {
    const out = C.spreadLabels([{ y: 100 }, { y: 101 }, { y: 102 }], C.CAPSULE_H + C.CAPSULE_GAP, 8, 300);
    for (let i = 1; i < out.length; i++) expect(out[i].ly - out[i - 1].ly - C.CAPSULE_H).toBeGreaterThanOrEqual(C.CAPSULE_GAP - 1e-9);
    expect(C.CAPSULE_GAP).toBeGreaterThanOrEqual(4);
  });
  it("separates crowded labels by at least the gap, keeping their order", () => {
    const out = C.spreadLabels([{ y: 50 }, { y: 52 }, { y: 54 }], 20, 0, 200);
    expect(out.map((o) => o.ly).sort((a, b) => a - b)).toEqual(out.map((o) => o.ly));
    for (let i = 1; i < out.length; i++) expect(out[i].ly - out[i - 1].ly).toBeGreaterThanOrEqual(20 - 1e-9);
  });
  it("keeps the stack on screen at the bottom edge", () => {
    const out = C.spreadLabels([{ y: 190 }, { y: 195 }, { y: 199 }], 20, 10, 200);
    expect(Math.max(...out.map((o) => o.ly))).toBeLessThanOrEqual(200);
    expect(Math.min(...out.map((o) => o.ly))).toBeGreaterThanOrEqual(10);
  });
  it("leaves well-separated labels exactly where they are", () => {
    expect(C.spreadLabels([{ y: 30 }, { y: 90 }], 20, 0, 200).map((o) => o.ly)).toEqual([30, 90]);
  });
  it("pins a level kept off the scale to the edge it lies beyond, with an arrow and no ray", () => {
    const pane = { top: 10, priceBottom: 200, lo: 0, hi: 190, yOf: (v) => 200 - v };
    const [above, inside, below] = C.placeCapsules([{ id: "a", value: 400, text: "Strike 400" }, { id: "b", value: 100, text: "Strike 100" }, { id: "c", value: -50, text: "Strike \u221250" }], pane).sort((x, y) => x.value - y.value).reverse();
    expect(above).toMatchObject({ off: "above", text: "Strike 400 \u2191" });
    expect(above.ly).toBeCloseTo(10 + C.CAPSULE_H / 2);
    expect(inside).toMatchObject({ off: null, text: "Strike 100", ly: 100 });
    expect(below).toMatchObject({ off: "below", text: "Strike \u221250 \u2193" });
    expect(below.ly).toBeCloseTo(200 - C.CAPSULE_H / 2);
  });
  it("hides the price ticks a capsule covers", () => {
    const pane = { top: 0, priceBottom: 200, yOf: (v) => 200 - v };
    const caps = C.placeCapsules([{ id: "a", value: 100, text: "Strike 100" }], pane);
    expect(caps[0].ly).toBe(100);
    expect(C.hideTicks([50, 100, 104, 150], pane, caps)).toEqual([50, 150]);
  });
});

const candles = (n) => Array.from({ length: n }, (_, i) => ({ i, t: i * DAY, open: 100 + i, high: 105 + i, low: 95 + i, close: 102 + i, volume: 10 + i }));

describe("groupBars (crisp.test.ts)", () => {
  it("draws every candle when they fit", () => {
    const { bars, step } = C.groupBars(candles(20), 0, 19, 40);
    expect(step).toBe(1);
    expect(bars).toHaveLength(20);
    expect(bars[3]).toMatchObject({ open: 103, close: 105, high: 108, low: 98, center: 3, up: true });
  });
  it("merges neighbours into true OHLC bars when they do not", () => {
    const { bars, step } = C.groupBars(candles(20), 0, 19, 5);
    expect(step).toBe(4);
    expect(bars).toHaveLength(5);
    expect(bars[0]).toMatchObject({ open: 100, close: 105, high: 108, low: 95, volume: 10 + 11 + 12 + 13, center: 1.5 });
  });
  it("handles a ragged final group", () => {
    const { bars } = C.groupBars(candles(10), 0, 9, 4);
    expect(bars.length).toBe(4);
    expect(bars[bars.length - 1].center).toBe(9);
  });
  it("centres a group on the shared time axis, not the candle array", () => {
    const sparse = candles(4).map((c, k) => ({ ...c, i: k * 3 }));
    expect(C.groupBars(sparse, 0, 3, 2).bars.map((b) => b.center)).toEqual([1.5, 7.5]);
  });
});

describe("candlePaths (crisp.test.ts)", () => {
  const bars = C.groupBars(candles(10), 0, 9, 10).bars;
  const xOf = (i) => 10 + i * 20;
  const yOf = (p) => 200 - p;
  it("emits four paths, one segment per candle", () => {
    const p = C.candlePaths(bars, xOf, yOf, 20, 2);
    expect((p.upBody.match(/M/g) ?? []).length).toBe(10);
    expect((p.upWick.match(/M/g) ?? []).length).toBe(10);
    expect(p.downBody).toBe("");
  });
  it("routes falling candles to the down paths", () => {
    const p = C.candlePaths(bars.map((b) => ({ ...b, up: false })), xOf, yOf, 20, 2);
    expect(p.upBody).toBe("");
    expect((p.downWick.match(/M/g) ?? []).length).toBe(10);
  });
  it("puts every wick on a device-pixel centre and gives bodies an odd device-pixel width", () => {
    for (const dpr of [1, 2, 3]) {
      const p = C.candlePaths(bars, xOf, yOf, 7.3, dpr);
      for (const m of p.upWick.matchAll(/M([\d.]+) /g)) {
        const dev = Number(m[1]) * dpr - 0.5;
        expect(Math.abs(dev - Math.round(dev))).toBeLessThan(2e-3);
      }
      for (const m of p.upBody.matchAll(/h([\d.]+)v/g)) expect(Math.round(Number(m[1]) * dpr) % 2).toBe(1);
    }
  });
  it("never lets a doji vanish: minimum body height is one device pixel", () => {
    const p = C.candlePaths([{ ...bars[0], open: 100, close: 100, up: true }], xOf, yOf, 20, 2);
    expect(Number(/v([\d.]+)h/.exec(p.upBody)[1])).toBeGreaterThanOrEqual(0.5 - 1e-9);
  });
});

describe("volumePaths (crisp.test.ts)", () => {
  it("scales to the tallest bar and respects the band", () => {
    const bars = C.groupBars(candles(6), 0, 5, 6).bars;
    const v = C.volumePaths(bars, (i) => 10 + i * 20, { top: 100, bottom: 130 }, 20, 2);
    expect((v.up.match(/M/g) ?? []).length).toBe(6);
    const heights = [...v.up.matchAll(/v([\d.]+)h/g)].map((m) => Number(m[1]));
    expect(Math.max(...heights)).toBeLessThanOrEqual(30 + 1e-9);
    expect(Math.max(...heights)).toBeCloseTo(30, 0);
  });
  it("draws nothing when there is no volume", () => {
    const flat = C.groupBars(candles(4).map((c) => ({ ...c, volume: 0 })), 0, 3, 4).bars;
    expect(C.volumePaths(flat, (i) => i * 10, { top: 0, bottom: 20 }, 10, 1)).toEqual({ up: "", down: "" });
  });
});

describe("lines, areas, bands and histograms", () => {
  const xOf = (i) => i * 10;
  const yOf = (v) => 100 - v;
  it("breaks a line at a missing value", () => {
    expect(C.linePath([{ i: 0, v: 1 }, { i: 1, v: 2 }, { i: 2, v: NaN }, { i: 3, v: 4 }], xOf, yOf)).toBe("M0 99L10 98M30 96");
  });
  it("closes an area to its base, one run each", () => {
    expect(C.areaPath([{ i: 0, v: 10 }, { i: 1, v: 20 }], xOf, yOf, 100)).toBe("M0 100L0 90L10 80L10 100Z");
    expect(C.areaPath([{ i: 0, v: 10 }], xOf, yOf, 100)).toBe("");
  });
  it("draws a band between its edges", () => {
    expect(C.bandPath([{ i: 0, lo: 1, hi: 3 }, { i: 1, lo: 2, hi: 4 }], xOf, yOf)).toBe("M0 97L10 96L10 98L0 99Z");
  });
  it("splits a signed series at zero so gains and losses fill apart", () => {
    const { pos, neg } = C.splitSigned([{ i: 0, v: 10 }, { i: 1, v: -10 }]);
    expect(pos.map((p) => [p.i, p.v])).toEqual([[0, 10], [0.5, 0], [1, NaN]]);
    expect(neg.map((p) => [p.i, p.v])).toEqual([[0, NaN], [0.5, 0], [1, -10]]);
  });
  it("tones a signed histogram by sign and snaps it to the grid", () => {
    const out = C.histogramPaths([{ i: 0, v: 5 }, { i: 1, v: -5 }, { i: 2, v: 2, tone: "warn" }], xOf, yOf, 10, 2, { signed: true });
    expect(Object.keys(out).sort()).toEqual(["neg", "pos", "warn"]);
    for (const m of out.pos.matchAll(/[Mhv]([\d.-]+)/g)) expect(Math.abs(Number(m[1]) * 2 - Math.round(Number(m[1]) * 2))).toBeLessThan(1e-6);
  });
});

describe("scales", () => {
  it("picks round ticks that cover the range", () => {
    expect(C.niceTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(C.niceTicks(25_812, 26_243, 4)).toEqual([25_900, 26_000, 26_100, 26_200]);
    expect(C.niceTicks(0.8, 1.3, 5)).toEqual([0.8, 0.9, 1, 1.1, 1.2, 1.3]);
    expect(C.niceTicks(5, 5)).toEqual([5]);
    expect(C.niceTicks(NaN, 1)).toEqual([]);
  });
  it("gives each step the decimals it needs", () => {
    expect(C.tickDecimals([0, 100])).toBe(0);
    expect(C.tickDecimals([0.8, 0.9])).toBe(1);
    expect(C.tickDecimals([1.05, 1.1])).toBe(2);
  });
  it("covers every value with a margin and keeps the references in view", () => {
    const d = C.paneDomain([10, 20], { include: [0] });
    expect(d.lo).toBeLessThan(0);
    expect(d.hi).toBeGreaterThan(20);
    const flat = C.paneDomain([50, 50]);
    expect(flat.hi).toBeGreaterThan(flat.lo);
    expect(C.paneDomain([NaN])).toBeNull();
  });
});

describe("model and layout (pattern-lite-geometry.test.ts)", () => {
  const series = Array.from({ length: 80 }, (_, i) => ({ t: ist(2026, 6, 1) + i * DAY, open: 100, high: 101 + (i === 33 ? 12 : 0), low: 99 - (i === 36 ? 9 : 0), close: 100 + (i % 5), volume: 1000 + i }));
  const spec = (extra = [], volume = false) => ({ series: [{ type: "candles", data: series, volume }, ...extra] });

  it("puts every series on one shared time axis", () => {
    const m = C.buildModel({ series: [{ type: "line", data: [{ t: 3, v: 1 }, { t: 1, v: 2 }] }, { type: "line", data: [{ t: 2, v: 5 }] }] });
    expect(m.times).toEqual([1, 2, 3]);
    expect(m.series[0].pts.map((p) => p.i)).toEqual([0, 2]);
    expect(m.hasData).toBe(true);
    expect(C.buildModel({ series: [{ type: "level", value: 5 }] }).hasData).toBe(false);
    expect(C.buildModel({ series: [{ type: "nope", data: [{ t: 1, v: 1 }] }] }).series).toEqual([]);
  });

  it("reserves a volume strip under the price area without changing the horizontal scale", () => {
    const plain = C.buildModel(spec());
    const withVol = C.buildModel(spec([], true));
    const [p] = C.layoutPanes(plain, 300);
    const [v] = C.layoutPanes(withVol, 300);
    expect(p.volumeBand).toBeNull();
    expect(v.volumeBand.bottom - v.volumeBand.top).toBeLessThanOrEqual(C.VOLUME_BAND);
    expect(C.layoutX(withVol, 400, 50).xOf(30)).toBeCloseTo(C.layoutX(plain, 400, 50).xOf(30));
    expect(v.yOf(90)).toBeLessThan(p.yOf(90));
    expect(v.yOf(90)).toBeLessThanOrEqual(v.volumeBand.top);
  });

  it("fits every candle's true high and low, not just its close", () => {
    const [p] = C.layoutPanes(C.buildModel(spec()), 300);
    expect(p.hi).toBeGreaterThanOrEqual(113);
    expect(p.lo).toBeLessThanOrEqual(90);
    expect(p.yOf(113)).toBeGreaterThanOrEqual(p.top - 0.5);
  });

  it("keeps every level and band inside the drawn box (never clamps one to the edge)", () => {
    const [p] = C.layoutPanes(C.buildModel(spec([{ type: "level", value: 140 }, { type: "band", lo: 70, hi: 80 }])), 300);
    for (const v of [70, 140]) {
      expect(p.yOf(v)).toBeGreaterThanOrEqual(p.top - 0.5);
      expect(p.yOf(v)).toBeLessThanOrEqual(p.priceBottom + 0.5);
    }
    expect(p.yOf(70)).toBeGreaterThan(p.yOf(140));
    // fit: false keeps a far level off the scale (a deep wing strike must not squash spot through the day).
    const [q] = C.layoutPanes(C.buildModel(spec([{ type: "level", value: 400, fit: false }])), 300);
    expect(q.hi).toBeLessThan(400);
  });

  it("stacks panes by weight with their own domains", () => {
    const m = C.buildModel({ panes: [{ id: "a", weight: 2 }, { id: "b", weight: 1 }], series: [{ type: "line", pane: "a", data: [{ t: 1, v: 26000 }, { t: 2, v: 26100 }] }, { type: "area", pane: "b", signed: true, data: [{ t: 1, v: -500 }, { t: 2, v: 900 }] }] });
    const [a, b] = C.layoutPanes(m, 300);
    expect(a.bottom - a.top).toBeCloseTo(2 * (b.bottom - b.top));
    expect(b.top - a.bottom).toBe(C.LC_PAD.gap);
    expect(a.lo).toBeGreaterThan(25_000);
    expect(b.lo).toBeLessThan(-500);
    expect(b.hi).toBeGreaterThan(900);
  });

  it("drops panes nothing is drawn in, and adds one a series names", () => {
    const m = C.buildModel({ panes: [{ id: "a" }, { id: "empty" }], series: [{ type: "line", pane: "a", data: [{ t: 1, v: 1 }] }, { type: "line", pane: "x", data: [{ t: 1, v: 2 }] }] });
    expect(m.panes.map((p) => p.id)).toEqual(["a", "x"]);
  });

  it("centres each bar in its slot so the first and last are not clipped", () => {
    const X = C.layoutX(C.buildModel(spec()), 400, 50);
    expect(X.xOf(0)).toBeCloseTo(X.left + X.slot / 2);
    expect(X.xOf(79)).toBeCloseTo(X.right - X.slot / 2);
    expect(X.indexAt(X.xOf(41))).toBe(41);
    expect(X.indexAt(-50)).toBe(0);
    expect(X.indexAt(1e6)).toBe(79);
  });

  it("merges candles rather than dropping them when the chart is narrow", () => {
    const m = C.buildModel(spec());
    const X = C.layoutX(m, 120, 40);
    const { bars, step } = C.groupBars(m.series[0].pts, 0, 79, Math.floor((X.right - X.left) / C.MIN_SLOT));
    expect(step).toBeGreaterThan(1);
    expect(X.slot * step).toBeGreaterThanOrEqual(C.MIN_SLOT - 1e-9);
    expect(Math.max(...bars.map((b) => b.high))).toBe(113);
    expect(Math.min(...bars.map((b) => b.low))).toBe(90);
  });

  it("returns null when there is not enough room to draw honestly", () => {
    expect(C.layoutX(C.buildModel(spec()), 60, 40)).toBeNull();
    expect(C.layoutX(C.buildModel({ series: [] }), 400, 40)).toBeNull();
  });

  it("sizes the gutter for the widest tick or capsule", () => {
    expect(C.gutterFor(["26000"], [])).toBeLessThan(C.gutterFor(["26000"], ["Strike 26000"]));
    expect(C.gutterFor([], [])).toBe(36);
  });

  it("reads a series' point at an index (tooltips)", () => {
    const m = C.buildModel({ series: [{ type: "line", data: [{ t: 1, v: 5 }, { t: 3, v: 7 }] }, { type: "line", data: [{ t: 2, v: 1 }] }] });
    expect(C.valueAt(m.series[0], 2).v).toBe(7);
    expect(C.valueAt(m.series[0], 1)).toBeNull();
  });
});

describe("time axis (timeAxisTicks.ts rules, IST)", () => {
  const plan = (times, width = 600, kind) => {
    const m = { times };
    const X = { left: 8, right: width - 50, xOf: (i) => 8 + (i + 0.5) * ((width - 58) / times.length) };
    return C.planTimeTicks({ times: m.times, xOf: X.xOf, left: X.left, right: X.right, kind });
  };
  const noOverlap = (ticks) => {
    const s = [...ticks].sort((a, b) => a.textX - b.textX);
    for (let i = 1; i < s.length; i++) expect(s[i].textX - s[i].width / 2).toBeGreaterThanOrEqual(s[i - 1].textX + s[i - 1].width / 2 + 12 - 1e-6);
  };

  it("reads calendar fields in IST, whatever the machine's zone", () => {
    expect(C.istFields(Date.UTC(2026, 9, 30, 3, 45))).toMatchObject({ year: 2026, month: 10, day: 30, minute: 9 * 60 + 15 });
    expect(C.istFields(Date.UTC(2026, 11, 31, 20, 0))).toMatchObject({ year: 2027, month: 1, day: 1, minute: 90 });
    expect(C.istFields(NaN)).toBeNull();
  });

  it("knows a bar's granularity from the spacing", () => {
    expect(C.axisKind([0, 5 * 60_000, 10 * 60_000])).toBe("intraday");
    expect(C.axisKind([0, DAY, 2 * DAY, 5 * DAY])).toBe("daily");
    expect(C.axisKind([0, 7 * DAY, 14 * DAY])).toBe("weekly");
    expect(C.axisKind([0, 30 * DAY, 61 * DAY])).toBe("monthly");
  });

  it("spells the crosshair stamp per granularity", () => {
    const t = ist(2026, 9, 29, 10, 15);
    expect(C.formatStamp(t, "intraday")).toBe("Tue 29 Sep 2026 10:15");
    expect(C.formatStamp(t, "daily")).toBe("Tue 29 Sep 2026");
    expect(C.formatStamp(t, "monthly")).toBe("Sep 2026");
  });

  it("daily bars: months on real month starts, the year where it turns, no overlaps", () => {
    const times = [];
    for (let d = ist(2025, 10, 1); times.length < 160; d += DAY) {
      const wd = C.istFields(d).weekday;
      if (wd !== 0 && wd !== 6) times.push(d);
    }
    const ticks = plan(times, 700, "daily");
    expect(ticks.length).toBeGreaterThan(3);
    noOverlap(ticks);
    expect(ticks.some((t) => t.text === "2026" && t.level === 4)).toBe(true);
    for (const t of ticks.filter((x) => x.level === 3)) {
      const f = C.istFields(times[t.index]);
      const p = C.istFields(times[t.index - 1]);
      expect(f.month).not.toBe(p.month);
      expect(t.text).toBe(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][f.month - 1]);
    }
  });

  it("an intraday session: its date first, then times on round boundaries", () => {
    const times = Array.from({ length: 75 }, (_, k) => ist(2026, 10, 30, 9, 15) + k * 5 * 60_000);
    const ticks = plan(times, 700, "intraday");
    expect(ticks[0]).toMatchObject({ index: 0, text: "30 Oct", level: 2 });
    const rest = ticks.slice(1);
    expect(rest.length).toBeGreaterThan(2);
    for (const t of rest) {
      expect(t.level).toBe(1);
      expect(Number(t.text.slice(3)) % 30).toBe(0);
    }
    noOverlap(ticks);
  });

  it("two sessions: the second session is labelled by its date", () => {
    const day = (d) => Array.from({ length: 75 }, (_, k) => ist(2026, 10, d, 9, 15) + k * 5 * 60_000);
    const times = [...day(29), ...day(30)];
    const ticks = plan(times, 900, "intraday");
    expect(ticks.find((t) => t.index === 75)).toMatchObject({ text: "30 Oct", level: 2 });
  });

  it("slides a label inward instead of cutting it at the edge, and drops what does not fit", () => {
    const times = Array.from({ length: 3 }, (_, k) => ist(2026, 10, 28 + k));
    const ticks = plan(times, 100, "daily");
    for (const t of ticks) {
      expect(t.textX - t.width / 2).toBeGreaterThanOrEqual(8);
      expect(t.textX + t.width / 2).toBeLessThanOrEqual(50);
    }
    expect(plan([], 600)).toEqual([]);
  });
});
