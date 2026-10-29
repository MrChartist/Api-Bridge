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
    const g = O.parityGrowth(years);
    expect(g).toBeCloseTo(Math.exp(O.RISK_FREE * years), 12);
    expect(O.parityGrowth(0)).toBe(1);
    const D = Math.exp(-O.RISK_FREE * years);
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
      "Range 25900–26500 · Writers on both sides · PCR 1.08 balanced · Max pain 26300 (low relevance)",
    );
    expect(OA.oiVerdict({ pcr: 1.3 })).toBe("PCR 1.30 put-heavy");
    expect(OA.oiVerdict({ walls: { r1: 26500, s1: null } })).toBe("Resistance 26500");
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
    expect(O.exitPlan([{ ...legs[0], q: 225 }], { pct: 50 }).orders[0].qty).toBe(150);
    expect(O.exitPlan([{ ...legs[0], q: 75 }], { pct: 25 }).orders[0].qty).toBe(75);
    expect(O.exitPlan([{ ...legs[0], q: 37 }], { pct: 50 }).orders[0].qty).toBe(37);
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
    expect(c).toEqual({ cols: ["pnl", "gamma"], group: "expiry", closed: false, ladder: "wide", axis: "days", lossLimit: 5000, exitType: "touch", hedge: { method: "gamma", side: "SELL" }, excluded: { "demo-paper": ["NFO:NIFTY-2026-11-03-26000-CE"] }, chartSlot: true });
    expect(O.positionsConfig({ cols: [], lossLimit: -3 }).cols).toEqual([...O.POSITIONS_DEFAULTS.cols]);
    expect(O.positionsConfig({ lossLimit: -3 }).lossLimit).toBeNull();
  });
});

// ── Volatility (the #/vol page, PRD 05) ──
describe("volatility", () => {
  const {
    RATE,
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
