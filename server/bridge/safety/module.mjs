/**
 * safety module — stream S9: Safety guard and audit log. Owned files and tasks: docs/STREAMS.md §S9.
 *
 * Provides deps.audit (auditLog.mjs) and deps.safety (safetyGuard.mjs) and serves the Safety routes
 * (routes.mjs). The route table below is the contract in docs/openapi.yaml (method, path, auth, scope);
 * core/openapi.test.mjs fails if it drifts. Uses the core-owned config.safety section; owns no config section.
 */
import { defineModule } from "../core/modules.mjs";
import { createAuditLog } from "./auditLog.mjs";
import { createSafetyRoutes } from "./routes.mjs";
import { createSafetyGuard } from "./safetyGuard.mjs";

/** [method, path, route options, handler name] */
export const ROUTES = Object.freeze([
  ["GET", "/v1/safety", { scope: "read" }, "getSafety"],
  ["POST", "/v1/safety/kill-switch", { scope: "read" }, "engageKillSwitch"],
  ["DELETE", "/v1/safety/kill-switch", { scope: "admin", loopbackOnly: true }, "releaseKillSwitch"],
  ["GET", "/v1/audit", { scope: "admin", loopbackOnly: true }, "queryAudit"],
  ["GET", "/v1/audit/verify", { scope: "admin", loopbackOnly: true }, "verifyAudit"],
]);

export default defineModule({
  name: "safety",
  stream: "S9",
  services: { safety: (deps) => createSafetyGuard(deps), audit: (deps) => createAuditLog(deps) },
  register(app, deps) {
    const handlers = createSafetyRoutes(deps);
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], options);
  },
});
