/**
 * Nothing in the studies module can reach an order. Proved three ways:
 *  1. the route table: two routes, scope read, key auth, no order-like path;
 *  2. the static import graph of module.mjs and worker.mjs (the worker is started by URL, so it is a root of its own),
 *     followed through every relative import into the vendored core, reaches no order, paper, safety, book, strategy,
 *     trigger, hook or broker module, and no order-placing name appears in the vendored core;
 *  3. driven with hostile bodies, the handlers touch only deps.marketData (and deps.backupData, to read whether backup
 *     is on): a recording Proxy around deps, with order-capable services that throw if called.
 */
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SERVICE_CONTRACTS, notImplementedService } from "../core/contracts.mjs";
import { createStudyRoutes, ROUTES, USED_SERVICES } from "./module.mjs";
import { makeCandles } from "./__fixtures__/candles.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
const SPEC_RE = /^\s*(?:import|export)\b[^;'"]*?\bfrom\s*(['"])([^'"\n]+)\1|^\s*import\s*(['"])([^'"\n]+)\3/gm;

/** Every file reachable by static imports from the roots, and the bare (package or node:) specifiers seen. */
function graph(roots) {
  const seen = new Set();
  const bare = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(SPEC_RE)) {
      const spec = m[2] ?? m[4];
      if (spec.startsWith(".")) visit(resolve(dirname(file), spec));
      else bare.add(spec);
    }
  };
  roots.forEach(visit);
  return { files: [...seen].map((f) => relative(ROOT, f).split("\\").join("/")).sort(), bare: [...bare].sort() };
}

const FORBIDDEN = [
  /^server\/bridge\/(orders|paper|safety|book|strategies|triggers|hooks|accounts|auth|integrations|mcp|compat)\//,
  /^server\/brokers\//,
  /^server\/lib\/(orderGuard|dhanOrders|basketEngine|panic|positionStateMachine|riskEngine|deadManSwitch|tradingLockState)/,
];

describe("route table", () => {
  it("two read-scope routes, key auth, nothing order-like", () => {
    expect(ROUTES.map(([m, p]) => `${m} ${p}`)).toEqual(["GET /v1/studies", "POST /v1/studies/compute"]);
    for (const [, path, o] of ROUTES) {
      expect(o.scope, path).toBe("read");
      expect(o.auth ?? "key", path).toBe("key");
      expect(o.public, path).toBeUndefined();
      expect(o.allowQueryKey, path).toBeUndefined();
      expect(path).not.toMatch(/order|trade|position|basket|gtt|paper|live/i);
    }
    expect(USED_SERVICES).toEqual(["marketData"]);
  });
});

describe("import graph", () => {
  const g = graph([resolve(import.meta.dirname, "module.mjs"), resolve(import.meta.dirname, "worker.mjs")]);
  const worker = graph([resolve(import.meta.dirname, "worker.mjs")]);

  it("reaches no order-capable module", () => {
    expect(g.files.length).toBeGreaterThan(100);
    expect(g.files.filter((f) => FORBIDDEN.some((re) => re.test(f)))).toEqual([]);
    expect(g.bare.filter((s) => !s.startsWith("node:"))).toEqual(["zod"]);
  });

  it("the worker thread loads only the core, the error codes and compute.mjs", () => {
    const own = worker.files.filter((f) => !f.startsWith("server/vendor/chartist-core/"));
    expect(own).toEqual(["server/bridge/core/errors.mjs", "server/bridge/studies/compute.mjs", "server/bridge/studies/worker.mjs"]);
    expect(worker.bare).toEqual(["node:worker_threads"]);
  });

  it("the vendored core names no order-placing call", () => {
    for (const f of g.files.filter((x) => x.startsWith("server/vendor/"))) {
      expect(readFileSync(resolve(ROOT, f), "utf8"), f).not.toMatch(/placeOrder|modifyOrder|cancelOrder|\/v1\/orders|submitOrder/);
    }
  });
});

describe("handlers touch only market data", () => {
  it("records every deps property the handlers read", async () => {
    const touched = new Set();
    const calls = [];
    const candles = makeCandles(300);
    const real = {
      config: {},
      marketData: { history: async (params) => (calls.push(`marketData.history ${JSON.stringify(params)}`), { symbol: params.symbol, interval: params.interval, candles, partial: false, freshness: { source: "broker" } }) },
    };
    for (const name of Object.keys(SERVICE_CONTRACTS)) {
      if (real[name]) continue;
      const svc = notImplementedService(name);
      real[name] = new Proxy(svc, {
        get(t, m) {
          if (typeof m === "string" && typeof t[m] === "function") {
            return () => {
              calls.push(`${name}.${m}`);
              throw new Error(`${name}.${m} must not be called from studies`);
            };
          }
          return t[m];
        },
      });
    }
    const deps = new Proxy(real, {
      get(t, p) {
        if (typeof p === "string") touched.add(p);
        return t[p];
      },
    });
    const pool = {
      plan: async () => ({ warmBars: 20, units: 1, costPerBar: 1 }),
      run: async (_job, cs, from) => ({ time: cs.slice(from).map((c) => c.time), series: [], markers: [], fills: [], studies: [], usage: {} }),
    };
    const h = createStudyRoutes(deps, pool);
    const ctx = (body, query = "") => ({ body, query: new URLSearchParams(query), requestId: "r", signal: undefined, principal: { kind: "local" }, requireAccountAccess: () => {} });
    await h.list(ctx(undefined));
    const bodies = [
      { symbol: "NSE:RELIANCE", interval: "1d", studies: [{ id: "sma" }] },
      { symbol: "NSE:RELIANCE", interval: "1d", from: "2026-03-01", script: 'plot(close, "c")' },
      { symbol: "NSE:RELIANCE", interval: "1d", side: "BUY", quantity: 1, orderType: "MARKET", studies: [{ id: "sma" }] },
      { symbol: "NSE:RELIANCE", interval: "5m", studies: [{ id: "sma" }] },
      { symbol: "=PLACE_ORDER()", interval: "1d", script: "placeOrder()" },
    ];
    for (const b of bodies) {
      try {
        await h.compute(ctx(b, "account=demo&mode=live"));
      } catch {
        /* refusals are fine; what matters is what was touched */
      }
    }
    expect([...touched].sort()).toEqual(["backupData", "marketData"]);
    expect(calls.every((c) => c.startsWith("marketData.history"))).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });
});
