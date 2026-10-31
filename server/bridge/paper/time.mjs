/**
 * India Standard Time helpers for the paper engine. IST is UTC+05:30 all year (no daylight saving), so plain
 * arithmetic is exact and no Intl time-zone data is needed.
 */

export const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 86_400_000;

/** IST calendar day "YYYY-MM-DD" for an epoch-ms instant. */
export function istDay(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** IST calendar day as "YYYYMMDD" (order ids). */
export function istDayCompact(ms) {
  return istDay(ms).replace(/-/g, "");
}

/**
 * Epoch ms of HH:MM IST on the IST day that contains `ms`.
 * @param {number} ms
 * @param {string} hhmm e.g. "15:20"
 */
export function istTimeOnDay(ms, hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm));
  if (!m) throw new Error(`Not an HH:MM time: ${hhmm}`);
  const midnight = Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
  return midnight + (Number(m[1]) * 60 + Number(m[2])) * 60_000;
}

/** Epoch ms -> ISO-8601 with the +05:30 offset, e.g. "2026-10-19T09:15:00.000+05:30". */
export function toIstIso(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().replace("Z", "+05:30");
}
