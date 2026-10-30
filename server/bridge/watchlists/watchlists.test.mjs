import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNullLogger } from "../core/logger.mjs";
import { createWatchlistService } from "./watchlistService.mjs";
import { ROUTES } from "./module.mjs";
import { nearFuture, normaliseSymbol, oiChange, sortRows, watchRow } from "../dashboard/watchlist-core.js";

const NOW = Date.parse("2026-10-30T11:00:00+05:30");

function rig({ demo = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mcb-watch-"));
  const clock = { t: NOW, now() { return this.t; } };
  const calls = { quotes: 0, expiries: 0, vol: 0 };
  const oi = { v: 1_000_000 };
  const deps = {
    paths: { dataDir: dir },
    clock,
    logger: createNullLogger(),
    config: { demo },
    marketData: {
      expiries: async (u) => {
        calls.expiries += 1;
        return { expiries: u === "RELIANCE" ? ["2026-11-24", "2026-12-29"] : [] };
      },
      quotes: async (syms) => {
        calls.quotes += 1;
        return { items: syms.map((s) => (s.endsWith("-FUT") ? { symbol: s, ltp: 1410, oi: oi.v } : { symbol: s, ltp: 1400, close: 1380 })), errors: [] };
      },
    },
    vol: { summary: async ({ underlyings }) => ((calls.vol += 1), { items: [{ underlying: underlyings[0], available: underlyings[0] === "RELIANCE", iv: 24.5, ivr: 40, hv20: 21 }] }) },
  };
  return { dir, clock, calls, oi, deps, svc: createWatchlistService(deps) };
}

describe("watchlist maths", () => {
  it("normalises symbols and finds the near future", () => {
    expect(normaliseSymbol(" reliance ")).toBe("NSE:RELIANCE");
    expect(normaliseSymbol("sensex")).toBe("BSE:SENSEX");
    expect(normaliseSymbol("nse:m&m")).toBe("NSE:M&M");
    expect(normaliseSymbol("XX:Y")).toBeNull();
    expect(normaliseSymbol("")).toBeNull();
    expect(nearFuture("NSE:RELIANCE", ["2026-11-03", "2026-11-24", "2026-12-29"], "2026-10-30")).toBe("NFO:RELIANCE-2026-11-24-FUT");
    expect(nearFuture("NFO:X-2026-11-24-FUT", ["2026-11-24"], "2026-10-30")).toBeNull();
    expect(nearFuture("NSE:TCS", [], "2026-10-30")).toBeNull();
  });
  it("rows, OI change and sorting", () => {
    expect(oiChange(1100, 1000)).toEqual({ oi: 1100, change: 100, changePct: 10 });
    const r = watchRow("NSE:RELIANCE", { ltp: 1400, close: 1380 }, { oi: oiChange(1100, 1000), vol: { iv: 24.5 } });
    expect(r).toMatchObject({ name: "RELIANCE", index: false, change: 20, oiChangePct: 10, iv: 24.5 });
    expect(r.changePct).toBeCloseTo((20 / 1380) * 100, 6);
    expect(sortRows([{ name: "B", iv: null }, { name: "A", iv: 3 }, { name: "C", iv: 5 }], "iv", -1).map((x) => x.name)).toEqual(["C", "A", "B"]);
  });
});

describe("watchlist service", () => {
  it("creates, validates, renames and deletes lists in the Bridge home", () => {
    const r = rig();
    expect(() => r.svc.create({ name: "" })).toThrow(/name/);
    expect(() => r.svc.create({ name: "X", symbols: ["???"] })).toThrow(/Not a symbol/);
    expect(() => r.svc.create({ name: "X", colour: 1 })).toThrow(/Unknown field/);
    const a = r.svc.create({ name: "Mine", symbols: ["reliance", "NSE:RELIANCE", "tcs"], events: true });
    expect(a).toMatchObject({ id: "w1", symbols: ["NSE:RELIANCE", "NSE:TCS"], events: true, home: false });
    const b = r.svc.create({ name: "Other", events: true, home: true });
    // One list feeds Live events at a time.
    expect(r.svc.list().map((l) => [l.name, l.events])).toEqual([["Mine", false], ["Other", true]]);
    expect(r.svc.update(b.id, { name: "Renamed" }).name).toBe("Renamed");
    expect(r.svc.remove(a.id)).toEqual({ id: a.id, deleted: true });
    expect(() => r.svc.get(a.id)).toThrow(/No watchlist/);
    expect(JSON.parse(readFileSync(join(r.dir, "watchlists", "lists.json"), "utf8")).lists).toHaveLength(1);
    expect(createWatchlistService(r.deps).list()).toHaveLength(1);
  });

  it("prices a list in one quotes call, finds futures once a day and measures OI change from the first read", async () => {
    const r = rig();
    const l = r.svc.create({ name: "F&O", symbols: ["NSE:RELIANCE", "NSE:TCS"] });
    const q1 = await r.svc.quotes(l.id);
    expect(r.calls.quotes).toBe(1);
    expect(q1.rows[0]).toMatchObject({ symbol: "NSE:RELIANCE", future: "NFO:RELIANCE-2026-11-24-FUT", oi: 1_000_000, oiChange: 0, iv: 24.5 });
    expect(q1.rows[1]).toMatchObject({ symbol: "NSE:TCS", future: null, oi: null, iv: null });
    r.oi.v = 1_050_000;
    const q2 = await r.svc.quotes(l.id);
    expect(q2.rows[0].oiChangePct).toBeCloseTo(5, 6);
    expect(r.calls.expiries).toBe(2);
  });

  it("demo mode starts with two lists, one on Home and feeding Live events", () => {
    const r = rig({ demo: true });
    const lists = r.svc.list();
    expect(lists).toHaveLength(2);
    expect(lists[0]).toMatchObject({ events: true, home: true });
  });

  it("declares read scope for reads and paper scope for changes", () => {
    for (const [m, , o] of ROUTES) expect(o.scope).toBe(m === "GET" ? "read" : "paper");
  });
});
