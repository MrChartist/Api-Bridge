/**
 * The gamma profile of one expiry's book (pure): where the modelled hedging changes sign, and how firmly it leans.
 *
 * Same convention and units as exposure.mjs / math.mjs gammaExposure: Calls count +, Puts −, rupees of hedging per 1 %
 * move, OI in units of the underlying (× `lot` only for a chain marked in lots):
 *   net(P) = Σ_K [ γ(P, K, σ_CE) · callOi_K − γ(P, K, σ_PE) · putOi_K ] · lot · P² · 0.01
 * with γ from lib/blackScholes.mjs computeGreeks (the chain's own gamma), each leg keeping the IV it was solved at and
 * the time to expiry held fixed (the question is where the sign changes now, not tomorrow).
 *
 *   gamma flip     the price where net(P) changes sign, solved by scanning ±`range` around spot and bisecting each
 *                  crossing; the crossing nearest spot is THE flip. Null when none lies in range.
 *   ladder cross   the strike where the running total of each strike's Net (lowest strike up) crosses zero,
 *                  interpolated between the two strikes; a display level, not a re-priced one. Null when it never does.
 *   call wall      the strike ABOVE spot with the largest Call GEX; put wall: the strike BELOW spot with the largest
 *                  Put GEX by size (an unrestricted search would put both on the ATM strike).
 *   heaviest       the strike with the most gamma on both sides (Call + |Put|): no holder assumed.
 *   lean           |Σ Net| ÷ Σ |Net_K|, 0..1: how much of the strike-by-strike exposure survives the sum.
 *   verdict        "dampens" (Net > 0, lean ≥ 10 %), "amplifies" (Net < 0, lean ≥ 10 %), "balanced" (lean < 10 %),
 *                  "unmeasured" (no strike carries a gamma).
 * Read-only; no orders. Never NaN: missing figures are null.
 */
import { computeGreeks, DEFAULT_RATE } from "../../lib/blackScholes.mjs";
import { unitMultiplier } from "./math.mjs";

export const LEAN_BAND = 0.1;
export const FLIP_RANGE = 0.25;
const SCAN_STEPS = 240;
const CURVE_POINTS = 121;

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const pos = (v) => fin(v) && v > 0;
const r0 = (v) => (fin(v) ? Math.round(v) : null);
const r2 = (v) => (fin(v) ? Math.round(v * 100) / 100 : null);
const r4 = (v) => (fin(v) ? Math.round(v * 10000) / 10000 : null);

/** The legs that carry a gamma: { strike, callOi, putOi, callIv, putIv } (OI × lot, IV as a fraction). */
export function profileLegs(chain) {
  const lot = unitMultiplier(chain);
  const legOf = (leg) => (leg && pos(leg.oi) && pos(leg.iv) ? { oi: leg.oi * lot, iv: leg.iv / 100 } : null);
  return (Array.isArray(chain?.rows) ? chain.rows : [])
    .filter((r) => pos(r?.strike))
    .map((r) => {
      const c = legOf(r.ce);
      const p = legOf(r.pe);
      return { strike: r.strike, callOi: c?.oi ?? 0, putOi: p?.oi ?? 0, callIv: c?.iv ?? null, putIv: p?.iv ?? null };
    })
    .filter((l) => l.callIv !== null || l.putIv !== null)
    .sort((a, b) => a.strike - b.strike);
}

/** Net GEX of the legs if the underlying stood at `price` (each leg keeps its IV; `days` fixed). */
export function netGexAt(legs, price, { days, rate = DEFAULT_RATE } = {}) {
  if (!pos(price)) return null;
  const g = (strike, vol) => (vol > 0 ? computeGreeks({ spot: price, strike, daysToExpiry: days, type: "CE", vol, rate }).gamma : 0);
  let sum = 0;
  for (const l of legs ?? []) sum += g(l.strike, l.callIv) * l.callOi - g(l.strike, l.putIv) * l.putOi;
  return sum * price * price * 0.01;
}

/** Every price in [lo, hi] where net(P) changes sign, each narrowed by bisection. */
function crossings(f, lo, hi, steps) {
  const out = [];
  let a = lo;
  let fa = f(a);
  for (let i = 1; i <= steps; i++) {
    const b = lo + ((hi - lo) * i) / steps;
    const fb = f(b);
    if (fin(fa) && fin(fb) && fa !== 0 && fb !== 0 && Math.sign(fa) !== Math.sign(fb)) {
      let x0 = a;
      let x1 = b;
      let f0 = fa;
      for (let k = 0; k < 40 && x1 - x0 > 1e-6 * x1; k++) {
        const m = (x0 + x1) / 2;
        const fm = f(m);
        if (fm === 0) {
          x0 = x1 = m;
          break;
        }
        if (Math.sign(fm) === Math.sign(f0)) {
          x0 = m;
          f0 = fm;
        } else x1 = m;
      }
      out.push((x0 + x1) / 2);
    } else if (fb === 0 && fin(fa) && fa !== 0) out.push(b);
    a = b;
    fa = fb;
  }
  return out;
}

/** The running total of Net from the lowest strike up, and where it crosses zero (nearest spot), interpolated. */
export function ladderCross(strikes, spot) {
  const rows = [...(strikes ?? [])].filter((s) => fin(s?.netGex)).sort((a, b) => a.strike - b.strike);
  const found = [];
  let run = 0;
  let prev = null;
  for (const s of rows) {
    const next = run + s.netGex;
    if (prev && run !== 0 && next !== 0 && Math.sign(run) !== Math.sign(next)) {
      const w = Math.abs(run) / (Math.abs(run) + Math.abs(next));
      found.push(prev.strike + (s.strike - prev.strike) * w);
    }
    run = next;
    prev = s;
  }
  if (!found.length) return null;
  return pos(spot) ? found.reduce((b, x) => (Math.abs(x - spot) < Math.abs(b - spot) ? x : b)) : found[0];
}

/** Verdict from the net and the lean (null lean: unmeasured). */
export function gexVerdict(net, lean) {
  if (!fin(net) || !fin(lean)) return "unmeasured";
  if (lean < LEAN_BAND) return "balanced";
  return net > 0 ? "dampens" : net < 0 ? "amplifies" : "balanced";
}

/**
 * The profile of one chain. `strikes` are greekExposure's rows ({ strike, callGex, putGex, netGex }) so the walls and
 * the lean read the same bars the page draws; the flip and the curve re-price the legs.
 * @param {object} chain  the option chain (rows with ce/pe { oi, iv }, underlyingLtp, units, lotSize)
 * `curve: false` leaves the curve out and `steps` sets the scan's resolution (the session series asks for both, as it
 * solves a profile at every reading).
 * @param {{ days: number, rate?: number, strikes: Array<{strike:number, callGex:number, putGex:number, netGex:number}>, range?: number, curve?: boolean, steps?: number }} o
 */
export function gexProfile(chain, { days, rate = DEFAULT_RATE, strikes = [], range = FLIP_RANGE, curve: withCurve = true, steps = SCAN_STEPS } = {}) {
  const spot = fin(chain?.underlyingLtp) ? chain.underlyingLtp : null;
  const legs = profileLegs(chain);
  const rows = (strikes ?? []).filter((s) => fin(s?.strike));
  const measured = rows.filter((s) => s.callGex !== 0 || s.putGex !== 0);
  const empty = { spot, flip: null, flips: [], flipRange: null, ladderCross: null, callWall: null, putWall: null, heaviest: null, net: null, gross: null, lean: null, verdict: "unmeasured", regimeAtSpot: null, distanceToFlip: null, curve: [] };
  if (!pos(spot) || !legs.length || !measured.length) return empty;
  const opts = { days, rate };
  const f = (p) => netGexAt(legs, p, opts);
  const lo = spot * (1 - range);
  const hi = spot * (1 + range);
  const flips = crossings(f, lo, hi, steps);
  const flip = flips.length ? flips.reduce((b, x) => (Math.abs(x - spot) < Math.abs(b - spot) ? x : b)) : null;
  // The curve spans the strikes read (never wider than the scan), so it lines up with the bars.
  const kLo = Math.max(lo, legs[0].strike);
  const kHi = Math.min(hi, legs[legs.length - 1].strike);
  const curve = [];
  if (withCurve && kHi > kLo) for (let i = 0; i < CURVE_POINTS; i++) {
    const p = kLo + ((kHi - kLo) * i) / (CURVE_POINTS - 1);
    curve.push({ price: r2(p), net: r0(f(p)) });
  }
  const net = rows.reduce((t, s) => t + (s.netGex || 0), 0);
  const gross = rows.reduce((t, s) => t + Math.abs(s.netGex || 0), 0);
  const lean = gross > 0 ? Math.abs(net) / gross : 0; // strikes that all cancel: nothing survives the sum
  const best = (list, score) => list.reduce((b, s) => (score(s) > 0 && (b === null || score(s) > score(b)) ? s : b), null)?.strike ?? null;
  const atSpot = f(spot);
  return {
    spot,
    flip: r2(flip),
    flips: flips.map(r2),
    flipRange: [r2(lo), r2(hi)],
    ladderCross: r2(ladderCross(rows, spot)),
    callWall: best(rows.filter((s) => s.strike > spot), (s) => s.callGex || 0),
    putWall: best(rows.filter((s) => s.strike < spot), (s) => -(s.putGex || 0)),
    heaviest: best(rows, (s) => Math.abs(s.callGex || 0) + Math.abs(s.putGex || 0)),
    net: r0(net),
    gross: r0(gross),
    lean: r4(lean),
    verdict: gexVerdict(net, lean),
    regimeAtSpot: fin(atSpot) ? (atSpot > 0 ? "positive" : atSpot < 0 ? "negative" : "neutral") : null,
    distanceToFlip: flip === null ? null : r2(spot - flip),
    curve,
  };
}
