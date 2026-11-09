/**
 * library module: named, tagged collections of instruments, and option universes that are worked out when they are used.
 * Contract service `library` (service.mjs), config section `library` (config.mjs), routes under /v1/collections (routes.mjs),
 * bus topic `collection.changed`. Documented in docs/guides/collections.md.
 *
 * Downloads, recordings, the Excel and Sheets routes and the Python library call deps.library.resolve(name) when they run, so a
 * universe always means today's expiry and today's at-the-money strike. Collections are stored in <dataDir>/collections.json.
 */
import { defineModule } from "../core/modules.mjs";
import { LIBRARY_CONFIG_SCHEMA } from "./config.mjs";
import { createLibraryRoutes } from "./routes.mjs";
import { createLibraryService } from "./service.mjs";

const READ = Object.freeze({ scope: "read" });
const WRITE = Object.freeze({ scope: "paper" });
const WRITE_JSON = Object.freeze({ scope: "paper", body: "json", bodyLimitBytes: 262_144 });
const IMPORT = Object.freeze({ scope: "paper", body: "json-or-text", bodyLimitBytes: 4_194_304 });

/** [method, path, route options, handler name] */
export const ROUTES = Object.freeze([
  ["GET", "/v1/collections", READ, "list"],
  ["POST", "/v1/collections", WRITE_JSON, "create"],
  ["POST", "/v1/collections/import", IMPORT, "import"],
  ["GET", "/v1/collections/:name", READ, "get"],
  ["PATCH", "/v1/collections/:name", WRITE_JSON, "update"],
  ["DELETE", "/v1/collections/:name", { scope: "paper", body: "none" }, "remove"],
  ["GET", "/v1/collections/:name/resolve", READ, "resolve"],
  ["POST", "/v1/collections/:name/duplicate", WRITE_JSON, "duplicate"],
  ["GET", "/v1/collections/:name/export", READ, "export"],
  ["GET", "/v1/collections/:name/usage", READ, "usage"],
  ["GET", "/v1/collections/:name/estimate", READ, "estimate"],
]);

/** @param {Parameters<typeof createLibraryService>[1]} [opts]  tests */
export function createLibraryModule(opts = {}) {
  return defineModule({
    name: "library",
    configKey: "library",
    configSchema: LIBRARY_CONFIG_SCHEMA,
    services: { library: (deps) => createLibraryService(deps, opts) },
    register(app, deps) {
      const handlers = createLibraryRoutes(deps);
      for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], { ...options });
    },
  });
}

export default createLibraryModule();
