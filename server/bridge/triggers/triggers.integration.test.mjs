/**
 * The trigger engine against the real OrderService, SafetyGuard and PaperEngine (wired by createApp as in
 * production): a GTT fires through every order gate, OCO cancels its other leg, a trail only tightens, a price that
 * gaps through the trigger fires once, the kill switch fails a trigger for good, exits are reduce-only, and a restart
 * never fires twice.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
import ordersModule from "../orders/module.mjs";
import paperModule from "../paper/module.mjs";
import { createFakeScheduler, createManualClock } from "../ratelimit/fake.mjs";
import safetyModule from "../safety/module.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { INSTRUMENTS, KEYS, PRICES } from "../orders/__fixtures__/helpers.mjs";
import triggersModule, { triggerServiceOf } from "./module.mjs";
import { createTriggerService } from "./triggerService.mjs";

const OPT = "NFO:NIFTY-2026-10-27-25000-CE"; // lot 65, LTP 120.5
const LOT = 65;
const NOV = "NFO:NIFTY-2026-11-24-25000-CE"; // lot 65, expires after the dates the later tests run on
const log = createNullLogger();
const ctx = (key) => createCallContext({ source: "rest", key: KEYS[key], log });
let app;
let clock;
let md;
let dataDir;
let svc;

const reject = async (p) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
};

async function buyLots(lots, product = "MARGIN") {
  await clock.advance(1000);
  const r = await app.deps.orders.place(ctx("paper"), { account: "paper", symbol: OPT, side: "BUY", quantity: lots * LOT, product, orderType: "MARKET" });
  await clock.advance(1000);
  return r.order;
}
const held = async () => (await app.deps.orders.positions(ctx("paper"), "paper")).items.filter((p) => p.symbol === OPT).reduce((s, p) => s + p.netQty, 0);
const setPx = (v) => md.setPrice(OPT, v);

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mcb-triggers-"));
  const { config } = loadConfig({
    raw: { server: { port: 0 }, dataDir, accounts: [{ id: "paper", broker: "paper", limits: { maxLotsPerOrder: 10 } }] },
    env: {},
  });
  clock = createManualClock();
  md = createFakeMarketData({ prices: PRICES, clock });
  const accounts = createFakeAccountManager({ accounts: [{ id: "paper", broker: "paper" }] });
  app = await createApp({
    config,
    modules: [ordersModule, paperModule, safetyModule, triggersModule],
    logger: log,
    clock,
    overrides: { keyStore: notImplementedService("keyStore"), accounts, scheduler: createFakeScheduler(), symbols: createFakeSymbolService({ instruments: [...INSTRUMENTS, { symbol: NOV, lotSize: LOT, tickSize: 0.05 }] }), marketData: md },
  });
  svc = triggerServiceOf(app.deps);
});

afterAll(async () => {
  await app?.close();
});

describe("trigger engine", () => {
  it("refuses a trigger on the wrong side of the price, and one from an AI assistant key", async () => {
    setPx(120.5);
    const e = await reject(svc.create(ctx("paper"), { account: "paper", symbol: OPT, product: "MARGIN", legs: [{ trigger: 110, op: "above", order: { side: "BUY", lots: 1 } }] }));
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(e.detail).toMatch(/already at or above/);
    const m = await reject(svc.create(ctx("mcp"), { account: "paper", symbol: OPT, product: "MARGIN", legs: [{ trigger: 130, order: { side: "BUY", lots: 1 } }] }));
    expect(m.code).toBe("SCOPE_REQUIRED");
  });

  it("refuses a live trigger unless every live gate allows it", async () => {
    const e = await reject(svc.create(ctx("live"), { account: "paper", symbol: OPT, product: "MARGIN", mode: "live", legs: [{ trigger: 130, order: { side: "BUY", lots: 1 } }] }));
    expect(e.code).toBe("PAPER_ONLY");
    expect(e.detail).toMatch(/cannot send live orders/);
  });

  it("a GTT buy fires once when the price reaches it, through orders.place as source guard", async () => {
    setPx(120.5);
    const t = await svc.create(ctx("paper"), { account: "paper", symbol: OPT, product: "MARGIN", legs: [{ trigger: 125, order: { side: "BUY", lots: 1 } }] });
    expect(t).toMatchObject({ status: "active", type: "single", origin: "gtt", mode: "paper" });
    expect(t.legs[0]).toMatchObject({ op: "above", trigger: 125, role: "entry" });
    expect(t.owner).toEqual({ label: "paper script", keyId: "paperkey001" });
    await clock.advance(1000);
    expect(await svc.runOnce()).toBe(0);
    setPx(125.3);
    expect(await svc.runOnce()).toBe(1);
    const after = svc.get(ctx("paper"), t.id);
    expect(after.status).toBe("triggered");
    expect(after.result.orderId).toBeTruthy();
    const order = await app.deps.orders.get(ctx("paper"), after.result.orderId);
    expect(order).toMatchObject({ side: "BUY", quantity: LOT, clientOrderId: t.id, source: "guard" });
    await clock.advance(1000);
    setPx(130);
    expect(await svc.runOnce()).toBe(0); // fired triggers are done
  });

  it("an intraday trigger ends at today's 15:20 square-off and expires there; carry lasts to the contract's expiry", async () => {
    setPx(120);
    const mis = await svc.create(ctx("paper"), { account: "paper", symbol: OPT, product: "INTRADAY", legs: [{ trigger: 140, order: { side: "BUY", lots: 1 } }] });
    const day = new Date(clock.now() + 19_800_000).toISOString().slice(0, 10);
    expect(mis.expiresAt).toBe(`${day}T15:20:00.000+05:30`);
    const nrml = await svc.create(ctx("paper"), { account: "paper", symbol: OPT, product: "MARGIN", legs: [{ trigger: 140, order: { side: "BUY", lots: 1 } }] });
    expect(nrml.expiresAt).toBe("2026-10-27T15:30:00.000+05:30");
    const real = clock.now;
    clock.now = () => Date.parse(`${day}T15:20:01+05:30`);
    try {
      await svc.runOnce();
    } finally {
      clock.now = real;
    }
    expect(svc.get(ctx("paper"), mis.id)).toMatchObject({ status: "expired" });
    expect(svc.get(ctx("paper"), nrml.id).status).toBe("active");
    svc.cancel(ctx("paper"), nrml.id);
  });

  it("an OCO exit: the stop fires, the target is gone with it; reduce-only sends no more than is held", async () => {
    await buyLots(2);
    const before = await held();
    setPx(120);
    const t = await svc.create(ctx("paper"), {
      account: "paper",
      symbol: OPT,
      product: "MARGIN",
      origin: "position",
      legs: [
        { trigger: 110, order: { side: "SELL", quantity: before + LOT } },
        { trigger: 140, order: { side: "SELL", quantity: before + LOT } },
      ],
    });
    expect(t).toMatchObject({ type: "oco", reduceOnly: true });
    expect(t.legs.map((l) => [l.role, l.op])).toEqual([["stop", "below"], ["target", "above"]]);
    await clock.advance(1000);
    setPx(109.5);
    expect(await svc.runOnce()).toBe(1);
    const after = svc.get(ctx("paper"), t.id);
    expect(after).toMatchObject({ status: "triggered", firedLeg: 0 });
    expect(after.result.quantity).toBe(before);
    await clock.advance(1000);
    expect(await held()).toBe(0);
  });

  it("a price that gaps through the trigger fires once, at the gap price", async () => {
    await buyLots(1);
    setPx(120);
    const t = await svc.create(ctx("paper"), { account: "paper", symbol: OPT, product: "MARGIN", origin: "position", legs: [{ trigger: 115, order: { side: "SELL", lots: 1 } }] });
    await clock.advance(1000);
    setPx(90); // opened 25 points under the stop, never trading at 115
    expect(await svc.runOnce()).toBe(1);
    expect(await svc.runOnce()).toBe(0);
    const after = svc.get(ctx("paper"), t.id);
    expect(after).toMatchObject({ status: "triggered", fireLtp: 90 });
    const sells = (await app.deps.orders.list(ctx("paper"), { accountId: "paper", limit: 500 })).items.filter((o) => o.clientOrderId === t.id);
    expect(sells).toHaveLength(1);
  });

  it("a trailing stop follows the high and never moves back", async () => {
    await buyLots(1);
    setPx(120);
    const t = await svc.create(ctx("paper"), { account: "paper", symbol: OPT, product: "MARGIN", origin: "position", legs: [{ trigger: 110, trail: { points: 10 }, order: { side: "SELL", lots: 1 } }] });
    await clock.advance(1000);
    for (const [px, trig] of [[125, 115], [131.33, 121.3], [126, 121.3]]) {
      setPx(px);
      expect(await svc.runOnce()).toBe(0);
      expect(svc.get(ctx("paper"), t.id).legs[0].trigger).toBe(trig);
    }
    setPx(121.2);
    expect(await svc.runOnce()).toBe(1);
    await clock.advance(1000);
    expect(await held()).toBe(0);
  });

  it("an exit whose position is already closed is cancelled, not sent", async () => {
    await buyLots(1);
    setPx(120);
    const t = await svc.create(ctx("paper"), { account: "paper", symbol: OPT, product: "MARGIN", origin: "position", legs: [{ trigger: 100, order: { side: "SELL", lots: 1 } }] });
    await app.deps.orders.place(ctx("paper"), { account: "paper", symbol: OPT, side: "SELL", quantity: LOT, product: "MARGIN", orderType: "MARKET" });
    await clock.advance(1000);
    setPx(99);
    await svc.runOnce();
    expect(svc.get(ctx("paper"), t.id)).toMatchObject({ status: "cancelled", result: { code: "REDUCE_ONLY", message: "The position is already closed." } });
  });

  it("the kill switch fails the trigger with the reason; it is not retried", async () => {
    setPx(120);
    const t = await svc.create(ctx("paper"), { account: "paper", symbol: OPT, product: "MARGIN", legs: [{ trigger: 126, order: { side: "BUY", lots: 1 } }] });
    const admin = createCallContext({ source: "rest", key: KEYS.admin, log, scopes: ["admin"] });
    admin.loopback = true;
    await app.deps.safety.engageKillSwitch(admin, { reason: "test" });
    await clock.advance(1000);
    setPx(127);
    await svc.runOnce();
    const after = svc.get(ctx("paper"), t.id);
    expect(after.status).toBe("failed");
    expect(after.result.code).toBe("KILL_SWITCH_ACTIVE");
    await app.deps.safety.releaseKillSwitch?.(admin, { confirm: "RELEASE" });
  });

  it("a per-order limit applies to a trigger's order (refused when it is set; never weakened)", async () => {
    try {
      await app.deps.safety.releaseKillSwitch?.(createCallContext({ source: "cli", principal: { kind: "local", id: "cli" }, log, scopes: ["admin"] }), { confirm: "RELEASE" });
    } catch {
      /* already released */
    }
    setPx(120);
    const e = await reject(svc.create(ctx("paper"), { account: "paper", symbol: OPT, product: "MARGIN", legs: [{ trigger: 126, order: { side: "BUY", lots: 12 } }] }));
    expect(e.detail).toMatch(/12 lots is above the per-order limit of 10 lots/);
    // A limit price far from the price now is fine when it is set (the band is checked when it fires).
    const far = await svc.create(ctx("paper"), { account: "paper", symbol: OPT, product: "MARGIN", legs: [{ trigger: 150, order: { side: "BUY", lots: 1, orderType: "LIMIT", price: 151 } }] });
    expect(far.status).toBe("active");
    svc.cancel(ctx("paper"), far.id);
  });

  it("survives a restart: open triggers re-arm, and one left firing is resolved by its order, never sent twice", async () => {
    try {
      await app.deps.safety.releaseKillSwitch?.(createCallContext({ source: "cli", principal: { kind: "local", id: "cli" }, log, scopes: ["admin"] }), { confirm: "RELEASE" });
    } catch {
      /* already released */
    }
    setPx(120);
    const keep = await svc.create(ctx("paper"), { account: "paper", symbol: OPT, product: "MARGIN", legs: [{ trigger: 135, order: { side: "BUY", lots: 1 } }] });
    const crash = await svc.create(ctx("paper"), { account: "paper", symbol: OPT, product: "MARGIN", legs: [{ trigger: 128, order: { side: "BUY", lots: 1 } }] });
    await clock.advance(1000);
    // The Bridge placed crash's order, then stopped before the trigger was marked triggered.
    setPx(128.5);
    await svc.runOnce();
    const placed = svc.get(ctx("paper"), crash.id).result.orderId;
    const file = join(dataDir, "triggers", "triggers.json");
    const disk = JSON.parse(readFileSync(file, "utf8"));
    const rec = disk.items.find((x) => x.id === crash.id);
    Object.assign(rec, { status: "firing", result: null });
    writeFileSync(file, JSON.stringify(disk));
    setPx(120);

    const again = createTriggerService(app.deps, { timers: { setInterval: () => 0, clearInterval: () => {} } });
    expect(again.get(ctx("paper"), keep.id).status).toBe("active");
    await again.recover();
    const r = again.get(ctx("paper"), crash.id);
    expect(r).toMatchObject({ status: "triggered", result: { orderId: placed, recovered: true } });
    const mine = (await app.deps.orders.list(ctx("paper"), { accountId: "paper", limit: 500 })).items.filter((o) => o.clientOrderId === crash.id);
    expect(mine).toHaveLength(1);
    // The re-armed one still fires after the restart.
    await clock.advance(1000);
    setPx(135.5);
    expect(await again.runOnce()).toBe(1);
    expect(again.get(ctx("paper"), keep.id).status).toBe("triggered");
  });

  it("a bracket's exits wait for the entry to fill, then arm with the filled quantity; a cancelled entry cancels them", async () => {
    setPx(120);
    await clock.advance(1000);
    const entry = (await app.deps.orders.place(ctx("paper"), { account: "paper", symbol: OPT, side: "BUY", quantity: LOT, product: "MARGIN", orderType: "LIMIT", price: 118 })).order;
    expect(entry.status).toBe("open");
    const t = await svc.create(ctx("paper"), { account: "paper", symbol: OPT, product: "MARGIN", origin: "bracket", parentOrderId: entry.orderId, legs: [{ trigger: 110, op: "below", order: { side: "SELL", lots: 1 } }, { trigger: 130, op: "above", order: { side: "SELL", lots: 1 } }] });
    expect(t.status).toBe("waiting");
    await clock.advance(1000);
    setPx(117.5);
    await clock.advance(5000);
    await app.deps.paper.runOnce();
    await svc.runOnce();
    expect((await app.deps.orders.get(ctx("paper"), entry.orderId)).status).toBe("filled");
    expect(svc.get(ctx("paper"), t.id).status).toBe("active");

    const entry2 = (await app.deps.orders.place(ctx("paper"), { account: "paper", symbol: OPT, side: "BUY", quantity: LOT, product: "MARGIN", orderType: "LIMIT", price: 114 })).order;
    const t2 = await svc.create(ctx("paper"), { account: "paper", symbol: OPT, product: "MARGIN", origin: "bracket", parentOrderId: entry2.orderId, legs: [{ trigger: 105, op: "below", order: { side: "SELL", lots: 1 } }] });
    await clock.advance(1000);
    await app.deps.orders.cancel(ctx("paper"), entry2.orderId);
    await svc.runOnce();
    expect(svc.get(ctx("paper"), t2.id)).toMatchObject({ status: "cancelled" });
    svc.cancel(ctx("paper"), t.id);
  });
});

describe("after-market orders (held on this Bridge, sent at 09:15)", () => {
  const istNow = () => new Date(clock.now() + 19_800_000).toISOString().slice(0, 16);
  async function toIst(day, hhmm) {
    const target = Date.parse(`${day}T${hhmm}:00+05:30`);
    if (target > clock.now()) await clock.advance(target - clock.now());
  }

  it("is refused while the market is open", async () => {
    await toIst("2026-10-19", "11:00");
    setPx(120);
    const e = await reject(svc.create(ctx("paper"), { account: "paper", symbol: OPT, product: "MARGIN", origin: "amo", legs: [{ order: { side: "BUY", lots: 1, orderType: "LIMIT", price: 121 } }] }));
    expect(e.detail).toMatch(/market is open: place the order now/);
  });

  it("set after the close, goes at 09:15 the next trading day through every gate, and not before", async () => {
    await toIst("2026-10-23", "16:05"); // Friday after the close
    setPx(120);
    const t = await svc.create(ctx("paper"), { account: "paper", symbol: OPT, product: "MARGIN", origin: "amo", legs: [{ order: { side: "BUY", lots: 1, orderType: "LIMIT", price: 121 } }] });
    expect(t).toMatchObject({ origin: "amo", status: "active", held: "bridge", openAt: "2026-10-26T09:15:00.000+05:30", reduceOnly: false });
    expect(t.legs[0]).toMatchObject({ op: "open", trigger: null, role: "entry" });
    expect(t.expiresAt).toBe("2026-10-26T15:30:00.000+05:30");
    expect(await svc.runOnce()).toBe(0);
    await toIst("2026-10-26", "09:14");
    expect(await svc.runOnce()).toBe(0);
    await toIst("2026-10-26", "09:15");
    expect(await svc.runOnce()).toBe(1);
    const after = svc.get(ctx("paper"), t.id);
    expect(after.status).toBe("triggered");
    const o = await app.deps.orders.get(ctx("paper"), after.result.orderId);
    expect(o).toMatchObject({ side: "BUY", orderType: "LIMIT", price: 121, source: "guard", clientOrderId: t.id });
    expect(istNow()).toBe("2026-10-26T09:15");
  });

  it("a market AMO is not sent when the open gaps beyond the price band", async () => {
    await toIst("2026-10-26", "16:00");
    setPx(120);
    const t = await svc.create(ctx("paper"), { account: "paper", symbol: OPT, product: "MARGIN", origin: "amo", legs: [{ order: { side: "BUY", lots: 1, orderType: "MARKET" } }] });
    expect(t.openAt).toBe("2026-10-27T09:15:00.000+05:30");
    await toIst("2026-10-27", "09:15");
    setPx(140); // +16.7 % at the open
    await svc.runOnce();
    const after = svc.get(ctx("paper"), t.id);
    expect(after.status).toBe("failed");
    expect(after.result).toMatchObject({ code: "PRICE_BAND" });
    expect(after.result.message).toMatch(/opened 16\.67% away from 120/);
  });
});

describe("an after-market order is not warned about today's daily limits", () => {
  it("daily loss used up today + an AMO for the next session: no daily-limit warning (a same-day GTT keeps it)", async () => {
    const at = async (day, hhmm) => {
      const target = Date.parse(`${day}T${hhmm}:00+05:30`);
      if (target > clock.now()) await clock.advance(target - clock.now());
    };
    await at("2026-10-27", "10:00");
    try {
      await app.deps.safety.releaseKillSwitch?.(createCallContext({ source: "cli", principal: { kind: "local", id: "cli" }, log, scopes: ["admin"] }), { confirm: "RELEASE" });
    } catch {
      /* not engaged */
    }
    // Lose more than the daily limit today: 10 lots bought at 120 and sold at 100.
    setPx(120);
    await app.deps.orders.place(ctx("paper"), { account: "paper", symbol: OPT, side: "BUY", quantity: 10 * LOT, product: "MARGIN", orderType: "MARKET" });
    await clock.advance(1000);
    setPx(100);
    await app.deps.orders.place(ctx("paper"), { account: "paper", symbol: OPT, side: "SELL", quantity: 10 * LOT, product: "MARGIN", orderType: "MARKET" });
    await clock.advance(1000);
    const today = await reject(app.deps.orders.place(ctx("paper"), { account: "paper", symbol: OPT, side: "BUY", quantity: LOT, product: "MARGIN", orderType: "MARKET" }));
    expect(today.code).toBe("DAILY_LIMIT_REACHED");
    await at("2026-10-27", "16:00");
    // The option expires today; the next session's order is an equity one.
    md.setPrice("NSE:RELIANCE", 1400);
    const amo = await svc.create(ctx("paper"), { account: "paper", symbol: "NSE:RELIANCE", product: "CNC", origin: "amo", legs: [{ order: { side: "BUY", quantity: 1, orderType: "LIMIT", price: 1401 } }] });
    expect(amo.warnings.join(" ")).not.toMatch(/daily limit/);
    const gtt = await svc.create(ctx("paper"), { account: "paper", symbol: "NSE:RELIANCE", product: "CNC", legs: [{ trigger: 1410, order: { side: "BUY", quantity: 1 } }] });
    expect(gtt.warnings.join(" ")).toMatch(/daily limit/);
    svc.cancel(ctx("paper"), amo.id);
    svc.cancel(ctx("paper"), gtt.id);
  });
});

describe("adversarial review: cancels and scopes", () => {
  const quiet = { timers: { setInterval: () => 0, clearInterval: () => {} } };
  const at = async (day, hhmm) => {
    const target = Date.parse(`${day}T${hhmm}:00+05:30`);
    if (target > clock.now()) await clock.advance(target - clock.now());
  };

  it("an after-market order cancelled while the engine reads the opening price is not sent", async () => {
    await at("2026-10-28", "16:00");
    md.setPrice("NSE:RELIANCE", 1400);
    let during = null;
    const marketData = { ...md, ltp: async (...a) => {
      const r = await md.ltp(...a);
      const f = during;
      during = null;
      f?.();
      return r;
    } };
    const s2 = createTriggerService({ ...app.deps, marketData }, quiet);
    const t = await s2.create(ctx("paper"), { account: "paper", symbol: "NSE:RELIANCE", product: "CNC", origin: "amo", legs: [{ order: { side: "BUY", quantity: 1, orderType: "LIMIT", price: 1401 } }] });
    await at("2026-10-29", "09:15");
    during = () => s2.cancel(ctx("paper"), t.id);
    expect(await s2.runOnce()).toBe(0);
    expect(s2.get(ctx("paper"), t.id).status).toBe("cancelled");
    const sent = (await app.deps.orders.list(ctx("paper"), { accountId: "paper", limit: 500 })).items.filter((o) => o.clientOrderId === t.id);
    expect(sent).toHaveLength(0);
  });

  it("a bracket cancelled while the engine reads its entry order stays cancelled (is not re-armed)", async () => {
    await at("2026-10-29", "10:00");
    md.setPrice("NSE:RELIANCE", 1400);
    const entry = (await app.deps.orders.place(ctx("paper"), { account: "paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "MARKET" })).order;
    await clock.advance(1000);
    let during = null;
    const orders = { ...app.deps.orders, get: async (...a) => {
      const r = await app.deps.orders.get(...a);
      const f = during;
      during = null;
      f?.();
      return r;
    } };
    const s2 = createTriggerService({ ...app.deps, orders }, quiet);
    const t = await s2.create(ctx("paper"), { account: "paper", symbol: "NSE:RELIANCE", product: "CNC", origin: "bracket", parentOrderId: entry.orderId, legs: [{ trigger: 1300, op: "below", order: { side: "SELL", quantity: 1 } }] });
    expect(t.status).toBe("waiting");
    expect((await app.deps.orders.get(ctx("paper"), entry.orderId)).status).toBe("filled");
    during = () => s2.cancel(ctx("paper"), t.id);
    await s2.runOnce();
    expect(s2.get(ctx("paper"), t.id).status).toBe("cancelled");
  });

  it("a live trigger cannot be changed or cancelled by a key without the live scope; an AI assistant key cannot change one", async () => {
    await at("2026-10-29", "10:30");
    md.setPrice("NSE:RELIANCE", 1400);
    const s2 = createTriggerService(app.deps, quiet);
    const t = await s2.create(ctx("paper"), { account: "paper", symbol: "NSE:RELIANCE", product: "CNC", legs: [{ trigger: 1450, order: { side: "BUY", quantity: 1 } }] });
    const m = await reject(s2.update(ctx("mcp"), t.id, { legs: [{ trigger: 1410 }] }));
    expect(m.code).toBe("SCOPE_REQUIRED");
    // As if it had been set live by a live key (a paper account cannot hold one): a paper key may not steer it.
    s2._state().items.find((x) => x.id === t.id).mode = "live";
    const u = await reject(s2.update(ctx("paper"), t.id, { legs: [{ trigger: 1401 }] }));
    expect(u.code).toBe("SCOPE_REQUIRED");
    const c = await reject(Promise.resolve().then(() => s2.cancel(ctx("paper"), t.id)));
    expect(c.code).toBe("SCOPE_REQUIRED");
    expect(s2.get(ctx("paper"), t.id).legs[0].trigger).toBe(1450);
    s2.cancel(ctx("live"), t.id);
    expect(s2.get(ctx("paper"), t.id).status).toBe("cancelled");
  });

  it("an unreadable triggers file is kept aside, not overwritten by the next save", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-triggers-bad-"));
    mkdirSync(join(dir, "triggers"), { recursive: true });
    const bad = '{"v":1,"items":[{"id":"trg_aaaaaaaaaaaa","legs":[],"status":"active"'; // cut short
    writeFileSync(join(dir, "triggers", "triggers.json"), bad);
    md.setPrice("NSE:RELIANCE", 1400);
    const s2 = createTriggerService({ ...app.deps, paths: { ...app.deps.paths, dataDir: dir } }, quiet);
    const t = await s2.create(ctx("paper"), { account: "paper", symbol: "NSE:RELIANCE", product: "CNC", legs: [{ trigger: 1450, order: { side: "BUY", quantity: 1 } }] });
    const kept = readdirSync(join(dir, "triggers")).filter((f) => f.startsWith("triggers.json.corrupt-"));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(dir, "triggers", kept[0]), "utf8")).toBe(bad);
    s2.cancel(ctx("paper"), t.id);
  });

  it("a trigger that could not be saved is refused and never fires", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-triggers-ro-"));
    writeFileSync(join(dir, "triggers"), "not a folder"); // every save fails
    md.setPrice("NSE:RELIANCE", 1400);
    const s2 = createTriggerService({ ...app.deps, paths: { ...app.deps.paths, dataDir: dir } }, quiet);
    await reject(s2.create(ctx("paper"), { account: "paper", symbol: "NSE:RELIANCE", product: "CNC", legs: [{ trigger: 1405, order: { side: "BUY", quantity: 1 } }] }));
    expect(s2.list(() => true, { status: "open" })).toHaveLength(0);
    await clock.advance(1000);
    md.setPrice("NSE:RELIANCE", 1406);
    expect(await s2.runOnce()).toBe(0);
  });

  it("a trigger left firing that expired while the Bridge was stopped is not sent on restart", async () => {
    await at("2026-10-29", "15:10");
    md.setPrice("NSE:RELIANCE", 1400);
    const s1 = createTriggerService(app.deps, quiet);
    const t = await s1.create(ctx("paper"), { account: "paper", symbol: "NSE:RELIANCE", product: "INTRADAY", legs: [{ trigger: 1405, order: { side: "BUY", quantity: 1 } }] });
    expect(t.expiresAt).toBe("2026-10-29T15:20:00.000+05:30");
    // The Bridge marked it firing and stopped before the order went out; it starts again the next morning.
    const file = join(dataDir, "triggers", "triggers.json");
    const disk = JSON.parse(readFileSync(file, "utf8"));
    Object.assign(disk.items.find((x) => x.id === t.id), { status: "firing", firedLeg: 0, firedAt: "2026-10-29T15:19:00.000+05:30" });
    writeFileSync(file, JSON.stringify(disk));
    await at("2026-10-30", "09:20");
    const again = createTriggerService(app.deps, quiet);
    await again.recover();
    expect(again.get(ctx("paper"), t.id).status).toBe("expired");
    const sent = (await app.deps.orders.list(ctx("paper"), { accountId: "paper", limit: 500 })).items.filter((o) => o.clientOrderId === t.id);
    expect(sent).toHaveLength(0);
  });
});

describe("review follow-ups", () => {
  const quiet = { timers: { setInterval: () => 0, clearInterval: () => {} } };
  const at = async (day, hhmm) => {
    const target = Date.parse(`${day}T${hhmm}:00+05:30`);
    if (target > clock.now()) await clock.advance(target - clock.now());
  };
  const strategyCtx = () => createCallContext({ source: "rest", key: { ...KEYS.paper, id: "stratkey001", label: "Algo buyer", purpose: "strategy-run" }, log });

  it("a strategy run's own key cannot set a trigger (it would outlive the run and its revoked key)", async () => {
    await at("2026-11-02", "10:00");
    md.setPrice("NSE:RELIANCE", 1400);
    const s2 = createTriggerService(app.deps, quiet);
    const e = await reject(s2.create(strategyCtx(), { account: "paper", symbol: "NSE:RELIANCE", product: "CNC", legs: [{ trigger: 1450, order: { side: "BUY", quantity: 1 } }] }));
    expect(e.code).toBe("SCOPE_REQUIRED");
    expect(e.detail).toMatch(/strateg/i);
    expect(s2.list(() => true, { status: "open" }).filter((t) => t.owner?.keyId === "stratkey001")).toHaveLength(0);
  });

  it("a strategy run's own key cannot change or cancel a trigger either (the user's protective stops stay as set)", async () => {
    await at("2026-11-02", "10:10");
    md.setPrice("NSE:RELIANCE", 1400);
    const s2 = createTriggerService(app.deps, quiet);
    const t = await s2.create(ctx("paper"), { account: "paper", symbol: "NSE:RELIANCE", product: "CNC", legs: [{ trigger: 1450, order: { side: "BUY", quantity: 1 } }] });
    const u = await reject(s2.update(strategyCtx(), t.id, { legs: [{ trigger: 1500 }] }));
    expect(u.code).toBe("SCOPE_REQUIRED");
    expect(u.detail).toMatch(/strateg/i);
    const c = await reject(Promise.resolve().then(() => s2.cancel(strategyCtx(), t.id)));
    expect(c.code).toBe("SCOPE_REQUIRED");
    expect(s2.get(ctx("paper"), t.id)).toMatchObject({ status: "active", legs: [{ trigger: 1450 }] });
    s2.cancel(ctx("paper"), t.id);
  });

  it("a bracket's mode must match its entry order's mode: a paper bracket on a live entry is refused when it is set", async () => {
    await at("2026-11-02", "10:30");
    md.setPrice("NSE:RELIANCE", 1400);
    const entry = (await app.deps.orders.place(ctx("paper"), { account: "paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "LIMIT", price: 1390 })).order;
    // As a live entry would read (a paper account cannot hold one).
    const orders = { ...app.deps.orders, get: async (...a) => ({ ...(await app.deps.orders.get(...a)), mode: "live" }) };
    const s2 = createTriggerService({ ...app.deps, orders }, quiet);
    const body = { account: "paper", symbol: "NSE:RELIANCE", product: "CNC", origin: "bracket", parentOrderId: entry.orderId, legs: [{ trigger: 1300, op: "below", order: { side: "SELL", quantity: 1 } }] };
    const e = await reject(s2.create(ctx("paper"), body));
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(e.detail).toMatch(/entry order is live.*bracket is paper/);
    expect(s2.list(() => true, { status: "open" }).filter((t) => t.parentOrderId === entry.orderId)).toHaveLength(0);
    // The same bracket on the paper entry it really is: set.
    const s3 = createTriggerService(app.deps, quiet);
    const ok = await s3.create(ctx("paper"), body);
    expect(ok).toMatchObject({ status: "waiting", mode: "paper" });
    s3.cancel(ctx("paper"), ok.id);
    // An entry that does not exist is refused at once, not left waiting.
    const gone = await reject(s3.create(ctx("paper"), { ...body, parentOrderId: "PAPER-NOPE-1" }));
    expect(gone.code).toBe("VALIDATION_FAILED");
    expect(gone.detail).toMatch(/entry order .* was not found/);
    await app.deps.orders.cancel(ctx("paper"), entry.orderId);
  });

  it("a bracket whose entry partly filled and was then cancelled arms its exits for the filled quantity, reduce-only", async () => {
    await at("2026-11-02", "11:00");
    md.setPrice("NSE:RELIANCE", 1400);
    // 3 bought for real; the entry reads as 5 asked, 3 filled, the rest cancelled (as a broker reports it).
    const entry = (await app.deps.orders.place(ctx("paper"), { account: "paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 3, product: "CNC", orderType: "MARKET" })).order;
    await clock.advance(1000);
    const partly = async (...a) => ({ ...(await app.deps.orders.get(...a)), quantity: 5, filledQuantity: 3, status: "cancelled" });
    const s2 = createTriggerService({ ...app.deps, orders: { ...app.deps.orders, get: partly } }, quiet);
    const t = await s2.create(ctx("paper"), { account: "paper", symbol: "NSE:RELIANCE", product: "CNC", origin: "bracket", parentOrderId: entry.orderId, legs: [{ trigger: 1300, op: "below", order: { side: "SELL", quantity: 5 } }, { trigger: 1500, op: "above", order: { side: "SELL", quantity: 5 } }] });
    expect(t.status).toBe("waiting");
    await s2.runOnce();
    const armed = s2.get(ctx("paper"), t.id);
    expect(armed).toMatchObject({ status: "active", reduceOnly: true });
    expect(armed.legs.map((l) => l.order.quantity)).toEqual([3, 3]);
    // A cancelled entry with nothing filled still cancels its exits.
    const none = async (...a) => ({ ...(await app.deps.orders.get(...a)), quantity: 5, filledQuantity: 0, status: "cancelled" });
    const s4 = createTriggerService({ ...app.deps, orders: { ...app.deps.orders, get: none } }, quiet);
    const t4 = await s4.create(ctx("paper"), { account: "paper", symbol: "NSE:RELIANCE", product: "CNC", origin: "bracket", parentOrderId: entry.orderId, legs: [{ trigger: 1300, op: "below", order: { side: "SELL", quantity: 5 } }] });
    await s4.runOnce();
    expect(s4.get(ctx("paper"), t4.id)).toMatchObject({ status: "cancelled" });
    s2.cancel(ctx("paper"), t.id);
    await app.deps.orders.place(ctx("paper"), { account: "paper", symbol: "NSE:RELIANCE", side: "SELL", quantity: 3, product: "CNC", orderType: "MARKET" });
    await clock.advance(1000);
  });

  it("converting MIS to NRML carries the position's stop and target to NRML with the same levels; they are not cancelled as closed", async () => {
    await at("2026-11-02", "12:00");
    md.setPrice(NOV, 120);
    const s2 = createTriggerService(app.deps, quiet);
    await s2.start();
    try {
      await app.deps.orders.place(ctx("paper"), { account: "paper", symbol: NOV, side: "BUY", lots: 4, product: "INTRADAY", orderType: "MARKET" });
      await clock.advance(1000);
      const full = await s2.create(ctx("paper"), { account: "paper", symbol: NOV, product: "INTRADAY", origin: "position", legs: [{ trigger: 110, trail: { points: 2 }, order: { side: "SELL", lots: 4 } }, { trigger: 140, order: { side: "SELL", lots: 4 } }] });
      expect(Date.parse(full.expiresAt)).toBeLessThan(Date.parse("2026-11-03T00:00:00+05:30")); // ends at today's square-off
      md.setPrice(NOV, 118);
      await clock.advance(1000);
      await s2.runOnce(); // the trail moves the stop up to 116
      const before = s2.get(ctx("paper"), full.id);
      expect(before.legs[0].trigger).toBe(116);

      // Convert 1 lot of the 4 first: 1 is carried to NRML, 3 stay on MIS.
      await app.deps.orders.convertPosition(ctx("paper"), { account: "paper", symbol: NOV, from: "INTRADAY", to: "MARGIN", lots: 1 });
      const kept = s2.get(ctx("paper"), full.id);
      expect(kept).toMatchObject({ status: "active", product: "INTRADAY" });
      expect(kept.legs.map((l) => l.order.quantity)).toEqual([195, 195]);
      const moved = s2.list(() => true, { status: "open" }).filter((t) => t.convertedFrom === full.id);
      expect(moved).toHaveLength(1);
      expect(moved[0]).toMatchObject({ status: "active", product: "MARGIN", type: "oco", reduceOnly: true, origin: "position", expiresAt: "2026-11-24T15:30:00.000+05:30" });
      expect(moved[0].legs.map((l) => [l.trigger, l.op, l.trail, l.order.quantity])).toEqual(before.legs.map((l) => [l.trigger, l.op, l.trail, 65]));

      // Then the other 3: the whole trigger moves to NRML, same id and levels, good till the contract's expiry.
      await app.deps.orders.convertPosition(ctx("paper"), { account: "paper", symbol: NOV, from: "INTRADAY", to: "MARGIN", lots: 3 });
      const after = s2.get(ctx("paper"), full.id);
      expect(after).toMatchObject({ status: "active", product: "MARGIN", expiresAt: "2026-11-24T15:30:00.000+05:30" });
      expect(after.legs.map((l) => [l.trigger, l.op, l.trail, l.order.quantity])).toEqual(before.legs.map((l) => [l.trigger, l.op, l.trail, 195]));

      // The flat-position sweep leaves them alone (the MIS position is flat, the NRML one is held).
      await clock.advance(61_000);
      await s2.runOnce();
      expect(s2.get(ctx("paper"), full.id).status).toBe("active");
      expect(s2.get(ctx("paper"), moved[0].id).status).toBe("active");

      // And the stop fires on NRML, selling what is held there.
      md.setPrice(NOV, 115.5);
      await clock.advance(1000);
      expect(await s2.runOnce()).toBe(2);
      await clock.advance(1000);
      for (const id of [full.id, moved[0].id]) expect(s2.get(ctx("paper"), id)).toMatchObject({ status: "triggered", firedLeg: 0 });
      const nrml = (await app.deps.orders.positions(ctx("paper"), "paper")).items.filter((p) => p.symbol === NOV && p.product === "MARGIN");
      expect(nrml.reduce((n, p) => n + p.netQty, 0)).toBe(0);
    } finally {
      s2.stop();
    }
  });
});
