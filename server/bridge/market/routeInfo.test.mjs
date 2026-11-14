/**
 * The route record of the request log: how freshness labels are summed up (the least current verdict, the most
 * informative source), that it is built without extra calls, and that it reaches GET /v1/requests through the real app.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { runAsConsumer } from "../ratelimit/consumer.mjs";
import { markShared, noteRoute, summariseRoute } from "./routeInfo.mjs";

const label = (over = {}) => ({ source: "broker", stale: false, broker: "dhan", accountId: "main", class: "realtime", delaySec: 0, ...over });

describe("summariseRoute", () => {
  it("names the broker that answered a live read", () => {
    expect(summariseRoute([label(), label()])).toEqual({ from: "live", source: "dhan", sourceName: "Dhan", class: "realtime", delaySec: 0 });
  });

  it("says stream for a live subscription and cache for a cached value", () => {
    expect(summariseRoute([label({ source: "stream" })])).toMatchObject({ from: "stream", source: "dhan" });
    expect(summariseRoute([label({ source: "cache" })])).toMatchObject({ from: "cache" });
    expect(summariseRoute([label({ source: "stream" }), label({ source: "cache" })])).toMatchObject({ from: "cache" });
  });

  it("says stale when any cached value was older than its target, even beside fresh ones, but not for a value just fetched", () => {
    expect(summariseRoute([label({ source: "cache", stale: true }), label()])).toMatchObject({ from: "stale" });
    expect(summariseRoute([label({ stale: true })])).toMatchObject({ from: "live" });
  });

  it("says shared when every live item joined a call another caller had started, live when one did not", () => {
    expect(summariseRoute([label(), label()], { shared: 2 })).toMatchObject({ from: "shared" });
    expect(summariseRoute([label(), label()], { shared: 1 })).toMatchObject({ from: "live" });
  });

  it("takes the least current class and the largest delay, and prefers a data source over a broker as the named source", () => {
    const yahoo = label({ source: "backup", broker: null, provider: "yahoo", class: "delayed", delaySec: 900 });
    const r = summariseRoute([label(), label(), yahoo], { nameOf: (id) => (id === "yahoo" ? "Yahoo Finance" : undefined) });
    expect(r).toEqual({ from: "live", source: "yahoo", sourceName: "Yahoo Finance", class: "delayed", delaySec: 900 });
    expect(summariseRoute([yahoo, label({ source: "backup", broker: null, provider: "eodsrc", class: "eod", delaySec: null })])).toMatchObject({ class: "eod", delaySec: 900 });
  });

  it("names the source that answered most items when several brokers did", () => {
    const r = summariseRoute([label({ broker: "zerodha" }), label({ broker: "dhan" }), label({ broker: "dhan" })]);
    expect(r).toMatchObject({ source: "dhan", sourceName: "Dhan" });
  });

  it("is null when nothing answered, and holds no per-symbol detail", () => {
    expect(summariseRoute([])).toBeNull();
    expect(summariseRoute(undefined)).toBeNull();
    expect(Object.keys(summariseRoute([label()])).sort()).toEqual(["class", "delaySec", "from", "source", "sourceName"]);
  });
});

describe("noteRoute and markShared", () => {
  it("put the record on the request context, counting joins made inside the request's run", () => {
    const ctx = {};
    runAsConsumer("Key: x", () => markShared(), ctx);
    markShared(); // outside any run: ignored
    expect(ctx.routeShared).toBe(1);
    noteRoute(ctx, [label()]);
    expect(ctx.route).toMatchObject({ from: "shared" });
    const empty = {};
    noteRoute(empty, []);
    expect(empty.route).toBeUndefined();
    expect(() => noteRoute(null, [label()])).not.toThrow();
  });
});

describe("GET /v1/requests", () => {
  const apps = [];
  afterEach(async () => {
    while (apps.length) await apps.pop().close();
  });

  async function boot(sources = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-route-"));
    const { config } = loadConfig({ raw: { server: { port: 0 }, dataDir, logging: { level: "silent" }, sources }, env: {}, demo: true });
    const app = await createApp({ config, logger: createNullLogger() });
    apps.push(app);
    const { port } = await app.listen();
    const make = async (label, accounts) => (await app.deps.keyStore.create({ label, scopes: ["admin"], accounts, expiresAt: null, allowQuery: false, clientKind: "other" })).key;
    const admin = await make("admin", "*");
    const http = async (path, { key = admin } = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${key}` } });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    };
    const latest = async (path) => (await http("/v1/requests?limit=50")).json.data.find((e) => e.path === path);
    return { app, http, latest, make };
  }

  it("carries what answered a market read: live first, cache next, and nothing for other routes", async () => {
    const env = await boot();
    expect((await env.http("/v1/quotes?symbols=NSE:NIFTY,NSE:RELIANCE&maxAgeMs=0")).status).toBe(200);
    expect((await env.latest("/v1/quotes")).route).toMatchObject({ from: "live", source: "demo", class: "realtime", delaySec: 0 });
    expect(typeof (await env.latest("/v1/quotes")).route.sourceName).toBe("string");
    expect((await env.http("/v1/quotes?symbols=NSE:NIFTY,NSE:RELIANCE")).status).toBe(200);
    expect((await env.latest("/v1/quotes")).route.from).toBe("cache");
    await env.http("/v1/health");
    expect((await env.latest("/v1/health")).route).toBeUndefined();
  });

  it("says which data source answered, with its class and delay, and the name it shows", async () => {
    const env = await boot({ autoFallback: true });
    await env.app.deps.backupData.setEnabled("demo-delayed", true, { acknowledge: "demo-1" });
    // A key limited to an account that does not exist has no broker: only the delayed source can answer.
    const limited = await env.make("limited", ["no-such-account"]);
    const r = await env.http("/v1/ltp?symbols=NSE:NIFTY", { key: limited });
    expect(r.json.data[0].freshness).toMatchObject({ source: "backup", provider: "demo-delayed" });
    expect((await env.latest("/v1/ltp")).route).toEqual({ from: "live", source: "demo-delayed", sourceName: "Demo delayed data (sample)", class: "delayed", delaySec: 900 });
  });

  it("marks a read that joined another caller's in-flight call as shared", async () => {
    const env = await boot();
    const other = await env.make("other", "*");
    // Whether two requests overlap depends on timing, so try the pair again (up to 12 times) until one of them joined the
    // other's call. When they do overlap, exactly one is live and the other is shared; when they do not, both are live.
    let froms = [];
    for (let i = 0; i < 12 && !froms.includes("shared"); i++) {
      const [a, b] = await Promise.all([env.http("/v1/ltp?symbols=NSE:INFY&maxAgeMs=0"), env.http("/v1/ltp?symbols=NSE:INFY&maxAgeMs=0", { key: other })]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const entries = (await env.http("/v1/requests?limit=50")).json.data.filter((e) => e.path === "/v1/ltp");
      froms = entries.map((e) => e.route.from);
    }
    expect(froms.every((f) => f === "live" || f === "shared")).toBe(true);
    expect(froms).toContain("shared");
    expect(froms.filter((f) => f === "live").length).toBeGreaterThanOrEqual(froms.filter((f) => f === "shared").length);
  });
});
