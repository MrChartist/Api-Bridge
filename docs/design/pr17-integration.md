# PR 17 integration: one of each feature

PR 17 ("Options analytics API and terminal dashboard", branch `claude/optionsdesk-api-bridge-iqzi0k`) was built on
`master` while this branch (`claude/happy-carson-2a6o3y`) grew its own options desk. Both sides built some of the same
things. This file records, feature by feature, which version is kept, why, and what moved from the other one.

Rules followed:

- One implementation and one UI per feature. A PR 17 route that overlaps ours keeps working as an **alias** of ours
  (same data, PR 17's request and response shape), and each alias is covered by a test.
- Everything PR 17's dropped screens showed that ours did not (a column, a metric, a filter) is **ported** into ours;
  the ports are listed in the last section.
- PR 17's unique analytics stay, as routes and as pages in this branch's shell and design.

## 1. Decisions

| Feature | Kept | Why | Merged from the other side | Alias |
|---|---|---|---|---|
| Market alert rules (PCR, max pain distance, gamma regime, ATM IV, basis, spot cross, unusual count, tide sentiment, IV rank, FII streak, volume spike) | **Ours** (`server/bridge/alerts/`, the bell), with PR 17's engine inside it | One alert system: the bell already holds position alerts, the inbox and notify. PR 17's 11 metrics had no home there | PR 17's metric engine (`analytics/alertRules.mjs`: metrics through marketData, edge trigger, schedule) now runs under the alerts module; its fires land in the bell's inbox (`alertService.record`). Scheduled checks read at background priority | `/v1/analytics/alert-rules[/{id}[/check]]` = `/v1/alerts/market[...]` |
| Watchlists | **Ours** (`/v1/watchlists`, Screeners › Watchlists) | Ours feed Live events and Home, carry OI change and front ATM IV | Quote rows now carry open, day high, day low, previous close and volume (PR 17's columns) | `/v1/analytics/watchlists[...]` (PR 17's array shape, `add`/`remove` updates, read scope kept) |
| Participant OI | **Ours** (`server/bridge/participants/`, OI Analysis › Participants) | One NSE fetcher with a store, back-fill, sync and demo history; PR 17 fetched the same file a second time | PR 17's product groups and sentiment read are computed from our store | `/v1/analytics/participants` (PR 17's shape, read from our store, no NSE request of its own) |
| Ctrl K palette | **Ours** (`palette.js`, trade intents) | Ours is the app's one palette and already places trades by typing | PR 17's `[symbol] [code]` command line, `help <code>` and `g` key navigation (see the page redesign commits) | – |
| Terminal chrome (`chrome.js`: collapsible groups, context bar, market chip, density toggle, auto-refresh) | **Ours** (sidebar, top bar, density setting, live control) | It duplicated our shell | The context bar idea becomes the Analytics pages' top-bar capsule; CSV export and saved layouts stay as shared helpers | – |
| What-if, scenario grid and margin | **Ours** (`whatif-core.js`, `span-margin.js`, Positions' scenario matrix) in the UI | Ours prices hedged margin; PR 17's what-if reports margin as null | – | `/v1/analytics/risk/whatif` and `/risk/scenario` stay as API routes (no UI duplicate) |
| Book VaR, exposure, concentration, execution costs | **PR 17's** (no page of ours did this) | New: Analytics › Risk | P&L histogram (`distribution`) added to `/risk/var`; positions shown as contracts | – |
| Strategy finder | **PR 17's optimizer** (`/v1/analytics/optimizer`) behind Strategy lab › Finder | It searches every template's strikes and widths and ranks by a chosen objective; the older ranking only tried each template's defaults | Range-bound templates are among the neutral ones | `/v1/analytics/strategies/find` stays as an API route |
| Backtest | **PR 17's** (nothing of ours) | New: Strategy lab › Backtest | – | – |
| Option chain page | **Ours** | Live, stream-first, trading from the chain | – | – |
| OI and PCR page | **Ours** (OI Analysis) | Ours has walls, build-up, max pain, windows | See ports | – |
| Strategy payoff page | **Ours** (Strategy Builder) | Ours prices legs, margin and POP and places | – | – |
| Positions (Greeks, lot split) page | **Ours** (Positions; basket slicing) | Ours shows Greeks per leg and slices by freeze | – | `/v1/analytics/position-greeks`, `/v1/analytics/lot-split` stay as API routes |
| Option screener | **Ours** (Screeners › Options) | Ours scans every underlying and expiry | See ports | `/v1/analytics/screener` stays as an API route |
| Live events vs NSE corporate events | **Both, different things** | Ours is the live tick feed (`/v1/events`); PR 17's `/v1/analytics/events` is NSE's results calendar | – | – |
| Journal | **Ours** | PR 17 dropped its own journal before the merge | – | – |

## 2. PR 17 routes kept as they are

Every other PR 17 route keeps its path and shape: OI, OI change and spurts, GEX, exposure (delta, gamma, vanna,
charm) and OI explorer, skew, surface, Greeks grid, synthetics, straddle, futures and basis, FII/DII, expiry-day digest,
strategies and finder, optimizer, backtest, payoff, Greeks and position-size calculators, lot split, position Greeks,
unusual activity, tide, vol stats and term, contract screener, markets overview, risk (scenario, exposure,
concentration, VaR, what-if, TCA), derivatives depth (forward curve, RR/BF, vol cone, event vol), NSE deals, insiders,
events, announcements, SEBI/RBI notices, central-bank dates, F&O ban list, timeline, `/v1/fields*` and `POST /v1/batch`.

## 3. Fixes made while merging

- `analytics.alert` was not a known bus topic, so a firing PR 17 rule threw after sending its `scan.alert`. It is a
  topic now.
- `/v1/analytics/skew` checks `width` before reading the chain, so a bad request costs no broker call.
- Session times in `workspace.js` and the event time in `derivDepth.mjs` come from the reference store's defaults.
- PR 17's number helpers use the house format (en dash for empty, true minus).
- OI and volume are in units on this Bridge (`market/oiUnits.mjs`); PR 17 multiplied them by the lot size again, so
  exposure, unusual activity, the screener and tide read 65x too large. `unitMultiplier(chain)` is 1 unless a chain
  says `units: "lots"`.
- Futures are monthly. Basis, synthetics, the futures chain, strategies and the optimizer read a weekly option expiry's
  month future (`monthlyExpiries`, `futureExpiryFor`).
- `/risk/*` and `/position-greeks` pinned chain reads to the account whose positions they read; a paper account has no
  market data, so every leg came back unpriced. `pinMarketRead` lets a paper account read through the data accounts.
- The tide records and replays only inside market hours (`reason: "market_closed"` otherwise).
- §10's meter rule `.bar { height: 6px }` also sized SVG `<rect class="bar">`, so every analytics bar chart drew 6 px
  bars; it is `.bar:not(rect)` now.
- Every rule of the analytics CSS sections is scoped under `.an-page` (a test fails on an unscoped one), after PR 17's
  `.leg-row` overrode the Strategy Builder's.

## 4. Ports into our versions

| From PR 17's screen | What | Now in |
|---|---|---|
| Watchlist quotes | Open, day high, day low, previous close, volume | `watchRow` (`dashboard/watchlist-core.js`), `/v1/watchlists/{id}/quotes` |
| Exposure › Straddle | A strangle (±1 to ±5 strikes) beside the ATM straddle | `/v1/analytics/straddle?width=`, Exposure › Straddle |
| Terminal command line | `banknifty oc`, `help gx`, `g` + go-key | `palette.js` (`commandResult`, `paletteCodes` in `views.js`) |
| Alert rules page | The 14 market metrics, a builder with a strike picker | The bell's Market alerts and "New market alert" (`alerts.js`) |

## 5. The menu

Analytics: **Exposure** (By strike, By expiry, OI heatmap, Greeks grid, Straddle), **Flow** (Unusual activity, Market
tide, FII and DII, Filings), **Futures** (Futures chain, Basis history, Synthetics), **Strategy lab** (Finder,
Templates, Calculators, Backtest), **Risk** (VaR and exposure, Execution costs). PR 17 tabs inside our pages: OI
Analysis › OI change, Strike history, Spurts, Expiry day; Volatility › Skew, Surface, Cone, Vol stats.

## 6. Added after the merge (broker gap list)

- Per-strike OI and IV through the session (OI Analysis › Strike history, from `/v1/options/snapshots`).
- Strangle premium through the session (Exposure › Straddle, `width`).
- Probability cone by expiry (Volatility › Cone).
- Alert conditions: `strike_oi_change`, `strike_iv`, `atm_iv_change` (market rules) and `theta_below`, `vega_outside`
  (position rules), all on the existing engines.

## 7. Not done

- PR 17's `chrome.js` and `terminal.js` stay in the tree for their tested helpers (command grammar, layouts, history);
  the terminal chrome itself is not mounted. Saved layouts have no UI here yet.
- Derivatives depth (forward curve, RR/BF, vol cone, event vol) has no page; its routes stay.
- Demo prices are a seeded random walk now; recorded demo snapshots from before the change keep the old levels until
  they age out of the recorder.
