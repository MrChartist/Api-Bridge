# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Live events

- **Live events engine (server).** Detects 33 price, gap, volume, circuit (only buyers / only sellers / unlocked),
  level, pivot, swing, F&O OI and option events (strike OI surge and build-up, premium spike, IV spike and crush,
  walls, PCR, max pain, straddle, basis, unusual volume) on stream ticks across F&O stocks, indices and your watchlist,
  with repeats counted inside a cool-down, a day store, `GET /v1/events*` routes, the `subscribe_events` stream op
  and a lively demo feed. Guide: `docs/guides/live-events.md`. The dashboard page follows.

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
  charcoal canvases, bottom sheets on phones, and a Spotlight-style search. The house fonts follow the Mr. Chartist
  type system (`docs/theme/TYPE-SYSTEM.md`): Chartist Sans for headings, Chartist Sans Flex for text and numbers,
  Chartist Serif for the one accent word, all self-hosted under the SIL Open Font License with no slashed zero; numbers print without grouping commas, with fixed decimals and `--` for
  missing values. Checked at 320 to 2560 px in light and dark with no horizontal overflow.
- **Buttons follow the Mr Chartist button system** (`docs/theme/BUTTON-SYSTEM.md`): pure black or white with an iOS
  glass finish, only Buy and Sell in colour (gain green, loss red), capsules by default, a focus ring inside the shape,
  a press that settles and springs back, connected bars with one line per seam, and a 44 px touch area that keeps dense
  toolbars dense. Price changes are plain coloured text, never a filled pill.
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

- **Trading readiness** (`readiness` config, `GET /v1/readiness`, `POST /v1/readiness/check`,
  `GET /v1/readiness/history`): every live-enabled account is checked at 09:00 IST on trading days and every 4
  minutes in market hours (broker session and stated expiry, a cheap read call, this computer's IP against
  `live.registeredIp` / the new `live.backupIp` through an opt-in lookup, order and daily-limit headroom, kill switch).
  A badge on every dashboard page (a bottom sheet on phones), a "Trading readiness" card on the Safety page with recent
  changes and, in the demo, simulation buttons. New notify event `trading.readiness` (on by default; never carries an
  IP). `get_safety_status` includes it. `mc-bridge doctor` warns about a live account without `live.registeredIp` and
  about notify targets that do not listen to `trading.readiness`. New guide: [deployment.md](docs/guides/deployment.md).
- **Behaviour change:** a live webhook order is refused with `CANNOT_TRADE` while its account cannot trade (no broker
  call is made); orders a person sends get a `READINESS` warning instead. Escape hatches: `readiness.gateAutomated:
  false` or `readiness.enabled: false`.
- Writes from a browser that says `Sec-Fetch-Site: cross-site` (or `same-site`) without an allowlisted Origin are
  refused (`ORIGIN_NOT_ALLOWED`).
- **Option chains recorded on this computer, with the browser closed** (stream S17, `docs/guides/recorder.md`). The
  Bridge records the configured index chains every minute in session (opted-in stocks every 5 minutes) from one data
  account: live feed first, REST only inside half of every broker window, never more than 200 ms of delay to your own
  requests. Gaps are written as gaps. Read it with `GET /v1/options/snapshots` (JSON or CSV), `/snapshots/latest`,
  `/v1/options/daily` (PCR, max pain, largest OI, ΔOI, futures basis and rollover) and the MCP tool
  `get_option_snapshots`. **On upgrade the recorder starts for indices by default** and may hold up to 60 % of the
  feed's subscriptions; opt out with `"recorder": { "enabled": false }`.
- **Data recorder page** (`#/recorder`, Overview): state, feeding account, today's snapshots and disk use; coverage per
  chain with its gap list; the recorder's share of the feed and REST budget; settings with a live "this account can
  carry …" verdict (a request the account cannot carry is refused with what fits, and nothing is saved); which
  brokers can record what.
- **OI Analysis windows read from the recorder.** When the recorder records the chain on screen, the 5m, 15m, 30m,
  1h and Since open windows use its minutes ("Recorded by the Bridge every minute", with its coverage and gaps), and
  the page's own browser snapshots become a cache of them.

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
