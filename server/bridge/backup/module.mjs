/**
 * backup module: copies of the data folder that cannot be made again (keys store, accounts, state, quotas, paper books,
 * order records, audit log, settings), a copy before the Bridge version changes, and an optional daily backup.
 *
 * Owns config section `backup` (config.mjs), the routes below (docs/openapi.yaml, x-module: backup) and the
 * `backup` / `restore` commands (cli.mjs). Owns no contract service: a small manager per app is built in register()
 * and stopped in stop(). Bus topics backup.completed and backup.failed carry no file contents, only name, size and time.
 */
import { defineModule } from "../core/modules.mjs";
import { BRIDGE_VERSION } from "../core/app.mjs";
import { BACKUP_CONFIG_SCHEMA } from "./config.mjs";
import { createBackupManager } from "./manager.mjs";
import { createBackupRoutes } from "./routes.mjs";

/** [method, path, route options, handler name] */
export const ROUTES = Object.freeze([
  ["GET", "/v1/backup", { scope: "admin", loopbackOnly: true }, "getBackup"],
  ["POST", "/v1/backup", { scope: "admin", loopbackOnly: true }, "createBackup"],
]);

/** deps -> manager, so start() and stop() find what register() built. */
const managers = new WeakMap();

/** The backup manager of an app (undefined before register). */
export const backupManagerOf = (deps) => managers.get(deps);

export default defineModule({
  name: "backup",
  configKey: "backup",
  configSchema: BACKUP_CONFIG_SCHEMA,
  register(app, deps) {
    const manager = createBackupManager({
      dataDir: deps.paths.dataDir,
      configFile: deps.paths.configFile,
      config: deps.config,
      bridgeVersion: BRIDGE_VERSION,
      logger: deps.logger.child({ module: "backup" }),
      bus: deps.bus,
      clock: deps.clock,
    });
    managers.set(deps, manager);
    const handlers = createBackupRoutes({ deps, manager });
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], { ...options });
  },
  async start(deps) {
    managers.get(deps)?.start();
  },
  async stop(deps) {
    managers.get(deps)?.stop();
  },
});
