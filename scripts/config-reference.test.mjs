/**
 * docs/guides/config.md lists every bridge.config.json key. It is written from the real zod schemas and the descriptions in
 * scripts/lib/config-descriptions.mjs, so these tests fail when:
 *   - a key in a schema has no description (a new setting cannot ship undocumented),
 *   - a description names a key that is not in any schema (a removed setting cannot linger),
 *   - the committed page is out of date (run: npm run docs:generate),
 *   - the page states a default that the schema does not have,
 *   - the page names an environment variable or a guide that does not exist.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyModuleConfig } from "../server/bridge/core/modules.mjs";
import { BUILTIN_MODULES } from "../server/bridge/core/builtinModules.mjs";
import { coreSchema } from "../server/bridge/core/config.mjs";
import { configPage, buildConfigReference } from "./gen-config-reference.mjs";
import { allConfigKeys, configSections } from "./lib/config-model.mjs";
import { DESCRIPTIONS, SECTIONS } from "./lib/config-descriptions.mjs";
import { ROOT, repoFiles } from "./lib/repo-files.mjs";

const keys = allConfigKeys();
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

describe("every configuration key has a description", () => {
  it("the schema has the keys we expect to document (a floor, so an empty walk cannot pass)", () => {
    expect(keys.length).toBeGreaterThan(300);
    for (const must of ["safety.liveTrading", "server.port", "downloads.maxBudgetShare", "recorder.autoRecord.rules[].everySec", "ratelimit.brokers.<name>.limits.<name>.perSecond", "accounts[].live.enabled", "orders.reconcileGiveUpMs"]) {
      expect(keys.map((k) => k.path), must).toContain(must);
    }
  });

  it("no key is missing a description", () => {
    expect(keys.filter((k) => !DESCRIPTIONS[k.path]).map((k) => k.path)).toEqual([]);
  });

  it("no description names a key that does not exist", () => {
    const known = new Set(keys.map((k) => k.path));
    expect(Object.keys(DESCRIPTIONS).filter((p) => !known.has(p))).toEqual([]);
  });

  it("a description is a real sentence, not a placeholder", () => {
    const weak = Object.entries(DESCRIPTIONS).filter(([, t]) => t.trim().length < 12 || !/[.}\])"]$/.test(t.trim()));
    expect(weak.map(([p]) => p)).toEqual([]);
  });

  it("every section has an introduction, and the guide it points at exists", () => {
    const files = new Set(repoFiles());
    for (const s of configSections()) {
      if (["dataDir", "masterKeyFile", "demo"].includes(s.name)) continue; // listed together under "general"
      expect(SECTIONS[s.name], s.name).toBeTruthy();
    }
    for (const [name, m] of Object.entries(SECTIONS)) {
      expect(m.about.length, name).toBeGreaterThan(20);
      if (m.guide) expect(files.has(`docs/guides/${m.guide}`), `${name} -> ${m.guide}`).toBe(true);
    }
  });

  it("generating the page refuses a key without a description", () => {
    const missing = { ...DESCRIPTIONS };
    delete missing["safety.liveTrading"];
    expect(() => configPage(undefined, missing)).toThrow(/safety\.liveTrading has no description/);
  });
});

describe("the page matches the schema", () => {
  it("the committed page is what the generator writes (run: npm run docs:generate)", () => {
    for (const [file, text] of buildConfigReference()) expect(read(file), file).toBe(text);
  });

  it("every key appears in the page", () => {
    const page = read("docs/guides/config.md");
    for (const k of keys) expect(page, k.path).toContain(`| \`${k.path}\` |`);
  });

  it("a default shown in the page is the default the real loader fills in", () => {
    // Parse an empty file through the real validators, then compare each plain default with what the page prints.
    const core = coreSchema.parse({});
    const parsed = applyModuleConfig(core, BUILTIN_MODULES);
    const at = (path) => path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), parsed);
    let checked = 0;
    for (const k of keys) {
      if (k.path.includes("[]") || k.path.includes("<name>") || k.path.startsWith("hooks.presets") || !k.hasDefault || k.default === undefined) continue;
      expect(at(k.path), k.path).toEqual(k.default);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(200);
  });

  it("the defaults the guides and the safety page quote are the real ones", () => {
    const by = Object.fromEntries(keys.map((k) => [k.path, k.default]));
    expect(by["safety.maxOrderValue"]).toBe(200_000);
    expect(by["safety.dailyMaxLoss"]).toBe(10_000);
    expect(by["safety.dailyMaxOrders"]).toBe(100);
    expect(by["safety.maxLotsPerOrder"]).toBe(10);
    expect(by["safety.priceBandPct"]).toBe(3);
    expect(by["safety.orderRatePerSecond"]).toBe(5);
    expect(by["downloads.maxBudgetShare"]).toBe(0.3);
    expect(by["recorder.maxBudgetShare"]).toBe(0.3);
    expect(by["orders.ticketTtlMs"]).toBe(60_000);
    expect(by["server.port"]).toBe(4300);
  });
});

describe("what the page says around the table is true", () => {
  const page = read("docs/guides/config.md");
  const sources = repoFiles().filter((f) => /^(server|bin)\/.*\.mjs$/.test(f) && !f.endsWith(".test.mjs")).map(read).join("\n");

  it("every environment variable it names is read by the code", () => {
    const named = [...new Set([...page.matchAll(/`(MCB_[A-Z_]+)/g)].map((m) => m[1]))];
    expect(named.length).toBeGreaterThanOrEqual(10);
    expect(named.filter((v) => !sources.includes(v))).toEqual([]);
  });

  it("it lists the removed settings the loader refuses", async () => {
    const { REMOVED_SETTINGS } = await import("../server/bridge/core/config.mjs");
    for (const k of Object.keys(REMOVED_SETTINGS)) expect(page, k).toContain(`- \`${k}\`:`);
  });

  it("the example config file only holds keys this reference documents", () => {
    const example = JSON.parse(read("bridge.config.example.json"));
    const known = new Set(keys.map((k) => k.path.split(/[.[]/)[0]));
    expect(Object.keys(example).filter((k) => !known.has(k) && k !== "$schema" && k !== "_comment")).toEqual([]);
  });
});
