/**
 * When a recording is due: the session of an IST day, from the Bridge's own market calendar (market/calendarView.mjs:
 * holidays, weekends and special sessions). Pure apart from the calendar passed in.
 *
 *   schedule "market-hours"                      the exchange's session of each trading day (open to close)
 *   schedule { days, start, end }                those days (IST) between start and end; trading days only for the
 *                                                exchanges the calendar covers (NSE, BSE, NFO, BFO)
 *   sessionOnly false (manual recording)         always; `always` below
 *
 * MCX and CDS have their own hours that the calendar does not hold: for them only an explicit { days, start, end } works.
 */
import { BridgeError } from "../core/errors.mjs";
import { addDays, istDateOf, istInstant, weekdayOf } from "../reference/calendar.mjs";
import { CALENDAR_EXCHANGES } from "../market/calendarView.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** The exchange whose calendar and hours apply to a list of canonical symbols (NFO for any derivative, else NSE). */
export function exchangeOfSymbols(symbols) {
  let cash = "NSE";
  let seen = null;
  for (const s of symbols) {
    let p;
    try {
      p = parseSymbol(s);
    } catch {
      continue;
    }
    if (p.exchange === "MCX" || p.exchange === "CDS") return p.exchange;
    if (p.exchange === "BFO") seen = "BFO";
    else if (p.exchange === "NFO" && seen !== "BFO") seen = "NFO";
    else if (p.exchange === "BSE" && !seen) cash = "BSE";
  }
  return seen ?? cash;
}

/** The exchange that applies to an underlying's options and cash price. */
export const exchangeOfUnderlying = (underlying) => (["SENSEX", "BANKEX", "SENSEX50"].includes(String(underlying).toUpperCase()) ? "BFO" : "NFO");

/**
 * @param {{ calendarView: { sessions(exchange: string, date: string): any } }} deps
 */
export function createSessionClock({ calendarView }) {
  const cache = new Map();
  const session = (exchange, date) => {
    const key = `${exchange}|${date}`;
    let s = cache.get(key);
    if (!s) {
      s = calendarView.sessions(exchange, date);
      cache.set(key, s);
      if (cache.size > 400) cache.delete(cache.keys().next().value);
    }
    return s;
  };

  /**
   * The window of one IST day: { date, active, start, end, startMs, endMs, label } (times IST "HH:MM"; active false when
   * nothing is due that day).
   */
  function windowOn(date, schedule, exchange) {
    const none = { date, active: false, start: null, end: null, startMs: null, endMs: null, label: null };
    if (schedule === "market-hours" || schedule === undefined) {
      if (!CALENDAR_EXCHANGES.includes(exchange)) {
        throw new BridgeError("CAPABILITY_UNSUPPORTED", `The Bridge's calendar covers NSE, BSE, NFO and BFO only. ${exchange} has its own hours: use an explicit schedule { "days": [...], "start": "09:00", "end": "23:30" } or sessionOnly false.`);
      }
      const s = session(exchange, date);
      if (!s.isTradingDay || !s.open || !s.close) return { ...none, label: s.reason };
      return { date, active: true, start: s.open, end: s.close, startMs: istInstant(date, s.open), endMs: istInstant(date, s.close), label: s.reason };
    }
    const day = DAY_NAMES[weekdayOf(date)];
    if (!schedule.days.includes(day)) return { ...none, label: "not one of the chosen days" };
    if (CALENDAR_EXCHANGES.includes(exchange) && !session(exchange, date).isTradingDay) return { ...none, label: session(exchange, date).reason };
    return { date, active: true, start: schedule.start, end: schedule.end, startMs: istInstant(date, schedule.start), endMs: istInstant(date, schedule.end), label: "chosen hours" };
  }

  /**
   * Where `ms` stands: { state: "active"|"waiting", window (today's), nextStartMs|null, nextStartDate }.
   * "waiting" covers before the open, after the close and a day with no session.
   */
  function stateAt(ms, schedule, exchange) {
    const date = istDateOf(ms);
    const window = windowOn(date, schedule, exchange);
    if (window.active && ms >= window.startMs && ms < window.endMs) return { state: "active", window, nextStartMs: null, nextStartDate: null };
    if (window.active && ms < window.startMs) return { state: "waiting", window, nextStartMs: window.startMs, nextStartDate: date };
    let d = date;
    for (let i = 0; i < 14; i += 1) {
      d = addDays(d, 1);
      const w = windowOn(d, schedule, exchange);
      if (w.active) return { state: "waiting", window, nextStartMs: w.startMs, nextStartDate: d };
    }
    return { state: "waiting", window, nextStartMs: null, nextStartDate: null };
  }

  return { windowOn, stateAt };
}
