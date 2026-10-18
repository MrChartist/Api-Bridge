import { describe, expect, it } from "vitest";
import { applyModuleConfig } from "../core/modules.mjs";
import { loadConfig } from "../core/config.mjs";
import { INTEGRATIONS_CONFIG_SCHEMA, SESSION_DEFAULTS, SESSION_RE, UDF_RESOLUTION_KEYS, mcxSessionFor, parseIntegrationsConfig } from "./config.mjs";
import { countbackRange, sessionMinutes, usDstInEffect } from "../market/history.mjs";
import integrations from "./module.mjs";

describe("integrations config", () => {
  it("defaults everything from {}", () => {
    const c = parseIntegrationsConfig({});
    expect(c.udf.supportedResolutions).toEqual(["1", "3", "5", "10", "15", "30", "60", "1D", "1W", "1M"]);
    expect(c.udf.sessions).toEqual({ ...SESSION_DEFAULTS, MCX: mcxSessionFor(Date.now()) });
    expect(c.udf).toMatchObject({ searchLimit: 30, maxCountback: 5000, maxQuoteSymbols: 100, nextTimeLookup: true });
    expect(c.xl).toEqual({ chainFormat: "csv", historyLayout: "standard", defaultCountback: 500 });
    expect(parseIntegrationsConfig(undefined)).toEqual(c);
  });

  it("MCX closes at 23:55 IST while US daylight saving is off and 23:30 while it is on (needs verification)", () => {
    expect(usDstInEffect(Date.parse("2026-07-01T12:00:00Z"))).toBe(true);
    expect(usDstInEffect(Date.parse("2026-12-15T12:00:00Z"))).toBe(false);
    expect(usDstInEffect(Date.parse("2026-03-08T06:59:00Z"))).toBe(false); // second Sunday of March 2026, before 2 am ET
    expect(usDstInEffect(Date.parse("2026-03-08T07:00:00Z"))).toBe(true);
    expect(usDstInEffect(Date.parse("2026-11-01T05:59:00Z"))).toBe(true); // first Sunday of November 2026
    expect(usDstInEffect(Date.parse("2026-11-01T06:00:00Z"))).toBe(false);
    expect(mcxSessionFor(Date.parse("2026-12-15T12:00:00Z"))).toBe("0900-2355");
    expect(mcxSessionFor(Date.parse("2026-07-01T12:00:00Z"))).toBe("0900-2330");
    expect(sessionMinutes("MCX", Date.parse("2026-12-15T12:00:00Z"))).toBe(895);
    expect(sessionMinutes("MCX", Date.parse("2026-07-01T12:00:00Z"))).toBe(870);
    expect(sessionMinutes("NSE", Date.parse("2026-12-15T12:00:00Z"))).toBe(375);
    const to = Date.parse("2026-12-15T18:00:00Z");
    expect(countbackRange({ toMs: to, countback: 179, interval: "5m", exchange: "MCX" })).toBeLessThan(to);
  });

  it("keeps defaults for sessions not overridden", () => {
    const c = parseIntegrationsConfig({ udf: { sessions: { MCX: "0900-2355" } } });
    expect(c.udf.sessions.MCX).toBe("0900-2355");
    expect(c.udf.sessions.NSE).toBe("0915-1530");
  });

  it.each([
    [{ udf: { supportedResolutions: ["240"] } }],
    [{ udf: { supportedResolutions: [] } }],
    [{ udf: { supportedResolutions: ["5", "5"] } }],
    [{ udf: { sessions: { NSE: "9:15-15:30" } } }],
    [{ udf: { sessions: { NYSE: "0930-1600" } } }],
    [{ udf: { searchLimit: 0 } }],
    [{ xl: { chainFormat: "xlsx" } }],
    [{ unknown: true }],
  ])("refuses %j", (raw) => {
    expect(INTEGRATIONS_CONFIG_SCHEMA.safeParse(raw).success).toBe(false);
  });

  it("session strings follow the TradingView grammar", () => {
    for (const s of ["0915-1530", "0900-1700:23456", "0915-1200,1300-1530", "0900-2330|0900-2355:6"]) expect(SESSION_RE.test(s), s).toBe(true);
    for (const s of ["915-1530", "0915-1530:8", "0915", ""]) expect(SESSION_RE.test(s), s).toBe(false);
  });

  it("resolution keys are in chart order", () => {
    expect(UDF_RESOLUTION_KEYS).toEqual(["1", "3", "5", "10", "15", "30", "60", "1D", "1W", "1M"]);
  });

  it("is the section the module claims and core validates", () => {
    expect(integrations.configKey).toBe("integrations");
    const { config } = loadConfig({ raw: { integrations: { xl: { historyLayout: "amibroker" } } }, env: {} });
    const out = applyModuleConfig(config, [integrations]);
    expect(out.integrations.xl.historyLayout).toBe("amibroker");
    expect(out.integrations.udf.searchLimit).toBe(30);
    const bad = loadConfig({ raw: { integrations: { udf: { searchLimit: 1000 } } }, env: {} }).config;
    expect(() => applyModuleConfig(bad, [integrations])).toThrow(/integrations\.udf\.searchLimit/);
  });
});
