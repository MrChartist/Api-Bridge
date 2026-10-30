import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyticsPages, chainRows, compact, divergingLayout, freshnessLabel, greeksQuery, legsToBody, lineLayout, niceScale, payoffLayout, presetLegs, readNumber, sizeBody, surfaceSeries } from "./analyticsViews.js";

describe("freshness and numbers", () => {
  it("labels freshness with source, age and staleness", () => {
    expect(freshnessLabel({ source: "stream", ageMs: 2400, stale: false })).toEqual({ text: "Live stream · 2s old", tone: "ok" });
    expect(freshnessLabel({ source: "backup", provider: "nse", ageMs: 90_000, stale: true })).toEqual({ text: "Backup (nse) · 2 min old · stale", tone: "warn" });
    expect(freshnessLabel(undefined).text).toBe("Freshness unknown");
  });
  it("prints compact Indian figures and -- for missing", () => {
    expect(compact(12_500_000)).toBe("1.25 Cr");
    expect(compact(-450_000)).toBe("-4.5 L");
    expect(compact(12_300)).toBe("12.3k");
    expect(compact(800)).toBe("800");
    expect(compact(null)).toBe("--");
  });
  it("makes nice axes that contain the data", () => {
    const s = niceScale(3, 97, 5);
    expect(s.min).toBeLessThanOrEqual(3);
    expect(s.max).toBeGreaterThanOrEqual(97);
    expect(s.ticks[0]).toBe(s.min);
    expect(niceScale(5, 5).max).toBeGreaterThan(5);
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

describe("pages and CSP", () => {
  it("adds the Analytics group with unique ids, labels and shortcuts-free tab bar entries", () => {
    const pages = analyticsPages(() => ({}));
    expect(pages.map((p) => p.id)).toEqual(["chain", "oi", "gex", "skew", "payoff", "calculators"]);
    expect(new Set(pages.map((p) => p.group))).toEqual(new Set(["Analytics"]));
    for (const p of pages) expect(typeof p.render).toBe("function");
    expect(pages.some((p) => p.tab)).toBe(false);
  });
  it("uses no inline styles, external hosts or locale number formatting", () => {
    const src = readFileSync(new URL("./analyticsViews.js", import.meta.url), "utf8");
    expect(src).not.toMatch(/setAttribute\(\s*["']style|\bstyle:|innerHTML|outerHTML|insertAdjacentHTML/);
    // The only URL is the SVG namespace, which is an identifier, not a request.
    expect(src.match(/https?:\/\/[^"\s]+/g)).toEqual(["http://www.w3.org/2000/svg"]);
    expect(src).not.toMatch(/Intl\.NumberFormat|\.toLocaleString\(|toFixed\(/);
  });
});
