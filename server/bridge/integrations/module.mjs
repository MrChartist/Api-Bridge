/**
 * integrations module: spreadsheet (Excel, Google Sheets) and AmiBroker endpoints.
 * The routes below are the contract in docs/openapi.yaml (method, path,
 * auth, scope).
 *
 * Config section `integrations` (optional; see config.mjs): CSV and countback defaults for /xl.
 *
 * Safety: every route is a GET with scope "read", and the handlers only touch deps.marketData
 * (noOrders.test.mjs proves it), so nothing reachable from a spreadsheet formula or an AmiBroker
 * formula can place, modify or cancel an order. `?key=` works here only for read-only keys created with allowQuery
 * (enforced by the core pipeline).
 */
import { defineModule } from "../core/modules.mjs";
import { INTEGRATIONS_CONFIG_SCHEMA, parseIntegrationsConfig } from "./config.mjs";
import { createPortfolioRoutes } from "./portfolio.mjs";
import { createQuoteRoutes } from "./quotes.mjs";
import { tableError } from "./table.mjs";
import { createXlRoutes, xlError } from "./xl.mjs";

/**
 * Error bodies for failures raised before a handler runs (bad key, missing scope, client rate limit). A spreadsheet
 * cell should show #N/A, not problem+json.
 */
export const ERROR_FORMATTERS = Object.freeze({ xlCell: (err) => xlError(err), xlTable: (err, info) => tableError(err, info?.query) });

/** Single-cell routes answer #N/A; the batch tables answer a one-row table with the reason; chain/history keep problem+json. */
const CELL_ROUTES = new Set(["ltp", "quote"]);
const TABLE_ROUTES = new Set(["quotes", "instrument", "positions", "holdings", "funds", "orders"]);
const formatterFor = (group, name) => (CELL_ROUTES.has(name) ? ERROR_FORMATTERS.xlCell : TABLE_ROUTES.has(name) ? ERROR_FORMATTERS.xlTable : undefined);

/** The contract services the handlers read. Anything else is a bug (see noOrders.test.mjs). */
export const USED_SERVICES = Object.freeze(["marketData", "symbols", "orders", "accounts", "clock", "library"]);

/** The only methods of the order and account services these routes call, all reads (see noOrders.test.mjs). */
export const READ_METHODS = Object.freeze({ orders: ["positions", "holdings", "funds", "list"], accounts: ["list"], symbols: ["parse", "resolve"] });

/** [method, path, route options, handler group, handler name] */
export const ROUTES = Object.freeze([
  ["GET", "/xl/ltp", { scope: "read", allowQueryKey: true, summary: "LTP as plain text" }, "xl", "ltp"],
  ["GET", "/xl/quote", { scope: "read", allowQueryKey: true, summary: "One quote field as plain text" }, "xl", "quote"],
  ["GET", "/xl/chain", { scope: "read", allowQueryKey: true, summary: "Flat option chain (CSV or JSON)" }, "xl", "chain"],
  ["GET", "/xl/history", { scope: "read", allowQueryKey: true, summary: "Candles as CSV (standard or AmiBroker)" }, "xl", "history"],
  ["GET", "/xl/quotes", { scope: "read", allowQueryKey: true, summary: "Prices for many symbols as one table" }, "quotes", "quotes"],
  ["GET", "/xl/instrument", { scope: "read", allowQueryKey: true, summary: "Lot, tick and freeze quantity" }, "quotes", "instrument"],
  ["GET", "/xl/positions", { scope: "read", allowQueryKey: true, summary: "Positions as one table" }, "portfolio", "positions"],
  ["GET", "/xl/holdings", { scope: "read", allowQueryKey: true, summary: "Holdings as one table" }, "portfolio", "holdings"],
  ["GET", "/xl/funds", { scope: "read", allowQueryKey: true, summary: "Funds as one table" }, "portfolio", "funds"],
  ["GET", "/xl/orders", { scope: "read", allowQueryKey: true, summary: "Orders as one table" }, "portfolio", "orders"],
]);

export default defineModule({
  name: "integrations",
  configKey: "integrations",
  configSchema: INTEGRATIONS_CONFIG_SCHEMA,
  register(app, deps) {
    // Core has already validated and defaulted config.integrations; parsing again is cheap and keeps register()
    // usable with a hand-built facade in tests.
    const cfg = parseIntegrationsConfig(app.config?.integrations);
    const env = { demo: app.config?.demo === true };
    const handlers = { xl: createXlRoutes(deps, cfg), quotes: createQuoteRoutes(deps, cfg, env), portfolio: createPortfolioRoutes(deps, cfg, env) };
    for (const [method, path, options, group, name] of ROUTES) app.route(method, path, handlers[group][name], { ...options, formatError: formatterFor(group, name) });
  },
});
