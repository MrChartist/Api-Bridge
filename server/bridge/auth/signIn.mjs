/**
 * One-time sign-in codes: how the dashboard gets an admin key without anyone copying it out of a terminal.
 *
 *  - `mc-bridge start --open` and `mc-bridge open` (this computer, access to the data folder) create a code and open
 *    http://127.0.0.1:<port>/dashboard#signin=<code>. The code is in the URL fragment, so the browser never sends it
 *    to the server in a request line and it never reaches an access log.
 *  - The dashboard removes the fragment at once and sends the code to POST /v1/sign-in (loopback only, no key). A
 *    valid code is consumed and exchanged for a new admin key that expires in 30 days.
 *  - Code: 32 random bytes, base64url (43 characters). Stored ONLY as a SHA-256 hash with its expiry (10 minutes) in
 *    <dataDir>/sign-in-codes.json (mode 0600, atomic writes). At most MAX_PENDING codes are kept; expired ones are
 *    dropped on every write. A plain hash is enough here: the code has 256 bits of entropy, so it cannot be guessed
 *    from the hash, and it lives for minutes.
 *  - The CLI writes the file and the running Bridge reads it at claim time, so a code works whether it was made
 *    before or after the Bridge started. Both sides take a small lock file around read-modify-write, so a code being
 *    created can never bring back one that was just consumed.
 *  - Matching hashes every stored entry with timingSafeEqual and never exits early.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./fsUtil.mjs";

export const SIGN_IN_FILE = "sign-in-codes.json";
export const SIGN_IN_FORMAT = "mcb-sign-in-codes";
export const SIGN_IN_VERSION = 1;
/** How long a sign-in link works. */
export const SIGN_IN_TTL_MS = 10 * 60_000;
/** Codes kept at once; the oldest are dropped when more are made. */
export const MAX_PENDING = 5;
/** How long the admin key a sign-in creates stays valid. */
export const SIGN_IN_KEY_TTL_MS = 30 * 86_400_000;
export const SIGN_IN_CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;

/** @param {string} dataDir */
export const signInPath = (dataDir) => join(dataDir, SIGN_IN_FILE);
const lockPath = (dataDir) => join(dataDir, `.${SIGN_IN_FILE}.lock`);
const sha256 = (s) => createHash("sha256").update(String(s), "utf8").digest();

/** Pending entries from the file; a missing or unreadable file reads as none (fails closed: no code matches). */
function readEntries(dataDir) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(signInPath(dataDir), "utf8"));
  } catch {
    return [];
  }
  if (raw?.format !== SIGN_IN_FORMAT || !Array.isArray(raw.codes)) return [];
  return raw.codes.filter((c) => c && typeof c.hash === "string" && HASH_RE.test(c.hash) && typeof c.expiresAt === "string" && Number.isFinite(Date.parse(c.expiresAt)));
}

function writeEntries(dataDir, codes) {
  writeFileAtomic(signInPath(dataDir), `${JSON.stringify({ format: SIGN_IN_FORMAT, version: SIGN_IN_VERSION, codes }, null, 2)}\n`);
}

/**
 * Run `fn` holding <dataDir>/.sign-in-codes.json.lock (created with O_EXCL). A lock older than LOCK_STALE_MS is
 * left over from a crashed process and is taken over.
 * @template T @param {string} dataDir @param {() => T} fn @returns {Promise<T>}
 */
async function withLock(dataDir, fn) {
  const file = lockPath(dataDir);
  const deadline = Date.now() + LOCK_WAIT_MS;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      closeSync(openSync(file, "wx", 0o600));
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS) unlinkSync(file);
      } catch {
        /* gone meanwhile */
      }
      if (Date.now() > deadline) throw new Error("The sign-in code file is busy; try again.");
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(file);
    } catch {
      /* already removed */
    }
  }
}

/**
 * Create a one-time sign-in code. Only its hash is written.
 * @param {string} dataDir @param {{ now?: number }} [opts]
 * @returns {Promise<{ code: string, expiresAt: string }>}
 */
export async function createSignInCode(dataDir, { now = Date.now() } = {}) {
  const code = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now + SIGN_IN_TTL_MS).toISOString();
  await withLock(dataDir, () => {
    const live = readEntries(dataDir).filter((c) => Date.parse(c.expiresAt) > now);
    live.push({ hash: sha256(code).toString("hex"), expiresAt });
    writeEntries(dataDir, live.slice(-MAX_PENDING));
  });
  return { code, expiresAt };
}

/**
 * Consume a sign-in code: true once for a valid, unexpired code, then false for ever. Garbage is false.
 * @param {string} dataDir @param {unknown} code @param {{ now?: number }} [opts]
 * @returns {Promise<boolean>}
 */
export async function consumeSignInCode(dataDir, code, { now = Date.now() } = {}) {
  if (typeof code !== "string" || !SIGN_IN_CODE_RE.test(code)) return false;
  const given = sha256(code);
  return withLock(dataDir, () => {
    const entries = readEntries(dataDir);
    let hit = -1;
    // Compare against every entry, without an early exit.
    entries.forEach((c, i) => {
      if (timingSafeEqual(Buffer.from(c.hash, "hex"), given) && hit === -1) hit = i;
    });
    const valid = hit !== -1 && Date.parse(entries[hit].expiresAt) > now;
    const keep = entries.filter((c, i) => i !== hit && Date.parse(c.expiresAt) > now);
    if (keep.length !== entries.length) writeEntries(dataDir, keep);
    return valid;
  });
}
