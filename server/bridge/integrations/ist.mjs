/**
 * India Standard Time helpers for stream S10. IST is a fixed UTC+05:30 with no daylight saving, so plain offset
 * arithmetic is exact and needs no time-zone database.
 */

export const IST_OFFSET_SECONDS = 19_800;
export const DAY_SECONDS = 86_400;

const pad = (n, w = 2) => String(n).padStart(w, "0");

/** Calendar parts of an epoch-seconds instant, in IST. */
export function istParts(epochSeconds) {
  const d = new Date((epochSeconds + IST_OFFSET_SECONDS) * 1000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
}

/** "YYYY-MM-DD" (IST) for an epoch-seconds instant. */
export function istDate(epochSeconds) {
  const p = istParts(epochSeconds);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

/** "HH:MM:SS" (IST) for an epoch-seconds instant. */
export function istTime(epochSeconds) {
  const p = istParts(epochSeconds);
  return `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}

/** "YYYY-MM-DD HH:MM:SS" (IST): the form Excel, Google Sheets and Power Query read as a date-time. */
export function istDateTime(epochSeconds) {
  return `${istDate(epochSeconds)} ${istTime(epochSeconds)}`;
}
