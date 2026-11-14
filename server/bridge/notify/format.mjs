/**
 * Human-readable messages for the readiness monitor's notifications (shown as "would have sent" in demo mode). Pure functions. Instrument names and broker messages
 * are third-party text: they are kept short and never interpreted.
 */
const clip = (s, n = 200) => {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** "Log in again …" etc.: what to do about the first failing readiness check. */
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
 * trading.readiness. Never an IP address, a lookup host, a token or a broker client code: only the
 * account's own local id and label, the broker's name and the reason lines (which carry none of those).
 */
function formatReadiness(p) {
  const sim = p.simulated ? " (simulated)" : "";
  // "Zerodha Main"; a label that already starts with the broker's name as a word ("Zerodha main", "Demo market data")
  // is not prefixed twice. An account id stands in for a missing label and keeps the prefix ("Dhan dhan-main").
  const who = (a) => {
    const broker = clip(a.brokerName ?? a.broker ?? "", 40);
    const name = clip(a.label || a.accountId, 60);
    const label = String(a.label ?? "");
    const named = broker && label.toLowerCase().startsWith(broker.toLowerCase()) && !/^[\p{L}\p{N}]/u.test(label.slice(broker.length));
    return named ? String(name).trim() : `${broker} ${name}`.trim();
  };
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

/** { title, text } for one event. Only trading.readiness is formatted; anything else gets its topic as the title. */
export function formatEvent(topic, p = {}) {
  return topic === "trading.readiness" ? formatReadiness(p) : { title: topic, text: "" };
}
