/**
 * events module: Bridge events out, so other programs react without polling.
 *
 *   event bus -> event log (cursor, kept on disk, survives a restart) -> SSE and WebSocket readers (replay with ?since=)
 *                                                                      -> signed webhooks (durable outbox, retries, dead letters)
 *
 * Config section `events` (config.mjs). Routes: /v1/events/* and /v1/subscriptions/* (routes.mjs). Documented in
 * docs/guides/events.md and docs/asyncapi.yaml. Events are read-only notifications; nothing here can place, confirm or
 * reject an order. A Bridge that nobody subscribes to behaves exactly as before: the module only listens to the bus.
 *
 * The module offers no contract service. `opts` (transport, resolve, now, random, setTimer, setInterval) are for tests.
 */
import { join } from "node:path";
import { defineModule } from "../core/modules.mjs";
import { addMetrics } from "../core/metrics.mjs";
import { BridgeError } from "../core/errors.mjs";
import { EVENT_TOPICS } from "./catalog.mjs";
import { createClientRegistry, createEventsSse, createEventsWs } from "./clients.mjs";
import { EVENTS_CONFIG_SCHEMA, eventsConfig } from "./config.mjs";
import { createEventLog } from "./eventLog.mjs";
import { createEventsRoutes } from "./routes.mjs";
import { createSender } from "./sender.mjs";
import { createWebhookService } from "./webhooks.mjs";

const ADMIN = Object.freeze({ scope: "admin" });
const ADMIN_LOCAL_JSON = Object.freeze({ scope: "admin", loopbackOnly: true, body: "json", bodyLimitBytes: 4096 });
const ADMIN_LOCAL_NO_BODY = Object.freeze({ scope: "admin", loopbackOnly: true, body: "none" });

/** [method, path, route options, handler name] — the contract; keep in step with docs/openapi.yaml. */
export const ROUTES = Object.freeze([
  ["GET", "/v1/events/stream", Object.freeze({ auth: "custom" }), "stream"],
  ["GET", "/v1/events/topics", Object.freeze({ scope: "read" }), "getTopics"],
  ["GET", "/v1/events", Object.freeze({ scope: "read" }), "listEvents"],
  ["GET", "/v1/events/status", ADMIN, "getStatus"],
  ["GET", "/v1/subscriptions", ADMIN, "listSubscriptions"],
  ["POST", "/v1/subscriptions", ADMIN_LOCAL_JSON, "createSubscription"],
  ["GET", "/v1/subscriptions/:subscriptionId", ADMIN, "getSubscription"],
  ["PATCH", "/v1/subscriptions/:subscriptionId", ADMIN_LOCAL_JSON, "patchSubscription"],
  ["DELETE", "/v1/subscriptions/:subscriptionId", ADMIN_LOCAL_NO_BODY, "deleteSubscription"],
  ["POST", "/v1/subscriptions/:subscriptionId/test", ADMIN_LOCAL_NO_BODY, "testSubscription"],
  ["GET", "/v1/subscriptions/:subscriptionId/deliveries", ADMIN, "listDeliveries"],
  ["GET", "/v1/subscriptions/:subscriptionId/dead-letters", ADMIN, "listDeadLetters"],
  ["DELETE", "/v1/subscriptions/:subscriptionId/dead-letters", ADMIN_LOCAL_NO_BODY, "clearDeadLetters"],
  ["POST", "/v1/subscriptions/:subscriptionId/dead-letters/:deliveryId/retry", ADMIN_LOCAL_NO_BODY, "retryDeadLetter"],
]);

/** @param {{ transport?: import("./transport.mjs").Transport, resolve?: Function, now?: () => number, random?: () => number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout, setInterval?: typeof setInterval, clearInterval?: typeof clearInterval }} [opts] */
export function createEventsModule(opts = {}) {
  /** deps -> this app's state, so two Bridges in one process (tests) never share one. @type {WeakMap<object, { eventLog: any, webhooks: any, registry: any, ws: any, offs: Array<() => void>, cfg: any }>} */
  const states = new WeakMap();

  return defineModule({
    name: "events",
    configKey: "events",
    configSchema: EVENTS_CONFIG_SCHEMA,
    register(app, deps) {
      const cfg = eventsConfig(app.config);
      const log = deps.logger.child({ module: "events" });
      const now = opts.now ?? (() => deps.clock.now());
      const dir = join(deps.paths.dataDir, "events");
      const eventLog = createEventLog({ dir, retain: cfg.retain, maxEventBytes: cfg.maxEventBytes, now, logger: log });
      const sender = createSender({
        policy: () => ({ allowPrivateTargets: cfg.webhooks.allowPrivateTargets, allowedHosts: cfg.webhooks.allowedHosts, timeoutMs: cfg.webhooks.timeoutMs, maxResponseBytes: cfg.webhooks.maxResponseBytes }),
        transport: opts.transport,
        ...(opts.resolve ? { resolve: opts.resolve } : {}),
        now,
      });
      const webhooks = createWebhookService({ cfg, dir, secrets: deps.secrets, sender, logger: log, now, random: opts.random, setTimer: opts.setTimer, clearTimer: opts.clearTimer });
      const registry = createClientRegistry({ max: cfg.maxClients, maxPerKey: cfg.maxClientsPerKey });
      const common = { eventLog, keyStore: deps.keyStore, registry, cfg, clock: { now }, logger: log };
      const sse = createEventsSse({ ...common, bus: deps.bus, cors: app.config.cors, setInterval: opts.setInterval, clearInterval: opts.clearInterval });
      const ws = createEventsWs(common);
      states.set(deps, { eventLog, webhooks, registry, ws, offs: [], cfg });
      addMetrics(deps, () => {
        const w = webhooks.status();
        const c = registry.stats();
        return [
          { name: "bridge_events_total", help: "Events recorded in the event log since the Bridge started.", type: "counter", value: eventLog.stats().recorded },
          { name: "bridge_sse_clients", help: "Open event streams (server-sent events).", value: c.sse },
          { name: "bridge_ws_clients", help: "Open event WebSocket connections.", value: c.ws },
          { name: "bridge_webhook_pending", help: "Webhook deliveries waiting.", value: w.pending },
          { name: "bridge_webhook_inflight", help: "Webhook deliveries being sent now.", value: w.inflight },
          { name: "bridge_webhook_dead", help: "Webhook dead letters.", value: w.deadLetters },
        ];
      });

      const handlers = createEventsRoutes({ eventLog, webhooks, registry, audit: deps.audit, cfg });
      const off = () => {
        if (!cfg.enabled) throw new BridgeError("CAPABILITY_UNSUPPORTED", "Events are switched off (events.enabled in the config file).");
      };
      handlers.stream = (ctx) => {
        off();
        return sse(ctx);
      };
      for (const [method, path, options, name] of ROUTES) app.route(method, path, (ctx) => handlers[name](ctx), { ...options });
      app.upgrade("/v1/events/ws", (args) => {
        if (!cfg.enabled) return args.reject("404 Not Found");
        return ws.handleUpgrade(args);
      });
    },
    start(deps) {
      const state = states.get(deps);
      if (!state || !state.cfg.enabled) return;
      const { eventLog, webhooks } = state;
      for (const t of EVENT_TOPICS) {
        try {
          state.offs.push(deps.bus.on(t.topic, (payload) => void eventLog.record(t.topic, payload)));
        } catch {
          /* a topic the bus does not know yet (a module that has not landed): nothing to listen to */
        }
      }
      state.offs.push(eventLog.subscribe((e) => webhooks.offer(e)));
      state.offs.push(deps.bus.on("system.resumed", () => webhooks.wake()));
      state.offs.push(
        deps.bus.on("key.revoked", ({ keyId } = {}) => {
          for (const s of state.registry.all()) if (s.keyId === keyId) s.goAway("key_revoked", "The API key behind this connection was revoked.");
        }),
      );
      webhooks.start();
    },
    async stop(deps) {
      const state = states.get(deps);
      if (!state) return;
      for (const off of state.offs.splice(0)) off();
      state.registry.all().forEach((s) => s.goAway("shutdown", "The Bridge is restarting. Reconnect in a few seconds with your last cursor."));
      state.ws.close();
      // Deliveries in flight get a few seconds to end; the queue itself is already on disk, so what is left is sent again.
      await state.webhooks.stop();
    },
  });
}

export default createEventsModule();
