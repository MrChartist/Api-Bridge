/**
 * The trigger engine against the real OrderService, SafetyGuard and PaperEngine (wired by createApp as in
 * production): a GTT fires through every order gate, OCO cancels its other leg, a trail only tightens, a price that
 * gaps through the trigger fires once, the kill switch fails a trigger for good, exits are reduce-only, and a restart
 * never fires twice.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    overrides: { keyStore: notImplementedService("keyStore"), accounts, scheduler: createFakeScheduler(), symbols: createFakeSymbolService({ instruments: INSTRUMENTS }), marketData: md },
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
