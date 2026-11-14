# The command line

> Commands here start with `mc-bridge`. In a git checkout, run them as `npm run bridge -- <command>` instead ([why](README.md#running-mc-bridge)).

`mc-bridge --help` lists every command with its options. This page says what each group is for and, because it trips people
up, **which credential each one needs**.

## Which commands need a key

Most commands run on the computer that holds the Bridge's data folder, and some talk to the running Bridge.

| Group | Needs |
|---|---|
| `init`, `start`, `doctor`, `backup`, `restore`, `openai-tools`, `expose`, `sources plugins pin` and `check` | Nothing. They read and write the data folder and the config file on this computer. (`restore` needs the Bridge stopped.) |
| `keys create`, `keys list`, `keys revoke` | Nothing. They work on the key file in the data folder, whether or not the Bridge is running. Run them from the folder (or with the config) the Bridge uses: the CLI prints which folder the keys live in. |
| `accounts list` | Nothing. It lists the accounts **in the config file**; to see the running Bridge's accounts use the dashboard's Accounts page or `GET /v1/accounts`. |
| `open`, `kill`, `kill release`, `orders acknowledge-state`, `download ...`, `init <starter> --with-key` | Nothing on this computer. A running Bridge keeps a control token in its data folder (`control.token`, owner-only) that these commands use. It is accepted only for these actions and only from this computer. |
| `accounts connect` | An admin key: `MCB_ADMIN_KEY` or `--key`. The secrets you type are asked for with hidden input and are never stored. |
| `sources ...`, `notify ...`, `subscriptions ...`, `record ...` | A key for the running Bridge: `read` to look (`sources list`, `record status`), `admin` to change things (`sources enable`, `notify telegram setup`, `subscriptions add`, `record preset`). Set `MCB_ADMIN_KEY` or `MCB_API_KEY`, or pass `--key`. |
| `collections ...` | `MCB_API_KEY` or `--key`: `read` to look, `paper` to change. |
| `mcp` | `--key` (or `MCB_API_KEY`): the key the assistant will use. |

When a command needs more than you gave it, it says so: for example "This command needs an admin key ... Set MCB_ADMIN_KEY, or
pass `--key`". An admin key is made on this computer with `keys create --label cli --scope admin`.

**`MCB_API_KEY` and the emergency commands.** The [quickstart](quickstart.md) has you export a read key as `MCB_API_KEY`. That does
**not** stop `kill` and `kill release` from working: on this computer they use the control token first, so they do not need
a key at all, and an exported read key does not get in the way. An admin key in `MCB_ADMIN_KEY` or `--key` is used when you give one.
From another computer there is no control token; use an admin key, or the dashboard on the computer running the Bridge.

A key typed after `--key` stays in your shell history and is visible to other programs on the machine while the command
runs. Prefer the environment variable (the CLI warns when you use `--key`).

## What is where

| To do this | Command | Guide |
|---|---|---|
| First setup, or a starter project | `init` | [developers.md](developers.md) |
| Run the Bridge, open the dashboard | `start [--demo] [--open]`, `open` | [quickstart.md](quickstart.md) |
| Keys | `keys create / list / revoke` | [developers.md](developers.md#auth-and-scopes) |
| Brokers and accounts | `accounts list / connect` | [accounts.md](accounts.md) |
| Health check | `doctor [--strict] [--json]` | [operations.md](operations.md) |
| Backups | `backup`, `backup list / verify`, `restore` | [backup.md](backup.md) |
| Stop all orders | `kill`, `kill release` | [safety.md](safety.md) |
| Data sources | `sources ...` | [sources.md](sources.md) |
| Phone alerts | `notify ...` | [telegram.md](telegram.md) |
| Lists of instruments | `collections ...` | [collections.md](collections.md) |
| Events to your own program | `subscriptions ...` | [events.md](events.md) |
| History to files | `download ...` | [downloads.md](downloads.md) |
| Live prices and chains to files | `record ...` | [recording.md](recording.md) |
| Reach the Bridge from outside, safely | `expose ...` | [expose-alerts.md](expose-alerts.md) |
| An AI assistant | `mcp`, `openai-tools` | [mcp.md](mcp.md), [chatgpt-openai.md](chatgpt-openai.md) |

## Exit codes

`0` means the command did what you asked. `1` means it did not; the reason is printed on the error stream. `doctor` exits `1`
when a check fails, and with `--strict` also for a blocking exposure problem, so a scheduler can alert on it.

## Where the Bridge looks

The command line finds the Bridge's settings in this order: `--config`, `MCB_CONFIG`, `./bridge.config.json`, then the per-user
folder (`~/.mc-bridge`, or `%APPDATA%\MrChartist\Bridge` on Windows; `MCB_HOME` moves it). Commands that talk to a running Bridge use
`--url`, else `MCB_BRIDGE_URL`, else the address in the config (default `http://127.0.0.1:4300`).
