import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeAccountManager } from "./fake.mjs";
import { TOPICS, createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { MORNING_LOGIN_CONFIG_SCHEMA, createMorningLogin } from "./morningLogin.mjs";

const T = (iso) => Date.parse(iso);
// 2026-10-19 is a Monday; 2026-10-17 a Saturday.
const MON = "2026-10-19";
const SAT = "2026-10-17";

function setup({ start = `${MON}T08:30:00+05:30`, accountsList, config, dataDir = mkdtempSync(join(tmpdir(), "mcb-morning-")) } = {}) {
  const bus = createEventBus({ logger: createNullLogger(), topics: TOPICS });
  const events = [];
  bus.on("account.login_needed", (p) => events.push(p));
  let t = T(start);
  const accounts = createFakeAccountManager({
    accounts: accountsList ?? [
      { id: "dhan-main", label: "Dhan main", broker: "dhan", state: "expired" },
      { id: "zerodha-2", label: "Zerodha 2", broker: "zerodha", state: "connected", expiresAt: `${MON}T11:00:00+05:30` },
      { id: "angel", label: "Angel", broker: "angelone", state: "connected", expiresAt: "2026-10-20T06:00:00+05:30" },
      { id: "paper", broker: "paper" },
    ],
    bus,
  });
  const svc = createMorningLogin({ config: { morningLogin: config ?? {} }, logger: createNullLogger(), bus, clock: { now: () => t }, paths: { dataDir }, accounts }, { tickMs: 60_000 });
  return { svc, events, bus, accounts, dataDir, setNow: (iso) => (t = T(iso)), advance: (ms) => (t += ms) };
}

describe("morningLogin config", () => {
  it("defaults to 08:45 IST, on, with a 30 minute warning, and refuses unknown keys or bad times", () => {
    expect(MORNING_LOGIN_CONFIG_SCHEMA.parse({})).toEqual({ enabled: true, remindAt: "08:45", warnBeforeEndMinutes: 30 });
    expect(MORNING_LOGIN_CONFIG_SCHEMA.safeParse({ remindAt: "8:45" }).success).toBe(false);
    expect(MORNING_LOGIN_CONFIG_SCHEMA.safeParse({ nope: 1 }).success).toBe(false);
  });
});

describe("account.login_needed", () => {
  it("sends nothing before the reminder time, then one event per account that needs a login, with the label and no secrets", () => {
    const { svc, events, setNow } = setup();
    expect(svc.tick()).toBe(0);
    expect(events).toEqual([]);
    setNow(`${MON}T08:45:30+05:30`);
    expect(svc.tick()).toBe(2);
    expect(events).toEqual([
      { accountId: "dhan-main", label: "Dhan main", broker: "dhan", method: "apiKeyToken", reason: "expired", kind: "preopen" },
      { accountId: "zerodha-2", label: "Zerodha 2", broker: "zerodha", method: "apiKeyToken", reason: "ends_before_close", kind: "preopen", endsAt: `${MON}T11:00:00+05:30` },
    ]);
    // Paper never needs a login, and an account connected until tomorrow is not mentioned.
    expect(JSON.stringify(events)).not.toMatch(/paper|angel/);
    expect(JSON.stringify(events)).not.toMatch(/password|secret|\bpin\b|totp|accessToken|requestCode/i);
  });

  it("sends the daily reminder once, even if the clock ticks many times or the Bridge restarts the same day", () => {
    const first = setup({ start: `${MON}T08:46:00+05:30` });
    first.svc.tick();
    first.svc.tick();
    first.advance(600_000);
    first.svc.tick();
    expect(first.events.filter((e) => e.kind === "preopen")).toHaveLength(2);
    const restarted = setup({ start: `${MON}T09:05:00+05:30`, dataDir: first.dataDir });
    restarted.svc.tick();
    expect(restarted.events).toEqual([]);
    // The next trading day it sends again.
    restarted.setNow("2026-10-20T08:45:00+05:30");
    restarted.svc.tick();
    expect(restarted.events.some((e) => e.kind === "preopen")).toBe(true);
  });

  it("does nothing on a weekend or when switched off", () => {
    const weekend = setup({ start: `${SAT}T08:50:00+05:30` });
    expect(weekend.svc.tick()).toBe(0);
    const off = setup({ start: `${MON}T08:50:00+05:30`, config: { enabled: false } });
    expect(off.svc.tick()).toBe(0);
    expect(off.events).toEqual([]);
  });

  it("uses the configured time", () => {
    const { svc, events, setNow } = setup({ start: `${MON}T08:50:00+05:30`, config: { remindAt: "09:00" } });
    expect(svc.tick()).toBe(0);
    setNow(`${MON}T09:00:10+05:30`);
    svc.tick();
    expect(events.length).toBeGreaterThan(0);
  });

  it("warns again shortly before a session that ends before the close", () => {
    const { svc, events, setNow } = setup({ start: `${MON}T10:20:00+05:30`, config: { remindAt: "08:45" } });
    svc.tick(); // the morning reminder is late but still due: it goes out now
    events.length = 0;
    setNow(`${MON}T10:35:00+05:30`); // 25 minutes before 11:00
    svc.tick();
    expect(events).toEqual([{ accountId: "zerodha-2", label: "Zerodha 2", broker: "zerodha", method: "apiKeyToken", reason: "ends_before_close", kind: "ending_soon", endsAt: `${MON}T11:00:00+05:30` }]);
    svc.tick();
    expect(events).toHaveLength(1); // once per session
  });

  it("stops reminding after the close and when the warning is switched off", () => {
    const afterClose = setup({ start: `${MON}T15:40:00+05:30` });
    expect(afterClose.svc.tick()).toBe(0);
    const noWarn = setup({ start: `${MON}T10:40:00+05:30`, config: { warnBeforeEndMinutes: 0, remindAt: "23:00" } });
    expect(noWarn.svc.tick()).toBe(0);
  });

  it("plan() lists who needs a login without sending anything", () => {
    const { svc, events } = setup();
    expect(svc.plan().map((p) => [p.accountId, p.reason])).toEqual([["dhan-main", "expired"], ["zerodha-2", "ends_before_close"]]);
    expect(events).toEqual([]);
  });

  it("start() and stop() run a timer and never fire after stop", () => {
    const calls = [];
    const { bus, accounts } = setup();
    const svc = createMorningLogin(
      { config: {}, logger: createNullLogger(), bus, clock: { now: () => T(`${MON}T08:50:00+05:30`) }, accounts },
      { timers: { setInterval: (fn, ms) => (calls.push(["set", ms]), { unref() {}, fn }), clearInterval: () => calls.push(["clear"]) } },
    );
    svc.start();
    svc.start();
    svc.stop();
    expect(calls).toEqual([["set", 60_000], ["clear"]]);
  });
});
