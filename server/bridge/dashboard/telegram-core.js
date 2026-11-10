// The Telegram card's pure parts (no DOM, no network): how events are grouped and how a target's health reads.

/** The events, grouped the way a person thinks about them. Keys are the Bridge's; labels come from GET /v1/notify/events. */
export const EVENT_GROUPS = Object.freeze([
  ["Orders", ["order.rejected", "order.outcome_unknown", "order.filled", "order.placed", "ticket.prepared"]],
  ["Safety and logins", ["session.expired", "kill_switch.engaged", "kill_switch.released", "limit.reached", "readiness.changed"]],
  ["Webhook alerts", ["hook.rejected", "hook.stale", "hook.failed"]],
  ["Data and limits", ["source.ejected", "ratelimit.refused", "backup.failed"]],
  ["Reminders", ["reminder.morning", "summary.eod"]],
]);

/** The health word and pill tone for a target's state. Pure. */
export function healthView(h2) {
  const state = h2?.state ?? "unverified";
  if (state === "ok") return { word: "Working", tone: "ok" };
  if (state === "unverified") return { word: "Not tested yet", tone: "" };
  if (state === "rate_limited") return { word: "Slowed by Telegram", tone: "warn" };
  if (state === "network" || state === "timeout" || state === "server") return { word: "Cannot reach Telegram", tone: "warn" };
  return { word: "Needs attention", tone: "bad" };
}

/** Events keyed and grouped for drawing; keys the server did not list are left out. Pure. */
export function groupEvents(list) {
  const by = new Map(list.map((e) => [e.key, e]));
  return EVENT_GROUPS.map(([title, keys]) => ({ title, events: keys.map((k) => by.get(k)).filter(Boolean) })).filter((g) => g.events.length);
}
