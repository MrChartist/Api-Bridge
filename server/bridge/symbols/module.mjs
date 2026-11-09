/**
 * symbols module: Symbology and instruments.
 * The routes below are the contract in docs/openapi.yaml (method, path, auth, scope).
 *
 * Config section `symbols` (optional; see symbolsConfig.mjs). On start the module warms the instrument masters of
 * every connected broker in the background (scheduler class "master", priority "background"); requests never wait
 * for a broker that is still downloading unless its master is missing altogether.
 */
import { isStub } from "../core/contracts.mjs";
import { defineModule } from "../core/modules.mjs";
import { createSymbolRoutes } from "./routes.mjs";
import { createSymbolService } from "./symbolService.mjs";
import { SYMBOLS_CONFIG_SCHEMA } from "./symbolsConfig.mjs";

/** [method, path, route options, handler name in createSymbolRoutes()] */
export const ROUTES = Object.freeze([
  ["GET", "/v1/instruments/search", { scope: "read", summary: "Search instruments across connected brokers' masters" }, "search"],
  ["GET", "/v1/instruments/:symbol", { scope: "read", summary: "Resolve one instrument (lot size, tick size, freeze quantity)" }, "instrument"],
  ["GET", "/v1/symbols/convert", { scope: "read", summary: "Convert one symbol between formats" }, "convertOne"],
  ["POST", "/v1/symbols/convert", { scope: "read", summary: "Convert up to 200 symbols in one call" }, "convertMany"],
  ["GET", "/v1/symbols/resolve", { scope: "read", summary: "Resolve a name to one instrument with the reason; ambiguous names return candidates" }, "resolve"],
  ["GET", "/v1/symbols/validate", { scope: "read", summary: "Check one symbol: canonical form, lot size, tradable" }, "validateOne"],
  ["POST", "/v1/symbols/validate", { scope: "read", summary: "Check up to 200 symbols in one call" }, "validateMany"],
]);

export default defineModule({
  name: "symbols",
  configKey: "symbols",
  configSchema: SYMBOLS_CONFIG_SCHEMA,
  services: { symbols: (deps) => createSymbolService(deps) },
  register(app, deps) {
    const handlers = createSymbolRoutes(deps);
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], options);
  },
  async start(deps) {
    const svc = deps.symbols;
    if (!svc || isStub(svc) || typeof svc.warm !== "function") return;
    if (deps.config?.symbols?.warmOnStart === false) return;
    // Background: a slow or failing broker must not delay the listener.
    svc.warm().catch((err) => deps.logger?.warn("instrument warm-up failed", { code: err?.code }));
  },
  async stop(deps) {
    const svc = deps.symbols;
    if (svc && !isStub(svc) && typeof svc.close === "function") svc.close();
  },
});
