/**
 * GET /v1/sources/trace end to end through the real request pipeline: the market module's service (which owns the
 * router), a tiny module that registers the trace route the way the sources module does, a fake backup facade and the
 * published fakes. No network.
 */
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { defineModule } from "../core/modules.mjs";
import { instrumentSpecs, stubAdapter, stubStreamHub } from "../market/__fixtures__/helpers.mjs";
import marketModule from "../market/module.mjs";
import { createFakeScheduler } from "../ratelimit/fake.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { registerTraceRoutes } from "./trace.mjs";

const READ = "mcb_read0000001_aaaaaaaaaaaaaaaaaaaa";
const LIMITED = "mcb_limit000001_bbbbbbbbbbbbbbbbbbbb";
const KEYS = {
  [READ]: { id: "read0000001", label: "reader", scopes: ["read"], accounts: "*" },
  [LIMITED]: { id: "limit000001", label: "dhan only", scopes: ["read"], accounts: ["dhan-main"] },
};
const fakeKeyStore = { ...notImplementedService("keyStore"), authenticate: async (raw) => KEYS[raw] ?? null };

/** A facade as the sources service offers it: management rows through list(), calls through quotes() etc. */
const facade = {
  autoFallbackOn: false,
  autoFallback() {
    return this.autoFallbackOn;
  },
  list: () => [
    { id: "web-delayed", name: "Web delayed", kind: "free", tier: "opt-in", enabled: true, configured: true, class: "delayed", delaySec: 900, official: false, capabilities: ["quotes", "history", "expiries", "optionChain"], limits: { perMinute: 30 } },
    { id: "web-eod", name: "Web end of day", kind: "free", tier: "byok", enabled: true, configured: true, needsKey: true, class: "eod", delaySec: null, official: false, capabilities: ["history"], limits: { perDay: 25 } },
    { id: "keyless", name: "Needs a key", kind: "free", tier: "byok", enabled: true, configured: false, needsKey: true, class: "delayed", delaySec: 900, official: false, capabilities: ["quotes"], limits: { perDay: 25 } },
  ],
  quoteCalls: 0,
  async quotes(symbols, opts) {
    this.quoteCalls += 1;
    return { items: symbols.map((symbol) => ({ symbol, fields: { ltp: 42 }, at: Date.now() - 900_000, provider: opts?.sourceId ?? "web-delayed" })), errors: [] };
  },
  history: async () => ({ candles: [] }),
  expiries: async () => ({ expiries: [] }),
  optionChain: async () => ({ rows: [] }),
  status: () => ({ enabled: true }),
};

const traceModule = defineModule({
  name: "tracetest",
  stream: "core",
  register(app, deps) {
    registerTraceRoutes(app, deps);
  },
});

let app;
let port;

function call(path, { key = READ } = {}) {
  const headers = { host: `127.0.0.1:${port}` };
  if (key) headers.authorization = `Bearer ${key}`;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path, headers }, (res) => {
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
    req.end();
  });
}

let scheduler;
let zerodha;
beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-trace-"));
  const { config } = loadConfig({ raw: { server: { port: 0 }, dataDir, market: { batch: { windowMs: 5 } } }, env: {} });
  zerodha = stubAdapter("zerodha");
  scheduler = createFakeScheduler();
  const accounts = createFakeAccountManager({
    accounts: [
      { id: "zerodha-main", broker: "zerodha", adapter: zerodha, creds: { apiKey: "k" } },
      {
        id: "dhan-main",
        broker: "dhan",
        adapter: stubAdapter("dhan", {
          capabilities: { auth: { kind: "apiKeyToken" }, testConnection: true, quotes: true, ltp: true, historical: { intervals: ["1d"] } },
          overrides: {
            async fetchQuotes() {
              throw Object.assign(new Error("dhan is down"), { code: "UPSTREAM_ERROR" });
            },
          },
        }),
        creds: { clientId: "1" },
      },
    ],
  });
  app = await createApp({
    config,
    modules: [marketModule, traceModule],
    overrides: {
      keyStore: fakeKeyStore,
      accounts,
      scheduler,
      symbols: createFakeSymbolService({ instruments: instrumentSpecs() }),
      streamHub: stubStreamHub(),
      backupData: facade,
    },
    logger: createNullLogger(),
    clock: { now: () => Date.now() },
  });
  ({ port } = await app.listen());
});

afterAll(async () => {
  await app?.close?.();
});

describe("GET /v1/sources/trace", () => {
  it("is registered once, with read scope", () => {
    const rows = app.router.list().filter((r) => r.pattern === "/v1/sources/trace");
    expect(rows).toHaveLength(1);
    expect(rows[0].method).toBe("GET");
    expect(rows[0].options.scope).toBe("read");
  });

  it("needs an API key", async () => {
    expect((await call("/v1/sources/trace", { key: null })).status).toBe(401);
  });

  it("answers { data: TraceResult, meta } for the default quote read", async () => {
    const r = await call("/v1/sources/trace?symbols=NSE:RELIANCE");
    expect(r.status).toBe(200);
    expect(r.json.meta.requestId).toEqual(expect.any(String));
    const t = r.json.data;
    expect(t.request).toMatchObject({ capability: "quotes", purpose: "display", symbols: ["NSE:RELIANCE"], allowBackup: false });
    expect(t.class).toBe("realtime");
    expect(t.considered[0]).toMatchObject({ id: "zerodha-main", kind: "broker", verdict: "chosen", health: { state: "ok" } });
    // no pooling here, so one broker account is the only candidate and the others are not considered
    expect(t.considered.filter((c) => c.kind === "broker")).toHaveLength(1);
    const web = t.considered.find((c) => c.id === "web-delayed");
    expect(web.verdict).toBe("skipped");
    expect(web.reason).toMatch(/backup=true|automatic fallback/);
    expect(t.note).toMatch(/real-time/);
  });

  it("makes no upstream call and spends no budget", async () => {
    const before = scheduler.calls.length;
    const brokerCalls = zerodha.calls.length;
    await call("/v1/sources/trace?symbols=NSE:RELIANCE&backup=true");
    expect(scheduler.calls.length).toBe(before);
    expect(zerodha.calls.length).toBe(brokerCalls);
  });

  it("with backup=true the delayed source is the labelled fallback", async () => {
    const r = await call("/v1/sources/trace?symbols=NSE:RELIANCE&backup=true");
    const web = r.json.data.considered.find((c) => c.id === "web-delayed");
    expect(r.json.data.request.allowBackup).toBe(true);
    expect(web.verdict).not.toBe("chosen");
    expect(r.json.data.considered.filter((c) => c.verdict !== "skipped")).toHaveLength(2);
  });

  it("follows the autoFallback setting when backup= is not given", async () => {
    facade.autoFallbackOn = true;
    try {
      const r = await call("/v1/sources/trace?symbols=NSE:RELIANCE");
      expect(r.json.data.request.allowBackup).toBe(true);
    } finally {
      facade.autoFallbackOn = false;
    }
  });

  it("an order read never lists a delayed source as usable, and says why", async () => {
    const r = await call("/v1/sources/trace?symbols=NSE:RELIANCE&purpose=order&backup=true");
    expect(r.status).toBe(200);
    const web = r.json.data.considered.find((c) => c.id === "web-delayed");
    expect(web).toMatchObject({ verdict: "skipped", reason: "skipped: needs real-time, this source is delayed 15 min" });
    expect(r.json.data.considered.filter((c) => c.kind === "source").every((c) => c.verdict === "skipped")).toBe(true);
    expect(r.json.data.class).toBe("realtime");
  });

  it("a source that needs a key it does not have is off", async () => {
    const r = await call("/v1/sources/trace?symbols=NSE:RELIANCE&backup=true");
    expect(r.json.data.considered.find((c) => c.id === "keyless").reason).toMatch(/switched off/);
  });

  it("maxAgeMs rules out delayed sources", async () => {
    const r = await call("/v1/sources/trace?symbols=NSE:RELIANCE&backup=true&maxAgeMs=2000");
    expect(r.json.data.considered.find((c) => c.id === "web-delayed").reason).toMatch(/at most 2 s old/);
  });

  it("history: a source answers first when no broker offers the interval", async () => {
    // dhan-main offers daily candles only
    const r = await call("/v1/sources/trace?capability=history&symbols=NSE:RELIANCE&interval=5m&backup=true", { key: LIMITED });
    expect(r.status).toBe(200);
    expect(r.json.data.request).toMatchObject({ capability: "history", interval: "5m" });
    const rows = Object.fromEntries(r.json.data.considered.map((c) => [c.id, c]));
    expect(rows["web-delayed"].verdict).toBe("chosen");
    expect(rows["dhan-main"].verdict).toBe("skipped");
    expect(rows["dhan-main"].reason).toMatch(/cannot supply 5m candles/);
    expect(r.json.data.class).toBe("delayed");
  });

  it("a key limited to some accounts only ever sees those accounts routed", async () => {
    const r = await call("/v1/sources/trace?symbols=NSE:RELIANCE", { key: LIMITED });
    expect(r.json.data.considered.find((c) => c.verdict === "chosen").id).toBe("dhan-main");
    expect(r.json.data.considered.some((c) => c.id === "zerodha-main")).toBe(false);
  });

  it("a pinned account is not routed", async () => {
    const r = await call("/v1/sources/trace?symbols=NSE:RELIANCE&account=dhan-main&backup=true");
    expect(r.status).toBe(200);
    expect(r.json.data.considered).toHaveLength(1);
    expect(r.json.data.considered[0]).toMatchObject({ id: "dhan-main", verdict: "chosen" });
    expect((await call("/v1/sources/trace?account=zerodha-main", { key: LIMITED })).status).toBe(403);
  });

  it("validates its parameters", async () => {
    for (const q of ["capability=nope", "purpose=nope", "maxAgeMs=abc", "maxAgeMs=3600001", "backup=maybe", "deadlineMs=-1", "capability=history&interval=7m", "symbols=" + Array.from({ length: 201 }, () => "NSE:NIFTY").join(",")]) {
      const r = await call(`/v1/sources/trace?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.json.code).toBe("VALIDATION_FAILED");
    }
  });

  it("a second registration is a no-op, not a crash", () => {
    const facadeApp = { get: () => { throw new Error("must not register twice"); }, routes: () => [{ method: "GET", pattern: "/v1/sources/trace" }] };
    expect(registerTraceRoutes(facadeApp, {})).toBe(false);
  });
});

describe("?purpose= on the market reads (through the real pipeline)", () => {
  const enc = encodeURIComponent;

  it("accepts every purpose and refuses others with a 400", async () => {
    for (const purpose of ["display", "analysis", "alert", "paper", "risk", "order"]) {
      const r = await call(`/v1/ltp?symbols=${enc("NSE:RELIANCE")}&purpose=${purpose}`);
      expect(r.status, purpose).toBe(200);
    }
    const bad = await call(`/v1/ltp?symbols=${enc("NSE:RELIANCE")}&purpose=trading`);
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("VALIDATION_FAILED");
    expect(bad.json.errors[0].path).toBe("purpose");
  });

  it("a display read is answered by the labelled backup when the only broker fails; an order read is not", async () => {
    // LIMITED may use dhan-main only, and dhan's quotes API is down.
    const before = facade.quoteCalls;
    const display = await call(`/v1/ltp?symbols=${enc("NSE:STK01")}&backup=true`, { key: LIMITED });
    expect(display.status).toBe(200);
    expect(display.json.data[0]).toMatchObject({ symbol: "NSE:STK01", ltp: 42 });
    expect(display.json.data[0].freshness).toMatchObject({ source: "backup", class: "delayed", delaySec: 900, official: false });
    expect(facade.quoteCalls).toBe(before + 1);
    for (const purpose of ["order", "risk", "paper", "alert"]) {
      const r = await call(`/v1/ltp?symbols=${enc("NSE:STK02")}&backup=true&purpose=${purpose}`, { key: LIMITED });
      expect(r.status, purpose).toBe(200);
      expect(r.json.data, purpose).toEqual([]);
      expect(r.json.errors[0].code, purpose).toBe("UPSTREAM_ERROR");
    }
    expect(facade.quoteCalls).toBe(before + 1); // no strict read reached the source
  });
});
