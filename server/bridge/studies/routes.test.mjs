/**
 * /v1/studies and /v1/studies/compute through real HTTP against the REAL app in demo mode (createApp with the built-in
 * modules, the real key store and the demo broker account, in a temp data folder on a loopback port).
 *
 * Also pins the response shape a chart reads: `time` plus series of `values` aligned to it, and markers.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createDemoRegistry } from "../demo/demoMode.mjs";
import { studyPoolOf } from "./module.mjs";

const START = Date.parse("2026-10-28T11:00:00+05:30");
const apps = [];
let base;
let readKey;
let app;

async function boot(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mcb-studies-"));
  const { config } = loadConfig({ raw: { dataDir: dir, server: { port: 0 }, logging: { level: "silent" }, ...extra }, env: {}, demo: true });
  const offset = START - Date.now();
  const now = () => Date.now() + offset;
  const a = await createApp({ config, logger: createNullLogger(), clock: { now }, brokers: createDemoRegistry({ now }) });
  const { port } = await a.listen();
  const { key } = await a.deps.keyStore.create({ label: "reader", scopes: ["read"], accounts: "*" });
  apps.push({ app: a, dir });
  return { app: a, base: `http://127.0.0.1:${port}`, key };
}

beforeAll(async () => {
  ({ app, base, key: readKey } = await boot());
});

afterAll(async () => {
  for (const x of apps) {
    await x.app.close();
    rmSync(x.dir, { recursive: true, force: true });
  }
});

async function call(method, path, body, { key = readKey, at = base, raw } = {}) {
  const res = await fetch(at + path, {
    method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined || raw !== undefined ? { "content-type": "application/json" } : {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave null */
  }
  return { status: res.status, body: json };
}

describe("GET /v1/studies", () => {
  it("lists studies and patterns with a read key", async () => {
    const r = await call("GET", "/v1/studies");
    expect(r.status).toBe(200);
    expect(r.body.data.studies.length).toBe(88);
    expect(r.body.data.patterns.length).toBe(24);
    expect(r.body.data.intervals).toEqual(["1d", "1w", "1M"]);
    expect(r.body.meta.requestId).toBeTruthy();
  });

  it("needs a key", async () => {
    expect((await call("GET", "/v1/studies", undefined, { key: null })).status).toBe(401);
    expect((await call("POST", "/v1/studies/compute", { symbol: "NSE:RELIANCE", interval: "1d", studies: [{ id: "sma" }] }, { key: null })).status).toBe(401);
  });
});

describe("POST /v1/studies/compute", () => {
  it("computes studies and patterns on the demo candles, aligned and warmed up", async () => {
    const r = await call("POST", "/v1/studies/compute", {
      symbol: "NSE:RELIANCE",
      interval: "1d",
      countback: 120,
      studies: [{ id: "sma", params: { length: 50 }, key: "sma50" }, { id: "bb" }, { id: "rsi" }, { id: "supertrend" }],
      patterns: "all",
    });
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.time).toHaveLength(120);
    expect(d.warmup).toEqual({ needed: 49, used: 49, short: 0 });
    for (const s of d.series) {
      expect(s.values, s.key).toHaveLength(120);
      // Warmed up: every value of these studies is known from the first candle shown.
      expect(s.values.every((v) => typeof v === "number" && Number.isFinite(v)), s.key).toBe(true);
    }
    expect(d.series.map((s) => s.key)).toEqual(["sma50.value", "bb1.upper", "bb1.mid", "bb1.lower", "rsi2.value", "supertrend3.value", "supertrend3.direction"]);
    for (const m of d.markers) {
      expect(d.time).toContain(m.time);
      expect(["above", "below"]).toContain(m.position);
      expect(typeof m.price).toBe("number");
    }
    expect(r.body.meta.freshness.source).toBeTruthy();
    expect(r.body.meta.core.stdlib).toMatch(/^1\.0\.0/);
    // The candles are the ones /v1/history gives for the same range.
    const h = await call("GET", "/v1/history?symbol=NSE:RELIANCE&interval=1d&countback=120");
    expect(h.body.data.candles.map((c) => c.time)).toEqual(d.time);
  });

  it("runs a ChartistScript indicator, from a date, with settings", async () => {
    const script = '@indicator(name="Cross", overlay=True)\ndef f(n: int = input(20, min=2, max=60)):\n    plot(ta.sma(close, n), "SMA")\n    mark(ta.crossover(close, ta.sma(close, n)), where="below", text="Up")\n';
    const r = await call("POST", "/v1/studies/compute", { symbol: "NSE:RELIANCE", interval: "1d", from: "2026-06-01", script, inputs: { n: 10 } });
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.script).toMatchObject({ name: "Cross", overlay: true, inputs: [{ name: "n", type: "int", default: 20, min: 2, max: 60 }] });
    expect(d.time[0]).toBeGreaterThanOrEqual(Date.parse("2026-06-01T00:00:00+05:30") / 1000);
    expect(d.series).toHaveLength(1);
    expect(d.series[0]).toMatchObject({ key: "p1", label: "SMA", pane: "price", style: "line" });
    expect(d.series[0].values[0]).not.toBeNull();
  });

  it("weekly candles work; intraday intervals are refused", async () => {
    const w = await call("POST", "/v1/studies/compute", { symbol: "NSE:RELIANCE", interval: "1w", countback: 30, studies: [{ id: "ema", params: { length: 10 } }] });
    expect(w.status).toBe(200);
    expect(w.body.data.time).toHaveLength(30);
    const i = await call("POST", "/v1/studies/compute", { symbol: "NSE:RELIANCE", interval: "5m", countback: 30, studies: [{ id: "sma" }] });
    expect(i.status).toBe(400);
    expect(i.body.code).toBe("VALIDATION_FAILED");
  });

  it("a bad script or setting fails with the core's diagnostics, before any candles are read", async () => {
    const r = await call("POST", "/v1/studies/compute", { symbol: "NSE:RELIANCE", interval: "1d", script: "plot(close +\n" });
    expect(r.status).toBe(400);
    expect(r.body.errors[0].message).toMatch(/^E-[A-Z-]+ line 1:/);
    const s = await call("POST", "/v1/studies/compute", { symbol: "NSE:RELIANCE", interval: "1d", studies: [{ id: "sma", params: { length: 9999 } }] });
    expect(s.status).toBe(400);
    expect(s.body.errors[0].path).toBe("studies[0].params.length");
    const u = await call("POST", "/v1/studies/compute", { symbol: "NSE:RELIANCE", interval: "1d", studies: [{ id: "sma" }], orderType: "MARKET" });
    expect(u.status).toBe(400);
  });

  it("limits: too many studies, a body over 64 KiB", async () => {
    const many = await call("POST", "/v1/studies/compute", { symbol: "NSE:RELIANCE", interval: "1d", studies: Array.from({ length: 17 }, () => ({ id: "sma" })) });
    expect(many.status).toBe(422);
    expect(many.body.code).toBe("COMPUTE_LIMIT");
    const big = await call("POST", "/v1/studies/compute", undefined, { raw: JSON.stringify({ symbol: "NSE:RELIANCE", interval: "1d", script: `# ${"x".repeat(70 * 1024)}\n` }) });
    expect(big.status).toBe(413);
    expect(big.body.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("a calculation past the time limit is stopped with COMPUTE_TIMEOUT; a full queue gives RATE_LIMITED", async () => {
    const b = await boot({ studies: { workers: 1, timeoutMs: 200, maxQueue: 0 } });
    const pool = studyPoolOf(b.app.deps);
    const body = { symbol: "NSE:RELIANCE", interval: "1d", countback: 50, studies: [{ id: "sma" }] };
    // Stand in for a script that never ends: the job holds its worker for a minute.
    const realPlan = pool.plan;
    pool.plan = (_job, o) => pool.spin(60_000, o);
    const t = await call("POST", "/v1/studies/compute", body, { at: b.base, key: b.key });
    expect(t.status).toBe(504);
    expect(t.body.code).toBe("COMPUTE_TIMEOUT");
    expect(pool.stats().timeouts).toBe(1);
    // One worker, no queue: while it is busy a second call is refused at once.
    const busy = pool.spin(150).catch(() => {});
    const q = await call("POST", "/v1/studies/compute", body, { at: b.base, key: b.key });
    expect(q.status).toBe(429);
    expect(q.body.code).toBe("RATE_LIMITED");
    await busy;
    pool.plan = realPlan;
  });
});
