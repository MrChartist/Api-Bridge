import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BridgeError } from "../core/errors.mjs";
import { startLibraryApp } from "./__fixtures__/app.mjs";
import { collectionsCommand, universeFromFlags } from "./cli.mjs";

let t;
let dir;
beforeAll(async () => {
  t = await startLibraryApp();
  dir = mkdtempSync(join(tmpdir(), "mcb-libcli-"));
});
afterAll(async () => {
  await t.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  for (const c of (await t.request("/v1/collections", { key: t.keys.read })).json.data) await t.request(`/v1/collections/${c.name}?force=true`, { method: "DELETE", key: t.keys.admin });
});

/** The same shape of client the real CLI gets: JSON in, parsed JSON out, a BridgeError on a problem. */
function connectWith(key) {
  return async () => ({
    call: async (method, path, body) => {
      const res = await t.request(path, { method, key, ...(body ? { body } : {}) });
      if (res.status >= 400) throw new BridgeError(res.json?.code && ["NOT_FOUND", "VALIDATION_FAILED", "STATE_CONFLICT"].includes(res.json.code) ? res.json.code : "UPSTREAM_ERROR", res.json?.detail ?? `HTTP ${res.status}`);
      return res.json ?? {};
    },
  });
}

async function run(args, flags = {}, key = t.keys.admin) {
  const out = [];
  const err = [];
  const code = await collectionsCommand(args, flags, { out: (s) => out.push(s), err: (s) => err.push(s), cwd: dir, env: {} }, { connect: connectWith(key), cli: "mc-bridge", usage: "USAGE TEXT" });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("flags to a universe", () => {
  it("reads underlying, expiries (a rule or dates), strikes (atm:N or from/to), sides and the switches", () => {
    expect(universeFromFlags({ underlying: "NIFTY" })).toEqual({ underlying: "NIFTY" });
    expect(universeFromFlags({ underlying: "BANKNIFTY", expiries: "current-monthly", strikes: "atm:7", sides: "ce", future: true, "no-underlying": true })).toEqual({
      underlying: "BANKNIFTY",
      expiries: "current-monthly",
      strikes: { around: "atm", count: 7 },
      sides: ["CE"],
      includeFuture: true,
      includeUnderlying: false,
    });
    expect(universeFromFlags({ underlying: "NIFTY", expiries: "2026-11-24,2026-12-01", from: "24000", to: "26000" })).toEqual({ underlying: "NIFTY", expiries: ["2026-11-24", "2026-12-01"], strikes: { from: 24000, to: 26000 } });
  });
  it("refuses what it cannot read", () => {
    expect(() => universeFromFlags({})).toThrow(/--underlying/);
    expect(() => universeFromFlags({ underlying: "NIFTY", from: "24000" })).toThrow(/go together/);
    expect(() => universeFromFlags({ underlying: "NIFTY", strikes: "wide" })).toThrow(/atm:<count>/);
    expect(() => universeFromFlags({ underlying: "NIFTY", from: "x", to: "y" })).toThrow(/must be a number/);
  });
});

describe("collections command", () => {
  it("prints the usage for an unknown subcommand, without calling the Bridge", async () => {
    const r = await run(["bogus"]);
    expect(r.code).toBe(1);
    expect(r.err).toBe("USAGE TEXT");
  });

  it("create, list, show, tag, rename, duplicate, delete", async () => {
    expect((await run(["create", "banks"], { symbols: "NSE:HDFCBANK,NSE:ICICIBANK", tags: "cash", description: "Banks" })).out).toBe('Created "banks" with 2 symbols.');
    await run(["universe", "nifty-weekly"], { underlying: "NIFTY", strikes: "atm:2", tags: "options" });
    const list = await run(["list"]);
    expect(list.out).toMatch(/banks\s+2 symbols\s+cash/);
    expect(list.out).toMatch(/nifty-weekly\s+option universe\s+options/);
    expect((await run(["list"], { tag: "options" })).out).not.toMatch(/banks/);
    expect(JSON.parse((await run(["list"], { json: true })).out)).toHaveLength(2);
    const show = await run(["show", "banks"]);
    expect(show.out).toMatch(/banks {2}\(static, id col_/);
    expect(show.out).toMatch(/NSE:HDFCBANK, NSE:ICICIBANK/);
    expect((await run(["show", "nifty-weekly"])).out).toMatch(/NIFTY options, expiries current-weekly, 2 each side of the ATM strike, CE\+PE, with the index/);
    expect((await run(["tag", "banks", "add", "bluechip,Cash"])).out).toBe("banks: tags are now bluechip, cash.");
    expect((await run(["tag", "banks", "remove", "cash"])).out).toBe("banks: tags are now bluechip.");
    expect((await run(["tag", "banks", "set", "a,b"])).out).toBe("banks: tags are now a, b.");
    expect((await run(["rename", "banks", "private-banks"])).out).toMatch(/Renamed to "private-banks"/);
    expect((await run(["show", "banks"])).out).toMatch(/earlier names: banks/);
    expect((await run(["duplicate", "private-banks"])).out).toBe('Copied to "private-banks-copy".');
    expect((await run(["duplicate", "private-banks", "mine"])).out).toBe('Copied to "mine".');
    expect((await run(["delete", "mine"])).out).toBe('Deleted "mine".');
    await expect(run(["show", "mine"])).rejects.toThrow(/no collection called/);
  });

  it("resolve prints the rule, the price and its source, each expiry, notes and the symbols", async () => {
    await run(["universe", "n"], { underlying: "NIFTY", strikes: "atm:1", "no-underlying": true });
    const r = await run(["resolve", "n"]);
    expect(r.out).toMatch(/^n: 6 symbols at 2026-11-09T05:30:00.000Z/);
    expect(r.out).toMatch(/Price: NSE:NIFTY 25012 \(live/);
    expect(r.out).toMatch(/Expiry 2026-11-10 \(weekly\): ATM 25000, step 50, 3 strikes 24950-25050/);
    // strikes = 3, sides = 2 -> 6 contracts
    expect(r.out.split("\n").filter((l) => l.startsWith("NFO:"))).toHaveLength(6);
    t.market.setPrice("NSE:NIFTY", 25012, { class: "delayed" });
    await expect(run(["resolve", "n"])).rejects.toThrow(/delayed/);
    const ok = await run(["resolve", "n"], { "allow-stale": true });
    expect(ok.out).toMatch(/\(delayed, delayed/);
    expect(ok.out).toMatch(/Note: .*delayed source/);
    t.market.setPrice("NSE:NIFTY", 25012);
    const spot = await run(["resolve", "n"], { spot: "25126", json: true });
    expect(JSON.parse(spot.out).atmSource).toBe("supplied");
  });

  it("export and import: JSON to a file (never overwrites), CSV back in, a file named after itself", async () => {
    await run(["create", "src"], { symbols: "NSE:RELIANCE,NSE:INFY", tags: "x" });
    const jsonFile = join(dir, "src.json");
    expect((await run(["export", "src"], { out: "src.json" })).out).toMatch(/^Wrote .*src\.json/);
    expect(JSON.parse(readFileSync(jsonFile, "utf8")).collection.symbols).toEqual(["NSE:RELIANCE", "NSE:INFY"]);
    await expect(run(["export", "src"], { out: "src.json" })).rejects.toThrow(/already exists/);
    const csvOut = await run(["export", "src"], { format: "csv" });
    expect(csvOut.out.split("\r\n")[0]).toBe("symbol,exchange,kind,underlying,expiry,strike,right");
    writeFileSync(join(dir, "my-list.csv"), csvOut.out);
    const imp = await run(["import", "my-list.csv"], { tags: "fromfile" });
    expect(imp.out).toBe('Created "my-list" (2 symbols).');
    expect(JSON.parse((await run(["show", "my-list"], { json: true })).out)).toMatchObject({ tags: ["fromfile"], symbols: ["NSE:RELIANCE", "NSE:INFY"] });
    const j = await run(["import", "src.json"], { name: "src2" });
    expect(j.out).toBe('Created "src2" (2 symbols).');
    await expect(run(["import", "src.json"], { name: "src2" })).rejects.toThrow(/already exists/);
    expect((await run(["import", "src.json"], { name: "src2", replace: true })).out).toBe('Replaced "src2".');
    await expect(run(["import", "missing.csv"])).rejects.toThrow(/There is no file/);
  });

  it("create from a CSV file, and the argument checks", async () => {
    writeFileSync(join(dir, "w.csv"), "symbol\nNSE:RELIANCE\nNSE:M&M\n");
    expect((await run(["create", "fromfile"], { file: "w.csv" })).out).toBe('Created "fromfile" with 2 symbols.');
    await expect(run(["create", "empty"])).rejects.toThrow(/needs --symbols/);
    await expect(run(["show"])).rejects.toThrow(/needs a collection name/);
    await expect(run(["tag", "fromfile", "flip", "a"])).rejects.toThrow(/Use: mc-bridge collections tag/);
    await expect(run(["rename", "fromfile"])).rejects.toThrow(/Use: mc-bridge collections rename/);
    await expect(run(["estimate", "fromfile"])).rejects.toThrow(/Use: mc-bridge collections estimate/);
  });

  it("usage and estimate", async () => {
    await run(["create", "two"], { symbols: "NSE:RELIANCE,NSE:INFY" });
    const u = await run(["usage", "two"]);
    expect(u.out).toMatch(/two: used by 0 things\./);
    expect(u.out).toMatch(/downloads: not counted \(that part of the Bridge is off\)/);
    t.app.deps.library.registerUsageProvider("downloads", () => [{ id: "dl1", label: "nightly" }]);
    expect((await run(["usage", "two"])).out).toMatch(/downloads: nightly/);
    const e = await run(["estimate", "two"], { interval: "5m,1d", days: "30" });
    expect(e.out).toMatch(/two: 2 symbols x 5m, 1d x 30 days \(\d+ trading days\)/);
    expect(e.out).toMatch(/About [\d,]+ rows, .* as CSV, 4 broker calls\./);
  });

  it("a read key can make collections; deleting one is refused (it needs admin), and the message says so", async () => {
    await run(["create", "r"], { symbols: "NSE:RELIANCE" }, t.keys.read);
    expect((await run(["list"], {}, t.keys.read)).out).toMatch(/^r /);
    await expect(run(["delete", "r"], {}, t.keys.read)).rejects.toThrow(/HTTP 403|scope|admin/i);
    expect((await run(["list"], {}, t.keys.read)).out).toMatch(/^r /);
  });
});
