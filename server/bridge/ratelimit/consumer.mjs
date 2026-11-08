/**
 * Who caused a broker call: a short consumer name carried through async work (AsyncLocalStorage), so the rate-limit
 * engine can say which tool, page or background job used the budget ("Top consumers" on API › Rate limits).
 *
 * The HTTP pipeline runs each request as its consumer (core/app.mjs: the dashboard page, else the API key's label);
 * background jobs wrap their work in runAsConsumer("Data recorder", fn). Work started inside a run (timers, promises,
 * the market-data batcher's flush) keeps the name of the run that started it, so a batched or coalesced call is
 * credited to the caller that opened it and the callers that joined it are counted as saved calls.
 *
 * Names are labels only: never a key, token or anything secret. They are cleaned to 48 printable characters.
 *
 * FAIRNESS IDENTITY. Next to the name the run can carry a request context (runAsConsumer(name, fn, ctx)); the
 * scheduler's fair queue shares a lane between consumers by `fairKey`, never by name (names collide: every
 * dashboard page has its own). The key is the API key id ("key:<id>"), else the principal kind ("principal:hook"),
 * else, for a background job that only has a name, "job:<name>". The context is read when work is scheduled, so a
 * handler that authenticates itself after the run began (the compat routes) is still attributed to its key.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();

/** Weight of a consumer's share in a contended lane, by the kind of key (ratelimit.client.kindWeights may change them). */
export const DEFAULT_KIND_WEIGHTS = Object.freeze({ ui: 4, mcp: 2, excel: 1, script: 1, other: 1 });

/** A consumer name as shown: printable, single spaces, at most 48 characters; null when nothing is left. */
export function consumerName(raw) {
  const s = String(raw ?? "")
    .replace(/[^\p{L}\p{N} ·:/()._+&-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
  return s || null;
}

/**
 * Run fn as `name` (a cleaned consumer name). `ctx` (optional) is the request context the fairness identity is read from.
 * @param {string} name
 * @param {() => any} fn
 * @param {{ key?: { id?: string, clientKind?: string, label?: string } | null, principal?: { kind?: string, id?: string, label?: string } | null } | null} [ctx]
 */
export function runAsConsumer(name, fn, ctx = null) {
  return als.run({ name: consumerName(name) ?? "Other", ctx }, fn);
}

/** The consumer name of the work running now, or null. */
export function currentConsumer() {
  return als.getStore()?.name ?? null;
}

/**
 * Who the fair queue should treat the running work as: `{ name, fairKey, keyId, clientKind, label }`, or null when
 * the work runs outside any consumer (internal calls share one unnamed consumer).
 */
export function currentConsumerInfo() {
  const store = als.getStore();
  return store ? consumerIdentity(store.name, store.ctx) : null;
}

/**
 * Pure: the fairness identity of a named consumer and its request context.
 * @param {string} name
 * @param {{ key?: any, principal?: any } | null} [ctx]
 */
export function consumerIdentity(name, ctx = null) {
  const keyId = typeof ctx?.key?.id === "string" ? ctx.key.id : null;
  if (keyId) {
    return { name, fairKey: `key:${keyId}`, keyId, clientKind: ctx.key.clientKind ?? "other", label: consumerName(ctx.key.label) ?? name };
  }
  const kind = ctx?.principal?.kind;
  if (kind && kind !== "key") return { name, fairKey: `principal:${kind}`, keyId: null, clientKind: "other", label: name };
  return { name, fairKey: `job:${name}`, keyId: null, clientKind: "other", label: name };
}

/** Dashboard page ids a request may name in X-MCB-Page (anything else is just "Dashboard"). */
const PAGE_NAMES = Object.freeze({
  home: "Home",
  chain: "Option Chain",
  strategy: "Strategy",
  positions: "Positions",
  orders: "Orders",
  safety: "Safety",
  oi: "OI Analysis",
  participants: "OI Analysis",
  vol: "Volatility",
  screener: "Screeners",
  arb: "Screeners",
  events: "Live events",
  scanner: "Stock scanner",
  calendar: "Market calendar",
  accounts: "Accounts",
  keys: "API",
  integrations: "API",
  console: "API",
  limits: "API",
  activity: "API",
  recorder: "Data recorder",
  prefetch: "prefetch",
});

/**
 * The consumer of one HTTP request (pure): "Dashboard · Option Chain" for the dashboard, "MCP" and "Excel / compat"
 * by path, else "Key: <label>" for an API key, "This computer" for the local CLI.
 * @param {{ headers: Record<string, any>, path: string, principal?: { kind?: string, label?: string } | null }} r
 */
export function httpConsumer({ headers = {}, path = "", principal = null } = {}) {
  if (headers["x-mcb-client"] === "dashboard") {
    const page = PAGE_NAMES[String(headers["x-mcb-page"] ?? "").toLowerCase()];
    if (page === "prefetch") return "Dashboard · prefetch";
    return page ? `Dashboard · ${page}` : "Dashboard";
  }
  if (path.startsWith("/mcp")) return "MCP (AI tools)";
  if (path.startsWith("/api/v1")) return "Excel / compat";
  if (principal?.kind === "local") return "This computer";
  const label = consumerName(principal?.label);
  return label ? `Key: ${label}` : "API";
}
