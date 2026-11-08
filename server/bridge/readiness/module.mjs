/**
 * readiness module: whether each live-enabled account can trade right now
 * (broker session, static IP, order headroom, kill switch), for people (API, notifications) and for automation (the
 * automated-send gate in OrderService, hooks, later guards and alert actions). Contract service `readiness`
 * (monitor.mjs). Config section `readiness` (config.mjs). State under dataDir/readiness/ (store.mjs).
 *
 * The demo-only scenario route POST /v1/demo/readiness lives in demo/routes.mjs (registered only in demo mode).
 */
import { defineModule } from "../core/modules.mjs";
import { READINESS_CONFIG_SCHEMA } from "./config.mjs";
import { createReadinessService } from "./monitor.mjs";
import { createReadinessRoutes } from "./routes.mjs";

const READ = Object.freeze({ scope: "read" });

/** [method, path, route options, handler name] — docs/openapi.yaml, x-the readiness module. */
export const ROUTES = Object.freeze([
  ["GET", "/v1/readiness", READ, "getReadiness"],
  ["POST", "/v1/readiness/check", READ, "checkReadiness"],
  ["GET", "/v1/readiness/history", READ, "getHistory"],
]);

export default defineModule({
  name: "readiness",
  stream: "S20",
  configKey: "readiness",
  configSchema: READINESS_CONFIG_SCHEMA,
  services: { readiness: (deps) => createReadinessService(deps) },
  register(app, deps) {
    const handlers = createReadinessRoutes(deps);
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], { ...options });
  },
  async start(deps) {
    deps.readiness?.start?.();
  },
  async stop(deps) {
    deps.readiness?.stop?.();
  },
});
