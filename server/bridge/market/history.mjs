/**
 * History helpers. Pure functions for /v1/history:
 *
 *  - planInterval: map a Bridge interval (1m … 1M) onto what the broker offers (capabilities.historical.intervals).
 *    A broker interval that divides the target evenly is fetched and aggregated (10m from 5m, 1w and 1M from 1d).
 *  - planChunks: split [from, to] into broker-sized ranges (whole IST days, at most `spanDays` each), newest first.
 *  - aggregate: build bigger bars from smaller ones. Intraday buckets are aligned to the exchange's session open
 *    (09:15 IST for NSE/BSE/NFO/BFO, 09:00 for MCX and CDS); weekly buckets start on Monday and monthly on the 1st (IST).
 *  - countbackRange: a from-time that should cover `countback` bars before `to`, allowing for weekends and holidays.
 *  - historyCsvRows: CSV rows with IST times.
 */
import { BridgeError } from "../core/errors.mjs";
import { DAY_MS, istDate, istDateTime, istDateTimeMinutes, istMidnight, istMonthStart, istWeekStart } from "./time.mjs";
import { sharedCalendar } from "../reference/sharedCalendar.mjs";

/** Bridge intervals (OpenAPI Interval). */
export const INTERVALS = Object.freeze(["1m", "3m", "5m", "10m", "15m", "30m", "60m", "1d", "1w", "1M"]);

/** Intervals a broker adapter may offer (contract HistoricalRequest). */
export const BROKER_INTERVALS = Object.freeze(["1m", "3m", "5m", "15m", "30m", "60m", "1d"]);

/** Minutes per intraday interval. */
export const INTRADAY_MINUTES = Object.freeze({ "1m": 1, "3m": 3, "5m": 5, "10m": 10, "15m": 15, "30m": 30, "60m": 60 });

/** Session open (minutes after IST midnight) used to align intraday buckets. */
export const SESSION_OPEN_MIN = Object.freeze({ NSE: 555, BSE: 555, NFO: 555, BFO: 555, MCX: 540, CDS: 540 });

/** Trading minutes in a regular session for the exchanges the dated session rules do not cover (MCX is handled below), for countback estimates. */
const SESSION_MINUTES = Object.freeze({ MCX: 870, CDS: 480 });

const toMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * True while US daylight saving time is in force on this date (second Sunday of March to the first Sunday of
 * November, US rule since 2007). MCX follows US hours: it closes at 23:30 IST during US DST and at 23:55 IST
 * otherwise (non-agri contracts; needs verification against MCX circulars).
 * @param {number} ms epoch ms
 */
export function usDstInEffect(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const nthSunday = (month, n) => {
    const first = new Date(Date.UTC(y, month, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + (n - 1) * 7;
  };
  const start = Date.UTC(y, 2, nthSunday(2, 2), 7); // 02:00 US Eastern = 07:00 UTC
  const end = Date.UTC(y, 10, nthSunday(10, 1), 6); // 02:00 US Eastern (EDT) = 06:00 UTC
  return ms >= start && ms < end;
}

/**
 * Regular session length in minutes on a date. NSE, BSE, NFO and BFO read the dated session rules of the reference data
 * (derivatives are 385 minutes from 2026-08-03 and 390 from 2026-12-07; a special session has its own length). MCX runs 09:00-23:30
 * IST during US daylight saving time and 09:00-23:55 otherwise (roughly November to March; needs verification against MCX circulars).
 */
export function sessionMinutes(exchange, ms) {
  if (exchange === "MCX") return usDstInEffect(ms) ? 870 : 895;
  if (Object.hasOwn(SESSION_MINUTES, exchange)) return SESSION_MINUTES[exchange];
  const cal = sharedCalendar();
  const date = istDate(ms);
  const sp = cal.specialOn(date, exchange);
  const open = sp?.open && sp?.close ? sp.open : cal.windowFor(exchange, date).open;
  return toMinutes(cal.closeFor(exchange, date)) - toMinutes(open);
}

/**
 * Days one broker call may cover for a base interval.
 *  - override: the user's explicit per-broker span (config market.history.brokers) wins outright.
 *  - otherwise the configured default span, capped by what the broker's manifest documents (`historical.maxSpanDays[interval]`),
 *    and, where the manifest documents a record cap (`historical.maxRecords[interval]`), by the days that fit in it.
 * @param {{ base: string, override?: number|null, defaults: { intraday: number, daily: number }, manifest?: { maxSpanDays?: object, maxRecords?: object }|null, exchange?: string, ms?: number }} p
 */
export function historySpanDays({ base, override = null, defaults, manifest = null, exchange = "NFO", ms = Date.now() }) {
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  const daily = base === "1d";
  let span = daily ? defaults.daily : defaults.intraday;
  const cap = manifest?.maxSpanDays?.[base];
  if (Number.isFinite(cap) && cap > 0) span = Math.min(span, cap);
  const records = manifest?.maxRecords?.[base];
  if (!daily && Number.isFinite(records) && records > 0 && INTRADAY_MINUTES[base]) {
    const perDay = Math.max(1, Math.floor(sessionMinutes(exchange, ms) / INTRADAY_MINUTES[base]));
    // 5 trading days per 7 calendar days, so the whole window never holds more bars than the cap.
    span = Math.min(span, Math.max(1, Math.floor((Math.floor(records / perDay) * 7) / 5)));
  }
  return Math.max(1, Math.floor(span));
}

/**
 * The start of the bar that contains `ms`, for the bars a broker stamps at IST midnight: 1d at 00:00, 1w on Monday, 1M on the 1st.
 * Intraday intervals are returned unchanged. A request whose `from` falls inside a daily bar (12:00 on that day) must still get
 * that day's bar, so `from` is floored to this before bars are filtered.
 */
export function barStartOf(interval, ms) {
  if (interval === "1d") return istMidnight(ms);
  if (interval === "1w") return istWeekStart(ms);
  if (interval === "1M") return istMonthStart(ms);
  return ms;
}

export const isIntraday = (interval) => Object.hasOwn(INTRADAY_MINUTES, interval);

/**
 * @param {string} interval Bridge interval
 * @param {string[] | undefined} offered broker intervals (capabilities.historical.intervals); undefined = all contract intervals
 * @returns {{ base: string, factor: number, aggregate: "none"|"intraday"|"week"|"month" }}
 *   factor = how many base bars make one target bar (intraday only).
 * @throws BridgeError CAPABILITY_UNSUPPORTED when nothing offered can build the interval
 */
export function planInterval(interval, offered) {
  const have = new Set((Array.isArray(offered) && offered.length ? offered : BROKER_INTERVALS).filter((i) => BROKER_INTERVALS.includes(i)));
  if (!INTERVALS.includes(interval)) throw new BridgeError("VALIDATION_FAILED", `interval must be one of ${INTERVALS.join(", ")}.`);
  if (interval === "1w" || interval === "1M") {
    if (!have.has("1d")) throw new BridgeError("CAPABILITY_UNSUPPORTED", `This broker offers no daily candles, so ${interval} candles cannot be built.`);
    return { base: "1d", factor: 1, aggregate: interval === "1w" ? "week" : "month" };
  }
  if (interval === "1d") {
    if (!have.has("1d")) throw new BridgeError("CAPABILITY_UNSUPPORTED", "This broker offers no daily candles.");
    return { base: "1d", factor: 1, aggregate: "none" };
  }
  if (have.has(interval)) return { base: interval, factor: 1, aggregate: "none" };
  const target = INTRADAY_MINUTES[interval];
  const bases = [...have].filter((i) => isIntraday(i) && target % INTRADAY_MINUTES[i] === 0).sort((a, b) => INTRADAY_MINUTES[b] - INTRADAY_MINUTES[a]);
  if (!bases.length) throw new BridgeError("CAPABILITY_UNSUPPORTED", `This broker cannot supply ${interval} candles (it offers ${[...have].join(", ") || "none"}).`);
  return { base: bases[0], factor: target / INTRADAY_MINUTES[bases[0]], aggregate: "intraday" };
}

/**
 * Split [fromMs, toMs] into chunks of at most `spanDays` IST calendar days each, newest first.
 * Chunk bounds are formatted the way adapters take them: "YYYY-MM-DD" for daily candles, "YYYY-MM-DD HH:mm" (IST) for
 * intraday.
 * @param {{ fromMs: number, toMs: number, spanDays: number, daily: boolean }} p
 * @returns {Array<{ fromMs: number, toMs: number, from: string, to: string }>}
 */
export function planChunks({ fromMs, toMs, spanDays, daily }) {
  if (!(toMs >= fromMs)) return [];
  const span = Math.max(1, Math.floor(spanDays));
  const chunks = [];
  let end = toMs;
  for (;;) {
    // The chunk covers whole IST days [startDay, endDay], span days in all, clipped to fromMs.
    const endDay = istMidnight(end);
    const startDay = endDay - (span - 1) * DAY_MS;
    const start = Math.max(fromMs, startDay);
    chunks.push({
      fromMs: start,
      toMs: end,
      from: daily ? istDate(start) : istDateTimeMinutes(start),
      to: daily ? istDate(end) : istDateTimeMinutes(end),
    });
    if (start <= fromMs) break;
    end = startDay - 60_000; // 23:59 IST on the previous day
  }
  return chunks;
}

function bucketStart(timeMs, plan, interval, exchange) {
  if (plan.aggregate === "week") return istWeekStart(timeMs);
  if (plan.aggregate === "month") return istMonthStart(timeMs);
  const size = INTRADAY_MINUTES[interval] * 60_000;
  const open = istMidnight(timeMs) + (SESSION_OPEN_MIN[exchange] ?? SESSION_OPEN_MIN.NSE) * 60_000;
  return open + Math.floor((timeMs - open) / size) * size;
}

/**
 * Aggregate ascending base candles into target bars. Intraday bars are stamped with their aligned bucket start;
 * weekly and monthly bars keep the time of their first daily bar (the broker's own daily stamp).
 * @param {Array<object>} candles ascending, de-duplicated
 * @param {{ aggregate: string }} plan from planInterval
 * @param {string} interval Bridge interval
 * @param {string} [exchange]
 */
export function aggregate(candles, plan, interval, exchange = "NSE") {
  if (plan.aggregate === "none") return candles;
  const out = [];
  let cur = null;
  let curKey = null;
  for (const c of candles) {
    const key = bucketStart(c.time * 1000, plan, interval, exchange);
    if (cur && key === curKey) {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
      if (c.oi !== undefined) cur.oi = c.oi;
      continue;
    }
    if (cur) out.push(cur);
    curKey = key;
    cur = { time: plan.aggregate === "intraday" ? Math.floor(key / 1000) : c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    if (c.oi !== undefined) cur.oi = c.oi;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * A from-time that should cover `countback` bars ending at `toMs`, with room for weekends and a few holidays.
 * @returns {number} epoch ms
 */
export function countbackRange({ toMs, countback, interval, exchange = "NSE" }) {
  let days;
  if (isIntraday(interval)) {
    const perDay = Math.max(1, Math.floor(sessionMinutes(exchange, toMs) / INTRADAY_MINUTES[interval]));
    days = Math.ceil(countback / perDay);
  } else if (interval === "1d") days = countback;
  else if (interval === "1w") days = countback * 5;
  else days = countback * 22;
  // trading days -> calendar days, plus a holiday margin
  const calendar = Math.ceil(days * 1.45) + 4;
  return istMidnight(toMs) - calendar * DAY_MS;
}

/** CSV rows (header first) for a HistoryResult: time in IST ("YYYY-MM-DD HH:mm:ss", or the date for 1d and longer). */
export function historyCsvRows(result) {
  const daily = !isIntraday(result.interval);
  const rows = [["time", "open", "high", "low", "close", "volume", "oi"]];
  for (const c of result.candles) {
    rows.push([daily ? istDate(c.time * 1000) : istDateTime(c.time * 1000), c.open, c.high, c.low, c.close, c.volume, c.oi ?? ""]);
  }
  return rows;
}
