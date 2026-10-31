/**
 * watchlists module — user watchlists. Routes:
 *
 *   GET    /v1/watchlists                    scope read   every list
 *   POST   /v1/watchlists                    scope paper  create { name, symbols?, events?, home? }
 *   PUT    /v1/watchlists/{listId}           scope paper  change any of those
 *   DELETE /v1/watchlists/{listId}           scope paper
 *   GET    /v1/watchlists/{listId}/quotes    scope read   last price, % change, OI and its change today for F&O, IV
 *
 * Aliases kept from PR 17 (docs/design/pr17-integration.md), same lists, PR 17's shapes:
 *
 *   GET    /v1/analytics/watchlists                  read    the lists as an array
 *   POST   /v1/analytics/watchlists                  read    create { name, symbols? } (201)
 *   PUT    /v1/analytics/watchlists/{listId}         read    { name?, symbols? } or { add?, remove? }
 *   DELETE /v1/analytics/watchlists/{listId}         read
 *   GET    /v1/analytics/watchlists/{listId}/quotes  read    { id, name, count, items } with errors beside data
 *
 * Lists hold symbols only, never secrets, and the module places nothing.
 */
import { BridgeError } from "../core/errors.mjs";
import { json } from "../core/http.mjs";
import { defineModule } from "../core/modules.mjs";
import { normaliseSymbol } from "../dashboard/watchlist-core.js";
import { createWatchlistService } from "./watchlistService.mjs";

export const ROUTES = Object.freeze([
  ["GET", "/v1/watchlists", { scope: "read" }, "list"],
  ["POST", "/v1/watchlists", { scope: "paper" }, "create"],
  ["PUT", "/v1/watchlists/:listId", { scope: "paper" }, "update"],
  ["DELETE", "/v1/watchlists/:listId", { scope: "paper", body: "none" }, "remove"],
  ["GET", "/v1/watchlists/:listId/quotes", { scope: "read" }, "quotes"],
]);

/**
 * PR 17's /v1/analytics/watchlists family, served by the same service (aliases). They keep PR 17's read scope for
 * changes, so read-only keys that used them keep working (a list holds symbols only); /v1/watchlists asks for paper.
 */
export const ALIAS_ROUTES = Object.freeze([
  ["GET", "/v1/analytics/watchlists", { scope: "read" }, "aliasList"],
  ["POST", "/v1/analytics/watchlists", { scope: "read" }, "aliasCreate"],
  ["PUT", "/v1/analytics/watchlists/:listId", { scope: "read" }, "aliasUpdate"],
  ["DELETE", "/v1/analytics/watchlists/:listId", { scope: "read", body: "none" }, "aliasRemove"],
  ["GET", "/v1/analytics/watchlists/:listId/quotes", { scope: "read" }, "aliasQuotes"],
]);

const aliasView = (l) => ({ id: l.id, name: l.name, symbols: [...(l.symbols ?? [])], createdAt: l.createdAt ?? null, updatedAt: l.updatedAt ?? l.createdAt ?? null });
/** PR 17's quote row from ours. */
const aliasRow = (r) => ({ symbol: r.symbol, ltp: r.ltp, change: r.change, changePct: r.changePct, volume: r.volume ?? null, oi: r.oi ?? null, dayHigh: r.dayHigh ?? null, dayLow: r.dayLow ?? null, open: r.open ?? null, prevClose: r.prevClose ?? null });

/** PR 17's update body ({ add, remove } beside name / symbols) as ours ({ name, symbols }). Pure. */
export function aliasUpdateBody(body, current) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BridgeError("VALIDATION_FAILED", "Send the watchlist as a JSON object.");
  const { add, remove, ...rest } = body;
  if (add === undefined && remove === undefined) return rest;
  if (rest.symbols !== undefined) throw new BridgeError("VALIDATION_FAILED", "symbols replaces the list; do not combine it with add or remove.", { errors: [{ path: "symbols", message: "symbols replaces the list; do not combine it with add or remove." }] });
  for (const [k, v] of [["add", add], ["remove", remove]]) if (v !== undefined && !Array.isArray(v)) throw new BridgeError("VALIDATION_FAILED", `${k} must be a list of symbols.`, { errors: [{ path: k, message: `${k} must be a list of symbols.` }] });
  const drop = new Set((remove ?? []).map((x) => normaliseSymbol(x) ?? String(x)));
  const next = (current.symbols ?? []).filter((x) => !drop.has(x));
  for (const x of add ?? []) {
    const n = normaliseSymbol(x) ?? String(x);
    if (!next.includes(n)) next.push(n);
  }
  return { ...rest, symbols: next };
}

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
      create: async (ctx) => ({ data: await svc.create(ctx.body), meta: meta(ctx) }),
      update: async (ctx) => ({ data: await svc.update(ctx.params.listId, ctx.body), meta: meta(ctx) }),
      remove: async (ctx) => ({ data: svc.remove(ctx.params.listId), meta: meta(ctx) }),
      quotes: async (ctx) => ({ data: await svc.quotes(ctx.params.listId), meta: meta(ctx) }),
      aliasList: async (ctx) => ({ data: svc.list().map(aliasView), meta: { ...meta(ctx), aliasOf: "/v1/watchlists" } }),
      aliasCreate: async (ctx) => json({ data: aliasView(await svc.create(ctx.body)), meta: { ...meta(ctx), aliasOf: "/v1/watchlists" } }, { status: 201 }),
      aliasUpdate: async (ctx) => {
        const cur = svc.get(ctx.params.listId);
        return { data: aliasView(await svc.update(cur.id, aliasUpdateBody(ctx.body, cur))), meta: { ...meta(ctx), aliasOf: "/v1/watchlists/{listId}" } };
      },
      aliasRemove: async (ctx) => ({ data: svc.remove(ctx.params.listId), meta: { ...meta(ctx), aliasOf: "/v1/watchlists/{listId}" } }),
      aliasQuotes: async (ctx) => {
        const q = await svc.quotes(ctx.params.listId);
        const items = q.rows.filter((r) => r.ltp !== null).map(aliasRow);
        const errors = q.errors.map((e) => ({ symbol: e.symbol, code: "SYMBOL_NOT_FOUND", message: e.message }));
        return { data: { id: q.id, name: q.name, count: q.rows.length, items }, errors, meta: { ...meta(ctx), aliasOf: "/v1/watchlists/{listId}/quotes", requested: q.rows.length, quoted: items.length } };
      },
    };
    for (const [method, path, options, name] of [...ROUTES, ...ALIAS_ROUTES]) app.route(method, path, handlers[name], options);
  },
});

export const watchlistServiceOf = (deps) => services.get(deps) ?? null;
