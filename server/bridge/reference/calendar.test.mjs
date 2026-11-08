import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { addDays, createCalendar, deliveryMarginDates, expiryKinds, expiryShifts, isIsoDate, istInstant, mergeHolidays } from "./calendar.mjs";
import { SHIPPED_DELIVERY_MARGIN, shippedHolidayRows, shippedSpecialSessions } from "./shipped.mjs";

const at = (date, hhmm) => istInstant(date, hhmm);

describe("dates", () => {
  it("validates real dates only", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-2-3")).toBe(false);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("isTradingDay", () => {
  const cal = createCalendar({
    holidays: mergeHolidays(shippedHolidayRows(), { add: [{ date: "2026-11-27", label: "Test holiday", exchanges: ["NSE"] }], remove: ["2026-12-25"] }),
    specialSessions: { "2026-11-08": { open: "18:00", close: "19:00", label: "Muhurat", exchanges: ["NSE", "BSE"] }, "2026-11-15": { open: null, close: null, label: "Unannounced" } },
  });

  it("weekends and holidays are closed; config add and remove apply", () => {
    expect(cal.isTradingDay("2026-10-31")).toBe(false); // Saturday
    expect(cal.isTradingDay("2026-11-01")).toBe(false); // Sunday
    expect(cal.isTradingDay("2026-11-24")).toBe(false); // shipped holiday
    expect(cal.isTradingDay("2026-11-27", "NFO")).toBe(false); // config add (NSE only)
    expect(cal.isTradingDay("2026-11-27", "BFO")).toBe(true);
    expect(cal.isTradingDay("2026-12-25")).toBe(true); // config remove
    expect(cal.isTradingDay("2026-10-29")).toBe(true);
  });

  it("a special session counts only when its times are set", () => {
    expect(cal.isTradingDay("2026-11-08")).toBe(true);
    expect(cal.isTradingDay("2026-11-15")).toBe(false);
  });

  it("previous and next trading day step over weekends and holidays", () => {
    expect(cal.nextTradingDay("2026-11-23")).toBe("2026-11-25");
    expect(cal.prevTradingDay("2026-11-25")).toBe("2026-11-23");
    expect(cal.prevTradingDay("2026-11-02")).toBe("2026-10-30");
  });
});

describe("tradingDaysBetween and staleness", () => {
  it("Thu 29 Oct to Mon 2 Nov is 2 trading days (stale); 1 when Fri 30 Oct is a holiday", () => {
    const plain = createCalendar({ holidays: [] });
    expect(plain.tradingDaysBetween("2026-10-29", "2026-11-02")).toBe(2);
    expect(plain.staleTradingDays("2026-10-29", "2026-11-02")).toBe(2);
    expect(plain.tradingDaysBetween("2026-11-02", "2026-10-29")).toBe(-2);
    const hol = createCalendar({ holidays: [{ date: "2026-10-30", label: "X", exchanges: ["NSE", "BSE"], verified: true }] });
    expect(hol.tradingDaysBetween("2026-10-29", "2026-11-02")).toBe(1);
    expect(hol.tradingDaysBetween("2026-11-02", "2026-10-29")).toBe(-1);
  });
});

describe("sessionAt", () => {
  const cal = createCalendar({ holidays: shippedHolidayRows(), specialSessions: shippedSpecialSessions() });
  it.each([
    ["08:59", "CLOSED"],
    ["09:00", "PRE_OPEN"],
    ["09:14", "PRE_OPEN"],
    ["09:15", "OPEN"],
    ["15:29", "OPEN"],
    ["15:30", "CLOSED"],
  ])("Thu 29 Oct %s IST is %s", (hhmm, state) => {
    const s = cal.sessionAt("NFO", at("2026-10-29", hhmm));
    expect(s.state).toBe(state);
    expect(s).toMatchObject({ date: "2026-10-29", open: "09:15", close: "15:30", preOpen: "09:00", holiday: null });
  });

  it("a holiday reports HOLIDAY with its label and verification", () => {
    const s = cal.sessionAt("NFO", at("2026-11-24", "10:00"));
    expect(s.state).toBe("HOLIDAY");
    expect(s.holiday).toEqual({ label: "Prakash Gurpurb Sri Guru Nanak Dev", verified: true });
    expect(s.label).toBe("Prakash Gurpurb Sri Guru Nanak Dev");
  });

  it("Muhurat with no announced time is closed; with times it is SPECIAL at 18:30", () => {
    const untimed = createCalendar({ holidays: [], specialSessions: { "2026-11-08": { open: null, close: null, label: "Muhurat trading" } } });
    expect(untimed.sessionAt("NFO", at("2026-11-08", "18:30"))).toMatchObject({ state: "CLOSED", label: "Muhurat trading: time not announced" });
    // The shipped 2026 session has its times (NSE notice of 19 Oct 2026: 14:20 to 15:30 IST).
    expect(cal.sessionAt("NFO", at("2026-11-08", "14:30")).state).toBe("SPECIAL");
    const timed = createCalendar({ holidays: [], specialSessions: { "2026-11-08": { open: "18:00", close: "19:00", label: "Muhurat trading" } } });
    expect(timed.sessionAt("NFO", at("2026-11-08", "18:30")).state).toBe("SPECIAL");
    expect(timed.sessionAt("NFO", at("2026-11-08", "19:00")).state).toBe("CLOSED");
  });

  it("config session times override the defaults", () => {
    const c = createCalendar({ sessions: { NFO: { preOpen: null, open: null, close: "15:00" } } });
    expect(c.sessionAt("NFO", at("2026-10-29", "15:10")).state).toBe("CLOSED");
    expect(c.sessionAt("BFO", at("2026-10-29", "15:10")).state).toBe("OPEN");
    expect(c.windowFor("NFO").source).toMatch(/config/);
  });
});

describe("expiry kinds and shifts", () => {
  const cal = createCalendar({ holidays: shippedHolidayRows() });
  it("NIFTY 23 Nov 2026 (Mon) is shifted because Tue 24 Nov is a holiday", () => {
    const listed = ["2026-11-03", "2026-11-09", "2026-11-17", "2026-11-23", "2026-12-01", "2026-12-29"];
    const kinds = expiryKinds(listed);
    expect(kinds.map((k) => k.kind)).toEqual(["weekly", "weekly", "weekly", "monthly", "weekly", "monthly"]);
    const out = expiryShifts(kinds, cal, "NFO");
    const nov23 = out.find((e) => e.date === "2026-11-23");
    expect(nov23).toMatchObject({ shifted: true, ruleDate: "2026-11-24", reason: "2026-11-24 is a holiday" });
    expect(out.find((e) => e.date === "2026-11-09")).toMatchObject({ shifted: true, ruleDate: "2026-11-10" });
    expect(out.find((e) => e.date === "2026-11-17").shifted).toBe(false);
  });
  it("futures-only lists are monthly", () => {
    expect(expiryKinds(["2026-11-24", "2026-12-29"], { futuresOnly: true }).every((k) => k.kind === "monthly")).toBe(true);
  });
});

describe("delivery-margin dates", () => {
  it("E-1..E-4 before the 23 Nov 2026 expiry", () => {
    const cal = createCalendar({ holidays: shippedHolidayRows() });
    expect(deliveryMarginDates("2026-11-23", SHIPPED_DELIVERY_MARGIN.schedule, cal)).toEqual([
      { day: "E-4", date: "2026-11-17", pct: 10 },
      { day: "E-3", date: "2026-11-18", pct: 25 },
      { day: "E-2", date: "2026-11-19", pct: 45 },
      { day: "E-1", date: "2026-11-20", pct: 70 },
    ]);
  });
});

describe("IST correctness whatever the host time zone", () => {
  it.each(["UTC", "America/New_York", "Asia/Kolkata"])("TZ=%s gives the same sessions", (tz) => {
    const script = `import("${new URL("./calendar.mjs", import.meta.url).href}").then((m) => { const c = m.createCalendar({}); const t = m.istInstant("2026-10-29", "09:15"); console.log(JSON.stringify([c.sessionAt("NFO", t).state, c.sessionAt("NFO", t - 60000).state, m.istDateOf(Date.parse("2026-10-29T19:00:00Z"))])); });`;
    const out = execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: tz }, encoding: "utf8" });
    expect(JSON.parse(out)).toEqual(["OPEN", "PRE_OPEN", "2026-10-30"]);
  });
});

