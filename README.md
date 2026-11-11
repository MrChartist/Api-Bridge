# API Bridge v2

**One bridge between everything that trades and every broker you use.**

API Bridge is a small service that runs on your own computer. On one side it takes in alerts and API calls from the
tools you already have: TradingView, ChartInk, GoCharting, your Python and Node scripts, Excel and Google Sheets,
AmiBroker, AI assistants. On the other side it holds your broker accounts, several brokers and several accounts each.
In between sits one API, one set of rate limits and one set of safety checks, so no tool has to know which broker it
is talking to and no two tools can trip the same broker limit.

```
 TradingView  ChartInk  GoCharting  ─┐                                  ┌─  Dhan
 Python  Node  REST  WebSocket      ─┤   API Bridge                     ├─  Zerodha
 Excel  Google Sheets  AmiBroker    ─┤   rate limits · safety · paper   ├─  Upstox
 Claude  ChatGPT (MCP)              ─┘                                  └─  ... 41 brokers
```

What is in it:

- **Brokers.** 41 Indian broker adapters behind one common API; several accounts per broker, logged in from the dashboard.
- **Sources.** Inbound webhooks for TradingView, ChartInk, GoCharting and your own signed senders; API keys per tool;
  SDKs for Node and Python (`sdk/`); Excel, Google Sheets and AmiBroker (`integrations/`); MCP tools for AI assistants;
  a compat API at `/api/v1`.
- **Rate-limit management.** Every broker account has one budget that all tools share. The Bridge queues, batches,
  caches and serves from the live stream so the budget goes further, and shows what is used this second.
- **Safety.** Paper trading by default, a kill switch, daily limits, price bands, and explicit opt-ins before any live order.
- **One REST API and one WebSocket stream** for market data and orders, whichever broker is behind them.
- **A dashboard** that looks and behaves like a native app, light and dark, phone to desktop:
  - **Home**: the map of your Bridge (sources, the Bridge, brokers), the live API budget, setup steps, and what became of each alert.
  - **Accounts**: broker accounts and sessions.
  - **API**: keys, integrations, a test console, rate limits, the request log.
  - **Orders** and **Safety**.

Analytics, scanners, calendars, recorder, option desks, journal, alerts and the other trading-desk features are not part of v2. The full app lives in [MrChartist/api-bridge](https://github.com/MrChartist/api-bridge).

## TradingView in two minutes

1. `npm run dev`, then open **API → Integrations → TradingView and webhooks** and choose **Create webhook**.
2. Copy the hook URL (shown once) and the alert message the Bridge wrote for it.
3. In TradingView, create an alert, tick **Webhook URL**, paste the URL (through your tunnel's public address), and paste the message.
4. Fire the alert. Home shows it under **Latest alerts** within a second: placed, or refused with the reason.

Orders are paper until you opt in to live trading. See `docs/guides/webhooks.md`.

## Install and run

Requires Node.js 22 or newer.

```bash
npm ci
npm run dev        # demo mode, no broker needed, opens the dashboard
npm start          # start the Bridge
npm run doctor     # check the setup
npm test           # run the tests
```

The dashboard is served at `http://localhost:4300/dashboard` and opens without a key on the computer the Bridge runs on (see `docs/guides/safety.md` to switch that off). The health check is at `/v1/health`. Copy `bridge.config.example.json` to `bridge.config.json` to configure accounts, ports and limits.

Other commands: `npm run bridge -- <command>` (CLI), `npm run typecheck`, `npm run check:mjs`, `npm run capabilities`.

## Docs

See `docs/`: `guides/` (install, accounts, rate limits, safety, streaming, webhooks, MCP, compat API, SDKs, integrations), `openapi.yaml`, `asyncapi.yaml`, `BROKERS.md`, `ARCHITECTURE.md`, `broker-contract.md`.

## License

MIT, see `LICENSE`.
