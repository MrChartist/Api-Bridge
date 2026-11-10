/**
 * What may leave the Bridge in an event. The bus payloads are already meant to be safe to log, but an event goes to other
 * programs, so this is a second, stricter pass that fails closed:
 *
 *  - a field whose NAME looks like a secret, a token, a signature, a key, a password or an approval (confirm...) is dropped,
 *    at any depth (not masked: the field is simply not there);
 *  - a string VALUE that looks like a Bridge key, a bearer token, a JWT or an order-approval token is masked;
 *  - depth, array length and string length are capped, and data above `maxBytes` is replaced by a short note.
 *
 * Events are read-only notifications: nothing in an event is a credential, and nothing a receiver sends back is read.
 */
import { redact } from "../core/logger.mjs";

// Not the logger's list: that one masks a field called "session", which account.status needs ("connected", "expired").
const FORBIDDEN_NAME_RE = /secret|token|password|passwd|passphrase|authori[sz]ation|cookie|api[-_]?key|access[-_]?key|private|credential|signature|hmac|bearer|master[-_]?key|confirm(?!ed)|approv|^(key|k|pin|otp|totp)$/i;
const MAX_DEPTH = 5;
const MAX_ARRAY = 50;
const MAX_STRING = 500;
const VALUE_RE = [
  /mcb_[A-Za-z0-9_-]{8,}/g, // Bridge keys and stream tokens
  /mct_[A-Za-z0-9_-]{8,}/g, // order-approval tokens
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
  /mcbctl_[A-Za-z0-9_-]{8,}/g, // the control token of this computer
  /whsec_[A-Za-z0-9_-]{8,}/g, // a webhook signing secret
  /https?:\/\/hooks\.slack\.com\/services\/\S+/gi, // a chat webhook URL is a credential
  /\/hooks\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]{16,}/g, // the ingest path of a Bridge hook: its last part is the secret
  /\b(?:x-api-key|x-auth-token|authorization)\s*[:=]\s*\S{8,}/gi, // a header copied into an error text
  /\b(?:access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|client[_-]?secret|secret|token|password|passwd|signature|sig)=[^\s&"',;]{6,}/gi, // key=value pairs in a URL or a message
  /\b(?:token|key|secret)\s+[A-Za-z0-9_-]{4,}:[A-Za-z0-9._~+/=-]{8,}/gi, // "token <id>:<secret>"
];
const MASK = "[removed]";
const TEXT_FIELD_RE = /^(message|error|reason|detail|note|description)$/i;

/** True when a field must never appear in an event. */
export const isForbiddenField = (name) => FORBIDDEN_NAME_RE.test(String(name));

function scrub(s) {
  let out = s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…` : s;
  for (const re of VALUE_RE) out = out.replace(re, MASK);
  return out;
}

function walk(v, depth, seen) {
  if (typeof v === "string") return scrub(v);
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return v.toString();
  if (typeof v !== "object" || typeof v === "function") return undefined;
  if (seen.has(v)) return undefined;
  if (depth >= MAX_DEPTH) return undefined;
  seen.add(v);
  if (Array.isArray(v)) return v.slice(0, MAX_ARRAY).map((x) => walk(x, depth + 1, seen)).filter((x) => x !== undefined);
  if (v instanceof Error) return { message: scrub(String(v.message ?? "")) };
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (isForbiddenField(k)) continue;
    // Free text that carries an upstream error body (download.failed.message comes from a broker): the logger's own value
    // patterns run on top of this module's, so a pattern added there protects events too.
    const w = TEXT_FIELD_RE.test(k) && typeof x === "string" ? scrub(String(redact(x))) : walk(x, depth + 1, seen);
    if (w !== undefined) out[k] = w;
  }
  return out;
}

/**
 * @param {unknown} payload  the bus payload
 * @param {{ maxBytes?: number }} [opts]
 * @returns {object}  a plain JSON-safe object
 */
export function sanitizePayload(payload, { maxBytes = 16_384 } = {}) {
  const data = walk(payload, 0, new WeakSet());
  const obj = data && typeof data === "object" && !Array.isArray(data) ? data : data === undefined || data === null ? {} : { value: data };
  const text = JSON.stringify(obj);
  if (Buffer.byteLength(text) > maxBytes) return { truncated: true, note: "This event was too large to carry. Read it from the Bridge's REST routes.", bytes: Buffer.byteLength(text) };
  return obj;
}

/** Mask anything key-like in free text (error messages that go to a log or a delivery record). */
export const scrubText = (s) => redact(String(s ?? "")).toString().slice(0, 300);
