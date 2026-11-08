import { describe, expect, it } from "vitest";
import { validateResult } from "./results.mjs";

const NOW = Date.parse("2026-10-19T10:00:00+05:30");
const AT = NOW - 900_000;
const check = (method, data, now = NOW) => validateResult(method, data, now);
const rejects = (method, data, re) => {
  const r = check(method, data);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(re);
};

describe("quotes", () => {
  const q = (over = {}, fields = {}) => ({ items: [{ symbol: "NSE:RELIANCE", at: AT, fields: { ltp: 100, ...fields }, ...over }] });

  it("accepts and normalises, dropping unknown keys", () => {
    const r = check("quotes", q({ extra: 1 }, { open: 99, secret: "x" }));
    expect(r.ok).toBe(true);
    expect(r.value.items[0]).toEqual({ symbol: "NSE:RELIANCE", at: AT, fields: { ltp: 100, open: 99, high: null, low: null, close: null, volume: null, oi: null, bid: null, ask: null, bidQty: null, askQty: null } });
  });

  it("rejects non-positive, non-finite and non-numeric prices (hostile payloads)", () => {
    for (const ltp of [0, -1, "100", null, NaN, Infinity, "Infinity", "NaN", {}, [1]]) rejects("quotes", q({}, { ltp }), /ltp|items/);
    rejects("quotes", q({}, { volume: "5" }), /volume/);
    rejects("quotes", q({}, { volume: -1 }), /volume/);
  });

  it("rejects a timestamp from the future, or missing", () => {
    rejects("quotes", q({ at: NOW + 60_000 }), /future/);
    rejects("quotes", q({ at: undefined }), /at/);
    rejects("quotes", q({ at: "2026-10-19" }), /at/);
    expect(check("quotes", q({ at: NOW + 4_000 })).ok).toBe(true);
  });

  it("drops a crossed book instead of passing it on", () => {
    expect(check("quotes", q({}, { bid: 101, ask: 100 })).value.items[0].fields).toMatchObject({ bid: null, ask: null });
    expect(check("quotes", q({}, { bid: 99, ask: 100 })).value.items[0].fields).toMatchObject({ bid: 99, ask: 100 });
  });

  it("rejects bad symbols and too many items", () => {
    rejects("quotes", q({ symbol: "" }), /symbol/);
    rejects("quotes", q({ symbol: "a b" }), /symbol/);
    rejects("quotes", q({ symbol: "x".repeat(80) }), /symbol/);
    rejects("quotes", { items: Array(201).fill(q().items[0]) }, /items/);
    rejects("quotes", { items: "x" }, /items/);
    rejects("quotes", null, /shape/);
  });
});

describe("history", () => {
  const c = (time, over = {}) => ({ time, open: 10, high: 12, low: 9, close: 11, volume: 5, ...over });
  const h = (candles, over = {}) => ({ candles, at: AT, ...over });

  it("accepts ascending candles and defaults volume", () => {
    const r = check("history", h([c(1000), c(2000, { volume: undefined })]));
    expect(r.ok).toBe(true);
    expect(r.value.candles[1].volume).toBe(0);
  });

  it("rejects out-of-order or duplicate times, bad prices and high below low", () => {
    rejects("history", h([c(2000), c(1000)]), /ascend/);
    rejects("history", h([c(1000), c(1000)]), /ascend/);
    rejects("history", h([c(1000, { close: 0 })]), /close/);
    rejects("history", h([c(1000, { high: 5, low: 9 })]), /high is below low/);
    rejects("history", h([c(1.5)]), /time/);
    rejects("history", h([c(1000, { open: "10" })]), /open/);
  });
});

describe("expiries and optionChain", () => {
  it("expiries must be ISO calendar dates", () => {
    expect(check("expiries", { expiries: ["2026-10-29", "2026-11-26"], at: AT }).ok).toBe(true);
    rejects("expiries", { expiries: ["29-10-2026"], at: AT }, /expiries/);
    rejects("expiries", { expiries: ["2026-13-40"], at: AT }, /expiries/);
  });

  it("an option chain keeps only known leg fields and null legs", () => {
    const r = check("optionChain", { underlyingLtp: 24500, rows: [{ strike: 24500, ce: { ltp: 110, iv: 14.2, delta: 0.5, junk: 1 }, pe: null }, { strike: 24600 }], at: AT });
    expect(r.ok).toBe(true);
    expect(r.value.rows[0].ce).toMatchObject({ ltp: 110, iv: 14.2, delta: 0.5, bid: null });
    expect(r.value.rows[0].ce.junk).toBeUndefined();
    expect(r.value.rows[1]).toEqual({ strike: 24600, ce: null, pe: null });
    rejects("optionChain", { underlyingLtp: 0, rows: [], at: AT }, /underlyingLtp/);
    rejects("optionChain", { underlyingLtp: 1, rows: [{ strike: -5 }], at: AT }, /strike/);
  });
});

describe("test and unknown methods", () => {
  it("test answers are small", () => {
    expect(check("test", { ok: true, detail: "fine" }).ok).toBe(true);
    rejects("test", { ok: "yes" }, /ok/);
    rejects("test", { ok: true, detail: "x".repeat(300) }, /detail/);
  });
  it("refuses a method it does not know", () => {
    expect(check("placeOrder", {}).ok).toBe(false);
  });
});
