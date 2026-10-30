/**
 * alerts module — stream S24 (position alerts; docs/spec/p1-11-alerts.md is the wider plan). Routes:
 *
 *   GET    /v1/alerts                 scope read   rules on accounts the key may use, newest first
 *   POST   /v1/alerts                 scope paper  create { name?, account, underlying, symbols?, conditions[], match?,
 *                                                  repeat?, cooldownMin?, notify? }
 *   PUT    /v1/alerts/{alertId}       scope paper  change any of those, or { enabled }
 *   DELETE /v1/alerts/{alertId}       scope paper
 *   GET    /v1/alerts/inbox           scope read   fires, newest first, and how many are unread
 *   POST   /v1/alerts/inbox/read      scope read   mark every fire read
 *
 *   GET    /v1/alerts/market                       scope read   market rules (PR 17's 11 analytics metrics)
 *   POST   /v1/alerts/market                       scope read   save { name, underlying, expiry?, metric, op?, value?, to?, ... }
 *   DELETE /v1/alerts/market/{ruleId}              scope read
 *   POST   /v1/alerts/market/{ruleId}/check        scope read   evaluate now (?dryRun=true leaves state and phone alone)
 *   /v1/analytics/alert-rules[...]                              the same four, PR 17's paths (aliases)
 *
 * Market rules run in analytics/alertRules.mjs (chain metrics through marketData, background priority); a fire lands in
 * this module's inbox, so the bell shows position and market alerts together. The evaluation loops run from start()
 * and only notify: they place no order.
 */
import { BridgeError } from "../core/errors.mjs";
import { defineModule } from "../core/modules.mjs";
import { createAlertService } from "./alertService.mjs";
import { alertRuleRoutes, alertRulesFor } from "../analytics/alertRules.mjs";

export const ROUTES = Object.freeze([
  ["GET", "/v1/alerts", { scope: "read" }, "list"],
  ["POST", "/v1/alerts", { scope: "paper" }, "create"],
  ["GET", "/v1/alerts/inbox", { scope: "read" }, "inbox"],
  ["POST", "/v1/alerts/inbox/read", { scope: "read", body: "none" }, "read"],
  ["PUT", "/v1/alerts/:alertId", { scope: "paper" }, "update"],
  ["DELETE", "/v1/alerts/:alertId", { scope: "paper", body: "none" }, "remove"],
]);

/** Where the market rules are served: ours first, then PR 17's paths (aliases, docs/design/pr17-integration.md). */
export const MARKET_BASES = Object.freeze(["/v1/alerts/market", "/v1/analytics/alert-rules"]);

const services = new WeakMap();

/** A filter over account ids: the ones this key may use. */
const allowedFor = (ctx) => (id) => {
  try {
    ctx.requireAccountAccess(id);
    return true;
  } catch {
    return false;
  }
};

export default defineModule({
  name: "alerts",
  stream: "S24",
  register(app, deps) {
    const svc = createAlertService(deps);
    services.set(deps, svc);
    const meta = (ctx) => ({ requestId: ctx.requestId });
    const body = (ctx) => {
      if (!ctx.body || typeof ctx.body !== "object" || Array.isArray(ctx.body)) throw new BridgeError("VALIDATION_FAILED", "Send the alert as a JSON object.");
      return ctx.body;
    };
    const handlers = {
      list: async (ctx) => ({ data: { items: svc.list(allowedFor(ctx)) }, meta: meta(ctx) }),
      create: async (ctx) => {
        const b = body(ctx);
        ctx.requireAccountAccess(String(b.account ?? ""));
        return { data: svc.create(b), meta: meta(ctx) };
      },
      update: async (ctx) => {
        const r = svc.get(ctx.params.alertId);
        ctx.requireAccountAccess(r.account);
        const b = body(ctx);
        if (b.account !== undefined) ctx.requireAccountAccess(String(b.account));
        return { data: svc.update(r.id, b), meta: meta(ctx) };
      },
      remove: async (ctx) => {
        const r = svc.get(ctx.params.alertId);
        ctx.requireAccountAccess(r.account);
        svc.remove(r.id);
        return { data: { removed: r.id }, meta: meta(ctx) };
      },
      inbox: async (ctx) => ({ data: svc.inbox(allowedFor(ctx)), meta: meta(ctx) }),
      read: async (ctx) => {
        svc.markRead();
        return { data: svc.inbox(allowedFor(ctx)), meta: meta(ctx) };
      },
    };
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], options);
    // Market rules: one engine, the canonical paths and PR 17's alias paths.
    for (const base of MARKET_BASES) for (const [method, path, options, handler] of alertRuleRoutes(deps, { base })) app.route(method, path, handler, options);
    // A market rule's fire goes into the same inbox as position alerts (notify already sends it as scan.alert).
    deps.bus?.on?.("analytics.alert", (p) => svc.record({ ruleId: p.ruleId, name: p.name, underlying: p.underlying, text: p.message, at: p.at, values: { metric: p.metric, value: p.value, expiry: p.expiry } }));
  },
  async start(deps) {
    services.get(deps)?.start();
    alertRulesFor(deps)?.startSchedule?.();
  },
  async stop(deps) {
    services.get(deps)?.stop();
    alertRulesFor(deps)?.stop?.();
  },
});

/** The running service for a deps object (tests). */
export const alertServiceOf = (deps) => services.get(deps) ?? null;
