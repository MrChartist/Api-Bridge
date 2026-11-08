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

/** How long the Orders page reuses Cancel all's dry run for its button (a redraw right after a render asks again). */
export const DRY_RUN_REUSE_MS = 3000;

/**
 * One answer reused while it is at most `ttlMs` old and no write happened since (`epoch`, app.js writeCount): a page
 * drawn twice in a row asks once. A load that answers with an error is not kept.
 * @returns {(load: () => Promise<any>, o?: { now?: number, epoch?: number }) => Promise<any>}
 */
export function shortMemo(ttlMs) {
  let held = null;
  return (load, { now = Date.now(), epoch = 0 } = {}) => {
    if (held && held.epoch === epoch && now - held.at >= 0 && now - held.at <= ttlMs) return held.value;
    const value = Promise.resolve(load());
    const mine = { at: now, epoch, value };
    held = mine;
    value.then(
      (r) => {
        if (r?.error && held === mine) held = null;
      },
      () => {
        if (held === mine) held = null;
      },
    );
    return value;
  };
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

/**
 * The line under "Placed through the Bridge" in the Cancel all question: what confirming would cancel, by mode. Said
 * before anything is sent, so not "cancelled." (which read as already done).
 */
export function cancelAllBridgeLine(g) {
  const parts = [g.paper ? `${formatInt(g.paper)} paper` : null, g.live ? `${formatInt(g.live)} live` : null].filter(Boolean).join(" and ");
  return parts ? `Cancelled when you confirm: ${parts}.` : "None open.";
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
