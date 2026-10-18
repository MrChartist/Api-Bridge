import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "../core/eventBus.mjs";
import { bucketStart, createCandleAggregator, createLiveCandles, istMidnight, sessionWindow, tickTimeMs } from "./candles.mjs";

const ist = (s) => Date.parse(`2026-10-19T${s}+05:30`); // a Monday
const sec = (s) => ist(s) / 1000;
const tick = (symbol, time, ltp, extra = {}) => ({ symbol, ltp, exchangeTs: ist(time), receivedAt: ist(time) + 50, accountId: "a", broker: "b", volume: null, oi: null, ...extra });

describe("session-aligned buckets", () => {
  it("aligns NSE bars to 09:15", () => {
    expect(bucketStart(ist("09:15:00"), "1m", "NSE")).toBe(sec("09:15:00"));
    expect(bucketStart(ist("09:16:59"), "1m", "NSE")).toBe(sec("09:16:00"));
    expect(bucketStart(ist("09:19:59"), "5m", "NSE")).toBe(sec("09:15:00"));
    expect(bucketStart(ist("09:20:00"), "5m", "NSE")).toBe(sec("09:20:00"));
    expect(bucketStart(ist("10:20:00"), "60m", "NFO")).toBe(sec("10:15:00"));
    expect(bucketStart(ist("15:29:59"), "60m", "NSE")).toBe(sec("15:15:00"));
    expect(bucketStart(ist("09:40:00"), "30m", "BFO")).toBe(sec("09:15:00"));
    expect(bucketStart(ist("09:45:00"), "30m", "BSE")).toBe(sec("09:45:00"));
  });

  it("drops pre-open and post-close ticks unless asked to keep them", () => {
    expect(bucketStart(ist("09:08:00"), "1m", "NSE")).toBeNull();
    expect(bucketStart(ist("15:30:00"), "1m", "NSE")).toBeNull();
    expect(bucketStart(ist("09:08:30"), "5m", "NSE", { outsideSession: "clock" })).toBe(sec("09:05:00"));
  });

  it("uses each exchange's session (MCX and CDS open at 09:00)", () => {
    expect(bucketStart(ist("09:30:00"), "60m", "MCX")).toBe(sec("09:00:00"));
    expect(bucketStart(ist("23:00:00"), "15m", "MCX")).toBe(sec("23:00:00"));
    expect(bucketStart(ist("16:59:00"), "60m", "CDS")).toBe(sec("16:00:00"));
    expect(bucketStart(ist("12:00:00"), "1m", "XYZ")).toBeNull();
  });

  it("stamps daily bars at IST midnight", () => {
    expect(bucketStart(ist("14:00:00"), "1d", "NSE")).toBe(sec("00:00:00"));
    expect(istMidnight(ist("23:59:59"))).toBe(ist("00:00:00"));
  });

  it("honours special sessions such as Muhurat trading", () => {
    const specialSessions = { "2026-10-19": { open: "18:00", close: "19:00" } };
    expect(sessionWindow(ist("12:00:00"), "NSE", { specialSessions })).toEqual({ open: ist("18:00:00"), close: ist("19:00:00") });
    expect(bucketStart(ist("18:07:00"), "5m", "NSE", { specialSessions })).toBe(sec("18:05:00"));
    expect(bucketStart(ist("10:00:00"), "5m", "NSE", { specialSessions })).toBeNull();
  });

  it("reads exchange time in seconds or ms, else the receive time", () => {
    expect(tickTimeMs({ exchangeTs: 1_760_000_000, receivedAt: 1 })).toBe(1_760_000_000_000);
    expect(tickTimeMs({ exchangeTs: 1_760_000_000_123, receivedAt: 1 })).toBe(1_760_000_000_123);
    expect(tickTimeMs({ exchangeTs: null, receivedAt: 42 })).toBe(42);
  });
});

describe("candle aggregator", () => {
  it("builds OHLC bars, volume from cumulative day volume, and closes a bar when the next starts", () => {
    const events = [];
    const agg = createCandleAggregator({ intervals: ["1m", "5m"], onBar: (e) => events.push(e) });
    agg.push(tick("NSE:NIFTY", "09:15:05", 100, { volume: 1000, oi: 5 }));
    agg.push(tick("NSE:NIFTY", "09:15:30", 104, { volume: 1300 }));
    agg.push(tick("NSE:NIFTY", "09:15:50", 98, { volume: 1350, oi: 7 }));
    agg.push(tick("NSE:NIFTY", "09:16:10", 101, { volume: 1500 }));
    expect(agg.bars("NSE:NIFTY", "1m")).toEqual([
      { time: sec("09:15:00"), open: 100, high: 104, low: 98, close: 98, volume: 350, oi: 7 },
      { time: sec("09:16:00"), open: 101, high: 101, low: 101, close: 101, volume: 150, oi: 7 },
    ]);
    expect(agg.current("NSE:NIFTY", "5m")).toMatchObject({ time: sec("09:15:00"), open: 100, high: 104, low: 98, close: 101, volume: 500 });
    const closed = events.filter((e) => e.closed);
    expect(closed).toEqual([{ symbol: "NSE:NIFTY", interval: "1m", bar: expect.objectContaining({ time: sec("09:15:00"), close: 98 }), closed: true }]);
  });

  it("ignores late ticks for closed bars and out-of-session ticks", () => {
    const agg = createCandleAggregator({ intervals: ["1m"] });
    agg.push(tick("NSE:INFY", "09:20:10", 10));
    agg.push(tick("NSE:INFY", "09:21:10", 11));
    expect(agg.push(tick("NSE:INFY", "09:20:50", 99))).toBe(0);
    expect(agg.push(tick("NSE:INFY", "15:45:00", 99))).toBe(0);
    expect(agg.push({ symbol: "NSE:INFY", ltp: 0, receivedAt: ist("09:22:00") })).toBe(0);
    expect(agg.bars("NSE:INFY", "1m").map((b) => b.high)).toEqual([10, 11]);
  });

  it("flush closes quiet bars at their end, cut at the session close", () => {
    const agg = createCandleAggregator({ intervals: ["1m", "60m", "1d"] });
    agg.push(tick("NSE:NIFTY", "15:20:00", 100));
    expect(agg.flush(ist("15:20:59"))).toBe(0);
    expect(agg.flush(ist("15:21:00"))).toBe(1);
    expect(agg.flush(ist("15:30:00"))).toBe(2); // 15:15 hourly bar ends at the close, as does the daily bar
    expect(agg.current("NSE:NIFTY", "60m")).toBeNull();
    expect(agg.bars("NSE:NIFTY", "1d")).toHaveLength(1);
    agg.push(tick("NSE:NIFTY", "15:20:30", 50)); // same minute after it closed: ignored
    expect(agg.bars("NSE:NIFTY", "1m")).toHaveLength(1);
  });

  it("daily bars carry the cumulative day volume", () => {
    const agg = createCandleAggregator({ intervals: ["1d"] });
    agg.push(tick("NSE:NIFTY", "09:15:01", 100, { volume: 10 }));
    agg.push(tick("NSE:NIFTY", "12:00:00", 105, { volume: 9000 }));
    expect(agg.current("NSE:NIFTY", "1d")).toMatchObject({ time: sec("00:00:00"), open: 100, high: 105, close: 105, volume: 9000 });
  });

  it("bounds bars per series and the number of series", () => {
    const agg = createCandleAggregator({ intervals: ["1m"], maxBars: 10, maxSeries: 2 });
    for (let m = 0; m < 30; m += 1) agg.push({ symbol: "NSE:NIFTY", ltp: 100 + m, exchangeTs: ist("09:15:00") + m * 60_000, receivedAt: 0 });
    expect(agg.bars("NSE:NIFTY", "1m", { includeCurrent: false })).toHaveLength(10);
    expect(agg.bars("NSE:NIFTY", "1m", { limit: 3 }).map((b) => b.close)).toEqual([127, 128, 129]);
    agg.push(tick("NSE:INFY", "10:00:00", 1));
    agg.push(tick("NSE:TCS", "10:00:00", 1));
    expect(agg.stats().series).toBe(2);
    expect(agg.bars("NSE:NIFTY", "1m")).toEqual([]); // least recently updated was evicted
  });

  it("continues seeded history", () => {
    const agg = createCandleAggregator({ intervals: ["5m"] });
    agg.seed("NSE:NIFTY", "5m", [
      { time: sec("09:15:00"), open: 1, high: 2, low: 1, close: 2, volume: 10 },
      { time: sec("09:20:00"), open: 2, high: 3, low: 2, close: 3, volume: 5 },
    ], ist("09:22:00"));
    agg.push(tick("NSE:NIFTY", "09:22:30", 4));
    agg.push(tick("NSE:NIFTY", "09:25:10", 5));
    expect(agg.bars("NSE:NIFTY", "5m").map((b) => [b.time - sec("09:15:00"), b.high, b.close])).toEqual([
      [0, 2, 2],
      [300, 4, 4],
      [600, 5, 5],
    ]);
    agg.clear("NSE:NIFTY");
    expect(agg.bars("NSE:NIFTY", "5m")).toEqual([]);
  });

  it("refuses unknown intervals", () => {
    expect(() => createCandleAggregator({ intervals: ["2m"] })).toThrow(/Unknown interval/);
  });

  it("createLiveCandles follows bus ticks and closes bars on a timer", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(ist("09:15:10"));
      const bus = createEventBus();
      const live = createLiveCandles({ bus, intervals: ["1m"] });
      bus.emit("tick", tick("NSE:NIFTY", "09:15:10", 200));
      expect(live.current("NSE:NIFTY", "1m")).toMatchObject({ open: 200 });
      vi.advanceTimersByTime(60_000);
      expect(live.current("NSE:NIFTY", "1m")).toBeNull();
      expect(live.bars("NSE:NIFTY", "1m")).toHaveLength(1);
      live.dispose();
      expect(bus.listenerCount("tick")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
