# Changelog

## Unreleased

- TradingView alerts are a first-class source: `POST /v1/hooks` with `"source": "tradingview"` (URL token plus a
  passphrase inside the message, stored hashed; JSON or plain-text alerts in our own schema; chart tickers such as
  `NSE:M_M` and `NSE:NIFTY1!` resolved through the chart mapping; an editable TradingView sender-address preset;
  `maxAgeSec` stale-alert limit; replay and duplicate protection on id + time + symbol + side that survives a restart;
  a derived `clientOrderId`; bursts wait for an order slot instead of being rejected). New `GET /v1/hooks/{hookId}/signals`,
  `POST /v1/hooks/{hookId}/test`, `GET /v1/hooks/presets`, the `hook.rejected` bus event, a TradingView panel in the
  dashboard, and a verified TradingView section in [docs/guides/webhooks.md](docs/guides/webhooks.md). Generic hooks no
  longer swallow a later alert that reuses an `id` with a new `time`.
- Declining a pending confirmation is real now: `POST /v1/tickets/{ticketId}/reject` (admin, this computer only, optional
  `{ "reason" }` up to 200 characters) removes the ticket for good, so it can never be confirmed later; a ticket that
  was confirmed, used or has expired answers 409 with its `state`. It is audited as `ticket.rejected`, announced on the
  event bus, and the last ones stay listed for 15 minutes in `GET /v1/tickets?state=rejected`. The dashboard's Decline
  button uses it (an optional reason, the card goes at once and returns if the Bridge refuses, a "Recently declined"
  list). AI assistants get the MCP tool `check_order_ticket` (`status: "rejected"` with the reason) and
  `submit_confirmed_order` refuses a declined ticket plainly; a webhook signal waiting on it ends as `rejected`.
- Data sources and plugins: optional free sources and owner-approved plugins next to your broker accounts, each answer
  labelled with its data class (`realtime`, `delayed`, `eod`), delay, `official` flag and confidence; `/v1/sources`, a
  routing trace, pooling consent, per-key quotas, `limits?explain=1` and a `purpose` read parameter. Plugins run in their
  own process with a brokered, allow-listed network and a hash pin, and never see credentials or order code. New:
  `mc-bridge sources ...`, [docs/guides/sources.md](docs/guides/sources.md), [docs/source-contract.md](docs/source-contract.md)
  and `examples/source-plugin/`.
- Sources page in the dashboard (Overview, Providers, Quotas) replaces API > Rate limits. Recent requests show what
  answered each market read: `GET /v1/requests` entries carry `route` (`from`, `source`, `sourceName`, `class`,
  `delaySec`).
- First run: a "Get started" checklist on the Accounts page (five steps from the demo or your broker to a first
  `curl` call, a paper order and the Sources page; each step ticks itself from what the Bridge sees; hide it any time).
- Automatic fallback is a switch on Sources > Providers instead of a config edit: `PATCH /v1/sources/settings`
  `{ "autoFallback": true|false }` is saved in `sources/state.json`, wins over `sources.autoFallback`, is audited
  (`sources.setting_changed`), and `GET /v1/sources` meta says where the value comes from (`autoFallbackSource`).
- `GET /v1/pooling` accounts carry a `label`, and the Providers page shows it instead of the id.
- The dashboard says "Reconnecting to the Bridge..." when the Bridge restarts and redraws by itself when it is back; a
  revoked or expired key returns to the sign-in screen with a message. An account that is not logged in shows "Log in
  needed" on Sources instead of "Backing off".
- Quote batches are per consumer, so a light reader no longer waits in a heavy reader's place in the queue. Two keys
  asking for different symbols in the same moment make two broker calls instead of one.
- Fixes in the sources wiring: the built-in providers now register in a normal start, plugins named in
  `sources.plugins` are loaded (and stopped with the Bridge), the router's choice is honoured by the sources service,
  source health shows the outcome of real calls, and a plugin's own health appears in `GET /v1/sources`. `health.nextTryAt`
  is always ISO text and `health.lastError` plain text.
- Pooling needs your consent: it stays off until you accept a versioned notice (`GET`, `PUT` and `DELETE /v1/pooling`).
- Security hardening of the data-source subsystem, after an independent review:
  - Plugins: the child process may read only its entry file (not its folder), and a plugin folder that holds any symbolic
    link is refused, so a pinned plugin cannot reach the Bridge's data folder through a link. `plugins check` realpath-checks
    its fixtures and runs under the same flags as the host; the CLI and docs now say the order is read, `pin`, then `check`,
    because `check` runs the plugin's code. A plugin can still signal the Bridge (Node's permission flags do not cover
    signals): this is now stated plainly in `plugins pin`, the log and the docs, and the new optional
    `sources.pluginUser: { uid, gid }` starts plugins as another user when the Bridge runs as root. Plugin processes are
    killed when the Bridge exits, refused-fetch log lines are summarised to one per 10 s, wildcard hosts over public
    suffixes and shared hosting (`*.co.uk`, `*.herokuapp.com`) and the remaining in-tree broker hosts are refused, and the
    read's `purpose` now reaches the source so a plugin's own refusal of order, risk, paper and alert reads fires.
  - Prices: orders, price bands, market protection and paper fills read with an explicit `order` or `paper` purpose and
    refuse any value labelled stale, delayed, end-of-day, unofficial, from a source or unlabelled. A test fails when internal
    code makes a market-data call without a purpose. The compat API and the `/xl` spreadsheet routes never use backup
    sources (a dead `backup` config key is gone; `?backup=true` on `/xl` is refused); a stale compat quote says `stale: true`.
  - Pooling consent: a key limited to some accounts now only adds or removes its own accounts in the shared record.
  - Quotas: floors (0.01 a second, 1 a day, burst and weight at least 1), and the only active admin key cannot be given a
    quota that could lock it out.
  - Built-in providers: bodies are streamed with a 2 MB cap, impossible prices and timestamps more than 5 minutes ahead are
    refused, keys are scrubbed in URL-encoded and base64 forms, and the Alpha Vantage test needs the documented shape.
  - Opt-in sources need a fresh acknowledgement after more than 24 hours off or a new notice; an enabled opt-in source with no
    matching acknowledgement is treated as off and logged at start.
  - CLI: `sources set-key` rejects a key typed after the id, and `--key` on the command line prints a warning.
  - Tests: the global `fetch` is guarded in the test run, so no test can reach a real host.
- `GET /v1/sources` rows carry `health.lastErrorKind` (`none`, `auth`, `rate-limit`, `not-found`, `hard`) so a refused key or a
  vendor limit is not shown as working, and the response `meta` carries `autoFallback`. The Sources page says when a free
  source on will actually be asked, switches show their new state at once, and the dashboard's counted words, motion, touch
  targets and sheets were tidied across pages.
- Removed what v2 does not serve, so the public project matches the routes that exist (each item was checked against
  the registered routes or for a reader before it was deleted):
  - API spec: 17 unused tags (Alerts, Triggers, Watchlists, Journal, Strategies, Book, Events, Scanner, Notifications,
    Backup data, Reference data, Volatility, Options desk, Participant OI, Options data, Studies, Analytics), 84 unused
    schemas, parameters and responses, the error codes `ALERT_LIMIT`, `COMPUTE_LIMIT`, `COMPUTE_TIMEOUT`,
    `CAPACITY_EXCEEDED` and `AUTOMATION_NOT_ALLOWED`, the chain-leg fields `oiChangeBasis` and `oiChangeSince`, and the key
    `purpose` field. Operations now carry `x-module` (the module that registers them) instead of `x-stream`.
  - SDKs: the backup and scanner methods of the Node SDK (`backupQuotes`, `scan`, `saveScan`, ...) and the Python SDK
    (`backup_quotes`, `scan`, `save_scan`, ...); they called routes that answer 404. The Python strategy runner stays (you run it yourself); `oi_walls.py` now works
    out its open-interest walls from the option chain instead of calling a route that does not exist.
  - Streams: the WebSocket ops `subscribe_scans`, `unsubscribe_scans`, `subscribe_events` and `unsubscribe_events`, the SSE
    switches `scans=1` and `events=1`, the `scan` and `market_event` messages, and the always-empty `jobs` list of the
    `budget` message. Nothing ever sent them.
  - Settings: `stream.candles` and the MCP toolset `options` (no reader, no tools), and the old top-level sections
    `alerts`, `triggers`, `watchlists`, `journal`, `strategies`, `scanner`, `analytics`, `studies`, `vol`, `recorder`,
    `reference`, `participants`, `notify` and `backup`. A config file that still has one is refused with a friendly
    message naming it ("this setting was removed in v2"), not a crash. `readiness` status no longer says that no
    notification target listens (there are none).
  - Internal: the service contracts `participants`, `vol` and `recorder`, the build-stream tags in modules, contracts and
    docs, unused event-bus topics, and the unused dashboard page names of the request log.

## 2.0.0

Initial public release: a local service that connects your Indian broker accounts to one REST + WebSocket API.

- 41 broker adapters on one tested contract, with several accounts per broker.
- Accounts, encrypted credential storage, API keys with scopes, and rate-limit-aware routing (per-account token buckets, priority queue, coalescing, batching, freshness cache).
- Symbols and instruments, market data (LTP, quotes, depth, history, expiries, option chain) and a live stream over WebSocket and SSE.
- Orders and portfolio with idempotency keys, paper trading, and safety gates (kill switch, daily limits, order-rate cap, audit log, trading readiness).
- Inbound webhooks (signed generic, ChartInk, GoCharting), MCP tools for AI assistants, and a compat API at `/api/v1`.
- Python and Node SDKs, spreadsheet and AmiBroker integrations, and a minimal dashboard (Accounts, API, Orders, Safety).

API changes that need a migration window are recorded in [docs/CHANGELOG.md](docs/CHANGELOG.md).
