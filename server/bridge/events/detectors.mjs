/**
 * Stock and index detectors (stream S28). Pure and incremental: each symbol keeps a small state object, and
 * detectStock(state, quote, sel, t) does O(1) work per tick (no history rescans) and returns the hits this tick
 * produced. The engine (engine.mjs) turns hits into event records, dedupes repeats inside the cool-down and stores them.
 *
 * Inputs
 *  quote  { ltp, open, high, low, close (previous close), volume, oi, bid, ask, bidQty, askQty, avgPrice?, upper?, lower? }
 *  ctx    the symbol's previous-day context { prevClose, prevHigh, prevLow, prevVolume, avgVolume, high52, low52 } (any
 *         field may be null: a holiday, a new listing or a feed without history; the kinds that need it then stay quiet)
 *  t      { ms, minute } — minute = minutes since the session opened (09:15 IST; the demo clock in demo mode)
 *  sel    { on: Set<kind>, params: { [kind]: object } }
 *
 * A hit is { kind, variant, dir (+1 / −1 / 0), strength (number), text (context words), level? }.
 */
import { classifyBuildup, BUILDUP_NAMES } from "../dashboard/options.js";

export const CIRCUIT_BANDS = Object.freeze([2, 5, 10, 20]);
/** NSE cash session length in minutes (09:15 to 15:30). */
export const SESSION_MINUTES = 375;

const num = (v) => (typeof v === "number" ? (Number.isFinite(v) ? v : null) : v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const pos = (v) => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};
const r2 = (n) => Math.round(n * 100) / 100;
/** Plain ASCII-free number words for context text: format.js is the dashboard's formatter; the server text stays simple. */
const f1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
const f2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
const signed = (n, dp = 1) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(dp)}`;

// ── Intraday volume curve ──

/**
 * Share of a day's volume traded by minute m of the session (0..375): the usual NSE U shape, heavy at the open and in
 * the last half hour. Precomputed once; volumeShareAt is a table lookup.
 */
const CURVE = (() => {
  const w = [];
  for (let m = 0; m < SESSION_MINUTES; m += 1) w.push(1 + 2.4 * Math.exp(-m / 22) + 1.6 * Math.exp(-(SESSION_MINUTES - 1 - m) / 28));
  const total = w.reduce((a, b) => a + b, 0);
  const out = new Float64Array(SESSION_MINUTES + 1);
  let acc = 0;
  for (let m = 0; m < SESSION_MINUTES; m += 1) {
    out[m] = acc / total;
    acc += w[m];
  }
  out[SESSION_MINUTES] = 1;
  return out;
})();
export function volumeShareAt(minute) {
  const m = num(minute);
  if (m === null || m <= 0) return 0;
  if (m >= SESSION_MINUTES) return 1;
  const i = Math.floor(m);
  return CURVE[i] + (CURVE[i + 1] - CURVE[i]) * (m - i);
}

// ── Circuit bands ──

const onGrid = (n, tick, mode) => {
  const k = n / tick;
  const q = mode === "floor" ? Math.floor(k + 1e-9) : mode === "ceil" ? Math.ceil(k - 1e-9) : Math.round(k);
  return Number((q * tick).toFixed(4));
};

/**
 * Where a price sits against its circuit bands. A broker band (quote.upper / quote.lower) wins; otherwise each NSE
 * band (2, 5, 10, 20 %) of the previous close is tried, with the band price rounded to the tick every way an exchange
 * may round it (down, nearest, up), because a published band of 5 % on 164.52 is 172.75 on a 0.05 tick but 172.74 on
 * a 0.01 tick. Returns { at: "upper" | "lower" | null, bandPct, price }.
 */
export function circuitAt(quote, prevClose, tick = 0.05) {
  const ltp = pos(quote?.ltp);
  if (ltp === null) return { at: null, bandPct: null, price: null };
  const eps = Math.max(1e-6, tick * 0.01);
  const up = pos(quote?.upper);
  const lo = pos(quote?.lower);
  const pc = pos(prevClose);
  if (up !== null && ltp >= up - eps) return { at: "upper", bandPct: pc ? r2((up / pc - 1) * 100) : null, price: up };
  if (lo !== null && ltp <= lo + eps) return { at: "lower", bandPct: pc ? r2((1 - lo / pc) * 100) : null, price: lo };
  if (up !== null || lo !== null || pc === null) return { at: null, bandPct: null, price: null };
  const ticks = tick === 0.01 ? [0.01] : [tick, 0.01];
  for (const b of CIRCUIT_BANDS) {
    for (const tk of ticks) {
      for (const mode of ["floor", "round", "ceil"]) {
        const u = onGrid(pc * (1 + b / 100), tk, mode);
        if (Math.abs(ltp - u) <= eps) return { at: "upper", bandPct: b, price: u };
        const l = onGrid(pc * (1 - b / 100), tk, mode);
        if (Math.abs(ltp - l) <= eps) return { at: "lower", bandPct: b, price: l };
      }
    }
  }
  return { at: null, bandPct: null, price: null };
}

/** Classic floor pivots from the previous day's high, low and close; null when any is missing. */
export function pivots(ctx) {
  const H = pos(ctx?.prevHigh);
  const L = pos(ctx?.prevLow);
  const C = pos(ctx?.prevClose);
  if (H === null || L === null || C === null) return null;
  const P = (H + L + C) / 3;
  return { P: r2(P), R1: r2(2 * P - L), S1: r2(2 * P - H), R2: r2(P + (H - L)), S2: r2(P - (H - L)) };
}

// ── Minute ring: the value of a series N minutes ago in O(1) ──

export class MinuteRing {
  constructor(size = 64) {
    this.size = size;
    this.min = new Int32Array(size).fill(-1e9);
    this.val = new Float64Array(size);
  }
  /** Record the latest value for minute m (the last write in a minute wins). */
  put(m, v) {
    const mi = Math.floor(m);
    const i = ((mi % this.size) + this.size) % this.size;
    this.min[i] = mi;
    this.val[i] = v;
  }
  /** The value at minute m − k, or the nearest earlier minute within 3; null when the ring has none. */
  ago(m, k) {
    const target = Math.floor(m) - k;
    for (let d = 0; d <= 3; d += 1) {
      const mm = target - d;
      const i = ((mm % this.size) + this.size) % this.size;
      if (this.min[i] === mm) return this.val[i];
    }
    return null;
  }
  /** The oldest value the ring holds within `k` minutes back (for a ring warming up). */
  first(m, k) {
    for (let d = k; d >= 1; d -= 1) {
      const v = this.ago(m, d);
      if (v !== null) return v;
    }
    return null;
  }
}

// ── State ──

/** A fresh per-symbol state for one day. */
export function createStockState(meta = {}, ctx = {}) {
  return {
    meta,
    ctx: ctx ?? {},
    seen: 0,
    last: null,
    hi: null,
    lo: null,
    chg: null,
    gapPct: null,
    gapDone: false,
    gapFilled: false,
    volDone: false,
    surgeLevel: 0,
    lock: null,
    lockBand: null,
    pv: 0,
    vv: 0,
    lastVol: null,
    vwap: null,
    vwapSide: 0,
    pivotSide: null,
    swing: { dir: 0, hi: null, lo: null, ext: null },
    fut: null,
  };
}

const params = (sel, kind) => sel.params?.[kind] ?? {};
const on = (sel, kind) => sel.on.has(kind);

/**
 * Run every enabled stock detector on one quote. Mutates `s`, returns hits.
 * @param {ReturnType<typeof createStockState>} s
 */
export function detectStock(s, quote, sel, t) {
  const hits = [];
  const ltp = pos(quote?.ltp);
  if (ltp === null) return hits;
  const ctx = s.ctx ?? {};
  const prev = pos(quote.close) ?? pos(ctx.prevClose);
  const minute = num(t?.minute) ?? 0;
  const first = s.seen === 0;
  s.seen += 1;
  const last = s.last;
  s.last = ltp;
  const isIndex = s.meta?.kind === "INDEX";

  // Change from the previous close.
  const chg = prev ? ((ltp - prev) / prev) * 100 : null;
  const lastChg = s.chg;
  s.chg = chg;

  // ── Gaps (the open against the previous close; fired only near the open) ──
  const open = pos(quote.open);
  if (!s.gapDone && open !== null && prev !== null) {
    s.gapDone = true;
    s.gapPct = ((open - prev) / prev) * 100;
    if (minute <= 15) {
      if (on(sel, "gap_up") && s.gapPct >= params(sel, "gap_up").minPct) hits.push({ kind: "gap_up", variant: "", dir: 1, strength: r2(s.gapPct), text: `gap ${signed(s.gapPct)} % at ${f2(open)}` });
      if (on(sel, "gap_down") && -s.gapPct >= params(sel, "gap_down").minPct) hits.push({ kind: "gap_down", variant: "", dir: -1, strength: r2(s.gapPct), text: `gap ${signed(s.gapPct)} % at ${f2(open)}` });
    }
  }
  if (on(sel, "gap_filled") && !s.gapFilled && s.gapPct !== null && prev !== null && Math.abs(s.gapPct) >= params(sel, "gap_filled").minPct) {
    const low = pos(quote.low) ?? ltp;
    const high = pos(quote.high) ?? ltp;
    if ((s.gapPct > 0 && Math.min(low, ltp) <= prev) || (s.gapPct < 0 && Math.max(high, ltp) >= prev)) {
      s.gapFilled = true;
      hits.push({ kind: "gap_filled", variant: s.gapPct > 0 ? "up" : "down", dir: s.gapPct > 0 ? -1 : 1, strength: r2(s.gapPct), text: `${signed(s.gapPct)} % gap filled at ${f2(prev)}` });
    }
  }

  // ── Day high / low ──
  const qh = pos(quote.high);
  const ql = pos(quote.low);
  const hiNow = Math.max(ltp, qh ?? ltp);
  const loNow = Math.min(ltp, ql ?? ltp);
  if (s.hi === null) {
    s.hi = hiNow;
    s.lo = loNow;
  } else {
    if (hiNow > s.hi) {
      const was = s.hi;
      s.hi = hiNow;
      if (on(sel, "day_high") && minute >= params(sel, "day_high").afterMinutes && ltp >= was) hits.push({ kind: "day_high", variant: "", dir: 1, strength: r2(chg ?? 0), text: `new high ${f2(hiNow)}${chg !== null ? `, ${signed(chg, 2)} % on the day` : ""}` });
    }
    if (loNow < s.lo) {
      const was = s.lo;
      s.lo = loNow;
      if (on(sel, "day_low") && minute >= params(sel, "day_low").afterMinutes && ltp <= was) hits.push({ kind: "day_low", variant: "", dir: -1, strength: r2(chg ?? 0), text: `new low ${f2(loNow)}${chg !== null ? `, ${signed(chg, 2)} % on the day` : ""}` });
    }
  }

  // ── % move levels ──
  if (on(sel, "move_pct") && chg !== null) {
    for (const L of params(sel, "move_pct").levels ?? []) {
      if (chg >= L && (lastChg === null || lastChg < L)) hits.push({ kind: "move_pct", variant: `${L}u`, dir: 1, strength: r2(chg), level: L, text: `up ${f1(L)} %: ${signed(chg, 2)} % at ${f2(ltp)}` });
      if (chg <= -L && (lastChg === null || lastChg > -L)) hits.push({ kind: "move_pct", variant: `${L}d`, dir: -1, strength: r2(chg), level: -L, text: `down ${f1(L)} %: ${signed(chg, 2)} % at ${f2(ltp)}` });
    }
  }

  // ── Volume ──
  const vol = num(quote.volume);
  if (vol !== null && vol >= 0 && !isIndex) {
    const dir = chg === null ? 0 : chg >= 0 ? 1 : -1;
    const pv = pos(ctx.prevVolume);
    if (on(sel, "vol_above_prev") && !s.volDone && pv !== null && vol >= pv) {
      s.volDone = true;
      hits.push({ kind: "vol_above_prev", variant: "", dir, strength: r2(vol / pv), text: `${f1(vol / pv)}× prev-day volume by ${clockText(t)}` });
    }
    if (on(sel, "vol_surge")) {
      const pr = params(sel, "vol_surge");
      const base = pos(ctx.avgVolume) ?? pv;
      const share = volumeShareAt(minute);
      if (base !== null && minute >= pr.minMinutes && share > 0) {
        const pace = vol / (base * share);
        // Fires at the multiple, then again each time the pace doubles (2.5×, 5×, 10× ...).
        const level = pace >= pr.multiple ? 1 + Math.floor(Math.log2(pace / pr.multiple)) : 0;
        if (level > s.surgeLevel) {
          s.surgeLevel = level;
          hits.push({ kind: "vol_surge", variant: `x${level}`, dir, strength: r2(pace), text: `${f1(pace)}× ${pos(ctx.avgVolume) ? "average" : "prev-day"} pace by ${clockText(t)}` });
        }
      }
    }
    // VWAP built from volume deltas when the feed sends no average price.
    if (pos(quote.avgPrice) === null && s.lastVol !== null && vol > s.lastVol) {
      s.pv += ltp * (vol - s.lastVol);
      s.vv += vol - s.lastVol;
      s.vwap = s.pv / s.vv;
    }
    s.lastVol = vol;
  }

  // The feed's average traded price is the day's VWAP when it sends one.
  if (pos(quote.avgPrice) !== null && !isIndex) s.vwap = pos(quote.avgPrice);

  // ── VWAP cross ──
  if (on(sel, "vwap_cross") && s.vwap !== null && !isIndex) {
    const pr = params(sel, "vwap_cross");
    const buf = (pr.bufferPct / 100) * s.vwap;
    const side = ltp > s.vwap + buf ? 1 : ltp < s.vwap - buf ? -1 : 0;
    if (side !== 0 && side !== s.vwapSide) {
      const was = s.vwapSide;
      s.vwapSide = side;
      if (was !== 0 && minute >= pr.afterMinutes) hits.push({ kind: "vwap_cross", variant: side > 0 ? "up" : "down", dir: side, strength: r2(((ltp - s.vwap) / s.vwap) * 100), text: `${side > 0 ? "above" : "below"} VWAP ${f2(s.vwap)}` });
    }
  }

  // ── Circuits ──
  if (!isIndex && (on(sel, "only_buyers") || on(sel, "only_sellers") || on(sel, "circuit_unlocked"))) {
    const c = circuitAt(quote, prev, s.meta?.tick ?? 0.05);
    const bq = num(quote.bidQty);
    const aq = num(quote.askQty);
    const bid = pos(quote.bid);
    const ask = pos(quote.ask);
    const noSell = aq === 0 || (aq === null && ask === null && bid !== null);
    const noBuy = bq === 0 || (bq === null && bid === null && ask !== null);
    let lock = null;
    if (c.at === "upper" && noSell && (bq === null || bq > 0)) lock = "upper";
    else if (c.at === "lower" && noBuy && (aq === null || aq > 0)) lock = "lower";
    if (lock && lock !== s.lock) {
      s.lock = lock;
      s.lockBand = c.bandPct;
      const band = c.bandPct !== null ? `${f1(c.bandPct).replace(/\.0$/, "")} %` : "band";
      const qty = lock === "upper" ? bq : aq;
      const qtyText = qty !== null && qty > 0 ? `, ${Math.round(qty)} ${lock === "upper" ? "bid" : "offered"}` : "";
      if (lock === "upper" && on(sel, "only_buyers")) hits.push({ kind: "only_buyers", variant: "", dir: 1, strength: c.bandPct ?? 0, text: `upper circuit ${band} at ${f2(c.price)}${qtyText}` });
      if (lock === "lower" && on(sel, "only_sellers")) hits.push({ kind: "only_sellers", variant: "", dir: -1, strength: c.bandPct ?? 0, text: `lower circuit ${band} at ${f2(c.price)}${qtyText}` });
    } else if (!lock && s.lock) {
      // Unlocked: off the band, or both sides quoted again.
      const offBand = c.at === null;
      const twoSided = (bq ?? 0) > 0 && (aq ?? 0) > 0;
      if (offBand || twoSided) {
        const was = s.lock;
        s.lock = null;
        if (on(sel, "circuit_unlocked")) hits.push({ kind: "circuit_unlocked", variant: was, dir: was === "upper" ? -1 : 1, strength: s.lockBand ?? 0, text: `${was} circuit ${s.lockBand !== null ? `${f1(s.lockBand).replace(/\.0$/, "")} % ` : ""}unlocked at ${f2(ltp)}` });
      }
    }
  }

  // ── Previous-day levels and pivots ──
  const ph = pos(ctx.prevHigh);
  const pl = pos(ctx.prevLow);
  if (last !== null) {
    if (on(sel, "prev_high_break") && ph !== null && last <= ph && ltp > ph) hits.push({ kind: "prev_high_break", variant: "", dir: 1, strength: r2(((ltp - ph) / ph) * 100), text: `above prev high ${f2(ph)}` });
    if (on(sel, "prev_low_break") && pl !== null && last >= pl && ltp < pl) hits.push({ kind: "prev_low_break", variant: "", dir: -1, strength: r2(((ltp - pl) / pl) * 100), text: `below prev low ${f2(pl)}` });
    const h52 = pos(ctx.high52);
    const l52 = pos(ctx.low52);
    const ath = pos(ctx.allTimeHigh);
    const atl = pos(ctx.allTimeLow);
    const since = ctx.historyFrom ? ` (data since ${ctx.historyFrom})` : "";
    if (on(sel, "all_time_high") && ath !== null && last <= ath && ltp > ath) hits.push({ kind: "all_time_high", variant: "", dir: 1, strength: r2(((ltp - ath) / ath) * 100), text: `above all-time high ${f2(ath)}${since}` });
    if (on(sel, "all_time_low") && atl !== null && last >= atl && ltp < atl) hits.push({ kind: "all_time_low", variant: "", dir: -1, strength: r2(((ltp - atl) / atl) * 100), text: `below all-time low ${f2(atl)}${since}` });
    if (on(sel, "high_52w") && h52 !== null && last <= h52 && ltp > h52) hits.push({ kind: "high_52w", variant: "", dir: 1, strength: r2(((ltp - h52) / h52) * 100), text: `above 52-week high ${f2(h52)}` });
    if (on(sel, "low_52w") && l52 !== null && last >= l52 && ltp < l52) hits.push({ kind: "low_52w", variant: "", dir: -1, strength: r2(((ltp - l52) / l52) * 100), text: `below 52-week low ${f2(l52)}` });
    if (on(sel, "pivot_cross")) {
      const pv = s.pivots === undefined ? (s.pivots = pivots(ctx)) : s.pivots;
      if (pv) {
        for (const name of ["S1", "P", "R1"]) {
          const lv = pv[name];
          if (last <= lv && ltp > lv) hits.push({ kind: "pivot_cross", variant: `${name}u`, dir: 1, strength: r2(((ltp - lv) / lv) * 100), text: `crossed above ${name} ${f2(lv)}` });
          else if (last >= lv && ltp < lv) hits.push({ kind: "pivot_cross", variant: `${name}d`, dir: -1, strength: r2(((ltp - lv) / lv) * 100), text: `crossed below ${name} ${f2(lv)}` });
        }
      }
    }
  }

  // ── Swings (zigzag on ticks) ──
  if (on(sel, "swing_up") || on(sel, "swing_down")) {
    const r = (params(sel, "swing_up").reversalPct ?? params(sel, "swing_down").reversalPct ?? 1) / 100;
    const sw = s.swing;
    if (sw.hi === null) {
      sw.hi = ltp;
      sw.lo = ltp;
    }
    if (sw.dir >= 0) {
      if (ltp > sw.hi) sw.hi = ltp;
      if (ltp <= sw.hi * (1 - r) && (sw.dir === 1 || sw.dir === 0)) {
        const from = sw.hi;
        sw.dir = -1;
        sw.lo = ltp;
        if (on(sel, "swing_down")) hits.push({ kind: "swing_down", variant: "", dir: -1, strength: r2(((ltp - from) / from) * 100), text: `turned down ${signed(((ltp - from) / from) * 100, 2)} % from ${f2(from)}` });
      }
    }
    if (sw.dir <= 0) {
      if (ltp < sw.lo) sw.lo = ltp;
      if (ltp >= sw.lo * (1 + r) && (sw.dir === -1 || sw.dir === 0)) {
        const from = sw.lo;
        sw.dir = 1;
        sw.hi = ltp;
        if (on(sel, "swing_up")) hits.push({ kind: "swing_up", variant: "", dir: 1, strength: r2(((ltp - from) / from) * 100), text: `turned up ${signed(((ltp - from) / from) * 100, 2)} % from ${f2(from)}` });
      }
    }
  }

  if (first) s.firstAt = t?.ms ?? null;
  return hits;
}

/** HH:MM in IST for context text. */
export function clockText(t) {
  const ms = num(t?.ms);
  if (ms === null) return "now";
  const d = new Date(ms + 330 * 60_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * The front future of an F&O stock: OI build-up class changes and OI surges. Mutates `s.fut`; returns hits.
 * Build-up uses classifyBuildup (dashboard/options.js, the one OI Analysis uses) on the change since the first OI
 * seen today (or the previous close's OI when the feed sends it) and the future's change from its previous close.
 */
export function detectFuture(s, quote, sel, t, lot = 1) {
  const hits = [];
  const ltp = pos(quote?.ltp);
  const oi = num(quote?.oi);
  if (ltp === null || oi === null || oi <= 0) return hits;
  const minute = num(t?.minute) ?? 0;
  if (!s.fut) s.fut = { oiRef: pos(quote.oiPrev) ?? oi, ltpRef: pos(quote.close) ?? ltp, cls: null, ring: new MinuteRing(64), surgeAt: -1e9 };
  const f = s.fut;
  f.ring.put(minute, oi);
  if (on(sel, "oi_buildup")) {
    const pr = params(sel, "oi_buildup");
    const cls = classifyBuildup({ d: oi - f.oiRef, oiRef: f.oiRef, dLtp: ltp - f.ltpRef, ltpRef: f.ltpRef, v: 0 }, { lot, minLots: 1, minOiPct: pr.minOiPct, minPxPct: 0.2, tick: 0.05, churnX: 1e9 });
    if (cls && cls !== "CH" && cls !== f.cls) {
      f.cls = cls;
      const dOi = ((oi - f.oiRef) / f.oiRef) * 100;
      const dPx = ((ltp - f.ltpRef) / f.ltpRef) * 100;
      hits.push({ kind: "oi_buildup", variant: cls, dir: cls === "LB" || cls === "SC" ? 1 : -1, strength: r2(dOi), text: `${BUILDUP_NAMES[cls]}: OI ${signed(dOi)} %, fut ${signed(dPx, 2)} %` });
    }
  }
  if (on(sel, "oi_surge")) {
    const pr = params(sel, "oi_surge");
    const ago = f.ring.ago(minute, pr.windowMinutes) ?? f.ring.first(minute, pr.windowMinutes);
    if (ago !== null && ago > 0) {
      const d = ((oi - ago) / ago) * 100;
      if (Math.abs(d) >= pr.pct && minute - f.surgeAt >= pr.windowMinutes) {
        f.surgeAt = minute;
        const dPx = ((ltp - f.ltpRef) / f.ltpRef) * 100;
        hits.push({ kind: "oi_surge", variant: d > 0 ? "up" : "down", dir: dPx >= 0 ? 1 : -1, strength: r2(d), text: `fut OI ${signed(d)} % in ${pr.windowMinutes} min (${signed((oi - ago) / lot, 0)} lots)` });
      }
    }
  }
  return hits;
}
