/**
 * Pure helpers for broker sessions (stream S1): input validation for connect(), session expiry times, and the
 * state derived from a stored SecretStore record. Nothing here does I/O, keeps state or touches a secret value
 * beyond checking its shape, so every rule is unit-testable with plain objects.
 *
 * A stored record ("account:<id>" in SecretStore) looks like:
 *   { values: Record<string,string>,         saved credentialFields only (API key, client id, access token ...)
 *     session: Record<string,string> | null, sessionLogin brokers: ONLY the adapter's declared auth.sessionFields
 *     sessionExpiresAt: number | null,       epoch ms; null = no known daily expiry (apiKeyToken)
 *     connectedAt: string,                   ISO time of the connect that wrote it (also the record's "stamp")
 *     disconnectedAt?: string }              set by disconnect(); the saved keys stay, the session does not
 * Passwords, PINs and TOTP codes are never part of it.
 */
import { isForbiddenSecretKey } from "../../brokers/contract.mjs";
import { nextIstMidnightMs } from "../../brokers/sessionLogin.mjs";
import { BridgeError } from "../core/errors.mjs";

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_VALUE_LEN = 4096;
export const MAX_SECRET_LEN = 256;
const KEY_RE = /^[A-Za-z0-9_]{1,40}$/;
const TOTP_RE = /^\d{6}$/;

/**
 * Values that belong to one day's session for brokers whose access token is minted daily (oauthRedirect,
 * requestTokenExchange). disconnect() drops these and keeps the long-lived keys (API key, secret, client id).
 */
export const DAILY_TOKEN_VALUE_KEYS = Object.freeze(["accessToken", "requestToken", "requestCode", "authCode", "userSession", "interactiveSessionToken"]);

/** Paper accounts have no adapter; these are the order/portfolio capabilities the paper engine provides. */
export const PAPER_CAPABILITIES = Object.freeze(["orderBook", "tradeBook", "positions", "funds", "placeOrder", "modifyOrder", "cancelOrder"]);

/**
 * Epoch ms of the next HH:MM IST strictly after `now`.
 * @param {number} hh 0-23
 * @param {number} mm 0-59
 * @param {number} now epoch ms
 */
export function nextIstTimeMs(hh, mm, now) {
  const istDayStart = Math.floor((now + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
  let t = istDayStart + hh * 3_600_000 + mm * 60_000;
  while (t <= now) t += DAY_MS;
  return t;
}

/**
 * When a newly saved session for this adapter stops working, as epoch ms, or null when the broker documents no
 * daily expiry (apiKeyToken: the token lives until the user revokes it or the broker rejects it).
 * oauthRedirect / requestTokenExchange: the adapter's `auth.tokenExpiry` ("06:00 IST next day") when it states
 * one, else the next IST midnight, which is conservative (an early expiry only asks the user to log in sooner).
 * @param {{ kind?: string, tokenExpiry?: string } | undefined} auth
 * @param {number} now
 */
export function sessionExpiryFor(auth, now) {
  const kind = auth?.kind ?? "apiKeyToken";
  if (kind === "apiKeyToken") return null;
  const m = /^(\d{1,2}):(\d{2})\s*IST/i.exec(String(auth?.tokenExpiry ?? ""));
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh <= 23 && mm <= 59) return nextIstTimeMs(hh, mm, now);
  }
  return nextIstMidnightMs(now);
}

/** ISO-8601 with the IST offset (+05:30), the format every Bridge timestamp uses. */
export function toIstIso(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  const d = new Date(ms + IST_OFFSET_MS);
  return `${d.toISOString().slice(0, 19)}+05:30`;
}

function stringMap(raw, what, maxLen) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new BridgeError("VALIDATION_FAILED", `${what} must be an object of text fields.`, { errors: [{ path: what, message: "must be an object" }] });
  const out = {};
  const errors = [];
  for (const [k, v] of Object.entries(raw)) {
    // Error entries name the KEY only; a value (possibly a secret) is never echoed back.
    if (!KEY_RE.test(k)) errors.push({ path: `${what}.(key)`, message: "field names use letters, digits and underscores (max 40)" });
    else if (typeof v !== "string") errors.push({ path: `${what}.${k}`, message: "must be text" });
    else if (v.length > maxLen) errors.push({ path: `${what}.${k}`, message: `must be at most ${maxLen} characters` });
    else out[k] = v;
  }
  if (errors.length) throw new BridgeError("VALIDATION_FAILED", `Some ${what} fields are not valid.`, { errors: errors.slice(0, 20) });
  return out;
}

/**
 * Validate a connect() input against the adapter's declared fields. Never echoes a value.
 *  - values: only the adapter's credentialFields; a secret-looking key (password, PIN, TOTP ...) is refused even if
 *    an adapter listed it by mistake. An empty string removes a saved value.
 *  - secrets: only for sessionLogin adapters, only their auth.loginFields, all of them present, totpCode 6 digits.
 * @param {object} adapter  Broker adapter module.
 * @param {{ values?: unknown, secrets?: unknown }} input
 * @returns {{ values: Record<string,string>, secrets: Record<string,string> }}
 */
export function validateConnectInput(adapter, input) {
  if (input === undefined || input === null) input = {};
  if (typeof input !== "object" || Array.isArray(input)) throw new BridgeError("VALIDATION_FAILED", "Send { values, secrets }.");
  const extra = Object.keys(input).filter((k) => k !== "values" && k !== "secrets");
  if (extra.length) throw new BridgeError("VALIDATION_FAILED", "Only 'values' and 'secrets' may be sent.", { errors: extra.slice(0, 5).map((k) => ({ path: String(k).slice(0, 40), message: "unknown field" })) });

  const values = stringMap(input.values, "values", MAX_VALUE_LEN);
  const secrets = stringMap(input.secrets, "secrets", MAX_SECRET_LEN);
  const allowed = new Set(Array.isArray(adapter.credentialFields) ? adapter.credentialFields : []);
  const errors = [];
  for (const k of Object.keys(values)) {
    if (isForbiddenSecretKey(k)) errors.push({ path: `values.${k}`, message: "passwords, PINs and TOTP codes are never saved; send them in 'secrets' for a session login" });
    else if (!allowed.has(k)) errors.push({ path: `values.${k}`, message: `not a field this broker uses (expected one of: ${[...allowed].join(", ") || "none"})` });
  }

  const auth = adapter.capabilities?.auth;
  if (auth?.kind === "sessionLogin") {
    const loginKeys = new Set((auth.loginFields ?? []).map((f) => f.key));
    for (const k of Object.keys(secrets)) if (!loginKeys.has(k)) errors.push({ path: `secrets.${k}`, message: `not a login field for this broker (expected: ${[...loginKeys].join(", ")})` });
    for (const f of auth.loginFields ?? []) if (!String(secrets[f.key] ?? "").trim()) errors.push({ path: `secrets.${f.key}`, message: `enter your ${f.label ?? f.key}` });
    if (secrets.totpCode !== undefined && String(secrets.totpCode).trim() && !TOTP_RE.test(String(secrets.totpCode).trim())) {
      errors.push({ path: "secrets.totpCode", message: "enter the current 6-digit code from your authenticator app" });
    }
  } else if (Object.keys(secrets).length) {
    errors.push({ path: "secrets", message: "this broker does not use a password + TOTP login; send its keys in 'values'" });
  }
  if (errors.length) throw new BridgeError("VALIDATION_FAILED", "Some fields are missing or not valid.", { errors: errors.slice(0, 20) });
  if (secrets.totpCode !== undefined) secrets.totpCode = secrets.totpCode.trim();
  return { values, secrets };
}

/**
 * Merge newly typed values over the saved ones, keeping only declared credentialFields and dropping empty strings.
 * @param {object} adapter
 * @param {Record<string,string> | undefined} saved
 * @param {Record<string,string>} typed
 * @param {{ dropDailyTokens?: boolean }} [opts]
 */
export function mergeValues(adapter, saved, typed, { dropDailyTokens = false } = {}) {
  const allowed = new Set(Array.isArray(adapter.credentialFields) ? adapter.credentialFields : []);
  const out = {};
  for (const [k, v] of Object.entries({ ...(saved ?? {}), ...typed })) {
    if (!allowed.has(k) || isForbiddenSecretKey(k) || typeof v !== "string" || v === "") continue;
    if (dropDailyTokens && DAILY_TOKEN_VALUE_KEYS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Keep only the declared session fields with string values (defence in depth after checkLoginResult). */
export function pickSessionFields(session, sessionFields) {
  const out = {};
  for (const f of sessionFields ?? []) {
    if (isForbiddenSecretKey(f)) continue;
    const v = session?.[f];
    if (typeof v === "string" && v !== "") out[f] = v;
  }
  return out;
}

/**
 * The non-secret facts about a stored record that the in-memory state machine needs. Values are dropped here, so
 * the manager can keep this without holding broker tokens in memory between calls.
 * @param {object | null} record
 * @param {object | null} adapter
 * @returns {{ stamp: string | null, usable: boolean, disconnected: boolean, expiresAt: number | null }}
 */
export function describeRecord(record, adapter) {
  if (!record || typeof record !== "object") return { stamp: null, usable: false, disconnected: false, expiresAt: null };
  const auth = adapter?.capabilities?.auth;
  const exp = Number(record.sessionExpiresAt);
  const expiresAt = Number.isFinite(exp) && exp > 0 ? exp : null;
  let usable;
  if (auth?.kind === "sessionLogin") {
    const primary = auth.sessionFields?.[0];
    usable = Boolean(primary && typeof record.session?.[primary] === "string" && record.session[primary]);
  } else {
    usable = Object.values(record.values ?? {}).some((v) => typeof v === "string" && v !== "");
  }
  // The stamp identifies one written record: rev (written by every connect/disconnect), else connectedAt, else a
  // fixed marker for a record written by something older. In-memory flags (rejected, error) are tied to it.
  const stamp = typeof record.rev === "string" && record.rev ? record.rev : typeof record.connectedAt === "string" && record.connectedAt ? record.connectedAt : "legacy";
  return { stamp, usable, disconnected: Boolean(record.disconnectedAt), expiresAt };
}

/**
 * Session state from the record facts plus in-memory flags.
 * @param {ReturnType<typeof describeRecord>} facts
 * @param {{ rejectedStamp?: string | null, error?: { stamp: string | null, message: string } | null, checking?: boolean }} flags
 * @param {number} now
 * @returns {{ state: import("../core/contracts.mjs").SessionStateName, expiresAt: number | null, message: string | null }}
 */
export function deriveState(facts, flags, now) {
  if (flags.checking) return { state: "checking", expiresAt: facts.expiresAt, message: null };
  if (flags.error && flags.error.stamp === facts.stamp) return { state: "error", expiresAt: facts.expiresAt, message: flags.error.message };
  if (facts.disconnected) return { state: "missing", expiresAt: null, message: "Logged out. Connect again to use this account." };
  if (!facts.usable) return { state: "missing", expiresAt: null, message: "Not connected yet. Connect this account from this computer (admin)." };
  if (facts.expiresAt !== null && facts.expiresAt <= now) return { state: "expired", expiresAt: facts.expiresAt, message: "The broker session has ended for the day. Log in again." };
  if (flags.rejectedStamp && flags.rejectedStamp === facts.stamp) return { state: "expired", expiresAt: facts.expiresAt, message: "The broker rejected the session. Log in again." };
  return { state: "connected", expiresAt: facts.expiresAt, message: null };
}
