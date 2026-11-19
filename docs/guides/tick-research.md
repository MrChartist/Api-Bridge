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

The code is in `server/bridge/ticks/` (`import { ... } from "./server/bridge/ticks/index.mjs"`). From the terminal, `mc-bridge ticks` covers the everyday steps (see [the command](#the-command)).

## In one minute

```
# bridge.config.json: "ticks": { "record": true, "symbols": ["NSE:NIFTY", "NSE:BANKNIFTY"] }
mc-bridge ticks status                                   # what is recorded
mc-bridge ticks audit                                    # every tick there? (holes in seq, torn lines)
mc-bridge ticks run ./signals/nifty-vs-bank.mjs --from 2026-11-18 --out run.jsonl
mc-bridge ticks verify ./signals/nifty-vs-bank.mjs --from 2026-11-18
#   ✓ deterministic (history run twice): Identical: 1734 outputs match tick by tick.
#   ✓ replay through the live StreamHub: Identical: 1734 outputs match tick by tick.
#   Identical: history and live agree tick by tick.
```

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
| `depthLevels` | `0` | order-book levels per side to keep with each tick, when the feed sends depth (0 to 20). Depth makes files several times larger |
| `compressFinished` | `false` | gzip each finished day (about ten times smaller) |
| `maxDiskMb` | `null` | all days together at most this |
| `minFreeDiskMb` | `500` | keep at least this much free on the disk |

What it promises:

- **Bounded memory.** When the buffer is full, it is written before the next tick is taken. Under load the Bridge slows down a little; memory does not grow.
- **Nothing dropped silently.** Each tick gets a `seq` (1, 2, 3 ... per IST day, kept across restarts). If the disk refuses writes, ticks stay buffered up to twice the limit. Past that, the oldest are given up, counted (`bridge_ticks_lost_total` in `/metrics`) and logged. The missing seq numbers show as a hole in the file, so loss can always be found later:

  ```js
  const { complete, days } = await auditTickLog({ root: "data/ticks" });
  // days[0] = { date, ticks, firstSeq, lastSeq, holes: [{ from, to }], bad }
  ```
- **Arrival order is the order.** `seq` is the order the Bridge received ticks across all symbols, which is exactly the order a live signal saw them. Wall-clock time can step backwards (NTP); seq cannot.
- **Disk limits are never passed.** A write that would pass `maxDiskMb` or `minFreeDiskMb` is held like a failing disk, then given up and counted with the reason `DISK_LIMIT` or `DISK_LOW`; it goes on by itself when there is room.
- **No account ids in the file.** A tick log can be handed to someone else for research.
- **Cheap.** Measured on 1,000,000 ticks over 200 symbols: 2.8 µs a tick to write (about 360,000 ticks a second, far above any Indian feed), 133 bytes a tick, 14 MB a million ticks once gzipped.

One line per tick, short keys because tick logs are large: `q` seq, `t` receivedAt (epoch ms), `x` exchange time, `s` symbol, `p` ltp, `b`/`a` bid/ask, `bq`/`aq` their quantities, `v` volume, `oi`, `o h l c`, `k` broker, and `d` the depth (`[bids, asks]`, each level `[price, qty, orders]`) when `depthLevels` is set. Unknown fields are left out. Finished days can be gzipped (`.ticks.jsonl.gz`, by `compressFinished` or `mc-bridge ticks compress`); readers handle both.

The files are plain JSON lines, so other tools read them directly. DuckDB, for example (an example to adapt, not something the Bridge runs):

```sql
SELECT s AS symbol, count(*) AS ticks, min(p) AS low, max(p) AS high
FROM read_json_auto('data/ticks/2026-11-18.ticks.jsonl*') GROUP BY s;
```

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

**Several stores as one.** `mergeStores([archive, ticklog])` reads them as one stream in replay order (by time; on a tie the store given first wins), streaming each, never loading one whole. Give it stores that do not overlap in time, such as a SQL archive up to yesterday and the tick log from today. Each tick says which store it came from (`store`, `storeSeq`).

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

The replay is a feed adapter with the same `createFeed(creds, { onTick, onStatus })` contract every broker adapter has. The real StreamHub runs on it unchanged, so the client path (`attachSink` and `subscribe`, used by the WebSocket and SSE endpoints) is exercised as in production. The replay drives a virtual clock that it sets to each tick's recorded time before handing it over. The hub stamps `receivedAt` from that clock, so live event times equal the stored ones. Depth recorded with the ticks is replayed too.

```js
const { hub, replay, close } = createReplayHub({ store: ticklog, range: { fromMs, toMs } });   // the real StreamHub on a replay
const live = await runLive(niftyVsBank, hub);
await replay.start();                        // every stored tick, in order; { speed: 1 } plays in real time
close();
const result = compareRuns(historical.outputs, live.outputs);
result.summary   // "Identical: 1734 outputs match tick by tick."
```

`createReplayHub` starts nothing else of the Bridge, touches no data folder and uses no network; replay runs at about 235,000 ticks a second. For a hub you build yourself, `createReplayAdapter` and `createReplayClock` are the pieces underneath. Use the replay clock only in a simulation process, never in a Bridge that trades.

## 6. All checks at once

`verifySignal(signal, store, range, { liveOutputs, tolerance })` (and `mc-bridge ticks verify`) answers "can I trust this signal live?" in three checks of growing reach:

| Check | Catches |
|---|---|
| **deterministic**: the historical run, twice | `Date.now()`, `Math.random()`, state kept outside `create()`. Cheap: run it on every change to a signal |
| **replay**: history against a replay through the real StreamHub | anything the live path does differently: normalising, ordering, subscriptions |
| **saved live run** (`liveOutputs`): history against outputs saved during a real live day | ticks the live run never saw |

`ok` is true only when every check that ran is identical.

### Saving a real live run

The last check is the one that matters in production: the signal ran live today, and the tick log recorded the same ticks. Save its outputs as it runs, then compare them with history after the close:

```js
const log = createOutputLog({ path: "signals/nifty-vs-bank/2026-11-18.outputs.jsonl" });
const runner = createSignalRunner(niftyVsBank, { onOutput: log.append, keep: false });
// feed runner.push(tick) from runLive(...) inside the Bridge, or from your own WebSocket client (below)
log.close();
```

```
mc-bridge ticks verify ./signals/nifty-vs-bank.mjs --from 2026-11-18 --live signals/nifty-vs-bank/2026-11-18.outputs.jsonl
```

**A signal in another process, over the WebSocket.** WebSocket tick frames carry `receivedAt`, so a runner fed from `/v1/stream` sees the same event times as the tick log, as long as the client subscribes in `quote` mode (or `depth`, for depth) so it gets the same fields. One difference matters: to protect memory, the WebSocket keeps only the **latest** tick per symbol for a client that reads too slowly (the heartbeat's `conflated` count says how many were replaced). A conflated client missed ticks, so its outputs show up as `missing` in the comparison. That is the comparison doing its job. Keep the client fast, or run the signal in the same process as the hub.

## The command

`mc-bridge ticks` works on the files in the data folder; the Bridge does not need to be running.

| Command | What it does |
|---|---|
| `ticks status` | settings, and each day recorded with its size |
| `ticks audit [--from <day>] [--to <day>]` | holes in seq, torn or bad lines; exit code 1 when not complete |
| `ticks compress` | gzip finished days (never today's) |
| `ticks run <signal.mjs> --from <day> [--to <day>] [--out <file>] [--store ticklog\|recordings]` | a historical run; `--out` saves the outputs as an output log |
| `ticks verify <signal.mjs> --from <day> [--to <day>] [--live <file>] [--tolerance <n>]` | the three checks above; exit code 1 when not identical, so it can gate a deploy |

`--from` and `--to` take an IST day (`2026-11-18`) or a time (`2026-11-18T09:15:00+05:30`); `--to` defaults to the end of the `--from` day. A signal file exports a `defineSignal(...)` result, as default or by name (`--name`). It runs with your permissions, like any script you start yourself: only run files you wrote or trust.

When the runs differ, `compareRuns` says how, which usually names the cause:

| Kind | Usually means |
|---|---|
| `missing` | live never produced an output history did: a tick that did not arrive, a symbol that was dropped |
| `extra` | the reverse: a tick the store does not have |
| `value` | same tick, different value: state shared between runs, `Date.now()` or randomness in the signal |
| `order` | the same outputs in another order: ticks delivered differently from how they were recorded |

`firstDivergence` points at the earliest one. Comparison is exact by default; `compareRuns(a, b, { tolerance: 1e-9 })` accepts tiny numeric differences when you compare against an outside system.

`server/bridge/ticks/parity.e2e.test.mjs` runs this whole loop on 6,000 ticks through the real StreamHub: tick log, store, historical run, replay, live run, and an identical comparison. It also shows that a leaky signal and a lost subscription are caught. `socket.e2e.test.mjs` goes one step further, through the WebSocket client protocol behind `/v1/stream` with every frame passed through JSON as on the wire: identical again, and a client that stops reading shows up as missing outputs.

## Limits

- The tick log records what the broker's feed sends. Brokers conflate ticks before they reach you, so "every tick" means every tick the feed delivered, not every exchange trade.
- Depth is kept only when `depthLevels` is set and the broker's feed sends it.
- `mergeStores` does not remove a tick that two overlapping stores both hold.
- Samples from the recorder (`createRecordingStore`) can be researched too, but they are not every tick: the store says `kind: "samples"`.
