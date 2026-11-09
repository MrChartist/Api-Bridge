// The dashboard's static server over real HTTP: compression negotiation, validators and headers.
import http from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DASHBOARD_FILES } from "./app.mjs";
import { bootSecurityApp } from "./__fixtures__/securityApp.mjs";

const DIR = resolve(import.meta.dirname, "../dashboard");
let boot;

/** A GET with exact headers; the body comes back as the bytes sent (not decoded). */
const get = (path, headers = {}, method = "GET") =>
  new Promise((resolveReq, reject) => {
    const req = http.request({ host: "127.0.0.1", port: boot.port, method, path, agent: false, headers: { host: `127.0.0.1:${boot.port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolveReq({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });

beforeAll(async () => {
  boot = await bootSecurityApp({ demo: true });
});
afterAll(async () => {
  await boot.close();
});

const source = (name) => readFileSync(resolve(DIR, name));

describe("dashboard compression", () => {
  it("br when the client prefers it: smaller body, right headers, decodes to the file", async () => {
    const r = await get("/dashboard/app.js", { "accept-encoding": "gzip, deflate, br" });
    expect(r.status).toBe(200);
    expect(r.headers["content-encoding"]).toBe("br");
    expect(r.headers.vary).toBe("Accept-Encoding");
    expect(r.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(r.headers["content-length"]).toBe(String(r.body.length));
    expect(r.body.length).toBeLessThan(source("app.js").length / 2);
    expect(brotliDecompressSync(r.body).equals(source("app.js"))).toBe(true);
  });

  it("gzip when that is all it accepts", async () => {
    const r = await get("/dashboard/app.css", { "accept-encoding": "gzip" });
    expect(r.headers["content-encoding"]).toBe("gzip");
    expect(r.headers.vary).toBe("Accept-Encoding");
    expect(gunzipSync(r.body).equals(source("app.css"))).toBe(true);
  });

  it("gzip when br is refused with q=0 or ranked lower", async () => {
    expect((await get("/dashboard/app.js", { "accept-encoding": "br;q=0, gzip" })).headers["content-encoding"]).toBe("gzip");
    expect((await get("/dashboard/app.js", { "accept-encoding": "br;q=0.4, gzip;q=0.8" })).headers["content-encoding"]).toBe("gzip");
  });

  it("the plain file, still with Vary, when no header, identity, q=0 on both or only unknown codings", async () => {
    for (const ae of [undefined, "identity", "br;q=0, gzip;q=0", "zstd, deflate"]) {
      const r = await get("/dashboard/app.js", ae === undefined ? {} : { "accept-encoding": ae });
      expect(r.status, String(ae)).toBe(200);
      expect(r.headers["content-encoding"], String(ae)).toBeUndefined();
      expect(r.headers.vary, String(ae)).toBe("Accept-Encoding");
      expect(r.body.equals(source("app.js")), String(ae)).toBe(true);
      expect(r.headers.etag, String(ae)).toMatch(/^"[A-Za-z0-9_-]{22}"$/);
    }
  });

  it("every dashboard page and script is served compressed and decodes to the file on disk", async () => {
    const names = Object.keys(DASHBOARD_FILES).filter((n) => /\.(js|css|html)$/.test(n));
    expect(names.length).toBeGreaterThan(20);
    for (const n of names) {
      const r = await get(n === "index.html" ? "/dashboard" : `/dashboard/${n}`, { "accept-encoding": "br" });
      expect(r.status, n).toBe(200);
      expect(r.headers["content-encoding"], n).toBe("br");
      expect(brotliDecompressSync(r.body).equals(source(n)), n).toBe(true);
    }
  });

  it("tiny files are not compressed and carry no Vary (the answer cannot differ by encoding)", async () => {
    expect(source("logo.svg").length).toBeLessThan(1024);
    const r = await get("/dashboard/logo.svg", { "accept-encoding": "br, gzip" });
    expect(r.status).toBe(200);
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(r.headers.vary).toBeUndefined();
    expect(r.body.equals(source("logo.svg"))).toBe(true);
  });

  it("images are never compressed again", async () => {
    const png = readdirSync(resolve(DIR, "brokers")).find((f) => f.endsWith(".png"));
    const r = await get(`/dashboard/broker-${png.slice(0, -4)}.png`, { "accept-encoding": "br, gzip" });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(r.body.equals(readFileSync(resolve(DIR, "brokers", png)))).toBe(true);
  });

  it("HEAD reports the compressed length and sends no body", async () => {
    const r = await get("/dashboard/app.js", { "accept-encoding": "br" }, "HEAD");
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(0);
    const full = await get("/dashboard/app.js", { "accept-encoding": "br" });
    expect(r.headers["content-length"]).toBe(String(full.body.length));
    expect(r.headers["content-encoding"]).toBe("br");
  });

  it("keeps the strict CSP and every other header on compressed answers", async () => {
    const r = await get("/dashboard/app.js", { "accept-encoding": "br" });
    const plain = await get("/dashboard/app.js");
    expect(r.headers["content-security-policy"]).toBe(plain.headers["content-security-policy"]);
    expect(r.headers["content-security-policy"]).toMatch(/script-src 'self'/);
    expect(r.headers["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
    expect(r.headers["cache-control"]).toBe("no-cache");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBeDefined();
    expect(r.headers["cross-origin-resource-policy"]).toBe("same-origin");
  });
});

describe("dashboard validators", () => {
  it("each coding has its own strong ETag, stable across requests", async () => {
    const [id, br, gz, br2] = await Promise.all([get("/dashboard/views.js"), get("/dashboard/views.js", { "accept-encoding": "br" }), get("/dashboard/views.js", { "accept-encoding": "gzip" }), get("/dashboard/views.js", { "accept-encoding": "br" })]);
    const tags = [id, br, gz].map((r) => r.headers.etag);
    expect(new Set(tags).size).toBe(3);
    for (const t of tags) expect(t.startsWith("W/")).toBe(false);
    expect(br.headers.etag).toBe(br2.headers.etag);
    expect(br.headers.etag).toBe(`${id.headers.etag.slice(0, -1)}-br"`);
  });

  it("304 with no body when the validator matches, with ETag, Vary and Cache-Control", async () => {
    for (const coding of ["br", "gzip", null]) {
      const ae = coding ? { "accept-encoding": coding } : {};
      const first = await get("/dashboard/views.js", ae);
      const again = await get("/dashboard/views.js", { ...ae, "if-none-match": first.headers.etag });
      expect(again.status, String(coding)).toBe(304);
      expect(again.body.length).toBe(0);
      expect(again.headers.etag).toBe(first.headers.etag);
      expect(again.headers.vary).toBe("Accept-Encoding");
      expect(again.headers["cache-control"]).toBe("no-cache");
      expect(again.headers["content-security-policy"]).toBeDefined();
    }
  });

  it("a validator from another coding does not match: the client gets the new representation in full", async () => {
    const gz = await get("/dashboard/views.js", { "accept-encoding": "gzip" });
    const r = await get("/dashboard/views.js", { "accept-encoding": "br", "if-none-match": gz.headers.etag });
    expect(r.status).toBe(200);
    expect(r.headers["content-encoding"]).toBe("br");
    const plain = await get("/dashboard/views.js");
    const r2 = await get("/dashboard/views.js", { "accept-encoding": "gzip", "if-none-match": plain.headers.etag });
    expect(r2.status).toBe(200);
    expect(r2.headers["content-encoding"]).toBe("gzip");
  });

  it("matches a list, a weak prefix and *", async () => {
    const first = await get("/dashboard/views.js", { "accept-encoding": "br" });
    for (const inm of [`"nope", ${first.headers.etag}`, `W/${first.headers.etag}`, "*"]) {
      expect((await get("/dashboard/views.js", { "accept-encoding": "br", "if-none-match": inm })).status, inm).toBe(304);
    }
    expect((await get("/dashboard/views.js", { "accept-encoding": "br", "if-none-match": '"nope"' })).status).toBe(200);
  });

  it("a request that accepts nothing and sends a compressed validator gets the plain file", async () => {
    const br = await get("/dashboard/views.js", { "accept-encoding": "br" });
    const r = await get("/dashboard/views.js", { "if-none-match": br.headers.etag });
    expect(r.status).toBe(200);
    expect(r.headers["content-encoding"]).toBeUndefined();
  });
});
