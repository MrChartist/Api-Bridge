// The order ticket: one sheet to place a buy or a sell by hand, with every order type the Bridge takes (LIMIT, MARKET,
// SL, SL-M), every product (CNC, INTRADAY, MARGIN, MTF) and both validities (DAY, IOC). It only builds the same body a
// script would POST to /v1/orders, so every safety check, limit and the paper/live rules still apply on the server.
// "Check order" asks POST /v1/orders/preview and shows each warning and block before anything is placed.
import { api, h, modal, optional, plainBrokerMessage, toast } from "./app.js";
import { formatFixed, formatInt } from "./format.js";
import { createOrderKeys } from "./orders-core.js";
import { field, segField, segmented } from "./views.js";

/** [value, label on the control, what it means in plain words]. */
export const TICKET_ORDER_TYPES = Object.freeze([
  ["LIMIT", "Limit", "Fills at your price or better."],
  ["MARKET", "Market", "Fills now at the best price available, with market protection."],
  ["SL", "SL", "Stop-loss limit: waits for the trigger price, then becomes a limit order at your price."],
  ["SL-M", "SL-M", "Stop-loss market: waits for the trigger price, then fills at the market."],
]);
export const TICKET_PRODUCTS = Object.freeze([
  ["CNC", "CNC", "Delivery: shares you keep. No leverage."],
  ["INTRADAY", "Intraday", "Squared off the same day."],
  ["MARGIN", "Margin", "Carried overnight: futures and options positions."],
  ["MTF", "MTF", "Margin trading facility: delivery bought with broker funding."],
]);
export const TICKET_VALIDITIES = Object.freeze([
  ["DAY", "Day", "Stays open until the market closes."],
  ["IOC", "IOC", "Immediate or cancel: whatever cannot fill at once is cancelled."],
]);

/** Which price fields an order type uses. Pure. */
export const ticketNeeds = (orderType) => ({ price: orderType === "LIMIT" || orderType === "SL", trigger: orderType === "SL" || orderType === "SL-M" });

/** The plain-words line for the chosen value of one of the lists above. Pure. */
export const choiceHint = (list, value) => list.find(([v]) => v === value)?.[2] ?? "";

/** Accounts an order can go to: enabled ones, paper accounts first (the safe default). Pure. */
export function ticketAccounts(accounts) {
  const on = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.enabled !== false);
  return [...on.filter((a) => a.broker === "paper"), ...on.filter((a) => a.broker !== "paper")];
}

const positive = (text) => {
  const n = Number(String(text ?? "").trim());
  return String(text ?? "").trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * The POST /v1/orders body from what the ticket holds, or the first problem and the field it belongs to. Pure.
 * `lotSize` > 1 means the size was typed in lots (futures and options); otherwise in units.
 * @returns {{ body: object } | { error: { field: "account"|"symbol"|"size"|"price"|"trigger", message: string } }}
 */
export function buildTicketOrder({ account, symbol, side, size, lotSize = 1, product, orderType, price, trigger, validity = "DAY", mode = "paper", tag = "" }) {
  const fail = (f, message) => ({ error: { field: f, message } });
  if (!account) return fail("account", "Choose the account this order goes to.");
  const sym = String(symbol ?? "").trim().toUpperCase();
  if (!sym) return fail("symbol", "Type a symbol, for example NSE:RELIANCE.");
  const n = positive(size);
  const inLots = Number(lotSize) > 1;
  if (n === null || !Number.isInteger(n)) return fail("size", inLots ? "Lots must be a whole number, 1 or more." : "Quantity must be a whole number, 1 or more.");
  const needs = ticketNeeds(orderType);
  const p = needs.price ? positive(price) : null;
  const t = needs.trigger ? positive(trigger) : null;
  if (needs.trigger && t === null) return fail("trigger", "Type the trigger price: the price at which this order wakes up.");
  if (needs.price && p === null) return fail("price", orderType === "SL" ? "Type the limit price used once the trigger is hit." : "Type your limit price.");
  // A stop-loss limit must be able to fill once it wakes: a buy's limit at or above its trigger, a sell's at or below.
  if (orderType === "SL" && side === "BUY" && p < t) return fail("price", "For a buy stop-loss, the limit price must be the trigger price or higher.");
  if (orderType === "SL" && side === "SELL" && p > t) return fail("price", "For a sell stop-loss, the limit price must be the trigger price or lower.");
  const cleanTag = String(tag ?? "").trim();
  if (cleanTag && !/^[A-Za-z0-9_-]{1,20}$/.test(cleanTag)) return fail("tag", "A tag is up to 20 letters, digits, - or _.");
  return {
    body: {
      account,
      symbol: sym,
      side,
      ...(inLots ? { lots: n } : { quantity: n }),
      product,
      orderType,
      ...(p !== null ? { price: p } : {}),
      ...(t !== null ? { triggerPrice: t } : {}),
      validity,
      mode,
      ...(cleanTag ? { tag: cleanTag } : {}),
    },
  };
}

/** "Buy 2 lots NFO:NIFTY... at 245.50 (SL, trigger 240)". Pure. */
export function ticketSummary(body) {
  const size = body.lots ? `${formatInt(body.lots)} ${body.lots === 1 ? "lot" : "lots"}` : formatInt(body.quantity);
  const at = body.price !== undefined ? `at ${formatFixed(body.price, 2)}` : "at market";
  const trig = body.triggerPrice !== undefined ? `, trigger ${formatFixed(body.triggerPrice, 2)}` : "";
  return `${body.side === "BUY" ? "Buy" : "Sell"} ${size} ${body.symbol} ${at} (${body.orderType}${trig})`;
}

/** The first field a refusal from the Bridge names, as a ticket field id, or null. Pure. */
export function refusedField(errors) {
  for (const e of Array.isArray(errors) ? errors : []) {
    const leaf = String(e?.path ?? "").split(".").pop();
    if (leaf === "quantity" || leaf === "lots") return { field: "size", message: String(e.message ?? "") };
    if (leaf === "price") return { field: "price", message: String(e.message ?? "") };
    if (leaf === "triggerPrice") return { field: "trigger", message: String(e.message ?? "") };
    if (leaf === "symbol") return { field: "symbol", message: String(e.message ?? "") };
  }
  return null;
}

const SEARCH_WAIT_MS = 220;

/**
 * Open the ticket. Resolves once it closes; `onPlaced` runs after an order went through.
 * `account`, `quantity` (units) and `product` fill the ticket in, for "Exit" on a position: nothing is placed until
 * the person chooses Place order.
 * @param {{ accounts: object[], side?: "BUY"|"SELL", symbol?: string, account?: string, quantity?: number, product?: string, onPlaced?: () => void }} opts
 */
export async function openOrderTicket({ accounts, side: firstSide = "BUY", symbol: firstSymbol = "", account: firstAccount = "", quantity: firstQuantity = 0, product: firstProduct = "", onPlaced = null }) {
  const accs = ticketAccounts(accounts);
  const byId = new Map(accs.map((a) => [a.id, a]));
  const side = segmented("Side", [["BUY", "Buy"], ["SELL", "Sell"]], firstSide);
  // The colour of a side follows its value (BUY green, SELL red), whatever the label says.
  const account = h("select", { id: "tk-account" }, ...accs.map((a) => h("option", { value: a.id }, a.broker === "paper" ? `${a.label} (paper)` : a.label)));
  const symbol = h("input", { id: "tk-symbol", type: "text", autocomplete: "off", spellcheck: "false", placeholder: "NSE:RELIANCE", value: firstSymbol });
  const matches = h("datalist", { id: "tk-matches" });
  symbol.setAttribute("list", "tk-matches");
  const about = h("span", { class: "hint", "aria-live": "polite" });
  const size = h("input", { id: "tk-size", type: "number", min: "1", step: "1", inputmode: "numeric", value: "1" });
  const sizeName = h("span", {}, "Quantity");
  const sizeHint = h("span", { class: "hint", "aria-live": "polite" });
  const product = segmented("Product", TICKET_PRODUCTS.map(([v, t]) => [v, t]), TICKET_PRODUCTS.some(([v]) => v === firstProduct) ? firstProduct : "CNC");
  if (firstAccount && accs.some((a) => a.id === firstAccount)) account.value = firstAccount;
  if (firstQuantity > 0) size.value = String(firstQuantity);
  const productHint = h("p", { class: "tk-hint" });
  const orderType = segmented("Order type", TICKET_ORDER_TYPES.map(([v, t]) => [v, t]), "LIMIT");
  const typeHint = h("p", { class: "tk-hint" });
  const price = h("input", { id: "tk-price", type: "number", min: "0.01", step: "0.05", inputmode: "decimal" });
  const trigger = h("input", { id: "tk-trigger", type: "number", min: "0.01", step: "0.05", inputmode: "decimal" });
  const priceField = field("Limit price", price);
  const triggerField = field("Trigger price", trigger);
  const prices = h("div", { class: "form-grid bk-pair" }, triggerField, priceField);
  const validity = segmented("Validity", TICKET_VALIDITIES.map(([v, t]) => [v, t]), "DAY");
  const mode = segmented("Mode", [["paper", "Paper"], ["live", "Live"]], "paper");
  const modeField = segField("Mode", mode);
  const modeHint = h("p", { class: "tk-hint" });
  const tag = h("input", { id: "tk-tag", type: "text", maxlength: "20", autocomplete: "off", placeholder: "Optional" });
  const checks = h("div", { class: "tk-checks", "aria-live": "polite" });
  const err = h("p", { class: "bad-text", role: "alert", hidden: true });

  const keys = createOrderKeys();
  let lotSize = 1;
  let known = new Map();
  const inputs = { account, symbol, size, price, trigger, tag };
  const say = (message) => {
    err.textContent = message;
    err.hidden = !message;
    if (message) err.scrollIntoView({ block: "nearest" });
  };
  const mark = (name, message) => {
    const el = inputs[name] ?? symbol;
    say(message);
    el.setAttribute("aria-invalid", "true");
    el.focus();
    el.addEventListener("input", () => el.removeAttribute("aria-invalid"), { once: true });
    return false;
  };

  const showSize = () => {
    const inLots = lotSize > 1;
    sizeName.textContent = inLots ? "Lots" : "Quantity";
    const n = Number(size.value);
    sizeHint.textContent = inLots ? `Lot size ${formatInt(lotSize)}${Number.isInteger(n) && n > 0 ? ` · ${formatInt(n * lotSize)} qty` : ""}` : "";
  };
  const showType = () => {
    const needs = ticketNeeds(orderType.value);
    priceField.hidden = !needs.price;
    triggerField.hidden = !needs.trigger;
    prices.hidden = !needs.price && !needs.trigger;
    typeHint.textContent = choiceHint(TICKET_ORDER_TYPES, orderType.value);
    productHint.textContent = choiceHint(TICKET_PRODUCTS, product.value);
  };
  const showMode = () => {
    const a = byId.get(account.value);
    const real = Boolean(a) && a.broker !== "paper" && a.broker !== "demo";
    modeField.hidden = !real;
    if (!real) mode.value = "paper";
    modeHint.hidden = !real;
    modeHint.textContent = mode.value === "live" ? "Live sends a real order with real money to your broker. The Bridge refuses it unless live trading is switched on for this account." : "Paper practises with virtual money at real prices. Nothing reaches your broker.";
  };
  /** What the Bridge knows about the typed symbol: its name, lot size and tick (the size field follows the lot). */
  const showSymbol = async () => {
    const sym = symbol.value.trim().toUpperCase();
    checks.replaceChildren();
    if (!sym.includes(":")) return void ((lotSize = 1), (about.textContent = ""), showSize());
    let inst = known.get(sym) ?? null;
    if (!inst) inst = (await optional(api(`/v1/instruments/${encodeURIComponent(sym)}`))).data?.data ?? null;
    if (symbol.value.trim().toUpperCase() !== sym) return;
    lotSize = Number(inst?.lotSize) > 0 ? Number(inst.lotSize) : 1;
    about.textContent = inst ? [inst.name, inst.expiry ? `expires ${inst.expiry}` : null, Number(inst.tickSize) > 0 ? `tick ${inst.tickSize}` : null].filter(Boolean).join(" · ") : "";
    if (inst && Number(inst.tickSize) > 0) for (const el of [price, trigger]) el.step = String(inst.tickSize);
    // Shares are usually bought for delivery; a future or an option cannot be.
    if (inst && inst.kind && inst.kind !== "EQ" && (product.value === "CNC" || product.value === "MTF")) product.value = "MARGIN";
    // A quantity handed in (Exit on a position) is in units; the field is in lots when the contract has a lot size.
    if (firstQuantity > 0 && sym === String(firstSymbol).toUpperCase() && lotSize > 1 && firstQuantity % lotSize === 0) size.value = String(firstQuantity / lotSize);
    showSize();
    showType();
  };
  let waiting = 0;
  const search = () => {
    clearTimeout(waiting);
    const q = symbol.value.trim();
    if (q.length < 2) return;
    waiting = setTimeout(async () => {
      const r = await optional(api(`/v1/instruments/search?q=${encodeURIComponent(q)}&limit=8`));
      const rows = r.data?.data ?? [];
      if (symbol.value.trim() !== q || !rows.length) return;
      known = new Map(rows.map((x) => [x.symbol, x]));
      matches.replaceChildren(...rows.map((x) => h("option", { value: x.symbol }, x.name ?? "")));
    }, SEARCH_WAIT_MS);
  };
  symbol.addEventListener("input", () => (search(), known.has(symbol.value.trim().toUpperCase()) ? showSymbol() : null));
  symbol.addEventListener("change", showSymbol);
  size.addEventListener("input", showSize);
  account.addEventListener("change", showMode);
  for (const seg of [orderType, product, mode]) seg.addEventListener("click", () => (showType(), showMode()));
  for (const seg of [orderType, product, mode]) seg.addEventListener("keydown", () => queueMicrotask(() => (showType(), showMode())));

  const read = () =>
    buildTicketOrder({ account: account.value, symbol: symbol.value, side: side.value, size: size.value, lotSize, product: product.value, orderType: orderType.value, price: price.value, trigger: trigger.value, validity: validity.value, mode: mode.value, tag: tag.value });
  const refused = (e) => {
    const f = refusedField(e?.body?.errors);
    if (f) return mark(f.field, f.message);
    say(plainBrokerMessage(String(e?.message ?? "The Bridge did not accept this order.")));
    return false;
  };
  /** Ask the Bridge what it would do with this order, and list every warning and block. Places nothing. */
  const check = async () => {
    say("");
    const o = read();
    if (o.error) return mark(o.error.field, o.error.message);
    let data;
    try {
      data = (await api("/v1/orders/preview", { method: "POST", body: o.body })).data?.data;
    } catch (e) {
      return refused(e);
    }
    const rows = (data?.checks ?? []).map((c) => h("p", { class: c?.severity === "block" ? "tk-check block" : "tk-check" }, h("strong", {}, c?.severity === "block" ? "Blocked: " : "Note: "), String(c?.message ?? c?.code ?? "")));
    const facts = [
      data?.ltp ? `Last price ${formatFixed(data.ltp, 2)}` : null,
      data?.estimatedValue ? `Order value ₹${formatInt(Math.round(data.estimatedValue))}` : null,
      data?.margin?.required ? `Margin needed ₹${formatInt(Math.round(data.margin.required))}` : null,
    ].filter(Boolean);
    checks.replaceChildren(
      ...[
        h("p", { class: data?.ok ? "tk-check ok" : "tk-check block" }, h("strong", {}, data?.ok ? "Ready to place. " : "Not ready. "), data?.ok ? ticketSummary(o.body) : "Fix what is listed below."),
        facts.length ? h("p", { class: "tk-check" }, facts.join(" · ")) : null,
        ...rows,
      ].filter(Boolean),
    );
    checks.scrollIntoView({ block: "nearest" });
    return false;
  };
  const place = async () => {
    say("");
    const o = read();
    if (o.error) return mark(o.error.field, o.error.message);
    let placed;
    try {
      // The same order pressed twice is one order: the key is the same for the same ticket contents.
      placed = (await api("/v1/orders", { method: "POST", body: o.body, idempotencyKey: keys.keyFor(o.body) })).data?.data;
    } catch (e) {
      return refused(e);
    }
    // The Bridge took it but the broker (or the paper engine) turned it down: say why and keep the ticket open.
    if (placed?.status === "rejected") {
      if (onPlaced) onPlaced();
      say(`Rejected: ${plainBrokerMessage(String(placed.statusMessage ?? "the order was not accepted."))}`);
      return false;
    }
    toast(`Placed: ${ticketSummary(o.body)}`);
    return true;
  };

  showSize();
  showType();
  showMode();
  if (firstSymbol) showSymbol();
  // A check result describes the order as it was; any change to the ticket takes it away.
  const stale = () => (checks.replaceChildren(), say(""));
  const form = h("div", { class: "tk-form stack", oninput: stale });
  for (const seg of [side, product, orderType, validity, mode]) seg.addEventListener("click", stale);
  account.addEventListener("change", stale);
  form.append(
      segField("Side", side, { wide: true }),
      h("div", { class: "form-grid bk-pair" }, field("Account", account), h("label", { class: "field", for: "tk-symbol" }, h("span", {}, "Symbol"), symbol, about)),
      matches,
      h("div", { class: "form-grid bk-pair" }, h("label", { class: "field", for: "tk-size" }, sizeName, size, sizeHint), segField("Validity", validity)),
      h("div", { class: "tk-group" }, segField("Product", product, { wide: true }), productHint),
      h("div", { class: "tk-group" }, segField("Order type", orderType, { wide: true }), typeHint),
      prices,
      h("div", { class: "form-grid bk-pair" }, modeField, field("Tag", tag)),
      modeHint,
  );
  const ok = await modal({
    title: "New order",
    body: h(
      "div",
      { class: "stack tk" },
      form,
      checks,
      err,
    ),
    buttons: [
      { label: "Close", value: false },
      { label: "Check order", onClick: check },
      { label: "Place order", cls: "primary", onClick: place },
    ],
  });
  if (ok && onPlaced) onPlaced();
  return ok;
}
