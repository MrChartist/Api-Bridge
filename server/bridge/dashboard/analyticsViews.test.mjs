import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyticsMorePages, barTimeLabel, countdownText, describeRule, dryRunText, flowItems, gridItems, legsToEditor, lotSplitBody, oiChangeItems, rollingRows, ruleBody, ruleState, rulerLayout, seriesLayout, streakText, windowNote } from "./analyticsMore.js";
import { analyticsPages, TAG_CHAR_W, chainRows, compact, divergingLayout, freshnessLabel, greeksQuery, legsToBody, lineLayout, niceScale, payoffLayout, presetLegs, readNumber, sizeBody, surfaceSeries, tickDecimals } from "./analyticsViews.js";

describe("freshness and numbers", () => {
  it("labels freshness with source, age and staleness", () => {
    expect(freshnessLabel({ source: "stream", ageMs: 2400, stale: false })).toEqual({ text: "Live stream · 2s old", tone: "ok" });
    expect(freshnessLabel({ source: "backup", provider: "nse", ageMs: 90_000, stale: true })).toEqual({ text: "Backup (nse) · 2 min old · stale", tone: "warn" });
    expect(freshnessLabel(undefined).text).toBe("Freshness unknown");
  });
  it("prints compact Indian figures and -- for missing", () => {
    expect(compact(12_500_000)).toBe("1.25 Cr");
    expect(compact(-450_000)).toBe("−4.5 L");
    expect(compact(12_300)).toBe("12.3 K");
    expect(compact(800)).toBe("800");
    expect(compact(null)).toBe("–");
  });
  it("makes nice axes that contain the data", () => {
    const s = niceScale(3, 97, 5);
    expect(s.min).toBeLessThanOrEqual(3);
    expect(s.max).toBeGreaterThanOrEqual(97);
    expect(s.ticks[0]).toBe(s.min);
    expect(niceScale(5, 5).max).toBeGreaterThan(5);
  });
  it("labels axis ticks with enough decimals that neighbours never read the same", () => {
    expect(tickDecimals(0.05, 1)).toBe(2);
    expect(tickDecimals(0.1, 1)).toBe(1);
    expect(tickDecimals(0.2, 0)).toBe(1);
    expect(tickDecimals(5, 1)).toBe(1);
    const L = seriesLayout([{ id: "ce", label: "CE IV", cls: "call", points: [21.11, 21.29, 21.13, 21.24].map((y, i) => ({ label: String(i), y })) }], { width: 600, height: 300, yDecimals: 1 });
    const labels = L.yTicks.map((t) => t.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
  it("places points that carry `at` by their time (the cone by days to expiry), not one step each", () => {
    const pts = [[0, "Now"], [3, "3 Nov"], [9, "9 Nov"], [24, "24 Nov"]].map(([at, label], i) => ({ label, at, y: 100 + i }));
    const L = seriesLayout([{ id: "u", label: "+1σ", cls: "s1", points: pts }], { width: 640, height: 300, padL: 50, padR: 14 });
    const xs = L.paths[0].dots.map((d) => d.x);
    // 3 days of 24 is an eighth of the plot, not a third
    expect(xs[1] - xs[0]).toBeCloseTo(((640 - 64) * 3) / 24, 0);
    expect(L.xTicks.map((t) => t.label)).toEqual(["Now", "3 Nov", "9 Nov", "24 Nov"]);
    // Without `at`, points stay evenly spaced
    const even = seriesLayout([{ id: "u", label: "x", cls: "s1", points: pts.map(({ label, y }) => ({ label, y })) }], { width: 640, height: 300, padL: 50, padR: 14 });
    expect(even.paths[0].dots[1].x - even.paths[0].dots[0].x).toBeCloseTo((640 - 64) / 3, 0);
  });
  it("reads numbers strictly", () => {
    expect(readNumber(" 12.5 ")).toBe(12.5);
    expect(readNumber("")).toBeNull();
    expect(readNumber("abc")).toBeNull();
  });
});

describe("bar layout", () => {
  const items = [
    { label: "24500", bars: [{ value: -300, cls: "put" }, { value: 100, cls: "call" }] },
    { label: "24400", band: "pain", bars: [{ value: -50, cls: "put" }, { value: 400, cls: "call" }] },
  ];
  it("puts the zero line between puts (left) and calls (right) and keeps every bar inside the plot", () => {
    const L = divergingLayout(items, { width: 400 });
    expect(L.height).toBeGreaterThan(L.bottom);
    for (const r of L.rows) {
      const [put, call] = r.bars;
      expect(put.x + put.w).toBeCloseTo(L.x0, 0);
      expect(call.x).toBeCloseTo(L.x0, 0);
      expect(put.x).toBeGreaterThanOrEqual(L.plotL - 1);
      expect(call.x + call.w).toBeLessThanOrEqual(L.plotR + 1);
    }
    expect(L.rows[0].bars[0].w).toBeGreaterThan(L.rows[1].bars[0].w);
  });
  it("reserves a tag column wide enough for the longest tag, so Max pain never touches a bar", () => {
    const rows = [{ label: "1", tag: "Max pain", band: "pain", bars: [{ value: 100, cls: "call" }] }, { label: "2", bars: [{ value: 90, cls: "call" }] }];
    for (const width of [240, 360, 900]) {
      const L = divergingLayout(rows, { width });
      expect(L.tagX - "Max pain".length * TAG_CHAR_W).toBeGreaterThanOrEqual(L.plotR);
      for (const r of L.rows) for (const b of r.bars) expect(b.x + b.w).toBeLessThanOrEqual(L.plotR + 1);
    }
  });
  it("scales the axis to the largest |value| with 10 % headroom, symmetric around zero", () => {
    const L = divergingLayout([{ label: "a", bars: [{ value: 12_000, cls: "call" }] }, { label: "b", bars: [{ value: -3_000, cls: "put" }] }], { width: 800 });
    const half = L.plotR - L.x0;
    expect(L.x0 - L.plotL).toBeCloseTo(half, 0); // zero in the middle
    expect(L.rows[0].bars[0].w / half).toBeGreaterThan(0.88); // the biggest bar reaches 1 / 1.1 of its side
    expect(L.rows[0].bars[0].w / half).toBeLessThan(0.93);
    for (const t of L.ticks) expect(Math.abs(t.value)).toBeLessThanOrEqual(13_200);
  });
  it("stacks grouped bars of one row without overlap", () => {
    const L = divergingLayout([{ label: "a", bars: [{ value: 5, cls: "s1" }, { value: 7, cls: "s2" }] }], { width: 400, rowH: 30, group: true });
    const [a, b] = L.rows[0].bars;
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.h);
  });
  it("works for tiny widths, empty and one-sided data", () => {
    expect(divergingLayout([], { width: 100 }).rows).toEqual([]);
    const one = divergingLayout([{ label: "1", bars: [{ value: 5, cls: "call" }] }], { width: 100 });
    expect(one.width).toBe(240);
    expect(one.x0).toBe(one.plotL);
  });
});

describe("line and payoff layout", () => {
  it("breaks a line at gaps and caps x labels on narrow screens", () => {
    const pts = Array.from({ length: 21 }, (_, i) => ({ x: 24000 + i * 50, y: i === 5 ? null : 12 + i * 0.1 }));
    const wide = lineLayout([{ id: "a", label: "A", cls: "call", points: pts }], { width: 800 });
    const narrow = lineLayout([{ id: "a", label: "A", cls: "call", points: pts }], { width: 280 });
    expect(wide.paths[0].d.match(/M/g)).toHaveLength(2);
    expect(narrow.xTicks.length).toBeLessThan(wide.xTicks.length);
    expect(lineLayout([{ id: "a", label: "A", cls: "x", points: [{ x: 1, y: null }] }]).empty).toBe(true);
  });
  it("clips the payoff area at zero and places break-evens", () => {
    const curve = [{ price: 90, pnl: -10 }, { price: 100, pnl: 0 }, { price: 110, pnl: 10 }];
    const L = payoffLayout(curve, { width: 400, breakevens: [100, 500], spot: 105 });
    expect(L.zeroY).toBeGreaterThan(L.padT);
    expect(L.zeroY).toBeLessThan(L.plotBottom);
    expect(L.breakevens).toHaveLength(1);
    expect(L.spot.value).toBe(105);
    expect(L.area.endsWith("Z")).toBe(true);
  });
  it("builds one surface series per expiry", () => {
    const s = surfaceSeries([{ expiry: "2026-11-05", points: [{ strike: 100, ceIv: 10, peIv: 12 }, { strike: 110, ceIv: null, peIv: 9 }] }]);
    expect(s[0].points).toEqual([{ x: 100, y: 11 }, { x: 110, y: 9 }]);
  });
});

describe("request building", () => {
  const leg = { type: "CE", side: "buy", strike: "24500", price: "120", lots: "2", lotSize: "75" };
  it("turns the leg editor into the payoff body", () => {
    expect(legsToBody([leg], "24480")).toEqual({ ok: true, body: { legs: [{ type: "CE", side: "buy", strike: 24500, price: 120, lots: 2, lotSize: 75 }], spot: 24480 } });
    expect(legsToBody([{ ...leg, type: "FUT", strike: "" }]).body.legs[0]).not.toHaveProperty("strike");
  });
  it("names every problem", () => {
    const r = legsToBody([{ ...leg, strike: "", price: "-1", lots: "1.5" }], "x");
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.field).sort()).toEqual(["lots", "price", "spot", "strike"]);
    expect(legsToBody([]).ok).toBe(false);
    expect(legsToBody(Array.from({ length: 13 }, () => leg)).ok).toBe(false);
  });
  it("builds greeks and position-size requests", () => {
    expect(greeksQuery({ spot: "24500", strike: "24500", type: "PE", days: "7", mode: "iv", iv: "14" })).toEqual({ ok: true, query: "spot=24500&strike=24500&type=PE&days=7&iv=14" });
    expect(greeksQuery({ spot: "24500", strike: "24500", type: "CE", days: "7", mode: "price", price: "" }).ok).toBe(false);
    expect(sizeBody({ capital: "500000", riskPct: "1", entry: "100", stop: "90", lotSize: "75", maxLots: "" })).toEqual({ ok: true, body: { capital: 500000, riskPct: 1, entry: 100, stop: 90, lotSize: 75 } });
    expect(sizeBody({ capital: "1", riskPct: "150", entry: "1", stop: "1" }).ok).toBe(false);
  });
  it("prices ready-made strategies from the chain", () => {
    const rows = [-4, -3, -2, -1, 0, 1, 2, 3, 4].map((o) => ({ strike: 24500 + o * 50, ce: { ltp: 100 - o }, pe: { ltp: 100 + o } }));
    const chain = { atmStrike: 24500, lotSize: 75, rows };
    const ic = presetLegs("iron-condor", chain).legs;
    expect(ic).toHaveLength(4);
    expect(ic[0]).toMatchObject({ type: "CE", side: "sell", strike: "24600", lotSize: "75" });
    expect(presetLegs("iron-condor", { ...chain, rows: rows.slice(3, 6) }).error).toMatch(/no CE price/);
    expect(presetLegs("nope", chain).error).toBeTruthy();
    expect(chainRows(chain).find((r) => r.atm).strike).toBe(24500);
  });
});

describe("more analytics: pure helpers", () => {
  it("lays out series and a ruler inside the width, with no label overlapping another in its lane", () => {
    const L = seriesLayout([{ id: "a", label: "A", cls: "s1", points: Array.from({ length: 30 }, (_, i) => ({ label: `d${i}`, y: i % 5 })) }], { width: 300, refs: [{ y: 2, label: "Avg" }] });
    expect(L.xTicks.length).toBeLessThan(6);
    expect(L.paths[0].d.startsWith("M")).toBe(true);
    expect(seriesLayout([{ id: "a", label: "A", cls: "s1", points: [] }]).empty).toBe(true);
    const R = rulerLayout([{ id: "a", label: "Spot", value: 100 }, { id: "b", label: "Max pain", value: 101 }, { id: "c", label: "Wall", value: 160 }], { width: 300, band: { from: 90, to: 120 } });
    const byLane = new Map();
    for (const i of R.items) {
      expect(i.left).toBeGreaterThanOrEqual(0);
      expect(i.left + i.text.length * TAG_CHAR_W).toBeLessThanOrEqual(300);
      byLane.set(i.lane, [...(byLane.get(i.lane) ?? []), i]);
    }
    for (const list of byLane.values()) for (let k = 1; k < list.length; k++) expect(list[k].left).toBeGreaterThanOrEqual(list[k - 1].left + list[k - 1].text.length * TAG_CHAR_W);
    expect(R.lanes).toBeGreaterThan(1);
    expect(rulerLayout([], {}).empty).toBe(true);
  });
  it("words flows, streaks, countdowns and windows", () => {
    expect(streakText({ direction: "selling", count: 3 })).toMatchObject({ value: "Net selling", sub: "3 sessions in a row" });
    expect(streakText({ direction: "flat", count: 0 }).value).toBe("Flat");
    expect(flowItems([{ date: "2026-10-30", fii: { buy: 10, sell: 4, net: 6 }, dii: { buy: 1, sell: 3, net: -2 } }])[0].bars.map((b) => b.value)).toEqual([6, -2]);
    expect(rollingRows([{ window: 5, days: 3, fiiNet: 1, diiNet: 2 }])[0]).toMatchObject({ label: "Last 5 sessions", partial: true });
    expect(countdownText(19.5)).toBe("19 h 30 min");
    expect(countdownText(0)).toBe("Expired");
    expect(countdownText(72)).toBe("3.0 days");
    expect(windowNote({ from: 0, to: 600_000, windowCovered: false, windowMs: 900_000 })).toMatch(/asked for 15 min/);
    expect(barTimeLabel(1_793_000_000, "day")).toMatch(/Oct|Nov/);
  });
  it("shapes OI change, greeks and strategy hand-off data", () => {
    const items = oiChangeItems([{ strike: 100, side: "CE", oiChange: 5 }, { strike: 100, side: "PE", oiChange: -3 }, { strike: 110, side: "CE", oiChange: 1 }]);
    expect(items.map((i) => i.label)).toEqual(["110", "100"]);
    expect(items[1].bars.map((b) => b.value)).toEqual([5, -3]);
    expect(gridItems([{ strike: 100, ce: { gamma: 0.1 }, pe: { gamma: null } }], "gamma")[0].bars.map((b) => b.value)).toEqual([0.1, 0]);
    expect(legsToEditor([{ type: "FUT", side: "buy", strike: null, price: 100, lots: 1, lotSize: 75 }, { type: "CE", side: "sell", strike: 24500, price: 80.5, lots: 2, lotSize: 75 }])).toEqual([
      { type: "FUT", side: "buy", strike: "", price: "100", lots: "1", lotSize: "75" },
      { type: "CE", side: "sell", strike: "24500", price: "80.5", lots: "2", lotSize: "75" },
    ]);
  });
  it("describes and validates alert rules in plain language", () => {
    expect(describeRule({ metric: "pcr_oi", underlying: "nifty", expiry: "2026-11-05", op: "above", value: 1.2 })).toBe("Tell me when NIFTY's PCR (OI) rises above 1.2 (expiry 2026-11-05).");
    expect(describeRule({ metric: "spot_cross", underlying: "NIFTY", op: "either", value: 24500 })).toBe("Tell me when NIFTY crosses 24500 in either direction.");
    expect(describeRule({ metric: "gex_regime", underlying: "NIFTY", expiry: "2026-11-05", to: "negative" })).toMatch(/changes to negative/);
    const ok = ruleBody({ name: "", underlying: "nifty", expiry: "2026-11-05", metric: "atm_iv", op: "below", value: "12", to: "", every: "15", marketHoursOnly: true });
    expect(ok).toEqual({ ok: true, body: { name: "NIFTY's ATM IV falls below 12% (expiry 2026-11-05)", underlying: "NIFTY", metric: "atm_iv", marketHoursOnly: true, enabled: true, expiry: "2026-11-05", value: 12, op: "below", everyMinutes: 15 } });
    expect(ruleBody({ underlying: "NIFTY", expiry: "", metric: "pcr_oi", op: "above", value: "", every: "0", marketHoursOnly: true }).errors).toHaveLength(3);
    expect(ruleBody({ underlying: "NIFTY", metric: "spot_cross", op: "either", value: "24500", every: "", marketHoursOnly: true }).body).not.toHaveProperty("expiry");
    expect(ruleBody({ underlying: "NIFTY", expiry: "2026-11-05", metric: "gex_regime", to: "negative", value: "9", marketHoursOnly: false }).body).toMatchObject({ to: "negative" });
    expect(ruleState({ enabled: true, lastCheck: { status: "ok", condition: false } }).tone).toBe("ok");
    expect(ruleState({ disabledReason: "key revoked" }).tone).toBe("bad");
    expect(dryRunText({ status: "baseline" })).toMatch(/starting reading/);
  });
  it("builds the lot-split body from lots", () => {
    expect(lotSplitBody({ symbol: " NFO:NIFTY-2026-11-24-FUT ", lots: "100", lotSize: "75", freezeQty: "", iceberg: true, sliceLots: "", delayMs: "250" })).toEqual({ ok: true, body: { symbol: "NFO:NIFTY-2026-11-24-FUT", quantity: 7500, lotSize: 75, iceberg: { delayMs: 250 } } });
    expect(lotSplitBody({ symbol: "", lots: "1", lotSize: "1" }).ok).toBe(false);
    expect(lotSplitBody({ symbol: "X", lots: "1.5", lotSize: "1" }).ok).toBe(false);
  });
});

describe("pages and CSP", () => {
  it("adds the remaining pages to the same group, after the first six", () => {
    const more = analyticsMorePages(() => ({}));
    expect(more.map((p) => p.id)).toEqual(["futures", "flows", "expiry", "oichange", "strategies", "greeksgrid", "alerts", "positions"]);
    expect(new Set(more.map((p) => p.group))).toEqual(new Set(["Analytics"]));
    const ids = [...analyticsPages(() => ({})), ...more].map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(more.some((p) => p.tab)).toBe(false);
  });
  it("serves analyticsMore.js from the dashboard allowlist", () => {
    expect(readFileSync(new URL("../core/app.mjs", import.meta.url), "utf8")).toMatch(/"analyticsMore\.js": "text\/javascript/);
  });
  it("adds the Analytics group with unique ids, labels and shortcuts-free tab bar entries", () => {
    const pages = analyticsPages(() => ({}));
    expect(pages.map((p) => p.id)).toEqual(["chain", "oi", "gex", "skew", "payoff", "calculators"]);
    expect(new Set(pages.map((p) => p.group))).toEqual(new Set(["Analytics"]));
    for (const p of pages) expect(typeof p.render).toBe("function");
    expect(pages.some((p) => p.tab)).toBe(false);
  });
  it.each(["./analyticsViews.js", "./analyticsMore.js"])("%s uses no inline styles, external hosts or locale number formatting", (file) => {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(src).not.toMatch(/setAttribute\(\s*["']style|\bstyle:|innerHTML|outerHTML|insertAdjacentHTML/);
    // The only URL is the SVG namespace, which is an identifier, not a request.
    expect(src.match(/https?:\/\/[^"\s]+/g) ?? []).toEqual(file.endsWith("Views.js") ? ["http://www.w3.org/2000/svg"] : []);
    expect(src).not.toMatch(/Intl\.NumberFormat|\.toLocaleString\(|toFixed\(/);
  });
});
