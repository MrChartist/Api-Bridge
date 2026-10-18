/**
 * IST time helpers for market data (stream S5). India has no daylight saving, so IST is a fixed UTC+05:30 offset and
 * all arithmetic here is plain epoch maths. Pure functions, no I/O.
 */
import { BridgeError } from "../core/errors.mjs";

export const IST_OFFSET_MS = 330 * 60_000;
export const DAY_MS = 86_400_000;

const pad = (n, w = 2) => String(n).padStart(w, "0");

/** Calendar parts of an epoch-ms instant as seen in IST. */
export function istParts(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    millis: d.getUTCMilliseconds(),
    weekday: d.getUTCDay(), // 0 = Sunday
  };
}

/** "2026-10-19T09:30:00.000+05:30" — the Freshness.asOf format. */
export function toIstIso(ms) {
  const p = istParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}.${pad(p.millis, 3)}+05:30`;
}

/** "2026-10-19" (IST calendar day). */
export function istDate(ms) {
  const p = istParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "2026-10-19 09:30" (IST), the form broker adapters take for intraday history. */
export function istDateTimeMinutes(ms) {
  const p = istParts(ms);
  return `${istDate(ms)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** "2026-10-19 09:30:00" (IST), used in CSV output. */
export function istDateTime(ms) {
  const p = istParts(ms);
  return `${istDate(ms)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** Epoch ms of 00:00 IST on the IST day that contains `ms`. */
export function istMidnight(ms) {
  return Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

/** Epoch ms of 00:00 IST on the Monday of the IST week that contains `ms`. */
export function istWeekStart(ms) {
  const mid = istMidnight(ms);
  const weekday = istParts(mid).weekday;
  return mid - ((weekday + 6) % 7) * DAY_MS;
}

/** Epoch ms of 00:00 IST on the first day of the IST month that contains `ms`. */
export function istMonthStart(ms) {
  const p = istParts(ms);
  return Date.UTC(p.year, p.month - 1, 1) - IST_OFFSET_MS;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const EPOCH_S = /^\d{9,11}$/;

function realDate(y, m, d) {
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
}

/**
 * Parse a time given by a client: epoch seconds, an ISO date ("2026-10-19", IST) or an ISO date-time (IST when it
 * has no offset). A date-only value means the start of that IST day, or its end when `endOfDay` is true.
 * @param {string | number} input
 * @param {{ endOfDay?: boolean, field?: string }} [opts]
 * @returns {number} epoch ms
 */
export function parseTimeInput(input, { endOfDay = false, field = "time" } = {}) {
  const bad = () =>
    new BridgeError("VALIDATION_FAILED", `${field} must be a date (2026-10-19), a date and time (2026-10-19T09:15, IST unless an offset is given) or epoch seconds.`, {
      errors: [{ path: field, message: "not a valid time" }],
    });
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) throw bad();
    return Math.round(input * 1000);
  }
  const s = String(input ?? "").trim();
  if (EPOCH_S.test(s)) return Number(s) * 1000;
  let m = DATE_ONLY.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!realDate(y, mo, d)) throw bad();
    const start = Date.UTC(y, mo - 1, d) - IST_OFFSET_MS;
    return endOfDay ? start + DAY_MS - 1000 : start;
  }
  m = DATE_TIME.exec(s);
  if (m) {
    const [y, mo, d, hh, mm] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
    const ss = m[6] ? Number(m[6]) : 0;
    const ms = m[7] ? Number(m[7].padEnd(3, "0")) : 0;
    if (!realDate(y, mo, d) || hh > 23 || mm > 59 || ss > 59) throw bad();
    let offsetMs = IST_OFFSET_MS;
    if (m[8] === "Z") offsetMs = 0;
    else if (m[8]) {
      const sign = m[8][0] === "-" ? -1 : 1;
      const digits = m[8].slice(1).replace(":", "");
      const oh = Number(digits.slice(0, 2));
      const om = Number(digits.slice(2, 4));
      if (oh > 14 || om > 59) throw bad();
      offsetMs = sign * (oh * 60 + om) * 60_000;
    }
    return Date.UTC(y, mo - 1, d, hh, mm, ss, ms) - offsetMs;
  }
  throw bad();
}
