/**
 * The listeners a tunnel is pointed at, against the REAL app on loopback (no outside network): the alerts listener
 * serves only webhooks, the Sheets listener only GET /xl/* for read-only keys, and neither serves the dashboard or the
 * API. Also the two this-computer-only routes behind the Expose card, and the self-check against the live listeners.
 */
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.mjs";
import { loadConfig } from "./config.mjs";
import { runSelfCheck } from "./expose.mjs";
import { createSheetsLimiter, sheetsAdmits } from "./exposeRoutes.mjs";
import { createNullLogger } from "./logger.mjs";

let app;
let ports;
let admin;
let reader;
let paper;

function call(port, { method = "GET", path, headers = {}, body, host }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, agent: false, headers: { host: host ?? `127.0.0.1:${port}`, ...(body !== undefined ? { "content-length": Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const bearer = (k) => ({ authorization: `Bearer ${k}` });

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-expose-"));
  const { config } = loadConfig({
    raw: {
      dataDir,
      logging: { level: "silent" },
      server: {
        port: 0,
        publicIngress: { enabled: true, port: 0, allowedHosts: ["hooks.example.com"] },
        sheetsIngress: { enabled: true, port: 0, allowedHosts: ["sheet.example.com"], requestsPerMinute: 12 },
      },
      ratelimit: { client: { perSecond: 10_000 } },
    },
    env: {},
    demo: true,
  });
  app = await createApp({ config, logger: createNullLogger() });
  ports = await app.listen();
  const mk = async (scopes, extra = {}) => (await app.deps.keyStore.create({ label: scopes.join("-"), scopes, accounts: "*", expiresAt: null, allowQuery: false, clientKind: "other", ...extra })).key;
  admin = await mk(["admin", "paper"]);
  reader = await mk(["read"]);
  paper = await mk(["read", "paper"]);
});
afterAll(async () => app?.close());

const sheets = (o) => call(ports.sheetsPort, { host: "sheet.example.com", ...o });
const alerts = (o) => call(ports.publicPort, { host: "hooks.example.com", ...o });

describe("the Sheets listener", () => {
  it("is a third port, separate from the main and alerts ports", () => {
    expect(new Set([ports.port, ports.publicPort, ports.sheetsPort]).size).toBe(3);
    expect(ports.sheetsPort).toBeGreaterThan(0);
  });

  it("serves GET /xl/* to a read-only key (header and, for a URL key, ?key=)", async () => {
    const r = await sheets({ path: "/xl/ltp?symbol=NSE:NIFTY", headers: bearer(reader) });
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/^\d/);
    const urlKey = (await app.deps.keyStore.create({ label: "url", scopes: ["read"], accounts: "*", expiresAt: null, allowQuery: true, clientKind: "excel" })).key;
    expect((await sheets({ path: `/xl/ltp?symbol=NSE:NIFTY&key=${urlKey}` })).status).toBe(200);
  });

  it("refuses a key with any scope beyond read (admin, paper), even though /xl would accept it on the main port", async () => {
    expect((await call(ports.port, { path: "/xl/ltp?symbol=NSE:NIFTY", headers: bearer(paper) })).status).toBe(200);
    for (const k of [admin, paper]) {
      const r = await sheets({ path: "/xl/ltp?symbol=NSE:NIFTY", headers: bearer(k) });
      expect(r.status).toBe(401);
      expect(r.text).toMatch(/#N\/A|read-only/i);
    }
  });

  it("answers 401 without a key", async () => {
    expect((await sheets({ path: "/xl/ltp?symbol=NSE:NIFTY" })).status).toBe(401);
  });

  it("answers 404 to everything that is not GET /xl/*: dashboard, API, keys, orders, webhooks, writes", async () => {
    const paths = [
      ["GET", "/"],
      ["GET", "/dashboard"],
      ["GET", "/dashboard/app.js"],
      ["GET", "/openapi.yaml"],
      ["GET", "/v1/health"],
      ["GET", "/v1/keys"],
      ["GET", "/v1/quotes?symbols=NSE:NIFTY"],
      ["GET", "/v1/orders"],
      ["GET", "/v1/expose"],
      ["POST", "/v1/sign-in"],
      ["POST", "/v1/orders"],
      ["POST", "/xl/ltp?symbol=NSE:NIFTY"],
      ["POST", "/hooks/generic/tok_sample_0000000000000000000000000"],
      ["DELETE", "/v1/keys/mcb_x"],
      ["GET", "/mcp"],
      ["GET", "/v1/stream/sse"],
    ];
    for (const [method, path] of paths) {
      const r = await sheets({ method, path, headers: { ...bearer(reader), ...(method === "POST" ? { "content-type": "application/json" } : {}) }, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
  });

  it("refuses a foreign Host (403) and a foreign Origin (403)", async () => {
    expect((await sheets({ path: "/xl/ltp?symbol=NSE:NIFTY", host: "evil.example", headers: bearer(reader) })).status).toBe(403);
    expect((await sheets({ path: "/xl/ltp?symbol=NSE:NIFTY", headers: { ...bearer(reader), origin: "https://evil.example" } })).status).toBe(403);
    // the alerts host name is not a Sheets host name
    expect((await sheets({ path: "/xl/ltp?symbol=NSE:NIFTY", host: "hooks.example.com", headers: bearer(reader) })).status).toBe(403);
  });

  it("rejects WebSocket upgrades with 404", async () => {
    const status = await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: ports.sheetsPort, path: "/v1/stream", headers: { host: "sheet.example.com", connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } });
      req.on("response", (res) => resolve(res.statusCode));
      req.on("upgrade", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode);
      });
      req.on("error", () => resolve("closed"));
      req.end();
    });
    expect([404, "closed"]).toContain(status);
  });
});

describe("the alerts listener", () => {
  it("does not serve /xl, the dashboard or the API", async () => {
    for (const [method, path] of [["GET", "/xl/ltp?symbol=NSE:NIFTY"], ["GET", "/dashboard"], ["GET", "/v1/keys"], ["GET", "/v1/expose"], ["POST", "/v1/expose/check"]]) {
      const r = await alerts({ method, path, headers: { ...bearer(admin), "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
  });
  it("answers an unknown webhook with 404 and a foreign host with 403, and caps the body at 413", async () => {
    const tok = "tok_sample_0000000000000000000000000";
    expect((await alerts({ method: "POST", path: `/hooks/generic/${tok}`, headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
    expect((await alerts({ method: "POST", path: `/hooks/generic/${tok}`, host: "evil.example", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await alerts({ method: "POST", path: `/hooks/generic/${tok}`, headers: { "content-type": "application/json" }, body: JSON.stringify({ pad: "x".repeat(20_000) }) })).status).toBe(413);
  });
});

describe("the main listener does not answer the tunnel host names", () => {
  it("403 for the alerts and Sheets hosts (the main listener's allowedHosts is left alone)", async () => {
    expect((await call(ports.port, { path: "/v1/health", host: "hooks.example.com" })).status).toBe(403);
    expect((await call(ports.port, { path: "/v1/health", host: "sheet.example.com" })).status).toBe(403);
  });
});

describe("GET /v1/expose and POST /v1/expose/check", () => {
  it("are admin and this-computer only", async () => {
    expect((await call(ports.port, { path: "/v1/expose" })).status).toBe(401);
    expect((await call(ports.port, { path: "/v1/expose", headers: bearer(reader) })).status).toBe(403);
    expect((await call(ports.port, { path: "/v1/expose", headers: { ...bearer(admin), "x-forwarded-for": "1.2.3.4" } })).status).toBe(403);
  });
  it("state: both listeners on, with the address patterns and the checks", async () => {
    const r = await call(ports.port, { path: "/v1/expose", headers: bearer(admin) });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ state: "on", exposed: ["alerts", "sheets"], alerts: { enabled: true, urlPattern: "https://hooks.example.com/hooks/<source>/<token>" }, sheets: { enabled: true, urlPattern: "https://sheet.example.com/xl/<route>" } });
    expect(r.json.data.headline).toMatch(/dashboard and the rest of the API stay on this computer/);
    expect(r.json.data.checks.some((c) => c.check === "expose-client-ip")).toBe(true);
  });
  it("check: refuses a public URL without allowOutbound, and makes no outbound call", async () => {
    const r = await call(ports.port, { method: "POST", path: "/v1/expose/check", headers: { ...bearer(admin), "content-type": "application/json" }, body: JSON.stringify({ publicUrl: "https://hooks.example.com" }) });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/allowOutbound/);
  });
  it("check: local probes run and return the result shape", async () => {
    const r = await call(ports.port, { method: "POST", path: "/v1/expose/check", headers: { ...bearer(admin), "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(200);
    expect(["good", "notes", "not_working", "unsafe"]).toContain(r.json.data.verdict);
    expect(Array.isArray(r.json.data.items)).toBe(true);
  });
});

describe("the self-check against the live listeners", () => {
  it("passes every local check on both (real HTTP to 127.0.0.1)", async () => {
    const r = await runSelfCheck({ config: app.config, ports: { alerts: ports.publicPort, sheets: ports.sheetsPort } });
    expect(r.items.filter((i) => i.status !== "pass")).toEqual([]);
    expect(r.verdict).toBe("good");
  });
});

describe("the Sheets request cap (last: it uses up the minute)", () => {
  it("caps requests per minute per caller address (429 with Retry-After)", async () => {
    const codes = [];
    for (let i = 0; i < 16; i++) codes.push((await sheets({ path: "/xl/ltp?symbol=NSE:NIFTY", headers: bearer(reader) })).status);
    expect(codes).toContain(429);
    const limited = await sheets({ path: "/xl/ltp?symbol=NSE:NIFTY", headers: bearer(reader) });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // the self-check says so in words instead of failing mysteriously
    const r = await runSelfCheck({ config: app.config, kinds: ["sheets"], ports: { sheets: ports.sheetsPort } });
    expect(r.items[0].detail).toMatch(/request cap/);
  });
});

describe("sheetsAdmits and the limiter", () => {
  const route = (method, pattern, options = {}) => ({ method, pattern, options });
  it("admits only GET /xl/* that need a read key and are not this-computer-only", () => {
    expect(sheetsAdmits("GET", route("GET", "/xl/ltp", { scope: "read" }))).toBe(true);
    expect(sheetsAdmits("HEAD", route("GET", "/xl/ltp", { scope: "read" }))).toBe(true);
    expect(sheetsAdmits("POST", route("POST", "/xl/ltp", { scope: "read" }))).toBe(false);
    expect(sheetsAdmits("GET", route("GET", "/xl/orders", { scope: "paper" }))).toBe(false);
    expect(sheetsAdmits("GET", route("GET", "/xl/x", { scope: "read", loopbackOnly: true }))).toBe(false);
    expect(sheetsAdmits("GET", route("GET", "/xl/x", { auth: "none" }))).toBe(false);
    expect(sheetsAdmits("GET", route("GET", "/v1/ltp", { scope: "read" }))).toBe(false);
    expect(sheetsAdmits("GET", route("GET", "/xlsx/x", { scope: "read" }))).toBe(false);
    expect(sheetsAdmits("GET", null)).toBe(false);
  });
  it("counts per address inside a minute and starts again after it", () => {
    let t = 0;
    const l = createSheetsLimiter({ perMinute: 2, now: () => t });
    expect(l.hit("a").ok).toBe(true);
    expect(l.hit("a").ok).toBe(true);
    const third = l.hit("a");
    expect(third.ok).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
    expect(l.hit("b").ok).toBe(true);
    t = 61_000;
    expect(l.hit("a").ok).toBe(true);
  });
  it("tracks a bounded number of addresses", () => {
    const l = createSheetsLimiter({ perMinute: 1, maxKeys: 3 });
    for (const a of ["1", "2", "3", "4", "5"]) l.hit(a);
    expect(l.hit("1").ok).toBe(true); // the oldest were forgotten, so its window began again
  });
});
