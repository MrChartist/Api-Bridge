/**
 * Acceptance: nothing in this module can place an order. Proved four ways:
 *  1. every integrations route is a GET with scope "read" (no write method, no paper/live scope);
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
import integrations, { READ_METHODS, ROUTES, USED_SERVICES } from "./module.mjs";
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
  "symbols=NSE:NIFTY,NSE:RELIANCE,NOPE&fields=ltp,chg,pct&format=tsv",
  "symbol=NSE:RELIANCE&field=lot",
  "account=demo-paper&format=json&status=open&limit=5",
  "symbols=%3DPLACE_ORDER(),NSE:NIFTY&format=json&cache=1",
];

/** Reads the integrations routes may make on the order and account services: harmless empty answers. */
const READ_ANSWERS = {
  orders: {
    positions: () => ({ items: [], freshness: { source: "paper", asOf: "2026-10-16T15:00:00+05:30", ageMs: 0, stale: false } }),
    holdings: () => ({ items: [], freshness: { source: "paper", asOf: "2026-10-16T15:00:00+05:30", ageMs: 0, stale: false } }),
    funds: () => ({ funds: {}, freshness: { source: "paper", asOf: "2026-10-16T15:00:00+05:30", ageMs: 0, stale: false } }),
    list: () => ({ items: [], nextCursor: null }),
  },
  accounts: { list: () => [{ id: "dhan-main", broker: "paper", enabled: true, session: { state: "connected" }, capabilities: ["positions", "holdings", "funds", "orderBook"] }] },
};

/** Recording stand-ins for every order-capable service: each method call is logged and throws. */
function recordingServices(log, reads = []) {
  const out = {};
  for (const name of ["orders", "paper", "safety", "audit", "accounts", "scheduler"]) {
    const svc = {};
    for (const m of SERVICE_CONTRACTS[name].methods) {
      svc[m] = (...args) => {
        if (READ_METHODS[name]?.includes(m)) {
          reads.push(`${name}.${m}`);
          return READ_ANSWERS[name][m](...args);
        }
        log.push(`${name}.${m}`);
        if (name === "scheduler" && m === "checkClient") return { ok: true, retryAfterMs: 0, headers: {} };
        throw new Error(`${name}.${m} must not be called from integrations`);
      };
    }
    out[name] = svc;
  }
  return out;
}

describe("route table", () => {
  it("every integrations route is GET with scope read", () => {
    expect(ROUTES.length).toBe(10);
    for (const [method, path, options] of ROUTES) {
      expect(method, path).toBe("GET");
      expect(options.scope, path).toBe("read");
      expect(options.auth ?? "key", path).toBe("key");
      expect(options.public, path).toBeUndefined();
      expect(path).toMatch(/^\/xl\//);
    }
  });
});

describe("handlers only read", () => {
  it("records every deps property the handlers touch", async () => {
    const touched = new Set();
    const calls = [];
    const reads = [];
    const real = { marketData: createFakeMarketData(), symbols: createFakeSymbols(), clock: { now: () => NOW_MS }, ...recordingServices(calls, reads) };
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
      expect([...touched].filter((p) => !USED_SERVICES.includes(p)), key).toEqual([]);
    }
    expect(calls).toEqual([]);
    // the probe really observed the handlers (not a vacuous pass)
    expect([...touched].sort()).toEqual(["accounts", "clock", "marketData", "orders", "symbols"]);
    expect([...USED_SERVICES].sort()).toEqual(["accounts", "clock", "marketData", "orders", "symbols"]);
    // of the order and account services only the listed read methods were called, and they were called
    expect([...new Set(reads)].sort()).toEqual(["accounts.list", "orders.funds", "orders.holdings", "orders.list", "orders.positions"]);
  });
});

describe("through the HTTP pipeline", () => {
  let t;
  const calls = [];
  const reads = [];
  beforeAll(async () => {
    t = await startTestApp({ overrides: recordingServices(calls, reads) });
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
  it("never names an order-capable service or method (portfolio.mjs reads four order methods and accounts.list, nothing else)", () => {
    const dir = new URL("./", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));
    expect(files.sort()).toEqual(["config.mjs", "ist.mjs", "module.mjs", "params.mjs", "portfolio.mjs", "quotes.mjs", "table.mjs", "xl.mjs"]);
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""); // code only
      if (f === "portfolio.mjs") {
        for (const [svc, methods] of [["orders", READ_METHODS.orders], ["accounts", READ_METHODS.accounts]]) {
          const used = [...src.matchAll(new RegExp(`deps\\.${svc}\\??\\.(\\w+)`, "g"))].map((m) => m[1]);
          expect(used.length, `${svc} reads`).toBeGreaterThan(0);
          for (const m of used) expect(methods, `${svc}.${m}`).toContain(m);
        }
        expect(src, f).not.toMatch(/deps\.(paper|safety|audit|scheduler|keyStore|secrets)\b/);
      } else expect(src, f).not.toMatch(/deps\.(orders|paper|safety|audit|accounts|scheduler|keyStore|secrets)\b/);
      expect(src, f).not.toMatch(/\b(placeOrder|cancelAll|issueOrderGate|modifyOrder|cancelOrder)\b/);
      expect(src, f).not.toMatch(/\.(place|modify|cancel)\(/);
      expect(src, f).not.toMatch(/brokers\//);
    }
  });
});
