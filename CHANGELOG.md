# Changelog

## Unreleased

- Tools on the computer the Bridge runs on need no API key for now: REST, the live stream and the compat API treat a request with no key as "This computer" (read, paper and admin; never live). `server.keylessApi: false` or `MCB_KEYLESS=0` requires keys again.
- The dashboard opens without a key on the computer the Bridge runs on (`POST /v1/sign-in/local`: loopback and the Bridge's own page only). `server.keylessSignIn: false` switches it off; it is off by default with `server.localPeers` or a remote dashboard.
- TradingView is a webhook source (`"source": "tradingview"`): strategy, indicator and price alerts, JSON or text, with ready alert messages for each hook.
- Dashboard: a Home page with the map of sources, the Bridge and brokers, the live broker API budget, setup steps, the latest alerts (placed or refused, with the reason) and the latest calls from other tools.
- Dashboard: an iOS finish across every page (`ios.css`): system blue for actions and the current page, iOS segmented controls, switches and ticks, panels on soft depth, lit icon tiles, a red kill switch. Home leads with a status widget whose colour is its state, and sources you have not set up are a grid of icons to pick from.
- First run: the dashboard opens with a short welcome guide (connect a broker, connect alerts, where to look). It shows once and can be reopened from Home.
- The window of the Windows app, the Mac app and the start files now shows a short plain status (running, the dashboard address, the next step, how to stop) instead of an admin key, commands and log lines.
- A double-clicked app no longer fails on a busy port: it starts on the next free one and says so, opens the dashboard of a copy that is already running, keeps the reason on screen when it cannot start, and keeps a copy of its window in `logs/window.log` (Windows app).
- Fixed: the Bridge refused to start with a settings file written by the full Mr. Chartist app ("Unknown config section \"backup\""). Whole sections this version does not have are now left out with a note; a typo inside a section it knows is still an error.
- Windows Setup now carries on as the app in the same window, and runs the new version even when an older Bridge window is still open.
- Dashboard: choices that mean something take its colour (BUY green, SELL red, MARKET amber, LIMIT blue); order sides are tinted tags; dropdowns are pop-up buttons with a floating, rounded menu where the browser allows it.
- Dashboard: a broker's raw error (status and JSON) is shown as its sentence plus the next step, for example what to do when a broker token has expired.
- Dashboard: a Data page. It lists every connected account that can give prices, backfills price history for up to 50 symbols at once (trying the next source when one cannot answer), and downloads the result as one CSV or JSON; it also shows the same call for other projects.
- Dashboard: a New order ticket on the Orders page. Buy or sell by hand with every order type (Limit, Market, SL, SL-M), product (CNC, Intraday, Margin, MTF) and validity (Day, IOC); "Check order" lists every warning and block before anything is placed.
- Webhooks: stop-loss order types. A hook can now place SL (stop-loss limit) and SL-M (stop-loss market) orders as well as LIMIT and MARKET; the alert carries a `triggerPrice` (text alerts: `trigger=1400`). TradingView, GoCharting and signed JSON; not ChartInk, whose alerts carry one price.
- Dashboard: API › Integrations › Your project. One place to connect another project: the address with a live check, a ready `.env`, Python and Node starters that need no packages, the OpenAPI file to import, and the call for each thing a project usually wants.
- Forwarding: the Bridge can send each order update to a URL in another project (`/v1/forwards`, and API › Integrations › Your project). Signed JSON (`X-MCB-Signature`), retried three times, one queue per project; https, or http to this computer only. Also kill switch, account session and unknown-outcome events.
- Dashboard: Orders › Positions. Open positions and delivery holdings across every connected account, with profit and loss; Exit and Sell open the order ticket already filled in.
- Dashboard: removed three leftovers from the full app that v2 cannot serve (the alert bell, the market-alert and scan commands, a holders lookup), which made three failed calls on every page; the command palette gains New order and Connect your project.
- Forwarding: the same state of an order is sent once, not twice.
- Docs: `docs/guides/data-api.md`, the contract for the data calls other projects point at (connect, every call, freshness, partial errors, error codes, limits, what stays stable).
- Dashboard: the Data page offers exactly the intervals the history API accepts; its "1 hour" choice was sending a name the API refuses.
- Downloads: a Mac app (`Mr-Chartist-Bridge-<version>-macos-<arch>.app.zip`) next to the Windows Setup .exe and the ZIPs. It keeps settings, data and caches in `~/.mc-bridge`, never inside the app.
- The one-line installers, package metadata and help links now point at `MrChartist/api-bridge-v2` (they pointed at the full app's repository).
- Dashboard: Home refreshes itself when an alert arrives, a hook is added, a tool calls or the kill switch changes.
- README rewritten with screenshots (`docs/screenshots`) and a 60-second announcement video (`docs/media/announcement.mp4`).
- Dashboard: Home, Accounts, API and Orders are in the phone tab bar; shortcuts are 1 to 5 in the order of the sidebar.
- Dashboard: Orders no longer shows a Triggers card or links to the option chain (neither is part of v2).
- Fixed: the Bridge did not start from a fresh clone, because `server/bridge/reference/data/` was ignored by git. The four data files are back (rebuilt, marked unverified where they could not be checked) and the ignore rule is gone.

## 2.0.0

Cut from MrChartist/api-bridge: the API connection layer only (broker adapters, accounts, auth, API keys, rate limits, symbols, market data, stream, orders, paper trading, safety, readiness, webhooks, MCP, compat API, SDKs, integrations) and a minimal dashboard (Accounts, API, Orders, Safety).
