/**
 * Reference data end to end (docs/spec/p1-02-reference.md §9.5): a real demo Bridge (every module, HTTP on an
 * ephemeral port) with reference.blockLotsWhenStale on. Walks status → bundle → events → ban → corporate-action
 * preview (acceptance criterion 5) → rate write (admin only) → stale lots (demo switch and ?demoStale=1) →
 * LOT_SIZE_STALE in the order preview and lotSizeConfirmed clearing it (acceptance criterion 4) → demo refusals →
 * /v1/expiries unchanged → the dashboard serves the new modules. A second, non-demo Bridge with archives off proves
 * that nothing is fetched; a third, with archives on and a fake fetch serving the fixtures, syncs the market-lots file
 * (lot history, F&O universe intervals) and then a revised file (the lot-revision event).
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { istInstant } from "../reference/calendar.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";

const READ = "mcb_e2eread0001_aaaaaaaaaaaaaaaaaaaa";
const ADMIN = "mcb_e2eadmin001_bbbbbbbbbbbbbbbbbbbb";
const KEYS = {
  [READ]: { id: "e2eread0001", label: "reader", scopes: ["read"], accounts: "*" },
  [ADMIN]: { id: "e2eadmin001", label: "admin", scopes: ["admin", "paper"], accounts: "*" },
};
const keyStore = { ...notImplementedService("keyStore"), authenticate: async (raw) => KEYS[raw] ?? null };

async function boot({ demo, raw = {}, overrides = {}, clock }) {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-ref-e2e-"));
  const { config } = loadConfig({ raw: { dataDir, server: { port: 0 }, logging: { level: "silent" }, ...raw }, env: {}, demo });
  const app = await createApp({ config, overrides: { keyStore, ...overrides }, logger: createNullLogger(), clock });
  const { port } = await app.listen();
  // node:http, not fetch: the non-demo Bridge below runs with fetch stubbed (to prove it downloads nothing).
  const http = (path, { method = "GET", key = READ, body } = {}) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers = { host: `127.0.0.1:${port}` };
      if (key) headers.authorization = `Bearer ${key}`;
      if (payload !== undefined) {
        headers["content-type"] = "application/json";
        headers["content-length"] = Buffer.byteLength(payload);
      }
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode, json, text, headers: new Headers(Object.entries(res.headers).map(([k, v]) => [k, String(v)])) });
        });
      });
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  return { app, http, close: () => app.close() };
}

describe("reference data on a demo Bridge", () => {
  let b;
  let option;
  beforeAll(async () => {
    b = await boot({ demo: true, raw: { reference: { blockLotsWhenStale: true } } });
    const ex = (await b.http("/v1/expiries?underlying=NIFTY")).json.data.expiries;
    const chain = (await b.http(`/v1/optionchain?underlying=NIFTY&expiry=${ex[0]}&strikes=2`)).json.data;
    option = chain.rows.find((r) => r.ce?.symbol)?.ce.symbol;
  });
  afterAll(async () => {
    await b?.close();
  });

  it("status: every dataset available from the demo source", async () => {
    const st = (await b.http("/v1/reference/status")).json.data;
    expect(st.demo).toBe(true);
    for (const d of ["lots", "universe", "ban", "mwpl", "holidays", "corporateActions"]) expect(st.datasets[d], d).toMatchObject({ available: true, source: "demo" });
  });

  it("bundle for NIFTY: session, lot 65, holidays and the 6.50 % default rate, said to be unsourced", async () => {
    const d = (await b.http("/v1/reference/bundle?underlying=NIFTY")).json.data;
    expect(d.session).toMatchObject({ open: expect.stringMatching(/^\d\d:\d\d$/), close: expect.stringMatching(/^\d\d:\d\d$/) });
    expect(d.lots).toMatchObject({ current: 65, stale: false });
    expect(d.holidays.length).toBeGreaterThan(0);
    expect(d.rate).toMatchObject({ value: 0.065, quality: "default" });
    expect(d.warnings.join(" ")).toMatch(/default, not sourced/);
  });

  it("events within 7 days include a corporate action (the banner, acceptance criterion 3)", async () => {
    const items = (await b.http("/v1/reference/events?days=7")).json.data.items;
    const ca = items.find((e) => e.kind === "corporate-action");
    expect(ca).toBeTruthy();
    expect(ca.daysAway).toBeGreaterThanOrEqual(0);
    expect(ca.daysAway).toBeLessThanOrEqual(7);
    expect(ca.text).not.toMatch(/\b(avoid|safe|opportunity|buy|sell)\b/i);
  });

  it("ban list has 2-3 symbols", async () => {
    const d = (await b.http("/v1/reference/ban")).json.data;
    expect(d.available).toBe(true);
    expect(d.items.length).toBeGreaterThanOrEqual(2);
    expect(d.items.length).toBeLessThanOrEqual(3);
  });

  it("corporate-action preview, example 1 (1:1 bonus): strikes 1,400 / 1,410 and lot 500 (acceptance criterion 5)", async () => {
    const r = await b.http("/v1/reference/corporate-actions/preview", { method: "POST", body: { type: "bonus", ratio: { new: 1, held: 1 }, lot: 250, strikes: [2800, 2820, 2830] } });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ factor: 2, lotAfter: 500 });
    expect(r.json.data.strikes.map((s) => s.after)).toEqual([1400, 1410, 1415]);
  });

  it("PUT /rate: admin from this computer 200, a read key 403", async () => {
    const body = { value: 0.0571, asOf: "2026-10-28", source: "91-day T-bill cut-off, RBI auction" };
    expect((await b.http("/v1/reference/rate", { method: "PUT", body })).status).toBe(403);
    const r = await b.http("/v1/reference/rate", { method: "PUT", key: ADMIN, body });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ value: 0.0571, source: body.source });
    expect((await b.http("/v1/reference/bundle?underlying=NIFTY")).json.data.rate).toMatchObject({ value: 0.0571, quality: "user" });
  });

  it("?demoStale=1 reports the lots as stale on the bundle only", async () => {
    expect((await b.http("/v1/reference/bundle?underlying=NIFTY&demoStale=1")).json.data.lots).toMatchObject({ stale: true, staleTradingDays: 2 });
    expect((await b.http("/v1/reference/bundle?underlying=NIFTY")).json.data.lots.stale).toBe(false);
  });

  it("stale lots: LOT_SIZE_STALE blocks an order in lots; lotSizeConfirmed clears it; quantity is never checked (criterion 4)", async () => {
    expect(option).toMatch(/^NFO:NIFTY-/);
    const order = { account: "demo-paper", symbol: option, side: "BUY", orderType: "MARKET", product: "INTRADAY" };
    const codes = (r) => (r.json.data.checks ?? []).map((c) => `${c.code}:${c.severity}`);
    // Current lots: no check.
    expect(codes(await b.http("/v1/orders/preview", { method: "POST", key: ADMIN, body: { ...order, lots: 1 } }))).not.toContain("LOT_SIZE_STALE:block");
    // The demo switch (admin, demo only) makes the reference lots two trading days old.
    expect((await b.http("/v1/demo/reference", { method: "PUT", body: { lotsStale: true } })).status).toBe(403);
    expect((await b.http("/v1/demo/reference", { method: "PUT", key: ADMIN, body: { lotsStale: "yes" } })).status).toBe(400);
    expect((await b.http("/v1/demo/reference", { method: "PUT", key: ADMIN, body: { lotsStale: true } })).json.data).toEqual({ lotsStale: true });
    expect((await b.http("/v1/reference/bundle?underlying=NIFTY")).json.data.lots).toMatchObject({ stale: true });
    const blocked = await b.http("/v1/orders/preview", { method: "POST", key: ADMIN, body: { ...order, lots: 1 } });
    expect(codes(blocked)).toContain("LOT_SIZE_STALE:block");
    expect(blocked.json.data.checks.find((c) => c.code === "LOT_SIZE_STALE").message).toMatch(/Confirm 65 units per lot or send quantity in units/);
    const wrong = await b.http("/v1/orders/preview", { method: "POST", key: ADMIN, body: { ...order, lots: 1, lotSizeConfirmed: 75 } });
    expect(codes(wrong)).toContain("LOT_SIZE_STALE:block");
    const ok = await b.http("/v1/orders/preview", { method: "POST", key: ADMIN, body: { ...order, lots: 1, lotSizeConfirmed: 65 } });
    expect(codes(ok).filter((c) => c.startsWith("LOT_SIZE_STALE"))).toEqual([]);
    const units = await b.http("/v1/orders/preview", { method: "POST", key: ADMIN, body: { ...order, quantity: 65 } });
    expect(codes(units).filter((c) => c.startsWith("LOT_SIZE_STALE"))).toEqual([]);
    await b.http("/v1/demo/reference", { method: "PUT", key: ADMIN, body: { lotsStale: false } });
    expect((await b.http("/v1/reference/bundle?underlying=NIFTY")).json.data.lots.stale).toBe(false);
  });

  it("demo mode never downloads: PUT /sources answers 422", async () => {
    const r = await b.http("/v1/reference/sources", { method: "PUT", key: ADMIN, body: { nseArchives: true } });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe("CAPABILITY_UNSUPPORTED");
  });

  it("/v1/expiries keeps its shape (back-compat)", async () => {
    const d = (await b.http("/v1/expiries?underlying=NIFTY")).json.data;
    expect(d.underlying).toBe("NIFTY");
    expect(Array.isArray(d.expiries) && d.expiries.every((e) => typeof e === "string")).toBe(true);
  });

  it("serves the dashboard's reference and Market calendar modules", async () => {
    for (const f of ["reference.js", "calendar.js"]) {
      const r = await b.http(`/dashboard/${f}`, { key: null });
      expect(r.status, f).toBe(200);
      expect(r.headers.get("content-type")).toMatch(/javascript/);
    }
  });
});

describe("a non-demo Bridge with archives off", () => {
  let b;
  const fetchSpy = vi.fn(async () => {
    throw new Error("no network in tests");
  });
  beforeAll(async () => {
    vi.stubGlobal("fetch", fetchSpy);
    b = await boot({ demo: false });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await b?.close();
  });

  it("answers available: false with SOURCE_OFF, has no demo routes, and makes zero fetch calls", async () => {
    const st = (await b.http("/v1/reference/status")).json.data;
    expect(st).toMatchObject({ demo: false, sources: { nseArchives: { enabled: false } } });
    expect(st.datasets.ban).toMatchObject({ available: false, reason: "SOURCE_OFF" });
    expect((await b.http("/v1/reference/mwpl")).json.data).toMatchObject({ available: false, reason: "SOURCE_OFF" });
    expect((await b.http("/v1/demo/reference", { method: "PUT", key: ADMIN, body: { lotsStale: true } })).status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("a non-demo Bridge with archives on, served the fixtures by a fake fetch", () => {
  const fixture = (name) => readFileSync(new URL(`../reference/__fixtures__/${name}`, import.meta.url));
  let lotsFile = "fo_mktlots.csv";
  const calls = [];
  const fakeFetch = vi.fn(async (url) => {
    calls.push(String(url));
    const body = /fo_mktlots/.test(url) ? fixture(lotsFile) : /fo_secban/.test(url) ? fixture("fo_secban.csv") : /combineoi/.test(url) ? fixture("combineoi.zip") : null;
    return body ? new Response(body, { status: 200 }) : new Response("not found", { status: 404 });
  });
  // Wed 24 Dec 2025: NIFTY's last December expiry is Tue 30 Dec, so a January lot change starts within 7 days.
  // The clock runs (rate limits refill) from a set start; moveTo() jumps it to another day.
  const clock = { off: istInstant("2025-12-24", "10:00") - Date.now(), now: () => clock.off + Date.now() };
  const moveTo = (t) => (clock.off = t - Date.now());
  const opt = (e) => ["CE", "PE"].map((r) => ({ symbol: `NFO:NIFTY-${e}-25000-${r}`, lotSize: 75, tickSize: 0.05 }));
  const symbols = createFakeSymbolService({ clock, instruments: [{ symbol: "NSE:NIFTY", lotSize: 1, tickSize: 0.05 }, ...["2025-12-30", "2026-01-06", "2026-01-27"].flatMap(opt)] });
  let b;
  beforeAll(async () => {
    vi.stubGlobal("fetch", fakeFetch);
    b = await boot({ demo: false, clock, overrides: { symbols } });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await b?.close();
  });
  const idle = async () => {
    for (let i = 0; i < 150; i++) {
      const st = (await b.http("/v1/reference/status")).json?.data;
      if (st && !st.syncing) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`the reference sync did not finish: ${JSON.stringify(calls)} ${JSON.stringify((await b.http("/v1/reference/status")).json).slice(0, 400)}`);
  };
  const syncLots = async () => {
    const r = await b.http("/v1/reference/sync", { method: "POST", key: ADMIN, body: { datasets: ["lots"] } });
    expect(r.status, JSON.stringify(r.json)).toBe(202);
    await idle();
  };

  it("syncs the market-lots file, then serves the lot history and the F&O universe intervals", async () => {
    const on = await b.http("/v1/reference/sources", { method: "PUT", key: ADMIN, body: { nseArchives: true } });
    expect(on.status).toBe(200);
    // Turning the source on queues a start-up sync of every dataset (with the polite gap between files): let it end.
    await idle();
    await syncLots();
    expect(calls.some((u) => /fo_mktlots/.test(u))).toBe(true);
    const lots = (await b.http("/v1/reference/lots?underlying=BANKNIFTY")).json.data;
    expect(lots.history.map((h) => [h.expiryMonth, h.lot])).toEqual(expect.arrayContaining([["2026-10", 30], ["2026-12", 35]]));
    const uni = (await b.http("/v1/reference/fno-universe?date=2025-12-24&kind=all")).json.data;
    expect(uni.items.map((i) => i.symbol)).toEqual(expect.arrayContaining(["NIFTY", "BANKNIFTY", "RELIANCE", "M&M"]));
    expect(uni.items.find((i) => i.symbol === "RELIANCE")).toMatchObject({ kind: "stock", since: "2025-12-24", sinceIsFirstFetch: true });
    expect(uni.knownSince).toBe("2025-12-24");
  });

  it("a second sync with a revised file shows the lot-revision event", async () => {
    lotsFile = "mktlots-revision.csv";
    moveTo(istInstant("2025-12-26", "10:00"));
    await syncLots();
    const ev = (await b.http("/v1/reference/events?days=7&underlying=NIFTY")).json.data.items;
    expect(ev.find((e) => e.kind === "lot-revision")).toMatchObject({ underlying: "NIFTY", effectiveOn: "2025-12-31", ref: { lotBefore: 75, lotAfter: 65 } });
  });
});
