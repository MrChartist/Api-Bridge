/**
 * Contract tests: webhooks and MCP tools against the REAL OrderService (mode decision, ticket book, idempotency
 * store, order gate), wired by the orders module's own test harness over fakes and a stub broker adapter. No network.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCallContext } from "../core/context.mjs";
import { buildHarness } from "../orders/__fixtures__/helpers.mjs";
import { createHookStore } from "../hooks/hookStore.mjs";
import { createSignalWorker } from "../hooks/worker.mjs";
import { createToolRegistry } from "./tools.mjs";

let h;
let dir;
beforeEach(() => {
  h = buildHarness({ raw: { mcp: { toolsets: ["market", "analytics", "account", "orders"], orderAccounts: ["zerodha-main", "paper"] } } });
  dir = mkdtempSync(join(tmpdir(), "mcb-s11-contract-"));
});
afterEach(() => {
  h.svc.close?.();
  rmSync(dir, { recursive: true, force: true });
});

function hooks() {
  const store = createHookStore({ dataDir: dir });
  const worker = createSignalWorker({ deps: { orders: h.svc, symbols: h.symbols, audit: h.audit }, store, logger: h.logger, queueSize: 50, concurrency: 2 });
  return { store, worker };
}
const signal = (o = {}) => ({ symbol: "NSE:RELIANCE", side: "BUY", quantity: 10, lots: null, price: 1400, orderType: null, product: null, ref: null, time: null, ...o });

describe("webhooks through the real OrderService", () => {
  it("a live hook on an account that allows webhooks places once per idempotency key", async () => {
    const { store, worker } = hooks();
    const { hook } = await store.create({ source: "gocharting", label: "GC live", account: "zerodha-main", mode: "live", product: "CNC", maxLotsPerSignal: 10 });
    const job = (id) => ({ signalId: id, hookId: hook.id, index: 0, signal: signal(), idempotencyKey: "hook:gc-double-fire-key-1", receivedAt: Date.now() });
    worker.enqueue([job("sig_a"), job("sig_b")]);
    await worker.idle();
    expect(h.zerodha.placed).toHaveLength(1);
    expect([worker.get("sig_a")[0].status, worker.get("sig_b")[0].status].sort()).toEqual(["duplicate", "placed"]);
    expect(worker.get("sig_a")[0].mode).toBe("live");
  });

  it("a live hook on an account that does not allow webhooks is refused, never downgraded", async () => {
    const { store, worker } = hooks();
    const { hook } = await store.create({ source: "gocharting", label: "GC", account: "dhan-main", mode: "live", product: "CNC", maxLotsPerSignal: 10 });
    worker.enqueue([{ signalId: "sig_c", hookId: hook.id, index: 0, signal: signal(), idempotencyKey: "hook:dhan-refused-0001", receivedAt: Date.now() }]);
    await worker.idle();
    expect(worker.get("sig_c")[0]).toMatchObject({ status: "rejected", code: "PAPER_ONLY" });
    expect(h.dhan.placed).toHaveLength(0);
  });

  it("a confirmation-required hook opens a real ticket and reaches no broker", async () => {
    const { store, worker } = hooks();
    const { hook } = await store.create({ source: "gocharting", label: "GC confirm", account: "zerodha-main", mode: "live", product: "CNC", maxLotsPerSignal: 10, requireConfirmation: true });
    worker.enqueue([{ signalId: "sig_d", hookId: hook.id, index: 0, signal: signal(), idempotencyKey: "hook:confirm-0000001", receivedAt: Date.now() }]);
    await worker.idle();
    expect(worker.get("sig_d")[0].status).toBe("awaiting_confirmation");
    const tickets = await h.svc.tickets(h.ctx("admin"));
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ source: "webhook", client: "GC confirm" });
    expect(h.zerodha.placed).toHaveLength(0);
  });
});

describe("MCP order tools through the real OrderService", () => {
  const registry = () => createToolRegistry({ deps: { ...h.deps, orders: h.svc } });
  const aiCtx = () => createCallContext({ source: "mcp", key: { id: "mcpkey00001", label: "Claude", scopes: ["live"], accounts: "*" }, log: h.logger });
  const order = { account: "zerodha-main", symbol: "NSE:RELIANCE", side: "BUY", quantity: 10, product: "CNC", orderType: "LIMIT", price: 1400, mode: "live" };

  it("no AI order reaches the broker without a ticket confirmed by a person; with it, exactly one", async () => {
    const reg = registry();
    const ctx = aiCtx();
    const prep = await reg.call("prepare_order", order, ctx);
    expect(prep.isError, prep.content?.[0]?.text).toBeUndefined();
    const { ticketId } = prep.structuredContent.data;
    expect(ticketId).toBeTruthy();
    expect(h.zerodha.placed).toHaveLength(0);

    const guessed = await reg.call("submit_confirmed_order", { ticketId, confirmToken: "mct_guess-guess-guess-guess" }, ctx);
    expect(guessed.isError).toBe(true);
    expect(h.zerodha.placed).toHaveLength(0);

    // The AI's own key cannot confirm (source mcp), even with admin scope.
    await expect(h.svc.confirmTicket(Object.assign(aiCtx(), { scopes: new Set(["admin", "read"]) }), ticketId)).rejects.toBeTruthy();

    const { confirmToken } = await h.svc.confirmTicket(h.ctx("admin"), ticketId);
    const sent = await reg.call("submit_confirmed_order", { ticketId, confirmToken }, ctx);
    expect(sent.isError, sent.content?.[0]?.text).toBeUndefined();
    expect(sent.structuredContent.data.order).toMatchObject({ mode: "live", source: "mcp", accountId: "zerodha-main" });
    expect(h.zerodha.placed).toHaveLength(1);

    // A retry after a lost response gets the same order back (replayed), never a second broker order.
    const again = await reg.call("submit_confirmed_order", { ticketId, confirmToken }, ctx);
    expect(again.isError, again.content?.[0]?.text).toBeUndefined();
    expect(again.structuredContent.data).toMatchObject({ replayed: true, order: { orderId: sent.structuredContent.data.order.orderId } });
    expect(h.zerodha.placed).toHaveLength(1);
  });
});
