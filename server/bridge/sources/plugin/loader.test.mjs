import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateDescriptor } from "../contract.mjs";
import { PURPOSES_REFUSED_FOR_PLUGINS, inspectPluginFolder, loadPlugins, pinOf } from "./loader.mjs";
import { fakeSpawn, goodQuotes, testManifest } from "./__fixtures__/fakeChild.mjs";

const NOW = Date.parse("2026-10-19T10:00:00+05:30");
const ENTRY = "export default { async quotes() { return { items: [] }; } };\n";

function makePlugin(manifest = {}, { entry = ENTRY, entryName = "index.mjs" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mcb-plugin-"));
  const m = testManifest(manifest);
  writeFileSync(join(dir, "mc-source.json"), JSON.stringify(m, null, 2));
  mkdirSync(join(dir, entryName, ".."), { recursive: true });
  writeFileSync(join(dir, entryName), entry);
  return { dir, manifest: m };
}

const pinFor = (dir) => inspectPluginFolder(dir).pin;
const load = (entries, opts = {}) => {
  const fs = fakeSpawn({ capabilities: ["quotes", "history", "expiries", "optionChain"], onMessage: (m, c) => m.type === "call" && c.say({ type: "result", id: m.id, data: goodQuotes(NOW - 900_000) }) });
  const r = loadPlugins({ entries, spawnImpl: fs.spawnImpl, clock: () => NOW, stopGraceMs: 10, ...opts });
  stops.push(r.stop);
  return { ...r, fs };
};
const stops = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((s) => s()));
});

describe("pinOf", () => {
  it("changes when either file changes", () => {
    const a = pinOf("m", "e");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(pinOf("m2", "e")).not.toBe(a);
    expect(pinOf("m", "e2")).not.toBe(a);
    expect(pinOf("m", "e")).toBe(a);
    expect(pinOf(Buffer.from("m"), Buffer.from("e"))).toBe(a);
  });
});

describe("loadPlugins: what must hold before a plugin loads", () => {
  it("loads a granted, pinned plugin and returns a provider with a valid descriptor", () => {
    const { dir } = makePlugin();
    const { providers, problems } = load([{ path: dir, sha256: pinFor(dir), granted: true }]);
    expect(problems).toEqual([]);
    expect(providers).toHaveLength(1);
    const d = providers[0].descriptor;
    expect(validateDescriptor(d).ok).toBe(true);
    expect(d).toMatchObject({ id: "fake-plugin", kind: "plugin", tier: "plugin", official: false, class: "delayed", delaySec: 900, flags: ["plugin", "unofficial", "delayed"], trust: "untrusted" });
    expect(providers[0].plugin).toMatchObject({ version: "1.0.0", pin: pinFor(dir) });
  });

  it("refuses a plugin that is not granted, whatever else is true", () => {
    const { dir } = makePlugin();
    for (const granted of [false, undefined, "true", 1, null]) {
      const { providers, problems } = load([{ path: dir, sha256: pinFor(dir), granted }]);
      expect(providers).toEqual([]);
      expect(problems[0].reason).toMatch(/not granted/);
    }
  });

  it("refuses when the pin is missing or malformed", () => {
    const { dir } = makePlugin();
    for (const sha256 of [undefined, "", "abc", "Z".repeat(64)]) {
      const { providers, problems } = load([{ path: dir, sha256, granted: true }]);
      expect(providers).toEqual([]);
      expect(problems[0].reason).toMatch(/pin/);
    }
  });

  it("refuses a changed entry file until the owner updates the pin", () => {
    const { dir } = makePlugin();
    const pin = pinFor(dir);
    writeFileSync(join(dir, "index.mjs"), `${ENTRY}// a quiet change\n`);
    const { providers, problems } = load([{ path: dir, sha256: pin, granted: true }]);
    expect(providers).toEqual([]);
    expect(problems[0]).toMatchObject({ id: "fake-plugin" });
    expect(problems[0].reason).toMatch(/changed since they were pinned/);
    expect(problems[0].reason).toMatch(/plugins pin/);
    // Updating the pin is the explicit step.
    expect(load([{ path: dir, sha256: pinFor(dir), granted: true }]).providers).toHaveLength(1);
  });

  it("refuses a changed manifest, even one that widens network.allowHosts", () => {
    const { dir, manifest } = makePlugin();
    const pin = pinFor(dir);
    writeFileSync(join(dir, "mc-source.json"), JSON.stringify({ ...manifest, network: { allowHosts: ["api.vendor-example.com", "evil.example.org"] } }));
    const { providers, problems } = load([{ path: dir, sha256: pin, granted: true }]);
    expect(providers).toEqual([]);
    expect(problems[0].reason).toMatch(/changed since they were pinned/);
  });

  it("refuses an invalid manifest with every problem listed, and never starts it", () => {
    const { dir } = makePlugin({ capabilities: ["orders"], official: true });
    const { providers, problems, fs } = load([{ path: dir, sha256: "a".repeat(64), granted: true }]);
    expect(providers).toEqual([]);
    expect(problems[0].reason).toMatch(/capabilities/);
    expect(problems[0].reason).toMatch(/official/);
    expect(fs.calls).toHaveLength(0);
  });

  it("refuses a missing folder, a missing manifest, a missing entry, and an entry outside the folder", () => {
    expect(load([{ path: join(tmpdir(), "mcb-nope-xyz"), sha256: "a".repeat(64), granted: true }]).problems[0].reason).toMatch(/does not exist/);
    const empty = mkdtempSync(join(tmpdir(), "mcb-plugin-"));
    expect(load([{ path: empty, sha256: "a".repeat(64), granted: true }]).problems[0].reason).toMatch(/no mc-source\.json/);
    const { dir } = makePlugin({ entry: "gone.mjs" });
    expect(load([{ path: dir, sha256: "a".repeat(64), granted: true }]).problems[0].reason).toMatch(/does not exist/);
    const outside = makePlugin();
    const sneaky = makePlugin({ entry: "link.mjs" });
    symlinkSync(join(outside.dir, "index.mjs"), join(sneaky.dir, "link.mjs"));
    const r = load([{ path: sneaky.dir, sha256: "a".repeat(64), granted: true }]);
    expect(r.providers).toEqual([]);
    expect(r.problems[0].reason).toMatch(/outside the plugin folder/);
  });

  it("refuses a plugin folder that holds any symbolic link, at any depth, file or folder, even a dangling one", () => {
    const secretDir = mkdtempSync(join(tmpdir(), "mcb-secret-"));
    writeFileSync(join(secretDir, "master.key"), "MASTER");
    for (const [where, target, name] of [
      [".", join(secretDir, "master.key"), "notes.txt"],
      [".", secretDir, "data"],
      ["fixtures/deep", join(secretDir, "master.key"), "quotes.json"],
      [".", join(secretDir, "does-not-exist"), "dangling"],
    ]) {
      const { dir } = makePlugin();
      mkdirSync(join(dir, where), { recursive: true });
      symlinkSync(target, join(dir, where, name));
      const info = inspectPluginFolder(dir);
      expect(info.ok).toBe(false);
      expect(info.problems[0]).toMatch(/symbolic link/);
      const r = load([{ path: dir, sha256: "a".repeat(64), granted: true }]);
      expect(r.providers).toEqual([]);
      expect(r.problems[0].reason).toMatch(/symbolic link/);
      expect(r.fs.calls).toHaveLength(0); // nothing was started
    }
  });

  it("refuses a plugin folder with an unreasonable number of files", () => {
    const { dir } = makePlugin();
    for (let i = 0; i < 5; i++) {
      const d = join(dir, `d${i}`);
      mkdirSync(d);
      for (let j = 0; j < 1100; j++) writeFileSync(join(d, `f${j}`), "x");
    }
    expect(inspectPluginFolder(dir).problems[0]).toMatch(/more than 5000/);
  });

  it("refuses a folder whose path has a comma (it would break the permission flag)", () => {
    const base = mkdtempSync(join(tmpdir(), "mcb-plugin-"));
    const dir = join(base, "a,b");
    mkdirSync(dir);
    writeFileSync(join(dir, "mc-source.json"), JSON.stringify(testManifest()));
    writeFileSync(join(dir, "index.mjs"), ENTRY);
    expect(load([{ path: dir, sha256: "a".repeat(64), granted: true }]).problems[0].reason).toMatch(/comma/);
  });

  it("refuses an id already used by another source and a second plugin with the same id", () => {
    const a = makePlugin();
    const b = makePlugin();
    const r = load([{ path: a.dir, sha256: pinFor(a.dir), granted: true }, { path: b.dir, sha256: pinFor(b.dir), granted: true }]);
    expect(r.providers).toHaveLength(1);
    expect(r.problems[0].reason).toMatch(/already used/);
    const taken = load([{ path: a.dir, sha256: pinFor(a.dir), granted: true }], { takenIds: ["fake-plugin"] });
    expect(taken.providers).toEqual([]);
  });

  it("validates the owner's config against the manifest's configSchema before anything starts", () => {
    const { dir } = makePlugin({ configSchema: { region: { type: "string", enum: ["in"], default: "in" } } });
    const pin = pinFor(dir);
    const bad = load([{ path: dir, sha256: pin, granted: true, config: { region: "us" } }]);
    expect(bad.providers).toEqual([]);
    expect(bad.problems[0].reason).toMatch(/config: region/);
    const unknown = load([{ path: dir, sha256: pin, granted: true, config: { other: 1 } }]);
    expect(unknown.problems[0].reason).toMatch(/unknown setting/);
    expect(load([{ path: dir, sha256: pin, granted: true }]).providers).toHaveLength(1);
  });

  it("reports an entry with no path and keeps loading the others", () => {
    const { dir } = makePlugin();
    const r = load([{ granted: true }, { path: dir, sha256: pinFor(dir), granted: true }]);
    expect(r.providers).toHaveLength(1);
    expect(r.problems).toHaveLength(1);
  });

  it("logs each refusal as a warning", () => {
    const warns = [];
    const { dir } = makePlugin();
    load([{ path: dir, sha256: "a".repeat(64), granted: true }], { logger: { warn: (m) => warns.push(m) } });
    expect(warns[0]).toMatch(/not loaded/);
  });
});

describe("the provider a plugin becomes", () => {
  const provider = (manifest = {}) => {
    const { dir } = makePlugin(manifest);
    const r = load([{ path: dir, sha256: pinFor(dir), granted: true }]);
    return { p: r.providers[0], fs: r.fs };
  };

  it("exposes only the declared capabilities, plus test and health", () => {
    const { p } = provider();
    expect(typeof p.quotes).toBe("function");
    expect(p.history).toBeUndefined();
    expect(p.expiries).toBeUndefined();
    expect(p.optionChain).toBeUndefined();
    const all = provider({ id: "all-caps", capabilities: ["quotes", "history", "expiries", "optionChain"] }).p;
    for (const m of ["quotes", "history", "expiries", "optionChain", "test", "health", "stop"]) expect(typeof all[m]).toBe("function");
  });

  it("labels every answer: plugin flag, class and official come from the descriptor, never from the plugin", async () => {
    const { p } = provider();
    const r = await p.quotes(["NSE:RELIANCE"], { now: NOW });
    expect(r.flags).toEqual(["plugin", "unofficial", "delayed"]);
    expect(r.items[0].flags).toEqual(["plugin", "unofficial", "delayed"]);
    expect(p.descriptor).toMatchObject({ class: "delayed", official: false });
    expect(r.items[0].class).toBeUndefined();
  });

  it("never serves order, risk, paper or alert reads, even if the router asked", async () => {
    const { p, fs } = provider({ class: "eod", delaySec: undefined });
    for (const purpose of PURPOSES_REFUSED_FOR_PLUGINS) {
      await expect(p.quotes(["NSE:X"], { now: NOW, purpose })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    }
    expect(fs.calls).toHaveLength(0);
    expect((await p.quotes(["NSE:X"], { now: NOW, purpose: "display" })).items).toHaveLength(1);
  });

  it("a call cannot carry an account: only symbols, intervals and underlyings reach the plugin", async () => {
    const { p, fs } = provider({ id: "all-caps", capabilities: ["quotes", "history"] });
    await p.quotes(["NSE:X"], { now: NOW, accountId: "dhan-main", account: { id: "x" } });
    const sent = fs.last().of("call")[0];
    expect(sent.params).toEqual({ symbols: ["NSE:X"] });
    expect(JSON.stringify(fs.last().received)).not.toMatch(/dhan-main|accountId/);
  });

  it("validates arguments before they leave the Bridge", async () => {
    const { p } = provider({ id: "all-caps", capabilities: ["quotes", "history", "optionChain"] });
    await expect(p.quotes([], {})).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(p.quotes([42], {})).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(p.quotes(Array(201).fill("A"), {})).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(p.history({ symbol: "A", interval: "1d", fromMs: "x", toMs: 1 }, {})).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(p.optionChain("NIFTY", "tomorrow", {})).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("test() never throws: a failing plugin is a failed test", async () => {
    const { p } = provider({ id: "all-caps" });
    const r = await p.test({});
    expect(r.ok).toBe(false);
    expect(r.detail).toBeTypeOf("string");
  });

  it("health() reports ok, then disabled with the reason once the plugin is disabled", async () => {
    const { dir } = makePlugin();
    const fs = fakeSpawn({ capabilities: [] }); // does not implement quotes
    const r = loadPlugins({ entries: [{ path: dir, sha256: pinFor(dir), granted: true }], spawnImpl: fs.spawnImpl, clock: () => NOW, stopGraceMs: 10 });
    stops.push(r.stop);
    expect(r.providers[0].health()).toMatchObject({ state: "ok", lastError: null });
    await expect(r.providers[0].quotes(["A"], {})).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE" });
    const h = r.providers[0].health();
    expect(h.state).toBe("disabled");
    expect(h.lastError).toMatch(/does not implement/);
  });

  it("passes a secret reader the plugin's own id only", async () => {
    const { dir } = makePlugin({ secrets: ["apiKey"] });
    const asked = [];
    const fs = fakeSpawn({ onMessage: (m, c) => m.type === "call" && c.say({ type: "result", id: m.id, data: goodQuotes(NOW - 900_000) }) });
    const r = loadPlugins({ entries: [{ path: dir, sha256: pinFor(dir), granted: true }], spawnImpl: fs.spawnImpl, clock: () => NOW, stopGraceMs: 10, readSecret: (id) => (asked.push(id), "k-123456") });
    stops.push(r.stop);
    expect(r.providers[0].descriptor.needsKey).toBe(true);
    await r.providers[0].quotes(["A"], {});
    expect(asked).toEqual(["fake-plugin"]);
  });
});
