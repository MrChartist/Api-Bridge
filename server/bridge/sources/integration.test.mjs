/**
 * The whole data-source path through the real app in demo mode (no network): the router's choice reaches the sources
 * service, enabled sources answer only when a read allows backup (or sources.autoFallback) and the purpose permits,
 * the outcome of real calls shows in GET /v1/sources, a failing source is ejected by the breaker and recovers when the
 * clock passes the cooldown, a plugin's own health() shows up, and no secret appears in any answer.
 *
 * The clock is the real one plus an offset the tests move forward, so the scheduler and timers behave as usual.
 * Fake sources are registered on the app's registry next to the demo ones.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createLogger, createNullLogger } from "../core/logger.mjs";

const SECRET = "sk-integration-0123456789";
const SYMBOLS = ["NSE:NIFTY", "NSE:RELIANCE", "NSE:INFY", "NSE:TCS", "NSE:SBIN", "NSE:ITC", "NSE:LT", "NSE:WIPRO"];
const START = Date.now();
const NOW = Date.parse("2026-10-19T10:00:00+05:30");

const descriptor = (id, over = {}) => ({
  id,
  name: `Fake ${id}`,
  kind: "free",
  tier: "plugin",
  class: "delayed",
  delaySec: 900,
  official: false,
  capabilities: ["quotes"],
  limits: { perMinute: 600 },
  terms: { url: "https://example.com/terms", note: "A test source." },
  ...over,
});

/** A source whose answers and failures the test controls. */
function fakeSource(id, over = {}) {
  const calls = [];
  const state = { fail: false, price: 100 };
  const provider = {
    descriptor: descriptor(id, over),
    state,
    calls,
    async quotes(symbols, ctx) {
      calls.push([...symbols]);
      if (state.fail) throw Object.assign(new Error(`${id} is down`), { code: "UPSTREAM_ERROR" });
      return { items: symbols.map((symbol) => ({ symbol, fields: { ltp: state.price }, at: ctx.now })) };
    },
  };
  return provider;
}

const apps = [];
afterEach(async () => {
  while (apps.length) await apps.pop().close();
});

async function boot({ sourcesConfig = {} } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-sources-int-"));
  const { config } = loadConfig({ raw: { server: { port: 0 }, dataDir, logging: { level: "silent" }, sources: sourcesConfig }, env: {}, demo: true });
  const offset = { ms: 0 };
  const clock = { now: () => NOW + offset.ms + (Date.now() - START) };
  const app = await createApp({ config, logger: createNullLogger(), clock });
  apps.push(app);
  const { port } = await app.listen();
  const admin = (await app.deps.keyStore.create({ label: "admin", scopes: ["admin"], accounts: "*", expiresAt: null, allowQuery: false, clientKind: "other" })).key;
  // A key that may use only an account that does not exist: its reads can only be answered by a data source.
  const noBroker = (await app.deps.keyStore.create({ label: "no broker", scopes: ["read"], accounts: ["no-such-account"], expiresAt: null, allowQuery: false, clientKind: "other" })).key;
  const bodies = [];
  const http = async (path, { method = "GET", key = admin, body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const sources = async () => Object.fromEntries((await http("/v1/sources")).json.data.map((s) => [s.id, s]));
  /** Move the clock forward (the router's view of the registry is cached for a second). */
  const advance = (ms) => {
    offset.ms += ms;
  };
  const registry = app.deps.backupData.registry;
  return { app, http, noBroker, admin, sources, advance, now: clock.now, registry, bodies, health: app.deps.marketData.sourceHealth };
}

const quotes = (env, symbols, { key, query = "" } = {}) => env.http(`/v1/quotes?symbols=${symbols.join(",")}${query}`, { key: key ?? env.noBroker });

describe("sources are used only when the read allows them and the purpose permits", () => {
  it("answers nothing from an enabled source unless the read opts in, and never for a trusted-data purpose", async () => {
    const env = await boot();
    const fake = fakeSource("fake-a");
    env.registry.register(fake);
    expect((await env.http("/v1/sources/fake-a", { method: "PATCH", body: { enabled: true } })).status).toBe(200);
    env.advance(2000);

    const plain = await quotes(env, ["NSE:NIFTY"]);
    expect(plain.json.data).toEqual([]);
    expect(plain.json.errors).toHaveLength(1);
    expect(fake.calls).toEqual([]);

    const optedIn = await quotes(env, ["NSE:NIFTY"], { query: "&backup=true" });
    expect(optedIn.json.errors).toEqual([]);
    expect(optedIn.json.data[0].freshness).toMatchObject({ source: "backup", provider: "fake-a", class: "delayed", delaySec: 900, official: false });
    expect(fake.calls).toEqual([["NSE:NIFTY"]]);

    // A delayed source never answers an order, risk, paper or alert read, even when the read opts in.
    for (const purpose of ["order", "risk", "paper", "alert"]) {
      const r = await quotes(env, ["NSE:RELIANCE"], { query: `&backup=true&purpose=${purpose}` });
      expect(r.json.data).toEqual([]);
    }
    expect(fake.calls).toEqual([["NSE:NIFTY"]]);

    // A pinned read never moves to a source.
    const pinned = await env.http("/v1/quotes?symbols=NSE:INFY&backup=true&account=demo-main", { key: env.admin });
    for (const it of pinned.json.data ?? []) expect(it.freshness.source).not.toBe("backup");
    expect(fake.calls).toEqual([["NSE:NIFTY"]]);
  });

  it("falls back without being asked when sources.autoFallback is on, and ?backup=false opts one read out", async () => {
    const env = await boot({ sourcesConfig: { autoFallback: true } });
    const fake = fakeSource("fake-a");
    env.registry.register(fake);
    await env.http("/v1/sources/fake-a", { method: "PATCH", body: { enabled: true } });
    env.advance(2000);
    const auto = await quotes(env, ["NSE:NIFTY"]);
    expect(auto.json.data[0].freshness.provider).toBe("fake-a");
    const off = await quotes(env, ["NSE:RELIANCE"], { query: "&backup=false" });
    expect(off.json.data).toEqual([]);
    expect(fake.calls).toEqual([["NSE:NIFTY"]]);
  });

  it("does not use a source the owner has not switched on", async () => {
    const env = await boot();
    const fake = fakeSource("fake-a");
    env.registry.register(fake);
    const r = await quotes(env, ["NSE:NIFTY"], { query: "&backup=true" });
    expect(r.json.data).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});

describe("the router's choice reaches the sources service", () => {
  it("asks the source the router chose, not the first one in registration order", async () => {
    const env = await boot();
    const first = fakeSource("fake-a");
    const second = fakeSource("fake-b");
    env.registry.register(first);
    env.registry.register(second);
    for (const id of ["fake-a", "fake-b"]) await env.http(`/v1/sources/${id}`, { method: "PATCH", body: { enabled: true } });
    env.advance(2000);
    // The first source has been failing a little (not enough to be ejected): the router prefers the second.
    env.health.record("fake-a", { ok: false, ms: 5, kind: "hard" });
    env.health.record("fake-a", { ok: false, ms: 5, kind: "hard" });
    const r = await quotes(env, ["NSE:NIFTY"], { query: "&backup=true" });
    expect(r.json.data[0].freshness.provider).toBe("fake-b");
    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual([["NSE:NIFTY"]]);
  });

  it("the facade itself honours opts.sourceId, and refuses a source that is not eligible", async () => {
    const env = await boot();
    const first = fakeSource("fake-a");
    const second = fakeSource("fake-b");
    env.registry.register(first);
    env.registry.register(second);
    const svc = env.app.deps.backupData;
    await svc.setEnabled("fake-a", true);
    await svc.setEnabled("fake-b", true);
    const viaB = await svc.quotes(["NSE:NIFTY"], { sourceId: "fake-b" });
    expect(viaB.items.map((i) => i.provider)).toEqual(["fake-b"]);
    expect(first.calls).toEqual([]);
    // fake-b is a delayed source: pinned to it for an order read, nothing answers
    const refused = await svc.quotes(["NSE:RELIANCE"], { sourceId: "fake-b", purpose: "order" });
    expect(refused.items).toEqual([]);
    expect(second.calls).toEqual([["NSE:NIFTY"]]);
  });
});

describe("health of real calls", () => {
  it("shows in GET /v1/sources: usage, median latency, and a failing source is ejected, then recovers", async () => {
    const env = await boot();
    const flaky = fakeSource("fake-a");
    env.registry.register(flaky);
    await env.http("/v1/sources/fake-a", { method: "PATCH", body: { enabled: true } });
    env.advance(2000);

    // A good call first: usage and a latency appear.
    await quotes(env, [SYMBOLS[0]], { query: "&backup=true" });
    let row = (await env.sources())["fake-a"];
    expect(row.usage.lastMinute).toBe(1);
    expect(row.health).toMatchObject({ state: "ok", lastError: null, nextTryAt: null });
    expect(typeof row.health.p50Ms).toBe("number");

    // Three failures in a row eject it. Each read asks for another symbol and the clock moves past the short memory of a failure.
    flaky.state.fail = true;
    for (const symbol of SYMBOLS.slice(1, 4)) {
      const r = await quotes(env, [symbol], { query: "&backup=true" });
      expect(r.json.data).toEqual([]);
      env.advance(3000);
    }
    expect(flaky.calls).toHaveLength(4);
    row = (await env.sources())["fake-a"];
    expect(row.health.state).toBe("open");
    expect(row.health.lastError).toMatch(/down/);
    expect(Date.parse(row.health.nextTryAt)).toBeGreaterThan(env.now());

    // While ejected it is not asked, except for one last-resort probe when nothing else could answer, at most every few seconds.
    await quotes(env, [SYMBOLS[4]], { query: "&backup=true" });
    expect(flaky.calls).toHaveLength(5);
    const during = await quotes(env, [SYMBOLS[5]], { query: "&backup=true" });
    expect(during.json.data).toEqual([]);
    expect(flaky.calls).toHaveLength(5);

    // After the cooldown a probe goes through; the source answers again and the breaker closes.
    flaky.state.fail = false;
    env.advance(6 * 60_000);
    const after = await quotes(env, [SYMBOLS[6]], { query: "&backup=true" });
    expect(after.json.errors).toEqual([]);
    expect(after.json.data[0].freshness.provider).toBe("fake-a");
    row = (await env.sources())["fake-a"];
    expect(row.health.state).not.toBe("open");
    expect(row.health.nextTryAt).toBeNull();
  });

  it("does not count one call twice (the market service records it, the facade does not)", async () => {
    const env = await boot();
    const src = fakeSource("fake-a");
    env.registry.register(src);
    await env.http("/v1/sources/fake-a", { method: "PATCH", body: { enabled: true } });
    env.advance(2000);
    await quotes(env, [SYMBOLS[0]], { query: "&backup=true" });
    expect(env.health.samples("fake-a")).toBe(1);
  });

  it("shows a plugin's own health() in GET /v1/sources", async () => {
    const env = await boot();
    const plugin = fakeSource("fake-plugin");
    plugin.health = () => ({ state: "disabled", errorRate: null, p50Ms: null, lastError: "stopped after 4 crashes in 10 minutes", nextTryAt: null });
    env.registry.register(plugin);
    await env.http("/v1/sources/fake-plugin", { method: "PATCH", body: { enabled: true } });
    const row = (await env.sources())["fake-plugin"];
    expect(row.enabled).toBe(true);
    expect(row.health).toMatchObject({ state: "disabled", lastError: "stopped after 4 crashes in 10 minutes" });

    plugin.health = () => ({ state: "degraded", errorRate: null, p50Ms: null, lastError: null, nextTryAt: null });
    expect((await env.sources())["fake-plugin"].health.state).toBe("degraded");
    plugin.health = () => ({ state: "ok", errorRate: null, p50Ms: null, lastError: null, nextTryAt: null });
    expect((await env.sources())["fake-plugin"].health.state).toBe("ok");
  });
});

describe("secrets", () => {
  it("never appear in an answer, the sources list, the config or a log line", async () => {
    const lines = [];
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-sources-int-"));
    const { config } = loadConfig({ raw: { server: { port: 0 }, dataDir, logging: { level: "debug" } }, env: {}, demo: true });
    const app = await createApp({ config, logger: createLogger({ level: "debug", write: (l) => lines.push(l) }) });
    apps.push(app);
    const { port } = await app.listen();
    const admin = (await app.deps.keyStore.create({ label: "admin", scopes: ["admin"], accounts: "*", expiresAt: null, allowQuery: false, clientKind: "other" })).key;
    const bodies = [];
    const http = async (path, { method = "GET", body } = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${admin}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      bodies.push(text);
      return { status: res.status, json: text ? JSON.parse(text) : null };
    };
    expect((await http("/v1/sources/demo-eod/config", { method: "PUT", body: { apiKey: SECRET } })).status).toBe(200);
    expect((await http("/v1/sources/demo-eod", { method: "PATCH", body: { enabled: true } })).status).toBe(200);
    await http("/v1/sources");
    await http("/v1/sources/demo-eod/test", { method: "POST" });
    await http("/v1/quotes?symbols=NSE:NIFTY&backup=true");
    await http("/v1/health");
    await http("/v1/meta");
    expect(bodies.join("\n")).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain(SECRET);
  });
});
