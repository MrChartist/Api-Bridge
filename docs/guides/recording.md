# Recording: save prices and option chains as they happen

Brokers give you old candles, but they do not give you old option chains, old open-interest snapshots or old tick-by-tick prices. If you want those later, someone has to write them down while the market is open. The recorder does that for you, from the Bridge's own live data, into plain files on this computer.

- It saves **real-time data only**. If the only answer available is delayed or end-of-day, the recorder does not write it. It counts it, says why on the recording, and logs a gap. A file never mixes data of different quality.
- It starts **by itself** if you want: "every trading day, record NIFTY and BANKNIFTY option chains, ATM plus or minus 10, current weekly expiry, every 30 seconds, during market hours". Auto-record is **off until you turn it on**.
- It stays out of your way: it reads from the live feed first, then from the cache, and only then asks the broker, at the lowest priority and inside a share cap (see [Saving API calls](#saving-api-calls)).
- It stops writing before a disk limit is passed, and tells you first.

## Start in one minute

Open the dashboard, Data, Recordings, and press **Record index option chains**. Or from a terminal:

```
mc-bridge record preset index-option-chains     # adds the rule and turns auto-record on
mc-bridge record status                         # Recording today: 2 rules, 86 symbols, 38 KB, last write 12:29:44.
```

A manual recording, for example a price a second for two symbols:

```
mc-bridge record quotes NSE:NIFTY NSE:RELIANCE --every 1
mc-bridge record chain NIFTY --every 30 --expiry 2026-11-17 --strikes 10
mc-bridge record list
mc-bridge record show <id>
mc-bridge record stop <id>
```

The commands need an admin key (`--key`, or `MCB_ADMIN_KEY` in the environment) and the Bridge running on this computer.

## What is recorded

| Kind | What you give | What is saved | How often |
|---|---|---|---|
| `quotes` | symbols, a collection, or an underlying with a universe | price, bid, ask, quantities, volume, open interest, day open/high/low/close | `everySec`, at least 1 (from the live feed). Symbols the feed does not carry are read from the broker, which needs 5 seconds or more |
| `chain` | an underlying (with expiry and strikes), a collection, or option symbols | every leg of the chain: price, bid, ask, open interest and its change, volume, IV and Greeks when known, the spot price | `everySec`, at least 15 |

Strikes, expiries and the ATM are chosen like this:

- `expiries`: `current-weekly`, `next-weekly`, `current-monthly`, `all-weekly` (the next five weeks), or a list of dates. The expiry rolls on its own: the rule is worked out again each trading day.
- `strikes`: `{ "around": "atm", "count": 10 }` or `{ "from": 23000, "to": 25000 }`. The ATM comes from the real-time price and moves during the day. The window is looked at again every 30 minutes (`recorder.reResolveMinutes`); symbols are added, never dropped, so the day's files do not lose a strike when the price drifts.
- **No guessing.** If the price is delayed, stale or missing, the ATM window is not built from it. The recording waits, says why in its status, logs a gap "The symbols to record could not be chosen", and tries again every minute.
- A **collection** (from the library) is resolved again every day by the library. A resolution that rests on a delayed or end-of-day price is refused the same way.

## Market hours

By default a recording runs only inside the exchange session of each trading day. That comes from the Bridge's market calendar (holidays, weekends, special sessions such as Muhurat). For NSE, BSE, NFO and BFO it opens at the open and stops at the close by itself. Your own days and hours work too (IST, trading days only):

```
mc-bridge record rule add chain NIFTY --every 30 --days mon,tue,wed --start 09:30 --end 14:00
```

MCX and CDS have their own hours that the calendar does not hold. For them use `--all-day` or an explicit schedule. All-day recordings roll to a new file at IST midnight.

The calendar is a dated list, not a live feed from the exchange; the market calendar answers say when a holiday row is not verified. If the Bridge thinks a day is a holiday and it is not, check the exchange's circular and tell the Bridge with a custom schedule.

## Auto-record rules

A rule is "what to record, how often, when". Rules live in `recordings/rules.json` in the data folder, or in `recorder.autoRecord.rules` in the config file (those are read-only through the API).

```
POST /v1/recordings/rules
{
  "name": "Index option chains",
  "kind": "chain",
  "underlying": ["NIFTY", "BANKNIFTY"],
  "universe": { "expiries": "current-weekly", "strikes": { "around": "atm", "count": 10 }, "sides": ["CE", "PE"], "includeUnderlying": true },
  "everySec": 30,
  "schedule": "market-hours",
  "keepDays": 60
}
```

Rule fields: `id`, `name`, `enabled`, `kind`, one of `symbols` / `collection` / `underlying` (+ `universe`), `everySec`, `schedule` (`"market-hours"` or `{ days, start, end }`), `keepDays`, `maxDiskMb`, `compress`, `format`.

What the Bridge does with them, by itself:

1. At the session start it starts the rule's recording (bus event `recording.started`), chooses the symbols and subscribes them to the live feed.
2. At the session end it stops (`recording.stopped`, reason `session-end`).
3. The next trading day it chooses the symbols again: the expiry rolls, the ATM follows the price.
4. After a restart it picks up where it was. The time the Bridge was off is logged as a gap.
5. **No login at the session start?** It sends `account.login_needed` once that day (so the morning reminder and Telegram can tell you), logs a "login missing" gap, and starts writing as soon as a login or a feed is available.

Turn rules on and off with `mc-bridge record auto on|off`, `PUT /v1/recordings/auto`, or the dashboard. Turning auto-record off stops every rule's recording; the files stay.

### Presets

| Preset | What it adds |
|---|---|
| `index-option-chains` | NIFTY and BANKNIFTY chains, ATM plus or minus 10, current expiry, every 30 s, market hours |
| `my-watchlist` | every symbol of the collection `watchlist` (or another one: `--collection name`), one price a second from the live feed, market hours. Needs the library of collections |

Applying a preset creates its rule and turns auto-record on. Applying it again does not add a second copy.

## Status in plain words

`GET /v1/recordings/status`, `mc-bridge record status` and the dashboard show one line:

```
Recording today: 3 rules, 41 symbols, 18 MB, last write 09:31:02.
```

or what is wrong: `Auto-record is on: 3 recordings waiting for 10 Nov 09:15 IST.`, `; 1 gap today (one is open now)`, `; writing stopped on a disk limit`. Each recording has its own sentence (`statusText`), its counters, its gaps and its disk use.

## Gaps

A gap is a stretch inside a session when nothing was saved. Each one has a start, an end and a reason:

| Reason | Meaning |
|---|---|
| `login-missing` | no broker account was logged in |
| `feed-down` | the live feed was down and the broker could not be read instead |
| `feed-silent` | the feed sent nothing |
| `budget` | the broker's budget was in use by other work, or the broker asked the Bridge to slow down |
| `delayed-source` | the only data was delayed or end-of-day, which is never recorded |
| `universe-unresolved` | the symbols could not be chosen honestly (see above) |
| `bridge-stopped` | the Bridge was not running |
| `computer-asleep` | the computer was asleep, or the Bridge was frozen, so nothing could be recorded (not the broker's fault) |
| `disk-full` | a disk limit was reached |

A gap opens after silence of `recorder.gapAfterSec` (default three intervals, at least 30 seconds), except login-missing and disk-full, which open at once. They are kept in `gaps.jsonl` in the recording's folder, shown in `GET /v1/recordings/{recordingId}`, and sent as `recording.gap` events (`state` open, then closed). A quiet symbol that simply has not traded is not a gap: the feed is alive.

## Files

Everything is under the data folder, `recordings/<id>/`, where `<id>` is `rec_xxxxxxxx` for a manual recording and `rule-<ruleId>` for a rule. One file per symbol per IST trading day:

```
recordings/rule-index-option-chains/2026-11-09__NFO_NIFTY-2026-11-09-24000-CE.csv
recordings/rule-index-option-chains/2026-11-09__NSE_NIFTY.csv
recordings/rule-index-option-chains/2026-11-06__NSE_NIFTY.csv.gz       (a finished day, compressed)
recordings/rule-index-option-chains/recording.json                    what it is
recordings/rule-index-option-chains/state.json, index.json            counters and row counts (rebuilt if lost)
recordings/rule-index-option-chains/gaps.jsonl                        the gaps
```

The file name is `<YYYY-MM-DD>__<symbol with : written as _>.<csv|jsonl>[.gz]`. The date is the IST day the rows were sampled. Files are created readable by your user only.

Columns (CSV; JSON lines use the same names). Empty means "not known":

`time, symbol, ltp, bid, ask, bidQty, askQty, volume, oi, oiChange, open, high, low, close, iv, delta, gamma, theta, vega, spot, tickAt, source, class`

- `time`: when the sample was taken, ISO with `+05:30`.
- `tickAt`: when the price itself was last updated. A quiet symbol shows an older `tickAt` than `time`; nothing is hidden.
- `source`: `stream` (the live feed), `cache` or `broker`.
- `class`: always `realtime`.
- `spot`: the underlying's price in the chain snapshot. `iv` is in percent.

List and download files through the API (`GET /v1/recordings/{recordingId}/files`, `.../files/{name}`), the dashboard, or just open them in Excel or Python. A crash can leave the last line unfinished; the next write starts on a fresh line and readers skip the torn one.

### Reading them back

Anything that reads local data (history, downloads, datasets) can use `server/bridge/recorder/reader.mjs`:

```js
import { readRecorded } from "./recorder/reader.mjs";
const { rows, gaps, recordings } = readRecorded({ dataDir, symbol: "NSE:NIFTY", fromMs, toMs });
```

It reads plain and `.gz` files, orders the rows by time and returns the gaps inside the range, so the caller can ask the broker only for the gaps and the missing tail. Pandas: `pd.read_csv(path)` (or `read_json(path, lines=True)`).

## Disk safety and retention

| Setting | Default | What it does |
|---|---|---|
| `recorder.maxDiskMb` | 5000 | all recordings together |
| a recording's or rule's `maxDiskMb` | none | that recording only |
| `recorder.minFreeDiskMb` | 500 | stop when the disk has less free than this |
| `recorder.retentionDays` / `keepDays` | none | keep this many days of files (today included); older day files are deleted |
| `recorder.compressFinished` / `compress` | off | gzip the files of finished days |

At 90 % of a limit (and when free space is below twice the floor) the Bridge sends `recording.disk_low` with `level: "warning"`, once a day per limit. At the limit it **stops writing before passing it**: the sample that would not fit is dropped whole, the recording shows `blocked` with the reason, a gap `disk-full` opens and `recording.disk_low` is sent with `level: "stopped"`. It starts again when there is room (retention ran, you deleted something). Day files are tidied at start, at the first pass of each new day and every hour.

## Saving API calls

- **The live feed first.** Quotes and chain legs that the feed carries cost no broker call. The recorder subscribes the symbols it records (up to `recorder.maxStreamSymbols`, 400 per recording). Calls avoided are counted in the scheduler's savings and shown as `apiCalls.savedToday`.
- **Background priority, share cap.** When it does need the broker, a recording asks at the lowest ("background") priority and may use at most `recorder.maxBudgetShare` (default 0.3, from 0.05 to 0.8) of an account's spare budget. Change it while the Bridge runs with `PATCH /v1/recordings/settings` `{ "maxBudgetShare": 0.5 }` (admin key from this computer; read it with a `read` key, or on the Data page). It applies at the next broker read and is kept in `recordings/settings.json`; the config value is only the default. Recordings have no after-hours switch: they record during market hours. A live read, an order check or another key always goes first. If the broker asks the Bridge to slow down, broker reads pause for the time it names and the recording uses the live feed only; the missed samples are logged as a `budget` gap.
- **One chain call per expiry.** All the legs of an expiry come from one chain read, however many strikes you record.
- A chain recording never asks for data from a backup source (`allowBackup` is off): those are delayed or unofficial and never recorded.

## Settings

```json
"recorder": {
  "enabled": true,
  "maxRecordings": 10,
  "maxDiskMb": 5000,
  "retentionDays": null,
  "compressFinished": false,
  "minFreeDiskMb": 500,
  "maxBudgetShare": 0.3,
  "maxSymbolsPerRecording": 1000,
  "maxStreamSymbols": 400,
  "gapAfterSec": null,
  "reResolveMinutes": 30,
  "autoRecord": { "enabled": false, "rules": [] }
}
```

`maxRecordings` counts running, paused and waiting recordings, rules included.

## Routes and events

Reading needs a `read` key. Starting, changing or deleting a recording or a rule needs an admin key used from this computer (it uses this computer's disk and your broker's budget).

| Route | What |
|---|---|
| `GET /v1/recordings`, `POST /v1/recordings` | list, start a manual recording |
| `GET /v1/recordings/status` | the plain line and numbers |
| `GET /v1/recordings/{recordingId}`, `DELETE`, `POST .../pause`, `.../resume`, `.../stop` | one recording |
| `GET /v1/recordings/{recordingId}/files`, `.../files/{name}` | the day files |
| `GET/PUT /v1/recordings/auto` | the auto-record switch |
| `GET/POST /v1/recordings/rules`, `GET/PATCH/DELETE /v1/recordings/rules/{ruleId}` | rules |
| `GET /v1/recordings/presets`, `POST .../presets/{preset}/apply` | presets |

A recording that belongs to a rule is changed through the rule. Deleting a rule keeps its files unless you add `?deleteFiles=true`.

Bus topics (also in the notifications and event streams): `recording.started`, `recording.stopped`, `recording.gap`, `recording.disk_low`.

## Questions

**Why is a recording "waiting"?** Outside the session, on a holiday, or no login yet. Its sentence says which, and when it starts next.

**Can I record when the Bridge is off?** No. It records only while it runs. Run it on a computer that is on during market hours, or see [vps.md](vps.md).

**Why nothing for an illiquid option?** If it did not trade, there is no new price. Its rows carry the time of its last price (`tickAt`). Chains give a price per leg at each snapshot.

**Is this advice or analysis?** No. It saves data. What you do with it is your own work.
