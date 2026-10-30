/**
 * The API budget in one small object (pure): what the dashboard's budget indicator shows. For each broker account,
 * the fullest per-second and per-minute window across its endpoint classes right now, back-off and queue, and the
 * calls made and saved today. Sent over the stream as `budget` messages (op subscribe_budget) and returned by
 * GET /v1/usage?view=budget.
 */

const SECOND = new Set(["1s"]);
const MINUTE = new Set(["1m", "60s"]);

/** The fullest window of a kind over every class: { used, limit, cls } or null when the account has none. */
function fullest(classes, kinds) {
  let best = null;
  for (const [cls, c] of Object.entries(classes ?? {})) {
    for (const w of c.windows ?? []) {
      if (!kinds.has(w.window) || !(Number(w.limit) > 0)) continue;
      const share = w.used / w.limit;
      if (!best || share > best.share || (share === best.share && w.used > best.used)) best = { used: w.used, limit: w.limit, cls, share };
    }
  }
  if (!best) return null;
  const { share: _s, ...out } = best;
  return out;
}

/**
 * @param {{ accounts: object[], savings?: object }} usage  scheduler.usage() (or the /v1/usage data)
 * @param {"*" | Set<string>} [visible]  account ids the caller may see
 * @param {{ feeds?: Array<{ accountId?: string, state?: string, connected?: boolean, subscriptions?: number }> }} [stream]
 */
export function budgetSummary(usage, visible = "*", stream = {}) {
  const accounts = [];
  let callsToday = 0;
  for (const a of usage?.accounts ?? []) {
    if (visible !== "*" && !visible.has(a.accountId)) continue;
    const classes = a.classes ?? {};
    let calls = 0;
    let backoffMs = 0;
    for (const c of Object.values(classes)) {
      calls += c.callsToday ?? 0;
      backoffMs = Math.max(backoffMs, c.backoffMs ?? 0);
    }
    callsToday += calls;
    accounts.push({
      accountId: a.accountId,
      broker: a.broker,
      healthy: a.healthy !== false,
      queued: a.queued ?? 0,
      backoffMs,
      second: fullest(classes, SECOND),
      minute: fullest(classes, MINUTE),
      callsToday: calls,
    });
  }
  const s = usage?.savings ?? {};
  const saved = (s.servedFromStream ?? 0) + (s.servedFromCache ?? 0) + (s.coalesced ?? 0) + (s.batched ?? 0);
  const feeds = (stream.feeds ?? []).filter((f) => visible === "*" || !f.accountId || visible.has(f.accountId));
  const up = feeds.filter((f) => f.connected || f.state === "up").length;
  return {
    accounts,
    callsToday,
    savedToday: saved,
    savings: { servedFromStream: s.servedFromStream ?? 0, servedFromCache: s.servedFromCache ?? 0, coalesced: s.coalesced ?? 0, batched: s.batched ?? 0 },
    stream: { feeds: feeds.length, up, subscriptions: feeds.reduce((n, f) => n + (f.subscriptions ?? 0), 0) },
  };
}
