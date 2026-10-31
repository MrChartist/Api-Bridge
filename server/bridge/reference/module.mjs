/**
 * reference module — stream S16 (docs/spec/p1-02-reference.md): the contract calendar, sessions, holidays, lots with
 * effective dates, freeze quantities, ban list, MWPL, F&O universe by date, corporate actions, rate and charges.
 * Contract service `reference` (deps.reference). Config section `reference` (config.mjs). Stores under
 * dataDir/reference/. A minute-tick scheduler runs the morning and evening syncs (only when NSE archive downloads are
 * turned on; never in demo mode).
 */
import { defineModule } from "../core/modules.mjs";
import { REFERENCE_CONFIG_SCHEMA } from "./config.mjs";
import { createReferenceService } from "./referenceService.mjs";
import { createReferenceRoutes } from "./routes.mjs";

const READ = Object.freeze({ scope: "read" });
const WRITE = Object.freeze({ scope: "admin", loopbackOnly: true });

/** [method, path, route options, handler name] — 20 operations (docs/openapi.yaml, x-stream S16). */
export const ROUTES = Object.freeze([
  ["GET", "/v1/reference/status", READ, "status"],
  ["GET", "/v1/reference/bundle", READ, "bundle"],
  ["GET", "/v1/reference/expiries", READ, "expiries"],
  ["GET", "/v1/reference/sessions", READ, "sessions"],
  ["GET", "/v1/reference/holidays", READ, "holidays"],
  ["GET", "/v1/reference/lots", READ, "lots"],
  ["GET", "/v1/reference/ban", READ, "ban"],
  ["GET", "/v1/reference/mwpl", READ, "mwpl"],
  ["GET", "/v1/reference/fno-universe", READ, "universe"],
  ["GET", "/v1/reference/corporate-actions", READ, "listActions"],
  ["POST", "/v1/reference/corporate-actions/preview", READ, "previewAction"],
  ["POST", "/v1/reference/corporate-actions", WRITE, "addAction"],
  ["DELETE", "/v1/reference/corporate-actions/:id", { ...WRITE, body: "none" }, "deleteAction"],
  ["GET", "/v1/reference/rate", READ, "rate"],
  ["PUT", "/v1/reference/rate", WRITE, "setRate"],
  ["GET", "/v1/reference/charges", READ, "charges"],
  ["GET", "/v1/reference/delivery-margin", READ, "deliveryMargin"],
  ["GET", "/v1/reference/events", READ, "events"],
  ["PUT", "/v1/reference/sources", WRITE, "setSources"],
  ["POST", "/v1/reference/sync", WRITE, "sync"],
]);

export default defineModule({
  name: "reference",
  stream: "S16",
  configKey: "reference",
  configSchema: REFERENCE_CONFIG_SCHEMA,
  services: { reference: (deps) => createReferenceService(deps) },
  register(app, deps) {
    const handlers = createReferenceRoutes(deps.reference, deps);
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], { ...options });
  },
  async start(deps) {
    deps.reference?.start?.();
  },
  async stop(deps) {
    deps.reference?.stop?.();
  },
});
