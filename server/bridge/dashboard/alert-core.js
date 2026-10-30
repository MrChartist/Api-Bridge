/**
 * Position alerts: the pure part (shared by server/bridge/alerts and the dashboard). No DOM, no fetch, no clock:
 * `nowMs` comes in as an argument. Numbers stay numbers; text is made by the caller (format.js on the dashboard).
 *
 * A rule watches one account's legs on one underlying (or a chosen set of symbols) and fires when its conditions
 * become true (all of them, or any). It fires on the edge: once true it stays quiet until the conditions are false
 * again, and never more often than its cool-down. "once" rules switch themselves off after firing. Alerts only
 * notify: nothing here places, changes or cancels an order.
 *
 * Condition kinds (value in rupees, points, units of the underlying, minutes or a multiple):
 *   pnl_above / pnl_below      P&L of the legs (realised + unrealised) at or above / at or below `value`
 *   spot_above / spot_below    the underlying at or above / at or below `value`
 *   delta_outside              net delta (units of the underlying) below `value` or above `value2`
 *   expiry_within              the nearest leg expires within `value` minutes
 *   premium_multiple           a leg's price is at least `value` × its average price (2 = it doubled)
 */
import { b76Delta, impliedVolB76 } from "./pricing.js";

export const ALERT_KINDS = Object.freeze(["pnl_above", "pnl_below", "spot_above", "spot_below", "delta_outside", "expiry_within", "premium_multiple"]);
export const MAX_CONDITIONS = 5;
export const DEFAULT_COOLDOWN_MIN = 15;

const YEAR_MS = 365 * 86_400_000;
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const OPT_RE = /^([A-Z]{3}):([A-Z0-9][A-Z0-9&_-]*?)-(\d{4}-\d{2}-\d{2})-(?:(FUT)|(\d+(?:\.\d+)?)-(CE|PE))$/;
const CASH_RE = /^([A-Z]{3}):([A-Z0-9][A-Z0-9&_-]*)$/;

/** Parts of a canonical symbol: { exchange, underlying, expiry, kind, strike, right } (expiry null for cash). */
export function symbolParts(symbol) {
  const s = String(symbol ?? "");
  const m = OPT_RE.exec(s);
  if (m) return { exchange: m[1], underlying: m[2], expiry: m[3], kind: m[4] ? "FUT" : "OPT", strike: m[5] ? Number(m[5]) : null, right: m[6] ?? null };
  const c = CASH_RE.exec(s);
  return c ? { exchange: c[1], underlying: c[2], expiry: null, kind: "EQ", strike: null, right: null } : null;
}

/** The spot symbol an underlying is quoted on (BSE indices on BSE, the rest on NSE). */
export const spotSymbolOf = (underlying) => `${["SENSEX", "BANKEX", "SENSEX50"].includes(underlying) ? "BSE" : "NSE"}:${underlying}`;

/** Milliseconds to 15:30 IST on an expiry day. */
export const expiryCloseMs = (expiry) => Date.parse(`${expiry}T15:30:00+05:30`);

/**
 * A rule's problems, or [] when it is well formed. Used by the server before saving and by the form before sending.
 * @param {object} r
 */
export function ruleProblems(r) {
  const out = [];
  if (!r || typeof r !== "object") return ["The alert is empty."];
  if (typeof r.account !== "string" || !r.account) out.push("Choose an account.");
  if (typeof r.underlying !== "string" || !/^[A-Z0-9][A-Z0-9&_-]{0,29}$/.test(r.underlying)) out.push("Choose an underlying.");
  if (r.symbols !== null && r.symbols !== undefined && (!Array.isArray(r.symbols) || r.symbols.length > 24 || r.symbols.some((s) => symbolParts(s)?.underlying !== r.underlying))) out.push("The chosen legs must be contracts on the underlying.");
  const cs = Array.isArray(r.conditions) ? r.conditions : [];
  if (!cs.length) out.push("Add at least one condition.");
  if (cs.length > MAX_CONDITIONS) out.push(`At most ${MAX_CONDITIONS} conditions.`);
  cs.forEach((c, i) => {
    const at = `Condition ${i + 1}`;
    if (!ALERT_KINDS.includes(c?.kind)) return out.push(`${at}: unknown kind.`);
    const v = num(c.value);
    if (v === null) return out.push(`${at}: give a number.`);
    if (c.kind === "delta_outside") {
      const v2 = num(c.value2);
      if (v2 === null || v2 <= v) out.push(`${at}: the upper delta must be above the lower one.`);
    }
    if ((c.kind === "spot_above" || c.kind === "spot_below") && v <= 0) out.push(`${at}: the level must be above zero.`);
    if (c.kind === "expiry_within" && (v <= 0 || v > 60 * 24 * 60)) out.push(`${at}: minutes from 1 to 86400.`);
    if (c.kind === "premium_multiple" && !(v > 1 && v <= 50)) out.push(`${at}: a multiple above 1 (2 = the premium doubled).`);
  });
  if (r.match !== undefined && r.match !== "all" && r.match !== "any") out.push("Match must be all or any.");
  if (r.repeat !== undefined && r.repeat !== "once" && r.repeat !== "every") out.push("Repeat must be once or every.");
  const cd = num(r.cooldownMin);
  if (r.cooldownMin !== undefined && (cd === null || cd < 1 || cd > 1440)) out.push("Cool-down from 1 to 1440 minutes.");
  return out;
}

/**
 * What the rule's legs show now.
 * @param {Array<{ symbol: string, netQty: number, avgPrice?: number, ltp?: number|null, pnl?: number|null }>} positions
 * @param {{ underlying: string, symbols?: string[]|null, spot?: number|null, nowMs: number }} o
 * @returns {{ legs: number, pnl: number|null, spot: number|null, delta: number|null, minutesToExpiry: number|null,
 *   premiumMultiple: number|null, premiumLeg: string|null, nearestExpiry: string|null }}
 */
export function groupMetrics(positions, { underlying, symbols = null, spot = null, nowMs }) {
  const want = Array.isArray(symbols) && symbols.length ? new Set(symbols) : null;
  const legs = (positions ?? []).filter((p) => {
    if (!p || !num(p.netQty)) return false;
    if (want) return want.has(p.symbol);
    return symbolParts(p.symbol)?.underlying === underlying;
  });
  const S = num(spot);
  let pnl = 0;
  let pnlKnown = legs.length > 0;
  let delta = S ? 0 : null;
  let minutes = null;
  let nearest = null;
  let mult = null;
  let multLeg = null;
  for (const p of legs) {
    const q = Number(p.netQty);
    const x = symbolParts(p.symbol);
    if (num(p.pnl) === null) pnlKnown = false;
    else pnl += Number(p.pnl);
    if (x?.expiry) {
      const m = (expiryCloseMs(x.expiry) - nowMs) / 60_000;
      if (minutes === null || m < minutes) {
        minutes = m;
        nearest = x.expiry;
      }
    }
    const ltp = num(p.ltp);
    const avg = num(p.avgPrice);
    if (x?.kind === "OPT" && ltp !== null && avg !== null && avg > 0) {
      const r = ltp / avg;
      if (mult === null || r > mult) {
        mult = r;
        multLeg = p.symbol;
      }
    }
    if (delta !== null) {
      if (x?.kind === "FUT" || x?.kind === "EQ") delta += q;
      else if (x?.kind === "OPT") {
        const T = Math.max(0, (expiryCloseMs(x.expiry) - nowMs) / YEAR_MS);
        const iv = ltp !== null && T > 0 ? impliedVolB76(ltp, S, x.strike, T, x.right) : null;
        let d = iv !== null ? b76Delta(S, x.strike, T, iv, x.right) : null;
        if (d === null) {
          // Expired, or an IV that cannot be solved (a stale or odd price): delta by moneyness keeps the total usable.
          const itm = x.right === "CE" ? S > x.strike : S < x.strike;
          d = (x.right === "CE" ? 1 : -1) * (T > 0 ? (itm ? 0.75 : 0.25) : itm ? 1 : 0);
        }
        delta += q * d;
      }
    }
  }
  return { legs: legs.length, pnl: pnlKnown ? pnl : null, spot: S, delta, minutesToExpiry: minutes, premiumMultiple: mult, premiumLeg: multLeg, nearestExpiry: nearest };
}

/**
 * Open F&O positions grouped by account and underlying, each with groupMetrics plus its short-leg count, the biggest
 * |P&L| first (Home's open positions). `spots`: underlying -> price.
 * @param {Array<{ accountId?: string, symbol: string, netQty: number, avgPrice?: number, ltp?: number, pnl?: number }>} positions
 */
export function bookGroups(positions, { spots = {}, nowMs }) {
  const by = new Map();
  for (const p of positions ?? []) {
    if (!p || !num(p.netQty)) continue;
    const x = symbolParts(p.symbol);
    if (!x || x.kind === "EQ") continue;
    const key = `${p.accountId ?? ""}|${x.underlying}`;
    if (!by.has(key)) by.set(key, { account: p.accountId ?? null, underlying: x.underlying, items: [] });
    by.get(key).items.push(p);
  }
  return [...by.values()]
    .map((g) => ({ account: g.account, underlying: g.underlying, shorts: g.items.filter((p) => Number(p.netQty) < 0).length, ...groupMetrics(g.items, { underlying: g.underlying, spot: num(spots[g.underlying]), nowMs }) }))
    .sort((a, b) => Math.abs(b.pnl ?? 0) - Math.abs(a.pnl ?? 0));
}

/** One condition against the metrics: { met: true|false|null (no data), value }. */
export function evalCondition(c, m) {
  const v = num(c?.value);
  const pick = { pnl_above: m.pnl, pnl_below: m.pnl, spot_above: m.spot, spot_below: m.spot, delta_outside: m.delta, expiry_within: m.minutesToExpiry, premium_multiple: m.premiumMultiple }[c?.kind];
  const x = num(pick);
  if (x === null || v === null || !m.legs) return { met: null, value: x };
  switch (c.kind) {
    case "pnl_above":
    case "spot_above":
    case "premium_multiple":
      return { met: x >= v, value: x };
    case "pnl_below":
    case "spot_below":
      return { met: x <= v, value: x };
    case "delta_outside":
      return { met: x < v || x > num(c.value2), value: x };
    case "expiry_within":
      return { met: x <= v && x > 0, value: x };
    default:
      return { met: null, value: x };
  }
}

/**
 * One evaluation step. Returns the next state and whether to fire.
 * state: { armed: boolean, lastFireMs: number|null, blind: boolean }. A rule starts armed; it disarms when it fires
 * and re-arms only once its conditions are false again (so a P&L sitting below the level fires once, not every tick).
 * @returns {{ fire: boolean, state: object, results: Array<{ met: boolean|null, value: number|null }>, met: boolean|null }}
 */
export function step(rule, m, state, nowMs) {
  const s = { armed: state?.armed !== false, lastFireMs: num(state?.lastFireMs), blind: false };
  const results = (rule.conditions ?? []).map((c) => evalCondition(c, m));
  const known = results.filter((r) => r.met !== null);
  if (!known.length || (rule.match !== "any" && known.length < results.length)) return { fire: false, state: { ...s, blind: true }, results, met: null };
  const met = rule.match === "any" ? known.some((r) => r.met) : known.every((r) => r.met);
  if (!met) return { fire: false, state: { ...s, armed: true }, results, met };
  const cool = (num(rule.cooldownMin) ?? DEFAULT_COOLDOWN_MIN) * 60_000;
  const ready = s.armed && (s.lastFireMs === null || nowMs - s.lastFireMs >= cool);
  if (!ready) return { fire: false, state: s, results, met };
  return { fire: true, state: { ...s, armed: false, lastFireMs: nowMs }, results, met };
}
