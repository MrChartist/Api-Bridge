// Orders › Orders: the day's order book with filters (status, side, search) and Cancel all; Orders › Trades: every fill
// with totals. Filters are a per-viewer convenience (localStorage); the books come from GET /v1/orders and /v1/trades.
import { alertBox, api, card, emptyState, h, istTime, modal, optional, table, toast, writeCount } from "./app.js";
import { contractName } from "./flows.js";
import { DASH, formatDayMonth, formatFixed, formatInt, formatPercent, formatRupee, formatRupeeGrouped } from "./format.js";
import { DRY_RUN_REUSE_MS, ORDER_FILTERS, cancelAllBody, cancelAllBridgeLine, cancelAllButton, cancelAllGroups, cancelAllTitle, cancelAllReport, filterOrders, filterTrades, fundsView, openByMode, orderCounts, shortMemo } from "./orders-core.js";
import { fillCharges, fillTotals } from "./charges.js";

const KEY = "mcb.orders.filters";
/**
 * Cancel all's dry run for the button: one per page render or action. The redraw that follows a render painted from
 * remembered answers reuses it (DRY_RUN_REUSE_MS), any write asks again, and the Cancel all question always asks afresh.
 */
const buttonDryRun = shortMemo(DRY_RUN_REUSE_MS);
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
  // Cancel all: shown from the page's own open orders at once, then from a dry run's count of both groups, so orders
  // placed outside the Bridge (in the broker's app) show it too.
  const cancelAll = h("span", { class: "ca-slot" });
  const drawCancelAll = (groups) => {
    const b = cancelAllButton(open.total, groups);
    cancelAll.replaceChildren(b.show ? h("button", { type: "button", class: "small", onclick: () => cancelAllFlow(labelOf).then((report) => report && showReport(report, refresh)) }, b.label) : "");
  };
  drawCancelAll(null);
  buttonDryRun(() => optional(api("/v1/orders/cancel-all", { method: "POST", body: { dryRun: true } })), { epoch: writeCount() }).then((r) => {
    if (!r.error) drawCancelAll(cancelAllGroups(r.data?.data));
  });
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

/** Redraw the page, then say what Cancel all did: the redraw hides any toast, so the report goes up after it starts. */
function showReport(report, refresh) {
  refresh();
  if (report.text) toast(report.text, { tone: report.tone });
}

/** One open order in Cancel all's lists: side, quantity, contract, account and mode. */
function cancelRow(o, labelOf) {
  const qty = o.quantity ? `${formatInt(o.quantity)} ` : "";
  return h("li", { class: "ca-row" }, h("span", { class: "ca-what" }, `${o.side ?? ""} ${qty}${o.symbol ? contractName(o.symbol) : o.orderId}`.trim()), h("span", { class: "muted small" }, `${labelOf(o.accountId)} · ${o.mode === "live" ? "live" : "paper"}`));
}
function cancelList(rows, labelOf) {
  const shown = rows.slice(0, 6);
  return h("ul", { class: "ca-list" }, ...shown.map((o) => cancelRow(o, labelOf)), rows.length > shown.length ? h("li", { class: "muted small" }, `and ${formatInt(rows.length - shown.length)} more`) : null);
}

/**
 * Cancel the working orders on the accounts this key may use, after one question that counts and lists both groups:
 * orders the Bridge placed (cancelled), and live orders placed outside the Bridge, in the broker's app (left open
 * unless the trader ticks the box). The request body matches the choice. Resolves the report ({ text, tone }: what
 * each group got) or null when nothing was sent.
 */
async function cancelAllFlow(labelOf = (id) => id) {
  const dry = await optional(api("/v1/orders/cancel-all", { method: "POST", body: { dryRun: true } }));
  if (dry.error) {
    toast(`Could not read the open orders: ${dry.error.message ?? "refused"}`, { tone: "error" });
    return null;
  }
  const g = cancelAllGroups(dry.data?.data);
  if (!g.total) return { text: "No open orders to cancel", tone: "info" };
  const ours = g.bridge.length;
  const theirs = g.external.length;
  const also = theirs ? h("input", { type: "checkbox" }) : null;
  const ok = await modal({
    title: cancelAllTitle(g),
    body: h(
      "div",
      { class: "stack ca-body" },
      h("p", {}, "The unfilled part is withdrawn. What already filled stays in Positions."),
      h("section", { class: "ca-group" }, h("h3", { class: "ca-head" }, `Placed through the Bridge · ${formatInt(ours)}`), h("p", { class: "muted small" }, cancelAllBridgeLine(g)), ours ? cancelList(g.bridge, labelOf) : null),
      theirs
        ? h(
            "section",
            { class: "ca-group" },
            h("h3", { class: "ca-head" }, `Placed outside the Bridge · ${formatInt(theirs)}`),
            h("p", { class: "muted small" }, "In your broker's app or terminal, such as a stop-loss you set there. Left open unless you tick the box."),
            cancelList(g.external, labelOf),
            h("label", { class: "check" }, also, `Also cancel ${formatInt(theirs)} order${theirs === 1 ? "" : "s"} placed outside the Bridge`),
          )
        : null,
          ),
    buttons: [
      { label: "Keep them", value: false },
      { label: "Cancel orders", cls: "primary", value: true },
    ],
  });
  if (!ok) return null;
  const r = await optional(api("/v1/orders/cancel-all", { method: "POST", body: cancelAllBody(also?.checked === true) }));
  if (r.error) {
    toast(`Not cancelled: ${r.error.message ?? "refused"}`, { tone: "error" });
    return null;
  }
  return cancelAllReport(r.data?.data);
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
    { label: "Contract", wrap: true, cell: (t) => h("div", { class: "order-contract", title: t.symbol }, h("strong", {}, contractName(t.symbol)), h("div", { class: "muted small" }, `${t.product ?? ""} · ${formatDayMonth(String(t.tradedAt ?? "").slice(0, 10))}`)) },
    { label: "Side", cell: (t) => h("span", { class: "order-side" }, t.side) },
    { label: "Qty", num: true, cell: (t) => formatInt(t.qty ?? t.quantity) },
    { label: "Price", num: true, cell: (t) => formatFixed(t.price, 2) },
    { label: "Value", num: true, cell: (t) => formatRupee((Number(t.qty ?? t.quantity) || 0) * (Number(t.price) || 0), 0) },
    { label: "Charges ≈", num: true, cell: (t) => formatRupee(fillCharges(t)?.total, 2) },
    { label: "Order", cell: (t) => h("span", { class: "mono muted small" }, t.orderId) },
  ];
  const fig = (label, value) => h("div", {}, h("small", {}, label), value);
  function draw() {
    side.draw(f.side);
    const rows = filterTrades(list, { ...f, labelOf });
    const t = fillTotals(rows);
    totalsEl.replaceChildren(fig("Trades", formatInt(t.count)), fig("Bought", formatRupee(t.buyValue, 0)), fig("Sold", formatRupee(t.sellValue, 0)), fig("Traded value", formatRupee(t.turnoverValue, 0)), fig("Charges ≈", formatRupee(t.charges.total, 2)));
    body.replaceChildren(table(columns, rows, emptyState("orders", list.length ? "No trades match" : "No trades yet", list.length ? "Change the side or clear the search." : "Fills from your scripts, webhooks and AI assistants show up here.", null, { compact: true })));
  }
  draw();
  return [
    card({
      glyph: "list",
      tint: "teal",
      title: "Trade book",
      sub: "Every fill, newest first. Charges are estimated for futures and options (brokerage, STT, exchange, SEBI, stamp, GST); your broker's contract note is final.",
      flush: true,
      body: trades.error ? h("div", { class: "card-body" }, alertBox(trades.error)) : h("div", {}, h("div", { class: "bk-ob-bar" }, side.el, search), totalsEl, body),
    }),
  ];
}

/**
 * Funds for every account in one card: available, margin used, collateral, a utilisation bar, realised and
 * unrealised P&L and open positions. Paper accounts read the paper engine; a broker account reads the broker (one funds
 * and one positions call each, when the page draws), and says why when it cannot.
 * @param {Array<{ id: string, label: string, broker: string }>} accs
 * @param {(v: number|null) => Node|string} pnl  the page's grouped, signed P&L cell
 */
export async function fundsCard(accs, pnl) {
  const list = accs.filter((a) => a.broker !== "demo");
  if (!list.length) return null;
  const rows = await Promise.all(
    list.map(async (a) => {
      const [funds, pos] = await Promise.all([optional(api(`/v1/funds?account=${encodeURIComponent(a.id)}`)), optional(api(`/v1/positions?account=${encodeURIComponent(a.id)}`))]);
      const f = funds.data?.data?.funds ?? funds.data?.data ?? null;
      const items = pos.data?.data ?? null;
      return { a, f, v: fundsView(f), error: funds.error ?? null, open: items ? items.filter((p) => Number(p.netQty) !== 0).length : null };
    }),
  );
  const util = (v) => {
    if (v.util === null) return DASH;
    const bar = h("span", { class: "bk-util-bar", "data-level": v.level, "aria-hidden": "true" });
    bar.style.setProperty("--w", String(v.util));
    return h("span", { class: "bk-util", title: `${formatPercent(v.util * 100, 1)} of ${formatRupeeGrouped(v.total, 0)} is blocked as margin` }, h("span", { class: "bk-util-track" }, bar), formatPercent(v.util * 100, 0));
  };
  return card({
    glyph: "wallet",
    tint: "teal",
    title: "Funds",
    sub: "Every account: what is free to trade, the margin in use, collateral and P&L. Paper from the paper engine; a broker account as the broker reports it.",
    flush: true,
    body: table(
      [
        { label: "Account", cell: ({ a }) => h("div", {}, h("strong", {}, a.label), h("div", { class: "muted small" }, a.broker === "paper" ? "Paper" : `${a.broker} · as reported`)) },
        { label: "Available", num: true, cell: ({ v, error }) => (error ? h("span", { class: "muted small", title: error.message }, "Not available") : formatRupeeGrouped(v.available, 0)) },
        { label: "Margin used", num: true, cell: ({ v, error }) => (error ? DASH : formatRupeeGrouped(v.used, 0)) },
        { label: "Collateral", num: true, cell: ({ v, a, error }) => (error ? DASH : v.collateral === null ? h("span", { class: "muted small", title: a.broker === "paper" ? "Paper accounts have no pledged holdings" : "The broker did not report collateral" }, DASH) : formatRupeeGrouped(v.collateral, 0)) },
        { label: "Used", cell: ({ v, error }) => (error ? DASH : util(v)) },
        { label: "Realised", num: true, cell: ({ f, error }) => (error ? DASH : pnl(f?.realisedPnl)) },
        { label: "Unrealised", num: true, cell: ({ f, error }) => (error ? DASH : pnl(f?.unrealisedPnl)) },
        { label: "Open", num: true, cell: ({ open }) => formatInt(open) },
        { label: "", cell: ({ a, error }) => (error ? h("button", { type: "button", class: "small", onclick: () => (location.hash = "#/accounts") }, "Accounts") : h("button", { type: "button", class: "small", "aria-label": `Positions of ${a.label}`, onclick: () => (location.hash = "#/positions") }, "Positions")) },
      ],
      rows,
    ),
  });
}
