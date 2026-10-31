/**
 * stream module — stream S6: live streaming over WebSocket and SSE (docs/STREAMS.md §S6, protocol in docs/asyncapi.yaml).
 *
 *   WS  /v1/stream          upgrade; ?token=<stream token> or Authorization header; read scope
 *   GET /v1/stream/sse      auth custom (same credentials); same messages as the WebSocket
 *   GET /v1/stream/stats    read; upstream feeds, subscriptions and downstream connections
 *
 * Config section: `stream` (./config.mjs). On stop() every client gets go_away "shutdown" before the feeds close.
 */
import { defineModule } from "../core/modules.mjs";
import { streamConfigSchema } from "./config.mjs";
import { createSessionRegistry } from "./protocol.mjs";
import { createSseHandler } from "./sse.mjs";
import { createStreamHub } from "./streamHub.mjs";
import { createWsEndpoint } from "./wsServer.mjs";

/** [method, path, route options] — the contract; keep in step with docs/openapi.yaml. */
export const ROUTES = Object.freeze([
  ["GET", "/v1/stream/sse", { auth: "custom" }],
  ["GET", "/v1/stream/stats", { scope: "read" }],
]);

/** deps.streamHub -> endpoint state, so stop() can reach what register() built. */
const endpoints = new WeakMap();

/**
 * Build the downstream endpoints for a hub. Exported for tests.
 * @param {object} deps  all services (register() receives every one)
 * @param {{ cors?: object }} [opts]
 */
export function createStreamEndpoints(deps, { cors } = {}) {
  const hub = deps.streamHub;
  const cfg = hub.config ?? streamConfigSchema.parse(deps.config?.stream ?? {});
  const logger = deps.logger.child({ module: "stream" });
  const registry = createSessionRegistry({ max: cfg.maxClients, maxPerKey: cfg.maxClientsPerKey ?? 10 });
  const common = { hub, bus: deps.bus, keyStore: deps.keyStore, registry, config: cfg, clock: deps.clock, logger, scheduler: deps.scheduler ?? null };
  const ws = createWsEndpoint(common);
  const sse = createSseHandler({ ...common, cors: cors ?? deps.config?.cors });
  const offRevoked =
    deps.bus?.on?.("key.revoked", ({ keyId } = {}) => {
      for (const s of registry.all()) if (s.keyId === keyId) s.goAway("key_revoked", "The API key behind this connection was revoked.", null);
    }) ?? (() => {});
  return {
    registry,
    ws,
    sse,
    /** GET /v1/stream/stats */
    stats(ctx) {
      return { data: { ...hub.stats(), downstream: registry.stats() }, meta: { requestId: ctx.requestId } };
    },
    /** go_away to every client, then close the WebSocket server. */
    shutdown() {
      offRevoked();
      registry.goAwayAll("shutdown", "The Bridge is restarting. Reconnect in a few seconds.", 3000);
      ws.close();
    },
  };
}

export default defineModule({
  name: "stream",
  stream: "S6",
  configKey: "stream",
  configSchema: streamConfigSchema,
  services: { streamHub: (deps) => createStreamHub(deps) },
  register(app, deps) {
    const ep = createStreamEndpoints(deps, { cors: app.config.cors });
    endpoints.set(deps.streamHub, ep);
    const handlers = { "/v1/stream/sse": (ctx) => ep.sse(ctx), "/v1/stream/stats": (ctx) => ep.stats(ctx) };
    for (const [method, path, options] of ROUTES) app.route(method, path, handlers[path], options);
    app.upgrade("/v1/stream", (args) => ep.ws.handleUpgrade(args));
  },
  async stop(deps) {
    endpoints.get(deps.streamHub)?.shutdown();
    deps.streamHub.stop?.();
  },
});
