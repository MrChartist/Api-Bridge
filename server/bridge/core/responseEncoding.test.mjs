/**
 * ETag, 304 and gzip for the large read answers: the pure encoder, then the real app over raw HTTP (so the client's
 * Accept-Encoding is exactly what the test sends).
 */
import http from "node:http";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootBridge, stubBroker } from "../e2e/fixtures.mjs";
import { Reply, json } from "./http.mjs";
import { ENCODED_ROUTES, createResponseEncoder, mergeVary } from "./responseEncoding.mjs";

const big = (n = 400) => ({ data: Array.from({ length: n }, (_, i) => ({ i, text: `row ${i}` })), meta: { requestId: "r" } });

describe("mergeVary", () => {
  it("keeps what CORS set and adds Accept-Encoding once", () => {
    expect(mergeVary("Origin", "Accept-Encoding")).toBe("Origin, Accept-Encoding");
    expect(mergeVary(undefined, "Accept-Encoding")).toBe("Accept-Encoding");
    expect(mergeVary("origin, accept-encoding", "Accept-Encoding")).toBe("origin, accept-encoding");
  });
});

describe("response encoder", () => {
  const enc = createResponseEncoder();
  const ask = (reply, o = {}) => enc.encode(reply, { method: "GET", pattern: "/v1/history", requestHeaders: {}, ...o });

  it("leaves other routes, other methods, errors and tiny answers alone", async () => {
    const r = json(big());
    expect(await ask(r, { pattern: "/v1/quotes" })).toBe(r);
    expect(await ask(r, { method: "POST" })).toBe(r);
    const err = new Reply(404, "{}", {});
    expect(await ask(err)).toBe(err);
    const tiny = await ask(json({ data: [] }), { requestHeaders: { "accept-encoding": "gzip" } });
    expect(tiny.status).toBe(200);
    expect(tiny.headers["Content-Encoding"]).toBeUndefined();
    expect(tiny.headers.ETag).toMatch(/^"[A-Za-z0-9_-]{22}"$/);
  });

  it("adds a strong ETag and no compression when the client does not ask for it", async () => {
    const r = await ask(json(big()));
    expect(r.status).toBe(200);
    expect(r.headers.ETag).toMatch(/^"[A-Za-z0-9_-]{22}"$/);
    expect(r.headers.Vary).toBe("Accept-Encoding");
    expect(r.headers["Content-Encoding"]).toBeUndefined();
    expect(JSON.parse(r.body).data).toHaveLength(400);
    expect(r.headers["Cache-Control"]).toBeUndefined(); // live answers keep the pipeline's no-store
  });

  it("gzips a live answer on request and the body decodes to the very same bytes", async () => {
    const plain = await ask(json(big()));
    const z = await ask(json(big()), { requestHeaders: { "accept-encoding": "gzip, deflate" } });
    expect(z.headers["Content-Encoding"]).toBe("gzip");
    expect(z.headers.ETag).toBe(plain.headers.ETag.replace(/"$/, '-gzip"'));
    expect(gunzipSync(z.body).toString("utf8")).toBe(plain.body);
    expect(z.body.length).toBeLessThan(Buffer.byteLength(plain.body) / 3);
  });

  it("answers 304 with no body when If-None-Match matches this representation, and not another one", async () => {
    const first = await ask(json(big()), { requestHeaders: { "accept-encoding": "gzip" } });
    const again = await ask(json(big()), { requestHeaders: { "accept-encoding": "gzip", "if-none-match": first.headers.ETag } });
    expect(again.status).toBe(304);
    expect(again.body).toBe("");
    expect(again.headers.ETag).toBe(first.headers.ETag);
    // The gzip validator never matches the identity representation.
    const other = await ask(json(big()), { requestHeaders: { "if-none-match": first.headers.ETag } });
    expect(other.status).toBe(200);
    // A different body is a different ETag, so a changed answer is never served as a 304.
    const changed = await ask(json(big(401)), { requestHeaders: { "accept-encoding": "gzip", "if-none-match": first.headers.ETag } });
    expect(changed.status).toBe(200);
    // Weak form and lists are matched; "*" matches.
    expect((await ask(json(big()), { requestHeaders: { "accept-encoding": "gzip", "if-none-match": `"x", W/${first.headers.ETag}` } })).status).toBe(304);
    expect((await ask(json(big()), { requestHeaders: { "if-none-match": "*" } })).status).toBe(304);
  });

  it("static answers use br when accepted, are revalidated (no-cache) and compress once per content", async () => {
    const text = new Reply(200, "openapi: 3.1.0\n".repeat(2000), { "Content-Type": "application/yaml; charset=utf-8" });
    const r = await ask(text, { pattern: "/openapi.yaml", requestHeaders: { "accept-encoding": "br, gzip" } });
    expect(r.headers["Content-Encoding"]).toBe("br");
    expect(r.headers["Cache-Control"]).toBe("no-cache");
    expect(brotliDecompressSync(r.body).toString("utf8")).toBe(text.body);
    const r2 = await ask(text, { pattern: "/openapi.yaml", requestHeaders: { "accept-encoding": "br, gzip" } });
    expect(r2.body).toBe(r.body); // the same cached Buffer
    expect(enc.stats().entries).toBeGreaterThan(0);
    const g = await ask(text, { pattern: "/openapi.yaml", requestHeaders: { "accept-encoding": "gzip" } });
    expect(g.headers["Content-Encoding"]).toBe("gzip");
  });

  it("only the documented routes are encoded", () => {
    expect(Object.keys(ENCODED_ROUTES).sort()).toEqual(["/openapi.yaml", "/v1/brokers", "/v1/calendar/holidays", "/v1/errors", "/v1/history", "/v1/instruments/search", "/v1/optionchain"]);
  });
});

let bridge;
let key;

/** A raw GET, so the test controls Accept-Encoding and sees the body as sent. */
function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: bridge.port, method: "GET", path, headers: { host: `127.0.0.1:${bridge.port}`, ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("on the real app", () => {
  beforeAll(async () => {
    bridge = await bootBridge({
      brokers: { zerodha: stubBroker("zerodha") },
      raw: { accounts: [{ id: "zerodha-main", broker: "zerodha", label: "Main" }] },
    });
    await bridge.deps.accounts.connect("zerodha-main", { values: { apiKey: "k", accessToken: "token-main" } });
    key = (await bridge.deps.keyStore.create({ label: "read", scopes: ["read"], accounts: "*", expiresAt: null, allowQuery: false, clientKind: "other" })).key;
  });
  afterAll(async () => {
    await bridge?.close();
  });

  it("/openapi.yaml: br or gzip on request, an ETag, and a 304 on the next visit; no header means the same bytes as before", async () => {
    const plain = await get("/openapi.yaml");
    expect(plain.status).toBe(200);
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.headers.etag).toBeTruthy();
    expect(plain.body.length).toBeGreaterThan(100_000);
    const br = await get("/openapi.yaml", { "accept-encoding": "br, gzip" });
    expect(br.headers["content-encoding"]).toBe("br");
    expect(br.headers.vary).toMatch(/Accept-Encoding/);
    expect(br.headers["cache-control"]).toBe("no-cache");
    expect(br.body.length).toBeLessThan(plain.body.length / 4);
    expect(brotliDecompressSync(br.body).equals(plain.body)).toBe(true);
    const gz = await get("/openapi.yaml", { "accept-encoding": "gzip" });
    expect(gunzipSync(gz.body).equals(plain.body)).toBe(true);
    const again = await get("/openapi.yaml", { "accept-encoding": "br", "if-none-match": br.headers.etag });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
    expect(again.headers["content-length"]).toBe("0");
  });

  it("/v1/history is gzipped on request, keeps no-store, and the decoded body is the plain answer", async () => {
    const path = "/v1/history?symbol=NSE:RELIANCE&interval=1d&from=2025-01-01&to=2026-10-16";
    const plain = await get(path);
    expect(plain.status).toBe(200);
    const z = await get(path, { "accept-encoding": "gzip" });
    expect(z.status).toBe(200);
    expect(z.headers["content-encoding"]).toBe("gzip");
    expect(z.headers["cache-control"]).toBe("no-store");
    const a = JSON.parse(gunzipSync(z.body).toString("utf8"));
    const b = JSON.parse(plain.body.toString("utf8"));
    expect(a.data.candles).toEqual(b.data.candles);
    expect(a.data.candles.length).toBeGreaterThan(100);
    // The auth and scope checks still come first.
    key = undefined;
    expect((await get(path, { "accept-encoding": "gzip" })).status).toBe(401);
  });
});
