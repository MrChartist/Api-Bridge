/**
 * orders module: Orders, idempotency, tickets and portfolio.
 * The routes below are the contract in docs/openapi.yaml (method, path, auth, scope).
 *
 * Config section `orders` (optional; see config.mjs): ticket and confirmation TTLs, live-call timeout,
 * reconciliation interval, freeze-quantity slicing, retention.
 */
import { isStub } from "../core/contracts.mjs";
import { defineModule } from "../core/modules.mjs";
import { ORDERS_CONFIG_SCHEMA } from "./config.mjs";
import { createOrderService } from "./orderService.mjs";
import { createOrderRoutes } from "./routes.mjs";

/** [method, path, route options, handler name in createOrderRoutes()] */
export const ROUTES = Object.freeze([
  ["GET", "/v1/orders", { scope: "read" }, "listOrders"],
  ["POST", "/v1/orders", { scope: "paper" }, "placeOrder"],
  ["POST", "/v1/orders/preview", { scope: "paper" }, "previewOrder"],
  ["POST", "/v1/orders/cancel-all", { scope: "paper" }, "cancelAll"],
  ["GET", "/v1/orders/by-client-id/:clientOrderId", { scope: "read" }, "getByClientId"],
  ["GET", "/v1/orders/:orderId", { scope: "read" }, "getOrder"],
  ["PATCH", "/v1/orders/:orderId", { scope: "paper" }, "modifyOrder"],
  ["DELETE", "/v1/orders/:orderId", { scope: "paper", body: "none" }, "cancelOrder"],
  ["GET", "/v1/trades", { scope: "read" }, "listTrades"],
  ["GET", "/v1/positions", { scope: "read" }, "positions"],
  ["POST", "/v1/positions/convert", { scope: "paper" }, "convertPosition"],
  ["GET", "/v1/holdings", { scope: "read" }, "holdings"],
  ["GET", "/v1/funds", { scope: "read" }, "funds"],
  ["GET", "/v1/tickets", { scope: "admin", loopbackOnly: true }, "listTickets"],
  ["POST", "/v1/tickets/:ticketId/confirm", { scope: "admin", loopbackOnly: true, body: "none" }, "confirmTicket"],
]);

export default defineModule({
  name: "orders",
  configKey: "orders",
  configSchema: ORDERS_CONFIG_SCHEMA,
  services: { orders: (deps) => createOrderService(deps) },
  register(app, deps) {
    const handlers = createOrderRoutes(deps);
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], options);
  },
  async stop(deps) {
    const svc = deps.orders;
    if (svc && !isStub(svc) && typeof svc.close === "function") svc.close();
  },
});
