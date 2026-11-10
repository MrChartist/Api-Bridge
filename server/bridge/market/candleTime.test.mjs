import { describe, expect, it } from "vitest";
import { withCandleTimes } from "./candleTime.mjs";

// 1794249000 = 2026-11-09T18:30:00Z = 2026-11-10 00:00 IST: the bar for the 10th. Its UTC date is the 9th.
const DAILY = 1794249000;
const bar = (time) => ({ time, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });

describe("candle times", () => {
  it("a daily bar gets the IST trading date, not the UTC date of its epoch time", () => {
    const out = withCandleTimes({ symbol: "NSE:NIFTY", interval: "1d", candles: [bar(DAILY)] });
    expect(out.candles[0].date).toBe("2026-11-10");
    expect(new Date(DAILY * 1000).toISOString().slice(0, 10)).toBe("2026-11-09");
    expect(out.candles[0].time).toBe(DAILY);
    expect(out.symbol).toBe("NSE:NIFTY");
  });

  it("weekly and monthly bars get a date too; intraday bars do not, unless asked for an ISO time", () => {
    expect(withCandleTimes({ interval: "1w", candles: [bar(DAILY)] }).candles[0].date).toBe("2026-11-10");
    expect(withCandleTimes({ interval: "1M", candles: [bar(DAILY)] }).candles[0].date).toBe("2026-11-10");
    const intraday = { interval: "5m", candles: [bar(DAILY + 9 * 3600 + 900)] };
    expect(withCandleTimes(intraday)).toBe(intraday);
    expect(withCandleTimes(intraday, { iso: true }).candles[0]).toEqual({ ...intraday.candles[0], timeIso: "2026-11-10T09:15:00+05:30" });
  });

  it("timeIso is IST by default and UTC with tz=UTC; both are the same instant as time", () => {
    const ist = withCandleTimes({ interval: "1d", candles: [bar(DAILY)] }, { iso: true }).candles[0].timeIso;
    const utc = withCandleTimes({ interval: "1d", candles: [bar(DAILY)] }, { iso: true, tz: "UTC" }).candles[0].timeIso;
    expect(ist).toBe("2026-11-10T00:00:00+05:30");
    expect(utc).toBe("2026-11-09T18:30:00Z");
    expect(Date.parse(ist)).toBe(DAILY * 1000);
    expect(Date.parse(utc)).toBe(DAILY * 1000);
  });

  it("never changes the candles it was given (they may be shared with the cache or a dataset)", () => {
    const input = { interval: "1d", candles: [bar(DAILY)] };
    const before = JSON.stringify(input);
    const out = withCandleTimes(input, { iso: true });
    expect(JSON.stringify(input)).toBe(before);
    expect(out.candles[0]).not.toBe(input.candles[0]);
  });

  it("leaves a candle without a usable time alone", () => {
    const out = withCandleTimes({ interval: "1d", candles: [{ time: "x" }] });
    expect(out.candles[0]).toEqual({ time: "x" });
  });
});
