import http from "node:http";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createApp } from "./app.mjs";
import { loadConfig } from "./config.mjs";
import { BridgeError } from "./errors.mjs";
import { csv, text } from "./http.mjs";
import { createLogger } from "./logger.mjs";
import { defineModule } from "./modules.mjs";
import { notImplementedService } from "./contracts.mjs";

const KEYS = {
  "mcb_read0000001_aaaaaaaaaaaaaaaaaaaa": { id: "read0000001", label: "reader", scopes: ["read"], accounts: "*", allowQuery: false },
  "mcb_xlread00001_bbbbbbbbbbbbbbbbbbbb": { id: "xlread00001", label: "excel", scopes: ["read"], accounts: "*", allowQuery: true },
  "mcb_live0000001_cccccccccccccccccccc": { id: "live0000001", label: "live", scopes: ["live"], accounts: ["a1"], allowQuery: true },
  "mcb_admin000001_dddddddddddddddddddd": { id: "admin000001", label: "admin", scopes: ["admin"], accounts: "*" },
};
const fakeKeyStore = {
  ...notImplementedService("keyStore"),
  authenticate: async (raw) => KEYS[raw] ?? null,
};
let limited = false;
const fakeScheduler = {
  ...notImplementedService("scheduler"),
  checkClient: () => (limited ? { ok: false, retryAfterMs: 2500, headers: { RateLimit: "limit=10, remaining=0, reset=3" } } : { ok: true, retryAfterMs: 0, headers: { RateLimit: "limit=10, remaining=9, reset=1" } }),
};

const testModule = defineModule({
  name: "testmod",
  stream: "S10",
  register(app) {
    app.get("/t/read", (ctx) => ({ key: ctx.key.id, scopes: [...ctx.scopes].sort(), q: ctx.query.get("x") }), { scope: "read" });
    app.get("/t/xl", () => text("123.45"), { scope: "read", allowQueryKey: true });
    app.get("/t/csv", () => csv([["a", "b"], [1, "=cmd()"]]), { scope: "read" });
    app.post("/t/paper", (ctx) => ({ body: ctx.body }), { scope: "paper" });
    app.post("/t/hook/:token", (ctx) => ({ token: ctx.params.token, body: ctx.body, raw: ctx.rawBody?.toString("utf8"), public: ctx.viaPublicIngress }), { auth: "custom", public: true, body: "json-or-text" });
    app.post("/t/small", () => ({}), { scope: "read", bodyLimitBytes: 16 });
    app.delete("/t/nothing", () => undefined, { scope: "paper", body: "none" });
    app.get("/t/throw", () => {
      throw new BridgeError("UPSTREAM_RATE_LIMITED", "Broker busy", { retryAfterMs: 3000, broker: { id: "dhan", code: "DH-904" } });
    }, { scope: "read" });
    app.get("/t/crash", () => {
      throw new Error("internal path /secret/thing");
    }, { auth: "none" });
    app.get("/t/admin", () => ({ ok: true }), { scope: "admin", loopbackOnly: true });
    app.get("/t/stub", (ctx) => ctx.log && notImplementedService("orders").list(), { scope: "read" });
    app.upgrade("/t/ws", ({ req, socket, head, reject }) => {
      if (req.headers.authorization !== "Bearer mcb_read0000001_aaaaaaaaaaaaaaaaaaaa") return reject("401 Unauthorized");
      wss.handleUpgrade(req, socket, head, (ws) => ws.send("hello"));
    });
  },
});
const wss = new WebSocketServer({ noServer: true });

let app;
let port;
let publicPort;
const logLines = [];

function request(p, { method = "GET", path, headers = {}, body } = {}) {
  const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  const lengthHeader = payload === undefined ? {} : { "content-length": Buffer.byteLength(payload) };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: p, method, path, headers: { host: `127.0.0.1:${p}`, ...lengthHeader, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = JSON.parse(raw);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
const get = (path, headers) => request(port, { path, headers });
const auth = (k) => ({ authorization: `Bearer ${k}` });
const READ = "mcb_read0000001_aaaaaaaaaaaaaaaaaaaa";
const LIVE = "mcb_live0000001_cccccccccccccccccccc";

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-app-"));
  const { config } = loadConfig({
    raw: { server: { port: 0, allowedHosts: ["tunnel.example"], publicIngress: { enabled: true, port: 0 } }, cors: { allowedOrigins: ["http://localhost:5173"] }, dataDir },
    env: {},
  });
  const logger = createLogger({ level: "info", write: (l) => logLines.push(l) });
  app = await createApp({ config, modules: [testModule], overrides: { keyStore: fakeKeyStore, scheduler: fakeScheduler }, logger });
  ({ port, publicPort } = await app.listen());
});

afterAll(async () => {
  await app.close();
});

describe("core routes", () => {
  it("health is public; loopback callers see service status", async () => {
    const r = await get("/v1/health");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "ok", apiVersion: "v1" });
    expect(r.json.services.keyStore).toBe("ready");
    expect(r.json.services.orders).toBe("not_built");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("meta needs a read key and lists routes", async () => {
    expect((await get("/v1/meta")).status).toBe(401);
    const r = await get("/v1/meta", auth(READ));
    expect(r.status).toBe(200);
    expect(r.json.routes.some((x) => x.path === "/t/read")).toBe(true);
    expect(existsSync(join(r.json.installDir, "bin", "mc-bridge.mjs"))).toBe(true);
  });

  it("serves the OpenAPI document", async () => {
    const r = await get("/openapi.yaml");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/yaml/);
    expect(r.raw).toMatch(/^openapi: 3\.1/m);
  });
});

describe("loopback trust (tunnels)", () => {
  const ADMIN = "mcb_admin000001_dddddddddddddddddddd";
  it("a request through a local tunnel host is not 'this computer' even though the peer is 127.0.0.1", async () => {
    const r = await get("/t/admin", { ...auth(ADMIN), host: "tunnel.example" });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("LOOPBACK_ONLY");
    expect((await get("/dashboard", { host: "tunnel.example" })).json.code).toBe("LOOPBACK_ONLY");
  });

  it("forwarding headers remove loopback trust, including the health detail", async () => {
    for (const h of [{ "x-forwarded-for": "8.8.8.8" }, { forwarded: "for=8.8.8.8" }, { "cf-connecting-ip": "8.8.8.8" }, { "x-real-ip": "8.8.8.8" }]) {
      const r = await get("/t/admin", { ...auth(ADMIN), ...h });
      expect(r.json?.code).toBe("LOOPBACK_ONLY");
    }
    const health = await get("/v1/health", { "x-forwarded-for": "8.8.8.8" });
    expect(health.status).toBe(200);
    expect(health.json.services).toBeUndefined();
  });

  it("a plain local request keeps loopback trust", async () => {
    expect((await get("/t/admin", auth(ADMIN))).status).toBe(200);
  });
});

describe("access log redaction", () => {
  it("never logs a webhook URL token, even when the method or path does not match", async () => {
    const token = "TOKENsecret0123456789abcdefghijklmnopqrstuvw";
    await get(`/hooks/gocharting/${token}`);
    await request(port, { method: "DELETE", path: `/hooks/gocharting/${token}` });
    await request(publicPort, { method: "GET", path: `/hooks/gocharting/${token}`, headers: { host: `127.0.0.1:${publicPort}` } });
    await request(publicPort, { method: "GET", path: `/nope/${token}`, headers: { host: `127.0.0.1:${publicPort}` } });
    expect(logLines.join("\n")).not.toContain(token);
    expect(logLines.join("\n")).toContain("/hooks/:source/:token");
  });
});

describe("dashboard allowlist", () => {
  it("inherited object names are 404, not 500", async () => {
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect((await get(`/dashboard/${name}`)).status).toBe(404);
    }
  });
});

describe("authentication and scopes", () => {
  it("401 without a key or with a bad key, as problem+json", async () => {
    const r = await get("/t/read");
    expect(r.status).toBe(401);
    expect(r.headers["content-type"]).toMatch(/application\/problem\+json/);
    expect(r.json).toMatchObject({ code: "UNAUTHENTICATED", retryable: false });
    expect((await get("/t/read", auth("mcb_nope"))).status).toBe(401);
  });

  it("accepts Bearer and X-API-Key", async () => {
    expect((await get("/t/read", auth(READ))).json.key).toBe("read0000001");
    expect((await get("/t/read", { "x-api-key": READ })).json.key).toBe("read0000001");
  });

  it("scopes imply each other: live -> paper -> read; admin -> read", async () => {
    expect((await get("/t/read", auth(LIVE))).json.scopes).toEqual(["live", "paper", "read"]);
    const paper = await request(port, { method: "POST", path: "/t/paper", headers: { ...auth(READ), "content-type": "application/json" }, body: { a: 1 } });
    expect(paper.status).toBe(403);
    expect(paper.json.code).toBe("SCOPE_REQUIRED");
    const ok = await request(port, { method: "POST", path: "/t/paper", headers: { ...auth(LIVE), "content-type": "application/json" }, body: { a: 1 } });
    expect(ok.json).toEqual({ body: { a: 1 } });
  });

  it("?key= works only on routes that allow it, and only for read-only URL keys", async () => {
    expect((await get("/t/read?key=" + READ)).status).toBe(401);
    expect((await get("/t/xl?key=" + READ)).status).toBe(401);
    expect((await get("/t/xl?key=mcb_live0000001_cccccccccccccccccccc")).status).toBe(401);
    const ok = await get("/t/xl?key=mcb_xlread00001_bbbbbbbbbbbbbbbbbbbb");
    expect(ok.status).toBe(200);
    expect(ok.raw).toBe("123.45");
    expect(ok.headers["content-type"]).toMatch(/text\/plain/);
  });

  it("the access log never contains keys or query strings", async () => {
    await get("/t/xl?key=mcb_xlread00001_bbbbbbbbbbbbbbbbbbbb&x=1");
    const joined = logLines.join("\n");
    expect(joined).not.toContain("bbbbbbbbbbbb");
    expect(joined).not.toContain("key=");
    expect(joined).toContain('"path":"/t/xl"');
  });

  it("admin routes need the admin scope", async () => {
    expect((await get("/t/admin", auth(READ))).status).toBe(403);
    expect((await get("/t/admin", auth("mcb_admin000001_dddddddddddddddddddd"))).status).toBe(200);
  });
});

describe("transport guards", () => {
  it("refuses a foreign Host header (DNS rebinding)", async () => {
    const r = await get("/v1/health", { host: "evil.example" });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("HOST_NOT_ALLOWED");
  });

  it("refuses origins not on the allowlist and answers preflight for listed ones", async () => {
    expect((await get("/v1/health", { origin: "https://evil.example" })).json.code).toBe("ORIGIN_NOT_ALLOWED");
    const pre = await request(port, { method: "OPTIONS", path: "/t/read", headers: { origin: "http://localhost:5173" } });
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(pre.headers["access-control-allow-headers"]).toMatch(/Idempotency-Key/);
    const r = await get("/t/read", { ...auth(READ), origin: "http://localhost:5173" });
    expect(r.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(r.headers.vary).toBe("Origin");
  });
});

describe("routing and bodies", () => {
  it("404 and 405 with Allow", async () => {
    expect((await get("/nope")).json.code).toBe("NOT_FOUND");
    const r = await request(port, { method: "PATCH", path: "/t/read", headers: auth(READ) });
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe("GET");
  });

  it("HEAD is answered like GET without a body", async () => {
    const r = await request(port, { method: "HEAD", path: "/v1/health" });
    expect(r.status).toBe(200);
    expect(r.raw).toBe("");
  });

  it("parses JSON and rejects bad JSON, wrong media types and oversized bodies", async () => {
    const h = { ...auth(LIVE), "content-type": "application/json" };
    expect((await request(port, { method: "POST", path: "/t/paper", headers: h, body: "{bad" })).json.code).toBe("INVALID_JSON");
    expect((await request(port, { method: "POST", path: "/t/paper", headers: { ...auth(LIVE), "content-type": "text/csv" }, body: "a,b" })).json.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    const big = await request(port, { method: "POST", path: "/t/small", headers: { ...auth(READ), "content-type": "application/json" }, body: { x: "y".repeat(100) } });
    expect(big.status).toBe(413);
    const del = await request(port, { method: "DELETE", path: "/t/nothing", headers: auth(LIVE), body: "x" });
    expect(del.json.code).toBe("VALIDATION_FAILED");
  });

  it("returns 204 when a handler returns nothing", async () => {
    const r = await request(port, { method: "DELETE", path: "/t/nothing", headers: auth(LIVE) });
    expect(r.status).toBe(204);
  });

  it("CSV replies guard against formula injection", async () => {
    const r = await get("/t/csv", auth(READ));
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
    expect(r.raw).toBe("a,b\r\n1,'=cmd()\r\n");
  });

  it("json-or-text routes keep the raw body and accept text/plain", async () => {
    const r = await request(port, { method: "POST", path: "/t/hook/tok123", headers: { "content-type": "text/plain" }, body: "BUY NIFTY" });
    expect(r.json).toEqual({ token: "tok123", body: "BUY NIFTY", raw: "BUY NIFTY", public: false });
    const j = await request(port, { method: "POST", path: "/t/hook/tok123", headers: { "content-type": "text/plain" }, body: '{"action":"BUY"}' });
    expect(j.json.body).toEqual({ action: "BUY" });
  });
});

describe("errors", () => {
  it("BridgeError -> status, problem body, Retry-After and broker detail", async () => {
    const r = await get("/t/throw", auth(READ));
    expect(r.status).toBe(429);
    expect(r.headers["retry-after"]).toBe("3");
    expect(r.json).toMatchObject({ code: "UPSTREAM_RATE_LIMITED", retryable: true, broker: { id: "dhan", code: "DH-904" } });
    expect(r.json.requestId).toBe(r.headers["x-request-id"]);
  });

  it("unexpected errors are 500 and leak nothing", async () => {
    const r = await get("/t/crash");
    expect(r.status).toBe(500);
    expect(r.raw).not.toContain("/secret/thing");
  });

  it("stub services answer 501 naming the stream", async () => {
    const r = await get("/t/stub", auth(READ));
    expect(r.status).toBe(501);
    expect(r.json.detail).toContain("OrderService.list() (stream S7)");
  });

  it("echoes a sane X-Request-Id and replaces a bad one", async () => {
    expect((await get("/v1/health", { "x-request-id": "my-trace-123456" })).headers["x-request-id"]).toBe("my-trace-123456");
    expect((await get("/v1/health", { "x-request-id": "bad id!" })).headers["x-request-id"]).toMatch(/^req_/);
  });
});

describe("client rate limit", () => {
  it("passes RateLimit headers through and answers 429 with Retry-After when exhausted", async () => {
    expect((await get("/t/read", auth(READ))).headers.ratelimit).toBe("limit=10, remaining=9, reset=1");
    limited = true;
    try {
      const r = await get("/t/read", auth(READ));
      expect(r.status).toBe(429);
      expect(r.json.code).toBe("RATE_LIMITED");
      expect(r.headers["retry-after"]).toBe("3");
      expect(r.headers.ratelimit).toBe("limit=10, remaining=0, reset=3");
    } finally {
      limited = false;
    }
  });
});

describe("public ingress", () => {
  it("serves only routes marked public", async () => {
    const hook = await request(publicPort, { method: "POST", path: "/t/hook/abc", headers: { "content-type": "application/json" }, body: { a: 1 } });
    expect(hook.status).toBe(200);
    expect(hook.json.public).toBe(true);
    expect((await request(publicPort, { path: "/v1/health" })).status).toBe(404);
    expect((await request(publicPort, { path: "/t/read", headers: auth(READ) })).status).toBe(404);
    expect((await request(publicPort, { method: "DELETE", path: "/t/hook/abc" })).status).toBe(404);
  });
});

describe("WebSocket upgrades", () => {
  const connect = (path, headers = {}) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
      ws.on("message", (m) => {
        resolve({ ok: true, msg: m.toString() });
        ws.close();
      });
      ws.on("unexpected-response", (_req, res) => resolve({ ok: false, status: res.statusCode }));
      ws.on("error", () => {});
    });

  it("routes to the registered handler, which authenticates", async () => {
    expect(await connect("/t/ws", auth(READ))).toEqual({ ok: true, msg: "hello" });
    expect(await connect("/t/ws")).toEqual({ ok: false, status: 401 });
  });

  it("refuses unknown paths, foreign hosts and foreign origins", async () => {
    expect(await connect("/nope", auth(READ))).toEqual({ ok: false, status: 404 });
    expect(await connect("/t/ws", { ...auth(READ), origin: "https://evil.example" })).toEqual({ ok: false, status: 403 });
  });
});
