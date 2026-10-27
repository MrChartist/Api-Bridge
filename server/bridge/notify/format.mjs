/**
 * Human-readable messages for notification events (stream S15). Pure functions. Instrument names and broker messages
 * are third-party text: they are kept short and never interpreted.
 */
const clip = (s, n = 200) => {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const list = (a, n = 20) => {
  const arr = Array.isArray(a) ? a : [];
  return arr.length > n ? `${arr.slice(0, n).join(", ")} and ${arr.length - n} more` : arr.join(", ");
};

/** { title, text } for one event. */
export function formatEvent(topic, p = {}) {
  switch (topic) {
    case "scan.alert":
      return { title: `Scan "${clip(p.name, 80)}": ${p.newMatches?.length ?? 0} new match(es)`, text: `New: ${list(p.newMatches)}` };
    case "scan.completed":
      return { title: `Scan finished (${p.status})`, text: `${p.progress?.matched ?? 0} matched of ${p.progress?.total ?? 0}${p.matched?.length ? `: ${list(p.matched)}` : ""}` };
    case "order.updated": {
      const qty = p.filledQuantity ? ` ${p.filledQuantity} filled${p.avgPrice ? ` @ ${p.avgPrice}` : ""}` : "";
      return { title: `${String(p.mode ?? "").toUpperCase()} order ${p.status}`, text: `${clip(p.orderId, 60)} on ${clip(p.accountId, 40)}${qty}${p.brokerStatus ? ` (${clip(p.brokerStatus, 60)})` : ""}` };
    }
    case "safety.kill_switch":
      return { title: p.engaged ? "KILL SWITCH ENGAGED" : "Kill switch released", text: `${p.reason ? clip(p.reason) : "No reason given"}${p.by ? ` · by ${clip(p.by, 60)}` : ""}${p.cancelOpenOrders ? " · cancelling open orders" : ""}` };
    case "account.status":
      return { title: `Account ${clip(p.accountId, 40)}: ${p.session}`, text: p.session === "expired" ? "The broker session ended. Log in again: mc-bridge accounts connect " + clip(p.accountId, 40) : clip(p.message ?? "") };
    case "limits.throttled":
      return { title: `Broker rate limit hit on ${clip(p.accountId, 40)}`, text: `${p.endpointClass} calls paused for ${Math.ceil((p.retryAfterMs ?? 0) / 1000)} s` };
    case "test":
      return { title: "Mr. Chartist API Bridge: test message", text: "Notifications from your Bridge reach this place." };
    default:
      return { title: topic, text: "" };
  }
}
