# Data downloads

The Bridge can save history to files on this computer: candles for many symbols and intervals, as CSV, JSONL or an
AmiBroker import file. A download is a background job. It runs through the same rate-limit scheduler as everything else, at
the lowest priority, so it never slows a live read, an order check or another key.

## Start one

```bash
mc-bridge download NSE:NIFTY NSE:BANKNIFTY --interval 5m --from 2024-01-01 --watch
```

On this computer no key is needed. From a script, send the same thing to the API:

```bash
curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"symbols":["NSE:NIFTY"],"intervals":["5m"],"from":"2024-01-01"}' \
  http://127.0.0.1:4300/v1/downloads
```

The answer is `202` with the job. Poll `GET /v1/downloads/{id}` until `status` is `done`, then read `GET /v1/downloads/{id}/files`
and fetch each file from `GET /v1/downloads/{id}/files/{name}`.

Fields of the request: `symbols` (canonical, at most 500) or `collection` (a named list), `intervals`, `from`, `to`
(default now), `format` (`csv`, `jsonl` or `amibroker`), `layout` (`per-symbol` or `combined`), `dataset`, `account`,
`backup`, `afterHoursOnly`, `name`, `tags`.

## Know the cost first

`POST /v1/downloads?dryRun=1` (or `mc-bridge download ... --dry-run`) starts nothing and returns the estimate:
broker calls, rows, bytes, the time at your budget share, and whether it fits the disk limit. Parts that are already
stored on this computer cost no broker call and are counted as `callsSaved`. Rows assume every trading minute has a bar,
so a thin stock has fewer.

## Your API budget

- Downloads use at most `downloads.maxBudgetShare` of an account's budget (default 0.3, never more than 0.5). The
  per-second window is paced; every longer window (minute, day) keeps the rest free for live use and other keys.
- A live read, an order check or another key always goes first. While the broker is throttling, downloads wait.
- `downloads.afterHoursOnly` (or `afterHoursOnly` on one job) makes a job wait until the market is closed.
- Data already on this computer is not fetched again. See "Stored ranges" below. `GET /v1/limits?explain=1` shows
  `savedCalls`: calls not made today.

## Jobs

| Status | Meaning |
|---|---|
| `queued`, `running` | waiting for its turn, or working |
| `paused` | stopped by you (`reason: user`), by the kill switch (`kill_switch`) or because no broker login was available (`session_lost`) |
| `done` | every item finished |
| `failed` | some items failed, or the disk limit was reached; the finished files are kept. `resume` tries the failed items again |
| `cancelled` | stopped for good; finished files are kept |

- `POST /v1/downloads/{id}/pause`, `resume`, `cancel`; `DELETE /v1/downloads/{id}` removes the files (admin key, this computer).
- A job is saved after every window of one broker call. After a restart it continues from there (it comes back `queued`).
- A temporary broker error is tried again with a growing wait. An error that will not pass (an unknown symbol) fails that
  item only; the other items go on.
- A paused job continues by itself when the kill switch is released or an account is connected again.
- The bus topics are `download.progress` (about once a second), `download.done` and `download.failed`.

## Files and the manifest

Files are under `downloads/jobs/<id>/` in the data folder; you never choose a path. Each job has a `manifest.json`:

```json
{ "id": "dl_…", "name": "…", "status": "done", "request": {…},
  "files": [{ "name": "NSE_NIFTY_5m.csv", "symbol": "NSE:NIFTY", "interval": "5m", "rows": 18000, "bytes": 1116000,
              "firstBar": "2024-01-01T09:15:00.000+05:30", "lastBar": "…", "sha256": "…" }],
  "dataClass": "realtime", "source": "dhan", "official": true, "delaySec": null, "notes": [] }
```

Times are IST bar-open times. The bar that is still forming is never written, so a file holds only finished bars. Daily
and longer bars carry the date; they are stamped at IST midnight of that date.

**What the data class means.** `realtime` is history from your own broker account. `delayed` and `eod` come from other
data sources (only with `backup: true`) and are delayed or end-of-day. Every file download carries the headers
`X-Data-Class`, `X-Data-Source`, `X-Data-Official` and `X-Data-Delay-Sec`. Delayed and end-of-day data must never feed orders,
risk checks, paper fills or alerts.

Formats: `csv` is the same as `GET /v1/history?format=csv` (`time,open,high,low,close,volume,oi`); `combined` adds a
`symbol` column and writes one file per interval. `amibroker` is the layout of `/xl/history?layout=amibroker`, so the
shipped import formats read it. `jsonl` has one object per line.

## Datasets: update, do not download again

A job with `dataset: "nifty-5m"` writes into a named dataset, one file per symbol and interval. The next job for the same
dataset (or `POST /v1/datasets/nifty-5m/update`, or `mc-bridge download update nifty-5m`) continues from the last stored bar and
fetches only what is new. A dataset keeps one format and is always per-symbol.

`GET /v1/datasets` lists them (`?tag=` filters); `GET /v1/datasets/{name}` shows each file, its `coverage` (the stretch
fetched and stored with no failed call inside it) and its `gaps`: trading days with no bar and stretches of missing bars.
A gap is reported, never filled with a made-up bar: a thin stock has no 1-minute bar when nothing traded.
`PATCH /v1/datasets/{name}` renames a dataset or changes its tags and title. `DELETE` removes it (admin key, this computer).

## Stored ranges (local first)

- A download that is not for a dataset still reads a range from a dataset of this Bridge when one covers it, and asks the
  broker only for the rest (`downloads.localFirst`, on by default). The job's notes say which bars came from disk.
- `GET /v1/history?...&dataset=nifty-5m` reads from that dataset; `meta.source` is `local` (no broker call) or `mixed`, and
  the freshness says `provider: dataset:<name>` with the flag `local`. For plain history requests, `market.history.localFirst`
  (off by default) does the same for any dataset that covers the range. Intraday bars are identical to the broker's.
- Stored bars keep the data class they were written with; they are never relabelled realtime.

## Collections

Give `collection: "<name>"` instead of `symbols`. The Bridge asks the library for the symbols when the job starts. If the
library cannot say (for example the price for the ATM strike is delayed), the job is refused with that reason; nothing is guessed.

## Instrument master as a file

`GET /v1/instruments/export?exchange=NFO&kind=OPT&format=csv` streams the instrument master (`csv` or `jsonl`).

## Limits and settings

```json
"downloads": { "enabled": true, "maxConcurrentJobs": 1, "maxSymbolsPerJob": 500, "retentionDays": null,
               "maxDiskMb": 5000, "minFreeDiskMb": 500, "maxQueuedJobs": 20, "maxQueuedJobsPerKey": 8,
               "maxStoredJobs": 500, "pauseOnKeyRevoked": true, "maxBudgetShare": 0.3, "afterHoursOnly": false, "localFirst": true }
```

- `maxDiskMb`: writing stops at this size of the downloads folder; the job fails with `reason: disk_limit` and resumes once there is room.
  A job that would not fit is refused up front.
- `retentionDays`: finished jobs older than this are deleted with their files. Datasets are never deleted by retention.
- Jobs need the `read` scope (and the accounts the key may use). Deleting needs an admin key from this computer.
- `minFreeDiskMb` (500): a job pauses with `reason: disk_low` before the disk that holds the data folder drops under this, and continues
  by itself once there is clearly more room. A job that would leave less than this free is refused up front. `0` switches it off.
- `maxQueuedJobs` (20) and `maxQueuedJobsPerKey` (8): jobs that are waiting, running or paused. A new job over either answers `429`. One key
  cannot take every place. `maxStoredJobs` (500) bounds finished jobs too; delete old ones or set `retentionDays`.
  The disk check counts what the waiting jobs are still expected to write, not only what is on disk.
- Who may change what: a job belongs to the key that started it (`createdBy`). Only that key, or an admin key, may pause, resume, cancel or
  rename it. The same holds for a dataset: only its creator or an admin may write into it with a new job, rename it or tag it. Any read key can read
  both and can ask for a dataset's update (it runs the stored request, nothing the caller chose). Another job never rewrites what a dataset updates from.
- `pauseOnKeyRevoked` (true): when a key is revoked, its open jobs are paused (`reason: key_revoked`); an admin can resume or cancel them.
- Starting, pausing, resuming, cancelling, renaming and deleting are written to the audit log (`download.*`, `dataset.*`).
- Every broker call carries the scheduler's floor, so live traffic that spends the budget between the pacer's check and the call is never pushed
  under half of any window. The file of a dataset job carries the dataset's own labels (its worst class), not the older job's.

## Command line

```
mc-bridge download <symbols...> --interval 5m --from 2024-01-01 [--to ...] [--format csv|jsonl|amibroker] [--dataset name]
                   [--layout combined] [--collection name] [--account id] [--backup] [--dry-run] [--watch] [--json]
mc-bridge download list | show <id> | pause <id> | resume <id> | cancel <id> | delete <id>
mc-bridge download files <id> [--out folder]     saves the files and checks every checksum
mc-bridge download datasets | update <dataset>
```
