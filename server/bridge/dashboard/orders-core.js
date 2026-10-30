// Orders and trade book: filters, counts and totals (pure: no DOM, no fetch, no clock).
import { contractName } from "./flows.js";

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
