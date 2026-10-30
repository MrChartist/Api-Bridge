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

  it("leaves a book in whole lots alone", async () => {
    const { deps, calls } = fakes(-LOT);
    const r = await seedDemoBook(deps);
    expect(calls.reset).toEqual([]);
    expect(r.seeded).toEqual([]);
  });
});
