/**
 * Demo history seeding (stream S18, docs/spec/p1-03-pricing-vol.md §4.2). Demo mode never touches the network: this
 * builds a 300-trading-day history for the demo underlyings from the demo adapter's own prices, through the REAL
 * capture.mjs (live days) and backfill/proxy.mjs (back-fill days), so every route and every UI state can be seen.
 *
 *  - Days −1 … −35 except −12: quality "live", capture.mjs on demoChainAt(…, 15:25 that day) for that day's expiries
 *    (34 live days).
 *  - Day −12: an explicit missed row (reason BRIDGE_OFF), so the gap shows on the chart and in /history.
 *  - Days −36 … −300: quality "backfill-eod", proxy.mjs on a synthetic end-of-day file (15:30 closes from the demo
 *    option prices, futures settles from the demo futures, contracts from a volume model).
 *  - VIX closes from the demo INDIAVIX; HV from the demo daily candles; S9 predictions for the live days.
 * Everything is labelled `source: "demo"`. Work is chunked (one setImmediate turn per 20 days) so the event loop stays
 * free while the Bridge starts.
 */
import { candles, demoChainAt, expiriesFor, optionPrice, priceOf, spotAt } from "../demo/demoAdapter.mjs";
import { chooseExpiries, cmTargetDate, expiryRow, hvOf, istDateOf, missedRow, predictionRows, summaryRow } from "./capture.mjs";
import { proxyRows } from "./backfill/proxy.mjs";

export const DEMO_DAYS = 300;
/** Live days are −1 … −LIVE_SPAN except the missed day. */
export const LIVE_SPAN = 35;
export const MISSED_DAY = 12;
/** Demo underlyings seeded with history (BANKEX is not a demo underlying). */
export const DEMO_VOL_UNDERLYINGS = Object.freeze(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"]);
const CHUNK_DAYS = 20;
const SEED_STRIKES = 12;
const IST = 330 * 60_000;
const DAY = 86_400_000;

/** Epoch ms of hh:mm IST on `date`. */
export const istAtHm = (date, hm) => Date.parse(`${date}T00:00:00Z`) + (Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5))) * 60_000 - IST;
const turn = () => new Promise((r) => setImmediate(r));

/** The `n` trading days strictly before `today`, newest first. */
export function tradingDaysBefore(today, n, isTradingDay) {
  const out = [];
  let t = Date.parse(`${today}T00:00:00Z`) - DAY;
  for (let guard = 0; out.length < n && guard < n * 3; guard += 1, t -= DAY) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (isTradingDay(d)) out.push(d);
  }
  return out;
}

/** A synthetic end-of-day file for one underlying and day (the shape proxy.mjs reads), from the demo prices. */
export function demoEodDay(u, exchange, date, closeMs, { stepOf, strikesEachSide = 3, target = null } = {}) {
  const spot = spotAt(u, closeMs);
  // The files list every expiry; only the ones a back-fill row can use (front, the 30-day pair, ≤ 100 days) are made.
  const expiries = chooseExpiries(expiriesFor(u, closeMs, 6).filter((e) => e > date), { today: date, target: target ?? date, maxPerUnderlying: 4, maxCalendarDays: 100 });
  const step = stepOf(u);
  const centre = Math.round(spot / step) * step;
  const futures = [];
  const options = [];
  for (const expiry of expiries) {
    const fut = priceOf(`DM-${u}-${expiry}-FUT`, closeMs);
    if (fut) futures.push({ expiry, settle: fut });
    for (let i = -strikesEachSide; i <= strikesEachSide; i += 1) {
      const strike = centre + i * step;
      const near = Math.exp(-((i / 3) ** 2));
      for (const right of ["CE", "PE"]) {
        const close = optionPrice(u, expiry, strike, right, closeMs);
        if (close) options.push({ expiry, strike, right, close, contracts: Math.round(800 + 40_000 * near) });
      }
    }
  }
  return { underlying: u, exchange, date, spot, futures, options };
}

/**
 * Seed the store. `ctxFor(exchange)` gives the clock context (vol/context.mjs on the demo reference data).
 * @param {{ store: object, ctxFor: (exchange: string) => object, today: string, isTradingDay: (date: string, exchange: string) => boolean,
 *   exchangeOf: (u: string) => string, stepOf: (u: string) => number, kindOf?: (u: string) => string,
 *   underlyings?: string[], days?: number, minContracts?: number, vixSymbol?: string, session?: { open: string, close: string } }} p
 * @returns {Promise<{ underlyings: string[], liveDays: number, backfillDays: number, missed: string[], rows: number }>}
 */
export async function seedDemoHistory({ store, ctxFor, today, isTradingDay, exchangeOf, stepOf, kindOf = () => "index", underlyings = DEMO_VOL_UNDERLYINGS, days = DEMO_DAYS, minContracts = 500, session }) {
  const captureHm = minus(session.close, 5);
  const report = { underlyings: [...underlyings], liveDays: 0, backfillDays: 0, missed: [], rows: 0 };
  // VIX closes over the NSE calendar (INDIA VIX is an NSE index).
  const vixDays = tradingDaysBefore(today, days, (d) => isTradingDay(d, "NFO")).reverse();
  store.putVix(vixDays.map((date) => {
    const c = spotAt("INDIAVIX", istAtHm(date, session.close));
    const o = spotAt("INDIAVIX", istAtHm(date, session.open));
    return { date, o, h: Math.max(o, c), l: Math.min(o, c), c, source: "demo" };
  }));
  for (const u of underlyings) {
    const exchange = exchangeOf(u);
    const ctx = ctxFor(exchange);
    const list = tradingDaysBefore(today, days, (d) => isTradingDay(d, exchange));
    const firstMs = istAtHm(list.at(-1), session.open) - 100 * DAY;
    const bars = candles(`DM-${u}`, "1d", firstMs, istAtHm(today, "00:00"));
    let prevFront = null;
    const ordered = list.map((date, i) => ({ date, back: i + 1 })).reverse();
    for (let start = 0; start < ordered.length; start += CHUNK_DAYS) {
      const expRows = [];
      const sums = [];
      const preds = [];
      for (const { date, back } of ordered.slice(start, start + CHUNK_DAYS)) {
        const closeMs = istAtHm(date, session.close);
        const dayBars = bars.filter((b) => b.time * 1000 < closeMs).slice(-70);
        const hv = hvOf(dayBars, "demo");
        const spotClose = spotAt(u, closeMs);
        const vixClose = spotAt("INDIAVIX", closeMs);
        if (back === MISSED_DAY) {
          sums.push(missedRow(u, date, "BRIDGE_OFF"));
          report.missed.push(date);
          continue;
        }
        if (back <= LIVE_SPAN) {
          const t = istAtHm(date, captureHm);
          const target = cmTargetDate(ctx, date);
          const exps = chooseExpiries(expiriesFor(u, t, 6), { today: date, target });
          const capturedAt = isoIst(t + 3000);
          const rows = [];
          for (const e of exps) {
            const chain = demoChainAt(u, e, t, SEED_STRIKES);
            const row = chain && expiryRow(chain, ctx, t, e, { underlying: u, exchange, kind: kindOf(u), quality: "live", trigger: "scheduled", source: "demo", broker: "demo", capturedAt });
            if (row) {
              rows.push(row);
              preds.push(...predictionRows(row, { ts: capturedAt, strikes: chain.rows.map((r) => r.strike) }));
            }
          }
          expRows.push(...rows);
          const s = summaryRow({ underlying: u, rows, ctx, now: t, quality: "live", vix: { value: spotAt("INDIAVIX", t), close: vixClose, source: "demo" }, hv, spotClose, prevFront });
          prevFront = s.front?.expiry ?? prevFront;
          sums.push(s);
          continue;
        }
        const eod = demoEodDay(u, exchange, date, closeMs, { stepOf, target: cmTargetDate(ctx, date) });
        const { rows } = proxyRows(eod, { ctx, closeMs, minContracts, source: "demo", kind: kindOf(u) });
        expRows.push(...rows);
        const s = summaryRow({ underlying: u, rows, ctx, now: closeMs, quality: "backfill-eod", vix: { value: vixClose, close: vixClose, source: "demo" }, hv, spotClose, prevFront });
        prevFront = s.front?.expiry ?? prevFront;
        sums.push(s);
      }
      report.rows += store.putExpiryRows(u, expRows).length;
      store.putSummaries(u, sums);
      if (preds.length) store.appendPredictions(preds);
      await turn();
    }
    if (u === underlyings[0]) {
      report.liveDays = store.summaries(u).filter((r) => r.quality === "live").length;
      report.backfillDays = store.summaries(u).filter((r) => r.quality === "backfill-eod").length;
    }
  }
  await store.flush();
  return report;
}

function minus(hm, minutes) {
  const m = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)) - minutes;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** ISO-8601 with +05:30 and milliseconds. */
export function isoIst(ms) {
  return `${new Date(ms + IST).toISOString().slice(0, 23)}+05:30`;
}

export { istDateOf };
