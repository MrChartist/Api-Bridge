import { describe, expect, it } from "vitest";
import { rollBreakevens, rollItems, rollMargin, rollMoney, rollPlan, rollStrike, touch } from "./roll-core.js";

const NOW = Date.parse("2026-10-30T10:00:00+05:30");
const q = (strike, right, bid, ask, delta) => ({ symbol: `NFO:NIFTY-2026-11-10-${strike}-${right}`, bid, ask, ltp: (bid + ask) / 2, delta, iv: 13 });
// The 10 Nov chain: strikes every 50 from 25600 to 27000.
const rows = [];
for (let k = 25600; k <= 27000; k += 50) {
  const dc = Math.max(0.02, Math.min(0.98, 0.5 - (k - 26350) / 1400));
  const tv = 120 * Math.exp(-Math.abs(k - 26350) / 350);
  const c = Math.max(0, 26350 - k) + tv;
  const p = Math.max(0, k - 26350) + tv;
  rows.push({ strike: k, ce: q(k, "CE", c - 1, c + 1, dc), pe: q(k, "PE", p - 1, p + 1, dc - 1) });
}
const legs = [
  { symbol: "NFO:NIFTY-2026-11-03-26850-CE", kind: "OPT", strike: 26850, right: "CE", expiry: "2026-11-03", q: -65, lot: 65, avg: 105.8, mark: 60, quote: { bid: 59, ask: 61 }, F: 26300, iv: 12, T: 4 / 365, greeks: { delta: 0.18 }, product: "MARGIN", freeze: 1800, priced: true, inc: true, t0: NOW },
  { symbol: "NFO:NIFTY-2026-11-03-25750-PE", kind: "OPT", strike: 25750, right: "PE", expiry: "2026-11-03", q: -65, lot: 65, avg: 127, mark: 70, quote: { bid: 69, ask: 71 }, F: 26300, iv: 14, T: 4 / 365, greeks: { delta: -0.2 }, product: "MARGIN", freeze: 1800, priced: true, inc: true, t0: NOW },
];
const ctx = { mode: "same", toExpiry: "2026-11-10", rows, Fnow: 26300, Fnext: 26350, years: 11 / 365, underlying: "NIFTY", prefix: "NFO" };

describe("roll strikes", () => {
  it("same strike, nearest listed when missing", () => {
    expect(rollStrike(legs[0], "same", ctx)).toBe(26850);
    expect(rollStrike({ ...legs[0], strike: 26860 }, "same", ctx)).toBe(26850);
  });
  it("same delta picks the strike whose delta is nearest", () => {
    const k = rollStrike(legs[0], "delta", ctx);
    const d = rows.find((r) => r.strike === k).ce.delta;
    for (const r of rows) expect(Math.abs(d - 0.18)).toBeLessThanOrEqual(Math.abs(r.ce.delta - 0.18) + 1e-12);
    expect(rollStrike(legs[1], "delta", ctx)).toBeLessThan(26350);
  });
  it("same distance keeps the points from the forward", () => {
    // F moves 26300 → 26350: the 26850 call becomes the 26900 call.
    expect(rollStrike(legs[0], "distance", ctx)).toBe(26900);
    expect(rollStrike(legs[1], "distance", ctx)).toBe(25800);
  });
  it("the touch: buys pay the ask, sells get the bid", () => {
    expect(touch({ bid: 10, ask: 11 }, "BUY")).toBe(11);
    expect(touch({ bid: 10, ask: 11 }, "SELL")).toBe(10);
    expect(touch({ ltp: 9 }, "SELL")).toBe(9);
    expect(touch(null, "BUY", 7)).toBe(7);
  });
});

describe("roll plan and money", () => {
  const plan = rollPlan(legs, ctx);
  it("closes each short at the ask and sells the new one at the bid", () => {
    expect(plan.rolls).toHaveLength(2);
    expect(plan.rolls[0].close).toEqual({ side: "BUY", price: 61 });
    expect(plan.rolls[0].open).toMatchObject({ side: "SELL", strike: 26850, expiry: "2026-11-10", symbol: "NFO:NIFTY-2026-11-10-26850-CE" });
    expect(plan.rolls[0].lots).toBe(1);
  });
  it("skips futures with a reason", () => {
    const p = rollPlan([...legs, { symbol: "NFO:NIFTY-2026-11-24-FUT", kind: "FUT", q: 65, lot: 65 }], ctx);
    expect(p.skipped).toHaveLength(1);
  });
  it("nets the credit before and after charges", () => {
    const m = rollMoney(plan, undefined);
    const expected = (-61 + plan.rolls[0].open.price - 71 + plan.rolls[1].open.price) * 65;
    expect(m.net).toBeCloseTo(expected, 6);
    expect(m.charges).toBeGreaterThan(0);
    expect(m.netAfter).toBeCloseTo(m.net - m.charges, 6);
    expect(m.missing).toBe(0);
  });
  it("breakevens bracket the new strikes and count the P&L the old legs locked in", () => {
    const be = rollBreakevens(plan, { spot: 26300 });
    expect(be).toHaveLength(2);
    expect(be[0]).toBeLessThan(25750);
    expect(be[1]).toBeGreaterThan(26850);
    // Less locked-in profit narrows the range.
    const worse = rollBreakevens({ rolls: plan.rolls.map((r) => ({ ...r, leg: { ...r.leg, avg: r.close.price - 15 } })) }, { spot: 26300 });
    expect(worse[1] - worse[0]).toBeLessThan(be[1] - be[0]);
  });
  it("margin before and after on the paper model", () => {
    const m = rollMargin(legs, plan, { underlying: "NIFTY", nowMs: NOW, Fnow: 26300, Fnext: 26350 });
    expect(m.before).toBeGreaterThan(50_000);
    expect(m.after).toBeGreaterThan(50_000);
    expect(m.change).toBeCloseTo(m.after - m.before, 6);
    expect(rollMargin(legs, plan, { underlying: "NIFTY", nowMs: NOW, Fnow: null })).toBeNull();
  });
  it("sends a close and an open order per roll", () => {
    const items = rollItems(plan, { label: (x) => `${x.strike} ${x.right}${x.close ? " close" : ""}` });
    expect(items.map((i) => [i.side, i.label, i.lots])).toEqual([
      ["BUY", "26850 CE close", 1],
      ["SELL", "26850 CE", 1],
      ["BUY", "25750 PE close", 1],
      ["SELL", "25750 PE", 1],
    ]);
    // The order sheet labels the closing orders "close", not "short leg" or "buy first".
    expect(items.map((i) => Boolean(i.closing))).toEqual([true, false, true, false]);
  });
});
