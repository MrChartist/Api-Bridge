// brief-core.js: the maths and words of the Market brief (brief.js, Shift+Y). Deterministic and facts-only: the
// trend regime of the index from 5-minute candles, RSI and MACD on the same candles, VWAP of the near future, classic
// pivots and CPR from the previous session, the option levels merged onto one price ladder, and up to three plain
// sentences on what changed in the last 15 minutes. No DOM, no fetch, no clock (callers pass times). brief-core.test.mjs
// checks every export.
import { MINUS, formatCompact, formatFixed, formatGrouped, formatInt } from "./format.js";

const num = (v) => (v === null || v === undefined || v === "" || typeof v === "boolean" || !Number.isFinite(Number(v)) ? null : Number(v));
const IST_S = 19_800;

/** The index each underlying's brief reads (its spot candles). */
export const INDEX_SYMBOL = Object.freeze({ NIFTY: "NSE:NIFTY", BANKNIFTY: "NSE:BANKNIFTY", FINNIFTY: "NSE:FINNIFTY", MIDCPNIFTY: "NSE:MIDCPNIFTY", SENSEX: "BSE:SENSEX" });

/** "YYYY-MM-DD" (IST) of an epoch-seconds time. */
export const istDateOf = (sec) => new Date((Number(sec) + IST_S) * 1000).toISOString().slice(0, 10);
/** "HH:MM" (IST) of an epoch-seconds time; "" when not a time. */
export function istHm(sec) {
  const s = num(sec);
  if (s === null) return "";
  return new Date((s + IST_S) * 1000).toISOString().slice(11, 16);
}

// ── Indicators (standard definitions) ──

/** Exponential moving average, seeded with the simple average of the first `period` values; null before that. */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = num(values[i]);
    if (v === null) {
      out[i] = prev;
      continue;
    }
    if (prev === null) {
      sum += v;
      n += 1;
      if (n === period) prev = sum / period;
      out[i] = prev;
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

/** RSI with Wilder's smoothing (14 by default): null until `period` changes have been seen. */
export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = Math.max(d, 0);
    const l = Math.max(-d, 0);
    if (i <= period) {
      gain += g / period;
      loss += l / period;
      if (i < period) continue;
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
    }
    out[i] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** MACD (12, 26, 9): { line, avg (the 9-period EMA of the line, usually called its signal line), hist }. */
export function macd(values, fast = 12, slow = 26, smooth = 9) {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line = values.map((_, i) => (f[i] === null || s[i] === null ? null : f[i] - s[i]));
  const first = line.findIndex((x) => x !== null);
  const avgPart = first < 0 ? [] : ema(line.slice(first), smooth);
  const avg = line.map((_, i) => (first < 0 || i < first ? null : avgPart[i - first]));
  const hist = line.map((x, i) => (x === null || avg[i] === null ? null : x - avg[i]));
  return { line, avg, hist };
}

/** Index of the first candle of the last IST trading day in `candles` (ascending, `time` in epoch seconds); -1 if none. */
export function sessionStart(candles) {
  const cs = candles ?? [];
  if (!cs.length) return -1;
  const day = istDateOf(cs[cs.length - 1].time);
  let i = cs.length - 1;
  while (i > 0 && istDateOf(cs[i - 1].time) === day) i -= 1;
  return i;
}

// ── The trend card ──

/**
 * The trend rule, in full (also printed under the card):
 *  1. EMA 9 of the index's 5-minute closes (warmed up on the earlier sessions fetched with it).
 *  2. Slope: the EMA now minus the EMA 3 candles back (15 minutes).
 *  3. Noise unit: the median high-to-low range of today's 5-minute candles.
 *  4. A candle is Rising when the slope is at least 0.5 noise units and it closes above the EMA, Falling when the slope
 *     is at most -0.5 units and it closes below the EMA, otherwise Sideways.
 *  5. The regime changes only when a new state holds for 2 candles in a row; it started at the first of them.
 */
export const TREND_RULE = Object.freeze({ ema: 9, lookback: 3, slopeK: 0.5, confirm: 2, minBars: 4, minutes: 5 });

const median = (xs) => {
  const s = xs.filter((x) => x !== null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Today's regime from 5-minute candles (ascending, earlier sessions allowed for the EMA's warm-up): { state ("up" |
 * "down" | "flat"), since (epoch s, start of the regime's first candle), sinceIndex, fromOpen, bars (today's candles),
 * slope (points over the lookback), unit (the noise unit), ema (last), close (last), move (close now − close before
 * the regime began, points), states (per candle of today) }. Null when today has fewer than `minBars` candles.
 */
export function trendRegime(candles, rule = TREND_RULE) {
  const cs = (candles ?? []).filter((c) => num(c?.close) !== null && num(c?.time) !== null);
  const s0 = sessionStart(cs);
  if (s0 < 0 || cs.length - s0 < rule.minBars) return null;
  const closes = cs.map((c) => Number(c.close));
  const e = ema(closes, rule.ema);
  const today = cs.slice(s0);
  const unit = median(today.map((c) => (num(c.high) !== null && num(c.low) !== null ? c.high - c.low : null)));
  const raw = [];
  for (let i = s0; i < cs.length; i++) {
    const j = i - rule.lookback;
    if (j < 0 || e[i] === null || e[j] === null || !unit) {
      raw.push("flat");
      continue;
    }
    const slope = e[i] - e[j];
    const c = closes[i];
    raw.push(slope >= rule.slopeK * unit && c > e[i] ? "up" : slope <= -rule.slopeK * unit && c < e[i] ? "down" : "flat");
  }
  let state = raw[0];
  let start = 0;
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] === state) continue;
    const from = i - rule.confirm + 1;
    if (from < 0) continue;
    let held = true;
    for (let k = from; k <= i; k++) if (raw[k] !== raw[i]) held = false;
    if (held) {
      state = raw[i];
      start = from;
    }
  }
  const last = cs.length - 1;
  const before = start === 0 ? num(today[0].open) : closes[s0 + start - 1];
  return {
    state,
    since: Number(today[start].time),
    sinceIndex: start,
    fromOpen: start === 0,
    bars: today.length,
    slope: last - rule.lookback >= 0 && e[last] !== null && e[last - rule.lookback] !== null ? e[last] - e[last - rule.lookback] : null,
    unit,
    ema: e[last],
    close: closes[last],
    move: before === null ? null : closes[last] - before,
    states: raw,
  };
}

/** The regime in words: { word, title ("Rising since 10:20"), tone ("up" | "down" | "flat"), detail }. */
export function trendWords(t) {
  if (!t) return { word: "Too early", title: "Too early to read", tone: "flat", detail: `Needs ${formatInt(TREND_RULE.minBars)} five-minute candles from today.` };
  const word = t.state === "up" ? "Rising" : t.state === "down" ? "Falling" : "Sideways";
  const at = istHm(t.since);
  const title = `${word} since ${at}${t.fromOpen ? ", the open" : ""}`;
  const mv = num(t.move);
  const moveText = mv === null ? "" : `${mv > 0 ? "+" : mv < 0 ? MINUS : ""}${formatGrouped(Math.abs(mv), 2)} points since then`;
  const emaSide = num(t.ema) === null ? "" : `; the last close is ${t.close >= t.ema ? "above" : "below"} the EMA 9`;
  return { word, title, tone: t.state, detail: `${moveText}${emaSide}.`.replace(/^; /, "") };
}

// ── One line each ──

/** RSI in words: { value, zone ("above 70" | "below 30" | "between 30 and 70") }; null without a value. */
export function rsiFact(v) {
  const n = num(v);
  if (n === null) return null;
  return { value: n, zone: n >= 70 ? "70 or above" : n <= 30 ? "30 or below" : "between 30 and 70" };
}

/**
 * Where the MACD line sits against its 9-period average, and since when: { above (bool), since (epoch s of the
 * candle where it last crossed, or null when it has not crossed in the candles given), hist }. Null without values.
 */
export function macdFact(m, times) {
  const n = m?.line?.length ?? 0;
  const i = n - 1;
  if (i < 0 || m.line[i] === null || m.avg[i] === null) return null;
  const above = m.line[i] > m.avg[i];
  let k = i;
  while (k > 0 && m.line[k - 1] !== null && m.avg[k - 1] !== null && m.line[k - 1] > m.avg[k - 1] === above) k -= 1;
  const crossed = k > 0 && m.line[k - 1] !== null && m.avg[k - 1] !== null;
  return { above, since: crossed ? num(times?.[k]) : null, hist: m.hist[i], line: m.line[i] };
}

/**
 * VWAP through today's candles (typical price × volume): { vwap (per candle of today, null until volume trades),
 * last, close, side ("above" | "below" | "at" | null) }. Candles without volume (an index) give null.
 */
export function sessionVwap(candles) {
  const cs = candles ?? [];
  const s0 = sessionStart(cs);
  if (s0 < 0) return null;
  const today = cs.slice(s0);
  let pv = 0;
  let vol = 0;
  const vwap = today.map((c) => {
    const v = num(c.volume);
    const tp = (Number(c.high) + Number(c.low) + Number(c.close)) / 3;
    if (v !== null && v > 0 && Number.isFinite(tp)) {
      pv += tp * v;
      vol += v;
    }
    return vol > 0 ? pv / vol : null;
  });
  const last = vwap[vwap.length - 1];
  if (last === null) return null;
  const close = Number(today[today.length - 1].close);
  return { vwap, today, last, close, side: Math.abs(close - last) < 0.005 ? "at" : close > last ? "above" : "below" };
}

/**
 * The last time the close crossed VWAP within the last `minutes` of candles: { dir ("above" | "below"), at (epoch s:
 * the close of the candle that crossed), vwap } or null.
 */
export function vwapCross(v, { minutes = 15, barMinutes = 5 } = {}) {
  if (!v?.today?.length) return null;
  const n = v.today.length;
  const span = Math.max(1, Math.round(minutes / barMinutes));
  const side = (i) => (v.vwap[i] === null ? 0 : Math.sign(Number(v.today[i].close) - v.vwap[i]));
  for (let i = n - 1; i >= Math.max(1, n - span); i--) {
    const a = side(i - 1);
    const b = side(i);
    if (a !== 0 && b !== 0 && a !== b) return { dir: b > 0 ? "above" : "below", at: Number(v.today[i].time) + barMinutes * 60, vwap: v.vwap[i] };
  }
  return null;
}

// ── Key levels ──

/** Classic floor pivots and CPR from one session's high, low and close: { pp, r1, s1, r2, s2, tc, bc } or null. */
export function classicPivots(day) {
  const H = num(day?.high);
  const L = num(day?.low);
  const C = num(day?.close);
  if (H === null || L === null || C === null) return null;
  const pp = (H + L + C) / 3;
  const b = (H + L) / 2;
  const t = 2 * pp - b;
  return { pp, r1: 2 * pp - L, s1: 2 * pp - H, r2: pp + (H - L), s2: pp - (H - L), tc: Math.max(t, b), bc: Math.min(t, b) };
}

/** The daily candle of the session before `date` ("YYYY-MM-DD", IST), from ascending daily candles; null if none. */
export function prevSession(daily, date) {
  const cs = daily ?? [];
  for (let i = cs.length - 1; i >= 0; i--) if (istDateOf(cs[i].time) < date) return cs[i];
  return null;
}

/** The level names, by kind (the Home key-levels card's words for the option levels). */
export const BRIEF_LEVEL_NAMES = Object.freeze({ ce: "Call wall", pe: "Put wall", mp: "Max pain", hi: "Day high", lo: "Day low", mhi: "Move high", mlo: "Move low", r1: "R1", pp: "Pivot", s1: "S1", tc: "CPR top", bc: "CPR bottom" });
/** Which name leads a merged row (earlier first). */
const PRIORITY = ["ce", "pe", "mp", "hi", "lo", "pp", "tc", "bc", "r1", "s1", "mhi", "mlo"];

/** The levels the brief prints: [{ kind, label, price }] (only those with a figure). */
export function briefLevels({ callWall = null, putWall = null, maxPain = null, dayHigh = null, dayLow = null, rangeLo = null, rangeHi = null, pivots = null } = {}) {
  const xs = [
    ["ce", callWall],
    ["pe", putWall],
    ["mp", maxPain],
    ["hi", dayHigh],
    ["lo", dayLow],
    ["mhi", rangeHi],
    ["mlo", rangeLo],
    ["r1", pivots?.r1],
    ["pp", pivots?.pp],
    ["s1", pivots?.s1],
    ["tc", pivots?.tc],
    ["bc", pivots?.bc],
  ];
  return xs.filter(([, p]) => num(p) !== null).map(([kind, p]) => ({ kind, label: BRIEF_LEVEL_NAMES[kind], price: Number(p) }));
}

/**
 * Levels merged and sorted for a price ladder, highest first, with spot in its place: [{ price, kinds, labels, dist
 * (price − spot), spot (true for the spot row) }]. Levels within `tol` points of each other share a row (two sources
 * agreeing is the point); the row's price is its leading level's. `tol` defaults to 0.05 % of spot. `span` limits the
 * ladder to levels within that many points of spot (the rest are counted in `off`).
 * @returns {{ rows: object[], off: string[] }}
 */
export function mergeLevels(levels, spot, { tol = null, span = null } = {}) {
  const s = num(spot);
  const t = num(tol) ?? (s === null ? 0 : s * 0.0005);
  const all = (levels ?? []).filter((l) => num(l?.price) !== null);
  const within = span === null || s === null ? all : all.filter((l) => Math.abs(l.price - s) <= span);
  const off = all.filter((l) => !within.includes(l)).map((l) => l.label);
  const sorted = [...within].sort((a, b) => b.price - a.price);
  const groups = [];
  for (const l of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g.anchor - l.price) <= t) g.items.push(l);
    else groups.push({ anchor: l.price, items: [l] });
  }
  const rows = groups.map((g) => {
    const items = [...g.items].sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
    const price = items[0].price;
    return { price, kinds: items.map((i) => i.kind), labels: items.map((i) => i.label), dist: s === null ? null : price - s, spot: false };
  });
  if (s !== null) {
    const at = rows.findIndex((r) => r.price < s);
    rows.splice(at < 0 ? rows.length : at, 0, { price: s, kinds: ["spot"], labels: ["Spot"], dist: 0, spot: true });
  }
  return { rows, off };
}

// ── What changed in the last 15 minutes ──

/**
 * A snapshot's time in epoch ms: the recorder's `slot` (its `t` is the time to expiry in years, not a clock time),
 * else `at` (snapOfChain's read time); NaN when neither.
 */
export function snapTime(s) {
  const slot = Date.parse(s?.slot ?? s?.ts ?? "");
  if (Number.isFinite(slot)) return slot;
  const at = num(s?.at);
  return at === null ? Number.NaN : at;
}

/**
 * The strikes around ATM of one recorded snapshot (GET /v1/options/snapshots item, or snapOfChain below): { t (epoch
 * ms), spot, atm, strikes, ce, pe (OI per strike), ceOi, peOi, pcr }. `strikes` either side of ATM (7, as the walls).
 */
export function oiWindow(snap, { strikes = 7 } = {}) {
  const k = Array.isArray(snap?.strikes) ? snap.strikes.map(Number) : [];
  if (!k.length) return null;
  const spot = num(snap.spot);
  const atm = num(snap.atm) ?? (spot === null ? null : k.reduce((b, x) => (Math.abs(x - spot) < Math.abs(b - spot) ? x : b), k[0]));
  const ai = atm === null ? Math.floor(k.length / 2) : k.indexOf(k.reduce((b, x) => (Math.abs(x - atm) < Math.abs(b - atm) ? x : b), k[0]));
  const lo = Math.max(0, ai - strikes);
  const hi = Math.min(k.length - 1, ai + strikes);
  const out = { t: snapTime(snap), spot, atm, strikes: [], ce: [], pe: [], ceOi: 0, peOi: 0, pcr: null };
  for (let i = lo; i <= hi; i++) {
    const co = num(snap.ce?.oi?.[i]);
    const po = num(snap.pe?.oi?.[i]);
    if (co === null || po === null) continue;
    out.strikes.push(k[i]);
    out.ce.push(co);
    out.pe.push(po);
    out.ceOi += co;
    out.peOi += po;
  }
  if (!out.strikes.length) return null;
  out.pcr = out.ceOi > 0 ? out.peOi / out.ceOi : null;
  return out;
}

/** A chain (GET /v1/optionchain data) as a snapshot-shaped record, so the brief can compare chains it read itself. */
export function snapOfChain(chain, nowMs) {
  const rows = chain?.rows ?? [];
  if (!rows.length) return null;
  const at = Date.parse(chain?.freshness?.asOf ?? "");
  return {
    at: Number.isFinite(at) ? at : nowMs,
    spot: num(chain.spot ?? chain.underlyingLtp),
    atm: num(chain.atm),
    strikes: rows.map((r) => r.strike),
    ce: { oi: rows.map((r) => num(r.ce?.oi)) },
    pe: { oi: rows.map((r) => num(r.pe?.oi)) },
  };
}

/** From a list of snapshots (oldest first, each with `slot` or `at`), the latest one and the one `minutes` before it. */
export function pickWindow(snaps, { minutes = 15, slackMinutes = 5 } = {}) {
  const ts = snapTime;
  const xs = (snaps ?? []).filter((s) => Number.isFinite(ts(s)));
  if (xs.length < 2) return null;
  const after = xs[xs.length - 1];
  const target = ts(after) - minutes * 60_000;
  let before = null;
  for (const s of xs) if (ts(s) <= target) before = s;
  if (!before || target - ts(before) > slackMinutes * 60_000) return null;
  return { before, after, minutes: Math.round((ts(after) - ts(before)) / 60_000) };
}

/**
 * OI between two windows over the strikes both carry: { dCe, dPe (units), dCePct, dPePct, pcrFrom, pcrTo, topCe,
 * topPe ({ strike, d }: the strike whose OI moved most on that side, in the direction of the side's total) }.
 */
export function oiShift(before, after) {
  if (!before || !after) return null;
  const idx = new Map(before.strikes.map((k, i) => [k, i]));
  let ce0 = 0;
  let pe0 = 0;
  let ce1 = 0;
  let pe1 = 0;
  const per = [];
  after.strikes.forEach((k, j) => {
    const i = idx.get(k);
    if (i === undefined) return;
    ce0 += before.ce[i];
    pe0 += before.pe[i];
    ce1 += after.ce[j];
    pe1 += after.pe[j];
    per.push({ strike: k, ce: after.ce[j] - before.ce[i], pe: after.pe[j] - before.pe[i] });
  });
  if (!per.length) return null;
  const dCe = ce1 - ce0;
  const dPe = pe1 - pe0;
  const top = (side, d) => {
    const pick = per.filter((p) => Math.sign(p[side]) === Math.sign(d) && p[side] !== 0).sort((a, b) => Math.abs(b[side]) - Math.abs(a[side]))[0];
    return pick ? { strike: pick.strike, d: pick[side] } : null;
  };
  return {
    strikes: per.length,
    dCe,
    dPe,
    dCePct: ce0 > 0 ? (dCe / ce0) * 100 : null,
    dPePct: pe0 > 0 ? (dPe / pe0) * 100 : null,
    pcrFrom: ce0 > 0 ? pe0 / ce0 : null,
    pcrTo: ce1 > 0 ? pe1 / ce1 : null,
    topCe: top("ce", dCe),
    topPe: top("pe", dPe),
  };
}

/** Changes smaller than these are left out of the sentences. */
export const CHANGE_FLOORS = Object.freeze({ oiPct: 1, pcr: 0.02 });

const signedCompact = (v) => formatCompact(v, { signed: true });

/**
 * Up to three plain sentences on the last `minutes`: a VWAP cross first, then the larger OI moves (by %), then the PCR
 * shift; when there is room, where price stayed against VWAP. [{ text, tone ("up" | "down" | "") }]. One quiet
 * sentence when nothing passed the floors; empty when there is nothing to compare.
 * @param {{ shift?: object|null, cross?: object|null, vwapSide?: string|null, minutes?: number }} x
 */
export function changeSentences({ shift = null, cross = null, vwapSide = null, minutes = 15 } = {}) {
  const out = [];
  if (cross) out.push({ text: `The near future crossed ${cross.dir} its VWAP (${formatGrouped(cross.vwap, 2)}) at ${istHm(cross.at)}.`, tone: cross.dir === "above" ? "up" : "down", w: 1000 });
  if (shift) {
    const sideText = (name, d, pct, top) => {
      const verb = d > 0 ? "rose" : "fell";
      const at = top ? `, most at ${formatInt(top.strike)} (${signedCompact(top.d)})` : "";
      return `${name} OI ${verb} by ${formatCompact(Math.abs(d))} (${formatFixed(Math.abs(pct), 1)}%) across the ${formatInt(shift.strikes)} strikes around ATM${at}.`;
    };
    const sides = [
      ["Put", shift.dPe, shift.dPePct, shift.topPe],
      ["Call", shift.dCe, shift.dCePct, shift.topCe],
    ]
      .filter(([, d, pct]) => num(pct) !== null && Math.abs(pct) >= CHANGE_FLOORS.oiPct && d !== 0)
      .sort((a, b) => Math.abs(b[2]) - Math.abs(a[2]));
    for (const [name, d, pct, top] of sides) out.push({ text: sideText(name, d, pct, top), tone: d > 0 ? "up" : "down", w: 100 + Math.abs(pct) });
    if (num(shift.pcrFrom) !== null && num(shift.pcrTo) !== null && Math.abs(shift.pcrTo - shift.pcrFrom) >= CHANGE_FLOORS.pcr) {
      out.push({ text: `PCR around ATM moved from ${formatFixed(shift.pcrFrom, 2)} to ${formatFixed(shift.pcrTo, 2)}.`, tone: shift.pcrTo > shift.pcrFrom ? "up" : "down", w: 50 });
    }
  }
  if (!cross && (vwapSide === "above" || vwapSide === "below") && out.length < 3) out.push({ text: `The near future stayed ${vwapSide} its VWAP.`, tone: vwapSide === "above" ? "up" : "down", w: 10 });
  if (!out.length) {
    if (!shift && !vwapSide) return [];
    return [{ text: `Little changed in the last ${formatInt(minutes)} minutes: OI moved less than ${formatInt(CHANGE_FLOORS.oiPct)}% on each side${vwapSide ? " and price did not cross VWAP" : ""}.`, tone: "" }];
  }
  return out
    .sort((a, b) => b.w - a.w)
    .slice(0, 3)
    .map(({ text, tone }) => ({ text, tone }));
}

// ── Breadth and IV range ──

/** Advance / decline in words: { up, down, flat, total, tone, text } or null. */
export function breadthFact(summary) {
  const a = num(summary?.advances);
  const d = num(summary?.declines);
  if (a === null || d === null) return null;
  const u = num(summary?.unchanged) ?? 0;
  return { up: a, down: d, flat: u, total: a + d + u, tone: a > d ? "up" : a < d ? "down" : "", text: `${formatInt(a)} up · ${formatInt(d)} down${u ? ` · ${formatInt(u)} unchanged` : ""}` };
}

/**
 * Where IV sits in its stored range (GET /v1/vol/rank, the longest lookback with a range): { iv, lo, hi, days, at
 * (0–1 in the range), rank, pct } or null.
 */
export function ivRange(rank) {
  if (!rank?.available) return null;
  const lb = [...(rank.lookbacks ?? [])].filter((l) => num(l?.min?.iv) !== null && num(l?.max?.iv) !== null).sort((a, b) => b.days - a.days)[0];
  const iv = num(rank.current?.iv);
  if (!lb || iv === null) return null;
  const lo = Number(lb.min.iv);
  const hi = Number(lb.max.iv);
  return { iv, lo, hi, days: lb.n ?? lb.days, at: hi > lo ? Math.max(0, Math.min(1, (iv - lo) / (hi - lo))) : null, rank: num(lb.ivr), pct: num(lb.ivp) };
}
