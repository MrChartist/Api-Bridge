import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPluginFolder } from "./check.mjs";
import { testManifest } from "./__fixtures__/fakeChild.mjs";

// The conformance harness is written by the providers stream; until it is merged these tests are skipped.
const HARNESS = existsSync(resolve(import.meta.dirname, "../conformance.mjs"));
const EXAMPLE = resolve(import.meta.dirname, "../../../../examples/source-plugin");

const GOOD = `
const BASE = "https://api.vendor-example.com";
export default {
  async quotes(symbols, ctx) {
    const res = await ctx.fetch(BASE + "/q?s=" + encodeURIComponent(symbols.join(",")));
    if (res.status === 429) ctx.fail("RATE_LIMITED", "slow down", 30000);
    if (res.status === 404) ctx.fail("NOT_FOUND", "unknown");
    if (res.status === 401) ctx.fail("AUTH", "bad key");
    if (res.status >= 500) ctx.fail("UNAVAILABLE", "vendor down");
    const body = await res.json();
    return { items: body.q.map((q) => ({ symbol: q.s, at: Date.parse(q.t), fields: { ltp: q.p } })) };
  },
};
`;

function folder({ entry = GOOD, fixtures, manifest = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mcb-check-"));
  writeFileSync(join(dir, "mc-source.json"), JSON.stringify(testManifest({ limits: { perSecond: 2, perMinute: 20, callTimeoutMs: 3000 }, ...manifest })));
  writeFileSync(join(dir, "index.mjs"), entry);
  mkdirSync(join(dir, "fixtures"));
  writeFileSync(join(dir, "fixtures", "q.json"), JSON.stringify({ q: [{ s: "NSE:X", p: 10.5, t: "2026-11-02T10:00:00Z" }] }));
  const fx = fixtures === undefined ? { inputs: { quotes: ["NSE:X"] }, responses: [{ urlContains: "/q?", file: "q.json" }] } : fixtures;
  if (fx !== false) writeFileSync(join(dir, "fixtures", "conformance.json"), JSON.stringify(fx));
  return dir;
}

const failed = (r) => r.steps.filter((s) => !s.ok).map((s) => s.name);

describe.skipIf(!HARNESS)("checkPluginFolder (offline conformance)", () => {
  it("passes a correct plugin and reports its pin", async () => {
    const r = await checkPluginFolder(folder());
    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.pin).toMatch(/^[0-9a-f]{64}$/);
    expect(r.steps.map((s) => s.name)).toEqual(expect.arrayContaining(["manifest", "load", "conformance: shape:quotes", "conformance: limits", "conformance: errors:rate-limited", "conformance: abort"]));
  }, 60_000);

  it("fails a plugin that does not report a 429 as RATE_LIMITED", async () => {
    const r = await checkPluginFolder(folder({ entry: GOOD.replace('if (res.status === 429) ctx.fail("RATE_LIMITED", "slow down", 30000);', "") }));
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain("conformance: errors:rate-limited");
  }, 60_000);

  it("fails a plugin that asks for a host its manifest does not allow", async () => {
    const r = await checkPluginFolder(folder({ entry: GOOD.replace("https://api.vendor-example.com", "https://elsewhere.example.org") }));
    expect(r.ok).toBe(false);
    expect(failed(r).some((n) => n.startsWith("conformance: shape"))).toBe(true);
  }, 60_000);

  it("fails a plugin whose answers do not fit the contract", async () => {
    const r = await checkPluginFolder(folder({ entry: GOOD.replace("fields: { ltp: q.p }", "fields: { ltp: -q.p }") }));
    expect(r.ok).toBe(false);
  }, 60_000);

  it("fails a plugin whose answers change between identical calls", async () => {
    const r = await checkPluginFolder(folder({ entry: GOOD.replace("fields: { ltp: q.p }", "fields: { ltp: q.p + Math.random() }") }));
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain("deterministic");
  }, 60_000);

  it("fails when a request matches no fixture", async () => {
    const r = await checkPluginFolder(folder({ fixtures: { inputs: { quotes: ["NSE:X"] }, responses: [{ urlContains: "/nothing-matches", json: {} }] } }));
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain("requests matched fixtures");
  }, 60_000);

  it("fails without fixtures, with a hint", async () => {
    const r = await checkPluginFolder(folder({ fixtures: false }));
    expect(r.ok).toBe(false);
    expect(r.steps.find((s) => s.name === "fixtures").detail).toMatch(/conformance\.json/);
  });

  it("fails on an invalid manifest without starting anything", async () => {
    const r = await checkPluginFolder(folder({ manifest: { capabilities: ["orders"] } }));
    expect(r.ok).toBe(false);
    expect(r.steps.every((s) => s.name === "manifest")).toBe(true);
  });

  it("the example plugin passes", async () => {
    const r = await checkPluginFolder(EXAMPLE);
    expect(failed(r)).toEqual([]);
  }, 60_000);
});

describe("checkPluginFolder without the harness", () => {
  it.skipIf(HARNESS)("says so instead of passing", async () => {
    const r = await checkPluginFolder(folder());
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1).name).toBe("conformance harness");
  });
});
