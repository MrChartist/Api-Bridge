# Handoff: where the options desk stands

Written 30 October 2026 for whoever picks this up next, including a Claude session on your own computer. Branch:
`claude/happy-carson-2a6o3y` (draft PR [MrChartist/api-bridge#16](https://github.com/MrChartist/api-bridge/pull/16)).

## 1. Run it

```bash
git fetch origin
git checkout claude/happy-carson-2a6o3y
git pull origin claude/happy-carson-2a6o3y
npm install
npm run dev
```

`npm run dev` starts a demo Bridge (sample prices, no broker needed) and opens the dashboard already signed in through a
one-time link (`/dashboard#signin=<code>`, valid 10 minutes). If the browser does not open, copy the link the command
prints. Each Bridge accepts only its own keys: a key from another machine or an older Bridge home is refused.

- Other port or a clean home: `MCB_PORT=4300 MCB_HOME=./.demo-home npm run dev`.
- A key by hand: `node bin/mc-bridge.mjs keys create --label me --scope admin,paper`.
- Tests: `npx vitest run` (all) and `npm run -s check:mjs`. Each run's temp folders go in one `mcb-test-run-*` folder
  that is removed at the end (`vitest.config.mjs`, `test/tmpdir.mjs`).
- If the demo shows `lot 1` or blank lot sizes, delete `<MCB_HOME>/data/instruments/demo-*.json` and restart. It's a
  stale demo instrument cache.
- Stop the Bridge by its PID or Ctrl+C, never `pkill` by pattern (other Bridges may be running).

## 2. Done and on this branch

| Area | What | Where to read |
|---|---|---|
| Type system | Chartist Sans, Chartist Sans Flex and Chartist Serif, self-hosted. All older fonts removed. Nothing under 12px, nothing heavier than 600, no em dash or slashed zero in visible text. | `docs/theme/TYPE-SYSTEM.md`, `typeSystem.test.mjs` |
| Buttons | The mrchartist.com button system adapted: six intents and ink or glass capsules. Only Buy and Sell are coloured. The focus ring sits inside the button. | `docs/theme/BUTTON-SYSTEM.md` (Dashboard adaptation), `buttonSystem.test.mjs`, `app.css` section 8a |
| UI pass 3 | No decorative strips or one-sided edges; one elevation scale; radius, spacing and z-index tokens. Menu is 13 pages in Trade, Markets and Bridge. Tabbed pages for API (Keys, Integrations, Test console, Rate limits, Activity), Screeners (Options, Arbitrage, Stocks) and OI Analysis (By strike, Participants). Old links redirect. Phone tab bar is Home, Chain, Positions, Orders, More. | `docs/design/ui-pass-3.md`, `polish.test.mjs` |
| Polish | Toasts top-centre on desktop (`placeToast()` moves them clear of what they would cover). Accounts holder column; Screeners phone gap. `DASH` is the en dash. Phone tab strips scroll the tapped tab into view. P&L heroes never split the sign from the number. | `docs/CHANGELOG.md` |
| Dev mode | `npm run dev`; login help and key errors point to it. | `README.md` |
| Phase 1 steps merged | 0 F0, 1 and 7 reference data, 2 and 8 pricing and vol, 3 and 4 recorder, 5 and 6 readiness, 12 stock options server, 14 participants, 25 book. | `docs/spec/README.md` section 4 |

## 3. To do, in order

### 3a. Branches to review and merge (pushed, not on this branch yet)

| Branch | State | Next step |
|---|---|---|
| `p1-integration` | Phase 1 integration branch. It carries the last review fixes for steps 3 and 14 (690108f, 28231e0), which are not on this branch yet. | Merge into `claude/happy-carson-2a6o3y`, run the full suite. |
| `p1/s12-stocks-a` | Step 12 merged; one extra test fix (829f9ee). | Merge. |
| `p1/s25-book` | Step 25 merged; two review fixes (e6cc89b, 9071592: demo NIFTY future, gamma digits, tablet grid, empty state). | Review, merge. |
| `p1/s10-stream-a` | Step 10 (P1-4a server-side chain views over `/v1/stream`); built, not reviewed. | Review against `docs/spec/p1-04-streaming.md` T1–T7, fix, merge. |
| `p1/s06-readiness-b` | Step 6 merged earlier; last commit is unreviewed WIP (readiness.js, app.css, test). | Diff it, keep what helps, run `readiness.test.mjs`. |
| `p1/s13-stocks-b` | Step 13 WIP (P1-6b tasks 9–15). Started: `formatStrike` and `strikeFormat.test.mjs` (T9), `underlyings.js` and the underlying picker wired into chain, positions, vol and screener (T10), `expiry-panel.js` (T13). Not done: T11 warnings by kind and `noLiteralRates`, T12 stock bits in chain, ticket and strategy, T14 screener server sweep and ban filter, T15 docs, e2e and screenshots. | Finish from `docs/spec/p1-06-stocks.md`, full suite, merge. |
| `p1/s21-margin-a` | Step 21 WIP (P1-10a margin checks tasks 1–12). Started: `server/bridge/margin/`, `margin-core.js` and its test, contract and paper engine changes. | Finish from `docs/spec/p1-10-margin-checks.md`, full suite, merge. |

WIP commits were saved as-is when the run was paused, so run the tests before trusting them.

### 3b. Phase 1 steps not started

Build them in this order; each depends on the steps in brackets. Acceptance checks are in `docs/spec/README.md`
section 4.

- 9 pricing P1-3c (8)
- 11 streaming P1-4b (10)
- 15, 16 OI, straddle and charts P1-7a/b (4, 9)
- 17, 18 exposure P1-8a/b (3, 8, 14)
- 19, 20 multi-expiry scenarios P1-9a/b (8, 7)
- 22 margin P1-10b (21)
- 23, 24 alerts P1-11a/b (3, 8)
- 26, 27 guards server, UI and live path P1-12a/b (21, 23, 25)

### 3c. Live events feed (stocks and options)

The goal is a faster, clearer version of the Spider IRIS "Event Selector": a live list of stocks crossing events as
they happen. Events:

- **Bullish:** new high of day, gap up, volume above the previous day.
- **Bearish:** new low of day, gap down, volume below.
- **Misc:** pivot crossovers, upper and lower circuit ("only buyers" / "only sellers"), swings, gap close.

Then the same for options: OI spikes, IV jumps, PCR shifts, straddle breaks, wall moves.

- Speed targets: 100 ms or less from tick to paint at p95; a perf test at 2,000 events per second across 500 symbols.
- An agent built this as stream S28 `events` (`docs/guides/live-events.md`). Check `git log --grep=events` on this
  branch; if it is not there, look for a pushed `events` branch.
- Then: run it in demo, measure tick-to-paint in the browser, and compare against Spider on your machine.

### 3d. Mid-width layout (1024–1399 px)

An agent was fixing these:

- the Accounts table scrolling sideways between 1100 and 1399 px;
- the Strategy hero at about 1100 px;
- the POP sub-line in the hero;
- toast placement below 1024 px;
- a sweep of every page at 1024, 1180, 1280 and 1366 px.

Check what landed (`git log`) and screenshot those widths in light and dark.

### 3e. Check everything by hand

At phone 390, tablet 820, laptop 1280 and desktop 1440, in light and dark, go through every menu page and every tab.
Look for:

- horizontal page scroll;
- clipped or overlapping text;
- signs split from numbers;
- touch targets under 44 px on touch screens;
- toasts covering controls;
- empty chart slots (they stay hidden until a chart engine is connected).

## 4. Known blockers

- **CI:** every GitHub Actions job fails before it starts because of the account's billing or spending limit, not the
  code. Fix the billing in GitHub settings, then re-run. Until then, run `npx vitest run` and `npm run -s check:mjs`
  locally.
- **Live broker paths** need the existing opt-ins and safety gates. Orders default to paper. Never weaken a gate to get
  a test green.

## 5. Spider and DeltaDash notes (from the PAID50 download)

- **The executables:** Spider52 = IRIS 5.3.0.3, Spider60 = 6.3.0.3, Spider70 = GChart 7.3.0.3 (Shekar Arumugam);
  DeltaDash1 2.0.1.3 (Gokyo Analytics LLP).
  - All are unsigned Windows Delphi executables wrapped in a packer.
  - Check their hashes with the vendor before running them. SHA-256 prefixes: Spider52 5432ec3adcfb8e7a, Spider60
    78373166a97aa530, Spider70 a308f5442f5aab9c, DeltaDash 910c06994b2f7f0e.
- **Spider70 screens worth matching or beating:** EVENTSELECTOR, OPTIONCHAINREPORT, DERIVPAYOFF, DELTADASH4,
  TECHNICALQUERY_ALGOSERVER, LIVEDATAHANDLER, REPLAY.
- **Why Spider feels fast:** it's a native desktop app reading a local live-data handler, with no browser round trip.
  Our answer is server-side computation, compact deltas over one WebSocket, and painting in place. The 100 ms target
  above holds us to it.
- Never share Spider licence or password files with anyone, including an AI session.

## 6. House rules (short)

- Dashboard: vanilla JS ES modules, no build step, in `server/bridge/dashboard/`. New files go into `DASHBOARD_FILES`
  in `server/bridge/core/app.mjs` and the list in `format.test.mjs`.
- Numbers become text only in `format.js`. Use the true minus (U+2212); `replaceChildren(null)` prints "null", so
  filter nulls first.
- Content Security Policy is self-only: no CDNs and no inline styles in HTML.
- Maths lives in pure, tested modules. Demo mode must show every feature with realistic data.
- Commits end with the Co-Authored-By and Claude-Session lines used throughout this branch. Never force-push. Merge
  the base instead of rebasing a shared branch.
