/**
 * integrations module — stream S10: charting datafeed (TradingView UDF) and spreadsheet/AmiBroker endpoints.
 * Owned files and tasks: docs/STREAMS.md §S10. The routes below are the contract in docs/openapi.yaml (method, path,
 * auth, scope).
 *
 * Config section `integrations` (optional; see config.mjs): UDF resolutions, Asia/Kolkata sessions per exchange,
 * search and countback limits, and CSV defaults for /xl.
 *
 * Safety: every route is a GET with scope "read", and the handlers only touch deps.marketData, deps.symbols and
 * deps.clock (noOrders.test.mjs proves it), so nothing reachable from a chart, a spreadsheet formula or an AmiBroker
 * formula can place, modify or cancel an order. `?key=` works here only for read-only keys created with allowQuery
 * (enforced by the core pipeline).
 */
import { defineModule } from "../core/modules.mjs";
import { INTEGRATIONS_CONFIG_SCHEMA, parseIntegrationsConfig } from "./config.mjs";
import { createUdfRoutes, udfError } from "./udf.mjs";
import { createXlRoutes, xlError } from "./xl.mjs";

/**
 * Error bodies for failures raised before a handler runs (bad key, missing scope, client rate limit). TradingView
 * reads any UDF body without `s` as data, and a spreadsheet cell should show #N/A, not problem+json.
 */
export const ERROR_FORMATTERS = Object.freeze({ udf: (err, info) => udfError(err, info), xlCell: (err) => xlError(err) });

/** Which formatter a route uses: every UDF route; only the single-cell /xl routes (chain/history keep problem+json). */
const formatterFor = (group, name) => (group === "udf" ? ERROR_FORMATTERS.udf : name === "ltp" || name === "quote" ? ERROR_FORMATTERS.xlCell : undefined);

/** The contract services the handlers read. Anything else is a bug (see noOrders.test.mjs). */
export const USED_SERVICES = Object.freeze(["marketData", "symbols"]);

/** [method, path, route options, handler group, handler name] */
export const ROUTES = Object.freeze([
  ["GET", "/udf/config", { scope: "read", allowQueryKey: true, summary: "UDF datafeed configuration" }, "udf", "config"],
  ["GET", "/udf/symbols", { scope: "read", allowQueryKey: true, summary: "UDF symbol info" }, "udf", "symbols"],
  ["GET", "/udf/search", { scope: "read", allowQueryKey: true, summary: "UDF symbol search" }, "udf", "search"],
  ["GET", "/udf/history", { scope: "read", allowQueryKey: true, summary: "UDF bars" }, "udf", "history"],
  ["GET", "/udf/time", { scope: "read", allowQueryKey: true, summary: "UDF server time" }, "udf", "time"],
  ["GET", "/udf/quotes", { scope: "read", allowQueryKey: true, summary: "UDF quotes" }, "udf", "quotes"],
  ["GET", "/xl/ltp", { scope: "read", allowQueryKey: true, summary: "LTP as plain text" }, "xl", "ltp"],
  ["GET", "/xl/quote", { scope: "read", allowQueryKey: true, summary: "One quote field as plain text" }, "xl", "quote"],
  ["GET", "/xl/chain", { scope: "read", allowQueryKey: true, summary: "Flat option chain (CSV or JSON)" }, "xl", "chain"],
  ["GET", "/xl/history", { scope: "read", allowQueryKey: true, summary: "Candles as CSV (standard or AmiBroker)" }, "xl", "history"],
]);

export default defineModule({
  name: "integrations",
  stream: "S10",
  configKey: "integrations",
  configSchema: INTEGRATIONS_CONFIG_SCHEMA,
  register(app, deps) {
    // Core has already validated and defaulted config.integrations; parsing again is cheap and keeps register()
    // usable with a hand-built facade in tests.
    const cfg = parseIntegrationsConfig(app.config?.integrations);
    const handlers = { udf: createUdfRoutes(deps, cfg), xl: createXlRoutes(deps, cfg) };
    for (const [method, path, options, group, name] of ROUTES) app.route(method, path, handlers[group][name], { ...options, formatError: formatterFor(group, name) });
  },
});
