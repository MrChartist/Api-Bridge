import { describe, expect, it } from "vitest";
import { createFakeMarketData } from "../market/fake.mjs";
import { FIELDS, FIELD_CATALOGUE_VERSION } from "./fieldCatalogue.mjs";
import { aggregatePeriods, buildGrid, fieldsRoutes, fillPrevious, parseOverride, resolveField, searchFields } from "./fields.mjs";

const NOW = Date.parse("2026-10-30T10:00:00+05:30");
const OPT = "NFO:NIFTY-2026-11-03-25000-CE";
const FUT = "NFO:NIFTY-2026-11-24-FUT";
const ctx = (query, body) => ({ query: new URLSearchParams(query), body, requestId: "r1", principal: { kind: "local" }, requireAccountAccess() {} });
const sec = (d) => Date.parse(`${d}T00:00:00+05:30`) / 1000;
const bar = (d, o, h, l, c, v) => ({ time: sec(d), open: o, high: h, low: l, close: c, volume: v });

function legs(strike, ce, pe) {
  const mk = (right, ltp, iv, delta) => ({ symbol: `NFO:NIFTY-2026-11-03-${strike}-${right}`, ltp, bid: ltp - 1, ask: ltp + 1, oi: 1000, oiChange: 50, volume: 10, iv, delta, gamma: 0.001, theta: -5, vega: 9, greeksSource: "broker" });
  return { strike, ce: mk("CE", ce, 14, 0.52), pe: mk("PE", pe, 16, -0.48) };
}

function setup() {
  const md = createFakeMarketData({ prices: { "NSE:NIFTY": 25000, [FUT]: 25040, "NSE:RELIANCE": 1400 } });
  md.setQuote("NSE:RELIANCE", { ltp: 1400, close: 1390, volume: 100 });
  md.setExpiries("NIFTY", ["2026-10-27", "2026-11-03", "2026-11-24"]);
  md.setChain("NIFTY", "2026-11-03", { underlyingLtp: 25000, lotSize: 75, rows: [legs(24950, 120, 60), legs(25000, 90, 85), legs(25050, 60, 120)] });
  md.setPrice(OPT, 90);
  md.setCandles("NSE:NIFTY", "1d", [bar("2026-10-26", 100, 110, 95, 105, 10), bar("2026-10-27", 105, 120, 100, 118, 20), bar("2026-10-30", 118, 119, 90, 92, 5)]);
  md.setCandles("NSE:RELIANCE", "5m", [{ time: sec("2026-10-30") + 36000, open: 1, high: 1402, low: 1398, close: 1400, volume: 100 }, { time: sec("2026-10-30") + 36300, open: 1, high: 1406, low: 1402, close: 1404, volume: 300 }]);
  const routes = Object.fromEntries(fieldsRoutes({ marketData: md, clock: { now: () => NOW } }).map(([m, p, o, h]) => [`${m} ${p}`, { o, h }]));
  return { md, routes, get: (p, q) => routes[`GET ${p}`].h(ctx(q)) };
}

describe("catalogue", () => {
  it("is well formed", () => {
    expect(FIELD_CATALOGUE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(new Set(FIELDS.map((f) => f.id)).size).toBe(FIELDS.length);
    for (const f of FIELDS) {
      for (const k of ["description", "category", "dataType", "cadence", "source", "example", "excelCall"]) expect(f[k], `${f.id}.${k}`).toBeTruthy();
      expect(f.applies_to.length).toBeGreaterThan(0);
      expect(["realtime", "eod"]).toContain(f.cadence);
      expect(f.excelCall.startsWith("=MC.BD")).toBe(true);
    }
    for (const id of ["ltp", "bid", "ask", "open", "high", "low", "close", "prev_close", "change", "change_pct", "volume", "oi", "oi_change", "vwap", "iv", "delta", "gamma", "theta", "vega", "atm_iv", "pcr_oi", "max_pain", "lot_size", "expiry", "strike", "option_type", "basis"]) expect(resolveField(id)?.id).toBe(id);
  });
  it("resolves aliases and ranks search", () => {
    expect(resolveField("Open  Interest")?.id).toBe("oi");
    expect(searchFields("open interest")[0].id).toBe("oi");
    expect(searchFields("pcr")[0].id).toBe("pcr_oi");
    expect(searchFields("", { category: "greeks" }).map((f) => f.id)).toEqual(["delta", "gamma", "theta", "vega"]);
    expect(searchFields("zzzz")).toEqual([]);
  });
  it("parses overrides", () => {
    expect(parseOverride("expiry:2026-11-27,rate:6.5")).toEqual({ expiry: "2026-11-27", rate: 6.5 });
    expect(() => parseOverride("rate:abc")).toThrow();
    expect(() => parseOverride("foo:1")).toThrow();
    expect(() => parseOverride("expiry:2026-13-01")).toThrow();
  });
});

describe("routes shape", () => {
  it("are read scoped", () => {
    const list = fieldsRoutes({ marketData: createFakeMarketData() });
    expect(list.map(([m, p, o]) => `${m} ${p} ${o.scope}`)).toEqual(["GET /v1/fields/search read", "GET /v1/fields read", "GET /v1/fields/history read", "GET /v1/fields/bulk read", "POST /v1/batch read"]);
  });
  it("search route json and csv", async () => {
    const { get } = setup();
    const r = await get("/v1/fields/search", "q=open+interest");
    expect(r.data.fields[0].id).toBe("oi");
    expect(r.meta.catalogueVersion).toBe(FIELD_CATALOGUE_VERSION);
    const c = await get("/v1/fields/search", "q=iv&format=csv");
    expect(c.headers["Content-Type"]).toMatch(/text\/csv/);
    expect(c.body.split("\r\n")[0].startsWith("id,category")).toBe(true);
    await expect(get("/v1/fields/search", "category=nope")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("BDP grid", () => {
  it("batches quotes in one call and nulls fields that do not apply", async () => {
    const { md, get } = setup();
    const r = await get("/v1/fields", `symbols=NSE:NIFTY,NSE:RELIANCE,${FUT}&fields=ltp,change_pct,oi,prev_close`);
    expect(md.calls.filter((c) => c[0] === "quotes")).toHaveLength(1);
    expect(md.calls.some((c) => ["optionChain", "expiries"].includes(c[0]))).toBe(false);
    const by = Object.fromEntries(r.data.rows.map((x) => [x.symbol, x.values]));
    expect(by["NSE:RELIANCE"]).toMatchObject({ ltp: 1400, prev_close: 1390, oi: null });
    expect(by["NSE:RELIANCE"].change_pct).toBeCloseTo(0.7194, 3);
    expect(by[FUT].ltp).toBe(25040);
    expect(r.errors.filter((e) => e.code === "FIELD_NOT_APPLICABLE").map((e) => `${e.symbol}|${e.field}`).sort()).toEqual(["NSE:NIFTY|oi", "NSE:RELIANCE|oi"]);
    expect(r.data.rows[0].freshness.source).toBe("broker");
  });
  it("reads option greeks from one chain call, and iv under a rate override", async () => {
    const { md, get } = setup();
    const r = await get("/v1/fields", `symbols=${OPT},NFO:NIFTY-2026-11-03-25000-PE&fields=iv,delta,oi_change,strike,option_type,lot_size,expiry`);
    expect(md.calls.filter((c) => c[0] === "optionChain")).toHaveLength(1);
    expect(r.data.rows[0].values).toMatchObject({ iv: 14, delta: 0.52, oi_change: 50, strike: 25000, option_type: "CE", lot_size: 75, expiry: "2026-11-03" });
    expect(r.data.rows[1].values.delta).toBe(-0.48);
    expect(r.errors).toEqual([]);
    const o = await get("/v1/fields", `symbols=${OPT}&fields=iv,delta&override=rate:0`);
    expect(o.data.rows[0].values.iv).toBeGreaterThan(0);
    expect(o.data.rows[0].values.iv).not.toBe(14);
    expect(o.meta.overrides).toEqual({ rate: 0 });
  });
  it("underlying fields use the nearest upcoming expiry, or the override", async () => {
    const { md, get } = setup();
    const r = await get("/v1/fields", "symbols=NSE:NIFTY&fields=atm_iv,pcr_oi,max_pain,next_expiry");
    expect(r.data.rows[0].values).toMatchObject({ atm_iv: 15, pcr_oi: 1, max_pain: 25000, next_expiry: "2026-11-03" });
    expect(md.calls.filter((c) => c[0] === "expiries")).toHaveLength(1);
    expect(md.calls.find((c) => c[0] === "optionChain")[1].expiry).toBe("2026-11-03");
    const o = await get("/v1/fields", "symbols=NSE:NIFTY&fields=atm_iv&override=expiry:2026-11-24");
    expect(o.data.rows[0].values.atm_iv).toBeNull();
    expect(o.errors).toHaveLength(1);
    expect(o.errors[0]).toMatchObject({ symbol: "NSE:NIFTY", field: "atm_iv" });
  });
  it("an expiry override swaps the option's expiry for iv", async () => {
    const { md, get } = setup();
    const r = await get("/v1/fields", `symbols=${OPT}&fields=iv&override=expiry:2026-11-24`);
    expect(md.calls.find((c) => c[0] === "optionChain")[1].expiry).toBe("2026-11-24");
    // the fake builds a synthetic chain for 2026-11-24 with no IV, so the cell is null with an error
    expect(r.data.rows[0].values.iv).toBeNull();
    expect(r.errors).toEqual([expect.objectContaining({ symbol: OPT, field: "iv", code: "NO_DATA" })]);
  });
  it("computes basis, vwap and days_to_expiry", async () => {
    const { get } = setup();
    const r = await get("/v1/fields", `symbols=${FUT},NSE:RELIANCE&fields=basis,basis_pct,days_to_expiry,vwap`);
    expect(r.data.rows[0].values.basis).toBe(40);
    expect(r.data.rows[0].values.basis_pct).toBe(0.16);
    expect(r.data.rows[0].values.days_to_expiry).toBeCloseTo(25.23, 1);
    expect(r.data.rows[1].values.vwap).toBe(1403);
    expect(r.errors.some((e) => e.symbol === FUT && e.field === "vwap")).toBe(true);
  });
  it("never throws for a bad or unknown symbol, and 400s on a bad request", async () => {
    const { get } = setup();
    const r = await get("/v1/fields", "symbols=NSE:NIFTY,NSE:NOPE,%%%&fields=ltp,vega");
    expect(r.data.rows.map((x) => x.values.ltp)).toEqual([25000, null, null]);
    expect(r.errors.filter((e) => e.field === "ltp")).toHaveLength(2);
    await expect(get("/v1/fields", "symbols=NSE:NIFTY&fields=ltp,bogus")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(get("/v1/fields", "symbols=NSE:NIFTY")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const many = Array.from({ length: 51 }, (_, i) => `NSE:S${i}`).join(",");
    await expect(get("/v1/fields", `symbols=${many}&fields=ltp`)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const f21 = FIELDS.slice(0, 21).map((f) => f.id).join(",");
    await expect(get("/v1/fields", `symbols=NSE:NIFTY&fields=${f21}`)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("a failing market-data call becomes cell errors", async () => {
    const { md } = setup();
    md.fail("NSE:NIFTY", "UPSTREAM_ERROR");
    const g = await buildGrid({ md, opts: {}, nowMs: NOW }, ["NSE:NIFTY", "NSE:RELIANCE"], [resolveField("ltp")], {});
    expect(g.rows.map((r) => r.values.ltp)).toEqual([null, 1400]);
    expect(g.errors).toEqual([expect.objectContaining({ symbol: "NSE:NIFTY", field: "ltp", code: "UPSTREAM_ERROR" })]);
  });
  it("csv", async () => {
    const { get } = setup();
    const c = await get("/v1/fields", "symbols=NSE:NIFTY,NSE:RELIANCE&fields=ltp,open interest&format=csv");
    expect(c.body).toBe("symbol,ltp,oi\r\nNSE:NIFTY,25000,\r\nNSE:RELIANCE,1400,\r\n");
    expect(c.headers["X-MCB-Errors"]).toBe("2");
  });
});

describe("BDH", () => {
  it("aggregates by period", () => {
    const c = [bar("2026-10-26", 100, 110, 95, 105, 10), bar("2026-10-27", 105, 120, 100, 118, 20), bar("2026-11-02", 1, 2, 1, 2, 3)];
    expect(aggregatePeriods(c, "W")).toEqual([
      { key: "2026-10-26", date: "2026-10-27", open: 100, high: 120, low: 95, close: 118, volume: 30, oi: null },
      { key: "2026-11-02", date: "2026-11-02", open: 1, high: 2, low: 1, close: 2, volume: 3, oi: null },
    ]);
    expect(aggregatePeriods(c, "M")).toHaveLength(2);
    expect(fillPrevious(aggregatePeriods(c, "D"), "D", "2026-10-28").map((b) => [b.date, b.filled === true])).toEqual([["2026-10-26", false], ["2026-10-27", false], ["2026-10-28", true]]);
  });
  it("serves daily bars with change fields", async () => {
    const { get, md } = setup();
    const r = await get("/v1/fields/history", "symbols=NSE:NIFTY&fields=close,volume,change&from=2026-10-26&to=2026-10-30");
    expect(r.data.series[0].rows).toEqual([
      { date: "2026-10-26", close: 105, volume: 10, change: null },
      { date: "2026-10-27", close: 118, volume: 20, change: 13 },
      { date: "2026-10-30", close: 92, volume: 5, change: -26 },
    ]);
    expect(md.calls.filter((c) => c[0] === "history")).toHaveLength(1);
  });
  it("weekly and monthly periods, fill=prev", async () => {
    const { get } = setup();
    const w = await get("/v1/fields/history", "symbols=NSE:NIFTY&fields=high,low,volume,open,close&from=2026-10-26&to=2026-10-30&period=W");
    expect(w.data.series[0].rows).toEqual([{ date: "2026-10-30", high: 120, low: 90, volume: 35, open: 100, close: 92 }]);
    const f = await get("/v1/fields/history", "symbols=NSE:NIFTY&fields=close,volume&from=2026-10-26&to=2026-10-30&fill=prev");
    expect(f.data.series[0].rows.map((x) => [x.date, x.close, x.volume, x.filled === true])).toEqual([
      ["2026-10-26", 105, 10, false], ["2026-10-27", 118, 20, false], ["2026-10-28", 118, 0, true], ["2026-10-29", 118, 0, true], ["2026-10-30", 92, 5, false],
    ]);
  });
  it("reports unsupported fields and failing symbols as errors, validates, and does csv", async () => {
    const { get } = setup();
    const r = await get("/v1/fields/history", "symbols=NSE:NIFTY,NSE:NOPE&fields=close,iv&from=2026-10-26&to=2026-10-30");
    expect(r.errors.map((e) => e.code).sort()).toEqual(["FIELD_NOT_HISTORICAL", "FIELD_NOT_HISTORICAL", "SYMBOL_NOT_FOUND"]);
    expect(r.data.series[1].rows).toEqual([]);
    const c = await get("/v1/fields/history", "symbols=NSE:NIFTY&fields=close&from=2026-10-26&to=2026-10-30&format=csv");
    expect(c.body.split("\r\n")[0]).toBe("symbol,date,close");
    await expect(get("/v1/fields/history", "symbols=NSE:NIFTY&fields=close")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(get("/v1/fields/history", "symbols=NSE:NIFTY&from=2026-10-30&to=2026-10-26")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(get("/v1/fields/history", "symbols=NSE:NIFTY&from=2000-01-01&to=2026-10-26")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(get("/v1/fields/history", "symbols=NSE:NIFTY&from=2026-10-01&period=Q")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const eleven = Array.from({ length: 11 }, (_, i) => `NSE:S${i}`).join(",");
    await expect(get("/v1/fields/history", `symbols=${eleven}&from=2026-10-01`)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("BDS", () => {
  it("lists expiries and the chain, as json and csv", async () => {
    const { get } = setup();
    const e = await get("/v1/fields/bulk", "symbol=NSE:NIFTY&field=expiries");
    expect(e.data.rows.map((x) => x.expiry)).toEqual(["2026-10-27", "2026-11-03", "2026-11-24"]);
    const c = await get("/v1/fields/bulk", "symbol=NIFTY&field=CHAIN&expiry=2026-11-03");
    expect(c.data.rows).toHaveLength(3);
    expect(c.data.rows[1]).toMatchObject({ strike: 25000, ce_ltp: 90, pe_iv: 16 });
    expect(c.data.lotSize).toBe(75);
    const v = await get("/v1/fields/bulk", "symbol=NIFTY&field=CHAIN&expiry=2026-11-03&format=csv");
    expect(v.body.split("\r\n")[0].startsWith("strike,ce_ltp")).toBe(true);
    await expect(get("/v1/fields/bulk", "symbol=NIFTY&field=CHAIN")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(get("/v1/fields/bulk", "symbol=NIFTY&field=OTHER")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("POST /v1/batch", () => {
  it("runs sub-requests through the route handlers with per-item status", async () => {
    const { routes } = setup();
    const post = (body) => routes["POST /v1/batch"].h(ctx("", body));
    const r = await post({
      requests: [
        { id: "a", path: "/v1/fields", query: { symbols: ["NSE:NIFTY", "NSE:RELIANCE"], fields: "ltp" } },
        { id: "b", path: "/v1/ltp?symbols=NSE:RELIANCE" },
        { id: "c", path: "/v1/fields/search", query: { q: "vega", format: "csv" } },
        { id: "d", path: "/v1/fields", query: { symbols: "NSE:NIFTY", fields: "bogus" } },
        { id: "e", path: "/v1/orders" },
        { id: "f", path: "/v1/analytics/gex", query: { underlying: "NIFTY", expiry: "2026-11-03" } },
        { id: "g", path: "/v1/analytics/oi", query: { underlying: "NIFTY", expiry: "2026-11-03" } },
        { id: "h", path: "/v1/fields/../orders" },
      ],
    });
    const by = Object.fromEntries(r.data.results.map((x) => [x.id, x]));
    expect(r.data.results.map((x) => x.id)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    expect(by.a.status).toBe(200);
    expect(by.a.body.data.rows.map((x) => x.values.ltp)).toEqual([25000, 1400]);
    expect(by.b.body.data[0].ltp).toBe(1400);
    expect(by.c.contentType).toMatch(/csv/);
    expect(by.d).toMatchObject({ status: 400, body: { code: "VALIDATION_FAILED" } });
    expect(by.e).toMatchObject({ status: 400, body: { code: "VALIDATION_FAILED" } });
    expect(by.f.status).toBe(200);
    expect(by.g.body.data.pcrOi).toBe(1);
    expect(by.h.status).toBe(400);
  });
  it("answers 404 for an allow-listed path it cannot dispatch", async () => {
    const { routes } = setup();
    const r = await routes["POST /v1/batch"].h(ctx("", { requests: [{ id: "x", path: "/v1/analytics/greeks-grid", query: { underlying: "NIFTY" } }] }));
    expect(r.data.results[0].status).toBe(404);
  });
  it("validates the envelope", async () => {
    const { routes } = setup();
    const post = (body) => routes["POST /v1/batch"].h(ctx("", body));
    await expect(post({})).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(post({ requests: [{ id: "a", path: "/v1/ltp" }, { id: "a", path: "/v1/ltp" }] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(post({ requests: [{ path: "/v1/ltp" }] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const many = Array.from({ length: 21 }, (_, i) => ({ id: `i${i}`, path: "/v1/ltp", query: { symbols: "NSE:NIFTY" } }));
    await expect(post({ requests: many })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const ok = await post({ requests: many.slice(0, 20) });
    expect(ok.data.results).toHaveLength(20);
  });
});
