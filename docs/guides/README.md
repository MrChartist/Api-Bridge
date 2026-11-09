# Mr. Chartist API Bridge: guides

Start with the [quickstart](quickstart.md) (five minutes, demo mode, no broker needed) or the [docs home](../README.md), which sorts the guides by what you want to do. These guides go deeper, one topic each.

| Guide | For |
|---|---|
| [quickstart.md](quickstart.md) | Clone, start in demo mode, make a key, get a price, place a paper order, read a stream; and what to do when it does not work |
| [faq.md](faq.md) | Is it free, is my broker supported, why pooling is off, why Yahoo is not real-time, where the data lives, how to reset |
| [install.md](install.md) | Installing in one step on Windows, Mac or Linux (no Node.js, no admin password), updating, uninstalling |
| [accounts.md](accounts.md) | Adding brokers and several accounts, logging in, sessions, family accounts |
| [rate-limits.md](rate-limits.md) | How the Bridge stays inside every broker's limits, spreading reads over your own accounts |
| [sources.md](sources.md) | Where prices come from: your brokers, optional free sources and plugins, what delayed, end-of-day and unofficial mean, how to turn a source on |
| [paper-margin.md](paper-margin.md) | How the paper engine estimates margin for F&O positions |
| [compat-api.md](compat-api.md) | `/api/v1` apikey-in-body REST and WebSocket for existing algo tools and SDKs |
| [streaming.md](streaming.md) | WebSocket and SSE live data |
| [webhooks.md](webhooks.md) | TradingView, signed generic, ChartInk and GoCharting alerts |
| [webhooks.md](webhooks.md) | Signed generic, ChartInk and GoCharting alerts |
| [alert-orders.md](alert-orders.md) | Target-size and basket orders, MIS/NRML words, symbol check, basket margin, market calendar |
| [amibroker.md](amibroker.md) | AmiBroker AFL and ASCII import |
| [python.md](python.md) | Python SDK |
| [typescript.md](typescript.md) | Node and TypeScript SDK |
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
