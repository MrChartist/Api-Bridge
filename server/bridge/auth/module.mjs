/**
 * auth module: API keys, secrets and stream tokens.
 * Routes follow docs/openapi.yaml (method, path, auth, scope); responses use the { data, meta } envelope.
 *
 *  GET    /v1/keys            admin, loopback only   list keys (never the key or its hash); an account-limited admin key
 *                                                    sees and revokes only keys limited to its own accounts
 *  POST   /v1/keys            admin, loopback only   create a key; 201 with the key shown once; audited key.created
 *  DELETE /v1/keys/{keyId}    admin, loopback only   revoke now; audited key.revoked
 *  POST   /v1/stream/token    read                   single-use 60 s token for ?token= on WS/SSE URLs
 *  POST   /v1/sign-in         none, loopback only    exchange a one-time sign-in code (signIn.mjs) for a new admin key
 *                                                    that expires in 30 days; audited key.created
 *
 * Audit: key events go to deps.audit (safety). While safety is a stub the action still succeeds and a warning is logged,
 * matching the CLI; any other audit failure is logged as an error (the key change itself has already happened).
 */
import { BridgeError, NotImplementedError } from "../core/errors.mjs";
import { json } from "../core/http.mjs";
import { defineModule } from "../core/modules.mjs";
import { createKeyStore, KEY_ID_RE } from "./keyStore.mjs";
import { createSecretStore } from "./secretStore.mjs";
import { SIGN_IN_KEY_TTL_MS, consumeSignInCode } from "./signIn.mjs";
import { createDemoSecretStore } from "../demo/demoMode.mjs";

/** [method, path, route options] — the contract; keep in step with docs/openapi.yaml. */
export const ROUTES = Object.freeze([
  ["GET", "/v1/keys", { scope: "admin", loopbackOnly: true, summary: "List API keys" }],
  ["POST", "/v1/keys", { scope: "admin", loopbackOnly: true, summary: "Create an API key" }],
  ["DELETE", "/v1/keys/:keyId", { scope: "admin", loopbackOnly: true, body: "none", summary: "Revoke an API key" }],
  ["POST", "/v1/stream/token", { scope: "read", body: "none", summary: "Short-lived token for WebSocket and SSE URLs" }],
  ["POST", "/v1/sign-in", { auth: "none", loopbackOnly: true, bodyLimitBytes: 1024, summary: "Exchange a one-time sign-in code for a dashboard key" }],
]);

/** Label of the admin key a sign-in creates (the dashboard's welcome checklist does not count these as tool keys). */
export const SIGN_IN_KEY_LABEL = "Dashboard sign-in";
/** The one answer for a sign-in code that is wrong, expired or already used. */
export const SIGN_IN_FAILED = "This sign-in link has expired or was already used. Open the Bridge again from its shortcut, or run mc-bridge open.";
/** Failed sign-in attempts allowed per minute (all callers are on this computer) before the route refuses for a while. */
export const MAX_FAILED_SIGN_IN = 20;
const SIGN_IN_WINDOW_MS = 60_000;

const meta = (ctx) => ({ requestId: ctx.requestId });
/** A key record the caller may see and revoke: its accounts are all ones the caller holds. */
const visible = (ctx, record) => ctx.canAccessAccounts?.(record.accounts) ?? true;

/**
 * Append an audit record for a key event without failing the request.
 * @param {object} deps @param {import("../core/context.mjs").RequestContext} ctx @param {string} type @param {object} data
 */
export async function auditKeyEvent(deps, ctx, type, data) {
  try {
    await deps.audit.append({ type, actor: { kind: ctx.principal.kind, id: ctx.principal.id }, source: ctx.source, requestId: ctx.requestId, data });
  } catch (err) {
    if (err instanceof NotImplementedError) ctx.log.warn("audit log not built yet; key event not audited", { type, keyId: data.keyId });
    else ctx.log.error("audit append failed for key event", { type, keyId: data.keyId, err });
  }
}

/** Route handlers, exported for unit tests. @param {object} deps */
export function createHandlers(deps) {
  const now = () => deps.clock?.now() ?? Date.now();
  /** Times of recent failed sign-ins (memory only). */
  const failedSignIns = [];
  return {
    async listKeys(ctx) {
      // An account-limited admin key sees only keys limited to accounts it holds (never the unlimited ones).
      const all = await deps.keyStore.list();
      return { data: all.filter((k) => visible(ctx, k)), meta: meta(ctx) };
    },
    async createKey(ctx) {
      if (ctx.body === undefined || ctx.body === null || typeof ctx.body !== "object" || Array.isArray(ctx.body)) {
        throw new BridgeError("VALIDATION_FAILED", "Send a JSON object with at least label and scopes.");
      }
      // A key cannot grant more than it holds (live needs live); the local CLI is not limited.
      // Nor reach more accounts than it may use.
      const creatorScopes = ctx.principal?.kind === "local" ? undefined : [...(ctx.scopes ?? [])];
      const creatorAccounts = ctx.principal?.kind === "local" ? undefined : (ctx.key?.accounts ?? []);
      const { key, record } = await deps.keyStore.create(ctx.body, { loopback: ctx.loopback, creatorScopes, creatorAccounts });
      await auditKeyEvent(deps, ctx, "key.created", { keyId: record.id, label: record.label, scopes: record.scopes, accounts: record.accounts, allowQuery: record.allowQuery, expiresAt: record.expiresAt, createdBy: ctx.key?.id ?? ctx.principal?.id ?? null });
      return json({ data: { key, record }, meta: meta(ctx) }, { status: 201 });
    },
    async revokeKey(ctx) {
      const keyId = ctx.params.keyId;
      if (!KEY_ID_RE.test(String(keyId ?? ""))) throw new BridgeError("NOT_FOUND", "No API key with this id.");
      const before = await deps.keyStore.get(keyId);
      // The same answer as an unknown id, so a limited key cannot probe for keys it may not manage.
      if (before && !visible(ctx, before)) throw new BridgeError("NOT_FOUND", "No API key with this id.");
      const record = await deps.keyStore.revoke(keyId);
      if (before && !before.revokedAt) await auditKeyEvent(deps, ctx, "key.revoked", { keyId: record.id, label: record.label });
      return { data: record, meta: meta(ctx) };
    },
    async createStreamToken(ctx) {
      if (!ctx.key) throw new BridgeError("UNAUTHENTICATED", "A stream token needs an API key.");
      const { token, expiresAt } = await deps.keyStore.issueStreamToken(ctx.key);
      return { data: { token, expiresAt }, meta: meta(ctx) };
    },
    async signIn(ctx) {
      // Never log the code or the key: neither is passed to a logger, and the code only ever arrives in the body.
      const t = now();
      while (failedSignIns.length && failedSignIns[0] <= t - SIGN_IN_WINDOW_MS) failedSignIns.shift();
      if (failedSignIns.length >= MAX_FAILED_SIGN_IN) {
        throw new BridgeError("RATE_LIMITED", "Too many sign-in attempts. Wait a minute, then open the Bridge again from its shortcut, or run mc-bridge open.", { retryAfterMs: failedSignIns[0] + SIGN_IN_WINDOW_MS - t });
      }
      const body = ctx.body;
      const code = body && typeof body === "object" && !Array.isArray(body) ? body.code : undefined;
      if (!(await consumeSignInCode(deps.paths.dataDir, code, { now: t }))) {
        failedSignIns.push(t);
        throw new BridgeError("UNAUTHENTICATED", SIGN_IN_FAILED);
      }
      const { key, record } = await deps.keyStore.create(
        { label: SIGN_IN_KEY_LABEL, scopes: ["admin", "paper"], accounts: "*", clientKind: "ui", expiresAt: new Date(t + SIGN_IN_KEY_TTL_MS).toISOString() },
        { loopback: ctx.loopback },
      );
      // The code was made by someone with this computer's data folder (the mc-bridge command), so the actor is local.
      const actorCtx = { ...ctx, principal: { kind: "local", id: "sign-in-link" } };
      await auditKeyEvent(deps, actorCtx, "key.created", { keyId: record.id, label: record.label, scopes: record.scopes, accounts: record.accounts, allowQuery: record.allowQuery, expiresAt: record.expiresAt, createdBy: "sign-in-link" });
      return json({ data: { key, record }, meta: meta(ctx) }, { status: 201 });
    },
  };
}

const HANDLER_FOR = Object.freeze({
  "GET /v1/keys": "listKeys",
  "POST /v1/keys": "createKey",
  "DELETE /v1/keys/:keyId": "revokeKey",
  "POST /v1/stream/token": "createStreamToken",
  "POST /v1/sign-in": "signIn",
});

export default defineModule({
  name: "auth",
  stream: "S2",
  services: { secrets: (deps) => (deps.config.demo ? createDemoSecretStore() : createSecretStore(deps)), keyStore: (deps) => createKeyStore(deps) },
  register(app, deps) {
    const handlers = createHandlers(deps);
    for (const [method, path, options] of ROUTES) app.route(method, path, handlers[HANDLER_FOR[`${method} ${path}`]], options);
  },
});
