// The rules behind the Developers page (#/developers): which key a task needs, apps (a key with its scope, quota and
// use), the snippets with the real address, the live request log filtered by app, the scope finder and the error
// catalogue. Pure (no DOM at import time), so developers-core.test.mjs runs it under Node. Key rules are not written
// again: names and expiry come from flows.js, snippets from snippets.js, the same code the Keys and Connect pages use.
import { defaultKeyName, istDay, keyFormProblem } from "./flows.js";
import { formatDayMonth, formatInt } from "./format.js";
import { snippets } from "./snippets.js";

/** The label of the admin key a dashboard sign-in makes: it is the dashboard's own, not an app a developer made. */
export const DASHBOARD_KEY_LABEL = "Dashboard sign-in";
export const OPENAPI_PATH = "/openapi.yaml";

// ── Presets: what to pick when making an app ──

/**
 * The choices on "Create app". Each is the least access that kind of program needs. `orders`: the key can place
 * practice (paper) orders. A preset never offers live trading: a key that can move money is made on purpose, from
 * this computer's command line (see the safety guide).
 */
export const APP_PRESETS = Object.freeze([
  {
    id: "read", word: "Data", name: "Read prices and data", blurb: "A script, notebook or service that reads prices, history, option chains and positions.",
    scopes: ["read"], clientKind: "script", expiresDays: 90, allowQuery: false, orders: false, glyph: "chart", tint: "teal",
    can: ["Read prices, candles, option chains, positions and funds.", "Download history and watch live events."],
    cannot: ["It cannot place, change or cancel any order.", "It cannot make keys or change settings."],
  },
  {
    id: "paper", word: "Practice", name: "Practice orders", blurb: "A script or bot that tries ideas with paper (practice) orders. Real money is never at risk.",
    scopes: ["paper"], clientKind: "script", expiresDays: 90, allowQuery: false, orders: true, glyph: "orders", tint: "orange",
    can: ["Everything a read key can do.", "Place and cancel paper orders."],
    cannot: ["It cannot place a real-money order.", "It cannot make keys or change settings."],
  },
  {
    id: "sheet", word: "Sheet", name: "Spreadsheet", blurb: "Excel or Google Sheets. It may sit in a web address, so it can only read and it expires.",
    scopes: ["read"], clientKind: "excel", expiresDays: 90, allowQuery: true, orders: false, glyph: "integrations", tint: "green",
    can: ["Read prices through the spreadsheet routes."],
    cannot: ["It cannot place any order.", "A key in a web address can leak: keep it read only and revoke it when done."],
  },
  {
    id: "assistant", word: "Assistant", name: "AI assistant", blurb: "Claude, ChatGPT or any program that uses the Bridge's AI tools (MCP).",
    scopes: ["read"], clientKind: "mcp", expiresDays: null, allowQuery: false, orders: false, glyph: "bolt", tint: "purple",
    can: ["Read prices, charts and positions through the AI tools."],
    cannot: ["It cannot place an order.", "It can never confirm an order on its own: that stays with you."],
  },
  {
    id: "admin", word: "Admin", name: "Admin tools", blurb: "Manage keys, quotas and event subscriptions from this computer. Short lived on purpose.",
    scopes: ["admin"], clientKind: "script", expiresDays: 7, allowQuery: false, orders: false, glyph: "keys", tint: "red",
    can: ["Make and revoke keys, change quotas, create event subscriptions.", "Read everything a read key can."],
    cannot: ["It works from this computer only.", "It cannot place orders. Give it only to programs you run yourself."],
  },
]);
export const presetById = (id) => APP_PRESETS.find((p) => p.id === id) ?? APP_PRESETS[0];

/** The expiry choices on the form: [days or "", label]. */
export const EXPIRY_CHOICES = Object.freeze([["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["", "Never"]]);

/** A name that tells apps apart: "Data app · 9 Nov", with " 2", " 3" when that name is taken. */
export function defaultAppName(presetId, when = new Date(), taken = []) {
  const word = presetById(presetId).word;
  const base = `${word} app · ${formatDayMonth(istDay(when))}`;
  const used = new Set(taken.map((t) => String(t).trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; n < 100; n++) if (!used.has(`${base} ${formatInt(n)}`.toLowerCase())) return `${base} ${formatInt(n)}`;
  return base;
}

/**
 * The POST /v1/keys body for a preset, or the problem to show on the form. Least privilege: exactly the preset's
 * scopes (never live), accounts "*" unless one is chosen.
 * @param {string} presetId
 * @param {{ name?: string, expiresDays?: string | number | null, account?: string, now?: Date }} [o]
 * @returns {{ body: object } | { error: { field: string, message: string } }}
 */
export function appBody(presetId, { name = "", expiresDays, account = "*", now = new Date() } = {}) {
  const preset = presetById(presetId);
  const problem = keyFormProblem({ label: name, scopes: preset.scopes, allowQuery: preset.allowQuery });
  if (problem) return { error: problem };
  const body = { label: String(name).trim(), scopes: [...preset.scopes], accounts: account && account !== "*" ? [account] : "*", clientKind: preset.clientKind };
  const days = expiresDays === undefined ? preset.expiresDays : expiresDays === "" || expiresDays === null ? null : Number(expiresDays);
  if (days) body.expiresAt = new Date(now.getTime() + days * 86_400_000).toISOString();
  if (preset.allowQuery) body.allowQuery = true;
  return { body };
}

// ── Scopes in words ──

export const SCOPE_WORD = Object.freeze({ read: "Read only", paper: "Paper orders", live: "Live orders", admin: "Admin" });
export const SCOPE_TONE = Object.freeze({ read: "info", paper: "info", live: "bad", admin: "warn" });
const RANK = Object.freeze({ read: 1, paper: 2, live: 3, admin: 4 });

/** The headline scope of a key (the strongest it holds), as { id, word, tone }. */
export function scopeBadge(scopes = []) {
  const top = [...scopes].sort((a, b) => (RANK[b] ?? 0) - (RANK[a] ?? 0))[0] ?? "read";
  return { id: top, word: SCOPE_WORD[top] ?? top, tone: SCOPE_TONE[top] ?? "info" };
}

// ── Apps: a key with its scope, quota and use ──

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "2 days ago", then the date. Never throws on bad input: "never". */
export function agoText(iso, now = Date.now()) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "never";
  const d = now - t;
  if (d < 45_000) return "just now";
  if (d < HOUR) return `${Math.max(1, Math.round(d / MINUTE))} min ago`;
  if (d < DAY) return `${Math.round(d / HOUR)} h ago`;
  if (d < 14 * DAY) return `${Math.round(d / DAY)} days ago`;
  return `on ${formatDayMonth(istDay(new Date(t)))}`;
}

/** When a key stops working, in words: "expires in 12 days", "expired 3 days ago", "no expiry". */
export function expiryText(iso, now = Date.now()) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "no expiry";
  const d = t - now;
  if (d <= 0) return `expired ${agoText(iso, now)}`.replace("expired on ", "expired ");
  if (d < HOUR) return "expires within the hour";
  if (d < DAY) return `expires in ${Math.round(d / HOUR)} h`;
  return `expires in ${Math.round(d / DAY)} days`;
}

/** "50 a second, burst 50, no daily cap". */
export function quotaText(q) {
  if (!q) return "default quota";
  const per = Number(q.perSecond);
  const secs = Number.isFinite(per) ? `${formatInt(per)} a second` : "a default rate";
  const cap = q.perDay ? `${formatInt(q.perDay)} a day` : "no daily cap";
  return `${secs}, burst ${formatInt(q.burst)}, ${cap}`;
}

/**
 * Apps = keys, joined with their quota and use. Revoked and expired keys sort last; the dashboard's own sign-in keys
 * are left out (they are not something a developer made).
 * @param {{ keys?: object[], quotas?: { keys?: object[] } | null, now?: number, ownKeyId?: string | null }} o
 */
export function buildApps({ keys = [], quotas = null, now = Date.now(), ownKeyId = null } = {}) {
  const q = new Map((quotas?.keys ?? []).map((k) => [k.keyId, k]));
  const rows = keys
    .filter((k) => k.label !== DASHBOARD_KEY_LABEL)
    .map((k) => {
      const quota = q.get(k.id) ?? null;
      const expired = Boolean(k.expiresAt) && Date.parse(k.expiresAt) <= now;
      const status = k.revokedAt ? "revoked" : expired ? "expired" : k.expiresAt && Date.parse(k.expiresAt) - now < 7 * DAY ? "expiring" : "active";
      return {
        id: k.id,
        name: k.label,
        scopes: k.scopes ?? [],
        badge: scopeBadge(k.scopes),
        clientKind: k.clientKind ?? "other",
        accounts: k.accounts ?? "*",
        accountsText: k.accounts === "*" || !k.accounts ? "all accounts" : k.accounts.join(", "),
        allowQuery: k.allowQuery === true,
        status,
        statusText: { active: "Active", expiring: "Expires soon", expired: "Expired", revoked: "Revoked" }[status],
        expiresAt: k.expiresAt ?? null,
        expiryText: k.revokedAt ? "revoked" : expiryText(k.expiresAt, now),
        lastUsedAt: k.lastUsedAt ?? null,
        lastUsedText: agoText(k.lastUsedAt, now),
        createdAt: k.createdAt ?? null,
        requestsToday: quota?.usage?.today ?? 0,
        requestsLastMinute: quota?.usage?.lastMinute ?? 0,
        throttledToday: quota?.usage?.throttledToday ?? 0,
        quota,
        quotaText: quotaText(quota),
        quotaCustom: quota?.source === "override",
        own: ownKeyId === k.id,
        usable: status === "active" || status === "expiring",
      };
    });
  const order = { active: 0, expiring: 0, expired: 1, revoked: 2 };
  return rows.sort((a, b) => order[a.status] - order[b.status] || (Date.parse(b.lastUsedAt ?? "") || 0) - (Date.parse(a.lastUsedAt ?? "") || 0) || (Date.parse(b.createdAt ?? "") || 0) - (Date.parse(a.createdAt ?? "") || 0));
}

/** One line for an app row: what it did lately. */
export function appUseLine(app) {
  if (!app.usable && app.status === "revoked") return "Revoked. It no longer works.";
  const n = app.requestsToday;
  const used = app.lastUsedAt ? `Last used ${app.lastUsedText}` : "Never used yet";
  const calls = n === 0 ? "no requests today" : `${formatInt(n)} request${n === 1 ? "" : "s"} today`;
  const slow = app.throttledToday > 0 ? `, ${formatInt(app.throttledToday)} slowed down` : "";
  return `${used} · ${calls}${slow}`;
}

/** The key in the snippets when the real one is not known (it is shown once, at creation): the key id, then a clear gap. */
export const keyPlaceholder = (app) => `mcb_${app.id}_PASTE_THE_SECRET_HERE`;

/**
 * The ready-to-paste setups for an app, with this Bridge's real address: curl, Node, Python, and (only when the key
 * is allowed in a web address) Excel, or the AI settings for an assistant key.
 * @param {{ id: string, scopes: string[], allowQuery?: boolean, clientKind?: string }} app
 * @param {{ base: string, key?: string | null, folder?: string, account?: string }} o
 * @returns {Array<{ id: string, label: string, blocks: Array<{ title: string, lang: string, code: string }> }>}
 */
export function appSnippetGroups(app, { base, key = null, folder = "/path/to/api-bridge-v2", account = "demo-paper" }) {
  const k = key ?? keyPlaceholder(app);
  const orders = app.scopes.includes("paper") || app.scopes.includes("live");
  const all = snippets({ base, key: k, account, folder, orders });
  const groups = [
    { id: "curl", label: "curl", blocks: all.rest },
    { id: "node", label: "Node", blocks: all.node },
    { id: "python", label: "Python", blocks: all.python },
  ];
  if (app.allowQuery) groups.push({ id: "excel", label: "Excel", blocks: all.excel });
  if (app.clientKind === "mcp") groups.push({ id: "assistant", label: "AI assistant", blocks: all.claude });
  return groups;
}

// ── Starters ──

/** The `mc-bridge init` starters (server/bridge/starters/starters.mjs is the source; a test keeps this list the same). */
export const STARTERS = Object.freeze([
  { id: "node", title: "Node", about: "Prices, history, data downloads and events. No packages." },
  { id: "python", title: "Python", about: "The same from Python 3.9 or newer. Standard library only." },
  { id: "curl", title: "curl", about: "Shell scripts that handle the key, errors and retries." },
  { id: "sheets", title: "Google Sheets", about: "The Bridge's Apps Script, with a check to run first." },
  { id: "webhook-receiver", title: "Webhook receiver", about: "Receives the Bridge's signed events and checks them." },
  { id: "mcp-client", title: "MCP client", about: "Use the Bridge's AI tools from your own program." },
]);
export const starterCommand = (id, cli = "mc-bridge") => `${cli} init ${id}${id === "webhook-receiver" ? "" : " --with-key"}`;

/**
 * The three steps of "zero to a working call". Plain data, so the page and the tests agree.
 * @param {{ base: string, cli?: string, haveApps: boolean }} o
 */
export function quickStart({ base, cli = "mc-bridge", haveApps = false }) {
  return [
    { n: 1, id: "address", title: "Check the Bridge answers", text: "This is the address of your Bridge. It needs no key.", code: `curl ${base}/v1/health` },
    { n: 2, id: "app", title: haveApps ? "Use an app, or make one for this work" : "Make an app", text: "An app is one key with only the access its job needs. It is shown once; keep it in an environment variable or a .env file, never in code you share.", code: null },
    { n: 3, id: "call", title: "Make your first call", text: "Replace the key and run it. Every price says how fresh it is and where it came from.", code: `export BRIDGE_KEY=mcb_...\ncurl -H "Authorization: Bearer $BRIDGE_KEY" "${base}/v1/ltp?symbols=NSE:RELIANCE,NSE:NIFTY"` },
  ];
}

// ── The live request log, by app ──

/** Colour of a status (never the only carrier: the number is shown). */
export const statusTone = (n) => (n < 300 ? "ok" : n < 500 ? "warn" : "bad");

/**
 * The filter choices: every app that appears in the log or exists, plus the dashboard and "no key".
 * @returns {Array<[string, string]>} [value, label]
 */
export function logFilters(apps, requests = []) {
  const seen = new Set(requests.map((r) => r.keyId).filter(Boolean));
  const names = new Map(apps.map((a) => [a.id, a.name]));
  const keyed = [...new Set([...apps.filter((a) => a.usable || seen.has(a.id)).map((a) => a.id), ...seen])].map((id) => [id, names.get(id) ?? `Key ${id}`]);
  return [["all", "All apps"], ...keyed, ["dashboard", "This dashboard"], ["none", "No key"]];
}

/**
 * The requests that belong to one filter value, then to a status and a search word. Requests the dashboard makes for
 * itself carry client "dashboard"; they are in "All apps" only when `includeDashboard` is set.
 * @param {object[]} requests @param {{ app?: string, status?: "all"|"ok"|"err", q?: string, includeDashboard?: boolean }} f
 */
export function filterRequests(requests, { app = "all", status = "all", q = "", includeDashboard = false } = {}) {
  const needle = q.trim().toLowerCase();
  return requests.filter((x) => {
    if (app === "dashboard") {
      if (x.client !== "dashboard") return false;
    } else if (app === "none") {
      if (x.keyId) return false;
    } else if (app !== "all") {
      if (x.keyId !== app) return false;
    } else if (!includeDashboard && x.client === "dashboard") return false;
    if (status === "ok" && x.status >= 400) return false;
    if (status === "err" && x.status < 400) return false;
    return !needle || `${x.method} ${x.path} ${x.status}`.toLowerCase().includes(needle);
  });
}

/** Counts for the strip above the log. */
export function requestStats(list) {
  const errors = list.filter((x) => x.status >= 400).length;
  const ms = list.map((x) => x.ms).filter(Number.isFinite).sort((a, b) => a - b);
  return { total: list.length, errors, ok: list.length - errors, medianMs: ms.length ? ms[Math.floor(ms.length / 2)] : null };
}

/** Whose request a row is: the app's name, "This dashboard", or "No key". */
export function requestOwner(x, apps) {
  if (x.client === "dashboard") return "This dashboard";
  if (!x.keyId) return "No key";
  return apps.find((a) => a.id === x.keyId)?.name ?? `Key ${x.keyId}`;
}

// ── The scope finder ──

/** What a route needs, from GET /v1/meta: { scope, auth, words }. */
export function routeAccess(route) {
  const auth = route.auth ?? "key";
  if (auth === "none") return { scope: null, auth, words: "No key needed." };
  if (auth === "custom") return { scope: null, auth, words: "Signs in its own way (a signature or a key in the body), not with the Authorization header." };
  const scope = route.scope ?? "read";
  return { scope, auth, words: scopeAdvice(scope) };
}

/** Which keys work for a scope, in words. */
export function scopeAdvice(scope) {
  switch (scope) {
    case "read": return "Any key works: read, paper, live or admin.";
    case "paper": return "Needs a key with the paper scope. A live key works too.";
    case "live": return "Needs a key with the live scope. It is made on purpose from this computer's command line.";
    case "admin": return "Needs an admin key, and works from this computer only.";
    default: return "Needs an API key.";
  }
}

/** The app preset that gives a scope, or null (live is never a preset). */
export const presetForScope = (scope) => ({ read: "read", paper: "paper", admin: "admin" })[scope] ?? null;

/**
 * Routes that match what a person typed ("orders", "get option chain", "POST /v1/keys"), best first.
 * @param {Array<{ method: string, path: string, scope?: string | null, auth?: string }>} routes
 */
export function findRoutes(routes, query, limit = 8) {
  const words = String(query ?? "").toLowerCase().split(/[\s/]+/).filter(Boolean);
  if (!words.length) return [];
  const scored = [];
  for (const r of routes) {
    const hay = `${r.method} ${r.path}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    // Shorter paths and a match at the start of a path segment rank higher.
    const segment = words.filter((w) => hay.includes(`/${w}`)).length;
    scored.push({ r, score: segment * 100 - r.path.length });
  }
  return scored.sort((a, b) => b.score - a.score || a.r.path.localeCompare(b.r.path)).slice(0, limit).map(({ r }) => ({ method: r.method, path: r.path, ...routeAccess(r) }));
}

// ── The error catalogue (GET /v1/errors) ──

export const ERROR_GROUPS = Object.freeze([["all", "All"], ["request", "Your request"], ["rate", "Slow down"], ["server", "Bridge or broker"]]);
/** Which group a status belongs to: your request (4xx), slow down (429) or the Bridge or broker (5xx). */
export const errorGroup = (status) => (status === 429 ? "rate" : status < 500 ? "request" : "server");

/**
 * @param {Array<{ code: string, status: number, title: string, retryable: boolean, means: string, fix: string }>} entries
 * @param {{ q?: string, group?: string, status?: number | null }} f
 */
export function filterCatalogue(entries, { q = "", group = "all", status = null } = {}) {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((e) => {
    if (status !== null && e.status !== status) return false;
    if (group !== "all" && errorGroup(e.status) !== group) return false;
    const hay = `${e.code} ${e.status} ${e.title} ${e.means} ${e.fix}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The statuses worth a "look it up" button in the log (an error row). */
export const isErrorStatus = (n) => Number.isFinite(n) && n >= 400;

/** The shape of an error answer for one catalogue entry, as pretty JSON (the dashboard shows it under each code). */
export function sampleProblem(e) {
  const p = { title: e.title, status: e.status, detail: "Plain words for a person. Do not parse this.", code: e.code, retryable: e.retryable, requestId: "req_..." };
  if (e.status === 429) Object.assign(p, { scope: "client", retryAfterMs: 1200 });
  if (e.code === "VALIDATION_FAILED") p.errors = [{ path: "symbols", message: "Required" }];
  return JSON.stringify(p, null, 2);
}

/** What a key may and may not do, for a key made outside the presets (an older key, or one from the command line). */
export function capabilityLines(scopes = [], clientKind = "other") {
  const hit = APP_PRESETS.find((p) => p.clientKind === clientKind && p.scopes.length === scopes.length && p.scopes.every((s) => scopes.includes(s)));
  if (hit) return { can: hit.can, cannot: hit.cannot };
  const top = scopeBadge(scopes).id;
  if (top === "admin") return { can: ["Make and revoke keys, change quotas, create event subscriptions.", "Read everything a read key can."], cannot: ["It works from this computer only."] };
  if (top === "live") return { can: ["Read data, place paper orders, and place real orders when every live opt-in is on."], cannot: ["It cannot confirm an order ticket for you: approval stays on this computer."] };
  if (top === "paper") return { can: ["Read data and place paper orders."], cannot: ["It cannot place a real-money order.", "It cannot make keys or change settings."] };
  return { can: ["Read prices, history, option chains and positions."], cannot: ["It cannot place or change any order.", "It cannot make keys or change settings."] };
}

// ── Events: order and data events sent to your own program ──

/** The topics in plain groups. A topic belongs to the first group whose prefix it starts with. */
export const EVENT_GROUPS = Object.freeze([
  { id: "orders", title: "Orders and trading", blurb: "An order filled or was rejected, a position moved, an account can or cannot trade.", prefixes: ["order.", "orders.", "position.", "trading.", "ticket.", "hook."] },
  { id: "data", title: "Downloads and recordings", blurb: "A download finished or failed, a recording started, stopped, missed data or is low on disk.", prefixes: ["download.", "recording.", "collection."] },
  { id: "accounts", title: "Accounts and price feeds", blurb: "A broker login changed, a price feed went up or down, a rate limit slowed a request.", prefixes: ["account.", "stream.", "limits."] },
  { id: "safety", title: "Safety and housekeeping", blurb: "The kill switch changed, a daily limit was reached, a backup finished or failed, the disk is nearly full, or the computer woke from sleep.", prefixes: ["safety.", "backup.", "config.", "storage.", "system.", "data."] },
]);

/** Group the Bridge's topic list (`GET /v1/events/topics`) for the form. Topics no group claims go in a last "Other" group. */
export function groupTopics(topics = []) {
  const groups = EVENT_GROUPS.map((g) => ({ ...g, topics: [] }));
  const other = { id: "other", title: "Other", blurb: "", prefixes: [], topics: [] };
  for (const t of topics) (groups.find((g) => g.prefixes.some((p) => t.topic.startsWith(p))) ?? other).topics.push(t);
  return [...groups, other].filter((g) => g.topics.length);
}

/**
 * The topic filters to send for the topics ticked: a whole family ("order.*") when every topic of it is ticked, "*" when
 * everything is, otherwise the names. New topics of a ticked family are then included without editing anything.
 */
export function collapseTopics(selected, all) {
  const chosen = [...new Set(selected)];
  if (all.length && chosen.length === all.length) return ["*"];
  const family = (t) => t.split(".")[0];
  const out = [];
  const done = new Set();
  for (const t of chosen) {
    const f = family(t);
    if (done.has(f)) continue;
    const members = all.filter((x) => family(x) === f);
    if (members.length > 1 && members.every((x) => chosen.includes(x))) {
      out.push(`${f}.*`);
      done.add(f);
    } else out.push(t);
  }
  return out;
}

/** A signing secret: 64 hex characters from 32 random bytes (the Bridge asks for 16 to 256 characters). */
export function secretFromBytes(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The first thing wrong with the add-a-receiver form, or "". The Bridge makes the final call (https, allowed hosts). */
export function receiverProblem({ url = "", topics = [] } = {}) {
  const u = String(url).trim();
  if (!u) return "Type the address your program listens on, for example https://example.com/bridge/events.";
  if (!/^https?:\/\/[^\s/]+/i.test(u)) return "The address must start with https:// (or http:// for a program on this computer or network).";
  if (!topics.length) return "Tick at least one kind of event.";
  return "";
}

/** The body for POST /v1/subscriptions. */
export function receiverBody({ url, label = "", topics, allTopics, secret }) {
  const body = { url: String(url).trim(), topics: collapseTopics(topics, allTopics), secret };
  if (String(label).trim()) body.label = String(label).trim().slice(0, 60);
  return body;
}

const HEALTH = Object.freeze({
  ok: { word: "Working", tone: "ok" },
  unverified: { word: "Not tested yet", tone: "info" },
  failing: { word: "Failing", tone: "bad" },
  paused: { word: "Paused", tone: "" },
  "needs-secret": { word: "Needs a new secret", tone: "warn" },
});

/** "order.*" becomes "all order events", "*" becomes "Everything". A few names, then "and 2 more". */
export function topicsText(topics = []) {
  if (topics.includes("*")) return "Everything";
  const word = (t) => (t.endsWith(".*") ? `all ${t.slice(0, -2)} events` : t);
  if (topics.length <= 3) return topics.map(word).join(", ");
  return `${topics.slice(0, 2).map(word).join(", ")} and ${topics.length - 2} more`;
}

/** One receiver as a row and a sheet show it. */
export function receiverView(s, now = Date.now()) {
  const hl = s?.health ?? {};
  const st = HEALTH[hl.state] ?? HEALTH.unverified;
  const counts = [];
  if (hl.delivered) counts.push(`${formatInt(hl.delivered)} delivered`);
  if (hl.failed) counts.push(`${formatInt(hl.failed)} failed`);
  const last = hl.lastFailure && hl.state === "failing" ? `Last problem: ${hl.lastFailure.message}` : hl.lastDeliveredAt ? `Last delivery ${agoText(hl.lastDeliveredAt, now)}` : "Nothing delivered yet";
  return {
    id: s?.id ?? "",
    title: s?.label || s?.host || "Receiver",
    host: s?.host ?? "",
    topics: topicsText(s?.topics ?? []).replace(/^./, (c) => c.toUpperCase()),
    state: st,
    active: s?.active !== false,
    counts: counts.join(", "),
    last,
    pending: s?.pending ?? 0,
    deadLetters: s?.deadLetters ?? 0,
    failure: hl.lastFailure ?? null,
  };
}

/** One delivery attempt as a line: "Delivered", or why not. */
export function deliveryLine(d, now = Date.now()) {
  const ok = d?.ok === true;
  const word = ok ? "Delivered" : d?.outcome === "retry" ? "Will try again" : d?.outcome === "dead" ? "Gave up" : "Failed";
  return { topic: d?.topic ?? "", word, tone: ok ? "ok" : d?.outcome === "retry" ? "warn" : "bad", when: agoText(d?.at, now), detail: ok ? (d?.durationMs != null ? `${formatInt(d.durationMs)} ms` : "") : (d?.message ?? ""), test: d?.topic === "subscription.test" };
}

/** A recent event as a row: its topic, when, and a few facts from its data. */
export function eventLine(e, nowMs = Date.now()) {
  const d = e?.data && typeof e.data === "object" ? e.data : {};
  const facts = Object.entries(d)
    .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v) && String(v).length <= 40)
    .slice(0, 3)
    .map(([k, v]) => `${k} ${v}`);
  const t = Date.parse(e?.time ?? "");
  return { id: String(e?.id ?? ""), topic: String(e?.topic ?? ""), when: Number.isFinite(t) ? agoText(new Date(t).toISOString(), nowMs) : "", facts: facts.join(" · ") };
}
