# Upgrading

> Commands here start with `mc-bridge`. In a git checkout, run them as `npm run bridge -- <command>` instead ([why](README.md#running-mc-bridge)).

How to move to a newer version of the Bridge without losing anything, how the Bridge protects your data while you do it, and how to
go back. Your settings, keys, paper books, orders and audit log live in the **data folder**, not in the program folder, so a new
program version starts on the same data.

## Which version you have

```sh
mc-bridge --version              # 2.0.0
curl -s http://127.0.0.1:4300/v1/health      # "version": "2.0.0", "apiVersion": "v1"
```

- The **program** follows [semantic versioning](https://semver.org/): `MAJOR.MINOR.PATCH`. A patch fixes things, a minor adds things, and
  a major may change things.
- The **API** is versioned by its address: `/v1`. Routes under `/v1` only gain things: a field is not renamed or removed, a route is not
  removed, an error `code` is never renamed. A change that would break a program goes in a new `/v2` beside the old one. Ignore
  fields you do not know. Changes that need a migration window are written up in [API-DEPRECATIONS.md](../API-DEPRECATIONS.md), and a
  response that is affected carries a `Deprecation` header that links to its entry.
- The **Python and Node libraries** (`sdk/python`, `sdk/node`) have their own version numbers, because they can change without a program
  release.
- What changed is in the [changelog](../../CHANGELOG.md): read what is under the new version before you upgrade, and the "Unreleased"
  section if you run from a git checkout.

## Before you upgrade

1. **Look at the changelog** for your version to the new one. Anything that needs action says so.
2. **Stop the Bridge** (Ctrl+C in its window, or `docker compose stop`). Upgrade outside market hours if you trade live, and look at the
   readiness badge afterwards.
3. **Make a backup you control** (optional but cheap):

   ```sh
   mc-bridge backup --out ~/Backups/bridge-before-upgrade.tar.gz
   ```

   It holds your settings and state, not the master key and not downloads or recordings (add `--include-data` for those).
   Keep a copy of the **master key** somewhere separate, as [backup.md](backup.md) explains; no backup ever contains it.

You do not have to do step 3: the Bridge makes its own copy, next.

## What the Bridge does by itself

The first time a new version starts on a data folder, `mc-bridge start` copies your data **before it reads or changes anything**
and prints one line:

```text
Saved a copy of your data before this version runs (2.0.0 to 2.1.0): /home/me/.mc-bridge/data/backups/mc-bridge-backup-20261109-021500-upgrade.tar.gz. Restore it with: mc-bridge restore "..."
```

- The copy is in `backups/` inside the data folder, named `...-upgrade.tar.gz`. `mc-bridge backup list` shows it as kind `upgrade`.
- The version that last ran is remembered in `last-version.json` in the data folder; the copy is made when it differs from the running one.
  A data folder with nothing in it yet gets no copy.
- It holds your state and **includes** `secrets.enc` (your saved broker logins; the copy sits next to the file it copies, so it adds no
  exposure) so that going back does not cost you a re-login. It never holds the master key, downloads or recordings.
- The newest `backup.keep` (5) are kept. Daily backups, copies made before a restore and manual backups are counted separately.
- It never stops the Bridge from starting. If your settings and state are larger than `backup.maxSizeMb` (500) or the disk lacks room
  for the copy, you get one line instead and the Bridge starts anyway:

  ```text
  Warning: no copy of your data was made before this version runs (<why>) Start continues. Run "mc-bridge backup --out <file>" to make one yourself.
  ```

Stores that changed how they keep their files upgrade them on their own at the next start. A file that cannot be read is set aside and
reported rather than stopping the start ([operations.md](operations.md#a-damaged-file)).

## Upgrade

| How you installed | How to upgrade |
|---|---|
| One-step installer ([install.md](install.md)) | Run the same line again. Your settings and data are kept. Choose a version with `--version` (Mac, Linux) or `MCB_VERSION` (Windows). No release has been published yet, so today this path does not exist |
| Git checkout | Stop the Bridge, `git pull`, `npm ci`, start it again with `mc-bridge start` (or `npm run bridge -- start`) |
| A VPS with systemd | `sudo git pull --ff-only && sudo npm ci --omit=dev`, then `sudo systemctl restart mc-bridge` ([vps.md](vps.md#8-updating)) |
| Docker | `docker compose up -d --build` in the repository folder. The data is in the `bridge-data` volume and survives ([docker.md](docker.md)) |

Then check:

```sh
mc-bridge doctor                 # settings, keys, disk, calendar, backup: every line should be OK or say what to do
```

Open the dashboard, look at **Accounts** (log in again if a broker session ended), the readiness badge on **Safety**, and send one paper
order ([orders.md](orders.md)) before you trust the new version with anything live.

## Settings that a new version no longer accepts

The Bridge checks `bridge.config.json` every time it starts. A setting it does not know stops the start with a message that
names it, except the settings an older, fuller release had: those are ignored with a note, so a settings file left over from
that release never stops the Bridge. Nothing is changed in your file; you edit it and start again. These are the messages that exist today. Every setting is
listed in [config.md](config.md).

**A setting that was removed.** Older, fuller releases accepted these; this version does not have them. The Bridge starts
without them and says so:

```text
Ignored settings that v2 no longer has: alerts: this setting was removed in v2 (position alerts are not part of v2); watchlists: this setting was removed in v2 (watchlists are not part of v2); stream.candles: ...
```

The list of removed settings, each with its reason, is in [config.md](config.md#settings-that-no-longer-exist). Delete the named
keys when convenient; the note goes away. (`mcp.toolsets` with `"options"` is the one removed value rather than key: take `"options"` out of the list.)

**A typo or a setting from a newer version.** A key this version does not know, inside a section:

```text
Error: Config is not valid: safety: Unrecognized key: "maxOrderValu"
```

and a section it does not know at the top of the file:

```text
Error: Unknown config section "fooo".
```

If you went back to an older version and the file mentions a setting that only the newer one has, you get these messages. Remove the
setting, or install the newer version again.

**A value that is out of range or the wrong kind:**

```text
Error: Config is not valid: stream.heartbeatMs: Too small: expected number to be >=1000
Error: Config is not valid: safety.maxOrderValue: Invalid input: expected number, received string
```

The message names the full path of the key and says what was wrong; [config.md](config.md) gives the type and range of each. `mc-bridge doctor` runs
the same check without starting the Bridge.

**A change of default.** When a default changes, it is written up in the changelog and, where an API is affected, in
[API-DEPRECATIONS.md](../API-DEPRECATIONS.md). One that is already announced: the option-chain implied-volatility model switches its
default from `legacy-bs-spot` to `b76-forward` on 1 May 2027; set `market.chain.ivModelDefault` to choose now.

## Go back

If something looks wrong after an upgrade, go back to the version you had **and** the data you had. Do these with the Bridge stopped:

1. Find the copy made before the upgrade: `mc-bridge backup list` (kind `upgrade`).
2. Install the previous version by number (`--version <old>` or `MCB_VERSION`; in a checkout, `git checkout <old tag>` and `npm ci`; in Docker,
   check out the old version and rebuild).
3. Look first: `mc-bridge restore <that file> --dry-run` lists what will change.
4. `mc-bridge restore <that file>`. It asks you to type `RESTORE`, makes a safety copy of the data as it is now, swaps the old data in,
   and puts everything back if any step fails. It refuses while a Bridge is running on that folder.
5. Start the old version. Tell us what failed at [the issue tracker](https://github.com/MrChartist/api-bridge-v2/issues). Never paste a key.

**Restore before you start the old program.** A newer version may have changed how files are written, and an older one can misread them. This
is also why `restore` refuses a backup made by a newer version than the one running:

```text
This backup was made by Bridge 2.1.0, which is newer than this one (2.0.0). Older programs can misread newer data. Install Bridge 2.1.0 or newer, then restore.
```

A backup from an **older** version restores fine on a newer one: the stores upgrade their files at the next start.

Downloads and recordings are not in the upgrade copy, so going back does not touch them. A restore from a backup made with
`--include-data` puts them back and keeps the ones it replaced beside them (`downloads.before-restore-...`); delete those when you have checked.

## Quick checks when an upgrade does not start

| You see | Do |
|---|---|
| `Ignored settings that v2 no longer has` | Nothing is wrong: the Bridge runs without them. Delete the named settings to remove the note ([config.md](config.md#settings-that-no-longer-exist)) |
| `Config is not valid: ... Unrecognized key` | A typo, or a setting of another version. Remove it |
| `Unknown config section` | The same, at the top of the file |
| `Port 4300 is already in use by another program` | Another program holds the port. Close it, or choose another `server.port` |
| `Another Bridge (process ...) is using this data folder` | The old Bridge is still running. Stop it first ([operations.md](operations.md#one-bridge-per-data-folder)) |
| The Bridge starts but a broker says `SESSION_EXPIRED` | Log in again on **Accounts**; sessions end every day and an upgrade does not extend them |
| Webhook subscriptions fail after a restore on another computer | Their secrets are in `secrets.enc`: `mc-bridge subscriptions rotate-secret <id>` ([backup.md](backup.md)) |
