/**
 * S8 fill model: pure rules for MARKET/LIMIT/SL/SL-M fills, tick rounding, margin, brokerage and position maths.
 */
import { describe, expect, it } from "vitest";
import {
  FILL_MODEL_TEXT,
  applyFill,
  bestOpposite,
  brokerageFor,
  evaluate,
  isTickMultiple,
  limitCrossed,
  marginFor,
  marketFillPrice,
  round2,
  roundToTick,
  stopTriggered,
} from "./fillModel.mjs";

const M = { intradayEquityPct: 20, futuresPct: 15, optionSellPct: 15 };
const flat = () => ({ netQty: 0, avgPrice: 0, realisedPnl: 0, buyQty: 0, sellQty: 0, buyValue: 0, sellValue: 0 });
const opts = { slippageBps: 5, tickSize: 0.05 };

describe("tick rounding", () => {
  it("rounds to the tick in each direction without float noise", () => {
    expect(roundToTick(100.03, 0.05)).toBe(100.05);
    expect(roundToTick(100.02, 0.05)).toBe(100);
    expect(roundToTick(100.01, 0.05, "up")).toBe(100.05);
    expect(roundToTick(100.04, 0.05, "down")).toBe(100);
    expect(roundToTick(0.1 + 0.2, 0.1)).toBe(0.3);
    expect(roundToTick(1401.37, 0.5, "up")).toBe(1401.5);
    expect(roundToTick(5.0, 0.0025)).toBe(5);
  });

  it("keeps exact multiples when rounding up or down", () => {
    expect(roundToTick(100.05, 0.05, "up")).toBe(100.05);
    expect(roundToTick(100.05, 0.05, "down")).toBe(100.05);
  });

  it("falls back to paise for a missing tick", () => {
    expect(roundToTick(10.123, 0)).toBe(10.12);
    expect(roundToTick(10.123, NaN, "up")).toBe(10.13);
  });

  it("checks tick multiples with float tolerance", () => {
    expect(isTickMultiple(100.15, 0.05)).toBe(true);
    expect(isTickMultiple(100.12, 0.05)).toBe(false);
    expect(isTickMultiple(1, 0)).toBe(true);
  });
});

describe("MARKET price", () => {
  it("uses the opposite best price from depth first", () => {
    const depth = { bids: [{ price: 99.9 }], asks: [{ price: 100.1 }] };
    expect(marketFillPrice({ side: "BUY", ltp: 100, depth, ...opts })).toEqual({ price: 100.1, basis: "depth" });
    expect(marketFillPrice({ side: "SELL", ltp: 100, depth, ...opts })).toEqual({ price: 99.9, basis: "depth" });
  });

  it("uses tick bid/ask when there is no depth", () => {
    expect(marketFillPrice({ side: "BUY", ltp: 100, ask: 100.2, bid: 99.8, ...opts })?.price).toBe(100.2);
    expect(marketFillPrice({ side: "SELL", ltp: 100, ask: 100.2, bid: 99.8, ...opts })?.price).toBe(99.8);
  });

  it("falls back to LTP ± slippage, rounded against the trader", () => {
    // 1000 * 1.0005 = 1000.5 ; 1000 * 0.9995 = 999.5
    expect(marketFillPrice({ side: "BUY", ltp: 1000, ...opts })).toEqual({ price: 1000.5, basis: "ltp" });
    expect(marketFillPrice({ side: "SELL", ltp: 1000, ...opts })).toEqual({ price: 999.5, basis: "ltp" });
    // 101 * 1.0005 = 101.0505 -> up to 101.1 ; 101 * 0.9995 = 100.9495 -> down to 100.9
    expect(marketFillPrice({ side: "BUY", ltp: 101, ...opts })?.price).toBe(101.1);
    expect(marketFillPrice({ side: "SELL", ltp: 101, ...opts })?.price).toBe(100.9);
  });

  it("ignores empty or zero depth levels and needs some price", () => {
    expect(bestOpposite("BUY", { asks: [{ price: 0 }] })).toBeNull();
    expect(bestOpposite("SELL", { bids: [] })).toBeNull();
    expect(marketFillPrice({ side: "BUY", ltp: null, depth: { asks: [] }, ...opts })).toBeNull();
  });

  it("never fills a cheap option at zero after slippage", () => {
    expect(marketFillPrice({ side: "SELL", ltp: 0.05, slippageBps: 500, tickSize: 0.05 })?.price).toBe(0.05);
  });
});

describe("crossing rules", () => {
  it("limit crosses at or through the limit", () => {
    expect(limitCrossed("BUY", 100, 100)).toBe(true);
    expect(limitCrossed("BUY", 100, 100.05)).toBe(false);
    expect(limitCrossed("SELL", 100, 100)).toBe(true);
    expect(limitCrossed("SELL", 100, 99.95)).toBe(false);
  });

  it("stop triggers at or through the trigger", () => {
    expect(stopTriggered("BUY", 105, 105)).toBe(true);
    expect(stopTriggered("BUY", 105, 104.95)).toBe(false);
    expect(stopTriggered("SELL", 95, 95)).toBe(true);
    expect(stopTriggered("SELL", 95, 95.05)).toBe(false);
  });
});

describe("evaluate", () => {
  const limitBuy = { side: "BUY", orderType: "LIMIT", price: 100, triggerPrice: null, triggered: false };

  it("returns noprice without a usable LTP", () => {
    expect(evaluate(limitBuy, { ltp: 0 }, opts)).toEqual({ action: "noprice" });
    expect(evaluate(limitBuy, null, opts)).toEqual({ action: "noprice" });
  });

  it("LIMIT waits, then fills at the limit when crossed", () => {
    expect(evaluate(limitBuy, { ltp: 101 }, opts)).toEqual({ action: "none" });
    expect(evaluate(limitBuy, { ltp: 99 }, opts)).toEqual({ action: "fill", price: 100, triggered: false });
  });

  it("a marketable LIMIT on arrival fills at the better market price", () => {
    expect(evaluate({ ...limitBuy, price: 105 }, { ltp: 100 }, { ...opts, immediate: true })).toEqual({ action: "fill", price: 100, triggered: false });
    expect(evaluate({ ...limitBuy, side: "SELL", price: 95 }, { ltp: 100, bid: 99.9 }, { ...opts, immediate: true })).toEqual({ action: "fill", price: 99.9, triggered: false });
  });

  it("a LIMIT is judged against the opposite touch when the book is known, not LTP", () => {
    // LTP 99.5 is below the buy limit, but the best ask is 101: no seller at or below 100 is showing.
    expect(evaluate(limitBuy, { ltp: 99.5, bid: 99, ask: 101 }, { ...opts, immediate: true })).toEqual({ action: "none" });
    expect(evaluate(limitBuy, { ltp: 99.5, bid: 99, ask: 101 }, opts)).toEqual({ action: "none" });
    expect(evaluate(limitBuy, { ltp: 101, depth: { bids: [{ price: 99 }], asks: [{ price: 100 }] } }, opts)).toEqual({ action: "fill", price: 100, triggered: false });
    const limitSell = { ...limitBuy, side: "SELL" };
    expect(evaluate(limitSell, { ltp: 100.5, bid: 99.5, ask: 101 }, opts)).toEqual({ action: "none" });
    expect(evaluate(limitSell, { ltp: 99, bid: 100.2, ask: 100.4 }, opts)).toEqual({ action: "fill", price: 100, triggered: false });
    // Book unknown: LTP decides, as before.
    expect(evaluate(limitBuy, { ltp: 99.5 }, opts)).toEqual({ action: "fill", price: 100, triggered: false });
  });

  it("MARKET always fills when there is a price", () => {
    expect(evaluate({ side: "SELL", orderType: "MARKET", price: null, triggerPrice: null, triggered: false }, { ltp: 1000 }, opts)).toEqual({ action: "fill", price: 999.5, triggered: false });
  });

  it("SL-M waits for the trigger then fills like MARKET", () => {
    const o = { side: "SELL", orderType: "SL-M", price: null, triggerPrice: 95, triggered: false };
    expect(evaluate(o, { ltp: 96 }, opts)).toEqual({ action: "none" });
    expect(evaluate(o, { ltp: 94, bid: 93.9 }, opts)).toEqual({ action: "fill", price: 93.9, triggered: true });
  });

  it("SL triggers into a LIMIT and fills only when the limit is crossed", () => {
    const o = { side: "BUY", orderType: "SL", price: 101, triggerPrice: 100, triggered: false };
    expect(evaluate(o, { ltp: 99 }, opts)).toEqual({ action: "none" });
    expect(evaluate(o, { ltp: 102 }, opts)).toEqual({ action: "trigger" });
    expect(evaluate({ ...o, triggered: true }, { ltp: 102 }, opts)).toEqual({ action: "none" });
    expect(evaluate({ ...o, triggered: true }, { ltp: 100.5 }, opts)).toEqual({ action: "fill", price: 101, triggered: true });
  });

  it("SL that triggers and is marketable in one step fills at the better price", () => {
    const o = { side: "BUY", orderType: "SL", price: 101, triggerPrice: 100, triggered: false };
    expect(evaluate(o, { ltp: 100.5 }, opts)).toEqual({ action: "fill", price: 100.5, triggered: true });
  });
});

describe("margin and brokerage (approximate)", () => {
  it("equity delivery blocks full value, intraday a percentage", () => {
    expect(marginFor({ kind: "EQ" }, { side: "BUY", product: "CNC", quantity: 10, price: 1400 }, M)).toBe(14_000);
    expect(marginFor({ kind: "EQ" }, { side: "SELL", product: "INTRADAY", quantity: 10, price: 1400 }, M)).toBe(2800);
  });

  it("futures block a percentage of contract value", () => {
    expect(marginFor({ kind: "FUT" }, { side: "SELL", product: "MARGIN", quantity: 65, price: 25_000 }, M)).toBe(243_750);
  });

  it("option buys block the premium; option writing a percentage of strike value", () => {
    expect(marginFor({ kind: "OPT", strike: 25_000 }, { side: "BUY", product: "MARGIN", quantity: 65, price: 120 }, M)).toBe(7800);
    expect(marginFor({ kind: "OPT", strike: 25_000 }, { side: "SELL", product: "INTRADAY", quantity: 65, price: 120 }, M)).toBe(243_750);
  });

  it("zero quantity blocks nothing", () => {
    expect(marginFor({ kind: "EQ" }, { side: "BUY", product: "CNC", quantity: 0, price: 1 }, M)).toBe(0);
  });

  it("brokerage: flat plus percentage, capped", () => {
    expect(brokerageFor(100_000, { perOrder: 0, pct: 0, maxPerOrder: null })).toBe(0);
    expect(brokerageFor(100_000, { perOrder: 20, pct: 0, maxPerOrder: null })).toBe(20);
    expect(brokerageFor(100_000, { perOrder: 0, pct: 0.03, maxPerOrder: 20 })).toBe(20);
    expect(brokerageFor(10_000, { perOrder: 0, pct: 0.03, maxPerOrder: 20 })).toBe(3);
  });
});

describe("applyFill", () => {
  it("averages same-direction fills", () => {
    let { position } = applyFill(flat(), { side: "BUY", quantity: 10, price: 100 });
    ({ position } = applyFill(position, { side: "BUY", quantity: 30, price: 104 }));
    expect(position.netQty).toBe(40);
    expect(position.avgPrice).toBe(103);
    expect(position.realisedPnl).toBe(0);
  });

  it("realises on a partial close and keeps the average", () => {
    const { position: p1 } = applyFill(flat(), { side: "BUY", quantity: 40, price: 103 });
    const { position, realised } = applyFill(p1, { side: "SELL", quantity: 10, price: 110 });
    expect(realised).toBe(70);
    expect(position.netQty).toBe(30);
    expect(position.avgPrice).toBe(103);
  });

  it("realises shorts correctly and resets the average when flat", () => {
    const { position: p1 } = applyFill(flat(), { side: "SELL", quantity: 50, price: 200 });
    const { position, realised } = applyFill(p1, { side: "BUY", quantity: 50, price: 190 });
    expect(realised).toBe(500);
    expect(position.netQty).toBe(0);
    expect(position.avgPrice).toBe(0);
  });

  it("a flip realises the closed part and opens the rest at the fill price", () => {
    const { position: p1 } = applyFill(flat(), { side: "BUY", quantity: 10, price: 100 });
    const { position, realised } = applyFill(p1, { side: "SELL", quantity: 25, price: 90 });
    expect(realised).toBe(-100);
    expect(position.netQty).toBe(-15);
    expect(position.avgPrice).toBe(90);
    expect(position.buyQty).toBe(10);
    expect(position.sellQty).toBe(25);
    expect(round2(position.sellValue)).toBe(2250);
  });

  it("does not mutate its input", () => {
    const p = flat();
    applyFill(p, { side: "BUY", quantity: 1, price: 1 });
    expect(p).toEqual(flat());
  });
});

it("describes the fill model for clients", () => {
  expect(FILL_MODEL_TEXT).toMatch(/opposite best price/);
  expect(FILL_MODEL_TEXT).toMatch(/15:20 IST/);
});
