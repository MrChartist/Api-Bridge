/**
 * The universe resolver: expiry rules, an ATM window from a real-time price, honesty about a delayed or missing price,
 * the library of collections when it is there, and the answer shapes it tolerates.
 */
import { describe, expect, it } from "vitest";
import { BridgeError } from "../core/errors.mjs";
import { createFakeMarketData } from "../market/fake.mjs";
import { fromLibraryAnswer, pickExpiries, createUniverseResolver } from "./universe.mjs";
import { NIFTY, at, leg } from "./testkit.mjs";

describe("pickExpiries", () => {
  const list = ["2026-11-09", "2026-11-17", "2026-11-24", "2026-12-01", "2026-12-08", "2026-12-29", "2027-01-26"];
  it("current and next weekly", () => {
    expect(pickExpiries(list, "current-weekly", "2026-11-09").dates).toEqual(["2026-11-09"]);
    expect(pickExpiries(list, "current-weekly", "2026-11-10").dates).toEqual(["2026-11-17"]);
    expect(pickExpiries(list, "next-weekly", "2026-11-09").dates).toEqual(["2026-11-17"]);
    expect(pickExpiries(["2026-11-17"], "next-weekly", "2026-11-09").dates).toEqual([]);
  });
  it("current monthly is the last expiry of the month of the nearest expiry, and moves to the next month after it", () => {
    expect(pickExpiries(list, "current-monthly", "2026-11-09").dates).toEqual(["2026-11-24"]);
    expect(pickExpiries(list, "current-monthly", "2026-11-25").dates).toEqual(["2026-12-29"]);
  });
  it("all weekly takes the next five weeks, capped", () => {
    expect(pickExpiries(list, "all-weekly", "2026-11-09").dates).toEqual(["2026-11-09", "2026-11-17", "2026-11-24", "2026-12-01", "2026-12-08"]);
  });
  it("explicit dates drop expired ones and say so", () => {
    const r = pickExpiries(list, ["2026-11-02", "2026-11-17", "2026-11-18"], "2026-11-09");
    expect(r.dates).toEqual(["2026-11-17", "2026-11-18"]);
    expect(r.notes.join(" ")).toMatch(/2026-11-02 has already expired/);
    expect(r.notes.join(" ")).toMatch(/2026-11-18 is not in the exchange's expiry list/);
  });
  it("nothing upcoming", () => {
    expect(pickExpiries([], "current-weekly", "2026-11-09").dates).toEqual([]);
  });
});

function world({ spot = 24012, label, library } = {}) {
  const clock = { now: () => at("2026-11-09T10:00:00") };
  const md = createFakeMarketData({ prices: { [NIFTY]: spot, "NSE:BANKNIFTY": 51030 }, clock });
  md.setExpiries("NIFTY", ["2026-11-09", "2026-11-17", "2026-11-24", "2026-12-29"]);
  md.setExpiries("BANKNIFTY", ["2026-11-24", "2026-12-29"]);
  const calls = [];
  const market = new Proxy(md, {
    get(t, p) {
      if (p === "optionChain") return async (...a) => {
        calls.push(["optionChain", ...a]);
        const r = await t.optionChain(...a);
        return label?.current ? { ...r, freshness: { ...r.freshness, ...label.current } } : r;
      };
      return t[p];
    },
  });
  const known = new Set();
  const symbols = { resolve: async (s) => { if (s.includes("FUT") && s.includes("BANKNIFTY")) throw new BridgeError("SYMBOL_NOT_FOUND", "no such instrument"); known.add(s); return { canonical: s }; } };
  const r = createUniverseResolver({ marketData: market, symbols, library: () => library ?? null, now: clock.now, share: () => 0.3 });
  return { r, md, calls };
}

const UNIVERSE = { expiries: "current-weekly", strikes: { around: "atm", count: 2 }, sides: ["CE", "PE"], includeUnderlying: true, includeFuture: false };

describe("the fallback resolver (underlying + universe)", () => {
  it("builds the ATM window for the current weekly expiry from the real-time price", async () => {
    const { r, calls } = world();
    const res = await r.resolve({ underlying: "NIFTY", universe: UNIVERSE });
    expect(res).toMatchObject({ ok: true, source: "bridge" });
    expect(res.rule).toBe("NIFTY 2026-11-09 ATM 24000 +/- 2 strikes (spot 24012)");
    expect(res.symbols).toEqual([
      ...[23900, 23950, 24000, 24050, 24100].flatMap((k) => [leg("NIFTY", "2026-11-09", k, "CE"), leg("NIFTY", "2026-11-09", k, "PE")]),
      NIFTY,
    ]);
    // one chain read, at background priority and within the share cap, never from a backup source
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toMatchObject({ priority: "background", backgroundShare: 0.3, allowBackup: false });
  });

  it("follows the price: a different spot gives a different ATM", async () => {
    const res = await world({ spot: 24260 }).r.resolve({ underlying: "NIFTY", universe: UNIVERSE });
    expect(res.rule).toMatch(/ATM 24250 /);
    expect(res.symbols).toContain(leg("NIFTY", "2026-11-09", 24250, "CE"));
  });

  it("sides, a strike range, the future and several underlyings", async () => {
    const { r } = world();
    const range = await r.resolve({ underlying: "NIFTY", universe: { ...UNIVERSE, strikes: { from: 23900, to: 24000 }, sides: ["PE"], includeUnderlying: false } });
    expect(range.symbols).toEqual([23900, 23950, 24000].map((k) => leg("NIFTY", "2026-11-09", k, "PE")));
    expect(range.rule).toBe("NIFTY 2026-11-09 strikes 23900 to 24000");
    const fut = await r.resolve({ underlying: "NIFTY", universe: { ...UNIVERSE, expiries: ["2026-11-24"], includeFuture: true, includeUnderlying: false } });
    expect(fut.symbols).toContain("NFO:NIFTY-2026-11-24-FUT");
    const noFut = await r.resolve({ underlying: "BANKNIFTY", universe: { ...UNIVERSE, includeFuture: true } });
    expect(noFut.symbols.some((s) => s.endsWith("-FUT"))).toBe(false); // the instrument list has no such future
    expect(noFut.notes.join(" ")).toMatch(/is not in the instrument list/);
    const two = await r.resolve({ underlying: ["NIFTY", "BANKNIFTY"], universe: UNIVERSE });
    expect(two.rule).toMatch(/NIFTY 2026-11-09 ATM 24000.*; BANKNIFTY 2026-11-24 ATM 51050/);
    expect(two.symbols).toContain(leg("BANKNIFTY", "2026-11-24", 51050, "CE"));
  });

  it("the manual shorthand (expiry + strikes) works the same way", async () => {
    const res = await world().r.resolve({ underlying: "NIFTY", expiry: "2026-11-17", strikes: 1 });
    expect(res.symbols).toContain(leg("NIFTY", "2026-11-17", 24000, "PE"));
    expect(res.symbols.filter((s) => s.includes("-CE"))).toHaveLength(3);
  });

  it("never uses a delayed or stale price for the ATM, and says why", async () => {
    const label = { current: { class: "delayed", delaySec: 900 } };
    const { r } = world({ label });
    const res = await r.resolve({ underlying: "NIFTY", universe: UNIVERSE });
    expect(res.ok).toBe(false);
    expect(res.symbols).toEqual([]);
    expect(res.reason).toMatch(/price of NIFTY is delayed \(900 s late\). A stale ATM is never used/);
    label.current = { stale: true };
    expect((await r.resolve({ underlying: "NIFTY", universe: UNIVERSE })).reason).toMatch(/out of date/);
    // a strike range does not depend on the price
    label.current = { class: "delayed", delaySec: 900 };
    expect((await r.resolve({ underlying: "NIFTY", universe: { ...UNIVERSE, strikes: { from: 24000, to: 24050 } } })).ok).toBe(true);
  });

  it("failures are plain: no expiries, no price, a broker error", async () => {
    const { r, md } = world();
    expect((await r.resolve({ underlying: "NOSUCH", universe: UNIVERSE })).reason).toMatch(/expiry list of NOSUCH could not be read/);
    md.fail(NIFTY, "UPSTREAM_ERROR");
    const noPrice = await r.resolve({ underlying: "NIFTY", universe: { ...UNIVERSE, expiries: ["2026-11-17"] } });
    expect(noPrice.symbols.length).toBeGreaterThan(0); // the chain itself was readable
    const empty = await r.resolve({ underlying: "NIFTY", universe: { ...UNIVERSE, expiries: ["2026-01-01"] } });
    expect(empty.ok).toBe(false);
    expect(empty.reason).toMatch(/already expired/);
  });
});

describe("symbols and collections", () => {
  it("listed symbols are checked and made canonical", async () => {
    const { r } = world();
    const res = await r.resolve({ symbols: ["NSE:NIFTY", "NSE:RELIANCE", "NSE:NIFTY", "nonsense!!"] });
    expect(res).toMatchObject({ ok: true, source: "given", symbols: ["NSE:NIFTY", "NSE:RELIANCE"] });
    expect(res.notes[0]).toMatch(/nonsense!!/);
  });

  it("a collection goes to the library's resolve and its answer is kept honest", async () => {
    const lib = { resolve: async (name) => ({ symbols: [NIFTY, "NSE:RELIANCE", "bad"], resolvedAt: "2026-11-09T10:00:00+05:30", rule: `collection ${name}` }) };
    const res = await world({ library: lib }).r.resolve({ collection: "watchlist" });
    expect(res).toMatchObject({ ok: true, source: "library", symbols: [NIFTY, "NSE:RELIANCE"], rule: "collection watchlist", resolvedAt: "2026-11-09T10:00:00+05:30" });
    const refused = await world({ library: { resolve: async () => ({ ok: false, symbols: [], reason: "NIFTY price is delayed" }) } }).r.resolve({ collection: "c" });
    expect(refused).toMatchObject({ ok: false, reason: "NIFTY price is delayed" });
    const broken = await world({ library: { resolve: async () => { throw new Error("boom"); } } }).r.resolve({ collection: "c" });
    expect(broken.reason).toMatch(/could not be resolved: boom/);
    const absent = await world().r.resolve({ collection: "c" });
    expect(absent.reason).toMatch(/library of collections is not available/);
  });

  it("tolerates the shapes a library may answer with", () => {
    expect(fromLibraryAnswer([NIFTY]).symbols).toEqual([NIFTY]);
    expect(fromLibraryAnswer({ data: { symbols: [{ symbol: NIFTY }] } }).symbols).toEqual([NIFTY]);
    expect(fromLibraryAnswer({ items: ["NSE:INFY"] }).symbols).toEqual(["NSE:INFY"]);
    expect(fromLibraryAnswer({ symbols: [NIFTY], atm: { ok: false } }).ok).toBe(false);
    expect(fromLibraryAnswer({}).reason).toMatch(/no symbols/);
  });

  it("never uses a collection resolved from a delayed or end-of-day price, and keeps the library's warnings", () => {
    const delayed = fromLibraryAnswer({ symbols: [NIFTY], atmSource: { source: "free-source", class: "delayed", delaySec: 900 } });
    expect(delayed.ok).toBe(false);
    expect(delayed.reason).toMatch(/not real-time/);
    expect(fromLibraryAnswer({ symbols: [NIFTY], atmSource: "eod close" }).ok).toBe(false);
    const live = fromLibraryAnswer({ symbols: [NIFTY], atmSource: { source: "stream", class: "realtime" }, warnings: ["Strikes 24000 missing", { message: "Lot size changed" }] });
    expect(live.ok).toBe(true);
    expect(live.notes).toEqual(["Strikes 24000 missing", "Lot size changed"]);
  });
});
