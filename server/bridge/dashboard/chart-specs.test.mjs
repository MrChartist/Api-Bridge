// Every chart slot's data mapping (chart-specs.js): from the Bridge's own answers to a chart-lite spec, and an honest
// empty state where there is nothing to draw. The specs are also run through the engine's model (chart-lite-core.js).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildModel } from "./chart-lite-core.js";
import * as S from "./chart-specs.js";

const IST = 330 * 60_000;
const ist = (y, mo, d, hh = 0, mm = 0) => Date.UTC(y, mo - 1, d, hh, mm) - IST;
const sec = (ms) => Math.floor(ms / 1000);
const MINUS = "−";
const candle = (t, c, v = 100) => ({ t, open: c - 1, high: c + 2, low: c - 2, close: c, volume: v });
const byId = (spec, id) => spec.series.find((s) => s.id === id);

describe("shared helpers", () => {
  it("names the spot symbol on its exchange", () => {
    expect(S.spotSymbol("NIFTY")).toBe("NSE:NIFTY");
    expect(S.spotSymbol("SENSEX")).toBe("BSE:SENSEX");
    expect(S.spotSymbol("RELIANCE")).toBe("NSE:RELIANCE");
  });
  it("reads an IST calendar day at IST midnight", () => {
    expect(S.istDayMs("2026-10-30")).toBe(ist(2026, 10, 30));
    expect(S.istDayMs("30 Oct")).toBeNull();
  });
  it("turns /v1/history candles (epoch seconds) into sorted chart candles, dropping broken ones", () => {
    const answer = { data: { candles: [{ time: sec(ist(2026, 10, 30, 9, 20)), open: 2, high: 3, low: 1, close: 2.5, volume: 7 }, { time: sec(ist(2026, 10, 30, 9, 15)), open: 1, high: 2, low: 0.5, close: 1.5 }, { time: 1, open: null, high: 1, low: 1, close: 1 }] } };
    const out = S.candlesOf(answer);
    expect(out.map((c) => c.t)).toEqual([ist(2026, 10, 30, 9, 15), ist(2026, 10, 30, 9, 20)]);
    expect(out[0].volume).toBe(0);
    expect(S.candlesOf({ candles: [] })).toEqual([]);
    expect(S.candlesOf(null)).toEqual([]);
  });
  it("keeps only the latest IST session", () => {
    const list = [candle(ist(2026, 10, 29, 15, 25), 1), candle(ist(2026, 10, 30, 9, 15), 2), candle(ist(2026, 10, 30, 9, 20), 3)];
    expect(S.lastSession(list).map((c) => c.close)).toEqual([2, 3]);
    expect(S.lastSession([])).toEqual([]);
  });
  it("prints prices through format.js with the true minus", () => {
    expect(S.priceText(26012.4)).toBe("26012");
    expect(S.priceText(-12.5)).toBe(`${MINUS}12.50`);
    expect(S.priceText(null)).toBe("–");
  });
});

describe("chain sheet: the contract's candles", () => {
  it("draws 5-minute candles with volume", () => {
    const spec = S.contractSpec({ name: "NIFTY 26000 CE", candles: [candle(1, 100), candle(2, 101)] });
    expect(byId(spec, "c")).toMatchObject({ type: "candles", volume: true });
    expect(buildModel(spec).hasData).toBe(true);
  });
  it("says so when the contract has no candles", () => {
    expect(S.contractSpec({ name: "X", candles: [] }).empty.title).toMatch(/No candles/);
  });
});

describe("strategy: candles, strikes, breakevens and ±σ", () => {
  const spec = S.strategySpec({ underlying: "NIFTY", candles: [candle(1, 26000), candle(2, 26050)], strikes: [26200, 25800, 26200, null], breakevens: [25650.4, 26349.6], band1: [25700, 26300], band2: [25400, 26600] });
  it("one level per distinct strike, in order, and one per breakeven", () => {
    expect(spec.series.filter((s) => s.id.startsWith("k")).map((s) => [s.value, s.label])).toEqual([[25800, "Strike 25800"], [26200, "Strike 26200"]]);
    expect(spec.series.filter((s) => s.id.startsWith("be")).map((s) => s.label)).toEqual(["BE 25650", "BE 26350"]);
  });
  it("draws the bands faint (2σ) under strong (1σ), and says what they are", () => {
    expect(byId(spec, "b2")).toMatchObject({ type: "band", lo: 25400, hi: 26600, strength: 2 });
    expect(byId(spec, "b1")).toMatchObject({ type: "band", lo: 25700, hi: 26300 });
    expect(spec.series.indexOf(byId(spec, "b2"))).toBeLessThan(spec.series.indexOf(byId(spec, "b1")));
    expect(spec.note).toMatch(/expected move/);
  });
  it("fits every level and band in the price pane", () => {
    const m = buildModel(spec);
    expect(m.panes.map((p) => p.id)).toEqual(["price"]);
    expect(m.series.length).toBe(spec.series.length);
  });
  it("without bands there is no note, and without candles an empty state", () => {
    expect(S.strategySpec({ underlying: "NIFTY", candles: [candle(1, 1)] }).note).toBe("");
    expect(S.strategySpec({ underlying: "NIFTY", candles: [] }).empty.title).toMatch(/No price history/);
  });
});

describe("positions: spot, strikes, exits and the book's P&L", () => {
  const t = (m) => ist(2026, 10, 30, 9, 15 + m);
  it("marks every open leg at its last close (carried forward), only once all legs have a price", () => {
    const legs = [
      { qty: 75, avg: 100, candles: [{ t: t(0), close: 110 }, { t: t(10), close: 90 }] },
      { qty: -75, avg: 50, candles: [{ t: t(5), close: 40 }] },
    ];
    // t(0): leg 2 has no price yet: skipped. t(5): 75·10 − 75·(−10) = 1500. t(10): 75·(−10) + 750 = 0.
    expect(S.bookPnlSeries(legs)).toEqual([{ t: t(5), v: 1500 }, { t: t(10), v: 0 }]);
  });
  it("draws no P&L when a leg has no candles (no partial book)", () => {
    expect(S.bookPnlSeries([{ qty: 1, avg: 1, candles: [{ t: 1, close: 2 }] }, { qty: 1, avg: 1, candles: [] }])).toEqual([]);
    expect(S.bookPnlSeries([])).toEqual([]);
  });
  it("spot as a line, strikes off the scale, exits on the index as stop and target levels, P&L in its own pane", () => {
    const spec = S.positionsSpec({
      underlying: "NIFTY",
      spot: [candle(t(0), 26000), candle(t(5), 26010)],
      legs: [{ qty: 75, avg: 100, candles: [{ t: t(0), close: 104 }] }],
      strikes: [26500, 26500],
      exits: [{ role: "stop", trigger: 25900 }, { role: "target", trigger: 26200 }, { role: "stop", trigger: null }],
    });
    expect(byId(spec, "spot").data.map((p) => p.v)).toEqual([26000, 26010]);
    expect(byId(spec, "k26500")).toMatchObject({ type: "level", fit: false });
    expect(spec.series.filter((s) => s.id.startsWith("x")).map((s) => [s.label, s.tone])).toEqual([["Stop 25900", "neg"], ["Target 26200", "pos"]]);
    expect(byId(spec, "pnl")).toMatchObject({ type: "area", pane: "pnl", signed: true });
    expect(byId(spec, "pnl").data).toEqual([{ t: t(0), v: 300 }]);
    expect(spec.panes.find((p) => p.id === "pnl").format(-1200)).toBe(`${MINUS}₹1200`);
    expect(spec.note).toMatch(/charges not included/);
  });
  it("without leg prices: spot only, and the reason as the note", () => {
    const spec = S.positionsSpec({ underlying: "NIFTY", spot: [candle(1, 1)], legs: [{ qty: 1, avg: 1, candles: [] }], pnlNote: "why" });
    expect(byId(spec, "pnl")).toBeUndefined();
    expect(spec.panes.map((p) => p.id)).toEqual(["price"]);
    expect(spec.note).toBe("why");
    expect(S.positionsSpec({ underlying: "NIFTY", spot: [] }).empty.title).toMatch(/No intraday prices/);
  });
});

describe("OI: spot, max pain, call and put OI, PCR", () => {
  const pts = [
    { t: ist(2026, 10, 30, 9, 15), spot: 26000, ceOi: 1000, peOi: 1200, pcr: 1.2, maxPain: 26000 },
    { t: ist(2026, 10, 30, 9, 16), spot: 26010, ceOi: 1100, peOi: 1150, pcr: null, maxPain: 26050 },
  ];
  it("three panes, PCR with its 1.0 reference, gaps kept as gaps", () => {
    const spec = S.oiSpec(pts, { underlying: "NIFTY" });
    expect(spec.panes.map((p) => p.id)).toEqual(["price", "oi", "pcr"]);
    expect(byId(spec, "ce").data.map((p) => p.v)).toEqual([1000, 1100]);
    expect(byId(spec, "pe").tone).toBe("put");
    expect(byId(spec, "pcr").data[1].v).toBeNull();
    expect(byId(spec, "pcr1")).toMatchObject({ type: "level", value: 1 });
    expect(spec.kind).toBe("intraday");
    expect(buildModel(spec).panes.length).toBe(3);
  });
  it("needs two snapshots", () => {
    expect(S.oiSpec(pts.slice(0, 1)).empty.text).toMatch(/recorder/);
    expect(S.oiSpec(null).empty).toBeTruthy();
  });
});

describe("volatility: ATM IV against HV20", () => {
  const answer = { available: true, items: [{ date: "2026-10-28", iv: 12.1, hv20: 10.4 }, { date: "2026-10-29", iv: 12.6, hv20: 10.5, roll: true }, { date: "2026-10-30", iv: null, hv20: 10.7 }] };
  it("two lines by IST day, a dotted rule where the front expiry rolled", () => {
    const spec = S.volSpec(answer, { underlying: "NIFTY" });
    expect(byId(spec, "iv").data).toEqual([{ t: ist(2026, 10, 28), v: 12.1 }, { t: ist(2026, 10, 29), v: 12.6 }, { t: ist(2026, 10, 30), v: null }]);
    expect(byId(spec, "hv20")).toMatchObject({ tone: "hv", dash: true });
    expect(spec.series.filter((s) => s.type === "marker").map((s) => s.t)).toEqual([ist(2026, 10, 29)]);
    expect(byId(spec, "iv").format(12.34)).toBe("12.3%");
  });
  it("says why when the store has nothing", () => {
    expect(S.volSpec({ available: false, reason: "NOT_TRACKED" }, { underlying: "ACC" }).empty.text).toMatch(/does not track ACC/);
    expect(S.volSpec({ available: false, reason: "COLLECTING" }).empty.text).toMatch(/collecting/);
    expect(S.volSpec({ available: true, items: [{ date: "2026-10-30", iv: 12, hv20: null }] }).empty).toBeTruthy();
  });
});

describe("participants: FII long % and the nets", () => {
  const model = {
    dates: ["2026-10-29", "2026-10-30"],
    from: "2026-10-29",
    to: "2026-10-30",
    series: [
      { key: "fiiLongPct", points: [{ date: "2026-10-29", value: 31.1 }, { date: "2026-10-30", value: 33 }] },
      { key: "fiiNet", points: [{ date: "2026-10-29", value: -137000 }] },
      { key: "clientCallNet", points: [] },
      { key: "clientPutNet", points: [{ date: "2026-10-30", value: 5000 }] },
    ],
    revisions: [{ date: "2026-10-30", text: "Contract size changed" }],
  };
  it("long % with 50 % in view, the three nets with zero, a marker per revision", () => {
    const spec = S.participantsSpec(model);
    expect(spec.panes.map((p) => [p.id, p.include])).toEqual([["pct", [50]], ["net", [0]]]);
    expect(byId(spec, "fiiLongPct").data).toEqual([{ t: ist(2026, 10, 29), v: 31.1 }, { t: ist(2026, 10, 30), v: 33 }]);
    expect(byId(spec, "fiiNet").format(-137000)).toBe(`${MINUS}1.37L`);
    expect(spec.series.filter((s) => s.type === "marker")).toHaveLength(1);
    expect(buildModel(spec).series.find((s) => s.id === "clientCallNet")).toBeUndefined();
  });
  it("no days, no chart", () => {
    expect(S.participantsSpec({ dates: [] }).empty.title).toBe("No history yet");
  });
});

describe("screener: price and IV", () => {
  const candles = [candle(ist(2026, 10, 29), 100), candle(ist(2026, 10, 30), 101)];
  it("candles over a 30-day ATM IV pane", () => {
    const spec = S.screenerSpec({ underlying: "RELIANCE", candles, ivHistory: { available: true, items: [{ date: "2026-10-29", iv: 22 }, { date: "2026-10-30", iv: 23 }] } });
    expect(spec.panes.map((p) => p.id)).toEqual(["price", "iv"]);
    expect(byId(spec, "iv").data.map((p) => p.v)).toEqual([22, 23]);
    expect(spec.note).toBe("");
  });
  it("candles alone, and says so, when the store has no IV", () => {
    const spec = S.screenerSpec({ underlying: "RELIANCE", candles, ivHistory: { available: false, reason: "NOT_TRACKED" } });
    expect(spec.panes.map((p) => p.id)).toEqual(["price"]);
    expect(spec.note).toMatch(/No IV history/);
    expect(S.screenerSpec({ underlying: "X", candles: [] }).empty).toBeTruthy();
  });
});

describe("arbitrage: implied forward and box rate", () => {
  const snap = (t, spot, adj = 0) => ({ t, spot, k: [25900, 26000, 26100, 26200], cl: [160 + adj, 100 + adj, 55 + adj, 25 + adj], pl: [50, 85, 140, 210] });
  it("forward by parity over the strikes nearest spot; box of the strikes either side, annualised", () => {
    const p = S.parityPoint(snap(1, 26010), 30);
    // K + C − P: 26010, 26015, 26015, 26015 → median 26015.
    expect(p.forward).toBe(26015);
    // Box 26000 / 26100: (100 − 85) − (55 − 140) = 100 for a 100-point spread → 0 % a year.
    expect(p.rate).toBe(0);
    // A box bought at 99 for 100 over 30 days: (100 / 99 − 1) × 365 / 30 ≈ 12.29 %.
    expect(S.parityPoint({ ...snap(1, 26010), pl: [50, 86, 140, 210] }, 30).rate).toBeCloseTo(12.29, 1);
  });
  it("no rate on expiry day, without the days, or without a strike above spot; null without two priced strikes", () => {
    expect(S.parityPoint(snap(1, 26010), 0.2).rate).toBeNull();
    expect(S.parityPoint(snap(1, 26010), null).rate).toBeNull();
    expect(S.parityPoint(snap(1, 30000), 30).rate).toBeNull();
    expect(S.parityPoint({ t: 1, spot: 100, k: [100], cl: [1], pl: [1] }, 30)).toBeNull();
    expect(S.parityPoint({ t: 1, spot: null, k: [], cl: [], pl: [] }, 30)).toBeNull();
  });
  it("two panes and the hurdle as a level; days come from the page; an honest empty state without recorder minutes", () => {
    const t0 = ist(2026, 10, 30, 9, 15);
    const seen = [];
    const spec = S.arbSpec([snap(t0 + 60_000, 26012), snap(t0, 26010)], { underlying: "NIFTY", hurdle: 6.5, daysAt: (t) => (seen.push(t), 4) });
    expect(seen.sort()).toEqual([t0, t0 + 60_000]);
    expect(spec.panes.map((p) => p.id)).toEqual(["fwd", "rate"]);
    expect(byId(spec, "fwd").data.map((p) => p.t)).toEqual([t0, t0 + 60_000]);
    expect(byId(spec, "hurdle")).toMatchObject({ value: 6.5, label: "Hurdle 6.5%" });
    expect(S.arbSpec([], { underlying: "NIFTY" }).empty.text).toMatch(/recorder/);
  });
});

describe("indicators: studies from the ChartistScript core", () => {
  const days = [28, 29, 30].map((d) => ist(2026, 10, d));
  const spec = S.strategySpec({ underlying: "NIFTY", candles: days.map((t, k) => candle(t, 26000 + k)) });
  // The core's times are its own candles' (IST midnight here, but matched by IST day whatever the hour).
  const result = {
    time: days.map((t) => sec(t) + 3600),
    partial: false,
    studies: [{ key: "bb0" }, { key: "macd1" }],
    series: [
      { key: "bb0.upper", study: "bb0", field: "upper", label: "bb(20, 2) upper", pane: "price", style: "line", values: [26100, 26110, 26120] },
      { key: "bb0.lower", study: "bb0", field: "lower", label: "bb(20, 2) lower", pane: "price", style: "line", values: [25900, null, 25920] },
      { key: "macd1.macd", study: "macd1", field: "macd", label: "macd(12, 26, 9) macd", pane: "panel", style: "line", values: [1, 2, 3] },
      { key: "macd1.hist", study: "macd1", field: "hist", label: "macd(12, 26, 9) hist", pane: "panel", style: "hist", values: [-1, 0.5, 2], level: 0 },
      { key: "x.bg", study: "x", field: "bg", label: "bg", pane: "price", style: "background", values: [1, 1, 1] },
    ],
    fills: [{ key: "bbfill", between: ["bb0.upper", "bb0.lower"] }],
    markers: [{ key: "m1", time: sec(days[1]), price: 1, position: "below", text: "Hammer", bias: "bullish" }, { key: "m2", time: sec(ist(2026, 9, 1)), text: "off chart" }],
  };
  const out = S.withStudies(spec, result);
  it("overlays price studies on the candles' pane and gives each panel study its own pane", () => {
    expect(out.panes.map((p) => [p.id, p.label ?? null, p.weight])).toEqual([["price", null, 2], ["study:macd1", "macd(12, 26, 9)", 0.75]]);
    expect(byId(out, "st:bb0.upper")).toMatchObject({ type: "line", pane: "price" });
    expect(byId(out, "st:bb0.upper").data.map((p) => p.t)).toEqual(days);
    expect(byId(out, "st:bb0.lower").data[1].v).toBeNull();
  });
  it("hist becomes signed bars, a level a reference line; background outputs are not drawn", () => {
    expect(byId(out, "st:macd1.hist")).toMatchObject({ type: "bars", signed: true, pane: "study:macd1" });
    expect(byId(out, "st:macd1.hist:level")).toMatchObject({ type: "level", value: 0 });
    expect(out.series.some((x) => x.id === "st:x.bg")).toBe(false);
  });
  it("tones come from the data-viz set, in order per study", () => {
    expect(["st:bb0.upper", "st:bb0.lower", "st:macd1.macd"].map((id) => byId(out, id).tone)).toEqual(["call", "put", "put"]);
    for (const x of out.series.filter((x) => x.id.startsWith("st:") && x.tone)) expect([...S.STUDY_TONES, "muted", "pos", "neg", "iv"]).toContain(x.tone);
  });
  it("a fill is a band between its two series, drawn first; markers on their candle, others dropped", () => {
    expect(out.series.findIndex((x) => x.type === "band")).toBeLessThan(out.series.findIndex((x) => x.id === "st:bb0.upper"));
    const band = out.series.find((x) => x.type === "band");
    expect(band.data[0]).toEqual({ t: days[0], lo: 25900, hi: 26100 });
    expect(Number.isNaN(band.data[1].lo)).toBe(true);
    expect(out.series.filter((x) => x.type === "marker")).toEqual([expect.objectContaining({ t: days[1], label: "Hammer", tone: "pos" })]);
    expect(buildModel(out).panes.length).toBe(2);
  });
  it("leaves a spec without candles, or an empty answer, as it was; says when warm-up was short", () => {
    expect(S.withStudies({ series: [{ type: "line", data: [] }] }, result).series).toHaveLength(1);
    expect(S.withStudies(spec, { time: [] })).toBe(spec);
    expect(S.withStudies(spec, { ...result, partial: true }).note).toMatch(/warm/);
  });
  it("remembers at most four known ids, and asks for daily candles of the chart's length", () => {
    expect(S.studyList('["rsi","macd","rsi","bad id!","bb","ema","sma"]')).toEqual(["rsi", "macd", "bb", "ema"]);
    expect(S.studyList("not json")).toEqual([]);
    expect(S.studyList(null)).toEqual([]);
    expect(S.studyRequest({ symbol: "NSE:NIFTY", bars: 120, ids: ["rsi"] })).toEqual({ symbol: "NSE:NIFTY", interval: "1d", countback: 120, studies: [{ id: "rsi" }] });
  });
  it("the chain sheet says when it shows daily candles for indicators", () => {
    expect(S.contractSpec({ name: "X", candles: [candle(1, 1)], daily: true })).toMatchObject({ label: "X: daily candles" });
    expect(S.contractSpec({ name: "X", candles: [candle(1, 1)], daily: true }).note).toMatch(/indicators/);
  });
  it("reads no studies until one is on: the catalogue loads on the picker's first open, compute only with ids", () => {
    const src = readFileSync(new URL("./chart-lite.js", import.meta.url), "utf8");
    expect(src).toMatch(/const loadCatalogue = \(\) => \(catalogue \?\?=/);
    expect(src).toMatch(/if \(!ids\.length \|\| !candles\?\.data\?\.length \|\| !symbol\) return spec;/);
  });
});

describe("house rules", () => {
  it("chart modules are served, format numbers only through format.js and set no inline styles", () => {
    for (const f of ["chart-lite.js", "chart-lite-core.js", "chart-specs.js"]) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/Intl\.NumberFormat|\.toLocaleString\(|toFixed\(|innerHTML|setAttribute\(\s*["']style|\.style\./);
      expect(src.match(/https?:\/\//g) ?? [], f).toEqual([]);
    }
  });
  it("the chart modal is wide on a desktop and the whole screen on a phone, its plot filling the room left", () => {
    const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");
    expect(css).toContain("dialog.sheet.lc-chart-sheet { height: 100dvh; max-height: 100dvh; border-radius: 0; }");
    expect(css).toMatch(/dialog\.sheet\.lc-chart-sheet \{ width: min\(1100px, 92vw\); max-width: none; height: 80vh;/);
    expect(css).toContain(".lc-expanded .lc-chart .lc-plot { flex: 1 1 0; height: auto; min-height: 220px; }");
    const js = readFileSync(new URL("./chart-lite.js", import.meta.url), "utf8");
    expect(js).toMatch(/export function openChartModal/);
    expect(js).toMatch(/expand: false, refreshMs: 0/);
  });
  it("every ported file carries its provenance", () => {
    for (const f of ["chart-lite.js", "chart-lite-core.js", "chart-lite-core.test.mjs"]) {
      expect(readFileSync(new URL(`./${f}`, import.meta.url), "utf8"), f).toMatch(/Ported from MrChartist\/scanner src\/components\/patterns\/lite-chart, <commit c2ac504>/);
    }
  });
});
