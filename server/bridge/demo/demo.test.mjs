/**
 * Demo mode: deterministic sample data through the real pipeline, every response labelled, no real broker reachable,
 * live trading forced off.
 */
import http from "node:http";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateAdapter } from "../../brokers/contract.mjs";
import { createBrokerRegistry } from "../../brokers/registry.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { candles, createDemoAdapter, demoInstruments, expiriesFor, optionPrice, parseToken, smileVol, spotAt } from "./demoAdapter.mjs";
import { NIFTY50 } from "../scanner/universes.mjs";
import { DEMO_HEADER, createDemoRegistry, labelDemoResult } from "./demoMode.mjs";

const T = Date.UTC(2026, 9, 19, 5, 0, 0); // Monday 10:30 IST

describe("demo adapter", () => {
  const a = createDemoAdapter({ now: () => T });

  it("is a strict contract adapter with no order methods", () => {
    expect(validateAdapter(a).errors).toEqual([]);
    for (const m of ["placeOrder", "modifyOrder", "cancelOrder"]) expect(a[m]).toBeUndefined();
  });

  it("gives the same prices for the same instant", async () => {
    expect(spotAt("NIFTY", T)).toBe(spotAt("NIFTY", T));
    const q1 = await a.fetchQuotes({}, [{ token: "DM-RELIANCE", exchange: "NSE" }]);
    const q2 = await createDemoAdapter({ now: () => T }).fetchQuotes({}, [{ token: "DM-RELIANCE", exchange: "NSE" }]);
    expect(q1).toEqual(q2);
    expect(spotAt("NIFTY", T + 60_000)).not.toBe(spotAt("NIFTY", T));
    expect(spotAt("NIFTY", T)).toBeGreaterThan(22_000);
    expect(spotAt("NIFTY", T)).toBeLessThan(29_000);
  });

  it("lists NIFTY, BANKNIFTY, SENSEX and stocks, all named (Demo)", () => {
    const rows = demoInstruments(T);
    for (const u of ["NIFTY", "BANKNIFTY", "SENSEX", "RELIANCE", "TCS"]) expect(rows.some((r) => r.underlying === u)).toBe(true);
    expect(rows.every((r) => r.name.includes("(Demo)"))).toBe(true);
    expect(expiriesFor("NIFTY", T)[0]).toBe("2026-10-20");
    expect(expiriesFor("SENSEX", T)[0]).toBe("2026-10-22");
    expect(expiriesFor("BANKNIFTY", T)[0]).toBe("2026-10-27");
  });

  it("covers every NIFTY 50 stock, including symbols with - and &, so demo scans have a full universe", async () => {
    const listed = new Set(demoInstruments(T).map((r) => `${r.exchange}:${r.tradingSymbol}`));
    expect(NIFTY50.filter((s) => !listed.has(s))).toEqual([]);
    expect(parseToken("DM-BAJAJ-AUTO")).toEqual({ symbol: "BAJAJ-AUTO", kind: "spot" });
    expect(parseToken("DM-M&M")).toEqual({ symbol: "M&M", kind: "spot" });
    expect(parseToken("DM-NIFTY-2026-10-27-FUT")).toEqual({ symbol: "NIFTY", kind: "fut", expiry: "2026-10-27" });
    const q = await a.fetchQuotes({}, [{ token: "DM-BAJAJ-AUTO", exchange: "NSE" }, { token: "DM-M&M", exchange: "NSE" }]);
    expect(q.data.map((x) => x.ltp > 0)).toEqual([true, true]);
  });

  it("builds an option chain around the spot and candles in market hours", async () => {
    const chain = (await a.fetchOptionChain({}, "NIFTY", "2026-10-20")).data;
    expect(Object.keys(chain.oc)).toHaveLength(61);
    expect(chain.last_price).toBe(spotAt("NIFTY", T));
    const bars = candles("DM-NIFTY", "15m", Date.UTC(2026, 9, 16, 3, 45), Date.UTC(2026, 9, 16, 10, 0));
    expect(bars).toHaveLength(25);
    for (const b of bars) expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
  });

  it("prices CE and PE on one vol per strike and tenor: parity holds, fronts are richer, puts are skewed", () => {
    const S = spotAt("NIFTY", T);
    for (const e of expiriesFor("NIFTY", T)) {
      const years = Math.max((Date.parse(`${e}T15:30:00+05:30`) - T) / (365 * 86_400_000), 10 / (365 * 24 * 60));
      for (const k of [-6, -2, 0, 3, 7].map((i) => Math.round(S / 50) * 50 + i * 50)) {
        const c = optionPrice("NIFTY", e, k, "CE", T);
        const p = optionPrice("NIFTY", e, k, "PE", T);
        if (c <= 0.05 || p <= 0.05) continue;
        // C − P = S − K·e^(−rT), up to the 0.05 tick on each leg.
        expect(Math.abs(c - p - (S - k * Math.exp(-0.065 * years)))).toBeLessThanOrEqual(0.1 + 1e-9);
      }
    }
    const u = { iv: 0.12, step: 50 };
    expect(smileVol(u, 25000, 25000, 7 / 365)).toBeGreaterThan(smileVol(u, 25000, 25000, 60 / 365));
    expect(smileVol(u, 25000, 0.95 * 25000, 30 / 365)).toBeGreaterThan(smileVol(u, 25000, 1.05 * 25000, 30 / 365));
  });

  it("the demo registry holds only the demo broker", () => {
    const r = createDemoRegistry();
    expect(r.list()).toEqual(["demo"]);
    expect(() => r.get("zerodha")).toThrow(/Demo mode serves only/);
    expect(createBrokerRegistry().has("demo")).toBe(false);
  });

  it("labels { data, meta } bodies only", () => {
    expect(labelDemoResult({ data: 1, meta: { requestId: "r" } }).meta).toMatchObject({ demo: true, requestId: "r" });
    expect(labelDemoResult({ s: "ok" })).toEqual({ s: "ok" });
  });
});

describe("demo mode config", () => {
  it("replaces accounts, forces live trading off and keeps real brokers out", () => {
    const { config, warnings } = loadConfig({
      raw: { dataDir: "/tmp/x", safety: { liveTrading: true }, accounts: [{ id: "dhan-main", broker: "dhan", live: { enabled: true } }] },
      env: {},
      demo: true,
      knownBrokers: createBrokerRegistry().list(),
    });
    expect(config.demo).toBe(true);
    expect(config.safety.liveTrading).toBe(false);
    expect(config.accounts.map((a) => [a.id, a.broker])).toEqual([["demo", "demo"], ["demo-paper", "paper"]]);
    expect(warnings.join(" ")).toMatch(/DEMO MODE/);
  });

  it("MCB_DEMO=1 and \"demo\": true turn it on; a demo account outside demo mode is refused", () => {
    expect(loadConfig({ raw: {}, env: { MCB_DEMO: "1" } }).config.demo).toBe(true);
    expect(loadConfig({ raw: { demo: true }, env: {} }).config.demo).toBe(true);
    expect(() => loadConfig({ raw: { accounts: [{ id: "x1", broker: "demo" }] }, env: {}, knownBrokers: createBrokerRegistry().list() })).toThrow(/unknown broker demo/);
  });
});

describe("demo mode end to end", () => {
  let app;
  let base;
  let key;
  let dir;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "mcb-demo-"));
    const { config } = loadConfig({ raw: { dataDir: dir, server: { port: 0 }, logging: { level: "silent" } }, env: {}, demo: true });
    app = await createApp({ config, logger: createNullLogger() });
    const { port } = await app.listen();
    base = `http://127.0.0.1:${port}`;
    ({ key } = await app.deps.keyStore.create({ label: "t", scopes: ["admin", "paper"], accounts: "*" }));
  });
  afterAll(async () => {
    await app?.close();
  });
  const get = async (path) => {
    const r = await fetch(base + path, { headers: { Authorization: `Bearer ${key}` } });
    return { status: r.status, demo: r.headers.get(DEMO_HEADER), body: await r.json().catch(() => null) };
  };

  it("serves labelled quotes, chains and history from the demo account", async () => {
    const h = await get("/v1/health");
    expect(h).toMatchObject({ status: 200, demo: "demo", body: { demo: true } });
    const q = await get("/v1/quotes?symbols=NSE:NIFTY,BSE:SENSEX,NSE:RELIANCE");
    expect(q.status).toBe(200);
    expect(q.demo).toBe("demo");
    expect(q.body.meta).toMatchObject({ demo: true });
    expect(q.body.data.map((x) => x.freshness.broker)).toEqual(["demo", "demo", "demo"]);
    const e = await get("/v1/expiries?underlying=NIFTY");
    const c = await get(`/v1/optionchain?underlying=NIFTY&expiry=${e.body.data.expiries[0]}&strikes=3&greeks=true`);
    expect(c.status).toBe(200);
    expect(c.body.data.rows).toHaveLength(7);
    expect(c.body.data.rows[3].ce.delta).toBeGreaterThan(0);
    const hist = await get("/v1/history?symbol=NSE:NIFTY&interval=1d&countback=5");
    expect(hist.body.data.candles).toHaveLength(5);
    const cell = await fetch(`${base}/xl/ltp?symbol=NSE:NIFTY`, { headers: { Authorization: `Bearer ${key}` } });
    expect(cell.headers.get(DEMO_HEADER)).toBe("demo");
  });

  it("places paper orders and refuses live ones; writes no secrets file or master key", async () => {
    const order = (mode) =>
      fetch(`${base}/v1/orders`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json", "Idempotency-Key": `demo-test-${mode}-0001` },
        body: JSON.stringify({ account: "demo-paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "MARKET", mode }),
      });
    const paper = await order("paper");
    expect(paper.status).toBe(201);
    expect((await paper.json()).data.mode).toBe("paper");
    const live = await order("live");
    expect(live.status).toBeGreaterThanOrEqual(400);
    expect(existsSync(join(dir, "secrets.enc"))).toBe(false);
    expect(existsSync(join(dir, "master.key"))).toBe(false);
  });

  it("errors are labelled too", async () => {
    const r = await get("/v1/quotes");
    expect(r.status).toBe(400);
    expect(r.demo).toBe("demo");
  });

  it("an unknown account points at the demo account ids", async () => {
    const r = await get("/v1/positions?account=paper");
    expect(r.body.code).toBe("ACCOUNT_NOT_FOUND");
    expect(r.body.detail).toContain('"demo-paper"');
  });
});

describe("public demo dashboard (server.remoteDashboard)", () => {
  const get = (port, path, host) =>
    new Promise((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port, path, headers: { host, "x-forwarded-for": "203.0.113.9" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      r.on("error", reject);
      r.end();
    });
  const boot = async (remoteDashboard) => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-pubdemo-"));
    const { config } = loadConfig({ raw: { dataDir: dir, demo: true, server: { port: 0, allowedHosts: ["demo.example.com"], remoteDashboard }, logging: { level: "silent" } }, env: {} });
    const app = await createApp({ config, logger: createNullLogger() });
    const { port } = await app.listen();
    return { app, port };
  };

  it("serves the dashboard through a proxy only when switched on; key routes stay this-computer-only", async () => {
    const off = await boot(false);
    try {
      expect(await get(off.port, "/dashboard", "demo.example.com")).toBe(403);
    } finally {
      await off.app.close();
    }
    const on = await boot(true);
    try {
      expect(await get(on.port, "/dashboard", "demo.example.com")).toBe(200);
      expect(await get(on.port, "/dashboard/app.js", "demo.example.com")).toBe(200);
      expect(await get(on.port, "/v1/accounts", "demo.example.com")).toBe(401);
      expect(await get(on.port, "/dashboard", "evil.example.net")).toBe(403);
    } finally {
      await on.app.close();
    }
  });
});
