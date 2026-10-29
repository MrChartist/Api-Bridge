import { describe, expect, it } from "vitest";
import { effectiveSettings, parseReferenceConfig } from "./config.mjs";
import { DEFAULT_BROKERAGE, DEFAULT_RATE, DEFAULT_SESSIONS } from "./defaults.mjs";

describe("reference config", () => {
  it("defaults: archives off, the schedule, 1 trading day, 7-day banners, no blocking, no rate", () => {
    const c = parseReferenceConfig({});
    expect(c.sources.nseArchives).toEqual({ enabled: false, baseUrl: "https://nsearchives.nseindia.com", gapMs: 2000, timeoutMs: 15000, maxBytes: 20971520 });
    expect(c.schedule).toEqual({ morning: "08:20", morningRetry: "08:50", evening: "19:35", eveningRetry: "21:05" });
    expect(c).toMatchObject({ staleAfterTradingDays: 1, bannerDays: 7, blockLotsWhenStale: false, rateStaleDays: 14, extraordinaryDividendPct: 2, retentionDays: 400 });
    expect(c.rate).toEqual({ value: null, asOf: null, source: null });
    expect(c.brokerage).toEqual({ kind: "flat", perOrder: DEFAULT_BROKERAGE.perOrder });
    expect(c.sessions.NFO).toEqual({ preOpen: null, open: null, close: null });
  });

  it("is strict about unknown keys", () => {
    expect(() => parseReferenceConfig({ ratee: 0.06 })).toThrow();
    expect(() => parseReferenceConfig({ sources: { nseArchives: { enabled: true, url: "x" } } })).toThrow();
  });

  it("validates HH:MM, dates, rate bounds and the polite gap", () => {
    expect(() => parseReferenceConfig({ schedule: { morning: "8:20" } })).toThrow();
    expect(() => parseReferenceConfig({ sessions: { NFO: { open: "15:30", close: "09:15" } } })).toThrow();
    expect(() => parseReferenceConfig({ specialSessions: { "2026-02-30": { open: "18:00", close: "19:00" } } })).toThrow();
    expect(() => parseReferenceConfig({ rate: { value: 6.5 } })).toThrow();
    expect(() => parseReferenceConfig({ rate: { value: -0.01 } })).toThrow();
    expect(() => parseReferenceConfig({ sources: { nseArchives: { gapMs: 100 } } })).toThrow();
    expect(() => parseReferenceConfig({ sources: { nseArchives: { baseUrl: "http://example.com" } } })).toThrow();
    expect(parseReferenceConfig({ rate: { value: 0.0571, asOf: "2026-10-28", source: "91-day T-bill" } }).rate.value).toBe(0.0571);
    expect(parseReferenceConfig({ holidays: { add: [{ date: "2026-11-27", label: "X" }] } }).holidays.add[0]).toMatchObject({ exchanges: ["NSE", "BSE"], verified: true });
  });

  it("settings.json overrides config, config overrides the defaults", () => {
    const none = effectiveSettings(parseReferenceConfig({}), {});
    expect(none.rate).toMatchObject({ value: DEFAULT_RATE, quality: "default", setBy: "default" });
    expect(none.nseArchives).toMatchObject({ enabled: false, setBy: "default" });
    const cfg = parseReferenceConfig({ rate: { value: 0.0571, asOf: "2026-10-28", source: "91-day T-bill" }, sources: { nseArchives: { enabled: true } } });
    expect(effectiveSettings(cfg, {}).rate).toMatchObject({ value: 0.0571, quality: "config" });
    expect(effectiveSettings(cfg, {}).nseArchives).toMatchObject({ enabled: true, setBy: "config" });
    const s = { version: 1, rate: { value: 0.06, asOf: "2026-10-29", source: "dashboard entry" }, nseArchives: { enabled: false, at: "2026-10-29T10:00:00.000+05:30", by: "local:cli" } };
    expect(effectiveSettings(cfg, s).rate).toMatchObject({ value: 0.06, quality: "user", setBy: "dashboard" });
    expect(effectiveSettings(cfg, s).nseArchives).toEqual({ enabled: false, setBy: "dashboard", setAt: "2026-10-29T10:00:00.000+05:30", by: "local:cli" });
    expect(effectiveSettings(cfg, { rate: { value: 9 } }).rate.quality).toBe("config"); // a broken settings file is ignored
  });

  it("the S5 defaults carry their source", () => {
    expect(DEFAULT_SESSIONS.NFO).toEqual({ preOpen: "09:00", open: "09:15", close: "15:30" });
    expect(DEFAULT_SESSIONS.source).toMatch(/needs verification/);
    expect(DEFAULT_BROKERAGE.source).toMatch(/default/i);
    // User-facing: no spec store ids or config keys.
    for (const t of [DEFAULT_SESSIONS.source, DEFAULT_BROKERAGE.source]) expect(t).not.toMatch(/\bS5\b|reference\./);
  });
});
