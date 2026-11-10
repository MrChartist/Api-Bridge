# Changelog

## Unreleased

- Python and Node clients: `downloads.estimate`, `downloads.settings/set_settings`, `recordings.status/settings/presets/apply_preset`
  and `saved_calls()` / `savedCalls()` (from `GET /v1/limits?explain=1`).
- `GET/PATCH /v1/downloads/settings` and `/v1/recordings/settings`: change the background budget share (0.05 to 0.8) and the
  downloads after-hours switch while the Bridge runs; kept in a small file in the data folder, applied without a restart. The
  scheduler's background share ceiling is now 0.8 (default for other jobs stays 0.5).
- Library of collections ([docs/guides/collections.md](docs/guides/collections.md)): named, tagged lists of instruments and option
  universes (`current-weekly`, `current-monthly`, `all-weekly`, dates; ATM +/- N listed strikes, honest about a stale, delayed or
  last-close price). `GET/POST /v1/collections`, `.../{name}` (rename, tags), `/resolve`, `/estimate`, `/usage`, `/export`,
  `/duplicate`, `POST /v1/collections/import`; `deps.library` for downloads and recordings; `mc-bridge collections`; bus topic
  `collection.changed`; `/xl/quotes?collection=<name>` for Excel and Sheets; config `library`.
- Events out ([docs/guides/events.md](docs/guides/events.md)): `GET /v1/events/stream` (SSE) and `/v1/events/ws` with cursor replay
  that survives a restart, topic and per-key account filters (a read key never sees admin-only topics), `GET /v1/events` as a
  polling twin, and signed webhooks (`/v1/subscriptions`, `mc-bridge subscriptions`) with a durable outbox, backoff retries, a
  dead-letter list, a delivery log and test send. Targets must be https on public addresses (no redirects, checked again at
  every delivery); the secret is write-only. Events are read-only: none carries a secret or an approval token. Receiver
  snippets for Node, Python and the shell are run in the tests. New `download.*` and `recording.*` bus topics.
- Data downloads ([docs/guides/downloads.md](docs/guides/downloads.md)): `POST /v1/downloads` (with `?dryRun=1` for the
  estimate), jobs you can pause, resume and cancel that survive a restart, files with a manifest that names the data class,
  datasets that continue from their last stored bar and report gaps, `GET /v1/instruments/export`, and
  `mc-bridge download ...`. Calls run at the lowest priority within `downloads.maxBudgetShare` of the budget; stored ranges
  are read from disk (`?dataset=` on `/v1/history`, `market.history.localFirst`), and `GET /v1/limits?explain=1` shows `savedCalls`.

- Dashboard Data page (`#/data`): a download wizard with an estimate before start, live progress, recordings with auto-record rules and one-click presets, datasets with Update now, collections with an option-universe builder and live preview, and a Saving API calls card.
- Recorder ([docs/guides/recording.md](docs/guides/recording.md)): saves your own real-time quotes and option chains to files on your computer, by hand or by auto-record rules every trading day (market calendar, ATM window and expiry chosen again each day, restart resume, gaps with reasons, disk and retention limits, background priority inside a share cap, real-time class only). New `/v1/recordings` routes (rules, presets, files), `mc-bridge record ...`, bus topics `recording.started`, `recording.stopped`, `recording.gap`, `recording.disk_low`, config `recorder`. Auto-record is off until you turn it on.
- Developer kit: `mc-bridge init <starter>` (node, python, curl, sheets, webhook-receiver, mcp-client) writes a tested project with the real address and, on request, a least-privilege key in `.env` only; a Developers page in the dashboard (apps, scope finder, live requests by app, error catalogue); `GET /v1/errors`; `docs/guides/developers.md`.
- Developer files generated from `docs/openapi.yaml`: Postman and Bruno collections (`docs/collections/`), one Markdown page
  per endpoint and the error codes (`docs/api/`), `docs/llms.txt`, `docs/llms-full.txt` and a search index. The curl
  examples in them and in the quickstart run in the tests; `npm run docs:generate` rewrites everything and `npm run
  docs:check` (run in CI) fails when a file is out of date. New docs home: `docs/README.md`. Pull requests that change
  `server/`, the OpenAPI file or `sdk/` need a line under Unreleased (`scripts/changelog-check.mjs`).
- TradingView alerts are a first-class source: `POST /v1/hooks` with `"source": "tradingview"` (URL token plus a
  passphrase inside the message, stored hashed; JSON or plain-text alerts in our own schema; chart tickers such as
  `NSE:M_M` and `NSE:NIFTY1!` resolved through the chart mapping; an editable TradingView sender-address preset;
  `maxAgeSec` stale-alert limit; replay and duplicate protection on id + time + symbol + side that survives a restart;
  a derived `clientOrderId`; bursts wait for an order slot instead of being rejected). New `GET /v1/hooks/{hookId}/signals`,
  `POST /v1/hooks/{hookId}/test`, `GET /v1/hooks/presets`, the `hook.rejected` bus event, a TradingView panel in the
  dashboard, and a verified TradingView section in [docs/guides/webhooks.md](docs/guides/webhooks.md). Generic hooks no
  longer swallow a later alert that reuses an `id` with a new `time`.
- Orders for alerts and sheets ([docs/guides/alert-orders.md](docs/guides/alert-orders.md)): `POST /v1/orders/to-target`
  (be long 3 lots: places only the difference, `POSITION_UNKNOWN` and nothing placed when the position cannot be read,
  same gates and idempotency as `POST /v1/orders`), `POST /v1/orders/batch` (up to 20 legs, a result per leg, a key per
  leg), `POST /v1/margin/basket` (broker figure when the adapter has one, else the labelled paper model; the compat
  `margin` call works now) and `GET /v1/calendar/holidays|sessions|status` with the verified flags kept.
- Symbols: `GET /v1/symbols/resolve` (the reason and ranked candidates; `AMBIGUOUS_SYMBOL` instead of a guess),
  `GET`/`POST /v1/symbols/validate`, and automatic resolution now reads `NSE:M_M`, `NSE:BAJAJ_AUTO`, `NSE_INDEX:NIFTY 50`
  and `RELIANCE-EQ`. Native order inputs accept `MIS`, `NRML` and similar words; the canonical value is in `meta.normalised`.
- `mc-bridge expose` lets TradingView alerts or a Google Sheet reach the Bridge through a tunnel or proxy in one step
  (alerts or sheets; Cloudflare, ngrok, Caddy or a plain port forward): it writes the listener, its own host list, the
  caller-address header and an optional TradingView sender allowlist, prints the provider commands and what to paste,
  and `expose check` proves that only the intended routes answer (the optional call to your public address needs
  `--allow-outbound`). Restart the Bridge afterwards. New optional Sheets listener `server.sheetsIngress` (GET `/xl/*`,
  read-only keys, own hosts, request cap). `mc-bridge doctor` gains exposure checks with a fix each and `--strict`;
  `GET /v1/expose` and `POST /v1/expose/check` feed an Expose card in Integrations. Guides: expose-alerts.md, vps.md;
  recipes in `deploy/expose/`.
- Backup and restore: `mc-bridge backup [--out FILE] [--include-secrets]`, `backup list`, `backup verify FILE` and
  `mc-bridge restore FILE [--dry-run]` (checks every checksum first, refuses while a Bridge runs, keeps a safety copy,
  swaps atomically). The master key is never in an archive. A copy of the data is made before a new version first
  starts (`backup.keep`, default 5); an optional daily backup (`backup.schedule`, off by default) reports failures in
  `/v1/health`, doctor and the bus events `backup.completed` and `backup.failed`. `GET` and `POST /v1/backup`
  (admin, this computer only), a Backups card on the Safety page, [docs/guides/backup.md](docs/guides/backup.md).
  The old `backup` config key (data sources, removed in v2) now means this section.
- The one-line installers download a tagged release and check its SHA-256 against the release's `SHA256SUMS.txt`
  before installing; they accept `--version` and `--sha256` (`MCB_VERSION`, `MCB_SHA256` on Windows), and the release
  publishes the source archives, `install.sh`, `install.ps1` and the list. `MCB_REF` is gone.
- Telegram: alerts on your phone and read-only commands (`/price`, `/positions`, `/orders`, `/funds`, `/status`, `/kill`).
  A durable outbox with retries, `retry_after`, pacing, digests and quiet hours; a morning "not logged in" reminder on
  trading days; the bot token and chat ids are typed on this computer only and kept encrypted. New: `notify` config section
  (no longer on the removed list), `/v1/notify/*`, `mc-bridge notify ...`, a Telegram card under Integrations, events
  `ticket.prepared` and `hook.rejected` / `hook.stale` / `hook.failed`, `docs/guides/telegram.md` and `notifications.md`.
  Order approval is never possible from Telegram, and `mc-bridge doctor` reports delivery truthfully.
- Python library 0.2 (`sdk/python`, still standard library only): `Bridge()` finds the URL and key by itself, typed frozen
  records with freshness labels (`require_realtime()`), a typed error tree with fix hints, paper-first `bridge.orders`
  (idempotent, reconciles an unknown outcome instead of retrying, `wait_for_fill`, `to_target`, `batch`), `bridge.tickets`
  (watch only), reconnecting sync and asyncio streams, `AsyncBridge`, pandas and CSV helpers, retry and batching that honour
  `Retry-After`, provisional alert helpers. `BridgeClient` is unchanged. See [docs/guides/python.md](docs/guides/python.md).
- Python library 0.3 and Node client 0.2: `bridge.downloads` (create, wait, save with SHA-256 check, read), `datasets`,
  `recordings` (+ auto-record `rules`), `collections` (option universes, resolve), `subscriptions`, `events.subscribe`
  (reconnects, resumes from a cursor, reports gaps), `subscriptions` with dead-letter calls, `verify_signature` / `verifySignature` (X-Bridge-Signature), and `history_all` / `historyAll` with
  `local_first`. Python adds records and optional Parquet (only when `pyarrow` is installed); both stay dependency-free.
- Spreadsheets: `GET /xl/quotes` gives a whole sheet of prices in one request (`csv`, `tsv` or `json`, one row per symbol,
  a bad symbol is a blank row with an `error`), every row labelled with `as_of`, `age_s`, `class`, `source`, `stale`
  (and `DEMO` in demo mode). New read-only tables `/xl/positions`, `/xl/holdings`, `/xl/funds`, `/xl/orders` and
  `/xl/instrument` (lot, tick, freeze). `?cache=1` opts in to `max-age` and an `ETag`; refused requests answer a
  one-row table with "Too many refreshes: wait N seconds". Single-value routes refuse delayed or end-of-day prices.
- Excel workbook rebuilt: formulas stored with the `_xlfn.` prefix (no more `#NAME?`), a filled watchlist, Positions,
  Holdings, Funds and Orders sheets, one request per sheet, a Status line, and no key in a visible cell. Google Sheets
  Apps Script now has a menu, `BRIDGE_QUOTES` and a timed refresh. Integrations > Excel and Sheets in the dashboard
  makes the key, the workbook and the script, and has a "Test it" button. Guide rewritten.
- Broker safety and verification: every adapter now runs order-safety cases on recorded replies (no order id, garbled reply,
  lost reply, documented refusal, stop-loss and cancel-variety mapping, session-ended reply); gaps show as `needs fixture`
  in the generated tables of docs/BROKERS.md. Fixes found: an order reply without an id can no longer come back as placed
  (and is an unknown outcome, not a validation failure, for Arrow, Definedge, Nubra, Paytm and both HDFC adapters); mStock
  cancels a stop-loss order with its own variety; session-ended wording is tagged so the account shows login needed.
- Broker verification ladder (`beta`, `contract`, `sandbox`, `live-verified`) in `server/brokers/verification.json`;
  `GET /v1/brokers` carries `verification` and `singleSession`; the broker catalogue badge and counts come from it. How to
  verify a broker: docs/broker-verification.md.
- Streams: a feed silent during market hours is rebuilt (`stream.staleRebuildAfterMs`), and one that never connects
  (`stream.connectTimeoutMs`); `rebuilds` in the stream stats.
- Morning login: a guided sheet on the Accounts page for every account that needs a login, and the event
  `account.login_needed` at `morningLogin.remindAt` (default 08:45 IST on trading days).
- Declining a pending confirmation is real now: `POST /v1/tickets/{ticketId}/reject` (admin, this computer only, optional
  `{ "reason" }` up to 200 characters) removes the ticket for good, so it can never be confirmed later; a ticket that
  was confirmed, used or has expired answers 409 with its `state`. It is audited as `ticket.rejected`, announced on the
  event bus, and the last ones stay listed for 15 minutes in `GET /v1/tickets?state=rejected`. The dashboard's Decline
  button uses it (an optional reason, the card goes at once and returns if the Bridge refuses, a "Recently declined"
  list). AI assistants get the MCP tool `check_order_ticket` (`status: "rejected"` with the reason) and
  `submit_confirmed_order` refuses a declined ticket plainly; a webhook signal waiting on it ends as `rejected`.
- Faster dashboard: its files are sent compressed (Brotli or gzip, chosen from `Accept-Encoding`, each file compressed once
  per change, a separate ETag per encoding), the modules the app needs load in parallel instead of one import level at a
  time, the sign-in screen is drawn before the app code has loaded, the live connection and API budget chip start after
  the first page is drawn, and the broker list is kept for a minute (and shown from memory for half an hour while it is
  fetched again behind it).
- Easier dashboard for people who are not developers ([docs/guides/connect.md](docs/guides/connect.md)):
  - **Connect a tool** (`#/connect`): choose Excel or Sheets, an AI assistant, a Python or Node script, your own app or
    AmiBroker; the dashboard makes a key with only the access that tool needs (read only unless you switch on practice
    orders; never live), fills this Bridge's address and the key into the setup to copy, and **Test it** makes a real
    read call with the new key and says in plain words whether it worked.
  - **Simple and Advanced view**: a new browser starts in Simple (Accounts, Connect a tool, Sources, Orders, Safety; Sources
    opens on the provider cards with one sentence about where prices come from). Advanced adds API, Overview and Quotas.
    One setting in the account menu and the search palette; nothing is removed and every page still opens by link.
  - **Something wrong?** and **Stop** in the toolbar of every page; a failed request offers one fix button (log in again,
    open Keys, see why it is slow, log in to your broker).
  - A glossary: a **?** button after the first use of each technical word on a page opens a one-sentence meaning.
  - **Send a practice order** is a short form (stock, buy or sell, quantity) instead of editing JSON in the test console.
  - The Claude setup on API > Integrations made a read-only key, which cannot prepare orders for you to approve; Connect a
    tool asks, and makes a paper key when you say yes.
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
