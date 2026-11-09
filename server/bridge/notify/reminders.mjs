/**
 * When the morning reminder, the second nudge and the end-of-day summary are due. Pure: the clock and the calendar come
 * in. Trading days: the NSE/BSE holiday calendar shipped in server/bridge/reference (updated each year with a release);
 * a date the calendar does not know is judged by weekday alone (Saturday and Sunday are never trading days).
 *
 * A reminder is due from its time until a grace period later (a Bridge started at 14:00 does not send the 08:45 reminder
 * then), and at most once per day (the caller remembers what it sent).
 */
import { createCalendar, istDateOf, istInstant, weekdayOf } from "../reference/calendar.mjs";
import { shippedHolidayRows, shippedSpecialSessions } from "../reference/shipped.mjs";

const MIN = 60_000;

/** @returns {{ isTradingDay(date: string): boolean, source: "calendar"|"weekdays" }} */
export function createTradingCalendar() {
  try {
    const cal = createCalendar({ holidays: shippedHolidayRows(), specialSessions: shippedSpecialSessions() });
    return { isTradingDay: (date) => cal.isTradingDay(date, "NSE"), source: "calendar" };
  } catch {
    return { isTradingDay: (date) => ![0, 6].includes(weekdayOf(date)), source: "weekdays" };
  }
}

export const GRACE_MS = Object.freeze({ morning: 90 * MIN, second: 45 * MIN, eod: 180 * MIN });

/**
 * @param {{ now: number, morning: { enabled: boolean, at: string, secondAt: string, endOfDay: { enabled: boolean, at: string } },
 *   calendar: { isTradingDay(date: string): boolean }, sent: Record<string, number> }} input
 * @returns {Array<{ id: string, kind: "morning"|"second"|"eod", date: string }>}
 */
export function dueReminders({ now, morning, calendar, sent }) {
  if (!morning?.enabled && !morning?.endOfDay?.enabled) return [];
  const date = istDateOf(now);
  if (!calendar.isTradingDay(date)) return [];
  const out = [];
  const check = (kind, hhmm) => {
    const at = istInstant(date, hhmm);
    const id = `${kind}:${date}`;
    if (now >= at && now < at + GRACE_MS[kind] && !sent?.[id]) out.push({ id, kind, date });
  };
  if (morning.enabled) {
    check("morning", morning.at);
    check("second", morning.secondAt);
  }
  if (morning.endOfDay?.enabled) check("eod", morning.endOfDay.at);
  return out;
}

/** The next time a reminder is due after `now` (for status screens), or null. */
export function nextReminderAt({ now, morning, calendar }) {
  if (!morning?.enabled) return null;
  let date = istDateOf(now);
  for (let i = 0; i < 12; i += 1) {
    if (calendar.isTradingDay(date)) {
      const at = istInstant(date, morning.at);
      if (at > now) return at;
    }
    date = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }
  return null;
}
