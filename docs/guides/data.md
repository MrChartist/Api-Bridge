# Saving data: downloads, recordings, collections and datasets

> Commands here start with `mc-bridge`. In a git checkout, run them as `npm run bridge -- <command>` instead ([why](README.md#running-mc-bridge)).

The Bridge can keep data for you as plain files on your own computer. This page ties the four parts together, says which one to use
for what, and walks through three jobs from start to finish. Each part has its own guide with every option:
[downloads.md](downloads.md), [recording.md](recording.md), [collections.md](collections.md).

## Which part for which data

| You want | Use | Why |
|---|---|---|
| Old candles (1 minute to daily) for some symbols | **Download** | Brokers keep history. The Bridge fetches it in the background and writes CSV, JSONL or an AmiBroker import file |
| The same candles, kept up to date | **Dataset** (a download with a `dataset` name) | The next run fetches only what is new, from the last stored bar |
| Old option chains, open-interest snapshots, tick-by-tick prices | **Recording** | Brokers do not keep these. Someone has to write them down while the market is open, so the Bridge does it from its own live data, going forward |
| The same list of symbols in every job, or "NIFTY weekly, ATM plus or minus 10" that rolls by itself | **Collection** | A named, tagged list. Downloads, recordings, sheets and Python all accept `collection: "<name>"` |

What none of them can do: give you a chain, open interest or ticks from **before** you started recording, or data for a day the Bridge
was not running (a recording logs that as a gap instead of inventing it).

## What you get, and what it says about itself

- **One data class per file**: `realtime`, `delayed` or `eod`, with the source and the delay. A download from your own broker is
  `realtime`. A free source can fill in only when you ask for it (`backup: true`), and its files say `delayed` or `eod`. A recording
  never writes delayed or end-of-day data: it logs a gap instead. Delayed and end-of-day data must never feed an order, a risk check, a
  paper fill or an alert.
- **Finished bars only.** The bar that is still forming when a download runs is left out. Times are IST bar-open times.
- **Gaps are reported, never filled.** A dataset lists its gaps (days with no bar, stretches of missing bars); a thin stock has no
  1-minute bar when nothing traded. A recording keeps a gap list with the reason (login missing, feed down, computer asleep, disk full).
- **Where the files are.** Under the data folder (`mc-bridge doctor` prints it): `downloads/jobs/<id>/`, `downloads/datasets/<name>/`
  and `recordings/<id>/`. You never choose a path through the API. Download them with `mc-bridge download files <id>` (it checks every
  checksum), through the API, from the dashboard's **Data** page, or just open the folder.
- **A normal backup leaves them out.** They can be many gigabytes and can be fetched or recorded again. `mc-bridge backup --include-data`
  adds them ([backup.md](backup.md)).

## Your API budget stays yours

Background work never takes the budget a live read, an order check or another key needs.

- A download or a recording uses at most `downloads.maxBudgetShare` / `recorder.maxBudgetShare` of an account's spare request budget
  (0.3 by default, from 0.05 to 0.8) and yields at once when something else needs it. Downloads can also wait for after market hours
  (`downloads.afterHoursOnly`). Both are in [config.md](config.md#downloads) and can be changed while the Bridge runs.
- **Look before you start:** `mc-bridge download ... --dry-run` starts nothing and prints the rows, the size, the number of broker calls
  and the time at your share. Parts you already have on this computer cost no call.
- **Local first.** A range that is already stored is read from disk, and only the missing tail or the gaps go to the broker. This is
  on for downloads and dataset updates (`downloads.localFirst`). For reading, name the dataset:
  `GET /v1/history?symbol=...&interval=5m&dataset=<name>` answers from disk with `meta.source: "local"` and `meta.brokerCalls: 0`
  (`"mixed"` when it had to ask for a missing tail). A plain `GET /v1/history` does the same only if you turn on
  `market.history.localFirst`, which is off by default.
- **Calls saved** are counted: `GET /v1/limits?explain=1` shows `savedCalls` (by reason, and what the stream and cache served), and the
  Data page says "API calls saved today".

## Recipe 1: two years of 5-minute bars for a watchlist

Result: one dataset, `watchlist-5m`, with a CSV file per symbol that you can read in Python and that you can update with one command
each evening (recipe 3).

**1. Make the list once.** A read key is enough to make and change a collection. Put the key in `MCB_API_KEY`
([quickstart.md](quickstart.md) makes one). In demo mode the key from the quickstart works.

**2. Estimate, then download.** Use a date two years back. The estimate costs nothing; the download runs in the background and
`--watch` shows its progress.

<!-- runs against a demo Bridge in scripts/guide-recipes.test.mjs -->
```sh
mc-bridge collections create watchlist --symbols NSE:RELIANCE,NSE:INFY,NSE:HDFCBANK,NSE:TCS,NSE:SBIN --tags cash
mc-bridge download --collection watchlist --interval 5m --from 2024-11-11 --dataset watchlist-5m --dry-run
mc-bridge download --collection watchlist --interval 5m --from 2024-11-11 --dataset watchlist-5m --watch
mc-bridge download datasets
```

The estimate line looks like `5 symbols x 1 interval: about 187,000 rows, 11 MB on disk. Broker calls: 65...`. How far back a
broker serves 5-minute bars, and how many days one call may cover, is the broker's rule, not the Bridge's. A symbol the broker has
less history for just has fewer rows, and a failed item says why (`mc-bridge download show <id>`). Resume a job that stopped with
`mc-bridge download resume <id>`; it carries on from the last saved window, also after a restart.

**3. Check what you got.** `mc-bridge download datasets` lists it with its row count, data class and gaps. The files are in
`downloads/datasets/watchlist-5m/` in the data folder:

```text
NSE_RELIANCE_5m.csv     time,open,high,low,close,volume,oi
dataset.json            what it is, its coverage and its gaps
```

**4. Read it in Python.** Install the library once (`pip install "./sdk/python[pandas]"`, [python.md](python.md)).

<!-- runs against a demo Bridge in scripts/guide-recipes.test.mjs -->
```python
from mrchartist_bridge import Bridge

bridge = Bridge()
df = bridge.datasets.read("watchlist-5m", "NSE:RELIANCE", "5m", as_dataframe=True)   # from this computer's disk
print(df.tail(3))
print(df.attrs["freshness"])          # the data class, source and delay travel with the data
```

Or with plain pandas on the file: `pd.read_csv(".../downloads/datasets/watchlist-5m/NSE_RELIANCE_5m.csv", parse_dates=["time"])`.

**5. Read the same bars over HTTP, without touching the broker:**

<!-- runs against a demo Bridge in scripts/guide-recipes.test.mjs -->
```sh
curl -s -H "Authorization: Bearer $MCB_API_KEY" \
  "http://127.0.0.1:4300/v1/history?symbol=NSE:RELIANCE&interval=5m&from=2025-06-02&to=2025-06-03&dataset=watchlist-5m" | grep -o '"source":"local"'
```

It prints `"source":"local"`: the Bridge answered from the dataset and made no broker call.

## Recipe 2: record index option chains every day, and read them back in Python

Brokers give you today's option chain, not last month's. If you want last month's, record it now. Option chain recording reads the
Bridge's own live data and needs an **admin key from this computer** (it uses this computer's disk and your broker's budget).
Set it in `MCB_ADMIN_KEY` (`mc-bridge keys create --label admin --scope admin`; do not keep this key in a script).

**1. Try it for a minute** while the market is open. This records the NIFTY chain, 5 strikes around the at-the-money strike, every 15
seconds (the shortest a chain allows), all day long until you stop it:

<!-- runs against a demo Bridge in scripts/guide-recipes.test.mjs -->
```sh
mc-bridge record chain NIFTY --every 15 --strikes 5 --all-day
mc-bridge record list
```

`record list` shows the recording, its rows and its size. It writes one file per option per IST day to
`recordings/<id>/`, named like `2026-11-10__NFO_NIFTY-2026-11-17-24200-CE.csv`. The columns are `time, symbol, ltp, bid, ask,
bidQty, askQty, volume, oi, oiChange, open, high, low, close, iv, delta, gamma, theta, vega, spot, tickAt, source, class`. The class is always `realtime`. Stop the
trial with `mc-bridge record stop <id>` (the files stay).

**2. Make it daily and automatic.** The preset adds a rule "NIFTY and BANKNIFTY chains, current weekly expiry, ATM plus or minus 10,
every 30 seconds, during market hours" and turns auto-record on:

<!-- runs against a demo Bridge in scripts/guide-recipes.test.mjs -->
```sh
mc-bridge record preset index-option-chains
mc-bridge record status
```

From then on the Bridge starts the recording at each session start and stops it at the close, picks the expiry and the strikes again
every trading day, resumes after a restart and logs a gap for any time it could not record. If nobody is logged in at the start it
sends `account.login_needed` once and starts when a feed is available. **The Bridge records only while it runs**, so the computer has to be
on and the Bridge started during market hours ([windows.md](windows.md#running-at-login), [vps.md](vps.md)). Auto-record is off until a
person turns it on, and the preset does. Set a limit with `recorder.maxDiskMb` and `keepDays` on the rule so it cannot fill the disk
([recording.md](recording.md#disk-safety-and-retention)).

**3. The next day, read it back.** The rule's recording is called `rule-index-option-chains`; the trial's id is in `record list`.

<!-- runs against a demo Bridge in scripts/guide-recipes.test.mjs -->
```python
from mrchartist_bridge import Bridge

bridge = Bridge()
RECORDING = "rule-index-option-chains"      # or the id that `record list` shows

chain = bridge.recordings.read(RECORDING, as_dataframe=True)   # every day file of it, one table indexed by time (IST)
print(len(chain), "rows from", chain["symbol"].nunique(), "options")
print(chain.groupby("symbol")[["ltp", "oi"]].last().head())     # last price and open interest of each option
```

Plain files work too: every day file is an ordinary CSV, readable in Excel or `pd.read_csv`. Files of finished days may be `.csv.gz` (pandas
reads them as they are) when compression is on. `tickAt` is when the price itself last changed: a quiet option shows an older `tickAt` than
`time`. Gaps are in `GET /v1/recordings/{id}`, in `gaps.jsonl` next to the files, and as `recording.gap` events.

## Recipe 3: keep a dataset up to date with a scheduled command

A dataset remembers its last bar. `mc-bridge download update watchlist-5m` fetches only what is after it, and with `--watch` it waits
for the job and ends with exit code 0 when the job is done and 1 when it is not. That is what a scheduler needs. On the computer that
runs the Bridge it needs no key (it uses the control token the Bridge keeps in its data folder), so there is no secret in the schedule.

Put the command in a small script. Run it **after the close**, so the day's last bars exist: the forming bar is never written, and an
update at 16:35 IST has all of today's finished bars.

<!-- runs against a demo Bridge in scripts/guide-recipes.test.mjs -->
```sh
#!/bin/sh
# update-dataset.sh: fetch what is new for one dataset. Exit 0 only when the update finished.
mc-bridge download update watchlist-5m --watch || exit 1
```

**Mac and Linux (cron).** `crontab -e`, then one line (weekdays at 16:35 on this computer's clock; cron uses the computer's own time
zone, so convert if it is not on IST; use full paths, cron has almost no environment):

```text
35 16 * * 1-5 /bin/sh /home/you/update-dataset.sh >> /home/you/update-dataset.log 2>&1
```

If you start the Bridge with its own folder (`MCB_HOME`), put the same `MCB_HOME=...` line at the top of the script. `which mc-bridge`
gives the path to use when cron cannot find the command; in a git checkout use `npm run bridge --` in the repository folder.

**Windows (Task Scheduler).** Put `mc-bridge download update watchlist-5m --watch` and `exit $LASTEXITCODE` in `update-dataset.ps1`,
then in PowerShell:

```text
schtasks /Create /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 16:35 /TN "Bridge dataset update" /TR "powershell -NoProfile -File C:\Users\you\update-dataset.ps1"
```

The scheduler runs the script; the **Bridge itself must be running** at that time, because the update is a job inside the Bridge. If it is not,
the command says so (`The Bridge is not running at ...`) and ends with a non-zero code; look at the log. A holiday is harmless: the job finds
nothing new and finishes.

**Know when it fails.** `download.failed` and `download.done` are events. To get a message on a failure, subscribe a webhook of yours
([events.md](events.md)) or a Telegram route ([telegram.md](telegram.md)) to `download.failed`. `mc-bridge download list` and
`mc-bridge download show <id>` say why a job failed (an expired login, the disk limit, a symbol the broker has no data for), and
`mc-bridge download resume <id>` tries the failed items again.

**Several datasets.** Give each its own name and one line per dataset, or one script with several `update` lines. Jobs run one at a
time by default (`downloads.maxConcurrentJobs`) and share the budget cap.

## When something is off

| You see | What it means |
|---|---|
| `The Bridge is not running at ...` | Start the Bridge first; background jobs live inside it |
| A job `paused` with a reason | `user` (you), `kill_switch`, `session_lost` (log in again), `disk_low`, `key_revoked`. After `kill_switch`, `session_lost` and `disk_low` it continues by itself once that is fixed; otherwise `resume` it |
| A recording `waiting` | Outside the session, a holiday, or no login yet. Its status line says when it starts next |
| A recording shows a `delayed-source` gap | The only data available was delayed or end of day, which is never recorded |
| The estimate says the job does not fit | `downloads.maxDiskMb` or `downloads.minFreeDiskMb`: free space or raise the limit ([operations.md](operations.md#disk-space)) |
| A 400 `VALIDATION_FAILED` naming a symbol | The symbol is not in any connected broker's list, so nothing was created. The answer names the closest real ones. An expired contract needs `--allow-expired` |
