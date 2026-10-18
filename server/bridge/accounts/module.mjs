/**
 * accounts module — stream S1: Accounts and broker sessions. Owned files and tasks: docs/STREAMS.md §S1.
 * The routes below are the contract in docs/openapi.yaml (method, path, auth, scope).
 *
 * Lifecycle: start() runs the AccountManager's SecretStore watcher (so a session saved by the CLI in another
 * process is picked up) and its daily-expiry timers; stop() ends them.
 */
import { defineModule } from "../core/modules.mjs";
import { createAccountManager } from "./accountManager.mjs";
import { createAccountRoutes, loadRoutePolicies } from "./routes.mjs";

/** Body cap for the connect route. Saved values are small in practice; 16 KB is ample and bounds abuse. */
export const SESSION_BODY_LIMIT_BYTES = 16 * 1024;

/** [method, path, route options, handler name] */
export const ROUTES = Object.freeze([
  ["GET", "/v1/brokers", { scope: "read" }, "listBrokers"],
  ["GET", "/v1/accounts", { scope: "read" }, "listAccounts"],
  ["GET", "/v1/accounts/:accountId", { scope: "read" }, "getAccount"],
  ["POST", "/v1/accounts/:accountId/session", { scope: "admin", loopbackOnly: true, bodyLimitBytes: SESSION_BODY_LIMIT_BYTES }, "connect"],
  ["DELETE", "/v1/accounts/:accountId/session", { scope: "admin", loopbackOnly: true, body: "none" }, "disconnect"],
  ["POST", "/v1/accounts/:accountId/test", { scope: "read", body: "none" }, "test"],
]);

export default defineModule({
  name: "accounts",
  stream: "S1",
  services: { accounts: (deps) => createAccountManager(deps) },
  async register(app, deps) {
    const policies = await loadRoutePolicies(app.logger);
    const handlers = createAccountRoutes(deps, { policies });
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], options);
  },
  async start(deps) {
    if (typeof deps.accounts?.start === "function") await deps.accounts.start();
  },
  async stop(deps) {
    if (typeof deps.accounts?.stop === "function") await deps.accounts.stop();
  },
});
