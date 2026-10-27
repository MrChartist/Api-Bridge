# Mr. Chartist API Bridge: guides

Start with the [main README](../../README.md) for the quick start. These guides go deeper, one topic each.

| Guide | For |
|---|---|
| [accounts.md](accounts.md) | Adding brokers and several accounts, logging in, sessions, family accounts |
| [rate-limits.md](rate-limits.md) | How the Bridge stays inside every broker's limits, spreading reads over your own accounts |
| [backup-data.md](backup-data.md) | Yahoo Finance and NSE website as a labelled fallback when no broker can answer |
| [scanner.md](scanner.md) | Condition scans over big universes, scheduled scans and alerts |
| [notifications.md](notifications.md) | Saved-scan alerts, fills, kill switch and expired sessions to Telegram, Discord, Slack or a webhook |
| [compat-api.md](compat-api.md) | `/api/v1` apikey-in-body REST and WebSocket for existing algo tools and SDKs |
| [streaming.md](streaming.md) | WebSocket and SSE live data |
| [charts.md](charts.md) | TradingView-compatible UDF datafeed, Lightweight Charts |
| [webhooks.md](webhooks.md) | TradingView, ChartInk, GoCharting and signed generic alerts |
| [amibroker.md](amibroker.md) | AmiBroker AFL and ASCII import |
| [python.md](python.md) | Python SDK |
| [typescript.md](typescript.md) | Node and TypeScript SDK |
| [excel-sheets.md](excel-sheets.md) | Excel `WEBSERVICE`, Power Query, Google Sheets |
| [mcp.md](mcp.md) | Claude Desktop, Claude Code, Cursor (MCP) |
| [chatgpt-openai.md](chatgpt-openai.md) | ChatGPT and OpenAI function calling |
| [safety.md](safety.md) | Paper and live modes, keys, limits, kill switch, audit |
| [compliance.md](compliance.md) | SEBI, exchange and broker rules that shape the design (with needs-verification flags) |

Reference: [openapi.yaml](../openapi.yaml) (REST), [asyncapi.yaml](../asyncapi.yaml) (streams),
[ARCHITECTURE.md](../ARCHITECTURE.md) (design), [BROKERS.md](../BROKERS.md) (broker table).
