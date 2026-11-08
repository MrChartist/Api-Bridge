# API Bridge v2

API Bridge v2 is one local service that sits in front of your Indian broker accounts and exposes a single REST + WebSocket API, so every tool you use shares the same connections and stays inside each broker's rate limits.

What is in it:

- 40+ Indian broker adapters behind one common API
- One REST API and a live WebSocket stream (market data, orders)
- API keys with their own quotas, rate limits and rate-limit-aware routing
- Optional free data sources and plugins, always labelled delayed or end of day
- Paper trading and safety gates
- Inbound webhooks, MCP tools for AI assistants, and a compat API at `/api/v1`
- SDKs (`sdk/` for Node and Python) and integrations (`integrations/` for Excel, Google Sheets, AmiBroker)
- A minimal dashboard with five pages: Accounts, Sources, API, Orders, Safety

It is a connection layer, not a trading desk: it has no analytics, scanners, journal or strategy features. Build those on top of the API.

## Install and run

Requires Node.js 22 or newer.

```bash
npm ci
npm run dev        # demo mode, no broker needed, opens the dashboard
npm start          # start the Bridge
npm run doctor     # check the setup
npm test           # run the tests
```

The dashboard is served at `http://localhost:4300/dashboard` and the health check at `/v1/health`. Copy `bridge.config.example.json` to `bridge.config.json` to configure accounts, ports and limits.

Other commands: `npm run bridge -- <command>` (CLI), `npm run typecheck`, `npm run check:mjs`, `npm run capabilities`.

## Sources, limits and pooling

Real-time prices and option chains come from your own broker accounts. You can also switch on free data sources or
plugins; their answers are labelled delayed or end of day and are never used for orders, risk checks, paper fills or
alerts. The Bridge keeps every broker inside its documented limits, shares them fairly between your tools (each API key
has its own quota), and says why a request was held back. Spreading reads over several of your own accounts (pooling) is
off until you accept a notice that names the risk. See [docs/guides/sources.md](docs/guides/sources.md) and
[docs/guides/rate-limits.md](docs/guides/rate-limits.md); the Sources page in the dashboard shows how it is going.

## Docs

See `docs/`: `guides/` (install, accounts, rate limits, sources, safety, streaming, webhooks, MCP, compat API, SDKs, integrations), `openapi.yaml`, `asyncapi.yaml`, `BROKERS.md`, `ARCHITECTURE.md`, `broker-contract.md`.

## License

MIT, see `LICENSE`.
