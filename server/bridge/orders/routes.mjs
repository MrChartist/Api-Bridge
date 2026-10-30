/**
 * Route handlers for stream S7 (docs/openapi.yaml, tags "Orders" and "Portfolio"). Every handler answers
 * { data, meta } and delegates to OrderService (deps.orders); the service enforces account access, idempotency,
 * mode decisions and safety. Query parameters are validated here; bodies are validated by the service's zod schemas.
 *
 *   GET    /v1/orders?account=&mode=&status=&limit=&cursor=      list (both modes when mode is absent)
 *   POST   /v1/orders               Idempotency-Key header        201, Idempotency-Replayed: true on replay
 *   POST   /v1/orders/preview
 *   POST   /v1/orders/cancel-all    { account?, mode?, bridgeOnly?, dryRun? }
 *   GET    /v1/orders/by-client-id/{clientOrderId}
 *   GET    /v1/orders/{orderId}     PATCH (OrderChanges)          DELETE
 *   GET    /v1/trades?account=&mode=&limit=&cursor=
 *   GET    /v1/positions?account=&mode=   /v1/holdings?account=   /v1/funds?account=&mode=
 *   POST   /v1/positions/convert    { account, symbol, from, to, quantity | lots, mode? }   Intraday ↔ carry (paper)
 *   GET    /v1/tickets              POST /v1/tickets/{ticketId}/confirm   (admin, this computer only)
 */
import { BridgeError } from "../core/errors.mjs";
import { json } from "../core/http.mjs";
import { startupReady } from "../core/startup.mjs";
import { ACCOUNT_RE, CLIENT_ORDER_ID_RE, ORDER_STATUSES, cancelAllSchema, parseWith } from "./orderValidation.mjs";

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });

const opt = (q, name) => {
  const v = q.get(name);
  return v === null || v === "" ? undefined : v;
};

function accountParam(q, { required }) {
  const v = opt(q, "account");
  if (v === undefined) {
    if (required) throw invalid("account", "account is required: the account id from your config, such as dhan-main.");
    return undefined;
  }
  if (!ACCOUNT_RE.test(v)) throw invalid("account", "account is not a valid account id.");
  return v;
}

function modeParam(q) {
  const v = opt(q, "mode");
  if (v === undefined) return undefined;
  if (v !== "paper" && v !== "live") throw invalid("mode", "mode must be paper or live.");
  return v;
}

function limitParam(q) {
  const v = opt(q, "limit");
  if (v === undefined) return 100;
  if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 500) throw invalid("limit", "limit must be a whole number from 1 to 500.");
  return Number(v);
}

function cursorParam(q) {
  const v = opt(q, "cursor");
  if (v !== undefined && v.length > 512) throw invalid("cursor", "cursor is too long.");
  return v;
}

function idempotencyKey(ctx) {
  const v = ctx.req?.headers?.["idempotency-key"] ?? ctx.idempotencyKey;
  if (v === undefined || v === null || v === "") return undefined;
  const s = Array.isArray(v) ? v[0] : String(v);
  if (!/^[A-Za-z0-9_.:-]{8,255}$/.test(s)) throw invalid("Idempotency-Key", "Idempotency-Key must be 8-255 letters, digits or _ . : - (a UUID works).");
  return s;
}

const meta = (ctx, extra = {}) => ({ requestId: ctx.requestId, ...extra });

/** Write result -> reply, with Idempotency-Replayed when it was a replay. */
function writeReply(ctx, { order, replayed }, status) {
  const headers = replayed ? { "Idempotency-Replayed": "true" } : {};
  return json({ data: order, meta: meta(ctx, { accountId: order.accountId, mode: order.mode }) }, { status, headers });
}

/**
 * @param {{ orders: object }} deps
 * @returns {Record<string, (ctx: import("../core/context.mjs").RequestContext) => Promise<unknown>>}
 */
export function createOrderRoutes(deps) {
  const svc = () => deps.orders;
  return {
    async listOrders(ctx) {
      // While the Bridge starts, wait for startup jobs (the demo book seed): never a half-seeded book.
      await startupReady(deps);
      const q = ctx.query;
      const status = opt(q, "status");
      if (status !== undefined && !ORDER_STATUSES.includes(status)) throw invalid("status", `status must be one of ${ORDER_STATUSES.join(", ")}.`);
      const accountId = accountParam(q, { required: false });
      const mode = modeParam(q);
      const page = await svc().list(ctx, { accountId, status, mode, limit: limitParam(q), cursor: cursorParam(q) });
      return { data: page.items, meta: meta(ctx, { nextCursor: page.nextCursor, accountId: accountId ?? null, ...(mode ? { mode } : {}) }) };
    },

    async placeOrder(ctx) {
      const key = idempotencyKey(ctx);
      const result = await svc().place(ctx, ctx.body, { idempotencyKey: key });
      return writeReply(ctx, result, 201);
    },

    async previewOrder(ctx) {
      const data = await svc().preview(ctx, ctx.body);
      return { data, meta: meta(ctx, { mode: data.mode }) };
    },

    async cancelAll(ctx) {
      idempotencyKey(ctx); // validated; cancel-all is naturally idempotent
      const body = parseWith(cancelAllSchema, ctx.body ?? {}, "The cancel-all request is not valid.");
      const data = await svc().cancelAll(ctx, { accountId: body.account, mode: body.mode, bridgeOnly: body.bridgeOnly === true, dryRun: body.dryRun === true });
      return { data, meta: meta(ctx, { accountId: body.account ?? null, ...(body.mode ? { mode: body.mode } : {}) }) };
    },

    async getByClientId(ctx) {
      const id = ctx.params.clientOrderId;
      if (!CLIENT_ORDER_ID_RE.test(id ?? "")) throw invalid("clientOrderId", "clientOrderId must be 1-64 letters, digits, '_' or '-'.");
      const order = await svc().getByClientId(ctx, id);
      return { data: order, meta: meta(ctx, { accountId: order.accountId, mode: order.mode }) };
    },

    async getOrder(ctx) {
      const order = await svc().get(ctx, ctx.params.orderId);
      return { data: order, meta: meta(ctx, { accountId: order.accountId, mode: order.mode }) };
    },

    async modifyOrder(ctx) {
      const result = await svc().modify(ctx, ctx.params.orderId, ctx.body, { idempotencyKey: idempotencyKey(ctx) });
      return writeReply(ctx, result, 200);
    },

    async cancelOrder(ctx) {
      const result = await svc().cancel(ctx, ctx.params.orderId, { idempotencyKey: idempotencyKey(ctx) });
      return writeReply(ctx, result, 200);
    },

    async listTrades(ctx) {
      // While the Bridge starts, wait for startup jobs (the demo book seed): never a half-seeded book.
      await startupReady(deps);
      const q = ctx.query;
      const accountId = accountParam(q, { required: false });
      const mode = modeParam(q);
      const page = await svc().trades(ctx, { accountId, mode, limit: limitParam(q), cursor: cursorParam(q) });
      return { data: page.items, meta: meta(ctx, { nextCursor: page.nextCursor, accountId: accountId ?? null, ...(mode ? { mode } : {}) }) };
    },

    async positions(ctx) {
      // While the Bridge starts, wait for startup jobs (the demo book seed): never a half-seeded book.
      await startupReady(deps);
      const accountId = accountParam(ctx.query, { required: true });
      const r = await svc().positions(ctx, accountId, { mode: modeParam(ctx.query) });
      return { data: r.items, meta: meta(ctx, { accountId, mode: r.freshness.source === "paper" ? "paper" : "live", freshness: r.freshness }) };
    },

    async convertPosition(ctx) {
      const data = await svc().convertPosition(ctx, ctx.body);
      return { data, meta: meta(ctx, { accountId: data.accountId, mode: data.mode }) };
    },

    async holdings(ctx) {
      const accountId = accountParam(ctx.query, { required: true });
      const r = await svc().holdings(ctx, accountId);
      return { data: r.items, meta: meta(ctx, { accountId, mode: r.freshness.source === "paper" ? "paper" : "live", freshness: r.freshness }) };
    },

    async funds(ctx) {
      // While the Bridge starts, wait for startup jobs (the demo book seed): never a half-seeded book.
      await startupReady(deps);
      const accountId = accountParam(ctx.query, { required: true });
      const r = await svc().funds(ctx, accountId, { mode: modeParam(ctx.query) });
      return { data: r.funds, meta: meta(ctx, { accountId, mode: r.freshness.source === "paper" ? "paper" : "live", freshness: r.freshness }) };
    },

    async listTickets(ctx) {
      const data = await svc().tickets(ctx);
      return { data, meta: meta(ctx) };
    },

    async confirmTicket(ctx) {
      const data = await svc().confirmTicket(ctx, ctx.params.ticketId);
      return { data, meta: meta(ctx) };
    },
  };
}
