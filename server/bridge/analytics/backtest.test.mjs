import { describe, expect, it } from "vitest";
import { EXAMPLES, MAX_BARS, backtestRoutes, backtestSchema } from "./backtest.mjs";
import { parseExpression } from "../scanner/expr.mjs";
import { createFakeMarketData } from "../market/fake.mjs";

const T0 = Date.parse("2026-01-05T03:45:00Z") / 1000; // 09:15 IST, a Monday
const DAY = 86_400;
const candle = (i, [o, h, l, c]) => ({ time: T0 + i * DAY, open: o, high: h, low: l, close: c, volume: 1000 });
const mk = (rows) => rows.map((r, i) => candle(i, r));
const flat = (prices) => mk(prices.map((p) => [p, p, p, p]));

// Hand-checked series. Entry "close > 104" signals on bars 2, 3, 4; the first fill is bar 3's open (106).
const BASE = mk([
  [100, 101, 99, 100], // 0
  [100, 102, 99, 101], // 1
  [101, 106, 100, 105], // 2 signal (close 105 > 104)
  [106, 108, 105, 107], // 3 fill 106
  [107, 110, 106, 109], // 4
  [109, 109, 100, 101], // 5 close 101 < 102: exit signal
  [99, 100, 97, 98], // 6 exit fill at open 99
  [98, 99, 96, 97], // 7
  [97, 98, 95, 96], // 8
  [96, 103, 95, 102], // 9
]);

const ctx = (body) => ({ query: new URLSearchParams(), body, requestId: "r1", principal: { kind: "local" }, requireAccountAccess() {} });
function setup(candles = BASE, symbol = "NSE:TEST") {
  const md = createFakeMarketData({ prices: { [symbol]: 100 } });
  md.setCandles(symbol, "1d", candles);
  const routes = backtestRoutes({ marketData: md });
  const find = (m, p) => routes.find((r) => r[0] === m && r[1] === p);
  const post = find("POST", "/v1/analytics/backtest")[3];
  return { md, routes, post, examples: find("GET", "/v1/analytics/backtest/examples")[3] };
}
const base = { symbol: "NSE:TEST", entry: "close > 104", exit: "close < 102", quantity: 10, initialCapital: 10000, feesPct: 0, slippagePct: 0 };
const run = async (extra = {}, candles) => (await setup(candles).post(ctx({ ...base, ...extra }))).data;
const fails = async (body, candles) => {
  try {
    await setup(candles).post(ctx(body));
  } catch (e) {
    return e;
  }
  return null;
};

describe("trades on fixed candles", () => {
  it("signals on the close and fills at the next open", async () => {
    const d = await run();
    expect(d.trades).toHaveLength(1);
    const t = d.trades[0];
    expect(t).toMatchObject({ side: "long", entryBar: 3, entryPrice: 106, exitBar: 6, exitPrice: 99, quantity: 10, grossPnl: -70, fees: 0, netPnl: -70, barsHeld: 3, exitReason: "signal" });
    expect(t.entryDate).toBe("2026-01-08");
    expect(t.exitDate).toBe("2026-01-11");
    expect(d.stats).toMatchObject({ trades: 1, wins: 0, losses: 1, finalEquity: 9930, totalReturnPct: -0.7, winRatePct: 0, profitFactor: 0 });
    expect(d.equityCurve).toHaveLength(10);
    expect(d.equityCurve[4].equity).toBe(10000 + 10 * (109 - 106));
    expect(d.method.summary).toMatch(/not predictive/);
    expect(d.method.costs).toMatch(/OPEN|open|slippage/);
  });

  it("charges fees on both fills", async () => {
    const t = (await run({ feesPct: 1 })).trades[0];
    expect(t.fees).toBeCloseTo(10.6 + 9.9, 6);
    expect(t.netPnl).toBe(-90.5);
  });

  it("moves fills against the trader with slippage", async () => {
    const t = (await run({ slippagePct: 1 })).trades[0];
    expect(t.entryPrice).toBe(107.06);
    expect(t.exitPrice).toBe(98.01);
    expect(t.netPnl).toBe(-90.5);
  });

  it("stops out intrabar from the entry fill, at the stop price", async () => {
    const d = await run({ stopLossPct: 5 });
    expect(d.trades[0]).toMatchObject({ exitBar: 5, exitPrice: 100.7, exitReason: "stop", netPnl: -53, barsHeld: 3 });
  });

  it("exits at a target, and re-enters on a later signal", async () => {
    const d = await run({ targetPct: 3, exit: undefined });
    expect(d.trades[0]).toMatchObject({ exitBar: 4, exitPrice: 109.18, exitReason: "target", netPnl: 31.8, barsHeld: 2 });
    // bar 4 closes at 109 > 104, so a new entry fills at bar 5's open (109) and is closed at the end
    expect(d.trades[1]).toMatchObject({ entryBar: 5, entryPrice: 109, exitBar: 9, exitPrice: 102, exitReason: "end", netPnl: -70 });
  });

  it("exits after maxBarsInTrade at the next open", async () => {
    const d = await run({ maxBarsInTrade: 2, exit: undefined });
    expect(d.trades[0]).toMatchObject({ entryBar: 3, exitBar: 5, exitPrice: 109, exitReason: "time", barsHeld: 2, netPnl: 30 });
  });

  it("shorts profit when price falls", async () => {
    const t = (await run({ side: "short" })).trades[0];
    expect(t).toMatchObject({ side: "short", entryPrice: 106, exitPrice: 99, grossPnl: 70, netPnl: 70 });
  });

  it("assumes the stop hit first when one bar touches both levels", async () => {
    const rows = mk([
      [100, 100, 100, 100],
      [100, 106, 94, 100], // entry fill 100; stop 95 and target 105 are both inside the range
      [100, 100, 100, 100],
    ]);
    const t = (await run({ entry: "close > 99", exit: undefined, stopLossPct: 5, targetPct: 5 }, rows)).trades[0];
    expect(t).toMatchObject({ exitReason: "stop", exitPrice: 95, entryBar: 1, exitBar: 1 });
  });

  it("fills a gap through the stop at the open", async () => {
    const rows = mk([
      [100, 100, 100, 100],
      [100, 101, 99, 100],
      [90, 91, 88, 89],
    ]);
    const t = (await run({ entry: "close > 99", exit: undefined, stopLossPct: 5 }, rows)).trades[0];
    expect(t).toMatchObject({ exitReason: "stop", exitPrice: 90, exitBar: 2, netPnl: -100 });
  });

  it("closes an open position at the last close, and never enters on the last bar", async () => {
    const d = await run({ entry: "close > 0", exit: undefined }, flat([10, 10, 10, 12]));
    expect(d.trades).toHaveLength(1);
    expect(d.trades[0]).toMatchObject({ entryBar: 1, exitBar: 3, exitPrice: 12, exitReason: "end", netPnl: 20 });
  });

  it("skips a quantity it cannot afford and says so", async () => {
    const d = await run({ quantity: 1000 });
    expect(d.trades).toHaveLength(0);
    expect(d.skippedEntries).toBeGreaterThan(0);
    expect(d.warnings.join(" ")).toMatch(/skipped/);
  });

  it("sizes by capitalPct with whole units", async () => {
    const d = await run({ quantity: undefined, capitalPct: 50 });
    expect(d.trades[0].quantity).toBe(Math.floor(5000 / 106));
  });
});

describe("no lookahead", () => {
  it("is unaffected by candles after the decision bar", async () => {
    const future = BASE.slice(0, 5).concat(mk([[1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1]]).map((c, i) => ({ ...c, time: T0 + (5 + i) * DAY })));
    const a = await run({ exit: undefined, maxBarsInTrade: 50 });
    const b = await run({ exit: undefined, maxBarsInTrade: 50 }, future);
    expect(b.trades[0].entryPrice).toBe(a.trades[0].entryPrice);
    expect(b.equityCurve.slice(0, 5)).toEqual(a.equityCurve.slice(0, 5));
  });

  it("does not fill on the signal bar itself", async () => {
    const t = (await run()).trades[0];
    expect(t.entryBar).toBe(3); // signal on bar 2 (close 105), never bar 2's own open 101 or close 105
    expect(t.entryPrice).not.toBe(105);
  });
});

describe("statistics", () => {
  it("matches a hand computation over two trades", async () => {
    const d = await run({ entry: "close == 100", exit: "close == 90", quantity: 4, initialCapital: 1000 }, flat([50, 100, 80, 80, 90, 100, 70, 65]));
    expect(d.trades.map((t) => [t.entryPrice, t.exitPrice, t.netPnl, t.exitReason])).toEqual([
      [80, 100, 80, "signal"],
      [70, 65, -20, "end"],
    ]);
    expect(d.equityCurve.map((p) => p.equity)).toEqual([1000, 1000, 1000, 1000, 1040, 1080, 1080, 1060]);
    expect(d.stats).toMatchObject({
      trades: 2,
      wins: 1,
      losses: 1,
      netPnl: 60,
      finalEquity: 1060,
      totalReturnPct: 6,
      winRatePct: 50,
      profitFactor: 4,
      expectancy: 30,
      avgWin: 80,
      avgLoss: -20,
      maxDrawdownPct: 1.85,
      maxDrawdown: 20,
      exposurePct: 62.5,
      bestTrade: { id: 1, netPnl: 80 },
      worstTrade: { id: 2, netPnl: -20 },
      cagrPct: null,
      sharpe: null,
    });
    expect(d.stats.peakDate).toBe("2026-01-10");
    expect(d.stats.troughDate).toBe("2026-01-12");
    expect(d.stats.recoveryDate).toBeNull();
    // buy and hold: 20 units at 50, out at 65
    expect(d.buyAndHold).toMatchObject({ quantity: 20, finalEquity: 1300, totalReturnPct: 30, strategyMinusBuyAndHoldPct: -24 });
  });

  it("computes Sharpe and CAGR on a long run", async () => {
    const rows = flat(Array.from({ length: 300 }, (_, i) => 100 + i * 0.1 + (i % 2)));
    const d = await run({ entry: "close > 0", exit: undefined, quantity: undefined, capitalPct: 100 }, rows);
    expect(d.stats.sharpe).toBeGreaterThan(0);
    expect(Number.isFinite(d.stats.cagrPct)).toBe(true);
    expect(d.method.sharpe).toMatch(/sqrt\(252\)/);
  });
});

describe("validation and bounds", () => {
  it("rejects unsupported fields and bad numbers", async () => {
    for (const bad of [
      { extra: 1 },
      { stopLossPct: 0 },
      { stopLossPct: 101 },
      { targetPct: -1 },
      { quantity: 1.5 },
      { quantity: 0 },
      { initialCapital: "1000" },
      { feesPct: 6 },
      { slippagePct: -0.1 },
      { maxBarsInTrade: 0 },
      { side: "both" },
      { interval: "2d" },
      { countback: 5001 },
      { from: "2026-13-40" },
      { capitalPct: 150 },
      { feesPct: Infinity },
      { initialCapital: Number.NaN },
    ]) {
      const e = await fails({ ...base, ...bad });
      expect(e?.code, JSON.stringify(bad)).toBe("VALIDATION_FAILED");
    }
  });

  it("rejects conflicting options", async () => {
    expect((await fails({ ...base, capitalPct: 50 }))?.code).toBe("VALIDATION_FAILED");
    expect((await fails({ ...base, quantity: undefined, from: "2026-01-01", countback: 5 }))?.code).toBe("VALIDATION_FAILED");
    expect((await fails({ ...base, from: "2026-02-01", to: "2026-01-01" }))?.code).toBe("VALIDATION_FAILED");
    expect((await fails({ ...base, to: "2026-02-01" }))?.code).toBe("VALIDATION_FAILED");
  });

  it("rejects bad symbols and conditions with the scanner's limits", async () => {
    expect((await fails({ ...base, symbol: "reliance!!" }))?.code).toBe("VALIDATION_FAILED");
    expect((await fails({ ...base, entry: "foo(3) > 1" }))?.code).toBe("VALIDATION_FAILED");
    expect((await fails({ ...base, exit: "close >" }))?.code).toBe("VALIDATION_FAILED");
    expect((await fails({ ...base, entry: `close > ${"1 + ".repeat(200)}1` }))?.code).toBe("VALIDATION_FAILED");
    expect((await fails({ ...base, entry: "sma(9999) > 1" }))?.code).toBe("VALIDATION_FAILED");
    expect((await fails({ ...base, entry: "a".repeat(1001) }))?.code).toBe("VALIDATION_FAILED");
    expect((await fails({ ...base, entry: undefined }))?.code).toBe("VALIDATION_FAILED");
  });

  it("rejects more than the bar limit", async () => {
    const many = Array.from({ length: MAX_BARS + 1 }, (_, i) => candle(i, [10, 10, 10, 10]));
    const e = await fails({ ...base, from: "2020-01-01" }, many);
    expect(e?.code).toBe("VALIDATION_FAILED");
    expect(e.detail ?? e.message).toMatch(/5000/);
  });

  it("rejects runs that make too many trades", async () => {
    const rows = Array.from({ length: 2100 }, (_, i) => candle(i, [100, 100, 98, 100]));
    const e = await fails({ ...base, entry: "close > 0", exit: undefined, stopLossPct: 1, quantity: 1, initialCapital: 1e6, from: "2020-01-01" }, rows);
    expect(e?.code).toBe("VALIDATION_FAILED");
    expect(e.detail ?? e.message).toMatch(/2000 trades/);
  });

  it("reports too few candles", async () => {
    const e = await fails(base, mk([[1, 1, 1, 1]]));
    expect(e?.code).toBe("NOT_FOUND");
  });

  it("warns when the condition cannot warm up", async () => {
    const d = await run({ entry: "sma(50) > 1", exit: undefined });
    expect(d.warnings.join(" ")).toMatch(/warm/);
    expect(d.trades).toHaveLength(0);
  });
});

describe("examples route", () => {
  it("returns five bodies that all validate and parse", async () => {
    const { examples } = setup();
    const r = await examples(ctx());
    expect(r.data.examples).toHaveLength(5);
    expect(EXAMPLES).toHaveLength(5);
    for (const e of r.data.examples) {
      expect(backtestSchema.safeParse(e.body).success, e.id).toBe(true);
      parseExpression(e.body.entry);
      if (e.body.exit) parseExpression(e.body.exit);
    }
  });

  it("is registered read-only", () => {
    const { routes } = setup();
    expect(routes.map((r) => [r[0], r[1], r[2].scope])).toEqual([
      ["POST", "/v1/analytics/backtest", "read"],
      ["GET", "/v1/analytics/backtest/examples", "read"],
    ]);
  });
});
