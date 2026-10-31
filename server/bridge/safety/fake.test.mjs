/**
 * Contract tests: the real services and the published fakes satisfy SERVICE_CONTRACTS and behave the same on the
 * points other streams rely on (record shape, chaining, redaction, query order and cursor; kill switch blocks
 * place/modify but not cancel, emits safety.kill_switch, release needs RELEASE).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../core/config.mjs";
import { createCallContext } from "../core/context.mjs";
import { assertService, notImplementedService } from "../core/contracts.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createAuditLog } from "./auditLog.mjs";
import { createFakeAuditLog, createFakeSafetyGuard } from "./fake.mjs";
import { createSafetyGuard } from "./safetyGuard.mjs";

const T = Date.UTC(2026, 9, 19, 4, 30);
const clock = { now: () => T };

const audits = {
  real: (bus) => createAuditLog({ logger: createNullLogger(), bus, clock, paths: { dataDir: mkdtempSync(join(tmpdir(), "mcb-c-")) } }),
  fake: (bus) => createFakeAuditLog({ bus, clock }),
};

describe.each(Object.entries(audits))("AuditLog contract (%s)", (_name, make) => {
  it("satisfies the service contract", () => {
    expect(() => assertService("audit", make())).not.toThrow();
  });

  it("appends redacted, chained records, emits audit.appended, queries newest first and verifies", async () => {
    const bus = createEventBus();
    const seen = [];
    bus.on("audit.appended", (p) => seen.push(p.seq));
    const audit = make(bus);
    const a = await audit.append({ type: "order.placed", actor: { kind: "key", id: "k1" }, source: "rest", accountId: "dhan-main", requestId: "req_1", data: { orderId: "PAPER-1", accessToken: "zzz-secret" } });
    const b = await audit.append({ type: "order.cancelled", actor: { kind: "key", id: "k1" }, source: "rest", data: {} });
    expect(a).toMatchObject({ seq: 1, at: "2026-10-19T10:00:00.000+05:30", type: "order.placed", accountId: "dhan-main", requestId: "req_1", data: { orderId: "PAPER-1", accessToken: "[redacted]" } });
    expect(b).toMatchObject({ seq: 2, prevHash: a.hash, accountId: null, requestId: null });
    expect(seen).toEqual([1, 2]);
    const page = await audit.query({ limit: 1 });
    expect(page.items.map((r) => r.seq)).toEqual([2]);
    expect((await audit.query({ limit: 1, cursor: page.nextCursor })).items.map((r) => r.seq)).toEqual([1]);
    expect((await audit.query({ type: "order.*", accountId: "dhan-main" })).items.map((r) => r.seq)).toEqual([1]);
    expect(await audit.verify()).toMatchObject({ ok: true, checked: 2, brokenAt: null });
    await expect(audit.append({ type: "NOT VALID" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

const config = loadConfig({ raw: { dataDir: "/unused", accounts: [{ id: "dhan-main", broker: "dhan" }] }, env: {} }).config;
const guards = {
  real: (bus) =>
    createSafetyGuard(
      { config, logger: createNullLogger(), bus, clock, paths: { dataDir: mkdtempSync(join(tmpdir(), "mcb-c-")) }, audit: createFakeAuditLog({ clock }), accounts: notImplementedService("accounts") },
      { env: {} },
    ),
  fake: (bus) => createFakeSafetyGuard({ bus, clock }),
};

const ctx = (scopes = ["paper"]) => {
  const c = createCallContext({ source: "rest", key: { id: "k1", label: "k1", scopes, accounts: "*" }, log: createNullLogger() });
  c.loopback = true;
  return c;
};
const intent = (action) => ({ accountId: "dhan-main", mode: "paper", action, order: action === "cancel" ? null : { symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "LIMIT", price: 100 }, source: "rest", keyId: "k1", quantity: 1, value: 100, ltp: 100 });

describe.each(Object.entries(guards))("SafetyGuard contract (%s)", (_name, make) => {
  it("satisfies the service contract", () => {
    expect(() => assertService("safety", make(createEventBus()))).not.toThrow();
  });

  it("allows, then blocks place/modify (not cancel) under the kill switch, emitting events", async () => {
    const bus = createEventBus();
    const events = [];
    bus.on("safety.kill_switch", (p) => events.push(p));
    const g = make(bus);
    expect(await g.check(ctx(), intent("place"))).toMatchObject({ ok: true, mode: "paper", reasons: [] });
    expect(g.acquireOrderSlot("dhan-main")).toMatchObject({ ok: true });
    g.recordOrderEvent("dhan-main", { action: "place", mode: "live", status: "open", realisedPnl: -10 });
    expect(g.limits("dhan-main").usage).toMatchObject({ ordersToday: 1, realisedPnlToday: -10 });

    await g.engageKillSwitch(ctx(["live"]), { reason: "stop", cancelOpenOrders: true });
    expect(g.killSwitchStatus()).toMatchObject({ engaged: true, reason: "stop", by: "key:k1" });
    expect(events[0]).toMatchObject({ engaged: true, cancelOpenOrders: true });
    for (const a of ["place", "modify"]) expect((await g.check(ctx(), intent(a))).reasons.map((r) => r.code)).toContain("KILL_SWITCH_ACTIVE");
    expect((await g.check(ctx(), intent("cancel"))).ok).toBe(true);

    await expect(g.releaseKillSwitch(ctx(["admin"]), { confirm: "no" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await g.releaseKillSwitch(ctx(["admin"]), { confirm: "RELEASE" })).engaged).toBe(false);
    expect(events.at(-1)).toMatchObject({ engaged: false, cancelOpenOrders: false });
    expect(g.status().killSwitch.engaged).toBe(false);
  });
});

describe("fake guard controls", () => {
  it("refuse / allow / warn / setSlot", async () => {
    const g = createFakeSafetyGuard();
    g.refuse({ code: "DAILY_LIMIT_REACHED", message: "done for today" }, { actions: ["place"] });
    expect((await g.check(ctx(), intent("place"))).reasons).toEqual([{ code: "DAILY_LIMIT_REACHED", message: "done for today" }]);
    expect((await g.check(ctx(), intent("modify"))).ok).toBe(true);
    g.allow();
    g.warn("Static IP differs");
    expect(await g.check(ctx(), intent("place"))).toMatchObject({ ok: true, warnings: ["Static IP differs"] });
    g.setSlot({ ok: false, retryAfterMs: 250 });
    expect(g.acquireOrderSlot("dhan-main")).toEqual({ ok: false, retryAfterMs: 250 });
    expect(g.checks).toHaveLength(3);
    expect(g.slots).toEqual(["dhan-main"]);
  });

  it("fake audit failNext", async () => {
    const a = createFakeAuditLog();
    a.failNext();
    await expect(a.append({ type: "x.y" })).rejects.toMatchObject({ code: "INTERNAL" });
    expect((await a.append({ type: "x.y" })).seq).toBe(1);
    expect(a.ofType("x.*")).toHaveLength(1);
  });
});
