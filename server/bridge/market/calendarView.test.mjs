/**
 * The market calendar answers: holidays, sessions and status from the shipped holiday list, the verified flags kept, and
 * the routes through the real request pipeline with a controllable clock.
 */
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { istInstant } from "../reference/calendar.mjs";
import { createCalendarView } from "./calendarView.mjs";
import { createCalendarRoutes } from "./calendarRoutes.mjs";
import marketModule, { ROUTES } from "./module.mjs";

const at = (date, hhmm) => istInstant(date, hhmm);
const view = createCalendarView({ now: () => at("2026-11-09", "10:00") });

describe("holidays", () => {
  it("lists a year with every row's own verified flag, the source and the date of the list", () => {
    const r = view.holidays("NSE", 2026);
    expect(r).toMatchObject({ exchange: "NSE", year: 2026 });
    expect(r.holidays).toHaveLength(16);
    // 15 Jan 2026 was added by NSE/CMTR/72260 (Maharashtra municipal elections), after the December holiday circular.
    expect(r.holidays[0]).toMatchObject({ date: "2026-01-15", weekday: "Thursday", label: "Municipal Corporation Election in Maharashtra", exchanges: ["NSE", "BSE"], verified: true });
    expect(r.holidays[1]).toMatchObject({ date: "2026-01-26", weekday: "Monday", label: "Republic Day", exchanges: ["NSE", "BSE"], verified: true });
    // Special sessions are in the list, but their timing was not read in an exchange circular, so the answer is not verified.
    expect(r.calendar).toMatchObject({ covered: true, verified: false, coveredYears: [2025, 2026], note: expect.stringMatching(/special session this answer rests on is not verified.*Weekends are not listed\.$/) });
    expect(r.calendar.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.calendar.source).toMatch(/NSE and BSE/);
    expect(r.specialSessions.map((x) => [x.date, x.weekday, x.open, x.close, x.verified])).toEqual([
      ["2026-02-01", "Sunday", "09:15", "15:30", false],
      ["2026-11-08", "Sunday", "14:20", "15:30", false],
    ]);
    expect(r.specialSessions[1]).toMatchObject({ label: "Muhurat trading", preOpen: "14:05", readOn: "2026-11-10", note: expect.stringMatching(/Secondary source only/) });
  });

  it("the derivatives segments follow their cash exchange; the year defaults to this one", () => {
    expect(view.holidays("NFO", 2026).holidays).toEqual(view.holidays("NSE", 2026).holidays);
    expect(view.holidays("BFO", 2026).holidays).toEqual(view.holidays("BSE", 2026).holidays);
    expect(view.holidays(undefined, undefined).year).toBe(2026);
    expect(view.holidays("nse", 2026).exchange).toBe("NSE");
  });

  it("a year outside the list says plainly that it is not covered and not verified", () => {
    const r = view.holidays("NSE", 2027);
    expect(r.holidays).toEqual([]);
    expect(r.calendar).toMatchObject({ covered: false, verified: false });
    expect(r.calendar.note).toMatch(/outside the years/);
    expect(r.calendar.note).toMatch(/NOT verified/);
  });

  it("an unverified row keeps its flag and makes the answer unverified", () => {
    const rows = [{ date: "2026-08-15", label: "Test day", exchanges: ["NSE"], verified: false, origin: "shipped" }];
    const v = createCalendarView({ now: () => at("2026-08-01", "10:00"), holidays: { asOf: "2026-01-01", source: "test", years: { 2026: rows } }, rows });
    const r = v.holidays("NSE", 2026);
    expect(r.holidays[0].verified).toBe(false);
    expect(r.calendar.verified).toBe(false);
    expect(r.calendar.note).toMatch(/not verified/);
    expect(v.sessions("NSE", "2026-08-15").calendar.verified).toBe(false);
    expect(v.sessions("NSE", "2026-08-14").calendar.verified).toBe(true);
  });

  it("refuses bad years and exchanges the calendar does not hold", () => {
    expect(() => view.holidays("NSE", 1999)).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => view.holidays("NSE", 2101)).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => view.holidays("NSE", 2026.5)).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => view.holidays("XYZ", 2026)).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => view.holidays("MCX", 2026)).toThrow(expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED" }));
    expect(() => view.holidays("CDS", 2026)).toThrow(expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED" }));
  });
});

describe("sessions", () => {
  it("a regular day has pre-open, open and close, the neighbours, and the dated rule with its circular", () => {
    const r = view.sessions("NSE", "2026-11-09");
    expect(r).toMatchObject({ date: "2026-11-09", weekday: "Monday", isTradingDay: true, reason: "Regular trading day", previousTradingDay: "2026-11-08", nextTradingDay: "2026-11-11", holiday: null, specialSession: null });
    expect(r.preOpen).toEqual({ start: r.sessionTimes.preOpen, end: r.sessionTimes.open });
    expect(r.open).toBe(r.sessionTimes.open);
    expect(r.close).toBe(r.sessionTimes.close);
    expect(r.sessionTimes.verified).toBe(true);
    expect(r.sessionTimes.rule).toMatchObject({ id: "cash-cas-2026-08-03", circular: expect.stringMatching(/2026-01-16/), url: expect.stringMatching(/^https:\/\/www\.sebi\.gov\.in/), readOn: "2026-11-10" });
    expect(r.calendar).toMatchObject({ covered: true, verified: true });
  });

  it("derivatives close at 15:40 from 3 Aug 2026 and 15:45 from 7 Dec 2026; before that the hours are the unverified standard ones", () => {
    const nfo = (d) => view.sessions("NFO", d);
    expect(nfo("2026-11-09")).toMatchObject({ close: "15:40", sessionTimes: { verified: true } });
    expect(nfo("2026-12-08")).toMatchObject({ close: "15:45", sessionTimes: { expiringIndexClose: "15:30", verified: true } });
    expect(view.sessions("NSE", "2026-12-08").close).toBe("15:30");
    const old = nfo("2026-07-30");
    expect(old).toMatchObject({ close: "15:30", sessionTimes: { verified: false } });
    expect(old.sessionTimes.source).toMatch(/needs verification/);
  });

  it("a holiday and a weekend are not trading days and say why", () => {
    const h = view.sessions("NSE", "2026-11-10");
    expect(h).toMatchObject({ isTradingDay: false, reason: "Holiday: Diwali-Balipratipada", open: null, close: null, preOpen: null, holiday: { label: "Diwali-Balipratipada", verified: true } });
    expect(h.nextTradingDay).toBe("2026-11-11");
    expect(view.sessions("NSE", "2026-11-14")).toMatchObject({ isTradingDay: false, reason: "Weekend", holiday: null });
  });

  it("the Muhurat session on a Sunday trades its own hours", () => {
    const r = view.sessions("BSE", "2026-11-08");
    expect(r).toMatchObject({ isTradingDay: true, open: "14:20", close: "15:30", preOpen: { start: "14:05", end: "14:20" }, specialSession: { label: "Muhurat trading", verified: false, preOpen: "14:05" } });
    expect(r.reason).toMatch(/Muhurat trading: trades 14:20-15:30 IST \(timing not verified\)/);
    expect(r.calendar.verified).toBe(false);
  });

  it("a date outside the list is a weekday by the calendar and is marked not covered", () => {
    const r = view.sessions("NSE", "2028-03-01");
    expect(r.isTradingDay).toBe(true);
    expect(r.calendar).toMatchObject({ covered: false, verified: false });
    expect(r.calendar.note).toMatch(/NOT verified/);
  });

  it("defaults the date to today and refuses a date that is not real", () => {
    expect(view.sessions("NSE").date).toBe("2026-11-09");
    for (const bad of ["2026-02-30", "2026-13-01", "09-11-2026", "today", "", "2026-11-09T10:00"]) {
      expect(() => view.sessions("NSE", bad), bad).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    }
  });
});

describe("status", () => {
  const status = (when, ex = "NSE") => view.status(ex, when);
  const t = (date, hhmm) => at(date, hhmm);

  it("open during the session, with today's close and no next open", () => {
    const s = status(t("2026-11-09", "10:00"));
    expect(s).toMatchObject({ status: "open", closedBecause: null, date: "2026-11-09", time: "10:00", nextOpen: null, opensAt: null });
    expect(s.closesAt).toBe("2026-11-09T15:30:00.000+05:30");
    expect(s.asOf).toBe("2026-11-09T10:00:00.000+05:30");
  });

  it("pre-open before the open, with when it opens", () => {
    const s = status(t("2026-11-09", "09:05"));
    expect(s).toMatchObject({ status: "pre-open", closedBecause: null });
    expect(s.opensAt).toBe("2026-11-09T09:15:00.000+05:30");
    expect(s.nextOpen.at).toBe("2026-11-09T09:15:00.000+05:30");
  });

  it("closed before pre-open and after the close, with the next open", () => {
    expect(status(t("2026-11-09", "07:00"))).toMatchObject({ status: "closed", closedBecause: "before-open", nextOpen: { date: "2026-11-09", at: "2026-11-09T09:15:00.000+05:30", kind: "regular" } });
    expect(status(t("2026-11-09", "16:00"))).toMatchObject({ status: "closed", closedBecause: "after-close", nextOpen: { date: "2026-11-11" } }); // 10 Nov is a holiday
  });

  it("a holiday: closed, the reason names it, the next open skips it", () => {
    const s = status(t("2026-11-10", "10:00"));
    expect(s).toMatchObject({ status: "closed", closedBecause: "holiday", nextOpen: { date: "2026-11-11", time: "09:15" } });
    expect(s.reason).toMatch(/Diwali-Balipratipada/);
  });

  it("a weekend: the next open is Monday", () => {
    expect(status(t("2026-11-14", "11:00"))).toMatchObject({ status: "closed", closedBecause: "weekend", nextOpen: { date: "2026-11-16" } });
  });

  it("Muhurat on a Sunday is open in its window and the Saturday before points at it", () => {
    expect(status(t("2026-11-08", "14:30"))).toMatchObject({ status: "open", closesAt: "2026-11-08T15:30:00.000+05:30" });
    expect(status(t("2026-11-08", "12:00"))).toMatchObject({ status: "closed", nextOpen: { date: "2026-11-08", time: "14:20", kind: "special", label: "Muhurat trading" } });
    expect(status(t("2026-11-07", "12:00")).nextOpen).toMatchObject({ date: "2026-11-08", kind: "special" });
    expect(status(t("2026-11-08", "16:00")).nextOpen.date).toBe("2026-11-09");
  });

  it("the boundaries: the open minute is open, the close minute is closed", () => {
    expect(status(t("2026-11-09", "09:15")).status).toBe("open");
    expect(status(t("2026-11-09", "15:29")).status).toBe("open");
    expect(status(t("2026-11-09", "15:30")).status).toBe("closed");
    expect(status(t("2026-11-09", "09:00")).status).toBe("pre-open");
    expect(status(t("2026-11-09", "08:59")).status).toBe("closed");
  });

  it("carries the verified flag: a date outside the list is not verified", () => {
    expect(status(t("2026-11-09", "10:00")).calendar.verified).toBe(true);
    expect(status(t("2028-03-01", "10:00")).calendar).toMatchObject({ covered: false, verified: false });
  });
});

describe("cell (the function behind a spreadsheet market call)", () => {
  it("answers one plain value, an empty string when there is none", () => {
    const open = at("2026-11-09", "10:00");
    expect(view.cell("NSE", "status", open)).toBe("open");
    expect(view.cell("NSE", undefined, open)).toBe("open");
    expect(view.cell("NSE", "closesAt", open)).toBe("2026-11-09T15:30:00.000+05:30");
    expect(view.cell("NSE", "nextOpen", open)).toBe("");
    expect(view.cell("NSE", "isTradingDay", open)).toBe(true);
    expect(view.cell("NSE", "holiday", open)).toBe("");
    expect(view.cell("NSE", "verified", open)).toBe(true);
    const holiday = at("2026-11-10", "10:00");
    expect(view.cell("NSE", "status", holiday)).toBe("closed");
    expect(view.cell("NSE", "holiday", holiday)).toBe("Diwali-Balipratipada");
    expect(view.cell("NSE", "opensAt", holiday)).toBe("2026-11-11T09:15:00.000+05:30");
    expect(view.cell("NSE", "reason", holiday)).toMatch(/Diwali/);
  });

  it("refuses an unknown field", () => {
    expect(() => view.cell("NSE", "price")).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
});

describe("routes", () => {
  const KEY = "mcb_readkey0001_x";
  const keyStore = { ...notImplementedService("keyStore"), authenticate: async (raw) => (raw === KEY ? { id: "readkey0001", label: "sheet", scopes: ["read"], accounts: "*" } : null) };
  let app;
  let port;
  let nowMs = at("2026-11-09", "10:00");

  const call = (path, { key = KEY } = {}) =>
    new Promise((resolve, reject) => {
      const headers = { host: `127.0.0.1:${port}` };
      if (key) headers.authorization = `Bearer ${key}`;
      const req = http.request({ host: "127.0.0.1", port, method: "GET", path, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode, json: text ? JSON.parse(text) : undefined });
        });
      });
      req.on("error", reject);
      req.end();
    });

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-calendar-"));
    const { config } = loadConfig({ raw: { server: { port: 0 }, dataDir }, env: {} });
    app = await createApp({ config, modules: [marketModule], overrides: { keyStore }, logger: createNullLogger(), clock: { now: () => nowMs } });
    ({ port } = await app.listen());
  });
  afterAll(async () => app?.close?.());

  it("registers three read-scoped routes", () => {
    const mine = ROUTES.filter(([, p]) => p.startsWith("/v1/calendar/"));
    expect(mine.map(([m, p, o]) => [m, p, o.scope])).toEqual([
      ["GET", "/v1/calendar/holidays", "read"],
      ["GET", "/v1/calendar/sessions", "read"],
      ["GET", "/v1/calendar/status", "read"],
    ]);
  });

  it("GET /v1/calendar/holidays", async () => {
    const r = await call("/v1/calendar/holidays?exchange=NSE&year=2026");
    expect(r.status).toBe(200);
    expect(r.json.data.holidays).toHaveLength(16);
    expect(r.json.meta.requestId).toEqual(expect.any(String));
    expect((await call("/v1/calendar/holidays")).json.data.year).toBe(2026);
    expect((await call("/v1/calendar/holidays?year=2027")).json.data.calendar.covered).toBe(false);
  });

  it("GET /v1/calendar/sessions", async () => {
    const r = await call("/v1/calendar/sessions?exchange=BSE&date=2026-11-10");
    expect(r.json.data).toMatchObject({ exchange: "BSE", isTradingDay: false, reason: "Holiday: Diwali-Balipratipada" });
    expect((await call("/v1/calendar/sessions")).json.data.date).toBe("2026-11-09");
  });

  it("GET /v1/calendar/status follows the clock", async () => {
    expect((await call("/v1/calendar/status?exchange=NFO")).json.data).toMatchObject({ exchange: "NFO", status: "open" });
    nowMs = at("2026-11-09", "18:00");
    const closed = await call("/v1/calendar/status");
    expect(closed.json.data).toMatchObject({ status: "closed", closedBecause: "after-close", nextOpen: { date: "2026-11-11" } });
    nowMs = at("2026-11-09", "10:00");
  });

  it("refuses bad input and unknown keys", async () => {
    for (const bad of ["/v1/calendar/holidays?year=26", "/v1/calendar/holidays?year=abcd", "/v1/calendar/holidays?year=1999", "/v1/calendar/holidays?exchange=XYZ", "/v1/calendar/sessions?date=2026-02-30", "/v1/calendar/status?exchange=%00"]) {
      expect((await call(bad)).status, bad).toBe(400);
    }
    expect((await call("/v1/calendar/status?exchange=MCX")).status).toBe(422);
    expect((await call("/v1/calendar/status", { key: null })).status).toBe(401);
    expect((await call("/v1/calendar/status", { key: "mcb_nope000000_x" })).status).toBe(401);
  });

  it("the handlers can be built without the app (a spreadsheet function can share the view)", async () => {
    const h = createCalendarRoutes({ clock: { now: () => at("2026-11-09", "10:00") } });
    const r = await h.calendarStatus({ query: new URLSearchParams("exchange=NSE"), requestId: "r1" });
    expect(r.data.status).toBe("open");
  });
});
