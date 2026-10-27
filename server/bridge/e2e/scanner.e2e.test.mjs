/**
 * Scanner and backup routes end to end in demo mode: real pipeline, real MarketDataService over the demo account.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createCallContext } from "../core/context.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { mcpRegistryFor } from "../mcp/module.mjs";

describe("scanner over HTTP (demo mode)", () => {
  let app;
  let base;
  let admin;
  let reader;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-scan-e2e-"));
    const { config } = loadConfig({ raw: { dataDir: dir, server: { port: 0 }, logging: { level: "silent" } }, env: {}, demo: true });
    app = await createApp({ config, logger: createNullLogger() });
    const { port } = await app.listen();
    base = `http://127.0.0.1:${port}`;
    ({ key: admin } = await app.deps.keyStore.create({ label: "admin", scopes: ["admin"], accounts: "*" }));
    ({ key: reader } = await app.deps.keyStore.create({ label: "reader", scopes: ["read"], accounts: "*" }));
  });
  afterAll(async () => {
    await app?.close();
  });
  const call = async (method, path, body, key = reader) => {
    const r = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
  };

  it("documents its language and universes", async () => {
    const lang = await call("GET", "/v1/scanner/language");
    expect(lang.status).toBe(200);
    expect(lang.body.data.functions.map((f) => f.name)).toContain("rsi");
    const u = await call("GET", "/v1/scanner/universes");
    expect(u.body.data.map((x) => x.name)).toEqual(expect.arrayContaining(["FNO", "NIFTY50", "INDICES"]));
    const n = await call("GET", "/v1/scanner/universes/nifty50");
    expect(n.body.data.symbols).toHaveLength(50);
  });

  it("plans and runs a scan, waiting for the result", async () => {
    const req = { symbols: ["NSE:NIFTY", "NSE:BANKNIFTY", "NSE:RELIANCE", "NSE:TCS", "NSE:INFY"], interval: "1d", condition: "close > 0", columns: ["rsi(14)", "sma(5)"], sort: { by: "rsi(14)" } };
    const plan = await call("POST", "/v1/scanner/plan", req);
    expect(plan.status).toBe(200);
    expect(plan.body.data.pools).toEqual([expect.objectContaining({ kind: "broker", accountId: "demo" })]);
    const r = await call("POST", "/v1/scanner/jobs?waitMs=20000", req);
    expect(r.status).toBe(200);
    const job = r.body.data;
    expect(job.status).toBe("completed");
    expect(job.progress).toMatchObject({ total: 5, done: 5, errors: 0, matched: 5 });
    expect(job.results[0].values).toHaveProperty("rsi(14)");
    expect(job.results[0]).toMatchObject({ source: "broker", accountId: "demo" });
    const got = await call("GET", `/v1/scanner/jobs/${job.id}`);
    expect(got.body.data.results).toHaveLength(5);
    const list = await call("GET", "/v1/scanner/jobs");
    expect(list.body.data[0]).not.toHaveProperty("results");
  });

  it("a key sees only its own scans; an admin key sees all", async () => {
    const r = await call("POST", "/v1/scanner/jobs", { symbols: ["NSE:RELIANCE"], condition: "close > 0" }, admin);
    expect([200, 202]).toContain(r.status);
    const mine = await call("GET", `/v1/scanner/jobs/${r.body.data.id}`, undefined, reader);
    expect(mine.status).toBe(404);
    const all = await call("GET", "/v1/scanner/jobs", undefined, admin);
    expect(all.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses a bad condition with a readable message", async () => {
    const r = await call("POST", "/v1/scanner/jobs", { symbols: ["NSE:RELIANCE"], condition: "close >> 1" });
    expect(r.status).toBe(400);
    expect(r.body.detail).toMatch(/Scan condition/);
  });

  it("saves, lists, runs and deletes a saved scan", async () => {
    const c = await call("POST", "/v1/scanner/saved", { name: "Up days", request: { symbols: ["NSE:RELIANCE", "NSE:TCS"], condition: "close > open" }, everyMinutes: 15 });
    expect(c.status).toBe(201);
    const id = c.body.data.id;
    expect((await call("GET", "/v1/scanner/saved")).body.data.map((s) => s.id)).toContain(id);
    const run = await call("POST", `/v1/scanner/saved/${id}/run?waitMs=20000`);
    expect(run.body.data.savedId).toBe(id);
    expect((await call("DELETE", `/v1/scanner/saved/${id}`)).status).toBe(200);
    expect((await call("DELETE", `/v1/scanner/saved/${id}`)).status).toBe(404);
  });

  it("backup sources are off in demo mode and say so", async () => {
    const s = await call("GET", "/v1/backup/status");
    expect(s.body.data).toMatchObject({ enabled: false, demo: true, autoFallback: false });
    const q = await call("GET", "/v1/backup/quotes?symbols=NSE:RELIANCE");
    expect(q.status).toBe(422);
    expect(q.body.detail).toMatch(/demo mode/);
  });

  it("AI assistants can run a scan through the scan_market MCP tool", async () => {
    const registry = mcpRegistryFor(app.deps);
    const record = await app.deps.keyStore.authenticate(reader, {});
    const ctx = createCallContext({ source: "mcp", key: record, log: createNullLogger() });
    expect(registry.listTools(ctx).map((t) => t.name)).toContain("scan_market");
    const r = await registry.call("scan_market", { symbols: ["NSE:RELIANCE", "NSE:TCS"], condition: "close > 0", columns: ["rsi(14)"], sortBy: "close" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.data.status).toBe("completed");
    expect(r.structuredContent.data.matches).toHaveLength(2);
    expect(r.structuredContent.data.matches[0].values).toHaveProperty("rsi(14)");
  });
});
