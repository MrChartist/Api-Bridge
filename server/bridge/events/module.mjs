/**
 * events module — stream S28 "Live events" (docs/guides/live-events.md): price, volume, circuit, level, swing, F&O OI
 * and option events detected live across a universe, with a day store, REST, a stream topic (subscribe_events) and an
 * MCP tool. Routes only (no contract service): the handlers read the engine this module builds, and nothing here can
 * place an order. Config section `events` (config.mjs).
 */
import { defineModule } from "../core/modules.mjs";
import { EVENTS_CONFIG_SCHEMA } from "./config.mjs";
import { createEventsRoutes } from "./routes.mjs";
import { createEventsService } from "./service.mjs";

const READ = Object.freeze({ scope: "read" });
const ADMIN = Object.freeze({ scope: "admin", loopbackOnly: true });

/** [method, path, route options, handler name] */
export const ROUTES = Object.freeze([
  ["GET", "/v1/events", READ, "list"],
  ["GET", "/v1/events/catalogue", READ, "catalogue"],
  ["GET", "/v1/events/selection", READ, "getSelection"],
  ["PUT", "/v1/events/selection", READ, "putSelection"],
  ["GET", "/v1/events/summary", READ, "summary"],
  ["GET", "/v1/events/symbols/:symbol", READ, "symbol"],
  ["GET", "/v1/events/chain", READ, "chain"],
  ["GET", "/v1/events/conditions", READ, "listConditions"],
  ["POST", "/v1/events/conditions", ADMIN, "createCondition"],
  ["DELETE", "/v1/events/conditions/:conditionId", { scope: "admin", loopbackOnly: true, body: "none" }, "deleteCondition"],
  ["GET", "/v1/events/status", READ, "status"],
]);

/** The services the engine reads. Nothing here may reach orders, paper or safety. */
export const USED_SERVICES = Object.freeze(["marketData", "streamHub", "accounts", "scheduler", "symbols", "recorder"]);

const services = new WeakMap();

/** The events service register() built for these deps (MCP tool, tests), or null. */
export function eventsFor(deps) {
  return services.get(deps) ?? null;
}

export default defineModule({
  name: "events",
  stream: "S28",
  configKey: "events",
  configSchema: EVENTS_CONFIG_SCHEMA,
  register(app, deps) {
    const svc = createEventsService(deps);
    services.set(deps, svc);
    const handlers = createEventsRoutes(svc);
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], { ...options });
  },
  async start(deps) {
    services.get(deps)?.start()?.catch?.((err) => deps.logger?.error?.("events start failed", { err }));
  },
  async stop(deps) {
    await services.get(deps)?.stop();
  },
});
