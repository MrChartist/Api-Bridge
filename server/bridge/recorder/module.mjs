/**
 * recorder module: saves the Bridge's own real-time data going forward (quotes, option chains) to files on this
 * computer, by hand or by rules every trading day. Contract service `recorder` (service.mjs), config section `recorder`
 * (config.mjs), routes under /v1/recordings (routes.mjs), CLI `mc-bridge record ...` (cli.mjs). Documented in
 * docs/guides/recording.md.
 *
 * It listens to the event bus and reads through the market service and the live feed; nothing depends on it. Off by
 * default for auto-record: a Bridge that never turns it on writes nothing.
 */
import { isStub } from "../core/contracts.mjs";
import { defineModule } from "../core/modules.mjs";
import { addMetrics } from "../core/metrics.mjs";
import { RECORDER_CONFIG_SCHEMA } from "./config.mjs";
import { createRecorderRoutes } from "./routes.mjs";
import { createRecorderService } from "./service.mjs";

const READ = Object.freeze({ scope: "read" });
const ADMIN_LOCAL = Object.freeze({ scope: "admin", loopbackOnly: true });
const ADMIN_LOCAL_JSON = Object.freeze({ scope: "admin", loopbackOnly: true, body: "json", bodyLimitBytes: 32_768 });

/** [method, path, route options, handler name] */
export const ROUTES = Object.freeze([
  ["GET", "/v1/recordings", READ, "list"],
  ["POST", "/v1/recordings", ADMIN_LOCAL_JSON, "create"],
  ["GET", "/v1/recordings/status", READ, "getStatus"],
  ["GET", "/v1/recordings/settings", READ, "getSettings"],
  ["PATCH", "/v1/recordings/settings", ADMIN_LOCAL_JSON, "patchSettings"],
  ["GET", "/v1/recordings/auto", READ, "getAuto"],
  ["PUT", "/v1/recordings/auto", ADMIN_LOCAL_JSON, "putAuto"],
  ["GET", "/v1/recordings/presets", READ, "listPresets"],
  ["POST", "/v1/recordings/presets/:presetId/apply", ADMIN_LOCAL_JSON, "applyPreset"],
  ["GET", "/v1/recordings/rules", READ, "listRules"],
  ["POST", "/v1/recordings/rules", ADMIN_LOCAL_JSON, "createRule"],
  ["GET", "/v1/recordings/rules/:ruleId", READ, "getRule"],
  ["PATCH", "/v1/recordings/rules/:ruleId", ADMIN_LOCAL_JSON, "patchRule"],
  ["DELETE", "/v1/recordings/rules/:ruleId", ADMIN_LOCAL, "deleteRule"],
  ["GET", "/v1/recordings/:recordingId", READ, "get"],
  ["DELETE", "/v1/recordings/:recordingId", ADMIN_LOCAL, "remove"],
  ["POST", "/v1/recordings/:recordingId/pause", ADMIN_LOCAL, "pause"],
  ["POST", "/v1/recordings/:recordingId/resume", ADMIN_LOCAL, "resume"],
  ["POST", "/v1/recordings/:recordingId/stop", ADMIN_LOCAL, "stop"],
  ["GET", "/v1/recordings/:recordingId/files", READ, "files"],
  ["GET", "/v1/recordings/:recordingId/files/:name", READ, "getFile"],
]);

/**
 * @param {Parameters<typeof createRecorderService>[1]} [opts]  now, calendarView, statfs, library, timers (tests)
 */
export function createRecorderModule(opts = {}) {
  return defineModule({
    name: "recorder",
    configKey: "recorder",
    configSchema: RECORDER_CONFIG_SCHEMA,
    services: { recorder: (deps) => createRecorderService(deps, opts) },
    register(app, deps) {
      addMetrics(deps, () => {
        const s = deps.recorder.status?.();
        if (!s) return [];
        return [
          { name: "bridge_recorder_rows_today", help: "Rows saved by recordings today.", value: s.today?.rows ?? 0 },
          { name: "bridge_recorder_gaps_today", help: "Stretches today with no data saved.", value: s.today?.gaps ?? 0 },
          { name: "bridge_recorder_disk_bytes", help: "Disk used by recordings.", value: s.disk?.usedBytes ?? 0 },
          { name: "bridge_recorder_recordings_running", help: "Recordings writing now.", value: s.recordings?.running ?? 0 },
        ];
      });
      const handlers = createRecorderRoutes(deps);
      for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], { ...options });
    },
    async start(deps) {
      // The library of collections is built by another module; look for it now that every service exists.
      deps.recorder?.attach?.({ library: deps.library && !isStub(deps.library) ? deps.library : null });
      await deps.recorder?.start?.();
    },
    async stop(deps) {
      await deps.recorder?.close?.();
    },
  });
}

export default createRecorderModule();
