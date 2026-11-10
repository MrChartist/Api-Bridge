/**
 * The market calendar as read-only answers: holidays for a year, the sessions of a date and whether an exchange is open
 * now. Built on the reference calendar (reference/calendar.mjs) and the holiday list shipped in the repo
 * (reference/data/holidays.json). Pure: no I/O, the clock is passed in.
 *
 * Honesty rules (the data is a dated list, not a live feed from the exchange):
 *  - every holiday row keeps its own `verified` flag, and every answer carries `calendar.verified`, which is false when
 *    the date is outside the years the list covers or any row it used is unverified;
 *  - a date outside the covered years is treated as an ordinary weekday and the answer says so (`covered: false`);
 *  - the session times come from the dated rules in reference/data/sessions.json (the same source the live-order gate and the
 *    recorder schedule read); each answer says which rule applied, its circular and URL, the date it was read and whether it is
 *    `verified`. Special sessions (Muhurat, Budget Sunday) come from reference/data/special-sessions.json with their own flag;
 *  - only NSE, BSE, NFO and BFO are covered; MCX and CDS have their own hours that this list does not hold.
 */
import { BridgeError } from "../core/errors.mjs";
import { addDays, createCalendar, istClockOf, istDateOf, istInstant, isIsoDate, mergeHolidays, weekdayOf } from "../reference/calendar.mjs";
import { SHIPPED_HOLIDAYS, shippedHolidayRows, shippedSpecialSessions } from "../reference/shipped.mjs";

export const CALENDAR_EXCHANGES = Object.freeze(["NSE", "BSE", "NFO", "BFO"]);
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const IST = "+05:30";

const istIso = (ms) => new Date(ms + 330 * 60_000).toISOString().replace("Z", IST);

/** The exchange as the calendar knows it, or a clear refusal. */
export function calendarExchange(value) {
  const e = String(value ?? "NSE").trim().toUpperCase();
  if (CALENDAR_EXCHANGES.includes(e)) return e;
  if (e === "MCX" || e === "CDS") {
    throw new BridgeError("CAPABILITY_UNSUPPORTED", `The Bridge's calendar covers ${CALENDAR_EXCHANGES.join(", ")} only. ${e} has its own holidays and hours that are not in it.`);
  }
  throw new BridgeError("VALIDATION_FAILED", `exchange must be one of ${CALENDAR_EXCHANGES.join(", ")}.`, { errors: [{ path: "exchange", message: "not a calendar exchange" }] });
}

/**
 * @param {{ now: () => number, holidays?: object, rows?: object[], specials?: object }} opts
 *   holidays/rows/specials: override the shipped data (tests)
 */
export function createCalendarView({ now, holidays = SHIPPED_HOLIDAYS, rows, specials } = {}) {
  const clock = now ?? (() => Date.now());
  const years = Object.keys(holidays.years ?? {}).map(Number).sort((a, b) => a - b);
  const heldRows = rows ?? (holidays === SHIPPED_HOLIDAYS ? shippedHolidayRows() : mergeHolidays(Object.values(holidays.years ?? {}).flat()));
  const specialSessions = specials ?? (holidays === SHIPPED_HOLIDAYS ? shippedSpecialSessions() : {});
  const cal = createCalendar({ holidays: heldRows, specialSessions });

  const coveredYears = years.length ? `${years[0]}${years.length > 1 ? `-${years[years.length - 1]}` : ""}` : "none";
  const isCovered = (date) => years.includes(Number(date.slice(0, 4)));

  /** Facts about the data itself, with whether this answer rests only on verified rows. */
  function calendarInfo({ covered, verified, extra }) {
    const notes = [];
    if (!covered) notes.push(`This date is outside the years the Bridge's holiday list covers (${coveredYears}). It is treated as an ordinary weekday and is NOT verified: check the exchange's holiday circular.`);
    if (covered && !verified) notes.push("A holiday or special session this answer rests on is not verified (the timing has not been confirmed from the exchange circular). Check the exchange's circular.");
    if (extra) notes.push(extra);
    return { asOf: holidays.asOf ?? null, source: holidays.source ?? null, coveredYears: years, covered, verified: covered && verified, note: notes.length ? notes.join(" ") : null };
  }

  const holidayRow = (h) => ({ date: h.date, weekday: WEEKDAYS[weekdayOf(h.date)], label: h.label, exchanges: h.exchanges, verified: h.verified });

  function windowOf(exchange, date) {
    const w = cal.windowFor(exchange, date);
    return {
      preOpen: w.preOpen,
      open: w.open,
      close: w.close,
      ...(w.expiringIndexClose ? { expiringIndexClose: w.expiringIndexClose } : {}),
      ...(w.cas ? { cas: w.cas } : {}),
      timezone: "IST",
      verified: w.verified,
      source: w.source,
      rule: { id: w.ruleId ?? null, from: w.from ?? null, to: w.to ?? null, circular: w.circular ?? null, url: w.url ?? null, readOn: w.readOn ?? null, note: w.note ?? null },
    };
  }

  /** The first session open strictly after `ms`: { date, at, kind }. */
  function nextOpen(exchange, ms) {
    let d = istDateOf(ms);
    for (let i = 0; i < 45; i += 1) {
      if (cal.isTradingDay(d, exchange)) {
        const w = cal.windowFor(exchange, d);
        const sp = cal.specialOn(d, exchange);
        const open = sp && sp.open && sp.close ? sp.open : w.open;
        const at = istInstant(d, open);
        if (at > ms) return { date: d, time: open, at: istIso(at), kind: sp && sp.open && sp.close ? "special" : "regular", label: sp && sp.open && sp.close ? sp.label : null };
      }
      d = addDays(d, 1);
    }
    return null;
  }

  return {
    /** Holidays of one calendar year for an exchange. */
    holidays(exchangeIn, yearIn) {
      const exchange = calendarExchange(exchangeIn);
      const year = yearIn === undefined ? Number(istDateOf(clock()).slice(0, 4)) : yearIn;
      if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new BridgeError("VALIDATION_FAILED", "year must be a four-digit year from 2000 to 2100.", { errors: [{ path: "year", message: "out of range" }] });
      const from = `${year}-01-01`;
      const to = `${year}-12-31`;
      const list = cal.holidaysIn(from, to, exchange).map(holidayRow);
      const special = Object.entries(cal.specialSessions)
        .filter(([date]) => date >= from && date <= to && cal.specialOn(date, exchange))
        .map(([date, s]) => ({ date, weekday: WEEKDAYS[weekdayOf(date)], label: s.label ?? "Special session", open: s.open ?? null, close: s.close ?? null, ...(s.preOpen ? { preOpen: s.preOpen } : {}), ...(s.cas ? { cas: s.cas } : {}), verified: s.verified === true, source: s.source ?? null, readOn: s.readOn ?? null, note: s.note ?? null }));
      const covered = years.includes(year);
      return {
        exchange,
        year,
        holidays: list,
        specialSessions: special,
        calendar: calendarInfo({ covered, verified: list.every((h) => h.verified) && special.every((s) => s.verified), extra: "Weekends are not listed." }),
      };
    },

    /** The session of one date: trading day or not, why, and the times. */
    sessions(exchangeIn, dateIn) {
      const exchange = calendarExchange(exchangeIn);
      const date = dateIn === undefined ? istDateOf(clock()) : dateIn;
      if (!isIsoDate(date)) throw new BridgeError("VALIDATION_FAILED", "date must be a real date like 2026-11-09.", { errors: [{ path: "date", message: "not a date" }] });
      const covered = isCovered(date);
      const holiday = cal.holidayOn(date, exchange);
      const special = cal.specialOn(date, exchange);
      const weekday = weekdayOf(date);
      const tradingDay = cal.isTradingDay(date, exchange);
      const w = windowOf(exchange, date);
      const specialWithTimes = special && special.open && special.close;
      let reason;
      if (specialWithTimes) reason = `${special.label}: trades ${special.open}-${special.close} IST${special.verified ? "" : " (timing not verified)"}${holiday ? ` (${holiday.label} is a holiday)` : ""}`;
      else if (special) reason = `${special.label}: the time has not been announced`;
      else if (holiday) reason = `Holiday: ${holiday.label}`;
      else if (weekday === 0 || weekday === 6) reason = "Weekend";
      else reason = "Regular trading day";
      const rowsUsed = [holiday, special].filter(Boolean);
      return {
        exchange,
        date,
        weekday: WEEKDAYS[weekday],
        isTradingDay: tradingDay,
        reason,
        preOpen: tradingDay ? (specialWithTimes ? (special.preOpen ? { start: special.preOpen, end: special.open } : null) : { start: w.preOpen, end: w.open }) : null,
        open: tradingDay ? (specialWithTimes ? special.open : w.open) : null,
        close: tradingDay ? (specialWithTimes ? special.close : w.close) : null,
        holiday: holiday ? { label: holiday.label, verified: holiday.verified } : null,
        specialSession: special ? { label: special.label, open: special.open, close: special.close, ...(special.preOpen ? { preOpen: special.preOpen } : {}), ...(special.cas ? { cas: special.cas } : {}), verified: special.verified, source: special.source, readOn: special.readOn, note: special.note } : null,
        sessionTimes: w,
        previousTradingDay: cal.prevTradingDay(date, exchange),
        nextTradingDay: cal.nextTradingDay(date, exchange),
        calendar: calendarInfo({ covered, verified: rowsUsed.every((r) => r.verified === true) }),
      };
    },

    /** Whether the exchange is open at `ms` (now by default) and when it next opens. */
    status(exchangeIn, ms = clock()) {
      const exchange = calendarExchange(exchangeIn);
      const s = cal.sessionAt(exchange, ms);
      const date = s.date;
      const state = s.state === "OPEN" || s.state === "SPECIAL" ? "open" : s.state === "PRE_OPEN" ? "pre-open" : "closed";
      const w = cal.windowFor(exchange, date);
      const special = cal.specialOn(date, exchange);
      const specialWithTimes = special && special.open && special.close;
      const todaysClose = specialWithTimes ? special.close : w.close;
      const todaysOpen = specialWithTimes ? special.open : w.open;
      let closedBecause = null;
      if (state === "closed") {
        if (s.state === "HOLIDAY") closedBecause = "holiday";
        else if (weekdayOf(date) === 0 || weekdayOf(date) === 6) closedBecause = "weekend";
        else if (istClockOf(ms) < (specialWithTimes ? special.open : w.preOpen)) closedBecause = "before-open";
        else closedBecause = "after-close";
      }
      const next = state === "open" ? null : nextOpen(exchange, ms);
      const rowsUsed = [s.holiday, s.special].filter(Boolean);
      const covered = isCovered(date);
      return {
        exchange,
        status: state,
        reason: s.label,
        closedBecause,
        asOf: istIso(ms),
        date,
        time: istClockOf(ms),
        opensAt: state === "pre-open" ? istIso(istInstant(date, todaysOpen)) : null,
        closesAt: state === "open" || state === "pre-open" ? istIso(istInstant(date, todaysClose)) : null,
        nextOpen: next,
        sessionTimes: windowOf(exchange, date),
        calendar: calendarInfo({ covered, verified: rowsUsed.every((r) => r.verified === true) }),
      };
    },

    /**
     * One plain value for a spreadsheet cell (the function behind /xl/market): status, reason, opensAt, closesAt,
     * nextOpen (when it next opens), isTradingDay (today), holiday (today's holiday name, else empty), verified.
     * Dates and times are IST text; an absent value is an empty string, never a guess.
     */
    cell(exchangeIn, field, ms = clock()) {
      const st = this.status(exchangeIn, ms);
      switch (String(field ?? "status")) {
        case "status":
          return st.status;
        case "reason":
          return st.reason;
        case "opensAt":
          return st.opensAt ?? st.nextOpen?.at ?? "";
        case "closesAt":
          return st.closesAt ?? "";
        case "nextOpen":
          return st.nextOpen?.at ?? "";
        case "isTradingDay":
          return this.sessions(exchangeIn, st.date).isTradingDay;
        case "holiday":
          return this.sessions(exchangeIn, st.date).holiday?.label ?? "";
        case "verified":
          return st.calendar.verified;
        default:
          throw new BridgeError("VALIDATION_FAILED", "field must be one of status, reason, opensAt, closesAt, nextOpen, isTradingDay, holiday, verified.", { errors: [{ path: "field", message: "unknown field" }] });
      }
    },
  };
}
