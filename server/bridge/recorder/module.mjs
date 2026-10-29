/**
 * recorder module — stream S17 (docs/spec/p1-01-recorder.md): records option chains every minute in session from one
 * data account (stream first, REST inside half of the broker budget), writes S1 snapshots and gaps and S3 daily rows
 * under dataDir/recorder/ (dataDir/recorder-demo/ in demo mode), and serves them over REST and MCP. Contract service
 * `recorder` (deps.recorder). Config section `recorder` (config.mjs). Never places orders: nothing under recorder/
 * imports orders/, paper/ or safety/.
 */
import { defineModule } from "../core/modules.mjs";
import { RECORDER_CONFIG_SCHEMA } from "./config.mjs";
import { createRecorderService } from "./recorderService.mjs";
import { createRecorderRoutes } from "./routes.mjs";

const READ = Object.freeze({ scope: "read" });
const WRITE = Object.freeze({ scope: "admin", loopbackOnly: true });

/** Services the recorder reads (vol/context.mjs is a pure import, not a service call). */
export const USED_SERVICES = Object.freeze(["marketData", "streamHub", "accounts", "scheduler", "symbols", "reference", "backupData"]);

/** [method, path, route options, handler name] — 6 operations (docs/openapi.yaml, x-stream S17). */
export const ROUTES = Object.freeze([
  ["GET", "/v1/options/snapshots", READ, "snapshots"],
  ["GET", "/v1/options/snapshots/latest", READ, "latest"],
  ["GET", "/v1/options/daily", READ, "daily"],
  ["GET", "/v1/options/recorder", READ, "status"],
  ["POST", "/v1/options/recorder/plan", READ, "plan"],
  ["PUT", "/v1/options/recorder/config", WRITE, "setConfig"],
]);

export default defineModule({
  name: "recorder",
  stream: "S17",
  configKey: "recorder",
  configSchema: RECORDER_CONFIG_SCHEMA,
  services: { recorder: (deps) => createRecorderService(deps) },
  register(app, deps) {
    const handlers = createRecorderRoutes(deps.recorder, deps);
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], { ...options });
  },
  async start(deps) {
    // In the background: planning, a restart's gap records and the demo back-fill must not hold up the listener.
    deps.recorder?.start?.()?.catch?.((err) => deps.logger?.error?.("recorder start failed", { err }));
  },
  async stop(deps) {
    await deps.recorder?.stop?.();
  },
});
