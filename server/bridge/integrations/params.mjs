/**
 * Query-string helpers shared by the UDF and spreadsheet routes (stream S10). Every helper throws
 * VALIDATION_FAILED with a field path, so clients get the same error shape as the /v1 routes.
 */
import { BridgeError } from "../core/errors.mjs";

const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

/** VALIDATION_FAILED for one field. */
export const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });

/** Optional query value: absent or blank -> undefined, else trimmed. */
export function opt(query, name) {
  const v = query.get(name);
  if (v === null) return undefined;
  const s = v.trim();
  return s === "" ? undefined : s;
}

/** Required query value. */
export function req(query, name, example) {
  const v = opt(query, name);
  if (v === undefined) throw invalid(name, `${name} is required${example ? `, for example ${example}` : ""}.`);
  return v;
}

/** Whole number in [min, max], or undefined when absent. Negative numbers are allowed when min < 0. */
export function intParam(query, name, min, max) {
  const v = opt(query, name);
  if (v === undefined) return undefined;
  if (!/^-?\d{1,16}$/.test(v)) throw invalid(name, `${name} must be a whole number from ${min} to ${max}.`);
  const n = Number(v);
  if (n < min || n > max) throw invalid(name, `${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

/** true/false/1/0, or `dflt` when absent. */
export function boolParam(query, name, dflt) {
  const v = opt(query, name);
  if (v === undefined) return dflt;
  const s = v.toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  throw invalid(name, `${name} must be true or false.`);
}

/** One of `allowed` (case-insensitive match, returns the allowed spelling), or `dflt` when absent. */
export function enumParam(query, name, allowed, dflt) {
  const v = opt(query, name);
  if (v === undefined) return dflt;
  const hit = allowed.find((a) => a.toLowerCase() === v.toLowerCase());
  if (hit === undefined) throw invalid(name, `${name} must be one of ${allowed.join(", ")}.`);
  return hit;
}

/** Comma-separated list, trimmed, blanks dropped, at most `max` entries. */
export function listParam(query, name, max, example) {
  const raw = opt(query, name);
  const list = String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length) throw invalid(name, `${name} is required${example ? `, for example ${example}` : ""}.`);
  if (list.length > max) throw invalid(name, `Ask for at most ${max} symbols at a time.`);
  return list;
}

/**
 * Market-data read options from the query: an optional pinned `account` (checked against the key first) and
 * `maxAgeMs`. The caller's abort signal is passed through so a closed chart stops waiting for budget.
 * @param {import("../core/context.mjs").RequestContext} ctx
 * @param {{ maxAge?: boolean, autoBackup?: boolean }} [o]  autoBackup: the config default for `?backup=` (unpinned
 *   reads that no broker can answer fall back to the labelled backup data sources).
 */
export function readOptions(ctx, { maxAge = true, autoBackup = false } = {}) {
  const opts = { signal: ctx.signal, priority: "interactive" };
  const account = opt(ctx.query, "account");
  if (account !== undefined) {
    if (!ACCOUNT_RE.test(account)) throw invalid("account", "account is not a valid account id.");
    ctx.requireAccountAccess(account);
    opts.accountId = account;
  }
  if (maxAge) {
    const m = intParam(ctx.query, "maxAgeMs", 0, 3_600_000);
    if (m !== undefined) opts.maxAgeMs = m;
  }
  const b = opt(ctx.query, "backup");
  if (b !== undefined && !/^(true|false|1|0)$/i.test(b)) throw invalid("backup", "backup must be true or false.");
  const backup = b === undefined ? autoBackup : /^(true|1)$/i.test(b);
  if (backup && opts.accountId === undefined) opts.allowBackup = true;
  return opts;
}

/** The `?backup=` default from config: backup sources on, autoFallback on, not demo mode. */
export function autoBackupFromConfig(config) {
  return Boolean(config && config.demo !== true && config.backup?.enabled === true && config.backup?.autoFallback !== false);
}

/** Turn anything thrown into a BridgeError (unknown errors become INTERNAL without their message). */
export function asBridgeError(err) {
  return err instanceof BridgeError ? err : new BridgeError("INTERNAL");
}

/** Retry-After header (whole seconds) for an error that carries retryAfterMs, plus any headers the thrower set. */
export function errorHeaders(err) {
  const h = { ...(err.headers ?? {}) };
  if (err.retryAfterMs !== undefined) h["Retry-After"] = String(Math.max(1, Math.ceil(err.retryAfterMs / 1000)));
  return h;
}
