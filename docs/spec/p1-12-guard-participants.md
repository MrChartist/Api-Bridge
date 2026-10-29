# Spec P1-12 + P1-13: Strategy guard, participant OI and the unified positions book (H2, J1, S4, F2, F11)

Status: ready to build in three sessions (`docs/spec/README.md`): **participants** (P1-13a) needs only P1-2a and lands **before P1-8**, which reads it; **book and family gate** (P1-13b) and **guards** (P1-12) land after P1-5, P1-10 and P1-11 (§1.4) · Owner: tech lead, Options desk · Date: 29 Oct 2026
Streams (final ids from the stream table in `docs/spec/README.md`):
- **S25 "Guards"**: `server/bridge/guards/` (P1-12).
- **S26 "Participants"**: `server/bridge/participants/` (P1-13, store S4).
- **S27 "Book"**: `server/bridge/book/` (P1-13, F2/F11).

BRD: `docs/brd/options-platform.md` §2 (persona M), §3.D/§3.F/§3.H/§3.J rows H2, H5, F2, F9, F11, J1, §4 items 5 and 6, §5.1–§5.6 (stores S4 and S7, the alert evaluator, the API list), §6.1 P1-12 and P1-13 (acceptance criteria), the Phase 1 cross-cutting list, §7.1–§7.9, §8.1–§8.4 and §9.2.

These are the last two Phase 1 builds. They share one spec because they share one idea: **automation and aggregation that stay per account and per holder**. The guard acts on one account. The book shows many accounts but never acts across them. The family definition (F11) decides which accounts automation may touch.

> **Not legal or market advice.** Every exchange rule, archive URL, file layout and broker behaviour below that comes from outside this repo is marked **needs verification**. A row marked that way ships with `verified: false`. It can show or warn, but it never blocks an order or arms live automation until a person has checked the primary source (§9.3).

> **Styling.** Another team is restyling the dashboard (near-black theme, colour tokens, motion). This spec names panels, classes, `data-*` states and interactions only. It uses existing components (`card`, `table`, `pill`, `modal`, `sheetPopover`, `alertBox`, `emptyState`, `chartSlot`, `segmented`, `toast`) and the shared tokens in `app.css`/`palette.css` (`--pos`, `--neg`, `--warn`, `--ios-red`, `--ios-green`, `--foreground` with `--a-quiet`). It adds no colours, sizes, fonts or motion. Each new state attribute gets one CSS rule that reads an existing token.

> **Build order and shared foundations.** This spec is steps 14, 25, 26 and 27 (P1-13a participants; P1-13b book and family gate; P1-12a guards server; P1-12b guards UI and live path; session map in §12) in `docs/spec/README.md`, after P1-13a: P1-2a. Guards: P1-5a, P1-10a, P1-11a, P1-13b. It uses, and does not rebuild, the F0 foundations listed there: final stream ids, bus topics and error codes pre-registered in core, the opt-in `options` MCP toolset (every MCP tool in this spec goes there), `demo/routes.mjs` plus the OpenAPI demo-only list, `server/lib/jsonl.mjs` (append, torn-line tolerance, last-wins, quarantine of corrupt files), `ratelimit/backgroundGate.mjs` (the one ≤ 50 % background-budget check), `core/ownership.mjs`, and `dashboard/copyRules.mjs` (the one banned-word list). Where this text and README disagree, README's build order and shared-module owners win.

---

## 0. Summary

| BRD item | What ships this round | What our data allows |
|---|---|---|
| **P1-12 H2 strategy guard** | A server-side guard per strategy (a set of legs on one account) and per account per day. It supports max loss, target, a trailing lock and a spot-level stop. The default action is a notification with a **prepared exit basket**, shorts first and checked by P1-10's F9 sequence, which one tap sends. Auto-exit is opt-in per guard: allowed in paper, and in live only behind every gate in `docs/guides/safety.md` plus a typed per-guard confirmation and a config switch that is off by default. The guard has three notified non-firing states: **blind**, **cannot trade** and **disarmed**. | The guard runs on the user's computer. It is not a stop order held at the exchange. If the Bridge stops, sleeps or loses its connection, the guard cannot act, and the UI and every notification say so. P&L uses the broker's average price. Brokers define that differently for carried positions, so the entry price is captured when the guard is armed and can be edited. |
| **P1-13 J1/S4 participant OI** | Store S4: NSE's daily `fao_participant_oi` file is fetched at about 19:10 IST with retries until 22:10, plus a resumable 2-year backfill where the archive still has the files. There is a **Participants** page, an API, CSV and an MCP tool. The service `deps.participants` feeds P1-8's participant scale. | NSE publishes this file only; no BSE equivalent was located (**needs verification**). Figures are contracts summed across all strikes and expiries, published after the close. Lot-size and contract-size revisions break like-for-like comparisons, and the history marks them. |
| **P1-13 F2/F11 unified and family book** | `GET /v1/book` returns one book per holder and a family view for holders tagged with a family relationship. Each has per-account tags, combined Greeks per underlying, P&L, and broker-reported margin per account. Positions gains an **All accounts / Family** scope. Every leg keeps its account, and every exit goes to that leg's account. The family gate refuses guards (and, from P1-11, alert actions) on accounts outside the configured family definition. | Holders are pricing walls. One holder's legs are priced only from that holder's own market-data account, or from the paper engine's source for paper-only holders. A holder with no usable data account shows broker-reported P&L but no Greeks, with the reason. Margin is shown per account as each broker reports it. Totals are display sums, labelled "not shared between accounts". |

---

## 1. Scope

### 1.1 MUST (this round)

| # | Item | Acceptance link |
|---|---|---|
| **Guards (S25)** | | |
| G-M1 | Module `server/bridge/guards/` (routes-only, built in `register()` like `scanner`), config section `guards`, store under `dataDir/guards/` | P1-12 all |
| G-M2 | Pure core `dashboard/guard-core.js`, shared by server and browser: leg marks and strategy P&L (imported from P1-11's shared `dashboard/marks.js`, not re-implemented), account-day P&L, rule evaluation (max loss, target, trailing lock, spot stop), confirmation window, blind detection, state precedence, exit basket, exit prices | AC1, AC2, AC4 |
| G-M3 | Engine: a 1 s evaluation loop from in-memory marks (stream first, REST fallback), positions sync every 30 s and on `order.updated`, readiness registration (`readiness.registerAutomation`), state machine and notifications (bus topic `strategy.guard`, notify event) | AC1, AC4 |
| G-M4 | Prepared exit: built on fire (and on demand), checked with `margin.check({ intent: "guardExit" })`, kept 30 min. One-tap send through `POST /v1/guards/{id}/fires/{fireId}/exit` | AC2 |
| G-M5 | Exit runner: sequential legs in the margin-covered order, idempotent (`fireId` keys), waits for each fill, one re-price, halts rather than leaving a short naked, cancels open orders on the exit symbols first | AC2, AC3, AC5 |
| G-M6 | Auto-exit in paper (opt-in per guard); auto-exit in live behind §9.1's eight gates, including config `guards.autoExit.live` (default `false`) and the typed `confirmLive` phrase | AC3 |
| G-M7 | Audit: `guard.created/updated/armed/disarmed/deleted/fired/exit_order/exit_done/exit_halted` with guard id, conditions and fire id | AC5 |
| G-M8 | Routes, OpenAPI, MCP (`list_guards` read; `create_guard` paper scope, notify only) | §5.6, §7.8 |
| G-M9 | Dashboard: Guards page (`#/guards`), "Guard…" on Positions expiry groups and on the account-day strip, "Add a guard" after a Builder placement, an app-wide fired banner, deep links | AC2 |
| G-M10 | Demo: a stable sample position, demo price shock, blind and cannot-trade scenarios (`POST /v1/demo/guards`), a seeded sample guard, and "Would have been sent" messages | demo realism |
| **Participants (S26)** | | |
| P-M1 | Module `server/bridge/participants/` with contract service `participants` (`latest`, `series`, `status`, `sync`), config section `participants`, store S4 under `dataDir/participants/` | P1-13 AC1 |
| P-M2 | Pure parser for the published layout (title line, header, CLIENT/DII/FII/PRO/TOTAL) with total-balance validation; pure metrics (net, long %, day-on-day change, share of OI) | AC1 |
| P-M3 | Scheduler: 19:10 IST fetch, retry every 30 min until 22:10, 08:40 catch-up; backfill for 500 trading days at one file per 6 s outside market hours, resumable; 404 recorded as "no file" | AC1 |
| P-M4 | Routes `GET /v1/participants/oi`, `/oi/summary`, `/status`, `POST /v1/participants/sync`; CSV; MCP `get_participant_oi` | AC1, §7.8 |
| P-M5 | Dashboard: Participants page (`#/participants`); a one-line tile on the OI page | AC1 |
| P-M6 | Demo: deterministic 2-year history with balanced totals, consistent with P1-8's demo CE/PE rows | demo |
| **Book (S27)** | | |
| B-M1 | Module `server/bridge/book/` (routes-only), config section `book`, holder tags in `dataDir/book/holders.json` | P1-13 AC2, AC3 |
| B-M2 | Family gate `book/family.mjs` (pure): relationship per holder, family membership, `automationAllowed(accountId)` with the reason; used by guards and exported for P1-11 | AC3 |
| B-M3 | `GET /v1/book` (holders and family views), `GET /v1/book/holders`, `PUT /v1/book/holders/{holder}`; per-holder pricing wall; pure aggregation in `dashboard/book-core.js` | AC2 |
| B-M4 | Positions page scope switch: This account / All accounts / Family; exits always per leg account | AC2 |
| B-M5 | Demo: holders `demo` (self), `demo-spouse` (spouse) and `demo-other` (other) across three paper accounts, with a seeded book | demo |
| **Shared** | | |
| X-M1 | Core changes landed by the lead (§2.2): config `live.allowedSources` += `"guard"`, principal kind `"guard"`, topics, notify event, error codes, contract `participants`, `DASHBOARD_FILES` | — |
| X-M2 | Docs: `docs/guides/guards.md`, `docs/guides/participants.md`, `docs/guides/family-book.md`, `safety.md`, `compliance.md`, `notifications.md`, ARCHITECTURE (modules, data layout), STREAMS (S25–S27), `bridge.config.example.json`, CHANGELOG | cross-cutting |
| X-M3 | K3 glossary hovers, K5 CSV export on every new panel, and the K7 OpenAPI diff check | cross-cutting |

### 1.2 LATER (named so nobody builds it now)

| Item | Why later | Goes with |
|---|---|---|
| Per-holder guards (one loss limit across a holder's several accounts) | An exit would span accounts. Each exit stays per account, but "who fires first" and partial-failure semantics need their own design. F11's "per-holder limits" is not in the P1-13 acceptance criteria. | P2 (F6 book risk) |
| Engaging the kill switch after a day guard fires ("stop trading for the day") | The kill switch is global, not per account; a per-account lock is a safety change | P2 with H3 |
| Broker-native P&L exits and resting SL orders at the broker (Dhan P&L Exit, bracket/OCO) | Adapter layer is frozen; G6 is P2 | P2 G6 |
| Alert → guard combinations and a guard condition builder (AND/OR) | P1-11 owns conditions; H3 is P2 | P2 H3 |
| Guard on stock options with physical settlement awareness (E-n rules) | P1-6 warnings exist; exit timing on E-1 needs its own rule | P2 |
| Streaming the book (`positions` channel) | P1-4 streams the single-account positions page; the book polls every 15 s | P2 |
| FII/DII **cash** file and the participant **volume** file (J2) | Not in the P1-13 AC; S4 schema leaves room (`instrument` enum is open) | P2 J2 |
| BSE participant OI | No BSE file located (**needs verification**) | — |
| Family refusal for **live webhooks** (hooks are automation too) | Not named in the AC. This round `mc-bridge doctor` warns about a live hook on an account outside the family. | P2 |
| Compat `/api/v1` and Sheets parity for the new reads | §7.8 parity; MCP and CSV ship now | next round |
| Participant OI history chart in the owner's chart engine | Chart engine not landed; `chartSlot` with an SVG sparkline and a table ships now | §10.1 chart policy |

### 1.3 Honest fallbacks (where the acceptance criteria meet our data)

| Limitation | Why | What this spec does |
|---|---|---|
| **The guard is not an exchange stop** | It runs in the Bridge process on the user's computer, priced from the user's broker feed | Every guard card, the create sheet and every notification carry: "This guard runs on this computer. If the Bridge stops, sleeps or loses its connection, it cannot act. For a hard stop, also place a stop-loss order at your broker." A heartbeat records gaps, and on restart the user is told "Guards were not running from 10:12 to 10:31" (§3.5). |
| **Entry price semantics differ by broker** | Some brokers report the previous close as `avgPrice` for carried positions; others report the buy average (**needs verification** per broker) | `entryAvg` per leg is captured at arm from `avgPrice`. The create sheet shows it and lets the user edit it ("your fill price"). The Builder fills it from actual fills. The method note names the source. |
| **Account-day P&L is the broker's day P&L** | Same definition as the existing daily-loss read (`orderService` "realised plus open mark-to-market") | Day P&L = Σ realised today + Σ q·(mark − avg) over F&O positions. The note says it follows the broker's average price for carried positions. |
| **"No prices for over 30 s" vs a quiet contract** | A far wing may not tick for minutes while the feed is healthy | **Blind** means no fresh *source*, not no new price. A leg is fresh while the stream reports it live and its upstream is `up` (P1-4 stall detection), or its last successful REST quote is ≤ 30 s old. A quiet leg on a healthy stream is not blind (§7.6). |
| **Gaps and slippage** | A guard reacts after the condition is seen, and exits fill at market prices | Exit limits are at the touch ± 2 ticks, with one re-price. The fire record shows expected vs realised P&L. Copy never says "limits your loss to"; it says "acts when the loss reaches". |
| **F9 needs P1-10** | `margin.check` lives in P1-10 | If `deps.margin` is a stub, the exit uses `exitPlan`'s shorts-first order (`options.js`). The basket shows "margin after each leg not checked (P1-10 not available)", and live auto-exit is refused, because the BRD says "checked by F9". |
| **"Cannot trade" needs P1-5** | `readiness` lives in P1-5 | If `deps.readiness` is a stub, paper guards work; live guards can be created in notify mode only, with "Trading readiness is not available on this Bridge; live one-tap and auto-exit are off". |
| **Participant file is NSE-only, aggregated, contracts, T+0 evening** | NSE publishes one CSV per day after the close (**needs verification**: URL, time, columns) | Every panel and response says "NSE only; summed over all strikes and expiries; number of contracts; for the trading day ended {date}". SENSEX/BANKEX pages link here with "No BSE participant file". |
| **Contract counts are not comparable across lot revisions** | The same rupee exposure is a different number of contracts after a lot change (for example Jan 2026), and after the Nov 2024 contract-size rule | History rows carry `lotRegime` from P1-2's lot history (or a shipped list of revision dates). Charts draw a vertical rule at each revision with "contract size changed; counts before and after are not like for like". Long % and shares are ratios and stay comparable. |
| **Backfill depth is unknown** | NSE archives may not keep 2 years at the same URL (**needs verification**) | Backfill tries each URL template. A 404 is recorded as `noFile` and never retried more than twice. Status shows "History: 487 of 500 trading days; 13 not available from NSE". |
| **NSE archive downloads are opt-in** | P1-2 keeps `reference.sources.nseArchives.enabled` off on a fresh install (BRD §8.1, §8.3) | The participants module obeys that switch. When it is off, the page shows "Turn on NSE archive downloads (Market calendar page) to fetch participant OI". Nothing is fetched. Demo is unaffected. |
| **The family definition itself** | The algo framework's family definition (self, spouse, dependent children, dependent parents) is **needs verification**; HUF is unclear | The relationship list lives in config with that default. `huf` exists as a tag but is outside the default family, and the docs say why. The owner decides (OQ1). |
| **"Never pools data across holders" vs a family view** | A family total is a sum across holders | Interpretation (OQ3): data is never *fetched* through another holder's account. Each holder is priced from that holder's own sources, and the family view only adds the per-holder results on this computer for the operator. Orders never span accounts. |
| **Greeks for a holder without a data account** | Pricing walls (row above) | Broker-reported `ltp` and `pnl` are shown, and Greeks show "—" with "No market-data account for {holder}; Greeks need spot and IV from that holder's own data". |
| **Broker margin definitions differ** | `usedMargin` and `availableCash` mean slightly different things per broker (**needs verification**) | Shown per account "as reported by {broker} at HH:MM:SS". Sums are labelled "sum of separate accounts; margin is not shared between accounts". |

### 1.4 Dependencies

| Spec | Kind | What we use | If absent |
|---|---|---|---|
| **P1-5** readiness | **Hard for live guards**, soft at runtime | `readiness.registerAutomation`, `canTrade`, `ensureFresh`; `CANNOT_TRADE`; `AUTOMATED_SOURCES` includes `"guard"` | Paper guards work. Live guards are notify-only, and the UI says why. |
| **P1-10** margin | **Hard for any live exit**, soft for paper | `margin.check({ intent: "guardExit" })`, `sequence.covered.order`; `margin-core.js sendOrderFor` | Shorts-first order from `options.js exitPlan`, with "not checked" shown. Live one-tap and auto-exit are refused. |
| **P1-2** reference | Hard for real participant data; soft otherwise | `reference/nseArchives.mjs` client and the `nseArchives.enabled` switch; `reference.session()` / `calendar()`; lot history for `lotRegime` | Participants: `SOURCE_UNAVAILABLE` in real mode (demo works). Guards: `lib/marketHours.mjs` session. `lotRegime`: shipped `participants/data/lot-revisions.json` |
| **P1-4** streaming | Soft | Stream freshness (`isLive`, upstream `state`), leg `ts`, `POST /v1/demo/feed` | REST quote polling (3 s) for every guard leg; blindness from REST age only |
| P1-3 pricing | Hard (lands earlier) | `dashboard/pricing.js` (vol-time clock, forward) for book Greeks | — |
| P1-8 exposure | Consumer (built **after** the participants part of this spec) | `deps.participants.latest({ exchange: "NSE" })` (shape fixed in §4.2.1) | — |
| P1-11 alerts | Sibling consumer | `book/family.mjs automationAllowed`; `guard-core.js strategyPnl` for the "strategy P&L" condition; shared notify formatting | — |

Build order (see `docs/spec/README.md`): **participants first, as its own session before P1-8** (tasks 1-participants-part and 8–12; it needs only P1-2a's archive client), then **book and family gate** (tasks 2–7), then **guards** (tasks 13–28; guards need the gate, P1-5, P1-10 and P1-11's `marks.js`).

---

## 2. Architecture

### 2.1 Module map (new files)

```
server/bridge/guards/
  module.mjs          defineModule({ name: "guards", stream: "S25", configKey: "guards", register, start, stop }) + ROUTES;
                      routes-only: the engine is built in register() (it reads orders, marketData, streamHub, safety, audit,
                      readiness, margin, reference, accounts), exported through guardsFor(deps) for MCP and tests
  config.mjs          GUARDS_CONFIG_SCHEMA (zod .strict()), defaults (§2.6)
  schema.mjs          zod: GuardInput, GuardPatch, ExitRequest; normaliseGuard()
  store.mjs           guards.json (atomic), fires/YYYY-MM-DD.jsonl (append), state.json (heartbeat); corrupt → renamed, fresh
  feeds.mjs           marks: streamHub subscription ("guards" client), REST fallback batches per data account, freshness per symbol
  positionsSync.mjs   per guarded account: positions every positionsSeconds and on order.updated (debounced 2 s); leg reconciliation
  engine.mjs          createGuardEngine(deps, { clock, timers, demo }): evaluation loop, states, fires, notifications, readiness hooks
  exitRunner.mjs      sequential, idempotent exit (cancel open orders, legs in order, wait for fill, re-price once, halt rule)
  gates.mjs           pure: canCreate(), canAutoExitLive(), canOneTap() → { ok, code, message } (the §9.1 gates in one place)
  notify.mjs          pure: messageFor(event) (no account ids unless configured); dedupe and cooldown
  routes.mjs          handlers (§4.1)
  demoGuards.mjs      demo seeding, scenarios and the "Would have been sent" ring (§5)
  testkit.mjs         fakeGuardDeps() for P1-11 and e2e
server/bridge/participants/
  module.mjs          defineModule({ name: "participants", stream: "S26", configKey: "participants",
                      services: { participants }, register, start, stop }) + ROUTES
  config.mjs          PARTICIPANTS_CONFIG_SCHEMA
  parser.mjs          pure: parseParticipantOi(csvText) → { date, rows, total, warnings }; validateTotals()
  metrics.mjs         pure: summary(day, prevDay), longPct(), shareOfOi(), seriesFor()
  fetcher.mjs         uses reference/nseArchives.mjs: url templates, gap, 404 → noFile, sha256, raw copy
  store.mjs           oi/<YYYY>.jsonl (one line per date; last wins), state.json, raw/<date>/; retention
  service.mjs         createParticipantsService(deps): contract methods, scheduler, backfill queue
  demo.mjs            deterministic generator (§5.3)
  routes.mjs
  data/lot-revisions.json   shipped dates when index/stock contract sizes changed (needs verification), used when P1-2 is absent
  __fixtures__/fao_participant_oi_28102026.csv, …_bad-totals.csv, …_extra-blank-lines.csv, …_old-header.csv  (illustrative)
server/bridge/book/
  module.mjs          defineModule({ name: "book", stream: "S27", configKey: "book", register }) + ROUTES; bookFor(deps)
  config.mjs          BOOK_CONFIG_SCHEMA
  family.mjs          pure: holderOf(), relationshipOf(), inFamily(), automationAllowed(config, tags, accountId) → { ok, code, reason }
  holderStore.mjs     holders.json read/write (atomic), loadHolderTags(paths) (sync read, cached by mtime; P1-11 imports it)
  pricing.mjs         per-holder price source: pinned data account, paper source or none (§3.4)
  bookService.mjs     read({ view, underlying, accounts, ctx }): positions + funds per account (scheduler via OrderService), pricing, aggregation
  routes.mjs
  demoBook.mjs        demo holders and seed (§5.4)
server/bridge/dashboard/
  guard-core.js       pure; server and browser (G-M2)
  guards.js           Guards page, create/edit sheet, fire sheet, banner model
  book-core.js        pure aggregation (per holder, per underlying, family totals, ₹Δ)
  participants.js     Participants page + pure view-model
```

### 2.2 Changed files and owners

| File | Owner | Change |
|---|---|---|
| `core/config.mjs` | lead | `sources` enum += `"guard"` (and `"alert"`, reserved for P1-11). Additive: existing configs still parse. |
| `core/context.mjs` | lead | `Principal` += `{ kind: "guard", id, label }`; `requireAccountAccess` accepts `principal.kind ∈ {"hook","guard"}` with `ctx.hookAccounts` (one-line change); `Source` += `"guard"`. |
| `core/contracts.mjs` | lead | New contract `participants` (§4.2.1). Nothing else (guards and book are routes-only). |
| `core/builtinModules.mjs` | lead | Add `book`, `participants` and `guards` after `readiness`/`margin` (guards last). |
| `core/eventBus.mjs` | lead | Topics `strategy.guard` (§3.3) and `participants.updated` `{ date, source, changed }`. |
| `core/errors.mjs` | lead | `AUTOMATION_NOT_ALLOWED: { status: 403, title: "Automation is not allowed on this account (family definition)", retryable: false }` and `STATE_CONFLICT: { status: 409, title: "The item changed or is busy; read it again", retryable: true }`. |
| `core/app.mjs` | lead | `DASHBOARD_FILES` += `guard-core.js`, `guards.js`, `book-core.js`, `participants.js`. |
| `core/cli.mjs` (`doctor`) | lead | Warn about (a) a live guard whose account lacks `"guard"` in `allowedSources`; (b) `guards.autoExit.live: true` with no notify target listening to `strategy.guard`; (c) a live hook on an account outside the family; (d) a holder with no relationship tag. |
| `orders/modeDecision.mjs` | S7 | `sourceLabel("guard") = "a strategy guard"`. `AUTOMATED_SOURCES` already lists `guard` (P1-5). |
| `notify/config.mjs`, `format.mjs`, `notifier.mjs` | S15 | `NOTIFY_EVENTS` += `"strategy.guard"`; default `events` += `"strategy.guard"`; `wants()` passes only `notify: true`; message format (§6.6). |
| `mcp/tools.mjs` | S11 | `list_guards` (read), `create_guard` (paper scope; `action.kind` fixed to `notify`), `get_participant_oi` (read), `get_book` (read). |
| `demo/demoAdapter.mjs` | demo | Stable sample position (strike fixed at the IST day's open spot); `demoControl.shock({ underlying \| "all", pct, rampMs, ms })` applied inside `spotAt`; `demoControl.quotesDown(ms)`. |
| `demo/demoMode.mjs`, `demo/routes.mjs` | demo | Demo accounts += `demo-paper-spouse`, `demo-paper-other`; `demo-paper` gets `holder: "demo"`; `POST /v1/demo/guards`; `DEMO_ACCOUNT_HINT` text. |
| `dashboard/positions.js`, `strategy-place.js`, `desk.js`, `views.js`, `app.js`, `oi.js`, `index.html`, `app.css` | dashboard | §6 |
| `docs/openapi.yaml`, `docs/ARCHITECTURE.md`, `docs/STREAMS.md`, `docs/guides/*`, `bridge.config.example.json`, `CHANGELOG.md` | lead | §4.4, §11 |

Rules (each is a grep test, §10.1):
- `guards/*` sends orders only through `orders.place/cancel` (never an adapter, never `orderGate.mjs`), reads positions only through `orders.positions`, and never imports `paper/`.
- `book/*` and `participants/*` never import `orders/orderService.mjs` internals or `brokers/orderGate.mjs`, and never call `place`, `modify` or `cancel`.
- `participants/*` makes no broker call at all.

### 2.3 Data model

**Guard** (stored and returned; the API adds the `live` block):

```json
{
  "id": "gd_k3j9x2m1q8wz",
  "name": "NIFTY 3 Nov strangle",
  "account": "zerodha-main",
  "mode": "live",
  "scope": {
    "kind": "strategy",
    "underlying": "NIFTY",
    "legs": [
      { "symbol": "NFO:NIFTY-2026-11-03-25600-CE", "qty": -130, "entryAvg": 82.40, "entrySource": "position-avg" },
      { "symbol": "NFO:NIFTY-2026-11-03-24700-PE", "qty": -130, "entryAvg": 76.10, "entrySource": "user" }
    ]
  },
  "rules": {
    "maxLoss": 4500,
    "target": 6000,
    "trail": { "activateAt": 3000, "lockPct": 50 },
    "spot": { "symbol": "NSE:NIFTY", "below": 24800, "above": 25750 }
  },
  "action": { "kind": "notify", "pricing": "touch" },
  "repeat": "once",
  "armed": true,
  "exitEnabled": true,
  "liveConfirm": null,
  "createdAt": "2026-10-29T10:05:12.410+05:30",
  "createdBy": { "kind": "key", "id": "k_7f2a", "clientKind": "ui", "loopback": true },
  "updatedAt": "2026-10-29T10:05:12.410+05:30",
  "version": 1,
  "persist": { "peak": 1250.0, "peakAt": "2026-10-29T10:41:03+05:30", "realisedOutside": 0, "day": "2026-10-29" }
}
```

- `scope.kind`: `strategy` (1–12 legs, one underlying, one account) or `accountDay` (no legs; every open F&O position on the account in `guards.session.exchanges`; `rules.spot` not allowed).
- `qty`: signed units at arm (negative = short). `entryAvg`: ₹ per unit. `entrySource`: `position-avg | user | fills`.
- `rules`: at least one of the four. Amounts are positive rupees. `trail.lockPct` is 1–99 and `trail.activateAt` > 0. `spot` needs at least one side; `symbol` defaults to the underlying's index (`NSE:NIFTY`, `BSE:SENSEX`) and may be the near future.
- `action.kind`: `notify` (default) or `autoExit`. `pricing`: `touch` (default; limit at touch ± `slipTicks`) or `mid` (limit at mid; one re-price to touch). Market orders are never used by a guard.
- `mode`: `paper` (default) or `live`. A paper account (`broker: "paper"`) is always `paper`.
- `repeat`: `once` (strategy default; after a fire the guard stays `fired` until re-armed) or `daily` (accountDay default; re-arms at the next session open and resets `peak`).
- `exitEnabled`: whether the server may send this guard's exit (one tap or auto). It is `true` for paper. For live it is `true` only when the creation passed gates 1–5 in §9.1. Otherwise the prepared exit opens in the Positions exit plan for the person to send with their own key.
- `liveConfirm`: `{ phrase: "LIVE zerodha-main", at, by }` when live auto-exit was confirmed. It is cleared by any change to `rules`, `scope` or `action`, which drops the guard back to notify until confirmed again.
- **No secrets, tokens, IPs or broker client codes are stored** (test).

**State** (in memory, mirrored to `state.json` per guard for restart; never trusted for firing after a restart):

```json
{ "state": "armed", "since": "…", "reasons": [ { "code": "STREAM_FALLBACK", "severity": "info", "message": "Prices by REST every 3 s (no live feed for 1 leg)." } ],
  "pnl": -4123.5, "peak": 1250.0, "lock": null, "spot": 25612.4, "breach": null,
  "marks": [ { "symbol": "…25600-CE", "mark": 160.4, "basis": "mid", "bid": 160.1, "ask": 160.7, "ltp": 160.5, "ageMs": 420, "source": "stream", "fresh": true } ],
  "positions": { "readAt": "…", "ok": true, "drift": [] }, "evaluatedAt": "…" }
```

State values (closed list, documented as open in OpenAPI) and precedence, highest first:

| State | Meaning | Evaluates conditions? | Fires? | Notified on entry |
|---|---|---|---|---|
| `disarmed` | User turned it off | no | no | yes ("disarmed by you") |
| `completed` | Every leg was closed outside the guard, or a `once` day guard reached the day end | no | no | yes |
| `exiting` | Exit runner active | no | — | via the fire |
| `exit_incomplete` | Runner halted with legs open | no | no | yes (urgent) |
| `fired` | Condition met; prepared exit waiting (notify), or exit done (`exited` in the fire) | no | no | via the fire |
| `cannot_trade` | Readiness `cannot_trade` for live; kill switch, or account session down, for paper | yes (breach is notified, never acted on) | **no** | yes |
| `blind` | Some guard leg, or the spot for a spot rule, has no fresh source for > `blindAfterSeconds` | **no** | **no** | yes |
| `sleeping` | Outside the session (or a non-trading day) | no | no | no |
| `warming` | Just armed or restarted: waiting for one positions read and every mark fresh | no | no | no |
| `armed` | Watching | yes | yes | no |

Several conditions can hold together. `state` is the highest; `reasons` lists all of them.

**Fire record** (one line in `fires/<date>.jsonl` per change; last line per `fireId` wins):

```json
{ "fireId": "gf_20261029_110212_q8wz", "guardId": "gd_k3j9x2m1q8wz", "at": "2026-10-29T11:02:12.004+05:30",
  "rule": "maxLoss", "condition": { "pnl": -4705.5, "threshold": -4500, "firstSeenAt": "2026-10-29T11:02:10.001+05:30", "samples": 3 },
  "action": "prepared", "status": "prepared", "expiresAt": "2026-10-29T11:32:12.004+05:30",
  "basket": { "order": [0, 1], "legs": [
      { "k": 0, "symbol": "NFO:NIFTY-2026-11-03-25600-CE", "side": "BUY", "qty": 130, "slices": [130], "limit": 166.50, "mid": 166.00, "estPnl": -10933.0 },
      { "k": 1, "symbol": "NFO:NIFTY-2026-11-03-24700-PE", "side": "BUY", "qty": 130, "slices": [130], "limit": 29.10, "mid": 28.90, "estPnl": 6110.0 } ],
    "estPnl": -4823.0, "slippageVsMid": 91.0, "orders": 2, "priceAsOf": "2026-10-29T11:02:11.950+05:30" },
  "check": { "ok": true, "blocking": 0, "warnings": 1, "basis": "broker", "codes": ["MARGIN_SOURCE", "UPFRONT_PREMIUM"] },
  "orders": [], "realisedPnl": null, "haltedAt": null, "haltReason": null }
```

`status`: `prepared | sending | exited | halted | expired | refused | interrupted | superseded`. `action`: `prepared | auto`. Order rows: `{ k, slice, attempt, orderId, clientOrderId, status, filledQty, avgPrice, at }`.

**Bus topic `strategy.guard`** (payload safe to log; no account id unless `includeAccountLabel`):

```json
{ "guardId": "gd_k3j9x2m1q8wz", "name": "NIFTY 3 Nov strangle", "kind": "fired",
  "state": "fired", "previous": "armed", "mode": "live", "rule": "maxLoss", "pnl": -4705.5, "threshold": -4500,
  "fireId": "gf_20261029_110212_q8wz", "action": "prepared", "exitEnabled": true,
  "reasons": [], "notify": true, "simulated": false, "at": "2026-10-29T11:02:12.004+05:30" }
```

`kind` ∈ `state | fired | breach_cannot_trade | exit_done | exit_halted | gap | expired`. `notify` is the dedupe decision (§7.9).

**Participant day** (S4, one line in `participants/oi/<YYYY>.jsonl`):

```json
{ "v": 1, "date": "2026-10-28", "exchange": "NSE", "source": "nse-archives:fao_participant_oi_28102026.csv",
  "fetchedAt": "2026-10-28T19:11:42.003+05:30", "sha256": "…", "quality": "ok", "unit": "contracts", "lotRegime": "2026-01",
  "rows": {
    "CLIENT": { "IDX_FUT": [180600, 96330], "IDX_CE": [1520000, 1090000], "IDX_PE": [1350000, 1140000], "STK_FUT": [ … ], "STK_CE": [ … ], "STK_PE": [ … ] },
    "DII":    { "…": "…" }, "FII": { "…": "…" }, "PRO": { "…": "…" }, "TOTAL": { "…": "…" } } }
```

Each pair is `[long, short]`. `quality`: `ok | totals-mismatch | partial` (§7.11).

**Holder tags** (`dataDir/book/holders.json`):

```json
{ "version": 1, "holders": { "self": { "relationship": "self", "label": "Me" },
                             "spouse": { "relationship": "spouse", "label": "Asha" },
                             "rk-huf": { "relationship": "huf", "label": "RK HUF" } },
  "updatedAt": "…", "updatedBy": "local" }
```

`relationship` ∈ `self | spouse | dependent-child | dependent-parent | huf | other` (closed in the schema, open in OpenAPI). Config `book.holders` entries override the file and show as "set in config" (read-only in the UI).

### 2.4 Storage on disk

```
<dataDir>/guards/                (0700; demo uses guards-demo/, never mixed)
  guards.json                    { "version": 1, "guards": [Guard] }       atomic; written on change and every 60 s if peak moved
  state.json                     { "version": 1, "beatAt": "…", "byGuard": { id: { state, since, lastNotifiedKey, lastNotifiedAt } } }
  fires/2026-10-29.jsonl         fire records and state transitions (append-only; torn last line skipped)
<dataDir>/participants/          (0700; demo uses participants-demo/)
  state.json                     { lastFetch, lastSuccessDate, backfill: { cursor, done, noFile: [dates], failed: { date: n } } }
  oi/2026.jsonl                  one line per date (last wins); ~2.4 KB a line; 2 years ≈ 1.2 MB
  raw/2026-10-28/fao_participant_oi_28102026.csv  (+ .sha256)      kept retentionDays
<dataDir>/book/
  holders.json                   holder tags (above)
```

- Atomic writes through `auth/fsUtil.mjs writeFileAtomic`; mode 0600 files, 0700 folders.
- A corrupt `guards.json` is renamed `guards.json.corrupt-<ts>`. Every guard comes back **disarmed** (never armed blind), and the dashboard shows "Guards could not be read and were turned off; check and re-arm". A corrupt day file never stops the next day (BRD §7.7).
- Retention: fires 400 days, participant raw files 1,100 days, participant rows forever (tiny).

### 2.5 Schedulers and timers

All timers follow the scanner/notify pattern: `start()` arms them with `unref()`, `stop()` clears them, time comes from `deps.clock.now()`, and timers are injectable for tests.

| Job | When | What |
|---|---|---|
| `guards.eval` | every `evalMs` (1,000) while ≥ 1 guard is armed and in session | Pure evaluation of every guard from in-memory marks. No I/O. Budget ≤ 5 ms for 50 guards. |
| `guards.quotes` | every `quotePollSeconds` (3) per data account, only for symbols not live on the stream | One batched `marketData.quotes(symbols, { accountId, maxAgeMs: 2000, priority: "live" })` |
| `guards.positions` | every `positionsSeconds` (30) per guarded account, plus `order.updated` for that account (debounced 2 s, at most 6/min) | `orders.positions(ctx, account, { mode })`; reconcile legs (§7.8) |
| `guards.beat` | every 60 s | `state.json.beatAt`; detects gaps on the next start (§3.5) |
| `guards.session` | every 60 s | Session open/close transitions (`sleeping` ↔ `warming`), daily re-arm, `expired` prepared exits |
| `participants.fetch` | `fetchAt` 19:10 IST, then every 30 min until `retryUntil` 22:10, on trading days; `morningCatchUp` 08:40 for a missed day | Fetch → parse → validate → store → `participants.updated` |
| `participants.backfill` | outside `notDuring` (09:00–15:45 IST), one file per `gapSeconds` (6), ≤ `maxPerRun` (120) per hour, until `backfill.days` (500) is covered | Resumable cursor, newest first |
| `book` | none (computed on request, cached `cacheSeconds`) | — |

Each Bridge adds deterministic jitter `hash(dataDir) % 300` seconds to the participant fetch times (P1-2 pattern).

### 2.6 Config (all optional; zod `.strict()`)

```jsonc
"guards": {
  "enabled": true,
  "evalMs": 1000,                       // 250..5000
  "confirmSeconds": 2,                  // condition must hold this long with ≥ 2 fresh samples (0..30)
  "blindAfterSeconds": 30,              // BRD: "no prices for over 30 s" (10..120)
  "recoverAfterSeconds": 5,             // fresh this long to leave blind
  "positionsSeconds": 30,               // 10..120
  "quotePollSeconds": 3,                // REST fallback cadence (2..15)
  "staleQuoteSeconds": 10,              // BRD §7.5 stale-data guard for any exit
  "mark": { "basis": "mid", "maxSpreadPct": 15 },   // mid when two-sided and spread ≤ maxSpreadPct of mid, else LTP
  "maxActive": 50, "maxLegs": 12,
  "exit": { "slipTicks": 2, "legFillTimeoutSeconds": 8, "reprice": 1, "maxOrdersPerFire": 40, "cancelOpenOrders": true },
  "preparedTtlMinutes": 30,
  "autoExit": { "paper": true, "live": false },     // live: config FILE only; env can never set it (like safety.liveTrading)
  "notify": { "dashboardUrl": null, "includeAccountLabel": false, "blindCooldownMinutes": 10 },
  "session": { "exchanges": ["NFO", "BFO"] },
  "retentionDays": 400
},
"participants": {
  "enabled": true,
  "fetchAt": "19:10", "retryEveryMinutes": 30, "retryUntil": "22:10", "morningCatchUp": "08:40",
  "urls": ["{base}/content/nsccl/fao_participant_oi_{DDMMYYYY}.csv"],   // {base} = reference.sources.nseArchives.baseUrl; needs verification
  "backfill": { "enabled": true, "days": 500, "gapSeconds": 6, "maxPerRun": 120, "notDuring": { "from": "09:00", "to": "15:45" } },
  "retentionDays": 1100
},
"book": {
  "family": { "name": "Family", "relationships": ["self", "spouse", "dependent-child", "dependent-parent"] },  // needs verification
  "untaggedHolder": "self",             // accounts with no holder count as this holder (single-user installs keep working)
  "holders": {},                        // optional locks: { "spouse": { "relationship": "spouse", "label": "Asha" } }
  "cacheSeconds": 10,
  "exchanges": ["NFO", "BFO"],
  "maxAccounts": 20
}
```

Demo defaults (`demoMode.mjs`): `guards.session` checks ignored (the demo market is always open), `confirmSeconds: 2`, `autoExit.live` irrelevant (live is simulated); participants never fetch; book holders seeded (§5).

---

## 3. How it works

### 3.1 Guard lifecycle

```
POST /v1/guards ─► gates.canCreate (scope, family, live gates, overlap) ─► store ─► readiness.registerAutomation
      │                                                                   (kind "guard", mode, onState → cannot_trade)
      ▼
  warming ── positions read OK + every mark fresh ─► armed ◄──────────── session open (daily re-arm for repeat:daily)
      │                                               │  every 1 s: marks → P&L/spot → rules → confirm window
      │            blind (no fresh source > 30 s) ◄───┤
      │            cannot_trade (readiness/kill) ◄────┤  (breach while cannot_trade → notify only)
      │                                               ▼
      │                                    FIRE (fireId) ─► exit basket ─► margin.check(guardExit)
      │                                         │
      │                 action notify ──────────┼──────────── action autoExit (all gates re-checked now)
      │                 status prepared         │              exitRunner: cancel open orders on exit symbols,
      │                 notify + deep link      │              legs in covered order, wait fill, re-price once,
      │                 one tap → exitRunner ───┘              halt on unfilled → exit_incomplete
      ▼
  fired / exited / exit_incomplete / completed / disarmed
```

### 3.2 Evaluation (every `evalMs`)

For each guard in `armed` or `cannot_trade`:

1. Marks from `feeds.mjs` (§7.1). Any required symbol not fresh → candidate `blind` (enter after `blindAfterSeconds`; §7.6).
2. P&L from `guard-core.js` (§7.2 strategy, §7.3 account-day). Peak update (§7.4).
3. Rules in fixed order `maxLoss`, `spot`, `trail`, `target`. The first breached rule is the candidate.
4. Confirmation window (§7.5). When confirmed:
   - `armed` → **fire** (§3.4).
   - `cannot_trade` → record a `breach_cannot_trade` event with the reasons and notify ("Max loss reached on NIFTY 3 Nov strangle, but this account cannot trade: session expired. Log in and exit from your broker or the Bridge."). It does not fire. When the account becomes ready again and the condition still holds, the guard fires then.
5. State and reasons recomputed; transitions appended to the fires file and emitted on the bus.

### 3.3 Feeds and positions

- **Stream first.** `streamHub.subscribe("guards", symbols, "quote")` for every leg and spot symbol of armed guards (deduplicated; unsubscribed within 5 s of the last guard on a symbol disarming). Marks come from `streamHub.lastTick(symbol)`. A symbol counts as stream-fresh while `isLive(symbol)` is true and its upstream `state` is `up` (P1-4).
- **REST fallback** for symbols that are not stream-fresh: one batched `quotes` call per data account per `quotePollSeconds`.
- **Data account (pricing wall, same rule as the book §3.4):** the guard's own account if it has the `quotes` capability and is connected; else another connected account **of the same holder**; for paper accounts, the unpinned read the paper engine itself uses. With none: the guard is `blind` with reason `NO_DATA_ACCOUNT` ("No market-data account for this holder").
- **Positions** through `orders.positions(guardCtx, account, { mode })`. The guard context is `createCallContext({ source: "guard", principal: { kind: "guard", id }, scopes: ["read"], hookAccounts: [account] })`. Reconciliation is pure (§7.8).

### 3.4 Fire, prepared exit and exit runner

1. `fireId = gf_<yyyymmdd>_<hhmmss>_<last4 of guard id>`. This is the idempotency root (BRD §7.5).
2. Basket (§7.7) from the reconciled legs: quantity capped at the current position on that account (never flips a position), sides that close, freeze slices from `symbols.resolve().freezeQty` (as `OrderService` slices), and limit prices from fresh quotes. A leg whose quote is older than `staleQuoteSeconds` marks the basket `stale`.
3. `margin.check(ctx, { account, mode, legs, intent: "guardExit" })` when `deps.margin` is not a stub. The send order is `sequence.covered.order ?? sequence.order`. The check summary is stored on the fire.
4. **Notify action:** status `prepared`, `expiresAt = at + preparedTtlMinutes`. Notification and in-app banner (§6.5). One tap calls `POST …/fires/{fireId}/exit`. That re-reads positions, rebuilds the basket at current prices (same `fireId`), re-checks the gates and margin, and runs the exit runner. After expiry the route still works but returns the rebuilt basket for confirmation first (`409 STATE_CONFLICT` with the new basket in `detail.basket`).
5. **Auto action:** the gates are re-checked at fire time (§9.1). Any gate failing → status `refused` with the gate's reason, the action falls back to `prepared`, and the notification says "Auto-exit did not run: {reason}. Exit prepared."
6. **Exit runner** (`exitRunner.mjs`, one run per account at a time, a mutex keyed by account):
   1. If `exit.cancelOpenOrders`: cancel open orders on the basket's symbols (`orders.list({ accountId, status: "open" })`, then `orders.cancel` with `idempotencyKey = <fireId>:c:<orderId>`), so a resting order cannot re-open a position after the exit.
   2. For each leg k in send order and each slice s: `orders.place(guardCtx, { account, symbol, side, quantity, product, orderType: "LIMIT", price, validity: "DAY", mode, clientOrderId: "g" + <fireId tail> + k + s, tag: "MCBGUARD" }, { idempotencyKey: "<fireId>:<k>:<s>:a<attempt>" })`.
   3. Wait for `order.updated` with `filled` up to `legFillTimeoutSeconds`. If it is not filled: cancel, re-quote, re-place once at touch + 2 × `slipTicks` (attempt 2). Still not filled: **halt**. Status `halted`, guard state `exit_incomplete`, urgent notification listing what is still open. A short buy-back that did not fill means the hedges are **not** sold.
   4. A `rejected` leg halts the same way, with the broker's message.
   5. When done: status `exited`, `realisedPnl` from fills, audit `guard.exit_done`, notification with expected vs realised.
7. **Restart during a run:** a fire with status `sending` found at boot becomes `interrupted`. Nothing is resent automatically. The orders are reconciled by `clientOrderId` (`orders.getByClientId`), the guard is set to `exit_incomplete`, and the user is notified with a prepared remainder.

### 3.5 Restart, heartbeat and gaps

- On start, every guard is loaded as `warming` (or `disarmed`/`fired`/`completed` as stored). Nothing fires until one positions read succeeds and every mark is fresh.
- If `now − beatAt > 120 s` and the gap overlaps a session, one `gap` event is emitted per guard ("Guards were not running from 10:12 to 10:31 (the Bridge was not running)"). It is notified once per restart.
- `peak` is persisted at most every 60 s, and at once when the trail activates or the lock moves by ≥ ₹500. After a restart the lock is never lower than the persisted one.

### 3.6 Book read

```
GET /v1/book?view=family
  └─ visible accounts (key filter) ─► holderOf(account) (config.holder → untaggedHolder) ─► tags (config > holders.json)
       ├─ per account, in parallel (allSettled, 5 s timeout each): orders.positions(ctx, a, { mode }) and orders.funds(ctx, a, { mode })
       │     (paper accounts: paper engine; live: scheduler "portfolio" class; cached cacheSeconds per account)
       ├─ per holder: price source (§3.4 below) → quotes for spots and legs (one batch) → book-core.priceHolder()
       └─ book-core.aggregate(): holders[], family (relationship ∈ family.relationships), totals, notes
```

**Pricing wall (`book/pricing.mjs`)** for holder H:
1. A connected account of H with `quotes` (prefer one with `optionChain`): pinned reads (`accountId`).
2. Else, if every account of H is a paper account: the paper engine's own source (unpinned, as paper fills are priced today). No other person's broker session is involved, because paper is a local simulation on the operator's Bridge.
3. Else: broker-reported only (`ltp`, `pnl` from each position row). Greeks `null` with `NO_DATA_ACCOUNT`.

Never: one holder's legs priced through another holder's account (a test asserts every `marketData` call's `accountId` belongs to the holder being priced).

---

## 4. API changes

All routes: JSON `{ data, meta }`, Problem errors, demo labelling as today. Account visibility follows the key's account list (`accountFilter(ctx)` from `safety/routes.mjs`; reuse it). Times IST with offset. Money in ₹ (2 dp). OI in contracts for S4 (as published; the field says so).

### 4.1 Guards (stream S25)

| Method | Path | Scope (route) | Extra rule in the handler |
|---|---|---|---|
| GET | `/v1/guards` | read | Only guards on accounts the key may use |
| POST | `/v1/guards` | paper | `mode: "live"` → `live` scope or local; `action.kind: "autoExit"` → not an MCP key; live autoExit → loopback + `confirmLive` (§9.1) |
| POST | `/v1/guards/preview` | read | Dry run; stores nothing |
| GET | `/v1/guards/{guardId}` | read | |
| PATCH | `/v1/guards/{guardId}` | paper | Same rules as POST for the resulting guard; `version` must match (409 `STATE_CONFLICT`) |
| DELETE | `/v1/guards/{guardId}` | paper | Refused while `exiting` (409) |
| POST | `/v1/guards/{guardId}/arm` | paper | Re-runs the create gates; live → `live` scope or local |
| POST | `/v1/guards/{guardId}/disarm` | paper | Always allowed for any key that may see the guard (turning protection off is a user choice, never blocked) |
| GET | `/v1/guards/{guardId}/events` | read | `?from=&to=&limit=` (fires and transitions) |
| GET | `/v1/guards/{guardId}/fires/{fireId}` | read | |
| POST | `/v1/guards/{guardId}/fires/{fireId}/exit` | paper | Paper guard → `paper` scope. Live guard → `live` scope, **or** `admin` scope from loopback (mirrors ticket confirmation). `exitEnabled` must be true. |
| POST | `/v1/demo/guards` | read | Demo only (route registered only when `config.demo`); §5.2 |

#### 4.1.1 `POST /v1/guards`

Request (`GuardInput`):

```json
{
  "name": "NIFTY 3 Nov strangle",
  "account": "zerodha-main",
  "mode": "live",
  "scope": { "kind": "strategy", "legs": [
      { "symbol": "NFO:NIFTY-2026-11-03-25600-CE", "qty": -130 },
      { "symbol": "NFO:NIFTY-2026-11-03-24700-PE", "qty": -130, "entryAvg": 76.10 } ] },
  "rules": { "maxLoss": 4500, "trail": { "activateAt": 3000, "lockPct": 50 }, "spot": { "below": 24800, "above": 25750 } },
  "action": { "kind": "autoExit", "pricing": "touch" },
  "confirmLive": "LIVE zerodha-main",
  "armed": true
}
```

- `qty` is optional. When omitted, it is taken from the account's position at create time. When given, |qty| must be ≤ |position| with the same sign, and a multiple of the lot.
- `entryAvg` is optional (default: the position `avgPrice`; `entrySource: "position-avg"`).
- `scope.underlying` is derived from the legs. All legs must share one underlying (`VALIDATION_FAILED`, path `scope.legs`).
- `confirmLive` is required only for `mode: "live"` + `autoExit`, and must equal `LIVE <account>` exactly (case-sensitive).

Response `201` `{ data: Guard & { live: GuardLive }, meta }`. `GuardLive`:

```json
{ "state": "warming", "since": "…", "reasons": [ { "code": "WARMING", "severity": "info", "message": "Reading positions and prices." } ],
  "pnl": null, "peak": null, "lock": null, "spot": null,
  "distance": { "maxLoss": null, "target": null, "trail": null, "spotBelow": null, "spotAbove": null },
  "marks": [], "readiness": { "state": "ready", "reasons": [] },
  "exitEnabled": true, "autoExitAllowed": true, "runsOn": "this computer", "lastFire": null, "asOf": "…" }
```

Errors:

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Shape; no rule; legs on two underlyings; qty larger than the position or wrong sign; not a lot multiple; > `maxLegs`; `spot` with `accountDay`; `errors[].code` adds `GUARD_OVERLAP` (another armed strategy guard on this account already covers part of the same quantity, §7.8) and `GUARD_LIMIT` (`maxActive`) |
| 403 | `SCOPE_REQUIRED` | Live without `live` scope; `autoExit` from an MCP key ("An AI assistant cannot set a guard to send orders by itself.") |
| 403 | `PAPER_ONLY` | Live not enabled for the account or the Bridge; `"guard"` not in `live.allowedSources` (for `exitEnabled`); `guards.autoExit.live` false (for live autoExit) |
| 403 | `LOOPBACK_ONLY` | Live autoExit from another computer |
| 403 | `AUTOMATION_NOT_ALLOWED` | The account's holder is outside the family definition (§7.12): "Guards are allowed only on accounts of your family as defined in book.family (self, spouse, dependent children, dependent parents). This account belongs to holder 'friend' (other)." |
| 403 | `ACCOUNT_FORBIDDEN` | Key may not use the account |
| 404 | `ACCOUNT_NOT_FOUND`, `SYMBOL_NOT_FOUND` | |
| 422 | `CANNOT_TRADE` | Live autoExit while readiness is `cannot_trade` ("Fix: … then arm again"); notify guards are still created, in state `cannot_trade` |
| 422 | `VALIDATION_FAILED` | `confirmLive` missing or wrong (path `confirmLive`) |

A live guard that fails the live exit gates but passes the rest is **created** with `exitEnabled: false` and `action: notify`. The response carries `warnings: ["One-tap exit is off for this guard: add \"guard\" to accounts[].live.allowedSources …"]`, so the person still gets protection by notification. Only an explicit `autoExit` request is refused outright.

#### 4.1.2 `POST /v1/guards/preview`

Body: `GuardInput` (no `armed`, no `confirmLive`). Response `data`:

```json
{ "pnl": -1180.0, "spot": 25402.1, "distance": { "maxLoss": 3320.0, "spotAbove": 347.9, "spotBelow": 602.1, "target": null, "trail": null },
  "legs": [ { "symbol": "…", "qty": -130, "entryAvg": 82.40, "entrySource": "position-avg", "mark": 96.3, "basis": "mid", "pnl": -1807.0 } ],
  "basket": { "...": "as in the fire record" }, "check": { "...": "margin.check summary or null + reason" },
  "gates": { "create": { "ok": true }, "exitEnabled": { "ok": false, "code": "PAPER_ONLY", "message": "…" }, "autoExitLive": { "ok": false, "code": "PAPER_ONLY", "message": "guards.autoExit.live is off in the config file" } },
  "notes": ["This guard runs on this computer. …", "P&L uses the entry price shown; your broker may show a different figure for positions carried from an earlier day."] }
```

#### 4.1.3 `POST /v1/guards/{guardId}/fires/{fireId}/exit`

Body: `{ "acceptStale": false, "basketVersion": 2 }`. `basketVersion` echoes the basket the person saw; if the rebuilt basket differs (quantities, legs or order), the route answers 409 `STATE_CONFLICT` with `detail.basket` to show and confirm.
Response `202`: `{ data: FireRecord (status "sending"), meta }` with `Location: /v1/guards/{id}/fires/{fireId}`.
Errors: 404 (unknown or another guard's fire); 409 `STATE_CONFLICT` (already `sending`/`exited`, or basket changed); 422 `INVALID_ORDER` "Prices are older than 10 s; confirm to use them" when stale and `acceptStale` is false; 403 per the scope rule; 422 `CANNOT_TRADE`; 423 `KILL_SWITCH_ACTIVE`; 403 `PAPER_ONLY` when `exitEnabled` is false ("Open the exit plan on the Positions page to send this exit with your own key").

### 4.2 Participants (stream S26)

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/v1/participants/oi` | read | `?from=&to=` (ISO dates, max 750 days, default last 60), `participants=CLIENT,DII,FII,PRO,TOTAL`, `instruments=IDX_FUT,IDX_CE,IDX_PE,STK_FUT,STK_CE,STK_PE`, `format=json\|csv` |
| GET | `/v1/participants/oi/summary` | read | `?date=` (default latest) |
| GET | `/v1/participants/status` | read | |
| POST | `/v1/participants/sync` | admin, loopback | `{ "date"?: "2026-10-28", "backfill"?: true }` |

#### 4.2.1 Service contract (core change: the lead lands it)

```js
/**
 * ParticipantOI — S26. NSE participant-wise open interest (store S4). No broker calls. NSE only.
 *  latest({ exchange: "NSE"|"BSE" }) -> { available: true, asOfDate, source, unit: "contracts",
 *      rows: [{ participant: "CLIENT"|"DII"|"FII"|"PRO", instrument: "IDX_FUT"|"IDX_CE"|"IDX_PE"|"STK_FUT"|"STK_CE"|"STK_PE", long, short }] }
 *    | { available: false, reason: "NO_PARTICIPANT_DATA"|"PARTICIPANT_STALE"|"NOT_FOR_BSE"|"SOURCE_OFF", detail }
 *      (the shape P1-8 §3.5 reads; stale = asOfDate older than the previous trading day)
 *  series({ from, to, participants?, instruments? }) -> Array<ParticipantDay>
 *  status() -> ParticipantStatus
 *  sync({ date?, backfill? }) -> Promise<{ fetched: string[], noFile: string[], failed: Array<{ date, code }> }>
 */
participants: { iface: "ParticipantOI", stream: "S26", requires: ["reference"], methods: ["latest", "series", "status", "sync"] },
```

`reference` is required because it may be a stub: the service checks `isStub` and reports `SOURCE_UNAVAILABLE` (real mode) instead of failing.

#### 4.2.2 `GET /v1/participants/oi/summary`

```json
{ "data": {
    "date": "2026-10-28", "previousDate": "2026-10-27", "exchange": "NSE", "unit": "contracts", "quality": "ok",
    "publishedNote": "NSE only. Summed over all strikes and expiries. Number of contracts, for the trading day ended 28 Oct 2026.",
    "table": [
      { "participant": "FII", "instrument": "IDX_FUT", "long": 112340, "short": 248910, "net": -136570,
        "netChange": -15565, "longPct": 31.10, "longPctChange": -2.04, "shareOfLong": 27.43, "shareOfShort": 60.79 } ],
    "headline": { "fiiIndexFutLongPct": 31.10, "fiiIndexFutLongPctChange": -2.04, "fiiIndexFutNet": -136570, "fiiIndexFutNetChange": -15565,
                  "formula": "FII index-futures long % = FII long ÷ (FII long + FII short) × 100, in contracts" },
    "history": { "fiiIndexFutLongPct": [ { "date": "2026-09-30", "value": 38.2 } ], "days": 20 },
    "revisions": [ { "date": "2026-01-01", "text": "Index lot sizes revised; contract counts before and after are not like for like" } ],
    "source": "nse-archives:fao_participant_oi_28102026.csv", "fetchedAt": "2026-10-28T19:11:42.003+05:30" },
  "meta": { "requestId": "…" } }
```

Errors: 404 `NOT_FOUND` "No participant OI for 2026-10-25 (no file: likely a holiday)"; 503 `BROKER_UNAVAILABLE` is never used. When the source is off, the body says `available: false, reason: "SOURCE_OFF"` with 200, so the page can show its hint.

#### 4.2.3 `GET /v1/participants/status`

```json
{ "enabled": true, "source": { "nseArchives": "on", "setBy": "dashboard", "verified": false },
  "latestDate": "2026-10-28", "lastAttemptAt": "…", "lastError": null, "nextRunAt": "2026-10-29T19:12:37+05:30",
  "backfill": { "target": 500, "have": 487, "noFile": 13, "failed": 0, "running": false, "cursor": "2024-10-31" },
  "rows": 487, "diskBytes": 1184211 }
```

### 4.3 Book (stream S27)

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/v1/book` | read | `?view=holders\|family` (default `holders`), `underlying=` (optional filter), `account=` (repeatable; default all visible), `mode=live\|paper\|all` (default `all`), `format=json\|csv` |
| GET | `/v1/book/holders` | read | Holders, relationships, family membership, accounts per holder (ids only for keys that may see them) |
| PUT | `/v1/book/holders/{holder}` | admin, loopback | `{ "relationship": "spouse", "label": "Asha" }`; 409 `STATE_CONFLICT` when locked by config |

#### 4.3.1 `GET /v1/book?view=family`

```json
{ "data": {
    "view": "family", "asOf": "2026-10-29T11:15:04+05:30",
    "family": { "name": "Family", "relationships": ["self", "spouse", "dependent-child", "dependent-parent"],
      "holders": ["self", "spouse"],
      "totals": { "pnl": -888.0, "realised": 0.0, "unrealised": -888.0, "theta": 1854.0, "vega": -2176.0, "rupeeDelta": -726352.0,
                  "marginUsed": 245600.0, "marginAvailable": 512340.0, "accounts": 3, "partial": false },
      "notes": ["Totals add separate accounts on this computer. Margin is not shared between accounts, and every exit goes to the leg's own account."] },
    "holders": [
      { "holder": "self", "label": "Me", "relationship": "self", "inFamily": true, "priceSource": { "kind": "account", "broker": "zerodha" },
        "accounts": [
          { "account": "zerodha-main", "broker": "zerodha", "label": "Main", "mode": "live", "tags": ["self", "live"],
            "positions": 1, "pnl": -4888.0, "margin": { "used": 145200.0, "available": 310000.0, "asOf": "…", "source": "broker" }, "error": null },
          { "account": "dhan-main", "broker": "dhan", "label": "Dhan", "mode": "live", "tags": ["self", "live"],
            "positions": 1, "pnl": 2600.0, "margin": { "used": 38400.0, "available": 120000.0, "asOf": "…", "source": "broker" }, "error": null } ],
        "underlyings": [
          { "underlying": "NIFTY", "spot": 25120.0, "lot": 65,
            "greeks": { "delta": 10.4, "deltaLots": 0.16, "rupeeDelta": 261248.0, "gamma": -0.0403, "theta": 1274.0, "vega": -1456.0, "missing": 0 },
            "legs": [
              { "account": "zerodha-main", "symbol": "NFO:NIFTY-2026-11-03-25600-CE", "q": -130, "avg": 82.40, "mark": 120.00, "markSource": "mid",
                "pnl": -4888.0, "iv": 13.1, "greeks": { "delta": 0.42, "gamma": 0.00031, "theta": -9.80, "vega": 11.20 }, "guarded": ["gd_k3j9x2m1q8wz"] },
              { "account": "dhan-main", "symbol": "NFO:NIFTY-2026-11-24-FUT", "q": 65, "avg": 25150.0, "mark": 25190.0, "pnl": 2600.0,
                "greeks": { "delta": 1, "gamma": 0, "theta": 0, "vega": 0 }, "guarded": [] } ] } ],
        "totals": { "pnl": -2288.0, "theta": 1274.0, "vega": -1456.0, "rupeeDelta": 261248.0, "marginUsed": 183600.0, "marginAvailable": 430000.0 } },
      { "holder": "spouse", "label": "Asha", "relationship": "spouse", "inFamily": true, "...": "…" } ],
    "outsideFamily": [ { "holder": "friend", "relationship": "other", "accounts": 1, "note": "Not in the family view. Guards and alert actions are not allowed on this holder's accounts." } ],
    "method": "Greeks per leg from that holder's own market data (Black-76 on the forward, IV from the leg's mark). ₹Δ = Δ (units) × spot, summed across underlyings, so it is not a hedge ratio.",
    "disclaimer": "For information and personal use. Not investment advice." },
  "meta": { "requestId": "…" } }
```

- `view=holders` returns the same `holders` (every visible holder) plus `outsideFamily: []` and `family: null`.
- A key limited to some accounts gets `partial: true` on the totals and only its accounts. A holder with no visible account is omitted.
- Errors: 403 `ACCOUNT_FORBIDDEN` (named account), 404 `ACCOUNT_NOT_FOUND`, 400 `VALIDATION_FAILED`. Per-account failures never fail the whole response; they appear in `accounts[].error` (`{ code, message }`).

### 4.4 `docs/openapi.yaml` additions (disciplined layout read by `core/openapi.test.mjs`)

New tags `Guards`, `Participant OI`, `Book`. Every operation has `x-stream` and `x-scope`; the loopback routes carry `x-loopback-only: true`. Abbreviated below: every path shows `parameters`/`requestBody` and its 200/201/202, and the shared `"4XX"`/`"5XX"` Problem responses as in the rest of the file.

```yaml
  /v1/guards:
    get:
      tags: [Guards]
      operationId: listGuards
      summary: Strategy guards on accounts this key may use, with live state
      x-stream: S25
      x-scope: read
      parameters:
        - { name: account, in: query, required: false, schema: { type: string } }
        - { name: state, in: query, required: false, schema: { type: string } }
      responses:
        "200":
          description: Guards.
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { type: array, items: { $ref: "#/components/schemas/Guard" } }
                  meta: { $ref: "#/components/schemas/Meta" }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }
    post:
      tags: [Guards]
      operationId: createGuard
      summary: Create a guard (paper scope; live guards need the live scope; live auto-exit needs this computer and a typed confirmation)
      x-stream: S25
      x-scope: paper
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/GuardInput" }
      responses:
        "201":
          description: Created.
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { $ref: "#/components/schemas/Guard" }
                  meta: { $ref: "#/components/schemas/Meta" }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }

  /v1/guards/preview:
    post:
      tags: [Guards]
      operationId: previewGuard
      summary: Dry run of a guard (P&L now, distances, the exit basket and its margin check, the gates); stores nothing
      x-stream: S25
      x-scope: read
      requestBody: { required: true, content: { application/json: { schema: { $ref: "#/components/schemas/GuardInput" } } } }
      responses:
        "200": { description: Preview., content: { application/json: { schema: { type: object, required: [data, meta], properties: { data: { $ref: "#/components/schemas/GuardPreview" }, meta: { $ref: "#/components/schemas/Meta" } } } } } }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }

  /v1/guards/{guardId}:
    get:     { tags: [Guards], operationId: getGuard, summary: One guard with live state, x-stream: S25, x-scope: read, … }
    patch:   { tags: [Guards], operationId: updateGuard, summary: Change a guard (same rules as create; version must match), x-stream: S25, x-scope: paper, … }
    delete:  { tags: [Guards], operationId: deleteGuard, summary: Delete a guard (not while it is exiting), x-stream: S25, x-scope: paper, … }
  /v1/guards/{guardId}/arm:
    post:    { tags: [Guards], operationId: armGuard, x-stream: S25, x-scope: paper, … }
  /v1/guards/{guardId}/disarm:
    post:    { tags: [Guards], operationId: disarmGuard, x-stream: S25, x-scope: paper, … }
  /v1/guards/{guardId}/events:
    get:     { tags: [Guards], operationId: listGuardEvents, x-stream: S25, x-scope: read, … }
  /v1/guards/{guardId}/fires/{fireId}:
    get:     { tags: [Guards], operationId: getGuardFire, x-stream: S25, x-scope: read, … }
  /v1/guards/{guardId}/fires/{fireId}/exit:
    post:    { tags: [Guards], operationId: sendGuardExit, summary: "Send a fired guard's prepared exit (one tap). Live guards: live scope, or admin from this computer", x-stream: S25, x-scope: paper, … }
  /v1/demo/guards:
    post:    { tags: [Demo], operationId: demoGuardScenario, summary: "Demo only: price shock, blind feed, cannot-trade, restore", x-stream: S25, x-scope: read, … }

  /v1/participants/oi:
    get:     { tags: [Participant OI], operationId: getParticipantOi, summary: "NSE participant-wise OI by day (contracts; NSE only; all strikes and expiries)", x-stream: S26, x-scope: read, … }
  /v1/participants/oi/summary:
    get:     { tags: [Participant OI], operationId: getParticipantOiSummary, x-stream: S26, x-scope: read, … }
  /v1/participants/status:
    get:     { tags: [Participant OI], operationId: getParticipantStatus, x-stream: S26, x-scope: read, … }
  /v1/participants/sync:
    post:    { tags: [Participant OI], operationId: syncParticipantOi, x-stream: S26, x-scope: admin, x-loopback-only: true, … }

  /v1/book:
    get:     { tags: [Book], operationId: getBook, summary: "One book per holder, or the family view (never pooled for orders; each leg keeps its account)", x-stream: S27, x-scope: read, … }
  /v1/book/holders:
    get:     { tags: [Book], operationId: listHolders, x-stream: S27, x-scope: read, … }
  /v1/book/holders/{holder}:
    put:     { tags: [Book], operationId: setHolderTag, x-stream: S27, x-scope: admin, x-loopback-only: true, … }
```

The real file uses the expanded block form for every operation (the `readOperations` parser needs `x-scope` and `x-stream` on their own 6-space lines). The compact `{ … }` lines above show content, not the layout to paste.

Schemas (`components/schemas`), expanded in the file:

```yaml
    GuardInput:
      type: object
      required: [name, account, scope, rules]
      additionalProperties: false
      properties:
        name: { type: string, minLength: 1, maxLength: 60 }
        account: { type: string }
        mode: { type: string, enum: [paper, live], default: paper }
        scope: { $ref: "#/components/schemas/GuardScope" }
        rules: { $ref: "#/components/schemas/GuardRules" }
        action:
          type: object
          additionalProperties: false
          properties:
            kind: { type: string, enum: [notify, autoExit], default: notify }
            pricing: { type: string, enum: [touch, mid], default: touch }
        repeat: { type: string, enum: [once, daily], description: "Default once for strategy, daily for accountDay" }
        confirmLive: { type: string, description: "Exactly 'LIVE <account>'; required for live autoExit only" }
        armed: { type: boolean, default: true }
    GuardScope:
      oneOf:
        - type: object
          required: [kind, legs]
          properties:
            kind: { const: strategy }
            legs:
              type: array
              minItems: 1
              maxItems: 12
              items:
                type: object
                required: [symbol]
                properties:
                  symbol: { type: string }
                  qty: { type: integer, description: "Signed units (negative = short); default the current position" }
                  entryAvg: { type: number, minimum: 0, description: "₹ per unit; default the position average" }
        - type: object
          required: [kind]
          properties: { kind: { const: accountDay } }
    GuardRules:
      type: object
      minProperties: 1
      additionalProperties: false
      properties:
        maxLoss: { type: number, exclusiveMinimum: 0, description: "₹; fires when P&L ≤ −maxLoss" }
        target: { type: number, exclusiveMinimum: 0, description: "₹; fires when P&L ≥ target" }
        trail:
          type: object
          required: [activateAt, lockPct]
          properties:
            activateAt: { type: number, exclusiveMinimum: 0, description: "₹ of peak P&L that turns the lock on" }
            lockPct: { type: number, minimum: 1, maximum: 99, description: "% of peak P&L kept; fires when P&L ≤ lock" }
        spot:
          type: object
          properties:
            symbol: { type: string }
            below: { type: number }
            above: { type: number }
    Guard:
      allOf:
        - $ref: "#/components/schemas/GuardInput"
        - type: object
          required: [id, state, mode, exitEnabled, createdAt, version]
          properties:
            id: { type: string, pattern: "^gd_[a-z0-9]{12}$" }
            state: { type: string, description: "armed | warming | sleeping | blind | cannot_trade | fired | exiting | exit_incomplete | completed | disarmed (open enum)" }
            reasons: { type: array, items: { $ref: "#/components/schemas/StateReason" } }
            exitEnabled: { type: boolean }
            live: { $ref: "#/components/schemas/GuardLive" }
            lastFire: { oneOf: [ { $ref: "#/components/schemas/GuardFire" }, { type: "null" } ] }
            createdAt: { type: string, format: date-time }
            updatedAt: { type: string, format: date-time }
            version: { type: integer }
    GuardLive:        { type: object, description: "pnl, peak, lock, spot, distance, marks[], readiness, autoExitAllowed, runsOn, asOf (§4.1.1)" }
    GuardFire:        { type: object, description: "fireId, guardId, at, rule, condition, action, status, expiresAt, basket, check, orders[], realisedPnl (§2.3)" }
    GuardPreview:     { type: object, description: "pnl, spot, distance, legs[], basket, check, gates, notes (§4.1.2)" }
    StateReason:      { type: object, required: [code, severity, message], properties: { code: { type: string }, severity: { type: string, enum: [info, warn, fail] }, message: { type: string } } }
    ParticipantDay:   { type: object, description: "date, exchange, unit (contracts), quality, lotRegime, rows: { CLIENT|DII|FII|PRO|TOTAL: { IDX_FUT|IDX_CE|IDX_PE|STK_FUT|STK_CE|STK_PE: [long, short] } }" }
    ParticipantSummary: { type: object, description: "§4.2.2" }
    ParticipantStatus:  { type: object, description: "§4.2.3" }
    Book:             { type: object, description: "§4.3.1" }
    HolderTag:
      type: object
      required: [relationship]
      properties:
        relationship: { type: string, enum: [self, spouse, dependent-child, dependent-parent, huf, other] }
        label: { type: string, maxLength: 40 }
```

`ErrorCode` enum += `AUTOMATION_NOT_ALLOWED`, `STATE_CONFLICT` (and `CANNOT_TRADE` if P1-5 has not added it). The OpenAPI diff check in CI must show only additions.

### 4.5 MCP (parity, §7.8)

| Tool | Scope | Notes |
|---|---|---|
| `list_guards` | read | Same fields as `GET /v1/guards` |
| `create_guard` | paper | `action.kind` is not in the input schema (always `notify`), `mode: "live"` is offered only with the `live` scope, and `confirmLive` does not exist. A model can never arm an auto-send (BRD §7.9). |
| `get_participant_oi` | read | Summary, or a series when `from`/`to` are given (max 250 rows; CSV via REST) |
| `get_book` | read | `view`, `underlying`; legs capped at 200 with `truncated: true` |

---

## 5. Demo mode

Goal: `mc-bridge start --demo` at any hour shows a working guard that fires, a blind and a cannot-trade guard, a two-year participant history, and a family book across three holders, with nothing to configure.

### 5.1 Demo adapter

1. **Stable sample position.** `fetchPositions` fixes the strike at the ATM of the IST day's 09:15 spot (`spotAt(NIFTY, sessionOpen(t))`), so the symbol no longer changes during the day. The avg stays `ltp × 0.94` **computed at session open**, so P&L moves during the day.
2. **Price shock** `demoControl.shock({ underlying: "NIFTY"|"BANKNIFTY"|"SENSEX"|"all", pct, rampMs = 20000, ms = 600000 })`. `spotAt(symbol, t)` multiplies by `1 + pct × min(1, (t − t0)/rampMs)` while active. Options, futures, quotes, chains and the feed all follow, because they derive from `spotAt`. Auto-restores after `ms` (≤ 10 min).
3. **Quotes down** `demoControl.quotesDown(ms)`. `fetchQuotes`/`fetchLTP` throw `UPSTREAM_TIMEOUT` for `ms`. Combined with P1-4's `stall({ mode: "silent" })`, this produces a real blind state.

### 5.2 `POST /v1/demo/guards` (demo only; scope `read` so the public demo can use it)

Body `{ "scenario": "shock-up" | "shock-down" | "blind" | "cannot-trade" | "restore" }`.

| Scenario | Effect | What the viewer sees within 30 s |
|---|---|---|
| `shock-up` | `shock({ underlying: "all", pct: +0.015 })` | The seeded short-strangle guard's P&L falls through its max loss. It fires (paper, notify), the banner shows "Max loss reached", and one tap exits on `demo-paper`. |
| `shock-down` | `pct: −0.015` | The spouse account's iron condor day guard (paper, autoExit) fires and exits by itself, legs in covered order. |
| `blind` | `quotesDown(60000)` + P1-4 `stall({ mode: "silent", ms: 60000 })` | Guards go `blind` after 30 s, then `armed` 5 s after the feed returns |
| `cannot-trade` | Demo overlay: every demo account reads `cannot_trade` ("Simulated: session expired") for 10 min. It never touches the real kill switch, so other public-demo viewers keep trading. | Guards show "cannot trade". A shock during it shows "breach: cannot trade, not acted on". |
| `restore` | Clears all of the above | — |

Response: `{ data: { scenario, until, guards: [{ id, name, state }] } }`. Every scenario reverts by itself after at most 10 minutes. The card says "Simulations are shared by everyone viewing this demo and reset after 10 minutes" (P1-5 wording).

### 5.3 Seeded data (first start in demo with empty demo stores; re-seeded when the books are empty, for example after expiry)

- **Accounts** (`demoMode.mjs`): `demo` (market data, holder `demo`), `demo-paper` (paper, holder `demo`), `demo-paper-spouse` (paper, holder `demo-spouse`, label "Paper · spouse (sample)"), `demo-paper-other` (paper, holder `demo-other`, label "Paper · not family (sample)").
- **Holder tags** (in `book-demo/holders.json`): `demo` → self ("You (demo)"), `demo-spouse` → spouse, `demo-other` → other.
- **Paper book seed** (`book/demoBook.mjs`, through `orders.place` with a local principal, `mode: "paper"`, `tag: "DEMOSEED"`, nearest weekly expiry):
  - `demo-paper`: NIFTY short strangle, 2 lots, strikes ±2 % from spot rounded to the step; BANKNIFTY bull call spread, 1 lot.
  - `demo-paper-spouse`: SENSEX iron condor, 1 lot, shorts ±1.5 %, wings ±3 %.
  - `demo-paper-other`: NIFTY long future, 1 lot.
- **Guards seed** (`guards/demoGuards.mjs`):
  - "Sample: NIFTY strangle max loss" on `demo-paper`: strategy guard over the strangle; `maxLoss` = 60 % of the strangle's credit at seed time; `trail { activateAt: 40 % of credit, lockPct: 50 }`; spot stop at the short strikes; notify.
  - "Sample: spouse day guard" on `demo-paper-spouse`: `accountDay`, `maxLoss` = 1.2 × the condor's credit, autoExit (paper).
  - An attempt to seed a guard on `demo-paper-other` is **expected to be refused** (`AUTOMATION_NOT_ALLOWED`). The Guards page shows that holder under "Not allowed (outside family)", so the rule is visible.
- **Participants** (`participants/demo.mjs`): every weekday (IST) for 520 days back is deterministic from `hash32(date)`. CE/PE rows are identical to P1-8's `demoParticipants.mjs` when that file exists (import and reuse; otherwise this generator is the one P1-8 switches to). Futures: total index-futures OI 3.2–4.6 lakh contracts; FII long % follows a 40-trading-day cycle between 18 % and 64 % plus noise; stocks: futures 18–24 lakh, options CE/PE 6–14 lakh. Σ long = Σ short per instrument exactly (the generator sets the last participant's side as the balancing figure). One synthetic `lotRegime` change on 1 Jan of the current year. Every 30th weekday is a "holiday" with no file, so gaps show.
- **Notifications** in demo: the notifier is off (existing rule). The Guards page lists the last 20 messages under "Would have been sent", formatted by `notify/format.mjs` exactly as Telegram would receive them.

---

## 6. Dashboard

### 6.1 Guards page (`#/guards`, "Guards", Options group after Positions, icon `shield`)

- **Header strip:** counts per state (`pill`s: Armed, Blind, Cannot trade, Fired, Disarmed), and a persistent note: "Guards run on this computer. If the Bridge stops, they cannot act." A **New guard** button opens the create sheet with the scope picker.
- **Guard cards** (one per guard, `data-state` attribute):
  - Title, account label and a mode badge (Paper/Live), plus a state chip with icon and text (never colour alone).
  - **P&L meter:** a horizontal track from −maxLoss to +target. The current P&L marker carries its signed value as text ("−₹4,123"); the trail lock is a tick with "lock ₹2,600". `role="meter"` with `aria-valuetext` "P&L minus ₹4,123; max loss ₹4,500, ₹377 away".
  - Distances: "₹377 to max loss · spot 138 below 25,750".
  - Legs (collapsible): symbol, qty, entry, mark with basis and age, leg P&L.
  - Reasons list (blind/cannot trade with the fix).
  - Actions: Arm/Disarm (a toggle, with a confirmation on disarm), Edit, Delete, Events.
  - Fired: the **fire panel** (§6.4) inline.
- **Not allowed:** a collapsed section listing accounts outside the family, with the reason and "Set the relationship on the Accounts page".
- **Demo card** (demo only): the four scenario buttons, the "Would have been sent" list and the shared-demo notice.

### 6.2 Create / edit sheet (`guards.js openGuardSheet({ account, mode, legs?, kind })`)

- Opened from: Positions expiry-group header "Guard…" (legs = that group's legs, qty = current); Positions book strip "Day guard…" (`accountDay`); the Builder placement sheet after all legs fill ("Add a guard", legs and `entryAvg` from the fills, `entrySource: "fills"`); the Guards page (pick account, then legs from its positions).
- Fields: name (prefilled "NIFTY 3 Nov · Short strangle" from `detectStructure`); max loss ₹ (prefilled from positions `lossLimit` when set); target ₹; trailing lock (activate at ₹, keep %); spot stop (below/above, with "nearest short strike" quick fills); legs table with editable entry price; action segmented (Notify me / Exit automatically).
- A live preview (`POST /v1/guards/preview`, debounced 400 ms) shows P&L now, distances, the exit basket with send order and the margin check lines (P1-10's `checkPanel`), and the gates as plain lines ("One-tap exit: on" / "Auto-exit in live: off — guards.autoExit.live is off in the config file").
- Live + Exit automatically: a typed field "Type LIVE zerodha-main to confirm" (the Save button stays disabled until it matches), plus the §8.4 text: "Auto-exit sends live orders without asking you. It counts toward your order limits. It runs only while this Bridge is running and the account can trade." The option is hidden when gates 1–5 fail, with the reason shown instead.
- Numeric inputs only (no drag), `inputmode="numeric"`, and 44 px targets.

### 6.3 Positions page (`positions.js`)

- **Scope control** in the page context bar (`segmented`): `This account` (today's page, unchanged) · `All accounts` · `Family`. Saved in `st.pos.scope`. The account select is hidden for the last two.
- **All accounts / Family view** (`book-core.js` view-model, data from `GET /v1/book`, polled every 15 s on this page only; 0 polls on other pages):
  - Family view: a top strip with family totals (P&L, Θ ₹/day, Vega ₹/pt, ₹Δ, margin used/available labelled "sum of separate accounts").
  - Holder sections (collapsible, `data-holder-relationship`): holder label and relationship chip, the holder strip, per-account chips (broker logo, label, mode, P&L, margin used/available, "as reported HH:MM:SS"), then per underlying a legs table with an **Account** column, Δ (units, lots), Γ, Θ, Vega, P&L and a guard shield if guarded.
  - Leg actions: **Exit** opens the existing ticket with `account` preset to the leg's account (never a multi-account basket); **Guard…** opens the sheet for that leg's account. Bulk select works within one account only (selecting a leg from another account clears the selection, with toast "Exits go to one account at a time").
  - Outside-family holders: in `All accounts` with an "Outside family" chip; excluded from `Family`.
  - A holder without a data account: Greeks "—" with the reason tooltip; P&L from the broker.
- **This account view additions:** a shield icon on guarded legs; an expiry-group header button "Guard…"; a book-strip button "Day guard…"; a small row "2 guards on this account" linking to `#/guards`.

### 6.4 Fire panel and one tap (Guards card, banner sheet, deep link)

- Content: rule and value ("Max loss reached: −₹4,705 at 11:02:12"), the basket table (order #, side, qty, slices, limit, mid, est. P&L), estimated total and slippage vs mid, the check lines, and the expiry countdown.
- Primary button **Exit now** (one tap) → `POST …/exit` with `basketVersion`. On 409, the table re-renders with the changed rows highlighted (`data-changed`) and the button reads "Confirm changed exit". On stale prices: a checkbox "Prices are 14 s old — use them anyway".
- During `sending`: per-leg progress rows (queued → sent → filled / re-priced / halted) from polling the fire every 1 s.
- `exitEnabled: false` (a live guard without the server exit path): the button reads **Open exit plan** and goes to `#/positions?account=…&exit=<symbols>` with the existing exit-plan sheet prefilled. The person sends with their own key.

### 6.5 App-wide banner (`app.js`)

- Every 15 s on any page (only when ≥ 1 guard exists; one local call, no broker call): `GET /v1/guards?state=fired,exit_incomplete,blind,cannot_trade`.
- A fired guard shows a sticky banner under the toolbar: "Guard fired: NIFTY 3 Nov strangle — max loss reached. Review exit". `exit_incomplete` shows an urgent banner. Blind/cannot-trade show a quiet chip in the toolbar with a count. Dismissing hides the banner for that `fireId` only.
- Deep link `#/guards/<id>?fire=<fireId>` opens the card with the fire panel. Notifications carry it when `guards.notify.dashboardUrl` is set.

### 6.6 Notification messages (`notify/format.mjs`, case `strategy.guard`)

```
🛡 Guard fired · NIFTY 3 Nov strangle (live)
Max loss reached: P&L −₹4,705 (limit −₹4,500) at 11:02.
Exit prepared: BUY 25600 CE ×130, then BUY 24700 PE ×130 (est. −₹4,823).
Open the Bridge to send it: http://… (only if dashboardUrl is set)
This guard runs on your computer; it acts only while the Bridge is running.
```

Other kinds: "blind: no live prices for 30 s; not watching until prices return", "cannot trade: Zerodha session expired; the guard will not exit", "breach while cannot trade", "exit done: realised −₹4,861 (expected −₹4,823)", "exit halted: 25600 CE buy-back not filled; 24700 PE still open; act now", "Guards were not running from 10:12 to 10:31". No account ids, tokens, IPs or client codes. The account label appears only with `includeAccountLabel: true`.

### 6.7 Participants page (`#/participants`, "Participant OI", Options group after OI Analysis, icon `people`)

- Top line: date, "NSE only · all strikes and expiries · contracts · for the day ended 28 Oct", a source/freshness pill, and CSV.
- **Headline tiles:** FII index-futures long % (with Δ pts and the formula in a K3 hover), FII index-futures net (with Δ), Client index-options net calls/puts, Pro index-options net calls/puts.
- **Table:** rows = participants (Client, DII, FII, Pro, Total); column groups = Index fut, Index CE, Index PE, Stock fut, Stock CE, Stock PE; each with Long, Short, Net, Δ net. Sticky participant column; horizontal scroll inside the panel on phones; phone alternative = one card per participant with a segmented instrument picker.
- **History:** `chartSlot("Participant OI history")` plus the fallback purpose-built SVG sparkline per series (FII idx fut long %, FII idx fut net, Client idx CE net, Client idx PE net) and a data table toggle. Range segmented 20 / 60 / 250 / all. Revision rules drawn with text labels.
- States: source off (with a link to the Market calendar page switch), no data yet ("First file arrives after 19:10 today"), backfill progress ("History: 312 of 500 days"), quality `totals-mismatch` (warn chip "NSE totals did not add up on this day; shown as published").
- **OI page tile** (`oi.js`): one line "FII index futures: 31.1 % long (−2.0 pts) · Participants →" for NSE underlyings; for SENSEX/BANKEX "No BSE participant file".

### 6.8 Accounts page (`views.js renderAccounts`): holders

- Each account card shows "Holder: spouse (Asha) · Family" or "Holder: friend · Outside family". **Edit relationship** (admin, this computer) opens a small sheet with the relationship select (from the schema list; family members marked) and a label. Locked-by-config tags show "set in bridge.config.json".
- A one-line explainer under the section: "Family = self, spouse, dependent children and dependent parents (book.family in the config file). Guards and alert actions work only on family accounts. Managing money for anyone else needs SEBI registration."

### 6.9 Phone, tablet, desktop

| Surface | Phone (< 720 px) | Tablet (720–1023) | Desktop (≥ 1024) |
|---|---|---|---|
| Guards page | One column of cards; meter full width; legs collapsed; fire panel as a bottom sheet | Two columns | Three columns; fire panel inline |
| Create sheet | Full-height bottom sheet; preview collapsed under "What happens if it fires" | Side sheet | Side sheet with live preview beside the form |
| Positions All/Family | Holder sections as stacked cards; legs as cards (account chip first) | Table with Account column; Γ hidden | Full table |
| Participants | Card per participant + instrument picker; tiles 2-up | Table scrolls in its panel | Full table |
| Banner | Under the toolbar, one line, tap → sheet | same | same |

16 px gutter, no page-level horizontal scroll, 44 px targets, every SVG with a text summary and table toggle, `aria-live="off"` for ticking numbers, and an opt-in "announce guard events" (`aria-live="assertive"` only for fired/halted). Reduced motion: no meter animation.

### 6.10 CSS (`app.css`; tokens only)

`[data-state="fired"]`, `[data-state="exit_incomplete"]` → border `--ios-red`; `[data-state="blind"]`, `[data-state="cannot_trade"]` → `--warn`; `[data-state="armed"]` → `--ios-green`; the meter fill uses `--pos`/`--neg`; `[data-changed]` → `--warn` outline. Ten rules, no new colours, no new motion. The restyle team owns the final look.

---

## 7. Formulas and worked examples

All functions are pure, in `dashboard/guard-core.js`, `participants/metrics.mjs` and `dashboard/book-core.js`. Each has a reference-value test with the numbers below.

### 7.1 Leg mark (`legMark(q, { maxSpreadPct })`, from the shared `dashboard/marks.js`, P1-11)

- Two-sided quote (bid > 0, ask ≥ bid) and `(ask − bid)/mid ≤ maxSpreadPct/100` → `mark = mid = (bid + ask)/2`, basis `mid`.
- Else LTP (basis `ltp`). If there is no LTP → `null` (the leg is not priced; it counts toward blind only through freshness, §7.6).
- Example: CE bid 165.60, ask 166.40 → spread 0.80/166.00 = 0.48 % ≤ 15 % → mark **166.00**.

### 7.2 Strategy P&L (`strategyPnl(legs, marks)`, from the shared `dashboard/marks.js`, P1-11)

**P = Σᵢ qᵢ · (mᵢ − aᵢ) + R**, where qᵢ is the guard's current quantity (signed units), aᵢ is `entryAvg` and R is `realisedOutside` (§7.8).

*Worked (NIFTY lot 65, 2 lots each).* Legs: short 25600 CE (q = −130, a = 82.40) and short 24700 PE (q = −130, a = 76.10). At 11:02:10 the marks are CE 166.00 and PE 28.90 (bid 28.80 / ask 29.00):

- CE: −130 × (166.00 − 82.40) = −130 × 83.60 = **−10,868.00**
- PE: −130 × (28.90 − 76.10) = −130 × (−47.20) = **+6,136.00**
- **P = −4,732.00.** With `maxLoss` 4,500: −4,732 ≤ −4,500 → breach (first seen 11:02:10.001).

### 7.3 Account-day P&L (`dayPnl(positions, marks)`)

**D = Σₚ realisedₚ + Σₚ qₚ · (mₚ − avgₚ)** over positions on `session.exchanges`. Rows without a fresh mark use the broker `unrealisedPnl` and make the guard blind (they are not silently mixed in).

*Worked.* BANKNIFTY spread closed today, realised +2,350; the strangle above, unrealised −4,732; a long SENSEX put, unrealised −2,388 → **D = 2,350 − 4,732 − 2,388 = −4,770**. With a day `maxLoss` of 4,500 → breach.

### 7.4 Trailing lock (`trailStep(state, P, { activateAt: Y, lockPct: X })`)

- `peak = max(peak, P)` (persisted). Active when `peak ≥ Y`. **lock = floor(X/100 × peak)**, and it never decreases. Breach when active and **P ≤ lock**.
- *Worked* (Y = 3,000, X = 50):

| t | P | peak | active | lock | breach |
|---|---|---|---|---|---|
| 10:20 | 1,200 | 1,200 | no | — | no |
| 10:41 | 3,400 | 3,400 | yes | 1,700 | no |
| 11:05 | 5,200 | 5,200 | yes | 2,600 | no |
| 11:40 | 2,590 | 5,200 | yes | 2,600 | **yes** (2,590 ≤ 2,600) |

  Fire at 11:40:02 if P is still ≤ 2,600 (§7.5). Kept ≈ ₹2,540–2,600 of a ₹5,200 peak.

### 7.5 Confirmation window (`confirm(prev, breached, now, fresh, { confirmSeconds: c })`)

- A breach starts a window at `firstSeenAt` when the sample is fresh. Each fresh breached sample increments `samples`. A non-breached fresh sample resets the window. A non-fresh sample neither confirms nor resets.
- **Confirmed** when `samples ≥ 2` and `now − firstSeenAt ≥ c` seconds.
- *Worked:* breach at 11:02:10.001 (P = −4,732), 11:02:11.002 (−4,690), 11:02:12.004 (−4,705.5) → samples 3, elapsed 2.003 s ≥ 2 → **fire at 11:02:12.004**. With c = 0 a single sample still needs `samples ≥ 2`, so one bad tick can never fire a guard.
- Latency bound: `evalMs` + c + feed delay ≈ 1 + 2 + < 1 s ≈ **≤ 4 s** on a streamed instrument; ≤ 1 + 2 + 3 (REST poll) ≈ 6 s on REST fallback. P1-11's p95 ≤ 5 s target applies to streamed instruments.

### 7.6 Freshness and blind (`isFresh(sym, now)`, `blindStep`)

- `fresh(sym) = (stream.isLive(sym) && upstream.state === "up") || (now − lastRestOkAt(sym) ≤ 30 s)`.
- `required(guard)` = every leg symbol (strategy) or every open position symbol (accountDay), plus `rules.spot.symbol` when a spot rule exists.
- `unfreshSince` = the first instant some required symbol was not fresh. **Blind when `now − unfreshSince > blindAfterSeconds`**. Recovery when every required symbol has been fresh for `recoverAfterSeconds`.
- *Worked:* the CE leg's stream upstream goes `stale` at 10:14:05 (P1-4 stall), and REST calls time out. At 10:14:35.001 (30.001 s) → **blind**, notified. The feed returns at 10:15:02 → fresh until 10:15:07 → **armed**, recovery notified.
- Outside the session the guard is `sleeping`, never blind.

### 7.7 Exit basket (`exitBasket(legs, marks, inst, { pricing, slipTicks, freeze })`)

- Per leg: side = closes (q < 0 → BUY, q > 0 → SELL); qty = min(|q_guard|, |q_position|) when the signs agree, else skipped; slices by freeze qty rounded down to lots (as `exitPlan`); limit = touch ± slipTicks × tick (BUY: ask + 2 ticks; SELL: bid − 2 ticks), rounded to tick away from the trader's favour, clamped into the price band (`safety.priceBandPct` vs LTP) with a `BAND_CLAMPED` note.
- Send order: P1-10 `sendOrderFor(legs, "guardExit")` (buy-backs of shorts, largest |Δ| first; then long options sold; futures last). Without P1-10: `exitPlan` rank (shorts, longs, futures; |Δ| descending).
- *Worked (the strangle at fire):* Δ_CE 0.58, Δ_PE −0.05. |q·Δ|: CE 75.4, PE 6.5 → order **[CE, PE]**. Ask CE 166.40 → limit **166.50**; ask PE 29.00 → limit **29.10** (tick 0.05, 2 ticks = 0.10). Band (3 % of LTP 166.10 = 171.08 max) OK. Freeze 1,800 > 130 → 1 slice each. Est. P&L at limits: −130 × (166.50 − 82.40) − 130 × (29.10 − 76.10) = −10,933 + 6,110 = **−4,823**. Slippage vs mid = 130 × 0.50 + 130 × 0.20 = **₹91**. Orders: 2 (+ cancels of open orders on these two symbols).
- *Iron condor variant:* shorts are bought back first (two BUYs, larger |Δ| first), then wings are sold (two SELLs at bid − 2 ticks). If a buy-back halts, the wings are not sold (§3.4).

### 7.8 Leg reconciliation (`reconcile(guardLegs, positions)`)

For each guard leg with position quantity p (0 if absent) and guard quantity g:

| Case | Result |
|---|---|
| sign(p) = sign(g), \|p\| ≥ \|g\| | unchanged (any extra quantity is not guarded; reason `EXTRA_QTY` info) |
| sign(p) = sign(g), \|p\| < \|g\| | g ← p; `realisedOutside += (g − p) × (mark − entryAvg)` at the current mark, labelled "estimated"; reason `REDUCED_OUTSIDE` (notified once) |
| p = 0 or sign flipped | leg closed outside the guard; same realised estimate; reason `CLOSED_OUTSIDE` |
| every leg closed | state `completed` |

**Overlap rule** (create/arm): for every symbol, Σ |g| over armed strategy guards on the account ≤ |p|. Otherwise `GUARD_OVERLAP`. This guarantees that two exits can never over-close into a reverse position. An `accountDay` guard may coexist: its exit caps every leg at the position's current quantity at send time, and the per-account runner mutex (§3.4) serialises exits.

### 7.9 Notification dedupe (`shouldNotify(key, last, now)`)

`key = guardId + kind + state + rule`. Fired, exit and halt events: always. Blind: once per `blindCooldownMinutes` (10). Recovery: only if the blind notice was sent. Cannot trade: on entry and on recovery. Day re-arm: never.

### 7.10 Participant metrics (`participants/metrics.mjs`)

For participant p and instrument X with long L and short S (contracts):

- **net = L − S**; **Δnet = net_d − net_{d−1}**.
- **long % = L / (L + S) × 100** (2 dp); Δ in percentage points.
- **share of long = L / Σ_p L** (and of short likewise).

*Worked (28 Oct 2026, illustrative; CE/PE rows are P1-8 §7.8's):*

| | FII L | FII S | Pro L | Pro S | Client L | Client S | DII L | DII S | Total |
|---|---|---|---|---|---|---|---|---|---|
| Index fut | 1,12,340 | 2,48,910 | 98,400 | 61,250 | 1,80,600 | 96,330 | 18,150 | 3,000 | 4,09,490 each side |
| Index CE | 1,80,000 | 2,60,000 | 4,10,000 | 6,90,000 | 15,20,000 | 10,90,000 | 0 | 70,000 | 21,10,000 |
| Index PE | 3,00,000 | 2,10,000 | 5,20,000 | 8,40,000 | 13,50,000 | 11,40,000 | 20,000 | 0 | 21,90,000 |

- FII index-futures **long % = 1,12,340 / 3,61,250 = 31.10 %**. Previous day (L 1,18,900, S 2,39,905): 1,18,900 / 3,58,805 = 33.14 % → **−2.04 pts**.
- FII index-futures **net = −1,36,570**; previous −1,21,005 → **Δnet = −15,565**.
- FII share of index-futures long = 1,12,340 / 4,09,490 = **27.43 %**; of short = 2,48,910 / 4,09,490 = **60.79 %**.
- Client index CE net = +4,30,000; FII index CE net = −80,000; FII index PE net = +90,000.

### 7.11 Parser validation (`validateTotals(rows)`)

For each instrument: Σ_p L = TOTAL.L and Σ_p S = TOTAL.S, and TOTAL.L = TOTAL.S. Any mismatch > 0 → `quality: "totals-mismatch"` with the instruments listed. The row is stored as published (never corrected). A missing participant row → `partial`. Header aliases cover `Client Type`, `Future Index Long`, …, `Option Stock Put Short` and `Total Long Contracts` / `Total Short Contracts` (**needs verification** against a real download; the fixtures carry `illustrative: true` until replaced). A first line starting "Participant wise Open Interest" is skipped, its "as on <date>" is parsed and must equal the requested date (else `PARSE_FAILED: date mismatch`).

### 7.12 Family gate (`automationAllowed(config, tags, accountId)`)

```
holder = account.holder ?? config.book.untaggedHolder                         // "self" by default
rel    = config.book.holders[holder]?.relationship ?? tags[holder]?.relationship
         ?? (holder === config.book.untaggedHolder ? "self" : null)
ok     = rel !== null && config.book.family.relationships.includes(rel)
reason = rel === null ? "Holder '<h>' has no relationship tag. Set it on the Accounts page."
       : !ok ? "Holder '<h>' is tagged '<rel>', which is outside the family definition (book.family.relationships)." : null
```

*Worked:* `zerodha-main` (no holder) → `self` → allowed. `upstox-asha` (holder `spouse`, tag spouse) → allowed. `dhan-friend` (holder `friend`, tag `other`) → refused. `angel-huf` (holder `rk-huf`, tag `huf`) → refused under the default list (OQ1).

### 7.13 Book aggregation (`book-core.js`)

- Per leg: Greeks per unit from P1-3 `pricing.js` when present; else `black76Greeks(F, K, T, iv, right)` with `F = spot·e^{rT}` (r from `reference.rate()` or the default), `iv = impliedVol(mark, F, K, T, right)`. Futures: Δ = 1.
- Per underlying (per holder): Δ = Σ q·δ (units); **Δ lots = Δ / lot**; **₹Δ = Δ × spot**; Γ = Σ q·γ; Θ = Σ q·θ (₹/day); Vega = Σ q·ν (₹/vol pt).
- Holder totals: P&L, Θ, Vega and ₹Δ summed across underlyings. Δ in units is **not** summed across underlyings.
- Family totals: sums of the family holders' totals; margins sum `used`/`available` per account.
- *Worked:* self NIFTY: CE q −130 (δ 0.42, θ −9.80, ν 11.20) and FUT q +65 → Δ = −54.6 + 65 = **10.4 units = 0.16 lots**, ₹Δ = 10.4 × 25,120 = **₹2,61,248**, Θ = −130 × −9.80 = **+₹1,274/day**, Vega = −130 × 11.20 = **−₹1,456/pt**. P&L: CE −130 × (120.00 − 82.40) = −4,888; FUT 65 × (25,190 − 25,150) = +2,600 → self **−2,288**. Spouse SENSEX: q −40 (δ 0.30, θ −14.5, ν 18.0), mark 210 vs avg 245 → P&L +1,400, Δ −12, ₹Δ −12 × 82,300 = −₹9,87,600, Θ +580, Vega −720. **Family:** P&L −888, Θ +₹1,854/day, Vega −₹2,176/pt, ₹Δ −₹7,26,352, margin used 1,45,200 + 38,400 + 62,000 = **₹2,45,600**.

---

## 8. Rate-limit and resource budget

| Path | Broker calls | Rule |
|---|---|---|
| Guard positions | 1 per guarded account per 30 s (2/min) + event re-reads (≤ 6/min) → ≤ 8/min per account, class `portfolio`, priority `interactive` | Many guards on one account share one read |
| Guard prices, streamed | 0 REST. Subscriptions ≤ 13 per guard (12 legs + spot), deduplicated; ≤ 650 at `maxActive` 50 | Counted against the feed cap via StreamHub (`SUBSCRIPTION_LIMIT` → that symbol falls to REST and the guard shows `STREAM_FALLBACK`) |
| Guard prices, REST fallback | 1 batched quotes call per data account per 3 s = 20/min, priority `live`, only while some symbol is not stream-fresh | Capped at 50 % of that account's `quote` class per minute (`scheduler.headroom`). If the cap would be exceeded, the cadence stretches; past `blindAfterSeconds` the guard is blind with `RATE_BUDGET` |
| Guard fire | `margin.check`: ≤ 8 broker calls (P1-10 `maxBrokerCalls`); orders: legs × slices × ≤ 2 attempts + cancels ≤ `maxOrdersPerFire` 40 | Orders go through OrderService: safety order-rate cap (5/s default, ≤ 10/s), daily order count and daily loss all apply. 2 legs ≈ 0.4 s at the cap |
| Book | Per request (cached 10 s): positions + funds per visible account (2 calls), one quotes batch per holder | The page polls every 15 s → ≤ 8 portfolio calls/min per account while open; zero when closed |
| Participants | 0 broker calls. NSE archives: 1 file a day + ≤ 6 retries; backfill ≤ 120 files/hour at 6 s gaps, outside 09:00–15:45 | Through P1-2's archive client (one request in flight, `gapMs` floor) |
| CPU | Guard eval ≤ 5 ms per second for 50 guards (pure arithmetic); book aggregation ≤ 20 ms for 20 accounts × 50 legs | §7.1 BRD: no main-thread long task; the server loop never blocks > 10 ms |

User-facing requests keep priority: guard REST quotes run at `live` but are capped at 50 % of the class, and the positions reads at `interactive` share the class with the Positions page.

---

## 9. Safety, compliance and honesty gates

### 9.1 Order safety (BRD §7.5; nothing loosens `docs/guides/safety.md`)

`gates.mjs` holds every gate as one pure function, used at create, at arm, at fire and at one-tap.

**Live server exit (one tap or auto), all required:**
1. `safety.liveTrading` true and the account's `live.enabled` true (config file).
2. `"guard"` in the account's `live.allowedSources`.
3. The guard was created or last edited by a key with the `live` scope (or the local CLI). The guard's own context carries `scopes: ["live"]` only when this held (the hook pattern).
4. The account's holder is inside the family (§7.12).
5. `deps.readiness` and `deps.margin` are present (not stubs).
6. At send time: readiness `canTrade` (after `ensureFresh` when stale) is not `cannot_trade`; the kill switch is off; no basket price is older than `staleQuoteSeconds` (auto) or the person accepted stale prices (one tap); `margin.check.ok` is true (no `block` line).
7. One-tap only: the caller has the `live` scope, or `admin` from loopback.

**Live auto-exit additionally:** 8a `guards.autoExit.live: true` in the config file (environment cannot set it; demo forces false); 8b created from loopback; 8c `liveConfirm` phrase typed; 8d not an MCP key. Any change to rules, scope or action clears 8c.

**Always:**
- Orders go only through `OrderService.place` with `source: "guard"`, so mode decision, idempotency (a live order without a key is refused), safety checks, the order-rate cap, daily orders and daily loss all apply unchanged. `clientOrderId` and the idempotency key derive from `fireId` (BRD §7.5: the rule-fire ID is the idempotency key).
- A guard **never sends while blind or cannot_trade**, and **never opens** a position: the quantity is capped at the current position and the side always reduces (a test feeds flipped and grown positions).
- Kill switch: engaging it stops a running exit after the current leg (OrderService refuses the next), and every guard shows `cannot_trade`.
- The exit runner never sells a hedge after a short buy-back failed (§3.4).
- Every fire with auto-exit is audited (`guard.fired` with guard id, rule, condition values, `fireId`; then one `guard.exit_order` per order, and `guard.exit_done` or `guard.exit_halted`) — AC5.
- Paper guards use the same code path with `mode: "paper"`. Paper is the default everywhere.

### 9.2 Compliance (BRD §8)

- **Algo framework (§8.1).** A guard exit is a condition-triggered order sent by software, which may count as "algo" (**needs verification** per broker). It stays under the Bridge's 5/s cap (≤ 10/s ceiling), uses the generic tag `MCBGUARD` (the BRD's "broker's generic tag"; **needs verification** that each adapter passes tags through), needs explicit opt-in, needs H5 "can trade" (static IP, valid session) for live, and is white-box: the user sets every number and sees every condition.
- **Algo-provider empanelment (§8.1).** Live auto-exit ships **off by default** (`guards.autoExit.live: false`), behind a config-file opt-in, until the legal review decides whether the vendor needs empanelment. `docs/guides/guards.md` says so. Notify + one tap is a person's decision and is not affected.
- **Family definition (§8.1).** Guards on accounts outside the configured family are refused (`AUTOMATION_NOT_ALLOWED`), and so are alert actions in P1-11 through the same `family.mjs`. Copy: "Managing money for anyone else needs PMS/IA/RA registration and is out of scope."
- **RA/IA (§8.1).** No "recommended stop", "safe level" or "best exit". Words used: "max loss", "target", "lock", "exit prepared", "acts when". The banned-word test is extended to `guards.js`, `guard-core.js`, `participants.js` and `book-core.js` strings. Participant copy is descriptive ("FII held 31.1 % of their index-futures positions long"), never "bullish/bearish".
- **Market-data terms (§8.3).** The book and the guards never fetch one holder's data through another holder's account (test). The family view is computed locally for the operator and never exported with other holders' identifiers beyond their labels. Participant files are public NSE archives fetched politely, behind P1-2's opt-in.
- **Notifications (§7.9).** No account ids, tokens, IPs or client codes; the account label is opt-in.
- **Disclaimers (§8.4).** Guards: "This guard runs on this computer…" (§1.3) on every card and message. Participants: "NSE only; aggregated; contracts; published after the close. For information, not a signal." Book: the global footer, plus "Margin is not shared between accounts".

### 9.3 "Needs verification" register (each blocks `verified: true`)

| # | Item | Where it bites | Check against |
|---|---|---|---|
| V1 | Participant OI URL, publication time and columns | P-M3 fetch, parser | A real download on three dates (2024, 2025, 2026) and NSE's archive listing |
| V2 | How far back the archive keeps the file | backfill target | Archive probes; record in `participants/data/lot-revisions.json` notes |
| V3 | No BSE participant file | SENSEX/BANKEX copy | BSE derivatives reports |
| V4 | Algo-framework family definition (self, spouse, dependent children, dependent parents; HUF?) | `book.family.relationships` default | SEBI circular of 4 Feb 2025, NSE standards of 5 May 2025, broker FAQs |
| V5 | Whether a bridge-side conditional exit is "algo" per broker, and tag pass-through | live auto-exit | Each broker's algo FAQ; adapter tag mapping |
| V6 | Broker `avgPrice` semantics for carried positions | P&L basis note | Zerodha, Dhan and Upstox position docs |
| V7 | Broker `usedMargin`/`availableCash` definitions | book margin labels | Same |
| V8 | Lot and contract-size revision dates for the history rules | `lotRegime` | NSE circulars (P1-2 lot history once landed) |

---

## 10. Test plan

### 10.1 Unit (Vitest, `environment: node`, fake clock and timers, no network)

| File | Covers |
|---|---|
| `dashboard/guard-core.test.mjs` | §7.1 marks (mid/LTP/null, spread cut-off); §7.2 strategy P&L (the −4,732 example); §7.3 day P&L (−4,770); §7.4 trail table row by row (lock never decreases; restart with a persisted peak); §7.5 confirmation (single-tick spike never fires; stale sample neither confirms nor resets; c = 0 still needs two samples); §7.6 blind enter/recover timing incl. the 30.001 s edge and stream-live-but-quiet ≠ blind; state precedence over all 2^n reason combinations; §7.7 basket (order, limits 166.50/29.10, est. −4,823, slippage 91, band clamp, freeze slices, iron-condor order); §7.8 reconciliation table and overlap rule |
| `guards/gates.test.mjs` | Every §9.1 gate alone flips the result; MCP key + autoExit → `SCOPE_REQUIRED`; `confirmLive` exact match; rule edit clears it; paper guard needs none of the live gates |
| `guards/engine.test.mjs` | Warming → armed only after positions + fresh marks; fire once (`once`), daily re-arm and peak reset (`daily`); breach in `cannot_trade` notifies and never calls `orders.place`; readiness `onState` moves state within one tick; restart: no fire before warming completes; gap event after a 19-minute beat gap |
| `guards/exitRunner.test.mjs` | Covered order used; idempotency keys and clientOrderIds stable across a retry; unfilled short → re-price once → halt, hedges never sold; rejection halts; cancel of open orders first; kill switch mid-run stops after the current leg; per-account mutex serialises a day fire and a strategy fire; quantity never exceeds the position (flipped and grown positions); restart with `sending` → `interrupted`, nothing resent |
| `guards/feeds.test.mjs` | Stream-first, REST fallback batching per data account, pricing wall (a spouse guard never uses the self account), 50 % class cap stretches the cadence, `SUBSCRIPTION_LIMIT` fallback |
| `guards/store.test.mjs` | Atomic write; corrupt `guards.json` → renamed, every guard disarmed; torn fire line skipped; no token, IP or client code in any stored file (scan with the capturing-logger secrets) |
| `guards/notify.test.mjs` | Message texts (§6.6) with no account id; label only when configured; dedupe and cooldown (§7.9) |
| `guards/noOrders.test.mjs` | Grep: `guards/*` never imports `brokers/orderGate.mjs`, `paper/`, or an adapter; `book/*` and `participants/*` never call `place`/`modify`/`cancel` |
| `participants/parser.test.mjs` | Fixture parse; title line date check; header aliases; commas in numbers; blank lines; totals mismatch → quality; missing row → partial; non-CSV/HTML error page → `PARSE_FAILED` |
| `participants/metrics.test.mjs` | §7.10 numbers exactly (31.10 %, −2.04 pts, −1,36,570, −15,565, 27.43 %, 60.79 %) |
| `participants/service.test.mjs` | Schedule (19:10 + jitter, retries to 22:10, 08:40 catch-up; skips non-trading days with P1-2 present); source off → no fetch and `SOURCE_OFF`; 404 → `noFile`, at most two attempts; backfill resumes from the cursor after a restart, respects `notDuring`, gap and `maxPerRun`; `latest()` stale and BSE answers in P1-8's shape |
| `participants/demo.test.mjs` | Deterministic; Σ long = Σ short for every instrument and day; CE/PE equal to P1-8's generator; holidays produce gaps |
| `book/family.test.mjs` | §7.12 table; config lock beats the file; untagged default; HUF outside the default |
| `dashboard/book-core.test.mjs` | §7.13 numbers; Δ not summed across underlyings; partial totals for a limited key; holder without data → Greeks null with reason |
| `book/bookService.test.mjs` | Pricing wall (every `marketData` call's `accountId` belongs to the holder priced); per-account failures isolated; cache 10 s; paper-only holder uses the paper source |
| `dashboard/guards.test.mjs`, `participants.test.mjs`, `positions.test.mjs` additions | View-models: meter text, distance strings, state chips with text, fire panel rows, changed-row diff, banner selection, holder sections, one-account bulk selection rule |

### 10.2 Contract and security tests

- `core/openapi.test.mjs` passes with the new paths (scope, stream and loopback flags).
- P1-5's route-table security tests cover the new write routes automatically (CSRF/`Sec-Fetch-Site`, scope per route). Add explicit cases: `POST /v1/guards` live with a paper key → 403; live autoExit from non-loopback → 403; `PUT /v1/book/holders/*` non-loopback → 403; `POST …/exit` on a live guard with an admin key from non-loopback → 403.
- MCP matrix (read / paper / live × tools): `create_guard` never exposes `action` or `confirmLive`; `list_guards`, `get_book` and `get_participant_oi` are read-only.
- `core/contracts` `assertService("participants", impl)`; `participants/fake.mjs` published for P1-8 tests.
- Notify: `strategy.guard` in `NOTIFY_EVENTS`; a webhook target receives the signed body.
- Config: an old `bridge.config.json` without the new sections parses unchanged; `allowedSources: ["rest","guard"]` parses; env cannot set `guards.autoExit.live`.

### 10.3 End-to-end (`server/bridge/e2e/guards.e2e.test.mjs`, `participants.e2e.test.mjs`, `book.e2e.test.mjs`; real app on 127.0.0.1, demo config, shifted clock)

1. **Guard fires and exits (paper, notify + one tap):** demo seed → strangle guard armed → `POST /v1/demo/guards {shock-up}` → within 30 s `GET /v1/guards/{id}` shows `fired` with a basket ordered CE then PE → `POST …/exit` → fire `exited`, `demo-paper` positions flat on those symbols, audit has `guard.fired` and two `guard.exit_order` records sharing the `fireId`.
2. **Auto-exit (paper):** spouse day guard + `shock-down` → exits without a call; order count and daily paper counters rose by the leg count.
3. **Blind:** `blind` scenario → `blind` within 35 s → a shock during blind does **not** fire → `restore` → armed → fires.
4. **Cannot trade:** `cannot-trade` + shock → `breach_cannot_trade` event, zero orders placed (assert on `orders.list`).
5. **Family gate:** creating a guard on `demo-paper-other` → 403 `AUTOMATION_NOT_ALLOWED`; after `PUT /v1/book/holders/demo-other {relationship:"spouse"}` (loopback) it succeeds.
6. **Live gates (fake broker from `e2e/fixtures.mjs`, live-enabled config):** live autoExit refused while `guards.autoExit.live` is false; with it true and all gates passing, a fire sends live orders through the stub adapter with `source: "guard"`; expiring the session (P1-5 fake) before the fire → no order attempted.
7. **Restart:** kill the app mid-exit (after leg 1) → restart → fire `interrupted`, guard `exit_incomplete`, nothing resent, `gap` event.
8. **Participants:** demo `GET /v1/participants/oi/summary` → balanced table, formula present; `format=csv` downloads; a real-mode app with the source off → `SOURCE_OFF`.
9. **Book:** `GET /v1/book?view=family` → holders `demo` and `demo-spouse` only, `outsideFamily` lists `demo-other`, every leg has `account`, totals equal the sum of holder totals.

### 10.4 Manual checks (results pasted in the PR)

Demo on a 360 px phone and a desktop: the guard card meter readable with a screen reader; the fire sheet; the banner deep link; Positions Family view; the Participants table scrolls inside its panel. Telegram message from a real Bridge (non-demo, paper guard) matches §6.6.

---

## 11. Migration and back-compat

- **Additive API only** (BRD §7.8): new paths, new schemas, two new error codes, open enums. No existing field changes meaning.
- **Config:** new sections default safe (`guards.autoExit.live: false`; participants obey P1-2's archive switch, off on a fresh install). `live.allowedSources` gains the value `"guard"`. Existing configs parse unchanged. Live guards with one-tap exit need the user to add `"guard"`; `mc-bridge doctor` explains.
- **Holders:** accounts without `holder` count as `self` (`untaggedHolder`), so single-user installs get guards with no setup. Existing multi-holder configs (pooling users) must tag non-`self` holders before guards work on those accounts. The Guards page and doctor say so.
- **Demo:** two more demo accounts and `holder: "demo"` on `demo-paper`. `demo.test.mjs`'s account-list assertion and `DEMO_ACCOUNT_HINT` are updated in the same PR. The demo sample position no longer re-centres its strike during the day.
- **Positions page:** `This account` is the default, unchanged. The existing `lossLimit` setting stays (scenario shading) and pre-fills the guard sheet's max loss.
- **P1-8:** `deps.participants.latest()` returns exactly the shape P1-8 §3.5 reads. If P1-8 shipped `exposure/demoParticipants.mjs`, `participants/demo.mjs` imports it for CE/PE so both pages agree.
- **P1-11:** imports `book/family.mjs` and `guard-core.js strategyPnl`; no other coupling.
- **Notify:** `"strategy.guard"` joins the default event list. Users with an explicit `events` list must add it; doctor warns when guards exist and no target listens.
- **Data folders** are new; nothing is migrated. Uninstall = delete `dataDir/guards`, `participants`, `book`.

---

## 12. Ordered task list (one engineer, one session; each task lands with its tests green)

The list is ordered so the session can stop at the marked cut points with something shippable.

**Sessions (build order in `docs/spec/README.md`):** P1-13a participants = task 1 (only the `participants` contract and `DASHBOARD_FILES`; topics and error codes are pre-registered by F0) and tasks 8–12; P1-13b book and family gate = tasks 2–7; P1-12a guards server = tasks 13–23; P1-12b guards UI, e2e, live path, docs = tasks 24–28. The cut points below map onto these sessions.

1. Lead core change (§2.2): config `"guard"` source, principal kind `guard` in `context.mjs`, topics, error codes, `participants` contract + stub, `builtinModules`, `DASHBOARD_FILES`. Tests: config parse, context access for a guard principal, `assertService`.
2. `book/config.mjs`, `book/family.mjs`, `book/holderStore.mjs` + `family.test.mjs` (§7.12).
3. `book/routes.mjs` holders GET/PUT (admin, loopback) + routes tests; OpenAPI for `/v1/book/holders*`.
4. `dashboard/book-core.js` pure aggregation + `book-core.test.mjs` (§7.13 numbers).
5. `book/pricing.mjs` + `bookService.mjs` + `GET /v1/book` (+ CSV) + `bookService.test.mjs` (pricing wall); OpenAPI `/v1/book`.
6. Demo accounts and holders (`demoMode.mjs`, `book/demoBook.mjs` seed) + `demo.test.mjs` update.
7. Positions scope switch (`positions.js`): All accounts / Family view-model and rendering; per-leg account exits; bulk-select rule; Accounts page holder chip and editor (`views.js`). **Cut point A: F2/F11 shippable.**
8. `participants/parser.mjs` + fixtures + `parser.test.mjs`.
9. `participants/metrics.mjs` + `metrics.test.mjs` (§7.10).
10. `participants/store.mjs`, `fetcher.mjs` (P1-2 archive client), `service.mjs` (schedule, retries, backfill) + `service.test.mjs` + `fake.mjs`.
11. `participants/demo.mjs` + `demo.test.mjs`; routes + CSV + MCP `get_participant_oi`; OpenAPI.
12. `participants.js` page + OI page tile + view-model tests. **Cut point B: J1/S4 shippable; P1-8 reads it.**
13. `dashboard/guard-core.js`: re-export `legMark`/`strategyPnl` from `marks.js` (P1-11) and add the §7.1/§7.2 guard cases to its tests; day P&L, trail, confirm, freshness/blind, state precedence + tests.
14. `guard-core.js`: exit basket and reconciliation/overlap + tests.
15. `guards/config.mjs`, `schema.mjs`, `store.mjs` + store tests.
16. `guards/gates.mjs` + `gates.test.mjs`.
17. `guards/feeds.mjs` + `positionsSync.mjs` + `feeds.test.mjs`.
18. `guards/engine.mjs` (loop, states, readiness registration, bus, heartbeat) + `engine.test.mjs`.
19. `guards/notify.mjs` + `notify/*` changes (event, format) + tests.
20. `guards/exitRunner.mjs` + `exitRunner.test.mjs` (paper path first).
21. `guards/routes.mjs` (all §4.1 routes, preview) + routes/security tests; OpenAPI; MCP `list_guards`/`create_guard`.
22. Audit records (G-M7) + the `noOrders` grep test.
23. Demo adapter: stable position, `shock`, `quotesDown`; `POST /v1/demo/guards`; `demoGuards.mjs` seed + "Would have been sent" ring.
24. `guards.js`: Guards page, cards, meter, create/edit sheet with preview, fire panel.
25. Positions hooks ("Guard…", "Day guard…", shields), Builder "Add a guard", app-wide banner and deep link.
26. e2e: guards (scenarios 1–5, 7), participants (8), book (9).
27. Live path: gates 1–8 wired into fire and one-tap; e2e scenario 6 with the fake broker.
28. Docs: `guides/guards.md`, `participants.md`, `family-book.md`, `safety.md` (guard source and gates), `compliance.md` (family, empanelment, V-register), `notifications.md`; ARCHITECTURE, STREAMS (S25–S27), example config, CHANGELOG; `doctor` checks. **Cut point C: P1-12 complete.**

If the session runs short, ship A and B, and land 13–22 behind `guards.enabled: false` in the next session. Do not ship task 27 without 20–22.

---

## 13. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Users treat the guard as an exchange stop; the Bridge is asleep or offline when the market moves | High | High | Copy on every surface and message; heartbeat gap notices; recommend a broker-side SL in the guide; live auto-exit off by default |
| R2 | A partial exit leaves a naked short (buy-back unfilled, hedge sold) | Medium | High | Shorts first, wait-for-fill, halt-before-hedges rule, `exit_incomplete` urgent notice; tests in `exitRunner.test.mjs` |
| R3 | A double exit over-closes into a reverse position (two guards, or guard + person) | Medium | High | Overlap rule at create/arm, qty capped at the live position at send time, per-account mutex, idempotent `fireId` keys |
| R4 | Wrong P&L basis (broker avg on carried positions) fires early or late | Medium | Medium | Entry captured at arm and editable, basis shown on the card; V6 |
| R5 | Spurious fire from a bad tick or a wide spread | Medium | Medium | Mid with a spread cut-off, ≥ 2 fresh samples over `confirmSeconds`; tests with spike fixtures |
| R6 | Regulatory: bridge-side conditional exits count as algo; the vendor may need empanelment | Medium | High | Off by default in live, white-box, opt-in, under 5/s, generic tag, H5 gate; legal review before enabling by default (V5, BRD §8.1) |
| R7 | NSE changes the participant file URL or layout, or blocks the fetch | Medium | Medium | URL templates in config, header aliases, `PARSE_FAILED` keeps the last good day, status shows the error; demo unaffected |
| R8 | Contract-count history misread across lot revisions | Medium | Low | Revision rules on charts, ratios as headline metrics |
| R9 | Family definition wrong (HUF, adult children) and users are refused or wrongly allowed | Medium | Medium | Config-driven list, doctor and docs, OQ1; refusal text names the fix |
| R10 | The pricing wall leaves Greeks empty for holders without a data account, which feels broken | Medium | Low | Explicit reason in the cell; docs explain why (personal-use data terms) |
| R11 | Scope is large for one session | High | Medium | Cut points A/B/C; guards gated off until complete; tasks independent per module |
| R12 | Stream numbering | Resolved | — | Fixed in `docs/spec/README.md`: guards S25, participants S26, book S27 |
| R13 | Public demo: one visitor's scenario affects others | High | Low | Auto-restore ≤ 10 min, shared-demo notice, the cannot-trade overlay never touches the real kill switch |

## 14. Open questions for the owner (defaults chosen so the build is not blocked)

| # | Question | Default |
|---|---|---|
| OQ1 | Is HUF inside the family for automation? Adult non-dependent children? | No (tag exists, outside the default list) |
| OQ2 | Relationship per holder (this spec) or per account? | Per holder (one person, many accounts) |
| OQ3 | Does a family total count as "pooling data across holders"? | No: each holder is fetched and priced from their own sources; the total is a local display sum |
| OQ4 | Strategy P&L basis default: since entry (broker avg) or since arm? | Since entry, with the entry price shown and editable |
| OQ5 | Should live one-tap from a phone be possible with a non-loopback admin key over a private VPN? | No: live scope or loopback admin, as for tickets |
| OQ6 | After a day guard fires, block new entries on that account for the day? | Not this round (needs a per-account lock; LATER) |
