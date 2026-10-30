/**
 * Convert Intraday ↔ carry (POST /v1/positions/convert) on the real OrderService, SafetyGuard and PaperEngine: the
 * quantity moves at its average price, a position held in the other product merges at the weighted average, and the
 * refusals (more than held, the opposite side, part lots, the kill switch, Intraday after the square-off, live) say why.
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
import { INSTRUMENTS, KEYS, PRICES } from "./__fixtures__/helpers.mjs";
import ordersModule from "./module.mjs";

const OPT = "NFO:NIFTY-2026-10-27-25000-CE"; // lot 65
const LOT = 65;
const log = createNullLogger();
const ctx = () => createCallContext({ source: "rest", key: KEYS.paper, log });
const cli = () => createCallContext({ source: "cli", principal: { kind: "local", id: "cli" }, log, scopes: ["admin", "live"] });
let app;
let clock;
let md;

const reject = async (p) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
};
const pos = async () => Object.fromEntries((await app.deps.orders.positions(ctx(), "paper")).items.filter((p) => p.symbol === OPT).map((p) => [p.product, p]));
async function trade(side, lots, product, price) {
  md.setPrice(OPT, price);
  await clock.advance(1000);
  const r = await app.deps.orders.place(ctx(), { account: "paper", symbol: OPT, side, quantity: lots * LOT, product, orderType: "MARKET" });
  await clock.advance(1000);
  return r.order;
}

beforeAll(async () => {
  const { config } = loadConfig({ raw: { server: { port: 0 }, dataDir: mkdtempSync(join(tmpdir(), "mcb-convert-")), accounts: [{ id: "paper", broker: "paper" }, { id: "dhan-main", broker: "dhan" }] }, env: {} });
  clock = createManualClock();
  md = createFakeMarketData({ prices: PRICES, clock });
  const accounts = createFakeAccountManager({ accounts: [{ id: "paper", broker: "paper" }, { id: "dhan-main", broker: "dhan" }] });
  app = await createApp({
    config,
    modules: [ordersModule, paperModule, safetyModule],
    logger: log,
    clock,
    overrides: { keyStore: notImplementedService("keyStore"), accounts, scheduler: createFakeScheduler(), symbols: createFakeSymbolService({ instruments: INSTRUMENTS }), marketData: md },
  });
});
afterAll(async () => app?.close());

describe("convert a position between products", () => {
  it("moves part of an Intraday position to carry at its average price, then merges at the weighted average", async () => {
    const o = await trade("BUY", 2, "INTRADAY", 120);
    expect(o.status).toBe("filled");
    const avg = (await pos()).INTRADAY.avgPrice;
    const out = await app.deps.orders.convertPosition(ctx(), { account: "paper", symbol: OPT, from: "INTRADAY", to: "MARGIN", lots: 1 });
    expect(out).toMatchObject({ mode: "paper", quantity: LOT, fromNetQty: LOT, toNetQty: LOT });
    let p = await pos();
    expect(p.INTRADAY).toMatchObject({ netQty: LOT, avgPrice: avg });
    expect(p.MARGIN).toMatchObject({ netQty: LOT, avgPrice: avg });
    // One more lot bought Intraday at a different price, converted: carry averages the two.
    await trade("BUY", 1, "INTRADAY", 130);
    const avg2 = (await pos()).INTRADAY.avgPrice;
    await app.deps.orders.convertPosition(ctx(), { account: "paper", symbol: OPT, from: "INTRADAY", to: "MARGIN", quantity: 2 * LOT });
    p = await pos();
    expect(p.INTRADAY.netQty).toBe(0);
    expect(p.MARGIN.netQty).toBe(3 * LOT);
    expect(p.MARGIN.avgPrice).toBeCloseTo((avg + 2 * avg2) / 3, 4);
  });

  it("refuses more than is held, part lots, the opposite side, and says why", async () => {
    expect((await reject(app.deps.orders.convertPosition(ctx(), { account: "paper", symbol: OPT, from: "MARGIN", to: "INTRADAY", lots: 9 }))).detail).toMatch(/Only 195 is held in MARGIN/);
    expect((await reject(app.deps.orders.convertPosition(ctx(), { account: "paper", symbol: OPT, from: "MARGIN", to: "INTRADAY", quantity: 10 }))).detail).toMatch(/whole number of lots \(lot 65\)/);
    await trade("SELL", 1, "INTRADAY", 125); // short 1 lot Intraday while long 3 lots carry
    expect((await reject(app.deps.orders.convertPosition(ctx(), { account: "paper", symbol: OPT, from: "MARGIN", to: "INTRADAY", lots: 1 }))).detail).toMatch(/on the other side; close it first/);
    expect((await reject(app.deps.orders.convertPosition(ctx(), { account: "paper", symbol: OPT, from: "MARGIN", to: "MARGIN", lots: 1 }))).code).toBe("VALIDATION_FAILED");
  });

  it("refuses a live account (convert at the broker) and while the kill switch is on", async () => {
    const live = await reject(app.deps.orders.convertPosition(createCallContext({ source: "rest", key: KEYS.live, log }), { account: "dhan-main", symbol: OPT, from: "INTRADAY", to: "MARGIN", lots: 1 }));
    expect(live.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(live.detail).toMatch(/Convert it in your broker's app/);
    await app.deps.safety.engageKillSwitch(cli(), { reason: "test" });
    const k = await reject(app.deps.orders.convertPosition(ctx(), { account: "paper", symbol: OPT, from: "MARGIN", to: "INTRADAY", lots: 1 }));
    expect(k.code).toBe("KILL_SWITCH_ACTIVE");
    await app.deps.safety.releaseKillSwitch(cli(), { confirm: "RELEASE" });
  });

  it("refuses a product the contract cannot be traded in (shares to MARGIN, F&O to CNC), as an order would be", async () => {
    md.setPrice("NSE:RELIANCE", 1400);
    await clock.advance(1000);
    await app.deps.orders.place(ctx(), { account: "paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 2, product: "INTRADAY", orderType: "MARKET" });
    await clock.advance(1000);
    const eq = await reject(app.deps.orders.convertPosition(ctx(), { account: "paper", symbol: "NSE:RELIANCE", from: "INTRADAY", to: "MARGIN", quantity: 2 }));
    expect(eq.code).toBe("INVALID_ORDER"); // the code an order with that product gets
    expect(eq.detail).toMatch(/MARGIN is the carry-forward product for futures and options\. Use CNC/);
    const shares = async (product) => (await app.deps.orders.positions(ctx(), "paper")).items.filter((p) => p.symbol === "NSE:RELIANCE" && p.product === product).reduce((n, p) => n + p.netQty, 0);
    expect(await shares("INTRADAY")).toBe(2);
    expect(await shares("MARGIN")).toBe(0);
    // Shares to CNC is fine.
    await app.deps.orders.convertPosition(ctx(), { account: "paper", symbol: "NSE:RELIANCE", from: "INTRADAY", to: "CNC", quantity: 2 });
    expect(await shares("CNC")).toBe(2);
    // An option to CNC is refused the same way.
    const before = await pos();
    const fno = await reject(app.deps.orders.convertPosition(ctx(), { account: "paper", symbol: OPT, from: "MARGIN", to: "CNC", lots: 1 }));
    expect(fno.code).toBe("INVALID_ORDER");
    expect(fno.detail).toMatch(/CNC is for cash-market shares/);
    expect(await pos()).toEqual(before);
  });

  it("refuses converting into Intraday after the square-off time", async () => {
    await trade("BUY", 1, "INTRADAY", 120); // flatten the Intraday short
    await clock.advance(6 * 3600_000); // 09:30 → 15:30 IST
    const e = await reject(app.deps.orders.convertPosition(ctx(), { account: "paper", symbol: OPT, from: "MARGIN", to: "INTRADAY", lots: 1 }));
    expect(e.detail).toMatch(/past the intraday square-off time/);
  });

  it("Day view: the next day a carried position starts from the previous close, and a conversion keeps the day's P&L whole", async () => {
    md.setPrice(OPT, 140);
    await pos(); // the last mark of the day: 140
    await clock.advance(18 * 3600_000); // the next day, 09:30 IST
    await app.deps.paper.runOnce();
    let p = await pos();
    expect(p.MARGIN).toMatchObject({ netQty: 3 * LOT, overnightQty: 3 * LOT, prevClose: 140, buyQty: 0, sellQty: 0 });
    md.setPrice(OPT, 150);
    await trade("BUY", 1, "INTRADAY", 150);
    p = await pos();
    const before = (p.MARGIN.dayPnl ?? 0) + (p.INTRADAY.dayPnl ?? 0);
    expect(p.MARGIN.dayPnl).toBeCloseTo((p.MARGIN.ltp - 140) * 3 * LOT, 6);
    expect(p.INTRADAY.dayPnl).toBeCloseTo((p.INTRADAY.ltp - 150) * LOT, 6);
    await app.deps.orders.convertPosition(ctx(), { account: "paper", symbol: OPT, from: "MARGIN", to: "INTRADAY", lots: 2 });
    p = await pos();
    expect(p.INTRADAY.overnightQty).toBe(2 * LOT);
    expect(p.MARGIN.overnightQty).toBe(LOT);
    expect(p.MARGIN.dayPnl + p.INTRADAY.dayPnl).toBeCloseTo(before, 6);
  });
});
