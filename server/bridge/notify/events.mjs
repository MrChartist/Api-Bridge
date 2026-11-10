/**
 * The events a person can switch on or off, with plain labels and sensible defaults. One list: the dashboard card,
 * PUT /v1/notify/events, the docs table and the router all read it.
 *
 *  key       the name used in config and in the API
 *  label     what the dashboard shows
 *  help      one plain sentence
 *  default   on or off until the person decides
 *  critical  bypasses quiet hours and is never folded into a digest line that hides it
 *  topics    the bus topics that can produce it (docs/ARCHITECTURE.md; core/eventBus.mjs). An empty list means the event
 *            is made by the notifier itself (source.ejected and the reminders come from polling in service.mjs), not
 *            by a bus topic; it works, there is just no topic to subscribe to.
 */
export const EVENT_CATALOG = Object.freeze([
  { key: "order.rejected", label: "An order is rejected", help: "Your broker or the Bridge's safety checks refused an order.", default: true, critical: false, topics: ["order.updated"] },
  { key: "order.outcome_unknown", label: "An order's result is not known", help: "The broker did not confirm an order. Check your broker; do not send it again.", default: true, critical: true, topics: ["order.outcome_unknown"] },
  { key: "orders.drift", label: "The Bridge and your broker disagree about an order", help: "A read-only check found an order whose state differs between the Bridge and the broker's order book. Nothing is changed: check your broker app.", default: true, critical: false, topics: ["orders.drift"] },
  { key: "order.filled", label: "An order is filled", help: "An order was fully executed.", default: true, critical: false, topics: ["order.updated"] },
  { key: "order.placed", label: "An order is placed", help: "An order was accepted and is waiting at the exchange. Chatty if you trade a lot.", default: false, critical: false, topics: ["order.updated"] },
  { key: "ticket.prepared", label: "An order needs your approval", help: "An order is waiting for you to approve it on this computer.", default: true, critical: false, topics: ["ticket.prepared"] },
  { key: "kill_switch.engaged", label: "The kill switch is turned on", help: "All new orders are blocked.", default: true, critical: true, topics: ["safety.kill_switch"] },
  { key: "kill_switch.released", label: "The kill switch is turned off", help: "Orders can be sent again.", default: true, critical: false, topics: ["safety.kill_switch"] },
  { key: "session.expired", label: "A broker account is logged out", help: "Log in again on this computer, or orders and prices from that account stop.", default: true, critical: false, topics: ["account.status", "account.session_rejected"] },
  { key: "readiness.changed", label: "An account cannot trade (or can again)", help: "From the readiness check: session, static IP, limits.", default: true, critical: false, topics: ["trading.readiness"] },
  { key: "hook.rejected", label: "A webhook alert is rejected", help: "An alert from TradingView or another platform did not become an order.", default: true, critical: false, topics: ["hook.rejected"] },
  { key: "hook.stale", label: "A webhook alert arrived too late", help: "The alert was too old to trade on, so it was dropped.", default: true, critical: false, topics: ["hook.stale"] },
  { key: "hook.failed", label: "A webhook alert failed after it was accepted", help: "The alert was accepted but the order could not be made.", default: true, critical: false, topics: ["hook.failed"] },
  { key: "limit.reached", label: "A daily safety limit is reached", help: "Daily loss or order count reached.", default: true, critical: false, topics: ["safety.limit"] },
  { key: "ratelimit.refused", label: "Many requests are being slowed by rate limits", help: "Sent once when the number of throttled requests passes your threshold.", default: true, critical: false, topics: ["limits.throttled"] },
  { key: "backup.failed", label: "A backup could not be written", help: "A daily or manual backup failed, so your data may not be saved. Check the disk and the backup settings on this computer.", default: true, critical: false, topics: ["backup.failed"] },
  { key: "source.ejected", label: "A data source is switched off after failures", help: "A price source stopped answering and is paused for a while.", default: true, critical: false, topics: [] },
  { key: "reminder.morning", label: "Morning reminder to log in", help: "On trading days before the open, if a broker account is not logged in.", default: true, critical: false, topics: [] },
  { key: "summary.eod", label: "End-of-day summary", help: "Orders, fills, rejections and profit or loss for the day.", default: false, critical: false, topics: [] },
]);

export const EVENT_KEYS = Object.freeze(EVENT_CATALOG.map((e) => e.key));
const BY_KEY = new Map(EVENT_CATALOG.map((e) => [e.key, e]));

export const eventInfo = (key) => BY_KEY.get(key) ?? null;
export const isCritical = (key) => BY_KEY.get(key)?.critical === true;

/** The defaults as a { key: boolean } map. */
export function defaultEventFlags() {
  return Object.fromEntries(EVENT_CATALOG.map((e) => [e.key, e.default]));
}

/** Effective flags: defaults, then config, then what the person saved. Unknown keys are ignored. */
export function effectiveEventFlags(...layers) {
  const out = defaultEventFlags();
  for (const layer of layers) for (const [k, v] of Object.entries(layer ?? {})) if (BY_KEY.has(k) && typeof v === "boolean") out[k] = v;
  return out;
}
