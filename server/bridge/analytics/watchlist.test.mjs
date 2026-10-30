import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeMarketData } from "../market/fake.mjs";
import { DEFAULT_LIST_NAME, DEFAULT_SYMBOLS, QUOTE_CHUNK, createWatchlists, watchlistRoutes } from "./watchlist.mjs";

const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup(prices = {}) {
  const dir = mkdtempSync(join(tmpdir(), "watchlists-"));
  dirs.push(dir);
  const marketData = createFakeMarketData({ prices });
  const deps = { marketData, clock: { now: () => Date.parse("2026-10-30T05:00:00Z") }, paths: { dataDir: dir } };
  const handlers = {};
  for (const [m, p, o, h] of watchlistRoutes(deps)) handlers[`${m} ${p}`] = { o, h };
  const call = (key, ctx = {}) => handlers[key].h({ requestId: "q", params: {}, query: new URLSearchParams(), principal: { kind: "local" }, ...ctx });
  const keyCtx = (id, extra = {}) => ({ principal: { kind: "key" }, key: { id, accounts: "*" }, scopes: new Set(["read"]), ...extra });
  return { dir, marketData, deps, handlers, call, keyCtx };
}
const L = "/v1/analytics/watchlists";
const body = (r) => JSON.parse(r.body);

describe("routes", () => {
  it("exposes the five routes, read scope, DELETE body none", () => {
    const { handlers } = setup();
    expect(Object.keys(handlers)).toEqual([`GET ${L}`, `POST ${L}`, `PUT ${L}/:listId`, `DELETE ${L}/:listId`, `GET ${L}/:listId/quotes`]);
    expect(handlers[`DELETE ${L}/:listId`].o).toEqual({ scope: "read", body: "none" });
    expect(handlers[`GET ${L}`].o).toEqual({ scope: "read" });
  });

  it("seeds the default list once per key and does not bring it back after delete", async () => {
    const { call, keyCtx } = setup();
    const first = (await call(`GET ${L}`, keyCtx("k1"))).data;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ name: DEFAULT_LIST_NAME, symbols: [...DEFAULT_SYMBOLS] });
    expect(first[0].keyId).toBeUndefined();
    expect(first[0].symbols.slice(0, 4)).toEqual(["NSE:NIFTY", "NSE:BANKNIFTY", "NSE:FINNIFTY", "BSE:SENSEX"]);
    expect((await call(`GET ${L}`, keyCtx("k1"))).data).toHaveLength(1);
    expect((await call(`GET ${L}`, keyCtx("k2"))).data).toHaveLength(1);
    await call(`DELETE ${L}/:listId`, { ...keyCtx("k1"), params: { listId: first[0].id } });
    expect((await call(`GET ${L}`, keyCtx("k1"))).data).toEqual([]);
  });

  it("creates, normalises, de-duplicates, updates, persists 0600, and deletes", async () => {
    const { dir, call, deps } = setup();
    const r = await call(`POST ${L}`, { body: { name: "  Banks ", symbols: ["hdfcbank", "NSE:HDFCBANK", "NSE:SBIN", "sensex"] } });
    expect(r.status).toBe(201);
    const made = body(r).data;
    expect(made).toMatchObject({ name: "Banks", symbols: ["NSE:HDFCBANK", "NSE:SBIN", "BSE:SENSEX"] });
    const file = join(dir, "analytics", "watchlists.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).lists.some((l) => l.id === made.id)).toBe(true);

    const up = (b) => call(`PUT ${L}/:listId`, { params: { listId: made.id }, body: b });
    expect((await up({ add: ["NSE:ICICIBANK", "NSE:SBIN"], remove: ["NSE:HDFCBANK"] })).data.symbols).toEqual(["NSE:SBIN", "BSE:SENSEX", "NSE:ICICIBANK"]);
    expect((await up({ name: "PSU", symbols: ["NSE:SBIN"] })).data).toMatchObject({ name: "PSU", symbols: ["NSE:SBIN"] });
    await expect(up({})).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(up({ symbols: ["NSE:SBIN"], add: ["NSE:TCS"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(up({ add: ["not a symbol!"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(createWatchlists(deps).get(made.id)).toMatchObject({ name: "PSU" }); // a fresh store reads it back
    expect((await call(`DELETE ${L}/:listId`, { params: { listId: made.id } })).data).toEqual({ id: made.id, deleted: true });
    await expect(up({ name: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("validates symbols, the 100-symbol cap and unknown fields", async () => {
    const { call } = setup();
    const create = (b) => call(`POST ${L}`, { body: b });
    await expect(create({ name: "x", symbols: ["NSE:OK", "bad symbol"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED", errors: [{ path: "symbols.1" }] });
    await expect(create({ name: "x", symbols: Array.from({ length: 101 }, (_, i) => `NSE:S${i}`) })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await create({ name: "x", symbols: Array.from({ length: 100 }, (_, i) => `NSE:S${i}`) })).status).toBe(201);
    await expect(create({ name: "", symbols: [] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(create({ name: "x", symbols: [], bogus: 1 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const list = (await call(`POST ${L}`, { body: { name: "full", symbols: Array.from({ length: 100 }, (_, i) => `NSE:T${i}`) } })).body;
    await expect(call(`PUT ${L}/:listId`, { params: { listId: JSON.parse(list).data.id }, body: { add: ["NSE:EXTRA"] } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("caps lists at 20 per key and hides other keys' lists", async () => {
    const { call, keyCtx } = setup();
    const k1 = keyCtx("k1");
    await call(`GET ${L}`, k1); // seeds the default: 1 of 20
    for (let i = 0; i < 19; i += 1) await call(`POST ${L}`, { body: { name: `l${i}`, symbols: [] }, ...k1 });
    await expect(call(`POST ${L}`, { body: { name: "one too many", symbols: [] }, ...k1 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await call(`POST ${L}`, { body: { name: "k2 ok", symbols: [] }, ...keyCtx("k2") })).status).toBe(201);
    const mine = (await call(`GET ${L}`, k1)).data;
    expect(mine).toHaveLength(20);
    const k2 = keyCtx("k2");
    expect((await call(`GET ${L}`, k2)).data.some((l) => l.name === "l0")).toBe(false);
    await expect(call(`GET ${L}/:listId/quotes`, { ...k2, params: { listId: mine[0].id } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call(`DELETE ${L}/:listId`, { ...k2, params: { listId: mine[0].id } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const admin = { principal: { kind: "key" }, key: { id: "root", accounts: "*" }, scopes: new Set(["read", "admin"]) };
    expect((await call(`GET ${L}`, admin)).data.length).toBeGreaterThan(20);
  });

  it("rolls a create back when the disk write fails", async () => {
    const { dir, call } = setup();
    await call(`GET ${L}`); // seed first, while the disk works
    rmSync(join(dir, "analytics"), { recursive: true, force: true });
    writeFileSync(join(dir, "analytics"), "a file where the directory should be");
    chmodSync(join(dir, "analytics"), 0o600);
    await expect(call(`POST ${L}`, { body: { name: "lost", symbols: [] } })).rejects.toMatchObject({ code: "INTERNAL" });
    const names = (await call(`GET ${L}`)).data.map((l) => l.name);
    expect(names).toEqual([DEFAULT_LIST_NAME]);
  });
});

describe("quotes", () => {
  const quoteList = async (call, id) => call(`GET ${L}/:listId/quotes`, { params: { listId: id } });

  it("returns day fields in list order, with per-symbol errors and freshness in meta", async () => {
    const { call, marketData } = setup();
    marketData.setQuote("NSE:HDFCBANK", { ltp: 1700, close: 1680, high: 1710, low: 1675, open: 1685, volume: 5_000_000, oi: 0 });
    marketData.setQuote("NSE:SBIN", { ltp: 800, close: 810, high: 812, low: 795, volume: 9_000_000 });
    marketData.fail("NSE:INFY", "UPSTREAM_ERROR");
    const made = body(await call(`POST ${L}`, { body: { name: "t", symbols: ["NSE:SBIN", "NSE:INFY", "NSE:HDFCBANK", "NSE:NOPRICE"] } })).data;
    const r = await quoteList(call, made.id);
    expect(r.data.items.map((i) => i.symbol)).toEqual(["NSE:SBIN", "NSE:HDFCBANK"]);
    expect(r.data.items[1]).toMatchObject({ ltp: 1700, change: 20, dayHigh: 1710, dayLow: 1675, volume: 5_000_000, prevClose: 1680 });
    expect(r.data.items[1].changePct).toBeCloseTo(1.1905, 3);
    expect(r.data.items[0]).toMatchObject({ change: -10, oi: null });
    expect(r.errors.map((e) => [e.symbol, e.code])).toEqual([["NSE:INFY", "UPSTREAM_ERROR"], ["NSE:NOPRICE", "SYMBOL_NOT_FOUND"]]);
    expect(r.meta).toMatchObject({ requested: 4, quoted: 2, stale: false, freshness: { source: "broker" } });
  });

  it("batches into chunks, and a failed chunk only fills errors", async () => {
    const { call, marketData } = setup();
    const syms = Array.from({ length: QUOTE_CHUNK + 10 }, (_, i) => `NSE:S${i}`);
    for (const s of syms) marketData.setQuote(s, { ltp: 10 });
    const made = body(await call(`POST ${L}`, { body: { name: "big", symbols: syms } })).data;
    const r = await quoteList(call, made.id);
    expect(r.data.items).toHaveLength(syms.length);
    expect(marketData.calls.filter((c) => c[0] === "quotes").map((c) => c[1].length)).toEqual([QUOTE_CHUNK, 10]);

    const orig = marketData.quotes;
    let n = 0;
    marketData.quotes = async (...a) => {
      if (n++ === 1) throw new Error("boom with secrets");
      return orig(...a);
    };
    const r2 = await quoteList(call, made.id);
    expect(r2.data.items).toHaveLength(QUOTE_CHUNK);
    expect(r2.errors).toHaveLength(10);
    expect(r2.errors[0]).toEqual({ symbol: syms[QUOTE_CHUNK], code: "INTERNAL", message: "The quote read failed." });
  });

  it("the default list is quoted with a single marketData.quotes call", async () => {
    const { call, marketData } = setup();
    const id = (await call(`GET ${L}`)).data[0].id;
    const r = await quoteList(call, id);
    expect(marketData.calls.filter((c) => c[0] === "quotes")).toHaveLength(1);
    expect(r.errors).toHaveLength(DEFAULT_SYMBOLS.length); // the fake has no prices, so every symbol is an error, not a throw
    expect(r.data.items).toEqual([]);
  });

  it("an empty list needs no market data call", async () => {
    const { call, marketData } = setup();
    const made = body(await call(`POST ${L}`, { body: { name: "empty" } })).data;
    expect((await quoteList(call, made.id)).data).toMatchObject({ count: 0, items: [] });
    expect(marketData.calls).toEqual([]);
  });
});
