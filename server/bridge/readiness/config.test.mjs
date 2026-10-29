import { describe, expect, it } from "vitest";
import { detectionBoundSeconds, parseReadinessConfig, readinessWarnings } from "./config.mjs";

describe("readiness config (p1-05 §3.6)", () => {
  it("defaults: lookup off, 4 min inside 08:45–15:45, pre-open 09:00, gate on", () => {
    const c = parseReadinessConfig({});
    expect(c).toMatchObject({
      enabled: true,
      intervalMinutes: 4,
      window: { from: "08:45", to: "15:45" },
      preOpenAt: "09:00",
      probe: { enabled: true, timeoutMs: 10000, cooldownSeconds: 30, endpointClass: "portfolio" },
      egressIp: { mode: "off", lookupUrl: null, manualIp: null, timeoutMs: 5000, maxSkewMs: 5000 },
      gateAutomated: true,
      staleAfterMinutes: 10,
      warn: { sessionExpiresWithinMinutes: 60, dailyOrdersLeftPct: 10, dailyLossLeftPct: 20 },
      notify: { cooldownMinutes: 15, onRecovery: true, preopenOnlyIfFailing: true },
    });
  });

  it("refuses preOpenAt outside the window, a backwards window, and unknown keys", () => {
    expect(() => parseReadinessConfig({ preOpenAt: "08:30" })).toThrow(/preOpenAt must lie inside window/);
    expect(() => parseReadinessConfig({ window: { from: "15:00", to: "09:00" } })).toThrow(/window.from must be before window.to/);
    expect(() => parseReadinessConfig({ intervalMinutes: 0 })).toThrow();
    expect(() => parseReadinessConfig({ intervalMinutes: 16 })).toThrow();
    expect(() => parseReadinessConfig({ surprise: 1 })).toThrow();
  });

  it("lookup needs an https URL (http only to this computer); manual needs an address", () => {
    expect(() => parseReadinessConfig({ egressIp: { mode: "lookup" } })).toThrow(/lookupUrl/);
    expect(() => parseReadinessConfig({ egressIp: { mode: "lookup", lookupUrl: "http://api.ipify.org" } })).toThrow(/https/);
    expect(() => parseReadinessConfig({ egressIp: { mode: "lookup", lookupUrl: "https://user:pw@api.ipify.org" } })).toThrow();
    expect(parseReadinessConfig({ egressIp: { mode: "lookup", lookupUrl: "https://api.ipify.org" } }).egressIp.mode).toBe("lookup");
    expect(parseReadinessConfig({ egressIp: { mode: "lookup", lookupUrl: "http://127.0.0.1:8080/ip" } }).egressIp.lookupUrl).toBe("http://127.0.0.1:8080/ip");
    expect(() => parseReadinessConfig({ egressIp: { mode: "manual" } })).toThrow(/manualIp/);
  });

  it("detection bound (§7.5): 280.25 s at the defaults; intervalMinutes > 4 warns, never fails", () => {
    expect(detectionBoundSeconds(parseReadinessConfig({}))).toBe(280.25);
    expect(readinessWarnings(parseReadinessConfig({}))).toEqual([]);
    const five = parseReadinessConfig({ intervalMinutes: 5 });
    expect(readinessWarnings(five)[0]).toMatch(/Readiness can take up to 6 minutes/);
  });
});
