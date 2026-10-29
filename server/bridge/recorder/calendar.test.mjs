/**
 * Recorder slot calendar (docs/spec/p1-01-recorder.md §6.1, §6.13): 375/75 slots, weekends, holidays and a Muhurat
 * window from a reference fake, IST on any host time zone, and the holiday detector.
 */
import { describe, expect, it } from "vitest";
import { createCalendar } from "../reference/calendar.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { cadenceAt, dayPlan, expectedMinutesBetween, expectedSlotsBy, holidaySuspected, isDue, istDateOf, nextSlotAfter, resolveDay, slotIndex, slotsOfDay } from "./calendar.mjs";

const IST = (s) => Date.parse(`${s}+05:30`);

/** A reference fake over the real calendar maths: one listed holiday and a Sunday Muhurat session. */
function fakeReference() {
  const cal = createCalendar({
    holidays: [{ date: "2026-11-24", exchanges: ["NSE", "BSE"], label: "Guru Nanak Jayanti", verified: true }],
    specialSessions: { "2026-11-08": { open: "18:00", close: "19:00", label: "Muhurat trading", exchanges: ["NSE", "BSE"] } },
  });
  return {
    session: (exchange, t) => {
      const s = cal.sessionAt(exchange, t);
      return { ...s, tradingDay: cal.isTradingDay(s.date, exchange) };
    },
    calendar: () => ({ isTradingDay: cal.isTradingDay, prevTradingDay: cal.prevTradingDay, holidays: cal.holidays }),
  };
}

describe("slots", () => {
  const plan = dayPlan({ date: "2026-10-29", open: "09:15", close: "15:30" });
  it("a full day has 375 index slots (09:15–15:29) and 75 stock slots at 5 minutes", () => {
    const idx = slotsOfDay(plan, "index");
    expect(idx).toHaveLength(375);
    expect(idx[0]).toBe(IST("2026-10-29T09:15:00"));
    expect(idx.at(-1)).toBe(IST("2026-10-29T15:29:00"));
    const st = slotsOfDay(plan, "stock", 5);
    expect(st).toHaveLength(75);
    expect(st[1]).toBe(IST("2026-10-29T09:20:00"));
    expect(st.at(-1)).toBe(IST("2026-10-29T15:25:00"));
    expect(slotsOfDay(plan, "stock", 15)).toHaveLength(25);
  });
  it("§6.1: at 10:15:30 IST, 61 index slots are expected; 13 stock slots", () => {
    expect(expectedSlotsBy(plan, IST("2026-10-29T10:15:30"), "index")).toBe(61);
    expect(expectedSlotsBy(plan, IST("2026-10-29T10:15:30"), "stock", 5)).toBe(13);
    expect(expectedSlotsBy(plan, IST("2026-10-29T18:00:00"), "index")).toBe(375);
    expect(slotIndex(plan, IST("2026-10-29T10:15:30"))).toBe(60);
    expect(slotIndex(plan, IST("2026-10-29T15:30:00"))).toBeNull();
  });
  it("nothing is due outside the session; next slot rolls over", () => {
    expect(isDue(plan, IST("2026-10-29T15:30:00"), "index")).toBe(false);
    expect(isDue(plan, IST("2026-10-29T09:14:00"), "index")).toBe(false);
    expect(nextSlotAfter(plan, IST("2026-10-29T08:00:00"))).toBe(IST("2026-10-29T09:15:00"));
    expect(nextSlotAfter(plan, IST("2026-10-29T10:15:02"))).toBe(IST("2026-10-29T10:16:00"));
    expect(nextSlotAfter(plan, IST("2026-10-29T15:29:10"))).toBeNull();
  });
  it("demo always-open: 1-minute slots 09:15–15:30 and 5-minute slots outside", () => {
    const demo = dayPlan({ date: "2026-10-31", open: "09:15", close: "15:30", alwaysOpen: true });
    const idx = slotsOfDay(demo, "index");
    expect(idx).toHaveLength(375 + (24 * 60 - 375) / 5);
    expect(isDue(demo, IST("2026-10-31T03:05:00"), "index")).toBe(true);
    expect(isDue(demo, IST("2026-10-31T03:06:00"), "index")).toBe(false);
    expect(isDue(demo, IST("2026-10-31T10:01:00"), "index")).toBe(true);
    expect(isDue(demo, IST("2026-10-31T10:01:00"), "stock", 5)).toBe(false);
    expect(isDue(demo, IST("2026-10-31T10:05:00"), "stock", 5)).toBe(true);
  });
  it("minutes, not slots: each due slot counts its cadence (5-minute chains, the demo's 5-minute night)", () => {
    const demo = dayPlan({ date: "2026-10-31", open: "09:15", close: "15:30", alwaysOpen: true });
    expect(cadenceAt(demo, IST("2026-10-31T00:45:00"), "index")).toBe(5);
    expect(cadenceAt(demo, IST("2026-10-31T10:01:00"), "index")).toBe(1);
    expect(cadenceAt(demo, IST("2026-10-31T10:05:00"), "stock", 5)).toBe(5);
    expect(cadenceAt(demo, IST("2026-10-31T00:45:00"), "stock", 15)).toBe(15);
    // 00:00–00:45 at 5-minute slots: 10 slots that stand for 50 minutes.
    const midnight = IST("2026-10-31T00:00:00");
    expect(expectedSlotsBy(demo, IST("2026-10-31T00:45:30"), "index") - expectedSlotsBy(demo, midnight - 1, "index")).toBe(10);
    expect(expectedMinutesBetween(demo, midnight, IST("2026-10-31T00:45:30"), "index")).toBe(50);
    // A stock at 5 minutes from 09:15 to 10:15 in a real session: 13 slots, 65 minutes (the last slot runs to 10:20).
    const plan = dayPlan({ date: "2026-10-29", open: "09:15", close: "15:30" });
    expect(expectedMinutesBetween(plan, IST("2026-10-29T09:15:00"), IST("2026-10-29T10:15:30"), "stock", 5)).toBe(65);
    expect(expectedMinutesBetween(plan, IST("2026-10-29T09:15:00"), IST("2026-10-29T10:15:30"), "index")).toBe(61);
  });
  it("IST dates on any host time zone", () => {
    expect(istDateOf(Date.parse("2026-10-29T19:00:00Z"))).toBe("2026-10-30");
    expect(istDateOf(Date.parse("2026-10-29T18:29:59Z"))).toBe("2026-10-29");
  });
});

describe("resolveDay over the reference calendar", () => {
  const reference = fakeReference();
  it("a weekday is a trading day with the reference window", () => {
    const d = resolveDay({ reference, t: IST("2026-10-29T11:00:00") });
    expect(d).toMatchObject({ date: "2026-10-29", tradingDay: true, calendarSource: "reference" });
    expect(slotsOfDay(d.plan, "index")).toHaveLength(375);
  });
  it("weekend and the listed holiday write nothing", () => {
    expect(resolveDay({ reference, t: IST("2026-10-31T11:00:00") })).toMatchObject({ tradingDay: false, plan: null, reason: "weekend" });
    expect(resolveDay({ reference, t: IST("2026-11-24T11:00:00") })).toMatchObject({ tradingDay: false, plan: null, reason: "holiday" });
  });
  it("a Muhurat session with times records its own window, unless switched off", () => {
    const d = resolveDay({ reference, t: IST("2026-11-08T18:30:00") });
    expect(d.tradingDay).toBe(true);
    expect(slotsOfDay(d.plan, "index")).toHaveLength(60);
    expect(resolveDay({ reference, t: IST("2026-11-08T18:30:00"), recordSpecialSessions: false })).toMatchObject({ tradingDay: false, reason: "special-session-off" });
  });
  it("without reference data: weekdays only, labelled", () => {
    const stub = notImplementedService("reference");
    expect(resolveDay({ reference: stub, t: IST("2026-11-24T11:00:00") })).toMatchObject({ tradingDay: true, calendarSource: "weekdays only (reference data not loaded)" });
    expect(resolveDay({ reference: stub, t: IST("2026-11-01T11:00:00") }).tradingDay).toBe(false);
  });
  it("demo always-open treats every day as a trading day", () => {
    expect(resolveDay({ reference, t: IST("2026-11-01T02:00:00"), alwaysOpen: true })).toMatchObject({ tradingDay: true, calendarSource: "demo-always-open" });
  });
});

describe("holiday detector (§6.13)", () => {
  const flat = [25000, 25000, 25000, 25000, 25000, 25000];
  it("flat spot and zero (or unchanged) volume on every chain → suspected", () => {
    expect(holidaySuspected([{ spots: flat, volume: 0 }, { spots: [5, 5, 5, 5, 5, 5], volume: 900, prevVolume: 900 }])).toBe(true);
  });
  it("any moving spot, any new volume, missing data or no chains → not suspected", () => {
    expect(holidaySuspected([{ spots: [...flat.slice(0, 5), 25000.05], volume: 0 }])).toBe(false);
    expect(holidaySuspected([{ spots: flat, volume: 10, prevVolume: 9 }])).toBe(false);
    expect(holidaySuspected([{ spots: flat.slice(0, 5), volume: 0 }])).toBe(false);
    expect(holidaySuspected([{ spots: [...flat.slice(0, 5), null], volume: 0 }])).toBe(false);
    expect(holidaySuspected([{ spots: flat, volume: null, prevVolume: null }])).toBe(false);
    expect(holidaySuspected([])).toBe(false);
    expect(holidaySuspected([{ spots: flat, volume: 0 }, { spots: [1, 2, 3, 4, 5, 6], volume: 0 }])).toBe(false);
  });
});
