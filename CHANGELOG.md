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

## 2.0.0

Initial public release: a local service that connects your Indian broker accounts to one REST + WebSocket API.

- 41 broker adapters on one tested contract, with several accounts per broker.
- Accounts, encrypted credential storage, API keys with scopes, and rate-limit-aware routing (per-account token buckets, priority queue, coalescing, batching, freshness cache).
- Symbols and instruments, market data (LTP, quotes, depth, history, expiries, option chain) and a live stream over WebSocket and SSE.
- Orders and portfolio with idempotency keys, paper trading, and safety gates (kill switch, daily limits, order-rate cap, audit log, trading readiness).
- Inbound webhooks (signed generic, ChartInk, GoCharting), MCP tools for AI assistants, and a compat API at `/api/v1`.
- Python and Node SDKs, spreadsheet and AmiBroker integrations, and a minimal dashboard (Accounts, API, Orders, Safety).

API changes that need a migration window are recorded in [docs/CHANGELOG.md](docs/CHANGELOG.md).
