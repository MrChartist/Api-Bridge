import { describe, expect, it } from "vitest";
import { createFakeMarketData } from "../market/fake.mjs";
import { integrate, lognormalGrid, MAX_CANDIDATES, optimize, optimizerRoutes } from "./optimizer.mjs";

const EXP = "2099-12-31";
const leg = (strike, right, spot, iv = 15) => {
  const intr = right === "CE" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  const ltp = Math.round((intr + 150 * Math.exp(-Math.abs(strike - spot) / 150)) * 100) / 100;
  return { symbol: `NFO:NIFTY-${EXP}-${strike}-${right}`, ltp, bid: ltp - 0.5, ask: ltp + 0.5, oi: 1, iv };
};
const chain = (spot = 25000) => ({
  underlyingLtp: spot, atmStrike: spot, lotSize: 75,
  rows: Array.from({ length: 31 }, (_, i) => 24250 + i * 50).map((k) => ({ strike: k, ce: leg(k, "CE", spot), pe: leg(k, "PE", spot) })),
});
const setup = () => {
  const md = createFakeMarketData({ prices: { "NSE:NIFTY": 25000 } });
  md.setChain("NIFTY", EXP, chain());
  const [[, , , h]] = optimizerRoutes({ marketData: md });
  const ctx = (q = "") => ({ query: new URLSearchParams(`underlying=NIFTY&expiry=${EXP}&${q}`), requestId: "r1", principal: { kind: "local" }, requireAccountAccess() {} });
  return { md, h, ctx };
};

describe("lognormal integration", () => {
  it("cell masses sum to one with the tails", () => {
    const g = lognormalGrid(25000, 15, 30);
    expect(g.cells.reduce((a, b) => a + b, g.lowTail + g.highTail)).toBeCloseTo(1, 6);
  });
  it("a flat payoff of +100 has PoP 1 and EV 100; the identity payoff has EV about zero", () => {
    const g = lognormalGrid(25000, 15, 30);
    const flat = Array.from({ length: 801 }, () => ({ pnl: 100 }));
    const r = integrate(flat, g);
    expect(r.pop).toBeCloseTo(1, 6);
    expect(r.ev).toBeCloseTo(100, 4);
    const lin = Array.from({ length: 801 }, (_, i) => ({ pnl: g.from + i * g.step - 25000 }));
    expect(Math.abs(integrate(lin, g).ev)).toBeLessThan(15); // zero drift, small grid error
  });
});

describe("optimizer", () => {
  it("declares its route", () => {
    const [[m, p, o]] = optimizerRoutes({ marketData: {} });
    expect([m, p, o]).toEqual(["GET", "/v1/analytics/optimizer", { scope: "read" }]);
  });

  it("returns ranked bullish strategies with rationale, within the candidate cap", async () => {
    const { h, ctx } = setup();
    const r = await h(ctx("view=bullish&top=3"));
    expect(r.data.results.length).toBe(3);
    expect(r.data.evaluated).toBeLessThanOrEqual(MAX_CANDIDATES);
    expect(r.data.results.map((x) => x.rank)).toEqual([1, 2, 3]);
    for (const x of r.data.results) {
      expect(x.rationale).toMatch(/chance of profit/);
      expect(x.probabilityOfProfitPct).toBeGreaterThanOrEqual(0);
      expect(x.probabilityOfProfitPct).toBeLessThanOrEqual(100);
    }
    expect(r.data.model).toMatch(/Lognormal/);
  });

  it("honours maxLoss (no unbounded risk, loss within budget) and minPop", async () => {
    const { h, ctx } = setup();
    const r = await h(ctx("view=neutral&maxLoss=20000&minPop=40&top=10"));
    expect(r.data.results.length).toBeGreaterThan(0);
    for (const x of r.data.results) {
      expect(x.unboundedRisk).toBe(false);
      expect(Math.abs(x.maxLoss)).toBeLessThanOrEqual(20000);
      expect(x.probabilityOfProfitPct).toBeGreaterThanOrEqual(40);
    }
  });

  it("sizes lots from capital", async () => {
    const { h, ctx } = setup();
    const r = await h(ctx("view=bearish&capital=500000&top=5"));
    for (const x of r.data.results) expect(x.capitalRequired).toBeLessThanOrEqual(500000);
    expect(r.data.results.some((x) => x.lots > 1)).toBe(true);
  });

  it("changes the ordering by objective and sorts descending", async () => {
    const { h, ctx } = setup();
    for (const obj of ["expectedValue", "popAdjusted", "riskReward"]) {
      const r = await h(ctx(`view=volatile&objective=${obj}&top=5`));
      const s = r.data.results.map((x) => x.score);
      expect([...s].sort((a, b) => b - a)).toEqual(s);
    }
  });

  it("long straddle break-evens bracket the spot and its PoP matches the closed form", () => {
    const c = chain();
    const r = optimize(c, { view: "volatile", days: 30, top: 20 });
    const st = r.results.find((x) => x.template === "long_straddle");
    expect(st.breakevens.length).toBe(2);
    expect(st.breakevens[0]).toBeLessThan(25000);
    expect(st.breakevens[1]).toBeGreaterThan(25000);
    // fake premiums total ~300, so break-evens sit ~1.2% away; sd over 30 days at 15% IV is ~4.3%: P(|move| > 1.2%) ~ 78%
    expect(st.probabilityOfProfitPct).toBeGreaterThan(74);
    expect(st.probabilityOfProfitPct).toBeLessThan(82);
  });

  it("validates parameters", async () => {
    const { h, ctx } = setup();
    for (const q of ["view=sideways", "view=bullish&objective=x", "view=bullish&top=0", "view=bullish&minPop=101", "view=bullish&maxLoss=-1", "view=bullish&capital=0"]) {
      await expect(h(ctx(q))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });

  it("only reads (the chain, the expiries for the month's future, and its quote)", async () => {
    const { md, h, ctx } = setup();
    await h(ctx("view=bullish"));
    expect(md.calls.every(([name]) => ["optionChain", "quotes", "expiries"].includes(name))).toBe(true);
  });
});
