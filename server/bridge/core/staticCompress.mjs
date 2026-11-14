/**
 * Compression for the dashboard's static files: which coding a request accepts, an ETag per coding, and a small
 * bounded cache so each file is compressed ONCE per content change (never per request). No dependencies beyond
 * node:zlib. The compression runs on the libuv thread pool, so it never blocks the event loop.
 */
import { brotliCompress, constants, gzip } from "node:zlib";

/** Files smaller than this are sent as they are: the saving is smaller than the cost of the header. */
export const MIN_COMPRESS_BYTES = 1024;
/** Codings the Bridge can produce, best first (a tie in the client's preference goes to the first). */
export const CODINGS = Object.freeze(["br", "gzip"]);
/** Upper bound on the compressed bodies kept in memory. */
export const DEFAULT_CACHE_BYTES = 8 * 1024 * 1024;

/** Content types worth compressing (text formats). Images such as PNG are already compressed. */
export const isCompressible = (contentType) => /^(text\/|application\/(javascript|json|xml)|image\/svg\+xml)/i.test(String(contentType ?? ""));

/**
 * The codings an Accept-Encoding header lists, with their q values (RFC 9110 12.5.3). Names are lower-cased; a token
 * that cannot be read is ignored; a missing q is 1. `*` is kept under "*". Pure.
 * @param {string | string[] | undefined} header @returns {Map<string, number>}
 */
export function parseAcceptEncoding(header) {
  const out = new Map();
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (typeof raw !== "string") return out;
  for (const part of raw.split(",")) {
    const [name, ...params] = part.trim().split(";");
    const coding = name.trim().toLowerCase();
    if (!coding) continue;
    let q = 1;
    let valid = true;
    for (const p of params) {
      const m = /^\s*q\s*=\s*(.*?)\s*$/i.exec(p);
      if (!m) continue;
      // qvalue = ( "0" [ "." 0*3DIGIT ] ) / ( "1" [ "." 0*3("0") ] )
      if (/^(0(\.\d{0,3})?|1(\.0{0,3})?)$/.test(m[1])) q = Number(m[1]);
      else valid = false;
    }
    if (valid && !out.has(coding)) out.set(coding, q);
  }
  return out;
}

/**
 * The coding to answer with: the acceptable one with the highest q (br before gzip on a tie), or null for no
 * compression (no header, only identity, only q=0, or only codings this server does not make). Pure.
 * @param {string | string[] | undefined} header @param {readonly string[]} [supported]
 * @returns {"br" | "gzip" | null}
 */
export function negotiateEncoding(header, supported = CODINGS) {
  const accepted = parseAcceptEncoding(header);
  if (accepted.size === 0) return null;
  let best = null;
  let bestQ = 0;
  for (const coding of supported) {
    const q = accepted.has(coding) ? accepted.get(coding) : (accepted.get("*") ?? 0);
    if (q > bestQ) {
      best = coding;
      bestQ = q;
    }
  }
  return /** @type {"br" | "gzip" | null} */ (best);
}

/**
 * The strong ETag of one representation. The same file in another coding is another representation, so it gets another
 * validator: a cache can then never hand a br body to a client that asked with a gzip validator. Pure.
 * @param {string} etag  the identity ETag, quoted  @param {string | null} coding
 */
export const etagFor = (etag, coding) => (coding ? `${etag.slice(0, -1)}-${coding}"` : etag);

/**
 * Whether an If-None-Match header matches `etag` (weak comparison, as GET and HEAD use: a W/ prefix is ignored; `*`
 * matches any current representation). Pure.
 */
export function ifNoneMatches(header, etag) {
  if (typeof header !== "string" || !header) return false;
  return header.split(",").some((t) => {
    const tag = t.trim();
    return tag === "*" || tag.replace(/^W\//, "") === etag;
  });
}

/** @param {Buffer} buf @param {"br" | "gzip"} coding @returns {Promise<Buffer>} */
function compress(buf, coding) {
  return new Promise((resolve, reject) => {
    const done = (err, out) => (err ? reject(err) : resolve(out));
    if (coding === "br") {
      // Quality 9: within a few percent of the slowest setting at a tenth of the time.
      brotliCompress(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }, done);
    } else gzip(buf, { level: 9 }, done);
  });
}

/**
 * A bounded cache of compressed bodies. An entry is valid for one version of the source (its ETag), so a file edited on
 * disk is compressed again once and the old body is dropped. Callers asking at the same moment share one compression.
 * Least recently used entries go first when the byte bound is reached.
 * @param {{ maxBytes?: number, compressFn?: typeof compress }} [opts]
 */
export function createCompressionCache({ maxBytes = DEFAULT_CACHE_BYTES, compressFn = compress } = {}) {
  /** @type {Map<string, { version: string, body: Buffer }>} */
  const entries = new Map();
  /** @type {Map<string, Promise<Buffer>>} */
  const running = new Map();
  let bytes = 0;
  const drop = (key) => {
    const e = entries.get(key);
    if (!e) return;
    bytes -= e.body.length;
    entries.delete(key);
  };
  return {
    /**
     * @param {string} name  the file  @param {string} version  its ETag (changes with its content)
     * @param {"br" | "gzip"} coding  @param {() => Buffer} source  the file's bytes (called only on a miss)
     * @returns {Promise<Buffer>}
     */
    async get(name, version, coding, source) {
      const key = `${name}\0${coding}`;
      const hit = entries.get(key);
      if (hit && hit.version === version) {
        entries.delete(key); // most recently used goes last
        entries.set(key, hit);
        return hit.body;
      }
      const flight = `${key}\0${version}`;
      let p = running.get(flight);
      if (!p) {
        p = compressFn(source(), coding).finally(() => running.delete(flight));
        running.set(flight, p);
      }
      const body = await p;
      drop(key);
      if (body.length <= maxBytes) {
        entries.set(key, { version, body });
        bytes += body.length;
        while (bytes > maxBytes) drop(entries.keys().next().value);
      }
      return body;
    },
    stats: () => ({ entries: entries.size, bytes, running: running.size }),
  };
}
