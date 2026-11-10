/**
 * Small protocol details every client can rely on: a 401 says how to authenticate, every answer names the contract
 * version, and a browser page on an allowed origin can preflight the PUT routes.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootDemoBridge } from "./__fixtures__/demoBridge.mjs";

describe("protocol details", () => {
  let b;
  beforeAll(async () => {
    b = await bootDemoBridge({ raw: { cors: { allowedOrigins: ["https://app.example.test"] } } });
  });
  afterAll(() => b?.close());

  it("a 401 carries WWW-Authenticate: Bearer", async () => {
    const r = await b.call("GET", "/v1/ltp?symbols=NSE:RELIANCE", { auth: null });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect((await b.call("GET", "/v1/ltp?symbols=NSE:RELIANCE", { auth: "mcb_nokey_wrongwrongwrongwrongwrong" })).headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect((await b.call("GET", "/v1/ltp?symbols=NSE:RELIANCE")).headers.get("www-authenticate")).toBeNull();
  });

  it("every answer names the contract version", async () => {
    expect((await b.call("GET", "/v1/health", { auth: null })).headers.get("x-api-version")).toBe("v1");
    expect((await b.call("GET", "/v1/ltp?symbols=NSE:RELIANCE")).headers.get("x-api-version")).toBe("v1");
    expect((await b.call("GET", "/v1/no-such-route")).headers.get("x-api-version")).toBe("v1");
  });

  it("a preflight from an allowed origin lists PUT among the methods", async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(`${b.base}/v1/recordings/auto`, { method: "OPTIONS", headers: { Origin: "https://app.example.test", "Access-Control-Request-Method": "PUT" } }, (r) => {
        r.resume();
        r.on("end", () => resolve(r));
      });
      req.on("error", reject);
      req.end();
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-methods"]).toContain("PUT");
    expect(res.headers["access-control-expose-headers"]).toContain("X-MCB-Ignored-Params");
  });
});
