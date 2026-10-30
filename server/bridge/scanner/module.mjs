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
import { eventsFor } from "../events/module.mjs";
import { fnoFor } from "../fno/module.mjs";

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
  ["PATCH", "/v1/scanner/saved/:savedId", { scope: "read" }, "updateSaved"],
  ["POST", "/v1/scanner/saved/:savedId/duplicate", { scope: "read", body: "none" }, "duplicateSaved"],
  ["GET", "/v1/scanner/saved/:savedId/results", { scope: "read", allowQueryKey: true }, "savedResults"],
  ["GET", "/v1/scanner/library", { scope: "read" }, "library"],
  ["POST", "/v1/scanner/compile", { scope: "read" }, "compile"],
  ["POST", "/v1/scanner/count", { scope: "read" }, "count"],
  ["GET", "/v1/scanner/scan", { scope: "read", allowQueryKey: true }, "scanFromQuery"],
]);

/** The services the scanner reads. Nothing here may reach orders, paper or safety. */
export const USED_SERVICES = Object.freeze(["marketData", "accounts", "scheduler", "symbols", "backupData", "reference", "recorder"]);

/** One scanner per app (tests build many apps in one process). */
const scanners = new WeakMap();

/** The scanner register() built for these deps (the MCP scan tool), or null before registration. */
export function scannerFor(deps) {
  return scanners.get(deps) ?? null;
}

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
      reference: deps.reference,
      recorder: deps.recorder,
      // Getters: Live events (scan hits) and the option sweep (chains) are built by their own modules.
      events: () => eventsFor(deps),
      fno: () => fnoFor(deps),
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
