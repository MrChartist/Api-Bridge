/**
 * backup module — stream S12: free public market data (Yahoo Finance, NSE India website) as a labelled fallback when
 * no broker account can answer. Config section `backup` (see config.mjs); off by default and always off in demo mode.
 */
import { defineModule } from "../core/modules.mjs";
import { createBackupDataService } from "./backupService.mjs";
import { BACKUP_CONFIG_SCHEMA } from "./config.mjs";
import { createBackupRoutes } from "./routes.mjs";

/** [method, path, route options, handler name] */
export const ROUTES = Object.freeze([
  ["GET", "/v1/backup/status", { scope: "read" }, "status"],
  ["GET", "/v1/backup/quotes", { scope: "read" }, "quotes"],
  ["GET", "/v1/backup/history", { scope: "read" }, "history"],
]);

export default defineModule({
  name: "backup",
  stream: "S12",
  configKey: "backup",
  configSchema: BACKUP_CONFIG_SCHEMA,
  services: { backupData: (deps) => createBackupDataService(deps) },
  register(app, deps) {
    const handlers = createBackupRoutes(deps);
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], options);
  },
});
