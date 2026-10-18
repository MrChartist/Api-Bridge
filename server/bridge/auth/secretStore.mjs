/**
 * SecretStore — stream S2 (docs/STREAMS.md §S2, contract SERVICE_CONTRACTS.secrets in ../core/contracts.mjs).
 *
 * Holds the user's saved broker values (API keys, client ids, access tokens, session fields) encrypted at rest in
 * <dataDir>/secrets.enc. Passwords, PINs and TOTP codes never come here (S1 sends them to adapter.login() once).
 *
 * Crypto
 *  - Master key: 32 bytes from MCB_MASTER_KEY (base64 of exactly 32 bytes), else from a key file
 *    (MCB_MASTER_KEY_FILE, else the config's masterKeyFile, else <dataDir>/master.key) holding the base64 key. The file is created on first write
 *    with mode 0600 (exclusive create, so two processes cannot race). On POSIX a key file that group/others can
 *    access, or that another user owns, is refused with a clear message — never silently "fixed".
 *  - Two sub-keys are derived with HKDF-SHA256 so one key never does two jobs: an AES-256-GCM key and an
 *    HMAC-SHA256 key.
 *  - Each entry is sealed separately with AES-256-GCM, a fresh random 12-byte IV per write, and AAD binding the
 *    ciphertext to its entry name ("mcb-secrets/v1\0<name>"), so a ciphertext moved to another name fails.
 *  - A file-level HMAC over the header and all entries detects removed, added, swapped or individually rolled-back
 *    entries, which per-entry GCM alone would not.
 *  - `keyCheck` (an HMAC of a fixed label) tells "wrong master key" apart from "file was tampered with".
 *
 * File format (JSON, mode 0600, written atomically: temp file + fsync + rename):
 *   { "format": "mcb-secrets", "version": 1, "keyCheck": "<hex>",
 *     "entries": { "<name>": { "iv": "<b64>", "tag": "<b64>", "data": "<b64>" } }, "mac": "<b64>" }
 *   Entry names are visible in the file (they are ids such as "account:dhan-main", not secrets); values are not.
 *
 * Behaviour
 *  - Any integrity failure throws SecretStoreError and returns nothing: never partial data.
 *  - Every decrypted string of 6+ characters (at any depth) is registered with logger.addSecret(), as is the master key.
 *  - The file is re-read whenever it changes on disk (checked with stat on each call), so a change made by the CLI in
 *    another process is picked up by the running server. Writes inside one process are serialised.
 *  - Values are plain JSON objects; get() returns a deep copy.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BridgeError } from "../core/errors.mjs";
import { fileSignature, unsafeKeyFileReason, writeFileAtomic } from "./fsUtil.mjs";

export const SECRETS_FORMAT = "mcb-secrets";
export const SECRETS_VERSION = 1;
export const SECRETS_FILE = "secrets.enc";
export const MASTER_KEY_FILE = "master.key";
export const MAX_ENTRY_BYTES = 64 * 1024;
export const MAX_ENTRIES = 1000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:._@-]{0,127}$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Raised for an unusable master key or a secrets file that fails its integrity checks (HTTP 500, not retryable). */
export class SecretStoreError extends BridgeError {
  /**
   * @param {string} detail
   * @param {{ reason: "bad_env_key"|"unsafe_key_file"|"bad_key_file"|"no_key"|"wrong_key"|"tampered"|"corrupt", cause?: unknown }} extra
   */
  constructor(detail, { reason, cause }) {
    super("INTERNAL", detail, cause === undefined ? {} : { cause });
    this.name = "SecretStoreError";
    /** Machine-readable reason (see constructor JSDoc). */
    this.reason = reason;
  }
}

/** Validate an entry name. Throws VALIDATION_FAILED. @param {unknown} name */
export function assertSecretName(name) {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new BridgeError("VALIDATION_FAILED", "A secret name is 1-128 characters: letters, digits and : . _ @ -, starting with a letter or digit.");
  }
}

/**
 * Decode MCB_MASTER_KEY-style base64 (standard or URL-safe alphabet) into exactly 32 bytes.
 * @param {string} text
 * @returns {Buffer | null} null when the text is not base64 of exactly 32 bytes
 */
export function decodeMasterKey(text) {
  const t = String(text ?? "").trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) return null;
  const buf = Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return buf.length === 32 ? buf : null;
}

/** HKDF sub-keys from the master key. @param {Buffer} master */
function deriveKeys(master) {
  const enc = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "mcb-secrets v1 aes-256-gcm", 32));
  const mac = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "mcb-secrets v1 hmac-sha256", 32));
  const keyCheck = createHmac("sha256", mac).update("mcb-secrets key check").digest("hex").slice(0, 16);
  return { enc, mac, keyCheck };
}

const aadFor = (name) => Buffer.from(`${SECRETS_FORMAT}/v${SECRETS_VERSION}\0${name}`, "utf8");

/** Canonical bytes covered by the file MAC (fixed field order, entries sorted by name). */
function macInput(keyCheck, entries) {
  const names = Object.keys(entries).sort();
  const parts = names.map((n) => [n, entries[n].iv, entries[n].tag, entries[n].data]);
  return JSON.stringify([SECRETS_FORMAT, SECRETS_VERSION, keyCheck, parts]);
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/**
 * @typedef {{ get(name: string): Promise<object | null>, set(name: string, value: object): Promise<void>,
 *   delete(name: string): Promise<boolean>, list(): Promise<string[]>,
 *   status(): { keySource: "env"|"file"|"none", path: string, entries: number } }} SecretStore
 */

/**
 * @param {object} deps  Core deps: config, logger, paths (dataDir), clock, bus, brokers.
 * @param {{ env?: Record<string, string | undefined>, file?: string }} [opts]  env defaults to process.env (tests inject one).
 * @returns {SecretStore}
 */
export function createSecretStore(deps, opts = {}) {
  const env = opts.env ?? process.env;
  const logger = deps.logger;
  const dataDir = resolve(deps.paths?.dataDir ?? deps.config?.dataDir ?? "./data");
  const filePath = opts.file ?? join(dataDir, SECRETS_FILE);
  const keyFilePath = resolve(env.MCB_MASTER_KEY_FILE || deps.config?.masterKeyFile || join(dataDir, MASTER_KEY_FILE));

  /** @type {{ enc: Buffer, mac: Buffer, keyCheck: string } | null} */
  let keys = null;
  /** @type {"env"|"file"|null} */
  let keySourceLoaded = null;
  /** Decrypted view (name -> value) and the sealed entries as on disk (re-used for untouched entries on write). */
  let plain = new Map();
  let sealed = {};
  let loadedSig; // undefined = never loaded; null = the file was absent when last checked
  let queue = Promise.resolve();

  const registerSecrets = (v, depth = 0) => {
    if (depth > 8 || v === null || v === undefined) return;
    if (typeof v === "string") logger.addSecret(v);
    else if (Array.isArray(v)) for (const x of v) registerSecrets(x, depth + 1);
    else if (typeof v === "object") for (const x of Object.values(v)) registerSecrets(x, depth + 1);
  };

  /** Load (or, with create, generate) the master key. Returns null only when absent and !create. */
  const loadKey = ({ create }) => {
    if (keys) return keys;
    let master;
    if (env.MCB_MASTER_KEY) {
      master = decodeMasterKey(env.MCB_MASTER_KEY);
      if (!master) throw new SecretStoreError("MCB_MASTER_KEY must be base64 of exactly 32 bytes (generate one with: openssl rand -base64 32).", { reason: "bad_env_key" });
      keySourceLoaded = "env";
    } else {
      let st = null;
      try {
        st = statSync(keyFilePath);
      } catch (err) {
        if (err.code !== "ENOENT") throw new SecretStoreError(`The master key file ${keyFilePath} could not be read.`, { reason: "bad_key_file", cause: err });
      }
      if (!st) {
        if (!create) return null;
        master = randomBytes(32);
        let fd;
        try {
          fd = openSync(keyFilePath, "wx", 0o600);
        } catch (err) {
          if (err.code === "EEXIST") return loadKey({ create }); // another process created it first: use that key
          throw new SecretStoreError(`The master key file ${keyFilePath} could not be created.`, { reason: "bad_key_file", cause: err });
        }
        try {
          const reason = unsafeKeyFileReason(fstatSync(fd));
          if (reason) throw new SecretStoreError(`The new master key file ${keyFilePath} ${reason}.`, { reason: "unsafe_key_file" });
          writeSync(fd, `${master.toString("base64")}\n`);
        } finally {
          closeSync(fd);
        }
        logger.info("created master key file", { path: keyFilePath });
        // A key file next to secrets.enc protects nothing once the folder is backed up, synced or zipped for
        // support; Windows file permissions are not checked by the Bridge at all.
        if (resolve(dirname(keyFilePath)) === resolve(dataDir)) logger.warn("the master key file is in the data folder next to secrets.enc; set MCB_MASTER_KEY_FILE to a path outside it (see mc-bridge doctor)", { path: keyFilePath });
        if (process.platform === "win32") logger.warn("file permissions of the master key file are not checked on Windows; restrict it to your user (icacls)", { path: keyFilePath });
      } else {
        const reason = unsafeKeyFileReason(st);
        if (reason) throw new SecretStoreError(`Refusing to use master key file ${keyFilePath}: it ${reason}.`, { reason: "unsafe_key_file" });
        master = decodeMasterKey(readFileSync(keyFilePath, "utf8"));
        if (!master) throw new SecretStoreError(`The master key file ${keyFilePath} must hold base64 of exactly 32 bytes.`, { reason: "bad_key_file" });
      }
      keySourceLoaded = "file";
    }
    logger.addSecret(master.toString("base64"));
    keys = deriveKeys(master);
    master.fill(0);
    return keys;
  };

  /** Parse and fully verify the file. Returns the new state; never touches the current state. */
  const readFileState = () => {
    const sig = fileSignature(filePath);
    if (sig === null) return { sig, sealed: {}, plain: new Map() };
    let doc;
    try {
      doc = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (err) {
      throw new SecretStoreError(`${filePath} is not a valid secrets file (it could not be parsed). Restore it from a backup, or delete it and reconnect your accounts.`, { reason: "corrupt", cause: err });
    }
    if (!isPlainObject(doc) || doc.format !== SECRETS_FORMAT || doc.version !== SECRETS_VERSION || !isPlainObject(doc.entries) || typeof doc.mac !== "string" || typeof doc.keyCheck !== "string") {
      throw new SecretStoreError(`${filePath} is not a version ${SECRETS_VERSION} secrets file.`, { reason: "corrupt" });
    }
    const k = loadKey({ create: false });
    if (!k) throw new SecretStoreError(`${filePath} exists but no master key was found (set MCB_MASTER_KEY or restore ${keyFilePath}).`, { reason: "no_key" });
    const check = Buffer.from(k.keyCheck);
    const given = Buffer.from(doc.keyCheck);
    if (check.length !== given.length || !timingSafeEqual(check, given)) {
      throw new SecretStoreError(`${filePath} was written with a different master key from the one configured.`, { reason: "wrong_key" });
    }
    for (const [name, e] of Object.entries(doc.entries)) {
      if (!NAME_RE.test(name) || !isPlainObject(e) || typeof e.iv !== "string" || typeof e.tag !== "string" || typeof e.data !== "string") {
        throw new SecretStoreError(`${filePath} failed its integrity check.`, { reason: "tampered" });
      }
    }
    const expectedMac = createHmac("sha256", k.mac).update(macInput(doc.keyCheck, doc.entries)).digest();
    const givenMac = Buffer.from(doc.mac, "base64");
    if (givenMac.length !== expectedMac.length || !timingSafeEqual(givenMac, expectedMac)) {
      throw new SecretStoreError(`${filePath} failed its integrity check: it was changed outside the Bridge or is damaged.`, { reason: "tampered" });
    }
    const out = new Map();
    for (const [name, e] of Object.entries(doc.entries)) {
      try {
        const iv = Buffer.from(e.iv, "base64");
        const tag = Buffer.from(e.tag, "base64");
        if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("bad IV or tag length");
        const d = createDecipheriv("aes-256-gcm", k.enc, iv, { authTagLength: TAG_BYTES });
        d.setAAD(aadFor(name));
        d.setAuthTag(tag);
        const pt = Buffer.concat([d.update(Buffer.from(e.data, "base64")), d.final()]);
        out.set(name, JSON.parse(pt.toString("utf8")));
      } catch (err) {
        throw new SecretStoreError(`${filePath} failed its integrity check (an entry could not be decrypted).`, { reason: "tampered", cause: err });
      }
    }
    // Only now, with every entry verified, register the values with the logger.
    for (const v of out.values()) registerSecrets(v);
    return { sig, sealed: { ...doc.entries }, plain: out };
  };

  /** Make the in-memory view match the file on disk (re-read only when it changed). */
  const sync = () => {
    const sig = fileSignature(filePath);
    if (loadedSig !== undefined && sig === loadedSig) return;
    const state = readFileState();
    plain = state.plain;
    sealed = state.sealed;
    loadedSig = state.sig;
  };

  const seal = (k, name, value) => {
    const iv = randomBytes(IV_BYTES);
    const c = createCipheriv("aes-256-gcm", k.enc, iv, { authTagLength: TAG_BYTES });
    c.setAAD(aadFor(name));
    const data = Buffer.concat([c.update(Buffer.from(JSON.stringify(value), "utf8")), c.final()]);
    return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
  };

  const persist = (k, nextSealed) => {
    const mac = createHmac("sha256", k.mac).update(macInput(k.keyCheck, nextSealed)).digest("base64");
    const doc = { format: SECRETS_FORMAT, version: SECRETS_VERSION, keyCheck: k.keyCheck, entries: nextSealed, mac };
    writeFileAtomic(filePath, `${JSON.stringify(doc, null, 2)}\n`);
    loadedSig = fileSignature(filePath);
  };

  /** Serialise mutations within this process. */
  const exclusive = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  return {
    /** @param {string} name @returns {Promise<object | null>} a deep copy, or null when absent */
    async get(name) {
      assertSecretName(name);
      sync();
      const v = plain.get(name);
      return v === undefined ? null : structuredClone(v);
    },

    /** @param {string} name @param {object} value  A plain JSON object (at most 64 KB once serialised). */
    async set(name, value) {
      assertSecretName(name);
      if (!isPlainObject(value)) throw new BridgeError("VALIDATION_FAILED", "A secret value must be a JSON object.");
      let json;
      try {
        json = JSON.stringify(value);
      } catch {
        throw new BridgeError("VALIDATION_FAILED", "A secret value must be JSON-serialisable.");
      }
      if (Buffer.byteLength(json) > MAX_ENTRY_BYTES) throw new BridgeError("VALIDATION_FAILED", `A secret value may be at most ${MAX_ENTRY_BYTES} bytes.`);
      const copy = JSON.parse(json);
      return exclusive(async () => {
        sync();
        if (!plain.has(name) && plain.size >= MAX_ENTRIES) throw new BridgeError("VALIDATION_FAILED", `The secret store holds at most ${MAX_ENTRIES} entries.`);
        const k = loadKey({ create: true });
        registerSecrets(copy);
        const nextSealed = { ...sealed, [name]: seal(k, name, copy) };
        persist(k, nextSealed);
        sealed = nextSealed;
        plain = new Map(plain).set(name, copy);
      });
    },

    /** @param {string} name @returns {Promise<boolean>} true when an entry was removed */
    async delete(name) {
      assertSecretName(name);
      return exclusive(async () => {
        sync();
        if (!plain.has(name)) return false;
        const k = loadKey({ create: false });
        const nextSealed = { ...sealed };
        delete nextSealed[name];
        persist(k, nextSealed);
        sealed = nextSealed;
        const next = new Map(plain);
        next.delete(name);
        plain = next;
        return true;
      });
    },

    /** @returns {Promise<string[]>} entry names, sorted */
    async list() {
      sync();
      return [...plain.keys()].sort();
    },

    /** Synchronous summary for `doctor` and health detail. Never throws, never decrypts. */
    status() {
      const keySource = keySourceLoaded ?? (env.MCB_MASTER_KEY ? "env" : existsSync(keyFilePath) ? "file" : "none");
      let entries = 0;
      try {
        if (existsSync(filePath)) {
          const doc = JSON.parse(readFileSync(filePath, "utf8"));
          if (isPlainObject(doc?.entries)) entries = Object.keys(doc.entries).length;
        }
      } catch {
        entries = 0;
      }
      return { keySource, path: filePath, entries };
    },
  };
}
