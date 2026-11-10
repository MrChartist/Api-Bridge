import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertService } from "../core/contracts.mjs";
import { at } from "./__fixtures__/fakes.mjs";
import { cleanupLibraries, makeLibrary } from "./__fixtures__/lib.mjs";

afterEach(cleanupLibraries);

const UNIVERSE = { underlying: "NIFTY", expiries: "current-weekly", strikes: { around: "atm", count: 2 }, sides: ["CE", "PE"] };

describe("contract", () => {
  it("satisfies the library service contract", () => {
    const { lib } = makeLibrary();
    expect(() => assertService("library", lib)).not.toThrow();
  });
});

describe("library.enabled false", () => {
  it("every use answers a plain 'switched off' error", async () => {
    const { lib } = makeLibrary({ library: { enabled: false } });
    expect(() => lib.list()).toThrow(/switched off/);
    expect(() => lib.create({ name: "a", symbols: [] })).toThrow(/switched off/);
    expect(() => lib.get("a")).toThrow(expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED" }));
    await expect(lib.resolve("a")).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    expect(() => lib.importData({ data: [], name: "x" })).toThrow(/switched off/);
    expect(lib.status().enabled).toBe(false);
  });
});

describe("RDATA-08 a failed save leaves memory as the disk is", () => {
  it("create, update and remove roll back, and the retry works once the problem is fixed", async () => {
    const { lib, dataDir } = makeLibrary();
    const file = join(dataDir, "collections.json");
    lib.create({ name: "keep", symbols: ["NSE:TCS"] });
    const good = readFileSync(file, "utf8");
    // make every save fail: the target of the atomic rename is a directory
    rmSync(file);
    mkdirSync(file);
    expect(() => lib.create({ name: "wl", symbols: ["NSE:TCS"] })).toThrow(expect.objectContaining({ code: "INTERNAL" }));
    expect(lib.list().map((c) => c.name)).toEqual(["keep"]);
    expect(() => lib.update("keep", { description: "changed" })).toThrow(expect.objectContaining({ code: "INTERNAL" }));
    expect(lib.get("keep").description).toBe("");
    expect(() => lib.update("keep", { name: "renamed" })).toThrow(expect.objectContaining({ code: "INTERNAL" }));
    expect(lib.get("keep").previousNames).toEqual([]);
    await expect(lib.remove("keep")).rejects.toMatchObject({ code: "INTERNAL" });
    expect(lib.list().map((c) => c.name)).toEqual(["keep"]);
    rmSync(file, { recursive: true });
    writeFileSync(file, good);
    expect(lib.create({ name: "wl", symbols: ["NSE:TCS"] }).name).toBe("wl"); // not "already exists"
    expect(JSON.parse(readFileSync(file, "utf8")).collections.map((c) => c.name).sort()).toEqual(["keep", "wl"]);
  });
});

describe("RDATA-11 collections have an owner", () => {
  const A = { id: "key:aaa", admin: false };
  const B = { id: "key:bbb", admin: false };
  const ADMIN = { id: "key:root", admin: true };
  it("records createdBy; only the owner or an admin may update, delete or replace; anyone may read and copy", async () => {
    const { lib } = makeLibrary();
    const c = lib.create({ name: "mine", symbols: ["NSE:TCS"] }, { actor: A });
    expect(c.createdBy).toBe("key:aaa");
    expect(() => lib.update("mine", { symbols: ["NSE:INFY"] }, { actor: B })).toThrow(expect.objectContaining({ code: "SCOPE_REQUIRED" }));
    await expect(lib.remove("mine", { actor: B })).rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
    expect(() => lib.importData({ data: "NSE:INFY\n", format: "csv", name: "mine", replace: true, actor: B })).toThrow(expect.objectContaining({ code: "SCOPE_REQUIRED" }));
    expect(lib.get("mine").symbols).toEqual(["NSE:TCS"]);
    expect(lib.update("mine", { description: "ok" }, { actor: A }).description).toBe("ok");
    expect(lib.update("mine", { description: "admin" }, { actor: ADMIN }).description).toBe("admin");
    expect(lib.duplicate("mine", "copy-b", { actor: B }).createdBy).toBe("key:bbb");
    expect(lib.update("copy-b", { description: "b's" }, { actor: B }).description).toBe("b's");
    // an internal call (no actor) and a collection made before owners were recorded
    expect(lib.update("mine", { description: "internal" }).description).toBe("internal");
    const old = lib.create({ name: "legacy", symbols: ["NSE:TCS"] });
    expect(old.createdBy).toBeNull();
    expect(() => lib.update("legacy", { description: "x" }, { actor: A })).toThrow(expect.objectContaining({ code: "SCOPE_REQUIRED" }));
  });
  it("keeps the owner across a restart", () => {
    const a = makeLibrary();
    a.lib.create({ name: "mine", symbols: ["NSE:TCS"] }, { actor: { id: "key:aaa", admin: false } });
    const b = makeLibrary({ dataDir: a.dataDir });
    expect(b.lib.get("mine").createdBy).toBe("key:aaa");
  });
});

describe("create, get, list", () => {
  it("creates a static collection with canonical, de-duplicated symbols and sorted lower-case tags", () => {
    const { lib } = makeLibrary();
    const c = lib.create({ name: "banks", description: "Banks", tags: ["Cash", "banks", "cash"], symbols: ["NSE:HDFCBANK", "nse:hdfcbank", "NSE:ICICIBANK"] });
    expect(c).toMatchObject({ name: "banks", kind: "static", tags: ["banks", "cash"], symbols: ["NSE:HDFCBANK", "NSE:ICICIBANK"], symbolCount: 2 });
    expect(c.id).toMatch(/^col_[a-z0-9]{10}$/);
    expect(lib.get("BANKS").id).toBe(c.id);
    expect(lib.get(c.id).name).toBe("banks");
  });

  it("kind is inferred from the body and a mismatch is refused", () => {
    const { lib } = makeLibrary();
    expect(lib.create({ name: "u", universe: UNIVERSE }).kind).toBe("option-universe");
    expect(() => lib.create({ name: "s", kind: "static", universe: UNIVERSE })).toThrow(/symbols list/);
    expect(() => lib.create({ name: "u2", kind: "option-universe", symbols: ["NSE:RELIANCE"] })).toThrow(/universe rule/);
    expect(() => lib.create({ name: "u3", kind: "option-universe" })).toThrow(/needs a universe/);
  });

  it("fills in the universe defaults", () => {
    const { lib } = makeLibrary();
    const c = lib.create({ name: "u", universe: { underlying: "nifty" } });
    expect(c.universe).toEqual({ underlying: "NIFTY", expiries: "current-weekly", strikes: { around: "atm", count: 10 }, sides: ["CE", "PE"], includeUnderlying: true, includeFuture: false });
  });

  it("refuses bad names, duplicates (any case), reserved words, bad symbols and bad universes", () => {
    const { lib } = makeLibrary();
    lib.create({ name: "one", symbols: [] });
    expect(() => lib.create({ name: "ONE", symbols: [] })).toThrow(/already exists/);
    expect(() => lib.create({ name: "has space", symbols: [] })).toThrow(/letters, digits/);
    expect(() => lib.create({ name: "import", symbols: [] })).toThrow(/reserved/);
    expect(() => lib.create({ name: "bad", symbols: ["NSE:RELIANCE", "???"] })).toThrow(/not in a form/);
    expect(() => lib.create({ name: "u", universe: { underlying: "NIFTY", expiries: ["2026-02-30"] } })).toThrow();
    expect(() => lib.create({ name: "u", universe: { underlying: "NIFTY", strikes: { from: 26000, to: 24000 } } })).toThrow(/from must not be above to/);
    expect(() => lib.create({ name: "u", universe: { underlying: "NIFTY", sides: [] } })).toThrow();
    expect(() => lib.create({ name: "u", universe: { underlying: "NIFTY", extra: 1 } })).toThrow();
    expect(() => lib.create({ name: "t", symbols: [], tags: ["Bad Tag!"] })).toThrow(/is not a tag/);
  });

  it("lists with tag, kind and text filters, newest data without symbol lists", () => {
    const { lib } = makeLibrary();
    lib.create({ name: "b-banks", tags: ["cash", "banks"], symbols: ["NSE:HDFCBANK"] });
    lib.create({ name: "a-it", tags: ["cash", "it"], symbols: ["NSE:INFY"] });
    lib.create({ name: "c-nifty", tags: ["options"], universe: UNIVERSE });
    expect(lib.list().map((c) => c.name)).toEqual(["a-it", "b-banks", "c-nifty"]);
    expect(lib.list().every((c) => c.symbols === undefined)).toBe(true);
    expect(lib.list({ tag: "cash" }).map((c) => c.name)).toEqual(["a-it", "b-banks"]);
    expect(lib.list({ tag: "cash,banks" }).map((c) => c.name)).toEqual(["b-banks"]);
    expect(lib.list({ tag: ["cash", "options"] })).toEqual([]);
    expect(lib.list({ kind: "option-universe" }).map((c) => c.name)).toEqual(["c-nifty"]);
    expect(lib.list({ q: "INFY" })).toEqual([]);
    expect(lib.list({ q: "bank" }).map((c) => c.name)).toEqual(["b-banks"]);
  });

  it("get of an unknown collection is NOT_FOUND", () => {
    const { lib } = makeLibrary();
    expect(() => lib.get("nope")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("holds at most library.maxCollections", () => {
    const { lib } = makeLibrary({ library: { maxCollections: 2 } });
    lib.create({ name: "a", symbols: [] });
    lib.create({ name: "b", symbols: [] });
    expect(() => lib.create({ name: "c", symbols: [] })).toThrow(/at most 2 collections/);
  });

  it("refuses a static list over library.maxSymbols", () => {
    const { lib } = makeLibrary({ library: { maxSymbols: 2 } });
    expect(() => lib.create({ name: "a", symbols: ["NSE:A", "NSE:B", "NSE:C"] })).toThrow(/at most 2 symbols/);
  });
});

describe("update, tags, rename", () => {
  it("changes description, tags and symbols of a static collection and keeps the id", () => {
    const { lib } = makeLibrary();
    const c = lib.create({ name: "w", symbols: ["NSE:RELIANCE"] });
    const u = lib.update("w", { description: "mine", tags: ["x", "y"], symbols: ["NSE:INFY", "NSE:RELIANCE"] });
    expect(u).toMatchObject({ id: c.id, description: "mine", tags: ["x", "y"], symbols: ["NSE:INFY", "NSE:RELIANCE"] });
    expect(u.updatedAt >= c.updatedAt).toBe(true);
  });

  it("changes the universe of a universe, but not the kind, and not a symbols list on a universe", () => {
    const { lib } = makeLibrary();
    lib.create({ name: "u", universe: UNIVERSE });
    expect(lib.update("u", { universe: { ...UNIVERSE, strikes: { around: "atm", count: 5 } } }).universe.strikes.count).toBe(5);
    expect(() => lib.update("u", { symbols: ["NSE:RELIANCE"] })).toThrow(/no symbols list/);
    expect(() => lib.update("u", { kind: "static" })).toThrow(/cannot be changed/);
    lib.create({ name: "s", symbols: [] });
    expect(() => lib.update("s", { universe: UNIVERSE })).toThrow(/no universe/);
    expect(() => lib.update("s", {})).toThrow(/at least one/);
  });

  it("rename: the id stays, the old name still finds it (labelled), the new name must be free", async () => {
    const { lib, events } = makeLibrary();
    const c = lib.create({ name: "old", symbols: ["NSE:RELIANCE"] });
    lib.create({ name: "other", symbols: [] });
    expect(() => lib.update("old", { name: "OTHER" })).toThrow(/already exists/);
    const r = lib.update("old", { name: "fresh" });
    expect(r).toMatchObject({ id: c.id, name: "fresh", previousNames: ["old"] });
    expect(lib.get("old")).toMatchObject({ name: "fresh", viaOldName: true });
    expect(lib.get(c.id).name).toBe("fresh");
    const res = await lib.resolve("old");
    expect(res.viaOldName).toBe(true);
    expect(res.warnings.join(" ")).toMatch(/was renamed; "old" is its old name/);
    expect(events.at(-1)).toEqual(["collection.changed", expect.objectContaining({ action: "renamed", name: "fresh", from: "old", id: c.id })]);
    // a new collection can take the old name
    const reuse = lib.create({ name: "old", symbols: [] });
    expect(lib.get("old").id).toBe(reuse.id);
    expect(lib.get(c.id).previousNames).toEqual([]);
  });

  it("renaming to a new case of its own name is allowed", () => {
    const { lib } = makeLibrary();
    lib.create({ name: "abc", symbols: [] });
    expect(lib.update("abc", { name: "ABC" }).name).toBe("ABC");
  });
});

describe("duplicate and delete", () => {
  it("copies the definition under a free name (-copy, -copy2, or the one given)", () => {
    const { lib } = makeLibrary();
    lib.create({ name: "base", tags: ["t"], description: "d", universe: UNIVERSE });
    const a = lib.duplicate("base");
    const b = lib.duplicate("base");
    const c = lib.duplicate("base", "mine");
    expect([a.name, b.name, c.name]).toEqual(["base-copy", "base-copy2", "mine"]);
    expect(a).toMatchObject({ kind: "option-universe", tags: ["t"], description: "d", universe: lib.get("base").universe });
    expect(a.id).not.toBe(lib.get("base").id);
    expect(() => lib.duplicate("base", "MINE")).toThrow(/already exists/);
    // changing the copy leaves the original alone
    lib.update("base-copy", { universe: { ...UNIVERSE, strikes: { around: "atm", count: 9 } } });
    expect(lib.get("base").universe.strikes.count).toBe(2);
  });

  it("deletes, and says so on the event bus", async () => {
    const { lib, events } = makeLibrary();
    lib.create({ name: "gone", symbols: [] });
    await lib.remove("gone");
    expect(() => lib.get("gone")).toThrow();
    expect(events.map((e) => e[1].action)).toEqual(["created", "deleted"]);
    await expect(lib.remove("gone")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("events carry no symbol lists", () => {
    const { lib, events } = makeLibrary();
    lib.create({ name: "e", tags: ["a"], symbols: ["NSE:RELIANCE"] });
    expect(events[0][1]).toEqual({ action: "created", id: expect.any(String), name: "e", kind: "static", tags: ["a"] });
  });
});

describe("usage view", () => {
  it("asks each registered provider with the name, id and earlier names, and says which kinds are not there", async () => {
    const { lib } = makeLibrary();
    const c = lib.create({ name: "u", symbols: [] });
    lib.update("u", { name: "u2" });
    const seen = [];
    lib.registerUsageProvider("downloads", (q) => {
      seen.push(q);
      return [{ id: "dl_1", label: "nightly", status: "done", active: false }];
    });
    lib.registerUsageProvider("recordings", async () => [{ id: "rec_1", label: "chain", status: "running", active: true }]);
    const u = await lib.usage("u2");
    expect(seen[0]).toEqual({ id: c.id, name: "u2", names: ["u2", "u"] });
    expect(u).toMatchObject({ name: "u2", total: 2, downloads: [{ id: "dl_1" }], recordings: [{ id: "rec_1" }], datasets: [], rules: [] });
    expect(u.sources).toEqual({ downloads: "available", recordings: "available", rules: "not-available", datasets: "not-available" });
    expect(u.note).toMatch(/not-available/);
  });

  it("a provider that throws is reported as an error and does not fail the view", async () => {
    const { lib, warnings } = makeLibrary();
    lib.create({ name: "u", symbols: [] });
    lib.registerUsageProvider("datasets", () => {
      throw new Error("boom");
    });
    const u = await lib.usage("u");
    expect(u.sources.datasets).toBe("error");
    expect(warnings).toHaveLength(1);
  });

  it("refuses to delete a collection something active uses, unless forced", async () => {
    const { lib } = makeLibrary();
    lib.create({ name: "u", symbols: [] });
    lib.registerUsageProvider("rules", () => [{ id: "r1", label: "every day", active: true }]);
    await expect(lib.remove("u")).rejects.toMatchObject({ code: "STATE_CONFLICT", detail: expect.stringMatching(/in use by rule every day/) });
    await lib.remove("u", { force: true });
    expect(lib.list()).toEqual([]);
  });

  it("an unknown usage kind is a programming error", () => {
    const { lib } = makeLibrary();
    expect(() => lib.registerUsageProvider("things", () => [])).toThrow();
  });
});

describe("resolve of a static collection", () => {
  it("returns the stored list and warns about expired contracts", async () => {
    const { lib } = makeLibrary();
    lib.create({ name: "mix", symbols: ["NSE:RELIANCE", "NFO:NIFTY-2026-11-03-25000-CE", "NFO:NIFTY-2026-11-24-25000-CE"] });
    const r = await lib.resolve("mix");
    expect(r).toMatchObject({ kind: "static", count: 3, atmSource: "not-needed", rule: "a fixed list of symbols" });
    expect(r.warnings).toEqual([expect.stringMatching(/1 contract has already expired \(for example NFO:NIFTY-2026-11-03-25000-CE\)/)]);
  });

  it("a universe is recomputed on every resolve: the ATM moves with the price and the expiry rolls with the day", async () => {
    const t = makeLibrary();
    t.lib.create({ name: "n", universe: UNIVERSE });
    const first = await t.lib.resolve("n");
    expect(first.expiries[0]).toMatchObject({ expiry: "2026-11-10", atm: 25000 });
    t.market.setPrice("NSE:NIFTY", 25260);
    expect((await t.lib.resolve("n")).expiries[0].atm).toBe(25250);
    t.clock.t = at("2026-11-10T16:00:00+05:30");
    expect((await t.lib.resolve("n")).expiries[0].expiry).toBe("2026-11-17");
  });
});

describe("estimate", () => {
  it("symbols x intervals x days for a static list", async () => {
    const { lib } = makeLibrary();
    lib.create({ name: "two", symbols: ["NSE:RELIANCE", "NSE:INFY"] });
    const e = await lib.estimate("two", ["5m", "1d"], 30);
    // 30 days back from Mon 9 Nov 2026: 21 weekdays minus the holidays in the shipped calendar's coverage is checked in estimate.test
    expect(e).toMatchObject({ name: "two", symbols: 2, intervals: ["5m", "1d"], days: 30 });
    expect(e.rows).toBe(2 * (75 + 1) * e.tradingDays);
    expect(e.bytes).toBe(e.rows * 70);
    expect(e.brokerCalls).toBe(2 * 1 + 2 * 1);
    expect(e.perInterval.map((p) => p.interval)).toEqual(["5m", "1d"]);
  });

  it("a universe is resolved first, even on a stale price, and the answer says which price it used", async () => {
    const t = makeLibrary();
    t.lib.create({ name: "n", universe: UNIVERSE });
    t.market.setPrice("NSE:NIFTY", 25012, { class: "delayed" });
    const e = await t.lib.estimate("n", "1m", 5);
    expect(e.symbols).toBe(1 + 5 * 2);
    expect(e.atmSource).toBe("delayed");
    expect(e.warnings.join(" ")).toMatch(/delayed/);
  });

  it("refuses unknown intervals and silly day counts", async () => {
    const { lib } = makeLibrary();
    lib.create({ name: "s", symbols: ["NSE:RELIANCE"] });
    await expect(lib.estimate("s", "7m", 5)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(lib.estimate("s", "5m", 0)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(lib.estimate("s", "5m", "abc")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(lib.estimate("s", "", 5)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("import and export", () => {
  it("CSV round trip: export a static list, import it under another name", async () => {
    const { lib } = makeLibrary();
    lib.create({ name: "src", symbols: ["NSE:RELIANCE", "NFO:NIFTY-2026-11-24-25000-CE"] });
    const out = await lib.exportData("src", { format: "csv" });
    expect(out.contentType).toMatch(/text\/csv/);
    expect(out.body.split("\r\n")[0]).toBe("symbol,exchange,kind,underlying,expiry,strike,right");
    expect(out.body).toContain("NFO:NIFTY-2026-11-24-25000-CE,NFO,OPT,NIFTY,2026-11-24,25000,CE");
    const r = lib.importData({ data: out.body, name: "copy", tags: ["Imported"] });
    expect(r.created[0]).toMatchObject({ name: "copy", tags: ["imported"], symbolCount: 2 });
    expect(lib.get("copy").symbols).toEqual(lib.get("src").symbols);
  });

  it("CSV export of a universe lists the symbols as resolved now", async () => {
    const { lib } = makeLibrary();
    lib.create({ name: "n", universe: UNIVERSE });
    const out = await lib.exportData("n", { format: "csv" });
    expect(out.body.trim().split("\r\n")).toHaveLength(1 + 1 + 10);
    expect(out.resolvedAt).toBeTruthy();
  });

  it("JSON round trip keeps the definition (a universe stays a universe)", async () => {
    const { lib } = makeLibrary();
    lib.create({ name: "n", description: "d", tags: ["a"], universe: UNIVERSE });
    const out = await lib.exportData("n", { format: "json" });
    const file = JSON.parse(out.body);
    expect(file).toMatchObject({ version: 1, collection: { name: "n", kind: "option-universe", tags: ["a"], universe: expect.objectContaining({ underlying: "NIFTY" }) } });
    expect(file.collection.id).toBeUndefined();
    const r = lib.importData({ data: out.body, name: "n2" });
    expect(r.created[0].name).toBe("n2");
    expect(lib.get("n2").universe).toEqual(lib.get("n").universe);
  });

  it("resolved JSON export turns a universe into the static list of the moment", async () => {
    const { lib } = makeLibrary();
    lib.create({ name: "n", universe: UNIVERSE });
    const file = JSON.parse((await lib.exportData("n", { format: "json", resolved: true })).body);
    expect(file.collection.kind).toBe("static");
    expect(file.collection.symbols).toHaveLength(11);
  });

  it("CSV import: header named symbol in any column, no header, spreadsheet apostrophes, quotes and blank lines", () => {
    const { lib } = makeLibrary();
    lib.importData({ data: "name,Symbol\r\nfoo,NSE:RELIANCE\r\n\r\nbar,'NSE:INFY\r\n", name: "h" });
    expect(lib.get("h").symbols).toEqual(["NSE:RELIANCE", "NSE:INFY"]);
    lib.importData({ data: "NSE:RELIANCE\nNSE:M&M\n", name: "nohead" });
    expect(lib.get("nohead").symbols).toEqual(["NSE:RELIANCE", "NSE:M&M"]);
    lib.importData({ data: '"NSE:RELIANCE"\n', name: "quoted" });
    expect(lib.get("quoted").symbols).toEqual(["NSE:RELIANCE"]);
    lib.importData({ data: "Ticker\nNSE:INFY\n", name: "tk" });
    expect(lib.get("tk").symbols).toEqual(["NSE:INFY"]);
  });

  it("CSV import with a bad line imports nothing, and names the line; skipInvalid imports the rest", () => {
    const { lib } = makeLibrary();
    const csv = "symbol\nNSE:RELIANCE\nNOT A SYMBOL\nNSE:INFY\n";
    expect(() => lib.importData({ data: csv, name: "x" })).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED", errors: [expect.objectContaining({ path: "line 3" })] }));
    expect(lib.list()).toEqual([]);
    const r = lib.importData({ data: csv, name: "x", skipInvalid: true });
    expect(r.created[0].symbolCount).toBe(2);
    expect(r.warnings[0]).toMatch(/1 line was skipped: line 3/);
  });

  it("CSV needs a name; an existing name conflicts unless replace; replace may change the kind", () => {
    const { lib } = makeLibrary();
    expect(() => lib.importData({ data: "symbol\nNSE:INFY\n" })).toThrow(/Say what to call/);
    lib.create({ name: "u", universe: UNIVERSE });
    expect(() => lib.importData({ data: "symbol\nNSE:INFY\n", name: "u" })).toThrow(expect.objectContaining({ code: "STATE_CONFLICT" }));
    const r = lib.importData({ data: "symbol\nNSE:INFY\n", name: "u", replace: true });
    expect(r.replaced[0]).toMatchObject({ name: "u", kind: "static", symbolCount: 1 });
    expect(lib.get("u").universe).toBeUndefined();
    expect(lib.get("u").symbols).toEqual(["NSE:INFY"]);
  });

  it("JSON import: a plain array of symbols, a collections list (all or nothing), and fields from other exports ignored", () => {
    const { lib } = makeLibrary();
    lib.importData({ data: ["NSE:RELIANCE"], name: "arr" });
    expect(lib.get("arr").symbols).toEqual(["NSE:RELIANCE"]);
    const many = { collections: [{ name: "m1", symbols: ["NSE:INFY"], id: "x", createdAt: "y" }, { name: "m2", universe: UNIVERSE }] };
    const r = lib.importData({ data: JSON.stringify(many) });
    expect(r.created.map((c) => c.name)).toEqual(["m1", "m2"]);
    const bad = { collections: [{ name: "ok", symbols: [] }, { name: "m1", symbols: [] }] };
    expect(() => lib.importData({ data: bad })).toThrow(/already exists/);
    expect(lib.get("m1").symbols).toEqual(["NSE:INFY"]);
    expect(() => lib.get("ok")).toThrow();
    expect(() => lib.importData({ data: "{not json", format: "json" })).toThrow(expect.objectContaining({ code: "INVALID_JSON" }));
    expect(() => lib.importData({ data: { collections: [{ name: "d", symbols: [] }, { name: "D", symbols: [] }] } })).toThrow(/two collections/);
  });

  it("an unclosed quote in a CSV is refused", () => {
    const { lib } = makeLibrary();
    expect(() => lib.importData({ data: '"NSE:RELIANCE\n', name: "q", format: "csv" })).toThrow(/never closed/);
  });
});

describe("persistence", () => {
  it("writes collections.json atomically (no temp files left), and a new service on the same folder sees everything", () => {
    const a = makeLibrary();
    a.lib.create({ name: "keep", tags: ["x"], symbols: ["NSE:RELIANCE"] });
    a.lib.create({ name: "u", universe: UNIVERSE });
    a.lib.update("keep", { name: "kept" });
    const file = join(a.dataDir, "collections.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1, collections: [expect.objectContaining({ name: "kept", previousNames: ["keep"] }), expect.objectContaining({ name: "u" })] });
    expect(readdirSync(a.dataDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const b = makeLibrary({ dataDir: a.dataDir });
    expect(b.lib.list().map((c) => c.name)).toEqual(["kept", "u"]);
    expect(b.lib.get("keep").name).toBe("kept");
    expect(b.lib.get("kept").id).toBe(a.lib.get("kept").id);
    expect(b.lib.status()).toMatchObject({ collections: 2, loadedFrom: "file" });
  });

  it("the file is private (mode 600)", () => {
    const a = makeLibrary();
    a.lib.create({ name: "k", symbols: [] });
    if (process.platform !== "win32") expect(statMode(join(a.dataDir, "collections.json"))).toBe(0o600);
  });

  it("a damaged file is moved aside and the library starts empty, with a warning", () => {
    const a = makeLibrary();
    writeFileSync(join(a.dataDir, "collections.json"), "{ this is not json");
    const b = makeLibrary({ dataDir: a.dataDir });
    expect(b.lib.list()).toEqual([]);
    expect(b.lib.status().loadedFrom).toBe("corrupt");
    expect(readdirSync(a.dataDir).some((f) => f.startsWith("collections.json.corrupt-"))).toBe(true);
    expect(b.warnings[0][0]).toMatch(/could not be read/);
    b.lib.create({ name: "fresh", symbols: [] });
    expect(existsSync(join(a.dataDir, "collections.json"))).toBe(true);
  });

  it("an unusable entry in a hand-edited file is skipped, the rest loads", () => {
    const a = makeLibrary();
    a.lib.create({ name: "good", symbols: ["NSE:RELIANCE"] });
    const file = join(a.dataDir, "collections.json");
    const data = JSON.parse(readFileSync(file, "utf8"));
    data.collections.push({ id: "nope", name: "bad" }, { ...data.collections[0], id: "col_aaaaaaaaaa", name: "GOOD" });
    writeFileSync(file, JSON.stringify(data));
    const b = makeLibrary({ dataDir: a.dataDir });
    expect(b.lib.list().map((c) => c.name)).toEqual(["good"]);
    expect(b.warnings.some((w) => /skipped/.test(w[0]))).toBe(true);
  });
});

function statMode(p) {
  return statSync(p).mode & 0o777;
}
