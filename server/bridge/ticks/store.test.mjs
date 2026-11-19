import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { csvHeader, encodeRow, fileNameFor, rowOf } from "../recorder/format.mjs";
import { createArrayStore, createRecordingStore, createSqlTickStore, createTickLogStore } from "./store.mjs";
import { createTickLog, tickFileName } from "./tickLog.mjs";

const T0 = Date.parse("2026-11-18T09:15:00+05:30");
const all = async (it) => {
  const out = [];
  for await (const x of it) out.push(x);
  return out;
};

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tickstore-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("tick log store", () => {
  it("streams a range of days in arrival order, filters symbols, and reads finished .gz days", async () => {
    const log = createTickLog({ root: dir, flushEveryMs: 0 });
    const day2 = Date.parse("2026-11-19T09:15:00+05:30");
    for (let i = 0; i < 6; i += 1) log.append({ symbol: i % 2 ? "NSE:A" : "NSE:B", ltp: i + 1, receivedAt: T0 + 10 - i }); // clock went backwards: seq still rules
    for (let i = 0; i < 4; i += 1) log.append({ symbol: "NSE:A", ltp: 50 + i, receivedAt: day2 + i });
    log.close();
    const f = join(dir, tickFileName("2026-11-18"));
    writeFileSync(`${f}.gz`, gzipSync(readFileSync(f)));
    unlinkSync(f);
    const store = createTickLogStore({ root: dir });
    const got = await all(store.read({ fromMs: T0 - 1000, toMs: day2 + 2 }));
    expect(got.map((t) => t.ltp)).toEqual([1, 2, 3, 4, 5, 6, 50, 51, 52]);
    const onlyA = await all(store.read({ symbols: ["NSE:A"], fromMs: T0 - 1000, toMs: T0 + 1000 }));
    expect(onlyA.map((t) => [t.seq, t.ltp])).toEqual([[2, 2], [4, 4], [6, 6]]);
    await expect(all(store.read({ fromMs: 2, toMs: 1 }))).rejects.toThrow(/fromMs <= toMs/);
  });
});

describe("recordings store (the existing recorder's files)", () => {
  it("reads sampled quotes in place as kind samples", async () => {
    const id = "rec_abcd1234";
    const folder = join(dir, "recordings", id);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "recording.json"), JSON.stringify({ id, kind: "quotes", everySec: 1 }));
    for (const [sym, base] of [["NSE:NIFTY", 24000], ["NSE:INFY", 1500]]) {
      let body = csvHeader();
      for (let i = 0; i < 3; i += 1) body += encodeRow(rowOf({ ms: T0 + i * 1000, symbol: sym, ltp: base + i, bid: base + i - 0.5, tickAtMs: T0 + i * 1000 - 200, source: "stream" }), "csv");
      writeFileSync(join(folder, fileNameFor("2026-11-18", sym, "csv")), body);
    }
    const store = createRecordingStore({ dataDir: dir });
    expect(store.kind).toBe("samples");
    const got = await all(store.read({ symbols: ["NSE:NIFTY", "NSE:INFY"], fromMs: T0, toMs: T0 + 10_000 }));
    expect(got.map((t) => [t.seq, t.symbol, t.ltp])).toEqual([
      [1, "NSE:INFY", 1500], [2, "NSE:NIFTY", 24000], [3, "NSE:INFY", 1501], [4, "NSE:NIFTY", 24001], [5, "NSE:INFY", 1502], [6, "NSE:NIFTY", 24002],
    ]);
    expect(got[0]).toMatchObject({ bid: 1499.5, receivedAt: T0, exchangeTs: T0 - 200 });
    await expect(all(store.read({ fromMs: T0, toMs: T0 + 1 }))).rejects.toThrow(/needs the symbols/);
  });
});

/** A fake SQL "database": understands exactly the SELECTs createSqlTickStore builds, over an array of rows. */
function fakeDb(rows, cols = { ts: "ts", seq: "seq" }) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    const lim = /LIMIT (\d+)$/.exec(sql);
    const [from, to, ...rest] = params.map((p) => (p instanceof Date ? p.getTime() : p));
    const syms = sql.includes(" IN (") ? rest.splice(0, (sql.match(/IN \(([^)]*)\)/)[1].match(/[$?@]/g) ?? []).length) : null;
    const after = rest.length ? { t: rest[0], seq: rest[2] } : null;
    const out = rows
      .filter((r) => r[cols.ts] >= from && r[cols.ts] <= to && (!syms || syms.includes(r.symbol)))
      .filter((r) => !after || r[cols.ts] > after.t || (r[cols.ts] === after.t && r[cols.seq] > after.seq))
      .sort((a, b) => a[cols.ts] - b[cols.ts] || (a[cols.seq] ?? 0) - (b[cols.seq] ?? 0));
    return (lim ? out.slice(0, Number(lim[1])) : out).map((r) => {
      const o = {};
      for (const [k, v] of Object.entries(r)) o[k.toUpperCase()] = k === cols.ts ? new Date(v) : v; // keys in upper case, as Snowflake returns them
      return o;
    });
  };
  return { query, calls };
}

describe("SQL store (any driver)", () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ ts: T0 + Math.floor(i / 3), seq: i + 1, symbol: i % 2 ? "NSE:A" : "NSE:B", ltp: String(100 + i), bid: null, ask: null, bid_qty: 5n, ask_qty: null, volume: i, oi: null, exchange_ts: null }));

  it("builds parameterised SQL for each placeholder style; values never go into the text", () => {
    const q = { symbols: ["NSE:A'; DROP TABLE x;--"], fromMs: T0, toMs: T0 + 1 };
    const pg = createSqlTickStore({ query: async () => [], table: "market.ticks" }).sqlFor(q);
    expect(pg.sql).toBe("SELECT ts, seq, symbol, ltp, bid, ask, bid_qty, ask_qty, volume, oi, exchange_ts FROM market.ticks WHERE ts >= $1 AND ts <= $2 AND symbol IN ($3) ORDER BY ts, seq LIMIT 10000");
    expect(pg.params[2]).toBe("NSE:A'; DROP TABLE x;--");
    expect(createSqlTickStore({ query: async () => [], table: "t", placeholder: "question" }).sqlFor(q).sql).toContain("ts >= ? AND ts <= ?");
    expect(createSqlTickStore({ query: async () => [], table: "t", placeholder: "at" }).sqlFor(q).sql).toContain("ts >= @p1");
    const ns = createSqlTickStore({ query: async () => [], table: "t", timeAs: "ns" }).sqlFor(q);
    expect(ns.params[0]).toBe(BigInt(T0) * 1_000_000n);
  });

  it("refuses identifiers that are not plain names", () => {
    expect(() => createSqlTickStore({ query: async () => [], table: "ticks; DROP" })).toThrow(/not a plain identifier/);
    expect(() => createSqlTickStore({ query: async () => [], table: "t", columns: { ltp: "price)--" } })).toThrow(/column ltp/);
    expect(() => createSqlTickStore({ query: async () => [], table: "t", columns: { symbol: null } })).toThrow(/required/);
  });

  it("pages with keyset paging on (time, seq) across ties, without losing or repeating a row", async () => {
    const db = fakeDb(rows);
    const store = createSqlTickStore({ query: db.query, table: "ticks", pageSize: 4 });
    const got = await all(store.read({ fromMs: T0, toMs: T0 + 100 }));
    expect(got.map((t) => t.seq)).toEqual(rows.map((r) => r.seq));
    expect(db.calls.length).toBe(7);
    expect(got[0]).toMatchObject({ symbol: "NSE:B", ltp: 100, bidQty: 5, receivedAt: T0, exchangeTs: null, open: null });
    const onlyA = await all(store.read({ symbols: ["NSE:A"], fromMs: T0, toMs: T0 + 100 }));
    expect(onlyA.every((t) => t.symbol === "NSE:A")).toBe(true);
    expect(onlyA).toHaveLength(12);
  });

  it("reads a table without a seq column in one query", async () => {
    const db = fakeDb(rows.map(({ seq, ...r }) => r), { ts: "ts", seq: "none" });
    const store = createSqlTickStore({ query: db.query, table: "ticks", columns: { seq: null } });
    const got = await all(store.read({ fromMs: T0, toMs: T0 + 100 }));
    expect(got).toHaveLength(25);
    expect(got.map((t) => t.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(db.calls[0].sql).not.toContain("LIMIT");
  });
});

describe("array store", () => {
  it("fills every field and seq, and filters", async () => {
    const s = createArrayStore([{ symbol: "NSE:A", ltp: 1, receivedAt: 5 }, { symbol: "NSE:B", ltp: 2, receivedAt: 6 }]);
    expect(await all(s.read({ fromMs: 0, toMs: 10, symbols: ["NSE:B"] }))).toEqual([expect.objectContaining({ symbol: "NSE:B", seq: 2, bid: null })]);
  });
});
