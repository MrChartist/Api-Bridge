import { describe, expect, it } from "vitest";
import { canonicaliseOrderInput } from "./aliases.mjs";
import { createRequestRecords } from "./requestRecords.mjs";
import { parseOrderChanges, parseOrderRequest } from "./orderValidation.mjs";

const base = { account: "paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "LIMIT", price: 1400 };

describe("canonicaliseOrderInput", () => {
  it.each([
    ["MIS", "INTRADAY"],
    ["mis", "INTRADAY"],
    [" Mis ", "INTRADAY"],
    ["NRML", "MARGIN"],
    ["carryforward", "MARGIN"],
    ["DELIVERY", "CNC"],
  ])("product %s is %s", (from, to) => {
    const r = canonicaliseOrderInput({ ...base, product: from });
    expect(r.input.product).toBe(to);
    expect(r.notes).toEqual([{ field: "product", from, to }]);
  });

  it("canonical words and unknown words are left alone, and the same object comes back when nothing changed", () => {
    for (const product of ["CNC", "INTRADAY", "MARGIN", "MTF"]) {
      const r = canonicaliseOrderInput({ ...base, product });
      expect(r.notes).toEqual([]);
    }
    const body = { ...base };
    expect(canonicaliseOrderInput(body).input).toBe(body);
    const odd = canonicaliseOrderInput({ ...base, product: "COVER", orderType: "ICEBERG", side: "HOLD" });
    expect(odd.input).toMatchObject({ product: "COVER", orderType: "ICEBERG", side: "HOLD" });
    expect(odd.notes).toEqual([]);
  });

  it("never touches mode, quantities or other fields, and never mutates its input", () => {
    const body = { ...base, product: "MIS", mode: "LIVE", quantity: "5" };
    const copy = structuredClone(body);
    const r = canonicaliseOrderInput(body);
    expect(body).toEqual(copy);
    expect(r.input.mode).toBe("LIVE");
    expect(r.input.quantity).toBe("5");
  });

  it("is safe with inputs that are not objects or have odd values", () => {
    for (const v of [null, undefined, 5, "x", [], [1, 2]]) expect(canonicaliseOrderInput(v).input).toBe(v);
    expect(canonicaliseOrderInput({ product: 5, orderType: {}, side: null }).notes).toEqual([]);
    expect(canonicaliseOrderInput({ product: "x".repeat(10000) }).notes).toEqual([]);
    expect(canonicaliseOrderInput({ product: "__proto__", orderType: "constructor" }).notes).toEqual([]);
  });

  it.each([
    ["MKT", "MARKET"],
    ["slm", "SL-M"],
    ["SL_M", "SL-M"],
    ["stop_loss", "SL"],
    ["limit", "LIMIT"],
  ])("order type %s is %s", (from, to) => {
    expect(canonicaliseOrderInput({ orderType: from }).input.orderType).toBe(to);
  });
});

describe("the order schemas read the words", () => {
  it("parseOrderRequest accepts MIS and lower-case words and returns the canonical request", () => {
    const r = parseOrderRequest({ ...base, product: "mis", side: "sell", orderType: "limit" });
    expect(r).toMatchObject({ product: "INTRADAY", side: "SELL", orderType: "LIMIT" });
  });

  it("an alias and the canonical word give the same request (so the same fingerprint)", () => {
    expect(parseOrderRequest({ ...base, product: "NRML" })).toEqual(parseOrderRequest({ ...base, product: "MARGIN" }));
  });

  it("a modify may use the order-type words", () => {
    expect(parseOrderChanges({ orderType: "slm", triggerPrice: 10 })).toMatchObject({ orderType: "SL-M" });
  });

  it("an unknown word is still VALIDATION_FAILED", () => {
    expect(() => parseOrderRequest({ ...base, product: "COVER" })).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
});

describe("request records", () => {
  it("run once, replay the answer, refuse another body, and release on failure", () => {
    let t = 1000;
    const r = createRequestRecords({ now: () => t });
    expect(r.begin("k1", "fp1")).toEqual({ replay: false });
    expect(() => r.begin("k1", "fp1")).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_IN_PROGRESS" }));
    r.complete("k1", { a: 1 });
    expect(r.begin("k1", "fp1")).toEqual({ replay: true, result: { a: 1 } });
    expect(() => r.begin("k1", "fp2")).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }));
    expect(() => r.begin("k1", "fp2", { reuseCode: "DUPLICATE_CLIENT_ORDER_ID" })).toThrow(expect.objectContaining({ code: "DUPLICATE_CLIENT_ORDER_ID" }));
    r.release("k1");
    expect(r.begin("k1", "fp2")).toEqual({ replay: false });
    t += 25 * 60 * 60_000; // after 24 hours the record is gone
    expect(r.begin("k1", "fp3")).toEqual({ replay: false });
  });

  it("the replayed answer is a copy", () => {
    const r = createRequestRecords({ now: () => 1 });
    r.begin("k", "f");
    r.complete("k", { list: [1] });
    r.begin("k", "f").result.list.push(2);
    expect(r.begin("k", "f").result.list).toEqual([1]);
  });

  it("is bounded", () => {
    const r = createRequestRecords({ now: () => 1 });
    for (let i = 0; i < 6000; i += 1) r.begin(`k${i}`, "f");
    expect(r.size()).toBeLessThanOrEqual(5000);
  });
});
