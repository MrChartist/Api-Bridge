# Running the Bridge day to day

What the Bridge does to stay up, what it tells you when something is wrong, and what to do about it. Everything here is for
a Bridge on your own computer or server. Run `mc-bridge doctor` any time: it reads the data folder (the Bridge does not need
to be running) and says what needs attention. `mc-bridge doctor --strict` also exits with 1 for the serious ones, so a
scheduler or a monitor can act on it.

## One Bridge per data folder

The Bridge keeps a small file, `bridge.lock`, in its data folder while it runs. A second Bridge on the same folder is refused:

```
Error: Another Bridge (process 4312, port 4300, started 2026-11-10 09:12) is using this data folder (...).
Two Bridges on one folder lose each other's changes and repeat order numbers. Stop the other one ...
```

Two Bridges on one folder would overwrite each other's files, hand out the same paper order numbers, count the daily limits
twice and leave `mc-bridge kill` talking to only one of them. The lock names the process id and port of the holder.

A lock left by a Bridge that crashed is taken over by the next start: the process no longer exists, or its id now belongs to
another program, or (where the system cannot say) nobody has touched the file for two minutes. A laptop that slept for an
hour keeps its lock. If you are sure no Bridge is running and the message still appears, delete `bridge.lock`. `mc-bridge doctor`
shows who holds it. It works with Windows folders (`C:\Users\...`) like any other.

## Stopping

Ctrl+C, closing the terminal or console window, and a termination signal (`systemctl stop`, `docker stop`) all stop the Bridge the
same way: it writes down what it was doing (download jobs, recordings, the webhook queue), removes its lock and control token,
and logs `stopped in N ms`. A stop that is not finished in 10 seconds is cut off and logged. A second Ctrl+C exits at once. A
stray error is logged, the Bridge saves what it can for up to 3 seconds and exits (a service manager restarts it).

Downloads continue after a restart from their last saved window. Recordings resume by themselves. Webhook deliveries that were
being sent are sent again (receivers de-duplicate on the event id).

## A damaged file

A power cut or a full disk can leave a state file empty or cut off. Every store handles that the same way: the file is moved aside
as `<name>.corrupt-<time>` (you can still look at it), a warning names it, the Bridge starts without it, and the fact is shown in
`GET /v1/health` (`problems`), `mc-bridge doctor` and as the event `data.quarantined`. What it means for each:

| File | What happens |
|---|---|
| `hooks.json` (alert hooks) | The Bridge starts with no hooks; create them again (their URLs are gone with the file) |
| `orders/state.json` (record of sent orders) | **Paper orders keep working. Live orders are refused** (`ORDER_STATE_DAMAGED`) until you have looked at your broker's order book and run `mc-bridge orders acknowledge-state`. Without the record the Bridge cannot tell whether a retried alert was already sent |
| `recordings/<id>/recording.json` | The recording stays in the list as "damaged" with its day files; delete it or start a new one |
| `downloads/jobs/<id>/job.json` | The job stays in the list as failed ("damaged"); its files count towards the disk limit, so delete it to free the space |
| webhook subscriptions, event log | Lines that cannot be read are skipped, a copy of the file is kept and the loss is reported |
| collections, readiness state, source settings, paper books, notification outbox | The file is set aside and the store starts empty |

A damaged safety state or keys file already fails closed: the kill switch engages, and every API key is refused until it is fixed.

Writes use one careful routine everywhere (temporary file, flush to disk, rename, with a short retry for Windows when an
antivirus scanner holds the file). Temporary files a cut-off write left behind are removed at the next start.

## Disk space

The Bridge measures free space where the data folder is, every 30 seconds:

| Free space | What it does |
|---|---|
| below `storage.minFreeMb` (default 1024) | `GET /v1/health` says `degraded` with a plain message; the event `storage.status` says `low` |
| below `storage.hardFreeMb` (default 200) | downloads pause (reason `disk_low`) and no new one starts; `GET /v1/ready` answers 503; the recorder has its own floor (`recorder.minFreeDiskMb`) |

A file that could not be written (a state file, a paper book) is counted: `/v1/health` shows `storage.writeErrors` and says `degraded`
until the file is written again. A request that fails because the disk is full gets `DISK_FULL` (HTTP 507) with the fix, not "Internal
error". **A paper order is never accepted unless it was saved**: on a full disk it is refused with `DISK_FULL`, nothing is placed, the
order number is not used up. A live order is never sent unless its order record and its audit record could be written.
Free space by deleting old downloads and recordings on the Data page (`downloads.retentionDays`, `recorder.retentionDays` do it
by themselves).

## Health, readiness and numbers

- `GET /v1/health`: `status` is `ok` or `degraded` (always HTTP 200). On this computer it also lists `problems` (low disk, files that could not be
  saved, damaged files set aside, damaged order records, the kill switch on) and `storage`.
- `GET /v1/ready`: 200 when the Bridge has finished starting and can save, 503 otherwise. Use it for a Docker health check or a script that waits.
- `GET /v1/metrics` (admin key, this computer only): Prometheus text with uptime, memory, open file handles, event-loop delay, requests by
  status class, free disk, failed writes, files set aside, last backup age, webhook queue sizes, download and recording figures. Counters and
  gauges only: no symbol, key or account id.

## Logs

The running Bridge keeps `logs/bridge.log` in its data folder (one JSON line per record), rotated at 10 MB with the newest 5 old files
compressed (`bridge.log.1.gz` ...). In Docker it logs to the console only (`docker logs`). Settings under `logging`:

| Setting | Default | Meaning |
|---|---|---|
| `level` | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `requests` | `errors` | Which requests get an access line: `errors` (status 400 and above, and requests slower than 1 s), `all`, `off` |
| `file` | on for `mc-bridge start` (off in Docker) | Also write the log file |
| `maxFileMb`, `keepFiles` | 10, 5 | Rotation |

A webhook that keeps failing is reported on its first failure and then once a minute with the count, not once per attempt. A log
destination that fails (a full disk, a closed console) never stops the Bridge.

## Webhooks that do not answer

Each webhook subscription has its own delivery slots (`events.webhooks.perSubscription`, default 2), so a receiver that never answers delays
only itself. After `events.webhooks.breakerAfter` (default 3) failures in a row where nothing answered, the subscription is tried once per
backoff period instead of once per event. Deliveries whose signing secret is missing (after a restore) wait in the queue instead of being thrown
away. `mc-bridge doctor` lists failing subscriptions, dead letters and the age of the oldest queued delivery.

## Sleep and wake

The Bridge notices when the computer slept (or the process was frozen) and when the clock jumped: events `system.resumed` and
`system.clock_changed`. A recording that missed data because the computer slept labels the gap `computer-asleep` instead of blaming the
broker; readiness checks the broker session and IP again; the webhook queue reschedules.

## The audit log

A client that keeps retrying a refused order adds one record per minute with a count (`suppressed`), not one per retry. `mc-bridge doctor`
shows the audit log's size.
