/**
 * The spreadsheet batch routes: /xl/quotes, /xl/instrument, /xl/positions, /xl/holdings, /xl/funds, /xl/orders.
 * Behaviour with good, bad, duplicate and huge symbol lists; formats; freshness columns; no backup data; the opt-in
 * cache headers; the rate-limit message; and that no key ever reaches a log line.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeError } from "../core/errors.mjs";
import { createLogger } from "../core/logger.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { KEYS, createFakeMarketData } from "./__fixtures__/fakes.mjs";
import { bearer, startTestApp } from "./__fixtures__/testApp.mjs";
import { toCsv } from "../core/http.mjs";
import { toTsv } from "./table.mjs";

const lines = [];
let t;
beforeAll(async () => {
  t = await startTestApp({ logger: createLogger({ level: "debug", write: (l) => lines.push(l) }) });
});
afterAll(async () => {
  await t.close();
});
const R = bearer(KEYS.READ);
const get = (path, headers = R) => t.request(path, { headers });
const rows = (r) => r.raw.trimEnd().split("\r\n").map((l) => l.split(","));

describe("/xl/quotes", () => {
  it("one request, one row per symbol in the order asked, bad symbols blank with an error, duplicates kept", async () => {
    const before = t.marketData.calls.length;
    const r = await get("/xl/quotes?symbols=NSE:RELIANCE,NSE:NOPE,NSE:NIFTY,NSE:RELIANCE,NSE:M%26M");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^text\/csv/);
    const all = rows(r);
    expect(all[0]).toEqual(["symbol", "ltp", "chg", "pct", "volume", "as_of", "age_s", "class", "source", "stale", "error"]);
    expect(all.map((x) => x[0])).toEqual(["symbol", "NSE:RELIANCE", "NSE:NOPE", "NSE:NIFTY", "NSE:RELIANCE", "NSE:M&M"]);
    expect(all[1].slice(1, 5)).toEqual(["2900", "5", "0.1727", "123456"]);
    expect(all[2].slice(1, 10)).toEqual(["", "", "", "", "", "", "", "", ""]);
    expect(all[2][10]).toMatch(/^SYMBOL_NOT_FOUND: /);
    expect(all[3][4]).toBe(""); // an index has no volume
    // exactly one batched read for the distinct symbols (the broker side answers NSE:NOPE with an error of its own)
    const reads = t.marketData.calls.slice(before).filter((c) => c[0] === "quotes");
    expect(reads).toHaveLength(1);
    expect(reads[0][1]).toEqual(["NSE:RELIANCE", "NSE:NOPE", "NSE:NIFTY", "NSE:M&M"]); // duplicates read once
  });

  it("freshness columns: as_of in IST, age_s, class, source, stale", async () => {
    const r = await get("/xl/quotes?symbols=NSE:RELIANCE");
    expect(rows(r)[1].slice(5)).toEqual(["2026-10-16 15:00:00", "0.1", "realtime", "stream", "false", ""]);
  });

  it("fields choose and order the value columns; freshness columns are always there", async () => {
    const r = await get("/xl/quotes?symbols=NSE:RELIANCE&fields=pct,LTP,as_of,class");
    expect(rows(r)[0]).toEqual(["symbol", "pct", "ltp", "as_of", "class", "age_s", "source", "stale", "error"]);
    const only = await get("/xl/quotes?symbols=NSE:RELIANCE&fields=ltp");
    expect(rows(only)[0].slice(0, 2)).toEqual(["symbol", "ltp"]);
    expect(only.raw).toContain("NSE:RELIANCE,2900,");
    const bad = await get("/xl/quotes?symbols=NSE:RELIANCE&fields=ltp,pe");
    expect(bad.status).toBe(400);
    expect(bad.raw).toMatch(/unknown name ""pe""/);
  });

  it("asking for the last price only reads last prices (cheaper); other fields read quotes", async () => {
    let before = t.marketData.calls.length;
    await get("/xl/quotes?symbols=NSE:RELIANCE,NSE:NIFTY&fields=ltp");
    expect(t.marketData.calls.slice(before).map((c) => c[0])).toEqual(["ltp"]);
    before = t.marketData.calls.length;
    await get("/xl/quotes?symbols=NSE:RELIANCE,NSE:NIFTY&fields=ltp,volume");
    expect(t.marketData.calls.slice(before).map((c) => c[0])).toEqual(["quotes"]);
  });

  it("csv, tsv and json carry the same table", async () => {
    const csv = await get("/xl/quotes?symbols=NSE:RELIANCE,NSE:NOPE&fields=ltp,chg");
    const tsv = await get("/xl/quotes?symbols=NSE:RELIANCE,NSE:NOPE&fields=ltp,chg&format=tsv");
    const js = await get("/xl/quotes?symbols=NSE:RELIANCE,NSE:NOPE&fields=ltp,chg&format=json");
    expect(tsv.headers["content-type"]).toMatch(/^text\/tab-separated-values/);
    expect(tsv.raw.endsWith("\n")).toBe(true);
    expect(tsv.raw).not.toContain("\r");
    const tsvRows = tsv.raw.trimEnd().split("\n").map((l) => l.split("\t"));
    expect(tsvRows[0]).toEqual(rows(csv)[0]);
    expect(tsvRows[1].slice(0, 3)).toEqual(["NSE:RELIANCE", "2900", "5"]);
    expect(js.headers["content-type"]).toMatch(/^application\/json/);
    expect(js.json).toHaveLength(2);
    expect(js.json[0]).toMatchObject({ symbol: "NSE:RELIANCE", ltp: 2900, chg: 5, class: "realtime", stale: false, error: null });
    expect(js.json[1]).toMatchObject({ symbol: "NSE:NOPE", ltp: null });
    expect((await get("/xl/quotes?symbols=NSE:RELIANCE&format=xml")).status).toBe(400);
  });

  it("numbers use a dot and never a thousands separator or an exponent", async () => {
    const r = await get("/xl/quotes?symbols=BSE:SENSEX,CDS:USDINR-2026-10-28-FUT,NSE:NIFTY&fields=ltp,bid");
    const all = rows(r);
    expect(all[1].slice(1, 3)).toEqual(["82000", "81999.95"]);
    expect(all[2].slice(1, 3)).toEqual(["88.1234", "88.0734"]);
    expect(r.raw).not.toMatch(/\d,\d{3}\b.*[0-9]e[+-]/i);
    expect(r.raw).not.toMatch(/e[+-]\d/);
  });

  it("symbols may come as repeated symbol= or symbols=, spaces and empty items are ignored", async () => {
    const r = await get("/xl/quotes?symbol=NSE:NIFTY&symbols=%20NSE:RELIANCE%20,,");
    expect(rows(r).map((x) => x[0])).toEqual(["symbol", "NSE:RELIANCE", "NSE:NIFTY"]);
  });

  it("a missing list, a huge list and a too-long symbol are 400s that say what to do, and reach no broker", async () => {
    const before = t.marketData.calls.length;
    const none = await get("/xl/quotes");
    expect(none.status).toBe(400);
    const huge = await get(`/xl/quotes?symbols=${Array.from({ length: 5000 }, (_, i) => `NSE:S${i}`).join(",").slice(0, 12_000)}`);
    expect(huge.status).toBe(400);
    expect(huge.raw).toMatch(/Too many symbols/);
    expect(huge.raw).toMatch(/split a longer list/);
    expect(huge.headers["x-error-code"]).toBe("VALIDATION_FAILED");
    const long = await get(`/xl/quotes?symbols=NSE:${"A".repeat(80)}`);
    expect(long.status).toBe(400);
    expect(t.marketData.calls.length).toBe(before);
    const hundred = await get(`/xl/quotes?symbols=${Array.from({ length: 100 }, () => "NSE:NIFTY").join(",")}`);
    expect(hundred.status).toBe(200);
    expect(rows(hundred)).toHaveLength(101);
    expect(t.marketData.calls.slice(before).filter((c) => c[0] === "quotes")).toHaveLength(1);
    expect(t.marketData.calls.at(-1)[1]).toEqual(["NSE:NIFTY"]); // duplicates are read once
  });

  it("the symbol cap is configurable", async () => {
    const t2 = await startTestApp({ integrations: { xl: { maxSymbols: 2 } } });
    try {
      expect((await t2.request("/xl/quotes?symbols=NSE:NIFTY,NSE:RELIANCE", { headers: R })).status).toBe(200);
      const over = await t2.request("/xl/quotes?symbols=NSE:NIFTY,NSE:RELIANCE,NSE:M%26M", { headers: R });
      expect(over.status).toBe(400);
      expect(over.raw).toMatch(/at most 2/);
    } finally {
      await t2.close();
    }
  });

  it("never uses a backup data source and refuses ?backup=true", async () => {
    const before = t.marketData.calls.length;
    await get("/xl/quotes?symbols=NSE:NIFTY,NSE:RELIANCE");
    expect(t.marketData.calls.slice(before)[0].at(-1).allowBackup).toBe(false);
    const r = await get("/xl/quotes?symbols=NSE:NIFTY&backup=true");
    expect(r.status).toBe(400);
    expect(r.raw).toMatch(/backup sources are not available/);
  });

  it("a key limited to some accounts reads only inside them; a pinned foreign account is refused", async () => {
    const before = t.marketData.calls.length;
    await get("/xl/quotes?symbols=NSE:NIFTY", bearer(KEYS.ONE_ACCOUNT));
    expect(t.marketData.calls.slice(before)[0].at(-1).allowedAccounts).toEqual(["dhan-main"]);
    const r = await get("/xl/quotes?symbols=NSE:NIFTY&account=zerodha-family", bearer(KEYS.ONE_ACCOUNT));
    expect(r.status).toBe(403);
    expect(r.headers["x-error-code"]).toBe("ACCOUNT_FORBIDDEN");
  });

  it("works with a read-only URL key and refuses other keys in the URL", async () => {
    expect((await get(`/xl/quotes?symbols=NSE:NIFTY&key=${KEYS.XL}`, {})).status).toBe(200);
    expect((await get(`/xl/quotes?symbols=NSE:NIFTY&key=${KEYS.READ}`, {})).status).toBe(401);
    expect((await get(`/xl/quotes?symbols=NSE:NIFTY&key=${KEYS.PAPER_Q}`, {})).status).toBe(401);
  });

  it("formula-looking text from a broker or a typo never becomes a formula", async () => {
    const r = await get("/xl/quotes?symbols=%3DHYPERLINK(%22x%22)&format=csv");
    expect(r.raw).toContain("'=HYPERLINK");
    expect(toCsv([["=1+1"]])).toBe("'=1+1\r\n");
    expect(toTsv([["=1+1", "a\tb\nc"]])).toBe("'=1+1\ta b c\n");
  });
});

describe("/xl/quotes when the broker cannot answer", () => {
  const withMarket = async (patch, fn) => {
    const base = createFakeMarketData();
    const t2 = await startTestApp({ overrides: { marketData: { ...base, ...patch(base) } } });
    try {
      await fn((p) => t2.request(p, { headers: R }), t2);
    } finally {
      await t2.close();
    }
  };

  it("a broker with no quotes API still gives the last price (other fields blank)", async () => {
    await withMarket(
      (base) => ({
        async quotes(symbols, opts) {
          const r = await base.ltp(symbols, opts);
          return { items: [], errors: r.items.map((i) => ({ symbol: i.symbol, code: "CAPABILITY_UNSUPPORTED", message: "Only a last price is available." })) };
        },
      }),
      async (g) => {
        const r = await g("/xl/quotes?symbols=NSE:RELIANCE&fields=ltp,chg");
        expect(rows(r)[1].slice(0, 3)).toEqual(["NSE:RELIANCE", "2900", ""]);
        expect(rows(r)[1].at(-1)).toBe("");
      },
    );
  });

  it("every symbol rate limited: a real 429 with Retry-After and a message a sheet can show", async () => {
    await withMarket(
      () => ({ quotes: async (symbols) => ({ items: [], errors: symbols.map((s) => ({ symbol: s, code: "UPSTREAM_RATE_LIMITED", message: "busy" })) }) }),
      async (g) => {
        const r = await g("/xl/quotes?symbols=NSE:RELIANCE,NSE:NIFTY");
        expect(r.status).toBe(429);
        expect(r.headers["retry-after"]).toBe("5");
        expect(r.raw.split("\r\n")[0]).toBe("status,code,message,retry_after_s");
        expect(r.raw).toContain("Too many refreshes: wait 5 seconds");
      },
    );
  });

  it("some symbols rate limited: 200, those rows carry the error, the others their prices", async () => {
    await withMarket(
      (base) => ({
        async quotes(symbols, opts) {
          const r = await base.quotes(symbols, opts);
          return { items: r.items.filter((i) => i.symbol !== "NSE:NIFTY"), errors: [...r.errors, { symbol: "NSE:NIFTY", code: "SESSION_EXPIRED", message: "The broker session has expired. Log in again." }] };
        },
      }),
      async (g) => {
        const r = await g("/xl/quotes?symbols=NSE:RELIANCE,NSE:NIFTY");
        expect(r.status).toBe(200);
        expect(rows(r)[2].at(-1)).toBe("SESSION_EXPIRED: The broker session has expired. Log in again.");
        expect(rows(r)[1][1]).toBe("2900");
      },
    );
  });

  it("a delayed price is labelled in the table and refused by the single-value routes", async () => {
    const slow = (i) => ({ ...i, freshness: { ...i.freshness, class: "delayed", delaySec: 900, source: "broker" } });
    await withMarket(
      (base) => ({
        async quotes(s, o) {
          const r = await base.quotes(s, o);
          return { ...r, items: r.items.map(slow) };
        },
        async ltp(s, o) {
          const r = await base.ltp(s, o);
          return { ...r, items: r.items.map(slow) };
        },
      }),
      async (g) => {
        expect(rows(await g("/xl/quotes?symbols=NSE:RELIANCE&fields=ltp,class"))[1].slice(0, 3)).toEqual(["NSE:RELIANCE", "2900", "delayed"]);
        for (const p of ["/xl/ltp?symbol=NSE:RELIANCE", "/xl/quote?symbol=NSE:RELIANCE&field=bid"]) {
          const r = await g(p);
          expect([r.status, r.raw]).toEqual([422, "#N/A"]);
          expect(r.headers["x-error-code"]).toBe("CAPABILITY_UNSUPPORTED");
        }
      },
    );
  });
});

describe("caching is opt-in", () => {
  it("default: no-store, no ETag", async () => {
    const r = await get("/xl/quotes?symbols=NSE:NIFTY");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers.etag).toBeUndefined();
  });
  it("?cache=1: max-age (from config) and an ETag; If-None-Match gets 304", async () => {
    const r = await get("/xl/quotes?symbols=NSE:NIFTY&cache=1");
    expect(r.headers["cache-control"]).toBe("private, max-age=5");
    expect(r.headers.etag).toMatch(/^W\/"/);
    const again = await get("/xl/quotes?symbols=NSE:NIFTY&cache=1", { ...R, "if-none-match": r.headers.etag });
    expect(again.status).toBe(304);
    expect(again.raw).toBe("");
    expect((await get("/xl/quotes?symbols=NSE:RELIANCE&cache=1", { ...R, "if-none-match": r.headers.etag })).status).toBe(200);
    const t2 = await startTestApp({ integrations: { xl: { cacheSeconds: 30 } } });
    try {
      expect((await t2.request("/xl/quotes?symbols=NSE:NIFTY&cache=true", { headers: R })).headers["cache-control"]).toBe("private, max-age=30");
    } finally {
      await t2.close();
    }
  });
  it("errors are never cached", async () => {
    const r = await get("/xl/quotes?cache=1");
    expect(r.status).toBe(400);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers.etag).toBeUndefined();
  });
  it("every other table route honours it too, and the single-value routes stay no-store", async () => {
    for (const p of ["/xl/instrument?symbol=NSE:RELIANCE,NSE:NIFTY"]) {
      expect((await get(`${p}${p.includes("?") ? "&" : "?"}cache=1`)).headers["cache-control"], p).toBe("private, max-age=5");
    }
    expect((await get("/xl/ltp?symbol=NSE:NIFTY&cache=1")).headers["cache-control"]).toBe("no-store");
  });
});

describe("the client rate limit", () => {
  it("answers a table whose message says how long to wait", async () => {
    const scheduler = { ...notImplementedService("scheduler"), checkClient: () => ({ ok: false, error: new BridgeError("RATE_LIMITED", "Too many requests", { retryAfterMs: 3000, scope: "client" }) }) };
    const t2 = await startTestApp({ overrides: { scheduler } });
    try {
      const r = await t2.request("/xl/quotes?symbols=NSE:NIFTY", { headers: R });
      expect(r.status).toBe(429);
      expect(r.headers["retry-after"]).toBe("3");
      expect(r.raw).toBe('status,code,message,retry_after_s\r\n429,RATE_LIMITED,Too many refreshes: wait 3 seconds and try again.,3\r\n');
      const j = await t2.request("/xl/quotes?symbols=NSE:NIFTY&format=json", { headers: R });
      expect(j.json[0]).toMatchObject({ status: 429, code: "RATE_LIMITED", retry_after_s: 3 });
      const cell = await t2.request("/xl/ltp?symbol=NSE:NIFTY", { headers: R });
      expect(cell.raw).toBe("#N/A");
    } finally {
      await t2.close();
    }
  });
  it("INT-06: ?errors=200 answers a refusal with HTTP 200 and the same table, for WEBSERVICE which cannot read an error status", async () => {
    const wrong = await get("/xl/positions?errors=200&format=tsv", bearer("mcb_nope0000001_zzzzzzzzzzzzzzzzzzzz"));
    expect(wrong.status).toBe(200);
    const [head, line] = wrong.raw.trimEnd().split("\n");
    expect(head).toBe("status\tcode\tmessage\tretry_after_s");
    expect(line).toMatch(/^401\tUNAUTHENTICATED\tThe key was not accepted/);
    expect(wrong.headers["x-error-code"]).toBe("UNAUTHENTICATED");
    const bad = await get("/xl/quotes?errors=200");
    expect([bad.status, bad.raw.split("\r\n")[0]]).toEqual([200, "status,code,message,retry_after_s"]);
    const plain = await get("/xl/quotes");
    expect(plain.status).toBe(400); // without it the real status stays
    const scheduler = { ...notImplementedService("scheduler"), checkClient: () => ({ ok: false, error: new BridgeError("RATE_LIMITED", "Too many requests", { retryAfterMs: 3000, scope: "client" }) }) };
    const t2 = await startTestApp({ overrides: { scheduler } });
    try {
      const r = await t2.request("/xl/funds?errors=200", { headers: R });
      expect([r.status, r.raw]).toEqual([200, "status,code,message,retry_after_s\r\n429,RATE_LIMITED,Too many refreshes: wait 3 seconds and try again.,3\r\n"]);
    } finally {
      await t2.close();
    }
  });
  it("a wrong key is explained in plain words", async () => {
    const r = await get("/xl/quotes?symbols=NSE:NIFTY", bearer("mcb_nope0000001_zzzzzzzzzzzzzzzzzzzz"));
    expect(r.status).toBe(401);
    expect(r.raw).toMatch(/key was not accepted/);
  });
});

describe("/xl/instrument", () => {
  it("one symbol and one field is a bare value for a cell", async () => {
    const lot = await get("/xl/instrument?symbol=NFO:NIFTY-2026-10-27-FUT&field=lot");
    expect([lot.status, lot.raw, lot.headers["content-type"]]).toEqual([200, "75", "text/plain; charset=utf-8"]);
    expect((await get("/xl/instrument?symbol=NSE:RELIANCE&field=tick")).raw).toBe("0.1");
    const none = await get("/xl/instrument?symbol=NSE:RELIANCE&field=freeze");
    expect([none.status, none.raw, none.headers["x-error-code"]]).toEqual([404, "#N/A", "NOT_FOUND"]);
    expect((await get("/xl/instrument?symbol=NSE:NOPE&field=lot")).raw).toBe("#N/A");
    expect((await get("/xl/instrument?symbol=NSE:RELIANCE&field=colour")).status).toBe(400);
  });
  it("several symbols or no field: a table, bad symbols in their own row", async () => {
    const r = await get("/xl/instrument?symbol=NSE:RELIANCE,NFO:NIFTY-2026-10-27-FUT,NSE:NOPE&field=lot,tick");
    const all = rows(r);
    expect(all[0]).toEqual(["symbol", "lot", "tick", "error"]);
    expect(all[1]).toEqual(["NSE:RELIANCE", "1", "0.1", ""]);
    expect(all[2]).toEqual(["NFO:NIFTY-2026-10-27-FUT", "75", "0.1", ""]);
    expect(all[3][3]).toMatch(/^SYMBOL_NOT_FOUND/);
    expect(rows(await get("/xl/instrument?symbol=NSE:RELIANCE"))[0]).toEqual(["symbol", "lot", "tick", "freeze", "name", "kind", "error"]);
    expect((await get("/xl/instrument?symbols=NSE:RELIANCE&field=lot&format=json")).json).toEqual([{ symbol: "NSE:RELIANCE", lot: 1, error: null }]);
  });
});

describe("demo mode marks every row", () => {
  it("adds a demo column with DEMO", async () => {
    const t2 = await startTestApp({ demo: true });
    try {
      const r = await t2.request("/xl/quotes?symbols=NSE:RELIANCE,NSE:NOPE", { headers: R });
      const all = rows(r);
      expect(all[0].at(-1)).toBe("demo");
      expect(all.slice(1).map((x) => x.at(-1))).toEqual(["DEMO", "DEMO"]);
      expect(r.headers["x-mcb-data"]).toBe("demo");
      expect((await t.request("/xl/quotes?symbols=NSE:RELIANCE", { headers: R })).raw).not.toContain("DEMO");
    } finally {
      await t2.close();
    }
  });
});

describe("portfolio tables", () => {
  const fresh = (source, id) => ({ source, asOf: "2026-10-16T15:00:00+05:30", ageMs: 1500, stale: false, accountId: id, broker: source === "paper" ? "paper" : "dhan" });
  const accounts = [
    { id: "paper-1", broker: "paper", enabled: true, session: { state: "connected" }, capabilities: ["positions", "funds", "orderBook"] },
    { id: "dhan-main", broker: "dhan", enabled: true, session: { state: "connected" }, capabilities: ["positions", "holdings", "funds", "orderBook"] },
    { id: "dhan-off", broker: "dhan", enabled: true, session: { state: "expired" }, capabilities: ["positions", "holdings", "funds"] },
    { id: "dhan-bad", broker: "dhan", enabled: true, session: { state: "connected" }, capabilities: ["positions", "holdings", "funds"] },
  ];
  const calls = [];
  const orders = {
    async positions(_ctx, id, o) {
      calls.push(["positions", id, o]);
      if (id === "dhan-bad") throw new BridgeError("SESSION_EXPIRED", "The broker session has expired. Log in again.");
      return { items: [{ symbol: "NSE:RELIANCE", product: "CNC", netQty: 10, avgPrice: 2800, ltp: 2900, pnl: 1000, realisedPnl: 0, unrealisedPnl: 1000 }, { symbol: "NSE:INFY", product: "INTRADAY", netQty: 0, avgPrice: 0, ltp: 1500, pnl: 50, realisedPnl: 50, unrealisedPnl: null }], freshness: fresh(id === "paper-1" ? "paper" : "broker", id) };
    },
    async holdings(_ctx, id) {
      if (id === "dhan-bad") throw new BridgeError("UPSTREAM_ERROR", "The broker did not answer.");
      return { items: [{ symbol: "NSE:SBIN", isin: "INE062A01020", qty: 40, avgPrice: 723.75, ltp: 1018.65, pnl: 11796 }], freshness: fresh("broker", id) };
    },
    async funds(_ctx, id) {
      return { funds: { availableCash: 250000.5, usedMargin: 1, totalBalance: 250001.5, collateral: 0, withdrawable: 250000, realisedPnl: null, unrealisedPnl: null }, freshness: fresh(id === "paper-1" ? "paper" : "broker", id) };
    },
    async list(_ctx, o) {
      calls.push(["list", o]);
      return {
        items: [{ orderId: "PAPER-1", clientOrderId: "c-1", accountId: "paper-1", mode: "paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 5, filledQuantity: 5, avgPrice: 2899.5, price: 2900, triggerPrice: null, orderType: "LIMIT", product: "CNC", status: "filled", statusMessage: null, placedAt: "2026-10-16T14:00:00+05:30", updatedAt: "2026-10-16T14:00:01+05:30" }],
        nextCursor: o.limit === 1 ? "next" : null,
      };
    },
  };
  let t2;
  beforeAll(async () => {
    t2 = await startTestApp({ overrides: { orders: { ...notImplementedService("orders"), ...orders }, accounts: { ...notImplementedService("accounts"), list: () => accounts } } });
  });
  afterAll(async () => {
    await t2.close();
  });
  const g = (p, h = R) => t2.request(p, { headers: h });

  it("positions: stable columns, every answering account, open=1 hides closed rows, freshness labels", async () => {
    const r = await g("/xl/positions");
    const all = rows(r);
    expect(all[0]).toEqual(["account", "mode", "symbol", "product", "qty", "avg_price", "ltp", "pnl", "realised_pnl", "unrealised_pnl", "as_of", "age_s", "class", "source", "stale", "error"]);
    // paper-1 and dhan-main answer, dhan-bad fails into its own row, dhan-off (logged out) has an error row too
    expect(all.map((x) => x[0]).sort()).toEqual(["account", "dhan-bad", "dhan-main", "dhan-main", "dhan-off", "paper-1", "paper-1"]);
    const paper = all.find((x) => x[0] === "paper-1");
    expect(paper.slice(1, 5)).toEqual(["paper", "NSE:RELIANCE", "CNC", "10"]);
    expect(paper.slice(10)).toEqual(["2026-10-16 15:00:00", "1.5", "realtime", "paper", "false", ""]);
    expect(all.find((x) => x[0] === "dhan-bad").at(-1)).toMatch(/^SESSION_EXPIRED/);
    expect(all.find((x) => x[0] === "dhan-main")[1]).toBe("live");
    expect(rows(await g("/xl/positions?open=1")).filter((x) => x[2] === "NSE:INFY")).toHaveLength(0);
  });
  it("INT-01: a logged-out account is a visible error row on positions, holdings and funds, not a missing account", async () => {
    calls.length = 0;
    for (const route of ["positions", "holdings", "funds"]) {
      const r = rows(await g(`/xl/${route}`));
      const off = r.filter((x) => x[0] === "dhan-off");
      expect(off, route).toHaveLength(1);
      expect(off[0].at(-1), route).toMatch(/^SESSION_EXPIRED: dhan-off is logged out\./);
      const json = (await g(`/xl/${route}?format=json`)).json.find((x) => x.account === "dhan-off");
      expect(json.error, route).toMatch(/logged out/);
      expect(json.symbol ?? null, route).toBeNull();
    }
    // the read itself is not attempted for it (no broker call for a session that is known to be gone)
    expect(calls.filter((c) => c[1] === "dhan-off")).toEqual([]);
    // a key limited to another account never learns about it
    expect(rows(await g("/xl/positions", bearer(KEYS.ONE_ACCOUNT))).map((x) => x[0])).not.toContain("dhan-off");
  });
  it("INT-02: ?limit= keeps the first rows and ends with a visible 'showing N of M' row, never silently", async () => {
    const r = await g("/xl/positions?limit=3");
    expect(r.headers["x-truncated"]).toBe("true");
    expect(r.headers["x-total-rows"]).toBe("6");
    const all = rows(r);
    expect(all).toHaveLength(1 + 3 + 1);
    expect(all.at(-1)[0]).toBe("(more rows)");
    expect(all.at(-1).at(-1)).toMatch(/^SHOWING 3 OF 6 ROWS: the other 3 are not shown/);
    const whole = await g("/xl/positions?limit=50");
    expect(whole.headers["x-truncated"]).toBeUndefined();
    expect(rows(whole).map((x) => x[0])).not.toContain("(more rows)");
    expect(rows(await g("/xl/positions")).map((x) => x[0])).not.toContain("(more rows)"); // no limit: everything
    expect((await g("/xl/holdings?limit=0")).status).toBe(400);
    const j = (await g("/xl/funds?limit=2&format=json")).json;
    expect(j.at(-1)).toMatchObject({ account: "(more rows)" });
  });
  it("a pinned account is read alone; a foreign one is refused", async () => {
    calls.length = 0;
    await g("/xl/positions?account=dhan-main");
    expect(calls.map((c) => c[1])).toEqual(["dhan-main"]);
    expect((await g("/xl/positions?account=paper-1", bearer(KEYS.ONE_ACCOUNT))).status).toBe(403);
    const mine = await g("/xl/holdings", bearer(KEYS.ONE_ACCOUNT));
    expect(rows(mine).map((x) => x[0])).toEqual(["account", "dhan-main", "dhan-bad"].filter((x) => x !== "dhan-bad"));
  });
  it("holdings and funds", async () => {
    const h = rows(await g("/xl/holdings"));
    expect(h[0]).toEqual(["account", "mode", "symbol", "isin", "qty", "avg_price", "ltp", "pnl", "as_of", "age_s", "class", "source", "stale", "error"]);
    expect(h.find((x) => x[0] === "dhan-main").slice(2, 8)).toEqual(["NSE:SBIN", "INE062A01020", "40", "723.75", "1018.65", "11796"]);
    const f = rows(await g("/xl/funds?format=csv"));
    expect(f[0].slice(0, 9)).toEqual(["account", "mode", "available_cash", "used_margin", "total_balance", "collateral", "withdrawable", "realised_pnl", "unrealised_pnl"]);
    expect(f.find((x) => x[0] === "dhan-main").slice(2, 5)).toEqual(["250000.5", "1", "250001.5"]);
    expect((await g("/xl/funds?format=json")).json[0]).toMatchObject({ account: "paper-1", mode: "paper", available_cash: 250000.5, realised_pnl: null });
  });
  it("orders: stable columns, IST times, status filter and limit are passed, truncation flagged", async () => {
    calls.length = 0;
    const r = await g("/xl/orders?status=filled&limit=1&account=paper-1");
    const all = rows(r);
    expect(all[0].slice(0, 6)).toEqual(["account", "mode", "order_id", "client_order_id", "symbol", "side"]);
    expect(all[1].slice(0, 6)).toEqual(["paper-1", "paper", "PAPER-1", "c-1", "NSE:RELIANCE", "BUY"]);
    expect(all[1][15]).toBe("2026-10-16 14:00:00");
    expect(r.headers["x-truncated"]).toBe("true");
    expect(calls[0][1]).toMatchObject({ accountId: "paper-1", status: "filled", mode: undefined, limit: 1 });
    expect((await g("/xl/orders?status=sideways")).status).toBe(400);
    expect((await g("/xl/orders?limit=9999")).status).toBe(400);
  });
  it("cache=1 works on the portfolio tables too, and is off by default", async () => {
    for (const p of ["/xl/positions", "/xl/holdings", "/xl/funds", "/xl/orders"]) {
      expect((await g(p)).headers["cache-control"], p).toBe("no-store");
      expect((await g(`${p}?cache=1`)).headers["cache-control"], p).toBe("private, max-age=5");
    }
  });
  it("errors that stop a whole table come back as a table with the reason", async () => {
    const r = await g("/xl/funds?format=nonsense");
    expect(r.status).toBe(400);
    expect(r.raw.split("\r\n")[0]).toBe("status,code,message,retry_after_s");
  });
});

describe("INT-02: a capped table always fits WEBSERVICE's 32,767 characters, whatever the size of the book", () => {
  it("5000 holdings with the workbook's limit stay far under the limit and say how many were left out", async () => {
    const fresh = { source: "broker", asOf: "2026-10-16T15:00:00+05:30", ageMs: 1500, stale: false, accountId: "dhan-main", broker: "dhan" };
    const items = Array.from({ length: 5000 }, (_, i) => ({ symbol: `NSE:LONGNAMEDSTOCK${i}-EQ-WITH-SUFFIX`, isin: "INE062A01020", qty: 123456, avgPrice: 12345.675, ltp: 12345.675, pnl: -1234567.89 }));
    const accounts = [{ id: "dhan-main", broker: "dhan", enabled: true, session: { state: "connected" }, capabilities: ["holdings"] }];
    const t3 = await startTestApp({ overrides: { orders: { ...notImplementedService("orders"), holdings: async () => ({ items, freshness: fresh }) }, accounts: { ...notImplementedService("accounts"), list: () => accounts } } });
    try {
      const all = await t3.request("/xl/holdings?format=tsv", { headers: R });
      expect(all.raw.length).toBeGreaterThan(32_767); // the uncapped answer would be #VALUE! in WEBSERVICE
      for (const limit of [60, 40, 10]) {
        const r = await t3.request(`/xl/holdings?format=tsv&limit=${limit}`, { headers: R });
        expect(r.raw.length, `limit ${limit}`).toBeLessThan(32_767);
        expect(r.raw.trimEnd().split("\n").at(-1)).toContain(`SHOWING ${limit} OF 5000 ROWS`);
      }
    } finally {
      await t3.close();
    }
  });
});

describe("keys and tokens never reach a log line", () => {
  it("not for URL keys, header keys, wrong keys, 429s or errors", async () => {
    await get(`/xl/quotes?symbols=NSE:NIFTY&key=${KEYS.XL}`, {});
    await get(`/xl/quotes?symbols=NSE:NIFTY&key=${KEYS.READ}`, {});
    await get("/xl/quotes?symbols=NSE:NIFTY", bearer(KEYS.PAPER_Q));
    await get("/xl/quotes?symbols=NSE:NOPE,%3DSUM(1)&fields=zzz", R);
    await get("/xl/funds?cache=1", R);
    expect(lines.length).toBeGreaterThan(5);
    const all = lines.join("\n");
    for (const k of Object.values(KEYS)) {
      expect(all).not.toContain(k);
      expect(all).not.toContain(k.slice(4, 15) + "_" + k.slice(16));
    }
    expect(all).not.toMatch(/key=/);
  });
});
