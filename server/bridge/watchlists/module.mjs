/**
 * watchlists module — user watchlists. Routes:
 *
 *   GET    /v1/watchlists                    scope read   every list
 *   POST   /v1/watchlists                    scope paper  create { name, symbols?, events?, home? }
 *   PUT    /v1/watchlists/{listId}           scope paper  change any of those
 *   DELETE /v1/watchlists/{listId}           scope paper
 *   GET    /v1/watchlists/{listId}/quotes    scope read   last price, % change, OI and its change today for F&O, IV
 *
 * Lists hold symbols only, never secrets, and the module places nothing.
 */
import { defineModule } from "../core/modules.mjs";
import { createWatchlistService } from "./watchlistService.mjs";

export const ROUTES = Object.freeze([
  ["GET", "/v1/watchlists", { scope: "read" }, "list"],
  ["POST", "/v1/watchlists", { scope: "paper" }, "create"],
  ["PUT", "/v1/watchlists/:listId", { scope: "paper" }, "update"],
  ["DELETE", "/v1/watchlists/:listId", { scope: "paper", body: "none" }, "remove"],
  ["GET", "/v1/watchlists/:listId/quotes", { scope: "read" }, "quotes"],
]);

const services = new WeakMap();

export default defineModule({
  name: "watchlists",
  stream: "S29",
  register(app, deps) {
    const svc = createWatchlistService(deps);
    services.set(deps, svc);
    const meta = (ctx) => ({ requestId: ctx.requestId });
    const handlers = {
      list: async (ctx) => ({ data: { items: svc.list() }, meta: meta(ctx) }),
      create: async (ctx) => ({ data: svc.create(ctx.body), meta: meta(ctx) }),
      update: async (ctx) => ({ data: svc.update(ctx.params.listId, ctx.body), meta: meta(ctx) }),
      remove: async (ctx) => ({ data: svc.remove(ctx.params.listId), meta: meta(ctx) }),
      quotes: async (ctx) => ({ data: await svc.quotes(ctx.params.listId), meta: meta(ctx) }),
    };
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], options);
  },
});

export const watchlistServiceOf = (deps) => services.get(deps) ?? null;
