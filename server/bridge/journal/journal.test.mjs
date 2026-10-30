/**
 * The trade journal end to end: fills from the orders service grouped into trades, daily P&L from the paper engine,
 * tags and notes stored in the Bridge home, account access by key, demo sample history, and no order ever placed.
 */
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import journalModule, { ROUTES } from "./module.mjs";
import { createJournalService } from "./journalService.mjs";
import { demoJournalHistory } from "./demoHistory.mjs";
import { buildTrades, statsOf } from "../dashboard/journal-core.js";

const READ = "mcb_read0000001_aaaaaaaaaaaaaaaaaaaa";
const PAPER = "mcb_paper000001_bbbbbbbbbbbbbbbbbbbb";
const LIMITED = "mcb_limit000001_cccccccccccccccccccc";
const KEYS = {
  [READ]: { id: "read0000001", label: "reader", scopes: ["read"], accounts: "*" },
  [PAPER]: { id: "paper000001", label: "paper trader", scopes: ["paper"], accounts: "*" },
  [LIMITED]: { id: "limit000001", label: "paper-2 only", scopes: ["paper"], accounts: ["paper-2"] },
};
const CE = "NFO:NIFTY-2026-11-03-26800-CE";
const PE = "NFO:NIFTY-2026-11-03-25800-PE";
const fills = {
  "paper-1": [
    { tradeId: "a", accountId: "paper-1", symbol: CE, side: "SELL", qty: 65, price: 100, charges: 20, tradedAt: "2026-10-27T09:30:00+05:30", mode: "paper" },
    { tradeId: "b", accountId: "paper-1", symbol: PE, side: "SELL", qty: 65, price: 90, charges: 20, tradedAt: "2026-10-27T09:30:05+05:30", mode: "paper" },
    { tradeId: "c", accountId: "paper-1", symbol: CE, side: "BUY", qty: 65, price: 40, charges: 20, tradedAt: "2026-10-29T14:00:00+05:30", mode: "paper" },
    { tradeId: "d", accountId: "paper-1", symbol: PE, side: "BUY", qty: 65, price: 30, charges: 20, tradedAt: "2026-10-29T14:00:05+05:30", mode: "paper" },
  ],
  "paper-2": [{ tradeId: "e", accountId: "paper-2", symbol: CE, side: "BUY", qty: 65, price: 50, charges: 20, tradedAt: "2026-10-30T10:00:00+05:30", mode: "paper" }],
};
let placed = 0;
const orders = {
  ...notImplementedService("orders"),
  trades: async (_ctx, { accountId }) => ({ items: fills[accountId] ?? [], nextCursor: null }),
  positions: async (_ctx, accountId) => ({ items: accountId === "paper-2" ? [{ symbol: CE, netQty: 65, ltp: 70 }] : [] }),
  place: async () => {
    placed += 1;
  },
};
const paper = { ...notImplementedService("paper"), daily: async (id) => (id === "paper-1" ? [{ day: "2026-10-29", pnl: 7720, equity: 1_007_720, source: "eod" }] : [{ day: "2026-10-29", pnl: -100, equity: 999_900, source: "eod" }]) };

let app;
let port;
let dataDir;
function call(path, { key = READ, method = "GET", body } = {}) {
  const headers = { host: `127.0.0.1:${port}` };
  if (key) headers.authorization = `Bearer ${key}`;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let json;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mcb-journal-"));
  const { config } = loadConfig({ raw: { server: { port: 0 }, dataDir, accounts: [{ id: "paper-1", broker: "paper" }, { id: "paper-2", broker: "paper" }] }, env: {} });
  app = await createApp({ config, modules: [journalModule], overrides: { keyStore: { ...notImplementedService("keyStore"), authenticate: async (raw) => KEYS[raw] ?? null }, orders, paper }, logger: createNullLogger() });
  ({ port } = await app.listen());
});
afterAll(async () => {
  await app?.close?.();
});

describe("journal routes", () => {
  it("registers exactly its routes", () => {
    const listed = app.router.list().filter((r) => r.module === "journal");
    expect(listed.map((r) => `${r.method} ${r.pattern} ${r.options.scope}`).sort()).toEqual(ROUTES.map(([m, p, o]) => `${m} ${p} ${o.scope}`).sort());
  });

  it("groups fills into trades with P&L, sums daily P&L across accounts and adds stats", async () => {
    const r = await call("/v1/journal");
    expect(r.status).toBe(200);
    const { trades, daily, stats, accounts } = r.json.data;
    expect(accounts).toEqual(["paper-1", "paper-2"]);
    expect(trades).toHaveLength(2);
    const closed = trades.find((t) => t.status === "closed");
    expect(closed).toMatchObject({ account: "paper-1", structure: "Short strangle", pnl: (100 + 90 - 40 - 30) * 65 - 80 });
    expect(trades.find((t) => t.status === "open")).toMatchObject({ account: "paper-2", pnl: (70 - 50) * 65 - 20 });
    expect(daily).toEqual([{ day: "2026-10-29", pnl: 7620, accounts: 2 }]);
    expect(stats.byStructure[0]).toMatchObject({ key: "Short strangle", n: 1, wins: 1 });
    expect(placed).toBe(0);
  });

  it("scopes to the accounts a key may use, and to ?account=", async () => {
    const lim = await call("/v1/journal", { key: LIMITED });
    expect(lim.json.data.accounts).toEqual(["paper-2"]);
    expect((await call("/v1/journal?account=paper-1", { key: LIMITED })).status).toBe(403);
    expect((await call("/v1/journal?account=paper-1")).json.data.trades).toHaveLength(1);
  });

  it("stores tags, notes and setup by trade id (paper scope), validated, in the Bridge home", async () => {
    const id = (await call("/v1/journal")).json.data.trades.find((t) => t.status === "closed").id;
    expect((await call(`/v1/journal/trades/${id}`, { method: "PUT", body: { tags: ["weekly"] } })).status).toBe(403);
    expect((await call(`/v1/journal/trades/${id}`, { key: PAPER, method: "PUT", body: { colour: "red" } })).status).toBe(400);
    expect((await call("/v1/journal/trades/nope", { key: PAPER, method: "PUT", body: { notes: "x" } })).status).toBe(400);
    const ok = await call(`/v1/journal/trades/${id}`, { key: PAPER, method: "PUT", body: { tags: ["weekly", " Weekly ", "event"], notes: " Took half the credit. ", setup: "IV rank above 60" } });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ id, tags: ["weekly", "event"], notes: "Took half the credit.", setup: "IV rank above 60" });
    const again = (await call("/v1/journal")).json.data.trades.find((t) => t.id === id);
    expect(again).toMatchObject({ tags: ["weekly", "event"], setup: "IV rank above 60" });
    const file = join(dataDir, "journal", "journal.json");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).not.toMatch(/mcb_/);
  });
});

describe("demo history", () => {
  const NOW = Date.parse("2026-10-30T11:00:00+05:30");
  it("is deterministic, weeks long, mostly closed trades with tags and a daily row per active day", () => {
    const a = demoJournalHistory({ nowMs: NOW, account: "demo-paper" });
    const b = demoJournalHistory({ nowMs: NOW, account: "demo-paper" });
    expect(a.fills).toEqual(b.fills);
    const trades = buildTrades(a.fills, { notes: a.notes });
    const closed = trades.filter((t) => t.status === "closed");
    expect(closed.length).toBeGreaterThanOrEqual(15);
    expect(closed.length).toBe(trades.length);
    expect(new Set(closed.map((t) => t.underlying))).toEqual(new Set(["NIFTY", "BANKNIFTY", "SENSEX"]));
    const s = statsOf(closed);
    expect(s.winRate).toBeGreaterThan(30);
    expect(s.winRate).toBeLessThan(90);
    expect(trades.filter((t) => t.tags.length).length).toBeGreaterThan(5);
    expect(a.daily.length).toBeGreaterThan(15);
    expect(a.daily.every((d) => d.day < "2026-10-30")).toBe(true);
    // The daily rows add up to the closed trades' P&L (the swings of open trades unwind by their close).
    const sumDaily = a.daily.reduce((x, d) => x + d.pnl, 0);
    expect(sumDaily).toBeCloseTo(s.total, 0);
  });

  it("is served in demo mode only, once, merged with the demo account's own rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-journal-demo-"));
    const deps = { paths: { dataDir: dir }, clock: { now: () => NOW }, logger: createNullLogger(), config: { demo: true, accounts: [{ id: "demo-paper", broker: "paper" }] }, orders: { trades: async () => ({ items: [] }), positions: async () => ({ items: [] }) }, paper: { daily: async () => [{ day: "2026-10-29", pnl: 1, equity: 1, source: "eod" }] } };
    const svc = createJournalService(deps);
    const j = await svc.journal({}, [{ id: "demo-paper", broker: "paper" }]);
    expect(j.demo).toBe(true);
    expect(j.trades.length).toBeGreaterThan(10);
    expect(j.trades.every((t) => t.sample)).toBe(true);
    expect(j.dailyByAccount["demo-paper"].find((d) => d.day === "2026-10-29")).toMatchObject({ pnl: 1 });
    const off = createJournalService({ ...deps, paths: { dataDir: mkdtempSync(join(tmpdir(), "mcb-journal-off-")) }, config: { accounts: deps.config.accounts } });
    expect((await off.journal({}, [{ id: "demo-paper", broker: "paper" }])).trades).toEqual([]);
  });
});
