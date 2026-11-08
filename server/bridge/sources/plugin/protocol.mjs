/**
 * Protocol `bridge-source/1`: newline-delimited JSON between the Bridge (host) and a plugin process (child) over
 * stdin and stdout. One message per line, UTF-8, every message an object with a `type`.
 *
 *   host -> child   hello, init, call, cancel, fetchResult, ping, shutdown
 *   child -> host   ready, result, error, log, fetch, pong
 *
 * Everything that comes from the child is untrusted: it is size-capped, parsed once, stripped of dangerous keys, and
 * checked against a strict schema before the host acts on it. A message that fails any step is a protocol violation.
 */
import { z } from "zod";
import { API_VERSION } from "./manifest.mjs";

export const PROTOCOL = "bridge-source/1";
/** Longest single line the host accepts from a child. */
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export const MAX_JSON_DEPTH = 12;
export const MAX_JSON_NODES = 200_000;

/** Plugin error codes, and what each maps to in the Bridge's own taxonomy (docs/source-contract.md). */
export const PLUGIN_ERROR_CODES = Object.freeze({
  RATE_LIMITED: "UPSTREAM_RATE_LIMITED",
  UNAVAILABLE: "BROKER_UNAVAILABLE",
  TIMEOUT: "UPSTREAM_TIMEOUT",
  BAD_RESPONSE: "UPSTREAM_ERROR",
  NOT_FOUND: "SYMBOL_NOT_FOUND",
  UNSUPPORTED: "CAPABILITY_UNSUPPORTED",
  AUTH: "UPSTREAM_ERROR",
  CANCELLED: "UPSTREAM_ERROR",
  INTERNAL: "UPSTREAM_ERROR",
});

/** What the host asks of a plugin. */
export const METHODS = Object.freeze(["quotes", "history", "expiries", "optionChain", "test"]);

const id = z.number().int().min(1).max(2 ** 31 - 1);
const FETCH_INIT = z
  .object({
    method: z.string().max(10).optional(),
    headers: z.record(z.string().max(100), z.string().max(2000)).optional(),
    body: z.string().max(64 * 1024).optional(),
  })
  .strict();

const childMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), apiVersion: z.number().int(), capabilities: z.array(z.string().max(40)).max(10) }).strict(),
  z.object({ type: z.literal("result"), id, data: z.unknown() }).strict(),
  z.object({ type: z.literal("error"), id, code: z.string().max(40), message: z.string().max(500).optional(), retryAfterMs: z.number().int().min(0).max(3_600_000).optional() }).strict(),
  z.object({ type: z.literal("log"), level: z.enum(["debug", "info", "warn", "error"]), msg: z.string().max(1000) }).strict(),
  z.object({ type: z.literal("fetch"), id, url: z.string().max(2048), init: FETCH_INIT.optional() }).strict(),
  z.object({ type: z.literal("pong"), id }).strict(),
]);

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Deep copy of parsed JSON into plain objects: drops `__proto__`, `constructor` and `prototype` keys, refuses nesting
 * deeper than MAX_JSON_DEPTH or more than MAX_JSON_NODES values. Throws on a violation.
 */
export function sanitizeJson(value) {
  let nodes = 0;
  const walk = (v, depth) => {
    if (++nodes > MAX_JSON_NODES) throw new Error("too many values");
    if (v === null || typeof v !== "object") return v;
    if (depth >= MAX_JSON_DEPTH) throw new Error("nested too deeply");
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out = {};
    for (const k of Object.keys(v)) if (!DANGEROUS_KEYS.has(k)) out[k] = walk(v[k], depth + 1);
    return out;
  };
  return walk(value, 0);
}

/**
 * Parse and validate one line from the child.
 * @param {string} line
 * @returns {{ ok: true, msg: any } | { ok: false, error: string }}
 */
export function parseChildMessage(line) {
  if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) return { ok: false, error: "message too large" };
  let json;
  try {
    json = JSON.parse(line);
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return { ok: false, error: "message is not an object" };
  let clean;
  try {
    clean = sanitizeJson(json);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const r = childMessage.safeParse(clean);
  if (!r.success) return { ok: false, error: `invalid ${typeof clean.type === "string" ? clean.type.slice(0, 20) : "message"}: ${r.error.issues[0]?.path.join(".") || "shape"} ${r.error.issues[0]?.message ?? ""}`.trim() };
  return { ok: true, msg: r.data };
}

/**
 * Splits a byte stream into lines without ever holding more than MAX_MESSAGE_BYTES (plus one chunk) for a line that has
 * not ended. `push` returns events: `{ line }` for each complete line, `{ error }` once when a line is too long (the host
 * kills the child; the decoder then discards everything it still holds).
 */
export class LineDecoder {
  constructor(maxBytes = MAX_MESSAGE_BYTES) {
    this.max = maxBytes;
    this.buf = Buffer.alloc(0);
    this.dead = false;
  }

  /** @param {Buffer|string} chunk @returns {Array<{ line: string } | { error: string }>} */
  push(chunk) {
    if (this.dead) return [];
    const events = [];
    this.buf = this.buf.length ? Buffer.concat([this.buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]) : Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    for (;;) {
      const nl = this.buf.indexOf(10, start);
      if (nl === -1) break;
      if (nl - start > this.max) {
        this.dead = true;
        this.buf = Buffer.alloc(0);
        return [...events, { error: "message too large" }];
      }
      const line = this.buf.toString("utf8", start, nl).replace(/\r$/, "");
      start = nl + 1;
      if (line.length) events.push({ line });
    }
    this.buf = this.buf.subarray(start);
    if (this.buf.length > this.max) {
      this.dead = true;
      this.buf = Buffer.alloc(0);
      events.push({ error: "message too large" });
    }
    return events;
  }
}

/** Serialise a host-to-child message as one line. */
export const encode = (msg) => `${JSON.stringify(msg)}\n`;

export const hello = (hostVersion) => encode({ type: "hello", protocol: PROTOCOL, apiVersion: API_VERSION, hostVersion, features: ["fetch", "cancel", "ping"] });
export const init = (config, secrets) => encode({ type: "init", config, secrets });
export const call = (callId, method, params, deadlineMs, now) => encode({ type: "call", id: callId, method, params, deadlineMs, now });
export const cancel = (callId) => encode({ type: "cancel", id: callId });
export const ping = (pingId) => encode({ type: "ping", id: pingId });
export const shutdown = () => encode({ type: "shutdown" });
export const fetchOk = (fetchId, status, headers, body) => encode({ type: "fetchResult", id: fetchId, ok: true, status, headers, body });
export const fetchFail = (fetchId, code, message, retryAfterMs) => encode({ type: "fetchResult", id: fetchId, ok: false, code, message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
