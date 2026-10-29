/**
 * Option Desk maths: what a trader reads off a chain at a glance (PCR, max pain, OI walls, the ATM straddle) and
 * the small helpers the order ticket needs. Pure (no DOM, no fetch) so it runs in Node tests; numbers are formatted
 * by format.js, never here.
 *
 * A chain is GET /v1/optionchain's data: { underlying, expiry, underlyingLtp, atmStrike, lotSize,
 * rows: [{ strike, ce: { ltp, bid, ask, oi, oiChange, volume, iv, delta, ... } | null, pe: {...} | null }] }.
 */

import { DASH, MINUS, formatCompact, formatFixed, formatInt, formatRupee, formatSigned } from "./format.js";
import {
  atmIvAt,
  b76Delta,
  black76,
  calendarYearDays,
  greeks76,
  impliedVolB76,
  ivAtDelta,
  legPrice,
  normCdf,
  parityForward as pricingForward,
  probItm,
  realisedVol,
  sigmaMove,
  skewMetrics,
  smilePoints as pricingSmilePoints,
  strikeStep,
  volTime,
} from "./pricing.js";

// The pricing core lives in pricing.js (shared with the server); these names are re-exported so pages keep importing
// them from here. They are the same function objects.
export { atmIvAt, b76Delta, black76, impliedVolB76, ivAtDelta, legPrice, normCdf, probItm, realisedVol, sigmaMove, skewMetrics };

/**
 * @deprecated Use impliedVolB76. A thin wrapper kept for older callers: the one IV solver (pricing.js impliedVolB76)
 * on an undiscounted price (df = 1). Null when it cannot be solved (no clamping to the search bounds).
 */
export function impliedVol(price, forward, strike, years, right) {
  return impliedVolB76(price, forward, strike, years, right, 1);
}
import { REF_DEFAULTS, refCharges } from "./reference.js";

// Reference values (docs/spec/p1-02-reference.md §5.6): the rate, the session times and the charge table come from the
// page's reference bundle (reference.js). Callers pass them in; the defaults below are reference.js's labelled
// fallback, used only by callers that have no bundle (tests, a Bridge that cannot answer).
const FALLBACK_SESSION = REF_DEFAULTS.session;
const FALLBACK_RATE = REF_DEFAULTS.rate.value;
const FALLBACK_RATES = refCharges(null);
/** "HH:MM" → minutes after midnight, else the fallback session's value for that key. */
const hmOf = (hm, key = "close") => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hm ?? ""));
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const f = /^(\d{2}):(\d{2})$/.exec(FALLBACK_SESSION[key]);
  return Number(f[1]) * 60 + Number(f[2]);
};

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
 * Time left to an expiry (YYYY-MM-DD, settling at the session close, IST). `days` is fractional; `label` reads
 * "Expires today", "1 day", "6 days" or "Expired". `close` is the reference session's close ("HH:MM").
 */
export function timeToExpiry(expiry, now = Date.now(), close = FALLBACK_SESSION.close) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(expiry ?? ""));
  if (!m) return { days: null, label: "" };
  const closeMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + hmOf(close) * 60000 - IST_OFFSET_MS;
  return toCloseText(closeMs, now);
}
function toCloseText(close, now) {
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
/** Years to expiry (to the session close, IST), for pricing. */
export const yearsToExpiry = (expiry, now = Date.now(), close = FALLBACK_SESSION.close) => {
  const d = timeToExpiry(expiry, now, close).days;
  return d === null ? null : d / 365;
};
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
/**
 * Units of a leg: whole lots × its own lot size (else the fallback). A leg loaded from a position may carry its exact
 * `units` (an odd quantity such as half a lot): they count while `lots` is still the whole-lot count they round up to,
 * so editing the lots in the builder takes over again.
 */
export const legUnits = (l, fallbackLot) => {
  const lot = num(l?.lotSize) || num(fallbackLot) || 1;
  const lots = Math.max(0, Math.floor(num(l?.lots) ?? 0));
  const u = num(l?.units);
  return u !== null && u > 0 && Number.isInteger(u) && Math.max(1, Math.ceil(u / lot)) === lots ? u : lots * lot;
};
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
    // Never S = 0: there a later leg's Black-76 value collapses and the sampled worst case is fiction.
    const lo = Math.max(w !== null ? F0 * Math.exp(-w) : 0, 0.01 * (F0 ?? Math.max(ref, 1)));
    if (w !== null) hi = Math.max(F0 * Math.exp(w), strikes.length ? strikes[strikes.length - 1] * 1.01 : 0);
    const n = 400;
    const grid = Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n);
    pts = [...new Set([...grid, ...strikes.filter((k) => k > lo && k < hi)])].sort((a, b) => a - b);
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
  else if (F && F > 0 && sigPct && T > 0 && laterLegs) pop = probProfit(f, { forward: F, ivPct: sigPct, years: T });
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
  return { maxProfit, maxLoss, breakevens, pop, net, upSlope, stress, locked, topStrike: strikes.length ? strikes[strikes.length - 1] : null, approx: laterLegs };
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
const P = (id, name, group, risk, hint, needsFut = false, multi = false) => Object.freeze({ id, name, group, risk, needsFut, multi, hint, view: hint });
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
  P("call-calendar", "Long calendar (call)", "neutral", "defined", "Pins near the strike; gains on time", false, true),
  P("put-calendar", "Long calendar (put)", "neutral", "defined", "Pins near the strike; gains on time", false, true),
  P("call-diagonal", "Diagonal (call)", "neutral", "defined", "Drifts up slowly; gains on time", false, true),
  P("double-calendar", "Double calendar", "neutral", "defined", "A wide range; gains on time", false, true),
  P("double-diagonal", "Double diagonal", "neutral", "defined", "A range; time decay, defined risk", false, true),
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
 * fetched rows are clamped to the outermost listed one. A futures preset without `fut` returns []. Calendar presets
 * (`multi`) sell the chain's expiry and buy `back` (a later expiry: its legs carry `expiry`); without `back`, [].
 * @param {{ move?: number|null, forward?: number|null, fut?: { symbol: string, expiry: string, lotSize?: number }|null, back?: string|null }} [o]
 */
export function presetLegs(id, chain, { move = null, forward = null, fut = null, back = null } = {}) {
  const rows = chain?.rows ?? [];
  const atm = atmRow(chain);
  if (!atm || !rows.length) return [];
  const meta = PRESETS.find((p) => p.id === id);
  if (!meta) return [];
  if (meta.needsFut && !fut?.symbol) return [];
  if (meta.multi && !(typeof back === "string" && DATE_RE.test(back))) return [];
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
  const front = DATE_RE.test(String(chain?.expiry ?? "")) ? chain.expiry : null;
  const FR = (right, strike, side) => ({ ...L(right, strike, side), expiry: front });
  const BK = (right, strike, side) => ({ ...L(right, strike, side), expiry: back });
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
    case "call-calendar": return [FR("CE", K0, "SELL"), BK("CE", K0, "BUY")];
    case "put-calendar": return [FR("PE", K0, "SELL"), BK("PE", K0, "BUY")];
    case "call-diagonal": return [FR("CE", Kc1, "SELL"), BK("CE", K0, "BUY")];
    case "double-calendar": return [FR("PE", Kp1, "SELL"), BK("PE", Kp1, "BUY"), FR("CE", Kc1, "SELL"), BK("CE", Kc1, "BUY")];
    case "double-diagonal": return [FR("PE", Kp1, "SELL"), BK("PE", Kp1 - w, "BUY"), FR("CE", Kc1, "SELL"), BK("CE", Kc1 + w, "BUY")];
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
/** A usable two-sided quote: bid > 0 and ask ≥ bid. */
export const twoSided = (q) => num(q?.bid) !== null && num(q?.ask) !== null && q.bid > 0 && q.ask >= q.bid;
/**
 * e^(rT): turns a present-value option spread into forward points (put-call parity: C − P = (F − K)·e^(−rT)). `rate`
 * is required (the reference rate, refRate(bundle).value); without a finite rate this returns 1 (no carry).
 */
export const parityGrowth = (years, rate) => (num(years) !== null && years > 0 && num(rate) !== null ? Math.exp(Number(rate) * years) : 1);
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

const IST_HM = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
/** "10:42" in IST for an epoch-ms time ("--" when missing). */
export const istHm = (ms) => (Number.isFinite(ms) ? IST_HM.format(new Date(ms)) : DASH);
/** The IST calendar date ("YYYY-MM-DD"), weekday (0 = Sunday) and minutes since IST midnight of an epoch-ms time. */
export function istClock(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), dow: d.getUTCDay(), mins: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/**
 * Where the cash session stands (IST, the reference session's open and close): phase "pre" before the open on a
 * trading day, "open" in the session, "closed" after it, at weekends and on holidays. `session` is refSession(bundle)
 * ({ open, close, holiday, date }); `isTradingDay` (refCalendar(bundle).isTradingDay) adds the holiday list for other
 * days. A holiday reads "Market closed · <holiday>".
 */
export function marketSession(nowMs = Date.now(), session = FALLBACK_SESSION, { isTradingDay = null } = {}) {
  const c = istClock(nowMs);
  const s = session ?? FALLBACK_SESSION;
  const weekday = c.dow >= 1 && c.dow <= 5;
  const holiday = s.holiday && (!s.date || s.date === c.date) ? s.holiday : null;
  const trading = weekday && !holiday && (typeof isTradingDay !== "function" || isTradingDay(c.date));
  const phase = !trading ? "closed" : c.mins < hmOf(s.open, "open") ? "pre" : c.mins < hmOf(s.close, "close") ? "open" : "closed";
  const label = phase === "open" ? "Market open" : phase === "pre" ? "Before the open · last session" : holiday?.label ? `Market closed · ${holiday.label}` : "Market closed · last session";
  return { phase, istDate: c.date, weekday, holiday: holiday?.label ?? null, label };
}

/**
 * Trading sessions left to an expiry, today included while the session has not closed. Weekends never count;
 * `isTradingDay` (refCalendar(bundle).isTradingDay) also skips holidays; `session` gives the close.
 */
export function sessionsLeft(expiry, now = Date.now(), { session = FALLBACK_SESSION, isTradingDay = null } = {}) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(expiry ?? ""));
  if (!m) return null;
  const exp = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
  const today = Math.floor((now + IST_OFFSET_MS) / 86400000);
  const afterClose = istClock(now).mins >= hmOf(session?.close, "close");
  let n = 0;
  for (let d = today; d <= exp && d - today < 800; d += 1) {
    const dow = (d + 4) % 7; // 1970-01-01 was a Thursday
    if (dow === 0 || dow === 6 || (d === today && afterClose)) continue;
    if (typeof isTradingDay === "function" && !isTradingDay(new Date(d * 86400000).toISOString().slice(0, 10))) continue;
    n += 1;
  }
  return n;
}
/** How much max pain matters: "high" with ≤ 2 sessions left, "medium" with ≤ 5, else "low" (null without an expiry). */
export function maxPainRelevance(expiry, now = Date.now(), cal = {}) {
  const n = sessionsLeft(expiry, now, cal);
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

/**
 * Where a PCR sits on the OI page's gauge (docs/design/oi.md §7.3): a log scale from `lo` to `hi`, clamped to 0..1, so
 * 0.5 and 2.0 sit the same distance from 1.0. Null for a missing or non-positive ratio. Pure.
 */
export function pcrGaugePos(p, lo = 0.4, hi = 2.5) {
  const x = num(p);
  if (x === null || x <= 0 || !(lo > 0) || !(hi > lo)) return null;
  return Math.max(0, Math.min(1, (Math.log(x) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))));
}

/** The underlying effect of a build-up word: "pos" (bullish / supportive), "neg" (bearish / capping) or "neutral". */
export const buildupEffect = (word) => (word === "bullish" || word === "supportive" ? "pos" : word === "bearish" || word === "capping" ? "neg" : "neutral");

/**
 * The build-up matrix as heat cells (oi.md §7.5): per side and class { n, lots, effect, step }. `effect` is what the
 * class means for the underlying on that side ("pos" / "neg" / "neutral" for churn); `step` = min(3, ceil(3 · lots /
 * maxLots)) over all 10 cells, 0 for an empty cell. Input: buildupSummary() output. Pure.
 */
export function buildupHeat(bu) {
  const out = { ce: {}, pe: {} };
  let max = 0;
  for (const s of ["ce", "pe"]) for (const k of CLASSES) max = Math.max(max, num(bu?.[s]?.[k]?.lots) ?? 0);
  for (const s of ["ce", "pe"]) {
    for (const k of CLASSES) {
      const c = bu?.[s]?.[k] ?? { n: 0, lots: 0 };
      const lots = num(c.lots) ?? 0;
      const n = num(c.n) ?? 0;
      const step = lots > 0 && max > 0 ? Math.min(3, Math.max(1, Math.ceil((3 * lots) / max))) : 0;
      out[s][k] = { n, lots, effect: buildupEffect(BUILDUP_READ[s][k][1]), step };
    }
  }
  return out;
}

/**
 * Spot as a fractional index into ascending strikes (oi.md §6.3): i + (spot − k_i) / (k_{i+1} − k_i). An exact strike
 * gives its index; null without strikes or spot, or when spot is outside the first..last strike. Pure.
 */
export function spotX(strikes, spot) {
  const s = num(spot);
  const ks = (strikes ?? []).map(num).filter((k) => k !== null);
  if (s === null || !ks.length || s < ks[0] || s > ks[ks.length - 1]) return null;
  for (let i = 0; i < ks.length; i += 1) {
    if (s === ks[i]) return i;
    if (i + 1 < ks.length && s > ks[i] && s < ks[i + 1]) return i + (s - ks[i]) / (ks[i + 1] - ks[i]);
  }
  return null;
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
export function pickRef(snaps, nowMs, win, { hasPrev = false, open = FALLBACK_SESSION.open } = {}) {
  if (win === "prev") return hasPrev ? { snap: null, label: "vs previous close", ok: true, reason: null } : { snap: null, label: "vs previous close", ok: false, reason: NO_PREV_OI };
  const name = OI_WINDOWS.find((w) => w[0] === win)?.[1] ?? win;
  const list = (snaps ?? []).filter((s) => Number.isFinite(s?.t) && s.t <= nowMs).sort((a, b) => a.t - b.t);
  if (!list.length) return { snap: null, label: "", ok: false, reason: `No snapshots yet: ${name} works once this page has recorded for a while` };
  const first = list[0];
  if (win === "open") {
    const late = istClock(first.t).mins > hmOf(open, "open") + 5;
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
  else if (r1 !== null) parts.push(`Call wall ${formatInt(r1)}`);
  else if (s1 !== null) parts.push(`Put wall ${formatInt(s1)}`);
  if (buildup?.short && !buildup.empty) parts.push(buildup.short);
  const p = num(pcr);
  if (p !== null) parts.push(`PCR ${formatFixed(p, 2)} ${pcrBand(p)?.word ?? ""}`.trim());
  if (num(mp) !== null) parts.push(`Max Pain ${formatInt(mp)}${relevance ? ` (${relevance} relevance)` : ""}`);
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
      if (l.entryTag === "avg" || l.entryTag === "saved" || l.entryTag === "manual") leg.entryTag = l.entryTag;
    }
    if (["INTRADAY", "MARGIN", "CNC"].includes(l.product)) leg.product = l.product;
    if (Number.isInteger(num(l.units)) && num(l.units) > 0) leg.units = num(l.units);
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
    const sameExp = !l.expiry || !m.expiry || l.expiry === m.expiry;
    return (l.kind === "FUT") === (m.kind === "FUT") && (l.kind === "FUT" || (l.right === m.right && l.strike === m.strike && sameExp)) && l.side === m.side && Math.floor(l.lots) === Math.floor(m.lots) && l.on !== false;
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

/** The settlement moment of an expiry date (the reference session close, IST), epoch ms; null for a bad date. */
export function expiryCloseMs(expiry, close = FALLBACK_SESSION.close) {
  const m = DATE_RE.exec(String(expiry ?? "")) ? String(expiry).split("-").map(Number) : null;
  return m ? Date.UTC(m[0], m[1] - 1, m[2]) + hmOf(close) * 60000 - IST_OFFSET_MS : null;
}

/**
 * Black-76 greeks per unit (forward measure, r = 0): delta, gamma (per point), theta (₹ per calendar day, per unit)
 * and vega (per vol point). At or after expiry: delta 1 / −1 in the money, 0 out of it, the rest 0. The maths is
 * pricing.js greeks76; theta stays per calendar day here until the pages move to the vol-time clock (P1-3b).
 */
export function black76Greeks(forward, strike, years, ivPct, right) {
  return greeks76(forward, strike, years, ivPct, right, { yearBasis: calendarYearDays() });
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

// Statutory charges on Indian F&O: the reference table (GET /v1/reference/charges, in the page's bundle), turned into
// this shape by refCharges(bundle): { asOf, asOfDate, brokeragePerOrder, opt: { sttSell, exerciseStt, stampBuy, txn },
// fut: { sttSell, stampBuy, txn }, sebiPerCrore, ipftPerCrore, gst }. Every function below takes it as `rates`.
const exchangeOf = (l) => (/^BFO:/.test(String(l?.symbol ?? "")) ? "BSE" : "NSE");
/** Statutory lines of one order (brokerage given): the shared core of `charges` and the arbitrage `orderCharges`. */
function chargeLines(kind, side, turnover, exch, r, brokerage = turnover > 0 ? num(r.brokeragePerOrder) ?? 0 : 0) {
  const k = kind === "FUT" ? r.fut : r.opt;
  const stt = side === "SELL" ? turnover * k.sttSell : 0;
  const txn = turnover * (k.txn[exch] ?? k.txn.NSE);
  const sebi = (turnover * r.sebiPerCrore) / 1e7;
  const ipft = (turnover * (r.ipftPerCrore ?? 0)) / 1e7;
  const stamp = side === "BUY" ? turnover * k.stampBuy : 0;
  const gst = (brokerage + txn + sebi + ipft) * r.gst;
  return { brokerage, stt, txn, sebi, ipft, stamp, gst };
}
const addCharges = (a, b) => {
  for (const k of Object.keys(b)) a[k] = (a[k] ?? 0) + b[k];
  return a;
};
/**
 * Entry charges of a basket at its prices (one order per leg): { brokerage, stt, txn, sebi, stamp, gst, total }.
 * Legs without a price are skipped.
 */
export function charges(legs, rates = FALLBACK_RATES, { lotSize = 1 } = {}) {
  const out = { brokerage: 0, stt: 0, txn: 0, sebi: 0, ipft: 0, stamp: 0, gst: 0 };
  for (const l of activeLegs(legs)) {
    const p = num(l.price);
    if (p === null) continue;
    addCharges(out, chargeLines(isFut(l) ? "FUT" : "OPT", l.side, p * legUnits(l, lotSize), exchangeOf(l), rates));
  }
  out.total = out.brokerage + out.stt + out.txn + out.sebi + out.ipft + out.stamp + out.gst;
  return out;
}
/**
 * Charges to get out at expiry with the underlying at S: exercise STT on long in-the-money options (on intrinsic ×
 * units) plus squaring off FUT legs at S. Shorts that expire worthless or are assigned pay nothing here.
 */
export function exitCharges(legs, S, rates = FALLBACK_RATES, { lotSize = 1 } = {}) {
  let t = 0;
  for (const l of activeLegs(legs)) {
    const u = legUnits(l, lotSize);
    if (isFut(l)) {
      const c = chargeLines("FUT", l.side === "BUY" ? "SELL" : "BUY", Math.max(0, S) * u, exchangeOf(l), rates);
      t += c.brokerage + c.stt + c.txn + c.sebi + c.ipft + c.stamp + c.gst;
    } else if (l.side === "BUY") t += intrinsicOf(l, S) * u * rates.opt.exerciseStt;
  }
  return t;
}

/**
 * Entry and exit charges for the figures: { entry, exit(S) }. Exit charges grow with S (exercise STT on a long ITM
 * option, FUT turnover), so S is held inside the strikes widened to F·e^(±3σ√T): far tails (S = 0, 2 × the top strike)
 * would otherwise inflate max loss with STT nobody pays in a market that can actually trade.
 */
export function strategyCharges(legs, rates = FALLBACK_RATES, { lotSize = 1, forward = null, ivPct = null, years = null } = {}) {
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
 * The payoff chart's x-range: wide enough for 2.6 expected moves, every strike (×1.35 its distance), ±1.5% of spot
 * and `sd2` (2.2σ, so the ±2σ band is always inside). Depends only on the legs' strikes, spot and the move, so it
 * holds still across ticks.
 */
export function payoffRange(legs, { spot, move = null, sd2 = null }) {
  const S = num(spot);
  if (!S) return null;
  const ks = activeLegs(legs).filter((l) => !isFut(l)).map((l) => l.strike);
  const span = Math.max((num(move) ?? S * 0.02) * 2.6, ...ks.map((k) => Math.abs(k - S) * 1.35), S * 0.015, num(sd2) ?? 0);
  return { lo: Math.max(0, S - span), hi: S + span };
}

/**
 * Everything the payoff chart draws (PRD 02 §9.1, docs/design/strategy.md §4.4), pure: sample prices, the expiry
 * curve (at the first expiry `years`: legs that expire later are valued by Black-76, so a calendar bends), the target
 * curve (null when the target is the expiry or a leg has no IV) and, with `curves: 3`, a mid-date curve; breakevens,
 * ±1σ / ±2σ bands and the log-normal density at the curve horizon; the argmax / argmin prices of the expiry curve; the
 * profitable intervals; and a y-range with a 4× clamp (a far tail would flatten the rest; `clip` says what was cut).
 * @param {{ lotSize: number, spot: number, forward: number, years: number, el?: number, ivShift?: number,
 *   ivPct?: number|null, charges?: { entry: number, exit: (S: number) => number }|null, range?: { lo, hi }|null,
 *   samples?: number, curves?: 1|2|3, clamp?: boolean }} m
 */
export function payoffModel(legs, m) {
  const act = activeLegs(legs);
  const spot = num(m?.spot) ?? num(m?.forward);
  if (!act.length || spot === null) return null;
  const F = num(m.forward) ?? spot;
  const T = num(m.years) ?? 0;
  const el = Math.max(0, num(m.el) ?? 0);
  const shift = num(m.ivShift) ?? 0;
  const curves = [1, 2, 3].includes(m.curves) ? m.curves : 2;
  const iv = num(m.ivPct) !== null && m.ivPct > 0 ? Math.max(1, m.ivPct + shift) : null;
  const range = m.range ?? payoffRange(act, { spot, move: sigmaMove(F, iv, T), sd2: sigmaMove(F, iv, T) ? 2.2 * sigmaMove(F, iv, T) : null });
  const { lo, hi } = range;
  const n = Math.max(20, Math.min(260, num(m.samples) ?? 240));
  const strikes = [...new Set(act.filter((l) => !isFut(l)).map((l) => l.strike))].sort((a, b) => a - b);
  const xs = [...new Set([...Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n), ...strikes.filter((k) => k > lo && k < hi)])].sort((a, b) => a - b);
  const f = strategyPayoff(act, m.lotSize, { years: T, ivShift: shift, charges: m.charges ?? null });
  const expiry = xs.map(f);
  const basis = F - spot;
  const entry = num(m.charges?.entry) ?? 0;
  const curveAt = (e) => {
    const v = xs.map((S) => {
      const x = valueAt(act, S, m.lotSize, null, basis, { el: e, ivShift: shift });
      return x === null ? null : x - entry;
    });
    return v.some((x) => x === null) ? null : v;
  };
  const target = curves >= 2 && T > 0 && el < T - 1e-7 ? curveAt(el) : null;
  const midEl = (el + T) / 2;
  const mid = curves === 3 && target && T - el > 1 / 365 ? curveAt(midEl) : null;
  const stats = strategyStats(act, m.lotSize, { forward: F, ivPct: m.ivPct, years: T, ivShift: shift, spot, charges: m.charges ?? null });
  let iMax = 0;
  let iMin = 0;
  expiry.forEach((v, i) => {
    if (v > expiry[iMax]) iMax = i;
    if (v < expiry[iMin]) iMin = i;
  });
  const all = [...expiry, ...(target ?? []), ...(mid ?? []), 0];
  let yMin = Math.min(...all);
  let yMax = Math.max(...all);
  // Symmetric clamp: the dominant side stops at 4× the other, so the profitable part keeps its height.
  let clip = null;
  if (m.clamp !== false && yMax > 0 && yMin < 0) {
    if (-yMin > 4 * yMax) {
      clip = { side: "low", value: expiry[iMin] < Math.min(...(target ?? [0])) ? expiry[iMin] : Math.min(...all), at: xs[iMin] };
      yMin = -4 * yMax;
    } else if (yMax > 4 * -yMin) {
      clip = { side: "high", value: Math.max(...all), at: xs[iMax] };
      yMax = 4 * -yMin;
    }
  }
  const pad = (yMax - yMin || Math.abs(yMax) || 1) * 0.12;
  yMin -= pad;
  yMax += pad;
  // The bands and the density belong to the horizon the user reads: the target date when it is later than now and
  // a target curve shows, else the first expiry.
  const horizon = curves >= 2 && target && el > 1e-6 ? el : T;
  const b1 = sigmaBand(F, iv, horizon, 1);
  const b2 = sigmaBand(F, iv, horizon, 2);
  let density = null;
  if (iv !== null && horizon > 0) {
    const d = xs.map((S) => lognormalPdf(S, F, iv / 100, horizon));
    const top = Math.max(...d);
    density = top > 0 ? d.map((v) => v / top) : null;
  }
  return {
    xs,
    expiry,
    target,
    mid,
    curves: [{ id: "expiry", vals: expiry, el: T }, ...(target ? [{ id: "target", vals: target, el }] : []), ...(mid ? [{ id: "mid", vals: mid, el: midEl }] : [])],
    breakevens: stats?.breakevens ?? [],
    band1: b1 ? [b1.lo, b1.hi] : null,
    band2: b2 ? [b2.lo, b2.hi] : null,
    density,
    horizon,
    profitIntervals: intervalsWhere(xs, expiry, (v) => v > 0),
    maxProfitAt: xs[iMax],
    maxLossAt: xs[iMin],
    approx: Boolean(stats?.approx),
    clip,
    spot,
    forward: F,
    ivPct: iv,
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
 *   lotSize?: number, legCount?: number, rates?: object, chainAgeMs?: number|null, today?: string }} c
 */
export function strategyWarnings(c) {
  const out = [];
  const add = (code, severity, text) => out.push({ code, severity, text });
  const legs = activeLegs(c?.legs);
  const lot = num(c?.lotSize) || 1;
  const listed = new Set(c?.strikes ?? []);
  const rates = c?.rates ?? FALLBACK_RATES;
  const S = num(c?.spot);
  const age = num(c?.chainAgeMs);
  if (age !== null && age > STALE_MS) add("STALE", "block", `Prices are ${formatInt(Math.round(age / 1000))} s old`);
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
    const stress = st.stress ? `: stress ${MINUS}${rupeeShort(Math.min(0, st.stress.value))} at +2σ` : "";
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
  // Calendars and diagonals (option legs in two or more expiries).
  const optExps = [...new Set(legs.filter((l) => !isFut(l) && l.expiry).map((l) => l.expiry))].sort();
  if (optExps.length > 1) {
    if (c?.today && optExps[0] === c.today) add("CAL_EXPIRY_DAY", "warn", "Front leg expires today: no calendar benefit left");
    const ivOf = (e) => {
      const v = legs.filter((l) => !isFut(l) && l.expiry === e && num(l.iv) !== null).map((l) => l.iv);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const f0 = ivOf(optExps[0]);
    const b0 = ivOf(optExps[optExps.length - 1]);
    if (f0 !== null && b0 !== null && b0 < f0 - 2) add("BACK_IV_LOWER", "info", "Back month IV below front: calendars lose on IV convergence");
  }
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
  ["pop", "POP"],
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
  scenario: "strikes",
  product: "MARGIN",
  hedgeWait: 15,
  moreOpen: false,
  curves: 2,
  dist: true,
  perLeg: false,
  yMode: "rupee",
  table: "spot",
  riskOpen: true,
  suggestOpen: false,
});
/** Settings with defaults: unknown keys dropped, bad values replaced, at least one metric kept. */
export function strategyConfig(saved) {
  const d = STRATEGY_DEFAULTS;
  const c = saved && typeof saved === "object" ? saved : {};
  const known = new Set(STRATEGY_METRICS.map(([k]) => k));
  const metrics = Array.isArray(c.metrics) ? c.metrics.filter((k, i, a) => known.has(k) && a.indexOf(k) === i) : [...d.metrics];
  const bool = (k) => (typeof c[k] === "boolean" ? c[k] : d[k]);
  return {
    group: PRESET_GROUPS.some(([g]) => g === c.group) ? c.group : d.group,
    basis: ["touch", "mid", "ltp"].includes(c.basis) ? c.basis : d.basis,
    net: bool("net"),
    metrics: metrics.length ? metrics : [...d.metrics],
    scenario: ["strikes", "pct", "sigma"].includes(c.scenario) ? c.scenario : d.scenario,
    product: c.product === "INTRADAY" ? "INTRADAY" : d.product,
    hedgeWait: [5, 15, 30].includes(c.hedgeWait) ? c.hedgeWait : d.hedgeWait,
    moreOpen: bool("moreOpen"),
    curves: [1, 2, 3].includes(c.curves) ? c.curves : d.curves,
    dist: bool("dist"),
    perLeg: bool("perLeg"),
    yMode: c.yMode === "pct" ? "pct" : d.yMode,
    table: ["spot", "grid", "greeks"].includes(c.table) ? c.table : d.table,
    riskOpen: bool("riskOpen"),
    suggestOpen: bool("suggestOpen"),
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

// ── Book risk ──
//
// The #/positions page (PRD 04): every open option and future on one underlying, all expiries, priced from its own
// expiry's chain (else a quote and an IV solved from it), summed into book Greeks, a scenario P&L calibrated to the
// marks, a hedge proposal and a safe exit plan. Quantities are signed units (q > 0 long, q < 0 short).

/** Extra exposure margin on index option shorts on their expiry day (fraction of notional). */
export const EXPIRY_ELM = 0.02;
const OPT_RE = /^(NFO|BFO):([A-Z0-9&]+)-(\d{4}-\d{2}-\d{2})-([\d.]+)-(CE|PE)$/;
const FUT_RE = /^(NFO|BFO):([A-Z0-9&]+)-(\d{4}-\d{2}-\d{2})-FUT$/;
/** Half rounds away from zero (2.5 → 3, −2.5 → −3). */
export const roundHalfAway = (x) => (x < 0 ? -Math.round(-x) : Math.round(x));
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

/** "NFO:NIFTY-2026-11-24-FUT" → { exchange, underlying, expiry } (null when not a future). */
export function parseFutureSymbol(symbol) {
  const m = FUT_RE.exec(String(symbol ?? ""));
  return m ? { exchange: m[1], underlying: m[2], expiry: m[3] } : null;
}

/**
 * Book legs on one underlying from GET /v1/positions rows: options and futures of every expiry, exact underlying
 * match (NIFTY is not NIFTYNXT50). netQty 0 rows are kept only with `closed` (today's closed legs, for realised P&L).
 * @returns {Array<{ symbol, kind: "OPT"|"FUT", underlying, expiry, strike, right, q, avg, product, realised, ltp, pnl }>}
 */
export function bookLegs(positions, underlying, { closed = false } = {}) {
  const u = String(underlying ?? "").toUpperCase();
  const out = [];
  for (const p of positions ?? []) {
    const s = String(p?.symbol ?? "");
    const o = OPT_RE.exec(s);
    const f = o ? null : FUT_RE.exec(s);
    const m = o ?? f;
    if (!m || m[2] !== u) continue;
    const q = num(p.netQty) ?? 0;
    if (!q && !closed) continue;
    out.push({
      symbol: s,
      kind: o ? "OPT" : "FUT",
      underlying: m[2],
      expiry: m[3],
      strike: o ? Number(o[4]) : null,
      right: o ? o[5] : null,
      q,
      avg: num(p.avgPrice),
      product: ["INTRADAY", "MARGIN", "CNC"].includes(p.product) ? p.product : "MARGIN",
      realised: num(p.realisedPnl),
      unrealised: num(p.unrealisedPnl),
      ltp: num(p.ltp),
      pnl: num(p.pnl),
    });
  }
  return out;
}

/** Other underlyings with open option / future legs: [{ underlying, legs, pnl }] (broker P&L), by name. */
export function bookUnderlyings(positions, except = null) {
  const m = new Map();
  for (const p of positions ?? []) {
    const s = String(p?.symbol ?? "");
    const r = OPT_RE.exec(s) ?? FUT_RE.exec(s);
    if (!r || !num(p.netQty) || r[2] === except) continue;
    const e = m.get(r[2]) ?? { underlying: r[2], legs: 0, pnl: 0 };
    e.legs += 1;
    e.pnl += num(p.pnl) ?? 0;
    m.set(r[2], e);
  }
  return [...m.values()].sort((a, b) => (a.underlying < b.underlying ? -1 : 1));
}

/** The last option expiry of each calendar month (the monthly series, where index futures expire). */
export function monthlyExpiries(expiries) {
  const by = new Map();
  for (const e of [...(expiries ?? [])].filter((x) => DATE_RE.test(String(x))).sort()) by.set(e.slice(0, 7), e);
  return [...by.values()];
}

/**
 * The mark of a quote: the mid when both sides are quoted and the spread is at most 20 % of it, else the LTP.
 * @returns {{ mark: number|null, source: "mid"|"ltp"|null }}
 */
export function legMark(quote) {
  const b = num(quote?.bid);
  const a = num(quote?.ask);
  if (b > 0 && a > 0 && a >= b && (a - b) / ((a + b) / 2) <= 0.2) return { mark: (a + b) / 2, source: "mid" };
  const l = num(quote?.ltp);
  return l !== null && l > 0 ? { mark: l, source: "ltp" } : { mark: null, source: null };
}


/**
 * Price every book leg (pure). Options read their own expiry's chain (mark, IV, the server's Greeks); a leg missing
 * from it falls back to `quotes` with IV solved from the mark and Black-76 Greeks. Futures: mark from `quotes`, Δ 1.
 * `inst` gives lotSize / freezeQty / tickSize per symbol (else the chain's lot size, else 1 with `lotUnknown`).
 * @param {object[]} legs from bookLegs
 * @param {{ chains?: Map<string, object>, quotes?: Map<string, object>, inst?: Map<string, object>, spot?: number|null,
 *   excluded?: Set<string>, now?: number, rate?: number, close?: string }} m `close` is the reference session close
 *   ("HH:MM" IST) time to expiry is measured to.
 */
export function priceBook(legs, { chains = new Map(), quotes = new Map(), inst = new Map(), spot = null, excluded = new Set(), now = Date.now(), rate = FALLBACK_RATE, close = FALLBACK_SESSION.close } = {}) {
  const fwd = new Map();
  const futMark = new Map();
  for (const l of legs) {
    if (l.kind !== "FUT") continue;
    const mk = legMark(quotes.get(l.symbol)).mark;
    if (mk !== null) futMark.set(l.expiry, mk);
  }
  let S = num(spot);
  for (const c of chains.values()) if (S === null) S = num(c?.underlyingLtp);
  const expCtx = (e) => {
    if (fwd.has(e)) return fwd.get(e);
    const c = chains.get(e) ?? null;
    const T = yearsToExpiry(e, now, close) ?? 0;
    const sm = c ? chainSummary(c) : null;
    const F = (c ? forwardPrice(c, parityGrowth(T, rate)) : null) ?? futMark.get(e) ?? S;
    const ctx = { chain: c, T, F, atmIv: sm?.atmIv ?? null, lot: num(c?.lotSize) };
    fwd.set(e, ctx);
    return ctx;
  };
  return legs.map((l) => {
    const ix = inst.get(l.symbol) ?? null;
    const x = expCtx(l.expiry);
    const lot = num(ix?.lotSize) || x.lot || 1;
    const base = { ...l, lot, lotUnknown: !(num(ix?.lotSize) || x.lot), freeze: num(ix?.freezeQty), tick: num(ix?.tickSize) || 0.05, inc: !excluded.has(l.symbol), T: x.T, expired: !(x.T > 0) };
    if (l.kind === "FUT") {
      const qt = quotes.get(l.symbol) ?? null;
      const { mark, source } = legMark(qt);
      return { ...base, quote: qt, mark, markSrc: source, F: mark, atmIv: null, iv: null, ivSolved: false, greeks: { delta: 1, gamma: 0, theta: 0, vega: 0 }, priced: mark !== null, why: mark === null ? "no quote" : null };
    }
    const row = x.chain?.rows?.find((r) => r.strike === l.strike);
    const fromChain = row?.[l.right === "CE" ? "ce" : "pe"] ?? null;
    const qt = fromChain ?? quotes.get(l.symbol) ?? null;
    let { mark, source } = legMark(qt);
    const F = x.F;
    if (base.expired && F !== null) {
      mark = l.right === "CE" ? Math.max(0, F - l.strike) : Math.max(0, l.strike - F);
      source = "intrinsic";
    }
    let iv = num(fromChain?.iv);
    let ivSolved = false;
    if (iv === null && mark !== null && !base.expired) {
      iv = impliedVol(mark, F, l.strike, x.T, l.right);
      ivSolved = iv !== null;
    }
    const chainG = fromChain && ["delta", "gamma", "theta", "vega"].every((k) => num(fromChain[k]) !== null) ? { delta: num(fromChain.delta), gamma: num(fromChain.gamma), theta: num(fromChain.theta), vega: num(fromChain.vega) } : null;
    const greeks = chainG ?? (F !== null && (iv !== null || base.expired) ? black76Greeks(F, l.strike, base.expired ? 0 : x.T, iv ?? 0, l.right) : null);
    const priced = mark !== null && F !== null && (iv !== null || base.expired) && greeks !== null;
    return { ...base, quote: qt, mark, markSrc: source, F, atmIv: x.atmIv ?? iv, iv, ivSolved, greeks, priced, why: priced ? null : mark === null ? "no quote" : "no IV" };
  });
}

/**
 * Model value per unit of a priced leg at a scenario: options Black-76 on F·(1 + dS) with IV + dIv (floored at
 * 0.5 %) and `days` less to expiry (intrinsic past it); futures F·(1 + dS). Null when it cannot be valued.
 */
export function priceLeg(leg, { dS = 0, dIv = 0, days = 0 } = {}) {
  const F = num(leg?.F);
  if (F === null) return null;
  const Fs = F * (1 + dS);
  if (leg.kind === "FUT") return Fs;
  const T = Math.max(0, (num(leg.T) ?? 0) - days / 365);
  if (T > 0 && num(leg.iv) === null) return null;
  return black76(Fs, leg.strike, T, Math.max(0.5, (num(leg.iv) ?? 0) + dIv), leg.right);
}
/** Calibration: mark − model value now, so a scenario at (0, 0, 0) equals the live P&L. 0 once the leg has expired. */
export function legAdj(leg, days = 0) {
  if (leg?.kind === "FUT" || num(leg?.mark) === null) return 0;
  if (!((num(leg.T) ?? 0) - days / 365 > 0)) return 0;
  const v = priceLeg(leg, {});
  return v === null ? 0 : leg.mark - v;
}
const counts = (l) => l && l.priced && l.inc !== false && num(l.avg) !== null;
/** Unrealised P&L of the included, priced legs at a scenario (₹): Σ q × (value + calibration − avg). */
export function scenarioPnl(legs, shift = {}) {
  let t = 0;
  for (const l of legs ?? []) {
    if (!counts(l)) continue;
    const v = priceLeg(l, shift);
    if (v === null) continue;
    t += l.q * (v + legAdj(l, shift.days ?? 0) - l.avg);
  }
  return t;
}
/** Unrealised P&L per leg from its mark (no model): (mark − avg) × q, or null. */
export const legPnl = (l) => (num(l?.mark) !== null && num(l?.avg) !== null ? (l.mark - l.avg) * l.q : null);
/**
 * Unrealised P&L of a leg: from its mark, else the broker's unrealised figure, else its total P&L less realised (the
 * broker `pnl` is realised + unrealised, so it is never used whole). Closed legs (q 0) have none.
 */
export function legUnrealised(l) {
  if (!num(l?.q)) return 0;
  const u = legPnl(l);
  if (u !== null) return u;
  if (num(l.unrealised) !== null) return num(l.unrealised);
  return num(l.pnl) !== null ? num(l.pnl) - (num(l.realised) ?? 0) : 0;
}
/**
 * The book's P&L (₹) over every leg, today's closed ones (q 0) included: realised R, unrealised U and whether the
 * broker sent no realised figure for an open leg (`noRealised`).
 */
export function bookPnl(legs) {
  let realised = 0;
  let unrealised = 0;
  let noRealised = false;
  for (const l of legs ?? []) {
    unrealised += legUnrealised(l);
    if (num(l.realised) === null) noRealised ||= Boolean(num(l.q));
    else realised += num(l.realised);
  }
  return { realised, unrealised, total: realised + unrealised, noRealised };
}

/**
 * Book Greeks from the legs' own Greeks (the chain's, else Black-76 on the solved IV): Δ units, Γ per point, Θ ₹ per
 * calendar day, Vega ₹ per vol point. Excluded legs count nowhere; included legs without Greeks are in `missing`.
 */
export function bookGreeks(legs) {
  const out = { delta: 0, gamma: 0, theta: 0, vega: 0, missing: [], excluded: 0, priced: 0 };
  for (const l of legs ?? []) {
    if (l.inc === false) {
      out.excluded += 1;
      continue;
    }
    if (!l.priced || !l.greeks) {
      out.missing.push(l);
      continue;
    }
    out.priced += 1;
    if (l.kind === "FUT") {
      out.delta += l.q;
      continue;
    }
    for (const k of ["delta", "gamma", "theta", "vega"]) out[k] += l.q * l.greeks[k];
  }
  return out;
}
/** Analytic Black-76 Greeks of the included legs at a scenario (the scenario panel's output line). */
export function scenarioGreeks(legs, { dS = 0, dIv = 0, days = 0 } = {}) {
  const out = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  for (const l of legs ?? []) {
    if (!counts(l)) continue;
    if (l.kind === "FUT") {
      out.delta += l.q;
      continue;
    }
    const g = black76Greeks(l.F * (1 + dS), l.strike, Math.max(0, l.T - days / 365), Math.max(0.5, (num(l.iv) ?? 0) + dIv), l.right);
    if (g) for (const k of Object.keys(out)) out[k] += l.q * g[k];
  }
  return out;
}

/** Spot ladders of the scenario matrix: % moves, or σ multiples for "sigma". */
export const LADDERS = Object.freeze({
  tight: Object.freeze([-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5]),
  wide: Object.freeze([-10, -5, -3, -2, -1, 0, 1, 2, 3, 5, 10]),
  sigma: Object.freeze([-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2]),
});
/**
 * Scenario matrix: rows = spot ladder, columns = IV shifts (`ivCols`, default −5, 0, +5, at `days`) or days
 * (`dayCols`, default Today, +1, +3, first expiry, at `dIv`; deduped and clamped to the first expiry). `sigmaPct` = 1σ
 * move in % of F (the sigma ladder). Cells are unrealised P&L (scenarioPnl). `m95` = the 95th percentile of |cell|,
 * the diverging colour scale (divStep), so one outlier does not wash the rest out.
 * @returns {{ rows: Array<{ pct, k, price, cells: number[] }>, cols: Array<{ label, short, dIv, days }>, worst, best, m95 }}
 */
export function scenarioGrid(legs, { ladder = "tight", axis = "iv", days = 0, dIv = 0, sigmaPct = null, F = null, firstDays = 0, ivCols = null, dayCols = null } = {}) {
  const lad = LADDERS[ladder] ?? LADDERS.tight;
  const sig = ladder === "sigma" && num(sigmaPct) > 0;
  const steps = ladder === "sigma" && !sig ? LADDERS.tight : lad;
  const fd = Math.max(0, Math.round(num(firstDays) ?? 0));
  const ivList = Array.isArray(ivCols) && ivCols.length ? [...new Set(ivCols.map(Number).filter(Number.isFinite))].sort((a, b) => a - b) : [-5, 0, 5];
  const dayList = [...new Set((Array.isArray(dayCols) && dayCols.length ? dayCols : [0, 1, 3, fd]).map((x) => Math.max(0, Math.min(fd, Math.round(Number(x) || 0)))))].sort((a, b) => a - b);
  const minus = (x) => (x < 0 ? `\u2212${Math.abs(x)}` : `+${x}`);
  const cols =
    axis === "days"
      ? dayList.map((dd) => (dd === 0 ? { label: "Today", short: "Today", dIv, days: 0 } : dd === fd ? { label: `Expiry (+${fd})`, short: "Exp", dIv, days: fd } : { label: `+${dd} day${dd === 1 ? "" : "s"}`, short: `+${dd}d`, dIv, days: dd }))
      : ivList.map((v) => ({ label: v === 0 ? "IV now" : `IV ${minus(v)}`, short: v === 0 ? "now" : minus(v), dIv: v, days }));
  let worst = null;
  let best = null;
  const abs = [];
  const rows = steps.map((k, r) => {
    const pct = sig ? k * sigmaPct : k;
    const cells = cols.map((c, ci) => {
      const v = scenarioPnl(legs, { dS: pct / 100, dIv: c.dIv, days: c.days });
      if (!worst || v < worst.v) worst = { v, r, c: ci };
      if (!best || v > best.v) best = { v, r, c: ci };
      abs.push(Math.abs(v));
      return v;
    });
    return { pct, k: sig ? k : null, price: num(F) !== null ? F * (1 + pct / 100) : null, cells };
  });
  return { rows, cols, worst, best, m95: percentileOf(abs, 0.95) };
}

/** Roots of f over the sorted sample points xs: sign changes, linear interpolation, then bisection refinement. */
export function curveRoots(f, xs) {
  const out = [];
  let px = xs[0];
  let py = f(px);
  for (let i = 1; i < xs.length; i++) {
    const x = xs[i];
    const y = f(x);
    if (py === 0) out.push(px);
    else if (sgn(py) * sgn(y) < 0) {
      // Linear interpolation, then bisection on the bracket until it is under 0.01 point wide.
      let a = px;
      let b = x;
      let fa = py;
      let r = a - (py * (b - a)) / (y - py);
      for (let i = 0; i < 40 && b - a > 0.01; i++) {
        const fr = f(r);
        if (fr === 0) break;
        if (sgn(fr) === sgn(fa)) [a, fa] = [r, fr];
        else b = r;
        r = (a + b) / 2;
      }
      out.push(r);
    }
    px = x;
    py = y;
  }
  return out.filter((r, i, a) => i === 0 || Math.abs(r - a[i - 1]) > 0.5);
}

/** Distance of an option leg's strike from its forward in σ of its expiry, with the side, points and ITM flag. */
export function legDistance(l) {
  if (l?.kind !== "OPT" || num(l.F) === null) return null;
  const pts = l.strike - l.F;
  const s = sigmaMove(l.F, l.atmIv ?? l.iv, l.T);
  const itm = l.right === "CE" ? l.F > l.strike : l.F < l.strike;
  const sigma = s ? Math.abs(pts) / s : null;
  return { pts, pct: (pts / l.F) * 100, sigma, dir: pts >= 0 ? "up" : "down", itm, tested: l.q < 0 && (itm || (sigma !== null && sigma < 0.5)) };
}

/**
 * The structure of one expiry group, from units (not lots): long / short call or put, straddle, strangle, verticals,
 * ratio spreads, iron condor / fly, future, covered call, protective put, conversion, reversal and box. Conversion,
 * reversal and box are `locked` (a flat expiry line). Anything else: "Custom · N legs".
 */
export function detectStructure(legs) {
  const ls = (legs ?? []).filter((l) => l && num(l.q));
  const n = ls.length;
  const custom = { name: `Custom · ${formatInt(n)} leg${n === 1 ? "" : "s"}`, locked: false };
  if (!n) return { name: "No legs", locked: false };
  const futs = ls.filter((l) => l.kind === "FUT");
  const opts = ls.filter((l) => l.kind !== "FUT");
  const ce = opts.filter((l) => l.right === "CE").sort((a, b) => a.strike - b.strike);
  const pe = opts.filter((l) => l.right === "PE").sort((a, b) => a.strike - b.strike);
  const sameQty = ls.every((l) => Math.abs(l.q) === Math.abs(ls[0].q));
  const LS = (q) => (q > 0 ? "Long" : "Short");
  if (futs.length === 1 && !opts.length) return { name: `${LS(futs[0].q)} future`, locked: false };
  if (futs.length === 1 && sameQty) {
    const f = futs[0];
    if (opts.length === 1) {
      const o = opts[0];
      if (f.q > 0 && o.right === "CE" && o.q < 0) return { name: "Covered call", locked: false };
      if (f.q > 0 && o.right === "PE" && o.q > 0) return { name: "Protective put", locked: false };
      if (f.q < 0 && o.right === "PE" && o.q < 0) return { name: "Covered put", locked: false };
      if (f.q < 0 && o.right === "CE" && o.q > 0) return { name: "Protective call", locked: false };
    }
    if (ce.length === 1 && pe.length === 1 && ce[0].strike === pe[0].strike) {
      if (f.q > 0 && ce[0].q < 0 && pe[0].q > 0) return { name: "Conversion", locked: true };
      if (f.q < 0 && ce[0].q > 0 && pe[0].q < 0) return { name: "Reversal", locked: true };
    }
    return custom;
  }
  if (futs.length) return custom;
  if (n === 1) return { name: `${LS(opts[0].q)} ${opts[0].right === "CE" ? "call" : "put"}`, locked: false };
  if (n === 2) {
    const [a, b] = opts;
    if (a.right !== b.right && sgn(a.q) === sgn(b.q) && sameQty) return { name: `${LS(a.q)} ${a.strike === b.strike ? "straddle" : "strangle"}`, locked: false };
    if (a.right === b.right && sgn(a.q) !== sgn(b.q) && a.strike !== b.strike) {
      const [lo, hi] = a.right === "CE" ? ce : pe;
      if (!sameQty) return { name: `${a.right === "CE" ? "Call" : "Put"} ratio spread`, locked: false };
      if (a.right === "CE") return { name: lo.q > 0 ? "Bull call spread" : "Bear call spread", locked: false };
      return { name: hi.q > 0 ? "Bear put spread" : "Bull put spread", locked: false };
    }
    return custom;
  }
  if (n === 4 && ce.length === 2 && pe.length === 2 && sameQty) {
    const [c1, c2] = ce;
    const [p1, p2] = pe;
    // Box: bull call (long K1 CE, short K2 CE) + bear put (long K2 PE, short K1 PE), or the reverse.
    if (c1.strike === p1.strike && c2.strike === p2.strike && c1.strike < c2.strike && sgn(c1.q) === -sgn(c2.q) && sgn(p2.q) === -sgn(p1.q) && sgn(c1.q) === sgn(p2.q)) return { name: c1.q > 0 ? "Long box" : "Short box", locked: true };
    // Iron condor / fly: short inner strikes (PE below or at CE), long wings outside.
    if (p1.strike < p2.strike && c1.strike < c2.strike && p2.strike <= c1.strike && sgn(p2.q) === sgn(c1.q) && sgn(p1.q) === sgn(c2.q) && sgn(p1.q) === -sgn(p2.q)) {
      const fly = p2.strike === c1.strike;
      return { name: `${p2.q < 0 ? "" : "Reverse "}iron ${fly ? "fly" : "condor"}`.replace(/^iron/, "Iron"), locked: false };
    }
  }
  return custom;
}

/**
 * The flat expiry value of a locked group (conversion, reversal, box): P&L at expiry at three prices that must agree
 * within ₹1, else null (not locked).
 */
export function lockedValue(legs) {
  const ks = (legs ?? []).filter((l) => l.kind !== "FUT").map((l) => l.strike);
  if (!ks.length || (legs ?? []).some((l) => num(l.avg) === null)) return null;
  const lo = Math.min(...ks);
  const hi = Math.max(...ks);
  const at = (P) => legs.reduce((t, l) => t + l.q * ((l.kind === "FUT" ? P : l.right === "CE" ? Math.max(0, P - l.strike) : Math.max(0, l.strike - P)) - l.avg), 0);
  const vs = [lo * 0.8, (lo + hi) / 2, hi * 1.2].map(at);
  return Math.max(...vs) - Math.min(...vs) <= 1 ? vs[1] : null;
}

/**
 * A hedge proposal (pure). `book` = { delta, gamma, theta, vega, S }. Methods: "fut" (futures lots to the target Δ),
 * "atm" (ATM option of the chosen side; the right follows the direction), "gamma" (ATM options to flatten Γ, then
 * futures for the Δ left). `fut` = { symbol, lot, mark, expiry }; `atm` = { strike, expiry, lot, ce, pe } where ce / pe
 * = { symbol, mark, delta, gamma, theta, vega }.
 * @returns {{ method, legs: object[], change, after, residual, premium, notes: string[], error: string|null }}
 */
export function hedgePlan(book, { method = "fut", target = 0, side = "BUY", fut = null, atm = null } = {}) {
  const before = { delta: num(book?.delta) ?? 0, gamma: num(book?.gamma) ?? 0, theta: num(book?.theta) ?? 0, vega: num(book?.vega) ?? 0 };
  const S = num(book?.S);
  const change = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  const legs = [];
  const notes = [];
  let premium = 0;
  const res = (error = null) => {
    const after = Object.fromEntries(Object.keys(before).map((k) => [k, before[k] + change[k]]));
    return { method, legs, change, after, residual: after.delta - (num(target) ?? 0), premium, notes, error };
  };
  const addFut = (need) => {
    const L = num(fut?.lot);
    if (!fut?.symbol || !(L > 0)) return "No future to hedge with";
    const lots = roundHalfAway(need / L);
    if (!lots) return null;
    legs.push({ kind: "FUT", symbol: fut.symbol, expiry: fut.expiry ?? null, side: lots > 0 ? "BUY" : "SELL", lots: Math.abs(lots), units: Math.abs(lots) * L, lot: L, mark: num(fut.mark) });
    change.delta += lots * L;
    return null;
  };
  const addOpt = (right, sideSign, lots) => {
    const o = right === "CE" ? atm.ce : atm.pe;
    const u = lots * atm.lot * sideSign;
    legs.push({ kind: "OPT", symbol: o.symbol, right, strike: atm.strike, expiry: atm.expiry, side: sideSign > 0 ? "BUY" : "SELL", lots, units: lots * atm.lot, lot: atm.lot, mark: num(o.mark) });
    for (const k of Object.keys(change)) change[k] += u * (num(o[k]) ?? 0);
    premium += -u * (num(o.mark) ?? 0);
  };
  const need = (num(target) ?? 0) - before.delta;
  if (method === "fut") {
    const err = addFut(need);
    if (err) return res(err);
    notes.push("Futures add no Γ, Θ or Vega");
  } else if (method === "atm") {
    const sideSign = side === "SELL" ? -1 : 1;
    const right = (need < 0) === (sideSign > 0) ? "PE" : "CE";
    const o = right === "CE" ? atm?.ce : atm?.pe;
    const d = num(o?.delta);
    if (!o?.symbol || d === null || Math.abs(d) < 0.05 || !(num(atm?.lot) > 0)) return res("ATM delta unavailable");
    const lots = Math.max(0, roundHalfAway(need / (d * atm.lot * sideSign)));
    if (lots) addOpt(right, sideSign, lots);
  } else {
    const g = num(atm?.ce?.gamma) ?? num(atm?.pe?.gamma);
    if (S !== null && Math.abs(before.gamma) * S * 0.01 < 1) {
      notes.push("Γ already ≈ 0: futures only");
    } else if (!(g > 0) || !(num(atm?.lot) > 0)) return res("ATM gamma unavailable");
    else {
      const lots = roundHalfAway(-before.gamma / (g * atm.lot));
      if (!lots) notes.push("Γ is within one ATM lot: futures only");
      if (lots) {
        const sideSign = lots > 0 ? 1 : -1;
        // Buying: the CE also lifts Δ, the PE lowers it; selling: the reverse. Pick the one that helps Δ.
        const right = (need > 0) === (sideSign > 0) ? "CE" : "PE";
        if (!(right === "CE" ? atm.ce : atm.pe)?.symbol) return res("ATM option unavailable");
        addOpt(right, sideSign, Math.abs(lots));
      }
    }
    const err = addFut((num(target) ?? 0) - (before.delta + change.delta));
    if (err && !legs.length) return res(err);
  }
  if (!legs.length) notes.unshift(`Within one lot of target: no hedge needed (residual ${formatSigned(before.delta - (num(target) ?? 0), 0)})`);
  return res();
}

/**
 * Exit orders for a set of legs (pure): short options first (largest |Δ| first), then long options, then futures.
 * `type` "mid" (limit at mid, rounded to tick toward a fill), "touch" (bid to sell, ask to buy) or "market" (estimated
 * at the touch). `pct` < 100 exits floor(lots · p) whole lots; a leg that rounds to 0 lots is listed in `skipped`. Orders above the freeze quantity are split
 * into lot-multiple slices with the remainder last. Slippage = |price − mid| × qty. A limit order with no quote to
 * price it has `price` null and `unpriced` true (`market` is true only for type "market").
 * Legs: { symbol, kind, right, strike, expiry, q, avg, lot, freeze, tick, quote, greeks, product }.
 */
export function exitPlan(legs, { type = "mid", pct = 100 } = {}) {
  const orders = [];
  const skipped = [];
  for (const l of legs ?? []) {
    const abs = Math.abs(num(l.q) ?? 0);
    if (!abs) continue;
    const L = num(l.lot) || 1;
    let qty = abs;
    if (pct < 100) {
      // A part exit never sends more than asked: floor(lots · p) whole lots. A leg that rounds to 0 (1 lot at 50 %,
      // an odd-unit leg) cannot be split and is skipped, never exited in full.
      const n = Math.floor((Math.floor(abs / L) * pct) / 100 + 1e-9);
      if (n < 1) {
        skipped.push(l);
        continue;
      }
      qty = n * L;
    }
    const side = l.q > 0 ? "SELL" : "BUY";
    const b = num(l.quote?.bid);
    const a = num(l.quote?.ask);
    const ltp = num(l.quote?.ltp) ?? num(l.mark);
    const m = b > 0 && a > 0 ? (a + b) / 2 : ltp;
    const tick = num(l.tick) || 0.05;
    const touch = side === "BUY" ? (a > 0 ? a : ltp) : b > 0 ? b : ltp;
    const market = type === "market";
    const price = market ? null : type === "touch" ? roundToTick(touch, tick, side === "BUY" ? "buy" : "sell") : roundToTick(m, tick, side === "BUY" ? "buy" : "sell");
    // No quote to price a limit from: the order stays a limit, flagged `unpriced` (never turned into a market order).
    const unpriced = !market && num(price) === null;
    const est = market ? touch : price;
    const fz = num(l.freeze);
    const per = fz > 0 && qty > fz ? Math.max(L, Math.floor(fz / L) * L) : qty;
    const slices = [];
    for (let left = qty; left > 0; left -= per) slices.push(Math.min(per, left));
    const dAbs = Math.abs(l.q * (l.kind === "FUT" ? 1 : num(l.greeks?.delta) ?? 0));
    orders.push({
      leg: l,
      symbol: l.symbol,
      side,
      qty,
      slices,
      price: unpriced ? null : price,
      market,
      unpriced,
      mid: m,
      est,
      slip: est !== null && m !== null ? Math.abs(est - m) * qty : null,
      pnl: est !== null && num(l.avg) !== null ? (l.q > 0 ? est - l.avg : l.avg - est) * qty : null,
      rank: l.kind === "FUT" ? 2 : l.q < 0 ? 0 : 1,
      dAbs,
      product: l.product,
    });
  }
  orders.sort((x, y) => x.rank - y.rank || y.dAbs - x.dAbs);
  const total = (k) => orders.reduce((t, o) => (o[k] === null ? t : t + o[k]), 0);
  return { orders, slippage: total("slip"), pnl: total("pnl"), count: orders.reduce((t, o) => t + o.slices.length, 0), unpriced: orders.filter((o) => o.unpriced).length, skipped };
}

/** Can a part exit of `pct` % split this leg into at least one whole lot (floor(lots · p) ≥ 1)? Pure. */
export function canPartExit(leg, pct) {
  const abs = Math.abs(num(leg?.q) ?? 0);
  const L = num(leg?.lot) || 1;
  return pct >= 100 ? abs > 0 : Math.floor((Math.floor(abs / L) * pct) / 100 + 1e-9) >= 1;
}

const IST_MIN = (ms) => istClock(ms).mins + (new Date(ms + IST_OFFSET_MS).getUTCSeconds() / 60);
/** Seconds to the 15:20 IST intraday square-off while it is between 14:50 and 15:20 IST, else null. */
export function misCountdown(nowMs = Date.now()) {
  const m = IST_MIN(nowMs);
  return m >= 14 * 60 + 50 && m < 15 * 60 + 20 ? Math.round((15 * 60 + 20 - m) * 60) : null;
}

/**
 * Warnings for the book (PRD 04 §7), most severe first: [{ id, level: "bad"|"warn"|"info", text, title }].
 * `legs` are priced legs (priceBook); `stale` = { age } when prices are old.
 */
export function bookWarnings(legs, { spot = null, now = Date.now(), stale = null, band = null, rates = FALLBACK_RATES } = {}) {
  const STT_EXERCISE = num((rates ?? FALLBACK_RATES).opt?.exerciseStt) ?? FALLBACK_RATES.opt.exerciseStt;
  const out = [];
  const add = (id, level, text, title = "") => out.push({ id, level, text, title });
  const name = (l) => (l.kind === "FUT" ? `FUT ${dayMonth(l.expiry)}` : `${formatInt(l.strike)} ${l.right} ${dayMonth(l.expiry)}`);
  const inc = (legs ?? []).filter((l) => l.inc !== false && num(l.q));
  const unpriced = inc.filter((l) => !l.priced);
  if (unpriced.length) add("unpriced", "bad", `Not in Greeks: ${unpriced.slice(0, 3).map((l) => `${name(l)} (${l.why ?? "no quote"})`).join(", ")}${unpriced.length > 3 ? ` +${formatInt(unpriced.length - 3)}` : ""}`, "These legs could not be priced: the book's Greeks, payoff and scenarios leave them out");
  const S = num(spot);
  for (const l of inc) {
    if (l.kind !== "OPT" || !isExpiryDay(l.expiry, now)) continue;
    const intr = S === null ? 0 : l.right === "CE" ? Math.max(0, S - l.strike) : Math.max(0, l.strike - S);
    if (l.q > 0 && intr > 0) add("stt", "bad", `Long ${formatInt(l.strike)} ${l.right} ITM expires today: exercise STT ≈ ${formatRupee(STT_EXERCISE * intr * l.q, 0)}. Exiting may cost less`, `Rate ${formatFixed(STT_EXERCISE * 100, 2)}% of intrinsic (approx; check current rates)`);
  }
  const shortsToday = inc.filter((l) => l.kind === "OPT" && l.q < 0 && isExpiryDay(l.expiry, now));
  if (shortsToday.length && S !== null) add("elm", "warn", `Expiry day: extra ELM ≈ ${formatRupee(EXPIRY_ELM * S * shortsToday.reduce((t, l) => t + Math.abs(l.q), 0), 0)} on shorts`, "Exchanges add 2% ELM on index option shorts on their expiry day");
  const mis = misCountdown(now);
  if (mis !== null && inc.some((l) => l.product === "INTRADAY")) add("mis", "warn", `Intraday legs square off at 15:20 · ${formatInt(Math.floor(mis / 60))}:${String(mis % 60).padStart(2, "0")}`, "15:20 is the paper default; your broker may square off earlier");
  for (const l of inc) if (l.lot > 1 && Math.abs(l.q) % l.lot !== 0) add("lot", "warn", `${l.kind === "FUT" ? "FUT" : `${formatInt(l.strike)} ${l.right}`}: ${formatInt(Math.abs(l.q))} qty is not a multiple of lot ${formatInt(l.lot)}`, "Exit may need an odd-lot order or holding to expiry");
  for (const l of inc) {
    const d = l.priced ? legDistance(l) : null;
    if (!d?.tested) continue;
    add("tested", d.itm ? "bad" : "warn", d.itm ? `Short ${formatInt(l.strike)} ${l.right} is ITM` : `Short ${formatInt(l.strike)} ${l.right} tested (${formatFixed(Math.floor(d.sigma * 10) / 10, 1)}σ)`, `${formatSigned(d.pts, 0)} pts from the forward`);
  }
  const shorts = inc.filter((l) => l.kind === "OPT" && l.q < 0);
  const lastShort = shorts.map((l) => l.expiry).sort().pop();
  const shortDelta = shorts.reduce((t, l) => t + l.q * (num(l.greeks?.delta) ?? 0), 0);
  if (lastShort && shortDelta) {
    const early = inc.filter((l) => (l.kind === "FUT" || l.q > 0) && l.expiry < lastShort && sgn(l.q * (l.kind === "FUT" ? 1 : num(l.greeks?.delta) ?? 0)) === -sgn(shortDelta));
    for (const e of [...new Set(early.map((l) => l.expiry))]) add("hedge-early", "warn", `Hedge ${dayMonth(e)} expires before ${dayMonth(lastShort)} shorts`, "When it expires, the shorts it covers are left open");
  }
  if (band && num(band.delta) !== null && num(band.band) > 0 && Math.abs(band.delta) > band.band) add("band", "warn", `Δ ${formatSigned(band.delta, 0)} outside ±${formatInt(band.band)} band`, "Your delta band (Customise): the book's net Δ in units is outside it");
  const ex = (legs ?? []).filter((l) => l.inc === false && num(l.q)).length;
  if (ex) add("excluded", "info", `${formatInt(ex)} leg${ex === 1 ? "" : "s"} excluded from risk`, "Click to include every leg again");
  if (stale) add("stale", "warn", `Prices ${stale.age ?? "a while"} old`, "The last good prices are shown");
  return out;
}

/** Columns of the positions table (key, header, Customise name). */
export const POS_COLUMNS = Object.freeze([
  ["lots", "Lots", "Lots"],
  ["px", "Avg → Mark", "Avg → Mark"],
  ["pnl", "P&L", "P&L"],
  ["pnlPct", "P&L %", "P&L %"],
  ["delta", "Δ", "Delta (position)"],
  ["theta", "Θ ₹/d", "Theta ₹ a day"],
  ["vega", "Vega ₹", "Vega ₹ per vol point"],
  ["gamma", "Γ", "Gamma"],
  ["iv", "IV", "IV"],
  ["dist", "Distance", "Distance from the forward (σ)"],
]);
export const POSITIONS_DEFAULTS = Object.freeze({
  cols: Object.freeze(["lots", "px", "pnl", "pnlPct", "delta", "theta", "vega", "iv", "dist"]),
  group: "expiry",
  closed: false,
  ladder: "tight",
  axis: "iv",
  lossLimit: null,
  exitType: "mid",
  hedge: Object.freeze({ method: "fut", side: "BUY" }),
  excluded: Object.freeze({}),
  chartSlot: false,
  deltaBand: null,
  curves: "exp",
  heatCols: "auto",
  bars: true,
  gauges: true,
});
/** The positions page settings (desk prefs → pos), validated: unknown keys dropped, bad values replaced. */
export function positionsConfig(saved) {
  const d = POSITIONS_DEFAULTS;
  const s = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  const known = new Set(POS_COLUMNS.map(([k]) => k));
  const cols = Array.isArray(s.cols) ? s.cols.filter((k, i, a) => known.has(k) && a.indexOf(k) === i) : [...d.cols];
  const pick = (v, list, def) => (list.includes(v) ? v : def);
  const h = s.hedge && typeof s.hedge === "object" ? s.hedge : {};
  const excluded = {};
  if (s.excluded && typeof s.excluded === "object" && !Array.isArray(s.excluded)) {
    for (const [acc, list] of Object.entries(s.excluded)) {
      if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(acc) || !Array.isArray(list)) continue;
      const l = [...new Set(list.filter((x) => typeof x === "string" && (OPT_RE.test(x) || FUT_RE.test(x))))].slice(0, 200);
      if (l.length) excluded[acc] = l;
    }
  }
  const loss = num(s.lossLimit);
  return {
    cols: cols.length ? cols : [...d.cols],
    group: pick(s.group, ["expiry", "none"], d.group),
    closed: typeof s.closed === "boolean" ? s.closed : d.closed,
    ladder: pick(s.ladder, Object.keys(LADDERS), d.ladder),
    axis: pick(s.axis, ["iv", "days"], d.axis),
    lossLimit: loss !== null && loss > 0 ? Math.round(loss) : null,
    exitType: pick(s.exitType, ["mid", "touch", "market"], d.exitType),
    hedge: { method: pick(h.method, ["fut", "atm", "gamma"], d.hedge.method), side: pick(h.side, ["BUY", "SELL"], d.hedge.side) },
    excluded,
    chartSlot: typeof s.chartSlot === "boolean" ? s.chartSlot : d.chartSlot,
    deltaBand: num(s.deltaBand) !== null && Number(s.deltaBand) > 0 ? Math.round(Number(s.deltaBand)) : null,
    curves: pick(s.curves, ["now", "exp", "target"], d.curves),
    heatCols: s.heatCols === 3 || s.heatCols === 5 ? s.heatCols : pick(s.heatCols, ["auto"], d.heatCols),
    bars: typeof s.bars === "boolean" ? s.bars : d.bars,
    gauges: typeof s.gauges === "boolean" ? s.gauges : d.gauges,
  };
}

// ── Positions round 2 (docs/design/positions.md §7): book-level risk read-outs. Pure. ──

/**
 * Sampled statistics of a book curve (the first-expiry curve of a multi-expiry book, where later legs are valued by the
 * model, so no closed form exists): max / min and where, the roots, the profitable intervals (open-ended at the range
 * edges: [0, b] or [a, Infinity]) and whether profit or loss keeps growing past the sampled range. A side is
 * "unlimited" when the slope over the last 5 % of the samples exceeds `slopeEps` × |max − min| per sample, in the
 * direction that adds profit (`unlimitedUp`) or loss (`unlimitedDown`). Always `approx`.
 * @param {(x: number) => number} f @param {number[]} xs sorted sample prices
 */
export function bookCurveStats(f, xs, { slopeEps = 0.005 } = {}) {
  const pts = (xs ?? []).filter((x) => Number.isFinite(x));
  if (pts.length < 3) return null;
  const vals = pts.map(f);
  let iMax = 0;
  let iMin = 0;
  vals.forEach((v, i) => {
    if (v > vals[iMax]) iMax = i;
    if (v < vals[iMin]) iMin = i;
  });
  const max = vals[iMax];
  const min = vals[iMin];
  const n = pts.length;
  const k = Math.max(1, Math.round(0.05 * n));
  const eps = slopeEps * Math.abs(max - min);
  const right = (vals[n - 1] - vals[n - 1 - k]) / k;
  const left = (vals[k] - vals[0]) / k; // slope going right over the first 5 %: falling towards the left edge is -left
  const tol = eps > 0 ? eps : 1e-9;
  // Which edge each open end is on: the payoff's "Unlimited" pills and the footer name the same side.
  const upLeft = -left > tol;
  const upRight = right > tol;
  const downLeft = left > tol;
  const downRight = right < -tol;
  return {
    max,
    maxAt: pts[iMax],
    min,
    minAt: pts[iMin],
    unlimitedUp: upLeft || upRight,
    unlimitedDown: downLeft || downRight,
    upSide: upRight ? "right" : upLeft ? "left" : null,
    downSide: downLeft && !downRight ? "left" : downRight ? "right" : null,
    roots: curveRoots(f, pts),
    profitIntervals: intervalsWhere(pts, vals, (v) => v > 0),
    xs: pts,
    vals,
    approx: true,
  };
}

/**
 * Book POP at the first expiry: the log-normal mass of the profitable intervals (z = (ln(x/F) + σ²T/2)/(σ√T), σ = the
 * ATM IV, T = years to the first expiry). Null when there is no profitable interval or σ / T / F is unknown.
 */
export function bookPop(intervals, { forward, years, ivPct } = {}) {
  if (!Array.isArray(intervals) || !intervals.length) return null;
  return probIntervals(intervals, forward, years, ivPct);
}

/**
 * Stress P&L at ±kσ: for each k, dS = e^(k·σ√T) − 1 and v = scenarioPnl(legs, { dS }) at now (days 0, IV unchanged).
 * `sigmaFrac` is σ√T of the nearest expiry as a fraction (sigmaPct / 100). Returns [{ k, pct, price, v }]; [] without σ.
 */
export function stressPnl(legs, sigmaFrac, ks = [-2, -1, 1, 2], { spot = null } = {}) {
  const sf = num(sigmaFrac);
  if (!(sf > 0)) return [];
  const S = num(spot);
  return ks.map((k) => {
    const dS = Math.exp(k * sf) - 1;
    return { k, pct: dS * 100, price: S === null ? null : S * (1 + dS), v: scenarioPnl(legs, { dS }) };
  });
}

/** Where the book's P&L came from: open legs in profit (`won`), open legs in loss (`lost`) and `realised` (signed). */
export function pnlComposition(legs) {
  let won = 0;
  let lost = 0;
  let realised = 0;
  for (const l of legs ?? []) {
    const u = legUnrealised(l);
    if (u > 0) won += u;
    else lost += u;
    realised += num(l?.realised) ?? 0;
  }
  return { won, lost, realised, total: won + lost + realised };
}

/**
 * Charges to close the open legs now at their marks (one order per leg, the opposite side): a short is bought back
 * (no STT on an option buy), a long sold. { brokerage, stt, txn, sebi, ipft, stamp, gst, total }.
 */
export function closeCharges(legs, rates = FALLBACK_RATES) {
  const exit = (legs ?? [])
    .filter((l) => num(l?.q) && num(l.mark) !== null)
    .map((l) => ({ kind: l.kind, right: l.right, strike: l.strike, symbol: l.symbol, side: l.q > 0 ? "SELL" : "BUY", price: l.mark, lots: Math.abs(l.q), lotSize: 1 }));
  return charges(exit, rates, { lotSize: 1 });
}

/**
 * This book's margin, estimated per expiry group (marginEstimate on the group's legs as a strategy at lot size 1, at
 * the group's forward and time) and summed. It ignores hedge benefit across expiries, so it over-estimates. Groups
 * without a forward are skipped (`partial`). Null when nothing could be estimated.
 */
export function bookMargin(legs, { now = Date.now() } = {}) {
  const by = new Map();
  for (const l of legs ?? []) {
    if (!num(l?.q)) continue;
    if (!by.has(l.expiry)) by.set(l.expiry, []);
    by.get(l.expiry).push(l);
  }
  let total = 0;
  let any = false;
  let partial = false;
  for (const [e, ls] of by) {
    const F = num(ls.find((l) => num(l.F) !== null)?.F);
    const T = num(ls.find((l) => num(l.T) !== null)?.T);
    if (F === null || T === null) {
      partial = true;
      continue;
    }
    const strat = ls.map((l) => ({ kind: l.kind, right: l.right, strike: l.strike, side: l.q > 0 ? "BUY" : "SELL", lots: Math.abs(l.q), lotSize: 1, price: num(l.avg) ?? num(l.mark) ?? 0 }));
    const m = marginEstimate(strat, 1, { forward: F, years: T, expiryToday: isExpiryDay(e, now) });
    if (!m) {
      partial = true;
      continue;
    }
    total += m.required;
    any = true;
  }
  return any ? { required: total, partial } : null;
}

/**
 * The Greek gauges' scales (positions.md §4.2): Δ and Γ share M = max(2·band, 1.15·max(|Δ|, |Γ per 1 %|)); Θ and ν
 * share Mtv = 1.15·max(|Θ|, |ν|). `band` defaults to one futures lot (`lot`).
 */
export function greekScales({ delta = 0, gamma1 = 0, theta = 0, vega = 0, band = null, lot = null } = {}) {
  const B = num(band) > 0 ? Number(band) : num(lot) > 0 ? Number(lot) : null;
  const d = Math.abs(num(delta) ?? 0);
  const g = Math.abs(num(gamma1) ?? 0);
  const M = Math.max(B ? 2 * B : 0, 1.15 * Math.max(d, g), 1);
  const Mtv = Math.max(1.15 * Math.max(Math.abs(num(theta) ?? 0), Math.abs(num(vega) ?? 0)), 1);
  return { M, Mtv, band: B, outside: B !== null && d > B };
}

/**
 * The payoff's y-range: every series and 0, with the dominant side clamped to `ratio`× the other (so a deep loss tail
 * does not flatten the profitable hump), padded by `pad`. `clip` = { side, value, at } names what was cut, from the
 * `main` curve (the expiry curve) sampled at `xs`.
 */
export function payoffYRange(series, { main = null, xs = null, ratio = 4, pad = 0.12 } = {}) {
  const all = [0, ...(series ?? []).flat().filter((v) => typeof v === "number" && Number.isFinite(v))];
  let yMin = Math.min(...all);
  let yMax = Math.max(...all);
  let clip = null;
  const at = (want) => {
    if (!main || !xs) return null;
    let best = 0;
    main.forEach((v, i) => (want === "min" ? v < main[best] : v > main[best]) && (best = i));
    return { value: main[best], at: xs[best] };
  };
  if (yMax > 0 && yMin < 0) {
    if (-yMin > ratio * yMax) {
      const a = at("min");
      clip = { side: "low", value: a?.value ?? yMin, at: a?.at ?? null };
      yMin = -ratio * yMax;
    } else if (yMax > ratio * -yMin) {
      const a = at("max");
      clip = { side: "high", value: a?.value ?? yMax, at: a?.at ?? null };
      yMax = ratio * -yMin;
    }
  }
  const p = (yMax - yMin || Math.abs(yMax) || 1) * pad;
  return { yMin: yMin - p, yMax: yMax + p, clip };
}

// ── Volatility (the #/vol page): Black-76 on the parity forward, recomputed from mids ──

const T_FLOOR = 0.25 / 365;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];




/**
 * The forward the options price in, from put-call parity on mids: the median of K + (C − P)·e^(rT) over the 3
 * two-sided strikes nearest spot. Spot when parity cannot be read (source "spot"); { F: null } without spot either.
 * @returns {{ F: number|null, source: "parity"|"spot"|null }}
 */
export function impliedForward(chain, years, rate = FALLBACK_RATE) {
  // The arbitrage form: impliedForward(chain, { rate, days, window }) → a band of carried synthetics, never spot.
  if (years !== null && typeof years === "object") return parityForward(chain, years);
  const spot = num(chain?.underlyingLtp);
  const growth = years > 0 ? Math.exp((num(rate) ?? FALLBACK_RATE) * years) : 1;
  const two = (leg) => {
    const p = legPrice(leg, "mid");
    return p.q === "mid" || p.q === "wide" ? p.price : null;
  };
  const centre = spot ?? num(chain?.atmStrike);
  const rows = (chain?.rows ?? []).map((r) => ({ k: r.strike, c: two(r.ce), p: two(r.pe) })).filter((r) => r.c !== null && r.p !== null);
  if (rows.length && centre !== null) {
    rows.sort((a, b) => Math.abs(a.k - centre) - Math.abs(b.k - centre));
    const f = rows.slice(0, 3).map((r) => r.k + (r.c - r.p) * growth).sort((a, b) => a - b);
    return { F: f[Math.floor(f.length / 2)], source: "parity" };
  }
  return spot !== null ? { F: spot, source: "spot" } : { F: null, source: null };
}



/**
 * One point per strike with a leg: IVs recomputed with Black-76 on `F` (discounted at `rate`), from `basis` prices.
 * The maths is pricing.js smilePoints; this wrapper keeps the page defaults (the 6.5 % rate and a quarter-day floor on
 * T) until the pages move to the vol-time clock (P1-3b). otm = the PE below F, the CE at or above it; `callDelta` =
 * the CE delta at the OTM IV; `gap` = CE and PE IV bands do not overlap; `out` = why the OTM point is not drawn.
 * `Tcal` (optional) puts the discount factor on calendar time while `years` is the clock's T.
 */
export function smilePoints(chain, { F, years, rate = FALLBACK_RATE, basis = "mid", Tcal = null } = {}) {
  return pricingSmilePoints(chain, { F, years: Math.max(num(years) ?? 0, T_FLOOR), rate: num(rate) ?? FALLBACK_RATE, basis, Tcal });
}





/** The strike nearest `v` (the lower one on a tie). */
function nearestStrike(strikes, v) {
  let best = null;
  for (const k of strikes) if (best === null || Math.abs(k - v) < Math.abs(best - v) || (Math.abs(k - v) === Math.abs(best - v) && k < best)) best = k;
  return best;
}

/**
 * One expiry's volatility read (a row of the term table): forward, ATM IV, straddle and 1σ move, skew, the hedge put,
 * the future's gap to the parity forward. `fut` is the same-expiry future's quote, if listed.
 */
export function termRow(chain, { now = Date.now(), rate = FALLBACK_RATE, basis = "mid", hedgePct = 97, spot = null, monthly = false, fut = null, ctx = null, close = FALLBACK_SESSION.close } = {}) {
  const expiry = chain?.expiry ?? null;
  const tt = timeToExpiry(expiry, now, close);
  const days = tt.days;
  // With a clock context (pricing.js volTime): T on the vol-time clock, interest on calendar time, the 5-strike parity
  // forward — exactly what the server computes for ?ivModel=b76-forward. Without one: the page's legacy reading.
  const clock = ctx ? volTime(ctx, now, expiry) : null;
  const years = clock ? clock.T : days === null ? null : days / 365;
  const T = clock ? clock.T : Math.max(years ?? 0, T_FLOOR);
  const Tc = clock ? clock.Tcal : T;
  const S = num(spot) ?? num(chain?.underlyingLtp);
  const fw = clock ? pricingForward(chain, { rate, Tcal: clock.Tcal }) : impliedForward(chain, T, rate);
  const F = fw.F;
  const points = F === null ? [] : clock ? pricingSmilePoints(chain, { F, years: T, rate, Tcal: clock.Tcal, basis, settling: clock.settling }) : smilePoints(chain, { F, years: T, rate, basis });
  const atmIv = atmIvAt(points, F);
  const strikes = points.map((p) => p.strike);
  const atmStrike = F === null ? null : nearestStrike(strikes, F);
  const ap = points.find((p) => p.strike === atmStrike) ?? null;
  const straddle = ap?.ce?.price != null && ap?.pe?.price != null ? ap.ce.price + ap.pe.price : null;
  const lot = num(chain?.lotSize);
  const rupee = straddle !== null && lot ? straddle * lot : null;
  const dayFloor = Math.max(days ?? 0, 0.25);
  const move = sigmaMove(F, atmIv, T);
  const sd = atmIv !== null ? (atmIv / 100) * Math.sqrt(T) : null;
  const skew = skewMetrics(points, atmIv);
  // Hedge put: the strike nearest F·pct with a PE price, within 1.5 strike steps.
  let hedge = null;
  const step = strikeStep(strikes);
  if (F !== null && step !== null) {
    const target = (F * hedgePct) / 100;
    const k = nearestStrike(points.filter((p) => p.pe?.price != null).map((p) => p.strike), target);
    const p = k === null ? null : points.find((x) => x.strike === k);
    if (p && Math.abs(k - target) <= 1.5 * step) {
      const pctF = (p.pe.price / F) * 100;
      hedge = { pct: hedgePct, strike: k, pts: p.pe.price, pctF, annualPct: (pctF * 365) / dayFloor };
    }
  }
  // Quality: the share of strikes within ATM ±10 whose OTM side has a two-sided, tight quote.
  const ai = ap ? points.indexOf(ap) : -1;
  const near = ai < 0 ? [] : points.slice(Math.max(0, ai - 10), ai + 11);
  const quality = near.length ? near.filter((p) => p[p.strike < F ? "pe" : "ce"]?.q === "mid").length / near.length : null;
  const fb = num(fut?.bid);
  const fa = num(fut?.ask);
  const futPx = fb !== null && fa !== null && fb > 0 && fa >= fb ? (fb + fa) / 2 : num(fut?.ltp);
  const wd = DATE_RE.test(String(expiry ?? "")) ? WEEKDAYS[new Date(`${expiry}T00:00:00Z`).getUTCDay()] : "";
  return {
    expiry,
    weekday: wd,
    monthly: Boolean(monthly),
    days,
    years,
    F,
    source: fw.source,
    spot: S,
    basis: F !== null && S !== null ? F - S : null,
    // Carry is an interest quantity: on the clock path it runs on calendar time (Tcal), not on the vol-time T.
    carryPct: F !== null && S && Tc > 0 ? (Math.log(F / S) / Tc) * 100 : null,
    atmStrike,
    atmIv,
    ceIv: ap?.ce?.iv ?? null,
    peIv: ap?.pe?.iv ?? null,
    straddle,
    straddlePct: straddle !== null && F ? (straddle / F) * 100 : null,
    rupee,
    perDay: rupee !== null ? rupee / dayFloor : null,
    move,
    movePct: move !== null && F ? (move / F) * 100 : null,
    lo: sd !== null && F !== null ? F * Math.exp(-sd) : null,
    hi: sd !== null && F !== null ? F * Math.exp(sd) : null,
    beLo: straddle !== null && atmStrike !== null ? atmStrike - straddle : null,
    beHi: straddle !== null && atmStrike !== null ? atmStrike + straddle : null,
    ratio: straddle !== null && move ? straddle / move : null,
    rr25: skew.rr25,
    bf25: skew.bf25,
    rr10: skew.rr10,
    hedge,
    futGap: futPx !== null && F !== null ? futPx - F : null,
    quality,
    dim: isExpiryDay(expiry, now) || days === 0,
    points,
    skew,
    lot,
  };
}

/**
 * Forward vol between two term rows (a before b): √((σb²·Tb − σa²·Ta)/(Tb − Ta)). Total variance falling gives
 * { vol: null, inverted: true }; under half a day apart, or a missing IV, { vol: null, inverted: false }.
 */
export function forwardVol(a, b) {
  const sa = num(a?.atmIv);
  const sb = num(b?.atmIv);
  const ta = num(a?.years);
  const tb = num(b?.years);
  if (sa === null || sb === null || ta === null || tb === null || tb - ta < 0.5 / 365) return { vol: null, inverted: false };
  const v = ((sb / 100) ** 2 * tb - (sa / 100) ** 2 * ta) / (tb - ta);
  return v > 0 ? { vol: Math.sqrt(v) * 100, inverted: false } : { vol: null, inverted: true };
}

/**
 * The OTM composite IV at moneyness `m` (percent, K/F − 1): linear in m between the two bracketing points with an OTM
 * IV. Null outside the loaded range, or when the bracket spans more than 2 strike steps (missing strikes in between).
 */
export function ivAtMny(points, m) {
  const t = num(m);
  if (t === null) return null;
  const all = (points ?? []).filter((p) => num(p?.strike) !== null).sort((a, b) => a.strike - b.strike);
  const step = strikeStep(all.map((p) => p.strike));
  const pts = all.filter((p) => num(p.m) !== null && num(p.otm?.iv) !== null);
  if (!pts.length) return null;
  const exact = pts.find((p) => Math.abs(p.m - t) < 1e-9);
  if (exact) return exact.otm.iv;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (t < a.m || t > b.m) continue;
    if (step !== null && b.strike - a.strike > 2 * step + 1e-9) return null;
    return a.otm.iv + ((b.otm.iv - a.otm.iv) * (t - a.m)) / (b.m - a.m);
  }
  return null;
}

/**
 * A down-sampled OTM smile for a sparkline: `n` points evenly spaced in moneyness across ±`half` % (default: the
 * loaded range), each from ivAtMny; points without an IV are left out. Ascending in m. Fewer than 2 points → [].
 * @returns {{ m: number, iv: number }[]}
 */
export function smileSpark(points, { n = 24, half = null } = {}) {
  const pts = (points ?? []).filter((p) => num(p?.m) !== null && num(p?.otm?.iv) !== null);
  if (pts.length < 2 || !(n >= 2)) return [];
  const ms = pts.map((p) => p.m);
  const h = num(half);
  const lo = h !== null && h > 0 ? Math.max(Math.min(...ms), -h) : Math.min(...ms);
  const hi = h !== null && h > 0 ? Math.min(Math.max(...ms), h) : Math.max(...ms);
  if (!(hi > lo)) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const m = lo + ((hi - lo) * i) / (n - 1);
    const iv = ivAtMny(pts, m);
    if (iv !== null) out.push({ m, iv });
  }
  return out;
}

/** The ±2σ range at expiry: F·exp(∓2σ√T), σ = atmIv / 100, T floored at a quarter day. Null without inputs. */
export function twoSigma(forward, atmIv, years) {
  const F = num(forward);
  const s = num(atmIv);
  if (F === null || F <= 0 || s === null || !(s > 0)) return null;
  const T = Math.max(num(years) ?? 0, T_FLOOR);
  const sd = (s / 100) * Math.sqrt(T);
  return { lo: F * Math.exp(-2 * sd), hi: F * Math.exp(2 * sd) };
}

const SHAPE_LABEL = Object.freeze({ contango: "Contango · back richer", backwardation: "Inverted · front richer", flat: "Flat", humped: "Humped", insufficient: "Needs 2 expiries" });
/**
 * The term structure's shape from ATM IVs (expiry-day rows left out): contango (back ≥ 0.5 pts over front),
 * backwardation (≤ −0.5), flat, or humped (an interior row over 0.5 pts above both ends).
 * @returns {{ kind: string, slope: number|null, label: string }}
 */
export function termShape(rows) {
  const use = (rows ?? []).filter((r) => r && !r.dim && num(r.atmIv) !== null);
  if (use.length < 2) return { kind: "insufficient", slope: null, label: SHAPE_LABEL.insufficient };
  const first = use[0].atmIv;
  const last = use[use.length - 1].atmIv;
  const slope = last - first;
  const humped = use.slice(1, -1).some((r) => r.atmIv > first + 0.5 && r.atmIv > last + 0.5);
  const kind = humped ? "humped" : slope >= 0.5 ? "contango" : slope <= -0.5 ? "backwardation" : "flat";
  return { kind, slope, label: SHAPE_LABEL[kind] };
}


/**
 * Where today's realised HV(n) sits among the HV(n) of the previous `lookback` sessions: the percent of them below it.
 * Null when fewer than 120 earlier values exist. Realised, not implied.
 * @returns {{ pct: number, count: number, now: number }|null}
 */
export function hvPercentile(closes, n = 20, lookback = 252) {
  const c = (closes ?? []).map(num).filter((v) => v !== null && v > 0);
  const hv = [];
  for (let e = Math.max(n, c.length - 1 - lookback); e < c.length; e++) {
    const v = realisedVol(c.slice(e - n, e + 1), n);
    if (v !== null) hv.push(v);
  }
  if (hv.length < 2) return null;
  const now = hv[hv.length - 1];
  const past = hv.slice(0, -1);
  if (past.length < 120) return null;
  return { pct: (100 * past.filter((v) => v < now).length) / past.length, count: past.length, now };
}

/**
 * Static arbitrage at executable prices (asks to buy, bids to sell) over ATM ±`span` two-sided strikes: verticals,
 * vertical bounds, butterflies and boxes (both ways); plus calendar variance inversions from `term` rows. Edges are
 * per unit, gross of charges. The result carries `strikes`, the number of strikes checked.
 * @returns {{ kind: string, legs: { side: "BUY"|"SELL", right: "CE"|"PE", strike: number, price: number, qty?: number }[],
 *   edge: number|null, note?: string }[] & { strikes: number }}
 */
export function arbChecks(chain, { df = 1, minEdge = 0.5, span = 20, term = null } = {}) {
  const q = (leg) => {
    const b = num(leg?.bid);
    const a = num(leg?.ask);
    return b !== null && a !== null && b > 0 && a >= b ? { bid: b, ask: a } : null;
  };
  const all = [...(chain?.rows ?? [])].filter((r) => num(r.strike) !== null).sort((a, b) => a.strike - b.strike);
  const spot = num(chain?.underlyingLtp) ?? num(chain?.atmStrike);
  let ai = 0;
  if (spot !== null) all.forEach((r, i) => Math.abs(r.strike - spot) < Math.abs(all[ai].strike - spot) && (ai = i));
  const rows = all.slice(Math.max(0, ai - span), ai + span + 1).map((r) => ({ k: r.strike, c: q(r.ce), p: q(r.pe) })).filter((r) => r.c || r.p);
  const hits = [];
  const L = (side, right, strike, price, qty) => (qty ? { side, right, strike, price, qty } : { side, right, strike, price });
  const D = num(df) ?? 1;
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i];
    const b = rows[i + 1];
    const w = (b.k - a.k) * D;
    if (a.c && b.c) {
      if (b.c.bid - a.c.ask > minEdge) hits.push({ kind: "Call vertical", legs: [L("BUY", "CE", a.k, a.c.ask), L("SELL", "CE", b.k, b.c.bid)], edge: b.c.bid - a.c.ask });
      if (a.c.bid - b.c.ask - w > minEdge) hits.push({ kind: "Call vertical bound", legs: [L("SELL", "CE", a.k, a.c.bid), L("BUY", "CE", b.k, b.c.ask)], edge: a.c.bid - b.c.ask - w });
    }
    if (a.p && b.p) {
      if (a.p.bid - b.p.ask > minEdge) hits.push({ kind: "Put vertical", legs: [L("BUY", "PE", b.k, b.p.ask), L("SELL", "PE", a.k, a.p.bid)], edge: a.p.bid - b.p.ask });
      if (b.p.bid - a.p.ask - w > minEdge) hits.push({ kind: "Put vertical bound", legs: [L("SELL", "PE", b.k, b.p.bid), L("BUY", "PE", a.k, a.p.ask)], edge: b.p.bid - a.p.ask - w });
    }
    if (a.c && b.c && a.p && b.p) {
      const cost = a.c.ask - b.c.bid + b.p.ask - a.p.bid;
      if (w - cost > minEdge) hits.push({ kind: "Box (buy)", legs: [L("BUY", "CE", a.k, a.c.ask), L("SELL", "CE", b.k, b.c.bid), L("BUY", "PE", b.k, b.p.ask), L("SELL", "PE", a.k, a.p.bid)], edge: w - cost, note: "depends on rate" });
      const proceeds = a.c.bid - b.c.ask + b.p.bid - a.p.ask;
      if (proceeds - w > minEdge) hits.push({ kind: "Box (sell)", legs: [L("SELL", "CE", a.k, a.c.bid), L("BUY", "CE", b.k, b.c.ask), L("SELL", "PE", b.k, b.p.bid), L("BUY", "PE", a.k, a.p.ask)], edge: proceeds - w, note: "depends on rate" });
    }
    const c = rows[i + 2];
    if (c && Math.abs(c.k - b.k - (b.k - a.k)) < 1e-9) {
      for (const [side, right] of [["c", "CE"], ["p", "PE"]]) {
        if (!a[side] || !b[side] || !c[side]) continue;
        const e = 2 * b[side].bid - a[side].ask - c[side].ask;
        if (e > minEdge) hits.push({ kind: "Butterfly", legs: [L("BUY", right, a.k, a[side].ask), L("SELL", right, b.k, b[side].bid, 2), L("BUY", right, c.k, c[side].ask)], edge: e });
      }
    }
  }
  hits.sort((x, y) => y.edge - x.edge);
  if (Array.isArray(term)) {
    const use = term.filter((r) => r && !r.dim);
    for (let i = 1; i < use.length; i++) {
      if (forwardVol(use[i - 1], use[i]).inverted) hits.push({ kind: "Calendar variance", legs: [], edge: null, from: use[i - 1].expiry, to: use[i].expiry, note: "model-based" });
    }
  }
  hits.strikes = rows.length;
  return hits;
}

export const VOL_READ_FOOTER = "Context from current prices, not advice.";
/**
 * Plain lines per persona from the page's figures (each only when its inputs exist), then the footer as the last
 * entry ({ persona: "Note" }). Deterministic; no colour meaning.
 */
export function volRead(m = {}) {
  const f1 = (v) => formatFixed(v, 1);
  const f2 = (v) => formatFixed(v, 2);
  const has = (...v) => v.every((x) => num(x) !== null);
  const buyer = [];
  const seller = [];
  const hedger = [];
  const arb = [];
  const label = m.expiryLabel ?? "expiry";
  if (has(m.straddle, m.straddlePct, m.move, m.movePct)) buyer.push(`The ATM straddle costs ${f2(m.straddle)} (${f2(m.straddlePct)}%): that is the move needed by ${label} to break even. The 1σ move is ±${formatInt(m.move)} (${f2(m.movePct)}%).`);
  if (has(m.vrp) && m.vrp >= 2) buyer.push(`IV is ${f1(m.vrp)} pts over 20-day realised: options are priced above recent movement.`);
  else if (has(m.vrp) && m.vrp <= -1) buyer.push(`IV is ${f1(-m.vrp)} pts under 20-day realised: options are cheap relative to recent movement.`);
  if (has(m.wingPut16) && m.wingPut16 >= 3) buyer.push(`The 16Δ put is ${f1(m.wingPut16)} pts over ATM IV: OTM puts are dear; a spread offsets it.`);
  if (has(m.wingCall16) && m.wingCall16 >= 3) buyer.push(`The 16Δ call is ${f1(m.wingCall16)} pts over ATM IV: OTM calls are dear; a spread offsets it.`);
  if (has(m.days) && m.days < 1) buyer.push("Expiry day: time value decays fastest now.");

  if (has(m.lo, m.hi, m.emDown, m.emUp)) seller.push(`1σ range ${formatInt(m.lo)}–${formatInt(m.hi)}: ${formatInt(m.emDown)} PE and ${formatInt(m.emUp)} CE sit at its edges.`);
  if (has(m.vrp) && m.vrp >= 2) seller.push(`IV is ${f1(m.vrp)} pts over realised: premium is rich relative to recent movement.`);
  else if (has(m.vrp) && m.vrp <= -1) seller.push(`IV is ${f1(-m.vrp)} pts under realised: premium is thin relative to recent movement.`);
  if (m.shape === "backwardation") seller.push("Front IV is above later expiries (inverted): the market expects a near-term move.");
  if (has(m.rr25) && m.rr25 >= 2) seller.push(`Puts carry ${f1(m.rr25)} pts more IV than calls at 25Δ.`);
  else if (has(m.rr25) && m.rr25 <= -2) seller.push(`Calls carry ${f1(-m.rr25)} pts more IV than puts at 25Δ.`);

  const hg = m.hedge;
  if (hg && has(hg.strike, hg.pts, hg.pctF, hg.annualPct)) hedger.push(`${formatInt(hg.pct)}% put (${formatInt(hg.strike)} PE): ${f2(hg.pts)} pts, ${hg.pctF < 0.01 ? formatFixed(hg.pctF, 3) : f2(hg.pctF)}% of the forward, ${f1(hg.annualPct)}% a year.`);
  const ch = m.cheapestHedge;
  if (ch && has(ch.annualPct) && ch.expiry !== m.expiry) hedger.push(`Cheapest per year among loaded expiries: ${ch.label ?? ch.expiry} at ${f1(ch.annualPct)}%.`);
  if (has(m.rr25) && m.rr25 >= 0.5) hedger.push(`Downside protection carries ${f1(m.rr25)} pts of skew over calls.`);
  else if (has(m.rr25) && m.rr25 <= -0.5) hedger.push(`Puts sit ${f1(-m.rr25)} pts under calls at 25Δ: protection carries no skew premium.`);

  if (has(m.hits)) arb.push(m.hits > 0 ? `${formatInt(m.hits)} executable violation${m.hits === 1 ? "" : "s"} at bid/ask (gross).` : "No executable violations at bid/ask.");
  if (has(m.gapCount) && m.gapCount > 0) arb.push(`CE/PE IV gap outside both bid–ask bands at ${formatInt(m.gapCount)} strike${m.gapCount === 1 ? "" : "s"}: check conversions/reversals.`);
  for (const inv of m.inversions ?? []) arb.push(`Total variance falls from ${inv.from} to ${inv.to}: forward vol undefined.`);
  for (const g of m.futGaps ?? []) {
    if (!has(g.futGap, g.F) || Math.abs(g.futGap) <= 0.001 * g.F) continue;
    arb.push(`${g.label} future is ${f1(Math.abs(g.futGap))} pts ${g.futGap > 0 ? "over" : "under"} the parity forward.`);
  }
  return [
    { persona: "Buyer", lines: buyer },
    { persona: "Seller", lines: seller },
    { persona: "Hedger", lines: hedger },
    { persona: "Arbitrageur", lines: arb },
    { persona: "Note", lines: [VOL_READ_FOOTER] },
  ];
}

/** True for the last listed expiry in its calendar month (the monthly series). */
export const isMonthly = (expiry, allExpiries) => isMonthlyExpiry(expiry, allExpiries);

// ── Charges ──
// One charges model for the whole desk (PRD 02 and PRD 06): the reference table (refCharges) is the only rate table. These add
// brokerage models, per-order breakdowns and the hold-to-expiry / close-before-expiry exit for arbitrage structures.

/** Brokerage models: [id, label, help]. Broker names are deliberately not used as presets. */
export const BROKERAGE_MODELS = Object.freeze([
  ["flat", "Flat per order", "Most discount brokers charge ₹20 per order (futures: the lower of that and a % of turnover)"],
  ["perLot", "Per lot", "A fixed amount for every lot in the order"],
  ["pct", "% of turnover, capped", "A percentage of the order value, up to a cap per order"],
  ["zero", "Zero brokerage", "No brokerage (statutory charges still apply)"],
]);
/** The default brokerage profile: flat ₹20 per order, futures min(₹20, 0.03%), brokerage on exercise (conservative). */
export const DEFAULT_PROFILE = Object.freeze({ brokerage: "flat", value: 20, futPct: 0.0003, pct: 0.0003, cap: 20, exerciseBrokerage: true });

/** Statutory rate fields the user can edit: [path in the rate table, label, unit ("pct" of value or ₹ "crore")]. */
export const RATE_FIELDS = Object.freeze([
  ["opt.sttSell", "STT, options sell (on premium)", "pct"],
  ["opt.exerciseStt", "STT, exercised long ITM (on intrinsic)", "pct"],
  ["fut.sttSell", "STT, futures sell", "pct"],
  ["opt.txn.NSE", "NSE txn, options", "pct"],
  ["fut.txn.NSE", "NSE txn, futures", "pct"],
  ["opt.txn.BSE", "BSE txn, options", "pct"],
  ["fut.txn.BSE", "BSE txn, futures", "pct"],
  ["opt.stampBuy", "Stamp, options buy", "pct"],
  ["fut.stampBuy", "Stamp, futures buy", "pct"],
  ["sebiPerCrore", "SEBI fee, ₹ per crore", "crore"],
  ["ipftPerCrore", "IPFT, ₹ per crore", "crore"],
  ["gst", "GST (on brokerage, txn, SEBI)", "pct"],
]);
const pathGet = (o, path) => path.split(".").reduce((a, k) => (a === null || a === undefined ? undefined : a[k]), o);
/** The reference value of one rate path (`base` = refCharges(bundle)). */
export const rateDefault = (path, base = FALLBACK_RATES) => pathGet(base ?? FALLBACK_RATES, path);
/** The rate table with the user's overrides ({ "opt.sttSell": 0.0015, ... }) applied; unknown or bad values are ignored. */
export function ratesWith(overrides, base = FALLBACK_RATES) {
  const out = JSON.parse(JSON.stringify(base ?? FALLBACK_RATES));
  for (const [path, , unit] of RATE_FIELDS) {
    const v = num(overrides?.[path]);
    if (v === null || v < 0 || (unit === "pct" ? v >= 1 : v > 1e5)) continue;
    const keys = path.split(".");
    let o = out;
    for (const k of keys.slice(0, -1)) o = o[k];
    o[keys[keys.length - 1]] = v;
  }
  return out;
}

/** Brokerage of one executed order under a profile. */
export function brokerageFor({ kind = "OPT", turnover = 0, lots = 1 } = {}, profile = DEFAULT_PROFILE) {
  const p = profile ?? DEFAULT_PROFILE;
  const t = num(turnover) ?? 0;
  if (!(t > 0)) return 0;
  const value = num(p.value) ?? DEFAULT_PROFILE.value;
  if (p.brokerage === "zero") return 0;
  if (p.brokerage === "perLot") return value * Math.max(1, num(lots) ?? 1);
  if (p.brokerage === "pct") return Math.min((num(p.pct) ?? DEFAULT_PROFILE.pct) * t, num(p.cap) ?? DEFAULT_PROFILE.cap);
  return kind === "FUT" ? Math.min(value, (num(p.futPct) ?? DEFAULT_PROFILE.futPct) * t) : value;
}
/** NSE for NFO / NSE symbols, BSE for BFO / BSE ones. */
export const exchangeOfSymbol = (symbol) => (/^B(FO|SE):/.test(String(symbol ?? "")) ? "BSE" : "NSE");
const CHARGE_KEYS = ["brokerage", "stt", "txn", "sebi", "ipft", "stamp", "gst"];
const zeroLines = () => ({ brokerage: 0, stt: 0, txn: 0, sebi: 0, ipft: 0, stamp: 0, gst: 0, total: 0 });
const linesTotal = (o) => CHARGE_KEYS.reduce((a, k) => a + (o[k] ?? 0), 0);

/**
 * Charges of one order: { turnover, brokerage, stt, txn, sebi, ipft, stamp, gst, total } (₹). STT only on a sell, stamp
 * only on a buy; GST on brokerage + txn + SEBI + IPFT. Null without a price or units.
 * @param {{ kind: "OPT"|"FUT", side: "BUY"|"SELL", price: number, units: number, exchange?: string, lots?: number }} o
 */
export function orderCharges(o, profile = DEFAULT_PROFILE, rates = FALLBACK_RATES) {
  const price = num(o?.price);
  const units = num(o?.units);
  if (price === null || units === null || price < 0 || units <= 0) return null;
  const kind = o.kind === "FUT" ? "FUT" : "OPT";
  const turnover = price * units;
  const exch = o.exchange === "BSE" || o.exchange === "BFO" ? "BSE" : "NSE";
  const brokerage = brokerageFor({ kind, turnover, lots: num(o.lots) ?? 1 }, profile);
  const l = chargeLines(kind, o.side, turnover, exch, rates ?? FALLBACK_RATES, brokerage);
  return { turnover, ...l, total: linesTotal(l) };
}
const legIntrinsic = (l, S) => (l.right === "CE" ? Math.max(0, S - l.strike) : Math.max(0, l.strike - S));
/** Exercise STT at `settle`: Σ over long option legs of rate × intrinsic × units. Short legs pay none. */
export function exerciseStt(legs, settle, rates = FALLBACK_RATES) {
  const S = num(settle);
  if (S === null) return 0;
  let t = 0;
  for (const l of legs ?? []) if (l.kind !== "FUT" && l.side === "BUY") t += (rates ?? FALLBACK_RATES).opt.exerciseStt * legIntrinsic(l, S) * (num(l.units) ?? 0);
  return t;
}

/**
 * All-in charges of a multi-leg structure: { entry, exit, exerciseStt, exitSpread, exercised, total, hold, settle }.
 * hold "expiry": exercise STT at `settle` plus (with exerciseBrokerage) one order's brokerage per option leg exercised
 * or assigned; futures settle at FSP with no charges. hold "close": the reverse orders at the opposite touch
 * (`exitQuotes` symbol → quote, else each leg's own `quote`) plus the exit spread Σ (ask − bid) × units.
 * Legs: { kind, side, price, units, lots?, exchange?, right?, strike?, symbol?, quote? }. Null when a leg is unpriced.
 * `memo` (a Map) caches order charges by (symbol, side, price, units) across calls in one tick.
 */
export function structureCharges(legs, profile = DEFAULT_PROFILE, { hold = "expiry", settle = null, exitQuotes = null } = {}, rates = FALLBACK_RATES, memo = null) {
  const one = (o) => {
    if (!memo) return orderCharges(o, profile, rates);
    const k = `${o.symbol ?? o.kind}|${o.side}|${o.price}|${o.units}`;
    if (!memo.has(k)) memo.set(k, orderCharges(o, profile, rates));
    return memo.get(k);
  };
  const entry = zeroLines();
  for (const l of legs ?? []) {
    const c = one({ ...l, exchange: l.exchange ?? exchangeOfSymbol(l.symbol) });
    if (!c) return null;
    for (const k of CHARGE_KEYS) entry[k] += c[k];
  }
  entry.total = linesTotal(entry);
  const exit = zeroLines();
  let exStt = 0;
  let exitSpread = 0;
  let exercised = 0;
  const S = num(settle);
  if (hold === "close") {
    for (const l of legs) {
      const q = (exitQuotes instanceof Map ? exitQuotes.get(l.symbol) : exitQuotes?.[l.symbol]) ?? l.quote;
      if (!twoSided(q)) return null;
      const c = one({ ...l, side: l.side === "BUY" ? "SELL" : "BUY", price: l.side === "BUY" ? Number(q.bid) : Number(q.ask), exchange: l.exchange ?? exchangeOfSymbol(l.symbol) });
      if (!c) return null;
      for (const k of CHARGE_KEYS) exit[k] += c[k];
      exitSpread += (Number(q.ask) - Number(q.bid)) * l.units;
    }
  } else if (S !== null) {
    exStt = exerciseStt(legs, S, rates);
    for (const l of legs) {
      if (l.kind === "FUT" || !(legIntrinsic(l, S) > 0)) continue;
      exercised += 1;
      if (profile?.exerciseBrokerage === false) continue;
      // GST applies to the exercise brokerage too (its base is brokerage + txn + SEBI + IPFT).
      const b = brokerageFor({ kind: "OPT", turnover: legIntrinsic(l, S) * l.units, lots: l.lots ?? 1 }, profile);
      exit.brokerage += b;
      exit.gst += b * (num(rates?.gst) ?? FALLBACK_RATES.gst);
    }
  }
  exit.total = linesTotal(exit);
  return { entry, exit, exerciseStt: exStt, exitSpread, exercised, total: entry.total + exit.total + exStt + exitSpread, hold: hold === "close" ? "close" : "expiry", settle: S };
}

// ── Arbitrage ──
// Executable at the touch, after every charge and after the cost of money at the user's hurdle. Simple ACT/365
// annualisation throughout. A figure that needs a one-sided leg is null (shown as --), never 0.

/** e^(rate·days/365): the carry factor g. Null without a rate; 1 at or past expiry. */
export function carryFactor(rate, days) {
  const r = num(rate);
  const d = num(days);
  if (r === null) return null;
  return d === null || d <= 0 ? 1 : Math.exp((r * d) / 365);
}
/** net / capital × 365 / days (simple). Null when capital ≤ 0 or days < 1 (expiry day). */
export function annualise(net, capital, days) {
  const n = num(net);
  const c = num(capital);
  const d = num(days);
  if (n === null || c === null || d === null || c <= 0 || d < 1) return null;
  return (n / c) * (365 / d);
}
const sortedRows = (chain) => [...(chain?.rows ?? [])].filter((r) => num(r?.strike) !== null).sort((a, b) => a.strike - b.strike);
const nearestIndex = (rows, x) => {
  let best = -1;
  for (let i = 0; i < rows.length; i++) if (best < 0 || Math.abs(rows[i].strike - x) < Math.abs(rows[best].strike - x)) best = i;
  return best;
};
/** The rows within ±window strikes (by position) of the strike nearest `centre`. */
export function windowRows(chain, centre, window = 10) {
  const rows = sortedRows(chain);
  const c = num(centre);
  if (!rows.length || c === null) return [];
  const i = nearestIndex(rows, c);
  return rows.slice(Math.max(0, i - window), i + window + 1);
}

/**
 * The chain's implied forward for arbitrage: over two-sided strikes within ATM(spot) ± window, SynM = K + (mid C −
 * mid P)·e^(rT). { forward: median, lo, hi, n, atm: the strike nearest the forward }; null when n < 2 (no spot fallback).
 */
function parityForward(chain, { rate = FALLBACK_RATE, days = null, window = 5 } = {}) {
  const spot = num(chain?.underlyingLtp) ?? num(chain?.atmStrike);
  const g = carryFactor(rate, days) ?? 1;
  const syn = windowRows(chain, spot, window)
    .filter((r) => twoSided(r.ce) && twoSided(r.pe))
    .map((r) => r.strike + (mid(r.ce) - mid(r.pe)) * g);
  if (syn.length < 2) return null;
  const forward = median(syn);
  const rows = sortedRows(chain);
  return { forward, lo: Math.min(...syn), hi: Math.max(...syn), n: syn.length, atm: rows[nearestIndex(rows, forward)].strike };
}

/**
 * The rate the options price in (independent of dividends): over adjacent two-sided strike pairs within ATM ± window,
 * box mid Bm = (mid C1 − mid C2) + (mid P2 − mid P1), r = (W/Bm − 1)·365/d. The median; null when n < 2 or d < 1.
 */
export function optionsImpliedRate(chain, { days = null, window = 5 } = {}) {
  const d = num(days);
  if (d === null || d < 1) return null;
  const rows = windowRows(chain, num(chain?.underlyingLtp) ?? num(chain?.atmStrike), window);
  const rs = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i];
    const b = rows[i + 1];
    if (![a.ce, a.pe, b.ce, b.pe].every(twoSided)) continue;
    const bm = mid(a.ce) - mid(b.ce) + (mid(b.pe) - mid(a.pe));
    if (!(bm > 0)) continue;
    rs.push(((b.strike - a.strike) / bm - 1) * (365 / d));
  }
  return rs.length < 2 ? null : median(rs);
}

const optLeg = (side, right, row, price, U, lots, tick = 0.05) => ({ kind: "OPT", side, right, strike: row.strike, symbol: row[right.toLowerCase()]?.symbol ?? null, price, units: U, lots, quote: row[right.toLowerCase()] ?? null, tick, exchange: exchangeOfSymbol(row[right.toLowerCase()]?.symbol) });
const futLeg = (side, fut, price, U, lots) => ({ kind: "FUT", side, symbol: fut.symbol ?? null, price, units: U, lots, quote: fut, tick: num(fut.tickSize) || 0.05, exchange: exchangeOfSymbol(fut.symbol), expiry: fut.expiry ?? null });

/**
 * The waterfall of a structure, each line ₹ for its units (costs negative): Gross locked, − Financing at hurdle (when
 * the structure has one), − Brokerage, − STT, − Exchange txn, − SEBI fee, − Stamp, − GST, then − Exercise STT (hold to
 * expiry) or − Exit charges − Exit spread (close). `net` is the exact sum of the unrounded lines.
 * @returns {{ lines: { key: string, label: string, value: number }[], net: number }}
 */
export function waterfall(s) {
  const c = s.charges;
  const exp = c.hold !== "close";
  const lines = [{ key: "gross", label: "Gross locked", value: s.grossRs }];
  if (num(s.financingRs) !== null) lines.push({ key: "fin", label: "Financing at hurdle", value: -s.financingRs });
  lines.push(
    { key: "brokerage", label: exp && c.exit.brokerage > 0 ? "Brokerage (incl. exercise)" : "Brokerage", value: -(c.entry.brokerage + (exp ? c.exit.brokerage : 0)) },
    { key: "stt", label: "STT", value: -c.entry.stt },
    { key: "txn", label: "Exchange txn", value: -c.entry.txn },
    { key: "sebi", label: c.entry.ipft > 0 ? "SEBI fee + IPFT" : "SEBI fee", value: -(c.entry.sebi + c.entry.ipft) },
    { key: "stamp", label: "Stamp", value: -c.entry.stamp },
    { key: "gst", label: "GST", value: -(c.entry.gst + (exp ? c.exit.gst : 0)) },
  );
  if (exp) lines.push({ key: "exStt", label: "Exercise STT", value: -c.exerciseStt });
  else lines.push({ key: "exit", label: "Exit charges", value: -c.exit.total }, { key: "spread", label: "Exit spread", value: -c.exitSpread });
  const net = lines.reduce((a, l) => a + l.value, 0);
  const shown = roundToSum(lines.map((l) => l.value));
  lines.forEach((l, i) => (l.shown = shown.values[i]));
  return { lines, net, netShown: shown.total };
}

/**
 * Whole numbers for display that add up to the rounded total (largest remainder): each value is floored, then the
 * ones with the largest fractional parts get +1 until the parts sum to round(Σ values). { values, total }.
 */
export function roundToSum(values, dp = 0) {
  const f = 10 ** dp;
  const xs = (values ?? []).map((v) => (num(v) ?? 0) * f);
  const sum = xs.reduce((a, x) => a + x, 0);
  const total = Math.sign(sum) * Math.round(Math.abs(sum)); // half away from zero, as formatFixed prints the net
  const floors = xs.map((x) => Math.floor(x));
  let k = total - floors.reduce((a, x) => a + x, 0);
  const order = xs.map((x, i) => [x - floors[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const out = [...floors];
  for (let j = 0; k > 0 && j < order.length; j++, k--) out[order[j][1]] += 1;
  const fix = (x) => (x === 0 ? 0 : x / f); // never -0
  return { values: out.map(fix), total: fix(total) };
}

/**
 * Put-call parity per strike in ATM(forward) ± window, against the same-expiry future (or, without one, the chain's
 * implied forward: then conversions and reversals are null). Each row: { key, strike, ce, pe, atm, synBuy, synSell,
 * synMid, dev, devBp, tag ("callsRich"|"putsRich"|null), conv, rev, best, liq, ivDiff, oiC, oiP, oneSided }. A
 * structure: { kind, key, strike, grossPts, grossRs, financingPts, financingRs, charges, chargesTotal, net, netPts,
 * breakEvenPts, capital, capitalBasis, annual, legs, U, liq }.
 */
export function parityRows(chain, { fut = null, rate = 0.06, days = null, lots = 1, profile = DEFAULT_PROFILE, hold = "expiry", window = 10, rates = FALLBACK_RATES, futMarginPct = 0.12, fwd = undefined, memo = null } = {}) {
  const F = fwd === undefined ? parityForward(chain, { rate, days }) : fwd;
  const lot = num(chain?.lotSize) || 1;
  const N = Math.max(1, Math.floor(num(lots) ?? 1));
  const U = lot * N;
  const g = carryFactor(rate, days) ?? 1;
  const futOk = Boolean(fut) && twoSided(fut);
  const lotMismatch = Boolean(fut) && num(fut.lotSize) !== null && num(fut.lotSize) !== lot;
  // Without a future the reference is the implied forward, and its band is the spread of the near-the-money synthetics
  // (lo..hi): a synthetic only gets a rich tag when it sits outside that band, not 0.05 off a single point.
  const ref = futOk ? { kind: "fut", bid: Number(fut.bid), ask: Number(fut.ask), mid: (Number(fut.bid) + Number(fut.ask)) / 2 } : F ? { kind: "fwd", bid: Math.min(num(F.lo) ?? F.forward, F.forward), ask: Math.max(num(F.hi) ?? F.forward, F.forward), mid: F.forward } : null;
  const settle = F?.forward ?? ref?.mid ?? num(chain?.underlyingLtp);
  const centre = F?.atm ?? num(chain?.underlyingLtp) ?? num(chain?.atmStrike);
  const all = chain?.rows ?? [];
  const ranks = { ce: volumeRanks(all, "ce"), pe: volumeRanks(all, "pe") };
  const rows = windowRows(chain, centre, window).map((r) => {
    const K = r.strike;
    const two = twoSided(r.ce) && twoSided(r.pe);
    const mC = mid(r.ce);
    const mP = mid(r.pe);
    const synMid = mC !== null && mP !== null ? K + (mC - mP) * g : null;
    const synBuy = two ? K + (r.ce.ask - r.pe.bid) * g : null;
    const synSell = two ? K + (r.ce.bid - r.pe.ask) * g : null;
    const dev = synMid !== null && ref ? synMid - ref.mid : null;
    const tag = !two || !ref ? null : synSell > ref.ask ? "callsRich" : synBuy < ref.bid ? "putsRich" : null;
    const lc = liquidityScore(r.ce, ranks.ce.get(K));
    const lp = liquidityScore(r.pe, ranks.pe.get(K));
    const liq = Math.min(lc, lp);
    const make = (kind) => {
      if (!futOk || !two || lotMismatch) return null;
      const rev = kind === "rev";
      const optNet = rev ? r.ce.ask - r.pe.bid : r.ce.bid - r.pe.ask; // rev: paid; conv: received
      const grossPts = rev ? fut.bid - K - optNet : optNet - (fut.ask - K);
      const financingPts = rev ? optNet * (g - 1) : -optNet * (g - 1);
      const legs = rev
        ? [optLeg("BUY", "CE", r, Number(r.ce.ask), U, N), optLeg("SELL", "PE", r, Number(r.pe.bid), U, N), futLeg("SELL", fut, Number(fut.bid), U, N)]
        : [optLeg("SELL", "CE", r, Number(r.ce.bid), U, N), optLeg("BUY", "PE", r, Number(r.pe.ask), U, N), futLeg("BUY", fut, Number(fut.ask), U, N)];
      const charges = structureCharges(legs, profile, { hold, settle }, rates, memo);
      if (!charges) return null;
      const s = { kind, key: `p:${K}`, strike: K, grossPts, grossRs: grossPts * U, financingPts, financingRs: financingPts * U, charges, chargesTotal: charges.total, legs, U, lots: N, lot, liq };
      s.net = waterfall(s).net;
      s.netPts = s.net / U;
      s.breakEvenPts = (charges.total + s.financingRs) / U;
      const debit = rev ? optNet : -optNet;
      s.capital = Math.max(0, debit) * U + futMarginPct * ref.mid * U + charges.entry.total;
      s.capitalBasis = `${debit > 0 ? "option debit + " : ""}${formatInt(futMarginPct * 100)}% futures margin (est.) + entry charges`;
      s.annual = annualise(s.net, s.capital, days);
      return s;
    };
    const conv = make("conv");
    const rev = make("rev");
    const best = conv && rev ? (rev.net > conv.net ? rev : conv) : conv ?? rev;
    return {
      key: `p:${K}`,
      strike: K,
      ce: r.ce ?? null,
      pe: r.pe ?? null,
      atm: F ? K === F.atm : false,
      synBuy,
      synSell,
      synMid,
      dev,
      devBp: dev !== null && ref?.mid ? (dev / ref.mid) * 1e4 : null,
      tag,
      conv,
      rev,
      best,
      liq,
      ivDiff: num(r.pe?.iv) !== null && num(r.ce?.iv) !== null ? r.pe.iv - r.ce.iv : null,
      oiC: num(r.ce?.oi),
      oiP: num(r.pe?.oi),
      oneSided: !two,
      spreadC: spreadPct(r.ce),
      spreadP: spreadPct(r.pe),
    };
  });
  return { rows, fwd: F ?? null, ref, U, lot, lots: N, g, settle, lotMismatch, noFuture: !fut };
}

/**
 * Box spreads K1 < K2 inside ATM ± window, at most `maxSteps` strike steps wide, all four legs two-sided. Lend (long
 * box): debit D = (C1a − C2b) + (P2a − P1b), rate rL = ((W·U − X)/(D·U + Cin) − 1)·365/d. Borrow (short box): credit
 * Cr = (C1b − C2a) + (P2b − P1a), rate rB = ((W·U + X)/(Cr·U − Cin) − 1)·365/d. Cin = entry charges, X = expiry or
 * exit costs. Sorted by vs-hurdle bp, best first. Crossed: a price ≤ 0, a free-money borrow, or a rate over 100%/yr.
 */
export function boxes(chain, { rate = 0.06, days = null, lots = 1, profile = DEFAULT_PROFILE, hold = "expiry", window = 10, maxSteps = 10, mode = "lend", rates = FALLBACK_RATES, centre = null, settle = null, memo = null } = {}) {
  const lot = num(chain?.lotSize) || 1;
  const N = Math.max(1, Math.floor(num(lots) ?? 1));
  const U = lot * N;
  const d = num(days);
  const h = num(rate) ?? 0;
  const lend = mode !== "borrow";
  const c0 = num(centre) ?? num(chain?.underlyingLtp) ?? num(chain?.atmStrike);
  const rows = windowRows(chain, c0, window);
  const all = chain?.rows ?? [];
  const ranks = { ce: volumeRanks(all, "ce"), pe: volumeRanks(all, "pe") };
  const S = num(settle) ?? num(chain?.underlyingLtp);
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    if (!twoSided(a.ce) || !twoSided(a.pe)) continue;
    for (let j = i + 1; j < rows.length && j - i <= maxSteps; j++) {
      const b = rows[j];
      if (!twoSided(b.ce) || !twoSided(b.pe)) continue;
      const W = b.strike - a.strike;
      const price = lend ? a.ce.ask - b.ce.bid + (b.pe.ask - a.pe.bid) : a.ce.bid - b.ce.ask + (b.pe.bid - a.pe.ask);
      const legs = lend
        ? [optLeg("BUY", "CE", a, Number(a.ce.ask), U, N), optLeg("SELL", "CE", b, Number(b.ce.bid), U, N), optLeg("BUY", "PE", b, Number(b.pe.ask), U, N), optLeg("SELL", "PE", a, Number(a.pe.bid), U, N)]
        : [optLeg("SELL", "CE", a, Number(a.ce.bid), U, N), optLeg("BUY", "CE", b, Number(b.ce.ask), U, N), optLeg("SELL", "PE", b, Number(b.pe.bid), U, N), optLeg("BUY", "PE", a, Number(a.pe.ask), U, N)];
      const charges = structureCharges(legs, profile, { hold, settle: S }, rates, memo);
      if (!charges) continue;
      const cin = charges.entry.total;
      const X = charges.total - cin;
      const ann = d !== null && d >= 1;
      let r = null;
      let grossRate = null;
      let capital;
      let locked;
      if (lend) {
        capital = price * U + cin;
        locked = W * U - price * U - charges.total;
        if (ann && price > 0 && capital > 0) {
          r = ((W * U - X) / capital - 1) * (365 / d);
          grossRate = (W / price - 1) * (365 / d);
        }
      } else {
        capital = W * U;
        locked = price * U - W * U - charges.total;
        const got = price * U - cin;
        if (ann && got > 0) {
          r = ((W * U + X) / got - 1) * (365 / d);
          grossRate = price > 0 ? (W / price - 1) * (365 / d) : null;
        }
      }
      const crossed = lend ? price <= 0 || (r !== null && r > 1) : price * U - cin <= 0 || price >= W || (r !== null && (r < 0 || r > 1));
      const liq = Math.min(...[[a, "ce"], [b, "ce"], [a, "pe"], [b, "pe"]].map(([row, sd]) => liquidityScore(row[sd], ranks[sd].get(row.strike))));
      const s = {
        kind: lend ? "lbox" : "sbox",
        key: `b:${a.strike}-${b.strike}:${lend ? "lend" : "borrow"}`,
        mode: lend ? "lend" : "borrow",
        k1: a.strike,
        k2: b.strike,
        width: W,
        price,
        priceRs: price * U,
        charges,
        chargesTotal: charges.total,
        cin,
        x: X,
        grossRs: lend ? (W - price) * U : (price - W) * U,
        financingRs: null,
        locked,
        rate: r,
        grossRate,
        vsHurdleBp: r === null ? null : (lend ? r - h : h - r) * 1e4,
        capital,
        capitalBasis: lend ? "debit + entry charges" : "≈ width (short box margin)",
        liq,
        crossed,
        legs,
        U,
        lots: N,
        lot,
      };
      s.net = waterfall(s).net;
      s.netPts = s.net / U;
      s.breakEvenPts = charges.total / U;
      s.hurdle = h;
      s.days = ann ? d : null;
      s.annual = s.rate;
      out.push(s);
    }
  }
  return out.sort((x, y) => (y.vsHurdleBp ?? -Infinity) - (x.vsHurdleBp ?? -Infinity));
}

/**
 * The box price per unit that gives `target` (%/yr as a decimal) after charges: lend Dmax = ((W·U − X)/(1 + t·d/365)
 * − Cin)/U rounded down to tick; borrow Crmin = ((W·U + X)/(1 + t·d/365) + Cin)/U rounded up. Cin and X are taken at
 * the current quotes (an approximation). Null on expiry day or without inputs.
 */
export function boxLimit({ mode = "lend", width, units, cin = 0, x = 0, target, days, tick = 0.05 } = {}) {
  const W = num(width);
  const U = num(units);
  const t = num(target);
  const d = num(days);
  if (W === null || U === null || U <= 0 || t === null || d === null || d < 1) return null;
  const f = 1 + (t * d) / 365;
  if (!(f > 0)) return null;
  const raw = mode === "borrow" ? ((W * U + (num(x) ?? 0)) / f + (num(cin) ?? 0)) / U : ((W * U - (num(x) ?? 0)) / f - (num(cin) ?? 0)) / U;
  return { raw, limit: roundToTick(raw, tick, mode === "borrow" ? "buy" : "sell") };
}

const futMid = (q) => (twoSided(q) ? (Number(q.bid) + Number(q.ask)) / 2 : null);
/**
 * Long or short exposure: the future at its touch, or the synthetic at the ATM-forward strike (K + (Ca − Pb)·g to buy,
 * K + (Cb − Pa)·g to sell), each per unit after entry charges (and exercise STT at `settle` on the synthetic's long
 * option). { long: { pick, diffPts, diffPerLot, fut, syn }, short: {...} }; null without two-sided quotes.
 */
export function cheaperExposure({ fut, row, rate = 0.06, days = null, profile = DEFAULT_PROFILE, lot = 1, rates = FALLBACK_RATES, settle = null } = {}) {
  if (!fut || !row || !twoSided(fut) || !twoSided(row.ce) || !twoSided(row.pe)) return null;
  const u = num(lot) || 1;
  const g = carryFactor(rate, days) ?? 1;
  const K = row.strike;
  const ex = exchangeOfSymbol(fut.symbol);
  const per = (legs) => legs.reduce((a, l) => a + (orderCharges({ ...l, units: u, exchange: ex }, profile, rates)?.total ?? 0), 0) / u;
  const S = num(settle) ?? futMid(fut);
  const longFut = Number(fut.ask) + per([{ kind: "FUT", side: "BUY", price: Number(fut.ask) }]);
  const longSyn = K + (row.ce.ask - row.pe.bid) * g + per([{ kind: "OPT", side: "BUY", price: Number(row.ce.ask) }, { kind: "OPT", side: "SELL", price: Number(row.pe.bid) }]) + exerciseStt([{ kind: "OPT", side: "BUY", right: "CE", strike: K, units: u }], S, rates) / u;
  const shortFut = Number(fut.bid) - per([{ kind: "FUT", side: "SELL", price: Number(fut.bid) }]);
  const shortSyn = K + (row.ce.bid - row.pe.ask) * g - per([{ kind: "OPT", side: "SELL", price: Number(row.ce.bid) }, { kind: "OPT", side: "BUY", price: Number(row.pe.ask) }]) - exerciseStt([{ kind: "OPT", side: "BUY", right: "PE", strike: K, units: u }], S, rates) / u;
  const side = (a, b, lower) => {
    const pick = lower ? (a <= b ? "future" : "synthetic") : a >= b ? "future" : "synthetic";
    const diffPts = Math.abs(a - b);
    return { pick, diffPts, diffPerLot: diffPts * u, fut: a, syn: b };
  };
  return { long: side(longFut, longSyn, true), short: side(shortFut, shortSyn, false), strike: K };
}

/**
 * The futures term: one row per future, nearest first ({ key, expiry, symbol, days, bid, ask, mid, spread, basis,
 * basisPct, carry, carryVsBp, fwd, fwdGap, fwdTag, cheaper }), and a calendar between each consecutive pair ({ key,
 * from, to, buyFar, sellFar, fwdRate, fair, midSpread, vsFair, tag, rollLong, rollShort }). `chains` (expiry →
 * optionchain data) adds the options forward and future-vs-synthetic. Rates are decimals.
 */
export function futuresTerm(spot, futs, { now = Date.now(), rate = 0.06, profile = DEFAULT_PROFILE, rates = FALLBACK_RATES, chains = new Map() } = {}) {
  const S = num(spot);
  const h = num(rate) ?? 0;
  const list = [...(futs ?? [])].filter((f) => f && /^\d{4}-\d{2}-\d{2}$/.test(f.expiry ?? "")).sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
  const futures = list.map((f) => {
    const days = timeToExpiry(f.expiry, now).days;
    const m = futMid(f);
    const lot = num(f.lotSize) || 1;
    const basis = m !== null && S !== null ? m - S : null;
    const carry = m !== null && S && days !== null && days >= 1 ? (m / S - 1) * (365 / days) : null;
    const ch = chains.get(f.expiry) ?? null;
    let fwd = null;
    let fwdTag = null;
    let cheaper = null;
    if (ch) {
      const pf = parityForward(ch, { rate: h, days });
      if (pf) {
        const g = carryFactor(h, days) ?? 1;
        const row = (ch.rows ?? []).find((r) => r.strike === pf.atm) ?? null;
        const two = row && twoSided(row.ce) && twoSided(row.pe);
        fwd = { ...pf, synBuy: two ? row.strike + (row.ce.ask - row.pe.bid) * g : null, synSell: two ? row.strike + (row.ce.bid - row.pe.ask) * g : null };
        if (twoSided(f) && fwd.synSell !== null) fwdTag = Number(f.bid) > fwd.synSell ? "rich" : Number(f.ask) < fwd.synBuy ? "cheap" : null;
        cheaper = cheaperExposure({ fut: f, row, rate: h, days, profile, lot, rates, settle: pf.forward });
      }
    }
    return {
      key: `f:${f.expiry}`,
      expiry: f.expiry,
      symbol: f.symbol ?? null,
      lot,
      days,
      bid: num(f.bid),
      ask: num(f.ask),
      mid: m,
      spread: m !== null ? Number(f.ask) - Number(f.bid) : null,
      twoSided: twoSided(f),
      basis,
      basisPct: basis !== null && S ? (basis / S) * 100 : null,
      carry,
      carryVsBp: carry !== null ? (carry - h) * 1e4 : null,
      fwd,
      fwdGap: fwd && m !== null ? m - fwd.forward : null,
      fwdTag,
      cheaper,
    };
  });
  const calendars = [];
  for (let i = 0; i + 1 < futures.length; i++) {
    const a = futures[i];
    const b = futures[i + 1];
    const ok = a.twoSided && b.twoSided;
    const dd = a.days !== null && b.days !== null ? b.days - a.days : null;
    // NSE revises lot sizes series by series: when the two lots differ there is no one-for-one roll.
    const lotMismatch = a.lot !== b.lot;
    const u = a.lot;
    const ex = exchangeOfSymbol(a.symbol);
    const ch = (legs) => legs.reduce((t, l) => t + (orderCharges({ kind: "FUT", units: u, exchange: ex, ...l }, profile, rates)?.total ?? 0), 0);
    const fair = ok && dd !== null && dd > 0 ? a.mid * (Math.exp((h * dd) / 365) - 1) : null;
    const midSpread = ok ? b.mid - a.mid : null;
    const vsFair = fair !== null ? midSpread - fair : null;
    calendars.push({
      key: `c:${a.expiry}>${b.expiry}`,
      from: a.expiry,
      to: b.expiry,
      lot: u,
      lotMismatch,
      buyFar: ok && !lotMismatch ? b.ask - a.bid : null,
      sellFar: ok && !lotMismatch ? b.bid - a.ask : null,
      fwdRate: ok && dd !== null && dd > 0 ? (b.mid / a.mid - 1) * (365 / dd) : null,
      fair,
      midSpread,
      vsFair,
      tag: vsFair === null ? null : vsFair > 0 ? "rich" : vsFair < 0 ? "cheap" : null,
      rollLong: ok && !lotMismatch ? (b.ask - a.bid) * u + ch([{ side: "SELL", price: a.bid }, { side: "BUY", price: b.ask }]) : null,
      rollShort: ok && !lotMismatch ? (a.ask - b.bid) * u + ch([{ side: "BUY", price: a.ask }, { side: "SELL", price: b.bid }]) : null,
    });
  }
  return { futures, calendars };
}

/**
 * Quote staleness: { stale, ageMs, skewMs }. Stale when the chain or the future is older than maxAgeMs, or their
 * timestamps are further apart than that (a phantom edge from mismatched quotes).
 */
export function staleness({ chainAsOf = null, futAsOf = null, now = Date.now(), maxAgeMs = 5000 } = {}) {
  const tc = chainAsOf ? Date.parse(chainAsOf) : Number.NaN;
  const tf = futAsOf ? Date.parse(futAsOf) : Number.NaN;
  if (!Number.isFinite(tc)) return { stale: false, ageMs: null, skewMs: null };
  const ageMs = Math.max(0, now - tc, Number.isFinite(tf) ? now - tf : 0);
  const skewMs = Number.isFinite(tf) ? Math.abs(tc - tf) : null;
  return { stale: ageMs > maxAgeMs || (skewMs !== null && skewMs > maxAgeMs), ageMs, skewMs };
}

/** Minutes past midnight IST. */
const istMinutes = (ms) => Math.floor((((ms + IST_OFFSET_MS) % 86400000) + 86400000) % 86400000 / 60000);
/** Flag codes, in priority order (most important first). */
export const ARB_FLAGS = Object.freeze(["LOT_MISMATCH", "CROSSED", "ORDER_LIMIT", "STALE", "EXPIRY_DAY", "MARKET_CLOSED", "NEAR_CLOSE", "WIDE", "THIN", "ONE_SIDED", "NO_FUTURE", "FREEZE", "EXERCISE_STT"]);
/**
 * The risk flags that apply to one structure: [{ code, sev: "bad"|"warn"|"info", text }], most important first.
 * ctx: { stale, ageMs, days, hold, noFuture, lotMismatch, oneSided, topQty: Map symbol → qty, freezeQty: Map symbol
 * → qty, orderLimit (₹ per order), nowMs, demo }.
 */
export function arbFlags(s, ctx = {}) {
  const out = [];
  const add = (code, sev, text) => out.push({ code, sev, text });
  const legs = s?.legs ?? [];
  if (ctx.lotMismatch) add("LOT_MISMATCH", "bad", "The future's lot size differs from the options': conversions and reversals are off");
  if (s?.crossed) add("CROSSED", "bad", "Crossed quotes: almost certainly a stale or bad quote");
  const limit = num(ctx.orderLimit);
  if (limit !== null && legs.some((l) => (num(l.price) ?? 0) * (num(l.units) ?? 0) > limit)) add("ORDER_LIMIT", "bad", `A leg is above the per-order limit of ${formatRupee(limit, 0)}`);
  if (ctx.stale) add("STALE", "warn", `Quotes are stale${num(ctx.ageMs) !== null ? ` (${formatInt(ctx.ageMs / 1000)} s)` : ""}: excluded from Best`);
  if (num(ctx.days) !== null && ctx.days < 1) add("EXPIRY_DAY", "warn", "Expiry day: +2% ELM on short options, no annualised figures");
  if (!ctx.demo && num(ctx.nowMs) !== null) {
    // The reference session (ctx.session = refSession(bundle)): pre-open, then the continuous session to the close.
    const ses = ctx.session ?? FALLBACK_SESSION;
    const m = istMinutes(ctx.nowMs);
    const pre = hmOf(ses.preOpen, "preOpen");
    const open = hmOf(ses.open, "open");
    const close = hmOf(ses.close, "close");
    if (ses.holiday || m < pre || m >= close) add("MARKET_CLOSED", "warn", `Market closed${ses.holiday?.label ? ` (${ses.holiday.label})` : ""}: quotes are frozen at the last trade, nothing is executable now`);
    else if (m < open) add("NEAR_CLOSE", "warn", `Pre-open: quotes thin until ${ses.open ?? FALLBACK_SESSION.open}`);
    else if (m >= close - 30) add("NEAR_CLOSE", "warn", "Last 30 min: quotes thin");
  }
  const wide = legs.filter((l) => l.kind !== "FUT" && (spreadPct(l.quote) ?? 0) > 5);
  if (wide.length) add("WIDE", "warn", `Wide spread on ${wide.map((l) => `${formatInt(l.strike)} ${l.right}`).join(", ")} (over 5%)`);
  const tq = ctx.topQty instanceof Map ? ctx.topQty : null;
  if (tq && legs.some((l) => num(tq.get(l.symbol)) !== null && tq.get(l.symbol) < (num(s.lot) ?? 1))) add("THIN", "warn", "Less than one lot at the touch on a leg");
  if (ctx.oneSided || (s && legs.some((l) => !twoSided(l.quote)))) add("ONE_SIDED", "info", "A leg has no two-sided quote: figures show --");
  if (ctx.noFuture) add("NO_FUTURE", "info", "No listed future for this expiry");
  const fq = ctx.freezeQty instanceof Map ? ctx.freezeQty : null;
  const slices = fq ? Math.max(1, ...legs.map((l) => (num(fq.get(l.symbol)) > 0 ? Math.ceil(l.units / fq.get(l.symbol)) : 1))) : 1;
  if (slices > 1) add("FREEZE", "info", `Above the freeze quantity: sent as ${formatInt(slices)} orders`);
  if (s?.charges && s.charges.hold !== "close" && s.charges.exerciseStt >= 0.5) add("EXERCISE_STT", "info", `Exercise STT ${formatRupee(s.charges.exerciseStt, 0)} on the long ITM leg at expiry`);
  return out;
}

/**
 * The order to send a structure's legs in: the least liquid option leg first (widest spread %), then the other option
 * legs by spread % descending, then the future last.
 */
export function sendOrder(legs) {
  const opts = (legs ?? []).filter((l) => l.kind !== "FUT").map((l) => ({ l, sp: spreadPct(l.quote) ?? Infinity }));
  opts.sort((a, b) => b.sp - a.sp);
  return [...opts.map((x) => x.l), ...(legs ?? []).filter((l) => l.kind === "FUT")];
}
/** Split `units` into freeze-quantity slices of whole lots: [75, 75] style; one slice when freeze is unknown. */
export function freezeSlices(units, freezeQty, lot = 1) {
  const u = Math.floor(num(units) ?? 0);
  const fq = num(freezeQty);
  if (u <= 0) return [];
  if (fq === null || fq <= 0 || u <= fq) return [u];
  const step = Math.max(lot, Math.floor(fq / lot) * lot);
  const out = [];
  let left = u;
  while (left > 0) {
    out.push(Math.min(step, left));
    left -= step;
  }
  return out;
}
/** floor(min over legs of the top-of-book quantity / lot): lots available at these prices; null without depth. */
export function maxLotsAtTouch(legs, topQty, lot = 1) {
  const qs = (legs ?? []).map((l) => num(topQty?.get?.(l.symbol)));
  if (!qs.length || qs.some((q) => q === null)) return null;
  return Math.floor(Math.min(...qs) / (num(lot) || 1));
}

/** Parity table columns: [id, header]. Strike and the net columns (conv, rev, annual) cannot be hidden. */
export const ARB_PARITY_COLUMNS = Object.freeze([
  ["strike", "Strike"],
  ["call", "Call bid·ask"],
  ["put", "Put bid·ask"],
  ["syn", "Synthetic sell·buy"],
  ["dev", "Dev"],
  ["edge", "Edge"],
  ["conv", "Conversion"],
  ["rev", "Reversal"],
  ["annual", "Net %/yr"],
  ["liq", "Liq"],
  ["fwdK", "Implied fwd at K"],
  ["ivpc", "IV P−C"],
  ["oi", "OI C·P"],
  ["gross", "Gross pts"],
  ["charges", "Charges ₹"],
  ["capital", "Capital ₹"],
]);
export const ARB_LOCKED_COLUMNS = Object.freeze(["strike", "conv", "rev", "annual"]);
export const ARB_DEFAULTS = Object.freeze({
  tab: "parity",
  lots: 1,
  hold: "expiry",
  onlyOpps: false,
  boxMode: "lend",
  sort: Object.freeze({ parity: Object.freeze({ key: "strike", dir: "asc" }), boxes: Object.freeze({ key: "vsHurdle", dir: "desc" }), futures: Object.freeze({ key: "expiry", dir: "asc" }) }),
  hurdle: 6,
  profile: DEFAULT_PROFILE,
  rates: Object.freeze({}),
  futMarginPct: 12,
  minNet: 0,
  minBoxBp: 0,
  minLiq: 2,
  staleSec: 5,
  window: 10,
  boxMaxSteps: 10,
  cols: Object.freeze(ARB_PARITY_COLUMNS.slice(0, 10).map((c) => c[0])),
  notesOpen: null,
  boxView: "list",
});
const SORT_KEYS = { parity: ["strike", "dev", "edge", "conv", "rev", "annual"], boxes: ["vsHurdle", "rate", "locked", "strikes"], futures: ["expiry"] };
/** The Arbitrage page's saved settings (mcb.dashboard.desk → arb), validated: bad values fall back to defaults. */
export function arbConfig(saved) {
  const d = ARB_DEFAULTS;
  const s = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  const pick = (v, list, def) => (list.includes(v) ? v : def);
  const range = (v, lo, hi, def) => (num(v) !== null && Number(v) >= lo && Number(v) <= hi ? Number(v) : def);
  const p = s.profile && typeof s.profile === "object" ? s.profile : {};
  const sort = {};
  for (const tab of Object.keys(SORT_KEYS)) {
    const x = s.sort?.[tab];
    sort[tab] = x && SORT_KEYS[tab].includes(x.key) && ["asc", "desc"].includes(x.dir) ? { key: x.key, dir: x.dir } : { ...d.sort[tab] };
  }
  const ids = ARB_PARITY_COLUMNS.map((c) => c[0]);
  let cols = Array.isArray(s.cols) ? s.cols.filter((k, i, a) => ids.includes(k) && a.indexOf(k) === i) : [...d.cols];
  // Saved before the Edge column existed (round 2): show it once, after Dev (the user can hide it again).
  if (Array.isArray(s.cols) && s.colsV !== 2 && !cols.includes("edge")) cols.splice(cols.includes("dev") ? cols.indexOf("dev") + 1 : 1, 0, "edge");
  for (const k of ARB_LOCKED_COLUMNS) if (!cols.includes(k)) cols.push(k);
  if (cols[0] !== "strike") cols = ["strike", ...cols.filter((k) => k !== "strike")];
  const rates = {};
  for (const [path, , unit] of RATE_FIELDS) {
    const v = num(s.rates?.[path]);
    if (v !== null && v >= 0 && (unit === "pct" ? v < 1 : v <= 1e5)) rates[path] = v;
  }
  return {
    tab: pick(s.tab, ["parity", "boxes", "futures"], d.tab),
    lots: Math.round(range(s.lots, 1, 100, d.lots)),
    hold: pick(s.hold, ["expiry", "close"], d.hold),
    onlyOpps: typeof s.onlyOpps === "boolean" ? s.onlyOpps : d.onlyOpps,
    boxMode: pick(s.boxMode, ["lend", "borrow"], d.boxMode),
    sort,
    hurdle: range(s.hurdle, 0, 50, d.hurdle),
    profile: {
      brokerage: pick(p.brokerage, BROKERAGE_MODELS.map((m) => m[0]), DEFAULT_PROFILE.brokerage),
      value: range(p.value, 0, 10000, DEFAULT_PROFILE.value),
      futPct: range(p.futPct, 0, 0.05, DEFAULT_PROFILE.futPct),
      pct: range(p.pct, 0, 0.05, DEFAULT_PROFILE.pct),
      cap: range(p.cap, 0, 10000, DEFAULT_PROFILE.cap),
      exerciseBrokerage: typeof p.exerciseBrokerage === "boolean" ? p.exerciseBrokerage : DEFAULT_PROFILE.exerciseBrokerage,
    },
    rates,
    futMarginPct: range(s.futMarginPct, 0, 100, d.futMarginPct),
    minNet: range(s.minNet, -1e7, 1e7, d.minNet),
    minBoxBp: range(s.minBoxBp, -10000, 10000, d.minBoxBp),
    minLiq: Math.round(range(s.minLiq, 0, 5, d.minLiq)),
    staleSec: pick(Number(s.staleSec), [2, 5, 10, 30], d.staleSec),
    window: pick(Number(s.window), [5, 10, 20], d.window),
    boxMaxSteps: Math.round(range(s.boxMaxSteps, 1, 40, d.boxMaxSteps)),
    cols,
    colsV: 2,
    notesOpen: typeof s.notesOpen === "boolean" ? s.notesOpen : null,
    boxView: pick(s.boxView, ["list", "matrix"], d.boxView),
  };
}

// ── Arbitrage display helpers (docs/design/arb.md §10; pure, tested) ──

/**
 * How much of the total cost the gross edge pays for, in points per unit. gross = grossPts (parity), width − price
 * (lend box) or price − width/(1 + h·d/365) (borrow box, against the fair credit at the hurdle); cost = breakEvenPts,
 * plus price·h·d/365 for a lend box (the hurdle on the money lent). h = s.hurdle, d = s.days (missing → 0). cover = gross / cost (null when cost ≤ 0); short =
 * max(0, cost − gross), the points still missing. Missing inputs give all null.
 */
export function coverRatio(s) {
  const none = { cover: null, gross: null, cost: null, short: null };
  if (!s || typeof s !== "object") return none;
  // Boxes carry the cost of money at the hurdle, as parity carries its financing: a lend box pays for the debit's
  // hurdle interest (cost += price·h·d/365); a borrow box is measured against the fair credit W/(1 + h·d/365).
  const g = num(s.hurdle) !== null && num(s.days) !== null && num(s.days) > 0 ? (Number(s.hurdle) * Number(s.days)) / 365 : 0;
  const gross = s.kind === "lbox" ? diffOf(s.width, s.price) : s.kind === "sbox" ? (num(s.width) === null ? null : diffOf(s.price, Number(s.width) / (1 + g))) : num(s.grossPts);
  const be = num(s.breakEvenPts);
  const cost = be === null ? null : s.kind === "lbox" && num(s.price) !== null ? be + Math.max(0, Number(s.price)) * g : be;
  if (gross === null || cost === null) return none;
  return { cover: cost > 0 ? gross / cost : null, gross, cost, short: Math.max(0, cost - gross) };
}
const diffOf = (a, b) => (num(a) === null || num(b) === null ? null : Number(a) - Number(b));

/**
 * Diverging step −3..3 for a rate gap in basis points on fixed trader thresholds (not a percentile, so a colour means
 * the same thing every day): |bp| < 10 → 0, < 50 → ±1, < 150 → ±2, else ±3. Non-finite → null.
 */
export function bpStep(bp) {
  if (typeof bp !== "number" || !Number.isFinite(bp)) return null;
  const a = Math.abs(bp);
  if (a < 10) return 0;
  return Math.sign(bp) * (a < 50 ? 1 : a < 150 ? 2 : 3);
}

/**
 * The parity heat strip: per row { side: "call" | "put" | null, step: 0..5, m }. dev > 0 (synthetic above the
 * reference) is calls rich, dev < 0 puts rich; step = seqStep(|devBp|, 0, m) with m = max(5 bp, p95 |devBp|), so one
 * outlier does not wash the rest out. |devBp| < 1 (or missing) is neutral: side null, step 0.
 */
export function devHeat(rows) {
  const list = rows ?? [];
  const abs = list.map((r) => num(r?.devBp)).filter((v) => v !== null).map(Math.abs);
  const m = Math.max(5, percentileOf(abs, 0.95) ?? 0);
  return list.map((r) => {
    const bp = num(r?.devBp);
    const dev = num(r?.dev) ?? bp;
    if (bp === null || Math.abs(bp) < 1 || dev === null || dev === 0) return { side: null, step: 0, m };
    return { side: dev > 0 ? "call" : "put", step: seqStep(Math.abs(bp), 0, m), m };
  });
}

/** The annual of a parity row's better side (r.best; else the larger of conv and rev), any sign: { k: "conv" | "rev", v } or null. */
export function bestAnnualSigned(r) {
  // The row's better side (r.best, by net ₹) when it has an annual, so the return matches the coloured money cell.
  const b = r?.best;
  if (b && (b.kind === "conv" || b.kind === "rev") && num(b.annual) !== null) return { k: b.kind, v: num(b.annual) };
  const opts = [["conv", num(r?.conv?.annual)], ["rev", num(r?.rev?.annual)]].filter(([, v]) => v !== null);
  if (!opts.length) return null;
  const [k, v] = opts.sort((a, b) => b[1] - a[1])[0];
  return { k, v };
}

/**
 * A cost waterfall as floating steps: the first line runs from 0 to its value (gross), each next one from the running
 * total before it to the total after it. { steps: [{ key, from, to }], net, min, max } where [min, max] spans 0 and
 * every step, so the drawing needs no maths. Missing values count as 0.
 */
export function waterfallSteps(lines) {
  const steps = [];
  let run = 0;
  let min = 0;
  let max = 0;
  for (const l of lines ?? []) {
    const v = num(l?.value) ?? 0;
    const from = run;
    run += v;
    steps.push({ key: l?.key ?? String(steps.length), from, to: run });
    min = Math.min(min, from, run);
    max = Math.max(max, from, run);
  }
  return { steps, net: run, min, max };
}

// ── Option Screener (PRD 07): per-leg metrics, scores, costs, skew and hedges over many chains ──

/**
 * Contracts whose volume ÷ OI stands out from the rest of the chain: at least `minRatio`× the side's median (the
 * upper median, as the chain has always used), the `top` highest per side. Fewer than 5 live legs on a side: none.
 * @returns {Set<string>} symbols
 */
export function unusualVolume(rows, { minRatio = 3, top = 4 } = {}) {
  const out = new Set();
  for (const side of ["ce", "pe"]) {
    const legs = (rows ?? []).map((r) => r[side]).filter((q) => num(q?.volume) > 0 && num(q?.oi) > 0).map((q) => ({ symbol: q.symbol, r: q.volume / q.oi }));
    if (legs.length < 5) continue;
    const sorted = legs.map((l) => l.r).sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    legs.sort((a, b) => b.r - a.r).slice(0, top).filter((l) => l.r >= minRatio * med).forEach((l) => out.add(l.symbol));
  }
  return out;
}

/** The median of the figures in `values` (nulls and non-numbers ignored); null when none. */
export function median(values) {
  const v = (values ?? []).map(num).filter((x) => x !== null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * strike → (volume ÷ OI) ÷ the median volume ÷ OI of the same side, over legs with volume > 0 and OI ≥ `minOi`
 * (at least 1). A leg below `minOi` (a lot or two on a far wing) gets no ratio: Vol/OI on a sliver of OI is noise.
 * Fewer than 5 such legs: an empty map (a median of three strikes says nothing).
 */
/** Legs with less OI than this many lots get no Vol/OI-to-median ratio in the screener. */
export const VOL_OI_MIN_LOTS = 5;
export function volOiRelative(rows, side, minOi = 0) {
  const floor = Math.max(1e-9, num(minOi) ?? 0);
  const legs = (rows ?? []).map((r) => ({ k: r.strike, q: r[side] })).filter((x) => num(x.q?.volume) > 0 && num(x.q?.oi) >= floor).map((x) => ({ k: x.k, r: x.q.volume / x.q.oi }));
  const out = new Map();
  if (legs.length < 5) return out;
  const med = median(legs.map((l) => l.r));
  if (!(med > 0)) return out;
  for (const l of legs) out.set(l.k, l.r / med);
  return out;
}

/** Median IV of the `n` nearest strikes below and `n` above `strike` on one side (iv > 0; the strike itself left out). */
const LIVE_IV = new WeakMap(); // rows → { ce, pe }: legs with an IV, by strike (one sort per chain, not per leg)
export function neighbourIv(rows, side, strike, n = 2) {
  if (!rows) return null;
  let memo = LIVE_IV.get(rows);
  if (!memo) LIVE_IV.set(rows, (memo = {}));
  const live = (memo[side] ??= rows.filter((r) => num(r?.strike) !== null && num(r[side]?.iv) > 0).map((r) => ({ k: r.strike, iv: Number(r[side].iv) })).sort((a, b) => a.k - b.k));
  let i = 0;
  while (i < live.length && live[i].k < strike) i += 1;
  const below = live.slice(Math.max(0, i - n), i);
  const above = live.slice(i < live.length && live[i].k === strike ? i + 1 : i).slice(0, n);
  return median([...below, ...above].map((x) => x.iv));
}

/**
 * 25-delta risk reversal from the chain's own deltas: IV of the put nearest Δ −0.25 minus IV of the call nearest
 * Δ +0.25 (each within ±0.08). Positive = puts richer. Null when either wing is missing.
 */
export function skew25(rows) {
  const pick = (side) => {
    let best = null;
    for (const r of rows ?? []) {
      const d = num(r[side]?.delta);
      const iv = num(r[side]?.iv);
      if (d === null || !(iv > 0)) continue;
      const gap = Math.abs(Math.abs(d) - 0.25);
      if (gap <= 0.08 && (best === null || gap < best.gap)) best = { strike: r.strike, iv, gap };
    }
    return best;
  };
  const p = pick("pe");
  const c = pick("ce");
  if (!p || !c) return null;
  return { put: p.iv, call: c.iv, rr: p.iv - c.iv, putStrike: p.strike, callStrike: c.strike };
}

/** P(price at expiry < x) on the forward (log-normal, Black-76); 0 for x ≤ 0; null without a forward, time or vol. */
export function probBelow(x, forward, years, ivPct) {
  const X = num(x);
  const F = num(forward);
  const sig = (num(ivPct) ?? 0) / 100;
  if (X === null || F === null || F <= 0 || !(years > 0) || !(sig > 0)) return null;
  return cdfAt(X, F, years, sig);
}

/** One hour in years: the floor for T, so σ maths near the close never divides by zero. */
export const MIN_YEARS = 1 / (24 * 365);

/**
 * The screener's percent form of the reference charge table (refCharges(bundle)): percent fields are in percent
 * (0.15 = 0.15 %), from the same figures as `charges()`. Brokerage is the reference default; the screener's own
 * setting overrides it. Pure.
 */
export function chargesPct(rates = FALLBACK_RATES) {
  const r = rates ?? FALLBACK_RATES;
  const pct = (v) => Math.round(v * 100 * 1e9) / 1e9;
  return {
    asOf: r.asOfDate ?? null,
    brokeragePerOrder: num(r.brokeragePerOrder) ?? 0,
    sttSellPct: pct(r.opt.sttSell),
    sttExercisePct: pct(r.opt.exerciseStt),
    txnPct: { NFO: pct(r.opt.txn.NSE), BFO: pct(r.opt.txn.BSE) },
    sebiPerCrore: r.sebiPerCrore,
    stampBuyPct: pct(r.opt.stampBuy),
    gstPct: pct(r.gst),
  };
}
const FALLBACK_PCT = chargesPct(FALLBACK_RATES);
const zeroCosts = () => ({ brokerage: 0, stt: 0, txn: 0, sebi: 0, stamp: 0, gst: 0, total: 0 });
const addCosts = (a, b) => {
  a.brokerage += b.brokerage;
  a.stt += b.stt;
  a.txn += b.txn;
  a.sebi += b.sebi;
  a.stamp += b.stamp;
  a.gst += b.gst;
  a.total += b.total;
  return a;
};
/**
 * Charges of one option order in ₹ (unrounded): brokerage, STT (sells, on premium), exchange transaction charge,
 * SEBI fee, stamp duty (buys) and GST on brokerage + exchange + SEBI.
 * @param {{ side: "BUY"|"SELL", price: number, qty: number, exchange?: "NFO"|"BFO" }} o
 */
export function legCosts({ side, price, qty, exchange = "NFO" } = {}, charges = FALLBACK_PCT) {
  const c = charges ?? FALLBACK_PCT;
  const turnover = Math.max(0, (num(price) ?? 0) * (num(qty) ?? 0));
  const brokerage = num(c.brokeragePerOrder) ?? 0;
  const stt = side === "SELL" ? (turnover * c.sttSellPct) / 100 : 0;
  const txn = (turnover * (c.txnPct[exchange] ?? c.txnPct.NFO)) / 100;
  const sebi = (turnover * c.sebiPerCrore) / 1e7;
  const stamp = side === "BUY" ? (turnover * c.stampBuyPct) / 100 : 0;
  const gst = ((brokerage + txn + sebi) * c.gstPct) / 100;
  return { brokerage, stt, txn, sebi, stamp, gst, total: brokerage + stt + txn + sebi + stamp + gst };
}
/** Buy then sell one lot at the same price: the cost of a round trip, by line. */
export function roundTripCosts(price, lot, exchange = "NFO", charges = FALLBACK_PCT) {
  const out = zeroCosts();
  addCosts(out, legCosts({ side: "BUY", price, qty: lot, exchange }, charges));
  addCosts(out, legCosts({ side: "SELL", price, qty: lot, exchange }, charges));
  return out;
}
/**
 * Opening charges of an arbitrage hit for one lot (each leg × its qty), plus settlement STT on a box: 0.15 % of the
 * width × lot (the intrinsic of the in-the-money long leg at expiry).
 */
export function arbCosts(hit, lot, exchange = "NFO", charges = FALLBACK_PCT) {
  const c = charges ?? FALLBACK_PCT;
  const out = zeroCosts();
  for (const l of hit?.legs ?? []) addCosts(out, legCosts({ side: l.side, price: l.price, qty: (num(l.qty) ?? 1) * (num(lot) ?? 1), exchange }, c));
  // Settlement STT is paid on the intrinsic of an exercised long. A bought box (long K1 call, long K2 put) always has
  // one long ITM worth the width. A sold box is long the K2 call and the K1 put, both OTM when settlement lands
  // between the strikes (its short legs are assigned and pay none), so it adds nothing here.
  if (/box \(buy\)/i.test(String(hit?.kind ?? "")) && hit.legs?.length) {
    const ks = hit.legs.map((l) => l.strike);
    const settle = ((Math.max(...ks) - Math.min(...ks)) * (num(lot) ?? 1) * c.sttExercisePct) / 100;
    out.stt += settle;
    out.total += settle;
  }
  return out;
}

/**
 * What every screener row of one chain shares: spot, forward (parity, as on the Chain page), time (floored at one
 * hour), lot, ATM IV and the ±1σ move, the chain summary, volume ranks, Vol/OI medians, HV20 and the exchange.
 */
export function chainContext(chain, { now = Date.now(), hv20 = null, charges = FALLBACK_PCT, rate = FALLBACK_RATE, close = FALLBACK_SESSION.close } = {}) {
  const rows = [...(chain?.rows ?? [])].filter((r) => num(r?.strike) !== null).sort((a, b) => a.strike - b.strike);
  const sm = chainSummary(chain);
  const tte = timeToExpiry(chain?.expiry, now, close);
  const yrs = tte.days === null ? null : tte.days / 365;
  const T = yrs === null ? null : Math.max(yrs, MIN_YEARS);
  const S = num(chain?.underlyingLtp);
  const F = forwardPrice(chain, parityGrowth(T, rate)) ?? S;
  const atmIv = num(sm.atmIv);
  let step = null;
  for (let i = 1; i < rows.length; i++) {
    const g = rows[i].strike - rows[i - 1].strike;
    if (g > 0 && (step === null || g < step)) step = g;
  }
  const sym = rows.find((r) => r.ce?.symbol || r.pe?.symbol);
  return {
    underlying: chain?.underlying ?? null,
    expiry: chain?.expiry ?? null,
    rows,
    S,
    F,
    T,
    days: tte.days,
    label: tte.label,
    expired: tte.label === "Expired",
    lot: num(chain?.lotSize) || 1,
    atmIv,
    em: sigmaMove(F, atmIv, T),
    sm,
    ranks: { ce: volumeRanks(rows, "ce"), pe: volumeRanks(rows, "pe") },
    volOi: { ce: volOiRelative(rows, "ce", VOL_OI_MIN_LOTS * (num(chain?.lotSize) || 1)), pe: volOiRelative(rows, "pe", VOL_OI_MIN_LOTS * (num(chain?.lotSize) || 1)) },
    hv20: num(hv20),
    exchange: /^BFO:/.test(String(sym?.ce?.symbol ?? sym?.pe?.symbol ?? "")) ? "BFO" : "NFO",
    step,
    charges: charges ?? FALLBACK_PCT,
    rate: num(rate) ?? FALLBACK_RATE,
  };
}

/**
 * Every figure the screener ranks a single option leg by (PRD 07 §5.2). Null when the leg has no price at all.
 * Prices: you sell at the bid and buy at the ask (the last price when a side is missing, flagged by `priceQ`).
 */
export function legMetrics(leg, row, side, ctx) {
  if (!leg || !ctx) return null;
  const R = side === "pe" ? "PE" : "CE";
  const K = num(row?.strike);
  const bid = num(leg.bid) > 0 ? num(leg.bid) : null;
  const ask = num(leg.ask) > 0 ? num(leg.ask) : null;
  const ltp = num(leg.ltp) > 0 ? num(leg.ltp) : null;
  const two = bid !== null && ask !== null && ask >= bid;
  const m = two ? (bid + ask) / 2 : ltp;
  if (K === null || m === null || !(m > 0)) return null;
  const { F, S, T, lot, atmIv, days } = ctx;
  const sell = bid ?? ltp;
  const buy = ask ?? ltp;
  const legIv = num(leg.iv) > 0 ? num(leg.iv) : null;
  const ivL = legIv ?? atmIv;
  const sdA = atmIv !== null && T > 0 ? (atmIv / 100) * Math.sqrt(T) : null;
  const delta = num(leg.delta);
  const theta = num(leg.theta);
  const vega = num(leg.vega);
  const oi = num(leg.oi);
  const oiChange = num(leg.oiChange);
  const volume = num(leg.volume);
  const pb = (x) => probBelow(x, F, T, ivL);
  const popShort = sell === null ? null : R === "CE" ? pb(K + sell) : pb(K - sell) === null ? null : 1 - pb(K - sell);
  const popLong = buy === null ? null : R === "CE" ? (pb(K + buy) === null ? null : 1 - pb(K + buy)) : pb(K - buy);
  const beLong = buy === null ? null : R === "CE" ? K + buy : K - buy;
  const prior = oi !== null && oiChange !== null ? oi - oiChange : null;
  const nbrIv = neighbourIv(ctx.rows, side, K);
  return {
    kind: "contract",
    key: leg.symbol ?? `${ctx.underlying}|${ctx.expiry}|${K}|${R}`,
    symbol: leg.symbol ?? null,
    underlying: ctx.underlying,
    expiry: ctx.expiry,
    strike: K,
    right: R,
    side,
    lot,
    days,
    S,
    F,
    bid,
    ask,
    ltp,
    mid: m,
    priceQ: two ? "mid" : "ltp",
    sellPrice: sell,
    buyPrice: buy,
    spread: spreadPct(leg),
    liq: liquidityScore(leg, ctx.ranks[side].get(K)),
    otm: F !== null && (R === "CE" ? K > F : K < F),
    iv: legIv,
    ivUsed: ivL,
    ivFallback: legIv === null && atmIv !== null,
    delta,
    absDelta: delta === null ? null : Math.abs(delta),
    gamma: num(leg.gamma),
    theta,
    vega,
    sigmaOtm: sdA && F > 0 ? (R === "CE" ? Math.log(K / F) : Math.log(F / K)) / sdA : null,
    thetaPct: theta !== null && m >= 0.5 ? (Math.abs(theta) / m) * 100 : null,
    thetaLot: theta === null ? null : Math.abs(theta) * lot,
    vegaPct: vega !== null ? (vega / m) * 100 : null,
    leverage: delta !== null && S !== null ? (Math.abs(delta) * S) / m : null,
    popShort,
    popLong,
    beLong,
    beSigma: sdA && beLong > 0 && F > 0 ? Math.abs(Math.log(beLong / F)) / sdA : null,
    // Chance the index touches the level before expiry, from spot (1 only when spot is already at or beyond it): the
    // long's breakeven and the short's strike.
    touchBe: touchFrom(beLong, S ?? F, T, ivL, R),
    touchK: touchFrom(K, S ?? F, T, ivL, R),
    ivHv: ctx.hv20 !== null && ivL !== null ? ivL - ctx.hv20 : null,
    volume,
    oi,
    oiChange,
    oiChangeLots: oiChange === null ? null : oiChange / lot,
    volOi: volume !== null && oi > 0 ? volume / oi : null,
    volOiRel: ctx.volOi[side].get(K) ?? null,
    oiChgPct: prior !== null && prior >= 100 * lot ? oiChangePct(leg) : null,
    committed: oiChange === null ? null : Math.abs(oiChange) * m,
    turnover: volume === null ? null : volume * m,
    changePct: changePct(leg),
    tag: buildup(leg),
    nbrIv,
    bump: legIv !== null && nbrIv !== null ? legIv - nbrIv : null,
    vsAtm: legIv !== null && atmIv !== null ? legIv - atmIv : null,
    fair: nbrIv !== null ? black76(F, K, T, nbrIv, R) : null,
    costsRt: roundTripCosts(m, lot, ctx.exchange, ctx.charges),
  };
}

/**
 * The defined-risk alternative to a short: buy the strike `widthStrikes` steps further out (the furthest listed one
 * short of that). credit = short bid − wing ask; maxLoss = (width − credit) × lot; rr = maxLoss ÷ credit per lot.
 * Null without a wing strike or a positive credit.
 */
export function wingFor(rec, chain, widthStrikes = 4) {
  if (!rec || rec.sellPrice === null || rec.sellPrice === undefined) return null;
  const side = rec.right === "PE" ? "pe" : "ce";
  const { rows, step } = strikeGrid(chain);
  if (!step) return null;
  const reach = step * Math.max(1, num(widthStrikes) ?? 4) + 1e-9;
  const price = (q) => (num(q?.ask) > 0 ? num(q.ask) : num(q?.ltp) > 0 ? num(q.ltp) : null);
  const out = rows.filter((r) => (rec.right === "CE" ? r.strike > rec.strike : r.strike < rec.strike) && Math.abs(r.strike - rec.strike) <= reach && price(r[side]) !== null);
  if (!out.length) return null;
  const w = rec.right === "CE" ? out[out.length - 1] : out[0];
  const wingAsk = price(w[side]);
  const credit = rec.sellPrice - wingAsk;
  if (!(credit > 0)) return null;
  const lot = num(rec.lot) || 1;
  const maxLoss = (Math.abs(w.strike - rec.strike) - credit) * lot;
  return { wingStrike: w.strike, wingSymbol: w[side]?.symbol ?? null, wingAsk, credit, maxLoss, rr: maxLoss / (credit * lot) };
}

const GRID = new WeakMap(); // chain → its rows by strike and the minimum strike step
function strikeGrid(chain) {
  let g = chain ? GRID.get(chain) : null;
  if (g) return g;
  const rows = [...(chain?.rows ?? [])].filter((r) => num(r?.strike) !== null).sort((a, b) => a.strike - b.strike);
  let step = null;
  for (let i = 1; i < rows.length; i++) {
    const d = rows[i].strike - rows[i - 1].strike;
    if (d > 0 && (step === null || d < step)) step = d;
  }
  g = { rows, step };
  if (chain) GRID.set(chain, g);
  return g;
}

/** Screener score weights and penalties, in one place (PRD 07 §5.5). */
export const SCORE = Object.freeze({
  sell: Object.freeze({ rich: 0.35, safety: 0.25, decay: 0.2, liq: 0.2 }),
  buy: Object.freeze({ cheap: 0.3, reach: 0.3, decay: 0.2, liq: 0.2 }),
  penalty: 0.5,
  minParts: 3,
});
const SCORE_LABEL = Object.freeze({ rich: "Richness", safety: "Safety", decay: "Decay", liq: "Liquidity", cheap: "Cheapness", reach: "Reach" });
const clamp01 = (x) => Math.min(1, Math.max(0, x));
function scoreOf(parts, penalties) {
  const use = parts.filter((p) => p.value !== null);
  if (use.length < SCORE.minParts) return null;
  const w = use.reduce((a, p) => a + p.weight, 0);
  const raw = use.reduce((a, p) => a + p.weight * p.value, 0) / w;
  const pen = penalties.length ? SCORE.penalty : 1;
  // `raw` keeps the decimals, so ties on the integer can still be told apart (the table shows one decimal then).
  return { score: Math.round(100 * raw * pen), raw: 100 * raw * pen, parts, penalties };
}
const part = (id, weight, value) => ({ id, label: SCORE_LABEL[id], weight, value: value === null || value === undefined || !Number.isFinite(value) ? null : value });
const liqPart = (liq) => (num(liq) === null ? null : clamp01((liq - 1) / 4));
/** 0–100 for writing this (OTM) leg: rich IV over HV, a high chance of keeping the premium, fast decay, liquidity. */
export function sellScore(rec) {
  if (!rec || !rec.otm) return null;
  const W = SCORE.sell;
  const parts = [
    part("rich", W.rich, rec.ivHv === null ? null : clamp01((rec.ivHv + 2) / 8)),
    part("safety", W.safety, rec.popShort === null ? null : clamp01((rec.popShort - 0.6) / 0.3)),
    part("decay", W.decay, rec.thetaPct === null ? null : clamp01(rec.thetaPct / 15)),
    part("liq", W.liq, liqPart(rec.liq)),
  ];
  const pen = [];
  if (rec.sigmaOtm !== null && rec.sigmaOtm < 1) pen.push("Inside 1σ");
  if (rec.days !== null && rec.days < 1) pen.push("Expiry day");
  return scoreOf(parts, pen);
}
/** 0–100 for buying this leg: IV cheap to HV, a breakeven within reach, slow decay, liquidity. */
export function buyScore(rec) {
  if (!rec) return null;
  const W = SCORE.buy;
  const parts = [
    part("cheap", W.cheap, rec.ivHv === null ? null : clamp01((2 - rec.ivHv) / 8)),
    part("reach", W.reach, rec.beSigma === null ? null : clamp01((1.5 - rec.beSigma) / 1)),
    part("decay", W.decay, rec.thetaPct === null ? null : clamp01(1 - rec.thetaPct / 10)),
    part("liq", W.liq, liqPart(rec.liq)),
  ];
  const pen = [];
  if (rec.popLong !== null && rec.popLong < 0.1) pen.push("Lottery ticket");
  if (rec.days !== null && rec.days < 1) pen.push("Expiry day");
  return scoreOf(parts, pen);
}

const READING = Object.freeze({
  CE: Object.freeze({ LB: ["Call buying", "bullish"], SB: ["Call writing", "bearish"], SC: ["Call short covering", "bullish"], LU: ["Call unwinding", "bearish"] }),
  PE: Object.freeze({ LB: ["Put buying", "bearish"], SB: ["Put writing", "bullish"], SC: ["Put short covering", "bearish"], LU: ["Put unwinding", "bullish"] }),
});
/** The writer's reading of a leg's build-up tag: "Put writing · bullish". Null for no tag. */
export function buildupReading(tag, right) {
  const r = READING[right === "PE" ? "PE" : "CE"][tag];
  return r ? { text: `${r[0]} · ${r[1]}`, action: r[0], bias: r[1] } : null;
}
/** The build-up with the most money behind it (Σ |OI change| × mid per tag and right). Null without OI change. */
export function dominantBuildup(chain) {
  const legs = (chain?.rows ?? []).flatMap((r) => [["CE", r.ce], ["PE", r.pe]]).filter(([, q]) => q);
  if (!legs.some(([, q]) => num(q.oiChange) !== null)) return null;
  const sums = new Map();
  for (const [right, q] of legs) {
    const tag = buildup(q);
    const m = mid(q);
    if (!tag || m === null) continue;
    const k = `${tag}|${right}`;
    sums.set(k, (sums.get(k) ?? 0) + Math.abs(num(q.oiChange)) * m);
  }
  let best = null;
  for (const [k, v] of sums) if (!best || v > best.rupees) best = { key: k, rupees: v };
  if (!best) return null;
  const [tag, right] = best.key.split("|");
  return { tag, right, rupees: best.rupees, ...buildupReading(tag, right) };
}

/**
 * Protective puts below the forward within a depth band (percent below F), priced at the ask: cost, ₹ per lot and per
 * day, annualised cost, the payout multiple at a −2σ fall (ATM IV), skew paid, and lots for an index notional.
 */
export function hedgeRows(chain, ctx, { minDepth = 0, maxDepth = 100, notional = null } = {}) {
  const c = ctx ?? chainContext(chain);
  const { F, T, lot, atmIv } = c;
  if (!(F > 0)) return [];
  const days = Math.max(num(c.days) ?? 0, 0.25);
  const N = num(notional) > 0 ? num(notional) : null;
  const low = atmIv !== null && T > 0 ? F * Math.exp(-2 * (atmIv / 100) * Math.sqrt(T)) : null;
  const out = [];
  for (const r of c.rows ?? []) {
    const q = r.pe;
    const ask = num(q?.ask);
    if (!q || !(ask > 0) || !(r.strike < F)) continue;
    const depth = ((F - r.strike) / F) * 100;
    if (depth < minDepth - 1e-9 || depth > maxDepth + 1e-9) continue;
    const costPct = (ask / F) * 100;
    const lots = N ? Math.ceil(N / (F * lot)) : null;
    out.push({
      kind: "hedge",
      key: q.symbol ?? `${c.underlying}|${c.expiry}|${r.strike}|PE`,
      symbol: q.symbol ?? null,
      underlying: c.underlying,
      expiry: c.expiry,
      strike: r.strike,
      right: "PE",
      side: "pe",
      lot,
      days: c.days,
      depth,
      ask,
      bid: num(q.bid) > 0 ? num(q.bid) : null,
      costPct,
      perLot: ask * lot,
      perDay: (ask * lot) / days,
      annualised: (costPct * 365) / days,
      payout: low === null ? null : Math.max(0, r.strike - low) / ask,
      skewPaid: num(q.iv) > 0 && atmIv !== null ? num(q.iv) - atmIv : null,
      lots,
      total: lots === null ? null : lots * ask * lot,
      liq: liquidityScore(q, c.ranks?.pe?.get(r.strike)),
      spread: spreadPct(q),
    });
  }
  return out;
}
/** "Best per expiry": the cheapest put per year for each underlying × expiry (ties go to the deeper put). */
export function bestHedges(rows) {
  const best = new Map();
  for (const r of rows ?? []) {
    const k = `${r.underlying}|${r.expiry}`;
    const b = best.get(k);
    if (!b || r.annualised < b.annualised - 1e-12 || (Math.abs(r.annualised - b.annualised) <= 1e-12 && r.strike < b.strike)) best.set(k, r);
  }
  return (rows ?? []).filter((r) => best.get(`${r.underlying}|${r.expiry}`) === r);
}

/**
 * Is the ATM straddle rich or cheap? Against HV20 when known (IV ÷ HV: ≥ 1.20 rich, ≤ 0.90 cheap), else against
 * the other scanned chains (straddle % ÷ √days relative to their median: ≥ 1.15 / ≤ 0.87; needs 3 peers).
 * @param {{ days: number, atmIv: number|null, hv20: number|null, straddle: number|null, S: number|null }} ov
 * @returns {{ label: string|null, ratio: number|null, basis: "hv"|"peers"|"expiry"|null }}
 */
export function straddleVerdict(ov, peers = []) {
  if (!ov) return { label: null, ratio: null, basis: null };
  if (num(ov.days) !== null && ov.days < 1) return { label: "Expiry day", ratio: null, basis: "expiry" };
  const iv = num(ov.atmIv);
  const hv = num(ov.hv20);
  if (iv !== null && hv !== null && hv > 0) {
    const ratio = iv / hv;
    return { label: ratio >= 1.2 ? "Rich" : ratio <= 0.9 ? "Cheap" : "Fair", ratio, basis: "hv" };
  }
  const dns = (o) => (num(o?.straddle) > 0 && num(o?.S) > 0 && num(o?.days) >= 1 ? o.straddle / o.S / Math.sqrt(o.days) : null);
  const vals = (peers ?? []).map(dns).filter((v) => v !== null);
  const me = dns(ov);
  if (vals.length < 3 || me === null) return { label: null, ratio: null, basis: null };
  const ratio = me / median(vals);
  return { label: ratio >= 1.15 ? "Rich vs peers" : ratio <= 0.87 ? "Cheap vs peers" : "Fair vs peers", ratio, basis: "peers" };
}

// ── Display helpers shared by every Options page (PRD 08; pure, tested) ──

/** Round axis values (1, 2, 2.5 or 5 × 10^n) covering [lo, hi]: about `count` ticks. (0, 0) → [0]. */
export function niceTicks(lo, hi, count) {
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  const span = b - a || Math.abs(b) || 1;
  const raw = span / Math.max(1, count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(a / step) * step; v <= b + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : Math.round(v / step) * step);
  if (!out.length && a === b) out.push(a);
  return out;
}

/**
 * Lay labels out on one line without overlap: each label [{ x, w, text }] (centre and width, px) is nudged right to
 * keep `gap` px from the one before; when a nudge would push it more than `maxShift` px off its mark, it is merged
 * with the previous label ("BE 25906 · 26420"). Returns [{ x, text, xs: [marks] }], left to right, clamped to
 * [lo, hi]. Pure.
 */
export function placeLabels(items, { gap = 4, maxShift = 18, lo = -Infinity, hi = Infinity, join = " · ", prefix = "" } = {}) {
  const list = [...(items ?? [])].filter((i) => Number.isFinite(i?.x)).sort((p, q) => p.x - q.x);
  const out = [];
  // Settle the last label against the one before it: nudge it right (up to maxShift from its marks) or merge the
  // two, then re-check the merged label against the one before that, so a merge never lands on an earlier label.
  const settle = () => {
    while (out.length > 1) {
      const cur = out[out.length - 1];
      const prev = out[out.length - 2];
      const need = prev.x + prev.w / 2 + gap + cur.w / 2;
      if (cur.x >= need) return;
      const home = (cur.xs[0] + cur.xs[cur.xs.length - 1]) / 2;
      if (need - home <= maxShift) {
        cur.x = need;
        return;
      }
      const xs = [...prev.xs, ...cur.xs];
      out.splice(-2, 2, { x: (xs[0] + xs[xs.length - 1]) / 2, w: prev.w + cur.w + 12, parts: [...prev.parts, ...cur.parts], xs });
    }
  };
  for (const it of list) {
    out.push({ x: it.x, w: it.w, parts: [it.text], xs: [it.x] });
    settle();
  }
  return out.map((o) => {
    const x = Math.max(lo + o.w / 2, Math.min(hi - o.w / 2, o.x));
    return { x, xs: o.xs, text: o.parts.length > 1 ? `${prefix}${o.parts.join(join)}` : o.parts[0] };
  });
}

/**
 * The expiry picker's words for one expiry: "5d" (calendar days), "<1d" on expiry day, "Expired" after the close, and
 * "M" for the monthly (the last listed expiry of its month) or "W" for a weekly. Pure.
 */
export function expiryTag(expiry, expiries, now = Date.now()) {
  const t = timeToExpiry(expiry, now);
  const n = /^(\d+) days?$/.exec(t.label);
  const days = t.label === "Expired" ? "Expired" : t.label === "Expires today" ? "<1d" : n ? `${n[1]}d` : "";
  return { days, kind: isMonthlyExpiry(expiry, expiries) ? "M" : "W" };
}

/**
 * What the freshness pill says. Inputs: the response's `asOf`, `stale` and `marketOpen` flags, whether the last fetch
 * failed, whether the page is live, and the refresh period. Kinds: "error" (Not updating), "paused", "closed" (Market
 * closed · last <time>), "stale" (flag set, or older than 3 refresh periods while live) and "live" (as of <time>).
 * Market hours (09:15–15:30 IST on weekdays) decide "closed" when the response has no `marketOpen` flag. Pure.
 */
export function freshnessState({ asOf = null, stale = false, marketOpen = undefined, error = false, live = true, refreshMs = 3000, now = Date.now(), demo = false, session = FALLBACK_SESSION } = {}) {
  const t = asOf ? Date.parse(asOf) : NaN;
  const ageMs = Number.isFinite(t) ? Math.max(0, now - t) : null;
  const open = typeof marketOpen === "boolean" ? marketOpen : demo ? true : marketSession(now, session).phase === "open";
  let kind = "live";
  if (error) kind = "error";
  else if (!live) kind = "paused";
  else if (!open) kind = "closed";
  else if (stale || (ageMs !== null && ageMs > 3 * refreshMs)) kind = "stale";
  return { kind, ageMs, open };
}

/** Legs whose bid-ask spread is wider than `limit` % of mid (the Exit all warning). Pure. */
export function wideSpreadCount(quotes, limit = 5) {
  return (quotes ?? []).filter((q) => {
    const s = spreadPct(q);
    return s !== null && s > limit;
  }).length;
}

// ── Colour scales for data visualisation (docs/design/foundation.md §4.3–4.4). Pure; viz.js heatCell paints them. ──

/** The p-th percentile (0..1, linear interpolation) of the finite values; null when there are none. Pure. */
export function percentileOf(values, p) {
  const v = (values ?? []).filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = Math.max(0, Math.min(1, p)) * (v.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return v[lo] + (v[hi] - v[lo]) * (i - lo);
}

/**
 * Sequential step 1..5 for an intensity value: clamp(1, 5, 1 + floor(4 · (v − lo) / (hi − lo))). Pass lo / hi as the
 * 5th and 95th percentile of the visible values (scaleRange) so one outlier does not wash the rest out. A missing or
 * non-finite value (or lo / hi) gives null: no fill, the cell shows "--". lo === hi gives the middle step.
 */
export function seqStep(v, lo, hi) {
  if (![v, lo, hi].every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  if (hi <= lo) return 3;
  return Math.max(1, Math.min(5, 1 + Math.floor((4 * (v - lo)) / (hi - lo))));
}

/**
 * Diverging step −3..+3 for a signed value: sign(v) · min(3, ceil(3 · |v| / m)), 0 inside the dead-band |v| < m / 20.
 * `m` is the 95th percentile of |v| (scaleRange). Missing values (or m ≤ 0) give null, except v === 0 → 0.
 */
export function divStep(v, m) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v === 0) return 0;
  if (typeof m !== "number" || !Number.isFinite(m) || m <= 0) return null;
  const a = Math.abs(v);
  if (a < m / 20) return 0;
  return Math.sign(v) * Math.min(3, Math.ceil((3 * a) / m));
}

/** The ranges for seqStep / divStep from the values on screen: { lo, hi } (5th / 95th percentile) and m (95th of |v|). */
export function scaleRange(values) {
  const v = (values ?? []).filter((x) => typeof x === "number" && Number.isFinite(x));
  return { lo: percentileOf(v, 0.05), hi: percentileOf(v, 0.95), m: percentileOf(v.map(Math.abs), 0.95) };
}

// ── Option chain round 2 (docs/design/chain.md) ──

/**
 * Heat-cell alpha for the chain's "Cell fill" bar style: a0 + a1 · frac^0.75 (frac clamped to 0..1). Dark uses
 * a0 0.06 / a1 0.42, light 0.05 / 0.32; the curve lifts small values so mid-sized OI still reads. Missing → 0.
 */
export function heatAlpha(frac, a0 = 0.06, a1 = 0.42) {
  const f = num(frac);
  if (f === null || f <= 0) return 0;
  return a0 + a1 * Math.min(1, f) ** 0.75;
}
/** frac^0.75 (clamped 0..1): the shape heatAlpha applies, for CSS to scale per theme. */
export const heatShape = (frac) => {
  const f = num(frac);
  return f === null || f <= 0 ? 0 : Math.min(1, f) ** 0.75;
};

/** PCR at one strike: put OI ÷ call OI (null without both, or with no call OI). */
export function strikePcr(row) {
  const c = num(row?.ce?.oi);
  const p = num(row?.pe?.oi);
  return c === null || p === null || c <= 0 ? null : p / c;
}

/** The straddle at one strike: mid(CE) + mid(PE) (null when either side has no price). */
export function strikeStraddle(row) {
  const c = mid(row?.ce);
  const p = mid(row?.pe);
  return c === null || p === null ? null : c + p;
}

/**
 * The chain with each leg's oiChange measured over a window instead of the day: OI now minus the OI in the reference
 * snapshot `snap` (oi-store), and `winChange` the price change over the same window (build-up reads both). A strike the
 * snapshot does not have keeps a null change. Without a snapshot the chain is returned as is.
 */
export function withOiWindow(chain, snap) {
  if (!chain?.rows || !snap?.k) return chain;
  const w = new Map(oiWindowRows(chain, snap).map((r) => [r.strike, r]));
  // oiWindowRows counts a strike the snapshot lacks from zero (its whole OI as "added"): here it has no change.
  const has = new Set(snap.k);
  return {
    ...chain,
    rows: chain.rows.map((r) => {
      const o = has.has(r.strike) ? w.get(r.strike) : null;
      const leg = (side) => (r[side] ? { ...r[side], oiChange: o?.[side]?.d ?? null, winChange: o?.[side]?.dLtp ?? null } : r[side]);
      return { ...r, ce: leg("ce"), pe: leg("pe") };
    }),
  };
}

// ── Strategy builder, round 2 (docs/design/strategy.md): probabilities, P&L table rows, sizing, multi-expiry drafts,
// adjustments, auto-naming and suggestions by view. Pure, tested in strategy.test.mjs. ──

/** Chain prices older than this block placing (STALE). */
export const STALE_MS = 15000;
const PHI = (z) => Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI);
/** Log-normal density of S at `t` years (forward measure, σ as a decimal): φ(z) / (S·σ·√t), z = (ln(S/F) + σ²t/2)/(σ√t). */
export function lognormalPdf(S, F, sig, t) {
  if (!(S > 0) || !(F > 0) || !(sig > 0) || !(t > 0)) return 0;
  const sd = sig * Math.sqrt(t);
  return PHI((Math.log(S / F) + (sd * sd) / 2) / sd) / (S * sd);
}
/** P(price at `years` > x): 1 − probBelow. Null without a forward, time or vol. */
export function probAbove(x, forward, years, ivPct) {
  const b = probBelow(x, forward, years, ivPct);
  return b === null ? null : 1 - b;
}
/**
 * P(f(S_T) > 0) under the log-normal (S = F·e^(−σ²T/2 + σ√T·z)): f is sampled on n + 1 points of z ∈ [−6, 6], every
 * sign change is refined by bisection and the normal mass of each profitable z-interval is summed. The POP of a
 * curved payoff (calendars), whose breakevens are only sampled.
 */
export function probProfit(f, { forward, ivPct, years, n = 600 } = {}) {
  const F = num(forward);
  const sig = (num(ivPct) ?? 0) / 100;
  if (!(F > 0) || !(sig > 0) || !(years > 0)) return null;
  const sd = sig * Math.sqrt(years);
  const ok = (z) => f(F * Math.exp((-sd * sd) / 2 + sd * z)) > 0;
  const h = 12 / n;
  let p = 0;
  let z0 = -6;
  let in0 = ok(z0);
  let from = in0 ? -Infinity : null;
  for (let i = 1; i <= n; i += 1) {
    const z1 = -6 + i * h;
    const in1 = ok(z1);
    if (in1 !== in0) {
      let a = z0;
      let b = z1;
      for (let k = 0; k < 50 && b - a > 1e-9; k += 1) {
        const m = (a + b) / 2;
        if (ok(m) === in0) a = m;
        else b = m;
      }
      const zc = (a + b) / 2;
      if (in1) from = zc;
      else {
        p += normCdf(zc) - (from === -Infinity ? 0 : normCdf(from));
        from = null;
      }
    }
    z0 = z1;
    in0 = in1;
  }
  if (from !== null) p += 1 - (from === -Infinity ? 0 : normCdf(from));
  return Math.max(0, Math.min(1, p));
}
/**
 * The price intervals where `test(value)` holds on a sampled curve: [[a, b]], ends found by linear interpolation; an
 * interval that reaches the first sample starts at 0 and one that reaches the last runs to Infinity.
 */
export function intervalsWhere(xs, vals, test) {
  const out = [];
  let start = null;
  const cross = (i) => {
    const a = vals[i - 1];
    const b = vals[i];
    if (a === null || b === null || a === b) return xs[i];
    // Linear root of (v − level) where the test flips: the curve crosses zero for v > 0 tests and near-max tests alike.
    const lvl = test.level ?? 0;
    const t = (lvl - a) / (b - a);
    return xs[i - 1] + (xs[i] - xs[i - 1]) * Math.max(0, Math.min(1, t));
  };
  for (let i = 0; i < xs.length; i += 1) {
    const ok = vals[i] !== null && test(vals[i]);
    if (ok && start === null) start = i === 0 ? 0 : cross(i);
    if (!ok && start !== null) {
      out.push([start, cross(i)]);
      start = null;
    }
  }
  if (start !== null) out.push([start, Infinity]);
  return out;
}
/** P(S_T inside any of the intervals) under the log-normal. */
export function probIntervals(intervals, forward, years, ivPct) {
  let p = 0;
  for (const [a, b] of intervals ?? []) {
    const hi = b === Infinity ? 1 : probBelow(b, forward, years, ivPct);
    const lo = a <= 0 ? 0 : probBelow(a, forward, years, ivPct);
    if (hi === null || lo === null) return null;
    p += hi - lo;
  }
  return Math.max(0, Math.min(1, p));
}
/** P(max profit): the chance the expiry price lands where the curve is within 0.5% (₹1 at least) of its top. */
export function probMaxProfit(xs, vals, forward, years, ivPct) {
  const top = Math.max(...vals.filter((v) => v !== null));
  if (!Number.isFinite(top) || top <= 0) return null;
  const eps = Math.max(1, Math.abs(top) * 0.005);
  const test = (v) => v >= top - eps;
  test.level = top - eps;
  return probIntervals(intervalsWhere(xs, vals, test), forward, years, ivPct);
}
/**
 * P(the index touches `level` before `years`, starting from `from` (spot)), on the side a call (above) or a put
 * (below) cares about: 1 when it is already there, else the reflection approximation. Null without inputs.
 */
export function touchFrom(level, from, years, ivPct, right) {
  const x = num(level);
  const s = num(from);
  if (x === null || !(s > 0)) return null;
  if (right === "PE" ? s <= x : s >= x) return 1;
  return probTouch(x, s, years, ivPct);
}
/** P(the price touches x before `years`) ≈ min(1, 2·P(close beyond x)) (the reflection approximation). */
export function probTouch(x, forward, years, ivPct) {
  const F = num(forward);
  if (num(x) === null || !(F > 0)) return null;
  const beyond = x >= F ? probAbove(x, F, years, ivPct) : probBelow(x, F, years, ivPct);
  return beyond === null ? null : Math.min(1, 2 * beyond);
}

/**
 * Rows of the P&L table by spot (§5.2): the listed strikes from n steps below the strike nearest spot to n above,
 * the spot itself and the breakevens, sorted: [{ price, kind: "strike" | "spot" | "be" }].
 */
export function spotLevels({ strikes = [], spot = null, n = 6, breakevens = [] } = {}) {
  const S = num(spot);
  const ks = [...new Set(strikes.filter((k) => num(k) !== null))].sort((a, b) => a - b);
  if (S === null || !ks.length) return [];
  let i = 0;
  ks.forEach((k, j) => (Math.abs(k - S) < Math.abs(ks[i] - S) ? (i = j) : null));
  const from = Math.max(0, Math.min(i - n, ks.length - (2 * n + 1)));
  const rows = ks.slice(from, from + 2 * n + 1).map((price) => ({ price, kind: "strike" }));
  const lo = rows[0].price;
  const hi = rows[rows.length - 1].price;
  if (!rows.some((r) => Math.abs(r.price - S) < 1e-9)) rows.push({ price: S, kind: "spot" });
  else rows.find((r) => Math.abs(r.price - S) < 1e-9).kind = "spot";
  for (const b of breakevens) if (num(b) !== null && b > lo && b < hi && !rows.some((r) => Math.abs(r.price - b) < 0.5)) rows.push({ price: b, kind: "be" });
  return rows.sort((a, b) => a.price - b.price);
}
/**
 * Rows of the P&L table that cover the whole story (§5.2): an even grid from the lowest to the highest of the legs'
 * strikes, the breakevens, spot and the ±1σ band, `rows` rows apart by step = max(strike step, roundUp(span / (rows − 1),
 * strike step)), so the wings and the loss side always show; spot and every breakeven inserted.
 * [{ price, kind: "strike" | "spot" | "be" }], sorted. Pure.
 */
export function coverLevels({ strikes = [], legStrikes = [], breakevens = [], spot = null, band = null, rows = 13 } = {}) {
  const S = num(spot);
  const ks = [...new Set(strikes.map(num).filter((k) => k !== null && k > 0))].sort((a, b) => a - b);
  if (S === null || !ks.length) return [];
  const gaps = ks.slice(1).map((k, i) => k - ks[i]).filter((g) => g > 0);
  const unit = gaps.length ? Math.min(...gaps) : Math.max(1, Math.round(S * 0.005));
  const marks = [S, ...legStrikes, ...breakevens, ...(band ?? [])].map(num).filter((v) => v !== null && v > 0);
  const lo = Math.min(...marks);
  const hi = Math.max(...marks);
  const n = Math.max(3, Math.floor(rows));
  const step = Math.max(unit, Math.ceil((hi - lo) / (n - 1) / unit - 1e-9) * unit);
  let a = Math.floor(lo / step) * step;
  let b = Math.ceil(hi / step) * step;
  for (let k = Math.round((b - a) / step) + 1, i = 0; k < n; k += 1, i += 1) {
    if (i % 2 === 0 && a - step > 0) a -= step;
    else b += step;
  }
  const out = [];
  for (let p = a; p <= b + step * 1e-9; p += step) out.push({ price: Math.round(p * 100) / 100, kind: "strike" });
  const same = (p) => out.find((r) => Math.abs(r.price - p) < 0.5);
  if (same(S)) same(S).kind = "spot";
  else out.push({ price: S, kind: "spot" });
  for (const be of breakevens.map(num).filter((v) => v !== null && v > 0)) if (!same(be)) out.push({ price: be, kind: "be" });
  return out.sort((p, q) => p.price - q.price);
}
/** Columns of the price × date grid: now, then each day to the expiry (≤ max columns, evenly spaced past that); the last is the expiry. */
export function gridDates(nowMs, expMs, max = 8) {
  if (!(expMs > nowMs)) return [nowMs];
  const DAY = 86400000;
  const days = Math.ceil((expMs - nowMs) / DAY);
  const n = Math.min(max - 1, days);
  const out = [nowMs];
  for (let i = 1; i < n; i += 1) out.push(days + 1 <= max ? nowMs + i * DAY : Math.round(nowMs + ((expMs - nowMs) * i) / n));
  out.push(expMs);
  return out;
}

const gcd2 = (a, b) => (b ? gcd2(b, a % b) : a);
/** The size multiplier of a draft: the gcd of the legs' lots (1 for an empty draft). */
export const legsGcd = (legs) => (legs ?? []).reduce((g, l) => gcd2(Math.max(1, Math.floor(num(l.lots) ?? 1)), g), 0) || 1;
/** Every leg at size g (§5.6): lots_i = (lots_i / gcd) × g, ratios kept; g is clamped to 1 … floor(maxLots / the largest ratio). */
export function sizeLegs(legs, g, { maxLots = 10000 } = {}) {
  const g0 = legsGcd(legs);
  const ratios = (legs ?? []).map((l) => Math.max(1, Math.floor(num(l.lots) ?? 1)) / g0);
  const cap = Math.max(1, Math.floor(maxLots / Math.max(1, ...ratios)));
  const k = Math.max(1, Math.min(cap, Math.floor(num(g) ?? 1)));
  return (legs ?? []).map((l, i) => ({ ...l, lots: ratios[i] * k }));
}
/** Buy ↔ sell on every leg (a credit structure becomes its debit mirror); entry prices are cleared. */
export const flipSides = (legs) =>
  (legs ?? []).map((l) => {
    const { entry, entryTag, ...rest } = l;
    void entry;
    void entryTag;
    return { ...rest, side: l.side === "BUY" ? "SELL" : "BUY" };
  });

/**
 * Drafts keyed by underlying (§5.1). Old `UNDERLYING|EXPIRY` drafts move into `UNDERLYING`, their legs keeping that
 * expiry. A draft of held legs (Positions → Analyse: every leg has an average entry) replaces the draft; others merge
 * (same contract and side add up), capped at MAX_LEGS. Returns a new object; legs come back unmigrated otherwise.
 */
export function migrateBaskets(baskets) {
  const src = baskets && typeof baskets === "object" ? baskets : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) if (!k.includes("|")) out[k] = Array.isArray(v) ? v : [];
  for (const [k, v] of Object.entries(src)) {
    if (!k.includes("|") || !Array.isArray(v) || !v.length) continue;
    const [u, e] = k.split("|");
    const legs = v.map((l) => ({ ...l, expiry: l?.expiry ?? (DATE_RE.test(e ?? "") ? e : null) }));
    const held = legs.every((l) => num(l?.entry) !== null && l?.entryTag === "avg");
    if (held || !out[u]?.length) {
      out[u] = legs.slice(0, MAX_LEGS);
      continue;
    }
    const cur = [...out[u]];
    for (const l of legs) {
      const same = cur.find((c) => (c.kind ?? "OPT") === (l.kind ?? "OPT") && c.right === l.right && c.strike === l.strike && c.side === l.side && (c.expiry ?? e) === l.expiry && num(c.entry) === null && num(l.entry) === null && (c.kind !== "FUT" || c.symbol === l.symbol));
      if (same) same.lots = (num(same.lots) ?? 1) + (num(l.lots) ?? 1);
      else if (cur.length < MAX_LEGS) cur.push(l);
    }
    out[u] = cur;
  }
  return out;
}
/** The back month for a calendar: the first listed expiry ≥ minDays after the front, else the next listed one. */
export function backExpiry(expiries, front, minDays = 7) {
  const ex = [...new Set((expiries ?? []).filter((e) => DATE_RE.test(e)))].sort();
  const later = ex.filter((e) => e > front);
  if (!later.length) return null;
  const f = Date.parse(`${front}T00:00:00Z`);
  return later.find((e) => Date.parse(`${e}T00:00:00Z`) - f >= minDays * 86400000) ?? later[0];
}
/** The next listed expiry after `e` (null at the end). */
export const nextExpiry = (expiries, e) => [...new Set(expiries ?? [])].sort().find((x) => x > e) ?? null;

const listed = (strikes) => [...new Set((strikes ?? []).filter((k) => num(k) !== null))].sort((a, b) => a - b);
/** Roll a leg's strike one listed step away from spot ("out") or towards it ("in"); null at the edge or when already at spot. */
export function rollStrike(strikes, leg, spot, dir = "out") {
  const ks = listed(strikes);
  const i = ks.indexOf(leg?.strike);
  const S = num(spot);
  if (i < 0 || S === null) return null;
  let away = leg.strike > S ? 1 : leg.strike < S ? -1 : leg.right === "CE" ? 1 : -1;
  if (dir === "in") {
    if (leg.strike === S) return null;
    away = -away;
  }
  const j = i + away;
  return j < 0 || j >= ks.length ? null : ks[j];
}
/**
 * A wing for a sold option (§5.5): the same right `w` steps further out of the money, w = the smallest step count
 * (at least `minSteps`) whose premium is ≤ maxFrac of the short's; the outermost listed strike when none is cheap
 * enough. `priceOf(strike)` gives the wing's premium. Null for a bought leg or a strike outside the list.
 */
export function wingStrike(strikes, leg, priceOf, { maxFrac = 0.25, minSteps = 2 } = {}) {
  const ks = listed(strikes);
  const i = ks.indexOf(leg?.strike);
  if (i < 0 || leg.side !== "SELL" || leg.kind === "FUT") return null;
  const dir = leg.right === "CE" ? 1 : -1;
  const short = num(priceOf?.(leg.strike)) ?? num(leg.price);
  let last = null;
  for (let w = minSteps; ; w += 1) {
    const j = i + dir * w;
    if (j < 0 || j >= ks.length) return last;
    last = ks[j];
    const p = num(priceOf?.(ks[j]));
    if (short === null || (p !== null && p <= maxFrac * short)) return ks[j];
  }
}
/**
 * Delta-neutralise (§5.8): with `deltaUnits` the net delta in units, the futures lots that cancel it (when a future
 * is given) or else ATM options: n = round(−Δ / (|δ_ATM| × lot)), buying a call to add delta and a put to cut it.
 * → { kind: "FUT"|"OPT", side, lots, right?, strike?, after } (after = the delta left, in units) or null when nothing
 * whole is needed.
 */
export function neutraliseDelta({ deltaUnits, lot = 1, fut = null, atm = null } = {}) {
  const d = num(deltaUnits);
  if (d === null) return null;
  if (fut && num(fut.lotSize) > 0) {
    const lots = Math.round(-d / fut.lotSize);
    if (!lots) return null;
    return { kind: "FUT", side: lots > 0 ? "BUY" : "SELL", lots: Math.abs(lots), after: d + lots * fut.lotSize };
  }
  if (!atm || !(num(atm.strike) > 0)) return null;
  const right = d < 0 ? "CE" : "PE";
  const dl = Math.abs(num(right === "CE" ? atm.ceDelta : atm.peDelta) ?? 0.5);
  if (!(dl > 0)) return null;
  const n = Math.round(Math.abs(d) / (dl * lot));
  if (!n) return null;
  return { kind: "OPT", side: "BUY", right, strike: atm.strike, lots: n, after: d + (right === "CE" ? 1 : -1) * n * dl * lot };
}
/**
 * Convert a structure (§5.8): short strangle → iron condor and short straddle → iron fly (wings `w` listed steps
 * outside the shorts), a naked short option → a credit spread (`w` steps further out). → { name, legs } (the whole new
 * draft) or null when the draft is none of these.
 */
export function convertStructure(legs, strikes, { w = 2 } = {}) {
  const ks = listed(strikes);
  const act = (legs ?? []).filter((l) => l && l.on !== false);
  const opts = act.filter((l) => !isFut(l));
  if (opts.length !== act.length || !opts.length) return null;
  const out = (l, steps) => {
    const i = ks.indexOf(l.strike);
    if (i < 0) return null;
    const j = Math.max(0, Math.min(ks.length - 1, i + (l.right === "CE" ? steps : -steps)));
    return j === i ? null : ks[j];
  };
  const wing = (l) => {
    const k = out(l, w);
    return k === null ? null : { kind: "OPT", right: l.right, strike: k, side: "BUY", lots: l.lots, expiry: l.expiry ?? null, symbol: null, lotSize: l.lotSize ?? null };
  };
  if (opts.length === 1 && opts[0].side === "SELL") {
    const b = wing(opts[0]);
    return b ? { name: opts[0].right === "CE" ? "Bear call spread" : "Bull put spread", legs: [...legs, b] } : null;
  }
  if (opts.length === 2 && opts.every((l) => l.side === "SELL") && opts[0].right !== opts[1].right && opts[0].lots === opts[1].lots && opts[0].expiry === opts[1].expiry) {
    const ce = opts.find((l) => l.right === "CE");
    const pe = opts.find((l) => l.right === "PE");
    if (pe.strike > ce.strike) return null;
    const a = wing(pe);
    const b = wing(ce);
    if (!a || !b) return null;
    return { name: pe.strike === ce.strike ? "Iron fly" : "Iron condor", legs: [a, ...legs, b] };
  }
  return null;
}

const shortNum = (k) => formatInt(Math.round(k));
/**
 * A draft's name (§5.9): calendars and diagonals by their expiries, else detectStructure, with the strikes:
 * "Iron condor 25800/26000/26850/27050", "Long calendar (call) 26000", "Custom 3-leg".
 */
export function strategyName(legs) {
  const act = (legs ?? []).filter((l) => l && l.on !== false);
  if (!act.length) return "New strategy";
  const opts = act.filter((l) => !isFut(l));
  const ks = [...new Set(opts.map((l) => l.strike))].sort((a, b) => a - b);
  const tail = ks.length ? ` ${ks.map(shortNum).join("/")}` : "";
  const exps = new Set(opts.map((l) => l.expiry).filter(Boolean));
  if (exps.size > 1 && opts.length === act.length) {
    const sameLots = opts.every((l) => l.lots === opts[0].lots);
    const pairs = ["CE", "PE"].map((r) => opts.filter((l) => l.right === r)).filter((p) => p.length);
    const kindOf = (p) => (p.length === 2 && p[0].expiry !== p[1].expiry && p[0].side !== p[1].side ? (p[0].strike === p[1].strike ? "calendar" : "diagonal") : null);
    const kinds = pairs.map(kindOf);
    if (sameLots && kinds.every(Boolean)) {
      const far = (p) => (p[0].expiry > p[1].expiry ? p[0] : p[1]);
      const long = pairs.every((p) => far(p).side === "BUY");
      if (pairs.length === 2) return `${long ? "Double" : "Short double"} ${kinds.includes("diagonal") ? "diagonal" : "calendar"}${tail}`;
      const r = pairs[0][0].right === "CE" ? "call" : "put";
      return kinds[0] === "calendar" ? `${long ? "Long" : "Short"} calendar (${r})${tail}` : `Diagonal (${r})${tail}`;
    }
    return `Custom ${formatInt(act.length)}-leg`;
  }
  const st = detectStructure(act.map((l) => ({ kind: l.kind, right: l.right, strike: l.strike, q: (l.side === "SELL" ? -1 : 1) * Math.max(1, num(l.lots) ?? 1) })));
  if (/^Custom/.test(st.name)) {
    if (opts.length === 3 && opts.every((l) => l.right === opts[0].right) && ks.length === 3) {
      const mid = opts.find((l) => l.strike === ks[1]);
      if (mid && mid.lots === 2 * opts.find((l) => l.strike === ks[0]).lots) return `${mid.side === "SELL" ? "Long" : "Short"} ${mid.right === "CE" ? "call" : "put"} butterfly${tail}`;
    }
    return `Custom ${formatInt(act.length)}-leg`;
  }
  return `${st.name}${st.name.includes("future") ? "" : tail}`;
}

/** The view a target price implies (§5.7): beyond ±0.25 of the expected move from spot is directional. */
export function inferView(target, spot, move) {
  const T = num(target);
  const S = num(spot);
  const m = num(move) ?? 0;
  if (T === null || S === null) return "neutral";
  if (T > S + 0.25 * m) return "bull";
  if (T < S - 0.25 * m) return "bear";
  return "neutral";
}
/**
 * Candidate strategies for a view (§5.7): every preset of the group (futures presets and ratio back spreads are
 * skipped; calendars only with `back`), at spread widths of 1–4 strike steps and anchors shifted 0, ±1, ±2 steps
 * from the strike nearest the target (directional) or the forward (neutral). De-duplicated, at most `cap`.
 * → [{ id, name, risk, legs }] with legs { right, strike, side, lots, expiry? }.
 */
export function suggestCandidates(chain, { target, spot = null, forward = null, move = null, group = null, back = null, cap = 400 } = {}) {
  const rows = chain?.rows ?? [];
  if (!rows.length) return [];
  const ks = listed(rows.map((r) => r.strike));
  const step = ks.length > 1 ? Math.min(...ks.slice(1).map((k, i) => k - ks[i]).filter((d) => d > 0)) : 50;
  const F = num(forward) ?? num(spot) ?? num(chain.underlyingLtp);
  const g = group ?? inferView(target, spot ?? F, move);
  const anchor0 = g === "neutral" ? F : num(target) ?? F;
  const near = (x) => ks.reduce((b, k) => (Math.abs(k - x) < Math.abs(b - x) ? k : b), ks[0]);
  const presets = PRESETS.filter((p) => p.group === g && !p.needsFut && !/ratio|synthetic/.test(p.id) && (!p.multi || back));
  const out = [];
  const seen = new Set();
  for (const p of presets) {
    for (const wk of [1, 2, 3, 4]) {
      for (const off of [0, 1, -1, 2, -2]) {
        if (out.length >= cap) return out;
        const a = near(anchor0 + off * step);
        const legs = presetLegs(p.id, { ...chain, atmStrike: a }, { move: 2 * wk * step, forward: a, back });
        if (!legs.length) continue;
        const sig = `${p.id}|${legs.map((l) => `${l.side}${l.right}${l.strike}${l.lots}${l.expiry ?? ""}`).join(",")}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push({ id: p.id, name: p.name, risk: p.risk, legs });
      }
    }
  }
  return out;
}
/**
 * Score one candidate (§5.7): legs priced at mid (LTP fallback) with their row's IV; pnlT = P&L at (target, date)
 * by Black-76 with the ATM IV fallback; capital = max(margin estimate, |max loss|, debit); score = pnlT / capital.
 * `ctx`: { chain, backChain?, lot, forward, spot, ivPct, years (first expiry), backYears?, el (years to the date),
 * target }. Null when a leg cannot be priced.
 */
export function scoreCandidate(cand, ctx) {
  const rowsOf = (e) => (e && ctx.backChain && e === ctx.backChain.expiry ? ctx.backChain : ctx.chain).rows;
  const legs = [];
  for (const l of cand.legs) {
    const row = rowsOf(l.expiry).find((r) => r.strike === l.strike);
    const q = row?.[l.right === "CE" ? "ce" : "pe"];
    const price = mid(q) ?? (num(q?.ltp) > 0 ? num(q.ltp) : null);
    if (price === null) return null;
    const back = l.expiry && ctx.backChain && l.expiry === ctx.backChain.expiry;
    legs.push({ kind: "OPT", right: l.right, strike: l.strike, side: l.side, lots: l.lots, price, iv: num(q?.iv) ?? ctx.ivPct, years: back ? ctx.backYears : ctx.years, expiry: l.expiry ?? null, on: true });
  }
  const basis = (num(ctx.forward) ?? ctx.spot) - ctx.spot;
  const pnlT = valueAt(legs, ctx.target, ctx.lot, null, basis, { el: Math.min(ctx.el, ctx.years) });
  if (pnlT === null) return null;
  const stats = strategyStats(legs, ctx.lot, { forward: ctx.forward, ivPct: ctx.ivPct, years: ctx.years, spot: ctx.spot });
  const margin = marginEstimate(legs, ctx.lot, { forward: ctx.forward, years: ctx.years })?.required ?? null;
  const debit = stats.net < 0 ? -stats.net : 0;
  const capital = Math.max(margin ?? 0, stats.maxLoss !== null ? -Math.min(0, stats.maxLoss) : 0, debit);
  return { ...cand, legs, pnlT, maxLoss: stats.maxLoss, maxProfit: stats.maxProfit, pop: stats.pop, margin, capital, net: stats.net, score: capital > 0 ? pnlT / capital : null };
}
/** Keep the money-makers within the limits and rank them: score, then POP. Top `top`. */
export function rankSuggestions(scored, { risk = "defined", maxCapital = null, top = 6 } = {}) {
  const cap = num(maxCapital);
  return scored
    .filter((c) => c && c.pnlT > 0 && c.score !== null && (cap === null || cap <= 0 || c.capital <= cap) && (risk !== "defined" || (c.risk === "defined" && c.maxLoss !== null)))
    .sort((a, b) => b.score - a.score || (b.pop ?? 0) - (a.pop ?? 0))
    .slice(0, top);
}
/** All of §5.7 at once (the page runs the same steps in idle chunks). */
export function suggestStrategies(chain, view, opts = {}) {
  const cands = suggestCandidates(chain, { target: view.target, spot: view.spot, forward: view.forward, move: view.move, group: view.group ?? null, back: opts.backChain?.expiry ?? null });
  const ctx = { chain, backChain: opts.backChain ?? null, lot: view.lot, forward: view.forward, spot: view.spot, ivPct: view.ivPct, years: view.years, backYears: opts.backYears ?? null, el: view.el ?? view.years, target: view.target };
  return rankSuggestions(cands.map((c) => scoreCandidate(c, ctx)), { risk: view.risk ?? "defined", maxCapital: view.maxCapital ?? null, top: opts.top ?? 6 });
}
