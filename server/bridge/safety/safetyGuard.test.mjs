/**
 * SafetyGuard (S9): every rule in check(), the order-rate window, daily counters per IST day, the kill switch
 * (boot, persistence, release rules, events), limits that only tighten, and restart persistence. Real files in a
 * temp dir, a hand-driven clock, the real AuditLog (so audit lines are checked end to end).
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../core/config.mjs";
import { createCallContext } from "../core/context.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createLogger, createNullLogger } from "../core/logger.mjs";
import { createAuditLog } from "./auditLog.mjs";
import { createSafetyGuard, rupees } from "./safetyGuard.mjs";

const MON_1000 = Date.UTC(2026, 9, 19, 4, 30); // Monday 2026-10-19 10:00 IST (market open)
const MON_0800 = Date.UTC(2026, 9, 19, 2, 30); // 08:00 IST (closed)
const SAT_1100 = Date.UTC(2026, 9, 24, 5, 30); // Saturday

function makeConfig({ safety = {}, accounts } = {}) {
  return loadConfig({
    raw: {
      dataDir: "/unused",
      safety: { liveTrading: true, ...safety },
      accounts: accounts ?? [
        { id: "dhan-main", broker: "dhan", live: { enabled: true, allowedSources: ["rest", "cli"], registeredIp: "203.0.113.7" } },
        { id: "zerodha-main", broker: "zerodha", limits: { dailyMaxOrders: 3, orderRatePerSecond: 2 } },
        { id: "paper", broker: "paper" },
        { id: "off", broker: "upstox", enabled: false },
      ],
    },
    env: {},
  }).config;
}

function setup({ t = MON_1000, config = makeConfig(), dataDir = mkdtempSync(join(tmpdir(), "mcb-safety-")), env = {}, audit, bus = createEventBus(), egressIp, logger = createNullLogger() } = {}) {
  const clock = { t, now: () => clock.t };
  const auditLog = audit ?? createAuditLog({ logger, bus, clock, paths: { dataDir } });
  const events = [];
  bus.on("safety.kill_switch", (p) => events.push({ topic: "safety.kill_switch", ...p }));
  bus.on("safety.limit", (p) => events.push({ topic: "safety.limit", ...p }));
  const make = () => createSafetyGuard({ config, logger, bus, clock, paths: { dataDir }, audit: auditLog, accounts: notImplementedService("accounts") }, { env, egressIp });
  return { guard: make(), make, clock, dataDir, audit: auditLog, events, bus, config };
}

const keyCtx = ({ scopes = ["paper"], accounts = "*", source = "rest", loopback = true, id = "k1" } = {}) => {
  const ctx = createCallContext({ source, key: { id, label: id, scopes, accounts }, log: createNullLogger() });
  ctx.loopback = loopback;
  return ctx;
};

const limitOrder = (over = {}) => ({ account: "dhan-main", symbol: "NSE:RELIANCE", side: "BUY", quantity: 10, product: "INTRADAY", orderType: "LIMIT", price: 2500, ...over });
const intent = (over = {}) => ({ accountId: "dhan-main", mode: "paper", action: "place", order: limitOrder(), source: "rest", keyId: "k1", quantity: 10, value: 25_000, ltp: 2500, ...over });
const codes = (v) => v.reasons.map((r) => r.code);
const rules = (v) => v.reasons.map((r) => r.rule);

describe("check(): basics", () => {
  it("allows a sane paper order", async () => {
    const { guard } = setup();
    expect(await guard.check(keyCtx(), intent())).toEqual({ ok: true, mode: "paper", reasons: [], warnings: [] });
  });

  it("refuses unknown, forbidden and disabled accounts", async () => {
    const { guard } = setup();
    expect(codes(await guard.check(keyCtx(), intent({ accountId: "nope" })))).toContain("ACCOUNT_NOT_FOUND");
    expect(codes(await guard.check(keyCtx({ accounts: ["zerodha-main"] }), intent()))).toContain("ACCOUNT_FORBIDDEN");
    expect(rules(await guard.check(keyCtx(), intent({ accountId: "off" })))).toContain("accountEnabled");
    expect(codes(await guard.check(keyCtx(), intent({ mode: "both", action: "buy" })))).toEqual(["VALIDATION_FAILED", "VALIDATION_FAILED"]);
  });

  it("returns every reason, not just the first", async () => {
    const config = makeConfig({ safety: { liveTrading: false, marketOrders: "reject" } });
    const { guard } = setup({ t: MON_0800, config });
    await guard.engageKillSwitch(keyCtx(), { reason: "test" });
    const v = await guard.check(
      keyCtx({ scopes: ["paper"], source: "webhook" }),
      intent({ mode: "live", source: "webhook", value: 5_00_000, order: limitOrder({ orderType: "MARKET", price: undefined, lots: 50 }) }),
    );
    expect(v.ok).toBe(false);
    expect(new Set(codes(v))).toEqual(new Set(["KILL_SWITCH_ACTIVE", "PAPER_ONLY", "SCOPE_REQUIRED", "INVALID_ORDER", "MARKET_CLOSED"]));
    expect(rules(v)).toEqual(expect.arrayContaining(["killSwitch", "liveTrading", "allowedSources", "liveScope", "maxOrderValue", "maxLotsPerOrder", "marketOrders", "marketHours"]));
  });
});

describe("check(): live enablement", () => {
  const live = (over = {}) => intent({ mode: "live", ...over });

  it("passes only with global switch, account switch, live key and an allowed source", async () => {
    const { guard } = setup();
    expect(await guard.check(keyCtx({ scopes: ["live"] }), live())).toMatchObject({ ok: true, mode: "live" });
  });

  it("refuses when safety.liveTrading is off (MCB_PAPER_ONLY)", async () => {
    const config = loadConfig({ raw: { dataDir: "/unused", safety: { liveTrading: true }, accounts: [{ id: "dhan-main", broker: "dhan", live: { enabled: true } }] }, env: { MCB_PAPER_ONLY: "1" } }).config;
    const { guard } = setup({ config });
    const v = await guard.check(keyCtx({ scopes: ["live"] }), live());
    expect(v.reasons).toEqual([expect.objectContaining({ code: "PAPER_ONLY", rule: "liveTrading" })]);
  });

  it("refuses an account without live.enabled, a paper account, a paper key and a disallowed source", async () => {
    const { guard } = setup();
    expect(rules(await guard.check(keyCtx({ scopes: ["live"] }), live({ accountId: "zerodha-main", order: limitOrder({ account: "zerodha-main" }) })))).toEqual(["liveEnabled"]);
    expect(rules(await guard.check(keyCtx({ scopes: ["live"] }), live({ accountId: "paper" })))).toContain("liveEnabled");
    expect(codes(await guard.check(keyCtx({ scopes: ["paper"] }), live()))).toEqual(["SCOPE_REQUIRED"]);
    const v = await guard.check(keyCtx({ scopes: ["live"], source: "mcp" }), live({ source: "mcp" }));
    expect(v.reasons).toEqual([expect.objectContaining({ code: "PAPER_ONLY", rule: "allowedSources" })]);
    expect(v.reasons[0].message).toMatch(/mcp/);
  });

  it("checks both the intent source and the context source", async () => {
    const { guard } = setup();
    const v = await guard.check(keyCtx({ scopes: ["live"], source: "webhook" }), live({ source: "rest" }));
    expect(rules(v)).toEqual(["allowedSources"]);
  });

  it("lets a live cancel through without config enablement but still needs the live scope", async () => {
    const { guard } = setup();
    expect((await guard.check(keyCtx({ scopes: ["live"] }), live({ accountId: "zerodha-main", action: "cancel", order: null }))).ok).toBe(true);
    expect(codes(await guard.check(keyCtx({ scopes: ["paper"] }), live({ action: "cancel", order: null })))).toEqual(["SCOPE_REQUIRED"]);
  });

  it("warns (never blocks) on a static-IP mismatch", async () => {
    const { guard } = setup({ egressIp: "198.51.100.9" });
    const v = await guard.check(keyCtx({ scopes: ["live"] }), live());
    expect(v.ok).toBe(true);
    expect(v.warnings.join(" ")).toMatch(/198\.51\.100\.9.*203\.0\.113\.7/);
    guard.setDetectedEgressIp("203.0.113.7");
    expect((await guard.check(keyCtx({ scopes: ["live"] }), live())).warnings).toEqual([]);
  });
});

describe("check(): order shape", () => {
  it("max value with Indian rupee formatting, and unknown value", async () => {
    const { guard } = setup();
    const v = await guard.check(keyCtx(), intent({ value: 2_50_000 }));
    expect(v.reasons[0]).toMatchObject({ code: "INVALID_ORDER", rule: "maxOrderValue" });
    expect(v.reasons[0].message).toContain("₹2,50,000");
    expect(v.reasons[0].message).toContain("₹2,00,000");
    expect(rupees(1234567.5)).toBe("₹12,34,567.5");
    expect((await guard.check(keyCtx(), intent({ value: null }))).warnings.join(" ")).toMatch(/value/);
    expect(rules(await guard.check(keyCtx({ scopes: ["live"] }), intent({ mode: "live", value: null })))).toEqual(["maxOrderValue"]);
  });

  it("max lots from lots, or from quantity and lot size", async () => {
    const { guard } = setup();
    const fno = limitOrder({ symbol: "NFO:NIFTY-2026-10-27-25000-CE", price: 100 });
    expect(rules(await guard.check(keyCtx(), intent({ order: { ...fno, lots: 11 }, ltp: 100, value: 1000 })))).toEqual(["maxLotsPerOrder"]);
    expect(rules(await guard.check(keyCtx(), intent({ order: fno, quantity: 825, lotSize: 75, ltp: 100, value: 1000 })))).toEqual(["maxLotsPerOrder"]);
    expect((await guard.check(keyCtx(), intent({ order: fno, quantity: 750, resolved: { lotSize: 75 }, ltp: 100, value: 1000 }))).ok).toBe(true);
    const unknown = await guard.check(keyCtx(), intent({ order: fno, quantity: 750, ltp: 100, value: 1000 }));
    expect(unknown.ok).toBe(true);
    expect(unknown.warnings.join(" ")).toMatch(/lot size/);
  });

  it("price band against LTP for price and trigger price", async () => {
    const { guard } = setup();
    expect((await guard.check(keyCtx(), intent({ order: limitOrder({ price: 2574 }) }))).ok).toBe(true); // 2.96%
    const v = await guard.check(keyCtx(), intent({ order: limitOrder({ orderType: "SL", price: 2400, triggerPrice: 2410 }) }));
    expect(rules(v)).toEqual(["priceBandPct", "priceBandPct"]);
    expect(v.reasons[0].message).toMatch(/4\.00% away/);
  });

  it("market-order policy: protect warns, reject refuses", async () => {
    const a = setup();
    const v = await a.guard.check(keyCtx(), intent({ order: limitOrder({ orderType: "MARKET", price: undefined }) }));
    expect(v.ok).toBe(true);
    expect(v.warnings.join(" ")).toMatch(/market protection of 2%/);
    const b = setup({ config: makeConfig({ safety: { marketOrders: "reject" } }) });
    expect(rules(await b.guard.check(keyCtx(), intent({ order: limitOrder({ orderType: "SL-M", price: undefined, triggerPrice: 2490 }) })))).toEqual(["marketOrders"]);
  });
});

describe("check(): market hours", () => {
  it("refuses live and warns paper outside NSE hours, including pre-open and weekends", async () => {
    for (const t of [MON_0800, Date.UTC(2026, 9, 19, 3, 35), SAT_1100]) {
      const { guard } = setup({ t });
      expect(rules(await guard.check(keyCtx({ scopes: ["live"] }), intent({ mode: "live" })))).toEqual(["marketHours"]);
      const p = await guard.check(keyCtx(), intent());
      expect(p.ok).toBe(true);
      expect(p.warnings.join(" ")).toMatch(/not open.*may stay open until trading resumes/);
    }
  });

  it("does not warn demo paper orders about a closed market (demo prices run round the clock, so they fill at once)", async () => {
    const config = { ...makeConfig(), demo: true };
    const { guard } = setup({ t: SAT_1100, config });
    const p = await guard.check(keyCtx(), intent());
    expect(p.ok).toBe(true);
    expect(p.warnings.join(" ")).not.toMatch(/not open|wait/);
    const mcx = await guard.check(keyCtx(), intent({ order: limitOrder({ symbol: "MCX:CRUDEOIL-2026-11-19-FUT" }) }));
    expect(mcx.warnings.join(" ")).not.toMatch(/outside its usual/);
  });

  it("allows cancels when closed; refuses live MCX/CDS outside their window, warns about holidays inside it", async () => {
    const { guard, clock } = setup({ t: MON_0800 });
    expect((await guard.check(keyCtx({ scopes: ["live"] }), intent({ mode: "live", action: "cancel", order: null }))).ok).toBe(true);
    const mcx = intent({ mode: "live", order: limitOrder({ symbol: "MCX:CRUDEOIL-2026-11-19-FUT" }) });
    const closed = await guard.check(keyCtx({ scopes: ["live"] }), mcx);
    expect(codes(closed)).toContain("MARKET_CLOSED");
    const paper = await guard.check(keyCtx(), { ...mcx, mode: "paper" });
    expect(paper.ok).toBe(true);
    clock.t = MON_1000;
    const open = await guard.check(keyCtx({ scopes: ["live"] }), mcx);
    expect(codes(open)).not.toContain("MARKET_CLOSED");
    expect(open.warnings.join(" ")).toMatch(/MCX holidays are not checked/);
    clock.t = Date.UTC(2026, 9, 19, 12, 0); // 17:30 IST: CDS closed, MCX open
    expect(codes(await guard.check(keyCtx({ scopes: ["live"] }), intent({ mode: "live", order: limitOrder({ symbol: "CDS:USDINR-2026-10-28-FUT" }) })))).toContain("MARKET_CLOSED");
    expect(codes(await guard.check(keyCtx({ scopes: ["live"] }), mcx))).not.toContain("MARKET_CLOSED");
  });
});

describe("order rate", () => {
  it("defaults to 5 per sliding second and counts place, modify and cancel alike", async () => {
    const { guard, clock, events } = setup();
    for (let n = 0; n < 5; n += 1) expect(guard.acquireOrderSlot("dhan-main").ok).toBe(true);
    const r = guard.acquireOrderSlot("dhan-main");
    expect(r.ok).toBe(false);
    expect(r.retryAfterMs).toBe(1000);
    const v = await guard.check(keyCtx({ scopes: ["live"] }), intent({ mode: "live", action: "cancel", order: null }));
    expect(v.reasons.find((x) => x.code === "ORDER_RATE_LIMITED")).toMatchObject({ code: "ORDER_RATE_LIMITED", retryAfterMs: 1000 });
    expect(events.some((e) => e.topic === "safety.limit" && e.limit === "orderRatePerSecond")).toBe(true);
    clock.t += 999;
    expect(guard.acquireOrderSlot("dhan-main").ok).toBe(false);
    clock.t += 1;
    expect(guard.acquireOrderSlot("dhan-main").ok).toBe(true);
  });

  it("uses the stricter account value and never exceeds 10/s", async () => {
    const { guard } = setup();
    expect(guard.acquireOrderSlot("zerodha-main").ok).toBe(true);
    expect(guard.acquireOrderSlot("zerodha-main").ok).toBe(true);
    expect(guard.acquireOrderSlot("zerodha-main").ok).toBe(false);
    expect(guard.limits("dhan-main").limits.orderRatePerSecond).toBe(5);
    // A config object that somehow carries 50/s (bypassing the schema) is still clamped to 10.
    const raw = makeConfig();
    const forced = { ...raw, safety: { ...raw.safety, orderRatePerSecond: 50 } };
    const b = setup({ config: forced });
    let ok = 0;
    for (let n = 0; n < 20; n += 1) if (b.guard.acquireOrderSlot("dhan-main").ok) ok += 1;
    expect(ok).toBe(10);
  });
});

describe("daily counters (IST day)", () => {
  it("counts placed orders per mode and refuses at the limit", async () => {
    const { guard, events } = setup();
    for (let n = 0; n < 3; n += 1) guard.recordOrderEvent("zerodha-main", { action: "place", mode: "paper", status: "filled" });
    guard.recordOrderEvent("zerodha-main", { action: "modify", mode: "paper", status: "open" });
    const v = await guard.check(keyCtx(), intent({ accountId: "zerodha-main" }));
    expect(v.reasons).toEqual([expect.objectContaining({ code: "DAILY_LIMIT_REACHED", rule: "dailyMaxOrders" })]);
    expect(events.filter((e) => e.topic === "safety.limit" && e.limit === "dailyMaxOrders")[0]).toMatchObject({ accountId: "zerodha-main", value: 3, threshold: 3 });
    // Modify and cancel still pass; live has its own count.
    expect((await guard.check(keyCtx(), intent({ accountId: "zerodha-main", action: "modify" }))).ok).toBe(true);
    expect(guard.limits("zerodha-main").usage.byMode.paper.orders).toBe(3);
    expect(guard.limits("zerodha-main").usage.ordersToday).toBe(0);
  });

  it("refuses new orders once today's realised loss reaches the limit", async () => {
    const { guard, audit } = setup();
    guard.recordOrderEvent("dhan-main", { action: "place", mode: "paper", status: "filled", realisedPnl: -6000 });
    expect((await guard.check(keyCtx(), intent())).ok).toBe(true);
    guard.recordOrderEvent("dhan-main", { action: "place", mode: "paper", status: "filled", realisedPnl: -4000 });
    const v = await guard.check(keyCtx(), intent());
    expect(v.reasons).toEqual([expect.objectContaining({ code: "DAILY_LIMIT_REACHED", rule: "dailyMaxLoss" })]);
    expect(v.reasons[0].message).toContain("₹10,000");
    await new Promise((r) => setImmediate(r));
    expect((await audit.query({ type: "safety.daily_loss_reached" })).items).toHaveLength(1);
  });

  it("resets at IST midnight, not UTC midnight", async () => {
    const { guard, clock } = setup({ t: Date.UTC(2026, 9, 19, 18, 0) }); // 23:30 IST on the 19th (UTC still the 19th)
    for (let n = 0; n < 3; n += 1) guard.recordOrderEvent("zerodha-main", { action: "place", mode: "paper", status: "filled" });
    expect(guard.limits("zerodha-main").usage.byMode.paper.orders).toBe(3);
    clock.t = Date.UTC(2026, 9, 19, 18, 31); // 00:01 IST on the 20th, UTC still the 19th
    expect(guard.limits("zerodha-main").usage.byMode.paper.orders).toBe(0);
    expect(guard.limits("zerodha-main").usage.day).toBe("2026-10-20");
  });

  it("rejects malformed events", () => {
    const { guard } = setup();
    expect(() => guard.recordOrderEvent("dhan-main", { action: "buy", mode: "paper" })).toThrow(/place\|modify\|cancel/);
  });
});

describe("restart persistence", () => {
  it("keeps the kill switch and today's counters across a restart", async () => {
    const a = setup();
    for (let n = 0; n < 3; n += 1) a.guard.recordOrderEvent("zerodha-main", { action: "place", mode: "live", status: "open", realisedPnl: -100 });
    await a.guard.engageKillSwitch(keyCtx(), { reason: "Runaway alert loop" });
    const b = a.make();
    expect(b.killSwitchStatus()).toMatchObject({ engaged: true, reason: "Runaway alert loop", by: "key:k1" });
    expect(b.limits("zerodha-main").usage).toMatchObject({ ordersToday: 3, realisedPnlToday: -300 });
    expect(codes(await b.check(keyCtx(), intent()))).toEqual(["KILL_SWITCH_ACTIVE"]);
  });

  it("keeps runtime-tightened limits for the rest of the day, then drops them", async () => {
    const a = setup();
    await a.guard.tightenLimits(keyCtx(), "dhan-main", { maxOrderValue: 50_000 });
    const b = a.make();
    expect(b.limits("dhan-main").limits.maxOrderValue).toBe(50_000);
    a.clock.t += 24 * 3_600_000;
    expect(b.limits("dhan-main").limits.maxOrderValue).toBe(2_00_000);
  });

  it("engages the kill switch when a state file is unreadable", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-safety-"));
    mkdirSync(join(dataDir, "safety"), { recursive: true });
    writeFileSync(join(dataDir, "safety", "kill-switch.json"), "{broken");
    expect(setup({ dataDir }).guard.killSwitchStatus()).toMatchObject({ engaged: true, by: "system:startup" });

    const d2 = mkdtempSync(join(tmpdir(), "mcb-safety-"));
    mkdirSync(join(d2, "safety"), { recursive: true });
    writeFileSync(join(d2, "safety", "counters.json"), "nope");
    const s = setup({ dataDir: d2 });
    expect(s.guard.killSwitchStatus().engaged).toBe(true);
    expect(s.guard.killSwitchStatus().reason).toMatch(/counters could not be read/);
  });
});

describe("limits only tighten at runtime", () => {
  it("accepts tighter values and refuses looser ones", async () => {
    const { guard, audit } = setup();
    expect((await guard.tightenLimits(keyCtx(), "dhan-main", { dailyMaxOrders: 10, orderRatePerSecond: 1, marketOrders: "reject" })).dailyMaxOrders).toBe(10);
    await expect(guard.tightenLimits(keyCtx(), "dhan-main", { dailyMaxOrders: 11 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(guard.tightenLimits(keyCtx(), "dhan-main", { marketOrders: "protect" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(guard.tightenLimits(keyCtx(), "dhan-main", { orderRatePerSecond: 0 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(guard.tightenLimits(keyCtx(), "dhan-main", { madeUp: 1 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const lim = guard.limits("dhan-main").limits;
    expect(lim).toMatchObject({ dailyMaxOrders: 10, orderRatePerSecond: 1, marketOrders: "reject" });
    expect(guard.acquireOrderSlot("dhan-main").ok).toBe(true);
    expect(guard.acquireOrderSlot("dhan-main").ok).toBe(false);
    expect((await audit.query({ type: "safety.limits_tightened" })).items).toHaveLength(1);
  });

  it("a global tightening applies to every account and cannot exceed any account's current value", async () => {
    const { guard } = setup();
    await expect(guard.tightenLimits(null, null, { dailyMaxOrders: 5 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" }); // zerodha-main is at 3
    await guard.tightenLimits(null, null, { dailyMaxOrders: 2, priceBandPct: 1 });
    expect(guard.limits("dhan-main").limits).toMatchObject({ dailyMaxOrders: 2, priceBandPct: 1 });
    expect(guard.limits("zerodha-main").limits.dailyMaxOrders).toBe(2);
    expect(rules(await guard.check(keyCtx(), intent({ order: limitOrder({ price: 2540 }) })))).toEqual(["priceBandPct"]);
  });
});

describe("kill switch", () => {
  it("any key engages it; cancels still pass; repeat engage keeps the first reason and can ask for cancellation", async () => {
    const { guard, events, audit } = setup();
    const s = await guard.engageKillSwitch(keyCtx({ scopes: ["read"] }), { reason: "Stop now" });
    expect(s).toMatchObject({ engaged: true, reason: "Stop now", by: "key:k1", at: "2026-10-19T10:00:00.000+05:30" });
    expect(codes(await guard.check(keyCtx(), intent()))).toEqual(["KILL_SWITCH_ACTIVE"]);
    expect(codes(await guard.check(keyCtx(), intent({ action: "modify" })))).toEqual(["KILL_SWITCH_ACTIVE"]);
    expect((await guard.check(keyCtx(), intent({ action: "cancel", order: null }))).ok).toBe(true);
    const again = await guard.engageKillSwitch(keyCtx({ id: "k2", scopes: ["live"] }), { reason: "Second", cancelOpenOrders: true });
    expect(again.reason).toBe("Stop now");
    expect(events.filter((e) => e.topic === "safety.kill_switch").map((e) => e.cancelOpenOrders)).toEqual([false, true]);
    const rows = (await audit.query({ type: "kill_switch.engaged" })).items;
    expect(rows.map((r) => r.data.alreadyEngaged)).toEqual([true, false]);
    await expect(guard.engageKillSwitch(keyCtx(), { reason: " " })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("release needs RELEASE, loopback, admin and a human source; it is audited and emitted", async () => {
    const { guard, events, audit } = setup();
    await guard.engageKillSwitch(keyCtx(), { reason: "x" });
    await expect(guard.releaseKillSwitch(keyCtx({ scopes: ["admin"] }), { confirm: "yes" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(guard.releaseKillSwitch(keyCtx({ scopes: ["admin"], loopback: false }), { confirm: "RELEASE" })).rejects.toMatchObject({ code: "LOOPBACK_ONLY" });
    await expect(guard.releaseKillSwitch(keyCtx({ scopes: ["live"] }), { confirm: "RELEASE" })).rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
    await expect(guard.releaseKillSwitch(keyCtx({ scopes: ["admin"], source: "mcp" }), { confirm: "RELEASE" })).rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
    await expect(guard.releaseKillSwitch(keyCtx({ scopes: ["admin"], source: "webhook" }), { confirm: "RELEASE" })).rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
    expect(guard.killSwitchStatus().engaged).toBe(true);
    const s = await guard.releaseKillSwitch(keyCtx({ scopes: ["admin"], id: "admin1" }), { confirm: "RELEASE" });
    expect(s).toEqual({ engaged: false, reason: null, by: null, at: null });
    expect(events.filter((e) => e.topic === "safety.kill_switch").at(-1)).toMatchObject({ engaged: false, by: "key:admin1", cancelOpenOrders: false });
    expect((await audit.query({ type: "kill_switch.released" })).items[0]).toMatchObject({ actor: { kind: "key", id: "admin1" }, data: { previousReason: "x" } });
    // Releasing when already off is a no-op.
    expect((await guard.releaseKillSwitch(keyCtx({ scopes: ["admin"] }), { confirm: "RELEASE" })).engaged).toBe(false);
  });

  it("the local CLI may release from this computer", async () => {
    const { guard } = setup();
    await guard.engageKillSwitch(keyCtx(), { reason: "x" });
    const cli = createCallContext({ source: "cli", principal: { kind: "local", id: "cli" }, log: createNullLogger() });
    expect((await guard.releaseKillSwitch(cli, { confirm: "RELEASE" })).engaged).toBe(false);
  });

  it("stays engaged when the release cannot be audited", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-safety-"));
    const failing = { append: async () => { throw new Error("disk full"); }, query: async () => ({ items: [], nextCursor: null }), verify: async () => ({ ok: true, checked: 0, brokenAt: null }) };
    const { guard } = setup({ dataDir, audit: failing });
    await guard.engageKillSwitch(keyCtx(), { reason: "x" }); // engaging still works when audit fails
    await expect(guard.releaseKillSwitch(keyCtx({ scopes: ["admin"] }), { confirm: "RELEASE" })).rejects.toMatchObject({ code: "INTERNAL" });
    expect(guard.killSwitchStatus().engaged).toBe(true);
  });

  it("is engaged at boot by killSwitchOnStart or MCB_KILL_SWITCH, and audited", async () => {
    const a = setup({ config: makeConfig({ safety: { killSwitchOnStart: true } }) });
    expect(a.guard.killSwitchStatus()).toMatchObject({ engaged: true, by: "system:startup" });
    await new Promise((r) => setImmediate(r));
    expect((await a.audit.query({ type: "kill_switch.engaged" })).items[0]).toMatchObject({ actor: { kind: "system", id: "startup" } });
    const b = setup({ env: { MCB_KILL_SWITCH: "1" } });
    expect(b.guard.killSwitchStatus().engaged).toBe(true);
    const fromEnv = loadConfig({ raw: { dataDir: "/unused" }, env: { MCB_KILL_SWITCH: "true" } }).config;
    expect(setup({ config: fromEnv }).guard.killSwitchStatus().engaged).toBe(true);
    expect(setup().guard.killSwitchStatus().engaged).toBe(false);
  });
});

describe("audit of refusals", () => {
  it("audits refusals once per second per identical reason set, with a suppressed count", async () => {
    const { guard, clock, audit } = setup();
    await guard.engageKillSwitch(keyCtx(), { reason: "x" });
    for (let n = 0; n < 5; n += 1) await guard.check(keyCtx(), intent());
    clock.t += 1000;
    await guard.check(keyCtx(), intent());
    await new Promise((r) => setImmediate(r));
    const rows = (await audit.query({ type: "safety.refused" })).items;
    expect(rows).toHaveLength(2);
    expect(rows[0].data).toMatchObject({ suppressed: 4, action: "place", mode: "paper", symbol: "NSE:RELIANCE", reasons: [{ code: "KILL_SWITCH_ACTIVE", rule: "killSwitch" }] });
    expect(rows[0]).toMatchObject({ accountId: "dhan-main", actor: { kind: "key", id: "k1" }, source: "rest" });
  });

  it("tolerates the audit stub", async () => {
    const lines = [];
    const logger = createLogger({ write: (l) => lines.push(JSON.parse(l)) });
    const { guard } = setup({ audit: notImplementedService("audit"), logger });
    await guard.engageKillSwitch(keyCtx(), { reason: "x" });
    expect((await guard.check(keyCtx(), intent())).ok).toBe(false);
    expect(lines.some((l) => /not audited/.test(l.msg))).toBe(true);
  });
});

describe("status()", () => {
  it("lists only the accounts the caller may see", () => {
    const { guard } = setup();
    const s = guard.status((id) => id === "dhan-main");
    expect(s).toMatchObject({ killSwitch: { engaged: false }, liveTrading: true, day: "2026-10-19" });
    expect(s.accounts).toEqual([expect.objectContaining({ accountId: "dhan-main", liveAllowedByConfig: true, ordersToday: 0, realisedPnlToday: 0 })]);
    expect(s.accounts[0].limits).toMatchObject({ orderRatePerSecond: 5, dailyMaxOrders: 100 });
  });

  it("keeps the state files owner-only and secret-free", async () => {
    const { guard, dataDir } = setup();
    await guard.engageKillSwitch(keyCtx(), { reason: "x" });
    guard.recordOrderEvent("dhan-main", { action: "place", mode: "paper" });
    const text = readFileSync(join(dataDir, "safety", "kill-switch.json"), "utf8") + readFileSync(join(dataDir, "safety", "counters.json"), "utf8");
    expect(text).not.toMatch(/mcb_|password|token/i);
  });
});

describe("review regressions", () => {
  it("paper orders have their own order-rate window with the same cap", async () => {
    const { guard } = setup();
    for (let n = 0; n < 5; n += 1) expect(guard.acquireOrderSlot("dhan-main", { mode: "paper" }).ok).toBe(true);
    expect(guard.acquireOrderSlot("dhan-main", { mode: "paper" }).ok).toBe(false);
    // The live window is untouched by paper orders.
    expect(guard.acquireOrderSlot("dhan-main").ok).toBe(true);
    expect(codes(await guard.check(keyCtx(), intent()))).toContain("ORDER_RATE_LIMITED");
  });

  it("a passing place check with reserve:true holds a daily-count slot until the order is recorded", async () => {
    const { guard } = setup();
    // zerodha-main allows 3 orders a day.
    const z = (over = {}) => intent({ accountId: "zerodha-main", order: limitOrder({ account: "zerodha-main" }), reserve: true, ...over });
    for (let n = 0; n < 3; n += 1) expect((await guard.check(keyCtx(), z())).ok).toBe(true);
    expect(codes(await guard.check(keyCtx(), z()))).toContain("DAILY_LIMIT_REACHED");
    // Recording converts reservations into counted orders: still at the limit.
    for (let n = 0; n < 3; n += 1) guard.recordOrderEvent("zerodha-main", { action: "place", mode: "paper", status: "open" });
    expect(codes(await guard.check(keyCtx(), z({ reserve: false })))).toContain("DAILY_LIMIT_REACHED");
  });

  it("reservations that are never recorded expire", async () => {
    const { guard, clock } = setup();
    const z = intent({ accountId: "zerodha-main", order: limitOrder({ account: "zerodha-main" }), reserve: true });
    for (let n = 0; n < 3; n += 1) await guard.check(keyCtx(), z);
    clock.t += 31_000;
    expect((await guard.check(keyCtx(), z)).ok).toBe(true);
  });

  it("recordRealisedPnl and paper fill events count towards the daily loss", async () => {
    const { guard, bus } = setup();
    bus.emit("order.updated", { orderId: "P1", accountId: "dhan-main", mode: "paper", status: "filled", filledQuantity: 1, source: "rest", realisedPnl: -6000 });
    guard.recordRealisedPnl("dhan-main", "paper", -4000);
    expect(codes(await guard.check(keyCtx(), intent()))).toContain("DAILY_LIMIT_REACHED");
  });

  it("syncDayPnl sets the live day P&L from a broker total", async () => {
    const { guard } = setup();
    guard.syncDayPnl("dhan-main", "live", -12_000);
    expect(guard.limits("dhan-main").usage.realisedPnlToday).toBe(-12_000);
    guard.syncDayPnl("dhan-main", "live", -500);
    expect(guard.limits("dhan-main").usage.realisedPnlToday).toBe(-500);
  });

  it("a live modify with a price and no LTP is refused (price band cannot be checked)", async () => {
    const { guard } = setup();
    const v = await guard.check(keyCtx({ scopes: ["live"] }), intent({ mode: "live", action: "modify", ltp: null }));
    expect(v.reasons.find((r) => r.rule === "priceBandPct")).toBeTruthy();
    const noValue = await guard.check(keyCtx({ scopes: ["live"] }), intent({ mode: "live", action: "modify", value: null, order: limitOrder({ orderType: "SL-M", price: undefined, triggerPrice: undefined }) }));
    expect(noValue.reasons.find((r) => r.rule === "maxOrderValue")).toBeTruthy();
  });

  it("cancelOpenOrders needs the live scope and is limited to the caller's accounts and Bridge orders", async () => {
    const { guard, events } = setup();
    const read = await guard.engageKillSwitch(keyCtx({ scopes: ["read"] }), { reason: "x", cancelOpenOrders: true });
    expect(read.warnings.join(" ")).toMatch(/NOT cancelled/);
    expect(events.at(-1)).toMatchObject({ cancelOpenOrders: false });
    await guard.engageKillSwitch(keyCtx({ scopes: ["live"], accounts: ["dhan-main"] }), { reason: "y", cancelOpenOrders: true, includeExternal: true });
    expect(events.at(-1)).toMatchObject({ cancelOpenOrders: true, cancelScope: { accounts: ["dhan-main"], includeExternal: false } });
    await guard.engageKillSwitch(keyCtx({ scopes: ["admin"] }), { reason: "z", cancelOpenOrders: true, includeExternal: true });
    expect(events.at(-1)).toMatchObject({ cancelOpenOrders: true, cancelScope: { accounts: "*", includeExternal: true } });
  });
});
