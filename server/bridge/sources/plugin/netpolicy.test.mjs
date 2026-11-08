import { describe, expect, it } from "vitest";
import { checkHostPattern, checkOutboundUrl, hostMatches, isBrokerHost, isPrivateAddress } from "./netpolicy.mjs";

describe("checkHostPattern", () => {
  it.each(["api.vendor.com", "*.vendor.com", "a-b.c1.vendor.co.in"])("accepts %s", (p) => expect(checkHostPattern(p)).toBeNull());

  it.each([
    ["10.0.0.1", /IP/],
    ["192.168.1.5", /IP/],
    ["127.0.0.1", /IP/],
    ["[::1]", /bare host/],
    ["::1", /bare host/],
    ["localhost", /full host name/],
    ["printer.local", /local-network/],
    ["db.internal", /local-network/],
    ["foo.localhost", /local-network/],
    ["*", /wildcard/],
    ["*.com", /full host name/],
    ["*.*.vendor.com", /wildcard/],
    ["api.*.vendor.com", /wildcard/],
    ["a*.vendor.com", /wildcard/],
    ["https://api.vendor.com", /bare host/],
    ["api.vendor.com:8443", /bare host/],
    ["api.vendor.com/path", /bare host/],
    ["user@api.vendor.com", /bare host/],
    ["API.vendor.com", /lowercase/],
    ["api.vendor.com.", /dot/],
    [".vendor.com", /dot/],
    ["", /non-empty/],
    ["api.kite.trade", /broker/],
    ["*.zerodha.com", /broker/],
    ["api.dhan.co", /broker/],
  ])("rejects %s", (p, why) => expect(checkHostPattern(p)).toMatch(why));

  it("rejects non-strings", () => expect(checkHostPattern(42)).toMatch(/string/));
});

describe("hostMatches", () => {
  it("matches exact names and wildcard subdomains, not the apex or look-alikes", () => {
    expect(hostMatches(["api.vendor.com"], "api.vendor.com")).toBe(true);
    expect(hostMatches(["api.vendor.com"], "x.api.vendor.com")).toBe(false);
    expect(hostMatches(["*.vendor.com"], "a.vendor.com")).toBe(true);
    expect(hostMatches(["*.vendor.com"], "a.b.vendor.com")).toBe(true);
    expect(hostMatches(["*.vendor.com"], "vendor.com")).toBe(false);
    expect(hostMatches(["*.vendor.com"], "evilvendor.com")).toBe(false);
    expect(hostMatches(["*.vendor.com"], "vendor.com.evil.com")).toBe(false);
  });
});

describe("isBrokerHost", () => {
  it("matches broker domains and subdomains only", () => {
    expect(isBrokerHost("api.kite.trade")).toBe(true);
    expect(isBrokerHost("kite.trade")).toBe(true);
    expect(isBrokerHost("api.upstox.com")).toBe(true);
    expect(isBrokerHost("notkite.trade")).toBe(false);
    expect(isBrokerHost("api.vendor.com")).toBe(false);
    expect(isBrokerHost("x.custom-broker.example", ["custom-broker.example"])).toBe(true);
  });
});

describe("isPrivateAddress", () => {
  it.each([
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.0.9", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.0.0.1", "192.0.2.5", "192.168.0.10", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "255.255.255.255",
    "::", "::1", "fe80::1", "fe80::abcd%eth0", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
    "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "64:ff9b::7f00:1", "2002:7f00:1::1", "2002:0a00:0001::1", "not-an-ip", "",
  ])("%s is private", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(["8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.169.0.1", "198.17.0.1", "13.107.42.14", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "[2606:4700:4700::1111]"])("%s is public", (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe("checkOutboundUrl", () => {
  const policy = { allowHosts: ["api.vendor.com", "*.cdn.vendor.com"] };
  const refused = (url, code, re) => {
    const r = checkOutboundUrl(url, policy);
    expect(r.ok).toBe(false);
    expect(r.code).toBe(code);
    expect(r.message).toMatch(re);
  };

  it("accepts an https URL on an allowed host", () => {
    const r = checkOutboundUrl("https://api.vendor.com/v1/q?s=NSE:X", policy);
    expect(r.ok).toBe(true);
    expect(r.url.hostname).toBe("api.vendor.com");
    expect(checkOutboundUrl("https://a.cdn.vendor.com/x", policy).ok).toBe(true);
    expect(checkOutboundUrl("https://API.VENDOR.COM/x", policy).ok).toBe(true);
    expect(checkOutboundUrl("https://api.vendor.com:443/x", policy).ok).toBe(true);
  });

  it("refuses everything else", () => {
    refused("http://api.vendor.com/x", "HOST_NOT_ALLOWED", /https/);
    refused("ftp://api.vendor.com/x", "HOST_NOT_ALLOWED", /https/);
    refused("https://evil.com/x", "HOST_NOT_ALLOWED", /allowHosts/);
    refused("https://api.vendor.com.evil.com/x", "HOST_NOT_ALLOWED", /allowHosts/);
    refused("https://vendor.com/x", "HOST_NOT_ALLOWED", /allowHosts/);
    refused("https://user:pw@api.vendor.com/x", "HOST_NOT_ALLOWED", /credentials/);
    refused("https://api.vendor.com:8443/x", "HOST_NOT_ALLOWED", /port/);
    refused("https://127.0.0.1/x", "HOST_NOT_ALLOWED", /IP/);
    refused("https://2130706433/x", "HOST_NOT_ALLOWED", /IP/);
    refused("https://0x7f.1/x", "HOST_NOT_ALLOWED", /IP/);
    refused("https://[::1]/x", "HOST_NOT_ALLOWED", /IP/);
    refused("https://[::ffff:127.0.0.1]/x", "HOST_NOT_ALLOWED", /IP/);
    refused("https://169.254.169.254/latest/meta-data", "HOST_NOT_ALLOWED", /IP/);
    refused("https://localhost/x", "HOST_NOT_ALLOWED", /allowHosts/);
    refused("https://api.vendor.com./x", "HOST_NOT_ALLOWED", /trailing dot/);
    refused("not a url", "BAD_REQUEST", /parse/);
    refused("", "BAD_REQUEST", /missing/);
    refused(`https://api.vendor.com/${"a".repeat(3000)}`, "BAD_REQUEST", /too long/);
    refused(42, "BAD_REQUEST", /missing/);
  });

  it("never reaches a broker, even when the manifest asked for it", () => {
    const r = checkOutboundUrl("https://api.kite.trade/orders", { allowHosts: ["api.kite.trade"] });
    expect(r).toMatchObject({ ok: false, code: "HOST_NOT_ALLOWED" });
    expect(r.message).toMatch(/broker/);
  });
});
