/**
 * scanner module — stream S13: condition scans over big symbol universes, shared out over the user's pooled accounts
 * at background priority, with the backup sources as a fallback. Routes only (no contract service): the handlers
 * use marketData, accounts, scheduler, symbols and backupData, and never anything that can place an order.
 * Config section `scanner` (see config.mjs).
 */
import { defineModule } from "../core/modules.mjs";
import { SCANNER_CONFIG_SCHEMA } from "./config.mjs";
import { createScannerRoutes } from "./routes.mjs";
import { createScanner } from "./scanService.mjs";

/** [method, path, route options, handler name] */
export const ROUTES = Object.freeze([
  ["GET", "/v1/scanner/language", { scope: "read" }, "language"],
  ["GET", "/v1/scanner/universes", { scope: "read" }, "universes"],
  ["GET", "/v1/scanner/universes/:name", { scope: "read" }, "universe"],
  ["POST", "/v1/scanner/plan", { scope: "read" }, "plan"],
  ["POST", "/v1/scanner/jobs", { scope: "read" }, "startJob"],
  ["GET", "/v1/scanner/jobs", { scope: "read" }, "listJobs"],
  ["GET", "/v1/scanner/jobs/:jobId", { scope: "read" }, "getJob"],
  ["DELETE", "/v1/scanner/jobs/:jobId", { scope: "read", body: "none" }, "cancelJob"],
  ["GET", "/v1/scanner/saved", { scope: "read" }, "listSaved"],
  ["POST", "/v1/scanner/saved", { scope: "read" }, "createSaved"],
  ["DELETE", "/v1/scanner/saved/:savedId", { scope: "read", body: "none" }, "deleteSaved"],
  ["POST", "/v1/scanner/saved/:savedId/run", { scope: "read", body: "none" }, "runSaved"],
]);

/** The services the scanner reads. Nothing here may reach orders, paper or safety. */
export const USED_SERVICES = Object.freeze(["marketData", "accounts", "scheduler", "symbols", "backupData"]);

/** One scanner per app (tests build many apps in one process). */
const scanners = new WeakMap();

export default defineModule({
  name: "scanner",
  stream: "S13",
  configKey: "scanner",
  configSchema: SCANNER_CONFIG_SCHEMA,
  register(app, deps) {
    const scanner = createScanner({
      config: deps.config,
      marketData: deps.marketData,
      accounts: deps.accounts,
      scheduler: deps.scheduler,
      symbols: deps.symbols,
      backupData: deps.backupData,
      bus: deps.bus,
      clock: deps.clock,
      paths: deps.paths,
      logger: deps.logger,
    });
    scanners.set(deps, scanner);
    const handlers = createScannerRoutes(scanner);
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], options);
  },
  async start(deps) {
    scanners.get(deps)?.startSchedule();
  },
  async stop(deps) {
    scanners.get(deps)?.stop();
  },
});
