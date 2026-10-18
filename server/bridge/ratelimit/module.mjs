/**
 * ratelimit module — stream S3: Rate-limit engine and routing. Owned files and tasks: docs/STREAMS.md §S3.
 *
 * Provides deps.scheduler (scheduler.mjs), owns the `ratelimit` config section (config.mjs) and serves
 * GET /v1/limits and GET /v1/usage (routes.mjs). stop() refuses whatever is still queued and clears the timer.
 */
import { defineModule } from "../core/modules.mjs";
import { ratelimitConfigSchema } from "./config.mjs";
import { createLimitRoutes } from "./routes.mjs";
import { createScheduler } from "./scheduler.mjs";

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
  services: { scheduler: (deps) => createScheduler(deps) },
  register(app, deps) {
    const handlers = createLimitRoutes(deps);
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], options);
  },
  async stop(deps) {
    if (typeof deps.scheduler?.stop === "function") deps.scheduler.stop();
  },
});
