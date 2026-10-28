/** Option Desk maths (options.js): chain reads, pricing and strategy payoffs. */
import { describe, expect, it } from "vitest";
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
