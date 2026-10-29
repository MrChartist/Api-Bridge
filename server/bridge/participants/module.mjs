/**
 * participants module — stream S26 (docs/spec/p1-12-guard-participants.md, P1-13a). Store S4: NSE participant-wise
 * open interest (one file a day after the close, a resumable back-fill, a deterministic demo history). Contract
 * service `participants` (deps.participants; P1-8 exposure reads latest()). Config section `participants`.
 * Store under dataDir/participants/. No broker call, no order path.
 */
import { defineModule } from "../core/modules.mjs";
import { PARTICIPANTS_CONFIG_SCHEMA } from "./config.mjs";
import { createParticipantRoutes } from "./routes.mjs";
import { createParticipantsService } from "./service.mjs";

const READ = Object.freeze({ scope: "read" });
const WRITE = Object.freeze({ scope: "admin", loopbackOnly: true });

/** [method, path, route options, handler name] — docs/openapi.yaml, x-stream S26. */
export const ROUTES = Object.freeze([
  ["GET", "/v1/participants/oi", READ, "oi"],
  ["GET", "/v1/participants/oi/summary", READ, "summary"],
  ["GET", "/v1/participants/status", READ, "status"],
  ["POST", "/v1/participants/sync", WRITE, "sync"],
]);

export default defineModule({
  name: "participants",
  stream: "S26",
  configKey: "participants",
  configSchema: PARTICIPANTS_CONFIG_SCHEMA,
  services: { participants: (deps) => createParticipantsService(deps) },
  register(app, deps) {
    const handlers = createParticipantRoutes(deps.participants, deps);
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], { ...options });
  },
  async start(deps) {
    deps.participants?.start?.();
  },
  async stop(deps) {
    deps.participants?.stop?.();
  },
});
