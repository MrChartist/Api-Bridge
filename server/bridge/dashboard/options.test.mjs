/** Option Desk maths (options.js): chain reads, pricing and strategy payoffs. */
import { describe, expect, it } from "vitest";
import * as A from "./options.js";
import { REF_DEFAULTS, refCharges } from "./reference.js";

/** The reference values the pages pass in (reference.js fallback: the same figures the demo Bridge serves). */
const RATES = refCharges(null);
const RISK = REF_DEFAULTS.rate.value;
import {
  atmRow,
  black76,
  buildup,
  chainSummary,
  changePct,
  deltaTargets,
  forwardPrice,
  inTheMoney,
  liquidityScore,
  maxPain,
  mid,
  netGreeks,
  netPremium,
  normCdf,
  oiChangePct,
  parseOptionSymbol,
  payoffAt,
  positionsFor,
  presetLegs,
  probItm,
  roundToTick,
  rowsAroundAtm,
  sigmaMove,
  spreadPct,
  strategyStats,
  timeToExpiry,
  touchPrice,
  valueAt,
  volumeRanks,
} from "./options.js";
import * as O from "./options.js";

const leg = (o) => ({ symbol: "X", ltp: 100, bid: 99.9, ask: 100.1, oi: 1000, oiChange: 100, volume: 500, iv: 12, ...o });
const chain = {
  underlying: "NIFTY",
  expiry: "2026-11-03",
  underlyingLtp: 26010,
  atmStrike: 26000,
  lotSize: 75,
  rows: [
    { strike: 25900, ce: leg({ ltp: 180, bid: 179.9, ask: 180.1, oi: 500, volume: 100 }), pe: leg({ ltp: 70, bid: 69.9, ask: 70.1, oi: 4000, volume: 300 }) },
    { strike: 25950, ce: leg({ ltp: 140, bid: 139.9, ask: 140.1, oi: 800, volume: 200 }), pe: leg({ ltp: 80, bid: 79.9, ask: 80.1, oi: 2000, volume: 400 }) },
    { strike: 26000, ce: leg({ ltp: 110, bid: 109.9, ask: 110.1, oi: 3000, volume: 900 }), pe: leg({ ltp: 100, bid: 99.9, ask: 100.1, oi: 3000, volume: 900 }) },
    { strike: 26050, ce: leg({ ltp: 85, bid: 84.9, ask: 85.1, oi: 2500, volume: 500 }), pe: leg({ ltp: 125, bid: 124.9, ask: 125.1, oi: 900, volume: 200 }) },
    { strike: 26100, ce: leg({ ltp: 60, bid: 59.9, ask: 60.1, oi: 6000, volume: 300 }), pe: leg({ ltp: 150, bid: 149.9, ask: 150.1, oi: 300, volume: 50 }) },
  ],
};

describe("chain summary", () => {
  it("finds ATM, PCR, OI walls, max pain and the straddle", () => {
    const s = chainSummary(chain);
    expect(atmRow(chain).strike).toBe(26000);
    expect(s.atm).toBe(26000);
    expect(s.straddle).toBe(210);
    expect(s.upper).toBe(26210);
    expect(s.lower).toBe(25790);
    expect(s.ceOi).toBe(12800);
    expect(s.peOi).toBe(10200);
    expect(s.pcr).toBeCloseTo(10200 / 12800, 10);
    expect(s.resistance).toEqual({ strike: 26100, oi: 6000 });
    expect(s.support).toEqual({ strike: 25900, oi: 4000 });
    expect(s.maxOi).toBe(6000);
    expect(s.atmIv).toBe(12);
  });

  it("max pain is the settlement that pays option buyers least", () => {
    // All OI at one strike on both sides: settling there pays nobody.
    const rows = [25900, 26000, 26100].map((k) => ({ strike: k, ce: { oi: k === 26000 ? 100 : 0 }, pe: { oi: k === 26000 ? 100 : 0 } }));
    expect(maxPain(rows)).toBe(26000);
    expect(maxPain([])).toBeNull();
  });

  it("windows strikes around ATM and marks ITM by side", () => {
    expect(rowsAroundAtm(chain, 1).map((r) => r.strike)).toEqual([25950, 26000, 26050]);
    expect(rowsAroundAtm(chain, 10)).toHaveLength(5);
    expect(inTheMoney(25950, "ce", 26010)).toBe(true);
    expect(inTheMoney(25950, "pe", 26010)).toBe(false);
    expect(inTheMoney(26050, "pe", 26010)).toBe(true);
    expect(inTheMoney(26050, "ce", null)).toBe(false);
  });

  it("reads the forward from put-call parity", () => {
    // K + C - P at 26000 = 26010; at 25950 = 26010; at 26050 = 26010.
    expect(forwardPrice(chain)).toBeCloseTo(26010, 6);
    expect(forwardPrice({ underlyingLtp: 100, rows: [] })).toBe(100);
  });
});

describe("per-leg reads", () => {
  it("classifies OI build-up", () => {
    expect(buildup({ change: 5, oiChange: 10 })).toBe("LB");
    expect(buildup({ change: -5, oiChange: 10 })).toBe("SB");
    expect(buildup({ change: 5, oiChange: -10 })).toBe("SC");
    expect(buildup({ change: -5, oiChange: -10 })).toBe("LU");
    expect(buildup({ change: null, oiChange: 10 })).toBeNull();
    expect(buildup({ change: 0, oiChange: 10 })).toBeNull();
  });

  it("mid, spread, OI change % and price change %", () => {
    expect(mid({ bid: 10, ask: 12 })).toBe(11);
    expect(mid({ bid: 0, ask: 12, ltp: 9 })).toBe(9);
    expect(spreadPct({ bid: 99, ask: 101 })).toBeCloseTo(2, 10);
    expect(spreadPct({ bid: null, ask: 101 })).toBeNull();
    expect(oiChangePct({ oi: 120, oiChange: 20 })).toBeCloseTo(20, 10);
    expect(oiChangePct({ oi: 20, oiChange: 20 })).toBeNull();
    expect(changePct({ close: 200, change: -50 })).toBe(-25);
  });

  it("scores liquidity from spread and volume rank", () => {
    expect(liquidityScore({ bid: 99.95, ask: 100.05, volume: 10 }, 1)).toBe(5);
    expect(liquidityScore({ bid: 80, ask: 120, volume: 10 }, 0)).toBe(1);
    expect(liquidityScore({}, 0)).toBe(0);
    const ranks = volumeRanks(chain.rows, "ce");
    expect(ranks.get(25900)).toBe(0);
    expect(ranks.get(26000)).toBe(1);
  });

  it("finds the 16 and 30 delta strikes", () => {
    const rows = [0.62, 0.45, 0.31, 0.17, 0.05].map((d, i) => ({ strike: 100 + i, ce: { delta: d }, pe: { delta: d - 1 } }));
    const t = deltaTargets(rows);
    expect(t.ce.get(103)).toBe("16Δ");
    expect(t.ce.get(102)).toBe("30Δ");
    expect(t.pe.size).toBe(0);
  });
});

describe("pricing", () => {
  it("normal CDF", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 3);
  });

  it("Black-76: ATM price, parity, intrinsic at expiry", () => {
    const T = 30 / 365;
    const c = black76(26000, 26000, T, 12, "CE");
    const p = black76(26000, 26000, T, 12, "PE");
    // ATM ≈ 0.4 · F · σ · √T
    expect(c).toBeCloseTo(0.3989 * 26000 * 0.12 * Math.sqrt(T), 0);
    expect(c - p).toBeCloseTo(0, 6);
    expect(black76(26100, 26000, T, 12, "CE") - black76(26100, 26000, T, 12, "PE")).toBeCloseTo(100, 6);
    expect(black76(26100, 26000, 0, 12, "CE")).toBe(100);
    expect(black76(26100, 26000, T, 0, "PE")).toBe(0);
  });

  it("probability ITM and the 1σ move", () => {
    const T = 30 / 365;
    expect(probItm(26000, 26000, T, 12, "CE")).toBeLessThan(0.5);
    expect(probItm(26000, 26000, T, 12, "CE") + probItm(26000, 26000, T, 12, "PE")).toBeCloseTo(1, 10);
    expect(probItm(26000, 30000, T, 12, "CE")).toBeLessThan(0.01);
    expect(sigmaMove(26000, 12, T)).toBeCloseTo(26000 * 0.12 * Math.sqrt(T), -1);
    expect(sigmaMove(26000, null, T)).toBeNull();
  });
});

describe("strategies", () => {
  const L = (right, strike, side, price, lots = 1) => ({ right, strike, side, price, lots, iv: 12 });

  it("short straddle: credit, unlimited loss, two breakevens", () => {
    const legs = [L("CE", 26000, "SELL", 110), L("PE", 26000, "SELL", 100)];
    expect(netPremium(legs, 75)).toBe(210 * 75);
    expect(payoffAt(legs, 26000, 75)).toBe(210 * 75);
    const s = strategyStats(legs, 75, { forward: 26000, ivPct: 12, years: 5 / 365 });
    expect(s.maxProfit).toBe(210 * 75);
    expect(s.maxLoss).toBeNull();
    expect(s.breakevens[0]).toBeCloseTo(25790, 6);
    expect(s.breakevens[1]).toBeCloseTo(26210, 6);
    expect(s.pop).toBeGreaterThan(0.3);
    expect(s.pop).toBeLessThan(0.9);
  });

  it("bull call spread: capped both ways, one breakeven", () => {
    const legs = [L("CE", 26000, "BUY", 110), L("CE", 26100, "SELL", 60)];
    const s = strategyStats(legs, 75);
    expect(s.net).toBe(-50 * 75);
    expect(s.maxLoss).toBe(-50 * 75);
    expect(s.maxProfit).toBe(50 * 75);
    expect(s.breakevens).toHaveLength(1);
    expect(s.breakevens[0]).toBeCloseTo(26050, 6);
    expect(s.pop).toBeNull();
  });

  it("diagonal put: a short front put over a long back put has a finite, sane worst case", () => {
    const legs = [
      { right: "PE", strike: 26000, side: "SELL", price: 120, lots: 1, iv: 12, years: 5 / 365 },
      { right: "PE", strike: 25900, side: "BUY", price: 110, lots: 1, iv: 12, years: 12 / 365 },
    ];
    const s = strategyStats(legs, 75, { forward: 26000, ivPct: 12, years: 5 / 365, spot: 26000 });
    const net = netPremium(legs, 75);
    expect(Number.isFinite(s.maxLoss)).toBe(true);
    // Far below the strikes the back put is worth about its strike: the loss is the strike gap less the credit, not S = 0.
    expect(s.maxLoss).toBeGreaterThan(-(26000 - 25900) * 75 + net - 75);
    expect(s.maxLoss).toBeLessThan(0);
    expect(black76(0, 25900, 0.1, 12, "PE")).toBe(25900);
    expect(black76(0, 25900, 0.1, 12, "CE")).toBe(0);
  });

  it("coverLevels: the P&L rows span the wings, the breakevens and ±1σ, with every breakeven listed", () => {
    const strikes = Array.from({ length: 81 }, (_, i) => 24500 + i * 50);
    const lv = O.coverLevels({ strikes, legStrikes: [25950, 26100, 26900, 27250], breakevens: [26112, 27088], spot: 26408.5, band: [26100, 26720], rows: 13 });
    const grid = lv.filter((r) => r.kind === "strike");
    expect(grid.length).toBeGreaterThanOrEqual(13);
    expect(grid.length).toBeLessThanOrEqual(14);
    expect(grid[0].price).toBeLessThanOrEqual(25950);
    expect(grid[grid.length - 1].price).toBeGreaterThanOrEqual(27250);
    expect(grid[1].price - grid[0].price).toBe(150);
    expect(lv.filter((r) => r.kind === "be").map((r) => r.price)).toEqual([26112, 27088]);
    expect(lv.filter((r) => r.kind === "spot")).toHaveLength(1);
    expect(lv.map((r) => r.price)).toEqual([...lv.map((r) => r.price)].sort((a, b) => a - b));
    expect(O.coverLevels({ strikes: [], spot: 1 })).toEqual([]);
  });

  it("long call: unlimited profit; lots scale P&L", () => {
    const s = strategyStats([L("CE", 26000, "BUY", 110, 2)], 75);
    expect(s.maxProfit).toBeNull();
    expect(s.maxLoss).toBe(-110 * 150);
  });

  it("value today converges to expiry payoff", () => {
    const legs = [L("CE", 26000, "BUY", 110)];
    expect(valueAt(legs, 26200, 75, 0)).toBeCloseTo(payoffAt(legs, 26200, 75), 6);
    expect(valueAt(legs, 26000, 75, 5 / 365)).toBeGreaterThan(payoffAt(legs, 26000, 75));
  });

  it("presets build the right legs around ATM", () => {
    expect(presetLegs("short-straddle", chain)).toEqual([
      { right: "CE", strike: 26000, side: "SELL", lots: 1 },
      { right: "PE", strike: 26000, side: "SELL", lots: 1 },
    ]);
    const ic = presetLegs("iron-condor", chain, { move: 50 });
    expect(ic.map((l) => `${l.side} ${l.strike} ${l.right}`)).toEqual(["BUY 25900 PE", "SELL 25950 PE", "SELL 26050 CE", "BUY 26100 CE"]);
    const bull = presetLegs("bull-call", chain, { move: 100 });
    expect(bull[1].strike).toBe(26100);
    expect(presetLegs("nope", chain)).toEqual([]);
  });

  it("net Greeks sign by side", () => {
    const c = { lotSize: 75, rows: [{ strike: 26000, ce: { delta: 0.5, theta: -10 }, pe: { delta: -0.5, theta: -9 } }] };
    const g = netGreeks([L("CE", 26000, "SELL", 1), L("PE", 26000, "SELL", 1)], c);
    expect(g.delta).toBeCloseTo(0, 10);
    expect(g.theta).toBe((10 + 9) * 75);
  });
});

describe("ticket helpers", () => {
  it("rounds to the tick in the trader's favour", () => {
    expect(roundToTick(100.03, 0.05)).toBe(100.05);
    expect(roundToTick(100.01, 0.05, "buy")).toBe(100.05);
    expect(roundToTick(100.04, 0.05, "sell")).toBe(100);
    expect(roundToTick(100.05, 0.05, "buy")).toBe(100.05);
    expect(roundToTick(null)).toBeNull();
    expect(touchPrice({ bid: 99.9, ask: 100.1, ltp: 100 }, "BUY")).toBe(100.1);
    expect(touchPrice({ bid: 99.9, ask: 100.1, ltp: 100 }, "SELL")).toBe(99.9);
    expect(touchPrice({ bid: null, ask: null, ltp: 100 }, "SELL")).toBe(100);
  });

  it("counts time to the 15:30 IST expiry", () => {
    const at = (iso) => new Date(iso).getTime();
    expect(timeToExpiry("2026-11-03", at("2026-11-03T09:00:00+05:30")).label).toBe("Expires today");
    expect(timeToExpiry("2026-11-03", at("2026-11-02T09:00:00+05:30")).label).toBe("1 day");
    expect(timeToExpiry("2026-11-03", at("2026-10-28T09:00:00+05:30")).label).toBe("6 days");
    expect(timeToExpiry("2026-11-03", at("2026-11-03T15:31:00+05:30")).label).toBe("Expired");
    expect(timeToExpiry("bad").days).toBeNull();
  });

  it("filters positions to one underlying's options", () => {
    const pos = [{ symbol: "NFO:NIFTY-2026-11-03-26000-CE" }, { symbol: "NFO:BANKNIFTY-2026-11-24-52000-PE" }, { symbol: "NSE:NIFTY" }, { symbol: "BFO:SENSEX-2026-10-29-80000-PE" }];
    expect(positionsFor(pos, "NIFTY").map((p) => p.symbol)).toEqual(["NFO:NIFTY-2026-11-03-26000-CE"]);
    expect(positionsFor(pos, "SENSEX")).toHaveLength(1);
    expect(parseOptionSymbol("NFO:NIFTY-2026-11-03-26000-CE")).toEqual({ underlying: "NIFTY", expiry: "2026-11-03", strike: 26000, right: "CE" });
    expect(parseOptionSymbol("NSE:NIFTY")).toBeNull();
  });
});

describe("persona reads", () => {
  it("breakeven", () => {
    expect(O.breakeven(26400, "CE", 155.35)).toBeCloseTo(26555.35, 6);
    expect(O.breakeven(26400, "PE", 158.9)).toBeCloseTo(26241.1, 6);
    expect(O.breakeven(26400, "CE", null)).toBeNull();
    expect(O.breakeven(100, "PE", 120)).toBeNull();
  });

  it("chance of profit is P(ITM) at the breakeven", () => {
    const T = 10 / 365;
    const pop = O.chanceOfProfit(26000, 26000, T, 12, "CE", 150);
    expect(pop).toBeCloseTo(O.probItm(26000, 26150, T, 12, "CE"), 10);
    expect(pop).toBeLessThan(O.probItm(26000, 26000, T, 12, "CE"));
    expect(O.chanceOfProfit(26200, 26000, 0, 12, "CE", 150)).toBe(1);
    expect(O.chanceOfProfit(26100, 26000, 0, 12, "CE", 150)).toBe(0);
    expect(O.chanceOfProfit(26000, 26000, T, null, "CE", 150)).toBeNull();
  });

  it("distance from spot, OTM positive, and in σ", () => {
    expect(O.distance(26500, "CE", 26000)).toEqual({ pts: 500, pct: (500 / 26000) * 100 });
    expect(O.distance(25500, "PE", 26000).pts).toBe(500);
    expect(O.distance(25500, "CE", 26000).pts).toBe(-500);
    const T = 30 / 365;
    const K = 26000 * Math.exp(0.12 * Math.sqrt(T));
    expect(O.sigmaDistance(K, "CE", 26000, 12, T)).toBeCloseTo(1, 10);
    expect(O.sigmaDistance(26000 * Math.exp(-0.12 * Math.sqrt(T)), "PE", 26000, 12, T)).toBeCloseTo(1, 10);
    expect(O.sigmaDistance(K, "CE", 26000, null, T)).toBeNull();
  });

  it("log-normal σ bands", () => {
    const T = 30 / 365;
    const b1 = O.sigmaBand(26000, 12, T, 1);
    const b2 = O.sigmaBand(26000, 12, T, 2);
    expect(b1.lo * b1.hi).toBeCloseTo(26000 * 26000, 3);
    expect(b2.hi).toBeGreaterThan(b1.hi);
    expect(b2.lo).toBeLessThan(b1.lo);
    expect(O.sigmaBand(26000, null, T)).toBeNull();
  });

  it("time value against the forward is not clamped", () => {
    expect(O.extrinsic(26000, "CE", 90, 26100)).toBe(-10);
    expect(O.extrinsic(26500, "CE", 40, 26100)).toBe(40);
    expect(O.extrinsic(26500, "PE", 410, 26100)).toBe(10);
    expect(O.extrinsic(26500, "PE", null, 26100)).toBeNull();
  });

  it("synthetic future and the parity edge", () => {
    const row = { strike: 26000, ce: { bid: 110, ask: 111, ltp: 110.5 }, pe: { bid: 99, ask: 100, ltp: 99.5 } };
    const s = O.synthetic(row);
    expect(s.mid).toBeCloseTo(26011, 6);
    expect(s.buy).toBe(26000 + 111 - 99);
    expect(s.sell).toBe(26000 + 110 - 100);
    expect(O.synthetic({ strike: 26000, ce: { ltp: 110 }, pe: { bid: 99, ask: 100 } })).toMatchObject({ buy: null, sell: null, twoSided: false });
    // Normal market: both ways cost the spread.
    expect(O.parityEdge(row, 26011).edge).toBeLessThanOrEqual(0);
    // The synthetic sells above the future: a conversion.
    expect(O.parityEdge(row, 26005)).toEqual({ edge: 5, kind: "conv" });
    // The future above the synthetic's buy price: a reversal.
    expect(O.parityEdge(row, 26015)).toEqual({ edge: 3, kind: "rev" });
    expect(O.parityEdge({ strike: 26000, ce: { ltp: 1 }, pe: { ltp: 1 } }, 26000)).toBeNull();
  });

  it("the parity edge trades the future at its touch, not its last price", () => {
    const row = { strike: 26000, ce: { bid: 110, ask: 111, ltp: 110.5 }, pe: { bid: 99, ask: 100, ltp: 99.5 } };
    // syn.sell = 26010; LTP 26008.5 would show +1.5, but a conversion buys the future at its ask (26011): −1.
    expect(O.parityEdge(row, { bid: 26006, ask: 26011, ltp: 26008.5 })).toEqual({ edge: -1, kind: "conv" });
    // A reversal sells the future at its bid.
    expect(O.parityEdge(row, { bid: 26016, ask: 26018, ltp: 26017 })).toEqual({ edge: 4, kind: "rev" });
    // No two-sided future quote: no executable edge.
    expect(O.parityEdge(row, { bid: null, ask: 26011, ltp: 26008 })).toBeNull();
  });

  it("the synthetic is flat across strikes when the chain is priced with carry (r > 0)", () => {
    const F = 26500;
    const years = 27 / 365;
    const g = O.parityGrowth(years, RISK);
    expect(g).toBeCloseTo(Math.exp(RISK * years), 12);
    expect(O.parityGrowth(0, RISK)).toBe(1);
    // The rate is required: without one there is no carry (never a hidden default).
    expect(O.parityGrowth(years)).toBe(1);
    expect(O.parityGrowth(years, null)).toBe(1);
    expect(O.parityGrowth(years, 0.0571)).toBeCloseTo(Math.exp(0.0571 * years), 12);
    const D = Math.exp(-RISK * years);
    const rows = [25400, 26000, 26500, 27000, 27400].map((K) => {
      const c = O.black76(F, K, years, 12, "CE") * D;
      const p = c - (F - K) * D;
      const q = (v) => ({ bid: v - 0.05, ask: v + 0.05, ltp: v });
      return { strike: K, ce: q(c), pe: q(p) };
    });
    const mids = rows.map((r) => O.synthetic(r, g).mid);
    for (const m of mids) expect(m).toBeCloseTo(F, 6);
    // Without the carry factor the synthetic tilts with strike.
    expect(Math.abs(O.synthetic(rows[0]).mid - O.synthetic(rows[4]).mid)).toBeGreaterThan(5);
    expect(O.forwardPrice({ underlyingLtp: 26450, rows }, g)).toBeCloseTo(F, 6);
  });

  it("top OI strikes per side", () => {
    const rows = [
      { strike: 100, ce: { oi: 50 } },
      { strike: 110, ce: { oi: 90 } },
      { strike: 120, ce: { oi: 50 } },
      { strike: 130, ce: { oi: 0 } },
      { strike: 140, ce: { oi: 10 } },
    ];
    expect(O.topOi(rows, "ce", 3)).toEqual([
      { strike: 110, oi: 90, rank: 1 },
      { strike: 100, oi: 50, rank: 2 },
      { strike: 120, oi: 50, rank: 3 },
    ]);
    expect(O.topOi([{ strike: 1, pe: { oi: 0 } }], "pe")).toEqual([]);
  });

  it("hedge lots", () => {
    expect(O.hedgeLots(150, -0.5, 75)).toBe(4);
    expect(O.hedgeLots(75, -0.5, 75)).toBe(2);
    expect(O.hedgeLots(150, 0.5, 75)).toBeNull();
    expect(O.hedgeLots(150, -0.01, 75)).toBeNull();
    expect(O.hedgeLots(-150, 0.3, 75)).toBe(7);
  });

  it("strike query", () => {
    const strikes = Array.from({ length: 21 }, (_, i) => 25500 + i * 100);
    const ctx = { strikes, atm: 26500, F: 26500, sigmaPts: 400, maxPain: 26300 };
    expect(O.strikeQuery("26400", ctx)).toBe(26400);
    expect(O.strikeQuery("26437", ctx)).toBe(26400);
    expect(O.strikeQuery("264", ctx)).toBe(26400);
    expect(O.strikeQuery("+3", ctx)).toBe(26800);
    expect(O.strikeQuery("-2", ctx)).toBe(26300);
    expect(O.strikeQuery("1s", ctx)).toBe(26900);
    expect(O.strikeQuery("-2σ", ctx)).toBe(25700);
    expect(O.strikeQuery("+1.5sd", ctx)).toBe(27100);
    expect(O.strikeQuery("ATM", ctx)).toBe(26500);
    expect(O.strikeQuery("mp", ctx)).toBe(26300);
    expect(O.strikeQuery("max pain", ctx)).toBe(26300);
    expect(O.strikeQuery("abc", ctx)).toBeNull();
    expect(O.strikeQuery("", ctx)).toBeNull();
    expect(O.strikeQuery("+99", ctx)).toBe(27500);
  });

  it("expiry day and the monthly expiry", () => {
    const at = (iso) => Date.parse(iso);
    expect(O.isExpiryDay("2026-11-03", at("2026-11-03T09:15:00+05:30"))).toBe(true);
    expect(O.isExpiryDay("2026-11-03", at("2026-11-03T15:31:00+05:30"))).toBe(false);
    expect(O.isExpiryDay("2026-11-03", at("2026-11-02T10:00:00+05:30"))).toBe(false);
    const list = ["2026-11-03", "2026-11-24", "2026-12-29"];
    expect(O.isMonthlyExpiry("2026-11-24", list)).toBe(true);
    expect(O.isMonthlyExpiry("2026-11-03", list)).toBe(false);
  });

  it("net OI change in the summary", () => {
    const s = chainSummary(chain);
    expect(s.netOiChange).toBe(0);
    const c2 = { ...chain, rows: [{ strike: 1, ce: { oiChange: -500 }, pe: { oiChange: 200 } }] };
    expect(chainSummary(c2).netOiChange).toBe(700);
    expect(chainSummary(c2).pcrChange).toBeNull();
  });
});

describe("trade warnings", () => {
  const good = { bid: 100, ask: 100.5, ltp: 100.2, theta: -2 };
  const base = { side: "BUY", right: "CE", leg: good, lots: 1, lot: 75, freezeQty: 1800, liq: 5, stale: false, isExpiryDay: false, itm: false, intrinsic: 0, hasLongSameExpiry: false, orderType: "LIMIT", years: 5 / 365 };
  const codes = (o) => O.tradeWarnings({ ...base, ...o }).map((w) => w.code);
  it("is quiet for a clean order", () => expect(O.tradeWarnings(base)).toEqual([]));
  it("flags each mistake", () => {
    expect(O.tradeWarnings({ ...base, leg: { bid: 93, ask: 100 } })[0]).toMatchObject({ code: "WIDE_SPREAD", level: "warn", text: "Spread 7.3% of mid: use a limit order" });
    expect(O.tradeWarnings({ ...base, leg: { bid: 80, ask: 100 } })[0].level).toBe("bad");
    expect(codes({ liq: 2 })).toEqual(["ILLIQUID"]);
    expect(codes({ leg: { bid: 98, ask: 101 }, orderType: "MARKET" })).toEqual(["MARKET_ILLIQUID"]);
    expect(codes({ leg: { bid: 0, ask: 101, ltp: 100 } })).toEqual(["ONE_SIDED"]);
    expect(codes({ stale: true })).toEqual(["STALE"]);
    expect(codes({ lots: 25 })).toEqual(["FREEZE"]);
    expect(O.tradeWarnings({ ...base, side: "SELL" })[0]).toMatchObject({ code: "NAKED_SHORT", text: "Uncovered short: margin is blocked and losses are unlimited" });
    expect(O.tradeWarnings({ ...base, side: "SELL", right: "PE" })[0].text).toMatch(/large$/);
    expect(codes({ side: "SELL", hasLongSameExpiry: true })).toEqual([]);
    expect(codes({ side: "SELL", hasLongSameExpiry: true, isExpiryDay: true })).toEqual(["EXPIRY_ELM"]);
    const stt = O.tradeWarnings({ ...base, isExpiryDay: true, itm: true, intrinsic: 200, lots: 2 });
    expect(stt.map((w) => w.code)).toEqual(["EXPIRY_STT"]);
    expect(stt[0].text).toContain("₹38");
    expect(stt[0].text).toContain("₹15");
    expect(codes({ side: "SELL", exit: true, isExpiryDay: true, itm: true, intrinsic: 200 })).toEqual(["EXPIRY_STT"]);
    expect(codes({ years: 0.5 / 365, leg: { ...good, theta: -40 } })).toEqual(["THETA_0DTE"]);
  });
});

// ── OI analysis ──
import * as OA from "./options.js";

/** IST wall-clock time → epoch ms (IST is UTC+05:30). */
const ist = (y, mo, d, hh = 10, mm = 0) => Date.UTC(y, mo - 1, d, hh, mm) - 5.5 * 3600 * 1000;
/** Window-row leg from plain numbers. */
const wl = (oi, d, extra = {}) => ({ oi, d, oiRef: oi === null || d === null ? null : oi - d, dPct: null, ltp: 100, ltpRef: 100, dLtp: 0, v: 0, ...extra });

describe("OI analysis maths", () => {
  it("pcrSet: ratio, each non-ratio kind, null ΔOI and an empty call side", () => {
    const rows = [{ strike: 1, ce: wl(100, 10, { v: 50 }), pe: wl(150, 20, { v: 100 }) }];
    const a = OA.pcrSet(rows);
    expect(a.oi).toBeCloseTo(1.5);
    expect(a.vol).toBeCloseTo(2);
    expect(a.chg).toMatchObject({ kind: "ratio", p: 20, c: 10 });
    expect(a.chg.ratio).toBeCloseTo(2);
    const kind = (dc, dp) => OA.pcrSet([{ strike: 1, ce: wl(100, dc), pe: wl(100, dp) }]).chg;
    expect(kind(-5, 10)).toMatchObject({ kind: "put-add-call-cut", ratio: null, text: "Puts added, calls cut: supportive" });
    expect(kind(0, 10).kind).toBe("put-add-call-cut");
    expect(kind(10, -5).kind).toBe("call-add-put-cut");
    expect(kind(-3, -5)).toMatchObject({ kind: "both-cut", p: -5, c: -3 });
    expect(kind(0, 0).kind).toBe("flat");
    expect(OA.pcrSet([{ strike: 1, ce: wl(100, null), pe: wl(100, null) }]).chg).toBeNull();
    // A missing ΔOI on one leg counts as 0.
    expect(OA.pcrSet([{ strike: 1, ce: wl(100, null), pe: wl(100, 4) }]).chg.kind).toBe("put-add-call-cut");
    expect(OA.pcrSet([{ strike: 1, ce: wl(0, 0), pe: wl(100, 0) }]).oi).toBeNull();
    // Band vs chain: the scope is whatever rows are passed.
    const chain = [{ strike: 1, ce: wl(100, 0), pe: wl(300, 0) }, { strike: 2, ce: wl(100, 0), pe: wl(100, 0) }];
    expect(OA.pcrSet(chain).oi).toBeCloseTo(2);
    expect(OA.pcrSet(chain.slice(1)).oi).toBeCloseTo(1);
  });

  it("PCR bands read in the writer view", () => {
    expect(OA.pcrBand(1.5).word).toBe("very put-heavy (extreme)");
    expect(OA.pcrBand(1.2).word).toBe("put-heavy");
    expect(OA.pcrBand(1).word).toBe("balanced");
    expect(OA.pcrBand(0.8).word).toBe("call-heavy");
    expect(OA.pcrBand(0.6).word).toBe("very call-heavy (extreme)");
    expect(OA.pcrBand(null)).toBeNull();
    expect(OA.PCR_BANDS).toHaveLength(5);
  });

  it("maxPainCurve: a hand-computed chain, ties, the edge flag and coverage", () => {
    const rows = [100, 110, 120, 130, 140].map((k, i) => ({ strike: k, ce: { oi: [0, 0, 10, 20, 5][i] }, pe: { oi: [5, 20, 10, 0, 0][i] } }));
    const mp = OA.maxPainCurve(rows);
    // pain(100) = PE 20·10 + 10·20 = 400; pain(120) = 0 (no CE OI below it, no PE OI above it).
    const pain = (K) => rows.reduce((a, r) => a + r.ce.oi * Math.max(0, K - r.strike) + r.pe.oi * Math.max(0, r.strike - K), 0);
    expect(mp.curve.map((c) => c.pain)).toEqual([100, 110, 120, 130, 140].map(pain));
    expect(mp.curve[0].pain).toBe(400);
    expect(mp.curve.find((c) => c.strike === 120).pain).toBe(0);
    expect(mp.strike).toBe(120);
    expect(mp).toMatchObject({ n: 5, lo: 100, hi: 140, edge: false });
    expect(OA.maxPain(rows)).toBe(120);
    // Tie between 110 and 120 (symmetric OI): the strike nearer spot wins, else the lower.
    const tie = [100, 110, 120, 130].map((k) => ({ strike: k, ce: { oi: k === 110 ? 10 : 0 }, pe: { oi: k === 120 ? 10 : 0 } }));
    expect(OA.maxPainCurve(tie, 119).strike).toBe(120);
    expect(OA.maxPainCurve(tie, null).strike).toBe(110);
    // All OI on the top strike: the edge.
    const edge = [100, 110, 120].map((k) => ({ strike: k, ce: { oi: 0 }, pe: { oi: k === 120 ? 50 : 0 } }));
    expect(OA.maxPainCurve(edge)).toMatchObject({ strike: 120, edge: true });
    expect(OA.maxPainCurve(rows.slice(0, 2))).toBeNull();
    expect(OA.maxPain([])).toBeNull();
  });

  it("maxPainRelevance counts weekday sessions", () => {
    // Friday 10:00 to Tuesday expiry: Fri, Mon, Tue.
    expect(OA.sessionsLeft("2026-11-03", ist(2026, 10, 30, 10))).toBe(3);
    expect(OA.maxPainRelevance("2026-11-03", ist(2026, 10, 30, 10))).toBe("medium");
    expect(OA.sessionsLeft("2026-11-03", ist(2026, 11, 2, 10))).toBe(2);
    expect(OA.maxPainRelevance("2026-11-03", ist(2026, 11, 2, 10))).toBe("high");
    expect(OA.sessionsLeft("2026-11-03", ist(2026, 11, 3, 16))).toBe(0);
    expect(OA.maxPainRelevance("2026-11-03", ist(2026, 11, 3, 16))).toBe("high");
    expect(OA.sessionsLeft("2026-11-10", ist(2026, 11, 3, 10))).toBe(6);
    expect(OA.maxPainRelevance("2026-11-10", ist(2026, 11, 3, 10))).toBe("low");
    expect(OA.maxPainRelevance("x")).toBeNull();
  });

  it("oiWalls: top 3, sides of spot, ties, share, strength and freshness", () => {
    const rows = [
      { strike: 100, ce: wl(10, 0), pe: wl(80, 4) },
      { strike: 110, ce: wl(30, 3), pe: wl(80, -4) },
      { strike: 120, ce: wl(50, 2), pe: wl(40, 0) },
      { strike: 130, ce: wl(50, 30), pe: wl(5, 0) },
      { strike: 140, ce: wl(20, -1), pe: wl(5, 0) },
      { strike: 150, ce: wl(40, 0), pe: wl(5, 0) },
    ];
    const ce = OA.oiWalls(rows, "ce", 121, { move: 18 });
    // 120 is below spot: calls start at 130. 130 (50) leads, 150 (40) next, then 140 (20).
    expect(ce.map((w) => w.strike)).toEqual([130, 150, 140]);
    expect(ce[0]).toMatchObject({ rank: 1, oi: 50, d: 30, dist: 9 });
    expect(ce[0].share).toBeCloseTo(50 / 200);
    expect(ce[0].strength).toBeCloseTo(50 / (200 / 6));
    expect(ce[0].sigma).toBeCloseTo(0.5);
    expect(ce[0].fresh).toBe("fresh");
    expect(ce[1].fresh).toBe("steady");
    // Puts at or below spot; 100 and 110 tie on 80: the one nearer spot ranks first.
    const pe = OA.oiWalls(rows, "pe", 121);
    expect(pe.map((w) => w.strike)).toEqual([110, 100, 120]);
    expect(pe[0].fresh).toBe("steady"); // −4 of 84 is −4.8%
    expect(pe[1].fresh).toBe("fresh"); // +4 of 76 is +5.3%
    expect(OA.wallFreshness(4, 80)).toBe("fresh");
    expect(OA.wallFreshness(3.9, 80)).toBe("steady");
    expect(OA.wallFreshness(-4, 80)).toBe("unwinding");
    expect(OA.wallFreshness(-3.9, 80)).toBe("steady");
    expect(OA.wallFreshness(5, 0)).toBe("fresh");
    expect(OA.wallFreshness(null, 80)).toBeNull();
    expect(OA.oiWalls(rows, "ce", null).map((w) => w.strike)).toEqual([120, 130, 150]);
    expect(OA.oiWalls(rows, "ce", 121, { top: 1 })).toHaveLength(1);
    expect(OA.oiWalls(rows, "ce", 121, { band: rows.slice(3) })[0].strength).toBeCloseTo(50 / (110 / 3));
  });

  it("freshWall picks the largest add; pinZone shares the strikes nearest spot", () => {
    const rows = [{ strike: 100, ce: wl(10, 2), pe: wl(10, 9) }, { strike: 110, ce: wl(10, 7), pe: wl(10, -1) }];
    expect(OA.freshWall(rows, "ce")).toEqual({ strike: 110, d: 7, oi: 10 });
    expect(OA.freshWall(rows, "pe").strike).toBe(100);
    expect(OA.freshWall([{ strike: 1, ce: wl(10, -2) }], "ce")).toBeNull();
    const pz = OA.pinZone([...rows, { strike: 120, ce: wl(20, 0), pe: wl(20, 0) }, { strike: 130, ce: wl(60, 0), pe: null }], 111, 2);
    expect(pz).toEqual({ lo: 110, hi: 120, share: 60 / 140 });
  });

  it("classifyBuildup: quadrants, churn, noise and the tick floor", () => {
    const o = { lot: 75 };
    const leg = (d, dLtp, extra = {}) => ({ d, oiRef: 100000, dLtp, ltpRef: 100, v: 0, ...extra });
    expect(OA.classifyBuildup(leg(5000, 2), o)).toBe("LB");
    expect(OA.classifyBuildup(leg(5000, -2), o)).toBe("SB");
    expect(OA.classifyBuildup(leg(-5000, 2), o)).toBe("SC");
    expect(OA.classifyBuildup(leg(-5000, -2), o)).toBe("LU");
    // Below the OI threshold (max(1% of 100000, 10 lots) = 1000): churn with heavy volume, else nothing.
    expect(OA.classifyBuildup(leg(500, 2, { v: 5 * 10 * 75 }), o)).toBe("CH");
    expect(OA.classifyBuildup(leg(500, 2, { v: 100 }), o)).toBeNull();
    // Below the price threshold (0.5% of 100 = 0.5): churn when volume ≥ 5 × |ΔOI|.
    expect(OA.classifyBuildup(leg(5000, 0.3, { v: 25000 }), o)).toBe("CH");
    expect(OA.classifyBuildup(leg(5000, 0.3, { v: 100 }), o)).toBeNull();
    expect(OA.classifyBuildup(leg(null, 2), o)).toBeNull();
    expect(OA.classifyBuildup(leg(5000, null), o)).toBeNull();
    // No reference price: two ticks (0.10) decide.
    expect(OA.classifyBuildup(leg(5000, 0.1, { ltpRef: null }), o)).toBe("LB");
    expect(OA.classifyBuildup(leg(5000, 0.05, { ltpRef: null }), o)).toBeNull();
    expect(OA.BUILDUP_NAMES.CH).toBe("Churn");
  });

  it("buildupSummary translates each side into direction", () => {
    const leg = (d, dLtp) => ({ d, oiRef: 100000, dLtp, ltpRef: 100, v: 0 });
    // PE long build-up (put buying) is bearish; PE short build-up (put writing) supportive.
    expect(OA.buildupSummary([{ strike: 1, ce: null, pe: leg(5000, 5) }]).score).toBe(-1);
    expect(OA.buildupSummary([{ strike: 1, ce: null, pe: leg(5000, -5) }]).score).toBe(1);
    expect(OA.buildupSummary([{ strike: 1, ce: leg(5000, 5), pe: null }]).score).toBe(1);
    expect(OA.BUILDUP_DIR.LB).toEqual({ ce: 1, pe: -1 });
    expect(OA.BUILDUP_DIR.SB).toEqual({ ce: -1, pe: 1 });
    // Writers on both sides: range wins over the score.
    const range = OA.buildupSummary([{ strike: 1, ce: leg(5000, -5), pe: leg(9000, -5) }], { range: { lo: 25900, hi: 26500 } });
    expect(range.tone).toBe("range");
    expect(range.text).toBe("Writers on both sides: range 25900–26500");
    expect(range.short).toBe("Writers on both sides");
    expect(range.ce.SB).toEqual({ n: 1, lots: 5000 });
    expect(range.ce.dom).toBe("SB");
    // Score thresholds at ±0.25: up 5000 (CE LB) vs down 3000 (CE LU) → 0.25.
    const at = OA.buildupSummary([{ strike: 1, ce: leg(5000, 5), pe: null }, { strike: 2, ce: leg(-3000, -5), pe: null }]);
    expect(at.score).toBeCloseTo(0.25);
    expect(at.tone).toBe("up");
    const under = OA.buildupSummary([{ strike: 1, ce: leg(5000, 5), pe: null }, { strike: 2, ce: leg(-3100, -5), pe: null }]);
    expect(under.tone).toBe("mixed");
    const down = OA.buildupSummary([{ strike: 1, ce: leg(-5000, -5), pe: null }, { strike: 2, ce: leg(3000, 5), pe: null }]);
    expect(down.tone).toBe("down");
    const empty = OA.buildupSummary([]);
    expect(empty.score).toBeNull();
    expect(empty.tone).toBe("mixed");
    expect(empty.empty).toBe(true);
  });

  it("oiMovers: ordering, the cap, new strikes and wall tags", () => {
    const chain = { rows: [100, 110, 120, 130].map((k, i) => ({ strike: k, ce: { oi: 1000 + i * 100, ltp: 10, volume: 0 }, pe: { oi: 500, ltp: 10, volume: 0 } })) };
    const ref = { k: [100, 110, 120], co: [1000, 1300, 1000], po: [500, 400, 600], cl: [10, 10, 10], pl: [10, 10, 10], cv: [0, 0, 0], pv: [0, 0, 0] };
    const rows = OA.oiWindowRows(chain, ref);
    const m = OA.oiMovers(rows, { n: 2, walls: { ce: new Map([[130, "R1"]]), pe: new Map() } });
    // 130 is new on both sides (CE +1300, PE +500), then CE 120 +200; unwinds CE 110 −200, PE 120 −100.
    expect(m.adds.map((a) => [a.strike, a.side, a.d])).toEqual([[130, "ce", 1300], [130, "pe", 500]]);
    expect(m.adds[0]).toMatchObject({ dPct: null, oiRef: 0, wall: "R1" });
    expect(m.unwinds.map((a) => [a.strike, a.side, a.d])).toEqual([[110, "ce", -200], [120, "pe", -100]]);
    expect(OA.oiMovers(rows).adds.map((a) => a.d)).toEqual([1300, 500, 200, 100]);
    // The noise filter drops sub-threshold changes: 10 lots of 15 = 150, so only +1300, +500, +200 and −200 remain.
    const f = OA.oiMovers(rows, { lot: 15, minLots: 10 });
    expect(f.adds.map((a) => a.d)).toEqual([1300, 500, 200]);
    expect(f.unwinds.map((a) => a.d)).toEqual([-200]);
  });

  it("oiWindowRows: previous close, a snapshot with a missing strike, window volume", () => {
    const chain = { rows: [{ strike: 100, ce: { symbol: "C", oi: 1000, oiChange: 200, ltp: 12, change: -3, volume: 900 }, pe: null }, { strike: 110, ce: { oi: 50, oiChange: null, ltp: 5, change: 1, volume: 10 }, pe: { oi: 70, ltp: 4, volume: 5 } }] };
    const prev = OA.oiWindowRows(chain);
    expect(prev[0].ce).toMatchObject({ symbol: "C", oi: 1000, oiRef: 800, d: 200, dPct: 25, ltp: 12, ltpRef: 15, dLtp: -3, v: 900 });
    expect(prev[0].pe).toBeNull();
    expect(prev[1].ce).toMatchObject({ oiRef: null, d: null });
    const snap = OA.oiWindowRows(chain, { k: [100], co: [900], po: [null], cl: [10], pl: [null], cv: [1000], pv: [null] });
    expect(snap[0].ce).toMatchObject({ oiRef: 900, d: 100, ltpRef: 10, v: 0 });
    expect(snap[0].ce.dLtp).toBeCloseTo(2);
    expect(snap[1].ce).toMatchObject({ oiRef: 0, d: 50, dPct: null, ltpRef: null, dLtp: null });
  });

  it("pickRef: exact, half-window fallback, warm-up, since open and previous close", () => {
    const now = ist(2026, 11, 2, 11, 0);
    const snaps = [ist(2026, 11, 2, 10, 30), ist(2026, 11, 2, 10, 44), ist(2026, 11, 2, 10, 46), ist(2026, 11, 2, 10, 59)].map((t) => ({ t }));
    const r15 = OA.pickRef(snaps, now, "15");
    expect(r15).toMatchObject({ ok: true, label: "since 10:44" });
    expect(r15.snap.t).toBe(snaps[1].t);
    // 1h: nothing 60 min old, but the first snapshot is 30 min old (≥ half): use it.
    expect(OA.pickRef(snaps, now, "60")).toMatchObject({ ok: true, label: "since 10:30 (30m)" });
    // Warm-up: first snapshot 4 min old, 15m needs 7.5.
    const warm = OA.pickRef([{ t: ist(2026, 11, 2, 10, 56) }], now, "15");
    expect(warm.ok).toBe(false);
    expect(warm.reason).toBe("Recording since 10:56 · 15m ready at 11:11");
    expect(OA.pickRef([], now, "5").ok).toBe(false);
    expect(OA.pickRef(snaps, now, "open")).toMatchObject({ ok: true, label: "since 10:30 (opened late)" });
    expect(OA.pickRef([{ t: ist(2026, 11, 2, 9, 16) }], now, "open").label).toBe("since 09:16");
    expect(OA.pickRef(snaps, now, "prev", { hasPrev: true })).toMatchObject({ ok: true, snap: null });
    expect(OA.pickRef(snaps, now, "prev")).toMatchObject({ ok: false, reason: OA.NO_PREV_OI });
  });

  it("cumulativeOi sums in lots across lot sizes", () => {
    const a = { expiry: "2026-11-03", lotSize: 75, underlyingLtp: 105, rows: [100, 110, 120].map((k) => ({ strike: k, ce: { oi: 750, oiChange: 75, volume: 0 }, pe: { oi: 1500, oiChange: null } })) };
    const b = { expiry: "2026-11-24", lotSize: 25, underlyingLtp: 105, rows: [110, 120, 130].map((k) => ({ strike: k, ce: { oi: 250, oiChange: -25 }, pe: { oi: 250, oiChange: 25 } })) };
    const c = OA.cumulativeOi([a, b], ist(2026, 11, 2, 10));
    expect(c.rows.map((r) => r.strike)).toEqual([100, 110, 120, 130]);
    const r110 = c.rows[1];
    expect(r110.ce).toMatchObject({ oi: 20, d: 0, by: { "2026-11-03": 10, "2026-11-24": 10 } });
    expect(r110.pe).toMatchObject({ oi: 30, d: 1 });
    expect(c.rows[0].ce.d).toBe(1);
    expect(c.perExpiry).toHaveLength(2);
    expect(c.perExpiry[0]).toMatchObject({ expiry: "2026-11-03", lot: 75, ceOi: 30, peOi: 60, pcr: 2, r1: 110, s1: 100 });
    expect(c.perExpiry[1]).toMatchObject({ lot: 25, ceOi: 30, peOi: 30, pcr: 1 });
  });

  it("oiSeries: totals, PCR and walls per snapshot; wall migration text", () => {
    const s = (t, co, po) => ({ t, spot: 115, lot: 10, k: [100, 110, 120, 130], co, po, cl: [1, 1, 1, 1], pl: [1, 1, 1, 1] });
    const series = OA.oiSeries([s(ist(2026, 11, 2, 9, 31), [0, 0, 100, 50], [80, 20, 0, 0]), s(ist(2026, 11, 2, 11, 2), [0, 0, 50, 200], [80, 20, 0, 0])]);
    expect(series[0]).toMatchObject({ spot: 115, ceOi: 15, peOi: 10, r1: 120, s1: 100 });
    expect(series[0].pcr).toBeCloseTo(100 / 150);
    expect(series[1].r1).toBe(130);
    expect(typeof series[0].maxPain).toBe("number");
    expect(OA.wallMigrationText(series)).toBe("Call wall: 120 (09:31) → 130 (11:02) · Put wall: 100 since 09:31");
    expect(OA.wallMigrationText([])).toBeNull();
  });

  it("oiVerdict joins only the parts that exist", () => {
    expect(OA.oiVerdict({ walls: { r1: 26500, s1: 25900 }, buildup: { short: "Writers on both sides" }, pcr: 1.08, maxPain: 26300, relevance: "low" })).toBe(
      "Range 25900–26500 · Writers on both sides · PCR 1.08 balanced · Max Pain 26300 (low relevance)",
    );
    expect(OA.oiVerdict({ pcr: 1.3 })).toBe("PCR 1.30 put-heavy");
    expect(OA.oiVerdict({ walls: { r1: 26500, s1: null } })).toBe("Call wall 26500");
    expect(OA.oiVerdict({})).toBeNull();
  });

  it("marketSession reads IST from a UTC time", () => {
    expect(OA.marketSession(ist(2026, 10, 31, 11)).phase).toBe("closed"); // Saturday
    expect(OA.marketSession(ist(2026, 11, 2, 9, 14)).phase).toBe("pre");
    expect(OA.marketSession(ist(2026, 11, 2, 9, 15)).phase).toBe("open");
    expect(OA.marketSession(ist(2026, 11, 2, 15, 29)).phase).toBe("open");
    expect(OA.marketSession(ist(2026, 11, 2, 15, 30))).toMatchObject({ phase: "closed", istDate: "2026-11-02", label: "Market closed · last session" });
    // 23:00 UTC on 1 Nov is 04:30 IST on 2 Nov.
    expect(OA.marketSession(Date.UTC(2026, 10, 1, 23, 0)).istDate).toBe("2026-11-02");
  });
});

// ── Book risk (PRD 04) ──
import { computeIVAndGreeks } from "../../lib/blackScholes.mjs";

describe("book legs", () => {
  const pos = [
    { symbol: "NFO:NIFTY-2026-11-03-26400-CE", netQty: -75, avgPrice: 40, product: "MARGIN", realisedPnl: 10 },
    { symbol: "NFO:NIFTY-2026-11-24-FUT", netQty: 75, avgPrice: 26500, product: "MARGIN" },
    { symbol: "NFO:NIFTY-2026-11-03-26500-PE", netQty: 0, avgPrice: 0, realisedPnl: 300 },
    { symbol: "NFO:NIFTYNXT50-2026-11-24-60000-CE", netQty: 25, avgPrice: 100 },
    { symbol: "NFO:BANKNIFTY-2026-11-24-52000-PE", netQty: 30, avgPrice: 100, pnl: 120 },
    { symbol: "BFO:SENSEX-2026-11-05-80000-CE", netQty: -20, avgPrice: 200, pnl: -50 },
    { symbol: "NSE:RELIANCE", netQty: 10 },
  ];
  it("keeps CE / PE / FUT of the underlying, exact match, open only unless closed", () => {
    const l = O.bookLegs(pos, "NIFTY");
    expect(l.map((x) => x.symbol)).toEqual(["NFO:NIFTY-2026-11-03-26400-CE", "NFO:NIFTY-2026-11-24-FUT"]);
    expect(l[0]).toMatchObject({ kind: "OPT", strike: 26400, right: "CE", q: -75, avg: 40, expiry: "2026-11-03", realised: 10 });
    expect(l[1]).toMatchObject({ kind: "FUT", strike: null, right: null, q: 75, expiry: "2026-11-24" });
    expect(O.bookLegs(pos, "NIFTY", { closed: true })).toHaveLength(3);
    expect(O.bookLegs(pos, "BANKNIFTY").map((x) => x.underlying)).toEqual(["BANKNIFTY"]);
    expect(O.bookLegs(pos, "SENSEX")[0]).toMatchObject({ kind: "OPT", strike: 80000, q: -20 });
  });
  it("counts the other underlyings with open legs", () => {
    expect(O.bookUnderlyings(pos, "NIFTY")).toEqual([
      { underlying: "BANKNIFTY", legs: 1, pnl: 120 },
      { underlying: "NIFTYNXT50", legs: 1, pnl: 0 },
      { underlying: "SENSEX", legs: 1, pnl: -50 },
    ]);
  });
  it("parses future symbols", () => {
    expect(O.parseFutureSymbol("NFO:NIFTY-2026-11-24-FUT")).toEqual({ exchange: "NFO", underlying: "NIFTY", expiry: "2026-11-24" });
    expect(O.parseFutureSymbol("BFO:SENSEX-2026-11-26-FUT")?.underlying).toBe("SENSEX");
    expect(O.parseFutureSymbol("NFO:NIFTY-2026-11-24-26000-CE")).toBeNull();
    expect(O.parseFutureSymbol("NIFTY-FUT")).toBeNull();
    expect(O.parseFutureSymbol(null)).toBeNull();
  });
  it("monthly expiries are the last option expiry of each month", () => {
    expect(O.monthlyExpiries(["2026-11-10", "2026-11-03", "2026-11-24", "2026-12-01", "2026-12-29", "bad"])).toEqual(["2026-11-24", "2026-12-29"]);
  });
  it("legUnits honours exact units while lots match them", () => {
    expect(O.legUnits({ lots: 1, units: 37, lotSize: 75 })).toBe(37);
    expect(O.legUnits({ lots: 2, units: 150, lotSize: 75 })).toBe(150);
    expect(O.legUnits({ lots: 3, units: 37, lotSize: 75 })).toBe(225);
    expect(O.legUnits({ lots: 2, lotSize: 75 })).toBe(150);
    expect(O.migrateLegs([{ right: "CE", strike: 26000, side: "BUY", lots: 1, units: 37 }], "2026-11-03")[0].units).toBe(37);
  });
});

describe("implied vol and Black-76 Greeks", () => {
  it("round-trips black76 for CE and PE", () => {
    for (const right of ["CE", "PE"]) {
      for (const iv of [5, 12, 60]) {
        for (const days of [1, 30]) {
          const T = days / 365;
          const p = black76(26000, 26200, T, iv, right);
          expect(Math.abs(O.impliedVol(p, 26000, 26200, T, right) - iv)).toBeLessThan(0.01 + (p < 0.5 ? 1 : 0));
        }
      }
    }
  });
  it("is null below intrinsic or at expiry", () => {
    expect(O.impliedVol(100, 26300, 26000, 0.02, "CE")).toBeNull();
    expect(O.impliedVol(100, 26000, 26000, 0, "CE")).toBeNull();
  });
  it("satisfies parity and matches the server's Greeks", () => {
    const c = O.black76Greeks(26000, 26100, 10 / 365, 13, "CE");
    const p = O.black76Greeks(26000, 26100, 10 / 365, 13, "PE");
    expect(c.delta - p.delta).toBeCloseTo(1, 10);
    expect(c.gamma).toBeCloseTo(p.gamma, 12);
    expect(c.vega).toBeCloseTo(p.vega, 12);
    expect(c.theta).toBeLessThan(0);
    // Server fixture: Black-Scholes on spot with r = 6.5 %, an ATM NIFTY leg 6 days out.
    const S = 26416.75;
    const K = 26400;
    const days = 6;
    const r = 0.065;
    const T = days / 365;
    const sc = computeIVAndGreeks({ ltp: 177.1, spot: S, strike: K, daysToExpiry: days, type: "CE", rate: r });
    const sp = computeIVAndGreeks({ ltp: 151.2, spot: S, strike: K, daysToExpiry: days, type: "PE", rate: r });
    const F = S * Math.exp(r * T);
    const mc = O.black76Greeks(F, K, T, sc.iv, "CE");
    const within = (a, b, tol) => expect(Math.abs(a / b - 1)).toBeLessThan(tol);
    within(mc.delta, sc.delta, 0.02);
    within(mc.gamma, sc.gamma, 0.02);
    within(mc.vega, sc.vega, 0.02);
    const mp = O.black76Greeks(F, K, T, sp.iv, "PE");
    // Theta: Black-76 has no carry term, so it matches the server's CE / PE average.
    within((mc.theta + mp.theta) / 2, (sc.theta + sp.theta) / 2, 0.05);
  });
});

const NOW = Date.UTC(2026, 9, 28, 6, 0); // 28 Oct 2026, 11:30 IST
const mkChain = (expiry, spot, iv = 12) => {
  const T = O.yearsToExpiry(expiry, NOW);
  const rows = [];
  for (let k = 25500; k <= 26500; k += 100) {
    const mk = (right) => {
      const p = black76(spot, k, T, iv, right);
      const g = O.black76Greeks(spot, k, T, iv, right);
      return { symbol: `NFO:NIFTY-${expiry}-${k}-${right}`, ltp: p, bid: p - 0.05, ask: p + 0.05, iv, ...g };
    };
    rows.push({ strike: k, ce: mk("CE"), pe: mk("PE") });
  }
  return { underlying: "NIFTY", expiry, underlyingLtp: spot, atmStrike: 26000, lotSize: 75, rows };
};
const condorPositions = [
  { symbol: "NFO:NIFTY-2026-11-03-26300-CE", netQty: -150, avgPrice: 40 },
  { symbol: "NFO:NIFTY-2026-11-03-26500-CE", netQty: 150, avgPrice: 12 },
  { symbol: "NFO:NIFTY-2026-11-03-25700-PE", netQty: -150, avgPrice: 38 },
  { symbol: "NFO:NIFTY-2026-11-03-25500-PE", netQty: 150, avgPrice: 14 },
];
const priced = (pos, more = {}) => O.priceBook(O.bookLegs(pos, "NIFTY"), { chains: new Map([["2026-11-03", mkChain("2026-11-03", 26000)], ["2026-11-24", mkChain("2026-11-24", 26000)]]), now: NOW, ...more });

describe("pricing, Greeks and scenarios", () => {
  it("prices from the chain and calibrates to the mark", () => {
    const legs = priced(condorPositions);
    expect(legs.every((l) => l.priced && l.lot === 75)).toBe(true);
    const live = legs.reduce((t, l) => t + O.legPnl(l), 0);
    expect(O.scenarioPnl(legs, {})).toBeCloseTo(live, 6);
  });
  it("at the expiry date equals payoffAt for a single-expiry book", () => {
    const legs = priced(condorPositions);
    const days = legs[0].T * 365;
    const asStrategy = legs.map((l) => ({ kind: "OPT", right: l.right, strike: l.strike, side: l.q > 0 ? "BUY" : "SELL", lots: Math.abs(l.q) / 75, lotSize: 75, price: l.avg }));
    for (const x of [25400, 25700, 26000, 26400, 26700]) expect(O.scenarioPnl(legs, { dS: x / legs[0].F - 1, days })).toBeCloseTo(payoffAt(asStrategy, x, 75), 6);
  });
  it("futures are linear; IV up lifts longs; legs past expiry sit at intrinsic", () => {
    const fut = O.priceBook(O.bookLegs([{ symbol: "NFO:NIFTY-2026-11-24-FUT", netQty: 75, avgPrice: 26000 }], "NIFTY"), { quotes: new Map([["NFO:NIFTY-2026-11-24-FUT", { ltp: 26100, bid: 26099, ask: 26101 }]]), now: NOW });
    expect(O.scenarioPnl(fut, {})).toBeCloseTo(7500, 6);
    expect(O.scenarioPnl(fut, { dS: 0.01 }) - O.scenarioPnl(fut, {})).toBeCloseTo(75 * 261, 6);
    expect(O.bookGreeks(fut).delta).toBe(75);
    const long = priced([{ symbol: "NFO:NIFTY-2026-11-24-26000-CE", netQty: 75, avgPrice: 200 }]);
    expect(O.scenarioPnl(long, { dIv: 5 })).toBeGreaterThan(O.scenarioPnl(long, {}));
    const past = O.scenarioPnl(long, { dS: 0.02, days: 60 });
    expect(past).toBeCloseTo(75 * (26000 * 1.02 - 26000 - 200), 4);
  });
  it("book Greeks sum expiries, skip excluded legs and report unpriced ones", () => {
    const pos = [...condorPositions, { symbol: "NFO:NIFTY-2026-11-24-26000-PE", netQty: 75, avgPrice: 150 }, { symbol: "NFO:NIFTY-2026-11-03-29900-CE", netQty: -75, avgPrice: 1 }];
    const legs = priced(pos, { excluded: new Set(["NFO:NIFTY-2026-11-03-25500-PE"]) });
    const g = O.bookGreeks(legs);
    expect(g.excluded).toBe(1);
    expect(g.missing.map((l) => l.strike)).toEqual([29900]);
    const want = legs.filter((l) => l.inc && l.priced).reduce((t, l) => t + l.q * l.greeks.delta, 0);
    expect(g.delta).toBeCloseTo(want, 9);
    expect(legs.find((l) => l.strike === 26000).expiry).toBe("2026-11-24");
  });
  it("falls back to a quote with a solved IV", () => {
    const legs = O.priceBook(O.bookLegs([{ symbol: "NFO:NIFTY-2026-11-03-26000-CE", netQty: 75, avgPrice: 100 }], "NIFTY"), { quotes: new Map([["NFO:NIFTY-2026-11-03-26000-CE", { ltp: 120, bid: 119.9, ask: 120.1 }]]), spot: 26000, now: NOW });
    expect(legs[0]).toMatchObject({ priced: true, ivSolved: true });
    expect(black76(26000, 26000, legs[0].T, legs[0].iv, "CE")).toBeCloseTo(120, 1);
  });
  it("measures time to expiry to the reference session close it is given", () => {
    const pos = [{ symbol: "NFO:NIFTY-2026-11-03-26000-CE", netQty: 75, avgPrice: 100 }];
    const q = { quotes: new Map([["NFO:NIFTY-2026-11-03-26000-CE", { ltp: 120, bid: 119.9, ask: 120.1 }]]), spot: 26000, now: NOW };
    const normal = O.priceBook(O.bookLegs(pos, "NIFTY"), { ...q, close: "15:30" })[0].T;
    const early = O.priceBook(O.bookLegs(pos, "NIFTY"), { ...q, close: "13:30" })[0].T;
    expect(normal).toBeCloseTo(O.yearsToExpiry("2026-11-03", NOW, "15:30"), 12);
    expect(normal - early).toBeCloseTo(2 / (24 * 365), 6);
  });
  it("builds the scenario grid with labels and its worst cell", () => {
    const legs = priced(condorPositions);
    const g = O.scenarioGrid(legs, { ladder: "tight", axis: "iv", F: 26000 });
    expect(g.rows).toHaveLength(11);
    expect(g.cols.map((c) => c.label)).toEqual(["IV −5", "IV now", "IV +5"]);
    expect(g.rows[5].pct).toBe(0);
    expect(g.rows[0].price).toBeCloseTo(24700, 6);
    expect(g.rows[5].cells[1]).toBeCloseTo(O.scenarioPnl(legs, {}), 6);
    const all = g.rows.flatMap((r) => r.cells);
    expect(g.worst.v).toBe(Math.min(...all));
    expect(g.rows[g.worst.r].cells[g.worst.c]).toBe(g.worst.v);
    const d = O.scenarioGrid(legs, { axis: "days", firstDays: 6 });
    expect(d.cols.map((c) => c.days)).toEqual([0, 1, 3, 6]);
    expect(O.scenarioGrid(legs, { ladder: "sigma", sigmaPct: 2 }).rows.map((r) => r.pct)).toEqual([-4, -3, -2, -1, 0, 1, 2, 3, 4]);
  });
  it("finds breakevens on a sampled curve", () => {
    const r = O.curveRoots((x) => (x - 100) * (x - 200), [0, 50, 120, 180, 250]);
    expect(r[0]).toBeCloseTo(100, 0);
    expect(r[1]).toBeCloseTo(200, 0);
  });
});

describe("hedge plan", () => {
  const fut = { symbol: "NFO:NIFTY-2026-11-24-FUT", lot: 65, mark: 26000, expiry: "2026-11-24" };
  it("futures: rounds to lots and reports the residual", () => {
    const p = O.hedgePlan({ delta: -1310, S: 26000 }, { method: "fut", fut });
    expect(p.legs[0]).toMatchObject({ side: "BUY", lots: 20, units: 1300 });
    expect(p.residual).toBe(-10);
    expect(p.change.gamma).toBe(0);
    expect(O.hedgePlan({ delta: 162.5 }, { method: "fut", fut }).legs[0]).toMatchObject({ side: "SELL", lots: 3 });
    expect(O.hedgePlan({ delta: -162.5 }, { method: "fut", fut }).legs[0]).toMatchObject({ side: "BUY", lots: 3 });
    const none = O.hedgePlan({ delta: 30 }, { method: "fut", fut });
    expect(none.legs).toHaveLength(0);
    expect(none.notes[0]).toMatch(/Within one lot/);
  });
  const atm = { strike: 26000, expiry: "2026-11-03", lot: 75, ce: { symbol: "C", mark: 120, delta: 0.5, gamma: 0.001, theta: -15, vega: 12 }, pe: { symbol: "P", mark: 110, delta: -0.5, gamma: 0.001, theta: -14, vega: 12 } };
  it("ATM option: the right follows the direction and the side", () => {
    const buy = O.hedgePlan({ delta: 300 }, { method: "atm", side: "BUY", atm });
    expect(buy.legs[0]).toMatchObject({ right: "PE", side: "BUY", lots: 8 });
    expect(buy.premium).toBeCloseTo(-8 * 75 * 110, 6);
    const sell = O.hedgePlan({ delta: 300 }, { method: "atm", side: "SELL", atm });
    expect(sell.legs[0]).toMatchObject({ right: "CE", side: "SELL", lots: 8 });
    expect(sell.premium).toBeGreaterThan(0);
    expect(O.hedgePlan({ delta: -300 }, { method: "atm", side: "BUY", atm }).legs[0].right).toBe("CE");
    expect(O.hedgePlan({ delta: 300 }, { method: "atm", atm: { ...atm, pe: { ...atm.pe, delta: -0.01 } } }).error).toMatch(/ATM delta/);
  });
  it("gamma then delta flattens Γ within a lot and Δ within a futures lot", () => {
    const p = O.hedgePlan({ delta: 400, gamma: -0.6, S: 26000 }, { method: "gamma", atm, fut });
    expect(Math.abs(p.after.gamma)).toBeLessThanOrEqual(0.001 * 75);
    expect(Math.abs(p.after.delta)).toBeLessThanOrEqual(65 / 2);
    expect(p.legs[0]).toMatchObject({ kind: "OPT", side: "BUY", right: "PE" });
    expect(O.hedgePlan({ delta: 400, gamma: 0.00001, S: 26000 }, { method: "gamma", atm, fut }).notes.join()).toMatch(/already/);
  });
});

describe("exit plan", () => {
  const q = (bid, ask) => ({ bid, ask, ltp: (bid + ask) / 2 });
  const legs = [
    { symbol: "LC", kind: "OPT", q: 150, avg: 10, lot: 75, quote: q(5, 5.4), greeks: { delta: 0.1 } },
    { symbol: "SC", kind: "OPT", q: -150, avg: 40, lot: 75, quote: q(20, 20.4), greeks: { delta: 0.3 } },
    { symbol: "F", kind: "FUT", q: 75, avg: 26000, lot: 75, quote: q(26100, 26101) },
    { symbol: "SP", kind: "OPT", q: -150, avg: 38, lot: 75, quote: q(30, 30.4), greeks: { delta: -0.4 } },
  ];
  it("orders shorts by |Δ|, then longs, then futures", () => {
    expect(O.exitPlan(legs).orders.map((o) => o.symbol)).toEqual(["SP", "SC", "LC", "F"]);
    expect(O.exitPlan(legs).orders.map((o) => o.side)).toEqual(["BUY", "BUY", "SELL", "SELL"]);
  });
  it("prices at mid (toward a fill), touch and market, with slippage", () => {
    const mid = O.exitPlan(legs, { type: "mid" }).orders;
    expect(mid[0].price).toBe(30.2);
    expect(mid.find((o) => o.symbol === "F").price).toBe(26100.5);
    const touch = O.exitPlan(legs, { type: "touch" });
    expect(touch.orders[0].price).toBe(30.4);
    expect(touch.orders.find((o) => o.symbol === "LC").price).toBe(5);
    expect(touch.slippage).toBeCloseTo(0.2 * 150 * 3 + 0.5 * 75, 6);
    const mkt = O.exitPlan(legs, { type: "market" });
    expect(mkt.orders[0].price).toBeNull();
    expect(mkt.slippage).toBeCloseTo(touch.slippage, 6);
    expect(O.exitPlan([legs[1]], { type: "touch" }).pnl).toBeCloseTo((40 - 20.4) * 150, 6);
  });
  it("slices above the freeze quantity and exits partial whole lots", () => {
    const big = O.exitPlan([{ symbol: "B", kind: "OPT", q: -4000, avg: 1, lot: 75, freeze: 1800, quote: q(1, 1.1) }]).orders[0];
    expect(big.slices).toEqual([1800, 1800, 400]);
    // A part exit never sends more than asked: floor(lots · p); a leg that cannot be split is skipped, not exited in full.
    expect(O.exitPlan([{ ...legs[0], q: 225 }], { pct: 50 }).orders[0].qty).toBe(75);
    expect(O.exitPlan([{ ...legs[0], q: 300 }], { pct: 50 }).orders[0].qty).toBe(150);
    expect(O.exitPlan([{ ...legs[0], q: 300 }], { pct: 75 }).orders[0].qty).toBe(225);
    const one = O.exitPlan([{ ...legs[0], q: 75 }, { ...legs[1], q: 150 }], { pct: 50 });
    expect(one.orders.map((o) => o.qty)).toEqual([75]);
    expect(one.skipped.map((l) => l.symbol)).toEqual([legs[0].symbol]);
    expect(O.exitPlan([{ ...legs[0], q: 75 }], { pct: 25 }).orders).toEqual([]);
    expect(O.exitPlan([{ ...legs[0], q: 37 }], { pct: 50 }).skipped.length).toBe(1);
    expect(O.exitPlan([{ ...legs[0], q: 37 }]).orders[0].qty).toBe(37);
    expect(O.canPartExit({ q: -75, lot: 75 }, 50)).toBe(false);
    expect(O.canPartExit({ q: -75, lot: 75 }, 100)).toBe(true);
    expect(O.canPartExit({ q: 150, lot: 75 }, 50)).toBe(true);
    expect(O.canPartExit({ q: 150, lot: 75 }, 25)).toBe(false);
  });  it("never turns a quote-less leg into a market order unless market was chosen", () => {
    const bare = { symbol: "W", kind: "OPT", q: -75, avg: 2, lot: 75, quote: null, mark: null, greeks: { delta: -0.02 } };
    for (const type of ["mid", "touch"]) {
      const p = O.exitPlan([legs[1], bare], { type });
      const o = p.orders.find((x) => x.symbol === "W");
      expect(o).toMatchObject({ price: null, unpriced: true, market: false });
      expect(p.unpriced).toBe(1);
      expect(p.orders.find((x) => x.symbol === "SC")).toMatchObject({ unpriced: false, market: false });
    }
    const m = O.exitPlan([bare], { type: "market" });
    expect(m.orders[0]).toMatchObject({ price: null, market: true, unpriced: false });
    expect(m.unpriced).toBe(0);
  });
});

describe("book P&L", () => {
  it("counts today's closed legs in realised", () => {
    const pos = [
      { symbol: "NFO:NIFTY-2026-11-03-26400-CE", netQty: 0, avgPrice: 0, realisedPnl: 33.75, pnl: 33.75 },
      { symbol: "NFO:NIFTY-2026-11-03-26000-PE", netQty: -75, avgPrice: 100, realisedPnl: 0, pnl: 150 },
    ];
    const legs = O.bookLegs(pos, "NIFTY", { closed: true }).map((l) => (l.q ? { ...l, mark: 98 } : l));
    const p = O.bookPnl(legs);
    expect(p.realised).toBeCloseTo(33.75, 6);
    expect(p.unrealised).toBeCloseTo(150, 6);
    expect(p.total).toBeCloseTo(183.75, 6);
  });
  it("falls back to the broker's unrealised, never the total P&L, for an unpriced leg", () => {
    const pos = [{ symbol: "NFO:NIFTY-2026-11-03-26000-PE", netQty: -75, avgPrice: 100, realisedPnl: 500, pnl: 650 }];
    const l = O.bookLegs(pos, "NIFTY");
    expect(O.bookPnl(l)).toMatchObject({ realised: 500, unrealised: 150, total: 650 });
    const u = O.bookLegs([{ ...pos[0], unrealisedPnl: 140 }], "NIFTY");
    expect(O.bookPnl(u)).toMatchObject({ realised: 500, unrealised: 140, total: 640 });
  });
});

describe("structures", () => {
  const o = (right, strike, q) => ({ kind: "OPT", right, strike, q });
  const f = (q) => ({ kind: "FUT", q });
  it("names each recognised structure", () => {
    const cases = [
      [[o("CE", 100, 75)], "Long call"],
      [[o("PE", 100, -75)], "Short put"],
      [[o("CE", 100, -75), o("PE", 100, -75)], "Short straddle"],
      [[o("CE", 110, 75), o("PE", 90, 75)], "Long strangle"],
      [[o("CE", 100, 75), o("CE", 110, -75)], "Bull call spread"],
      [[o("CE", 100, -75), o("CE", 110, 75)], "Bear call spread"],
      [[o("PE", 100, -75), o("PE", 90, 75)], "Bull put spread"],
      [[o("PE", 100, 75), o("PE", 90, -75)], "Bear put spread"],
      [[o("CE", 100, 75), o("CE", 110, -150)], "Call ratio spread"],
      [[o("PE", 80, 75), o("PE", 90, -75), o("CE", 110, -75), o("CE", 120, 75)], "Iron condor"],
      [[o("PE", 90, 75), o("PE", 100, -75), o("CE", 100, -75), o("CE", 110, 75)], "Iron fly"],
      [[f(75)], "Long future"],
      [[f(75), o("CE", 110, -75)], "Covered call"],
      [[f(75), o("PE", 90, 75)], "Protective put"],
      [[f(75), o("CE", 100, -75), o("PE", 100, 75)], "Conversion"],
      [[f(-75), o("CE", 100, 75), o("PE", 100, -75)], "Reversal"],
      [[o("CE", 100, 75), o("CE", 110, -75), o("PE", 110, 75), o("PE", 100, -75)], "Long box"],
      [[o("CE", 100, 75), o("PE", 90, 75), o("CE", 130, -25)], "Custom · 3 legs"],
    ];
    for (const [legs, name] of cases) expect(O.detectStructure(legs).name).toBe(name);
    expect(O.detectStructure(cases[14][0]).locked).toBe(true);
    expect(O.detectStructure(cases[16][0]).locked).toBe(true);
    expect(O.detectStructure(cases[9][0]).locked).toBe(false);
  });
  it("reads the locked value of a conversion", () => {
    const legs = [{ kind: "FUT", q: 75, avg: 26050 }, { kind: "OPT", right: "CE", strike: 26000, q: -75, avg: 150 }, { kind: "OPT", right: "PE", strike: 26000, q: 75, avg: 95 }];
    expect(O.lockedValue(legs)).toBeCloseTo(75 * (26000 - 26050 + 150 - 95), 6);
    expect(O.lockedValue([legs[0], legs[1]])).toBeNull();
  });
});

describe("book warnings and settings", () => {
  it("flags unpriced, lot mismatch, tested shorts and excluded legs", () => {
    const legs = priced([...condorPositions, { symbol: "NFO:NIFTY-2026-11-03-26000-PE", netQty: -100, avgPrice: 50 }, { symbol: "NFO:NIFTY-2026-11-03-29900-CE", netQty: -75, avgPrice: 1 }], { excluded: new Set(["NFO:NIFTY-2026-11-03-25500-PE"]) });
    const w = O.bookWarnings(legs, { spot: 26000, now: NOW, stale: { age: "40 s" } });
    const ids = w.map((x) => x.id);
    expect(ids[0]).toBe("unpriced");
    expect(ids).toContain("lot");
    expect(ids).toContain("tested");
    expect(ids).toContain("excluded");
    expect(ids).toContain("stale");
    expect(w.find((x) => x.id === "lot").text).toMatch(/100 qty is not a multiple of lot 75/);
  });
  it("on expiry day warns of exercise STT, ELM and the MIS square-off", () => {
    const day = Date.UTC(2026, 10, 3, 9, 0); // 3 Nov, 14:30 IST
    const legs = O.priceBook(O.bookLegs([{ symbol: "NFO:NIFTY-2026-11-03-25800-CE", netQty: 75, avgPrice: 150, product: "INTRADAY" }, { symbol: "NFO:NIFTY-2026-11-03-26500-CE", netQty: -75, avgPrice: 5 }], "NIFTY"), { chains: new Map([["2026-11-03", mkChain("2026-11-03", 26000)]]), now: day });
    const w = O.bookWarnings(legs, { spot: 26000, now: day });
    expect(w.find((x) => x.id === "stt").text).toMatch(/≈ ₹23/);
    expect(w.find((x) => x.id === "elm").text).toMatch(/₹39000/);
    expect(w.some((x) => x.id === "mis")).toBe(false);
    expect(O.bookWarnings(legs, { spot: 26000, now: day + 30 * 60000 }).find((x) => x.id === "mis").text).toMatch(/15:20 · 20:00/);
    expect(O.misCountdown(day + 60 * 60000)).toBeNull();
  });
  it("hedge expiring before the shorts is flagged", () => {
    const legs = priced([{ symbol: "NFO:NIFTY-2026-11-24-26300-CE", netQty: -75, avgPrice: 80 }, { symbol: "NFO:NIFTY-2026-11-03-26200-CE", netQty: 75, avgPrice: 30 }]);
    expect(O.bookWarnings(legs, { spot: 26000, now: NOW }).find((x) => x.id === "hedge-early").text).toMatch(/3 Nov expires before 24 Nov/);
  });
  it("positionsConfig: defaults, unknown keys dropped, bad values replaced", () => {
    const d = O.positionsConfig(undefined);
    expect(d).toEqual({ ...O.POSITIONS_DEFAULTS, cols: [...O.POSITIONS_DEFAULTS.cols], hedge: { ...O.POSITIONS_DEFAULTS.hedge }, excluded: {} });
    const c = O.positionsConfig({ cols: ["pnl", "nope", "pnl", "gamma"], group: "x", ladder: "wide", axis: "days", lossLimit: "5000", exitType: "touch", hedge: { method: "gamma", side: "SELL" }, excluded: { "demo-paper": ["NFO:NIFTY-2026-11-03-26000-CE", "junk", 4], "bad acct!": ["NFO:NIFTY-2026-11-24-FUT"] }, chartSlot: true, extra: 1 });
    expect(c).toEqual({ cols: ["pnl", "gamma"], group: "expiry", closed: false, ladder: "wide", axis: "days", lossLimit: 5000, exitType: "touch", hedge: { method: "gamma", side: "SELL" }, excluded: { "demo-paper": ["NFO:NIFTY-2026-11-03-26000-CE"] }, chartSlot: true, deltaBand: null, curves: "exp", heatCols: "auto", bars: true, gauges: true, scope: "account" });
    expect(O.positionsConfig({ scope: "family" }).scope).toBe("family");
    expect(O.positionsConfig({ scope: "everyone" }).scope).toBe("account");
    expect(O.positionsConfig({ cols: [], lossLimit: -3 }).cols).toEqual([...O.POSITIONS_DEFAULTS.cols]);
    expect(O.positionsConfig({ lossLimit: -3 }).lossLimit).toBeNull();
  });
  it("positionsConfig: delta band, curves, heatmap columns, bars and gauges", () => {
    const c = O.positionsConfig({ deltaBand: "150", curves: "target", heatCols: 3, bars: false, gauges: false });
    expect(c).toMatchObject({ deltaBand: 150, curves: "target", heatCols: 3, bars: false, gauges: false });
    for (const bad of [0, -5, "x", Infinity, null]) expect(O.positionsConfig({ deltaBand: bad }).deltaBand).toBeNull();
    expect(O.positionsConfig({ curves: "all", heatCols: 4, bars: "yes" })).toMatchObject({ curves: "exp", heatCols: "auto", bars: true });
    expect(O.positionsConfig({ heatCols: 5 }).heatCols).toBe(5);
  });
  it("warns when net Δ leaves the delta band", () => {
    const legs = priced(condorPositions);
    expect(O.bookWarnings(legs, { spot: 26000, now: NOW, band: { delta: 312, band: 75 } }).find((x) => x.id === "band").text).toBe("Δ +312 outside ±75 band");
    expect(O.bookWarnings(legs, { spot: 26000, now: NOW, band: { delta: -40, band: 75 } }).some((x) => x.id === "band")).toBe(false);
  });
});

describe("positions round 2: book read-outs", () => {
  const condor = priced(condorPositions);
  const T1 = condor[0].T;
  const days1 = T1 * 365;
  const fExp = (legs) => (x) => O.scenarioPnl(legs, { dS: x / 26000 - 1, days: days1 });
  const range = (n = 240, lo = 24800, hi = 27200) => {
    const xs = Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n);
    for (const k of [25500, 25700, 26300, 26500]) xs.push(k);
    return [...new Set(xs)].sort((a, b) => a - b);
  };
  it("bookCurveStats: an iron condor's sampled max and min match strategyStats", () => {
    const st = O.bookCurveStats(fExp(condor), range());
    const asStrat = condor.map((l) => ({ kind: "OPT", right: l.right, strike: l.strike, side: l.q > 0 ? "BUY" : "SELL", lots: Math.abs(l.q) / 75, lotSize: 75, price: l.avg }));
    const exact = O.strategyStats(asStrat, 75, { spot: 26000 });
    expect(st.max).toBeCloseTo(exact.maxProfit, 0);
    expect(st.min).toBeCloseTo(exact.maxLoss, 0);
    expect(Math.abs(st.max - exact.maxProfit)).toBeLessThan(1);
    expect(st.unlimitedUp).toBe(false);
    expect(st.unlimitedDown).toBe(false);
    expect(st.roots).toHaveLength(2);
    expect(st.profitIntervals).toHaveLength(1);
    expect(st.approx).toBe(true);
  });
  it("bookCurveStats: a short call is unlimited down on the right; a calendar stays finite", () => {
    const sc = priced([{ symbol: "NFO:NIFTY-2026-11-03-26200-CE", netQty: -75, avgPrice: 60 }]);
    const s1 = O.bookCurveStats(fExp(sc), range());
    expect(s1.unlimitedDown).toBe(true);
    expect(s1.downSide).toBe("right");
    expect(s1.unlimitedUp).toBe(false);
    expect(s1.upSide).toBe(null);
    const sp = priced([{ symbol: "NFO:NIFTY-2026-11-03-26200-PE", netQty: -75, avgPrice: 60 }]);
    const s3 = O.bookCurveStats(fExp(sp), range());
    expect(s3.unlimitedDown).toBe(true);
    expect(s3.downSide).toBe("left");
    expect(s1.profitIntervals[0][0]).toBe(0);
    const cal = priced([{ symbol: "NFO:NIFTY-2026-11-03-26000-CE", netQty: -75, avgPrice: 60 }, { symbol: "NFO:NIFTY-2026-11-24-26000-CE", netQty: 75, avgPrice: 160 }]);
    const s2 = O.bookCurveStats(fExp(cal), range(240, 23000, 29000));
    expect(Number.isFinite(s2.max) && Number.isFinite(s2.min)).toBe(true);
    expect(s2.unlimitedDown).toBe(false);
    expect(s2.max).toBeGreaterThan(0);
  });
  it("book POP: a long ATM call below 50 %, a short strangle above, complements sum to 1", () => {
    const F = 26000;
    const iv = 12;
    const call = (x) => Math.max(0, x - 26000) - 200;
    const xs = range(400, 22000, 30000);
    const pc = O.bookPop(O.bookCurveStats(call, xs).profitIntervals, { forward: F, years: T1, ivPct: iv });
    expect(pc).toBeLessThan(0.5);
    const strangle = (x) => 150 - Math.max(0, x - 26300) - Math.max(0, 25700 - x);
    const st = O.bookCurveStats(strangle, xs);
    const ps = O.bookPop(st.profitIntervals, { forward: F, years: T1, ivPct: iv });
    expect(ps).toBeGreaterThan(0.5);
    const loss = O.bookPop(O.intervalsWhere(st.xs, st.vals, (v) => v <= 0), { forward: F, years: T1, ivPct: iv });
    expect(ps + loss).toBeCloseTo(1, 6);
    expect(O.bookPop([], { forward: F, years: T1, ivPct: iv })).toBeNull();
    expect(O.bookPop(st.profitIntervals, { forward: F, years: T1, ivPct: null })).toBeNull();
  });
  it("stressPnl matches scenarioPnl at e^(kσ√T) − 1", () => {
    const s = O.stressPnl(condor, 0.02, [-2, -1, 1, 2], { spot: 26000 });
    expect(s.map((x) => x.k)).toEqual([-2, -1, 1, 2]);
    for (const x of s) {
      const dS = Math.exp(x.k * 0.02) - 1;
      expect(x.v).toBeCloseTo(O.scenarioPnl(condor, { dS }), 9);
      expect(x.pct).toBeCloseTo(dS * 100, 9);
      expect(x.price).toBeCloseTo(26000 * (1 + dS), 6);
    }
    expect(O.stressPnl(condor, null)).toEqual([]);
  });
  it("pnlComposition sums to bookPnl().total", () => {
    const pos = [
      { symbol: "NFO:NIFTY-2026-11-03-26400-CE", netQty: 0, avgPrice: 0, realisedPnl: -1492, pnl: -1492 },
      { symbol: "NFO:NIFTY-2026-11-03-26000-PE", netQty: -75, avgPrice: 100, realisedPnl: 0 },
      { symbol: "NFO:NIFTY-2026-11-03-26600-CE", netQty: -75, avgPrice: 80, realisedPnl: 0 },
    ];
    const legs = O.bookLegs(pos, "NIFTY", { closed: true }).map((l) => (l.right === "PE" ? { ...l, mark: 90 } : l.q ? { ...l, mark: 150 } : l));
    const c = O.pnlComposition(legs);
    expect(c.won).toBeCloseTo(750, 6);
    expect(c.lost).toBeCloseTo(-5250, 6);
    expect(c.realised).toBeCloseTo(-1492, 6);
    expect(c.won + c.lost + c.realised).toBeCloseTo(O.bookPnl(legs).total, 6);
  });
  it("closeCharges: a short's exit is a buy (no STT); totals are non-negative", () => {
    const short = [{ kind: "OPT", right: "CE", strike: 26000, q: -75, mark: 100, symbol: "NFO:NIFTY-2026-11-03-26000-CE" }];
    const c = O.closeCharges(short);
    expect(c.stt).toBe(0);
    expect(c.stamp).toBeGreaterThan(0);
    expect(c.total).toBeGreaterThan(0);
    const long = O.closeCharges([{ ...short[0], q: 75 }]);
    expect(long.stt).toBeCloseTo(100 * 75 * O.rateDefault("opt.sttSell"), 9);
    expect(O.closeCharges([]).total).toBe(0);
  });
  it("bookMargin sums per-expiry estimates; greekScales share Δ/Γ and Θ/ν scales", () => {
    const m = O.bookMargin(condor, { now: NOW });
    expect(m.required).toBeGreaterThan(0);
    const asStrat = condor.map((l) => ({ kind: "OPT", right: l.right, strike: l.strike, side: l.q > 0 ? "BUY" : "SELL", lots: Math.abs(l.q), lotSize: 1, price: l.avg }));
    expect(m.required).toBeCloseTo(O.marginEstimate(asStrat, 1, { forward: condor[0].F, years: T1 }).required, 6);
    expect(O.bookMargin([])).toBeNull();
    const g = O.greekScales({ delta: 16, gamma1: -17, theta: 966, vega: -1591, lot: 75 });
    expect(g.M).toBe(150);
    expect(g.Mtv).toBeCloseTo(1.15 * 1591, 9);
    expect(g.outside).toBe(false);
    expect(O.greekScales({ delta: 312, band: 75 })).toMatchObject({ outside: true, M: 1.15 * 312 });
  });
  it("scenarioGrid: explicit columns, dedup at a near expiry, m95 ignores one outlier", () => {
    const g = O.scenarioGrid(condor, { axis: "iv", ivCols: [-10, -5, 0, 5, 10], F: 26000 });
    expect(g.cols.map((c) => c.dIv)).toEqual([-10, -5, 0, 5, 10]);
    expect(g.cols.map((c) => c.short)).toEqual(["\u221210", "\u22125", "now", "+5", "+10"]);
    expect(g.rows.every((r) => r.cells.length === 5)).toBe(true);
    const d = O.scenarioGrid(condor, { axis: "days", dayCols: [0, 1, 2, 3, 5], firstDays: 2 });
    expect(d.cols.map((c) => c.days)).toEqual([0, 1, 2]);
    expect(d.cols.map((c) => c.short)).toEqual(["Today", "+1d", "Exp"]);
    const all = g.rows.flatMap((r) => r.cells.map(Math.abs));
    expect(g.m95).toBeCloseTo(O.percentileOf(all, 0.95), 9);
    expect(g.m95).toBeLessThanOrEqual(Math.max(...all));
  });
  it("payoffYRange clamps the dominant side to 4× and names the clip", () => {
    const xs = [1, 2, 3, 4];
    const main = [-60000, -1000, 5000, 5000];
    const r = O.payoffYRange([main], { main, xs, pad: 0 });
    expect(r.yMin).toBe(-20000);
    expect(r.yMax).toBe(5000);
    expect(r.clip).toEqual({ side: "low", value: -60000, at: 1 });
    expect(O.payoffYRange([[-100, 100]], { pad: 0 }).clip).toBeNull();
  });
});

// ── Volatility (the #/vol page, PRD 05) ──
describe("volatility", () => {
  const RATE = RISK;
  const {
    VOL_READ_FOOTER,
    arbChecks,
    atmIvAt,
    b76Delta,
    forwardVol,
    hvPercentile,
    impliedForward,
    impliedVolB76,
    isMonthly,
    ivAtDelta,
    legPrice,
    realisedVol,
    skewMetrics,
    smilePoints,
    termRow,
    termShape,
    volRead,
  } = O;
  const NOW = Date.UTC(2026, 9, 29, 4, 0); // Thu 29 Oct 2026, 09:30 IST
  /** Days from NOW to 15:30 IST on `expiry`. */
  const daysTo = (e) => (Date.parse(`${e}T15:30:00+05:30`) - NOW) / 86_400_000;

  /** A synthetic chain priced by Black-76 at `vol(K)` (percent), discounted at `rate`, with a tight two-sided quote. */
  function chain({ F = 25000, years = 7 / 365, rate = RATE, vol = () => 15, step = 50, n = 30, spot = null, half = 0.05, expiry = "2026-11-05", lot = 75 } = {}) {
    const df = Math.exp(-rate * years);
    const atm = Math.round(F / step) * step;
    const rows = [];
    for (let i = -n; i <= n; i++) {
      const K = atm + i * step;
      const leg = (right) => {
        const p = black76(F, K, years, vol(K), right) * df;
        return { ltp: p, bid: Math.max(0, p - half), ask: p + half };
      };
      rows.push({ strike: K, ce: leg("CE"), pe: leg("PE") });
    }
    return { underlying: "NIFTY", expiry, underlyingLtp: spot ?? F * df, atmStrike: atm, lotSize: lot, rows };
  }

  describe("legPrice", () => {
    it("reads the mid, flags a wide spread, falls back to the LTP, and can be forced to the LTP", () => {
      expect(legPrice({ bid: 99, ask: 101, ltp: 90 })).toEqual({ price: 100, q: "mid" });
      expect(legPrice({ bid: 9, ask: 11, ltp: 10 })).toEqual({ price: 10, q: "wide" });
      expect(legPrice({ bid: 0, ask: 11, ltp: 10.5 })).toEqual({ price: 10.5, q: "ltp" });
      expect(legPrice({ bid: null, ask: null, ltp: 0 })).toEqual({ price: null, q: "none" });
      expect(legPrice(null)).toEqual({ price: null, q: "none" });
      expect(legPrice({ bid: 99, ask: 101, ltp: 90 }, "ltp")).toEqual({ price: 90, q: "ltp" });
    });
  });

  describe("impliedVolB76", () => {
    it("round-trips CE and PE across vols, tenors, moneyness and discounting", () => {
      let checked = 0;
      for (const sig of [5, 12, 40, 150])
        for (const T of [0.5 / 365, 7 / 365, 90 / 365])
          for (const kf of [0.9, 1, 1.1])
            for (const df of [1, 0.98])
              for (const right of ["CE", "PE"]) {
                const F = 25000;
                const K = F * kf;
                const price = black76(F, K, T, sig, right) * df;
                const intrinsic = right === "CE" ? Math.max(0, F - K) : Math.max(0, K - F);
                // Only where time value is measurable: a priceless far wing has no recoverable vol.
                if (price / df - intrinsic < 1e-3) continue;
                checked += 1;
                expect(Math.abs(impliedVolB76(price, F, K, T, right, df) - sig), `${sig} ${T} ${kf} ${df} ${right}`).toBeLessThan(1e-4);
              }
      expect(checked).toBeGreaterThan(40);
    });

    it("is null below intrinsic, at the upper bound, at price 0 and at T = 0", () => {
      expect(impliedVolB76(900, 26000, 25000, 0.05, "CE")).toBeNull();
      expect(impliedVolB76(26000, 26000, 25000, 0.05, "CE")).toBeNull();
      expect(impliedVolB76(25000 * 0.98, 26000, 25000, 0.05, "PE", 0.98)).toBeNull();
      expect(impliedVolB76(0, 25000, 25000, 0.05, "CE")).toBeNull();
      expect(impliedVolB76(100, 25000, 25000, 0, "CE")).toBeNull();
    });
  });

  describe("b76Delta", () => {
    it("is just over 0.5 for an ATM call and call − 1 for the put", () => {
      const c = b76Delta(25000, 25000, 30 / 365, 15, "CE");
      expect(c).toBeGreaterThan(0.5);
      expect(c).toBeLessThan(0.52);
      expect(b76Delta(25000, 25000, 30 / 365, 15, "PE")).toBeCloseTo(c - 1, 12);
      expect(b76Delta(25000, 25000, 30 / 365, null, "CE")).toBeNull();
    });
  });

  describe("impliedForward", () => {
    it("recovers F from parity with discounting, from the median of the 3 strikes nearest spot", () => {
      const years = 30 / 365;
      const c = chain({ F: 25012, years, half: 0 });
      // Mids exactly on Black-76, so every strike reads F; the median of 3 is F.
      const f = impliedForward(c, years, RATE);
      expect(f.source).toBe("parity");
      expect(f.F).toBeCloseTo(25012, 6);
      // One outlier among the 3 nearest is ignored by the median.
      const near = [...c.rows].sort((a, b) => Math.abs(a.strike - c.underlyingLtp) - Math.abs(b.strike - c.underlyingLtp));
      near[0].ce.bid += 30;
      near[0].ce.ask += 30;
      expect(impliedForward(c, years, RATE).F).toBeCloseTo(25012, 6);
    });

    it("falls back to spot with no two-sided quotes, and to null without spot", () => {
      const c = chain();
      for (const r of c.rows) r.ce.bid = r.pe.bid = 0;
      expect(impliedForward(c, 7 / 365)).toEqual({ F: c.underlyingLtp, source: "spot" });
      expect(impliedForward({ rows: [] }, 7 / 365)).toEqual({ F: null, source: null });
    });
  });

  describe("smilePoints", () => {
    const years = 14 / 365;
    it("reads a flat 15% smile back everywhere, with no parity gaps", () => {
      const c = chain({ years });
      const pts = smilePoints(c, { F: 25000, years, rate: RATE });
      const drawn = pts.filter((p) => p.otm);
      expect(drawn.length).toBeGreaterThan(30);
      for (const p of drawn) expect(Math.abs(p.otm.iv - 15)).toBeLessThan(1e-3);
      expect(pts.some((p) => p.gap)).toBe(false);
    });

    it("takes the PE below F and the CE at or above it", () => {
      const pts = smilePoints(chain({ years }), { F: 25000, years });
      expect(pts.find((p) => p.strike === 24950).otm.side).toBe("pe");
      expect(pts.find((p) => p.strike === 25000).otm.side).toBe("ce");
      expect(pts.find((p) => p.strike === 25000).callDelta).toBeGreaterThan(0.5);
    });

    it("marks tick-floor, below-intrinsic and out-of-range points, and a parity gap", () => {
      const c = chain({ years });
      const r = (k) => c.rows.find((x) => x.strike === k);
      Object.assign(r(23500).pe, { bid: 0, ask: 0.05, ltp: 0.05 });
      Object.assign(r(25500).ce, { bid: 0.02, ask: 0.04 }); // mid 0.03: tick floor
      const pts0 = smilePoints(c, { F: 25000, years });
      expect(pts0.find((p) => p.strike === 23500).out).toBe("tick");
      expect(pts0.find((p) => p.strike === 25500).out).toBe("tick");
      // Below intrinsic: a deep ITM call under F − K (it is not the OTM side, so read the leg).
      Object.assign(r(24000).ce, { bid: 900, ask: 901 });
      expect(smilePoints(c, { F: 25000, years }).find((p) => p.strike === 24000).ce.out).toBe("intrinsic");
      // Over 300%: a far call priced like a 400% vol.
      const px = black76(25000, 26000, years, 400, "CE");
      Object.assign(r(26000).ce, { bid: px - 0.05, ask: px + 0.05 });
      expect(smilePoints(c, { F: 25000, years }).find((p) => p.strike === 26000).out).toBe("range");
      // A gap: the CE bid IV over the PE ask IV.
      const g = black76(25000, 25100, years, 18, "CE") * Math.exp(-RATE * years);
      Object.assign(r(25100).ce, { bid: g - 0.05, ask: g + 0.05 });
      expect(smilePoints(c, { F: 25000, years }).find((p) => p.strike === 25100).gap).toBe(true);
      // Rounding noise is not a gap: a CE band a few hundredths of a vol point above the PE band.
      const n = black76(25000, 25200, years, 15.03, "CE") * Math.exp(-RATE * years);
      Object.assign(r(25200).ce, { bid: n, ask: n + 0.1 });
      Object.assign(r(25200).pe, { bid: r(25200).pe.bid, ask: r(25200).pe.bid });
      expect(smilePoints(c, { F: 25000, years }).find((p) => p.strike === 25200).gap).toBe(false);
    });
  });

  describe("atmIvAt", () => {
    const pt = (strike, iv) => ({ strike, ce: { iv }, pe: { iv } });
    it("uses an exact strike, interpolates between brackets, and one side within one step", () => {
      const pts = [pt(100, 20), pt(110, 10)];
      expect(atmIvAt(pts, 100)).toBe(20);
      expect(atmIvAt(pts, 105)).toBeCloseTo(15, 12);
      expect(atmIvAt(pts, 112)).toBe(10);
      expect(atmIvAt(pts, 125)).toBeNull();
      expect(atmIvAt([{ strike: 100, ce: { iv: 10 }, pe: { iv: 12 } }], 100)).toBe(11);
    });
    it("accepts a lone strike within 0.5% of the forward", () => {
      expect(atmIvAt([pt(26000, 14)], 26001)).toBe(14);
      expect(atmIvAt([pt(26000, 14)], 26200)).toBeNull();
    });
  });

  describe("ivAtDelta and skewMetrics", () => {
    const years = 30 / 365;
    it("reads a known risk reversal from a linear skew and a positive fly from a convex smile", () => {
      const F = 25000;
      const linear = (K) => 15 - 20 * Math.log(K / F); // puts richer
      const pts = smilePoints(chain({ F, years, vol: linear, n: 60 }), { F, years });
      const s = skewMetrics(pts, atmIvAt(pts, F));
      expect(s.rr25).toBeGreaterThan(1);
      expect(s.put25.strike).toBeLessThan(F);
      expect(s.call25.strike).toBeGreaterThan(F);
      // The put and call 25Δ strikes sit about symmetrically in log-moneyness: rr ≈ 20·(ln Kc − ln Kp).
      expect(s.rr25).toBeCloseTo(20 * (Math.log(s.call25.strike / F) - Math.log(s.put25.strike / F)), 0);
      const convex = (K) => 15 + 400 * Math.log(K / F) ** 2;
      const p2 = smilePoints(chain({ F, years, vol: convex, n: 60 }), { F, years });
      expect(skewMetrics(p2, atmIvAt(p2, F)).bf25).toBeGreaterThan(0.1);
    });

    it("is null on a chain too narrow for 25Δ", () => {
      const pts = smilePoints(chain({ years, n: 2 }), { F: 25000, years });
      expect(ivAtDelta(pts, -0.25)).toBeNull();
      const s = skewMetrics(pts, 15);
      expect(s.rr25).toBeNull();
      expect(s.bf25).toBeNull();
    });
  });

  describe("ivAtMny, smileSpark and twoSigma (vol round 2)", () => {
    const P = (strike, m, iv) => ({ strike, m, otm: iv === null ? null : { iv } });
    const pts = [P(100, -2, 18), P(101, -1, 16), P(102, 0, 14), P(103, 1, 15), P(104, 2, 16)];
    it("interpolates linearly in moneyness and is monotone between the points", () => {
      expect(O.ivAtMny(pts, 0)).toBe(14);
      expect(O.ivAtMny(pts, -1.5)).toBeCloseTo(17, 9);
      expect(O.ivAtMny(pts, 0.5)).toBeCloseTo(14.5, 9);
      let prev = Infinity;
      for (let m = -2; m <= 0; m += 0.25) {
        const v = O.ivAtMny(pts, m);
        expect(v).toBeLessThanOrEqual(prev + 1e-12);
        prev = v;
      }
    });
    it("is null outside the loaded range and across a gap of more than 2 strike steps", () => {
      expect(O.ivAtMny(pts, -2.5)).toBeNull();
      expect(O.ivAtMny(pts, 2.1)).toBeNull();
      expect(O.ivAtMny(pts, null)).toBeNull();
      const gap = [P(100, -2, 18), P(101, -1, null), P(102, 0, null), P(103, 1, null), P(104, 2, 16)];
      expect(O.ivAtMny(gap, 0)).toBeNull();
      const small = [P(100, -2, 18), P(101, -1, null), P(102, 0, 14)];
      expect(O.ivAtMny(small, -1)).toBeCloseTo(16, 9);
    });
    it("sparkline: n points ascending in m inside the window; a 1-point chain gives []", () => {
      const s = O.smileSpark(pts, { n: 9 });
      expect(s).toHaveLength(9);
      for (let i = 1; i < s.length; i++) expect(s[i].m).toBeGreaterThan(s[i - 1].m);
      expect(s[0]).toEqual({ m: -2, iv: 18 });
      const w = O.smileSpark(pts, { n: 5, half: 1 });
      expect(w.map((x) => x.m)).toEqual([-1, -0.5, 0, 0.5, 1]);
      expect(O.smileSpark([P(100, 0, 14)])).toEqual([]);
      expect(O.smileSpark([])).toEqual([]);
    });
    it("twoSigma is symmetric in log space around the forward and wider than 1σ", () => {
      const r = O.twoSigma(25000, 16, 30 / 365);
      expect(Math.log(r.hi / 25000)).toBeCloseTo(-Math.log(r.lo / 25000), 12);
      expect(Math.log(r.hi / 25000)).toBeCloseTo(2 * 0.16 * Math.sqrt(30 / 365), 12);
      expect(O.twoSigma(25000, null, 0.1)).toBeNull();
      expect(O.twoSigma(0, 15, 0.1)).toBeNull();
      // The same quarter-day floor as the 1σ maths.
      expect(O.twoSigma(25000, 15, 0)).toEqual(O.twoSigma(25000, 15, 0.25 / 365));
    });
  });

  describe("termRow", () => {
    it("prices the straddle, ₹/lot, breakevens, ratio and hedge put; dims expiry day", () => {
      const e = "2026-11-12";
      const years = daysTo(e) / 365;
      const c = chain({ F: 25000, years, expiry: e, n: 40 });
      const r = termRow(c, { now: NOW, hedgePct: 97 });
      expect(r.F).toBeCloseTo(25000, 4);
      expect(r.atmStrike).toBe(25000);
      expect(r.atmIv).toBeCloseTo(15, 3);
      const ce = (black76(25000, 25000, years, 15, "CE") * Math.exp(-RATE * years));
      expect(r.straddle).toBeCloseTo(2 * ce, 6);
      expect(r.rupee).toBeCloseTo(r.straddle * 75, 6);
      expect(r.perDay).toBeCloseTo(r.rupee / daysTo(e), 6);
      expect(r.beLo).toBeCloseTo(25000 - r.straddle, 6);
      expect(r.beHi).toBeCloseTo(25000 + r.straddle, 6);
      expect(r.ratio).toBeGreaterThan(0.77);
      expect(r.ratio).toBeLessThan(0.82);
      expect(r.hedge.strike).toBe(24250);
      expect(r.hedge.annualPct).toBeCloseTo((r.hedge.pts / r.F) * 100 * (365 / daysTo(e)), 6);
      expect(r.weekday).toBe("Thu");
      expect(r.dim).toBe(false);
      expect(termRow({ ...c, lotSize: null }, { now: NOW }).rupee).toBeNull();
      // Expiry day: dimmed, and ₹/lot a day floors the days at 0.25.
      const today = termRow({ ...chain({ years: 0.1 / 365, expiry: "2026-10-29" }) }, { now: NOW });
      expect(today.dim).toBe(true);
      expect(today.perDay).toBeCloseTo(today.rupee / 0.25, 6);
      // The evening before expiry (16:30 IST) is under a day away but not expiry day: not dimmed.
      const eve = termRow(chain({ years: 23 / 24 / 365, expiry: "2026-11-03" }), { now: Date.parse("2026-11-02T11:00:00Z") });
      expect(eve.days).toBeLessThan(1);
      expect(eve.dim).toBe(false);
    });
  });

  describe("forwardVol and termShape", () => {
    it("gives the forward vol, an inversion, and nothing under half a day apart", () => {
      expect(forwardVol({ atmIv: 12, years: 0.02 }, { atmIv: 15, years: 0.1 }).vol).toBeCloseTo(Math.sqrt((0.15 ** 2 * 0.1 - 0.12 ** 2 * 0.02) / 0.08) * 100, 10);
      expect(forwardVol({ atmIv: 30, years: 0.05 }, { atmIv: 12, years: 0.1 })).toEqual({ vol: null, inverted: true });
      expect(forwardVol({ atmIv: 12, years: 0.1 }, { atmIv: 15, years: 0.1 + 0.2 / 365 })).toEqual({ vol: null, inverted: false });
    });

    it("labels contango, backwardation, flat, humped and too few; expiry-day rows are left out", () => {
      const r = (...ivs) => ivs.map((atmIv) => ({ atmIv, dim: false }));
      expect(termShape(r(12, 13, 14)).kind).toBe("contango");
      expect(termShape(r(16, 14, 13)).kind).toBe("backwardation");
      expect(termShape(r(14, 14.2, 14.1)).kind).toBe("flat");
      expect(termShape(r(13, 15, 13.2)).kind).toBe("humped");
      expect(termShape(r(13)).kind).toBe("insufficient");
      expect(termShape([{ atmIv: 30, dim: true }, ...r(13, 14)]).kind).toBe("contango");
      expect(termShape(r(12, 14)).slope).toBeCloseTo(2, 12);
    });
  });

  describe("realisedVol and hvPercentile", () => {
    it("is 0 for a constant return, a hand value for an alternating series, null when short", () => {
      const steady = Array.from({ length: 30 }, (_, i) => 100 * 1.01 ** i);
      expect(realisedVol(steady, 20)).toBeCloseTo(0, 9);
      const alt = [100, 101, 100, 101, 100];
      const a = Math.log(1.01);
      // Returns +a, −a, +a, −a: mean 0, sample variance 4a²/3.
      expect(realisedVol(alt, 4)).toBeCloseTo(Math.sqrt((4 * a * a) / 3) * Math.sqrt(252) * 100, 9);
      expect(realisedVol(alt, 5)).toBeNull();
    });

    it("needs 120 earlier values and reads 100 at the series max", () => {
      expect(hvPercentile(Array.from({ length: 100 }, (_, i) => 100 + i), 20)).toBeNull();
      // Quiet then a final burst: today's HV20 is the highest.
      const closes = [100];
      for (let i = 1; i < 300; i++) closes.push(closes[i - 1] * (1 + (i % 2 ? 1 : -1) * (i > 290 ? 0.03 : 0.005 + 0.0001 * (i % 7))));
      const p = hvPercentile(closes, 20, 252);
      expect(p.pct).toBe(100);
      expect(p.count).toBeGreaterThanOrEqual(120);
    });
  });

  describe("arbChecks", () => {
    const years = 7 / 365;
    const df = Math.exp(-RATE * years);
    it("finds nothing on a clean chain", () => {
      const hits = arbChecks(chain({ years }), { df });
      expect(hits.length).toBe(0);
      expect(hits.strikes).toBe(41);
    });

    it("detects a planted vertical, butterfly, buy box and sell box, with their edges", () => {
      const c = chain({ years, half: 0.1 });
      const r = (k) => c.rows.find((x) => x.strike === k);
      // Vertical: the 25100 CE bid above the 25050 CE ask.
      const v = chain({ years, half: 0.1 });
      const vr = (k) => v.rows.find((x) => x.strike === k);
      vr(25100).ce.bid = vr(25050).ce.ask + 2;
      vr(25100).ce.ask = vr(25100).ce.bid + 0.2;
      const vh = arbChecks(v, { df }).find((h) => h.kind === "Call vertical");
      expect(vh.edge).toBeCloseTo(2, 9);
      expect(vh.legs.map((l) => `${l.side} ${l.strike}`)).toEqual(["BUY 25050", "SELL 25100"]);
      // Butterfly: lift the 24900 PE bid well above the wings' average.
      const b = chain({ years, half: 0.1 });
      const br = (k) => b.rows.find((x) => x.strike === k);
      br(24900).pe.bid += 5;
      br(24900).pe.ask += 5;
      const fly = arbChecks(b, { df }).find((h) => h.kind === "Butterfly" && h.legs[1].strike === 24900 && h.legs[1].right === "PE");
      expect(fly.edge).toBeCloseTo(2 * br(24900).pe.bid - br(24850).pe.ask - br(24950).pe.ask, 9);
      expect(fly.legs[1].qty).toBe(2);
      // Buy box: make the 25000/25050 box cheap.
      r(25000).ce.ask -= 3;
      r(25000).ce.bid -= 3;
      const bb = arbChecks(c, { df }).find((h) => h.kind === "Box (buy)" && h.legs[0].strike === 25000);
      const cost = r(25000).ce.ask - r(25050).ce.bid + r(25050).pe.ask - r(25000).pe.bid;
      expect(bb.edge).toBeCloseTo(50 * df - cost, 9);
      expect(bb.note).toBe("depends on rate");
      // Sell box: make the 24800/24850 box rich.
      r(24800).ce.bid += 3;
      r(24800).ce.ask += 3;
      const sb = arbChecks(c, { df }).find((h) => h.kind === "Box (sell)" && h.legs[0].strike === 24800);
      const proceeds = r(24800).ce.bid - r(24850).ce.ask + r(24850).pe.bid - r(24800).pe.ask;
      expect(sb.edge).toBeCloseTo(proceeds - 50 * df, 9);
      // Sorted by edge, descending.
      const all = arbChecks(c, { df }).map((h) => h.edge);
      expect([...all].sort((x, y) => y - x)).toEqual(all);
    });

    it("lists calendar variance inversions from term rows", () => {
      const hits = arbChecks(chain({ years }), { df, term: [{ expiry: "a", atmIv: 30, years: 0.02 }, { expiry: "b", atmIv: 12, years: 0.06 }] });
      expect(hits.map((h) => h.kind)).toEqual(["Calendar variance"]);
    });
  });

  describe("volRead", () => {
    const base = { straddle: 300, straddlePct: 1.2, move: 380, movePct: 1.5, expiryLabel: "5 Nov", days: 7 };
    const lines = (m) => volRead(m).flatMap((p) => p.lines);
    it("adds each line at its threshold and drops it under", () => {
      expect(lines({ ...base, vrp: 2 }).some((l) => l.startsWith("IV is 2.0 pts over 20-day"))).toBe(true);
      expect(lines({ ...base, vrp: 1.9 }).some((l) => l.includes("20-day"))).toBe(false);
      expect(lines({ ...base, vrp: -1 }).some((l) => l.includes("under 20-day"))).toBe(true);
      expect(lines({ ...base, wingPut16: 3 }).some((l) => l.startsWith("The 16Δ put"))).toBe(true);
      expect(lines({ ...base, wingPut16: 2.9 }).some((l) => l.startsWith("The 16Δ put"))).toBe(false);
      expect(lines({ ...base, days: 0.5 })).toContain("Expiry day: time value decays fastest now.");
      expect(lines({ ...base, rr25: 2 }).some((l) => l.startsWith("Puts carry 2.0"))).toBe(true);
      expect(lines({ ...base, rr25: -2 }).some((l) => l.startsWith("Calls carry 2.0"))).toBe(true);
      expect(lines({ ...base, rr25: 1.9 }).some((l) => l.includes("more IV than"))).toBe(false);
      expect(lines({ ...base, shape: "backwardation" }).some((l) => l.includes("(inverted)"))).toBe(true);
      expect(lines({ hits: 0 })).toContain("No executable violations at bid/ask.");
      expect(lines({ hits: 3, gapCount: 2 }).some((l) => l.startsWith("3 executable violations"))).toBe(true);
      expect(lines({ futGaps: [{ label: "24 Nov", futGap: 30, F: 25000 }] })).toContain("24 Nov future is 30.0 pts over the parity forward.");
      expect(lines({ futGaps: [{ label: "24 Nov", futGap: 20, F: 25000 }] }).some((l) => l.includes("future"))).toBe(false);
      const hedge = { pct: 97, strike: 24250, pts: 40, pctF: 0.16, annualPct: 8.3 };
      expect(lines({ hedge, cheapestHedge: { expiry: "x", label: "24 Nov", annualPct: 4 }, expiry: "y" })).toContain("Cheapest per year among loaded expiries: 24 Nov at 4.0%.");
      expect(lines({ hedge, cheapestHedge: { expiry: "y", annualPct: 4 }, expiry: "y" }).some((l) => l.startsWith("Cheapest"))).toBe(false);
    });

    it("emits nothing without inputs, and always ends with the footer", () => {
      const r = volRead({ vrp: null, rr25: null });
      expect(r.slice(0, 4).every((p) => p.lines.length === 0)).toBe(true);
      expect(r.map((p) => p.persona)).toEqual(["Buyer", "Seller", "Hedger", "Arbitrageur", "Note"]);
      expect(r[4].lines).toEqual([VOL_READ_FOOTER]);
    });
  });

  describe("isMonthly", () => {
    it("is the last listed expiry in its month, across a year boundary", () => {
      const ex = ["2026-12-22", "2026-12-29", "2027-01-05", "2027-01-26", "2027-02-23"];
      expect(ex.map((e) => isMonthly(e, ex))).toEqual([false, true, false, true, true]);
    });
  });
});

// ── Arbitrage and charges (PRD 06) ──
describe("charges model (PRD 06 §6)", () => {
  const conv = [
    { kind: "FUT", side: "BUY", price: 26600.5, units: 75, symbol: "NFO:NIFTY-2026-11-24-FUT" },
    { kind: "OPT", side: "SELL", right: "CE", strike: 26400, price: 450.15, units: 75, symbol: "NFO:NIFTY-2026-11-24-26400-CE" },
    { kind: "OPT", side: "BUY", right: "PE", strike: 26400, price: 254.45, units: 75, symbol: "NFO:NIFTY-2026-11-24-26400-PE" },
  ];

  it("orderCharges: the worked conversion, line by line, totals ₹226.90 (3.03 pts a unit)", () => {
    const [f, c, p] = conv.map((l) => A.orderCharges(l));
    expect(f.turnover).toBeCloseTo(1995037.5, 6);
    expect(c.turnover).toBeCloseTo(33761.25, 6);
    expect(p.turnover).toBeCloseTo(19083.75, 6);
    expect(f.brokerage + c.brokerage + p.brokerage).toBeCloseTo(60, 6);
    expect(f.brokerage).toBe(20); // min(20, 0.03% of 1995037.50 = 598.51)
    expect(f.stt + c.stt + p.stt).toBeCloseTo(50.64, 2);
    expect(f.txn + c.txn + p.txn).toBeCloseTo(53.03, 2);
    expect(f.sebi + c.sebi + p.sebi).toBeCloseTo(2.05, 2);
    expect(f.stamp + c.stamp + p.stamp).toBeCloseTo(40.47, 2);
    expect(f.gst + c.gst + p.gst).toBeCloseTo(20.71, 2);
    const total = f.total + c.total + p.total;
    expect(total).toBeCloseTo(226.9, 2);
    expect(total / 75).toBeCloseTo(3.03, 2);
  });

  it("BSE: options txn 0.0325%, futures txn 0", () => {
    const o = A.orderCharges({ kind: "OPT", side: "BUY", price: 200, units: 20, exchange: "BSE" });
    expect(o.txn).toBeCloseTo(4000 * 0.000325, 9);
    expect(o.stamp).toBeCloseTo(4000 * 0.00003, 9);
    expect(o.stt).toBe(0);
    expect(A.orderCharges({ kind: "FUT", side: "BUY", price: 80000, units: 20, exchange: "BSE" }).txn).toBe(0);
    expect(A.exchangeOfSymbol("BFO:SENSEX-2026-11-06-80000-PE")).toBe("BSE");
    expect(A.exchangeOfSymbol("NFO:NIFTY-2026-11-24-FUT")).toBe("NSE");
  });

  it("GST is on brokerage + txn + SEBI only (not STT or stamp)", () => {
    const o = A.orderCharges({ kind: "OPT", side: "SELL", price: 100, units: 75 });
    expect(o.gst).toBeCloseTo(0.18 * (o.brokerage + o.txn + o.sebi), 9);
    expect(o.stt).toBeGreaterThan(0);
    expect(o.total).toBeCloseTo(o.brokerage + o.stt + o.txn + o.sebi + o.stamp + o.gst, 9);
  });

  it("brokerage models: perLot, pct (cap hit and not), zero; a missing price is null", () => {
    const leg = { kind: "OPT", side: "BUY", price: 100, units: 225, lots: 3 };
    expect(A.orderCharges(leg, { ...A.DEFAULT_PROFILE, brokerage: "perLot", value: 10 }).brokerage).toBe(30);
    expect(A.orderCharges(leg, { ...A.DEFAULT_PROFILE, brokerage: "pct", pct: 0.0003, cap: 20 }).brokerage).toBeCloseTo(22500 * 0.0003, 9);
    expect(A.orderCharges({ ...leg, price: 1000 }, { ...A.DEFAULT_PROFILE, brokerage: "pct", pct: 0.0003, cap: 20 }).brokerage).toBe(20);
    const z = A.orderCharges(leg, { ...A.DEFAULT_PROFILE, brokerage: "zero" });
    expect(z.brokerage).toBe(0);
    expect(z.gst).toBeCloseTo(0.18 * (z.txn + z.sebi), 9);
    expect(A.orderCharges({ ...leg, price: null })).toBeNull();
    expect(A.orderCharges({ ...leg, units: 0 })).toBeNull();
  });

  it("one rate table: user overrides apply on a copy, bad values are ignored", () => {
    const r = A.ratesWith({ "opt.sttSell": 0.001, gst: 5, "nope.x": 1 });
    expect(r.opt.sttSell).toBe(0.001);
    expect(r.gst).toBe(RATES.gst);
    expect(RATES.opt.sttSell).toBe(0.0015);
    expect(A.rateDefault("fut.txn.NSE")).toBe(0.0000173);
    // Overrides apply to the reference table the page passes in.
    const base = { ...RATES, opt: { ...RATES.opt, sttSell: 0.002 } };
    expect(A.ratesWith({}, base).opt.sttSell).toBe(0.002);
    expect(A.rateDefault("opt.sttSell", base)).toBe(0.002);
  });

  it("exerciseStt: long ITM pays on intrinsic; short and OTM pay nothing", () => {
    const long = { kind: "OPT", side: "BUY", right: "CE", strike: 26400, units: 75 };
    expect(A.exerciseStt([long], 26628)).toBeCloseTo(0.0015 * 228 * 75, 9);
    expect(A.exerciseStt([{ ...long, side: "SELL" }], 26628)).toBe(0);
    expect(A.exerciseStt([long], 26300)).toBe(0);
    expect(A.exerciseStt([{ ...long, right: "PE" }], 26300)).toBeCloseTo(0.0015 * 100 * 75, 9);
  });

  it("structureCharges: hold to expiry adds exercise brokerage (on/off); close uses opposite touches + exit spread", () => {
    const on = A.structureCharges(conv, A.DEFAULT_PROFILE, { hold: "expiry", settle: 26628 });
    expect(on.entry.total).toBeCloseTo(226.9, 2);
    expect(on.exerciseStt).toBe(0); // the long PE expires OTM
    expect(on.exercised).toBe(1); // the short CE is assigned
    expect(on.total).toBeCloseTo(226.9 + 20 * 1.18, 2); // ₹20 exercise brokerage + 18% GST on it
    expect(on.exit.gst).toBeCloseTo(0.18 * on.exit.brokerage, 9);
    const off = A.structureCharges(conv, { ...A.DEFAULT_PROFILE, exerciseBrokerage: false }, { hold: "expiry", settle: 26628 });
    expect(off.total).toBeCloseTo(226.9, 2);
    const quotes = new Map([
      ["NFO:NIFTY-2026-11-24-FUT", { bid: 26600, ask: 26600.5 }],
      ["NFO:NIFTY-2026-11-24-26400-CE", { bid: 450.15, ask: 450.25 }],
      ["NFO:NIFTY-2026-11-24-26400-PE", { bid: 254.35, ask: 254.45 }],
    ]);
    const close = A.structureCharges(conv, A.DEFAULT_PROFILE, { hold: "close", exitQuotes: quotes });
    const exitF = A.orderCharges({ kind: "FUT", side: "SELL", price: 26600, units: 75 });
    const exitC = A.orderCharges({ kind: "OPT", side: "BUY", price: 450.25, units: 75 });
    const exitP = A.orderCharges({ kind: "OPT", side: "SELL", price: 254.35, units: 75 });
    expect(close.exit.total).toBeCloseTo(exitF.total + exitC.total + exitP.total, 9);
    expect(close.exitSpread).toBeCloseTo((0.5 + 0.1 + 0.1) * 75, 9);
    expect(close.exerciseStt).toBe(0);
    expect(close.total).toBeCloseTo(close.entry.total + close.exit.total + close.exitSpread, 9);
  });
});

/** A parity-consistent chain: C − P = (F − K)/g at every strike, spread 0.10 on each leg. */
function arbChain({ F = 26628, rate = 0.06, days = 27, strikes = [26200, 26300, 26400, 26500, 26600, 26700, 26800, 26900, 27000], spot = 26472.85, iv = 0.12, half = 0.05 } = {}) {
  const T = days / 365;
  const g = Math.exp(rate * T);
  const rows = strikes.map((K) => {
    const c = black76(F, K, T, iv * 100, "CE") / g;
    const p = c - (F - K) / g;
    const q = (m, right) => ({ symbol: `NFO:NIFTY-2026-11-24-${K}-${right}`, bid: Math.round((m - half) * 100) / 100, ask: Math.round((m + half) * 100) / 100, ltp: m, volume: 1000, oi: 5000, iv: 12 });
    return { strike: K, ce: q(c, "CE"), pe: q(p, "PE") };
  });
  return { underlying: "NIFTY", expiry: "2026-11-24", underlyingLtp: spot, lotSize: 75, rows };
}

describe("arbitrage maths (PRD 06 §7)", () => {
  it("carryFactor and annualise (null on capital ≤ 0 or expiry day)", () => {
    expect(A.carryFactor(0.06, 27)).toBeCloseTo(Math.exp((0.06 * 27) / 365), 12);
    expect(A.carryFactor(0.06, 0)).toBe(1);
    expect(A.carryFactor(null, 27)).toBeNull();
    expect(A.annualise(100, 10000, 36.5)).toBeCloseTo(0.1, 12);
    expect(A.annualise(100, 0, 30)).toBeNull();
    expect(A.annualise(100, -5, 30)).toBeNull();
    expect(A.annualise(100, 1000, 0.5)).toBeNull();
  });

  it("impliedForward: the median of carried synthetics, n < 2 → null (no spot fallback)", () => {
    const c = arbChain();
    const f = A.impliedForward(c, { rate: 0.06, days: 27 });
    expect(f.forward).toBeCloseTo(26628, 0);
    expect(f.n).toBeGreaterThanOrEqual(5);
    expect(f.lo).toBeLessThanOrEqual(f.forward);
    expect(f.hi).toBeGreaterThanOrEqual(f.forward);
    expect(f.atm).toBe(26600);
    const one = { ...c, rows: c.rows.map((r, i) => (i === 3 ? r : { ...r, pe: { ...r.pe, bid: 0 } })) };
    expect(A.impliedForward(one, { rate: 0.06, days: 27 })).toBeNull();
    // The vol page's form is unchanged.
    expect(A.impliedForward(c, 27 / 365, 0.06).source).toBe("parity");
  });

  it("impliedForward applies the carry: a deep ITM strike matches only when discounted", () => {
    const c = arbChain({ strikes: [25000, 25100] , spot: 25050 });
    const carried = A.impliedForward(c, { rate: 0.06, days: 27 });
    const flat = A.impliedForward(c, { rate: 0, days: 27 });
    expect(carried.forward).toBeCloseTo(26628, 0);
    expect(Math.abs(flat.forward - 26628)).toBeGreaterThan(5);
  });

  it("optionsImpliedRate: the box mids give the chain's rate; d < 1 → null", () => {
    const c = arbChain({ half: 0.0 + 0.05 });
    const r = A.optionsImpliedRate(c, { days: 27 });
    // Simple ACT/365 from a continuous 6%: (e^(0.06·27/365) − 1)·365/27.
    expect(r).toBeCloseTo((Math.exp((0.06 * 27) / 365) - 1) * (365 / 27), 3);
    expect(A.optionsImpliedRate(c, { days: 0.5 })).toBeNull();
    expect(A.optionsImpliedRate({ rows: [] }, { days: 27 })).toBeNull();
  });

  const one = (ce, pe, K = 26400) => ({ strike: K, ce: { symbol: `NFO:NIFTY-2026-11-24-${K}-CE`, volume: 10, oi: 10, ...ce }, pe: { symbol: `NFO:NIFTY-2026-11-24-${K}-PE`, volume: 10, oi: 10, ...pe } });
  const fut = { symbol: "NFO:NIFTY-2026-11-24-FUT", bid: 26600, ask: 26600.5, lotSize: 75 };
  const chainAt = (row) => ({ underlyingLtp: 26472.85, lotSize: 75, rows: [row, one({ bid: 400, ask: 400.1 }, { bid: 300, ask: 300.1 }, 26500)] });

  it("parityRows: conversion and reversal gross, financing sign and net", () => {
    const row = one({ bid: 450.15, ask: 450.25 }, { bid: 254.35, ask: 254.45 });
    const g = Math.exp((0.06 * 27) / 365);
    const res = A.parityRows(chainAt(row), { fut, rate: 0.06, days: 27, lots: 2, window: 5 });
    const r = res.rows.find((x) => x.strike === 26400);
    expect(res.U).toBe(150);
    expect(r.rev.grossPts).toBeCloseTo(200 - 195.9, 9);
    expect(r.rev.financingPts).toBeCloseTo(195.9 * (g - 1), 9);
    expect(r.rev.financingPts).toBeGreaterThan(0); // a debit pays interest
    expect(r.conv.grossPts).toBeCloseTo(195.7 - 200.5, 9);
    expect(r.conv.financingPts).toBeCloseTo(-195.7 * (g - 1), 9);
    expect(r.conv.financingPts).toBeLessThan(0); // a credit earns it
    for (const s of [r.rev, r.conv]) {
      expect(s.net).toBeCloseTo((s.grossPts - s.financingPts) * 150 - s.chargesTotal, 6);
      expect(s.breakEvenPts).toBeCloseTo((s.chargesTotal + s.financingRs) / 150, 9);
      expect(s.legs.map((l) => l.kind)).toContain("FUT");
    }
    expect(r.rev.legs.map((l) => `${l.side} ${l.kind}`)).toEqual(["BUY OPT", "SELL OPT", "SELL FUT"]);
    expect(r.synBuy).toBeCloseTo(26400 + 195.9 * g, 9);
    expect(r.synSell).toBeCloseTo(26400 + 195.7 * g, 9);
    // capital: option debit + 12% futures margin + entry charges; annualised on it.
    expect(r.rev.capital).toBeCloseTo(195.9 * 150 + 0.12 * 26600.25 * 150 + r.rev.charges.entry.total, 6);
    expect(r.rev.annual).toBeCloseTo((r.rev.net / r.rev.capital) * (365 / 27), 12);
    expect(A.parityRows(chainAt(row), { fut, rate: 0.06, days: 0.5, window: 5 }).rows[0].rev.annual).toBeNull();
  });

  it("parityRows: no future → conv/rev null and dev against the implied forward", () => {
    const c = arbChain();
    const res = A.parityRows(c, { fut: null, rate: 0.06, days: 27 });
    expect(res.noFuture).toBe(true);
    expect(res.ref.kind).toBe("fwd");
    for (const r of res.rows) {
      expect(r.conv).toBeNull();
      expect(r.rev).toBeNull();
      expect(r.dev).toBeCloseTo(r.synMid - res.fwd.forward, 9);
    }
    expect(res.rows.find((r) => r.atm).strike).toBe(26600);
  });

  it("parityRows: a one-sided leg gives null figures, not 0", () => {
    const row = one({ bid: 0, ask: 450.25 }, { bid: 254.35, ask: 254.45 });
    const r = A.parityRows(chainAt(row), { fut, rate: 0.06, days: 27, window: 5 }).rows.find((x) => x.strike === 26400);
    expect(r.oneSided).toBe(true);
    expect(r.synBuy).toBeNull();
    expect(r.conv).toBeNull();
    expect(r.rev).toBeNull();
    expect(r.tag).toBeNull();
  });

  it("parityRows: the rich tags only outside the bid-ask band", () => {
    const rich = one({ bid: 460, ask: 460.1 }, { bid: 254.35, ask: 254.45 });
    expect(A.parityRows(chainAt(rich), { fut, rate: 0.06, days: 27, window: 5 }).rows.find((x) => x.strike === 26400).tag).toBe("callsRich");
    const puts = one({ bid: 440, ask: 440.1 }, { bid: 254.35, ask: 254.45 });
    expect(A.parityRows(chainAt(puts), { fut, rate: 0.06, days: 27, window: 5 }).rows.find((x) => x.strike === 26400).tag).toBe("putsRich");
    const inside = one({ bid: 450.15, ask: 450.25 }, { bid: 254.35, ask: 254.45 });
    expect(A.parityRows(chainAt(inside), { fut: { ...fut, bid: 26595.5, ask: 26596 }, rate: 0, days: 27, window: 5 }).rows.find((x) => x.strike === 26400).tag).toBeNull();
  });

  it("parityRows: a lot-size mismatch switches conversions and reversals off", () => {
    const row = one({ bid: 450.15, ask: 450.25 }, { bid: 254.35, ask: 254.45 });
    const res = A.parityRows(chainAt(row), { fut: { ...fut, lotSize: 50 }, rate: 0.06, days: 27, window: 5 });
    expect(res.lotMismatch).toBe(true);
    expect(res.rows[0].rev).toBeNull();
  });

  const boxChain = (c1, c2, p1, p2) => ({ underlyingLtp: 26450, lotSize: 75, rows: [one(c1, p1, 26400), one(c2, p2, 26500)] });

  it("boxes: D = 98.50, W = 100, d = 27 → gross 20.59%/yr; the net rate after charges", () => {
    const c = boxChain({ bid: 449.9, ask: 450 }, { bid: 400, ask: 400.1 }, { bid: 251.5, ask: 251.6 }, { bid: 299.9, ask: 300 });
    const [b] = A.boxes(c, { rate: 0.06, days: 27, lots: 1, window: 5 });
    expect(b.k1).toBe(26400);
    expect(b.k2).toBe(26500);
    expect(b.price).toBeCloseTo(98.5, 9);
    expect(b.grossRate).toBeCloseTo((100 / 98.5 - 1) * (365 / 27), 12);
    expect(Math.round(b.grossRate * 10000) / 100).toBe(20.59);
    const U = 75;
    expect(b.rate).toBeCloseTo(((100 * U - b.x) / (98.5 * U + b.cin) - 1) * (365 / 27), 12);
    expect(b.vsHurdleBp).toBeCloseTo((b.rate - 0.06) * 1e4, 9);
    expect(b.capital).toBeCloseTo(98.5 * U + b.cin, 9);
    expect(b.locked).toBeCloseTo(100 * U - 98.5 * U - b.chargesTotal, 9);
    expect(b.crossed).toBe(false);
  });

  it("boxes: the borrow formula", () => {
    const c = boxChain({ bid: 449.9, ask: 450 }, { bid: 400, ask: 400.1 }, { bid: 251.5, ask: 251.6 }, { bid: 299.9, ask: 300 });
    const [b] = A.boxes(c, { rate: 0.06, days: 27, mode: "borrow", window: 5 });
    expect(b.price).toBeCloseTo(449.9 - 400.1 + 299.9 - 251.6, 9);
    expect(b.rate).toBeCloseTo(((100 * 75 + b.x) / (b.price * 75 - b.cin) - 1) * (365 / 27), 12);
    expect(b.vsHurdleBp).toBeCloseTo((0.06 - b.rate) * 1e4, 9);
    expect(b.capital).toBe(100 * 75);
    expect(b.locked).toBeLessThan(0);
  });

  it("boxes: D ≤ 0 is flagged crossed", () => {
    const c = boxChain({ bid: 349.9, ask: 350 }, { bid: 400, ask: 400.1 }, { bid: 251.5, ask: 251.6 }, { bid: 299.9, ask: 300 });
    const [b] = A.boxes(c, { rate: 0.06, days: 27, window: 5 });
    expect(b.price).toBeLessThanOrEqual(0);
    expect(b.crossed).toBe(true);
    expect(A.arbFlags(b, {}).map((f) => f.code)).toContain("CROSSED");
  });

  it("boxLimit: the limit for a target rate round-trips to that rate", () => {
    const U = 75;
    const cin = 120;
    const x = 30;
    const L = A.boxLimit({ mode: "lend", width: 100, units: U, cin, x, target: 0.07, days: 27 });
    expect(((100 * U - x) / (L.raw * U + cin) - 1) * (365 / 27)).toBeCloseTo(0.07, 12);
    expect(L.limit).toBeLessThanOrEqual(L.raw); // a debit rounds down
    const B = A.boxLimit({ mode: "borrow", width: 100, units: U, cin, x, target: 0.07, days: 27 });
    expect(((100 * U + x) / (B.raw * U - cin) - 1) * (365 / 27)).toBeCloseTo(0.07, 12);
    expect(B.limit).toBeGreaterThanOrEqual(B.raw); // a credit rounds up
    expect(A.boxLimit({ mode: "lend", width: 100, units: U, target: 0.07, days: 0.4 })).toBeNull();
  });

  it("futuresTerm: basis, carry, calendar forward rate, fair spread and roll ₹ with charges", () => {
    const now = Date.parse("2026-10-29T04:00:00Z");
    const f1 = { symbol: "NFO:NIFTY-2026-11-24-FUT", expiry: "2026-11-24", lotSize: 75, bid: 26594.8, ask: 26600.1 };
    const f2 = { symbol: "NFO:NIFTY-2026-12-29-FUT", expiry: "2026-12-29", lotSize: 75, bid: 26750, ask: 26756 };
    const t = A.futuresTerm(26472.85, [f2, f1], { now, rate: 0.06 });
    expect(t.futures.map((f) => f.expiry)).toEqual(["2026-11-24", "2026-12-29"]);
    const a = t.futures[0];
    const m1 = (26594.8 + 26600.1) / 2;
    const d1 = A.timeToExpiry("2026-11-24", now).days;
    expect(a.basis).toBeCloseTo(m1 - 26472.85, 9);
    expect(a.carry).toBeCloseTo((m1 / 26472.85 - 1) * (365 / d1), 12);
    expect(a.carryVsBp).toBeCloseTo((a.carry - 0.06) * 1e4, 9);
    const c = t.calendars[0];
    const m2 = (26750 + 26756) / 2;
    const dd = A.timeToExpiry("2026-12-29", now).days - d1;
    expect(c.key).toBe("c:2026-11-24>2026-12-29");
    expect(c.buyFar).toBeCloseTo(26756 - 26594.8, 9);
    expect(c.sellFar).toBeCloseTo(26750 - 26600.1, 9);
    expect(c.fwdRate).toBeCloseTo((m2 / m1 - 1) * (365 / dd), 12);
    expect(c.fair).toBeCloseTo(m1 * (Math.exp((0.06 * dd) / 365) - 1), 9);
    const sell = A.orderCharges({ kind: "FUT", side: "SELL", price: 26594.8, units: 75 }).total;
    const buy = A.orderCharges({ kind: "FUT", side: "BUY", price: 26756, units: 75 }).total;
    expect(c.rollLong).toBeCloseTo((26756 - 26594.8) * 75 + sell + buy, 6);
    const buyNear = A.orderCharges({ kind: "FUT", side: "BUY", price: 26600.1, units: 75 }).total;
    const sellFar = A.orderCharges({ kind: "FUT", side: "SELL", price: 26750, units: 75 }).total;
    expect(c.rollShort).toBeCloseTo((26600.1 - 26750) * 75 + buyNear + sellFar, 6);
  });

  it("cheaperExposure: picks the cheaper side and reports the gap", () => {
    const row = one({ bid: 450.15, ask: 450.25 }, { bid: 254.35, ask: 254.45 });
    // Synthetic buy ≈ 26400 + 195.9·g ≈ 26596.8: a future offered at 26620 is the dearer way to go long.
    const r = A.cheaperExposure({ fut: { ...fut, bid: 26619.5, ask: 26620 }, row, rate: 0.06, days: 27, lot: 75 });
    expect(r.long.pick).toBe("synthetic");
    expect(r.long.diffPts).toBeCloseTo(Math.abs(r.long.fut - r.long.syn), 12);
    expect(r.long.diffPerLot).toBeCloseTo(r.long.diffPts * 75, 9);
    expect(r.short.pick).toBe("future");
    const cheap = A.cheaperExposure({ fut: { ...fut, bid: 26570, ask: 26570.5 }, row, rate: 0.06, days: 27, lot: 75 });
    expect(cheap.long.pick).toBe("future");
    expect(cheap.short.pick).toBe("synthetic");
    expect(A.cheaperExposure({ fut: { bid: 0, ask: 1 }, row, rate: 0.06, days: 27 })).toBeNull();
  });

  it("staleness: by age and by skew", () => {
    const now = Date.parse("2026-10-29T06:00:10Z");
    expect(A.staleness({ chainAsOf: "2026-10-29T06:00:09Z", futAsOf: "2026-10-29T06:00:09Z", now }).stale).toBe(false);
    const old = A.staleness({ chainAsOf: "2026-10-29T06:00:01Z", futAsOf: "2026-10-29T06:00:09Z", now });
    expect(old.stale).toBe(true);
    expect(old.ageMs).toBe(9000);
    const skew = A.staleness({ chainAsOf: "2026-10-29T06:00:09Z", futAsOf: "2026-10-29T06:00:03Z", now, maxAgeMs: 8000 });
    expect(skew.ageMs).toBe(7000);
    expect(skew.skewMs).toBe(6000);
    expect(skew.stale).toBe(false);
    expect(A.staleness({ chainAsOf: "2026-10-29T06:00:09Z", futAsOf: "2026-10-29T06:00:03Z", now, maxAgeMs: 5000 }).stale).toBe(true);
    expect(A.staleness({ chainAsOf: null }).stale).toBe(false);
  });

  it("the waterfall adds up exactly to the net (50 random structures)", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 50; i++) {
      const row = one({ bid: 400 + rnd() * 100, ask: 0 }, { bid: 200 + rnd() * 100, ask: 0 });
      row.ce.ask = row.ce.bid + 0.05 + rnd() * 2;
      row.pe.ask = row.pe.bid + 0.05 + rnd() * 2;
      const f = { ...fut, bid: 26550 + rnd() * 100 };
      f.ask = f.bid + 0.05 + rnd() * 5;
      const res = A.parityRows(chainAt(row), { fut: f, rate: rnd() * 0.1, days: 1 + rnd() * 60, lots: 1 + Math.floor(rnd() * 10), hold: rnd() > 0.5 ? "close" : "expiry", window: 5 });
      for (const s of [res.rows[0].conv, res.rows[0].rev]) {
        const w = A.waterfall(s);
        expect(w.lines.reduce((a, l) => a + l.value, 0)).toBe(s.net);
        expect(s.net).toBeCloseTo(s.grossRs - s.financingRs - s.chargesTotal, 6);
      }
    }
  });

  it("arbFlags: staleness, expiry day, wide, freeze, exercise STT, no future", () => {
    const row = one({ bid: 10, ask: 11 }, { bid: 254.35, ask: 254.45 });
    const res = A.parityRows(chainAt(row), { fut, rate: 0.06, days: 27, lots: 30, window: 5, fwd: { forward: 26628, atm: 26400, lo: 0, hi: 0, n: 2 } });
    const s = res.rows[0].rev;
    const codes = A.arbFlags(s, { stale: true, ageMs: 7000, days: 0.5, freezeQty: new Map(s.legs.map((l) => [l.symbol, 1800])), demo: true }).map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(["STALE", "EXPIRY_DAY", "WIDE", "FREEZE", "EXERCISE_STT"]));
    expect(A.arbFlags(null, { noFuture: true }).map((f) => f.code)).toEqual(["NO_FUTURE"]);
    // Market hours (IST = UTC + 5:30): closed before 09:00 and from 15:30; pre-open 09:00-09:15; last 30 min 15:00-15:30.
    const at = (ist) => A.arbFlags(s, { nowMs: Date.parse(`2026-10-29T${ist}:00+05:30`) }).map((f) => f.code);
    expect(at("08:00")).toContain("MARKET_CLOSED");
    expect(at("08:00")).not.toContain("NEAR_CLOSE");
    expect(at("09:10")).toContain("NEAR_CLOSE");
    expect(at("09:10")).not.toContain("MARKET_CLOSED");
    expect(at("12:00")).not.toEqual(expect.arrayContaining(["NEAR_CLOSE"]));
    expect(at("12:00")).not.toContain("MARKET_CLOSED");
    expect(at("15:10")).toContain("NEAR_CLOSE");
    expect(at("16:00")).toContain("MARKET_CLOSED");
    expect(at("16:00")).not.toContain("NEAR_CLOSE");
  });

  it("the waterfall's displayed (whole-rupee) lines add up to the displayed net (200 random structures)", () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 200; i++) {
      const row = one({ bid: 400 + rnd() * 100, ask: 0 }, { bid: 200 + rnd() * 100, ask: 0 });
      row.ce.ask = row.ce.bid + 0.05 + rnd() * 2;
      row.pe.ask = row.pe.bid + 0.05 + rnd() * 2;
      const f = { ...fut, bid: 26550 + rnd() * 100 };
      f.ask = f.bid + 0.05 + rnd() * 5;
      const res = A.parityRows(chainAt(row), { fut: f, rate: rnd() * 0.1, days: 1 + rnd() * 60, lots: 1 + Math.floor(rnd() * 10), hold: rnd() > 0.5 ? "close" : "expiry", window: 5 });
      for (const s of [res.rows[0].conv, res.rows[0].rev]) {
        const w = A.waterfall(s);
        for (const l of w.lines) {
          expect(Number.isInteger(l.shown)).toBe(true);
          expect(Math.abs(l.shown - l.value)).toBeLessThan(1);
        }
        expect(w.lines.reduce((a, l) => a + l.shown, 0)).toBe(w.netShown);
        expect(Math.abs(w.netShown - w.net)).toBeLessThanOrEqual(0.5);
      }
    }
    // The reviewer's case: nine lines rounded on their own summed to -461 against a -463 net.
    expect(A.roundToSum([-291.62, 80.58, -80.41, -53.55, -53.33, -2.47, -40.36, -21.44, 0.2])).toEqual({ values: [-292, 81, -80, -54, -53, -3, -40, -21, 0], total: -462 });
    expect(A.roundToSum([0.4, 0.4, 0.4])).toEqual({ values: [1, 0, 0], total: 1 });
  });

  it("structureCharges: exercise brokerage on hold-to-expiry carries GST", () => {
    const leg = { kind: "OPT", side: "BUY", right: "PE", strike: 26400, price: 100, units: 75, lots: 1, symbol: "NFO:NIFTY-2026-11-24-26400-PE" };
    const c = A.structureCharges([leg], undefined, { hold: "expiry", settle: 26300 });
    expect(c.exercised).toBe(1);
    expect(c.exit.brokerage).toBeGreaterThan(0);
    expect(c.exit.gst).toBeCloseTo(0.18 * c.exit.brokerage, 9);
    expect(c.exit.total).toBeCloseTo(c.exit.brokerage * 1.18, 9);
    const otm = A.structureCharges([leg], undefined, { hold: "expiry", settle: 26500 });
    expect(otm.exit.gst).toBe(0);
  });

  it("parityRows: against the implied forward, no rich tag while the synthetic sits inside the forward band", () => {
    const row = one({ bid: 450.15, ask: 450.25 }, { bid: 254.35, ask: 254.45 }); // g = 1: SynS 26595.7, SynB 26595.9
    const at = (fwd) => A.parityRows(chainAt(row), { fut: null, rate: 0, days: 27, window: 5, fwd: { atm: 26400, n: 3, ...fwd } }).rows.find((x) => x.strike === 26400);
    const inside = at({ forward: 26595.6, lo: 26595, hi: 26596.5 });
    expect(inside.dev).toBeCloseTo(0.2, 9);
    expect(inside.tag).toBeNull();
    expect(at({ forward: 26590, lo: 26589, hi: 26591 }).tag).toBe("callsRich");
    expect(at({ forward: 26600, lo: 26599, hi: 26601 }).tag).toBe("putsRich");
  });

  it("futuresTerm: calendars with different lot sizes have no roll figures", () => {
    const now = Date.parse("2026-10-29T06:00:00Z");
    const futs = [
      { symbol: "NFO:NIFTY-2026-11-24-FUT", expiry: "2026-11-24", lotSize: 75, bid: 26600, ask: 26600.5 },
      { symbol: "NFO:NIFTY-2026-12-29-FUT", expiry: "2026-12-29", lotSize: 65, bid: 26750, ask: 26751 },
    ];
    const [cal] = A.futuresTerm(26500, futs, { now }).calendars;
    expect(cal.lotMismatch).toBe(true);
    expect(cal.rollLong).toBeNull();
    expect(cal.rollShort).toBeNull();
    expect(cal.buyFar).toBeNull();
    expect(cal.fwdRate).not.toBeNull();
    const [same] = A.futuresTerm(26500, futs.map((f) => ({ ...f, lotSize: 75 })), { now }).calendars;
    expect(same.lotMismatch).toBe(false);
    expect(same.rollLong).not.toBeNull();
  });

  it("sendOrder: least liquid option first, future last; freezeSlices; maxLotsAtTouch", () => {
    const legs = [
      { kind: "FUT", symbol: "F", quote: { bid: 1, ask: 1.1 } },
      { kind: "OPT", symbol: "A", quote: { bid: 100, ask: 100.1 } },
      { kind: "OPT", symbol: "B", quote: { bid: 10, ask: 11 } },
    ];
    expect(A.sendOrder(legs).map((l) => l.symbol)).toEqual(["B", "A", "F"]);
    expect(A.freezeSlices(3750, 1800, 75)).toEqual([1800, 1800, 150]);
    expect(A.freezeSlices(150, 1800, 75)).toEqual([150]);
    expect(A.maxLotsAtTouch(legs, new Map([["F", 900], ["A", 175], ["B", 600]]), 75)).toBe(2);
    expect(A.maxLotsAtTouch(legs, new Map([["F", 900]]), 75)).toBeNull();
  });

  it("arbConfig: defaults, validation and the locked columns", () => {
    const d = A.arbConfig(undefined);
    expect(d.tab).toBe("parity");
    expect(d.hurdle).toBe(6);
    expect(d.cols).toEqual(["strike", "call", "put", "syn", "dev", "edge", "conv", "rev", "annual", "liq"]);
    expect(d.boxView).toBe("list");
    expect(A.arbConfig({ boxView: "matrix" }).boxView).toBe("matrix");
    expect(A.arbConfig({ boxView: "grid" }).boxView).toBe("list");
    // A saved column list from before the Edge column gets it once, after Dev; a round-2 list keeps the user's choice.
    expect(A.arbConfig({ cols: ["strike", "dev", "conv"] }).cols.slice(0, 3)).toEqual(["strike", "dev", "edge"]);
    expect(A.arbConfig({ cols: ["strike", "dev", "conv"], colsV: 2 }).cols).not.toContain("edge");
    expect(A.arbConfig({ sort: { parity: { key: "edge", dir: "desc" } } }).sort.parity.key).toBe("edge");
    const c = A.arbConfig({ tab: "boxes", lots: 500, cols: ["dev", "bogus", "oi"], staleSec: 7, rates: { "opt.sttSell": 0.002, gst: 3 }, sort: { parity: { key: "conv", dir: "desc" } } });
    expect(c.tab).toBe("boxes");
    expect(c.lots).toBe(1);
    expect(c.cols[0]).toBe("strike");
    expect(c.cols).toEqual(expect.arrayContaining(["dev", "oi", "conv", "rev", "annual"]));
    expect(c.cols).not.toContain("bogus");
    expect(c.staleSec).toBe(5);
    expect(c.rates).toEqual({ "opt.sttSell": 0.002 });
    expect(c.sort.parity).toEqual({ key: "conv", dir: "desc" });
  });
});

describe("Arbitrage display helpers (arb.md §10)", () => {
  it("coverRatio: gross over cost, the points short, null-safe", () => {
    expect(A.coverRatio({ kind: "conv", grossPts: 3, breakEvenPts: 2 })).toEqual({ cover: 1.5, gross: 3, cost: 2, short: 0 });
    const neg = A.coverRatio({ kind: "rev", grossPts: -1, breakEvenPts: 2 });
    expect(neg.cover).toBe(-0.5);
    expect(neg.short).toBe(3);
    expect(A.coverRatio({ kind: "conv", grossPts: 1, breakEvenPts: 0 }).cover).toBeNull();
    expect(A.coverRatio({ kind: "lbox", width: 500, price: 497, breakEvenPts: 2 })).toEqual({ cover: 1.5, gross: 3, cost: 2, short: 0 });
    expect(A.coverRatio({ kind: "sbox", width: 500, price: 499, breakEvenPts: 2 }).gross).toBe(-1);
    expect(A.coverRatio(null)).toEqual({ cover: null, gross: null, cost: null, short: null });
    expect(A.coverRatio({ kind: "conv", grossPts: 1 })).toEqual({ cover: null, gross: null, cost: null, short: null });
  });
  it("coverRatio: boxes pay for money at the hurdle (lend below hurdle is short; a cheap borrow covers)", () => {
    // Lend 497 for a year to get 500 back: 0.6 %/yr, far under a 6 % hurdle, so the box does not cover.
    const lendLow = A.coverRatio({ kind: "lbox", width: 500, price: 497, breakEvenPts: 2, hurdle: 0.06, days: 365 });
    expect(lendLow.gross).toBe(3);
    expect(lendLow.cost).toBeCloseTo(2 + 497 * 0.06, 6);
    expect(lendLow.cover).toBeLessThan(1);
    expect(lendLow.short).toBeGreaterThan(0);
    // Borrow 480 against 500 owed in a year: ≈ 4.2 %/yr, under the 6 % hurdle, so it covers (fair credit ≈ 471.70).
    const borrowLow = A.coverRatio({ kind: "sbox", width: 500, price: 480, breakEvenPts: 2, hurdle: 0.06, days: 365 });
    expect(borrowLow.gross).toBeCloseTo(480 - 500 / 1.06, 6);
    expect(borrowLow.cover).toBeGreaterThan(1);
    expect(borrowLow.short).toBe(0);
    // Borrow 470 against 500: ≈ 6.4 %/yr, over the hurdle, so the gross is negative.
    expect(A.coverRatio({ kind: "sbox", width: 500, price: 470, breakEvenPts: 2, hurdle: 0.06, days: 365 }).gross).toBeLessThan(0);
  });
  it("bpStep: fixed thresholds at 10 / 50 / 150 bp, both signs", () => {
    const cases = [[0, 0], [9.99, 0], [10, 1], [49.99, 1], [50, 2], [149.99, 2], [150, 3], [4000, 3], [-9.99, 0], [-10, -1], [-50, -2], [-150, -3]];
    for (const [bp, step] of cases) expect(A.bpStep(bp), String(bp)).toBe(step);
    expect(Object.is(A.bpStep(-5), 0)).toBe(true);
    expect(A.bpStep(null)).toBeNull();
    expect(A.bpStep(Number.NaN)).toBeNull();
    expect(A.bpStep(Infinity)).toBeNull();
  });
  it("devHeat: a flat chain is calm; the side follows the sign; one outlier does not wash the rest out", () => {
    const flat = A.devHeat(Array.from({ length: 21 }, () => ({ dev: 0.01, devBp: 0.4 })));
    expect(flat.every((c) => c.step === 0 && c.side === null)).toBe(true);
    const rows = [...Array.from({ length: 20 }, (_, i) => ({ dev: i % 2 ? 2 : -2, devBp: i % 2 ? 10 : -10 })), { dev: 50, devBp: 500 }];
    const heat = A.devHeat(rows);
    expect(heat[0].side).toBe("put");
    expect(heat[1].side).toBe("call");
    expect(heat[0].m).toBe(10);
    expect(heat[0].step).toBe(5); // scaled to the 95th percentile, not to the 500 bp outlier
    expect(heat[20].step).toBe(5);
    expect(A.devHeat([{ dev: null, devBp: null }])[0]).toEqual({ side: null, step: 0, m: 5 });
    expect(A.devHeat([{ dev: 0.5, devBp: 2 }])[0].step).toBe(2); // m floors at 5 bp: 1 + floor(4 · 2 / 5)
  });
  it("bestAnnualSigned: the better side, else the larger of conv and rev, negatives included", () => {
    expect(A.bestAnnualSigned({ conv: { annual: -0.03 }, rev: { annual: -0.05 } })).toEqual({ k: "conv", v: -0.03 });
    expect(A.bestAnnualSigned({ conv: { annual: 0.01 }, rev: { annual: 0.02 } })).toEqual({ k: "rev", v: 0.02 });
    expect(A.bestAnnualSigned({ conv: null, rev: { annual: -0.1 } })).toEqual({ k: "rev", v: -0.1 });
    expect(A.bestAnnualSigned({ conv: { annual: null }, rev: null })).toBeNull();
    // The better side by net wins even when the other side has the larger annual (spec §8.1).
    const conv = { kind: "conv", net: -1200, annual: -0.02 };
    const rev = { kind: "rev", net: -157, annual: -0.4 };
    expect(A.bestAnnualSigned({ conv, rev, best: rev })).toEqual({ k: "rev", v: -0.4 });
  });
  it("waterfallSteps: the steps chain and end at the net; the domain spans zero", () => {
    const w = A.waterfallSteps([{ key: "gross", value: 1620 }, { key: "fin", value: -164 }, { key: "brk", value: -80 }, { key: "stt", value: -75 }, { key: "earn", value: 30 }]);
    for (let i = 0; i + 1 < w.steps.length; i++) expect(w.steps[i].to).toBe(w.steps[i + 1].from);
    expect(w.steps[0].from).toBe(0);
    expect(w.steps.at(-1).to).toBe(w.net);
    expect(w.net).toBe(1331);
    expect(w.min).toBe(0);
    expect(w.max).toBe(1620);
    const n = A.waterfallSteps([{ key: "gross", value: -100 }, { key: "c", value: -50 }]);
    expect(n).toEqual({ steps: [{ key: "gross", from: 0, to: -100 }, { key: "c", from: -100, to: -150 }], net: -150, min: -150, max: 0 });
    expect(A.waterfallSteps([]).net).toBe(0);
  });
  it("uses the real structures: cover on a parity row and a box", () => {
    const s = { kind: "conv", grossPts: -4.6, breakEvenPts: 3.32 };
    const c = A.coverRatio(s);
    expect(c.short).toBeCloseTo(7.92, 6);
    expect(c.cover).toBeCloseTo(-4.6 / 3.32, 9);
  });
});

describe("Option Screener maths (PRD 07)", () => {
  const NOW = Date.UTC(2026, 9, 29, 4, 0); // 29 Oct 2026 09:30 IST
  const leg = (strike, right, o = {}) => ({ symbol: `NFO:NIFTY-2026-11-03-${strike}-${right}`, ltp: 10, bid: 9.9, ask: 10.1, oi: 75000, oiChange: 7500, volume: 150000, iv: 14, close: 9, change: 1, delta: right === "CE" ? 0.3 : -0.3, theta: -2, vega: 5, ...o });
  // A smooth demo-like chain: 26000..26900 step 50, spot 26450.
  const strikes = Array.from({ length: 19 }, (_, i) => 26000 + i * 50);
  const priced = (k, right) => {
    const F = 26450;
    const p = A.black76(F, k, 5 / 365, 14, right);
    const d = A.probItm(F, k, 5 / 365, 14, right);
    return leg(k, right, { ltp: p, bid: Math.max(0.05, p - 0.5), ask: p + 0.5, delta: right === "CE" ? d : -d, oiChange: k % 100 ? -3000 : 9000 });
  };
  const chain = { underlying: "NIFTY", expiry: "2026-11-03", underlyingLtp: 26450, atmStrike: 26450, lotSize: 75, rows: strikes.map((k) => ({ strike: k, ce: priced(k, "CE"), pe: priced(k, "PE") })) };

  it("unusualVolume: the chain's old rule by default; minRatio and top respected; < 5 legs gives none", () => {
    const rows = [100, 110, 120, 130, 140, 150].map((k, i) => ({ strike: k, ce: { symbol: `c${k}`, volume: i === 5 ? 9000 : 100, oi: 100 }, pe: null }));
    expect([...A.unusualVolume(rows)]).toEqual(["c150"]);
    expect([...A.unusualVolume(rows, { minRatio: 100 })]).toEqual([]);
    rows[4].ce.volume = 8000;
    expect([...A.unusualVolume(rows, { top: 1 })]).toEqual(["c150"]);
    expect(A.unusualVolume(rows.slice(0, 4)).size).toBe(0);
  });

  it("median ignores nulls; odd, even and empty", () => {
    expect(A.median([3, 1, 2])).toBe(2);
    expect(A.median([4, 1, 3, 2])).toBe(2.5);
    expect(A.median([null, 5, undefined, "x"])).toBe(5);
    expect(A.median([])).toBeNull();
  });

  it("volOiRelative: ratios to the side median; OI 0 left out; < 5 legs empty", () => {
    const rows = [1, 2, 3, 4, 5, 6].map((k) => ({ strike: k, ce: { volume: k * 100, oi: k === 6 ? 0 : 100 } }));
    const m = A.volOiRelative(rows, "ce");
    expect(m.size).toBe(5);
    expect(m.get(3)).toBeCloseTo(1, 12); // median of 1..5 is 3
    expect(m.get(5)).toBeCloseTo(5 / 3, 12);
    expect(m.has(6)).toBe(false);
    expect(A.volOiRelative(rows.slice(0, 4), "ce").size).toBe(0);
    // An OI floor leaves thin legs out of the median and the result.
    const thin = [...rows.slice(0, 5), { strike: 7, ce: { volume: 5000, oi: 2 } }];
    expect(A.volOiRelative(thin, "ce").get(7)).toBeGreaterThan(100);
    const floored = A.volOiRelative(thin, "ce", 50);
    expect(floored.has(7)).toBe(false);
    expect(floored.get(3)).toBeCloseTo(1, 12);
  });

  it("neighbourIv: two each side, iv ≤ 0 skipped, edges use one side", () => {
    const rows = [10, 11, 12, 13, 14, 15].map((iv, i) => ({ strike: 100 + i * 10, ce: { iv: i === 1 ? 0 : iv } }));
    expect(A.neighbourIv(rows, "ce", 120)).toBe(A.median([10, 13, 14]));
    expect(A.neighbourIv(rows, "ce", 100)).toBe(A.median([12, 13]));
    expect(A.neighbourIv(rows, "ce", 150)).toBe(A.median([13, 14]));
    expect(A.neighbourIv([], "ce", 100)).toBeNull();
  });

  it("skew25 picks the nearest |Δ| 0.25 within ±0.08; puts richer is positive; null when absent", () => {
    const rows = [
      { strike: 1, pe: { delta: -0.2, iv: 18 }, ce: { delta: 0.9, iv: 10 } },
      { strike: 2, pe: { delta: -0.26, iv: 17 }, ce: { delta: 0.6, iv: 11 } },
      { strike: 3, pe: { delta: -0.5, iv: 15 }, ce: { delta: 0.24, iv: 13 } },
    ];
    expect(A.skew25(rows)).toEqual({ put: 17, call: 13, rr: 4, putStrike: 2, callStrike: 3 });
    expect(A.skew25([{ strike: 1, pe: { delta: -0.5, iv: 15 }, ce: { delta: 0.24, iv: 13 } }])).toBeNull();
  });

  it("probBelow = 1 − probItm(CE) at the strike; 0 at or below 0; null without vol", () => {
    expect(A.probBelow(26500, 26450, 0.02, 14)).toBeCloseTo(1 - A.probItm(26450, 26500, 0.02, 14, "CE"), 10);
    expect(A.probBelow(0, 26450, 0.02, 14)).toBe(0);
    expect(A.probBelow(26500, 26450, 0.02, null)).toBeNull();
  });

  it("legMetrics: σ OTM signs, POP short + long ≈ 1 at one price, θ % floor, BE σ, ATM IV fallback", () => {
    const ctx = A.chainContext(chain, { now: NOW, hv20: 12 });
    expect(ctx.exchange).toBe("NFO");
    expect(ctx.T).toBeGreaterThan(0);
    const row = chain.rows.find((r) => r.strike === 26700);
    const ce = A.legMetrics(row.ce, row, "ce", ctx);
    const pe = A.legMetrics(row.pe, row, "pe", ctx);
    expect(ce.otm).toBe(true);
    expect(ce.sigmaOtm).toBeGreaterThan(0);
    expect(pe.otm).toBe(false);
    expect(pe.sigmaOtm).toBeLessThan(0);
    const sdA = (ctx.atmIv / 100) * Math.sqrt(ctx.T);
    expect(ce.sigmaOtm).toBeCloseTo(Math.log(26700 / ctx.F) / sdA, 10);
    expect(ce.beSigma).toBeCloseTo(Math.abs(Math.log((26700 + ce.ask) / ctx.F)) / sdA, 10);
    // one price both ways: the long's and the short's chance of profit add up to 1
    const flat = { ...row.ce, bid: 20, ask: 20 };
    const f = A.legMetrics(flat, row, "ce", ctx);
    expect(f.popShort + f.popLong).toBeCloseTo(1, 10);
    expect(A.legMetrics({ ...row.ce, bid: 0.2, ask: 0.3, ltp: 0.25 }, row, "ce", ctx).thetaPct).toBeNull();
    const noIv = A.legMetrics({ ...row.ce, iv: null }, row, "ce", ctx);
    expect(noIv.ivFallback).toBe(true);
    expect(noIv.ivUsed).toBe(ctx.atmIv);
    expect(ce.ivHv).toBeCloseTo(14 - 12, 10);
    expect(A.legMetrics({ symbol: "x", bid: null, ask: null, ltp: null }, row, "ce", ctx)).toBeNull();
    const oneSided = A.legMetrics({ ...row.ce, bid: null }, row, "ce", ctx);
    expect(oneSided.priceQ).toBe("ltp");
    expect(oneSided.sellPrice).toBe(row.ce.ltp);
  });

  it("wingFor: hand values; a missing wing strike uses the furthest one; no credit is null", () => {
    const rows = [100, 110, 120, 130].map((k) => ({ strike: k, ce: { ask: { 100: 12, 110: 8, 120: 5, 130: 3 }[k] } }));
    const c = { rows };
    const w = A.wingFor({ right: "CE", strike: 100, sellPrice: 11, lot: 50 }, c, 2);
    expect(w).toMatchObject({ wingStrike: 120, wingAsk: 5, credit: 6 });
    expect(w.maxLoss).toBe((20 - 6) * 50);
    expect(w.rr).toBeCloseTo(700 / 300, 12);
    expect(A.wingFor({ right: "CE", strike: 100, sellPrice: 11, lot: 50 }, c, 9).wingStrike).toBe(130);
    expect(A.wingFor({ right: "CE", strike: 100, sellPrice: 4, lot: 50 }, c, 2)).toBeNull();
    expect(A.wingFor({ right: "CE", strike: 130, sellPrice: 4, lot: 50 }, c, 2)).toBeNull();
  });

  it("sellScore / buyScore: hand parts, weights renormalise without HV, < 3 parts null, penalties", () => {
    const base = { otm: true, ivHv: 2, popShort: 0.84, thetaPct: 7.5, liq: 5, sigmaOtm: 1.5, days: 5 };
    const s = A.sellScore(base);
    // 0.35·0.5 + 0.25·0.8 + 0.2·0.5 + 0.2·1 = 0.675
    expect(s.score).toBe(68);
    expect(A.sellScore({ ...base, otm: false })).toBeNull();
    // HV missing: (0.25·0.8 + 0.2·0.5 + 0.2·1) / 0.65
    expect(A.sellScore({ ...base, ivHv: null }).score).toBe(Math.round((100 * 0.5) / 0.65));
    expect(A.sellScore({ ...base, ivHv: null, thetaPct: null })).toBeNull();
    expect(A.sellScore({ ...base, sigmaOtm: 0.8 }).score).toBe(Math.round(100 * 0.675 * 0.5));
    expect(A.sellScore({ ...base, days: 0.5 }).penalties).toEqual(["Expiry day"]);
    const b = { ivHv: -2, beSigma: 1, thetaPct: 5, liq: 3, popLong: 0.3, days: 5 };
    // 0.3·0.5 + 0.3·0.5 + 0.2·0.5 + 0.2·0.5 = 0.5
    expect(A.buyScore(b).score).toBe(50);
    expect(A.buyScore({ ...b, popLong: 0.05 }).score).toBe(25);
    expect(A.buyScore({ ...b, popLong: 0.05 }).penalties).toEqual(["Lottery ticket"]);
  });

  it("touchFrom: 1 only when spot is already at or beyond the level on the option's side, else the reflection rule", () => {
    // OTM by spot but below the forward: no longer pinned to 100%.
    const t = A.touchFrom(57700, 57388, 30 / 365, 14, "CE");
    expect(t).toBeGreaterThan(0.3);
    expect(t).toBeLessThan(1);
    expect(t).toBeCloseTo(A.probTouch(57700, 57388, 30 / 365, 14), 12);
    expect(A.touchFrom(57000, 57388, 30 / 365, 14, "CE")).toBe(1);
    expect(A.touchFrom(57500, 57388, 30 / 365, 14, "PE")).toBe(1);
    expect(A.touchFrom(56000, 57388, 30 / 365, 14, "PE")).toBeLessThan(1);
    expect(A.touchFrom(null, 57388, 0.1, 14, "CE")).toBeNull();
    expect(A.buyScore({ ivHv: -2, beSigma: 1, thetaPct: 5, liq: 3, popLong: 0.3, days: 5 }).raw).toBeCloseTo(50, 9);
  });

  it("buildupReading covers the 8 cells; dominantBuildup is null without OI change", () => {
    const want = { CE: { LB: "Call buying · bullish", SB: "Call writing · bearish", SC: "Call short covering · bullish", LU: "Call unwinding · bearish" }, PE: { LB: "Put buying · bearish", SB: "Put writing · bullish", SC: "Put short covering · bearish", LU: "Put unwinding · bullish" } };
    for (const right of ["CE", "PE"]) for (const tag of ["LB", "SB", "SC", "LU"]) expect(A.buildupReading(tag, right).text).toBe(want[right][tag]);
    expect(A.buildupReading(null, "CE")).toBeNull();
    const noOi = { rows: [{ strike: 1, ce: { oiChange: null, change: 1, bid: 1, ask: 1 } }] };
    expect(A.dominantBuildup(noOi)).toBeNull();
    const d = A.dominantBuildup({ rows: [{ strike: 1, ce: { oiChange: 100, change: -1, bid: 10, ask: 10 }, pe: { oiChange: 50, change: 1, bid: 10, ask: 10 } }] });
    expect(d).toMatchObject({ tag: "SB", right: "CE", rupees: 1000, text: "Call writing · bearish" });
  });

  it("hedgeRows: depth band, annualised, payout at −2σ, best per expiry, lots for a notional", () => {
    const ctx = { underlying: "NIFTY", expiry: "2026-11-24", F: 1000, T: 0.1, days: 36.5, lot: 10, atmIv: 20, rows: [900, 950, 980].map((k) => ({ strike: k, pe: { symbol: `p${k}`, ask: { 900: 2, 950: 5, 980: 9 }[k], bid: 1, iv: 22 } })), ranks: { pe: new Map() } };
    const rows = A.hedgeRows(null, ctx, { minDepth: 2, maxDepth: 10, notional: 100000 });
    expect(rows.map((r) => r.strike)).toEqual([900, 950, 980]);
    const r = rows[1];
    expect(r.depth).toBeCloseTo(5, 10);
    expect(r.costPct).toBeCloseTo(0.5, 10);
    expect(r.annualised).toBeCloseTo((0.5 * 365) / 36.5, 10);
    expect(r.payout).toBeCloseTo(Math.max(0, 950 - 1000 * Math.exp(-2 * 0.2 * Math.sqrt(0.1))) / 5, 10);
    expect(r.lots).toBe(10);
    expect(r.total).toBe(10 * 5 * 10);
    expect(A.hedgeRows(null, ctx, { minDepth: 3, maxDepth: 6 }).map((x) => x.strike)).toEqual([950]);
    const best = A.bestHedges([{ ...rows[0], annualised: 3 }, { ...rows[1], annualised: 3 }, { ...rows[2], annualised: 4 }]);
    expect(best.map((x) => x.strike)).toEqual([900]);
  });

  it("straddleVerdict: HV thresholds at the boundaries, peers fallback, < 3 peers null, expiry day", () => {
    expect(A.straddleVerdict({ days: 5, atmIv: 12, hv20: 10 })).toEqual({ label: "Rich", ratio: 1.2, basis: "hv" });
    expect(A.straddleVerdict({ days: 5, atmIv: 9, hv20: 10 }).label).toBe("Cheap");
    expect(A.straddleVerdict({ days: 5, atmIv: 10, hv20: 10 }).label).toBe("Fair");
    expect(A.straddleVerdict({ days: 0.4, atmIv: 12, hv20: 10 }).basis).toBe("expiry");
    const peers = [{ days: 4, straddle: 100, S: 10000 }, { days: 9, straddle: 150, S: 10000 }, { days: 16, straddle: 200, S: 10000 }];
    const me = { days: 4, straddle: 130, S: 10000, atmIv: 12, hv20: null };
    expect(A.straddleVerdict(me, peers)).toMatchObject({ label: "Rich vs peers", basis: "peers" });
    expect(A.straddleVerdict(me, peers.slice(0, 2))).toEqual({ label: null, ratio: null, basis: null });
  });

  it("costs: legs, round trip and arbitrage (with box settlement STT), NFO and BFO", () => {
    const buy = A.legCosts({ side: "BUY", price: 100, qty: 75, exchange: "NFO" });
    expect(buy.stt).toBe(0);
    expect(buy.stamp).toBeCloseTo(7500 * 0.00003, 12);
    expect(buy.txn).toBeCloseTo(7500 * 0.0003503, 12);
    expect(buy.gst).toBeCloseTo(0.18 * (20 + 7500 * 0.0003503 + 7500 * 10 / 1e7), 12);
    const sell = A.legCosts({ side: "SELL", price: 100, qty: 75, exchange: "BFO" });
    expect(sell.stt).toBeCloseTo(7500 * 0.0015, 12);
    expect(sell.stamp).toBe(0);
    expect(sell.txn).toBeCloseTo(7500 * 0.000325, 12);
    expect(sell.total).toBeCloseTo(sell.brokerage + sell.stt + sell.txn + sell.sebi + sell.gst, 12);
    const rt = A.roundTripCosts(100, 75, "NFO");
    expect(rt.total).toBeCloseTo(buy.total + A.legCosts({ side: "SELL", price: 100, qty: 75 }).total, 10);
    expect(A.legCosts({ side: "BUY", price: 100, qty: 75 }, { ...A.chargesPct(RATES), brokeragePerOrder: 0 }).brokerage).toBe(0);
    const box = { kind: "Box (buy)", legs: [{ side: "BUY", right: "CE", strike: 100, price: 5 }, { side: "SELL", right: "CE", strike: 110, price: 1 }, { side: "BUY", right: "PE", strike: 110, price: 6 }, { side: "SELL", right: "PE", strike: 100, price: 1 }] };
    const legsOnly = box.legs.reduce((a, l) => a + A.legCosts({ side: l.side, price: l.price, qty: 10 }).total, 0);
    expect(A.arbCosts(box, 10).total).toBeCloseTo(legsOnly + 10 * 10 * 0.0015, 10);
    // A sold box is long the K2 call and the K1 put: both OTM between the strikes, so no exercise STT.
    const sbox = { kind: "Box (sell)", legs: [{ side: "SELL", right: "CE", strike: 100, price: 5 }, { side: "BUY", right: "CE", strike: 110, price: 1 }, { side: "SELL", right: "PE", strike: 110, price: 6 }, { side: "BUY", right: "PE", strike: 100, price: 1 }] };
    const sLegs = sbox.legs.reduce((a, l) => a + A.legCosts({ side: l.side, price: l.price, qty: 10 }).total, 0);
    expect(A.arbCosts(sbox, 10).total).toBeCloseTo(sLegs, 10);
    const fly = { kind: "Butterfly", legs: [{ side: "BUY", price: 5, strike: 1 }, { side: "SELL", price: 3, strike: 2, qty: 2 }, { side: "BUY", price: 2, strike: 3 }] };
    expect(A.arbCosts(fly, 10).total).toBeCloseTo(A.legCosts({ side: "BUY", price: 5, qty: 10 }).total + A.legCosts({ side: "SELL", price: 3, qty: 20 }).total + A.legCosts({ side: "BUY", price: 2, qty: 10 }).total, 10);
  });

  it("arbChecks takes a negative minEdge and returns near misses, best first", () => {
    const rows = [100, 110, 120].map((k) => ({ strike: k, ce: { bid: { 100: 12, 110: 7, 120: 3 }[k], ask: { 100: 12.5, 110: 7.5, 120: 3 }[k] }, pe: null }));
    const c = { underlyingLtp: 110, rows };
    expect(A.arbChecks(c, { minEdge: 0.5 }).length).toBe(0);
    expect(A.arbChecks(c, { minEdge: -2 }).map((h) => h.kind)).toEqual(["Butterfly"]);
    const near = A.arbChecks(c, { minEdge: -6 });
    expect(near.length).toBe(4);
    expect(near[0]).toMatchObject({ kind: "Butterfly", edge: -1.5 });
    for (let i = 1; i < near.length; i++) expect(near[i - 1].edge).toBeGreaterThanOrEqual(near[i].edge);
    expect(near.every((h) => h.edge > -6)).toBe(true);
  });
});

describe("PRD 08 display helpers", () => {
  it("niceTicks gives round steps", () => {
    const t = O.niceTicks(25344, 27120, 5);
    const step = t[1] - t[0];
    expect([250, 500]).toContain(step);
    expect(t.every((v) => v % step === 0)).toBe(true);
    expect(t[0]).toBeGreaterThanOrEqual(25344);
    expect(t[t.length - 1]).toBeLessThanOrEqual(27120);
    expect(O.niceTicks(0, 0, 4)).toEqual([0]);
    const neg = O.niceTicks(-50000, 20000, 5);
    expect(neg).toContain(0);
    expect(neg[0]).toBeLessThan(0);
    expect(O.niceTicks(0, 100, 4)).toEqual([0, 50, 100]);
  });
  it("placeLabels nudges and merges colliding labels", () => {
    const apart = O.placeLabels([{ x: 100, w: 40, text: "A" }, { x: 300, w: 40, text: "B" }]);
    expect(apart.map((l) => l.text)).toEqual(["A", "B"]);
    expect(apart[1].x).toBe(300);
    const near = O.placeLabels([{ x: 100, w: 40, text: "A" }, { x: 140, w: 40, text: "B" }]);
    expect(near[1].x).toBeGreaterThanOrEqual(144);
    const merged = O.placeLabels([{ x: 100, w: 40, text: "25906" }, { x: 105, w: 40, text: "26420" }], { prefix: "BE " });
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe("BE 25906 · 26420");
    const clamped = O.placeLabels([{ x: 5, w: 40, text: "A" }], { lo: 0, hi: 200 });
    expect(clamped[0].x).toBe(20);
  });
  it("placeLabels re-checks a merged label against the one before it", () => {
    // Three marks 10 px apart after a fourth far left: the merged "b · c · d" would overlap "a", so all four merge.
    const four = O.placeLabels([{ x: 0, w: 40, text: "a" }, { x: 60, w: 40, text: "b" }, { x: 70, w: 40, text: "c" }, { x: 80, w: 40, text: "d" }]);
    expect(four.map((l) => l.text)).toEqual(["a · b · c · d"]);
    // A merged pair that clears the earlier label keeps it separate, and does not overlap it.
    const two = O.placeLabels([{ x: 0, w: 40, text: "a" }, { x: 100, w: 40, text: "b" }, { x: 105, w: 40, text: "c" }]);
    expect(two.map((l) => l.text)).toEqual(["a", "b · c"]);
    expect(two[1].x - 46).toBeGreaterThanOrEqual(two[0].x + 20 + 4);
  });
  it("expiryTag reads days and weekly / monthly", () => {
    const now = Date.parse("2026-10-29T03:00:00Z");
    const ex = ["2026-11-03", "2026-11-10", "2026-11-24"];
    expect(O.expiryTag("2026-11-03", ex, now)).toEqual({ days: "5d", kind: "W" });
    expect(O.expiryTag("2026-11-24", ex, now).kind).toBe("M");
    expect(O.expiryTag("2026-10-29", ["2026-10-29"], now).days).toBe("<1d");
    expect(O.expiryTag("2026-10-27", ex, now).days).toBe("Expired");
  });
  it("freshnessState picks one state", () => {
    const now = Date.parse("2026-10-29T06:00:00Z"); // 11:30 IST, Thursday
    const asOf = new Date(now - 2000).toISOString();
    expect(O.freshnessState({ asOf, now }).kind).toBe("live");
    expect(O.freshnessState({ asOf, now, error: true }).kind).toBe("error");
    expect(O.freshnessState({ asOf, now, live: false }).kind).toBe("paused");
    expect(O.freshnessState({ asOf, now, stale: true }).kind).toBe("stale");
    expect(O.freshnessState({ asOf: new Date(now - 20000).toISOString(), now }).kind).toBe("stale");
    expect(O.freshnessState({ asOf, now, marketOpen: false }).kind).toBe("closed");
    const sat = Date.parse("2026-10-31T06:00:00Z");
    expect(O.freshnessState({ asOf, now: sat }).kind).toBe("closed");
    expect(O.freshnessState({ asOf, now: sat, demo: true }).kind).not.toBe("closed");
    expect(O.freshnessState({ asOf, now }).ageMs).toBe(2000);
  });
  it("wideSpreadCount counts legs over the limit", () => {
    expect(O.wideSpreadCount([{ bid: 100, ask: 101 }, { bid: 10, ask: 12 }, null])).toBe(1);
  });
});

describe("colour scales (seqStep, divStep, scaleRange)", () => {
  it("seqStep maps lo..hi onto 1..5 and clamps outside", () => {
    expect(A.seqStep(0, 0, 100)).toBe(1);
    expect(A.seqStep(24.9, 0, 100)).toBe(1);
    expect(A.seqStep(25, 0, 100)).toBe(2);
    expect(A.seqStep(50, 0, 100)).toBe(3);
    expect(A.seqStep(75, 0, 100)).toBe(4);
    expect(A.seqStep(99, 0, 100)).toBe(4);
    expect(A.seqStep(100, 0, 100)).toBe(5);
    expect(A.seqStep(-50, 0, 100)).toBe(1);
    expect(A.seqStep(500, 0, 100)).toBe(5);
  });
  it("seqStep: missing values get no step; a flat range is the middle step", () => {
    expect(A.seqStep(null, 0, 1)).toBeNull();
    expect(A.seqStep(Number.NaN, 0, 1)).toBeNull();
    expect(A.seqStep(5, null, 10)).toBeNull();
    expect(A.seqStep(5, 5, 5)).toBe(3);
  });
  it("divStep is signed, capped at ±3, with a dead-band around zero", () => {
    expect(A.divStep(0, 10)).toBe(0);
    expect(A.divStep(0.4, 10)).toBe(0);
    expect(A.divStep(-0.4, 10)).toBe(0);
    expect(A.divStep(0.5, 10)).toBe(1);
    expect(A.divStep(3.3, 10)).toBe(1);
    expect(A.divStep(3.4, 10)).toBe(2);
    expect(A.divStep(6.7, 10)).toBe(3);
    expect(A.divStep(10, 10)).toBe(3);
    expect(A.divStep(-50, 10)).toBe(-3);
    expect(A.divStep(-5, 10)).toBe(-2);
  });
  it("divStep: missing values and a zero scale", () => {
    expect(A.divStep(null, 10)).toBeNull();
    expect(A.divStep(Number.POSITIVE_INFINITY, 10)).toBeNull();
    expect(A.divStep(2, 0)).toBeNull();
    expect(A.divStep(0, 0)).toBe(0);
  });
  it("scaleRange ignores outliers via the 5th / 95th percentiles", () => {
    const v = [...Array.from({ length: 99 }, (_, i) => i + 1), 10000];
    const r = A.scaleRange(v);
    expect(r.lo).toBeCloseTo(5.95, 6);
    expect(r.hi).toBeCloseTo(95.05, 6);
    expect(A.seqStep(10000, r.lo, r.hi)).toBe(5);
    expect(A.seqStep(50, r.lo, r.hi)).toBe(2);
    expect(A.seqStep(60, r.lo, r.hi)).toBe(3);
    expect(A.scaleRange([]).lo).toBeNull();
    expect(A.scaleRange([-4, 2, null, Number.NaN]).m).toBeCloseTo(3.9, 6);
  });
});

describe("chain round 2 helpers", () => {
  it("heatAlpha follows a0 + a1·frac^0.75, clamped", () => {
    expect(A.heatAlpha(0)).toBe(0);
    expect(A.heatAlpha(null)).toBe(0);
    expect(A.heatAlpha(1)).toBeCloseTo(0.48, 9);
    expect(A.heatAlpha(2)).toBeCloseTo(0.48, 9);
    expect(A.heatAlpha(0.5, 0.05, 0.32)).toBeCloseTo(0.05 + 0.32 * 0.5 ** 0.75, 9);
    expect(A.heatShape(0.5)).toBeCloseTo(0.5 ** 0.75, 9);
  });
  it("strike PCR and straddle", () => {
    const row = { strike: 100, ce: { oi: 200, bid: 4, ask: 6 }, pe: { oi: 300, ltp: 3 } };
    expect(A.strikePcr(row)).toBeCloseTo(1.5, 9);
    expect(A.strikePcr({ ce: { oi: 0 }, pe: { oi: 5 } })).toBeNull();
    expect(A.strikeStraddle(row)).toBeCloseTo(8, 9);
    expect(A.strikeStraddle({ ce: { ltp: 1 } })).toBeNull();
  });
  it("withOiWindow measures OI change against a snapshot", () => {
    const chain = { rows: [{ strike: 100, ce: { oi: 150, ltp: 12, oiChange: 999, change: 5 }, pe: { oi: 80, ltp: 4 } }, { strike: 110, ce: { oi: 10, ltp: 1 }, pe: null }] };
    const snap = { k: [100], co: [100], po: [100], cl: [10], pl: [5], cv: [null], pv: [null] };
    const w = A.withOiWindow(chain, snap);
    expect(w.rows[0].ce.oiChange).toBe(50);
    expect(w.rows[0].ce.winChange).toBe(2);
    expect(w.rows[0].ce.change).toBe(5);
    expect(w.rows[0].pe.oiChange).toBe(-20);
    // 110 is not in the snapshot: no change over the window (not its whole OI counted as added).
    expect(w.rows[1].ce.oiChange).toBeNull();
    expect(w.rows[1].ce.winChange).toBeNull();
    expect(w.rows[1].ce.oi).toBe(10);
    expect(w.rows[1].pe).toBeNull();
    expect(A.withOiWindow(chain, null)).toBe(chain);
    expect(chain.rows[0].ce.oiChange).toBe(999);
  });
});

describe("OI page visuals (pcrGaugePos, buildupHeat, spotX)", () => {
  it("pcrGaugePos is a log scale from 0.4 to 2.5, clamped", () => {
    expect(A.pcrGaugePos(0.4)).toBe(0);
    expect(A.pcrGaugePos(2.5)).toBe(1);
    expect(A.pcrGaugePos(0.1)).toBe(0);
    expect(A.pcrGaugePos(9)).toBe(1);
    expect(A.pcrGaugePos(1)).toBeCloseTo(Math.log(2.5) / Math.log(6.25), 10);
    // Log symmetry: 0.5 and 2 sit the same distance either side of 1.
    const mid = A.pcrGaugePos(1);
    expect(mid - A.pcrGaugePos(0.5)).toBeCloseTo(A.pcrGaugePos(2) - mid, 10);
    expect(A.pcrGaugePos(null)).toBeNull();
    expect(A.pcrGaugePos(0)).toBeNull();
    expect(A.pcrGaugePos(-1)).toBeNull();
    expect(A.pcrGaugePos("x")).toBeNull();
  });
  it("buildupHeat steps each cell by its share of the largest and reads its effect per side", () => {
    const cell = (n, lots) => ({ n, lots });
    const bu = {
      ce: { LB: cell(2, 30), SB: cell(5, 90), SC: cell(0, 0), LU: cell(1, 10), CH: cell(1, 5) },
      pe: { LB: cell(1, 31), SB: cell(3, 60), SC: cell(0, 0), LU: cell(0, 0), CH: cell(0, 0) },
    };
    const m = A.buildupHeat(bu);
    expect(m.ce.SB).toEqual({ n: 5, lots: 90, effect: "neg", step: 3 });
    expect(m.ce.LB).toMatchObject({ effect: "pos", step: 1 });
    expect(m.pe.LB).toMatchObject({ effect: "neg", step: 2 });
    expect(m.pe.SB).toMatchObject({ effect: "pos", step: 2 });
    expect(m.ce.SC).toMatchObject({ effect: "pos", step: 0 });
    expect(m.pe.LU).toMatchObject({ effect: "pos", step: 0 });
    expect(m.ce.LU).toMatchObject({ effect: "neg", step: 1 });
    expect(m.ce.CH).toMatchObject({ effect: "neutral", step: 1 });
    // Empty or missing input: every cell is zero, no step.
    const e = A.buildupHeat(null);
    expect(e.ce.LB).toEqual({ n: 0, lots: 0, effect: "pos", step: 0 });
    expect(Object.keys(e.pe)).toEqual(["LB", "SB", "SC", "LU", "CH"]);
  });
  it("spotX interpolates between strikes and is null outside them", () => {
    const ks = [26300, 26350, 26400, 26450];
    expect(A.spotX(ks, 26300)).toBe(0);
    expect(A.spotX(ks, 26450)).toBe(3);
    expect(A.spotX(ks, 26400)).toBe(2);
    expect(A.spotX(ks, 26417.5)).toBeCloseTo(2.35, 10);
    expect(A.spotX(ks, 26299)).toBeNull();
    expect(A.spotX(ks, 26451)).toBeNull();
    expect(A.spotX([], 26400)).toBeNull();
    expect(A.spotX(ks, null)).toBeNull();
    expect(A.spotX([26400], 26400)).toBe(0);
  });
});

// ── Reference values passed in (docs/spec/p1-02-reference.md §5.6, P1-2b) ──
describe("reference values are parameters, not constants", () => {
  const ist = (y, mo, d, hh = 10, mm = 0) => Date.UTC(y, mo - 1, d, hh, mm) - 5.5 * 3600 * 1000;
  const SESSION = { preOpen: "09:00", open: "09:15", close: "15:30", holiday: null, date: null };
  // 24 Nov 2026 (Tue) is on the shipped holiday list; 10 Nov too.
  const holidays = new Set(["2026-11-10", "2026-11-24"]);
  const isTradingDay = (d) => {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    return dow !== 0 && dow !== 6 && !holidays.has(d);
  };

  it("marketSession reads the session times and closes on a holiday", () => {
    expect(A.marketSession(ist(2026, 11, 2, 9, 14), SESSION).phase).toBe("pre");
    expect(A.marketSession(ist(2026, 11, 2, 9, 15), SESSION).phase).toBe("open");
    // A later close from the reference (a special day) moves the end.
    expect(A.marketSession(ist(2026, 11, 2, 15, 45), { ...SESSION, close: "16:00" }).phase).toBe("open");
    // Today's session is a holiday: closed all day, with its label.
    const hol = A.marketSession(ist(2026, 11, 10, 11), { ...SESSION, date: "2026-11-10", holiday: { label: "Diwali Balipratipada", verified: false } });
    expect(hol).toMatchObject({ phase: "closed", holiday: "Diwali Balipratipada", label: "Market closed · Diwali Balipratipada" });
    // The calendar knows other days' holidays too.
    expect(A.marketSession(ist(2026, 11, 24, 11), SESSION, { isTradingDay }).phase).toBe("closed");
    expect(A.marketSession(ist(2026, 11, 23, 11), SESSION, { isTradingDay }).phase).toBe("open");
  });

  it("sessionsLeft skips holidays when the calendar is given", () => {
    // Mon 23 Nov 10:00 → Fri 27 Nov: 23, 25, 26, 27 (24 is a holiday) = 4; weekdays only would say 5.
    expect(A.sessionsLeft("2026-11-27", ist(2026, 11, 23, 10))).toBe(5);
    expect(A.sessionsLeft("2026-11-27", ist(2026, 11, 23, 10), { session: SESSION, isTradingDay })).toBe(4);
    expect(A.maxPainRelevance("2026-11-27", ist(2026, 11, 23, 10), { session: SESSION, isTradingDay })).toBe("medium");
    // After the reference close, today no longer counts.
    expect(A.sessionsLeft("2026-11-27", ist(2026, 11, 23, 15, 45), { session: SESSION, isTradingDay })).toBe(3);
    expect(A.sessionsLeft("2026-11-27", ist(2026, 11, 23, 15, 45), { session: { ...SESSION, close: "16:00" }, isTradingDay })).toBe(4);
  });

  it("timeToExpiry and expiryCloseMs settle at the session close", () => {
    expect(new Date(A.expiryCloseMs("2026-11-03", "15:30")).toISOString()).toBe("2026-11-03T10:00:00.000Z");
    expect(new Date(A.expiryCloseMs("2026-11-03", "15:00")).toISOString()).toBe("2026-11-03T09:30:00.000Z");
    expect(A.timeToExpiry("2026-11-03", ist(2026, 11, 3, 15, 10), "15:00").label).toBe("Expired");
    expect(A.timeToExpiry("2026-11-03", ist(2026, 11, 3, 15, 10), "15:30").label).toBe("Expires today");
    expect(A.timeToExpiry("2026-11-03", ist(2026, 11, 3, 14, 30), "15:30").days).toBeCloseTo(1 / 24, 9);
  });

  it("chargesPct derives the screener's percent table from the reference table (same figures as before)", () => {
    expect(A.chargesPct(RATES)).toEqual({ asOf: "2026-04-01", brokeragePerOrder: 20, sttSellPct: 0.15, sttExercisePct: 0.15, txnPct: { NFO: 0.03503, BFO: 0.0325 }, sebiPerCrore: 10, stampBuyPct: 0.003, gstPct: 18 });
    const zero = A.chargesPct({ ...RATES, brokeragePerOrder: 0 });
    expect(A.legCosts({ side: "BUY", price: 100, qty: 75 }, zero).brokerage).toBe(0);
    // legCosts on the derived table equals charges() on the same table (one rate table).
    const viaPct = A.legCosts({ side: "SELL", price: 100, qty: 75, exchange: "NFO" }, A.chargesPct(RATES));
    const viaRates = A.charges([{ kind: "OPT", side: "SELL", right: "CE", strike: 26000, price: 100, lots: 1, on: true, symbol: "NFO:NIFTY-2026-11-03-26000-CE" }], RATES, { lotSize: 75 });
    expect(viaPct.total).toBeCloseTo(viaRates.total, 9);
  });

  it("refCharges reads the server's charge table and its brokerage", () => {
    const server = { asOf: "2026-04-01", source: "Union Budget 2026 STT", opt: { sttSell: 0.002, exerciseStt: 0.0015, stampBuy: 0.00003, txn: { NSE: 0.0003503, BSE: 0.000325 } }, fut: { sttSell: 0.0005, stampBuy: 0.00002, txn: { NSE: 0.0000173, BSE: 0 } }, sebiPerCrore: 10, ipftPerCrore: 0, gst: 0.18, brokerage: { kind: "flat", perOrder: 15 } };
    const r = refCharges({ charges: server });
    expect(r).toMatchObject({ asOf: "Apr 2026", asOfDate: "2026-04-01", brokeragePerOrder: 15, source: "Union Budget 2026 STT" });
    expect(r.opt.sttSell).toBe(0.002);
    expect(A.charges([{ kind: "OPT", side: "SELL", right: "CE", strike: 1, price: 100, lots: 1, on: true }], r, { lotSize: 1 }).brokerage).toBe(15);
  });

  it("arbFlags reads the market hours from the reference session", () => {
    const flags = (m, ses) => A.arbFlags({ legs: [] }, { nowMs: m, session: ses }).map((f) => f.code);
    expect(flags(ist(2026, 11, 2, 9, 5), SESSION)).toContain("NEAR_CLOSE");
    expect(flags(ist(2026, 11, 2, 11), SESSION)).not.toContain("MARKET_CLOSED");
    expect(flags(ist(2026, 11, 2, 11), { ...SESSION, holiday: { label: "Holiday" } })).toContain("MARKET_CLOSED");
    expect(flags(ist(2026, 11, 2, 15, 35), SESSION)).toContain("MARKET_CLOSED");
  });
});
