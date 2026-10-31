/**
 * Request context: what every handler receives. Built by app.mjs for each HTTP request, and by non-HTTP callers
 * (MCP tools, webhook workers, CLI) through createCallContext() so services always see the same shape.
 *
 * Scopes (stored on API keys; see docs/ARCHITECTURE.md §8):
 *   read   market data, instruments, accounts, portfolio, orders list, limits
 *   paper  read + paper orders
 *   live   paper + live orders (the account must also be live-enabled in config, and the request must say mode "live")
 *   admin  read + keys, audit, kill-switch release, account sessions (loopback only)
 */
import { randomUUID } from "node:crypto";
import { BridgeError } from "./errors.mjs";

export const SCOPES = Object.freeze(["read", "paper", "live", "admin"]);
const IMPLIES = Object.freeze({ read: ["read"], paper: ["paper", "read"], live: ["live", "paper", "read"], admin: ["admin", "read"] });

/**
 * Sources that are automations, never a person: they may not confirm an order ticket (the human confirmation gate).
 * "guard" and "alert" are the Phase 1 automations (strategy guards, alert actions).
 */
export const AUTOMATED_SOURCES = Object.freeze(["mcp", "webhook", "guard", "alert"]);
/** Principal kinds that are automations (hooks and in-process guards). */
const AUTOMATED_PRINCIPALS = new Set(["hook", "guard"]);

/**
 * Whether a context belongs to an automation rather than a person: an automated source, a key whose clientKind is
 * "mcp", or a hook / guard principal.
 * @param {{ source?: string, key?: { clientKind?: string } | null, principal?: { kind?: string } }} ctx
 */
export function isAutomatedContext(ctx) {
  if (AUTOMATED_SOURCES.includes(ctx?.source)) return true;
  if (ctx?.key?.clientKind === "mcp") return true;
  return AUTOMATED_PRINCIPALS.has(ctx?.principal?.kind);
}

/** Expand granted scopes with what they imply. */
export function expandScopes(granted) {
  const out = new Set();
  for (const s of granted ?? []) for (const x of IMPLIES[s] ?? []) out.add(x);
  return out;
}

/** Whether a set of granted scopes satisfies `needed`. */
export function hasScope(granted, needed) {
  return expandScopes(granted).has(needed);
}

/**
 * @typedef {{ id: string, label: string, scopes: string[], accounts: string[] | "*", allowQuery?: boolean,
 *   clientKind?: "script"|"excel"|"mcp"|"ui"|"other", createdAt: string, expiresAt?: string | null,
 *   lastUsedAt?: string | null, revokedAt?: string | null }} KeyRecord
 *   Public view of an API key. Never holds the key or its hash.
 * @typedef {{ kind: "key", id: string, label: string } | { kind: "hook", id: string, label?: string } |
 *   { kind: "guard", id: string, label?: string } | { kind: "local", id: "cli" } | { kind: "anonymous", id: "anonymous" }} Principal
 *   A "guard" principal is built in-process only (strategy guards, docs/spec/p1-12); like a hook it may use only the
 *   accounts in ctx.hookAccounts.
 * @typedef {"rest" | "webhook" | "mcp" | "cli" | "stream" | "system" | "guard" | "alert"} Source
 *   "guard" and "alert" are automated sources (strategy guards and alert actions, Phase 1); live orders from them
 *   still need the source in the account's live.allowedSources.
 *
 * @typedef {object} RequestContext
 * @property {string} requestId
 * @property {string} method
 * @property {string} path
 * @property {Record<string, string>} params
 * @property {URLSearchParams} query
 * @property {unknown} body           Parsed body (route option `body`).
 * @property {Buffer | undefined} rawBody  Only for routes with body "raw" or "json-or-text" (HMAC checks).
 * @property {KeyRecord | null} key
 * @property {Set<string>} scopes     Expanded scopes of the key ("custom" routes may set them).
 * @property {Principal} principal
 * @property {Source} source
 * @property {string} clientIp
 * @property {boolean} loopback       TCP peer is loopback.
 * @property {boolean} viaPublicIngress
 * @property {AbortSignal} signal     Aborts when the client disconnects.
 * @property {number} startedAt
 * @property {import("./logger.mjs").Logger} log
 * @property {import("node:http").IncomingMessage} [req]
 * @property {import("node:http").ServerResponse} [res]
 * @property {(scope: string) => void} requireScope
 * @property {(accountId: string) => void} requireAccountAccess  Key may use this account (does not check it exists).
 * @property {(accounts: "*" | string[]) => boolean} canAccessAccounts  Key may use every one of these accounts ("*" needs an
 *   unlimited key). Admin routes use it so an account-limited admin key only sees and manages keys and hooks for its accounts.
 * @property {(name: string, value: string) => void} setHeader   Add a response header (RateLimit, Idempotency-Replayed ...).
 * @property {Record<string, string>} responseHeaders
 * @property {boolean} [confirmationRequired]  Set for webhook signals whose hook requires a person to confirm each
 *   order (OrderService then opens a ticket instead of placing).
 * @property {string[]} [hookAccounts]   Accounts a webhook principal may use.
 */

export function newRequestId() {
  return `req_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function attachHelpers(ctx) {
  ctx.requireScope = (scope) => {
    if (!ctx.scopes.has(scope)) {
      throw new BridgeError(ctx.key || ctx.principal.kind !== "anonymous" ? "SCOPE_REQUIRED" : "UNAUTHENTICATED", ctx.key ? `This API key needs the "${scope}" scope.` : undefined);
    }
  };
  ctx.requireAccountAccess = (accountId) => {
    if (ctx.principal.kind === "local") return;
    const allowed = ctx.key?.accounts;
    if (allowed === "*" || (Array.isArray(allowed) && allowed.includes(accountId))) return;
    if ((ctx.principal.kind === "hook" || ctx.principal.kind === "guard") && ctx.hookAccounts?.includes(accountId)) return;
    throw new BridgeError("ACCOUNT_FORBIDDEN", `This key may not use account ${accountId}.`);
  };
  ctx.canAccessAccounts = (accounts) => {
    if (ctx.principal.kind === "local") return true;
    const allowed = ctx.key?.accounts;
    if (allowed === "*") return true;
    if (accounts === "*" || !Array.isArray(allowed) || !Array.isArray(accounts)) return false;
    return accounts.every((a) => allowed.includes(a));
  };
  ctx.setHeader = (name, value) => {
    ctx.responseHeaders[name] = String(value);
  };
  return ctx;
}

/**
 * Context for calls that do not come from an HTTP request (MCP tools, webhook workers, CLI, background jobs).
 * @param {{ source: Source, principal?: Principal, key?: KeyRecord | null, scopes?: Iterable<string>, log: import("./logger.mjs").Logger,
 *   requestId?: string, signal?: AbortSignal, hookAccounts?: string[], confirmationRequired?: boolean }} opts
 * @returns {RequestContext}
 */
export function createCallContext({ source, principal, key = null, scopes, log, requestId = newRequestId(), signal, hookAccounts, confirmationRequired }) {
  const ctx = {
    requestId,
    method: "CALL",
    path: "",
    params: {},
    query: new URLSearchParams(),
    body: undefined,
    rawBody: undefined,
    key,
    scopes: expandScopes(scopes ?? key?.scopes ?? []),
    principal: principal ?? (key ? { kind: "key", id: key.id, label: key.label } : { kind: "anonymous", id: "anonymous" }),
    source,
    clientIp: "",
    loopback: true,
    viaPublicIngress: false,
    signal: signal ?? new AbortController().signal,
    startedAt: Date.now(),
    log: log.child({ requestId, source }),
    responseHeaders: {},
    hookAccounts,
  };
  if (confirmationRequired !== undefined) ctx.confirmationRequired = confirmationRequired === true;
  return attachHelpers(ctx);
}

/**
 * Context for an HTTP request (app.mjs). Auth fields are filled in later by the pipeline.
 * @returns {RequestContext}
 */
export function createHttpContext({ req, res, url, params, log, viaPublicIngress, requestId = newRequestId() }) {
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) ac.abort();
  });
  const clientIp = req.socket?.remoteAddress ?? "";
  const ctx = {
    requestId,
    method: req.method,
    path: url.pathname,
    params,
    query: url.searchParams,
    body: undefined,
    rawBody: undefined,
    key: null,
    scopes: new Set(),
    principal: { kind: "anonymous", id: "anonymous" },
    source: "rest",
    clientIp,
    loopback: false,
    viaPublicIngress,
    signal: ac.signal,
    startedAt: Date.now(),
    log: log.child({ requestId }),
    req,
    res,
    responseHeaders: {},
  };
  return attachHelpers(ctx);
}
