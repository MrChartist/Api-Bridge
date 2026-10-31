/**
 * KeyStore — stream S2 (docs/STREAMS.md §S2, contract SERVICE_CONTRACTS.keyStore in ../core/contracts.mjs).
 *
 * API keys
 *  - Format: mcb_<keyId>_<secret>. keyId = 10 lowercase RFC 4648 base32 characters (a-z, 2-7; public, used in logs,
 *    URLs and the audit log). secret = 32 random bytes, base64url (43 characters). The full key is returned ONCE by
 *    create() and never stored.
 *  - Stored in <dataDir>/keys.json (mode 0600, atomic writes): the public record plus
 *    { kdf: { alg: "scrypt", N: 2^15, r: 8, p: 1, keylen: 32 }, salt, hash } with hash = scrypt(secret, salt).
 *  - authenticate() is constant time with respect to the SECRET: a wrong secret for a known keyId runs the same scrypt
 *    and timingSafeEqual as the right one, and nothing exits early on a matching prefix. A malformed key, or a keyId
 *    that does not exist, is refused at once WITHOUT scrypt: the key format and keyIds are public, so spending
 *    32 MB and tens of milliseconds on them only lets any local process, LAN peer or tunnel caller exhaust the libuv
 *    threadpool (shared with DNS lookups and file I/O, so broker calls would stall). The scrypt work that remains
 *    is bounded: at most MAX_CONCURRENT_VERIFY verifications at a time with a short queue (then RATE_LIMITED), and
 *    a client IP with too many failed keys in a minute is refused before any hashing. Validity (revoked, expired) is
 *    checked after the hash comparison, on every call.
 *  - Verified-key cache: successful verifications are remembered for at most 60 s so scrypt (about 32 MB and tens of
 *    milliseconds) does not run on every request. The cache key is HMAC-SHA256(per-process random key, full key), so
 *    the cache never holds a key and its entries are useless outside this process. Entries are dropped on revoke and
 *    whenever the stored hash for that keyId changes; revocation and expiry are still checked on every request, so a
 *    revoked key fails on the very next request, including revocations made by the CLI in another process.
 *  - lastUsedAt is written at most once a minute per key.
 *  - keys.json is re-read whenever it changes on disk (stat on each call; no watcher, which is unreliable across
 *    platforms). If the file cannot be read or fails validation, the store FAILS CLOSED: authenticate() returns null
 *    for every key until the file is valid again, and an error is logged.
 *
 * Rules
 *  - allowQuery (the ?key= URL form for Excel and chart libraries) only when scopes are exactly ["read"]. Records
 *    edited by hand to break this rule are loaded with allowQuery = false.
 *  - Keys with the "live" or "admin" scope may be created only from this computer: create(input, { loopback }) with
 *    loopback false is refused with LOOPBACK_ONLY. The CLI is local, so loopback defaults to true; the HTTP route
 *    passes ctx.loopback (the route is loopbackOnly as well, so this is defence in depth).
 *  - A caller may not grant more than it holds: over HTTP the route passes the creating key's scopes
 *    (opts.creatorScopes), and a key with the "live" scope can only be minted by a key that has "live" itself. An
 *    admin key alone cannot create a live trading path (admin does not imply live). Likewise the creating key's
 *    accounts (opts.creatorAccounts): a key limited to some accounts can only mint keys limited to those accounts.
 *    The local CLI passes neither.
 *  - A key for an AI assistant (clientKind "mcp") may not have the admin scope: admin confirms order tickets, and the
 *    assistant must never confirm its own orders.
 *
 * Stream tokens
 *  - mcb_st_<32 random bytes base64url>, held only in memory (keyed by HMAC, like the cache), bound to one key,
 *    single use, valid for at most 60 s to connect. Revoking the key voids its unused tokens. The "mcb_" prefix means
 *    the core logger masks tokens like keys.
 */
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { SCOPES } from "../core/context.mjs";
import { BridgeError, fromValidation } from "../core/errors.mjs";
import { fileSignature, writeFileAtomic } from "./fsUtil.mjs";

export const KEYS_FORMAT = "mcb-keys";
export const KEYS_VERSION = 1;
export const KEYS_FILE = "keys.json";
/** scrypt parameters for new keys (docs/ARCHITECTURE.md §8). */
export const SCRYPT_PARAMS = Object.freeze({ alg: "scrypt", N: 2 ** 15, r: 8, p: 1, keylen: 32 });
export const VERIFY_CACHE_TTL_MS = 60_000;
export const LAST_USED_WRITE_INTERVAL_MS = 60_000;
export const STREAM_TOKEN_TTL_MS = 60_000;
export const MAX_KEYS = 500;
/** Concurrent scrypt verifications allowed, and how many may wait for a turn before RATE_LIMITED. */
export const MAX_CONCURRENT_VERIFY = 2;
export const MAX_WAITING_VERIFY = 32;
/** Failed key checks allowed per client IP per minute before that IP is refused without hashing. */
export const MAX_FAILED_AUTH_PER_IP = 30;
const FAILED_AUTH_WINDOW_MS = 60_000;
const MAX_STREAM_TOKENS_PER_KEY = 32;
const MAX_STREAM_TOKENS = 10_000;
const MAX_CACHE_ENTRIES = 10_000;
const MAX_RAW_KEY_LENGTH = 512;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
export const KEY_ID_RE = /^[a-z2-7]{10}$/;
export const API_KEY_RE = /^mcb_([a-z2-7]{10})_([A-Za-z0-9_-]{43})$/;
export const STREAM_TOKEN_RE = /^mcb_st_[A-Za-z0-9_-]{43}$/;
export const CLIENT_KINDS = Object.freeze(["script", "excel", "mcp", "ui", "other"]);
/**
 * What the Bridge made a key for, set only by the Bridge itself (never from a request body): "strategy-run" is the key
 * of one Python strategy run (docs/STRATEGIES-PYTHON.md), revoked when the run ends and at every start.
 */
export const KEY_PURPOSES = Object.freeze(["strategy-run"]);
const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** @typedef {import("../core/context.mjs").KeyRecord} KeyRecord */

/**
 * Split a raw key into its parts without any secret-dependent branching beyond the format check.
 * @param {unknown} raw
 * @returns {{ keyId: string, secret: string } | null}
 */
export function parseApiKey(raw) {
  if (typeof raw !== "string") return null;
  const m = API_KEY_RE.exec(raw);
  return m ? { keyId: m[1], secret: m[2] } : null;
}

/** 10 random lowercase base32 characters (50 bits). Uniform: 256 is a multiple of 32. */
export function generateKeyId() {
  const bytes = randomBytes(10);
  let out = "";
  for (const b of bytes) out += BASE32[b & 31];
  return out;
}

/**
 * scrypt as a promise, with maxmem sized for the parameters.
 * @param {string | Buffer} secret @param {Buffer} salt @param {{ N: number, r: number, p: number, keylen: number }} params
 * @returns {Promise<Buffer>}
 */
export function scryptHash(secret, salt, { N, r, p, keylen }) {
  return new Promise((ok, fail) => {
    scryptCb(secret, salt, keylen, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (err, key) => (err ? fail(err) : ok(key)));
  });
}

const isoString = z.string().regex(ISO_RE, "use an ISO-8601 date-time with a time zone, e.g. 2026-12-31T23:59:59+05:30").refine((s) => Number.isFinite(Date.parse(s)), "not a real date-time");
const scopesSchema = z.array(z.enum(SCOPES)).min(1).max(SCOPES.length);
const accountsSchema = z.union([z.literal("*"), z.array(z.string().regex(ACCOUNT_ID_RE, "account ids are 2-32 lowercase letters, digits or hyphens")).min(1).max(100)]);

/** Body of POST /v1/keys and the argument of create() (docs/openapi.yaml KeyCreateRequest). */
export const keyCreateSchema = z
  .object({
    label: z.string().trim().min(1).max(60).regex(/^[^\p{Cc}]*$/u, "no control characters"),
    scopes: scopesSchema,
    accounts: accountsSchema.default("*"),
    expiresAt: isoString.nullable().optional(),
    allowQuery: z.boolean().default(false),
    clientKind: z.enum(CLIENT_KINDS).default("other"),
  })
  .strict();

const storedKeySchema = z.object({
  id: z.string().regex(KEY_ID_RE),
  label: z.string().max(200),
  scopes: scopesSchema,
  accounts: accountsSchema,
  allowQuery: z.boolean().default(false),
  // A kind this version no longer offers (a key file written by an older release) reads as "other".
  clientKind: z.enum(CLIENT_KINDS).catch("other"),
  // A purpose this version does not know reads as none.
  purpose: z.enum(KEY_PURPOSES).nullable().default(null).catch(null),
  createdAt: isoString,
  expiresAt: isoString.nullable().default(null),
  revokedAt: isoString.nullable().default(null),
  lastUsedAt: isoString.nullable().default(null),
  kdf: z.object({
    alg: z.literal("scrypt"),
    N: z.number().int().min(2 ** 14).max(2 ** 20).refine((n) => (n & (n - 1)) === 0, "N must be a power of two"),
    r: z.number().int().min(1).max(32),
    p: z.number().int().min(1).max(16),
    keylen: z.literal(32),
  }),
  salt: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
  hash: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
const keysFileSchema = z.object({ format: z.literal(KEYS_FORMAT), version: z.literal(KEYS_VERSION), keys: z.array(storedKeySchema).max(MAX_KEYS * 2) });

const readOnlyScopes = (scopes) => scopes.length === 1 && scopes[0] === "read";

/** Public view of a stored record: never the salt, the hash or the key. @returns {KeyRecord} */
export function publicRecord(r) {
  return {
    id: r.id,
    label: r.label,
    scopes: [...r.scopes],
    accounts: r.accounts === "*" ? "*" : [...r.accounts],
    allowQuery: r.allowQuery,
    clientKind: r.clientKind,
    ...(r.purpose ? { purpose: r.purpose } : {}),
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
  };
}

/**
 * @typedef {{ create(input: object, opts?: { loopback?: boolean }): Promise<{ key: string, record: KeyRecord }>,
 *   list(): Promise<KeyRecord[]>, get(keyId: string): Promise<KeyRecord | null>, revoke(keyId: string): Promise<KeyRecord>,
 *   authenticate(rawKey: string, opts?: { ip?: string }): Promise<KeyRecord | null>,
 *   issueStreamToken(record: KeyRecord, opts?: { ttlMs?: number }): Promise<{ token: string, expiresAt: string }>,
 *   verifyStreamToken(token: string): Promise<KeyRecord | null> }} KeyStore
 */

/**
 * @param {object} deps  Core deps: config, logger, clock, paths (dataDir), bus, brokers.
 * @param {{ file?: string, scryptParams?: { N: number, r: number, p: number }, hasher?: typeof scryptHash }} [opts]
 *   Test hooks only (the module passes none): scryptParams applies to NEW keys (N below 2^14 is refused); hasher
 *   wraps scryptHash so tests can count and inspect hash calls.
 * @returns {KeyStore}
 */
export function createKeyStore(deps, opts = {}) {
  const logger = deps.logger;
  const now = () => (deps.clock?.now ? deps.clock.now() : Date.now());
  const dataDir = resolve(deps.paths?.dataDir ?? deps.config?.dataDir ?? "./data");
  const filePath = opts.file ?? join(dataDir, KEYS_FILE);
  const newKdf = { ...SCRYPT_PARAMS, ...(opts.scryptParams ?? {}), alg: "scrypt", keylen: 32 };
  if (!(newKdf.N >= 2 ** 14)) throw new Error("scrypt N must be at least 2^14");
  const hasher = opts.hasher ?? scryptHash;

  const processKey = randomBytes(32);
  const tag = (s) => createHmac("sha256", processKey).update(s, "utf8").digest("base64url");

  /** @type {Map<string, object>} keyId -> stored record (with hashBuf/saltBuf) */
  let records = new Map();
  let loadedSig; // undefined = never loaded; null = file absent
  /** @type {Error | null} set while keys.json is unreadable: authenticate fails closed */
  let loadError = null;
  let lastLoadErrorLogAt = 0;
  /** @type {Map<string, { keyId: string, hash: string, expiresAt: number }>} */
  const verifyCache = new Map();
  /** @type {Map<string, { keyId: string, expiresAt: number }>} */
  const streamTokens = new Map();
  const lastUsedPending = new Set();
  let queue = Promise.resolve();

  // ── Bounded scrypt work (see the header) ──
  let verifying = 0;
  /** @type {Array<() => void>} */
  const verifyWaiters = [];
  async function withVerifySlot(fn) {
    if (verifying >= MAX_CONCURRENT_VERIFY) {
      if (verifyWaiters.length >= MAX_WAITING_VERIFY) throw new BridgeError("RATE_LIMITED", "Too many API key checks at once. Try again in a moment.", { retryAfterMs: 1000 });
      await new Promise((r) => verifyWaiters.push(r));
    }
    verifying += 1;
    try {
      return await fn();
    } finally {
      verifying -= 1;
      verifyWaiters.shift()?.();
    }
  }
  /** @type {Map<string, { n: number, since: number }>} client IP -> failed checks in the current window */
  const failedByIp = new Map();
  const ipBlocked = (ip, t) => {
    if (!ip) return false;
    const f = failedByIp.get(ip);
    if (!f) return false;
    if (t - f.since >= FAILED_AUTH_WINDOW_MS) {
      failedByIp.delete(ip);
      return false;
    }
    return f.n >= MAX_FAILED_AUTH_PER_IP;
  };
  const noteFailed = (ip, t) => {
    if (!ip) return;
    const f = failedByIp.get(ip);
    if (!f || t - f.since >= FAILED_AUTH_WINDOW_MS) failedByIp.set(ip, { n: 1, since: t });
    else f.n += 1;
    if (failedByIp.size > 10_000) failedByIp.delete(failedByIp.keys().next().value);
  };

  const hydrate = (r) => {
    const rec = { ...r };
    if (rec.allowQuery && !readOnlyScopes(rec.scopes)) rec.allowQuery = false;
    rec.saltBuf = Buffer.from(rec.salt, "base64");
    rec.hashBuf = Buffer.from(rec.hash, "base64");
    if (rec.hashBuf.length !== 32 || rec.saltBuf.length < 16) throw new Error(`key ${rec.id}: bad salt or hash length`);
    return rec;
  };

  const loadFromDisk = (sig) => {
    if (sig === null) return new Map();
    const doc = JSON.parse(readFileSync(filePath, "utf8"));
    const parsed = keysFileSchema.safeParse(doc);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new Error(`${first?.path?.join(".") || "(root)"}: ${first?.message ?? "invalid"}`);
    }
    const out = new Map();
    for (const r of parsed.data.keys) {
      if (out.has(r.id)) throw new Error(`duplicate key id ${r.id}`);
      out.set(r.id, hydrate(r));
    }
    return out;
  };

  /** Re-read keys.json if it changed. Never throws; sets loadError (fail closed) on a bad file. */
  const refresh = () => {
    let sig;
    try {
      sig = fileSignature(filePath);
      if (loadedSig !== undefined && sig === loadedSig && !loadError) return;
      if (loadError && sig === loadedSig) return; // still the same broken file
      const next = loadFromDisk(sig);
      records = next;
      loadedSig = sig;
      loadError = null;
      // Drop cache entries whose record vanished or changed hash.
      for (const [id, c] of verifyCache) {
        const r = records.get(c.keyId);
        if (!r || r.hash !== c.hash) verifyCache.delete(id);
      }
    } catch (err) {
      loadedSig = sig;
      loadError = err;
      records = new Map();
      verifyCache.clear();
      streamTokens.clear();
      if (now() - lastLoadErrorLogAt > 60_000) {
        lastLoadErrorLogAt = now();
        logger.error("keys file is not valid; every API key is refused until it is fixed", { path: filePath, err: { message: String(err?.message ?? err) } });
      }
    }
  };

  /** For admin operations: refresh and throw when the file is unusable. */
  const requireLoaded = () => {
    refresh();
    if (loadError) throw new BridgeError("INTERNAL", `${filePath} is not a valid keys file (${String(loadError.message).slice(0, 200)}). Fix or restore it; until then every API key is refused.`);
  };

  const persist = () => {
    const keys = [...records.values()].map(({ saltBuf: _s, hashBuf: _h, ...r }) => r);
    writeFileAtomic(filePath, `${JSON.stringify({ format: KEYS_FORMAT, version: KEYS_VERSION, keys }, null, 2)}\n`);
    loadedSig = fileSignature(filePath);
  };

  const exclusive = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  const isUsable = (r, t = now()) => Boolean(r) && !r.revokedAt && !(r.expiresAt && Date.parse(r.expiresAt) <= t);

  const forgetKey = (keyId) => {
    for (const [id, c] of verifyCache) if (c.keyId === keyId) verifyCache.delete(id);
    for (const [id, s] of streamTokens) if (s.keyId === keyId) streamTokens.delete(id);
  };

  const noteUsed = (rec) => {
    const t = now();
    if (rec.lastUsedAt && t - Date.parse(rec.lastUsedAt) < LAST_USED_WRITE_INTERVAL_MS) return;
    if (lastUsedPending.has(rec.id)) return;
    lastUsedPending.add(rec.id);
    exclusive(async () => {
      try {
        refresh();
        if (loadError) return;
        const cur = records.get(rec.id);
        if (!cur || (cur.lastUsedAt && now() - Date.parse(cur.lastUsedAt) < LAST_USED_WRITE_INTERVAL_MS)) return;
        cur.lastUsedAt = new Date(now()).toISOString();
        persist();
      } catch (err) {
        logger.warn("could not record key lastUsedAt", { keyId: rec.id, err: { message: String(err?.message ?? err) } });
      } finally {
        lastUsedPending.delete(rec.id);
      }
    });
  };

  const sweepTokens = () => {
    const t = now();
    for (const [id, s] of streamTokens) if (s.expiresAt <= t) streamTokens.delete(id);
  };

  refresh();

  return {
    /**
     * Create a key. The full key is in the result once and is never stored.
     * @param {object} input  KeyCreateRequest: { label, scopes, accounts?, expiresAt?, allowQuery?, clientKind? }
     * @param {{ loopback?: boolean, purpose?: string }} [opts]  loopback: the request came from this computer (default
     *   true: CLI). purpose: one of KEY_PURPOSES, set by the Bridge's own code only (a strategy run's key).
     */
    async create(input, { loopback = true, creatorScopes, creatorAccounts, purpose } = {}) {
      const parsed = keyCreateSchema.safeParse(input ?? {});
      if (!parsed.success) throw fromValidation(parsed.error, "The key request is not valid.");
      if (purpose !== undefined && !KEY_PURPOSES.includes(purpose)) throw new BridgeError("VALIDATION_FAILED", `purpose must be one of ${KEY_PURPOSES.join(", ")}.`, { errors: [{ path: "purpose", message: "unknown purpose" }] });
      const v = parsed.data;
      const scopes = SCOPES.filter((s) => v.scopes.includes(s));
      if (v.allowQuery && !readOnlyScopes(scopes)) {
        throw new BridgeError("VALIDATION_FAILED", "allowQuery is only allowed for keys whose only scope is read.", { errors: [{ path: "allowQuery", message: "needs scopes exactly [\"read\"]" }] });
      }
      if (!loopback && (scopes.includes("live") || scopes.includes("admin"))) {
        throw new BridgeError("LOOPBACK_ONLY", "Keys with the live or admin scope can only be created from this computer.");
      }
      if (creatorScopes !== undefined && scopes.includes("live") && !new Set(creatorScopes).has("live")) {
        throw new BridgeError("SCOPE_REQUIRED", 'Only a key that has the "live" scope itself (or the mc-bridge command line) can create a live key.', { errors: [{ path: "scopes", message: "live needs a creator with live" }] });
      }
      if (creatorAccounts !== undefined && creatorAccounts !== "*") {
        const held = new Set(Array.isArray(creatorAccounts) ? creatorAccounts : []);
        if (v.accounts === "*" || !v.accounts.every((a) => held.has(a))) {
          throw new BridgeError("ACCOUNT_FORBIDDEN", "A key limited to some accounts can only create keys limited to those same accounts.", { errors: [{ path: "accounts", message: "must be a subset of the creating key's accounts" }] });
        }
      }
      if (v.clientKind === "mcp" && scopes.includes("admin")) {
        throw new BridgeError("VALIDATION_FAILED", "A key for an AI assistant (clientKind mcp) cannot have the admin scope: admin confirms orders, and an assistant must never confirm its own.", { errors: [{ path: "scopes", message: "admin not allowed with clientKind mcp" }] });
      }
      const t = now();
      if (v.expiresAt && Date.parse(v.expiresAt) <= t) {
        throw new BridgeError("VALIDATION_FAILED", "expiresAt must be in the future.", { errors: [{ path: "expiresAt", message: "must be in the future" }] });
      }
      const secret = randomBytes(32).toString("base64url");
      const salt = randomBytes(16);
      const hash = await hasher(secret, salt, newKdf);
      return exclusive(async () => {
        requireLoaded();
        if ([...records.values()].filter((r) => !r.revokedAt).length >= MAX_KEYS) {
          throw new BridgeError("VALIDATION_FAILED", `At most ${MAX_KEYS} active keys are allowed. Revoke unused keys first.`);
        }
        let id = generateKeyId();
        while (records.has(id)) id = generateKeyId();
        // The file holds at most MAX_KEYS * 2 records (keysFileSchema): past that it would fail validation and every
        // key would be refused. Revoked keys can never authenticate again, so the oldest revoked ones make room
        // (strategy runs mint and revoke a key each, docs/STRATEGIES-PYTHON.md). Active keys are never dropped.
        let kept = records;
        if (records.size >= MAX_KEYS * 2) {
          const revoked = [...records.values()].filter((r) => r.revokedAt).sort((a, b) => a.revokedAt.localeCompare(b.revokedAt) || a.id.localeCompare(b.id));
          kept = new Map(records);
          for (const r of revoked.slice(0, records.size - MAX_KEYS * 2 + 1)) kept.delete(r.id);
        }
        const stored = {
          id,
          label: v.label,
          scopes,
          accounts: v.accounts,
          allowQuery: v.allowQuery,
          clientKind: v.clientKind,
          ...(purpose ? { purpose } : {}),
          createdAt: new Date(t).toISOString(),
          expiresAt: v.expiresAt ? new Date(Date.parse(v.expiresAt)).toISOString() : null,
          revokedAt: null,
          lastUsedAt: null,
          kdf: { alg: "scrypt", N: newKdf.N, r: newKdf.r, p: newKdf.p, keylen: 32 },
          salt: salt.toString("base64"),
          hash: hash.toString("base64"),
        };
        const next = new Map(kept).set(id, hydrate(stored));
        const prev = records;
        records = next;
        try {
          persist();
        } catch (err) {
          records = prev;
          throw err;
        }
        logger.info("api key created", { keyId: id, scopes });
        return { key: `mcb_${id}_${secret}`, record: publicRecord(stored) };
      });
    },

    /** @returns {Promise<KeyRecord[]>} all keys (including revoked and expired), oldest first */
    async list() {
      requireLoaded();
      return [...records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(publicRecord);
    },

    /** @param {string} keyId @returns {Promise<KeyRecord | null>} */
    async get(keyId) {
      if (typeof keyId !== "string" || !KEY_ID_RE.test(keyId)) return null;
      requireLoaded();
      const r = records.get(keyId);
      return r ? publicRecord(r) : null;
    },

    /**
     * Revoke a key; effective on the very next request. Revoking an already revoked key returns it unchanged.
     * @param {string} keyId @returns {Promise<KeyRecord>} throws NOT_FOUND
     */
    async revoke(keyId) {
      if (typeof keyId !== "string" || !KEY_ID_RE.test(keyId)) throw new BridgeError("NOT_FOUND", "No API key with this id.");
      return exclusive(async () => {
        requireLoaded();
        const r = records.get(keyId);
        if (!r) throw new BridgeError("NOT_FOUND", "No API key with this id.");
        forgetKey(keyId);
        if (r.revokedAt) return publicRecord(r);
        const updated = { ...r, revokedAt: new Date(now()).toISOString() };
        const prev = records;
        records = new Map(records).set(keyId, updated);
        try {
          persist();
        } catch (err) {
          records = prev;
          throw err;
        }
        logger.info("api key revoked", { keyId });
        // Open streams close at once in this process; a revocation made by the CLI is caught by the stream's
        // periodic key re-check.
        try {
          deps.bus?.emit?.("key.revoked", { keyId });
        } catch {
          /* a bus without the topic (old tests) must not undo a revocation */
        }
        return publicRecord(updated);
      });
    },

    /**
     * Check a raw API key. Constant time with respect to the key's content (see the file header).
     * @param {string} rawKey @param {{ ip?: string }} [_opts]
     * @returns {Promise<KeyRecord | null>} null for malformed, unknown, wrong, revoked or expired keys
     */
    async authenticate(rawKey, opts = {}) {
      const ip = typeof opts?.ip === "string" && opts.ip ? opts.ip : null;
      const t = now();
      if (ipBlocked(ip, t)) throw new BridgeError("RATE_LIMITED", "Too many invalid API keys from this address. Wait a minute and try again.", { retryAfterMs: FAILED_AUTH_WINDOW_MS });
      if (typeof rawKey !== "string" || rawKey.length === 0 || rawKey.length > MAX_RAW_KEY_LENGTH) {
        noteFailed(ip, t);
        return null;
      }
      refresh();
      const cacheId = tag(rawKey);
      let rec = null;
      const cached = verifyCache.get(cacheId);
      if (cached && cached.expiresAt > t) {
        const r = records.get(cached.keyId);
        if (r && r.hash === cached.hash) rec = r;
        else verifyCache.delete(cacheId);
      } else if (cached) verifyCache.delete(cacheId);

      if (!rec) {
        const parts = parseApiKey(rawKey);
        const candidate = parts ? records.get(parts.keyId) : undefined;
        // Malformed key or unknown keyId: both are public facts, so refuse without hashing.
        if (!candidate || loadError) {
          noteFailed(ip, t);
          return null;
        }
        let derived;
        try {
          derived = await withVerifySlot(() => hasher(parts.secret, candidate.saltBuf, candidate.kdf));
        } catch (err) {
          if (err instanceof BridgeError) throw err;
          logger.error("scrypt failed", { err: { message: String(err?.message ?? err) } });
          return null;
        }
        const equal = derived.length === candidate.hashBuf.length && timingSafeEqual(derived, candidate.hashBuf);
        if (!equal) noteFailed(ip, t);
        if (!equal || loadError) return null;
        // Re-check after the await: the file may have been reloaded meanwhile.
        const current = records.get(candidate.id);
        if (!current || current.hash !== candidate.hash) return null;
        rec = current;
        if (isUsable(rec, t)) {
          if (verifyCache.size >= MAX_CACHE_ENTRIES) verifyCache.delete(verifyCache.keys().next().value);
          verifyCache.set(cacheId, { keyId: rec.id, hash: rec.hash, expiresAt: t + VERIFY_CACHE_TTL_MS });
        }
      }
      if (!isUsable(rec, now())) {
        verifyCache.delete(cacheId);
        return null;
      }
      noteUsed(rec);
      return publicRecord(rec);
    },

    /**
     * Issue a single-use stream token for WS/SSE URLs, bound to `record`'s key.
     * @param {KeyRecord} record  The authenticated caller's key (ctx.key).
     * @param {{ ttlMs?: number }} [opts]  At most 60 s (the default); at least 1 s.
     */
    async issueStreamToken(record, { ttlMs = STREAM_TOKEN_TTL_MS } = {}) {
      refresh();
      const rec = record && typeof record.id === "string" ? records.get(record.id) : undefined;
      if (!isUsable(rec)) throw new BridgeError("UNAUTHENTICATED", "This API key is not valid, has expired or was revoked.");
      const ttl = Math.min(STREAM_TOKEN_TTL_MS, Math.max(1000, Number.isFinite(ttlMs) ? Math.floor(ttlMs) : STREAM_TOKEN_TTL_MS));
      sweepTokens();
      const mine = [...streamTokens].filter(([, s]) => s.keyId === rec.id);
      for (const [id] of mine.slice(0, Math.max(0, mine.length - MAX_STREAM_TOKENS_PER_KEY + 1))) streamTokens.delete(id);
      while (streamTokens.size >= MAX_STREAM_TOKENS) streamTokens.delete(streamTokens.keys().next().value);
      const token = `mcb_st_${randomBytes(32).toString("base64url")}`;
      const expiresAt = now() + ttl;
      streamTokens.set(tag(token), { keyId: rec.id, expiresAt });
      return { token, expiresAt: new Date(expiresAt).toISOString() };
    },

    /**
     * Redeem a stream token: valid once, within its TTL, while its key is still usable.
     * @param {string} token @returns {Promise<KeyRecord | null>}
     */
    async verifyStreamToken(token) {
      if (typeof token !== "string" || !STREAM_TOKEN_RE.test(token)) return null;
      const id = tag(token);
      const entry = streamTokens.get(id);
      streamTokens.delete(id);
      if (!entry || entry.expiresAt <= now()) return null;
      refresh();
      const rec = records.get(entry.keyId);
      return isUsable(rec) ? publicRecord(rec) : null;
    },
  };
}
