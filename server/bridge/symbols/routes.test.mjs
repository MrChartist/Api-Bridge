/**
 * S4 routes end to end through the real request pipeline (createApp): fixture masters behind stub adapters, the fake
 * AccountManager, a recording scheduler and a fake key store. Checks the OpenAPI shapes ({ data, meta },
 * Instrument.symbol, ConvertResult, ItemError), auth and scope, validation and problem codes.
 */
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrokerRegistry } from "../../brokers/registry.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import symbolsModule, { ROUTES } from "./module.mjs";
import { toPublicInstrument } from "./routes.mjs";
import { FIXTURE_BROKERS, accountsFor, createRecordingScheduler, loadMaster, stubAdapter } from "./__fixtures__/helpers.mjs";

const READ = "mcb_read0000001_aaaaaaaaaaaaaaaaaaaa";
const PAPER_ONLY = "mcb_paper000001_cccccccccccccccccccc";
const KEYS = {
  [READ]: { id: "read0000001", label: "reader", scopes: ["read"], accounts: "*" },
  [PAPER_ONLY]: { id: "paper000001", label: "paper", scopes: ["paper"], accounts: "*" },
};
const fakeKeyStore = { ...notImplementedService("keyStore"), authenticate: async (raw) => KEYS[raw] ?? null };

let app;
let port;
let scheduler;

function call(method, path, { key = READ, body, raw } = {}) {
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  const headers = { host: `127.0.0.1:${port}` };
  if (key) headers.authorization = `Bearer ${key}`;
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
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
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const enc = encodeURIComponent;

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-sym-routes-"));
  const { config } = loadConfig({
    raw: { server: { port: 0 }, dataDir, symbols: { refreshAfterIst: "08:30", warmOnStart: true }, accounts: FIXTURE_BROKERS.map((b) => ({ id: `${b}-1`, broker: b })) },
    env: {},
  });
  scheduler = createRecordingScheduler();
  const adapters = Object.fromEntries(FIXTURE_BROKERS.map((b) => [b, stubAdapter(b, loadMaster(b))]));
  app = await createApp({
    config,
    modules: [symbolsModule],
    overrides: { keyStore: fakeKeyStore, accounts: accountsFor(adapters), scheduler },
    logger: createNullLogger(),
    clock: { now: () => Date.parse("2026-10-18T10:00:00+05:30") },
    brokers: createBrokerRegistry(),
  });
  ({ port } = await app.listen());
});

afterAll(async () => {
  await app?.close();
});

describe("route table", () => {
  it("matches the contract: four read-scoped routes", () => {
    expect(ROUTES.map(([m, p, o]) => [m, p, o.scope])).toEqual([
      ["GET", "/v1/instruments/search", "read"],
      ["GET", "/v1/instruments/:symbol", "read"],
      ["GET", "/v1/symbols/convert", "read"],
      ["POST", "/v1/symbols/convert", "read"],
    ]);
  });

  it("warms the masters on start through the scheduler", async () => {
    for (let i = 0; i < 100 && scheduler.calls.length < 5; i++) await new Promise((r) => setTimeout(r, 5));
    expect(scheduler.calls.map((c) => c.endpointClass)).toEqual(Array(5).fill("master"));
  });

  it("rejects a missing or unknown key; any scope implies read", async () => {
    expect((await call("GET", "/v1/instruments/search?q=nifty", { key: null })).status).toBe(401);
    expect((await call("GET", "/v1/instruments/search?q=nifty", { key: "mcb_nope000000_x" })).json.code).toBe("UNAUTHENTICATED");
    expect((await call("GET", "/v1/instruments/NSE%3ANIFTY", { key: PAPER_ONLY })).status).toBe(200);
  });
});

describe("GET /v1/instruments/{symbol}", () => {
  it("resolves any accepted form to an OpenAPI Instrument", async () => {
    const r = await call("GET", `/v1/instruments/${enc("NSE:NIFTY261027C25000")}`);
    expect(r.status).toBe(200);
    expect(r.json.meta.requestId).toEqual(expect.any(String));
    expect(r.json.data).toEqual({
      symbol: "NFO:NIFTY-2026-10-27-25000-CE",
      exchange: "NFO",
      kind: "OPT",
      underlying: "NIFTY",
      name: null,
      expiry: "2026-10-27",
      strike: 25000,
      right: "CE",
      lotSize: 65,
      tickSize: 0.05,
      freezeQty: expect.any(Number),
      freezeQtySource: "exchange-list",
      isin: null,
    });
  });

  it("include=refs adds each broker's token and trading symbol", async () => {
    const r = await call("GET", `/v1/instruments/${enc("NSE:RELIANCE")}?include=refs`);
    expect(r.json.data).toMatchObject({ symbol: "NSE:RELIANCE", kind: "EQ", isin: "INE002A01018", refs: { dhan: { token: "2885", exchange: "NSE", tradingSymbol: "RELIANCE" }, upstox: { token: "NSE_EQ|INE002A01018" } } });
    expect((await call("GET", `/v1/instruments/${enc("NSE:RELIANCE")}?include=everything`)).json.code).toBe("VALIDATION_FAILED");
  });

  it("continuous futures, unknown and expired symbols", async () => {
    expect((await call("GET", `/v1/instruments/${enc("NSE:BANKNIFTY1!")}`)).json.data.symbol).toBe("NFO:BANKNIFTY-2026-10-27-FUT");
    const missing = await call("GET", `/v1/instruments/${enc("NSE:NOSUCH")}`);
    expect(missing.status).toBe(404);
    expect(missing.headers["content-type"]).toMatch(/problem\+json/);
    expect(missing.json).toMatchObject({ code: "SYMBOL_NOT_FOUND", retryable: false });
    expect((await call("GET", `/v1/instruments/${enc("NFO:NIFTY-2026-10-16-FUT")}`)).json).toMatchObject({ code: "SYMBOL_NOT_FOUND", detail: expect.stringMatching(/expired/) });
    expect((await call("GET", `/v1/instruments/${enc("???")}`)).status).toBe(400);
  });
});

describe("GET /v1/instruments/search", () => {
  it("returns ranked Instruments and pages with meta.nextCursor", async () => {
    const first = await call("GET", "/v1/instruments/search?q=nifty&limit=2");
    expect(first.status).toBe(200);
    expect(first.json.data).toHaveLength(2);
    expect(first.json.data[0].symbol).toBe("NSE:NIFTY");
    expect(first.json.data[0]).not.toHaveProperty("refs");
    expect(first.json.meta.nextCursor).toEqual(expect.any(String));
    const second = await call("GET", `/v1/instruments/search?q=nifty&limit=2&cursor=${enc(first.json.meta.nextCursor)}`);
    expect(second.json.data).toHaveLength(2);
    expect(second.json.data[0].symbol).not.toBe(first.json.data[0].symbol);
  });

  it("filters by exchange, kind and expiry (case-insensitive enums)", async () => {
    const r = await call("GET", "/v1/instruments/search?q=nifty&kind=fut&exchange=nfo");
    expect(r.json.data.map((i) => i.symbol)).toEqual(["NFO:NIFTY-2026-10-27-FUT", "NFO:BANKNIFTY-2026-10-27-FUT"]);
    const e = await call("GET", "/v1/instruments/search?q=sensex&expiry=2026-10-22");
    expect(e.json.data.every((i) => i.expiry === "2026-10-22")).toBe(true);
    expect(e.json.meta.nextCursor).toBeNull();
  });

  it("validates q, limit, kind and cursor", async () => {
    expect((await call("GET", "/v1/instruments/search")).json.code).toBe("VALIDATION_FAILED");
    expect((await call("GET", "/v1/instruments/search?q=nifty&limit=0")).json.code).toBe("VALIDATION_FAILED");
    expect((await call("GET", "/v1/instruments/search?q=nifty&limit=501")).json.code).toBe("VALIDATION_FAILED");
    expect((await call("GET", "/v1/instruments/search?q=nifty&limit=abc")).json.code).toBe("VALIDATION_FAILED");
    expect((await call("GET", "/v1/instruments/search?q=nifty&kind=bond")).json.code).toBe("VALIDATION_FAILED");
    expect((await call("GET", "/v1/instruments/search?q=nifty&cursor=zzz")).json.code).toBe("VALIDATION_FAILED");
  });
});

describe("/v1/symbols/convert", () => {
  it("GET converts one symbol", async () => {
    const r = await call("GET", `/v1/symbols/convert?input=${enc("NIFTY27OCT2625000CE")}&exchange=NFO&broker=zerodha`);
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({
      input: "NIFTY27OCT2625000CE",
      canonical: "NFO:NIFTY-2026-10-27-25000-CE",
      aliases: {
        tradingview: "NSE:NIFTY261027C25000",
        compact: "NIFTY27OCT2625000CE",
        compactExchange: "NFO",
        "broker:zerodha": "NIFTY26OCT25000CE",
        "broker:zerodha:token": "12010242",
      },
    });
  });

  it("GET validates", async () => {
    expect((await call("GET", "/v1/symbols/convert")).json.code).toBe("VALIDATION_FAILED");
    expect((await call("GET", `/v1/symbols/convert?input=x&from=reuters`)).json.code).toBe("VALIDATION_FAILED");
    expect((await call("GET", `/v1/symbols/convert?input=${enc("NSE:RELIANCE")}&broker=nosuch`)).json.code).toBe("VALIDATION_FAILED");
  });

  it("POST converts a batch with one result or ItemError per item, in order", async () => {
    const r = await call("POST", "/v1/symbols/convert", {
      body: { items: [{ input: "NSE:NIFTY1!" }, { input: "NSE:NOPE1!" }, { input: "51440", from: "broker", broker: "dhan" }, { input: "garbage???" }] },
    });
    expect(r.status).toBe(200);
    expect(r.json.data).toHaveLength(4);
    expect(r.json.data[0]).toMatchObject({ input: "NSE:NIFTY1!", canonical: "NFO:NIFTY-2026-10-27-FUT" });
    expect(r.json.data[1]).toMatchObject({ symbol: "NSE:NOPE1!", code: "SYMBOL_NOT_FOUND", message: expect.any(String) });
    expect(r.json.data[2]).toMatchObject({ canonical: "NFO:NIFTY-2026-10-27-25000-CE", aliases: { "broker:dhan:token": "51440" } });
    expect(r.json.data[3]).toMatchObject({ symbol: "garbage???", code: "VALIDATION_FAILED" });
  });

  it("POST validates the envelope (1 to 200 items, no unknown fields)", async () => {
    expect((await call("POST", "/v1/symbols/convert", { body: { items: [] } })).json.code).toBe("VALIDATION_FAILED");
    expect((await call("POST", "/v1/symbols/convert", { body: { items: Array(201).fill({ input: "NSE:RELIANCE" }) } })).json.code).toBe("VALIDATION_FAILED");
    expect((await call("POST", "/v1/symbols/convert", { body: { items: [{ input: "NSE:RELIANCE", extra: 1 }] } })).json.code).toBe("VALIDATION_FAILED");
    expect((await call("POST", "/v1/symbols/convert", { raw: "{not json" })).json.code).toBe("INVALID_JSON");
  });
});

describe("toPublicInstrument", () => {
  it("renames canonical to symbol and only includes refs on request", () => {
    const r = { canonical: "NSE:X", exchange: "NSE", kind: "EQ", underlying: "X", expiry: null, strike: null, right: null, lotSize: 1, tickSize: 0.05, refs: { a: { token: "1" } } };
    expect(toPublicInstrument(r)).not.toHaveProperty("refs");
    expect(toPublicInstrument(r, { withRefs: true }).refs).toEqual({ a: { token: "1" } });
    expect(toPublicInstrument(r)).toMatchObject({ symbol: "NSE:X", name: null, freezeQty: null, isin: null });
  });
});
