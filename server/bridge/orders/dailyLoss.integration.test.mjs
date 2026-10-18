/**
 * Regression: dailyMaxLoss must actually trip. Real SafetyGuard + PaperEngine wired by createApp (as in
 * production); a losing paper round trip blocks the next paper order, and a live account whose broker day P&L is
 * below the limit blocks the next live order. Fake clock, fake market data and a stub adapter; no network.
 */
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
import paperModule from "../paper/module.mjs";
import { createFakeScheduler, createManualClock } from "../ratelimit/fake.mjs";
import safetyModule from "../safety/module.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { INSTRUMENTS, KEYS, PRICES, liveOrder, stubOrderAdapter } from "./__fixtures__/helpers.mjs";
import ordersModule from "./module.mjs";

let app;
let md;
let clock;
let zerodha;
const log = createNullLogger();
const ctx = (key) => createCallContext({ source: "rest", key: KEYS[key], log });
const reject = async (p) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
};

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-dailyloss-"));
  const { config } = loadConfig({
    raw: {
      server: { port: 0 },
      dataDir,
      safety: { liveTrading: true, dailyMaxLoss: 1000 },
      accounts: [
        { id: "zerodha-main", broker: "zerodha", live: { enabled: true, allowedSources: ["rest"] } },
        { id: "paper", broker: "paper" },
      ],
    },
    env: {},
  });
  clock = createManualClock();
  md = createFakeMarketData({ prices: PRICES, clock });
  zerodha = stubOrderAdapter("zerodha");
  const accounts = createFakeAccountManager({
    accounts: [
      { id: "zerodha-main", broker: "zerodha", adapter: zerodha, creds: { apiKey: "k", accessToken: "t" }, liveAllowedByConfig: true },
      { id: "paper", broker: "paper" },
    ],
  });
  app = await createApp({
    config,
    modules: [ordersModule, paperModule, safetyModule],
    logger: log,
    clock,
    overrides: { keyStore: notImplementedService("keyStore"), accounts, scheduler: createFakeScheduler(), symbols: createFakeSymbolService({ instruments: INSTRUMENTS }), marketData: md },
  });
});

afterAll(async () => {
  await app?.close();
});

const paperOrder = (over = {}) => liveOrder({ account: "paper", mode: undefined, product: "INTRADAY", ...over });

describe("daily loss limit", () => {
  it("a losing paper round trip blocks the next paper order with DAILY_LIMIT_REACHED", async () => {
    const buy = await app.deps.orders.place(ctx("paper"), paperOrder({ price: 1402.3 }));
    await clock.advance(1000);
    expect((await app.deps.paper.order("paper", buy.order.orderId)).status).toBe("filled");
    md.setPrice("NSE:RELIANCE", 1250);
    app.deps.bus.emit("tick", { symbol: "NSE:RELIANCE", accountId: "fake-1", broker: "fake", ltp: 1250, receivedAt: clock.now() });
    await clock.advance(3000);
    const sell = await app.deps.orders.place(ctx("paper"), paperOrder({ side: "SELL", price: 1250 }));
    await clock.advance(1000);
    expect((await app.deps.paper.order("paper", sell.order.orderId)).status).toBe("filled");
    expect(app.deps.safety.limits("paper").usage.byMode.paper.realisedPnl).toBeLessThanOrEqual(-1000);
    const e = await reject(app.deps.orders.place(ctx("paper"), paperOrder({ price: 1250 })));
    expect(e.code).toBe("DAILY_LIMIT_REACHED");
  });

  it("a live account whose broker day P&L is past the limit cannot place a live order", async () => {
    zerodha.positions = [{ tradingSymbol: "RELIANCE", exchange: "NSE", token: "738561", product: "INTRADAY", netQty: 10, avgPrice: 1400, ltp: 1250, pnl: -1500, realisedPnl: 0, unrealisedPnl: -1500 }];
    md.setPrice("NSE:RELIANCE", 1250);
    const e = await reject(app.deps.orders.place(ctx("live"), liveOrder({ price: 1250 }), { idempotencyKey: "loss-live-0001" }));
    expect(e.code).toBe("DAILY_LIMIT_REACHED");
    expect(zerodha.placed).toHaveLength(0);
  });
});
