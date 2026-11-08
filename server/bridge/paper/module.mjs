/**
 * paper module: Paper trading engine.
 * The routes below are the contract in docs/openapi.yaml (method, path, auth, scope).
 *
 * Config section `paper` (optional; see config.mjs): starting capital (₹10,00,000), slippage (5 bps), depth use,
 * poll interval, intraday square-off and session-end times, approximate margin percentages, brokerage model,
 * history limit.
 *
 * Lifecycle: start() restores every configured account's paper book from <dataDir>/paper/, subscribes to `tick`
 * events and starts the poll timer that re-prices pending orders, squares off intraday positions and expires DAY
 * orders; stop() undoes that. State is written after every change; stop() also saves the latest position marks.
 */
import { isStub } from "../core/contracts.mjs";
import { defineModule } from "../core/modules.mjs";
import { PAPER_CONFIG_SCHEMA } from "./config.mjs";
import { createPaperEngine } from "./paperEngine.mjs";
import { createPaperRoutes } from "./routes.mjs";

/** [method, path, route options, handler name in createPaperRoutes()] */
export const ROUTES = Object.freeze([
  ["GET", "/v1/paper/accounts/:accountId", { scope: "read" }, "getAccount"],
  ["POST", "/v1/paper/accounts/:accountId/reset", { scope: "paper" }, "reset"],
  ["POST", "/v1/paper/accounts/:accountId/reset/undo", { scope: "paper" }, "undoReset"],
  ["POST", "/v1/paper/accounts/:accountId/margin", { scope: "read" }, "margin"],
  ["GET", "/v1/paper/accounts/:accountId/daily", { scope: "read" }, "daily"],
  ["POST", "/v1/paper/accounts/:accountId/daily", { scope: "paper", body: "none" }, "snapshot"],
]);

export default defineModule({
  name: "paper",
  stream: "S8",
  configKey: "paper",
  configSchema: PAPER_CONFIG_SCHEMA,
  services: { paper: (deps) => createPaperEngine(deps) },
  register(app, deps) {
    const handlers = createPaperRoutes(deps);
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], options);
  },
  async start(deps) {
    const svc = deps.paper;
    if (svc && !isStub(svc) && typeof svc.start === "function") svc.start();
  },
  async stop(deps) {
    const svc = deps.paper;
    if (svc && !isStub(svc) && typeof svc.stop === "function") svc.stop();
  },
});
