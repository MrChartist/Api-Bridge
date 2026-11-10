/**
 * The shared list pager (core/paginate.mjs) and the unknown-query-parameter report (core/query.mjs), unit level and over
 * HTTP on a demo Bridge.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootDemoBridge } from "./__fixtures__/demoBridge.mjs";
import { pageParams, paginate } from "./paginate.mjs";
import { checkQuery, suggest } from "./query.mjs";

const rows = Array.from({ length: 7 }, (_, i) => ({ id: `r${i}` }));
const q = (s) => new URLSearchParams(s);

describe("pageParams and paginate", () => {
  it("reads limit and cursor, with a default only where the route has one", () => {
    expect(pageParams(q(""))).toEqual({ limit: null, cursor: null });
    expect(pageParams(q(""), { defaultLimit: 100 })).toEqual({ limit: 100, cursor: null });
    expect(pageParams(q("limit=5&cursor=abc"))).toEqual({ limit: 5, cursor: "abc" });
    for (const bad of ["limit=0", "limit=501", "limit=x", "limit=1.5", `cursor=${"a".repeat(513)}`]) expect(() => pageParams(q(bad))).toThrow(/limit|cursor/);
  });

  it("walks a list page by page and ends with a null cursor", () => {
    const seen = [];
    let cursor = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const r = paginate(rows, { limit: 3, cursor, keyOf: (x) => x.id });
      seen.push(...r.items.map((x) => x.id));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    expect(seen).toEqual(rows.map((r) => r.id));
    expect(paginate(rows, { limit: null, cursor: null, keyOf: (x) => x.id })).toEqual({ items: rows, nextCursor: null });
    expect(paginate(rows, { limit: 7, cursor: null, keyOf: (x) => x.id }).nextCursor).toBeNull();
  });

  it("continues after the last item seen even when the list changed in between", () => {
    const first = paginate(rows, { limit: 3, cursor: null, keyOf: (x) => x.id });
    const withoutFirst = rows.slice(1); // r0 was deleted
    expect(paginate(withoutFirst, { limit: 3, cursor: first.nextCursor, keyOf: (x) => x.id }).items.map((x) => x.id)).toEqual(["r3", "r4", "r5"]);
    const withNew = [{ id: "new" }, ...rows]; // a new item was put in front
    expect(paginate(withNew, { limit: 3, cursor: first.nextCursor, keyOf: (x) => x.id }).items.map((x) => x.id)).toEqual(["r3", "r4", "r5"]);
    const lastGone = rows.filter((r) => r.id !== "r2"); // the item the cursor names was deleted: fall back to its position
    expect(paginate(lastGone, { limit: 3, cursor: first.nextCursor, keyOf: (x) => x.id }).items.map((x) => x.id)).toEqual(["r4", "r5", "r6"]);
  });

  it("refuses a cursor that is not one of ours", () => {
    expect(() => paginate(rows, { limit: 3, cursor: "not-a-cursor", keyOf: (x) => x.id })).toThrow(/cursor is not valid/);
  });
});

describe("checkQuery", () => {
  const ctx = (s) => {
    const headers = {};
    return { query: q(s), headers, setHeader: (k, v) => (headers[k] = v) };
  };
  it("is quiet when every parameter is known", () => {
    const c = ctx("symbols=NSE:TCS&maxAgeMs=0&strict=false");
    expect(checkQuery(c, ["symbols", "maxAgeMs"])).toEqual([]);
    expect(c.headers).toEqual({});
  });
  it("names an ignored parameter and what it probably meant", () => {
    const c = ctx("symbols=NSE:TCS&maxAge=0&bogus=1");
    expect(checkQuery(c, ["symbols", "maxAgeMs"])).toEqual(["maxAge", "bogus"]);
    expect(c.headers["X-MCB-Ignored-Params"]).toBe("maxAge,bogus");
    expect(c.headers["X-MCB-Param-Hint"]).toBe("maxAge: did you mean maxAgeMs");
  });
  it("refuses it with strict=true", () => {
    expect(() => checkQuery(ctx("maxAge=0&strict=true"), ["maxAgeMs"])).toThrow(/did you mean maxAgeMs/);
  });
  it("suggests a case slip, a prefix or a letter off, and nothing for a stranger", () => {
    expect(suggest("MAXAGEMS", ["maxAgeMs"])).toBe("maxAgeMs");
    expect(suggest("symbol", ["symbols"])).toBe("symbols");
    expect(suggest("simbols", ["symbols"])).toBe("symbols");
    expect(suggest("zzz", ["symbols", "maxAgeMs"])).toBeNull();
  });
});

describe("paging and unknown parameters over HTTP", () => {
  let b;
  beforeAll(async () => {
    b = await bootDemoBridge();
    for (const n of ["col-a", "col-b", "col-c"]) expect((await b.call("POST", "/v1/collections", { body: { name: n, symbols: ["NSE:RELIANCE"] } })).status).toBe(201);
  });
  afterAll(() => b?.close());

  it("pages collections, downloads, recordings, keys, accounts and subscriptions with one scheme", async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await b.call("POST", "/v1/recordings", { body: { kind: "quotes", symbols: ["NSE:RELIANCE"], everySec: 5, name: `rec-${i}` } })).status).toBe(201);
      expect((await b.call("POST", "/v1/keys", { body: { label: `page-key-${i}`, scopes: ["read"], accounts: "*" } })).status).toBe(201);
    }
    for (const path of ["/v1/collections", "/v1/recordings", "/v1/keys"]) {
      const all = (await b.call("GET", path)).json;
      expect(all.meta.nextCursor, path).toBeNull();
      const got = [];
      let cursor = null;
      for (let guard = 0; guard < 20; guard += 1) {
        const r = (await b.call("GET", `${path}?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json;
        expect(r.data.length, path).toBeLessThanOrEqual(2);
        got.push(...r.data);
        cursor = r.meta.nextCursor;
        if (!cursor) break;
      }
      expect(got.map((x) => x.id ?? x.name), path).toEqual(all.data.map((x) => x.id ?? x.name));
    }
    const accounts = (await b.call("GET", "/v1/accounts?limit=1")).json;
    expect(accounts.data).toHaveLength(1);
    expect(accounts.meta.nextCursor).toBeTruthy();
    expect((await b.call("GET", "/v1/subscriptions?limit=1")).json.meta.nextCursor).toBeNull();
    expect((await b.call("GET", "/v1/collections?limit=0")).status).toBe(400);
    expect((await b.call("GET", "/v1/collections?cursor=junk")).status).toBe(400);
  });

  it("downloads keep their default of 100 and now give a cursor", async () => {
    for (let i = 0; i < 3; i += 1) expect((await b.call("POST", "/v1/downloads", { body: { symbols: ["NSE:RELIANCE"], intervals: ["1d"], from: "2026-10-01", name: `dl-${i}` } })).status).toBe(202);
    const page1 = (await b.call("GET", "/v1/downloads?limit=2")).json;
    expect(page1.data).toHaveLength(2);
    const page2 = (await b.call("GET", `/v1/downloads?limit=2&cursor=${encodeURIComponent(page1.meta.nextCursor)}`)).json;
    expect(page2.data).toHaveLength(1);
    expect(page2.meta.nextCursor).toBeNull();
    expect(page1.meta.total).toBe(3);
  });

  it("a misspelt freshness parameter on quotes is reported, not silently ignored", async () => {
    const r = await b.call("GET", "/v1/quotes?symbols=NSE:RELIANCE&maxAge=0");
    expect(r.status).toBe(200);
    expect(r.headers.get("x-mcb-ignored-params")).toBe("maxAge");
    expect(r.headers.get("x-mcb-param-hint")).toBe("maxAge: did you mean maxAgeMs");
    const ok = await b.call("GET", "/v1/quotes?symbols=NSE:RELIANCE&maxAgeMs=0");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-mcb-ignored-params")).toBeNull();
    const strict = await b.call("GET", "/v1/quotes?symbols=NSE:RELIANCE&maxAge=0&strict=true");
    expect(strict.status).toBe(400);
    expect(strict.json.code).toBe("VALIDATION_FAILED");
    expect(strict.json.errors[0]).toMatchObject({ path: "maxAge" });
  });

  it("history reports a maxAgeMs it does not use, and every other read option is known", async () => {
    const r = await b.call("GET", "/v1/history?symbol=NSE:RELIANCE&interval=1d&countback=2&maxAgeMs=0&purpose=analysis&backup=false");
    expect(r.status).toBe(200);
    expect(r.headers.get("x-mcb-ignored-params")).toBe("maxAgeMs");
    for (const path of ["/v1/ltp?symbols=NSE:RELIANCE&purpose=display&swr=false&priority=interactive", "/v1/depth?symbol=NSE:RELIANCE", "/v1/expiries?underlying=NIFTY&exchange=NFO"]) {
      expect((await b.call("GET", path)).headers.get("x-mcb-ignored-params"), path).toBeNull();
    }
    expect((await b.call("GET", "/v1/ltp?symbols=NSE:RELIANCE&fields=ltp")).headers.get("x-mcb-ignored-params")).toBe("fields");
  });

  it("history?localFirst=true reads a stored dataset and says so", async () => {
    const dl = await b.call("POST", "/v1/downloads", { body: { symbols: ["NSE:RELIANCE"], intervals: ["1d"], from: "2026-10-01", to: "2026-10-30", dataset: "lf-ds" } });
    expect(dl.status).toBe(202);
    for (let i = 0; i < 100; i += 1) {
      const j = (await b.call("GET", `/v1/downloads/${dl.json.data.id}`)).json.data;
      if (["done", "failed", "cancelled"].includes(j.status)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const plain = await b.call("GET", "/v1/history?symbol=NSE:RELIANCE&interval=1d&from=2026-10-05&to=2026-10-20");
    expect(plain.status).toBe(200);
    expect(plain.json.meta.source).toBeUndefined();
    const local = await b.call("GET", "/v1/history?symbol=NSE:RELIANCE&interval=1d&from=2026-10-05&to=2026-10-20&localFirst=true");
    expect(local.status, local.text).toBe(200);
    expect(local.headers.get("x-mcb-ignored-params")).toBeNull();
    expect(local.json.meta.source).toBe("local");
  });
});
