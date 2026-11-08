import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PORT, effectiveAccountLimits, liveAllowedByConfig, loadConfig, moduleSections, userBridgeDir } from "./config.mjs";

const load = (raw, env = {}) => loadConfig({ raw, env, cwd: "/tmp/mcb" });

describe("loadConfig", () => {
  it("has safe defaults: loopback, paper only, 5 orders/s", () => {
    const { config } = load({});
    expect(config.server).toMatchObject({ host: "127.0.0.1", port: DEFAULT_PORT, allowNonLoopback: false });
    expect(config.server.publicIngress.enabled).toBe(false);
    expect(config.cors.allowedOrigins).toEqual([]);
    expect(config.safety).toMatchObject({ liveTrading: false, orderRatePerSecond: 5, marketOrders: "protect", killSwitchOnStart: false });
    expect(config.dataDir).toBe("/tmp/mcb/data");
    expect(Object.isFrozen(config.safety)).toBe(true);
  });

  it("reads a config file and resolves dataDir next to it", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-cfg-"));
    writeFileSync(join(dir, "bridge.config.json"), JSON.stringify({ server: { port: 5000 }, dataDir: "state" }));
    const { config, source } = loadConfig({ env: {}, cwd: dir });
    expect(source).toBe(join(dir, "bridge.config.json"));
    expect(config.server.port).toBe(5000);
    expect(config.dataDir).toBe(join(dir, "state"));
  });

  it("warns when no file exists and errors when a named file is missing", () => {
    expect(loadConfig({ env: {}, cwd: mkdtempSync(join(tmpdir(), "mcb-none-")) }).warnings[0]).toMatch(/safe defaults/);
    expect(() => loadConfig({ env: { MCB_CONFIG: "/nope/x.json" } })).toThrow(/not found/);
  });

  it("without a config file in the folder, uses the per-user folder for config and data, never ./data", () => {
    const home = mkdtempSync(join(tmpdir(), "mcb-home-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "mcb-elsewhere-"));
    const none = loadConfig({ env: { MCB_HOME: home }, cwd: elsewhere });
    expect(none.source).toBeNull();
    expect(none.config.dataDir).toBe(join(home, "data"));
    expect(none.warnings[0]).toMatch(/safe defaults/);
    writeFileSync(join(home, "bridge.config.json"), JSON.stringify({ server: { port: 4999 }, dataDir: "state" }));
    const user = loadConfig({ env: { MCB_HOME: home }, cwd: elsewhere });
    expect(user.source).toBe(join(home, "bridge.config.json"));
    expect(user.config.server.port).toBe(4999);
    expect(user.config.dataDir).toBe(join(home, "state"));
    expect(userBridgeDir({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32")).toMatch(/MrChartist.Bridge$/);
  });

  it("rejects typos inside core sections", () => {
    expect(() => load({ safety: { liveTrade: true } })).toThrow(/Config is not valid/);
    expect(() => load({ server: { prot: 1 } })).toThrow(/Config is not valid/);
  });

  it("refuses a non-loopback bind unless allowNonLoopback is set, and then warns", () => {
    expect(() => load({ server: { host: "0.0.0.0" } })).toThrow(/not a loopback/);
    const { warnings } = load({ server: { host: "0.0.0.0", allowNonLoopback: true } });
    expect(warnings.join(" ")).toMatch(/not only on this computer/);
  });

  it("applies the same loopback rule to the public webhook listener", () => {
    expect(() => load({ server: { publicIngress: { enabled: true, host: "0.0.0.0" } } })).toThrow(/publicIngress\.host .* not a loopback/);
    expect(() => load({ server: { publicIngress: { enabled: false, host: "0.0.0.0" } } })).not.toThrow();
    const { warnings } = load({ server: { allowNonLoopback: true, publicIngress: { enabled: true, host: "0.0.0.0" } } });
    expect(warnings.join(" ")).toMatch(/webhook listener will listen on 0\.0\.0\.0/);
  });

  it("caps the order rate at the SEBI unregistered-algo ceiling of 10/s", () => {
    expect(() => load({ safety: { orderRatePerSecond: 11 } })).toThrow(/orderRatePerSecond/);
    expect(load({ safety: { orderRatePerSecond: 10 } }).config.safety.orderRatePerSecond).toBe(10);
    expect(() => load({ accounts: [{ id: "a1", broker: "dhan", limits: { orderRatePerSecond: 12 } }] })).toThrow();
  });

  it("environment can move the listener and tighten safety, never loosen it", () => {
    const { config } = load({ safety: { liveTrading: true } }, { MCB_PORT: "4400", MCB_LOG_LEVEL: "debug", MCB_PAPER_ONLY: "1", MCB_KILL_SWITCH: "true" });
    expect(config.server.port).toBe(4400);
    expect(config.logging.level).toBe("debug");
    expect(config.safety.liveTrading).toBe(false);
    expect(config.safety.killSwitchOnStart).toBe(true);
    expect(() => load({}, { MCB_PORT: "x" })).toThrow(/MCB_PORT/);
    expect(load({}, { MCB_LIVE_TRADING: "1" }).config.safety.liveTrading).toBe(false);
  });

  it("validates accounts: unique ids, known brokers, no live on paper accounts", () => {
    expect(() => load({ accounts: [{ id: "a1", broker: "dhan" }, { id: "a1", broker: "zerodha" }] })).toThrow(/Duplicate/);
    expect(() => loadConfig({ raw: { accounts: [{ id: "a1", broker: "nosuch" }] }, env: {}, knownBrokers: ["dhan"] })).toThrow(/unknown broker/);
    expect(() => load({ accounts: [{ id: "practice", broker: "paper", live: { enabled: true } }] })).toThrow(/paper account/);
    expect(() => load({ accounts: [{ id: "Bad Id", broker: "dhan" }] })).toThrow();
  });

  it("account defaults are conservative and warnings explain ineffective live flags", () => {
    const { config, warnings } = load({ accounts: [{ id: "a1", broker: "dhan", live: { enabled: true, allowedSources: ["rest", "mcp"] } }] });
    expect(config.accounts[0].marketData.pooling).toBe(false);
    expect(warnings.join(" ")).toMatch(/stays paper only/);
    expect(warnings.join(" ")).toMatch(/AI assistants/);
  });

  it("accepts the automation sources guard and alert (opt-in) and still refuses unknown sources", () => {
    const { config } = load({ accounts: [{ id: "a1", broker: "dhan", live: { enabled: false, allowedSources: ["rest", "guard", "alert"] } }] });
    expect(config.accounts[0].live.allowedSources).toEqual(["rest", "guard", "alert"]);
    expect(() => load({ accounts: [{ id: "a1", broker: "dhan", live: { allowedSources: ["robot"] } }] })).toThrow();
    const { config: dflt } = load({ accounts: [{ id: "a1", broker: "dhan" }] });
    expect(dflt.accounts[0].live.allowedSources).toEqual(["rest"]);
  });

  it("accepts live.backupIp (optional, ≤ 64 chars) next to registeredIp; registeredIp stays a free string", () => {
    const { config } = load({ accounts: [{ id: "zz", broker: "zerodha", live: { registeredIp: "203.0.113.10", backupIp: "198.51.100.7" } }] });
    expect(config.accounts[0].live).toMatchObject({ registeredIp: "203.0.113.10", backupIp: "198.51.100.7" });
    expect(load({ accounts: [{ id: "zz", broker: "zerodha", live: { registeredIp: "my office" } }] }).config.accounts[0].live.registeredIp).toBe("my office");
    expect(() => load({ accounts: [{ id: "zz", broker: "zerodha", live: { backupIp: "x".repeat(65) } }] })).toThrow();
  });

  it("keeps module sections for module schemas to validate", () => {
    const { config } = load({ hooks: { x: 1 } });
    expect(moduleSections(config)).toEqual(["hooks"]);
  });
});

describe("effective limits and live permission", () => {
  it("takes the stricter of global and account limits", () => {
    const { config } = load({ safety: { dailyMaxOrders: 50 }, accounts: [{ id: "a1", broker: "dhan", limits: { dailyMaxOrders: 80, maxOrderValue: 1000 } }] });
    expect(effectiveAccountLimits(config, config.accounts[0])).toMatchObject({ dailyMaxOrders: 50, maxOrderValue: 1000, orderRatePerSecond: 5 });
  });

  it("live needs the global switch AND the account flag", () => {
    const off = load({ accounts: [{ id: "a1", broker: "dhan", live: { enabled: true } }] }).config;
    expect(liveAllowedByConfig(off, off.accounts[0])).toBe(false);
    const on = load({ safety: { liveTrading: true }, accounts: [{ id: "a1", broker: "dhan", live: { enabled: true } }, { id: "a2", broker: "dhan" }] }).config;
    expect(liveAllowedByConfig(on, on.accounts[0])).toBe(true);
    expect(liveAllowedByConfig(on, on.accounts[1])).toBe(false);
  });
});

describe("server.remoteDashboard", () => {
  it("is refused unless demo mode is on", () => {
    expect(() => loadConfig({ raw: { server: { remoteDashboard: true } }, env: {} })).toThrow(/only allowed in demo mode/);
    const { config, warnings } = loadConfig({ raw: { demo: true, server: { remoteDashboard: true } }, env: {} });
    expect(config.server.remoteDashboard).toBe(true);
    expect(warnings.join(" ")).toMatch(/remoteDashboard is on/);
  });
});
