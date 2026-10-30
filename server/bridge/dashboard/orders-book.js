// Orders › Orders: the day's order book with filters (status, side, search) and Cancel all; Orders › Trades: every fill
// with totals. Filters are a per-viewer convenience (localStorage); the books come from GET /v1/orders and /v1/trades.
import { alertBox, api, card, emptyState, h, istDateTime, istTime, modal, optional, table, toast } from "./app.js";
import { contractName } from "./flows.js";
import { formatFixed, formatInt, formatRupee } from "./format.js";
import { ORDER_FILTERS, filterOrders, filterTrades, openByMode, orderCounts, tradeTotals } from "./orders-core.js";

const KEY = "mcb.orders.filters";
function loadFilters() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { status: typeof v.status === "string" ? v.status : "all", side: ["all", "BUY", "SELL"].includes(v.side) ? v.side : "all", q: "" };
  } catch {
    return { status: "all", side: "all", q: "" };
  }
}
function saveFilters(f) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ status: f.status, side: f.side }));
  } catch {
    /* private window: the filter lasts this visit only */
  }
}

/** A small pressed-button group (a filter), with counts. */
function chips(label, options, value, onPick) {
  const el = h("div", { class: "bk-chips", role: "group", "aria-label": label });
  const draw = (current, counts = null) =>
    el.replaceChildren(
      ...options.map(([v, text]) => {
        const n = counts?.[v];
        return h("button", { type: "button", class: "chip-btn bk-chip", "aria-pressed": String(v === current), onclick: () => onPick(v) }, text, n !== undefined ? h("span", { class: "bk-chip-n" }, formatInt(n)) : null);
      }),
    );
  draw(value);
  return { el, draw };
}

/**
 * The day's orders card: status and side filters, a search box and Cancel all (when something is working).
 * @param {{ ord: object[], error: object|null, byId: Map<string, { label: string }>, columns: object[], empty: Node, refresh: () => void }} o
 */
export function ordersCard({ ord, error, byId, columns, empty, actions, refresh }) {
  const f = loadFilters();
  const labelOf = (id) => byId.get(id)?.label ?? id;
  const counts = orderCounts(ord);
  const body = h("div", { class: "bk-ob-body" });
  const status = chips("Status", ORDER_FILTERS, f.status, (v) => ((f.status = v), saveFilters(f), draw()));
  const side = chips("Side", [["all", "Both sides"], ["BUY", "Buy"], ["SELL", "Sell"]], f.side, (v) => ((f.side = v), saveFilters(f), draw()));
  const search = h("input", { type: "search", class: "bk-ob-search", placeholder: "Search contract, order id or tag", "aria-label": "Search orders", autocomplete: "off", spellcheck: "false" });
  search.addEventListener("input", () => ((f.q = search.value), draw()));
  const open = openByMode(ord);
  const cancelAll = open.total
    ? h("button", { type: "button", class: "small", onclick: () => cancelAllFlow(open).then((done) => done && refresh()) }, `Cancel all open (${formatInt(open.total)})`)
    : null;
  const bar = h("div", { class: "bk-ob-bar" }, status.el, side.el, search);
  function draw() {
    status.draw(f.status, counts);
    side.draw(f.side);
    const rows = filterOrders(ord, { ...f, labelOf });
    body.replaceChildren(
      error
        ? h("div", { class: "card-body" }, alertBox(error))
        : ord.length && !rows.length
          ? emptyState("orders", "No orders match", "Change the filters above, or clear the search.", h("button", { type: "button", class: "small", onclick: () => ((f.status = "all"), (f.side = "all"), (f.q = ""), (search.value = ""), saveFilters(f), draw()) }, "Show all"), { compact: true })
          : table(columns, rows, empty),
    );
  }
  draw();
  return card({
    glyph: "orders",
    tint: "orange",
    title: "Today's orders",
    cls: "orders-today",
    actions: h("div", { class: "row" }, cancelAll, ...actions),
    flush: true,
    body: h("div", {}, ord.length ? bar : null, body),
  });
}

/** Cancel every working order on the accounts this key may use (paper and live), after one question. */
async function cancelAllFlow(open) {
  const parts = [open.paper ? `${formatInt(open.paper)} paper` : null, open.live ? `${formatInt(open.live)} live` : null].filter(Boolean).join(" and ");
  const ok = await modal({
    title: `Cancel all ${formatInt(open.total)} open order${open.total === 1 ? "" : "s"}?`,
    body: h(
      "div",
      { class: "stack" },
      h("p", {}, `The unfilled part of ${parts} order${open.total === 1 ? "" : "s"} is withdrawn. What already filled stays in Positions.`),
      h("p", { class: "muted" }, "Triggers (GTT, stops and targets) are not touched: cancel those in Triggers above."),
    ),
    buttons: [
      { label: "Keep them", value: false },
      { label: "Cancel all", cls: "primary", value: true },
    ],
  });
  if (!ok) return false;
  const r = await optional(api("/v1/orders/cancel-all", { method: "POST", body: {} }));
  if (r.error) {
    toast(`Not cancelled: ${r.error.message ?? "refused"}`, { tone: "error" });
    return false;
  }
  const d = r.data?.data ?? {};
  const n = d.cancelled?.length ?? 0;
  const failed = d.failed ?? [];
  toast(failed.length ? `Cancelled ${formatInt(n)}; ${formatInt(failed.length)} not cancelled: ${failed[0]?.message ?? "refused"}` : `Cancelled ${formatInt(n)} order${n === 1 ? "" : "s"}`, { tone: failed.length ? "warn" : "ok" });
  return true;
}

/** Orders › Trades: every fill on the accounts this key may use, newest first, with buy, sell and turnover totals. */
export async function renderTradesPage() {
  const [trades, accounts] = await Promise.all([optional(api("/v1/trades?limit=500")), optional(api("/v1/accounts"))]);
  const byId = new Map((accounts.data?.data ?? []).map((a) => [a.id, a]));
  const labelOf = (id) => byId.get(id)?.label ?? id;
  const list = [...(trades.data?.data ?? [])].sort((a, b) => Date.parse(b.tradedAt) - Date.parse(a.tradedAt));
  const f = { side: "all", q: "" };
  const totalsEl = h("div", { class: "ticket-figs bk-tb-figs" });
  const body = h("div");
  const side = chips("Side", [["all", "Both sides"], ["BUY", "Buy"], ["SELL", "Sell"]], f.side, (v) => ((f.side = v), draw()));
  const search = h("input", { type: "search", class: "bk-ob-search", placeholder: "Search contract, order id or account", "aria-label": "Search trades", autocomplete: "off", spellcheck: "false" });
  search.addEventListener("input", () => ((f.q = search.value), draw()));
  const columns = [
    { label: "Time", cell: (t) => istTime(t.tradedAt) },
    { label: "Account", cell: (t) => labelOf(t.accountId) },
    { label: "Contract", wrap: true, cell: (t) => h("div", { class: "order-contract", title: t.symbol }, h("strong", {}, contractName(t.symbol)), h("div", { class: "muted small" }, `${t.product ?? ""} · ${istDateTime(t.tradedAt)}`)) },
    { label: "Side", cell: (t) => h("span", { class: "order-side" }, t.side) },
    { label: "Qty", num: true, cell: (t) => formatInt(t.qty ?? t.quantity) },
    { label: "Price", num: true, cell: (t) => formatFixed(t.price, 2) },
    { label: "Value", num: true, cell: (t) => formatRupee((Number(t.qty ?? t.quantity) || 0) * (Number(t.price) || 0), 0) },
    { label: "Charges", num: true, cell: (t) => formatRupee(t.charges, 2) },
    { label: "Order", cell: (t) => h("span", { class: "mono muted small" }, t.orderId) },
  ];
  const fig = (label, value) => h("div", {}, h("small", {}, label), value);
  function draw() {
    side.draw(f.side);
    const rows = filterTrades(list, { ...f, labelOf });
    const t = tradeTotals(rows);
    totalsEl.replaceChildren(fig("Trades", formatInt(t.count)), fig("Bought", formatRupee(t.buyValue, 0)), fig("Sold", formatRupee(t.sellValue, 0)), fig("Turnover", formatRupee(t.turnover, 0)), fig("Charges", formatRupee(t.charges, 2)));
    body.replaceChildren(table(columns, rows, emptyState("orders", list.length ? "No trades match" : "No trades yet", list.length ? "Change the side or clear the search." : "Fills from the chain, your scripts, triggers and webhooks show up here.", null, { compact: true })));
  }
  draw();
  return [
    card({
      glyph: "list",
      tint: "teal",
      title: "Trade book",
      sub: "Every fill, newest first. Paper charges are the paper engine's brokerage; statutory charges are in the ticket and the journal.",
      flush: true,
      body: trades.error ? h("div", { class: "card-body" }, alertBox(trades.error)) : h("div", {}, h("div", { class: "bk-ob-bar" }, side.el, search), totalsEl, body),
    }),
  ];
}
