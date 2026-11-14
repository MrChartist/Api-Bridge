/**
 * The test that checks the test setup: no test may reach a real vendor host through the global `fetch`
 * (test/noRealNetwork.mjs), the built-in network providers are not registered in demo mode, and the route that tests a
 * source (`POST /v1/sources/<id>/test`) uses the injected fetch. A security review once made a REAL request to a vendor
 * host by calling that route with a canary key from a test; a provider turns a failed request into a plain error, so
 * nothing in the test noticed. The guard records every such request and fails the test that made it.
 */
import http from "node:http";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { networkViolations } from "../../../test/noRealNetwork.mjs";
import authModule from "../auth/module.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { createLogger } from "../core/logger.mjs";
import { createBuiltinProviders } from "./providers/index.mjs";
import sourcesModule from "./module.mjs";
import { createSourceRegistry } from "./registry.mjs";
import { createSourcesService, secretNameFor } from "./service.mjs";

const CANARY = "CANARY-KEY-DO-NOT-SEND-0123456789";
const fakeAudit = { ...notImplementedService("audit"), append: async (i) => ({ ...i, seq: 1 }) };

/** Take the violations a test provoked on purpose out of the list, so the setup's afterEach does not fail the test. */
const takeViolations = () => networkViolations.splice(0);

const send = (port, path, { method = "GET", headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const extra = payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) };
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
        resolve({ status: res.statusCode, raw, json });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });

describe("the socket guard (code that does not use fetch)", () => {
  it("refuses a connection from node's own http client to a real host, records it, and lets loopback through", async () => {
    const err = await new Promise((resolve) => http.get({ host: "api.example.invalid", port: 80, path: "/" }, () => resolve(null)).on("error", resolve));
    expect(err).toMatchObject({ code: "ECONNREFUSED" });
    expect(err.message).toMatch(/real network/);
    const raw = await new Promise((resolve) => {
      const socket = net.connect(80, "203.0.113.9");
      socket.on("error", resolve);
    });
    expect(raw.message).toMatch(/real network/);
    expect(takeViolations()).toEqual(["api.example.invalid", "203.0.113.9"]);
    const server = http.createServer((_q, res) => res.end("ok"));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const body = await new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port: server.address().port }, (res) => { let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => resolve(t)); }).on("error", reject));
    server.close();
    expect(body).toBe("ok");
    expect(networkViolations).toEqual([]);
  });
});

describe("the socket guard and a pinned address", () => {
  const pinnedTo = (address) => (_host, options, cb) => (options?.all ? cb(null, [{ address, family: 4 }]) : cb(null, address, 4));

  it("judges a caller that pins the address with its own lookup by that address, not by the name", async () => {
    const server = http.createServer((_q, res) => res.end("pinned"));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const body = await new Promise((resolve, reject) => http.get({ host: "receiver.example.test", port: server.address().port, lookup: pinnedTo("127.0.0.1") }, (res) => { let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => resolve(t)); }).on("error", reject));
    server.close();
    expect(body).toBe("pinned");
    expect(networkViolations).toEqual([]);
    const err = await new Promise((resolve) => http.get({ host: "receiver.example.test", port: 80, lookup: pinnedTo("203.0.113.7") }, () => resolve(null)).on("error", resolve));
    expect(err.message).toMatch(/receiver\.example\.test resolved to 203\.0\.113\.7/);
    expect(takeViolations()).toEqual(["receiver.example.test (resolved to 203.0.113.7)"]);
  });
});

describe("the global fetch guard", () => {
  it("refuses a request to a real host, records it, and the error says what to do", async () => {
    await expect(fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI")).rejects.toThrow(/real network.*Inject a fake fetch/);
    await expect(fetch(new URL("https://www.alphavantage.co/query?apikey=x"))).rejects.toThrow(/real network/);
    await expect(fetch(new Request("https://api.twelvedata.com/quote"))).rejects.toThrow(/real network/);
    await expect(fetch("not a url")).rejects.toThrow(/real network/);
    expect(takeViolations()).toEqual(["query1.finance.yahoo.com", "www.alphavantage.co", "api.twelvedata.com", "an address that does not parse"]);
  });

  it("lets requests to this computer through (loopback servers that tests start) and data URLs", async () => {
    const server = http.createServer((_req, res) => res.end("local"));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address();
      expect(await (await fetch(`http://127.0.0.1:${port}/x`)).text()).toBe("local");
      expect(await (await fetch(`http://localhost:${port}/x`)).text()).toBe("local");
      expect(await (await fetch("data:text/plain,hello")).text()).toBe("hello");
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(takeViolations()).toEqual([]);
  });

  it("does not let a look-alike host through", async () => {
    await expect(fetch("https://127.0.0.1.evil.example/x")).rejects.toThrow(/real network/);
    await expect(fetch("https://localhost.evil.example/x")).rejects.toThrow(/real network/);
    expect(takeViolations()).toHaveLength(2);
  });

  it("records a request that the code under test swallowed: a built-in provider with no injected fetch 'could not be reached', and the guard still knows", async () => {
    const registry = createSourceRegistry();
    for (const p of createBuiltinProviders({ getSecret: async () => CANARY })) registry.register(p); // the slip: no fetch injected
    const svc = createSourcesService({ registry, config: { sources: {} }, clock: { now: () => Date.now() }, paths: { dataDir: mkdtempSync(join(tmpdir(), "mcb-nonet-")) }, secrets: { get: async (n) => (n === secretNameFor("twelvedata") ? { apiKey: CANARY } : null), set: async () => {}, delete: async () => true } });
    await svc.refresh();
    const r = await svc.test("yahoo");
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/could not be reached/); // the provider's own message hides what happened ...
    expect(takeViolations()).toEqual(["query1.finance.yahoo.com"]); // ... the guard does not
  });

  it("an injected fake fetch is used by the test route and the guard sees nothing", async () => {
    const calls = [];
    const fake = async (url, init) => {
      calls.push({ url: String(url), headers: init?.headers });
      return new Response(JSON.stringify({ code: 401, status: "error", message: "bad key" }), { status: 401, headers: { "content-type": "application/json" } });
    };
    const registry = createSourceRegistry();
    for (const p of createBuiltinProviders({ fetch: fake, getSecret: async () => CANARY })) registry.register(p);
    const stored = new Map([[secretNameFor("twelvedata"), { apiKey: CANARY }]]);
    const svc = createSourcesService({ registry, config: { sources: {} }, clock: { now: () => Date.now() }, paths: { dataDir: mkdtempSync(join(tmpdir(), "mcb-nonet-")) }, secrets: { get: async (n) => stored.get(n) ?? null, set: async (n, v) => void stored.set(n, v), delete: async (n) => stored.delete(n) } });
    await svc.refresh();
    const r = await svc.test("twelvedata");
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/^https:\/\/api\.twelvedata\.com\//);
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(takeViolations()).toEqual([]);
  });
});

describe("demo mode registers no network source", () => {
  let env;
  afterAll(async () => {
    await env?.app.close();
  });

  it("has only the demo sources, and the test route for a vendor source is 404 without any request leaving", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-nonet-demo-"));
    const { config } = loadConfig({ raw: { server: { port: 0 }, dataDir }, env: {}, demo: true });
    const app = await createApp({ config, modules: [authModule, sourcesModule], overrides: { audit: fakeAudit }, logger: createLogger({ level: "silent" }) });
    env = { app };
    const { port } = await app.listen();
    const { key: admin } = await app.deps.keyStore.create({ label: "cli admin", scopes: ["admin"] });
    const as = { authorization: `Bearer ${admin}` };
    const ids = (await send(port, "/v1/sources", { headers: as })).json.data.map((s) => s.id);
    expect(ids).toEqual(["demo", "demo-delayed", "demo-eod"]);
    for (const id of ["yahoo", "alphavantage", "twelvedata"]) {
      expect(app.deps.backupData.registry.get(id) ?? null).toBeNull();
      const t = await send(port, `/v1/sources/${id}/test`, { method: "POST", headers: as });
      expect(t.status, id).toBe(404);
      const k = await send(port, `/v1/sources/${id}/config`, { method: "PUT", headers: as, body: { apiKey: CANARY } });
      expect(k.status, id).toBe(404);
    }
    // Even the demo sources never use fetch.
    for (const id of ids) await send(port, `/v1/sources/${id}/test`, { method: "POST", headers: as });
    expect(takeViolations()).toEqual([]);
  });

  it("registers no plugin in demo mode even when the config grants one", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-nonet-demo2-"));
    const { config } = loadConfig({ raw: { server: { port: 0 }, dataDir, sources: { plugins: [{ path: "examples/source-plugin", sha256: "a".repeat(64), granted: true }] } }, env: {}, demo: true });
    const app = await createApp({ config, modules: [authModule, sourcesModule], overrides: { audit: fakeAudit }, logger: createLogger({ level: "silent" }) });
    try {
      expect(app.deps.backupData.list().map((s) => s.id)).toEqual(["demo", "demo-delayed", "demo-eod"]);
    } finally {
      await app.close();
    }
  });
});
