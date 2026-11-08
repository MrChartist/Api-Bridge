/**
 * Pooling routes through the real request pipeline: GET /v1/pooling, PUT and DELETE /v1/pooling/consent. Access rules
 * (read for GET; admin and this computer only for writes), validation (different holders, unknown and paper accounts,
 * a not-allowed broker), the audit trail, per-key visibility and the effect on the AccountManager (consent gate).
 */
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { defineModule } from "../core/modules.mjs";
import accountsModule from "../accounts/module.mjs";
import { apiKeyAdapter, createCapturingLogger, createMemorySecretStore, createStubRegistry } from "../accounts/__fixtures__/stubs.mjs";
import { POOLING_NOTICE_VERSION, createPoolingService } from "./pooling.mjs";
import { POOLING_ROUTES, registerPoolingRoutes } from "./poolingRoutes.mjs";

const KEYS = {
  mcb_read0000001_aaaaaaaaaaaaaaaaaaaa: { id: "read0000001", label: "reader", scopes: ["read"], accounts: "*" },
  mcb_admin000001_dddddddddddddddddddd: { id: "admin000001", label: "admin", scopes: ["admin"], accounts: "*" },
  mcb_adminone001_eeeeeeeeeeeeeeeeeeee: { id: "adminone001", label: "admin-one-account", scopes: ["admin"], accounts: ["dhan-main"] },
  mcb_readone0001_ffffffffffffffffffff: { id: "readone0001", label: "read-one-account", scopes: ["read"], accounts: ["dhan-main"] },
};
const READ = "mcb_read0000001_aaaaaaaaaaaaaaaaaaaa";
const ADMIN = "mcb_admin000001_dddddddddddddddddddd";
const ADMIN_ONE = "mcb_adminone001_eeeeeeeeeeeeeeeeeeee";
const READ_ONE = "mcb_readone0001_ffffffffffffffffffff";
const ACK = POOLING_NOTICE_VERSION;
const OPT = { pooling: true, poolingWhenTermsUnknown: true };

const fakeKeyStore = { ...notImplementedService("keyStore"), authenticate: async (raw) => KEYS[raw] ?? null };

function caller(port) {
  return (method, path, { key, body, remote = false } = {}) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { host: `127.0.0.1:${port}`, ...(remote ? { "x-forwarded-for": "8.8.8.8" } : {}) };
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
  };
}

let app;
let call;
let audit;
let dataDir;
let mgr;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mcb-poolroutes-"));
  const { config } = loadConfig({
    raw: {
      dataDir,
      server: { port: 0 },
      logging: { level: "silent" },
      accounts: [
        { id: "dhan-main", broker: "dhan", holder: "self", marketData: OPT },
        { id: "zerodha-main", broker: "zerodha", holder: "self", marketData: OPT },
        { id: "zerodha-spouse", broker: "zerodha", holder: "spouse", marketData: OPT },
        { id: "angel-nohold", broker: "angelone", marketData: OPT },
        { id: "paper", broker: "paper" },
      ],
    },
    env: {},
  });
  audit = [];
  const fakeAudit = { ...notImplementedService("audit"), append: async (input) => (audit.push(structuredClone(input)), { ...input, seq: audit.length }) };
  const poolingModule = defineModule({ name: "pooling-test", stream: "core", register: (a, deps) => void registerPoolingRoutes(a, deps) });
  app = await createApp({
    config,
    modules: [accountsModule, poolingModule],
    overrides: { keyStore: fakeKeyStore, secrets: createMemorySecretStore(), audit: fakeAudit },
    logger: createCapturingLogger().logger,
    brokers: createStubRegistry({ dhan: apiKeyAdapter({ id: "dhan" }), zerodha: apiKeyAdapter({ id: "zerodha" }), angelone: apiKeyAdapter({ id: "angelone" }) }),
  });
  const { port } = await app.listen();
  call = caller(port);
  mgr = app.deps.accounts;
  for (const id of ["dhan-main", "zerodha-main", "zerodha-spouse", "angel-nohold"]) await mgr.connect(id, { values: { accessToken: "t-123456" } });
});
afterAll(async () => {
  await app?.close();
});

const put = (accounts, extra = {}, key = ADMIN) => call("PUT", "/v1/pooling/consent", { key, body: { acknowledge: ACK, accounts, ...extra } });
const unpinned = () => mgr.marketDataCandidates({ capability: "quotes" });

describe("route table", () => {
  it("reads need the read scope; writes are admin and this computer only", () => {
    const opts = Object.fromEntries(POOLING_ROUTES.map(([m, p, o]) => [`${m} ${p}`, o]));
    expect(opts["GET /v1/pooling"]).toMatchObject({ scope: "read" });
    expect(opts["GET /v1/pooling"].loopbackOnly).toBeUndefined();
    expect(opts["PUT /v1/pooling/consent"]).toMatchObject({ scope: "admin", loopbackOnly: true });
    expect(opts["DELETE /v1/pooling/consent"]).toMatchObject({ scope: "admin", loopbackOnly: true, body: "none" });
  });
});

describe("GET /v1/pooling", () => {
  it("needs a key", async () => {
    expect((await call("GET", "/v1/pooling")).status).toBe(401);
  });

  it("answers with no consent, the accounts by holder with each broker's policy and the notice", async () => {
    const r = await call("GET", "/v1/pooling", { key: READ });
    expect(r.status).toBe(200);
    const { consent, groups, notice } = r.json.data;
    expect(consent).toBeNull();
    expect(notice.version).toBe(ACK);
    expect(notice.text).toMatch(/turn this off at any time/);
    expect(groups.map((g) => [g.holder, g.accounts.map((a) => a.id)])).toEqual([
      ["self", ["dhan-main", "zerodha-main"]],
      ["spouse", ["zerodha-spouse"]],
      [null, ["angel-nohold"]],
    ]);
    const dhan = groups[0].accounts[0];
    expect(dhan).toMatchObject({ broker: "dhan", poolingPolicy: "unknown", optedIn: true, consented: false, inPool: false, dataEntitlement: { value: "paid-for-live" } });
    expect(dhan.poolingNote).toMatch(/silent on several accounts/);
    expect(r.json.meta.requestId).toBeTruthy();
    expect(JSON.stringify(r.json)).not.toMatch(/t-123456/);
  });

  it("shows a key limited to some accounts only those accounts", async () => {
    const r = await call("GET", "/v1/pooling", { key: READ_ONE });
    expect(r.json.data.groups).toEqual([{ holder: "self", accounts: [expect.objectContaining({ id: "dhan-main" })] }]);
  });
});

describe("PUT /v1/pooling/consent", () => {
  it("needs an admin key", async () => {
    expect((await put(["dhan-main"], {}, READ)).status).toBe(403);
    expect((await call("PUT", "/v1/pooling/consent", { body: { acknowledge: ACK, accounts: ["dhan-main"] } })).status).toBe(401);
  });

  it("is this computer only", async () => {
    const r = await call("PUT", "/v1/pooling/consent", { key: ADMIN, body: { acknowledge: ACK, accounts: ["dhan-main"] }, remote: true });
    expect(r.status).toBe(403);
    expect(r.json.code ?? r.json.type).toMatch(/LOOPBACK_ONLY/i);
    expect(unpinned()).toEqual(["dhan-main"]);
  });

  it("refuses a missing or wrong acknowledgement and unknown fields", async () => {
    expect((await call("PUT", "/v1/pooling/consent", { key: ADMIN, body: { accounts: ["dhan-main"] } })).status).toBe(400);
    expect((await call("PUT", "/v1/pooling/consent", { key: ADMIN, body: { acknowledge: "pooling-0", accounts: ["dhan-main"] } })).status).toBe(400);
    const extra = await put(["dhan-main"], { sneaky: true });
    expect(extra.status).toBe(400);
    expect(JSON.stringify(extra.json)).toMatch(/sneaky/);
    expect((await call("PUT", "/v1/pooling/consent", { key: ADMIN, body: [] })).status).toBe(400);
  });

  it("refuses accounts of different holders, unknown accounts and paper accounts", async () => {
    const holders = await put(["dhan-main", "zerodha-spouse"]);
    expect(holders.status).toBe(400);
    expect(JSON.stringify(holders.json)).toMatch(/different holders/);
    const unknown = await put(["dhan-main", "ghost-9"]);
    expect(unknown.status).toBe(400);
    expect(JSON.stringify(unknown.json)).toMatch(/ghost-9 is not an account/);
    const paper = await put(["dhan-main", "paper"]);
    expect(paper.status).toBe(400);
    expect(JSON.stringify(paper.json)).toMatch(/paper account/);
    const noHolder = await put(["angel-nohold"]);
    expect(noHolder.status).toBe(400);
    expect(JSON.stringify(noHolder.json)).toMatch(/no holder/);
    expect(unpinned()).toEqual(["dhan-main"]);
    expect((await call("GET", "/v1/pooling", { key: READ })).json.data.consent).toBeNull();
  });

  it("refuses a broker whose policy says not-allowed", async () => {
    const config = app.deps.config;
    const svc = createPoolingService({ config, paths: { dataDir: mkdtempSync(join(tmpdir(), "mcb-poolblock-")) } }, { policies: { dhan: { pooling: "not-allowed" }, zerodha: { pooling: "unknown" } } });
    await expect(svc.acceptConsent({ acknowledge: ACK, accounts: ["dhan-main", "zerodha-main"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("a key that may not use every named account cannot consent for them", async () => {
    const r = await put(["dhan-main", "zerodha-main"], {}, ADMIN_ONE);
    expect(r.status).toBe(403);
    expect(unpinned()).toEqual(["dhan-main"]);
  });

  it("accepts consent: pooling starts on the next read, the answer shows it, and the audit log records ids only", async () => {
    expect(unpinned()).toEqual(["dhan-main"]);
    const r = await put(["dhan-main", "zerodha-main"]);
    expect(r.status).toBe(200);
    expect(r.json.data.consent).toMatchObject({ version: ACK, accounts: ["dhan-main", "zerodha-main"], current: true });
    expect(r.json.data.consent.acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const byId = Object.fromEntries(r.json.data.groups.flatMap((g) => g.accounts.map((a) => [a.id, a])));
    expect(byId["dhan-main"]).toMatchObject({ consented: true, inPool: true });
    expect(byId["zerodha-main"]).toMatchObject({ consented: true, inPool: true });
    expect(byId["zerodha-spouse"]).toMatchObject({ consented: false, inPool: false });
    expect(unpinned()).toEqual(["dhan-main", "zerodha-main"]);
    expect(audit.at(-1)).toMatchObject({ type: "pooling.consent_accepted", actor: { kind: "key", id: "admin000001" }, data: { version: ACK, accounts: ["dhan-main", "zerodha-main"] } });
    // And GET agrees.
    expect((await call("GET", "/v1/pooling", { key: READ })).json.data.consent.accounts).toEqual(["dhan-main", "zerodha-main"]);
  });

  it("consent for some accounts does not pool the others", async () => {
    const r = await put(["dhan-main"]);
    expect(r.status).toBe(200);
    expect(unpinned()).toEqual(["dhan-main"]);
    const flags = Object.fromEntries(mgr.list().map((a) => [a.id, a.pooling]));
    expect(flags["dhan-main"]).toBe(true);
    expect(flags["zerodha-main"]).toBe(false);
  });
});

describe("DELETE /v1/pooling/consent", () => {
  it("needs an admin key and this computer", async () => {
    expect((await call("DELETE", "/v1/pooling/consent", { key: READ })).status).toBe(403);
    expect((await call("DELETE", "/v1/pooling/consent", { key: ADMIN, remote: true })).status).toBe(403);
    expect((await call("GET", "/v1/pooling", { key: READ })).json.data.consent).not.toBeNull();
  });

  it("revokes at once: pooling ends on the very next read, and the change is audited", async () => {
    await put(["dhan-main", "zerodha-main"]);
    expect(unpinned()).toEqual(["dhan-main", "zerodha-main"]);
    const r = await call("DELETE", "/v1/pooling/consent", { key: ADMIN });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ revoked: true, consent: null });
    expect(unpinned()).toEqual(["dhan-main"]);
    expect(Object.values(Object.fromEntries(mgr.list().map((a) => [a.id, a.pooling]))).every((x) => x === false)).toBe(true);
    expect(audit.at(-1)).toMatchObject({ type: "pooling.consent_revoked", data: {} });
  });

  it("is harmless when there is nothing to revoke", async () => {
    const before = audit.length;
    const r = await call("DELETE", "/v1/pooling/consent", { key: ADMIN });
    expect(r.status).toBe(200);
    expect(r.json.data.revoked).toBe(false);
    expect(audit.length).toBe(before);
  });
});
