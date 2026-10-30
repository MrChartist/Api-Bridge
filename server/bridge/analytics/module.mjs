/**
 * analytics module — stream S15: options analytics computed from the Bridge's own chain, quotes and Black-Scholes
 * (OI and PCR, OI change, max pain, gamma exposure, IV skew and term structure, Greeks grid, synthetics, straddle,
 * futures chain and basis, FII/DII flows, expiry-day digest, strategy templates and finder, Greeks calculator,
 * payoff, position sizing, lot-split plans, position Greeks, alert rules). Nothing here can place an order: lot-split
 * only plans, and the only state kept is the saved alert rules.
 */
import { defineModule } from "../core/modules.mjs";
import { alertRuleRoutes, alertRulesFor } from "./alertRules.mjs";
import { expiryDayRoutes } from "./expiryDay.mjs";
import { flowsRoutes } from "./flows.mjs";
import { futuresChainRoutes } from "./futuresChain.mjs";
import { greeksGridRoutes } from "./greeksGrid.mjs";
import { oiTrackerRoutes } from "./oiTracker.mjs";
import { positionRoutes } from "./positions.mjs";
import { createAnalyticsRoutes } from "./routes.mjs";
import { strategyRoutes } from "./strategies.mjs";
import { volStatsRoutes } from "./volStats.mjs";
import { unusualRoutes } from "./unusual.mjs";
import { tideRoutes } from "./tide.mjs";
import { screenerRoutes } from "./screener.mjs";
import { marketEventsRoutes } from "./marketEvents.mjs";
import { exposureRoutes } from "./exposure.mjs";
import { watchlistRoutes } from "./watchlist.mjs";
import { optimizerRoutes } from "./optimizer.mjs";
import { participantsRoutes } from "./participants.mjs";
import { backtestRoutes } from "./backtest.mjs";

/** [method, path, route options, handler name] for the routes in routes.mjs. */
export const ROUTES = Object.freeze([
  ["GET", "/v1/analytics/oi", { scope: "read" }, "oi"],
  ["GET", "/v1/analytics/gex", { scope: "read" }, "gex"],
  ["GET", "/v1/analytics/skew", { scope: "read" }, "skew"],
  ["GET", "/v1/analytics/surface", { scope: "read" }, "surface"],
  ["GET", "/v1/analytics/basis", { scope: "read" }, "basis"],
  ["GET", "/v1/analytics/greeks", { scope: "read" }, "greeks"],
  ["POST", "/v1/analytics/payoff", { scope: "read" }, "payoff"],
  ["POST", "/v1/analytics/position-size", { scope: "read" }, "positionSize"],
]);

/** The services analytics reads. Nothing here may reach paper or safety, and orders only for reading positions. */
export const USED_SERVICES = Object.freeze(["marketData", "orders", "accounts", "backupData"]);

/** Feature files that build their own [method, path, options, handler] entries. */
const FEATURE_ROUTES = Object.freeze([oiTrackerRoutes, greeksGridRoutes, strategyRoutes, futuresChainRoutes, flowsRoutes, expiryDayRoutes, alertRuleRoutes, positionRoutes, unusualRoutes, tideRoutes, exposureRoutes, volStatsRoutes, marketEventsRoutes, screenerRoutes, backtestRoutes, participantsRoutes, optimizerRoutes, watchlistRoutes]);

export default defineModule({
  name: "analytics",
  stream: "S15",
  register(app, deps) {
    const handlers = createAnalyticsRoutes(deps);
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], options);
    for (const build of FEATURE_ROUTES) for (const [method, path, options, handler] of build(deps)) app.route(method, path, handler, options);
  },
  async start(deps) {
    alertRulesFor(deps)?.startSchedule?.();
  },
  async stop(deps) {
    alertRulesFor(deps)?.stop?.();
  },
});
