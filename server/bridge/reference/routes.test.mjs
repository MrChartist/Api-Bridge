/**
 * S16 routes end to end through the real request pipeline (createApp, every module, HTTP on an ephemeral port):
 * a demo Bridge (every dataset, the corporate-action calculator, writes with audit) and a fresh non-demo Bridge
 * (archives off: available false with reasons, no fetch). Checks scopes, loopback, demo refusals, problem codes and
 * that response fields are documented in docs/openapi.yaml.
 */
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { notImplementedService } from "../core/contracts.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { ROUTES } from "./module.mjs";

const READ = "mcb_read0000001_aaaaaaaaaaaaaaaaaaaa";
const ADMIN = "mcb_admin000001_bbbbbbbbbbbbbbbbbbbb";
const KEYS = {
  [READ]: { id: "read0000001", label: "reader", scopes: ["read"], accounts: "*" },
  [ADMIN]: { id: "admin000001", label: "admin", scopes: ["admin", "paper"], accounts: "*" },
};
const fakeKeyStore = { ...notImplementedService("keyStore"), authenticate: async (raw) => KEYS[raw] ?? null };
const SPEC = readFileSync(resolve(import.meta.dirname, "../../../docs/openapi.yaml"), "utf8");

/** Top-level property names of a components schema (the YAML's disciplined layout). */
function schemaKeys(name) {
  const lines = SPEC.split("\n");
  const at = lines.findIndex((l) => l === `    ${name}:`);
  if (at < 0) throw new Error(`schema ${name} not in docs/openapi.yaml`);
  const keys = [];
  for (let i = at + 1; i < lines.length && !/^ {4}\S/.test(lines[i]) && !/^\S/.test(lines[i]); i += 1) {
    const m = /^ {8}([A-Za-z][A-Za-z0-9]*):/.exec(lines[i]);
    if (m) keys.push(m[1]);
  }
  return keys;
}
const undocumented = (obj, schema) => Object.keys(obj).filter((k) => !schemaKeys(schema).includes(k));

function boot({ demo, raw = {} }) {
  const state = {};
  state.ready = (async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-ref-routes-"));
    const { config } = loadConfig({ raw: { server: { port: 0 }, dataDir, ...raw }, env: {}, demo });
    state.app = await createApp({ config, overrides: { keyStore: fakeKeyStore }, logger: createNullLogger() });
    ({ port: state.port } = await state.app.listen());
  })();
  state.call = (method, path, { key = READ, body, headers: extra = {} } = {}) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { host: `127.0.0.1:${state.port}`, ...extra };
    if (key) headers.authorization = `Bearer ${key}`;
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload);
    }
    return new Promise((res, rej) => {
      const req = http.request({ host: "127.0.0.1", port: state.port, method, path, headers }, (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          res({ status: r.statusCode, json });
        });
      });
      req.on("error", rej);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  };
  return state;
}

describe("route table", () => {
  it("20 operations: reads need read; the five writes need admin from this computer", () => {
    expect(ROUTES).toHaveLength(20);
    const writes = ROUTES.filter(([, , o]) => o.scope === "admin").map(([m, p, o]) => [m, p, o.loopbackOnly]);
    expect(writes).toEqual([
      ["POST", "/v1/reference/corporate-actions", true],
      ["DELETE", "/v1/reference/corporate-actions/:id", true],
      ["PUT", "/v1/reference/rate", true],
      ["PUT", "/v1/reference/sources", true],
      ["POST", "/v1/reference/sync", true],
    ]);
    expect(ROUTES.filter(([, , o]) => o.scope === "read")).toHaveLength(15);
  });
});

describe("demo Bridge", () => {
  const h = boot({ demo: true });
  beforeAll(() => h.ready);
  afterAll(() => h.app?.close());

  it("status: every dataset available from the demo source", async () => {
    const r = await h.call("GET", "/v1/reference/status");
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ demo: true, sources: { nseArchives: { enabled: false } } });
    for (const name of ["lots", "universe", "ban", "mwpl", "holidays", "corporateActions"]) expect(r.json.data.datasets[name], name).toMatchObject({ available: true, source: "demo" });
    expect(undocumented(r.json.data, "RefStatus")).toEqual([]);
  });

  it("bundle NIFTY: lot 65, the 6.50 % default rate (not sourced), session, holidays, expiries with the holiday shift", async () => {
    const r = await h.call("GET", "/v1/reference/bundle?underlying=NIFTY");
    expect(r.status).toBe(200);
    const b = r.json.data;
    expect(b).toMatchObject({ underlying: "NIFTY", exchange: "NFO", kind: "index", lots: { current: 65, stale: false }, rate: { value: 0.065, source: "default (not sourced)", quality: "default" } });
    expect(b.warnings).toContain("Rate is the 6.50 % default, not sourced.");
    expect(b.expiries.every((e) => e.lot === 65)).toBe(true);
    expect(b.session).toMatchObject({ open: "09:15", close: "15:30" });
    expect(b.freeze).toMatchObject({ freezeQty: 1800, source: "exchange-list", verified: false });
    expect(undocumented(b, "RefBundle")).toEqual([]);
    expect(undocumented(b.session, "RefSession")).toEqual([]);
  });

  it("bundle for a stock has ban/MWPL and the delivery-margin schedule; demoStale=1 reports stale lots", async () => {
    const s = (await h.call("GET", "/v1/reference/bundle?underlying=RELIANCE")).json.data;
    expect(s).toMatchObject({ kind: "stock", lots: { current: 525 } });
    expect(s.ban).toMatchObject({ band: expect.stringMatching(/^(ban|high|normal)$/), source: "demo" });
    expect(s.deliveryMargin.items.map((i) => i.day)).toEqual(["E-4", "E-3", "E-2", "E-1"]);
    const stale = (await h.call("GET", "/v1/reference/bundle?underlying=NIFTY&demoStale=1")).json.data;
    expect(stale.lots).toMatchObject({ stale: true, staleTradingDays: 2 });
  });

  it("bundle errors: missing or bad underlying (400), unknown underlying (404)", async () => {
    expect((await h.call("GET", "/v1/reference/bundle")).json.code).toBe("VALIDATION_FAILED");
    expect((await h.call("GET", "/v1/reference/bundle?underlying=NIFTY%2050")).status).toBe(400);
    expect((await h.call("GET", "/v1/reference/bundle?underlying=NIFTY&exchange=MCX")).status).toBe(400);
    const nf = await h.call("GET", "/v1/reference/bundle?underlying=NOSUCHU");
    expect(nf.status).toBe(404);
    expect(nf.json.code).toBe("SYMBOL_NOT_FOUND");
  });

  it("events within 7 days include a corporate action; days is 1-30", async () => {
    const r = await h.call("GET", "/v1/reference/events?days=7");
    expect(r.json.data.items.some((e) => e.kind === "corporate-action")).toBe(true);
    expect((await h.call("GET", "/v1/reference/events?days=31")).status).toBe(400);
  });

  it("ban list has 2-3 symbols; MWPL by symbol; universe before knownSince is not recorded", async () => {
    const ban = (await h.call("GET", "/v1/reference/ban")).json.data;
    expect(ban.available).toBe(true);
    expect(ban.items.length).toBeGreaterThanOrEqual(2);
    expect(ban.items.length).toBeLessThanOrEqual(3);
    expect(undocumented(ban, "RefBan")).toEqual([]);
    const mw = (await h.call("GET", `/v1/reference/mwpl?symbol=${ban.items[0].symbol}`)).json.data;
    expect(mw.items).toHaveLength(1);
    expect(mw.items[0].band).toBe("ban");
    const u = (await h.call("GET", "/v1/reference/fno-universe?date=2020-01-01")).json.data;
    expect(u).toMatchObject({ coverage: "not-recorded", items: [] });
    const now = (await h.call("GET", "/v1/reference/fno-universe?kind=stock")).json.data;
    expect(now.count).toBe(50);
    expect(undocumented(now, "RefUniverse")).toEqual([]);
  });

  it("corporate-action preview: example 1 gives strikes 1,400/1,410 and lot 500 (AC5)", async () => {
    const r = await h.call("POST", "/v1/reference/corporate-actions/preview", { body: { type: "bonus", ratio: { new: 1, held: 1 }, lot: 250, strikes: [2800, 2820] } });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ factor: 2, lotAfter: 500, strikes: [{ before: 2800, after: 1400 }, { before: 2820, after: 1410 }] });
    expect((await h.call("POST", "/v1/reference/corporate-actions/preview", { body: { type: "bonus", ratio: { new: 0, held: 1 } } })).status).toBe(400);
  });

  it("other reads: expiries, sessions, holidays (range), lots, actions, rate, charges, delivery margin", async () => {
    const ex = (await h.call("GET", "/v1/reference/expiries?underlying=BANKNIFTY")).json.data;
    expect(ex.expiries[0]).toMatchObject({ kind: "monthly", lot: 30 });
    expect(undocumented(ex, "RefExpiries")).toEqual([]);
    const ses = (await h.call("GET", "/v1/reference/sessions?date=2026-11-24&exchange=NFO")).json.data;
    expect(ses).toMatchObject({ state: "HOLIDAY", tradingDay: false, holiday: { verified: true } });
    const hol = (await h.call("GET", "/v1/reference/holidays?from=2026-01-01&to=2026-12-31&exchange=NSE")).json.data;
    expect(hol.items.length).toBeGreaterThan(10);
    // Special sessions in the range come with the holidays (one request per month on the Market calendar page).
    expect(hol.specialSessions).toEqual(expect.arrayContaining([expect.objectContaining({ date: "2026-11-08", open: "18:00", close: "19:00" })]));
    expect(undocumented(hol, "RefHolidays")).toEqual([]);
    expect((await h.call("GET", "/v1/reference/holidays?from=2026-01-01&to=2027-06-30")).status).toBe(400);
    expect((await h.call("GET", "/v1/reference/holidays?from=2026-12-31&to=2026-01-01")).status).toBe(400);
    const lots = (await h.call("GET", "/v1/reference/lots?underlying=NIFTY")).json.data;
    expect(lots).toMatchObject({ current: 65, freeze: { freezeQty: 1800 } });
    expect(undocumented(lots, "RefLots")).toEqual([]);
    expect((await h.call("GET", "/v1/reference/lots?underlying=NOSUCHU")).status).toBe(404);
    const acts = (await h.call("GET", "/v1/reference/corporate-actions?origin=inferred")).json.data;
    expect(acts.items[0]).toMatchObject({ origin: "inferred", nonStandard: true });
    expect((await h.call("GET", "/v1/reference/corporate-actions?origin=nope")).status).toBe(400);
    expect((await h.call("GET", "/v1/reference/rate")).json.data).toMatchObject({ value: 0.065, quality: "default", stale: true });
    expect((await h.call("GET", "/v1/reference/charges")).json.data.brokerage).toMatchObject({ kind: "flat", perOrder: 20 });
    const idx = (await h.call("GET", "/v1/reference/delivery-margin?underlying=NIFTY&expiry=2026-11-23")).json.data;
    expect(idx).toMatchObject({ available: false, reason: "INDEX_CASH_SETTLED" });
    const stock = (await h.call("GET", "/v1/reference/delivery-margin?underlying=RELIANCE&expiry=2026-11-23")).json.data;
    expect(stock.items).toEqual([
      { day: "E-4", date: "2026-11-17", pct: 10 },
      { day: "E-3", date: "2026-11-18", pct: 25 },
      { day: "E-2", date: "2026-11-19", pct: 45 },
      { day: "E-1", date: "2026-11-20", pct: 70 },
    ]);
  });

  it("GET /v1/expiries keeps its shape (back-compat)", async () => {
    const r = await h.call("GET", "/v1/expiries?underlying=NIFTY");
    expect(r.status).toBe(200);
    expect(Object.keys(r.json.data).sort()).toEqual(["expiries", "freshness", "underlying"].sort());
  });

  it("demo mode never downloads: PUT /sources and POST /sync answer 422", async () => {
    const s = await h.call("PUT", "/v1/reference/sources", { key: ADMIN, body: { nseArchives: true } });
    expect(s.status).toBe(422);
    expect(s.json.code).toBe("CAPABILITY_UNSUPPORTED");
    expect((await h.call("POST", "/v1/reference/sync", { key: ADMIN, body: {} })).status).toBe(422);
  });

  it("writes need admin from this computer; PUT /rate and corporate actions are stored and audited", async () => {
    const rateBody = { value: 0.0571, asOf: "2026-10-28", source: "91-day T-bill cut-off, RBI auction" };
    const ro = await h.call("PUT", "/v1/reference/rate", { body: rateBody });
    expect(ro.status).toBe(403);
    expect(ro.json.code).toBe("SCOPE_REQUIRED");
    const proxied = await h.call("PUT", "/v1/reference/rate", { key: ADMIN, body: rateBody, headers: { "x-forwarded-for": "198.51.100.7" } });
    expect(proxied.status).toBe(403);
    expect(proxied.json.code).toBe("LOOPBACK_ONLY");
    const ok = await h.call("PUT", "/v1/reference/rate", { key: ADMIN, body: rateBody });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ value: 0.0571, quality: "user", setBy: "dashboard" });
    expect((await h.call("PUT", "/v1/reference/rate", { key: ADMIN, body: { value: 5.71, source: "percent" } })).status).toBe(400);

    const action = { symbol: "TCS", type: "split", fv: { from: 10, to: 2 }, exDate: "2027-01-15", source: "my note" };
    const added = await h.call("POST", "/v1/reference/corporate-actions", { key: ADMIN, body: action });
    expect(added.status).toBe(201);
    expect(added.json.data).toMatchObject({ symbol: "TCS", factor: 5, origin: "user", verified: true });
    expect((await h.call("POST", "/v1/reference/corporate-actions", { key: ADMIN, body: action })).status).toBe(400);
    expect((await h.call("POST", "/v1/reference/corporate-actions", { key: ADMIN, body: { ...action, exDate: "2027-01-16", factor: 99 } })).status).toBe(400);
    const listed = (await h.call("GET", "/v1/reference/corporate-actions?symbol=TCS&origin=user")).json.data.items;
    expect(listed.map((a) => a.id)).toEqual([added.json.data.id]);
    expect((await h.call("DELETE", `/v1/reference/corporate-actions/${added.json.data.id}`, { key: ADMIN })).status).toBe(204);
    expect((await h.call("DELETE", `/v1/reference/corporate-actions/${added.json.data.id}`, { key: ADMIN })).status).toBe(404);
    expect((await h.call("DELETE", "/v1/reference/corporate-actions/ca_RELIANCE_2024-10-28_bonus", { key: ADMIN })).status).toBe(404);

    // The add form's previewed strikes are stored, and the listed row's example uses exactly those strikes.
    const bonus = { symbol: "RELIANCE", type: "bonus", ratio: { new: 1, held: 1 }, exDate: "2026-11-12", exampleStrikes: [1520, 1480, 1500, 1540, 1560] };
    const preview = (await h.call("POST", "/v1/reference/corporate-actions/preview", { body: { type: "bonus", ratio: { new: 1, held: 1 }, strikes: [1480, 1500, 1520, 1540, 1560] } })).json.data;
    const saved = await h.call("POST", "/v1/reference/corporate-actions", { key: ADMIN, body: bonus });
    expect(saved.status).toBe(201);
    expect(saved.json.data.exampleStrikes).toEqual([1480, 1500, 1520, 1540, 1560]);
    const row = (await h.call("GET", "/v1/reference/corporate-actions?symbol=RELIANCE&origin=user")).json.data.items[0];
    expect(row.adjusted.exampleStrikes).toEqual(preview.strikes);
    expect((await h.call("POST", "/v1/reference/corporate-actions", { key: ADMIN, body: { ...bonus, exDate: "2026-11-13", exampleStrikes: [-1] } })).status).toBe(400);

    const audit = await h.app.deps.audit.query({ limit: 50 });
    const types = (audit.items ?? audit.data ?? audit).map((r) => r.type);
    expect(types).toEqual(expect.arrayContaining(["reference.rate.set", "reference.corporate_action.added", "reference.corporate_action.deleted"]));
  });
});

describe("fresh non-demo Bridge (archives off)", () => {
  const h = boot({ demo: false });
  const fetchSpy = vi.fn(async () => {
    throw new Error("no network in tests");
  });
  beforeAll(async () => {
    vi.stubGlobal("fetch", fetchSpy);
    await h.ready;
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await h.app?.close();
  });

  it("status says the source is off; datasets answer available: false with a reason", async () => {
    const st = (await h.call("GET", "/v1/reference/status")).json.data;
    expect(st).toMatchObject({ demo: false, sources: { nseArchives: { enabled: false, setBy: "default" } } });
    expect(st.datasets.ban).toMatchObject({ available: false, reason: "SOURCE_OFF" });
    expect(st.datasets.holidays).toMatchObject({ available: true, verified: true });
    expect(st.datasets.rate).toMatchObject({ quality: "default", stale: true });
    expect((await h.call("GET", "/v1/reference/ban")).json.data).toMatchObject({ available: false, reason: "SOURCE_OFF", items: [] });
    expect((await h.call("GET", "/v1/reference/mwpl")).json.data).toMatchObject({ available: false, reason: "SOURCE_OFF" });
    expect((await h.call("GET", "/v1/reference/fno-universe")).json.data).toMatchObject({ coverage: "not-recorded", available: false, reason: "SOURCE_OFF" });
  });

  it("no master loaded: bundle is 404; sessions and holidays still answer", async () => {
    expect((await h.call("GET", "/v1/reference/bundle?underlying=NIFTY")).status).toBe(404);
    expect((await h.call("GET", "/v1/reference/sessions?date=2026-11-24")).json.data).toMatchObject({ state: "HOLIDAY", holiday: { verified: true } });
  });

  it("a sync with archives off records SOURCE_OFF and makes zero fetch calls", async () => {
    const r = await h.call("POST", "/v1/reference/sync", { key: ADMIN, body: { datasets: ["lots", "ban"] } });
    expect(r.status).toBe(202);
    expect(r.json.data).toMatchObject({ jobId: expect.stringMatching(/^refsync_/), datasets: ["lots", "ban"] });
    for (let i = 0; i < 50 && h.app.deps.reference.syncRunning(); i += 1) await new Promise((res) => setTimeout(res, 10));
    expect((await h.call("GET", "/v1/reference/status")).json.data.datasets.lots.error).toMatchObject({ code: "SOURCE_OFF" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await h.call("POST", "/v1/reference/sync", { key: ADMIN, body: { datasets: ["quotes"] } })).status).toBe(400);
  });

  it("PUT /sources records the choice (admin, loopback) and is audited", async () => {
    const r = await h.call("PUT", "/v1/reference/sources", { key: ADMIN, body: { nseArchives: false } });
    expect(r.status).toBe(200);
    expect(r.json.data.nseArchives).toMatchObject({ enabled: false, setBy: "dashboard" });
    expect((await h.call("PUT", "/v1/reference/sources", { key: ADMIN, body: { nseArchives: "yes" } })).status).toBe(400);
    const audit = await h.app.deps.audit.query({ limit: 50 });
    expect((audit.items ?? audit.data ?? audit).map((x) => x.type)).toContain("reference.sources.set");
  });
});
