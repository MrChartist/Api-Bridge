import { describe, expect, it } from "vitest";
import { DASH } from "./format.js";
import * as O from "./options.js";
import { accountOverview, attentionItems, legShort, marginUse, moneyShort, riskGrid, riskParts, riskRead } from "./positions-core.js";

// 31 Oct 2026, 12:00 IST.
const NOW = Date.UTC(2026, 9, 31, 6, 30);
const leg = (o) => ({ kind: "OPT", q: -65, lot: 65, avg: 50, mark: 50, F: 25000, iv: 12, atmIv: 12, T: 3 / 365, priced: true, inc: true, ...o });

describe("moneyShort / legShort", () => {
  it("signs compact rupees with a true minus and keeps a dash for no figure", () => {
    expect(moneyShort(9700)).toBe("+₹9.7K");
    expect(moneyShort(-142000)).toBe("−₹1.42L");
    expect(moneyShort(0.2)).toBe("₹0");
    expect(moneyShort(null)).toBe(DASH);
  });
  it("names a leg by strike and side, futures as FUT", () => {
    expect(legShort({ kind: "OPT", strike: 24500, right: "PE" })).toBe("24500 PE");
    expect(legShort({ kind: "FUT" })).toBe("FUT");
  });
});

describe("marginUse", () => {
  it("reads used of used + available, with the colour level of the rounded share", () => {
    const m = marginUse({ usedMargin: 250000, availableCash: 2250000 });
    expect(m.used).toBe(250000);
    expect(m.total).toBe(2500000);
    expect(m.util).toBeCloseTo(0.1);
    expect(m.level).toBe("ok");
    expect(marginUse({ usedMargin: 70, availableCash: 30 }).level).toBe("warn");
    expect(marginUse({ usedMargin: 89.6, availableCash: 10.4 }).level).toBe("neg");
  });
  it("falls back to the total balance, and is empty without funds", () => {
    expect(marginUse({ usedMargin: 10, totalBalance: 100 }).total).toBe(100);
    expect(marginUse(null)).toEqual({ used: null, total: null, free: null, util: null, level: "none" });
    expect(marginUse({ usedMargin: 0, availableCash: 0 }).level).toBe("none");
  });
});

describe("accountOverview", () => {
  const rows = [
    { symbol: "NFO:NIFTY-2026-11-03-25500-CE", netQty: -65, pnl: -71.5 },
    { symbol: "NFO:NIFTY-2026-11-03-24500-PE", netQty: -65, pnl: 52 },
    { symbol: "NFO:BANKNIFTY-2026-11-23-58200-CE", netQty: 0, realisedPnl: 400, unrealisedPnl: 0 },
    { symbol: "NFO:BANKNIFTY-2026-11-23-59400-CE", netQty: -30, pnl: 205.5 },
    { symbol: "NSE:RELIANCE", netQty: 10 },
  ];
  it("totals every position's P&L (realised + unrealised when no pnl) and counts the ones without a figure", () => {
    const o = accountOverview(rows, { funds: { usedMargin: 100, availableCash: 900 }, dayTotal: -12 });
    expect(o.total).toBeCloseTo(-71.5 + 52 + 400 + 205.5);
    expect(o.missing).toBe(1);
    expect(o.open).toBe(4);
    expect(o.day).toBe(-12);
    expect(o.margin.util).toBeCloseTo(0.1);
    expect(o.underlyings.map((u) => u.underlying)).toEqual(["BANKNIFTY", "NIFTY"]);
    expect(o.underlyings.find((u) => u.underlying === "NIFTY")).toMatchObject({ legs: 2 });
  });
  it("keeps the current underlying in the rail and never invents a zero", () => {
    const o = accountOverview([], { current: "FINNIFTY" });
    expect(o.total).toBeNull();
    expect(o.day).toBeNull();
    expect(o.underlyings).toEqual([{ underlying: "FINNIFTY", legs: 0, pnl: null }]);
  });
});

describe("attentionItems", () => {
  it("puts an ITM short first, then a tested short, the near expiry (calendar days) and the biggest loser", () => {
    const legs = [
      leg({ symbol: "A", strike: 24800, right: "CE", expiry: "2026-11-03", mark: 260 }), // F 25000 > 24800: ITM short call
      leg({ symbol: "B", strike: 24950, right: "PE", expiry: "2026-11-03", mark: 40 }), // 50 pts: tested
      leg({ symbol: "C", strike: 26000, right: "CE", expiry: "2026-11-24", q: 65, avg: 10, mark: 12, T: 24 / 365 }),
    ];
    const { items, more } = attentionItems(legs, { now: NOW, limit: 10 });
    expect(items.map((i) => i.kind)).toEqual(["itm", "tested", "expiry", "loser"]);
    expect(items[0]).toMatchObject({ level: "bad", symbols: ["A"], text: "24800 CE 3 Nov" });
    expect(items.find((i) => i.kind === "expiry")).toMatchObject({ symbols: ["A", "B"], level: "warn" });
    expect(items.find((i) => i.kind === "loser")).toMatchObject({ symbols: ["A"], name: "24800 CE" });
    expect(items.find((i) => i.kind === "loser").value).toBeCloseTo((50 - 260) * 65);
    expect(more).toBe(0);
  });
  it("marks an expiry on its own day as bad and caps the list", () => {
    const legs = [leg({ symbol: "X", strike: 26000, right: "CE", expiry: "2026-10-31" }), leg({ symbol: "Y", strike: 24000, right: "PE", expiry: "2026-10-31" })];
    const r = attentionItems(legs, { now: NOW, limit: 1 });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ kind: "expiry", level: "bad", label: "Expires today" });
  });
  it("is quiet for a calm book: far expiry, shorts out of the money, one leg only", () => {
    expect(attentionItems([leg({ symbol: "Z", strike: 27000, right: "CE", expiry: "2026-11-24", mark: 80, T: 24 / 365 })], { now: NOW }).items).toEqual([]);
    expect(attentionItems([], { now: NOW })).toEqual({ items: [], more: 0 });
  });
  it("ignores closed and unpriced legs", () => {
    const legs = [leg({ symbol: "A", strike: 24800, right: "CE", expiry: "2026-11-24", q: 0 }), leg({ symbol: "B", strike: 24800, right: "CE", expiry: "2026-11-24", priced: false })];
    expect(attentionItems(legs, { now: NOW }).items).toEqual([]);
  });
});

describe("riskRead / riskParts", () => {
  it("reads a defined-risk curve: max loss, max profit and the breakevens", () => {
    // An iron-condor-like expiry curve: −500 below 90, +300 between 95 and 105, −500 above 110.
    const f = (x) => (x < 90 ? -500 : x < 95 ? -500 + (x - 90) * 160 : x <= 105 ? 300 : x < 110 ? 300 - (x - 105) * 160 : -500);
    const xs = riskGrid(100, 0.05, [90, 95, 105, 110]);
    const r = riskRead(O.bookCurveStats(f, xs));
    expect(r.maxLoss).toBe(-500);
    expect(r.maxProfit).toBe(300);
    expect(r.lossUnlimited).toBe(false);
    expect(r.breakevens).toEqual([93, 107]);
    expect(riskParts(r)).toEqual(["Max loss −₹500", "Max profit +₹300", "BE 93 · 107"]);
  });
  it("calls an open side Unlimited and a one-signed curve no loss", () => {
    const strangle = (x) => 300 - Math.max(0, x - 105) * 100 - Math.max(0, 95 - x) * 100;
    const r = riskRead(O.bookCurveStats(strangle, riskGrid(100, 0.05, [95, 105])));
    expect(r.lossUnlimited).toBe(true);
    expect(r.maxLoss).toBeNull();
    expect(riskParts(r)[0]).toBe("Max loss Unlimited");
    const longCall = (x) => Math.max(0, x - 100) * 10 + 1;
    const l = riskRead(O.bookCurveStats(longCall, riskGrid(100, 0.05, [100])));
    expect(l.maxLoss).toBe(0);
    expect(l.profitUnlimited).toBe(true);
    expect(riskRead(null)).toBeNull();
    expect(riskParts(null)).toEqual([]);
  });
});

describe("riskGrid", () => {
  it("spans F·e^(±4σ), widened past the outer strikes, with the strikes inside, sorted", () => {
    const xs = riskGrid(100, 0.05, [101.3]);
    expect(xs[0]).toBeCloseTo(100 * Math.exp(-0.2));
    expect(xs[xs.length - 1]).toBeCloseTo(100 * Math.exp(0.2));
    expect(xs).toContain(101.3);
    const wide = riskGrid(100, 0.05, [80, 150]);
    expect(wide[0]).toBeCloseTo(73.6);
    expect(wide[wide.length - 1]).toBeCloseTo(162);
    expect(wide).toContain(150);
    expect([...wide].sort((a, b) => a - b)).toEqual(wide);
    expect(riskGrid(0, 0.05)).toEqual([]);
  });
  it("reads a far-winged condor as defined risk, not Unlimited", () => {
    const f = (x) => 200 - Math.max(0, x - 105) * 10 + Math.max(0, x - 140) * 10 - Math.max(0, 95 - x) * 10 + Math.max(0, 60 - x) * 10;
    const r = riskRead(O.bookCurveStats(f, riskGrid(100, 0.02, [60, 95, 105, 140])));
    expect(r.lossUnlimited).toBe(false);
    expect(r.maxLoss).toBeCloseTo(-150);
  });
});
