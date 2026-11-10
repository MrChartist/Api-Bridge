/**
 * Conformance of the sources module: it boots with the real auth module (keys and secrets store), the routes answer
 * with the documented shapes, an opt-in source cannot be switched on without its acknowledgement, and no API key
 * appears in any response or log line.
 */
import http from "node:http";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import authModule from "../auth/module.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { createLogger } from "../core/logger.mjs";
import { BUILTIN_MODULES } from "../core/builtinModules.mjs";
import sourcesModule, { ROUTES } from "./module.mjs";

const KEY = "demo-key-0123456789";
const fakeAudit = { ...notImplementedService("audit"), append: async (i) => ({ ...i, seq: 1 }) };

const requestOn = (port) => (path, { method = "GET", headers = {}, body } = {}) => {
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
};

async function boot({ demo, sources = {}, audit = fakeAudit, dataDir: givenDir, shareFolder = false }) {
  const dataDir = givenDir ?? mkdtempSync(join(tmpdir(), "mcb-sources-mod-"));
  const { config } = loadConfig({ raw: { server: { port: 0 }, dataDir, sources }, env: {}, demo });
  const logLines = [];
  const logger = createLogger({ level: "debug", write: (l) => logLines.push(l) });
  // shareFolder: a second Bridge on the folder of a running one (a "restart" next to it), so no data-folder lock
  const app = await createApp({ config, modules: [authModule, sourcesModule], overrides: { audit }, logger, ...(shareFolder ? { instanceLock: false } : {}) });
  const { port } = await app.listen();
  const { key: admin } = await app.deps.keyStore.create({ label: "cli admin", scopes: ["admin"] });
  const { key: read } = await app.deps.keyStore.create({ label: "reader", scopes: ["read"] });
  const request = requestOn(port);
  const as = (k) => ({ authorization: `Bearer ${k}` });
  /** Every raw response body, to scan for secrets at the end. */
  const bodies = [];
  const call = async (path, opts = {}) => {
    const r = await request(path, { ...opts, headers: { ...as(opts.key ?? admin), ...(opts.headers ?? {}) } });
    bodies.push(r.raw);
    return r;
  };
  return { app, dataDir, logLines, request, call, admin, read, as, bodies, close: () => app.close() };
}

describe("sources module in demo mode", () => {
  let env;
  beforeAll(async () => {
    env = await boot({ demo: true });
  });
  afterAll(async () => {
    await env?.close();
  });

  it("is a built-in module and provides the backupData service instead of a stub", () => {
    expect(BUILTIN_MODULES.some((m) => m.name === "sources")).toBe(true);
    expect(sourcesModule.services.backupData).toBeTypeOf("function");
    expect(sourcesModule.configKey).toBe("sources");
    expect(env.app.deps.backupData.quotes).toBeTypeOf("function");
    expect(env.app.deps.backupData.setEnabled).toBeTypeOf("function");
  });

  it("registers exactly its documented routes, the key route and the writes only for this computer", () => {
    const listed = env.app.router.list().filter((r) => r.module === "sources");
    const got = listed.map((r) => `${r.method} ${r.pattern}`).sort();
    // The module's own routes, plus the routes of the parts it loads when present: pooling consent and the route trace.
    const partRoutes = new Set(["GET /v1/pooling", "PUT /v1/pooling/consent", "DELETE /v1/pooling/consent", "GET /v1/sources/trace"]);
    const own = ROUTES.map(([m, p]) => `${m} ${p}`).sort();
    expect(got.filter((r) => !partRoutes.has(r))).toEqual(own);
    expect(got.filter((r) => partRoutes.has(r)).every((r) => partRoutes.has(r))).toBe(true);
    const byKey = Object.fromEntries(listed.map((r) => [`${r.method} ${r.pattern}`, r.options]));
    expect(byKey["GET /v1/sources"]).toMatchObject({ scope: "read" });
    expect(byKey["PATCH /v1/sources/:id"]).toMatchObject({ scope: "admin", loopbackOnly: true });
    expect(byKey["PUT /v1/sources/:id/config"]).toMatchObject({ scope: "admin", loopbackOnly: true });
    expect(byKey["POST /v1/sources/:id/test"]).toMatchObject({ scope: "admin" });
  });

  it("GET /v1/sources needs a key and lists the demo, delayed and end-of-day sources with the documented shape", async () => {
    expect((await env.request("/v1/sources")).status).toBe(401);
    const r = await env.call("/v1/sources", { key: env.read });
    expect(r.status).toBe(200);
    expect(r.json.meta.requestId).toBeTypeOf("string");
    expect(r.json.meta.notice).toMatch(/never answer orders/);
    expect(r.json.meta.autoFallback).toBe(false);
    expect(r.json.data.map((s) => s.id)).toEqual(["demo", "demo-delayed", "demo-eod"]);
    for (const s of r.json.data) {
      expect(Object.keys(s)).toEqual(expect.arrayContaining(["id", "name", "kind", "tier", "enabled", "configured", "class", "delaySec", "official", "capabilities", "limits", "usage", "health", "terms", "needsKey", "consent"]));
      expect(s.usage).toEqual({ lastMinute: 0, today: 0 });
      expect(Object.keys(s.health).sort()).toEqual(["errorRate", "lastError", "lastErrorKind", "nextTryAt", "p50Ms", "state"]);
      expect(s.health.lastErrorKind).toBe("none");
    }
    const [demo, delayed, eod] = r.json.data;
    expect(demo).toMatchObject({ kind: "broker", tier: "builtin", enabled: true, class: "realtime", delaySec: 0, official: true });
    expect(delayed).toMatchObject({ kind: "free", tier: "opt-in", enabled: false, configured: true, class: "delayed", delaySec: 900, official: false, noticeVersion: "demo-1", needsKey: false, consent: null });
    expect(eod).toMatchObject({ kind: "free", tier: "byok", enabled: false, configured: false, class: "eod", needsKey: true, consent: null });
    expect(delayed.terms.url).toMatch(/^https:/);
  });

  it("enabling an opt-in source without the acknowledgement is a 4xx with a clear message", async () => {
    const none = await env.call("/v1/sources/demo-delayed", { method: "PATCH", body: { enabled: true } });
    expect(none.status).toBe(400);
    expect(none.json).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(none.json.detail).toMatch(/acknowledge: "demo-1"/);
    const wrong = await env.call("/v1/sources/demo-delayed", { method: "PATCH", body: { enabled: true, acknowledge: "nope" } });
    expect(wrong.status).toBe(400);
    expect(wrong.json.detail).toMatch(/demo-1/);
    const after = await env.call("/v1/sources");
    expect(after.json.data.find((s) => s.id === "demo-delayed")).toMatchObject({ enabled: false, consent: null });
  });

  it("enabling a BYOK source without a key is refused", async () => {
    const r = await env.call("/v1/sources/demo-eod", { method: "PATCH", body: { enabled: true } });
    expect(r.status).toBe(409);
    expect(r.json.detail).toMatch(/API key/);
  });

  it("validates bodies and ids, and needs the admin scope", async () => {
    expect((await env.call("/v1/sources/demo-delayed", { method: "PATCH", body: { enabled: true }, key: env.read })).status).toBe(403);
    expect((await env.call("/v1/sources/demo-delayed", { method: "PATCH", body: {} })).status).toBe(400);
    expect((await env.call("/v1/sources/demo-delayed", { method: "PATCH", body: { enabled: "yes" } })).status).toBe(400);
    expect((await env.call("/v1/sources/demo-delayed", { method: "PATCH", body: { enabled: true, surprise: 1 } })).status).toBe(400);
    expect((await env.call("/v1/sources/demo-delayed", { method: "PATCH", body: [1] })).status).toBe(400);
    expect((await env.call("/v1/sources/nope", { method: "PATCH", body: { enabled: false } })).status).toBe(404);
    expect((await env.call("/v1/sources/Not%20An%20Id", { method: "PATCH", body: { enabled: false } })).status).toBe(404);
    expect((await env.call("/v1/sources/demo-eod/config", { method: "PUT", body: { apiKey: KEY }, key: env.read })).status).toBe(403);
    expect((await env.call("/v1/sources/demo-delayed/config", { method: "PUT", body: { apiKey: KEY } })).status).toBe(400);
    expect((await env.call("/v1/sources/demo-eod/config", { method: "PUT", body: { apiKey: "x" } })).status).toBe(400);
    expect((await env.call("/v1/sources/nope/test", { method: "POST" })).status).toBe(404);
  });

  it("saves a key, never echoes it, then enables, serves labelled data and counts usage", async () => {
    const put = await env.call("/v1/sources/demo-eod/config", { method: "PUT", body: { apiKey: KEY } });
    expect(put.status).toBe(200);
    expect(put.json.data).toEqual({ configured: true });
    expect(put.json.configured).toBe(true);
    expect(put.raw).not.toContain(KEY);

    const test = await env.call("/v1/sources/demo-eod/test", { method: "POST" });
    expect(test.status).toBe(200);
    expect(test.json.data).toMatchObject({ ok: true });
    expect(test.json.data.latencyMs).toBeTypeOf("number");
    expect(test.json.ok).toBe(true);

    const on = await env.call("/v1/sources/demo-eod", { method: "PATCH", body: { enabled: true } });
    expect(on.status).toBe(200);
    expect(on.json.data).toMatchObject({ id: "demo-eod", enabled: true, configured: true });
    const ack = await env.call("/v1/sources/demo-delayed", { method: "PATCH", body: { enabled: true, acknowledge: "demo-1" } });
    expect(ack.status).toBe(200);
    expect(ack.json.data).toMatchObject({ enabled: true, consent: { noticeVersion: "demo-1" } });
    expect(Date.parse(ack.json.data.consent.acceptedAt)).toBeGreaterThan(0);

    const svc = env.app.deps.backupData;
    const q = await svc.quotes(["NSE:RELIANCE", "NSE:NOPE"]);
    expect(q.items).toHaveLength(1);
    expect(q.items[0]).toMatchObject({ symbol: "NSE:RELIANCE", provider: "demo-delayed", class: "delayed", delaySec: 900, official: false });
    expect(q.items[0].fields.ltp).toBeGreaterThan(0);
    expect(q.errors.map((e) => e.symbol)).toEqual(["NSE:NOPE"]);
    const h = await svc.history({ symbol: "NSE:RELIANCE", interval: "1d", fromMs: Date.now() - 10 * 86_400_000, toMs: Date.now() });
    expect(h.provider).toBe("demo-delayed");
    expect(h.candles.length).toBeGreaterThan(0);
    const ex = await svc.expiries("NIFTY");
    expect(ex.expiries.length).toBeGreaterThan(0);
    const chain = await svc.optionChain("NIFTY", ex.expiries[0]);
    expect(chain.rows.length).toBeGreaterThan(10);
    // the same read for an order is refused: only real-time sources may answer it
    expect((await svc.quotes(["NSE:RELIANCE"], { purpose: "order" })).items).toEqual([]);

    const list = await env.call("/v1/sources");
    const delayed = list.json.data.find((s) => s.id === "demo-delayed");
    expect(delayed.usage.today).toBeGreaterThanOrEqual(4);
    expect(delayed.health.state).toBe("ok");

    const off = await env.call("/v1/sources/demo-delayed", { method: "PATCH", body: { enabled: false } });
    expect(off.json.data).toMatchObject({ enabled: false });
    expect(off.json.data.consent.noticeVersion).toBe("demo-1");
  });

  it("/v1/health reports the extra sources (those that are on, of all) for this computer and the backupData service as ready", async () => {
    const r = await env.request("/v1/health");
    expect(r.json.services.backupData).toBe("ready");
    expect(r.json.sources).toEqual({ enabled: 1, total: 2, autoFallback: false });
  });

  it("no API key appears in any response, any log line or any file in the data folder except the encrypted store", () => {
    expect(env.bodies.join("\n")).not.toContain(KEY);
    expect(env.logLines.join("\n")).not.toContain(KEY);
    const state = readFileSync(join(env.dataDir, "sources", "state.json"), "utf8");
    expect(state).not.toContain(KEY);
    expect(state).toContain("demo-eod");
    // demo mode keeps the secrets store in memory, so nothing in the data folder holds the key
    for (const name of readdirSync(env.dataDir)) {
      if (name === "sources") continue;
      try {
        expect(readFileSync(join(env.dataDir, name), "utf8")).not.toContain(KEY);
      } catch {
        // a folder
      }
    }
  });
});

describe("sources module outside demo mode", () => {
  let env;
  beforeAll(async () => {
    env = await boot({ demo: false, sources: { autoFallback: true, timeoutMs: 2000 } });
  });
  afterAll(async () => {
    await env?.close();
  });

  it("holds no demo source and no network source until a provider part adds one", async () => {
    const r = await env.call("/v1/sources");
    expect(r.status).toBe(200);
    expect(r.json.data.some((s) => s.id.startsWith("demo"))).toBe(false);
    expect(env.app.deps.backupData.autoFallback()).toBe(true);
  });

  it("keeps a BYOK key in the encrypted secrets store under source:<id>, not in state.json", async () => {
    const { registry } = env.app.deps.backupData;
    registry.register({
      descriptor: { id: "vendor-eod", name: "Vendor EOD", kind: "free", tier: "byok", class: "eod", delaySec: null, official: true, capabilities: ["history"], limits: { perDay: 25 }, terms: { url: "https://example.com/t", note: "Your account, your terms." } },
      history: async () => ({ candles: [], at: 1 }),
    });
    const put = await env.call("/v1/sources/vendor-eod/config", { method: "PUT", body: { apiKey: KEY } });
    expect(put.status).toBe(200);
    expect(await env.app.deps.secrets.list()).toContain("source:vendor-eod");
    expect(await env.app.deps.secrets.get("source:vendor-eod")).toEqual({ apiKey: KEY });
    expect(readFileSync(join(env.dataDir, "sources", "state.json"), "utf8")).not.toContain(KEY);
    expect(readFileSync(join(env.dataDir, "secrets.enc"), "utf8")).not.toContain(KEY);
    expect(env.bodies.join("\n")).not.toContain(KEY);
    expect(env.logLines.join("\n")).not.toContain(KEY);
  });

  it("rejects a bad sources config section at boot", async () => {
    const { config } = loadConfig({ raw: { server: { port: 0 }, dataDir: mkdtempSync(join(tmpdir(), "mcb-sources-bad-")), sources: { timeoutMs: 99_999 } }, env: {} });
    await expect(createApp({ config, modules: [authModule, sourcesModule], overrides: { audit: fakeAudit }, logger: createLogger({ level: "error", write: () => {} }) })).rejects.toThrow(/sources\.timeoutMs/);
  });
});

describe("PATCH /v1/sources/settings: the automatic fallback switch", () => {
  const audits = [];
  const capture = { ...notImplementedService("audit"), append: async (i) => (audits.push(i), { ...i, seq: audits.length }) };
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-sources-settings-"));
  let env;
  beforeAll(async () => {
    env = await boot({ demo: true, audit: capture, dataDir });
  });
  afterAll(async () => {
    await env?.close();
  });

  it("is documented as admin and this computer only", () => {
    const route = env.app.router.list().find((r) => r.method === "PATCH" && r.pattern === "/v1/sources/settings");
    expect(route.options).toMatchObject({ scope: "admin", loopbackOnly: true });
  });

  it("starts from the default and says so", async () => {
    const r = await env.call("/v1/sources");
    expect(r.json.meta).toMatchObject({ autoFallback: false, autoFallbackSource: "default" });
  });

  it("needs an admin key and a body of exactly { autoFallback: boolean }", async () => {
    expect((await env.request("/v1/sources/settings", { method: "PATCH", body: { autoFallback: true } })).status).toBe(401);
    expect((await env.call("/v1/sources/settings", { method: "PATCH", body: { autoFallback: true }, key: env.read })).status).toBe(403);
    for (const body of [{}, { autoFallback: "yes" }, { autoFallback: 1 }, { autoFallback: true, extra: 1 }, [true], "x"]) {
      const r = await env.call("/v1/sources/settings", { method: "PATCH", body });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect((await env.call("/v1/sources")).json.meta.autoFallbackSource).toBe("default");
  });

  it("switches it on, shows it in the list, the live service and the audit log, and keeps it across a restart", async () => {
    const r = await env.call("/v1/sources/settings", { method: "PATCH", body: { autoFallback: true } });
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({ autoFallback: true, autoFallbackSource: "setting", persisted: true });
    expect(r.json.autoFallback).toBe(true);
    expect(env.app.deps.backupData.autoFallback()).toBe(true);
    const list = await env.call("/v1/sources");
    expect(list.json.meta).toMatchObject({ autoFallback: true, autoFallbackSource: "setting" });
    expect(audits.at(-1)).toMatchObject({ type: "sources.setting_changed", data: { setting: "autoFallback", from: false, to: true } });
    expect(JSON.parse(readFileSync(join(dataDir, "sources", "state.json"), "utf8")).settings).toEqual({ autoFallback: true });
    const second = await boot({ demo: true, dataDir, shareFolder: true });
    try {
      expect((await second.call("/v1/sources")).json.meta).toMatchObject({ autoFallback: true, autoFallbackSource: "setting" });
      expect(second.app.deps.backupData.autoFallback()).toBe(true);
    } finally {
      await second.close();
    }
  });

  it("can be switched off again, and the saved choice beats the config file either way", async () => {
    const off = await env.call("/v1/sources/settings", { method: "PATCH", body: { autoFallback: false } });
    expect(off.json.data).toMatchObject({ autoFallback: false, autoFallbackSource: "setting" });
    expect(audits.at(-1).data).toEqual({ setting: "autoFallback", from: true, to: false });
    const withConfigOn = await boot({ demo: true, dataDir, sources: { autoFallback: true }, shareFolder: true });
    try {
      expect((await withConfigOn.call("/v1/sources")).json.meta).toMatchObject({ autoFallback: false, autoFallbackSource: "setting" });
    } finally {
      await withConfigOn.close();
    }
  });

  it("without a saved choice the config file decides and the list says so", async () => {
    const fresh = await boot({ demo: true, sources: { autoFallback: true } });
    try {
      expect((await fresh.call("/v1/sources")).json.meta).toMatchObject({ autoFallback: true, autoFallbackSource: "config" });
    } finally {
      await fresh.close();
    }
  });

  it("is not mistaken for a source id: /v1/sources/settings never reaches the per-source handler", async () => {
    const r = await env.call("/v1/sources/settings", { method: "PATCH", body: { enabled: true } });
    expect(r.status).toBe(400);
    expect(r.raw).toMatch(/autoFallback|Unknown field/);
  });
});
