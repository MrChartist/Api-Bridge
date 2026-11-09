/**
 * notify module: Bridge events to Telegram, and a few read-only commands back. Contract service `notify`
 * (service.mjs), config section `notify` (config.mjs), routes under /v1/notify (routes.mjs). Documented in
 * docs/guides/telegram.md and docs/guides/notifications.md.
 *
 * The module listens to the event bus; nothing else depends on it, so a Bridge without a Telegram bot behaves exactly as
 * before. Outbound HTTPS only (api.telegram.org); no inbound port.
 */
import { defineModule } from "../core/modules.mjs";
import { NOTIFY_CONFIG_SCHEMA } from "./config.mjs";
import { createNotifyRoutes } from "./routes.mjs";
import { createNotifyService } from "./service.mjs";

const ADMIN = Object.freeze({ scope: "admin" });
const ADMIN_LOCAL = Object.freeze({ scope: "admin", loopbackOnly: true });
const ADMIN_LOCAL_JSON = Object.freeze({ scope: "admin", loopbackOnly: true, body: "json", bodyLimitBytes: 4096 });

/** [method, path, route options, handler name] */
export const ROUTES = Object.freeze([
  ["GET", "/v1/notify/status", ADMIN, "getStatus"],
  ["GET", "/v1/notify/targets", ADMIN, "listTargets"],
  ["POST", "/v1/notify/targets", ADMIN_LOCAL_JSON, "createTarget"],
  ["DELETE", "/v1/notify/targets/:targetId", ADMIN_LOCAL, "deleteTarget"],
  ["POST", "/v1/notify/targets/:targetId/test", ADMIN_LOCAL_JSON, "testTarget"],
  ["POST", "/v1/notify/targets/:targetId/find-chat", ADMIN_LOCAL, "findChat"],
  ["POST", "/v1/notify/targets/:targetId/chats", ADMIN_LOCAL_JSON, "addChat"],
  ["PATCH", "/v1/notify/targets/:targetId/chats/:chatKey", ADMIN_LOCAL_JSON, "patchChat"],
  ["DELETE", "/v1/notify/targets/:targetId/chats/:chatKey", ADMIN_LOCAL, "deleteChat"],
  ["GET", "/v1/notify/events", ADMIN, "getEvents"],
  ["PUT", "/v1/notify/events", ADMIN_LOCAL_JSON, "putEvents"],
]);

/**
 * The module. `opts` (fetchImpl, now, random, calendar, timers) are for tests: the default module talks to Telegram with
 * the global fetch and the real clock.
 * @param {Parameters<typeof createNotifyService>[1]} [opts]
 */
export function createNotifyModule(opts = {}) {
  return defineModule({
    name: "notify",
    configKey: "notify",
    configSchema: NOTIFY_CONFIG_SCHEMA,
    services: { notify: (deps) => createNotifyService(deps, opts) },
    register(app, deps) {
      const handlers = createNotifyRoutes(deps);
      for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], { ...options });
    },
    async start(deps) {
      await deps.notify?.start?.();
    },
    async stop(deps) {
      await deps.notify?.stop?.();
    },
  });
}

export default createNotifyModule();
