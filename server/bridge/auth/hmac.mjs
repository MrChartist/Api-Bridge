/**
 * HMAC request signatures for webhooks and other signed callers, used by the webhook (hooks) module.
 *
 * Header format (Stripe-style, so it is familiar to script authors):
 *
 *   X-MCB-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>." + rawBody)>
 *
 * - The signed payload is the decimal timestamp, a full stop, then the EXACT raw request bytes. Never re-serialise
 *   parsed JSON before verifying: key order and whitespace would change the bytes.
 * - Several `v1=` entries may be present (a sender rotating its secret); the request passes if any one matches.
 *   Likewise verify() accepts an array of secrets on the receiving side.
 * - A request is accepted only when |now - t| <= toleranceS (default 300 s) AND its (t, signature) pair has not been
 *   seen before inside that window (replay cache). Pairs are remembered only after a signature verifies, so junk
 *   traffic cannot fill the cache with entries an attacker chooses.
 * - Comparison is constant time (crypto.timingSafeEqual on equal-length buffers).
 *
 * verify() never throws for a bad request: it returns { ok: false, reason } so the caller (hooks) decides the HTTP
 * answer (normally 401 UNAUTHENTICATED with a generic message; the reason is for the audit log and debug logs).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "X-MCB-Signature";
export const SIGNATURE_VERSION = "v1";
export const DEFAULT_TOLERANCE_S = 300;
/** Shortest secret sign() accepts (bytes). hooks should generate 32 random bytes. */
export const MIN_SECRET_BYTES = 16;
const MAX_HEADER_LENGTH = 1024;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * @typedef {"missing_header"|"malformed_header"|"no_secret"|"timestamp_out_of_range"|"signature_mismatch"|"replayed"|"replay_cache_full"} VerifyFailure
 * @typedef {{ ok: true, timestamp: number } | { ok: false, reason: VerifyFailure }} VerifyResult
 */

/** @param {string | Buffer | Uint8Array} b */
function toBuffer(b) {
  if (Buffer.isBuffer(b)) return b;
  if (b instanceof Uint8Array) return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (typeof b === "string") return Buffer.from(b, "utf8");
  if (b === undefined || b === null) return Buffer.alloc(0);
  throw new TypeError("rawBody must be a Buffer, Uint8Array or string");
}

/**
 * Hex HMAC-SHA256 over "<timestamp>." + rawBody.
 * @param {string | Buffer} secret
 * @param {number} timestamp  Unix seconds (integer).
 * @param {string | Buffer | Uint8Array} rawBody
 * @returns {string} 64 lowercase hex characters
 */
export function computeSignature(secret, timestamp, rawBody) {
  return createHmac("sha256", toBuffer(secret))
    .update(`${timestamp}.`, "utf8")
    .update(toBuffer(rawBody))
    .digest("hex");
}

/**
 * Build an X-MCB-Signature header value. For senders (SDKs, tests, the Bridge's own outbound callbacks).
 * @param {string | Buffer} secret  At least MIN_SECRET_BYTES bytes.
 * @param {number} timestamp        Unix seconds; pass Math.floor(Date.now() / 1000).
 * @param {string | Buffer | Uint8Array} rawBody
 * @returns {string} e.g. "t=1760781234,v1=5f2b…"
 */
export function sign(secret, timestamp, rawBody) {
  const key = toBuffer(secret);
  if (key.length < MIN_SECRET_BYTES) throw new RangeError(`HMAC secret must be at least ${MIN_SECRET_BYTES} bytes`);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new RangeError("timestamp must be a non-negative integer of Unix seconds");
  return `t=${timestamp},${SIGNATURE_VERSION}=${computeSignature(key, timestamp, rawBody)}`;
}

/**
 * Parse a signature header. Unknown fields (future versions) are ignored; exactly one `t` is required.
 * @param {string | undefined | null} header
 * @returns {{ timestamp: number, signatures: string[] } | null}
 */
export function parseSignatureHeader(header) {
  if (typeof header !== "string" || header.length === 0 || header.length > MAX_HEADER_LENGTH) return null;
  let timestamp = null;
  const signatures = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) return null;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") {
      if (timestamp !== null || !/^\d{1,12}$/.test(v)) return null;
      timestamp = Number(v);
    } else if (k === SIGNATURE_VERSION) {
      const hex = v.toLowerCase();
      if (!HEX64.test(hex)) return null;
      if (signatures.length < 8) signatures.push(hex);
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/**
 * In-memory replay cache: remembers verified (timestamp, signature) pairs until they could no longer pass the
 * timestamp window anyway. Bounded. When it is full of unexpired entries it FAILS CLOSED by default
 * (onFull "refuse"): a new signature is refused (checkAndAdd returns "full") rather than evicting a pair that could
 * then be replayed inside the window, which matters on an order path. Size it from the expected signal rate x the
 * timestamp window. onFull "evict" keeps the old behaviour (drop the entries closest to expiry).
 *
 * @param {{ max?: number, now?: () => number, onFull?: "refuse" | "evict" }} [opts]  now in milliseconds.
 */
export function createReplayCache({ max = 10_000, now = () => Date.now(), onFull = "refuse" } = {}) {
  /** @type {Map<string, number>} id -> expiresAtMs (insertion order ~ expiry order for a fixed window) */
  const entries = new Map();
  const sweep = () => {
    const t = now();
    for (const [id, exp] of entries) {
      if (exp <= t) entries.delete(id);
    }
  };
  return {
    /**
     * Record `id` unless it is already present and unexpired.
     * @param {string} id
     * @param {number} expiresAtMs
     * @returns {boolean | "full"} true when the id is fresh (first sighting), false for a replay, "full" when the
     *   cache is full of unexpired entries and onFull is "refuse" (the request must be refused)
     */
    checkAndAdd(id, expiresAtMs) {
      const t = now();
      const prev = entries.get(id);
      if (prev !== undefined && prev > t) return false;
      if (entries.size >= max) sweep();
      if (entries.size >= max && onFull === "refuse") return "full";
      while (entries.size >= max) entries.delete(entries.keys().next().value);
      entries.set(id, expiresAtMs);
      return true;
    },
    /** Number of remembered pairs (after dropping expired ones). */
    size() {
      sweep();
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}

/**
 * Verify an X-MCB-Signature header.
 * @param {string | undefined | null} header
 * @param {string | Buffer | Array<string | Buffer>} secret  One secret, or several during rotation.
 * @param {string | Buffer | Uint8Array} rawBody            Exact bytes received.
 * @param {{ now?: number, toleranceS?: number, seen?: { checkAndAdd(id: string, expiresAtMs: number): boolean } }} [opts]
 *   now: milliseconds (default Date.now()). seen: a replay cache from createReplayCache(); strongly recommended, and
 *   hooks must pass one per hook (or one shared cache — ids include the signature, which is secret-specific).
 * @returns {VerifyResult}
 */
export function verify(header, secret, rawBody, { now = Date.now(), toleranceS = DEFAULT_TOLERANCE_S, seen } = {}) {
  if (header === undefined || header === null || header === "") return { ok: false, reason: "missing_header" };
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: "malformed_header" };
  const secrets = (Array.isArray(secret) ? secret : [secret]).map((s) => (s === undefined || s === null ? Buffer.alloc(0) : toBuffer(s))).filter((s) => s.length > 0);
  if (secrets.length === 0) return { ok: false, reason: "no_secret" };
  const nowS = now / 1000;
  if (!(Math.abs(nowS - parsed.timestamp) <= toleranceS)) return { ok: false, reason: "timestamp_out_of_range" };

  const body = toBuffer(rawBody);
  let matched = null;
  // Check every (secret, signature) pair without early exit so timing does not reveal which one matched.
  for (const s of secrets) {
    const expected = Buffer.from(computeSignature(s, parsed.timestamp, body), "hex");
    for (const sig of parsed.signatures) {
      const given = Buffer.from(sig, "hex");
      if (given.length === expected.length && timingSafeEqual(given, expected) && matched === null) matched = sig;
    }
  }
  if (matched === null) return { ok: false, reason: "signature_mismatch" };
  if (seen) {
    const fresh = seen.checkAndAdd(`${parsed.timestamp}.${matched}`, (parsed.timestamp + toleranceS) * 1000 + 1000);
    if (fresh === "full") return { ok: false, reason: "replay_cache_full" };
    if (!fresh) return { ok: false, reason: "replayed" };
  }
  return { ok: true, timestamp: parsed.timestamp };
}
