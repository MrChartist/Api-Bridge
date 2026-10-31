/**
 * vol module — stream S18 (docs/spec/p1-03-pricing-vol.md): the vol-time clock, the daily vol store (S2), IV rank
 * and percentile, IV history, VIX and the prediction log (S9). Contract service `vol` (deps.vol). Config section
 * `vol` (config.mjs). Stores under dataDir/vol/ (dataDir/vol-demo/ in demo mode).
 *
 * The reads and the manual capture are built (P1-3b); the back-fill writes answer 501 until step P1-3c.
 */
import { defineModule } from "../core/modules.mjs";
import { VOL_CONFIG_SCHEMA } from "./config.mjs";
import { createVolRoutes } from "./routes.mjs";
import { createVolService } from "./volService.mjs";

const READ = Object.freeze({ scope: "read" });
const WRITE = Object.freeze({ scope: "admin", loopbackOnly: true });

/** [method, path, route options, handler] — 10 operations (docs/openapi.yaml, x-stream S18). */
export const ROUTES = Object.freeze([
  ["GET", "/v1/vol/clock", READ, "clock"],
  ["GET", "/v1/vol/snapshot", READ, "snapshot"],
  ["GET", "/v1/vol/history", READ, "history"],
  ["GET", "/v1/vol/rank", READ, "rank"],
  ["GET", "/v1/vol/summary", READ, "summary"],
  ["GET", "/v1/vol/status", READ, "status"],
  ["GET", "/v1/vol/predictions", READ, "predictions"],
  ["POST", "/v1/vol/capture", WRITE, "capture"],
  ["POST", "/v1/vol/backfill", WRITE, "backfill"],
  ["DELETE", "/v1/vol/backfill", { ...WRITE, body: "none" }, "cancelBackfill"],
]);

export default defineModule({
  name: "vol",
  stream: "S18",
  configKey: "vol",
  configSchema: VOL_CONFIG_SCHEMA,
  services: { vol: (deps) => createVolService(deps) },
  register(app, deps) {
    const handlers = createVolRoutes(deps.vol, deps);
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], { ...options });
  },
  async start(deps) {
    // In the background: the demo seeding and a late capture must not hold up the listener.
    deps.vol?.start?.()?.catch?.((err) => deps.logger?.error?.("vol start failed", { err }));
  },
  async stop(deps) {
    await deps.vol?.stop?.();
  },
});
