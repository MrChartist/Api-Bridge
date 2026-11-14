// Orders and trade book: filters, counts and totals (pure: no DOM, no fetch, no clock).
import { contractName } from "./flows.js";
import { formatInt, plural } from "./format.js";

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
  if (n) return `Cancel ${plural(n, "open order")}?`;
  const m = g.external.length;
  return `${plural(m, "open order")} placed outside the Bridge`;
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

const ordersWord = (n) => plural(n, "order");

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

// ── Orders page: how a row reads (pure) ──

/** A status in plain words with the tone its pill wears: working orders are accent, a fill is green, a refusal is red. */
export function orderStatusLook(status) {
  const map = {
    filled: { text: "Filled", tone: "ok" },
    rejected: { text: "Rejected", tone: "bad" },
    cancelled: { text: "Cancelled", tone: "" },
    expired: { text: "Expired", tone: "" },
    open: { text: "Open", tone: "info" },
    pending: { text: "Sending", tone: "info" },
    trigger_pending: { text: "Waiting for trigger", tone: "info" },
    partially_filled: { text: "Part filled", tone: "info" },
    outcome_unknown: { text: "Outcome unknown", tone: "bad" },
  };
  return map[status] ?? { text: status ? `${String(status)[0].toUpperCase()}${String(status).slice(1)}` : "Unknown", tone: "warn" };
}

/** How long ago a time was, short: "just now", "42 s ago", "5 min ago", "3 h ago"; null for older than a day or a bad time. */
export function ago(iso, nowMs = Date.now()) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return null;
  const s = Math.round((nowMs - t) / 1000);
  if (s < -5) return null;
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return null;
}

/** "m:ss" for a number of milliseconds (never negative). */
export function clockText(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * A pending ticket's life: time left, share left (for the bar), and whether it is over. `level` is "ok" with more than
 * 20 s left, "warn" up to that, "bad" when over.
 * @param {{ createdAt?: string, expiresAt?: string }} t
 */
export function ticketLife(t, nowMs = Date.now()) {
  const end = Date.parse(t?.expiresAt ?? "");
  const start = Date.parse(t?.createdAt ?? "");
  if (!Number.isFinite(end)) return { known: false, left: 0, share: 0, over: false, text: "", level: "ok" };
  const left = end - nowMs;
  const span = Number.isFinite(start) && end > start ? end - start : 60_000;
  return { known: true, left: Math.max(0, left), share: Math.min(1, Math.max(0, left / span)), over: left <= 0, text: left <= 0 ? "Expired" : `${clockText(left)} left`, level: left <= 0 ? "bad" : left <= 20_000 ? "warn" : "ok" };
}

/**
 * The body that places a cancelled paper order's unfilled part again ("Undo" after Cancel): the same order, `left` units, in paper.
 * It goes through every normal check on the server. Pure.
 */
export function placeAgainBody(o, left) {
  return { account: o.accountId, symbol: o.symbol, side: o.side, quantity: left, product: o.product, orderType: o.orderType, validity: o.validity ?? "DAY", mode: "paper", ...(o.price ? { price: o.price } : {}), ...(o.triggerPrice ? { triggerPrice: o.triggerPrice } : {}), ...(o.tag ? { tag: o.tag } : {}) };
}

/**
 * One Idempotency-Key per order a person means to place. The same body always gets the same key (a double click, a retry after
 * a network failure, Undo pressed twice), so the Bridge can answer the repeat with the first order instead of placing a second;
 * a different body gets a new key (the Bridge refuses one key with two different bodies). Pure apart from crypto.randomUUID.
 * @param {() => string} [uuid]
 */
export function createOrderKeys(uuid = () => globalThis.crypto.randomUUID()) {
  let lastBody = null;
  let lastKey = null;
  return {
    keyFor(body) {
      const text = JSON.stringify(body);
      if (text !== lastBody) {
        lastBody = text;
        lastKey = `dash-${uuid()}`;
      }
      return lastKey;
    },
  };
}

/** The longest reason a person can give when declining (the API's limit). */
export const DECLINE_REASON_MAX = 200;

/** What the decline box holds, as the API wants it: trimmed text, or null when empty. */
export function declineBody(text) {
  const reason = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, DECLINE_REASON_MAX);
  return reason ? { reason } : {};
}

/**
 * What a decline attempt came to, in words a person reads in a toast. `err` is the ApiError (or null when it worked).
 * "done": it is declined (also when it already was); "gone": it expired or is unknown, so there is nothing to decline;
 * "confirmed": someone confirmed or used it first, so it can no longer be declined; "failed": it did not go through,
 * show the card again. Clients read the 409 `state`, never the sentence.
 * @returns {{ kind: "done"|"gone"|"confirmed"|"failed", message: string }}
 */
export function declineOutcome(err, assistantNamed = "the client that prepared it") {
  if (!err) return { kind: "done", message: `Declined. Nothing was sent, and ${assistantNamed} is told you said no.` };
  const state = err.body?.state;
  if (err.status === 409 && state === "rejected") return { kind: "done", message: "Already declined. Nothing was sent." };
  if (err.status === 409 && state === "confirmed") return { kind: "confirmed", message: "This was confirmed a moment ago, so it can no longer be declined. The client that prepared it may now send it." };
  if (err.status === 409 && state === "consumed") return { kind: "confirmed", message: "This was already confirmed and sent, so it can no longer be declined. Find it in Today's orders." };
  if ((err.status === 409 && state === "expired") || err.status === 404) return { kind: "gone", message: "This request had already expired, so there is nothing to decline. Nothing was sent." };
  if (err.network) return { kind: "failed", message: "Could not reach the Bridge, so it was not declined. It is back in the list; try again." };
  return { kind: "failed", message: `Could not decline: ${String(err.message ?? "the Bridge refused").replace(/[.\s]+$/, "")}. It is back in the list.` };
}

/** Who prepared a ticket, in words: "AI assistant", "Webhook" or "REST client", with the key or hook label. */
export function ticketSource(t) {
  const kind = { mcp: "AI assistant", webhook: "Webhook", rest: "REST client" }[t?.source] ?? "Client";
  return { kind, label: t?.client ? String(t.client) : "" };
}

/** The order's size as a person says it: "10", "4 of 10" while part filled. */
export function qtyText(o) {
  const q = Number(o?.quantity);
  const f = Number(o?.filledQuantity);
  if (Number.isFinite(f) && f > 0 && Number.isFinite(q) && f !== q) return `${formatInt(f)} of ${formatInt(q)}`;
  return formatInt(q);
}

/** The order type in words: "Market", "Limit", "Stop-loss", "Stop-loss market". */
export function orderTypeText(type) {
  return { MARKET: "Market", LIMIT: "Limit", SL: "Stop-loss", "SL-M": "Stop-loss market" }[type] ?? (type ? String(type) : "");
}

/** The product in words, as the API names it in brackets where that helps: "Delivery (CNC)", "Intraday", "Carry (NRML)". */
export function productText(p) {
  return { CNC: "Delivery (CNC)", INTRADAY: "Intraday", MARGIN: "Carry (NRML)", MTF: "MTF" }[p] ?? (p ? String(p) : "");
}

/** A day "2026-11-08" as "Today, Sun 8 Nov", "Yesterday, Sat 7 Nov" or "Fri 6 Nov", against today's day (IST). */
export function dayHeading(day, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return String(day ?? "");
  const d = new Date(`${day}T00:00:00Z`);
  const t = new Date(`${today}T00:00:00Z`);
  const diff = Math.round((t - d) / 86_400_000);
  const w = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const long = `${w} ${d.getUTCDate()} ${m}`;
  return diff === 0 ? `Today, ${long}` : diff === 1 ? `Yesterday, ${long}` : long;
}

/**
 * Trades grouped by IST day in the order given (newest first gives the newest day first).
 * @param {object[]} trades
 * @param {(iso: string) => string} dayOf
 * @returns {Array<{ day: string, rows: object[] }>}
 */
export function groupByDay(trades, dayOf) {
  const out = [];
  for (const t of trades ?? []) {
    const day = dayOf(t.tradedAt);
    const last = out[out.length - 1];
    if (last && last.day === day) last.rows.push(t);
    else out.push({ day, rows: [t] });
  }
  return out;
}

const csvCell = (v) => {
  let s = v === null || v === undefined ? "" : String(v);
  // Spreadsheet formula guard (same rule as the server's CSV exports): text starting with = + - @ tab or CR gets a leading apostrophe.
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * The trade book as CSV (RFC 4180, CRLF): one row per fill, plain numbers (no grouping), the charges estimate empty
 * where none is priced.
 * @param {object[]} trades
 * @param {{ labelOf?: (id: string) => string, chargesOf?: (t: object) => { total: number } | null, timeOf?: (iso: string) => string }} o
 */
export function tradesCsv(trades, { labelOf = (id) => id, chargesOf = () => null, timeOf = (x) => x } = {}) {
  const head = ["Time (IST)", "Account", "Symbol", "Contract", "Side", "Quantity", "Price", "Value", "Product", "Order id", "Trade id", "Estimated charges"];
  const rows = (trades ?? []).map((t) => {
    const qty = Number(t.qty ?? t.quantity);
    const price = Number(t.price);
    const c = chargesOf(t);
    return [timeOf(t.tradedAt), labelOf(t.accountId), t.symbol, contractName(t.symbol), t.side, Number.isFinite(qty) ? qty : "", Number.isFinite(price) ? price : "", Number.isFinite(qty * price) ? Math.round(qty * price * 100) / 100 : "", t.product ?? "", t.orderId ?? "", t.tradeId ?? "", c ? Math.round(c.total * 100) / 100 : ""];
  });
  return `${[head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
