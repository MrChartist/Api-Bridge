import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { BridgeError } from "../core/errors.mjs";
import { createFakeOrderService } from "../orders/fake.mjs";
import { createFakeAuditLog } from "../safety/fake.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { createHookStore } from "./hookStore.mjs";
import { createSignalWorker } from "./worker.mjs";

let dir;
let store;
let orders;
let audit;
let worker;
const sig = (o = {}) => ({ symbol: "NSE:RELIANCE", side: "BUY", quantity: null, lots: null, price: 1400, orderType: null, product: null, ref: null, time: null, ...o });
let n = 0;
const job = (hook, signal, extra = {}) => ({ signalId: `sig_${++n}`, hookId: hook.id, index: 0, signal, idempotencyKey: `hook:${hook.id}:k${n}xxxxxxxx`, receivedAt: Date.now(), ...extra });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcb-worker-"));
  store = createHookStore({ dataDir: dir });
  orders = createFakeOrderService({ accounts: ["paper", "dhan-main"], liveAccounts: ["dhan-main"], lotSizes: { "NFO:NIFTY-2026-10-27-25000-CE": 65 } });
  audit = createFakeAuditLog();
  worker = createSignalWorker({ deps: { orders, symbols: createFakeSymbolService(), audit }, store, logger: createNullLogger(), queueSize: 5, concurrency: 2 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(hookDef, signal) {
  const { hook } = await store.create({ source: "gocharting", label: "t", account: "paper", product: "CNC", ...hookDef });
  const j = job(hook, signal);
  worker.enqueue([j]);
  await worker.idle();
  return { hook, rec: worker.get(j.signalId)[0] };
}

describe("signal worker: held alerts (a hook over its per-minute limit)", () => {
  it("INT-09: jobs enqueued with a delay show as queued with the reason, count against the queue size, then run", async () => {
    const { hook } = await store.create({ source: "gocharting", label: "t", account: "paper", product: "CNC" });
    const j = job(hook, sig({ quantity: 1 }));
    worker.enqueue([j], { delayMs: 80, reason: "held for the limit" });
    expect(worker.get(j.signalId)[0]).toMatchObject({ status: "queued", code: "HOOK_RATE_HELD", reason: "held for the limit" });
    expect(worker.stats()).toMatchObject({ waitingForSlot: 1, queued: 0 });
    // held jobs use the queue: queueSize is 5, so only 4 more fit
    const more = Array.from({ length: 5 }, () => job(hook, sig({ quantity: 1 })));
    expect(() => worker.enqueue(more, { delayMs: 80 })).toThrow(expect.objectContaining({ code: "RATE_LIMITED" }));
    await worker.idle();
    expect(worker.get(j.signalId)[0]).toMatchObject({ status: "placed" });
    expect(orders.all()).toHaveLength(1);
  });

  it("INT-09: stopping drops held jobs and says so (they were acknowledged)", async () => {
    const { hook } = await store.create({ source: "gocharting", label: "t", account: "paper", product: "CNC" });
    const j = job(hook, sig({ quantity: 1 }));
    worker.enqueue([j], { delayMs: 60_000, reason: "held" });
    await worker.stop({ timeoutMs: 50 });
    expect(worker.get(j.signalId)[0]).toMatchObject({ status: "dropped", code: "SHUTDOWN" });
    expect(orders.all()).toHaveLength(0);
  });
});

describe("signal worker: hook mapping and caps", () => {
  it("places a paper order through OrderService with source webhook and the hook as principal", async () => {
    const { hook, rec } = await run({ maxLotsPerSignal: 5 }, sig({ quantity: 3 }));
    expect(rec).toMatchObject({ status: "placed", symbol: "NSE:RELIANCE", side: "BUY", mode: "paper" });
    const [, body, opts] = orders.calls.find((c) => c[0] === "place");
    expect(body).toEqual({ account: "paper", symbol: "NSE:RELIANCE", side: "BUY", lots: 3, product: "CNC", orderType: "LIMIT", mode: "paper", tag: hook.id, price: 1400 });
    expect(opts.idempotencyKey).toMatch(/^hook:hk_/);
    expect(orders.all()[0].source).toBe("webhook");
    expect(audit.ofType("hook.signal")[0].data).toMatchObject({ status: "placed", hookId: hook.id });
  });

  it("converts quantity to lots for derivatives and refuses non-multiples", async () => {
    expect((await run({ maxLotsPerSignal: 2 }, sig({ symbol: "NFO:NIFTY-2026-10-27-25000-CE", quantity: 130, price: 120 }))).rec.status).toBe("placed");
    expect(orders.calls.at(-1)[1].lots).toBe(2);
    const bad = await run({ maxLotsPerSignal: 2 }, sig({ symbol: "NFO:NIFTY-2026-10-27-25000-CE", quantity: 100, price: 120 }));
    expect(bad.rec).toMatchObject({ status: "rejected", code: "INVALID_ORDER" });
  });

  it("refuses above the lots cap instead of trimming", async () => {
    const { rec } = await run({ maxLotsPerSignal: 1 }, sig({ lots: 2 }));
    expect(rec).toMatchObject({ status: "rejected", code: "LOTS_CAP_EXCEEDED" });
    expect(orders.calls.some((c) => c[0] === "place")).toBe(false);
  });

  it("defaults to one lot when the alert gives no size", async () => {
    await run({}, sig());
    expect(orders.calls.at(-1)[1].lots).toBe(1);
  });

  it("enforces allowed symbols after resolving aliases", async () => {
    expect((await run({ allowedSymbols: ["NSE:INFY"] }, sig())).rec).toMatchObject({ status: "rejected", code: "SYMBOL_NOT_ALLOWED" });
    expect((await run({ allowedSymbols: ["NSE:RELIANCE"] }, sig({ symbol: "nse:reliance" }))).rec.status).toBe("placed");
  });

  it("enforces a fixed side, product and order type", async () => {
    expect((await run({ side: "BUY" }, sig({ side: "SELL" }))).rec.code).toBe("SIDE_NOT_ALLOWED");
    expect((await run({ side: "SELL" }, sig({ side: null }))).rec.status).toBe("placed");
    expect((await run({}, sig({ side: null }))).rec.code).toBe("VALIDATION_FAILED");
    expect((await run({ product: "CNC" }, sig({ product: "INTRADAY" }))).rec.code).toBe("PRODUCT_NOT_ALLOWED");
    expect((await run({ product: undefined }, sig({ product: null }))).rec.code).toBe("VALIDATION_FAILED");
    expect((await run({}, sig({ orderType: "MARKET" }))).rec.code).toBe("ORDER_TYPE_NOT_ALLOWED");
  });

  it("needs a price for LIMIT hooks and sends none for MARKET hooks", async () => {
    expect((await run({}, sig({ price: null }))).rec.code).toBe("VALIDATION_FAILED");
    await run({ orderType: "MARKET" }, sig({ price: null }));
    expect(orders.calls.at(-1)[1]).not.toHaveProperty("price");
  });

  it("refuses unknown symbols", async () => {
    expect((await run({}, sig({ symbol: "NSE:NOSUCHCO" }))).rec).toMatchObject({ status: "rejected", code: "SYMBOL_NOT_FOUND" });
  });

  it("confirmation hooks only open a ticket: nothing is placed", async () => {
    const { rec } = await run({ requireConfirmation: true }, sig());
    expect(rec.status).toBe("awaiting_confirmation");
    expect(rec.ticketId).toMatch(/^tkt_/);
    expect(orders.calls.some((c) => c[0] === "place")).toBe(false);
    expect(orders.all()).toHaveLength(0);
  });

  it("a ticket the person declined ends its signal as rejected (TICKET_REJECTED); another client's decline does not", async () => {
    const bus = createEventBus({ logger: createNullLogger() });
    worker = createSignalWorker({ deps: { orders, symbols: createFakeSymbolService(), audit, bus }, store, logger: createNullLogger(), queueSize: 5, concurrency: 2 });
    const { hook, rec } = await run({ requireConfirmation: true }, sig());
    expect(rec.status).toBe("awaiting_confirmation");
    bus.emit("ticket.rejected", { ticketId: rec.ticketId, accountId: "paper", principal: "key:someone-else" });
    expect(worker.get(rec.signalId)[0].status).toBe("awaiting_confirmation");
    bus.emit("ticket.rejected", { ticketId: rec.ticketId, accountId: "paper", principal: `hook:${hook.id}` });
    expect(worker.get(rec.signalId)[0]).toMatchObject({ status: "rejected", code: "TICKET_REJECTED", reason: expect.stringMatching(/declined/) });
    expect(orders.all()).toHaveLength(0);
    await worker.idle();
    expect(audit.ofType("hook.signal").at(-1).data).toMatchObject({ status: "rejected", code: "TICKET_REJECTED" });
  });

  it("live hooks are refused by OrderService unless every opt-in holds (never downgraded)", async () => {
    const { rec } = await run({ mode: "live", account: "paper" }, sig());
    expect(rec).toMatchObject({ status: "rejected", code: "PAPER_ONLY" });
    expect(orders.all()).toHaveLength(0);
  });

  it("the same idempotency key never places twice", async () => {
    const { hook } = await store.create({ source: "gocharting", label: "t", account: "paper", product: "CNC" });
    const j1 = job(hook, sig(), { idempotencyKey: "hook:same-key-123" });
    const j2 = job(hook, sig(), { idempotencyKey: "hook:same-key-123" });
    worker.enqueue([j1, j2]);
    await worker.idle();
    expect(orders.all()).toHaveLength(1);
    expect([worker.get(j1.signalId)[0].status, worker.get(j2.signalId)[0].status].sort()).toEqual(["duplicate", "placed"]);
  });

  it("maps OrderService refusals and unknown outcomes", async () => {
    orders.failNext(new BridgeError("KILL_SWITCH_ACTIVE"));
    expect((await run({}, sig())).rec).toMatchObject({ status: "rejected", code: "KILL_SWITCH_ACTIVE" });
    orders.failNext(new BridgeError("OUTCOME_UNKNOWN", "timeout"));
    expect((await run({}, sig())).rec).toMatchObject({ status: "outcome_unknown" });
    orders.failNext(new BridgeError("BROKER_UNAVAILABLE"));
    expect((await run({}, sig())).rec).toMatchObject({ status: "failed" });
  });

  it("rejects signals whose hook was deleted meanwhile", async () => {
    const { hook } = await store.create({ source: "gocharting", label: "t", account: "paper", product: "CNC" });
    const j = job(hook, sig());
    await store.remove(hook.id);
    worker.enqueue([j]);
    await worker.idle();
    expect(worker.get(j.signalId)[0]).toMatchObject({ status: "rejected", code: "NOT_FOUND" });
  });
});

describe("signal worker: queue", () => {
  it("is bounded: an alert that does not fit is refused whole with RATE_LIMITED", async () => {
    const { hook } = await store.create({ source: "gocharting", label: "t", account: "paper", product: "CNC" });
    const jobs = Array.from({ length: 6 }, () => job(hook, sig()));
    expect(() => worker.enqueue(jobs)).toThrow(expect.objectContaining({ code: "RATE_LIMITED" }));
    expect(worker.stats().queued).toBe(0);
    worker.enqueue(jobs.slice(0, 5));
    expect(worker.stats().queued).toBe(5);
    await worker.idle();
    expect(orders.all()).toHaveLength(5);
  });

  it("does not start work before the receiver returns (processing is deferred)", async () => {
    const { hook } = await store.create({ source: "gocharting", label: "t", account: "paper", product: "CNC" });
    worker.enqueue([job(hook, sig())]);
    expect(orders.calls).toHaveLength(0);
    await worker.idle();
    expect(orders.calls).toHaveLength(1);
  });

  it("drops and audits queued signals at shutdown, then refuses new ones", async () => {
    const { hook } = await store.create({ source: "gocharting", label: "t", account: "paper", product: "CNC" });
    const j = job(hook, sig());
    worker.enqueue([j]);
    await worker.stop();
    expect(worker.get(j.signalId)[0].status).toBe("dropped");
    expect(audit.ofType("hook.signal").at(-1).data.status).toBe("dropped");
    expect(() => worker.enqueue([job(hook, sig())])).toThrow(expect.objectContaining({ code: "BROKER_UNAVAILABLE" }));
  });
});
