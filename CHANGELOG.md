# Changelog

## Unreleased

- The dashboard opens without a key on the computer the Bridge runs on (`POST /v1/sign-in/local`: loopback and the Bridge's own page only). `server.keylessSignIn: false` switches it off; it is off by default with `server.localPeers` or a remote dashboard.
- TradingView is a webhook source (`"source": "tradingview"`): strategy, indicator and price alerts, JSON or text, with ready alert messages for each hook.
- Dashboard: a Home page with the map of sources, the Bridge and brokers, the live broker API budget, setup steps, the latest alerts (placed or refused, with the reason) and the latest calls from other tools.
- Dashboard: an iOS finish across every page (`ios.css`): system blue for actions and the current page, iOS segmented controls, switches and ticks, panels on soft depth, lit icon tiles, a red kill switch. Home leads with a status widget whose colour is its state, and sources you have not set up are a grid of icons to pick from.
- Dashboard: Home, Accounts, API and Orders are in the phone tab bar; shortcuts are 1 to 5 in the order of the sidebar.
- Dashboard: Orders no longer shows a Triggers card or links to the option chain (neither is part of v2).
- Fixed: the Bridge did not start from a fresh clone, because `server/bridge/reference/data/` was ignored by git. The four data files are back (rebuilt, marked unverified where they could not be checked) and the ignore rule is gone.

## 2.0.0

Cut from MrChartist/api-bridge: the API connection layer only (broker adapters, accounts, auth, API keys, rate limits, symbols, market data, stream, orders, paper trading, safety, readiness, webhooks, MCP, compat API, SDKs, integrations) and a minimal dashboard (Accounts, API, Orders, Safety).
