/**
 * Readiness monitor (p1-05 §3.2, §10.1): timers, bus triggers, probe cooldown and singleflight, egress feed to safety,
 * trading.readiness payloads and notify decisions, audit, persisted state. Fake timers, fake services, no network.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { parseReadinessConfig } from "./config.mjs";
import { createReadinessService } from "./monitor.mjs";

const T = (s) => Date.parse(s);
const MON_0840 = T("2026-10-19T08:40:00+05:30");
const MON_1000 = T("2026-10-19T10:00:00+05:30");

function harness({ readiness = {}, accounts: accs, liveTrading = true, egress, audit, dataDir = mkdtempSync(join(tmpdir(), "mcb-rd-")), notifyTargets = [], session = {} } = {}) {
  const config = {
    demo: false,
    safety: { liveTrading },
    accounts: accs ?? [{ id: "zerodha-main", broker: "zerodha", label: "Main", enabled: true, live: { enabled: true, allowedSources: ["rest", "webhook"], registeredIp: "203.0.113.10" } }],
    readiness: parseReadinessConfig(readiness),
    notify: { targets: notifyTargets },
  };
  const bus = createEventBus();
  const sessions = new Map(config.accounts.map((a) => [a.id, { state: "connected", expiresAt: null, message: null, ...session }]));
  const accounts = {
    status: vi.fn((id) => sessions.get(id)),
    testConnection: vi.fn(async () => ({ ok: true, message: "ok" })),
  };
  const scheduler = {
    schedule: vi.fn((opts, fn) => fn()),
    headroom: () => ({ remaining: 10, limit: 10, resetMs: 0 }),
    policyFor: () => ({ limits: { portfolio: { perSecond: 10 }, order: { perSecond: 10, verified: true } } }),
    usage: () => ({ accounts: [] }),
  };
  let ks = { engaged: false, reason: null, by: null, at: null };
  const usage = { ordersToday: 0, realisedPnlToday: 0, ordersLastSecond: 0 };
  const safety = {
    limits: () => ({ limits: { orderRatePerSecond: 5, dailyMaxOrders: 100, dailyMaxLoss: 10000 }, usage: { ...usage } }),
    killSwitchStatus: () => ks,
    setDetectedEgressIp: vi.fn(),
  };
  const auditLog = audit === undefined ? { append: vi.fn(async () => ({})) } : audit;
  const events = [];
  bus.on("trading.readiness", (p) => events.push(p));
  const deps = { config, logger: createNullLogger(), bus, clock: { now: () => Date.now() }, paths: { dataDir }, accounts, scheduler, safety, audit: auditLog };
  const make = (opts = {}) => createReadinessService(deps, { jitterSeconds: 0, egress, ...opts });
  return {
    deps,
    make,
    bus,
    accounts,
    scheduler,
    safety,
    events,
    audit: auditLog,
    dataDir,
    sessions,
    usage,
    setKillSwitch: (v) => {
      ks = v;
    },
  };
}

const fakeEgress = (answer) => {
  const lookup = vi.fn(async () => (typeof answer === "function" ? answer() : answer));
  return { lookup, seenBy: "api.ipify.org" };
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("readiness monitor timers", () => {
  it("startup outside the window: state only, no broker call (unknown until probed)", async () => {
    vi.setSystemTime(T("2026-10-19T07:00:00+05:30"));
    const h = harness();
    const svc = h.make();
    svc.start();
    await vi.advanceTimersByTimeAsync(20_100);
    expect(h.accounts.testConnection).not.toHaveBeenCalled();
    expect(svc.status().accounts[0].state).toBe("unknown");
    svc.stop();
  });

  it("cycles only inside the window on trading days, every intervalMinutes", async () => {
    vi.setSystemTime(MON_0840);
    const h = harness();
    const svc = h.make();
    svc.start();
    await vi.advanceTimersByTimeAsync(4 * 60_000); // 08:44: before the window
    expect(h.accounts.testConnection).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(2 * 60_000); // 08:46: first cycle at the 08:45 tick
    expect(h.accounts.testConnection).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8 * 60_000); // 08:54
    expect(h.accounts.testConnection.mock.calls.length).toBeGreaterThanOrEqual(3);
    svc.stop();

    vi.setSystemTime(T("2026-10-18T10:00:00+05:30")); // Sunday
    const s2 = harness();
    const svc2 = s2.make();
    svc2.start();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(s2.accounts.testConnection).not.toHaveBeenCalled();
    svc2.stop();
  });

  it("pre-open runs once per IST day, notifies failing accounts, and is persisted across a restart", async () => {
    vi.setSystemTime(T("2026-10-19T08:58:00+05:30"));
    const h = harness({ readiness: { egressIp: { mode: "lookup", lookupUrl: "https://api.ipify.org" } }, egress: fakeEgress({ ok: true, ip: "198.51.100.23", family: "ipv4", at: Date.now(), seenBy: "api.ipify.org" }) });
    const svc = h.make();
    svc.start();
    await vi.advanceTimersByTimeAsync(3 * 60_000); // past 09:00
    const pre = h.events.filter((e) => e.kind === "preopen");
    expect(pre).toHaveLength(1);
    expect(pre[0]).toMatchObject({ notify: true, cannotTrade: 1, holidayCaveat: expect.stringMatching(/holiday list/) });
    expect(JSON.stringify(pre[0])).not.toContain("198.51.100.23");
    expect(h.audit.append).toHaveBeenCalledWith(expect.objectContaining({ type: "readiness.preopen", data: { accounts: 1, failing: ["zerodha-main"] } }));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.events.filter((e) => e.kind === "preopen")).toHaveLength(1);
    svc.stop();
    // Restart at 09:15: no second pre-open run today.
    const svc2 = h.make();
    svc2.start();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(h.events.filter((e) => e.kind === "preopen")).toHaveLength(1);
    svc2.stop();
  });

  it("an all-ready pre-open is not notified when preopenOnlyIfFailing", async () => {
    vi.setSystemTime(T("2026-10-19T08:59:00+05:30"));
    const h = harness({ accounts: [{ id: "dhan-main", broker: "dhan", enabled: true, live: { enabled: true, allowedSources: ["rest"] } }] });
    const svc = h.make();
    svc.start();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(h.events.filter((e) => e.kind === "preopen")).toHaveLength(0);
    expect(h.audit.append).toHaveBeenCalledWith(expect.objectContaining({ type: "readiness.preopen" }));
    svc.stop();
  });
});

describe("readiness monitor triggers and probes", () => {
  it("bus triggers re-evaluate within the 250 ms debounce", async () => {
    vi.setSystemTime(MON_1000);
    const h = harness();
    const svc = h.make();
    svc.start();
    await svc.check({});
    expect(svc.status().accounts[0].state).toBe("warn"); // registered IP set, lookup off → IP_UNCHECKED
    h.setKillSwitch({ engaged: true, reason: "manual", by: "me", at: "x" });
    h.bus.emit("safety.kill_switch", { engaged: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(svc.status().accounts[0].state).toBe("cannot_trade");
    expect(svc.status().accounts[0].reasons[0].code).toBe("KILL_SWITCH");

    h.setKillSwitch({ engaged: false });
    h.bus.emit("safety.kill_switch", { engaged: false });
    await vi.advanceTimersByTimeAsync(300);
    h.usage.ordersToday = 100;
    h.bus.emit("safety.limit", { accountId: "zerodha-main", limit: "dailyMaxOrders" });
    await vi.advanceTimersByTimeAsync(300);
    expect(svc.status().accounts[0].reasons.map((r) => r.code)).toContain("DAILY_ORDERS_EXHAUSTED");
    h.usage.ordersToday = 0;

    h.bus.emit("account.session_rejected", { accountId: "zerodha-main", broker: "zerodha", code: "SESSION_EXPIRED" });
    await vi.advanceTimersByTimeAsync(300);
    expect(svc.status().accounts[0].reasons[0].code).toBe("SESSION_REJECTED");

    // A new session: account.status connected → probe afresh → recovered.
    const calls = h.accounts.testConnection.mock.calls.length;
    h.bus.emit("account.status", { accountId: "zerodha-main", broker: "zerodha", session: "connected" });
    await vi.advanceTimersByTimeAsync(300);
    expect(h.accounts.testConnection.mock.calls.length).toBe(calls + 1);
    expect(svc.status().accounts[0].state).toBe("warn");
    svc.stop();
  });

  it("probe cooldown (30 s) and singleflight per account", async () => {
    vi.setSystemTime(MON_1000);
    const h = harness();
    let release;
    h.accounts.testConnection.mockImplementation(() => new Promise((r) => (release = () => r({ ok: true }))));
    const svc = h.make();
    const a = svc.check({});
    const b = svc.check({});
    await vi.advanceTimersByTimeAsync(10);
    release();
    await Promise.all([a, b]);
    expect(h.accounts.testConnection).toHaveBeenCalledTimes(1);
    expect(h.scheduler.schedule).toHaveBeenCalledWith(expect.objectContaining({ accountId: "zerodha-main", endpointClass: "portfolio", priority: "background", backgroundShare: 0.5 }), expect.any(Function));
    h.accounts.testConnection.mockResolvedValue({ ok: true });
    const r = await svc.checkNow({});
    expect(r.skipped).toEqual(["probe:zerodha-main:cooldown"]);
    expect(h.accounts.testConnection).toHaveBeenCalledTimes(1);
    vi.setSystemTime(MON_1000 + 31_000);
    await svc.checkNow({});
    expect(h.accounts.testConnection).toHaveBeenCalledTimes(2);
  });

  it("checkNow answers after at most 12 s, with the slow part still unknown", async () => {
    vi.setSystemTime(MON_1000);
    const h = harness({ readiness: { probe: { timeoutMs: 30_000 } } });
    h.accounts.testConnection.mockImplementation(() => new Promise(() => {}));
    const svc = h.make();
    let done = null;
    svc.checkNow({}).then((r) => (done = r));
    await vi.advanceTimersByTimeAsync(11_900);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(done.snapshot.accounts[0].state).toBe("unknown");
    expect(done.snapshot.accounts[0].checks.session).toMatchObject({ status: "unknown", message: "Still checking" });
  });

  it("a probe that times out is a warn (PROBE_FAILED), not a failure", async () => {
    vi.setSystemTime(MON_1000);
    const h = harness({ readiness: { probe: { timeoutMs: 1000 } } });
    h.accounts.testConnection.mockImplementation(() => new Promise(() => {}));
    const svc = h.make();
    const p = svc.check({});
    await vi.advanceTimersByTimeAsync(1100);
    await p;
    expect(svc.status().accounts[0].reasons.map((r) => r.code)).toContain("PROBE_FAILED");
    expect(svc.status().accounts[0].state).toBe("warn");
  });
});

describe("readiness egress, events, audit and storage", () => {
  it("feeds safety.setDetectedEgressIp with the detected IP, and with null when the mode is off", async () => {
    vi.setSystemTime(MON_1000);
    const h = harness({ readiness: { egressIp: { mode: "lookup", lookupUrl: "https://api.ipify.org" } }, egress: fakeEgress({ ok: true, ip: "198.51.100.23", family: "ipv4", at: MON_1000, seenBy: "api.ipify.org" }) });
    const svc = h.make();
    await svc.check({});
    expect(h.safety.setDetectedEgressIp).toHaveBeenCalledWith("198.51.100.23");
    expect(svc.status().accounts[0].reasons[0].code).toBe("IP_MISMATCH");
    const off = harness();
    off.make().start();
    expect(off.safety.setDetectedEgressIp).toHaveBeenCalledWith(null);
  });

  it("emits trading.readiness with the notify decision (§7.7), appends readiness.changed, never carries the IP", async () => {
    vi.setSystemTime(MON_1000);
    let ip = "203.0.113.10";
    const h = harness({ readiness: { egressIp: { mode: "lookup", lookupUrl: "https://api.ipify.org" } }, egress: fakeEgress(() => ({ ok: true, ip, family: "ipv4", at: Date.now(), seenBy: "api.ipify.org" })) });
    const svc = h.make();
    await svc.check({});
    expect(svc.status().accounts[0].state).toBe("ready");
    ip = "198.51.100.23";
    vi.setSystemTime(MON_1000 + 60_000);
    await svc.check({});
    const change = h.events.at(-1);
    expect(change).toMatchObject({ accountId: "zerodha-main", state: "cannot_trade", previous: "ready", kind: "change", notify: true });
    expect(JSON.stringify(h.events)).not.toMatch(/198\.51\.100\.23|203\.0\.113\.10|ipify/);
    expect(h.audit.append).toHaveBeenCalledWith(expect.objectContaining({ type: "readiness.changed", accountId: "zerodha-main", data: { from: "ready", to: "cannot_trade", codes: ["IP_MISMATCH"] } }));
    // Same key 4 min later: no new event at all (nothing changed).
    const n = h.events.length;
    vi.setSystemTime(MON_1000 + 5 * 60_000);
    await svc.check({});
    expect(h.events.length).toBe(n);
    // Recovered.
    ip = "203.0.113.10";
    vi.setSystemTime(MON_1000 + 9 * 60_000);
    await svc.check({});
    expect(h.events.at(-1)).toMatchObject({ state: "ready", kind: "recovered", notify: true });
    expect(svc.history({}).map((t) => `${t.from}>${t.to}`)).toEqual(["cannot_trade>ready", "ready>cannot_trade", "unknown>ready"]);
  });

  it("a stub audit log is skipped softly; a failing one never throws", async () => {
    vi.setSystemTime(MON_1000);
    const h = harness({ audit: { append: vi.fn(async () => { throw new Error("disk full"); }) } });
    const svc = h.make();
    await expect(svc.check({})).resolves.toBeTruthy();
    const h2 = harness({ audit: null });
    await expect(h2.make().check({})).resolves.toBeTruthy();
  });

  it("state.json: 0600, no egress IP, transitions kept; a corrupt file is renamed and a fresh state used", async () => {
    vi.setSystemTime(MON_1000);
    const h = harness({ readiness: { egressIp: { mode: "lookup", lookupUrl: "https://api.ipify.org" } }, egress: fakeEgress({ ok: true, ip: "198.51.100.23", family: "ipv4", at: MON_1000, seenBy: "api.ipify.org" }) });
    const svc = h.make();
    await svc.check({});
    const file = join(h.dataDir, "readiness", "state.json");
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("198.51.100.23");
    expect(text).not.toContain("203.0.113.10");
    const state = JSON.parse(text);
    expect(state.accounts["zerodha-main"].state).toBe("cannot_trade");
    expect(state.egress.matchesByAccount).toEqual({ "zerodha-main": false });
    if (process.platform !== "win32") {
      const { statSync } = await import("node:fs");
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }

    const dir = mkdtempSync(join(tmpdir(), "mcb-rd-corrupt-"));
    mkdirSync(join(dir, "readiness"), { recursive: true });
    writeFileSync(join(dir, "readiness", "state.json"), "{not json");
    const c = harness({ dataDir: dir });
    const svc2 = c.make();
    expect(svc2.status().accounts[0].state).toBe("unknown");
    expect(readdirSync(join(dir, "readiness")).some((f) => f.startsWith("state.json.corrupt-"))).toBe(true);
    await svc2.check({});
    expect(existsSync(join(dir, "readiness", "state.json"))).toBe(true);
  });
});

describe("readiness contract helpers", () => {
  it("canTrade: paper always ok; unknown accounts are paper_only; stale state is flagged", async () => {
    vi.setSystemTime(MON_1000);
    const h = harness();
    const svc = h.make();
    expect(svc.canTrade("zerodha-main", { mode: "paper" })).toMatchObject({ ok: true, state: "ready" });
    expect(svc.canTrade("nobody", { mode: "live" })).toMatchObject({ ok: true, state: "paper_only" });
    expect(svc.canTrade("zerodha-main", { mode: "live" })).toMatchObject({ state: "unknown", stale: true, ok: false });
    await svc.check({});
    expect(svc.canTrade("zerodha-main", { mode: "live" })).toMatchObject({ state: "warn", stale: false, ok: true });
    vi.setSystemTime(MON_1000 + 11 * 60_000);
    expect(svc.canTrade("zerodha-main", { mode: "live" })).toMatchObject({ state: "unknown", stale: true });
    const fresh = await svc.ensureFresh("zerodha-main", {});
    expect(fresh).toMatchObject({ state: "warn", stale: false });
  });

  it("disabled: status says so, canTrade is ok with a reason, no timers", () => {
    vi.setSystemTime(MON_1000);
    const h = harness({ readiness: { enabled: false } });
    const svc = h.make();
    svc.start();
    expect(svc.status()).toMatchObject({ overall: "unknown", disabled: true });
    expect(svc.canTrade("zerodha-main", { mode: "live" })).toMatchObject({ ok: true, disabled: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an account not allowed live is paper_only and does not count towards overall", async () => {
    vi.setSystemTime(MON_1000);
    const h = harness({ liveTrading: false });
    const svc = h.make();
    await svc.check({});
    const s = svc.status();
    expect(s.accounts[0].state).toBe("paper_only");
    expect(s.accounts[0].reasons[0].code).toBe("LIVE_OFF");
    expect(s).toMatchObject({ overall: "paper_only", paperOnly: true });
    expect(s.notifications.warning).toMatch(/No notification target listens to trading\.readiness/);
  });

  it("registerAutomation: onState on every state change of its account", async () => {
    vi.useRealTimers();
    const h = harness();
    const svc = h.make();
    const seen = [];
    svc.registerAutomation({ id: "g1", kind: "guard", accountId: "zerodha-main", mode: "live", label: "G", onState: (s) => seen.push(s.state) });
    await svc.check({});
    h.setKillSwitch({ engaged: true, reason: "x" });
    await svc.check({});
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual(["warn", "cannot_trade"]);
    expect(svc.status().automations).toEqual({ total: 1, live: 1, cannotTrade: 1 });
  });
});
