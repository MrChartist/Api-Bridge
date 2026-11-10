# Backup and restore

> Commands here start with `mc-bridge`. In a git checkout, run them as `npm run bridge -- <command>` instead ([why](README.md#running-mc-bridge)).

The Bridge keeps everything you cannot make again in one data folder: your API key records, accounts, safety and quota
state, paper books, order records, audit log and source settings. This guide shows how to copy that folder safely, how
to put a copy back, and what to do when a disk dies, an upgrade goes wrong or you move to another computer.

**Downloads and recordings are not in a normal backup.** They can be many gigabytes and can be downloaded or recorded
again, so a backup holds settings and state only, says which folders it left out and how big they are, and stays small
and fast. Add `--include-data` (or `backup.includeData`) when you want them in the file too.

Where the data folder is: `~/.mc-bridge/data` on Mac, Linux and Android, `%APPDATA%\MrChartist\Bridge\data` on Windows,
and `data` next to `bridge.config.json` if you start the Bridge from a folder with its own config. `mc-bridge doctor`
prints the exact path.

## What a backup holds, and what it never holds

| In a backup | Not in a backup |
|---|---|
| `bridge.config.json` (your settings) | **The master key** (`master.key`, or wherever `masterKeyFile` points). Never, with any option. |
| API key records (`keys.json`), webhook hooks | `secrets.enc` (saved broker logins), unless you add `--include-secrets` |
| Accounts state, safety state and kill switch, per-key quotas | One-run files: the control token, one-time sign-in codes, lock and temp files |
| Data-source settings, pooling consent | The instrument cache (it is downloaded again) |
| Paper books, order and idempotency records | Other backups |
| The audit log (with its hash chain) | |
| Collections, webhook subscription records (not their secrets), the event log | The URL and signing secret of a webhook subscription: they live in `secrets.enc` only |
| | **Downloads and recordings** (`downloads/`, `recordings/`), unless you add `--include-data` |

**Why the master key is left out.** `secrets.enc` is encrypted with the master key. If one file carried both, the
encryption would protect nothing. So a backup never holds the key, and `secrets.enc` is optional: it is only of use
together with your original master key. Keep a copy of the master key somewhere safe and separate from your backups (a
password manager is fine). Without it you simply log in to your brokers again after a restore.

A backup is one `.tar.gz` file, readable by your user only (mode 600). It holds your key records and audit log, so
treat it like the data folder itself: another disk or your own computer, not a shared or public folder.

## Make a backup

```sh
mc-bridge backup --out ~/Backups/bridge-2026-11-09.tar.gz
```

- It never overwrites a file: if the name exists it stops and says so.
- Without `--out` the file goes to `backups/` inside the data folder. That does **not** survive a failed disk, so copy it
  elsewhere.
- `--include-secrets` also copies `secrets.enc`.
- `--include-data` also copies the `downloads/` and `recordings/` folders. They are streamed in pieces (never read whole into
  memory) and a recording that is still growing is copied up to the size it had when its turn came. The command prints their
  size first when they are left out: `NOT included: downloads: 22 MB, 32 jobs; recordings: 1.6 MB, 3 recordings`. More than
  `backup.maxDataFiles` (default 50,000) files in these folders is refused with a plain message, not a crash; copy the folders
  yourself in that case.
- Every file is copied whole and the finished archive is read back and compared with the checksum of each file. The
  command says "matched its checksum" only when they agree.
- The Bridge can be running. Each file is copied in one piece (the Bridge replaces files atomically, so a copy is always
  a whole version), and the audit head is copied before the log so the copy is never inconsistent.

From the dashboard: **Safety → Backups → Back up now**. It writes the same file and shows where it is on this computer.
The file is never sent through the browser; copy it from the folder shown. Over the API: `POST /v1/backup` (admin key,
this computer only).

Other commands: `mc-bridge backup list` (the copies in the data folder's `backups/`), `mc-bridge backup verify FILE`
(check an archive without restoring it).

## Restore

Stop the Bridge first (press Ctrl+C in its window), then:

```sh
mc-bridge restore ~/Backups/bridge-2026-11-09.tar.gz --dry-run   # look first
mc-bridge restore ~/Backups/bridge-2026-11-09.tar.gz             # then do it
```

What restore does, in order:

1. Reads the whole archive and checks every name, size and checksum. A damaged, cut-short or edited archive stops here
   and nothing is touched. It also checks the version: a backup from an older Bridge restores fine (the stores upgrade
   their files on the next start); a backup from a **newer** Bridge is refused with the version to install first.
2. Refuses to go on while a Bridge is running on that data folder.
3. Shows what will change: new files, replaced files, files that exist now but are not in the backup (they were made
   after it and will be removed), and what happens to `secrets.enc`. With `--dry-run` it stops here.
4. Asks you to type `RESTORE` (or pass `--yes`).
5. Makes a safety copy of the current data in `backups/` (`...-safety.tar.gz`), then unpacks into a temporary folder and
   swaps it in. If any step fails, everything is moved back and your data is as it was.
6. Prints the next steps.

An archive can only write files under the data folder and the settings file. A file name that tries to leave it
(`../`, an absolute path), a link, or a file a backup never holds (the master key, the control token) makes the whole
restore refuse.

`--skip-config` leaves your current `bridge.config.json` alone.

## A copy before every upgrade

The first time a new version of the Bridge starts on a data folder, `mc-bridge start` copies the data to `backups/`
before anything is read or migrated, and prints one line:

```
Saved a copy of your data before this version runs (2.0.0 to 2.1.0): /home/me/.mc-bridge/data/backups/mc-bridge-backup-20261109-021500-upgrade.tar.gz. Restore it with: mc-bridge restore "..."
```

- It keeps the newest `backup.keep` (default 5). Daily backups, restore safety copies and manual backups in that folder
  are counted separately; manual ones keep the newest `backup.manualKeep` (default 5). Copies made with `--out` are never removed.
- It never holds downloads or recordings (the copy before an upgrade and the safety copy before a restore are always state only),
  so they stay small and quick to make however large the recordings grow.
- It includes `secrets.enc` (the copy stays next to the file it copies, so it adds no exposure), never the master key.
- It never fills the disk or stops the Bridge. It is skipped, with one warning line, when the settings and state are larger than
  `backup.maxSizeMb` (default 500; downloads and recordings are not counted) or when less than the size plus 50 MB is free. The Bridge starts anyway; make a copy
  yourself.
- The version that last ran is remembered in `last-version.json` in the data folder.

## Daily backup (optional)

Off by default. In `bridge.config.json`:

```json
{
  "backup": {
    "keep": 5,
    "maxSizeMb": 500,
    "includeData": false,
    "schedule": { "enabled": true, "time": "02:30", "keep": 7, "includeSecrets": false }
  }
}
```

It runs once a day at `time` on this computer's clock while the Bridge is running, and catches up shortly after a start
if the computer was off at that time. A failure is logged, retried after an hour, shown in `GET /v1/health` (under
`backup`, for callers on this computer), in `mc-bridge doctor` and on the Safety page, and announced on the event bus as
`backup.failed` (`backup.completed` on success), which the Telegram agent can subscribe to. The files stay in `backups/`
on the same disk: copy them out with your normal backup tool, or point it at that folder.

## Recovery runbook

Do these with the Bridge stopped.

### The disk died (you have a backup file elsewhere)

1. Install the Bridge on the new disk ([install.md](install.md)). If the backup says it was made by a newer version than
   the installer gives you, install that version with `--version`.
2. Put your **master key** back if you kept a copy, at the path your settings name (`masterKeyFile`, or
   `~/.mc-bridge/data/master.key`; `mc-bridge doctor` prints it) or set `MCB_MASTER_KEY`.
3. `mc-bridge restore <file> --dry-run`, then `mc-bridge restore <file>`.
4. `mc-bridge start --open`, then `mc-bridge doctor`.
5. Check Safety: live trading is on only if your settings say so. The kill switch state is restored as it was.

A restore of a backup that holds downloads and recordings puts them back and keeps the ones it replaced next to them, as
`downloads.before-restore-...` and `recordings.before-restore-...` (no safety copy holds them); delete those when you have
checked. A restore of a state-only backup leaves the downloads and recordings on this computer as they are.

Webhook subscriptions: their URL and signing secret are in `secrets.enc`, which a normal backup leaves out. After a restore on
another computer (or without `--include-secrets` and the original master key) each subscription needs its secret again:
`mc-bridge subscriptions rotate-secret <id>`. Its queued deliveries wait for it (they are not thrown away). `restore` and
`mc-bridge doctor` say how many.

You do **not** have to re-enter: API keys (the keys themselves are shown only once, and every tool that has one keeps
working), accounts, quotas, paper books, hooks and the audit history. You **do** have to re-enter: broker logins if the
backup had no `secrets.enc` or you no longer have the original master key (use **Accounts → Log in**); a broker session
is daily anyway. If you had no backup at all, you start from `mc-bridge init`, create new keys and update each tool.

### An upgrade went wrong

1. Stop the Bridge.
2. Find the copy made before the upgrade: `mc-bridge backup list` (kind `upgrade`).
3. Install the previous version by number: `install.sh --version <old>` (Windows: `$env:MCB_VERSION`).
4. `mc-bridge restore <that file>`. Newer data would be misread by an older program, so restore before starting the old
   version.
5. Start it. Tell us what failed at [the issue tracker](https://github.com/MrChartist/api-bridge-v2/issues) (never paste
   keys).

### You moved to another computer

1. On the old computer, make a backup with `--include-secrets` and copy your **master key** file separately.
2. On the new one, install the Bridge, put the master key at the path in your settings, and restore.
3. Re-check what depends on the machine, because the restored settings came from the old one:
   - `dataDir` and `masterKeyFile` paths in `bridge.config.json`, if they were absolute;
   - **live trading**: orders must leave from your broker-registered static IP, so update `live.registeredIp` and the
     broker's registered IP before enabling live orders (see [deployment.md](deployment.md));
   - tunnels or webhook URLs that point at the old machine;
   - broker logins, if you did not bring the key.
4. Run `mc-bridge doctor`.

### Docker

The data folder is the mounted volume. Make a backup with `docker compose exec bridge mc-bridge backup` (it lands in
`backups/` inside the volume; copy it out with `docker cp`). To restore, stop the service first, then run the restore in
a one-off container with the same volume: `docker compose run --rm --no-deps bridge mc-bridge restore <path inside the container>`.

## Settings reference

| Setting | Default | Meaning |
|---|---|---|
| `backup.keep` | 5 | Snapshots kept per kind: before an upgrade, before a restore |
| `backup.maxSizeMb` | 500 | Settings and state larger than this are not copied automatically (downloads and recordings are not counted). A warning, never a failure to start |
| `backup.includeData` | false | Also put `downloads/` and `recordings/` into manual and daily backups (never into the copy before an upgrade or a restore) |
| `backup.maxDataFiles` | 50000 | More files than this in downloads and recordings: a backup with data is refused with a clear message |
| `backup.manualKeep` | 5 | Manual backups kept in the data folder (backups made with `--out` are never removed) |
| `backup.schedule.enabled` | false | Daily backup |
| `backup.schedule.time` | `"02:30"` | Local time, 24-hour |
| `backup.schedule.keep` | 7 | Daily backups kept |
| `backup.schedule.includeSecrets` | false | Copy `secrets.enc` too |
