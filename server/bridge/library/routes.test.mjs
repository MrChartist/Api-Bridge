import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startLibraryApp } from "./__fixtures__/app.mjs";
import { ROUTES } from "./module.mjs";

let t;
beforeAll(async () => {
  t = await startLibraryApp();
});
afterAll(async () => t.close());
beforeEach(async () => {
  const list = await t.request("/v1/collections", { key: t.keys.read });
  for (const c of list.json.data) await t.request(`/v1/collections/${c.name}?force=true`, { method: "DELETE", key: t.keys.admin });
  t.events.length = 0;
});

const UNIVERSE = { underlying: "NIFTY", expiries: "current-weekly", strikes: { around: "atm", count: 2 }, sides: ["CE", "PE"] };
const w = (path, body, method = "POST") => t.request(path, { method, key: t.keys.read, body });
const r = (path, key = t.keys.read) => t.request(path, { key });

describe("route table", () => {
  it("reads and writes are read scope, delete is admin; nothing is public or loopback-only, no write accepts ?key=", () => {
    for (const [method, path, options] of ROUTES) {
      expect(options.scope, `${method} ${path}`).toBe(method === "DELETE" ? "admin" : "read");
      expect(options.public).toBeUndefined();
      expect(options.allowQueryKey).toBeUndefined();
    }
    expect(ROUTES).toHaveLength(12);
  });

  it("a read key makes and changes collections (the scope of starting a download), but cannot delete or replace; no key gets 401", async () => {
    expect((await r("/v1/collections")).status).toBe(200);
    expect((await t.request("/v1/collections")).status).toBe(401);
    // writing needs no paper scope any more
    const made = await t.request("/v1/collections", { method: "POST", key: t.keys.read, body: { name: "scoped", symbols: ["NSE:INFY"] } });
    expect(made.status).toBe(201);
    expect((await t.request("/v1/collections/scoped", { method: "PATCH", key: t.keys.read, body: { tags: ["x"] } })).status).toBe(200);
    expect((await t.request("/v1/collections/scoped/duplicate", { method: "POST", key: t.keys.read, body: { name: "scoped2" } })).status).toBe(201);
    expect((await t.request("/v1/collections/import?name=scoped3", { method: "POST", key: t.keys.read, raw: "NSE:SBIN\n", contentType: "text/plain" })).status).toBe(201);
    // delete, and an import that replaces, need admin
    for (const [method, path, extra] of [["DELETE", "/v1/collections/scoped", {}], ["DELETE", "/v1/collections/scoped?force=true", {}], ["POST", "/v1/collections/import?name=scoped3&replace=true", { raw: "NSE:INFY\n", contentType: "text/plain" }]]) {
      const res = await t.request(path, { method, key: t.keys.read, ...extra });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.json.code).toBe("SCOPE_REQUIRED");
    }
    expect((await r("/v1/collections/scoped")).json.data.symbolCount).toBe(1);
    // RDATA-11: another key (even one that holds paper) cannot rewrite a collection it did not create; an admin can
    const other = await t.request("/v1/collections/scoped", { method: "PATCH", key: t.keys.paper, body: { description: "d" } });
    expect(other.status).toBe(403);
    expect(other.json.code).toBe("SCOPE_REQUIRED");
    expect((await t.request("/v1/collections/scoped", { method: "PATCH", key: t.keys.admin, body: { description: "d" } })).status).toBe(200);
    // it may still read it and make its own copy, which it then owns
    expect((await t.request("/v1/collections/scoped", { key: t.keys.paper })).status).toBe(200);
    const copy = await t.request("/v1/collections/scoped/duplicate", { method: "POST", key: t.keys.paper, body: { name: "mine-now" } });
    expect(copy.status).toBe(201);
    expect(copy.json.data.createdBy).toMatch(/^key:/);
    expect((await t.request("/v1/collections/mine-now", { method: "PATCH", key: t.keys.paper, body: { description: "mine" } })).status).toBe(200);
    expect((await t.request("/v1/collections/mine-now", { method: "PATCH", key: t.keys.read, body: { description: "not mine" } })).status).toBe(403);
    expect((await t.request("/v1/collections/scoped", { method: "DELETE", key: t.keys.admin })).status).toBe(204);
  });
});

describe("create, read, list", () => {
  it("creates (201), reads by name and by id, lists with filters", async () => {
    const c = await w("/v1/collections", { name: "banks", tags: ["Cash"], symbols: ["NSE:HDFCBANK", "NSE:ICICIBANK"] });
    expect(c.status).toBe(201);
    expect(c.json.data).toMatchObject({ name: "banks", kind: "static", tags: ["cash"], symbolCount: 2 });
    expect(c.json.meta.requestId).toBeTruthy();
    expect(c.headers["cache-control"]).toBe("no-store");
    await w("/v1/collections", { name: "u", tags: ["options"], universe: UNIVERSE });
    expect((await r("/v1/collections/banks")).json.data.symbols).toEqual(["NSE:HDFCBANK", "NSE:ICICIBANK"]);
    expect((await r(`/v1/collections/${c.json.data.id}`)).json.data.name).toBe("banks");
    expect((await r("/v1/collections/BANKS")).status).toBe(200);
    const all = await r("/v1/collections");
    expect(all.json.data.map((x) => x.name)).toEqual(["banks", "u"]);
    expect(all.json.meta.count).toBe(2);
    expect((await r("/v1/collections?tag=options")).json.data.map((x) => x.name)).toEqual(["u"]);
    expect((await r("/v1/collections?kind=static")).json.data.map((x) => x.name)).toEqual(["banks"]);
    expect((await r("/v1/collections?q=ban")).json.data).toHaveLength(1);
    expect((await r("/v1/collections?kind=other")).status).toBe(400);
  });

  it("problems are problem+json with the right code", async () => {
    expect((await r("/v1/collections/missing")).json).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect((await r("/v1/collections/bad%20name")).status).toBe(404);
    const bad = await w("/v1/collections", { name: "has space", symbols: [] });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("VALIDATION_FAILED");
    expect(bad.json.detail).toMatch(/name/);
    await w("/v1/collections", { name: "dup", symbols: [] });
    expect((await w("/v1/collections", { name: "DUP", symbols: [] })).json.code).toBe("STATE_CONFLICT");
    const notJson = await t.request("/v1/collections", { method: "POST", key: t.keys.paper, raw: "{nope" });
    expect(notJson.json.code).toBe("INVALID_JSON");
    expect((await w("/v1/collections", { name: "x", symbols: [], extra: 1 })).status).toBe(400);
  });
});

describe("change, rename, duplicate, delete", () => {
  it("PATCH changes fields; renaming keeps the old name working; every write emits collection.changed", async () => {
    await w("/v1/collections", { name: "w", symbols: ["NSE:RELIANCE"] });
    const p = await w("/v1/collections/w", { description: "mine", tags: ["x"], name: "w2" }, "PATCH");
    expect(p.status).toBe(200);
    expect(p.json.data).toMatchObject({ name: "w2", description: "mine", tags: ["x"], previousNames: ["w"] });
    expect((await r("/v1/collections/w")).json.data).toMatchObject({ name: "w2", viaOldName: true });
    expect(t.events.map((e) => [e.action, e.name])).toEqual([["created", "w"], ["renamed", "w2"]]);
    expect(t.events[1].from).toBe("w");
    expect((await w("/v1/collections/w2", {}, "PATCH")).status).toBe(400);
  });

  it("duplicate answers 201 with the copy; delete answers 204; a second delete is 404", async () => {
    await w("/v1/collections", { name: "base", symbols: ["NSE:INFY"] });
    const d = await w("/v1/collections/base/duplicate", {});
    expect(d.status).toBe(201);
    expect(d.json.data).toMatchObject({ name: "base-copy", symbols: ["NSE:INFY"] });
    const named = await w("/v1/collections/base/duplicate", { name: "second" });
    expect(named.json.data.name).toBe("second");
    const bodyless = await t.request("/v1/collections/base/duplicate", { method: "POST", key: t.keys.paper });
    expect(bodyless.json.data.name).toBe("base-copy2");
    const del = await t.request("/v1/collections/base-copy", { method: "DELETE", key: t.keys.admin });
    expect(del.status).toBe(204);
    expect((await t.request("/v1/collections/base-copy", { method: "DELETE", key: t.keys.admin })).status).toBe(404);
  });
});

describe("resolve", () => {
  it("a universe resolves to concrete symbols with the rule, the time and the price source", async () => {
    await w("/v1/collections", { name: "n", universe: UNIVERSE });
    const res = await r("/v1/collections/n/resolve");
    expect(res.status).toBe(200);
    const d = res.json.data;
    expect(d).toMatchObject({ name: "n", kind: "option-universe", atmSource: "live", count: 11 });
    expect(d.resolvedAt).toBe(res.json.meta.resolvedAt);
    expect(d.symbols[0]).toBe("NSE:NIFTY");
    expect(d.symbols).toContain("NFO:NIFTY-2026-11-10-25000-CE");
    expect(d.rule).toMatch(/current-weekly/);
    expect(d.expiries[0]).toMatchObject({ expiry: "2026-11-10", atm: 25000, step: 50 });
  });

  it("a price that cannot be trusted is an error response; allowStale turns it into a labelled answer", async () => {
    await w("/v1/collections", { name: "n", universe: UNIVERSE });
    t.market.setPrice("NSE:NIFTY", 25012, { class: "delayed", source: "backup" });
    const refused = await r("/v1/collections/n/resolve");
    expect(refused.status).toBe(422);
    expect(refused.json.code).toBe("CAPABILITY_UNSUPPORTED");
    const ok = await r("/v1/collections/n/resolve?allowStale=true");
    expect(ok.status).toBe(200);
    expect(ok.json.data.atmSource).toBe("delayed");
    expect(ok.json.data.warnings.join(" ")).toMatch(/delayed/);
    t.market.setPrice("NSE:NIFTY", 25012, { stale: true, ageMs: 900_000 });
    expect((await r("/v1/collections/n/resolve")).status).toBe(503);
    t.market.setPrice("NSE:NIFTY", 25012);
    expect((await r("/v1/collections/n/resolve")).status).toBe(200);
  });

  it("spot, priority and requireLive are read from the query and checked", async () => {
    await w("/v1/collections", { name: "n", universe: UNIVERSE });
    const s = await r("/v1/collections/n/resolve?spot=25126");
    expect(s.json.data).toMatchObject({ atmSource: "supplied" });
    expect(s.json.data.expiries[0].atm).toBe(25150);
    const before = t.market.calls.length;
    await r("/v1/collections/n/resolve?priority=background");
    expect(t.market.calls.slice(before).find((c) => c[0] === "ltp")[2].priority).toBe("background");
    expect((await r("/v1/collections/n/resolve?priority=order")).status).toBe(400);
    expect((await r("/v1/collections/n/resolve?spot=abc")).status).toBe(400);
    expect((await r("/v1/collections/n/resolve?allowStale=maybe")).status).toBe(400);
    expect((await r("/v1/collections/n/resolve?requireLive=true")).status).toBe(200);
  });

  it("a key limited to other accounts cannot pin an account it does not have, and unpinned reads stay inside its list", async () => {
    await w("/v1/collections", { name: "n", universe: UNIVERSE });
    expect((await r("/v1/collections/n/resolve?account=dhan-other", t.keys.oneAccount)).status).toBe(403);
    const before = t.market.calls.length;
    expect((await r("/v1/collections/n/resolve", t.keys.oneAccount)).status).toBe(200);
    expect(t.market.calls.slice(before).find((c) => c[0] === "ltp")[2].allowedAccounts).toEqual(["dhan-main"]);
  });

  describe("a universe that is not saved yet (POST /v1/collections/resolve, the builder's preview)", () => {
    const draft = (body, query = "", key = t.keys.read) => t.request(`/v1/collections/resolve${query}`, { method: "POST", key, body });

    it("answers what the saved universe would, saves nothing and says it is a draft", async () => {
      await w("/v1/collections", { name: "n", universe: UNIVERSE });
      const saved = (await r("/v1/collections/n/resolve")).json.data;
      const res = await draft({ kind: "option-universe", universe: UNIVERSE });
      expect(res.status).toBe(200);
      const d = res.json.data;
      expect(d).toMatchObject({ draft: true, kind: "option-universe", atmSource: "live", count: 11 });
      expect(d.symbols).toEqual(saved.symbols);
      expect(d.rule).toBe(saved.rule);
      expect(d.expiries[0]).toMatchObject({ expiry: "2026-11-10", atm: 25000 });
      expect(d).not.toHaveProperty("id");
      expect(d).not.toHaveProperty("name");
      expect(d.resolvedAt).toBe(res.json.meta.resolvedAt);
      // the same universe without `kind`, and a different one, nothing stored
      expect((await draft({ universe: { ...UNIVERSE, strikes: { around: "atm", count: 1 } } })).json.data.count).toBe(7);
      expect((await r("/v1/collections")).json.data.map((c) => c.name)).toEqual(["n"]);
    });

    it("follows the price rules of a saved universe: an untrusted price is refused unless allowStale, spot is taken", async () => {
      t.market.setPrice("NSE:NIFTY", 25012, { class: "delayed", source: "backup" });
      expect((await draft({ universe: UNIVERSE })).status).toBe(422);
      const ok = await draft({ universe: UNIVERSE }, "?allowStale=true");
      expect(ok.status).toBe(200);
      expect(ok.json.data.atmSource).toBe("delayed");
      t.market.setPrice("NSE:NIFTY", 25012);
      expect((await draft({ universe: UNIVERSE }, "?spot=25126")).json.data.atmSource).toBe("supplied");
    });

    it("checks the body like a saved universe and refuses anything else in it", async () => {
      expect((await draft({})).status).toBe(400);
      expect((await draft([])).status).toBe(400);
      expect((await draft({ universe: { ...UNIVERSE, underlying: "nifty 50" } })).status).toBe(400);
      expect((await draft({ universe: { ...UNIVERSE, surprise: 1 } })).status).toBe(400);
      expect((await draft({ kind: "static", universe: UNIVERSE })).status).toBe(400);
      expect((await draft({ universe: UNIVERSE, name: "x" })).status).toBe(400);
      expect((await t.request("/v1/collections/resolve", { method: "POST", key: t.keys.read, raw: "{" , contentType: "application/json" })).status).toBe(400);
    });

    it("needs a key, stays inside the key's accounts, and a read key may use it (it changes nothing)", async () => {
      expect((await t.request("/v1/collections/resolve", { method: "POST", body: { universe: UNIVERSE } })).status).toBe(401);
      expect((await draft({ universe: UNIVERSE }, "?account=dhan-other", t.keys.oneAccount)).status).toBe(403);
      const before = t.market.calls.length;
      expect((await draft({ universe: UNIVERSE }, "", t.keys.oneAccount)).status).toBe(200);
      expect(t.market.calls.slice(before).find((c) => c[0] === "ltp")[2].allowedAccounts).toEqual(["dhan-main"]);
    });
  });

  it("a static collection resolves to its list", async () => {
    await w("/v1/collections", { name: "s", symbols: ["NSE:RELIANCE"] });
    expect((await r("/v1/collections/s/resolve")).json.data).toMatchObject({ symbols: ["NSE:RELIANCE"], count: 1, atmSource: "not-needed" });
  });
});

describe("export and import", () => {
  it("exports CSV and JSON as downloads", async () => {
    await w("/v1/collections", { name: "s", symbols: ["NSE:RELIANCE", "NSE:INFY"] });
    const csv = await r("/v1/collections/s/export?format=csv");
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/^text\/csv/);
    expect(csv.headers["content-disposition"]).toBe('attachment; filename="s.csv"');
    expect(csv.raw.split("\r\n")[1]).toMatch(/^NSE:RELIANCE,NSE,/);
    const js = await r("/v1/collections/s/export");
    expect(js.headers["content-type"]).toMatch(/^application\/json/);
    expect(JSON.parse(js.raw).collection.symbols).toEqual(["NSE:RELIANCE", "NSE:INFY"]);
    expect((await r("/v1/collections/s/export?format=xml")).status).toBe(400);
  });

  it("a universe exports as CSV of the moment, with the time in a header", async () => {
    await w("/v1/collections", { name: "n", universe: UNIVERSE });
    const csv = await r("/v1/collections/n/export?format=csv");
    expect(csv.headers["x-resolved-at"]).toBe("2026-11-09T05:30:00.000Z");
    expect(csv.raw.trim().split("\r\n")).toHaveLength(12);
  });

  it("imports CSV text (text/plain) with name and tags in the query, and JSON", async () => {
    const csv = await t.request("/v1/collections/import?name=fromcsv&tags=a,b", { method: "POST", key: t.keys.paper, raw: "symbol\nNSE:RELIANCE\nNSE:INFY\n", contentType: "text/plain" });
    expect(csv.status).toBe(201);
    expect(csv.json.data.created[0]).toMatchObject({ name: "fromcsv", tags: ["a", "b"], symbolCount: 2 });
    const wrapped = await w("/v1/collections/import", { format: "csv", csv: "NSE:RELIANCE\n", name: "wrapped", tags: ["z"] });
    expect(wrapped.json.data.created[0]).toMatchObject({ name: "wrapped", tags: ["z"] });
    const js = await w("/v1/collections/import", { name: "fromjson", universe: UNIVERSE });
    expect(js.json.data.created[0].kind).toBe("option-universe");
    const again = await t.request("/v1/collections/import?name=fromcsv", { method: "POST", key: t.keys.paper, raw: "NSE:INFY\n", contentType: "text/plain" });
    expect(again.status).toBe(409);
    const replaced = await t.request("/v1/collections/import?name=fromcsv&replace=true", { method: "POST", key: t.keys.admin, raw: "NSE:INFY\n", contentType: "text/plain" });
    expect(replaced.json.data.replaced[0].symbolCount).toBe(1);
    const bad = await t.request("/v1/collections/import?name=badcsv", { method: "POST", key: t.keys.paper, raw: "symbol\nNSE:INFY\n???\n", contentType: "text/plain" });
    expect(bad.status).toBe(400);
    expect(bad.json.errors[0].path).toBe("line 3");
    const nothing = await t.request("/v1/collections/import", { method: "POST", key: t.keys.paper });
    expect(nothing.status).toBe(400);
    expect((await t.request("/v1/collections/import?name=x", { method: "POST", key: t.keys.paper, raw: "a", contentType: "text/csv" })).status).toBe(415);
  });
});

describe("usage and estimate", () => {
  it("usage: nothing registered yet, so every kind says not-available and the list is empty", async () => {
    await w("/v1/collections", { name: "s", symbols: [] });
    const u = await r("/v1/collections/s/usage");
    expect(u.status).toBe(200);
    expect(u.json.data).toMatchObject({ name: "s", total: 0, downloads: [], recordings: [], datasets: [], rules: [] });
    expect(u.json.data.sources.downloads).toBe("not-available");
  });

  it("a registered provider shows up, and an active use blocks delete until force=true", async () => {
    await w("/v1/collections", { name: "s", symbols: [] });
    const off = t.app.deps.library.registerUsageProvider("recordings", () => [{ id: "rec_1", label: "chain", active: true }]);
    expect((await r("/v1/collections/s/usage")).json.data.recordings).toHaveLength(1);
    const blocked = await t.request("/v1/collections/s", { method: "DELETE", key: t.keys.admin });
    expect(blocked.status).toBe(409);
    expect((await t.request("/v1/collections/s?force=true", { method: "DELETE", key: t.keys.admin })).status).toBe(204);
    off();
  });

  it("estimate needs intervals and days, and answers rows, bytes and broker calls", async () => {
    await w("/v1/collections", { name: "s", symbols: ["NSE:RELIANCE", "NSE:INFY"] });
    const e = await r("/v1/collections/s/estimate?intervals=5m,1d&days=30");
    expect(e.status).toBe(200);
    expect(e.json.data).toMatchObject({ symbols: 2, days: 30, intervals: ["5m", "1d"], brokerCalls: 4 });
    expect(e.json.data.rows).toBeGreaterThan(0);
    expect((await r("/v1/collections/s/estimate?days=30")).status).toBe(400);
    expect((await r("/v1/collections/s/estimate?intervals=5m")).status).toBe(400);
    expect((await r("/v1/collections/s/estimate?intervals=5m&days=0")).status).toBe(400);
  });
});
