import { describe, expect, it } from "vitest";
import { basketMarginBody, basketProgress, expandSlices, orderLimitsOf, orderRows, perOrderCap, sliceLots, sliceNotes } from "./basket-core.js";

describe("orderLimitsOf", () => {
  it("reads one account's per-order limits from GET /v1/safety, null when it is not listed", () => {
    const safety = { accounts: [{ accountId: "a", limits: { maxLotsPerOrder: 10, maxOrderValue: 200000, dailyMaxOrders: 100 } }, { accountId: "b" }] };
    expect(orderLimitsOf(safety, "a")).toEqual({ maxLotsPerOrder: 10, maxOrderValue: 200000 });
    expect(orderLimitsOf(safety, "b")).toBeNull();
    expect(orderLimitsOf(safety, "c")).toBeNull();
    expect(orderLimitsOf(null, "a")).toBeNull();
  });
});

describe("freeze slicing", () => {
  it("splits whole lots under the freeze quantity, the last slice taking the rest", () => {
    // NIFTY: lot 65, freeze 1800 → 27 lots per slice.
    expect(sliceLots(60, 65, 1800)).toEqual([27, 27, 6]);
    expect(sliceLots(27, 65, 1800)).toEqual([27]);
    expect(sliceLots(5, 65, null)).toEqual([5]);
    expect(sliceLots(0, 65, 1800)).toEqual([]);
    // A freeze under one lot still sends one lot at a time.
    expect(sliceLots(3, 100, 50)).toEqual([1, 1, 1]);
  });

  it("expands items into slice rows with their own labels", () => {
    const rows = expandSlices([
      { label: "26000 CE", side: "SELL", lots: 30, lotSize: 65, freezeQty: 1800 },
      { label: "25500 PE", side: "BUY", lots: 2, lotSize: 65, freezeQty: 1800 },
    ]);
    expect(rows.map((r) => [r.label, r.lots, r.item])).toEqual([
      ["26000 CE · 1/2", 27, 0],
      ["26000 CE · 2/2", 3, 0],
      ["25500 PE", 2, 1],
    ]);
  });
});

describe("per-order limits (safety config)", () => {
  // The demo's default per-order limits: 10 lots and ₹2,00,000 an order.
  const demo = { maxLotsPerOrder: 10, maxOrderValue: 200_000 };

  it("slices at the smaller of the freeze and the per-order lots limit, so every slice can pass", () => {
    // 40 NIFTY lots: the freeze alone gives 27 + 13, both above the 10-lot limit; the limit gives 10 × 4.
    expect(sliceLots(40, 65, 1800)).toEqual([27, 13]);
    expect(sliceLots(40, 65, 1800, demo, 50)).toEqual([10, 10, 10, 10]);
    expect(sliceLots(25, 65, 1800, demo, 50)).toEqual([10, 10, 5]);
    expect(sliceLots(10, 65, 1800, demo, 50)).toEqual([10]);
    for (const lots of sliceLots(40, 65, 1800, demo, 50)) expect(lots).toBeLessThanOrEqual(demo.maxLotsPerOrder);
    // A freeze tighter than the lots limit still wins.
    expect(sliceLots(12, 100, 500, demo, 10)).toEqual([5, 5, 2]);
    expect(perOrderCap({ lotSize: 100, freezeQty: 500, price: 10 }, demo)).toEqual({ per: 5, by: "freeze" });
  });

  it("slices under the per-order value limit at the leg's price, never below one lot", () => {
    // 65 × ₹200 = ₹13,000 a lot: ₹2,00,000 fits 15 lots, under the 27-lot freeze but above the 10-lot limit.
    expect(perOrderCap({ lotSize: 65, freezeQty: 1800, price: 200 }, demo)).toEqual({ per: 10, by: "lots" });
    // 65 × ₹400 = ₹26,000 a lot: 7 lots fit.
    expect(perOrderCap({ lotSize: 65, freezeQty: 1800, price: 400 }, demo)).toEqual({ per: 7, by: "value" });
    expect(sliceLots(20, 65, 1800, demo, 400)).toEqual([7, 7, 6]);
    for (const lots of sliceLots(20, 65, 1800, demo, 400)) expect(lots * 65 * 400).toBeLessThanOrEqual(demo.maxOrderValue);
    // One lot above the value limit stays one lot an order: the Bridge refuses it and says so.
    expect(sliceLots(3, 65, 1800, { maxOrderValue: 1000 }, 400)).toEqual([1, 1, 1]);
    // No price, no value cap; no limits at all, the freeze alone.
    expect(perOrderCap({ lotSize: 65, freezeQty: 1800 }, { maxOrderValue: 1000 })).toEqual({ per: 27, by: "freeze" });
    expect(perOrderCap({ lotSize: 65 }, {})).toEqual({ per: null, by: null });
  });

  it("marks why an item was split and explains it once in the sheet", () => {
    const items = [
      { label: "27250 CE", side: "BUY", lots: 40, lotSize: 65, freezeQty: 1800, price: 20 },
      { label: "26900 CE", side: "SELL", lots: 40, lotSize: 65, freezeQty: 1800, price: 60 },
      { label: "25500 PE", side: "BUY", lots: 2, lotSize: 65, freezeQty: 1800, price: 20 },
    ];
    const rows = expandSlices(items, demo);
    expect(rows.filter((r) => r.item === 0).map((r) => r.lots)).toEqual([10, 10, 10, 10]);
    expect(rows.find((r) => r.item === 0).slicedBy).toBe("lots");
    expect(rows.find((r) => r.item === 2).slicedBy).toBeNull();
    expect(sliceNotes(rows)).toEqual(["Sliced to 10 lots per order: your per-order limit (Safety)"]);
    // Without the limits: the freeze, naming the legs.
    expect(sliceNotes(expandSlices(items))).toEqual(["Sliced to 27 lots per order: the exchange freeze quantity (27250 CE, 26900 CE)"]);
    expect(sliceNotes(expandSlices([items[2]], demo))).toEqual([]);
  });
});

describe("send order", () => {
  const rows = [
    { side: "SELL", label: "a" },
    { side: "BUY", label: "b" },
    { side: "SELL", label: "c" },
    { side: "BUY", label: "d" },
  ];
  it("buys first, stable, with buys waited as hedges", () => {
    const o = orderRows(rows);
    expect(o.map((r) => r.label)).toEqual(["b", "d", "a", "c"]);
    expect(o.map((r) => r.phase)).toEqual(["hedge", "hedge", "short", "short"]);
  });
  it("as listed keeps the order and waits for nothing", () => {
    const o = orderRows(rows, "as-listed");
    expect(o.map((r) => r.label)).toEqual(["a", "b", "c", "d"]);
    expect(new Set(o.map((r) => r.phase))).toEqual(new Set(["listed"]));
  });
  it("an exit plan is left as planned", () => {
    expect(orderRows(rows, "buys-first", { exit: true })).toEqual(rows);
  });
});

describe("basket margin and progress", () => {
  it("builds the margin body from whole items, up to 24 legs", () => {
    expect(basketMarginBody([{ symbol: "NFO:X", side: "SELL", lots: 2, price: 10.5 }, { symbol: null, side: "BUY", lots: 1 }])).toEqual({ legs: [{ symbol: "NFO:X", side: "SELL", lots: 2, price: 10.5 }] });
    expect(basketMarginBody(Array.from({ length: 25 }, (_, i) => ({ symbol: `S${i}`, side: "BUY", lots: 1 })))).toBeNull();
    expect(basketMarginBody([])).toBeNull();
  });
  it("counts filled, working, failed and waiting rows", () => {
    const p = basketProgress([{ status: "filled" }, { status: "open" }, { status: "rejected" }, { status: "queued" }]);
    expect(p).toEqual({ total: 4, filled: 1, working: 1, failed: 1, waiting: 1, done: false });
    expect(basketProgress([{ status: "filled" }, { status: "cancelled" }]).done).toBe(true);
  });
});
