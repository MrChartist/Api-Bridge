// Order defaults and 1-Tap instant trade (the UI). The rules live in one-tap-core.js (pure, tested).
//
// How 1-Tap is guarded (every one of these, every time):
//  1. OFF on every page load: its state lives in this module's memory only, never in storage.
//  2. Switching it on is a sheet, never a single key: Ctrl+Alt+1 or the toolbar capsule opens it; the person picks the
//     account and Paper or Live. Live is offered only for an account the config file allows live orders on, and needs
//     the "each tap sends a real order" box ticked. Paper is the default.
//  3. It turns itself off after 30 minutes without a key press or a click, and when its account stops being usable.
//  4. Each tap re-reads the accounts, then POSTs /v1/orders/preview with the same body the ticket would send; any
//     blocking check (kill switch, limits, live opt-ins, market hours…) stops it with the Bridge's reason. On a live
//     1-Tap a readiness or safety warning also stops it and opens the ticket. A lot size that needs a check, a missing
//     bid / ask for a limit, and every exit open the ticket instead.
//  5. Then POST /v1/orders: the same route, so the Bridge applies every gate again (kill switch, limits, readiness,
//     live opt-ins: config, account, key scope, source). One order in flight at a time; an unknown outcome is looked up
//     by its client order id and never resent.
//  6. The toolbar capsule says "1-Tap ON", the account and Paper / LIVE while it is on, on every page.
import { DEMO_EXPLAINER, api, app, h, icon, modal, optional, sheetPopover, toast } from "./app.js";
import { formatFixed, formatInt } from "./format.js";
import { segmented, segField } from "./views.js";
import { lotStaleCheck } from "./reference.js";
import { parseOptionSymbol } from "./options.js";
import {
  BASE_DEFAULTS,
  DEFAULTS_SLOT,
  MAX_DEFAULT_LOTS,
  MAX_OFFSET_TICKS,
  ORDER_TYPES,
  PRODUCTS,
  VALIDITIES,
  armOneTap,
  cancellable,
  capsuleText,
  defaultsSummary,
  isOneTapKey,
  liveCapable,
  normalizeDefaults,
  oneTapBody,
  oneTapEligibility,
  oneTapExpired,
  oneTapMinutesLeft,
  oneTapVerdict,
  readDefaults,
  touchOneTap,
} from "./one-tap-core.js";

/** The underlyings the defaults sheet lists lots for (desk.js UNDERLYINGS; repeated here so this module stays light). */
const LOT_UNDERLYINGS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"];
/** desk.js TRADE_HANDOFF_SLOT: a trade handed to the chain (it opens the ticket there, never sends). */
const TRADE_HANDOFF_SLOT = "mcb.dashboard.tradeHandoff";
/** Pages where the capsule shows while 1-Tap is off (it shows everywhere while it is on). */
const TRADE_PAGES = new Set(["chain", "positions"]);

let state = null; // 1-Tap: null (off) or one-tap-core armOneTap's state. Memory only.
let busy = false;
const listeners = new Set();

// ── Order defaults ──

/** The saved order defaults (validated; a fresh browser gets BASE_DEFAULTS). */
export function orderDefaults() {
  return readDefaults(app.local.get(DEFAULTS_SLOT));
}
function saveDefaults(d) {
  app.local.set(DEFAULTS_SLOT, JSON.stringify(normalizeDefaults(d).defaults));
  emit();
}

/** Accounts that can place orders from the dashboard (desk.js `tradable`). */
async function tradableAccounts(fresh = false) {
  const r = await optional(api("/v1/accounts", { fresh }));
  return (r.data?.data ?? []).filter((a) => a.enabled && (a.capabilities ?? []).includes("placeOrder"));
}

/** A small − n + stepper over a number input (whole numbers between lo and hi). */
function stepper(label, value, lo, hi, { placeholder = "" } = {}) {
  const input = h("input", { type: "number", min: String(lo), max: String(hi), step: "1", inputmode: "numeric", "aria-label": label, placeholder, value: value === null || value === undefined ? "" : String(value) });
  const bump = (d) => {
    const n = Number(input.value);
    const base = Number.isFinite(n) && input.value !== "" ? n : d > 0 ? lo - 1 : lo;
    input.value = String(Math.max(lo, Math.min(hi, Math.round(base) + d)));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const el = h("div", { class: "bk-stepper" }, h("button", { type: "button", class: "plain bk-step-btn", "aria-label": `${label}: one less`, onclick: () => bump(-1) }, "−"), input, h("button", { type: "button", class: "plain bk-step-btn", "aria-label": `${label}: one more`, onclick: () => bump(1) }, "+"));
  return { el, input };
}

/** The order defaults sheet: product, lots per underlying, order type and limit offset, validity, account. */
export async function openOrderDefaults() {
  const d = orderDefaults();
  const accounts = await tradableAccounts();
  const prod = segmented("Product", PRODUCTS, d.product);
  const type = segmented("Order type", ORDER_TYPES, d.orderType);
  const val = segmented("Validity", VALIDITIES, d.validity);
  const off = stepper("Limit offset in ticks", d.offsetTicks, -MAX_OFFSET_TICKS, MAX_OFFSET_TICKS);
  const offHint = h("p", { class: "hint od-hint" });
  const any = stepper("Lots, any underlying", d.anyLots, 1, MAX_DEFAULT_LOTS);
  const per = LOT_UNDERLYINGS.map((u) => ({ u, s: stepper(`Lots for ${u}`, d.lots[u] ?? null, 1, MAX_DEFAULT_LOTS, { placeholder: "Same" }) }));
  const acct = h("select", { "aria-label": "Account" }, h("option", { value: "" }, "The page's own account"), accounts.map((a) => h("option", { value: a.id, selected: a.id === d.account }, a.label)));
  const problem = h("p", { class: "hint bad-text", role: "alert", hidden: true });
  const read = () => {
    const lots = {};
    for (const { u, s } of per) if (s.input.value !== "") lots[u] = Number(s.input.value);
    return { product: prod.value, orderType: type.value, validity: val.value, offsetTicks: off.input.value === "" ? 0 : Number(off.input.value), anyLots: Number(any.input.value), lots, account: acct.value };
  };
  const sync = () => {
    const limit = type.value === "LIMIT";
    offField.hidden = !limit;
    const n = Number(off.input.value) || 0;
    offHint.textContent = n === 0 ? "At the touch: the ask to buy, the bid to sell." : n > 0 ? `${formatInt(n)} tick${n === 1 ? "" : "s"} past the touch: pays up to buy, gives down to sell, so it fills more readily.` : `${formatInt(-n)} tick${n === -1 ? "" : "s"} inside the touch: waits in the spread for a better price, and may not fill.`;
    const { problems } = normalizeDefaults(read());
    problem.hidden = !problems.length;
    problem.textContent = problems[0]?.message ?? "";
    return !problems.length;
  };
  const offField = h("div", { class: "field" }, h("span", {}, "Limit price"), off.el, offHint);
  const body = h(
    "div",
    { class: "stack od-sheet" },
    h("p", { class: "muted small" }, "Saved in this browser. Every order ticket opens with these, and 1-Tap sends them as they are. The ticket can still change anything before you place."),
    h("div", { class: "ticket-grid" }, segField("Product", prod), segField("Validity", val)),
    segField("Order type", type),
    offField,
    h("div", { class: "field" }, h("span", {}, "Lots"), h("div", { class: "od-lots" }, h("label", { class: "od-lot" }, h("span", {}, "Any underlying"), any.el), per.map(({ u, s }) => h("label", { class: "od-lot" }, h("span", {}, u), s.el)))),
    h("label", { class: "field" }, h("span", {}, "Account"), acct, h("span", { class: "hint" }, "The Options pages open on this account, and 1-Tap starts on it.")),
    problem,
  );
  for (const el of [prod, type, val]) el.addEventListener("change", sync);
  body.addEventListener("input", sync);
  sync();
  const r = await modal({
    title: "Order defaults",
    body,
    buttons: [
      { label: "Reset", cls: "plain", onClick: () => (saveDefaults(BASE_DEFAULTS), toast("Order defaults reset"), "reset") },
      { label: "Cancel", value: false },
      { label: "Save", cls: "primary", onClick: () => (sync() ? (saveDefaults(read()), "saved") : false) },
    ],
  });
  if (r === "saved") toast(`Order defaults saved: ${defaultsSummary(orderDefaults())}`);
  return r;
}

// ── 1-Tap state ──

function emit() {
  document.documentElement.dataset.oneTap = state?.on ? state.mode : "";
  for (const f of listeners) f(state);
}
/** Call fn(state) whenever 1-Tap or the defaults change. */
export function onOneTapChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
/** 1-Tap is on (and not idle past its limit; an expired one is switched off here, with a note). */
export function oneTapOn() {
  if (state?.on && oneTapExpired(state, Date.now())) turnOff("1-Tap is off: 30 minutes without a key press or a click.");
  return Boolean(state?.on);
}
export const oneTapState = () => state;
function turnOff(note = "1-Tap is off. Buy and sell open the ticket again.") {
  if (!state) return;
  state = null;
  emit();
  toast(note, { tone: "info" });
}

/** The switch: off → the sheet that turns it on; on → off at once. */
export function toggleOneTap() {
  if (oneTapOn()) return turnOff();
  return openArmSheet();
}

/** Switching 1-Tap on: account, Paper / Live, the defaults it will send, and what turns it off. */
async function openArmSheet() {
  if (document.getElementById("dialog")?.open) return toast("Close the open sheet first, then switch 1-Tap on.", { tone: "info" });
  const accounts = await tradableAccounts(true);
  if (!accounts.length) return toast("No account can place orders yet: connect one on Accounts.", { tone: "info" });
  const d = orderDefaults();
  const startId = accounts.some((a) => a.id === d.account) ? d.account : (accounts.find((a) => a.broker === "paper") ?? accounts[0]).id;
  const sel = h("select", { "aria-label": "Account" }, accounts.map((a) => h("option", { value: a.id, selected: a.id === startId }, a.label)));
  const modeHost = h("div", { class: "field" });
  const ack = h("input", { type: "checkbox" });
  const ackRow = h("label", { class: "check live-ack", hidden: true }, ack, h("span", { class: "ack-text" }));
  const sum = h("p", { class: "od-sum" });
  let modeSeg = null;
  let onBtn = null;
  const acc = () => accounts.find((a) => a.id === sel.value) ?? null;
  const live = () => modeSeg?.value === "live";
  const draw = () => {
    const a = acc();
    modeSeg = liveCapable(a) ? segmented("Mode", [["paper", "Paper"], ["live", "Live"]], modeSeg?.value ?? "paper") : null;
    modeSeg?.addEventListener("change", redraw);
    modeHost.replaceChildren(h("span", {}, "Mode"), modeSeg ?? h("span", { class: "ticket-acct" }, "Paper", h("span", { class: "muted small" }, " · this account has no live orders")));
    redraw();
  };
  const redraw = () => {
    const a = acc();
    ackRow.hidden = !live();
    ackRow.querySelector(".ack-text").textContent = `I understand each tap sends a real order to ${a?.label ?? "this account"} at once, with no ticket.`;
    if (!live()) ack.checked = false;
    if (onBtn) {
      onBtn.disabled = live() && !ack.checked;
      onBtn.textContent = live() ? "Turn on 1-Tap · LIVE" : "Turn on 1-Tap";
    }
  };
  sel.addEventListener("change", draw);
  ack.addEventListener("change", redraw);
  const d0 = orderDefaults();
  sum.replaceChildren(h("strong", {}, "Sends: "), `${defaultsSummary(d0)} · ${formatInt(d0.anyLots)} lot${d0.anyLots === 1 ? "" : "s"}${Object.keys(d0.lots).length ? " (or each underlying's own)" : ""}`);
  draw();
  const body = h(
    "div",
    { class: "stack od-sheet" },
    h("p", {}, "With 1-Tap on, a tap on a bid or ask in the chain, and Shift+B / Shift+S on a focused contract, send the order at once with your order defaults. No ticket."),
    h("label", { class: "field" }, h("span", {}, "Orders go to"), sel),
    modeHost,
    ackRow,
    h("div", { class: "od-box" }, sum, h("button", { type: "button", class: "small plain", onclick: () => { closeSheet?.(undefined, true); setTimeout(() => openOrderDefaults(), 280); } }, icon("sliders"), "Edit order defaults")),
    h(
      "ul",
      { class: "od-rules" },
      h("li", {}, "Every order still goes through the Bridge's checks: the kill switch, your limits, readiness and the live opt-ins."),
      h("li", {}, "Exits, a lot size that needs a check, or a missing bid / ask open the ticket instead."),
      h("li", {}, "It turns itself off when the page reloads and after 30 minutes without a key press or a click. Ctrl+Alt+1 switches it off at once."),
      app.state.demo ? h("li", {}, `Demo: ${DEMO_EXPLAINER}`) : null,
    ),
  );
  let closeSheet = null;
  const r = await modal({
    title: "1-Tap instant trade",
    body: (close) => ((closeSheet = close), body),
    buttons: [
      { label: "Cancel", value: false },
      {
        label: "Turn on 1-Tap",
        cls: "primary",
        ref: (el) => ((onBtn = el), redraw()),
        onClick: () => {
          const res = armOneTap({ account: acc(), mode: live() ? "live" : "paper", ack: ack.checked, nowMs: Date.now() });
          if (!res.ok) return toast(res.reason, { tone: "warn" }), false;
          state = res.state;
          emit();
          return "on";
        },
      },
    ],
  });
  if (r === "on") toast(`1-Tap is ON: ${state.mode === "live" ? "LIVE orders" : "paper orders"} to ${state.accountLabel}`, { tone: state.mode === "live" ? "warn" : "ok" });
}

// ── Sending ──

/**
 * Send one order at once with the defaults (1-Tap on). The desk passes what it knows of the contract; `openTicket`
 * opens the ticket for it (the fallback whenever a person should look first). Resolves "placed", "ticket" or "refused".
 * @param {{ symbol: string, side: "BUY"|"SELL", underlying: string, quote: object|null, tick?: number, name: string,
 *   lotCheckNeeded?: boolean, exit?: boolean, openTicket: () => unknown, onPlaced?: () => void }} o
 */
export async function sendOneTap(o) {
  const now = Date.now();
  if (state?.on && oneTapExpired(state, now)) turnOff("1-Tap is off: 30 minutes without a key press or a click.");
  if (busy) return toast("The last 1-Tap order is still going out.", { tone: "info" }), "refused";
  busy = true;
  try {
    const defaults = orderDefaults();
    const accounts = await tradableAccounts(true);
    const ok = oneTapEligibility({ state, nowMs: now, accounts, exit: Boolean(o.exit), orderable: Boolean(o.symbol), lotCheckNeeded: Boolean(o.lotCheckNeeded), quote: o.quote, defaults, side: o.side });
    if (!ok.ok) {
      if (ok.code === "ACCOUNT" || ok.code === "LIVE_OFF") turnOff(ok.reason);
      else if (ok.code !== "OFF" && ok.code !== "EXIT") toast(ok.reason, { tone: "info" });
      if (ok.ticket) o.openTicket();
      return ok.ticket ? "ticket" : "refused";
    }
    const armed = state;
    const body = oneTapBody({ state: armed, defaults, symbol: o.symbol, side: o.side, underlying: o.underlying, quote: o.quote, tick: o.tick });
    // The same preview the ticket shows: the Bridge's checks decide before anything is sent.
    let pv;
    try {
      pv = (await api("/v1/orders/preview", { method: "POST", body })).data.data;
    } catch (err) {
      toast(`1-Tap sent nothing: ${err?.message ?? "the preview failed"}`, { tone: "error" });
      return "refused";
    }
    if (lotStaleCheck(pv?.checks)) {
      toast("The lot size needs a check first: opening the ticket.", { tone: "info" });
      o.openTicket();
      return "ticket";
    }
    const v = oneTapVerdict(pv?.checks, armed.mode);
    if (!v.ok) {
      toast(`1-Tap sent nothing: ${v.reason}`, { tone: v.ticket ? "warn" : "error" });
      if (v.ticket) o.openTicket();
      return v.ticket ? "ticket" : "refused";
    }
    // Still on, still the same switch-on (a toggle while the preview was out cancels the tap).
    if (!state?.on || state.armedAt !== armed.armedAt || state.accountId !== armed.accountId || state.mode !== armed.mode) return toast("1-Tap changed while the order was being checked: nothing was sent.", { tone: "info" }), "refused";
    const clientOrderId = `1tap-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    let order = null;
    try {
      order = (await api("/v1/orders", { method: "POST", body: { ...body, clientOrderId, tag: "mcb1tap" } })).data.data;
    } catch (err) {
      if (err?.network || err?.code === "OUTCOME_UNKNOWN" || err?.status >= 500) {
        const found = await optional(api(`/v1/orders/by-client-id/${encodeURIComponent(clientOrderId)}`));
        order = found.data?.data ?? null;
        if (!order) {
          toast("1-Tap: the outcome is unknown. Check the order book before trying again.", { tone: "error" });
          return "refused";
        }
      } else {
        toast(`1-Tap refused: ${err?.message ?? "the Bridge refused the order"}`, { tone: "error" });
        return "refused";
      }
    }
    notePlaced(order, o.name, v.warns);
    o.onPlaced?.();
    return order.status === "rejected" || order.status === "cancelled" ? "refused" : "placed";
  } finally {
    busy = false;
  }
}

/** The toast after a 1-Tap order: what happened, in which mode, and Cancel while a limit order is still working. */
function notePlaced(r, name, warns = []) {
  const refused = r.status === "rejected" || r.status === "cancelled";
  const what = `${r.status === "filled" ? "Filled" : r.status === "rejected" ? "Rejected" : r.status === "cancelled" ? "Cancelled" : "Placed"}: ${r.side === "BUY" ? "Buy" : "Sell"} ${formatInt(r.quantity)} ${name}${Number.isFinite(Number(r.avgPrice)) && r.avgPrice !== null ? ` @ ${formatFixed(r.avgPrice, 2)}` : Number.isFinite(Number(r.price)) && r.price !== null ? ` at ${formatFixed(r.price, 2)}` : ""} · ${r.mode === "live" ? "LIVE" : "paper"} · 1-Tap${refused && r.statusMessage ? `. ${r.statusMessage}` : ""}${warns.length ? `. Note: ${warns[0]}` : ""}`;
  if (!cancellable(r)) return toast(what, { tone: refused ? "error" : "ok" });
  const cancel = h("button", { type: "button", class: "toast-undo", onclick: async () => {
    cancel.disabled = true;
    const res = await optional(api(`/v1/orders/${encodeURIComponent(r.orderId)}`, { method: "DELETE" }));
    toast(res.error ? `Could not cancel: ${res.error.message ?? "refused"}` : `Cancelled: ${r.side === "BUY" ? "buy" : "sell"} ${name}`, { tone: res.error ? "error" : "info" });
  } }, "Cancel");
  toast(h("span", { class: "toast-undo-row" }, `${what} · `, cancel), { tone: "ok", ms: 9000 });
}

// ── The toolbar capsule ──

let capsule = null;
/** Mount the capsule into the toolbar slot (once) and wire Ctrl+Alt+1, the idle timer and Shift+B / S handoffs. */
export function mountOneTap(slot) {
  if (!slot || slot.dataset.ready) return;
  slot.dataset.ready = "1";
  // "1-Tap ON · Paper" (or "· LIVE"), and on the Options pages' full bar the short form: the bolt and "ON" in amber for
  // paper, "LIVE" in red (no words at all while off; the label, tooltip and sheet say the rest).
  const full = document.createTextNode("1-Tap");
  const short = h("span", { class: "onetap-short" });
  const sub = h("span", { class: "onetap-sub" });
  const flag = h("span", { class: "onetap-flag" }, icon("bolt"), h("span", { class: "onetap-main" }, full), short);
  capsule = h("button", { type: "button", class: "toolbar-onetap", "aria-keyshortcuts": "Control+Alt+1", "aria-haspopup": "dialog", onclick: () => (oneTapOn() ? statusPop() : openArmSheet()) }, flag, sub);
  slot.append(capsule);
  const draw = () => {
    const on = oneTapOn();
    const t = capsuleText(state);
    full.data = t.main;
    short.textContent = on ? (state.mode === "live" ? "LIVE" : "ON") : "";
    sub.textContent = t.sub;
    capsule.dataset.on = on ? state.mode : "";
    capsule.title = on ? `1-Tap is ON: buy and sell send at once (${state.mode === "live" ? "LIVE" : "paper"}, ${state.accountLabel}). Click for details; Ctrl+Alt+1 turns it off.` : "1-Tap instant trade is off: buy and sell open the ticket. Click or press Ctrl+Alt+1 to switch it on.";
    capsule.setAttribute("aria-label", on ? `1-Tap on, ${state.mode === "live" ? "live" : "paper"} orders to ${state.accountLabel}` : "1-Tap instant trade, off");
    slot.hidden = !on && !TRADE_PAGES.has(document.documentElement.dataset.page ?? "");
  };
  onOneTapChange(draw);
  new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ["data-page"] });
  draw();
  // Activity keeps 1-Tap alive; a check every 20 s switches it off when idle (and again before every send).
  const alive = () => state?.on && (state = touchOneTap(state, Date.now()));
  document.addEventListener("pointerdown", alive, { capture: true, passive: true });
  document.addEventListener("keydown", alive, { capture: true, passive: true });
  setInterval(() => state?.on && oneTapOn(), 20_000);
  document.addEventListener("keydown", (e) => {
    if (!isOneTapKey(e) || e.repeat) return;
    e.preventDefault();
    toggleOneTap();
  });
  // Shift+B / Shift+S over an element that names a contract (data-trade-symbol, e.g. a chart) on a page that did not
  // handle the key itself: openTicketFor (the ticket over an Options page that lists it, else the chain with it filled in).
  addEventListener("keydown", (e) => {
    if (e.defaultPrevented || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.repeat || !/^[bs]$/i.test(e.key)) return;
    const t = /** @type {HTMLElement|null} */ (e.target instanceof HTMLElement ? e.target : null);
    if (!t || t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || document.querySelector("dialog[open]")) return;
    const sym = t.closest("[data-trade-symbol]")?.getAttribute("data-trade-symbol");
    if (!parseOptionSymbol(sym)) return;
    e.preventDefault();
    openTicketFor(sym, e.key.toLowerCase() === "b" ? "BUY" : "SELL");
  });
}

let ticketHost = null;
/**
 * The Options page on screen registers here (desk.js): `fn(symbol, side)` opens that contract's ticket in place (or
 * sends it with 1-Tap on) and returns true, or false when the contract is not on its chain. Returns an unregister.
 */
export function registerTicketHost(fn) {
  ticketHost = fn;
  return () => {
    if (ticketHost === fn) ticketHost = null;
  };
}
/**
 * Buy or sell a contract ("NFO:NIFTY-2026-11-03-26000-CE") from any page: on an Options page whose chain lists it, the
 * ticket opens over the page (1-Tap: sent at once, with every check); elsewhere the chain opens with the ticket filled
 * in (never sent). Returns false for a symbol that is not an option contract.
 */
export function openTicketFor(symbol, side) {
  const s = side === "SELL" ? "SELL" : "BUY";
  if (ticketHost?.(symbol, s)) return true;
  const o = parseOptionSymbol(symbol);
  if (!o) return false;
  handToChain(o, s);
  return true;
}

/** Open the chain on a contract with its ticket filled in (desk.js reads TRADE_HANDOFF_SLOT once). */
function handToChain(o, side) {
  const d = orderDefaults();
  app.local.set(TRADE_HANDOFF_SLOT, JSON.stringify({ underlying: o.underlying, expiry: o.expiry, jump: { underlying: o.underlying, expiry: o.expiry, strike: o.strike, side: o.right === "PE" ? "pe" : "ce" }, ticket: { strike: o.strike, right: o.right, side, lots: d.lots[o.underlying] ?? d.anyLots } }));
  location.hash = location.hash.split("?")[0] === "#/chain" ? `#/chain?trade=${Date.now().toString(36)}` : "#/chain";
}

/** The capsule's popover while 1-Tap is on: what it sends, where, until when; Turn off; Order defaults. */
function statusPop() {
  const s = state;
  const d = orderDefaults();
  const left = oneTapMinutesLeft(s, Date.now());
  const pop = sheetPopover({
    trigger: capsule,
    title: "1-Tap is on",
    cls: "onetap-pop",
    body: h(
      "div",
      { class: "stack onetap-pop-body" },
      h("p", { class: `onetap-pop-mode${s.mode === "live" ? " live" : ""}` }, s.mode === "live" ? "LIVE orders" : "Paper orders", h("span", { class: "muted" }, ` to ${s.accountLabel}`)),
      h("p", { class: "muted small" }, `${defaultsSummary(d)} · ${formatInt(d.anyLots)} lot${d.anyLots === 1 ? "" : "s"}${Object.keys(d.lots).length ? " (or each underlying's own)" : ""}`),
      h("p", { class: "muted small" }, `Turns itself off after ${formatInt(left)} more minute${left === 1 ? "" : "s"} without a key press or a click, and on reload.`),
      h(
        "div",
        { class: "onetap-pop-acts" },
        h("button", { type: "button", class: "primary", onclick: () => (pop.close(), turnOff()) }, "Turn off 1-Tap"),
        h("button", { type: "button", class: "small plain", onclick: () => (pop.close(), openOrderDefaults()) }, icon("sliders"), "Order defaults"),
      ),
    ),
  });
}
