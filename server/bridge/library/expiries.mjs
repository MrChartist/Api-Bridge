/**
 * Rolling expiries for an option universe. Pure functions over the expiries an underlying has LISTED (the instrument
 * master's dates, which already follow the exchange's holiday shifts) and the calendar in reference/calendar.mjs.
 *
 * The exchange decides the dates; this file never invents one. It only chooses among the listed dates:
 *   upcoming         listed dates from today on; an expiry whose day is today drops out once the session has closed
 *   kinds            weekly or monthly (the last listed expiry of a calendar month is the monthly one: reference/calendar.mjs expiryKinds)
 *   weekly series    the nearest expiry plus those that follow it about a week apart (at most 9 days between neighbours)
 *   shifts           an expiry on an unusual weekday because the usual day is a holiday is marked `shifted` with the reason
 *
 *   current-weekly   the nearest upcoming expiry of an underlying that has weekly expiries
 *   next-weekly      the one after it
 *   current-monthly  the nearest upcoming monthly expiry (stocks and some indices have only these)
 *   all-weekly       the weekly series, at most `maxWeekly` expiries
 *   [dates]          exactly these, each checked against the listed dates
 *
 * An underlying with no weekly expiries (a stock, or an index whose weeklies were withdrawn) answers a weekly rule with an
 * error that says so, instead of quietly using a monthly date.
 */
import { BridgeError } from "../core/errors.mjs";
import { calendarDaysBetween, expiryKinds, expiryShifts, istDateOf, istInstant, weekdayOf } from "../reference/calendar.mjs";

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Neighbouring weekly expiries are about 7 days apart; a holiday shift can stretch or shrink that by a day or two. */
const WEEKLY_GAP_MAX_DAYS = 9;

/**
 * Listed expiry dates -> upcoming ones with kind and shift explanation.
 * @param {string[]} listed
 * @param {{ nowMs: number, cal: ReturnType<typeof import("../reference/calendar.mjs").createCalendar>, exchange?: string }} o
 * @returns {{ items: Array<{ date: string, kind: "weekly"|"monthly", shifted: boolean, ruleDate?: string, reason?: string, daysAway: number }>, today: string, droppedToday: string | null, close: string }}
 */
export function upcomingExpiries(listed, { nowMs, cal, exchange = "NFO" }) {
  const today = istDateOf(nowMs);
  const close = cal.windowFor(exchange).close;
  const closeAt = istInstant(today, close);
  let droppedToday = null;
  const dates = [...new Set(listed)]
    .filter((d) => {
      if (d < today) return false;
      if (d === today && nowMs >= closeAt) {
        droppedToday = d;
        return false;
      }
      return true;
    })
    .sort();
  const withKinds = expiryKinds(dates);
  const items = expiryShifts(withKinds, cal, exchange).map((e) => ({ ...e, daysAway: calendarDaysBetween(today, e.date) }));
  return { items, today, droppedToday, close };
}

/** The weekly series: the nearest expiry and those that follow about a week apart, in order. */
export function weeklyRun(items) {
  if (!items.length) return [];
  const run = [items[0]];
  for (let i = 1; i < items.length; i += 1) {
    if (calendarDaysBetween(items[i - 1].date, items[i].date) > WEEKLY_GAP_MAX_DAYS) break;
    run.push(items[i]);
  }
  return run;
}

/** Whether the underlying has weekly expiries (some listed expiry is not the last of its month, and the nearest ones run weekly). */
export function hasWeeklies(items) {
  return items.some((e) => e.kind === "weekly") && weeklyRun(items).length >= 2;
}

const noWeeklies = (underlying, items) =>
  new BridgeError(
    "VALIDATION_FAILED",
    `${underlying} has no weekly expiries listed (its expiries are ${items.slice(0, 4).map((e) => e.date).join(", ") || "none"}${items.length > 4 ? ", ..." : ""}). Use "current-monthly", or list the dates.`,
    { errors: [{ path: "universe.expiries", message: "no weekly expiries for this underlying" }] },
  );

/**
 * Choose the expiries a rule means, from the upcoming list.
 * @param {string | string[]} rule
 * @param {ReturnType<typeof upcomingExpiries>["items"]} items
 * @param {{ underlying: string, maxWeekly?: number, today: string, droppedToday?: string | null, close?: string }} o
 * @returns {{ picked: any[], warnings: string[], rule: string }}
 */
export function selectExpiries(rule, items, { underlying, maxWeekly = 5, today, droppedToday = null, close = "" }) {
  const warnings = [];
  if (!items.length) {
    throw new BridgeError("SYMBOL_NOT_FOUND", `${underlying} has no upcoming expiries in the instrument list${droppedToday ? ` (${droppedToday} has just expired)` : ""}.`);
  }
  let picked;
  let text;
  if (Array.isArray(rule)) {
    const byDate = new Map(items.map((e) => [e.date, e]));
    picked = [];
    for (const d of rule) {
      const hit = byDate.get(d);
      if (hit) {
        picked.push(hit);
        continue;
      }
      const near = items.filter((e) => Math.abs(calendarDaysBetween(d, e.date)) <= 6).map((e) => e.date);
      const why = d < today ? "already expired" : droppedToday === d ? "expired at today's close" : `not a listed expiry of ${underlying}`;
      warnings.push(`${d} (${WEEKDAY[weekdayOf(d)]}) is ${why}; skipped${near.length ? `. Listed near it: ${near.join(", ")}` : ""}.`);
    }
    text = `the dates ${rule.join(", ")}`;
  } else if (rule === "current-monthly") {
    const m = items.find((e) => e.kind === "monthly");
    picked = m ? [m] : [];
    text = "current-monthly: the nearest expiry that is the last of its month";
    if (!m) warnings.push("No monthly expiry is listed yet.");
  } else {
    if (!hasWeeklies(items)) throw noWeeklies(underlying, items);
    const run = weeklyRun(items);
    if (rule === "current-weekly") {
      picked = [run[0]];
      text = "current-weekly: the nearest expiry that has not closed";
    } else if (rule === "next-weekly") {
      picked = run.length > 1 ? [run[1]] : [];
      text = "next-weekly: the expiry after the nearest one";
      if (!picked.length) warnings.push("Only one weekly expiry is listed, so there is no next-weekly yet.");
    } else if (rule === "all-weekly") {
      picked = run.slice(0, maxWeekly);
      text = `all-weekly: the nearest expiry and the weekly ones after it, up to ${maxWeekly} (library.maxWeeklyExpiries)`;
    } else {
      throw new BridgeError("VALIDATION_FAILED", `Unknown expiry rule "${rule}".`);
    }
  }
  if (droppedToday && !Array.isArray(rule)) warnings.push(`The ${droppedToday} expiry closed${close ? ` at ${close} IST` : ""} today, so the rule rolled on to the next one.`);
  for (const e of picked) {
    if (e.shifted) warnings.push(`${e.date} (${WEEKDAY[weekdayOf(e.date)]}) is not the usual expiry day: ${e.reason}. The exchange's listed date is used.`);
  }
  return { picked, warnings, rule: text };
}
