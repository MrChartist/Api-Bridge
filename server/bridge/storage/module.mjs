/**
 * storage module: watches free disk space and write failures on the data folder (monitor.mjs), sweeps temp files that a
 * cut-off write left behind, and reports problems in GET /v1/health and GET /v1/ready (core/healthProblems.mjs).
 *
 * Owns config section `storage` (config.mjs). No routes and no contract service: the monitor lives in a WeakMap keyed by
 * the app's deps (registry.mjs), like the backup module's manager. `opts` (statfs, setInterval, clearInterval) are for tests.
 */
import { defineModule } from "../core/modules.mjs";
import { sweepStaleTemps } from "../core/instanceLock.mjs";
import { STORAGE_CONFIG_SCHEMA, storageSettings } from "./config.mjs";
import { createStorageMonitor } from "./monitor.mjs";
import { monitors } from "./registry.mjs";

/** @param {{ statfs?: (dir: string) => any, setInterval?: typeof setInterval, clearInterval?: typeof clearInterval }} [opts] */
export function createStorageModule(opts = {}) {
  return defineModule({
    name: "storage",
    configKey: "storage",
    configSchema: STORAGE_CONFIG_SCHEMA,
    register(app, deps) {
      monitors.set(
        deps,
        createStorageMonitor({
          dataDir: deps.paths.dataDir,
          cfg: storageSettings(deps.config),
          bus: deps.bus,
          logger: deps.logger.child({ module: "storage" }),
          now: () => deps.clock.now(),
          ...(opts.statfs ? { statfs: opts.statfs } : {}),
          ...(opts.setInterval ? { setInterval: opts.setInterval, clearInterval: opts.clearInterval } : {}),
        }),
      );
    },
    async start(deps) {
      const log = deps.logger.child({ module: "storage" });
      try {
        const removed = sweepStaleTemps(deps.paths.dataDir);
        if (removed.length) log.info("removed temp files a cut-off write left behind", { count: removed.length });
      } catch (err) {
        log.warn("temp files could not be swept", { err: String(err?.message ?? err) });
      }
      monitors.get(deps)?.start();
    },
    async stop(deps) {
      monitors.get(deps)?.stop();
    },
  });
}

export default createStorageModule();
