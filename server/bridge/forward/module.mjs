/**
 * forward module: send the Bridge's events to other projects (stream S15, the notify family).
 *
 * A project gives a URL; the Bridge POSTs each order update there as signed JSON (sender.mjs). Targets are managed
 * from the dashboard (API > Integrations > Your project) or with the routes below, all admin and loopback only:
 * a target decides where order data goes, so only the owner at this computer may add one.
 *
 * An order update carries the event (order id, account, mode, status, filled quantity, average price). For paper
 * orders it also carries the whole order as GET /v1/orders/{orderId} shows it; for live orders the receiver reads
 * the order itself when it needs more (the Bridge does not ask the broker again just to forward).
 */
import { BridgeError } from "../core/errors.mjs";
import { isStub } from "../core/contracts.mjs";
import { json } from "../core/http.mjs";
import { defineModule } from "../core/modules.mjs";
import { createForwardSender } from "./sender.mjs";
import { FORWARD_EVENTS, FORWARD_ID_RE, createForwardStore, publicForward } from "./store.mjs";

/** [method, path, route options, handler name] */
export const ROUTES = Object.freeze([
  ["GET", "/v1/forwards", { scope: "admin", loopbackOnly: true }, "listForwards"],
  ["POST", "/v1/forwards", { scope: "admin", loopbackOnly: true }, "createForward"],
  ["DELETE", "/v1/forwards/:forwardId", { scope: "admin", loopbackOnly: true }, "deleteForward"],
  ["POST", "/v1/forwards/:forwardId/test", { scope: "admin", loopbackOnly: true }, "testForward"],
]);

const runtimes = new WeakMap();

/** A context for reading an order on the Bridge's own behalf (the forwarder is not a caller with a key). */
const systemCtx = (log) => ({ requestId: null, source: "system", principal: { kind: "local", id: "forward" }, key: null, scopes: new Set(["read", "paper", "live", "admin"]), loopback: true, log, requireAccountAccess() {}, requireScope() {}, canAccessAccounts: () => true });

/**
 * @param {any} deps
 * @param {{ logger?: any, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, retryDelays?: readonly number[] }} [opts]
 */
export function createForwardRuntime(deps, { logger, fetchImpl, sleep, retryDelays } = {}) {
  const log = logger ?? deps.logger.child({ module: "forward" });
  const now = () => deps.clock.now();
  const store = createForwardStore({ dataDir: deps.paths.dataDir, secrets: deps.secrets && !isStub(deps.secrets) ? deps.secrets : undefined, now, logger: log });
  const sender = createForwardSender({ store, logger: log, now, ...(fetchImpl ? { fetchImpl } : {}), ...(sleep ? { sleep } : {}), ...(retryDelays ? { retryDelays } : {}) });
  const offs = [];

  /**
   * The payload for an order event: the event's own fields, plus the whole order for paper orders. A live order is
   * not read here: reading it asks the broker again, which costs rate limit and would raise a new update each time.
   */
  async function orderData(p) {
    try {
      if (p?.mode === "paper" && deps.orders && !isStub(deps.orders)) return { ...p, order: await deps.orders.get(systemCtx(log), p.orderId) };
    } catch {
      /* the bare event still says what changed */
    }
    return { ...p };
  }

  /**
   * The order service can announce the same state of an order more than once (the engine, then the route). A
   * receiver should get each state once: remember the last one sent per order and skip an exact repeat.
   */
  const lastSent = new Map();
  const REMEMBERED_ORDERS = 2000;
  function repeatOf(p) {
    const state = `${p?.status}|${p?.filledQuantity ?? 0}|${p?.avgPrice ?? ""}`;
    if (lastSent.get(p?.orderId) === state) return true;
    lastSent.delete(p?.orderId);
    lastSent.set(p?.orderId, state);
    if (lastSent.size > REMEMBERED_ORDERS) lastSent.delete(lastSent.keys().next().value);
    return false;
  }

  const wanted = (event) => store.list().some((t) => t.enabled !== false && t.events.includes(event));

  function listen() {
    for (const event of FORWARD_EVENTS) {
      offs.push(
        deps.bus.on(event, (p) => {
          if (!wanted(event)) return;
          // The bus does not wait: build the payload and queue it off the emitter's stack.
          if (event === "order.updated") {
            if (!repeatOf(p)) orderData(p).then((data) => sender.publish(event, data));
          }
          else sender.publish(event, { ...p });
        }),
      );
    }
  }

  const audit = async (ctx, type, data) => {
    if (!deps.audit || isStub(deps.audit)) return;
    await deps.audit.append({ type, actor: { kind: ctx.principal?.kind ?? "anonymous", id: ctx.principal?.id ?? "anonymous" }, source: ctx.source ?? "rest", accountId: null, requestId: ctx.requestId, data });
  };
  const find = (ctx) => {
    const id = String(ctx.params.forwardId ?? "");
    const t = FORWARD_ID_RE.test(id) ? store.get(id) : null;
    if (!t) throw new BridgeError("NOT_FOUND", "No forward target with this id.");
    return t;
  };

  const handlers = {
    async listForwards(ctx) {
      return { data: store.list().map(publicForward), meta: { requestId: ctx.requestId } };
    },
    async createForward(ctx) {
      const { target, signingSecret } = await store.create(ctx.body);
      await audit(ctx, "forward.created", { forwardId: target.id, label: target.label, host: new URL(target.url).host, events: target.events });
      return json({ data: { ...publicForward(target), signingSecret }, meta: { requestId: ctx.requestId } }, { status: 201, headers: { "Cache-Control": "no-store" } });
    },
    async deleteForward(ctx) {
      const t = find(ctx);
      await store.delete(t.id);
      await audit(ctx, "forward.deleted", { forwardId: t.id, label: t.label });
      return { data: { id: t.id, deleted: true }, meta: { requestId: ctx.requestId } };
    },
    async testForward(ctx) {
      const t = find(ctx);
      const r = await sender.test(t);
      return { data: { id: t.id, ok: r.ok, status: r.status, error: r.error }, meta: { requestId: ctx.requestId } };
    },
  };

  return {
    store,
    sender,
    handlers,
    listen,
    stop() {
      for (const off of offs.splice(0)) off();
      sender.stop();
    },
  };
}

/** The runtime register() built for these deps (tests, diagnostics). */
export const forwardRuntimeFor = (deps) => runtimes.get(deps) ?? null;

export default defineModule({
  name: "forward",
  stream: "S15",
  register(app, deps) {
    const rt = createForwardRuntime(deps, { logger: app.logger });
    runtimes.set(deps, rt);
    for (const [method, path, options, name] of ROUTES) app.route(method, path, rt.handlers[name], options);
  },
  async start(deps) {
    runtimes.get(deps)?.listen();
  },
  async stop(deps) {
    runtimes.get(deps)?.stop();
  },
});
