/**
 * Participant OI end to end (docs/spec/p1-12-guard-participants.md §10.3 step 8): the real Bridge (every module, real
 * HTTP on 127.0.0.1) in demo mode serves a balanced table with its formula and CSV; a fresh real-mode Bridge with NSE
 * archive downloads off fetches nothing and says SOURCE_OFF. deps.participants.latest() answers P1-8's shape.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { INSTRUMENTS, PARTICIPANTS } from "../participants/parser.mjs";
import { shiftedClock } from "./fixtures.mjs";

const AT = Date.parse("2026-10-29T12:00:00+05:30");

async function boot({ demo }) {
  const dir = mkdtempSync(join(tmpdir(), "mcb-part-e2e-"));
  const { config } = loadConfig({ raw: { dataDir: dir, server: { port: 0 }, logging: { level: "silent" } }, env: {}, demo });
  const app = await createApp({ config, logger: createNullLogger(), clock: shiftedClock(AT) });
  const { port } = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  const { key: admin } = await app.deps.keyStore.create({ label: "admin", scopes: ["admin", "read"], accounts: "*" });
  const { key: reader } = await app.deps.keyStore.create({ label: "reader", scopes: ["read"], accounts: "*" });
  const call = async (method, path, { body, key = reader } = {}) => {
    const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${key}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* CSV */
    }
    return { status: r.status, json, text, headers: r.headers };
  };
  return { app, call, admin, reader };
}

describe("participants over HTTP (demo mode)", () => {
  let b;
  beforeAll(async () => {
    b = await boot({ demo: true });
  });
  afterAll(async () => {
    await b?.app.close();
  });

  it("summary: a balanced table for the latest day with the formula and the published note", async () => {
    const r = await b.call("GET", "/v1/participants/oi/summary");
    expect(r.status).toBe(200);
    const d = r.json.data;
    expect(d).toMatchObject({ available: true, date: "2026-10-28", exchange: "NSE", unit: "contracts", quality: "ok", source: "demo" });
    expect(d.headline.formula).toMatch(/FII long ÷ \(FII long \+ FII short\) × 100/);
    expect(d.publishedNote).toMatch(/^NSE only\. Summed over all strikes and expiries\. Number of contracts/);
    for (const x of INSTRUMENTS) {
      const rows = d.table.filter((t) => t.instrument === x);
      const sum = (k) => rows.filter((t) => t.participant !== "TOTAL").reduce((a, t) => a + t[k], 0);
      const total = rows.find((t) => t.participant === "TOTAL");
      expect(sum("long")).toBe(total.long);
      expect(sum("short")).toBe(total.short);
      expect(total.long).toBe(total.short);
    }
    expect(d.history.fiiIndexFutLongPct).toHaveLength(20);
  });

  it("series as JSON and as a CSV download", async () => {
    const j = await b.call("GET", "/v1/participants/oi?from=2026-10-01&to=2026-10-28&participants=FII,TOTAL&instruments=IDX_FUT");
    expect(j.status).toBe(200);
    expect(j.json.data.days.length).toBeGreaterThan(15);
    expect(Object.keys(j.json.data.days[0].rows)).toEqual(["FII", "TOTAL"]);
    const c = await b.call("GET", "/v1/participants/oi?from=2026-10-20&to=2026-10-28&format=csv");
    expect(c.status).toBe(200);
    expect(c.headers.get("content-type")).toMatch(/text\/csv/);
    expect(c.headers.get("content-disposition")).toMatch(/participant-oi_2026-10-20_2026-10-28\.csv/);
    const lines = c.text.trim().split("\r\n");
    expect(lines[0]).toBe("date,exchange,participant,instrument,long,short,net,long_pct,unit,quality,lot_regime");
    expect(lines.length).toBe(1 + 30 * j.json.data.days.filter((x) => x.date >= "2026-10-20").length);
    const bad = await b.call("GET", "/v1/participants/oi?instruments=XYZ");
    expect(bad.status).toBe(400);
  });

  it("status shows two years of demo history; sync is refused in demo mode and needs admin", async () => {
    const s = await b.call("GET", "/v1/participants/status");
    expect(s.json.data).toMatchObject({ demo: true, latestDate: "2026-10-28", backfill: { target: 500 } });
    expect((await b.call("POST", "/v1/participants/sync", { body: {} })).status).toBe(403);
    const r = await b.call("POST", "/v1/participants/sync", { body: {}, key: b.admin });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe("CAPABILITY_UNSUPPORTED");
  });

  it("deps.participants.latest() returns the shape p1-08 §3.5 reads; BSE is never available", () => {
    const l = b.app.deps.participants.latest({ exchange: "NSE" });
    expect(l).toMatchObject({ available: true, asOfDate: "2026-10-28", source: "demo" });
    expect(l.rows).toHaveLength(PARTICIPANTS.length * INSTRUMENTS.length);
    for (const r of l.rows) {
      expect(Object.keys(r).sort()).toEqual(["instrument", "long", "participant", "short"]);
      expect(PARTICIPANTS).toContain(r.participant);
    }
    expect(b.app.deps.participants.latest({ exchange: "BSE" })).toMatchObject({ available: false, reason: "NOT_FOR_BSE" });
  });
});

describe("participants over HTTP (real mode, archive downloads off)", () => {
  let b;
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  beforeAll(async () => {
    b = await boot({ demo: false });
  });
  afterAll(async () => {
    await b?.app.close();
    fetchSpy.mockRestore();
  });

  it("answers SOURCE_OFF, fetches nothing from NSE and refuses a sync", async () => {
    const r = await b.call("GET", "/v1/participants/oi/summary");
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ available: false, reason: "SOURCE_OFF" });
    expect(r.json.data.detail).toMatch(/Turn on NSE archive downloads/);
    const s = await b.call("GET", "/v1/participants/status");
    expect(s.json.data).toMatchObject({ demo: false, source: { nseArchives: "off" }, latestDate: null, rows: 0 });
    const y = await b.call("POST", "/v1/participants/sync", { body: {}, key: b.admin });
    expect(y.status).toBe(422);
    await b.app.deps.participants.tick();
    const external = fetchSpy.mock.calls.map((c) => String(c[0])).filter((u) => !u.startsWith("http://127.0.0.1"));
    expect(external).toEqual([]);
  });
});
