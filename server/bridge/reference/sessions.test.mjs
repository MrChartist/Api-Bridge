/**
 * The dated session rules and the special sessions (reference/data/sessions.json, special-sessions.json): what each date's
 * hours are, that every verified row names its circular and URL, and that an unverified row can never make the live-order
 * window longer than the floor.
 */
import { describe, expect, it } from "vitest";
import { createCalendar, istInstant, isIsoDate } from "./calendar.mjs";
import { closeOf, ruleFor, segmentOf, windowOfRule } from "./sessions.mjs";
import { SHIPPED_SESSIONS, SHIPPED_SPECIAL_SESSIONS, shippedSessionRules, shippedSpecialSessions } from "./shipped.mjs";

const at = (date, hhmm) => istInstant(date, hhmm);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

describe("the shipped session rules", () => {
  it("each row has dates, times and a verified flag, and a verified row names its circular, URL and the date it was read", () => {
    for (const r of SHIPPED_SESSIONS.rules) {
      expect(isIsoDate(r.from), r.id).toBe(true);
      if (r.to) expect(isIsoDate(r.to) && r.to >= r.from, r.id).toBe(true);
      for (const k of ["preOpen", "open", "close"]) expect(r[k], `${r.id}.${k}`).toMatch(HHMM);
      expect(["cash", "derivatives"]).toContain(r.segment);
      expect(typeof r.verified).toBe("boolean");
      if (r.verified) {
        expect(r.circular, r.id).toMatch(/SEBI\//);
        expect(r.source, r.id).toMatch(/^https:\/\//);
        expect(isIsoDate(r.readOn), r.id).toBe(true);
      } else {
        expect(r.circular).toBeNull();
      }
    }
  });

  it("a verified row's note never says the circular was not opened or read (the flag and the note agree)", () => {
    for (const r of SHIPPED_SESSIONS.rules) {
      if (r.verified) expect(r.note ?? "", r.id).not.toMatch(/\b(not|never|n't)\b[^.]{0,30}\b(opened|read)\b/i);
    }
  });

  it("the derivatives rows quote the paragraph they rest on: the 15:40 and 15:45 times and the expiring index wording", () => {
    const { rules } = shippedSessionRules();
    expect(ruleFor(rules, "NFO", "2026-08-03").note).toMatch(/3:40 p\.m\./);
    const dec = ruleFor(rules, "NFO", "2026-12-07").note;
    expect(dec).toMatch(/3:45 p\.m\./);
    expect(dec).toMatch(/expiry days.*expiring index derivatives contracts ceases at 3:30 p\.m\./);
  });

  it("the same derivatives rows with verified:false could not lengthen the live window past 15:30", () => {
    const { rules, gateFloor } = shippedSessionRules();
    for (const d of ["2026-08-03", "2026-12-07"]) {
      const row = { ...ruleFor(rules, "NFO", d), verified: false };
      const win = windowOfRule(row, gateFloor);
      expect(win.close).not.toBe("15:30"); // shown read-only as the data states it
      expect(win.gate.close).toBe("15:30");
      expect(closeOf(win, d, { gate: true, instrument: { kind: "stock", expiry: null } })).toBe("15:30");
    }
  });

  it("the rows of one segment follow each other without a gap or an overlap", () => {
    for (const seg of ["cash", "derivatives"]) {
      const rows = SHIPPED_SESSIONS.rules.filter((r) => r.segment === seg).sort((a, b) => (a.from < b.from ? -1 : 1));
      for (let i = 1; i < rows.length; i += 1) {
        const prev = rows[i - 1];
        expect(prev.to, `${prev.id} must end the day before ${rows[i].id}`).toBeTruthy();
        const next = new Date(Date.parse(`${prev.to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
        expect(next).toBe(rows[i].from);
      }
      expect(rows.at(-1).to ?? null).toBeNull();
    }
  });

  it("derivatives: 15:30 until 2 Aug 2026, 15:40 from 3 Aug (SEBI 2026-01-16), 15:45 from 7 Dec (SEBI 2026-10-15), expiring index contracts 15:30", () => {
    const { rules } = shippedSessionRules();
    const close = (d) => ruleFor(rules, "NFO", d).close;
    expect(close("2026-08-02")).toBe("15:30");
    expect(close("2026-08-03")).toBe("15:40");
    expect(close("2026-12-06")).toBe("15:40");
    expect(close("2026-12-07")).toBe("15:45");
    expect(ruleFor(rules, "NFO", "2026-12-07").expiringIndexClose).toBe("15:30");
    expect(ruleFor(rules, "NFO", "2026-12-06").expiringIndexClose).toBeUndefined();
    expect(ruleFor(rules, "BFO", "2026-12-07").close).toBe("15:45");
    expect(ruleFor(rules, "NFO", "2026-08-03")).toMatchObject({ verified: true, source: "https://www.sebi.gov.in/sebi_data/attachdocs/jan-2026/1768576287344.pdf" });
    expect(ruleFor(rules, "NFO", "2026-12-07")).toMatchObject({ verified: true, source: "https://www.sebi.gov.in/sebi_data/attachdocs/oct-2026/1792079571420.pdf" });
  });

  it("cash keeps 15:30 as the end of order entry in every period", () => {
    const { rules } = shippedSessionRules();
    for (const d of ["2026-01-05", "2026-08-03", "2026-12-07", "2027-03-01"]) expect(ruleFor(rules, "NSE", d).close).toBe("15:30");
  });

  it("segments: NSE/BSE cash, NFO/BFO derivatives, MCX and CDS are not in the table", () => {
    expect(["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"].map(segmentOf)).toEqual(["cash", "cash", "derivatives", "derivatives", null, null]);
    expect(ruleFor(shippedSessionRules().rules, "MCX", "2026-11-10")).toBeNull();
  });
});

describe("the gate window of an unverified rule", () => {
  const floor = { preOpen: "09:00", open: "09:15", close: "15:30" };
  const longer = { id: "t", segment: "derivatives", exchanges: ["NFO"], from: "2026-01-01", preOpen: "08:45", open: "09:00", close: "16:00", expiringIndexClose: "15:50", verified: false, circular: null, source: null, readOn: null };

  it("never opens earlier or closes later than the floor, whatever the unverified row says", () => {
    const w = windowOfRule(longer, floor);
    expect(w).toMatchObject({ close: "16:00", open: "09:00", verified: false });
    expect(w.gate).toEqual({ preOpen: "09:00", open: "09:15", close: "15:30", expiringIndexClose: "15:30" });
  });

  it("a verified row is used as it is, longer or not", () => {
    const w = windowOfRule({ ...longer, verified: true }, floor);
    expect(w.gate).toEqual({ preOpen: "08:45", open: "09:00", close: "16:00", expiringIndexClose: "15:50" });
  });

  it("an unverified row that is SHORTER than the floor still shortens the gate", () => {
    const w = windowOfRule({ ...longer, preOpen: "09:00", open: "09:30", close: "15:00", expiringIndexClose: null }, floor);
    expect(w.gate).toMatchObject({ open: "09:30", close: "15:00" });
  });

  it("a calendar built on such a rule refuses a live order after 15:30 but still shows the longer session read-only", () => {
    const cal = createCalendar({ holidays: [], rules: { gateFloor: floor, rules: [{ ...longer, exchanges: ["NFO", "BFO"] }] } });
    const t = at("2026-10-29", "15:45");
    expect(cal.sessionAt("NFO", t).state).toBe("OPEN");
    expect(cal.sessionAt("NFO", t, { gate: true }).state).toBe("CLOSED");
    expect(cal.sessionAt("NFO", at("2026-10-29", "15:29"), { gate: true }).state).toBe("OPEN");
    expect(cal.windowFor("NFO", "2026-10-29")).toMatchObject({ close: "16:00", verified: false });
  });
});

describe("the close of one contract", () => {
  const { rules, gateFloor } = shippedSessionRules();
  const win = windowOfRule(ruleFor(rules, "NFO", "2026-12-08"), gateFloor);

  it("from 7 Dec 2026 an index contract expiring that day stops at 15:30 for the gate; stock and later expiries run to 15:45", () => {
    const g = (instrument) => closeOf(win, "2026-12-08", { gate: true, instrument });
    expect(g({ kind: "index", expiry: "2026-12-08" })).toBe("15:30");
    expect(g({ kind: "index", expiry: "2026-12-15" })).toBe("15:45");
    expect(g({ kind: "stock", expiry: "2026-12-08" })).toBe("15:45");
    // Unknown contract: the earlier close, never the later one.
    expect(g(null)).toBe("15:30");
    expect(g({ kind: null, expiry: null })).toBe("15:30");
    expect(closeOf(win, "2026-12-08", { gate: false })).toBe("15:45");
  });

  it("before 7 Dec every derivative runs to 15:40", () => {
    const w = windowOfRule(ruleFor(rules, "NFO", "2026-11-10"), gateFloor);
    expect(closeOf(w, "2026-11-10", { gate: true, instrument: { kind: "index", expiry: "2026-11-10" } })).toBe("15:40");
  });

  it("calendar.expiryCloseFor is the read-only version", () => {
    const cal = createCalendar({ holidays: [] });
    expect(cal.expiryCloseFor("NFO", "2026-11-10", "index")).toBe("15:40");
    expect(cal.expiryCloseFor("NFO", "2026-12-08", "index")).toBe("15:30");
    expect(cal.expiryCloseFor("NFO", "2026-12-08", "stock")).toBe("15:45");
    expect(cal.expiryCloseFor("NSE", "2026-12-08", "index")).toBe("15:30");
  });
});

describe("special sessions", () => {
  const cal = createCalendar({ holidays: [], specialSessions: shippedSpecialSessions() });

  it("the data file is dated, and every row says whether its timing is verified; a verified row names its source", () => {
    expect(SHIPPED_SPECIAL_SESSIONS.sessions.map((s) => s.date)).toEqual(["2025-02-01", "2025-10-21", "2026-02-01", "2026-11-08"]);
    for (const s of SHIPPED_SPECIAL_SESSIONS.sessions) {
      expect(typeof s.verified).toBe("boolean");
      expect(s.open).toMatch(HHMM);
      expect(s.close).toMatch(HHMM);
      if (s.verified) expect(s.source, s.date).toMatch(/^https:\/\//);
    }
    // Nothing in the file was read in an exchange circular, so none is marked verified.
    expect(SHIPPED_SPECIAL_SESSIONS.sessions.filter((s) => s.verified)).toEqual([]);
  });

  it("the Muhurat Sunday is a trading day with its own hours and never reads as Weekend", () => {
    expect(cal.isTradingDay("2026-11-08", "NFO")).toBe(true);
    expect(cal.isTradingDay("2026-02-01", "NSE")).toBe(true);
    for (const hhmm of ["08:00", "12:00", "14:10", "16:00"]) {
      const s = cal.sessionAt("NSE", at("2026-11-08", hhmm));
      expect(s.label, hhmm).not.toBe("Weekend");
      expect(s.state).toBe("CLOSED");
    }
    expect(cal.sessionAt("NSE", at("2026-11-08", "12:00")).label).toMatch(/Muhurat trading opens at 14:20 IST \(timing unverified\)/);
  });

  it("read-only: SPECIAL inside the window with the unverified flag; for a live order: closed, with the reason", () => {
    const t = at("2026-11-08", "14:30");
    const read = cal.sessionAt("NFO", t);
    expect(read.state).toBe("SPECIAL");
    expect(read.special).toMatchObject({ verified: false, open: "14:20", close: "15:30" });
    expect(read.label).toMatch(/timing unverified/);
    const gate = cal.sessionAt("NFO", t, { gate: true });
    expect(gate).toMatchObject({ state: "CLOSED", unverifiedSpecial: true });
    expect(gate.label).toMatch(/not verified, so live orders are refused/);
  });

  it("a special session whose timing is verified opens the gate", () => {
    const verified = createCalendar({ holidays: [], specialSessions: { "2026-11-08": { ...shippedSpecialSessions()["2026-11-08"], verified: true } } });
    expect(verified.sessionAt("NFO", at("2026-11-08", "14:30"), { gate: true }).state).toBe("SPECIAL");
    expect(verified.sessionAt("NFO", at("2026-11-08", "15:30"), { gate: true }).state).toBe("CLOSED");
  });

  it("the calendar's special-session rows carry pre-open and CAS times for the Muhurat session", () => {
    expect(cal.specialOn("2026-11-08", "NSE")).toMatchObject({ preOpen: "14:05", cas: { start: "15:20", end: "15:35" }, verified: false });
  });

  it("a derivatives close for a special session applies to NFO and BFO only", () => {
    const c = createCalendar({ holidays: [], specialSessions: { "2026-11-08": { open: "14:20", close: "15:30", derivativesClose: "15:45", label: "X", verified: true } } });
    expect(c.specialOn("2026-11-08", "NSE").close).toBe("15:30");
    expect(c.specialOn("2026-11-08", "NFO").close).toBe("15:45");
  });
});
