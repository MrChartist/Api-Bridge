# Changelog

## Unreleased

- Data sources and plugins: optional free sources and owner-approved plugins next to your broker accounts, each answer
  labelled with its data class (`realtime`, `delayed`, `eod`), delay, `official` flag and confidence; `/v1/sources`, a
  routing trace, pooling consent, per-key quotas, `limits?explain=1` and a `purpose` read parameter. Plugins run in their
  own process with a brokered, allow-listed network and a hash pin, and never see credentials or order code. New:
  `mc-bridge sources ...`, [docs/guides/sources.md](docs/guides/sources.md), [docs/source-contract.md](docs/source-contract.md)
  and `examples/source-plugin/`.
- Sources page in the dashboard (Overview, Providers, Quotas) replaces API > Rate limits. Recent requests show what
  answered each market read: `GET /v1/requests` entries carry `route` (`from`, `source`, `sourceName`, `class`,
  `delaySec`).
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

## 2.0.0

Initial public release: a local service that connects your Indian broker accounts to one REST + WebSocket API.

- 41 broker adapters on one tested contract, with several accounts per broker.
- Accounts, encrypted credential storage, API keys with scopes, and rate-limit-aware routing (per-account token buckets, priority queue, coalescing, batching, freshness cache).
- Symbols and instruments, market data (LTP, quotes, depth, history, expiries, option chain) and a live stream over WebSocket and SSE.
- Orders and portfolio with idempotency keys, paper trading, and safety gates (kill switch, daily limits, order-rate cap, audit log, trading readiness).
- Inbound webhooks (signed generic, ChartInk, GoCharting), MCP tools for AI assistants, and a compat API at `/api/v1`.
- Python and Node SDKs, spreadsheet and AmiBroker integrations, and a minimal dashboard (Accounts, API, Orders, Safety).

API changes that need a migration window are recorded in [docs/CHANGELOG.md](docs/CHANGELOG.md).
