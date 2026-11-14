/**
 * The pricing core, used by server/bridge (market, vol, demo). Pure: no DOM, no fetch, no session literals; callers
 * pass the clock context.
 *
 * One implementation of: the normal CDF/PDF, Black-76 on the forward (price, Greeks, the single IV solver), the leg
 * price basis, the put-call-parity forward, smile points, ATM IV at the forward, IV at a delta, skew metrics, the
 * vol-time clock (weighted / trading / calendar), clock conversion, 30-day constant maturity, IV rank and percentile,
 * same-DTE selection, σ bands and the realised-vol estimators (close-to-close, Parkinson, Yang-Zhang).
 *
 * Conventions: IV is in vol points (percent); rates are decimals; T is in years; clock `units` are trading-day
 * equivalents. Interest (discount factor, parity growth, carry) runs on calendar time `Tcal`; volatility runs on the
 * clock's `T` (only inside σ√T). Nothing here holds a rate or a session time: both come in as arguments.
 *
 * Clock context (from `vol/context.mjs` on the server, or built from GET /v1/vol/clock in the browser):
 *   { mode: "weighted"|"trading"|"calendar", nonTradingDayWeight, overnightShare, eventDays: { "YYYY-MM-DD": m },
 *     yearBasis: number|null, settlementWindowMinutes, session: { open: "HH:MM", close: "HH:MM" },
 *     isTradingDay?: (date) => boolean, holidays?: string[] }   (weekends are never trading days without isTradingDay)
 */

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// ── Normal distribution ──

/** Standard normal CDF (Abramowitz-Stegun 26.2.17, |error| < 7.5e-8). */
export function normCdf(x) {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
/** Standard normal density. */
export const normPdf = (x) => 0.3989422804014327 * Math.exp((-x * x) / 2);

// ── Black-76 on the forward ──

/** Black-76 price of a CE / PE (undiscounted); intrinsic value at or after expiry or without a volatility. */
export function black76(forward, strike, years, ivPct, right) {
  const F = num(forward);
  const K = num(strike);
  const sig = (num(ivPct) ?? 0) / 100;
  if (F === null || K === null || K <= 0) return null;
  // A forward at (or below) 0: the call is worthless, the put is worth its strike.
  if (F <= 0) return right === "CE" ? 0 : K;
  const intrinsic = right === "CE" ? Math.max(0, F - K) : Math.max(0, K - F);
  if (!(years > 0) || !(sig > 0)) return intrinsic;
  const sd = sig * Math.sqrt(years);
  const d1 = (Math.log(F / K) + (sd * sd) / 2) / sd;
  const d2 = d1 - sd;
  return right === "CE" ? F * normCdf(d1) - K * normCdf(d2) : K * normCdf(-d2) - F * normCdf(-d1);
}

/**
 * Black-76 Greeks per unit on the forward: Δ = N(d1) (CE) or N(d1) − 1 (PE); Γ = n(d1)/(F·σ√T); vega per vol
 * point = F·n(d1)·√T / 100; theta = −F·n(d1)·σ / (2√T) per year, divided by `yearBasis` when given (so with the clock's
 * year basis it is the decay of one unit of vol-time: "per trading day"). At or after expiry: Δ 1 / −1 in the money, 0
 * out of it, the rest 0.
 */
export function greeks76(forward, strike, years, ivPct, right, { yearBasis = null } = {}) {
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
  const pdf = normPdf(d1);
  const perYear = -(F * pdf * sig) / (2 * Math.sqrt(years));
  const Y = num(yearBasis);
  return {
    delta: right === "CE" ? normCdf(d1) : normCdf(d1) - 1,
    gamma: pdf / (F * sd),
    theta: Y !== null && Y > 0 ? perYear / Y : perYear,
    vega: (F * pdf * Math.sqrt(years)) / 100,
  };
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

/** One-standard-deviation move of a log-normal price: half the width of the ±1σ band. */
export function sigmaMove(forward, ivPct, years) {
  const F = num(forward);
  const sig = (num(ivPct) ?? 0) / 100;
  if (F === null || !(sig > 0) || !(years > 0)) return null;
  const sd = sig * Math.sqrt(years);
  return (F * Math.exp(sd) - F * Math.exp(-sd)) / 2;
}

/**
 * σ bands and expected move: σ_T = σ·√T; band k = [F·e^(−kσ_T), F·e^(kσ_T)]; move = F·(e^σ_T − e^−σ_T)/2;
 * expected absolute move ≈ √(2/π)·σ·F·√T. Null without inputs.
 */
export function bands(forward, ivPct, years) {
  const F = num(forward);
  const sig = (num(ivPct) ?? 0) / 100;
  if (F === null || F <= 0 || !(sig > 0) || !(years > 0)) return null;
  const sdT = sig * Math.sqrt(years);
  return {
    sdT,
    band1: [F * Math.exp(-sdT), F * Math.exp(sdT)],
    band2: [F * Math.exp(-2 * sdT), F * Math.exp(2 * sdT)],
    move: (F * Math.exp(sdT) - F * Math.exp(-sdT)) / 2,
    eam: Math.sqrt(2 / Math.PI) * sdT * F,
  };
}

/**
 * THE implied-volatility function (percent) of a discounted Black-76 price: solves df·Black76(F, K, T, σ) = price by
 * Newton on vega from the Brenner–Subrahmanyam seed, falling back to bisection on [0.5 %, 500 %] whenever a step leaves
 * the bracket. Null when price ≤ 0, below df·intrinsic − 0.025, at or above df·F (CE) / df·K (PE), T ≤ 0, or no root.
 */
export function impliedVolB76(price, forward, strike, years, right, df = 1) {
  const P = num(price);
  const F = num(forward);
  const K = num(strike);
  const D = num(df) ?? 1;
  if (P === null || F === null || K === null || F <= 0 || K <= 0 || !(years > 0) || !(P > 0) || !(D > 0)) return null;
  const intrinsic = right === "CE" ? Math.max(0, F - K) : Math.max(0, K - F);
  if (P < D * intrinsic - 0.025) return null;
  if (P >= D * (right === "CE" ? F : K)) return null;
  const target = P / D;
  const rt = Math.sqrt(years);
  const f = (s) => black76(F, K, years, s * 100, right) - target;
  let lo = 0.005;
  let hi = 5;
  if (f(lo) > 0 || f(hi) < 0) return null;
  let s = Math.min(2, Math.max(0.05, (Math.sqrt((2 * Math.PI) / years) * target) / F));
  for (let i = 0; i < 60; i++) {
    const v = f(s);
    if (Math.abs(v) < 1e-12 * F) return s * 100;
    if (v > 0) hi = s;
    else lo = s;
    const sd = s * rt;
    const vega = F * normPdf((Math.log(F / K) + (sd * sd) / 2) / sd) * rt;
    let next = vega > 1e-14 ? s - v / vega : Number.NaN;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    if (Math.abs(next - s) < 1e-9) return next * 100;
    s = next;
  }
  return hi - lo < 1e-6 ? s * 100 : null;
}

/** Black-76 forward delta at `ivPct`: N(d1) for a CE, N(d1) − 1 for a PE; null without a volatility or time. */
export function b76Delta(forward, strike, years, ivPct, right) {
  const F = num(forward);
  const K = num(strike);
  const sig = (num(ivPct) ?? 0) / 100;
  if (F === null || K === null || F <= 0 || K <= 0 || !(years > 0) || !(sig > 0)) return null;
  const sd = sig * Math.sqrt(years);
  const n = normCdf((Math.log(F / K) + (sd * sd) / 2) / sd);
  return right === "CE" ? n : n - 1;
}

// ── Prices, forward, smile ──

/**
 * The price a vol figure reads from one leg. `basis` "mid": the bid–ask mid when two-sided (q "wide" when the spread
 * is over 10 % of it), else the LTP (q "ltp"); "ltp": always the LTP. { price: null, q: "none" } without either.
 * @returns {{ price: number|null, q: "mid"|"wide"|"ltp"|"none" }}
 */
export function legPrice(leg, basis = "mid") {
  if (basis !== "ltp") {
    const b = num(leg?.bid);
    const a = num(leg?.ask);
    if (b !== null && a !== null && b > 0 && a >= b) {
      const price = (a + b) / 2;
      return { price, q: ((a - b) / price) * 100 > 10 ? "wide" : "mid" };
    }
  }
  const l = num(leg?.ltp);
  return l !== null && l > 0 ? { price: l, q: "ltp" } : { price: null, q: "none" };
}

const twoSidedMid = (leg) => {
  const p = legPrice(leg, "mid");
  return p.q === "mid" || p.q === "wide" ? p.price : null;
};

/**
 * The parity forward: F_k = K + e^(r·Tcal)·(C_mid − P_mid) for the `strikes` (5) strikes nearest spot with both
 * legs two-sided (bid > 0, ask ≥ bid); F = the median. Without spot (and no atmStrike) the strikes are centred on the
 * two-sided strike with the smallest |C − P| (the one nearest the forward), so a chain with no underlying price still
 * gets a parity forward. Spot when no strike qualifies (source "spot"); { F: null } with neither.
 * `Tcal` is calendar time (interest accrues on calendar days).
 * @returns {{ F: number|null, source: "parity"|"spot"|null, strikes: number, values: { strike: number, F: number }[] }}
 */
export function parityForward(chain, { rate = 0, Tcal = 0, strikes = 5 } = {}) {
  const spot = num(chain?.underlyingLtp);
  const growth = num(Tcal) > 0 ? Math.exp((num(rate) ?? 0) * Tcal) : 1;
  const rows = (chain?.rows ?? []).map((r) => ({ k: num(r?.strike), c: twoSidedMid(r?.ce), p: twoSidedMid(r?.pe) })).filter((r) => r.k !== null && r.c !== null && r.p !== null);
  let centre = spot ?? num(chain?.atmStrike);
  if (centre === null && rows.length) centre = rows.reduce((b, r) => (Math.abs(r.c - r.p) < Math.abs(b.c - b.p) || (Math.abs(r.c - r.p) === Math.abs(b.c - b.p) && r.k < b.k) ? r : b)).k;
  if (rows.length && centre !== null) {
    rows.sort((a, b) => Math.abs(a.k - centre) - Math.abs(b.k - centre) || a.k - b.k);
    const values = rows.slice(0, Math.max(1, strikes)).map((r) => ({ strike: r.k, F: r.k + (r.c - r.p) * growth })).sort((a, b) => a.strike - b.strike);
    const sorted = values.map((v) => v.F).sort((a, b) => a - b);
    const n = sorted.length;
    const F = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    return { F, source: "parity", strikes: n, values };
  }
  return spot !== null ? { F: spot, source: "spot", strikes: 0, values: [] } : { F: null, source: null, strikes: 0, values: [] };
}

/**
 * One leg's IV on the forward: price from `basis`, solved by impliedVolB76 with discount factor `df`.
 * `out` says why there is no IV: "noquote", "tick" (≤ 0.05), "intrinsic", "range" (outside 1–300 %) or "settling"
 * (`settling` true — expiry day inside the settlement window — and the price within 2 ticks of intrinsic on F).
 * @returns {{ price: number|null, q: string, iv: number|null, bidIv: number|null, askIv: number|null,
 *   delta: number|null, out: null|"noquote"|"tick"|"intrinsic"|"range"|"settling" }}
 */
export function legIv(q, forward, strike, right, { years, df = 1, basis = "mid", settling = false, tick = 0.05 } = {}) {
  const F = num(forward);
  const K = num(strike);
  const T = num(years);
  if (!q) return null;
  const p = legPrice(q, basis);
  const ivOf = (v) => (num(v) !== null && v > 0 ? impliedVolB76(v, F, K, T, right, df) : null);
  const bidIv = ivOf(num(q.bid));
  const askIv = ivOf(num(q.ask));
  if (p.price === null) return { price: null, q: p.q, iv: null, bidIv, askIv, delta: null, out: "noquote" };
  const intrinsic = right === "CE" ? Math.max(0, F - K) : Math.max(0, K - F);
  const raw = impliedVolB76(p.price, F, K, T, right, df);
  let out = null;
  if (p.price <= tick) out = "tick";
  else if (settling && Math.abs(p.price - df * intrinsic) <= 2 * tick) out = "settling";
  else if (p.price < df * intrinsic - 0.025) out = "intrinsic";
  else if (raw === null) out = p.price <= df * intrinsic + 0.025 ? "intrinsic" : "range";
  else if (raw < 1 || raw > 300) out = "range";
  const iv = out ? null : raw;
  return { price: p.price, q: p.q, iv, bidIv, askIv, delta: iv === null ? null : b76Delta(F, K, T, iv, right), out };
}

/** The smallest gap between consecutive strikes (the strike step), or null. */
export function strikeStep(strikes) {
  let step = null;
  for (let i = 1; i < strikes.length; i++) {
    const d = strikes[i] - strikes[i - 1];
    if (d > 0 && (step === null || d < step)) step = d;
  }
  return step;
}

/** The least CE/PE IV separation (vol points) that counts as a parity gap. */
const GAP_MIN = 0.1;

/**
 * One point per strike with a leg: IVs with Black-76 on `F` from `basis` prices. Volatility time is `years` (the
 * clock's T); the discount factor is e^(−rate·Tcal) (`Tcal` defaults to `years`). otm = the PE below F, the CE at or
 * above it; `callDelta` = the CE delta at the OTM IV (the smile's delta axis); `gap` = CE and PE IV bands (bid IV–ask
 * IV) do not overlap; `out` = why the OTM point is not drawn.
 */
export function smilePoints(chain, { F, years, rate = 0, Tcal = null, basis = "mid", settling = false } = {}) {
  const Fv = num(F);
  const T = num(years);
  if (Fv === null || Fv <= 0 || !(T > 0)) return [];
  const df = Math.exp(-(num(rate) ?? 0) * (num(Tcal) ?? T));
  const out = [];
  for (const r of [...(chain?.rows ?? [])].sort((a, b) => a.strike - b.strike)) {
    const K = num(r.strike);
    if (K === null || K <= 0 || (!r.ce && !r.pe)) continue;
    const ce = legIv(r.ce, Fv, K, "CE", { years: T, df, basis, settling });
    const pe = legIv(r.pe, Fv, K, "PE", { years: T, df, basis, settling });
    const side = K < Fv ? "pe" : "ce";
    const o = side === "pe" ? pe : ce;
    const otm = o && o.iv !== null ? { side, iv: o.iv, delta: o.delta, q: o.q } : null;
    // A parity gap needs real separation: more than 0.1 vol point and more than one tick's worth of IV.
    const apart = (b, a, aLeg, right) => {
      if (b === null || a === null || b - a <= GAP_MIN) return false;
      const ask = num(aLeg?.ask);
      const tickIv = ask !== null && ask > 0 ? (impliedVolB76(ask + 0.05, Fv, K, T, right, df) ?? a) - a : 0;
      return b - a > Math.max(GAP_MIN, tickIv);
    };
    const gap = Boolean(ce && pe && (apart(ce.bidIv, pe.askIv, r.pe, "PE") || apart(pe.bidIv, ce.askIv, r.ce, "CE")));
    out.push({ strike: K, m: (K / Fv - 1) * 100, ce, pe, otm, callDelta: otm ? b76Delta(Fv, K, T, otm.iv, "CE") : null, gap, out: o ? o.out : "noquote" });
  }
  return out;
}

/** A point's mid IV: the mean of its valid CE and PE IVs (or the one that exists). */
const pointIv = (p) => {
  const v = [p?.ce?.iv, p?.pe?.iv].filter((x) => x !== null && x !== undefined);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/**
 * ATM IV at the forward: linear in strike between the two strikes bracketing F (each strike's CE/PE mean). One side
 * only: the nearest strike when within one strike step, else null.
 */
export function atmIvAt(points, forward) {
  const F = num(forward);
  if (F === null) return null;
  const pts = (points ?? []).map((p) => ({ k: p.strike, iv: pointIv(p) })).filter((p) => p.iv !== null).sort((a, b) => a.k - b.k);
  if (!pts.length) return null;
  const exact = pts.find((p) => p.k === F);
  if (exact) return exact.iv;
  const below = pts.filter((p) => p.k < F).pop() ?? null;
  const above = pts.find((p) => p.k > F) ?? null;
  if (below && above) return below.iv + ((above.iv - below.iv) * (F - below.k)) / (above.k - below.k);
  const step = strikeStep((points ?? []).map((p) => p.strike).sort((a, b) => a - b));
  const one = below ?? above;
  // A lone strike (no step to judge by) counts when it sits within 0.5% of the forward.
  return Math.abs(one.k - F) <= (step ?? 0.005 * F) ? one.iv : null;
}

/**
 * The OTM IV at a forward delta (−0.25 / −0.10 put, 0.25 / 0.10 call): linear in delta between the two OTM points
 * whose deltas bracket the target. `strike` is the point nearest the target. Null without a bracket.
 */
export function ivAtDelta(points, target) {
  const t = num(target);
  if (t === null || t === 0) return null;
  const side = t < 0 ? "pe" : "ce";
  const pts = (points ?? []).filter((p) => p.otm && p.otm.side === side && p.otm.delta !== null && p.otm.iv !== null).sort((a, b) => a.strike - b.strike);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1].otm;
    const b = pts[i].otm;
    if ((a.delta - t) * (b.delta - t) > 0) continue;
    const w = b.delta === a.delta ? 0 : (t - a.delta) / (b.delta - a.delta);
    const near = Math.abs(a.delta - t) <= Math.abs(b.delta - t) ? pts[i - 1] : pts[i];
    return { iv: a.iv + w * (b.iv - a.iv), strike: near.strike };
  }
  return null;
}

/** Skew at fixed deltas. rr = put IV − call IV (put minus call); bf = (put + call)/2 − ATM IV; wing16 = 16Δ IV − ATM IV. */
export function skewMetrics(points, atmIv) {
  const at = (d) => ivAtDelta(points, d);
  const put25 = at(-0.25);
  const call25 = at(0.25);
  const put10 = at(-0.1);
  const call10 = at(0.1);
  const p16 = at(-0.16);
  const c16 = at(0.16);
  const a = num(atmIv);
  const rr = (p, c) => (p && c ? p.iv - c.iv : null);
  const bf = (p, c) => (p && c && a !== null ? (p.iv + c.iv) / 2 - a : null);
  return {
    rr25: rr(put25, call25),
    bf25: bf(put25, call25),
    rr10: rr(put10, call10),
    bf10: bf(put10, call10),
    put25,
    call25,
    put10,
    call10,
    wingPut16: p16 && a !== null ? p16.iv - a : null,
    wingCall16: c16 && a !== null ? c16.iv - a : null,
  };
}

// ── The vol-time clock ──

export const CLOCK_VERSION = "vt1";
export const CLOCK_MODES = Object.freeze(["weighted", "trading", "calendar"]);
/** Trading days in a year, the trading clock's year and the weighted clock's base. */
const TRADING_DAYS = 252;
/** Non-trading days in a calendar year (the weighted clock's year adds them at their weight). */
const NON_TRADING_DAYS = 113;

const IST_MS = 330 * 60_000;
const DAY = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HM_RE = /^(\d{2}):(\d{2})$/;
const dayUtc = (date) => Date.parse(`${date}T00:00:00Z`);
const isoOf = (utc) => new Date(utc).toISOString().slice(0, 10);
const istDateOf = (ms) => isoOf(Math.floor((ms + IST_MS) / DAY) * DAY);
const hmMinutes = (hm) => {
  const m = HM_RE.exec(String(hm ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
/** Epoch ms of `minutes` after IST midnight on `date`. */
const istAtMinutes = (date, minutes) => dayUtc(date) + minutes * 60_000 - IST_MS;

/** Calendar days per year (ACT/365): the one place the calendar year's day count lives (calendar mode, money terms). */
export function calendarYearDays() {
  return 365;
}
/** Calendar time ACT/365: years from `nowMs` to `endMs`, never negative. */
export function calendarYears(nowMs, endMs) {
  return Math.max(0, endMs - nowMs) / DAY / calendarYearDays();
}

/** The clock settings with their defaults filled in (weights are stated assumptions). */
export function clockSettings(ctx = {}) {
  const mode = CLOCK_MODES.includes(ctx?.mode) ? ctx.mode : "weighted";
  const w = num(ctx?.nonTradingDayWeight) ?? 0.15;
  const phi = num(ctx?.overnightShare) ?? 0.2;
  return {
    mode,
    nonTradingDayWeight: w,
    overnightShare: phi,
    eventDays: ctx?.eventDays && typeof ctx.eventDays === "object" ? ctx.eventDays : {},
    yearBasis: num(ctx?.yearBasis),
    settlementWindowMinutes: Math.max(0, num(ctx?.settlementWindowMinutes) ?? 30),
  };
}

/** Units in a clock year: weighted = yearBasis ?? 252 + 113 × w; trading = 252; calendar = 365 (days). */
export function yearBasisOf(ctx = {}, mode = null) {
  const s = clockSettings(ctx);
  const m = mode ?? s.mode;
  if (m === "calendar") return calendarYearDays();
  if (m === "trading") return TRADING_DAYS;
  return s.yearBasis ?? TRADING_DAYS + NON_TRADING_DAYS * s.nonTradingDayWeight;
}

function tradingDayFn(ctx) {
  if (typeof ctx?.isTradingDay === "function") return ctx.isTradingDay;
  const hol = new Set(Array.isArray(ctx?.holidays) ? ctx.holidays.map((h) => (typeof h === "string" ? h : h?.date)) : []);
  return (date) => {
    const wd = new Date(dayUtc(date)).getUTCDay();
    return wd !== 0 && wd !== 6 && !hol.has(date);
  };
}

/**
 * Time to an expiry's settlement on the clock. Each trading day D ≤ expiry contributes a gap block at its open
 * (m_D·φ + Σ w·m_N over the non-trading days N since the previous trading day; only while now is before D's open) and
 * a session block (1 − φ)·m_D spread over its session minutes; on the expiry day the settlement window [close − W,
 * close] counts W/3 before it starts and (B − now)³ / (3·W²) inside it. U is the sum; T = U / Y.
 * Returns the weighted units, the trading-day units (φ = 0, w = 0, Y = 252), calendar T to the expiry close (ACT/365,
 * no window), and T for the context's mode. Null for a bad expiry or a context without a session.
 * @param {object} ctx  clock context (header)
 * @param {number} nowMs
 * @param {string} expiry  YYYY-MM-DD (IST)
 * @param {{ parts?: boolean }} [opts]  parts: also return the blocks [{ date, kind: "gap"|"session", units }]
 * @returns {{ version: string, mode: string, units: number, T: number, Tcal: number, Ttd: number, unitsWeighted: number,
 *   unitsTrading: number, yearBasis: number, settling: boolean, parts?: object[] } | null}
 */
export function volTime(ctx, nowMs, expiry, { parts: wantParts = false } = {}) {
  const s = clockSettings(ctx);
  const open = hmMinutes(ctx?.session?.open);
  const close = hmMinutes(ctx?.session?.close);
  if (!DATE_RE.test(String(expiry ?? "")) || open === null || close === null || !(close > open) || !Number.isFinite(nowMs)) return null;
  const S = close - open;
  const W = Math.min(s.settlementWindowMinutes, S);
  const phi = s.overnightShare;
  const w = s.nonTradingDayWeight;
  const mult = (d) => num(s.eventDays?.[d]) ?? 1;
  const isTrading = tradingDayFn(ctx);
  const today = istDateOf(nowMs);
  const closeE = istAtMinutes(expiry, close);
  const parts = [];
  let weighted = 0;
  let trading = 0;
  let settling = false;
  if (today <= expiry && nowMs < closeE) {
    // Non-trading days between the last trading day before today and today belong to the next open's gap.
    let pending = 0;
    let back = dayUtc(today) - DAY;
    for (let i = 0; i < 40 && !isTrading(isoOf(back)); i++, back -= DAY) pending += w * mult(isoOf(back));
    for (let t = dayUtc(today), end = dayUtc(expiry); t <= end; t += DAY) {
      const D = isoOf(t);
      const m = mult(D);
      if (!isTrading(D)) {
        pending += w * m;
        continue;
      }
      const openMs = istAtMinutes(D, open);
      const gap = phi * m + pending;
      pending = 0;
      if (nowMs < openMs) {
        weighted += gap;
        if (wantParts) parts.push({ date: D, kind: "gap", units: gap });
      }
      const nowMin = nowMs <= openMs ? open : Math.min(close, (nowMs - istAtMinutes(D, 0)) / 60_000);
      let eff;
      if (D === expiry && W > 0) {
        const A = close - W;
        if (nowMin < A) eff = A - nowMin + W / 3;
        else if (nowMin < close) {
          eff = (close - nowMin) ** 3 / (3 * W * W);
          settling = true;
        } else eff = 0;
      } else eff = Math.max(0, close - nowMin);
      const frac = eff / S;
      if (frac > 0) {
        weighted += (1 - phi) * m * frac;
        trading += m * frac;
        if (wantParts) parts.push({ date: D, kind: "session", units: (1 - phi) * m * frac });
      }
    }
  }
  const Tcal = calendarYears(nowMs, closeE);
  const Yw = yearBasisOf(ctx, "weighted");
  const Ttd = trading / TRADING_DAYS;
  const Tw = weighted / Yw;
  const T = s.mode === "calendar" ? Tcal : s.mode === "trading" ? Ttd : Tw;
  const units = s.mode === "calendar" ? Tcal * calendarYearDays() : s.mode === "trading" ? trading : weighted;
  const out = { version: CLOCK_VERSION, mode: s.mode, units, T, Tcal, Ttd, Tw, unitsWeighted: weighted, unitsTrading: trading, yearBasis: yearBasisOf(ctx), settling };
  if (wantParts) out.parts = parts;
  return out;
}

/** Convert an IV between clocks through total variance: σ_x = σ_y·√(T_y / T_x). Null without inputs. */
export function convertIv(ivPct, fromT, toT) {
  const s = num(ivPct);
  const a = num(fromT);
  const b = num(toT);
  if (s === null || a === null || b === null || !(a > 0) || !(b > 0)) return null;
  return s * Math.sqrt(a / b);
}

/**
 * Constant-maturity IV at clock time `Tstar`: total variance interpolated linearly in T between the two listed
 * expiries bracketing it (rows with `skip`, an expiry on its own expiry day, are left out). Beyond the last or before
 * the first: flat from that expiry (method "flat-extrapolated"). Rows: [{ expiry, T, iv }].
 * @returns {{ iv: number|null, method: "interpolated"|"flat-extrapolated"|"unavailable", expiries: string[] }}
 */
export function constantMaturity(rows, Tstar) {
  const Ts = num(Tstar);
  const use = (rows ?? []).filter((r) => r && !r.skip && num(r.T) > 0 && num(r.iv) > 0).sort((a, b) => a.T - b.T);
  if (!use.length || !(Ts > 0)) return { iv: null, method: "unavailable", expiries: [] };
  const before = use.filter((r) => r.T <= Ts).pop() ?? null;
  const after = use.find((r) => r.T > Ts) ?? null;
  if (before && after) {
    const tv1 = (before.iv / 100) ** 2 * before.T;
    const tv2 = (after.iv / 100) ** 2 * after.T;
    const tv = tv1 + ((tv2 - tv1) * (Ts - before.T)) / (after.T - before.T);
    return { iv: tv > 0 ? Math.sqrt(tv / Ts) * 100 : null, method: "interpolated", expiries: [before.expiry, after.expiry], tv };
  }
  const one = before ?? after;
  return { iv: one.iv, method: "flat-extrapolated", expiries: [one.expiry] };
}

/**
 * IV rank and IV percentile of `current` against past values (numbers or { iv, date }): IVR = (c − min) /
 * (max − min) × 100; IVP = share strictly below × 100. IVR and IVP are null with reason "COLLECTING" when n < minN;
 * IVR is null with reason "FLAT" when max = min (IVP is still given).
 * @returns {{ n: number, min: {iv:number,date:string|null}|null, max: {iv:number,date:string|null}|null,
 *   ivr: number|null, ivp: number|null, reason?: "COLLECTING"|"FLAT"|"NO_CURRENT" }}
 */
export function ivRank(values, current, { minN = 20 } = {}) {
  const pts = (values ?? []).map((v) => (typeof v === "object" && v !== null ? { iv: num(v.iv), date: v.date ?? null } : { iv: num(v), date: null })).filter((v) => v.iv !== null);
  const n = pts.length;
  const c = num(current);
  let min = null;
  let max = null;
  for (const p of pts) {
    if (!min || p.iv < min.iv) min = p;
    if (!max || p.iv > max.iv) max = p;
  }
  const base = { n, min, max, ivr: null, ivp: null };
  if (c === null) return { ...base, reason: "NO_CURRENT" };
  if (n < minN || n === 0) return { ...base, reason: "COLLECTING" };
  const ivp = (100 * pts.filter((p) => p.iv < c).length) / n;
  if (max.iv === min.iv) return { ...base, ivp, reason: "FLAT" };
  return { ...base, ivr: ((c - min.iv) / (max.iv - min.iv)) * 100, ivp };
}

/**
 * Same-DTE comparison set: past rows { date, units, ... } with |units − U| ≤ band, one per date (the closest).
 * Sorted by date.
 */
export function sameDteRows(rows, units, band = 0.5) {
  const U = num(units);
  if (U === null) return [];
  const best = new Map();
  for (const r of rows ?? []) {
    const u = num(r?.units);
    if (u === null || Math.abs(u - U) > band + 1e-12) continue;
    const prev = best.get(r.date);
    if (!prev || Math.abs(u - U) < Math.abs(prev.units - U)) best.set(r.date, r);
  }
  return [...best.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ── Realised volatility ──

/** Annualised realised vol (percent) of the last `n` daily log returns: sample stdev × √252. Null under n + 1 closes. */
export function realisedVol(closes, n) {
  const c = (closes ?? []).map(num).filter((v) => v !== null && v > 0);
  if (!(n >= 2) || c.length < n + 1) return null;
  const r = [];
  for (let i = c.length - n; i < c.length; i++) r.push(Math.log(c[i] / c[i - 1]));
  const mean = r.reduce((a, b) => a + b, 0) / n;
  const v = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(v) * Math.sqrt(TRADING_DAYS) * 100;
}

const goodBar = (b) => num(b?.open) > 0 && num(b?.high) > 0 && num(b?.low) > 0 && num(b?.close) > 0 && b.high >= b.low;
/** Daily bars with no real range (H = L) cannot feed range estimators. */
const flatBars = (bars) => bars.every((b) => b.high === b.low);

/** Parkinson vol (percent) over the last `n` bars: σ² = mean(ln(H/L)²) / (4·ln 2) × 252. Null without real ranges. */
export function parkinsonVol(bars, n) {
  const b = (bars ?? []).filter(goodBar).slice(-n);
  if (!(n >= 1) || b.length < n || flatBars(b)) return null;
  const v = b.reduce((a, x) => a + Math.log(x.high / x.low) ** 2, 0) / n / (4 * Math.LN2);
  return Math.sqrt(v * TRADING_DAYS) * 100;
}

/**
 * Yang-Zhang vol (percent) over the last `n` bars (needs n + 1 bars for the open gaps): σ² = σ_o² + k·σ_c² + (1 −
 * k)·σ_rs², k = 0.34 / (1.34 + (n + 1)/(n − 1)); σ_o² and σ_c² are sample variances of ln(O/C_prev) and ln(C/O),
 * σ_rs² the mean Rogers-Satchell term; annualised by 252. Null without real ranges.
 */
export function yangZhangVol(bars, n) {
  const b = (bars ?? []).filter(goodBar).slice(-(n + 1));
  if (!(n >= 2) || b.length < n + 1) return null;
  const cur = b.slice(1);
  if (flatBars(cur)) return null;
  const o = cur.map((x, i) => Math.log(x.open / b[i].close));
  const c = cur.map((x) => Math.log(x.close / x.open));
  const rs = cur.map((x) => Math.log(x.high / x.close) * Math.log(x.high / x.open) + Math.log(x.low / x.close) * Math.log(x.low / x.open));
  const svar = (xs) => {
    const m = xs.reduce((a, v) => a + v, 0) / xs.length;
    return xs.reduce((a, v) => a + (v - m) ** 2, 0) / (xs.length - 1);
  };
  const k = 0.34 / (1.34 + (n + 1) / (n - 1));
  const v = svar(o) + k * svar(c) + (1 - k) * (rs.reduce((a, x) => a + x, 0) / n);
  return v > 0 ? Math.sqrt(v * TRADING_DAYS) * 100 : null;
}
