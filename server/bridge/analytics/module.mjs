/**
 * analytics module — stream S15: options analytics computed from the Bridge's own chain, quotes and Black-Scholes
 * (OI and PCR, max pain, gamma exposure, IV skew and term structure, futures basis, Greeks calculator, strategy
 * payoff, position sizing). Routes only, read scope, and nothing here can reach orders, paper or safety.
 */
import { defineModule } from "../core/modules.mjs";
import { createAnalyticsRoutes } from "./routes.mjs";

/** [method, path, route options, handler name] */
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

/** The services analytics reads. Nothing here may reach orders, paper or safety. */
export const USED_SERVICES = Object.freeze(["marketData"]);

export default defineModule({
  name: "analytics",
  stream: "S15",
  register(app, deps) {
    const handlers = createAnalyticsRoutes(deps);
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], options);
  },
});
