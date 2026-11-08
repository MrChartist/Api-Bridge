# Changelog

## Unreleased

- Data sources and plugins: optional free sources and owner-approved plugins next to your broker accounts, each answer
  labelled with its data class (`realtime`, `delayed`, `eod`), delay, `official` flag and confidence; `/v1/sources`, a
  routing trace, pooling consent, per-key quotas, `limits?explain=1` and a `purpose` read parameter. Plugins run in their
  own process with a brokered, allow-listed network and a hash pin, and never see credentials or order code. New:
  `mc-bridge sources ...`, [docs/guides/sources.md](docs/guides/sources.md), [docs/source-contract.md](docs/source-contract.md)
  and `examples/source-plugin/`.

## 2.0.0

Initial public release: a local service that connects your Indian broker accounts to one REST + WebSocket API.

- 41 broker adapters on one tested contract, with several accounts per broker.
- Accounts, encrypted credential storage, API keys with scopes, and rate-limit-aware routing (per-account token buckets, priority queue, coalescing, batching, freshness cache).
- Symbols and instruments, market data (LTP, quotes, depth, history, expiries, option chain) and a live stream over WebSocket and SSE.
- Orders and portfolio with idempotency keys, paper trading, and safety gates (kill switch, daily limits, order-rate cap, audit log, trading readiness).
- Inbound webhooks (signed generic, ChartInk, GoCharting), MCP tools for AI assistants, and a compat API at `/api/v1`.
- Python and Node SDKs, spreadsheet and AmiBroker integrations, and a minimal dashboard (Accounts, API, Orders, Safety).

API changes that need a migration window are recorded in [docs/CHANGELOG.md](docs/CHANGELOG.md).
