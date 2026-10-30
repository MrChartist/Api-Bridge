# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Options analytics and terminal dashboard

- **Read-only options analytics API** under `/v1/analytics/...`: OI and PCR, max pain, OI change and spurts, gamma, delta,
  vanna and charm exposure, IV skew, surface and term structure, Greeks grid, synthetics, straddle, futures chain and
  basis, expiry-day digest, strategy templates, finder and optimizer, payoff, Greeks and position-size calculators,
  lot-split plans, position Greeks, a condition-based backtest, participant OI, FII/DII flows, unusual options activity,
  market tide, vol stats with IV rank, a contract screener, markets overview (indices, movers, sectors, breadth,
  rotation, correlation), risk scenarios, VaR and what-if, watchlists, and alert rules on 11 metrics. Nothing in it
  places an order. See `docs/guides/analytics.md`.
- **Field access** (`/v1/fields`, `/v1/fields/history`, `/v1/fields/bulk`, `/v1/fields/search`, `POST /v1/batch`): a
  Bloomberg-style field catalogue with snapshot, history and bulk reads and CSV output.
- **NSE, SEBI and RBI public data** (deals, insiders, events, announcements, regulatory wire, F&O ban list): best effort,
  personal use, endpoints unverified without network access, with stale-serve and clear `UPSTREAM_ERROR` messages.
- **Dashboard terminal shell:** an Analytics page group, a shared underlying, expiry and strikes context bar, a
  `[symbol] [code]` command line with `HELP`, `g` key navigation, history, saved layouts, auto-refresh with backoff, an
  IST market-status chip, compact density, and CSV export on every table.
- **Roadmap:** a Bloomberg-inspired terminal plan in `ROADMAP.md`.

### Easy install

- **One-line installers, no Node.js needed.** `irm …/install.ps1 | iex` (Windows) and `curl -fsSL …/install.sh | sh`
  (macOS, Linux): no admin password; Node.js 22 is used if present, otherwise a private copy is downloaded from
  nodejs.org and checked against its SHA-256. They set up paper trading, add a **Mr Chartist Bridge** app or shortcut
  (Start menu and Desktop; Spotlight and Launchpad; applications menu) and an `mc-bridge` command, then open the
  dashboard. Running them again upgrades in place; both can uninstall.
- **Windows Setup.exe.** `Mr-Chartist-Bridge-Setup-<version>.exe` installs with a double-click (no admin, Node.js
  inside), adds Start-menu and Desktop shortcuts with the Bridge icon and an entry under Settings > Apps, and is then
  the app itself. Built on Linux as a Node.js single executable application (`scripts/release/build-exe.mjs`) and
  tested on real Windows by the Release workflow before publishing.
- **Ready-to-run downloads.** Each release has one ZIP per system (Windows x64, macOS arm64/x64, Linux x64/arm64) with
  the Bridge, its parts and Node.js inside: unzip and double-click, even offline. Built and smoke-tested by the new
  Release workflow.
- **Double-click launchers with no questions**: `start-windows.bat`, `start-mac.command` and the new `start-linux.sh`
  fetch Node.js if needed and set up paper trading without asking anything.
- **Signed in automatically.** `mc-bridge start --open` and the new `mc-bridge open` open the dashboard with a
  one-time sign-in link (single use, 10 minutes, this computer only), so nobody copies an admin key. Starting again
  while it runs just reopens the dashboard.
- **Add a broker and log in from the dashboard**: an Add a broker sheet and a Log in form per broker
  (`POST`/`DELETE /v1/accounts`); no config file, terminal or restart.
- **Dashboard redesigned in the IPO Decode design system** (Liquid Glass): a floating glass sidebar on wide
  screens and a floating tab bar with a More sheet on phones and tablets, a glass toolbar with an IST clock, calm
  grouped cards with tinted icon tiles, large-title page headers and numbered section eyebrows, warm paper and warm
  charcoal canvases, bottom sheets on phones, and a Spotlight-style search. The house fonts (Plus Jakarta Sans,
  Inter, DM Serif Display) are self-hosted; numbers print without grouping commas, with fixed decimals and `--` for
  missing values. Checked at 320 to 2560 px in light and dark with no horizontal overflow.
- **Android**: the one-line installer works in Termux (Node.js from Termux's own packages, a Termux:Widget shortcut,
  a wake lock while running, links opened with termux-open-url).
- **Broker logos** on the Accounts page, the Add a broker list and the account tables: each broker's own site icon,
  shipped with the Bridge (no outside requests) and served as `/dashboard/broker-<id>.png`; initials when a logo is missing.
- Hints name the command that works in your setup (`mc-bridge …`, `npm run bridge -- …` or `docker compose exec …`).
- App icons for Windows, macOS and Linux; CI runs the installers on real Windows (PowerShell 5.1) and macOS.
- Beginner guide: [docs/guides/install.md](docs/guides/install.md).

### Changed

- **Node.js 22 or newer is now required** (Node 20 reached end of life in April 2026). CI runs Node 22 and 24.
  The Node SDK in `sdk/node` still works on Node 20.
- Dev tools: Vitest 5, TypeScript 7, @types/node 22; MCP SDK 1.32.2; GitHub Actions updated.
- `mc-bridge kill` and `kill release` need no `--key` on the computer running the Bridge: they use an owner-only
  control token the Bridge keeps in its data folder while it runs, accepted only on the kill-switch routes and only
  from this computer.
- An account-limited admin key now lists, revokes and deletes only the keys and hooks of its own accounts; others
  answer 404, like unknown ids.
- Docker: base images pinned by digest (Dependabot keeps them current), `docker-compose.yml` runs read-only with no
  capabilities, and the first start asks you to rotate the admin key it printed into the log.
- Demo mode: "account not found" errors name the demo accounts (`demo-paper`, `demo`).
- Docs: the AI confirmation step does not protect against an agent with shell or browser control (MCP guide,
  SECURITY.md).

### Added

- **Spread the work over your own accounts.** Many-symbol quote reads are split in each broker's batch size to the
  pooled account with the most spare budget. `marketData.poolingWhenTermsUnknown` lets you pool your own
  same-holder accounts at brokers whose terms are not confirmed; a "not-allowed" policy always wins.
- **Backup data** from Yahoo Finance and the NSE website (`backup` config, off unless enabled): quotes, candles,
  expiries and NSE option chains when no broker account can answer, always labelled `source: "backup"` with the
  provider and its own timestamp, never used for orders, paper fills or safety checks. `/v1/backup/*` routes.
- **Scanner** (`/v1/scanner/*`, dashboard page, `scan_market` MCP tool, SDK methods): a safe condition language
  (SMA, EMA, RSI, MACD, ATR, Bollinger, Supertrend, VWAP, `crosses above`, `x[k]` ...), FNO / NIFTY50 / custom
  universes, background priority, one worker pool per pooled account, saved scans every N minutes with alerts on
  the WebSocket (`subscribe_scans`) and SSE (`scans=1`).
- **Compat REST API and WebSocket** (`/api/v1/*`, `/api/v1/ws`): 30 endpoints in the common apikey-in-body style,
  analyzer (paper) mode by default.
- **Notifications** (`notify` config): saved-scan alerts, live fills, kill switch and expired sessions to Telegram,
  Discord, Slack or a signed webhook; secrets from environment variables only.
- `mc-bridge doctor` reports whether backup data is on.
- **macOS-style dashboard**: translucent sidebar, unified toolbar, System Settings cards, Finder tables, sheets and
  notification banners in light and dark, with Motion animations (reduced-motion aware), a Spotlight-style command
  palette (⌘K), ⌘1–⌘9 page shortcuts and a shortcuts sheet (?), plus accessibility fixes.
- **Public demo kit** for a Hostinger VPS (`deploy/hostinger`: Docker + Caddy HTTPS, demo mode only) and
  `server.remoteDashboard`, which the config accepts only in demo mode.
- Demo mode now covers every NIFTY 50 stock, so a demo scan runs over a whole universe.
- `scripts/capture-screenshots.mjs` regenerates every README and docs screenshot (63, new design) from a throwaway
  demo Bridge with Playwright.

### Fixed

- `/xl` reads from an account-limited key without `account=` now stay inside that key's accounts.
- Broker adapter tests no longer fail once the option expiries in their recorded fixtures pass.
- CI also runs on pushes to `master`.
- Demo instruments whose symbol contains `-` or `&` (BAJAJ-AUTO, M&M) no longer fail to price.
- Two key-redaction tests could fail at random when a key's secret contained `_`.

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
