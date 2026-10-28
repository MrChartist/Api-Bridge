/**
 * S7 routes end to end through the real request pipeline (createApp): the real OrderService over published fakes
 * (accounts, scheduler, symbols, market data) and the S7 stubs (safety, audit, paper), with a fake key store.
 * Checks the OpenAPI shapes ({ data, meta }), status codes, Idempotency-Replayed, auth and scope, validation and
 * the ticket confirmation routes.
 */
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { createApp } from "../core/app.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { createCallContext } from "../core/context.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createFakeMarketData } from "../market/fake.mjs";
import { createFakeScheduler, createManualClock } from "../ratelimit/fake.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { INSTRUMENTS, KEYS, PRICES, bookRow, createStubAudit, createStubPaper, createStubSafety, liveOrder, stubOrderAdapter } from "./__fixtures__/helpers.mjs";
import ordersModule, { ROUTES } from "./module.mjs";

const RAW = { live: "mcb_livekey0001_x", paper: "mcb_paperkey001_x", read: "mcb_readkey0001_x", admin: "mcb_adminkey001_x", mcp: "mcb_mcpkey00001_x" };
const BY_RAW = Object.fromEntries(Object.entries(RAW).map(([name, raw]) => [raw, KEYS[name]]));
const keyStore = { ...notImplementedService("keyStore"), authenticate: async (raw) => BY_RAW[raw] ?? null };

let app;
let port;
let zerodha;
let clock;

function call(method, path, { key = RAW.live, body, headers = {} } = {}) {
  const h = { host: `127.0.0.1:${port}`, ...headers };
  if (key) h.authorization = `Bearer ${key}`;
  let payload;
  if (body !== undefined) {
    payload = typeof body === "string" ? body : JSON.stringify(body);
    h["content-type"] = "application/json";
    h["content-length"] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-orders-routes-"));
  const { config } = loadConfig({
    raw: {
      server: { port: 0 },
      dataDir,
      safety: { liveTrading: true },
      accounts: [
        { id: "zerodha-main", broker: "zerodha", live: { enabled: true, allowedSources: ["rest", "mcp"] } },
        { id: "paper", broker: "paper" },
      ],
      orders: { liveCallTimeoutMs: 5000 },
    },
    env: {},
  });
  clock = createManualClock();
  zerodha = stubOrderAdapter("zerodha");
  const accounts = createFakeAccountManager({
    accounts: [
      { id: "zerodha-main", broker: "zerodha", adapter: zerodha, creds: { apiKey: "k", accessToken: "t" }, liveAllowedByConfig: true },
      { id: "paper", broker: "paper" },
    ],
  });
  app = await createApp({
    config,
    modules: [ordersModule],
    logger: createNullLogger(),
    clock,
    overrides: {
      keyStore,
      accounts,
      scheduler: createFakeScheduler(),
      symbols: createFakeSymbolService({ instruments: INSTRUMENTS }),
      marketData: createFakeMarketData({ prices: PRICES, clock }),
      safety: createStubSafety(),
      audit: createStubAudit(),
      paper: createStubPaper({ clock }),
    },
  });
  ({ port } = await app.listen());
});

afterAll(async () => {
  await app?.close();
});

describe("module", () => {
  it("registers exactly the contract routes and reports ready", async () => {
    const mine = app.router.list().filter((r) => r.module === "orders").map((r) => `${r.method} ${r.pattern}`);
    expect(mine.sort()).toEqual(ROUTES.map(([m, p]) => `${m} ${p}`).sort());
    const health = await call("GET", "/v1/health", { key: null });
    expect(health.json.services.orders).toBe("ready");
  });
});

describe("POST /v1/orders", () => {
  it("places a paper order (default mode): 201 { data, meta }", async () => {
    const r = await call("POST", "/v1/orders", { body: liveOrder({ mode: undefined }) });
    expect(r.status).toBe(201);
    expect(r.json.data).toMatchObject({ mode: "paper", accountId: "zerodha-main", symbol: "NSE:RELIANCE", status: "open" });
    expect(r.json.meta).toMatchObject({ requestId: expect.any(String), accountId: "zerodha-main", mode: "paper" });
  });

  it("places a live order and replays it for the same Idempotency-Key", async () => {
    const first = await call("POST", "/v1/orders", { body: liveOrder(), headers: { "idempotency-key": "route-key-0001" } });
    expect(first.status).toBe(201);
    expect(first.headers["idempotency-replayed"]).toBeUndefined();
    const again = await call("POST", "/v1/orders", { body: liveOrder(), headers: { "idempotency-key": "route-key-0001" } });
    expect(again.status).toBe(201);
    expect(again.headers["idempotency-replayed"]).toBe("true");
    expect(again.json.data.orderId).toBe(first.json.data.orderId);
    const other = await call("POST", "/v1/orders", { body: liveOrder({ quantity: 2 }), headers: { "idempotency-key": "route-key-0001" } });
    expect(other.status).toBe(409);
    expect(other.json).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", retryable: false });
    expect(other.headers["content-type"]).toMatch(/problem\+json/);
  });

  it("refuses bad keys, bad bodies and missing scopes with problem+json", async () => {
    expect((await call("POST", "/v1/orders", { body: liveOrder(), headers: { "idempotency-key": "x" } })).json.code).toBe("VALIDATION_FAILED");
    const noBody = await call("POST", "/v1/orders", {});
    expect(noBody.status).toBe(400);
    const missing = await call("POST", "/v1/orders", { body: { account: "zerodha-main", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1 } });
    expect(missing.status).toBe(400);
    expect(missing.json.errors.map((e) => e.path)).toEqual(expect.arrayContaining(["product", "orderType"]));
    expect((await call("POST", "/v1/orders", { key: RAW.read, body: liveOrder() })).json.code).toBe("SCOPE_REQUIRED");
    expect((await call("POST", "/v1/orders", { key: null, body: liveOrder() })).status).toBe(401);
    const paperKeyLive = await call("POST", "/v1/orders", { key: RAW.paper, body: liveOrder() });
    expect(paperKeyLive.status).toBe(403);
    expect(paperKeyLive.json.code).toBe("SCOPE_REQUIRED");
  });

  it("answers 504 OUTCOME_UNKNOWN (not retryable) when the broker does not answer", async () => {
    zerodha.next = "hang";
    const pending = call("POST", "/v1/orders", { body: liveOrder({ price: 1390 }), headers: { "idempotency-key": "route-hang-0001" } });
    for (let i = 0; i < 50 && zerodha.pendingCount() === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(zerodha.pendingCount()).toBe(1);
    await clock.advance(5000);
    const r = await pending;
    expect(r.status).toBe(504);
    expect(r.json).toMatchObject({ code: "OUTCOME_UNKNOWN", retryable: false });
    zerodha.next = "ack";
    zerodha.release({ orderId: "LATE-1", orderStatus: "OPEN" });
  });
});

describe("POST /v1/orders/preview margin", () => {
  const CE = "NFO:NIFTY-2026-10-27-25000-CE";
  const opt = (over) => ({ account: "paper", symbol: CE, side: "SELL", lots: 1, product: "MARGIN", orderType: "LIMIT", price: 120, ...over });

  it("a paper SELL option preview carries the paper engine's margin", async () => {
    const r = await call("POST", "/v1/orders/preview", { key: RAW.paper, body: opt() });
    expect(r.status).toBe(200);
    expect(r.json.data.margin).toEqual({ required: 243_750, source: "paper-model" }); // 15% of 25000 × 65
  });

  it("a paper BUY option blocks its premium", async () => {
    const r = await call("POST", "/v1/orders/preview", { key: RAW.paper, body: opt({ side: "BUY", price: 120 }) });
    expect(r.json.data.margin).toEqual({ required: 7800, source: "paper-model" }); // 120 × 65
  });

  it("an order that only closes a held position blocks nothing", async () => {
    app.deps.paper.seed("paper", { positions: [{ symbol: CE, product: "MARGIN", netQty: 65 }] });
    const r = await call("POST", "/v1/orders/preview", { key: RAW.paper, body: opt({ side: "SELL" }) });
    expect(r.json.data.margin).toEqual({ required: 0, source: "paper-model" });
  });

  it("a live preview on a broker account has no margin figure", async () => {
    const r = await call("POST", "/v1/orders/preview", { body: liveOrder() });
    expect(r.json.data.mode).toBe("live");
    expect(r.json.data.margin).toBeNull();
  });
});

describe("other order routes", () => {
  it("preview, get, by-client-id, modify, cancel and list", async () => {
    const pv = await call("POST", "/v1/orders/preview", { body: liveOrder() });
    expect(pv.status).toBe(200);
    expect(pv.json.data).toMatchObject({ ok: true, mode: "live", quantity: 10, requiresHumanConfirmation: false });

    const placed = await call("POST", "/v1/orders", { body: liveOrder({ clientOrderId: "route-c1", price: 1395 }) });
    const id = placed.json.data.orderId;
    zerodha.book = [bookRow({ orderId: placed.json.data.legs[0].brokerOrderId, price: 1395, status: "OPEN" })];
    const got = await call("GET", `/v1/orders/${id}`, { key: RAW.read });
    expect(got.json.data).toMatchObject({ orderId: id, status: "open" });
    expect((await call("GET", "/v1/orders/by-client-id/route-c1", { key: RAW.read })).json.data.orderId).toBe(id);
    expect((await call("GET", "/v1/orders/by-client-id/bad%20id", { key: RAW.read })).status).toBe(400);
    expect((await call("GET", "/v1/orders/ord_nope", { key: RAW.read })).status).toBe(404);

    const mod = await call("PATCH", `/v1/orders/${id}`, { body: { price: 1396 }, headers: { "idempotency-key": "route-mod-001" } });
    expect(mod.status).toBe(200);
    expect(mod.json.data.price).toBe(1396);
    expect((await call("PATCH", `/v1/orders/${id}`, { body: { price: 1396 }, headers: { "idempotency-key": "route-mod-001" } })).headers["idempotency-replayed"]).toBe("true");
    expect((await call("PATCH", `/v1/orders/${id}`, { body: { symbol: "x" } })).status).toBe(400);

    expect((await call("DELETE", `/v1/orders/${id}`, { body: { x: 1 } })).status).toBe(400); // body: none
    const del = await call("DELETE", `/v1/orders/${id}`);
    expect(del.status).toBe(200);
    expect(del.json.data.status).toBe("cancelled");

    const list = await call("GET", "/v1/orders?mode=live&limit=1", { key: RAW.read });
    expect(list.status).toBe(200);
    expect(list.json.data).toHaveLength(1);
    expect(list.json.meta).toMatchObject({ mode: "live", nextCursor: expect.any(String) });
    const next = await call("GET", `/v1/orders?mode=live&limit=1&cursor=${list.json.meta.nextCursor}`, { key: RAW.read });
    expect(next.json.data[0].orderId).not.toBe(list.json.data[0].orderId);
    expect((await call("GET", "/v1/orders?status=done", { key: RAW.read })).status).toBe(400);
    expect((await call("GET", "/v1/orders?limit=0", { key: RAW.read })).status).toBe(400);
    expect((await call("GET", "/v1/orders?mode=real", { key: RAW.read })).status).toBe(400);
  });

  it("cancel-all validates its body", async () => {
    const ok = await call("POST", "/v1/orders/cancel-all", { body: { account: "paper", mode: "paper" } });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toEqual({ cancelled: expect.any(Array), failed: [] });
    expect((await call("POST", "/v1/orders/cancel-all", { body: { everything: true } })).status).toBe(400);
  });

  it("trades", async () => {
    zerodha.trades = [{ tradeId: "T1", orderId: "X", tradingSymbol: "RELIANCE", exchange: "NSE", token: "738561", side: "BUY", qty: 1, price: 1400, tradedAt: null }];
    const r = await call("GET", "/v1/trades?account=zerodha-main&mode=live", { key: RAW.read });
    expect(r.status).toBe(200);
    expect(r.json.data[0]).toMatchObject({ tradeId: "T1", symbol: "NSE:RELIANCE", mode: "live" });
    expect(r.json.meta).toMatchObject({ accountId: "zerodha-main", nextCursor: null });
  });
});

describe("portfolio routes", () => {
  it("need an account and answer with freshness in meta", async () => {
    expect((await call("GET", "/v1/positions", { key: RAW.read })).status).toBe(400);
    zerodha.positions = [{ tradingSymbol: "RELIANCE", exchange: "NSE", token: "738561", product: "CNC", netQty: 1, avgPrice: 1, ltp: 2, pnl: 1, realisedPnl: null, unrealisedPnl: 1 }];
    const pos = await call("GET", "/v1/positions?account=zerodha-main", { key: RAW.read });
    expect(pos.status).toBe(200);
    expect(pos.json.data[0].symbol).toBe("NSE:RELIANCE");
    expect(pos.json.meta).toMatchObject({ accountId: "zerodha-main", mode: "live", freshness: { source: "broker", stale: false } });
    const hold = await call("GET", "/v1/holdings?account=zerodha-main", { key: RAW.read });
    expect(hold.status).toBe(200);
    const funds = await call("GET", "/v1/funds?account=paper", { key: RAW.read });
    expect(funds.json.meta.mode).toBe("paper");
    expect(funds.json.data.availableCash).toBe(1_000_000);
    expect((await call("GET", "/v1/funds?account=Bad!", { key: RAW.read })).status).toBe(400);
  });
});

describe("tickets", () => {
  it("lists and confirms with an admin key from this computer; others are refused", async () => {
    expect((await call("GET", "/v1/tickets", { key: RAW.live })).status).toBe(403);
    expect((await call("GET", "/v1/tickets", { key: RAW.admin })).json.data).toEqual([]);
    expect((await call("POST", "/v1/tickets/tkt_nope/confirm", { key: RAW.admin })).status).toBe(404);

    // An AI assistant prepares an order (MCP calls the service directly with source "mcp").
    const mcpCtx = createCallContext({ source: "mcp", key: KEYS.mcp, log: createNullLogger() });
    const body = liveOrder({ price: 1388 });
    const pv = await app.deps.orders.preview(mcpCtx, body);
    const listed = await call("GET", "/v1/tickets", { key: RAW.admin });
    expect(listed.json.data).toEqual([expect.objectContaining({ ticketId: pv.ticketId, source: "mcp", client: "Claude" })]);
    const conf = await call("POST", `/v1/tickets/${pv.ticketId}/confirm`, { key: RAW.admin });
    expect(conf.status).toBe(200);
    expect(conf.json.data).toEqual({ confirmToken: expect.stringMatching(/^mct_/), expiresAt: expect.stringMatching(/\+05:30$/) });
    const { order } = await app.deps.orders.place(mcpCtx, { ...body, confirmToken: conf.json.data.confirmToken }, { idempotencyKey: "mcp:route-ticket" });
    expect(order).toMatchObject({ mode: "live", source: "mcp" });
  });
});
