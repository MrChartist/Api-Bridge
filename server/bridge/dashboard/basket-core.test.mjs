import { describe, expect, it } from "vitest";
import { basketMarginBody, basketProgress, expandSlices, orderRows, sliceLots } from "./basket-core.js";

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
