/**
 * ETag, If-None-Match and compression for the large read answers of /v1 (docs/guides/developers.md, "Big answers").
 *
 * Which answers: a short list of GET routes whose bodies are large (history, option chain, instrument search, the OpenAPI
 * file, the error catalogue, the broker list, the holiday list). Everything else is sent as before. A client that does not
 * send Accept-Encoding gets the same bytes as before; the only change for it is a new `ETag` header.
 *
 *   ETag          a strong validator: a hash of the exact bytes of the answer, and a different one per coding (so a cache can
 *                 never hand a gzip body to a client that asked for another). It changes whenever one byte of the answer
 *                 changes, including `freshness`, so a 304 only ever says "these are the very same bytes you already have".
 *   304           when If-None-Match matches (weak comparison, as GET uses). No body, and nothing is compressed.
 *   compression   gzip or br when the client's Accept-Encoding allows it and the body is at least MIN_COMPRESS_BYTES.
 *                 Live answers use gzip level 6 (fast; they are built per request). The OpenAPI file, the error catalogue,
 *                 the broker list and the holiday list are static text: they use the shared compression cache (br or gzip at
 *                 the best setting, compressed once per content change).
 *   Cache-Control every authenticated answer stays `no-store` (the Bridge's baseline: nothing about orders or prices is kept
 *                 by a cache), so a client uses If-None-Match itself, as the SDKs and scripts can. Only the public, static
 *                 /openapi.yaml becomes `no-cache`: a client may keep a copy but must ask "still this one?" (a 304) each time.
 *
 * Nothing here changes a body, a status or a header other than ETag, Vary, Content-Encoding and Cache-Control.
 */
import { createHash } from "node:crypto";
import { gzip } from "node:zlib";
import { MIN_COMPRESS_BYTES, createCompressionCache, etagFor, ifNoneMatches, negotiateEncoding } from "./staticCompress.mjs";
import { Reply, json } from "./http.mjs";

/** Route pattern -> "live" (built per request, may change every second) or "static" (the same until the data or the build changes). */
export const ENCODED_ROUTES = Object.freeze({
  "/v1/history": "live",
  "/v1/optionchain": "live",
  "/v1/instruments/search": "live",
  "/openapi.yaml": "static",
  "/v1/errors": "static",
  "/v1/brokers": "static",
  "/v1/calendar/holidays": "static",
});

/** The text types of these routes (JSON, CSV, and the YAML of the OpenAPI file). */
const TEXTUAL = /^(text\/|application\/(json|yaml|x-yaml|xml)|application\/[a-z.+-]+\+json)/i;

const strongEtag =(body) => `"${createHash("sha1").update(body).digest("base64url").slice(0, 22)}"`;

const gzipFast = (buf) =>
  new Promise((resolve, reject) => {
    gzip(buf, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out)));
  });

/** "Origin" plus "Accept-Encoding": a Vary the pipeline already set (CORS) is kept. Pure. */
export function mergeVary(base, extra) {
  const set = new Map();
  for (const part of `${base ?? ""},${extra ?? ""}`.split(",")) {
    const t = part.trim();
    if (t && !set.has(t.toLowerCase())) set.set(t.toLowerCase(), t);
  }
  return [...set.values()].join(", ");
}

/**
 * @param {{ maxCacheBytes?: number }} [opts]
 * @returns {{ encode(reply: unknown, ctx: { method: string, pattern: string, requestHeaders: Record<string, any>, baseVary?: string }): Promise<unknown> }}
 */
export function createResponseEncoder({ maxCacheBytes } = {}) {
  const cache = createCompressionCache(maxCacheBytes ? { maxBytes: maxCacheBytes } : {});
  return {
    async encode(reply, { method, pattern, requestHeaders, baseVary }) {
      const kind = ENCODED_ROUTES[pattern];
      if (!kind || (method !== "GET" && method !== "HEAD")) return reply;
      if (!(reply instanceof Reply)) reply = json(reply);
      if (reply.status !== 200) return reply;
      if (typeof reply.body !== "string" && !Buffer.isBuffer(reply.body)) return reply;
      if (reply.headers?.["Content-Encoding"] || reply.headers?.ETag) return reply;
      const type = reply.headers?.["Content-Type"] ?? "";
      const body = typeof reply.body === "string" ? Buffer.from(reply.body, "utf8") : reply.body;
      const etag = strongEtag(body);
      const squeeze = body.length >= MIN_COMPRESS_BYTES && TEXTUAL.test(type);
      const coding = squeeze ? negotiateEncoding(requestHeaders?.["accept-encoding"], kind === "static" ? undefined : ["gzip"]) : null;
      const tag = etagFor(etag, coding);
      const headers = { ...reply.headers, ETag: tag, Vary: mergeVary(baseVary, "Accept-Encoding") };
      // Only the public, static spec may be kept by a client (and then must be revalidated). Every authenticated answer stays no-store.
      if (pattern === "/openapi.yaml") headers["Cache-Control"] = "no-cache";
      if (ifNoneMatches(requestHeaders?.["if-none-match"], tag)) return new Reply(304, "", headers);
      if (!coding) return new Reply(200, reply.body, headers);
      const packed = kind === "static" ? await cache.get(`${pattern}\0${etag}`, etag, coding, () => body) : await gzipFast(body);
      return new Reply(200, packed, { ...headers, "Content-Encoding": coding });
    },
    stats: () => cache.stats(),
  };
}
