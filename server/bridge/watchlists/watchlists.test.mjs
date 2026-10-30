import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNullLogger } from "../core/logger.mjs";
import { createWatchlistService } from "./watchlistService.mjs";
import { ROUTES } from "./module.mjs";
import { frontExpiry, nearFuture, normaliseSymbol, oiChange, prevFutureOi, sortRows, watchRow } from "../dashboard/watchlist-core.js";

const NOW = Date.parse("2026-10-30T11:00:00+05:30");

function rig({ demo = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mcb-watch-"));
  const clock = { t: NOW, now() { return this.t; } };
  const calls = { quotes: 0, expiries: 0, vol: 0, chains: [] };
  const oi = { v: 1_000_000 };
  const box = { prevOi: null };
  const deps = {
    paths: { dataDir: dir },
    clock,
    logger: createNullLogger(),
    config: { demo },
    marketData: {
      expiries: async (u) => {
        calls.expiries += 1;
        return { expiries: u === "RELIANCE" ? ["2026-11-24", "2026-12-29"] : u === "NIFTY" ? ["2026-11-03", "2026-11-24"] : [] };
      },
      // The front expiry's chain: ATM 1400 with CE 30 % and PE 32 % (the ATM IV is their mean, 31 %).
      optionChain: async (p, o) => {
        calls.chains.push([p, o]);
        return { underlying: p.underlying, expiry: p.expiry, underlyingLtp: 1401, atmStrike: 1400, rows: [{ strike: 1380, ce: { iv: 29 }, pe: { iv: 33 } }, { strike: 1400, ce: { iv: 30 }, pe: { iv: 32 } }, { strike: 1420, ce: { iv: 31 }, pe: { iv: 34 } }] };
      },
      quotes: async (syms) => {
        calls.quotes += 1;
        return { items: syms.map((s) => (s.endsWith("-FUT") ? { symbol: s, ltp: 1410, oi: oi.v, ...(box.prevOi ? { oiPrev: box.prevOi } : {}) } : { symbol: s, ltp: 1400, close: 1380 })), errors: [] };
      },
    },
    vol: { summary: async ({ underlyings }) => ((calls.vol += 1), { items: [{ underlying: underlyings[0], available: underlyings[0] === "RELIANCE", iv: 24.5, ivr: 40, hv20: 21 }] }) },
    // The instrument master: FOOBAR and ZZZ are not in it.
    symbols: {
      resolve: async (s) => {
        if (/FOOBAR|ZZZ/.test(s)) throw Object.assign(new Error(`${s} is not in any connected broker's instrument master.`), { code: "SYMBOL_NOT_FOUND" });
        return { symbol: s };
      },
    },
  };
  const out = { dir, clock, calls, oi, deps, svc: createWatchlistService(deps) };
  Object.defineProperty(out, "prevOi", { set: (v) => (box.prevOi = v) });
  return out;
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
  it("front expiry and the recorder's previous-day future OI", () => {
    expect(frontExpiry(["2026-11-24", "2026-10-29", "2026-11-03"], "2026-10-30")).toBe("2026-11-03");
    expect(frontExpiry(["2026-10-30", "2026-11-03"], "2026-10-30")).toBe("2026-10-30");
    expect(frontExpiry([], "2026-10-30")).toBeNull();
    const rows = [
      { date: "2026-10-28", fut: { x: "2026-11-24", oi: 900 } },
      { date: "2026-10-29", fut: { x: "2026-11-24", oi: 1000 } },
      { date: "2026-10-29", fut: { x: "2026-10-27", oi: 5 } },
      { date: "2026-10-30", fut: { x: "2026-11-24", oi: 1200 } },
    ];
    expect(prevFutureOi(rows, "2026-11-24", "2026-10-30")).toEqual({ date: "2026-10-29", oi: 1000 });
    expect(prevFutureOi(rows, "2026-12-29", "2026-10-30")).toBeNull();
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
  it("creates, validates, renames and deletes lists in the Bridge home", async () => {
    const r = rig();
    await expect(r.svc.create({ name: "" })).rejects.toThrow(/name/);
    await expect(r.svc.create({ name: "X", symbols: ["???"] })).rejects.toThrow(/Not a symbol/);
    await expect(r.svc.create({ name: "X", colour: 1 })).rejects.toThrow(/Unknown field/);
    const a = await r.svc.create({ name: "Mine", symbols: ["reliance", "NSE:RELIANCE", "tcs"], events: true });
    expect(a).toMatchObject({ id: "w1", symbols: ["NSE:RELIANCE", "NSE:TCS"], events: true, home: false });
    const b = await r.svc.create({ name: "Other", events: true, home: true });
    // One list feeds Live events at a time.
    expect(r.svc.list().map((l) => [l.name, l.events])).toEqual([["Mine", false], ["Other", true]]);
    expect((await r.svc.update(b.id, { name: "Renamed" })).name).toBe("Renamed");
    expect(r.svc.remove(a.id)).toEqual({ id: a.id, deleted: true });
    expect(() => r.svc.get(a.id)).toThrow(/No watchlist/);
    expect(JSON.parse(readFileSync(join(r.dir, "watchlists", "lists.json"), "utf8")).lists).toHaveLength(1);
    expect(createWatchlistService(r.deps).list()).toHaveLength(1);
  });

  it("refuses a symbol the instrument master does not list, and a second list with the same name", async () => {
    const r = rig();
    await expect(r.svc.create({ name: "X", symbols: ["RELIANCE", "FOOBAR"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringMatching(/Not in the instrument master: NSE:FOOBAR/) });
    const l = await r.svc.create({ name: "Banks", symbols: ["HDFCBANK"] });
    await expect(r.svc.update(l.id, { symbols: [...l.symbols, "ZZZ"] })).rejects.toThrow(/Not in the instrument master: NSE:ZZZ/);
    expect(r.svc.get(l.id).symbols).toEqual(["NSE:HDFCBANK"]);
    await expect(r.svc.create({ name: " banks " })).rejects.toThrow(/already exists/);
    const o = await r.svc.create({ name: "Other" });
    await expect(r.svc.update(o.id, { name: "BANKS" })).rejects.toThrow(/already exists/);
    // Renaming a list to its own name in another case is fine.
    expect((await r.svc.update(l.id, { name: "BANKS" })).name).toBe("BANKS");
    // No instrument master loaded yet: nothing can be checked, so the symbol is kept.
    r.deps.symbols.resolve = async (s) => {
      throw Object.assign(new Error(`${s} could not be checked: no broker instrument master is loaded yet.`), { code: "SYMBOL_NOT_FOUND" });
    };
    expect((await r.svc.create({ name: "Later", symbols: ["NEWCO"] })).symbols).toEqual(["NSE:NEWCO"]);
  });

  it("prices a list in one quotes call, finds futures once a day, and measures OI change from the previous day's OI only", async () => {
    const r = rig();
    const l = await r.svc.create({ name: "F&O", symbols: ["NSE:RELIANCE", "NSE:TCS"] });
    const q1 = await r.svc.quotes(l.id);
    expect(r.calls.quotes).toBe(1);
    // No previous-day OI in the quote: the OI shows, its change stays blank (never 0 % from an intraday base).
    expect(q1.rows[0]).toMatchObject({ symbol: "NSE:RELIANCE", future: "NFO:RELIANCE-2026-11-24-FUT", oi: 1_000_000, oiChangePct: null, iv: 31, ivExpiry: "2026-11-24", ivr: 40, fno: true });
    expect(q1.rows[1]).toMatchObject({ symbol: "NSE:TCS", future: null, oi: null, iv: null, fno: false });
    r.prevOi = 800_000;
    const q2 = await r.svc.quotes(l.id);
    expect(q2.rows[0].oiChangePct).toBeCloseTo(25, 6);
    expect(q2.rows[0].oiBase).toBe("quote");
    expect(r.calls.expiries).toBe(2);
  });

  it("IV is the front expiry's ATM IV for indices and stocks alike, read from a background chain and reused 30 s", async () => {
    const r = rig();
    const svc = createWatchlistService(r.deps, { factsFor: async () => ({ "NSE:RELIANCE": { fno: true, atm_iv: 42.4, iv_rank: 62, hv20: 18, fut_oi: 5_000_000, fut_oi_change_pct: -3.2 } }) });
    const l = await svc.create({ name: "Mixed", symbols: ["NSE:NIFTY", "NSE:RELIANCE"] });
    const q = await svc.quotes(l.id);
    // The scanner's own ATM IV (42.4) is another measure and is not shown; its rank and HV20 are.
    expect(q.rows[1]).toMatchObject({ symbol: "NSE:RELIANCE", iv: 31, ivExpiry: "2026-11-24", ivr: 40, hv20: 21, oiChangePct: -3.2 });
    expect(q.rows[0]).toMatchObject({ symbol: "NSE:NIFTY", iv: 31, ivExpiry: "2026-11-03", index: true });
    expect(r.calls.chains.map(([p]) => [p.underlying, p.expiry])).toEqual([["NIFTY", "2026-11-03"], ["RELIANCE", "2026-11-24"]]);
    expect(r.calls.chains[0][1]).toMatchObject({ priority: "background" });
    await svc.quotes(l.id);
    expect(r.calls.chains).toHaveLength(2);
    r.clock.t += 31_000;
    await svc.quotes(l.id);
    expect(r.calls.chains).toHaveLength(4);
  });

  it("index OI change falls back to the recorder's previous-day OI of the same future", async () => {
    const r = rig();
    const asked = [];
    r.deps.recorder = { daily: async (p) => (asked.push(p), [{ date: "2026-10-29", fut: { x: "2026-11-24", oi: 800_000 } }, { date: "2026-10-30", fut: { x: "2026-11-24", oi: 990_000 } }]) };
    const svc = createWatchlistService(r.deps);
    const l = await svc.create({ name: "Index", symbols: ["NIFTY"] });
    const q = await svc.quotes(l.id);
    expect(q.rows[0]).toMatchObject({ future: "NFO:NIFTY-2026-11-24-FUT", oi: 1_000_000, oiChangePct: 25, oiBase: "recorder 2026-10-29" });
    await svc.quotes(l.id);
    expect(asked).toHaveLength(1);
    // Nothing recorded before today: the change stays blank, and the recorder is asked again a few minutes later.
    r.deps.recorder.daily = async (p) => (asked.push(p), []);
    const svc2 = createWatchlistService(r.deps);
    const l2 = await svc2.create({ name: "Index 2", symbols: ["NIFTY"] });
    expect((await svc2.quotes(l2.id)).rows[0]).toMatchObject({ oi: 1_000_000, oiChangePct: null, oiBase: null });
    await svc2.quotes(l2.id);
    expect(asked).toHaveLength(2);
    r.clock.t += 6 * 60_000;
    await svc2.quotes(l2.id);
    expect(asked).toHaveLength(3);
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
