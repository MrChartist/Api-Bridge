/**
 * Option Desk maths: what a trader reads off a chain at a glance (PCR, max pain, OI walls, the ATM straddle) and
 * the small helpers the order ticket needs. Pure (no DOM, no fetch) so it runs in Node tests; numbers are formatted
 * by format.js, never here.
 *
 * A chain is GET /v1/optionchain's data: { underlying, expiry, underlyingLtp, atmStrike, lotSize,
 * rows: [{ strike, ce: { ltp, bid, ask, oi, oiChange, volume, iv, delta, ... } | null, pe: {...} | null }] }.
 */

import { DASH, formatCompact, formatFixed, formatInt, formatRupee } from "./format.js";

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const sum = (rows, pick) => rows.reduce((a, r) => a + (num(pick(r)) ?? 0), 0);

/** The row whose strike is closest to `price` (the chain's own atmStrike when it has one). */
export function atmRow(chain) {
  const rows = chain?.rows ?? [];
  if (!rows.length) return null;
  const atm = num(chain.atmStrike);
  if (atm !== null) {
    const exact = rows.find((r) => r.strike === atm);
    if (exact) return exact;
  }
  const spot = num(chain.underlyingLtp);
  if (spot === null) return rows[Math.floor(rows.length / 2)];
  return rows.reduce((best, r) => (Math.abs(r.strike - spot) < Math.abs(best.strike - spot) ? r : best));
}

/**
 * Max pain: the expiry price at which option buyers, all strikes together, would collect the least (writers pay
 * the least). Only the strikes in `rows` count, so ask for a wide chain. See maxPainCurve for the coverage.
 */
export function maxPain(rows) {
  return maxPainCurve(rows)?.strike ?? null;
}

/** The strike with the most open interest on one side ("ce" = resistance, "pe" = support); null without OI. */
export function oiWall(rows, side) {
  let best = null;
  for (const r of rows) {
    const oi = num(r[side]?.oi);
    if (oi !== null && oi > 0 && (best === null || oi > best.oi)) best = { strike: r.strike, oi };
  }
  return best;
}

/**
 * Everything the summary strip shows, from the whole chain the Bridge returned.
 * @returns {{ spot: number|null, atm: number|null, straddle: number|null, upper: number|null, lower: number|null,
 *   atmIv: number|null, pcr: number|null, pcrVolume: number|null, pcrChange: number|null, ceOi: number, peOi: number,
 *   ceOiChange: number, peOiChange: number, ceVolume: number, peVolume: number, maxPain: number|null,
 *   resistance: {strike:number, oi:number}|null, support: {strike:number, oi:number}|null, maxOi: number,
 *   maxOiChange: number }}
 */
export function chainSummary(chain) {
  const rows = chain?.rows ?? [];
  const spot = num(chain?.underlyingLtp);
  const atm = atmRow(chain);
  const ceLtp = num(atm?.ce?.ltp);
  const peLtp = num(atm?.pe?.ltp);
  const straddle = ceLtp !== null && peLtp !== null ? ceLtp + peLtp : null;
  const ivs = [num(atm?.ce?.iv), num(atm?.pe?.iv)].filter((v) => v !== null && v > 0);
  const ceOi = sum(rows, (r) => r.ce?.oi);
  const peOi = sum(rows, (r) => r.pe?.oi);
  const ceVol = sum(rows, (r) => r.ce?.volume);
  const peVol = sum(rows, (r) => r.pe?.volume);
  const maxOi = rows.reduce((m, r) => Math.max(m, num(r.ce?.oi) ?? 0, num(r.pe?.oi) ?? 0), 0);
  return {
    spot,
    atm: atm?.strike ?? null,
    straddle,
    upper: straddle !== null && atm ? atm.strike + straddle : null,
    lower: straddle !== null && atm ? atm.strike - straddle : null,
    atmIv: ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null,
    pcr: ceOi > 0 ? peOi / ceOi : null,
    pcrVolume: ceVol > 0 ? peVol / ceVol : null,
    ceOi,
    peOi,
    ceOiChange: sum(rows, (r) => r.ce?.oiChange),
    peOiChange: sum(rows, (r) => r.pe?.oiChange),
    maxPain: maxPain(rows),
    resistance: oiWall(rows, "ce"),
    support: oiWall(rows, "pe"),
    maxOi,
    maxOiChange: rows.reduce((m, r) => Math.max(m, Math.abs(num(r.ce?.oiChange) ?? 0), Math.abs(num(r.pe?.oiChange) ?? 0)), 0),
    ceVolume: ceVol,
    peVolume: peVol,
    pcrChange: (() => {
      const c = sum(rows, (r) => r.ce?.oiChange);
      const p = sum(rows, (r) => r.pe?.oiChange);
      return c > 0 && p > 0 ? p / c : null;
    })(),
    /** Put OI added minus call OI added today: signed, so it reads even when one side is unwinding. */
    netOiChange: sum(rows, (r) => r.pe?.oiChange) - sum(rows, (r) => r.ce?.oiChange),
  };
}

/** `count` strikes either side of the ATM strike (all rows when there are fewer). */
export function rowsAroundAtm(chain, count) {
  const rows = chain?.rows ?? [];
  const atm = atmRow(chain);
  if (!atm) return [];
  const i = rows.indexOf(atm);
  return rows.slice(Math.max(0, i - count), i + count + 1);
}

/** Whether a strike is in the money for calls ("ce") or puts ("pe") at this spot. */
export const inTheMoney = (strike, side, spot) => (num(spot) === null ? false : side === "ce" ? strike < spot : strike > spot);

/**
 * Round a price to the instrument's tick (0.05 for NSE / BSE options) without float drift. "buy" rounds up and
 * "sell" down so a limit order at the touch is not pushed away from it; anything else rounds to the nearest tick.
 */
export function roundToTick(price, tick = 0.05, direction) {
  const p = num(price);
  const t = num(tick) && num(tick) > 0 ? num(tick) : 0.05;
  if (p === null) return null;
  const steps = p / t;
  const n = direction === "buy" ? Math.ceil(steps - 1e-9) : direction === "sell" ? Math.floor(steps + 1e-9) : Math.round(steps);
  return Math.round(n * t * 100) / 100;
}

/**
 * The price a ticket starts at: the ask to buy, the bid to sell (the touch), else the last price.
 * @param {{ bid?: number, ask?: number, ltp?: number } | null} quote
 * @param {"BUY"|"SELL"} side
 */
export function touchPrice(quote, side, tick = 0.05) {
  const p = side === "BUY" ? (num(quote?.ask) || num(quote?.ltp)) : (num(quote?.bid) || num(quote?.ltp));
  return roundToTick(p, tick, side === "BUY" ? "buy" : "sell");
}

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
/**
 * Time left to an expiry (YYYY-MM-DD, settling at 15:30 IST). `days` is fractional; `label` reads "Expires today",
 * "1 day", "6 days" or "Expired".
 */
export function timeToExpiry(expiry, now = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(expiry ?? ""));
  if (!m) return { days: null, label: "" };
  const close = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 15, 30) - IST_OFFSET_MS;
  const ms = close - now;
  if (ms <= 0) return { days: 0, label: "Expired" };
  const istDay = (t) => Math.floor((t + IST_OFFSET_MS) / 86400000);
  const calendarDays = istDay(close) - istDay(now);
  return { days: ms / 86400000, label: calendarDays === 0 ? "Expires today" : calendarDays === 1 ? "1 day" : `${calendarDays} days` };
}

/** Option positions on one underlying, from GET /v1/positions rows ("NFO:NIFTY-2026-11-03-26400-CE"). */
export function positionsFor(positions, underlying) {
  const u = String(underlying ?? "").toUpperCase();
  const re = new RegExp(`^(NFO|BFO):${u.replace(/[^A-Z0-9&]/g, "")}-\\d{4}-\\d{2}-\\d{2}-[\\d.]+-(CE|PE)$`);
  return (positions ?? []).filter((p) => re.test(String(p.symbol ?? "")));
}

/** "NFO:NIFTY-2026-11-03-26400-CE" → { strike: 26400, right: "CE", expiry: "2026-11-03" } (null when not an option). */
export function parseOptionSymbol(symbol) {
  const m = /^(?:NFO|BFO):(.+)-(\d{4}-\d{2}-\d{2})-([\d.]+)-(CE|PE)$/.exec(String(symbol ?? ""));
  return m ? { underlying: m[1], expiry: m[2], strike: Number(m[3]), right: m[4] } : null;
}

// ── Per-leg reads ──

/**
 * OI build-up from a leg's price change and OI change: LB long build-up (price up, OI up), SB short build-up (down,
 * up), SC short covering (up, down), LU long unwinding (down, down). Null when either change is missing or zero.
 */
export function buildup(leg) {
  const p = num(leg?.change);
  const oi = num(leg?.oiChange);
  if (p === null || oi === null || p === 0 || oi === 0) return null;
  if (oi > 0) return p > 0 ? "LB" : "SB";
  return p > 0 ? "SC" : "LU";
}
export const BUILDUP_NAMES = Object.freeze({ LB: "Long build-up", SB: "Short build-up", SC: "Short covering", LU: "Long unwinding", CH: "Churn" });

/** Mid of a two-sided quote, else the last price. */
export function mid(leg) {
  const b = num(leg?.bid);
  const a = num(leg?.ask);
  if (b !== null && a !== null && b > 0 && a >= b) return (a + b) / 2;
  return num(leg?.ltp);
}
/** Bid-ask spread as a percent of mid (null without a two-sided quote). */
export function spreadPct(leg) {
  const b = num(leg?.bid);
  const a = num(leg?.ask);
  const m = mid(leg);
  if (b === null || a === null || b <= 0 || a < b || !m) return null;
  return ((a - b) / m) * 100;
}
/** OI change as a percent of the previous session's OI. */
export function oiChangePct(leg) {
  const oi = num(leg?.oi);
  const ch = num(leg?.oiChange);
  if (oi === null || ch === null) return null;
  const prev = oi - ch;
  return prev > 0 ? (ch / prev) * 100 : null;
}
/** Price change as a percent of the previous close. */
export function changePct(leg) {
  const c = num(leg?.close);
  const ch = num(leg?.change);
  return c && ch !== null ? (ch / c) * 100 : null;
}
/**
 * Liquidity 1-5 from the spread (55%) and the leg's volume rank on its side (45%); 0 for a dead leg.
 * @param {number} volRank 0..1 percentile of this leg's volume among its side's legs
 */
export function liquidityScore(leg, volRank) {
  const vol = num(leg?.volume) ?? 0;
  const sp = spreadPct(leg);
  if (!vol && !num(leg?.oi) && sp === null) return 0;
  const spreadScore = sp === null ? 1 : sp <= 1 ? 5 : sp <= 2.5 ? 4 : sp <= 5 ? 3 : sp <= 10 ? 2 : 1;
  const volScore = 1 + Math.round(Math.max(0, Math.min(1, volRank || 0)) * 4);
  return Math.max(1, Math.min(5, Math.round(0.55 * spreadScore + 0.45 * volScore)));
}
/** strike -> volume percentile (0..1) for one side ("ce" / "pe"). */
export function volumeRanks(rows, side) {
  const vols = rows.map((r) => num(r[side]?.volume)).filter((v) => v !== null).sort((a, b) => a - b);
  const out = new Map();
  if (!vols.length) return out;
  for (const r of rows) {
    const v = num(r[side]?.volume);
    if (v === null) continue;
    let below = 0;
    while (below < vols.length && vols[below] < v) below += 1;
    out.set(r.strike, vols.length > 1 ? below / (vols.length - 1) : 1);
  }
  return out;
}

// ── Pricing (Black-76 on the forward, r = 0: what NSE index options settle against) ──

/** Standard normal CDF (Abramowitz-Stegun 26.2.17, |error| < 7.5e-8). */
export function normCdf(x) {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
/** Black-76 price of a CE / PE; intrinsic value at or after expiry or without a volatility. */
export function black76(forward, strike, years, ivPct, right) {
  const F = num(forward);
  const K = num(strike);
  const sig = (num(ivPct) ?? 0) / 100;
  if (F === null || K === null || F <= 0 || K <= 0) return null;
  const intrinsic = right === "CE" ? Math.max(0, F - K) : Math.max(0, K - F);
  if (!(years > 0) || !(sig > 0)) return intrinsic;
  const sd = sig * Math.sqrt(years);
  const d1 = (Math.log(F / K) + (sd * sd) / 2) / sd;
  const d2 = d1 - sd;
  return right === "CE" ? F * normCdf(d1) - K * normCdf(d2) : K * normCdf(-d2) - F * normCdf(-d1);
}
/** Probability the option finishes in the money (N(d2) on the forward). */
export function probItm(forward, strike, years, ivPct, right) {
  const F = num(forward);
  const K = num(strike);
  const sig = (num(ivPct) ?? 0) / 100;
  if (F === null || K === null || F <= 0 || K <= 0 || !(years > 0) || !(sig > 0)) return null;
  const sd = sig * Math.sqrt(years);
  const d2 = (Math.log(F / K) - (sd * sd) / 2) / sd;
  return right === "CE" ? normCdf(d2) : normCdf(-d2);
}
/** P(price at expiry < x) under the same log-normal model. */
function cdfAt(x, forward, years, sig) {
  if (x <= 0) return 0;
  const sd = sig * Math.sqrt(years);
  return normCdf((Math.log(x / forward) + (sd * sd) / 2) / sd);
}

/**
 * The forward the options price in: median of K + (C − P)·growth (put-call parity, mids; growth = e^(rT)) over the
 * three two-sided strikes nearest spot; spot when parity cannot be read.
 */
export function forwardPrice(chain, growth = 1) {
  const spot = num(chain?.underlyingLtp);
  const rows = [...(chain?.rows ?? [])].filter((r) => mid(r.ce) !== null && mid(r.pe) !== null && num(r.ce?.bid) && num(r.pe?.bid));
  if (spot === null) return null;
  rows.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  const f = rows.slice(0, 3).map((r) => r.strike + (mid(r.ce) - mid(r.pe)) * (num(growth) ?? 1)).sort((a, b) => a - b);
  return f.length ? f[Math.floor(f.length / 2)] : spot;
}
/** Years to expiry (15:30 IST), for pricing. */
export const yearsToExpiry = (expiry, now = Date.now()) => {
  const d = timeToExpiry(expiry, now).days;
  return d === null ? null : d / 365;
};
/** One-standard-deviation move of a log-normal price: half the width of the ±1σ band. */
export function sigmaMove(forward, ivPct, years) {
  const F = num(forward);
  const sig = (num(ivPct) ?? 0) / 100;
  if (F === null || !(sig > 0) || !(years > 0)) return null;
  const sd = sig * Math.sqrt(years);
  return (F * Math.exp(sd) - F * Math.exp(-sd)) / 2;
}
/** For each side, the strikes whose |delta| is nearest 0.16 and 0.30 (within 0.08): strike -> "16Δ" / "30Δ". */
export function deltaTargets(rows) {
  const out = { ce: new Map(), pe: new Map() };
  for (const side of ["ce", "pe"]) {
    for (const target of [0.16, 0.3]) {
      let best = null;
      for (const r of rows) {
        const d = num(r[side]?.delta);
        if (d === null) continue;
        const gap = Math.abs(Math.abs(d) - target);
        if (gap <= 0.08 && (best === null || gap < best.gap)) best = { strike: r.strike, gap };
      }
      if (best) out[side].set(best.strike, `${Math.round(target * 100)}Δ`);
    }
  }
  return out;
}

// ── Strategies ──

/**
 * A strategy leg (data model v2, PRD 02 §5): { id, kind: "OPT"|"FUT", right: "CE"|"PE"|null, strike: number|null,
 * expiry, symbol, lotSize, side: "BUY"|"SELL", lots, on, entry? }. For the maths a leg also carries `price` (entry per
 * unit; null = no price), `iv` (percent), `years` (to its own expiry, from now) and, on FUT legs, `basis0` (future −
 * spot now) and `futYears` (to the future's expiry). Legs with `on === false` count nowhere. P&L is in rupees for the
 * whole basket; units = lots × the leg's own lot size (the `lotSize` argument is the fallback).
 */
const legSign = (l) => (l.side === "SELL" ? -1 : 1);
const isFut = (l) => l?.kind === "FUT";
/** Units of a leg: whole lots × its own lot size (else the fallback). */
export const legUnits = (l, fallbackLot) => Math.max(0, Math.floor(num(l?.lots) ?? 0)) * (num(l?.lotSize) || num(fallbackLot) || 1);
/** The legs that count: switched-off legs are dropped before every calculation. */
export const activeLegs = (legs) => (legs ?? []).filter((l) => l && l.on !== false);
const intrinsicOf = (l, S) => (l.right === "CE" ? Math.max(0, S - l.strike) : Math.max(0, l.strike - S));
/** A future `el` years from now with the underlying at S: its basis to spot decays linearly to the future's expiry. */
function futValue(l, S, el = 0) {
  const b = num(l.basis0) ?? 0;
  const T = num(l.futYears);
  if (!(T > 0)) return S;
  return S + (b * Math.max(0, T - el)) / T;
}

/**
 * P&L at expiry (the first option expiry, `years` from now) if the underlying settles at `price`. FUT legs are marked
 * at S + their basis left at that date; an option leg that expires later is valued by Black-76 for its time left.
 */
export function payoffAt(legs, price, lotSize, { years = null, ivShift = 0 } = {}) {
  let t = 0;
  for (const l of legs) {
    if (l.on === false) continue;
    const u = legUnits(l, lotSize);
    const p = num(l.price) ?? 0;
    if (isFut(l)) {
      t += legSign(l) * (futValue(l, price, num(years) ?? 0) - p) * u;
      continue;
    }
    const rest = num(l.years) !== null && num(years) !== null ? l.years - years : 0;
    const v = rest > 1e-6 && num(l.iv) !== null ? black76(price, l.strike, rest, Math.max(1, l.iv + (num(ivShift) ?? 0)), l.right) : intrinsicOf(l, price);
    t += legSign(l) * (v - p) * u;
  }
  return t;
}
/**
 * Mark-to-model P&L with the underlying at `price`: Black-76 per option leg at its IV plus `ivShift` (floored at 1%),
 * r = 0. Back-compat form valueAt(legs, price, lot, years, basis): every leg has `years` left on forward price + basis.
 * With `el` (years from now to the target date) each leg uses its own `years` − el and the basis decays with the time
 * left (PRD 02 §6.4); a leg past its expiry by then is worth its intrinsic value. Null when an option leg has no IV.
 */
export function valueAt(legs, price, lotSize, years, basis = 0, { el = null, ivShift = 0 } = {}) {
  let t = 0;
  for (const l of legs) {
    if (l.on === false) continue;
    const u = legUnits(l, lotSize);
    const p = num(l.price) ?? 0;
    if (isFut(l)) {
      t += legSign(l) * (futValue(l, price, num(el) ?? 0) - p) * u;
      continue;
    }
    const Ti = num(l.years) ?? num(years) ?? 0;
    const Tt = el === null ? num(years) ?? 0 : Ti - el;
    let v;
    if (!(Tt > 1e-9)) v = intrinsicOf(l, el === null ? price + basis : price);
    else {
      if (num(l.iv) === null) return null;
      const fwd = el === null ? price + basis : price + (Ti > 0 ? (basis * Tt) / Ti : 0);
      v = black76(fwd, l.strike, Tt, Math.max(1, l.iv + (num(ivShift) ?? 0)), l.right);
      if (v === null) return null;
    }
    t += legSign(l) * (v - p) * u;
  }
  return t;
}
/** Net premium of the option legs: positive = you receive (credit), negative = you pay (debit). FUT legs carry none. */
export const netPremium = (legs, lotSize) => legs.reduce((a, l) => (l.on === false || isFut(l) ? a : a - legSign(l) * (num(l.price) ?? 0) * legUnits(l, lotSize)), 0);

/**
 * The expiry payoff as a function of S, net of charges when `charges` = { entry, exit(S) } is given.
 * @returns {(S: number) => number}
 */
export function strategyPayoff(legs, lotSize, { years = null, ivShift = 0, charges = null } = {}) {
  const act = activeLegs(legs);
  const gross = (S) => payoffAt(act, S, lotSize, { years, ivShift });
  if (!charges) return gross;
  return (S) => gross(S) - (num(charges.entry) ?? 0) - (typeof charges.exit === "function" ? charges.exit(S) : 0);
}

/**
 * Max profit / loss (null = unlimited), breakevens, chance of profit at expiry, stress loss and the locked P&L.
 * With every option leg expiring together the payoff is linear between strikes, so {0, every strike, 2 × the top
 * strike} is exact. A leg that expires later (a calendar) is valued by Black-76 and bends the curve: then ~400 points
 * over F·e^(±6σ√T) plus the strikes are sampled and each sign change is refined by bisection. Only a slope above the
 * top strike (calls and futures) is unlimited: below the bottom strike the price stops at 0, so a naked short put has a
 * finite worst case. Breakevens are sign changes, de-duplicated within 0.5 points. `charges` makes every figure net.
 * PoP integrates the log-normal (forward measure, σ = ATM IV + shift) over the profitable intervals.
 */
export function strategyStats(legs, lotSize, { forward = null, ivPct = null, years = null, ivShift = 0, spot = null, charges = null } = {}) {
  const act = activeLegs(legs);
  if (!act.length) return null;
  const T = num(years);
  const f = strategyPayoff(act, lotSize, { years: T, ivShift, charges });
  const strikes = [...new Set(act.filter((l) => !isFut(l)).map((l) => l.strike))].filter((k) => k > 0).sort((a, b) => a - b);
  const ref = num(spot) ?? num(forward) ?? num(act.find(isFut)?.price) ?? 0;
  const ivp0 = num(ivPct);
  const sig0 = ivp0 !== null && ivp0 > 0 ? Math.max(1, ivp0 + (num(ivShift) ?? 0)) / 100 : null;
  const laterLegs = T !== null && act.some((l) => !isFut(l) && num(l.years) !== null && l.years - T > 1e-6 && num(l.iv) !== null);
  let hi = 2 * Math.max(strikes.length ? strikes[strikes.length - 1] : 0, ref, 1);
  let pts;
  if (laterLegs) {
    const F0 = num(forward) ?? (ref > 0 ? ref : null);
    const Tmax = Math.max(T, ...act.map((l) => num(l.years) ?? 0));
    const w = F0 && sig0 && Tmax > 0 ? 6 * sig0 * Math.sqrt(Tmax) : null;
    const lo = w !== null ? Math.max(0, F0 * Math.exp(-w)) : 0;
    if (w !== null) hi = Math.max(F0 * Math.exp(w), strikes.length ? strikes[strikes.length - 1] * 1.01 : 0);
    const n = 400;
    const grid = Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n);
    pts = [...new Set([0, ...grid, ...strikes.filter((k) => k < hi)])].sort((a, b) => a - b);
  } else pts = [0, ...strikes.filter((k) => k < hi), hi];
  const vals = pts.map(f);
  let upSlope = act.reduce((a, l) => a + (isFut(l) || l.right === "CE" ? legSign(l) * legUnits(l, lotSize) : 0), 0);
  if (Math.abs(upSlope) < 1e-9) upSlope = 0;
  const maxProfit = upSlope > 0 ? null : Math.max(...vals);
  const maxLoss = upSlope < 0 ? null : Math.min(...vals);
  const cross = (a, b, fa, fb) => {
    if (!laterLegs) return a + ((b - a) * -fa) / (fb - fa);
    let x0 = a;
    let x1 = b;
    let f0 = fa;
    for (let k = 0; k < 50 && x1 - x0 > 0.01; k += 1) {
      const m = (x0 + x1) / 2;
      const fm = f(m);
      if ((fm < 0) === (f0 < 0)) {
        x0 = m;
        f0 = fm;
      } else x1 = m;
    }
    return (x0 + x1) / 2;
  };
  const raw = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = vals[i];
    const b = vals[i + 1];
    if (Math.abs(a) < 0.5 && Math.abs(b) < 0.5) raw.push(pts[i], pts[i + 1]);
    else if (a === 0) raw.push(pts[i]);
    else if ((a < 0 && b > 0) || (a > 0 && b < 0)) raw.push(cross(pts[i], pts[i + 1], a, b));
  }
  const last = vals[vals.length - 1];
  if (last === 0) raw.push(hi);
  else if (upSlope !== 0 && Math.sign(last) !== Math.sign(upSlope)) raw.push(hi - last / upSlope);
  const breakevens = [];
  for (const b of raw.filter((x) => x > 0).sort((x, y) => x - y)) if (!breakevens.length || b - breakevens[breakevens.length - 1] > 0.5) breakevens.push(b);
  const F = num(forward);
  const ivp = num(ivPct);
  const sigPct = ivp !== null && ivp > 0 ? Math.max(1, ivp + (num(ivShift) ?? 0)) : null;
  let pop = null;
  if (F && F > 0 && T !== null && T <= 0) pop = f(num(spot) ?? F) > 0 ? 1 : 0;
  else if (F && F > 0 && sigPct && T > 0) {
    const sig = sigPct / 100;
    const cuts = [0, ...breakevens, Infinity];
    pop = 0;
    for (let i = 0; i < cuts.length - 1; i += 1) {
      const a = cuts[i];
      const b = cuts[i + 1];
      const probe = b === Infinity ? Math.max(a * 1.5, hi * 2) : a === 0 ? b / 2 : (a + b) / 2;
      if (f(probe) > 0) pop += (b === Infinity ? 1 : cdfAt(b, F, T, sig)) - cdfAt(a, F, T, sig);
    }
    pop = Math.max(0, Math.min(1, pop));
  }
  let stress = null;
  if (maxLoss === null && F && sigPct && T > 0) {
    const price = F * Math.exp(2 * (sigPct / 100) * Math.sqrt(T));
    stress = { price, value: f(price) };
  }
  const net = netPremium(act, lotSize);
  const locked = maxProfit !== null && maxLoss !== null && maxProfit - maxLoss < Math.max(1, 0.001 * Math.abs(net)) ? (maxProfit + maxLoss) / 2 : null;
  return { maxProfit, maxLoss, breakevens, pop, net, upSlope, stress, locked, topStrike: strikes.length ? strikes[strikes.length - 1] : null };
}
/** Net Greeks of a basket from the chain's own greeks (delta in units of the underlying, theta and vega in rupees). */
export function netGreeks(legs, chain) {
  const lotSize = num(chain?.lotSize) || 1;
  const out = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  for (const l of activeLegs(legs)) {
    if (isFut(l)) {
      out.delta += legSign(l) * legUnits(l, lotSize);
      continue;
    }
    const row = chain?.rows?.find((r) => r.strike === l.strike);
    const q = row?.[l.right.toLowerCase()];
    for (const k of Object.keys(out)) out[k] += legSign(l) * (num(q?.[k]) ?? 0) * legUnits(l, lotSize);
  }
  return out;
}

/**
 * Ready-made strategies (PRD 02 §7): 30 in five view groups. `risk` is the shape of the worst case; `needsFut` presets
 * hold a future and stay disabled until one is found.
 */
export const PRESET_GROUPS = Object.freeze([
  ["bull", "Bullish"],
  ["bear", "Bearish"],
  ["neutral", "Neutral"],
  ["vol", "Volatile"],
  ["hedge", "Hedge & arb"],
]);
const P = (id, name, group, risk, hint, needsFut = false) => Object.freeze({ id, name, group, risk, needsFut, hint, view: hint });
export const PRESETS = Object.freeze([
  P("long-call", "Long call", "bull", "defined", "Up, with leverage"),
  P("bull-call", "Bull call spread", "bull", "defined", "Moderately up, cheaper"),
  P("bull-put", "Bull put spread", "bull", "defined", "Not down: collect a credit"),
  P("short-put", "Short put", "bull", "undefined", "Not down: income, large downside"),
  P("call-ratio-back", "Call ratio back spread", "bull", "defined", "A sharp rise"),
  P("long-synthetic", "Long synthetic", "bull", "undefined", "Like a long future"),
  P("risk-reversal", "Risk reversal", "bull", "undefined", "Up, financed by a put"),
  P("long-put", "Long put", "bear", "defined", "Down, with leverage"),
  P("bear-put", "Bear put spread", "bear", "defined", "Moderately down, cheaper"),
  P("bear-call", "Bear call spread", "bear", "defined", "Not up: collect a credit"),
  P("short-call", "Short call", "bear", "undefined", "Not up: income, unlimited upside risk"),
  P("put-ratio-back", "Put ratio back spread", "bear", "defined", "A sharp fall"),
  P("short-synthetic", "Short synthetic", "bear", "undefined", "Like a short future"),
  P("bear-risk-reversal", "Bear risk reversal", "bear", "undefined", "Down, financed by a call"),
  P("short-straddle", "Short straddle", "neutral", "undefined", "Stays near ATM"),
  P("short-strangle", "Short strangle", "neutral", "undefined", "Stays in a range"),
  P("iron-condor", "Iron condor", "neutral", "defined", "Range, defined risk"),
  P("iron-fly", "Iron fly", "neutral", "defined", "Pins near ATM, defined risk"),
  P("long-call-fly", "Long call butterfly", "neutral", "defined", "Pins at ATM, cheap"),
  P("jade-lizard", "Jade lizard", "neutral", "undefined", "Range to up, no upside risk"),
  P("long-straddle", "Long straddle", "vol", "defined", "A big move either way"),
  P("long-strangle", "Long strangle", "vol", "defined", "A bigger move, cheaper"),
  P("reverse-iron-condor", "Reverse iron condor", "vol", "defined", "Breaks out of a range"),
  P("reverse-iron-fly", "Reverse iron fly", "vol", "defined", "Moves away from ATM"),
  P("protective-put", "Protective put", "hedge", "defined", "Long future with a floor", true),
  P("covered-call", "Covered call", "hedge", "undefined", "Long future, sell the upside", true),
  P("collar", "Collar", "hedge", "defined", "Long future with a floor and a cap", true),
  P("conversion", "Conversion", "hedge", "defined", "Arbitrage: long future, short synthetic", true),
  P("reversal", "Reversal", "hedge", "defined", "Arbitrage: short future, long synthetic", true),
  P("box", "Box", "hedge", "defined", "Arbitrage: a riskless spread at a price"),
]);

/**
 * Legs for a preset around the forward: OPT legs { right, strike, side, lots } and, for futures presets,
 * { kind: "FUT", right: null, strike: null, side, lots, symbol, expiry, lotSize } from `fut`. Strikes beyond the
 * fetched rows are clamped to the outermost listed one. A futures preset without `fut` returns [].
 * @param {{ move?: number|null, forward?: number|null, fut?: { symbol: string, expiry: string, lotSize?: number }|null }} [o]
 */
export function presetLegs(id, chain, { move = null, forward = null, fut = null } = {}) {
  const rows = chain?.rows ?? [];
  const atm = atmRow(chain);
  if (!atm || !rows.length) return [];
  const meta = PRESETS.find((p) => p.id === id);
  if (!meta) return [];
  if (meta.needsFut && !fut?.symbol) return [];
  const strikes = rows.map((r) => r.strike).sort((a, b) => a - b);
  const step = strikes.length > 1 ? Math.min(...strikes.slice(1).map((s, i) => s - strikes[i]).filter((d) => d > 0)) : 50;
  const near = (x) => strikes.reduce((b, s) => (Math.abs(s - x) < Math.abs(b - x) ? s : b), strikes[0]);
  const clamp = (k) => Math.max(strikes[0], Math.min(strikes[strikes.length - 1], k));
  const m = num(move) && move > 0 ? move : step * 4;
  const K0 = atm.strike;
  const F = num(forward) ?? K0;
  const Kc1 = clamp(Math.max(near(F + m), K0 + step));
  const Kp1 = clamp(Math.min(near(F - m), K0 - step));
  const w = Math.max(step, Math.round(m / 2 / step) * step);
  const W = Math.max(step, Math.round(m / step) * step);
  const L = (right, strike, side, lots = 1) => ({ right, strike: clamp(near(strike)), side, lots });
  const FUT = (side) => ({ kind: "FUT", right: null, strike: null, side, lots: 1, symbol: fut.symbol, expiry: fut.expiry ?? null, lotSize: num(fut.lotSize) ?? null });
  switch (id) {
    case "long-call": return [L("CE", K0, "BUY")];
    case "bull-call": return [L("CE", K0, "BUY"), L("CE", Kc1, "SELL")];
    case "bull-put": return [L("PE", K0, "SELL"), L("PE", Kp1, "BUY")];
    case "short-put": return [L("PE", Kp1, "SELL")];
    case "call-ratio-back": return [L("CE", K0, "SELL", 1), L("CE", Kc1, "BUY", 2)];
    case "long-synthetic": return [L("CE", K0, "BUY"), L("PE", K0, "SELL")];
    case "risk-reversal": return [L("CE", Kc1, "BUY"), L("PE", Kp1, "SELL")];
    case "long-put": return [L("PE", K0, "BUY")];
    case "bear-put": return [L("PE", K0, "BUY"), L("PE", Kp1, "SELL")];
    case "bear-call": return [L("CE", K0, "SELL"), L("CE", Kc1, "BUY")];
    case "short-call": return [L("CE", Kc1, "SELL")];
    case "put-ratio-back": return [L("PE", K0, "SELL", 1), L("PE", Kp1, "BUY", 2)];
    case "short-synthetic": return [L("CE", K0, "SELL"), L("PE", K0, "BUY")];
    case "bear-risk-reversal": return [L("PE", Kp1, "BUY"), L("CE", Kc1, "SELL")];
    case "short-straddle": return [L("CE", K0, "SELL"), L("PE", K0, "SELL")];
    case "short-strangle": return [L("CE", Kc1, "SELL"), L("PE", Kp1, "SELL")];
    case "iron-condor": return [L("PE", Kp1 - w, "BUY"), L("PE", Kp1, "SELL"), L("CE", Kc1, "SELL"), L("CE", Kc1 + w, "BUY")];
    case "iron-fly": return [L("PE", K0 - W, "BUY"), L("PE", K0, "SELL"), L("CE", K0, "SELL"), L("CE", K0 + W, "BUY")];
    case "long-call-fly": return [L("CE", K0 - W, "BUY"), L("CE", K0, "SELL", 2), L("CE", K0 + W, "BUY")];
    case "jade-lizard": return [L("PE", Kp1, "SELL"), L("CE", Kc1, "SELL"), L("CE", Kc1 + w, "BUY")];
    case "long-straddle": return [L("CE", K0, "BUY"), L("PE", K0, "BUY")];
    case "long-strangle": return [L("CE", Kc1, "BUY"), L("PE", Kp1, "BUY")];
    case "reverse-iron-condor": return [L("PE", Kp1 - w, "SELL"), L("PE", Kp1, "BUY"), L("CE", Kc1, "BUY"), L("CE", Kc1 + w, "SELL")];
    case "reverse-iron-fly": return [L("PE", K0 - W, "SELL"), L("PE", K0, "BUY"), L("CE", K0, "BUY"), L("CE", K0 + W, "SELL")];
    case "protective-put": return [FUT("BUY"), L("PE", F - m / 2, "BUY")];
    case "covered-call": return [FUT("BUY"), L("CE", Kc1, "SELL")];
    case "collar": return [FUT("BUY"), L("PE", Kp1, "BUY"), L("CE", Kc1, "SELL")];
    case "conversion": return [FUT("BUY"), L("PE", K0, "BUY"), L("CE", K0, "SELL")];
    case "reversal": return [FUT("SELL"), L("PE", K0, "SELL"), L("CE", K0, "BUY")];
    case "box": return [L("CE", K0, "BUY"), L("CE", Kc1, "SELL"), L("PE", Kc1, "BUY"), L("PE", K0, "SELL")];
    default: return [];
  }
}

// ── Persona reads (the numbers a buyer, seller, hedger or arbitrageur decides on) ──

/** Breakeven at expiry for a long option bought at `premium`: CE K + P, PE K − P (null when P is missing or BE ≤ 0). */
export function breakeven(strike, right, premium) {
  const K = num(strike);
  const P = num(premium);
  if (K === null || P === null) return null;
  const be = right === "CE" ? K + P : K - P;
  return be > 0 ? be : null;
}
/**
 * A buyer's chance of profit at expiry: P(S_T beyond the breakeven) under the log-normal model on the forward. At
 * or after expiry (T ≤ 0) it is 1 or 0 from where the forward stands against the breakeven.
 */
export function chanceOfProfit(forward, strike, years, ivPct, right, premium) {
  const F = num(forward);
  const be = breakeven(strike, right, premium);
  if (F === null || be === null) return null;
  if (!(years > 0)) return (right === "CE" ? F > be : F < be) ? 1 : 0;
  if (!(num(ivPct) > 0)) return null;
  return probItm(F, be, years, ivPct, right);
}
/** Distance from spot, out-of-the-money positive (CE: K − S, PE: S − K): { pts, pct }. */
export function distance(strike, right, spot) {
  const K = num(strike);
  const S = num(spot);
  if (K === null || S === null || S <= 0) return null;
  const pts = right === "CE" ? K - S : S - K;
  return { pts, pct: (pts / S) * 100 };
}
/** The same distance in standard deviations of the log price to expiry (CE ln(K/F), PE ln(F/K), over σ√T). */
export function sigmaDistance(strike, right, forward, atmIvPct, years) {
  const K = num(strike);
  const F = num(forward);
  const sig = (num(atmIvPct) ?? 0) / 100;
  if (K === null || F === null || K <= 0 || F <= 0 || !(sig > 0) || !(years > 0)) return null;
  const sd = sig * Math.sqrt(years);
  return (right === "CE" ? Math.log(K / F) : Math.log(F / K)) / sd;
}
/** The log-normal ±kσ band to expiry: { lo: F·e^(−kσ√T), hi: F·e^(kσ√T) } (lo · hi = F²). */
export function sigmaBand(forward, ivPct, years, k = 1) {
  const F = num(forward);
  const sig = (num(ivPct) ?? 0) / 100;
  if (F === null || F <= 0 || !(sig > 0) || !(years > 0)) return null;
  const sd = k * sig * Math.sqrt(years);
  return { lo: F * Math.exp(-sd), hi: F * Math.exp(sd) };
}
/**
 * Time value against the forward: P − max(0, ±(F − K)). Not clamped: a negative value means the premium is below
 * intrinsic on the forward (a parity break or a stale quote).
 */
export function extrinsic(strike, right, premium, forward) {
  const K = num(strike);
  const P = num(premium);
  const F = num(forward);
  if (K === null || P === null || F === null) return null;
  return P - Math.max(0, right === "CE" ? F - K : K - F);
}
const twoSided = (q) => num(q?.bid) !== null && num(q?.ask) !== null && q.bid > 0 && q.ask >= q.bid;
/** Risk-free rate the exchange-style pricing assumes (NSE uses about the 91-day T-bill; the demo prices at 6.5%). */
export const RISK_FREE = 0.065;
/** e^(rT): turns a present-value option spread into forward points (put-call parity: C − P = (F − K)·e^(−rT)). */
export const parityGrowth = (years, rate = RISK_FREE) => (num(years) !== null && years > 0 ? Math.exp(rate * years) : 1);
/**
 * The synthetic future at one strike (put-call parity, F = K + (C − P)·e^(rT)): `mid` from mids (or last prices),
 * and the executable prices when both legs are two-sided: `buy` = K + (C.ask − P.bid)·g (buy the call, sell the
 * put), `sell` = K + (C.bid − P.ask)·g. `growth` = e^(rT) (parityGrowth); 1 ignores carry.
 */
export function synthetic(row, growth = 1) {
  const K = num(row?.strike);
  const c = mid(row?.ce);
  const p = mid(row?.pe);
  const g = num(growth) ?? 1;
  if (K === null || c === null || p === null) return null;
  const exec = twoSided(row.ce) && twoSided(row.pe);
  return { mid: K + (c - p) * g, buy: exec ? K + (row.ce.ask - row.pe.bid) * g : null, sell: exec ? K + (row.ce.bid - row.pe.ask) * g : null, twoSided: exec };
}
/**
 * The parity edge at the touch against a reference future R, gross of costs: a conversion (sell the synthetic, buy
 * the future at its ask) earns syn.sell − R.ask; a reversal (buy the synthetic, sell the future at its bid) earns
 * R.bid − syn.buy. `reference` is a future quote { bid, ask } (null without a two-sided quote) or a plain price (the
 * chain's own forward, used for both sides). Returns the better of the two (usually ≤ 0), or null.
 */
export function parityEdge(row, reference, growth = 1) {
  let bid;
  let ask;
  if (reference !== null && typeof reference === "object") {
    if (!twoSided(reference)) return null;
    bid = Number(reference.bid);
    ask = Number(reference.ask);
  } else {
    bid = ask = num(reference);
  }
  const syn = synthetic(row, growth);
  if (bid === null || !syn?.twoSided) return null;
  const conv = syn.sell - ask;
  const rev = bid - syn.buy;
  return conv >= rev ? { edge: conv, kind: "conv" } : { edge: rev, kind: "rev" };
}
/** The `n` strikes with the most OI on one side, rank 1 first (ties keep the lower strike; OI 0 is left out). */
export function topOi(rows, side, n = 3) {
  return (rows ?? [])
    .map((r) => ({ strike: r.strike, oi: num(r[side]?.oi) ?? 0 }))
    .filter((r) => r.oi > 0)
    .sort((a, b) => b.oi - a.oi || a.strike - b.strike)
    .slice(0, n)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}
/**
 * Lots of this option that neutralise `netDelta` (units of the underlying): ceil(|netDelta| / (|delta| · lot)), only
 * when the option's delta has the opposite sign. Null for a same-sign leg, a tiny delta (< 0.02) or no delta to hedge.
 */
export function hedgeLots(netDelta, delta, lot) {
  const nd = num(netDelta);
  const d = num(delta);
  const L = num(lot) || 1;
  if (nd === null || nd === 0 || d === null || Math.abs(d) < 0.02 || Math.sign(d) === Math.sign(nd)) return null;
  return Math.ceil(Math.abs(nd) / (Math.abs(d) * L) - 1e-9);
}

/**
 * "Go to strike": what a trader types, to a listed strike (null when it means nothing).
 *   26400 → nearest strike · 264 → the strike starting 264… nearest ATM · +3 / -2 → strikes above / below ATM ·
 *   1s, -2σ, +1.5sd → nearest F·e^(kσ√T) · atm · mp / max pain.
 * @param {{ strikes: number[], atm: number|null, F: number|null, sigmaPts: number|null, maxPain: number|null }} ctx
 *   strikes sorted ascending; sigmaPts = σ_ATM·√T·F (one σ in points).
 */
export function strikeQuery(text, ctx) {
  const t = String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const strikes = ctx?.strikes ?? [];
  if (!t || !strikes.length) return null;
  const nearest = (x) => strikes.reduce((b, k) => (Math.abs(k - x) < Math.abs(b - x) ? k : b), strikes[0]);
  const atm = num(ctx.atm) ?? strikes[Math.floor(strikes.length / 2)];
  if (t === "atm") return nearest(atm);
  if (t === "mp" || t === "max pain" || t === "maxpain") return num(ctx.maxPain) === null ? null : nearest(ctx.maxPain);
  let m = /^([+-]?)(\d*\.?\d+) ?(s|σ|sd|sigma)$/.exec(t);
  if (m) {
    const F = num(ctx.F);
    const sp = num(ctx.sigmaPts);
    if (F === null || F <= 0 || sp === null || sp <= 0) return null;
    const k = Number(m[2]) * (m[1] === "-" ? -1 : 1);
    return nearest(F * Math.exp((k * sp) / F));
  }
  m = /^([+-])(\d+)$/.exec(t);
  if (m) {
    const i = strikes.indexOf(nearest(atm));
    const j = i + Number(m[2]) * (m[1] === "-" ? -1 : 1);
    return strikes[Math.max(0, Math.min(strikes.length - 1, j))];
  }
  m = /^\d+(\.\d+)?$/.exec(t);
  if (!m) return null;
  const n = Number(t);
  if (!(n > 0)) return null;
  const digits = String(Math.round(atm)).length;
  if (!m[1] && t.length < digits) {
    const hits = strikes.filter((k) => String(Math.round(k)).startsWith(t));
    if (hits.length) return hits.reduce((b, k) => (Math.abs(k - atm) < Math.abs(b - atm) ? k : b), hits[0]);
    return null;
  }
  return nearest(n);
}

/** True on the expiry date (IST) before the 15:30 IST settlement. */
export function isExpiryDay(expiry, now = Date.now()) {
  const t = timeToExpiry(expiry, now);
  return t.days !== null && t.days > 0 && t.label === "Expires today";
}
/** The monthly expiry: the last of the listed expiries in its calendar month. */
export function isMonthlyExpiry(expiry, expiries) {
  const e = String(expiry ?? "");
  const month = e.slice(0, 7);
  const same = (expiries ?? []).filter((x) => String(x).slice(0, 7) === month).sort();
  return same.length > 0 && same[same.length - 1] === e;
}

/**
 * Advisory warnings before an order (the Bridge's own checks still decide): [{ level: "warn"|"bad", code, text }].
 * @param {{ side: "BUY"|"SELL", right: "CE"|"PE", leg: object|null, lots: number, lot: number, freezeQty?: number|null,
 *   liq?: number|null, stale?: boolean, isExpiryDay?: boolean, itm?: boolean, intrinsic?: number|null,
 *   hasLongSameExpiry?: boolean, orderType?: "LIMIT"|"MARKET", years?: number|null, exit?: boolean }} i
 */
export function tradeWarnings(i) {
  const out = [];
  const add = (level, code, text) => out.push({ level, code, text });
  const leg = i?.leg ?? null;
  const lot = num(i?.lot) || 1;
  const lots = Math.max(1, Math.floor(num(i?.lots) ?? 1));
  const qty = lots * lot;
  const sp = spreadPct(leg);
  const P = mid(leg);
  if (sp !== null && sp > 5) add(sp > 10 ? "bad" : "warn", "WIDE_SPREAD", `Spread ${formatFixed(sp, 1)}% of mid: use a limit order`);
  if (num(i?.liq) !== null && i.liq > 0 && i.liq <= 2) add("warn", "ILLIQUID", "Thin strike: you may not get out at a fair price");
  if (i?.orderType === "MARKET" && sp !== null && sp > 2) add("bad", "MARKET_ILLIQUID", "Market order on a wide spread");
  if (leg && !(num(leg.bid) > 0 && num(leg.ask) > 0)) add("warn", "ONE_SIDED", "One-sided quote");
  if (i?.stale) add("bad", "STALE", "Quotes are stale: prices may have moved");
  if (num(i?.freezeQty) > 0 && qty > i.freezeQty) add("warn", "FREEZE", `Above freeze qty ${formatInt(i.freezeQty)}: the order will be split or rejected`);
  if (i?.side === "SELL" && !i.exit && !i.hasLongSameExpiry) add("warn", "NAKED_SHORT", `Uncovered short: margin is blocked and losses are ${i.right === "CE" ? "unlimited" : "large"}`);
  if (i?.isExpiryDay && i.side === "SELL" && !i.exit) add("warn", "EXPIRY_ELM", "Expiry day: +2% ELM on index option shorts");
  const intrinsic = num(i?.intrinsic);
  if (i?.isExpiryDay && i.itm && intrinsic !== null && intrinsic > 0 && ((i.side === "BUY" && !i.exit) || (i.side === "SELL" && i.exit))) {
    add("warn", "EXPIRY_STT", `ITM at expiry: exercise STT 0.125% of intrinsic (≈ ${formatRupee(0.00125 * intrinsic * qty, 0)}) vs 0.1% of premium if you square off (≈ ${formatRupee(0.001 * (P ?? 0) * qty, 0)})`);
  }
  const theta = num(leg?.theta);
  if (i?.side === "BUY" && !i.exit && num(i?.years) !== null && i.years < 1 / 365 && theta !== null && P && Math.abs(theta * lot) > 0.15 * P * lot) {
    add("warn", "THETA_0DTE", `Time decay ${formatRupee(Math.abs(theta * lot), 0)} per lot today`);
  }
  return out;
}

// ── OI analysis (the #/oi page) ──
//
// Everything here reads "window rows" (oiWindowRows): per strike and side, OI now and at the window's reference
// (the previous close, or a snapshot this page recorded), the change between them, the price change and the volume
// in the window. Quantities stay in contract units; the page divides by the lot size to show lots.

const SESSION_OPEN = 9 * 60 + 15;
const SESSION_CLOSE = 15 * 60 + 30;
const IST_HM = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
/** "10:42" in IST for an epoch-ms time ("--" when missing). */
export const istHm = (ms) => (Number.isFinite(ms) ? IST_HM.format(new Date(ms)) : DASH);
/** The IST calendar date ("YYYY-MM-DD"), weekday (0 = Sunday) and minutes since IST midnight of an epoch-ms time. */
export function istClock(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), dow: d.getUTCDay(), mins: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/**
 * Where the cash session stands (NSE / BSE, IST Monday to Friday 09:15–15:30): phase "pre" before the open on a
 * weekday, "open" in the session, "closed" after it and at weekends. Exchange holidays are not known: on a holiday
 * this says "open", but no fresh quote time arrives, so the snapshot recorder still writes nothing.
 */
export function marketSession(nowMs = Date.now()) {
  const c = istClock(nowMs);
  const weekday = c.dow >= 1 && c.dow <= 5;
  const phase = !weekday ? "closed" : c.mins < SESSION_OPEN ? "pre" : c.mins < SESSION_CLOSE ? "open" : "closed";
  return { phase, istDate: c.date, weekday, label: phase === "open" ? "Market open" : phase === "pre" ? "Before the open · last session" : "Market closed · last session" };
}

/** Trading sessions left to an expiry, counting weekdays, today included while the session has not closed. */
export function sessionsLeft(expiry, now = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(expiry ?? ""));
  if (!m) return null;
  const exp = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
  const today = Math.floor((now + IST_OFFSET_MS) / 86400000);
  const afterClose = istClock(now).mins >= SESSION_CLOSE;
  let n = 0;
  for (let d = today; d <= exp && d - today < 800; d += 1) {
    const dow = (d + 4) % 7; // 1970-01-01 was a Thursday
    if (dow === 0 || dow === 6 || (d === today && afterClose)) continue;
    n += 1;
  }
  return n;
}
/** How much max pain matters: "high" with ≤ 2 sessions left, "medium" with ≤ 5, else "low" (null without an expiry). */
export function maxPainRelevance(expiry, now = Date.now()) {
  const n = sessionsLeft(expiry, now);
  return n === null ? null : n <= 2 ? "high" : n <= 5 ? "medium" : "low";
}

/**
 * Max pain with its coverage: for each listed strike K, pain(K) = Σ CE_OI·max(0, K − k) + Σ PE_OI·max(0, k − K).
 * `strike` is the argmin (a tie goes to the strike nearest `spot`, then the lower one); `edge` is true when it is the
 * first or last listed strike (the chain may be partial). Null with fewer than 3 strikes carrying OI, or no OI.
 * @returns {{ strike: number, curve: {strike:number, pain:number}[], n: number, lo: number, hi: number, edge: boolean } | null}
 */
export function maxPainCurve(rows, spot = null) {
  const list = (rows ?? []).filter((r) => num(r?.strike) !== null).slice().sort((a, b) => a.strike - b.strike);
  const withOi = list.filter((r) => num(r.ce?.oi) !== null || num(r.pe?.oi) !== null);
  if (withOi.length < 3) return null;
  const legs = list.map((r) => [r.strike, num(r.ce?.oi) ?? 0, num(r.pe?.oi) ?? 0]);
  if (!legs.some((l) => l[1] > 0 || l[2] > 0)) return null;
  const s = num(spot);
  const curve = [];
  let best = null;
  for (const [K] of legs) {
    let pain = 0;
    for (const [k, co, po] of legs) {
      if (K > k) pain += co * (K - k);
      else if (k > K) pain += po * (k - K);
    }
    curve.push({ strike: K, pain });
    if (best === null || pain < best.pain) best = { strike: K, pain };
    else if (pain === best.pain && s !== null && Math.abs(K - s) < Math.abs(best.strike - s)) best = { strike: K, pain };
  }
  const lo = list[0].strike;
  const hi = list[list.length - 1].strike;
  return { strike: best.strike, curve, n: withOi.length, lo, hi, edge: best.strike === lo || best.strike === hi };
}

/**
 * The single input of every OI read: per strike and side { symbol, oi, oiRef, d, dPct, ltp, ltpRef, dLtp, v }.
 * Without a reference snapshot it uses the previous close (d = leg.oiChange, dLtp = leg.change, v = day volume); with
 * one, a strike missing from the snapshot is new (oiRef 0, ltpRef null) and v = volume since then (never below 0).
 * @param {object} chain GET /v1/optionchain data
 * @param {{ k:number[], co:(number|null)[], po:(number|null)[], cl:(number|null)[], pl:(number|null)[], cv:(number|null)[], pv:(number|null)[] } | null} ref
 */
export function oiWindowRows(chain, ref = null) {
  const rows = chain?.rows ?? [];
  const idx = ref?.k ? new Map(ref.k.map((k, i) => [k, i])) : null;
  return rows.map((r) => {
    const out = { strike: r.strike };
    for (const side of ["ce", "pe"]) {
      const q = r[side];
      if (!q) {
        out[side] = null;
        continue;
      }
      const oi = num(q.oi);
      const ltp = num(q.ltp);
      const vol = num(q.volume);
      let oiRef;
      let ltpRef;
      let dLtp;
      let v;
      if (!idx) {
        const ch = num(q.oiChange);
        const pc = num(q.change);
        oiRef = oi !== null && ch !== null ? oi - ch : null;
        dLtp = pc;
        ltpRef = ltp !== null && pc !== null ? ltp - pc : num(q.close);
        v = vol;
      } else {
        const i = idx.get(r.strike);
        const p = side === "ce" ? "c" : "p";
        if (i === undefined) {
          oiRef = oi === null ? null : 0;
          ltpRef = null;
          v = null;
        } else {
          oiRef = num(ref[`${p}o`]?.[i]);
          ltpRef = num(ref[`${p}l`]?.[i]);
          const vr = num(ref[`${p}v`]?.[i]);
          v = vol !== null && vr !== null ? Math.max(0, vol - vr) : null;
        }
        dLtp = ltp !== null && ltpRef !== null ? ltp - ltpRef : null;
      }
      const d = oi !== null && oiRef !== null ? oi - oiRef : null;
      out[side] = { symbol: q.symbol ?? null, oi, oiRef, d, dPct: d !== null && oiRef > 0 ? (d / oiRef) * 100 : null, ltp, ltpRef, dLtp, v };
    }
    return out;
  });
}

/**
 * PCR words, writer view (Indian convention: heavy put OI = put writing below spot = support). Checked in order:
 * the first band whose test passes names the ratio. Per-index baselines come later.
 */
export const PCR_BANDS = Object.freeze([
  Object.freeze({ min: 1.5, strict: false, word: "very put-heavy (extreme)", extreme: true }),
  Object.freeze({ min: 1.2, strict: false, word: "put-heavy", extreme: false }),
  Object.freeze({ min: 0.8, strict: true, word: "balanced", extreme: false }),
  Object.freeze({ min: 0.6, strict: true, word: "call-heavy", extreme: false }),
  Object.freeze({ min: Number.NEGATIVE_INFINITY, strict: false, word: "very call-heavy (extreme)", extreme: true }),
]);
/** The PCR_BANDS entry for a ratio (null without one). */
export function pcrBand(v) {
  const x = num(v);
  if (x === null) return null;
  return PCR_BANDS.find((b) => (b.strict ? x > b.min : x >= b.min)) ?? null;
}
/** What a ΔOI PCR that is not a ratio means. */
export const PCR_CHANGE_TEXT = Object.freeze({
  "put-add-call-cut": "Puts added, calls cut: supportive",
  "call-add-put-cut": "Calls added, puts cut: capping",
  "both-cut": "Both sides unwinding",
  flat: "No change",
});
/**
 * Put-call ratios over window rows: `oi` = ΣPE OI ÷ ΣCE OI, `vol` = ΣPE V ÷ ΣCE V (null when the call side is 0), and
 * `chg` for ΔOI: { ratio, kind, p, c } with p = ΣPE ΔOI and c = ΣCE ΔOI (a missing ΔOI counts 0). Only when both
 * sides added is it a ratio; otherwise `kind` says what happened. `chg` is null when no leg has a ΔOI.
 */
export function pcrSet(rows) {
  let co = 0;
  let po = 0;
  let cv = 0;
  let pv = 0;
  let c = 0;
  let p = 0;
  let any = false;
  for (const r of rows ?? []) {
    co += num(r.ce?.oi) ?? 0;
    po += num(r.pe?.oi) ?? 0;
    cv += num(r.ce?.v) ?? 0;
    pv += num(r.pe?.v) ?? 0;
    const dc = num(r.ce?.d);
    const dp = num(r.pe?.d);
    if (dc !== null) (c += dc), (any = true);
    if (dp !== null) (p += dp), (any = true);
  }
  let chg = null;
  if (any) {
    const kind = p > 0 && c > 0 ? "ratio" : p > 0 ? "put-add-call-cut" : c > 0 ? "call-add-put-cut" : p === 0 && c === 0 ? "flat" : "both-cut";
    chg = { ratio: kind === "ratio" ? p / c : null, kind, p, c, text: PCR_CHANGE_TEXT[kind] ?? null };
  }
  return { oi: co > 0 ? po / co : null, vol: cv > 0 ? pv / cv : null, chg, ceOi: co, peOi: po, ceVol: cv, peVol: pv };
}

/**
 * Whether a wall is being added to: "fresh" when d ≥ 5% of the reference OI (or any add on a strike that had none),
 * "unwinding" when d ≤ −5%, "steady" between, null without a change.
 */
export function wallFreshness(d, oiRef) {
  const x = num(d);
  if (x === null) return null;
  const ref = num(oiRef);
  if (ref === null || ref <= 0) return x > 0 ? "fresh" : x < 0 ? "unwinding" : "steady";
  if (x > 0 && x >= 0.05 * ref) return "fresh";
  if (x <= -0.05 * ref) return "unwinding";
  return "steady";
}

/**
 * The top OI strikes on one side as walls: calls at or above spot (resistance), puts at or below it (support); every
 * strike when spot is unknown. Ranked by OI, a tie going to the strike nearer spot.
 * share = OI ÷ the side's OI over `rows`; strength = OI ÷ the mean side OI over `band` rows with OI (≥ 2 = strong);
 * dist = strike − spot; sigma = |dist| ÷ `move` (one σ in points).
 */
export function oiWalls(rows, side, spot, { top = 3, band = null, move = null } = {}) {
  const s = num(spot);
  const list = rows ?? [];
  let total = 0;
  for (const r of list) total += num(r[side]?.oi) ?? 0;
  const bandOi = (band ?? list).map((r) => num(r[side]?.oi)).filter((v) => v !== null && v > 0);
  const mean = bandOi.length ? bandOi.reduce((a, b) => a + b, 0) / bandOi.length : null;
  const m = num(move);
  return list
    .filter((r) => {
      const oi = num(r[side]?.oi);
      return oi !== null && oi > 0 && (s === null || (side === "ce" ? r.strike >= s : r.strike <= s));
    })
    .sort((a, b) => num(b[side].oi) - num(a[side].oi) || (s === null ? a.strike - b.strike : Math.abs(a.strike - s) - Math.abs(b.strike - s) || a.strike - b.strike))
    .slice(0, Math.max(0, top))
    .map((r, i) => {
      const leg = r[side];
      const oi = num(leg.oi);
      const d = num(leg.d);
      const oiRef = num(leg.oiRef);
      const dist = s === null ? null : r.strike - s;
      const strength = mean ? oi / mean : null;
      return {
        rank: i + 1,
        strike: r.strike,
        oi,
        share: total > 0 ? oi / total : null,
        strength,
        strong: strength !== null && strength >= 2,
        d,
        oiRef,
        fresh: wallFreshness(d, oiRef),
        dist,
        distPct: dist === null || !s ? null : (dist / s) * 100,
        sigma: dist !== null && m !== null && m > 0 ? Math.abs(dist) / m : null,
      };
    });
}
/** The strike that added the most OI on one side, at any distance from spot: { strike, d, oi } or null. */
export function freshWall(rows, side) {
  let best = null;
  for (const r of rows ?? []) {
    const d = num(r[side]?.d);
    if (d !== null && d > 0 && (best === null || d > best.d)) best = { strike: r.strike, d, oi: num(r[side].oi) };
  }
  return best;
}
/** Share of all OI sitting on the `n` strikes nearest spot (pin risk near expiry): { lo, hi, share } or null. */
export function pinZone(rows, spot, n = 3) {
  const s = num(spot);
  const list = (rows ?? []).filter((r) => num(r?.strike) !== null);
  if (s === null || !list.length) return null;
  let total = 0;
  for (const r of list) total += (num(r.ce?.oi) ?? 0) + (num(r.pe?.oi) ?? 0);
  if (!(total > 0)) return null;
  const near = list.slice().sort((a, b) => Math.abs(a.strike - s) - Math.abs(b.strike - s) || a.strike - b.strike).slice(0, n);
  const at = near.reduce((a, r) => a + (num(r.ce?.oi) ?? 0) + (num(r.pe?.oi) ?? 0), 0);
  const ks = near.map((r) => r.strike);
  return { lo: Math.min(...ks), hi: Math.max(...ks), share: at / total };
}

/** Default noise filter for build-up: at least 10 lots and 1% of OI, and a price move of 0.5% (or 2 ticks). */
export const BUILDUP_DEFAULTS = Object.freeze({ minLots: 10, minOiPct: 1, minPxPct: 0.5, tick: 0.05, churnX: 5 });
/**
 * Build-up of one leg over a window, with a noise filter: LB / SB / SC / LU as buildup(), "CH" (churn) when OI or
 * price did not move enough but volume was heavy, null when nothing passed. Input is a window-row leg
 * { d, oiRef, dLtp, ltpRef, v }.
 */
export function classifyBuildup(leg, { lot = 1, minLots = 10, minOiPct = 1, minPxPct = 0.5, tick = 0.05, churnX = 5 } = {}) {
  const d = num(leg?.d);
  const dp = num(leg?.dLtp);
  if (d === null || dp === null) return null;
  const L = num(lot) || 1;
  const oiRef = Math.max(0, num(leg.oiRef) ?? 0);
  const ltpRef = num(leg.ltpRef);
  const v = num(leg.v) ?? 0;
  const oiSig = Math.abs(d) >= Math.max((minOiPct / 100) * oiRef, minLots * L) && d !== 0;
  const pxFloor = 2 * tick;
  const pxSig = Math.abs(dp) >= (ltpRef === null ? pxFloor : Math.max((minPxPct / 100) * Math.abs(ltpRef), pxFloor)) && dp !== 0;
  if (!oiSig) return v >= churnX * minLots * L && v > 0 ? "CH" : null;
  if (!pxSig) return v >= churnX * Math.abs(d) ? "CH" : null;
  if (d > 0) return dp > 0 ? "LB" : "SB";
  return dp > 0 ? "SC" : "LU";
}
/** What each build-up means for the underlying, per side: +1 bullish, −1 bearish (churn has no direction). */
export const BUILDUP_DIR = Object.freeze({
  LB: Object.freeze({ ce: 1, pe: -1 }),
  SB: Object.freeze({ ce: -1, pe: 1 }),
  SC: Object.freeze({ ce: 1, pe: -1 }),
  LU: Object.freeze({ ce: -1, pe: 1 }),
});
/** Build-up in words per side: [who, effect on the underlying]. */
export const BUILDUP_READ = Object.freeze({
  ce: Object.freeze({ LB: ["call buying", "bullish"], SB: ["call writing", "capping"], SC: ["call writers exit", "bullish"], LU: ["call longs exit", "bearish"], CH: ["churn", "no direction"] }),
  pe: Object.freeze({ LB: ["put buying", "bearish"], SB: ["put writing", "supportive"], SC: ["put writers exit", "bearish"], LU: ["put longs exit", "bullish"], CH: ["churn", "no direction"] }),
});
/** Classify every leg of window rows in place (leg.cls), so the summary, movers and ladder agree. Returns rows. */
export function annotateBuildup(rows, opts = {}) {
  for (const r of rows ?? []) for (const side of ["ce", "pe"]) if (r[side]) r[side].cls = classifyBuildup(r[side], opts);
  return rows;
}
const CLASSES = ["LB", "SB", "SC", "LU", "CH"];
/**
 * Build-up over rows (the band): per side and class { n, lots }, the dominant directional class per side, and a score
 * from −1 to +1 = Σ dir·|d| ÷ Σ|d| over the four directional classes. tone / text: "range" when short build-up is at
 * least half the directional change on both sides, else "up" (score ≥ 0.25), "down" (≤ −0.25) or "mixed".
 * @param {object} [opts] classifyBuildup options plus `range: { lo, hi }` (S1 and R1) for the range text
 */
export function buildupSummary(rows, opts = {}) {
  const L = num(opts.lot) || 1;
  const out = { ce: {}, pe: {} };
  const abs = { ce: {}, pe: {} };
  for (const side of ["ce", "pe"]) for (const k of CLASSES) (out[side][k] = { n: 0, lots: 0 }), (abs[side][k] = 0);
  let top = 0;
  let den = 0;
  for (const r of rows ?? []) {
    for (const side of ["ce", "pe"]) {
      const leg = r[side];
      if (!leg) continue;
      const cls = "cls" in leg ? leg.cls : classifyBuildup(leg, opts);
      if (!cls) continue;
      const a = Math.abs(num(leg.d) ?? 0);
      out[side][cls].n += 1;
      out[side][cls].lots += a / L;
      abs[side][cls] += a;
      if (cls !== "CH") {
        den += a;
        top += BUILDUP_DIR[cls][side] * a;
      }
    }
  }
  const dirAbs = (side) => abs[side].LB + abs[side].SB + abs[side].SC + abs[side].LU;
  for (const side of ["ce", "pe"]) {
    let dom = null;
    for (const k of ["LB", "SB", "SC", "LU"]) if (abs[side][k] > 0 && (dom === null || abs[side][k] > abs[side][dom])) dom = k;
    out[side].dom = dom;
  }
  const score = den > 0 ? top / den : null;
  const range = dirAbs("ce") > 0 && dirAbs("pe") > 0 && abs.ce.SB >= 0.5 * dirAbs("ce") && abs.pe.SB >= 0.5 * dirAbs("pe");
  let tone = "mixed";
  let short = "Mixed";
  if (range) (tone = "range"), (short = "Writers on both sides");
  else if (score !== null && score >= 0.25) (tone = "up"), (short = "Bullish tilt");
  else if (score !== null && score <= -0.25) (tone = "down"), (short = "Bearish tilt");
  const lo = num(opts.range?.lo);
  const hi = num(opts.range?.hi);
  const text = tone === "range" && lo !== null && hi !== null ? `${short}: range ${formatInt(lo)}–${formatInt(hi)}` : short;
  return { ce: out.ce, pe: out.pe, score, tone, text, short, empty: den === 0 && !out.ce.CH.n && !out.pe.CH.n };
}

/**
 * The biggest OI additions and unwinds over rows, both sides: { adds, unwinds }, each [{ strike, side, d, dPct, oi,
 * oiRef, dLtp, cls, dir, v, wall }] (dPct null for a strike that had no OI: print "new"). `walls` = { ce: Map(strike →
 * "R1"), pe: Map(strike → "S1") } tags the strikes that are walls. With `minLots` (and `lot`) given, a change below
 * minLots × lot is left out as noise.
 */
export function oiMovers(rows, { n = 5, walls = null, ...opts } = {}) {
  // With the noise filter given (minLots, lot), a change below it is noise, not a mover.
  const floor = num(opts.minLots) !== null ? num(opts.minLots) * (num(opts.lot) || 1) : 0;
  const items = [];
  for (const r of rows ?? []) {
    for (const side of ["ce", "pe"]) {
      const leg = r[side];
      const d = num(leg?.d);
      if (d === null || d === 0 || Math.abs(d) < floor) continue;
      const cls = "cls" in leg ? leg.cls : classifyBuildup(leg, opts);
      items.push({ strike: r.strike, side, d, dPct: num(leg.dPct), oi: num(leg.oi), oiRef: num(leg.oiRef), dLtp: num(leg.dLtp), cls, dir: cls && cls !== "CH" ? BUILDUP_DIR[cls][side] : null, v: num(leg.v), wall: walls?.[side]?.get(r.strike) ?? null });
    }
  }
  const adds = items.filter((i) => i.d > 0).sort((a, b) => b.d - a.d || a.strike - b.strike).slice(0, n);
  const unwinds = items.filter((i) => i.d < 0).sort((a, b) => a.d - b.d || a.strike - b.strike).slice(0, n);
  return { adds, unwinds };
}

/** The window choices: [id, short label]. Minute windows read the recorded snapshots. */
export const OI_WINDOWS = Object.freeze([["prev", "Prev close"], ["5", "5m"], ["15", "15m"], ["30", "30m"], ["60", "1h"], ["open", "Since open"]]);
export const NO_PREV_OI = "Your data source has no previous-day OI. Windows use snapshots recorded on this page.";
/**
 * The reference for a window: { snap, label, ok, reason }. Prev close needs the chain's oiChange (`hasPrev`). A minute
 * window W takes the latest snapshot at least W old; failing that, the first snapshot when it is at least W/2 old
 * (label "since 10:42 (22m)"); else it is not ready ("Recording since 10:42 · 15m ready at 10:57"). Since open is the
 * day's first snapshot ("opened late" when it was taken after 09:20). `snaps` are one IST day's, any order.
 */
export function pickRef(snaps, nowMs, win, { hasPrev = false } = {}) {
  if (win === "prev") return hasPrev ? { snap: null, label: "vs previous close", ok: true, reason: null } : { snap: null, label: "vs previous close", ok: false, reason: NO_PREV_OI };
  const name = OI_WINDOWS.find((w) => w[0] === win)?.[1] ?? win;
  const list = (snaps ?? []).filter((s) => Number.isFinite(s?.t) && s.t <= nowMs).sort((a, b) => a.t - b.t);
  if (!list.length) return { snap: null, label: "", ok: false, reason: `No snapshots yet: ${name} works once this page has recorded for a while` };
  const first = list[0];
  if (win === "open") {
    const late = istClock(first.t).mins > SESSION_OPEN + 5;
    return { snap: first, label: `since ${istHm(first.t)}${late ? " (opened late)" : ""}`, ok: true, reason: null };
  }
  const W = Number(win) * 60000;
  if (!(W > 0)) return { snap: null, label: "", ok: false, reason: "Unknown window" };
  let snap = null;
  for (const s of list) if (s.t <= nowMs - W) snap = s;
  if (snap) return { snap, label: `since ${istHm(snap.t)}`, ok: true, reason: null };
  const age = nowMs - first.t;
  if (age >= W / 2) return { snap: first, label: `since ${istHm(first.t)} (${formatInt(Math.floor(age / 60000))}m)`, ok: true, reason: null };
  return { snap: null, label: "", ok: false, reason: `Recording since ${istHm(first.t)} · ${name} ready at ${istHm(first.t + W)}` };
}

/** A recorded snapshot as chain-like rows: [{ strike, ce: { oi, ltp }, pe }]. */
export function snapRows(snap) {
  const k = snap?.k ?? [];
  const leg = (o, l) => (o === null || o === undefined) && (l === null || l === undefined) ? null : { oi: num(o), ltp: num(l) };
  return k.map((strike, i) => ({ strike, ce: leg(snap.co?.[i], snap.cl?.[i]), pe: leg(snap.po?.[i], snap.pl?.[i]) }));
}

/**
 * OI summed across expiries, in lots (each chain's own lot size, so a lot-size change does not distort the sum).
 * `chains` are GET /v1/optionchain data. rows: [{ strike, ce: { oi, oiRef, d, dPct, v, by: { [expiry]: lots } }, pe }]
 * with d from the previous close only; perExpiry: [{ expiry, days, dte, lot, ceOi, peOi, pcr, maxPain, edge, r1, s1 }].
 */
export function cumulativeOi(chains, now = Date.now()) {
  const map = new Map();
  const perExpiry = [];
  for (const c of chains ?? []) {
    if (!c?.rows) continue;
    const lot = num(c.lotSize) || 1;
    let ceOi = 0;
    let peOi = 0;
    for (const r of c.rows) {
      let row = map.get(r.strike);
      if (!row) map.set(r.strike, (row = { strike: r.strike, ce: null, pe: null }));
      for (const side of ["ce", "pe"]) {
        const q = r[side];
        if (!q) continue;
        const t = (row[side] ??= { oi: null, oiRef: null, d: null, dPct: null, ltp: null, ltpRef: null, dLtp: null, v: null, by: {} });
        const oi = num(q.oi);
        const ch = num(q.oiChange);
        const vol = num(q.volume);
        if (oi !== null) {
          t.oi = (t.oi ?? 0) + oi / lot;
          t.by[c.expiry] = oi / lot;
          if (side === "ce") ceOi += oi / lot;
          else peOi += oi / lot;
        }
        if (ch !== null) t.d = (t.d ?? 0) + ch / lot;
        if (vol !== null) t.v = (t.v ?? 0) + vol / lot;
      }
    }
    const spot = num(c.underlyingLtp);
    const mp = maxPainCurve(c.rows, spot);
    const t = timeToExpiry(c.expiry, now);
    perExpiry.push({
      expiry: c.expiry,
      days: t.days,
      dte: t.label,
      lot,
      ceOi,
      peOi,
      pcr: ceOi > 0 ? peOi / ceOi : null,
      maxPain: mp?.strike ?? null,
      edge: mp?.edge ?? false,
      r1: oiWalls(c.rows, "ce", spot, { top: 1 })[0]?.strike ?? null,
      s1: oiWalls(c.rows, "pe", spot, { top: 1 })[0]?.strike ?? null,
    });
  }
  const rows = [...map.values()].sort((a, b) => a.strike - b.strike);
  for (const r of rows) {
    for (const side of ["ce", "pe"]) {
      const t = r[side];
      if (!t) continue;
      t.oiRef = t.oi !== null && t.d !== null ? t.oi - t.d : null;
      t.dPct = t.d !== null && t.oiRef > 0 ? (t.d / t.oiRef) * 100 : null;
    }
  }
  return { rows, perExpiry };
}

/**
 * Prepared series for a time chart, one point per snapshot: [{ t, spot, ceOi, peOi, pcr, maxPain, r1, s1 }] with OI
 * totals in lots.
 */
export function oiSeries(snaps) {
  return (snaps ?? [])
    .filter((s) => Number.isFinite(s?.t))
    .slice()
    .sort((a, b) => a.t - b.t)
    .map((s) => {
      const lot = num(s.lot) || 1;
      const rows = snapRows(s);
      let co = 0;
      let po = 0;
      for (const r of rows) {
        co += num(r.ce?.oi) ?? 0;
        po += num(r.pe?.oi) ?? 0;
      }
      const spot = num(s.spot);
      return {
        t: s.t,
        spot,
        ceOi: co / lot,
        peOi: po / lot,
        pcr: co > 0 ? po / co : null,
        maxPain: maxPainCurve(rows, spot)?.strike ?? null,
        r1: oiWalls(rows, "ce", spot, { top: 1 })[0]?.strike ?? null,
        s1: oiWalls(rows, "pe", spot, { top: 1 })[0]?.strike ?? null,
      };
    });
}
/** Where a wall stood over a series: the points where it changed, [{ strike, t }] (the first point included). */
export function wallPath(series, key) {
  const out = [];
  for (const p of series ?? []) {
    const k = num(p?.[key]);
    if (k === null) continue;
    if (!out.length || out[out.length - 1].strike !== k) out.push({ strike: k, t: p.t });
  }
  return out;
}
/** "Call wall: 26400 (09:31) → 26500 (11:02) · Put wall: 26000 since 09:31" (null without walls). */
export function wallMigrationText(series) {
  const part = (name, key) => {
    const path = wallPath(series, key);
    if (!path.length) return null;
    if (path.length === 1) return `${name}: ${formatInt(path[0].strike)} since ${istHm(path[0].t)}`;
    return `${name}: ${path.slice(-4).map((p) => `${formatInt(p.strike)} (${istHm(p.t)})`).join(" → ")}`;
  };
  const parts = [part("Call wall", "r1"), part("Put wall", "s1")].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * The one-line reading at the top of the page, from the parts that exist:
 * "Range 25900–26500 · Writers on both sides · PCR 1.08 balanced · Max pain 26300 (low relevance)". Null when empty.
 */
export function oiVerdict({ walls = null, pcr = null, buildup = null, maxPain: mp = null, relevance = null } = {}) {
  const parts = [];
  const r1 = num(walls?.r1);
  const s1 = num(walls?.s1);
  if (r1 !== null && s1 !== null) parts.push(`Range ${formatInt(s1)}–${formatInt(r1)}`);
  else if (r1 !== null) parts.push(`Resistance ${formatInt(r1)}`);
  else if (s1 !== null) parts.push(`Support ${formatInt(s1)}`);
  if (buildup?.short && !buildup.empty) parts.push(buildup.short);
  const p = num(pcr);
  if (p !== null) parts.push(`PCR ${formatFixed(p, 2)} ${pcrBand(p)?.word ?? ""}`.trim());
  if (num(mp) !== null) parts.push(`Max pain ${formatInt(mp)}${relevance ? ` (${relevance} relevance)` : ""}`);
  return parts.length ? parts.join(" · ") : null;
}

// ── Strategy builder (PRD 02): legs v2, model greeks, charges, margin, what-if, warnings, saves ──

export const MAX_LEGS = 12;
let legSeq = 0;
/** A leg id: stable for DOM keys, undo and saves. */
export const newLegId = () => `l${Date.now().toString(36)}${(legSeq += 1).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Basket legs from any earlier shape ({ right, strike, side, lots, entry? }) to data model v2: an id, kind, the
 * leg's expiry (`expiry` = the basket's), its own lot size (`lotSize` = the chain's, filled when known) and on: true.
 * Unusable legs are dropped and the list is capped at 12.
 */
export function migrateLegs(legs, expiry, { lotSize = null } = {}) {
  const out = [];
  const seen = new Set();
  for (const l of Array.isArray(legs) ? legs : []) {
    if (!l || typeof l !== "object") continue;
    const kind = l.kind === "FUT" ? "FUT" : "OPT";
    const side = l.side === "SELL" ? "SELL" : l.side === "BUY" ? "BUY" : null;
    if (!side) continue;
    if (kind === "OPT" && (!(l.right === "CE" || l.right === "PE") || !(num(l.strike) > 0))) continue;
    let id = typeof l.id === "string" && l.id && l.id.length <= 40 ? l.id : newLegId();
    if (seen.has(id)) id = newLegId();
    seen.add(id);
    const leg = {
      id,
      kind,
      right: kind === "OPT" ? l.right : null,
      strike: kind === "OPT" ? num(l.strike) : null,
      expiry: typeof l.expiry === "string" && DATE_RE.test(l.expiry) ? l.expiry : expiry ?? null,
      symbol: typeof l.symbol === "string" && l.symbol ? l.symbol : null,
      lotSize: num(l.lotSize) > 0 ? num(l.lotSize) : num(lotSize) > 0 ? num(lotSize) : null,
      side,
      lots: Math.max(1, Math.floor(num(l.lots) ?? 1)),
      on: l.on !== false,
    };
    if (num(l.entry) !== null) {
      leg.entry = num(l.entry);
      if (l.entryTag === "avg" || l.entryTag === "saved") leg.entryTag = l.entryTag;
    }
    if (["INTRADAY", "MARGIN", "CNC"].includes(l.product)) leg.product = l.product;
    out.push(leg);
    if (out.length >= MAX_LEGS) break;
  }
  return out;
}

/** Same contracts, sides and lots in the same order (a preset chip is "on" while this holds). */
export function legsMatch(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return false;
  return a.every((l, i) => {
    const m = b[i];
    return (l.kind === "FUT") === (m.kind === "FUT") && (l.kind === "FUT" || (l.right === m.right && l.strike === m.strike)) && l.side === m.side && Math.floor(l.lots) === Math.floor(m.lots) && l.on !== false;
  });
}

/**
 * Move every option leg one listed strike down (dir −1) or up (+1). If any leg is at the edge of `strikes`, nothing
 * moves (the shape is kept) and the same array comes back. Entry prices are cleared on the legs that move.
 */
export function shiftLegs(legs, strikes, dir) {
  const ks = [...new Set((strikes ?? []).filter((k) => num(k) !== null))].sort((a, b) => a - b);
  const out = [];
  for (const l of legs ?? []) {
    if (l.kind === "FUT") {
      out.push(l);
      continue;
    }
    const i = ks.indexOf(l.strike);
    const j = i + (dir > 0 ? 1 : -1);
    if (i < 0 || j < 0 || j >= ks.length) return legs;
    const { entry, ...rest } = l;
    void entry;
    out.push({ ...rest, strike: ks[j], symbol: null });
  }
  return out;
}

/** The next listed strike from `strike` in `dir` (null at the edge). */
export function stepStrike(strikes, strike, dir) {
  const ks = [...new Set(strikes ?? [])].sort((a, b) => a - b);
  const i = ks.indexOf(strike);
  if (i < 0) return ks.length ? ks.reduce((b, k) => (Math.abs(k - strike) < Math.abs(b - strike) ? k : b), ks[0]) : null;
  const j = i + (dir > 0 ? 1 : -1);
  return j < 0 || j >= ks.length ? null : ks[j];
}

/** The settlement moment of an expiry date (15:30 IST), epoch ms; null for a bad date. */
export function expiryCloseMs(expiry) {
  const m = DATE_RE.exec(String(expiry ?? "")) ? String(expiry).split("-").map(Number) : null;
  return m ? Date.UTC(m[0], m[1] - 1, m[2], 15, 30) - IST_OFFSET_MS : null;
}

/**
 * Black-76 greeks per unit (forward measure, r = 0): delta, gamma (per point), theta (₹ per calendar day, per unit)
 * and vega (per vol point). At or after expiry: delta 1 / −1 in the money, 0 out of it, the rest 0.
 */
export function black76Greeks(forward, strike, years, ivPct, right) {
  const F = num(forward);
  const K = num(strike);
  const sig = (num(ivPct) ?? 0) / 100;
  if (F === null || K === null || F <= 0 || K <= 0) return null;
  if (!(years > 0) || !(sig > 0)) {
    const itm = right === "CE" ? F > K : F < K;
    return { delta: itm ? (right === "CE" ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0 };
  }
  const sd = sig * Math.sqrt(years);
  const d1 = (Math.log(F / K) + (sd * sd) / 2) / sd;
  const pdf = Math.exp((-d1 * d1) / 2) / Math.sqrt(2 * Math.PI);
  return {
    delta: right === "CE" ? normCdf(d1) : normCdf(d1) - 1,
    gamma: pdf / (F * sd),
    theta: -(F * pdf * sig) / (2 * Math.sqrt(years)) / 365,
    vega: (F * pdf * Math.sqrt(years)) / 100,
  };
}

/**
 * Net model greeks of a basket with the underlying at S, `el` years from now (the target date) and IV + `ivShift`
 * (PRD 02 §6.8): delta in units, gamma per point, theta ₹ per day, vega ₹ per vol point. FUT legs: delta 1 per unit.
 * Null when an option leg has no IV.
 */
export function netGreeksModel(legs, S, { lotSize = 1, basis = 0, el = 0, ivShift = 0 } = {}) {
  if (num(S) === null) return null;
  const out = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  for (const l of activeLegs(legs)) {
    const k = legSign(l) * legUnits(l, lotSize);
    if (isFut(l)) {
      out.delta += k;
      continue;
    }
    const Ti = num(l.years) ?? 0;
    const Tt = Ti - (num(el) ?? 0);
    if (Tt > 1e-9 && num(l.iv) === null) return null;
    const fwd = S + (Ti > 0 && Tt > 0 ? (basis * Tt) / Ti : 0);
    const g = black76Greeks(fwd, l.strike, Tt, Math.max(1, (num(l.iv) ?? 0) + (num(ivShift) ?? 0)), l.right);
    if (!g) return null;
    for (const key of Object.keys(out)) out[key] += k * g[key];
  }
  return out;
}

/**
 * Statutory charges on Indian index F&O. Rates as of Apr 2026 (Union Budget 2026 STT); verify against your broker's
 * contract note. One place to correct them.
 */
export const CHARGE_RATES = Object.freeze({
  asOf: "Apr 2026",
  brokeragePerOrder: 20,
  opt: Object.freeze({ sttSell: 0.0015, exerciseStt: 0.0015, stampBuy: 0.00003, txn: Object.freeze({ NSE: 0.0003503, BSE: 0.000325 }) }),
  fut: Object.freeze({ sttSell: 0.0005, stampBuy: 0.00002, txn: Object.freeze({ NSE: 0.0000173, BSE: 0.0000173 }) }),
  sebiPerCrore: 10,
  gst: 0.18,
});
const exchangeOf = (l) => (/^BFO:/.test(String(l?.symbol ?? "")) ? "BSE" : "NSE");
function orderCharges(kind, side, turnover, exch, r) {
  const k = kind === "FUT" ? r.fut : r.opt;
  const brokerage = turnover > 0 ? r.brokeragePerOrder : 0;
  const stt = side === "SELL" ? turnover * k.sttSell : 0;
  const txn = turnover * (k.txn[exch] ?? k.txn.NSE);
  const sebi = (turnover * r.sebiPerCrore) / 1e7;
  const stamp = side === "BUY" ? turnover * k.stampBuy : 0;
  const gst = (brokerage + txn + sebi) * r.gst;
  return { brokerage, stt, txn, sebi, stamp, gst };
}
const addCharges = (a, b) => {
  for (const k of Object.keys(b)) a[k] = (a[k] ?? 0) + b[k];
  return a;
};
/**
 * Entry charges of a basket at its prices (one order per leg): { brokerage, stt, txn, sebi, stamp, gst, total }.
 * Legs without a price are skipped.
 */
export function charges(legs, rates = CHARGE_RATES, { lotSize = 1 } = {}) {
  const out = { brokerage: 0, stt: 0, txn: 0, sebi: 0, stamp: 0, gst: 0 };
  for (const l of activeLegs(legs)) {
    const p = num(l.price);
    if (p === null) continue;
    addCharges(out, orderCharges(isFut(l) ? "FUT" : "OPT", l.side, p * legUnits(l, lotSize), exchangeOf(l), rates));
  }
  out.total = out.brokerage + out.stt + out.txn + out.sebi + out.stamp + out.gst;
  return out;
}
/**
 * Charges to get out at expiry with the underlying at S: exercise STT on long in-the-money options (on intrinsic ×
 * units) plus squaring off FUT legs at S. Shorts that expire worthless or are assigned pay nothing here.
 */
export function exitCharges(legs, S, rates = CHARGE_RATES, { lotSize = 1 } = {}) {
  let t = 0;
  for (const l of activeLegs(legs)) {
    const u = legUnits(l, lotSize);
    if (isFut(l)) {
      const c = orderCharges("FUT", l.side === "BUY" ? "SELL" : "BUY", Math.max(0, S) * u, exchangeOf(l), rates);
      t += c.brokerage + c.stt + c.txn + c.sebi + c.stamp + c.gst;
    } else if (l.side === "BUY") t += intrinsicOf(l, S) * u * rates.opt.exerciseStt;
  }
  return t;
}

/**
 * Entry and exit charges for the figures: { entry, exit(S) }. Exit charges grow with S (exercise STT on a long ITM
 * option, FUT turnover), so S is held inside the strikes widened to F·e^(±3σ√T): far tails (S = 0, 2 × the top strike)
 * would otherwise inflate max loss with STT nobody pays in a market that can actually trade.
 */
export function strategyCharges(legs, rates = CHARGE_RATES, { lotSize = 1, forward = null, ivPct = null, years = null } = {}) {
  const act = activeLegs(legs);
  const ks = act.filter((l) => !isFut(l)).map((l) => num(l.strike)).filter((k) => k !== null && k > 0);
  const F = num(forward);
  const iv = num(ivPct);
  const T = num(years);
  const w = F && F > 0 && iv !== null && iv > 0 && T !== null && T > 0 ? 3 * (iv / 100) * Math.sqrt(T) : 0;
  const lo = Math.min(...ks, ...(F && F > 0 ? [F * Math.exp(-w)] : []));
  const hi = Math.max(...ks, ...(F && F > 0 ? [F * Math.exp(w)] : []));
  const bounded = Number.isFinite(lo) && Number.isFinite(hi);
  return {
    entry: charges(act, rates, { lotSize }).total,
    exit: (S) => exitCharges(act, bounded ? Math.min(hi, Math.max(lo, S)) : S, rates, { lotSize }),
    lo: bounded ? lo : null,
    hi: bounded ? hi : null,
  };
}

/**
 * Expected P&L under the model the options are priced with (log-normal around the forward, σ = ATM IV + shift):
 * Σ payoff(F·e^(−σ²T/2 + σ√T·z)) φ(z) Δz over z ∈ [−6, 6], 481 points. Close to −(spreads + charges) by construction.
 */
export function expectedValue(legs, lotSize, { forward = null, ivPct = null, years = null, ivShift = 0, charges: ch = null } = {}) {
  const F = num(forward);
  const ivp = num(ivPct);
  const T = num(years);
  if (!F || F <= 0 || ivp === null || ivp <= 0 || T === null) return null;
  const f = strategyPayoff(legs, lotSize, { years: T, ivShift, charges: ch });
  if (T <= 0) return f(F);
  const sd = (Math.max(1, ivp + (num(ivShift) ?? 0)) / 100) * Math.sqrt(T);
  const n = 480;
  const dz = 12 / n;
  let ev = 0;
  for (let i = 0; i <= n; i += 1) {
    const z = -6 + i * dz;
    const w = (Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI)) * dz * (i === 0 || i === n ? 0.5 : 1);
    ev += f(F * Math.exp((-sd * sd) / 2 + sd * z)) * w;
  }
  return ev;
}

/**
 * Hedged margin estimate (PRD 02 §6.11), labelled ≈ in the page: defined risk (option legs only, max loss finite) =
 * |max loss|; otherwise the worst expiry loss over F ± 9% (price scan) + 2% exposure on short-option and futures
 * notional, plus the net debit; plus 2% ELM on short options on expiry day. The broker's figure is final.
 */
export function marginEstimate(legs, lotSize, { forward = null, years = null, expiryToday = false } = {}) {
  const act = activeLegs(legs);
  const F = num(forward);
  if (!act.length || !F || F <= 0) return null;
  const st = strategyStats(act, lotSize, { years, spot: F });
  const gross = strategyPayoff(act, lotSize, { years });
  const lo = F * 0.91;
  const hi = F * 1.09;
  const pts = [lo, ...act.filter((l) => !isFut(l) && l.strike > lo && l.strike < hi).map((l) => l.strike), hi];
  const scanLoss = Math.max(0, -Math.min(...pts.map(gross)));
  const shortOpt = act.filter((l) => !isFut(l) && l.side === "SELL").reduce((a, l) => a + legUnits(l, lotSize) * F, 0);
  const futNotional = act.filter(isFut).reduce((a, l) => a + legUnits(l, lotSize) * F, 0);
  const exposure = 0.02 * (shortOpt + futNotional);
  // Defined risk: no futures, nothing unlimited above, and no net short puts below the lowest strike (a naked short
  // put's finite S = 0 loss is the full notional, not a margin).
  const putNet = act.reduce((a, l) => a + (!isFut(l) && l.right === "PE" ? legSign(l) * legUnits(l, lotSize) : 0), 0);
  const defined = st.maxLoss !== null && !act.some(isFut) && putNet >= -1e-9;
  const debit = st.net < 0 ? -st.net : 0;
  const base = defined ? Math.max(0, -st.maxLoss) : scanLoss + exposure + debit;
  const elm = expiryToday ? 0.02 * shortOpt : 0;
  return { required: base + elm, defined, scanLoss, exposure, elm };
}

/** Return on margin, reward/risk and the implied annual rate of a locked P&L (null where they do not apply). */
export function strategyRatios({ maxProfit = null, maxLoss = null, margin = null, locked = null, net = null, years = null } = {}) {
  const rom = num(maxProfit) !== null && num(margin) > 0 ? maxProfit / margin : null;
  const rr = num(maxProfit) !== null && num(maxLoss) !== null && maxLoss < 0 ? maxProfit / -maxLoss : null;
  const capital = num(net) !== null && net < 0 ? -net : num(margin) > 0 ? margin : null;
  const implied = num(locked) !== null && capital && num(years) > 0 ? locked / capital / years : null;
  return { rom, rr, implied };
}

/** σ distance of a price from the forward: ln(x/F) / (σ√T) (signed). */
export function sigmaZ(x, forward, ivPct, years) {
  const X = num(x);
  const F = num(forward);
  const sig = (num(ivPct) ?? 0) / 100;
  if (!X || !F || X <= 0 || F <= 0 || !(sig > 0) || !(years > 0)) return null;
  return Math.log(X / F) / (sig * Math.sqrt(years));
}

/**
 * The payoff chart's x-range: wide enough for 2.6 expected moves, every strike (×1.35 its distance) and ±1.5% of
 * spot. Depends only on the legs' strikes, spot and the move, so it holds still across ticks.
 */
export function payoffRange(legs, { spot, move = null }) {
  const S = num(spot);
  if (!S) return null;
  const ks = activeLegs(legs).filter((l) => !isFut(l)).map((l) => l.strike);
  const span = Math.max((num(move) ?? S * 0.02) * 2.6, ...ks.map((k) => Math.abs(k - S) * 1.35), S * 0.015);
  return { lo: Math.max(0, S - span), hi: S + span };
}

/**
 * Everything the payoff chart draws (PRD 02 §9.1), pure: sample prices, the expiry and target curves (null when the
 * target is the expiry or a leg has no IV), breakevens, ±1σ / ±2σ bands, y-range.
 * @param {{ lotSize: number, spot: number, forward: number, years: number, el?: number, ivShift?: number,
 *   ivPct?: number|null, charges?: { entry: number, exit: (S: number) => number }|null, range?: { lo, hi }|null,
 *   samples?: number }} m
 */
export function payoffModel(legs, m) {
  const act = activeLegs(legs);
  const spot = num(m?.spot) ?? num(m?.forward);
  if (!act.length || spot === null) return null;
  const F = num(m.forward) ?? spot;
  const T = num(m.years) ?? 0;
  const el = Math.max(0, num(m.el) ?? 0);
  const shift = num(m.ivShift) ?? 0;
  const iv = num(m.ivPct) !== null && m.ivPct > 0 ? Math.max(1, m.ivPct + shift) : null;
  const range = m.range ?? payoffRange(act, { spot, move: sigmaMove(F, iv, T) });
  const { lo, hi } = range;
  const n = Math.max(20, Math.min(240, num(m.samples) ?? 240));
  const strikes = [...new Set(act.filter((l) => !isFut(l)).map((l) => l.strike))].sort((a, b) => a - b);
  const xs = [...new Set([...Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n), ...strikes.filter((k) => k > lo && k < hi)])].sort((a, b) => a - b);
  const f = strategyPayoff(act, m.lotSize, { years: T, ivShift: shift, charges: m.charges ?? null });
  const expiry = xs.map(f);
  let target = null;
  if (T > 0 && el < T - 1e-7) {
    const basis = F - spot;
    const entry = num(m.charges?.entry) ?? 0;
    target = xs.map((S) => {
      const v = valueAt(act, S, m.lotSize, null, basis, { el, ivShift: shift });
      return v === null ? null : v - entry;
    });
    if (target.some((v) => v === null)) target = null;
  }
  const stats = strategyStats(act, m.lotSize, { forward: F, ivPct: m.ivPct, years: T, ivShift: shift, spot, charges: m.charges ?? null });
  const all = [...expiry, ...(target ?? []), 0];
  let yMin = Math.min(...all);
  let yMax = Math.max(...all);
  const pad = (yMax - yMin || Math.abs(yMax) || 1) * 0.12;
  yMin -= pad;
  yMax += pad;
  const b1 = sigmaBand(F, iv, T, 1);
  const b2 = sigmaBand(F, iv, T, 2);
  return {
    xs,
    expiry,
    target,
    breakevens: stats?.breakevens ?? [],
    band1: b1 ? [b1.lo, b1.hi] : null,
    band2: b2 ? [b2.lo, b2.hi] : null,
    spot,
    forward: F,
    strikes,
    yMin,
    yMax,
    lo,
    hi,
    stats,
  };
}

/**
 * Scenario prices (PRD 02 §8.4): "pct" = spot × (1 + k/100) for k ∈ {−3 … +3}; "sigma" = F·e^(kσ√T) for
 * k ∈ {−2 … +2}. Each: { k, price, movePct }.
 */
export function scenarioLevels(mode, { spot, forward = null, ivPct = null, years = null } = {}) {
  const S = num(spot);
  if (!S) return [];
  if (mode === "sigma") {
    const F = num(forward) ?? S;
    const sig = (num(ivPct) ?? 0) / 100;
    if (!(sig > 0) || !(years > 0)) return [];
    return [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2].map((k) => {
      const price = k === 0 ? S : F * Math.exp(k * sig * Math.sqrt(years));
      return { k, price, movePct: ((price - S) / S) * 100 };
    });
  }
  return [-3, -2, -1, -0.5, 0, 0.5, 1, 2, 3].map((k) => ({ k, price: S * (1 + k / 100), movePct: k }));
}

/**
 * Order of legs to send (PRD 02 §11.2). Entry: option buys (furthest from spot first: the cheapest hedges), future
 * buys, future sells, then option sells (nearest spot last). Exit (closing held legs): buy back the shorts first,
 * then sell the longs, futures last. Each item: { leg, side (the order's side), phase: "hedge" | "short" }.
 */
export function placementPlan(legs, mode = "entry", { spot = null } = {}) {
  const S = num(spot);
  const dist = (l) => (isFut(l) || S === null ? 0 : Math.abs(l.strike - S));
  const act = activeLegs(legs);
  if (mode === "exit") {
    const shorts = act.filter((l) => !isFut(l) && l.side === "SELL").sort((a, b) => dist(a) - dist(b));
    const longs = act.filter((l) => !isFut(l) && l.side === "BUY").sort((a, b) => dist(a) - dist(b));
    const futs = act.filter(isFut);
    return [...shorts, ...longs, ...futs].map((leg) => ({ leg, side: leg.side === "BUY" ? "SELL" : "BUY", phase: "hedge" }));
  }
  const buyOpt = act.filter((l) => !isFut(l) && l.side === "BUY").sort((a, b) => dist(b) - dist(a));
  const buyFut = act.filter((l) => isFut(l) && l.side === "BUY");
  const sellFut = act.filter((l) => isFut(l) && l.side === "SELL");
  const sellOpt = act.filter((l) => !isFut(l) && l.side === "SELL").sort((a, b) => dist(b) - dist(a));
  return [...buyOpt.map((leg) => ({ leg, side: "BUY", phase: "hedge" })), ...[...buyFut, ...sellFut].map((leg) => ({ leg, side: leg.side, phase: "hedge" })), ...sellOpt.map((leg) => ({ leg, side: "SELL", phase: "short" }))];
}

/** Placement rows with no order on the book: only these may be sent (again). Open, part-filled, timed-out or unknown never are. */
export const SENDABLE_STATUS = Object.freeze(new Set(["queued", "skipped", "rejected", "cancelled", "expired"]));
/** The first row a Retry may resend, or −1: never a row whose order is still working (that would double the leg). */
export const retryIndex = (rows) => (rows ?? []).findIndex((r) => SENDABLE_STATUS.has(r?.status));

const DAY_MONTH = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
const dayMonth = (e) => (DATE_RE.test(String(e ?? "")) ? DAY_MONTH.format(new Date(`${e}T00:00:00Z`)) : String(e ?? ""));
const rupeeShort = (v) => (Math.abs(v) >= 1e5 ? `₹${formatCompact(Math.abs(v))}` : formatRupee(Math.abs(v), 0));
/** "26000 PE" / "FUT 24 Nov" */
export const legLabel = (l) => (isFut(l) ? `FUT ${dayMonth(l.expiry)}` : `${formatInt(l.strike)} ${l.right}`);

/**
 * Warnings before a strategy is placed (PRD 02 §10): [{ code, severity: "block"|"warn"|"info", text }], blocks first.
 * @param {{ legs: object[], strikes?: number[], stats?: object|null, spot?: number|null, band1?: { lo, hi }|null,
 *   margin?: { required: number|null, free: number|null, source?: "account"|"estimate" }|null, live?: boolean, expiryToday?: boolean,
 *   lotSize?: number, legCount?: number, rates?: object }} c
 */
export function strategyWarnings(c) {
  const out = [];
  const add = (code, severity, text) => out.push({ code, severity, text });
  const legs = activeLegs(c?.legs);
  const lot = num(c?.lotSize) || 1;
  const listed = new Set(c?.strikes ?? []);
  const rates = c?.rates ?? CHARGE_RATES;
  const S = num(c?.spot);
  for (const l of legs) if (num(l.price) === null) add("NO_PRICE", "block", `${legLabel(l)} has no price`);
  for (const l of legs) if (!isFut(l) && c?.strikes && !listed.has(l.strike)) add("NOT_IN_CHAIN", "block", `${legLabel(l)} is outside the loaded strikes`);
  for (const l of legs) if (!l.symbol && (isFut(l) || !c?.strikes || listed.has(l.strike))) add("NO_SYMBOL", "block", `${legLabel(l)}: contract not found`);
  const req = num(c?.margin?.required);
  const free = num(c?.margin?.free);
  // The account's own figure (the paper engine refuses an order above free funds; live brokers likewise) blocks; the
  // hedged estimate only warns.
  if (req !== null && free !== null && req > free) {
    const hard = Boolean(c?.live) || c?.margin?.source === "account";
    add("SHORTFALL", hard ? "block" : "warn", `Short of margin by ${rupeeShort(req - free)}${hard && !c?.live ? ": the account will refuse it" : ""}`);
  }
  const st = c?.stats;
  if (st && st.maxLoss === null) {
    const stress = st.stress ? `: stress -${rupeeShort(Math.min(0, st.stress.value))} at +2σ` : "";
    add("NAKED", "warn", `Unlimited loss above ${formatInt(st.topStrike ?? S)}${stress}`);
  }
  if (c?.expiryToday && legs.some((l) => !isFut(l) && l.side === "SELL")) add("EXPIRY_DAY_SHORT", "warn", "Expiry day: +2% ELM on shorts and fast gamma");
  const b1 = c?.band1;
  if (st && st.net < 0 && st.breakevens?.length && b1 && st.breakevens.every((b) => b < b1.lo || b > b1.hi)) add("BE_OUTSIDE_1S", "info", "Needs a move beyond 1σ to break even");
  if (S !== null) {
    for (const l of legs) {
      if (isFut(l) || l.side !== "BUY" || num(l.price) === null) continue;
      const intr = intrinsicOf(l, S);
      if (!(intr > 0)) continue;
      const u = legUnits(l, lot);
      const stt = intr * u * rates.opt.exerciseStt;
      const gain = (intr - l.price) * u;
      if ((gain > 0 && gain < stt) || (gain > 0 && stt > 0.2 * gain)) add("STT_TRAP", "warn", `${legLabel(l)}: exercise STT ≈ ${formatRupee(stt, 0)} at expiry; square off before 15:30`);
    }
  }
  for (const l of legs) {
    const sp = num(l.spreadPct);
    if (sp !== null && sp > 5) add("WIDE_SPREAD", "warn", `${legLabel(l)} spread ${formatFixed(sp, 1)}%`);
  }
  for (const l of legs) {
    const fq = num(l.freezeQty);
    const q = legUnits(l, lot);
    if (fq > 0 && q > fq) add("FREEZE", "info", `${legLabel(l)} goes in ${formatInt(Math.ceil(q / fq))} slices (freeze ${formatInt(fq)})`);
  }
  const futExp = legs.filter(isFut).map((l) => l.expiry).filter(Boolean).sort().pop();
  const optFirst = legs.filter((l) => !isFut(l)).map((l) => l.expiry).filter(Boolean).sort()[0];
  if (futExp && optFirst && optFirst < futExp) add("HEDGE_EXPIRES_FIRST", "warn", `The hedge expires before the future (${dayMonth(optFirst)} vs ${dayMonth(futExp)})`);
  if ((num(c?.legCount) ?? (c?.legs ?? []).length) >= MAX_LEGS) add("LEGS_CAP", "info", `Up to ${MAX_LEGS} legs`);
  const rank = { block: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/**
 * A preset's mini payoff: ≤ 8 points in a 32 × 16 box (x: a little either side of the strikes; y: payoff, with the
 * zero line at its true height). Prices come from the legs; legs without one count at 0.
 * @returns {{ points: [number, number][], zero: number } | null}
 */
export function presetGlyph(legs, lotSize = 1) {
  const act = activeLegs(legs);
  const ks = [...new Set(act.filter((l) => !isFut(l)).map((l) => l.strike))].sort((a, b) => a - b);
  if (!ks.length) return null;
  const pad = Math.max((ks[ks.length - 1] - ks[0]) * 0.6, ks[0] * 0.02);
  const xs = [ks[0] - pad, ...ks, ks[ks.length - 1] + pad].slice(0, 8);
  if (xs.length === 8 && xs[7] < ks[ks.length - 1]) xs[7] = ks[ks.length - 1] + pad;
  const f = strategyPayoff(act, lotSize);
  const ys = xs.map(f);
  const lo = Math.min(0, ...ys);
  const hi = Math.max(0, ...ys);
  const span = hi - lo || 1;
  const X = (x) => Math.round(((x - xs[0]) / (xs[xs.length - 1] - xs[0])) * 320) / 10;
  const Y = (v) => Math.round((1 + ((hi - v) / span) * 14) * 10) / 10;
  return { points: xs.map((x, i) => [X(x), Y(ys[i])]), zero: Y(0) };
}

/** Builder settings (PRD 02 §13), persisted under `strategy` in mcb.dashboard.desk. */
export const STRATEGY_METRICS = Object.freeze([
  ["net", "Credit / debit"],
  ["maxProfit", "Max profit"],
  ["maxLoss", "Max loss"],
  ["breakevens", "Breakevens"],
  ["pop", "Chance of profit"],
  ["margin", "Margin"],
  ["atTarget", "At target"],
  ["rom", "Return on margin"],
  ["rr", "Reward / risk"],
  ["delta", "Delta"],
  ["gamma", "Gamma"],
  ["theta", "Theta"],
  ["vega", "Vega"],
  ["ev", "EV at IV"],
  ["charges", "Charges"],
]);
export const STRATEGY_DEFAULTS = Object.freeze({
  group: "neutral",
  basis: "touch",
  net: true,
  metrics: Object.freeze(["net", "maxProfit", "maxLoss", "breakevens", "pop", "margin", "atTarget", "theta"]),
  scenario: "pct",
  product: "MARGIN",
  hedgeWait: 15,
  moreOpen: false,
});
/** Settings with defaults: unknown keys dropped, bad values replaced, at least one metric kept. */
export function strategyConfig(saved) {
  const d = STRATEGY_DEFAULTS;
  const c = saved && typeof saved === "object" ? saved : {};
  const known = new Set(STRATEGY_METRICS.map(([k]) => k));
  const metrics = Array.isArray(c.metrics) ? c.metrics.filter((k, i, a) => known.has(k) && a.indexOf(k) === i) : [...d.metrics];
  return {
    group: PRESET_GROUPS.some(([g]) => g === c.group) ? c.group : d.group,
    basis: ["touch", "mid", "ltp"].includes(c.basis) ? c.basis : d.basis,
    net: typeof c.net === "boolean" ? c.net : d.net,
    metrics: metrics.length ? metrics : [...d.metrics],
    scenario: c.scenario === "sigma" ? "sigma" : d.scenario,
    product: c.product === "INTRADAY" ? "INTRADAY" : d.product,
    hedgeWait: [5, 15, 30].includes(c.hedgeWait) ? c.hedgeWait : d.hedgeWait,
    moreOpen: typeof c.moreOpen === "boolean" ? c.moreOpen : d.moreOpen,
  };
}

/** A leg's price on the chosen basis: touch (ask to buy, bid to sell), mid or LTP; LTP as the fallback; else null. */
export function basisPrice(quote, side, basis = "touch") {
  if (!quote) return { price: null, fallback: false };
  const b = num(quote.bid);
  const a = num(quote.ask);
  const want = basis === "ltp" ? num(quote.ltp) : basis === "mid" ? (b > 0 && a >= b ? (a + b) / 2 : null) : side === "BUY" ? (a > 0 ? roundToTick(a, 0.05, "buy") : null) : b > 0 ? roundToTick(b, 0.05, "sell") : null;
  if (want !== null && want > 0) return { price: want, fallback: false };
  const ltp = num(quote.ltp);
  return ltp !== null && ltp > 0 ? { price: ltp, fallback: basis !== "ltp" } : { price: null, fallback: false };
}

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const fin = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
/**
 * Validate saved strategies (localStorage or an imported file): enums, finite numbers, 1–12 legs, ≤ 50 items, strings
 * trimmed and capped, unknown fields dropped, clashing ids regenerated. → { items, skipped }.
 */
export function normaliseSaved(obj) {
  const list = Array.isArray(obj) ? obj : Array.isArray(obj?.items) ? obj.items : [];
  const items = [];
  const ids = new Set();
  let skipped = 0;
  for (const it of list) {
    if (items.length >= 50) {
      skipped += 1;
      continue;
    }
    const name = str(it?.name, 60);
    const underlying = str(it?.underlying, 20).toUpperCase();
    const expiry = str(it?.expiry, 10);
    const rawLegs = Array.isArray(it?.legs) ? it.legs : [];
    const okLegs = rawLegs.length >= 1 && rawLegs.length <= MAX_LEGS && rawLegs.every((l) => l && ["OPT", "FUT", undefined].includes(l.kind) && ["BUY", "SELL"].includes(l.side) && Number.isInteger(l.lots) && l.lots >= 1 && l.lots <= 10000 && (l.kind === "FUT" || ((l.right === "CE" || l.right === "PE") && fin(l.strike) > 0)) && (l.entry === undefined || l.entry === null || fin(l.entry) !== null));
    if (!name || !/^[A-Z0-9&]{1,20}$/.test(underlying) || !DATE_RE.test(expiry) || !okLegs) {
      skipped += 1;
      continue;
    }
    const legs = migrateLegs(rawLegs, expiry).map((l, i) => {
      const src = rawLegs[i];
      const iv = fin(src.ivAtSave);
      return { ...l, entry: fin(src.entry), ...(iv !== null ? { ivAtSave: iv } : {}), symbol: l.symbol ? l.symbol.slice(0, 64) : null };
    });
    let id = str(it?.id, 40);
    if (!id || ids.has(id)) id = `s${newLegId()}`;
    ids.add(id);
    const saved = typeof it?.savedAt === "string" && Number.isFinite(Date.parse(it.savedAt)) ? new Date(Date.parse(it.savedAt)).toISOString() : new Date(0).toISOString();
    items.push({
      id,
      name,
      underlying,
      expiry,
      legs,
      spotAtSave: fin(it?.spotAtSave),
      forwardAtSave: fin(it?.forwardAtSave),
      target: fin(it?.target),
      ivShift: fin(it?.ivShift) === null ? 0 : Math.max(-10, Math.min(10, it.ivShift)),
      savedAt: saved,
      notes: str(it?.notes, 500),
    });
  }
  return { items, skipped };
}
