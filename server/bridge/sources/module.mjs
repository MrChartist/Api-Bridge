/**
 * sources module: data sources beyond the user's own broker accounts.
 *
 * Provides deps.backupData (the service in service.mjs: the facade MarketDataService reads through when no broker can
 * answer, plus the management API), owns the `sources` config section (config.mjs) and serves
 * GET /v1/sources, PATCH /v1/sources/{id}, PUT /v1/sources/{id}/config and POST /v1/sources/{id}/test (routes.mjs).
 *
 * Other parts add their routes here when their files exist (they are optional, so a build without them still boots):
 *  - poolingRoutes.mjs   registerPoolingRoutes(app, deps)   GET/PUT/DELETE /v1/pooling...
 *  - traceRoutes.mjs     registerTraceRoutes(app, deps)     GET /v1/sources/trace (the router's dry run)
 * Those get `deps` plus `sources` (this service) and `sourceRegistry`.
 */
import { defineModule } from "../core/modules.mjs";
import { registerBuiltinSources } from "./builtin.mjs";
import { sourcesConfigSchema } from "./config.mjs";
import { createSourceRegistry } from "./registry.mjs";
import { ROUTES, createSourcesRoutes } from "./routes.mjs";
import { createSourcesService } from "./service.mjs";

export { ROUTES };

/** Files that may export a route registrar: [export name, candidate files in order]. */
const OPTIONAL_ROUTES = Object.freeze([
  ["registerPoolingRoutes", ["./poolingRoutes.mjs"]],
  ["registerTraceRoutes", ["./traceRoutes.mjs", "./trace.mjs", "./router.mjs"]],
]);

/** Import `file` next to this one; null when that file does not exist, a logged null when it exists but fails. */
async function importIfPresent(file, logger) {
  const url = new URL(file, import.meta.url);
  try {
    return await import(url.href);
  } catch (err) {
    const missing = err?.code === "ERR_MODULE_NOT_FOUND" && String(err.message).includes(file.slice(2));
    if (!missing) logger?.warn?.("a sources route file could not be loaded", { file, err: err?.message });
    return null;
  }
}

export default defineModule({
  name: "sources",
  configKey: "sources",
  configSchema: sourcesConfigSchema,
  services: {
    async backupData(deps) {
      const registry = createSourceRegistry({ logger: deps.logger });
      await registerBuiltinSources(registry, deps);
      const service = createSourcesService({ registry, config: deps.config, logger: deps.logger, clock: deps.clock, paths: deps.paths, secrets: deps.secrets });
      await service.refresh();
      return service;
    },
  },
  async stop(deps) {
    // Plugins run in their own processes: stop them with the Bridge.
    const registry = deps.backupData?.registry;
    if (!registry) return;
    await Promise.all(registry.list().map(async (p) => (typeof p.stop === "function" ? p.stop() : undefined)));
  },
  async register(app, deps) {
    const handlers = createSourcesRoutes(deps);
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], options);
    const shared = { ...deps, sources: deps.backupData, sourceRegistry: deps.backupData.registry };
    for (const [exportName, files] of OPTIONAL_ROUTES) {
      for (const file of files) {
        const mod = await importIfPresent(file, app.logger);
        if (typeof mod?.[exportName] === "function") {
          await mod[exportName](app, shared);
          break;
        }
      }
    }
  },
});
