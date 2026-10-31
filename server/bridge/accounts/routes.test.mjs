/**
 * S1 routes end to end through the real request pipeline (createApp), with fixture adapters, an in-memory
 * SecretStore, a fake key store and a capturing audit log. The capture tests prove that a typed password/TOTP and
 * saved tokens never reach a response, a log line, the audit log or (for the secrets) the SecretStore.
 */
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrokerRegistry } from "../../brokers/registry.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import accountsModule, { ROUTES } from "./module.mjs";
import { createAccountRoutes } from "./routes.mjs";
import { apiKeyAdapter, createCapturingLogger, createMemorySecretStore, createStubRegistry, sessionAdapter } from "./__fixtures__/stubs.mjs";

const PASSWORD = "Pw-route-7c6b5a";
const TOTP = "907153";
const ACCESS = "eyJhbGciOiJIUzI1NiJ9.route-token.sig12345";
const KEYS = {
  mcb_read0000001_aaaaaaaaaaaaaaaaaaaa: { id: "read0000001", label: "reader", scopes: ["read"], accounts: "*" },
  mcb_onlydhan001_bbbbbbbbbbbbbbbbbbbb: { id: "onlydhan001", label: "dhan-only", scopes: ["read"], accounts: ["dhan-main"] },
  mcb_admin000001_dddddddddddddddddddd: { id: "admin000001", label: "admin", scopes: ["admin"], accounts: "*" },
};
const READ = "mcb_read0000001_aaaaaaaaaaaaaaaaaaaa";
const ONLY_DHAN = "mcb_onlydhan001_bbbbbbbbbbbbbbbbbbbb";
const ADMIN = "mcb_admin000001_dddddddddddddddddddd";

const auditRecords = [];
const fakeAudit = {
  ...notImplementedService("audit"),
  append: async (input) => {
    auditRecords.push(structuredClone(input));
    return { ...input, seq: auditRecords.length, at: new Date().toISOString(), prevHash: "", hash: "" };
  },
};
const fakeKeyStore = { ...notImplementedService("keyStore"), authenticate: async (raw) => KEYS[raw] ?? null };

let app;
let port;
let cap;
let store;
let sess;
const bodies = [];

function call(method, path, { key, body, raw } = {}) {
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  const headers = { host: `127.0.0.1:${port}` };
  if (key) headers.authorization = `Bearer ${key}`;
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        bodies.push(text);
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-acc-routes-"));
  const real = createBrokerRegistry();
  sess = sessionAdapter();
  const adapters = Object.fromEntries(real.list().map((id) => [id, real.get(id)]));
  // Replace the two brokers the tests log in to with network-free fixtures.
  adapters.dhan = { ...apiKeyAdapter({ id: "dhan" }) };
  adapters.angelone = sess;
  const { config } = loadConfig({
    raw: {
      server: { port: 0 },
      dataDir,
      accounts: [
        { id: "dhan-main", broker: "dhan", label: "Dhan main" },
        { id: "angel-1", broker: "angelone" },
        { id: "paper", broker: "paper" },
      ],
    },
    env: {},
  });
  cap = createCapturingLogger();
  store = createMemorySecretStore();
  app = await createApp({
    config,
    modules: [accountsModule],
    overrides: { keyStore: fakeKeyStore, secrets: store, audit: fakeAudit },
    logger: cap.logger,
    brokers: createStubRegistry(adapters),
  });
  ({ port } = await app.listen());
});

afterAll(async () => {
  await app?.close();
});

describe("route table", () => {
  it("keeps the contract options (scope, loopback-only for credential routes)", () => {
    const opts = Object.fromEntries(ROUTES.map(([m, p, o]) => [`${m} ${p}`, o]));
    expect(opts["POST /v1/accounts/:accountId/session"]).toMatchObject({ scope: "admin", loopbackOnly: true });
    expect(opts["DELETE /v1/accounts/:accountId/session"]).toMatchObject({ scope: "admin", loopbackOnly: true });
    expect(opts["GET /v1/accounts"]).toMatchObject({ scope: "read" });
    expect(opts["POST /v1/accounts/:accountId/test"]).toMatchObject({ scope: "read" });
  });
});

describe("GET /v1/brokers", () => {
  it("lists all 41 adapters with auth kind, capabilities and verification", async () => {
    expect((await call("GET", "/v1/brokers")).status).toBe(401);
    const r = await call("GET", "/v1/brokers", { key: READ });
    expect(r.status).toBe(200);
    expect(r.json.meta.requestId).toMatch(/^req_/);
    expect(r.json.data).toHaveLength(41);
    const zerodha = r.json.data.find((b) => b.id === "zerodha");
    expect(zerodha).toMatchObject({ name: "Zerodha (Kite)", authKind: "oauthRedirect", verified: false });
    expect(zerodha.capabilities).toContain("optionChain");
    expect(zerodha.capabilities).not.toContain("auth");
    expect(r.json.data.find((b) => b.id === "dhan").verified).toBe(true);
    expect(r.json.data.filter((b) => b.verified).map((b) => b.id)).toEqual(["dhan"]);
  });

  it("uses the scheduler's policy when S3 is running, else the static table", () => {
    const deps = {
      brokers: createStubRegistry({ dhan: apiKeyAdapter({ id: "dhan" }) }),
      accounts: {},
      scheduler: { policyFor: (id) => ({ brokerId: id, pooling: "not-allowed" }) },
    };
    const ctx = { requestId: "req_x" };
    expect(createAccountRoutes(deps).listBrokers(ctx).data[0].policy).toEqual({ brokerId: "dhan", pooling: "not-allowed" });
    const stubbed = { ...deps, scheduler: notImplementedService("scheduler") };
    expect(createAccountRoutes(stubbed, { policies: { dhan: { pooling: "allowed" } } }).listBrokers(ctx).data[0].policy).toEqual({ pooling: "allowed" });
    expect(createAccountRoutes(stubbed).listBrokers(ctx).data[0].policy).toBeUndefined();
  });
});

describe("GET /v1/accounts", () => {
  it("lists only the accounts the key may use", async () => {
    const all = await call("GET", "/v1/accounts", { key: READ });
    expect(all.status).toBe(200);
    expect(all.json.data.map((a) => a.id)).toEqual(["dhan-main", "angel-1", "paper"]);
    const one = await call("GET", "/v1/accounts", { key: ONLY_DHAN });
    expect(one.json.data.map((a) => a.id)).toEqual(["dhan-main"]);
  });

  it("GET one account checks access before existence", async () => {
    expect((await call("GET", "/v1/accounts/dhan-main", { key: ONLY_DHAN })).json.data.id).toBe("dhan-main");
    const forbidden = await call("GET", "/v1/accounts/angel-1", { key: ONLY_DHAN });
    expect(forbidden.status).toBe(403);
    expect(forbidden.json.code).toBe("ACCOUNT_FORBIDDEN");
    expect((await call("GET", "/v1/accounts/no-such", { key: ONLY_DHAN })).json.code).toBe("ACCOUNT_FORBIDDEN");
    const missing = await call("GET", "/v1/accounts/no-such", { key: READ });
    expect(missing.status).toBe(404);
    expect(missing.json.code).toBe("ACCOUNT_NOT_FOUND");
  });
});

describe("sessions", () => {
  it("connect needs an admin key", async () => {
    const r = await call("POST", "/v1/accounts/dhan-main/session", { key: READ, body: { values: { accessToken: ACCESS } } });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("SCOPE_REQUIRED");
  });

  it("connects a key broker; the response, audit and logs never contain the token", async () => {
    const r = await call("POST", "/v1/accounts/dhan-main/session", { key: ADMIN, body: { values: { clientId: "1100", accessToken: ACCESS } } });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ state: "connected", expiresAt: null });
    expect(r.json.meta.accountId).toBe("dhan-main");
    expect(auditRecords.at(-1)).toMatchObject({ type: "account.connected", accountId: "dhan-main", actor: { kind: "key", id: "admin000001" }, data: { broker: "dhan", state: "connected", previousState: "missing" } });
    const t = await call("POST", "/v1/accounts/dhan-main/test", { key: READ });
    expect(t.json.data).toEqual({ ok: true, message: "Connected to stub." });
    const list = await call("GET", "/v1/accounts", { key: READ });
    expect(list.json.data[0].session.state).toBe("connected");
  });

  it("logs in a session broker: secrets never reach responses, logs, audit or SecretStore", async () => {
    const r = await call("POST", "/v1/accounts/angel-1/session", { key: ADMIN, body: { values: { apiKey: "smart-key-route", clientId: "A1" }, secrets: { password: PASSWORD, totpCode: TOTP } } });
    expect(r.status).toBe(200);
    expect(r.json.data.state).toBe("connected");
    expect(sess.logins).toHaveLength(1);
    expect(sess.logins[0]).toMatchObject({ password: PASSWORD, totpCode: TOTP });
    expect(JSON.stringify(store.writes)).not.toContain(PASSWORD);
    expect(JSON.stringify(store.writes)).not.toContain(TOTP);
  });

  it("a failed login answers problem+json without the secret and audits the failure", async () => {
    const before = sess.logins.length;
    const original = sess.login;
    sess.login = async (c) => {
      sess.logins.push({ ...c });
      const { BrokerError } = await import("../../brokers/contract.mjs");
      throw new BrokerError(`wrong pin ${c.password} / ${c.totpCode}`, { code: "UPSTREAM_AUTH" });
    };
    const r = await call("POST", "/v1/accounts/angel-1/session", { key: ADMIN, body: { secrets: { password: PASSWORD, totpCode: TOTP } } });
    sess.login = original;
    expect(sess.logins.length).toBe(before + 1);
    expect(r.status).toBe(502);
    expect(r.json.code).toBe("UPSTREAM_ERROR");
    expect(auditRecords.at(-1)).toMatchObject({ type: "account.connect_failed", accountId: "angel-1", data: { code: "UPSTREAM_ERROR" } });
  });

  it("validation errors name fields, never values", async () => {
    const r = await call("POST", "/v1/accounts/dhan-main/session", { key: ADMIN, body: { values: { mpin: PASSWORD } } });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("VALIDATION_FAILED");
    expect(r.json.errors[0].path).toBe("values.mpin");
    const arr = await call("POST", "/v1/accounts/dhan-main/session", { key: ADMIN, raw: "[1]" });
    expect(arr.status).toBe(400);
    const paper = await call("POST", "/v1/accounts/paper/session", { key: ADMIN, body: {} });
    expect(paper.json.code).toBe("CAPABILITY_UNSUPPORTED");
  });

  it("test takes no body; paper always passes", async () => {
    expect((await call("POST", "/v1/accounts/dhan-main/test", { key: READ, body: { x: 1 } })).status).toBe(400);
    expect((await call("POST", "/v1/accounts/paper/test", { key: READ })).json.data.ok).toBe(true);
  });

  it("disconnect forgets the session and is audited", async () => {
    const r = await call("DELETE", "/v1/accounts/angel-1/session", { key: ADMIN });
    expect(r.status).toBe(200);
    expect(r.json.data.state).toBe("missing");
    expect(auditRecords.at(-1)).toMatchObject({ type: "account.disconnected", accountId: "angel-1", data: { state: "missing", previousState: "connected" } });
    expect(store.data.get("account:angel-1")).toMatchObject({ values: { apiKey: "smart-key-route", clientId: "A1" }, session: null });
    const t = await call("POST", "/v1/accounts/angel-1/test", { key: READ });
    expect(t.json.data.ok).toBe(false);
  });

  it("capture: no secret or saved token appears in any response, log line or audit record", () => {
    const everything = [...bodies, ...cap.lines, JSON.stringify(auditRecords)].join("\n");
    for (const secret of [PASSWORD, TOTP, ACCESS, "sess-token-abcdef123", "feed-token-xyz789"]) expect(everything).not.toContain(secret);
    expect(cap.lines.some((l) => l.includes('"msg":"account connected"'))).toBe(true);
  });
});

describe("audit fallback", () => {
  it("proceeds and warns when the audit log is still a stub", async () => {
    const warnings = [];
    const deps = {
      brokers: createStubRegistry({}),
      audit: notImplementedService("audit"),
      accounts: { status: () => ({ state: "missing" }), get: () => ({ broker: "x" }), disconnect: async () => ({ state: "missing" }) },
    };
    const ctx = { requestId: "req_y", params: { accountId: "aa" }, requireAccountAccess: () => {}, log: { warn: (m) => warnings.push(m), error: () => {} }, principal: { kind: "local", id: "cli" }, source: "cli" };
    const r = await createAccountRoutes(deps).disconnect(ctx);
    expect(r.data.state).toBe("missing");
    expect(warnings).toEqual(["audit log not available; action not audited"]);
  });
});
