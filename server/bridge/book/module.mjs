/**
 * book module — stream S27 (F2/F11; docs/spec/p1-12-guard-participants.md §2.1, §3.6, §4.3). The unified and family
 * positions book and the family gate. Routes only (no contract service): the handlers read orders (positions, funds),
 * marketData (quotes pinned to each holder's own account), accounts, symbols and reference, and never anything that
 * can place, modify or cancel an order (grep test). Config section `book` (see config.mjs); holder tags in
 * `<dataDir>/book/holders.json` (`book-demo/` in demo mode).
 *
 * familyGateFor(deps)(accountId) is the family gate guards (P1-12) and alert actions (P1-11) call before they act.
 */
import { isStub } from "../core/contracts.mjs";
import { defineModule } from "../core/modules.mjs";
import { startupJob, startupReady } from "../core/startup.mjs";
import { createBookService } from "./bookService.mjs";
import { BOOK_CONFIG_SCHEMA } from "./config.mjs";
import { seedDemoBook } from "./demoBook.mjs";
import { automationAllowed } from "./family.mjs";
import { createHolderStore } from "./holderStore.mjs";
import { createBookRoutes } from "./routes.mjs";

/** [method, path, route options, handler name] */
export const ROUTES = Object.freeze([
  ["GET", "/v1/book", { scope: "read", summary: "One book per holder, or the family view" }, "getBook"],
  ["GET", "/v1/book/holders", { scope: "read", summary: "Holders, relationships and family membership" }, "getHolders"],
  ["PUT", "/v1/book/holders/:holder", { scope: "admin", loopbackOnly: true, summary: "Set a holder's relationship" }, "putHolder"],
]);

/** The services the book reads. Nothing here may place, modify or cancel an order. */
export const USED_SERVICES = Object.freeze(["orders", "marketData", "accounts", "symbols", "reference", "audit"]);

const built = new WeakMap();

/** { service, store, gate } register() built for these deps (MCP, guards, alerts and tests), or null before. */
export function bookFor(deps) {
  return built.get(deps) ?? null;
}

/** The family gate for these deps: (accountId) => { ok, code, reason, holder, relationship }. */
export function familyGateFor(deps) {
  const b = built.get(deps);
  return (accountId) => automationAllowed(deps.config, b ? b.store.tags() : {}, accountId);
}

export default defineModule({
  name: "book",
  stream: "S27",
  configKey: "book",
  configSchema: BOOK_CONFIG_SCHEMA,
  register(app, deps) {
    const demo = deps.config?.demo === true;
    const store = createHolderStore({ paths: deps.paths, demo, clock: deps.clock, logger: deps.logger });
    const service = createBookService({
      config: deps.config,
      orders: deps.orders,
      marketData: deps.marketData,
      accounts: deps.accounts,
      symbols: deps.symbols,
      reference: deps.reference,
      holderTags: () => store.tags(),
      clock: deps.clock,
      logger: deps.logger,
    });
    built.set(deps, { service, store, gate: (id) => automationAllowed(deps.config, store.tags(), id) });
    const audit = deps.audit && !isStub(deps.audit) ? deps.audit : null;
    const handlers = createBookRoutes({ config: deps.config, service, store, audit, ready: () => startupReady(deps) });
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], { ...options });
  },
  async start(deps) {
    if (deps.config?.demo !== true) return;
    const b = built.get(deps);
    if (!b) return;
    // Demo: holder tags and a paper book across three holders, so the family view has something to show at once.
    // Seeding runs in the background (paper orders priced from the demo feed); a failure is logged, never fatal.
    b.stopping = false;
    const job = seedDemoBook({ ...deps, store: b.store, stopped: () => b.stopping }).catch((err) => deps.logger?.warn?.("demo book seed failed", { error: err?.message }));
    b.seeding = job;
    // Positions, funds, orders and the book wait for the seed while the Bridge starts, so a page opened at once never
    // shows a half-seeded book (core/startup.mjs).
    startupJob(deps, "demo book seed", job);
  },
  async stop(deps) {
    // Let a running demo seed finish (or fail) before the paper engine and stores shut down.
    const b = built.get(deps);
    if (b) b.stopping = true; // a seed waiting for headroom stops waiting
    await b?.seeding;
  },
});
