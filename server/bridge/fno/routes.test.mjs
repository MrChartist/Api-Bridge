/**
 * S19 routes through the real request pipeline (createApp, every module, HTTP on an ephemeral port): a demo Bridge
 * (universe, detail, expiry costs, the sweep with 202/200 joined/reused, settings, the demo ban route) and a non-demo
 * Bridge with no account (demo route absent, BROKER_UNAVAILABLE, NOT_FOUND). Scopes, loopback, audit rows, the §3.2
 * errors, available-false shapes and response keys against docs/openapi.yaml.
 */
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notImplementedService } from "../core/contracts.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { ROUTES, fnoFor } from "./module.mjs";

const READ = "mcb_read0000001_aaaaaaaaaaaaaaaaaaaa";
const ADMIN = "mcb_admin000001_bbbbbbbbbbbbbbbbbbbb";
const KEYS = {
  [READ]: { id: "read0000001", label: "reader", scopes: ["read"], accounts: "*" },
  [ADMIN]: { id: "admin000001", label: "admin", scopes: ["admin", "paper"], accounts: "*" },
};
const fakeKeyStore = { ...notImplementedService("keyStore"), authenticate: async (raw) => KEYS[raw] ?? null };
const SPEC = readFileSync(resolve(import.meta.dirname, "../../../docs/openapi.yaml"), "utf8");

/** Top-level property names of a components schema. */
function schemaKeys(name) {
  const lines = SPEC.split("\n");
  const at = lines.findIndex((l) => l === `    ${name}:`);
  if (at < 0) throw new Error(`schema ${name} not in docs/openapi.yaml`);
  const keys = [];
  for (let i = at + 1; i < lines.length && !/^ {4}\S/.test(lines[i]) && !/^\S/.test(lines[i]); i += 1) {
    const m = /^ {8}([A-Za-z][A-Za-z0-9]*):/.exec(lines[i]) ?? /^ {12}([A-Za-z][A-Za-z0-9]*):/.exec(lines[i]);
    if (m) keys.push(m[1]);
  }
  return keys;
}
const undocumented = (obj, ...schemas) => Object.keys(obj).filter((k) => !schemas.some((s) => schemaKeys(s).includes(k)));

function boot({ demo, raw = {} }) {
  const state = {};
  state.ready = (async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-fno-routes-"));
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
  it("ten routes, read scope except the settings write (admin, loopback)", () => {
    expect(ROUTES).toHaveLength(10);
    const put = ROUTES.find(([m, p]) => m === "PUT" && p === "/v1/options/sweeps/settings");
    expect(put[2]).toEqual({ scope: "admin", loopbackOnly: true });
    for (const r of ROUTES.filter((x) => x !== put)) expect(r[2].scope).toBe("read");
  });
});

describe("demo Bridge", () => {
  const h = boot({ demo: true, raw: { fno: { demo: { callDelayMs: 0 }, sweep: { hv: { source: "off" } } } } });
  beforeAll(() => h.ready, 30_000);
  afterAll(() => h.app?.close());

  it("GET /v1/options/underlyings: indices and 50 stocks with facts; keys documented", async () => {
    const r = await h.call("GET", "/v1/options/underlyings");
    expect(r.status).toBe(200);
    const d = r.json.data;
    expect(d.counts.stock).toBe(50);
    expect(d.counts.index).toBeGreaterThanOrEqual(3);
    expect(d.items.slice(0, d.counts.index).every((i) => i.kind === "index")).toBe(true);
    const rel = d.items.find((i) => i.underlying === "RELIANCE");
    expect(rel).toMatchObject({ kind: "stock", settlement: "physical", lot: 525, strikeStep: 20, spot: "NSE:RELIANCE" });
    expect(d.items.find((i) => i.underlying === "TATASTEEL").strikeStep).toBe(2.5);
    expect(d.counts.inBan).toBeGreaterThanOrEqual(2);
    expect(undocumented(d, "FnoUnderlyingList")).toEqual([]);
    expect(undocumented(rel, "FnoUnderlying")).toEqual([]);
    const q = await h.call("GET", "/v1/options/underlyings?q=rel&kind=stock");
    expect(q.json.data.items[0].underlying).toBe("RELIANCE");
    expect((await h.call("GET", "/v1/options/underlyings?kind=bond")).json.code).toBe("VALIDATION_FAILED");
    const wq = await h.call("GET", "/v1/options/underlyings?kind=index&withQuotes=1");
    expect(wq.json.data.quotes.loaded).toBe(true);
    expect(wq.json.data.items[0].quote.ltp).toBeGreaterThan(0);
  });

  it("GET /v1/options/underlyings/{u}: expiries, delivery schedule, adjusted contracts; index cash settled; 404", async () => {
    const r = await h.call("GET", "/v1/options/underlyings/reliance");
    expect(r.status).toBe(200);
    expect(r.json.data.expiries).toHaveLength(3);
    expect(r.json.data.deliveryMargin.items.map((x) => x.day)).toEqual(["E-4", "E-3", "E-2", "E-1"]);
    expect(r.json.data.rules).toContain("European exercise; physically settled.");
    const nifty = await h.call("GET", "/v1/options/underlyings/NIFTY");
    expect(nifty.json.data.deliveryMargin).toEqual({ available: false, reason: "INDEX_CASH_SETTLED" });
    const missing = await h.call("GET", "/v1/options/underlyings/NOSUCH");
    expect([missing.status, missing.json.code]).toEqual([404, "SYMBOL_NOT_FOUND"]);
    const split = (await h.call("GET", "/v1/options/underlyings")).json.data.items.filter((i) => i.nonStandard && i.kind === "stock");
    expect(split.length).toBeGreaterThanOrEqual(1);
    const adj = await h.call("GET", `/v1/options/underlyings/${split[0].underlying}`);
    expect(adj.json.data.nonStandardContracts.length).toBeGreaterThanOrEqual(1);
  });

  it("POST /v1/options/expiry-costs: §6.6 figures; validation errors", async () => {
    const detail = (await h.call("GET", "/v1/options/underlyings/RELIANCE")).json.data;
    const exp = detail.expiries[0].date;
    const asOf = detail.deliveryMargin.items.find((x) => x.day === "E-2").date;
    // a listed strike near the demo spot, then the §6.6 numbers on a 1420-style leg: K = listed strike, spot = K + 32.30
    const chain = (await h.call("GET", `/v1/optionchain?underlying=RELIANCE&expiry=${exp}&strikes=2`)).json.data;
    const K = chain.rows[0].strike;
    const r = await h.call("POST", "/v1/options/expiry-costs", { body: { underlying: "RELIANCE", asOf, spot: K + 32.3, varElmPct: 20, legs: [{ symbol: `NFO:RELIANCE-${exp}-${K}-CE`, qty: 500, bid: 33.8, ask: 34.2 }] } });
    expect(r.status).toBe(200);
    const leg = r.json.data.legs[0];
    expect(r.json.data).toMatchObject({ day: "E-2", inWindow: true, settlement: "physical" });
    expect(leg.moneyness).toBe("ITM");
    expect(leg.squareOff.total).toBe(55.96);
    expect(leg.settle.total).toBeCloseTo(842.22 * (K / 1420), 1);
    expect(undocumented(r.json.data, "ExpiryCostsResult")).toEqual([]);
    const bad = [
      [{ underlying: "RELIANCE", legs: [] }, "legs"],
      [{ underlying: "RELIANCE", legs: Array.from({ length: 41 }, () => ({ symbol: "NFO:X", qty: 1 })) }, "legs"],
      [{ underlying: "RELIANCE", asOf: "19-11-2026", legs: [{ symbol: "NFO:X", qty: 1 }] }, "asOf"],
      [{ underlying: "RELIANCE", varElmPct: 0.5, legs: [{ symbol: "NFO:X", qty: 1 }] }, "varElmPct"],
    ];
    for (const [body, path] of bad) {
      const e = await h.call("POST", "/v1/options/expiry-costs", { body });
      expect([e.status, e.json.code, e.json.errors?.[0]?.path]).toEqual([400, "VALIDATION_FAILED", path]);
    }
    const notOpt = await h.call("POST", "/v1/options/expiry-costs", { body: { underlying: "RELIANCE", legs: [{ symbol: "NSE:RELIANCE", qty: 1 }] } });
    expect(notOpt.status).toBe(400);
  });

  // The demo chain class has a 32-a-minute window (the recorder work) and background calls keep half of it free,
  // so after the earlier tests' chain reads the index chains can wait for the minute to roll over.
  it("sweeps: plan, start 202, join 200, chains pages, reuse, cancel; NOT_FOUND before; keys documented", async () => {
    const plan = await h.call("POST", "/v1/options/sweeps/plan", { body: {} });
    expect(plan.status).toBe(200);
    expect(plan.json.data).toMatchObject({ fits: true, account: { id: "demo", broker: "demo" } });
    expect(plan.json.data.groups.map((g) => g.method)).toEqual(["chain", "quotes"]);
    expect(undocumented(plan.json.data, "SweepPlan")).toEqual([]);
    const forced = await h.call("POST", "/v1/options/sweeps/plan", { body: { method: "nope" } });
    expect(forced.json.code).toBe("VALIDATION_FAILED");
    const a = await h.call("POST", "/v1/options/sweeps", { body: {} });
    expect(a.status).toBe(202);
    const b = await h.call("POST", "/v1/options/sweeps", { body: {} });
    expect([b.status, b.json.data.joined, b.json.data.id]).toEqual([200, true, a.json.data.id]);
    expect(undocumented(a.json.data, "SweepJob")).toEqual([]);
    const f = fnoFor(h.app.deps);
    await f.sweeper.idle();
    const cur = await h.call("GET", "/v1/options/sweeps/current?lease=1");
    expect(cur.json.data.status).toBe("done");
    expect(cur.json.data.lease.until).not.toBeNull();
    let since = 0;
    const items = [];
    for (let i = 0; i < 10; i += 1) {
      const p = await h.call("GET", `/v1/options/sweeps/current/chains?since=${since}&limit=40`);
      items.push(...p.json.data.items);
      since = p.json.data.nextCursor;
      if (p.json.data.done) break;
    }
    expect(items.length).toBe(cur.json.data.progress.total);
    const q = items.find((x) => x.method === "quotes");
    expect(q.chain.rows.some((r) => r.ce?.oiChangeBasis === "day-baseline")).toBe(true);
    expect((await h.call("GET", "/v1/options/sweeps/current/chains?limit=41")).json.code).toBe("VALIDATION_FAILED");
    const c = await h.call("POST", "/v1/options/sweeps", { body: {} });
    expect([c.status, c.json.data.reused]).toEqual([200, true]);
    const del = await h.call("DELETE", "/v1/options/sweeps/current");
    expect(del.status).toBe(200);
  }, 120_000);

  it("settings: admin from this computer, audited; read key refused; proxied refused; demo applies in memory", async () => {
    const ro = await h.call("PUT", "/v1/options/sweeps/settings", { body: { optIn: ["RELIANCE"] } });
    expect([ro.status, ro.json.code]).toEqual([403, "SCOPE_REQUIRED"]);
    const proxied = await h.call("PUT", "/v1/options/sweeps/settings", { key: ADMIN, body: { optIn: ["RELIANCE"] }, headers: { "x-forwarded-for": "198.51.100.7" } });
    expect(proxied.json.code).toBe("LOOPBACK_ONLY");
    const ok = await h.call("PUT", "/v1/options/sweeps/settings", { key: ADMIN, body: { optIn: ["RELIANCE", "sbin"], background: false } });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ optIn: ["RELIANCE", "SBIN"], persisted: false });
    const unknown = await h.call("PUT", "/v1/options/sweeps/settings", { key: ADMIN, body: { optIn: ["NOPE"] } });
    expect([unknown.status, unknown.json.code]).toEqual([400, "VALIDATION_FAILED"]);
    expect((await h.call("GET", "/v1/options/sweeps/settings")).json.data.optIn).toEqual(["RELIANCE", "SBIN"]);
    const audit = await h.app.deps.audit.query({ limit: 50 });
    expect((audit.items ?? audit.data ?? audit).map((x) => x.type)).toContain("fno.settings.updated");
  });

  it("POST /v1/demo/fno forces a ban (admin, loopback) and the list shows it", async () => {
    const ro = await h.call("POST", "/v1/demo/fno", { body: { ban: ["RELIANCE"] } });
    expect(ro.status).toBe(403);
    const ok = await h.call("POST", "/v1/demo/fno", { key: ADMIN, body: { ban: ["RELIANCE"], minutes: 5 } });
    expect(ok.json.data).toMatchObject({ ban: ["RELIANCE"], source: "demo-override" });
    const rel = (await h.call("GET", "/v1/options/underlyings?q=RELIANCE")).json.data.items[0];
    expect(rel.ban).toMatchObject({ inBan: true, band: "ban", source: "demo-override" });
    await h.call("POST", "/v1/demo/fno", { key: ADMIN, body: { ban: [] } });
    expect((await h.call("GET", "/v1/options/underlyings?q=RELIANCE")).json.data.items[0].ban.source).toBeUndefined();
  });
});

describe("non-demo Bridge without accounts", () => {
  const h = boot({ demo: false });
  beforeAll(() => h.ready, 30_000);
  afterAll(() => h.app?.close());

  it("no demo route; no sweep today is NOT_FOUND; planning without an account is BROKER_UNAVAILABLE; the list is empty, not an error", async () => {
    expect((await h.call("POST", "/v1/demo/fno", { key: ADMIN, body: { ban: [] } })).status).toBe(404);
    const cur = await h.call("GET", "/v1/options/sweeps/current");
    expect([cur.status, cur.json.code]).toEqual([404, "NOT_FOUND"]);
    const plan = await h.call("POST", "/v1/options/sweeps/plan", { body: {} });
    expect([plan.status, plan.json.code]).toEqual([503, "BROKER_UNAVAILABLE"]);
    const list = await h.call("GET", "/v1/options/underlyings");
    expect(list.status).toBe(200);
    expect(list.json.data.items).toEqual([]);
  });
});
