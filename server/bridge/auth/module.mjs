/**
 * auth module — stream S2: API keys, secrets and stream tokens. Owned files and tasks: docs/STREAMS.md §S2.
 * Routes follow docs/openapi.yaml (method, path, auth, scope); responses use the { data, meta } envelope.
 *
 *  GET    /v1/keys            admin, loopback only   list keys (never the key or its hash); an account-limited admin key
 *                                                    sees and revokes only keys limited to its own accounts
 *  POST   /v1/keys            admin, loopback only   create a key; 201 with the key shown once; audited key.created
 *  DELETE /v1/keys/{keyId}    admin, loopback only   revoke now; audited key.revoked
 *  POST   /v1/stream/token    read                   single-use 60 s token for ?token= on WS/SSE URLs
 *
 * Audit: key events go to deps.audit (S9). While S9 is a stub the action still succeeds and a warning is logged,
 * matching the CLI; any other audit failure is logged as an error (the key change itself has already happened).
 */
import { BridgeError, NotImplementedError } from "../core/errors.mjs";
import { json } from "../core/http.mjs";
import { defineModule } from "../core/modules.mjs";
import { createKeyStore, KEY_ID_RE } from "./keyStore.mjs";
import { createSecretStore } from "./secretStore.mjs";
import { createDemoSecretStore } from "../demo/demoMode.mjs";

/** [method, path, route options] — the contract; keep in step with docs/openapi.yaml. */
export const ROUTES = Object.freeze([
  ["GET", "/v1/keys", { scope: "admin", loopbackOnly: true, summary: "List API keys" }],
  ["POST", "/v1/keys", { scope: "admin", loopbackOnly: true, summary: "Create an API key" }],
  ["DELETE", "/v1/keys/:keyId", { scope: "admin", loopbackOnly: true, body: "none", summary: "Revoke an API key" }],
  ["POST", "/v1/stream/token", { scope: "read", body: "none", summary: "Short-lived token for WebSocket and SSE URLs" }],
]);

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
  };
}

const HANDLER_FOR = Object.freeze({
  "GET /v1/keys": "listKeys",
  "POST /v1/keys": "createKey",
  "DELETE /v1/keys/:keyId": "revokeKey",
  "POST /v1/stream/token": "createStreamToken",
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
