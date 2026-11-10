/**
 * What a download will cost before it starts: broker calls, rows, bytes and time. Pure maths over the request, the
 * exchange calendar, what is already stored (so a dataset update or a repeat of a stored range costs only the missing
 * part) and the budget share. `POST /v1/downloads?dryRun=1` returns this and starts nothing.
 *
 * The numbers are estimates: rows assume every trading minute has a bar (a thin stock has fewer), and the time assumes
 * the broker's published limit is the only limit. They are honest about being estimates in `notes`.
 */
import { sessionMinutes, isIntraday, INTRADAY_MINUTES } from "../market/history.mjs";
import { DAY_MS, istDate, istMidnight } from "../market/time.mjs";
import { subtractCoverage } from "../market/localStore.mjs";
import { coveredUpTo, exchangeOf, stepSeconds } from "./bars.mjs";

/** Average bytes per row on disk, by format (measured on typical bars). */
export const BYTES_PER_ROW = Object.freeze({ csv: 62, jsonl: 150, amibroker: 72 });

/**
 * Window plan for one stretch: broker calls of `spanDays - 1` whole IST days each (the extra day of margin keeps one
 * window to one broker call even when the Bridge rounds the edges to bar boundaries).
 * @returns {Array<{ from: number, to: number }>} epoch seconds, inclusive
 */
export function planWindows(aSec, bSec, spanDays) {
  if (bSec < aSec) return [];
  const len = Math.max(1, Math.floor(spanDays) - 1) * 86_400;
  const start = Math.floor(istMidnight(aSec * 1000) / 1000);
  const out = [];
  for (let s = start; s <= bSec; s += len) out.push({ from: s, to: Math.min(bSec, s + len - 1) });
  return out;
}

/**
 * @param {{ symbols: string[], intervals: string[], fromSec: number, toSec: number, format: string, nowMs: number,
 *   spanDays: (symbol: string, interval: string) => number,
 *   coverageOf?: (symbol: string, interval: string) => { from: number, to: number } | null,
 *   isTradingDay: (date: string, exchange: string) => boolean }} p
 */
export function estimateDownload({ symbols, intervals, fromSec, toSec, format, nowMs, spanDays, coverageOf, isTradingDay }) {
  const tradingDays = new Map();
  const daysIn = (ex, a, b) => {
    if (b < a) return 0;
    const key = `${ex}|${a}|${b}`;
    let n = tradingDays.get(key);
    if (n === undefined) {
      n = 0;
      for (let d = istMidnight(a * 1000); d <= b * 1000; d += DAY_MS) if (isTradingDay(istDate(d), ex)) n += 1;
      tradingDays.set(key, n);
    }
    return n;
  };
  const rowsIn = (symbol, interval, a, b) => {
    const ex = exchangeOf(symbol);
    const days = daysIn(ex, a, b);
    if (isIntraday(interval)) return days * Math.floor(sessionMinutes(ex, b * 1000) / INTRADAY_MINUTES[interval]);
    if (interval === "1d") return days;
    return Math.ceil(days / (interval === "1w" ? 5 : 21));
  };

  let calls = 0;
  let fullCalls = 0;
  let rows = 0;
  let fetchRows = 0;
  let upToDate = 0;
  const items = symbols.length * intervals.length;
  for (const symbol of symbols) {
    for (const interval of intervals) {
      const to = Math.min(toSec, coveredUpTo(nowMs, interval, exchangeOf(symbol)));
      const span = spanDays(symbol, interval);
      const full = planWindows(fromSec, to, span).length;
      const gaps = subtractCoverage(fromSec, to, coverageOf?.(symbol, interval) ?? null);
      let c = 0;
      let r = 0;
      for (const g of gaps) {
        c += planWindows(g.from, g.to, span).length;
        r += rowsIn(symbol, interval, g.from, g.to);
      }
      if (!gaps.length) upToDate += 1;
      fullCalls += full;
      calls += c;
      fetchRows += r;
      rows += rowsIn(symbol, interval, fromSec, to);
    }
  }
  const bytesPerRow = BYTES_PER_ROW[format] ?? BYTES_PER_ROW.csv;
  return {
    items,
    calls,
    callsSaved: Math.max(0, fullCalls - calls),
    rows,
    rowsToFetch: fetchRows,
    bytes: rows * bytesPerRow,
    bytesPerRow,
    upToDate,
    stepSeconds: intervals.map((i) => stepSeconds(i)),
  };
}

/**
 * Time at the allowed share. `windows` come from scheduler.headroomWindows(): the sustained rate is the slowest of
 * share x limit / window length over every window, so a daily cap shows up as days, not seconds.
 * @param {number} calls
 * @param {Array<{ window: string, limit: number }>} windows
 * @param {number} share
 * @returns {{ etaSec: number | null, callsPerSecond: number | null, binding: string | null, days: number | null }}
 */
export function timeAtShare(calls, windows, share) {
  const length = { "1s": 1, second: 1, "1m": 60, "60s": 60, "1h": 3600, day: 86_400, "1d": 86_400 };
  let rate = Infinity;
  let binding = null;
  for (const w of windows ?? []) {
    const len = length[w.window];
    if (!len || !Number.isFinite(w.limit) || w.limit <= 0) continue;
    const r = (share * w.limit) / len;
    if (r < rate) {
      rate = r;
      binding = w.window;
    }
  }
  if (!Number.isFinite(rate) || rate <= 0) return { etaSec: null, callsPerSecond: null, binding: null, days: null };
  const etaSec = Math.ceil(calls / rate);
  return { etaSec, callsPerSecond: Math.round(rate * 1000) / 1000, binding, days: binding === "day" || binding === "1d" ? Math.ceil(etaSec / 86_400) : null };
}
