/**
 * The one calendar of the process, built from the shipped reference data: the holiday list, the dated session rules and
 * the special sessions (reference/data/*.json). The live-order gate (lib/marketHours.mjs and the safety guard), the market
 * calendar pages, readiness, the recorder schedule and the downloads' day maths all read this one source, so a session time
 * or a special session is changed in one data file.
 */
import { createCalendar } from "./calendar.mjs";
import { shippedHolidayRows, shippedSpecialSessions } from "./shipped.mjs";

let shared;

/** One calendar for the process. */
export function sharedCalendar() {
  shared ??= createCalendar({ holidays: shippedHolidayRows(), specialSessions: shippedSpecialSessions() });
  return shared;
}
