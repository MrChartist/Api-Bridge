import { describe, expect, it } from "vitest";
import { addDays, weekdayOf } from "../reference/calendar.mjs";
import { demoHasFile, demoParticipantDay, demoRevisions, weekdayIndex } from "./demo.mjs";
import { createFakeParticipants } from "./fake.mjs";
import { longPct } from "./metrics.mjs";
import { INSTRUMENTS, PARTICIPANTS, validateTotals } from "./parser.mjs";

/** Weekdays from `from` back over n calendar days. */
function weekdays(from, n) {
  const out = [];
  for (let d = from, i = 0; i < n; i += 1, d = addDays(d, -1)) if (weekdayOf(d) !== 0 && weekdayOf(d) !== 6) out.push(d);
  return out;
}
const DAYS = weekdays("2026-10-28", 760);

describe("demo participant OI (§5.3)", () => {
  it("is deterministic per date", () => {
    expect(demoParticipantDay("2026-10-28")).toEqual(demoParticipantDay("2026-10-28"));
    expect(demoParticipantDay("2026-10-28")).not.toEqual(demoParticipantDay("2026-10-27"));
  });

  it("balances exactly: Σ long = Σ short = TOTAL for every instrument and day, all whole and ≥ 0", () => {
    for (const d of DAYS) {
      const day = demoParticipantDay(d);
      if (!day) continue;
      expect(validateTotals(day.rows).quality).toBe("ok");
      for (const p of [...PARTICIPANTS, "TOTAL"]) for (const x of INSTRUMENTS) for (const v of day.rows[p][x]) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("stays in the documented ranges", () => {
    let lo = 100;
    let hi = 0;
    for (const d of DAYS) {
      const day = demoParticipantDay(d);
      if (!day) continue;
      const t = day.rows.TOTAL;
      expect(t.IDX_FUT[0]).toBeGreaterThanOrEqual(320000);
      expect(t.IDX_FUT[0]).toBeLessThanOrEqual(460000);
      expect(t.STK_FUT[0]).toBeGreaterThanOrEqual(1800000);
      expect(t.STK_FUT[0]).toBeLessThanOrEqual(2400000);
      for (const x of ["STK_CE", "STK_PE"]) {
        expect(t[x][0]).toBeGreaterThanOrEqual(600000);
        expect(t[x][0]).toBeLessThanOrEqual(1400000);
      }
      const p = longPct(...day.rows.FII.IDX_FUT);
      lo = Math.min(lo, p);
      hi = Math.max(hi, p);
    }
    expect(lo).toBeGreaterThanOrEqual(16);
    expect(lo).toBeLessThan(22);
    expect(hi).toBeLessThanOrEqual(66);
    expect(hi).toBeGreaterThan(60);
  });

  it("weekends and every 30th weekday have no file, so gaps show", () => {
    expect(demoParticipantDay("2026-10-31")).toBeNull();
    expect(demoParticipantDay("2026-11-01")).toBeNull();
    const gaps = DAYS.filter((d) => !demoHasFile(d));
    expect(gaps.length).toBeGreaterThan(15);
    for (const g of gaps) expect(weekdayIndex(g) % 30).toBe(17);
  });

  it("one synthetic revision on 1 Jan of the current year", () => {
    expect(demoRevisions("2026-10-28")).toEqual([{ date: "2026-01-01", regime: "2026-01", text: expect.stringMatching(/not like for like/) }]);
  });

  it("the fake service (for P1-8 tests) answers the same CE/PE rows as the generator", () => {
    const l = createFakeParticipants({ asOfDate: "2026-10-28" }).latest({ exchange: "NSE" });
    const day = demoParticipantDay("2026-10-28");
    const fiiCe = l.rows.find((r) => r.participant === "FII" && r.instrument === "IDX_CE");
    expect([fiiCe.long, fiiCe.short]).toEqual(day.rows.FII.IDX_CE);
    expect(l.rows).toHaveLength(24);
  });
});
