import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXCEL_CELL_LIMIT } from "./xl.mjs";
import { HOLIDAYS, KEYS, NOW_MS, istAt } from "./__fixtures__/fakes.mjs";
import { bearer, startTestApp } from "./__fixtures__/testApp.mjs";

let t;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(async () => {
  await t.close();
});

const R = bearer(KEYS.READ);
const get = (path, headers = R) => t.request(path, { headers });
const qs = (o) => new URLSearchParams(o).toString();
const utcDay = (iso) => Date.parse(`${iso}T00:00:00Z`) / 1000;

describe("auth on /udf and /xl", () => {
  it("needs a key", async () => {
    const r = await get("/udf/config", {});
    expect(r.status).toBe(401);
    expect(r.json.code).toBe("UNAUTHENTICATED");
  });
  it("accepts ?key= only for read-only URL keys", async () => {
    expect((await get(`/xl/ltp?symbol=NSE:NIFTY&key=${KEYS.XL}`, {})).status).toBe(200);
    expect((await get(`/xl/ltp?symbol=NSE:NIFTY&key=${KEYS.READ}`, {})).status).toBe(401); // not created with allowQuery
    expect((await get(`/xl/ltp?symbol=NSE:NIFTY&key=${KEYS.PAPER_Q}`, {})).status).toBe(401); // more than read
  });
  it("a pinned account outside the key's list is refused before any read", async () => {
    const before = t.marketData.calls.length;
    const r = await get("/xl/ltp?symbol=NSE:NIFTY&account=zerodha-family", bearer(KEYS.ONE_ACCOUNT));
    expect(r.status).toBe(403);
    expect(r.raw).toBe("#N/A");
    expect(r.headers["x-error-code"]).toBe("ACCOUNT_FORBIDDEN");
    expect(t.marketData.calls.length).toBe(before);
  });
});

describe("/udf/config and /udf/time", () => {
  it("config", async () => {
    const r = await get("/udf/config");
    expect(r.status).toBe(200);
    expect(r.json.supported_resolutions).toContain("1D");
    expect(r.json.supports_time).toBe(true);
  });
  it("time is Unix seconds as text", async () => {
    const r = await get("/udf/time");
    expect(r.headers["content-type"]).toMatch(/^text\/plain/);
    expect(r.raw).toBe(String(NOW_MS / 1000));
  });
});

describe("/udf/symbols and /udf/search", () => {
  it("resolves aliases to canonical tickers", async () => {
    const r = await get(`/udf/symbols?${qs({ symbol: "nse:m&m" })}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ticker: "NSE:M&M", name: "M&M", type: "stock", minmov: 5, pricescale: 100, session: "0915-1530", timezone: "Asia/Kolkata" });
    const fut = await get(`/udf/symbols?${qs({ symbol: "NSE:NIFTY1!" })}`);
    expect(fut.json.ticker).toBe("NFO:NIFTY-2026-10-27-FUT");
  });
  it("CDS and MCX price formats", async () => {
    expect((await get(`/udf/symbols?symbol=CDS:USDINR-2026-10-28-FUT`)).json).toMatchObject({ minmov: 25, pricescale: 10000, session: "0900-1700" });
    expect((await get(`/udf/symbols?symbol=MCX:CRUDEOIL-2026-11-19-FUT`)).json).toMatchObject({ minmov: 1, pricescale: 1 });
  });
  it("unknown symbol is a UDF error with the Bridge code and real status", async () => {
    const r = await get("/udf/symbols?symbol=NSE:NOPE");
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ s: "error", code: "SYMBOL_NOT_FOUND", retryable: false });
    expect(r.json.errmsg).toMatch(/NSE:NOPE/);
    expect(r.json.requestId).toMatch(/^req_/);
  });
  it("missing symbol is VALIDATION_FAILED", async () => {
    const r = await get("/udf/symbols");
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ s: "error", code: "VALIDATION_FAILED" });
  });
  it("search maps type and exchange filters", async () => {
    const all = (await get("/udf/search?query=NIFTY")).json;
    expect(all.length).toBeGreaterThan(2);
    expect(all[0]).toHaveProperty("ticker");
    const opts = (await get("/udf/search?query=NIFTY&type=option&exchange=NFO")).json;
    expect(opts.length).toBeGreaterThan(0);
    expect(opts.every((x) => x.type === "option" && x.exchange === "NFO")).toBe(true);
    expect((await get("/udf/search?query=NIFTY&type=crypto")).json).toEqual([]);
    expect((await get("/udf/search?query=NIFTY&exchange=NYSE")).json).toEqual([]);
    expect((await get("/udf/search?query=")).json).toEqual([]);
    expect((await get("/udf/search?query=NIFTY&limit=1")).json).toHaveLength(1);
  });
});

describe("/udf/history", () => {
  const from = istAt("2026-10-16", 9, 15);
  it("returns column arrays in [from, to)", async () => {
    const r = await get(`/udf/history?${qs({ symbol: "NSE:NIFTY", resolution: "5", from, to: from + 1800 })}`);
    expect(r.status).toBe(200);
    expect(r.json.s).toBe("ok");
    expect(r.json.t).toEqual([0, 1, 2, 3, 4, 5].map((i) => from + i * 300));
    for (const k of ["o", "h", "l", "c", "v"]) expect(r.json[k]).toHaveLength(6);
  });
  it("countback wins over from", async () => {
    const to = istAt("2026-10-16", 10, 0);
    const r = await get(`/udf/history?${qs({ symbol: "NSE:NIFTY", resolution: "15", from: to - 60, to, countback: 3 })}`);
    expect(r.json.t).toEqual([to - 2700, to - 1800, to - 900]);
  });
  it("daily bars are stamped 00:00 UTC of the trading date", async () => {
    const r = await get(`/udf/history?${qs({ symbol: "NSE:NIFTY", resolution: "1D", from: utcDay("2026-10-12"), to: utcDay("2026-10-17") })}`);
    expect(r.json.t).toEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"].map(utcDay));
  });
  it("an empty range inside the data answers no_data with nextTime (holiday gap)", async () => {
    expect(HOLIDAYS.has("2026-10-02")).toBe(true);
    const r = await get(`/udf/history?${qs({ symbol: "NSE:NIFTY", resolution: "1D", from: utcDay("2026-10-02"), to: utcDay("2026-10-03") })}`);
    expect(r.json).toEqual({ s: "no_data", nextTime: utcDay("2026-10-01") });
  });
  it("before the data starts answers no_data without nextTime", async () => {
    const r = await get(`/udf/history?${qs({ symbol: "NSE:NIFTY", resolution: "1D", from: utcDay("2025-06-01"), to: utcDay("2025-07-01") })}`);
    expect(r.json).toEqual({ s: "no_data" });
  });
  it("silly ranges answer no_data without a broker read", async () => {
    const before = t.marketData.calls.length;
    expect((await get(`/udf/history?${qs({ symbol: "NSE:NIFTY", resolution: "5", from: 100, to: 50 })}`)).json).toEqual({ s: "no_data" });
    expect((await get(`/udf/history?${qs({ symbol: "NSE:NIFTY", resolution: "5", from: 0, to: 1000 })}`)).json).toEqual({ s: "no_data" });
    expect(t.marketData.calls.length).toBe(before);
  });
  it("bad input is a UDF error", async () => {
    const r = await get(`/udf/history?${qs({ symbol: "NSE:NIFTY", resolution: "240", from, to: from + 60 })}`);
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ s: "error", code: "VALIDATION_FAILED" });
    expect((await get(`/udf/history?${qs({ symbol: "NSE:NIFTY", resolution: "5", to: from })}`)).json.code).toBe("VALIDATION_FAILED");
    expect((await get(`/udf/history?${qs({ symbol: "NSE:NIFTY", resolution: "5", from: "abc", to: from })}`)).status).toBe(400);
  });
  it("passes the interval, an abort signal and interactive priority to marketData", async () => {
    await get(`/udf/history?${qs({ symbol: "NSE:NIFTY", resolution: "60", from, to: from + 7200 })}`);
    const [kind, params, opts] = t.marketData.calls.at(-1);
    expect(kind).toBe("history");
    expect(params).toMatchObject({ symbol: "NSE:NIFTY", interval: "60m", from, to: from + 7200 });
    expect(opts.priority).toBe("interactive");
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("/udf/quotes", () => {
  it("echoes the requested names and marks failures per symbol", async () => {
    const r = await get(`/udf/quotes?${qs({ symbols: "nse:nifty,NSE:NOPE,NSE:RELIANCE" })}`);
    expect(r.status).toBe(200);
    expect(r.json.s).toBe("ok");
    expect(r.json.d.map((x) => [x.s, x.n])).toEqual([
      ["ok", "nse:nifty"],
      ["error", "NSE:NOPE"],
      ["ok", "NSE:RELIANCE"],
    ]);
    expect(r.json.d[0].v).toMatchObject({ lp: 25000, short_name: "NIFTY", exchange: "NSE" });
    expect(r.json.d[0].v).not.toHaveProperty("volume"); // null for an index, so left out
    expect(r.json.d[1].code).toBe("SYMBOL_NOT_FOUND");
  });
  it("caps the list", async () => {
    const many = Array.from({ length: 101 }, (_, i) => `NSE:S${i}`).join(",");
    const r = await get(`/udf/quotes?symbols=${many}`);
    expect(r.status).toBe(400);
    expect(r.json.s).toBe("error");
  });
});

describe("/xl/ltp and /xl/quote", () => {
  it("one number as plain text with freshness headers", async () => {
    const r = await get("/xl/ltp?symbol=NSE:NIFTY");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^text\/plain/);
    expect(r.raw).toBe("25000");
    expect(r.headers["x-data-source"]).toBe("stream");
    expect(r.headers["x-data-stale"]).toBe("false");
    expect(r.raw.length).toBeLessThan(EXCEL_CELL_LIMIT);
  });
  it("#N/A with the error status and code", async () => {
    const r = await get("/xl/ltp?symbol=NSE:NOPE");
    expect(r.status).toBe(404);
    expect(r.raw).toBe("#N/A");
    expect(r.headers["x-error-code"]).toBe("SYMBOL_NOT_FOUND");
    const missing = await get("/xl/ltp");
    expect([missing.status, missing.raw, missing.headers["x-error-code"]]).toEqual([400, "#N/A", "VALIDATION_FAILED"]);
  });
  it("throttling keeps Retry-After", async () => {
    const r = await get("/xl/ltp?symbol=NSE:BUSY");
    expect([r.status, r.raw, r.headers["retry-after"], r.headers["x-error-code"]]).toEqual([429, "#N/A", "2", "UPSTREAM_RATE_LIMITED"]);
  });
  it("quote fields", async () => {
    expect((await get("/xl/quote?symbol=NSE:RELIANCE&field=changePct")).raw).toBe("0.1727");
    expect((await get("/xl/quote?symbol=NSE:RELIANCE&field=CHANGEPCT")).raw).toBe("0.1727");
    expect((await get("/xl/quote?symbol=NSE:RELIANCE&field=bid")).raw).toBe("2899.95");
    const none = await get("/xl/quote?symbol=NSE:RELIANCE&field=oi");
    expect([none.status, none.raw]).toEqual([404, "#N/A"]);
    const bad = await get("/xl/quote?symbol=NSE:RELIANCE&field=pe");
    expect([bad.status, bad.raw]).toEqual([400, "#N/A"]);
    expect((await get("/xl/quote?symbol=NSE:RELIANCE")).status).toBe(400);
  });
  it("pins the account when asked", async () => {
    await get("/xl/ltp?symbol=NSE:NIFTY&account=dhan-main&maxAgeMs=0");
    const [, , opts] = t.marketData.calls.at(-1);
    expect(opts).toMatchObject({ accountId: "dhan-main", maxAgeMs: 0 });
  });
});

describe("/xl/chain", () => {
  it("CSV, one row per strike, CRLF, header first", async () => {
    const r = await get("/xl/chain?underlying=NIFTY&expiry=2026-10-27");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^text\/csv/);
    expect(r.headers["content-disposition"]).toMatch(/chain-NIFTY-2026-10-27\.csv/);
    const lines = r.raw.trimEnd().split("\r\n");
    expect(lines[0].startsWith("underlying,expiry,strike,atm,ce_symbol,ce_ltp")).toBe(true);
    expect(lines).toHaveLength(6);
    expect(lines[3]).toMatch(/^NIFTY,2026-10-27,25000,true,NFO:NIFTY-2026-10-27-25000-CE,/);
    expect(lines[3]).toMatch(/,25012\.35,75,2026-10-16 15:00:00,cache,false$/);
  });
  it("JSON records", async () => {
    const r = await get("/xl/chain?underlying=NIFTY&expiry=2026-10-27&format=json&strikes=1&greeks=false");
    expect(r.json.map((x) => x.strike)).toEqual([24900, 25000, 25100]);
    expect(t.marketData.calls.at(-1)[1]).toMatchObject({ strikes: 1, greeks: false });
  });
  it("maxChars keeps the strikes nearest ATM and flags truncation", async () => {
    const full = await get("/xl/chain?underlying=NIFTY&expiry=2026-10-27");
    const lines = full.raw.split("\r\n");
    // room for the header and the three middle strikes only
    const budget = [lines[0], lines[2], lines[3], lines[4]].reduce((n, l) => n + l.length + 2, 0);
    const r = await get(`/xl/chain?underlying=NIFTY&expiry=2026-10-27&maxChars=${budget}`);
    expect(r.headers["x-truncated"]).toBe("true");
    expect(r.raw.length).toBeLessThanOrEqual(budget);
    const strikes = r.raw.trimEnd().split("\r\n").slice(1).map((l) => Number(l.split(",")[2]));
    expect(strikes).toEqual([24900, 25000, 25100]);
    expect((await get("/xl/chain?underlying=NIFTY&expiry=2026-10-27&maxChars=100000")).headers["x-truncated"]).toBeUndefined();
  });
  it("errors are problem+json (tables are not single cells)", async () => {
    const r = await get("/xl/chain?underlying=NIFTY&expiry=27-10-2026");
    expect(r.status).toBe(400);
    expect(r.headers["content-type"]).toMatch(/problem\+json/);
    expect((await get("/xl/chain?underlying=BANKNIFTY&expiry=2026-10-27")).json.code).toBe("SYMBOL_NOT_FOUND");
  });
});

describe("/xl/history", () => {
  it("standard CSV with IST date-times", async () => {
    const r = await get("/xl/history?symbol=NSE:NIFTY&interval=15m&from=2026-10-16&to=2026-10-16");
    const lines = r.raw.trimEnd().split("\r\n");
    expect(lines[0]).toBe("datetime,open,high,low,close,volume,oi");
    expect(lines[1].startsWith("2026-10-16 09:15:00,")).toBe(true);
    expect(lines).toHaveLength(26);
  });
  it("defaults to the configured countback when no range is given", async () => {
    await get("/xl/history?symbol=NSE:NIFTY&interval=1d");
    expect(t.marketData.calls.at(-1)[1]).toEqual({ symbol: "NSE:NIFTY", interval: "1d", countback: 500 });
  });
  it("AmiBroker intraday and EOD layouts", async () => {
    const intraday = (await get("/xl/history?symbol=NFO:NIFTY-2026-10-27-FUT&interval=5m&countback=2&layout=amibroker")).raw.trimEnd().split("\r\n");
    expect(intraday[0]).toBe("Ticker,Date,Time,Open,High,Low,Close,Volume,OpenInt");
    expect(intraday[1]).toMatch(/^NIFTY-2026-10-27-FUT,2026-10-16,14:55:00,/) // fake clock: 15:00 IST, last two bars 14:55 and 15:00;
    expect(intraday).toHaveLength(3);
    const eod = (await get("/xl/history?symbol=NSE:RELIANCE&interval=1d&countback=1&layout=amibroker&ticker=RELI")).raw.trimEnd().split("\r\n");
    expect(eod[0]).toBe("Ticker,Date,Open,High,Low,Close,Volume,OpenInt");
    expect(eod[1]).toMatch(/^RELI,2026-10-16,/);
  });
  it("JSON records and maxChars for WEBSERVICE", async () => {
    const j = await get("/xl/history?symbol=NSE:NIFTY&interval=1d&countback=3&format=json");
    expect(j.json).toHaveLength(3);
    expect(Object.keys(j.json[0])).toEqual(["datetime", "open", "high", "low", "close", "volume", "oi"]);
    const big = await get(`/xl/history?symbol=NSE:NIFTY&interval=1m&countback=5000&maxChars=${32767}`);
    expect(big.raw.length).toBeLessThanOrEqual(32767);
    expect(big.headers["x-truncated"]).toBe("true");
    const rows = big.raw.trimEnd().split("\r\n");
    expect(rows.at(-1).startsWith("2026-10-16 15:00:00")).toBe(true); // newest bars kept (now = 15:00 IST)
  });
  it("validates", async () => {
    expect((await get("/xl/history?symbol=NSE:NIFTY&interval=2h")).status).toBe(400);
    expect((await get("/xl/history?symbol=NSE:NIFTY&interval=1d&layout=amibroker&format=json")).status).toBe(400);
    expect((await get("/xl/history?symbol=NSE:NIFTY&interval=1d&layout=amibroker&ticker=NSE:NIFTY")).status).toBe(400);
    expect((await get("/xl/history?symbol=NSE:NIFTY&interval=1d&maxChars=10")).status).toBe(400);
  });
});

describe("integrations config reaches the routes", () => {
  it("custom resolutions and sessions", async () => {
    const t2 = await startTestApp({ integrations: { udf: { supportedResolutions: ["5", "1D"], sessions: { NSE: "0915-1530:23456" }, nextTimeLookup: false }, xl: { chainFormat: "json" } } });
    try {
      const g = (p) => t2.request(p, { headers: R });
      expect((await g("/udf/config")).json.supported_resolutions).toEqual(["5", "1D"]);
      expect((await g("/udf/symbols?symbol=NSE:NIFTY")).json.session).toBe("0915-1530:23456");
      expect((await g(`/udf/history?${qs({ symbol: "NSE:NIFTY", resolution: "1", from: 1_800_000_000, to: 1_800_000_600 })}`)).status).toBe(400);
      const gap = await g(`/udf/history?${qs({ symbol: "NSE:NIFTY", resolution: "1D", from: utcDay("2026-10-02"), to: utcDay("2026-10-03") })}`);
      expect(gap.json).toEqual({ s: "no_data" });
      expect(Array.isArray((await g("/xl/chain?underlying=NIFTY&expiry=2026-10-27")).json)).toBe(true);
    } finally {
      await t2.close();
    }
  });
});
