/**
 * Route handlers for the newer order routes (docs/openapi.yaml, tags "Orders" and "Margin"). Every handler answers
 * { data, meta } and delegates to the order service's extras (extras.mjs), which place orders only through
 * OrderService.place().
 *
 *   POST /v1/orders/to-target   Idempotency-Key   201 when an order was placed, 200 when nothing was needed or on dryRun
 *   POST /v1/orders/batch       Idempotency-Key   201 all legs placed, 207 some, 422 none
 *   POST /v1/margin/basket                        the margin of up to 50 prospective positions
 */
import { json } from "../core/http.mjs";
import { idempotencyKey, meta } from "./routes.mjs";

/**
 * @param {{ orders: object }} deps
 */
export function createOrderExtraRoutes(deps) {
  const svc = () => deps.orders;
  return {
    async toTarget(ctx) {
      const key = idempotencyKey(ctx);
      const r = await svc().placeToTarget(ctx, ctx.body, { idempotencyKey: key });
      const headers = r.replayed ? { "Idempotency-Replayed": "true" } : {};
      return json({ data: r.result, meta: meta(ctx, { accountId: r.result.account, mode: r.result.mode, ...(r.normalised.length ? { normalised: r.normalised } : {}) }) }, { status: r.status, headers });
    },

    async batch(ctx) {
      const key = idempotencyKey(ctx);
      const r = await svc().placeBatch(ctx, ctx.body, { idempotencyKey: key });
      const headers = r.replayed ? { "Idempotency-Replayed": "true" } : {};
      return json({ data: r.result, meta: meta(ctx, { accountId: r.result.account }) }, { status: r.status, headers });
    },

    /** The owner checked the broker's order book after a damaged order-records file was set aside: allow live orders again. */
    async acknowledgeOrderState(ctx) {
      const had = svc().acknowledgeStateDamage();
      if (had) {
        await deps.audit
          .append({ type: "orders.state_acknowledged", actor: { kind: ctx.principal?.kind ?? "local", id: ctx.principal?.id ?? "cli" }, source: ctx.source ?? "api", requestId: ctx.requestId ?? null, data: {} })
          .catch(() => {});
      }
      return { data: { acknowledged: had, liveOrders: "allowed" }, meta: meta(ctx) };
    },

    async marginBasket(ctx) {
      const data = await svc().basketMargin(ctx, ctx.body);
      return { data, meta: meta(ctx, { accountId: data.account }) };
    },
  };
}
