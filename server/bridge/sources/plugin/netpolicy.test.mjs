import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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

describe("wildcards over public suffixes and shared hosting are refused", () => {
  it.each(["*.co.uk", "*.org.uk", "*.co.in", "*.com.au", "*.co.jp", "*.ac.in", "*.gov.in", "*.com.br", "*.co.za"])("refuses %s (a public suffix)", (p) => expect(checkHostPattern(p)).toMatch(/public suffix/));

  it.each(["*.co.xx", "*.com.zz", "*.org.qq", "*.gov.yy"])("refuses %s (a country code with a generic second label, even if not in the list)", (p) => expect(checkHostPattern(p)).toMatch(/public suffix/));

  it.each(["*.herokuapp.com", "*.vercel.app", "*.netlify.app", "*.github.io", "*.pages.dev", "*.workers.dev", "*.web.app", "*.firebaseapp.com", "*.appspot.com", "*.azurewebsites.net", "*.cloudfront.net", "*.amazonaws.com", "*.s3.amazonaws.com", "*.onrender.com", "*.ngrok.io", "*.blogspot.com", "*.duckdns.org"])("refuses %s (shared hosting)", (p) => expect(checkHostPattern(p)).toMatch(/shared hosting/));

  it("accepts a wildcard over a domain one party can own, including a name one label below a hosting domain, and exact hosts on hosting domains", () => {
    for (const ok of ["*.vendor.co.uk", "*.vendor.co.in", "*.vendor.com.au", "*.myvendor.vercel.app", "*.myvendor.herokuapp.com", "*.mybucket.s3.amazonaws.com", "api.myvendor.herokuapp.com", "api.vendor.co.uk", "*.vendor.io", "*.api.vendor.com"]) {
      expect(checkHostPattern(ok), ok).toBeNull();
    }
  });

  it("the refusal says what to do instead", () => {
    expect(checkHostPattern("*.co.uk")).toMatch(/Name the vendor's own domain/);
    expect(checkHostPattern("*.herokuapp.com")).toMatch(/exact hosts/);
  });

  it("an exact host may be on a hosting domain but a wildcard match never reaches across the boundary", () => {
    expect(hostMatches(["*.myvendor.vercel.app"], "a.myvendor.vercel.app")).toBe(true);
    expect(hostMatches(["*.myvendor.vercel.app"], "other.vercel.app")).toBe(false);
  });

  it("the manifest refuses such a wildcard before any plugin code runs", async () => {
    const { parseManifest } = await import("./manifest.mjs");
    const { testManifest } = await import("./__fixtures__/fakeChild.mjs");
    const r = parseManifest(testManifest({ network: { allowHosts: ["*.herokuapp.com", "*.co.uk"] } }));
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/shared hosting/);
    expect(r.errors.join("\n")).toMatch(/public suffix/);
  });
});

describe("broker hosts the in-tree adapters use are denied", () => {
  it.each(["api.firstock.in", "firstock.in", "zebumyntapi.web.app", "bigul.s3.ap-south-1.amazonaws.com", "flattrade.s3.ap-south-1.amazonaws.com"])("%s is a broker host", (h) => {
    expect(isBrokerHost(h)).toBe(true);
    expect(checkHostPattern(h)).toMatch(/broker/);
    expect(checkOutboundUrl(`https://${h}/x`, { allowHosts: [h] })).toMatchObject({ ok: false, code: "HOST_NOT_ALLOWED" });
  });

  it("an unrelated bucket on the same shared domain is not swept in", () => {
    expect(isBrokerHost("someone-else.s3.ap-south-1.amazonaws.com")).toBe(false);
    expect(isBrokerHost("web.app")).toBe(false);
    expect(isBrokerHost("other.web.app")).toBe(false);
  });

  // The adapters declare no host list of their own (a base URL is a string in each file), so this scans them: every host an
  // adapter names in a URL must be denied here, or be one of the documentation links below. A new adapter with a new host
  // fails this test until its domain is added to BROKER_HOST_SUFFIXES in netpolicy.mjs.
  it("every host named in the adapter sources is denied (or is a documentation link)", () => {
    const BROKERS = resolve(import.meta.dirname, "../../../brokers");
    const DOC_ONLY = new Set(["documenter.getpostman.com", "github.com", "pypi.org", "pyintegrate.readthedocs.io"]);
    const found = new Map();
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "__fixtures__") continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(mjs|js|json)$/.test(name) && !/\.(test|spec)\./.test(name)) {
          for (const m of readFileSync(p, "utf8").matchAll(/(?:https?|wss?):\/\/([a-z0-9][a-z0-9.-]*[a-z0-9])/gi)) {
            const h = m[1].toLowerCase().replace(/\.$/, "");
            if (!found.has(h)) found.set(h, name);
          }
        }
      }
    };
    walk(BROKERS);
    expect(found.size).toBeGreaterThan(50); // the scan sees the adapters
    const missing = [...found].filter(([h]) => !DOC_ONLY.has(h) && !isBrokerHost(h)).map(([h, f]) => `${h} (in ${f})`);
    expect(missing).toEqual([]);
  });
});
