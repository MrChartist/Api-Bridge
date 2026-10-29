/**
 * vol module — stream S18 (docs/spec/p1-03-pricing-vol.md): the vol-time clock, the daily vol store (S2), IV rank
 * and percentile, IV history, VIX and the prediction log (S9). Contract service `vol` (deps.vol). Config section
 * `vol` (config.mjs). Stores under dataDir/vol/ (from P1-3b).
 *
 * Step P1-3a registers the ten routes with their contract (method, path, scope, loopback) as not built yet (501); the
 * handlers land in P1-3b (reads) and P1-3c (back-fill).
 */
import { defineModule, notBuilt } from "../core/modules.mjs";
import { VOL_CONFIG_SCHEMA } from "./config.mjs";
import { createVolService } from "./volService.mjs";

const READ = Object.freeze({ scope: "read" });
const WRITE = Object.freeze({ scope: "admin", loopbackOnly: true });

/** [method, path, route options] — 10 operations (docs/openapi.yaml, x-stream S18). */
export const ROUTES = Object.freeze([
  ["GET", "/v1/vol/clock", READ],
  ["GET", "/v1/vol/snapshot", READ],
  ["GET", "/v1/vol/history", READ],
  ["GET", "/v1/vol/rank", READ],
  ["GET", "/v1/vol/summary", READ],
  ["GET", "/v1/vol/status", READ],
  ["GET", "/v1/vol/predictions", READ],
  ["POST", "/v1/vol/capture", WRITE],
  ["POST", "/v1/vol/backfill", WRITE],
  ["DELETE", "/v1/vol/backfill", { ...WRITE, body: "none" }],
]);

export default defineModule({
  name: "vol",
  stream: "S18",
  configKey: "vol",
  configSchema: VOL_CONFIG_SCHEMA,
  services: { vol: (deps) => createVolService(deps) },
  register(app) {
    for (const [method, path, options] of ROUTES) app.route(method, path, notBuilt(`${method} ${path} (stream S18)`), { ...options });
  },
});
