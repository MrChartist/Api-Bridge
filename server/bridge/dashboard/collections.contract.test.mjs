/**
 * The Collections tab against the REAL library service, not a hand-written fixture. The list route returns `symbolCount` and no
 * `symbols` (the single route returns both); a page that reads `symbols` from the list route shows "0 symbols" and, on Save,
 * replaces the saved list with the contents of an empty box. These tests feed the dashboard helpers the exact shapes the server sends.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanupLibraries, makeLibrary } from "../library/__fixtures__/lib.mjs";
import { collectionBody, collectionView, copyName, createDataClient, loadFullCollection, parseCollectionImport, staticCount, symbolsLoaded } from "./data-core.js";

afterEach(cleanupLibraries);

const THIRTEEN = ["RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", "ITC", "LT", "AXISBANK", "WIPRO", "MARUTI", "TITAN", "ONGC"].map((s) => `NSE:${s}`);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** A client whose collections routes are the real service (the same objects the HTTP routes return). */
function clientOver(lib) {
  const calls = [];
  return {
    calls,
    collections: {
      list: async () => ({ data: lib.list() }),
      get: async (name) => (calls.push(["get", name]), { data: lib.get(name) }),
    },
  };
}

describe("F1: editing a collection must not blank its symbols", () => {
  it("the real list route has no symbols, so the page must load them before editing", async () => {
    const { lib } = makeLibrary();
    lib.create({ name: "roundtrip", symbols: THIRTEEN });
    const [fromList] = lib.list();
    expect(fromList.symbols).toBeUndefined();
    expect(fromList.symbolCount).toBe(13);
    expect(symbolsLoaded(fromList)).toBe(false);

    const client = clientOver(lib);
    const full = await loadFullCollection(client, fromList);
    expect(client.calls).toEqual([["get", "roundtrip"]]);
    expect(full.symbols).toEqual(THIRTEEN);
    // what the Edit sheet does: fill the box from the loaded record, add one symbol, save
    const f = { name: full.name, description: "", tags: "", kind: full.kind, symbols: `${full.symbols.join("\n")}\nNSE:ZOMATO`, symbolsLoaded: symbolsLoaded(full) };
    const { body } = collectionBody(f, []);
    expect(body.symbols).toHaveLength(14);
  });

  it("an already loaded record is not fetched again", async () => {
    const { lib } = makeLibrary();
    lib.create({ name: "a", symbols: THIRTEEN });
    const client = clientOver(lib);
    const full = lib.get("a");
    expect(await loadFullCollection(client, full)).toBe(full);
    expect(client.calls).toEqual([]);
  });

  it("refuses to build a patch from a list whose symbols were never loaded", () => {
    const { lib } = makeLibrary();
    lib.create({ name: "a", symbols: THIRTEEN });
    const [fromList] = lib.list();
    // the old page: the box was filled from `c.symbols ?? []`, i.e. empty, then the person typed one symbol
    const f = { name: "a", description: "", tags: "", kind: "static", symbols: "NSE:INFY", symbolsLoaded: symbolsLoaded(fromList) };
    const r = collectionBody(f, []);
    expect(r.body).toBeUndefined();
    expect(r.error.title).toMatch(/have not loaded/);
  });

  it("a failed load is an error, never an empty list", async () => {
    const { lib } = makeLibrary();
    lib.create({ name: "a", symbols: THIRTEEN });
    const broken = { collections: { get: async () => ({ data: { name: "a", kind: "static", symbolCount: 13 } }) } };
    await expect(loadFullCollection(broken, lib.list()[0])).rejects.toThrow(/could not be loaded/);
  });

  it("the list shows the count from symbolCount, for a fixed list and an option universe alike", () => {
    const { lib } = makeLibrary();
    lib.create({ name: "a", symbols: THIRTEEN });
    lib.create({ name: "one", symbols: ["NSE:INFY"] });
    lib.create({ name: "u", universe: { underlying: "NIFTY" } });
    const rows = lib.list().map((c) => [c.name, collectionView(c)]);
    expect(Object.fromEntries(rows.map(([n, v]) => [n, v.sub]))).toMatchObject({ a: "13 symbols", one: "1 symbol" });
    expect(staticCount(lib.list().find((c) => c.name === "u"))).toBeNull();
    expect(staticCount({ symbolCount: 0 })).toBe(0);
  });

  it("the client the page uses has a single-collection call", () => {
    const seen = [];
    const client = createDataClient(async (m, p) => (seen.push([m, p]), { data: {} }));
    client.collections.get("a b");
    expect(seen).toEqual([["GET", "/v1/collections/a%20b"]]);
  });
});

describe("F2: CSV import reads only the symbol column, and the Bridge's own export round-trips", () => {
  it("export then import gives back the same symbols (fixed list)", async () => {
    const { lib } = makeLibrary();
    lib.create({ name: "roundtrip", symbols: THIRTEEN });
    const file = await lib.exportData("roundtrip", { format: "csv" });
    expect(file.body.split(/\r?\n/)[0]).toBe("symbol,exchange,kind,underlying,expiry,strike,right");
    const r = parseCollectionImport(file.body, "roundtrip", { csv: true });
    expect(r.error).toBeUndefined();
    expect(r.body.symbols).toEqual(THIRTEEN);
    // and without being told it is a CSV (a pasted export)
    expect(parseCollectionImport(file.body, "x").body.symbols).toEqual(THIRTEEN);
    // the server accepts what the page then sends
    const made = lib.create({ ...r.body, name: "roundtrip2" });
    expect(made.symbols).toEqual(THIRTEEN);
  });

  it("export then import gives back an option universe's resolved symbols", async () => {
    const { lib } = makeLibrary();
    lib.create({ name: "u", universe: { underlying: "NIFTY", strikes: { around: "atm", count: 2 } } });
    const file = await lib.exportData("u", { format: "csv" });
    const resolved = (await lib.resolve("u", { allowStale: true })).symbols;
    expect(resolved.length).toBeGreaterThan(3);
    const r = parseCollectionImport(file.body, "u2", { csv: true });
    expect(r.body.symbols).toEqual(resolved);
  });

  it("other columns are never symbols: a symbol,name file imports the symbols only", () => {
    const r = parseCollectionImport("symbol,name,qty\nNSE:RELIANCE,Reliance Industries,10\nNSE:TCS,TCS,5\n", "mine", { csv: true });
    expect(r.body.symbols).toEqual(["NSE:RELIANCE", "NSE:TCS"]);
  });

  it("finds the symbol column wherever it is, with quotes, a BOM and CRLF", () => {
    const r = parseCollectionImport('﻿name,Ticker\r\n"Reliance, Inds",NSE:RELIANCE\r\n"x",NSE:INFY\r\n', "mine", { csv: true });
    expect(r.body.symbols).toEqual(["NSE:RELIANCE", "NSE:INFY"]);
  });

  it("with no header, takes the first column; with another header name, skips that line", () => {
    expect(parseCollectionImport("NSE:RELIANCE,1\nNSE:TCS,2\n", "m", { csv: true }).body.symbols).toEqual(["NSE:RELIANCE", "NSE:TCS"]);
    expect(parseCollectionImport("Stock name,else\nNSE:RELIANCE,1\n", "m", { csv: true }).body.symbols).toEqual(["NSE:RELIANCE"]);
  });

  it("removes the guard apostrophe and counts bad cells in the symbol column only", () => {
    const r = parseCollectionImport("symbol,note\n'NSE:RELIANCE,=HYPERLINK(\"x\")\n=cmd|calc,ok\nNSE:TCS,@SUM(1)\n", "m", { csv: true });
    expect(r.body.symbols).toEqual(["NSE:RELIANCE", "NSE:TCS"]);
    expect(r.skipped).toBe(1);
  });

  it("a plain pasted list and a one-line comma list still work", () => {
    expect(parseCollectionImport("NSE:RELIANCE\nNSE:TCS\n", "m").body.symbols).toEqual(["NSE:RELIANCE", "NSE:TCS"]);
    expect(parseCollectionImport("NSE:RELIANCE, NSE:TCS, NSE:INFY", "m").body.symbols).toEqual(["NSE:RELIANCE", "NSE:TCS", "NSE:INFY"]);
  });
});

describe("F3: a duplicate gets a name the Bridge accepts", () => {
  it("never has a space and always matches the name rule", () => {
    expect(copyName("xss1", ["xss1"])).toBe("xss1-copy");
    expect(copyName("xss1", ["xss1", "xss1-copy"])).toBe("xss1-copy-2");
    expect(copyName("xss1", ["XSS1-COPY"])).toBe("xss1-copy-2");
    for (const n of ["nifty 50", "a".repeat(64), "x.y_z-1", "weird name!"]) expect(copyName(n, [n]), n).toMatch(NAME_RE);
  });
  it("the real service accepts it", () => {
    const { lib } = makeLibrary();
    lib.create({ name: "base", symbols: ["NSE:INFY"] });
    const n = copyName("base", lib.list().map((c) => c.name));
    expect(() => lib.duplicate("base", n)).not.toThrow();
    expect(lib.get(n).symbols).toEqual(["NSE:INFY"]);
    expect(() => lib.duplicate("base", "base copy")).toThrow();
  });
});
