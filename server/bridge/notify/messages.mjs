/**
 * What the messages say. Pure functions: payload in, short plain text out. Rules:
 *  - plain text, a sentence or two, no markup (nothing to escape, nothing to mis-render);
 *  - money as rupees with Indian digit grouping, symbols without the exchange prefix when that is unambiguous;
 *  - an order whose result is not known is "unknown, check your broker", never "failed";
 *  - a ticket message tells the person to approve ON THIS COMPUTER and carries no token, link or id that could be used;
 *  - third-party text (a broker's rejection reason) is clipped and cleaned, never interpreted;
 *  - scrub() runs on every message before it is queued, so a secret that slipped into a payload still never leaves.
 */
import { formatEvent } from "./format.mjs";

const inr = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr0 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const qtyFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 4 });

/** "₹2,431.50", "-₹1,200.00" (a loss is shown with a minus sign, never in brackets). */
export function money(v, { whole = false } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "n/a";
  const s = (whole ? inr0 : inr).format(Math.abs(n));
  return `${n < 0 ? "-" : ""}₹${s}`;
}

/** "+₹310.00" / "-₹90.00" for profit and loss. */
export function pnl(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "n/a";
  return `${n > 0 ? "+" : ""}${money(n)}`;
}

export const qty = (v) => (Number.isFinite(Number(v)) ? qtyFmt.format(Number(v)) : "?");

/** "NSE:RELIANCE" -> "RELIANCE"; "NFO:NIFTY-2026-11-26-24500-CE" -> "NIFTY 26 Nov 24500 CE"; other text is cleaned and clipped. */
export function displaySymbol(sym) {
  const s = String(sym ?? "");
  const opt = /^(?:NFO|BFO|MCX|CDS):([A-Z0-9&_]+)-(\d{4})-(\d{2})-(\d{2})-(?:(\d+(?:\.\d+)?)-(CE|PE)|FUT)$/.exec(s);
  if (opt) {
    const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(opt[3]) - 1] ?? opt[3];
    return opt[5] ? `${opt[1]} ${Number(opt[4])} ${mon} ${opt[5]} ${opt[6]}` : `${opt[1]} ${Number(opt[4])} ${mon} FUT`;
  }
  return clip(s.replace(/^(NSE|BSE):/, ""), 40);
}

const CTRL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;
/** Third-party text: control and direction characters out, one line, clipped. */
export function clip(text, n = 120) {
  const t = String(text ?? "").replace(CTRL, " ").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

const SECRET_PATTERNS = [
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, // a Telegram bot token
  /\bmc[bt]_[A-Za-z0-9_-]{6,}/g, // Bridge API keys, stream tokens and order confirm tokens
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, // a JWT
  /\/hooks\/[a-z]+\/[A-Za-z0-9_-]{16,}/g, // a webhook URL carries its secret token
];

/** Remove anything that looks like a secret. Applied to every message; plus the logger's exact registered secrets when given. */
export function scrub(text, exact) {
  let t = String(text ?? "");
  for (const re of SECRET_PATTERNS) t = t.replace(re, "[hidden]");
  return typeof exact === "function" ? String(exact(t)).replace(/\[redacted\]/g, "[hidden]") : t;
}

const WHO = (by) => {
  const s = String(by ?? "");
  if (/^telegram:/.test(s) || s === "key:telegram") return "Telegram";
  if (/^local:/.test(s)) return "the command line";
  if (/^key:/.test(s)) return "an API key";
  if (/^hook:/.test(s)) return "a webhook";
  if (/^guard:/.test(s)) return "a rule";
  return s ? clip(s, 40) : "someone";
};

const modeWord = (mode) => (mode === "live" ? "live" : "paper");

/** "Zerodha Main (live)" style label of an account for a message. */
const acct = (h, id) => clip(h.accountLabel?.(id) ?? id ?? "an account", 50);

const orderLine = (o) => {
  const side = o?.side ? String(o.side).toUpperCase() : "";
  const sym = o?.symbol ? displaySymbol(o.symbol) : "";
  const q = o?.quantity ? qty(o.quantity) : "";
  return [side, q, sym].filter(Boolean).join(" ");
};

/**
 * @typedef {{ key: string, text: string, group: string, accountId?: string, dedupe?: string }} Composed
 * @typedef {{ accountLabel?: (id: string) => string }} Helpers
 */

/** order.updated -> a message for "filled", "rejected" or "placed" (the caller decides which transition this is). */
export function orderMessage(kind, p, order, h = {}) {
  const line = orderLine(order);
  const where = `${modeWord(p.mode)}, ${acct(h, p.accountId)}`;
  if (kind === "filled") {
    const px = Number.isFinite(Number(p.avgPrice)) ? ` at ${money(p.avgPrice)}` : "";
    return { key: "order.filled", group: "order.filled", accountId: p.accountId, text: line ? `Filled: ${line}${px} (${where}).` : `An order was filled${px} (${where}).` };
  }
  if (kind === "rejected") {
    const why = clip(order?.statusMessage ?? p.brokerStatus ?? "", 120);
    return { key: "order.rejected", group: "order.rejected", accountId: p.accountId, text: `Order rejected${line ? `: ${line}` : ""} (${where}).${why ? ` Reason: ${why}.` : ""}` };
  }
  return { key: "order.placed", group: "order.placed", accountId: p.accountId, text: line ? `Order placed: ${line} (${where}).` : `An order was placed (${where}).` };
}

export function unknownOutcomeMessage(p, order, h = {}) {
  const line = orderLine(order);
  return { key: "order.outcome_unknown", group: "order.outcome_unknown", accountId: p.accountId, text: `Order result unknown${line ? `: ${line}` : ""} on ${acct(h, p.accountId)}. The broker did not confirm it: check your broker. Do not send it again; the Bridge is checking the order book.` };
}

export function ticketMessage(p, h = {}) {
  const line = orderLine({ side: p.side, quantity: p.quantity, symbol: p.symbol });
  const value = Number.isFinite(Number(p.estimatedValue)) ? ` (about ${money(p.estimatedValue, { whole: true })})` : "";
  return {
    key: "ticket.prepared",
    group: "ticket.prepared",
    accountId: p.accountId,
    text: `An order is waiting for your approval: ${line || "an order"}${value} on ${acct(h, p.accountId)}. Approve it ON THIS COMPUTER, in the Bridge dashboard, within about a minute. It cannot be approved from Telegram.`,
  };
}

export function killSwitchMessage(p) {
  if (p?.engaged) {
    const why = clip(p.reason ?? "", 100);
    return { key: "kill_switch.engaged", group: "kill_switch", text: `Kill switch ON (by ${WHO(p.by)})${why ? `: ${why}` : ""}. New orders are blocked until you release it on this computer.` };
  }
  return { key: "kill_switch.released", group: "kill_switch", text: "Kill switch OFF. Orders can be sent again." };
}

export function sessionMessage(p, h = {}) {
  const name = acct(h, p.accountId);
  const why = p.session === "error" ? "has a problem with its login" : "is logged out";
  return { key: "session.expired", group: `session:${p.accountId}`, accountId: p.accountId, dedupe: `session:${p.accountId}:${p.session}`, text: `${name} ${why}. Log in again on this computer, or prices and orders from it stop.` };
}

export function readinessMessage(p, h = {}) {
  const { title, text } = formatEvent("trading.readiness", { ...p, accountId: p.accountId });
  return { key: "readiness.changed", group: `readiness:${p.accountId ?? "all"}`, accountId: p.accountId, text: clip(`${title}${text ? `. ${text}` : "."}`, 500) };
}

const HOOK_WORDS = {
  rejected: ["hook.rejected", "A webhook alert was rejected"],
  stale: ["hook.stale", "A webhook alert arrived too late and was dropped"],
  failed: ["hook.failed", "A webhook alert was accepted but its order failed"],
};
/** hook.rejected / hook.stale / hook.failed. Payload fields (all optional): label, hookId, source, reason or message, symbol, side. */
export function hookMessage(kind, p) {
  const [key, head] = HOOK_WORDS[kind];
  const who = p?.label ? ` on "${clip(p.label, 40)}"` : p?.source ? ` from ${clip(p.source, 20)}` : "";
  const what = [p?.side ? String(p.side).toUpperCase() : "", p?.symbol ? displaySymbol(p.symbol) : ""].filter(Boolean).join(" ");
  const why = clip(p?.reason ?? p?.message ?? "", 140);
  return { key, group: `${key}:${p?.hookId ?? p?.label ?? ""}`, text: `${head}${who}${what ? ` (${what})` : ""}.${why ? ` Reason: ${why}.` : ""}` };
}

export function limitMessage(p, h = {}) {
  const name = acct(h, p.accountId);
  if (p.limit === "dailyMaxLoss") return { key: "limit.reached", group: `limit:${p.accountId}`, accountId: p.accountId, text: `Daily loss limit reached on ${name}: ${money(Math.abs(Number(p.value)), { whole: true })} against a limit of ${money(p.threshold, { whole: true })}. New orders on it are blocked for today.` };
  if (p.limit === "dailyMaxOrders") return { key: "limit.reached", group: `limit:${p.accountId}`, accountId: p.accountId, text: `Daily order limit reached on ${name}: ${qty(p.value)} orders (limit ${qty(p.threshold)}). New orders on it are blocked for today.` };
  return { key: "limit.reached", group: `limit:${p.accountId}`, accountId: p.accountId, text: `A safety limit was reached on ${name} (${clip(p.limit, 30)}).` };
}

export function rateLimitMessage({ count, windowMinutes, worst }, h = {}) {
  const where = worst ? ` Most of it on ${acct(h, worst.accountId)} (${clip(worst.endpointClass, 20)}).` : "";
  return { key: "ratelimit.refused", group: "ratelimit", text: `Rate limits slowed ${count} requests in the last ${windowMinutes} minutes.${where} Prices may lag a little; nothing is lost.` };
}

export function sourceMessage(s) {
  return { key: "source.ejected", group: `source:${s.id}`, text: `Data source ${clip(s.name ?? s.id, 40)} is paused after repeated failures. The Bridge tries it again by itself.` };
}

const names = (list) => list.map((a) => clip(a.label || a.id, 40)).join(", ");

/** "3 accounts are not logged in: A, B, C." */
export function morningMessage(list, { second = false, opens = "09:15" } = {}) {
  const n = list.length;
  const head = second ? `Still not logged in at the open: ${n} account${n === 1 ? " is" : "s are"} not logged in` : `${n} account${n === 1 ? " is" : "s are"} not logged in`;
  return { key: "reminder.morning", group: second ? "reminder.second" : "reminder.morning", text: `${head}: ${names(list)}. ${second ? `The market opened at ${opens}.` : `Log in on this computer before the market opens at ${opens}.`}` };
}

/** End-of-day summary. rows: [{ label, mode, orders, fills, rejections, pnl }] */
export function eodMessage(rows, dateLabel) {
  if (!rows.length) return { key: "summary.eod", group: "summary.eod", text: `End of day ${dateLabel}: no orders today.` };
  const lines = rows.slice(0, 12).map((r) => `${clip(r.label, 40)} (${modeWord(r.mode)}): ${r.orders} order${r.orders === 1 ? "" : "s"}, ${r.fills} filled, ${r.rejections} rejected, P&L ${pnl(r.pnl)}`);
  return { key: "summary.eod", group: "summary.eod", text: `End of day ${dateLabel}.\n${lines.join("\n")}` };
}

export const TEST_MESSAGE = "This is a test from your Bridge. If you can read it, alerts will arrive in this chat.";
