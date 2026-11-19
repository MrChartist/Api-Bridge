# Tick research: record every tick, write a signal once, prove history equals live

The [recorder](recording.md) keeps a snapshot every few seconds, which is right for option chains and for reading prices back in Excel. Research on ticks needs more: **every** tick, in the order it arrived, and a way to show that a signal computed on stored data gives exactly what it gives live. This guide covers the pieces that do that. All of them are opt-in, and none changes how the rest of the Bridge works.

```
 live feeds (the 41 broker adapters) ─► StreamHub ──"tick"──► tick log            bounded memory, nothing dropped silently
                                                                   │
 stored ticks, read in place: tick log · recordings · any SQL store (DuckDB on Parquet/S3, PostgreSQL, QuestDB, ClickHouse ...)
          │                                                  │
          ▼ runHistorical: one batch                          ▼ replay adapter ─► the real StreamHub ─► runLive: streaming
   historical outputs ─────────────► compareRuns, tick by tick ◄───────────── live outputs
                                            │
                                     "Identical: 1,734 outputs match tick by tick."
```

The code is in `server/bridge/ticks/` (`import { ... } from "./server/bridge/ticks/index.mjs"`).

## 1. Record every tick

Turn the tick log on in `bridge.config.json`:

```json
"ticks": { "record": true, "symbols": ["NSE:NIFTY", "NSE:BANKNIFTY"], "keepDays": 30 }
```

| Key | Default | Meaning |
|---|---|---|
| `record` | `false` | write every tick to `data/ticks/<YYYY-MM-DD>.ticks.jsonl` |
| `symbols` | `null` | `null` keeps every symbol the live feed carries. A list keeps only those, and the Bridge subscribes them itself so they are recorded even when nothing else watches them |
| `maxBufferedTicks` | `5000` | ticks held in memory at most before a write |
| `flushEveryMs` | `250` | write at least this often |
| `keepDays` | `null` | delete days older than this |

What it promises:

- **Bounded memory.** When the buffer is full, it is written before the next tick is taken. Under load the Bridge slows down a little; memory does not grow.
- **Nothing dropped silently.** Each tick gets a `seq` (1, 2, 3 ... per IST day, kept across restarts). If the disk refuses writes, ticks stay buffered up to twice the limit. Past that, the oldest are given up, counted (`bridge_ticks_lost_total` in `/metrics`) and logged. The missing seq numbers show as a hole in the file, so loss can always be found later:

  ```js
  const { complete, days } = await auditTickLog({ root: "data/ticks" });
  // days[0] = { date, ticks, firstSeq, lastSeq, holes: [{ from, to }], bad }
  ```
- **Arrival order is the order.** `seq` is the order the Bridge received ticks across all symbols, which is exactly the order a live signal saw them. Wall-clock time can step backwards (NTP); seq cannot.
- **No account ids in the file.** A tick log can be handed to someone else for research.

One line per tick, short keys because tick logs are large: `q` seq, `t` receivedAt (epoch ms), `x` exchange time, `s` symbol, `p` ltp, `b`/`a` bid/ask, `bq`/`aq` their quantities, `v` volume, `oi`, `o h l c`, `k` broker. Unknown fields are left out. Finished days can be gzipped (`.ticks.jsonl.gz`); readers handle both.

The sampling recorder and the tick log are separate on purpose: the recorder's snapshots stay small and cheap for every-day use, while the tick log is for the symbols you research.

## 2. Read stored ticks in place

A **TickStore** is one small interface: `{ id, kind, read({ symbols, fromMs, toMs }) }`, which yields ticks in replay order. Nothing is imported or copied first.

```js
import { createTickLogStore, createRecordingStore, createSqlTickStore } from "./server/bridge/ticks/index.mjs";

const ticklog = createTickLogStore({ root: "data/ticks" });
const samples = createRecordingStore({ dataDir: "data" });   // the recorder's files; kind "samples", not every tick
```

**Any other store goes through your own driver.** The Bridge has no database dependency. You pass a `query(sql, params)` function, and the Bridge builds one parameterised SELECT and reads it page by page (keyset paging on time and seq, so memory stays bounded):

```js
// PostgreSQL / TimescaleDB (also QuestDB through its PostgreSQL port)
import pg from "pg";
const pool = new pg.Pool();
const store = createSqlTickStore({ table: "market.ticks", placeholder: "dollar", query: async (sql, p) => (await pool.query(sql, p)).rows });

// DuckDB: Parquet files, local or on S3, read in place
const store = createSqlTickStore({ table: "ticks", placeholder: "question", query: duckdbQuery });
//   with   CREATE VIEW ticks AS SELECT * FROM read_parquet('s3://my-bucket/ticks/*.parquet')

// SQL Server: placeholder "at" (@p1, @p2 ...). ClickHouse, SQLite, Snowflake: "question".
```

| Option | Default | Meaning |
|---|---|---|
| `table` | (required) | a plain or qualified name (`schema.table`) |
| `columns` | `ts, seq, symbol, ltp, bid, ask, bid_qty, ask_qty, volume, oi, exchange_ts` | override any name; `null` for a column the table does not have |
| `placeholder` | `"dollar"` | `"dollar"` ($1), `"question"` (?), `"at"` (@p1) |
| `timeAs` | `"date"` | how the time column is stored: `"date"` (a timestamp), `"ms"`, `"s"`, `"us"`, `"ns"` |
| `pageSize` | `10000` | rows per query |

Table and column names are checked to be plain identifiers, and every value is a parameter. Column names are matched ignoring case, because PostgreSQL returns them in lower case and Snowflake in upper case. Without a `seq` column the whole range is read in one query, and ties on time keep the order the store returns; add a sequence column if ties matter to you.

kdb+ users can read through its PostgreSQL interface the same way.

## 3. Write the signal once

A signal is a factory of one incremental function. The historical run and the live run call **the same function**, tick by tick, in the same order. There is no second, vectorised version to keep in step.

```js
import { defineSignal, asof, windowSum, ema, microprice } from "./server/bridge/ticks/index.mjs";

export const niftyVsBank = defineSignal({
  name: "nifty-vs-bank",
  symbols: ["NSE:NIFTY", "NSE:BANKNIFTY"],
  create() {
    const last = asof({ toleranceMs: 2000 });      // as-of join
    const ratio = windowSum({ spanMs: 60_000 });   // window sums
    const fair = ema({ halfLifeMs: 15_000 });
    return (tick, { time }) => {
      last.set(tick.symbol, time, tick.ltp);
      if (tick.symbol !== "NSE:NIFTY") return undefined;     // no output for this tick
      const bank = last.get("NSE:BANKNIFTY", time);
      if (bank === null) return undefined;
      ratio.push(time, tick.ltp / bank);
      return { mean: ratio.mean(time), fair: fair.push(time, microprice(tick) ?? tick.ltp) };
    };
  },
});
```

Building blocks:

| Operator | What it does |
|---|---|
| `asof({ toleranceMs })` | latest value of each key at or before a time, if not older than the tolerance. Never a value from the future; ties are settled by arrival order |
| `windowSum({ spanMs })` | sum, count, mean and variance over `(time - spanMs, time]`, with compensated sums so a sliding window does not drift over a long day |
| `windowExtremes({ spanMs })` | rolling max and min |
| `ema({ halfLifeMs })` | moving average in event time, correct for irregular ticks |
| `deltaOf()` | cumulative day volume or OI to per-tick change; null on a reset, never a negative volume |
| `mid`, `spread`, `microprice`, `imbalance`, `logReturn` | tick features; null without a sane two-sided quote |

Three rules keep a signal deterministic. The comparison catches any break of them.

1. Use `ctx.time` for anything time-based: never `Date.now()`, timers or `Math.random()`.
2. Keep all state inside `create()`: each run gets a fresh copy.
3. Return plain data.

`ctx.time` is the tick's `receivedAt` by default (recorded and replayed exactly). `defineSignal({ time: "exchangeTs" })` uses the exchange's time instead, skipping ticks that do not carry it.

## 4. Run it historically, and live

```js
import { runHistorical, runLive, compareRuns } from "./server/bridge/ticks/index.mjs";

const historical = await runHistorical(niftyVsBank, ticklog, { fromMs, toMs });   // one batch
const live = await runLive(niftyVsBank, streamHub);                                // streaming, from the StreamHub
```

Stored ticks go through the StreamHub's own normaliser (`quoteToTick`) before they reach the signal. A historical tick therefore has the same shape and filtering as a live one; for example, a zero price is dropped on both sides.

## 5. Replay through the live path, and compare

The replay is a feed adapter with the same `createFeed(creds, { onTick, onStatus })` contract every broker adapter has. The real StreamHub runs on it unchanged, so the client path (`attachSink` and `subscribe`, used by the WebSocket and SSE endpoints) is exercised as in production. The replay drives a virtual clock that it sets to each tick's recorded time before handing it over. The hub stamps `receivedAt` from that clock, so live event times equal the stored ones.

```js
const clock = createReplayClock();
const replay = createReplayAdapter({ store: ticklog, range: { fromMs, toMs }, clock, refFor, speed: Infinity });
// a StreamHub built with deps.clock = clock and one account whose adapter is replay.adapter
const live = await runLive(niftyVsBank, hub);
await replay.start();                        // every stored tick, in order; speed: 1 is real time
const result = compareRuns(historical.outputs, live.outputs);
result.summary   // "Identical: 1734 outputs match tick by tick."
```

Use the replay clock only in a simulation process, never in a Bridge that trades.

When the runs differ, `compareRuns` says how, which usually names the cause:

| Kind | Usually means |
|---|---|
| `missing` | live never produced an output history did: a tick that did not arrive, a symbol that was dropped |
| `extra` | the reverse: a tick the store does not have |
| `value` | same tick, different value: state shared between runs, `Date.now()` or randomness in the signal |
| `order` | the same outputs in another order: ticks delivered differently from how they were recorded |

`firstDivergence` points at the earliest one. Comparison is exact by default; `compareRuns(a, b, { tolerance: 1e-9 })` accepts tiny numeric differences when you compare against an outside system.

`server/bridge/ticks/parity.e2e.test.mjs` runs this whole loop on 6,000 ticks through the real StreamHub: tick log, store, historical run, replay, live run, and an identical comparison. It also shows that a leaky signal and a lost subscription are caught.

## Limits

- The tick log records what the broker's feed sends. Brokers conflate ticks before they reach you, so "every tick" means every tick the feed delivered, not every exchange trade.
- Depth (market-by-price levels) is not written to the tick log yet.
- Samples from the recorder (`createRecordingStore`) can be researched too, but they are not every tick: the store says `kind: "samples"`.
