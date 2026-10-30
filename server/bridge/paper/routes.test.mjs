/**
 * S8 routes end to end through the real request pipeline (createApp): the real PaperEngine over the published
 * market-data and symbol fakes and a fake key store. Checks the OpenAPI shapes ({ data: PaperAccount, meta }), auth
 * and scopes, account access against the key, validation, auditing of resets and the `paper` config section.
 */
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createFakeMarketData } from "../market/fake.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { FILL_MODEL_TEXT } from "./fillModel.mjs";
import paperModule, { ROUTES } from "./module.mjs";

const READ = "mcb_read0000001_aaaaaaaaaaaaaaaaaaaa";
const PAPER = "mcb_paper000001_bbbbbbbbbbbbbbbbbbbb";
const LIMITED = "mcb_limit000001_cccccccccccccccccccc";
const KEYS = {
  [READ]: { id: "read0000001", label: "reader", scopes: ["read"], accounts: "*" },
  [PAPER]: { id: "paper000001", label: "paper trader", scopes: ["paper"], accounts: "*" },
  [LIMITED]: { id: "limit000001", label: "paper-2 only", scopes: ["paper"], accounts: ["paper-2"] },
};
const fakeKeyStore = { ...notImplementedService("keyStore"), authenticate: async (raw) => KEYS[raw] ?? null };
const audited = [];
const fakeAudit = {
  append: async (input) => {
    audited.push(input);
    return { ...input, seq: audited.length, at: "", prevHash: "", hash: "" };
  },
  query: async () => ({ items: [], nextCursor: null }),
  verify: async () => ({ ok: true, checked: 0, brokenAt: null }),
};

let app;
let port;

function call(path, { key = READ, method = "GET", body } = {}) {
  const headers = { host: `127.0.0.1:${port}` };
  if (key) headers.authorization = `Bearer ${key}`;
  const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
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

const raw = (dataDir, paper = { startingCapital: 2_000_000, slippageBps: 3 }) => ({
  server: { port: 0 },
  dataDir,
  accounts: [
    { id: "paper-1", broker: "paper" },
    { id: "paper-2", broker: "paper" },
  ],
  paper,
});

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-paper-routes-"));
  const { config } = loadConfig({ raw: raw(dataDir), env: {} });
  app = await createApp({
    config,
    modules: [paperModule],
    overrides: {
      keyStore: fakeKeyStore,
      audit: fakeAudit,
      marketData: createFakeMarketData({ prices: { "NSE:RELIANCE": 1400, "NSE:NIFTY": 25_000, "NFO:NIFTY-2026-10-27-25100-CE": 75, "NFO:NIFTY-2026-10-27-25200-CE": 45 } }),
      symbols: createFakeSymbolService(),
    },
    logger: createNullLogger(),
  });
  ({ port } = await app.listen());
});

afterAll(async () => {
  await app?.close?.();
});

describe("paper routes", () => {
  it("registers exactly the contract routes with their scopes", () => {
    const listed = app.router.list().filter((r) => r.module === "paper");
    expect(listed.map((r) => `${r.method} ${r.pattern} ${r.options.scope}`).sort()).toEqual(ROUTES.map(([m, p, o]) => `${m} ${p} ${o.scope}`).sort());
  });

  it("needs an API key", async () => {
    expect((await call("/v1/paper/accounts/paper-1", { key: null })).status).toBe(401);
  });

  it("GET returns the PaperAccount with funds and the fill model", async () => {
    const r = await call("/v1/paper/accounts/paper-1");
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({
      accountId: "paper-1",
      startingCapital: 2_000_000,
      createdAt: expect.stringMatching(/\+05:30$/),
      resetAt: null,
      ordersToday: 0,
      funds: { availableCash: 2_000_000, usedMargin: 0, totalBalance: 2_000_000, realisedPnl: 0, unrealisedPnl: 0, charges: 0, collateral: null, withdrawable: 2_000_000 },
      fillModel: FILL_MODEL_TEXT,
    });
    expect(r.json.meta).toEqual({ requestId: expect.any(String), accountId: "paper-1", mode: "paper" });
  });

  it("reflects orders placed through the engine", async () => {
    await app.deps.paper.place("paper-2", { symbol: "NSE:RELIANCE", side: "BUY", quantity: 10, product: "CNC", orderType: "MARKET" });
    const r = await call("/v1/paper/accounts/paper-2");
    expect(r.json.data.ordersToday).toBe(1);
    expect(r.json.data.funds.usedMargin).toBe(14_000);
  });

  it("404s an unknown account and 403s an account the key may not use", async () => {
    const a = await call("/v1/paper/accounts/nobody");
    expect(a.status).toBe(404);
    expect(a.json.code).toBe("ACCOUNT_NOT_FOUND");
    const b = await call("/v1/paper/accounts/paper-1", { key: LIMITED });
    expect(b.status).toBe(403);
    expect(b.json.code).toBe("ACCOUNT_FORBIDDEN");
    expect((await call("/v1/paper/accounts/paper-2", { key: LIMITED })).status).toBe(200);
  });

  it("reset needs the paper scope", async () => {
    const r = await call("/v1/paper/accounts/paper-1/reset", { method: "POST", body: {} });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("SCOPE_REQUIRED");
  });

  it("reset clears the book, sets capital, answers the fresh account and is audited", async () => {
    await app.deps.paper.place("paper-1", { symbol: "NSE:RELIANCE", side: "BUY", quantity: 5, product: "CNC", orderType: "MARKET" });
    audited.length = 0;
    const r = await call("/v1/paper/accounts/paper-1/reset", { key: PAPER, method: "POST", body: { startingCapital: 250_000 } });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ accountId: "paper-1", startingCapital: 250_000, ordersToday: 0, resetAt: expect.stringMatching(/\+05:30$/) });
    expect(r.json.data.funds.availableCash).toBe(250_000);
    expect(r.json.meta.mode).toBe("paper");
    expect(audited).toEqual([
      { type: "paper.reset", actor: { kind: "key", id: "paper000001" }, source: "rest", accountId: "paper-1", requestId: r.json.meta.requestId, data: { startingCapital: 250_000 } },
    ]);
  });

  it("reset with no body uses the configured starting capital", async () => {
    const r = await call("/v1/paper/accounts/paper-1/reset", { key: PAPER, method: "POST" });
    expect(r.status).toBe(200);
    expect(r.json.data.startingCapital).toBe(2_000_000);
  });

  it("reset validates its body", async () => {
    for (const body of [{ startingCapital: 5 }, { startingCapital: 2e9 }, { startingCapital: "1000000" }, { capital: 100_000 }]) {
      const r = await call("/v1/paper/accounts/paper-1/reset", { key: PAPER, method: "POST", body });
      expect(r.status).toBe(400);
      expect(r.json.code).toBe("VALIDATION_FAILED");
    }
    const bad = await call("/v1/paper/accounts/paper-1/reset", { key: PAPER, method: "POST", body: "{nope" });
    expect(bad.json.code).toBe("INVALID_JSON");
  });

  it("reset on an account the key may not use is refused before anything changes", async () => {
    const r = await call("/v1/paper/accounts/paper-1/reset", { key: LIMITED, method: "POST", body: { startingCapital: 50_000 } });
    expect(r.status).toBe(403);
    expect((await call("/v1/paper/accounts/paper-1")).json.data.startingCapital).toBe(2_000_000);
  });
});

describe("basket margin and undo reset", () => {
  const legs = [
    { symbol: "NFO:NIFTY-2026-10-27-25100-CE", side: "SELL", lots: 1, price: 75 },
    { symbol: "NFO:NIFTY-2026-10-27-25200-CE", side: "BUY", lots: 1, price: 45 },
  ];
  it("prices a hedged basket with the portfolio model and places nothing", async () => {
    const n = (await app.deps.paper.orders("paper-2")).items.length;
    const r = await call("/v1/paper/accounts/paper-2/margin", { method: "POST", body: { legs } });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ model: "portfolio", forwards: { NIFTY: 25_000 }, fallback: [] });
    expect(r.json.data.change).toBeCloseTo(r.json.data.after - r.json.data.before, 1);
    expect(r.json.data.standalone).toBeGreaterThan(r.json.data.alone * 2);
    expect(r.json.data.method).toMatch(/^Approximate, not the exchange's SPAN/);
    expect((await app.deps.paper.orders("paper-2")).items).toHaveLength(n);
  });
  it("validates the basket", async () => {
    for (const body of [{}, { legs: [] }, { legs: [{ symbol: "NSE:RELIANCE", side: "HOLD", lots: 1 }] }, { legs: [{ symbol: "NSE:RELIANCE", side: "BUY" }] }]) {
      const r = await call("/v1/paper/accounts/paper-2/margin", { method: "POST", body });
      expect(r.status).toBe(400);
    }
  });
  it("undo puts back the book from before a reset, once", async () => {
    await app.deps.paper.place("paper-2", { symbol: "NSE:RELIANCE", side: "BUY", quantity: 2, product: "CNC", orderType: "MARKET" });
    const before = (await call("/v1/paper/accounts/paper-2")).json.data;
    await call("/v1/paper/accounts/paper-2/reset", { key: PAPER, method: "POST", body: { startingCapital: 500_000 } });
    expect((await call("/v1/paper/accounts/paper-2/reset/undo", { method: "POST" })).status).toBe(403);
    const u = await call("/v1/paper/accounts/paper-2/reset/undo", { key: PAPER, method: "POST" });
    expect(u.status).toBe(200);
    expect(u.json.data.startingCapital).toBe(before.startingCapital);
    expect(u.json.data.funds.usedMargin).toBe(before.funds.usedMargin);
    const again = await call("/v1/paper/accounts/paper-2/reset/undo", { key: PAPER, method: "POST" });
    expect(again.json.code).toBe("INVALID_ORDER");
  });
});

describe("paper config section", () => {
  it("defaults to ₹10,00,000 and 5 bps when the section is absent", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-paper-cfg-"));
    const { config } = loadConfig({ raw: { ...raw(dataDir), paper: undefined }, env: {} });
    const a = await createApp({ config, modules: [paperModule], overrides: { keyStore: fakeKeyStore }, logger: createNullLogger() });
    expect(a.config.paper).toMatchObject({ startingCapital: 1_000_000, slippageBps: 5, squareOff: { enabled: true, time: "15:20" } });
  });

  it("rejects an invalid section", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-paper-cfg-"));
    for (const paper of [{ startingCapital: 100 }, { slippageBps: -1 }, { squareOff: { time: "3:20pm" } }, { unknownKey: 1 }]) {
      const { config } = loadConfig({ raw: raw(dataDir, paper), env: {} });
      await expect(createApp({ config, modules: [paperModule], overrides: { keyStore: fakeKeyStore }, logger: createNullLogger() })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });
});
