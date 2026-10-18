/**
 * Structured, redacting logger. One JSON object per line (stderr by default, so `mc-bridge mcp` can keep stdout
 * for the MCP protocol).
 *
 * Redaction is on by default and cannot be switched off:
 *  - any field whose NAME looks secret (password, pin, totp, token, secret, authorization, apiKey, cookie, ...)
 *    is replaced with "[redacted]", at any depth;
 *  - any string VALUE that looks like a Bridge key (mcb_...), a bearer token or a JWT is masked;
 *  - exact values registered with addSecret() (decrypted broker tokens, the master key) are masked wherever they appear.
 * Never log request bodies of credential or order endpoints wholesale; log ids and decisions.
 */
import { isForbiddenSecretKey } from "../../brokers/contract.mjs";

export const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });
export const REDACTED = "[redacted]";

const SECRET_NAME_RE = /secret|token|authori[sz]ation|cookie|api[-_]?key|apikey|access[-_]?key|private|credential|signature|^session$|session[-_]?(token|id|key)|master[-_]?key|bearer|^key$|^k$/i;
const VALUE_PATTERNS = [
  /mcb_[A-Za-z0-9_-]{8,}/g, // Bridge API keys and stream tokens
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, // JWT
];
const MAX_DEPTH = 6;
const MAX_STRING = 2000;

/** True when a field name must never be logged with its value. */
export function isSecretFieldName(name) {
  const n = String(name ?? "");
  return SECRET_NAME_RE.test(n) || isForbiddenSecretKey(n);
}

/**
 * Deep-copy `value` with secrets removed. Pure apart from reading `exactSecrets`.
 * @param {unknown} value
 * @param {Iterable<string>} [exactSecrets]
 */
export function redact(value, exactSecrets = []) {
  const exact = [...exactSecrets].filter((s) => typeof s === "string" && s.length >= 6);
  const seen = new WeakSet();
  const scrubString = (s) => {
    let out = s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…` : s;
    for (const secret of exact) out = out.split(secret).join(REDACTED);
    for (const re of VALUE_PATTERNS) out = out.replace(re, (m, scheme) => (typeof scheme === "string" && /^(bearer|basic)$/i.test(scheme) ? `${scheme} ${REDACTED}` : REDACTED));
    return out;
  };
  const walk = (v, depth) => {
    if (typeof v === "string") return scrubString(v);
    if (v === null || typeof v !== "object") return typeof v === "bigint" ? v.toString() : v;
    if (v instanceof Error) return { name: v.name, message: scrubString(String(v.message ?? "")), code: v.code };
    if (seen.has(v)) return "[circular]";
    if (depth >= MAX_DEPTH) return "[depth]";
    seen.add(v);
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => walk(x, depth + 1));
    if (Buffer.isBuffer(v)) return `[buffer ${v.length} bytes]`;
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = isSecretFieldName(k) && x !== null && x !== undefined && x !== "" ? REDACTED : walk(x, depth + 1);
    return out;
  };
  return walk(value, 0);
}

/**
 * @typedef {{ debug(msg: string, fields?: object): void, info(msg: string, fields?: object): void,
 *   warn(msg: string, fields?: object): void, error(msg: string, fields?: object): void,
 *   child(bindings: object): Logger, addSecret(value: string): void, redact(value: unknown): any, level: string }} Logger
 */

/**
 * @param {{ level?: keyof LEVELS, write?: (line: string) => void, bindings?: object, now?: () => number }} [opts]
 * @returns {Logger}
 */
export function createLogger({ level = "info", write, bindings = {}, now = () => Date.now() } = {}) {
  const secrets = new Set();
  const sink = write ?? ((line) => process.stderr.write(line + "\n"));
  const threshold = LEVELS[level] ?? LEVELS.info;
  const make = (base) => {
    const emit = (lvl, msg, fields) => {
      if (LEVELS[lvl] < threshold) return;
      const record = redact({ ...base, ...(fields ?? {}) }, secrets);
      const line = { t: new Date(now()).toISOString(), level: lvl, msg: redact(String(msg ?? ""), secrets), ...record };
      try {
        sink(JSON.stringify(line));
      } catch {
        // A broken sink must never take a request down.
      }
    };
    return {
      level,
      debug: (m, f) => emit("debug", m, f),
      info: (m, f) => emit("info", m, f),
      warn: (m, f) => emit("warn", m, f),
      error: (m, f) => emit("error", m, f),
      child: (more) => make({ ...base, ...more }),
      addSecret: (value) => {
        if (typeof value === "string" && value.length >= 6) secrets.add(value);
      },
      /** redact() bound to the exact secrets registered with addSecret (the audit log uses it). */
      redact: (value) => redact(value, secrets),
    };
  };
  return make(bindings);
}

/** A logger that drops everything (tests, `--quiet`). */
export function createNullLogger() {
  return createLogger({ level: "silent", write: () => {} });
}
