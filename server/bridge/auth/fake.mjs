/**
 * In-memory fakes of SecretStore and KeyStore for OTHER modules' tests (accounts, stream, integrations, hooks ...). They implement the
 * exact contract methods (SERVICE_CONTRACTS.secrets / .keyStore), so pass them as createApp({ overrides }) or straight
 * into a factory. No files, no scrypt, no master key: fast and deterministic. Never use them in production code.
 *
 *   import { createFakeKeyStore, createFakeSecretStore } from "../auth/fake.mjs";
 *   const keyStore = createFakeKeyStore();
 *   const { key } = keyStore.addKey({ scopes: ["read"], accounts: ["dhan-main"] });   // raw key for Authorization
 *   const secrets = createFakeSecretStore({ initial: { "account:dhan-main": { clientId: "100" } } });
 *   secrets.calls   // [{ method: "set", name, value }, ...] to assert what was (and was not) stored
 *
 * Behaviour mirrors the real stores where tests depend on it: keys may be revoked or expire (via `clock`), stream
 * tokens are single use with a 60 s TTL, allowQuery needs scopes exactly ["read"], live/admin creation needs
 * loopback, get() returns copies, unknown ids give NOT_FOUND.
 */
import { randomBytes } from "node:crypto";
import { BridgeError, fromValidation } from "../core/errors.mjs";
import { generateKeyId, KEY_PURPOSES, keyCreateSchema, publicRecord, STREAM_TOKEN_TTL_MS } from "./keyStore.mjs";
import { assertSecretName } from "./secretStore.mjs";

/**
 * @param {{ initial?: Record<string, object>, logger?: { addSecret(v: string): void } }} [opts]
 * @returns {import("./secretStore.mjs").SecretStore & { calls: Array<{ method: string, name?: string, value?: object }>, dump(): Record<string, object> }}
 */
export function createFakeSecretStore({ initial = {}, logger } = {}) {
  const data = new Map(Object.entries(structuredClone(initial)));
  const calls = [];
  const register = (v) => {
    if (!logger) return;
    if (typeof v === "string") logger.addSecret(v);
    else if (v && typeof v === "object") for (const x of Object.values(v)) register(x);
  };
  return {
    calls,
    async get(name) {
      assertSecretName(name);
      calls.push({ method: "get", name });
      const v = data.get(name);
      if (v !== undefined) register(v);
      return v === undefined ? null : structuredClone(v);
    },
    async set(name, value) {
      assertSecretName(name);
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new BridgeError("VALIDATION_FAILED", "A secret value must be a JSON object.");
      const copy = structuredClone(value);
      calls.push({ method: "set", name, value: structuredClone(copy) });
      register(copy);
      data.set(name, copy);
    },
    async delete(name) {
      assertSecretName(name);
      calls.push({ method: "delete", name });
      return data.delete(name);
    },
    async list() {
      calls.push({ method: "list" });
      return [...data.keys()].sort();
    },
    status() {
      return { keySource: "env", path: "(memory)", entries: data.size };
    },
    /** Everything stored (deep copy), for assertions. */
    dump() {
      return Object.fromEntries([...data].map(([k, v]) => [k, structuredClone(v)]));
    },
  };
}

/**
 * @param {{ clock?: { now(): number } }} [opts]
 * @returns {import("./keyStore.mjs").KeyStore & {
 *   addKey(input: { label?: string, scopes: string[], accounts?: string[] | "*", allowQuery?: boolean, clientKind?: string, expiresAt?: string | null }): { key: string, record: import("../core/context.mjs").KeyRecord }
 * }}
 */
export function createFakeKeyStore({ clock = { now: () => Date.now() } } = {}) {
  /** @type {Map<string, { secret: string, rec: object }>} */
  const keys = new Map();
  const tokens = new Map();
  const usable = (rec) => rec && !rec.revokedAt && !(rec.expiresAt && Date.parse(rec.expiresAt) <= clock.now());

  const add = (v) => {
    let id = generateKeyId();
    while (keys.has(id)) id = generateKeyId();
    const secret = randomBytes(32).toString("base64url");
    const rec = {
      id,
      label: v.label ?? "test key",
      scopes: [...v.scopes],
      accounts: v.accounts ?? "*",
      allowQuery: Boolean(v.allowQuery) && v.scopes.length === 1 && v.scopes[0] === "read",
      clientKind: v.clientKind ?? "other",
      ...(v.purpose ? { purpose: v.purpose } : {}),
      createdAt: new Date(clock.now()).toISOString(),
      expiresAt: v.expiresAt ?? null,
      lastUsedAt: null,
      revokedAt: null,
    };
    keys.set(id, { secret, rec });
    return { key: `mcb_${id}_${secret}`, record: publicRecord(rec) };
  };

  return {
    /** Test helper (not part of the contract): add a key without validation rules beyond allowQuery. */
    addKey(input) {
      return add(input);
    },
    async create(input, { loopback = true, purpose } = {}) {
      const parsed = keyCreateSchema.safeParse(input ?? {});
      if (!parsed.success) throw fromValidation(parsed.error, "The key request is not valid.");
      if (purpose !== undefined && !KEY_PURPOSES.includes(purpose)) throw new BridgeError("VALIDATION_FAILED", `purpose must be one of ${KEY_PURPOSES.join(", ")}.`);
      const v = { ...parsed.data, ...(purpose ? { purpose } : {}) };
      if (v.allowQuery && !(v.scopes.length === 1 && v.scopes[0] === "read")) throw new BridgeError("VALIDATION_FAILED", "allowQuery is only allowed for keys whose only scope is read.");
      if (!loopback && (v.scopes.includes("live") || v.scopes.includes("admin"))) throw new BridgeError("LOOPBACK_ONLY", "Keys with the live or admin scope can only be created from this computer.");
      return add(v);
    },
    async list() {
      return [...keys.values()].map((k) => publicRecord(k.rec));
    },
    async get(keyId) {
      const k = keys.get(keyId);
      return k ? publicRecord(k.rec) : null;
    },
    async revoke(keyId) {
      const k = keys.get(keyId);
      if (!k) throw new BridgeError("NOT_FOUND", "No API key with this id.");
      if (!k.rec.revokedAt) k.rec.revokedAt = new Date(clock.now()).toISOString();
      for (const [t, e] of tokens) if (e.keyId === keyId) tokens.delete(t);
      return publicRecord(k.rec);
    },
    async authenticate(rawKey) {
      const m = typeof rawKey === "string" ? /^mcb_([a-z2-7]{10})_(.+)$/.exec(rawKey) : null;
      const k = m ? keys.get(m[1]) : undefined;
      if (!k || k.secret !== m[2] || !usable(k.rec)) return null;
      return publicRecord(k.rec);
    },
    async issueStreamToken(record, { ttlMs = STREAM_TOKEN_TTL_MS } = {}) {
      const k = record ? keys.get(record.id) : undefined;
      if (!k || !usable(k.rec)) throw new BridgeError("UNAUTHENTICATED", "This API key is not valid, has expired or was revoked.");
      const token = `mcb_st_${randomBytes(32).toString("base64url")}`;
      const expiresAt = clock.now() + Math.min(STREAM_TOKEN_TTL_MS, Math.max(1000, ttlMs));
      tokens.set(token, { keyId: record.id, expiresAt });
      return { token, expiresAt: new Date(expiresAt).toISOString() };
    },
    async verifyStreamToken(token) {
      const e = tokens.get(token);
      tokens.delete(token);
      if (!e || e.expiresAt <= clock.now()) return null;
      const k = keys.get(e.keyId);
      return k && usable(k.rec) ? publicRecord(k.rec) : null;
    },
  };
}
