// Orders and trade book: filters, counts and totals (pure: no DOM, no fetch, no clock).
import { contractName } from "./flows.js";
import { formatInt } from "./format.js";

/** The status filter's choices, in order. */
export const ORDER_FILTERS = Object.freeze([
  ["all", "All"],
  ["open", "Open"],
  ["filled", "Filled"],
  ["rejected", "Rejected"],
  ["cancelled", "Cancelled"],
]);

/** Which filter bucket an order status falls in. */
export function orderBucket(status) {
  if (["pending", "open", "trigger_pending", "partially_filled"].includes(status)) return "open";
  if (status === "filled") return "filled";
  if (status === "rejected" || status === "outcome_unknown") return "rejected";
  return "cancelled"; // cancelled, expired
}

const norm = (s) => String(s ?? "").toLowerCase();

/** Whether a row matches the search text: the contract as shown, the symbol, the order id, the tag or the account. */
function matches(row, q, extra = []) {
  const t = norm(q).trim();
  if (!t) return true;
  const hay = [contractName(row.symbol), row.symbol, row.orderId, row.tradeId, row.tag, row.accountId, ...extra].map(norm).join(" ");
  return t.split(/\s+/).every((w) => hay.includes(w));
}

/**
 * Orders that pass the filters.
 * @param {object[]} list
 * @param {{ status?: string, side?: "all"|"BUY"|"SELL", q?: string, labelOf?: (id: string) => string }} f
 */
export function filterOrders(list, { status = "all", side = "all", q = "", labelOf = () => "" } = {}) {
  return (list ?? []).filter((o) => (status === "all" || orderBucket(o.status) === status) && (side === "all" || o.side === side) && matches(o, q, [labelOf(o.accountId)]));
}

/** How many orders fall in each bucket (and all). */
export function orderCounts(list) {
  const c = { all: 0, open: 0, filled: 0, rejected: 0, cancelled: 0 };
  for (const o of list ?? []) {
    c.all += 1;
    c[orderBucket(o.status)] += 1;
  }
  return c;
}

/** Working orders split by mode (for Cancel all's question). */
export function openByMode(list) {
  const open = (list ?? []).filter((o) => orderBucket(o.status) === "open");
  return { total: open.length, paper: open.filter((o) => o.mode !== "live").length, live: open.filter((o) => o.mode === "live").length };
}

/**
 * Cancel all's two groups, from POST /v1/orders/cancel-all { dryRun: true }: orders the Bridge placed (paper and live)
 * and live orders placed outside the Bridge (in the broker's app). total counts both; paper and live are the Bridge's.
 */
export function cancelAllGroups(dry) {
  const bridge = dry?.bridge?.open ?? [];
  const external = dry?.external?.open ?? [];
  return { bridge, external, total: bridge.length + external.length, paper: bridge.filter((o) => o.mode !== "live").length, live: bridge.filter((o) => o.mode === "live").length };
}

/**
 * Cancel all's button: the page's own open orders until the dry run answers, then the dry run's count of both groups
 * (so it also shows when only orders placed outside the Bridge are open).
 * @param {number} pageOpen  open orders in the page's list (the Bridge's own)
 * @param {ReturnType<typeof cancelAllGroups> | null} groups  the dry run's groups, or null before it answers
 */
export function cancelAllButton(pageOpen, groups) {
  const count = groups ? groups.total : pageOpen;
  return count > 0 ? { show: true, count, label: `Cancel all open (${formatInt(count)})` } : { show: false, count: 0, label: "" };
}

/** Cancel all's question: the Bridge's open orders, or (none of those) the ones placed outside it, to tick. */
export function cancelAllTitle(g) {
  const n = g.bridge.length;
  if (n) return `Cancel ${formatInt(n)} open order${n === 1 ? "" : "s"}?`;
  const m = g.external.length;
  return `${formatInt(m)} open order${m === 1 ? "" : "s"} placed outside the Bridge`;
}

/** The cancel-all body: Bridge orders only unless the trader ticked "Also cancel … placed outside the Bridge". */
export function cancelAllBody(includeExternal = false) {
  return { bridgeOnly: includeExternal !== true };
}

const ordersWord = (n) => `${formatInt(n)} order${n === 1 ? "" : "s"}`;

/** What Cancel all did, in each group, in one line: { text, tone }. */
export function cancelAllReport(d) {
  const ours = d?.bridge?.cancelled?.length ?? 0;
  const theirs = d?.external?.cancelled?.length ?? 0;
  const left = d?.external?.left?.length ?? 0;
  const failed = d?.failed ?? [];
  let text = `Cancelled ${formatInt(ours)} Bridge ${ours === 1 ? "order" : "orders"}`;
  text += theirs ? ` and ${ordersWord(theirs)} placed outside the Bridge.` : ".";
  if (left) text += ` ${ordersWord(left)} placed outside the Bridge left open.`;
  if (failed.length) text += ` ${formatInt(failed.length)} not cancelled: ${failed[0]?.message ?? "refused"}`;
  return { text, tone: failed.length ? "warn" : "ok" };
}

/** Trades that pass the filters. */
export function filterTrades(list, { side = "all", q = "", labelOf = () => "" } = {}) {
  return (list ?? []).filter((t) => (side === "all" || t.side === side) && matches(t, q, [labelOf(t.accountId)]));
}

/** Totals of a set of trades: count, quantities, buy and sell value, turnover (their sum) and charges. */
export function tradeTotals(list) {
  const t = { count: 0, buyQty: 0, sellQty: 0, buyValue: 0, sellValue: 0, turnover: 0, charges: 0 };
  for (const x of list ?? []) {
    const qty = Number(x.qty ?? x.quantity) || 0;
    const value = qty * (Number(x.price) || 0);
    t.count += 1;
    if (x.side === "BUY") {
      t.buyQty += qty;
      t.buyValue += value;
    } else {
      t.sellQty += qty;
      t.sellValue += value;
    }
    t.turnover += value;
    t.charges += Number(x.charges) || 0;
  }
  return t;
}

/**
 * The Day view of positions (as brokers show it): what was bought and sold today, what was carried in, and today's
 * P&L, measured from the previous close for carried units: sell value − buy value + net × LTP − carried × previous
 * close. A row the source did not give day figures for (a broker that reports none) has dayPnl null.
 * @param {object[]} positions GET /v1/positions rows
 * @returns {{ rows: object[], total: number|null, missing: number }}
 */
export function dayRows(positions) {
  const rows = [];
  let total = 0;
  let missing = 0;
  for (const p of positions ?? []) {
    const buy = Number(p.buyQty) || 0;
    const sell = Number(p.sellQty) || 0;
    const carried = Number(p.overnightQty) || 0;
    if (!buy && !sell && !carried && !Number(p.netQty)) continue;
    let dayPnl = p.dayPnl;
    if (dayPnl === undefined || dayPnl === null) {
      const ltp = Number(p.ltp);
      const known = p.overnightQty !== undefined && (Number(p.netQty) === 0 || Number.isFinite(ltp)) && (!carried || Number.isFinite(Number(p.prevClose)));
      dayPnl = known ? sell * (Number(p.sellAvg) || 0) - buy * (Number(p.buyAvg) || 0) + (Number(p.netQty) || 0) * (Number.isFinite(ltp) ? ltp : 0) - carried * (Number(p.prevClose) || 0) : null;
    }
    if (dayPnl === null) missing += 1;
    else total += Number(dayPnl);
    rows.push({ ...p, buy, sell, carried, dayPnl: dayPnl === null ? null : Number(dayPnl) });
  }
  rows.sort((a, b) => Math.abs(b.dayPnl ?? 0) - Math.abs(a.dayPnl ?? 0));
  return { rows, total: rows.length && missing < rows.length ? total : null, missing };
}

/**
 * Market depth as the ticket draws it: rows pairing the n-th bid with the n-th ask, the total quantity each side
 * shows, the largest level (for the bars) and the bid share of the shown quantity. Levels arrive best first.
 * @param {{ bids?: Array<{ price: number, qty: number, orders?: number|null }>, asks?: Array<{ price: number, qty: number, orders?: number|null }> } | null} depth
 * @param {number} [max] the most levels to show a side (5 by default; 20 where the source gives that many)
 */
export function depthView(depth, max = 5) {
  const bids = (depth?.bids ?? []).filter((l) => Number(l?.qty) > 0).slice(0, max);
  const asks = (depth?.asks ?? []).filter((l) => Number(l?.qty) > 0).slice(0, max);
  const n = Math.max(bids.length, asks.length);
  const rows = Array.from({ length: n }, (_, i) => ({ bid: bids[i] ?? null, ask: asks[i] ?? null }));
  const totalBid = bids.reduce((s, l) => s + Number(l.qty), 0);
  const totalAsk = asks.reduce((s, l) => s + Number(l.qty), 0);
  const maxQty = Math.max(0, ...bids.map((l) => Number(l.qty)), ...asks.map((l) => Number(l.qty)));
  const available = Math.max(depth?.bids?.length ?? 0, depth?.asks?.length ?? 0);
  return { rows, totalBid, totalAsk, maxQty, bidShare: totalBid + totalAsk > 0 ? totalBid / (totalBid + totalAsk) : null, available };
}

/**
 * One account's funds for the Funds card: what is free to trade, what margin is blocked, collateral (pledged holdings,
 * when the source reports it) and how much of the total is used. Missing figures stay null.
 * @param {{ availableCash?: number|null, usedMargin?: number|null, collateral?: number|null, totalBalance?: number|null } | null} f
 */
export function fundsView(f) {
  const n = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const available = n(f?.availableCash);
  const used = n(f?.usedMargin);
  const collateral = n(f?.collateral);
  const total = available !== null && used !== null ? available + used : n(f?.totalBalance);
  const util = used !== null && total !== null && total > 0 ? Math.min(1, Math.max(0, used / total)) : null;
  return { available, used, collateral, total, util, level: util === null ? "none" : util >= 0.9 ? "neg" : util >= 0.7 ? "warn" : "ok" };
}
