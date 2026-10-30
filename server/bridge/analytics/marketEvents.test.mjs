import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeError } from "../core/errors.mjs";
import { mapDeals, mapEvents, mapInsiders, marketEventsRoutes } from "./marketEvents.mjs";

// 2026-10-30T10:00:00Z
const T0 = Date.UTC(2026, 9, 30, 10, 0, 0);
const deal = (o = {}) => ({ BD_DT_DATE: "29-Oct-2026", BD_SYMBOL: "RELIANCE", BD_SCRIP_NAME: "Reliance", BD_CLIENT_NAME: "ACME FUND", BD_BUY_SELL: "BUY", BD_QTY_TRD: "1,00,000".replace(/,/g, ""), BD_TP_WATP: "2500", ...o });
const pit = (o = {}) => ({ symbol: "TCS", company: "TCS Ltd", acqName: "A Person", personCategory: "Promoter", secType: "Equity Shares", secAcq: "1000", secVal: "50000000", tdpTransactionType: "Buy", acqMode: "Market Purchase", date: "28-Oct-2026 16:00:00", ...o });
const ev = (o = {}) => ({ symbol: "INFY", company: "Infosys", purpose: "Financial Results", bm_desc: "Q2 results", date: "02-Nov-2026", ...o });
const ctx = (qs = "") => ({ requestId: "r1", query: new URLSearchParams(qs) });

const setup = (responses, extra = {}) => {
  let t = T0;
  const calls = [];
  const marketEventsFetcher = async (kind, params) => {
    calls.push({ kind, ...params });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  const routes = marketEventsRoutes({ marketEventsFetcher, clock: { now: () => t }, ...extra });
  const h = Object.fromEntries(routes.map(([, p, , fn]) => [p.split("/").pop(), fn]));
  return { h, calls, tick: (ms) => (t += ms) };
};

describe("market events routes", () => {
  it("declares three read routes", () => {
    const r = marketEventsRoutes({ marketEventsFetcher: async () => [] });
    expect(r.map(([m, p, o]) => [m, p, o])).toEqual([
      ["GET", "/v1/analytics/deals", { scope: "read" }],
      ["GET", "/v1/analytics/insiders", { scope: "read" }],
      ["GET", "/v1/analytics/events", { scope: "read" }],
    ]);
  });

  describe("deals", () => {
    it("maps rows, computes value in crore, summarises and reports meta", async () => {
      const { h, calls } = setup([{ data: [deal(), deal({ BD_CLIENT_NAME: "SELLER", BD_BUY_SELL: "SELL", BD_QTY_TRD: "200000", BD_TP_WATP: "2500" })] }]);
      const r = await h.deals(ctx("kind=block&days=3"));
      expect(calls[0]).toMatchObject({ kind: "block", from: "2026-10-27", to: "2026-10-30" });
      expect(r.data.deals[0]).toMatchObject({ date: "2026-10-29", symbol: "RELIANCE", side: "SELL", quantity: 200000, price: 2500, valueCr: 50 });
      expect(r.data.summary).toMatchObject({ deals: 2, buyCr: 25, sellCr: 50 });
      expect(r.data.summary.topBuyers[0]).toEqual({ client: "ACME FUND", valueCr: 25, deals: 1 });
      expect(r.data.summary.topSellers[0].client).toBe("SELLER");
      expect(r.meta).toMatchObject({ source: "nse", fetchedAt: new Date(T0).toISOString(), stale: false });
    });

    it("filters by minValue and symbol, and tolerates missing fields", async () => {
      const { h } = setup([[deal(), deal({ BD_SYMBOL: "TCS", BD_QTY_TRD: "10" }), deal({ BD_SYMBOL: "NOPRICE", BD_TP_WATP: "" })]]);
      expect((await h.deals(ctx("kind=bulk&minValue=10"))).data.deals.map((d) => d.symbol)).toEqual(["RELIANCE"]);
      const all = await h.deals(ctx("kind=bulk"));
      const np = all.data.deals.find((d) => d.symbol === "NOPRICE");
      expect(np.price).toBeNull();
      expect(np.valueCr).toBeNull();
      expect((await h.deals(ctx("kind=bulk&symbol=tcs"))).data.deals.map((d) => d.symbol)).toEqual(["TCS"]);
    });

    it("accepts the snapshot shape", () => {
      const rows = mapDeals({ BLOCK_DEALS_DATA: [{ symbol: "SBIN", clientName: "X", buySell: "BUY", qty: 10, watp: 100, session: "1" }], BULK_DEALS_DATA: [] });
      expect(rows[0]).toMatchObject({ symbol: "SBIN", side: "BUY", valueCr: 0 });
    });

    it("validates query", async () => {
      const { h } = setup([[]]);
      for (const q of ["", "kind=x", "kind=block&days=0", "kind=block&days=91", "kind=block&minValue=-1", "kind=block&minValue=abc", "kind=block&symbol=a b"])
        await expect(h.deals(ctx(q))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("returns an empty result for an empty list", async () => {
      const r = await setup([{ data: [] }]).h.deals(ctx("kind=block"));
      expect(r.data.deals).toEqual([]);
      expect(r.data.summary.deals).toBe(0);
    });
  });

  describe("insiders", () => {
    it("computes net buying and groups by symbol", async () => {
      const { h, calls } = setup([{ data: [pit(), pit({ symbol: "INFY", tdpTransactionType: "Sell", secVal: "20000000" }), pit({ symbol: "HDFC", tdpTransactionType: "Pledge" })] }]);
      const r = await h.insiders(ctx());
      expect(calls[0]).toMatchObject({ kind: "pit", from: "2026-09-30", to: "2026-10-30" });
      expect(r.data.disclosures.find((x) => x.symbol === "TCS")).toMatchObject({ date: "2026-10-28", symbol: "TCS", direction: "acquisition", valueCr: 5, securities: 1000, category: "Promoter", mode: "Market Purchase" });
      expect(r.data.summary).toMatchObject({ acquisitionCr: 5, disposalCr: 2, netCr: 3, bias: "net buying", other: 1 });
      expect(r.data.summary.topNetBuyers).toEqual([{ symbol: "TCS", netCr: 5 }]);
      expect(r.data.summary.topNetSellers).toEqual([{ symbol: "INFY", netCr: -2 }]);
      expect(r.meta.source).toBe("nse");
    });

    it("never emits NaN for junk numbers", () => {
      const [row] = mapInsiders([pit({ secAcq: "n/a", secVal: "-" })]);
      expect(row.securities).toBeNull();
      expect(row.valueCr).toBeNull();
    });

    it("validates days and symbol", async () => {
      const { h } = setup([[]]);
      for (const q of ["days=0", "days=91", "symbol=!!"]) await expect(h.insiders(ctx(q))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });
  });

  describe("events", () => {
    it("groups by day ascending with purpose", async () => {
      const { h, calls } = setup([[ev(), ev({ symbol: "ABB", company: "ABB", date: "02-Nov-2026" }), ev({ symbol: "WIPRO", date: "05-Nov-2026", purpose: "Board Meeting", bm_desc: "" })]]);
      const r = await h.events(ctx("days=7"));
      expect(calls[0]).toMatchObject({ kind: "events", from: "2026-10-30", to: "2026-11-06" });
      expect(r.data.days.map((d) => d.date)).toEqual(["2026-11-02", "2026-11-05"]);
      expect(r.data.days[0].events.map((e) => e.symbol)).toEqual(["ABB", "INFY"]);
      expect(r.data.days[1].events[0]).toMatchObject({ purpose: "Board Meeting", description: null });
      expect(r.meta.source).toBe("nse");
    });
  });

  describe("caching and errors", () => {
    it("caches per query within the TTL, dedupes in-flight, refetches after", async () => {
      const { h, calls, tick } = setup([[deal()]]);
      await Promise.all([h.deals(ctx("kind=block")), h.deals(ctx("kind=block"))]);
      await h.deals(ctx("kind=block"));
      expect(calls.length).toBe(1);
      await h.deals(ctx("kind=bulk"));
      expect(calls.length).toBe(2);
      tick(6 * 60_000);
      await h.deals(ctx("kind=block"));
      expect(calls.length).toBe(3);
    });

    it("serves stale data when a refresh fails, but surfaces the error with nothing cached", async () => {
      const { h, tick } = setup([[deal()], new BridgeError("UPSTREAM_ERROR", "down")]);
      await h.deals(ctx("kind=block"));
      tick(10 * 60_000);
      const r = await h.deals(ctx("kind=block"));
      expect(r.meta.stale).toBe(true);
      expect(r.data.deals.length).toBe(1);
      await expect(setup([new BridgeError("UPSTREAM_ERROR", "down")]).h.events(ctx())).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    });

    it("maps raw failures and changed shapes to UPSTREAM_ERROR", async () => {
      const raw = setup([new TypeError("boom")]).h.insiders(ctx());
      await expect(raw).rejects.toBeInstanceOf(BridgeError);
      await expect(raw).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
      for (const [route, q] of [["deals", "kind=block"], ["insiders", ""], ["events", ""]]) {
        await expect(setup([{ not: "rows" }]).h[route](ctx(q))).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
        await expect(setup([[{ unknownField: 1 }]]).h[route](ctx(q))).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
      }
      expect(() => mapEvents(null)).toThrow(BridgeError);
    });
  });

  describe("persistence", () => {
    const dirs = [];
    afterEach(() => {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });
    const tmp = () => {
      const d = mkdtempSync(join(tmpdir(), "mktev-"));
      dirs.push(d);
      return d;
    };
    const file = (d) => join(d, "analytics", "market-events.json");

    it("survives a restart, writes 0600 and serves persisted rows when the fetch fails", async () => {
      const d = tmp();
      await setup([[deal()]], { paths: { dataDir: d } }).h.deals(ctx("kind=block"));
      expect(statSync(file(d)).mode & 0o777).toBe(0o600);
      expect(readdirSync(join(d, "analytics")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
      const r = await setup([new BridgeError("UPSTREAM_ERROR", "down")], { paths: { dataDir: d }, clock: { now: () => T0 + 10 * 60_000 } }).h.deals(ctx("kind=block"));
      expect(r.data.deals.length).toBe(1);
      expect(r.meta.stale).toBe(true);
    });

    it("moves a corrupt file aside and carries on", async () => {
      const d = tmp();
      mkdirSync(join(d, "analytics"));
      writeFileSync(file(d), "{not json");
      const r = await setup([[deal()]], { paths: { dataDir: d } }).h.deals(ctx("kind=block"));
      expect(r.data.deals.length).toBe(1);
      expect(readdirSync(join(d, "analytics")).some((f) => f.startsWith("market-events.json.corrupt-"))).toBe(true);
      expect(Object.keys(JSON.parse(readFileSync(file(d), "utf8")).entries).length).toBe(1);
    });

    it("never fails a request on disk errors", async () => {
      const d = tmp();
      writeFileSync(join(d, "analytics"), "i am a file, not a dir");
      const warnings = [];
      const r = await setup([[deal()]], { paths: { dataDir: d }, logger: { warn: (...a) => warnings.push(a) } }).h.deals(ctx("kind=block"));
      expect(r.data.deals.length).toBe(1);
      expect(warnings.length).toBeGreaterThan(0);
    });
  });
});
