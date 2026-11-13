// Orders › Positions: what you hold right now, across every connected account. Open positions (today's and carried)
// with their profit and loss, then delivery holdings. "Exit" opens the order ticket filled in with the opposite side
// for the whole quantity; nothing is placed until you choose Place order there.
// Reads GET /v1/positions?account= and /v1/holdings?account= once per enabled account.
import { alertBox, api, card, emptyState, h, optional, pill, table } from "./app.js";
import { contractName } from "./flows.js";
import { DASH, formatFixed, formatInt, formatRupeeGrouped, isFigure } from "./format.js";
import { openOrderTicket } from "./ticket.js";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Positions that are still open (a squared-off one stays in the list with its realised P&L). Pure. */
export const openPositions = (rows) => (Array.isArray(rows) ? rows : []).filter((p) => num(p?.netQty) !== 0);

/** Totals across positions. Pure. */
export function positionTotals(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    open: openPositions(list).length,
    closed: list.length - openPositions(list).length,
    unrealised: list.reduce((s, p) => s + num(p?.unrealisedPnl), 0),
    realised: list.reduce((s, p) => s + num(p?.realisedPnl), 0),
    day: list.reduce((s, p) => s + num(p?.dayPnl ?? p?.pnl), 0),
  };
}

/** What the ticket is filled with to close a position: the opposite side for the whole quantity. Pure. */
export function exitTicket(p) {
  const qty = num(p?.netQty);
  if (!qty) return null;
  return { account: p.accountId, symbol: p.symbol, side: qty > 0 ? "SELL" : "BUY", quantity: Math.abs(qty), product: p.product };
}

/** Holdings rows in one shape, whatever names a broker's adapter used. Pure. */
export function holdingRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((x) => {
    const qty = num(x.quantity ?? x.qty ?? x.netQty);
    const avg = x.avgPrice ?? x.averagePrice ?? null;
    const ltp = x.ltp ?? null;
    const pnl = x.pnl ?? (isFigure(avg) && isFigure(ltp) ? (num(ltp) - num(avg)) * qty : null);
    return { accountId: x.accountId, symbol: x.symbol, quantity: qty, avgPrice: avg, ltp, value: isFigure(ltp) ? num(ltp) * qty : null, pnl };
  });
}

/** Rupees with a sign and a colour: green for a gain, red for a loss. */
const money = (v) => {
  if (!isFigure(v)) return DASH;
  const n = Number(v);
  const text = formatRupeeGrouped(Math.abs(n), 0);
  if (text === "₹0") return text;
  return h("span", { class: n > 0 ? "up" : "down" }, `${n > 0 ? "+" : "-"}${text}`);
};
const fig = (label, value) => h("div", {}, h("small", {}, label), value);

export async function renderPositionsPage() {
  const accounts = (await api("/v1/accounts")).data.data ?? [];
  const usable = accounts.filter((a) => a.enabled !== false && (a.capabilities ?? []).includes("orderBook"));
  const labelOf = (id) => accounts.find((a) => a.id === id)?.label ?? id;
  const refresh = () => window.dispatchEvent(new HashChangeEvent("hashchange"));
  const results = await Promise.all(
    usable.map(async (a) => {
      const [pos, hold] = await Promise.all([optional(api(`/v1/positions?account=${encodeURIComponent(a.id)}`)), optional(api(`/v1/holdings?account=${encodeURIComponent(a.id)}`))]);
      return { a, pos, hold };
    }),
  );
  const positions = results.flatMap((r) => (r.pos.data?.data ?? []).map((p) => ({ ...p, accountId: p.accountId ?? r.a.id })));
  const holdings = holdingRows(results.flatMap((r) => (r.hold.data?.data ?? []).map((x) => ({ accountId: r.a.id, ...x }))));
  const failed = results.filter((r) => r.pos.error);
  const t = positionTotals(positions);
  const rows = [...openPositions(positions), ...positions.filter((p) => num(p.netQty) === 0)];

  const exit = (p) => {
    const x = exitTicket(p);
    return x ? h("button", { type: "button", class: "small", "aria-label": `Exit ${contractName(p.symbol)}`, onclick: () => openOrderTicket({ accounts, ...x, onPlaced: refresh }) }, "Exit") : pill("Closed");
  };
  const nodes = [
    card({
      glyph: "list",
      tint: "orange",
      title: "Positions",
      sub: "Open positions in every connected account, with profit and loss at the last price.",
      flush: true,
      actions: [h("button", { type: "button", class: "small primary", onclick: () => openOrderTicket({ accounts, onPlaced: refresh }) }, "New order")],
      body: h(
        "div",
        {},
        h("div", { class: "ticket-figs bk-tb-figs" }, fig("Open", formatInt(t.open)), fig("Unrealised", money(t.unrealised)), fig("Realised", money(t.realised)), fig("Today", money(t.day))),
        ...failed.map((r) => h("div", { class: "card-body" }, alertBox({ ...r.pos.error, message: `${r.a.label}: ${r.pos.error.message}` }))),
        table(
          [
            { label: "Account", cell: (p) => labelOf(p.accountId) },
            { label: "Contract", wrap: true, cell: (p) => h("div", { class: "order-contract", title: p.symbol }, h("strong", {}, contractName(p.symbol)), h("div", { class: "muted small" }, `${p.product ?? ""}${p.mode === "live" ? " · Live" : " · Paper"}`)) },
            { label: "Side", cell: (p) => (num(p.netQty) === 0 ? DASH : h("span", { class: "order-side", "data-side": num(p.netQty) > 0 ? "BUY" : "SELL" }, num(p.netQty) > 0 ? "LONG" : "SHORT")) },
            { label: "Qty", num: true, cell: (p) => formatInt(Math.abs(num(p.netQty))) },
            { label: "Avg price", num: true, cell: (p) => formatFixed(p.avgPrice, 2) },
            { label: "Last price", num: true, cell: (p) => formatFixed(p.ltp, 2) },
            { label: "P&L", num: true, cell: (p) => money(p.pnl ?? num(p.unrealisedPnl) + num(p.realisedPnl)) },
            { label: "", cell: exit },
          ],
          rows,
          emptyState("orders", "No positions", "When an order fills, the position shows up here with its profit and loss.", h("button", { type: "button", class: "primary", onclick: () => openOrderTicket({ accounts, onPlaced: refresh }) }, "New order"), { compact: true }),
        ),
      ),
    }),
    card({
      glyph: "accounts",
      tint: "indigo",
      title: "Holdings",
      sub: "Shares held for delivery in your broker accounts.",
      flush: true,
      body: table(
        [
          { label: "Account", cell: (x) => labelOf(x.accountId) },
          { label: "Stock", wrap: true, cell: (x) => h("strong", { title: x.symbol }, contractName(x.symbol)) },
          { label: "Qty", num: true, cell: (x) => formatInt(x.quantity) },
          { label: "Avg price", num: true, cell: (x) => formatFixed(x.avgPrice, 2) },
          { label: "Last price", num: true, cell: (x) => formatFixed(x.ltp, 2) },
          { label: "Value", num: true, cell: (x) => (isFigure(x.value) ? formatRupeeGrouped(x.value, 0) : DASH) },
          { label: "P&L", num: true, cell: (x) => money(x.pnl) },
          { label: "", cell: (x) => h("button", { type: "button", class: "small", "aria-label": `Sell ${contractName(x.symbol)}`, onclick: () => openOrderTicket({ accounts, account: x.accountId, symbol: x.symbol, side: "SELL", quantity: x.quantity, product: "CNC", onPlaced: refresh }) }, "Sell") },
        ],
        holdings,
        emptyState("accounts", "No holdings", "Delivery shares in a connected broker account are listed here. Shares bought on paper today show under Positions until the day ends.", null, { compact: true }),
      ),
    }),
  ];
  return nodes;
}
