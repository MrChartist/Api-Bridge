/**
 * Tick stores: one small interface for reading stored ticks IN PLACE, wherever they live, so a historical run never needs
 * an import step and the Bridge never needs a database driver of its own.
 *
 *   TickStore = { id: string, kind: "ticks" | "samples", read(query): AsyncIterable<Tick & { seq: number }> }
 *   query     = { symbols?: string[], fromMs: number, toMs: number }      (inclusive range on receivedAt)
 *
 * A store yields ticks in REPLAY ORDER: the order the live signal saw (or would have seen) them. For the tick log that is
 * the arrival order (`seq`); for others it is (receivedAt, seq). Every tick has the canonical Tick fields (null when not
 * known) plus `seq`.
 *
 * Built in:
 *  - createTickLogStore     the Bridge's own tick log (tickLog.mjs), plain or .gz, streamed line by line.
 *  - createRecordingStore   the existing recorder's files (../recorder/). These are samples, not every tick: kind "samples".
 *  - createSqlTickStore     ANY SQL store through a driver you pass in: PostgreSQL/TimescaleDB, QuestDB, ClickHouse,
 *                           SQL Server, Snowflake, SQLite, kdb+ (via its SQL/PG interface), DuckDB (which also reads Parquet
 *                           files and S3 in place: `read_parquet('s3://bucket/ticks/*.parquet')` as the table).
 *  - createArrayStore       ticks already in memory (tests, notebooks).
 */
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { istDateOf } from "../reference/calendar.mjs";
import { readRecorded } from "../recorder/reader.mjs";
import { TICK_FILE_RE, decodeTick } from "./tickLog.mjs";

/** Every canonical Tick field a store fills (null when the store does not have it). */
export const TICK_FIELDS = Object.freeze(["symbol", "ltp", "bid", "ask", "bidQty", "askQty", "volume", "oi", "open", "high", "low", "close", "exchangeTs", "receivedAt", "broker"]);

/** Replay order across stores: time first, then seq. */
export const compareTicks = (a, b) => a.receivedAt - b.receivedAt || a.seq - b.seq;

function checkQuery(q) {
  if (!q || !Number.isFinite(q.fromMs) || !Number.isFinite(q.toMs) || q.fromMs > q.toMs) throw new Error("a tick query needs fromMs <= toMs (epoch ms)");
  return { symbols: q.symbols?.length ? new Set(q.symbols) : null, fromMs: q.fromMs, toMs: q.toMs };
}

/** Ensure the object passed in is a TickStore (used by the runner and the replay). */
export function assertTickStore(store) {
  if (!store || typeof store.read !== "function" || typeof store.id !== "string") throw new Error("not a TickStore: needs { id, read(query) }");
  return store;
}

// ───────────────────────── the Bridge's tick log ─────────────────────────

/** Day files of a tick log between two IST dates, oldest first. A plain file wins over a .gz of the same day. */
function dayFiles(root, fromDate, toDate) {
  if (!existsSync(root)) return [];
  const byDate = new Map();
  for (const name of readdirSync(root)) {
    const m = TICK_FILE_RE.exec(name);
    if (!m || m[1] < fromDate || m[1] > toDate) continue;
    if (!byDate.has(m[1]) || !m[2]) byDate.set(m[1], { date: m[1], name, gz: Boolean(m[2]) });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function* linesOf(path, gz) {
  const raw = createReadStream(path);
  const rl = createInterface({ input: gz ? raw.pipe(createGunzip()) : raw, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
    raw.destroy();
  }
}

/**
 * @param {{ root: string, id?: string }} opts  root = the tick log folder
 */
export function createTickLogStore({ root, id = "ticklog" }) {
  return {
    id,
    kind: "ticks",
    async *read(query) {
      const q = checkQuery(query);
      for (const f of dayFiles(root, istDateOf(q.fromMs), istDateOf(q.toMs))) {
        for await (const line of linesOf(join(root, f.name), f.gz)) {
          if (!line) continue;
          const t = decodeTick(line);
          if (!t || t.receivedAt < q.fromMs || t.receivedAt > q.toMs) continue;
          if (q.symbols && !q.symbols.has(t.symbol)) continue;
          yield t;
        }
      }
    },
  };
}

/**
 * Check a tick log for what was lost: holes in `seq` (lines given up on a failing disk, or deleted), torn lines and
 * lines out of order. A clean range reports zero of each.
 * @returns {Promise<{ days: Array<{ date: string, ticks: number, firstSeq: number|null, lastSeq: number|null, holes: Array<{ from: number, to: number }>, bad: number }>, complete: boolean }>}
 */
export async function auditTickLog({ root, fromDate = "0000-00-00", toDate = "9999-99-99" }) {
  const days = [];
  for (const f of dayFiles(root, fromDate, toDate)) {
    const d = { date: f.date, ticks: 0, firstSeq: null, lastSeq: null, holes: [], bad: 0 };
    for await (const line of linesOf(join(root, f.name), f.gz)) {
      if (!line) continue;
      const t = decodeTick(line);
      if (!t) {
        d.bad += 1;
        continue;
      }
      if (d.lastSeq !== null && t.seq !== d.lastSeq + 1) {
        if (t.seq > d.lastSeq + 1) d.holes.push({ from: d.lastSeq + 1, to: t.seq - 1 });
        else d.bad += 1; // repeated or backwards seq
      }
      if (d.firstSeq === null) {
        d.firstSeq = t.seq;
        if (t.seq > 1) d.holes.push({ from: 1, to: t.seq - 1 });
      }
      d.lastSeq = Math.max(d.lastSeq ?? 0, t.seq);
      d.ticks += 1;
    }
    days.push(d);
  }
  return { days, complete: days.every((d) => d.holes.length === 0 && d.bad === 0) };
}

// ───────────────────────── the existing recorder's files ─────────────────────────

/**
 * The sampling recorder's files as a store. Samples are snapshots every `everySec`, so a run on them is a run on samples:
 * the store says so (`kind: "samples"`). `receivedAt` is the sample time, `exchangeTs` the price's own time (`tickAt`).
 * @param {{ dataDir: string, recordingId?: string, id?: string }} opts
 */
export function createRecordingStore({ dataDir, recordingId, id = "recordings" }) {
  return {
    id,
    kind: "samples",
    async *read(query) {
      const q = checkQuery(query);
      if (!q.symbols) throw new Error("the recordings store needs the symbols to read");
      const all = [];
      for (const symbol of q.symbols) {
        const { rows } = readRecorded({ dataDir, symbol, fromMs: q.fromMs, toMs: q.toMs, recordingId });
        for (const r of rows) {
          const t = Date.parse(r.time);
          if (!Number.isFinite(t) || !Number.isFinite(r.ltp)) continue;
          const x = r.tickAt ? Date.parse(r.tickAt) : NaN;
          all.push({ symbol, ltp: r.ltp, bid: r.bid, ask: r.ask, bidQty: r.bidQty, askQty: r.askQty, volume: r.volume, oi: r.oi, open: r.open, high: r.high, low: r.low, close: r.close, exchangeTs: Number.isFinite(x) ? x : null, receivedAt: t, broker: null });
        }
      }
      // Sort by time, then symbol, so the order does not depend on the order the symbols were given in.
      all.sort((a, b) => a.receivedAt - b.receivedAt || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
      let seq = 0;
      for (const t of all) yield { ...t, seq: ++seq };
    },
  };
}

// ───────────────────────── any SQL store ─────────────────────────

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,2}$/;
const ident = (name, what) => {
  if (!IDENT_RE.test(String(name))) throw new Error(`${what} "${name}" is not a plain identifier`);
  return name;
};

/** Default column names; override any of them with `columns`. `seq` may be null when the table has none. */
export const DEFAULT_SQL_COLUMNS = Object.freeze({
  receivedAt: "ts",
  seq: "seq",
  symbol: "symbol",
  ltp: "ltp",
  bid: "bid",
  ask: "ask",
  bidQty: "bid_qty",
  askQty: "ask_qty",
  volume: "volume",
  oi: "oi",
  open: null,
  high: null,
  low: null,
  close: null,
  exchangeTs: "exchange_ts",
  broker: null,
});

const PLACEHOLDERS = Object.freeze({
  dollar: (i) => `$${i}`, // PostgreSQL, QuestDB, DuckDB, CockroachDB
  question: () => "?", // SQLite, MySQL, ClickHouse (HTTP drivers), DuckDB, Snowflake
  at: (i) => `@p${i}`, // SQL Server
});

const TIME_CODECS = Object.freeze({
  date: { out: (ms) => new Date(ms), in: (v) => (v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : Number(v)) },
  ms: { out: (ms) => ms, in: (v) => Number(v) },
  s: { out: (ms) => ms / 1000, in: (v) => Number(v) * 1000 },
  us: { out: (ms) => BigInt(Math.round(ms)) * 1000n, in: (v) => Number(BigInt(v) / 1000n) },
  ns: { out: (ms) => BigInt(Math.round(ms)) * 1_000_000n, in: (v) => Number(BigInt(v) / 1_000_000n) },
});

const numOrNull = (v) => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Read ticks from any SQL store through YOUR driver. The Bridge builds one parameterised SELECT (identifiers are checked,
 * values are always parameters) and reads it page by page with keyset paging on (time, seq), so memory stays bounded.
 *
 *   const pg = new (await import("pg")).default.Pool();
 *   const store = createSqlTickStore({ table: "ticks", placeholder: "dollar", query: async (sql, params) => (await pg.query(sql, params)).rows });
 *
 * @param {{ query: (sql: string, params: any[]) => Promise<object[]>, table: string, columns?: Partial<typeof DEFAULT_SQL_COLUMNS>,
 *   placeholder?: "dollar"|"question"|"at", timeAs?: "date"|"ms"|"s"|"us"|"ns", pageSize?: number, id?: string }} opts
 *   table may be a qualified name (schema.table). Without a seq column ordering ties on time is up to the store, so
 *   the whole range is read in one query (no paging) and ties keep the store's order.
 */
export function createSqlTickStore({ query, table, columns = {}, placeholder = "dollar", timeAs = "date", pageSize = 10_000, id = "sql" }) {
  if (typeof query !== "function") throw new Error("createSqlTickStore needs query(sql, params)");
  const cols = { ...DEFAULT_SQL_COLUMNS, ...columns };
  for (const [k, v] of Object.entries(cols)) if (v !== null) ident(v, `column ${k}`);
  if (!cols.receivedAt || !cols.symbol || !cols.ltp) throw new Error("the columns receivedAt, symbol and ltp are required");
  const tbl = ident(table, "table");
  const ph = PLACEHOLDERS[placeholder];
  if (!ph) throw new Error(`placeholder must be one of ${Object.keys(PLACEHOLDERS).join(", ")}`);
  const time = TIME_CODECS[timeAs];
  if (!time) throw new Error(`timeAs must be one of ${Object.keys(TIME_CODECS).join(", ")}`);
  const fields = Object.entries(cols).filter(([, c]) => c !== null);
  // Plain column names, no aliases: PostgreSQL folds unquoted aliases to lower case and Snowflake to upper case, so
  // values are picked from each row by column name, ignoring case (pick below).
  const select = [...new Set(fields.map(([, c]) => c))].join(", ");
  const paged = Boolean(cols.seq);
  const order = paged ? `${cols.receivedAt}, ${cols.seq}` : cols.receivedAt;
  const limit = Math.max(1, Math.floor(pageSize));

  /** Build one page's SQL. Exported shape for tests through `store.sqlFor`. */
  function sqlFor(q, after) {
    const params = [];
    const p = (v) => {
      params.push(v);
      return ph(params.length);
    };
    const where = [`${cols.receivedAt} >= ${p(time.out(q.fromMs))}`, `${cols.receivedAt} <= ${p(time.out(q.toMs))}`];
    if (q.symbols) where.push(`${cols.symbol} IN (${[...q.symbols].map((s) => p(s)).join(", ")})`);
    if (after) {
      const t = time.out(after.receivedAt);
      where.push(`(${cols.receivedAt} > ${p(t)} OR (${cols.receivedAt} = ${p(t)} AND ${cols.seq} > ${p(after.seq)}))`);
    }
    const tail = paged ? ` LIMIT ${limit}` : "";
    return { sql: `SELECT ${select} FROM ${tbl} WHERE ${where.join(" AND ")} ORDER BY ${order}${tail}`, params };
  }

  /** The value of a field's column in a driver row, whatever case the driver gave the key. */
  const pick = (row, field) => {
    const c = cols[field];
    if (!c) return undefined;
    const bare = c.split(".").at(-1);
    if (bare in row) return row[bare];
    const lower = bare.toLowerCase();
    for (const k of Object.keys(row)) if (k.toLowerCase() === lower) return row[k];
    return undefined;
  };

  const toTick = (row, i) => {
    const t = {};
    for (const f of TICK_FIELDS) t[f] = null;
    t.symbol = String(pick(row, "symbol"));
    for (const f of ["ltp", "bid", "ask", "bidQty", "askQty", "volume", "oi", "open", "high", "low", "close"]) t[f] = numOrNull(pick(row, f));
    t.receivedAt = time.in(pick(row, "receivedAt"));
    const x = pick(row, "exchangeTs");
    t.exchangeTs = x === null || x === undefined ? null : time.in(x);
    const b = pick(row, "broker");
    if (b !== undefined && b !== null) t.broker = String(b);
    t.seq = paged ? numOrNull(pick(row, "seq")) : i + 1;
    return t;
  };

  return {
    id,
    kind: "ticks",
    sqlFor: (q, after) => sqlFor(checkQuery(q), after),
    async *read(range) {
      const q = checkQuery(range);
      let after = null;
      let n = 0;
      for (;;) {
        const { sql, params } = sqlFor(q, after);
        const rows = await query(sql, params);
        for (const row of rows) {
          const t = toTick(row, n++);
          if (Number.isFinite(t.receivedAt)) yield t;
        }
        if (!paged || rows.length < limit) return;
        const last = toTick(rows.at(-1), n);
        after = { receivedAt: last.receivedAt, seq: last.seq };
      }
    },
  };
}

// ───────────────────────── in memory ─────────────────────────

/** Ticks already in memory, yielded in the order given (give them in replay order). Missing seq is filled 1, 2, 3 ... */
export function createArrayStore(ticks, { id = "memory", kind = "ticks" } = {}) {
  const list = ticks.map((t, i) => {
    const o = {};
    for (const f of TICK_FIELDS) o[f] = t[f] ?? null;
    return { ...o, seq: t.seq ?? i + 1 };
  });
  return {
    id,
    kind,
    async *read(query) {
      const q = checkQuery(query);
      for (const t of list) {
        if (t.receivedAt < q.fromMs || t.receivedAt > q.toMs) continue;
        if (q.symbols && !q.symbols.has(t.symbol)) continue;
        yield t;
      }
    },
  };
}
