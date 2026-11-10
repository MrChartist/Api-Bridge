// A small client for the Bridge. No dependencies: Node 22 and its built-in fetch are enough.
//
// What it does for you
//   - reads BRIDGE_URL and BRIDGE_KEY from .env (or the environment) and sends the key in the Authorization header only
//   - turns an error answer (application/problem+json) into a BridgeError with code, retryable and requestId
//   - retries what is safe to retry: reads, and writes that carry an idempotency key, on 429 and temporary failures,
//     waiting as long as the Bridge says (Retry-After), at most 3 times
//   - optional(): a call that tolerates an older Bridge that does not have the route yet
import { readFileSync } from "node:fs";

/** Reads KEY=value lines of a .env file into an object (missing file: empty). The environment wins over the file. */
export function loadEnv(file = new URL("./.env", import.meta.url)) {
  const out = {};
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {
    /* no .env: the environment alone */
  }
  return { ...out, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("BRIDGE_") || k.startsWith("MCB_"))) };
}

/** An error answer from the Bridge. `code` is stable: switch on it, never on the message. */
export class BridgeError extends Error {
  constructor(problem, status) {
    super(problem.detail || problem.title || `The Bridge answered ${status}`);
    this.name = "BridgeError";
    this.status = status;
    this.code = problem.code ?? "UNKNOWN";
    this.retryable = problem.retryable === true;
    this.requestId = problem.requestId;
    this.retryAfterMs = problem.retryAfterMs;
    this.errors = problem.errors;
    this.problem = problem;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Routes a newer Bridge has and an older one answers with these codes.
const MISSING = new Set(["NOT_FOUND", "NOT_IMPLEMENTED", "METHOD_NOT_ALLOWED"]);
/** True when an error means "this Bridge does not have that route". */
export const isMissing = (err) => err instanceof BridgeError && MISSING.has(err.code);

export function createBridge({ baseUrl, key, maxRetries = 3, fetchImpl = globalThis.fetch } = {}) {
  const env = loadEnv();
  baseUrl = (baseUrl ?? env.BRIDGE_URL ?? "http://127.0.0.1:4300").replace(/\/+$/, "");
  key = key ?? env.BRIDGE_KEY ?? "";
  const authHeaders = () => {
    if (!key) throw new Error("No API key. Put BRIDGE_KEY=mcb_... in .env (make one with: mc-bridge keys create --label my-script --scope read).");
    return { Authorization: `Bearer ${key}` };
  };

  async function request(method, path, { query, body, idempotencyKey, headers = {}, raw = false, signal } = {}) {
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    // redirect: "error": a redirect could carry the Authorization header to another address
    const init = { method, signal, redirect: "error", headers: { Accept: "application/json", ...authHeaders(), ...headers } };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    if (idempotencyKey) init.headers["Idempotency-Key"] = idempotencyKey;
    // A read can always be repeated. A write only when it has an idempotency key, so a repeat can never act twice.
    const mayRetry = method === "GET" || Boolean(idempotencyKey);
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, init);
      } catch (err) {
        if (signal?.aborted) throw err;
        if (mayRetry && attempt < maxRetries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new Error(`Could not reach the Bridge at ${baseUrl}. Is it running? (${err.cause?.code ?? err.message})`);
      }
      if (raw && res.ok) return res;
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON */
      }
      if (res.ok) return { ...(json ?? {}), httpStatus: res.status, text, headers: res.headers };
      const problem = json && typeof json === "object" ? json : { title: text.slice(0, 200) };
      const err = new BridgeError(problem, res.status);
      const temporary = err.retryable || [502, 503, 504].includes(res.status);
      if (mayRetry && temporary && err.code !== "OUTCOME_UNKNOWN" && attempt < maxRetries) {
        const header = Number(res.headers.get("retry-after"));
        await sleep(err.retryAfterMs ?? (header > 0 ? header * 1000 : backoff(attempt)));
        continue;
      }
      throw err;
    }
  }

  return {
    baseUrl,
    request,
    get: (path, query, opts) => request("GET", path, { query, ...opts }),
    post: (path, body, opts) => request("POST", path, { body, ...opts }),
    /**
     * A call that tolerates an older Bridge. Returns { available: true, ...answer } or { available: false, reason }
     * when this Bridge does not have the route (it answers NOT_FOUND, NOT_IMPLEMENTED or METHOD_NOT_ALLOWED).
     */
    async optional(method, path, opts) {
      try {
        return { available: true, ...(await request(method, path, opts)) };
      } catch (err) {
        if (isMissing(err)) return { available: false, reason: "This Bridge does not have this feature yet. Update the Bridge and restart it." };
        throw err;
      }
    },
    /** Server-sent events as an async iterator of { id, event, data }. The caller ends it with `signal`. */
    async *events(path, { query, signal } = {}) {
      const res = await request("GET", path, { query, raw: true, headers: { Accept: "text/event-stream" }, signal });
      const decoder = new TextDecoder();
      let buf = "";
      let cur = {};
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (line === "") {
            if (cur.data !== undefined) yield { id: cur.id, event: cur.event ?? "message", data: cur.data };
            cur = {};
          } else if (!line.startsWith(":")) {
            const i = line.indexOf(":");
            const field = i < 0 ? line : line.slice(0, i);
            const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
            cur[field] = field === "data" && cur.data !== undefined ? `${cur.data}\n${value}` : value;
          }
        }
      }
    },
  };
}

/** Wait 0.5 s, 1 s, 2 s ... with some randomness, so many scripts do not come back in the same moment. */
function backoff(attempt) {
  return 500 * 2 ** attempt * (0.75 + Math.random() * 0.5);
}

/** Print an error the way a person needs it: what happened, the code, and the request id to quote. */
export function explain(err) {
  if (err instanceof BridgeError) {
    const lines = [`${err.code}: ${err.message}`];
    for (const e of err.errors ?? []) lines.push(`  - ${e.path}: ${e.message}`);
    if (err.code === "UNAUTHENTICATED") lines.push("  Check BRIDGE_KEY in .env (a key is shown once; make a new one if it was lost).");
    if (err.code === "SCOPE_REQUIRED") lines.push("  This key may not do that. Make a key with the scope the route needs (see Developers in the dashboard).");
    if (err.requestId) lines.push(`  request id: ${err.requestId}`);
    return lines.join("\n");
  }
  return String(err?.message ?? err);
}
