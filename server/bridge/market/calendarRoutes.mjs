/**
 * Calendar routes (docs/openapi.yaml, tag "Market data"). Read only, from the holiday list shipped in the repo; every
 * answer carries `calendar` with the list's date, its source and whether the answer rests on verified rows.
 *
 *   GET /v1/calendar/holidays?exchange=NSE&year=2026
 *   GET /v1/calendar/sessions?exchange=NSE&date=2026-11-09
 *   GET /v1/calendar/status?exchange=NSE            open, pre-open or closed, with the next open
 */
import { BridgeError } from "../core/errors.mjs";
import { createCalendarView } from "./calendarView.mjs";

const opt = (q, name) => {
  const v = q.get(name);
  return v === null || v === "" ? undefined : v;
};
const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });

/**
 * @param {{ clock: { now(): number } }} deps
 * @param {{ view?: ReturnType<typeof createCalendarView> }} [opts]
 */
export function createCalendarRoutes(deps, { view = createCalendarView({ now: () => deps.clock.now() }) } = {}) {
  const meta = (ctx) => ({ requestId: ctx.requestId });
  return {
    async calendarHolidays(ctx) {
      const y = opt(ctx.query, "year");
      if (y !== undefined && !/^\d{4}$/.test(y)) throw invalid("year", "year must be a four-digit year.");
      return { data: view.holidays(opt(ctx.query, "exchange"), y === undefined ? undefined : Number(y)), meta: meta(ctx) };
    },
    async calendarSessions(ctx) {
      return { data: view.sessions(opt(ctx.query, "exchange"), opt(ctx.query, "date")), meta: meta(ctx) };
    },
    async calendarStatus(ctx) {
      return { data: view.status(opt(ctx.query, "exchange")), meta: meta(ctx) };
    },
  };
}
