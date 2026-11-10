# Configuration reference

> Commands here start with `mc-bridge`. In a git checkout, run them as `npm run bridge -- <command>` instead ([why](README.md#running-mc-bridge)).

Every setting of `bridge.config.json`: what it is, its type, its default and what it does. *This page is generated from the
Bridge's own settings checker and `scripts/lib/config-descriptions.mjs` (run `npm run docs:generate`); a test fails when a setting
has no description.*

Most people change very little: a demo or paper Bridge runs with no file at all. For a first set-up use `mc-bridge init`, then
[accounts.md](accounts.md) to add a broker. Change a setting here only when a guide tells you to, or when you know what it does.

## How the file is read

- **Where it is.** The Bridge looks for `bridge.config.json` in this order: `--config <file>`, the `MCB_CONFIG` variable, the file of that name in the current folder, then the per-user folder (`MCB_HOME`, else `%APPDATA%\MrChartist\Bridge` on Windows, else `~/.mc-bridge`). With none of them it runs on safe defaults: paper only, no accounts, `127.0.0.1:4300`.
- **Order of precedence.** Built-in defaults, then the file, then the environment. The environment can only change where the Bridge listens and logs, or make it stricter. It can never switch live trading on.
- **Changes need a restart.** The Bridge reads the file once, when it starts. Accounts added on the dashboard are the exception: they are written to the file and used at once. Stop with Ctrl+C and start again after editing.
- **Typos are caught.** A key the Bridge does not know, or a value outside its range, stops the start with a message that names the key, for example `Config is not valid: safety: Unrecognized key: "maxOrderValu"`. `mc-bridge doctor` checks the file without starting the Bridge.
- **Only what you change.** Write only the keys you want to change. Leave the rest out and the defaults below apply. A section you leave out is the same as `{}`.
- **No secrets.** Broker logins, the master key and webhook secrets never go in this file. They are kept encrypted in the data folder.
- **Times** are IST (Asia/Kolkata), 24-hour `HH:MM`, unless a setting says this computer's clock. **Money** is in rupees. Names that end in `Ms` are milliseconds, `Sec` or `S` seconds, `Mb` megabytes.

### Environment variables

| Variable | Effect |
|---|---|
| `MCB_CONFIG` | The config file to read |
| `MCB_HOME` | The per-user Bridge folder (config file and data) |
| `MCB_HOST`, `MCB_PORT` | Override `server.host` and `server.port` |
| `MCB_DATA_DIR` | Overrides `dataDir` |
| `MCB_LOG_LEVEL` | Overrides `logging.level` |
| `MCB_PAPER_ONLY=1` | Forces `safety.liveTrading` off |
| `MCB_KILL_SWITCH=1` | Starts with the kill switch on (same as `safety.killSwitchOnStart`) |
| `MCB_DEMO=1` | Demo mode (same as `demo`) |
| `MCB_MASTER_KEY`, `MCB_MASTER_KEY_FILE` | The master key itself, or the file that holds it. These take precedence over `masterKeyFile` |
| `MCB_API_KEY`, `MCB_ADMIN_KEY`, `MCB_BRIDGE_URL` | Not settings of the Bridge: what the command line and the SDKs use to reach a running Bridge ([cli.md](cli.md)) |

### Settings that no longer exist

A file that still holds one of these stops the start with a message that lists them (`Your config file has settings that v2 no longer has. Delete them and start again`):

- `alerts`: position alerts are not part of v2
- `triggers`: GTT, trailing stops and position stops are not part of v2
- `watchlists`: watchlists are not part of v2
- `journal`: the trade journal is not part of v2
- `strategies`: the Bridge does not run strategies in v2 (run a script yourself with the Python SDK)
- `scanner`: the scanner is not part of v2
- `analytics`: analytics are not part of v2
- `studies`: studies are not part of v2
- `vol`: volatility data is not part of v2
- `reference`: the reference-data store is not part of v2
- `participants`: participant open interest is not part of v2
- `stream.candles`: live candles are not served by the stream
- `mcp.toolsets` with `"options"`: there are no options tools

## Sections

- [`general`](#general): `dataDir`, `masterKeyFile`, `demo`
- [`server`](#server)
- [`cors`](#cors)
- [`logging`](#logging)
- [`accounts`](#accounts)
- [`safety`](#safety)
- [`morningLogin`](#morninglogin)
- [`ratelimit`](#ratelimit)
- [`symbols`](#symbols)
- [`market`](#market)
- [`stream`](#stream)
- [`orders`](#orders)
- [`paper`](#paper)
- [`readiness`](#readiness)
- [`integrations`](#integrations)
- [`hooks`](#hooks)
- [`mcp`](#mcp)
- [`compat`](#compat)
- [`sources`](#sources)
- [`backup`](#backup)
- [`notify`](#notify)
- [`library`](#library)
- [`events`](#events)
- [`downloads`](#downloads)
- [`recorder`](#recorder)
- [`storage`](#storage)

## general

Keys that sit at the top of the file, outside any section: where data is kept, where the master key is, and demo mode.

| Key | Type | Default | What it does |
|---|---|---|---|
| `dataDir` | text | `"./data"` | The folder for keys, accounts, paper books, orders, audit log, downloads, recordings and backups. A relative path is read from the folder of the config file. MCB_DATA_DIR overrides it. Without a config file the Bridge uses a folder in your user area. |
| `masterKeyFile` | text; at least 1 character | not set | The file holding the master key that encrypts saved broker logins. A relative path is read from the folder of the config file. MCB_MASTER_KEY or MCB_MASTER_KEY_FILE in the environment take precedence. Without it the key is data/master.key. Keep it outside the data folder, so a backup of the data folder never carries the key. |
| `demo` | true or false | `false` | Run with sample prices and no real broker. Live trading is off. The same as starting with --demo or MCB_DEMO=1. |

## server

Where the Bridge listens and who may talk to it. The defaults keep it on this computer only. More: [vps.md](vps.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `server.host` | text | `"127.0.0.1"` | The address the Bridge listens on. 127.0.0.1 means this computer only. Anything else needs allowNonLoopback. |
| `server.port` | whole number, 0 to 65535 | `4300` | The port of the main listener (API and dashboard). 0 lets the system pick a free one. The environment variable MCB_PORT overrides it. |
| `server.allowNonLoopback` | true or false | `false` | Must be true before the Bridge will listen on anything but this computer. Every route still needs an API key. |
| `server.remoteDashboard` | true or false | `false` | Serve the dashboard pages to other computers. Only allowed in demo mode (a public demo); the Bridge refuses to start with this on and real accounts. |
| `server.localPeers` | list of text; at most 8 items | `[]` | Addresses (IPv4 or IPv4/CIDR) that count as this computer for routes that must come from this computer, besides loopback. Only for Docker, where your browser arrives from the container network's gateway. Leave empty otherwise. |
| `server.allowedHosts` | list of text | `[]` | Extra Host header names the Bridge accepts. Loopback names are always accepted. This is the guard against a web page pointing its own name at 127.0.0.1. |
| `server.bodyLimitBytes` | whole number, above 0, up to 1048576 | `65536` | The largest request body the Bridge accepts, in bytes. A bigger body is refused. |
| `server.publicIngress.enabled` | true or false | `false` | Turn on a second listener that serves only the alert routes (hooks), for a tunnel or proxy that receives TradingView alerts. Off by default. |
| `server.publicIngress.host` | text | `"127.0.0.1"` | The address of the alert listener. Keep it on 127.0.0.1 and point your tunnel at it. |
| `server.publicIngress.port` | whole number, 0 to 65535 | `4301` | The port of the alert listener. It must differ from the other listeners. |
| `server.publicIngress.allowedHosts` | list of text | `[]` | Host names the alert listener accepts (your public host name). |
| `server.sheetsIngress.enabled` | true or false | `false` | Turn on a third listener that serves only GET /xl/* for read-only keys, for Google Sheets through a tunnel. Off by default. |
| `server.sheetsIngress.host` | text | `"127.0.0.1"` | The address of the Sheets listener. Keep it on 127.0.0.1 and point your tunnel at it. |
| `server.sheetsIngress.port` | whole number, 0 to 65535 | `4302` | The port of the Sheets listener. It must differ from the other listeners. |
| `server.sheetsIngress.allowedHosts` | list of text | `[]` | Host names the Sheets listener accepts (your public host name). |
| `server.sheetsIngress.requestsPerMinute` | whole number, 10 to 6000 | `600` | Requests per minute the Sheets listener accepts from one caller address. Behind a local tunnel every caller shares one address, so this caps them together. |

## cors

Which web pages in a browser may call the Bridge. More: [safety.md](safety.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `cors.allowedOrigins` | list of text | `[]` | Web page origins (scheme://host[:port], no path) that a browser may call the Bridge from. Empty means none. Scripts, Excel, AmiBroker and the dashboard need none. No wildcard is allowed. |

## logging

What the Bridge writes to its log. More: [operations.md](operations.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `logging.level` | one of `debug`, `info`, `warn`, `error`, `silent` | `"info"` | How much the Bridge says: debug, info, warn, error or silent. MCB_LOG_LEVEL overrides it. |
| `logging.requests` | one of `all`, `errors`, `off` | `"errors"` | Which requests get an access line: errors (status 400 and above, and anything slower than one second), all, or off. |
| `logging.file` | true or false | not set | Also write logs/bridge.log in the data folder, rotated. When not set it is on for mc-bridge start and off in Docker (use docker logs). |
| `logging.maxFileMb` | whole number, 1 to 1024 | `10` | The size at which the log file is rotated, in megabytes. |
| `logging.keepFiles` | whole number, 1 to 50 | `5` | How many rotated log files are kept. |

## accounts

Your broker accounts and the paper account. One entry per account. More: [accounts.md](accounts.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `accounts` | list of settings groups | `[]` | The list of accounts. Each entry has the settings below. Logins never go in this file; they are saved encrypted when you log in. |
| `accounts[].id` | text; a fixed pattern | required | Your name for the account: 2 to 32 lowercase letters, digits or hyphens. Used as account= in queries and "account" in orders. |
| `accounts[].broker` | text; a fixed pattern | required | The broker adapter id (dhan, zerodha, upstox and the others in BROKERS.md), or paper for a practice account. |
| `accounts[].label` | text; at most 60 characters | not set | A name to show on the dashboard and in answers. |
| `accounts[].holder` | text; at least 1 character, at most 64 characters, a fixed pattern | not set | Whose account this is: any stable label such as self or spouse, never a PAN. Reads are spread over accounts only when they have the same holder. |
| `accounts[].enabled` | true or false | `true` | false keeps the account in the file but out of use. |
| `accounts[].live.enabled` | true or false | `false` | Allow live orders on this account. Needs safety.liveTrading too. A paper account can never have it on. |
| `accounts[].live.allowedSources` | list of choices (`rest`, `webhook`, `mcp`, `cli`, `guard`, `alert`) | `["rest"]` | Which request sources may send live orders on this account: rest, webhook, mcp, cli, guard, alert. Listing mcp still needs a person to confirm each order. |
| `accounts[].live.registeredIp` | text; at most 64 characters | not set | The static IP address you registered with your broker for orders. Used by the readiness check. |
| `accounts[].live.backupIp` | text; at most 64 characters | not set | A second registered address, for brokers that allow a primary and a backup. The readiness check accepts either. |
| `accounts[].marketData.pooling` | true or false | `false` | Let this account's request budget serve reads that did not name an account. Off by default; it also needs your consent in the dashboard. |
| `accounts[].marketData.poolingWhenTermsUnknown` | true or false | `false` | Also pool when the broker's terms on spreading reads over your accounts are not confirmed (true for every broker today). Your own decision, made in this file only. |
| `accounts[].limits.dailyMaxOrders` | whole number, above 0 | not set | A stricter daily order count for this account than the global one. |
| `accounts[].limits.dailyMaxLoss` | number, at least 0 | not set | A stricter daily loss limit (rupees) for this account than the global one. |
| `accounts[].limits.maxOrderValue` | number, at least 0 | not set | A stricter order value limit (rupees) for this account than the global one. |
| `accounts[].limits.maxLotsPerOrder` | whole number, above 0 | not set | A stricter lots-per-order limit for this account than the global one. |
| `accounts[].limits.orderRatePerSecond` | number, above 0, up to 10 | not set | A stricter order rate (orders per second) for this account. The lower of this and the global value applies. |

## safety

The limits every order passes, paper and live. The Bridge applies the stricter of these and an account's own limits. More: [safety.md](safety.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `safety.liveTrading` | true or false | `false` | The master switch for live orders. Off by default. The environment can never turn it on; MCB_PAPER_ONLY=1 forces it off. |
| `safety.orderRatePerSecond` | number, above 0, up to 10 | `5` | Orders per second per account (place, modify and cancel all count). It cannot be set above 10. |
| `safety.dailyMaxOrders` | whole number, above 0 | `100` | Orders per account per IST day. An order that passes its checks reserves its place at once. |
| `safety.dailyMaxLoss` | number, at least 0 | `10000` | The daily loss per account, in rupees, after which new orders are refused. Paper uses realised paper P&L; live uses the broker's day P&L. |
| `safety.maxOrderValue` | number, at least 0 | `200000` | The largest value of one order, in rupees. A modify is checked on the order as it would stand after the change. |
| `safety.maxLotsPerOrder` | whole number, above 0 | `10` | The most lots in one order. |
| `safety.priceBandPct` | number, above 0, up to 20 | `3` | Limit and trigger prices must be within this percentage of the last price. |
| `safety.marketOrders` | one of `protect`, `reject` | `"protect"` | protect sends a market order as a limit at the last price plus or minus marketProtectionPct (or uses the broker's own protection). reject refuses market orders. |
| `safety.marketProtectionPct` | number, above 0, up to 10 | `2` | The percentage around the last price used to protect a market order. |
| `safety.killSwitchOnStart` | true or false | `false` | Start with the kill switch already on (no new orders until you release it). MCB_KILL_SWITCH=1 does the same. |

## morningLogin

The reminder to log in to your brokers on trading mornings. More: [accounts.md](accounts.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `morningLogin.enabled` | true or false | `true` | Send the login reminders. |
| `morningLogin.remindAt` | text; a fixed pattern | `"08:45"` | The IST time on trading days when the account.login_needed event is emitted for each account that needs a login. The Telegram message has its own time, notify.morning.at. |
| `morningLogin.warnBeforeEndMinutes` | whole number, 0 to 240 | `30` | Remind again this many minutes before a session that ends before the close. 0 turns the second reminder off. |

## ratelimit

How the Bridge stays inside each broker's request limits and shares them between your tools. These settings can only lower a broker's documented limits, never raise them. More: [rate-limits.md](rate-limits.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `ratelimit.client.perSecond` | number, 0.01 to 10000 | `50` | Requests per second each API key may make to the Bridge. |
| `ratelimit.client.burst` | whole number, above 0, up to 100000 | not set | The size of a short burst a key may make. When not set it equals perSecond. |
| `ratelimit.client.perDay` | number, 1 to 100000000 | not set | Requests per IST day each key may make. When not set there is no daily cap. |
| `ratelimit.client.maxConcurrent` | whole number, 1 to 10000 | not set | Requests one key may have in flight at once. Beyond it the Bridge answers 429. |
| `ratelimit.client.kindWeights.ui` | number, 1 to 16 | not set | Share of a busy broker queue for keys made for the "ui" kind of client (1 to 16). Defaults when not set: ui 4, mcp 2, excel 1, script 1, other 1. |
| `ratelimit.client.kindWeights.mcp` | number, 1 to 16 | not set | Share of a busy broker queue for keys made for the "mcp" kind of client (1 to 16). Defaults when not set: ui 4, mcp 2, excel 1, script 1, other 1. |
| `ratelimit.client.kindWeights.excel` | number, 1 to 16 | not set | Share of a busy broker queue for keys made for the "excel" kind of client (1 to 16). Defaults when not set: ui 4, mcp 2, excel 1, script 1, other 1. |
| `ratelimit.client.kindWeights.script` | number, 1 to 16 | not set | Share of a busy broker queue for keys made for the "script" kind of client (1 to 16). Defaults when not set: ui 4, mcp 2, excel 1, script 1, other 1. |
| `ratelimit.client.kindWeights.other` | number, 1 to 16 | not set | Share of a busy broker queue for keys made for the "other" kind of client (1 to 16). Defaults when not set: ui 4, mcp 2, excel 1, script 1, other 1. |
| `ratelimit.client.keys` | map of settings, by name | `{}` | Budgets for single keys, by the key's 10-character id (the part in mcb_<id>_...). |
| `ratelimit.client.keys.<name>.perSecond` | number, 0.01 to 10000 | not set | Requests per second for this key. |
| `ratelimit.client.keys.<name>.burst` | whole number, 1 to 100000 | not set | Burst size for this key. |
| `ratelimit.client.keys.<name>.perDay` | number, 1 to 100000000 | not set | Requests per IST day for this key. |
| `ratelimit.client.keys.<name>.weight` | number, 1 to 16 | not set | This key's share of a busy broker queue (1 to 16). |
| `ratelimit.brokers` | map of settings, by name | `{}` | Lower limits for every account of one broker, by broker id. A value above the documented limit is a config error, so a typo cannot quietly do nothing. |
| `ratelimit.brokers.<name>.limits` | map of settings, by name | not set | Lower this broker's limits per kind of request. The name is order, quote, depth, history, chain, portfolio, master or other. |
| `ratelimit.brokers.<name>.limits.<name>.perSecond` | number, above 0, up to 1000 | not set | Requests per second for this kind of request. |
| `ratelimit.brokers.<name>.limits.<name>.perMinute` | number, above 0, up to 60000 | not set | Requests per minute for this kind of request. |
| `ratelimit.brokers.<name>.limits.<name>.perDay` | number, above 0, up to 10000000 | not set | Requests per day for this kind of request. |
| `ratelimit.brokers.<name>.limits.<name>.extraWindows` | list of settings groups; at most 4 items | not set | Extra windows other than second, minute and day (up to 4), for example an hourly cap. |
| `ratelimit.brokers.<name>.limits.<name>.extraWindows[].windowMs` | whole number, 1000 to 86400000 | required | Length of the extra window in milliseconds. |
| `ratelimit.brokers.<name>.limits.<name>.extraWindows[].limit` | number, above 0 | required | Requests allowed in the extra window. |
| `ratelimit.brokers.<name>.groups` | map of settings, by name | not set | Lower limits for a named group of request kinds that share one budget at the broker, as that broker's documentation counts them. |
| `ratelimit.brokers.<name>.groups.<name>.perSecond` | number, above 0, up to 1000 | not set | Requests per second for this kind of request. |
| `ratelimit.brokers.<name>.groups.<name>.perMinute` | number, above 0, up to 60000 | not set | Requests per minute for this kind of request. |
| `ratelimit.brokers.<name>.groups.<name>.perDay` | number, above 0, up to 10000000 | not set | Requests per day for this kind of request. |
| `ratelimit.brokers.<name>.groups.<name>.extraWindows` | list of settings groups; at most 4 items | not set | Extra windows other than second, minute and day (up to 4), for example an hourly cap. |
| `ratelimit.brokers.<name>.groups.<name>.extraWindows[].windowMs` | whole number, 1000 to 86400000 | required | Length of the extra window in milliseconds. |
| `ratelimit.brokers.<name>.groups.<name>.extraWindows[].limit` | number, above 0 | required | Requests allowed in the extra window. |
| `ratelimit.brokers.<name>.maxQuoteBatch` | whole number, above 0, up to 10000 | not set | How many instruments one request to this broker carries for prices. It can only be lowered. |
| `ratelimit.brokers.<name>.tier` | text; a fixed pattern | not set | The broker plan your limits come from, for brokers with documented plans. Pick a higher plan only if you have it. Unknown names are refused for a broker entry. |
| `ratelimit.accounts` | map of settings, by name | `{}` | Lower limits for one account, by account id. A value above the broker's limit is clamped at run time. |
| `ratelimit.accounts.<name>.limits` | map of settings, by name | not set | Lower this account's limits per kind of request. The name is order, quote, depth, history, chain, portfolio, master or other. |
| `ratelimit.accounts.<name>.limits.<name>.perSecond` | number, above 0, up to 1000 | not set | Requests per second for this kind of request. |
| `ratelimit.accounts.<name>.limits.<name>.perMinute` | number, above 0, up to 60000 | not set | Requests per minute for this kind of request. |
| `ratelimit.accounts.<name>.limits.<name>.perDay` | number, above 0, up to 10000000 | not set | Requests per day for this kind of request. |
| `ratelimit.accounts.<name>.limits.<name>.extraWindows` | list of settings groups; at most 4 items | not set | Extra windows other than second, minute and day (up to 4), for example an hourly cap. |
| `ratelimit.accounts.<name>.limits.<name>.extraWindows[].windowMs` | whole number, 1000 to 86400000 | required | Length of the extra window in milliseconds. |
| `ratelimit.accounts.<name>.limits.<name>.extraWindows[].limit` | number, above 0 | required | Requests allowed in the extra window. |
| `ratelimit.accounts.<name>.groups` | map of settings, by name | not set | Lower limits for a named group of request kinds that share one budget at the account, as that broker's documentation counts them. |
| `ratelimit.accounts.<name>.groups.<name>.perSecond` | number, above 0, up to 1000 | not set | Requests per second for this kind of request. |
| `ratelimit.accounts.<name>.groups.<name>.perMinute` | number, above 0, up to 60000 | not set | Requests per minute for this kind of request. |
| `ratelimit.accounts.<name>.groups.<name>.perDay` | number, above 0, up to 10000000 | not set | Requests per day for this kind of request. |
| `ratelimit.accounts.<name>.groups.<name>.extraWindows` | list of settings groups; at most 4 items | not set | Extra windows other than second, minute and day (up to 4), for example an hourly cap. |
| `ratelimit.accounts.<name>.groups.<name>.extraWindows[].windowMs` | whole number, 1000 to 86400000 | required | Length of the extra window in milliseconds. |
| `ratelimit.accounts.<name>.groups.<name>.extraWindows[].limit` | number, above 0 | required | Requests allowed in the extra window. |
| `ratelimit.accounts.<name>.maxQuoteBatch` | whole number, above 0, up to 10000 | not set | How many instruments one request to this account's broker carries for prices. It can only be lowered. |
| `ratelimit.accounts.<name>.tier` | text; a fixed pattern | not set | The broker plan your limits come from, for brokers with documented plans. Pick a higher plan only if you have it. Unknown names are refused for a broker entry. |
| `ratelimit.queue.maxQueuedPerAccount` | whole number, above 0, up to 100000 | `5000` | Requests waiting for one account's budget, all kinds together. More are refused with UPSTREAM_RATE_LIMITED. |
| `ratelimit.queue.maxQueuedPerConsumer` | whole number, above 0, up to 100000 | not set | Requests one key may have waiting per account. When not set it is 200. Beyond it that key is refused. |
| `ratelimit.queue.ageingMs` | whole number, above 0, up to 600000 | `2000` | Every this many milliseconds a waiting request that is not an order moves up one priority level (never above live). |
| `ratelimit.queue.maxWaitMs.order` | whole number, 0 to 3600000 | `5000` | How long an order may wait for budget before it is refused, in milliseconds. |
| `ratelimit.queue.maxWaitMs.live` | whole number, 0 to 3600000 | `15000` | How long a request at the live priority may wait for budget before it is refused, in milliseconds. |
| `ratelimit.queue.maxWaitMs.interactive` | whole number, 0 to 3600000 | `10000` | How long a request at the interactive priority may wait for budget before it is refused, in milliseconds. |
| `ratelimit.queue.maxWaitMs.background` | whole number, 0 to 3600000 | `300000` | How long a request at the background priority (downloads, recordings, prefetches) may wait for budget before it is refused, in milliseconds. |
| `ratelimit.maxInFlightPerAccount` | whole number, above 0, up to 64 | `8` | Broker calls other than orders running at once per account. Orders are never held back by this. |
| `ratelimit.maxInFlightPerConsumer` | whole number, above 0, up to 64 | not set | Broker calls one key may hold at once while others wait. When not set it is half of maxInFlightPerAccount. |
| `ratelimit.windowPaddingMs` | whole number, 0 to 1000 | `100` | Extra width added to every sliding window to absorb network delay, in milliseconds. |
| `ratelimit.backoff.initialMs` | whole number, 100 to 60000 | `1000` | The first wait after a broker asks the Bridge to slow down, in milliseconds. It grows from here. |
| `ratelimit.backoff.maxMs` | whole number, 1000 to 3600000 | `60000` | The longest wait after repeated slow-down requests, in milliseconds. |

## symbols

How the instrument list (every share, future and option) is loaded and kept. More: [symbols.md](symbols.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `symbols.refreshAfterIst` | text; a fixed pattern | `"08:30"` | An instrument list fetched before this IST time is fetched again once the time has passed, so each trading day starts with the day's list. |
| `symbols.diskCache` | true or false | `true` | Keep today's instrument list in the data folder so a restart costs no download. |
| `symbols.failureBackoffMs` | whole number, 1000 to 3600000 | `60000` | After a failed download of an instrument list, wait this long before trying that broker again, in milliseconds. |
| `symbols.warmOnStart` | true or false | `true` | Load the connected brokers' instrument lists in the background when the Bridge starts. |

## market

How fresh a price must be, how long ranges of history are fetched, and how option chains are built. More: [rate-limits.md](rate-limits.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `market.freshness.ltpMs` | whole number, 0 to 5000 | `1000` | How old a last price may be before the Bridge fetches a new one, when the caller gives no maxAgeMs (milliseconds). It can be tightened freely and loosened only up to the maximum shown. |
| `market.freshness.quoteMs` | whole number, 0 to 10000 | `2000` | The same for full quotes (milliseconds). |
| `market.freshness.depthMs` | whole number, 0 to 5000 | `1000` | The same for market depth (milliseconds). Depth older than 5 seconds is never served whatever you set. |
| `market.freshness.chainMs` | whole number, 0 to 30000 | `3000` | The same for option chains (milliseconds). |
| `market.freshness.expiriesMs` | whole number, 0 to 3600000 | `300000` | The same for the list of expiry dates (milliseconds). |
| `market.freshness.historyMs` | whole number, 0 to 600000 | `60000` | The same for history answers (milliseconds). |
| `market.stale.enabled` | true or false | `true` | When a broker's budget is used up, serve a cached value labelled stale instead of making the caller wait past its deadline. |
| `market.stale.maxStaleMs` | whole number, 0 to 600000 | `60000` | The oldest cached value that may be served as stale, in milliseconds. Depth is capped at 5 seconds whatever this says. |
| `market.stale.waitMs` | whole number, 0 to 10000 | `250` | How long a read that has a stale fallback waits for budget before falling back, in milliseconds. |
| `market.batch.windowMs` | whole number, 0 to 200 | `25` | Price requests that arrive within this many milliseconds are merged into one broker call per account. |
| `market.batch.maxSymbols` | whole number, 1 to 5000 | `1000` | A merged batch is sent early when it reaches this many symbols. |
| `market.streamFirst` | true or false | `true` | Answer last prices and quotes from a live stream subscription when there is one, so they cost no broker request. |
| `market.quietLegMaxAgeMs` | whole number, 0 to 600000 | `60000` | For chains built from the stream: a leg that has not ticked within the chain freshness target is still used up to this age, when its subscription is live on a feed that is ticking now (milliseconds). 0 requires every leg to have ticked recently. |
| `market.history.maxChunks` | whole number, 1 to 200 | `40` | The most broker calls one history request may make. A longer range returns the newest part with partial: true. |
| `market.history.maxSpanDays.intraday` | whole number, 1 to 365 | `60` | Days of intraday bars asked from the broker in one call. |
| `market.history.maxSpanDays.daily` | whole number, 1 to 7300 | `2000` | Days of daily bars asked from the broker in one call. |
| `market.history.brokers` | map of settings, by name | `{}` | Different spans per broker, by broker id. Use only figures from the broker's own documentation. |
| `market.history.brokers.<name>.intraday` | whole number, 1 to 365 | not set | Days of intraday bars per call for this broker. |
| `market.history.brokers.<name>.daily` | whole number, 1 to 7300 | not set | Days of daily bars per call for this broker. |
| `market.history.localFirst` | true or false | `false` | Answer GET /v1/history from datasets stored on this computer when they cover the range, and ask the broker only for the rest. ?dataset=<name> always reads from that dataset. |
| `market.chain.source` | one of `auto`, `broker`, `built` | `"auto"` | auto uses the broker's own chain where the account offers one and otherwise builds it from the instrument list plus quotes. broker or built forces one way. |
| `market.chain.riskFreeRate` | number, 0 to 0.25 | not set | The yearly interest rate (as a decimal, 0.07 is 7 percent) used for computed Greeks. When not set the Bridge uses its built-in rate. |
| `market.chain.ivModelDefault` | one of `legacy-bs-spot`, `b76-forward` | `"legacy-bs-spot"` | The implied-volatility model used when a request names none. legacy-bs-spot until 1 May 2027, then b76-forward; set b76-forward to switch early. See API-DEPRECATIONS.md. |
| `market.chain.maxBuiltLegs` | whole number, 2 to 2000 | `400` | The most option instruments a chain built by the Bridge will price. |
| `market.cache.maxEntries` | whole number, 100 to 1000000 | `20000` | How many answers the in-memory cache keeps. |

## stream

The live price stream over WebSocket and server-sent events. More: [streaming.md](streaming.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `stream.heartbeatMs` | whole number, 1000 to 120000 | `15000` | How often a heartbeat goes to every stream client, in milliseconds. |
| `stream.maxClients` | whole number, 1 to 1000 | `50` | Open stream connections (WebSocket and server-sent events), all keys together. |
| `stream.maxClientsPerKey` | whole number, 1 to 1000 | `10` | Open stream connections for one API key. |
| `stream.maxSymbolsPerClient` | whole number, 1 to 10000 | `500` | Symbols one connection may subscribe to. Beyond it the Bridge answers SUBSCRIPTION_LIMIT. |
| `stream.maxSymbolsPerRequest` | whole number, 1 to 1000 | `200` | Symbols in one subscribe message or one server-sent-events address. |
| `stream.maxSubscriptionsPerUpstream` | whole number, above 0; or `null` | `null` | An extra cap on subscriptions per broker feed. When not set the broker's documented limit applies. |
| `stream.staleAfterMs` | whole number, 5000 to 3600000 | `60000` | A connected feed with no tick for this long is reported as stale, in milliseconds. |
| `stream.staleRebuildAfterMs` | whole number, 0 to 3600000 | `180000` | During market hours a feed silent this long is treated as a dead connection and rebuilt, in milliseconds. 0 means never. The wait doubles after each silent rebuild, up to 16 times. |
| `stream.connectTimeoutMs` | whole number, 1000 to 600000 | `45000` | A feed that has not reported connected this long after it was built is rebuilt, in milliseconds. |
| `stream.upstreamIdleMs` | whole number, 0 to 3600000 | `60000` | Close a broker feed this long after its last subscription went away, in milliseconds. |
| `stream.unsubscribeLingerMs` | whole number, 0 to 600000 | `0` | Keep a symbol subscribed at the broker this long after the last client left, in milliseconds. |
| `stream.adapterGraceMs` | whole number, 0 to 600000 | `35000` | Let the broker adapter reconnect by itself for this long before the Bridge rebuilds the feed, in milliseconds. |
| `stream.backoff.initialMs` | whole number, 100 to 60000 | `1000` | The first wait before reconnecting a broker feed, in milliseconds. It grows from here. |
| `stream.backoff.maxMs` | whole number, 1000 to 600000 | `30000` | The longest wait between reconnect attempts, in milliseconds. |
| `stream.maxQueuedMessages` | whole number, 16 to 100000 | `256` | Messages other than ticks waiting for one slow client before that client is dropped. |
| `stream.highWaterMarkBytes` | whole number, 16384 to 67108864 | `1048576` | Stop writing to a client while this many bytes are still unsent to it. |
| `stream.maxOpsPerSecond` | whole number, 1 to 1000 | `20` | Messages per second a client may send to the Bridge on one connection. |

## orders

How orders wait for confirmation, how an unknown result is looked up again, and how long order records are kept. Nothing here can switch live trading on. More: [orders.md](orders.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `orders.ticketTtlMs` | whole number, 10000 to 300000 | `60000` | How long a ticket waits for a person to confirm it, in milliseconds. |
| `orders.confirmTokenTtlMs` | whole number, 10000 to 300000 | `60000` | How long a confirmed ticket's single-use token may be used, in milliseconds. |
| `orders.confirmPaperFromMcp` | true or false | `true` | Orders prepared by an AI assistant need a person's confirmation even when they are paper orders. |
| `orders.liveCallTimeoutMs` | whole number, 1000 to 60000 | `15000` | A live order call to the broker that takes longer than this becomes OUTCOME_UNKNOWN, in milliseconds. The Bridge never sends it again by itself. |
| `orders.reconcileIntervalMs` | whole number, 500 to 60000 | `3000` | How often orders with an unknown outcome are looked up in the broker's order book, in milliseconds. |
| `orders.reconcileGiveUpMs` | whole number, 10000 to 86400000 | `600000` | Stop looking after this long, in milliseconds. The order then stays outcome_unknown: check your broker's own order book. |
| `orders.sliceAboveFreeze` | true or false | `false` | Split an order above the exchange's freeze quantity into several orders. When false it is refused instead. |
| `orders.maxSlices` | whole number, 1 to 40 | `10` | The most orders one sliced order may be split into. |
| `orders.orderRetentionDays` | whole number, 1 to 90 | `7` | Days that live order records are kept on disk. |
| `orders.maxOrderLookups` | whole number, 100 to 20000 | `2000` | Paper orders read per account for one listing. |

## paper

The paper-trading engine: starting money, fills, square-off, margin and charges. More: [paper-margin.md](paper-margin.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `paper.startingCapital` | number, 10000 to 1000000000 | `1000000` | Rupees in a new or reset paper account. Demo mode starts with 25 lakh when this is left at its default. |
| `paper.slippageBps` | number, 0 to 500 | `5` | Market orders that fill without depth fill at the last price plus or minus this many basis points (1 basis point is 0.01 percent). |
| `paper.useDepth` | true or false | `true` | Fill a market order at the best opposite price when market depth is available. |
| `paper.pollIntervalMs` | whole number, 250 to 60000 | `2000` | Pending paper orders are priced again at least this often even without new ticks, in milliseconds. |
| `paper.squareOff.enabled` | true or false | `true` | Close open intraday paper positions automatically at the square-off time. |
| `paper.squareOff.time` | text; a fixed pattern | `"15:20"` | The IST time of the intraday square-off. |
| `paper.squareOff.times` | map of name to text | `{}` | Different square-off times per exchange (NSE, BSE, NFO, BFO, MCX, CDS), as HH:MM. Built-in times for MCX and CDS apply under these. |
| `paper.sessionEnd.time` | text; a fixed pattern, or `null` | `null` | Pending DAY orders expire at this IST time. When not set the exchange's session close from the reference data is used. |
| `paper.sessionEnd.times` | map of name to text | `{}` | Different expiry times per exchange, as HH:MM. |
| `paper.margin.model` | one of `portfolio`, `simple` | `"portfolio"` | portfolio margins F&O legs together per underlying with an approximate scan, so hedges count. simple margins every leg by itself with the percentages below. Equity always uses the percentages. |
| `paper.margin.intradayEquityPct` | number, 0 to 100 | `20` | Percentage of order value blocked for intraday equity. |
| `paper.margin.futuresPct` | number, 0 to 100 | `15` | Percentage of contract value blocked for futures, in the simple model or when no underlying price is known. |
| `paper.margin.optionSellPct` | number, 0 to 100 | `15` | Percentage of strike times quantity blocked for option writing, in the simple model or when no underlying price is known. Option buys block the premium. |
| `paper.brokerage.perOrder` | number, 0 to 1000 | `0` | A flat charge in rupees per filled paper order. |
| `paper.brokerage.pct` | number, 0 to 5 | `0` | A percentage of turnover charged per filled paper order. |
| `paper.brokerage.maxPerOrder` | number, at least 0; or `null` | `null` | A cap in rupees on the charge per filled order. null means no cap. |
| `paper.historyLimit` | whole number, 50 to 100000 | `1000` | Finished orders and trades kept per paper account. Pending orders are always kept. |

## readiness

The trading-readiness check of live accounts: session, registered address, headroom and the kill switch. More: [deployment.md](deployment.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `readiness.enabled` | true or false | `true` | Run the trading-readiness checks. |
| `readiness.intervalMinutes` | whole number, 1 to 15 | `4` | Minutes between continuous checks inside the window on trading days. |
| `readiness.window.from` | text; a fixed pattern | `"08:45"` | IST time the continuous checks start. It must be before the end time. |
| `readiness.window.to` | text; a fixed pattern | `"15:45"` | IST time the continuous checks stop. |
| `readiness.preOpenAt` | text; a fixed pattern | `"09:00"` | IST time of the pre-open check of every live account. It must lie inside the window. |
| `readiness.probe.enabled` | true or false | `true` | Make one cheap read call to each live account's broker to prove the session works. |
| `readiness.probe.timeoutMs` | whole number, 1000 to 30000 | `10000` | How long that read may take before it counts as failed, in milliseconds. |
| `readiness.probe.cooldownSeconds` | whole number, 30 to 3600 | `30` | The least time between two probes of one account, in seconds. |
| `readiness.probe.endpointClass` | one of `portfolio`, `other`, `quote` | `"portfolio"` | Which kind of read the probe uses: portfolio, other or quote. |
| `readiness.egressIp.mode` | one of `off`, `lookup`, `manual` | `"off"` | off makes no outside call. lookup asks the service at lookupUrl for this computer's public address and compares it with the registered one. manual records the address you state in manualIp and can never notice a change. |
| `readiness.egressIp.lookupUrl` | text; at most 500 characters, or `null` | `null` | The https address of an IPv4-only address-echo service you choose. That service sees your IP every time. Needed when mode is lookup. |
| `readiness.egressIp.manualIp` | text; at most 64 characters, or `null` | `null` | The address you state this computer uses. Needed when mode is manual. |
| `readiness.egressIp.timeoutMs` | whole number, 500 to 15000 | `5000` | How long the lookup may take, in milliseconds. |
| `readiness.egressIp.maxSkewMs` | whole number, 500 to 600000 | `5000` | The clock difference, in milliseconds, above which the readiness card warns that this computer's clock is off. |
| `readiness.gateAutomated` | true or false | `true` | Refuse automated live orders (alerts) with CANNOT_TRADE while their account cannot trade. false turns the refusal into a warning. |
| `readiness.staleAfterMinutes` | whole number, 2 to 240 | `10` | A reading older than this is shown as not checked recently. |
| `readiness.warn.sessionExpiresWithinMinutes` | whole number, 0 to 720 | `60` | Warn when a broker session ends within this many minutes. |
| `readiness.warn.dailyOrdersLeftPct` | number, 0 to 100 | `10` | Warn when this percentage or less of the daily order count is left. |
| `readiness.warn.dailyLossLeftPct` | number, 0 to 100 | `20` | Warn when this percentage or less of the daily loss limit is left. |
| `readiness.notify.cooldownMinutes` | whole number, 1 to 1440 | `15` | The least time between two notifications about the same problem. |
| `readiness.notify.onRecovery` | true or false | `true` | Notify when an account that could not trade is ready again. |
| `readiness.notify.preopenOnlyIfFailing` | true or false | `true` | Send the pre-open notification only when something is failing. |

## integrations

Defaults for the spreadsheet routes under /xl (Excel, Google Sheets, AmiBroker). More: [excel-sheets.md](excel-sheets.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `integrations.xl.chainFormat` | one of `csv`, `json` | `"csv"` | The format of /xl/chain answers: csv or json. |
| `integrations.xl.historyLayout` | one of `standard`, `amibroker` | `"standard"` | The column layout of /xl/history: standard or amibroker. |
| `integrations.xl.defaultCountback` | whole number, 1 to 5000 | `500` | Bars /xl/history returns when the request gives neither a from date nor a countback. |
| `integrations.xl.maxSymbols` | whole number, 1 to 200 | `100` | The most symbols one /xl/quotes or /xl/instrument request may list. |
| `integrations.xl.cacheSeconds` | whole number, 1 to 60 | `5` | The max-age sent, in seconds, when a caller opts in with ?cache=1. |

## hooks

Alert hooks (TradingView, ChartInk and others): queue, duplicate checks, allowed addresses and limits. More: [webhooks.md](webhooks.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `hooks.queueSize` | whole number, 1 to 5000 | `200` | Alerts waiting to be processed. A full queue answers 429. |
| `hooks.concurrency` | whole number, 1 to 16 | `2` | Alerts processed at the same time. Orders are still capped by the safety order rate. |
| `hooks.dedupeWindowMs` | whole number, 1000 to 86400000 | `120000` | The same alert seen again inside this window is acknowledged as a duplicate, in milliseconds. |
| `hooks.signatureToleranceS` | whole number, 30 to 300 | `300` | For signed generic hooks: how many seconds the signed timestamp may differ from this computer's clock. |
| `hooks.maxSignalsPerMinute` | whole number, 1 to 600 | `30` | Alerts per minute per hook that pass every check. More are held for up to rateWaitSec. |
| `hooks.maxHooks` | whole number, 1 to 1000 | `100` | The most hooks you may create. |
| `hooks.allowSourceIps` | list of text; at most 100 items | `[]` | A list of addresses or IPv4 blocks added to every hook's own list of allowed senders. |
| `hooks.clientIpHeader` | one of `cf-connecting-ip`, `x-forwarded-for`, `x-real-ip`; or `null` | `null` | The header that carries the sender's address behind a local tunnel (cf-connecting-ip, x-forwarded-for or x-real-ip). It is trusted only when the connection itself comes from this computer. |
| `hooks.burstWaitSec` | whole number, 0 to 300 | `30` | An alert that meets the per-account order-rate cap waits up to this many seconds for a free slot, then is reported as rejected. 0 turns waiting off. |
| `hooks.rateWaitSec` | whole number, 0 to 300 | `60` | An alert over maxSignalsPerMinute is held up to this many seconds and then handled; past it the answer is 429. 0 means always 429. |
| `hooks.signalsKept` | whole number, 10 to 1000 | `100` | Recent alerts remembered per hook for the alert history. Kept in memory only. |
| `hooks.presets.tradingview.ips` | list of text; at least 1 item, at most 50 items | required | The addresses TradingView sends alerts from, used when a hook switches on the tradingview address list. Edit it when TradingView changes its list. Needed whenever you give this preset. |
| `hooks.presets.tradingview.verifiedAt` | text; at most 40 characters, or `null` | `null` | The date you last checked that list. |
| `hooks.presets.tradingview.source` | text; at most 300 characters, or `null` | `null` | Where you checked it. |

## mcp

The MCP endpoint for AI assistants. Read-only unless you add order tools here. More: [mcp.md](mcp.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `mcp.enabled` | true or false | `true` | Serve the MCP endpoint. false makes POST /mcp answer 404. |
| `mcp.toolsets` | list of choices (`market`, `analytics`, `account`, `orders`); at most 4 items | `["market","analytics","account"]` | Which groups of tools assistants get: market, analytics, account, orders. Add orders to let assistants prepare orders (a person still confirms each one). |
| `mcp.orderAccounts` | list of text; at most 50 items | `[]` | The accounts order tools may name. Empty means no order tools at all, even with orders in toolsets. |
| `mcp.maxItems` | whole number, 10 to 1000 | `200` | The largest page one tool returns. A cursor fetches the rest. |

## compat

The compatibility REST API at /api/v1 for tools that send the key in the request body. More: [compat-api.md](compat-api.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `compat.enabled` | true or false | `true` | Serve /api/v1. |
| `compat.account` | text; a fixed pattern | not set | The account compatibility calls act on. When not set, the first account the key may use. |
| `compat.analyzer` | true or false | `true` | Start in analyzer mode, which is the Bridge's paper mode. Leaving it only asks for live orders; the Bridge's own live rules still decide. |

## sources

Optional free data sources and plugins. Their answers are labelled delayed or end-of-day and never feed orders. More: [sources.md](sources.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `sources.autoFallback` | true or false | `false` | Let reads no broker can answer fall back to an enabled free source. The answer is labelled delayed or end-of-day. |
| `sources.timeoutMs` | whole number, 100 to 15000 | `5000` | How long one call to a source may take, in milliseconds. |
| `sources.providers` | map of settings, by name | `{}` | Per-source switches by source id. false keeps a source off whatever the dashboard says. A source may read its own other settings here. |
| `sources.providers.<name>.enabled` | true or false | not set | false keeps this source off. |
| `sources.pluginUser.uid` | whole number, 1 to 4294967294 | required | Run plugins as this user id, so a plugin cannot signal the Bridge. Needs the Bridge to run as root; when not permitted, plugins are not started. |
| `sources.pluginUser.gid` | whole number, 1 to 4294967294 | required | The group id to run plugins as. |
| `sources.plugins` | list of settings groups; at most 20 items | `[]` | Plugins to start. Each entry names a folder, its sha256 and whether you grant it permission to run. |
| `sources.plugins[].path` | text; at least 1 character, at most 512 characters | required | The plugin folder. |
| `sources.plugins[].sha256` | text; a fixed pattern | required | The 64-character checksum of the plugin, printed by mc-bridge sources plugins pin. A plugin that does not match does not run. |
| `sources.plugins[].granted` | true or false | `false` | true says you read the plugin and allow it to run. |
| `sources.plugins[].config` | map of name to any value | not set | The plugin's own settings. Never put a secret here. |

## backup

Copies of your data folder: before an upgrade, by hand and on a daily schedule. More: [backup.md](backup.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `backup.keep` | whole number, 1 to 100 | `5` | Automatic copies kept per kind (before an upgrade, before a restore). |
| `backup.maxSizeMb` | whole number, 10 to 10240 | `500` | Settings and state larger than this are not copied automatically. Downloads and recordings are not counted. |
| `backup.includeData` | true or false | `false` | Also put downloads and recordings into manual and daily backups. Large. Never in the copy before an upgrade or a restore. |
| `backup.maxDataFiles` | whole number, 1000 to 5000000 | `50000` | More download and recording files than this and a backup with data is refused with a clear message. |
| `backup.manualKeep` | whole number, 1 to 100 | `5` | Manual backups kept in the data folder. Backups made with --out are never removed. |
| `backup.schedule.enabled` | true or false | `false` | Make a daily backup. |
| `backup.schedule.time` | text; a fixed pattern | `"02:30"` | The time of the daily backup on this computer's clock (HH:MM, 24-hour). |
| `backup.schedule.keep` | whole number, 1 to 365 | `7` | Daily backups kept. |
| `backup.schedule.includeSecrets` | true or false | `false` | Also copy the saved broker logins file. It is useless without the original master key. |

## notify

Phone messages (Telegram): which events, quiet hours, pacing and retries. The bot token is never stored here. More: [notifications.md](notifications.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `notify.enabled` | true or false | `true` | Send phone messages. |
| `notify.events` | map of name to true or false | `{}` | Switch single events on or off by name, for example { "order.placed": true }. Unknown names are refused. |
| `notify.quietHours.enabled` | true or false | `false` | Hold non-critical messages during quiet hours. |
| `notify.quietHours.start` | text; a fixed pattern | `"22:00"` | IST time quiet hours start. |
| `notify.quietHours.end` | text; a fixed pattern | `"07:00"` | IST time quiet hours end. |
| `notify.morning.enabled` | true or false | `true` | Send the morning message about accounts that are not logged in. |
| `notify.morning.at` | text; a fixed pattern | `"08:45"` | IST time of the morning message. The event for your own programs has its own time, morningLogin.remindAt. |
| `notify.morning.secondAt` | text; a fixed pattern | `"09:10"` | IST time of the second nudge at the open. |
| `notify.morning.endOfDay.enabled` | true or false | `false` | Send an end-of-day summary. |
| `notify.morning.endOfDay.at` | text; a fixed pattern | `"15:45"` | IST time of the end-of-day summary. |
| `notify.coalesceSeconds` | whole number, 0 to 600 | `20` | Similar messages arriving within this many seconds are combined into one. |
| `notify.dedupeSeconds` | whole number, 0 to 3600 | `60` | An identical message inside this window is dropped. |
| `notify.rateLimitAlert.threshold` | whole number, 1 to 10000 | `20` | Send a rate-limit warning after this many refusals inside the window. |
| `notify.rateLimitAlert.windowMinutes` | whole number, 1 to 120 | `10` | The window, in minutes, for that count. |
| `notify.pacing.perChatMs` | whole number, 250 to 60000 | `1100` | The least time between two messages to one chat, in milliseconds. |
| `notify.pacing.perSecond` | whole number, 1 to 30 | `20` | Messages per second for the whole bot. |
| `notify.pacing.groupPerMinute` | whole number, 1 to 20 | `18` | Messages per minute to one group chat. |
| `notify.retry.maxAttempts` | whole number, 1 to 20 | `6` | Times a failed message is tried. |
| `notify.retry.baseMs` | whole number, 100 to 60000 | `2000` | The first wait before a retry, in milliseconds. It grows from here. |
| `notify.retry.maxMs` | whole number, 1000 to 3600000 | `300000` | The longest wait between retries, in milliseconds. |
| `notify.retry.maxAgeMinutes` | whole number, 1 to 1440 | `60` | A message older than this is dropped instead of sent late. |
| `notify.queue.max` | whole number, 10 to 5000 | `200` | Messages waiting to be sent. When it is full the oldest message that is not critical is dropped. |
| `notify.inbound.enabled` | true or false | `true` | Answer commands sent to the bot (read-only prices and status). |
| `notify.inbound.commandsPerMinute` | whole number, 1 to 60 | `10` | Commands per minute the bot answers. |
| `notify.inbound.pollSeconds` | whole number, 0 to 50 | `25` | How long one wait for new commands lasts, in seconds. |
| `notify.inbound.allowKill` | true or false | `true` | Let the bot engage the kill switch after a one-time code. Releasing it is never possible from Telegram. |
| `notify.inbound.maxCommandAgeSeconds` | whole number, 10 to 3600 | `120` | A command older than this is ignored, so a message that waited while the Bridge was off does not run later. |

## library

Collections: named lists of instruments and option universes. More: [collections.md](collections.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `library.enabled` | true or false | `true` | Switch collections on. false makes every use answer a plain error. |
| `library.maxCollections` | whole number, 1 to 5000 | `200` | How many collections the store holds. |
| `library.maxSymbols` | whole number, 1 to 50000 | `5000` | The most symbols a collection may hold or resolve to. |
| `library.maxWeeklyExpiries` | whole number, 1 to 12 | `5` | How many weekly expiries all-weekly stops at. |
| `library.allowStaleAtm` | true or false | `false` | Let a labelled stale, delayed or end-of-day price be the default basis of an at-the-money strike for callers that do not say. A spreadsheet request always says no. |
| `library.strikeSteps` | map of name to number, above 0, up to 100000 | `{}` | The strike step of an index, by underlying name, used only when no listed strikes are known. Built in: NIFTY 50, BANKNIFTY 100, FINNIFTY 50, MIDCPNIFTY 25, SENSEX 100, BANKEX 100. A stock's step is never guessed. |

## events

Events out: the event stream with replay, and signed outbound webhooks. More: [events.md](events.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `events.enabled` | true or false | `true` | Serve the event stream and keep the event log. |
| `events.retain` | whole number, 100 to 100000 | `5000` | Events kept for replay, in memory and on disk. They survive a restart. |
| `events.maxEventBytes` | whole number, 1024 to 262144 | `16384` | One event's data above this size is replaced by a short note. |
| `events.heartbeatMs` | whole number, 1000 to 120000 | `15000` | How often a heartbeat goes to event readers, in milliseconds. |
| `events.maxClients` | whole number, 1 to 1000 | `50` | Open event connections, all keys together. |
| `events.maxClientsPerKey` | whole number, 1 to 1000 | `5` | Open event connections for one key. |
| `events.maxBufferedBytes` | whole number, 16384 to 16777216 | `262144` | A reader this far behind is closed. It reconnects with its cursor. |
| `events.webhooks.enabled` | true or false | `true` | Allow signed outbound webhooks. |
| `events.webhooks.maxSubscriptions` | whole number, 1 to 200 | `20` | The most webhook subscriptions. |
| `events.webhooks.allowPrivateTargets` | true or false | `false` | Allow http:// and addresses on this computer or your home network as targets. Cloud metadata addresses are refused even then. Same as mc-bridge subscriptions allow-local. |
| `events.webhooks.allowedHosts` | list of text; at most 100 items | `[]` | When not empty, a target host must match one entry (example.com or *.example.com). |
| `events.webhooks.timeoutMs` | whole number, 1000 to 60000 | `10000` | How long a delivery may take, in milliseconds. |
| `events.webhooks.maxResponseBytes` | whole number, 256 to 65536 | `4096` | How much of a receiver's answer is read, in bytes. |
| `events.webhooks.concurrency` | whole number, 1 to 64 | `16` | Deliveries running at once, all subscriptions together. |
| `events.webhooks.perSubscription` | whole number, 1 to 8 | `2` | Deliveries running at once for one subscription, so a receiver that never answers holds only its own slots. |
| `events.webhooks.breakerAfter` | whole number, 1 to 20 | `3` | After this many failures in a row a subscription gets one attempt per back-off period. |
| `events.webhooks.replayWindowSec` | whole number, 30 to 3600 | `300` | The age in seconds that receivers are told to accept; also sent in a header. |
| `events.webhooks.retry.maxAttempts` | whole number, 1 to 50 | `8` | Attempts per delivery before it becomes a dead letter. |
| `events.webhooks.retry.baseMs` | whole number, 100 to 600000 | `5000` | The first wait before a retry, in milliseconds. It grows from here. |
| `events.webhooks.retry.maxMs` | whole number, 1000 to 86400000 | `3600000` | The longest wait between retries, in milliseconds. |
| `events.webhooks.retry.jitter` | number, 0 to 0.5 | `0.2` | Random variation of each wait, as a fraction (0.2 is 20 percent). |
| `events.webhooks.retry.maxAgeSec` | whole number, 60 to 604800 | `86400` | A delivery older than this stops being retried, in seconds. |
| `events.webhooks.maxPendingPerSubscription` | whole number, 10 to 10000 | `500` | Deliveries waiting for one subscription. More are dropped. |
| `events.webhooks.deadLetterMax` | whole number, 10 to 5000 | `200` | Dead letters kept per subscription. |
| `events.webhooks.deliveryLogMax` | whole number, 50 to 5000 | `500` | Delivery log entries kept per subscription. |

## downloads

Saving history to files, and keeping datasets up to date. More: [downloads.md](downloads.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `downloads.enabled` | true or false | `true` | Switch downloads off completely with false: every route answers CAPABILITY_UNSUPPORTED and nothing runs. |
| `downloads.maxConcurrentJobs` | whole number, 1 to 4 | `1` | Jobs that run at the same time. They still share one budget share per account. |
| `downloads.maxSymbolsPerJob` | whole number, 1 to 500 | `500` | The most symbols in one job. The hard limit is 500. |
| `downloads.retentionDays` | whole number, 1 to 3650; or `null` | `null` | Delete finished jobs and their files after this many days. null keeps them until you delete them. Datasets are never deleted by this. |
| `downloads.maxDiskMb` | whole number, 1 to 10000000 | `5000` | Writing stops when the downloads folder reaches this size, in megabytes. |
| `downloads.minFreeDiskMb` | whole number, 0 to 10000000 | `500` | A job pauses while the disk has less than this free, in megabytes. 0 switches the check off. |
| `downloads.maxQueuedJobs` | whole number, 1 to 500 | `20` | Jobs waiting, running or paused at once, all keys together. A new job over this is refused. |
| `downloads.maxQueuedJobsPerKey` | whole number, 1 to 500 | `8` | The same limit for the jobs started by one key. |
| `downloads.maxStoredJobs` | whole number, 1 to 10000 | `500` | Jobs kept in all, finished ones too. Delete old jobs or set retentionDays when it is reached. |
| `downloads.pauseOnKeyRevoked` | true or false | `true` | Pause a key's open jobs when the key is revoked. |
| `downloads.maxBudgetShare` | number, 0.05 to 0.8 | `0.3` | The share of an account's spare request budget that downloads may use. A live read, an order check or another key always goes first. This is the default; PATCH /v1/downloads/settings changes it while the Bridge runs. |
| `downloads.afterHoursOnly` | true or false | `false` | Run only outside market hours. A job started during the session waits. |
| `downloads.localFirst` | true or false | `true` | Serve ranges already stored in a dataset from disk and fetch only the missing parts. |
| `downloads.retries` | whole number, 0 to 10 | `4` | Times one broker call is tried again after a temporary error before the item fails. |
| `downloads.progressThrottleMs` | whole number, 100 to 60000 | `1000` | How often a running job reports download.progress, in milliseconds. |

## recorder

Recording live prices and option chains to files, by hand or by rules every trading day. More: [recording.md](recording.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `recorder.enabled` | true or false | `true` | Switch the recorder off completely with false. |
| `recorder.maxRecordings` | whole number, 1 to 200 | `10` | Recordings running, paused or waiting at one time. Rules count too. |
| `recorder.maxDiskMb` | whole number, 10 to 10000000 | `5000` | All recordings together, in megabytes. Writing stops at the limit and never goes beyond it. |
| `recorder.retentionDays` | whole number, 1 to 3650; or `null` | `null` | Delete day files older than this many days. null keeps everything. |
| `recorder.compressFinished` | true or false | `false` | Compress the files of finished days with gzip. |
| `recorder.minFreeDiskMb` | whole number, 0 to 1000000 | `500` | Stop writing when the disk has less than this free, in megabytes. |
| `recorder.maxBudgetShare` | number, 0.05 to 0.8 | `0.3` | The share of an account's spare request budget a recording may use when it needs the broker. This is the default; PATCH /v1/recordings/settings changes it while the Bridge runs. |
| `recorder.maxSymbolsPerRecording` | whole number, 1 to 5000 | `1000` | The most symbols one recording may hold. |
| `recorder.maxStreamSymbols` | whole number, 0 to 5000 | `400` | How many symbols one recording asks the live feed for. |
| `recorder.gapAfterSec` | whole number, 5 to 3600; or `null` | `null` | Silence longer than this inside a session is logged as a gap, in seconds. null means three times the interval, at least 30. |
| `recorder.reResolveMinutes` | whole number, 0 to 480 | `30` | A moving universe (an ATM window) is worked out again this often inside the session, in minutes. 0 means once a day. |
| `recorder.autoRecord.enabled` | true or false | `false` | Record by itself every trading day from the rules. Off until a person turns it on. The switch you set in the dashboard or with mc-bridge record auto is stored in the data folder and wins over this value. |
| `recorder.autoRecord.rules` | list of settings groups; at most 50 items | `[]` | Rules kept in the config file. Rules made in the dashboard or the API live in the data folder instead. |
| `recorder.autoRecord.rules[].id` | text; a fixed pattern | not set | A short name for the rule. Made from the name when not given. |
| `recorder.autoRecord.rules[].name` | text; at least 1 character, at most 60 characters | required | The rule's name. |
| `recorder.autoRecord.rules[].enabled` | true or false | `true` | Turn the rule off without deleting it. |
| `recorder.autoRecord.rules[].kind` | one of `quotes`, `chain` | required | quotes records prices; chain records option-chain snapshots. |
| `recorder.autoRecord.rules[].symbols` | list of text; at least 1 item, at most 2000 items | not set | The symbols to record. Give exactly one of symbols, collection or underlying. |
| `recorder.autoRecord.rules[].collection` | text; at least 1 character, at most 80 characters | not set | The name of a collection to record. Worked out again every day. |
| `recorder.autoRecord.rules[].underlying` | one of several forms | not set | One underlying such as NIFTY, or a list of them, with the universe below. |
| `recorder.autoRecord.rules[].universe.expiries` | one of several forms | `"current-weekly"` | current-weekly, next-weekly, current-monthly, all-weekly, or a list of dates. |
| `recorder.autoRecord.rules[].universe.strikes` | one of several forms | `{"around":"atm","count":10}` | { around: "atm", count: 10 } or { from, to }. |
| `recorder.autoRecord.rules[].universe.sides` | list of choices (`CE`, `PE`); at least 1 item, at most 2 items | `["CE","PE"]` | CE, PE or both. |
| `recorder.autoRecord.rules[].universe.includeUnderlying` | true or false | `true` | Also record the underlying itself. |
| `recorder.autoRecord.rules[].universe.includeFuture` | true or false | `false` | Also record the future of the chosen expiry month. |
| `recorder.autoRecord.rules[].everySec` | whole number, 1 to 86400 | required | Seconds between samples. At least 15 for a chain. |
| `recorder.autoRecord.rules[].schedule` | one of several forms | `"market-hours"` | market-hours (trading days from the calendar) or { days, start, end } in IST. |
| `recorder.autoRecord.rules[].keepDays` | whole number, 1 to 3650; or `null` | not set | Keep only this many days of this rule's files. |
| `recorder.autoRecord.rules[].maxDiskMb` | whole number, 1 to 1000000; or `null` | not set | A disk limit for this rule alone, in megabytes. |
| `recorder.autoRecord.rules[].compress` | true or false | not set | Compress this rule's finished days. |
| `recorder.autoRecord.rules[].format` | one of `csv`, `jsonl` | `"csv"` | csv or jsonl. |

## storage

Free-disk checks for the folder the Bridge writes to. More: [operations.md](operations.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `storage.minFreeMb` | whole number, 10 to 1000000 | `1024` | Free space below this makes health say degraded and the Bridge warn, in megabytes. |
| `storage.hardFreeMb` | whole number, 1 to 1000000 | `200` | Free space below this pauses downloads, starts no new download and makes readiness say not ready, in megabytes. It must not be more than minFreeMb. |
| `storage.checkIntervalSec` | whole number, 5 to 3600 | `30` | How often the free space is measured, in seconds. |

In `ratelimit`, `<name>` stands for a name you choose: a broker id, an account id, a key id, or the kind of request. In lists such as `accounts[]` and `sources.plugins[]`, `[]` stands for one entry of the list.
