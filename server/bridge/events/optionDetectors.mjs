/**
 * Option detectors (stream S28). Two layers, both incremental:
 *
 *  - Leg detectors run on every option tick in O(1): strike OI surge (ΔOI over a window against the strike's own
 *    recent pace, an EWMA of per-minute |ΔOI|), strike build-up change (classifyBuildup from dashboard/options.js),
 *    premium spike, per-strike IV spike or crush (strikes near the money), unusual volume (volume / OI) and an option
 *    near its price band.
 *  - Chain detectors run on a chain at most once per `chainEveryMs` while it is dirty (O(strikes), off the tick path):
 *    call or put wall shift, PCR level cross and sharp change, max pain shift, ATM straddle expansion or contraction,
 *    ATM IV spike or crush, and the futures basis jump. The chain maths is dashboard/options.js chainSummary (the same
 *    PCR, max pain, walls, straddle and ATM IV the Option Chain shows), not a second implementation.
 *
 * Leg quotes: { ltp, oi, volume, iv (percent or a fraction), oiPrev?, close?, upper?, lower? }.
 */
import { BUILDUP_DIR, BUILDUP_NAMES, chainSummary, classifyBuildup } from "../dashboard/options.js";
import { MinuteRing } from "./detectors.mjs";

const num = (v) => (typeof v === "number" ? (Number.isFinite(v) ? v : null) : v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const pos = (v) => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};
const r2 = (n) => Math.round(n * 100) / 100;
const signed = (n, dp = 1) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(dp)}`;
const grouped = (n) => Math.round(Math.abs(n)).toLocaleString("en-IN");
const strikeText = (k) => (Number.isInteger(k) ? String(k) : String(r2(k)));
/** IV in percent (recorder snapshots store a fraction, brokers send percent). */
export const ivPct = (v) => {
  const n = pos(v);
  if (n === null) return null;
  return n < 3 ? n * 100 : n;
};

const params = (sel, kind) => sel.params?.[kind] ?? {};
const on = (sel, kind) => sel.on.has(kind);
/** Strikes either side of ATM that get per-strike IV events (further out the IV is too noisy to read). */
export const IV_STRIKES_NEAR_ATM = 3;
/** Minutes of history before a strike's own OI pace is trusted. */
export const PACE_WARMUP_MINUTES = 5;

/** A chain's state for one day. */
export function createChainState({ underlying, expiry, lot = 1, kind = "INDEX", name = null, spotSymbol = null }) {
  return {
    underlying,
    expiry,
    lot: pos(lot) ?? 1,
    kind,
    name,
    spotSymbol,
    legs: new Map(),
    strikes: [],
    spot: null,
    fut: null,
    dirty: false,
    lastEvalMs: 0,
    rings: { pcr: new MinuteRing(64), straddle: new MinuteRing(64), atmIv: new MinuteRing(64), basis: new MinuteRing(64) },
    last: { ceWall: null, peWall: null, pcr: null, maxPain: null, atm: null },
    marks: { pcrJumpAt: -1e9, straddleAt: -1e9, ivAt: -1e9, basisAt: -1e9 },
    summary: null,
  };
}

/** The leg state for strike and right, created on first sight. */
export function legOf(chain, strike, right, symbol = null) {
  const key = `${strike}|${right}`;
  let leg = chain.legs.get(key);
  if (!leg) {
    leg = { key, symbol, strike, right, ltp: null, oi: null, vol: null, iv: null, oiRef: null, ltpRef: null, upper: null, lower: null, ringOi: new MinuteRing(64), ringLtp: new MinuteRing(64), ringIv: new MinuteRing(64), pace: 0, paceN: 0, minute: null, minuteOi: null, cls: null, volLevel: 0, spikeAt: -1e9, surgeAt: -1e9, ivAt: -1e9, band: null };
    chain.legs.set(key, leg);
    // Keep strikes sorted: binary insert (new strikes are rare; a tick never pays for it).
    if (!chain.strikes.includes(strike)) {
      let lo = 0;
      let hi = chain.strikes.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (chain.strikes[mid] < strike) lo = mid + 1;
        else hi = mid;
      }
      chain.strikes.splice(lo, 0, strike);
    }
  }
  if (symbol && !leg.symbol) leg.symbol = symbol;
  return leg;
}

/** The ATM strike from the chain's spot (null without one). */
export function atmStrike(chain) {
  const s = chain.spot;
  if (s === null || !chain.strikes.length) return null;
  let best = chain.strikes[0];
  for (const k of chain.strikes) if (Math.abs(k - s) < Math.abs(best - s)) best = k;
  return best;
}

const nearAtm = (chain, strike) => {
  const atm = chain.last.atm;
  if (atm === null) return false;
  const i = chain.strikes.indexOf(atm);
  const j = chain.strikes.indexOf(strike);
  return i >= 0 && j >= 0 && Math.abs(i - j) <= IV_STRIKES_NEAR_ATM;
};

const legLabel = (chain, leg) => `${chain.underlying} ${strikeText(leg.strike)} ${leg.right}`;
/** Who is acting when OI changes on a side: writers add calls (bearish) or puts (bullish). */
const oiDir = (right, dOi) => (right === "CE" ? (dOi > 0 ? -1 : 1) : dOi > 0 ? 1 : -1);
/** A premium move's read for the underlying: calls up or puts down are bullish. */
const pxDir = (right, d) => (right === "CE" ? (d > 0 ? 1 : -1) : d > 0 ? -1 : 1);

/**
 * One option leg tick. O(1). Mutates the leg and marks the chain dirty; returns hits (each carries `leg`).
 */
export function detectLeg(chain, leg, q, sel, t) {
  const hits = [];
  const minute = num(t?.minute) ?? 0;
  const ltp = pos(q.ltp);
  const oi = num(q.oi);
  const vol = num(q.volume);
  const iv = ivPct(q.iv);
  const prevOi = leg.oi;
  if (ltp !== null) leg.ltp = ltp;
  if (oi !== null && oi >= 0) leg.oi = oi;
  if (vol !== null && vol >= 0) leg.vol = vol;
  if (iv !== null) leg.iv = iv;
  if (pos(q.upper) !== null) leg.upper = pos(q.upper);
  if (pos(q.lower) !== null) leg.lower = pos(q.lower);
  if (leg.oiRef === null && leg.oi !== null) leg.oiRef = num(q.oiPrev) ?? leg.oi;
  if (leg.ltpRef === null && leg.ltp !== null) leg.ltpRef = pos(q.close) ?? leg.ltp;
  chain.dirty = true;
  if (leg.ltp === null) return hits;
  const lot = chain.lot;
  const tag = (h) => hits.push({ ...h, leg });

  // Per-minute OI pace (EWMA of |ΔOI| per minute), updated when the minute rolls.
  if (leg.oi !== null) {
    const m = Math.floor(minute);
    if (leg.minute === null) {
      leg.minute = m;
      leg.minuteOi = leg.oi;
    } else if (m > leg.minute) {
      // The pace is built from finished minutes only, so a burst in this minute is measured against the past.
      const closeOi = prevOi ?? leg.oi;
      const perMin = Math.abs(closeOi - leg.minuteOi) / (m - leg.minute);
      leg.pace = leg.paceN === 0 ? perMin : 0.85 * leg.pace + 0.15 * perMin;
      leg.paceN += 1;
      leg.minute = m;
      leg.minuteOi = closeOi;
    }
    leg.ringOi.put(minute, leg.oi);
  }
  leg.ringLtp.put(minute, leg.ltp);
  if (leg.iv !== null) leg.ringIv.put(minute, leg.iv);

  // ── Strike OI surge ──
  if (on(sel, "opt_oi_surge") && leg.oi !== null && leg.paceN >= PACE_WARMUP_MINUTES) {
    const pr = params(sel, "opt_oi_surge");
    const ago = leg.ringOi.ago(minute, pr.windowMinutes);
    if (ago !== null) {
      const d = leg.oi - ago;
      const expected = Math.max(leg.pace * pr.windowMinutes, lot);
      const lots = d / lot;
      if (Math.abs(lots) >= pr.minLots && Math.abs(d) >= pr.multiple * expected && minute - leg.surgeAt >= pr.windowMinutes) {
        leg.surgeAt = minute;
        const x = Math.abs(d) / expected;
        tag({ kind: "opt_oi_surge", variant: `${leg.key}|${d > 0 ? "add" : "cut"}`, dir: oiDir(leg.right, d), strength: r2(x), dOi: d, text: `${legLabel(chain, leg)} OI ${signed(lots, 0).replace(/\d+/, grouped(lots))} lots in ${pr.windowMinutes} min, ${x.toFixed(1)}× its pace` });
      }
    }
  }

  // ── Strike build-up change (since the previous close / first sight) ──
  if (on(sel, "opt_buildup") && leg.oi !== null && leg.oiRef !== null) {
    const pr = params(sel, "opt_buildup");
    const cls = classifyBuildup({ d: leg.oi - leg.oiRef, oiRef: leg.oiRef, dLtp: leg.ltp - leg.ltpRef, ltpRef: leg.ltpRef, v: leg.vol ?? 0 }, { lot, minLots: pr.minLots, minOiPct: 1, minPxPct: 0.5, tick: 0.05, churnX: 1e9 });
    if (cls && cls !== "CH" && cls !== leg.cls) {
      leg.cls = cls;
      const dOi = leg.oi - leg.oiRef;
      const dPx = leg.ltpRef ? ((leg.ltp - leg.ltpRef) / leg.ltpRef) * 100 : 0;
      tag({ kind: "opt_buildup", variant: `${leg.key}|${cls}`, dir: BUILDUP_DIR[cls][leg.right === "CE" ? "ce" : "pe"], strength: r2(dOi / lot), dOi, text: `${legLabel(chain, leg)} ${BUILDUP_NAMES[cls].toLowerCase()}: OI ${signed(dOi / lot, 0).replace(/\d+/, grouped(dOi / lot))} lots, premium ${signed(dPx)} %` });
    }
  }

  // ── Premium spike ──
  if (on(sel, "opt_premium_spike")) {
    const pr = params(sel, "opt_premium_spike");
    const ago = leg.ringLtp.ago(minute, pr.windowMinutes);
    if (ago !== null && ago > 0 && Math.max(ago, leg.ltp) >= pr.minPremium) {
      const d = ((leg.ltp - ago) / ago) * 100;
      if (Math.abs(d) >= pr.pct && minute - leg.spikeAt >= pr.windowMinutes) {
        leg.spikeAt = minute;
        tag({ kind: "opt_premium_spike", variant: `${leg.key}|${d > 0 ? "up" : "down"}`, dir: pxDir(leg.right, d), strength: r2(d), text: `${legLabel(chain, leg)} premium ${signed(d)} % in ${pr.windowMinutes} min (${ago.toFixed(2)} to ${leg.ltp.toFixed(2)})` });
      }
    }
  }

  // ── Per-strike IV spike / crush (near the money) ──
  if ((on(sel, "iv_spike") || on(sel, "iv_crush")) && leg.iv !== null && nearAtm(chain, leg.strike)) {
    for (const kind of ["iv_spike", "iv_crush"]) {
      if (!on(sel, kind)) continue;
      const pr = params(sel, kind);
      const ago = leg.ringIv.ago(minute, pr.windowMinutes);
      if (ago === null) continue;
      const d = leg.iv - ago;
      if ((kind === "iv_spike" ? d >= pr.points : -d >= pr.points) && minute - leg.ivAt >= pr.windowMinutes) {
        leg.ivAt = minute;
        tag({ kind, variant: leg.key, dir: 0, strength: r2(d), text: `${legLabel(chain, leg)} IV ${signed(d)} vol pts in ${pr.windowMinutes} min to ${leg.iv.toFixed(1)} %` });
      }
    }
  }

  // ── Unusual volume (volume / OI) ──
  if (on(sel, "opt_unusual_volume") && leg.vol !== null && leg.oi !== null && leg.oi > 0) {
    const pr = params(sel, "opt_unusual_volume");
    const ratio = leg.vol / leg.oi;
    const level = ratio >= pr.ratio && leg.vol / lot >= pr.minLots ? 1 + Math.floor(Math.log2(ratio / pr.ratio)) : 0;
    if (level > leg.volLevel) {
      leg.volLevel = level;
      tag({ kind: "opt_unusual_volume", variant: `${leg.key}|${level}`, dir: leg.right === "CE" ? 1 : -1, strength: r2(ratio), text: `${legLabel(chain, leg)} volume ${ratio.toFixed(1)}× OI (${grouped(leg.vol / lot)} lots)` });
    }
  }

  // ── Near the price band ──
  if (on(sel, "opt_near_band") && (leg.upper !== null || leg.lower !== null)) {
    const pr = params(sel, "opt_near_band");
    const nearUp = leg.upper !== null && leg.ltp >= leg.upper * (1 - pr.withinPct / 100);
    const nearLo = leg.lower !== null && leg.ltp <= leg.lower * (1 + pr.withinPct / 100);
    const band = nearUp ? "upper" : nearLo ? "lower" : null;
    if (band && band !== leg.band) {
      const price = band === "upper" ? leg.upper : leg.lower;
      tag({ kind: "opt_near_band", variant: `${leg.key}|${band}`, dir: pxDir(leg.right, band === "upper" ? 1 : -1), strength: r2(((leg.ltp - price) / price) * 100), text: `${legLabel(chain, leg)} at ${leg.ltp.toFixed(2)}, ${band} band ${price.toFixed(2)}` });
    }
    leg.band = band;
  }
  return hits;
}

/** The chain as GET /v1/optionchain rows, for the shared chain maths. O(strikes). */
export function chainRows(chain) {
  const rows = [];
  for (const k of chain.strikes) {
    const ce = chain.legs.get(`${k}|CE`);
    const pe = chain.legs.get(`${k}|PE`);
    const leg = (l) => (l && l.ltp !== null ? { symbol: l.symbol, ltp: l.ltp, oi: l.oi, volume: l.vol, iv: l.iv, oiChange: l.oi !== null && l.oiRef !== null ? l.oi - l.oiRef : null } : null);
    rows.push({ strike: k, ce: leg(ce), pe: leg(pe) });
  }
  return rows;
}

/**
 * Chain-level detectors. Call while the chain is dirty, at most once per `everyMs`. Returns hits.
 */
export function detectChain(chain, sel, t, { everyMs = 1000 } = {}) {
  const hits = [];
  const ms = num(t?.ms) ?? 0;
  if (!chain.dirty || ms - chain.lastEvalMs < everyMs) return hits;
  chain.dirty = false;
  chain.lastEvalMs = ms;
  const minute = num(t?.minute) ?? 0;
  const atm = atmStrike(chain);
  const s = chainSummary({ underlyingLtp: chain.spot, atmStrike: atm, rows: chainRows(chain) });
  chain.summary = s;
  chain.last.atm = atm;
  const u = chain.underlying;

  // ── Walls ──
  if (on(sel, "wall_shift")) {
    for (const [side, key, word] of [["ce", "ceWall", "Call wall"], ["pe", "peWall", "Put wall"]]) {
      const w = side === "ce" ? s.resistance : s.support;
      if (!w) continue;
      const was = chain.last[key];
      if (was && was.strike !== w.strike) {
        // A flip between two near-equal strikes is noise: the new wall must lead the old strike by 5 %.
        const oldNow = chain.legs.get(`${was.strike}|${side === "ce" ? "CE" : "PE"}`)?.oi ?? 0;
        if (w.oi >= oldNow * 1.05) {
          hits.push({ kind: "wall_shift", variant: `${side}|${w.strike}`, dir: w.strike > was.strike ? 1 : -1, strength: w.strike, text: `${word} ${strikeText(was.strike)} to ${strikeText(w.strike)} (${grouped(w.oi / chain.lot)} lots)`, chainStrike: w.strike, right: side === "ce" ? "CE" : "PE" });
          chain.last[key] = { strike: w.strike, oi: w.oi };
        }
      } else chain.last[key] = { strike: w.strike, oi: w.oi };
    }
  }

  // ── PCR ──
  if (s.pcr !== null) {
    const was = chain.last.pcr;
    if (on(sel, "pcr_cross") && was !== null) {
      for (const L of params(sel, "pcr_cross").levels ?? []) {
        if (was < L && s.pcr >= L) hits.push({ kind: "pcr_cross", variant: `${L}u`, dir: 1, strength: r2(s.pcr), text: `PCR ${was.toFixed(2)} to ${s.pcr.toFixed(2)}, above ${L}` });
        else if (was >= L && s.pcr < L) hits.push({ kind: "pcr_cross", variant: `${L}d`, dir: -1, strength: r2(s.pcr), text: `PCR ${was.toFixed(2)} to ${s.pcr.toFixed(2)}, below ${L}` });
      }
    }
    chain.last.pcr = s.pcr;
    chain.rings.pcr.put(minute, s.pcr);
    if (on(sel, "pcr_jump")) {
      const pr = params(sel, "pcr_jump");
      const ago = chain.rings.pcr.ago(minute, pr.windowMinutes);
      if (ago !== null && Math.abs(s.pcr - ago) >= pr.change && minute - chain.marks.pcrJumpAt >= pr.windowMinutes) {
        chain.marks.pcrJumpAt = minute;
        const d = s.pcr - ago;
        hits.push({ kind: "pcr_jump", variant: d > 0 ? "up" : "down", dir: d > 0 ? 1 : -1, strength: r2(d), text: `PCR ${signed(d, 2)} in ${pr.windowMinutes} min to ${s.pcr.toFixed(2)}` });
      }
    }
  }

  // ── Max pain ──
  if (s.maxPain !== null) {
    const was = chain.last.maxPain;
    if (on(sel, "max_pain_shift") && was !== null && was !== s.maxPain) hits.push({ kind: "max_pain_shift", variant: String(s.maxPain), dir: s.maxPain > was ? 1 : -1, strength: s.maxPain, text: `max pain ${strikeText(was)} to ${strikeText(s.maxPain)}` });
    chain.last.maxPain = s.maxPain;
  }

  // ── Straddle ──
  if (s.straddle !== null) {
    chain.rings.straddle.put(minute, s.straddle);
    if (on(sel, "straddle_move")) {
      const pr = params(sel, "straddle_move");
      const ago = chain.rings.straddle.ago(minute, pr.windowMinutes);
      if (ago !== null && ago > 0) {
        const d = ((s.straddle - ago) / ago) * 100;
        if (Math.abs(d) >= pr.pct && minute - chain.marks.straddleAt >= pr.windowMinutes) {
          chain.marks.straddleAt = minute;
          hits.push({ kind: "straddle_move", variant: d > 0 ? "up" : "down", dir: 0, strength: r2(d), text: `ATM ${strikeText(s.atm)} straddle ${signed(d)} % in ${pr.windowMinutes} min (${d > 0 ? "expansion" : "contraction"}) to ${s.straddle.toFixed(2)}` });
        }
      }
    }
  }

  // ── ATM IV ──
  if (s.atmIv !== null) {
    chain.rings.atmIv.put(minute, s.atmIv);
    for (const kind of ["iv_spike", "iv_crush"]) {
      if (!on(sel, kind)) continue;
      const pr = params(sel, kind);
      const ago = chain.rings.atmIv.ago(minute, pr.windowMinutes);
      if (ago === null) continue;
      const d = s.atmIv - ago;
      if ((kind === "iv_spike" ? d >= pr.points : -d >= pr.points) && minute - chain.marks.ivAt >= pr.windowMinutes) {
        chain.marks.ivAt = minute;
        hits.push({ kind, variant: "atm", dir: 0, strength: r2(d), text: `ATM IV ${signed(d)} vol pts in ${pr.windowMinutes} min to ${s.atmIv.toFixed(1)} %` });
      }
    }
  }

  // ── Basis ──
  if (chain.fut !== null && chain.spot !== null) {
    const basis = chain.fut - chain.spot;
    chain.rings.basis.put(minute, basis);
    if (on(sel, "basis_jump")) {
      const pr = params(sel, "basis_jump");
      const ago = chain.rings.basis.ago(minute, pr.windowMinutes);
      if (ago !== null) {
        const dPct = ((basis - ago) / chain.spot) * 100;
        if (Math.abs(dPct) >= pr.pct && minute - chain.marks.basisAt >= pr.windowMinutes) {
          chain.marks.basisAt = minute;
          hits.push({ kind: "basis_jump", variant: dPct > 0 ? "up" : "down", dir: dPct > 0 ? 1 : -1, strength: r2(dPct), text: `basis ${ago.toFixed(1)} to ${basis.toFixed(1)} pts (${signed(dPct, 2)} % of spot) in ${pr.windowMinutes} min` });
        }
      }
    }
  }
  return hits;
}
