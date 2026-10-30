/**
 * Derivatives depth for stream S15 (docs: analytics/derivDepth.openapi.yaml). Read-only; computed from the Bridge's own
 * option chains and daily candles, nothing is sent anywhere.
 *
 *   GET /v1/analytics/forward-curve?underlying=[&expiries=6][&ratePct=6.5]  implied forward and carry per expiry (put-call parity)
 *   GET /v1/analytics/rr-bf?underlying=&expiry=[&delta=25]                  risk reversal and butterfly in delta space
 *   GET /v1/analytics/vol-cone?underlying=[&days=500][&expiries=4]          HV cone, current vs cone, VRP, forward vol
 *   GET /v1/analytics/event-vol?underlying=&event=YYYY-MM-DD[&baselineVolPct=]  implied event move from total variance
 *
 * Forward: F = K + (C - P) e^{rT} at the (up to) three strikes nearest spot that have both legs priced (mid when bid and
 * ask exist, else LTP), averaged. T = days to the 15:30 IST expiry / 365. Carry rate c = ln(F/S)/T (financing minus
 * dividends, annualised) and implied dividend yield q = r - c.
 *
 * Risk reversal and butterfly: the smile is rebuilt in call-delta space from the OTM legs (calls above the forward, puts
 * below, a put's call-equivalent delta is its delta + 1); the chain's delta is used when present, else Black-Scholes
 * delta from the leg IV. IV at a target delta is linearly interpolated between the two bracketing points and never
 * extrapolated. RR(d) = IV(call d) - IV(put d); BF(d) = (IV(call d) + IV(put d)) / 2 - IV(ATM), ATM = 50 call delta.
 *
 * Vol cone: rolling close-to-close HV (annualised, sqrt 252, percent) over each tenor; percentiles of that history, the
 * current value, and its percentile. VRP = ATM IV of the nearest expiry with at least 3 days minus the HV of the closest
 * tenor. Forward vol between consecutive expiries: sigma_fwd^2 = (s2^2 T2 - s1^2 T1) / (T2 - T1), null when total
 * variance falls with maturity.
 *
 * Event vol: with E1 the last expiry before the event and E2 the first on or after it (event time 09:15 IST of that date),
 * the event variance is s2^2 T2 - s1^2 T1 - sigma_b^2 (T2 - T1), where sigma_b is the baseline (default s1, the
 * pre-event ATM IV, or an explicit baselineVolPct). Without a pre-event expiry the baseline is HV20 and
 * the variance is (s2^2 - sigma_b^2) T2. The implied 1-sigma event move is sqrt of that variance, in percent of spot.
 *
 * Every number is finite or null, every list is bounded, and a missing or thin input gives null with a reason.
 */
import { BridgeError } from "../core/errors.mjs";
import { defaultOptionExchange } from "../market/chain.mjs";
import { autoBackupFor, readOptionsBase } from "../market/routes.mjs";
import { computeGreeks, DEFAULT_RATE } from "../../lib/blackScholes.mjs";
import { expiryCutoffMs, ivSkew, nowMsOf, upcomingExpiries } from "./math.mjs";
import { closeHv, rollingHv } from "./volStats.mjs";

export const CONE_TENORS = Object.freeze([10, 20, 30, 60, 90]);
const DAY_MS = 86_400_000;
const MIN_SMILE_POINTS = 5;
const MIN_CONE_SAMPLES = 20;
const MAX_EXPIRIES = 12;

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const R = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

const guarded = (fn) => async (ctx) => {
  try {
    return await fn(ctx);
  } catch (e) {
    if (e instanceof BridgeError) throw e;
    throw new BridgeError("INTERNAL", "The derivatives calculation failed.");
  }
};

function qInt(q, name, min, max, dflt) {
  const v = q.get(name);
  if (v === null || v === "") return dflt;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw invalid(name, `${name} must be a whole number from ${min} to ${max}.`);
  return Number(v);
}
function qNum(q, name, min, max) {
  const v = q.get(name);
  if (v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw invalid(name, `${name} must be a number from ${min} to ${max}.`);
  return n;
}
function underlyingOf(ctx) {
  const u = String(ctx.query.get("underlying") ?? "").trim().toUpperCase();
  if (!u) throw invalid("underlying", "underlying is required, for example NIFTY.");
  if (!/^[A-Z0-9][A-Z0-9&_-]{0,29}$/.test(u)) throw invalid("underlying", "underlying is not a valid symbol name.");
  return u;
}

/** Mid when a sane bid and ask exist, else LTP, else null. */
export const legPrice = (leg) => (leg && leg.bid > 0 && leg.ask > 0 && leg.ask >= leg.bid ? (leg.bid + leg.ask) / 2 : leg && leg.ltp > 0 ? leg.ltp : null);

/**
 * Implied forward, carry and dividend yield for one chain.
 * @returns {{forward, spot, basis, basisPct, carryPct, impliedDividendYieldPct, strikesUsed, dispersion, quality, reason?}}
 */
export function impliedForward(chain, dte, rate) {
  const none = (reason) => ({ forward: null, spot: chain?.underlyingLtp > 0 ? chain.underlyingLtp : null, basis: null, basisPct: null, carryPct: null, impliedDividendYieldPct: null, strikesUsed: [], dispersion: null, quality: null, reason });
  const S = chain?.underlyingLtp;
  if (!(S > 0)) return none("no underlying price");
  if (!(dte >= 0.5)) return none("less than half a day to expiry; parity forward is too noisy");
  const T = dte / 365;
  const cand = (chain.rows ?? [])
    .map((r) => ({ K: r.strike, C: legPrice(r.ce), P: legPrice(r.pe) }))
    .filter((x) => x.K > 0 && x.C !== null && x.P !== null)
    .sort((a, b) => Math.abs(a.K - S) - Math.abs(b.K - S))
    .slice(0, 3);
  if (!cand.length) return none("no strike near spot has both a call and a put price");
  const fs = cand.map((x) => x.K + (x.C - x.P) * Math.exp(rate * T));
  const F = fs.reduce((t, x) => t + x, 0) / fs.length;
  if (!(F > 0) || !Number.isFinite(F)) return none("parity gave a non-positive forward");
  const carry = Math.log(F / S) / T;
  const dispersion = Math.max(...fs) - Math.min(...fs);
  return {
    forward: R(F, 4),
    spot: R(S, 2),
    basis: R(F - S, 2),
    basisPct: R(((F - S) / S) * 100, 4),
    carryPct: R(carry * 100, 3),
    impliedDividendYieldPct: R((rate - carry) * 100, 3),
    strikesUsed: cand.map((x) => x.K),
    dispersion: R(dispersion, 2),
    quality: dispersion / F > 0.0025 ? "wide" : "ok",
  };
}

/** Smile as sorted [{ delta (call-equivalent, 0..1), iv (percent), strike }] from the OTM legs. */
export function smileInDelta(chain, dte, rate) {
  const S = chain?.underlyingLtp;
  if (!(S > 0) || !(dte > 0)) return [];
  const atm = chain.atmStrike ?? S;
  const pts = [];
  for (const r of chain.rows ?? []) {
    const isCall = r.strike >= atm;
    const leg = isCall ? r.ce : r.pe;
    if (!leg || !(leg.iv > 0)) continue;
    let d = Number.isFinite(leg.delta) && leg.delta !== 0 ? leg.delta : computeGreeks({ spot: S, strike: r.strike, daysToExpiry: dte, type: isCall ? "CE" : "PE", vol: leg.iv / 100, rate }).delta;
    if (!Number.isFinite(d)) continue;
    if (!isCall) d += 1;
    if (d > 0 && d < 1) pts.push({ delta: d, iv: leg.iv, strike: r.strike });
  }
  return pts.sort((a, b) => a.delta - b.delta);
}

/** Linear interpolation of IV at a call delta; null outside the observed range. */
export function ivAtDelta(points, target) {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (target >= a.delta && target <= b.delta) {
      if (b.delta === a.delta) return a.iv;
      return a.iv + ((b.iv - a.iv) * (target - a.delta)) / (b.delta - a.delta);
    }
  }
  return null;
}

/** RR and BF at one delta (25 means 25-delta). Null fields when the smile does not reach the wings. */
export function rrBf(points, delta) {
  const atm = ivAtDelta(points, 0.5);
  const call = ivAtDelta(points, delta / 100);
  const put = ivAtDelta(points, 1 - delta / 100);
  const ok = atm !== null && call !== null && put !== null;
  return { delta, callIvPct: R(call), putIvPct: R(put), atmIvPct: R(atm), riskReversal: ok ? R(call - put, 3) : null, butterfly: ok ? R((call + put) / 2 - atm, 3) : null, reason: ok ? null : "the smile does not reach this delta on both wings" };
}

/** Percentile by linear interpolation over a sorted array. */
function pct(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Forward vol between consecutive (dte, ivPct) points; null where total variance decreases. */
export function forwardVols(slices) {
  const out = [];
  for (let i = 1; i < slices.length; i++) {
    const a = slices[i - 1];
    const b = slices[i];
    const T1 = a.dte / 365;
    const T2 = b.dte / 365;
    const base = { from: a.expiry, to: b.expiry, dteFrom: R(a.dte), dteTo: R(b.dte) };
    if (!(a.atmIv > 0) || !(b.atmIv > 0) || !(T2 > T1) || !(T1 > 0)) {
      out.push({ ...base, forwardVolPct: null, reason: "missing IV or non-increasing maturity" });
      continue;
    }
    const v = ((b.atmIv / 100) ** 2 * T2 - (a.atmIv / 100) ** 2 * T1) / (T2 - T1);
    out.push(v > 0 ? { ...base, forwardVolPct: R(Math.sqrt(v) * 100) } : { ...base, forwardVolPct: null, reason: "total variance falls with maturity (inverted term structure), so no real forward vol" });
  }
  return out;
}

/** Event variance and implied move. All vols in percent; returns null move with a reason when no premium shows. */
export function eventMove({ s1, T1, s2, T2, baseline, spot }) {
  const v2 = (s2 / 100) ** 2 * T2;
  const v1 = s1 > 0 && T1 > 0 ? (s1 / 100) ** 2 * T1 : 0;
  const ev = v2 - v1 - (baseline / 100) ** 2 * (T2 - (s1 > 0 && T1 > 0 ? T1 : 0));
  if (!(ev > 0)) return { eventVariance: R(ev, 8), impliedEventMovePct: null, reason: "no event premium: the later expiry's total variance is not above the baseline" };
  const sd = Math.sqrt(ev);
  return { eventVariance: R(ev, 8), impliedEventMovePct: R(sd * 100, 3), expectedAbsMovePct: R(sd * Math.sqrt(2 / Math.PI) * 100, 3), impliedEventMovePoints: spot > 0 ? R(sd * spot, 2) : null, reason: null };
}

/** @returns {Array<[string, string, {scope: "read"}, (ctx: any) => Promise<object>]>} */
export function derivDepthRoutes(deps) {
  const md = () => deps.marketData;
  const readOptions = (ctx, o = {}) => readOptionsBase(ctx, { ...o, autoBackup: autoBackupFor(deps) });
  const errLine = (e, extra = {}) => ({ ...extra, code: e?.code ?? "UPSTREAM_ERROR", message: String(e?.message ?? e).slice(0, 200) });
  const dteOf = (expiry, nowMs) => (expiryCutoffMs(expiry) - nowMs) / DAY_MS;
  const accountMeta = (ctx, opts, freshness) => ({ requestId: ctx.requestId, accountId: opts.accountId ?? null, ...(freshness ? { freshness } : {}) });
  const withErrors = (obj, errors) => (errors.length ? { ...obj, errors } : obj);

  async function upcoming(underlying, opts, count) {
    const list = await md().expiries(underlying, opts);
    return { expiries: upcomingExpiries(list.expiries, nowMsOf(deps)).slice(0, count), freshness: list.freshness };
  }

  // ── forward curve ──
  const forwardCurve = guarded(async (ctx) => {
    const underlying = underlyingOf(ctx);
    const count = qInt(ctx.query, "expiries", 1, MAX_EXPIRIES, 6);
    const rate = (qNum(ctx.query, "ratePct", 0, 100) ?? DEFAULT_RATE * 100) / 100;
    const opts = readOptions(ctx);
    const { expiries, freshness } = await upcoming(underlying, opts, count);
    const nowMs = nowMsOf(deps);
    const curve = [];
    const errors = [];
    let spot = null;
    for (const expiry of expiries) {
      const dte = dteOf(expiry, nowMs);
      try {
        const chain = await md().optionChain({ underlying, expiry, greeks: false }, opts);
        spot ??= chain.underlyingLtp > 0 ? chain.underlyingLtp : null;
        curve.push({ expiry, dte: R(dte), ...impliedForward(chain, dte, rate) });
      } catch (e) {
        errors.push(errLine(e, { expiry }));
        curve.push({ expiry, dte: R(dte), forward: null, reason: "chain unavailable" });
      }
    }
    const data = { underlying, spot: R(spot), ratePct: R(rate * 100, 3), curve, method: "F = K + (C - P) e^{rT}, mean over up to 3 strikes nearest spot; carry = ln(F/S)/T; implied dividend yield = r - carry" };
    return withErrors({ data, meta: accountMeta(ctx, opts, freshness) }, errors);
  });

  // ── risk reversal and butterfly ──
  const rrBfRoute = guarded(async (ctx) => {
    const underlying = underlyingOf(ctx);
    const expiry = ctx.query.get("expiry");
    if (!expiry || !isDate(expiry)) throw invalid("expiry", "expiry is required as YYYY-MM-DD.");
    const delta = qInt(ctx.query, "delta", 1, 49, 25);
    const opts = readOptions(ctx);
    const chain = await md().optionChain({ underlying, expiry, greeks: true }, opts);
    const dte = dteOf(expiry, nowMsOf(deps));
    const points = smileInDelta(chain, dte, DEFAULT_RATE);
    const deltas = [...new Set([delta, 25, 10])].sort((a, b) => b - a);
    const thin = points.length < MIN_SMILE_POINTS;
    const results = deltas.map((d) => (thin ? { delta: d, callIvPct: null, putIvPct: null, atmIvPct: null, riskReversal: null, butterfly: null, reason: `only ${points.length} usable smile points (need ${MIN_SMILE_POINTS})` } : rrBf(points, d)));
    const data = {
      underlying: String(chain.underlying ?? underlying),
      expiry,
      daysToExpiry: R(dte),
      spot: R(chain.underlyingLtp),
      requestedDelta: delta,
      requested: results.find((r) => r.delta === delta),
      deltas: results,
      smilePoints: points.length,
      convention: "RR = IV(call at delta) - IV(put at delta); BF = (IV(call) + IV(put)) / 2 - IV(ATM, 50 call delta). IV in percent, interpolated linearly in delta space, never extrapolated.",
    };
    return { data, meta: accountMeta(ctx, opts, chain.freshness) };
  });

  // ── vol cone ──
  const volCone = guarded(async (ctx) => {
    const underlying = underlyingOf(ctx);
    const days = qInt(ctx.query, "days", 120, 1500, 500);
    const count = qInt(ctx.query, "expiries", 1, 6, 4);
    const opts = readOptions(ctx);
    const cash = defaultOptionExchange(underlying) === "BFO" ? "BSE" : "NSE";
    const hist = await md().history({ symbol: `${cash}:${underlying}`, interval: "1d", countback: days + 1 }, readOptions(ctx, { maxAge: false }));
    const closes = (hist.candles ?? []).filter((c) => c && c.close > 0).map((c) => c.close);
    const cone = CONE_TENORS.map((n) => {
      const series = rollingHv(closes, n);
      const current = series.length ? series.at(-1) : null;
      if (series.length < MIN_CONE_SAMPLES) return { tenorDays: n, current: closeHv(closes, n), samples: series.length, min: null, p5: null, p25: null, p50: null, p75: null, p95: null, max: null, currentPercentile: null, position: null, reason: `only ${series.length} rolling windows (need ${MIN_CONE_SAMPLES})` };
      const sorted = [...series].sort((a, b) => a - b);
      const below = series.filter((v) => v < current).length;
      const p25 = pct(sorted, 0.25);
      const p75 = pct(sorted, 0.75);
      return { tenorDays: n, current, samples: series.length, min: R(sorted[0]), p5: R(pct(sorted, 0.05)), p25: R(p25), p50: R(pct(sorted, 0.5)), p75: R(p75), p95: R(pct(sorted, 0.95)), max: R(sorted.at(-1)), currentPercentile: R((below / series.length) * 100), position: current < p25 ? "low" : current > p75 ? "high" : "mid", reason: null };
    });

    const errors = [];
    const slices = [];
    let freshness;
    const { expiries } = await upcoming(underlying, opts, 12);
    const nowMs = nowMsOf(deps);
    for (const expiry of expiries) {
      const dte = dteOf(expiry, nowMs);
      if (dte < 3) continue;
      if (slices.length >= count) break;
      try {
        const chain = await md().optionChain({ underlying, expiry, greeks: true }, opts);
        freshness ??= chain.freshness;
        slices.push({ expiry, dte, atmIv: ivSkew(chain).atmIv, spot: chain.underlyingLtp });
      } catch (e) {
        errors.push(errLine(e, { expiry }));
      }
    }
    let vrp = null;
    const near = slices.find((s) => s.atmIv > 0);
    if (near) {
      const tenor = CONE_TENORS.reduce((best, t) => (Math.abs(t - near.dte) < Math.abs(best - near.dte) ? t : best), CONE_TENORS[0]);
      const hv = cone.find((c) => c.tenorDays === tenor)?.current ?? null;
      vrp = { expiry: near.expiry, daysToExpiry: R(near.dte), atmIvPct: near.atmIv, hvTenorDays: tenor, hvPct: hv, spreadPts: hv === null ? null : R(near.atmIv - hv), ratio: hv > 0 ? R(near.atmIv / hv, 3) : null, note: "VRP = ATM implied vol minus realised vol of the closest cone tenor; positive means options are priced above recent realised movement." };
    }
    const data = {
      underlying,
      lookbackDays: days,
      closes: closes.length,
      cone,
      vrp,
      atmTerm: slices.map((s) => ({ expiry: s.expiry, daysToExpiry: R(s.dte), atmIvPct: s.atmIv })),
      forwardVol: forwardVols(slices.filter((s) => s.atmIv > 0)),
      note: "HV is close-to-close, annualised with sqrt(252), percent. Forward vol: sigma_fwd^2 = (s2^2 T2 - s1^2 T1) / (T2 - T1), T in calendar days / 365.",
    };
    return withErrors({ data, meta: accountMeta(ctx, opts, freshness ?? hist.freshness) }, errors);
  });

  // ── event vol ──
  const eventVol = guarded(async (ctx) => {
    const underlying = underlyingOf(ctx);
    const event = ctx.query.get("event");
    if (!event || !isDate(event)) throw invalid("event", "event is required as YYYY-MM-DD.");
    const nowMs = nowMsOf(deps);
    const eventMs = Date.parse(`${event}T09:15:00+05:30`);
    if (eventMs <= nowMs) throw invalid("event", "event must be a future date.");
    if (eventMs - nowMs > 400 * DAY_MS) throw invalid("event", "event must be within the next 400 days.");
    const baselineParam = qNum(ctx.query, "baselineVolPct", 1, 300);
    const opts = readOptions(ctx);
    const { expiries, freshness } = await upcoming(underlying, opts, 24);
    const before = expiries.filter((e) => expiryCutoffMs(e) < eventMs).at(-1) ?? null;
    const after = expiries.find((e) => expiryCutoffMs(e) >= eventMs) ?? null;
    const base = { underlying, event, eventTimeAssumed: "09:15 IST on the event date" };
    if (!after) return { data: { ...base, impliedEventMovePct: null, reason: "No listed expiry on or after the event date, so no implied event premium can be read." }, meta: accountMeta(ctx, opts, freshness) };
    const errors = [];
    const slice = async (expiry) => {
      try {
        const chain = await md().optionChain({ underlying, expiry, greeks: true }, opts);
        const dte = dteOf(expiry, nowMs);
        return { expiry, dte, atmIv: ivSkew(chain).atmIv, spot: chain.underlyingLtp };
      } catch (e) {
        errors.push(errLine(e, { expiry }));
        return null;
      }
    };
    const s2 = await slice(after);
    const s1 = before ? await slice(before) : null;
    if (!s2 || !(s2.atmIv > 0)) return withErrors({ data: { ...base, impliedEventMovePct: null, reason: "No usable ATM IV for the expiry after the event." }, meta: accountMeta(ctx, opts, freshness) }, errors);
    const usePre = s1 && s1.atmIv > 0;
    let baseline = baselineParam;
    let baselineSource = "request";
    if (baseline === undefined && usePre) {
      baseline = s1.atmIv;
      baselineSource = "ATM IV of the pre-event expiry";
    }
    if (baseline === undefined) {
      try {
        const cash = defaultOptionExchange(underlying) === "BFO" ? "BSE" : "NSE";
        const hist = await md().history({ symbol: `${cash}:${underlying}`, interval: "1d", countback: 61 }, readOptions(ctx, { maxAge: false }));
        baseline = closeHv((hist.candles ?? []).map((c) => c.close), 20) ?? undefined;
        baselineSource = "HV20 (no pre-event expiry)";
      } catch (e) {
        errors.push(errLine(e, { what: "history" }));
      }
    }
    if (!(baseline > 0)) return withErrors({ data: { ...base, impliedEventMovePct: null, reason: "No pre-event expiry and no baseline vol; send baselineVolPct." }, meta: accountMeta(ctx, opts, freshness) }, errors);
    const T2 = s2.dte / 365;
    const m = eventMove({ s1: usePre ? s1.atmIv : 0, T1: usePre ? s1.dte / 365 : 0, s2: s2.atmIv, T2, baseline, spot: s2.spot });
    const data = {
      ...base,
      preEventExpiry: usePre ? { expiry: s1.expiry, daysToExpiry: R(s1.dte), atmIvPct: s1.atmIv, totalVariance: R((s1.atmIv / 100) ** 2 * (s1.dte / 365), 8) } : null,
      postEventExpiry: { expiry: s2.expiry, daysToExpiry: R(s2.dte), atmIvPct: s2.atmIv, totalVariance: R((s2.atmIv / 100) ** 2 * T2, 8) },
      baseline: { volPct: R(baseline), source: baselineSource },
      spot: R(s2.spot),
      ...m,
      method: "event variance = s2^2 T2 - s1^2 T1 - sigma_b^2 (T2 - T1); implied 1-sigma move = sqrt(event variance)",
    };
    return withErrors({ data, meta: accountMeta(ctx, opts, freshness) }, errors);
  });

  return [
    ["GET", "/v1/analytics/forward-curve", { scope: "read" }, forwardCurve],
    ["GET", "/v1/analytics/rr-bf", { scope: "read" }, rrBfRoute],
    ["GET", "/v1/analytics/vol-cone", { scope: "read" }, volCone],
    ["GET", "/v1/analytics/event-vol", { scope: "read" }, eventVol],
  ];
}
