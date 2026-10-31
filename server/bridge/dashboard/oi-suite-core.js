// oi-suite-core.js: the pure maths behind OI Analysis › OI change, Spurts, PCR, Max pain and Analytics › Exposure ›
// OI heatmap (analyticsOi.js draws them). Input is the Bridge recorder's day (GET /v1/options/snapshots, columnar),
// turned into frames once; every read below is a function of frames. No DOM, no fetch, no clock.
//
// Words are descriptions of what the book did, never advice: a leg's build-up names what its premium and open
// interest did together, and its lean says which way that position points for the underlying ("leans up" / "leans
// down"). Missing figures stay null (the page prints a dash), never 0.
import { isFigure } from "./format.js";

const num = (v) => (isFigure(v) ? Number(v) : null);
const MIN = 60_000;

/** The windows every view offers: id, label. "day" is since the first reading of the session. */
export const OIX_WINDOWS = Object.freeze([["5", "5m"], ["15", "15m"], ["30", "30m"], ["60", "1h"], ["day", "Day"]]);

/**
 * Recorder snapshots (API shape) as frames, oldest first: { t, hm, spot, atm, lot, k, co, po, cl, pl }. A snapshot
 * without a price or strikes is left out. While the recorder warms up the first frames can carry almost no OI: frames
 * at the start whose total OI is under 5 % of the day's median are trimmed, so no window starts on them.
 * @param {Array<object>} snaps
 */
export function framesFrom(snaps) {
  const out = [];
  for (const s of snaps ?? []) {
    const t = Date.parse(s?.slot ?? s?.ts ?? "");
    const k = Array.isArray(s?.strikes) ? s.strikes.map(Number) : [];
    if (!Number.isFinite(t) || !k.length || !(num(s?.spot) > 0)) continue;
    const col = (side, f) => k.map((_, i) => num(s?.[side]?.[f]?.[i]));
    const iso = String(s.slot ?? s.ts);
    out.push({ t, hm: /T(\d{2}:\d{2})/.exec(iso)?.[1] ?? "", spot: Number(s.spot), atm: num(s.atm), lot: num(s.lotSize) || 1, k, co: col("ce", "oi"), po: col("pe", "oi"), cl: col("ce", "ltp"), pl: col("pe", "ltp") });
  }
  out.sort((a, b) => a.t - b.t);
  const total = (f) => f.co.reduce((a, v) => a + (v ?? 0), 0) + f.po.reduce((a, v) => a + (v ?? 0), 0);
  const sorted = out.map(total).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  let start = 0;
  while (start < out.length - 1 && total(out[start]) < median * 0.05) start += 1;
  return out.slice(start);
}

/** The ATM strike of a frame: the recorder's own, else the listed strike nearest the price. */
export function atmOf(frame) {
  if (!frame?.k?.length) return null;
  if (frame.atm !== null && frame.atm !== undefined && frame.k.includes(frame.atm)) return frame.atm;
  return frame.k.reduce((b, k) => (Math.abs(k - frame.spot) < Math.abs(b - frame.spot) ? k : b), frame.k[0]);
}

/**
 * The strikes in scope: `each` listed strikes either side of ATM (counted in rows, not points), or all of them when
 * `each` is null. Returns the strike values in listing order.
 */
export function scopeStrikes(frame, each = null) {
  const k = frame?.k ?? [];
  if (each === null || each === undefined || !(Number(each) >= 0)) return [...k];
  const i = k.indexOf(atmOf(frame));
  if (i < 0) return [...k];
  return k.slice(Math.max(0, i - Number(each)), i + Number(each) + 1);
}

/**
 * The two frames a window compares: the latest, and the one nearest `win` minutes before it. States:
 *  - "ok": a frame sits within `tolMin` of the boundary;
 *  - "short": the session is younger than the window, so it starts at the first frame (spanMin says how long it is);
 *  - "gap": the nearest frame is further than `tolMin` from the boundary (a hole in the recording): not measured;
 *  - "none": fewer than two frames.
 * "day" always compares with the first frame.
 */
export function windowFrames(frames, win, { tolMin = 2.5 } = {}) {
  const list = frames ?? [];
  const latest = list.at(-1) ?? null;
  if (list.length < 2) return { state: "none", base: null, latest, spanMin: 0, wantMin: win === "day" ? null : Number(win) };
  const span = (b) => Math.round((latest.t - b.t) / MIN);
  if (win === "day") return { state: "ok", base: list[0], latest, spanMin: span(list[0]), wantMin: null };
  const want = Number(win);
  const target = latest.t - want * MIN;
  if (list[0].t > target + tolMin * MIN) return { state: "short", base: list[0], latest, spanMin: span(list[0]), wantMin: want };
  let base = list[0];
  for (const f of list) if (f !== latest && Math.abs(f.t - target) < Math.abs(base.t - target)) base = f;
  if (Math.abs(base.t - target) > tolMin * MIN) return { state: "gap", base: null, latest, spanMin: span(base), wantMin: want };
  return { state: "ok", base, latest, spanMin: span(base), wantMin: want };
}

/** Build-up from the change in OI and in premium: LB (both up), SB (OI up, premium down), SC (OI down, premium up), LU (both down). Null when either is flat or missing. */
export function buildupCode(dOi, dPx) {
  if (!isFigure(dOi) || !isFigure(dPx) || Number(dOi) === 0 || Number(dPx) === 0) return null;
  if (dOi > 0) return dPx > 0 ? "LB" : "SB";
  return dPx > 0 ? "SC" : "LU";
}

/** The four build-ups: a name, who is acting in plain words (no order-side words), and the corner on the map. */
export const BUILDUPS = Object.freeze({
  SB: Object.freeze({ name: "Short build-up", plain: "Writers adding", oi: "up", px: "down" }),
  LB: Object.freeze({ name: "Long build-up", plain: "Holders adding", oi: "up", px: "up" }),
  LU: Object.freeze({ name: "Long unwinding", plain: "Holders exiting", oi: "down", px: "down" }),
  SC: Object.freeze({ name: "Short covering", plain: "Writers covering", oi: "down", px: "up" }),
});
/** Map order: top-left, top-right, bottom-left, bottom-right. */
export const BUILDUP_ORDER = Object.freeze(["SB", "LB", "LU", "SC"]);

/** Which way a leg's build-up points for the underlying: +1 up, −1 down, 0 none. A call held or covered points up; a put the same points down. */
export function leanOf(side, code) {
  if (!code) return 0;
  const up = code === "LB" || code === "SC" ? 1 : -1;
  return side === "pe" ? -up : up;
}

/**
 * Every leg's move between two frames: [{ strike, side, oi0, oi1, d, pct, px0, px1, pxPct, code, lean, thin }].
 * `strikes` limits the strikes read (null: all strikes listed in both frames); `legs` "both" | "ce" | "pe". A leg that
 * opened the window with `thinOi` contracts or fewer, or a premium of `thinPx` or less, is thin: its percentage is not
 * trusted, so it gets no build-up and no lean (its contracts still count as opened or closed).
 */
export function legMoves(base, latest, { strikes = null, legs = "both", thinOi = 5000, thinPx = 0.05 } = {}) {
  if (!base || !latest) return [];
  const want = strikes ? new Set(strikes) : null;
  const at = new Map(base.k.map((k, i) => [k, i]));
  const out = [];
  latest.k.forEach((strike, j) => {
    if (want && !want.has(strike)) return;
    const i = at.get(strike);
    if (i === undefined) return;
    for (const side of ["ce", "pe"]) {
      if (legs !== "both" && legs !== side) continue;
      const oi0 = side === "ce" ? base.co[i] : base.po[i];
      const oi1 = side === "ce" ? latest.co[j] : latest.po[j];
      if (oi0 === null || oi1 === null) continue;
      const px0 = side === "ce" ? base.cl[i] : base.pl[i];
      const px1 = side === "ce" ? latest.cl[j] : latest.pl[j];
      const d = oi1 - oi0;
      const thin = oi0 <= thinOi || px0 === null || px0 <= thinPx;
      const dPx = px0 !== null && px1 !== null ? px1 - px0 : null;
      const code = thin ? null : buildupCode(d, dPx);
      out.push({
        strike,
        side,
        oi0,
        oi1,
        d,
        pct: oi0 > 0 ? (d / oi0) * 100 : null,
        px0,
        px1,
        pxPct: px0 !== null && px0 > 0 && px1 !== null ? ((px1 - px0) / px0) * 100 : null,
        code,
        lean: leanOf(side, code),
        thin,
      });
    }
  });
  return out;
}

/** The verdict words for a regime and a lean. */
const VERDICTS = Object.freeze({
  "building|up": ["Leans up · new positions", "New positions are going on faster than old ones come off, and most of the size that moved points up."],
  "building|down": ["Leans down · new positions", "New positions are going on faster than old ones come off, and most of the size that moved points down."],
  "building|none": ["Positions added on both sides", "The book is growing and neither direction is ahead."],
  "closing|up": ["Leans up · positions closing", "Positions are coming off, mostly ones that pointed down."],
  "closing|down": ["Leans down · positions closing", "Positions are coming off, mostly ones that pointed up."],
  "closing|none": ["Positions closed on both sides", "Positions are coming off and neither direction is ahead."],
  "churning|up": ["Leaning up", "Opened and closed are near even; most of what moved points up."],
  "churning|down": ["Leaning down", "Opened and closed are near even; most of what moved points down."],
  "churning|none": ["Turnover, no clear lean", "Both directions are turning over at a similar pace."],
});

/**
 * The board in one reading (the Spurts and OI change hero):
 *  - opened / closed: contracts added and removed; net = (opened − closed) ÷ (opened + closed): building at +1/6 or
 *    more, closing at −1/6 or less, churning between. Under a floor (20 lots, or 0.05 % of the OI standing on the
 *    strikes read, whichever is larger) the board is quiet;
 *  - lean: of the size with a direction (each leg weighted by contracts moved), 60 % or more up leans up, 40 % or less
 *    leans down. If under 25 % of the size has a direction, the lean is too thin to read;
 *  - three checks of how firmly the board backs it (never changing it): one direction holds 65 %+, one build-up
 *    carries 45 %+ of everything that moved, and at least 3 legs moved by `bar` % or more of their own book;
 *  - levels this window wrote or covered: the call at or above price with the most short build-up (a possible
 *    ceiling), the put at or below price with the most (a possible floor), and the largest short covering on either.
 */
export function boardReading(moves, { bar = 20, lot = 1, spot = null } = {}) {
  let opened = 0;
  let closed = 0;
  let standing = 0;
  let up = 0;
  let down = 0;
  const buckets = { SB: { sum: 0, n: 0 }, LB: { sum: 0, n: 0 }, LU: { sum: 0, n: 0 }, SC: { sum: 0, n: 0 } };
  let big = 0;
  for (const m of moves ?? []) {
    if (m.d > 0) opened += m.d;
    else closed -= m.d;
    standing += m.oi1 ?? 0;
    if (m.lean > 0) up += Math.abs(m.d);
    if (m.lean < 0) down += Math.abs(m.d);
    if (m.code) {
      buckets[m.code].sum += Math.abs(m.d);
      buckets[m.code].n += 1;
    }
    if (!m.thin && m.pct !== null && Math.abs(m.pct) >= bar) big += 1;
  }
  const total = opened + closed;
  const floor = Math.max(20 * (lot || 1), standing * 0.0005);
  const net = total > 0 ? (opened - closed) / total : null;
  const dir = up + down;
  const dirShare = total > 0 ? dir / total : null;
  const upShare = dir > 0 ? up / dir : null;
  let regime = "quiet";
  let lean = "none";
  if (total >= floor && total > 0) {
    regime = net >= 1 / 6 ? "building" : net <= -1 / 6 ? "closing" : "churning";
    if (dirShare < 0.25) lean = "thin";
    else lean = upShare >= 0.6 ? "up" : upShare <= 0.4 ? "down" : "none";
  }
  const [word, detail] = regime === "quiet" ? ["Quiet", "Too few contracts changed to read a direction."] : lean === "thin" ? ["No clear lean", "Contracts moved, but too little of the size moved on both OI and premium to say which way it points."] : VERDICTS[`${regime}|${lean}`];
  const tone = lean === "up" ? "pos" : lean === "down" ? "neg" : "zero";
  const topBucket = Object.entries(buckets).sort((a, b) => b[1].sum - a[1].sum)[0];
  const checks = [
    { id: "side", label: "One direction leads", pass: dir > 0 && Math.max(up, down) / dir >= 0.65, detail: dir > 0 ? `${Math.round((Math.max(up, down) / dir) * 100)}% of the directional size points one way (needs 65%)` : "No size with a direction" },
    { id: "behaviour", label: "One build-up leads", pass: total > 0 && topBucket[1].sum / total >= 0.45, detail: total > 0 ? `${BUILDUPS[topBucket[0]].name} carries ${Math.round((topBucket[1].sum / total) * 100)}% of all that moved (needs 45%)` : "Nothing moved" },
    { id: "big", label: `Legs over the ${bar}% bar`, pass: big >= 3, detail: `${big} leg${big === 1 ? "" : "s"} moved ${bar}% or more of their own book (needs 3)` },
  ];
  const passes = checks.filter((c) => c.pass).length;
  const s = num(spot);
  // The most contracts; a tie goes to the strike nearer the price.
  const pick = (list) => list.reduce((b, m) => (!b || Math.abs(m.d) > Math.abs(b.d) || (Math.abs(m.d) === Math.abs(b.d) && Math.abs(m.strike - s) < Math.abs(b.strike - s)) ? m : b), null);
  const levels =
    s === null
      ? { ceiling: null, floor: null, covering: null }
      : {
          ceiling: pick((moves ?? []).filter((m) => m.side === "ce" && m.code === "SB" && m.strike >= s)),
          floor: pick((moves ?? []).filter((m) => m.side === "pe" && m.code === "SB" && m.strike <= s)),
          covering: pick((moves ?? []).filter((m) => m.code === "SC" && ((m.side === "ce" && m.strike >= s) || (m.side === "pe" && m.strike <= s)))),
        };
  return { opened, closed, total, net, regime, lean, upShare, dirShare, word, detail, tone, checks, firmness: passes >= 3 ? "firm" : passes === 2 ? "partial" : "thin", buckets, big, legs: (moves ?? []).length, levels };
}

/** Each build-up's loudest legs by contracts moved (never by percent): { SB: { rows, more, sum }, ... }. */
export function topMoves(moves, n = 3) {
  const out = {};
  for (const code of BUILDUP_ORDER) {
    const list = (moves ?? []).filter((m) => m.code === code).sort((a, b) => Math.abs(b.d) - Math.abs(a.d) || a.strike - b.strike);
    out[code] = { rows: list.slice(0, n), more: Math.max(0, list.length - n), sum: list.reduce((a, m) => a + m.d, 0) };
  }
  return out;
}

/**
 * OI added and cut by strike between two frames (the OI change view): rows [{ strike, ce, pe }] where a side is
 * { d, oi1, code } or null, plus totals { ceAdd, ceCut, peAdd, peCut, ce, pe } (cut as a positive number).
 */
export function changeByStrike(moves) {
  const by = new Map();
  const tot = { ceAdd: 0, ceCut: 0, peAdd: 0, peCut: 0, ce: 0, pe: 0 };
  for (const m of moves ?? []) {
    const r = by.get(m.strike) ?? { strike: m.strike, ce: null, pe: null };
    r[m.side] = { d: m.d, oi1: m.oi1, oi0: m.oi0, code: m.code, pct: m.pct };
    by.set(m.strike, r);
    tot[m.side] += m.d;
    if (m.d > 0) tot[`${m.side}Add`] += m.d;
    else tot[`${m.side}Cut`] -= m.d;
  }
  return { rows: [...by.values()].sort((a, b) => a.strike - b.strike), totals: tot };
}

/**
 * One sentence for the OI change hero, from the totals: which side added more (or cut more) over the window. Words
 * describe the book only. `x` is the share gap under which the two are called even (12 % of the two together).
 */
export function changeReading(totals, { even = 0.12 } = {}) {
  if (!totals) return { word: "Not measured", tone: "zero", key: "none" };
  const c = totals.ce;
  const p = totals.pe;
  if (c === 0 && p === 0) return { word: "No change", tone: "zero", key: "flat" };
  const gap = Math.abs(p - c);
  const scale = Math.abs(p) + Math.abs(c);
  if (scale > 0 && gap / scale < even) return { word: "Even change on both sides", tone: "zero", key: "even" };
  if (p > 0 && c <= 0) return { word: "Puts added, calls cut", tone: "pos", key: "put-add-call-cut" };
  if (c > 0 && p <= 0) return { word: "Calls added, puts cut", tone: "neg", key: "call-add-put-cut" };
  if (p > 0 && c > 0) return p > c ? { word: "More puts added than calls", tone: "pos", key: "puts-lead" } : { word: "More calls added than puts", tone: "neg", key: "calls-lead" };
  // Both cut: the side cut more is the one giving way.
  return -c > -p ? { word: "More calls closed than puts", tone: "pos", key: "calls-closed" } : { word: "More puts closed than calls", tone: "neg", key: "puts-closed" };
}

// ── PCR ──

/** Put and call OI over the strikes in scope and their ratio (null without call OI). Only strikes with both sides count. */
export function scopedTotals(frame, each = null) {
  if (!frame) return { ce: null, pe: null, pcr: null, n: 0, lo: null, hi: null, centre: null };
  const want = new Set(scopeStrikes(frame, each));
  let ce = 0;
  let pe = 0;
  let n = 0;
  let lo = null;
  let hi = null;
  frame.k.forEach((k, i) => {
    if (!want.has(k) || frame.co[i] === null || frame.po[i] === null) return;
    ce += frame.co[i];
    pe += frame.po[i];
    n += 1;
    lo = lo === null ? k : Math.min(lo, k);
    hi = hi === null ? k : Math.max(hi, k);
  });
  return { ce: n ? ce : null, pe: n ? pe : null, pcr: n && ce > 0 ? pe / ce : null, n, lo, hi, centre: atmOf(frame) };
}

/** The ratio through the day, one point per frame: [{ t, hm, pcr, ce, pe, spot }]. */
export function pcrSeries(frames, each = null) {
  return (frames ?? []).map((f) => {
    const s = scopedTotals(f, each);
    return { t: f.t, hm: f.hm, pcr: s.pcr, ce: s.ce, pe: s.pe, spot: f.spot };
  });
}

/** Two decimals, as printed: every comparison uses the printed figure. */
const r2 = (v) => Math.round(v * 100) / 100;

/** Where the printed ratio crossed 1.00 (exactly 1.00 counts as above): [{ t, hm, dir: "up" | "down", from, to }]. */
export function pcrCrossings(series) {
  const out = [];
  let prev = null;
  for (const p of series ?? []) {
    if (p.pcr === null) continue;
    if (prev !== null) {
      const a = r2(prev.pcr) >= 1;
      const b = r2(p.pcr) >= 1;
      if (a !== b) out.push({ t: p.t, hm: p.hm, dir: b ? "up" : "down", from: r2(prev.pcr), to: r2(p.pcr) });
    }
    prev = p;
  }
  return out;
}

/** First, last, change, high and low (with their times) of a series' `key`. Nulls are skipped. */
export function seriesStats(series, key = "pcr") {
  const pts = (series ?? []).filter((p) => isFigure(p[key]));
  if (!pts.length) return { first: null, last: null, change: null, hi: null, lo: null, hiAt: "", loAt: "" };
  let hi = pts[0];
  let lo = pts[0];
  for (const p of pts) {
    if (p[key] > hi[key]) hi = p;
    if (p[key] < lo[key]) lo = p;
  }
  return { first: pts[0][key], last: pts.at(-1)[key], change: pts.at(-1)[key] - pts[0][key], hi: hi[key], lo: lo[key], hiAt: hi.hm, loAt: lo.hm };
}

/** PCR at each strike in scope: [{ strike, pcr, ce, pe }]; null where the call side has no OI. */
export function strikePcrs(frame, each = null) {
  if (!frame) return [];
  const want = new Set(scopeStrikes(frame, each));
  const out = [];
  frame.k.forEach((k, i) => {
    if (!want.has(k)) return;
    const ce = frame.co[i];
    const pe = frame.po[i];
    out.push({ strike: k, ce, pe, pcr: ce !== null && pe !== null && ce > 0 ? pe / ce : null });
  });
  return out;
}

/** The PCR of each expiry column of the OI explorer (GET /v1/analytics/oi-explorer): [{ expiry, ce, pe, pcr }]. */
export function expiryPcrs(columns) {
  return (columns ?? []).map((c) => {
    const ce = num(c.callOi);
    const pe = num(c.putOi);
    return { expiry: c.expiry, ce, pe, pcr: ce !== null && pe !== null && ce > 0 ? pe / ce : null };
  });
}

// ── Max pain ──

/**
 * Pain at each listed strike K (what option holders would collect if the expiry settled at K): Σ call OI × (K − k)⁺ +
 * Σ put OI × (k − K)⁺, split into its call and put parts. The level is the lowest total; a tie goes to the strike
 * nearer the price. Null with fewer than 3 strikes carrying OI.
 * @returns {{ strike: number, pain: number, curve: Array<{ strike: number, pain: number, call: number, put: number }> } | null}
 */
export function painCurve(frame) {
  if (!frame?.k?.length) return null;
  const legs = frame.k.map((k, i) => [k, frame.co[i] ?? 0, frame.po[i] ?? 0, frame.co[i] !== null || frame.po[i] !== null]);
  if (legs.filter((l) => l[3]).length < 3 || !legs.some((l) => l[1] > 0 || l[2] > 0)) return null;
  const curve = [];
  let best = null;
  for (const [K] of legs) {
    let call = 0;
    let put = 0;
    for (const [k, c, p] of legs) {
      if (K > k) call += c * (K - k);
      else if (k > K) put += p * (k - K);
    }
    const pain = call + put;
    curve.push({ strike: K, pain, call, put });
    if (!best || pain < best.pain || (pain === best.pain && Math.abs(K - frame.spot) < Math.abs(best.strike - frame.spot))) best = { strike: K, pain };
  }
  return { strike: best.strike, pain: best.pain, curve };
}

/** The level through the day: [{ t, hm, strike, spot }], one per frame (null strike where it cannot be read). */
export function painSeries(frames) {
  return (frames ?? []).map((f) => ({ t: f.t, hm: f.hm, strike: painCurve(f)?.strike ?? null, spot: f.spot }));
}

/** Where the level changed strike: [{ t, hm, from, to }]. */
export function painMoves(series) {
  const out = [];
  let prev = null;
  for (const p of series ?? []) {
    if (p.strike === null) continue;
    if (prev !== null && p.strike !== prev) out.push({ t: p.t, hm: p.hm, from: prev, to: p.strike });
    prev = p.strike;
  }
  return out;
}

/**
 * How flat the floor is: the extra pain at the cheaper neighbour of the level, in % of the level's pain. Under 1 % the
 * floor is flat (a small change in OI can move the level a strike); 1–5 % moderate; above, sharp.
 */
export function painFloor(pc) {
  if (!pc?.curve?.length) return { pct: null, word: null };
  const i = pc.curve.findIndex((c) => c.strike === pc.strike);
  const nb = [pc.curve[i - 1], pc.curve[i + 1]].filter(Boolean);
  if (!nb.length || !(pc.pain > 0)) return { pct: null, word: null };
  const next = Math.min(...nb.map((c) => c.pain));
  const pct = ((next - pc.pain) / pc.pain) * 100;
  return { pct, word: pct < 1 ? "flat" : pct <= 5 ? "moderate" : "sharp" };
}

// ── Heatmap through the day ──

/** One frame per `stepMin` step (the last reading in each), the newest frame always last. */
export function timeColumns(frames, stepMin = 15) {
  const list = frames ?? [];
  if (!list.length) return [];
  const t0 = list[0].t;
  const step = Math.max(1, stepMin) * MIN;
  const byStep = new Map();
  for (const f of list) byStep.set(Math.floor((f.t - t0) / step), f);
  const cols = [...byStep.values()];
  if (cols.at(-1) !== list.at(-1)) cols.push(list.at(-1));
  return cols;
}

/**
 * The strike × time plane: rows highest strike first, each with `ce` and `pe` cells (one per column, oldest first):
 * { oi, d, code, px } where d and code compare with the column before (null on the first column, or when a side is
 * missing). `max` holds the largest OI and the largest |change| of each side, so each wing scales on its own.
 */
export function heatPlane(cols, strikes) {
  const rows = [...(strikes ?? [])].sort((a, b) => b - a).map((strike) => ({ strike, ce: [], pe: [] }));
  const max = { ce: 0, pe: 0, dce: 0, dpe: 0 };
  const idx = cols.map((f) => new Map(f.k.map((k, i) => [k, i])));
  for (const row of rows) {
    cols.forEach((f, c) => {
      const i = idx[c].get(row.strike);
      const pi = c > 0 ? idx[c - 1].get(row.strike) : undefined;
      for (const side of ["ce", "pe"]) {
        const oiArr = side === "ce" ? "co" : "po";
        const pxArr = side === "ce" ? "cl" : "pl";
        const oi = i === undefined ? null : f[oiArr][i];
        const px = i === undefined ? null : f[pxArr][i];
        const was = c > 0 && pi !== undefined ? cols[c - 1][oiArr][pi] : null;
        const wasPx = c > 0 && pi !== undefined ? cols[c - 1][pxArr][pi] : null;
        const d = oi !== null && was !== null ? oi - was : null;
        const code = d !== null && px !== null && wasPx !== null ? buildupCode(d, px - wasPx) : null;
        row[side].push({ oi, d, code, px });
        if (oi !== null) max[side] = Math.max(max[side], oi);
        if (d !== null) max[`d${side}`] = Math.max(max[`d${side}`], Math.abs(d));
      }
    });
  }
  return { rows, max };
}

/** A tile's strength from 0 to 1 on a square-root scale (mid-sized tiles still show), rounded to 2 decimals. */
export function shade(v, max) {
  if (!isFigure(v) || !(Number(max) > 0)) return 0;
  return Math.round(Math.min(1, Math.sqrt(Math.abs(Number(v)) / Number(max))) * 100) / 100;
}

/** The `n` largest values of a side across the plane, as a Set of "strike|column" keys. */
export function planeTop(plane, side, n = 3, key = "oi") {
  const cells = [];
  for (const r of plane?.rows ?? []) r[side].forEach((c, i) => isFigure(c[key]) && cells.push({ k: `${r.strike}|${i}`, v: Math.abs(c[key]) }));
  cells.sort((a, b) => b.v - a.v);
  return new Set(cells.slice(0, n).filter((c) => c.v > 0).map((c) => c.k));
}
