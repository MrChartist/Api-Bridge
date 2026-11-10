/**
 * Size estimate for downloading a set of symbols: symbols x intervals x days.
 *
 * Rows: bars per trading day (a regular 375-minute session: 1m 375, 5m 75, 15m 25, 60m 7, daily 1, weekly 1/5, monthly
 * 1/21) times the trading days in the last `days` calendar days (the Bridge's holiday calendar, reference/calendar.mjs).
 * Bytes: about 70 per CSV row. Broker calls: per symbol and interval, one call per history chunk (market config
 * history.maxSpanDays: 60 days intraday, 2000 daily by default), counted for every interval separately, so a request for
 * both 5m and 15m is counted as two fetches (an upper bound).
 *
 * An ESTIMATE: an option contract that listed recently has fewer days than asked, a half-day session has fewer bars, and a
 * broker may keep less intraday history than `days`. The answer says so in `notes`.
 */
import { BridgeError } from "../core/errors.mjs";
import { addDays, istDateOf } from "../reference/calendar.mjs";
import { HISTORY_SPAN_DEFAULTS } from "../market/config.mjs";
import { INTERVALS, INTRADAY_MINUTES } from "../market/history.mjs";

export const SESSION_MINUTES = 375;
export const BYTES_PER_ROW = 70;
export const MAX_DAYS = 3650;

/** Bars one trading day contributes to an interval. */
export function barsPerTradingDay(interval) {
  if (interval === "1d") return 1;
  if (interval === "1w") return 1 / 5;
  if (interval === "1M") return 1 / 21;
  const minutes = INTRADAY_MINUTES[interval];
  return minutes ? Math.ceil(SESSION_MINUTES / minutes) : 0;
}

/** Trading days in the `days` calendar days that end on `today` (inclusive). */
export function tradingDaysIn(days, today, cal, exchange = "NFO") {
  let n = 0;
  for (let i = 0; i < days; i += 1) if (cal.isTradingDay(addDays(today, -i), exchange)) n += 1;
  return n;
}

/** Intervals from a list or a comma separated string, checked. */
export function parseIntervals(input) {
  const list = (Array.isArray(input) ? input : String(input ?? "").split(",")).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) throw new BridgeError("VALIDATION_FAILED", `Give at least one interval: ${INTERVALS.join(", ")}.`, { errors: [{ path: "intervals", message: "required" }] });
  const bad = list.find((i) => !INTERVALS.includes(i));
  if (bad) throw new BridgeError("VALIDATION_FAILED", `"${bad.slice(0, 12)}" is not an interval. Use: ${INTERVALS.join(", ")}.`, { errors: [{ path: "intervals", message: "unknown interval" }] });
  return [...new Set(list)];
}

/** `days` as a whole number from 1 to 3650. */
export function parseDays(input) {
  const n = typeof input === "number" ? input : /^\d{1,5}$/.test(String(input ?? "").trim()) ? Number(input) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) throw new BridgeError("VALIDATION_FAILED", `days must be a whole number from 1 to ${MAX_DAYS} (calendar days back from today).`, { errors: [{ path: "days", message: "out of range" }] });
  return n;
}

/**
 * @param {{ symbols: number, intervals: string[], days: number, nowMs: number, cal: any, exchange?: string, spans?: { intraday: number, daily: number } }} p
 */
export function estimateSize({ symbols, intervals, days, nowMs, cal, exchange = "NFO", spans = HISTORY_SPAN_DEFAULTS }) {
  const today = istDateOf(nowMs);
  const tradingDays = tradingDaysIn(days, today, cal, exchange);
  const perInterval = intervals.map((interval) => {
    const daily = interval === "1d" || interval === "1w" || interval === "1M";
    const barsEach = Math.round(barsPerTradingDay(interval) * tradingDays);
    const callsEach = Math.max(1, Math.ceil(days / (daily ? spans.daily : spans.intraday)));
    return { interval, barsPerSymbol: barsEach, rows: barsEach * symbols, bytes: barsEach * symbols * BYTES_PER_ROW, brokerCalls: callsEach * symbols };
  });
  const rows = perInterval.reduce((s, x) => s + x.rows, 0);
  return {
    symbols,
    intervals,
    days,
    tradingDays,
    rows,
    bytes: rows * BYTES_PER_ROW,
    brokerCalls: perInterval.reduce((s, x) => s + x.brokerCalls, 0),
    perInterval,
    notes: [
      "An estimate: a contract listed recently has fewer days than asked, a short session has fewer bars, and a broker may keep less intraday history than the days you ask for.",
      `Size assumes CSV at about ${BYTES_PER_ROW} bytes a row. Broker calls count each interval as its own fetch.`,
    ],
  };
}
