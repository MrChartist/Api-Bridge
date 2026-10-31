/**
 * Strategy backtest (stream S15). Read-only: it fetches candles and replays a scanner condition over them; nothing
 * here can place an order.
 *
 *   POST /v1/analytics/backtest            run one backtest
 *   GET  /v1/analytics/backtest/examples   five ready-made request bodies
 *
 * Conditions use the scanner language (scanner/expr.mjs, same parser, same limits). Rules, in bar order:
 *  1. A signal is read on the CLOSE of bar i (indicators only see bars 0..i) and filled at the OPEN of bar i+1.
 *  2. One position at a time. While a position is open, entry signals are ignored.
 *  3. After an entry fill, the stop loss and target are checked against that bar's high and low (and every later bar).
 *     A gap through a level fills at the open; if one bar touches both, the stop is assumed to have hit first.
 *  4. The exit condition and maxBarsInTrade are read on the close and fill at the next open. A position still open
 *     on the last bar is closed at that bar's close (exitReason "end").
 */
import { z } from "zod";
import { BridgeError } from "../core/errors.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { INTERVALS, isIntraday } from "../market/history.mjs";
import { autoBackupFor, readOptionsBase } from "../market/routes.mjs";
import { istDate, istDateTime } from "../market/time.mjs";
import { columns, evaluate, lookbackOf, parseExpression } from "../scanner/expr.mjs";

export const MAX_BARS = 5000;
export const MAX_TRADES = 2000;
const DEFAULT_COUNTBACK = 500;
const MIN_BARS = 2;
const YEAR_S = 365.25 * 86_400;

const DEFAULTS = Object.freeze({ initialCapital: 100_000, feesPct: 0.05, slippagePct: 0.05 });

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), "is not a real date");
const pct = (max) => z.number().finite().gt(0).max(max);

export const backtestSchema = z
  .strictObject({
    symbol: z.string().min(3).max(64),
    interval: z.enum(INTERVALS).default("1d"),
    from: date.optional(),
    to: date.optional(),
    countback: z.number().int().min(MIN_BARS).max(MAX_BARS).optional(),
    entry: z.string().min(1).max(1000),
    exit: z.string().min(1).max(1000).optional(),
    stopLossPct: pct(100).optional(),
    targetPct: pct(1000).optional(),
    maxBarsInTrade: z.number().int().min(1).max(MAX_BARS).optional(),
    side: z.enum(["long", "short"]).default("long"),
    initialCapital: z.number().finite().gt(0).max(1e12).default(DEFAULTS.initialCapital),
    quantity: z.number().int().min(1).max(1e9).optional(),
    capitalPct: pct(100).optional(),
    feesPct: z.number().finite().min(0).max(5).default(DEFAULTS.feesPct),
    slippagePct: z.number().finite().min(0).max(5).default(DEFAULTS.slippagePct),
  })
  .refine((b) => !(b.quantity !== undefined && b.capitalPct !== undefined), { message: "Give quantity or capitalPct, not both.", path: ["quantity"] })
  .refine((b) => !(b.from !== undefined && b.countback !== undefined), { message: "Give from/to or countback, not both.", path: ["countback"] })
  .refine((b) => !(b.to !== undefined && b.from === undefined && b.countback === undefined), { message: "to needs from or countback.", path: ["to"] })
  .refine((b) => !(b.from && b.to && b.from > b.to), { message: "from must not be after to.", path: ["from"] });

const invalid = (path, message) => new BridgeError("VALIDATION_FAILED", message, { errors: [{ path, message }] });

function parseBody(body) {
  const r = backtestSchema.safeParse(body ?? {});
  if (r.success) return r.data;
  const errors = r.error.issues.map((i) => ({ path: i.path.join(".") || "(body)", message: i.message }));
  throw new BridgeError("VALIDATION_FAILED", `The request is not valid: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`, { errors });
}

const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

export const METHOD = Object.freeze({
  summary: "Bar-by-bar replay of a scanner condition over historical candles. Past performance is not predictive of future results; this is an educational what-if, not advice, and nothing here places orders.",
  signals: "Entry and exit conditions are evaluated on the CLOSE of each bar using only that bar and earlier ones (no lookahead). A signal fills at the OPEN of the next bar.",
  positions: "One position at a time, long or short, no pyramiding, no leverage (size is limited to available equity). Entry signals while in a position are ignored.",
  stops: "Stop loss and target are measured from the entry fill price and checked against each bar's high and low, starting with the entry bar. A gap through a level fills at that bar's open. If one bar touches both, the stop is assumed to hit first. maxBarsInTrade counts the entry bar as 1 and exits at the next open.",
  endOfData: "A position still open on the last bar is closed at that bar's close (exitReason end).",
  costs: "feesPct is charged on the notional of every fill (entry and exit). slippagePct moves every fill against you (buys higher, sells lower). Defaults are 0.05 percent each. Real brokerage, STT, GST, stamp duty, exchange charges, taxes, liquidity limits, circuit limits and partial fills are not modelled. Prices are as the broker reports them (not adjusted unless the broker adjusts them).",
  sizing: "quantity fixes the units per trade (a trade that cannot be afforded is skipped and counted in skippedEntries). Otherwise capitalPct (default 100) of current equity buys as many whole units as fit.",
  equity: "Equity is mark-to-market at each bar close: initialCapital plus closed-trade net P&L plus open P&L after entry fees. Profits are compounded when sizing by capitalPct.",
  sharpe: "Sharpe = mean / sample standard deviation of per-day equity returns (last equity of each IST day; weekly and monthly bars use per-bar returns) times sqrt(252) (52 for 1w, 12 for 1M), risk-free rate 0, null with fewer than 10 returns or zero deviation.",
  cagr: "CAGR uses elapsed calendar time between the first and last candle (365.25 days per year); null for windows under one month.",
  buyAndHold: "Buy at the first bar's open and hold to the last close, with the same fees and slippage and the same initial capital (whole units, 100 percent of capital), always long.",
  exposure: "Exposure is the share of bars during which a position was open (a bar counts if the position was held at any point after that bar's open fill).",
  warmup: "Indicators warm up inside the fetched window, so signals can only start after enough bars (a 50-bar average needs 50 bars). Ask for extra countback or an earlier from date for that.",
});

// ── simulation ──

/** Maximum drawdown over equity values, with the dates of the peak, trough and recovery. */
function drawdownOf(equity, dates, startEquity, startDate) {
  let peak = startEquity;
  let peakDate = startDate;
  let worst = { pct: 0, amount: 0, peakDate: null, troughDate: null, peak: startEquity, peakIdx: -1, troughIdx: -1 };
  let peakIdx = -1;
  for (let i = 0; i < equity.length; i += 1) {
    if (equity[i] > peak) {
      peak = equity[i];
      peakDate = dates[i];
      peakIdx = i;
    }
    const dd = peak > 0 ? (peak - equity[i]) / peak : 0;
    if (dd > worst.pct) worst = { pct: dd, amount: peak - equity[i], peakDate, troughDate: dates[i], peak, peakIdx, troughIdx: i };
  }
  let recoveryDate = null;
  if (worst.troughIdx >= 0) {
    for (let i = worst.troughIdx + 1; i < equity.length; i += 1) {
      if (equity[i] >= worst.peak) {
        recoveryDate = dates[i];
        break;
      }
    }
  }
  return { maxDrawdownPct: round(worst.pct * 100), maxDrawdown: round(worst.amount), peakDate: worst.peakDate, troughDate: worst.troughDate, recoveryDate };
}

/**
 * Replay signals over candle columns. Pure.
 * @param {{ cols: object, entrySig: number[], exitSig: number[]|null, p: object }} a
 */
export function simulate({ cols, entrySig, exitSig, p }) {
  const n = cols.close.length;
  const dir = p.side === "long" ? 1 : -1;
  const fee = (notional) => (notional * p.feesPct) / 100;
  // buying costs more, selling yields less
  const px = (price, buying) => price * (1 + ((buying ? 1 : -1) * p.slippagePct) / 100);
  const trades = [];
  const equity = new Array(n);
  const inMarket = new Array(n).fill(false);
  let realized = 0;
  let pos = null;
  let pendingEntry = false;
  let pendingExit = null;
  let skippedEntries = 0;

  const close = (i, raw, reason) => {
    const fill = px(raw, dir === -1); // exiting a long sells, exiting a short buys
    const gross = dir * (fill - pos.fill) * pos.qty;
    const fees = pos.entryFee + fee(fill * pos.qty);
    const net = gross - fees;
    const entryValue = pos.fill * pos.qty;
    trades.push({
      id: trades.length + 1,
      side: p.side,
      entryBar: pos.idx,
      entryTime: cols.time[pos.idx],
      entryPrice: round(pos.fill, 4),
      exitBar: i,
      exitTime: cols.time[i],
      exitPrice: round(fill, 4),
      quantity: pos.qty,
      grossPnl: round(gross),
      fees: round(fees),
      netPnl: round(net),
      returnPct: round((net / entryValue) * 100, 3),
      barsHeld: i - pos.idx + (reason === "signal" || reason === "time" ? 0 : 1),
      exitReason: reason,
      net,
    });
    if (trades.length > MAX_TRADES) throw invalid("entry", `This backtest made more than ${MAX_TRADES} trades. Use a shorter window, a longer interval or a stricter condition.`);
    realized += net;
    pos = null;
  };

  for (let i = 0; i < n; i += 1) {
    const { open, high, low } = { open: cols.open[i], high: cols.high[i], low: cols.low[i] };
    if (pendingExit && pos) {
      close(i, open, pendingExit);
    }
    pendingExit = null;
    if (pendingEntry && !pos) {
      const fill = px(open, dir === 1);
      const equityNow = p.initialCapital + realized;
      let qty;
      if (p.quantity !== undefined) qty = p.quantity * fill * (1 + p.feesPct / 100) <= equityNow ? p.quantity : 0;
      else qty = Math.floor(((equityNow * (p.capitalPct ?? 100)) / 100) / (fill * (1 + p.feesPct / 100)));
      if (qty >= 1) {
        const stop = p.stopLossPct === undefined ? null : fill * (1 - (dir * p.stopLossPct) / 100);
        const target = p.targetPct === undefined ? null : fill * (1 + (dir * p.targetPct) / 100);
        pos = { idx: i, fill, qty, entryFee: fee(fill * qty), stop, target };
      } else skippedEntries += 1;
    }
    pendingEntry = false;
    if (pos) {
      inMarket[i] = true;
      const { stop, target } = pos;
      if (dir === 1) {
        if (stop !== null && low <= stop) close(i, Math.min(open, stop), "stop");
        else if (target !== null && high >= target) close(i, Math.max(open, target), "target");
      } else if (stop !== null && high >= stop) close(i, Math.max(open, stop), "stop");
      else if (target !== null && low <= target) close(i, Math.min(open, target), "target");
    }
    const last = i === n - 1;
    if (pos) {
      const reason = exitSig && exitSig[i] === 1 ? "signal" : p.maxBarsInTrade !== undefined && i - pos.idx + 1 >= p.maxBarsInTrade ? "time" : null;
      if (last) close(i, cols.close[i], "end");
      else if (reason) pendingExit = reason;
    } else if (!last && entrySig[i] === 1) pendingEntry = true;
    equity[i] = p.initialCapital + realized + (pos ? dir * (cols.close[i] - pos.fill) * pos.qty - pos.entryFee : 0);
  }
  return { trades, equity, inMarket, skippedEntries };
}

function buyAndHold(cols, dates, p) {
  const n = cols.close.length;
  const fill = cols.open[0] * (1 + p.slippagePct / 100);
  const qty = Math.floor(p.initialCapital / (fill * (1 + p.feesPct / 100)));
  const entryFee = (fill * qty * p.feesPct) / 100;
  const eq = cols.close.map((c) => p.initialCapital + qty * (c - fill) - entryFee);
  const exitFill = cols.close[n - 1] * (1 - p.slippagePct / 100);
  eq[n - 1] = p.initialCapital + qty * (exitFill - fill) - entryFee - (exitFill * qty * p.feesPct) / 100;
  return { eq, qty, ...summaryOf(eq, dates, cols.time, p.initialCapital) };
}

function cagrOf(finalEquity, startEquity, firstTime, lastTime) {
  const years = (lastTime - firstTime) / YEAR_S;
  if (years < 1 / 12 || !(startEquity > 0)) return null;
  if (finalEquity <= 0) return -100;
  return round((Math.pow(finalEquity / startEquity, 1 / years) - 1) * 100);
}

function summaryOf(eq, dates, times, startEquity) {
  const finalEquity = eq[eq.length - 1];
  return {
    finalEquity: round(finalEquity),
    totalReturnPct: round(((finalEquity - startEquity) / startEquity) * 100),
    cagrPct: cagrOf(finalEquity, startEquity, times[0], times[times.length - 1]),
    maxDrawdownPct: drawdownOf(eq, dates, startEquity, dates[0]).maxDrawdownPct,
  };
}

function sharpeOf(equity, times, interval, startEquity) {
  // last equity of each IST day (weekly and monthly bars are one point per bar already)
  const byDay = new Map();
  for (let i = 0; i < equity.length; i += 1) byDay.set(istDate(times[i] * 1000), equity[i]);
  const series = [startEquity, ...byDay.values()];
  const rets = [];
  for (let i = 1; i < series.length; i += 1) if (series[i - 1] > 0) rets.push(series[i] / series[i - 1] - 1);
  if (rets.length < 10) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
  if (!(sd > 0)) return null;
  const perYear = interval === "1w" ? 52 : interval === "1M" ? 12 : 252;
  return round((mean / sd) * Math.sqrt(perYear), 3);
}

function statsOf({ trades, equity, inMarket }, dates, cols, p) {
  const n = trades.length;
  const wins = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => t.net < 0);
  const sum = (xs) => xs.reduce((a, t) => a + t.net, 0);
  const grossWin = sum(wins);
  const grossLoss = -sum(losses);
  const net = sum(trades);
  const final = equity[equity.length - 1];
  const best = n ? trades.reduce((a, t) => (t.net > a.net ? t : a)) : null;
  const worst = n ? trades.reduce((a, t) => (t.net < a.net ? t : a)) : null;
  const brief = (t) => (t ? { id: t.id, netPnl: t.netPnl, returnPct: t.returnPct } : null);
  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    totalReturnPct: round(((final - p.initialCapital) / p.initialCapital) * 100),
    finalEquity: round(final),
    netPnl: round(net),
    cagrPct: cagrOf(final, p.initialCapital, cols.time[0], cols.time[cols.time.length - 1]),
    winRatePct: n ? round((wins.length / n) * 100) : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 3) : null,
    expectancy: n ? round(net / n) : null,
    expectancyPct: n ? round(trades.reduce((a, t) => a + t.returnPct, 0) / n, 3) : null,
    avgWin: wins.length ? round(grossWin / wins.length) : null,
    avgLoss: losses.length ? round(-grossLoss / losses.length) : null,
    ...drawdownOf(equity, dates, p.initialCapital, dates[0]),
    sharpe: sharpeOf(equity, cols.time, p.interval, p.initialCapital),
    exposurePct: round((inMarket.filter(Boolean).length / inMarket.length) * 100),
    bestTrade: brief(best),
    worstTrade: brief(worst),
    totalFees: round(trades.reduce((a, t) => a + t.fees, 0)),
  };
}

/** Parse, fetch and run. @param {object} deps @param {object} ctx */
async function run(deps, ctx) {
  const p = parseBody(ctx.body);
  try {
    parseSymbol(p.symbol);
  } catch (e) {
    throw invalid("symbol", e?.detail ?? "symbol is not a valid Bridge symbol, for example NSE:RELIANCE.");
  }
  // Same parser and limits as the scanner (length, node count, period and offset caps).
  const entryTree = parseExpression(p.entry);
  const exitTree = p.exit === undefined ? null : parseExpression(p.exit);
  const warmup = Math.max(lookbackOf(entryTree), exitTree ? lookbackOf(exitTree) : 0);

  const params = { symbol: p.symbol, interval: p.interval };
  if (p.from) params.from = p.from;
  if (p.to) params.to = p.to;
  if (p.from === undefined) params.countback = p.countback ?? DEFAULT_COUNTBACK;
  const opts = readOptionsBase(ctx, { maxAge: false, autoBackup: autoBackupFor(deps) });
  const h = await deps.marketData.history(params, opts);

  const candles = h.candles ?? [];
  if (candles.length > MAX_BARS) throw invalid("from", `The window has ${candles.length} bars; a backtest takes at most ${MAX_BARS}. Use a shorter range or a longer interval.`);
  if (candles.length < MIN_BARS) throw new BridgeError("NOT_FOUND", `Only ${candles.length} candle(s) came back for ${p.symbol} ${p.interval}; a backtest needs at least ${MIN_BARS}.`);
  for (const c of candles) {
    if (![c.time, c.open, c.high, c.low, c.close].every(Number.isFinite) || c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0) throw new BridgeError("UPSTREAM_ERROR", "The candles contain missing or non-positive prices; the backtest was not run.");
  }

  const cols = columns(candles);
  const entrySig = evaluate(entryTree, cols);
  const exitSig = exitTree ? evaluate(exitTree, cols) : null;
  const sim = simulate({ cols, entrySig, exitSig, p });
  const fmt = isIntraday(p.interval) ? istDateTime : istDate;
  const dates = cols.time.map((t) => fmt(t * 1000));
  const stats = statsOf(sim, dates, cols, p);
  const bh = buyAndHold(cols, dates, p);

  const warnings = [];
  if (candles.length <= warmup) warnings.push(`The condition needs about ${warmup} bars to warm up but only ${candles.length} were fetched, so it cannot signal. Ask for more bars.`);
  else if (warmup > candles.length / 2) warnings.push(`About ${warmup} of ${candles.length} bars go to indicator warm-up; the tested part is short.`);
  if (candles.length < 100) warnings.push("Under 100 bars: statistics are not reliable.");
  if (stats.trades > 0 && stats.trades < 30) warnings.push(`Only ${stats.trades} trade(s): too few for the statistics to mean much.`);
  if (sim.skippedEntries) warnings.push(`${sim.skippedEntries} entry signal(s) skipped because the quantity could not be afforded.`);
  if (h.partial) warnings.push("The broker returned partial history for this window.");
  if (p.stopLossPct === undefined && p.exit === undefined && p.targetPct === undefined && p.maxBarsInTrade === undefined) warnings.push("No exit rule was given, so any position is held to the end of the data.");

  return {
    data: {
      symbol: h.symbol ?? p.symbol,
      interval: p.interval,
      period: { from: dates[0], to: dates[dates.length - 1], bars: candles.length },
      request: { ...p },
      method: { ...METHOD, limits: { maxBars: MAX_BARS, maxTrades: MAX_TRADES }, warmupBars: warmup },
      stats,
      buyAndHold: { quantity: bh.qty, finalEquity: bh.finalEquity, totalReturnPct: bh.totalReturnPct, cagrPct: bh.cagrPct, maxDrawdownPct: bh.maxDrawdownPct, strategyMinusBuyAndHoldPct: round(stats.totalReturnPct - bh.totalReturnPct) },
      skippedEntries: sim.skippedEntries,
      trades: sim.trades.map(({ net, ...t }) => ({ ...t, entryDate: dates[t.entryBar], exitDate: dates[t.exitBar] })),
      equityCurve: sim.equity.map((e, i) => ({ time: cols.time[i], date: dates[i], equity: round(e), inTrade: sim.inMarket[i] })),
      warnings,
    },
    meta: { requestId: ctx.requestId, accountId: opts.accountId ?? null, ...(h.freshness ? { freshness: h.freshness } : {}) },
  };
}

const sym = "NSE:RELIANCE";
export const EXAMPLES = Object.freeze([
  {
    id: "ema-cross",
    title: "EMA 20/50 trend cross",
    description: "Buy when the 20-bar EMA crosses above the 50-bar EMA, sell when it crosses back below, 5 percent stop.",
    body: { symbol: sym, interval: "1d", countback: 1000, entry: "ema(20) crosses above ema(50)", exit: "ema(20) crosses below ema(50)", stopLossPct: 5, side: "long", initialCapital: 100000 },
  },
  {
    id: "rsi-mean-reversion",
    title: "RSI(14) below 30 mean reversion",
    description: "Buy oversold closes, exit when RSI recovers above 55, with a 4 percent stop and a 10-bar time limit.",
    body: { symbol: sym, interval: "1d", countback: 1500, entry: "rsi(14) < 30", exit: "rsi(14) > 55", stopLossPct: 4, maxBarsInTrade: 10, side: "long", capitalPct: 50 },
  },
  {
    id: "breakout-20d-high",
    title: "Breakout of the 20-day high",
    description: "Buy a close above the previous 20-day high, exit below the 10-day low, 6 percent stop.",
    body: { symbol: sym, interval: "1d", countback: 1250, entry: "close > highest(20)[1]", exit: "close < lowest(10)[1]", stopLossPct: 6, side: "long" },
  },
  {
    id: "supertrend-short",
    title: "Supertrend short with target",
    description: "Short when the close falls below Supertrend(10, 3), cover on the way back above, 8 percent target, 4 percent stop.",
    body: { symbol: "NSE:NIFTY", interval: "1d", countback: 1000, entry: "close crosses below supertrend(10, 3)", exit: "close crosses above supertrend(10, 3)", stopLossPct: 4, targetPct: 8, side: "short", quantity: 50, feesPct: 0.03, slippagePct: 0.02 },
  },
  {
    id: "bollinger-bounce",
    title: "Bollinger lower-band bounce, 1-hour",
    description: "Buy a close under the lower 20/2 Bollinger band on 60-minute bars; exit at the 20-bar average or after 12 bars.",
    body: { symbol: sym, interval: "60m", countback: 1500, entry: "close < bb_lower(20, 2)", exit: "close > sma(20)", maxBarsInTrade: 12, stopLossPct: 3, side: "long" },
  },
]);

/** @param {object} deps @returns {Array<[string, string, object, Function]>} */
export function backtestRoutes(deps) {
  return [
    ["POST", "/v1/analytics/backtest", { scope: "read" }, (ctx) => run(deps, ctx)],
    [
      "GET",
      "/v1/analytics/backtest/examples",
      { scope: "read" },
      async (ctx) => ({ data: { path: "/v1/analytics/backtest", method: "POST", examples: EXAMPLES.map((e) => ({ ...e, body: { ...e.body } })), reference: "GET /v1/scanner/indicators lists the fields and functions usable in entry and exit." }, meta: { requestId: ctx.requestId } }),
    ],
  ];
}
