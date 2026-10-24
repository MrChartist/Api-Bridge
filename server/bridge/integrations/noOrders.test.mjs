/**
 * Acceptance (docs/STREAMS.md §S10): nothing in this stream can place an order. Proved four ways:
 *  1. every S10 route is a GET with scope "read" (no write method, no paper/live scope);
 *  2. the handlers, driven with every route and hostile inputs, touch only deps.marketData (a recording Proxy
 *     around deps);
 *  3. through the real HTTP pipeline, with recording order/paper/safety services installed, no request reaches them,
 *     and every write method on /xl is refused with 405;
 *  4. the module's source never names an order-capable service or method.
 */
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SERVICE_CONTRACTS, notImplementedService } from "../core/contracts.mjs";
import { createCallContext } from "../core/context.mjs";
import { createNullLogger } from "../core/logger.mjs";
import integrations, { ROUTES, USED_SERVICES } from "./module.mjs";
import { KEYS, NOW_MS, createFakeMarketData, createFakeSymbols } from "./__fixtures__/fakes.mjs";
import { bearer, startTestApp } from "./__fixtures__/testApp.mjs";

const HOSTILE_QUERIES = [
  "",
  "symbol=NSE:NIFTY&resolution=5&from=1792122300&to=1792143000",
  "symbol=NSE:NIFTY&resolution=1D&countback=10&to=1792195200",
  "symbols=NSE:NIFTY,NSE:RELIANCE",
  "query=NIFTY&type=option",
  "symbol=NSE:NIFTY&field=ltp",
  "underlying=NIFTY&expiry=2026-10-27&format=json",
  "symbol=NSE:NIFTY&interval=5m&layout=amibroker&countback=5",
  "symbol=NSE:NIFTY&side=BUY&quantity=75&product=INTRADAY&orderType=MARKET&mode=live",
  "symbol=%3DPLACE_ORDER()&action=place&order=1",
  "account=dhan-main&mode=live&confirmToken=x",
];

/** Recording stand-ins for every order-capable service: each method call is logged and throws. */
function recordingServices(log) {
  const out = {};
  for (const name of ["orders", "paper", "safety", "audit", "accounts", "scheduler"]) {
    const svc = {};
    for (const m of SERVICE_CONTRACTS[name].methods) {
      svc[m] = (...args) => {
        log.push(`${name}.${m}`);
        if (name === "scheduler" && m === "checkClient") return { ok: true, retryAfterMs: 0, headers: {} };
        throw new Error(`${name}.${m} must not be called from S10`);
      };
    }
    out[name] = svc;
  }
  return out;
}

describe("route table", () => {
  it("every S10 route is GET with scope read", () => {
    expect(ROUTES.length).toBe(4);
    for (const [method, path, options] of ROUTES) {
      expect(method, path).toBe("GET");
      expect(options.scope, path).toBe("read");
      expect(options.auth ?? "key", path).toBe("key");
      expect(options.public, path).toBeUndefined();
      expect(path).toMatch(/^\/xl\//);
    }
  });
});

describe("handlers only read market data", () => {
  it("records every deps property the handlers touch", async () => {
    const touched = new Set();
    const calls = [];
    const real = { marketData: createFakeMarketData(), symbols: createFakeSymbols(), clock: { now: () => NOW_MS }, ...recordingServices(calls) };
    for (const name of Object.keys(SERVICE_CONTRACTS)) real[name] ??= notImplementedService(name);
    const deps = new Proxy(real, {
      get(target, prop) {
        if (typeof prop === "string") touched.add(prop);
        return target[prop];
      },
    });
    const handlers = new Map();
    integrations.register({ config: {}, route: (method, path, handler) => handlers.set(`${method} ${path}`, handler) }, deps);
    expect(handlers.size).toBe(ROUTES.length);
    expect(touched.size).toBe(0); // register() itself reads nothing
    const log = createNullLogger();
    for (const [key, handler] of handlers) {
      for (const q of HOSTILE_QUERIES) {
        const ctx = createCallContext({ source: "rest", key: { id: "k", label: "k", scopes: ["read"], accounts: "*" }, log });
        ctx.query = new URLSearchParams(q);
        try {
          await handler(ctx);
        } catch {
          /* table routes may throw validation errors; that is fine */
        }
      }
      expect([...touched].filter((p) => p !== "marketData"), key).toEqual([]);
    }
    expect(calls).toEqual([]);
    // the probe really observed the handlers (not a vacuous pass)
    expect([...touched].sort()).toEqual(["marketData"]);
    expect(USED_SERVICES).toEqual(["marketData"]);
  });
});

describe("through the HTTP pipeline", () => {
  let t;
  const calls = [];
  beforeAll(async () => {
    t = await startTestApp({ overrides: recordingServices(calls) });
  });
  afterAll(async () => {
    await t.close();
  });

  it("no request reaches orders, paper, safety, audit, accounts or the scheduler's order path", async () => {
    for (const [, path] of ROUTES) {
      for (const q of HOSTILE_QUERIES) {
        await t.request(`${path}?${q}`, { headers: bearer(KEYS.READ) });
        await t.request(`${path}?${q}&key=${KEYS.PAPER_Q}`); // a paper key in the URL is refused anyway
      }
    }
    expect(calls.filter((c) => c !== "scheduler.checkClient")).toEqual([]);
  });

  it("write methods are not routed (405 with Allow: GET)", async () => {
    for (const [, path] of ROUTES) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const r = await t.request(path, { method, headers: bearer(KEYS.PAPER_Q), body: { symbol: "NSE:NIFTY", side: "BUY", quantity: 1, mode: "live" } });
        expect(r.status, `${method} ${path}`).toBe(405);
        expect(r.headers.allow).toBe("GET");
      }
    }
    expect(calls.filter((c) => c !== "scheduler.checkClient")).toEqual([]);
  });
});

describe("source", () => {
  it("never names an order-capable service or method", () => {
    const dir = new URL("./", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));
    expect(files.sort()).toEqual(["config.mjs", "ist.mjs", "module.mjs", "params.mjs", "xl.mjs"]);
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""); // code only
      expect(src, f).not.toMatch(/deps\.(orders|paper|safety|audit|accounts|scheduler|keyStore|secrets)\b/);
      expect(src, f).not.toMatch(/\b(placeOrder|cancelAll|issueOrderGate|modifyOrder|cancelOrder)\b/);
      expect(src, f).not.toMatch(/\.(place|modify|cancel)\(/);
      expect(src, f).not.toMatch(/brokers\//);
    }
  });
});
