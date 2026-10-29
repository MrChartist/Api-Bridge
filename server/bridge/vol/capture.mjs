/**
 * Capture maths (stream S18, docs/spec/p1-03-pricing-vol.md §2.3, §2.7, §6.3–6.8). Pure: chains + the clock context →
 * store S2 expiry rows, the per-underlying daily summary and the S9 prediction rows. Every number comes from
 * dashboard/pricing.js (the one pricing core); nothing here holds a rate, a session time or a weight.
 *
 * Units: IVs in vol points (percent), rates decimal, prices in index points / ₹ per unit, T in years, clock `units`
 * in trading-day equivalents, timestamps ISO-8601 +05:30.
 */
import {
  atmIvAt,
  bands,
  constantMaturity,
  ivAtDelta,
  legPrice,
  parityForward,
  parkinsonVol,
  probItm,
  realisedVol,
  smilePoints,
  volTime,
  yangZhangVol,
} from "../dashboard/pricing.js";

export const ROW_VERSION = 1;
/** The model id logged with every prediction: Black-76 on the parity forward, vol-time clock vt1. */
export const MODEL_VERSION = "b76-vt1";
/** Smile points by forward delta (§2.3 `iv.*`): put deltas negative, call deltas positive. */
export const SMILE_DELTAS = Object.freeze({ p10: -0.1, p15: -0.15, p25: -0.25, p35: -0.35, c35: 0.35, c25: 0.25, c15: 0.15, c10: 0.1 });
/** Fewer OTM points with an IV than this: THIN. */
const THIN_POINTS = 5;
/** ATM spread over this share of the mid: WIDE_ATM. */
const WIDE_SHARE = 0.1;
const DAY = 86_400_000;
const IST = 330 * 60_000;

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
/** Round to `dp` decimals; null stays null. */
export const round = (v, dp) => {
  const n = num(v);
  if (n === null) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};
const isoOf = (utc) => new Date(utc).toISOString().slice(0, 10);
export const istDateOf = (ms) => isoOf(Math.floor((ms + IST) / DAY) * DAY);
/** ISO date `n` calendar days after `date`. */
export const addDays = (date, n) => isoOf(Date.parse(`${date}T00:00:00Z`) + n * DAY);

/** Trading-day test from a clock context (its isTradingDay, else weekdays not in ctx.holidays). */
export function tradingDayOf(ctx) {
  if (typeof ctx?.isTradingDay === "function") return ctx.isTradingDay;
  const hol = new Set((ctx?.holidays ?? []).map((h) => (typeof h === "string" ? h : h?.date)));
  return (date) => {
    const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
    return wd !== 0 && wd !== 6 && !hol.has(date);
  };
}

/** The 30-day target date (§6.6): today + 30 calendar days, or the previous trading day when that is not one. */
export function cmTargetDate(ctx, today, days = 30) {
  const isTrading = tradingDayOf(ctx);
  let d = addDays(today, days);
  for (let i = 0; i < 15 && !isTrading(d); i++) d = addDays(d, -1);
  return d;
}

/**
 * The expiries a capture reads (§2.7 step 2): listed, from today to `maxCalendarDays` ahead, the nearest
 * `maxPerUnderlying`, always including the pair that brackets the 30-day target (a middle expiry is dropped for it).
 */
export function chooseExpiries(listed, { today, target, maxPerUnderlying = 4, maxCalendarDays = 100 }) {
  const last = addDays(today, maxCalendarDays);
  const list = [...new Set((listed ?? []).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(String(e)) && e >= today && e <= last))].sort();
  const usable = list.filter((e) => e !== today);
  const before = usable.filter((e) => e <= target).pop();
  const after = usable.find((e) => e > target);
  const need = [before, after].filter(Boolean);
  const out = new Set(need);
  for (const e of list) {
    if (out.size >= Math.max(maxPerUnderlying, need.length)) break;
    out.add(e);
  }
  return [...out].sort();
}

const twoSided = (leg) => {
  const p = legPrice(leg, "mid");
  return p.q === "mid" || p.q === "wide";
};

/**
 * One S2 expiry row (§2.3) from a chain at `now`. Null when the clock has no time left (after the settlement) or the
 * chain has no forward. `meta` carries identity and provenance (underlying, exchange, kind, quality, trigger, late,
 * source, broker, accountId, partialWindow, basis).
 * @param {object} chain  OptionChain-shaped: { underlyingLtp, rows: [{ strike, ce, pe }] }
 * @param {object} ctx  clock context (vol/context.mjs) with ctx.rate
 */
export function expiryRow(chain, ctx, now, expiry, meta = {}) {
  const vt = volTime(ctx, now, expiry);
  if (!vt || !(vt.T > 0)) return null;
  const rate = num(ctx?.rate?.value) ?? 0;
  const basis = meta.basis ?? "mid";
  const pf = parityForward(chain, { rate, Tcal: vt.Tcal, strikes: 5 });
  if (pf.F === null) return null;
  const F = pf.F;
  const points = smilePoints(chain, { F, years: vt.T, rate, Tcal: vt.Tcal, basis, settling: vt.settling });
  const atmIv = atmIvAt(points, F);
  const strikes = points.map((p) => p.strike);
  let atmStrike = null;
  for (const k of strikes) if (atmStrike === null || Math.abs(k - F) < Math.abs(atmStrike - F)) atmStrike = k;
  const atmPoint = points.find((p) => p.strike === atmStrike) ?? null;
  const atmRow = (chain?.rows ?? []).find((r) => num(r?.strike) === atmStrike) ?? null;
  const iv = {};
  for (const [key, d] of Object.entries(SMILE_DELTAS)) iv[key] = round(ivAtDelta(points, d)?.iv ?? null, 2);
  const diff = (a, b) => (a === null || b === null ? null : round(a - b, 2));
  const rr25 = diff(iv.c25, iv.p25);
  const bf25 = iv.p25 !== null && iv.c25 !== null && atmIv !== null ? round((iv.p25 + iv.c25) / 2 - atmIv, 2) : null;
  const ce = legPrice(atmRow?.ce, basis);
  const pe = legPrice(atmRow?.pe, basis);
  const straddle = ce.price !== null && pe.price !== null ? ce.price + pe.price : null;
  const b = atmIv !== null ? bands(F, atmIv, vt.T) : null;
  // Quote quality: the share of legs within 10 strikes of ATM that are two-sided.
  const near = (chain?.rows ?? []).filter((r) => atmStrike !== null && Math.abs(strikes.indexOf(num(r.strike)) - strikes.indexOf(atmStrike)) <= 10);
  const legs = near.flatMap((r) => [r.ce, r.pe]).filter(Boolean);
  const quoteQuality = legs.length ? legs.filter(twoSided).length / legs.length : null;
  const flags = [];
  const spreadShare = (leg) => {
    const bid = num(leg?.bid);
    const ask = num(leg?.ask);
    return bid !== null && ask !== null && bid > 0 && ask >= bid ? (ask - bid) / ((ask + bid) / 2) : null;
  };
  if ([atmRow?.ce, atmRow?.pe].some((l) => (spreadShare(l) ?? 0) > WIDE_SHARE)) flags.push("WIDE_ATM");
  if (atmRow && ![atmRow.ce, atmRow.pe].every(twoSided)) flags.push("ONE_SIDED_ATM");
  if (pf.source === "spot") flags.push("FORWARD_SPOT");
  if (points.filter((p) => p.otm).length < THIN_POINTS) flags.push("THIN");
  if (istDateOf(now) === expiry) flags.push("EXPIRY_DAY");
  if (meta.partialWindow) flags.push("PARTIAL_WINDOW");
  const row = {
    v: ROW_VERSION,
    underlying: meta.underlying ?? chain?.underlying ?? null,
    exchange: meta.exchange ?? null,
    date: istDateOf(now),
    expiry,
    kind: meta.kind ?? null,
    capturedAt: meta.capturedAt ?? null,
    trigger: meta.trigger ?? "scheduled",
    quality: meta.quality ?? "live",
    late: Boolean(meta.late),
    source: meta.source ?? "broker",
    broker: meta.broker ?? null,
    clock: { version: vt.version, mode: vt.mode, units: round(vt.units, 5), T: round(vt.T, 9), Tcal: round(vt.Tcal, 9), Ttd: round(vt.Ttd, 9), Tw: round(vt.Tw, 9), unitsWeighted: round(vt.unitsWeighted, 5) },
    rate: { value: rate, quality: ctx?.rate?.quality ?? null },
    spot: round(chain?.underlyingLtp, 2),
    forward: round(F, 2),
    forwardSource: pf.source,
    forwardStrikes: pf.strikes,
    atmStrike,
    atmIv: round(atmIv, 2),
    ceIv: round(atmPoint?.ce?.iv ?? null, 2),
    peIv: round(atmPoint?.pe?.iv ?? null, 2),
    straddle: round(straddle, 2),
    iv,
    rr25,
    putSkew25: rr25 === null ? null : round(-rr25, 2),
    bf25,
    rr10: diff(iv.c10, iv.p10),
    tv: atmIv === null ? null : round((atmIv / 100) ** 2 * vt.T, 12),
    move1s: round(b?.move ?? null, 1),
    band1: b ? [round(b.band1[0], 1), round(b.band1[1], 1)] : null,
    eam: round(b?.eam ?? null, 1),
    quoteQuality: round(quoteQuality, 2),
    strikes: (chain?.rows ?? []).length,
    flags,
  };
  if (meta.accountId) row.accountId = meta.accountId;
  if (meta.contracts) row.contracts = meta.contracts;
  return row;
}

/** σ on another clock through total variance (§6.2): √(tv / T_x) in vol points. */
export function ivOnClock(row, clock) {
  const tv = num(row?.tv);
  const T = clock === "calendar" ? num(row?.clock?.Tcal) : clock === "trading" ? num(row?.clock?.Ttd) : num(row?.clock?.Tw ?? row?.clock?.T);
  if (tv === null || T === null || !(T > 0) || !(tv > 0)) return null;
  return Math.sqrt(tv / T) * 100;
}

const CLOCK_T = { weighted: "Tw", trading: "Ttd", calendar: "Tcal" };

/**
 * 30-day constant maturity (§6.6) from the day's expiry rows at `now`: total variance interpolated on the
 * installation's clock (rows on their own expiry day skipped), then read on the three clocks through total variance
 * (§6.2: σ_x = √(TV* / T*_x)). `method` "interpolated" | "flat-extrapolated" | "unavailable".
 */
export function cm30Of(rows, ctx, now) {
  const today = istDateOf(now);
  const targetDate = cmTargetDate(ctx, today);
  const star = volTime(ctx, now, targetDate);
  const out = { weighted: null, trading: null, calendar: null, method: "unavailable", expiries: [], targetDate };
  if (!star) return out;
  const mode = CLOCK_T[ctx?.mode] ? ctx.mode : "weighted";
  const key = CLOCK_T[mode];
  const cm = constantMaturity(
    (rows ?? []).map((r) => ({ expiry: r.expiry, T: num(r.clock?.[key]), iv: ivOnClock(r, mode), skip: r.expiry === today })),
    star[key],
  );
  out.method = cm.method;
  out.expiries = cm.expiries;
  if (cm.iv === null) return out;
  const tvStar = (cm.iv / 100) ** 2 * star[key];
  for (const [clock, k] of Object.entries(CLOCK_T)) out[clock] = star[k] > 0 ? round(Math.sqrt(tvStar / star[k]) * 100, 2) : null;
  return out;
}

/** The front expiry (§3.5): the nearest that is not on its own expiry day. */
export function frontOf(rows, today) {
  return [...(rows ?? [])].filter((r) => r.expiry !== today && num(r.atmIv) !== null).sort((a, b) => (a.expiry < b.expiry ? -1 : 1))[0] ?? null;
}

/**
 * Realised vol from daily bars (oldest first): close-to-close 10/20/60, Parkinson and Yang-Zhang 20 (§6.11). Range
 * estimators are null when the bars have no real highs and lows.
 */
export function hvOf(bars, source = "broker") {
  const b = (bars ?? []).filter((x) => num(x?.close) > 0);
  const closes = b.map((x) => x.close);
  return {
    cc10: round(realisedVol(closes, 10), 2),
    cc20: round(realisedVol(closes, 20), 2),
    cc60: round(realisedVol(closes, 60), 2),
    park20: round(parkinsonVol(b, 20), 2),
    yz20: round(yangZhangVol(b, 20), 2),
    source,
    closes: closes.length,
  };
}

/**
 * The daily summary row (§2.3) from the day's expiry rows.
 * @param {{ underlying: string, rows: object[], ctx: object, now: number, quality?: string, late?: boolean,
 *   partial?: boolean, vix?: object|null, hv?: object|null, spotClose?: number|null, prevFront?: string|null }} p
 */
export function summaryRow({ underlying, rows, ctx, now, quality = "live", late = false, partial = false, vix = null, hv = null, spotClose = null, prevFront = null }) {
  const today = istDateOf(now);
  const cm30 = cm30Of(rows, ctx, now);
  const f = frontOf(rows, today);
  const modeIv = cm30[ctx?.mode ?? "weighted"] ?? cm30.weighted;
  return {
    v: ROW_VERSION,
    underlying,
    date: today,
    quality,
    missed: false,
    late: Boolean(late),
    partial: Boolean(partial),
    cm30,
    front: f ? { expiry: f.expiry, atmIv: f.atmIv, roll: Boolean(prevFront && prevFront !== f.expiry) } : null,
    vix: vix ?? null,
    spotClose: round(spotClose, 2),
    hv: hv ?? null,
    ivHv20: modeIv !== null && num(hv?.cc20) > 0 ? round(modeIv / hv.cc20, 2) : null,
  };
}

/** An explicit missed-day row (§2.3). */
export function missedRow(underlying, date, reason) {
  return { v: ROW_VERSION, underlying, date, missed: true, reason, quality: null };
}

/**
 * S9 prediction rows (§2.3) for one expiry row: band1 (±1σ, p 0.6827), band2 (±2σ, p 0.9545), eam (expected absolute
 * move, with the straddle beside it) and pItmBand (N(d2) at the strikes nearest each 1σ edge).
 */
export function predictionRows(row, { ts, modelVersion = MODEL_VERSION, strikes = [] } = {}) {
  const F = num(row?.forward);
  const iv = num(row?.atmIv);
  const T = num(row?.clock?.T);
  if (F === null || iv === null || !(T > 0)) return [];
  const b = bands(F, iv, T);
  if (!b) return [];
  const stamp = String(ts ?? row.capturedAt ?? "").slice(0, 16);
  const id = (metric) => `p_${row.underlying}_${row.expiry}_${stamp}_${metric}`;
  const inputs = { forward: F, atmIv: iv, T, clock: row.clock?.mode ?? null, rate: row.rate?.value ?? null };
  const base = (metric, prediction) => ({ v: 1, id: id(metric), metric, modelVersion, underlying: row.underlying, expiry: row.expiry, ts: ts ?? row.capturedAt, inputs, prediction, outcome: null });
  const out = [
    base("band1", { lo: round(b.band1[0], 1), hi: round(b.band1[1], 1), p: 0.6827 }),
    base("band2", { lo: round(b.band2[0], 1), hi: round(b.band2[1], 1), p: 0.9545 }),
    base("eam", { move: round(b.eam, 1), straddle: row.straddle ?? null }),
  ];
  const ks = (strikes ?? []).filter((k) => num(k) !== null);
  if (ks.length) {
    const nearest = (x) => ks.reduce((a, k) => (Math.abs(k - x) < Math.abs(a - x) ? k : a));
    const lo = nearest(b.band1[0]);
    const hi = nearest(b.band1[1]);
    out.push(base("pItmBand", { putStrike: lo, pPut: round(probItm(F, lo, T, iv, "PE"), 4), callStrike: hi, pCall: round(probItm(F, hi, T, iv, "CE"), 4) }));
  }
  return out;
}

/**
 * A recorder snapshot (columnar S1 record, recorder/snapshot.mjs) as an OptionChain-shaped object, so a capture can
 * read the recorder instead of the broker (§2.7 step 3).
 */
export function chainFromSnapshot(snap) {
  if (!snap || !Array.isArray(snap.k)) return null;
  const leg = (side, i) => {
    const s = snap[side] ?? {};
    const v = (key) => (Array.isArray(s[key]) ? (s[key][i] ?? null) : null);
    const out = { ltp: v("ltp"), bid: v("bid"), ask: v("ask"), oi: v("oi"), volume: v("vol") };
    return out.ltp === null && out.bid === null && out.ask === null ? null : out;
  };
  return { underlying: snap.u ?? null, expiry: snap.x ?? null, underlyingLtp: snap.spot ?? null, atmStrike: snap.atm ?? null, rows: snap.k.map((k, i) => ({ strike: k, ce: leg("ce", i), pe: leg("pe", i) })) };
}
