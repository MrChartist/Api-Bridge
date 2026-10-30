/**
 * Greek exposure and Open Interest Explorer for Indian options (Unusual-Whales style). Read-only, no orders.
 *
 *   GET /v1/analytics/exposure?underlying=&expiry=[&strikes=]            delta/gamma/vanna/charm exposure per strike
 *   GET /v1/analytics/exposure/expiries?underlying=[&expiries=3][&strikes=]  exposure summed over the next N expiries
 *   GET /v1/analytics/oi-explorer?underlying=[&expiries=4][&strikes=]    call/put OI matrix, strike x expiry
 *
 * Convention (same as math.mjs gammaExposure): dealers are assumed LONG calls and SHORT puts, so a call leg
 * contributes +greek x OI x lot and a put leg -greek x OI x lot. Where "greek" is:
 *   d1 = (ln(S/K) + (r + s^2/2) T) / (s sqrt(T)),  d2 = d1 - s sqrt(T),  s = leg IV / 100, T = max(days, 0.25)/365
 *   delta = N(d1) (CE) or N(d1)-1 (PE)                                   -> from the chain / computeGreeks
 *   gamma = phi(d1) / (S s sqrt(T))                                      -> from the chain, via gammaExposure()
 *   vanna = d delta / d sigma = -phi(d1) d2 / s   (same for CE and PE)  -> reported per 1 vol point (/100)
 *   charm = d delta / d day (time passing, no dividend)
 *         = -phi(d1) (2 r T - d2 s sqrt(T)) / (2 T s sqrt(T)) / 365      (same for CE and PE)
 * Units, with q = OI x lotSize x sign:
 *   deltaExposure  = delta x q                INR per 1 index point (rupee P&L of the dealer book for a 1 point move)
 *   gammaExposure  = gamma x q x S^2 x 1%     INR per 1% move (math.mjs)
 *   vannaExposure  = vanna x q                change of deltaExposure per +1 vol point of IV (INR per point per vol point)
 *   charmExposure  = charm x q                change of deltaExposure per calendar day (INR per point per day)
 * A leg is skipped (counted in skippedLegs) when it has open interest but no usable IV or gamma. Output is never NaN.
 */
import { z } from "zod";
import { BridgeError } from "../core/errors.mjs";
import { autoBackupFor, readOptionsBase } from "../market/routes.mjs";
import { computeGreeks, daysBetween, DEFAULT_RATE } from "../../lib/blackScholes.mjs";
import { gammaExposure, nowMsOf, upcomingExpiries } from "./math.mjs";

const fin = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round = (v, d = 0) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : 0);
const pdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
const yearsOf = (days) => Math.max(days, 0.25) / 365;

function d12({ spot, strike, vol, days, rate }) {
  const T = yearsOf(days);
  const sq = vol * Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (rate + 0.5 * vol * vol) * T) / sq;
  return { T, sq, d1, d2: d1 - sq };
}
const validInputs = ({ spot, strike, vol }) => spot > 0 && strike > 0 && vol > 0;

/** Vanna: d delta / d IV, per 1 vol point (1 % absolute IV). `vol` is a fraction (0.15). Same for CE and PE. */
export function bsVanna({ spot, strike, days, vol, rate = DEFAULT_RATE }) {
  if (!validInputs({ spot, strike, vol })) return 0;
  const { d1, d2 } = d12({ spot, strike, vol, days, rate });
  return fin((-pdf(d1) * d2) / vol / 100);
}

/** Charm: d delta / d calendar day as time passes (delta decay per day). Same for CE and PE (no dividend). */
export function bsCharm({ spot, strike, days, vol, rate = DEFAULT_RATE }) {
  if (!validInputs({ spot, strike, vol })) return 0;
  const { T, sq, d1, d2 } = d12({ spot, strike, vol, days, rate });
  return fin((-pdf(d1) * (2 * rate * T - d2 * sq)) / (2 * T * sq) / 365);
}

const usable = (leg) => leg && fin(leg.oi) > 0 && fin(leg.iv) > 0 && Number.isFinite(leg.gamma) && leg.gamma !== null && leg.gamma > 0;

/**
 * Greek exposure for one chain. `days` = calendar days to expiry (defaults to a chain-supplied value else 0.25).
 * @returns per-strike rows, totals, walls, flip level and peak strikes.
 */
export function greekExposure(chain, { days = 0.25, rate = DEFAULT_RATE } = {}) {
  const rows = Array.isArray(chain?.rows) ? chain.rows : [];
  const spot = fin(chain?.underlyingLtp);
  const lot = fin(chain?.lotSize) || 1;
  let skipped = 0;
  const side = (leg) => {
    if (!leg || !(fin(leg.oi) > 0)) return null;
    if (!usable(leg) || !(spot > 0)) {
      skipped++;
      return null;
    }
    return leg;
  };
  const clean = rows.map((r) => ({ strike: r.strike, ce: side(r.ce), pe: side(r.pe) }));
  const gex = gammaExposure({ ...chain, rows: clean });
  const strikes = clean.map((r, i) => {
    const one = (leg, sign, type) => {
      if (!leg) return { delta: 0, vanna: 0, charm: 0 };
      const vol = leg.iv / 100;
      const q = sign * leg.oi * lot;
      const delta = Number.isFinite(leg.delta) && leg.delta !== null ? leg.delta : computeGreeks({ spot, strike: r.strike, daysToExpiry: days, type, vol, rate }).delta;
      return { delta: fin(delta * q), vanna: fin(bsVanna({ spot, strike: r.strike, days, vol, rate }) * q), charm: fin(bsCharm({ spot, strike: r.strike, days, vol, rate }) * q) };
    };
    const c = one(r.ce, 1, "CE");
    const p = one(r.pe, -1, "PE");
    const g = gex.strikes[i];
    return {
      strike: r.strike,
      callDelta: round(c.delta),
      putDelta: round(p.delta),
      netDelta: round(c.delta + p.delta),
      callGex: g.callGex,
      putGex: g.putGex,
      netGex: g.netGex,
      callVanna: round(c.vanna),
      putVanna: round(p.vanna),
      netVanna: round(c.vanna + p.vanna),
      callCharm: round(c.charm),
      putCharm: round(p.charm),
      netCharm: round(c.charm + p.charm),
    };
  });
  const sum = (f) => round(strikes.reduce((t, s) => t + s[f], 0));
  const peak = (f) => strikes.reduce((b, s) => (Math.abs(s[f]) > 0 && (b === null || Math.abs(s[f]) > Math.abs(b[f])) ? s : b), null)?.strike ?? null;
  const wall = (f, abs) => strikes.reduce((b, s) => (abs(s[f]) > 0 && (b === null || abs(s[f]) > abs(b[f])) ? s : b), null)?.strike ?? null;
  return {
    underlying: chain?.underlying ?? null,
    expiry: chain?.expiry ?? null,
    underlyingLtp: chain?.underlyingLtp ?? null,
    lotSize: chain?.lotSize ?? null,
    daysToExpiry: round(days, 4),
    units: {
      delta: "INR per 1 index point",
      gamma: "INR per 1% move",
      vanna: "INR per point per 1 vol point of IV",
      charm: "INR per point per calendar day",
    },
    totals: { netDelta: sum("netDelta"), netGex: sum("netGex"), netVanna: sum("netVanna"), netCharm: sum("netCharm") },
    regime: sum("netGex") > 0 ? "positive" : sum("netGex") < 0 ? "negative" : "neutral",
    callWall: wall("callGex", (v) => Math.max(0, v)),
    putWall: wall("putGex", (v) => Math.max(0, -v)),
    zeroGammaLevel: gex.flipStrike ?? null,
    peakStrike: peak("netGex"),
    peakStrikes: { delta: peak("netDelta"), gamma: peak("netGex"), vanna: peak("netVanna"), charm: peak("netCharm") },
    skippedLegs: skipped,
    strikes,
  };
}

/** Aggregate per-expiry exposures: totals, per-expiry share of gross gamma/delta, and net gamma by strike. */
export function exposureAcrossExpiries(items) {
  const gross = (e, f1, f2) => e.strikes.reduce((t, s) => t + Math.abs(s[f1]) + Math.abs(s[f2]), 0);
  const gG = items.map((e) => gross(e, "callGex", "putGex"));
  const gD = items.map((e) => gross(e, "callDelta", "putDelta"));
  const sG = gG.reduce((a, b) => a + b, 0);
  const sD = gD.reduce((a, b) => a + b, 0);
  const share = (v, tot) => (tot > 0 ? round(v / tot, 4) : 0);
  const by = new Map();
  for (const e of items)
    for (const s of e.strikes) {
      const a = by.get(s.strike) ?? { strike: s.strike, netGex: 0, netDelta: 0 };
      a.netGex += s.netGex;
      a.netDelta += s.netDelta;
      by.set(s.strike, a);
    }
  const strikes = [...by.values()].sort((a, b) => a.strike - b.strike).map((a) => ({ strike: a.strike, netGex: round(a.netGex), netDelta: round(a.netDelta) }));
  let run = 0;
  let prev = 0;
  let flip = null;
  for (const s of strikes) {
    run += s.netGex;
    const sg = Math.sign(run);
    if (flip === null && prev !== 0 && sg !== 0 && sg !== prev) flip = s.strike;
    if (sg !== 0) prev = sg;
  }
  const peak = strikes.reduce((b, s) => (Math.abs(s.netGex) > 0 && (b === null || Math.abs(s.netGex) > Math.abs(b.netGex)) ? s : b), null);
  const net = round(items.reduce((t, e) => t + e.totals.netGex, 0));
  return {
    unit: { gamma: "INR per 1% move", delta: "INR per 1 index point" },
    totals: { netGex: net, netDelta: round(items.reduce((t, e) => t + e.totals.netDelta, 0)) },
    regime: net > 0 ? "positive" : net < 0 ? "negative" : "neutral",
    zeroGammaLevel: flip,
    peakStrike: peak?.strike ?? null,
    skippedLegs: items.reduce((t, e) => t + e.skippedLegs, 0),
    expiries: items.map((e, i) => ({
      expiry: e.expiry,
      daysToExpiry: e.daysToExpiry,
      netGex: e.totals.netGex,
      netDelta: e.totals.netDelta,
      grossGex: round(gG[i]),
      gexShare: share(gG[i], sG),
      deltaShare: share(gD[i], sD),
      zeroGammaLevel: e.zeroGammaLevel,
      callWall: e.callWall,
      putWall: e.putWall,
    })),
    strikes,
  };
}

/** Call/put OI matrix by strike x expiry. `charts` = [{ expiry, chain }]. */
export function oiMatrix(charts, { top = 10 } = {}) {
  const oi = (leg) => Math.max(0, fin(leg?.oi));
  const strikeSet = new Set();
  for (const { chain } of charts) for (const r of chain?.rows ?? []) strikeSet.add(r.strike);
  const strikes = [...strikeSet].sort((a, b) => a - b);
  const cell = new Map();
  for (const { expiry, chain } of charts) for (const r of chain?.rows ?? []) cell.set(`${r.strike}|${expiry}`, { callOi: oi(r.ce), putOi: oi(r.pe) });
  const cells = [];
  const matrix = strikes.map((strike) => {
    let c = 0;
    let p = 0;
    const row = charts.map(({ expiry }) => {
      const x = cell.get(`${strike}|${expiry}`) ?? { callOi: 0, putOi: 0 };
      c += x.callOi;
      p += x.putOi;
      if (x.callOi > 0) cells.push({ strike, expiry, side: "CE", oi: x.callOi });
      if (x.putOi > 0) cells.push({ strike, expiry, side: "PE", oi: x.putOi });
      return { expiry, ...x, totalOi: x.callOi + x.putOi };
    });
    return { strike, cells: row, callOi: c, putOi: p, totalOi: c + p };
  });
  const columns = charts.map(({ expiry }, i) => {
    const callOi = matrix.reduce((t, r) => t + r.cells[i].callOi, 0);
    const putOi = matrix.reduce((t, r) => t + r.cells[i].putOi, 0);
    return { expiry, callOi, putOi, totalOi: callOi + putOi };
  });
  const callOi = columns.reduce((t, c) => t + c.callOi, 0);
  const putOi = columns.reduce((t, c) => t + c.putOi, 0);
  cells.sort((a, b) => b.oi - a.oi || a.strike - b.strike || a.expiry.localeCompare(b.expiry) || a.side.localeCompare(b.side));
  return {
    expiries: charts.map((c) => c.expiry),
    totals: { callOi, putOi, totalOi: callOi + putOi, pcr: callOi > 0 ? round(putOi / callOi, 3) : null },
    columns,
    strikes: matrix,
    topCells: cells.slice(0, top),
  };
}

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const opt = (q, name) => {
  const v = q.get(name);
  return v === null || v === "" ? undefined : v;
};
function intParam(q, name, min, max, dflt) {
  const v = opt(q, name);
  if (v === undefined) return dflt;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw invalid(name, `${name} must be a whole number from ${min} to ${max}.`);
  return Number(v);
}

/** @param {object} deps full deps (needs marketData) */
export function exposureRoutes(deps) {
  const md = () => deps.marketData;
  const readOptions = (ctx) => readOptionsBase(ctx, { autoBackup: autoBackupFor(deps) });
  const meta = (ctx, opts, freshness) => ({ requestId: ctx.requestId, accountId: opts.accountId ?? null, ...(freshness ? { freshness } : {}) });
  const underlyingOf = (q) => {
    const u = opt(q, "underlying");
    if (!u) throw invalid("underlying", "underlying is required, for example NIFTY.");
    return u;
  };
  const daysTo = (expiry) => Math.max(0, daysBetween(new Date(nowMsOf(deps)), expiry));

  async function multi(ctx, defaultCount, maxCount, greeks) {
    const underlying = underlyingOf(ctx.query);
    const count = intParam(ctx.query, "expiries", 1, maxCount, defaultCount);
    const strikes = intParam(ctx.query, "strikes", 1, 100);
    const opts = readOptions(ctx);
    const list = await md().expiries(underlying, opts);
    const picked = upcomingExpiries(list.expiries, nowMsOf(deps)).slice(0, count);
    const charts = [];
    for (const expiry of picked) {
      const params = { underlying, expiry, greeks };
      if (strikes !== undefined) params.strikes = strikes;
      charts.push({ expiry, chain: await md().optionChain(params, opts) });
    }
    return { underlying: underlying.toUpperCase(), charts, opts, freshness: list.freshness };
  }

  return [
    [
      "GET",
      "/v1/analytics/exposure",
      { scope: "read" },
      async (ctx) => {
        const q = ctx.query;
        const underlying = underlyingOf(q);
        const expiry = opt(q, "expiry");
        if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw invalid("expiry", "expiry is required as YYYY-MM-DD.");
        const params = { underlying, expiry, greeks: true };
        const strikes = intParam(q, "strikes", 1, 100);
        if (strikes !== undefined) params.strikes = strikes;
        const opts = readOptions(ctx);
        const chain = await md().optionChain(params, opts);
        return { data: greekExposure(chain, { days: daysTo(expiry) }), meta: meta(ctx, opts, chain.freshness) };
      },
    ],
    [
      "GET",
      "/v1/analytics/exposure/expiries",
      { scope: "read" },
      async (ctx) => {
        const { underlying, charts, opts, freshness } = await multi(ctx, 3, 6, true);
        const items = charts.map(({ expiry, chain }) => greekExposure(chain, { days: daysTo(expiry) }));
        return { data: { underlying, ...exposureAcrossExpiries(items) }, meta: meta(ctx, opts, freshness) };
      },
    ],
    [
      "GET",
      "/v1/analytics/oi-explorer",
      { scope: "read" },
      async (ctx) => {
        const { underlying, charts, opts, freshness } = await multi(ctx, 4, 8, false);
        return { data: { underlying, ...oiMatrix(charts) }, meta: meta(ctx, opts, freshness) };
      },
    ],
  ];
}
