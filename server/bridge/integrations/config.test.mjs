import { describe, expect, it } from "vitest";
import { applyModuleConfig } from "../core/modules.mjs";
import { loadConfig } from "../core/config.mjs";
import { INTEGRATIONS_CONFIG_SCHEMA, parseIntegrationsConfig } from "./config.mjs";
import { countbackRange, sessionMinutes, usDstInEffect } from "../market/history.mjs";
import integrations from "./module.mjs";

describe("integrations config", () => {
  it("defaults everything from {}", () => {
    const c = parseIntegrationsConfig({});
    expect(c.xl).toEqual({ chainFormat: "csv", historyLayout: "standard", defaultCountback: 500, maxSymbols: 100, cacheSeconds: 5 });
    expect(parseIntegrationsConfig(undefined)).toEqual(c);
  });

  it("MCX closes at 23:55 IST while US daylight saving is off and 23:30 while it is on (needs verification)", () => {
    expect(usDstInEffect(Date.parse("2026-07-01T12:00:00Z"))).toBe(true);
    expect(usDstInEffect(Date.parse("2026-12-15T12:00:00Z"))).toBe(false);
    expect(usDstInEffect(Date.parse("2026-03-08T06:59:00Z"))).toBe(false); // second Sunday of March 2026, before 2 am ET
    expect(usDstInEffect(Date.parse("2026-03-08T07:00:00Z"))).toBe(true);
    expect(usDstInEffect(Date.parse("2026-11-01T05:59:00Z"))).toBe(true); // first Sunday of November 2026
    expect(usDstInEffect(Date.parse("2026-11-01T06:00:00Z"))).toBe(false);
    expect(sessionMinutes("MCX", Date.parse("2026-12-15T12:00:00Z"))).toBe(895);
    expect(sessionMinutes("MCX", Date.parse("2026-07-01T12:00:00Z"))).toBe(870);
    expect(sessionMinutes("NSE", Date.parse("2026-12-15T12:00:00Z"))).toBe(375);
    const to = Date.parse("2026-12-15T18:00:00Z");
    expect(countbackRange({ toMs: to, countback: 179, interval: "5m", exchange: "MCX" })).toBeLessThan(to);
  });

  it.each([
    [{ xl: { chainFormat: "xlsx" } }],
    [{ xl: { defaultCountback: 0 } }],
    [{ unknown: true }],
  ])("refuses %j", (raw) => {
    expect(INTEGRATIONS_CONFIG_SCHEMA.safeParse(raw).success).toBe(false);
  });

  it("is the section the module claims and core validates", () => {
    expect(integrations.configKey).toBe("integrations");
    const { config } = loadConfig({ raw: { integrations: { xl: { historyLayout: "amibroker" } } }, env: {} });
    const out = applyModuleConfig(config, [integrations]);
    expect(out.integrations.xl.historyLayout).toBe("amibroker");
    expect(out.integrations.xl.defaultCountback).toBe(500);
    const bad = loadConfig({ raw: { integrations: { xl: { defaultCountback: 100000 } } }, env: {} }).config;
    expect(() => applyModuleConfig(bad, [integrations])).toThrow(/integrations\.xl\.defaultCountback/);
  });
});
