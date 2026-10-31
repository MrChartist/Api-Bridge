/**
 * triggers module — stream S25 (the order side of docs/spec/p1-12): GTT single and OCO, trailing stops, stop and
 * target attached to an entry, and position stops and targets, checked on the Bridge. Routes:
 *
 *   GET    /v1/triggers?account=&status=     scope read   triggers on accounts the key may use, newest first
 *                                                         (status: open, waiting, active, triggered, cancelled, failed, expired)
 *   POST   /v1/triggers                      scope paper  { account, symbol, product, type?, origin?, parentOrderId?,
 *                                                         mode?, name?, expiresAt?, legs: [{ trigger, op?, role?, trail?,
 *                                                         order: { side, quantity | lots, orderType?, price? } }] }
 *   GET    /v1/triggers/{triggerId}          scope read
 *   PATCH  /v1/triggers/{triggerId}          scope paper  { legs: [{ trigger?, price?, trail? }] }
 *   DELETE /v1/triggers/{triggerId}          scope paper  cancel
 *   (PATCH and DELETE on a live trigger also need the live scope; AI assistant keys cannot PATCH; a strategy
 *   run's own key can neither POST, PATCH nor DELETE.)
 *
 * Every order a trigger sends goes through orders.place (all safety gates) as source "guard"; see triggerService.mjs.
 */
import { BridgeError } from "../core/errors.mjs";
import { defineModule } from "../core/modules.mjs";
import { TRIGGER_STATUSES } from "./triggerCore.mjs";
import { createTriggerService } from "./triggerService.mjs";

export const ROUTES = Object.freeze([
  ["GET", "/v1/triggers", { scope: "read" }, "list"],
  ["POST", "/v1/triggers", { scope: "paper" }, "create"],
  ["GET", "/v1/triggers/:triggerId", { scope: "read" }, "get"],
  ["PATCH", "/v1/triggers/:triggerId", { scope: "paper" }, "update"],
  ["DELETE", "/v1/triggers/:triggerId", { scope: "paper", body: "none" }, "cancel"],
]);

const services = new WeakMap();

const allowedFor = (ctx) => (id) => {
  try {
    ctx.requireAccountAccess(id);
    return true;
  } catch {
    return false;
  }
};

export default defineModule({
  name: "triggers",
  stream: "S25",
  register(app, deps) {
    const svc = createTriggerService(deps);
    services.set(deps, svc);
    const meta = (ctx) => ({ requestId: ctx.requestId });
    const handlers = {
      list: async (ctx) => {
        const status = ctx.query.get("status") || undefined;
        if (status && status !== "open" && !TRIGGER_STATUSES.includes(status)) throw new BridgeError("VALIDATION_FAILED", `status must be open or one of ${TRIGGER_STATUSES.join(", ")}.`, { errors: [{ path: "status", message: "not valid" }] });
        const account = ctx.query.get("account") || undefined;
        if (account) ctx.requireAccountAccess(account);
        return { data: svc.list(allowedFor(ctx), { status, account }), meta: meta(ctx) };
      },
      create: async (ctx) => ({ data: await svc.create(ctx, ctx.body), meta: meta(ctx) }),
      get: async (ctx) => ({ data: svc.get(ctx, ctx.params.triggerId), meta: meta(ctx) }),
      update: async (ctx) => ({ data: await svc.update(ctx, ctx.params.triggerId, ctx.body), meta: meta(ctx) }),
      cancel: async (ctx) => ({ data: svc.cancel(ctx, ctx.params.triggerId), meta: meta(ctx) }),
    };
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], options);
  },
  async start(deps) {
    await services.get(deps)?.start();
  },
  async stop(deps) {
    services.get(deps)?.stop();
  },
});

/** The running service for a deps object (tests). */
export const triggerServiceOf = (deps) => services.get(deps) ?? null;
