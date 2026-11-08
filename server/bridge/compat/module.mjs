/**
 * compat module: a compatibility REST API (apikey-in-body style) at /api/v1/* on the Bridge's own port.
 *
 * Compat-style clients send the key in the JSON body (`apikey`), so these routes use `auth: "custom"`: the handler
 * authenticates the Bridge API key itself (body `apikey`, or the usual Authorization / X-API-Key header), applies
 * the key's scopes, account list and per-key rate limit exactly as the /v1 pipeline does, and only then runs.
 * Errors come back the compat-style way: { "status": "error", "message": "..." } with the Bridge's HTTP status.
 */
import { isStub } from "../core/contracts.mjs";
import { expandScopes } from "../core/context.mjs";
import { BridgeError, toProblem } from "../core/errors.mjs";
import { json } from "../core/http.mjs";
import { defineModule } from "../core/modules.mjs";
import { COMPAT_CONFIG_SCHEMA, parseCompatConfig } from "./config.mjs";
import { createCompatHandlers } from "./handlers.mjs";
import { createCompatWs } from "./ws.mjs";

/** One WebSocket endpoint per app. */
const endpoints = new WeakMap();

/** Compat-style endpoint (after /api/v1/) -> handler name. All POST with a JSON body. */
export const ENDPOINTS = Object.freeze({
  ping: "ping",
  analyzer: "analyzer",
  "analyzer/toggle": "analyzerToggle",
  funds: "funds",
  orderbook: "orderbook",
  tradebook: "tradebook",
  positionbook: "positionbook",
  holdings: "holdings",
  placeorder: "placeorder",
  placesmartorder: "placesmartorder",
  basketorder: "basketorder",
  splitorder: "splitorder",
  modifyorder: "modifyorder",
  cancelorder: "cancelorder",
  cancelallorder: "cancelallorder",
  closeposition: "closeposition",
  orderstatus: "orderstatus",
  openposition: "openposition",
  optionsorder: "optionsorder",
  quotes: "quotes",
  multiquotes: "multiquotes",
  depth: "depth",
  history: "history",
  intervals: "intervals",
  symbol: "symbol",
  search: "search",
  expiry: "expiry",
  optionchain: "optionchain",
  optionsymbol: "optionsymbol",
  margin: "margin",
});

/** [method, path, route options, endpoint] */
export const ROUTES = Object.freeze(Object.keys(ENDPOINTS).map((e) => ["POST", `/api/v1/${e}`, { auth: "custom", formatError: compatError }, e]));

/** Compat-style error body. */
export function compatError(err) {
  const p = toProblem(err, {});
  const headers = err?.retryAfterMs ? { "Retry-After": String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))) } : {};
  return json({ status: "error", message: p.detail ?? p.title, code: p.code }, { status: p.status, headers });
}

/** Authenticate the Bridge key a compat client sent, then fill the request context like the /v1 pipeline. */
async function authenticate(ctx, deps) {
  const body = ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body) ? ctx.body : {};
  let raw = typeof body.apikey === "string" && body.apikey ? body.apikey : null;
  const h = ctx.req?.headers ?? {};
  if (!raw && typeof h.authorization === "string") raw = /^Bearer\s+(\S+)$/i.exec(h.authorization.trim())?.[1] ?? null;
  if (!raw && typeof h["x-api-key"] === "string") raw = h["x-api-key"].trim() || null;
  if (!raw) throw new BridgeError("UNAUTHENTICATED", "Send your Bridge API key as apikey in the JSON body.");
  const record = await deps.keyStore.authenticate(raw, { ip: ctx.clientIp });
  if (!record) throw new BridgeError("UNAUTHENTICATED", "This API key is not valid, has expired or was revoked.");
  ctx.key = record;
  ctx.scopes = expandScopes(record.scopes);
  ctx.principal = { kind: "key", id: record.id, label: record.label };
  ctx.log = ctx.log?.child ? ctx.log.child({ keyId: record.id }) : ctx.log;
  ctx.requireScope("read");
  if (!isStub(deps.scheduler)) {
    const verdict = deps.scheduler.checkClient(ctx);
    Object.assign(ctx.responseHeaders, verdict.headers ?? {});
    if (!verdict.ok) throw verdict.error ?? new BridgeError("RATE_LIMITED", undefined, { retryAfterMs: verdict.retryAfterMs });
  }
  return body;
}

export default defineModule({
  name: "compat",
  stream: "S14",
  configKey: "compat",
  configSchema: COMPAT_CONFIG_SCHEMA,
  register(app, deps) {
    const cfg = parseCompatConfig(app.config?.compat);
    if (!cfg.enabled) return;
    const handlers = createCompatHandlers(deps, cfg);
    for (const [method, path, options, endpoint] of ROUTES) {
      const name = ENDPOINTS[endpoint];
      app.route(
        method,
        path,
        async (ctx) => {
          const body = await authenticate(ctx, deps);
          const { apikey: _k, ...rest } = body;
          return handlers[name](ctx, rest);
        },
        options,
      );
    }
    if (deps.streamHub && !isStub(deps.streamHub) && typeof deps.streamHub.attachSink === "function") {
      const ws = createCompatWs({ hub: deps.streamHub, keyStore: deps.keyStore, accounts: deps.accounts, bus: deps.bus, logger: deps.logger, account: cfg.account });
      endpoints.set(deps, ws);
      app.upgrade("/api/v1/ws", (args) => ws.handleUpgrade(args));
    }
  },
  async stop(deps) {
    endpoints.get(deps)?.close();
  },
});
