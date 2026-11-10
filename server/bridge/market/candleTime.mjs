/**
 * The time rule for candles (docs/guides/developers.md, "Times and time zones"). Additive only: `time` stays epoch seconds.
 *
 *   date      IST trading date of the bar's open, "YYYY-MM-DD". Added to daily, weekly and monthly bars. A daily bar opens at
 *             IST midnight, which is 18:30 UTC the day before, so the UTC date of `time` is the wrong day: use `date`.
 *   timeIso   the same instant as an ISO-8601 string with the offset, on request (`timeIso=true`, or `tz=IST|UTC`):
 *             "2026-11-10T00:00:00+05:30" (IST, the default) or "2026-11-09T18:30:00Z" (`tz=UTC`).
 *
 * Pure. It builds new candle objects: the answer may share candles with the cache or a stored dataset, which are never changed.
 */
import { istDate, toIstIso } from "./time.mjs";

/** Bar sizes at which a bar is a day or more, so a date says more than a clock time. */
const DATE_INTERVALS = new Set(["1d", "1w", "1M"]);

/** "2026-10-19T09:30:00+05:30" (no milliseconds: a bar opens on a whole second). */
const istIsoSeconds = (ms) => toIstIso(ms).replace(/\.\d{3}(?=\+)/, "");
const utcIsoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * @param {{ interval: string, candles: Array<{ time: number }> }} result  a HistoryResult
 * @param {{ iso?: boolean, tz?: "IST" | "UTC" }} [o]
 * @returns the same result with `date` (daily and longer bars) and, when asked, `timeIso` on each candle
 */
export function withCandleTimes(result, { iso = false, tz = "IST" } = {}) {
  const addDate = DATE_INTERVALS.has(result?.interval);
  if (!addDate && !iso) return result;
  const fmt = tz === "UTC" ? utcIsoSeconds : istIsoSeconds;
  return {
    ...result,
    candles: (result.candles ?? []).map((c) => {
      const ms = Number(c.time) * 1000;
      if (!Number.isFinite(ms)) return c;
      const out = { ...c };
      if (addDate) out.date = istDate(ms);
      if (iso) out.timeIso = fmt(ms);
      return out;
    }),
  };
}
