# Phase 1 engineering specs: build order and shared foundations

Status: authoritative build plan · Owner: principal engineer · Date: 29 Oct 2026
Source: BRD `docs/brd/options-platform.md` §6.1 (Phase 1) and the twelve specs in this folder.

Read this file before any spec. It fixes three things the specs could not fix on their own:

1. **Final stream ids** for every new module (the specs had claimed S16 twice, S18 twice, S20 twice and S21 twice).
2. **Shared foundations (F0)** and **shared-module owners**, so each piece of maths, storage and plumbing is built once.
3. **The build order**: one step per engineer session, with the dependency each step needs and the check that says it is done.

Where a spec and this file disagree, this file wins. Each spec carries a "Build order and shared foundations" note that points here.

---

## 1. Specs and BRD items

| Spec | BRD item(s) | Module(s) and stream |
|---|---|---|
| `p1-01-recorder.md` | P1-1 (D1, S1, S3) | `recorder` **S17** |
| `p1-02-reference.md` | P1-2 (J3, J8, J9, S5) | `reference` **S16** |
| `p1-03-pricing-vol.md` | P1-3 (A15, C1, C2, C11, S2, S6 back-fill, S9) | `vol` **S18**; `dashboard/pricing.js` |
| `p1-04-streaming.md` | P1-4 (A3, A11, A14) | changes in S5 `market`, S6 `stream` (no new stream) |
| `p1-05-readiness.md` | P1-5 (H5, §7.9) | `readiness` **S20** |
| `p1-06-stocks.md` | P1-6 (A2, E1, E2, F7) | `fno` **S19** |
| `p1-07-oi-straddle-charts.md` | P1-7 (D2–D5, A9) | inside `recorder` **S17** (`recorder/series/`) |
| `p1-08-exposure.md` | P1-8 (D6, D7) | `exposure` **S21** |
| `p1-09-multi-expiry.md` | P1-9 (B2–B4, A7, A16) | `strategy` **S22** |
| `p1-10-margin-checks.md` | P1-10 (G2, G3, F9, G8, G9) | `margin` **S23** |
| `p1-11-alerts.md` | P1-11 (H1) | `alerts` **S24** |
| `p1-12-guard-participants.md` | P1-12 (H2) **and** P1-13 (J1, S4, F2, F11) | `guards` **S25**, `participants` **S26**, `book` **S27** |

The BRD has 13 builds; the last spec file covers two of them. If capacity drops to 2 engineers (BRD §6.0), steps 25–27 (book, family gate and guards) move to Phase 2. Step 14 (participant OI) stays, because P1-8 reads it.

### 1.1 Final stream table (for `docs/STREAMS.md`)

| Stream | Builds | Consumes |
|---|---|---|
| S16 | `reference` | symbols (masters), scheduler |
| S17 | `recorder` (incl. `recorder/series`) | marketData, streamHub, accounts, scheduler, symbols, reference, backupData |
| S18 | `vol` (+ `dashboard/pricing.js`) | marketData, reference, symbols, scheduler, recorder (optional) |
| S19 | `fno` | marketData, symbols, accounts, scheduler, reference, recorder (optional) |
| S20 | `readiness` | accounts, scheduler, safety, reference (optional) |
| S21 | `exposure` | marketData, recorder, vol, reference, participants |
| S22 | `strategy` (`settlement` service) | marketData, streamHub, reference, vol, scheduler, recorder (optional) |
| S23 | `margin`, `chargePlans` | accounts, scheduler, symbols, marketData, orders, safety, reference, readiness |
| S24 | `alerts` | streamHub, marketData, symbols, accounts, scheduler, recorder, vol, exposure, reference |
| S25 | `guards` | orders, marketData, streamHub, safety, audit, readiness, margin, reference, accounts, book |
| S26 | `participants` | reference |
| S27 | `book` | orders, marketData, accounts |

---

## 2. Conflicts found and how they were resolved

All fixes are already applied in the spec files; this table is the record.

| # | Conflict | Specs | Resolution |
|---|---|---|---|
| C1 | Stream ids: S16 claimed by recorder and reference; S18 by vol and readiness; S20 by exposure and strategy; S21 by margin and alerts | all | Table §1.1; every `x-stream` and contract `stream` string updated |
| C2 | Three Black-76/IV implementations: P1-1 `server/lib/black76.mjs`, P1-8 `greeks.mjs impliedVol`, P1-11 "black76 fallback", plus interim seams in P1-4, P1-7 and P1-12 | P1-1, P1-3, P1-4, P1-7, P1-8, P1-11, P1-12 | One implementation: `dashboard/pricing.js` (P1-3a), built **before** the recorder. `black76.mjs` is dropped; the others call `pricing.js` |
| C3 | Two trading calendars: P1-1 interim `recorder/calendar.mjs` with `recorder.holidays`/`recorder.session` config vs P1-2 `reference` | P1-1, P1-2 | P1-2a lands first. The recorder keeps only slot maths and a holiday detector; the `holidays` and `session` recorder keys are removed |
| C4 | Same field name, two meanings: `callWall`/`putWall` = largest OI strike (P1-1 S3 rows, P1-7 series) vs gamma Call/Put Wall (P1-8) on the same `/v1/options/*` API | P1-1, P1-7, P1-8, P1-11 | OI fields renamed `largestCallOi`/`largestPutOi` (P1-8 already used these names). "Wall" means the gamma level only |
| C5 | PCR, max pain and largest OI computed twice (P1-1 `daily.mjs`, P1-7 `oi-series.js`) | P1-1, P1-7 | P1-1 creates `dashboard/oi-series.js` with them; P1-7 extends it |
| C6 | Two time-series SVG helpers (P1-3 `vol-history.js`, P1-7 `ts-chart.js`) | P1-3, P1-7 | P1-3c creates `dashboard/ts-chart.js`; P1-7 extends it |
| C7 | Two leg-mark and strategy-P&L functions with different spread caps (alerts 5 %, guards 15 %) | P1-11, P1-12 | One shared `dashboard/marks.js` (P1-11a). Strategy P&L uses 15 % in both, so a guard and an alert on the same legs agree |
| C8 | `vol.logPredictions` added to P1-3's contract later by P1-9 | P1-3, P1-9 | Defined in P1-3's contract from the start |
| C9 | P1-8 waits for "P1-13 (no spec yet)", but P1-13 is in the last spec and was scheduled last | P1-8, P1-12 | Participant OI split out as step 14, before P1-8. Shape fixed in `p1-12` §4.2.1 |
| C10 | MCP default tool count must stay under 20 (`mcp/tools.test.mjs`, `server.test.mjs`); today 18; the specs add 17 tools | all with MCP | F0 adds an opt-in `options` toolset; all Phase 1 tools go there |
| C11 | Feed-slot budget: recorder 60 % and alerts 15 %, while P1-1 and P1-4 promised users ≥ 40 % | P1-1, P1-4, P1-11 | Alerts count only symbols the recorder does not already hold. Background ceiling 75 %; users keep ≥ 25 % worst case, ≥ 40 % without alerts. Texts corrected |
| C12 | REST background budget enforced four different ways (recorder limiter, vol "≤ budgetShare", fno headroom gate, alerts headroom floor) | P1-1, P1-3, P1-6, P1-8, P1-11 | One check, `ratelimit/backgroundGate.mjs` (F0). The recorder keeps its stricter limiter on top |
| C13 | P1-6 reads `/v1/options/snapshots/latest?date=prev`, a parameter P1-1 does not have | P1-1, P1-6 | P1-6 reads the previous day through the recorder store (REST equivalent: `/v1/options/snapshots` with a previous-day range) |
| C14 | Demo underlyings: P1-1 adds FINNIFTY/MIDCPNIFTY, P1-3 says they are not demo underlyings; P1-1 "five stocks with fixture lots" vs P1-6 "all 50 with a formula" | P1-1, P1-2, P1-3, P1-6 | FINNIFTY/MIDCPNIFTY are demo underlyings (BANKEX stays absent). One demo lot table, `DEMO_STOCK_LOT`, owned by P1-2a |
| C15 | Demo `bidQty`/`askQty` and time-varying OI specified twice, conditionally (P1-1 and P1-4) | P1-1, P1-4 | Built once in P1-1a; P1-4 only routes them into feed ticks |
| C16 | Brokerage and charges: P1-2 removes `brokeragePerOrder`, but P1-10 kept `CHARGE_RATES.brokeragePerOrder` and a `statutory-fallback.json` copy; the 2 % expiry-day ELM rate stored in both P1-6 `charges.json` and P1-10 `rules.json` | P1-2, P1-6, P1-10 | Fallbacks are P1-2's `REF_DEFAULTS` / `reference/defaults.mjs`; the global brokerage layer of `chargePlans` is `reference.charges().brokerage`; the ELM rate lives only in `charges.json`, and P1-10's rule row reads it |
| C17 | Settlement window configured in two places (P1-3 `vol.clock`, P1-8 `exposure.settlementWindowMinutes`) | P1-3, P1-8 | Only `vol.clock.settlementWindowMinutes` |
| C18 | Wrong dependency order: specs written as if the recorder came before the calendar and pricing core; P1-3 assumed P1-2's dashboard step had already removed `RATE` | P1-1, P1-3 | Order in §4. `pricing.js` takes `rate` as a parameter, so P1-3a can land before P1-2b |
| C19 | Duplicated plumbing in every spec: append-only JSONL with torn-line tolerance and corrupt-file quarantine; demo-only route file and OpenAPI exclusion list ("create it if P1-4 has not landed"); ownership helpers; banned-word lists | P1-1, P1-3, P1-4, P1-5, P1-6, P1-8, P1-9, P1-10, P1-11, P1-12 | Built once in F0 (§3) |

---

## 3. Shared foundations (F0) and shared-module owners

### 3.1 F0: one lead-owned session before any spec

| Piece | What | Why one place |
|---|---|---|
| Stream table | `docs/STREAMS.md` rows S16–S27 (§1.1); `docs/ARCHITECTURE.md` module map placeholders | C1 |
| Bus topics | Add to `core/eventBus.mjs` TOPICS at once: `recorder.status`, `recorder.snapshot`, `reference.updated`, `vol.captured`, `trading.readiness`, `fno.sweep.progress`, `fno.sweep.completed`, `exposure.levels`, `settlement.update`, `charges.plan_changed`, `option.alert`, `strategy.guard`, `participants.updated` | TOPICS is a closed list, and every spec edits it; one edit avoids twelve merge conflicts |
| Error codes | Add to `core/errors.mjs`: `CAPACITY_EXCEEDED` 422, `CANNOT_TRADE` 403, `ALERT_LIMIT` 422, `AUTOMATION_NOT_ALLOWED` 403, `STATE_CONFLICT` 409 (plus the OpenAPI Problem code list) | same |
| Sources and principals | `core/context.mjs` `Source` += `guard`, `alert`; principal kind `guard`; config `live.allowedSources` enum += `guard`, `alert` (additive) | P1-5 and P1-12 both edit these |
| `core/ownership.mjs` | `seesAll`/`owns` moved from `scanner/routes.mjs` (scanner imports it) | alerts, guards and future rule stores share it |
| MCP `options` toolset | `mcp/config.mjs` `TOOLSETS` += `options` (not in `DEFAULT_TOOLSETS`); `tools.test.mjs` keeps "default < 20" and adds "`options` toolset ≤ 19 tools"; write tools in it (`create_guard`) still need `paper` scope | C10 |
| Demo routes | `server/bridge/demo/routes.mjs` (registered only when `config.demo`), the `x-demo-only: true` OpenAPI flag and the demo-only exclusion list in `core/openapi.test.mjs` | P1-4, P1-5, P1-11, P1-12 each said "create it if not there" |
| `server/lib/jsonl.mjs` | `appendLine` (repairs a missing final newline first), `readLines` (skips and counts a torn last line), `lastWinsIndex(key)`, `compact` through `writeFileAtomic`, `quarantine(file)` (rename to `*.corrupt-<ts>`), dated-file retention | Every new store (recorder, vol, exposure, alerts, guards, participants, fno, margin calibration, readiness, strategy) needs exactly this, and BRD §7.7 requires it |
| `ratelimit/backgroundGate.mjs` | `allow(accountId, endpointClass, { share = 0.5, cost = 1 })`: true only if, for every window covering the class, `remaining − cost ≥ ceil((1 − share) × limit)`; plus `waitMs()` | C12. Users always go first, and the 50 % ceiling (BRD §7.2) is one rule, not five |
| `dashboard/copyRules.mjs` | The one banned-word list (`recommend, best, buy, sell, rich, cheap, safe, avoid, opportunity, signal, bullish, bearish, support, resistance`) and a test helper with per-file allowlists for order-side controls | Every spec greps its own slightly different list today |
| Shared-module test | `dashboard/sharedModules.test.mjs`: every file listed as shared (pricing, oi-series, marks, scenario, margin-core, expiry-costs, guard-core, book-core) has no `import` except allowed siblings, no DOM, no `fetch`, no `Date.now`, and is in `DASHBOARD_FILES` | Replaces one ad-hoc "shared" test per spec |

**F0 acceptance check:** `npx vitest run server/bridge/core server/bridge/mcp server/bridge/ratelimit server/lib` and `node scripts/check-mjs.mjs` green; the new `jsonl.test.mjs` (torn line, newline repair, last-wins, quarantine) and `backgroundGate.test.mjs` (property test: over 10,000 random schedules a background caller never leaves a window below 50 % of its limit) pass; `mcp/tools.test.mjs` still lists 18 default tools; booting `--demo` serves the same routes as before.

### 3.2 Shared-module owners (build once, then extend)

| Module | Created by | Extended or used by |
|---|---|---|
| `dashboard/pricing.js` (Black-76, IV, parity forward, vol-time clock, cm30, ranks, HV) | P1-3a | everyone that prices: P1-1, P1-4, P1-6, P1-7, P1-8, P1-9, P1-11, P1-12 |
| `vol/context.mjs` (server clock context from `reference`) | P1-3a | `market/chain.mjs`, recorder, exposure, strategy |
| `dashboard/oi-series.js` (PCR, max pain, largest OI) | P1-1a | P1-7 (buckets, VWAP, build-up), P1-11 |
| `dashboard/ts-chart.js` (line with gaps, small multiples, table, CSV) | P1-3c | P1-7 (bars, step lines, class strip), P1-13a |
| `dashboard/marks.js` (`legMark`, `strategyPnl`) | P1-11a | P1-12 `guard-core.js` |
| `dashboard/scenario.js` (strategy engine) | P1-9a | P1-11 (multi-expiry marks), P1-10 (optional) |
| `reference/nseArchives.mjs` (consented archive client) | P1-2a | P1-3c back-fill, P1-13a participants |
| `reference/data/charges.json` + `REF_DEFAULTS` | P1-2a | P1-6 adds `physical` and `margin` rows; P1-10 reads them |
| `DEMO_STOCK_LOT` (`reference/demoReference.mjs`) | P1-2a | P1-1 (five stocks), P1-6 (all 50) |
| Demo OI model (`demo/demoAdapter.mjs openInterest`) | P1-1a (time factor) | P1-7a (day-story factor), P1-8a (writer-structured base). Composition: `base(P1-8) × time(P1-1) × story(P1-7)`, rounded to whole lots once at the end. Each step updates demo tests that assert exact OI |

### 3.3 Cross-cutting rules every step follows

- **Feed slots.** Recorder ≤ 60 % of the feed account's cap; alerts ≤ 15 % more, counted only for symbols not already held. Pages keep the rest. Chain views, guards and the settlement capture subscribe through the hub and share slots by reference counting.
- **REST background work** (recorder REST source, vol capture and snapshot, fno sweep, exposure REST fallback, alerts poll, readiness probe) calls `backgroundGate.allow()` before each scheduled call, at `priority: "background"`.
- **One data account per holder.** The recorder's `recorder.account` is the default data account; `vol.account` and the exposure REST fallback default to it; nothing ever pools across holders (BRD §8.3).
- **Order ticket gates** compose in this order, each independent, and Place stays disabled until all pass: readiness line and kill switch (P1-5, server preview), ban (P1-6), lot-size confirmation when stale (P1-2), stale-price confirmation (P1-4), margin check (P1-10). The server checks stay authoritative.
- **Neutral copy** through `copyRules.mjs`; "wall" names only P1-8's gamma levels.

---

## 4. Build order

One row is one engineer session. "Tasks" refers to the task list in that spec. With three engineers, any rows whose "Needs" are done can run in parallel; the order shown is the critical path for one engineer.

| Step | Spec (part) | Tasks | Goal | Needs | Acceptance check (done when) |
|---|---|---|---|---|---|
| 0 | `docs/spec/README.md` §3.1 (F0) | — | Shared foundations: stream table, topics, error codes, `options` MCP toolset, demo routes, `jsonl.mjs`, `backgroundGate.mjs`, `ownership.mjs`, `copyRules.mjs` | — | §3.1 check |
| 1 | `docs/spec/p1-02-reference.md` (P1-2a) | 1–9 | Reference store, calendar, NSE archive client, demo provider, consumers (market rate, safety holidays, scanner, paper, `LOT_SIZE_STALE`), MCP | 0 | §9.1–9.3 server tests green; demo: `/v1/reference/bundle?underlying=NIFTY` gives lot 65 and the 6.50 % "default, not sourced" rate; `POST /v1/reference/corporate-actions/preview` example 1 gives strikes 1,400/1,410 and lot 500 (AC5); with archives off, zero fetch calls |
| 2 | `docs/spec/p1-03-pricing-vol.md` (P1-3a) | 1, 2, 4, 5 | One pricing core and vol-time clock; `/v1/optionchain?ivModel=b76-forward`; demo prices on the clock | 1 | `pricing.test.mjs` §6.1 examples 1–4 (Fri→Mon, long weekend, expiry day 14:00/15:00/15:20) exact; `agreement.test.mjs` server vs dashboard ATM IV ≤ 0.05 vol pts (AC2); legacy `ivModel` byte-for-byte; `pricing.shared.test.mjs` |
| 3 | `docs/spec/p1-01-recorder.md` (P1-1a) | T1–T13 | Server recorder S1/S3 with the browser closed, budget, planner, OI units, REST/MCP, demo realism and back-fill | 1, 2 | `priority.test.mjs` (user chain ≤ 200 ms delay), `budget.test.mjs` property test (≤ 50 %), `plan.test.mjs` (§5.2 rows; doc table = generated), `oiUnits.contract.test.mjs`, restart writes `bridge-down` gaps and resumes ≤ 1 min; e2e steps 1–5 via API |
| 4 | `docs/spec/p1-01-recorder.md` (P1-1b) | T14–T16 | Data recorder page, OI page windows from the server, docs | 3 | `recorder.e2e.test.mjs` green; `#/recorder` works at 360/800/1280 px in demo; OI page 15m and Since-open windows read "Recorded by the Bridge" |
| 5 | `docs/spec/p1-05-readiness.md` (P1-5a) | T1–T13 | Readiness monitor, automated-send gate (`CANNOT_TRADE`), hooks, notify, security baseline tests | 0 (1 for holidays) | `readiness.e2e.test.mjs` steps 1–6: session expiry or IP change → `cannot_trade` ≤ 300 s, webhook refused, stub `placeOrder` count 0; T-sec-1…8 green |
| 6 | `docs/spec/p1-05-readiness.md` (P1-5b) | T14–T16 | Toolbar badge, Safety card, `doctor` checks, `deployment.md` | 5 | `readiness.test.mjs` view-model green; badge screenshots at 360/768/1440 px in demo; `docs/guides/deployment.md` present |
| 7 | `docs/spec/p1-02-reference.md` (P1-2b) | 10–15 | Dashboard: `reference.js`, constant removal, chip, banners, ticket lot gate, Market calendar page | 1 | `noConstants.test.mjs` green (AC2); `reference.e2e.test.mjs` incl. stale lots → `LOT_SIZE_STALE` and `lotSizeConfirmed` clears it (AC4); banner within 7 days in demo (AC3) |
| 8 | `docs/spec/p1-03-pricing-vol.md` (P1-3b) | 3, 6, 7, 8 | Client clock everywhere; 15:25 S2 capture (from the recorder), store, read routes, demo 300-day seed | 2, 3, 7 | `volService.test.mjs`: capture at close − 5, retry close + 5, missed rows (AC3); `routes.test.mjs`; demo `/v1/vol/rank?underlying=NIFTY` has three lookbacks and `demoPartial=1` shows "34 of 252" |
| 9 | `docs/spec/p1-03-pricing-vol.md` (P1-3c) | 9–14 | Bhavcopy/VIX back-fill, MCP `get_vol`, Volatility page (IVR tile, VIX, history with `ts-chart.js`), chain strip, ticket, screener columns | 8 | Parser and job tests (AC4); `vol.e2e.test.mjs`; IVR/IVP replace "Unavailable" on vol page, strip, screener, ticket (AC5); history panel fallback with roll markers (AC6) |
| 10 | `docs/spec/p1-04-streaming.md` (P1-4a) | T1–T7 | `ChainLeg` qty/ts, server chain views, `subscribe_chain`, stats, demo feed and stall route | 3 | `chainView.test.mjs`, `protocol.test.mjs`; `stream-chain.e2e.test.mjs` steps 1–6 (unsubscribe gone from `/v1/stream/stats` ≤ 1 s) |
| 11 | `docs/spec/p1-04-streaming.md` (P1-4b) | T8–T16 | Chain and positions pages stream-first, fallback, dimming, depth, ticket stale-price gate, perf probe | 10 | §10.4 manual protocol: tick-to-paint p95 ≤ 250 ms with 160 legs, no long task > 50 ms; demo stall → "Polling 3 s" at ~5 s → "Live"; full e2e |
| 12 | `docs/spec/p1-06-stocks.md` (P1-6a) | 1–8 | F&O universe API, chain facts, ban gate, expiry and delivery maths, server sweep | 1, 7 | `plan.test.mjs` (§6.9 rows), `load.test.mjs`, ban flow tests (§6.8 table), `expiry-costs.test.mjs` (₹842.22 / ₹55.96 / ₹31.40); e2e steps 1–6 by API |
| 13 | `docs/spec/p1-06-stocks.md` (P1-6b) | 9–15 | Picker, `formatStrike`, warnings by kind, positions delivery panel, screener on the server sweep, renames | 12 | `noLiteralRates.test.mjs` (AC4), `screens.test.mjs` banned-word scan (AC5), `strikeFormat.test.mjs`; `stocks.e2e.test.mjs` green |
| 14 | `docs/spec/p1-12-guard-participants.md` (P1-13a participants) | 1 (contract only), 8–12 | Store S4: NSE participant OI fetch, 2-year back-fill, page, API, MCP, demo | 1 | Parser and metrics tests (§7.10–7.11); `participants.e2e.test.mjs`; `deps.participants.latest({ exchange: "NSE" })` returns the shape `p1-08` §3.5 reads |
| 15 | `docs/spec/p1-07-oi-straddle-charts.md` (P1-7a) | T1–T8 | Series maths in `oi-series.js`, derived lines, series API, MCP, demo stories | 4, 9 | `oi-series.test.mjs` (all §5 examples), `perf.test.mjs` every route ≤ 800 ms cold, `series.e2e.test.mjs` steps 1–6 |
| 16 | `docs/spec/p1-07-oi-straddle-charts.md` (P1-7b) | T9–T15 | Live charts page, OI page timeline, straddle chain view | 15 | Charts page at 360/800/1280 px in demo; `straddle-chain.test.mjs` (IV 11.69 %); e2e step 7 |
| 17 | `docs/spec/p1-08-exposure.md` (P1-8a) | T1–T11 | Exposure profile, levels, sign models, participant scale, daily history, API, MCP, demo | 3, 8, 14 | Fixture: per-strike GEX within 0.5 %, zero-gamma within 0.1 % of the forward (AC6); `priority.test.mjs`; `/v1/options/levels?days=10` in demo with one missing day |
| 18 | `docs/spec/p1-08-exposure.md` (P1-8b) | T12–T16 | Exposure page, chain level markers, payoff rules, OI-tag renames | 17 | `exposure.test.mjs` copy test (AC7); `exposure.e2e.test.mjs`; levels on chain, payoff and strip in demo (AC5) |
| 19 | `docs/spec/p1-09-multi-expiry.md` (P1-9a) | 1–8 | `scenario.js`, `/v1/strategy/analyze`, expected move, settlement estimate service, demo replay | 8 (17 soft) | `scenario.test.mjs` example A; `perf.test.mjs` 10 legs × 25 × 20 ≤ 30 ms (AC6); demo settlement fixtures pass; real-fixture test skipped with the AC-open message |
| 20 | `docs/spec/p1-09-multi-expiry.md` (P1-9b) | 9–14 | Multi-expiry builder, grid and slices tabs, bands and EAM on payoff and chain, settlement pill | 19, 7 | Grid and slices tests; `strategy.e2e.test.mjs`; calendar preset values later legs at their IV (AC1) |
| 21 | `docs/spec/p1-10-margin-checks.md` (P1-10a) | 1–12 | Basket margin capability and service, rule-aware check, F9 sequence, charge plans, paper fills on plans, demo | 5, 12 | `rejections.test.mjs` ≥ 18 of 20 flagged (AC4); basket ≤ 1 s p95 with 5 s cache (AC2); plan tests for ₹0, ₹20 flat and % with cap (AC5) |
| 22 | `docs/spec/p1-10-margin-checks.md` (P1-10b) | 13–17 | Builder, placement sheet, ticket and positions checks, plan editor, MCP, compat | 21 | `margin.e2e.test.mjs`; "broker figure at HH:MM:SS" within 1 s of the last leg change in demo |
| 23 | `docs/spec/p1-11-alerts.md` (P1-11a) | T1–T11 | Alert engine, 12 condition kinds, stream/recorder/poll paths, S7 store, notify, stream op, MCP, demo samples; shared `marks.js` | 3, 8 (17, 19 soft) | `alerts.e2e.test.mjs`: streamed p95 ≤ 5 s, recorder-only ≤ 70 s; cap 500; restart never re-fires; notify messages carry no ids |
| 24 | `docs/spec/p1-11-alerts.md` (P1-11b) | T12–T16 | Alerts page, form, bell, entry points | 23 | Form creates every metric in demo at three widths; ≥ 10 condition kinds fire end to end (Phase 1 exit) |
| 25 | `docs/spec/p1-12-guard-participants.md` (P1-13b book) | 2–7 | Holder tags, family gate, `/v1/book`, positions All accounts / Family | 2 | `family.test.mjs`; pricing-wall test (every `marketData` call pinned to the holder's own account); `book.e2e.test.mjs` |
| 26 | `docs/spec/p1-12-guard-participants.md` (P1-12a guards server) | 13–23 | Guard engine, states (blind, cannot trade, disarmed), prepared exit with F9 order, exit runner, audit, demo | 21, 23, 25 | `guards.e2e.test.mjs` scenarios 1–5 and 7 (paper); "cannot trade" never attempts an order; `noOrders` grep test |
| 27 | `docs/spec/p1-12-guard-participants.md` (P1-12b guards UI and live path) | 24–28 | Guards page, positions hooks, banner and deep link, live gates, docs | 26 | e2e scenario 6 (live with fake broker, typed confirmation); guide pages; `doctor` checks |

### 4.1 Phase 1 exit (after step 27)

Run the BRD §6.1 exit list as one review: every Options page has a time axis (steps 4, 9, 16, 18); IVR/IVP live (step 9); stocks within the feasible set (step 13); broker margin for the 3 wired brokers with per-leg sequence checks (step 22); ≥ 10 alert conditions and guards showing "cannot trade" in the readiness test (steps 24, 26); no pricing constant left (`noConstants` + `noLiteralRates`, steps 7 and 13); no polling on chain or positions in market hours (step 11).
