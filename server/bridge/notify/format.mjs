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

/** "Log in again …" etc.: what to do about the first failing readiness check (p1-05 §6.8). */
function readinessRemedy(check, accountId) {
  if (check === "session") return `Log in again: mc-bridge accounts connect ${clip(accountId, 40)}, or the Accounts page.`;
  if (check === "egress") return "Check your internet connection or VPN; see the deployment guide.";
  if (check === "dailyOrders" || check === "dailyLoss") return "Daily limit reached; it resets at midnight IST.";
  if (check === "killSwitch") return "Release it on the Safety page if this was not intended.";
  return "";
}

const sentence = (parts) => {
  const msgs = parts.map((m) => clip(m, 200).replace(/\.\s*$/, "")).filter(Boolean);
  return msgs.length ? `${msgs.join("; ")}.` : "";
};

/**
 * trading.readiness (p1-05 §6.8). Never an IP address, a lookup host, a token or a broker client code: only the
 * account's own local id and label, the broker's name and the reason lines (which carry none of those).
 */
function formatReadiness(p) {
  const sim = p.simulated ? " (simulated)" : "";
  const who = (a) => `${clip(a.brokerName ?? a.broker ?? "", 40)} ${clip(a.label || a.accountId, 60)}`.trim();
  if (p.kind === "preopen") {
    const list = Array.isArray(p.accounts) ? p.accounts : [];
    const cannot = list.filter((a) => a.state === "cannot_trade").length;
    const failing = list.filter((a) => a.state !== "ready" && a.state !== "paper_only");
    const at = typeof p.preOpenAt === "string" ? p.preOpenAt : "09:00";
    const title = cannot ? `${at} readiness: ${cannot} account(s) cannot trade${sim}` : failing.length ? `${at} readiness: ${failing.length} account(s) need attention${sim}` : `${at} readiness: all accounts ready${sim}`;
    const stateText = (s) => (s === "cannot_trade" ? "cannot trade" : s === "warn" ? "needs attention" : s === "unknown" ? "not checked" : s);
    const lines = (failing.length ? failing : list).slice(0, 20).map((a) => {
      const why = sentence((a.reasons ?? []).filter((r) => a.state !== "cannot_trade" || r.severity === "fail").map((r) => r.message).slice(0, 3));
      return `${who(a)}: ${stateText(a.state)}${why ? ` (${why.replace(/\.$/, "")})` : ""}`;
    });
    if (p.holidayCaveat) lines.push(clip(p.holidayCaveat, 200));
    return { title, text: lines.join("\n") };
  }
  if (p.kind === "recovered") {
    const warns = (p.reasons ?? []).map((r) => r.message).slice(0, 3);
    return { title: `${who(p)}: ready again${sim}`, text: warns.length ? `Trading readiness checks pass again, with notes: ${sentence(warns)}` : "Trading readiness checks pass again." };
  }
  const fails = (p.reasons ?? []).filter((r) => r.severity === "fail");
  const shown = (fails.length ? fails : p.reasons ?? []).slice(0, 4);
  const stateText = p.state === "cannot_trade" ? "cannot trade" : p.state === "warn" ? "needs attention" : p.state === "unknown" ? "not checked" : String(p.state ?? "");
  const parts = [sentence(shown.map((r) => r.message))];
  if (p.state === "cannot_trade" && (p.automations?.live ?? 0) > 0) parts.push("Automated orders on this account are paused.");
  const remedy = readinessRemedy(shown[0]?.check, p.accountId);
  if (remedy) parts.push(remedy);
  return { title: `${who(p)}: ${stateText}${sim}`, text: parts.filter(Boolean).join(" ") };
}

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
    case "trading.readiness":
      return formatReadiness(p);
    case "test":
      return { title: "Mr. Chartist API Bridge: test message", text: "Notifications from your Bridge reach this place." };
    default:
      return { title: topic, text: "" };
  }
}
