/**
 * market module — stream S5: Market data service and REST. Owned files and tasks: docs/STREAMS.md §S5.
 * The routes below are the contract in docs/openapi.yaml (method, path, auth, scope).
 *
 * Config section `market` (optional; see config.mjs): freshness targets, stale fallback, batch window, stream-first,
 * history chunking and option-chain source.
 */
import { isStub } from "../core/contracts.mjs";
import { defineModule } from "../core/modules.mjs";
import { MARKET_CONFIG_SCHEMA } from "./config.mjs";
import { createMarketDataService } from "./marketDataService.mjs";
import { createMarketRoutes } from "./routes.mjs";

/** [method, path, route options, handler name in createMarketRoutes()] */
export const ROUTES = Object.freeze([
  ["GET", "/v1/ltp", { scope: "read" }, "ltp"],
  ["GET", "/v1/quotes", { scope: "read" }, "quotes"],
  ["GET", "/v1/depth", { scope: "read" }, "depth"],
  ["GET", "/v1/history", { scope: "read" }, "history"],
  ["GET", "/v1/expiries", { scope: "read" }, "expiries"],
  ["GET", "/v1/optionchain", { scope: "read" }, "optionChain"],
]);

export default defineModule({
  name: "market",
  stream: "S5",
  configKey: "market",
  configSchema: MARKET_CONFIG_SCHEMA,
  services: { marketData: (deps) => createMarketDataService(deps) },
  register(app, deps) {
    const handlers = createMarketRoutes(deps);
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], options);
  },
  async stop(deps) {
    const svc = deps.marketData;
    if (svc && !isStub(svc) && typeof svc.close === "function") svc.close();
  },
});
