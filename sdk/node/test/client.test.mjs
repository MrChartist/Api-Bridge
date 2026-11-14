// Node SDK tests against the local fake Bridge. Run: node --test sdk/node/test/
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import WebSocket from "ws";
import { BridgeApiError, BridgeClient, BridgeConnectionError, toQuery } from "../src/index.mjs";
import { TEST_KEY, createFakeBridge } from "./fakeServer.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ORDER = { account: "dhan-main", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "LIMIT", price: 2900 };

let fake;
let baseUrl;
let waits;
const client = (o = {}) => new BridgeClient({ baseUrl, apiKey: TEST_KEY, sleep: async (ms) => waits.push(ms), ...o });
const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

before(async () => {
  fake = createFakeBridge();
  baseUrl = `http://127.0.0.1:${await fake.listen()}`;
});
after(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.reset();
  waits = [];
});

describe("reads", () => {
  it("returns the envelope with freshness and per-symbol errors", async () => {
    const r = await client().ltp(["NSE:NIFTY", "NSE:NOPE"], { account: "dhan-main", maxAgeMs: 0 });
    assert.equal(r.data[0].ltp, 25000.5);
    assert.equal(r.data[0].freshness.source, "stream");
    assert.deepEqual(r.errors.map((e) => e.code), ["SYMBOL_NOT_FOUND"]);
    const [req] = fake.requests();
    assert.deepEqual(req.query, { symbols: "NSE:NIFTY,NSE:NOPE", account: "dhan-main", maxAgeMs: "0" });
    assert.equal(req.authorization, "present");
    assert.match(req.userAgent, /^mrchartist-bridge-node\//);
  });

  it("sends purpose, fields and the time options when given, and nothing when not", async () => {
    const c = client();
    await c.ltp(["NSE:NIFTY"], { purpose: "order" });
    assert.equal(fake.requests().at(-1).query.purpose, "order");
    await c.quotes("NSE:RELIANCE", { purpose: "alert", fields: ["ltp", "bid"] });
    assert.equal(fake.requests().at(-1).query.purpose, "alert");
    assert.equal(fake.requests().at(-1).query.fields, "ltp,bid");
    await c.optionChain({ underlying: "NIFTY", expiry: "2026-10-27", purpose: "analysis" });
    assert.equal(fake.requests().at(-1).query.purpose, "analysis");
    await c.history({ symbol: "NSE:NIFTY", interval: "1d", countback: 2, purpose: "paper", timeIso: true, tz: "UTC", fields: "close" });
    const q = fake.requests().at(-1).query;
    assert.deepEqual([q.purpose, q.timeIso, q.tz, q.fields], ["paper", "true", "UTC", "close"]);
    await c.ltp(["NSE:NIFTY"]);
    assert.equal("purpose" in fake.requests().at(-1).query, false);
  });

  it("history as JSON or CSV text; option chain; quotes", async () => {
    const c = client();
    assert.equal((await c.history({ symbol: "NSE:NIFTY", interval: "5m", countback: 2 })).data.candles.length, 2);
    assert.match(await c.history({ symbol: "NSE:NIFTY", interval: "5m", countback: 2, format: "csv" }), /^time,open/);
    assert.equal((await c.optionChain({ underlying: "NIFTY", expiry: "2026-10-27", strikes: 5 })).data.atmStrike, 25000);
    assert.equal((await c.quotes("NSE:RELIANCE")).data[0].bid, 99.95);
  });

  it("paginates with nextCursor", async () => {
    const ids = [];
    for await (const o of client().paginate((p) => client().orders(p), { account: "dhan-main" })) ids.push(o.orderId);
    assert.deepEqual(ids, ["PAPER-1", "PAPER-2", "PAPER-3", "PAPER-4", "PAPER-5", "PAPER-6"]);
  });

  it("never exposes the key on the client object", () => {
    const c = client();
    assert.equal(JSON.stringify(c).includes(TEST_KEY), false);
    assert.equal(Object.keys(c).includes("_apiKey"), false);
  });

  it("toQuery drops empty values and joins arrays", () => {
    assert.equal(toQuery({ a: undefined, b: null, c: ["x", "y"], d: 0, e: false }), "?c=x%2Cy&d=0&e=false");
    assert.equal(toQuery({}), "");
  });

  it("a bad key is a BridgeApiError, not retried", async () => {
    await assert.rejects(client({ apiKey: "wrong" }).ltp(["NSE:NIFTY"]), (e) => e instanceof BridgeApiError && e.code === "UNAUTHENTICATED" && e.status === 401);
    assert.equal(fake.requests().length, 1);
  });
});

describe("idempotency keys", () => {
  it("every order write carries one by default, and the same key replays", async () => {
    const c = client();
    const first = await c.placeOrder(ORDER);
    assert.match(first.idempotencyKey, UUID_RE);
    assert.equal(first.replayed, false);
    assert.equal(first.data.orderId, "PAPER-1");
    const again = await c.placeOrder(ORDER, { idempotencyKey: first.idempotencyKey });
    assert.equal(again.replayed, true);
    assert.equal(again.data.orderId, "PAPER-1");
    const second = await c.placeOrder(ORDER);
    assert.notEqual(second.idempotencyKey, first.idempotencyKey);
    assert.equal(second.data.orderId, "PAPER-2");
  });

  it("modify, cancel and cancel-all carry keys too", async () => {
    const c = client();
    await c.modifyOrder("PAPER-9", { price: 2901 });
    await c.cancelOrder("PAPER-9");
    const all = await c.cancelAllOrders({ account: "dhan-main", mode: "paper" });
    assert.deepEqual(all.data.cancelled, ["PAPER-1"]);
    const reqs = fake.requests();
    assert.deepEqual(reqs.map((r) => r.method), ["PATCH", "DELETE", "POST"]);
    for (const r of reqs) assert.match(r.idempotencyKey, UUID_RE);
    assert.deepEqual(reqs[2].body, { account: "dhan-main", mode: "paper" });
  });

  it("previews do not need a key", async () => {
    const r = await client().previewOrder(ORDER);
    assert.equal(r.data.ok, true);
    assert.equal(fake.requests()[0].idempotencyKey, null);
  });
});

describe("retries", () => {
  const busy = (code = "UPSTREAM_RATE_LIMITED", retryAfter = "2") => ({
    status: 429,
    body: { type: "x", title: "busy", status: 429, code, retryable: true },
    headers: { "Content-Type": "application/problem+json", "Retry-After": retryAfter },
  });

  it("retries a retryable problem after Retry-After", async () => {
    fake.script("GET", "/v1/ltp", [busy(), busy()]);
    const r = await client().ltp(["NSE:NIFTY"]);
    assert.equal(r.data[0].ltp, 25000.5);
    assert.equal(fake.requests().length, 3);
    assert.deepEqual(waits, [2000, 2000]);
  });

  it("gives up after maxRetries", async () => {
    fake.script("GET", "/v1/ltp", [busy(), busy(), busy()]);
    await assert.rejects(client({ maxRetries: 1 }).ltp(["NSE:NIFTY"]), (e) => e.code === "UPSTREAM_RATE_LIMITED" && e.retryable);
    assert.equal(fake.requests().length, 2);
  });

  it("does not retry a non-retryable problem", async () => {
    fake.script("POST", "/v1/orders", [{ status: 422, body: { type: "x", title: "bad", status: 422, code: "INVALID_ORDER", retryable: false, detail: "Lot size 75." }, headers: { "Content-Type": "application/problem+json" } }]);
    await assert.rejects(client().placeOrder(ORDER), (e) => e instanceof BridgeApiError && e.code === "INVALID_ORDER" && e.detail === "Lot size 75." && UUID_RE.test(e.idempotencyKey));
    assert.equal(fake.requests().length, 1);
  });

  it("never retries OUTCOME_UNKNOWN", async () => {
    fake.script("POST", "/v1/orders", [{ status: 504, body: { type: "x", title: "unknown", status: 504, code: "OUTCOME_UNKNOWN", retryable: false }, headers: { "Content-Type": "application/problem+json" } }]);
    await assert.rejects(client().placeOrder(ORDER), (e) => e.code === "OUTCOME_UNKNOWN" && e.retryable === false);
    assert.equal(fake.requests().length, 1);
  });

  it("retries a retryable write with the SAME idempotency key", async () => {
    fake.script("POST", "/v1/orders", [busy("ORDER_RATE_LIMITED", "1")]);
    const r = await client().placeOrder(ORDER);
    const keys = fake.requests().map((q) => q.idempotencyKey);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
    assert.equal(r.idempotencyKey, keys[0]);
    assert.deepEqual(waits, [1000]);
  });

  it("retries a read after a dropped connection", async () => {
    fake.script("GET", "/v1/ltp", [{ destroy: true }]);
    const r = await client().ltp(["NSE:NIFTY"]);
    assert.equal(r.data.length, 1);
    assert.equal(waits.length, 1);
  });

  it("never retries a write without a reply: outcome unknown, key kept for a safe manual retry", async () => {
    fake.script("POST", "/v1/orders", [{ destroy: true }]);
    await assert.rejects(client().placeOrder(ORDER), (e) => e instanceof BridgeConnectionError && e.outcomeUnknown === true && UUID_RE.test(e.idempotencyKey) && /same Idempotency-Key/.test(e.message));
    assert.equal(fake.requests().length, 1);
  });

  it("a write that times out is not retried", async () => {
    fake.script("POST", "/v1/orders", [{ delayMs: 400, status: 201, body: {} }]);
    await assert.rejects(client({ timeoutMs: 100 }).placeOrder(ORDER), (e) => e instanceof BridgeConnectionError && e.timedOut && e.outcomeUnknown);
    assert.equal(fake.requests().length, 1);
  });

  it("plain-text errors become problems using X-Error-Code", async () => {
    fake.script("GET", "/v1/ltp", [{ status: 404, body: "#N/A", headers: { "Content-Type": "text/plain", "X-Error-Code": "SYMBOL_NOT_FOUND" } }]);
    await assert.rejects(client().ltp(["NSE:X"]), (e) => e.code === "SYMBOL_NOT_FOUND" && e.status === 404 && e.retryable === false);
  });

  it("a Bridge that is not running is a connection error after read retries", async () => {
    const c = new BridgeClient({ baseUrl: "http://127.0.0.1:1", apiKey: TEST_KEY, maxRetries: 1, sleep: async (ms) => waits.push(ms) });
    await assert.rejects(c.health(), (e) => e instanceof BridgeConnectionError && e.outcomeUnknown === false);
    assert.equal(waits.length, 1);
  });
});

describe("safety surface", () => {
  it("can engage the kill switch but has no way to release it", async () => {
    const r = await client().engageKillSwitch({ reason: "test" });
    assert.equal(r.data.engaged, true);
    assert.deepEqual(fake.requests()[0].body, { reason: "test", cancelOpenOrders: false });
    assert.equal(typeof client().releaseKillSwitch, "undefined");
  });
});

describe("streaming", () => {
  it("streamUrl uses a fresh single-use token, never the API key", async () => {
    const url = await client().streamUrl();
    assert.match(url, /^ws:\/\/127\.0\.0\.1:\d+\/v1\/stream\?token=st_/);
    assert.equal(url.includes(TEST_KEY), false);
  });

  it("subscribes, receives ticks, reconnects with a new token and re-subscribes", async () => {
    for (const WS of [WebSocket, undefined]) {
      if (WS === undefined && typeof globalThis.WebSocket !== "function") continue; // Node 20: only the ws path
      fake.reset();
      const s = client({ WebSocket: WS }).stream({ symbols: ["NSE:NIFTY"], mode: "ltp" });
      const ticks = [];
      const snapshots = [];
      let reconnects = 0;
      s.on("tick", (t) => ticks.push(t.ltp));
      s.on("snapshot", (m) => snapshots.push(m.symbols));
      s.on("reconnecting", () => (reconnects += 1));
      await until(() => snapshots.length === 1);
      fake.tick("NSE:NIFTY", 25001);
      fake.tick("NSE:BANKNIFTY", 1); // not subscribed: never delivered
      await until(() => ticks.length === 1);
      s.subscribe(["NSE:RELIANCE"], "quote");
      await until(() => snapshots.length === 2);
      fake.drop();
      await until(() => snapshots.length >= 3);
      assert.equal(reconnects, 1);
      fake.tick("NSE:RELIANCE", 2900);
      await until(() => ticks.length === 2);
      assert.deepEqual(ticks, [25001, 2900]);
      const tokenCalls = fake.requests().filter((r) => r.path === "/v1/stream/token");
      assert.equal(tokenCalls.length, 2);
      s.close();
      await until(() => fake.clientCount() === 0);
    }
  });

  it("async iteration ends after close()", async () => {
    const s = client({ WebSocket }).stream({ symbols: ["NSE:NIFTY"] });
    const types = [];
    for await (const msg of s) {
      types.push(msg.type);
      if (msg.type === "snapshot") s.close();
    }
    assert.deepEqual(types, ["heartbeat", "snapshot"]);
  });

  it("a key without access stops instead of retrying forever", async () => {
    const s = client({ apiKey: "wrong", WebSocket }).stream({ symbols: ["NSE:NIFTY"] });
    const failures = [];
    s.on("failure", (e) => failures.push(e.code));
    await until(() => s.closed);
    assert.deepEqual(failures, ["UNAUTHENTICATED"]);
  });
});
