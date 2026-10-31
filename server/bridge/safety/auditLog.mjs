/**
 * AuditLog — stream S9 (docs/STREAMS.md §S9, docs/ARCHITECTURE.md §8). Contract: SERVICE_CONTRACTS.audit in
 * ../core/contracts.mjs.
 *
 * Storage: <dataDir>/audit/YYYY-MM-DD.jsonl, one file per IST day, one JSON object per line:
 *
 *   { seq, at, type, actor, source, accountId, requestId, data, prevHash, hash }
 *
 *   hash = sha256_hex(prevHash + canonicalJson({ seq, at, type, actor, source, accountId, requestId, data }))
 *
 * canonicalJson sorts object keys at every depth, so the hash does not depend on key order. The chain runs across
 * day files: the first line of a day carries the last hash of the previous day; the very first line ever carries
 * GENESIS_HASH (64 zeros). `seq` starts at 1 and never repeats.
 *
 * Rules:
 *  - Append-only: one appendFileSync per record (0600 file, 0700 directory); a line is never rewritten or deleted.
 *    A day file is never written after a later one exists (a clock that jumps backwards keeps writing to the
 *    latest file), so the files read in name order are the chain in order.
 *  - Redacted before it is written: input passes through core/logger.mjs redact() (secret field names, Bridge
 *    keys, bearer tokens and JWTs are masked); exact registered secrets are masked too when the logger exposes
 *    `redact()`. Oversized `data` (> MAX_DATA_BYTES as JSON) is replaced with a short marker.
 *  - <dataDir>/audit/head.json holds the last { seq, hash } so verify() also catches lines cut off the END of the
 *    log, which a chain alone cannot see. It may lag the files by one record after a crash; that is not an error.
 *  - Appends are synchronous inside the async method, so concurrent callers cannot interleave half lines.
 *  - Several processes may append to the same log (the running Bridge and `mc-bridge keys create` in another
 *    terminal). Each append takes an exclusive lock file (<dir>/.lock, created with O_EXCL) and, when the latest day
 *    file is not the size this process left it, re-reads the chain head from the file before writing. Without that,
 *    each process would continue from its own in-memory seq and break the chain on the first day of use.
 */
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { BridgeError } from "../core/errors.mjs";
import { redact } from "../core/logger.mjs";
import { readJsonState, writeJsonState } from "./stateFile.mjs";
import { isDayString, istDay, istIso } from "./time.mjs";

export const GENESIS_HASH = "0".repeat(64);
export const MAX_DATA_BYTES = 16_384;
export const DEFAULT_QUERY_LIMIT = 100;
export const MAX_QUERY_LIMIT = 500;
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const TYPE_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 15_000;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * JSON with object keys sorted at every depth (arrays keep their order). Used for the hash only.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/** The hashed part of a record, in a fixed shape. */
function hashedBody(rec) {
  return { seq: rec.seq, at: rec.at, type: rec.type, actor: rec.actor, source: rec.source, accountId: rec.accountId, requestId: rec.requestId, data: rec.data };
}

/**
 * Hash of one record given the previous hash.
 * @param {string} prevHash
 * @param {object} rec  any object with the AuditRecord fields
 * @returns {string} 64 hex characters
 */
export function recordHash(prevHash, rec) {
  return createHash("sha256").update(String(prevHash)).update(canonicalJson(hashedBody(rec))).digest("hex");
}

/**
 * Normalise and redact an AuditInput into the fields that get hashed (everything except seq, at and the hashes).
 * Exported so the fake produces identical records.
 * @param {import("../core/contracts.mjs").AuditInput} input
 * @param {(v: unknown) => any} [scrub]  redaction function (default core redact)
 */
export function normaliseInput(input, scrub = (v) => redact(v)) {
  if (!input || typeof input !== "object") throw new BridgeError("VALIDATION_FAILED", "An audit record needs an object with at least a type.");
  const type = String(input.type ?? "");
  if (!TYPE_RE.test(type)) throw new BridgeError("VALIDATION_FAILED", `Audit type "${type.slice(0, 40)}" is not valid: use lowercase words joined by dots, like order.placed.`);
  const actorIn = input.actor && typeof input.actor === "object" ? input.actor : { kind: "system", id: "system" };
  const actor = scrub({ kind: String(actorIn.kind ?? "system").slice(0, 32), id: String(actorIn.id ?? "system").slice(0, 64) });
  const source = scrub(String(input.source ?? "system").slice(0, 32));
  const accountId = input.accountId == null ? null : scrub(String(input.accountId).slice(0, 64));
  const requestId = input.requestId == null ? null : scrub(String(input.requestId).slice(0, 64));
  let data = input.data === undefined || input.data === null ? {} : scrub(input.data);
  if (typeof data !== "object" || Array.isArray(data)) data = { value: data };
  const bytes = Buffer.byteLength(JSON.stringify(data));
  if (bytes > MAX_DATA_BYTES) data = { truncated: true, bytes, keys: Object.keys(data).slice(0, 20) };
  return { type, actor, source, accountId, requestId, data };
}

/** Encode the opaque query cursor ("records with seq below b"). */
export function encodeCursor(beforeSeq) {
  return Buffer.from(JSON.stringify({ b: beforeSeq })).toString("base64url");
}

/** Decode a cursor from encodeCursor(); throws VALIDATION_FAILED otherwise. */
export function decodeCursor(cursor) {
  try {
    const o = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (Number.isInteger(o?.b) && o.b > 0) return o.b;
  } catch {
    // fall through
  }
  throw new BridgeError("VALIDATION_FAILED", "The cursor is not valid. Start again without one.", { errors: [{ path: "cursor", message: "not a cursor from this API" }] });
}

/** Parse a time filter: ISO-8601 string, Date or epoch ms. Null when absent. */
export function parseTimeFilter(v, name) {
  if (v === undefined || v === null || v === "") return null;
  const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
  if (!Number.isFinite(t)) throw new BridgeError("VALIDATION_FAILED", `${name} must be an ISO-8601 date-time.`, { errors: [{ path: name, message: "not a date-time" }] });
  return t;
}

/** Validate a query limit (default 100, 1..500). */
export function parseLimit(v) {
  const n = v === undefined || v === null || v === "" ? DEFAULT_QUERY_LIMIT : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_QUERY_LIMIT) {
    throw new BridgeError("VALIDATION_FAILED", `limit must be a whole number from 1 to ${MAX_QUERY_LIMIT}.`, { errors: [{ path: "limit", message: "out of range" }] });
  }
  return n;
}

/**
 * Matcher for the `type` filter: exact, or a prefix ending in ".*" ("order.*" matches order.placed).
 * @param {string | undefined} pattern
 * @returns {(type: unknown) => boolean}
 */
export function typeMatcher(pattern) {
  if (!pattern) return () => true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1);
    return (t) => typeof t === "string" && t.startsWith(prefix);
  }
  return (t) => t === pattern;
}

/**
 * @param {{ logger?: any, bus?: any, clock?: { now(): number }, paths: { dataDir: string } }} deps
 * @param {{ dir?: string }} [opts]  dir overrides <dataDir>/audit (tests).
 * @returns {object} AuditLog (append, query, verify) plus helpers dir, head(), files()
 */
export function createAuditLog(deps, opts = {}) {
  const logger = deps.logger;
  const bus = deps.bus;
  const clock = deps.clock;
  const now = () => (clock ? clock.now() : Date.now());
  const dir = opts.dir ?? join(deps.paths.dataDir, "audit");
  const headPath = join(dir, "head.json");
  const scrub = typeof logger?.redact === "function" ? (v) => logger.redact(v) : (v) => redact(v);

  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const listDays = () =>
    readdirSync(dir)
      .map((f) => DAY_FILE_RE.exec(f)?.[1])
      .filter(Boolean)
      .sort();
  const fileFor = (day) => join(dir, `${day}.jsonl`);

  /** Raw lines of a day file (the empty string after the final newline removed). */
  const readLines = (day) => {
    const text = readFileSync(fileFor(day), "utf8");
    const lines = text.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return { lines, endsWithNewline: text.length === 0 || text.endsWith("\n") };
  };
  const tryParse = (line) => {
    try {
      const o = JSON.parse(line);
      return o && typeof o === "object" && !Array.isArray(o) ? o : null;
    } catch {
      return null;
    }
  };
  const isChainRecord = (rec) => rec && Number.isInteger(rec.seq) && typeof rec.hash === "string" && HASH_RE.test(rec.hash);

  /** Last chain-looking record at or before the end of `days` (unverified). */
  const lastRecordOf = (days) => {
    for (let d = days.length - 1; d >= 0; d -= 1) {
      const { lines } = readLines(days[d]);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const rec = tryParse(lines[i]);
        if (isChainRecord(rec)) return rec;
      }
    }
    return null;
  };

  const readHead = () => {
    const head = readJsonState(headPath);
    if (head.status === "ok" && Number.isInteger(head.value.seq) && HASH_RE.test(String(head.value.hash))) return head.value;
    return null;
  };

  const lockPath = join(dir, ".lock");
  /** Take the cross-process append lock. Returns a release function. A lock older than LOCK_STALE_MS is broken. */
  function lock() {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const fd = openSync(lockPath, "wx", 0o600);
        closeSync(fd);
        return () => {
          try {
            unlinkSync(lockPath);
          } catch {
            // already gone
          }
        };
      } catch (err) {
        if (err?.code !== "EEXIST") throw err;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          continue; // released between the open and the stat
        }
        if (Date.now() > deadline) throw Object.assign(new Error("audit log lock busy"), { code: "ELOCKED" });
        sleepSync(5);
      }
    }
  }
  const sizeOf = (day) => {
    try {
      return statSync(fileFor(day)).size;
    } catch {
      return -1;
    }
  };

  // ── Load the chain head ──
  let lastSeq = 0;
  let lastHash = GENESIS_HASH;
  let lastDay = null;
  let needsNewline = false;
  {
    const days = listDays();
    if (days.length) {
      lastDay = days[days.length - 1];
      needsNewline = !readLines(lastDay).endsWithNewline;
    }
    const tail = lastRecordOf(days);
    const h = readHead();
    if (readJsonState(headPath).status === "corrupt") logger?.error("audit head file is unreadable; continuing from the log files", { path: headPath });
    if (tail && (!h || tail.seq >= h.seq)) {
      lastSeq = tail.seq;
      lastHash = tail.hash;
    } else if (h) {
      // Lines are missing from the end of the log. Keep the chain anchored to the head; verify() reports the gap.
      lastSeq = h.seq;
      lastHash = h.hash;
      if (tail || days.length) logger?.error("audit log is shorter than its head record; lines may have been removed", { headSeq: h.seq, fileSeq: tail?.seq ?? 0 });
    }
  }
  /** Size of the latest day file as this process last saw it (to notice another process's appends). */
  let knownSize = lastDay ? sizeOf(lastDay) : -1;

  /** Called under the lock: pick up records another process appended since our last write. */
  function syncFromDisk() {
    const days = listDays();
    const latest = days[days.length - 1] ?? null;
    if (latest === null) return;
    if (latest === lastDay && sizeOf(latest) === knownSize) return;
    const tail = lastRecordOf(days);
    if (tail && tail.seq > lastSeq) {
      lastSeq = tail.seq;
      lastHash = tail.hash;
    }
    lastDay = latest;
    needsNewline = !readLines(latest).endsWithNewline;
  }

  /**
   * Walk day files in order, checking every line against the chain.
   * @returns {{ ok: boolean, checked: number, brokenAt: number|null, day: string|null, line: number|null, reason: string|null,
   *   lastSeq: number, lastHash: string, lastDay: string|null, lastLineCount: number }}
   */
  function walk(days, startSeq, startHash) {
    let expectSeq = startSeq + 1;
    let prev = startHash;
    let checked = 0;
    let lastLineCount = 0;
    const fail = (day, line, reason) => ({ ok: false, checked, brokenAt: expectSeq, day, line, reason, lastSeq: expectSeq - 1, lastHash: prev, lastDay: day, lastLineCount });
    for (const day of days) {
      const { lines } = readLines(day);
      lastLineCount = lines.length;
      for (let i = 0; i < lines.length; i += 1) {
        const rec = tryParse(lines[i]);
        if (!rec) return fail(day, i + 1, "the line is not valid JSON");
        if (rec.seq !== expectSeq) return fail(day, i + 1, `expected seq ${expectSeq}, found ${JSON.stringify(rec.seq) ?? "nothing"}`);
        if (rec.prevHash !== prev) return fail(day, i + 1, "prevHash does not match the previous line");
        if (typeof rec.hash !== "string" || recordHash(prev, rec) !== rec.hash) return fail(day, i + 1, "the hash does not match the line's content");
        const atMs = Date.parse(rec.at);
        if (!Number.isFinite(atMs) || istDay(atMs) > day) return fail(day, i + 1, "the record time is missing or later than its day file");
        prev = rec.hash;
        expectSeq += 1;
        checked += 1;
      }
    }
    return { ok: true, checked, brokenAt: null, day: null, line: null, reason: null, lastSeq: expectSeq - 1, lastHash: prev, lastDay: days[days.length - 1] ?? null, lastLineCount };
  }

  /** Compare the end of a successful walk with head.json (catches lines cut off the end). */
  function checkHead(res) {
    if (!res.ok) return res;
    const h = readHead();
    if (h && res.lastSeq < h.seq) {
      return {
        ...res,
        ok: false,
        brokenAt: res.lastSeq + 1,
        day: res.lastDay,
        line: res.lastLineCount + 1,
        reason: `lines are missing at the end: the log stops at seq ${res.lastSeq} but the head record says ${h.seq}`,
      };
    }
    if (h && res.lastSeq === h.seq && h.hash !== res.lastHash) {
      return { ...res, ok: false, brokenAt: res.lastSeq, day: res.lastDay, line: res.lastLineCount, reason: "the last line does not match the head record" };
    }
    return res;
  }

  return {
    /** Directory holding the day files. */
    dir,

    /**
     * Append one record: redact, chain, write one line, emit "audit.appended".
     * @param {import("../core/contracts.mjs").AuditInput} input
     * @returns {Promise<import("../core/contracts.mjs").AuditRecord>}
     */
    async append(input) {
      const body = normaliseInput(input, scrub);
      let release;
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        release = lock();
      } catch (err) {
        logger?.error("audit append failed", { type: body.type, code: err?.code });
        throw new BridgeError("INTERNAL", "The audit log could not be written. The action was not recorded.", { cause: err });
      }
      let rec;
      let seq;
      let day;
      try {
        syncFromDisk();
        const t = now();
        day = istDay(t);
        if (lastDay && day < lastDay) day = lastDay;
        seq = lastSeq + 1;
        rec = { seq, at: istIso(t), ...body, prevHash: lastHash, hash: "" };
        rec.hash = recordHash(lastHash, rec);
        const line = (needsNewline ? "\n" : "") + JSON.stringify(rec) + "\n";
        try {
          appendFileSync(fileFor(day), line, { mode: 0o600 });
        } catch (err) {
          logger?.error("audit append failed", { type: rec.type, code: err?.code });
          throw new BridgeError("INTERNAL", "The audit log could not be written. The action was not recorded.", { cause: err });
        }
        needsNewline = false;
        lastSeq = seq;
        lastHash = rec.hash;
        lastDay = day;
        knownSize = sizeOf(day);
        try {
          writeJsonState(headPath, { seq, hash: rec.hash, day });
        } catch (err) {
          logger?.warn("audit head file could not be updated", { code: err?.code });
        }
      } finally {
        release();
      }
      bus?.emit("audit.appended", { seq, type: rec.type, accountId: rec.accountId ?? undefined });
      return rec;
    },

    /**
     * Newest first. `type` is exact or a prefix like "order.*"; `from`/`to` are inclusive ISO-8601 times; nextCursor
     * continues with older records. Unreadable lines are skipped here (verify() reports them).
     * @param {{ from?: string, to?: string, type?: string, accountId?: string, limit?: number, cursor?: string }} [q]
     * @returns {Promise<{ items: object[], nextCursor: string | null }>}
     */
    async query(q = {}) {
      const fromMs = parseTimeFilter(q.from, "from");
      const toMs = parseTimeFilter(q.to, "to");
      const limit = parseLimit(q.limit);
      const before = q.cursor ? decodeCursor(q.cursor) : Infinity;
      const matchType = typeMatcher(q.type);
      const fromDay = fromMs === null ? null : istDay(fromMs);
      const toDay = toMs === null ? null : istDay(toMs);
      const days = listDays()
        .filter((d) => (fromDay === null || d >= fromDay) && (toDay === null || d <= toDay))
        .reverse();
      const out = [];
      outer: for (const day of days) {
        const { lines } = readLines(day);
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const rec = tryParse(lines[i]);
          if (!isChainRecord(rec) || rec.seq >= before) continue;
          const at = Date.parse(rec.at);
          if (fromMs !== null && !(at >= fromMs)) continue;
          if (toMs !== null && !(at <= toMs)) continue;
          if (!matchType(rec.type)) continue;
          if (q.accountId && rec.accountId !== q.accountId) continue;
          out.push(rec);
          if (out.length > limit) break outer;
        }
      }
      const more = out.length > limit;
      const items = out.slice(0, limit);
      return { items, nextCursor: more ? encodeCursor(items[items.length - 1].seq) : null };
    },

    /**
     * Check the hash chain. Without `day`: every file, plus head.json for lines removed from the end. With `day`: that
     * day's file, chained from the last line of the previous file. `brokenAt` is the seq the broken line should have
     * had; `day`, `line` (1-based within that file) and `reason` say exactly where and why.
     * @param {{ day?: string }} [opts]
     * @returns {Promise<{ ok: boolean, checked: number, brokenAt: number|null, day: string|null, line: number|null, reason: string|null }>}
     */
    async verify({ day } = {}) {
      const all = listDays();
      let res;
      if (day !== undefined && day !== null && day !== "") {
        if (!isDayString(day)) throw new BridgeError("VALIDATION_FAILED", "day must be a date like 2026-10-19.", { errors: [{ path: "day", message: "not a date" }] });
        if (!existsSync(fileFor(day))) return { ok: true, checked: 0, brokenAt: null, day, line: null, reason: null };
        const start = lastRecordOf(all.filter((d) => d < day)) ?? { seq: 0, hash: GENESIS_HASH };
        res = walk([day], start.seq, start.hash);
        if (day === all[all.length - 1]) res = checkHead(res);
      } else {
        res = checkHead(walk(all, 0, GENESIS_HASH));
      }
      return { ok: res.ok, checked: res.checked, brokenAt: res.brokenAt, day: res.day, line: res.line, reason: res.reason };
    },

    /** { seq, hash, day } of the last record this process wrote or loaded. */
    head: () => ({ seq: lastSeq, hash: lastHash, day: lastDay }),

    /** Day files present, oldest first ("YYYY-MM-DD"). */
    files: () => listDays(),
  };
}
