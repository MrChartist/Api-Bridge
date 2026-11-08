/**
 * Contract test with the REAL SafetyGuard + AuditLog and PaperEngine: the OrderService wired by createApp
 * exactly as in production, over the published fakes for accounts, scheduler, symbols and market data, plus a stub
 * adapter whose order methods use the real order gate. Fake clock set inside NSE market hours. No network.
 */
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
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
import paperModule from "../paper/module.mjs";
import { createFakeScheduler, createManualClock } from "../ratelimit/fake.mjs";
import safetyModule from "../safety/module.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { INSTRUMENTS, KEYS, PRICES, bookRow, liveOrder, stubOrderAdapter } from "./__fixtures__/helpers.mjs";
import ordersModule from "./module.mjs";

let app;
let zerodha;
let clock;
let dataDir;
const log = createNullLogger();
const ctx = (key = "live", source = "rest") => createCallContext({ source, key: KEYS[key], log });

const reject = async (p) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
};

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mcb-orders-int-"));
  const { config } = loadConfig({
    raw: {
      server: { port: 0 },
      dataDir,
      safety: { liveTrading: true, orderRatePerSecond: 5 },
      accounts: [
        { id: "zerodha-main", broker: "zerodha", live: { enabled: true, allowedSources: ["rest"] } },
        { id: "paper", broker: "paper" },
      ],
    },
    env: {},
  });
  clock = createManualClock(); // Monday 19 Oct 2026, 09:30 IST
  zerodha = stubOrderAdapter("zerodha");
  const accounts = createFakeAccountManager({
    accounts: [
      { id: "zerodha-main", broker: "zerodha", adapter: zerodha, creds: { apiKey: "k", accessToken: "secret-token-value" }, liveAllowedByConfig: true },
      { id: "paper", broker: "paper" },
    ],
  });
  app = await createApp({
    config,
    modules: [ordersModule, paperModule, safetyModule],
    logger: log,
    clock,
    overrides: {
      keyStore: notImplementedService("keyStore"),
      accounts,
      scheduler: createFakeScheduler(),
      symbols: createFakeSymbolService({ instruments: INSTRUMENTS }),
      marketData: createFakeMarketData({ prices: PRICES, clock }),
    },
  });
});

afterAll(async () => {
  await app?.close();
});

describe("orders with the real paper engine and safety guard", () => {
  it("places a paper order through the real safety check, paper engine and audit log", async () => {
    const { order } = await app.deps.orders.place(ctx("paper"), liveOrder({ account: "paper", mode: undefined, price: 1402.3 }), { idempotencyKey: "int-paper-0001" });
    expect(order).toMatchObject({ mode: "paper", accountId: "paper", symbol: "NSE:RELIANCE", quantity: 10 });
    expect(order.orderId).toMatch(/^PAPER-/);
    const again = await app.deps.orders.place(ctx("paper"), liveOrder({ account: "paper", mode: undefined, price: 1402.3 }), { idempotencyKey: "int-paper-0001" });
    expect(again).toMatchObject({ replayed: true, order: { orderId: order.orderId } });
    const audit = await app.deps.audit.query({ type: "order.placed" });
    expect(audit.items.some((r) => r.data?.orderId === order.orderId)).toBe(true);
    expect((await app.deps.audit.verify({})).ok).toBe(true);
  });

  it("places a live order: real verdict mints the gate, the real order-rate window counts it", async () => {
    const { order } = await app.deps.orders.place(ctx("live"), liveOrder({ price: 1400 }), { idempotencyKey: "int-live-0001" });
    expect(order).toMatchObject({ mode: "live", status: "open" });
    expect(zerodha.placed).toHaveLength(1);
    expect(app.deps.safety.limits("zerodha-main").usage.ordersLastSecond).toBeGreaterThanOrEqual(1);
  });

  it("real safety refusals reach the caller with their codes (price band, lots, live scope)", async () => {
    const far = await reject(app.deps.orders.place(ctx("live"), liveOrder({ price: 1000 }), { idempotencyKey: "int-live-0002" }));
    expect(far.code).toBe("INVALID_ORDER");
    expect(far.detail).toMatch(/away from the last traded price/);
    const lots = await reject(app.deps.orders.place(ctx("live"), { account: "zerodha-main", symbol: "NFO:NIFTY-2026-10-27-FUT", lots: 11, product: "MARGIN", orderType: "LIMIT", price: 25060, side: "BUY", mode: "live" }, { idempotencyKey: "int-live-0003" }));
    expect(lots.errors.map((e) => e.message).join(" ")).toMatch(/11 lots is above the per-order limit of 10 lots/);
    expect(await reject(app.deps.orders.place(ctx("paper"), liveOrder()))).toMatchObject({ code: "SCOPE_REQUIRED" });
  });

  it("the order-rate cap (5/s) stops a burst; nothing past the cap reaches the adapter", async () => {
    await clock.advance(2000);
    const before = zerodha.placed.length;
    const results = [];
    for (let i = 0; i < 7; i += 1) results.push(await app.deps.orders.place(ctx("live"), liveOrder({ price: 1400 + i * 0.1 }), { idempotencyKey: `int-burst-${i}-000` }).then(() => "ok", (e) => e.code));
    expect(results.filter((r) => r === "ok")).toHaveLength(5);
    expect(results.filter((r) => r === "ORDER_RATE_LIMITED")).toHaveLength(2);
    expect(zerodha.placed.length - before).toBe(5);
  });

  it("the kill switch with cancelOpenOrders cancels open orders, then refuses new ones", async () => {
    await clock.advance(2000);
    zerodha.book = zerodha.placed.map((p, i) => bookRow({ orderId: `ZERODHA-${1001 + i}`, status: "OPEN", price: p.order.price }));
    await app.deps.safety.engageKillSwitch(ctx("live"), { reason: "integration test", cancelOpenOrders: true });
    for (let i = 0; i < 20 && zerodha.cancelled.length < zerodha.book.length; i += 1) await clock.advance(500);
    expect(zerodha.cancelled.length).toBe(zerodha.book.length);
    expect(await reject(app.deps.orders.place(ctx("live"), liveOrder({ price: 1401 }), { idempotencyKey: "int-live-0004" }))).toMatchObject({ code: "KILL_SWITCH_ACTIVE", status: 423 });
  });

  it("no credential reaches the audit files", () => {
    const dir = join(dataDir, "audit");
    const text = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    expect(text).toContain("order.requested");
    expect(text).not.toContain("secret-token-value");
  });
});
