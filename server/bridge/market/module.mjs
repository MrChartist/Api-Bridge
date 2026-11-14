/**
 * market module: Market data service and REST.
 * The routes below are the contract in docs/openapi.yaml (method, path, auth, scope).
 *
 * Config section `market` (optional; see config.mjs): freshness targets, stale fallback, batch window, stream-first,
 * history chunking and option-chain source.
 */
import { isStub } from "../core/contracts.mjs";
import { defineModule } from "../core/modules.mjs";
import { createCalendarRoutes } from "./calendarRoutes.mjs";
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
  ["GET", "/v1/calendar/holidays", { scope: "read" }, "calendarHolidays"],
  ["GET", "/v1/calendar/sessions", { scope: "read" }, "calendarSessions"],
  ["GET", "/v1/calendar/status", { scope: "read" }, "calendarStatus"],
]);

export default defineModule({
  name: "market",
  configKey: "market",
  configSchema: MARKET_CONFIG_SCHEMA,
  services: { marketData: (deps) => createMarketDataService(deps) },
  register(app, deps) {
    const handlers = { ...createMarketRoutes(deps), ...createCalendarRoutes(deps) };
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], options);
  },
  async stop(deps) {
    const svc = deps.marketData;
    if (svc && !isStub(svc) && typeof svc.close === "function") svc.close();
  },
});
