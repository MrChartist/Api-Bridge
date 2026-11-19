# Mr. Chartist API Bridge: guides

Start with the [quickstart](quickstart.md) (five minutes, demo mode, no broker needed) or the [docs home](../README.md), which sorts the guides by what you want to do. These guides go deeper, one topic each.

## Running mc-bridge

Commands in these guides start with `mc-bridge`. It is not on your PATH from a git checkout, so use `npm run bridge -- <command>` in the repository folder instead (for example `npm run bridge -- keys create --label me --scope read`). `node bin/mc-bridge.mjs <command>` does the same. Do not run it through npx: this project is not published to npm, and the name `mc-bridge` there belongs to an unrelated package. The Bridge's own hints (the dashboard and the command line) show the form that fits your setup.

On Windows, run the commands in PowerShell, and read [windows.md](windows.md) for the few places where the shell matters.

| Guide | For |
|---|---|
| [quickstart.md](quickstart.md) | Clone, start in demo mode, make a key, get a price, place a paper order, read a stream; and what to do when it does not work |
| [orders.md](orders.md) | Orders in one place: paper and live, the live opt-ins, tickets and confirmation on this computer, product words, target-size and basket orders, idempotency, and what `OUTCOME_UNKNOWN` means and what to do |
| [troubleshooting.md](troubleshooting.md) | What you see, the cause and the fix: by symptom and by error code, with real example answers |
| [glossary.md](glossary.md) | What the words mean: freshness, data class, ATM, ticket, cursor, dead letter and the rest (generated from the dashboard's own glossary) |
| [faq.md](faq.md) | Is it free, is my broker supported, why pooling is off, why Yahoo is not real-time, where the data lives, how to reset |
| [cli.md](cli.md) | Every `mc-bridge` command group, which credential each needs (none, the local control token, a read key, an admin key), exit codes, where the Bridge looks for settings |
| [windows.md](windows.md) | PowerShell instead of bash, `curl.exe`, where the files are on Windows, protecting the master key, firewall, start at login |
| [docker.md](docker.md) | The Dockerfile and compose file: start, what the compose file sets up, the dashboard from a container, running commands, backup, upgrade and what goes wrong |
| [upgrading.md](upgrading.md) | Upgrading: which version you have, what to do before, the copy the Bridge makes by itself, going back, and the messages about settings a new version no longer accepts |
| [downloads.md](downloads.md) | Saving history to files (CSV, JSONL, AmiBroker), datasets that update from their last bar, the API budget share, and the estimate before you start |
| [data.md](data.md) | Saving data: which of downloads, recordings, collections and datasets to use, local-first reads, and three recipes (two years of 5-minute bars, daily option chains read in Python, a dataset kept up to date by a scheduled command) |
| [backup.md](backup.md) | Backing up and restoring your data, the copy made before an upgrade, the daily backup, and a recovery runbook (disk died, wrong upgrade, new computer) |
| [connect.md](connect.md) | The dashboard's Connect a tool page: pick Excel, an AI assistant, a script or AmiBroker, get a key with only the access it needs and the setup to paste |
| [operations.md](operations.md) | Running the Bridge day to day: one Bridge per data folder, stopping, damaged files, disk space, health and readiness, metrics, logs, webhooks that do not answer, sleep and wake |
| [config.md](config.md) | Every `bridge.config.json` setting with its type, default and what it does (generated from the code) |
| [orders-drift.md](orders-drift.md) | The read-only order-book check: when it runs, what differences it reports, where you see them, and what it never does |
| [accounts.md](accounts.md) | Adding brokers and several accounts, logging in, sessions, family accounts |
| [dhan.md](dhan.md) | Connect Dhan, the broker checked with a live account: what you need from Dhan, add, log in, test, a first real price, what the adapter does and its limits, the daily routine and going live |
| [rate-limits.md](rate-limits.md) | How the Bridge stays inside every broker's limits, spreading reads over your own accounts |
| [sources.md](sources.md) | Where prices come from: your brokers, optional free sources and plugins, what delayed, end-of-day and unofficial mean, how to turn a source on |
| [paper-margin.md](paper-margin.md) | How the paper engine estimates margin for F&O positions |
| [compat-api.md](compat-api.md) | `/api/v1` apikey-in-body REST and WebSocket for existing algo tools and SDKs |
| [streaming.md](streaming.md) | WebSocket and SSE live data |
| [data-api.md](data-api.md) | The data calls every project points at: prices, history, option chain, instruments |
| [events.md](events.md) | Bridge events out without polling: SSE and WebSocket with cursor replay, signed webhooks with retries and dead letters, receiver code for Node, Python and the shell |
| [webhooks.md](webhooks.md) | TradingView, signed generic, ChartInk and GoCharting alerts |
| [tradingview.md](tradingview.md) | TradingView alerts in ten minutes: make a paper hook and test it, the sender addresses, the exact messages to paste, and the checks that tell you it works |
| [symbols.md](symbols.md) | How an instrument is written (shares, indices, futures, options), finding and converting a symbol, expiries and strikes, why an expired contract is not found |
| [alert-orders.md](alert-orders.md) | Target-size and basket orders, MIS/NRML words, symbol check, basket margin, market calendar |
| [telegram.md](telegram.md) | Alerts on your phone and read-only price and status commands: BotFather steps, which events, safety stance, troubleshooting |
| [notifications.md](notifications.md) | How a message travels (outbox, retries, pacing, quiet hours), the `notify` settings and routes |
| [recording.md](recording.md) | Saving real-time prices and option chains to files on your computer, by hand or by rules every trading day: market hours, gaps, disk limits, retention, the file layout, saving API calls |
| [tick-research.md](tick-research.md) | Recording every tick in arrival order, reading stored ticks in place from any store, writing a signal once, and proving the historical run and a replay through the live path give identical output |
| [amibroker.md](amibroker.md) | AmiBroker AFL and ASCII import |
| [developers.md](developers.md) | Start in five minutes, starters (`mc-bridge init`), auth and scopes, limits and retries, errors, pagination, idempotency, events, data downloads, versioning promise |
| [python.md](python.md) | Python SDK |
| [typescript.md](typescript.md) | Node and TypeScript SDK |
| [collections.md](collections.md) | Named, tagged lists of instruments and option universes (rolling expiry, ATM strike) for downloads, recordings, sheets and Python; import, export, size estimate |
| [excel-sheets.md](excel-sheets.md) | Excel `WEBSERVICE`, Power Query, Google Sheets |
| [mcp.md](mcp.md) | Claude Desktop, Claude Code, Cursor (MCP) |
| [chatgpt-openai.md](chatgpt-openai.md) | ChatGPT and OpenAI function calling |
| [expose-alerts.md](expose-alerts.md) | Letting TradingView alerts and a Google Sheet reach the Bridge through a tunnel or proxy without exposing the dashboard: `mc-bridge expose`, the safe layout, provider recipes, tests |
| [vps.md](vps.md) | A hardened VPS recipe: firewall, systemd or Docker, reaching the dashboard, static IP registration and change planning, updating, backups |
| [deployment.md](deployment.md) | Static IP for live orders (ISP, VPS, VPN), the daily login and the trading-readiness badge |
| [safety.md](safety.md) | Paper and live modes, keys, limits, kill switch, audit |
| [compliance.md](compliance.md) | SEBI, exchange and broker rules that shape the design (with needs-verification flags) |

Reference: [one page per endpoint](../api/README.md) and the [error codes](../api/errors.md), [openapi.yaml](../openapi.yaml) (REST),
[asyncapi.yaml](../asyncapi.yaml) (streams),
[ARCHITECTURE.md](../ARCHITECTURE.md) (design), [BROKERS.md](../BROKERS.md) (broker table),
[source-contract.md](../source-contract.md) (writing a data source or plugin),
[sources-architecture.md](../sources-architecture.md) (how sources, routing and quotas fit together).
For AI assistants: [llms.txt](../llms.txt) and [llms-full.txt](../llms-full.txt).
