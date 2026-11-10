/**
 * Idempotency-Key for the create routes that are not orders (orders keep their own store in orders/idempotencyStore.mjs).
 *
 * A repeat of a create that spends broker budget or mints a secret (a download job, a key, a recording, a webhook
 * subscription ...) would make a second one. With an `Idempotency-Key` header the pipeline (app.mjs) does this for the
 * routes in IDEMPOTENT_ROUTES, with the same rules the order routes document:
 *  - the same key and the same request again returns the stored answer with `Idempotency-Replayed: true`;
 *  - the same key with a different request (another route, query or body) is 409 IDEMPOTENCY_KEY_REUSED;
 *  - the same key while the first request is still running is 409 IDEMPOTENCY_IN_PROGRESS (retryable);
 *  - a request that failed (4xx, 5xx) is forgotten, so it can be retried with the same key.
 * Keys belong to the caller (the API key id), so two keys never see each other's answers.
 *
 * Records live in memory for 24 hours and are dropped on restart, so a retry after a restart can create again:
 * check the list route first. A stored answer for POST /v1/keys holds the new secret, which is why nothing here is
 * written to disk.
 *
 * A write route that does not honour the header answers with `Idempotency-Ignored: true` when one was sent, so a
 * client does not believe it is protected.
 */
import { createHash } from "node:crypto";
import { BridgeError } from "./errors.mjs";

/** Routes (router patterns) whose repeat would create a duplicate; they honour Idempotency-Key. Keep in sync with docs/openapi.yaml (a test checks). */
export const IDEMPOTENT_ROUTES = Object.freeze([
  "POST /v1/accounts",
  "POST /v1/keys",
  "POST /v1/hooks",
  "POST /v1/notify/targets",
  "POST /v1/collections",
  "POST /v1/collections/import",
  "POST /v1/collections/:name/duplicate",
  "POST /v1/downloads",
  "POST /v1/datasets/:name/update",
  "POST /v1/subscriptions",
  "POST /v1/recordings",
  "POST /v1/recordings/rules",
  "POST /v1/recordings/presets/:presetId/apply",
]);
const IDEMPOTENT = new Set(IDEMPOTENT_ROUTES);

/** Write routes under these prefixes handle (or deliberately need no) Idempotency-Key themselves: the order routes. */
const OWN_IDEMPOTENCY_PREFIXES = ["/v1/orders"];

const KEY_RE = /^[A-Za-z0-9_.:-]{8,255}$/;
const TTL_MS = 24 * 3600 * 1000;
const MAX_RECORDS = 2000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export const isIdempotentRoute = (method, pattern) => IDEMPOTENT.has(`${String(method).toUpperCase()} ${pattern}`);

/** Whether a write route neither honours the header nor is an order route (the pipeline then says it was ignored). */
export function ignoresIdempotencyKey(method, pattern) {
  const m = String(method).toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return false;
  if (IDEMPOTENT.has(`${m} ${pattern}`)) return false;
  return !OWN_IDEMPOTENCY_PREFIXES.some((p) => pattern === p || pattern.startsWith(`${p}/`));
}

/** The header value, validated; undefined when absent. */
export function readIdempotencyKey(headers) {
  const v = headers?.["idempotency-key"];
  if (v === undefined || v === null || v === "") return undefined;
  const s = Array.isArray(v) ? v[0] : String(v);
  if (!KEY_RE.test(s)) {
    throw new BridgeError("VALIDATION_FAILED", "Idempotency-Key must be 8-255 letters, digits or _ . : - (a UUID works).", { errors: [{ path: "Idempotency-Key", message: "must be 8-255 letters, digits or _ . : -" }] });
  }
  return s;
}

/** Stable JSON text (object keys sorted) so two spellings of one body fingerprint alike. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/** Fingerprint of a request: method, path, query (sorted) and body. */
export function fingerprint({ method, path, query, body }) {
  const q = [...(query ?? new URLSearchParams()).entries()].map(([k, v]) => `${k}=${v}`).sort().join("&");
  return createHash("sha256").update(`${String(method).toUpperCase()} ${path}?${q}\n${stable(body ?? null)}`).digest("hex");
}

/** @param {{ now?: () => number }} [opts] */
export function createWriteIdempotency({ now = () => Date.now() } = {}) {
  /** @type {Map<string, { fp: string, state: "in_progress"|"done", expiresAt: number, reply?: { status: number, body: string|Buffer, headers: Record<string,string> } }>} */
  const records = new Map();
  const prune = () => {
    const t = now();
    for (const [k, r] of records) if (r.expiresAt <= t) records.delete(k);
    while (records.size > MAX_RECORDS) records.delete(records.keys().next().value);
  };
  return {
    /**
     * Start (or replay) a write. Synchronous, so two concurrent requests with one key never both run.
     * @returns {{ replay: false, done: (reply: { status: number, body: string|Buffer, headers: Record<string,string> }) => void, release: () => void }
     *   | { replay: true, reply: { status: number, body: string|Buffer, headers: Record<string,string> } }}
     */
    begin(owner, key, fp) {
      prune();
      const id = `${owner}|${key}`;
      const r = records.get(id);
      if (r && r.expiresAt > now()) {
        if (r.fp !== fp) throw new BridgeError("IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used for a different request. Use a new key for a new request.");
        if (r.state === "in_progress") throw new BridgeError("IDEMPOTENCY_IN_PROGRESS", "The first request with this idempotency key is still running. Check the list route or retry in a moment.", { retryAfterMs: 1000 });
        return { replay: true, reply: r.reply };
      }
      const rec = { fp, state: "in_progress", expiresAt: now() + TTL_MS };
      records.set(id, rec);
      return {
        replay: false,
        done(reply) {
          const size = typeof reply.body === "string" ? reply.body.length : (reply.body?.length ?? 0);
          if (size > MAX_BODY_BYTES) return void records.delete(id);
          rec.state = "done";
          rec.reply = { status: reply.status, body: reply.body, headers: { ...reply.headers } };
        },
        release() {
          if (records.get(id) === rec) records.delete(id);
        },
      };
    },
    size: () => records.size,
  };
}
