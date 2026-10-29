/**
 * Demo history seeding (docs/spec/p1-03-pricing-vol.md §4.2, §9.2): 300 trading days with 34 live days and one missed
 * day; the same date gives the same history; demo IV runs above HV20 on average; IV rank travels from under 10 to
 * over 90; demo IV stays within 6–60 %; the demo INDIA VIX tracks NIFTY's 30-day calendar IV; back-fill days go
 * through the real proxy.mjs, live days through the real capture.mjs.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ivRank } from "../dashboard/pricing.js";
import { defaultOptionExchange } from "../market/chain.mjs";
import { demoCalendar } from "../reference/demoTables.mjs";
import { clockSettings } from "./config.mjs";
import { buildClockContext, holidayDates } from "./context.mjs";
import { DEMO_DAYS, MISSED_DAY, seedDemoHistory, tradingDaysBefore } from "./demoVol.mjs";
import { createVolStore } from "./store.mjs";

const TODAY = "2026-10-29";
const cal = demoCalendar();
const ctxFor = (exchange) => buildClockContext({ settings: clockSettings(null), session: { open: "09:15", close: "15:30" }, holidays: holidayDates(cal.holidays, exchange), rate: { value: 0.065, quality: "default" } });
const STEPS = { NIFTY: 50, BANKNIFTY: 100, SENSEX: 100 };

async function seed(underlyings) {
  const store = createVolStore({ root: mkdtempSync(join(tmpdir(), "mcb-vol-demo-")) });
  store.load();
  const report = await seedDemoHistory({ store, ctxFor, today: TODAY, isTradingDay: (d, e) => cal.isTradingDay(d, e), exchangeOf: defaultOptionExchange, stepOf: (u) => STEPS[u], underlyings, session: { open: "09:15", close: "15:30" } });
  await store.flush();
  return { store, report };
}

describe("demo vol history", () => {
  let a;
  beforeAll(async () => {
    a = await seed(["NIFTY", "BANKNIFTY", "SENSEX"]);
  }, 30_000);

  it("300 trading days: 34 live, one missed (BRIDGE_OFF), the rest back-filled", () => {
    const days = tradingDaysBefore(TODAY, DEMO_DAYS, (d) => cal.isTradingDay(d, "NFO"));
    const sums = a.store.summaries("NIFTY");
    expect(sums).toHaveLength(300);
    expect(sums.at(-1).date).toBe(days[0]);
    expect(sums[0].date).toBe(days.at(-1));
    expect(sums.filter((r) => r.quality === "live")).toHaveLength(34);
    expect(sums.filter((r) => r.quality === "backfill-eod")).toHaveLength(265);
    expect(sums.filter((r) => r.missed)).toEqual([{ v: 1, underlying: "NIFTY", date: days[MISSED_DAY - 1], missed: true, reason: "BRIDGE_OFF", quality: null }]);
    expect(a.report).toMatchObject({ liveDays: 34, backfillDays: 265 });
    // Live rows came through capture.mjs (smile points, bands), back-fill rows through proxy.mjs (futures forward).
    const idx = a.store.readExpiryRows("NIFTY");
    const live = idx.filter((r) => r.quality === "live");
    const bf = idx.filter((r) => r.quality === "backfill-eod");
    expect(live[0]).toMatchObject({ source: "demo", trigger: "scheduled", forwardSource: "parity" });
    expect(live[0].band1).toHaveLength(2);
    expect(bf[0]).toMatchObject({ source: "demo", trigger: "backfill", forwardSource: "future" });
    expect(Object.keys(bf[0].contracts).length).toBeGreaterThanOrEqual(2);
    // Every day has a 30-day figure and VIX; predictions exist for live days only.
    expect(sums.filter((r) => !r.missed && r.cm30.weighted === null)).toEqual([]);
    expect(a.store.vixRows()).toHaveLength(300);
    const preds = a.store.readPredictions({ from: "2025-01-01", to: TODAY });
    expect(new Set(preds.map((p) => p.ts.slice(0, 10))).size).toBe(34 * 1);
  });

  it("is deterministic for the same date", async () => {
    const b = await seed(["NIFTY"]);
    expect(b.store.summaries("NIFTY")).toEqual(a.store.summaries("NIFTY"));
  }, 30_000);

  it("IV above HV20 on average, inside 6–60 %, and IV rank travels from under 10 to over 90", () => {
    for (const u of ["NIFTY", "BANKNIFTY", "SENSEX"]) {
      const sums = a.store.summaries(u).filter((r) => !r.missed && r.cm30.weighted !== null);
      const iv = sums.map((r) => r.cm30.weighted);
      expect(Math.min(...iv), u).toBeGreaterThanOrEqual(6);
      expect(Math.max(...iv), u).toBeLessThanOrEqual(60);
      const prem = sums.map((r) => r.cm30.weighted - r.hv.cc20);
      expect(prem.reduce((x, y) => x + y, 0) / prem.length, u).toBeGreaterThan(0);
      const ranks = [];
      for (let i = 60; i < iv.length; i++) ranks.push(ivRank(iv.slice(Math.max(0, i - 252), i), iv[i]).ivr);
      expect(Math.min(...ranks), u).toBeLessThan(10);
      expect(Math.max(...ranks), u).toBeGreaterThan(90);
    }
  });

  it("the demo INDIA VIX tracks NIFTY's 30-day IV on calendar time", () => {
    const live = a.store.summaries("NIFTY").filter((r) => r.quality === "live");
    for (const r of live) {
      const ratio = r.vix.value / r.cm30.calendar;
      expect(ratio, r.date).toBeGreaterThan(0.95);
      expect(ratio, r.date).toBeLessThan(1.1);
    }
  });
});
