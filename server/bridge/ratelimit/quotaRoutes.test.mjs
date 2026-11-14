/**
 * GET /v1/quotas, PUT and DELETE /v1/quotas/{keyId}, the refusal body on a spent key budget and
 * GET /v1/limits?explain=1, through the real request pipeline (createApp) with the real scheduler.
 */
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { createLogger } from "../core/logger.mjs";
import ratelimitModule from "./module.mjs";

const ADMIN = "mcb_admin000001_aaaaaaaaaaaaaaaaaaaa";
const READ = "mcb_read0000001_bbbbbbbbbbbbbbbbbbbb";
const SLOW = "mcb_slow0000001_cccccccccccccccccccc";
const CFG = "mcb_cfg00000001_dddddddddddddddddddd";
const DAY = "mcb_day00000001_ffffffffffffffffffff";
const REVOKED = "mcb_gone0000001_eeeeeeeeeeeeeeeeeeee";
const rec = (id, label, scopes, extra = {}) => ({ id, label, scopes, accounts: "*", clientKind: "other", createdAt: "2026-01-01T00:00:00+05:30", expiresAt: null, revokedAt: null, ...extra });
const RECORDS = {
  [ADMIN]: rec("admin000001", "admin", ["admin"], { clientKind: "script" }),
  [READ]: rec("read0000001", "reader", ["read"], { clientKind: "ui" }),
  [SLOW]: rec("slow0000001", "slow", ["read"], { clientKind: "mcp" }),
  [CFG]: rec("cfg00000001", "configured", ["read"], { clientKind: "excel" }),
  [DAY]: rec("day00000001", "daily", ["read"]),
  [REVOKED]: rec("gone0000001", "revoked", ["read"], { revokedAt: "2026-02-01T00:00:00+05:30" }),
};
const byId = Object.fromEntries(Object.values(RECORDS).map((r) => [r.id, r]));

let app;
let port;
let dataDir;
const audits = [];

function request(method, path, key, body) {
  const headers = { host: `127.0.0.1:${port}` };
  if (key) headers.authorization = `Bearer ${key}`;
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}
const get = (path, key) => request("GET", path, key);

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mcb-quota-routes-"));
  const { config } = loadConfig({
    raw: {
      server: { port: 0 },
      dataDir,
      accounts: [
        { id: "zerodha-main", broker: "zerodha" },
        { id: "dhan-main", broker: "dhan" },
      ],
      ratelimit: { client: { perSecond: 50, keys: { cfg00000001: { perSecond: 5, weight: 2 }, slow0000001: { perSecond: 1, burst: 1 } } } },
    },
    env: {},
  });
  const accounts = createFakeAccountManager({
    accounts: [
      { id: "zerodha-main", broker: "zerodha" },
      { id: "dhan-main", broker: "dhan" },
    ],
  });
  const keyStore = {
    ...notImplementedService("keyStore"),
    authenticate: async (raw) => (RECORDS[raw] && !RECORDS[raw].revokedAt ? RECORDS[raw] : null),
    get: async (id) => byId[id] ?? null,
    list: async () => Object.values(RECORDS),
  };
  const audit = { ...notImplementedService("audit"), append: async (r) => audits.push(r) };
  app = await createApp({ config, modules: [ratelimitModule], overrides: { keyStore, accounts, audit }, logger: createLogger({ level: "silent" }) });
  ({ port } = await app.listen());
});

afterAll(async () => {
  await app?.close();
});

describe("GET /v1/quotas", () => {
  it("shows an admin key the default, the kind weights and a row per key with usage and where each setting came from", async () => {
    const r = await get("/v1/quotas", ADMIN);
    expect(r.status).toBe(200);
    const { data } = r.json;
    expect(data.default).toMatchObject({ perSecond: 50, burst: 50, perDay: null, maxConcurrent: 64 });
    expect(data.kinds).toEqual({ ui: 4, mcp: 2, excel: 1, script: 1, other: 1 });
    expect(data.keys.map((k) => k.keyId)).toEqual(["admin000001", "read0000001", "slow0000001", "cfg00000001", "day00000001"]); // the revoked key is not listed
    const cfg = data.keys.find((k) => k.keyId === "cfg00000001");
    expect(cfg).toEqual({ keyId: "cfg00000001", label: "configured", clientKind: "excel", weight: 2, perSecond: 5, burst: 5, perDay: null, usage: expect.objectContaining({ lastMinute: expect.any(Number), today: expect.any(Number), throttledToday: expect.any(Number) }), source: "config" });
    const reader = data.keys.find((k) => k.keyId === "read0000001");
    expect(reader).toMatchObject({ clientKind: "ui", weight: 4, perSecond: 50, burst: 50, source: "default" });
    expect(reader.usage.today).toBeGreaterThanOrEqual(0);
  });

  it("shows any other key only its own row", async () => {
    const r = await get("/v1/quotas", READ);
    expect(r.status).toBe(200);
    expect(r.json.data.keys.map((k) => k.keyId)).toEqual(["read0000001"]);
    expect(r.json.data.default).toBeDefined();
  });

  it("needs a key", async () => {
    expect((await get("/v1/quotas")).status).toBe(401);
  });
});

describe("PUT and DELETE /v1/quotas/{keyId}", () => {
  it("sets an override that applies at once, is persisted in quotas.json, and is audited", async () => {
    const before = await get("/v1/limits", CFG);
    expect(before.headers["ratelimit-policy"]).toBe("5;w=1;burst=5");
    const put = await request("PUT", "/v1/quotas/cfg00000001", ADMIN, { perSecond: 9, burst: 12, perDay: 500, weight: 5 });
    expect(put.status).toBe(200);
    expect(put.json.data).toMatchObject({ keyId: "cfg00000001", perSecond: 9, burst: 12, perDay: 500, weight: 5, source: "override" });
    expect((await get("/v1/limits", CFG)).headers["ratelimit-policy"]).toBe("9;w=1;burst=12");
    expect(JSON.parse(readFileSync(join(dataDir, "quotas.json"), "utf8")).keys.cfg00000001).toEqual({ perSecond: 9, burst: 12, perDay: 500, weight: 5 });
    expect(audits.at(-1)).toMatchObject({ type: "quota.set", data: { keyId: "cfg00000001", quota: { perSecond: 9, burst: 12, perDay: 500, weight: 5 } } });
    const list = await get("/v1/quotas", ADMIN);
    expect(list.json.data.keys.find((k) => k.keyId === "cfg00000001")).toMatchObject({ perSecond: 9, perDay: 500, weight: 5, source: "override" });
    const del = await request("DELETE", "/v1/quotas/cfg00000001", ADMIN);
    expect(del.status).toBe(200);
    expect(del.json.data).toMatchObject({ perSecond: 5, burst: 5, weight: 2, perDay: null, source: "config" });
    expect((await get("/v1/limits", CFG)).headers["ratelimit-policy"]).toBe("5;w=1;burst=5");
    expect(JSON.parse(readFileSync(join(dataDir, "quotas.json"), "utf8")).keys).toEqual({});
    expect(audits.at(-1)).toMatchObject({ type: "quota.cleared", data: { keyId: "cfg00000001" } });
    // deleting again is harmless
    expect((await request("DELETE", "/v1/quotas/cfg00000001", ADMIN)).status).toBe(200);
  });

  it("validates the body: positive finite numbers, burst of at least 1, sane maxima, known fields only", async () => {
    for (const body of [{ perSecond: 0 }, { perSecond: -1 }, { perSecond: 1e9 }, { burst: 0 }, { burst: 1.5 }, { perDay: 0 }, { weight: 0.5 }, { weight: 40 }, { perSecond: "fast" }, { colour: 1 }, {}]) {
      const r = await request("PUT", "/v1/quotas/read0000001", ADMIN, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.code).toBe("VALIDATION_FAILED");
      expect(r.json.errors.length).toBeGreaterThan(0);
    }
    expect((await get("/v1/quotas", ADMIN)).json.data.keys.find((k) => k.keyId === "read0000001").source).toBe("default");
  });

  it("refuses a rate so small it would lock a key out (1e-7 a second is one request in 115 days)", async () => {
    for (const body of [{ perSecond: 1e-7 }, { perSecond: 0.001 }, { perDay: 0.5 }, { perSecond: 5, perDay: 0 }]) {
      const r = await request("PUT", "/v1/quotas/read0000001", ADMIN, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.errors.length).toBeGreaterThan(0);
    }
    expect((await request("PUT", "/v1/quotas/read0000001", ADMIN, { perSecond: 0.01, burst: 1, perDay: 1 })).status).toBe(200); // the floor itself is allowed for an ordinary key
    expect((await request("DELETE", "/v1/quotas/read0000001", ADMIN)).status).toBe(200);
  });

  it("will not give the ONLY active admin key a quota that could lock it out, and leaves the old quota in place", async () => {
    for (const body of [{ perSecond: 0.5 }, { perSecond: 0.01 }, { perSecond: 5, perDay: 10 }, { perSecond: 5, perDay: 999 }]) {
      const r = await request("PUT", "/v1/quotas/admin000001", ADMIN, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.code).toBe("VALIDATION_FAILED");
      expect(r.json.detail).toMatch(/only active admin key/);
      expect(r.json.detail).toMatch(/control token is not limited/); // the recovery path is in the message
    }
    expect((await get("/v1/quotas", ADMIN)).json.data.keys.find((k) => k.keyId === "admin000001").source).toBe("default");
    // Floors themselves are fine, and so is a high rate with no daily cap.
    expect((await request("PUT", "/v1/quotas/admin000001", ADMIN, { perSecond: 1, burst: 20, perDay: 1000 })).status).toBe(200);
    // A refusal restores the PREVIOUS override rather than clearing it.
    expect((await request("PUT", "/v1/quotas/admin000001", ADMIN, { perSecond: 0.5 })).status).toBe(400);
    expect((await get("/v1/quotas", ADMIN)).json.data.keys.find((k) => k.keyId === "admin000001")).toMatchObject({ perSecond: 1, burst: 20, perDay: 1000, source: "override" });
    expect((await request("DELETE", "/v1/quotas/admin000001", ADMIN)).status).toBe(200);
  });

  it("allows a low quota on an admin key when another active admin key exists, and on any non-admin key", async () => {
    const second = rec("admin000002", "second admin", ["admin"]);
    RECORDS.second = second;
    byId.admin000002 = second;
    try {
      // With two active admin keys either may be limited; the one used here is left alone.
      expect((await request("PUT", "/v1/quotas/admin000002", ADMIN, { perSecond: 0.05, perDay: 20 })).status).toBe(200);
      expect((await request("DELETE", "/v1/quotas/admin000002", ADMIN)).status).toBe(200);
      // A revoked second admin does not count: the first is the last one again.
      RECORDS.second = { ...second, revokedAt: "2026-02-01T00:00:00+05:30" };
      byId.admin000002 = RECORDS.second;
      expect((await request("PUT", "/v1/quotas/admin000001", ADMIN, { perSecond: 0.05 })).status).toBe(400);
    } finally {
      delete RECORDS.second;
      delete byId.admin000002;
    }
    expect((await request("PUT", "/v1/quotas/read0000001", ADMIN, { perSecond: 0.05, perDay: 20 })).status).toBe(200);
    expect((await request("DELETE", "/v1/quotas/read0000001", ADMIN)).status).toBe(200);
  });

  it("answers 404 for a key that does not exist, is revoked or is not a key id", async () => {
    for (const id of ["nobody00001", "gone0000001", "x", "Bad_Id!"]) {
      const put = await request("PUT", `/v1/quotas/${encodeURIComponent(id)}`, ADMIN, { perSecond: 3 });
      expect(put.status, id).toBe(404);
      expect(put.json.code).toBe("NOT_FOUND");
      expect((await request("DELETE", `/v1/quotas/${encodeURIComponent(id)}`, ADMIN)).status).toBe(404);
    }
    expect(existsSync(join(dataDir, "quotas.json")) ? JSON.parse(readFileSync(join(dataDir, "quotas.json"), "utf8")).keys : {}).toEqual({});
  });

  it("needs the admin scope (this computer only)", async () => {
    expect((await request("PUT", "/v1/quotas/read0000001", READ, { perSecond: 3 })).status).toBe(403);
    expect((await request("DELETE", "/v1/quotas/read0000001", READ)).status).toBe(403);
    expect((await request("PUT", "/v1/quotas/read0000001", undefined, { perSecond: 3 })).status).toBe(401);
  });
});

describe("refusals that explain", () => {
  it("a spent key budget answers 429 RATE_LIMITED with scope, retryAfterMs, the limit, and a jittered Retry-After that is never early", async () => {
    // slow0000001 is configured at 1 a second with a burst of 1
    expect((await get("/v1/usage", SLOW)).status).toBe(200);
    for (let i = 0; i < 5; i++) {
      const r = await get("/v1/usage", SLOW);
      if (r.status === 200) continue; // a second passed on a slow machine: the next one will be refused
      expect(r.status).toBe(429);
      expect(r.headers["content-type"]).toMatch(/application\/problem\+json/);
      expect(r.json).toMatchObject({ code: "RATE_LIMITED", status: 429, retryable: true, scope: "client", retryAfterMs: expect.any(Number), limit: { name: "perSecond", remaining: 0, resetMs: expect.any(Number) } });
      const seconds = Number(r.headers["retry-after"]);
      expect(seconds).toBeGreaterThanOrEqual(Math.ceil(r.json.retryAfterMs / 1000));
      expect(seconds).toBeLessThanOrEqual(Math.ceil((r.json.retryAfterMs * 1.25) / 1000));
      expect(r.headers.ratelimit).toMatch(/^limit=1, remaining=0, reset=\d+$/);
      expect(r.headers["ratelimit-policy"]).toBe("1;w=1;burst=1");
      return;
    }
    throw new Error("the key was never refused");
  });

  it("a key over its daily cap is told when midnight IST comes", async () => {
    expect((await request("PUT", "/v1/quotas/day00000001", ADMIN, { perDay: 2 })).status).toBe(200);
    expect((await get("/v1/limits", DAY)).status).toBe(200);
    expect((await get("/v1/limits", DAY)).status).toBe(200);
    const r = await get("/v1/limits", DAY);
    expect(r.status).toBe(429);
    expect(r.json).toMatchObject({ code: "RATE_LIMITED", scope: "client", limit: { name: "perDay", remaining: 0 } });
    expect(r.json.retryAfterMs).toBeGreaterThan(0);
    expect(r.headers.ratelimit).toMatch(/^limit=2, remaining=0, reset=\d+$/);
    expect((await request("DELETE", "/v1/quotas/day00000001", ADMIN)).status).toBe(200);
    expect((await get("/v1/limits", DAY)).status).toBe(200);
    const row = (await get("/v1/quotas", ADMIN)).json.data.keys.find((k) => k.keyId === "day00000001");
    expect(row.usage.throttledToday).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /v1/limits?explain=1", () => {
  it("adds pools, consumers and the caller's own quota, and leaves the rest of the answer as it was", async () => {
    const plain = await get("/v1/limits", ADMIN);
    const explained = await get("/v1/limits?explain=1", ADMIN);
    expect(explained.status).toBe(200);
    const { pools, consumers, you, savedCalls, ...rest } = explained.json.data;
    expect(savedCalls).toMatchObject({ total: expect.any(Number), totalToday: expect.any(Number) });
    expect(Object.keys(plain.json.data)).toEqual(["safety", "brokers", "client", "accounts"]);
    const strip = (d) => ({ ...d, client: { ...d.client, remaining: 0 } });
    expect(strip(rest)).toEqual(strip(plain.json.data));
    expect(pools.map((p) => p.group).sort()).toEqual(expect.arrayContaining(["dhan-main/order", "zerodha-main/quote"]));
    for (const p of pools) expect(p).toMatchObject({ accounts: [p.accountId], backoffFactor: 1, ceiling: 1, spare: expect.any(Number) });
    expect(Array.isArray(consumers)).toBe(true);
    expect(you).toMatchObject({ keyId: "admin000001", source: "default", perSecond: 50 });
  });

  it("is byte for byte the old answer without the flag (or with a flag that is off)", async () => {
    const a = await get("/v1/limits", READ);
    const b = await get("/v1/limits?explain=0", READ);
    // the only parts of the text that differ between two requests are the request id and the key's own remaining budget
    const same = (t) => t.replace(/"requestId":"[^"]+"/, "").replace(/"client":\{[^}]*\}/, "");
    expect(Object.keys(a.json.data)).toEqual(["safety", "brokers", "client", "accounts"]);
    expect(Object.keys(b.json.data)).toEqual(["safety", "brokers", "client", "accounts"]);
    expect(same(b.text)).toBe(same(a.text));
    expect(a.text).not.toMatch(/"pools"|"consumers"|"you"/);
  });

  it("shows only the account's pools the key may see, and consumers only to admin keys (others see themselves)", async () => {
    const r = await get("/v1/limits?explain=1&account=dhan-main", READ);
    expect(r.json.data.pools.every((p) => p.accountId === "dhan-main")).toBe(true);
    expect(r.json.data.consumers.every((c) => c.id === "key:read0000001")).toBe(true);
  });
});
