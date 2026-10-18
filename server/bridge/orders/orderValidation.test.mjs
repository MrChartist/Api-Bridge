import { describe, expect, it } from "vitest";
import {
  applyMarketPolicy,
  blocking,
  checkInstrumentOrder,
  fingerprint,
  isMultipleOf,
  orderBody,
  parseOrderChanges,
  parseOrderRequest,
  resolveQuantity,
  roundToTick,
  rupees,
  sortByPriority,
} from "./orderValidation.mjs";

const base = { account: "dhan-main", symbol: "NSE:RELIANCE", side: "BUY", quantity: 10, product: "CNC", orderType: "LIMIT", price: 1400 };
const reliance = { canonical: "NSE:RELIANCE", exchange: "NSE", kind: "EQ", lotSize: 1, tickSize: 0.1, freezeQty: null };
const niftyCe = { canonical: "NFO:NIFTY-2026-10-27-25000-CE", exchange: "NFO", kind: "OPT", lotSize: 65, tickSize: 0.05, freezeQty: 1800 };

const failsWith = (input, path) => {
  try {
    parseOrderRequest(input);
  } catch (err) {
    expect(err.code).toBe("VALIDATION_FAILED");
    if (path) expect(err.errors.map((e) => e.path)).toContain(path);
    return err;
  }
  throw new Error("expected a validation failure");
};

describe("OrderRequest schema (openapi)", () => {
  it("accepts a minimal LIMIT order and keeps mode undefined (paper by default)", () => {
    const o = parseOrderRequest(base);
    expect(o).toMatchObject(base);
    expect(o.mode).toBeUndefined();
  });

  it("has no default product or order type", () => {
    const { product, ...noProduct } = base;
    const { orderType, ...noType } = base;
    void product;
    void orderType;
    failsWith(noProduct, "product");
    failsWith(noType, "orderType");
  });

  it("needs exactly one of quantity or lots", () => {
    failsWith({ ...base, lots: 1 }, "quantity");
    const { quantity, ...neither } = base;
    void quantity;
    failsWith(neither, "quantity");
    expect(parseOrderRequest({ ...neither, lots: 2 }).lots).toBe(2);
  });

  it("checks price and trigger against the order type", () => {
    failsWith({ ...base, price: undefined }, "price");
    failsWith({ ...base, orderType: "MARKET" }, "price");
    failsWith({ ...base, orderType: "SL" }, "triggerPrice");
    failsWith({ ...base, orderType: "SL-M", price: undefined }, "triggerPrice");
    failsWith({ ...base, triggerPrice: 1390 }, "triggerPrice");
    failsWith({ ...base, marketProtectionPct: 2 }, "marketProtectionPct");
    expect(parseOrderRequest({ ...base, orderType: "MARKET", price: undefined, marketProtectionPct: 1 }).marketProtectionPct).toBe(1);
  });

  it("refuses unknown fields, bad ids and out-of-range numbers", () => {
    failsWith({ ...base, lotSize: 75 });
    failsWith({ ...base, account: "Dhan Main" }, "account");
    failsWith({ ...base, clientOrderId: "has space" }, "clientOrderId");
    failsWith({ ...base, tag: "x".repeat(21) }, "tag");
    failsWith({ ...base, quantity: 1.5 }, "quantity");
    failsWith({ ...base, price: -1 }, "price");
    failsWith({ ...base, mode: "LIVE" }, "mode");
    failsWith({ ...base, disclosedQuantity: 20 }, "disclosedQuantity");
  });

  it("OrderChanges needs at least one known field", () => {
    expect(() => parseOrderChanges({})).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => parseOrderChanges({ symbol: "x" })).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(parseOrderChanges({ price: 10 })).toEqual({ price: 10 });
  });
});

describe("fingerprints", () => {
  it("ignore key order and undefined fields, and drop confirmToken from the body", () => {
    expect(fingerprint({ a: 1, b: { c: 2, d: undefined } })).toBe(fingerprint({ b: { c: 2 }, a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
    expect(orderBody({ ...base, confirmToken: "x".repeat(20) })).toEqual(base);
  });
});

describe("numbers", () => {
  it("tick multiples without float drift", () => {
    expect(isMultipleOf(1400.1, 0.1)).toBe(true);
    expect(isMultipleOf(120.55, 0.05)).toBe(true);
    expect(isMultipleOf(120.52, 0.05)).toBe(false);
    expect(roundToTick(1430.346, 0.1, "down")).toBe(1430.3);
    expect(roundToTick(1374.254, 0.1, "up")).toBe(1374.3);
    expect(roundToTick(120.52, 0.05)).toBe(120.5);
  });

  it("formats rupees with Indian grouping", () => {
    expect(rupees(200000)).toBe("₹2,00,000");
    expect(rupees(1234.5)).toBe("₹1,234.50");
    expect(rupees(12345678)).toBe("₹1,23,45,678");
    expect(rupees(-950)).toBe("-₹950");
  });
});

describe("pre-trade checks", () => {
  it("sizes by lots or checks the lot multiple", () => {
    expect(resolveQuantity({ lots: 2 }, niftyCe)).toEqual({ quantity: 130, checks: [] });
    const bad = resolveQuantity({ quantity: 100 }, niftyCe);
    expect(bad.checks[0]).toMatchObject({ code: "INVALID_ORDER", severity: "block" });
    expect(bad.checks[0].message).toMatch(/multiple of the lot size 65/);
    expect(resolveQuantity({ quantity: 1 }, { ...reliance, lotSize: 0 }).quantity).toBeNull();
  });

  it("refuses indices, wrong products, off-tick prices and inverted stop-loss prices", () => {
    const codes = (req, inst, q = 10) => checkInstrumentOrder(req, inst, q).checks.map((c) => c.message);
    expect(codes(base, { ...reliance, kind: "INDEX", canonical: "NSE:NIFTY" })[0]).toMatch(/index/);
    expect(codes({ ...base, product: "CNC" }, niftyCe, 65)[0]).toMatch(/INTRADAY or MARGIN/);
    expect(codes({ ...base, product: "MARGIN" }, reliance)[0]).toMatch(/carry-forward/);
    expect(codes({ ...base, price: 1400.05 }, reliance)[0]).toMatch(/tick size 0.1/);
    expect(codes({ ...base, orderType: "SL", price: 1390, triggerPrice: 1395 }, reliance)[0]).toMatch(/at or above the trigger/);
    expect(codes({ ...base, side: "SELL", orderType: "SL", price: 1400, triggerPrice: 1395 }, reliance)[0]).toMatch(/at or below the trigger/);
    expect(codes(base, reliance)).toEqual([]);
  });

  it("refuses above the freeze quantity unless slicing is on, then slices in lot multiples", () => {
    const req = { ...base, product: "INTRADAY", price: 120.5 };
    const refused = checkInstrumentOrder(req, niftyCe, 1950);
    expect(blocking(refused.checks)[0].message).toMatch(/freeze quantity 1800/);
    const sliced = checkInstrumentOrder(req, niftyCe, 1950, { sliceAboveFreeze: true, maxSlices: 10 });
    expect(blocking(sliced.checks)).toEqual([]);
    expect(sliced.legs).toEqual([1755, 195]);
    expect(sliced.legs.every((q) => q % 65 === 0)).toBe(true);
    const tooMany = checkInstrumentOrder(req, niftyCe, 65 * 300, { sliceAboveFreeze: true, maxSlices: 5 });
    expect(blocking(tooMany.checks)[0].message).toMatch(/limit is 5/);
  });
});

describe("market-order policy", () => {
  const order = { side: "BUY", orderType: "MARKET" };
  it("reject refuses MARKET and SL-M", () => {
    const r = applyMarketPolicy(order, { policy: "reject", defaultPct: 2, nativeProtection: true, ltp: 100, tickSize: 0.05 });
    expect(r.checks[0]).toMatchObject({ code: "INVALID_ORDER", severity: "block" });
  });
  it("protect keeps MARKET with native protection and reports the percentage", () => {
    const r = applyMarketPolicy({ ...order, marketProtectionPct: 1.5 }, { policy: "protect", defaultPct: 2, nativeProtection: true, ltp: 100, tickSize: 0.05 });
    expect(r.order.orderType).toBe("MARKET");
    expect(r.marketProtectionPct).toBe(1.5);
  });
  it("protect converts to LIMIT at LTP ± pct, rounded inside the band", () => {
    const buy = applyMarketPolicy(order, { policy: "protect", defaultPct: 2, nativeProtection: false, ltp: 1402.3, tickSize: 0.1 });
    expect(buy.order).toMatchObject({ orderType: "LIMIT", price: 1430.3 });
    expect(buy.checks[0].message).toMatch(/converted to LIMIT at 1430.3/);
    const sell = applyMarketPolicy({ side: "SELL", orderType: "MARKET" }, { policy: "protect", defaultPct: 2, nativeProtection: false, ltp: 1402.3, tickSize: 0.1 });
    expect(sell.order.price).toBe(1374.3);
  });
  it("converts SL-M to SL from the trigger, and refuses MARKET with no price", () => {
    const slm = applyMarketPolicy({ side: "SELL", orderType: "SL-M", triggerPrice: 100 }, { policy: "protect", defaultPct: 2, nativeProtection: false, ltp: null, tickSize: 0.05 });
    expect(slm.order).toMatchObject({ orderType: "SL", price: 98, triggerPrice: 100 });
    const none = applyMarketPolicy(order, { policy: "protect", defaultPct: 2, nativeProtection: false, ltp: null, tickSize: 0.05 });
    expect(none.checks[0]).toMatchObject({ code: "INVALID_ORDER", severity: "block" });
  });
  it("leaves LIMIT orders alone", () => {
    expect(applyMarketPolicy({ side: "BUY", orderType: "LIMIT", price: 1 }, { policy: "reject", defaultPct: 2, nativeProtection: false, ltp: 1, tickSize: 0.05 }).checks).toEqual([]);
  });
});

describe("refusal order", () => {
  it("reports the kill switch first, then mode refusals, then the rest", () => {
    const sorted = sortByPriority([
      { code: "INVALID_ORDER", message: "a", severity: "block" },
      { code: "PAPER_ONLY", message: "b", severity: "block" },
      { code: "KILL_SWITCH_ACTIVE", message: "c", severity: "block" },
    ]);
    expect(sorted.map((c) => c.code)).toEqual(["KILL_SWITCH_ACTIVE", "PAPER_ONLY", "INVALID_ORDER"]);
  });
});
