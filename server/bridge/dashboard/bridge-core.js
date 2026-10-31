// The Bridge pages' pure helpers (Accounts, API › Keys, Integrations, Test console, Rate limits, Activity): how an
// account's session, a key's expiry and a budget window read in words, what needs attention, and the Activity
// filters. No DOM and no I/O, so they run under Node (bridge-core.test.mjs).

import { DASH, formatInt } from "./format.js";

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
/** A session that ends within this reads "expires soon" (and is listed under Needs attention). */
export const SESSION_SOON_MS = 2 * HOUR;
/** A key that expires within this reads "expires soon". */
export const KEY_SOON_MS = 7 * DAY;
/** A request slower than this is "slow" in Activity. */
export const SLOW_MS = 1000;

const toMs = (v) => (typeof v === "number" ? v : typeof v === "string" && v ? Date.parse(v) : NaN);
const plural = (n, one, many = `${one}s`) => `${formatInt(n)} ${n === 1 ? one : many}`;

/** A span in words in its largest unit (minutes and hours rounded down, days to the nearest): "3 days", "5 hours", "12 min", "under a minute" (pure). */
export function spanWords(ms) {
  const m = Math.abs(Number(ms));
  if (!Number.isFinite(m)) return DASH;
  if (m < MINUTE) return "under a minute";
  if (m < HOUR) return `${formatInt(Math.floor(m / MINUTE))} min`;
  if (m < DAY) return plural(Math.floor(m / HOUR), "hour");
  // Whole days to the nearest (a key made for 7 days reads "7 days", not "6 days" a minute later).
  return plural(Math.max(1, Math.round(m / DAY)), "day");
}

/** "in 3 days" / "3 days ago" from now; DASH when the time is missing (pure). */
export function relativeText(when, nowMs) {
  const t = toMs(when);
  if (!Number.isFinite(t)) return DASH;
  const d = t - nowMs;
  return d >= 0 ? `in ${spanWords(d)}` : `${spanWords(d)} ago`;
}

// ── Accounts ──

/**
 * An account's status in plain words (pure): { kind, text, tone, attention }. Paper accounts are always "Ready";
 * a session that ends within two hours is "expiring"; expired, failed and missing sessions need attention.
 * @param {{ broker: string, session?: { state?: string, expiresAt?: string|null, message?: string|null } }} a
 */
export function accountStatus(a, nowMs) {
  if (a?.broker === "paper") return { kind: "paper", text: "Ready", tone: "ok", attention: false };
  const s = a?.session ?? {};
  switch (s.state) {
    case "connected": {
      const left = toMs(s.expiresAt) - nowMs;
      if (Number.isFinite(left) && left <= 0) return { kind: "expired", text: "Expired", tone: "bad", attention: true };
      if (Number.isFinite(left) && left <= SESSION_SOON_MS) return { kind: "expiring", text: `Ends in ${spanWords(left)}`, tone: "warn", attention: true };
      return { kind: "connected", text: "Logged in", tone: "ok", attention: false };
    }
    case "expired":
      return { kind: "expired", text: "Expired", tone: "bad", attention: true };
    case "error":
      return { kind: "error", text: "Login failed", tone: "bad", attention: true };
    case "connecting":
      return { kind: "connecting", text: "Logging in", tone: "warn", attention: false };
    default:
      return { kind: "missing", text: "Not logged in", tone: "warn", attention: true };
  }
}

/** Broker accounts and paper accounts, each in the config's order (pure). */
export function accountGroups(accs = []) {
  return { brokers: accs.filter((a) => a.broker !== "paper"), paper: accs.filter((a) => a.broker === "paper") };
}

/** Counts for the Accounts summary (pure): logged in, needing a login, paper, live-enabled. */
export function accountCounts(accs = [], nowMs) {
  let loggedIn = 0;
  let needLogin = 0;
  let paper = 0;
  let live = 0;
  for (const a of accs) {
    const s = accountStatus(a, nowMs);
    if (s.kind === "paper") paper += 1;
    else if (s.kind === "connected" || s.kind === "expiring") loggedIn += 1;
    if (s.attention && s.kind !== "expiring") needLogin += 1;
    if (a.liveAllowedByConfig) live += 1;
  }
  return { loggedIn, needLogin, paper, live };
}

/** The session line under an account: "Logged in until 31 Oct, 15:30" style, built from a formatter (pure). */
export function sessionLine(a, nowMs, fmt = (iso) => iso) {
  const st = accountStatus(a, nowMs);
  const s = a?.session ?? {};
  if (st.kind === "paper") return "Simulated orders on real prices";
  if (st.kind === "connected") return s.expiresAt ? `Session until ${fmt(s.expiresAt)}` : "Session open, no end time from the broker";
  if (st.kind === "expiring") return `Session ends ${relativeText(s.expiresAt, nowMs)}, at ${fmt(s.expiresAt)}`;
  if (st.kind === "expired") return "The broker ended the session. Log in again to use it";
  if (st.kind === "error") return s.message ? `Last try: ${s.message}` : "The last login did not go through";
  if (st.kind === "connecting") return "Waiting for the broker";
  return "Log in once a day with the broker's code or PIN";
}

// ── Keys ──

/**
 * A key's state (pure): { kind: "revoked" | "expired" | "expiring" | "active", text, tone, expiry } where `expiry` is
 * the expiry in words ("Never expires", "Expires in 3 days", "Expired 2 days ago").
 */
export function keyStatus(k, nowMs) {
  const t = toMs(k?.expiresAt);
  const expiry = !Number.isFinite(t) ? "Never expires" : t > nowMs ? `Expires ${relativeText(t, nowMs)}` : `Expired ${relativeText(t, nowMs)}`;
  if (k?.revokedAt) return { kind: "revoked", text: "Revoked", tone: "", expiry: `Revoked ${relativeText(k.revokedAt, nowMs)}` };
  if (Number.isFinite(t) && t <= nowMs) return { kind: "expired", text: "Expired", tone: "bad", expiry };
  if (Number.isFinite(t) && t - nowMs <= KEY_SOON_MS) return { kind: "expiring", text: "Expires soon", tone: "warn", expiry };
  return { kind: "active", text: "Active", tone: "ok", expiry };
}

const KEY_ORDER = { expiring: 0, expired: 1, active: 2, revoked: 3 };
/** Keys in the order a person reads them (pure): expiring soon, expired, active (newest first), revoked last. */
export function sortKeys(keys = [], nowMs) {
  return keys
    .map((k, i) => ({ k, i, s: keyStatus(k, nowMs).kind }))
    .sort((a, b) => KEY_ORDER[a.s] - KEY_ORDER[b.s] || (toMs(b.k.createdAt) || 0) - (toMs(a.k.createdAt) || 0) || a.i - b.i)
    .map((x) => x.k);
}

/** "Used 5 min ago" / "Never used" (pure). */
export const lastUsedText = (k, nowMs) => (k?.lastUsedAt ? `Used ${relativeText(k.lastUsedAt, nowMs)}` : "Never used");

// ── Rate limits ──

/** Tone of a share of a limit: "ok" below 70 %, "warn" to 90 %, "bad" above (pure; same steps as the API budget). */
export const shareTone = (share) => (share >= 0.9 ? "bad" : share >= 0.7 ? "warn" : "ok");
const WINDOW_WORD = { "1s": "second", "1m": "minute", "1h": "hour", "1d": "day" };
/** "second" for "1s" (pure). */
export const windowWord = (w) => WINDOW_WORD[w] ?? String(w ?? "");

/** The fullest window of an endpoint class (pure): { window, used, limit, share, tone }, or null with no limit. */
export function fullestWindow(cls) {
  let best = null;
  for (const w of cls?.windows ?? []) {
    if (!(w.limit > 0)) continue;
    const share = (Number(w.used) || 0) / w.limit;
    if (!best || share > best.share) best = { window: w.window, used: Number(w.used) || 0, limit: w.limit, share, tone: shareTone(share) };
  }
  if (!best && cls?.limit > 0) {
    const share = (Number(cls.used) || 0) / cls.limit;
    best = { window: cls.window ?? "1s", used: Number(cls.used) || 0, limit: cls.limit, share, tone: shareTone(share) };
  }
  return best;
}

/** The minute window of a class (pure), else null. */
export function minuteWindow(cls) {
  const w = (cls?.windows ?? []).filter((x) => x.window === "1m" && x.limit > 0).sort((a, b) => b.used / b.limit - a.used / a.limit)[0];
  return w ? { window: "1m", used: Number(w.used) || 0, limit: w.limit, share: (Number(w.used) || 0) / w.limit, tone: shareTone((Number(w.used) || 0) / w.limit) } : null;
}

/**
 * One row per endpoint class of a usage account (pure), fullest first, then busiest today: { cls, fullest, today,
 * throttled, refused }. Classes with no limit and no calls today are left out.
 */
export function classRows(account) {
  return Object.entries(account?.classes ?? {})
    .map(([cls, c]) => ({ cls, fullest: fullestWindow(c), today: Number(c.callsToday) || 0, throttled: Number(c.throttledToday) || 0, refused: Number(c.refusedToday) || 0 }))
    .filter((r) => r.fullest || r.today > 0)
    .sort((a, b) => (b.fullest?.share ?? 0) - (a.fullest?.share ?? 0) || b.today - a.today || a.cls.localeCompare(b.cls));
}

/** The account's headline numbers (pure): calls today, throttled, refused, and the fullest minute window. */
export function accountUsage(account) {
  const rows = classRows(account);
  let minute = null;
  for (const c of Object.values(account?.classes ?? {})) {
    const m = minuteWindow(c);
    if (m && (!minute || m.share > minute.share)) minute = m;
  }
  return {
    today: rows.reduce((s, r) => s + r.today, 0),
    throttled: rows.reduce((s, r) => s + r.throttled, 0),
    refused: rows.reduce((s, r) => s + r.refused, 0),
    minute,
  };
}

// ── Needs attention ──

/**
 * What needs attention across the Bridge pages (pure), most urgent first. Each item:
 * { id, tone: "bad" | "warn", title, detail, action: { kind: "login" | "keys" | "limits", id?, label } }.
 * Accounts: expired, failed, missing and soon-ending sessions. Keys: expired in the last 30 days (not revoked) and
 * expiring within 7 days. Budget: a broker back-off, and any class at 70 % or more of a limit.
 */
export function attentionItems({ accounts = [], keys = [], usage = null } = {}, nowMs) {
  const out = [];
  for (const a of accounts) {
    const s = accountStatus(a, nowMs);
    if (!s.attention) continue;
    const name = a.label ?? a.id;
    const title =
      s.kind === "expired" ? `${name}: the session has expired` : s.kind === "error" ? `${name}: the last login failed` : s.kind === "expiring" ? `${name}: the session ends ${relativeText(a.session?.expiresAt, nowMs)}` : `${name} is not logged in`;
    const detail = s.kind === "error" && a.session?.message ? a.session.message : s.kind === "expiring" ? "Log in again now to keep prices and orders flowing." : "Prices and orders through this broker wait until you log in.";
    out.push({ id: `acct:${a.id}`, tone: s.tone === "bad" ? "bad" : "warn", title, detail, action: { kind: "login", id: a.id, label: s.kind === "missing" ? "Log in" : "Log in again" } });
  }
  for (const k of keys) {
    const s = keyStatus(k, nowMs);
    if (s.kind === "expiring") out.push({ id: `key:${k.id}`, tone: "warn", title: `Key “${k.label}” ${s.expiry.toLowerCase()}`, detail: "Tools using it stop working then. Make a new key for the tool before it ends.", action: { kind: "keys", id: k.id, label: "Show key" } });
    else if (s.kind === "expired" && nowMs - toMs(k.expiresAt) <= 30 * DAY) out.push({ id: `key:${k.id}`, tone: "warn", title: `Key “${k.label}” has expired`, detail: "Anything still using it is refused. Make a new key and revoke this one.", action: { kind: "keys", id: k.id, label: "Show key" } });
  }
  for (const a of usage?.accounts ?? []) {
    if (a.broker === "paper") continue;
    if (a.healthy === false || Object.values(a.classes ?? {}).some((c) => c.backoffMs > 0)) {
      out.push({ id: `budget:${a.accountId}:backoff`, tone: "bad", title: `${a.accountId}: the broker asked the Bridge to slow down`, detail: "Calls wait a moment, then carry on. Nothing is lost.", action: { kind: "limits", id: a.accountId, label: "Rate limits" } });
      continue;
    }
    const top = classRows(a)[0];
    if (top?.fullest && top.fullest.share >= 0.7) {
      const f = top.fullest;
      out.push({
        id: `budget:${a.accountId}:${top.cls}`,
        tone: f.tone === "bad" ? "bad" : "warn",
        title: `${a.accountId}: ${top.cls} calls at ${formatInt(Math.round(f.share * 100))}% of the ${windowWord(f.window)} limit`,
        detail: `${formatInt(f.used)} of ${formatInt(f.limit)} this ${windowWord(f.window)}. New calls may wait a little.`,
        action: { kind: "limits", id: a.accountId, label: "Rate limits" },
      });
    }
  }
  const rank = { bad: 0, warn: 1 };
  return out.map((x, i) => ({ x, i })).sort((p, q) => rank[p.x.tone] - rank[q.x.tone] || p.i - q.i).map((p) => p.x);
}

// ── Activity ──

/** A response status as a word and tone (pure): 2xx/3xx ok, 4xx warn, 5xx bad. */
const STATUS_WORD = {
  200: "OK", 201: "Created", 202: "Accepted", 204: "No content", 304: "Not modified",
  400: "Bad request", 401: "Not signed in", 403: "Not allowed", 404: "Not found", 409: "Conflict", 413: "Too large", 422: "Check the fields", 429: "Too many requests",
  500: "Bridge error", 502: "Broker error", 503: "Unavailable", 504: "Broker timed out",
};
export function statusText(status) {
  const n = Number(status);
  if (!Number.isFinite(n) || n <= 0) return { text: DASH, tone: "" };
  const tone = n < 400 ? "ok" : n < 500 ? "warn" : "bad";
  return { text: `${formatInt(n)} ${STATUS_WORD[n] ?? (n < 400 ? "OK" : "Error")}`, tone };
}

export const ACTIVITY_FILTERS = Object.freeze([
  ["all", "All"],
  ["errors", "Errors"],
  ["slow", "Slow"],
  ["writes", "Changes"],
]);

/** Requests that match a filter (pure): kind (all, errors, slow, writes), a path search and the dashboard's own hidden. */
export function filterRequests(rows = [], { kind = "all", q = "", hideOwn = false } = {}) {
  const needle = String(q).trim().toLowerCase();
  return rows.filter((x) => {
    if (hideOwn && x.client === "dashboard") return false;
    if (kind === "errors" && !(x.status >= 400)) return false;
    if (kind === "slow" && !(x.ms >= SLOW_MS)) return false;
    if (kind === "writes" && !["POST", "PUT", "PATCH", "DELETE"].includes(x.method)) return false;
    if (needle && !String(x.path ?? "").toLowerCase().includes(needle) && !String(x.keyId ?? "").toLowerCase().includes(needle)) return false;
    return true;
  });
}

/** Totals for the Activity header (pure): requests, errors, slow and the median time in ms (null with none). */
export function requestSummary(rows = []) {
  const ms = rows.map((x) => Number(x.ms)).filter(Number.isFinite).sort((a, b) => a - b);
  const median = ms.length ? (ms.length % 2 ? ms[(ms.length - 1) / 2] : (ms[ms.length / 2 - 1] + ms[ms.length / 2]) / 2) : null;
  return { count: rows.length, errors: rows.filter((x) => x.status >= 400).length, slow: rows.filter((x) => x.ms >= SLOW_MS).length, median };
}

/**
 * Rows grouped into time buckets for a timeline (pure): "Last minute", "Last 5 minutes", "Last hour", "Earlier".
 * Empty buckets are left out; rows keep their order.
 */
export function timeBuckets(rows = [], nowMs, at = (x) => x.at) {
  const BUCKETS = [
    ["Last minute", MINUTE],
    ["Last 5 minutes", 5 * MINUTE],
    ["Last hour", HOUR],
    ["Earlier", Infinity],
  ];
  const groups = BUCKETS.map(([label]) => ({ label, rows: [] }));
  for (const x of rows) {
    const age = nowMs - toMs(at(x));
    const i = BUCKETS.findIndex(([, max]) => !(age > max));
    groups[i < 0 ? groups.length - 1 : i].rows.push(x);
  }
  return groups.filter((g) => g.rows.length);
}

// ── Audit log ──

export const AUDIT_FILTERS = Object.freeze([
  ["all", "All"],
  ["orders", "Orders"],
  ["keys", "Keys"],
  ["accounts", "Accounts"],
  ["safety", "Safety"],
]);

/** Which audit filter an event type belongs to (pure). */
export function auditKind(type) {
  const t = String(type ?? "");
  if (/^(order|ticket|trade|basket|paper)\b/.test(t)) return "orders";
  if (/^key\b/.test(t)) return "keys";
  if (/^(account|session|broker|holder)\b/.test(t)) return "accounts";
  if (/^(kill|killswitch|safety|guard|limit|live|readiness|hook)\b/i.test(t)) return "safety";
  return "other";
}

const sentence = (s) => (s ? `${s[0].toUpperCase()}${s.slice(1)}` : s);
/** "order.placed" → "Order placed", "killSwitch.engaged" → "Kill switch engaged" (pure). */
export function auditTitle(type) {
  const words = String(type ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  return words.length ? sentence(words.join(" ")) : DASH;
}

/**
 * One audit event as a timeline entry (pure): { title, detail, kind, side } where side is "buy" / "sell" for an order
 * (the dot's colour), else null. Details are short facts from the event's data, never its raw JSON.
 */
export function auditEntry(x) {
  const d = x?.data ?? {};
  const kind = auditKind(x?.type);
  const sideRaw = String(d.side ?? "").toUpperCase();
  const side = sideRaw === "BUY" ? "buy" : sideRaw === "SELL" ? "sell" : null;
  const parts = [];
  if (kind === "orders") {
    if (d.side || d.quantity) parts.push([d.side, d.quantity !== undefined ? formatInt(d.quantity) : null].filter(Boolean).join(" "));
    if (d.symbol) parts.push(d.symbol);
    if (d.status) parts.push(String(d.status));
    if (d.mode) parts.push(String(d.mode));
  } else if (kind === "keys") {
    if (d.label) parts.push(`“${d.label}”`);
    if (Array.isArray(d.scopes)) parts.push(d.scopes.join(" + "));
    if (d.keyId && !d.label) parts.push(d.keyId);
  } else {
    for (const [k, v] of Object.entries(d)) {
      if (parts.length >= 3) break;
      if (v === null || v === undefined || typeof v === "object" || /hash|secret|token/i.test(k)) continue;
      parts.push(`${k} ${String(v)}`);
    }
  }
  if (x?.accountId) parts.push(x.accountId);
  return { title: auditTitle(x?.type), detail: parts.filter(Boolean).join(" · "), kind, side };
}

/** "local:dashboard-local" → "This computer"; "key:abc" → "Key abc"; "system:bridge" → "The Bridge" (pure). */
export function actorText(actor) {
  if (!actor) return DASH;
  if (actor.kind === "system") return "The Bridge";
  if (actor.kind === "local") return "This computer";
  if (actor.kind === "key") return `Key ${actor.id ?? ""}`.trim();
  if (actor.kind === "hook") return `Webhook ${actor.id ?? ""}`.trim();
  return [actor.kind, actor.id].filter(Boolean).join(" ") || DASH;
}

// ── Integrations ──

/**
 * Each integration's tile: glyph and tint (app.js ICONS / iOS colour names), a one-line blurb and three setup steps
 * in plain words. The code to paste comes from snippets.js.
 */
export const INTEGRATION_INFO = Object.freeze({
  webhooks: { glyph: "bolt", tint: "orange", blurb: "Alerts that place paper orders", steps: ["Create a webhook below. Its secret address is shown once: copy it.", "Paste the address into your alert service (ChartInk, GoCharting or your own script).", "Send a test alert and watch it arrive in Activity and on the Orders page."] },
  python: { glyph: "console", tint: "blue", blurb: "The Python SDK, standard library only", steps: ["Create a paper key for scripts (the button on the right).", "Install the SDK from the api-bridge folder and set MCB_API_KEY.", "Run the example: it reads a price and places one paper order."] },
  node: { glyph: "console", tint: "green", blurb: "The Node SDK (ESM)", steps: ["Create a paper key for scripts.", "Install the SDK from the api-bridge folder and set MCB_API_KEY.", "Run the example; streaming on Node 20 also needs the ws package."] },
  excel: { glyph: "list", tint: "green", blurb: "Live prices in cells", steps: ["Create a read-only key that may sit in a URL (it expires in 90 days).", "Paste the formula into a cell; it already has your key and address.", "Recalculate (F9) for fresh prices, or use the workbook from Accounts."] },
  amibroker: { glyph: "chart", tint: "purple", blurb: "Live values in AFL and history imports", steps: ["Create a read-only URL key.", "Copy the AFL into a formula and the .format file into AmiBroker's Formats folder.", "Import history with /xl/history, then apply the formula to a chart."] },
  claude: { glyph: "integrations", tint: "orange", blurb: "The Bridge as an MCP server", steps: ["Create a read-only key for the assistant.", "Add the server block to Claude's config file and restart Claude.", "Ask about a price or a chain. Orders are only prepared for you to confirm here."] },
  chatgpt: { glyph: "integrations", tint: "teal", blurb: "The same tools through function calling", steps: ["Create a read-only key.", "Run the script on this computer: ChatGPT cannot reach a local server.", "It hands the Bridge's tools to the model and prints the answer."] },
  rest: { glyph: "plug", tint: "gray", blurb: "Plain HTTP and JSON", steps: ["Create a read-only key.", "Send it as a Bearer token on every request.", "Every answer is { data, meta } JSON; errors carry a stable code."] },
});
