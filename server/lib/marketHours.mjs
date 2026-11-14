/**
 * Indian market session clock, in IST regardless of where the host runs.
 *
 * The existing client-side check in src/hooks/useMarketData.ts uses the browser's
 * local clock, which is wrong on any non-IST machine — including a VPS in a
 * different region, which is exactly where this proxy is meant to be deployed
 * (Dhan's order APIs need a whitelisted static IP). Session state gates real
 * orders and arms stop-losses, so it is computed here from Asia/Kolkata parts.
 *
 * The session times and the special sessions are NOT held here: they come from the reference data (reference/data/sessions.json
 * and special-sessions.json, through the shared calendar), the same source as the calendar pages, readiness and the recorder
 * schedule. This file only turns them into the answers the order gate and the stream need.
 */
import { createCalendar } from "../bridge/reference/calendar.mjs";
import { sharedCalendar } from "../bridge/reference/sharedCalendar.mjs";
import { shippedSpecialSessions } from "../bridge/reference/shipped.mjs";


const IST_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Break a Date into IST calendar parts. */
export function istParts(date = new Date()) {
  const parts = Object.fromEntries(
    IST_PARTS.formatToParts(date).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );
  return {
    weekday: parts.weekday,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    minutesOfDay: Number(parts.hour) * 60 + Number(parts.minute),
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** Minutes past midnight -> "HH:MM". */
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const toMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * Special trading sessions come from reference/data/special-sessions.json (Muhurat, Budget Sunday). This function replaces
 * them for a test or an operator override; pass {} for none, and call useShippedSpecialSessions() to go back to the data file.
 *
 * Keys are the zero-padded IST date "YYYY-MM-DD". Shape: { "2026-11-08": { startMinute: 1110, endMinute: 1170, label: "Muhurat" } }
 * (startMinute/endMinute are minutes past IST midnight). A session given here counts as verified, because the caller stated it.
 */
let override = null;
let overrideCal = null;

export function setSpecialSessions(sessions) {
  override = sessions && typeof sessions === "object" ? sessions : {};
  const specials = {};
  for (const [date, v] of Object.entries(override)) {
    if (v && Number.isFinite(v.startMinute) && Number.isFinite(v.endMinute)) specials[date] = { open: hhmm(v.startMinute), close: hhmm(v.endMinute), label: v.label || "Special session", exchanges: ["NSE", "BSE"], verified: v.verified !== false };
  }
  overrideCal = createCalendar({ holidays: [], specialSessions: specials });
}

/** Go back to the special sessions of the data file. */
export function useShippedSpecialSessions() {
  override = null;
  overrideCal = null;
}

let noHolidayCal = null;
/** The calendar this file answers from: the shipped rules and special sessions, without holidays (see the note below). */
function calendar() {
  if (overrideCal) return overrideCal;
  noHolidayCal ??= createCalendar({ holidays: [], specialSessions: shippedSpecialSessions() });
  return noHolidayCal;
}

/** True when the exchange holds a session on this IST date ("YYYY-MM-DD"): a weekday, or a special session with times. Holidays are included. */
export function isTradingDay(dateKey, exchange = "NSE") {
  const cal = overrideCal ?? sharedCalendar();
  return cal.isTradingDay(dateKey, exchange);
}

const sessionLabel = (r) => {
  if (r.state === "OPEN") return "Regular session";
  if (r.state === "PRE_OPEN") return `Pre-open (${r.preOpen}\u2013${r.open}) \u2014 no orders`;
  if (r.state === "CLOSED" && (r.label === "After the close" || r.label === "Before the open")) return `Market closed (${r.open}\u2013${r.close} IST)`;
  return r.label;
};

/**
 * Current session state, from the dated reference rules. `exchange` picks the segment (NFO/BFO derivatives, NSE/BSE cash);
 * without one the cash window is used, which is the shortest and so never lets a derivative order through late.
 *
 * NOTE ON HOLIDAYS: this view does not apply the holiday list: on a holiday it reports OPEN during regular hours. The
 * safety guard and the calendar pages apply the holiday list (verified holidays block live orders, unverified ones warn).
 *
 * This is the read-only view: a special session counts as SPECIAL even when its timing is not verified yet (`verified` is
 * false then). For a live order use orderSession().
 *
 * @returns {{ state: "CLOSED"|"PRE_OPEN"|"OPEN"|"SPECIAL", label: string, ist: object, verified: boolean }}
 */
export function marketSession(date = new Date(), exchange = "NSE") {
  const ist = istParts(date);
  const r = calendar().sessionAt(exchange, date.getTime());
  return { state: r.state, label: sessionLabel(r), ist, verified: r.special ? r.special.verified : r.verified };
}

/**
 * Session state for a LIVE order: the gate view. An unverified rule never lengthens the window beyond the floor in the data,
 * a special session whose timing is not verified is refused, and an index contract expiring today (or of unknown expiry)
 * stops at the earlier expiry-day close where the rule has one.
 * @param {Date} date
 * @param {string} [exchange]
 * @param {{ kind?: "index"|"stock"|null, expiry?: string|null }} [instrument]
 */
export function orderSession(date = new Date(), exchange = "NSE", instrument = null) {
  const ist = istParts(date);
  const r = calendar().sessionAt(exchange, date.getTime(), { gate: true, instrument });
  return { state: r.state, label: sessionLabel(r), ist, verified: r.special ? r.special.verified : r.verified, ...(r.unverifiedSpecial ? { unverifiedSpecial: true } : {}) };
}

/** Can a real order be placed right now? Pre-open is explicitly excluded; an unverified special session is refused. */
export function isTradeable(date = new Date(), exchange = "NSE", instrument = null) {
  const { state } = orderSession(date, exchange, instrument);
  return state === "OPEN" || state === "SPECIAL";
}

/** Minutes until the regular session closes; negative once it has. */
export function minutesToClose(date = new Date(), exchange = "NSE") {
  const ist = istParts(date);
  return toMinutes(calendar().closeFor(exchange, ist.dateKey)) - ist.minutesOfDay;
}

/**
 * Is a tick recent enough, AND from inside today's session, to act on?
 *
 * This is what stops a stop-loss firing at 09:14 against yesterday's close: the
 * cached LTP is real, but its exchange timestamp is from the previous session.
 *
 * @param {number} lttEpochSeconds exchange last-traded time from the feed
 * @param {number} receivedAtMs when the Bridge received the tick
 * @param {number} maxAgeMs staleness ceiling (default 5s)
 */
export function requireFreshTick(lttEpochSeconds, receivedAtMs, maxAgeMs = 5000, now = Date.now(), exchange = "NSE") {
  if (!Number.isFinite(receivedAtMs) || now - receivedAtMs > maxAgeMs) {
    return { ok: false, reason: "STALE_FEED" };
  }
  if (!isTradeable(new Date(now), exchange)) {
    return { ok: false, reason: "MARKET_CLOSED" };
  }
  if (Number.isFinite(lttEpochSeconds) && lttEpochSeconds > 0) {
    const tickDay = istParts(new Date(lttEpochSeconds * 1000)).dateKey;
    if (tickDay !== istParts(new Date(now)).dateKey) {
      return { ok: false, reason: "TICK_FROM_PREVIOUS_SESSION" };
    }
  }
  return { ok: true, reason: null };
}
