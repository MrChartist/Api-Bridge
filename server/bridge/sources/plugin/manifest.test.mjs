import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkedDescriptor, descriptorFromManifest, effectiveLimits, parseManifest, parseManifestText, validateConfig } from "./manifest.mjs";
import { validateDescriptor } from "../contract.mjs";
import { testManifest } from "./__fixtures__/fakeChild.mjs";

const EXAMPLE = resolve(import.meta.dirname, "../../../../examples/source-plugin/mc-source.json");

const bad = (overrides, re) => {
  const r = parseManifest({ ...testManifest(), ...overrides });
  expect(r.ok).toBe(false);
  expect(r.errors.join("\n")).toMatch(re);
};

describe("parseManifest", () => {
  it("accepts the example plugin's manifest", () => {
    const r = parseManifestText(readFileSync(EXAMPLE, "utf8"));
    expect(r.errors).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.manifest.id).toBe("example-delayed");
  });

  it("reports invalid JSON as one clear error", () => {
    const r = parseManifestText("{ not json");
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/not valid JSON/);
  });

  it("returns every problem at once", () => {
    const r = parseManifest({ id: "X", name: "", version: "1", apiVersion: 2, entry: "../x.mjs", capabilities: ["orders"], class: "fast" });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(7);
  });

  it("refuses unknown keys, so a typo cannot drop a restriction", () => {
    bad({ netwrok: {} }, /netwrok|Unrecognized/i);
    bad({ network: { allowHosts: [], allowAll: true } }, /allowAll|Unrecognized/i);
  });

  it("is read-only market data: no order, account, portfolio or funds capability exists", () => {
    for (const cap of ["orders", "placeOrder", "portfolio", "funds", "login", "accounts"]) bad({ capabilities: [cap] }, /one of quotes, history, expiries, optionChain/);
  });

  it("official is always false", () => {
    bad({ official: true }, /official must be false/);
    expect(parseManifest({ ...testManifest(), official: false }).ok).toBe(true);
    expect(descriptorFromManifest(parseManifest(testManifest()).manifest).official).toBe(false);
  });

  it("apiVersion must be 1, version must be semver, id must be lowercase", () => {
    bad({ apiVersion: 2 }, /apiVersion/);
    bad({ version: "1.0" }, /semantic version/);
    bad({ id: "Fake_Plugin" }, /lowercase/);
  });

  it("will not shadow a built-in source id", () => {
    for (const id of ["demo", "yahoo", "broker", "alphavantage"]) bad({ id }, /reserved/);
  });

  it("a delayed plugin states its delay, and a plugin is never real-time", () => {
    bad({ class: "delayed", delaySec: undefined }, /delaySec/);
    bad({ class: "realtime", delaySec: undefined }, /never a real-time source/);
    bad({ class: "live" }, /class/);
    expect(parseManifest(testManifest({ class: "eod", delaySec: undefined })).ok).toBe(true);
  });

  it("network.allowHosts: https host names only, no IPs, localhost, private names, wildcards beyond one leading *., or brokers", () => {
    for (const h of ["10.0.0.1", "localhost", "*.com", "a.*.example.com", "api.example.com:8080", "http://x.example.com", "service.local", "api.kite.trade"]) bad({ network: { allowHosts: [h] } }, /allowHosts/);
    bad({ network: { allowHosts: ["a.example.com", "a.example.com"] } }, /duplicate/);
    expect(parseManifest(testManifest({ network: { allowHosts: ["*.vendor-example.com", "api.other-example.com"] } })).ok).toBe(true);
  });

  it("limits: at least one rate, and the call timeout can be lowered but never above 15 s", () => {
    bad({ limits: {} }, /at least one of/);
    bad({ limits: { perSecond: 1, callTimeoutMs: 15001 } }, /callTimeoutMs/);
    bad({ limits: { perSecond: 1, maxInFlight: 5 } }, /maxInFlight/);
    bad({ limits: { perSecond: 1, maxResponseBytes: 6 * 1024 * 1024 } }, /maxResponseBytes/);
    expect(parseManifest(testManifest({ limits: { perSecond: 1, callTimeoutMs: 15000 } })).ok).toBe(true);
  });

  it("entry is one relative file inside the folder", () => {
    for (const e of ["../index.mjs", "/etc/passwd", "C:\\x.mjs", "dir//x.mjs", "index.py", "a/../../b.mjs", ""]) bad({ entry: e }, /entry|String/);
    expect(parseManifest(testManifest({ entry: "dist/index.mjs" })).ok).toBe(true);
  });

  it("terms are required and https", () => {
    bad({ terms: { url: "http://x.example.com", note: "x" } }, /https/);
    bad({ terms: undefined }, /terms/);
  });

  it("secrets are not config", () => {
    bad({ configSchema: { apiKey: { type: "string" } } }, /secrets are not config/);
    bad({ configSchema: { token: { type: "string" } } }, /secrets are not config/);
    expect(parseManifest(testManifest({ secrets: ["apiKey"] })).ok).toBe(true);
    bad({ secrets: ["password"] }, /apiKey/);
  });

  it("a config default must satisfy its own rules", () => {
    bad({ configSchema: { region: { type: "string", enum: ["in"], default: "us" } } }, /default/);
  });
});

describe("effectiveLimits", () => {
  it("applies defaults and never exceeds the host caps", () => {
    const m = parseManifest(testManifest({ limits: { perSecond: 2, callTimeoutMs: undefined } })).manifest;
    expect(effectiveLimits(m)).toMatchObject({ callTimeoutMs: 5000, maxInFlight: 1, maxResponseBytes: 2 * 1024 * 1024, perSecond: 2 });
  });
});

describe("descriptor", () => {
  it("is a valid contract descriptor: tier plugin, kind plugin, official false, labelled", () => {
    const m = parseManifest(testManifest({ secrets: ["apiKey"] })).manifest;
    const { ok, errors, descriptor } = checkedDescriptor(m);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
    expect(validateDescriptor(descriptor).ok).toBe(true);
    expect(descriptor).toMatchObject({ kind: "plugin", tier: "plugin", official: false, class: "delayed", delaySec: 900, flags: ["plugin", "unofficial", "delayed"], trust: "untrusted", needsKey: true });
    expect(descriptor.limits).toEqual({ perSecond: 5, perMinute: 100 });
  });

  it("an end-of-day plugin may omit the delay", () => {
    expect(descriptorFromManifest(parseManifest(testManifest({ class: "eod", delaySec: undefined })).manifest)).toMatchObject({ class: "eod", delaySec: null });
  });
});

describe("validateConfig", () => {
  const manifest = parseManifest(
    testManifest({
      configSchema: {
        region: { type: "string", enum: ["in", "us"], default: "in" },
        depth: { type: "integer", minimum: 1, maximum: 10, required: true },
        verbose: { type: "boolean" },
      },
    }),
  ).manifest;

  it("applies defaults and accepts valid values", () => {
    expect(validateConfig(manifest, { depth: 3 })).toEqual({ ok: true, value: { region: "in", depth: 3 } });
    expect(validateConfig(manifest, { depth: 3, region: "us", verbose: true }).value).toEqual({ region: "us", depth: 3, verbose: true });
  });

  it("rejects unknown, missing and invalid settings", () => {
    expect(validateConfig(manifest, { depth: 3, extra: 1 }).errors).toEqual(["extra: unknown setting"]);
    expect(validateConfig(manifest, {}).errors).toEqual(["depth: required"]);
    expect(validateConfig(manifest, { depth: 99 }).ok).toBe(false);
    expect(validateConfig(manifest, { depth: 1.5 }).ok).toBe(false);
    expect(validateConfig(manifest, { depth: 3, region: "xx" }).errors[0]).toMatch(/region/);
    expect(validateConfig(manifest, { depth: 3, verbose: "yes" }).ok).toBe(false);
    expect(validateConfig(manifest, [1]).ok).toBe(false);
  });

  it("does not let __proto__ through as a setting", () => {
    const evil = JSON.parse('{"depth": 3, "__proto__": {"polluted": true}}');
    expect(validateConfig(manifest, evil).ok).toBe(false);
    expect({}.polluted).toBeUndefined();
  });
});
