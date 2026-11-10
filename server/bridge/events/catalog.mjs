/**
 * The topics other programs can receive, who may see each, and how a topic filter is matched. One list: the stream, the
 * replay route, the webhooks, the docs table and the tests all read it.
 *
 *  scope     the lowest scope that may receive it. "read" topics match what a read key can already ask for over REST;
 *            "admin" topics are about keys, backups, webhook alerts and order tickets, so only an admin key sees them.
 *  accounts  the payload names an account (`accountId`); a key limited to some accounts only sees its own.
 *  throttleMs  at most one event of this topic per key of the payload in this many ms (the rest are counted, not kept).
 *
 * Never offered: `tick` (use the price stream), `audit.appended` and `key.revoked` (internal), `account.session_rejected`
 * (internal; `account.status` says the same in plain words). Events only tell what happened. Nothing that arrives or is
 * sent through this module can place, confirm or reject an order.
 */
import { expandScopes } from "../core/context.mjs";

/** @typedef {{ topic: string, scope: "read"|"admin", accounts: boolean, description: string, throttleMs?: number, key?: string }} TopicInfo */

/** @type {readonly TopicInfo[]} */
export const EVENT_TOPICS = Object.freeze(
  [
    { topic: "stream.status", scope: "read", accounts: true, description: "A broker price feed went up, down or stale.", throttleMs: 1000, key: "accountId" },
    { topic: "account.status", scope: "read", accounts: true, description: "A broker account's login changed: connected, expired, missing or error." },
    { topic: "account.login_needed", scope: "read", accounts: true, description: "Morning reminder: an account needs a login before the market opens." },
    { topic: "order.updated", scope: "read", accounts: true, description: "An order (paper or live) changed state: placed, filled, rejected, cancelled." },
    { topic: "order.outcome_unknown", scope: "read", accounts: true, description: "The broker did not confirm an order. Check the broker before sending it again." },
    { topic: "position.converted", scope: "read", accounts: true, description: "A position was moved between products." },
    { topic: "trading.readiness", scope: "read", accounts: true, description: "An account can trade now, or cannot any more (session, static IP, limits)." },
    { topic: "safety.kill_switch", scope: "read", accounts: false, description: "The kill switch was turned on or off." },
    { topic: "safety.limit", scope: "read", accounts: true, description: "A daily safety limit was reached." },
    { topic: "limits.throttled", scope: "read", accounts: true, description: "A request was slowed by a rate limit.", throttleMs: 1000, key: "accountId" },
    { topic: "download.progress", scope: "read", accounts: false, description: "A data download moved forward (at most once a second per job).", throttleMs: 1000, key: "id" },
    { topic: "download.done", scope: "read", accounts: false, description: "A data download finished." },
    { topic: "download.failed", scope: "read", accounts: false, description: "A data download stopped with an error." },
    { topic: "collection.changed", scope: "read", accounts: false, description: "A named list of instruments or an option universe was created, changed or deleted." },
    { topic: "recording.started", scope: "read", accounts: false, description: "A recording started writing." },
    { topic: "recording.stopped", scope: "read", accounts: false, description: "A recording stopped." },
    { topic: "recording.gap", scope: "read", accounts: false, description: "A recording missed data because the feed or the login was missing." },
    { topic: "recording.disk_low", scope: "read", accounts: false, description: "A recording is close to its disk limit." },
    { topic: "ticket.prepared", scope: "admin", accounts: true, description: "An order waits for a person to approve it on this computer. Carries no approval token." },
    { topic: "ticket.confirmed", scope: "admin", accounts: true, description: "A person approved an order ticket." },
    { topic: "ticket.rejected", scope: "admin", accounts: true, description: "A person declined an order ticket." },
    { topic: "hook.rejected", scope: "admin", accounts: false, description: "A webhook alert was accepted but did not become an order." },
    { topic: "hook.stale", scope: "admin", accounts: false, description: "A webhook alert was too old to trade on." },
    { topic: "hook.failed", scope: "admin", accounts: false, description: "An accepted webhook alert's order could not be made." },
    { topic: "backup.completed", scope: "admin", accounts: false, description: "A backup was written." },
    { topic: "backup.failed", scope: "admin", accounts: false, description: "A backup could not be written." },
    { topic: "config.warning", scope: "admin", accounts: false, description: "The Bridge found something in the config worth fixing." },
    { topic: "storage.status", scope: "admin", accounts: false, description: "Free space on the Bridge's disk became low, critical or normal again." },
    { topic: "data.quarantined", scope: "admin", accounts: false, description: "A damaged data file was set aside and the Bridge started without it." },
  ].map((t) => Object.freeze(t)),
);

const BY_TOPIC = new Map(EVENT_TOPICS.map((t) => [t.topic, t]));
export const topicInfo = (topic) => BY_TOPIC.get(topic) ?? null;
export const isOfferedTopic = (topic) => BY_TOPIC.has(topic);

/** The topic that carries a delivery test. Always allowed to be sent by the test route; never produced by the bus. */
export const TEST_TOPIC = "subscription.test";

const PATTERN_RE = /^(\*|[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*(\.\*)?)$/;

/** Whether one filter pattern ("*", "order.*", "order.updated") matches a topic. */
export function patternMatches(pattern, topic) {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return topic.startsWith(pattern.slice(0, -1));
  return pattern === topic;
}

/**
 * Check a list of topic filters. Each must be "*", a topic, or a prefix with ".*" that matches at least one topic.
 * @param {unknown} patterns
 * @returns {{ ok: true, patterns: string[] } | { ok: false, message: string }}
 */
export function checkTopicPatterns(patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return { ok: false, message: "Give at least one topic, for example [\"order.*\"] or [\"*\"]." };
  if (patterns.length > 50) return { ok: false, message: "At most 50 topics." };
  const out = [];
  for (const p of patterns) {
    if (typeof p !== "string" || p.length > 64 || !PATTERN_RE.test(p)) return { ok: false, message: `"${String(p).slice(0, 40)}" is not a topic. Use a name from GET /v1/events/topics, "order.*" or "*".` };
    if (!EVENT_TOPICS.some((t) => patternMatches(p, t.topic))) return { ok: false, message: `No topic matches "${p}". See GET /v1/events/topics.` };
    if (!out.includes(p)) out.push(p);
  }
  return { ok: true, patterns: out };
}

/** Whether any of the patterns matches the topic. */
export const matchesAny = (patterns, topic) => patterns.some((p) => patternMatches(p, topic));

/** Topic filters from a query string value: "order.*,download.*". */
export function parsePatternList(value) {
  if (value === null || value === undefined || value === "") return ["*"];
  return String(value).split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * What a reader may see: its scopes (expanded) and the accounts it may use. A webhook is read as an admin key with every
 * account (an admin created it, on this computer), optionally narrowed by its own account list.
 * @typedef {{ admin: boolean, accounts: "*" | Set<string> }} Viewer
 */
/** @param {{ scopes?: string[], accounts?: string[] | "*" }} key @returns {Viewer} */
export function viewerOf(key) {
  return {
    admin: expandScopes(key?.scopes ?? []).has("admin"),
    accounts: key?.accounts === "*" || key?.accounts === undefined ? "*" : new Set(Array.isArray(key.accounts) ? key.accounts : []),
  };
}

/** Whether a viewer may see an event. `data.accountId`, when the topic is account-scoped, must be on the viewer's list. */
export function canSee(viewer, evt) {
  const info = topicInfo(evt.topic);
  if (!info) return false;
  if (info.scope === "admin" && !viewer.admin) return false;
  if (info.accounts && viewer.accounts !== "*") {
    const id = evt.data?.accountId;
    if (typeof id !== "string" || !viewer.accounts.has(id)) return false;
  }
  return true;
}

/** The topics a viewer may see, for GET /v1/events/topics. */
export const topicsFor = (viewer) => EVENT_TOPICS.filter((t) => t.scope === "read" || viewer.admin);
