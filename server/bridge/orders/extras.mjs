/**
 * Order-service extras built on top of the public OrderService methods (place, preview, positions, holdings, list):
 *   placeToTarget(ctx, body, { idempotencyKey })   POST /v1/orders/to-target
 *   placeBatch(ctx, body, { idempotencyKey })      POST /v1/orders/batch
 *   basketMargin(ctx, body)                        POST /v1/margin/basket (and the compat margin call)
 * None of them place an order by any path other than OrderService.place().
 */
import { createBatchOrders } from "./batchOrders.mjs";
import { createMarginBasket } from "./marginBasket.mjs";
import { createTargetOrders } from "./targetOrders.mjs";

/**
 * @param {{ deps: object, svc: object }} p  deps: the module's deps (accounts, symbols, paper, scheduler, clock); svc: the OrderService
 */
export function createOrderExtras({ deps, svc }) {
  const now = () => deps.clock.now();
  return {
    placeToTarget: createTargetOrders({ deps, svc, now }).toTarget,
    placeBatch: createBatchOrders({ deps, svc, now }).batch,
    basketMargin: createMarginBasket({ deps, now }).marginBasket,
  };
}
