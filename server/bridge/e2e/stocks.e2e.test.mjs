/**
 * Stock options end to end (docs/spec/p1-06-stocks.md §9.5): a real demo Bridge (every module, HTTP on an ephemeral
 * port). Steps share the Bridge and run in order:
 *  1. the F&O underlying list (indices, 50 stocks, lots, steps, ban band);
 *  2. stock expiries and a stock chain with a fractional strike and the contract facts;
 *  3. the server sweep: plan, 202, join, progress to done, chains with ΔOI basis, HV; the sweep's own calls never
 *     take more than 50 % of the quote class in any second (the demo recorder is off here);
 *  4. the ban gate on a paper ticket: open, force a ban, opening refused, closing allowed, then refused again;
 *  5. expiry costs at E-2 (₹842.22 / ₹55.96);
 *  6. sweep settings: admin from this computer (persisted false in demo), refused for a read key;
 *  7. back-compat of /v1/expiries and /v1/optionchain for NIFTY.
 */
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { createNullLogger } from "../core/logger.mjs";

const READ = "mcb_e2eread0001_aaaaaaaaaaaaaaaaaaaa";
const ADMIN = "mcb_e2eadmin001_bbbbbbbbbbbbbbbbbbbb";
const KEYS = {
  [READ]: { id: "e2eread0001", label: "reader", scopes: ["read"], accounts: "*" },
  [ADMIN]: { id: "e2eadmin001", label: "admin", scopes: ["admin", "paper"], accounts: "*" },
};
const keyStore = { ...notImplementedService("keyStore"), authenticate: async (raw) => KEYS[raw] ?? null };

let app;
let port;
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
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-stocks-e2e-"));
  const { config } = loadConfig({ raw: { dataDir, server: { port: 0 }, logging: { level: "silent" }, fno: { demo: { callDelayMs: 0 } }, recorder: { enabled: false } }, env: {}, demo: true });
  app = await createApp({ config, overrides: { keyStore }, logger: createNullLogger() });
  ({ port } = await app.listen());
}, 30_000);

afterAll(async () => {
  await app?.close();
});

describe("stock options end to end (demo)", () => {
  let relExpiry;

  it("1. GET /v1/options/underlyings: indices and ≥ 50 stocks with lots, settlement, steps and 2–3 in ban", async () => {
    const r = await http("/v1/options/underlyings");
    expect(r.status).toBe(200);
    const d = r.json.data;
    expect(d.counts.index).toBeGreaterThanOrEqual(3);
    expect(d.counts.stock).toBeGreaterThanOrEqual(50);
    expect(d.items.find((i) => i.underlying === "RELIANCE")).toMatchObject({ lot: 525, settlement: "physical", strikeStep: 20 });
    expect(d.items.find((i) => i.underlying === "TATASTEEL").strikeStep).toBe(2.5);
    expect(d.counts.inBan).toBeGreaterThanOrEqual(2);
    expect(d.counts.inBan).toBeLessThanOrEqual(3);
  });

  it("2. RELIANCE lists 3 monthly expiries; the TATASTEEL chain is a stock chain with 167.5 and OI in whole lots", async () => {
    const e = await http("/v1/expiries?underlying=RELIANCE");
    expect(e.json.data.expiries).toHaveLength(3);
    relExpiry = e.json.data.expiries[0];
    const te = (await http("/v1/expiries?underlying=TATASTEEL")).json.data.expiries[0];
    const c = await http(`/v1/optionchain?underlying=TATASTEEL&expiry=${te}`);
    expect(c.status).toBe(200);
    expect(c.json.data).toMatchObject({ underlyingKind: "stock", settlement: "physical", strikeStep: 2.5, lotSize: 4475 });
    expect(c.json.data.rows.map((r) => r.strike)).toContain(167.5);
    for (const r of c.json.data.rows) for (const leg of [r.ce, r.pe]) if (leg?.oi) expect(leg.oi % 4475).toBe(0);
  });

  it("3. the sweep: plan fits with two groups, 202 then joined, done with ≥ 50 stock chains, ΔOI basis, HV; the sweep uses ≤ 50 % of the quote class", async () => {
    const plan = await http("/v1/options/sweeps/plan", { method: "POST", body: {} });
    expect(plan.json.data.fits).toBe(true);
    expect(plan.json.data.groups.map((g) => g.kind)).toEqual(["index", "stock"]);
    // The sweep's own broker calls (background priority), timed when the scheduler starts them. The demo also has
    // user-priority traffic of its own (the demo book's paper fills read quotes at "live" priority), which may use the
    // whole window: users always go first; only the sweep is held to 50 %.
    const starts = [];
    const sch = app.deps.scheduler;
    const orig = sch.schedule.bind(sch);
    sch.schedule = (o, fn) => (o.priority === "background" ? orig(o, (...args) => (starts.push({ cls: o.endpointClass, at: Date.now(), cost: o.cost ?? 1 }), fn(...args))) : orig(o, fn));
    const start = await http("/v1/options/sweeps", { method: "POST", body: {} });
    expect(start.status).toBe(202);
    const join = await http("/v1/options/sweeps", { method: "POST", body: {} });
    expect([join.status, join.json.data.joined]).toEqual([200, true]);
    let status = "running";
    let limit = null;
    for (let i = 0; i < 600 && status === "running"; i += 1) {
      const u = await http("/v1/usage");
      limit ??= (u.json.data.accounts.find((a) => a.accountId === "demo" || a.id === "demo") ?? u.json.data.accounts[0]).classes.quote.limit;
      status = (await http("/v1/options/sweeps/current?lease=1")).json.data.status;
      if (status === "running") await sleep(150);
    }
    sch.schedule = orig;
    expect(status).toBe("done");
    // In any one-second window the sweep's quote (and quote-family) calls stay within half of the class's limit.
    const perWindow = (pred) => Math.max(0, ...starts.filter(pred).map((x) => starts.filter((y) => pred(y) && y.at >= x.at && y.at < x.at + 1000).reduce((a, y) => a + y.cost, 0)));
    expect(starts.length).toBeGreaterThan(10);
    expect(perWindow((x) => x.cls === "quote")).toBeLessThanOrEqual(0.5 * limit);
    expect(perWindow((x) => x.cls === "quote" || x.cls === "chain" || x.cls === "depth")).toBeLessThanOrEqual(0.5 * limit);
    const items = [];
    let since = 0;
    let last;
    for (let i = 0; i < 20; i += 1) {
      last = (await http(`/v1/options/sweeps/current/chains?since=${since}`)).json.data;
      items.push(...last.items);
      since = last.nextCursor;
      if (last.done) break;
    }
    const stockChains = items.filter((x) => x.chain.underlyingKind === "stock");
    expect(stockChains.length).toBeGreaterThanOrEqual(50);
    expect(stockChains.every((x) => x.chain.rows.some((r) => r.ce?.oiChangeBasis))).toBe(true);
    expect(Object.keys(last.hv).length).toBeGreaterThanOrEqual(50);
  }, 120_000);

  it("4. ban gate: buy opens; after a forced ban another buy is FNO_BAN, a sell closes with a warning, then a sell is FNO_BAN", async () => {
    const chain = (await http(`/v1/optionchain?underlying=RELIANCE&expiry=${relExpiry}&strikes=1`)).json.data;
    const symbol = chain.rows.find((r) => r.strike === chain.atmStrike).ce.symbol;
    const order = (side) => ({ account: "demo-paper", symbol, side, lots: 1, product: "MARGIN", orderType: "MARKET" });
    const buy = await http("/v1/orders", { method: "POST", key: ADMIN, body: order("BUY") });
    expect(buy.status).toBeLessThan(300);
    const forced = await http("/v1/demo/fno", { method: "POST", key: ADMIN, body: { ban: ["RELIANCE"] } });
    expect(forced.json.data.ban).toEqual(["RELIANCE"]);
    const more = await http("/v1/orders/preview", { method: "POST", key: ADMIN, body: order("BUY") });
    expect(more.json.data.ok).toBe(false);
    expect(more.json.data.checks.find((c) => c.code === "FNO_BAN").severity).toBe("block");
    const close = await http("/v1/orders/preview", { method: "POST", key: ADMIN, body: order("SELL") });
    expect(close.json.data.ok).toBe(true);
    expect(close.json.data.checks.map((c) => c.message)).toContain("Closing order in a ban-period stock.");
    const sold = await http("/v1/orders", { method: "POST", key: ADMIN, body: order("SELL") });
    expect(sold.json.data.status).toBe("filled");
    const again = await http("/v1/orders", { method: "POST", key: ADMIN, body: order("SELL") });
    expect([again.status, again.json.code, again.json.errors[0].path]).toEqual([422, "INVALID_ORDER", "FNO_BAN"]);
    await http("/v1/demo/fno", { method: "POST", key: ADMIN, body: { ban: [] } });
  });

  it("5. expiry costs at E-2 for +500 × 1420 CE at spot 1,452.30, bid 33.80: ₹842.22 to settle, ₹55.96 to square off", async () => {
    const detail = (await http("/v1/options/underlyings/RELIANCE")).json.data;
    const e2 = detail.deliveryMargin.items.find((x) => x.day === "E-2").date;
    const r = await http("/v1/options/expiry-costs", { method: "POST", body: { underlying: "RELIANCE", asOf: e2, spot: 1452.3, varElmPct: 20, legs: [{ symbol: `NFO:RELIANCE-${detail.deliveryMargin.expiry}-1420-CE`, qty: 500, bid: 33.8, ask: 34.2 }] } });
    expect(r.status).toBe(200);
    expect(r.json.data.day).toBe("E-2");
    expect(r.json.data.legs[0]).toMatchObject({ moneyness: "ITM", settle: { total: 842.22 }, squareOff: { total: 55.96 }, deliveryMargin: { pct: 45, indicative: 65353.5 } });
  });

  it("6. sweep settings: admin on this computer gets persisted false (demo); a read key gets 403", async () => {
    const ok = await http("/v1/options/sweeps/settings", { method: "PUT", key: ADMIN, body: { optIn: ["RELIANCE", "SBIN"] } });
    expect([ok.status, ok.json.data.persisted]).toEqual([200, false]);
    const ro = await http("/v1/options/sweeps/settings", { method: "PUT", key: READ, body: { optIn: ["RELIANCE"] } });
    expect(ro.status).toBe(403);
  });

  it("7. back-compat: /v1/expiries and /v1/optionchain for NIFTY keep their shape", async () => {
    const e = await http("/v1/expiries?underlying=NIFTY");
    expect(Object.keys(e.json.data).sort()).toEqual(["expiries", "freshness", "underlying"]);
    const c = await http(`/v1/optionchain?underlying=NIFTY&expiry=${e.json.data.expiries[0]}`);
    for (const k of ["underlying", "expiry", "rows", "freshness", "underlyingLtp", "atmStrike", "lotSize"]) expect(c.json.data).toHaveProperty(k);
    expect(c.json.data).toMatchObject({ underlyingKind: "index", settlement: "cash" });
  });
});
