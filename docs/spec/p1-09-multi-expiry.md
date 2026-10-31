# Spec P1-9: Multi-expiry builder, P&L heatmap, price slices, σ bands and settlement estimate (B2, B3, B4, A7, A16)

Status: ready to build once P1-3 has landed · Owner: tech lead, Options desk · Date: 29 Oct 2026 · Stream: **S22 (new) "Strategy analysis"** (final id from the stream table in `docs/spec/README.md`) · BRD: `docs/brd/options-platform.md` §3.A (A7, A16), §3.B (B2, B3, B4), §5.1–5.5 (S1 fallback, S9 logging, vol engine), §6.1 (P1-9 acceptance criteria), §7.1–7.9, §8, §10.1

> **Naming, read first.** "Store S1/S5/S9" means the BRD's stores (chain snapshots, reference data, prediction log). "Stream S5/S6/…" means the build streams in `docs/STREAMS.md`. `pricing.js`, the vol-time clock, the parity forward and the single IV function are **P1-3's** (`docs/spec/p1-03-pricing-vol.md` §2, §6). This spec never re-defines them; it calls them.

> **Not legal or market advice.** The exchange settlement method, the window length, the index closing-price method and every external number are marked **needs verification** and listed in §9.3. Nothing so marked becomes a blocking rule in code.

> **Styling.** Another team is restyling the dashboard (near-black theme, colour tokens, motion). This spec names panels, classes, states and interactions, and uses only shared tokens and existing helpers (`segmented`, `sheetPopover`, `emptyState`, `alertBox`, `chartSlot`, `freshnessPill`, `desk-stat`). It specifies no colours, sizes or motion beyond "uses token X".

> **Coordination with `docs/design/strategy.md` (restyle round 2).** That design spec lists multi-expiry legs (§5.1, MUST #10) and the price × date Grid (§5.2, MUST #12). **Ownership split:** P1-9 owns the data model (drafts per underlying, per-leg expiry, extra-expiry pricing), the maths (`scenario.js`), the server, the Grid and Slices *content and behaviour*. The restyle owns look and motion. Where the BRD acceptance criteria and the design spec differ, the BRD wins and the design team is told (§6.9): the Grid has 25 rows × up to 20 date columns (not 13 × 8) and is offered on phone with inner scroll (BRD §7.3); the design's "Greeks" tab becomes **Slices** (a superset: editable rows with P&L, Δ, Γ, Θ, ν).

> **Build order and shared foundations.** This spec is steps 19–20 (P1-9a server and engine tasks 1–8, P1-9b builder UI tasks 9–14) in `docs/spec/README.md`, after P1-3b, P1-2b (P1-8a soft). It uses, and does not rebuild, the F0 foundations listed there: final stream ids, bus topics and error codes pre-registered in core, the opt-in `options` MCP toolset (every MCP tool in this spec goes there), `demo/routes.mjs` plus the OpenAPI demo-only list, `server/lib/jsonl.mjs` (append, torn-line tolerance, last-wins, quarantine of corrupt files), `ratelimit/backgroundGate.mjs` (the one ≤ 50 % background-budget check), `core/ownership.mjs`, and `dashboard/copyRules.mjs` (the one banned-word list). Where this text and README disagree, README's build order and shared-module owners win.

---

## 1. Summary

Today the builder is single-expiry: drafts are keyed `underlying|expiry`, every leg is priced from the one toolbar chain, `options.js` values later legs only if the caller fills `l.years`, the futures basis decays linearly, the scenario table is nine fixed % or σ levels, bands come from calendar ACT/365 time, the chain shows a 1σ band but no market-implied "expected absolute move", and nothing knows that index options settle on an average.

P1-9 delivers:

| Item | This round | Honest limit |
|---|---|---|
| B2 Multi-expiry builder | Legs in any listed expiry (max 4 distinct) plus futures of any listed month; calendar, diagonal, double calendar, double diagonal presets; valuation at the first expiry with Black-76 at each later leg's own IV (sticky strike, shown); carry from each expiry's own parity forward | Sticky strike only (sticky delta and per-expiry IV shifts are B5, P2). After the first expiry the P&L is path dependent: the grid assumes "price at the row level at each expiry it passes" and says so |
| B3 P&L heatmap | 25 price rows (±2σ) × ≤ 20 date columns (now → last expiry; hourly on expiry days), on the P1-3 vol-time clock; ₹ or % of max risk; sign always shown; click sets target date and spot | Column count is capped (20); the thinning rule is deterministic and printed in the method note. "To the minute on expiry day" (B3 text) is hourly + the settlement instant this round |
| B4 Price slices | Editable rows (%, ₹, σ, breakevens, walls) with P&L, Δ, Γ, Θ, ν at the target date | Walls come from P1-8 levels when present, else from chain OI ("largest OI", labelled) |
| A7 σ bands + expected absolute move | σ bands F·e^{±kσ√T} (k = 1, 2) on the clock, and the straddle-based EAM, drawn and labelled separately on the payoff and the chain; `GET /v1/options/expected-move` | EAM uses the interpolated ATM straddle mid; with a one-sided ATM it falls back to the model value √(2/π)σF√T, labelled "model" |
| A16 Settlement estimate | On index expiry days from the window start (15:00 by default) a running time-weighted average of index ticks, with the remaining-minutes weight and a ±band; the expiry payoff is evaluated at it; every day's final estimate is compared with the published close and logged | We do not receive the constituent prices the exchange averages; we average **index ticks**. Accuracy is measured, not assumed (§7.11). The AC fixture of *real* recorded ticks cannot be produced in this session: the capture tooling ships now, the real-fixture test is skipped until one real expiry day is recorded (§2.3) |
| K6 logging (carried from P1-3) | Builder POP is computed by the shared `scenario.js` and logged to store S9 through the server (`/v1/strategy/analyze` with `log: true`) once a minute per strategy | POP stays "uncalibrated" until the P2 calibration job has ≥ 60 expiries |
| API parity (§7.8) | `POST /v1/strategy/analyze`, `GET /v1/options/settlement-estimate`, `.../accuracy`, `GET /v1/options/expected-move`; MCP read tools | Compat/Sheets path next round (as P1-3) |

---

## 2. Scope

### 2.1 MUST (this round)

| # | Item | AC |
|---|---|---|
| M1 | **Shared pure engine** `server/bridge/dashboard/scenario.js` (imports only `./pricing.js`): expiry contexts, leg valuation at any instant, stats (multi-expiry aware), payoff curves, grid rows/columns/cells, slices with Greeks, σ bands and EAM, multi-expiry preset legs. Used by the builder, the server and the tests | 1, 2, 3, 4, 6 |
| M2 | **Drafts per underlying** (`st.baskets[underlying]`), per-leg expiry pill, extra-expiry pricing from batched quotes (one chain fetch per newly used expiry for strikes and symbols), max 4 distinct expiries | 1 |
| M3 | **Presets**: Long call calendar, Long put calendar, Call diagonal, Put diagonal, Double calendar, Double diagonal (group Neutral/Volatile, `multiExpiry: true`) | 1 |
| M4 | **Payoff**: the "expiry" curve becomes "At first expiry (date)"; target curve on each leg's own remaining time; σ bands at the curve horizon; EAM range; settlement marker on expiry day | 1, 4, 5 |
| M5 | **P&L table tabs** `[By spot | Grid | Slices]`: Grid = heatmap (§6.4), Slices = editable price slices (§6.5). By spot stays as the design spec defines it | 2, 3 |
| M6 | **Chain page**: EAM row markers and the Expected-move tile shows σ band and EAM as two labelled lines; settlement item on expiry day | 4, 5 |
| M7 | **Module `strategy`** (`server/bridge/strategy/`, stream S22): routes, `analyze` service, settlement service (`deps.settlement`), config section `strategy`, storage under `dataDir/strategy/` | 5, K6, §7.8 |
| M8 | **Settlement estimate**: stream-first index tick capture on expiry days, REST-poll and recorder fallbacks, running estimate + band, final estimate at window end, published close fetch, accuracy log, bus topic `settlement.update` | 5 |
| M9 | **API**: 4 routes (§4), OpenAPI additions, MCP tools `analyze_strategy`, `get_settlement_estimate` (read) | §7.8 |
| M10 | **K6**: S9 rows for builder POP and settlement bands via `vol.logPredictions` | K6 |
| M11 | **Demo**: calendars/diagonals on demo NIFTY, SENSEX, BANKNIFTY; a deterministic settlement replay for any demo expiry day (`at` honoured in demo); a demo "published" settlement; seeded accuracy log | all, demo |
| M12 | **Performance test**: 10 legs × 25 × 20 grid recompute ≤ 30 ms (measured) | 6 |
| M13 | Positions page: one line "At settlement estimate" on expiry day for legs expiring today | 5 |

### 2.2 LATER (named so nobody builds it now)

| Item | Why later | Goes with |
|---|---|---|
| Sticky-delta / sticky-moneyness IV model, per-expiry IV shift, skew tilt | B5 | P2 |
| Probability cone and distribution overlay on the grid | B6 | P2 |
| Grid "to the minute" on expiry day, custom column dates | Hourly + settlement instant meet the AC; minute columns need a column editor | P2 |
| Strategy optimizer and suggestions across expiries | B7, needs P1-10 margin | P2 |
| Broker basket margin as the "% of risk" basis for unlimited-risk structures | P1-10 (G2) | P1-10 |
| Load live positions + hypothetical legs into the grid | B9 | P2 |
| Stock-option settlement estimate (closing price = 30-min VWAP of the stock) | Needs stock tick capture budget (P1-6 sweeps) and verification of the stock method | P2 |
| Pushing `settlement.update` over `/v1/stream` (AsyncAPI change) | The page polls a local route (0 broker calls); P1-11 alerts read the bus | P1-11 / next round |
| Shareable multi-expiry links | B13 | P2 |
| Compat/Sheets parity for the new routes | §7.8; MCP ships now | Next round |
| `GET /v1/strategy/presets` | Presets are client data; no AC needs a route | P2 with B7 |

### 2.3 What our data cannot do (and the honest fallback)

| Gap | Why | Fallback this round |
|---|---|---|
| **Exact settlement price** | NSE/BSE compute the closing index value from constituent prices over the last 30 minutes (method and weighting **need verification**). A broker feed gives index ticks (each already an index value), at uneven intervals, sometimes coalesced. | Time-weighted average of index ticks on a 1-second last-value grid. The response carries `method`, `quality` and the measured accuracy (`accuracy.p95AbsPct` over recorded days). The method note says "estimate from index values received by this Bridge; the exchange computes the official price from constituent prices". |
| **AC: "a fixture of recorded index ticks reproduces the published settlement price within the PRD tolerance"** | No real expiry-day tick recording exists in the repo, and this session cannot make one (it needs a broker feed during 15:00–15:30 IST on an expiry day). | Ship (a) the capture (`dataDir/strategy/settlement/…`), (b) `scripts/settlement-fixture.mjs` that turns a captured day plus its published close into `server/bridge/strategy/__fixtures__/settlement/real/<UNDERLYING>-<date>.json`, (c) the test `settlementFixture.test.mjs`, which runs every real fixture present and is `skipIf(none)`. The AC is **open** until the owner (or any user who opts in to share a fixture) records one NIFTY and one SENSEX expiry day. Demo fixtures prove the code path. Proposed tolerance **0.02 % of the published price** (≈ 5 pts NIFTY, ≈ 16 pts SENSEX), **needs verification**: if the first three real days show a larger p95 error, the tolerance in the PRD becomes that p95 and the band shown to users widens by it. |
| **Published settlement source** | The official final settlement price lives in exchange files. | After window end + 5 min, fetch the index daily candle close (`marketData.history`, `1d`) as `published`, `source: "broker-daily-close"`; when P1-3's bhavcopy parsers exist and archive consent is on, the UDiFF `UndrlygPric`/settlement field replaces it next morning (`source: "nse-bhavcopy"`, field meaning **needs verification**). |
| **No stream** (broker without a feed, or the feed is down) | — | REST poll of the index quote every `pollMs` (5 s) at background priority; `quality: "poll-5s"`, band widened by the sampling error (§7.10). Else store S1 `_und` minute lines (P1-1) if present: `quality: "recorder-1m"`. Else `available: false, reason: "NO_TICKS"`. |
| **Bridge restarted inside the window** | Missed seconds are unobserved. | Ticks already captured are re-read from the day file; the missing seconds are LOCF-filled only up to 10 s, beyond that they count as **unobserved** and enter the band like future minutes (§7.10); `gaps` listed. |
| **Path dependence after the first expiry** | A calendar's front leg settles at S(T1); later columns depend on S(T1) and S(t). | Grid columns after T1 use the assumption "the price is at the row level at every expiry it passes" (`assumption: "held-level"`), printed in the method note and as the column header tooltip. |
| **Back-month IV at T1** | We cannot know future IV. | Sticky strike: each leg keeps its current IV at its strike (plus the what-if IV shift). Shown in the model line: "Later legs valued with Black-76 at today's IV for their strike (sticky strike)". |
| **Extra-expiry chains on rate-limited brokers** | Dhan's chain endpoint is 1 per 3 s (unverified); the open page already uses it. | Extra expiries cost **one** chain call when the expiry is first used (strikes and symbols, cached 10 min), then their leg and parity-strike symbols ride the page's existing quotes call (or the stream, P1-4). §8. |
| **Max loss / POP of a multi-expiry structure** | Not piecewise linear. | Sampled (≥ 400 points over ±6σ plus strikes), bisection-refined breakevens, POP by Simpson integration on the forward measure; every figure flagged `approx: true` ("sampled"). |
| **"% of max risk" for unlimited-risk structures** | Max risk is unbounded. | Basis falls back to the margin estimate (`O.marginEstimate`; broker margin after P1-10), labelled "% of margin (risk unlimited)". |

### 2.4 Dependencies

| Spec | Hard / soft | What P1-9 uses |
|---|---|---|
| **P1-3** pricing core | **Hard** | `pricing.js` (Black-76, Greeks, IV solver, parity forward, `atmIvAt`, clock `volYearsAt`/`clockUnits`), `vol-context.js` (client clock context), `vol.logPredictions` (new contract method, §3.2), `vol.clock.settlementWindowMinutes` |
| **P1-2** reference data | **Hard** (P1-3 needs it) | `reference.session()`, `reference.calendar()` (holidays for columns), expiry calendar, `reference.rate()` |
| P1-4 streaming | Soft | Extra-expiry leg symbols subscribe through the stream client when present (0 REST); settlement ticks use `streamHub` (exists today) |
| P1-1 recorder | Soft | Store S1 `_und` lines as the last settlement fallback |
| P1-8 levels | Soft | Slice rows "Call wall"/"Put wall" from `/v1/options/levels`; otherwise chain OI walls |
| P1-10 margin | Soft | Later: broker margin as the risk basis |
| P1-6 stocks | Soft | Multi-expiry works for stock underlyings through the same paths (monthly only); settlement estimate is index-only |

---

## 3. Architecture

### 3.1 Module map

New, `server/bridge/strategy/` (stream S22):

| File | Purpose |
|---|---|
| `module.mjs` | `defineModule({ name: "strategy", stream: "S22", configKey: "strategy", services: { settlement }, register, start, stop })`, `ROUTES`, `USED_SERVICES = ["marketData", "streamHub", "reference", "vol", "scheduler", "symbols", "recorder?"]` (recorder optional) |
| `config.mjs` | `STRATEGY_CONFIG_SCHEMA` (zod, `.strict()`), `parseStrategyConfig` |
| `market.mjs` | Pure: `(chains, quotes, futures, ctx) → MarketSnapshot` (§3.3) via `pricing.js` |
| `analyzeService.mjs` | `createAnalyzer(deps)`: validates legs, assembles the market (chains per expiry, `maxAgeMs`, user priority), calls `scenario.analyze`, attaches the settlement estimate, logs predictions (rate-limited) |
| `settlement.mjs` | Pure: `secondGrid(ticks, window)`, `runningEstimate(grid, now, spot, sigma, ctx)`, `finalEstimate`, `accuracyRow` (§7.10, §7.11) |
| `settlementService.mjs` | `createSettlementService(deps)`: scheduler, hub client `settlement:<UNDERLYING>`, poll fallback, recorder fallback, day files, published fetch, bus events, `estimate()`, `accuracy()`, `status()` |
| `settlementStore.mjs` | Append-only tick files, day summaries, accuracy log, retention, corrupt-line tolerance |
| `demoSettlement.mjs` | Demo-only: deterministic replay of any demo expiry day from `spotAt`, demo "published" price, seeding the accuracy log (§5) |
| `routes.mjs` | Handlers |
| `fake.mjs` | In-memory `settlement` service for other streams' tests (P1-11, P1-12) |
| `__fixtures__/settlement/demo/*.json`, `__fixtures__/settlement/real/` (empty + README), `__fixtures__/market/*.json` | Fixtures |

New, dashboard (each added to `DASHBOARD_FILES` in `core/app.mjs`):

| File | Purpose |
|---|---|
| `scenario.js` | **The** strategy engine. Pure, no DOM, no fetch; imports only `./pricing.js`. Header: "Shared with server/bridge/strategy. Callers pass the market snapshot and the clock context." |
| `strategy-grid.js` | Grid tab: renders a `GridModel` (table with sticky price column, sticky header, cell click), keyboard navigation, CSV, text alternative |
| `strategy-slices.js` | Slices tab: row editor (add/remove/edit/reorder), table, CSV, persistence in `strategyConfig.slices` |
| `expiry-pricing.js` | Client data layer for extra expiries: strike/symbol cache per expiry, the symbol list merged into desk's quotes call (or stream), building `ExpiryContext`s through `scenario.expiryContext` |
| `settlement-view.js` | Shared settlement pill/line + popover (chain top line, builder hero, positions), polling `/v1/options/settlement-estimate` only on expiry days inside [start − 5 min, end + 10 min] |

Changed:

| File | Change |
|---|---|
| `core/contracts.mjs` | **Core change (lead):** `settlement` contract (§3.2). (`vol.logPredictions` is already in P1-3's contract.) |
| `core/builtinModules.mjs` | Add `strategy` after `vol` |
| `core/eventBus.mjs` | Topic `settlement.update` (§4.6) |
| `core/app.mjs` | Five `DASHBOARD_FILES` entries |
| `vol/predictions.mjs` (P1-3) | Uses the existing `logPredictions(rows)` (defined in P1-3 §2.2); adds the builder metrics to its open `metric` list |
| `demo/demoAdapter.mjs` | Export `demoSettlement(symbol, date, windowMin)` and `spotSeconds(symbol, fromMs, toMs)` helpers (no price change) |
| `mcp/tools.mjs` | `analyze_strategy`, `get_settlement_estimate` |
| `dashboard/strategy.js` | Drafts per underlying (+ migration), leg expiry pill and menu, calendar presets, `scenario.js` instead of `payoffModel`/`strategyStats`/`valueAt` for the builder, table tabs, settlement hero line, prediction logging call |
| `dashboard/payoff.js` | Draw EAM range, settlement marker and band; legend entries (classes only) |
| `dashboard/desk.js` | Quotes call carries extra-expiry symbols from `expiry-pricing.js`; chain Expected-move tile two lines; EAM row markers (`tags.eam`); settlement pill in the top line on expiry day |
| `dashboard/positions.js` | Expiry-day line "At settlement estimate" (§6.7) |
| `dashboard/options.js` | `PRESETS` gains the 6 multi-expiry entries (`multiExpiry: true`); `presetLegs` delegates those ids to `scenario.multiExpiryPresetLegs`; `normaliseSaved` keeps per-leg expiry (already does via `migrateLegs`); `STRATEGY_DEFAULTS` gains `table: "spot"`, `gridUnit: "rupee"`, `slices` |
| `docs/openapi.yaml`, `docs/ARCHITECTURE.md`, `docs/STREAMS.md`, `bridge.config.example.json`, `CHANGELOG.md`, `docs/guides/strategy.md` (new section "Calendars, grid, slices, settlement") | §4.7, §11 |

`USED_SERVICES` excludes `orders`, `paper`, `safety`; a test asserts no file in `strategy/` imports from those folders (scanner pattern). Nothing in this module can place an order.

### 3.2 Service contracts (core change: the lead lands it)

```js
// core/contracts.mjs
settlement: {
  iface: "SettlementService",
  stream: "S22",
  requires: ["marketData", "streamHub", "reference", "scheduler"],
  methods: ["estimate", "accuracy", "status"],
},
// vol (P1-3) already has: methods: [..., "logPredictions"]
```

| Method | Returns |
|---|---|
| `settlement.estimate({ underlying, date?, at? })` | `SettlementEstimate` (§4.3); `at` honoured in demo only |
| `settlement.accuracy({ underlying?, from?, to? })` | `{ items: AccuracyRow[], summary: { n, meanAbsPct, p95AbsPct, maxAbsPct } }` |
| `settlement.status()` | `{ enabled, today: [{ underlying, expiryDay, state, source, ticks, gaps }], disk }` |
| `vol.logPredictions(rows)` | `{ ids: string[] }`; rows in the S9 shape (P1-3 §2.3) |

The analyzer is not a contract service (only this module's routes and the MCP tool call it); `strategyFor(deps)` exposes it to `mcp/tools.mjs` like `scannerFor`.

Dependency order: `… → reference → marketData → vol → strategy`. `strategy` reads `deps.recorder` only if present and not a stub.

### 3.3 Data model

**Leg** (client draft, API request; additive to today's v2 leg):
```json
{ "id": "l1", "kind": "OPT", "underlying": "NIFTY", "expiry": "2026-11-03", "strike": 25150, "right": "CE",
  "side": "SELL", "lots": 1, "lotSize": 65, "on": true,
  "entry": null, "ivOverride": null }
```
`kind: "FUT"` legs have `strike: null, right: null` and their own `expiry`. `entry` = per-unit entry price (held or user override; null = use the live mark). `ivOverride` in vol points.

**ExpiryContext** (one per distinct expiry, built by `scenario.expiryContext`, server or client):
```json
{ "expiry": "2026-11-17", "settleAt": "2026-11-17T15:30:00+05:30", "units": 14.56133, "T": 0.0541414, "Tcal": 0.0526826,
  "forward": 25201.46, "forwardSource": "parity", "carry": 0.0610755, "df": 0.996581,
  "atmIv": 12.60, "straddle": 418.2, "asOf": "2026-10-29T10:00:00+05:30", "source": "chain" }
```
`source`: `chain` (the toolbar chain), `quotes` (extra expiry from batched quotes), `stream`, `supplied` (API caller), `carried` (no two-sided parity strikes: forward = spot·e^{c₀·Tcal} with c₀ from the nearest expiry that has one; flag `FORWARD_CARRIED`).

**MarketSnapshot** (input to `scenario.analyze`):
```json
{ "underlying": "NIFTY", "spot": 25120.5, "at": "2026-10-29T10:00:00+05:30", "rate": 0.065,
  "expiries": { "2026-11-03": { "...ExpiryContext" }, "2026-11-17": { "..." } },
  "marks": { "NFO:NIFTY26N0325150CE": { "bid": 149.4, "ask": 150.4, "ltp": 150.0, "iv": 12.03, "ts": "…" } },
  "futures": { "2026-11-24": { "price": 25262.0, "carry": 0.0605 } },
  "clock": { "version": "vt1", "mode": "weighted", "...": "P1-3 context" } }
```

**Analysis** (output of `scenario.analyze`, returned by the route; §4.2 shows it in full): `legs` (priced), `expiries`, `firstExpiry`, `lastExpiry`, `stats`, `payoff`, `grid`, `slices`, `bands`, `warnings`, `model`.

**Settlement tick line** (`dataDir/strategy/settlement/<UNDERLYING>/<YYYY-MM-DD>.ndjson`, one JSON per tick, append-only):
```json
{ "t": 1793874612345, "x": 1793874612000, "p": 25131.35, "s": "stream" }
```
`t` = receivedAt (ms), `x` = exchangeTs when the feed sends one (else omitted), `p` = index value, `s` = `stream` | `poll` | `recorder`. Only ticks in [windowStart − 5 min, windowEnd + 1 min] are written.

**Day summary** (`…/<YYYY-MM-DD>.json`, written atomically at window end and again when published arrives):
```json
{ "v": 1, "underlying": "NIFTY", "date": "2026-11-03", "exchange": "NSE", "windowStart": "2026-11-03T15:00:00+05:30",
  "windowEnd": "2026-11-03T15:30:00+05:30", "windowMinutes": 30, "method": "time-weighted-index-ticks-1s-locf",
  "quality": "stream", "ticks": 1794, "observedSeconds": 1800, "unobservedSeconds": 0, "gaps": [],
  "estimate": 25130.62, "published": { "value": 25131.05, "source": "broker-daily-close", "at": "2026-11-03T15:37:10+05:30" },
  "error": -0.43, "errorPct": -0.0017, "withinTolerance": true, "tolerancePct": 0.02 }
```

**Accuracy row** (`…/accuracy.jsonl`): `{ underlying, date, quality, estimate, published, publishedSource, error, errorPct, withinTolerance }`; last line per (underlying, date) wins.

### 3.4 Storage on disk

```
dataDir/strategy/                         mode 0700
  settlement/<UNDERLYING>/<YYYY-MM-DD>.ndjson   ticks, expiry days only (~1,800–3,000 lines ≈ 120 KB/day/underlying)
  settlement/<UNDERLYING>/<YYYY-MM-DD>.json     day summary
  settlement/accuracy.jsonl                     one row per (underlying, expiry day)
  state.json                                    last run per underlying, prediction rate-limit signatures (pruned daily)
```
S9 predictions go to `dataDir/vol/predictions/` through `vol.logPredictions` (one store, P1-3's format). Tick files older than `settlement.retentionDays` (400) are deleted at 02:40; summaries and accuracy are kept. A torn last line is skipped and counted (BRD §7.7); a corrupt day file never stops the next day. No secrets, no account ids are written (the tick line has none; the summary names `source`, not the account).

Size: 6 indices, ~1 expiry day per underlying per week ≈ 60 KB × 6 × 52 ≈ 20 MB/year before retention; reported by `status().disk`.

### 3.5 Schedulers

Same pattern as `scanner`/`vol`: one 1-second `setInterval` (unref'd) only while a window is near, otherwise a 60-second tick. Times come from `reference.session(exchange, now)` and the window length from `vol.clock.settlementWindowMinutes.index` (default 30, **needs verification**). No session literal appears in `strategy/`.

| Job | When | What |
|---|---|---|
| `arm` | Minute tick; at start | For each `settlement.underlyings` with today = a listed expiry (from `marketData.expiries` / P1-2 calendar) and the session open: at `windowStart − startBeforeMinutes` (14:55) subscribe hub client `settlement:<U>` to the index symbol (`NSE:NIFTY`, `BSE:SENSEX`, …) in `ltp` mode |
| `capture` | Every tick (bus `tick` filtered by the client's symbols) | Append tick line (buffered, flushed every 1 s with one `appendFile`) |
| `poll` | Every `pollMs` (5 s) inside [start − 5, end + 1] when the hub reports the symbol not live (`isLive` false) or no tick for 10 s | `marketData.ltp([symbol], { priority: "background", maxAgeMs: 2000 })` |
| `emit` | Every 60 s inside the window, plus at window end | Bus `settlement.update`; S9 row for the band (metric `settleBand1`) once at windowStart + 15 min and at windowEnd − 5 min |
| `finalise` | windowEnd + 2 s | Final estimate, day summary, unsubscribe at windowEnd + 1 min |
| `published` | windowEnd + 5 min, retries at +10, +20, +40, +60 min | `marketData.history({ symbol, interval: "1d", from: date, to: date }, { priority: "background" })` close → summary + accuracy row; in demo `demoSettlement()` |
| `retention` | 02:40 | Delete old tick files |

### 3.6 Config (`strategy` section; all optional; zod `.strict()`)

```jsonc
"strategy": {
  "maxLegs": 12,                          // matches O.MAX_LEGS
  "maxExpiries": 4,                       // distinct option/future expiries in one strategy
  "grid": { "rows": 25, "sigmas": 2, "maxColumns": 20, "expiryDayStepMinutes": 60, "minRows": 5, "maxRows": 61 },
  "sampling": { "points": 400, "sigmaSpan": 6 },
  "analyze": { "chainMaxAgeMs": 3000, "timeoutMs": 4000 },
  "predictions": { "enabled": true, "minIntervalSeconds": 60 },
  "settlement": {
    "enabled": true,
    "underlyings": ["NIFTY", "SENSEX", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "BANKEX"],
    "startBeforeMinutes": 5,
    "pollMs": 5000,
    "locfMaxSeconds": 10,
    "tolerancePct": 0.02,                 // needs verification; PRD sets it after 3 real days
    "bandZ": 1.645,                       // 90 % range shown; 1σ also returned
    "retentionDays": 400
  }
}
```
Validation: `grid.rows` odd, in [minRows, maxRows]; `maxColumns` 5–40; `sigmas` 0.5–4; `maxExpiries` 2–6; `pollMs` ≥ 2000; `tolerancePct` 0.001–1. Settlement window length is **not** here: it is `vol.clock.settlementWindowMinutes.index` (one source of truth with the clock).

### 3.7 Analysis pipeline (server and client run the same code)

1. **Validate legs** (≤ `maxLegs`, ≤ `maxExpiries` distinct expiries, one underlying, OPT legs have right/strike, lots ≥ 1).
2. **Market**: server: for each distinct option expiry `marketData.optionChain({ underlying, expiry, strikes: 10, greeks: false }, { priority: "user", maxAgeMs: chainMaxAgeMs })` in parallel (≤ 4), futures via `marketData.quotes`; then `market.mjs` → `MarketSnapshot`. A caller may instead send `market` (pure what-if, no broker calls). Client: the toolbar chain + `expiry-pricing.js` quotes.
3. **Expiry contexts** (§7.1): parity forward per expiry (P1-3 `parityForward`), carry, clock T and Tcal, ATM IV, straddle.
4. **Leg marks and IVs**: mark = mid if two-sided, else LTP (flag); IV = `ivOverride` ?? P1-3 IV of the mark on the expiry's forward ?? expiry ATM IV (`ivSource: "atm-fallback"`, warning `IV_FALLBACK`).
5. **Horizons**: T1 = earliest leg settlement instant; target instant (what-if; default now); grid columns (§7.6).
6. **Curves**: xs = `payoffRange`-style range widened to ±2σ of the first expiry (design §4.2), 240 samples + strikes; curve "first expiry" at T1; curve "target" at the target instant; optional "mid" (design).
7. **Stats** (§7.4), **bands** (§7.9), **grid** (§7.5–7.7), **slices** (§7.8).
8. **Settlement** (server only): when today is an expiry day of any leg and the estimate is `running`/`final`, attach it and `stats.atSettlement` = value of the first-expiry curve at the estimate and at the band edges.
9. **Warnings** (codes, open list): `IV_FALLBACK`, `FORWARD_CARRIED`, `NO_MARK`, `STALE_MARK` (> 10 s in market hours), `CAL_EXPIRY_DAY` ("front leg expires today: no calendar-spread margin benefit, extra ELM on short index options", SEBI rule from BRD §8.1), `BACK_IV_LOWER` (back-month ATM IV < front − 2 vol pts), `PATH_ASSUMPTION` (grid spans past T1), `SAMPLED` (multi-expiry stats), `TOO_MANY_EXPIRIES`.

### 3.8 Client data flow for extra expiries (`expiry-pricing.js`)

- `need(expiry)`: when a leg moves to an expiry other than the toolbar's, fetch `/v1/optionchain?underlying=&expiry=&strikes=12&greeks=false` **once** (cache 10 min per expiry; refetch if a leg strike leaves the cached strikes). From it keep: strikes, per-strike CE/PE symbols, lot size, and an initial `ExpiryContext`.
- `symbols()`: for each extra expiry, the legs' symbols + the CE/PE symbols of the 5 strikes nearest the expiry's forward (parity) = ≤ 12 per expiry, ≤ 36 total; plus futures legs' symbols.
- desk's existing `loadQuotes()` call appends `symbols()` to its symbol list (one call per refresh, as today). With P1-4's stream client present, the symbols are subscribed instead and the REST call drops them.
- On each refresh: `scenario.expiryContext(expiry, quotesFor(expiry), clockCtx)`; legs read marks from those quotes.
- Staleness: a leg whose quote is older than 10 s in market hours shows `STALE_MARK`; Place applies the BRD §7.5 stale-data confirmation (existing ticket rule), never silent.

---

## 4. API

All routes belong to module `strategy` (`x-stream: S22`), scope `read`, JSON `{ data, meta }`. Units: prices in index points/₹ per unit, P&L in ₹ (position total), IV in **vol points**, T in years (vol-time unless named `Tcal`), `units` in trading-day units, Δ in units of the underlying (and `deltaLots`), Γ as Δ change in units per 1 % move, Θ in ₹ per trading-day unit, ν in ₹ per vol point, timestamps ISO-8601 `+05:30`. Unavailable data is not an error: `available: false` with `reason`. Nothing here can prepare, place or modify an order.

### 4.1 Route table

| Method | Path | Scope | Purpose |
|---|---|---|---|
| POST | `/v1/strategy/analyze` | read | Price a strategy (any expiries): stats, curves, grid, slices, bands, settlement; optional S9 logging |
| GET | `/v1/options/expected-move` | read | σ bands and EAM per expiry for an underlying |
| GET | `/v1/options/settlement-estimate` | read | Running / final settlement estimate for an index on its expiry day |
| GET | `/v1/options/settlement-estimate/accuracy` | read | Estimate vs published, per expiry day, with summary |

POST with `scope: read` follows the scanner precedent (`POST /v1/scanner/plan`): the body is input, nothing is stored except the rate-limited S9 rows.

### 4.2 `POST /v1/strategy/analyze`

Request:
```json
{ "underlying": "NIFTY",
  "legs": [
    { "kind": "OPT", "expiry": "2026-11-03", "strike": 25150, "right": "CE", "side": "SELL", "lots": 1, "entry": 149.90 },
    { "kind": "OPT", "expiry": "2026-11-17", "strike": 25150, "right": "CE", "side": "BUY",  "lots": 1, "entry": 319.80 } ],
  "target": { "at": null, "ivShift": 0 },
  "grid": { "rows": 25, "sigmas": 2, "maxColumns": 20, "unit": "rupee" },
  "slices": [ { "kind": "sigma", "value": -1 }, { "kind": "pct", "value": 1 }, { "kind": "price", "value": 25300 },
              { "kind": "breakevens" }, { "kind": "walls" } ],
  "charges": false,
  "market": null,
  "at": null,
  "log": false }
```
- `legs` 1–12; `lots` 1–10,000; `entry` optional (null = live mark).
- `target.at` ISO instant ≤ last settlement (null = now); `ivShift` −50…+50 vol points (floor 1 % per leg IV).
- `grid.unit` `rupee` | `pctRisk`; `grid: false` skips the grid.
- `slices` ≤ 20 rows; kinds `pct` (value −50…50), `price` (value > 0), `sigma` (−4…4, at the target horizon), `breakevens`, `walls`, `spot`.
- `charges: true` makes P&L net of `structureCharges` (default brokerage profile; G9 plans are P1-10).
- `market`: optional `MarketSnapshot` (§3.3) for pure what-if; when present, no broker call is made and `at` may be any instant.
- `log: true` writes S9 rows (POP, P(target)) at most once per `minIntervalSeconds` per strategy signature (hash of legs, rounded entry, target date); ignored for `market`-supplied or `at`-shifted requests (not live predictions).

Response (abridged arrays; full arrays are 241 xs, 25 rows × ≤ 20 columns):
```json
{ "data": {
  "underlying": "NIFTY", "asOf": "2026-10-29T10:00:02.110+05:30", "at": "2026-10-29T10:00:00.000+05:30",
  "model": { "version": "p19-v1", "pricing": "black76-forward", "ivModel": "sticky-strike", "carry": "parity-implied",
             "clock": { "version": "vt1", "mode": "weighted" }, "rate": { "value": 0.065, "quality": "default" },
             "afterFirstExpiry": "held-level", "note": "Later legs valued with Black-76 at today's IV for their strike (sticky strike)." },
  "legs": [
    { "id": "l1", "expiry": "2026-11-03", "strike": 25150, "right": "CE", "side": "SELL", "lots": 1, "units": 65,
      "entry": 149.90, "mark": 149.90, "markBasis": "mid", "iv": 12.00, "ivSource": "chain-mid", "T": 0.0147289, "Tcal": 0.0143265 },
    { "id": "l2", "expiry": "2026-11-17", "strike": 25150, "right": "CE", "side": "BUY", "lots": 1, "units": 65,
      "entry": 319.80, "mark": 319.80, "markBasis": "mid", "iv": 12.60, "ivSource": "chain-mid", "T": 0.0541414, "Tcal": 0.0526826 } ],
  "expiries": [
    { "expiry": "2026-11-03", "forward": 25142.49, "carry": 0.0610755, "atmIv": 12.00, "T": 0.0147289, "Tcal": 0.0143265,
      "bands": { "s1": [24779.0, 25511.3], "s2": [24420.7, 25885.6] },
      "eam": { "value": 307.89, "basis": "market-straddle", "range": [24834.60, 25450.38], "model": 292.16 } },
    { "expiry": "2026-11-17", "forward": 25201.46, "carry": 0.0610755, "atmIv": 12.60, "T": 0.0541414, "Tcal": 0.0526826,
      "bands": { "s1": [24473.3, 25951.3], "s2": "…" }, "eam": { "...": "…" } } ],
  "firstExpiry": { "expiry": "2026-11-03", "settleAt": "2026-11-03T15:30:00+05:30" },
  "lastExpiry": { "expiry": "2026-11-17", "settleAt": "2026-11-17T15:30:00+05:30" },
  "stats": { "net": -11043.50, "netKind": "debit", "maxProfit": 7231.4, "maxProfitAt": 25160.0, "maxLoss": -10987.2, "maxLossAt": 22290.0,
             "unlimited": { "up": false, "down": false }, "breakevens": [24903.6, 25450.9], "pop": 0.4413,
             "approx": true, "risk": { "basis": "maxLoss", "value": 10987.2 },
             "probability": { "label": "Model probability", "calibration": "not yet measured" },
             "atSettlement": null },
  "payoff": { "xs": [23900, "…"], "curves": [
      { "id": "first-expiry", "at": "2026-11-03T15:30:00+05:30", "ys": ["…"] },
      { "id": "target", "at": "2026-10-29T10:00:00+05:30", "ys": ["…"] } ] },
  "grid": { "unit": "rupee", "risk": { "basis": "maxLoss", "value": 10987.2 },
            "rows": [ { "k": -2.0, "price": 23689.88 }, "…", { "k": 0, "price": 25120.50 }, "…", { "k": 2.0, "price": 26637.51 } ],
            "columns": [ { "at": "2026-10-29T10:00:00+05:30", "kind": "now", "label": "Now", "units": 14.56133 },
                         { "at": "2026-10-29T15:30:00+05:30", "kind": "close", "label": "Thu 29", "units": 13.85733 }, "…",
                         { "at": "2026-11-03T15:30:00+05:30", "kind": "settlement", "label": "3 Nov settle", "expiry": "2026-11-03" }, "…" ],
            "cells": [[-512.4, "…"], "…"], "maxAbs": 9876.5, "thinned": { "from": 27, "to": 20, "rule": "p0-p3" },
            "assumption": "held-level" },
  "slices": [
    { "kind": "sigma", "value": -1, "label": "−1σ", "price": 24779.0, "pnl": -1834.0, "delta": 21.4, "deltaLots": 0.33,
      "gamma": -3.1, "theta": 410.2, "vega": 702.5 },
    { "kind": "spot", "label": "Spot", "price": 25120.5, "pnl": 0.0, "delta": "…" } ],
  "settlement": null,
  "warnings": [ { "code": "SAMPLED", "severity": "info", "text": "Max profit, max loss and breakevens are sampled (legs expire on different dates)." },
                { "code": "PATH_ASSUMPTION", "severity": "info", "text": "Columns after 3 Nov assume the price is at the row level on 3 Nov as well." } ],
  "predictionIds": [] },
  "meta": { "requestId": "…", "sources": { "chains": [ { "expiry": "2026-11-03", "freshness": "cache", "ageMs": 1210 } ] } } }
```
Figures in this abridged example other than §7's worked examples are illustrative; tests assert §7's numbers.

### 4.3 `GET /v1/options/settlement-estimate?underlying=NIFTY[&date=2026-11-03][&at=…]`

`date` defaults to today (IST); a past date returns the stored summary. `at` (demo only; ignored with a `meta.ignored` note otherwise) replays a demo expiry day at that instant.

```json
{ "data": {
  "available": true, "underlying": "NIFTY", "date": "2026-11-03", "exchange": "NSE", "expiryDay": true,
  "state": "running",
  "window": { "start": "2026-11-03T15:00:00+05:30", "end": "2026-11-03T15:30:00+05:30", "minutes": 30, "source": "vol.clock.settlementWindowMinutes (needs verification)" },
  "asOf": "2026-11-03T15:18:00+05:30",
  "observed": { "minutes": 18.0, "mean": 25131.40, "ticks": 1076, "unobservedSeconds": 0, "gaps": [] },
  "remaining": { "minutes": 12.0, "weight": 0.4, "assumed": 25128.00, "effectiveMinutes": 0.64 },
  "estimate": 25130.04,
  "sd": 6.79, "band": { "z": 1.645, "lo": 25118.86, "hi": 25141.22, "p": 0.90 },
  "sigma": { "iv": 12.0, "source": "next-expiry ATM IV" },
  "quality": "stream", "method": "time-weighted-index-ticks-1s-locf",
  "accuracy": { "n": 0, "p95AbsPct": null, "note": "No recorded expiry days yet" },
  "published": null,
  "note": "Estimate from index values received by this Bridge. The exchange computes the official price from constituent prices; it can differ." },
  "meta": { "requestId": "…" } }
```
`state`: `not-expiry-day` | `pending` (before window start; `estimate` = spot, `sd` per §7.10) | `running` | `final` (after end; no band) | `published` (published value and error present) | `unavailable`. `reason` when `available: false`: `NOT_INDEX`, `NOT_TRACKED`, `NO_TICKS`, `DISABLED`, `NOT_LISTED_IN_DEMO`.

### 4.4 `GET /v1/options/settlement-estimate/accuracy?[underlying=NIFTY][&from=][&to=]`

```json
{ "data": { "items": [ { "underlying": "NIFTY", "date": "2026-10-27", "quality": "stream", "estimate": 25010.62,
              "published": 25011.05, "publishedSource": "broker-daily-close", "error": -0.43, "errorPct": -0.0017, "withinTolerance": true } ],
            "summary": { "n": 1, "meanAbsPct": 0.0017, "p95AbsPct": 0.0017, "maxAbsPct": 0.0017, "tolerancePct": 0.02 } },
  "meta": { "requestId": "…" } }
```
Range ≤ 1,100 days; `limit` ≤ 500.

### 4.5 `GET /v1/options/expected-move?underlying=NIFTY[&expiries=2026-11-03,2026-11-17][&at=]`

Default: the nearest 3 listed expiries. Reads chains with `priority: "user"`, `maxAgeMs: 3000` (≤ 3 chains; reuses the page's cache). Each item = the `expiries[]` shape of §4.2 plus `spot`, `straddleStrikes`, `flags` (`EAM_MODEL_FALLBACK` when the ATM straddle is one-sided). With `at` (any instant) the clock T moves but the prices are the current ones (what-if only, `meta.whatIf: true`).

### 4.6 Errors, MCP, bus

| Code | When |
|---|---|
| `VALIDATION_FAILED` 400 | Bad leg, > 12 legs, > `maxExpiries` expiries (`details.reason: "TOO_MANY_EXPIRIES"`), mixed underlyings, grid rows even/out of range, slice values out of range, `target.at` after the last settlement, `from > to` |
| `SYMBOL_NOT_FOUND` 404 | Unknown underlying |
| `CAPABILITY_UNSUPPORTED` 422 | No account can serve a chain for a leg's expiry (body names the expiry) and no `market` was supplied |
| `UPSTREAM_RATE_LIMITED` 429 / `UPSTREAM_TIMEOUT` 504 | Chain fetch failed after `timeoutMs`; never retried by the route |
| `RATE_LIMITED` 429 | Per-key limiter (existing) |

- **MCP** (`mcp/tools.mjs`, read): `analyze_strategy` (same input as §4.2 minus `log`; `grid` defaults to `false` and `payoff.xs` downsampled to 61 points for token economy) and `get_settlement_estimate` (`underlying`, `date?`). No write path; MCP calls never log predictions.
- **Bus**: `settlement.update { underlying, date, state, estimate, sd, observedMinutes, quality, published? }`, at most once a minute plus state changes. P1-11 alerts subscribe later. No WebSocket channel this round (`docs/asyncapi.yaml` unchanged).

### 4.7 `docs/openapi.yaml` additions

- `tags`: `- name: Strategy analysis` — "Multi-expiry strategy pricing, P&L grid and price slices, expected move, and the index settlement estimate (stream S22). Model outputs; nothing here places orders."
- `components/schemas`: `StrategyLegInput`, `StrategyTarget`, `StrategyGridRequest`, `StrategySliceRequest`, `MarketSnapshot`, `ExpiryContext`, `StrategyAnalyzeRequest`, `StrategyLegPriced`, `ExpiryBands`, `ExpectedAbsoluteMove`, `StrategyStats`, `PayoffCurve`, `StrategyGrid`, `StrategyGridColumn`, `StrategySlice`, `StrategyWarning` (`code` open enum), `StrategyAnalysis`, `ExpectedMove`, `SettlementEstimate`, `SettlementAccuracyRow`, `SettlementAccuracy`, `Unavailable` (reuse P1-3's `VolUnavailable` shape if landed, else define). `state`, `quality`, `ivSource`, `kind` enums are documented as open (BRD §7.8).
- Four `paths` with `x-stream: S22`, `x-scope: read`. Example:
```yaml
  /v1/strategy/analyze:
    post:
      tags: [Strategy analysis]
      operationId: analyzeStrategy
      summary: Price a strategy across expiries; P&L grid, price slices, bands and settlement estimate
      x-stream: S22
      x-scope: read
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/StrategyAnalyzeRequest" }
      responses:
        "200":
          description: The analysis. P&L in rupees; IV in vol points; probabilities are model values (uncalibrated).
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { $ref: "#/components/schemas/StrategyAnalysis" }
                  meta: { $ref: "#/components/schemas/Meta" }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }
  /v1/options/settlement-estimate:
    get:
      tags: [Strategy analysis]
      operationId: getSettlementEstimate
      summary: Running estimate of an index's expiry-day settlement price from the average over the settlement window
      x-stream: S22
      x-scope: read
      parameters:
        - { name: underlying, in: query, required: true, schema: { type: string, maxLength: 30 } }
        - { name: date, in: query, schema: { type: string, format: date } }
        - { name: at, in: query, description: "Demo mode only: replay a demo expiry day at this instant.", schema: { type: string, format: date-time } }
      responses:
        "200":
          description: The estimate, or available false with a reason.
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { oneOf: [{ $ref: "#/components/schemas/SettlementEstimate" }, { $ref: "#/components/schemas/Unavailable" }] }
                  meta: { $ref: "#/components/schemas/Meta" }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }
```

---

## 5. Demo mode

Demo never touches the network. Every route, the scheduler, the store and every UI state run unchanged.

- **Multi-expiry**: the demo already lists weekly NIFTY (Tue) and SENSEX (Thu) and monthly BANKNIFTY, with a term structure in `smileVol` (front richer). After P1-3, demo prices sit on the clock, so calendars and diagonals show realistic curved payoffs. A test asserts that a demo NIFTY call calendar's first-expiry curve is concave near the strike with its peak within one strike step of K.
- **Extra-expiry quotes**: `quoteOf` already serves any demo option token; the batched quotes path is exercised as with a broker.
- **Settlement replay** (`demoSettlement.mjs`): the demo index is a deterministic function of time (`spotAt`), so any demo expiry day can be replayed:
  - `spotSeconds(symbol, from, to)` samples `spotAt` each second; the replay drops 2 % of seconds deterministically (`hash32("drop:"+symbol+":"+t) % 50 === 0`) and coalesces every 7th pair, so LOCF and gap handling run;
  - `GET /v1/options/settlement-estimate?underlying=NIFTY&at=<instant>` in demo replays the day of `at` up to `at` (any past or current instant; a non-expiry day → `state: "not-expiry-day"`);
  - **demo published price** `demoSettlement(symbol, date, W)` = the exact mean of `spotAt` over all 1-second instants in [start, end), rounded to the tick. So the demo fixture error is the replay's sampling error only (≤ 0.001 %), proving the arithmetic; a second demo fixture with a 6-minute dropout proves the widened band contains the published value;
  - on a real demo expiry day the live service captures the demo feed's 1 s ticks like a broker feed;
  - on first demo start the accuracy log is seeded with the last 8 demo expiry days per demo index (`quality: "demo-replay"`), so the accuracy panel is never empty in demo.
- **Builder demo switch**: in demo only, the builder's `⋯` menu has "Preview expiry-day settlement", which sets the page's settlement `at` to the latest demo expiry day at windowStart + 18 min; the hero, payoff marker, chain pill and positions line all render. A banner "Demo preview: replaying 3 Nov 15:18" with "Exit preview" shows while active.
- **Walls** for slices: from `O.oiWalls` on the demo chain (demo OI peaks near the money), or P1-8 levels when present.
- FINNIFTY, MIDCPNIFTY, BANKEX are not demo underlyings: settlement status lists them `available: false, reason: "NOT_LISTED_IN_DEMO"`.

---

## 6. Dashboard

### 6.1 Builder legs and expiries (`strategy.js`, `expiry-pricing.js`)

- **Drafts per underlying**: `st.baskets[underlying]`; one-time migration merges `underlying|expiry` drafts into `underlying`, keeping each leg's expiry (if two old drafts exist for one underlying, the most recently edited wins and the other is kept as a saved strategy named "Draft 3 Nov (migrated)"; tested). The toolbar expiry becomes "the expiry new legs use".
- **Expiry pill** per leg row (design §5.5 places it): text `3 Nov`, `17 Nov · M` for monthly. Tap/click opens a menu of the next 6 listed expiries with calendar DTE and kind (`13 Nov · 15d · W`); keyboard `E` opens it for the focused leg. Choosing an expiry keeps strike/side/lots, clears `entry`, triggers `need(expiry)`; while its strikes load the leg shows `—` and a loading class; a 5th distinct expiry is refused with a toast "Up to 4 expiries in one strategy".
- **Strike stepping** on an extra-expiry leg uses that expiry's strike list.
- **Presets** (M3) appear in Neutral (calendars, double calendar) and Volatile (diagonals, double diagonal) with the badge "2 expiries". Back month = the next listed expiry ≥ 7 calendar days after the front, else the next one (design §5.1). Strike rules in §7.12.
- **Model line** under the what-if row (one line, quiet): "Later legs: Black-76 at today's IV for their strike (sticky strike) · Time: weighted clock · Carry from each expiry's parity forward". Tapping opens the method note sheet with the full text and the §2.3 assumptions.

### 6.2 Payoff additions (`payoff.js`)

Classes only; look from tokens.
- Curve ids: `first-expiry` (legend "At 3 Nov (first expiry)"; for single-expiry strategies "At expiry", unchanged), `target`.
- **σ bands** at the curve horizon (first expiry for the expiry curve; the target horizon when Curves shows only the target), classes `band band1`, `band band2`, labels "±1σ", "±2σ" (design §4.1 layers 2–4).
- **EAM range** of the first expiry: two short ticks on the x-axis at F ± EAM with the label "Straddle ±308" (class `eam`), a distinct shape from the band edges (BRD §7.4 shape cue). Tooltip: "Expected absolute move from the ATM straddle (market): ±307.9. Model √(2/π)·σ·F·√T: ±292.2. ±1σ band: 24,779–25,511."
- **Settlement marker** (expiry day, state `running`/`final`): vertical rule at the estimate (class `settle`), shaded band lo–hi (class `settle-band`), pill "Settle est. 25,130 ± 11"; the first-expiry curve dot at the estimate. The hero gains the line "At settlement estimate: +₹3,120 (90 %: +₹2,410 to +₹3,840)".
- Data table toggle (BRD §7.4): includes the band, EAM and settlement values.

### 6.3 P&L table tabs

`segmented("P&L table", [["spot","By spot"], ["grid","Grid"], ["slices","Slices"]])`, persisted in `strategyConfig.table`. All tabs respect the net-of-charges toggle and the IV shift.

### 6.4 Grid tab (`strategy-grid.js`)

- **Table**: `<table class="pl-grid">` with `<caption>` (text alternative, below), sticky first column (price, with `k`σ under it in quiet ink) and sticky header (date label; second line `T−3.3d` vol-time days left to the first expiry; expiry-day columns show `10:00 … 15:00`, `Settle`). Expiry boundaries get class `col-expiry`; columns after T1 get `col-after-first` and the header tooltip with the held-level assumption.
- **Cells**: text `+₹2,377` / `−₹2,626` (or `+21.6 %` / `−23.8 %` of risk) with the sign always present; zero shows `₹0`. Background from the shared heat tokens (`--heat-pos(x)`, `--heat-neg(x)`, x = |v| / maxAbs^0.7 per design); the token pair must pass the colour-blind check in §10.4. Loss cells also carry class `neg` (a hatch under `forced-colors`), so colour is never the only signal.
- **Unit toggle** `₹ | % of risk` (segmented) and the risk basis line under the table: "Max risk ₹10,987 (sampled)" or "% of margin estimate ₹1.2L (risk unlimited)".
- **Marks**: spot row (`row-spot`), the row nearest each breakeven (`row-be`), the column matching the target (`col-target`).
- **Interactions**: click/tap a cell → sets the what-if target date to the column instant and pins the payoff crosshair at the row price (design: target slider moves, chart pins). Arrow keys move the focused cell (roving `tabindex`), Enter applies, Esc returns focus to the tab. Long-press on touch shows the cell's breakdown popover: per-leg value at that cell.
- **Controls** (one row): rows `25` (stepper 5–61, odd), span `±2σ` (`±1σ | ±2σ | ±3σ`), `₹ | %`, `CSV`.
- **Text alternative**: one sentence, e.g. "P&L from −₹2,626 to +₹7,231 across 23,690–26,638 and 20 dates; profitable between about 24,904 and 25,451 at the first expiry."
- **Phone (< 720)**: offered (BRD §7.3); the table scrolls inside the panel both ways, price column sticky; 56 px cells, 2 lines of header; the tab shows a hint "Scroll for more dates →" once. **Tablet**: same with 64 px cells. **Desktop**: up to 20 columns fit at ≥ 1280 px content; else inner horizontal scroll. No horizontal page scroll anywhere (test).
- **Recompute**: on every model change and on each tick (prices only), through `scenario.grid`; ≤ 30 ms budget (§7.13). Slider drags redraw the grid at most every 100 ms (the chart keeps per-frame redraw).

### 6.5 Slices tab (`strategy-slices.js`)

- Default rows: `−2σ, −1σ, −1 %, Spot, +1 %, +1σ, +2σ, Breakevens, Put wall, Call wall` (persisted in `strategyConfig.slices`; "Reset rows").
- Columns: `Price · Move % · P&L · Δ (lots) · Γ (per 1 %) · Θ ₹/trading day · ν ₹/vol pt`, all at the **target date** (header says "at Now" / "at 31 Oct 15:30").
- **Edit**: `+ Add row` opens an inline form: kind `% | ₹ | σ | Breakevens | Walls` and a value; rows reorder by drag handle or `Alt+↑/↓`; each row has `×`. Breakevens and Walls expand to one row per level. Wall rows say "Put wall 24,800 (largest put OI)" or, with P1-8, "Put wall 24,800 (P1-8 level)".
- Click a row → pins the payoff crosshair at its price.
- Phone: columns `Price · P&L · Δ · Θ`, the rest in a tap-to-expand row; desktop/tablet: all.

### 6.6 Chain page (`desk.js`)

- **Expected-move tile**: two labelled lines: `±1σ 366 · 24,779–25,511` and `Straddle ±308 · 24,835–25,450`, title: "σ band from ATM IV on the vol-time clock; straddle range = the ATM straddle (market price of the expected absolute move)". When the straddle is one-sided: second line `Model ±292` with "model" tag.
- **Row markers**: existing ±1σ/±2σ markers (`tags.em`) stay; new `tags.eam` marks the rows nearest F ± EAM with a different glyph (class `em-abs`). Customise toggles both ("±1σ band", "Straddle range").
- **Settlement pill** in the top line on expiry days of the chain's underlying, from window start − 5 min to end + 10 min: `Settle est. 25,130.0 ± 11 · 18/30 min` (state `running`), `Settle est. 25,130.6 · final`, `Published 25,131.05 (est. −0.43)`. Tap opens the popover (`settlement-view.js`): observed mean, remaining weight, band, quality, gaps, accuracy summary, method note and disclaimer. Polls the local route every 5 s while visible inside that interval; 0 broker calls.

### 6.7 Positions page (`positions.js`)

On expiry day, inside the window, the summary gains one line for legs expiring today: "At settlement estimate 25,130: +₹3,120 on today's expiring legs (90 %: +₹2,410 to +₹3,840)". It uses `scenario.valueAtSettlement(legs, estimate)` and the same polling as §6.6. Nothing else on Positions changes.

### 6.8 Copy, accessibility, disclaimers

- Probabilities: "POP 44 % · Model probability · calibration: not yet measured" (BRD §8.4).
- Settlement: "Estimate, not the official price. The exchange computes the settlement price from constituent prices over the last 30 minutes (needs verification); this Bridge averages the index values it receives." Footer: "For information and personal use. Not investment advice."
- No "recommend", "best", "buy", "sell" as advice, "rich", "cheap" in new strings (banned-word test as P1-3).
- Live numbers `aria-live="off"`; settlement state changes announce only in the opt-in "announce alerts" mode. Every new SVG element has a text alternative; the grid is a real `<table>` with `scope` headers. Touch targets ≥ 44 px on coarse pointers. Reduced motion: no cell flashes.

### 6.9 Notes for the restyle team (to send with the PR)

1. The Grid follows BRD AC (25 × ≤ 20, phone offered with inner scroll), not design §5.2's 13 × 8.
2. The "Greeks" tab is replaced by "Slices" (Greeks across editable price rows).
3. New classes needing token styling: `pl-grid`, `row-spot`, `row-be`, `col-target`, `col-expiry`, `col-after-first`, `eam`, `em-abs`, `settle`, `settle-band`, `settle-pill`, `slice-row`, `leg-expiry-pill`.
4. Heat tokens must pass the colour-blind check (§10.4).

---

## 7. Formulas and worked examples

All functions are pure in `dashboard/scenario.js` (or `strategy/settlement.mjs`) and every worked example is a reference-value test (§10.1). Defaults: P1-3 weighted clock (w_nt 0.15, φ 0.20, Y = 268.95), session 09:15–15:30, window W = 30 min, r = 6.5 %, no holidays (fixture). Reference instant **Thu 29 Oct 2026 10:00 IST**, NIFTY spot S = 25,120.50, lot 65. Front expiry Tue 3 Nov (forward 25,142.49 from P1-3 example 5), back expiry Tue 17 Nov.

### 7.1 Carry and the forward at a later date

Per expiry i with parity forward F_i now and calendar time Tcal_i: **c_i = ln(F_i / S) / Tcal_i** (implied carry, which absorbs dividends; `forwardSource: "parity"`). The forward of expiry i at a later instant u with the underlying at X: **F_i(u, X) = X·e^{c_i·(Tcal_i − Tcal_u)}**. Discount from expiry i to u: df = e^{−r·(Tcal_i − Tcal_u)}. Vol time left: T_i(u) = (U_i(now) − U_u(now)) / Y from the P1-3 clock (units are additive). Futures legs: c_fut = ln(F_fut/S)/Tcal_fut; value at u = X·e^{c_fut·(Tcal_fut − Tcal_u)} if u < its expiry, else X (cash settled at the index close).

Example: c = ln(25,142.49 / 25,120.50) / 0.0143265 = **0.0610755**. Back expiry: Tcal = 19 d 5.5 h / 365 = 0.0526826; F_back = 25,120.50·e^{0.0610755·0.0526826} = **25,201.46** (if the 17 Nov chain's parity gives a different F, that one is used and its own c_back follows).

### 7.2 Leg value at an instant u with the underlying at X (sticky strike)

- Option leg, settles at or before u: intrinsic against X (index options settle on the settlement price; on expiry day inside the window X is the settlement estimate when evaluating "at settlement").
- Option leg, settles after u: df·Black76(F_i(u, X), K, T_i(u), σ_K + shift), σ_K = the leg's IV now (`ivOverride` ?? market IV at its strike; floor 1 %).
- P&L = Σ sign·units·(value − entry) − charges (when net). Same function draws the target curve (u = target), the first-expiry curve (u = T1) and every grid cell.
- Columns after T1 (`held-level`): a leg that settled at an expiry e ≤ u is valued at its intrinsic against the **row price** X.

### 7.3 Worked example A: long call calendar at the first expiry

Sell 1 × 25,150 CE 3 Nov at 149.90; buy 1 × 25,150 CE 17 Nov at 319.80 (model price on the clock at σ = 12.6 %: U_back = 4.00400 + 10.55733 = 14.56133 units, T = 0.0541414, df = e^{−0.065·0.0526826}; 319.80 after rounding to the tick). Net debit 169.90 × 65 = **₹11,043.50**.

At T1 = 3 Nov 15:30: ΔTcal = 14/365 = 0.0383562; back vol-time left U = 10 trading days (gap 0.2 + session 0.8) − 0.8 + 0.75733 (17 Nov to 15:00 plus a third of the window) + 2 weekends × 0.30 = **10.55733**, T = 0.0392539; df = e^{−0.065·0.0383562} = 0.9975100.

| X at T1 | F_back(T1) | Back value | Front intrinsic | P&L (₹, 65 units) |
|---|---|---|---|---|
| 24,800 | 24,858.17 | 129.50 | 0 | **−2,625.90** |
| 25,000 | 25,058.63 | 206.46 | 0 | **+2,376.69** |
| 25,150 | 25,208.99 | 280.65 | 0 | **+7,199.07** |
| 25,300 | 25,359.34 | 368.99 | 150 | **+3,191.13** |
| 25,500 | 25,559.81 | 507.29 | 350 | **−819.54** |

Test tolerance ±₹0.05 per row (normCdf precision ≤ 1e-7).

### 7.4 Stats for multi-expiry structures

- Sample the first-expiry curve on xs = {0} ∪ 400 evenly spaced points over F₁·e^{±6σ₁√T₁} ∪ every strike; refine each sign change by bisection to 0.01 pt (as `strategyStats` does today for later legs).
- **Asymptotic slopes** decide "unlimited": slope_up = Σ sign·units·s_i with s_i = 1 for a CE or FUT settled by T1, df_i·e^{c_i·ΔTcal_i} for a later CE, e^{c_fut·ΔTcal} for a later FUT, 0 for PE; slope_down similarly (−1 for PE at T1, −df_i for a later PE, but the price floor at 0 bounds it). If |slope_up| < 0.002 × Σ units it is **bounded**: max profit/loss come from the samples and are `approx: true` (a calendar's slope is e^{(c−r)ΔT} − 1 ≈ −0.0002, i.e. bounded).
- **POP** = ∫ 1[pnl_T1(x) > 0]·p(x) dx with p the lognormal density of S(T1) on the forward measure (F₁, σ = ATM IV of the first expiry + shift, T₁): sum of CDF differences over the profitable intervals between breakevens (exact for the sampled roots; the same code as today's single-expiry POP). Cross-checked against a seeded Monte-Carlo of 200,000 paths to ±0.5 percentage points in the test.
- **P(target)**: P(S(target) beyond each breakeven of the target curve), logged to S9 as `pTarget`.
- **Max risk** for the grid's % unit = |maxLoss| when bounded, else the margin estimate.

### 7.5 Grid rows

σ_H = ATM IV of the **last** leg expiry (the grid's horizon), T_H = its vol-time T. Row i of n (n odd, default 25): k_i = −m + i·(2m/(n−1)), m = `sigmas` (2); **price_i = S·e^{k_i·σ_H·√T_H}** (centred on spot so the middle row reads "price unchanged"; bands on the payoff stay on the forward). Prices are kept exact and displayed to the tick.

Example B1 (calendar above): σ_H√T_H = 0.126 × √0.0541414 = **0.0293181**; rows k = −2, −1.833, … : **23,689.88, 23,805.92, 23,922.53, …, 25,120.50 (k = 0), …, 26,378.46, 26,507.67, 26,637.51**.

### 7.6 Grid columns (vol-time clock, hourly on expiry days, capped)

Candidates, from now to the last settlement, each an instant with its clock units left:
- **P0** now, and the settlement instant (session close) of every leg expiry;
- **P1** each hour from the first full hour after the open to the window start (10:00 … 15:00 with `expiryDayStepMinutes` 60) on the **first** expiry day;
- **P2** the same on every other leg-expiry day;
- **P3** every trading day's session close strictly between now and the last expiry day, not already present (holidays from P1-2; weekends skipped).
Take P0, then P1, P2, P3 in order while the total ≤ `maxColumns`; the first class that does not fit is subsampled evenly: indices round(j·(m−1)/(k−1)), j = 0…k−1, for k free slots out of m candidates. Columns sort by time. `thinned` reports from/to counts.

Example B2 (single weekly, 3 Nov, at Thu 10:00): 11 columns, no thinning. Units to settlement per column: Now **3.96133**, Thu 15:30 **3.25733**, Fri 15:30 **2.25733**, Mon 15:30 **0.95733**, Tue 10:00 **0.66133**, 11:00 **0.53333**, 12:00 **0.40533**, 13:00 **0.27733**, 14:00 **0.14933**, 15:00 **0.02133**, Settle **0**. (Fri 15:30 and 14:00/15:00 equal P1-3 examples 2 and 4.) No column is placed on Sat/Sun: the clock does not move while the market is shut.

Example B3 (the calendar, at Thu 10:00, maxColumns 20): P0 = 3 (now, 3 Nov settle, 17 Nov settle); P1 = 6 → 9; P2 = 6 → 15; P3 has 12 closes (29 Oct, 30 Oct, 2, 4, 5, 6, 9, 10, 11, 12, 13, 16 Nov) for 5 slots → indices 0, 3, 6, 8, 11 → **29 Oct, 4 Nov, 9 Nov, 11 Nov, 16 Nov**; total 20, `thinned: { from: 27, to: 20 }`.

### 7.7 Cells and units

cell(i, j) = P&L at (price_i, column_j) by §7.2 with the IV shift. `pctRisk` = cell / risk × 100 with risk from §7.4. Example: a cell of −₹2,625.90 with a max risk of ₹11,043.50 → **−23.8 %**. Display: `formatSigned` with ₹ and compact above 7 characters (`+₹1.2L`); a cell within ±₹0.5 shows `₹0`.

### 7.8 Slices and Greeks at a price X and instant u

Price for each kind: `pct` X = S(1 + v/100); `price` X = v; `sigma` X = F_h·e^{v·σ_h√T_h} at the target horizon h (first expiry if the target is now and Curves = expiry); `breakevens` = the first-expiry breakevens; `walls` = P1-8 call/put walls or the chain's largest-OI strikes; `spot` X = S.
Per option leg at (X, u), with F = F_i(u, X), g = F/X, df, d1 on T_i(u):
- Δ = sign·units·df·N(d1)·g (CE) or df·(N(d1) − 1)·g (PE); FUT Δ = sign·units·e^{c·ΔTcal}; `deltaLots` = Δ / lot.
- Γ (per 1 % move) = sign·units·df·n(d1)/(F·σ√T)·g²·X·0.01.
- Θ (₹ per trading-day unit) = sign·units·df·(−F·n(d1)·σ / (2√T))/Y (P1-3 §6.5 definition, times df).
- ν (₹ per vol point) = sign·units·df·F·n(d1)·√T / 100.
A leg already settled at u contributes intrinsic P&L and Δ = sign·units·1[ITM], other Greeks 0.

Worked example D (calendar of §7.3, slice `price` 25,150, u = now): front value 157.31, back 335.77 → P&L **+₹556.47**; Δ **+1.47 units** (0.02 lots); Γ **−8.99 units per 1 %**; Θ **+₹544.69 per trading day**; ν **+₹715.83 per vol point**. Test: Greeks to 1e-2 against these and against central finite differences of the §7.2 value (h = 0.5 pt, 1e-4 vol, one clock minute).

### 7.9 σ bands and expected absolute move (A7)

- **σ bands** for expiry i at horizon T (vol-time): [F·e^{−kσ√T}, F·e^{kσ√T}], k = 1, 2, σ = ATM IV of that expiry (+ shift on the payoff only). P1-3 §6.8: F = 25,142.49, σ = 12 %, T = 0.0147289 → ±1σ **24,779.0 – 25,511.3**.
- **Expected absolute move (market)**: straddle mid at the two strikes bracketing F, linearly interpolated at F, divided by df: EAM = straddle(F)/df. Example: straddle 309.9 at 25,100 and 307.2 at 25,150 → 307.61 at F; df = e^{−0.065·0.0143265} = 0.999069 → **EAM = 307.89**, range **24,834.60 – 25,450.38**.
- **Model EAM** (shown beside it, and the fallback when the ATM straddle is not two-sided): √(2/π)·σ·F·√T = **292.16**.
- Labels are always distinct: "±1σ band (model)" vs "Straddle range (market)". The tastytrade 0.85 × straddle heuristic is not used.

### 7.10 Running settlement estimate (A16)

Window [A, B], W = B − A seconds. Build a 1-second grid g_s for s ∈ [A, min(now, B)): the last tick at or before s (exchange timestamp if sent, else receivedAt; out-of-order ticks are sorted; a tick before A seeds the grid). A second more than `locfMaxSeconds` (10) after the last tick is **unobserved**.
- Observed seconds O, unobserved seconds Q (gaps) and remaining seconds R = max(0, B − now).
- Mean of observed: m_O = (1/O)·Σ g_s.
- **Estimate** E = (O·m_O + (Q + R)·S_now)/W (the martingale assumption: every unobserved or future second is expected at the current index value).
- **Uncertainty**: in minutes, effective variance minutes M = R³/(3·W²) + Q_eff, where Q_eff = Σ over gaps of q·(gap length)²/W² (a conservative linear-interpolation error, `q` = 1/12 per gap) — 0 with no gaps. sd = S_now·σ·√(M · (1−φ)/375 / Y), σ = ATM IV of the **next** listed expiry (the expiring series' IV is unstable near settlement, P1-3 `SETTLING`). Before the window (`pending`): R is replaced by "minutes to A + W/3" so sd matches the P1-3 clock's window term. With `quality: "poll-5s"` add the sampling error √(Σ (5 s)²/12)/W per observed poll interval to sd (≈ 0.05 × σ-scaled; negligible but shown).
- `final`: at B, E = m over all seconds (unobserved seconds filled by linear interpolation between neighbours), sd omitted; flagged `gappy` if Q > 60 s.

Worked example C (NIFTY, 3 Nov, 15:18:00): O = 1,080 s, m_O = 25,131.40; S_now = 25,128.00; R = 720 s; Q = 0.
E = (18 × 25,131.40 + 12 × 25,128.00)/30 = **25,130.04**. M = 12³/(3 × 30²) = **0.64 min**; T = 0.64 × 0.8/375/268.95 = 5.0765e-6; sd = 25,128 × 0.12 × √5.0765e-6 = **6.79 pts**; 90 % band ±11.18 → **25,118.86 – 25,141.22**. At 14:30 (`pending`, 30 + 10 effective minutes) sd = **53.71 pts**.

Payoff at settlement: `stats.atSettlement` = { at: E, pnl: pnl_T1(E), lo: pnl_T1(E − 1.645 sd), hi: pnl_T1(E + 1.645 sd) } (lo/hi sorted by value).

### 7.11 Accuracy and tolerance

error = E_final − published; errorPct = 100·error/published; `withinTolerance` = |errorPct| ≤ `tolerancePct` (0.02, **needs verification**). Summary over rows: mean |errorPct|, p95 (nearest-rank), max. The settlement popover shows "Measured on n expiry days: 95 % within ±x %" once n ≥ 3, else "Not yet measured". If p95 > tolerance, the displayed band is widened by p95·E/100 (added in quadrature) and the note says so. Demo fixture: |errorPct| ≤ 0.001 for the clean replay; with the 6-minute dropout the published value lies inside the final ±3·sd(from the last pre-gap estimate) range.

### 7.12 Multi-expiry presets

Front = toolbar expiry e₁; back e₂ = the first listed expiry ≥ e₁ + 7 calendar days, else the next listed. K₀ = strike nearest F₁; step = strike step; w = max(step, round(move₁/(2·step))·step) (as `presetLegs`).
| Preset | Legs |
|---|---|
| Long call calendar | SELL CE K₀ e₁, BUY CE K₀ e₂ |
| Long put calendar | SELL PE K₀ e₁, BUY PE K₀ e₂ |
| Call diagonal | SELL CE K₀ + w e₁, BUY CE K₀ e₂ |
| Put diagonal | SELL PE K₀ − w e₁, BUY PE K₀ e₂ |
| Double calendar | SELL PE K₀ − w e₁, BUY PE K₀ − w e₂, SELL CE K₀ + w e₁, BUY CE K₀ + w e₂ |
| Double diagonal | SELL PE K₀ − w e₁, BUY PE K₀ − 2w e₂, SELL CE K₀ + w e₁, BUY CE K₀ + 2w e₂ |
Strikes clamp to each expiry's listed strikes. Placement order stays `placementPlan` (hedge-first: the long back legs first on entry; shorts first on exit).

### 7.13 Performance budget (AC 6)

`scenario.grid` for 10 legs × 25 rows × 20 columns = 5,000 cells × 10 legs = 50,000 Black-76 evaluations. Implementation rules: precompute per (leg, column) F-factor, df, √T, σ√T and ln K once (200 entries), per (leg, row, column) only ln X, d1, N(d1), N(d2) (a rational normCdf, no `Math.erf`); no allocation inside the cell loop (one `Float64Array(n·m)`); legs settled by a column use intrinsic. Target ≤ 8 ms on a mid-range laptop; the test asserts **median of 21 runs ≤ 30 ms** in CI (`perf.test.mjs`, skipped with a printed warning when `CI_SLOW=1` is set by a known slow runner, never silently).

---

## 8. Rate-limit budget

| Path | Broker calls | Rule |
|---|---|---|
| Builder, main expiry | unchanged (3 s chain poll, or the P1-4 stream) | — |
| Builder, each **newly used** extra expiry | **1 chain call** (12 strikes each side, no Greeks), cached 10 min | `priority: "user"`; refetch only if a leg strike leaves the cached strikes. Dhan (chain 1 per 3 s, unverified): the call waits behind at most one main refresh |
| Builder, extra-expiry marks | **0 extra calls**: ≤ 36 symbols appended to the page's existing quotes call (Dhan quotes 1/s up to 1,000 instruments; Zerodha quote class 1/s up to 500, needs verification) | With P1-4: stream subscriptions, 0 REST |
| `POST /v1/strategy/analyze` from the dashboard (`log: true`) | ≤ 4 chain reads with `maxAgeMs` 3 s → served from the freshness cache the page just filled (normally 0 broker calls) | ≤ 1 per minute per open builder; skipped while the tab is hidden |
| `POST /v1/strategy/analyze` from API/MCP | ≤ 4 chain reads (user priority, cache-first) | Per-key limiter (existing); `market` supplied → 0 calls |
| `GET /v1/options/expected-move` | ≤ 3 chain reads, cache-first | Per-key limiter |
| Settlement capture (stream) | 0 REST; 1 stream symbol per index on expiry days only (≤ 2 per day in practice: NIFTY Tue, SENSEX Thu, monthlies) | Hub client `settlement:<U>`, `ltp` mode; counts toward the per-feed cap (negligible) |
| Settlement poll fallback | 1 LTP call / 5 s / underlying for ≤ 36 min = ≤ 432 calls on an expiry day | `priority: "background"`, `maxAgeMs` 2 s (reuses the page's index quote when the chain page polls it) |
| Published close | 1 daily-history call per underlying per expiry day (+ ≤ 4 retries) | background |
| Dashboard → Bridge settlement polling | 1 local request / 5 s / visible page, only inside the window ± margin | 0 broker calls |
| CPU | Grid ≤ 30 ms (§7.13); settlement estimate ≤ 1 ms (1,800-element grid kept incrementally); tick append buffered 1 s | BRD §7.1 |

---

## 9. Safety, compliance and honesty gates

### 9.1 Order safety (nothing loosens `docs/guides/safety.md`)

- No new route or MCP tool can prepare, place, modify or cancel an order or touch the kill switch, limits or live gates. A static test asserts `strategy/` imports nothing from `orders/`, `paper/`, `safety/`.
- Placing a multi-expiry draft uses the existing `strategy-place.js` path: `POST /v1/orders/preview` then `POST /v1/orders` per leg, hedge-first on entry and shorts-first on exit (`placementPlan`), every Bridge gate applies, paper is the default. The UI never claims an atomic fill.
- **Stale marks**: an extra-expiry leg mark older than 10 s in market hours triggers the existing stale-price confirmation (BRD §7.5); a leg without a mark blocks Place (`NO_PRICE`, existing).
- **Expiry-day calendars**: `CAL_EXPIRY_DAY` warning names the BRD §8.1 rules (no calendar-spread margin benefit on expiry day, extra 2 % ELM on short index options); informational, it never changes a button state beyond today's rules.
- The settlement estimate and the grid are never used to size, price or trigger an order. "Click a cell" sets the what-if only.

### 9.2 Compliance (BRD §8)

- **Neutral copy (RA/IA)**: descriptive only ("P&L at 25,300 on 3 Nov: +₹3,191"); banned-word test over `scenario.js` strings, `strategy-grid.js`, `strategy-slices.js`, `settlement-view.js` and new strings in `strategy.js`, `desk.js`, `positions.js`.
- **Probabilities (D8, §8.4)**: "Model probability; calibration: not yet measured" on POP, P(target) and the settlement band; S9 rows written for each (K6).
- **Market-data terms (§8.3)**: ticks and summaries stay in `dataDir`; nothing is uploaded or pooled. Real settlement fixtures are created only by the owner's explicit script run; the script strips account and broker identifiers and the README says fixtures are shared only by choice and contain index values only.
- **Education rule** (finfluencer look-back): nothing here publishes; no share cards this round.
- **Security (§7.9)**: read scope only; responses carry no `accountId`; stores hold no secrets (the `securityReview.test.mjs` token-shape scan runs over `dataDir/strategy/`).
- **Data honesty (§7.6)**: method notes for the clock, carry, sticky strike, held-level assumption, settlement method; `approx` on sampled figures; `quality` on every settlement figure; unavailable states with reasons; demo labelled "Demo".

### 9.3 "Needs verification" register

| Item | Where |
|---|---|
| Index option final settlement = index closing price, computed from the last 30 minutes of constituent prices (NSE and BSE) | `settlement.mjs` method note, §2.3 |
| Window length and its end at the session close for NIFTY, SENSEX, BANKNIFTY, FINNIFTY, MIDCPNIFTY, BANKEX | `vol.clock.settlementWindowMinutes.index` |
| Broker 1d candle close on expiry day = official closing price | `published` source |
| UDiFF bhavcopy field holding the underlying settlement price | `published` upgrade path |
| Tolerance 0.02 % | `strategy.settlement.tolerancePct`, PRD |
| Expiry-day rules (no calendar benefit, extra ELM) still current | `CAL_EXPIRY_DAY` text |
| Dhan chain 1/3 s; Zerodha quote batch size | §8 |

---

## 10. Test plan

Vitest, files next to the code, existing naming, fake clock, no network (`globalThis.fetch` throws in every new test file).

### 10.1 Unit (pure)

| File | Covers |
|---|---|
| `server/bridge/dashboard/scenario.test.mjs` | §7.1 carry 0.0610755 and F_back 25,201.46; §7.3 example A five rows ±₹0.05; single-expiry results equal today's `strategyStats`/`payoffModel` on 10 legacy fixtures (iron condor, straddle, ratio, futures presets) to 1e-6 (back-compat); §7.4 bounded-slope rule (calendar bounded, naked short call unlimited, short future + long back call); POP vs seeded Monte-Carlo ±0.5 pp for calendar, diagonal, double calendar; §7.5 rows (B1 values to 0.01); §7.6 columns B2 (units to 1e-5, no weekend columns) and B3 (exact list, `thinned`), holiday fixture removes a close, today-is-expiry-day case, a target past T1; §7.7 %-risk and the unlimited fallback; §7.8 example D and finite differences; §7.9 bands, EAM 307.89, model 292.16, one-sided fallback; §7.12 preset legs on a demo chain pair; settled-leg handling in `held-level` columns; `ivOverride` precedence; `IV_FALLBACK`, `FORWARD_CARRIED` |
| `server/bridge/dashboard/scenario.shared.test.mjs` | Imports only `./pricing.js`; no `document`/`window`/`fetch`; no session or `365` literals; listed in `DASHBOARD_FILES`; imports cleanly in Node |
| `server/bridge/dashboard/perf.test.mjs` | **AC 6**: 10 legs (mixed expiries and a future) × 25 × 20, median of 21 runs ≤ 30 ms; prints the median |
| `server/bridge/strategy/settlement.test.mjs` | §7.10 example C (E 25,130.04, M 0.64, sd 6.79, band 25,118.86–25,141.22) and the 14:30 pending sd 53.71; LOCF; gap > 10 s → unobserved and widened sd; out-of-order and duplicate ticks; exchangeTs preferred; tick before A seeds; after B → final; `poll-5s` sampling term; `gappy` |
| `server/bridge/strategy/market.test.mjs` | Chains → ExpiryContexts (parity forward through `pricing.js`, carry, ATM IV, straddle), carried forward when one-sided, futures carry, mark basis mid/ltp |
| `server/bridge/strategy/config.test.mjs` | Defaults, strict keys, ranges, odd rows |
| `server/bridge/strategy/settlementStore.test.mjs` | Buffered append, torn last line skipped and counted, atomic summary, last accuracy row wins, retention keeps summaries |

### 10.2 Service and scheduler

- `server/bridge/strategy/settlementService.test.mjs` (fake hub, fake marketData, P1-2 `reference/fake.mjs`, manual clock): arms only on an expiry day of the underlying at window start − 5 min, not on a fixture holiday or a non-expiry weekday; subscribes `settlement:NIFTY` to `NSE:NIFTY` in `ltp` mode and unsubscribes at end + 1 min; feed down → polls every 5 s at background priority and `quality: "poll-5s"`; feed and poll unavailable but a fake `recorder` present → `recorder-1m`; restart at 15:12 reloads ticks and records the gap; published fetched at end + 5 with retries; accuracy row; `settlement.update` once a minute and on state change; S9 rows via `vol.logPredictions` (fake vol).
- `server/bridge/strategy/analyzeService.test.mjs`: one chain read per distinct expiry with `maxAgeMs` 3000 and user priority (call counter; second call within 3 s → 0 broker calls); `market` supplied → 0 calls; prediction logging rate-limited per signature (fake clock); `log` ignored with `market`/`at`; expiry-day attaches the settlement estimate and `atSettlement`.
- `server/bridge/strategy/settlementFixture.test.mjs` (**AC 5**): every file in `__fixtures__/settlement/demo/` (clean replay: |errorPct| ≤ 0.001; dropout replay: published within the band) and every file in `__fixtures__/settlement/real/` (|errorPct| ≤ tolerance). The real block is `it.skipIf(realFixtures.length === 0)` with the message "AC 5 open: record a NIFTY and a SENSEX expiry day (docs/guides/strategy.md → Settlement fixtures)".
- `server/bridge/strategy/agreement.test.mjs`: the server route and the dashboard's `scenario.analyze` on the same demo MarketSnapshot give identical stats, grid cells and slices (1e-9) for the calendar, an iron condor and a double diagonal with a futures leg.
- `server/bridge/strategy/imports.test.mjs`: no import from `orders/`, `paper/`, `safety/`.

### 10.3 Contract tests

- `server/bridge/core/openapi.test.mjs` passes with the 4 operations (`x-stream: S22`, `x-scope: read`).
- `server/bridge/strategy/routes.test.mjs`: happy paths; every §4.6 error; `available: false` shapes and reasons; `at` honoured only in demo; no `accountId` key anywhere (deep scan); every response field present in the OpenAPI schema (schema walk, as P1-3).
- `server/bridge/mcp/tools.test.mjs`: `analyze_strategy` returns the REST `data` (with `grid: false` default and 61-point payoff); `get_settlement_estimate`; no write path; never logs predictions.
- `server/bridge/core/eventBus.test.mjs`: `settlement.update` in TOPICS.

### 10.4 Dashboard

- `strategy.test.mjs`: draft migration (`underlying|expiry` → `underlying`, two-draft collision kept as a saved strategy); expiry pill menu; 5th expiry refused; strike stepping on an extra expiry uses its strikes; the 6 presets build legs on demo chain pairs; saved strategies round-trip per-leg expiries; prediction call at most once a minute and not while hidden.
- `expiry-pricing.test.mjs`: one chain fetch per new expiry, symbols list ≤ 36, merged into desk's quotes call (call counter), refetch when a strike leaves the cache, stale marking.
- `strategy-grid.test.mjs`: 25 × 20 table from a GridModel; sign on every cell; `neg` class on losses; sticky column classes; click → `onPick({ at, price })`; keyboard roving focus; CSV text; text-alternative sentence; 360 px layout has no horizontal page scroll (DOM width check as `polish.test.mjs`).
- `strategy-slices.test.mjs`: default rows; add/edit/remove/reorder; breakevens and walls expand; persistence; phone column set.
- `desk.test.mjs`: Expected-move tile shows both lines and the model fallback; `tags.eam` markers; settlement pill only on expiry days inside the interval; polling stops outside it.
- `positions.test.mjs` (or the existing positions test file): expiry-day settlement line.
- `polish.test.mjs`: add `strategy-grid.js`, `strategy-slices.js`, `settlement-view.js`, `expiry-pricing.js` (44 px targets, no colour literals).
- **Colour-blind check** (`palette.test.mjs`, owned with the restyle): the heat token ends at x = 1 differ by ΔE2000 ≥ 20 under deuteranopia and protanopia simulation (Machado 2009 matrices) in both themes; fails the build if the restyle picks an unsafe pair.
- Banned-word test over the new strings.

### 10.5 End-to-end

`server/bridge/e2e/strategy.e2e.test.mjs` (demo, real HTTP on an ephemeral port, as `bridge.e2e.test.mjs`):
- `POST /v1/strategy/analyze` with the §7.12 long call calendar on demo NIFTY: 200, two expiries, `approx: true`, grid 25 rows × ≤ 20 columns with a `settlement` column for each expiry, slices with Greeks; with `market` = the §7 fixture snapshot the §7.3 rows match.
- 13 legs → 400; 5 expiries → 400 `TOO_MANY_EXPIRIES`.
- `GET /v1/options/expected-move?underlying=NIFTY`: 3 items with bands and EAM.
- `GET /v1/options/settlement-estimate?underlying=NIFTY&at=<last demo Tue 15:18>`: `running`, band present; `at=<15:40>` → `published` with the demo published value and an error ≤ 0.001 %; `underlying=BANKEX` → `NOT_LISTED_IN_DEMO`.
- `GET /v1/options/settlement-estimate/accuracy`: 8 seeded rows per demo index.
- MCP `analyze_strategy` through the MCP endpoint returns the same stats.

Manual (`run` skill) at 390×844, 820×1180 and 1440×900, dark and light: build a calendar from the preset; change a leg's expiry; Grid (₹ and %), click a cell → target and crosshair move; Slices edit; Expected-move tile and EAM markers on the chain; demo "Preview expiry-day settlement" on builder, chain and positions. Screenshots in the PR.

---

## 11. Migration and back-compat

- **Drafts**: `st.baskets` keys move from `underlying|expiry` to `underlying` on first load (§6.1), one-time, tested; `try/catch` around storage as today. The undo record keeps working (key format change handled in `doUndo`).
- **Saved strategies**: already store per-leg `expiry` through `migrateLegs`; the top-level `expiry` field stays as "front expiry" for old readers.
- **`options.js`**: `payoffAt`, `valueAt`, `strategyStats`, `payoffModel`, `scenarioLevels`, `scenarioGrid` stay exported and unchanged (Positions and tests use them). The builder switches to `scenario.js`; for single-expiry strategies the numbers are identical (back-compat test §10.1) except where P1-3 already changed T (clock) and the futures basis (exponential carry instead of linear decay: under 0.5 pt difference over a month on NIFTY, noted in the changelog).
- **`strategyConfig`**: new keys `table` ("spot"), `gridUnit` ("rupee"), `gridRows` (25), `gridSigmas` (2), `slices` (defaults); unknown/old values fall back.
- **API**: new routes only; nothing existing changes shape (§7.8 additive). New bus topic, new contract method on `vol` (additive).
- **Config**: `strategy` is a new optional section. `bridge.config.example.json` documents it.
- **Data folder**: `dataDir/strategy/` created on first start; `backup/` copies `dataDir` (verify `backupService.mjs`; if it uses a list, add `strategy/`).
- **Docs**: STREAMS.md S22 row (`strategy` module; `settlement` service; requires marketData, streamHub, reference, vol, scheduler); ARCHITECTURE.md module map and dataDir layout; `docs/guides/strategy.md` section incl. "Settlement fixtures" (how to run `scripts/settlement-fixture.mjs`); CHANGELOG.
- **Without P1-3** (if this lands first by accident): the build must not ship. `scenario.shared.test.mjs` fails on the missing `pricing.js` import by design (hard dependency).

---

## 12. Ordered task list (one engineer, one session)

Each step ends green (`npx vitest run <files>` and `node scripts/check-mjs.mjs`).

1. **Skeleton** (lead lands the core change first): `settlement` contract (topic `settlement.update` is pre-registered by F0; `vol.logPredictions` exists from P1-3); `strategy/module.mjs` with the 4 routes as `notBuilt`, `config.mjs`, `fake.mjs`; 4 OpenAPI path stubs (`x-stream: S22`) so `openapi.test.mjs` passes; `DASHBOARD_FILES` entries.
2. **`scenario.js` core**: expiry contexts and carry (§7.1), leg valuation (§7.2), curves, multi-expiry stats and POP (§7.4); `scenario.test.mjs` with examples A, the bounded-slope cases, Monte-Carlo POP and the legacy back-compat fixtures; `scenario.shared.test.mjs`.
3. **Grid, slices, bands**: rows/columns/cells (§7.5–7.7), slices and Greeks (§7.8), bands and EAM (§7.9), presets (§7.12); tests B1–B3, D; `perf.test.mjs` (AC 6).
4. **Server analyze**: `market.mjs`, `analyzeService.mjs`, route, prediction logging; `market.test.mjs`, `analyzeService.test.mjs`, `agreement.test.mjs`.
5. **Settlement maths and store**: `settlement.mjs`, `settlementStore.mjs`; example C tests.
6. **Settlement service**: scheduler, hub client, poll and recorder fallbacks, published fetch, accuracy, bus, S9; `settlementService.test.mjs`.
7. **Demo**: `demoAdapter` helpers, `demoSettlement.mjs` replay and published price, accuracy seeding, demo fixtures; `settlementFixture.test.mjs` (demo green, real skipped with the AC-open message); `scripts/settlement-fixture.mjs` + fixtures README.
8. **Routes complete**: expected-move, settlement-estimate, accuracy; `routes.test.mjs`; MCP tools; full OpenAPI schemas (§4.7).
9. **Builder data**: drafts per underlying + migration, `expiry-pricing.js`, desk quotes merge, expiry pill and menu, presets, builder on `scenario.js`; `strategy.test.mjs`, `expiry-pricing.test.mjs`.
10. **Payoff additions**: bands at horizon, EAM ticks, settlement marker and hero line, model line; payoff data table.
11. **Grid tab** (`strategy-grid.js`) and **Slices tab** (`strategy-slices.js`) with their tests.
12. **Chain and positions**: Expected-move tile, `tags.eam`, settlement pill and popover (`settlement-view.js`), positions line; desk/positions tests.
13. **Static and polish**: banned words, `polish.test.mjs`, colour-blind token test (with the restyle), imports test, full suite.
14. **E2E and docs**: `strategy.e2e.test.mjs`; STREAMS, ARCHITECTURE, guide, example config, CHANGELOG; the §9.3 register and §6.9 notes in the PR description; screenshots at three sizes.

**Cut line** if the session runs short: after step 9 the server, API, demo and multi-expiry builder (AC 1, 5-server, 6) are shippable; steps 10–12 (payoff overlays, Grid/Slices UI, chain/positions) can land in the next session without blocking P1-10/P1-11. Never cut steps 2–3's tests or step 7's AC-open marker.

---

## 13. Acceptance criteria mapping

| BRD P1-9 criterion | Where it is met | Honest gap |
|---|---|---|
| 1. Legs in any listed expiry plus futures; calendars, diagonals and double calendars from presets; at the first expiry later legs valued by Black-76 at their IV (sticky strike default, shown) | §3.8, §6.1, §7.1–7.4, §7.12; `scenario.test.mjs` example A | Sticky strike is the only model this round (B5 later); max 4 expiries |
| 2. Heatmap: price rows (±2σ, 25) × date columns (today → last expiry; hourly on expiry day, vol-time clock); ₹ or % of max risk; colour-blind-safe scale with sign; click sets target date and spot | §6.4, §7.5–7.7; grid tests, palette test | Columns capped at 20 with a printed thinning rule; after the first expiry the held-level assumption applies; unlimited risk uses % of margin estimate |
| 3. Price-slice grid with editable rows (%, ₹, σ, breakevens, walls) and P&L, Δ, Γ, Θ, Vega | §6.5, §7.8, example D | Walls from P1-8 when present, else largest chain OI (labelled) |
| 4. σ bands from ATM IV·√T on the forward and the straddle-based EAM drawn and labelled separately on payoff and chain | §6.2, §6.6, §7.9 | EAM falls back to the model value when the ATM straddle is one-sided (labelled "model") |
| 5. NIFTY/SENSEX expiry days from 15:00: running settlement estimate shown; expiry payoff evaluated at it; a recorded-tick fixture reproduces the published settlement within tolerance | §3.5, §4.3, §6.2, §6.6, §6.7, §7.10–7.11; settlement tests | **Open until a real expiry day is recorded**: capture, script and test ship now; demo fixtures pass; tolerance 0.02 % proposed, needs verification |
| 6. Recompute 10 legs × 25×20 ≤ 30 ms, measured in a test | §7.13, `perf.test.mjs` | — |
| Carried from P1-3: builder probabilities logged (K6) | §4.2 `log`, §3.2 `vol.logPredictions` | Uncalibrated label until P2 |

---

## 14. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | P1-3 (`pricing.js`, clock) slips or changes its API | Medium | High | Hard dependency declared; `scenario.js` calls a small named set (`black76`, `greeks`, `impliedVol`, `parityForward`, `atmIvAt`, `clockUnits`, `volYearsAt`); an adapter shim in `scenario.js` is the only place to change |
| R2 | Our tick average differs from the exchange's constituent-based close by more than the tolerance | Medium | Medium | Accuracy log from day one; band widened by measured p95; copy says "estimate"; tolerance set from data |
| R3 | AC 5 stays open because nobody records a real expiry day | Medium | Medium | Recording is automatic for every user on expiry days; the script makes a fixture in one command; the owner records the first NIFTY Tuesday and SENSEX Thursday after merge |
| R4 | Conflict with the restyle team in `strategy.js`, `payoff.js`, `desk.js` | High | Medium | Ownership split stated above; P1-9 puts new UI in new files (`strategy-grid.js`, `strategy-slices.js`, `settlement-view.js`, `expiry-pricing.js`) and keeps edits in shared files to hooks; rebase daily |
| R5 | Rate limits on brokers with tight chain limits (Dhan) when extra expiries are added | Medium | Medium | One chain call per new expiry, then quotes in the existing call; stream with P1-4; budget test with a Dhan-policy fake |
| R6 | Users read the held-level grid columns or sampled stats as exact | Medium | Medium | `PATH_ASSUMPTION` and `SAMPLED` warnings, method note, column header tooltip, `approx` in the API |
| R7 | Grid perf on old phones (BRD phone target) | Low | Medium | Same budget on a 4× CPU-throttled run in the manual check; drag redraws throttled to 100 ms; typed arrays |
| R8 | Settlement window or method changes (SEBI/exchange) | Low | Medium | Window from config (`vol.clock`), method text in one place, register §9.3 |
| R9 | Stream id | Resolved | — | Fixed in `docs/spec/README.md`: strategy is S22 |
| R10 | Carry from parity is noisy when the back expiry's ATM quotes are wide | Medium | Low | Median of 5 strikes (P1-3), `FORWARD_CARRIED` fallback from the nearest clean expiry, flag shown |
