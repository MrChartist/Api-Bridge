import { describe, expect, it } from "vitest";
import { createCalendar } from "../reference/calendar.mjs";
import { BYTES_PER_ROW, barsPerTradingDay, estimateSize, parseDays, parseIntervals, tradingDaysIn } from "./estimate.mjs";
import { at } from "./__fixtures__/fakes.mjs";

const cal = createCalendar({ holidays: [{ date: "2026-11-10", label: "Test", exchanges: ["NSE"], verified: true }] });
const NOW = at("2026-11-09T11:00:00+05:30"); // Monday

describe("bars per trading day (375-minute session)", () => {
  it.each([
    ["1m", 375],
    ["3m", 125],
    ["5m", 75],
    ["10m", 38],
    ["15m", 25],
    ["30m", 13],
    ["60m", 7],
    ["1d", 1],
    ["1w", 0.2],
  ])("%s -> %f", (i, n) => expect(barsPerTradingDay(i)).toBeCloseTo(n, 5));
});

describe("trading days", () => {
  it("counts weekdays that are not holidays in the calendar days ending today", () => {
    // 7 days back from Mon 9 Nov: Tue 3 .. Mon 9 -> 5 weekdays (Tue Wed Thu Fri Mon)
    expect(tradingDaysIn(7, "2026-11-09", cal)).toBe(5);
    // 14 days: Tue 27 Oct .. Mon 9 Nov -> 10 weekdays; the holiday is in the future of today so not counted
    expect(tradingDaysIn(14, "2026-11-09", cal)).toBe(10);
    expect(tradingDaysIn(14, "2026-11-16", cal)).toBe(9); // now the holiday (Tue 10 Nov) is inside the window
  });
});

describe("estimateSize", () => {
  it("rows, bytes and broker calls for symbols x intervals x days", () => {
    const e = estimateSize({ symbols: 10, intervals: ["5m", "1d"], days: 7, nowMs: NOW, cal });
    expect(e.tradingDays).toBe(5);
    expect(e.perInterval).toEqual([
      { interval: "5m", barsPerSymbol: 375, rows: 3750, bytes: 3750 * BYTES_PER_ROW, brokerCalls: 10 },
      { interval: "1d", barsPerSymbol: 5, rows: 50, bytes: 50 * BYTES_PER_ROW, brokerCalls: 10 },
    ]);
    expect(e.rows).toBe(3800);
    expect(e.bytes).toBe(3800 * BYTES_PER_ROW);
    expect(e.brokerCalls).toBe(20);
    expect(e.notes.join(" ")).toMatch(/An estimate/);
  });

  it("a long intraday range needs one broker call per 60-day chunk, a long daily range far fewer", () => {
    const e = estimateSize({ symbols: 3, intervals: ["1m", "1d"], days: 365, nowMs: NOW, cal });
    expect(e.perInterval[0].brokerCalls).toBe(3 * Math.ceil(365 / 60));
    expect(e.perInterval[1].brokerCalls).toBe(3);
  });

  it("weekly and monthly bars are built from daily candles: daily call counts", () => {
    const e = estimateSize({ symbols: 1, intervals: ["1w", "1M"], days: 3000, nowMs: NOW, cal });
    expect(e.perInterval.map((p) => p.brokerCalls)).toEqual([2, 2]);
  });

  it("zero symbols is zero rows", () => {
    expect(estimateSize({ symbols: 0, intervals: ["5m"], days: 7, nowMs: NOW, cal }).rows).toBe(0);
  });
});

describe("input checks", () => {
  it("intervals: a list or a comma string, known ones only, no repeats", () => {
    expect(parseIntervals("5m, 1d,5m")).toEqual(["5m", "1d"]);
    expect(parseIntervals(["15m"])).toEqual(["15m"]);
    expect(() => parseIntervals("")).toThrow(/at least one/);
    expect(() => parseIntervals("5m,2h")).toThrow(/"2h" is not an interval/);
  });
  it("days: a whole number from 1 to 3650", () => {
    expect(parseDays("30")).toBe(30);
    expect(parseDays(5)).toBe(5);
    for (const bad of [0, -1, 3651, "1.5", "x", undefined, 2.5]) expect(() => parseDays(bad), String(bad)).toThrow(/whole number/);
  });
});
