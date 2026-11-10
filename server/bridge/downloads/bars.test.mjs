/**
 * Bars on disk: normalising, which bars are finished, the three file layouts and reading them back, a cut-off tail, and
 * the gaps report.
 */
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { amibrokerRows } from "../integrations/xl.mjs";
import { historyCsvRows } from "../market/history.mjs";
import { toCsv } from "../core/http.mjs";
import { calendarCovers, sharedCalendar } from "./calendar.mjs";
import { coveredUpTo, decodeLine, encodeBars, findHoles, headerText, isClosedBar, lastBarOf, normaliseBar, openBoundaryMs, readBars, readBarsFrom, splitCsvLine, stepSeconds, trimPartialTail } from "./bars.mjs";

const at = (iso) => Date.parse(iso);
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
const tmp = () => mkdtempSync(join(tmpdir(), "mcb-bars-"));

describe("normaliseBar", () => {
  it("stamps daily and longer bars at IST midnight and keeps intraday seconds", () => {
    const daily = normaliseBar({ time: sec("2026-10-01T09:15:00+05:30"), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }, "1d");
    expect(daily.time).toBe(sec("2026-10-01T00:00:00+05:30"));
    const intraday = normaliseBar({ time: sec("2026-10-01T09:15:00+05:30"), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, oi: 5 }, "5m");
    expect(intraday).toEqual({ time: sec("2026-10-01T09:15:00+05:30"), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, oi: 5 });
  });
  it("refuses a candle that is not numbers, and defaults a missing volume to 0", () => {
    expect(normaliseBar({ time: 1, open: NaN, high: 1, low: 1, close: 1 }, "5m")).toBeNull();
    expect(normaliseBar(null, "5m")).toBeNull();
    expect(normaliseBar({ time: 1_700_000_000, open: 1, high: 1, low: 1, close: 1 }, "5m").volume).toBe(0);
  });
});

describe("which bars are finished", () => {
  it("an intraday bar is finished once its interval has passed", () => {
    expect(openBoundaryMs(at("2026-10-20T11:02:30+05:30"), "5m", "NSE")).toBe(at("2026-10-20T11:00:00+05:30"));
    expect(isClosedBar({ time: sec("2026-10-20T10:55:00+05:30") }, "5m", "NSE", at("2026-10-20T11:02:30+05:30"))).toBe(true);
    expect(isClosedBar({ time: sec("2026-10-20T11:00:00+05:30") }, "5m", "NSE", at("2026-10-20T11:02:30+05:30"))).toBe(false);
    expect(coveredUpTo(at("2026-10-20T11:02:30+05:30"), "5m", "NSE")).toBe(sec("2026-10-20T11:00:00+05:30") - 1);
  });
  it("a daily bar is finished half an hour after the session closes", () => {
    expect(isClosedBar({ time: sec("2026-10-20T00:00:00+05:30") }, "1d", "NSE", at("2026-10-20T15:45:00+05:30"))).toBe(false);
    expect(isClosedBar({ time: sec("2026-10-20T00:00:00+05:30") }, "1d", "NSE", at("2026-10-20T16:00:00+05:30"))).toBe(true);
    // MCX stays open much later
    expect(isClosedBar({ time: sec("2026-10-20T00:00:00+05:30") }, "1d", "MCX", at("2026-10-20T16:00:00+05:30"))).toBe(false);
  });
  it("a weekly bar is finished when its week is over, a monthly one when its month is", () => {
    expect(isClosedBar({ time: sec("2026-10-19T00:00:00+05:30") }, "1w", "NSE", at("2026-10-23T18:00:00+05:30"))).toBe(false);
    expect(isClosedBar({ time: sec("2026-10-19T00:00:00+05:30") }, "1w", "NSE", at("2026-10-26T10:00:00+05:30"))).toBe(true);
    expect(isClosedBar({ time: sec("2026-10-01T00:00:00+05:30") }, "1M", "NSE", at("2026-10-31T18:00:00+05:30"))).toBe(false);
    expect(isClosedBar({ time: sec("2026-10-01T00:00:00+05:30") }, "1M", "NSE", at("2026-11-02T10:00:00+05:30"))).toBe(true);
  });
  it("knows how long a bar is", () => {
    expect([stepSeconds("1m"), stepSeconds("15m"), stepSeconds("1d"), stepSeconds("1w")]).toEqual([60, 900, 86_400, 604_800]);
  });
});

const bars5m = [
  { time: sec("2026-10-20T09:15:00+05:30"), open: 100, high: 102, low: 99.5, close: 101, volume: 1200 },
  { time: sec("2026-10-20T09:20:00+05:30"), open: 101, high: 103, low: 100, close: 102.5, volume: 800, oi: 55 },
];
const barsD = [
  { time: sec("2026-10-19T00:00:00+05:30"), open: 100, high: 102, low: 99.5, close: 101, volume: 1200 },
  { time: sec("2026-10-20T00:00:00+05:30"), open: 101, high: 103, low: 100, close: 102.5, volume: 800 },
];

describe("writers", () => {
  it("CSV per symbol is the history CSV of /v1/history, header first", () => {
    const text = headerText({ format: "csv", layout: "per-symbol", interval: "5m" }) + encodeBars(bars5m, { symbol: "NSE:X", interval: "5m", format: "csv", layout: "per-symbol" });
    expect(text).toBe(toCsv(historyCsvRows({ interval: "5m", candles: bars5m })));
    expect(text.split("\r\n")[1]).toBe("2026-10-20 09:15:00,100,102,99.5,101,1200,");
  });
  it("CSV combined puts the symbol first", () => {
    const text = headerText({ format: "csv", layout: "combined", interval: "1d" }) + encodeBars(barsD, { symbol: "NSE:X", interval: "1d", format: "csv", layout: "combined" });
    expect(text.split("\r\n").slice(0, 2)).toEqual(["symbol,time,open,high,low,close,volume,oi", "NSE:X,2026-10-19,100,102,99.5,101,1200,"]);
  });
  it("AmiBroker is the layout of /xl/history, so the shipped import formats read it", () => {
    const intraday = headerText({ format: "amibroker", layout: "per-symbol", interval: "5m" }) + encodeBars(bars5m, { symbol: "BSE:X", interval: "5m", format: "amibroker", layout: "per-symbol" });
    expect(intraday).toBe(toCsv([["Ticker", "Date", "Time", "Open", "High", "Low", "Close", "Volume", "OpenInt"], ...amibrokerRows(bars5m, "5m", "X.BSE")]));
    expect(intraday.split("\r\n")[1]).toBe("X.BSE,2026-10-20,09:15:00,100,102,99.5,101,1200,0");
    const daily = headerText({ format: "amibroker", layout: "per-symbol", interval: "1d" }) + encodeBars(barsD, { symbol: "NSE:X", interval: "1d", format: "amibroker", layout: "per-symbol" });
    expect(daily.split("\r\n")[0]).toBe("Ticker,Date,Open,High,Low,Close,Volume,OpenInt");
    expect(daily.split("\r\n")[1]).toBe("X,2026-10-19,100,102,99.5,101,1200,0");
  });
  it("JSONL is one object per line with an ISO time and no header", () => {
    const text = encodeBars(bars5m, { symbol: "NSE:X", interval: "5m", format: "jsonl", layout: "per-symbol" });
    expect(headerText({ format: "jsonl", layout: "per-symbol", interval: "5m" })).toBe("");
    const rows = text.trim().split("\n").map((l) => JSON.parse(l));
    expect(rows[0]).toEqual({ symbol: "NSE:X", interval: "5m", time: "2026-10-20T09:15:00.000+05:30", open: 100, high: 102, low: 99.5, close: 101, volume: 1200, oi: null });
    expect(rows[1].oi).toBe(55);
  });
  it("nothing in, nothing out", () => {
    expect(encodeBars([], { symbol: "NSE:X", interval: "5m", format: "csv", layout: "per-symbol" })).toBe("");
  });
});

describe("readers give back what the writers wrote", () => {
  const cases = [
    ["csv", "per-symbol", "5m", bars5m],
    ["csv", "per-symbol", "1d", barsD],
    ["csv", "combined", "5m", bars5m],
    ["jsonl", "per-symbol", "5m", bars5m],
    ["amibroker", "per-symbol", "5m", bars5m],
    ["amibroker", "per-symbol", "1d", barsD],
  ];
  for (const [format, layout, interval, bars] of cases) {
    it(`${format} ${layout} ${interval}`, async () => {
      const file = join(tmp(), "x.dat");
      writeFileSync(file, headerText({ format, layout, interval }) + encodeBars(bars, { symbol: "NSE:X", interval, format, layout }));
      const got = [];
      for await (const d of readBars(file, { format, layout, interval })) got.push(d.bar);
      expect(got).toEqual(bars.map((b) => ({ ...b, volume: b.volume })));
      expect((await lastBarOf(file, { format, layout, interval })).bar).toEqual(bars.at(-1));
      if (layout === "combined" || format === "jsonl") expect((await lastBarOf(file, { format, layout, interval })).symbol).toBe("NSE:X");
    });
  }

  it("skips the header, blank and broken lines, and reads a missing file as empty", async () => {
    expect(decodeLine("time,open,high,low,close,volume,oi", { format: "csv", layout: "per-symbol", interval: "5m" })).toBeNull();
    expect(decodeLine("", { format: "csv", layout: "per-symbol", interval: "5m" })).toBeNull();
    expect(decodeLine("2026-10-20 09:15:00,abc,1,1,1,1,", { format: "csv", layout: "per-symbol", interval: "5m" })).toBeNull();
    expect(decodeLine("{not json", { format: "jsonl", layout: "per-symbol", interval: "5m" })).toBeNull();
    const got = [];
    for await (const d of readBars(join(tmp(), "missing.csv"), { format: "csv", layout: "per-symbol", interval: "5m" })) got.push(d);
    expect(got).toEqual([]);
    expect(await lastBarOf(join(tmp(), "missing.csv"), { format: "csv", layout: "per-symbol", interval: "5m" })).toBeNull();
  });

  it("splits quoted CSV cells", () => {
    expect(splitCsvLine('a,"b,c","d ""e"""')).toEqual(["a", "b,c", 'd "e"']);
  });
});

describe("a cut-off tail", () => {
  it("is trimmed back to the last whole line", async () => {
    const file = join(tmp(), "t.csv");
    const whole = headerText({ format: "csv", layout: "per-symbol", interval: "5m" }) + encodeBars(bars5m, { symbol: "NSE:X", interval: "5m", format: "csv", layout: "per-symbol" });
    writeFileSync(file, whole);
    expect(await trimPartialTail(file)).toBe(Buffer.byteLength(whole));
    appendFileSync(file, "2026-10-20 09:25:00,1,2");
    expect(await trimPartialTail(file)).toBe(Buffer.byteLength(whole));
    expect(readFileSync(file, "utf8")).toBe(whole);
    writeFileSync(file, "no newline at all");
    expect(await trimPartialTail(file)).toBe(0);
    expect(await trimPartialTail(join(tmp(), "none"))).toBe(0);
  });
});

describe("findHoles", () => {
  const cal = sharedCalendar();
  const fiveMinDay = (date, skip = []) => Array.from({ length: 75 }, (_, k) => ({ time: sec(`${date}T09:15:00+05:30`) + k * 300 })).filter((_, k) => !skip.includes(k));
  const opts = { interval: "5m", exchange: "NSE", isTradingDay: (d) => cal.isTradingDay(d, "NSE") };

  it("finds bars missing inside a day, as one stretch", () => {
    const bars = [...fiveMinDay("2026-11-02"), ...fiveMinDay("2026-11-03", [10, 11, 12, 40])];
    const holes = findHoles(bars, opts);
    expect(holes).toEqual([
      { from: sec("2026-11-03T09:15:00+05:30") + 10 * 300, to: sec("2026-11-03T09:15:00+05:30") + 12 * 300, missing: 3, kind: "missing-bars" },
      { from: sec("2026-11-03T09:15:00+05:30") + 40 * 300, to: sec("2026-11-03T09:15:00+05:30") + 40 * 300, missing: 1, kind: "missing-bars" },
    ]);
  });
  it("finds a trading day with no bars, and does not count a weekend or a holiday", () => {
    const bars = [...fiveMinDay("2026-10-15"), ...fiveMinDay("2026-10-19")]; // Thu, then Mon: Friday 16 is missing; the weekend is not
    const holes = findHoles(bars, opts);
    expect(holes).toHaveLength(1);
    expect(holes[0]).toMatchObject({ kind: "missing-days", missing: 75, from: sec("2026-10-16T09:15:00+05:30") });
    // 2 October 2026 (Friday) is a holiday on the shipped list, and 3 and 4 October are the weekend
    expect(calendarCovers("2026-10-02")).toBe(true);
    expect(findHoles([...fiveMinDay("2026-10-01"), ...fiveMinDay("2026-10-05")], opts)).toEqual([]);
  });
  it("does not count the quiet edges of a day: a thin stock may open late and stop early", () => {
    const bars = fiveMinDay("2026-11-03").slice(5, 60);
    expect(findHoles(bars, opts)).toEqual([]);
  });
  it("without a calendar only holes between two stored bars are found", () => {
    const bars = [...fiveMinDay("2026-10-15"), ...fiveMinDay("2026-10-19", [3])]; // no calendar: only the hole inside Monday
    expect(findHoles(bars, { interval: "5m", exchange: "NSE" }).map((h) => h.kind)).toEqual(["missing-bars"]);
  });
  it("daily bars: stretches of missing trading days", () => {
    const day = (d) => ({ time: sec(`${d}T00:00:00+05:30`) });
    const bars = [day("2026-10-12"), day("2026-10-13"), day("2026-10-16"), day("2026-10-19")]; // 14 and 15 missing
    expect(findHoles(bars, { interval: "1d", exchange: "NSE", isTradingDay: (d) => cal.isTradingDay(d, "NSE") })).toEqual([{ from: sec("2026-10-14T00:00:00+05:30"), to: sec("2026-10-15T00:00:00+05:30"), missing: 2, kind: "missing-days" }]);
  });
  it("is empty for no bars and for weekly bars", () => {
    expect(findHoles([], opts)).toEqual([]);
    expect(findHoles([{ time: 1 }, { time: 9 * 86_400 }], { interval: "1w", exchange: "NSE" })).toEqual([]);
  });
});

describe("RDATA-18 readBarsFrom finds the start without parsing the whole file", () => {
  const start = sec("2026-01-01T09:15:00+05:30");
  const bars = Array.from({ length: 14_000 }, (_, i) => ({ time: start + i * 60, open: 100 + (i % 7), high: 108, low: 99, close: 101 + (i % 5), volume: i }));
  for (const format of ["csv", "jsonl"]) {
    it(`gives the same bars as a full read from any start (${format})`, async () => {
      const file = join(tmp(), `big.${format}`);
      writeFileSync(file, headerText({ format, layout: "per-symbol", interval: "1m" }) + encodeBars(bars, { symbol: "NSE:X", interval: "1m", format, layout: "per-symbol" }));
      const opts = { format, layout: "per-symbol", interval: "1m" };
      const full = [];
      for await (const { bar } of readBars(file, opts)) full.push(bar);
      expect(full).toHaveLength(bars.length);
      for (const from of [0, start, start + 60 * 7_000 + 30, start + 60 * 13_999, start + 60 * 14_000, start + 99_999_999]) {
        const got = [];
        for await (const { bar } of readBarsFrom(file, opts, from)) if (bar.time >= from) got.push(bar);
        expect(got, `from ${from}`).toEqual(full.filter((b) => b.time >= from));
      }
      // it really skips: a recent start does not yield the early bars
      let yielded = 0;
      for await (const _ of readBarsFrom(file, opts, start + 60 * 13_900)) yielded += 1;
      expect(yielded).toBeLessThan(2_000);
    });
  }
  it("reads a small file from the top and a missing file as nothing", async () => {
    const file = join(tmp(), "small.csv");
    writeFileSync(file, headerText({ format: "csv", layout: "per-symbol", interval: "1m" }) + encodeBars(bars.slice(0, 10), { symbol: "NSE:X", interval: "1m", format: "csv", layout: "per-symbol" }));
    const got = [];
    for await (const { bar } of readBarsFrom(file, { format: "csv", layout: "per-symbol", interval: "1m" }, start + 300)) got.push(bar);
    expect(got.filter((b) => b.time >= start + 300)).toHaveLength(5);
    const none = [];
    for await (const x of readBarsFrom(join(tmp(), "nope.csv"), { format: "csv", layout: "per-symbol", interval: "1m" }, 0)) none.push(x);
    expect(none).toEqual([]);
  });
});
