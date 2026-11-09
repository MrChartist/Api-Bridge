import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeKeyStore } from "../auth/fake.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { resolveStreamConfig } from "./config.mjs";
import { createFakeStreamHub } from "./fake.mjs";
import { authenticateStream, clientOpSchema, createClientSession, createSessionRegistry, errorBody, istIso, tickBody } from "./protocol.mjs";

const settle = () => new Promise((r) => setImmediate(r));

/** A transport that records messages; `blocked` simulates a client that is not reading. */
function fakeTransport() {
  const t = {
    kind: "ws",
    sent: [],
    blocked: false,
    closed: null,
    drainCbs: [],
    write(msg) {
      t.sent.push(structuredClone(msg));
    },
    bufferedBytes: () => (t.blocked ? 10 * 1_048_576 : 0),
    close(code, reason) {
      t.closed = { code, reason };
    },
    onDrain(cb) {
      t.drainCbs.push(cb);
    },
    unblock() {
      t.blocked = false;
      for (const cb of t.drainCbs.splice(0)) cb();
    },
    types: () => t.sent.map((m) => m.type),
  };
  return t;
}

const KEY = { id: "abcdefghij", label: "t", scopes: ["read"], accounts: ["dhan-main"] };

function setup({ stream = {}, key = KEY, hubOpts = {}, keyStore } = {}) {
  const bus = createEventBus();
  const hub = createFakeStreamHub({ bus, accountId: "dhan-main", broker: "dhan", ...hubOpts });
  const transport = fakeTransport();
  const cfg = resolveStreamConfig(stream);
  const closed = [];
  const session = createClientSession({ id: "ws_test", kind: "ws", key, hub, bus, transport, config: cfg, clock: { now: () => Date.now() }, logger: createNullLogger(), keyStore, onClosed: (s) => closed.push(s) });
  return { bus, hub, transport, session, closed, cfg };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-10-19T10:00:00+05:30"));
});
afterEach(() => vi.useRealTimers());

describe("message helpers", () => {
  const tick = { symbol: "NSE:NIFTY", ltp: 25100, bid: 25099, ask: 25101, bidQty: 50, askQty: 75, volume: 1000, oi: null, open: 25000, high: 25150, low: 24990, close: 25000, exchangeTs: 1, receivedAt: 2, accountId: "a", broker: "dhan", depth: { bids: [], asks: [] } };

  it("tickBody shapes fields by mode", () => {
    expect(tickBody(tick, "ltp")).toEqual({ symbol: "NSE:NIFTY", ltp: 25100, exchangeTs: 1, receivedAt: 2, accountId: "a", broker: "dhan" });
    const q = tickBody(tick, "quote");
    expect(q).toMatchObject({ open: 25000, high: 25150, change: 100, changePct: 0.4, bid: 25099, askQty: 75 });
    expect(q.depth).toBeUndefined();
    expect(tickBody(tick, "depth").depth).toEqual({ bids: [], asks: [] });
    expect(tickBody({ ...tick, close: null }, "quote")).toMatchObject({ change: null, changePct: null });
  });

  it("istIso uses the IST offset", () => {
    expect(istIso(Date.parse("2026-10-19T04:30:00Z"))).toBe("2026-10-19T10:00:00.000+05:30");
  });

  it("errorBody hides unknown errors", () => {
    expect(errorBody(new Error("secret path"))).toEqual({ code: "INTERNAL", message: "Something went wrong on the Bridge.", retryable: false });
  });

  it("op schema defaults the mode and refuses unknown fields", () => {
    expect(clientOpSchema.parse({ op: "subscribe", symbols: ["NSE:NIFTY"] }).mode).toBe("ltp");
    expect(clientOpSchema.safeParse({ op: "subscribe", symbols: ["NSE:NIFTY"], extra: 1 }).success).toBe(false);
    expect(clientOpSchema.safeParse({ op: "subscribe", symbols: [] }).success).toBe(false);
    expect(clientOpSchema.safeParse({ op: "nope" }).success).toBe(false);
  });
});

describe("authenticateStream", () => {
  it("accepts a single-use stream token, a Bearer header or X-API-Key", async () => {
    const ks = createFakeKeyStore();
    const { key, record } = ks.addKey({ scopes: ["read"] });
    const { token } = await ks.issueStreamToken(record);
    const q = new URLSearchParams({ token });
    expect((await authenticateStream({ keyStore: ks, query: q, headers: {} })).id).toBe(record.id);
    await expect(authenticateStream({ keyStore: ks, query: q, headers: {} })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect((await authenticateStream({ keyStore: ks, query: new URLSearchParams(), headers: { authorization: `Bearer ${key}` } })).id).toBe(record.id);
    expect((await authenticateStream({ keyStore: ks, query: new URLSearchParams(), headers: { "x-api-key": key } })).id).toBe(record.id);
  });

  it("refuses missing or bad credentials, API keys in the URL and keys without read", async () => {
    const ks = createFakeKeyStore();
    const { key } = ks.addKey({ scopes: ["read"] });
    await expect(authenticateStream({ keyStore: ks, query: new URLSearchParams(), headers: {} })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(authenticateStream({ keyStore: ks, query: new URLSearchParams({ key }), headers: {} })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(authenticateStream({ keyStore: ks, query: new URLSearchParams({ token: "x".repeat(600) }), headers: {} })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(authenticateStream({ keyStore: ks, query: new URLSearchParams(), headers: { authorization: "Bearer mcb_wrong_key" } })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const noScope = { verifyStreamToken: async () => ({ id: "k", scopes: [] }) };
    await expect(authenticateStream({ keyStore: noScope, query: new URLSearchParams({ token: "t" }), headers: {} })).rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
  });
});

describe("client session", () => {
  it("greets with a heartbeat, then each upstream's status", async () => {
    const bus = createEventBus();
    const hub = createFakeStreamHub({ bus });
    await hub.subscribe("other", ["NSE:NIFTY"]);
    const transport = fakeTransport();
    createClientSession({ id: "ws_x", kind: "ws", key: KEY, hub, bus, transport, config: resolveStreamConfig({}), clock: { now: () => Date.now() }, logger: createNullLogger() });
    await settle();
    expect(transport.sent[0]).toMatchObject({ type: "heartbeat", seq: 1, clientId: "ws_x", heartbeatMs: 15000, conflated: 0, time: "2026-10-19T10:00:00.000+05:30" });
    expect(transport.sent[1]).toMatchObject({ type: "status", seq: 2, state: "up", connected: true, subscriptions: 1 });
  });

  it("answers subscribe with a snapshot and per-code errors, then streams ticks with increasing seq", async () => {
    const { hub, transport, session } = setup({ hubOpts: { limit: 2, unknown: ["NSE:GHOST"] } });
    await hub.subscribe("other", ["NSE:NIFTY"]);
    hub.pushTick({ symbol: "NSE:NIFTY", ltp: 25000, close: 24900 });
    await session.handleMessage(JSON.stringify({ op: "subscribe", symbols: ["NSE:NIFTY", "NSE:INFY", "NSE:RELIANCE", "NSE:GHOST"], mode: "quote", id: "s1" }));
    await settle();
    const snap = transport.sent.find((m) => m.type === "snapshot");
    expect(snap).toMatchObject({ id: "s1", mode: "quote", symbols: ["NSE:NIFTY", "NSE:INFY"], pending: ["NSE:INFY"] });
    expect(snap.ticks).toEqual([expect.objectContaining({ symbol: "NSE:NIFTY", ltp: 25000, change: 100 })]);
    const errors = transport.sent.filter((m) => m.type === "error");
    expect(errors).toEqual([
      expect.objectContaining({ code: "SUBSCRIPTION_LIMIT", op: "subscribe", id: "s1", symbols: ["NSE:RELIANCE"], retryable: false }),
      expect.objectContaining({ code: "SYMBOL_NOT_FOUND", symbols: ["NSE:GHOST"] }),
    ]);
    hub.pushTick({ symbol: "NSE:INFY", ltp: 1500 });
    hub.pushTick({ symbol: "NSE:NIFTY", ltp: 25001 });
    await settle();
    const ticks = transport.sent.filter((m) => m.type === "tick");
    expect(ticks.map((t) => [t.symbol, t.ltp])).toEqual([["NSE:INFY", 1500], ["NSE:NIFTY", 25001]]);
    expect(ticks[0]).toHaveProperty("open"); // quote mode
    const seqs = transport.sent.map((m) => m.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1)); // no gaps while the client keeps up
  });

  it("conflates ticks per symbol for a slow client and keeps memory bounded", async () => {
    const { hub, transport, session } = setup();
    await session.handleOp({ op: "subscribe", symbols: ["NSE:NIFTY", "NSE:INFY", "NSE:RELIANCE"], mode: "ltp" });
    await settle();
    const before = transport.sent.length;
    transport.blocked = true;
    for (let i = 1; i <= 30_000; i += 1) {
      hub.pushTick({ symbol: ["NSE:NIFTY", "NSE:INFY", "NSE:RELIANCE"][i % 3], ltp: i });
      if (i % 1000 === 0) {
        await settle();
        expect(session.stats().queued).toBeLessThanOrEqual(3);
      }
    }
    expect(transport.sent.length).toBe(before);
    transport.unblock();
    await settle();
    const ticks = transport.sent.slice(before).filter((m) => m.type === "tick");
    expect(ticks.map((t) => t.ltp).sort((a, b) => a - b)).toEqual([29998, 29999, 30000]); // only the latest per symbol
    const lastSeq = transport.sent.at(-1).seq;
    expect(lastSeq).toBeGreaterThan(30_000); // dropped ticks used up seqs: the gap tells the client
    expect(session.stats().conflatedTotal).toBe(30_000 - 3);
    vi.advanceTimersByTime(15_000);
    await settle();
    expect(transport.sent.at(-1)).toMatchObject({ type: "heartbeat", conflated: 30_000 - 3 });
  });

  it("disconnects a client whose non-tick queue overflows, with go_away slow_consumer", async () => {
    const { hub, transport, session, bus, closed } = setup({ stream: { maxQueuedMessages: 16 } });
    await session.handleOp({ op: "subscribe", symbols: ["NSE:NIFTY"] });
    await settle();
    transport.blocked = true;
    for (let i = 0; i < 17; i += 1) bus.emit("stream.status", { accountId: "dhan-main", broker: "dhan", connected: i % 2 === 0, subscriptions: 1 });
    await settle();
    expect(transport.sent.at(-1)).toMatchObject({ type: "go_away", reason: "slow_consumer", reconnectAfterMs: 1000 });
    expect(transport.closed).toEqual({ code: 4008, reason: "slow_consumer" });
    expect(closed).toHaveLength(1);
    expect(hub.stats().clients).toBe(0); // its subscriptions were released
    expect(bus.listenerCount("stream.status")).toBe(0);
    hub.pushTick({ symbol: "NSE:NIFTY", ltp: 1 });
    await settle();
    expect(transport.sent.at(-1).type).toBe("go_away");
  });

  it("drops queued ticks for a symbol on unsubscribe", async () => {
    const { hub, transport, session } = setup();
    await session.handleOp({ op: "subscribe", symbols: ["NSE:NIFTY", "NSE:INFY"] });
    await settle();
    transport.blocked = true;
    hub.pushTick({ symbol: "NSE:NIFTY", ltp: 1 });
    hub.pushTick({ symbol: "NSE:INFY", ltp: 2 });
    await session.handleOp({ op: "unsubscribe", symbols: ["nse:nifty"] });
    transport.unblock();
    await settle();
    const ticks = transport.sent.filter((m) => m.type === "tick");
    expect(ticks.map((t) => t.symbol)).toEqual(["NSE:INFY"]);
    expect(hub.clientSymbols("ws_test")).toEqual([{ symbol: "NSE:INFY", mode: "ltp" }]);
  });

  it("reports bad JSON, bad ops and too many ops as errors without closing", async () => {
    const { transport, session } = setup({ stream: { maxOpsPerSecond: 3 } });
    await session.handleMessage("{not json");
    await session.handleMessage(JSON.stringify({ op: "subscribe", symbols: "NSE:NIFTY", id: 7 }));
    await session.handleMessage(JSON.stringify({ op: "ping", id: "p1" }));
    await session.handleMessage(JSON.stringify({ op: "ping" }));
    await settle();
    const errors = transport.sent.filter((m) => m.type === "error");
    expect(errors[0]).toMatchObject({ code: "INVALID_JSON" });
    expect(errors[1]).toMatchObject({ code: "VALIDATION_FAILED", id: 7 });
    expect(errors[2]).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(transport.sent.find((m) => m.type === "heartbeat" && m.id === "p1")).toBeTruthy();
    expect(transport.closed).toBeNull();
    vi.advanceTimersByTime(1000);
    await session.handleMessage(JSON.stringify({ op: "ping", id: "p2" }));
    await settle();
    expect(transport.sent.at(-1)).toMatchObject({ type: "heartbeat", id: "p2" });
  });

  it("streams order updates only for accounts the key may use", async () => {
    const { bus, transport, session } = setup();
    await session.handleOp({ op: "subscribe_orders", accounts: ["kite-2"], id: "o0" });
    await settle();
    expect(transport.sent.at(-1)).toMatchObject({ type: "error", code: "ACCOUNT_FORBIDDEN", id: "o0" });
    bus.emit("order.updated", { orderId: "PAPER-1", accountId: "dhan-main", mode: "paper", status: "open", filledQuantity: 0, source: "rest" });
    await settle();
    expect(transport.sent.filter((m) => m.type === "order")).toHaveLength(0); // not subscribed yet
    await session.handleOp({ op: "subscribe_orders" });
    bus.emit("order.updated", { orderId: "PAPER-2", accountId: "dhan-main", mode: "paper", status: "filled", filledQuantity: 1, source: "rest" });
    bus.emit("order.updated", { orderId: "ord_x", accountId: "kite-2", mode: "live", status: "open", filledQuantity: 0, source: "rest" });
    await settle();
    expect(transport.sent.filter((m) => m.type === "order").map((m) => m.order.orderId)).toEqual(["PAPER-2"]);
    await session.handleOp({ op: "subscribe_orders" }); // idempotent: no duplicate listener
    expect(bus.listenerCount("order.updated")).toBe(1);
    await session.handleOp({ op: "unsubscribe_orders" });
    bus.emit("order.updated", { orderId: "PAPER-3", accountId: "dhan-main", mode: "paper", status: "open", filledQuantity: 0, source: "rest" });
    await settle();
    expect(transport.sent.filter((m) => m.type === "order")).toHaveLength(1);
  });

  it("a '*' key sees every account's orders", async () => {
    const { bus, transport, session } = setup({ key: { ...KEY, accounts: "*" } });
    await session.handleOp({ op: "subscribe_orders" });
    bus.emit("order.updated", { orderId: "a", accountId: "kite-2", mode: "paper", status: "open" });
    await settle();
    expect(transport.sent.filter((m) => m.type === "order")).toHaveLength(1);
  });

  it("sends go_away when the key behind the connection is revoked", async () => {
    const ks = createFakeKeyStore();
    const { record } = ks.addKey({ scopes: ["read"] });
    const { transport, closed } = setup({ key: record, keyStore: ks });
    vi.advanceTimersByTime(15_000);
    await settle();
    expect(transport.closed).toBeNull();
    await ks.revoke(record.id);
    vi.advanceTimersByTime(15_000);
    await settle();
    await settle();
    expect(transport.sent.at(-1)).toMatchObject({ type: "go_away", reason: "key_revoked" });
    expect(transport.closed.code).toBe(4001);
    expect(closed).toHaveLength(1);
  });

  it("goAway and close are idempotent and release everything", async () => {
    const { hub, transport, session, bus, closed } = setup();
    await session.handleOp({ op: "subscribe", symbols: ["NSE:NIFTY"] });
    session.goAway("shutdown", "Restarting.", 3000);
    session.goAway("shutdown", "Restarting.", 3000);
    session.close();
    expect(transport.sent.filter((m) => m.type === "go_away")).toHaveLength(1);
    expect(transport.sent.at(-1)).toMatchObject({ reason: "shutdown", reconnectAfterMs: 3000 });
    expect(closed).toHaveLength(1);
    expect(hub.stats().symbols).toBe(0);
    expect(bus.listenerCount()).toBe(0);
  });
});

describe("session registry", () => {
  it("caps connections and totals stats across closed sessions", async () => {
    const reg = createSessionRegistry({ max: 1 });
    const bus = createEventBus();
    const hub = createFakeStreamHub({ bus });
    const transport = fakeTransport();
    const s = createClientSession({ id: "ws_r", kind: "ws", key: KEY, hub, bus, transport, config: resolveStreamConfig({}), clock: { now: () => Date.now() }, logger: createNullLogger(), onClosed: (x) => reg.remove(x) });
    reg.add(s);
    expect(reg.full()).toBe(true);
    expect(reg.stats()).toMatchObject({ connections: 1, ws: 1, sse: 0, maxConnections: 1, opened: 1 });
    reg.goAwayAll("shutdown", "bye", 1000);
    expect(reg.size()).toBe(0);
    expect(reg.full()).toBe(false);
    expect(transport.sent.at(-1)).toMatchObject({ type: "go_away", reason: "shutdown" });
  });
});

describe("per-key connection cap", () => {
  it("one key cannot hold every slot", () => {
    const reg = createSessionRegistry({ max: 50, maxPerKey: 2 });
    reg.add({ keyId: "k1" });
    expect(reg.fullFor("k1")).toBe(false);
    reg.add({ keyId: "k1" });
    expect(reg.fullFor("k1")).toBe(true);
    expect(reg.fullFor("k2")).toBe(false);
    expect(reg.full()).toBe(false);
  });
});

describe("docs/asyncapi.yaml stays in step with the code", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const spec = readFileSync(resolve(import.meta.dirname, "../../../docs/asyncapi.yaml"), "utf8");

  it("documents every client op", () => {
    const ops = clientOpSchema.options.map((o) => o.shape.op.value);
    expect(ops).toEqual(["subscribe", "unsubscribe", "subscribe_orders", "unsubscribe_orders", "subscribe_budget", "unsubscribe_budget", "ping"]);
    for (const op of ops) expect(spec).toContain(`op: { const: ${op} }`);
  });

  it("documents every server message type and go_away reason", () => {
    for (const type of ["heartbeat", "snapshot", "tick", "order", "budget", "status", "error", "go_away"]) expect(spec).toContain(`type: { const: ${type} }`);
    expect(spec).toContain("enum: [shutdown, slow_consumer, key_revoked]");
    expect(spec).toMatch(/^asyncapi: 3\.0\.0$/m);
  });
});

describe("subscribe_budget", () => {
  it("sends the budget at once, then only while it changes (at least every 5 s), for the key's accounts only", async () => {
    let calls = 3;
    const scheduler = {
      usage: () => ({
        accounts: [
          { accountId: "dhan-main", broker: "dhan", healthy: true, queued: 0, classes: { quote: { callsToday: calls, backoffMs: 0, windows: [{ window: "1s", used: 1, limit: 1 }] } } },
          { accountId: "kite-main", broker: "zerodha", healthy: true, queued: 0, classes: { quote: { callsToday: 99, backoffMs: 0, windows: [] } } },
        ],
        savings: { servedFromStream: 4 },
      }),
    };
    const bus = createEventBus();
    const hub = createFakeStreamHub({ bus, accountId: "dhan-main", broker: "dhan" });
    const transport = fakeTransport();
    const session = createClientSession({ id: "ws_b", kind: "ws", key: KEY, hub, bus, transport, config: resolveStreamConfig({}), clock: { now: () => Date.now() }, logger: createNullLogger(), scheduler });
    await session.handleOp({ op: "subscribe_budget" });
    await settle();
    const budgets = () => transport.sent.filter((m) => m.type === "budget");
    expect(budgets()).toHaveLength(1);
    expect(budgets()[0].accounts.map((a) => a.accountId)).toEqual(["dhan-main"]);
    expect(budgets()[0]).toMatchObject({ callsToday: 3, savedToday: 4 });
    vi.advanceTimersByTime(1000);
    await settle();
    expect(budgets()).toHaveLength(1); // nothing changed
    calls = 4;
    vi.advanceTimersByTime(1000);
    await settle();
    expect(budgets()).toHaveLength(2);
    vi.advanceTimersByTime(5000);
    await settle();
    expect(budgets()).toHaveLength(3); // the keep-alive copy
    await session.handleOp({ op: "unsubscribe_budget" });
    calls = 9;
    vi.advanceTimersByTime(10_000);
    await settle();
    expect(budgets()).toHaveLength(3);
    session.close("test", false);
  });
});
