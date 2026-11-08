/**
 * Demo readiness: every scenario gives the expected state and reason codes on the simulated demo account,
 * the samples follow it, scenarios restore themselves after 10 minutes, only documentation addresses are used, and the
 * check window is ignored (the demo works on a Sunday night).
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { DEMO_CHANGED_IP, DEMO_REGISTERED_IP, DEMO_SCENARIOS, createDemoReadiness, nextSixAmIst } from "./demoReadiness.mjs";

describe("demo readiness simulation (unit)", () => {
  it("uses documentation addresses only (RFC 5737)", () => {
    for (const ip of [DEMO_REGISTERED_IP, DEMO_CHANGED_IP]) expect(ip).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\./);
    const src = readFileSync(join(import.meta.dirname, "demoReadiness.mjs"), "utf8");
    const ips = src.match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) ?? [];
    for (const ip of ips) expect(ip).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\./);
  });

  it("the stated expiry is the next 06:00 IST", () => {
    expect(nextSixAmIst(Date.parse("2026-10-29T17:00:00+05:30"))).toBe(Date.parse("2026-10-30T06:00:00+05:30"));
    expect(nextSixAmIst(Date.parse("2026-10-29T05:00:00+05:30"))).toBe(Date.parse("2026-10-29T06:00:00+05:30"));
  });

  it("a scenario reverts by itself after restoreAfterMinutes", () => {
    let t = Date.parse("2026-11-01T21:00:00+05:30");
    const d = createDemoReadiness({ clock: { now: () => t }, safety: null });
    expect(d.apply("ip-changed")).toBe("ip-changed");
    expect(d.egress().detected.ip).toBe(DEMO_CHANGED_IP);
    t += 9 * 60_000;
    expect(d.scenario()).toBe("ip-changed");
    t += 61_000;
    expect(d.scenario()).toBeNull();
    expect(d.egress().detected.ip).toBe(DEMO_REGISTERED_IP);
    expect(() => d.apply("melt-down")).toThrow();
  });
});

describe("demo readiness on the demo app (Sunday evening)", () => {
  let app;
  let svc;
  const SUNDAY_9PM = Date.parse("2026-11-01T21:00:00+05:30");
  let offset = SUNDAY_9PM - Date.now();
  const clock = { now: () => Date.now() + offset };
  beforeAll(async () => {
    const { config } = loadConfig({ raw: { dataDir: mkdtempSync(join(tmpdir(), "mcb-demo-rd-")), logging: { level: "silent" } }, env: {}, demo: true });
    app = await createApp({ config, logger: createNullLogger(), clock });
    svc = app.deps.readiness;
  });
  afterAll(async () => {
    await app?.close();
  });

  it("starts ready (simulated) with two sample automations; the window is ignored", async () => {
    await svc.check({});
    const s = svc.status();
    expect(s.accounts.map((a) => a.accountId)).toEqual(["demo"]);
    expect(s.accounts[0]).toMatchObject({ state: "ready", simulated: true, live: { allowedByConfig: true, globalLiveTrading: "simulated" } });
    expect(s.accounts[0].checks.session).toMatchObject({ status: "pass", expirySource: "simulated", probe: "ok" });
    expect(s.accounts[0].automations.map((a) => [a.kind, a.mode, a.state])).toEqual([
      ["sample", "live", "ready"],
      ["sample", "live", "ready"],
    ]);
    expect(s.schedule).toMatchObject({ inWindow: true, tradingDay: true, intervalMinutes: 1 });
    expect(s.notifications.demoOff).toBe(true);
    // Demo mode never turns live trading on.
    expect(app.deps.config.safety.liveTrading).toBe(false);
  });

  const expected = {
    "session-expired": ["cannot_trade", ["SESSION_REJECTED"]],
    "session-expiring": ["warn", ["SESSION_EXPIRES_SOON"]],
    "ip-changed": ["cannot_trade", ["IP_MISMATCH"]],
    "ip-unchecked": ["warn", ["IP_UNCHECKED"]],
    "daily-loss-near": ["warn", ["DAILY_LOSS_NEAR"]],
    "daily-orders-exhausted": ["cannot_trade", ["DAILY_ORDERS_EXHAUSTED"]],
    restore: ["ready", []],
  };
  it("covers every scenario", () => {
    expect(Object.keys(expected).sort()).toEqual([...DEMO_SCENARIOS].sort());
  });
  for (const [scenario, [state, codes]] of Object.entries(expected)) {
    it(`${scenario} → ${state} ${codes.join(",")}`, async () => {
      const s = await svc.demoScenario(scenario);
      const a = s.accounts[0];
      expect(a.state).toBe(state);
      expect(a.reasons.map((r) => r.code)).toEqual(codes);
      expect(a.automations.every((x) => x.state === state)).toBe(true);
      await svc.demoScenario("restore");
    });
  }

  it("session-expiring: the simulated expiry is 25 minutes away (the market-close rule is ignored in the demo)", async () => {
    const s = await svc.demoScenario("session-expiring");
    expect([24, 25]).toContain(s.accounts[0].checks.session.expiresInMinutes);
    await svc.demoScenario("restore");
  });

  it("records the messages that would have been sent, and restores after 10 simulated minutes", async () => {
    await svc.demoScenario("ip-changed");
    const s = svc.status();
    expect(s.notifications.wouldHaveSent[0]).toMatchObject({ title: "Demo market data: cannot trade (simulated)" });
    expect(JSON.stringify(s.notifications.wouldHaveSent)).not.toMatch(/198\.51\.100|203\.0\.113/);
    offset += 10 * 60_000 + 1000;
    await svc.check({});
    expect(svc.status().accounts[0].state).toBe("ready");
  });

  it("engaging the real kill switch flips the simulated account at once", async () => {
    vi.useRealTimers();
    const ctx = { principal: { kind: "local", id: "cli" }, scopes: new Set(["admin"]), loopback: true, source: "cli", requestId: null };
    await app.deps.safety.engageKillSwitch(ctx, { reason: "demo test" });
    await svc.check({});
    expect(svc.status().accounts[0]).toMatchObject({ state: "cannot_trade", reasons: [expect.objectContaining({ code: "KILL_SWITCH" })] });
    await app.deps.safety.releaseKillSwitch(ctx, { confirm: "RELEASE" });
    await svc.check({});
    expect(svc.status().accounts[0].state).toBe("ready");
  });
});
