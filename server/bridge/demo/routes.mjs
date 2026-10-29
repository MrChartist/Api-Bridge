/**
 * Demo-only routes (docs/spec/README.md §3.1, F0). They exist ONLY when the Bridge runs in demo mode; a Bridge with
 * real accounts never registers them, so no demo control can reach real data or real money.
 *
 * Each Phase 1 spec that needs a demo control adds ONE entry to DEMO_ROUTES below, and in the same commit:
 *  - documents the operation in docs/openapi.yaml with `x-demo-only: true` (plus its usual x-scope and x-stream);
 *  - adds "METHOD /path" to the DEMO_ONLY list in server/bridge/core/openapi.test.mjs.
 * Planned: POST /v1/demo/feed (p1-04), POST /v1/demo/readiness (p1-05), the ban override (p1-06), alert simulate
 * (p1-11), guard scenarios (p1-12).
 *
 * Rules every entry follows (checked by registerDemoRoutes):
 *  - the path starts with /v1/demo/;
 *  - `module` names the module whose stream owns the route (route logs and the OpenAPI x-stream check use it), and
 *    that module must be loaded;
 *  - never `public: true` (demo controls are for this computer and the person trying the demo, not public ingress);
 *  - `handler(deps)` returns the request handler; it reads only services, never touches files outside dataDir.
 */

import { createReadinessRoutes } from "../readiness/routes.mjs";
import { BridgeError } from "../core/errors.mjs";

/**
 * @typedef {{ module: string, method: "GET"|"POST"|"PUT"|"PATCH"|"DELETE", path: string,
 *   options: { scope?: string, auth?: string, loopbackOnly?: boolean, summary?: string, [k: string]: unknown },
 *   handler: (deps: any) => (ctx: any) => unknown }} DemoRoute
 */

/** @type {readonly DemoRoute[]} */
export const DEMO_ROUTES = Object.freeze([
  // p1-05 §4.4: simulate a readiness failure on the demo account (restores itself after 10 minutes). Scope read, not
  // loopback-only, so the public demo can use it; it touches only simulated in-memory state.
  Object.freeze({
    module: "readiness",
    method: "POST",
    path: "/v1/demo/readiness",
    options: { scope: "read", summary: "Demo mode only: simulate a readiness failure on the demo account" },
    handler: (deps) => createReadinessRoutes(deps).demoScenario,
  }),
  // p1-02 (P1-2b): make the demo's lot data stale, so LOT_SIZE_STALE, the stale banner and the ticket's lot-size
  // confirmation can be tried end to end (the bundle's ?demoStale=1 only changes that one read).
  Object.freeze({
    module: "reference",
    method: "PUT",
    path: "/v1/demo/reference",
    options: { scope: "admin", loopbackOnly: true, summary: "Demo: report the reference lot data as two trading days old" },
    handler: (deps) => async (ctx) => {
      const b = ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body) ? ctx.body : null;
      if (!b || typeof b.lotsStale !== "boolean") throw new BridgeError("VALIDATION_FAILED", "Send { lotsStale: true | false }.", { field: "lotsStale" });
      return { data: { lotsStale: deps.reference.setDemoLotsStale(b.lotsStale) }, meta: { requestId: ctx.requestId } };
    },
  }),
]);

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * Register the demo-only routes. Does nothing (returns 0) unless `config.demo` is true.
 * @param {{ config: any, facadeFor: (moduleName: string) => { route(method: string, path: string, handler: Function, options?: object): void },
 *   deps: any, modules: Array<{ name: string }>, routes?: readonly DemoRoute[] }} opts
 * @returns {number} how many routes were registered
 */
export function registerDemoRoutes({ config, facadeFor, deps, modules, routes = DEMO_ROUTES }) {
  if (config?.demo !== true) return 0;
  const loaded = new Set(modules.map((m) => m.name));
  let n = 0;
  for (const r of routes) {
    if (!METHODS.has(r.method)) throw new Error(`Demo route ${r.method} ${r.path}: unknown method`);
    if (typeof r.path !== "string" || !r.path.startsWith("/v1/demo/")) throw new Error(`Demo route ${r.method} ${r.path}: path must start with /v1/demo/`);
    if (r.options?.public) throw new Error(`Demo route ${r.method} ${r.path}: demo routes are never public`);
    if (typeof r.handler !== "function") throw new Error(`Demo route ${r.method} ${r.path}: handler(deps) is required`);
    // A route whose owning module is not loaded (tests that boot a subset) is skipped, like the module's own routes.
    if (!loaded.has(r.module)) continue;
    facadeFor(r.module).route(r.method, r.path, r.handler(deps), { ...r.options });
    n += 1;
  }
  return n;
}

/** "METHOD /path" keys of the demo-only routes (the OpenAPI test compares them with x-demo-only operations). */
export const demoRouteKeys = (routes = DEMO_ROUTES) => routes.map((r) => `${r.method} ${r.path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}")}`);
