// vol-suite-core.js: the pure maths behind Volatility › IV today and Analytics › Exposure (GEX, Straddle). No DOM,
// no fetch, no clock (callers pass `nowMs`): vol-suite-core.test.mjs checks every function.
//
// Data sources (existing endpoints only):
//   GET /v1/options/snapshots   the recorder's minute snapshots: spot, forward, atm, straddle, t (years), and per strike
//                               ltp / iv / oi for each leg. The intraday ATM IV, the straddle through the day and the
//                               straddle split are worked from these.
//   GET /v1/optionchain         one chain per expiry for the expiry comparison.
//   GET /v1/analytics/exposure  greekExposure + gexProfile (the solved flip, walls, lean and the curve).
// Pricing comes from pricing.js (black76), unchanged.
import { black76 } from "./pricing.js";
import { DASH, formatFixed, formatInt, formatPercent, isFigure, MINUS } from "./format.js";

const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const num = (v) => (isFigure(v) ? Number(v) : null);
const pos = (v) => isFigure(v) && Number(v) > 0;

/** The convention the Option Chain and this page share: the expected move is 0.85 × the ATM straddle. */
export const EXPECTED_MOVE_K = 0.85;
/** A premium change inside 1% of the baseline (or one 0.05 tick) is "steady". */
export const STEADY_BAND = 0.01;
export const TICK = 0.05;
/** Priced day ÷ actual day: from 1.2 "bigger", to 1 ÷ 1.2 "smaller" (a 20-session HV is uncertain by about ±16%). */
export const RATIO_BAND = 1.2;
/** IV percentile verdict lines. */
export const IVP_HIGH = 80;
export const IVP_LOW = 20;

// ── Snapshots ──

/** The IST calendar day ("2026-10-31") of an epoch ms. */
export const istDay = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);

/**
 * IV at the forward from one snapshot's ladder: each strike's IV is the mean of its CE and PE IV (one side when only
 * one has an IV), linear in strike between the two strikes either side of F. Null without a bracket within one step.
 */
export function ivAtForward(strikes, ceIv, peIv, forward) {
  const F = num(forward);
  if (F === null || !Array.isArray(strikes)) return null;
  const pts = [];
  strikes.forEach((k, i) => {
    const c = pos(ceIv?.[i]) ? Number(ceIv[i]) : null;
    const p = pos(peIv?.[i]) ? Number(peIv[i]) : null;
    const iv = c !== null && p !== null ? (c + p) / 2 : (c ?? p);
    if (pos(k) && iv !== null) pts.push({ k: Number(k), iv });
  });
  pts.sort((a, b) => a.k - b.k);
  const below = pts.filter((p) => p.k <= F).pop() ?? null;
  const above = pts.find((p) => p.k >= F) ?? null;
  if (below && above) return below.k === above.k ? below.iv : below.iv + ((above.iv - below.iv) * (F - below.k)) / (above.k - below.k);
  return null;
}

/** One leg of a snapshot at `strike`: { ltp, iv } (nulls where missing or 0, which the recorder stores for "none"). */
export function legAt(snap, strike, side) {
  const i = (snap?.strikes ?? []).indexOf(strike);
  const leg = snap?.[side];
  if (i < 0 || !leg) return { ltp: null, iv: null };
  return { ltp: pos(leg.ltp?.[i]) ? Number(leg.ltp[i]) : null, iv: pos(leg.iv?.[i]) ? Number(leg.iv[i]) : null };
}

/**
 * GET /v1/options/snapshots items as points of the latest session, oldest first:
 * { t, spot, forward, atm, straddle, years, atmIv }. A snapshot without a forward or a time left is dropped (a gap,
 * never a zero).
 */
export function snapshotPoints(snaps) {
  const all = (snaps ?? [])
    .map((s) => {
      const t = Date.parse(s?.ts ?? s?.slot ?? "");
      if (!Number.isFinite(t) || !pos(s?.forward) || !pos(s?.t)) return null;
      return { t, spot: num(s.spot), forward: Number(s.forward), atm: num(s.atm), straddle: pos(s.straddle) ? Number(s.straddle) : null, years: Number(s.t), atmIv: ivAtForward(s.strikes, s.ce?.iv, s.pe?.iv, s.forward), raw: s };
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);
  if (!all.length) return [];
  const day = istDay(all[all.length - 1].t);
  return all.filter((p) => istDay(p.t) === day);
}

/** The highest and lowest of `key` over the points, with their times; null when none has a value. */
export function dayRange(points, key) {
  let hi = null;
  let lo = null;
  for (const p of points ?? []) {
    const v = num(p?.[key]);
    if (v === null) continue;
    if (!hi || v > hi.v) hi = { v, t: p.t };
    if (!lo || v < lo.v) lo = { v, t: p.t };
  }
  return hi ? { hi: hi.v, hiT: hi.t, lo: lo.v, loT: lo.t } : null;
}

/**
 * The change of `key` over a window: "day" (from the session's first reading), or minutes back (the reading nearest
 * now − minutes, within `tolMs` of it). { now, base, change, pct } or null when there is no baseline.
 */
export function changeOver(points, key, window, { tolMs = 150_000 } = {}) {
  const list = (points ?? []).filter((p) => num(p?.[key]) !== null);
  if (list.length < 2) return null;
  const last = list[list.length - 1];
  let base = null;
  if (window === "day") base = list[0];
  else {
    const target = last.t - Number(window) * 60_000;
    // The reading nearest that moment (either side of it, never the latest itself), if it is close enough.
    const near = list.slice(0, -1).reduce((b, p) => (!b || Math.abs(p.t - target) < Math.abs(b.t - target) ? p : b), null);
    if (near && Math.abs(near.t - target) <= tolMs) base = near;
  }
  if (!base || base === last) return null;
  const now = Number(last[key]);
  const b = Number(base[key]);
  return { now, base: b, change: now - b, pct: b !== 0 ? ((now - b) / Math.abs(b)) * 100 : null, baseT: base.t };
}

/** "rising" / "falling" / "steady" for a premium change against its baseline; null without one. */
export function premiumVerdict(change) {
  if (!change || !isFigure(change.change) || !pos(change.base)) return null;
  const d = change.change;
  if (Math.abs(d) <= TICK + 1e-9 || Math.abs(d) <= STEADY_BAND * change.base) return "steady";
  return d > 0 ? "rising" : "falling";
}

// ── Moves ──

/** The straddle's three levels: expected move (0.85 × premium, centred on spot) and breakevens (strike ± premium). */
export function straddleLevels({ premium, strike, spot }) {
  if (!pos(premium)) return null;
  const P = Number(premium);
  const move = EXPECTED_MOVE_K * P;
  const S = num(spot);
  const K = num(strike);
  return {
    premium: P,
    expectedMove: move,
    movePct: pos(S) ? (move / S) * 100 : null,
    rangeLo: pos(S) ? S - move : null,
    rangeHi: pos(S) ? S + move : null,
    beLo: pos(K) ? K - P : null,
    beHi: pos(K) ? K + P : null,
  };
}

/** One standard deviation of the price to expiry, in points: spot × IV × √years. */
export function sigmaMovePts(spot, ivPct, years) {
  return pos(spot) && pos(ivPct) && pos(years) ? Number(spot) * (Number(ivPct) / 100) * Math.sqrt(Number(years)) : null;
}

/**
 * Trading sessions left from `nowMs` to the close of `expiry` (IST): the unspent part of today's session plus every
 * whole weekday session after today up to and including expiry. Weekends carry none; exchange holidays are not
 * removed (no calendar here). Null for a passed or malformed expiry.
 */
export function sessionsLeft(nowMs, expiry, { open = 555, close = 930 } = {}) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(expiry ?? ""));
  if (!m || !Number.isFinite(nowMs)) return null;
  const expDay = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const ist = nowMs + IST_MS;
  const today = Math.floor(ist / DAY_MS) * DAY_MS;
  const minute = (ist - today) / 60_000;
  if (today > expDay || (today === expDay && minute >= close)) return null;
  const weekday = (d) => {
    const w = new Date(d).getUTCDay();
    return w !== 0 && w !== 6;
  };
  let n = weekday(today) ? Math.min(1, Math.max(0, (close - Math.max(minute, open)) / (close - open))) : 0;
  for (let d = today + DAY_MS; d <= expDay; d += DAY_MS) if (weekday(d)) n += 1;
  return n > 0 ? n : null;
}

/** The move per session: the move to expiry ÷ √(sessions left). */
export const perSession = (move, sessions) => (pos(move) && pos(sessions) ? Number(move) / Math.sqrt(Number(sessions)) : null);

/** One actual day in points from a 20-session HV (annualised over 252 sessions): spot × HV ÷ √252. */
export const actualDayPts = (spot, hvPct) => (pos(spot) && pos(hvPct) ? (Number(spot) * Number(hvPct)) / 100 / Math.sqrt(252) : null);

/** The priced day against the actual day, on the whole points shown: { ratio, word } ("bigger" | "like" | "smaller"). */
export function pricedVsActual(pricedDay, actualDay) {
  const a = pos(actualDay) ? Math.round(Number(actualDay)) : 0;
  const b = pos(pricedDay) ? Math.round(Number(pricedDay)) : 0;
  if (!(a > 0) || !(b > 0)) return null;
  const ratio = b / a;
  return { ratio, priced: b, actual: a, word: ratio >= RATIO_BAND ? "bigger" : ratio <= 1 / RATIO_BAND ? "smaller" : "like" };
}

/** IV percentile as a word, tested on the whole number shown: "high" (≥ 80), "low" (≤ 20), "normal"; null without one. */
export function ivVerdict(ivp) {
  if (!isFigure(ivp)) return null;
  const v = Math.round(Number(ivp));
  return v >= IVP_HIGH ? "high" : v <= IVP_LOW ? "low" : "normal";
}

// ── The straddle split: what moved the ATM straddle since the first reading ──

/**
 * Split the change of the straddle at `strike` between two snapshots into the underlying's move, the IV change, time
 * passing and what is left (a large move, or a stale price). Black-76 on each snapshot's forward and time, each leg at
 * its own IV, repriced in that order; the four parts add up to the traded change exactly. Null when a leg is missing.
 */
export function straddleSplit(first, last, strike) {
  if (!first || !last || !pos(strike)) return null;
  const K = Number(strike);
  const legs = ["ce", "pe"].map((side) => ({ side, right: side === "ce" ? "CE" : "PE", a: legAt(first, K, side), b: legAt(last, K, side) }));
  if (legs.some((l) => l.a.ltp === null || l.b.ltp === null || l.a.iv === null || l.b.iv === null)) return null;
  const F0 = num(first.forward);
  const F1 = num(last.forward);
  const T0 = num(first.t);
  const T1 = num(last.t);
  if (!pos(F0) || !pos(F1) || !pos(T0) || !pos(T1)) return null;
  let spot = 0;
  let iv = 0;
  let time = 0;
  for (const { right, a, b } of legs) {
    const p00 = black76(F0, K, T0, a.iv, right);
    const p10 = black76(F1, K, T0, a.iv, right);
    const p11 = black76(F1, K, T0, b.iv, right);
    const p1t = black76(F1, K, T1, b.iv, right);
    spot += p10 - p00;
    iv += p11 - p10;
    time += p1t - p11;
  }
  const before = legs.reduce((t, l) => t + l.a.ltp, 0);
  const after = legs.reduce((t, l) => t + l.b.ltp, 0);
  const total = after - before;
  const other = total - spot - iv - time;
  const ivPts = (legs[0].b.iv + legs[1].b.iv) / 2 - (legs[0].a.iv + legs[1].a.iv) / 2;
  const parts = [
    { id: "spot", label: "Price move", value: spot },
    { id: "iv", label: "IV change", value: iv },
    { id: "time", label: "Time decay", value: time },
    { id: "other", label: "Other", value: other },
  ];
  const moved = parts.reduce((t, p) => t + Math.abs(p.value), 0);
  return {
    strike: K,
    before,
    after,
    total,
    parts,
    ivPts,
    spotPts: num(last.spot) !== null && num(first.spot) !== null ? Number(last.spot) - Number(first.spot) : null,
    minutes: Math.round((Date.parse(last.ts ?? last.slot) - Date.parse(first.ts ?? first.slot)) / 60_000),
    // The unexplained part is more than a third of all the movement: the split is rough (a big move or a stale price).
    // (Under half a rupee of movement in all there is nothing to call rough.)
    rough: moved >= 0.5 && Math.abs(other) > moved / 3,
  };
}

/** The premium the first reading would have if only time had passed: first × √(years now ÷ years then). */
export function timeOnlyLine(points) {
  const first = (points ?? []).find((p) => pos(p.straddle) && pos(p.years));
  if (!first) return [];
  return points.filter((p) => pos(p.years) && p.t >= first.t).map((p) => ({ t: p.t, v: first.straddle * Math.sqrt(p.years / first.years) }));
}

// ── Compare expiries (one chain each) ──

/** Calendar days from `nowMs` to 15:30 IST on `expiry` (≥ 0), null when malformed. */
export function daysTo(nowMs, expiry) {
  const end = Date.parse(`${expiry}T15:30:00+05:30`);
  return Number.isFinite(end) && Number.isFinite(nowMs) ? Math.max(0, (end - nowMs) / DAY_MS) : null;
}

/**
 * One row of the expiry comparison from a GET /v1/optionchain answer: the ATM strike's straddle, its expected move and
 * breakevens, the ATM IV (mean of the two legs' IV), the 1σ move to expiry and the move per session.
 */
export function expiryRow(chain, nowMs) {
  const rows = chain?.rows ?? [];
  const spot = num(chain?.underlyingLtp);
  const k = num(chain?.atmStrike);
  const row = rows.find((r) => Number(r.strike) === k) ?? null;
  const ce = pos(row?.ce?.ltp) ? Number(row.ce.ltp) : null;
  const pe = pos(row?.pe?.ltp) ? Number(row.pe.ltp) : null;
  const premium = ce !== null && pe !== null ? ce + pe : null;
  const ivs = [row?.ce?.iv, row?.pe?.iv].filter(pos).map(Number);
  const atmIv = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
  const days = daysTo(nowMs, chain?.expiry);
  const sessions = sessionsLeft(nowMs, chain?.expiry);
  const sigma = sigmaMovePts(spot, atmIv, days !== null ? days / 365 : null);
  return { expiry: chain?.expiry ?? null, strike: k, spot, ce, pe, premium, atmIv, days, sessions, sigma, perDay: perSession(sigma, sessions), levels: straddleLevels({ premium, strike: k, spot }) };
}

/** The extremes of a list of rows by `key`: { hi, lo } expiries (null when fewer than two rows carry the key). */
export function extremes(rows, key) {
  const list = (rows ?? []).filter((r) => isFigure(r?.[key]));
  if (list.length < 2) return { hi: null, lo: null };
  const sorted = [...list].sort((a, b) => b[key] - a[key]);
  return { hi: sorted[0].expiry, lo: sorted[sorted.length - 1].expiry };
}

// ── GEX words and numbers ──

/** Rupees as the page prints them: "₹7868 Cr" from a crore, "₹1.5 L" from a lakh, "< ₹1 L" under it; true minus. */
export function rupeeCr(v) {
  if (!isFigure(v)) return DASH;
  const n = Number(v);
  const sign = n < 0 ? MINUS : "";
  const a = Math.abs(n);
  if (a >= 1e10) return `${sign}₹${formatInt(a / 1e7)} Cr`;
  if (a >= 1e7) return `${sign}₹${formatFixed(a / 1e7, 1)} Cr`;
  if (a >= 1e5) return `${sign}₹${formatFixed(a / 1e5, 1)} L`;
  return n === 0 ? "₹0" : "< ₹1 L";
}

/** The verdict words for a gexProfile verdict. */
export const GEX_WORDS = Object.freeze({
  dampens: "Hedging dampens moves",
  amplifies: "Hedging amplifies moves",
  balanced: "Near balance",
  unmeasured: "Not measured",
});

/** The lean as printed: whole per cent, but one decimal (truncated toward the band) within a point of 10%. */
export function leanText(lean) {
  if (!isFigure(lean)) return DASH;
  const pct = Number(lean) * 100;
  if (pct >= 9 && pct < 11) return `${formatFixed(Math.floor(pct * 10) / 10, 1)}%`;
  return `${formatInt(Math.floor(pct))}%`;
}

/** Where the price sits against the flip, in words: "NIFTY 109 above the flip". */
export function flipGist(underlying, distance, flipRangePct = 25) {
  if (!isFigure(distance)) return `No flip within ${formatInt(flipRangePct)}% of ${underlying}`;
  const d = Math.round(Number(distance));
  if (d === 0) return `${underlying} at the flip`;
  return `${underlying} ${formatInt(Math.abs(d))} ${d > 0 ? "above" : "below"} the flip`;
}

/**
 * The badges over the strike profile, placed on lanes so none overlaps the one before it on its lane: items
 * { id, x, w } (x centre, w width in px) -> the same items with `lane` (0, 1, 2...). Sorted by x.
 */
export function badgeLanes(items, gap = 6) {
  const ends = [];
  return [...(items ?? [])]
    .filter((i) => isFigure(i?.x))
    .sort((a, b) => a.x - b.x)
    .map((i) => {
      const left = i.x - i.w / 2;
      let lane = ends.findIndex((end) => left >= end + gap);
      if (lane < 0) lane = ends.length;
      ends[lane] = i.x + i.w / 2;
      return { ...i, lane };
    });
}

/** The strikes nearest spot, `count` of them (all when count is 0 or more than there are), in strike order. */
export function nearestStrikes(strikes, spot, count) {
  const list = [...(strikes ?? [])].filter((s) => isFigure(s?.strike));
  if (!count || count >= list.length || !pos(spot)) return list.sort((a, b) => a.strike - b.strike);
  return list.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot)).slice(0, count).sort((a, b) => a.strike - b.strike);
}

// ── Chart specs (chart-lite.js buildModel) ──

const rupee2 = (v) => (isFigure(v) ? `₹${formatFixed(v, 2)}` : DASH);

/** The chart: the ATM straddle through the day, the time-alone line from the first reading, and spot underneath. */
export function straddleSpec(points, { underlying, expiry }) {
  const prem = points.filter((p) => isFigure(p.straddle)).map((p) => ({ t: p.t, v: p.straddle }));
  if (prem.length < 2) return { empty: { title: "One reading so far", text: "The line draws from the second recorded minute." } };
  const decay = timeOnlyLine(points);
  const spot = points.filter((p) => isFigure(p.spot)).map((p) => ({ t: p.t, v: p.spot }));
  const r = dayRange(points, "straddle");
  return {
    label: `${underlying} ${expiry}: ATM straddle through the session, the time-alone line and spot`,
    panes: [{ id: "prem", weight: 3 }, { id: "spot", weight: 1.1, label: `${underlying} spot`, format: (v) => formatInt(v) }],
    series: [
      { id: "st", type: "line", pane: "prem", label: "ATM straddle", tone: "iv", data: prem, format: rupee2 },
      { id: "decay", type: "line", pane: "prem", label: "Time alone", tone: "muted", dash: true, data: decay, format: rupee2 },
      ...(r ? [{ id: "hi", type: "level", pane: "prem", value: r.hi, label: `High ${formatFixed(r.hi, 2)}`, tone: "muted", fit: false }, { id: "lo", type: "level", pane: "prem", value: r.lo, label: `Low ${formatFixed(r.lo, 2)}`, tone: "muted", fit: false }] : []),
      { id: "spot", type: "line", pane: "spot", label: "Spot", tone: "spot", data: spot, format: (v) => formatFixed(v, 2) },
    ],
    note: "Time alone: the first premium scaled by the square root of the time left, as if nothing else had moved.",
  };
}

/** The IV-today chart: the ATM IV through the session with the day's high and low, and spot underneath. */
export function ivTodaySpec(points, { underlying = "", expiry = "" } = {}) {
  const iv = points.filter((p) => isFigure(p.atmIv)).map((p) => ({ t: p.t, v: p.atmIv }));
  if (iv.length < 2) return { empty: { title: iv.length ? "First reading" : "Nothing recorded today", text: iv.length ? "The line draws from the second recorded minute." : "The Bridge records index chains every minute while it runs in market hours." } };
  const r = dayRange(points, "atmIv");
  const pct = (v) => formatPercent(v, 2);
  return {
    label: `${underlying} ${expiry}: ATM IV at the forward through the session, and spot`,
    panes: [{ id: "iv", weight: 3, label: "ATM IV, %" }, { id: "spot", weight: 1, label: `${underlying} spot`, format: (v) => formatInt(v) }],
    series: [
      { id: "iv", type: "line", pane: "iv", label: "ATM IV", tone: "iv", data: iv, format: pct },
      { id: "hi", type: "level", pane: "iv", value: r.hi, label: `High ${pct(r.hi)}`, tone: "muted", fit: false },
      { id: "lo", type: "level", pane: "iv", value: r.lo, label: `Low ${pct(r.lo)}`, tone: "muted", fit: false },
      { id: "spot", type: "line", pane: "spot", label: "Spot", tone: "spot", dash: true, data: points.filter((p) => isFigure(p.spot)).map((p) => ({ t: p.t, v: p.spot })), format: (v) => formatFixed(v, 2) },
    ],
  };
}

/** The four answers as figures (pure, for the panel and its tests). */
export function ivTodayModel(points, { expiry, nowMs, hv20 = null, rank = null }) {
  const last = points[points.length - 1] ?? null;
  if (!last) return null;
  const open = changeOver(points, "atmIv", "day");
  const range = dayRange(points, "atmIv");
  const move = sigmaMovePts(last.spot, last.atmIv, last.years);
  const sessions = sessionsLeft(nowMs, expiry);
  const day = perSession(move, sessions);
  const actual = actualDayPts(last.spot, hv20);
  return {
    t: last.t,
    atmIv: last.atmIv,
    sinceOpen: open?.change ?? null,
    range,
    move,
    movePct: isFigure(move) && last.spot ? (move / last.spot) * 100 : null,
    sessions,
    lastSession: isFigure(sessions) && sessions <= 1,
    day,
    actual,
    vsActual: pricedVsActual(day, actual),
    ivp: rank?.ivp ?? null,
    ivr: rank?.ivr ?? null,
    rankDays: rank?.n ?? null,
    verdict: ivVerdict(rank?.ivp),
    gaps: points.filter((p) => !isFigure(p.atmIv)).length,
  };
}
