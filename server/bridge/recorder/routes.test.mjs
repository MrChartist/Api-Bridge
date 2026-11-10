/**
 * The recorder routes on the real app (router, auth, scopes, loopback rule), with the fakes behind the services.
 */
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { createFakeKeyStore } from "../auth/fake.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createFakeMarketData } from "../market/fake.mjs";
import { createFakeScheduler } from "../ratelimit/fake.mjs";
import { createFakeAuditLog } from "../safety/fake.mjs";
import { createFakeStreamHub } from "../stream/fake.mjs";
import { createRecorderModule } from "./module.mjs";

let b;
const remote = { "X-Forwarded-For": "192.0.2.50" };

async function boot(extra = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-rec-http-"));
  const { config } = loadConfig({ raw: { dataDir, logging: { level: "silent" }, server: { port: 0 }, recorder: extra.recorder ?? {} }, env: {} });
  const keyStore = createFakeKeyStore();
  const audit = createFakeAuditLog();
  const app = await createApp({
    config,
    modules: [createRecorderModule({ library: () => extra.library ?? null })],
    logger: createNullLogger(),
    overrides: {
      keyStore,
      audit,
      accounts: createFakeAccountManager({ accounts: [{ id: "main", broker: "dhan" }] }),
      scheduler: createFakeScheduler(),
      symbols: { parse: (s) => ({ canonical: s }), format: () => "", resolve: async (s) => ({ canonical: s }), toBroker: async () => null, fromBroker: async () => null, search: async () => ({ items: [] }), convert: async () => ({}), refresh: async () => ({}), status: () => ({}) },
      streamHub: createFakeStreamHub({ connected: false }),
      marketData: createFakeMarketData({ prices: { "NSE:NIFTY": 24012 } }),
    },
  });
  const { port } = await app.listen();
  const keys = { admin: keyStore.addKey({ label: "admin", scopes: ["admin"], accounts: "*" }).key, read: keyStore.addKey({ label: "r", scopes: ["read"], accounts: "*" }).key };
  const request = ({ method = "GET", path, key, body, headers = {}, binary = false }) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        { host: "127.0.0.1", port, method, path, agent: false, headers: { host: `127.0.0.1:${port}`, ...(key ? { authorization: `Bearer ${key}` } : {}), ...(payload !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...headers } },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const buf = Buffer.concat(chunks);
            const text = binary ? "" : buf.toString("utf8");
            let json;
            try {
              json = JSON.parse(text);
            } catch {
              json = undefined;
            }
            resolve({ status: res.statusCode, headers: res.headers, raw: text, buf, json });
          });
        },
      );
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  return { app, keys, audit, dataDir, request, async close() { await app.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

beforeEach(async () => {
  b = await boot();
});
afterEach(async () => b.close());

const admin = () => b.keys.admin;
const read = () => b.keys.read;
const QUOTES = { kind: "quotes", symbols: ["NSE:NIFTY"], everySec: 1, sessionOnly: false };

describe("scopes and the this-computer rule", () => {
  it("reading needs a read key; changing anything needs an admin key from this computer", async () => {
    expect((await b.request({ path: "/v1/recordings" })).status).toBe(401);
    expect((await b.request({ path: "/v1/recordings", key: read() })).status).toBe(200);
    expect((await b.request({ method: "POST", path: "/v1/recordings", key: read(), body: QUOTES })).status).toBe(403);
    const far = await b.request({ method: "POST", path: "/v1/recordings", key: admin(), body: QUOTES, headers: remote });
    expect(far.status).toBe(403);
    expect(far.json.code).toBe("LOOPBACK_ONLY");
    for (const [method, path] of [["PUT", "/v1/recordings/auto"], ["POST", "/v1/recordings/rules"], ["POST", "/v1/recordings/presets/my-watchlist/apply"], ["DELETE", "/v1/recordings/rec_abcd1234"]]) {
      const r = await b.request({ method, path, key: read(), body: {} });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    // a read key can read everything, including status, rules and presets
    for (const path of ["/v1/recordings/status", "/v1/recordings/auto", "/v1/recordings/rules", "/v1/recordings/presets"]) expect((await b.request({ path, key: read() })).status, path).toBe(200);
  });
});

describe("manual recordings", () => {
  it("create, read, pause, resume, stop, delete", async () => {
    const created = await b.request({ method: "POST", path: "/v1/recordings", key: admin(), body: { ...QUOTES, name: "Nifty ticks" } });
    expect(created.status).toBe(201);
    const rec = created.json.data;
    expect(rec).toMatchObject({ name: "Nifty ticks", kind: "quotes", dataClass: "realtime", status: expect.stringMatching(/^(recording|waiting)$/), format: "csv" });
    expect(rec.id).toMatch(/^rec_[a-z0-9]{8}$/);
    const list = await b.request({ path: "/v1/recordings", key: read() });
    expect(list.json.data.map((r) => r.id)).toEqual([rec.id]);
    expect(list.json.meta.status).toMatch(/Recording|Auto-record/);
    expect((await b.request({ path: `/v1/recordings/${rec.id}`, key: read() })).json.data.files).toMatchObject({ count: 0 });
    expect((await b.request({ method: "POST", path: `/v1/recordings/${rec.id}/pause`, key: admin() })).json.data.status).toBe("paused");
    expect((await b.request({ method: "POST", path: `/v1/recordings/${rec.id}/resume`, key: admin() })).json.data.status).not.toBe("paused");
    expect((await b.request({ method: "POST", path: `/v1/recordings/${rec.id}/stop`, key: admin() })).json.data.status).toBe("stopped");
    expect((await b.request({ method: "POST", path: `/v1/recordings/${rec.id}/resume`, key: admin() })).status).toBe(409);
    expect((await b.request({ method: "DELETE", path: `/v1/recordings/${rec.id}`, key: admin() })).status).toBe(204);
    expect((await b.request({ path: `/v1/recordings/${rec.id}`, key: read() })).status).toBe(404);
    expect(b.audit.ofType("recording.*").map((r) => r.type)).toEqual(["recording.created", "recording.paused", "recording.resumed", "recording.stopped", "recording.deleted"]);
  });

  it("refuses a bad body in plain words, a delayed data class, and ids that are not ours", async () => {
    const bad = await b.request({ method: "POST", path: "/v1/recordings", key: admin(), body: { kind: "chain", underlying: "NIFTY", everySec: 5 } });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("VALIDATION_FAILED");
    expect(bad.json.detail).toMatch(/at least 15 seconds/);
    const delayed = await b.request({ method: "POST", path: "/v1/recordings", key: admin(), body: { ...QUOTES, dataClass: "delayed" } });
    expect(delayed.status).toBe(400);
    expect(delayed.json.detail).toMatch(/real-time data only/);
    expect((await b.request({ method: "POST", path: "/v1/recordings", key: admin(), body: { ...QUOTES, surprise: 1 } })).status).toBe(400);
    expect((await b.request({ path: "/v1/recordings/..%2F..%2Fetc", key: read() })).status).toBe(404);
    expect((await b.request({ path: "/v1/recordings/rec_nope0000", key: read() })).status).toBe(404);
  });

  it("lists and streams the day files; only listed names open; compressed days keep their .gz", async () => {
    const rec = (await b.request({ method: "POST", path: "/v1/recordings", key: admin(), body: QUOTES })).json.data;
    const dir = join(b.dataDir, "recordings", rec.id);
    mkdirSync(dir, { recursive: true });
    const csv = "time,symbol,ltp\n2026-11-09T09:15:00.000+05:30,NSE:NIFTY,24000\n";
    writeFileSync(join(dir, "2026-11-09__NSE_NIFTY.csv"), csv);
    writeFileSync(join(dir, "2026-11-06__NSE_NIFTY.csv.gz"), gzipSync(csv));
    const files = await b.request({ path: `/v1/recordings/${rec.id}/files`, key: read() });
    expect(files.status).toBe(200);
    expect(files.json.data).toMatchObject([
      { name: "2026-11-06__NSE_NIFTY.csv.gz", compressed: true, rows: 1, symbol: "NSE:NIFTY" },
      { name: "2026-11-09__NSE_NIFTY.csv", compressed: false, rows: 1, date: "2026-11-09" },
    ]);
    expect(files.json.meta).toMatchObject({ dataClass: "realtime" });
    const one = await b.request({ path: `/v1/recordings/${rec.id}/files/2026-11-09__NSE_NIFTY.csv`, key: read() });
    expect(one.status).toBe(200);
    expect(one.raw).toBe(csv);
    expect(one.headers["content-type"]).toMatch(/^text\/csv/);
    expect(one.headers["content-disposition"]).toBe('attachment; filename="2026-11-09__NSE_NIFTY.csv"');
    expect(one.headers["x-data-class"]).toBe("realtime");
    const gz = await b.request({ path: `/v1/recordings/${rec.id}/files/2026-11-06__NSE_NIFTY.csv.gz`, key: read(), binary: true });
    expect(gz.headers["content-type"]).toBe("application/gzip");
    expect(gz.buf.equals(gzipSync(csv)) || gz.buf.length > 10).toBe(true);
    for (const name of ["recording.json", "gaps.jsonl", "..%2Frecording.json", "2026-11-09__NSE_MISSING.csv", "2026-13-99__X_Y.csv"]) {
      expect((await b.request({ path: `/v1/recordings/${rec.id}/files/${name}`, key: read() })).status, name).toBe(404);
    }
    expect((await b.request({ path: `/v1/recordings/${rec.id}/files/2026-11-09__NSE_NIFTY.csv` })).status).toBe(401);
  });
});

describe("settings", () => {
  it("is not read as a recording id; a read key reads, an admin key from this computer changes", async () => {
    const got = await b.request({ path: "/v1/recordings/settings", key: read() });
    expect(got.status).toBe(200);
    expect(got.json.data).toMatchObject({ maxBudgetShare: 0.3, defaults: { maxBudgetShare: 0.3 }, limits: { minBudgetShare: 0.05, maxBudgetShare: 0.8 } });
    expect((await b.request({ path: "/v1/recordings/settings" })).status).toBe(401);
    const patch = (body, o = {}) => b.request({ method: "PATCH", path: "/v1/recordings/settings", key: admin(), body, ...o });
    expect((await patch({ maxBudgetShare: 0.6 }, { key: read() })).status).toBe(403);
    const far = await patch({ maxBudgetShare: 0.6 }, { headers: remote });
    expect(far.status).toBe(403);
    expect(far.json.code).toBe("LOOPBACK_ONLY");
    expect((await patch({ maxBudgetShare: 0.9 })).status).toBe(400);
    const noAfterHours = await patch({ afterHoursOnly: true });
    expect(noAfterHours.status).toBe(400);
    expect(noAfterHours.json.detail).toMatch(/market hours/);
    const ok = await patch({ maxBudgetShare: 0.6 });
    expect(ok.status).toBe(200);
    expect(ok.json.data.maxBudgetShare).toBe(0.6);
    expect((await b.request({ path: "/v1/recordings/status", key: read() })).json.data.budgetShare).toBe(0.6);
    expect(b.audit.ofType("recording.settings_changed")).toHaveLength(1);
  });
});

describe("rules, presets and the auto-record switch", () => {
  it("auto-record is off until turned on; rules are created, read, changed and deleted", async () => {
    const auto = await b.request({ path: "/v1/recordings/auto", key: read() });
    expect(auto.json.data).toMatchObject({ enabled: false, rules: 0 });
    const made = await b.request({ method: "POST", path: "/v1/recordings/rules", key: admin(), body: { name: "My ticks", kind: "quotes", symbols: ["NSE:NIFTY"], everySec: 5 } });
    expect(made.status).toBe(201);
    expect(made.json.data).toMatchObject({ id: "my-ticks", enabled: true, schedule: "market-hours", format: "csv", state: "off", source: "user" });
    expect((await b.request({ path: "/v1/recordings", key: read() })).json.data).toEqual([]);
    const on = await b.request({ method: "PUT", path: "/v1/recordings/auto", key: admin(), body: { enabled: true } });
    expect(on.json.data).toMatchObject({ enabled: true, activeRules: 1 });
    expect((await b.request({ path: "/v1/recordings", key: read() })).json.data.map((r) => r.id)).toEqual(["rule-my-ticks"]);
    const patched = await b.request({ method: "PATCH", path: "/v1/recordings/rules/my-ticks", key: admin(), body: { everySec: 15, keepDays: 10 } });
    expect(patched.json.data).toMatchObject({ everySec: 15, keepDays: 10 });
    expect((await b.request({ path: "/v1/recordings/rules/my-ticks", key: read() })).json.data.recordingId).toBe("rule-my-ticks");
    expect((await b.request({ method: "PATCH", path: "/v1/recordings/rules/my-ticks", key: admin(), body: { id: "x" } })).status).toBe(400);
    expect((await b.request({ method: "POST", path: "/v1/recordings/rec_0000abcd/stop", key: admin() })).status).toBe(404);
    expect((await b.request({ method: "POST", path: "/v1/recordings/rule-my-ticks/stop", key: admin() })).status).toBe(409);
    expect((await b.request({ method: "DELETE", path: "/v1/recordings/rules/my-ticks", key: admin() })).status).toBe(204);
    expect((await b.request({ path: "/v1/recordings/rules/my-ticks", key: read() })).status).toBe(404);
    expect((await b.request({ method: "PUT", path: "/v1/recordings/auto", key: admin(), body: { enabled: "yes" } })).status).toBe(400);
  });

  it("presets: list, apply once, apply again without duplicating", async () => {
    const presets = (await b.request({ path: "/v1/recordings/presets", key: read() })).json.data;
    expect(presets.map((p) => p.id)).toEqual(["index-option-chains", "my-watchlist"]);
    expect(presets[0]).toMatchObject({ title: "Record index option chains", rule: { kind: "chain", everySec: 30 } });
    const first = await b.request({ method: "POST", path: "/v1/recordings/presets/index-option-chains/apply", key: admin(), body: {} });
    expect(first.status).toBe(201);
    expect(first.json.data).toMatchObject({ created: true, auto: { enabled: true } });
    expect((await b.request({ method: "POST", path: "/v1/recordings/presets/index-option-chains/apply", key: admin(), body: {} })).status).toBe(200);
    expect((await b.request({ path: "/v1/recordings/rules", key: read() })).json.data).toHaveLength(1);
    expect((await b.request({ method: "POST", path: "/v1/recordings/presets/my-watchlist/apply", key: admin(), body: {} })).status).toBe(422);
    expect((await b.request({ method: "POST", path: "/v1/recordings/presets/nope/apply", key: admin(), body: {} })).status).toBe(404);
  });

  it("the plain status line", async () => {
    const s = await b.request({ path: "/v1/recordings/status", key: read() });
    expect(s.json.data.line).toBe("Recording is off. Nothing is being saved.");
    expect(s.json.data).toMatchObject({ dataClass: "realtime", budgetShare: 0.3, disk: { limitMb: 5000 } });
  });
});
