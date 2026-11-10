import { describe, expect, it } from "vitest";
import { addressAllowed, checkTargetUrl, displayTarget, isMetadataAddress, isPrivateAddress, resolveAllowed } from "./urlPolicy.mjs";
import { createFakeDns } from "./testkit.mjs";

const code = (u, p) => {
  const r = checkTargetUrl(u, p);
  return r.ok ? "ok" : r.code;
};

describe("checkTargetUrl (as written, no lookup)", () => {
  it("accepts an https URL on a public name or address", () => {
    expect(code("https://hooks.example.com/in/abc?x=1")).toBe("ok");
    expect(code("https://hooks.example.com:8443/in")).toBe("ok");
    expect(code("https://93.184.216.34/in")).toBe("ok");
    expect(code("https://[2606:2800:220:1:248:1893:25c8:1946]/in")).toBe("ok");
  });

  it("refuses http, other schemes, credentials and junk by default", () => {
    expect(code("http://hooks.example.com/in")).toBe("blocked_scheme");
    for (const u of ["ftp://hooks.example.com/", "file:///etc/passwd", "gopher://x.example.com/", "javascript:alert(1)", "wss://hooks.example.com/"]) expect(code(u), u).toBe("blocked_scheme");
    expect(code("https://user:pass@hooks.example.com/")).toBe("blocked_credentials");
    expect(code("https://user@hooks.example.com/")).toBe("blocked_credentials");
    for (const u of ["", "   ", "not a url", "https://", `https://hooks.example.com/${"a".repeat(2100)}`, "https://hooks.example.com/ x", "https://hooks.example.com/\nHost: evil"]) expect(code(u), JSON.stringify(u).slice(0, 40)).toBe("bad_url");
    expect(code(42)).toBe("bad_url");
    expect(code("https://hooks.example.com./in")).toBe("bad_url");
  });

  it("refuses localhost, local-network and metadata names", () => {
    for (const h of ["localhost", "LOCALHOST", "app.localhost", "printer.local", "db.internal", "nas.lan", "router.home", "x.corp", "intranet", "metadata.google.internal", "metadata", "instance-data"]) expect(code(`https://${h}/x`), h).toMatch(/^blocked_host$/);
  });

  it("refuses private, loopback, link-local and metadata addresses written in the URL, in every notation", () => {
    for (const a of [
      "127.0.0.1", "127.1", "0x7f.0.0.1", "2130706433", "017700000001", "0.0.0.0", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "169.254.1.1", "100.64.0.1", "100.100.100.200",
      "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.1", "[::1]", "[::]", "[fe80::1]", "[fc00::1]", "[fd00:ec2::254]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::ffff:a9fe:a9fe]", "[64:ff9b::7f00:1]", "[2002:7f00:1::]", "[ff02::1]",
    ]) {
      expect(["blocked_address", "blocked_host", "bad_url"], a).toContain(code(`https://${a}/x`));
    }
  });

  it("allows private targets and http only when the config says so, but never a metadata address", () => {
    const p = { allowPrivateTargets: true };
    expect(code("http://127.0.0.1:9000/in", p)).toBe("ok");
    expect(code("http://localhost:9000/in", p)).toBe("ok");
    expect(code("https://192.168.1.20/in", p)).toBe("ok");
    expect(code("http://nas.lan/in", p)).toBe("ok");
    expect(code("http://[::1]:9000/in", p)).toBe("ok");
    expect(code("https://user:pw@127.0.0.1/", p)).toBe("blocked_credentials");
    expect(code("ftp://127.0.0.1/", p)).toBe("blocked_scheme");
    for (const a of ["169.254.169.254", "100.100.100.200", "168.63.129.16", "169.254.170.2", "[fd00:ec2::254]", "[::ffff:169.254.169.254]"]) expect(code(`http://${a}/latest/meta-data`, p), a).toBe("blocked_address");
    for (const h of ["metadata.google.internal", "metadata", "instance-data"]) expect(code(`http://${h}/`, p)).toBe("blocked_host");
  });

  it("holds the target to the allowed host list when there is one", () => {
    const p = { allowedHosts: ["hooks.example.com", "*.partner.example.org"] };
    expect(code("https://hooks.example.com/x", p)).toBe("ok");
    expect(code("https://a.partner.example.org/x", p)).toBe("ok");
    expect(code("https://partner.example.org/x", p)).toBe("host_not_listed");
    expect(code("https://evilhooks.example.com/x", p)).toBe("host_not_listed");
    expect(code("https://hooks.example.com.evil.test/x", p)).toBe("host_not_listed");
  });

  it("shows only the host in lists, because a path or query can be a secret", () => {
    const url = (s) => new URL(s);
    expect(displayTarget(url("https://hooks.example.com/in/abcSECRET?token=1"))).toBe("https://hooks.example.com/…");
    expect(displayTarget(url("https://hooks.example.com:8443/"))).toBe("https://hooks.example.com:8443");
    expect(displayTarget(url("https://hooks.example.com/"))).not.toContain("…");
  });
});

describe("isPrivateAddress", () => {
  it("refuses everything that is not the public internet, in IPv4 and IPv6, however it is wrapped", () => {
    for (const a of [
      "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.0.9", "169.254.0.1", "172.16.0.1", "172.31.0.1", "192.0.0.5", "192.0.2.9", "192.168.0.1", "198.18.0.1", "198.19.255.1",
      "198.51.100.5", "203.0.113.5", "224.0.0.1", "239.1.1.1", "240.0.0.1", "255.255.255.255",
      "::", "::1", "fe80::1", "febf::1", "fec0::1", "feff::1", "3fff::1", "3fff:fff::1", "::ffff:0:7f00:1", "::ffff:0:8.8.8.8", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1", "2001::1", "100::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:c0a8:1", "64:ff9b::a00:1", "2002:a00:1::", "::10.0.0.1", "[::1]", "fe80::1%eth0",
      "not an ip", "", "1.2.3", "1.2.3.4.5", "999.1.1.1", "12345::",
    ]) expect(isPrivateAddress(a), a).toBe(true);
  });
  it("lets public addresses through", () => {
    for (const a of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "169.253.1.1", "192.169.0.1", "198.17.0.1", "223.255.255.255", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "::ffff:8.8.8.8", "64:ff9b::808:808", "[2606:4700::1]"]) expect(isPrivateAddress(a), a).toBe(false);
  });
});

describe("addresses", () => {
  it("knows the cloud metadata addresses, however they are written", () => {
    for (const a of ["169.254.169.254", "100.100.100.200", "168.63.129.16", "fd00:ec2::254", "FD00:EC2::254", "::ffff:169.254.169.254", "[fd00:ec2::254]"]) expect(isMetadataAddress(a), a).toBe(true);
    for (const a of ["8.8.8.8", "169.254.1.1", "10.0.0.1"]) expect(isMetadataAddress(a), a).toBe(false);
  });
  it("allows public addresses, and private ones only when told to (metadata never)", () => {
    expect(addressAllowed("8.8.8.8", false)).toBe(true);
    expect(addressAllowed("2606:4700:4700::1111", false)).toBe(true);
    expect(addressAllowed("10.1.2.3", false)).toBe(false);
    expect(addressAllowed("10.1.2.3", true)).toBe(true);
    expect(addressAllowed("::1", true)).toBe(true);
    expect(addressAllowed("169.254.169.254", true)).toBe(false);
    expect(addressAllowed("not an address", true)).toBe(false);
    expect(addressAllowed("not an address", false)).toBe(false);
  });
});

describe("resolveAllowed (the lookup done before every delivery)", () => {
  const target = (host) => ({ host, ipLiteral: null });
  it("returns the first address when every one is allowed", async () => {
    const dns = createFakeDns({ "a.example.com": ["93.184.216.34", "151.101.1.69"] });
    expect(await resolveAllowed(target("a.example.com"), { resolve: dns.resolve })).toEqual({ ok: true, address: "93.184.216.34", family: 4 });
  });
  it("refuses when ANY address is private (a mixed answer is how rebinding starts)", async () => {
    const dns = createFakeDns({ "a.example.com": ["93.184.216.34", "10.0.0.7"], "b.example.com": ["127.0.0.1"], "c.example.com": ["::1"], "d.example.com": ["169.254.169.254"], "e.example.com": ["::ffff:192.168.0.1"] });
    for (const h of ["a", "b", "c", "d", "e"]) expect((await resolveAllowed(target(`${h}.example.com`), { resolve: dns.resolve })).code, h).toBe("blocked_address");
  });
  it("allows private answers with allowPrivateTargets, but not metadata", async () => {
    const dns = createFakeDns({ "nas.example.com": ["192.168.1.5"], "meta.example.com": ["169.254.169.254"] });
    expect((await resolveAllowed(target("nas.example.com"), { resolve: dns.resolve, allowPrivateTargets: true })).ok).toBe(true);
    expect((await resolveAllowed(target("meta.example.com"), { resolve: dns.resolve, allowPrivateTargets: true })).code).toBe("blocked_address");
  });
  it("reports a failed or empty lookup, and uses a literal address without asking DNS", async () => {
    const dns = createFakeDns({ "empty.example.com": [] });
    expect((await resolveAllowed(target("nope.example.com"), { resolve: dns.resolve })).code).toBe("dns_failed");
    expect((await resolveAllowed(target("empty.example.com"), { resolve: dns.resolve })).code).toBe("dns_failed");
    expect(await resolveAllowed({ host: "93.184.216.34", ipLiteral: "93.184.216.34" }, { resolve: dns.resolve })).toEqual({ ok: true, address: "93.184.216.34", family: 4 });
    expect(dns.lookups).toEqual(["nope.example.com", "empty.example.com"]);
  });
});
