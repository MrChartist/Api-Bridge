/**
 * S17 routes (docs/spec/p1-01-recorder.md §4, §9): validation errors on every route, the CSV shape and cursor header,
 * the `unavailable` reasons, CAPACITY_EXCEEDED (with canCarry) and CONFIRMATION_REQUIRED, account-id redaction for
 * restricted keys, demo `persisted: false`, and — through the real request pipeline — scopes, loopback and that the
 * response fields are documented in docs/openapi.yaml.
 */
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { BridgeError, toProblem } from "../core/errors.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createRecorderRoutes, parseSnapshotQuery, snapshotsCsv, toApiSnapshot } from "./routes.mjs";
import { EXPIRY, IST, fakeSymbols, makeRecorder } from "./testkit.mjs";

const ctxFor = ({ query = {}, body, accounts = "*", local = false } = {}) => ({
  query: new URLSearchParams(query),
  body,
  requestId: "req_test",
  principal: local ? { kind: "local", id: "cli" } : { kind: "key", id: "k1" },
  key: { accounts },
  requireAccountAccess(id) {
    if (local || accounts === "*" || accounts.includes(id)) return;
    throw new BridgeError("ACCOUNT_FORBIDDEN", `This key may not use account ${id}.`);
  },
});

async function codeOf(p) {
  try {
    await p;
  } catch (err) {
    return toProblem(err);
  }
  return null;
}

async function recorded() {
  const r = makeRecorder({ start: IST("2026-10-19T10:00:30"), recorder: { sources: { stream: false } } });
  await r.svc.start();
  await r.minutes(5); // 10:00 … 10:05
  return { ...r, routes: createRecorderRoutes(r.svc, r.deps) };
}

describe("GET /v1/options/snapshots", () => {
  it("validates every parameter", async () => {
    const now = IST("2026-10-19T10:05:00");
    const bad = [
      [{}, "underlying"],
      [{ underlying: "NIFTY" }, "expiry"],
      [{ underlying: "nifty 50", expiry: EXPIRY }, "underlying"],
      [{ underlying: "NIFTY", expiry: "2026-02-30" }, "expiry"],
      [{ underlying: "NIFTY", expiry: EXPIRY, fields: "oi,theta" }, "fields"],
      [{ underlying: "NIFTY", expiry: EXPIRY, from: "2026-10-19T11:00", to: "2026-10-19T10:00" }, "to"],
      [{ underlying: "NIFTY", expiry: EXPIRY, from: "2026-09-01", to: "2026-10-19" }, "to"],
      [{ underlying: "NIFTY", expiry: EXPIRY, every: "2" }, "every"],
      [{ underlying: "NIFTY", expiry: EXPIRY, strikes: "61" }, "strikes"],
      [{ underlying: "NIFTY", expiry: EXPIRY, limit: "0" }, "limit"],
      [{ underlying: "NIFTY", expiry: EXPIRY, cursor: "junk" }, "cursor"],
      [{ underlying: "NIFTY", expiry: EXPIRY, format: "xml" }, "format"],
      [{ underlying: "NIFTY", expiry: EXPIRY, includeSuspect: "maybe" }, "includeSuspect"],
      [{ underlying: "NIFTY", expiry: EXPIRY, from: "yesterday" }, "from"],
    ];
    for (const [query, path] of bad) {
      let err = null;
      try {
        parseSnapshotQuery(new URLSearchParams(query), { now });
      } catch (e) {
        err = toProblem(e);
      }
      expect(err?.code, JSON.stringify(query)).toBe("VALIDATION_FAILED");
      expect(err.errors?.[0]?.path ?? "", JSON.stringify(query)).toBe(path);
    }
    const ok = parseSnapshotQuery(new URLSearchParams({ underlying: "nifty", expiry: EXPIRY }), { now });
    expect(ok).toMatchObject({ underlying: "NIFTY", fromMs: IST("2026-10-19T09:15:00"), toMs: now, fields: ["ltp", "oi", "volume", "iv"], every: 1, limit: 400, format: "json" });
  });

  it("returns snapshots with IST times, units, coverage and method; pages with a cursor", async () => {
    const r = await recorded();
    const out = await r.routes.snapshots(ctxFor({ query: { underlying: "NIFTY", expiry: EXPIRY, fields: "oi,ltp", limit: "4" } }));
    const d = out.data;
    expect(d).toMatchObject({ underlying: "NIFTY", expiry: EXPIRY, units: { oi: "units", volume: "units", iv: "percent", price: "INR", age: "ms" }, fields: ["oi", "ltp"], unavailable: null });
    expect(d.snapshots).toHaveLength(4);
    expect(d.snapshots[0]).toMatchObject({ slot: "2026-10-19T10:00:00.000+05:30", source: "rest", accountId: "acc-1", broker: "upstox", quality: "live", lotSize: 75, model: "b76-vt1" });
    expect(Object.keys(d.snapshots[0].ce)).toEqual(["oi", "ltp"]);
    expect(d.coverage).toMatchObject({ recordedSlots: 6, gapSlots: 0, firstSlot: "2026-10-19T10:00:00.000+05:30" });
    expect(d.method.iv).toMatch(/Black-76/);
    expect(d.nextCursor).toEqual(expect.any(String));
    const next = await r.routes.snapshots(ctxFor({ query: { underlying: "NIFTY", expiry: EXPIRY, fields: "oi,ltp", limit: "4", cursor: d.nextCursor } }));
    expect(next.data.snapshots.map((s) => s.slot)).toEqual(["2026-10-19T10:04:00.000+05:30", "2026-10-19T10:05:00.000+05:30"]);
    expect(next.data.nextCursor).toBeNull();
    await r.svc.stop();
  });

  it("CSV: one row per slot, strike and right; gaps as GAP rows; cursor header", async () => {
    const r = await recorded();
    const reply = await r.routes.snapshots(ctxFor({ query: { underlying: "NIFTY", expiry: EXPIRY, fields: "oi,ltp", limit: "2", format: "csv" } }));
    expect(reply.headers["Content-Type"]).toMatch(/text\/csv/);
    expect(reply.headers["Content-Disposition"]).toMatch(/NIFTY_2026-10-27_snapshots\.csv/);
    expect(reply.headers["X-MCB-Next-Cursor"]).toEqual(expect.any(String));
    const lines = String(reply.body).trim().split("\r\n");
    expect(lines[0]).toBe("slot,ts,source,quality,spot,forward,strike,right,oi,ltp");
    expect(lines).toHaveLength(1 + 2 * 5 * 2);
    const rows = snapshotsCsv({ fields: ["oi"], snapshots: [], gaps: [{ from: "x", reason: "stream-down" }] });
    expect(rows[1]).toEqual(["x", null, null, null, null, null, null, "GAP", "stream-down"]);
    await r.svc.stop();
  });

  it("nothing recorded: 200 with unavailable not-in-plan / not-recorded-yet / refused", async () => {
    const r = await recorded();
    const notInPlan = await r.routes.snapshots(ctxFor({ query: { underlying: "BANKNIFTY", expiry: EXPIRY } }));
    expect(notInPlan.data.snapshots).toEqual([]);
    expect(notInPlan.data.unavailable).toEqual({ reason: "not-in-plan", detail: "BANKNIFTY 2026-10-27 is not in the recorder plan. Add it on the Data recorder page." });
    expect(notInPlan.data.coverage).toMatchObject({ recordedSlots: 0, gapSlots: 0 });
    const notYet = await r.routes.snapshots(ctxFor({ query: { underlying: "NIFTY", expiry: EXPIRY, from: "2026-10-19T09:15", to: "2026-10-19T09:30" } }));
    expect(notYet.data.unavailable.reason).toBe("not-recorded-yet");
    await r.svc.stop();
    const z = makeRecorder({ start: IST("2026-10-19T10:00:30"), accounts: [{ id: "zer-1", broker: "zerodha" }], recorder: { sources: { stream: false } } });
    await z.svc.start();
    const refused = await createRecorderRoutes(z.svc, z.deps).snapshots(ctxFor({ query: { underlying: "NIFTY", expiry: EXPIRY } }));
    expect(refused.data.unavailable.reason).toBe("refused");
    expect(refused.data.unavailable.detail).toMatch(/1 request\/s/);
    await z.svc.stop();
  });

  it("account ids are null for a key limited to other accounts", async () => {
    const r = await recorded();
    const out = await r.routes.snapshots(ctxFor({ accounts: ["other"], query: { underlying: "NIFTY", expiry: EXPIRY, limit: "1" } }));
    expect(out.data.snapshots[0]).toMatchObject({ accountId: null, broker: null, accounts: null });
    const st = await r.routes.status(ctxFor({ accounts: ["other"] }));
    expect(st.data.account).toMatchObject({ id: null, feedAccount: null, broker: null });
    expect(st.data.oiUnits.broker).toBeNull();
    // No id of the recorder's account (and no broker name) anywhere in the status, warnings included.
    const text = JSON.stringify(st.data);
    expect(text).not.toContain("acc-1");
    expect(text.toLowerCase()).not.toContain("upstox");
    const own = await r.routes.status(ctxFor({ accounts: ["acc-1"] }));
    expect(own.data.account.id).toBe("acc-1");
    expect(toApiSnapshot({ slot: 0, ts: 0, accountId: "acc-1", broker: "x", k: [], ce: {}, pe: {} }, ctxFor({ local: true, accounts: [] })).accountId).toBe("acc-1");
    await r.svc.stop();
  });
});

describe("latest, daily, status, plan", () => {
  it("latest from memory; 404 when nothing today", async () => {
    const r = await recorded();
    const out = await r.routes.latest(ctxFor({ query: { underlying: "NIFTY", expiry: EXPIRY, fields: "oi", strikes: "1" } }));
    expect(out.data.snapshot).toMatchObject({ slot: "2026-10-19T10:05:00.000+05:30" });
    expect(out.data.snapshot.strikes).toHaveLength(3);
    const p = await codeOf(r.routes.latest(ctxFor({ query: { underlying: "NIFTY", expiry: "2026-11-03" } })));
    expect(p).toMatchObject({ code: "NOT_FOUND", status: 404, detail: "No snapshot has been recorded today for NIFTY 3 Nov." });
    expect((await codeOf(r.routes.latest(ctxFor({ query: { underlying: "NIFTY" } })))).code).toBe("VALIDATION_FAILED");
    await r.svc.stop();
  });

  it("daily rows with full names; bad ranges refused", async () => {
    const r = await recorded();
    await r.svc.runDaily("2026-10-19");
    const out = await r.routes.daily(ctxFor({ query: { underlying: "NIFTY" } }));
    expect(out.data.rows).toHaveLength(1);
    expect(Object.keys(out.data.rows[0])).toEqual(expect.arrayContaining(["pcrOi", "pcrVolume", "maxPain", "largestCallOi", "largestPutOi", "topAdds", "topCuts", "future", "gex", "zeroGamma"]));
    expect(out.data.rows[0].largestCallOi).toEqual({ strike: expect.any(Number), oi: expect.any(Number) });
    const csvOut = await r.routes.daily(ctxFor({ query: { underlying: "NIFTY", format: "csv" } }));
    expect(String(csvOut.body).split("\r\n")[0]).toMatch(/^date,underlying,expiry,asOf/);
    for (const query of [{ underlying: "NIFTY", from: "2026-10-20", to: "2026-10-19" }, { underlying: "NIFTY", from: "2020-01-01", to: "2026-10-19" }, { underlying: "NIFTY", to: "2026-13-01" }, {}]) {
      expect((await codeOf(r.routes.daily(ctxFor({ query })))).code, JSON.stringify(query)).toBe("VALIDATION_FAILED");
    }
    await r.svc.stop();
  });

  it("plan is a dry run with a plain verdict; bad bodies refused", async () => {
    const r = await recorded();
    const out = await r.routes.plan(ctxFor({ body: { indices: ["NIFTY", "BANKNIFTY"] } }));
    expect(out.data.ok).toBe(true);
    expect(out.data.message).toMatch(/^This account can carry all 1 index chain \(1 by REST\)/);
    expect(r.svc.settings().indices).toEqual(["NIFTY"]);
    expect((await codeOf(r.routes.plan(ctxFor({ body: { budgetShare: 0.9 } })))).code).toBe("VALIDATION_FAILED");
    expect((await codeOf(r.routes.plan(ctxFor({ body: [1] })))).code).toBe("VALIDATION_FAILED");
    await r.svc.stop();
  });
});

describe("POST /v1/options/recorder/plan for a restricted key", () => {
  it("hides the data and feed account ids and the broker; refuses probing an account the key cannot use", async () => {
    const PLAN_ACCOUNTS = Symbol.for("mcb.recorder.planAccounts");
    const stub = {
      async plan() {
        const out = { ok: true, message: "Upstox can carry all 1 index chain.", plan: { chains: [], refused: [], warnings: ["The live feed runs on feed-9; the recorder's account up-1 is used for REST only."] }, budget: {}, capacity: {} };
        Object.defineProperty(out, PLAN_ACCOUNTS, { value: { id: "up-1", broker: "upstox", feedAccountId: "feed-9", configured: null } });
        return out;
      },
    };
    const routes = createRecorderRoutes(stub, { clock: { now: () => IST("2026-10-19T10:00:00") }, config: {} });
    const restricted = await routes.plan(ctxFor({ accounts: ["other"], body: {} }));
    const text = JSON.stringify(restricted.data);
    expect(text).not.toMatch(/up-1|feed-9|upstox/i);
    expect(restricted.data.plan.warnings[0]).toBe("The live feed runs on (hidden account); the recorder's account (hidden account) is used for REST only.");
    expect(restricted.data.message).toBe("the broker can carry all 1 index chain.");
    // A key that may use the data account but not the feed account sees its own id only.
    const own = await routes.plan(ctxFor({ accounts: ["up-1"], body: {} }));
    expect(own.data.plan.warnings[0]).toBe("The live feed runs on (hidden account); the recorder's account up-1 is used for REST only.");
    expect((await routes.plan(ctxFor({ body: {} }))).data.plan.warnings[0]).toMatch(/feed-9/);
    // Probing another account's eligibility with a dry run is refused.
    expect((await codeOf(routes.plan(ctxFor({ accounts: ["other"], body: { account: "up-1" } })))).code).toBe("ACCOUNT_FORBIDDEN");
    expect((await routes.plan(ctxFor({ local: true, body: { account: "up-1" } }))).data.ok).toBe(true);
  });
});

describe("PUT /v1/options/recorder/config", () => {
  it("CAPACITY_EXCEEDED with canCarry when a 1/s broker is asked for 200 stocks; nothing saved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-rec-cfg-"));
    const file = join(dir, "bridge.config.json");
    writeFileSync(file, `${JSON.stringify({ accounts: [] }, null, 2)}\n`);
    const stocks = Array.from({ length: 200 }, (_, i) => `STK${i}`);
    const r = makeRecorder({ start: IST("2026-10-19T10:00:30"), accounts: [{ id: "dhan-1", broker: "dhan" }], symbols: fakeSymbols({ underlyings: ["NIFTY", ...stocks] }) });
    await r.svc.start();
    const routes = createRecorderRoutes(r.svc, { ...r.deps, paths: { configFile: file } });
    const p = await codeOf(routes.setConfig(ctxFor({ local: true, body: { stocks } })));
    expect(p).toMatchObject({ code: "CAPACITY_EXCEEDED", status: 422 });
    // Feed room 0.6 × 5,000 = 3,000: NIFTY (10 legs + 3) and 46 stocks (64 each) by stream; Dhan's 1/s chain class has no REST.
    expect(p.canCarry).toEqual({ indices: ["NIFTY"], stocks: stocks.slice(0, 46) });
    expect(p.refused).toHaveLength(154);
    expect(p.detail).toMatch(/46 of the 200 stocks you asked for \(46 by stream\)\. Nothing was saved\./);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ accounts: [] });
    expect(r.svc.settings().stocks).toEqual([]);
    await r.svc.stop();
  });

  it("an account change is planned against the NEW account (PUT and dry-run plan)", async () => {
    const r = makeRecorder({
      start: IST("2026-10-19T10:00:30"),
      accounts: [
        { id: "up-1", broker: "upstox" },
        { id: "dhan-1", broker: "dhan" },
      ],
      recorder: { account: "up-1", sources: { stream: false } },
    });
    await r.svc.start();
    const routes = createRecorderRoutes(r.svc, r.deps);
    // The current account (Upstox) carries NIFTY by REST.
    expect((await routes.plan(ctxFor({ body: {} }))).data.capacity.rest.allowed).toBe(true);
    // Dhan's chain class is 1/s: no REST, so a dry run with it reports Dhan's capacity, not Upstox's.
    const dry = await routes.plan(ctxFor({ body: { account: "dhan-1" } }));
    expect(dry.data.capacity.rest.allowed).toBe(false);
    expect(dry.data.ok).toBe(false);
    // And a PUT that switches to it is refused with 422; nothing changes.
    const p = await codeOf(routes.setConfig(ctxFor({ local: true, body: { account: "dhan-1" } })));
    expect(p).toMatchObject({ code: "CAPACITY_EXCEEDED", status: 422 });
    expect(r.svc.settings().account).toBe("up-1");
    expect(r.svc.status().warnings.join(" ")).not.toMatch(/dhan-1/);
    await r.svc.stop();
  });

  it("CONFIRMATION_REQUIRED for the NSE backup without acknowledgeNseTerms; saved with it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-rec-cfg-"));
    const file = join(dir, "bridge.config.json");
    writeFileSync(file, `${JSON.stringify({ accounts: [] })}\n`);
    const r = makeRecorder({ start: IST("2026-10-19T10:00:30"), recorder: { sources: { stream: false } } });
    await r.svc.start();
    const routes = createRecorderRoutes(r.svc, { ...r.deps, paths: { configFile: file } });
    expect((await codeOf(routes.setConfig(ctxFor({ local: true, body: { sources: { nseBackup: true } } })))).code).toBe("CONFIRMATION_REQUIRED");
    const ok = await routes.setConfig(ctxFor({ local: true, body: { sources: { nseBackup: true }, acknowledgeNseTerms: true, retentionDays: 30 } }));
    expect(ok.data.persisted).toBe(true);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.recorder).toMatchObject({ sources: { nseBackup: true }, retentionDays: 30 });
    expect(saved.recorder.acknowledgeNseTerms).toBeUndefined();
    expect(saved.accounts).toEqual([]);
    expect((await codeOf(routes.setConfig(ctxFor({ local: true, body: { retentionDays: 2 } })))).code).toBe("VALIDATION_FAILED");
    await r.svc.stop();
  });

  it("demo mode applies in memory only (persisted false)", async () => {
    const r = makeRecorder({ start: IST("2026-10-19T10:00:30"), demo: true, recorder: { sources: { stream: false }, demo: { alwaysOpen: false } } });
    await r.svc.start();
    const routes = createRecorderRoutes(r.svc, { ...r.deps, paths: { configFile: "/nonexistent/bridge.config.json" } });
    const out = await routes.setConfig(ctxFor({ local: true, body: { indexStrikes: 3 } }));
    expect(out.data.persisted).toBe(false);
    expect(out.meta.note).toMatch(/Demo mode/);
    expect(r.svc.settings().indexStrikes).toBe(3);
    await r.svc.stop();
  });
});

describe("through the real pipeline", () => {
  const READ = "mcb_read0000001_aaaaaaaaaaaaaaaaaaaa";
  const ADMIN = "mcb_admin000001_bbbbbbbbbbbbbbbbbbbb";
  const KEYS = {
    [READ]: { id: "read0000001", label: "reader", scopes: ["read"], accounts: "*" },
    [ADMIN]: { id: "admin000001", label: "admin", scopes: ["admin", "paper"], accounts: "*" },
  };
  const SPEC = readFileSync(resolve(import.meta.dirname, "../../../docs/openapi.yaml"), "utf8");
  const schemaKeys = (name) => {
    const lines = SPEC.split("\n");
    const at = lines.findIndex((l) => l === `    ${name}:`);
    const keys = [];
    for (let i = at + 1; i < lines.length && !/^ {4}\S/.test(lines[i]) && !/^\S/.test(lines[i]); i += 1) {
      const m = /^ {8}([A-Za-z][A-Za-z0-9]*):/.exec(lines[i]);
      if (m) keys.push(m[1]);
    }
    return keys;
  };
  let app;
  let port;
  const call = (method, path, { key = READ, body } = {}) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { host: `127.0.0.1:${port}` };
    if (key) headers.authorization = `Bearer ${key}`;
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload);
    }
    return new Promise((res, rej) => {
      const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          res({ status: r.statusCode, json: text ? JSON.parse(text) : null });
        });
      });
      req.on("error", rej);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  };
  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-rec-routes-"));
    const { config } = loadConfig({ raw: { server: { port: 0 }, dataDir }, env: {} });
    const bus = createEventBus();
    app = await createApp({ config, overrides: { keyStore: { ...notImplementedService("keyStore"), authenticate: async (raw) => KEYS[raw] ?? null }, accounts: createFakeAccountManager({ accounts: [], bus }) }, logger: createNullLogger() });
    ({ port } = await app.listen());
  });
  afterAll(async () => app?.close());

  it("read routes need a key; the config write needs admin", async () => {
    expect((await call("GET", "/v1/options/recorder", { key: null })).status).toBe(401);
    const st = await call("GET", "/v1/options/recorder");
    expect(st.status).toBe(200);
    expect(st.json.data).toMatchObject({ state: "not-configured", demo: false });
    expect(Object.keys(st.json.data).filter((k) => !schemaKeys("RecorderStatus").includes(k))).toEqual([]);
    const put = await call("PUT", "/v1/options/recorder/config", { body: { enabled: false } });
    expect(put.status).toBe(403);
    expect(put.json.code).toBe("SCOPE_REQUIRED");
    const ok = await call("PUT", "/v1/options/recorder/config", { key: ADMIN, body: { enabled: false } });
    expect(ok.status).toBe(200);
    expect(ok.json.data.status.state).toBe("paused");
    const snaps = await call("GET", `/v1/options/snapshots?underlying=NIFTY&expiry=${EXPIRY}`);
    expect(snaps.status).toBe(200);
    expect(Object.keys(snaps.json.data).filter((k) => !schemaKeys("OptionSnapshotPage").includes(k))).toEqual([]);
    expect(snaps.json.data.unavailable.reason).toBe("not-in-plan");
    expect((await call("GET", "/v1/options/snapshots?underlying=NIFTY")).json.code).toBe("VALIDATION_FAILED");
    expect((await call("POST", "/v1/options/recorder/plan", { body: { indexExpiries: 9 } })).status).toBe(400);
    expect((await call("GET", "/v1/options/daily?underlying=NIFTY")).json.data.rows).toEqual([]);
  });
});
