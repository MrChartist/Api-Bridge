/**
 * market routes end to end through the real request pipeline (createApp): the real MarketDataService over the published
 * fakes (accounts, scheduler, symbols), a stub stream hub and a fake key store. Checks the OpenAPI shapes
 * ({ data, errors?, meta }), auth and scope, account pinning against the key, validation, CSV output and the `market`
 * config section.
 */
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { createApp } from "../core/app.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createFakeScheduler } from "../ratelimit/fake.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { instrumentSpecs, priceForToken, stubAdapter, stubStreamHub } from "./__fixtures__/helpers.mjs";
import marketModule, { ROUTES } from "./module.mjs";

const READ = "mcb_read0000001_aaaaaaaaaaaaaaaaaaaa";
const LIMITED = "mcb_limit000001_bbbbbbbbbbbbbbbbbbbb";
const PAPER_ONLY = "mcb_paper000001_cccccccccccccccccccc";
const KEYS = {
  [PAPER_ONLY]: { id: "paper000001", label: "paper only", scopes: ["read"], accounts: ["paper"] },
  [READ]: { id: "read0000001", label: "reader", scopes: ["read"], accounts: "*" },
  [LIMITED]: { id: "limit000001", label: "dhan only", scopes: ["read"], accounts: ["dhan-main"] },
};
const fakeKeyStore = { ...notImplementedService("keyStore"), authenticate: async (raw) => KEYS[raw] ?? null };

// The instrument fixtures (__fixtures__/helpers.mjs) list option expiries up to 24 November 2026. The service asks the app clock which
// expiries are still ahead, so a real clock would make `/v1/expiries` answer 404 from 25 November. Pin the clock to the week
// the fixtures were written for (Monday 19 October 2026, 09:30 IST) and let it run forward from there.
const PIN_START = Date.UTC(2026, 9, 19, 4, 0, 0);
const REAL_START = Date.now();
const PINNED_CLOCK = { now: () => PIN_START + (Date.now() - REAL_START) };

let app;
let port;
let zerodha;

function call(path, { key = READ } = {}) {
  const headers = { host: `127.0.0.1:${port}` };
  if (key) headers.authorization = `Bearer ${key}`;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const enc = encodeURIComponent;

const daily = (req) => {
  const out = [];
  for (let d = Date.parse(`${req.from.slice(0, 10)}T00:00:00+05:30`); d <= Date.parse(`${req.to.slice(0, 10)}T00:00:00+05:30`); d += 86_400_000) {
    out.push({ time: d / 1000 + 33_300, open: 10, high: 12, low: 9, close: 11, volume: 1000, oi: 5 });
  }
  return out;
};

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-market-routes-"));
  const { config } = loadConfig({
    raw: { server: { port: 0 }, dataDir, market: { batch: { windowMs: 5 }, freshness: { quoteMs: 1500 } } },
    env: {},
  });
  zerodha = stubAdapter("zerodha", { candles: daily });
  const accounts = createFakeAccountManager({
    accounts: [
      { id: "zerodha-main", broker: "zerodha", adapter: zerodha, creds: { apiKey: "k" } },
      { id: "dhan-main", broker: "dhan", adapter: stubAdapter("dhan"), creds: { clientId: "1" } },
    ],
  });
  app = await createApp({
    config,
    modules: [marketModule],
    overrides: {
      keyStore: fakeKeyStore,
      accounts,
      scheduler: createFakeScheduler(),
      symbols: createFakeSymbolService({ instruments: instrumentSpecs() }),
      streamHub: stubStreamHub(),
    },
    logger: createNullLogger(),
    clock: PINNED_CLOCK,
  });
  ({ port } = await app.listen());
});

afterAll(async () => {
  await app?.close?.();
});

describe("market routes", () => {
  it("registers exactly the contract routes with scope read", () => {
    const listed = app.router.list().filter((r) => r.module === "market" || ROUTES.some(([m, p]) => m === r.method && p === r.pattern));
    expect(listed.map((r) => `${r.method} ${r.pattern}`).sort()).toEqual(ROUTES.map(([m, p]) => `${m} ${p}`).sort());
    for (const r of listed) expect(r.options.scope).toBe("read");
  });

  it("needs an API key", async () => {
    const r = await call("/v1/ltp?symbols=NSE:NIFTY", { key: null });
    expect(r.status).toBe(401);
  });

  it("GET /v1/ltp answers { data, errors, meta } with freshness", async () => {
    const r = await call(`/v1/ltp?symbols=${enc("NSE:NIFTY, nse:reliance,BAD SYMBOL")}`);
    expect(r.status).toBe(200);
    expect(r.json.data.map((i) => i.symbol)).toEqual(["NSE:NIFTY", "NSE:RELIANCE"]);
    expect(r.json.data[0]).toMatchObject({ ltp: priceForToken("Z1"), freshness: { source: "broker", accountId: "zerodha-main", broker: "zerodha", stale: false } });
    expect(r.json.errors).toEqual([expect.objectContaining({ symbol: "BAD SYMBOL", code: "VALIDATION_FAILED" })]);
    expect(r.json.meta).toMatchObject({ requestId: expect.any(String), accountId: null });
  });

  it("GET /v1/quotes serves the second read from cache", async () => {
    const first = await call(`/v1/quotes?symbols=${enc("NSE:INFY")}`);
    expect(first.status).toBe(200);
    expect(first.json.data[0]).toMatchObject({ symbol: "NSE:INFY", close: expect.any(Number), change: 5 });
    const second = await call(`/v1/quotes?symbols=${enc("NSE:INFY")}`);
    expect(second.json.data[0].freshness.source).toBe("cache");
    const live = await call(`/v1/quotes?symbols=${enc("NSE:INFY")}&maxAgeMs=0`);
    expect(live.json.data[0].freshness.source).toBe("broker");
  });

  it("fields= trims quotes and history candles but never drops the data-class label or the time", async () => {
    const q = await call(`/v1/quotes?symbols=${enc("NSE:INFY")}&fields=ltp,bid`);
    expect(q.status).toBe(200);
    expect(Object.keys(q.json.data[0])).toEqual(["symbol", "ltp", "bid", "freshness"]);
    expect(q.json.data[0].freshness).toMatchObject({ class: "realtime", source: expect.any(String) });
    expect(q.json.meta.fields).toEqual(["ltp", "bid"]);
    expect(Array.isArray(q.json.errors)).toBe(true);
    expect((await call(`/v1/quotes?symbols=${enc("NSE:INFY")}&fields=ltp,nope`)).status).toBe(400);
    expect((await call(`/v1/quotes?symbols=${enc("NSE:INFY")}&fields=`)).status).toBe(200); // an empty value counts as not sent
    const h = await call("/v1/history?symbol=NSE:NIFTY&interval=1d&from=2026-10-12&to=2026-10-14&fields=close,date,timeIso");
    expect(h.status).toBe(200);
    expect(Object.keys(h.json.data.candles[0])).toEqual(["time", "close", "date", "timeIso"]);
    expect(h.json.data.freshness).toBeTruthy();
    expect(h.json.data.partial).toBe(false);
    expect(h.json.meta.fields).toEqual(["close", "date", "timeIso"]);
    expect((await call("/v1/history?symbol=NSE:NIFTY&interval=1d&from=2026-10-12&to=2026-10-14&fields=close&format=csv")).status).toBe(400);
    expect((await call("/v1/history?symbol=NSE:NIFTY&interval=1d&from=2026-10-12&to=2026-10-14&fields=a,b")).json.detail).toMatch(/Allowed: time, open/);
  });

  it("validates symbols and maxAgeMs", async () => {
    expect((await call("/v1/ltp")).json.code).toBe("VALIDATION_FAILED");
    expect((await call(`/v1/ltp?symbols=${Array.from({ length: 201 }, () => "NSE:NIFTY").join(",")}`)).status).toBe(400);
    expect((await call("/v1/ltp?symbols=NSE:NIFTY&maxAgeMs=abc")).status).toBe(400);
    expect((await call("/v1/ltp?symbols=NSE:NIFTY&maxAgeMs=3600001")).status).toBe(400);
  });

  it("pins to an account the key may use, and refuses others", async () => {
    const ok = await call(`/v1/ltp?symbols=NSE:RELIANCE&account=dhan-main`, { key: LIMITED });
    expect(ok.status).toBe(200);
    expect(ok.json.meta.accountId).toBe("dhan-main");
    expect(ok.json.data[0].freshness).toMatchObject({ accountId: "dhan-main", broker: "dhan" });
    const no = await call(`/v1/ltp?symbols=NSE:RELIANCE&account=zerodha-main`, { key: LIMITED });
    expect(no.status).toBe(403);
    expect(no.json.code).toBe("ACCOUNT_FORBIDDEN");
    const missing = await call(`/v1/ltp?symbols=NSE:RELIANCE&account=ghost`);
    expect(missing.status).toBe(404);
    expect(missing.json.code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("serves an unpinned read only from accounts the key may use, never the primary it cannot use", async () => {
    const limited = await call(`/v1/ltp?symbols=NSE:RELIANCE&maxAgeMs=0`, { key: LIMITED });
    expect(limited.status).toBe(200);
    expect(limited.json.data[0].freshness).toMatchObject({ source: "broker", accountId: "dhan-main", broker: "dhan" });
    const none = await call(`/v1/ltp?symbols=NSE:RELIANCE&maxAgeMs=0`, { key: PAPER_ONLY });
    expect(none.status).toBe(200);
    expect(none.json.data).toEqual([]);
    expect(none.json.errors).toEqual([expect.objectContaining({ symbol: "NSE:RELIANCE", code: "BROKER_UNAVAILABLE" })]);
    const depth = await call(`/v1/depth?symbol=NSE:RELIANCE&maxAgeMs=0`, { key: PAPER_ONLY });
    expect(depth.json.code).toBe("BROKER_UNAVAILABLE");
  });

  it("GET /v1/depth", async () => {
    const r = await call(`/v1/depth?symbol=${enc("NSE:M&M")}`);
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ symbol: "NSE:M&M", bids: [{ price: 100 }, { price: 99 }], asks: [{ price: 101 }, { price: 101.5 }] });
    expect(r.json.meta.freshness).toEqual(r.json.data.freshness);
    expect((await call("/v1/depth")).status).toBe(400);
  });

  it("GET /v1/history as JSON and as CSV with IST times", async () => {
    const j = await call(`/v1/history?symbol=NSE:NIFTY&interval=1d&from=2026-10-12&to=2026-10-14`);
    expect(j.status).toBe(200);
    expect(j.json.data).toMatchObject({ symbol: "NSE:NIFTY", interval: "1d", partial: false });
    expect(j.json.data.candles).toHaveLength(3);
    const c = await call(`/v1/history?symbol=NSE:NIFTY&interval=1d&from=2026-10-12&to=2026-10-14&format=csv`);
    expect(c.status).toBe(200);
    expect(c.headers["content-type"]).toMatch(/^text\/csv/);
    expect(c.headers["content-disposition"]).toMatch(/NSE_NIFTY_1d\.csv/);
    expect(c.headers["x-mcb-partial"]).toBe("false");
    const lines = c.text.trim().split("\r\n");
    expect(lines[0]).toBe("time,open,high,low,close,volume,oi");
    expect(lines[1]).toBe("2026-10-12,10,12,9,11,1000,5");
    expect(lines).toHaveLength(4);
  });

  it("GET /v1/history: daily bars carry the IST date; timeIso and tz add an ISO twin of the epoch time", async () => {
    const base = "/v1/history?symbol=NSE:NIFTY&interval=1d&from=2026-10-12&to=2026-10-14";
    const j = await call(base);
    expect(j.json.data.candles.map((c) => c.date)).toEqual(["2026-10-12", "2026-10-13", "2026-10-14"]);
    expect(j.json.data.candles[0]).not.toHaveProperty("timeIso");
    expect(typeof j.json.data.candles[0].time).toBe("number");
    const ist = await call(`${base}&timeIso=true`);
    expect(ist.json.data.candles[0].timeIso).toBe("2026-10-12T09:15:00+05:30");
    expect(ist.json.data.candles[0].time).toBe(j.json.data.candles[0].time);
    const utc = await call(`${base}&tz=UTC`);
    expect(utc.json.data.candles[0].timeIso).toBe("2026-10-12T03:45:00Z");
    expect(utc.json.data.candles[0].date).toBe("2026-10-12");
    expect((await call(`${base}&tz=PST`)).status).toBe(400);
    expect((await call(`${base}&timeIso=maybe`)).status).toBe(400);
    expect((await call(`${base}&format=csv&tz=UTC`)).status).toBe(400);
    // Intraday bars carry no date by default (the epoch time and, on request, the ISO twin say it all).
    const m = await call("/v1/history?symbol=NSE:NIFTY&interval=5m&from=2026-10-12&to=2026-10-12&timeIso=1");
    if (m.json.data.candles.length) {
      expect(m.json.data.candles[0]).not.toHaveProperty("date");
      expect(m.json.data.candles[0].timeIso).toMatch(/\+05:30$/);
    }
  });

  it("validates history parameters", async () => {
    expect((await call("/v1/history?symbol=NSE:NIFTY")).status).toBe(400);
    expect((await call("/v1/history?symbol=NSE:NIFTY&interval=7m&from=2026-10-12")).status).toBe(400);
    expect((await call("/v1/history?symbol=NSE:NIFTY&interval=1d&from=2026-10-12&format=xml")).status).toBe(400);
    expect((await call("/v1/history?symbol=NSE:NIFTY&interval=1d&countback=0")).status).toBe(400);
    expect((await call("/v1/history?symbol=NSE:NIFTY&interval=1d&from=yesterday")).status).toBe(400);
  });

  it("GET /v1/expiries", async () => {
    const r = await call("/v1/expiries?underlying=NIFTY&exchange=nfo");
    expect(r.status).toBe(200);
    expect(r.json.data.underlying).toBe("NIFTY");
    expect(r.json.data.expiries.length).toBeGreaterThan(0);
    expect(r.json.data.expiries.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
    expect((await call("/v1/expiries")).status).toBe(400);
    expect((await call("/v1/expiries?underlying=NIFTY&exchange=NSE")).status).toBe(400);
  });

  it("GET /v1/optionchain", async () => {
    const r = await call("/v1/optionchain?underlying=NIFTY&expiry=2026-10-27&strikes=1&greeks=true");
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ underlying: "NIFTY", expiry: "2026-10-27", atmStrike: 25000, underlyingLtp: 25012.5 });
    expect(r.json.data.rows.map((x) => x.strike)).toEqual([24900, 25000, 25100]);
    expect(r.json.data.rows[1].ce.symbol).toBe("NFO:NIFTY-2026-10-27-25000-CE");
    expect((await call("/v1/optionchain?underlying=NIFTY")).status).toBe(400);
    expect((await call("/v1/optionchain?underlying=NIFTY&expiry=2026-10-27&greeks=maybe")).status).toBe(400);
    expect((await call("/v1/optionchain?underlying=NIFTY&expiry=2026-10-27&strikes=101")).status).toBe(400);
  });

  it("refuses an invalid market config section", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-market-cfg-"));
    const { config } = loadConfig({ raw: { dataDir, market: { freshness: { ltpMs: 60_000 } } }, env: {} });
    return expect(createApp({ config, modules: [marketModule], logger: createNullLogger() })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
