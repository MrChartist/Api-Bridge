/**
 * Per-key quotas: the quota store (override > config key > default, persisted atomically), the limiter's daily cap,
 * concurrency cap and usage counters, and the refusals it builds. Fake clocks, temp folders, no network.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCallContext } from "../core/context.mjs";
import { createLogger } from "../core/logger.mjs";
import { createClientLimiter } from "./clientLimiter.mjs";
import { QUOTA_MAX, QUOTA_MIN, parseRatelimitConfig } from "./config.mjs";
import { QUOTAS_FILE, createQuotaStore, validateQuota } from "./quotaStore.mjs";
import { IST_OFFSET_MS } from "./tokenBucket.mjs";

const log = createLogger({ level: "silent" });
const keyCtx = (id, extra = {}) => Object.assign(createCallContext({ source: "rest", key: { id, label: id, scopes: ["read"], accounts: "*" }, log }), extra);
const tmp = () => mkdtempSync(join(tmpdir(), "mcb-quotas-"));
const clockAt = (t = 1_000_000) => {
  const c = { t, now: () => c.t };
  return c;
};

describe("validateQuota", () => {
  it("accepts positive finite numbers within the maxima, a whole-number burst of at least 1, and perDay null", () => {
    expect(validateQuota({ perSecond: 5, burst: 10, weight: 2.5, perDay: 1000 })).toEqual({ ok: true, value: { perSecond: 5, burst: 10, weight: 2.5, perDay: 1000 } });
    expect(validateQuota({ perDay: null })).toEqual({ ok: true, value: { perDay: null } });
    expect(validateQuota({ perSecond: 0.5 }).ok).toBe(true);
  });

  it("accepts the smallest values it allows (0.01 a second, one a day, a burst of 1, a weight of 1) and the largest", () => {
    expect(validateQuota({ perSecond: QUOTA_MIN.perSecond, burst: QUOTA_MIN.burst, perDay: QUOTA_MIN.perDay, weight: QUOTA_MIN.weight }).ok).toBe(true);
    expect(QUOTA_MIN).toMatchObject({ perSecond: 0.01, burst: 1, perDay: 1, weight: 1 });
    expect(validateQuota({ perSecond: QUOTA_MAX.perSecond, burst: QUOTA_MAX.burst, perDay: QUOTA_MAX.perDay, weight: QUOTA_MAX.weight }).ok).toBe(true);
  });

  it("says why a too-small rate is refused, in plain words", () => {
    expect(validateQuota({ perSecond: 1e-7 }).errors[0].message).toMatch(/at least 0\.01.*every 100 seconds/);
    expect(validateQuota({ perDay: 0.2 }).errors[0].message).toMatch(/at least 1.*a day/);
  });

  it("a stored override that is now below the floor is ignored on load, not honoured", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-quota-floor-"));
    writeFileSync(join(dir, QUOTAS_FILE), JSON.stringify({ format: "mcb-quotas", version: 1, keys: { lockedout001: { perSecond: 1e-7 }, fine00000001: { perSecond: 2 } } }));
    const store = createQuotaStore({ dir, config: { perSecond: 50 } });
    expect(store.override("lockedout001")).toBeNull();
    expect(store.override("fine00000001")).toEqual({ perSecond: 2 });
    expect(store.resolve("lockedout001").perSecond).toBe(50);
  });

  it("rejects everything else with a path for each problem", () => {
    const bad = (body) => validateQuota(body);
    for (const body of [null, [], "x", 5, {}]) expect(bad(body).ok).toBe(false);
    const cases = [
      [{ perSecond: 0 }, "perSecond"],
      [{ perSecond: -1 }, "perSecond"],
      [{ perSecond: 1e-7 }, "perSecond"], // one request in 115 days: a lock-out, not a quota
      [{ perSecond: 0.0099 }, "perSecond"],
      [{ perSecond: Number.MIN_VALUE }, "perSecond"],
      [{ perDay: 0.5 }, "perDay"],
      [{ perDay: 1e-9 }, "perDay"],
      [{ perDay: -5 }, "perDay"],
      [{ perDay: NaN }, "perDay"],
      [{ perDay: Infinity }, "perDay"],
      [{ perDay: "100" }, "perDay"],
      [{ burst: -1 }, "burst"],
      [{ burst: NaN }, "burst"],
      [{ burst: Infinity }, "burst"],
      [{ burst: "5" }, "burst"],
      [{ weight: NaN }, "weight"],
      [{ weight: -1 }, "weight"],
      [{ weight: Infinity }, "weight"],
      [{ weight: null }, "weight"],
      [{ perSecond: null }, "perSecond"],
      [{ perSecond: NaN }, "perSecond"],
      [{ perSecond: Infinity }, "perSecond"],
      [{ perSecond: "5" }, "perSecond"],
      [{ perSecond: QUOTA_MAX.perSecond + 1 }, "perSecond"],
      [{ burst: 0 }, "burst"],
      [{ burst: 0.5 }, "burst"],
      [{ burst: 2.5 }, "burst"],
      [{ burst: QUOTA_MAX.burst + 1 }, "burst"],
      [{ perDay: 0 }, "perDay"],
      [{ perDay: QUOTA_MAX.perDay + 1 }, "perDay"],
      [{ weight: 0.9 }, "weight"],
      [{ weight: 17 }, "weight"],
      [{ colour: "red" }, "colour"],
    ];
    for (const [body, path] of cases) {
      const r = bad(body);
      expect(r.ok, JSON.stringify(body)).toBe(false);
      expect(r.errors.map((e) => e.path)).toContain(path);
    }
    expect(bad({ perSecond: -1, burst: 0 }).errors).toHaveLength(2);
  });
});

describe("quota store: override > config key > default", () => {
  const cfg = parseRatelimitConfig({ client: { perSecond: 20, burst: 40, perDay: 5000, keys: { slow000001: { perSecond: 2, weight: 3 }, big0000001: { perSecond: 200, burst: 500, perDay: 90000 } } } }).client;

  it("resolves each layer and says which one applied", () => {
    const store = createQuotaStore({ config: cfg });
    expect(store.resolve("anything01")).toMatchObject({ perSecond: 20, burst: 40, perDay: 5000, weight: null, source: "default" });
    expect(store.resolve("slow000001")).toMatchObject({ perSecond: 2, burst: 2, perDay: 5000, weight: 3, source: "config" });
    expect(store.resolve("big0000001")).toMatchObject({ perSecond: 200, burst: 500, perDay: 90000, source: "config" });
    expect(store.set("slow000001", { perSecond: 7, perDay: null }).ok).toBe(true);
    // the override wins field by field; what it leaves out falls through to the config entry
    expect(store.resolve("slow000001")).toMatchObject({ perSecond: 7, burst: 7, perDay: null, weight: 3, source: "override" });
    expect(store.set("anything01", { weight: 8 }).ok).toBe(true);
    expect(store.resolve("anything01")).toMatchObject({ perSecond: 20, burst: 40, weight: 8, source: "override" });
    expect(store.clear("slow000001")).toBe(true);
    expect(store.resolve("slow000001")).toMatchObject({ perSecond: 2, source: "config" });
    expect(store.clear("slow000001")).toBe(false);
  });

  it("may raise as well as lower a client quota (it protects the Bridge from its callers, not a broker)", () => {
    const store = createQuotaStore({ config: cfg });
    store.set("slow000001", { perSecond: 5000 });
    expect(store.resolve("slow000001").perSecond).toBe(5000);
  });

  it("tells listeners about changes and bumps its version", () => {
    const store = createQuotaStore({ config: cfg });
    const seen = [];
    store.onChange((id) => seen.push(id));
    const v0 = store.version;
    store.set("slow000001", { perSecond: 3 });
    store.clear("slow000001");
    expect(seen).toEqual(["slow000001", "slow000001"]);
    expect(store.version).toBe(v0 + 2);
  });

  it("refuses invalid overrides and ids without changing anything", () => {
    const store = createQuotaStore({ config: cfg });
    expect(store.set("slow000001", { perSecond: -3 })).toMatchObject({ ok: false });
    expect(store.set("Bad Id!", { perSecond: 3 })).toMatchObject({ ok: false });
    expect(store.override("slow000001")).toBeNull();
  });
});

describe("quota store: quotas.json", () => {
  it("persists overrides atomically in the data folder and reloads them", () => {
    const dir = tmp();
    const a = createQuotaStore({ dir, config: { perSecond: 50 } });
    expect(a.set("abcd000001", { perSecond: 4, burst: 8, perDay: 200, weight: 2 }).ok).toBe(true);
    expect(a.set("abcd000002", { weight: 5 }).ok).toBe(true);
    const file = join(dir, QUOTAS_FILE);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ format: "mcb-quotas", version: 1, keys: { abcd000001: { perSecond: 4, burst: 8, perDay: 200, weight: 2 }, abcd000002: { weight: 5 } } });
    // no temp files left behind, and private
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
    const b = createQuotaStore({ dir, config: { perSecond: 50 } });
    expect(b.resolve("abcd000001")).toMatchObject({ perSecond: 4, burst: 8, perDay: 200, weight: 2, source: "override" });
    expect(b.clear("abcd000001")).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).keys).toEqual({ abcd000002: { weight: 5 } });
  });

  it("ignores a damaged file, and invalid records inside a good one, and keeps working", () => {
    const dir = tmp();
    const file = join(dir, QUOTAS_FILE);
    const warnings = [];
    const logger = { warn: (m) => warnings.push(m) };
    writeFileSync(file, "{ not json");
    const a = createQuotaStore({ dir, config: { perSecond: 50 }, logger });
    expect(a.overrideIds()).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
    writeFileSync(file, JSON.stringify({ format: "mcb-quotas", version: 1, keys: { good000001: { perSecond: 3 }, bad0000001: { perSecond: -4 }, "Not A Key": { perSecond: 1 } } }));
    const b = createQuotaStore({ dir, config: { perSecond: 50 }, logger });
    expect(b.overrideIds()).toEqual(["good000001"]);
    expect(b.set("good000002", { perSecond: 9 }).ok).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it("changes nothing when the write fails", () => {
    const dir = join(tmp(), "not-a-folder");
    writeFileSync(dir, "a file where the folder should be");
    const store = createQuotaStore({ dir, config: { perSecond: 50 } });
    expect(() => store.set("abcd000001", { perSecond: 4 })).toThrow();
    expect(store.override("abcd000001")).toBeNull();
    expect(store.resolve("abcd000001").source).toBe("default");
  });

  it("works in memory when there is no data folder", () => {
    const store = createQuotaStore({ config: { perSecond: 50 } });
    expect(store.set("abcd000001", { perSecond: 4 }).ok).toBe(true);
    expect(store.resolve("abcd000001").perSecond).toBe(4);
  });
});

describe("client limiter: daily cap, concurrency, usage and refusals", () => {
  it("caps requests per IST day, refuses with the time to midnight, and counts the day over at midnight IST", () => {
    const midnight = Date.UTC(2026, 9, 20) - IST_OFFSET_MS;
    const clock = clockAt(midnight - 3_600_000); // one hour before IST midnight
    const lim = createClientLimiter({ perSecond: 1000, burst: 1000, perDay: 5 }, clock);
    const ctx = keyCtx("day0000001");
    for (let i = 0; i < 5; i++) expect(lim.check(ctx).ok).toBe(true);
    const r = lim.check(ctx);
    expect(r.ok).toBe(false);
    expect(r.retryAfterMs).toBe(3_600_000);
    expect(r.headers).toEqual({ RateLimit: "limit=5, remaining=0, reset=3600", "RateLimit-Policy": "5;w=86400" });
    expect(r.error).toMatchObject({ code: "RATE_LIMITED", scope: "client", retryAfterMs: 3_600_000, limit: { name: "perDay", remaining: 0, resetMs: 3_600_000 } });
    expect(r.error.detail).toMatch(/daily budget of 5/);
    expect(lim.usageOf("day0000001")).toEqual({ lastMinute: 5, today: 5, throttledToday: 1 });
    clock.t = midnight + 1;
    expect(lim.check(ctx).ok).toBe(true);
    expect(lim.usageOf("day0000001")).toMatchObject({ today: 1, throttledToday: 0 });
  });

  it("does not spend a token on a request the daily cap refuses", () => {
    const clock = clockAt();
    const lim = createClientLimiter({ perSecond: 1, burst: 3, perDay: 1 }, clock);
    const ctx = keyCtx("day0000001");
    expect(lim.check(ctx).ok).toBe(true);
    expect(lim.check(ctx).ok).toBe(false);
    expect(lim.peek(ctx).remaining).toBe(2);
  });

  it("answers a per-second refusal with the same headers as before, plus scope, retryAfterMs and the limit", () => {
    const lim = createClientLimiter({ perSecond: 10 }, clockAt());
    const ctx = keyCtx("abcd000001");
    for (let i = 0; i < 10; i++) lim.check(ctx);
    const r = lim.check(ctx);
    expect(r.headers).toEqual({ RateLimit: "limit=10, remaining=0, reset=1", "RateLimit-Policy": "10;w=1;burst=10" });
    expect(r.error).toMatchObject({ code: "RATE_LIMITED", status: 429, scope: "client", retryAfterMs: 100, limit: { name: "perSecond", remaining: 0, resetMs: 100 } });
  });

  it("limits requests in flight per key to maxConcurrent and frees the slot when the response ends", () => {
    const lim = createClientLimiter({ perSecond: 1000, burst: 1000, maxConcurrent: 3 }, clockAt());
    const open = [];
    const http = () => {
      const res = new EventEmitter();
      open.push(res);
      return keyCtx("conc000001", { res });
    };
    for (let i = 0; i < 3; i++) expect(lim.check(http()).ok).toBe(true);
    expect(lim.inFlightOf("conc000001")).toBe(3);
    const r = lim.check(http());
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: "RATE_LIMITED", scope: "client", limit: { name: "concurrency", remaining: 0 } });
    // another key is not affected
    expect(lim.check(keyCtx("conc000002", { res: new EventEmitter() })).ok).toBe(true);
    // a refused request holds no slot; finishing one frees one (and close after finish does not free twice)
    open[0].emit("finish");
    open[0].emit("close");
    expect(lim.inFlightOf("conc000001")).toBe(2);
    expect(lim.check(http()).ok).toBe(true);
    expect(lim.check(http()).ok).toBe(false);
  });

  it("does not count calls without a response (MCP tools, workers) as concurrent", () => {
    const lim = createClientLimiter({ perSecond: 1000, burst: 1000, maxConcurrent: 1 }, clockAt());
    for (let i = 0; i < 5; i++) expect(lim.check(keyCtx("conc000001")).ok).toBe(true);
  });

  it("counts lastMinute over a sliding minute and resets nothing else", () => {
    const clock = clockAt(60_000_000);
    const lim = createClientLimiter({ perSecond: 1000, burst: 1000 }, clock);
    const ctx = keyCtx("use0000001");
    for (let i = 0; i < 10; i++) lim.check(ctx);
    clock.t += 30_000;
    for (let i = 0; i < 5; i++) lim.check(ctx);
    expect(lim.usageOf("use0000001")).toEqual({ lastMinute: 15, today: 15, throttledToday: 0 });
    clock.t += 31_000; // the first ten are older than a minute now
    expect(lim.usageOf("use0000001")).toEqual({ lastMinute: 5, today: 15, throttledToday: 0 });
    expect(lim.usageOf("nobody00001")).toEqual({ lastMinute: 0, today: 0, throttledToday: 0 });
  });

  it("applies runtime overrides at once: a lowered rate, a daily cap, and keeps the headers' syntax", () => {
    const quotas = createQuotaStore({ config: { perSecond: 50 } });
    const lim = createClientLimiter({ perSecond: 50 }, clockAt(), { quotas });
    const ctx = keyCtx("ovr0000001");
    expect(lim.check(ctx).headers["RateLimit-Policy"]).toBe("50;w=1;burst=50");
    quotas.set("ovr0000001", { perSecond: 2, burst: 2 });
    for (let i = 0; i < 3; i++) lim.check(ctx); // the bucket is clamped to the new burst
    const r = lim.check(ctx);
    expect(r.ok).toBe(false);
    expect(r.headers["RateLimit-Policy"]).toBe("2;w=1;burst=2");
    quotas.clear("ovr0000001");
    expect(lim.peek(ctx)).toMatchObject({ perSecond: 50, burst: 50 });
  });

  it("gives the fair-queue weight of a key: its quota's weight, else its kind's", () => {
    const quotas = createQuotaStore({ config: { perSecond: 50, keys: { w0000000001: { weight: 6 } } } });
    const lim = createClientLimiter({ perSecond: 50, kindWeights: { script: 2 } }, clockAt(), { quotas });
    expect(lim.weightFor("w0000000001", "script")).toBe(6);
    expect(lim.weightFor("other000001", "script")).toBe(2);
    expect(lim.weightFor("other000001", "ui")).toBe(4);
    expect(lim.weightFor("other000001", "mcp")).toBe(2);
    expect(lim.weightFor("other000001", "excel")).toBe(1);
    expect(lim.weightFor("other000001", "other")).toBe(1);
    expect(lim.weightFor(null, "bogus")).toBe(1);
  });

  it("leaves local (CLI) callers unlimited and uncounted", () => {
    const lim = createClientLimiter({ perSecond: 1, perDay: 1, maxConcurrent: 1 }, clockAt());
    const local = Object.assign(createCallContext({ source: "cli", principal: { kind: "local", id: "cli" }, log }), { res: new EventEmitter() });
    for (let i = 0; i < 20; i++) expect(lim.check(local)).toEqual({ ok: true, retryAfterMs: 0, headers: {} });
  });
});
