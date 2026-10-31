// Positions suite (#/positions): the pure read-outs behind the account overview, the "Needs attention" strip and each
// group's risk line. No DOM, no fetches: positions.js calls these on every tick and patches the page from the result.
// Numbers become text through format.js only; missing figures stay null (the page prints DASH), never an invented 0.
import { DASH, formatCompact, formatDayMonth, formatFixed, formatInt, isFigure } from "./format.js";
import * as O from "./options.js";

const num = (v) => (isFigure(v) ? Number(v) : null);

/** Signed compact rupees with a true minus: "+₹9.7K", "−₹1.42L", "₹0". */
export function moneyShort(v) {
  if (!isFigure(v)) return DASH;
  const x = Number(v);
  const sign = x > 0.5 ? "+" : x < -0.5 ? "−" : "";
  return `${sign}₹${formatCompact(Math.abs(x))}`;
}

/** A leg's short name: "24500 PE" or "FUT". */
export const legShort = (l) => (l?.kind === "FUT" ? "FUT" : `${formatInt(l?.strike)} ${l?.right ?? ""}`.trim());

/**
 * The margin read-out of a funds object (broker or paper engine): used, the total it is a share of, the share and a
 * level for its colour (≥ 90 % neg, ≥ 70 % warn, else ok; the colour follows the rounded number the user reads).
 * Without both figures every field is null and the level "none".
 */
export function marginUse(funds) {
  const used = num(funds?.usedMargin);
  const avail = num(funds?.availableCash);
  const total = used !== null && avail !== null && used + avail > 0 ? used + avail : num(funds?.totalBalance);
  if (used === null || !(total > 0)) return { used: null, total: null, free: null, util: null, level: "none" };
  const util = used / total;
  const shown = Math.round(util * 100);
  return { used, total, free: avail ?? total - used, util, level: shown >= 90 ? "neg" : shown >= 70 ? "warn" : "ok" };
}

/**
 * The account overview (the hero over the page): total P&L over every position the account holds today (open and
 * closed, every underlying), today's P&L, open legs, margin used, and the underlyings with open legs, each with its
 * P&L and leg count. A position's P&L is the broker's `pnl`, else realised + unrealised; a position with neither is
 * counted in `missing` and left out (total is null when no position has a figure).
 * @param {object[]} positions GET /v1/positions rows
 * @param {{ funds?: object|null, dayTotal?: number|null, current?: string|null }} [o]
 */
export function accountOverview(positions, { funds = null, dayTotal = null, current = null } = {}) {
  let total = null;
  let missing = 0;
  let open = 0;
  for (const p of positions ?? []) {
    if (num(p?.netQty)) open += 1;
    const r = num(p?.realisedPnl);
    const u = num(p?.unrealisedPnl);
    const v = num(p?.pnl) ?? (r !== null || u !== null ? (r ?? 0) + (u ?? 0) : null);
    if (v === null) {
      missing += 1;
      continue;
    }
    total = (total ?? 0) + v;
  }
  const unds = O.bookUnderlyings(positions ?? []);
  // The underlying on screen stays in the rail even with only today's closed legs left on it.
  if (current && !unds.some((u) => u.underlying === current)) unds.push({ underlying: current, legs: 0, pnl: null });
  unds.sort((a, b) => (a.underlying < b.underlying ? -1 : 1));
  return { total, day: num(dayTotal), open, missing, margin: marginUse(funds), underlyings: unds };
}

const IST_MS = 330 * 60000;
const LEVEL = { bad: 0, warn: 1, info: 2 };

/**
 * What needs a look now, most urgent first: short options in the money (bad), short options within 0.5σ of the
 * forward (warn), held expiries within `nearDays` calendar days (IST) and not yet closed (bad on the day itself), and the biggest
 * loser among two or more open legs. Each item names the legs it is about (`symbols`) so the page can light them.
 * Legs are options.js priced legs ({ symbol, kind, right, strike, expiry, q, F, iv, T, priced, ... }).
 * @returns {{ items: { id: string, kind: "itm"|"tested"|"expiry"|"loser", level: "bad"|"warn", label: string, text: string, symbols: string[], value?: number }[], more: number }}
 */
export function attentionItems(legs, { now = Date.now(), close = undefined, nearDays = 3, limit = 4 } = {}) {
  const open = (legs ?? []).filter((l) => num(l?.q));
  const out = [];
  for (const l of open) {
    if (l.kind !== "OPT" || l.q >= 0 || !l.priced) continue;
    const d = O.legDistance(l);
    if (!d?.tested) continue;
    const when = formatDayMonth(l.expiry);
    if (d.itm) out.push({ id: `itm:${l.symbol}`, kind: "itm", level: "bad", label: "Short in the money", text: `${legShort(l)} ${when}`, symbols: [l.symbol] });
    else out.push({ id: `tested:${l.symbol}`, kind: "tested", level: "warn", label: "Short tested", text: `${legShort(l)} · ${formatFixed(Math.floor((d.sigma ?? 0) * 10 + 1e-9) / 10, 1)}σ away`, symbols: [l.symbol] });
  }
  const byExp = new Map();
  for (const l of open) {
    const t = O.timeToExpiry(l.expiry, now, close);
    // Calendar days in IST (3 Nov is "3 days" from any hour of 31 Oct), not hours to the close.
    const cal = /^\d{4}-\d{2}-\d{2}$/.test(l.expiry ?? "") ? Math.round((Date.parse(`${l.expiry}T00:00:00Z`) - Math.floor((now + IST_MS) / 86400000) * 86400000) / 86400000) : null;
    if (t.days === null || t.days <= 0 || cal === null || cal > nearDays) continue;
    if (!byExp.has(l.expiry)) byExp.set(l.expiry, { t, syms: [] });
    byExp.get(l.expiry).syms.push(l.symbol);
  }
  for (const [e, { t, syms }] of [...byExp.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const today = t.label === "Expires today";
    out.push({ id: `expiry:${e}`, kind: "expiry", level: today ? "bad" : "warn", label: today ? "Expires today" : "Near expiry", text: `${formatDayMonth(e)} · ${today ? `${formatInt(syms.length)} leg${syms.length === 1 ? "" : "s"}` : `${t.label} left`}`, symbols: syms });
  }
  if (open.length >= 2) {
    let worst = null;
    let wv = 0;
    for (const l of open) {
      const v = O.legUnrealised(l);
      if (v < wv - 0.5) {
        worst = l;
        wv = v;
      }
    }
    if (worst) out.push({ id: `loser:${worst.symbol}`, kind: "loser", level: "warn", label: "Biggest loser", text: `${legShort(worst)} ${moneyShort(wv)}`, name: legShort(worst), symbols: [worst.symbol], value: wv });
  }
  out.sort((a, b) => LEVEL[a.level] - LEVEL[b.level]);
  const n = Math.max(0, limit);
  return { items: out.slice(0, n), more: Math.max(0, out.length - n) };
}

/**
 * A group's risk at expiry from a sampled curve (options.js bookCurveStats): the maximum loss and profit (null when
 * that side keeps growing past the sampled range: "Unlimited"), and the breakevens rounded to whole points.
 * A curve that never goes below zero has no loss (maxLoss 0); one that never goes above zero has no profit.
 */
export function riskRead(stats) {
  if (!stats) return null;
  const maxLoss = stats.unlimitedDown ? null : Math.min(0, stats.min);
  const maxProfit = stats.unlimitedUp ? null : Math.max(0, stats.max);
  const breakevens = [];
  for (const r of (stats.roots ?? []).filter((x) => isFigure(x) && x > 0).map((x) => Math.round(x)).sort((a, b) => a - b)) if (breakevens[breakevens.length - 1] !== r) breakevens.push(r);
  return { maxLoss, maxProfit, breakevens, lossUnlimited: Boolean(stats.unlimitedDown), profitUnlimited: Boolean(stats.unlimitedUp) };
}

/** The risk line's parts: ["Max loss −₹12K", "Max profit +₹7.2K", "BE 24320 · 25610"] ("Unlimited" for an open side). */
export function riskParts(read) {
  if (!read) return [];
  const parts = [`Max loss ${read.lossUnlimited ? "Unlimited" : moneyShort(read.maxLoss)}`, `Max profit ${read.profitUnlimited ? "Unlimited" : moneyShort(read.maxProfit)}`];
  if (read.breakevens.length) parts.push(`BE ${read.breakevens.slice(0, 3).map((b) => formatInt(b)).join(" · ")}${read.breakevens.length > 3 ? " …" : ""}`);
  return parts;
}

/**
 * Sample points for a group's expiry curve: F·e^(±k·σ√T) (σ√T as a fraction, `sig`), widened to 8 % past the outer
 * strikes so a far wing is always inside, `n` steps, plus the strikes. Wide enough (k = 4) that a short option's loss
 * still slopes at the edge, so "Unlimited" is read from the slope, while a hedged wing reads flat.
 */
export function riskGrid(F, sig, strikes = [], { k = 4, n = 160 } = {}) {
  if (!(F > 0)) return [];
  const w = k * (sig > 0 ? sig : 0.02);
  const ks = (strikes ?? []).filter((x) => x > 0);
  const lo = Math.min(F * Math.exp(-w), ...ks.map((x) => x * 0.92));
  const hi = Math.max(F * Math.exp(w), ...ks.map((x) => x * 1.08));
  const xs = [];
  for (let i = 0; i <= n; i += 1) xs.push(lo * Math.exp((Math.log(hi / lo) * i) / n));
  for (const x of ks) if (x > lo && x < hi) xs.push(x);
  return [...new Set(xs)].sort((a, b) => a - b);
}
