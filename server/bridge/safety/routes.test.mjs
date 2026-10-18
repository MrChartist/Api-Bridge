/**
 * S9 routes end to end through the real request pipeline (createApp) with the real SafetyGuard and AuditLog, a
 * fake key store and a fake AccountManager: GET /v1/safety, POST/DELETE /v1/safety/kill-switch, GET /v1/audit and
 * GET /v1/audit/verify, plus "no secret in the audit file" over HTTP.
 */
import http from "node:http";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { createNullLogger } from "../core/logger.mjs";
import safetyModule, { ROUTES } from "./module.mjs";

const KEYS = {
  mcb_read0000001_aaaaaaaaaaaaaaaaaaaa: { id: "read0000001", label: "reader", scopes: ["read"], accounts: "*" },
  mcb_onlydhan001_bbbbbbbbbbbbbbbbbbbb: { id: "onlydhan001", label: "dhan-only", scopes: ["read"], accounts: ["dhan-main"] },
  mcb_admin000001_cccccccccccccccccccc: { id: "admin000001", label: "admin", scopes: ["admin"], accounts: "*" },
};
const READ = "mcb_read0000001_aaaaaaaaaaaaaaaaaaaa";
const ONLY_DHAN = "mcb_onlydhan001_bbbbbbbbbbbbbbbbbbbb";
const ADMIN = "mcb_admin000001_cccccccccccccccccccc";

let app;
let port;
let dataDir;

function request(method, path, { key, body, headers = {} } = {}) {
  const h = { host: `127.0.0.1:${port}`, ...headers };
  if (key) h.authorization = `Bearer ${key}`;
  const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  if (payload !== undefined) {
    h["content-type"] = h["content-type"] ?? "application/json";
    h["content-length"] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: h }, (res) => {
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
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mcb-safety-routes-"));
  const { config } = loadConfig({
    raw: {
      server: { port: 0 },
      dataDir,
      safety: { liveTrading: true },
      accounts: [
        { id: "dhan-main", broker: "dhan", live: { enabled: true } },
        { id: "zerodha-main", broker: "zerodha", limits: { dailyMaxOrders: 20 } },
      ],
    },
    env: {},
  });
  app = await createApp({
    config,
    modules: [safetyModule],
    logger: createNullLogger(),
    overrides: { keyStore: { ...notImplementedService("keyStore"), authenticate: async (raw) => KEYS[raw] ?? null }, accounts: notImplementedService("accounts") },
  });
  ({ port } = await app.listen());
});

afterAll(async () => {
  await app?.close();
});

describe("module", () => {
  it("registers exactly the contract routes and real services", () => {
    const listed = app.router.list().filter((r) => r.module === "safety" || ROUTES.some(([m, p]) => m === r.method && p === r.pattern));
    expect(listed.map((r) => `${r.method} ${r.pattern}`).sort()).toEqual(ROUTES.map(([m, p]) => `${m} ${p}`).sort());
  });

  it("health shows safety and audit as ready", async () => {
    const r = await request("GET", "/v1/health");
    expect(r.json.services).toMatchObject({ safety: "ready", audit: "ready" });
  });
});

describe("GET /v1/safety", () => {
  it("needs a key and shows only the key's accounts", async () => {
    expect((await request("GET", "/v1/safety")).status).toBe(401);
    const all = await request("GET", "/v1/safety", { key: READ });
    expect(all.status).toBe(200);
    expect(all.json.data).toMatchObject({ killSwitch: { engaged: false }, liveTrading: true });
    expect(all.json.data.accounts.map((a) => a.accountId)).toEqual(["dhan-main", "zerodha-main"]);
    expect(all.json.data.accounts[0]).toMatchObject({ liveAllowedByConfig: true, ordersToday: 0, realisedPnlToday: 0, limits: { orderRatePerSecond: 5 } });
    expect(all.json.meta.requestId).toBeTruthy();
    const one = await request("GET", "/v1/safety", { key: ONLY_DHAN });
    expect(one.json.data.accounts.map((a) => a.accountId)).toEqual(["dhan-main"]);
  });
});

describe("kill switch routes", () => {
  it("validates the engage body", async () => {
    expect((await request("POST", "/v1/safety/kill-switch", { key: READ, body: { reason: "x", extra: 1 } })).json.code).toBe("VALIDATION_FAILED");
    expect((await request("POST", "/v1/safety/kill-switch", { key: READ, body: { reason: "x".repeat(201) } })).status).toBe(400);
  });

  it("an empty POST engages with reason 'manual' (no body needed in a panic)", async () => {
    const on = await request("POST", "/v1/safety/kill-switch", { key: READ });
    expect(on.status).toBe(200);
    expect(on.json.data).toMatchObject({ engaged: true, reason: "manual" });
    expect((await request("DELETE", "/v1/safety/kill-switch", { key: ADMIN, body: { confirm: "RELEASE" } })).status).toBe(200);
  });

  it("a read key engages; release needs admin and RELEASE; both are audited", async () => {
    const on = await request("POST", "/v1/safety/kill-switch", { key: READ, body: { reason: "Stop everything", cancelOpenOrders: true } });
    expect(on.status).toBe(200);
    expect(on.json.data).toMatchObject({ engaged: true, reason: "Stop everything", by: "key:read0000001" });
    // A read key may stop trading but may not cancel open orders (that can remove protective stop-losses).
    expect(on.json.data.warnings.join(" ")).toMatch(/NOT cancelled/);
    expect((await request("GET", "/v1/safety", { key: READ })).json.data.killSwitch.engaged).toBe(true);

    const noAdmin = await request("DELETE", "/v1/safety/kill-switch", { key: READ, body: { confirm: "RELEASE" } });
    expect(noAdmin.status).toBe(403);
    expect(noAdmin.json.code).toBe("SCOPE_REQUIRED");
    const badConfirm = await request("DELETE", "/v1/safety/kill-switch", { key: ADMIN, body: { confirm: "release" } });
    expect(badConfirm.status).toBe(400);
    expect(badConfirm.json.detail).toMatch(/RELEASE/);
    expect((await request("DELETE", "/v1/safety/kill-switch", { key: ADMIN })).status).toBe(400);

    const off = await request("DELETE", "/v1/safety/kill-switch", { key: ADMIN, body: { confirm: "RELEASE" } });
    expect(off.status).toBe(200);
    expect(off.json.data).toEqual({ engaged: false, reason: null, by: null, at: null });

    const audit = await request("GET", "/v1/audit?type=kill_switch.*", { key: ADMIN });
    expect(audit.status).toBe(200);
    expect(audit.json.data.map((r) => r.type).slice(0, 2)).toEqual(["kill_switch.released", "kill_switch.engaged"]);
    expect(audit.json.data[1]).toMatchObject({ actor: { kind: "key", id: "read0000001" }, source: "rest", data: { reason: "Stop everything", cancelOpenOrders: false, cancelRequested: true } });
    expect(audit.json.meta.nextCursor).toBeNull();
  });
});

describe("audit routes", () => {
  it("are admin only", async () => {
    expect((await request("GET", "/v1/audit", { key: READ })).status).toBe(403);
    expect((await request("GET", "/v1/audit/verify", { key: READ })).status).toBe(403);
  });

  it("paginate with a cursor and validate parameters", async () => {
    for (let n = 0; n < 4; n += 1) await app.deps.audit.append({ type: "test.event", actor: { kind: "system", id: "t" }, source: "system", accountId: "zerodha-main", data: { n } });
    const p1 = await request("GET", "/v1/audit?type=test.event&limit=3", { key: ADMIN });
    expect(p1.json.data.map((r) => r.data.n)).toEqual([3, 2, 1]);
    const p2 = await request("GET", `/v1/audit?type=test.event&limit=3&cursor=${encodeURIComponent(p1.json.meta.nextCursor)}`, { key: ADMIN });
    expect(p2.json.data.map((r) => r.data.n)).toEqual([0]);
    expect(p2.json.meta.nextCursor).toBeNull();
    expect((await request("GET", "/v1/audit?account=zerodha-main&limit=500", { key: ADMIN })).json.data).toHaveLength(4);
    expect((await request("GET", "/v1/audit?limit=0", { key: ADMIN })).json.code).toBe("VALIDATION_FAILED");
    expect((await request("GET", "/v1/audit?bogus=1", { key: ADMIN })).json.code).toBe("VALIDATION_FAILED");
    expect((await request("GET", "/v1/audit?type=a&type=b", { key: ADMIN })).json.code).toBe("VALIDATION_FAILED");
    expect((await request("GET", "/v1/audit?cursor=zzz", { key: ADMIN })).json.code).toBe("VALIDATION_FAILED");
  });

  it("verify reports ok, then the exact broken line after tampering", async () => {
    const ok = await request("GET", "/v1/audit/verify", { key: ADMIN });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ ok: true, brokenAt: null });
    const checked = ok.json.data.checked;
    expect(checked).toBeGreaterThan(3);
    expect((await request("GET", "/v1/audit/verify?day=19-10-2026", { key: ADMIN })).json.code).toBe("VALIDATION_FAILED");

    const dir = join(dataDir, "audit");
    const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"));
    const lines = readFileSync(join(dir, file), "utf8").trimEnd().split("\n");
    lines[1] = lines[1].replace('"source":"rest"', '"source":"mcp"');
    writeFileSync(join(dir, file), lines.join("\n") + "\n");
    const bad = await request("GET", "/v1/audit/verify", { key: ADMIN });
    expect(bad.json.data).toMatchObject({ ok: false, brokenAt: 2, line: 2, day: file.slice(0, 10) });
    const day = await request("GET", `/v1/audit/verify?day=${file.slice(0, 10)}`, { key: ADMIN });
    expect(day.json.data).toMatchObject({ ok: false, brokenAt: 2 });
  });

  it("no API key or secret reaches the audit file", async () => {
    await request("POST", "/v1/safety/kill-switch", { key: READ, body: { reason: `leaked ${READ} and Bearer abcdefghijklmnopqrstu` } });
    const dir = join(dataDir, "audit");
    const text = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("");
    for (const k of Object.keys(KEYS)) expect(text).not.toContain(k);
    expect(text).not.toContain("abcdefghijklmnopqrstu");
  });
});
