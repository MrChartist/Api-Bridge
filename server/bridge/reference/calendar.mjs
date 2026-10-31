/**
 * Trading-day maths over the holiday calendar and the session windows (stream S16, docs/spec/p1-02-reference.md
 * §6.4–6.6, §6.9). Pure: no I/O, no clock. Dates are IST calendar dates "YYYY-MM-DD"; times are IST "HH:MM". India has
 * no daylight saving, so IST is a fixed UTC+05:30 offset and the host time zone never matters.
 *
 * Exchanges: the derivatives segments follow their cash exchange's holidays (NFO -> NSE, BFO -> BSE).
 */
import { DEFAULT_SESSIONS } from "./defaults.mjs";

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Longest run of closed days the calendar will step over (a guard against a broken holiday list). */
const MAX_STEP = 40;

const pad = (n) => String(n).padStart(2, "0");

/** True for a real calendar date in YYYY-MM-DD form. */
export function isIsoDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

const utcOf = (date) => Date.parse(`${date}T00:00:00Z`);
const fromUtc = (t) => new Date(t).toISOString().slice(0, 10);

/** date + n calendar days. */
export function addDays(date, n) {
  return fromUtc(utcOf(date) + n * DAY_MS);
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekdayOf(date) {
  return new Date(utcOf(date)).getUTCDay();
}

/** Calendar days from a to b (negative when b is earlier). */
export function calendarDaysBetween(a, b) {
  return Math.round((utcOf(b) - utcOf(a)) / DAY_MS);
}

/** IST calendar date of an epoch-ms instant. */
export function istDateOf(ms) {
  return fromUtc(ms + IST_OFFSET_MS);
}

/** IST "HH:MM" of an epoch-ms instant. */
export function istClockOf(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Epoch ms of "HH:MM" IST on an IST date. */
export function istInstant(date, hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return utcOf(date) + (h * 60 + m) * 60_000 - IST_OFFSET_MS;
}

/** The exchange whose holiday list applies: NFO/NSE -> NSE, BFO/BSE -> BSE. */
export function holidayKeyFor(exchange) {
  const e = String(exchange ?? "NFO").toUpperCase();
  return e === "BFO" || e === "BSE" ? "BSE" : "NSE";
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Tue 24 Nov" (copy helper for reasons and banners). */
export function shortDay(date) {
  const [, , d] = date.split("-");
  return `${WEEKDAY_NAMES[weekdayOf(date)]} ${Number(d)} ${MONTH_NAMES[Number(date.slice(5, 7)) - 1]}`;
}

/** "24 Nov" */
export function dayMonth(date) {
  return `${Number(date.slice(8, 10))} ${MONTH_NAMES[Number(date.slice(5, 7)) - 1]}`;
}

/** "Jan 2026" for "2026-01" */
export function monthLabel(month) {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/**
 * Merge the shipped holiday rows with the config's add/remove lists.
 * @param {Array<{ date, label, exchanges, verified, origin? }>} shipped
 * @param {{ add?: Array<{ date, label, exchanges?, verified? }>, remove?: string[] }} [cfg]
 * @returns {Array<{ date, label, exchanges: string[], verified: boolean, origin: "shipped"|"config"|"demo" }>}
 */
export function mergeHolidays(shipped, cfg = {}) {
  const removed = new Set(cfg.remove ?? []);
  const byKey = new Map();
  for (const r of shipped ?? []) {
    if (removed.has(r.date)) continue;
    byKey.set(r.date, { date: r.date, label: r.label, exchanges: [...(r.exchanges ?? ["NSE", "BSE"])], verified: r.verified === true, origin: r.origin ?? "shipped" });
  }
  for (const r of cfg.add ?? []) {
    byKey.set(r.date, { date: r.date, label: r.label, exchanges: [...(r.exchanges ?? ["NSE", "BSE"])], verified: r.verified !== false, origin: "config" });
  }
  return [...byKey.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * A calendar over holidays, special sessions and session windows.
 * @param {{ holidays?: Array<{ date, label, exchanges, verified, origin? }>,
 *   specialSessions?: Record<string, { open: string|null, close: string|null, label?: string, exchanges?: string[], verified?: boolean, origin?: string }>,
 *   sessions?: Record<string, { preOpen?: string|null, open?: string|null, close?: string|null }> }} [opts]
 *   sessions: per-exchange overrides; a null field keeps the default from reference/defaults.mjs.
 */
export function createCalendar({ holidays = [], specialSessions = {}, sessions = {} } = {}) {
  const byDate = new Map();
  for (const h of holidays) byDate.set(h.date, h);
  const specials = new Map(Object.entries(specialSessions ?? {}));

  function windowFor(exchange) {
    const e = String(exchange ?? "NFO").toUpperCase();
    const base = DEFAULT_SESSIONS[e] && typeof DEFAULT_SESSIONS[e] === "object" ? DEFAULT_SESSIONS[e] : DEFAULT_SESSIONS.NFO;
    // NSE/BSE cash windows follow the derivatives overrides of their segment when set (NFO for NSE, BFO for BSE).
    const segment = e === "NSE" ? "NFO" : e === "BSE" ? "BFO" : e;
    const o = sessions?.[segment] ?? {};
    const configured = Boolean(o.preOpen || o.open || o.close);
    return {
      preOpen: o.preOpen ?? base.preOpen,
      open: o.open ?? base.open,
      close: o.close ?? base.close,
      source: configured ? `config: reference.sessions.${segment}` : DEFAULT_SESSIONS.source,
    };
  }

  function holidayOn(date, exchange) {
    const h = byDate.get(date);
    return h && h.exchanges.includes(holidayKeyFor(exchange)) ? h : null;
  }

  function specialOn(date, exchange) {
    const s = specials.get(date);
    if (!s) return null;
    const ex = s.exchanges ?? ["NSE", "BSE"];
    return ex.includes(holidayKeyFor(exchange)) ? { date, open: s.open ?? null, close: s.close ?? null, label: s.label ?? "Special session", verified: s.verified !== false, origin: s.origin ?? "config" } : null;
  }

  const hasTimes = (s) => Boolean(s && s.open && s.close);

  function isTradingDay(date, exchange = "NFO") {
    if (hasTimes(specialOn(date, exchange))) return true;
    const wd = weekdayOf(date);
    if (wd === 0 || wd === 6) return false;
    return !holidayOn(date, exchange);
  }

  function step(date, dir, exchange) {
    let d = date;
    for (let i = 0; i < MAX_STEP; i += 1) {
      d = addDays(d, dir);
      if (isTradingDay(d, exchange)) return d;
    }
    return d;
  }

  /** The last trading day strictly before `date`. */
  const prevTradingDay = (date, exchange = "NFO") => step(date, -1, exchange);
  /** The first trading day strictly after `date`. */
  const nextTradingDay = (date, exchange = "NFO") => step(date, 1, exchange);

  /** |{ d : a < d <= b, isTradingDay(d) }|; negative when b is before a. */
  function tradingDaysBetween(a, b, exchange = "NFO") {
    if (a === b) return 0;
    const [lo, hi, sign] = a < b ? [a, b, 1] : [b, a, -1];
    let n = 0;
    for (let d = addDays(lo, 1); d <= hi; d = addDays(d, 1)) if (isTradingDay(d, exchange)) n += 1;
    return n * sign;
  }

  /** The n-th trading day before `date` (n >= 1): E-1 is the trading day before the expiry. */
  function nthTradingDayBefore(date, n, exchange = "NFO") {
    let d = date;
    for (let i = 0; i < n; i += 1) d = prevTradingDay(d, exchange);
    return d;
  }

  /**
   * Session state at an instant (§6.5): HOLIDAY, SPECIAL (inside a special session with times), PRE_OPEN, OPEN or
   * CLOSED. A special session with times wins over a holiday (Muhurat trading is held on a holiday).
   */
  function sessionAt(exchange, tMs) {
    const date = istDateOf(tMs);
    const clock = istClockOf(tMs);
    const w = windowFor(exchange);
    const holiday = holidayOn(date, exchange);
    const special = specialOn(date, exchange);
    const base = {
      date,
      preOpen: w.preOpen,
      open: w.open,
      close: w.close,
      holiday: holiday ? { label: holiday.label, verified: holiday.verified } : null,
      special: special ? { label: special.label, open: special.open, close: special.close, verified: special.verified } : null,
      source: w.source,
    };
    if (special) {
      if (hasTimes(special) && clock >= special.open && clock < special.close) return { ...base, state: "SPECIAL", label: `${special.label} (${special.open}–${special.close} IST)` };
      if (!hasTimes(special) && !holiday) return { ...base, state: "CLOSED", label: `${special.label}: time not announced` };
    }
    if (holiday) return { ...base, state: "HOLIDAY", label: `${holiday.label}${holiday.verified ? "" : " (unverified)"}` };
    if (special && hasTimes(special)) return { ...base, state: "CLOSED", label: clock < special.open ? `${special.label} opens at ${special.open} IST` : `${special.label} closed` };
    const wd = weekdayOf(date);
    if (wd === 0 || wd === 6) return { ...base, state: "CLOSED", label: "Weekend" };
    if (clock >= w.preOpen && clock < w.open) return { ...base, state: "PRE_OPEN", label: "Pre-open" };
    if (clock >= w.open && clock < w.close) return { ...base, state: "OPEN", label: "Open" };
    return { ...base, state: "CLOSED", label: clock < w.preOpen ? "Before the open" : "After the close" };
  }

  /** Holidays between two dates (inclusive), optionally for one exchange. */
  function holidaysIn(from, to, exchange) {
    return holidays.filter((h) => h.date >= from && h.date <= to && (!exchange || h.exchanges.includes(holidayKeyFor(exchange))));
  }

  /** Trading days from the dataset's asOf date to today (§6.4). */
  const staleTradingDays = (asOfDate, today, exchange = "NFO") => (asOfDate ? Math.max(0, tradingDaysBetween(asOfDate, today, exchange)) : null);

  return Object.freeze({
    holidays: Object.freeze([...holidays]),
    specialSessions: Object.freeze(Object.fromEntries(specials)),
    windowFor,
    holidayOn,
    specialOn,
    isTradingDay,
    prevTradingDay,
    nextTradingDay,
    tradingDaysBetween,
    nthTradingDayBefore,
    sessionAt,
    holidaysIn,
    staleTradingDays,
  });
}

/**
 * Weekly/monthly: an expiry is monthly when it is the last listed expiry of its calendar month (the existing
 * isMonthlyExpiry rule). Futures-only lists are all monthly.
 * @param {string[]} dates sorted ascending
 * @param {{ futuresOnly?: boolean }} [o]
 */
export function expiryKinds(dates, { futuresOnly = false } = {}) {
  const lastOfMonth = new Map();
  for (const d of dates) lastOfMonth.set(d.slice(0, 7), d);
  return dates.map((d) => ({ date: d, kind: futuresOnly || lastOfMonth.get(d.slice(0, 7)) === d ? "monthly" : "weekly" }));
}

/**
 * Expiry shift explanation (§6.6). The usual weekday w is the most common weekday of the listed weekly expiries (the
 * monthly ones when none are weekly). For a listed expiry whose weekday differs from w, ruleDate is the next date with
 * weekday w within 6 days; when that day is not a trading day the expiry is `shifted`. Explanation only: the listed
 * date always wins.
 * @param {Array<{ date: string, kind: "weekly"|"monthly" }>} expiries
 * @param {ReturnType<typeof createCalendar>} cal
 * @param {string} exchange
 */
export function expiryShifts(expiries, cal, exchange = "NFO") {
  const pool = expiries.some((e) => e.kind === "weekly") ? expiries.filter((e) => e.kind === "weekly") : expiries;
  const counts = new Array(7).fill(0);
  for (const e of pool) counts[weekdayOf(e.date)] += 1;
  let usual = -1;
  let best = 0;
  for (let i = 0; i < 7; i += 1) {
    if (counts[i] > best) {
      best = counts[i];
      usual = i;
    }
  }
  return expiries.map((e) => {
    const out = { ...e, shifted: false };
    if (usual < 0 || weekdayOf(e.date) === usual) return out;
    let rule = null;
    for (let i = 1; i <= 6; i += 1) {
      const d = addDays(e.date, i);
      if (weekdayOf(d) === usual) {
        rule = d;
        break;
      }
    }
    if (rule && !cal.isTradingDay(rule, exchange)) {
      const h = cal.holidayOn(rule, exchange);
      out.shifted = true;
      out.ruleDate = rule;
      out.reason = `${rule} is a holiday${h && !h.verified ? " (unverified)" : ""}`;
    }
    return out;
  });
}

/**
 * Delivery-margin dates for an expiry (§6.9): E-n is the n-th trading day before the expiry.
 * @param {string} expiry
 * @param {Array<{ day: string, pct: number }>} schedule  rows like { day: "E-4", pct: 10 }
 * @param {ReturnType<typeof createCalendar>} cal
 * @param {string} [exchange]
 */
export function deliveryMarginDates(expiry, schedule, cal, exchange = "NFO") {
  return schedule
    .map((r) => {
      const n = Number(/^E-(\d+)$/.exec(r.day)?.[1]);
      return Number.isInteger(n) && n > 0 ? { day: r.day, date: cal.nthTradingDayBefore(expiry, n, exchange), pct: r.pct } : null;
    })
    .filter(Boolean);
}
