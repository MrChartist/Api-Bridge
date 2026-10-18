/**
 * IST time helpers for the safety guard and the audit log. India has no daylight saving, so IST is always
 * UTC+05:30; nothing here reads the host's time zone (a VPS in another region gets the same answers).
 */

export const IST_OFFSET_MS = 19_800_000;
export const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" of the IST calendar day that contains epoch `ms`. */
export function istDay(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** ISO-8601 with the +05:30 offset, e.g. 2026-10-19T09:30:00.000+05:30. */
export function istIso(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().replace("Z", "+05:30");
}

/** Epoch ms of IST midnight at the start of day "YYYY-MM-DD". */
export function istDayStart(day) {
  return Date.parse(`${day}T00:00:00+05:30`);
}

/** Epoch ms of the next IST midnight after `ms`. */
export function endOfIstDay(ms) {
  return istDayStart(istDay(ms)) + DAY_MS;
}

/** True for a well-formed "YYYY-MM-DD" that is a real calendar date. */
export function isDayString(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}
