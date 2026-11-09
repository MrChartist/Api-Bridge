import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MIN_COMPRESS_BYTES, createCompressionCache, etagFor, ifNoneMatches, isCompressible, negotiateEncoding, parseAcceptEncoding } from "./staticCompress.mjs";

describe("Accept-Encoding negotiation", () => {
  it("prefers br, then gzip, when the client takes both equally", () => {
    expect(negotiateEncoding("gzip, deflate, br")).toBe("br");
    expect(negotiateEncoding("br, gzip")).toBe("br");
    expect(negotiateEncoding("gzip, deflate")).toBe("gzip");
    expect(negotiateEncoding("br")).toBe("br");
  });

  it("follows the client's q values", () => {
    expect(negotiateEncoding("br;q=0.5, gzip;q=0.9")).toBe("gzip");
    expect(negotiateEncoding("gzip;q=1, br;q=0.001")).toBe("gzip");
    expect(negotiateEncoding("br;q=0.8, gzip;q=0.8")).toBe("br");
  });

  it("q=0 means not acceptable", () => {
    expect(negotiateEncoding("br;q=0, gzip")).toBe("gzip");
    expect(negotiateEncoding("br;q=0, gzip;q=0")).toBeNull();
    expect(negotiateEncoding("gzip;q=0.0, br;q=0.000")).toBeNull();
  });

  it("sends nothing compressed when the header is missing, empty, identity-only or unknown", () => {
    expect(negotiateEncoding(undefined)).toBeNull();
    expect(negotiateEncoding("")).toBeNull();
    expect(negotiateEncoding("identity")).toBeNull();
    expect(negotiateEncoding("deflate, compress, zstd")).toBeNull();
    expect(negotiateEncoding("x-unknown;q=1")).toBeNull();
  });

  it("reads * as every coding not listed", () => {
    expect(negotiateEncoding("*")).toBe("br");
    expect(negotiateEncoding("gzip;q=0.5, *;q=0.1")).toBe("gzip");
    expect(negotiateEncoding("br;q=0, *;q=0.5")).toBe("gzip");
    expect(negotiateEncoding("*;q=0")).toBeNull();
  });

  it("ignores case, spaces, repeated names and malformed q values", () => {
    expect(negotiateEncoding("  GZip ;  Q=0.7 , BR;q=0.2 ")).toBe("gzip");
    expect(negotiateEncoding("gzip;q=abc, br")).toBe("br");
    expect(negotiateEncoding("gzip;q=2")).toBeNull();
    expect(negotiateEncoding("gzip;q=1.0001")).toBeNull();
    expect([...parseAcceptEncoding("gzip;q=0, gzip;q=1")]).toEqual([["gzip", 0]]);
    expect(negotiateEncoding(["gzip", "br;q=0.1"])).toBe("gzip");
  });
});

describe("ETags per coding", () => {
  it("each coding is its own strong validator", () => {
    const e = '"abc123"';
    expect(etagFor(e, null)).toBe(e);
    expect(etagFor(e, "br")).toBe('"abc123-br"');
    expect(etagFor(e, "gzip")).toBe('"abc123-gzip"');
    expect(new Set([etagFor(e, null), etagFor(e, "br"), etagFor(e, "gzip")]).size).toBe(3);
  });

  it("If-None-Match: exact, listed, weak-prefixed and * match; another representation does not", () => {
    const br = '"abc-br"';
    expect(ifNoneMatches('"abc-br"', br)).toBe(true);
    expect(ifNoneMatches('"x", "abc-br"', br)).toBe(true);
    expect(ifNoneMatches('W/"abc-br"', br)).toBe(true);
    expect(ifNoneMatches("*", br)).toBe(true);
    expect(ifNoneMatches('"abc"', br)).toBe(false);
    expect(ifNoneMatches('"abc-gzip"', br)).toBe(false);
    expect(ifNoneMatches("", br)).toBe(false);
    expect(ifNoneMatches(undefined, br)).toBe(false);
  });
});

describe("what is compressed", () => {
  it("text formats yes, images no", () => {
    for (const t of ["text/html; charset=utf-8", "text/javascript; charset=utf-8", "text/css; charset=utf-8", "image/svg+xml", "application/json"]) expect(isCompressible(t), t).toBe(true);
    for (const t of ["image/png", "image/jpeg", "image/webp", "font/woff2", "application/octet-stream", undefined]) expect(isCompressible(t), String(t)).toBe(false);
    expect(MIN_COMPRESS_BYTES).toBeGreaterThanOrEqual(512);
  });
});

describe("compression cache", () => {
  const text = Buffer.from("const answer = 42;\n".repeat(400));
  const counting = () => {
    const calls = [];
    const fn = async (buf, coding) => {
      calls.push(coding);
      return Buffer.from(`${coding}:${buf.length}`);
    };
    return { calls, fn };
  };

  it("round-trips real br and gzip", async () => {
    const cache = createCompressionCache();
    const br = await cache.get("a.js", "v1", "br", () => text);
    const gz = await cache.get("a.js", "v1", "gzip", () => text);
    expect(brotliDecompressSync(br).equals(text)).toBe(true);
    expect(gunzipSync(gz).equals(text)).toBe(true);
    expect(br.length).toBeLessThan(text.length / 5);
  });

  it("compresses a version once, however many ask, and again only when the content changes", async () => {
    const { calls, fn } = counting();
    const cache = createCompressionCache({ compressFn: fn });
    const src = () => text;
    await Promise.all([cache.get("a.js", "v1", "br", src), cache.get("a.js", "v1", "br", src), cache.get("a.js", "v1", "br", src)]);
    await cache.get("a.js", "v1", "br", src);
    expect(calls).toEqual(["br"]);
    await cache.get("a.js", "v1", "gzip", src);
    expect(calls).toEqual(["br", "gzip"]);
    await cache.get("a.js", "v2", "br", src);
    expect(calls).toEqual(["br", "gzip", "br"]);
    expect(cache.stats().entries).toBe(2);
    expect(cache.stats().running).toBe(0);
  });

  it("never reads the source on a hit", async () => {
    const { fn } = counting();
    const cache = createCompressionCache({ compressFn: fn });
    await cache.get("a.js", "v1", "br", () => text);
    let read = 0;
    await cache.get("a.js", "v1", "br", () => (read++, text));
    expect(read).toBe(0);
  });

  it("stays under its byte bound, dropping the least recently used first", async () => {
    const fn = async () => Buffer.alloc(40);
    const cache = createCompressionCache({ maxBytes: 100, compressFn: fn });
    await cache.get("a", "v", "br", () => text);
    await cache.get("b", "v", "br", () => text);
    await cache.get("a", "v", "br", () => text); // a is now the most recent
    await cache.get("c", "v", "br", () => text); // 120 > 100: b goes
    expect(cache.stats()).toMatchObject({ entries: 2, bytes: 80 });
    let recompressed = 0;
    const counted = createCompressionCache({ maxBytes: 100, compressFn: async () => (recompressed++, Buffer.alloc(40)) });
    for (const n of ["a", "b", "a", "c", "a"]) await counted.get(n, "v", "br", () => text);
    expect(recompressed).toBe(3); // a, b, c once each; a stayed
  });

  it("an entry bigger than the whole bound is served but not kept", async () => {
    const cache = createCompressionCache({ maxBytes: 10, compressFn: async () => Buffer.alloc(50) });
    expect((await cache.get("big", "v", "gzip", () => text)).length).toBe(50);
    expect(cache.stats()).toMatchObject({ entries: 0, bytes: 0 });
  });

  it("a failed compression is not cached and does not wedge the next ask", async () => {
    let n = 0;
    const cache = createCompressionCache({
      compressFn: async () => {
        if (n++ === 0) throw new Error("boom");
        return Buffer.from("ok");
      },
    });
    await expect(cache.get("a", "v", "br", () => text)).rejects.toThrow("boom");
    expect((await cache.get("a", "v", "br", () => text)).toString()).toBe("ok");
    expect(cache.stats().running).toBe(0);
  });
});
