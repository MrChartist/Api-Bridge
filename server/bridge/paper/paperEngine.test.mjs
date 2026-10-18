/**
 * S8 PaperEngine: state machine, fills from market data and ticks, funds and margin, positions and P&L,
 * intraday square-off, session-end expiry, day roll, persistence and restart, ids, pagination and reset.
 *
 * Deterministic: a fake clock, fake timers, the published market-data and symbol fakes (no broker calls) and a real
 * file store in a temp directory.
 */
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SERVICE_CONTRACTS, assertService } from "../core/contracts.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { buildServices } from "../core/modules.mjs";
import { createFakeMarketData } from "../market/fake.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { paperConfig } from "./config.mjs";
import paperModule from "./module.mjs";
import { createPaperEngine } from "./paperEngine.mjs";

const at = (local) => Date.parse(`${local}+05:30`);
const IS_POSIX = process.platform !== "win32";

const RELIANCE = "NSE:RELIANCE";
const NIFTY_CE = "NFO:NIFTY-2026-10-27-25000-CE";
const NIFTY_FUT = "NFO:NIFTY-2026-10-27-FUT";
const CRUDE = "MCX:CRUDEOIL-2026-11-19-FUT";

function fakeTimers() {
  const handles = [];
  return {
    handles,
    setInterval(fn, ms) {
      const h = { fn, ms, cleared: false };
      handles.push(h);
      return h;
    },
    clearInterval(h) {
      h.cleared = true;
    },
  };
}

/**
 * A full engine over a temp dir. `rig.restart()` builds a new engine on the same dir, clock, bus and market data.
 */
function rig({ dir = mkdtempSync(join(tmpdir(), "mcb-paper-")), paper = {}, prices = { [RELIANCE]: 1400, [NIFTY_CE]: 120, [NIFTY_FUT]: 25_000, [CRUDE]: 6000 }, t0 = at("2026-10-19T10:00:00") } = {}) {
  const clock = { t: t0, now() { return this.t; } };
  const config = {
    accounts: [
      { id: "paper-1", broker: "paper" },
      { id: "paper-2", broker: "paper" },
      { id: "zerodha-main", broker: "zerodha" },
    ],
    paper: paperConfig(paper),
  };
  const bus = createEventBus();
  const events = [];
  const warnings = [];
  bus.on("order.updated", (e) => events.push(e));
  bus.on("config.warning", (e) => warnings.push(e.message));
  const md = createFakeMarketData({ prices, clock });
  const symbols = createFakeSymbolService();
  const timers = fakeTimers();
  const make = () => createPaperEngine({ config, logger: createNullLogger(), bus, clock, paths: { dataDir: dir }, marketData: md, symbols }, { timers });
  const r = { dir, clock, config, bus, events, warnings, md, symbols, timers, engine: make() };
  r.engine.start(); // as the module does at boot: restore books, listen to ticks, poll timer (fake)
  r.restart = ({ stopOld = true } = {}) => {
    if (stopOld) r.engine.stop();
    r.engine = make();
    r.engine.start();
    return r.engine;
  };
  r.advance = (ms) => {
    clock.t += ms;
  };
  r.tick = (symbol, ltp, extra = {}) => bus.emit("tick", { symbol, ltp, accountId: "zerodha-main", broker: "zerodha", receivedAt: clock.t, ...extra });
  return r;
}

const buy = (symbol, quantity, extra = {}) => ({ symbol, side: "BUY", quantity, product: "CNC", orderType: "MARKET", ...extra });
const sell = (symbol, quantity, extra = {}) => ({ symbol, side: "SELL", quantity, product: "CNC", orderType: "MARKET", ...extra });

async function codeOf(promise) {
  try {
    await promise;
  } catch (err) {
    return err.code;
  }
  return "no error";
}

describe("contract", () => {
  it("satisfies SERVICE_CONTRACTS.paper and builds through the module with only its declared deps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-paper-mod-"));
    const config = { accounts: [{ id: "paper-1", broker: "paper" }], paper: paperConfig({}), dataDir: dir };
    const clock = { now: () => at("2026-10-19T10:00:00") };
    const deps = await buildServices(
      { config, logger: createNullLogger(), bus: createEventBus(), clock, paths: { dataDir: dir }, brokers: {} },
      [paperModule],
      { marketData: createFakeMarketData({ prices: { [RELIANCE]: 1400 }, clock }), symbols: createFakeSymbolService() },
    );
    assertService("paper", deps.paper);
    expect(SERVICE_CONTRACTS.paper.methods.every((m) => typeof deps.paper[m] === "function")).toBe(true);
    const o = await deps.paper.place("paper-1", buy(RELIANCE, 1));
    expect(o.status).toBe("filled");
  });

  it("returns OrderResult-shaped orders with PAPER- ids and mode paper", async () => {
    const { engine } = rig();
    const o = await engine.place("paper-1", buy(RELIANCE, 2, { clientOrderId: "c-1", tag: "t1", source: "webhook" }));
    expect(o).toMatchObject({
      orderId: expect.stringMatching(/^PAPER-20261019-\d{6}$/),
      clientOrderId: "c-1",
      accountId: "paper-1",
      broker: "paper",
      mode: "paper",
      symbol: RELIANCE,
      side: "BUY",
      quantity: 2,
      filledQuantity: 2,
      orderType: "MARKET",
      product: "CNC",
      validity: "DAY",
      status: "filled",
      brokerStatus: null,
      source: "webhook",
      tag: "t1",
      placedAt: "2026-10-19T10:00:00.000+05:30",
    });
    expect(o.legs).toEqual([{ brokerOrderId: null, quantity: 2, status: "filled", error: null }]);
  });

  it("refuses unknown and malformed account ids", async () => {
    const { engine } = rig();
    expect(await codeOf(engine.funds("nobody"))).toBe("ACCOUNT_NOT_FOUND");
    expect(await codeOf(engine.funds("../etc"))).toBe("ACCOUNT_NOT_FOUND");
    expect(await codeOf(engine.place("Paper 1", buy(RELIANCE, 1)))).toBe("ACCOUNT_NOT_FOUND");
  });

  it("uses order.resolved without asking the symbol service", async () => {
    const r = rig();
    const resolved = await r.symbols.resolve(RELIANCE);
    r.symbols.calls.length = 0;
    await r.engine.place("paper-1", { ...buy(RELIANCE, 1), resolved });
    expect(r.symbols.calls.filter(([m]) => m === "resolve")).toEqual([]);
  });

  it("works for a live-broker account id in paper mode", async () => {
    const { engine } = rig();
    expect((await engine.place("zerodha-main", buy(RELIANCE, 1))).status).toBe("filled");
  });
});

describe("MARKET fills", () => {
  it("fill at the opposite best price from depth", async () => {
    const r = rig();
    r.md.setDepth(RELIANCE, { bids: [{ price: 1399.5, qty: 10 }], asks: [{ price: 1400.4, qty: 10 }] });
    expect((await r.engine.place("paper-1", buy(RELIANCE, 5))).avgPrice).toBe(1400.4);
    expect((await r.engine.place("paper-1", sell(RELIANCE, 5))).avgPrice).toBe(1399.5);
  });

  it("fall back to LTP ± slippage when depth is off or unavailable", async () => {
    const r = rig({ paper: { useDepth: false } });
    expect((await r.engine.place("paper-1", buy(RELIANCE, 5))).avgPrice).toBe(1400.7); // 1400 * 1.0005, tick 0.1
    expect((await r.engine.place("paper-1", sell(RELIANCE, 5))).avgPrice).toBe(1399.3);
    expect(r.md.calls.some(([m]) => m === "depth")).toBe(false);
  });

  it("are rejected when there is no price", async () => {
    const r = rig();
    r.md.fail(RELIANCE, "UPSTREAM_ERROR");
    const o = await r.engine.place("paper-1", buy(RELIANCE, 1));
    expect(o.status).toBe("rejected");
    expect(o.statusMessage).toMatch(/No market price/);
    expect(o.legs[0].error.code).toBe("PAPER_REJECTED");
  });

  it("never fill on a stale-labelled cached price, and never reuse it as fresh", async () => {
    const r = rig();
    const asOf = new Date(r.clock.t - 120_000).toISOString();
    r.md.ltp = async (symbols) => ({ items: symbols.map((symbol) => ({ symbol, ltp: 1300, freshness: { source: "cache", asOf, ageMs: 120_000, stale: true, accountId: null, broker: null } })), errors: [] });
    const o = await r.engine.place("paper-1", buy(RELIANCE, 1));
    expect(o.status).toBe("rejected");
    expect(o.statusMessage).toMatch(/No market price/);
    // A second order straight after must not pick the old price up from the engine's own price memory.
    const o2 = await r.engine.place("paper-1", buy(RELIANCE, 1));
    expect(o2.status).toBe("rejected");
  });

  it("ask market data for fresh prices with interactive priority", async () => {
    const r = rig();
    await r.engine.place("paper-1", buy(RELIANCE, 1));
    const ltpCall = r.md.calls.find(([m]) => m === "ltp");
    expect(ltpCall[1]).toEqual([RELIANCE]);
    expect(ltpCall[2]).toMatchObject({ maxAgeMs: 1000, priority: "interactive" });
  });
});

describe("LIMIT, SL and SL-M state machine", () => {
  it("LIMIT waits open, then fills at the limit on a crossing tick", async () => {
    const r = rig();
    const o = await r.engine.place("paper-1", buy(RELIANCE, 10, { orderType: "LIMIT", price: 1390 }));
    expect(o.status).toBe("open");
    r.tick(RELIANCE, 1391);
    expect((await r.engine.order("paper-1", o.orderId)).status).toBe("open");
    r.tick(RELIANCE, 1388.5);
    const f = await r.engine.order("paper-1", o.orderId);
    expect(f).toMatchObject({ status: "filled", avgPrice: 1390, filledQuantity: 10 });
    expect(r.events.filter((e) => e.orderId === o.orderId).map((e) => e.status)).toEqual(["open", "filled"]);
    expect(r.events.every((e) => e.mode === "paper")).toBe(true);
  });

  it("a marketable LIMIT fills at once at the better price", async () => {
    const r = rig();
    const o = await r.engine.place("paper-1", buy(RELIANCE, 1, { orderType: "LIMIT", price: 1410 }));
    expect(o).toMatchObject({ status: "filled", avgPrice: 1400 });
  });

  it("IOC LIMIT that cannot match is cancelled", async () => {
    const r = rig();
    const o = await r.engine.place("paper-1", buy(RELIANCE, 1, { orderType: "LIMIT", price: 1300, validity: "IOC" }));
    expect(o.status).toBe("cancelled");
    expect(o.statusMessage).toMatch(/IOC/);
  });

  it("SL-M sell waits in trigger_pending and fills like MARKET once triggered", async () => {
    const r = rig({ paper: { useDepth: false } });
    await r.engine.place("paper-1", buy(RELIANCE, 10));
    const sl = await r.engine.place("paper-1", sell(RELIANCE, 10, { orderType: "SL-M", triggerPrice: 1380 }));
    expect(sl.status).toBe("trigger_pending");
    r.tick(RELIANCE, 1385);
    expect((await r.engine.order("paper-1", sl.orderId)).status).toBe("trigger_pending");
    r.tick(RELIANCE, 1379, { bid: 1378.9, ask: 1379.1 });
    expect(await r.engine.order("paper-1", sl.orderId)).toMatchObject({ status: "filled", avgPrice: 1378.9 });
  });

  it("SL buy triggers into an open limit, then fills when the limit is crossed", async () => {
    const r = rig();
    const o = await r.engine.place("paper-1", { ...buy(RELIANCE, 1), product: "INTRADAY", orderType: "SL", triggerPrice: 1410, price: 1412 });
    expect(o.status).toBe("trigger_pending");
    r.tick(RELIANCE, 1415);
    expect(await r.engine.order("paper-1", o.orderId)).toMatchObject({ status: "open", statusMessage: expect.stringMatching(/Trigger/) });
    r.tick(RELIANCE, 1411);
    expect(await r.engine.order("paper-1", o.orderId)).toMatchObject({ status: "filled", avgPrice: 1412 });
    expect(r.events.filter((e) => e.orderId === o.orderId).map((e) => e.status)).toEqual(["trigger_pending", "open", "filled"]);
  });

  it("a stop whose trigger is already crossed is rejected", async () => {
    const r = rig();
    const o = await r.engine.place("paper-1", { ...buy(RELIANCE, 1), product: "INTRADAY", orderType: "SL-M", triggerPrice: 1390 });
    expect(o.status).toBe("rejected");
    expect(o.statusMessage).toMatch(/above the last traded price \(1400\)/);
  });

  it("structural problems throw and create no order", async () => {
    const r = rig();
    expect(await codeOf(r.engine.place("paper-1", { ...buy(RELIANCE, 1), orderType: "LIMIT" }))).toBe("INVALID_ORDER");
    expect(await codeOf(r.engine.place("paper-1", { ...buy(RELIANCE, 1), orderType: "SL", price: 1400, triggerPrice: 1405 }))).toBe("INVALID_ORDER");
    expect(await codeOf(r.engine.place("paper-1", { ...buy(RELIANCE, 1), orderType: "LIMIT", price: 1400.05 }))).toBe("INVALID_ORDER"); // tick 0.1
    expect(await codeOf(r.engine.place("paper-1", { ...buy(NIFTY_CE, 50), product: "MARGIN" }))).toBe("INVALID_ORDER"); // lot 65
    expect(await codeOf(r.engine.place("paper-1", buy(RELIANCE, 0)))).toBe("INVALID_ORDER");
    expect(await codeOf(r.engine.place("paper-1", { ...buy(RELIANCE, 1), side: "HOLD" }))).toBe("VALIDATION_FAILED");
    expect(await codeOf(r.engine.place("paper-1", { ...buy(RELIANCE, 1), product: "NRML" }))).toBe("VALIDATION_FAILED");
    expect(await codeOf(r.engine.place("paper-1", { ...buy(RELIANCE, 1), validity: "GTC" }))).toBe("VALIDATION_FAILED");
    expect((await r.engine.orders("paper-1")).items).toEqual([]);
  });

  it("accepts lots as an alternative to quantity", async () => {
    const r = rig();
    const o = await r.engine.place("paper-1", { symbol: NIFTY_CE, side: "BUY", lots: 2, product: "MARGIN", orderType: "MARKET" });
    expect(o.quantity).toBe(130);
  });
});

describe("cancel and modify", () => {
  let r;
  let o;
  beforeEach(async () => {
    r = rig();
    o = await r.engine.place("paper-1", { ...buy(RELIANCE, 10), orderType: "LIMIT", price: 1390 });
  });

  it("cancels a pending order once", async () => {
    expect((await r.engine.cancel("paper-1", o.orderId)).status).toBe("cancelled");
    expect(await codeOf(r.engine.cancel("paper-1", o.orderId))).toBe("INVALID_ORDER");
    expect(await codeOf(r.engine.cancel("paper-1", "PAPER-20261019-999999"))).toBe("ORDER_NOT_FOUND");
    expect(await r.engine.order("paper-1", "PAPER-20261019-999999")).toBeNull();
  });

  it("orders are scoped to their account", async () => {
    expect(await codeOf(r.engine.cancel("paper-2", o.orderId))).toBe("ORDER_NOT_FOUND");
  });

  it("modifies price and quantity, and a marketable change fills at once", async () => {
    const m = await r.engine.modify("paper-1", o.orderId, { price: 1395, quantity: 20 });
    expect(m).toMatchObject({ status: "open", price: 1395, quantity: 20, statusMessage: "Modified." });
    const f = await r.engine.modify("paper-1", o.orderId, { price: 1405 });
    expect(f).toMatchObject({ status: "filled", avgPrice: 1400 });
    expect(await codeOf(r.engine.modify("paper-1", o.orderId, { price: 1390 }))).toBe("INVALID_ORDER");
  });

  it("modifies to MARKET (fills) and to SL (trigger_pending)", async () => {
    const s = await r.engine.modify("paper-1", o.orderId, { orderType: "SL", triggerPrice: 1410, price: 1411 });
    expect(s).toMatchObject({ status: "trigger_pending", orderType: "SL", triggerPrice: 1410, price: 1411 });
    const m = await r.engine.modify("paper-1", o.orderId, { orderType: "MARKET" });
    expect(m).toMatchObject({ status: "filled", orderType: "MARKET", price: null, triggerPrice: null });
  });

  it("refuses bad modifications", async () => {
    expect(await codeOf(r.engine.modify("paper-1", o.orderId, { side: "SELL" }))).toBe("VALIDATION_FAILED");
    expect(await codeOf(r.engine.modify("paper-1", o.orderId, { orderType: "STOP" }))).toBe("VALIDATION_FAILED");
    expect(await codeOf(r.engine.modify("paper-1", o.orderId, { quantity: -1 }))).toBe("INVALID_ORDER");
    expect(await codeOf(r.engine.modify("paper-1", o.orderId, { orderType: "SL-M", triggerPrice: 1390 }))).toBe("INVALID_ORDER"); // already crossed
    expect(await codeOf(r.engine.modify("paper-1", o.orderId, { quantity: 100_000 }))).toBe("INVALID_ORDER"); // funds
    expect((await r.engine.order("paper-1", o.orderId)).price).toBe(1390); // unchanged
  });
});

describe("funds and margin", () => {
  it("starts at ₹10,00,000 and blocks margin for pending orders and positions", async () => {
    const r = rig();
    expect(await r.engine.funds("paper-1")).toMatchObject({ availableCash: 1_000_000, usedMargin: 0, totalBalance: 1_000_000, realisedPnl: 0, unrealisedPnl: 0 });
    await r.engine.place("paper-1", { ...buy(RELIANCE, 100), orderType: "LIMIT", price: 1390 });
    expect(await r.engine.funds("paper-1")).toMatchObject({ usedMargin: 139_000, availableCash: 861_000 });
    await r.engine.place("paper-1", { ...buy(NIFTY_CE, 65), product: "MARGIN" }); // fake depth = LTP 120 -> premium 7800
    expect((await r.engine.funds("paper-1")).usedMargin).toBe(146_800);
  });

  it("rejects an order that needs more than is available", async () => {
    const r = rig();
    const o = await r.engine.place("paper-1", buy(RELIANCE, 1000)); // ₹14 lakh
    expect(o.status).toBe("rejected");
    expect(o.statusMessage).toMatch(/Insufficient paper funds.*₹14,00,000.*₹10,00,000/);
    expect((await r.engine.account("paper-1")).ordersToday).toBe(1);
  });

  it("closing quantity needs no extra margin", async () => {
    const r = rig({ paper: { startingCapital: 15_000 } });
    expect((await r.engine.place("paper-1", buy(RELIANCE, 10))).status).toBe("filled"); // 14,000
    expect((await r.engine.place("paper-1", sell(RELIANCE, 10, { orderType: "LIMIT", price: 1500 }))).status).toBe("open");
  });

  it("approximates futures and option-writing margin as configured", async () => {
    const r = rig({ paper: { margin: { futuresPct: 10, optionSellPct: 12 } } });
    await r.engine.place("paper-1", { symbol: NIFTY_FUT, side: "SELL", quantity: 65, product: "MARGIN", orderType: "MARKET" });
    expect((await r.engine.funds("paper-1")).usedMargin).toBe(162_500); // 65 * 25000 * 10%
    await r.engine.place("paper-1", { symbol: NIFTY_CE, side: "SELL", quantity: 65, product: "MARGIN", orderType: "MARKET" });
    expect((await r.engine.funds("paper-1")).usedMargin).toBe(162_500 + 195_000); // 65 * 25000 * 12%
  });

  it("applies the brokerage model to cash and totals", async () => {
    const r = rig({ paper: { brokerage: { perOrder: 20 } } });
    await r.engine.place("paper-1", buy(RELIANCE, 10));
    await r.engine.place("paper-1", sell(RELIANCE, 10));
    const f = await r.engine.funds("paper-1");
    expect(f.charges).toBe(40);
    expect(f.availableCash).toBe(1_000_000 - 40);
    const trades = (await r.engine.trades("paper-1")).items;
    expect(trades.map((t) => t.charges)).toEqual([20, 20]);
  });
});

describe("product rules", () => {
  it("refuses CNC short selling, delivery products on F&O and index orders", async () => {
    const r = rig();
    expect((await r.engine.place("paper-1", sell(RELIANCE, 1))).statusMessage).toMatch(/Not enough CNC quantity/);
    expect((await r.engine.place("paper-1", buy(NIFTY_CE, 65))).statusMessage).toMatch(/CNC is for equity delivery/);
    expect((await r.engine.place("paper-1", buy("NSE:NIFTY", 1, { orderType: "LIMIT", price: 25000 }))).statusMessage).toMatch(/index cannot be traded/);
  });

  it("counts pending CNC sells against holdings", async () => {
    const r = rig();
    await r.engine.place("paper-1", buy(RELIANCE, 10));
    expect((await r.engine.place("paper-1", sell(RELIANCE, 6, { orderType: "LIMIT", price: 1500 }))).status).toBe("open");
    expect((await r.engine.place("paper-1", sell(RELIANCE, 6, { orderType: "LIMIT", price: 1500 }))).status).toBe("rejected");
  });

  it("allows intraday short selling", async () => {
    const r = rig();
    expect((await r.engine.place("paper-1", { ...sell(RELIANCE, 10), product: "INTRADAY" })).status).toBe("filled");
    const [p] = await r.engine.positions("paper-1");
    expect(p).toMatchObject({ netQty: -10, product: "INTRADAY" });
  });
});

describe("positions and P&L", () => {
  it("tracks average price, realised and unrealised P&L", async () => {
    const r = rig();
    await r.engine.place("paper-1", buy(RELIANCE, 10)); // 1400
    r.md.setPrice(RELIANCE, 1410);
    r.advance(5000);
    await r.engine.place("paper-1", buy(RELIANCE, 30)); // 1410 -> avg 1407.5
    await r.engine.place("paper-1", sell(RELIANCE, 20, { orderType: "LIMIT", price: 1400 })); // marketable: 1410
    r.md.setPrice(RELIANCE, 1420);
    r.advance(5000);
    const [p] = await r.engine.positions("paper-1");
    expect(p).toMatchObject({ symbol: RELIANCE, product: "CNC", netQty: 20, avgPrice: 1407.5, ltp: 1420, realisedPnl: 50, unrealisedPnl: 250, pnl: 300, buyQty: 40, sellQty: 20, buyAvg: 1407.5, sellAvg: 1410 });
    const f = await r.engine.funds("paper-1");
    expect(f).toMatchObject({ realisedPnl: 50, unrealisedPnl: 250, totalBalance: 1_000_300, usedMargin: 28_150 });
  });

  it("P&L reconciles with trades over a long random sequence", async () => {
    const r = rig({ paper: { useDepth: false, startingCapital: 1_000_000_000 } });
    let seed = 42;
    const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    const book = [
      { symbol: RELIANCE, product: "INTRADAY", lot: 1, tick: 0.1, base: 1400 },
      { symbol: NIFTY_FUT, product: "MARGIN", lot: 65, tick: 0.1, base: 25_000 },
      { symbol: NIFTY_CE, product: "MARGIN", lot: 65, tick: 0.05, base: 120 },
    ];
    for (let i = 0; i < 150; i += 1) {
      const ins = book[Math.floor(rand() * book.length)];
      const px = Math.round((ins.base * (0.9 + rand() * 0.2)) / ins.tick) * ins.tick;
      r.md.setPrice(ins.symbol, Number(px.toFixed(2)));
      r.advance(1500);
      const side = rand() < 0.5 ? "BUY" : "SELL";
      await r.engine.place("paper-1", { symbol: ins.symbol, side, quantity: ins.lot * (1 + Math.floor(rand() * 5)), product: ins.product, orderType: "MARKET" });
    }
    const trades = (await r.engine.trades("paper-1", { limit: 500 })).items;
    expect(trades.length).toBe(150);
    const positions = await r.engine.positions("paper-1");
    const funds = await r.engine.funds("paper-1");
    // Cash-flow identity: realised + unrealised = sells - buys + net quantity marked at LTP.
    let cash = 0;
    for (const t of trades) cash += (t.side === "SELL" ? 1 : -1) * t.qty * t.price;
    const marked = positions.reduce((s, p) => s + p.netQty * (p.ltp ?? 0), 0);
    expect(funds.realisedPnl + funds.unrealisedPnl).toBeCloseTo(cash + marked, 1);
    // Per position the same identity holds, and quantities add up.
    for (const p of positions) {
      const mine = trades.filter((t) => t.symbol === p.symbol && t.product === p.product);
      const net = mine.reduce((s, t) => s + (t.side === "BUY" ? t.qty : -t.qty), 0);
      expect(p.netQty).toBe(net);
      const c = mine.reduce((s, t) => s + (t.side === "SELL" ? 1 : -1) * t.qty * t.price, 0);
      expect(p.realisedPnl + p.unrealisedPnl).toBeCloseTo(c + p.netQty * p.ltp, 1);
    }
    expect(funds.realisedPnl).toBeCloseTo(positions.reduce((s, p) => s + p.realisedPnl, 0), 1);
  });
});

describe("time-based behaviour (fake clock)", () => {
  it("squares off intraday positions and pending intraday orders at 15:20 IST, and refuses new ones after", async () => {
    const r = rig({ t0: at("2026-10-19T15:10:00"), paper: { useDepth: false } });
    await r.engine.place("paper-1", { ...buy(RELIANCE, 10), product: "INTRADAY" });
    await r.engine.place("paper-1", buy(RELIANCE, 5)); // CNC stays
    const pending = await r.engine.place("paper-1", { ...buy(RELIANCE, 1), product: "INTRADAY", orderType: "LIMIT", price: 1300 });
    r.clock.t = at("2026-10-19T15:19:59");
    await r.engine.runOnce();
    expect((await r.engine.positions("paper-1")).find((p) => p.product === "INTRADAY").netQty).toBe(10);
    r.md.setPrice(RELIANCE, 1410);
    r.clock.t = at("2026-10-19T15:20:05"); // the 15:19:59 price is now older than the poll interval
    await r.engine.runOnce();
    const positions = await r.engine.positions("paper-1");
    expect(positions.find((p) => p.product === "INTRADAY")).toMatchObject({ netQty: 0, realisedPnl: expect.any(Number) });
    expect(positions.find((p) => p.product === "CNC").netQty).toBe(5);
    expect((await r.engine.order("paper-1", pending.orderId)).status).toBe("cancelled");
    const squareOff = (await r.engine.orders("paper-1", { limit: 1 })).items[0];
    expect(squareOff).toMatchObject({ tag: "square-off", source: "system", orderType: "MARKET", side: "SELL", quantity: 10, status: "filled", avgPrice: 1409.2 });
    const late = await r.engine.place("paper-1", { ...buy(RELIANCE, 1), product: "INTRADAY" });
    expect(late.statusMessage).toMatch(/after the 15:20 IST square-off/);
    // Running again changes nothing.
    const n = r.events.length;
    await r.engine.runOnce();
    expect(r.events.length).toBe(n);
  });

  it("uses per-exchange square-off times (MCX later) and honours config overrides", async () => {
    const r = rig({ t0: at("2026-10-19T15:00:00"), paper: { squareOff: { times: { NSE: "15:15" } } } });
    await r.engine.place("paper-1", { symbol: CRUDE, side: "BUY", quantity: 100, product: "INTRADAY", orderType: "MARKET" });
    await r.engine.place("paper-1", { ...buy(RELIANCE, 1), product: "INTRADAY" });
    r.clock.t = at("2026-10-19T15:16:00");
    await r.engine.runOnce();
    const pos = await r.engine.positions("paper-1");
    expect(pos.find((p) => p.symbol === RELIANCE).netQty).toBe(0);
    expect(pos.find((p) => p.symbol === CRUDE).netQty).toBe(100);
    r.clock.t = at("2026-10-19T23:00:00");
    await r.engine.runOnce();
    expect((await r.engine.positions("paper-1")).find((p) => p.symbol === CRUDE).netQty).toBe(0);
  });

  it("square-off can be switched off", async () => {
    const r = rig({ t0: at("2026-10-19T15:25:00"), paper: { squareOff: { enabled: false } } });
    expect((await r.engine.place("paper-1", { ...buy(RELIANCE, 1), product: "INTRADAY" })).status).toBe("filled");
    await r.engine.runOnce();
    expect((await r.engine.positions("paper-1"))[0].netQty).toBe(1);
  });

  it("expires pending DAY orders at the session end", async () => {
    const r = rig({ t0: at("2026-10-19T15:00:00") });
    const o = await r.engine.place("paper-1", { ...buy(RELIANCE, 1), product: "CNC", orderType: "LIMIT", price: 1300 });
    r.clock.t = at("2026-10-19T15:29:00");
    await r.engine.runOnce();
    expect((await r.engine.order("paper-1", o.orderId)).status).toBe("open");
    r.clock.t = at("2026-10-19T15:30:00");
    await r.engine.runOnce();
    expect(await r.engine.order("paper-1", o.orderId)).toMatchObject({ status: "expired", statusMessage: expect.stringMatching(/session/) });
  });

  it("rolls the day: expires leftovers, resets the counters, drops flat positions and keeps carried ones", async () => {
    const r = rig({ t0: at("2026-10-19T11:00:00") });
    await r.engine.place("paper-1", buy(RELIANCE, 10));
    await r.engine.place("paper-1", { symbol: NIFTY_FUT, side: "BUY", quantity: 65, product: "MARGIN", orderType: "MARKET" });
    await r.engine.place("paper-1", { symbol: NIFTY_FUT, side: "SELL", quantity: 65, product: "MARGIN", orderType: "MARKET" });
    const o = await r.engine.place("paper-1", { ...buy(RELIANCE, 1), orderType: "LIMIT", price: 1300 });
    expect((await r.engine.account("paper-1")).ordersToday).toBe(4);
    r.clock.t = at("2026-10-20T09:00:00");
    expect((await r.engine.order("paper-1", o.orderId)).status).toBe("expired");
    expect((await r.engine.account("paper-1")).ordersToday).toBe(0);
    const positions = await r.engine.positions("paper-1");
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ symbol: RELIANCE, netQty: 10, buyQty: 0, realisedPnl: 0 });
    const next = await r.engine.place("paper-1", buy(RELIANCE, 1));
    expect(next.orderId).toBe("PAPER-20261020-000001");
  });

  it("squares off an intraday position left over from an earlier day", async () => {
    const r = rig({ t0: at("2026-10-19T14:00:00") });
    await r.engine.place("paper-1", { ...buy(RELIANCE, 3), product: "INTRADAY" });
    r.clock.t = at("2026-10-20T09:20:00");
    const e2 = r.restart();
    await e2.runOnce();
    expect((await e2.positions("paper-1"))[0].netQty).toBe(0);
  });

  it("re-prices pending orders by polling when no ticks arrive", async () => {
    const r = rig();
    const o = await r.engine.place("paper-1", { ...buy(RELIANCE, 1), orderType: "LIMIT", price: 1390 });
    r.md.setPrice(RELIANCE, 1385);
    r.advance(1000);
    await r.engine.runOnce();
    expect((await r.engine.order("paper-1", o.orderId)).status).toBe("open"); // price still fresh
    r.advance(1000);
    r.md.calls.length = 0;
    await r.engine.runOnce();
    expect((await r.engine.order("paper-1", o.orderId)).status).toBe("filled");
    expect(r.md.calls[0]).toEqual(["ltp", [RELIANCE], { maxAgeMs: 2000, priority: "interactive" }]);
  });

  it("start() is idempotent, polls on the configured interval, and stop() unhooks ticks and timers", async () => {
    const r = rig({ paper: { pollIntervalMs: 500 } });
    r.engine.start();
    expect(r.timers.handles).toHaveLength(1);
    expect(r.timers.handles[0].ms).toBe(500);
    expect(r.bus.listenerCount("tick")).toBe(1);
    r.engine.stop();
    expect(r.timers.handles[0].cleared).toBe(true);
    expect(r.bus.listenerCount("tick")).toBe(0);
  });

  it("ignores ticks for symbols no book cares about", async () => {
    const r = rig();
    r.tick("NSE:INFY", 1500);
    const o = await r.engine.place("paper-1", { ...buy(RELIANCE, 1), orderType: "LIMIT", price: 1390 });
    r.tick("NSE:INFY", 1);
    expect((await r.engine.order("paper-1", o.orderId)).status).toBe("open");
  });
});

describe("persistence", () => {
  it("restores orders, positions, funds and pending orders after a restart", async () => {
    const r = rig();
    await r.engine.place("paper-1", buy(RELIANCE, 10));
    await r.engine.place("paper-2", { symbol: NIFTY_CE, side: "BUY", quantity: 65, product: "MARGIN", orderType: "MARKET" });
    const pending = await r.engine.place("paper-1", sell(RELIANCE, 10, { orderType: "LIMIT", price: 1450 }));
    const before = {
      orders: await r.engine.orders("paper-1"),
      positions: await r.engine.positions("paper-1"),
      funds1: await r.engine.funds("paper-1"),
      funds2: await r.engine.funds("paper-2"),
      account: await r.engine.account("paper-1"),
    };
    const e2 = r.restart();
    expect(await e2.orders("paper-1")).toEqual(before.orders);
    expect(await e2.positions("paper-1")).toEqual(before.positions);
    expect(await e2.funds("paper-1")).toEqual(before.funds1);
    expect(await e2.funds("paper-2")).toEqual(before.funds2);
    expect(await e2.account("paper-1")).toEqual(before.account);
    // The restored pending order still fills on a tick, and ids keep counting.
    r.tick(RELIANCE, 1451);
    expect((await e2.order("paper-1", pending.orderId)).status).toBe("filled");
    expect((await e2.place("paper-1", buy(RELIANCE, 1))).orderId).toBe("PAPER-20261019-000004");
  });

  it("start() restores saved books so pending orders fill on ticks before any API call", async () => {
    const r = rig();
    const pending = await r.engine.place("paper-2", sell(RELIANCE, 1, { orderType: "LIMIT", price: 1450, product: "INTRADAY" }));
    r.restart();
    r.tick(RELIANCE, 1460);
    const saved = JSON.parse(readFileSync(join(r.dir, "paper", "paper-2.json"), "utf8"));
    expect(saved.orders.find((o) => o.orderId === pending.orderId).status).toBe("filled");
    // Accounts never used get no file.
    expect(readdirSync(join(r.dir, "paper")).sort()).toEqual(["_ids.json", "paper-2.json"]);
  });

  it("keeps the last price of open positions across a restart", async () => {
    const r = rig();
    await r.engine.place("paper-1", buy(RELIANCE, 10));
    r.md.setPrice(RELIANCE, 1420);
    r.advance(3000);
    expect((await r.engine.funds("paper-1")).unrealisedPnl).toBe(200);
    const e2 = r.restart();
    r.md.fail(RELIANCE, "BROKER_UNAVAILABLE");
    r.advance(3000);
    expect((await e2.funds("paper-1")).unrealisedPnl).toBe(200);
  });

  it("writes private files atomically with no temp files left", async () => {
    const r = rig();
    await r.engine.place("paper-1", buy(RELIANCE, 1));
    const dir = join(r.dir, "paper");
    const files = readdirSync(dir).sort();
    expect(files).toEqual(["_ids.json", "paper-1.json"]);
    if (IS_POSIX) {
      expect(statSync(join(dir, "paper-1.json")).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    const saved = JSON.parse(readFileSync(join(dir, "paper-1.json"), "utf8"));
    expect(saved).toMatchObject({ v: 1, accountId: "paper-1", startingCapital: 1_000_000 });
  });

  it("moves a corrupt state file aside, warns and starts a fresh book", async () => {
    const r = rig();
    await r.engine.place("paper-1", buy(RELIANCE, 1));
    r.engine.stop(); // its final save happens before the file is damaged
    writeFileSync(join(r.dir, "paper", "paper-1.json"), "{not json");
    const e2 = r.restart({ stopOld: false });
    expect((await e2.funds("paper-1")).availableCash).toBe(1_000_000);
    expect(r.warnings.some((w) => /could not be read and was moved aside/.test(w))).toBe(true);
    expect(readdirSync(join(r.dir, "paper")).some((f) => /^paper-1\.json\.corrupt-\d+$/.test(f))).toBe(true);
  });

  it("ids are unique across accounts and restart per IST day", async () => {
    const r = rig();
    const a = await r.engine.place("paper-1", buy(RELIANCE, 1));
    const b = await r.engine.place("paper-2", buy(RELIANCE, 1));
    expect([a.orderId, b.orderId]).toEqual(["PAPER-20261019-000001", "PAPER-20261019-000002"]);
    r.clock.t = at("2026-10-20T00:00:01");
    expect((await r.engine.place("paper-2", buy(RELIANCE, 1, { orderType: "LIMIT", price: 1300 }))).orderId).toBe("PAPER-20261020-000001");
  });

  it("caps finished history and keeps pending orders", async () => {
    const r = rig({ paper: { historyLimit: 50 } });
    const keep = await r.engine.place("paper-1", { ...buy(RELIANCE, 1), orderType: "LIMIT", price: 1000 });
    for (let i = 0; i < 60; i += 1) await r.engine.place("paper-1", buy(RELIANCE, 1));
    const all = (await r.engine.orders("paper-1", { limit: 500 })).items;
    expect(all).toHaveLength(51);
    expect(all.some((o) => o.orderId === keep.orderId)).toBe(true);
    expect((await r.engine.trades("paper-1", { limit: 500 })).items).toHaveLength(50);
  });
});

describe("listing and reset", () => {
  it("pages newest first with opaque cursors and filters by status", async () => {
    const r = rig();
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push((await r.engine.place("paper-1", buy(RELIANCE, 1))).orderId);
    const open = await r.engine.place("paper-1", { ...buy(RELIANCE, 1), orderType: "LIMIT", price: 1000 });
    const p1 = await r.engine.orders("paper-1", { limit: 4 });
    expect(p1.items.map((o) => o.orderId)).toEqual([open.orderId, ...ids.slice(2).reverse()]);
    const p2 = await r.engine.orders("paper-1", { limit: 4, cursor: p1.nextCursor });
    expect(p2.items.map((o) => o.orderId)).toEqual(ids.slice(0, 2).reverse());
    expect(p2.nextCursor).toBeNull();
    expect((await r.engine.orders("paper-1", { status: "open" })).items.map((o) => o.orderId)).toEqual([open.orderId]);
    expect(await codeOf(r.engine.orders("paper-1", { status: "done" }))).toBe("VALIDATION_FAILED");
    expect(await codeOf(r.engine.orders("paper-1", { cursor: "nonsense!" }))).toBe("VALIDATION_FAILED");
    expect(await codeOf(r.engine.orders("paper-1", { limit: 0 }))).toBe("VALIDATION_FAILED");
    const t = await r.engine.trades("paper-1", { limit: 2 });
    expect(t.items[0]).toMatchObject({ tradeId: `${ids[4]}-T1`, orderId: ids[4], mode: "paper", qty: 1, tradedAt: expect.stringMatching(/\+05:30$/) });
    expect(t.nextCursor).not.toBeNull();
  });

  it("reset cancels pending orders (with events), clears the book and sets new capital", async () => {
    const r = rig();
    await r.engine.place("paper-1", buy(RELIANCE, 10));
    const o = await r.engine.place("paper-1", { ...buy(RELIANCE, 1), orderType: "LIMIT", price: 1000 });
    const created = (await r.engine.account("paper-1")).createdAt;
    r.advance(60_000);
    await r.engine.reset("paper-1", { startingCapital: 500_000 });
    expect(r.events.at(-1)).toMatchObject({ orderId: o.orderId, status: "cancelled", mode: "paper" });
    expect(await r.engine.account("paper-1")).toEqual({ accountId: "paper-1", startingCapital: 500_000, createdAt: created, resetAt: "2026-10-19T10:01:00.000+05:30", ordersToday: 0 });
    expect((await r.engine.orders("paper-1")).items).toEqual([]);
    expect(await r.engine.positions("paper-1")).toEqual([]);
    expect((await r.engine.funds("paper-1")).availableCash).toBe(500_000);
    await r.engine.reset("paper-1");
    expect((await r.engine.account("paper-1")).startingCapital).toBe(1_000_000);
    expect(await codeOf(r.engine.reset("paper-1", { startingCapital: 5 }))).toBe("VALIDATION_FAILED");
    // Persisted.
    expect((await r.restart().account("paper-1")).startingCapital).toBe(1_000_000);
  });

  it("fill events carry the realised P&L of that fill", async () => {
    const r = rig({ paper: { useDepth: false } });
    await r.engine.place("paper-1", { ...buy(RELIANCE, 10), product: "INTRADAY" }); // 1400.7
    r.md.setPrice(RELIANCE, 1500);
    r.advance(2000);
    await r.engine.place("paper-1", { ...sell(RELIANCE, 10), product: "INTRADAY" }); // 1499.2
    const fills = r.events.filter((e) => e.status === "filled");
    expect(fills.map((e) => e.realisedPnl)).toEqual([0, 985]);
  });
});
