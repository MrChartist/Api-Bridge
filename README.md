# Mr. Chartist API Bridge

**One local API for all your Indian broker accounts.**

The Bridge connects to your brokers once and lets every tool you use share those connections: Option Hub, your charts, TradingView alerts, Python and Node scripts, Excel and Google Sheets, and AI assistants such as Claude and ChatGPT.

> **Status: v2 rebuild in progress.** The earlier prototype (4 brokers, three of them in mock mode) has been removed. This branch is the new foundation.

## What is here now

- **Broker layer for 33 Indian brokers** behind one contract (`server/brokers/contract.mjs`): login (API key, OAuth token, request-token exchange, or session login where your password and TOTP code are used once and never stored), instruments, expiries, option chain, quotes, depth, historical candles, live feeds for some brokers, positions, holdings, funds, order book, trade book, and orders behind safety gates.
- **Contract test harness** with fixtures taken from each broker's official API documentation. No live calls in tests.
- Docs: [`docs/broker-contract.md`](docs/broker-contract.md) and [`docs/BROKERS.md`](docs/BROKERS.md).

## What is being built

- **Multiple brokers and multiple accounts at once**, each with its own session and limits.
- **Rate-limit engine**: every broker's documented limits respected, requests coalesced and batched, live feeds shared by all clients, and read traffic routed across your own connected accounts.
- **Unified REST API, WebSocket stream and TradingView-compatible chart datafeed.**
- **Integrations**: TradingView webhooks, AmiBroker, Python and TypeScript SDKs, Excel and Sheets, and an MCP server for AI assistants.
- **Safety first**: paper mode by default, scoped API keys, order-rate caps, kill switch, daily limits and a full audit log.

## Development

```bash
npm install
npm test
npm run check:mjs
```

Requires Node.js 20 or newer.

## Licence

Proprietary. See [LICENSE](LICENSE). © Investology (Mr. Chartist).
