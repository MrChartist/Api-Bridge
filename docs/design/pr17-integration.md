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
| What-if and margin | **Ours** (`whatif-core.js`, `span-margin.js`) in the UI | Ours prices hedged margin; PR 17's what-if reports margin as null | – | `/v1/analytics/risk/whatif` stays as an API route (no UI duplicate) |
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

## 4. Ports into our versions

| From PR 17's screen | What | Now in |
|---|---|---|
| Watchlist quotes | Open, day high, day low, previous close, volume | `watchRow` (`dashboard/watchlist-core.js`), `/v1/watchlists/{id}/quotes` |
