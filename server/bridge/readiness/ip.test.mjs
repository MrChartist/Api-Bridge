import { describe, expect, it } from "vitest";
import { normaliseIp, parseLookupBody, sameIp } from "./ip.mjs";

describe("normaliseIp (p1-05 §7.3 reference cases)", () => {
  it("maps IPv4-mapped IPv6 to IPv4, expands IPv6, refuses leading zeros", () => {
    expect(normaliseIp("::ffff:203.0.113.10")).toEqual({ ip: "203.0.113.10", family: "ipv4" });
    expect(normaliseIp("2001:DB8::1")).toEqual({ ip: "2001:db8:0:0:0:0:0:1", family: "ipv6" });
    expect(normaliseIp("203.0.113.010")).toBeNull();
  });

  it("trims, accepts brackets, refuses zone ids, junk and out-of-range octets", () => {
    expect(normaliseIp("  198.51.100.23\n")).toEqual({ ip: "198.51.100.23", family: "ipv4" });
    expect(normaliseIp("[2001:db8::5]")).toEqual({ ip: "2001:db8:0:0:0:0:0:5", family: "ipv6" });
    expect(normaliseIp("fe80::1%eth0")).toBeNull();
    expect(normaliseIp("256.1.1.1")).toBeNull();
    expect(normaliseIp("1.2.3")).toBeNull();
    expect(normaliseIp("example.com")).toBeNull();
    expect(normaliseIp("")).toBeNull();
    expect(normaliseIp(null)).toBeNull();
    expect(normaliseIp("2001:db8::1::2")).toBeNull();
  });

  it("families", () => {
    expect(normaliseIp("0.0.0.0").family).toBe("ipv4");
    expect(normaliseIp("::1").family).toBe("ipv6");
    expect(normaliseIp("64:ff9b::1.2.3.4")).toEqual({ ip: "64:ff9b:0:0:0:0:102:304", family: "ipv6" });
  });
});

describe("sameIp", () => {
  it("compares normalised forms", () => {
    expect(sameIp("2001:DB8::1", "2001:db8:0:0:0:0:0:1")).toBe(true);
    expect(sameIp("::ffff:203.0.113.10", "203.0.113.10")).toBe(true);
    expect(sameIp("203.0.113.10", "203.0.113.11")).toBe(false);
    expect(sameIp("203.0.113.010", "203.0.113.10")).toBe(false);
    expect(sameIp(undefined, "203.0.113.10")).toBe(false);
  });
});

describe("parseLookupBody", () => {
  it("text/plain: the first line", () => {
    expect(parseLookupBody("198.51.100.23\n", "text/plain")).toEqual({ ip: "198.51.100.23", family: "ipv4" });
    expect(parseLookupBody("2001:db8::5\nsomething else", "text/plain; charset=utf-8")).toEqual({ ip: "2001:db8:0:0:0:0:0:5", family: "ipv6" });
  });

  it("JSON: ip, query or origin (first entry of a comma list)", () => {
    expect(parseLookupBody('{"ip":"203.0.113.10"}', "application/json")).toEqual({ ip: "203.0.113.10", family: "ipv4" });
    expect(parseLookupBody('{"status":"success","query":"203.0.113.10"}', "application/json")).toEqual({ ip: "203.0.113.10", family: "ipv4" });
    expect(parseLookupBody('{"origin":"198.51.100.23, 10.0.0.1"}', "application/json")).toEqual({ ip: "198.51.100.23", family: "ipv4" });
    expect(parseLookupBody('{"ip":"203.0.113.10"}', null)).toEqual({ ip: "203.0.113.10", family: "ipv4" });
  });

  it("refuses oversize bodies and garbage", () => {
    expect(parseLookupBody("1".repeat(1025), "text/plain")).toHaveProperty("error");
    expect(parseLookupBody("<html>hello</html>", "text/html")).toHaveProperty("error");
    expect(parseLookupBody("{not json", "application/json")).toHaveProperty("error");
    expect(parseLookupBody('{"address":"1.2.3.4"}', "application/json")).toHaveProperty("error");
    expect(parseLookupBody("", "text/plain")).toHaveProperty("error");
  });
});
