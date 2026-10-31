/**
 * Chains from quotes and the ΔOI basis (docs/spec/p1-06-stocks.md §6.10, §6.11, §9.1).
 */
import { describe, expect, it } from "vitest";
import { rowsFromQuotes } from "../market/chain.mjs";
import { chainFromQuotes, oiChangeOf, strikeWindow, withBrokerBasis } from "./quotesChain.mjs";

const NOW = Date.parse("2026-11-19T10:02:41+05:30");
const strikes = Array.from({ length: 61 }, (_, i) => 1060 + i * 20); // 1060 … 2260
const legs = (ks) => ks.flatMap((k) => ["CE", "PE"].map((right) => ({ canonical: `NFO:RELIANCE-2026-11-23-${k}-${right}`, strike: k, right })));

describe("strike window (§6.10)", () => {
  it("spot 1,452.30, step 20: ATM 1460, ±15 → 1160–1760 (31 strikes)", () => {
    const w = strikeWindow(strikes, 1452.3, 15);
    expect(w).toHaveLength(31);
    expect([w[0], w[15], w[30]]).toEqual([1160, 1460, 1760]);
  });
  it("lower strike on a tie; never invents strikes beyond the listed ones", () => {
    expect(strikeWindow([100, 110, 120], 105, 1)).toEqual([100, 110]);
    expect(strikeWindow([100, 110, 120], 119, 5)).toEqual([100, 110, 120]);
  });
});

describe("ΔOI basis (§6.11)", () => {
  it("recorder: 13,02,500 − 12,45,000 = +57,500", () => {
    expect(oiChangeOf({ oi: 1302500, recorderPrev: 1245000, dayBase: ["09:21", 1250000] })).toEqual({ oiChange: 57500, oiChangeBasis: "recorder" });
  });
  it("day baseline: 13,02,500 − 12,50,000 = +52,500 since 09:21", () => {
    expect(oiChangeOf({ oi: 1302500, dayBase: ["09:21", 1250000] })).toEqual({ oiChange: 52500, oiChangeBasis: "day-baseline", since: "09:21" });
  });
  it("broker first; nothing → null", () => {
    expect(oiChangeOf({ oi: 10, brokerChange: 5, recorderPrev: 1 })).toEqual({ oiChange: 5, oiChangeBasis: "broker" });
    expect(oiChangeOf({ oi: 10 })).toEqual({ oiChange: null, oiChangeBasis: null });
    expect(oiChangeOf({ oi: null, dayBase: ["09:21", 1] })).toEqual({ oiChange: null, oiChangeBasis: null });
  });
});

describe("chainFromQuotes", () => {
  const ks = strikeWindow(strikes, 1452.3, 15);
  const quotes = new Map(legs(ks).map((l) => [l.canonical, { symbol: l.canonical, ltp: Math.max(0.5, l.right === "CE" ? 1452.3 - l.strike + 20 : l.strike - 1452.3 + 20), bid: 1, ask: 2, oi: 1302500, volume: 412500, close: null, change: null }]));
  it("matches rowsFromQuotes' shape and adds the basis per leg", () => {
    const dayBase = { "NFO:RELIANCE-2026-11-23-1420-CE": ["09:21", 1250000] };
    const recorderPrev = new Map([["NFO:RELIANCE-2026-11-23-1440-CE", 1245000]]);
    const c = chainFromQuotes({ legs: legs(ks), quotes, spot: 1452.3, expiry: "2026-11-23", underlying: "RELIANCE", lotSize: 500, tickSize: 0.05, strikeStep: 20, nowMs: NOW, rate: 0.065, dayBase, recorderPrev });
    const plain = rowsFromQuotes(legs(ks), quotes, { spot: 1452.3, expiry: "2026-11-23", greeks: true, nowMs: NOW, rate: 0.065 });
    expect(c.rows.map((r) => r.strike)).toEqual(plain.rows.map((r) => r.strike));
    expect(c.atmStrike).toBe(1460);
    expect(c).toMatchObject({ underlyingKind: "stock", settlement: "physical", lotSize: 500, strikeStep: 20, oiChangeSince: "09:21" });
    const row = (k) => c.rows.find((r) => r.strike === k);
    expect(row(1420).ce).toMatchObject({ oiChange: 52500, oiChangeBasis: "day-baseline" });
    expect(row(1440).ce).toMatchObject({ oiChange: 57500, oiChangeBasis: "recorder" });
    expect(row(1460).ce).toMatchObject({ oiChange: null, oiChangeBasis: null });
    // Greeks come through the same seam as /v1/optionchain
    expect(row(1460).ce.greeksSource).toBe(plain.rows.find((r) => r.strike === 1460).ce.greeksSource);
    expect(row(1460).ce.delta).toBe(plain.rows.find((r) => r.strike === 1460).ce.delta);
  });
  it("broker chains keep the broker's own change", () => {
    const c = withBrokerBasis({ rows: [{ strike: 1, ce: { symbol: "a", oi: 10, oiChange: 3 }, pe: { symbol: "b", oi: 10, oiChange: null } }] }, { dayBase: { b: ["09:15", 4] } });
    expect(c.rows[0].ce.oiChangeBasis).toBe("broker");
    expect(c.rows[0].pe).toMatchObject({ oiChange: 6, oiChangeBasis: "day-baseline" });
  });
});
