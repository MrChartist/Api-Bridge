/**
 * downloads module: history downloads and incremental datasets, saved as files on this computer.
 *
 * Provides the contract service `downloads` (manager.mjs), owns config section `downloads` (config.mjs) and the routes
 * below (docs/openapi.yaml, x-module: downloads). Documented in docs/guides/downloads.md.
 *
 * Reading and starting jobs needs the read scope: a job only reads market data through the same scheduler as everything
 * else, at the lowest priority and a capped share of the budget, and writes inside the data folder. Deleting a job or a
 * dataset removes files, so it needs an admin key from this computer. The local control token (this computer, no key)
 * is accepted on these routes so `mc-bridge download` works without a key.
 *
 * Bus topics: download.progress (throttled), download.done, download.failed.
 */
import { defineModule } from "../core/modules.mjs";
import { DOWNLOADS_CONFIG_SCHEMA } from "./config.mjs";
import { createDownloadManager } from "./manager.mjs";
import { createDownloadRoutes } from "./routes.mjs";

const READ = Object.freeze({ scope: "read", localControl: true });
const READ_JSON = Object.freeze({ scope: "read", localControl: true, body: "json", bodyLimitBytes: 262_144 });
const ADMIN_LOCAL_JSON = Object.freeze({ scope: "admin", loopbackOnly: true, localControl: true, body: "json", bodyLimitBytes: 4096 });
const ADMIN_LOCAL = Object.freeze({ scope: "admin", loopbackOnly: true, localControl: true, body: "none" });

/** [method, path, route options, handler name] */
export const ROUTES = Object.freeze([
  ["POST", "/v1/downloads", READ_JSON, "create"],
  ["GET", "/v1/downloads", READ, "list"],
  // Static paths first: "settings" must not be read as a download id.
  ["GET", "/v1/downloads/settings", READ, "getSettings"],
  ["PATCH", "/v1/downloads/settings", ADMIN_LOCAL_JSON, "patchSettings"],
  ["GET", "/v1/downloads/:downloadId", READ, "get"],
  ["PATCH", "/v1/downloads/:downloadId", READ_JSON, "patch"],
  ["DELETE", "/v1/downloads/:downloadId", ADMIN_LOCAL, "remove"],
  ["POST", "/v1/downloads/:downloadId/pause", READ, "pause"],
  ["POST", "/v1/downloads/:downloadId/resume", READ, "resume"],
  ["POST", "/v1/downloads/:downloadId/cancel", READ, "cancel"],
  ["GET", "/v1/downloads/:downloadId/files", READ, "files"],
  ["GET", "/v1/downloads/:downloadId/files/:name", READ, "file"],
  ["GET", "/v1/datasets", READ, "listDatasets"],
  ["GET", "/v1/datasets/:name", READ, "getDataset"],
  ["PATCH", "/v1/datasets/:name", READ_JSON, "patchDataset"],
  ["DELETE", "/v1/datasets/:name", ADMIN_LOCAL, "removeDataset"],
  ["POST", "/v1/datasets/:name/update", READ, "updateDataset"],
  ["GET", "/v1/instruments/export", READ, "instrumentsExport"],
]);

/**
 * @param {Parameters<typeof createDownloadManager>[1]} [opts] sleep, calendar, random: tests only
 */
export function createDownloadsModule(opts = {}) {
  return defineModule({
    name: "downloads",
    configKey: "downloads",
    configSchema: DOWNLOADS_CONFIG_SCHEMA,
    services: { downloads: (deps) => createDownloadManager(deps, opts) },
    register(app, deps) {
      // Collections (the library module) are optional: looked up when a job asks for one.
      deps.downloads.attachLibrary?.(() => deps.library);
      // The collection's usage view lists the jobs and datasets made from it (the library may not be there).
      for (const [kind, pick] of [["downloads", "jobs"], ["datasets", "datasets"]]) {
        try {
          deps.library?.registerUsageProvider?.(kind, (c) => deps.downloads.usageOfCollection(c)[pick]);
        } catch (err) {
          app.logger?.warn?.("could not register a downloads usage provider", { kind, err });
        }
      }
      const handlers = createDownloadRoutes(deps, { downloads: deps.downloads });
      for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], options);
    },
    async start(deps) {
      await deps.downloads?.start?.();
    },
    async stop(deps) {
      await deps.downloads?.stop?.();
    },
  });
}

export default createDownloadsModule();
