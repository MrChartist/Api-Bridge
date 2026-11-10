# Mr. Chartist API Bridge: guides

Start with the [quickstart](quickstart.md) (five minutes, demo mode, no broker needed) or the [docs home](../README.md), which sorts the guides by what you want to do. These guides go deeper, one topic each.

**Running `mc-bridge`.** Commands in these guides start with `mc-bridge`. That command is on your PATH after you use one of the installers in [install.md](install.md). From a git checkout, use `npm run bridge -- <command>` (or `node bin/mc-bridge.mjs <command>`) in the repository folder instead. Do not run it through npx: this project is not published to npm, and the name `mc-bridge` there belongs to an unrelated package.

| Guide | For |
|---|---|
| [quickstart.md](quickstart.md) | Clone, start in demo mode, make a key, get a price, place a paper order, read a stream; and what to do when it does not work |
| [faq.md](faq.md) | Is it free, is my broker supported, why pooling is off, why Yahoo is not real-time, where the data lives, how to reset |
| [install.md](install.md) | Installing in one step on Windows, Mac or Linux (no Node.js, no admin password), updating, uninstalling |
| [downloads.md](downloads.md) | Saving history to files (CSV, JSONL, AmiBroker), datasets that update from their last bar, the API budget share, and the estimate before you start |
| [backup.md](backup.md) | Backing up and restoring your data, the copy made before an upgrade, the daily backup, and a recovery runbook (disk died, wrong upgrade, new computer) |
| [accounts.md](accounts.md) | Adding brokers and several accounts, logging in, sessions, family accounts |
| [rate-limits.md](rate-limits.md) | How the Bridge stays inside every broker's limits, spreading reads over your own accounts |
| [sources.md](sources.md) | Where prices come from: your brokers, optional free sources and plugins, what delayed, end-of-day and unofficial mean, how to turn a source on |
| [paper-margin.md](paper-margin.md) | How the paper engine estimates margin for F&O positions |
| [compat-api.md](compat-api.md) | `/api/v1` apikey-in-body REST and WebSocket for existing algo tools and SDKs |
| [streaming.md](streaming.md) | WebSocket and SSE live data |
| [events.md](events.md) | Bridge events out without polling: SSE and WebSocket with cursor replay, signed webhooks with retries and dead letters, receiver code for Node, Python and the shell |
| [webhooks.md](webhooks.md) | TradingView, signed generic, ChartInk and GoCharting alerts |
| [webhooks.md](webhooks.md) | Signed generic, ChartInk and GoCharting alerts |
| [alert-orders.md](alert-orders.md) | Target-size and basket orders, MIS/NRML words, symbol check, basket margin, market calendar |
| [telegram.md](telegram.md) | Alerts on your phone and read-only price and status commands: BotFather steps, which events, safety stance, troubleshooting |
| [notifications.md](notifications.md) | How a message travels (outbox, retries, pacing, quiet hours), the `notify` settings and routes |
| [recording.md](recording.md) | Saving real-time prices and option chains to files on your computer, by hand or by rules every trading day: market hours, gaps, disk limits, retention, the file layout, saving API calls |
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
[asyncapi.yaml](../asyncapi.yaml) (streams), [Postman and Bruno collections](../collections/README.md),
[ARCHITECTURE.md](../ARCHITECTURE.md) (design), [BROKERS.md](../BROKERS.md) (broker table),
[source-contract.md](../source-contract.md) (writing a data source or plugin),
[sources-architecture.md](../sources-architecture.md) (how sources, routing and quotas fit together).
For AI assistants: [llms.txt](../llms.txt) and [llms-full.txt](../llms-full.txt).
