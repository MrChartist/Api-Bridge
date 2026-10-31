/**
 * Option chain column maths (desk.js COLS): the per-leg figures behind the extra columns Customise can add (price and
 * volume, market depth, rho, 5 / 15 minute build-up, intrinsic value, theoretical price, premium yield). Pure: no DOM,
 * no fetch, no clock (time comes in as arguments); numbers are formatted by format.js in desk.js, never here.
 *
 * A leg is a chain row's `ce` / `pe` (GET /v1/optionchain): { ltp, bid, ask, bidQty?, askQty?, close, change, oi,
 * volume, high?, low?, avgPrice?, prevVolume?, iv, ... }. Every function returns null (shown as a dash) when an input
 * it needs is missing, never 0. Kept out of options.js, which is already large.
 */

import { breakeven, buildup, sigmaDistance, twoSided } from "./options.js";
import { black76, calendarYearDays } from "./pricing.js";

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// ── Price and volume ──

/** LTP change in rupees: LTP − previous close, else the chain's own `change`; null without either. */
export function ltpChange(leg) {
  const ltp = num(leg?.ltp);
  const close = num(leg?.close);
  if (ltp !== null && close !== null && close > 0) return ltp - close;
  return num(leg?.change);
}

/** Volume ÷ open interest (both in units): how much of the open position traded today. Null without OI > 0. */
export function volumeOiRatio(leg) {
  const v = num(leg?.volume);
  const oi = num(leg?.oi);
  return v === null || oi === null || oi <= 0 ? null : v / oi;
}

// ── Market depth ──

/** Bid-ask spread in rupees (ask − bid) of a two-sided quote; null otherwise. */
export function spreadAbs(leg) {
  return twoSided(leg) ? leg.ask - leg.bid : null;
}

/** A positive price, else null (a 0 bid or ask is "no quote", not a price of zero). */
export const quotePrice = (v) => (num(v) !== null && Number(v) > 0 ? Number(v) : null);

/** A positive quantity at the touch, else null. */
export const quoteQty = (v) => (num(v) !== null && Number(v) > 0 ? Number(v) : null);

// ── Model figures (Black-76 on the forward, as the chain's IV and Greeks) ──

/**
 * Black-76 rho per 1 percentage point of interest rate, the forward held fixed: the option's value is
 * df × Black-76(F, K, T, σ), so ∂V/∂r = −Tcal × V, and per point −Tcal × V / 100 (₹ per unit). `years` is vol-time T
 * (inside σ√T), `tcal` calendar years (interest), `df` the discount factor. 0 at or after expiry; null without an IV
 * before it.
 */
export function rho76(forward, strike, years, ivPct, right, tcal, df = 1) {
  const T = num(tcal);
  if (T === null || T < 0) return null;
  if (T === 0 || !(num(years) > 0)) return num(forward) === null || num(strike) === null ? null : 0;
  if (!(num(ivPct) > 0)) return null;
  const p = black76(forward, strike, years, ivPct, right);
  const d = num(df) ?? 1;
  return p === null ? null : (-T * p * d) / 100;
}

/**
 * Theoretical price: Black-76 on the chain's forward at the chain's ATM IV (one volatility for every strike, not the
 * leg's own IV), discounted by `df`. The gap to the market price is the smile: what the market charges over or under
 * a flat volatility. At or after expiry: intrinsic on the forward. Null without the forward, the strike or (before
 * expiry) the ATM IV.
 */
export function theoPrice(forward, strike, years, atmIvPct, right, df = 1) {
  const F = num(forward);
  const K = num(strike);
  if (F === null || K === null || K <= 0) return null;
  const d = num(df) ?? 1;
  if (!(num(years) > 0)) return Math.max(0, right === "CE" ? F - K : K - F) * d;
  if (!(num(atmIvPct) > 0)) return null;
  const p = black76(F, K, years, atmIvPct, right);
  return p === null ? null : p * d;
}

/** Intrinsic value on the forward: CE max(0, F − K), PE max(0, K − F). With Time value it adds up to the premium. */
export function intrinsicValue(strike, right, forward) {
  const K = num(strike);
  const F = num(forward);
  if (K === null || F === null) return null;
  return Math.max(0, right === "CE" ? F - K : K - F);
}

/** The expiry breakeven (CE K + premium, PE K − premium) as a % move from spot: (BE − spot) ÷ spot × 100. */
export function breakevenPct(strike, right, premium, spot) {
  const be = breakeven(strike, right, premium);
  const S = num(spot);
  return be === null || S === null || S <= 0 ? null : ((be - S) / S) * 100;
}

/**
 * Strike distance in standard deviations to expiry at ATM IV: ln(K/F) for a call, ln(F/K) for a put, over σ√T.
 * Positive out of the money, negative in it. Null on expiry day after the close, or without the ATM IV.
 */
export const relativeDistance = (strike, right, forward, atmIvPct, years) => sigmaDistance(strike, right, forward, atmIvPct, years);

// ── Premium yield ──

/** A price as % of the strike: the premium a writer collects per rupee of strike at the bid (or pays at the ask). */
export function pctOfStrike(price, strike) {
  const p = quotePrice(price);
  const K = num(strike);
  return p === null || K === null || K <= 0 ? null : (p / K) * 100;
}

/**
 * A yield annualised by calendar time to expiry (simple, ACT/365 through pricing.js calendarYearDays): pct ÷ Tcal.
 * Null with less than one calendar day left (expiry day: a one-day yield scaled to a year says nothing).
 */
export function annualisedPct(pct, tcal) {
  const p = num(pct);
  const T = num(tcal);
  if (p === null || T === null || T * calendarYearDays() < 1) return null;
  return p / T;
}

// ── 5 / 15 minute build-up (from the OI snapshots this browser records, oi-store.js) ──

/**
 * The snapshot to compare against for a `minutes` window: the latest one taken at least `minutes` ago and no more
 * than 1.5 × `minutes` ago (snapshots come at most once a minute; an older one would stretch the window). Returns
 * { t, snap, at: Map(strike → index) } once per refresh, so a cell reads two array slots; null when there is none.
 * @param {Array<{ t: number, k: number[], co: (number|null)[], po: (number|null)[], cl: (number|null)[], pl: (number|null)[] }>} snaps
 */
export function windowRef(snaps, nowMs, minutes) {
  const W = num(minutes) * 60_000;
  if (!(W > 0) || !Number.isFinite(nowMs) || !Array.isArray(snaps)) return null;
  let best = null;
  for (const s of snaps) {
    if (!Number.isFinite(s?.t) || !Array.isArray(s.k)) continue;
    const age = nowMs - s.t;
    if (age >= W && age <= 1.5 * W && (!best || s.t > best.t)) best = s;
  }
  if (!best) return null;
  return { t: best.t, snap: best, at: new Map(best.k.map((k, i) => [k, i])) };
}

/**
 * Build-up over a window (windowRef): price change = LTP now − LTP then, OI change = OI now − OI then, classified like
 * options.js buildup (LB price up OI up, SB down up, SC up down, LU down down). { code, dPx, dOi }, or null when the
 * strike or either figure is missing at either end, or either change is zero.
 */
export function windowBuildup(leg, ref, strike, side) {
  if (!ref || !leg) return null;
  const i = ref.at.get(strike);
  if (i === undefined) return null;
  const p = side === "ce" ? "c" : "p";
  const oi0 = num(ref.snap[`${p}o`]?.[i]);
  const px0 = num(ref.snap[`${p}l`]?.[i]);
  const oi = num(leg.oi);
  const px = num(leg.ltp);
  if (oi0 === null || px0 === null || oi === null || px === null) return null;
  const dPx = px - px0;
  const dOi = oi - oi0;
  const code = buildup({ change: dPx, oiChange: dOi });
  return code ? { code, dPx, dOi, pct: oi0 > 0 ? (dOi / oi0) * 100 : null } : null;
}

// ── Cell shapes (desk.js bu / oi / vol renderers): the split of a bar or a meter, so the drawing stays one line ──

/** Ticks of a `n`-tick strength meter filled by |value| ÷ max: at least 1 for a non-zero value, null without one. */
export function strengthTicks(value, max, n = 10) {
  const v = num(value);
  const m = num(max);
  if (v === null || m === null || m <= 0) return null;
  const f = Math.min(1, Math.abs(v) / m);
  return f > 0 ? Math.max(1, Math.round(f * n)) : 0;
}

/**
 * The OI bar's two layers on the chain's scale (`max` = largest OI, both sides), both anchored at the strike side:
 * `solid` = the OI both days share, `outer` = where the striped part ends. OI added today: solid = previous OI
 * (OI − change), striped up to today's OI (kind "add"). OI cut: solid = today's OI, a striped ghost up to the previous
 * OI (kind "cut"). No change known: one solid bar (kind null). Fractions are clamped to 0..1; null without OI or scale.
 */
export function oiBarSplit(oi, change, max) {
  const o = num(oi);
  const m = num(max);
  if (o === null || m === null || m <= 0) return null;
  const c = num(change);
  const clamp = (v) => Math.max(0, Math.min(1, v / m));
  if (c === null || c === 0) return { solid: clamp(o), outer: clamp(o), kind: null };
  const prev = Math.max(0, o - c);
  return c > 0 ? { solid: clamp(prev), outer: clamp(o), kind: "add" } : { solid: clamp(o), outer: clamp(prev), kind: "cut" };
}

/** Today's volume minus the previous session's; null when either is missing (never a 0 for "unknown"). */
export function volumeChange(volume, prevVolume) {
  const v = num(volume);
  const p = num(prevVolume);
  return v === null || p === null ? null : v - p;
}

/**
 * The volume bar's two tones on one track (`max` = the chain's largest of today's and the previous session's volume):
 * { today, prev } fractions; `prev` null when the quote has no previous volume. Null without today's volume or scale.
 */
export function volBarSplit(volume, prevVolume, max) {
  const v = num(volume);
  const m = num(max);
  if (v === null || m === null || m <= 0) return null;
  const p = num(prevVolume);
  const clamp = (x) => Math.max(0, Math.min(1, x / m));
  return { today: clamp(v), prev: p === null ? null : clamp(p) };
}
