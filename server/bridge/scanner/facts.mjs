/**
 * Scanner facts (pure): the numbers a live scan reads per symbol, built from parts the data path already holds.
 *
 *   daily      completed daily bars (oldest first), cached once per IST day      → 52-week, 20-day, NR7, HV20 ...
 *   quote      today's live quote (stream, else the shared quote cache)          → the live bar, circuits, volume pace
 *   fut        near / next futures quotes, the near future's previous OI         → OI change, basis, rollover
 *   chain      the recorder's or the option sweep's chain (standard rows)        → PCR, ATM IV, skew, max pain, straddle
 *   ivHistory  [{ date, iv }] stored ATM IV per day                              → IV rank and percentile
 *   mwpl       { mwplPct, inBan } from the reference service
 *
 * buildFacts(raw) gives a flat object keyed by the field ids in dashboard/scan-builder.js FACTS (plus ltp,
 * change_pct, gap_pct, sector, fno, indices, chain hints for the side sheet). Missing parts leave their fields null:
 * a condition on a null field is never a match.
 */
import { volumeShareAt } from "../events/detectors.mjs";
import { sessionMinute } from "../events/engine.mjs";
import { chainSummary } from "../dashboard/options.js";
import { ivRank, realisedVol } from "../dashboard/pricing.js";
import { IST_OFFSET_S } from "./indicators.mjs";

const num = (v) => (v === null || v === undefined || v === "" || typeof v === "boolean" || !Number.isFinite(Number(v)) ? null : Number(v));
const r2 = (v) => (v === null ? null : Math.round(v * 100) / 100);
const r4 = (v) => (v === null ? null : Math.round(v * 10_000) / 10_000);
const pct = (a, b) => (a === null || b === null || b === 0 ? null : ((a - b) / b) * 100);
const IST_OFFSET_MS = IST_OFFSET_S * 1000;
export const istDay = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

/** Minutes since the NSE open for a time (0 before the open; the open is the events engine's session clock). */
export function sessionMinuteOf(ms) {
  return Math.max(0, sessionMinute(ms));
}

/** The IST day of a candle (time in seconds or ms). */
const dayOfBar = (c) => (typeof c.time === "number" ? istDay(c.time < 1e12 ? c.time * 1000 : c.time) : String(c.time ?? "").slice(0, 10));

/** Completed daily bars only (drops today's partial bar), sanitised, oldest first. */
export function completedBars(candles, today) {
  return (candles ?? []).filter((c) => c && num(c.close) !== null && num(c.high) !== null && num(c.low) !== null && dayOfBar(c) < today);
}

/**
 * Facts from completed daily bars (once per symbol per day).
 * @param {Array<{ time, open, high, low, close, volume }>} bars oldest first, today's bar excluded
 */
export function dailyFacts(bars) {
  const n = bars.length;
  if (!n) return null;
  const last = bars[n - 1];
  const prev = n >= 2 ? bars[n - 2] : null;
  const year = bars.slice(-252);
  const vols = bars.slice(-20).map((b) => num(b.volume)).filter((v) => v !== null && v > 0);
  const ranges = bars.slice(-7).map((b) => b.high - b.low);
  const lastRange = last.high - last.low;
  return {
    prev_close: num(last.close),
    prev_high: num(last.high),
    prev_low: num(last.low),
    prev_volume: num(last.volume),
    high_52w: year.length >= 20 ? Math.max(...year.map((b) => b.high)) : null,
    low_52w: year.length >= 20 ? Math.min(...year.map((b) => b.low)) : null,
    avg_volume_20: vols.length >= 5 ? Math.round(vols.reduce((a, b) => a + b, 0) / vols.length) : null,
    hv20: r2(realisedVol(bars.map((b) => b.close), 20)),
    nr7: ranges.length === 7 ? (ranges.slice(0, 6).every((x) => x > lastRange) ? 1 : 0) : null,
    inside_day: prev ? (last.high <= prev.high && last.low >= prev.low && !(last.high === prev.high && last.low === prev.low) ? 1 : 0) : null,
    bars: n,
  };
}

/** The circuit band of a stock when the feed sends none: 10 % for F&O stocks (the first dynamic band), else 20 %. */
export const defaultBandPct = (fno) => (fno ? 10 : 20);

/**
 * Chain facts from a standard chain ({ underlyingLtp, atmStrike, expiry, lotSize, rows: [{ strike, ce, pe }] }).
 * IV values are in percent.
 * @param {object} chain @param {number|null} spot @param {number} nowMs
 */
export function chainFacts(chain, spot, nowMs) {
  const rows = (chain?.rows ?? []).filter((r) => num(r?.strike) !== null);
  if (!rows.length) return null;
  const s = chainSummary({ ...chain, rows, underlyingLtp: num(chain.underlyingLtp) ?? spot });
  const px = num(spot) ?? s.spot;
  const atmIv = num(s.atmIv);
  const dte = chain.expiry ? Math.max(0, (Date.parse(`${chain.expiry}T15:30:00+05:30`) - nowMs) / 86_400_000) : null;
  // IV of the strike nearest 5 % out of the money on each side.
  const ivAt = (target, side) => {
    let best = null;
    for (const r of rows) {
      const iv = num(r[side]?.iv);
      if (iv === null || iv <= 0) continue;
      if (!best || Math.abs(r.strike - target) < Math.abs(best.strike - target)) best = { strike: r.strike, iv };
    }
    return best && px && Math.abs(best.strike - target) / px < 0.03 ? best : null;
  };
  const otmPut = px ? ivAt(px * 0.95, "pe") : null;
  const otmCall = px ? ivAt(px * 1.05, "ce") : null;
  // The strike whose OI changed most (absolute), as % of its previous OI.
  let top = null;
  let unusual = null;
  for (const r of rows) {
    for (const side of ["ce", "pe"]) {
      const leg = r[side];
      const oi = num(leg?.oi);
      const chg = num(leg?.oiChange);
      if (oi !== null && chg !== null && oi - chg > 0) {
        const p = (chg / (oi - chg)) * 100;
        if (!top || Math.abs(chg) > Math.abs(top.chg)) top = { strike: r.strike, right: side === "ce" ? "CE" : "PE", chg, pct: p };
      }
      const vol = num(leg?.volume);
      // Strikes with little OI make volume / OI meaningless: at least 2 % of the chain's largest OI.
      if (oi !== null && vol !== null && oi > 0 && oi >= 0.02 * (s.maxOi || 0)) {
        const x = vol / oi;
        if (!unusual || x > unusual.x) unusual = { strike: r.strike, right: side === "ce" ? "CE" : "PE", x };
      }
    }
  }
  const straddlePct = s.straddle !== null && px ? (s.straddle / px) * 100 : null;
  const movePct = atmIv !== null && dte !== null ? atmIv * Math.sqrt(Math.max(dte, 0.25) / 365) : null;
  return {
    expiry: chain.expiry ?? null,
    lot: num(chain.lotSize),
    atm: s.atm,
    pcr: r4(s.pcr),
    atm_iv: r2(atmIv),
    put_skew: otmPut && atmIv !== null ? r2(otmPut.iv - atmIv) : null,
    call_skew: otmCall && atmIv !== null ? r2(otmCall.iv - atmIv) : null,
    max_pain: s.maxPain,
    max_pain_dist_pct: s.maxPain !== null && px ? r2(((px - s.maxPain) / px) * 100) : null,
    straddle: r2(s.straddle),
    straddle_pct: r2(straddlePct),
    expected_move_pct: r2(movePct),
    straddle_vs_move: straddlePct !== null && movePct ? r4(straddlePct / movePct) : null,
    call_wall: s.resistance?.strike ?? null,
    put_wall: s.support?.strike ?? null,
    top_oi_chg_pct: top ? r2(top.pct) : null,
    top_oi_chg_strike: top?.strike ?? null,
    top_oi_chg_right: top?.right ?? null,
    max_vol_oi: unusual ? r2(unusual.x) : null,
    max_vol_oi_strike: unusual?.strike ?? null,
    max_vol_oi_right: unusual?.right ?? null,
    dte: dte === null ? null : r2(dte),
  };
}

/**
 * Every fact for one symbol.
 * @param {{ symbol: string, daily?: object|null, quote?: object|null, fut?: { near?: object, next?: object, prevOi?: number|null, expiry?: string }|null,
 *   chain?: object|null, ivHistory?: Array<{ date: string, iv: number }>, mwpl?: { mwplPct?: number|null, inBan?: boolean|null }|null,
 *   meta?: { sector?: string|null, fno?: boolean, indices?: string[] } }} raw
 * @param {number} nowMs
 */
export function buildFacts(raw, nowMs) {
  const d = raw.daily ?? {};
  const q = raw.quote ?? {};
  const meta = raw.meta ?? {};
  const ltp = num(q.ltp);
  const prevClose = num(q.close) ?? num(d.prev_close);
  const high = num(q.high);
  const low = num(q.low);
  const open = num(q.open);
  const fno = meta.fno === true;
  const band = defaultBandPct(fno);
  const upper = num(q.upper) ?? (prevClose !== null ? prevClose * (1 + band / 100) : null);
  const lower = num(q.lower) ?? (prevClose !== null ? prevClose * (1 - band / 100) : null);
  // The demo market runs its own session clock (q.sessionMinute); live quotes use the time they describe.
  const share = volumeShareAt(num(q.sessionMinute) ?? sessionMinuteOf(num(q.atMs) ?? nowMs));
  const volume = num(q.volume);
  const avgVol = num(d.avg_volume_20);
  const out = {
    ltp,
    change_pct: r2(pct(ltp, prevClose)),
    gap_pct: r2(pct(open, prevClose)),
    day_high: high,
    day_low: low,
    volume,
    range_pct: high !== null && low !== null && prevClose ? r2(((high - low) / prevClose) * 100) : null,
    prev_close: prevClose,
    prev_high: num(d.prev_high),
    prev_low: num(d.prev_low),
    high_52w: num(d.high_52w),
    low_52w: num(d.low_52w),
    from_52w_high_pct: ltp !== null && num(d.high_52w) ? r2(((num(d.high_52w) - ltp) / num(d.high_52w)) * 100) : null,
    upper_circuit: r2(upper),
    lower_circuit: r2(lower),
    to_upper_circuit_pct: upper !== null && ltp ? r2(((upper - ltp) / ltp) * 100) : null,
    to_lower_circuit_pct: lower !== null && ltp ? r2(((ltp - lower) / ltp) * 100) : null,
    nr7: num(d.nr7),
    inside_day: num(d.inside_day),
    avg_volume_20: avgVol,
    vol_pace: volume !== null && avgVol && share > 0 ? r2(volume / (avgVol * share)) : null,
    hv20: num(d.hv20),
    sector: meta.sector ?? null,
    fno,
    indices: meta.indices ?? [],
  };

  // Futures
  const near = raw.fut?.near ?? null;
  const next = raw.fut?.next ?? null;
  const futLtp = num(near?.ltp);
  const futOi = num(near?.oi);
  const prevOi = num(raw.fut?.prevOi);
  const nearOi = futOi;
  const nextOi = num(next?.oi);
  const futDays = raw.fut?.expiry ? Math.max(1, (Date.parse(`${raw.fut.expiry}T15:30:00+05:30`) - nowMs) / 86_400_000) : null;
  const basis = futLtp !== null && ltp !== null ? futLtp - ltp : null;
  const basisPct = basis !== null && ltp ? (basis / ltp) * 100 : null;
  Object.assign(out, {
    fut_ltp: futLtp,
    fut_change_pct: r2(pct(futLtp, num(near?.close))),
    fut_oi: futOi,
    fut_oi_change_pct: futOi !== null && prevOi ? r2(((futOi - prevOi) / prevOi) * 100) : null,
    basis: r2(basis),
    basis_pct: r4(basisPct),
    basis_ann_pct: basisPct !== null && futDays ? r2((basisPct * 365) / futDays) : null,
    rollover_pct: nearOi !== null && nextOi !== null && nearOi + nextOi > 0 ? r2((nextOi / (nearOi + nextOi)) * 100) : null,
    fut_expiry: raw.fut?.expiry ?? null,
  });

  // MWPL
  out.mwpl_pct = num(raw.mwpl?.mwplPct);
  out.in_ban = raw.mwpl?.inBan === true ? 1 : raw.mwpl?.inBan === false ? 0 : null;

  // Options
  const c = raw.chain ? chainFacts(raw.chain, ltp, nowMs) : null;
  for (const k of ["pcr", "atm_iv", "put_skew", "call_skew", "max_pain", "max_pain_dist_pct", "straddle", "straddle_pct", "expected_move_pct", "straddle_vs_move", "call_wall", "put_wall", "top_oi_chg_pct", "top_oi_chg_strike", "top_oi_chg_right", "max_vol_oi", "max_vol_oi_strike", "max_vol_oi_right", "dte", "atm", "expiry", "lot"]) {
    out[k === "atm" ? "atm_strike" : k === "expiry" ? "chain_expiry" : k] = c ? c[k] : null;
  }
  out.iv_hv_gap = out.atm_iv !== null && out.hv20 !== null ? r2(out.atm_iv - out.hv20) : null;
  const rk = out.atm_iv !== null ? ivRank(raw.ivHistory ?? [], out.atm_iv, { minN: 20 }) : null;
  out.iv_rank = rk?.ivr === null || rk?.ivr === undefined ? null : r2(Math.min(100, Math.max(0, rk.ivr)));
  out.iv_percentile = rk?.ivp === null || rk?.ivp === undefined ? null : r2(rk.ivp);
  out.iv_days = rk?.n ?? 0;
  return out;
}

/**
 * Daily bars plus today's live bar (for the candle functions: sma(50), highest(20)[1], rsi(14) ...). Without a live
 * price the bars end at the last full day.
 */
export function liveBars(bars, quote, nowMs) {
  const ltp = num(quote?.ltp);
  if (ltp === null) return bars;
  const open = num(quote.open) ?? ltp;
  const bar = {
    time: Math.floor((num(quote.atMs) ?? nowMs) / 1000),
    open,
    high: Math.max(num(quote.high) ?? ltp, ltp, open),
    low: Math.min(num(quote.low) ?? ltp, ltp, open),
    close: ltp,
    volume: num(quote.volume) ?? NaN,
  };
  return [...bars, bar];
}
