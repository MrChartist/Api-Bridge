import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { createCallContext } from "../core/context.mjs";
import { createLogger, createNullLogger } from "../core/logger.mjs";
import { createFakeKeyStore } from "./fake.mjs";
import { createKeyStore } from "./keyStore.mjs";
import authModule, { auditKeyEvent, createHandlers, ROUTES } from "./module.mjs";

const auditRecords = [];
const fakeAudit = {
  ...notImplementedService("audit"),
  append: async (input) => {
    auditRecords.push(input);
    return { ...input, seq: auditRecords.length };
  },
};

let app;
let port;
let adminKey;
let readKey;
const logLines = [];

function request(path, { method = "GET", headers = {}, body } = {}) {
  const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  const extra = payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...extra, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = JSON.parse(raw);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
const bearer = (k) => ({ authorization: `Bearer ${k}` });

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-auth-"));
  const { config } = loadConfig({ raw: { server: { port: 0 }, dataDir }, env: {} });
  const logger = createLogger({ level: "debug", write: (l) => logLines.push(l) });
  app = await createApp({ config, modules: [authModule], overrides: { audit: fakeAudit }, logger });
  ({ port } = await app.listen());
  // Bootstrap as the CLI would.
  ({ key: adminKey } = await app.deps.keyStore.create({ label: "cli admin", scopes: ["admin"] }));
  ({ key: readKey } = await app.deps.keyStore.create({ label: "reader", scopes: ["read"] }));
});

afterAll(async () => {
  await app?.close();
});

describe("auth routes", () => {
  it("declares the contract routes", () => {
    const listed = app.router.list().filter((r) => r.module === "auth").map((r) => `${r.method} ${r.pattern}`);
    expect(listed.sort()).toEqual(ROUTES.map(([m, p]) => `${m} ${p}`).sort());
  });

  it("needs a key, and admin scope for /v1/keys", async () => {
    expect((await request("/v1/keys")).status).toBe(401);
    const r = await request("/v1/keys", { headers: bearer(readKey) });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("SCOPE_REQUIRED");
  });

  it("creates a key (201, shown once), audits it, and the new key works", async () => {
    const r = await request("/v1/keys", { method: "POST", headers: bearer(adminKey), body: { label: "Excel sheet", scopes: ["read"], allowQuery: true, clientKind: "excel" } });
    expect(r.status).toBe(201);
    expect(r.json.data.key).toMatch(/^mcb_[a-z2-7]{10}_/);
    expect(r.json.data.record).toMatchObject({ label: "Excel sheet", scopes: ["read"], allowQuery: true, clientKind: "excel" });
    expect(r.json.meta.requestId).toBe(r.headers["x-request-id"]);
    expect(r.headers["cache-control"]).toBe("no-store");
    const audit = auditRecords.find((a) => a.type === "key.created" && a.data.keyId === r.json.data.record.id);
    expect(audit).toMatchObject({ actor: { kind: "key" }, source: "rest", data: { scopes: ["read"] } });
    expect(JSON.stringify(audit)).not.toContain(r.json.data.key);

    const list = await request("/v1/keys", { headers: bearer(adminKey) });
    expect(list.status).toBe(200);
    expect(list.json.data.map((k) => k.label)).toContain("Excel sheet");
    expect(list.raw).not.toContain(r.json.data.key.slice(15));
    expect(list.raw).not.toMatch(/"hash"|"salt"/);

    const stream = await request("/v1/stream/token", { method: "POST", headers: bearer(r.json.data.key) });
    expect(stream.status).toBe(200);
  });

  it("validates the body", async () => {
    const bad = await request("/v1/keys", { method: "POST", headers: bearer(adminKey), body: { label: "x", scopes: ["paper"], allowQuery: true } });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("VALIDATION_FAILED");
    const none = await request("/v1/keys", { method: "POST", headers: bearer(adminKey) });
    expect(none.status).toBe(400);
    const arr = await request("/v1/keys", { method: "POST", headers: bearer(adminKey), body: [1] });
    expect(arr.status).toBe(400);
  });

  it("revokes immediately: the very next request with that key fails", async () => {
    const created = await request("/v1/keys", { method: "POST", headers: bearer(adminKey), body: { label: "to revoke", scopes: ["paper"] } });
    const { key, record } = created.json.data;
    expect((await request("/v1/stream/token", { method: "POST", headers: bearer(key) })).status).toBe(200);
    const del = await request(`/v1/keys/${record.id}`, { method: "DELETE", headers: bearer(adminKey) });
    expect(del.status).toBe(200);
    expect(del.json.data.revokedAt).toBeTruthy();
    expect(auditRecords.filter((a) => a.type === "key.revoked" && a.data.keyId === record.id)).toHaveLength(1);
    const after = await request("/v1/stream/token", { method: "POST", headers: bearer(key) });
    expect(after.status).toBe(401);
    // Second revoke: same record, no second audit line.
    expect((await request(`/v1/keys/${record.id}`, { method: "DELETE", headers: bearer(adminKey) })).status).toBe(200);
    expect(auditRecords.filter((a) => a.type === "key.revoked" && a.data.keyId === record.id)).toHaveLength(1);
    expect((await request("/v1/keys/zzzzzzzzzz", { method: "DELETE", headers: bearer(adminKey) })).status).toBe(404);
    expect((await request("/v1/keys/NOT-AN-ID", { method: "DELETE", headers: bearer(adminKey) })).status).toBe(404);
  });

  it("issues single-use stream tokens to read keys", async () => {
    const r = await request("/v1/stream/token", { method: "POST", headers: bearer(readKey) });
    expect(r.status).toBe(200);
    expect(r.json.data.token).toMatch(/^mcb_st_/);
    expect(Date.parse(r.json.data.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000);
    const rec = await app.deps.keyStore.verifyStreamToken(r.json.data.token);
    expect(rec.label).toBe("reader");
    expect(await app.deps.keyStore.verifyStreamToken(r.json.data.token)).toBeNull();
    // It takes no body.
    const withBody = await request("/v1/stream/token", { method: "POST", headers: bearer(readKey), body: { a: 1 } });
    expect(withBody.status).toBe(400);
  });

  it("never logs keys or stream tokens", async () => {
    const r = await request("/v1/stream/token", { method: "POST", headers: bearer(readKey) });
    const all = logLines.join("\n");
    expect(all).not.toContain(readKey);
    expect(all).not.toContain(adminKey);
    expect(all).not.toContain(r.json.data.token);
    expect(all).toContain('"msg":"http"');
  });
});

describe("handlers (unit, with fakes)", () => {
  const log = createNullLogger();

  it("refuses live/admin key creation from a non-loopback context", async () => {
    const keyStore = createFakeKeyStore();
    const h = createHandlers({ keyStore, audit: fakeAudit });
    const ctx = createCallContext({ source: "rest", log, principal: { kind: "key", id: "x", label: "x" } });
    ctx.loopback = false;
    ctx.body = { label: "remote", scopes: ["live"] };
    await expect(h.createKey(ctx)).rejects.toMatchObject({ code: "LOOPBACK_ONLY" });
    ctx.body = { label: "remote", scopes: ["read"] };
    const reply = await h.createKey(ctx);
    expect(reply.status).toBe(201);
  });

  it("an admin key without live cannot mint a live key over HTTP (admin does not imply live)", async () => {
    const keyStore = createKeyStore({ logger: log, paths: { dataDir: mkdtempSync(join(tmpdir(), "mcb-auth-escalate-")) } }, { scryptParams: { N: 2 ** 14, r: 8, p: 1 } });
    const h = createHandlers({ keyStore, audit: fakeAudit });
    const admin = createCallContext({ source: "rest", log, key: { id: "adminkey01", label: "dash", scopes: ["admin"], accounts: "*" } });
    admin.body = { label: "escalate", scopes: ["live"], accounts: "*" };
    await expect(h.createKey(admin)).rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
    const adminLive = createCallContext({ source: "rest", log, key: { id: "adminkey02", label: "owner", scopes: ["admin", "live"], accounts: "*" } });
    adminLive.body = { label: "ok", scopes: ["live"] };
    expect((await h.createKey(adminLive)).status).toBe(201);
  });

  it("tolerates the audit stub and audit failures", async () => {
    const warnings = [];
    const ctxLog = { ...createNullLogger(), warn: (m) => warnings.push(m), error: (m) => warnings.push(m) };
    const ctx = createCallContext({ source: "rest", log, principal: { kind: "key", id: "x", label: "x" } });
    ctx.log = ctxLog;
    await auditKeyEvent({ audit: notImplementedService("audit") }, ctx, "key.created", { keyId: "abc" });
    await auditKeyEvent({ audit: { append: async () => { throw new Error("disk full"); } } }, ctx, "key.created", { keyId: "abc" });
    expect(warnings).toHaveLength(2);
  });

  it("stream token handler needs a key on the context", async () => {
    const h = createHandlers({ keyStore: createFakeKeyStore(), audit: fakeAudit });
    const ctx = createCallContext({ source: "rest", log });
    await expect(h.createStreamToken(ctx)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
