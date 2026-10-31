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
import authModule, { MAX_FAILED_SIGN_IN, SIGN_IN_FAILED, auditKeyEvent, createHandlers, ROUTES } from "./module.mjs";
import { SIGN_IN_KEY_TTL_MS, SIGN_IN_TTL_MS, createSignInCode } from "./signIn.mjs";

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

  it("an account-limited admin key sees and revokes only keys limited to its own accounts", async () => {
    const ks = app.deps.keyStore;
    const { key: limitedAdmin } = await ks.create({ label: "desk A admin", scopes: ["admin"], accounts: ["acct-a"] });
    const { record: ownKey } = await ks.create({ label: "desk A script", scopes: ["paper"], accounts: ["acct-a"] });
    const { record: otherKey } = await ks.create({ label: "desk B script", scopes: ["paper"], accounts: ["acct-b"] });
    const { record: mixedKey } = await ks.create({ label: "both desks", scopes: ["read"], accounts: ["acct-a", "acct-b"] });

    const list = await request("/v1/keys", { headers: bearer(limitedAdmin) });
    expect(list.status).toBe(200);
    const labels = list.json.data.map((k) => k.label);
    expect(labels).toEqual(expect.arrayContaining(["desk A admin", "desk A script"]));
    for (const hidden of ["desk B script", "both desks", "cli admin", "reader"]) expect(labels).not.toContain(hidden);

    // Out-of-scope keys answer exactly like unknown ids, and stay active.
    for (const id of [otherKey.id, mixedKey.id]) {
      const r = await request(`/v1/keys/${id}`, { method: "DELETE", headers: bearer(limitedAdmin) });
      expect(r.status).toBe(404);
      expect((await ks.get(id)).revokedAt).toBeNull();
    }
    expect((await request(`/v1/keys/${ownKey.id}`, { method: "DELETE", headers: bearer(limitedAdmin) })).status).toBe(200);

    // An unlimited admin key still sees everything.
    const all = (await request("/v1/keys", { headers: bearer(adminKey) })).json.data.map((k) => k.label);
    expect(all).toEqual(expect.arrayContaining(["desk B script", "both desks", "cli admin"]));
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

describe("POST /v1/sign-in (one-time sign-in links)", () => {
  const signIn = (code, headers = {}) => request("/v1/sign-in", { method: "POST", headers, body: code === undefined ? undefined : { code } });

  it("exchanges a fresh code for a working admin key that expires in 30 days, audited", async () => {
    const { code } = await createSignInCode(app.config.dataDir);
    const t0 = Date.now();
    const r = await signIn(code);
    expect(r.status).toBe(201);
    expect(r.headers["cache-control"]).toBe("no-store");
    const { key, record } = r.json.data;
    expect(key).toMatch(/^mcb_[a-z2-7]{10}_/);
    expect(record).toMatchObject({ label: "Dashboard sign-in", scopes: ["paper", "admin"], accounts: "*", clientKind: "ui", allowQuery: false });
    const ttl = Date.parse(record.expiresAt) - t0;
    expect(ttl).toBeGreaterThan(SIGN_IN_KEY_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(SIGN_IN_KEY_TTL_MS + 1000);
    // The new key is an admin key: it can list keys.
    const list = await request("/v1/keys", { headers: bearer(key) });
    expect(list.status).toBe(200);
    const audit = auditRecords.find((a) => a.type === "key.created" && a.data.keyId === record.id);
    expect(audit).toMatchObject({ actor: { kind: "local", id: "sign-in-link" }, source: "rest", data: { scopes: ["paper", "admin"], createdBy: "sign-in-link", expiresAt: record.expiresAt } });
    expect(JSON.stringify(audit)).not.toContain(key);
    expect(JSON.stringify(audit)).not.toContain(code);
  });

  it("refuses a used, expired or made-up code with one friendly answer", async () => {
    const { code } = await createSignInCode(app.config.dataDir);
    expect((await signIn(code)).status).toBe(201);
    const { code: old } = await createSignInCode(app.config.dataDir, { now: Date.now() - SIGN_IN_TTL_MS - 1000 });
    const answers = [await signIn(code), await signIn(old), await signIn("A".repeat(43)), await signIn("not a code"), await signIn(undefined), await request("/v1/sign-in", { method: "POST", body: [code] })];
    for (const a of answers) {
      expect(a.status).toBe(401);
      expect(a.json).toMatchObject({ code: "UNAUTHENTICATED", detail: SIGN_IN_FAILED });
      expect(a.headers["cache-control"]).toBe("no-store");
    }
  });

  it("works only from this computer, and never spends the code on a refused request", async () => {
    const { code } = await createSignInCode(app.config.dataDir);
    const proxied = await signIn(code, { "x-forwarded-for": "203.0.113.9" });
    expect(proxied.status).toBe(403);
    expect(proxied.json.code).toBe("LOOPBACK_ONLY");
    expect((await signIn(code)).status).toBe(201);
  });

  it("never logs the code or the key", async () => {
    const { code } = await createSignInCode(app.config.dataDir);
    const r = await signIn(code);
    await signIn(code);
    const all = logLines.join("\n");
    expect(all).not.toContain(code);
    expect(all).not.toContain(r.json.data.key);
    expect(all).toContain('"path":"/v1/sign-in"');
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

  it("refuses sign-in for a minute after too many failed attempts", async () => {
    let t = Date.parse("2026-10-28T10:00:00Z");
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-auth-signin-"));
    const h = createHandlers({ keyStore: createFakeKeyStore(), audit: fakeAudit, paths: { dataDir }, clock: { now: () => t } });
    const attempt = (code) => {
      const ctx = createCallContext({ source: "rest", log });
      ctx.body = { code };
      return h.signIn(ctx);
    };
    for (let i = 0; i < MAX_FAILED_SIGN_IN; i += 1) await expect(attempt("A".repeat(43))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    // Even a good code is refused while the limit holds, and is not spent.
    const { code } = await createSignInCode(dataDir, { now: t });
    await expect(attempt(code)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    t += 61_000;
    expect((await attempt(code)).status).toBe(201);
  });
});
