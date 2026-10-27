/**
 * notify module — stream S15: push Bridge events (saved-scan alerts, live fills, kill switch, expired sessions) to
 * Telegram, Discord, Slack or a signed webhook. Routes only. Config section `notify` (see config.mjs). Off in demo mode.
 *
 *   GET  /v1/notify        targets, what each listens to, delivery counts (admin)
 *   POST /v1/notify/test   { "target"?: "<id>" } send a test message (admin, this computer only)
 */
import { BridgeError } from "../core/errors.mjs";
import { defineModule } from "../core/modules.mjs";
import { NOTIFY_CONFIG_SCHEMA } from "./config.mjs";
import { createNotifier } from "./notifier.mjs";

export const ROUTES = Object.freeze([
  ["GET", "/v1/notify", { scope: "admin" }, "status"],
  ["POST", "/v1/notify/test", { scope: "admin", loopbackOnly: true }, "test"],
]);

const notifiers = new WeakMap();

export default defineModule({
  name: "notify",
  stream: "S15",
  configKey: "notify",
  configSchema: NOTIFY_CONFIG_SCHEMA,
  register(app, deps) {
    const n = createNotifier({ config: deps.config, bus: deps.bus, clock: deps.clock, logger: deps.logger });
    notifiers.set(deps, n);
    const handlers = {
      status: async (ctx) => ({ data: n.status(), meta: { requestId: ctx.requestId } }),
      test: async (ctx) => {
        const target = ctx.body && typeof ctx.body === "object" ? ctx.body.target : undefined;
        if (target !== undefined && (typeof target !== "string" || !n.has(target))) throw new BridgeError("NOT_FOUND", `No notification target ${String(target).slice(0, 40)}.`);
        if (n.status().demo) throw new BridgeError("CAPABILITY_UNSUPPORTED", "Notifications are off in demo mode.");
        return { data: await n.test(target), meta: { requestId: ctx.requestId } };
      },
    };
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], options);
  },
  async start(deps) {
    notifiers.get(deps)?.start();
  },
  async stop(deps) {
    notifiers.get(deps)?.stop();
  },
});
