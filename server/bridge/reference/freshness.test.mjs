/**
 * Data freshness: the doctor warning and the readiness sentences, and the honesty of the shipped data files (every
 * asOf is a date, a verified flag never has an empty source, the freeze and charge tables keep their old numbers).
 */
import { describe, expect, it } from "vitest";
import { REF_DEFAULTS } from "../dashboard/reference.js";
import { referenceDoctorChecks } from "./doctor.mjs";
import { MAX_AGE_MONTHS, monthsBefore, referenceFreshness } from "./freshness.mjs";
import { SHIPPED_CHARGES, SHIPPED_DELIVERY_MARGIN, SHIPPED_FREEZE, SHIPPED_HOLIDAYS, SHIPPED_SESSIONS, SHIPPED_SPECIAL_SESSIONS } from "./shipped.mjs";

const at = (date) => Date.parse(`${date}T10:00:00+05:30`);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const fresh = (over = {}) => ({
  holidays: { asOf: "2026-11-10", years: { 2026: [{ date: "2026-01-26" }], 2027: [{ date: "2027-01-26" }] } },
  sessions: { asOf: "2026-11-10" },
  specials: { asOf: "2026-11-10" },
  charges: { asOf: "2026-11-01", groups: { stt: { asOf: "2026-11-01" } } },
  delivery: { asOf: "2026-11-01" },
  freeze: { entries: { "NFO:NIFTY": { asOf: "2026-11-02" } } },
  ...over,
});

describe("monthsBefore", () => {
  it("goes back whole calendar months and clamps the day", () => {
    expect(monthsBefore("2026-11-10", 6)).toBe("2026-05-10");
    expect(monthsBefore("2026-08-31", 6)).toBe("2026-02-28");
    expect(monthsBefore("2026-03-15", 6)).toBe("2025-09-15");
    expect(MAX_AGE_MONTHS).toBe(6);
  });
});

describe("referenceFreshness", () => {
  it("all current and next year covered: nothing to warn about", () => {
    const r = referenceFreshness({ now: at("2026-11-10"), data: fresh() });
    expect(r).toMatchObject({ level: "ok", today: "2026-11-10", summary: "Reference data is current" });
    expect(r.items.every((i) => i.level === "ok")).toBe(true);
  });

  it("warns when the calendar has no rows for next year, in plain words", () => {
    const d = fresh({ holidays: { asOf: "2026-11-10", years: { 2026: [{ date: "2026-01-26" }] } } });
    const r = referenceFreshness({ now: at("2026-11-10"), data: d });
    const w = r.items.find((i) => i.id === "calendar-next-year");
    expect(w.level).toBe("warn");
    expect(w.message).toMatch(/no rows for 2027 yet.*treated as ordinary weekdays.*not verified.*December/);
    expect(r.level).toBe("warn");
  });

  it("a calendar with no rows for this year is called out harder", () => {
    const r = referenceFreshness({ now: at("2027-02-01"), data: fresh({ holidays: { asOf: "2026-11-10", years: { 2026: [{ date: "2026-01-26" }] } } }) });
    expect(r.items.find((i) => i.id === "calendar-year").message).toMatch(/no rows for 2027, so every weekday this year is treated as a trading day/);
  });

  it("warns for any asOf older than six months, naming the file's weakest part", () => {
    const d = fresh({ charges: { asOf: "2026-02-28", groups: { nseTransactionCharges: { asOf: "2026-02-28" }, stt: { asOf: "2026-04-01" } } }, delivery: { asOf: "2026-05-10" } });
    const r = referenceFreshness({ now: at("2026-11-10"), data: d });
    const charges = r.items.find((i) => i.id === "asof-charges");
    expect(charges.level).toBe("warn");
    expect(charges.message).toMatch(/Statutory charges: as of 2026-02-28 \(8 months ago, older than 6 months; oldest group: nseTransactionCharges\)/);
    // Exactly six months old is still fine; a day older is not.
    expect(r.items.find((i) => i.id === "asof-delivery-margin").level).toBe("ok");
    const r2 = referenceFreshness({ now: at("2026-11-11"), data: d });
    expect(r2.items.find((i) => i.id === "asof-delivery-margin").level).toBe("warn");
  });

  it("a file with no asOf is reported as of unknown age", () => {
    const r = referenceFreshness({ now: at("2026-11-10"), data: fresh({ sessions: {} }) });
    expect(r.items.find((i) => i.id === "asof-sessions").message).toMatch(/no asOf date/);
  });

  it("the shipped data today: next year missing, and the old charge, freeze and delivery-margin figures are called out", () => {
    const r = referenceFreshness({ now: at("2026-11-10") });
    const warned = r.items.filter((i) => i.level === "warn").map((i) => i.id);
    expect(warned).toEqual(["calendar-next-year", "asof-freeze-quantities", "asof-charges", "asof-delivery-margin"]);
    expect(r.items.find((i) => i.id === "asof-freeze-quantities").message).toMatch(/oldest: SENSEX, BANKEX/);
    expect(r.items.find((i) => i.id === "asof-sessions").level).toBe("ok");
  });
});

describe("mc-bridge doctor", () => {
  it("one warning per stale item, each with the fix", () => {
    const lines = referenceDoctorChecks({ now: at("2026-11-10") });
    expect(lines.every((l) => l.level === "warn")).toBe(true);
    expect(lines.map((l) => l.check)).toContain("reference-data:calendar-next-year");
    expect(lines.find((l) => l.check === "reference-data:calendar-next-year").fix).toMatch(/docs\/reference-data\.md/);
  });

  it("an ok line when everything is current", () => {
    expect(referenceDoctorChecks({ now: at("2026-11-10"), data: fresh() })).toEqual([{ level: "ok", check: "reference-data", message: "Reference data is current (7 items checked)." }]);
  });
});

describe("the shipped data files are honest", () => {
  it("every file has an asOf date, and a verified row names where it was read", () => {
    for (const [name, f] of Object.entries({ holidays: SHIPPED_HOLIDAYS, sessions: SHIPPED_SESSIONS, specials: SHIPPED_SPECIAL_SESSIONS, charges: SHIPPED_CHARGES, delivery: SHIPPED_DELIVERY_MARGIN })) {
      expect(f.asOf, name).toMatch(DATE);
    }
    for (const [k, e] of Object.entries(SHIPPED_FREEZE.entries)) {
      expect(e.asOf, k).toMatch(DATE);
      expect(typeof e.verified).toBe("boolean");
      if (e.verified) expect(e.source && e.readOn, k).toBeTruthy();
    }
    for (const [y, s] of Object.entries(SHIPPED_HOLIDAYS.sources)) {
      expect(typeof s.verified).toBe("boolean");
      if (s.verified) expect(s.circulars.length && s.url && s.readOn, y).toBeTruthy();
    }
  });

  it("a holiday row is marked verified only for a year whose circular was read", () => {
    for (const [year, rows] of Object.entries(SHIPPED_HOLIDAYS.years)) {
      for (const r of rows) expect(r.verified, `${r.date}`).toBe(SHIPPED_HOLIDAYS.sources[year].verified);
    }
  });

  it("2026-01-15 is a holiday (NSE/CMTR/72260) and its amendment is recorded", () => {
    const row = SHIPPED_HOLIDAYS.years["2026"].find((r) => r.date === "2026-01-15");
    expect(row).toMatchObject({ label: "Municipal Corporation Election in Maharashtra", exchanges: ["NSE", "BSE"], verified: true });
    expect(SHIPPED_HOLIDAYS.amendments[0]).toMatchObject({ circular: expect.stringContaining("NSE/CMTR/72260"), date: "2026-01-12", readOn: "2026-11-10" });
  });

  it("freeze quantities keep the figures that were here before: nothing changed without a primary source", () => {
    const q = Object.fromEntries(Object.entries(SHIPPED_FREEZE.entries).map(([k, e]) => [k, e.freezeQty]));
    expect(q).toEqual({ "NFO:NIFTY": 1800, "NFO:BANKNIFTY": 900, "NFO:FINNIFTY": 1800, "NFO:MIDCPNIFTY": 2800, "NFO:NIFTYNXT50": 600, "BFO:SENSEX": 1000, "BFO:BANKEX": 900 });
    expect(Object.values(SHIPPED_FREEZE.entries).every((e) => e.verified === false)).toBe(true);
  });

  it("the statutory charge rates are the old ones, none verified, and the newer NSE rates sit as pending, not applied", () => {
    expect(SHIPPED_CHARGES.opt.txn.NSE).toBe(0.0003503);
    expect(SHIPPED_CHARGES.fut.txn.NSE).toBe(0.0000173);
    expect(SHIPPED_CHARGES.physical.txn.NSE).toBe(0.0000297);
    expect(SHIPPED_CHARGES.ipftPerCrore).toBe(0);
    expect(SHIPPED_CHARGES.groups.nseTransactionCharges).toMatchObject({ verified: false, stale: true, asOf: "2026-02-28", pending: { "opt.txn.NSE": 0.0003553, "fut.txn.NSE": 0.0000183, "physical.txn.NSE": 0.0000307 } });
    for (const [g, v] of Object.entries(SHIPPED_CHARGES.groups)) {
      expect(v.verified, g).toBe(false);
      expect(v.asOf, g).toMatch(DATE);
    }
    // The table is only as new as its oldest group.
    expect(SHIPPED_CHARGES.asOf).toBe(Object.values(SHIPPED_CHARGES.groups).map((g) => g.asOf).sort()[0]);
  });

  it("the dashboard's own copy of the charge table agrees with the shipped file", () => {
    const d = REF_DEFAULTS.charges;
    expect(d.asOf).toBe(SHIPPED_CHARGES.asOf);
    expect(d.opt).toEqual(SHIPPED_CHARGES.opt);
    expect(d.fut).toEqual(SHIPPED_CHARGES.fut);
    expect(d.sebiPerCrore).toBe(SHIPPED_CHARGES.sebiPerCrore);
    expect(d.ipftPerCrore).toBe(SHIPPED_CHARGES.ipftPerCrore);
    expect(d.gst).toBe(SHIPPED_CHARGES.gst);
  });
});
