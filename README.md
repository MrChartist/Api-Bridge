# API Bridge v2

API Bridge v2 is one local service that sits in front of your Indian broker accounts and exposes a single REST + WebSocket API, so every tool you use shares the same connections and stays inside each broker's rate limits.

What is in it:

- 40+ Indian broker adapters behind one common API
- One REST API and a live WebSocket stream (market data, orders)
- API keys, rate limits and rate-limit-aware routing
- Paper trading and safety gates
- Inbound webhooks, MCP tools for AI assistants, and a compat API at `/api/v1`
- SDKs (`sdk/` for Node and Python) and integrations (`integrations/` for Excel, Google Sheets, AmiBroker)
- A minimal dashboard with four pages: Accounts, API, Orders, Safety

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

## Docs

See `docs/`: `guides/` (install, accounts, rate limits, safety, streaming, webhooks, MCP, compat API, SDKs, integrations), `openapi.yaml`, `asyncapi.yaml`, `BROKERS.md`, `ARCHITECTURE.md`, `broker-contract.md`.

## License

MIT, see `LICENSE`.
