import { describe, expect, it } from "vitest";
import { offLot, seedDemoBook } from "./demoBook.mjs";

// The demo seed follows the instrument's current lot: a book seeded at an old lot size (NIFTY 75 before the lot became
// 65) is reset and seeded again, and a book in whole lots is left alone.
const LOT = 65;
const symbols = { resolve: async (s) => ({ lotSize: s.startsWith("NFO:NIFTY") ? LOT : 20 }), warm: async () => ({}) };

function fakes(netQty) {
  const calls = { reset: [], place: [] };
  const book = { "demo-paper": [{ symbol: "NFO:NIFTY-2026-11-03-26600-CE", netQty }] };
  const rows = [26300, 26350, 26400].map((k) => ({ strike: k, ce: { symbol: `NFO:NIFTY-2026-11-03-${k}-CE` }, pe: { symbol: `NFO:NIFTY-2026-11-03-${k}-PE` } }));
  return {
    calls,
    deps: {
      config: { demo: true, accounts: [{ id: "demo-paper" }] },
      store: { tags: () => ({ demo: 1, "demo-spouse": 1, "demo-other": 1 }), set() {} },
      symbols,
      paper: {
        account: async () => ({ startingCapital: 2_500_000 }),
        reset: async (id, opts) => {
          calls.reset.push([id, opts]);
          book[id] = [];
        },
      },
      orders: {
        positions: async (_ctx, id) => ({ items: book[id] ?? [] }),
        place: async (_ctx, o) => (calls.place.push(o), { order: { status: "complete" } }),
      },
      marketData: {
        expiries: async () => ({ expiries: ["2026-11-03"] }),
        optionChain: async () => ({ underlyingLtp: 26350, rows }),
      },
      clock: { now: () => Date.parse("2026-10-30T06:00:00Z") },
      logger: { info() {}, warn() {}, debug() {}, error() {}, child() { return this; } },
    },
  };
}

describe("demo book seed and lot sizes", () => {
  it("offLot spots a leg that is not a whole number of the current lot", async () => {
    expect(await offLot([{ symbol: "NFO:NIFTY-2026-11-03-26600-CE", netQty: -75 }], symbols)).toBe(true);
    expect(await offLot([{ symbol: "NFO:NIFTY-2026-11-03-26600-CE", netQty: -130 }], symbols)).toBe(false);
    expect(await offLot([{ symbol: "NFO:NIFTY-2026-11-03-26600-CE", netQty: -75 }], undefined)).toBe(false);
  });

  it("resets and reseeds a book seeded at an old lot size, keeping its capital; orders go in lots", async () => {
    const { deps, calls } = fakes(-75);
    const r = await seedDemoBook(deps);
    expect(calls.reset).toEqual([["demo-paper", { startingCapital: 2_500_000 }]]);
    expect(r.seeded).toEqual(["demo-paper"]);
    expect(calls.place.length).toBeGreaterThan(0);
    for (const o of calls.place) {
      expect(o.lots).toBe(1);
      expect(o.quantity).toBeUndefined();
    }
  });

  it("reports its progress leg by leg, and prices each account's legs and spots in one read before placing them", async () => {
    const { deps, calls } = fakes(-75);
    const seen = [];
    const events = [];
    deps.progress = (p) => seen.push({ ...p });
    deps.marketData.ltp = async (symbols, opts) => (events.push(["ltp", symbols, opts]), { items: [] });
    const place = deps.orders.place;
    deps.orders.place = async (ctx, o, x) => (events.push(["place", o.symbol]), place(ctx, o, x));
    await seedDemoBook(deps);
    const n = calls.place.length;
    expect(n).toBe(4);
    expect(seen[0]).toEqual({ done: 0, total: null });
    expect(seen[1]).toEqual({ done: 0, total: n });
    expect(seen.at(-1)).toEqual({ done: n, total: n });
    // Never a count that goes back or past the total.
    for (let i = 1; i < seen.length; i += 1) expect(seen[i].done).toBeGreaterThanOrEqual(seen[i - 1].done);
    expect(events[0][0]).toBe("ltp");
    expect(events[0][1]).toEqual(expect.arrayContaining([...calls.place.map((o) => o.symbol), "NSE:NIFTY"]));
    expect(events[0][2]).toEqual({ priority: "background" });
    expect(events.slice(1).every((e) => e[0] === "place")).toBe(true);
  });

  it("a book already seeded reports no legs to place", async () => {
    const { deps } = fakes(-LOT);
    const seen = [];
    deps.progress = (p) => seen.push(p);
    await seedDemoBook(deps);
    expect(seen.at(-1)).toEqual({ done: 0, total: 0 });
  });

  it("leaves a book in whole lots alone", async () => {
    const { deps, calls } = fakes(-LOT);
    const r = await seedDemoBook(deps);
    expect(calls.reset).toEqual([]);
    expect(r.seeded).toEqual([]);
  });
});
