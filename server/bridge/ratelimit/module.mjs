/**
 * ratelimit module: Rate-limit engine and routing.
 *
 * Provides deps.scheduler (scheduler.mjs), owns the `ratelimit` config section (config.mjs) and serves
 * GET /v1/limits and GET /v1/usage (routes.mjs). stop() refuses whatever is still queued and clears the timer.
 */
import { defineModule } from "../core/modules.mjs";
import { ratelimitConfigSchema } from "./config.mjs";
import { createLimitRoutes } from "./routes.mjs";
import { createScheduler } from "./scheduler.mjs";
import { BROKER_POLICIES } from "./brokerPolicies.mjs";
import { DEMO_BROKER_ID, DEMO_POLICY } from "../demo/demoMode.mjs";

/** [method, path, route options, handler name] — the contract in docs/openapi.yaml. */
export const ROUTES = Object.freeze([
  ["GET", "/v1/limits", { scope: "read" }, "getLimits"],
  ["GET", "/v1/usage", { scope: "read" }, "getUsage"],
]);

export default defineModule({
  name: "ratelimit",
  stream: "S3",
  configKey: "ratelimit",
  configSchema: ratelimitConfigSchema,
    // Demo mode adds the demo broker's sample limits; the real table stays one entry per real adapter.
  services: { scheduler: (deps) => createScheduler(deps, deps.config.demo ? { policies: { ...BROKER_POLICIES, [DEMO_BROKER_ID]: DEMO_POLICY } } : {}) },
  register(app, deps) {
    const handlers = createLimitRoutes(deps);
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], options);
  },
  async stop(deps) {
    if (typeof deps.scheduler?.stop === "function") deps.scheduler.stop();
  },
});
