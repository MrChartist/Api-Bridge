/**
 * Regression: a modify passes the same per-order checks as a new order. Real SafetyGuard + PaperEngine wired by
 * createApp (as in production). Before the fix a paper modify reached SafetyGuard with no lot size and no value, so a
 * 5-lot order could be raised to 20 lots (above maxLotsPerOrder and maxOrderValue) without a refusal.
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
import { INSTRUMENTS, KEYS, PRICES, stubOrderAdapter } from "./__fixtures__/helpers.mjs";
import ordersModule from "./module.mjs";

const OPT = "NFO:NIFTY-2026-10-27-25000-CE"; // lot 65, LTP 120.5, freeze 1800
const LOT = 65;
let app;
let clock;
const log = createNullLogger();
const ctx = (key) => createCallContext({ source: "rest", key: KEYS[key], log });
/** Every reason SafetyGuard gave, not just the first. */
const all = (e) => (e.errors ?? []).map((x) => x.message).join(" | ") || e.detail;
const reject = async (p) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
};

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-modifylimits-"));
  const { config } = loadConfig({
    raw: {
      server: { port: 0 },
      dataDir,
      safety: { liveTrading: true },
      // 10 lots and ₹60,000 per order: 8 lots at 118 is ₹61,360 (value refused, lots fine).
      accounts: [{ id: "paper", broker: "paper", limits: { maxLotsPerOrder: 10, maxOrderValue: 60_000 } }],
    },
    env: {},
  });
  clock = createManualClock();
  const accounts = createFakeAccountManager({ accounts: [{ id: "paper", broker: "paper" }] });
  void stubOrderAdapter;
  app = await createApp({
    config,
    modules: [ordersModule, paperModule, safetyModule],
    logger: log,
    clock,
    overrides: { keyStore: notImplementedService("keyStore"), accounts, scheduler: createFakeScheduler(), symbols: createFakeSymbolService({ instruments: INSTRUMENTS }), marketData: createFakeMarketData({ prices: PRICES, clock }) },
  });
});

afterAll(async () => {
  await app?.close();
});

/** A resting BUY LIMIT below the LTP (stays open), within the 3% band. */
async function restingOrder(lots = 5) {
  const r = await app.deps.orders.place(ctx("paper"), { account: "paper", symbol: OPT, side: "BUY", quantity: lots * LOT, product: "INTRADAY", orderType: "LIMIT", price: 118 });
  await clock.advance(1000); // past the paper order-rate window
  expect(r.order.status).toBe("open");
  return r.order.orderId;
}

describe("modify passes the per-order limits (paper)", () => {
  it("refuses a modify above the lot limit", async () => {
    const id = await restingOrder();
    const e = await reject(app.deps.orders.modify(ctx("paper"), id, { quantity: 20 * LOT }));
    expect(e.code).toBe("INVALID_ORDER");
    expect(all(e)).toMatch(/20 lots is above the per-order limit of 10 lots/);
    expect((await app.deps.paper.order("paper", id)).quantity).toBe(5 * LOT);
    await clock.advance(1000);
  });

  it("refuses a modify above the value limit (new quantity x new price)", async () => {
    const id = await restingOrder();
    const e = await reject(app.deps.orders.modify(ctx("paper"), id, { quantity: 8 * LOT }));
    expect(e.code).toBe("INVALID_ORDER");
    expect(e.detail).toMatch(/order value .* is above the per-order limit/);
    expect(all(e)).not.toMatch(/lots/);
    await clock.advance(1000);
    // A changed price alone is checked against the band too.
    const band = await reject(app.deps.orders.modify(ctx("paper"), id, { price: 130 }));
    expect(all(band)).toMatch(/away from the last traded price/);
    await clock.advance(1000);
  });

  it("accepts a modify within the limits", async () => {
    const id = await restingOrder();
    const out = await app.deps.orders.modify(ctx("paper"), id, { quantity: 7 * LOT, price: 118.5 });
    expect(out.order).toMatchObject({ quantity: 7 * LOT, price: 118.5 });
    await clock.advance(1000);
  });

  it("values a change to MARKET at the last price", async () => {
    const id = await restingOrder(7);
    // 7 lots x 120.5 (LTP) = ₹54,827.50, within ₹60,000; 8 lots x 120.5 = ₹62,660, above.
    const e = await reject(app.deps.orders.modify(ctx("paper"), id, { orderType: "MARKET", quantity: 8 * LOT }));
    expect(all(e)).toMatch(/order value ₹62,660/);
    await clock.advance(1000);
  });

  it("refuses a modify above the exchange freeze quantity (a change cannot be sliced)", async () => {
    const id = await restingOrder();
    const e = await reject(app.deps.orders.modify(ctx("paper"), id, { quantity: 1820 }));
    expect(e.code).toBe("INVALID_ORDER");
    expect(e.detail).toMatch(/freeze quantity 1800/);
    await clock.advance(1000);
  });

  it("the kill switch blocks a modify (cancels still pass)", async () => {
    const id = await restingOrder();
    await app.deps.safety.engageKillSwitch(ctx("paper"), { reason: "test" });
    try {
      const e = await reject(app.deps.orders.modify(ctx("paper"), id, { price: 118.5 }));
      expect(e.code).toBe("KILL_SWITCH_ACTIVE");
      expect((await app.deps.paper.order("paper", id)).price).toBe(118);
      await clock.advance(1000);
      expect((await app.deps.orders.cancel(ctx("paper"), id)).order.status).toBe("cancelled");
    } finally {
      await app.deps.safety.releaseKillSwitch(ctx("admin"), { confirm: "RELEASE" }).catch(() => {});
    }
  });
});
