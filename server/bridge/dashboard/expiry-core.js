// expiry-core.js: the expiry-day desk on Positions (persona X, BRD A16, D8). Pure: no DOM, no fetch, no clock.
// Which legs expire today or the next session, the book's gamma by strike, pin risk near spot, max pain and the OI
// walls, the time value left to decay by the close, and the legs at risk of assignment or physical settlement. Facts
// only: every figure says what it is, never what to do.
import { INDEX_UNDERLYINGS } from "./span-margin.js";

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const IST = 19_800_000;
const DAY_MS = 86_400_000;
export const istDayOf = (ms) => new Date(ms + IST).toISOString().slice(0, 10);

/** Epoch ms of the close ("HH:MM" IST, from the reference session) on an expiry day; NaN without one. */
export function closeMs(expiry, close) {
  return /^\d{2}:\d{2}$/.test(String(close ?? "")) ? Date.parse(`${expiry}T${close}:00+05:30`) : NaN;
}

/** The next weekday after an IST day (holidays aside): "today or the next session" for Friday reaches Monday. */
export function nextSessionDay(day) {
  let ms = Date.parse(`${day}T00:00:00Z`) + DAY_MS;
  while ([0, 6].includes(new Date(ms).getUTCDay())) ms += DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The expiry the desk shows: the nearest held expiry that is today or the next session, else null. `{ expiry, when:
 * "today"|"next" }`.
 */
export function deskExpiry(legs, nowMs, close) {
  const today = istDayOf(nowMs);
  const next = nextSessionDay(today);
  const exps = [...new Set((legs ?? []).filter((l) => num(l.q) && l.expiry).map((l) => l.expiry))].sort();
  const e = exps.find((x) => x === today && !(nowMs >= closeMs(x, close))) ?? exps.find((x) => x > today && x <= next);
  return e ? { expiry: e, when: e === today ? "today" : "next" } : null;
}

const intrinsic = (l, S) => (l.right === "CE" ? Math.max(0, S - l.strike) : Math.max(0, l.strike - S));

/**
 * Gamma of the expiring option legs by strike: per strike, Γ (units per point, signed by your quantity), the delta change
 * for a 1 % move (Γ × q × S × 1 %) and the P&L from gamma alone over a 1 % move (½ Γ q (S × 1 %)²). Sorted by strike.
 */
export function gammaByStrike(legs, S) {
  const by = new Map();
  for (const l of legs ?? []) {
    if (l.kind !== "OPT" || !num(l.q) || num(l.greeks?.gamma) === null) continue;
    const e = by.get(l.strike) ?? { strike: l.strike, gamma: 0, ce: 0, pe: 0 };
    const g = l.q * l.greeks.gamma;
    e.gamma += g;
    e[l.right === "CE" ? "ce" : "pe"] += l.q;
    by.set(l.strike, e);
  }
  const s = num(S) ?? 0;
  return [...by.values()]
    .map((e) => ({ ...e, deltaPer1pct: e.gamma * s * 0.01, pnlPer1pct: 0.5 * e.gamma * (s * 0.01) ** 2 }))
    .sort((a, b) => a.strike - b.strike);
}

/**
 * Pin risk: each expiring short strike with its distance from spot (points and %), and whether spot is within `band`
 * (share of spot) of it, or of max pain or an OI wall within that band of the strike.
 */
export function pinRisk(legs, { spot, maxPain = null, walls = [], band = 0.005 } = {}) {
  const S = num(spot);
  if (!(S > 0)) return [];
  const near = (a, b) => num(a) !== null && num(b) !== null && Math.abs(a - b) <= band * S;
  const out = [];
  const seen = new Set();
  for (const l of legs ?? []) {
    if (l.kind !== "OPT" || !(num(l.q) < 0) || seen.has(`${l.strike}${l.right}`)) continue;
    seen.add(`${l.strike}${l.right}`);
    const dist = l.strike - S;
    out.push({
      strike: l.strike,
      right: l.right,
      q: l.q,
      dist,
      distPct: (dist / S) * 100,
      atSpot: near(l.strike, S),
      atMaxPain: near(l.strike, maxPain),
      atWall: (walls ?? []).some((w) => near(l.strike, w)),
    });
  }
  return out.sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist));
}

/**
 * Time value left in the expiring option legs: Σ q × (mark − intrinsic). For a seller it is what decays in their
 * favour by the close if spot stays; for a buyer what decays against them. { total (signed ₹, + = you are short time
 * value), short, long }.
 */
export function decayLeft(legs, S) {
  const s = num(S);
  let short = 0;
  let long = 0;
  for (const l of legs ?? []) {
    if (l.kind !== "OPT" || !num(l.q) || num(l.mark) === null || s === null) continue;
    const tv = Math.max(0, l.mark - intrinsic(l, s)) * Math.abs(l.q);
    if (l.q < 0) short += tv;
    else long += tv;
  }
  return { total: short - long, short, long };
}

/**
 * Settlement on the expiry: per expiring option leg, whether it is in the money at spot, and what that means:
 *  - stock options settle by physical delivery: ITM (or within `near` of the strike) legs become delivery of shares;
 *  - index options settle in cash: an ITM long left open is exercised and pays STT on the intrinsic value; an ITM
 *    short is assigned at the settlement price.
 * @returns {object[]} { symbol, strike, right, q, itm, near, kind: "physical"|"exercise"|"assigned", intrinsic }
 */
export function settlementRisk(legs, { spot, underlying, near = 0.01 } = {}) {
  const S = num(spot);
  if (!(S > 0)) return [];
  const index = INDEX_UNDERLYINGS.includes(String(underlying ?? "").toUpperCase());
  const out = [];
  for (const l of legs ?? []) {
    if (l.kind !== "OPT" || !num(l.q)) continue;
    const iv = intrinsic(l, S);
    const itm = iv > 0;
    const close = Math.abs(l.strike - S) <= near * S;
    if (!itm && !(close && !index)) continue;
    out.push({ symbol: l.symbol, strike: l.strike, right: l.right, q: l.q, itm, near: close, kind: !index ? "physical" : l.q > 0 ? "exercise" : "assigned", intrinsic: iv * Math.abs(l.q) });
  }
  return out;
}

/** "3 h 12 min", "12 min", "45 s", "closed". */
export function countdownText(ms) {
  if (!(ms > 0)) return "closed";
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  if (hh >= 24) return `${Math.floor(hh / 24)} d ${hh % 24} h`;
  if (hh) return `${hh} h ${mm} min`;
  if (mm) return `${mm} min`;
  return `${s} s`;
}
