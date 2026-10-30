// Live events page: pure view-model helpers (events.js).
import { describe, expect, it } from "vitest";
import { applyPreset, csvOf, groupByStock, matches, percentile, rowModel, stockRowModel } from "./events.js";

const ev = (o = {}) => ({ id: "e1", ts: 1, time: "2026-10-30T10:42:07+05:30", symbol: "NSE:BODALCHEM", name: "Bodal Chemicals", asset: "stock", kind: "only_buyers", label: "Only buyers", side: "bull", ltp: 164.52, changePct: 5, strength: 5, context: "upper circuit 5 %", count: 1, first: true, tags: { fno: false }, ...o });

describe("events page helpers", () => {
  it("filters by asset, side, kind, search and minimum price", () => {
    expect(matches(ev(), { asset: "stock", side: "all" })).toBe(true);
    expect(matches(ev(), { asset: "option" })).toBe(false);
    expect(matches(ev(), { side: "bear" })).toBe(false);
    expect(matches(ev(), { kind: "day_high" })).toBe(false);
    expect(matches(ev(), { q: "bodal" })).toBe(true);
    expect(matches(ev(), { q: "nifty" })).toBe(false);
    expect(matches(ev(), { minPrice: 200 })).toBe(false);
  });
  it("row model uses format.js: true minus, no em dash, counts", () => {
    const m = rowModel(ev({ changePct: -4.98, count: 3 }));
    expect(m.chg).toBe("−4.98%");
    expect(m.count).toBe("×3");
    expect(m.ltp).toBe("164.52");
    expect(rowModel(ev({ ltp: null })).ltp).not.toContain("—");
  });
  it("groups by stock with bull and bear counts, newest first", () => {
    const g = groupByStock([ev({ id: "a", ts: 1 }), ev({ id: "b", ts: 3, side: "bear", label: "Only sellers" }), ev({ id: "c", ts: 2, symbol: "NSE:X" })]);
    expect(g.map((x) => x.symbol)).toEqual(["NSE:BODALCHEM", "NSE:X"]);
    expect(g[0]).toMatchObject({ n: 2, bull: 1, bear: 1 });
    expect(stockRowModel(g[0]).kinds).toHaveLength(2);
  });
  it("CSV quotes commas and keeps one line per event", () => {
    const csv = csvOf([ev({ context: "a, b" })]);
    expect(csv.split("\n")).toHaveLength(3);
    expect(csv).toContain('"a, b"');
  });
  it("percentile and presets", () => {
    expect(percentile([1, 2, 3, 4, 100], 95)).toBe(100);
    expect(percentile([], 95)).toBeNull();
    const cat = { kinds: [{ kind: "a", asset: "stock" }, { kind: "b", asset: "stock" }, { kind: "c", asset: "option" }] };
    const next = applyPreset({ kinds: { a: { on: true }, b: { on: true }, c: { on: true } } }, { asset: "stock", kinds: ["b"] }, cat);
    expect([next.kinds.a.on, next.kinds.b.on, next.kinds.c.on]).toEqual([false, true, true]);
  });
});
