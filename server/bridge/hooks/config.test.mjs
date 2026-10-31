import { describe, expect, it } from "vitest";
import { HOOKS_CONFIG_SCHEMA, expandIpList, hooksConfig, ipAllowed, isIpv4Cidr, normaliseIp } from "./config.mjs";

describe("hooks config", () => {
  it("has conservative defaults", () => {
    const c = hooksConfig({});
    expect(c).toMatchObject({ queueSize: 200, concurrency: 2, dedupeWindowMs: 120_000, signatureToleranceS: 300, allowSourceIps: [], clientIpHeader: null });
  });
  it("never allows a signature window above 5 minutes", () => {
    expect(HOOKS_CONFIG_SCHEMA.safeParse({ signatureToleranceS: 301 }).success).toBe(false);
  });
  it("rejects unknown keys and bad addresses", () => {
    expect(HOOKS_CONFIG_SCHEMA.safeParse({ queue: 1 }).success).toBe(false);
    expect(HOOKS_CONFIG_SCHEMA.safeParse({ allowSourceIps: ["not-an-ip"] }).success).toBe(false);
    expect(HOOKS_CONFIG_SCHEMA.safeParse({ allowSourceIps: ["52.89.214.238", "10.0.0.0/8", "::1"] }).success).toBe(true);
  });
});

describe("IP allowlists", () => {
  it("normalises entries", () => {
    expect(expandIpList(["FE80::1", "10.1.0.0/16"])).toEqual(["fe80::1", "10.1.0.0/16"]);
    expect(expandIpList(undefined)).toEqual([]);
  });
  it("matches exact addresses, IPv4-mapped IPv6 and CIDR blocks", () => {
    const list = expandIpList(["52.89.214.238", "10.1.0.0/16"]);
    expect(ipAllowed("52.89.214.238", list)).toBe(true);
    expect(ipAllowed("::ffff:52.89.214.238", list)).toBe(true);
    expect(ipAllowed("10.1.200.3", list)).toBe(true);
    expect(ipAllowed("10.2.0.1", list)).toBe(false);
    expect(ipAllowed("8.8.8.8", list)).toBe(false);
    expect(ipAllowed("", list)).toBe(false);
    expect(ipAllowed("1.2.3.4", ["0.0.0.0/0"])).toBe(true);
  });
  it("validates CIDR and normalises addresses", () => {
    expect(isIpv4Cidr("1.2.3.0/24")).toBe(true);
    expect(isIpv4Cidr("1.2.3.0/33")).toBe(false);
    expect(normaliseIp("FE80::1%eth0")).toBe("fe80::1");
  });
});
