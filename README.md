# API Bridge v2

API Bridge v2 is the **API connection layer only** of Mr. Chartist API Bridge: one local service that sits in front of your Indian broker accounts and exposes a single REST + WebSocket API.

What is in it:

- 40+ Indian broker adapters behind one common API
- One REST API and a live WebSocket stream (market data, orders)
- API keys, rate limits and rate-limit-aware routing
- Paper trading and safety gates
- Inbound webhooks, MCP tools for AI assistants, and a compat API at `/api/v1`
- SDKs (`sdk/` for Node and Python) and integrations (`integrations/` for Excel, Google Sheets, AmiBroker)
- A minimal dashboard with four pages: Accounts, API, Orders, Safety

Analytics, scanners, calendars, recorder, option desks, journal, alerts and the other trading-desk features are not part of v2. The full app lives in [MrChartist/api-bridge](https://github.com/MrChartist/api-bridge).

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
