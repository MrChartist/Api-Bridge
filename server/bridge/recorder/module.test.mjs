/**
 * Recorder module rules (docs/spec/p1-01-recorder.md §3.1, §9): nothing under recorder/ imports orders/, paper/ or
 * safety/ (the recorder can never place an order), nothing calls fetch directly (outbound reads only through
 * marketData/backupData), the declared services match the contract, and the config schema defaults and limits.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SERVICE_CONTRACTS } from "../core/contracts.mjs";
import { BUILTIN_MODULES } from "../core/builtinModules.mjs";
import { RECORDER_CONFIG_SCHEMA, parseRecorderConfig } from "./config.mjs";
import recorderModule, { ROUTES, USED_SERVICES } from "./module.mjs";

const DIR = import.meta.dirname;
const sources = readdirSync(DIR)
  .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"))
  .map((f) => ({ f, src: readFileSync(join(DIR, f), "utf8") }));

describe("recorder module boundaries", () => {
  it("imports nothing from orders/, paper/ or safety/", () => {
    for (const { f, src } of sources) {
      for (const m of src.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g)) {
        const spec = m[1] ?? m[2];
        expect(/(^|\/)(orders|paper|safety)\//.test(spec), `${f} imports ${spec}`).toBe(false);
      }
    }
  });
  it("makes no direct network call", () => {
    for (const { f, src } of sources) {
      expect(/\bfetch\s*\(|node:https?|\bWebSocket\b|undici/.test(src), f).toBe(false);
    }
  });
  it("declares the services of its contract and is registered after the scanner", () => {
    expect([...SERVICE_CONTRACTS.recorder.requires].sort()).toEqual([...USED_SERVICES].sort());
    expect(SERVICE_CONTRACTS.recorder.stream).toBe("S17");
    const names = BUILTIN_MODULES.map((m) => m.name);
    expect(names.indexOf("recorder")).toBe(names.indexOf("scanner") + 1);
    expect(recorderModule).toMatchObject({ name: "recorder", stream: "S17", configKey: "recorder" });
    expect(ROUTES.map(([m, p, o]) => `${m} ${p} ${o.scope}`)).toEqual([
      "GET /v1/options/snapshots read",
      "GET /v1/options/snapshots/latest read",
      "GET /v1/options/daily read",
      "GET /v1/options/recorder read",
      "POST /v1/options/recorder/plan read",
      "PUT /v1/options/recorder/config admin",
    ]);
  });
});

describe("recorder config", () => {
  it("defaults record the six indices, 3 expiries, ±40, stream and REST on, NSE backup off", () => {
    expect(parseRecorderConfig({})).toEqual({
      enabled: true,
      account: null,
      indices: ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"],
      indexExpiries: 3,
      indexStrikes: 40,
      stocks: [],
      stockExpiries: 1,
      stockStrikes: 15,
      stockEveryMinutes: 5,
      sources: { stream: true, rest: true, nseBackup: false },
      budgetShare: 0.5,
      streamShare: 0.6,
      strikeBuffer: 2,
      allowSingleTokenRest: false,
      retentionDays: 365,
      maxDiskMb: 10240,
      recordSpecialSessions: true,
      dailyAt: "15:31",
      slotOffsetMs: 2000,
      restSpreadMs: 40000,
      demo: { alwaysOpen: true, backfillDays: 2 },
    });
  });
  it("budgetShare above 0.5, unknown keys, holidays and bad values are rejected", () => {
    for (const bad of [{ budgetShare: 0.51 }, { holidays: [] }, { session: {} }, { stockEveryMinutes: 7 }, { indexExpiries: 5 }, { streamShare: 0.95 }, { dailyAt: "25:00" }, { sources: { feed: true } }, { indices: ["NIFTY", "NIFTY"] }, { stocks: Array.from({ length: 201 }, (_, i) => `S${i}`) }]) {
      expect(RECORDER_CONFIG_SCHEMA.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
  });
});
