# API Bridge v2

One local API in front of your Indian broker accounts, so every tool you run shares the same connections and stays inside each broker's rate limits.

It is for developers, traders and anyone building their own tools (a script, a spreadsheet, an AI assistant, a dashboard) who would rather talk to one steady API than log in to and rate-limit each broker separately.

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/accounts-dark.webp">
    <img src="docs/screenshots/accounts-light.webp" alt="The Accounts page of the dashboard, in demo mode, listing a demo market-data account and three paper accounts" width="32%">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/sources-overview-dark.webp">
    <img src="docs/screenshots/sources-overview-light.webp" alt="The Sources page, showing how much request room each broker and data source has left" width="32%">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/orders-dark.webp">
    <img src="docs/screenshots/orders-light.webp" alt="The Orders page with a few paper orders, two open and two filled" width="32%">
  </picture>
</p>

More: [Sources, providers](docs/screenshots/sources-providers-light.webp) · [API keys](docs/screenshots/api-keys-light.webp) · [Safety](docs/screenshots/safety-light.webp) · [on a phone](docs/screenshots/accounts-phone.webp). All screenshots are demo mode: sample prices, no broker, no real data.

## What you get

- **One API over 41 brokers.** REST and a WebSocket stream for quotes, option chains, history, positions, funds and orders, the same shape whichever broker is behind it. Only Dhan is verified with a live account; the other 40 are beta, written from official documentation and tested against recorded responses ([BROKERS.md](docs/BROKERS.md)).
- **Shared limits.** The Bridge keeps every broker inside its documented limits and splits the room fairly between your tools. Each API key has its own quota, and a refused request says whose limit it hit and when to retry.
- **Honest data sources.** Real-time prices come from your own broker. You can switch on free delayed or end-of-day sources, or write a plugin; every answer is labelled with its class, delay and whether the source is official, and such data is never used for orders or alerts.
- **Paper trading by default.** Every order is a paper order unless you go out of your way to make it live.
- **A dashboard**, plus MCP tools for AI assistants, signed webhooks, SDKs for Node and Python, and integrations for Excel, Google Sheets and AmiBroker.

## Five minutes to a first answer

You need Node.js 22.12 or newer.

```bash
git clone https://github.com/MrChartist/api-bridge-v2.git
cd api-bridge-v2
npm ci
npm run dev                                   # demo mode: sample data, no broker, opens the dashboard
```

In a second terminal, from the same folder:

```bash
npm run bridge -- keys create --label first --scope read,paper     # prints a key once: copy it
export MCB_API_KEY=mcb_...                                             # the key you were just shown
curl "http://127.0.0.1:4300/v1/ltp?symbols=NSE:RELIANCE" -H "Authorization: Bearer $MCB_API_KEY"
```

The full walk-through, with the output of every command (a paper order, the sources list, a WebSocket stream) and fixes for the usual problems, is [docs/guides/quickstart.md](docs/guides/quickstart.md). Demo prices are generated on your computer; they are not market data.

### Docker

`docker compose up -d` builds and starts the Bridge from `docker-compose.yml`, published on `127.0.0.1:4300` only. The first start writes a config and prints an admin key once: read it with `docker compose logs bridge`. Set `MCB_DEMO: "1"` in the compose file for demo mode. Without Docker, the [one-step installer](docs/guides/install.md) needs no Node.js.

## Safety stance

- **Paper by default.** Live orders need every one of these: `safety.liveTrading` on in the config file, the account marked live, the request source allowed, an API key with the `live` scope (created on this computer), `"mode": "live"` in the request, an idempotency key, and every safety check passing. AI assistants additionally need a human to confirm. A request that misses one is refused, never quietly downgraded. See [safety guide](docs/guides/safety.md).
- **This computer only.** The Bridge listens on `127.0.0.1` and keeps broker credentials encrypted in its data folder.
- **Pooling is off.** Spreading reads over several of your own accounts can give you more room, but no broker's terms clearly allow it. It stays off until you accept a notice that names the risk ([rate limits](docs/guides/rate-limits.md)).
- **Free sources are labelled, not trusted.** A delayed or end-of-day answer says so, and the Bridge refuses to use it for an order, a risk check, a paper fill or an alert ([sources](docs/guides/sources.md)).

## What it does not do

- It is a connection layer, not a trading desk: no analytics, scanners, journal or strategies. Build those on top of the API.
- It gives no financial advice and does not recommend trades.
- It does not provide free real-time market data. None exists in India that you may redistribute; real-time prices come from your broker account.
- It does not make a beta broker safe for live trading. Try it in paper mode first and check figures against your broker.

## Guides

[Quickstart](docs/guides/quickstart.md) · [FAQ](docs/guides/faq.md) · [One-step installer](docs/guides/install.md) · [Accounts](docs/guides/accounts.md) · [Rate limits](docs/guides/rate-limits.md) · [Sources](docs/guides/sources.md) · [Safety](docs/guides/safety.md) · [Streaming](docs/guides/streaming.md) · [MCP for AI assistants](docs/guides/mcp.md) · [Node SDK](docs/guides/typescript.md) · [Python SDK](docs/guides/python.md) · [Webhooks](docs/guides/webhooks.md) · [Excel and Sheets](docs/guides/excel-sheets.md) · [AmiBroker](docs/guides/amibroker.md)

All guides are listed in [docs/guides/README.md](docs/guides/README.md). Reference: [openapi.yaml](docs/openapi.yaml), [asyncapi.yaml](docs/asyncapi.yaml), [ARCHITECTURE.md](docs/ARCHITECTURE.md), [BROKERS.md](docs/BROKERS.md).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

MIT, see [LICENSE](LICENSE).
