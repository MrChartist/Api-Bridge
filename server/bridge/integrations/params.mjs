/**
 * Query-string helpers for the spreadsheet and AmiBroker routes. Every helper throws
 * VALIDATION_FAILED with a field path, so clients get the same error shape as the /v1 routes.
 */
import { BridgeError } from "../core/errors.mjs";
import { allowedAccountsFor } from "../market/routes.mjs";

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

/**
 * Market-data read options from the query: an optional pinned `account` (checked against the key first) and
 * `maxAgeMs`. The caller's abort signal is passed through so a closed client stops waiting for budget.
 * @param {import("../core/context.mjs").RequestContext} ctx
 * @param {{ maxAge?: boolean }} [o]
 *
 * These routes never use a backup data source. Their answers are a bare number or a fixed table that has no field
 * for how current a value is (an Excel WEBSERVICE call cannot even see headers), so a delayed or end-of-day value would
 * pass for a live one. `?backup=false` is accepted (it is what they do anyway); `?backup=true` is refused with a message.
 * Use the /v1 routes, which label every answer, when a backup source is wanted.
 */
export function readOptions(ctx, { maxAge = true } = {}) {
  const opts = { signal: ctx.signal, priority: "interactive" };
  // Unpinned reads stay inside the key's account list: a key limited to one account never borrows another's
  // market-data entitlement or rate budget.
  const allowed = allowedAccountsFor(ctx);
  if (allowed) opts.allowedAccounts = allowed;
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
  if (b !== undefined && /^(true|1)$/i.test(b)) throw invalid("backup", "backup sources are not available on the spreadsheet and AmiBroker routes: their answers cannot say how current a value is. Use the /v1 routes for a labelled backup answer.");
  opts.allowBackup = false;
  return opts;
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
