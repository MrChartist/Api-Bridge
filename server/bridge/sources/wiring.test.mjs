/**
 * How the sources module starts: the built-in providers register in a normal (non-demo) start, granted plugins register
 * from the config and are stopped with the Bridge, and the plugin entry in the config keeps its own `config` object.
 * Nothing here calls the network: providers and plugins only make calls when a read asks them.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createLogger } from "../core/logger.mjs";
import { sourcesConfigSchema } from "./config.mjs";
import { inspectPluginFolder } from "./plugin/loader.mjs";
import { registerPlugins } from "./plugin/index.mjs";
import { registerProviders } from "./providers/index.mjs";
import { createSourceRegistry } from "./registry.mjs";

const EXAMPLE = resolve(fileURLToPath(new URL("../../../examples/source-plugin", import.meta.url)));
const apps = [];
afterEach(async () => {
  while (apps.length) await apps.pop().close();
});

describe("the sources config section", () => {
  it("keeps the per-entry config object of a plugin, and everything else the entry says", () => {
    const entry = { path: "plugins/x", sha256: "a".repeat(64), granted: true, config: { market: "BSE", nested: { a: 1 } }, note: "kept" };
    const parsed = sourcesConfigSchema.parse({ plugins: [entry] });
    expect(parsed.plugins[0]).toEqual(entry);
    expect(sourcesConfigSchema.parse({ plugins: [{ path: "p", sha256: "b".repeat(64) }] }).plugins[0]).toEqual({ path: "p", sha256: "b".repeat(64), granted: false });
    expect(() => sourcesConfigSchema.parse({ plugins: [{ path: "p", sha256: "b".repeat(64), config: "text" }] })).toThrow();
  });
});

describe("built-in providers", () => {
  it("register from a scoped deps view that throws on names the contract did not declare", () => {
    const strict = new Proxy({ secrets: { get: async () => null } }, {
      get(target, prop) {
        if (prop in target) return target[prop];
        throw new Error(`deps.${String(prop)} was not declared`);
      },
    });
    const registry = createSourceRegistry();
    registerProviders(registry, strict);
    expect(registry.list().map((p) => p.descriptor.id)).toEqual(["yahoo", "alphavantage", "twelvedata"]);
  });

  it("are registered by a normal start, with no warning, and off until switched on", async () => {
    const lines = [];
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-sources-wiring-"));
    const { config } = loadConfig({ raw: { server: { port: 0 }, dataDir }, env: {}, demo: false });
    const app = await createApp({ config, logger: createLogger({ level: "debug", write: (l) => lines.push(l) }) });
    apps.push(app);
    const rows = app.deps.backupData.list();
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining(["yahoo", "alphavantage", "twelvedata"]));
    expect(rows.filter((r) => r.enabled).map((r) => r.id)).toEqual([]);
    expect(lines.join("\n")).not.toMatch(/failed to register|without declaring/);
  });
});

describe("plugins from the config", () => {
  const pinOfExample = () => inspectPluginFolder(EXAMPLE).pin;

  it("registers a granted, pinned plugin with its own config, and reports one that is not granted", async () => {
    const registry = createSourceRegistry();
    const warnings = [];
    const logger = { warn: (m) => warnings.push(m), info() {}, debug() {} };
    const { loaded, problems } = await registerPlugins(registry, {
      config: { sources: { plugins: [{ path: EXAMPLE, sha256: pinOfExample(), granted: true, config: { market: "BSE" } }] } },
      logger,
      paths: { configFile: null },
    });
    expect(loaded).toEqual(["example-delayed"]);
    expect(problems).toEqual([]);
    const provider = registry.get("example-delayed");
    expect(provider.descriptor).toMatchObject({ tier: "plugin", official: false, class: "delayed" });
    // The process starts on the first call, so a freshly loaded plugin reports ok and can be stopped without ever running.
    expect(provider.health().state).toBe("ok");
    await provider.stop();

    const second = createSourceRegistry();
    const refused = await registerPlugins(second, { config: { sources: { plugins: [{ path: EXAMPLE, sha256: pinOfExample(), granted: false }] } }, logger, paths: { configFile: null } });
    expect(refused.loaded).toEqual([]);
    expect(refused.problems[0].reason).toMatch(/not granted/);
    expect(second.list()).toEqual([]);
  });

  it("refuses a plugin whose files changed since they were pinned", async () => {
    const registry = createSourceRegistry();
    const r = await registerPlugins(registry, { config: { sources: { plugins: [{ path: EXAMPLE, sha256: "0".repeat(64), granted: true }] } }, logger: { warn() {} }, paths: { configFile: null } });
    expect(r.loaded).toEqual([]);
    expect(r.problems[0].reason).toMatch(/changed since they were pinned/);
  });

  it("a Bridge started with a granted plugin lists it (off until switched on) and stops it on close", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-sources-wiring-"));
    const raw = { server: { port: 0 }, dataDir, logging: { level: "silent" }, sources: { plugins: [{ path: EXAMPLE, sha256: pinOfExample(), granted: true, config: { market: "NSE" } }] } };
    const { config } = loadConfig({ raw, env: {}, demo: false });
    const app = await createApp({ config, logger: createLogger({ level: "silent", write() {} }) });
    const row = app.deps.backupData.list().find((r) => r.id === "example-delayed");
    expect(row).toMatchObject({ tier: "plugin", enabled: false, official: false, class: "delayed", health: { state: "disabled" } });
    let stopped = 0;
    const provider = app.deps.backupData.registry.get("example-delayed");
    const realStop = provider.stop;
    provider.stop = async () => {
      stopped += 1;
      return realStop();
    };
    await app.close();
    expect(stopped).toBe(1);
  });
});
