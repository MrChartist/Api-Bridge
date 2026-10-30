// whatif-core.js: the what-if scenario shared by Positions and the Strategy Builder (one state, one maths). Pure: no
// DOM, no fetch, no clock (`nowMs` comes in). A scenario is { pct, dIv, days }: spot moved by pct %, every leg's IV
// moved by dIv vol points, and `days` calendar days forward. It drives P&L, Greeks and margin for a set of legs (the
// whole book, one group, or a strategy draft), with the same functions the Positions scenario panel already used
// (options.js scenarioPnl / scenarioGreeks) and the one margin model (span-margin.js portfolioMargin).
//
// A leg here is a priced book leg (options.js priceBook): { kind, strike, right, expiry, q (signed units), avg, mark, F,
// iv, T, t0, priced, inc }. strategyBookLegs() turns Strategy Builder legs into the same shape.
import { scenarioGreeks, scenarioPnl, priceLeg, legAdj } from "./options.js";
import { portfolioMargin } from "./span-margin.js";

/** Slider ranges: spot ±10 % in 0.25 steps, IV ±10 points in 0.5 steps, days from 0 to the last expiry. */
export const WHATIF_LIMITS = Object.freeze({ pct: 10, pctStep: 0.25, dIv: 10, dIvStep: 0.5 });
const DAY_MS = 86_400_000;
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * The saved scenario, cleaned: { pct, dIv, days }. Accepts the Strategy Builder's older { target, ivShift } (target is
 * an absolute time; it becomes days from `nowMs`).
 */
export function normWhatIf(saved, nowMs = 0) {
  const s = saved && typeof saved === "object" ? saved : {};
  const pct = clamp(num(s.pct) ?? 0, -WHATIF_LIMITS.pct, WHATIF_LIMITS.pct);
  const dIv = clamp(num(s.dIv) ?? num(s.ivShift) ?? 0, -WHATIF_LIMITS.dIv, WHATIF_LIMITS.dIv);
  let days = num(s.days);
  if (days === null && num(s.target) !== null && nowMs) days = Math.max(0, (num(s.target) - nowMs) / DAY_MS);
  return { pct, dIv, days: Math.max(0, days ?? 0) };
}

/** True when the scenario is "now" (nothing moved). */
export const isNeutral = (w) => !w || (!num(w.pct) && !num(w.dIv) && !num(w.days));

/** Days slider step: whole days, or quarter days (6 h) when the last expiry is under 3 days away. */
export const daysStep = (maxDays) => (maxDays > 0 && maxDays < 3 ? 0.25 : 1);

/** Clamp a scenario to a page's range (days to `maxDays`), rounded to the slider steps. */
export function clampWhatIf(w, maxDays = 30) {
  const st = daysStep(maxDays);
  const r = (v, step) => Math.round(v / step) * step;
  return {
    pct: clamp(r(num(w?.pct) ?? 0, WHATIF_LIMITS.pctStep), -WHATIF_LIMITS.pct, WHATIF_LIMITS.pct),
    dIv: clamp(r(num(w?.dIv) ?? 0, WHATIF_LIMITS.dIvStep), -WHATIF_LIMITS.dIv, WHATIF_LIMITS.dIv),
    days: clamp(r(num(w?.days) ?? 0, st), 0, Math.max(0, maxDays)),
  };
}

/** The Strategy Builder's target time for a scenario: null for today, else now + days, capped at the first expiry. */
export function targetOf(w, nowMs, expMs) {
  const d = num(w?.days) ?? 0;
  if (!(d > 0)) return null;
  const t = nowMs + d * DAY_MS;
  return Number.isFinite(expMs) ? Math.min(t, expMs) : t;
}

/**
 * Strategy Builder legs -> priced book legs. `legs`: [{ kind, side, lots, lotSize?, strike, right, expiry, price, iv,
 * years }]; `ctx`: { lot, forward, nowMs }. A draft has no fills: avg is the leg price, so P&L now is 0 and a scenario
 * reads as the change from here.
 */
export function strategyBookLegs(legs, { lot = 1, forward = null, nowMs = 0 } = {}) {
  const F = num(forward);
  return (legs ?? [])
    .filter((l) => l && l.on !== false && num(l.price) !== null)
    .map((l) => {
      const units = (num(l.lots) ?? 0) * (num(l.lotSize) || lot || 1);
      const q = (l.side === "SELL" ? -1 : 1) * units;
      const fut = l.kind === "FUT";
      return {
        kind: fut ? "FUT" : "OPT",
        strike: fut ? null : num(l.strike),
        right: fut ? null : l.right,
        expiry: l.expiry ?? null,
        q,
        avg: num(l.price),
        mark: num(l.price),
        F: fut ? num(l.price) : F,
        iv: fut ? null : num(l.iv),
        T: num(l.years) ?? 0,
        t0: nowMs,
        priced: F !== null && (fut || num(l.iv) !== null),
        inc: true,
      };
    });
}

const counts = (l) => l && l.priced && l.inc !== false && num(l.q);

/** Margin legs (span-margin.js) of priced book legs at a scenario: marks revalued, IV shifted, futures moved. */
export function scenarioMarginLegs(legs, underlying, shift = {}) {
  const out = [];
  for (const l of legs ?? []) {
    if (!counts(l)) continue;
    const v = priceLeg(l, shift);
    const mark = v === null ? num(l.mark) : Math.max(0, v + legAdj(l, shift.days ?? 0));
    out.push({
      underlying,
      kind: l.kind === "FUT" ? "FUT" : "OPT",
      right: l.right ?? null,
      strike: num(l.strike),
      expiry: l.expiry,
      qty: l.q,
      // A long's premium is what it paid; the scan and exposure use the scenario.
      cost: l.q > 0 ? num(l.avg) ?? mark : mark,
      mark,
      iv: l.kind === "FUT" ? null : Math.max(0.5, (num(l.iv) ?? 0) + (num(shift.dIv) ?? 0)),
    });
  }
  return out;
}

/**
 * Every figure the what-if panel shows, now and at the scenario:
 * { pnl, pnl0, change, greeks, greeks0, margin, margin0, marginChange, legs (counted), spot (scenario spot) }.
 * `ctx`: { underlying, spot, nowMs, atmIv }. Margin is null without a forward.
 */
export function whatIfFigures(legs, w, { underlying = "", spot = null, nowMs = 0, atmIv = null } = {}) {
  const shift = { dS: (num(w?.pct) ?? 0) / 100, dIv: num(w?.dIv) ?? 0, days: num(w?.days) ?? 0 };
  const inc = (legs ?? []).filter(counts);
  const pnl0 = scenarioPnl(inc, {});
  const pnl = scenarioPnl(inc, shift);
  const greeks0 = scenarioGreeks(inc, {});
  const greeks = scenarioGreeks(inc, shift);
  const F = inc.find((l) => num(l.F) !== null)?.F ?? num(spot);
  let margin = null;
  let margin0 = null;
  if (F !== null && inc.length && underlying) {
    const ivs = num(atmIv) !== null ? { [underlying]: num(atmIv) } : {};
    margin0 = portfolioMargin(scenarioMarginLegs(inc, underlying, {}), { nowMs, forwards: { [underlying]: F }, ivs }).required;
    margin = portfolioMargin(scenarioMarginLegs(inc, underlying, shift), { nowMs: nowMs + shift.days * DAY_MS, forwards: { [underlying]: F * (1 + shift.dS) }, ivs: num(atmIv) !== null ? { [underlying]: Math.max(0.5, num(atmIv) + shift.dIv) } : {} }).required;
  }
  return {
    legs: inc.length,
    pnl,
    pnl0,
    change: pnl - pnl0,
    greeks,
    greeks0,
    margin,
    margin0,
    marginChange: margin !== null && margin0 !== null ? margin - margin0 : null,
    spot: num(spot) !== null ? num(spot) * (1 + shift.dS) : null,
  };
}
