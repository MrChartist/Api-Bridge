# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-24

First public release, under the MIT License.

### Added

- One local API (REST and WebSocket streaming) for 41 Indian brokers, with several accounts per broker. Dhan is verified with a live account; the other brokers are beta.
- Option chains with broker or locally computed Greeks, quotes, market depth, history, instrument search, holdings, positions, funds and order books.
- Paper trading engine for every broker; live orders for Dhan (verified), Zerodha and Upstox (beta), behind several separate opt-ins.
- Safety: paper by default, scoped and account-limited API keys, HMAC request signing, a kill switch, market-hours checks and an audit log.
- Rate-limit-aware routing using each broker's documented limits.
- Alert webhooks for Chartink, GoCharting and generic HMAC-signed sources.
- Integrations: Excel (Power Query), Google Sheets, AmiBroker, and AI assistants through MCP, with a confirmation step for AI-prepared orders.
- Node.js and Python SDKs.
- Dashboard with a first-run checklist, test console and demo mode, plus the `mc-bridge` CLI (`init`, `start`, `doctor`, `keys`, `accounts`, `kill`) and Docker support.
- Broker credentials encrypted at rest on your own machine.

[Unreleased]: https://github.com/MrChartist/api-bridge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/MrChartist/api-bridge/releases/tag/v0.1.0
