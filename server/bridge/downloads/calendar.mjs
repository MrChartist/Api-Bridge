/**
 * The exchange calendar the downloads use to know which days should have bars, from the holiday list shipped in the
 * repo (reference/data/holidays.json). A date outside the years that list covers is treated as an ordinary weekday, so a
 * gap report for such a day can be a holiday; the Bridge says so rather than hiding it (see `calendarCovers`).
 */
import { SHIPPED_HOLIDAYS } from "../reference/shipped.mjs";
export { sharedCalendar } from "../reference/sharedCalendar.mjs";

/** True when the shipped holiday list covers this IST date's year. */
export function calendarCovers(date) {
  return Object.hasOwn(SHIPPED_HOLIDAYS.years ?? {}, String(date).slice(0, 4));
}

/** Exchanges whose holidays the shipped list holds; others fall back to the weekday rule. */
export const CALENDAR_EXCHANGES = Object.freeze(["NSE", "BSE", "NFO", "BFO"]);
