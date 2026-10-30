/**
 * journal module — the trade journal (BRD I5, S8 journal store). Routes:
 *
 *   GET /v1/journal                    scope read   trades from every fill on the accounts this key may use (or
 *                                                   ?account=), grouped by strategy group, with tags, notes and
 *                                                   setup; the daily P&L snapshots; stats by structure and by tag
 *   PUT /v1/journal/trades/{tradeId}   scope paper  set { tags?, notes?, setup? } on a trade
 *
 * Reads only: the journal never places, changes or cancels an order. Demo mode adds sample history (demoHistory.mjs).
 */
import { BridgeError } from "../core/errors.mjs";
import { defineModule } from "../core/modules.mjs";
import { createJournalService } from "./journalService.mjs";

export const ROUTES = Object.freeze([
  ["GET", "/v1/journal", { scope: "read" }, "list"],
  ["PUT", "/v1/journal/trades/:tradeId", { scope: "paper" }, "annotate"],
]);

const services = new WeakMap();

export default defineModule({
  name: "journal",
  stream: "S28",
  register(app, deps) {
    const svc = createJournalService(deps);
    services.set(deps, svc);
    const meta = (ctx) => ({ requestId: ctx.requestId });
    const allowed = (ctx) =>
      (deps.config?.accounts ?? []).filter((a) => {
        try {
          ctx.requireAccountAccess(a.id);
          return true;
        } catch {
          return false;
        }
      });
    const handlers = {
      list: async (ctx) => {
        const want = ctx.query.get("account");
        let accounts = allowed(ctx);
        if (want) {
          ctx.requireAccountAccess(String(want));
          accounts = accounts.filter((a) => a.id === want);
          if (!accounts.length) throw new BridgeError("ACCOUNT_NOT_FOUND", `No account ${want} in the Bridge config.`);
        }
        return { data: await svc.journal(ctx, accounts), meta: meta(ctx) };
      },
      annotate: async (ctx) => ({ data: svc.annotate(ctx.params.tradeId, ctx.body), meta: meta(ctx) }),
    };
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], options);
  },
});

/** The service for a deps object (tests). */
export const journalServiceOf = (deps) => services.get(deps) ?? null;
