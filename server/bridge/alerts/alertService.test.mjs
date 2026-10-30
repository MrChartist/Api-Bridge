/**
 * Position alerts on the server: rules stored in the Bridge home, evaluated against the paper engine's positions and
 * spot prices, fired once on the edge, logged, emitted on the bus for notify, and restored after a restart without
 * firing again. No order is ever placed.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createAlertService, conditionWords } from "./alertService.mjs";

const CE = "NFO:NIFTY-2026-11-03-26500-CE";
const T0 = Date.parse("2026-11-02T10:00:00+05:30");

function rig({ dir = mkdtempSync(join(tmpdir(), "mcb-alerts-")), positions = [{ symbol: CE, netQty: -65, avgPrice: 40, ltp: 50, pnl: -650 }], spot = 26300 } = {}) {
  const clock = { t: T0, now() { return this.t; } };
  const bus = createEventBus();
  const fired = [];
  bus.on("option.alert", (p) => fired.push(p));
  const state = { positions, spot, placed: 0 };
  const deps = {
    paths: { dataDir: dir },
    bus,
    clock,
    logger: createNullLogger(),
    config: { accounts: [{ id: "demo-paper", broker: "paper" }, { id: "dhan-main", broker: "dhan" }] },
    orders: {
      positions: async () => ({ items: state.positions }),
      place: async () => {
        state.placed += 1;
      },
    },
    marketData: { ltp: async (syms) => ({ items: syms.map((s) => ({ symbol: s, ltp: state.spot })) }) },
  };
  const timers = { setInterval: () => 1, clearInterval: () => {} };
  const svc = createAlertService(deps, { timers });
  svc.start();
  return { dir, clock, bus, fired, state, deps, svc, restart: () => createAlertService(deps, { timers }) };
}

const base = { account: "demo-paper", underlying: "NIFTY", conditions: [{ kind: "pnl_below", value: -1000 }], repeat: "every", cooldownMin: 5, notify: true };

describe("position alerts service", () => {
  it("validates and stores rules in the Bridge home, with a default name", () => {
    const r = rig();
    expect(() => r.svc.create({ ...base, conditions: [] })).toThrow(/at least one condition/);
    const a = r.svc.create(base);
    expect(a).toMatchObject({ name: "NIFTY P&L at or below −₹1000", enabled: true, armed: true, fires: 0 });
    expect(existsSync(join(r.dir, "alerts", "rules.json"))).toBe(true);
    expect(r.svc.list()).toHaveLength(1);
  });

  it("fires once when P&L crosses the level, logs it, emits option.alert and places nothing", async () => {
    const r = rig();
    r.svc.create(base);
    expect(await r.svc.runOnce()).toBe(0);
    r.state.positions = [{ symbol: CE, netQty: -65, avgPrice: 40, ltp: 70, pnl: -1950 }];
    expect(await r.svc.runOnce()).toBe(1);
    expect(await r.svc.runOnce()).toBe(0);
    expect(r.fired).toHaveLength(1);
    expect(r.fired[0]).toMatchObject({ kind: "position", underlying: "NIFTY", notify: true });
    expect(r.fired[0].text).toMatch(/P&L at or below −₹1000\. Now: P&L −₹1950 · spot 26300\.00/);
    expect(JSON.stringify(r.fired[0])).not.toMatch(/demo-paper/);
    expect(r.state.placed).toBe(0);
    const inbox = r.svc.inbox();
    expect(inbox.unread).toBe(1);
    expect(inbox.items[0].text).toBe(r.fired[0].text);
    r.svc.markRead();
    expect(r.svc.inbox().unread).toBe(0);
    expect(readFileSync(join(r.dir, "alerts", "fires.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("a once rule switches itself off; a restart keeps the latch and does not fire again", async () => {
    const r = rig({ positions: [{ symbol: CE, netQty: -65, avgPrice: 40, ltp: 70, pnl: -1950 }] });
    const once = r.svc.create({ ...base, repeat: "once" });
    const every = r.svc.create({ ...base, name: "every" });
    expect(await r.svc.runOnce()).toBe(2);
    expect(r.svc.list().find((x) => x.id === once.id).enabled).toBe(false);
    const again = r.restart();
    again.start();
    r.clock.t += 60 * 60_000;
    expect(await again.runOnce()).toBe(0);
    expect(again.list().find((x) => x.id === every.id)).toMatchObject({ armed: false, fires: 1 });
  });

  it("spot, time to expiry and premium-multiple conditions", async () => {
    const r = rig();
    r.svc.create({ ...base, conditions: [{ kind: "spot_above", value: 26400 }], match: "any" });
    r.svc.create({ ...base, conditions: [{ kind: "premium_multiple", value: 2 }] });
    r.svc.create({ ...base, conditions: [{ kind: "expiry_within", value: 60 * 24 }] });
    expect(await r.svc.runOnce()).toBe(0);
    r.state.spot = 26450;
    r.state.positions = [{ symbol: CE, netQty: -65, avgPrice: 40, ltp: 85, pnl: -2925 }];
    r.clock.t = Date.parse("2026-11-03T09:30:00+05:30");
    expect(await r.svc.runOnce()).toBe(3);
  });

  it("edits re-arm the rule; delete removes it", async () => {
    const r = rig({ positions: [{ symbol: CE, netQty: -65, avgPrice: 40, ltp: 70, pnl: -1950 }] });
    const a = r.svc.create(base);
    await r.svc.runOnce();
    expect(r.svc.update(a.id, { conditions: [{ kind: "pnl_below", value: -1500 }] }).armed).toBe(true);
    r.svc.remove(a.id);
    expect(r.svc.list()).toEqual([]);
    expect(() => r.svc.get(a.id)).toThrow(/No alert/);
  });

  it("names conditions in plain words", () => {
    expect(conditionWords({ kind: "delta_outside", value: -50, value2: 50 })).toBe("delta outside −50 to 50");
    expect(conditionWords({ kind: "premium_multiple", value: 2 })).toBe("a leg at 2.0× its average price");
  });
});
