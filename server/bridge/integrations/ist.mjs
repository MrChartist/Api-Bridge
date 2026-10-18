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

/**
 * TradingView wants daily, weekly and monthly bars stamped at 00:00 UTC of the trading date. A Bridge candle's time is
 * the bar open as a real instant (for a daily bar usually 00:00 or 09:15 IST); this returns 00:00 UTC of its IST date.
 */
export function utcMidnightOfIstDate(epochSeconds) {
  const p = istParts(epochSeconds);
  return Date.UTC(p.y, p.mo - 1, p.d) / 1000;
}

/** Epoch seconds of `HH:MM` IST on an ISO date ("2026-10-27"), or null when the date is not valid. */
export function istInstant(isoDate, hh = 0, mm = 0) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate ?? ""));
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mm);
  if (!Number.isFinite(ms)) return null;
  return ms / 1000 - IST_OFFSET_SECONDS;
}
