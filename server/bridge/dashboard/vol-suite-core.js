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
import { b76Delta, black76 } from "./pricing.js";
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

/** Weekends closed, every weekday open: the test when no holiday calendar could be read. */
export const weekdaysOnly = (date) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ""));
  if (!m) return false;
  const w = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  return w !== 0 && w !== 6;
};

/**
 * A trading-day test from the reference holiday calendar (GET /v1/reference/holidays items): weekends and listed
 * holidays closed. A special session on a closed day (Muhurat, about an hour) is not counted as a session: it would
 * add a whole session's move for an hour of trading. `holidays` are { date, label } or date strings. Returns
 * (date) => boolean, with `.closed(date)` naming the holiday (null when none) and `.calendar` true.
 */
export function tradingDayTest(holidays = []) {
  const hol = new Map((holidays ?? []).map((x) => (typeof x === "string" ? [x, x] : [x?.date, x?.label ?? x?.date])).filter(([d]) => /^\d{4}-\d{2}-\d{2}$/.test(String(d ?? ""))));
  const test = (date) => weekdaysOnly(date) && !hol.has(date);
  test.closed = (date) => hol.get(date) ?? null;
  test.calendar = true;
  return test;
}

/** The weekdays from `nowMs`'s IST day to `expiry` (both included) that `isTradingDay` closes: [{ date, label }]. */
export function closedWeekdays(nowMs, expiry, isTradingDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(expiry ?? ""));
  if (!m || !Number.isFinite(nowMs) || typeof isTradingDay !== "function") return [];
  const expDay = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const out = [];
  for (let d = Math.floor((nowMs + IST_MS) / DAY_MS) * DAY_MS; d <= expDay && out.length < 60; d += DAY_MS) {
    const date = new Date(d).toISOString().slice(0, 10);
    if (weekdaysOnly(date) && !isTradingDay(date)) out.push({ date, label: isTradingDay.closed?.(date) ?? null });
  }
  return out;
}

/**
 * Trading sessions left from `nowMs` to the close of `expiry` (IST): the unspent part of today's session plus every
 * whole trading session after today up to and including expiry. `isTradingDay` (tradingDayTest) closes exchange
 * holidays; without it weekdays count. Null for a passed or malformed expiry.
 */
export function sessionsLeft(nowMs, expiry, { open = 555, close = 930, isTradingDay = weekdaysOnly } = {}) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(expiry ?? ""));
  if (!m || !Number.isFinite(nowMs)) return null;
  const expDay = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const ist = nowMs + IST_MS;
  const today = Math.floor(ist / DAY_MS) * DAY_MS;
  const minute = (ist - today) / 60_000;
  if (today > expDay || (today === expDay && minute >= close)) return null;
  const trades = (d) => (isTradingDay ?? weekdaysOnly)(new Date(d).toISOString().slice(0, 10));
  let n = trades(today) ? Math.min(1, Math.max(0, (close - Math.max(minute, open)) / (close - open))) : 0;
  for (let d = today + DAY_MS; d <= expDay; d += DAY_MS) if (trades(d)) n += 1;
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
export function expiryRow(chain, nowMs, { isTradingDay } = {}) {
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
  const sessions = sessionsLeft(nowMs, chain?.expiry, { isTradingDay });
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
export function ivTodayModel(points, { expiry, nowMs, hv20 = null, rank = null, isTradingDay } = {}) {
  const last = points[points.length - 1] ?? null;
  if (!last) return null;
  const open = changeOver(points, "atmIv", "day");
  const range = dayRange(points, "atmIv");
  const move = sigmaMovePts(last.spot, last.atmIv, last.years);
  const sessions = sessionsLeft(nowMs, expiry, { isTradingDay });
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
    holidays: closedWeekdays(nowMs, expiry, isTradingDay),
    calendar: Boolean(isTradingDay?.calendar),
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

// ── Straddle views: legs through the session (Premium Decay, Multi-Strike, Multi-Straddle, Price vs OI) ──

/** Most legs one Multi-Strike chart draws, and most strikes one Multi-Straddle chart draws. */
export const MULTI_LEG_MAX = 20;
export const MULTI_STRADDLE_MAX = 10;
/** The neutral tones a Multi-Straddle line takes (no direction is implied), two shades each: ten before they repeat. */
export const STRADDLE_TONES = Object.freeze(["iv", "today", "warn", "hv", "spot"]);

/** Every strike recorded over the session's readings (the union: the ladder moves with the ATM), in order. */
export function sessionStrikes(points) {
  const set = new Set();
  for (const p of points ?? []) for (const k of p?.raw?.strikes ?? []) if (pos(k)) set.add(Number(k));
  return [...set].sort((a, b) => a - b);
}

/** The recorded strike nearest `price`, or null. */
export function nearestStrike(strikes, price) {
  if (!pos(price) || !strikes?.length) return null;
  return strikes.reduce((b, k) => (Math.abs(k - price) < Math.abs(b - price) ? k : b));
}

/** The strikes within ±n of `centre` in the list (centre included), in order; [] when the centre is not listed. */
export function strikesAround(strikes, centre, n) {
  const list = [...(strikes ?? [])].sort((a, b) => a - b);
  const i = list.indexOf(centre);
  return i < 0 ? [] : list.slice(Math.max(0, i - n), i + n + 1);
}

/**
 * One leg's `key` ("ltp" or "oi") through the session: [{ t, v }], one per reading, v null where that reading has no
 * value (the recorder stores 0 for none). A gap stays a gap; it is never drawn as zero.
 */
export function legLine(points, strike, side, key = "ltp") {
  return (points ?? []).map((p) => {
    const s = p?.raw;
    const i = (s?.strikes ?? []).indexOf(strike);
    const v = i < 0 ? null : s?.[side]?.[key]?.[i];
    return { t: p.t, v: pos(v) ? Number(v) : null };
  });
}

/**
 * Premium Decay's baselines on a leg line: "open" each value minus the leg's first value in the window (the lines fan
 * out from zero); "prev" each value minus the reading before it (the first reading, with nothing before, is dropped;
 * a reading after a gap has no change either).
 */
export function decayLine(line, mode = "open") {
  const list = line ?? [];
  if (mode === "prev") return list.slice(1).map((p, i) => ({ t: p.t, v: p.v !== null && list[i].v !== null ? p.v - list[i].v : null }));
  const first = list.find((p) => p.v !== null);
  return first ? list.map((p) => ({ t: p.t, v: p.v !== null ? p.v - first.v : null })) : list.map((p) => ({ t: p.t, v: null }));
}

/** Lines added reading by reading: a reading counts only when every line has a value there (a missing leg is never 0). */
export function sumLines(lines) {
  const list = (lines ?? []).filter(Boolean);
  if (!list.length) return [];
  return list[0].map((p, i) => ({ t: p.t, v: list.every((l) => l[i] && l[i].v !== null) ? list.reduce((s, l) => s + l[i].v, 0) : null }));
}

/** The strike's own Put Call Ratio by reading: Put OI ÷ Call OI at that strike only; null where Call OI is 0 or a leg is missing. */
export function strikePcrLine(points, strike) {
  const c = legLine(points, strike, "ce", "oi");
  const p = legLine(points, strike, "pe", "oi");
  return c.map((x, i) => ({ t: x.t, v: x.v !== null && p[i].v !== null ? p[i].v / x.v : null }));
}

/** Each value's change from the line's first value (OI since the session's first reading); gaps stay gaps. */
export function changeSinceFirst(line) {
  return decayLine(line, "open");
}

/** The first and last values of a line and their change: { first, last, change } (null without two values). */
export function lineEnds(line) {
  const vals = (line ?? []).filter((p) => p.v !== null);
  if (vals.length < 2) return null;
  return { first: vals[0].v, last: vals[vals.length - 1].v, change: vals[vals.length - 1].v - vals[0].v, firstT: vals[0].t, lastT: vals[vals.length - 1].t };
}

/** The colour of the i-th pick on a side: shade 0 for the first, paler by pick order (four steps, then again). */
export const shadeOf = (i) => Math.max(0, Math.floor(Number(i) || 0)) % 4;

/** A Multi-Straddle line's tone and shade by pick order: five neutral tones, two shades, ten before they repeat. */
export function straddleTone(i) {
  const n = Math.max(0, Math.floor(Number(i) || 0)) % (STRADDLE_TONES.length * 2);
  return { tone: STRADDLE_TONES[n % STRADDLE_TONES.length], shade: n < STRADDLE_TONES.length ? 0 : 2 };
}

/** The leg's name as the keys print it: "24500 CE". */
export const legName = (strike, side) => `${formatInt(strike)} ${side === "pe" ? "PE" : "CE"}`;

// ── The smile at the session's first reading (Volatility › Smile, "open vs now") ──

/**
 * The OTM smile of one recorder snapshot, in the shape the smile chart's compare curve reads: each strike's OTM leg
 * (Call at or above the forward, Put below; the other side when that one has no IV), its moneyness against the
 * snapshot's own forward and its call delta. { t, forward, points } or null without a forward, a time or two strikes.
 */
export function smileFromSnapshot(snap) {
  const F = num(snap?.forward);
  const T = num(snap?.t);
  const t = Date.parse(snap?.ts ?? snap?.slot ?? "");
  if (!pos(F) || !pos(T)) return null;
  const points = [];
  (snap?.strikes ?? []).forEach((k, i) => {
    if (!pos(k)) return;
    const K = Number(k);
    const ce = pos(snap?.ce?.iv?.[i]) ? Number(snap.ce.iv[i]) : null;
    const pe = pos(snap?.pe?.iv?.[i]) ? Number(snap.pe.iv[i]) : null;
    const want = K >= F ? "ce" : "pe";
    const other = want === "ce" ? "pe" : "ce";
    const ivOf = (s) => (s === "ce" ? ce : pe);
    const side = ivOf(want) !== null ? want : ivOf(other) !== null ? other : null;
    if (!side) return;
    const iv = ivOf(side);
    points.push({ strike: K, m: (K / F - 1) * 100, callDelta: b76Delta(F, K, T, iv, "CE"), otm: { side, iv, q: "ltp" } });
  });
  return points.length >= 2 ? { t: Number.isFinite(t) ? t : null, forward: F, points: points.sort((a, b) => a.strike - b.strike) } : null;
}

// ── GEX through the session (GET /v1/analytics/exposure/session) ──

/** The index of the reading nearest `t` (the last one for null). -1 for no readings. */
export function nearestIndex(points, t) {
  const list = points ?? [];
  if (!list.length) return -1;
  if (!isFigure(t)) return list.length - 1;
  let best = 0;
  list.forEach((p, i) => {
    if (Math.abs(p.t - t) < Math.abs(list[best].t - t)) best = i;
  });
  return best;
}

/**
 * The three session cards as chart-lite specs, each with a marker at the reading shown (`at`, epoch ms; none at the
 * latest):
 *   levels    spot through the day against the flip and the walls as each reading solved them;
 *   strikes   spot through the day with the strikes carrying the most net gamma at the reading shown as levels;
 *   exposure  net gamma (filled, green above zero, red below) and Both sides on its own scale (a line, never filled).
 * `reading` is the full reading at `at` (for the strike levels). Fewer than two readings give `empty` cards.
 */
export function gexSessionSpecs(points, { underlying = "", at = null, reading = null, top = 5 } = {}) {
  const list = (points ?? []).filter((p) => isFigure(p?.t));
  if (list.length < 2) {
    const empty = { empty: { title: list.length ? "One reading so far" : "Nothing recorded yet", text: "The session cards draw from the second recorded reading." } };
    return { levels: empty, strikes: empty, exposure: empty };
  }
  const line = (key) => list.filter((p) => isFigure(p[key])).map((p) => ({ t: p.t, v: Number(p[key]) }));
  const shownT = isFigure(at) ? list[nearestIndex(list, at)].t : null;
  const marker = shownT !== null && shownT !== list[list.length - 1].t ? [{ id: "at", type: "marker", t: shownT, label: "Shown", tone: "today" }] : [];
  const lvl = (v) => (isFigure(v) ? formatInt(v) : DASH);
  const levels = {
    label: `${underlying}: spot through the session against the gamma flip and the walls at each reading`,
    panes: [{ id: "px", format: (v) => formatInt(v) }],
    series: [
      { id: "spot", type: "line", pane: "px", label: "Spot", tone: "spot", data: line("spot"), format: (v) => formatFixed(v, 2) },
      { id: "flip", type: "line", pane: "px", label: "Gamma flip", tone: "warn", dash: true, data: line("flip"), format: lvl },
      { id: "cw", type: "line", pane: "px", label: "Call wall", tone: "call", weight: "thin", data: line("callWall"), format: lvl },
      { id: "pw", type: "line", pane: "px", label: "Put wall", tone: "put", weight: "thin", data: line("putWall"), format: lvl },
      ...marker,
    ],
  };
  const rows = (reading?.strikes ?? []).filter((r) => isFigure(r?.netGex) && r.netGex !== 0);
  const heavy = [...rows].sort((a, b) => Math.abs(b.netGex) - Math.abs(a.netGex)).slice(0, top);
  const strikes = {
    label: `${underlying}: spot through the session and the ${heavy.length} strikes with the most net gamma at the reading shown`,
    panes: [{ id: "px", format: (v) => formatInt(v) }],
    series: [
      { id: "spot", type: "line", pane: "px", label: "Spot", tone: "spot", data: line("spot"), format: (v) => formatFixed(v, 2) },
      ...heavy.map((r) => ({ id: `k${r.strike}`, type: "level", pane: "px", value: r.strike, label: `${formatInt(r.strike)} ${r.netGex < 0 ? MINUS : "+"}${formatInt(Math.abs(r.netGex) / 1e7)} Cr`, tone: r.netGex > 0 ? "pos" : "neg", dash: false })),
      ...marker,
    ],
  };
  const exposure = {
    label: `${underlying}: net gamma exposure through the session (filled) and both sides on their own scale`,
    panes: [
      { id: "net", weight: 2, label: "Net, ₹ per 1% move", format: (v) => rupeeCr(v), include: [0] },
      { id: "gross", weight: 1, label: "Both sides", format: (v) => rupeeCr(v) },
    ],
    series: [
      { id: "net", type: "area", pane: "net", label: "Net", signed: true, baseline: 0, data: line("net"), format: rupeeCr },
      { id: "gross", type: "line", pane: "gross", label: "Both sides", tone: "muted", data: line("gross"), format: rupeeCr },
      ...marker,
    ],
  };
  return { levels, strikes, exposure };
}

/**
 * The session as of reading `i`: the net's change over 5 minutes, 15 minutes and the day (each measured back from that
 * reading), how many times the net changed sign so far, the flip's range so far, and how many strikes the ladder grew.
 */
export function gexSessionModel(points, i, { ladder = null } = {}) {
  const list = points ?? [];
  if (!list.length || i < 0 || i >= list.length) return null;
  const upTo = list.slice(0, i + 1);
  const now = upTo[upTo.length - 1];
  const win = (w) => changeOver(upTo, "net", w, { tolMs: w === 5 ? 200_000 : 300_000 });
  let flips = 0;
  for (let k = 1; k < upTo.length; k++) {
    const a = upTo[k - 1].net;
    const b = upTo[k].net;
    if (isFigure(a) && isFigure(b) && a !== 0 && b !== 0 && Math.sign(a) !== Math.sign(b)) flips += 1;
  }
  return {
    t: now.t,
    index: i,
    latest: i === list.length - 1,
    net: isFigure(now.net) ? Number(now.net) : null,
    changes: { m5: win(5), m15: win(15), day: win("day") },
    signChanges: flips,
    flipRange: dayRange(upTo, "flip"),
    grew: ladder && isFigure(ladder.first) && isFigure(ladder.last) && ladder.last > ladder.first ? ladder.last - ladder.first : 0,
  };
}
