/**
 * Symbol naming tolerance, resolve with reasons and validate: the service over the fake instrument list, then the three
 * routes through the real request pipeline.
 */
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createFakeSymbolService } from "./fake.mjs";
import { rewriteSymbolInput } from "./inputForms.mjs";
import symbolsModule from "./module.mjs";

const symbols = createFakeSymbolService({ today: "2026-10-18" });

describe("rewriteSymbolInput", () => {
  it.each([
    ["NSE_INDEX:NIFTY 50", "NSE:NIFTY"],
    ["NSE_INDEX:Nifty Bank", "NSE:BANKNIFTY"],
    ["BSE_INDEX:SENSEX", "BSE:SENSEX"],
    ["NSE:NIFTY BANK", "NSE:BANKNIFTY"],
    ["NSE_EQ:RELIANCE", "NSE:RELIANCE"],
    ["NSE:RELIANCE-EQ", "NSE:RELIANCE"],
    ["NSE_FO:NIFTY-2026-10-27-FUT", "NFO:NIFTY-2026-10-27-FUT"],
  ])("%s -> %s", (input, out) => {
    const r = rewriteSymbolInput(input);
    expect(r.input).toBe(out);
    expect(r.rules.length).toBeGreaterThan(0);
  });

  it("leaves everything else alone", () => {
    for (const s of ["NSE:RELIANCE", "NSE:BAJAJ-AUTO", "NFO:NIFTY-2026-10-27-25000-CE", "RELIANCE", "NSE:M&M"]) {
      expect(rewriteSymbolInput(s)).toEqual({ input: s, rules: [], indexHint: false });
    }
  });
});

describe("automatic resolution reads chart spellings and exchange words", () => {
  it.each([
    ["NSE:M_M", "NSE:M&M"],
    ["NSE:BAJAJ_AUTO", "NSE:BAJAJ-AUTO"],
    ["NSE:m_m", "NSE:M&M"],
    ["NSE_INDEX:NIFTY 50", "NSE:NIFTY"],
    ["NSE:NIFTY BANK", "NSE:BANKNIFTY"],
    ["NSE:RELIANCE-EQ", "NSE:RELIANCE"],
    ["NSE_EQ:RELIANCE", "NSE:RELIANCE"],
    ["NSE:NIFTY1!", "NFO:NIFTY-2026-10-27-FUT"],
  ])("resolve(%s) is %s", async (input, canonical) => {
    expect((await symbols.resolve(input)).canonical).toBe(canonical);
  });

  it("convert says the same, and the strict from=canonical still refuses a chart spelling", async () => {
    expect((await symbols.convert({ input: "NSE:BAJAJ_AUTO" })).canonical).toBe("NSE:BAJAJ-AUTO");
    await expect(symbols.resolve("NSE:M_M", { from: "canonical" })).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND" });
  });

  it("a name with an underscore that exists nowhere stays not found", async () => {
    await expect(symbols.resolve("NSE:NO_SUCH_NAME")).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND" });
  });
});

describe("resolveInput", () => {
  it("an explicit symbol resolves with the rule that was applied", async () => {
    const r = await symbols.resolveInput({ q: "NSE:M_M" });
    expect(r).toMatchObject({ status: "resolved", symbol: "NSE:M&M", confidence: "exact" });
    expect(r.rules).toEqual(["chart name NSE:M_M read as NSE:M&M"]);
    expect(r.steps.join(" ")).toContain("NSE:M&M");
  });

  it("a bare name with exactly one cash instrument resolves; the derivatives never win", async () => {
    const r = await symbols.resolveInput({ q: "Infosys" });
    expect(r).toMatchObject({ status: "resolved", symbol: "NSE:INFY", confidence: "unique-name" });
  });

  it("a bare name on two exchanges is ambiguous: nothing is picked", async () => {
    const r = await symbols.resolveInput({ q: "RELIANCE" });
    expect(r.status).toBe("ambiguous");
    expect(r.symbol).toBeNull();
    expect(r.candidates.map((c) => c.instrument.canonical)).toEqual(["NSE:RELIANCE", "BSE:RELIANCE"]);
  });

  it("the exchange settles it", async () => {
    expect((await symbols.resolveInput({ q: "RELIANCE", exchange: "BSE" })).symbol).toBe("BSE:RELIANCE");
    expect((await symbols.resolveInput({ q: "reliance", exchange: "nse" })).symbol).toBe("NSE:RELIANCE");
  });

  it("a name that is only a prefix is not found, with suggestions", async () => {
    const r = await symbols.resolveInput({ q: "RELIA" });
    expect(r.status).toBe("not_found");
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates[0].reason).toMatch(/starts with/);
  });

  it("a name that only futures and options carry is ambiguous (never one contract picked)", async () => {
    const r = await symbols.resolveInput({ q: "CRUDEOIL", exchange: "MCX" });
    // one MCX future in the fake list: the only contract with the name
    expect(r).toMatchObject({ status: "resolved", symbol: "MCX:CRUDEOIL-2026-11-19-FUT" });
    const two = await symbols.resolveInput({ q: "BANKNIFTY", kind: "FUT" });
    expect(two.status).toBe("resolved");
    const many = await symbols.resolveInput({ q: "NIFTY", kind: "OPT" });
    expect(many.status).toBe("ambiguous");
    expect(many.candidates.length).toBeLessThanOrEqual(10);
  });

  it("refuses an exchange that contradicts the symbol, and bad arguments", async () => {
    await expect(symbols.resolveInput({ q: "NSE:RELIANCE", exchange: "BSE" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(symbols.resolveInput({ q: "RELIANCE", exchange: "XYZ" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(symbols.resolveInput({ q: "" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(symbols.resolveInput({ q: "x".repeat(65) })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(symbols.resolveInput({ q: "RELIANCE", limit: 51 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("routes", () => {
  const KEY = "mcb_readkey0001_x";
  const keyStore = { ...notImplementedService("keyStore"), authenticate: async (raw) => (raw === KEY ? { id: "readkey0001", label: "sheet", scopes: ["read"], accounts: "*" } : null) };
  let app;
  let port;

  const call = (method, path, { body, key = KEY } = {}) =>
    new Promise((resolve, reject) => {
      const headers = { host: `127.0.0.1:${port}` };
      if (key) headers.authorization = `Bearer ${key}`;
      const payload = body === undefined ? undefined : JSON.stringify(body);
      if (payload !== undefined) Object.assign(headers, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode, json: text ? JSON.parse(text) : undefined });
        });
      });
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-sym-resolve-"));
    const { config } = loadConfig({ raw: { server: { port: 0 }, dataDir }, env: {} });
    app = await createApp({ config, modules: [symbolsModule], logger: createNullLogger(), overrides: { keyStore, symbols } });
    ({ port } = await app.listen());
  });
  afterAll(async () => app?.close());

  it("GET /v1/symbols/resolve answers the instrument, the rule and ranked candidates; explain adds the steps", async () => {
    const r = await call("GET", "/v1/symbols/resolve?q=NSE:BAJAJ_AUTO&explain=1");
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ symbol: "NSE:BAJAJ-AUTO", confidence: "exact", instrument: { symbol: "NSE:BAJAJ-AUTO", lotSize: 1 } });
    expect(r.json.data.candidates[0]).toMatchObject({ symbol: "NSE:BAJAJ-AUTO", reason: "exact symbol" });
    expect(Array.isArray(r.json.data.steps)).toBe(true);
    const plain = await call("GET", "/v1/symbols/resolve?q=NSE:BAJAJ_AUTO");
    expect(plain.json.data.steps).toBeUndefined();
  });

  it("an ambiguous name is AMBIGUOUS_SYMBOL (409) with the candidates and the rule, never a guess", async () => {
    const r = await call("GET", "/v1/symbols/resolve?q=RELIANCE");
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("AMBIGUOUS_SYMBOL");
    expect(r.json.candidates.map((c) => c.symbol)).toEqual(["NSE:RELIANCE", "BSE:RELIANCE"]);
    expect(r.json.candidates[0].reason).toMatch(/exact name/);
    expect(r.json.rule).toMatch(/name the exchange/);
    const ok = await call("GET", "/v1/symbols/resolve?q=RELIANCE&exchange=NSE");
    expect(ok.json.data.symbol).toBe("NSE:RELIANCE");
  });

  it("an unknown name is SYMBOL_NOT_FOUND with suggestions; bad parameters are VALIDATION_FAILED", async () => {
    const nf = await call("GET", "/v1/symbols/resolve?q=RELIA");
    expect(nf.status).toBe(404);
    expect(nf.json.code).toBe("SYMBOL_NOT_FOUND");
    expect(nf.json.candidates.length).toBeGreaterThan(0);
    for (const bad of ["", "?q=", "?q=NSE:RELIANCE&limit=0", "?q=NSE:RELIANCE&limit=abc", "?q=NSE:RELIANCE&explain=maybe", "?q=NSE:RELIANCE&exchange=ZZZ"]) {
      const r = await call("GET", `/v1/symbols/resolve${bad}`);
      expect(r.status, bad).toBe(400);
    }
  });

  it("needs a key", async () => {
    expect((await call("GET", "/v1/symbols/resolve?q=NSE:RELIANCE", { key: null })).status).toBe(401);
    expect((await call("GET", "/v1/symbols/validate?symbol=NSE:RELIANCE", { key: null })).status).toBe(401);
  });

  it("validate shows the canonical form and the lot size, and a bad symbol is a result, not an error", async () => {
    const good = await call("GET", "/v1/symbols/validate?symbol=NSE:M_M");
    expect(good.status).toBe(200);
    expect(good.json.data).toMatchObject({ valid: true, symbol: "NSE:M&M", kind: "EQ", lotSize: 1, tickSize: 0.05, tradable: true, normalised: true });
    const fut = await call("GET", `/v1/symbols/validate?symbol=${encodeURIComponent("NSE:NIFTY1!")}`);
    expect(fut.json.data).toMatchObject({ valid: true, symbol: "NFO:NIFTY-2026-10-27-FUT", lotSize: 65 });
    const index = await call("GET", `/v1/symbols/validate?symbol=${encodeURIComponent("NSE_INDEX:NIFTY 50")}`);
    expect(index.json.data).toMatchObject({ valid: true, symbol: "NSE:NIFTY", kind: "INDEX", tradable: false });
    expect(index.json.data.tradableNote).toMatch(/futures or options/);
    const bad = await call("GET", "/v1/symbols/validate?symbol=NSE:NOPE");
    expect(bad.status).toBe(200);
    expect(bad.json.data).toMatchObject({ valid: false, code: "SYMBOL_NOT_FOUND" });
    const amb = await call("GET", "/v1/symbols/validate?symbol=RELIANCE");
    expect(amb.json.data).toMatchObject({ valid: false, code: "AMBIGUOUS_SYMBOL" });
    expect(amb.json.data.candidates).toHaveLength(2);
    const junk = await call("GET", "/v1/symbols/validate?symbol=%00%01%02");
    expect(junk.json.data.valid).toBe(false);
  });

  it("POST /v1/symbols/validate checks up to 200 in order and refuses more", async () => {
    const r = await call("POST", "/v1/symbols/validate", { body: { items: [{ symbol: "NSE:RELIANCE" }, { symbol: "reliance", exchange: "BSE" }, { symbol: "NSE:NOPE" }] } });
    expect(r.status).toBe(200);
    expect(r.json.data.map((x) => [x.input, x.valid, x.symbol ?? x.code])).toEqual([
      ["NSE:RELIANCE", true, "NSE:RELIANCE"],
      ["reliance", true, "BSE:RELIANCE"],
      ["NSE:NOPE", false, "SYMBOL_NOT_FOUND"],
    ]);
    const many = await call("POST", "/v1/symbols/validate", { body: { items: Array.from({ length: 201 }, () => ({ symbol: "NSE:RELIANCE" })) } });
    expect(many.status).toBe(400);
    expect((await call("POST", "/v1/symbols/validate", { body: { items: [] } })).status).toBe(400);
    expect((await call("POST", "/v1/symbols/validate", { body: { items: [{ symbol: "NSE:RELIANCE", extra: 1 }] } })).status).toBe(400);
    expect((await call("POST", "/v1/symbols/validate", { body: { items: [{ symbol: 5 }] } })).status).toBe(400);
  });
});
