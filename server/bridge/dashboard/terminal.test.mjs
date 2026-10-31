import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GO_KEYS, safeStore } from "./workspace.js";
import { MAX_IMPORT_CHARS, MAX_LAYOUTS, createHistory, createHome, createLayouts, exportLayouts, parseCommand, parseLayoutFile, sanitizeLayout } from "./terminal.js";

const ids = Object.keys(GO_KEYS);
const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
};
const ctx = (u = "NIFTY", expiry = "", strikes = 10) => ({ underlying: u, expiry, strikes });

describe("command grammar", () => {
  it("parses [symbol] [code] in either order", () => {
    expect(parseCommand("banknifty oc", ids)).toMatchObject({ kind: "go", id: "chain", code: "OC", symbol: "BANKNIFTY", asset: null, hints: [] });
    expect(parseCommand("oi nifty", ids)).toMatchObject({ kind: "go", id: "oi", symbol: "NIFTY" });
    expect(parseCommand("GX finnifty", ids)).toMatchObject({ id: "gex", symbol: "FINNIFTY" });
    expect(parseCommand("  sk  ", ids)).toMatchObject({ id: "skew", symbol: null });
    expect(parseCommand("reliance pay", ids)).toMatchObject({ id: "payoff", symbol: "RELIANCE" });
  });
  it("is not a command for ordinary searches, unknown or doubled codes and junk", () => {
    expect(parseCommand("nifty", ids)).toBeNull();
    expect(parseCommand("go to underlying x", ids)).toBeNull();
    expect(parseCommand("oc oi", ids)).toBeNull();
    expect(parseCommand("a b oc d", ids)).toBeNull();
    expect(parseCommand("oc <script>", ids)).toBeNull();
    expect(parseCommand("", ids)).toBeNull();
    expect(parseCommand("oc", ["home"])).toBeNull(); // a page that does not exist
    expect(parseCommand("x".repeat(200), ids)).toBeNull();
  });
  it("reads EQ, FUT and OPT as the instrument type, and says when a page ignores it", () => {
    expect(parseCommand("nifty oc opt", ids)).toMatchObject({ id: "chain", asset: "OPT", hints: [] });
    expect(parseCommand("nifty ftr fut", ids)).toMatchObject({ id: "futures", asset: "FUT", hints: [] });
    const r = parseCommand("fut nifty oc", ids);
    expect(r.id).toBe("chain");
    expect(r.hints[0]).toMatch(/OC shows OPT only.*FUT was ignored/);
    expect(parseCommand("pos eq", ids).hints[0]).toMatch(/no instrument type/);
    // a symbol plus a type and no page picks that type's page
    expect(parseCommand("reliance fut", ids)).toMatchObject({ id: "futures", symbol: "RELIANCE" });
    expect(parseCommand("nifty opt", ids)).toMatchObject({ id: "chain" });
    expect(parseCommand("fut", ids)).toBeNull();
  });
  it("help <code> and ? <code>", () => {
    expect(parseCommand("help oc", ids)).toEqual({ kind: "help", id: "chain", code: "OC" });
    expect(parseCommand("? gx", ids)).toEqual({ kind: "help", id: "gex", code: "GX" });
    expect(parseCommand("?gx", ids)).toEqual({ kind: "help", id: "gex", code: "GX" });
    expect(parseCommand("HELP", ids)).toEqual({ kind: "help", id: null, code: null });
    expect(parseCommand("help nope", ids)).toBeNull();
    expect(parseCommand("help oc oi", ids)).toBeNull();
  });
});

describe("history", () => {
  it("goes back and forward over page and context, and a new step drops the forward list", () => {
    const h = createHistory();
    expect(h.canBack()).toBe(false);
    h.record({ page: "chain", ctx: ctx() });
    h.record({ page: "oi", ctx: ctx() });
    h.record({ page: "oi", ctx: ctx("BANKNIFTY") });
    expect(h.size()).toBe(3);
    expect(h.back()).toEqual({ page: "oi", ctx: ctx() });
    expect(h.back()).toEqual({ page: "chain", ctx: ctx() });
    expect(h.back()).toBeNull();
    expect(h.forward()).toEqual({ page: "oi", ctx: ctx() });
    h.record({ page: "gex", ctx: ctx() });
    expect(h.canForward()).toBe(false);
    expect(h.size()).toBe(3);
  });
  it("recording where you already are changes nothing (a restore re-draws the page)", () => {
    const h = createHistory();
    h.record({ page: "chain", ctx: ctx() });
    h.record({ page: "oi", ctx: ctx() });
    h.back();
    expect(h.record({ page: "chain", ctx: ctx() })).toBe(false);
    expect(h.canForward()).toBe(true);
  });
  it("an expiry filled in after the page loaded replaces the step", () => {
    const h = createHistory();
    h.record({ page: "chain", ctx: ctx() });
    h.record({ page: "chain", ctx: ctx("NIFTY", "2026-11-24") });
    expect(h.size()).toBe(1);
    expect(h.current().ctx.expiry).toBe("2026-11-24");
  });
  it("is capped", () => {
    const h = createHistory(3);
    for (const p of ["a", "b", "c", "d", "e"]) h.record({ page: p, ctx: ctx() });
    expect(h.size()).toBe(3);
    expect(h.back().page).toBe("d");
  });
});

describe("home page", () => {
  it("defaults to home, remembers a valid page and ignores junk", () => {
    const raw = memory();
    const mk = () => createHome(safeStore("local", raw), (id) => ids.includes(id));
    const home = mk();
    expect(home.get()).toBe("home");
    expect(home.set("chain")).toBe(true);
    expect(mk().get()).toBe("chain");
    expect(home.set("nope")).toBe(false);
    raw.setItem("mcb.dashboard.homePage", "<img>");
    expect(mk().get()).toBe("home");
    home.set("chain");
    home.set("home");
    expect(raw.getItem("mcb.dashboard.homePage")).toBeNull();
  });
});

describe("layouts", () => {
  const good = { name: "Morning", underlying: "banknifty", expiry: "2026-11-26", strikes: 15, density: "compact", autoRefresh: 15000, page: "oi", collapsed: ["Connect"] };
  it("validates every field and drops unknown keys", () => {
    const r = sanitizeLayout({ ...good, evil: "<script>", __proto__: { x: 1 }, constructor: "x" }, { pageIds: ids, groups: ["Connect", "Overview"] });
    expect(r.layout).toEqual({ ...good, underlying: "BANKNIFTY" });
    expect(Object.keys(r.layout).sort()).toEqual(["autoRefresh", "collapsed", "density", "expiry", "name", "page", "strikes", "underlying"]);
    expect(sanitizeLayout({ name: "x", underlying: "NIFTY" }).layout).toMatchObject({ strikes: 10, density: "comfortable", autoRefresh: 0, page: "", collapsed: [], expiry: "" });
    for (const bad of [null, [], "x", { underlying: "NIFTY" }, { name: "  ", underlying: "NIFTY" }, { ...good, underlying: "<b>" }, { ...good, expiry: "tomorrow" }, { ...good, expiry: "2026-13-45" }, { ...good, strikes: 0 }, { ...good, strikes: "10" }, { ...good, density: "huge" }, { ...good, autoRefresh: 7 }, { ...good, page: "../x" }, { ...good, collapsed: "Connect" }])
      expect(sanitizeLayout(bad).error, JSON.stringify(bad)).toBeTruthy();
  });
  it("forgets pages and groups this version does not have, and trims names", () => {
    const r = sanitizeLayout({ ...good, name: "  A\u0007 b  ".padEnd(80, "z"), page: "gone", collapsed: ["Nope", "Connect"] }, { pageIds: ids, groups: ["Connect"] });
    expect(r.layout.page).toBe("");
    expect(r.layout.collapsed).toEqual(["Connect"]);
    expect(r.layout.name.length).toBe(40);
    expect(r.layout.name).not.toMatch(/[\u0007]/);
  });
  it("saves, replaces by name, deletes and survives a reload; corrupt storage reads as empty", () => {
    const raw = memory();
    const mk = () => createLayouts(safeStore("local", raw));
    const l = mk();
    expect(l.save(good).ok).toBe(true);
    expect(l.save({ ...good, name: "MORNING", strikes: 5 }).ok).toBe(true);
    expect(l.list()).toHaveLength(1);
    expect(mk().get("morning").strikes).toBe(5);
    expect(l.save({ name: "" }).ok).toBe(false);
    expect(l.remove("Morning")).toBe(true);
    expect(l.remove("Morning")).toBe(false);
    expect(mk().list()).toEqual([]);
    raw.setItem("mcb.dashboard.layouts", "{not json");
    expect(mk().list()).toEqual([]);
    raw.setItem("mcb.dashboard.layouts", JSON.stringify([good, { bogus: true }]));
    expect(mk().list()).toHaveLength(1);
  });
  it("caps how many it keeps", () => {
    const l = createLayouts(safeStore("local", memory()));
    for (let i = 0; i < MAX_LAYOUTS; i++) expect(l.save({ ...good, name: `L${i}` }).ok).toBe(true);
    expect(l.save({ ...good, name: "one more" }).ok).toBe(false);
    expect(l.save({ ...good, name: "L3", strikes: 7 }).ok).toBe(true); // replacing is fine
  });
  it("exports and re-imports round trip", () => {
    const l = createLayouts(safeStore("local", memory()));
    l.save(good);
    const text = l.exportText();
    expect(JSON.parse(text)).toMatchObject({ format: "mcb-layouts", version: 1 });
    const r = parseLayoutFile(text);
    expect(r.ok).toBe(true);
    const other = createLayouts(safeStore("local", memory()));
    expect(other.importAll(r.layouts)).toBe(1);
    expect(other.list()).toEqual(l.list());
  });
  it("imports strictly: size cap, JSON, wrapper, version, count, bad entries skipped", () => {
    expect(parseLayoutFile("x".repeat(MAX_IMPORT_CHARS + 1)).error).toMatch(/larger/);
    expect(parseLayoutFile("{nope").error).toMatch(/not valid JSON/);
    expect(parseLayoutFile("[]").error).toMatch(/not a layout export/);
    expect(parseLayoutFile(JSON.stringify({ format: "other", version: 1, layouts: [] })).error).toMatch(/not a layout export/);
    expect(parseLayoutFile(JSON.stringify({ format: "mcb-layouts", version: 2, layouts: [] })).error).toMatch(/version/);
    expect(parseLayoutFile(JSON.stringify({ format: "mcb-layouts", version: 1 })).error).toMatch(/no layouts/);
    expect(parseLayoutFile(JSON.stringify({ format: "mcb-layouts", version: 1, layouts: Array(MAX_LAYOUTS + 1).fill(good) })).error).toMatch(/Too many/);
    expect(parseLayoutFile(JSON.stringify({ format: "mcb-layouts", version: 1, layouts: [{ bad: 1 }] })).ok).toBe(false);
    const mixed = parseLayoutFile(JSON.stringify({ format: "mcb-layouts", version: 1, layouts: [good, { ...good, name: "Bad", strikes: -1 }, { ...good, name: "Extra", onload: "alert(1)" }] }));
    expect(mixed.ok).toBe(true);
    expect(mixed.layouts.map((x) => x.name)).toEqual(["Morning", "Extra"]);
    expect(mixed.skipped).toHaveLength(1);
    expect(mixed.layouts[1]).not.toHaveProperty("onload");
    expect(parseLayoutFile(123).ok).toBe(false);
  });
  it("does not let a __proto__ key pollute anything", () => {
    const r = parseLayoutFile('{"format":"mcb-layouts","version":1,"layouts":[{"name":"p","underlying":"NIFTY","__proto__":{"polluted":true}}]}');
    expect(r.ok).toBe(true);
    expect({}.polluted).toBeUndefined();
    expect(r.layouts[0].polluted).toBeUndefined();
    expect(exportLayouts([])).toContain("mcb-layouts");
  });
});

describe("dashboard file allowlist", () => {
  it("serves every .js and .css file (a missing one would 404 the whole dashboard)", () => {
    const core = readFileSync(resolve(import.meta.dirname, "../core/app.mjs"), "utf8");
    const listed = new Set([...core.slice(core.indexOf("const DASHBOARD_FILES"), core.indexOf("const DASHBOARD_CSP")).matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]));
    const files = readdirSync(import.meta.dirname).filter((f) => /\.(js|css)$/.test(f));
    for (const f of files) expect(listed.has(f), `${f} is in DASHBOARD_FILES`).toBe(true);
    // every relative import of a dashboard module names a listed file
    for (const f of files.filter((x) => x.endsWith(".js"))) for (const m of readFileSync(resolve(import.meta.dirname, f), "utf8").matchAll(/from "\.\/([^"]+)"/g)) expect(listed.has(m[1]), `${f} imports ${m[1]}`).toBe(true);
  });
});
