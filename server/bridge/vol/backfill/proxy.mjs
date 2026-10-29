/**
 * Back-fill proxy ATM IV (stream S18, docs/spec/p1-03-pricing-vol.md §6.10): one parsed end-of-day file (bhavcopy
 * rows for an underlying on a date) → store S2 expiry rows with `quality: "backfill-eod"`. Pure.
 *
 * The bhavcopy close is the last trade (often hours old away from the money, no bid/ask), so only strikes within two
 * strike steps of the forward with at least `minContracts` traded are used, and a day with fewer than two usable
 * points is dropped (THIN). Non-standard contracts (P1-2 `nonStandard`) are excluded, so a corporate action never mixes
 * adjusted and standard contracts on one day. The parsers (legacy/UDiFF NSE, BSE) that feed this land with the
 * back-fill job (P1-3c); the demo seeding (demoVol.mjs) already runs this on synthetic files.
 *
 * Parsed day: { underlying, exchange, date, spot (underlying close or null),
 *   futures: [{ expiry, settle }], options: [{ expiry, strike, right: "CE"|"PE", close, contracts, nonStandard? }] }
 */
import { impliedVolB76, volTime } from "../../dashboard/pricing.js";
import { ROW_VERSION, round, tradingDayOf } from "../capture.mjs";

/** Trading days to expiry a back-fill row needs (§6.10). */
export const MIN_DTE = 2;
export const MAX_DTE = 70;
/** Strike steps either side of the forward that may give a point. */
const STEPS = 2;

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null;
};

const DTE_MEMO = new WeakMap();
/** Trading days after `date` up to and including `expiry` on the context's calendar (memoised per context). */
export function tradingDte(ctx, date, expiry) {
  let memo = ctx && typeof ctx === "object" ? DTE_MEMO.get(ctx) : null;
  if (ctx && typeof ctx === "object" && !memo) DTE_MEMO.set(ctx, (memo = new Map()));
  const key = `${date}|${expiry}`;
  if (memo?.has(key)) return memo.get(key);
  const n = countTradingDays(ctx, date, expiry);
  if (memo && memo.size < 50_000) memo.set(key, n);
  return n;
}

function countTradingDays(ctx, date, expiry) {
  const isTrading = tradingDayOf(ctx);
  let n = 0;
  for (let t = Date.parse(`${date}T00:00:00Z`) + 86_400_000, end = Date.parse(`${expiry}T00:00:00Z`); t <= end && n < 400; t += 86_400_000) {
    if (isTrading(new Date(t).toISOString().slice(0, 10))) n += 1;
  }
  return n;
}

/**
 * Proxy rows for one parsed day.
 * @param {object} day  parsed day (header)
 * @param {{ ctx: object, closeMs: number, minContracts?: number, source?: string, kind?: string }} p
 * @returns {{ rows: object[], dropped: { expiry: string, reason: string }[] }}
 */
export function proxyRows(day, { ctx, closeMs, minContracts = 500, source = "nse-bhavcopy-udiff", kind = null }) {
  const rate = num(ctx?.rate?.value) ?? 0;
  const rows = [];
  const dropped = [];
  const futures = [...(day?.futures ?? [])].filter((f) => num(f.settle) > 0).sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
  const expiries = [...new Set((day?.options ?? []).map((o) => o.expiry))].sort();
  const usable = (o) => o && !o.nonStandard && num(o.close) > 0 && (num(o.contracts) ?? 0) >= minContracts;
  for (const expiry of expiries) {
    const dte = tradingDte(ctx, day.date, expiry);
    if (dte < MIN_DTE || dte > MAX_DTE) continue;
    const vt = volTime(ctx, closeMs, expiry);
    if (!vt || !(vt.T > 0)) continue;
    const opts = day.options.filter((o) => o.expiry === expiry);
    const byStrike = new Map();
    for (const o of opts) {
      const k = num(o.strike);
      if (k === null) continue;
      if (!byStrike.has(k)) byStrike.set(k, {});
      byStrike.get(k)[o.right] = o;
    }
    const strikes = [...byStrike.keys()].sort((a, b) => a - b);
    let step = null;
    for (let i = 1; i < strikes.length; i++) if (step === null || strikes[i] - strikes[i - 1] < step) step = strikes[i] - strikes[i - 1];
    // 1. Forward: same-expiry future, else the near-month future carried, else parity on closes.
    let F = null;
    let forwardSource = null;
    const same = futures.find((f) => f.expiry === expiry);
    if (same) {
      F = num(same.settle);
      forwardSource = "future";
    } else if (futures.length) {
      const near = futures[0];
      const vf = volTime(ctx, closeMs, near.expiry);
      F = num(near.settle) * Math.exp(rate * (vt.Tcal - (vf?.Tcal ?? 0)));
      forwardSource = "future-carried";
    } else {
      const growth = Math.exp(rate * vt.Tcal);
      const centre = num(day.spot) ?? median(strikes);
      const pairs = strikes
        .filter((k) => usable(byStrike.get(k).CE) && usable(byStrike.get(k).PE))
        .sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre))
        .slice(0, 5)
        .map((k) => k + (byStrike.get(k).CE.close - byStrike.get(k).PE.close) * growth);
      F = median(pairs);
      forwardSource = F === null ? null : "parity-close";
    }
    if (F === null || !(F > 0) || step === null) {
      dropped.push({ expiry, reason: "NO_FORWARD" });
      continue;
    }
    // 2. Points: OTM side, within two strike steps of F, enough contracts, standard contracts only.
    const df = Math.exp(-rate * vt.Tcal);
    const points = [];
    const contracts = {};
    for (const k of strikes) {
      if (Math.abs(k - F) > STEPS * step + 1e-9) continue;
      const right = k < F ? "PE" : "CE";
      const o = byStrike.get(k)[right];
      if (!usable(o)) continue;
      const iv = impliedVolB76(o.close, F, k, vt.T, right, df);
      if (iv === null || iv < 1 || iv > 300) continue;
      points.push({ k, iv });
      contracts[k] = num(o.contracts);
    }
    // 3. ATM IV: linear at F between the nearest usable points either side; one side only: within one step.
    const below = points.filter((p) => p.k <= F).pop() ?? null;
    const above = points.find((p) => p.k > F) ?? null;
    let atmIv = null;
    if (below && above) atmIv = below.k === F ? below.iv : below.iv + ((above.iv - below.iv) * (F - below.k)) / (above.k - below.k);
    else {
      const one = below ?? above;
      if (one && Math.abs(one.k - F) <= step + 1e-9) atmIv = one.iv;
    }
    if (atmIv === null || points.length < 2) {
      dropped.push({ expiry, reason: "THIN" });
      continue;
    }
    let atmStrike = strikes[0];
    for (const k of strikes) if (Math.abs(k - F) < Math.abs(atmStrike - F)) atmStrike = k;
    const ce = byStrike.get(atmStrike)?.CE;
    const pe = byStrike.get(atmStrike)?.PE;
    rows.push({
      v: ROW_VERSION,
      underlying: day.underlying,
      exchange: day.exchange ?? null,
      date: day.date,
      expiry,
      kind,
      capturedAt: null,
      trigger: "backfill",
      quality: "backfill-eod",
      late: false,
      source,
      broker: null,
      clock: { version: vt.version, mode: vt.mode, units: round(vt.units, 5), T: round(vt.T, 9), Tcal: round(vt.Tcal, 9), Ttd: round(vt.Ttd, 9), Tw: round(vt.Tw, 9), unitsWeighted: round(vt.unitsWeighted, 5) },
      rate: { value: rate, quality: ctx?.rate?.quality ?? null },
      spot: round(day.spot, 2),
      forward: round(F, 2),
      forwardSource,
      forwardStrikes: forwardSource === "parity-close" ? 5 : 0,
      atmStrike,
      atmIv: round(atmIv, 2),
      ceIv: null,
      peIv: null,
      straddle: num(ce?.close) && num(pe?.close) ? round(ce.close + pe.close, 2) : null,
      iv: { p10: null, p15: null, p25: null, p35: null, c35: null, c25: null, c15: null, c10: null },
      rr25: null,
      putSkew25: null,
      bf25: null,
      rr10: null,
      tv: round((atmIv / 100) ** 2 * vt.T, 12),
      move1s: null,
      band1: null,
      eam: null,
      quoteQuality: null,
      strikes: strikes.length,
      contracts,
      flags: [],
    });
  }
  return { rows, dropped };
}
