// "Send a practice order": a short form for a first paper order (stock, buy or sell, how many). The Bridge's paper
// engine fills it against the current price. Answers are remembered, so the next one starts where this one ended.
import { alertBox, api, app, h, modal, toast } from "./app.js";
import { formatFixed } from "./format.js";
import { practiceOrder } from "./easy-core.js";
import { createOrderKeys } from "./orders-core.js";

const SLOT = "mcb.dashboard.practiceOrder";
let deps = { segmented: null };
export function configurePractice(d) {
  deps = { ...deps, ...d };
}

const readLast = () => {
  try {
    return JSON.parse(app.local.get(SLOT) ?? "{}") ?? {};
  } catch {
    return {};
  }
};

/**
 * Open the form. `onPlaced(order)` runs after the order went through (the Orders page redraws); with none, the person is
 * taken to the Orders page, where the order now is.
 */
export async function practiceOrderSheet({ onPlaced } = {}) {
  let paper = [];
  try {
    paper = ((await api("/v1/accounts")).data.data ?? []).filter((a) => a.broker === "paper");
  } catch {
    /* the form still opens; the order says why it cannot go */
  }
  const last = readLast();
  const symbol = h("input", { id: "po-symbol", value: last.symbol ?? "RELIANCE", autocomplete: "off", spellcheck: "false", autocapitalize: "characters", "aria-describedby": "po-symbol-hint" });
  const qty = h("input", { id: "po-qty", type: "text", inputmode: "numeric", value: String(last.quantity ?? 1), autocomplete: "off" });
  const side = deps.segmented("Buy or sell", [["BUY", "Buy"], ["SELL", "Sell"]], last.side === "SELL" ? "SELL" : "BUY");
  const account = h("select", { id: "po-account" }, paper.map((a) => h("option", { value: a.id, selected: a.id === last.account || undefined }, a.label ?? a.id)));
  const err = h("div", { "aria-live": "polite" });
  const field = (label, input, hint, id) => h("label", { class: "field", for: input.id }, h("span", {}, label), input, hint ? h("span", { class: "hint", id }, hint) : null);
  const mark = (input, message) => {
    input.setAttribute("aria-invalid", "true");
    input.focus();
    err.replaceChildren(alertBox({ title: message }, "warn"));
  };

  const body = h(
    "div",
    { class: "stack po-sheet" },
    h("p", { class: "po-lead" }, "A practice order uses pretend money. It is filled at the current price and nothing reaches the market."),
    field("Stock", symbol, "For example RELIANCE or TCS. NSE is assumed.", "po-symbol-hint"),
    h("div", { class: "field seg-field" }, h("span", { id: "po-side-l" }, "Buy or sell"), side),
    field("Quantity", qty),
    paper.length > 1 ? field("Paper account", account) : null,
    err,
  );
  side.removeAttribute("aria-label");
  side.setAttribute("aria-labelledby", "po-side-l");

  const keys = createOrderKeys(); // the same order pressed twice is one order
  const placed = await modal({
    title: "Send a practice order",
    body,
    buttons: [
      { label: "Cancel", value: false },
      {
        label: "Place practice order",
        cls: "primary",
        onClick: async () => {
          err.replaceChildren();
          symbol.removeAttribute("aria-invalid");
          qty.removeAttribute("aria-invalid");
          const acc = paper.length > 1 ? account.value : paper[0]?.id;
          const r = practiceOrder({ account: acc, symbol: symbol.value, side: side.value, quantity: qty.value });
          if (r.error) {
            mark(r.error.field === "quantity" ? qty : r.error.field === "symbol" ? symbol : account, r.error.message);
            return false;
          }
          try {
            const res = await api("/v1/orders", { method: "POST", body: r.body, idempotencyKey: keys.keyFor(r.body) });
            const o = res.data.data;
            app.local.set(SLOT, JSON.stringify({ symbol: symbol.value.trim().toUpperCase(), side: side.value, quantity: Number(qty.value), account: acc }));
            const fill = o.avgPrice ? ` at ₹${formatFixed(o.avgPrice, 2)}` : "";
            toast(`Practice order ${o.status ?? "placed"}: ${r.body.side === "BUY" ? "bought" : "sold"} ${r.body.quantity} ${r.body.symbol.replace(/^[A-Z]+:/, "")}${o.status === "filled" ? fill : ""}`);
            return { order: o };
          } catch (e) {
            err.replaceChildren(alertBox(e));
            return false;
          }
        },
      },
    ],
  });
  if (placed?.order) {
    if (onPlaced) onPlaced(placed.order);
    else location.hash = "#/orders";
  }
  return placed?.order ?? null;
}
