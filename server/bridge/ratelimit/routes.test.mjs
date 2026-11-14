/**
 * ratelimit routes end to end through the real request pipeline (createApp) with the real scheduler, a fake AccountManager
 * and a fake key store: GET /v1/limits, GET /v1/usage, the per-key client limit and the config section.
 */
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { createLogger } from "../core/logger.mjs";
import ratelimitModule, { ROUTES } from "./module.mjs";

const KEYS = {
  mcb_read0000001_aaaaaaaaaaaaaaaaaaaa: { id: "read0000001", label: "reader", scopes: ["read"], accounts: "*" },
  mcb_onlydhan001_bbbbbbbbbbbbbbbbbbbb: { id: "onlydhan001", label: "dhan-only", scopes: ["read"], accounts: ["dhan-main"] },
  mcb_burst000001_cccccccccccccccccccc: { id: "burst000001", label: "burst", scopes: ["read"], accounts: "*" },
};
const READ = "mcb_read0000001_aaaaaaaaaaaaaaaaaaaa";
const ONLY_DHAN = "mcb_onlydhan001_bbbbbbbbbbbbbbbbbbbb";
const BURST = "mcb_burst000001_cccccccccccccccccccc";

let app;
let port;

function get(path, key) {
  const headers = { host: `127.0.0.1:${port}` };
  if (key) headers.authorization = `Bearer ${key}`;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path, headers }, (res) => {
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
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function rawConfig(extra = {}) {
  return {
    server: { port: 0 },
    dataDir: mkdtempSync(join(tmpdir(), "mcb-ratelimit-")),
    accounts: [
      { id: "zerodha-main", broker: "zerodha", limits: { dailyMaxOrders: 20 } },
      { id: "dhan-main", broker: "dhan" },
      { id: "paper", broker: "paper" },
    ],
    ...extra,
  };
}

beforeAll(async () => {
  const { config } = loadConfig({
    raw: rawConfig({ ratelimit: { client: { perSecond: 50, keys: { burst000001: { perSecond: 2 } } }, brokers: { zerodha: { limits: { history: { perSecond: 2 } } } } } }),
    env: {},
  });
  const accounts = createFakeAccountManager({
    accounts: [
      { id: "zerodha-main", broker: "zerodha" },
      { id: "dhan-main", broker: "dhan" },
      { id: "paper", broker: "paper" },
    ],
  });
  app = await createApp({
    config,
    modules: [ratelimitModule],
    overrides: { keyStore: { ...notImplementedService("keyStore"), authenticate: async (raw) => KEYS[raw] ?? null }, accounts },
    logger: createLogger({ level: "silent" }),
  });
  ({ port } = await app.listen());
});

afterAll(async () => {
  await app?.close();
});

describe("route table", () => {
  it("keeps the contract options", () => {
    expect(ROUTES.map(([m, p, o]) => [m, p, o])).toEqual([
      ["GET", "/v1/limits", { scope: "read" }],
      ["GET", "/v1/usage", { scope: "read" }],
      ["GET", "/v1/quotas", { scope: "read" }],
      ["PUT", "/v1/quotas/:keyId", { scope: "admin", loopbackOnly: true }],
      ["DELETE", "/v1/quotas/:keyId", { scope: "admin", loopbackOnly: true, body: "none" }],
    ]);
  });

  it("needs a key", async () => {
    expect((await get("/v1/limits")).status).toBe(401);
    expect((await get("/v1/usage")).status).toBe(401);
  });

  it("reports the scheduler as ready", async () => {
    const r = await get("/v1/health");
    expect(r.json.services.scheduler).toBe("ready");
  });
});

describe("GET /v1/limits", () => {
  it("shows safety limits, effective broker policies, budgets and the caller's own budget", async () => {
    const r = await get("/v1/limits", READ);
    expect(r.status).toBe(200);
    const { data, meta } = r.json;
    expect(meta).toMatchObject({ requestId: expect.stringMatching(/^req_/), accountId: null });
    expect(Object.keys(data.safety).sort()).toEqual(["dhan-main", "paper", "zerodha-main"]);
    expect(data.safety["zerodha-main"]).toMatchObject({ dailyMaxOrders: 20, orderRatePerSecond: 5 });
    expect(Object.keys(data.brokers).sort()).toEqual(["dhan", "zerodha"]);
    expect(data.brokers.zerodha.limits.history).toMatchObject({ perSecond: 2, verified: true, lowered: true });
    expect(data.brokers.zerodha.pooling).toBe("unknown");
    expect(data.brokers.dhan.maxModificationsPerOrder).toBe(25);
    expect(data.client).toMatchObject({ perSecond: 50, burst: 50 });
    expect(data.client.remaining).toBeGreaterThan(40);
    const z = data.accounts.find((a) => a.accountId === "zerodha-main");
    expect(z.classes.quote).toEqual({ remaining: 1, limit: 1, resetMs: 0 });
    expect(data.accounts.some((a) => a.accountId === "paper")).toBe(false);
    expect(r.headers.ratelimit).toMatch(/^limit=50, remaining=\d+, reset=\d+$/);
    expect(r.headers["ratelimit-policy"]).toBe("50;w=1;burst=50");
  });

  it("only shows the accounts a key may use", async () => {
    const r = await get("/v1/limits", ONLY_DHAN);
    expect(Object.keys(r.json.data.safety)).toEqual(["dhan-main"]);
    expect(Object.keys(r.json.data.brokers)).toEqual(["dhan"]);
    const forbidden = await get("/v1/limits?account=zerodha-main", ONLY_DHAN);
    expect(forbidden.status).toBe(403);
    expect(forbidden.json.code).toBe("ACCOUNT_FORBIDDEN");
  });

  it("filters to one account, and validates the parameter", async () => {
    const r = await get("/v1/limits?account=dhan-main", READ);
    expect(r.status).toBe(200);
    expect(r.json.meta.accountId).toBe("dhan-main");
    expect(Object.keys(r.json.data.safety)).toEqual(["dhan-main"]);
    expect((await get("/v1/limits?account=nobody", READ)).json.code).toBe("ACCOUNT_NOT_FOUND");
    expect((await get("/v1/limits?account=Bad!", READ)).status).toBe(400);
  });
});

describe("GET /v1/usage", () => {
  it("shows per-class budgets and savings for visible accounts only", async () => {
    const all = await get("/v1/usage", READ);
    expect(all.status).toBe(200);
    expect(all.json.data.accounts.map((a) => a.accountId).sort()).toEqual(["dhan-main", "zerodha-main"]);
    const z = all.json.data.accounts.find((a) => a.accountId === "zerodha-main");
    expect(z.classes.quote).toMatchObject({ used: 0, limit: 1, queued: 0, resetMs: 0 });
    expect(all.json.data.savings).toMatchObject({ servedFromStream: 0, servedFromCache: 0, coalesced: 0, batched: 0 });
    const one = await get("/v1/usage", ONLY_DHAN);
    expect(one.json.data.accounts.map((a) => a.accountId)).toEqual(["dhan-main"]);
  });
});

describe("client rate limit", () => {
  it("answers 429 RATE_LIMITED with Retry-After when a key's budget is spent", async () => {
    expect((await get("/v1/usage", BURST)).status).toBe(200);
    expect((await get("/v1/usage", BURST)).status).toBe(200);
    const r = await get("/v1/usage", BURST);
    expect(r.status).toBe(429);
    expect(r.json.code).toBe("RATE_LIMITED");
    expect(Number(r.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(r.headers.ratelimit).toMatch(/^limit=2, remaining=0, reset=\d+$/);
    // Other keys are unaffected.
    expect((await get("/v1/usage", READ)).status).toBe(200);
  });
});

describe("config section", () => {
  it("refuses to boot with an override that raises a broker limit", async () => {
    const { config } = loadConfig({ raw: rawConfig({ ratelimit: { brokers: { zerodha: { limits: { quote: { perSecond: 5 } } } } } }), env: {} });
    await expect(createApp({ config, modules: [ratelimitModule], logger: createLogger({ level: "silent" }) })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringMatching(/ratelimit\.brokers\.zerodha\.limits\.quote\.perSecond/),
    });
  });
});
