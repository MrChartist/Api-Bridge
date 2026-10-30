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

Built: Markets › Screeners › Live events (`#/screeners/events`). Guide: `docs/guides/live-events.md`, server in `server/bridge/events/`.

- 37 event kinds:
  - day high/low, gaps and gap fill
  - volume surges
  - only buyers / only sellers (circuit lock and unlock)
  - previous-day, pivot, 52-week and all-time levels
  - swings
  - F&O OI build-up
  - option OI, IV, premium, walls, PCR, max pain, straddle, basis, unusual volume
  - spot crossing a strike
- One alert per move: all-time high > 52-week high > previous-day high > day high. Lower ones are folded into the top row.
- Live custom conditions in plain text (up to 50), fired on the false-to-true edge.
- Measured speed:
  - engine: p95 0.014 ms per tick;
  - tick to screen: p95 61–110 ms across three runs on a busy machine. The target is 100 ms or less; check it with `node scripts/events-paint.mjs`, or `?debug=1` on the page.

Left to do:
- MCP tool `get_market_events`.
- Option volume measured against average days. It needs per-strike volume history; today the check is volume / OI.
- A desk order ticket in the side sheet. It uses the strategy placement sheet today.
- Test the live broker path (`events/feed.mjs`); only demo was run end to end.
- In demo, a stream-only client starts nothing until something reads `/v1/events*`.
- Run the full test suite on a quiet machine. Three tests (fno/routes, vol/agreement, hooks/routes) failed once each under load and passed alone.

### 3d. Mid-width layout (1024–1399 px)

Done (d367b28):
- the Accounts table fits from 1024 to 1440 px, with the row actions moving into a ⋯ menu when space is short;
- the Strategy hero reflows (5, then 3 over 2, then 2 per row); the POP line wraps instead of being cut;
- the desk toolbar shows status dots only at 1024–1279 px, so spot and % change stay visible.

Done (polish pass 4, 30 Oct). Checked every page and tab (Home, Option Chain with ticket and Customise, Strategy
with legs, Positions, Orders, Safety, OI By strike and Participants, Volatility, Screeners Options, Arbitrage, Live
events and Stocks, Market calendar, Accounts, API Keys, Integrations, Test console, Rate limits and Activity, Data
recorder) at 1024, 1100, 1180, 1280 and 1366 px in dark and light, and at 390 and 820 px (touch). Light theme at 1440
and 390 px with a contrast probe. Playwright sweep and probes: `scratchpad/polish4/sweep.cjs`, `contrast.cjs`.

- **Toasts at every width** (`app.js placeToast`): the toast never covers the control just used (pointer, key or
  input in the last 4 s) or more controls than the other place. Below 1024 px: bottom centre above the tab bar and any
  sticky bar, else top centre under the toolbar (`[data-place="top"]`); 1024 px and up: top centre, else bottom right.
  Strategy's target-date slider and chips now keep the toast off them. `ui-pass-3.md` §4 updated.
- **Strategy 1024 to 1100:** with the rail sidebar the analysis column is now about 510 to 600 px, so the decision
  was to keep two columns: the Greek tiles go two by two in a build column under 540 px (subs no longer cut), the hero
  goes three over two below 680 px, and the payoff hint moves above the plot beside the spot pill when no corner is
  clear (left out when nothing is clear, as on phones).
- **Reference chip:** says only its first fact ("Lot 65") where the whole line does not fit; on phones it gives way
  last so the expiry is never cut to "3". **Broker names** wrap on Accounts.
- **Desk toolbar:** every desk page fits its capsule (OI, Volatility, Arbitrage, Positions too); at 1024 to 1279 the
  live control is its dot in every state (stale too). Phones: the bar shows the page glyph; Participants and Data
  recorder capsules fit.
- **Positions:** the table refits when it widens after a draw (Distance and Exit were cut at 1024); ±σ chips two by
  two in a narrow capital column (they overlapped); the scenario grid fits its figures ("−₹3…" before).
- **OI ladder** change and % fit a 32 px compact row; **Volatility** tiles wrap between parts; **Live events** Count
  column fits; **Customise** caption 12 px; phones: the move / maximise pill no longer sits on card titles.
- **Home on phones:** cockpit first (indices as one sideways row, P&L today, positions, events), then Get started,
  which is one row once a step is done (opens on a tap, all widths). Positions on phones drop Delta, Expiry and Watch
  columns and show expiry and warnings under the book; card head links reach 44 px on touch.
- **Light theme:** bid / ask, CE / PE IV, expiry chip days, journal days and ±σ keys at full ink on white (tokens
  `--ink-soft`, `--soft-op`); stale rows and cards dim to 0.86 in light (were 0.55, 2.4:1); weekend heads in the
  calendar at the quiet ink; event chips on a lighter tint.
- **Reference data unavailable** banner shows once per browser tab; the chip keeps its red "Defaults".
- `?` after Ctrl K on Home: checked (Escape, click outside, the sidebar Search button): it opens the shortcuts.
- **Demo seed:** a demo paper book whose legs are not whole lots of the current lot (seeded at 75 before NIFTY's 65)
  is reset and seeded again on start; the journal's demo history takes its sizes from the demo lot table.

Left:
- Market calendar: fixed 30 Oct (evening): month cells show the holiday's short name on two lines ("Gandhi
  Jayanti") with the full name as the cell's tooltip (`docs/design/ux-audit.md`, QA pass, follow-up).
- Phone page subtitles stay on one line with an ellipsis (a deliberate one-height header).
- The contrast probe counts a segmented control's selected label as failing (its thumb is a separate element): read
  those by eye.
- Live events search placeholder is cut at 1024 ("Search symbol or ev").

### 3d2. UX and space passes (done 30 Oct)

- **Space** (`docs/design/ui-pass-3.md` §12):
  - full-width pages, a flush sidebar with an icon rail, and a Compact / Comfortable / Auto density setting;
  - more columns and rows on wide screens (chain at 1920: 24 rows × 21 columns, was 21 × 17).
- **UX** (`docs/design/ux-audit.md`), 37 issues found, 30 fixed:
  - add a broker in demo, and in normal mode with no restart;
  - API keys with inline errors and ready-to-paste setups;
  - error toasts no longer show a green tick;
  - Home checklist;
  - the ticket shows max loss, breakeven and margin;
  - Orders get Modify and Cancel;
  - paper fund reset;
  - an Excel formula per contract.
- **Trading pass (30 Oct, `docs/design/ux-audit.md` "Trading pass"):**
  - paper margin that credits hedges, one model (`span-margin.js`) for the paper engine, ticket, Strategy and
    Positions; `docs/guides/paper-margin.md`;
  - right-click, long-press or T on a strike builds a strategy around it in the Strategy Builder;
  - position alerts (`server/bridge/alerts/`, the bell, Positions › Alert), notify only;
  - ticket charges with max loss and breakeven after charges;
  - Undo for a cancelled paper order and for a paper reset;
  - demo paper accounts start with ₹25 lakh;
  - Home cockpit; API › Keys side by side from 1700 px.
- **Trader tools (30 Oct, evening, `docs/design/ux-audit.md` "Trader tools"):** shared what-if (Positions and Strategy), roll sheet, basket orders (margin first, freeze slicing, buys first, Cancel remaining), trade journal with daily P&L snapshots, expiry desk, watchlists, Explain this on OI and Volatility, Ctrl K trading, Accounts today and the Excel workbook.
- **Still open:** the proposals in the audit's "Trading pass" and "Trader tools" sections.

### 3d3. Second build day (30 Oct, afternoon)

What landed, each with tests. Details are in `docs/design/ux-audit.md` ("Trading pass", "Trader tools", "QA pass (30 Oct)", "Safety pass") and `docs/perf/baseline.md`.

- **Paper margin:** a portfolio margin that credits hedges (`dashboard/span-margin.js`, `docs/guides/paper-margin.md`). One model is shared by the engine, ticket, Strategy and Positions.
- **Option Chain:**
  - build around a strike (right-click, long-press, T);
  - ticket charges and after-charges figures;
  - Excel formula per contract.
- **Positions:**
  - shared what-if (also on Strategy);
  - roll a leg or group;
  - alerts (`server/bridge/alerts/`, notify only);
  - expiry desk.
- **Basket orders:** margin first, slicing at min(freeze, per-order lots, per-order value), buys first, cancel remaining. Exits use the same slicer.
- **Orders and journal:** Orders › Journal with tags, notes, setup, P&L calendar and stats; the paper engine takes daily snapshots.
- **Scanners:**
  - number scans, plain-word builder, 34-scan library, saved and scheduled scans; hits go to Live events;
  - option-screener quick scans;
  - daily-bar pre-warm.
- **Watchlists:** front-expiry ATM IV, OI change; they feed Live events and Home.
- **Market pages:** "Explain this" on OI and Vol.
- **Ctrl K trading:** "buy 2 nifty 26300 ce", "sell nifty straddle 3 nov".
- **Home and Accounts:** Home cockpit; Accounts Today column and Excel workbook (.xlsx with WEBSERVICE formulas).
- **Speed** (3 rounds):
  - shared fetch layer, one WebSocket, stream-first chains, positions on the stream;
  - per-cell chain patches split across frames, compositor-only animations;
  - API budget indicator and Rate limits chart; events REST guaranteed share on strict brokers.
  - Chain tick-to-cell p95 is about 100 ms (it was 1,842 ms); busiest scenario 4–5 broker calls/min (was 32).
- **Safety:** a modify now passes every per-order check (lots, value, band, freeze, kill switch).
- **First run:** Home shows the demo seed's progress; the seed is about twice as fast.

**Open decision for the user:** should orders the Bridge verifies as reduce-only be exempt from `dailyMaxLoss` and the daily order count? The proposal is `safety.reduceOnlyExempt`, default off and audited; see the "Safety pass" section. Nothing has changed until the user decides.

**Known left:**
- rare 650–930 ms chain tick outliers;
- OI lower panels rebuild every 2 s;
- Excel workbook only on Accounts;
- live broker paths (journal fills, basket sends, events fallback) checked by code and tests, not end to end with a real broker.

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

## PR 17 analytics integration (claude/happy-carson-2a6o3y)

PR 17's analytics are merged and drawn in this shell: see `docs/design/pr17-integration.md` for the one-of-each
decisions, the aliases, the fixes and what is not done. Pages: Analytics › Exposure, Flow, Futures, Strategy lab, Risk;
tabs in OI Analysis (OI change, Strike history, Spurts, Expiry day) and Volatility (Skew, Surface, Cone, Forward, RR and BF, Event vol, Vol stats).
Host: `dashboard/analytics.js` (VIEWS, capsule, `fitDesk`, masonry). Page code: `analyticsViews.js`,
`analyticsMore.js`, `analyticsFlow.js`, `analyticsRisk.js`, `analyticsTime.js`. CSS: app.css sections 15, 16, 17 and
15d, all under `.an-page` (tested). Demo prices are a seeded random walk (`demo/demoAdapter.mjs` `walkAt`).
