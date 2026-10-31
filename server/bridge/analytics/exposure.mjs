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
import { CHAIN_READS, gammaExposure, nowMsOf, unitMultiplier, upcomingExpiries } from "./math.mjs";
import { mapSettledLimit } from "../../lib/batch.mjs";
import { gexProfile } from "./gexProfile.mjs";

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
  const lot = unitMultiplier(chain); // OI is in units on this Bridge
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

// ── Through the session: the recorder's readings re-solved one at a time ──

/** At most this many readings in a session series (one in each `every` minutes, thinned evenly beyond it). */
export const SESSION_POINTS = 120;
const IST_MS = 330 * 60_000;
const istDay = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);

/**
 * One recorder snapshot (the stored shape: k, ce / pe { oi, iv } arrays, spot, t in years, OI in units) as the option
 * chain greekExposure and gexProfile read. Gamma is recomputed at spot from each leg's recorded IV (the recorder keeps
 * the IV; gamma at spot keeps the bars and the re-priced curve on one footing). Null without a spot or a time left.
 * @returns {{ chain: object, days: number } | null}
 */
export function snapshotChain(snap, { underlying = null, expiry = null, rate = DEFAULT_RATE } = {}) {
  const spot = Number(snap?.spot);
  const years = Number(snap?.t);
  if (!(spot > 0) || !(years > 0) || !Array.isArray(snap?.k)) return null;
  const days = years * 365;
  const leg = (side, i, strike, type) => {
    const oi = Number(snap?.[side]?.oi?.[i]);
    const iv = Number(snap?.[side]?.iv?.[i]);
    if (!(oi > 0)) return null;
    if (!(iv > 0)) return { oi, iv: null, gamma: null };
    return { oi, iv, gamma: computeGreeks({ spot, strike, daysToExpiry: days, type, vol: iv / 100, rate }).gamma };
  };
  const rows = snap.k.map((strike, i) => ({ strike, ce: leg("ce", i, strike, "CE"), pe: leg("pe", i, strike, "PE") }));
  return { chain: { underlying, expiry, underlyingLtp: spot, units: "units", lotSize: snap.lot ?? null, rows }, days };
}

/** The full reading of one snapshot: greekExposure's rows and totals, and the profile with its curve. */
export function snapshotExposure(snap, opts = {}) {
  const sc = snapshotChain(snap, opts);
  if (!sc) return null;
  const data = greekExposure(sc.chain, { days: sc.days, rate: opts.rate });
  data.profile = gexProfile(sc.chain, { days: sc.days, rate: opts.rate, strikes: data.strikes });
  return data;
}

/** Keep at most `max` items, evenly spaced, always the first and the last. */
export function thinEvenly(list, max = SESSION_POINTS) {
  if (!Array.isArray(list) || list.length <= max) return list ?? [];
  const out = [];
  for (let i = 0; i < max; i++) out.push(list[Math.round((i * (list.length - 1)) / (max - 1))]);
  return out;
}

/**
 * The gamma book through one session, one point per snapshot (oldest first): spot, net and both-sides gamma, the
 * solved flip, the walls, the lean and the verdict, each as gexProfile reads that minute. The flip scan is coarser
 * than the single-reading route's (120 steps over the same ±25 %, then bisected), and the curve is left out.
 * `ladder` is the number of strikes read at the first and the last point, so a growing ladder can be named.
 */
export function gexSession(snaps, { rate = DEFAULT_RATE } = {}) {
  const points = [];
  for (const snap of snaps ?? []) {
    const sc = snapshotChain(snap, { rate });
    const t = Number(snap?.slot ?? Date.parse(snap?.ts ?? ""));
    if (!sc || !Number.isFinite(t)) continue;
    const g = gammaExposure(sc.chain);
    const p = gexProfile(sc.chain, { days: sc.days, rate, strikes: g.strikes, curve: false, steps: 120 });
    const read = sc.chain.rows.filter((r) => (r.ce?.oi ?? 0) > 0 || (r.pe?.oi ?? 0) > 0).length;
    points.push({ t, spot: p.spot, net: p.net, gross: p.gross, flip: p.flip, callWall: p.callWall, putWall: p.putWall, ladderCross: p.ladderCross, lean: p.lean, verdict: p.verdict, regimeAtSpot: p.regimeAtSpot, strikes: read });
  }
  points.sort((a, b) => a.t - b.t);
  return { points, ladder: points.length ? { first: points[0].strikes, last: points[points.length - 1].strikes } : null };
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
    // CHAIN_READS chains at a time (each still paced by the rate-limit scheduler), in expiry order; the first failure
    // in that order fails the request, as reading one after another did.
    const read = await mapSettledLimit(picked, CHAIN_READS, (expiry) => md().optionChain({ underlying, expiry, greeks, ...(strikes !== undefined ? { strikes } : {}) }, opts));
    const charts = picked.map((expiry, i) => {
      if (read[i].status === "rejected") throw read[i].reason;
      return { expiry, chain: read[i].value };
    });
    return { underlying: underlying.toUpperCase(), charts, opts, freshness: list.freshness };
  }

  // The session series, worked once per chain and recorded minute (a replay asks again for each reading it shows).
  const sessionCache = new Map();
  async function sessionOf(underlying, expiry, every) {
    const rec = deps.recorder;
    if (!rec || typeof rec.snapshots !== "function") return { snaps: [], summary: { day: null, points: [], ladder: null, unavailable: { reason: "no-recorder", detail: "The data recorder is not running on this Bridge." } } };
    const now = nowMsOf(deps);
    // The latest session the recorder holds: today, else the most recent of the four days before (never mixing days).
    let snaps = [];
    let unavailable = null;
    for (let back = 0; back < 5 && !snaps.length; back++) {
      const day = istDay(now - back * 86_400_000);
      const fromMs = Date.parse(`${day}T00:00:00+05:30`);
      const toMs = back ? fromMs + 86_400_000 - 1 : now;
      const page = await rec.snapshots({ underlying, expiry, fromMs, toMs, fields: ["oi", "iv"], every, limit: 500 });
      snaps = page?.snapshots ?? [];
      if (!back) unavailable = page?.unavailable ?? null;
    }
    if (!snaps.length) return { snaps, summary: { day: null, points: [], ladder: null, unavailable } };
    const day = istDay(snaps[snaps.length - 1].slot);
    snaps = thinEvenly(snaps.filter((s) => istDay(s.slot) === day));
    const key = `${underlying}|${expiry}|${every}`;
    const sig = `${snaps.length}|${snaps[0].slot}|${snaps[snaps.length - 1].slot}`;
    const hit = sessionCache.get(key);
    if (hit?.sig === sig) return { snaps, summary: hit.summary };
    const summary = { day, ...gexSession(snaps), unavailable: null };
    sessionCache.delete(key);
    sessionCache.set(key, { sig, summary });
    while (sessionCache.size > 8) sessionCache.delete(sessionCache.keys().next().value);
    return { snaps, summary };
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
        const days = daysTo(expiry);
        const data = greekExposure(chain, { days });
        // The solved gamma flip, the sign-change curve, walls either side of spot and the lean (gexProfile.mjs).
        data.profile = gexProfile(chain, { days, strikes: data.strikes });
        return { data, meta: meta(ctx, opts, chain.freshness) };
      },
    ],
    [
      "GET",
      "/v1/analytics/exposure/expiries",
      { scope: "read" },
      async (ctx) => {
        const { underlying, charts, opts, freshness } = await multi(ctx, 3, 6, true);
        const items = charts.map(({ expiry, chain }) => greekExposure(chain, { days: daysTo(expiry) }));
        const out = exposureAcrossExpiries(items);
        // Each expiry's own solved flip, walls either side of spot, lean and verdict (no curve: the page draws none here).
        out.expiries.forEach((e, i) => {
          const p = gexProfile(charts[i].chain, { days: items[i].daysToExpiry, strikes: items[i].strikes });
          delete p.curve;
          e.profile = p;
        });
        return { data: { underlying, ...out }, meta: meta(ctx, opts, freshness) };
      },
    ],
    [
      "GET",
      "/v1/analytics/exposure/session",
      { scope: "read" },
      async (ctx) => {
        const q = ctx.query;
        const underlying = underlyingOf(q).toUpperCase();
        const expiry = opt(q, "expiry");
        if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw invalid("expiry", "expiry is required as YYYY-MM-DD.");
        const every = intParam(q, "every", 1, 15, 5);
        const atRaw = opt(q, "at");
        const at = atRaw === undefined ? null : /^\d+$/.test(atRaw) ? Number(atRaw) : Date.parse(atRaw);
        if (atRaw !== undefined && !Number.isFinite(at)) throw invalid("at", "at must be an ISO time or epoch milliseconds.");
        const out = await sessionOf(underlying, expiry, every);
        const data = { underlying, expiry, every, ...out.summary };
        // The full reading nearest `at` (bars, levels and curve as the single-reading route gives them), for the replay.
        if (at !== null && out.snaps.length) {
          const snap = out.snaps.reduce((b, s) => (Math.abs(s.slot - at) < Math.abs(b.slot - at) ? s : b));
          const r = snapshotExposure(snap, { underlying, expiry });
          data.reading = r ? { t: snap.slot, ...r } : null;
        }
        return { data, meta: { requestId: ctx.requestId } };
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
