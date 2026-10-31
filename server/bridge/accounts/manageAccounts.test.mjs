/**
 * Adding and removing accounts from the dashboard (POST /v1/accounts, DELETE /v1/accounts/{id}) through the real
 * request pipeline: validation and id rules, the change saved to bridge.config.json (other content kept, re-loadable),
 * the new account usable by the next request without a restart, paper-only defaults, demo refusal, and the access
 * rules (admin scope, an admin key for every account, this computer only).
 */
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notImplementedService } from "../core/contracts.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import accountsModule, { ROUTES } from "./module.mjs";
import { defaultLabel, loginUrlTemplate, suggestAccountId } from "./routes.mjs";
import { apiKeyAdapter, createCapturingLogger, createMemorySecretStore, createStubRegistry, oauthAdapter, sessionAdapter } from "./__fixtures__/stubs.mjs";

const KEYS = {
  mcb_read0000001_aaaaaaaaaaaaaaaaaaaa: { id: "read0000001", label: "reader", scopes: ["read"], accounts: "*" },
  mcb_admin000001_dddddddddddddddddddd: { id: "admin000001", label: "admin", scopes: ["admin"], accounts: "*" },
  mcb_adminpaper1_eeeeeeeeeeeeeeeeeeee: { id: "adminpaper1", label: "admin-paper-only", scopes: ["admin"], accounts: ["paper"] },
};
const READ = "mcb_read0000001_aaaaaaaaaaaaaaaaaaaa";
const ADMIN = "mcb_admin000001_dddddddddddddddddddd";
const LIMITED_ADMIN = "mcb_adminpaper1_eeeeeeeeeeeeeeeeeeee";
const ACCESS = "eyJhbGciOiJIUzI1NiJ9.manage-token.sig999";

const fakeKeyStore = { ...notImplementedService("keyStore"), authenticate: async (raw) => KEYS[raw] ?? null };

function caller(port) {
  return (method, path, { key, body, remote = false } = {}) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    // remote: as if the request came through a tunnel or proxy (forwarding header), i.e. not from this computer.
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

const adapters = () => ({
  dhan: apiKeyAdapter({ id: "dhan" }),
  zerodha: { ...oauthAdapter({ id: "zerodha" }), capabilities: { ...oauthAdapter().capabilities, auth: { kind: "oauthRedirect", loginUrl: "https://kite.example/connect/login?v=3&api_key={apiKey}" } } },
  angelone: sessionAdapter(),
});

async function boot({ config, configFile, store = createMemorySecretStore(), audit = [] }) {
  const fakeAudit = { ...notImplementedService("audit"), append: async (input) => (audit.push(structuredClone(input)), { ...input, seq: audit.length }) };
  const app = await createApp({
    config,
    configFile,
    modules: [accountsModule],
    overrides: { keyStore: fakeKeyStore, secrets: store, audit: fakeAudit },
    logger: createCapturingLogger().logger,
    brokers: createStubRegistry(adapters()),
  });
  const { port } = await app.listen();
  return { app, call: caller(port), store, audit };
}

describe("pure helpers", () => {
  it("suggests <broker>-main, then <broker>-2 ...; paper, then paper-2", () => {
    expect(suggestAccountId("dhan", new Set())).toBe("dhan-main");
    expect(suggestAccountId("dhan", new Set(["dhan-main"]))).toBe("dhan-2");
    expect(suggestAccountId("dhan", new Set(["dhan-main", "dhan-2"]))).toBe("dhan-3");
    expect(suggestAccountId("paper", new Set())).toBe("paper");
    expect(suggestAccountId("paper", new Set(["paper"]))).toBe("paper-2");
  });

  it("labels new accounts plainly", () => {
    expect(defaultLabel("zerodha", "zerodha-main")).toBe("Zerodha (Kite) (main)");
    expect(defaultLabel("zerodha", "zerodha-2")).toBe("Zerodha (Kite) (2)");
    expect(defaultLabel("dhan", "dhan-spouse")).toBe("Dhan (dhan-spouse)");
    expect(defaultLabel("paper", "paper")).toBe("Paper account");
    expect(defaultLabel("paper", "paper-2")).toBe("Paper account 2");
  });

  it("offers a broker login page only when https and fillable from typed fields", () => {
    const a = (loginUrl, credentialFields = ["apiKey"]) => ({ credentialFields, capabilities: { auth: { loginUrl } } });
    expect(loginUrlTemplate(a("https://kite.example/login?api_key={apiKey}"))).toBe("https://kite.example/login?api_key={apiKey}");
    expect(loginUrlTemplate(a("https://x.example/login?client_id={apiKey}&redirect_uri={redirectUri}"))).toBeNull();
    expect(loginUrlTemplate(a("http://x.example/login?k={apiKey}"))).toBeNull();
    expect(loginUrlTemplate(a(undefined))).toBeNull();
  });

  it("route table: both routes are admin and this computer only", () => {
    const opts = Object.fromEntries(ROUTES.map(([m, p, o]) => [`${m} ${p}`, o]));
    expect(opts["POST /v1/accounts"]).toMatchObject({ scope: "admin", loopbackOnly: true });
    expect(opts["DELETE /v1/accounts/:accountId"]).toMatchObject({ scope: "admin", loopbackOnly: true, body: "none" });
  });
});

describe("with a config file", () => {
  let dir;
  let file;
  let b;
  const original = () => ({
    server: { port: 0 },
    logging: { level: "silent" },
    accounts: [
      { id: "paper", broker: "paper", label: "Practice" },
      { id: "zerodha-live", broker: "zerodha", live: { enabled: true, allowedSources: ["rest"] } },
    ],
    safety: { dailyMaxOrders: 42 },
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "mcb-manage-"));
    file = join(dir, "bridge.config.json");
    writeFileSync(file, `${JSON.stringify({ ...original(), dataDir: "./data" }, null, 2)}\n`);
    const { config, source } = loadConfig({ path: file, env: {} });
    b = await boot({ config, configFile: source });
  });
  afterAll(async () => {
    await b?.app.close();
  });

  it("adds a broker account, saves it paper-only and keeps the rest of the file", async () => {
    const r = await b.call("POST", "/v1/accounts", { key: ADMIN, body: { broker: "dhan" } });
    expect(r.status).toBe(201);
    expect(r.json.data).toMatchObject({ restartNeeded: false, configFile: file, account: { id: "dhan-main", broker: "dhan", label: "Dhan (main)", liveAllowedByConfig: false, session: { state: "missing" } } });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.safety).toEqual({ dailyMaxOrders: 42 });
    expect(saved.logging).toEqual({ level: "silent" });
    expect(saved.dataDir).toBe("./data");
    expect(saved.accounts.map((a) => a.id)).toEqual(["paper", "zerodha-live", "dhan-main"]);
    expect(saved.accounts[2]).toEqual({ id: "dhan-main", broker: "dhan", label: "Dhan (main)", holder: "self", live: { enabled: false, allowedSources: ["rest"] }, marketData: { pooling: false } });
    expect(b.audit.at(-1)).toMatchObject({ type: "account.added", accountId: "dhan-main", actor: { kind: "key", id: "admin000001" }, data: { broker: "dhan", restartNeeded: false, configFileCreated: false } });
  });

  it("the new account is usable at once: listed, logged in, tested, and seen by services reading config.accounts", async () => {
    const list = await b.call("GET", "/v1/accounts", { key: READ });
    expect(list.json.data.map((a) => a.id)).toContain("dhan-main");
    const s = await b.call("POST", "/v1/accounts/dhan-main/session", { key: ADMIN, body: { values: { clientId: "1100", accessToken: ACCESS } } });
    expect(s.status).toBe(200);
    expect(s.json.data.state).toBe("connected");
    expect((await b.call("POST", "/v1/accounts/dhan-main/test", { key: READ })).json.data.ok).toBe(true);
    expect(b.app.deps.config.accounts.map((a) => a.id)).toContain("dhan-main");
    expect(Object.isFrozen(b.app.deps.config.accounts.find((a) => a.id === "dhan-main"))).toBe(true);
  });

  it("generates the next id, takes a custom id and label, and refuses a used or malformed id", async () => {
    const second = await b.call("POST", "/v1/accounts", { key: ADMIN, body: { broker: "dhan" } });
    expect(second.json.data.account).toMatchObject({ id: "dhan-2", label: "Dhan (2)" });
    const custom = await b.call("POST", "/v1/accounts", { key: ADMIN, body: { broker: "ZERODHA", id: "kite-family", label: "  Kite   for family " } });
    expect(custom.status).toBe(201);
    expect(custom.json.data.account).toMatchObject({ id: "kite-family", broker: "zerodha", label: "Kite for family" });
    const dup = await b.call("POST", "/v1/accounts", { key: ADMIN, body: { broker: "dhan", id: "kite-family" } });
    expect(dup.status).toBe(400);
    expect(dup.json.errors[0]).toEqual({ path: "id", message: "already used" });
    for (const id of ["A", "x", "-dash", "has space", "a".repeat(33), 7]) {
      const bad = await b.call("POST", "/v1/accounts", { key: ADMIN, body: { broker: "dhan", id } });
      expect(bad.status).toBe(400);
      expect(bad.json.errors[0].path).toBe("id");
    }
  });

  it("validates the broker, the label and refuses any other setting (live trading stays a file decision)", async () => {
    for (const broker of ["nosuch", "demo", "", 5, undefined]) {
      const r = await b.call("POST", "/v1/accounts", { key: ADMIN, body: { broker } });
      expect(r.status).toBe(400);
      expect(r.json.code).toBe("VALIDATION_FAILED");
    }
    expect((await b.call("POST", "/v1/accounts", { key: ADMIN, body: { broker: "dhan", label: "x".repeat(61) } })).json.errors[0].path).toBe("label");
    const live = await b.call("POST", "/v1/accounts", { key: ADMIN, body: { broker: "dhan", live: { enabled: true } } });
    expect(live.status).toBe(400);
    expect(live.json.errors[0].path).toBe("live");
    expect((await b.call("POST", "/v1/accounts", { key: ADMIN, body: ["dhan"] })).status).toBe(400);
  });

  it("the saved file loads again with the new accounts, all paper only", () => {
    const { config } = loadConfig({ path: file, env: {}, knownBrokers: ["dhan", "zerodha", "angelone"] });
    const ids = config.accounts.map((a) => a.id);
    expect(ids).toEqual(["paper", "zerodha-live", "dhan-main", "dhan-2", "kite-family"]);
    for (const a of config.accounts.filter((x) => x.id !== "zerodha-live")) expect(a.live.enabled).toBe(false);
  });

  it("refuses a read key, an admin key limited to some accounts, and other computers", async () => {
    expect((await b.call("POST", "/v1/accounts", { key: READ, body: { broker: "dhan" } })).json.code).toBe("SCOPE_REQUIRED");
    const limited = await b.call("POST", "/v1/accounts", { key: LIMITED_ADMIN, body: { broker: "dhan" } });
    expect(limited.status).toBe(403);
    expect(limited.json.code).toBe("ACCOUNT_FORBIDDEN");
    expect((await b.call("POST", "/v1/accounts", { body: { broker: "dhan" } })).status).toBe(401);
    const remote = await b.call("POST", "/v1/accounts", { key: ADMIN, body: { broker: "dhan" }, remote: true });
    expect(remote.status).toBe(403);
    expect(remote.json.code).toBe("LOOPBACK_ONLY");
    expect((await b.call("DELETE", "/v1/accounts/paper", { key: LIMITED_ADMIN })).json.code).toBe("ACCOUNT_FORBIDDEN");
    expect((await b.call("DELETE", "/v1/accounts/dhan-2", { key: ADMIN, remote: true })).json.code).toBe("LOOPBACK_ONLY");
    expect((await b.call("DELETE", "/v1/accounts/dhan-2", { key: READ })).json.code).toBe("SCOPE_REQUIRED");
    expect(JSON.parse(readFileSync(file, "utf8")).accounts).toHaveLength(5);
  });

  it("an account id added to the file by hand since start is not reused", async () => {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.accounts.push({ id: "dhan-3", broker: "dhan" });
    writeFileSync(file, JSON.stringify(saved, null, 2));
    const r = await b.call("POST", "/v1/accounts", { key: ADMIN, body: { broker: "dhan" } });
    expect(r.json.data.account.id).toBe("dhan-4");
    const dup = await b.call("POST", "/v1/accounts", { key: ADMIN, body: { broker: "dhan", id: "dhan-3" } });
    expect(dup.status).toBe(400);
  });

  it("removes an account: gone from the list, the file and SecretStore; audited", async () => {
    expect(b.store.data.has("account:dhan-main")).toBe(true);
    const r = await b.call("DELETE", "/v1/accounts/dhan-main", { key: ADMIN });
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({ id: "dhan-main", removed: true, savedKeysDeleted: true, restartNeeded: false });
    expect(b.store.data.has("account:dhan-main")).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).accounts.map((a) => a.id)).not.toContain("dhan-main");
    expect((await b.call("GET", "/v1/accounts", { key: READ })).json.data.map((a) => a.id)).not.toContain("dhan-main");
    expect(b.app.deps.config.accounts.map((a) => a.id)).not.toContain("dhan-main");
    expect((await b.call("POST", "/v1/accounts/dhan-main/test", { key: READ })).json.code).toBe("ACCOUNT_NOT_FOUND");
    expect((await b.call("DELETE", "/v1/accounts/dhan-main", { key: ADMIN })).json.code).toBe("ACCOUNT_NOT_FOUND");
    expect(b.audit.at(-1)).toMatchObject({ type: "account.removed", accountId: "dhan-main", data: { broker: "dhan", removedFromConfigFile: true, savedKeysDeleted: true } });
    // The id is free again.
    expect((await b.call("POST", "/v1/accounts", { key: ADMIN, body: { broker: "dhan" } })).json.data.account.id).toBe("dhan-main");
  });

  it("refuses to remove a live-enabled account or the only paper account", async () => {
    const live = await b.call("DELETE", "/v1/accounts/zerodha-live", { key: ADMIN });
    expect(live.status).toBe(400);
    expect(live.json.detail).toMatch(/Live trading is set up/);
    const paper = await b.call("DELETE", "/v1/accounts/paper", { key: ADMIN });
    expect(paper.status).toBe(400);
    expect(paper.json.detail).toMatch(/only paper account/);
    // With a second paper account, either may go.
    expect((await b.call("POST", "/v1/accounts", { key: ADMIN, body: { broker: "paper" } })).json.data.account).toMatchObject({ id: "paper-2", label: "Paper account 2", capabilities: expect.arrayContaining(["placeOrder"]) });
    expect((await b.call("DELETE", "/v1/accounts/paper-2", { key: ADMIN })).json.data).toMatchObject({ removed: true, savedKeysDeleted: false });
  });

  it("GET /v1/brokers carries a fillable login page address where the adapter declares one", async () => {
    const r = await b.call("GET", "/v1/brokers", { key: READ });
    expect(r.json.data.find((x) => x.id === "zerodha").loginUrl).toBe("https://kite.example/connect/login?v=3&api_key={apiKey}");
    expect(r.json.data.find((x) => x.id === "dhan").loginUrl).toBeUndefined();
  });
});

describe("without a config file", () => {
  it("creates one at the given per-user location holding just the new account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-manage-nofile-"));
    const file = join(dir, "home", "bridge.config.json");
    const { config } = loadConfig({ raw: { server: { port: 0 }, dataDir: join(dir, "data") }, env: {} });
    const b = await boot({ config, configFile: file });
    try {
      const r = await b.call("POST", "/v1/accounts", { key: ADMIN, body: { broker: "angelone" } });
      expect(r.status).toBe(201);
      expect(r.json.data.account.id).toBe("angelone-main");
      expect(existsSync(file)).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ accounts: [expect.objectContaining({ id: "angelone-main", broker: "angelone", live: { enabled: false, allowedSources: ["rest"] } })] });
      expect(b.audit.at(-1).data.configFileCreated).toBe(true);
      const { config: again } = loadConfig({ path: file, env: {} });
      expect(again.accounts.map((a) => a.id)).toEqual(["angelone-main"]);
    } finally {
      await b.app.close();
    }
  });

  it("refuses when the Bridge has no config file location at all", async () => {
    const { config } = loadConfig({ raw: { server: { port: 0 }, dataDir: mkdtempSync(join(tmpdir(), "mcb-manage-none-")) }, env: {} });
    const b = await boot({ config, configFile: null });
    try {
      const r = await b.call("POST", "/v1/accounts", { key: ADMIN, body: { broker: "dhan" } });
      expect(r.status).toBe(400);
      expect(r.json.detail).toMatch(/without a config file location/);
    } finally {
      await b.app.close();
    }
  });

  it("never overwrites a config file it cannot read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-manage-broken-"));
    const file = join(dir, "bridge.config.json");
    const { config } = loadConfig({ raw: { server: { port: 0 }, dataDir: join(dir, "data") }, env: {} });
    const b = await boot({ config, configFile: file });
    try {
      writeFileSync(file, "{ not json");
      const r = await b.call("POST", "/v1/accounts", { key: ADMIN, body: { broker: "dhan" } });
      expect(r.status).toBe(400);
      expect(r.json.detail).toMatch(/could not be read/);
      expect(readFileSync(file, "utf8")).toBe("{ not json");
      expect((await b.call("GET", "/v1/accounts", { key: READ })).json.data).toEqual([]);
    } finally {
      await b.app.close();
    }
  });
});

describe("demo mode", () => {
  const demoBoot = async ({ raw = {}, fileContent } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-manage-demo-"));
    const { config } = loadConfig({ raw: { server: { port: 0 }, dataDir: dir, ...raw }, env: {}, demo: true });
    const file = join(dir, "bridge.config.json");
    if (fileContent) writeFileSync(file, `${JSON.stringify(fileContent, null, 2)}\n`);
    return { file, b: await boot({ config, configFile: file }) };
  };

  it("refuses to remove accounts, and never loads an added one into the running demo", async () => {
    const { file, b } = await demoBoot();
    try {
      const ids = (await b.call("GET", "/v1/accounts", { key: READ })).json.data.map((a) => a.id);
      expect((await b.call("DELETE", `/v1/accounts/${ids[0]}`, { key: ADMIN })).json.detail).toMatch(/Demo mode/);
      const r = await b.call("POST", "/v1/accounts", { key: ADMIN, body: { broker: "dhan" } });
      expect(r.status).toBe(201);
      expect(r.json.data).toMatchObject({ account: null, savedId: "dhan-main", restartNeeded: true, savedForLater: true });
      // The running demo still has only its sample accounts.
      expect((await b.call("GET", "/v1/accounts", { key: READ })).json.data.map((a) => a.id)).toEqual(ids);
      // Saved paper-only, exactly as a normal start would add it.
      const saved = JSON.parse(readFileSync(file, "utf8")).accounts;
      expect(saved).toEqual([{ id: "dhan-main", broker: "dhan", label: expect.any(String), holder: "self", live: { enabled: false, allowedSources: ["rest"] }, marketData: { pooling: false } }]);
    } finally {
      await b.app.close();
    }
  });

  it("turns demo off in the file only when asked, and refuses paper, unknown brokers and extra fields", async () => {
    const { file, b } = await demoBoot({ fileContent: { demo: true, accounts: [] } });
    try {
      for (const body of [{ broker: "paper" }, { broker: "nosuch" }, { broker: "demo" }, { broker: "dhan", live: { enabled: true } }, { broker: "dhan", leaveDemo: "yes" }]) {
        expect((await b.call("POST", "/v1/accounts", { key: ADMIN, body })).status).toBe(400);
      }
      const keep = await b.call("POST", "/v1/accounts", { key: ADMIN, body: { broker: "dhan" } });
      expect(keep.json.data).toMatchObject({ demoWasInFile: true, demoTurnedOff: false });
      expect(JSON.parse(readFileSync(file, "utf8")).demo).toBe(true);
      const leave = await b.call("POST", "/v1/accounts", { key: ADMIN, body: { broker: "zerodha", leaveDemo: true } });
      expect(leave.json.data).toMatchObject({ savedId: "zerodha-main", demoWasInFile: true, demoTurnedOff: true });
      const obj = JSON.parse(readFileSync(file, "utf8"));
      expect(obj.demo).toBeUndefined();
      expect(obj.accounts.map((a) => a.id)).toEqual(["dhan-main", "zerodha-main"]);
      expect(obj.accounts.every((a) => a.live.enabled === false)).toBe(true);
      // Only from this computer.
      expect((await b.call("POST", "/v1/accounts", { key: ADMIN, body: { broker: "dhan" }, remote: true })).status).toBe(403);
    } finally {
      await b.app.close();
    }
  });

  it("refuses to save anything when the demo dashboard is served to other computers", async () => {
    const { file, b } = await demoBoot({ raw: { server: { port: 0, remoteDashboard: true } } });
    try {
      const r = await b.call("POST", "/v1/accounts", { key: ADMIN, body: { broker: "dhan" } });
      expect(r.status).toBe(400);
      expect(r.json.detail).toMatch(/Demo mode uses its own sample accounts/);
      expect(existsSync(file)).toBe(false);
    } finally {
      await b.app.close();
    }
  });

  it("lists every real broker with the fields its login will ask for", async () => {
    const { b } = await demoBoot();
    try {
      const list = (await b.call("GET", "/v1/brokers", { key: READ })).json.data;
      // The test registry holds three stubs; the other real brokers come from the catalogue, marked unavailable.
      const listed = list.filter((x) => x.available === false);
      expect(listed.length).toBeGreaterThan(30);
      for (const x of listed) expect(Array.isArray(x.credentialFields)).toBe(true);
      expect(listed.some((x) => x.credentialFields.length > 0)).toBe(true);
    } finally {
      await b.app.close();
    }
  });
});
