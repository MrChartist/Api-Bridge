/**
 * Option chain column maths (desk.js COLS): the per-leg figures behind the chain's cells (price and volume, market
 * depth, rho, build-up over 1 day / 15 min / 5 min, intrinsic value, theoretical price, quote as % of spot). Pure: no
 * DOM, no fetch, no clock (time comes in as arguments); numbers are formatted by format.js in desk.js, never here.
 *
 * A leg is a chain row's `ce` / `pe` (GET /v1/optionchain): { ltp, bid, ask, bidQty?, askQty?, close, change, oi,
 * oiChange, volume, high?, low?, avgPrice?, prevVolume?, iv, ... }. Every function returns null (shown as a dash) when
 * an input it needs is missing, never an invented 0. Kept out of options.js, which is already large.
 */

import { breakeven, sigmaDistance } from "./options.js";
import { black76, calendarYearDays } from "./pricing.js";

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
/** A positive figure, else null (a 0 price, size, close or average is "none", not a value of zero). */
const pos = (v) => (num(v) !== null && Number(v) > 0 ? Number(v) : null);

// ── Price and volume ──

/** LTP change in rupees: LTP − previous close (a close of 0 is no baseline); null without a baseline. */
export function ltpChange(leg) {
  const ltp = num(leg?.ltp);
  const close = pos(leg?.close);
  if (ltp !== null && close !== null) return ltp - close;
  return close === null && num(leg?.close) === null ? num(leg?.change) : null;
}

/** LTP change as % of the previous close; null without a close above 0. */
export function ltpChangePct(leg) {
  const ch = ltpChange(leg);
  const close = pos(leg?.close);
  return ch === null || close === null ? null : (ch / close) * 100;
}

/** Today's high, never below the live LTP: max(day high, LTP). Null without a day high (0 counts as none). */
export function dayHigh(leg) {
  const h = pos(leg?.high);
  const ltp = pos(leg?.ltp);
  return h === null ? null : ltp === null ? h : Math.max(h, ltp);
}

/** Today's low, never above the live LTP: min(day low, LTP). Null without a day low (0 counts as none). */
export function dayLow(leg) {
  const l = pos(leg?.low);
  const ltp = pos(leg?.ltp);
  return l === null ? null : ltp === null ? l : Math.min(l, ltp);
}

/** Where the LTP sits in the day's range, 0 (at the low) to 1 (at the high); null without a range. */
export function rangePosition(leg) {
  const h = dayHigh(leg);
  const l = dayLow(leg);
  const ltp = pos(leg?.ltp);
  return h === null || l === null || ltp === null || h <= l ? null : (ltp - l) / (h - l);
}

/** Volume ÷ open interest (both in contracts): contracts traded for every contract still open. Null without OI > 0. */
export function volumeOiRatio(leg) {
  const v = num(leg?.volume);
  const oi = num(leg?.oi);
  return v === null || oi === null || oi <= 0 ? null : v / oi;
}

// ── Market depth ──

/** A positive price, else null (a 0 bid or ask is "no quote", not a price of zero). */
export const quotePrice = (v) => pos(v);

/** A positive quantity at the touch, else null. */
export const quoteQty = (v) => pos(v);

/**
 * Bid-ask spread in rupees: ask − bid, what crossing the book costs per unit. With no bid it is the whole ask (nobody
 * to sell to); null without an ask, or when the ask is not above the bid (locked or crossed quote).
 */
export function spreadAbs(leg) {
  const a = pos(leg?.ask);
  const b = pos(leg?.bid);
  if (a === null) return null;
  if (b === null) return a;
  return a > b ? a - b : null;
}

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
 * expiry) the ATM IV: there is never a theoretical price on a guessed volatility.
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

/**
 * Intrinsic value against the displayed spot: call max(0, spot − strike), put max(0, strike − spot). Out of the money
 * it is a real 0.00. Null without spot or strike.
 */
export function intrinsicValue(strike, right, spot) {
  const K = num(strike);
  const S = num(spot);
  if (K === null || S === null) return null;
  return Math.max(0, right === "CE" ? S - K : K - S);
}

/** The expiry breakeven (CE K + premium, PE K − premium) as a % move from spot: (BE − spot) ÷ spot × 100. */
export function breakevenPct(strike, right, premium, spot) {
  const P = pos(premium);
  const be = P === null ? null : breakeven(strike, right, P);
  const S = num(spot);
  return be === null || S === null || S <= 0 ? null : ((be - S) / S) * 100;
}

/** Relative distance: (strike − spot) ÷ spot × 100, negative below spot (both sides alike). Null without spot. */
export function relativeDistance(strike, spot) {
  const K = num(strike);
  const S = num(spot);
  return K === null || S === null || S <= 0 ? null : ((K - S) / S) * 100;
}

/**
 * The same distance in standard deviations to expiry at ATM IV: ln(K/F) for a call, ln(F/K) for a put, over σ√T.
 * Positive out of the money. Null at expiry, or without the ATM IV.
 */
export const sigmaDist = (strike, right, forward, atmIvPct, years) => sigmaDistance(strike, right, forward, atmIvPct, years);

// ── Quote as % of spot ──

/** A quote price as % of spot: price ÷ spot × 100 (the premium per rupee of the underlying). Null without either. */
export function pctOfSpot(price, spot) {
  const p = pos(price);
  const S = pos(spot);
  return p === null || S === null ? null : (p / S) * 100;
}

/** Whole calendar days to expiry for annualising: max(1, round(Tcal × days in a year)); null without Tcal. */
export function annualDays(tcal) {
  const T = num(tcal);
  return T === null || T < 0 ? null : Math.max(1, Math.round(T * calendarYearDays()));
}

/** A % annualised by simple scaling: pct × days in a year ÷ days to expiry (annualDays). Null without either. */
export function annualisedPct(pct, tcal) {
  const p = num(pct);
  const d = annualDays(tcal);
  return p === null || d === null ? null : (p * calendarYearDays()) / d;
}

// ── Build-up: one rule for every window ──

/**
 * The windows: the floors both moves must reach (|OI change %| and |premium change %|; exactly on the floor passes),
 * the strength anchors (premium, OI) and, for the minute windows, the snapshot tolerance around the mark.
 */
export const BUILDUP_WINDOWS = Object.freeze({
  day: Object.freeze({ label: "1 day", oiFloor: 2, pxFloor: 0.5, pxAnchor: 18, oiAnchor: 15, minutes: null, toleranceMs: null }),
  15: Object.freeze({ label: "15 min", oiFloor: 1, pxFloor: 0.5, pxAnchor: 5, oiAnchor: 4, minutes: 15, toleranceMs: 150_000 }),
  5: Object.freeze({ label: "5 min", oiFloor: 1, pxFloor: 0.5, pxAnchor: 3, oiAnchor: 2.5, minutes: 5, toleranceMs: 90_000 }),
});
/** Names by code; NT = neutral (both moves measured, one inside its floor). */
export const BUILDUP_LABELS = Object.freeze({ LB: "Long build-up", SB: "Short build-up", SC: "Short covering", LU: "Long unwinding", NT: "Neutral" });
/** Sort order by meaning (a call's reading from up to down): LB, SC, Neutral, LU, SB. */
export const BUILDUP_RANK = Object.freeze({ LB: 4, SC: 3, NT: 2, LU: 1, SB: 0 });

/**
 * Classify one leg over one window from its two ends: { px0, px } premium then and now, { oi0, oi } open interest then
 * and now. Rule: (1) a new strike (OI then exactly 0, OI now above 0): the premium alone decides, up LB, down SB,
 * unchanged neutral, no floor. (2) Otherwise both |OI %| and |premium %| must reach the window's floors, else neutral.
 * (3) The two signs name it: premium up and OI up LB, up and down SC, down and up SB, down and down LU.
 * Returns { code, dPx, dOi, pxPct, oiPct, isNew, conviction } or null when an end is missing (cannot measure).
 * `conviction` (0..1) = 0.72 √(p·o) + 0.28 min(p, o), p = |px%| ÷ (|px%| + px anchor), o likewise for OI.
 */
export function classifyBuildup({ px0, px, oi0, oi }, win = "day") {
  const w = BUILDUP_WINDOWS[win] ?? BUILDUP_WINDOWS.day;
  const a = num(px0);
  const b = num(px);
  const o0 = num(oi0);
  const o1 = num(oi);
  if (a === null || b === null || o0 === null || o1 === null || a <= 0 || o0 < 0) return null;
  const dPx = b - a;
  const dOi = o1 - o0;
  const pxPct = (dPx / a) * 100;
  const isNew = o0 === 0 && o1 > 0;
  const oiPct = o0 > 0 ? (dOi / o0) * 100 : null;
  const p = Math.abs(pxPct) / (Math.abs(pxPct) + w.pxAnchor);
  const o = oiPct === null ? (isNew ? 1 : 0) : Math.abs(oiPct) / (Math.abs(oiPct) + w.oiAnchor);
  const conviction = 0.72 * Math.sqrt(p * o) + 0.28 * Math.min(p, o);
  const out = (code) => ({ code, dPx, dOi, pxPct, oiPct, isNew, conviction: code === "NT" ? 0 : conviction });
  if (isNew) return out(dPx > 0 ? "LB" : dPx < 0 ? "SB" : "NT");
  if (o0 === 0) return out("NT");
  if (Math.abs(oiPct) < w.oiFloor || Math.abs(pxPct) < w.pxFloor || dOi === 0 || dPx === 0) return out("NT");
  if (dOi > 0) return out(dPx > 0 ? "LB" : "SB");
  return out(dPx > 0 ? "SC" : "LU");
}

/**
 * The 1-day ends of a leg: premium from the previous close (or LTP − change), OI from OI − change. With a windowed
 * chain (`change` / `oiChange` over a recorded window) pass that leg; null ends mean "no baseline".
 */
export function dayEnds(leg) {
  const px = num(leg?.ltp);
  const ch = num(leg?.change);
  const close = pos(leg?.close);
  const oi = num(leg?.oi);
  const oiCh = num(leg?.oiChange);
  return { px, px0: close ?? (px !== null && ch !== null ? px - ch : null), oi, oi0: oi !== null && oiCh !== null ? oi - oiCh : null };
}

/** Reading the 1-day build-up of a leg: { state: "ok", ...classifyBuildup } or { state: "no-baseline" | "cannot-measure" }. */
export function dayBuildup(leg, win = "day") {
  const e = dayEnds(leg);
  if (e.oi0 === null || e.px0 === null) return { state: "no-baseline" };
  const r = classifyBuildup(e, win);
  return r ? { state: "ok", ...r } : { state: "cannot-measure" };
}

/**
 * The baseline snapshot for a minute window, once per refresh: the stored snapshot nearest the mark (now − window)
 * that lies within the window's tolerance; never a wider window. `now` is the clock the caller reads (the feed's time
 * while live, else the last snapshot taken in market hours) and `live` says whether it is running.
 * Returns { state, win, t?, snap?, at?, waitMs? }:
 *  ok (snap found; `at` maps strike → index), no-snapshots (nothing stored), warming (history younger than the window
 *  on a running clock; waitMs until it fills), not-enough-history (the same on a stopped clock), gap (history spans
 *  the window but nothing lies within the tolerance of the mark).
 * @param {Array<{ t: number, k: number[], co: (number|null)[], po: (number|null)[], cl: (number|null)[], pl: (number|null)[] }>} snaps
 */
export function windowRef(snaps, nowMs, win, { live = true } = {}) {
  const w = BUILDUP_WINDOWS[win];
  if (!w?.minutes || !Number.isFinite(nowMs)) return { state: "no-snapshots", win };
  const list = (Array.isArray(snaps) ? snaps : []).filter((s) => Number.isFinite(s?.t) && Array.isArray(s?.k) && s.t <= nowMs);
  if (!list.length) return { state: "no-snapshots", win };
  const W = w.minutes * 60_000;
  const mark = nowMs - W;
  let first = list[0];
  let best = null;
  for (const s of list) {
    if (s.t < first.t) first = s;
    const d = Math.abs(s.t - mark);
    if (d <= w.toleranceMs && (!best || d < Math.abs(best.t - mark))) best = s;
  }
  if (best) return { state: "ok", win, t: best.t, snap: best, at: new Map(best.k.map((k, i) => [k, i])) };
  if (first.t > mark + w.toleranceMs) {
    const waitMs = first.t + W - w.toleranceMs - nowMs;
    return live ? { state: "warming", win, waitMs: Math.max(0, waitMs) } : { state: "not-enough-history", win };
  }
  return { state: "gap", win };
}

/**
 * A minute-window reading for one leg: { state: "ok", ...classifyBuildup } when the window's baseline holds this strike
 * with an OI and a traded price; { state: "cannot-measure" } when it does not; the window's own state otherwise.
 */
export function windowBuildup(leg, ref, strike, side) {
  if (!ref || ref.state !== "ok") return { state: ref?.state ?? "no-snapshots", waitMs: ref?.waitMs };
  const i = ref.at.get(strike);
  if (i === undefined || !leg) return { state: "cannot-measure" };
  const p = side === "ce" ? "c" : "p";
  const oi0 = num(ref.snap[`${p}o`]?.[i]);
  const px0 = pos(ref.snap[`${p}l`]?.[i]);
  const r = oi0 === null || px0 === null ? null : classifyBuildup({ px0, px: leg.ltp, oi0, oi: leg.oi }, ref.win);
  return r ? { state: "ok", ...r } : { state: "cannot-measure" };
}

/** Plain words for a reading's state (the card title and the facts). */
export const BUILDUP_STATE_TEXT = Object.freeze({
  "no-baseline": "No baseline: the data source sent no previous-close open interest for this contract",
  "cannot-measure": "Cannot measure this strike: it had no open interest or no traded price at the baseline",
  warming: "Warming up: this page has not recorded for the whole window yet; it fills by itself",
  "not-enough-history": "Not enough history: the recording is shorter than the window and the market clock has stopped",
  "no-snapshots": "No snapshots stored: this page records the chain once a minute while it is open",
  gap: "Snapshot gap: no recording lies close enough to the start of the window",
});

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
 * The build-up card's tint depth (0..1 of the deepest): 0.68 × conviction + 0.32 × bar share, so a strike with large
 * moves reads loud even with a short bar. 0 for neutral or no reading.
 */
export function buildupIntensity(reading, max) {
  if (!reading || reading.code === "NT" || !(num(reading.conviction) > 0)) return 0;
  const share = num(max) > 0 ? Math.min(1, Math.abs(num(reading.dOi) ?? 0) / max) : 0;
  return Math.min(1, 0.68 * reading.conviction + 0.32 * share);
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

/** OI at the previous close: max(0, OI − change); null without the change (no baseline). */
export function prevOi(leg) {
  const oi = num(leg?.oi);
  const ch = num(leg?.oiChange);
  return oi === null || ch === null ? null : Math.max(0, oi - ch);
}

/** OI change as % of the previous close's OI; null without a baseline or when it was 0 (a new strike). */
export function oiChangePctOf(leg) {
  const p = prevOi(leg);
  const ch = num(leg?.oiChange);
  return p === null || ch === null || p <= 0 ? null : (ch / p) * 100;
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

// ── Greeks: three different dashes ──

/**
 * How a Greek cell reads: "value" (a figure), "zero" (exactly 0: a plain dash, except Delta which prints 0.00),
 * "unavailable" (no IV or no Greek for this leg: a muted dash). Theor uses "unavailable" when it has no model price.
 */
export function greekState(key, value) {
  const v = num(value);
  if (v === null) return "unavailable";
  if (v === 0 && key !== "delta") return "zero";
  return "value";
}
