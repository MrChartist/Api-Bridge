/**
 * Snapshot store (stream S17, docs/spec/p1-01-recorder.md §3.4, §3.6, M7). Append-only NDJSON day files under
 * `<root>/s1/<YYYY-MM-DD>/<UNDERLYING>/<expiry>.ndjson` (plus `_und.ndjson` for spot and futures), gzipped at the
 * day roll; daily S3 rows under `<root>/s3/<UNDERLYING>/<YYYY>.ndjson`; recorder state in `<root>/state.json`.
 *
 *  - Appends go through server/lib/jsonl.mjs appendLine: one write per record, and a torn last line from a crash is
 *    closed with a newline first, so the next record never fuses with it. A torn or corrupt line is skipped and
 *    counted (`corruptLines`), never fatal.
 *  - Day roll: gzip to `.ndjson.gz.tmp`, fsync, rename to `.ndjson.gz`, verify by a full gunzip-and-count, then delete
 *    the `.ndjson`. Readers prefer `.gz`; a leftover `.ndjson` next to a `.gz` is deleted at the next roll.
 *  - A day folder that cannot be read (corrupt gzip, permission) is reported and skipped; it never stops recording or
 *    reading other days (BRD §7.7).
 *  - Retention deletes whole day folders older than `retentionDays` (IST dates). Over `maxDiskMb` the store refuses
 *    snapshots (the recorder writes `disk-full` gaps) and never deletes inside retention on its own.
 *  - Reads stream the day files of the range, keep snapshots and gaps in range, downsample (`everyMinutes`: the last
 *    snapshot of each bucket) and page with an opaque cursor. Past days are cached decompressed in a 64 MB LRU; the
 *    latest snapshot of each chain is kept in memory.
 *
 * Nothing here holds a credential: records carry account ids only. Files 0600, folders 0700.
 */
import { createReadStream, createWriteStream, existsSync, fsyncSync, closeSync, openSync, readdirSync, renameSync, rmSync, statSync, statfsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { constants as zlibConstants, createGzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { appendLine, appendLines, parseLines, pruneDated, quarantine, writeFileAtomic } from "../../lib/jsonl.mjs";
import { istDateOf } from "./calendar.mjs";

const gunzipAsync = promisify(gunzip);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const IST_OFFSET_MS = 330 * 60_000;
const MINUTE_MS = 60_000;
const DIR_MODE = 0o700;
/** Past-day decompressed cache cap (§3.6). */
export const LRU_BYTES = 64 * 1024 * 1024;
const YIELD_EVERY = 50;
const USAGE_TTL_MS = 15_000;
const SAFE_NAME = /^[A-Z0-9&_-]{1,40}$/;
const UND_FILE = "_und";
/** Day-roll compression: plain gzip (any gunzip reads it), tuned for time-ordered numeric JSON (§6.12). */
const GZIP_OPTIONS = Object.freeze({ level: 9, strategy: zlibConstants.Z_FILTERED });

const yieldTurn = () => new Promise((r) => setImmediate(r));
const chainKey = (u, x) => `${u}|${x}`;

/** Opaque cursor: base64url of { slot, u, x }. */
export function encodeCursor({ slot, u, x }) {
  return Buffer.from(JSON.stringify({ slot, u, x })).toString("base64url");
}
/** @returns {{ slot: number, u: string, x: string } | null} null when not a cursor of this store */
export function decodeCursor(s) {
  try {
    const o = JSON.parse(Buffer.from(String(s), "base64url").toString("utf8"));
    return Number.isInteger(o?.slot) && typeof o.u === "string" && typeof o.x === "string" ? o : null;
  } catch {
    return null;
  }
}

/** Last snapshot in each `everyMinutes` bucket (buckets aligned to IST clock time). */
export function downsample(snaps, everyMinutes) {
  if (!(everyMinutes > 1)) return snaps;
  const size = everyMinutes * MINUTE_MS;
  const out = [];
  let bucket = null;
  for (const s of snaps) {
    const b = Math.floor((s.slot + IST_OFFSET_MS) / size);
    if (b === bucket) out[out.length - 1] = s;
    else {
      out.push(s);
      bucket = b;
    }
  }
  return out;
}

/** Bytes used under a folder (files only). */
function folderBytes(dir) {
  let total = 0;
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const d of names) {
    const p = join(dir, d.name);
    if (d.isDirectory()) total += folderBytes(p);
    else {
      try {
        total += statSync(p).size;
      } catch {
        /* gone */
      }
    }
  }
  return total;
}

/**
 * @param {{ root: string, clock?: { now(): number }, logger?: any, retentionDays?: number, maxDiskMb?: number }} opts
 */
export function createSnapshotStore({ root, clock = { now: () => Date.now() }, logger, retentionDays = 365, maxDiskMb = 10240 }) {
  const s1 = join(root, "s1");
  const s3 = join(root, "s3");
  const stateFile = join(root, "state.json");
  let limits = { retentionDays, maxBytes: maxDiskMb * 1024 * 1024 };
  /** Latest snapshot per chain (memory). */
  const latest = new Map();
  /** Past-day cache: file path -> { records, bytes }. */
  const lru = new Map();
  let lruBytes = 0;
  let corruptLines = 0;
  /** Day folders that could not be read: date -> message. */
  const unreadable = new Map();
  let usageCache = null;
  let writtenSinceUsage = 0;

  // Folders are created on the first write, so building the service (a CLI command, the other mode) leaves no trace.

  const dayDir = (date) => join(s1, date);
  const fileBase = (date, u, x) => join(s1, date, u, x);
  const check = (u, x) => {
    if (!SAFE_NAME.test(u) || !(x === UND_FILE || DAY_RE.test(x))) throw new Error(`Bad chain name ${u} ${x}`);
  };

  function cacheGet(path) {
    const hit = lru.get(path);
    if (!hit) return null;
    lru.delete(path);
    lru.set(path, hit);
    return hit.records;
  }
  function cachePut(path, records, bytes) {
    if (bytes > LRU_BYTES) return;
    lru.set(path, { records, bytes });
    lruBytes += bytes;
    for (const [k, v] of lru) {
      if (lruBytes <= LRU_BYTES) break;
      lru.delete(k);
      lruBytes -= v.bytes;
    }
  }
  const forgetCache = (prefix) => {
    for (const [k, v] of lru) {
      if (k.startsWith(prefix)) {
        lru.delete(k);
        lruBytes -= v.bytes;
      }
    }
  };

  /** Parse NDJSON text, yielding every 50 lines so a big day never blocks the loop. */
  async function parseYielding(text) {
    const lines = text.split("\n");
    const endsClean = text.endsWith("\n");
    if (endsClean) lines.pop();
    const items = [];
    let bad = 0;
    for (let i = 0; i < lines.length; i++) {
      if (i > 0 && i % YIELD_EVERY === 0) await yieldTurn();
      const raw = lines[i];
      if (!raw.trim()) continue;
      try {
        items.push(JSON.parse(raw));
      } catch {
        bad += 1;
      }
    }
    return { items, bad };
  }

  /**
   * Every record of one chain-day file (.gz preferred). Unreadable files are reported and give [].
   * @returns {Promise<object[]>}
   */
  async function readFileRecords(date, u, x) {
    const base = fileBase(date, u, x);
    const gz = `${base}.ndjson.gz`;
    const plain = `${base}.ndjson`;
    const today = istDateOf(clock.now());
    try {
      if (existsSync(gz)) {
        const cached = cacheGet(gz);
        if (cached) return cached;
        const buf = await gunzipAsync(await readFile(gz));
        const text = buf.toString("utf8");
        const { items, bad } = await parseYielding(text);
        corruptLines += bad;
        if (date !== today) cachePut(gz, items, text.length);
        return items;
      }
      if (existsSync(plain)) {
        const text = await readFile(plain, "utf8");
        const { items, bad } = await parseYielding(text);
        corruptLines += bad;
        return items;
      }
      return [];
    } catch (err) {
      unreadable.set(date, `${u} ${x}: ${err?.code ?? err?.message ?? "unreadable"}`);
      logger?.warn?.("recorder day file could not be read; skipped", { date, underlying: u, expiry: x, code: err?.code });
      return [];
    }
  }

  /** Day folders (sorted) between two IST dates inclusive. */
  function daysIn(from, to) {
    let names;
    try {
      names = readdirSync(s1);
    } catch {
      return [];
    }
    return names.filter((n) => DAY_RE.test(n) && n >= from && n <= to).sort();
  }

  function usageNow() {
    const t = clock.now();
    if (usageCache && t - usageCache.at < USAGE_TTL_MS) return { ...usageCache.value, bytes: usageCache.value.bytes + writtenSinceUsage };
    const today = istDateOf(t);
    const days = daysIn("0000-00-00", "9999-99-99");
    const bytes = folderBytes(root);
    let freeBytes = null;
    for (const dir of [root, dirname(root)]) {
      try {
        const st = statfsSync(dir);
        freeBytes = Number(st.bavail) * Number(st.bsize);
        break;
      } catch {
        /* missing or not supported */
      }
    }
    const value = { bytes, todayBytes: folderBytes(dayDir(today)), days: days.length, oldestDay: days[0] ?? null, freeBytes };
    usageCache = { at: t, value };
    writtenSinceUsage = 0;
    return value;
  }

  const overCap = () => usageNow().bytes >= limits.maxBytes;

  return {
    root,
    /** Change retention and the disk cap (config change). */
    setLimits({ retentionDays: r, maxDiskMb: m }) {
      limits = { retentionDays: r ?? limits.retentionDays, maxBytes: m !== undefined ? m * 1024 * 1024 : limits.maxBytes };
    },
    get limits() {
      return { ...limits };
    },

    /**
     * Append a snapshot or gap record to its chain-day file (date = IST date of its slot). Snapshots are refused over
     * the disk cap (`{ ok: false, reason: "disk-full" }`); gap records (a few hundred bytes) are still written so the
     * day says why it is empty.
     * @returns {Promise<{ ok: boolean, bytes: number, reason?: string }>}
     */
    async append(rec) {
      check(rec.u, rec.x);
      if (rec.kind === "snap" && overCap()) return { ok: false, bytes: 0, reason: "disk-full" };
      const date = istDateOf(rec.slot);
      const { bytes } = await appendLine(`${fileBase(date, rec.u, rec.x)}.ndjson`, rec);
      writtenSinceUsage += bytes;
      if (rec.kind === "snap") {
        const key = chainKey(rec.u, rec.x);
        const prev = latest.get(key);
        if (!prev || prev.slot <= rec.slot) latest.set(key, rec);
      }
      return { ok: true, bytes };
    },

    /**
     * Append many records of ONE chain-day file in a single write (the demo back-fill). Same rules as append():
     * snapshots are refused over the disk cap.
     * @returns {Promise<{ ok: boolean, bytes: number, written: number, reason?: string }>}
     */
    async appendMany(recs) {
      if (!recs.length) return { ok: true, bytes: 0, written: 0 };
      const { u, x } = recs[0];
      check(u, x);
      const date = istDateOf(recs[0].slot);
      if (recs.some((r) => r.u !== u || r.x !== x || istDateOf(r.slot) !== date)) throw new Error("appendMany: one chain-day file per call");
      if (recs.some((r) => r.kind === "snap") && overCap()) return { ok: false, bytes: 0, written: 0, reason: "disk-full" };
      const { bytes } = await appendLines(`${fileBase(date, u, x)}.ndjson`, recs);
      writtenSinceUsage += bytes;
      for (const rec of recs) {
        if (rec.kind !== "snap") continue;
        const key = chainKey(rec.u, rec.x);
        const prev = latest.get(key);
        if (!prev || prev.slot <= rec.slot) latest.set(key, rec);
      }
      return { ok: true, bytes, written: recs.length };
    },

    /** Append an underlying line (spot and futures) to `_und.ndjson`. */
    async appendUnd(rec) {
      check(rec.u, UND_FILE);
      if (overCap()) return { ok: false, bytes: 0, reason: "disk-full" };
      const { bytes } = await appendLine(`${fileBase(istDateOf(rec.slot), rec.u, UND_FILE)}.ndjson`, rec);
      writtenSinceUsage += bytes;
      return { ok: true, bytes };
    },

    /** The latest snapshot recorded by this process (or loaded on start) for a chain, or null. */
    latest(u, x) {
      return latest.get(chainKey(u, x)) ?? null;
    },
    /** Remember a snapshot as the latest (start-up warm load). */
    rememberLatest(rec) {
      const key = chainKey(rec.u, rec.x);
      const prev = latest.get(key);
      if (!prev || prev.slot <= rec.slot) latest.set(key, rec);
    },

    /** Chains with a file on a day: [{ u, x }]. */
    chainsOn(date) {
      const out = [];
      let us;
      try {
        us = readdirSync(dayDir(date));
      } catch {
        return out;
      }
      for (const u of us.sort()) {
        if (!SAFE_NAME.test(u)) continue;
        let files;
        try {
          files = readdirSync(join(dayDir(date), u));
        } catch {
          continue;
        }
        const xs = new Set(files.map((f) => /^(\d{4}-\d{2}-\d{2})\.ndjson(\.gz)?$/.exec(f)?.[1]).filter(Boolean));
        for (const x of [...xs].sort()) out.push({ u, x });
      }
      return out;
    },

    /** Every record (snapshots and gaps) of one chain on one day, in file order. */
    readDay: (date, u, x) => readFileRecords(date, u, x),
    /** Underlying lines of a day. */
    readUnd: (date, u) => readFileRecords(date, u, UND_FILE),

    /** Recorded day folders between two dates (all when omitted). */
    days(from = "0000-00-00", to = "9999-99-99") {
      return daysIn(from, to);
    },

    /**
     * Records of one chain in [fromMs, toMs]: snapshots (downsampled, paged) and every gap in range.
     * @param {{ u: string, x: string, fromMs: number, toMs: number, includeSuspect?: boolean, everyMinutes?: number,
     *   limit?: number, cursor?: { slot: number } | null }} q
     * @returns {Promise<{ snaps: object[], gaps: object[], firstRecordSlot: number | null, allSnaps: number, partialSnaps: number, nextCursor: string | null }>}
     */
    async read({ u, x, fromMs, toMs, includeSuspect = false, everyMinutes = 1, limit = 400, cursor = null }) {
      check(u, x);
      const snaps = [];
      const gaps = [];
      for (const date of daysIn(istDateOf(fromMs), istDateOf(toMs))) {
        const recs = await readFileRecords(date, u, x);
        for (const r of recs) {
          if (!r || r.u !== u || r.x !== x || !(r.slot >= fromMs && r.slot <= toMs)) continue;
          if (r.kind === "snap") {
            if (r.quality === "suspect-holiday" && !includeSuspect) continue;
            snaps.push(r);
          } else if (r.kind === "gap") gaps.push(r);
        }
      }
      snaps.sort((a, b) => a.slot - b.slot);
      gaps.sort((a, b) => a.slot - b.slot);
      // One record per slot (a re-write after a restart keeps the later one).
      const bySlot = new Map();
      for (const s of snaps) bySlot.set(s.slot, s);
      const unique = [...bySlot.values()];
      const snapSlots = new Set(unique.map((s) => s.slot));
      const gapBySlot = new Map();
      for (const g of gaps) if (!snapSlots.has(g.slot) && !gapBySlot.has(g.slot)) gapBySlot.set(g.slot, g);
      const sampled = downsample(unique, everyMinutes);
      const after = cursor ? sampled.filter((s) => s.slot > cursor.slot) : sampled;
      const page = after.slice(0, limit);
      const more = after.length > page.length;
      const firstSlot = Math.min(unique[0]?.slot ?? Infinity, ...[...gapBySlot.keys()]);
      return {
        snaps: page,
        gaps: [...gapBySlot.values()],
        firstRecordSlot: Number.isFinite(firstSlot) ? firstSlot : null,
        allSnaps: unique.length,
        partialSnaps: unique.filter((s) => s.partial).length,
        nextCursor: more ? encodeCursor({ slot: page.at(-1).slot, u, x }) : null,
      };
    },

    /** The last record's slot (snapshot or gap) of a chain on a day, or null (restart gap filling). */
    async lastSlotOn(date, u, x) {
      const recs = await readFileRecords(date, u, x);
      let last = null;
      for (const r of recs) if (r && Number.isInteger(r.slot) && (last === null || r.slot > last)) last = r.slot;
      return last;
    },

    /**
     * Gzip every `.ndjson` of a day folder (§3.4) and write day.json. Safe to run twice; a leftover plain file next to
     * a verified `.gz` is removed.
     * @returns {Promise<{ date: string, files: number, bytes: number }>}
     */
    async rollDay(date, { quality = null } = {}) {
      const dir = dayDir(date);
      if (!existsSync(dir)) return { date, files: 0, bytes: 0 };
      const summary = { chains: {}, rolledAt: new Date(clock.now()).toISOString(), quality };
      let files = 0;
      let bytes = 0;
      for (const u of readdirSync(dir).sort()) {
        const udir = join(dir, u);
        let names;
        try {
          if (!statSync(udir).isDirectory()) continue;
          names = readdirSync(udir);
        } catch {
          continue;
        }
        for (const name of names) {
          const m = /^(.+)\.ndjson$/.exec(name);
          if (!m) continue;
          const plain = join(udir, name);
          const gz = `${plain}.gz`;
          if (existsSync(gz)) {
            rmSync(plain, { force: true });
            continue;
          }
          const tmp = `${gz}.tmp`;
          try {
            const text = readFileSync(plain, "utf8");
            const expect = parseLines(text).items.length;
            await pipeline(createReadStream(plain), createGzip(GZIP_OPTIONS), createWriteStream(tmp, { mode: 0o600 }));
            const fd = openSync(tmp, "r");
            try {
              fsyncSync(fd);
            } finally {
              closeSync(fd);
            }
            renameSync(tmp, gz);
            const back = parseLines((await gunzipAsync(readFileSync(gz))).toString("utf8")).items.length;
            if (back !== expect) throw new Error(`verify failed: ${back} of ${expect} lines`);
            rmSync(plain, { force: true });
            files += 1;
          } catch (err) {
            rmSync(tmp, { force: true });
            logger?.warn?.("recorder day roll failed for a file; the plain file is kept", { date, file: name, err: err?.message });
          }
        }
      }
      for (const { u, x } of this.chainsOn(date)) {
        const recs = await readFileRecords(date, u, x);
        const snaps = recs.filter((r) => r?.kind === "snap");
        const gz = `${fileBase(date, u, x)}.ndjson.gz`;
        const b = existsSync(gz) ? statSync(gz).size : 0;
        bytes += b;
        summary.chains[chainKey(u, x)] = { snaps: snaps.length, gaps: recs.filter((r) => r?.kind === "gap").length, partial: snaps.filter((r) => r.partial).length, bytes: b };
      }
      writeFileAtomic(join(dir, "day.json"), `${JSON.stringify(summary)}\n`);
      forgetCache(dir);
      return { date, files, bytes };
    },

    /** Whether a day folder has been rolled (day.json written and no open files). */
    isRolled(date) {
      const dir = dayDir(date);
      if (!existsSync(join(dir, "day.json"))) return false;
      return this.chainsOn(date).every(({ u, x }) => !existsSync(`${fileBase(date, u, x)}.ndjson`));
    },

    /**
     * Re-mark every snapshot of a day with a quality (the holiday detector's `suspect-holiday`), rewriting each open
     * day file once, atomically.
     */
    async remarkDay(date, quality) {
      for (const { u, x } of this.chainsOn(date)) {
        const plain = `${fileBase(date, u, x)}.ndjson`;
        if (!existsSync(plain)) continue;
        const recs = await readFileRecords(date, u, x);
        writeFileAtomic(plain, recs.map((r) => JSON.stringify(r.kind === "snap" ? { ...r, quality } : r)).join("\n") + (recs.length ? "\n" : ""));
        const l = latest.get(chainKey(u, x));
        if (l && istDateOf(l.slot) === date) latest.set(chainKey(u, x), { ...l, quality });
      }
    },

    /** Delete day folders older than the retention (IST dates). @returns {string[]} removed */
    prune(today = istDateOf(clock.now())) {
      const removed = pruneDated(s1, { keepDays: limits.retentionDays, today, match: DAY_RE });
      if (removed.length) {
        usageCache = null;
        for (const d of removed) forgetCache(join(s1, d));
      }
      return removed;
    },

    /** Disk use: { bytes, todayBytes, days, oldestDay, freeBytes, maxBytes, retentionDays, full }. */
    usage() {
      const u = usageNow();
      return { ...u, maxBytes: limits.maxBytes, retentionDays: limits.retentionDays, full: u.bytes >= limits.maxBytes };
    },
    /** Force the next usage() to measure again (tests, after a config change). */
    refreshUsage() {
      usageCache = null;
    },

    /** Lines skipped as torn or corrupt since start, and day folders that could not be read. */
    health() {
      return { corruptLines, unreadableDays: [...unreadable].map(([date, detail]) => ({ date, detail })) };
    },

    // ── S3 daily rows ──

    /**
     * Upsert daily rows: one line per (date, expiry) in `s3/<U>/<YYYY>.ndjson`, rewritten atomically per year file.
     * @param {object[]} rows S3 rows (same underlying or mixed)
     */
    async writeDaily(rows) {
      const byFile = new Map();
      for (const r of rows) {
        check(r.u, r.x);
        const file = join(s3, r.u, `${r.date.slice(0, 4)}.ndjson`);
        if (!byFile.has(file)) byFile.set(file, []);
        byFile.get(file).push(r);
      }
      for (const [file, add] of byFile) {
        let existing = [];
        if (existsSync(file)) {
          const parsed = parseLines(readFileSync(file, "utf8"));
          existing = parsed.items;
          corruptLines += parsed.corrupt + (parsed.tornTail ? 1 : 0);
        }
        const map = new Map(existing.map((r) => [`${r.date}|${r.x}`, r]));
        for (const r of add) map.set(`${r.date}|${r.x}`, r);
        const sorted = [...map.values()].sort((a, b) => (a.date === b.date ? (a.x < b.x ? -1 : 1) : a.date < b.date ? -1 : 1));
        mkdirSync(join(s3, add[0].u), { recursive: true, mode: DIR_MODE });
        writeFileAtomic(file, sorted.map((r) => JSON.stringify(r)).join("\n") + "\n");
      }
    },

    /** Daily rows of an underlying between two dates (inclusive), optionally one expiry, oldest first. */
    async readDaily({ u, from, to, x = null }) {
      check(u, x ?? UND_FILE);
      const out = [];
      for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
        const file = join(s3, u, `${y}.ndjson`);
        if (!existsSync(file)) continue;
        const parsed = parseLines(await readFile(file, "utf8"));
        for (const r of parsed.items) if (r.date >= from && r.date <= to && (!x || r.x === x)) out.push(r);
      }
      return out.sort((a, b) => (a.date === b.date ? (a.x < b.x ? -1 : 1) : a.date < b.date ? -1 : 1));
    },

    /** Dates that have S3 rows for an underlying (catch-up). */
    dailyDates(u) {
      const dates = new Set();
      let files;
      try {
        files = readdirSync(join(s3, u));
      } catch {
        return dates;
      }
      for (const f of files) {
        if (!/^\d{4}\.ndjson$/.test(f)) continue;
        for (const r of parseLines(readFileSync(join(s3, u, f), "utf8")).items) dates.add(r.date);
      }
      return dates;
    },

    // ── state.json ──

    /** Recorder state; a corrupt file is quarantined and null returned. */
    readState() {
      if (!existsSync(stateFile)) return null;
      try {
        return JSON.parse(readFileSync(stateFile, "utf8"));
      } catch {
        const moved = quarantine(stateFile, { now: clock.now() });
        logger?.warn?.("recorder state.json was corrupt; moved aside", { moved });
        return null;
      }
    },
    writeState(state) {
      writeFileAtomic(stateFile, `${JSON.stringify(state)}\n`);
    },
  };
}
