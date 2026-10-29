import { describe, expect, it } from "vitest";
import { assertNotCrossSiteWrite, assertTransportAllowed, createCors, createHostCheck, isLocalRequest, isLoopbackAddress, parseHostHeader } from "./security.mjs";

describe("Host allowlist (DNS rebinding guard)", () => {
  const check = createHostCheck({ port: 4300, allowedHosts: ["bridge.lan:4300", "my-tunnel.example"] });

  it("accepts loopback names on our port", () => {
    for (const h of ["127.0.0.1:4300", "localhost:4300", "[::1]:4300", "LOCALHOST:4300", "localhost"]) expect(check(h), h).toBe(true);
  });

  it("refuses other names, other ports and junk", () => {
    for (const h of ["evil.example", "evil.example:4300", "127.0.0.1:9999", "127.0.0.1.evil.example:4300", "", undefined, "a b", "x".repeat(300)]) {
      expect(check(h), String(h)).toBe(false);
    }
  });

  it("accepts configured extra hosts", () => {
    expect(check("bridge.lan:4300")).toBe(true);
    expect(check("my-tunnel.example")).toBe(true);
    expect(check("my-tunnel.example:443")).toBe(true);
  });

  it("parses host headers", () => {
    expect(parseHostHeader("[::1]:80")).toEqual({ name: "[::1]", port: 80 });
    expect(parseHostHeader("x:y")).toBeNull();
  });
});

describe("CORS allowlist", () => {
  const cors = createCors({ allowedOrigins: ["http://localhost:5173"] });
  it("allows listed origins and requests without Origin, refuses the rest (no wildcard)", () => {
    expect(cors.isAllowed(undefined)).toBe(true);
    expect(cors.isAllowed("http://localhost:5173")).toBe(true);
    expect(cors.isAllowed("http://localhost:5174")).toBe(false);
    expect(cors.isAllowed("null")).toBe(false);
    expect(cors.headersFor("http://localhost:5173")["Access-Control-Allow-Origin"]).toBe("http://localhost:5173");
  });
});

describe("assertTransportAllowed", () => {
  const guards = { hostCheck: createHostCheck({ port: 4300 }), cors: createCors({ allowedOrigins: [] }) };
  const req = (headers) => ({ headers });
  it("throws HOST_NOT_ALLOWED and ORIGIN_NOT_ALLOWED", () => {
    expect(() => assertTransportAllowed(req({ host: "evil.example" }), guards)).toThrow(expect.objectContaining({ code: "HOST_NOT_ALLOWED" }));
    expect(() => assertTransportAllowed(req({ host: "127.0.0.1:4300", origin: "https://evil.example" }), guards)).toThrow(expect.objectContaining({ code: "ORIGIN_NOT_ALLOWED" }));
    expect(() => assertTransportAllowed(req({ host: "127.0.0.1:4300" }), guards)).not.toThrow();
  });
});

describe("assertNotCrossSiteWrite (Sec-Fetch-Site guard, p1-05 §3.9 F7)", () => {
  const cors = createCors({ allowedOrigins: ["http://localhost:5173"] });
  const req = (method, headers) => ({ method, headers: { host: "127.0.0.1:4300", ...headers } });
  it("refuses a cross-site or same-site browser write that carries no allowed Origin", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(() => assertNotCrossSiteWrite(req(m, { "sec-fetch-site": "cross-site" }), cors)).toThrow(expect.objectContaining({ code: "ORIGIN_NOT_ALLOWED" }));
      expect(() => assertNotCrossSiteWrite(req(m, { "sec-fetch-site": "same-site" }), cors)).toThrow(expect.objectContaining({ code: "ORIGIN_NOT_ALLOWED" }));
      expect(() => assertNotCrossSiteWrite(req(m, { "sec-fetch-site": "cross-site", origin: "https://evil.example" }), cors)).toThrow(expect.objectContaining({ code: "ORIGIN_NOT_ALLOWED" }));
    }
  });
  it("lets reads, non-browser clients, same-origin pages and allowlisted origins through", () => {
    expect(() => assertNotCrossSiteWrite(req("GET", { "sec-fetch-site": "cross-site" }), cors)).not.toThrow();
    expect(() => assertNotCrossSiteWrite(req("OPTIONS", { "sec-fetch-site": "cross-site" }), cors)).not.toThrow();
    expect(() => assertNotCrossSiteWrite(req("POST", {}), cors)).not.toThrow();
    expect(() => assertNotCrossSiteWrite(req("POST", { "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:4300" }), cors)).not.toThrow();
    expect(() => assertNotCrossSiteWrite(req("POST", { "sec-fetch-site": "none" }), cors)).not.toThrow();
    expect(() => assertNotCrossSiteWrite(req("POST", { "sec-fetch-site": "same-site", origin: "http://localhost:5173" }), cors)).not.toThrow();
    expect(() => assertNotCrossSiteWrite(req("POST", { "sec-fetch-site": "same-site", origin: "http://127.0.0.1:4300" }), cors)).not.toThrow();
  });
});

describe("isLoopbackAddress", () => {
  it("recognises IPv4, IPv6 and mapped loopback only", () => {
    for (const a of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(a)).toBe(true);
    for (const a of ["10.0.0.1", "::ffff:10.0.0.1", "", undefined, "1270.0.0.1"]) expect(isLoopbackAddress(a)).toBe(false);
  });
});

describe("isLocalRequest", () => {
  const req = (remoteAddress, headers) => ({ socket: { remoteAddress }, headers });
  it("needs a loopback peer, a loopback Host name and no forwarding headers", () => {
    expect(isLocalRequest(req("127.0.0.1", { host: "127.0.0.1:4300" }))).toBe(true);
    expect(isLocalRequest(req("::1", { host: "localhost:4300" }))).toBe(true);
    expect(isLocalRequest(req("10.0.0.2", { host: "127.0.0.1:4300" }))).toBe(false);
    expect(isLocalRequest(req("127.0.0.1", { host: "abc.trycloudflare.com" }))).toBe(false);
    expect(isLocalRequest(req("127.0.0.1", { host: "127.0.0.1:4300", "x-forwarded-for": "8.8.8.8" }))).toBe(false);
    expect(isLocalRequest(req("127.0.0.1", { host: "localhost", "cf-connecting-ip": "8.8.8.8" }))).toBe(false);
    expect(isLocalRequest(req("127.0.0.1", {}))).toBe(false);
  });
});

describe("server.localPeers (Docker)", async () => {
  const { isLocalRequest, peerInList } = await import("./security.mjs");
  const req = (addr, host = "127.0.0.1:4300", headers = {}) => ({ socket: { remoteAddress: addr }, headers: { host, ...headers } });
  it("treats only listed peers as this computer, and still needs a loopback Host and no proxy headers", () => {
    expect(peerInList("172.31.240.1", ["172.31.240.1"])).toBe(true);
    expect(peerInList("::ffff:192.168.65.3", ["192.168.65.0/24"])).toBe(true);
    expect(peerInList("10.0.0.1", ["192.168.65.0/24"])).toBe(false);
    expect(peerInList("fe80::1", ["0.0.0.0/0"])).toBe(false);
    expect(isLocalRequest(req("172.31.240.1"))).toBe(false);
    expect(isLocalRequest(req("172.31.240.1"), { localPeers: ["172.31.240.1"] })).toBe(true);
    expect(isLocalRequest(req("172.31.240.1", "evil.example"), { localPeers: ["172.31.240.1"] })).toBe(false);
    expect(isLocalRequest(req("172.31.240.1", undefined, { "x-forwarded-for": "1.2.3.4" }), { localPeers: ["172.31.240.1"] })).toBe(false);
  });
});
