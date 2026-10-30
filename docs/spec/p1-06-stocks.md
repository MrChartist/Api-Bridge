# Engineering spec P1-6: stock options everywhere (A2, E2 stock part, F7, E1 renames)

Status: ready to build · Owner: tech lead, P1-6 · Date: 29 Oct 2026 · BRD: `docs/brd/options-platform.md` §3.A (A2), §3.E (E1, E2), §3.F (F7), §5.2–5.3 (stores, rate budget), §6.1 P1-6 (acceptance criteria), §7 (NFRs), §8 (compliance)

Builds on: `docs/spec/p1-02-reference.md` (hard), `p1-01-recorder.md`, `p1-03-pricing-vol.md` and `p1-04-streaming.md` (soft; each has an interim behaviour below).

> **Naming, read first.**
> - The BRD calls the reference-data store **S5**. In code, S5 is the *build stream* that owns `market/`. Here "store S5" means the BRD store, served by P1-2's `reference` service.
> - The new server module in this spec is build stream **S19**. P1-2 `reference` is S16, P1-1 `recorder` is S17 and P1-3 `vol` is S18 (final id from the stream table in `docs/spec/README.md`).
> - "Ban" means the exchange F&O ban period (MWPL above the limit). It is never a trading instruction.

> **Not legal or market advice.** Every exchange rule, rate and percentage below that comes from outside this repo is marked **needs verification**. Nothing marked that way becomes a blocking rule until a person has checked it against the primary NSE/NSE Clearing/SEBI source (register in §8.3).

> **Visual styling is out of scope.** The dashboard is being restyled (near-black theme, colour tokens, motion). This spec uses only existing components and the shared tokens (`--warn-ink`, `--neg-ink`, `--a-label`, `--a-quiet`, `--mat-separator`, `--mat-fill-*`). New states are `data-*` attributes or named classes whose look the restyle team owns. No new colours and no new motion.

> **Build order and shared foundations.** This spec is steps 12–13 (P1-6a server tasks 1–8, P1-6b dashboard tasks 9–15) in `docs/spec/README.md`, after P1-2a, P1-2b, P1-3a (P1-1a, P1-4a soft). It uses, and does not rebuild, the F0 foundations listed there: final stream ids, bus topics and error codes pre-registered in core, the opt-in `options` MCP toolset (every MCP tool in this spec goes there), `demo/routes.mjs` plus the OpenAPI demo-only list, `server/lib/jsonl.mjs` (append, torn-line tolerance, last-wins, quarantine of corrupt files), `ratelimit/backgroundGate.mjs` (the one ≤ 50 % background-budget check), `core/ownership.mjs`, and `dashboard/copyRules.mjs` (the one banned-word list). Where this text and README disagree, README's build order and shared-module owners win.

---

## 0. Summary

Today the Options group is index-only. `desk.js` hard-codes six index underlyings (three in demo). Spot quotes come from an index-only symbol map. The screener sweeps from the browser one call every 1.1 s, which would take more than 10 minutes for 180 stocks and stops when the tab is hidden. Warnings assume index rules: the +2% expiry ELM shows on any short, and the ticket says "exercise STT 0.125%". Physically settled stock options are not modelled at all.

P1-6 makes every Options page work for every F&O stock, honestly:

1. **One underlying list from data.** `GET /v1/options/underlyings` merges the point-in-time F&O universe (P1-2 store S5) with the instrument masters. It returns name, kind, settlement type, lot, tick, strike step, freeze, ban/MWPL band and sweep coverage. A searchable picker replaces the `<select>` on all seven Options pages.
2. **Correct contract facts per stock.** Lots and ticks come from the master contract, and the strike step is inferred from listed strikes. Fractional strikes (292.5) display correctly, and index-only rules stop applying to stocks.
3. **A server-side option sweep** (new module `fno`, stream S19) for the screener. It is one sweep at a time, resumable, uses at most 50 % of the data account's budget, and shows progress. Where the account can carry it, the sweep covers all ~180 stocks in ≤ 10 minutes, mostly from batched quotes. Elsewhere it covers an opted-in set and names the limit.
4. **Ban list in the ticket.** A "Ban: no fresh positions" badge appears everywhere. Opening orders in a banned stock's derivatives are refused (paper and live); closing orders pass.
5. **Expiry and physical delivery (F7).** From E-4 to E, ITM and close-to-money stock option legs show:
   - the delivery-margin schedule;
   - the delivery obligation (shares or cash);
   - the cost of letting them settle against squaring off now.

   All of it is computed from store S5 and the charges table, with no literal rates. The stale "0.125 % / 0.1 %" copy goes.
6. **Neutral screener names.** The "Sell premium" and "Buy options" tabs, the Rich/Cheap verdicts and the "Best per expiry" filter are renamed to descriptive labels. A test enforces the banned-word list.

What our data can honestly support:

| Need | Source this round | Quality | If missing |
|---|---|---|---|
| F&O stock list | P1-2 `reference.universe()` (NSE `fo_mktlots`), else masters (stocks with NFO futures) | Point-in-time from first fetch / current only | `source: "masters"`, "membership history not recorded" |
| Lot, tick, freeze | Master contract (`symbols.resolve`); freeze for stocks usually unknown | Authoritative (master) | "freeze qty unknown: slicing not checked" (P1-2) |
| Strike step | Modal gap of listed strikes per expiry (inferred) | Inferred, labelled | Chain still works; step-based helpers say "step unknown" |
| Ban list, MWPL % | P1-2 (NSE archives, user consent) | End of day, authoritative | "Ban list unavailable: NSE archive downloads are off"; order check warns instead of blocking |
| Delivery-margin schedule (E-4…E-1 %) | P1-2 shipped table | Curated, **needs verification** | Schedule hidden; obligation still shown |
| Delivery margin in ₹ | Not available: it needs the stock's VaR + ELM rate | — | % only, plus an *indicative* ₹ when the caller supplies `varElmPct`; broker figure later (P1-10) |
| Delivery STT, stamp | New rows in P1-2 `charges.json` (`physical.*`) | Curated, **needs verification** | — |
| Stock chain ΔOI on the quotes path | Broker chain ΔOI (chain method); P1-1 recorder's previous-close OI; else the first sweep of the day | Labelled per leg (`oiChangeBasis`) | "OI chg since 09:21" |
| Stock HV20 | Daily candles (broker at background priority, or backup Yahoo when on), cached per IST day | Same as indices today | "--" with reason |

---

## 1. Scope

### 1.1 MUST (this round)

| # | Item | BRD hook |
|---|---|---|
| M1 | **Module `fno`** (stream S19), routes plus an internal service, config section `fno`, store `dataDir/fno/`. It is routes-only for other streams (no service contract), like `scanner`. | P1-6 all |
| M2 | **Universe**: `GET /v1/options/underlyings` and `GET /v1/options/underlyings/{underlying}` (contract facts) | AC1 |
| M3 | **Chain additions** (S5, additive): `OptionChain.underlyingKind`, `settlement`, `strikeStep`, `tickSize` | AC1 (lots and ticks) |
| M4 | **Server sweep**: planner (method per broker, feasibility, auto interval), job runner (headroom-gated, resumable, single-flight), results API, opted-in set settings | AC2 |
| M5 | **Ban gate**: safety check `FNO_BAN` (blocks opening, passes closing), with orders supplying `heldQty` only when the underlying is in ban; plus `FNO_BAN_UNCONFIRMED` and `BAN_DATA_UNAVAILABLE` warnings | AC3 |
| M6 | **Expiry and delivery maths** (pure, shared by server and dashboard): `dashboard/expiry-costs.js`; route `POST /v1/options/expiry-costs` | AC4 |
| M7 | **Rate table additions** in P1-2 `reference/data/charges.json` and `REF_DEFAULTS`: `physical.sttDelivery`, `physical.stampBuy`, `physical.txn`, `margin.expiryDayElmIndexShort` | AC4 |
| M8 | **Static test** `dashboard/noLiteralRates.test.mjs`: any rupee warning using a literal rate fails. Removes `options.js:826`, `EXPIRY_DAY_NOTE`, `STT_EXERCISE`, `EXPIRY_ELM` literals | AC4 |
| M9 | **Dashboard**: `underlyings.js` (data and ranking), underlying picker in the shared top bar, `formatStrike`, stock-aware spot symbol, ban chip, contract-facts popover, ticket ban gating and settlement line, positions "Expiry and delivery" panel, strategy warning, index-only rules gated by kind | AC1, 3, 4 |
| M10 | **Screener**: universe selector, server sweep client, coverage line, ban column and filter, tab and label renames with saved-state migration | AC1, 2, 5 |
| M11 | **Demo**: all 50 demo stocks get monthly stock options and futures with realistic lots, steps (including fractional strikes), IV and OI. Adds a non-standard adjusted series, a demo-only ban override route and visible sweep progress | cross-cutting |
| M12 | **API contract**: OpenAPI paths and schemas, MCP read tools `get_option_underlyings`, `get_option_sweep`, `get_expiry_costs` | §7.8 |

### 1.2 LATER (named so nobody builds it now)

| Item | Why later | Goes with |
|---|---|---|
| Delivery margin in ₹ from exchange data | Needs the per-stock VaR file (NSE archives `C_VAR1_*`, layout **needs verification**) or the broker basket-margin API | P1-10 (broker figure), then a P1-2 dataset |
| Previous-day OI from the F&O bhavcopy for the quotes path | One more daily archive file and a contract-level store. P1-3's parser keeps only proxy IV rows | P1-7 or Phase 2 |
| Paper settlement of expired stock options (physical delivery into paper holdings) | The paper engine models no option expiry at all (`paperEngine.mjs` header, v1) | Phase 2 (I-series) |
| Do-not-exercise instructions for close-to-money contracts | Exchange facility status **needs verification** and no broker API is wired | Not planned |
| BSE stock derivatives | Few listed, illiquid; no BSE ban/MWPL source (P1-2 §1.2) | Later |
| Stock IVR/IVP filters in the screener | E2 says after 60 live days; P1-3 tracks stocks only in `vol.stocks` | Phase 2 |
| Beta weighting, covered-call and protective-put scans | E4, H persona | Phase 3 |
| Stock cash-and-carry on the Arbitrage page | Needs the cash leg and borrow assumptions (the page already says LATER) | Phase 2 |
| Event-in-window filter (results dates) | J4 | Phase 2 |
| Streaming the sweep to WebSocket clients | The page polls every 2 s while a sweep runs; nothing else needs push | P1-11 |

### 1.3 Honest fallbacks (where the acceptance criteria meet reality)

- **"Full stock sweep in ≤ 10 minutes."** The BRD §5.3 table assumed chain calls (180+/sweep), which only Upstox and Fyers could afford. For 180 stocks this spec builds stock chains from **batched quotes**: 12 calls on Dhan, 23 on Zerodha (§6.9).
  - Feasible where that table says "no", **if** the adapter's quote returns OI, bid and ask for NFO options. That is **needs verification per adapter** with a fixture (§9.3). Until a broker's fixture passes, the planner treats its quotes path as unavailable.
  - The cost is ΔOI: quotes carry no previous OI. Each leg says where its ΔOI came from (§6.11). The Build-up and Unusual tabs show "OI chg since 09:21" when only the day baseline exists.
  - The 10-minute figure covers the chain pass. HV20 for a stock is fetched once per IST day after the chain pass (or from backup Yahoo). It never holds the chains back, and its progress is shown separately.
- **Delivery margin in rupees.** We cannot compute it without the stock's VaR + ELM rate. We show the schedule percentage and dates (P1-2) and the full delivery obligation in shares and rupees. An indicative ₹ figure appears only when the caller passes `varElmPct`; the dashboard field is optional and labelled "from your broker's contract note". We never invent a VaR rate.
- **Cost of settling a stock option.** Physically settled stock options do **not** pay the option "exercise STT on intrinsic" that cash-settled index options pay. As commonly documented by brokers, the settled leg becomes an equity delivery trade: delivery STT on the contract value at the strike, both sides, plus stamp duty on the buyer. This is **needs verification** against the Finance Act schedule and the NSE Clearing circular. The rates live in the charges table, so a correction is a data change.
  - Many brokers also charge their own fee on physical delivery. That is not in any table; the line says "Broker's delivery charge not included" until P1-10's per-account brokerage plan (G9) adds `physicalPct`.
- **Ban rule granularity.** We refuse an order that **increases the absolute net position in that contract**. A trade in a different contract that reduces the underlying's overall exposure is still refused, because the exchange describes it as a fresh position in that contract (**needs verification**). When live positions cannot be read, we **warn and let the broker decide** rather than block a possible exit (§2.8).
- **Close to money.** No authoritative per-day CTM strike list is used. Our display band is "OTM but within `closeToMoneyStrikes` (1) strike step of spot", labelled as our band, and the exchange definition is marked **needs verification**.
- **Picker quotes.** Last price and change in the picker cost one batched quote read for ~190 symbols. They load after the list, never block it, and are skipped when the account's quote class has no headroom ("prices not loaded").

### 1.4 Dependencies

| Spec | Kind | What P1-6 uses | Interim if not merged |
|---|---|---|---|
| **P1-2** reference | **Hard** | `universe`, `lotFor`, `freezeFor`, `banStatus`, `deliveryMargin`, `calendar`, `charges`, `corporateActions` (inferred non-standard); `reference.js` client module, `REF_DEFAULTS` | Do not start M5, M6 or M9 before P1-2 steps 1–9 land |
| P1-1 recorder | Soft | Previous-close OI for ΔOI on the quotes path; latest snapshot as a zero-call sweep source; demo stock underlyings (M13 there) | ΔOI from the broker chain or day baseline only; the sweep fetches everything; this spec's demo work supersedes P1-1 M13's five stocks |
| P1-3 pricing | Soft | The one IV/Greeks function; vol-time clock; `/v1/vol/summary` for IVR columns | `market/chain.mjs withComputedGreeks` (the seam P1-3 swaps) |
| P1-4 streaming | Soft | Stream patches on stock chains (works for any underlying); stream-first quotes in the sweep | REST refresh, as today |
| P1-10 margin | Later | Broker delivery-margin figure; per-account brokerage including physical delivery | % and indicative only |

---

## 2. Architecture

### 2.1 New and changed files

New, `server/bridge/fno/`:

| File | Purpose |
|---|---|
| `module.mjs` | `defineModule({ name: "fno", stream: "S19", configKey: "fno", configSchema, register, start, stop })` and the `ROUTES` table (§3.1). Registers `/v1/demo/fno` only when `config.demo`. |
| `config.mjs` | `FNO_CONFIG_SCHEMA` (zod, strict), `parseFnoConfig` (§2.5) |
| `universe.mjs` | `createUniverse({ reference, symbols, clock, log })`: builds and caches the underlying list (§2.7). Pure helpers: `strikeStepOf(strikes)`, `settlementOf(kind)`, `mergeUniverse(refItems, masterItems)` |
| `plan.mjs` | Pure: `planSweep({ policy, adapterCaps, stocks, indices, cfg, quotesVerified })` returns `{ method per group, calls, minutes, fits, maxStocksThatFit, autoIntervalSec, message }` (§6.9) |
| `sweep.mjs` | `createSweeper(deps)`: job state machine, headroom gate, single flight, resume, results cache, lease-based auto-repeat (§2.6) |
| `sweepStore.mjs` | NDJSON job files, `state.json`, `oi-base/`, `hv/`, retention; atomic writes (`auth/fsUtil.mjs writeFileAtomic`); torn-line tolerant reader |
| `quotesChain.mjs` | Pure: `chainFromQuotes({ legs, quotes, spot, expiry, underlying, exchange, lotSize, now, greeksFor })` built on `market/chain.mjs rowsFromQuotes`; ΔOI basis merge (§6.11) |
| `routes.mjs` | Handlers |
| `demoFno.mjs` | Demo-only ban override and pacing (§4) |
| `__fixtures__/` | Quote rows for a stock option from Dhan, Zerodha and Upstox documentation (OPTSTK), a universe fixture, a policy table snapshot |
| Tests | §9 |

New, dashboard (add each to `DASHBOARD_FILES` in `core/app.mjs`):

| File | Purpose |
|---|---|
| `dashboard/expiry-costs.js` | **Pure, no imports, no DOM.** ITM/CTM classification, delivery obligation, indicative delivery margin, settle-vs-square-off costs (index and stock). Imported by `fno/routes.mjs` on the server (the P1-3 `pricing.js` pattern) and by the pages. |
| `dashboard/underlyings.js` | Client data module: `loadUnderlyings()` (cached 10 min), `spotSymbolOf(u)`, `kindOf(u)`, `rankUnderlyings(list, q, { recent, held })` (pure), `banChip(u)` |
| `dashboard/underlying-picker.js` | The picker component (§5.2) |

Changed:

| File | Change | Owner |
|---|---|---|
| `core/contracts.mjs` | `SafetyIntent` typedef gains optional `heldQty: number \| null` and `underlyingKind`. `orders.requires` gains `"reference"`. Lead-owned. | lead |
| `core/builtinModules.mjs` | Add `fno` after `reference` (and after `recorder`/`vol` if present) | lead |
| `core/app.mjs` | Three new `DASHBOARD_FILES` entries | lead |
| `docs/openapi.yaml`, `docs/ARCHITECTURE.md`, `docs/STREAMS.md`, `bridge.config.example.json` | §3.8; S19 row; dataDir layout; `fno` section | lead |
| `market/chain.mjs`, `market/marketDataService.mjs` | `chainMeta()` also returns `underlyingKind` (OPTSTK vs OPTIDX from the master), `tickSize` (largest option tick for that expiry) and `strikeStep` (§6.1); `OptionChain` gains the four fields | S5 |
| `orders/orderService.mjs` | In `prepare()`, for an NFO/BFO derivative of a stock: call `reference.banStatus(underlying)`; only when `inBan`, read the held quantity (paper `deps.paper.positions`, live through the existing positions read) and pass `heldQty` in the safety intent | S7 |
| `safety/safetyGuard.mjs` | New rule `fnoBan` (§2.8). Audits refusals as today. | S9 |
| `reference/data/charges.json`, `reference/defaults.mjs`, `dashboard/reference.js` (`REF_DEFAULTS`) | `physical` and `margin` rows (§2.3) | S16, made in this item with S16 review |
| `demo/demoAdapter.mjs`, `demo/demoMode.mjs` | §4 | demo |
| `dashboard/format.js` | `formatStrike(v)` = up to 2 decimals, no trailing zeros | dashboard |
| `dashboard/options.js` | `tradeWarnings`, `bookWarnings`, `strategyWarnings` take `{ rates, kind }`. They emit index or stock expiry lines from `expiry-costs.js`. Removes `STT_EXERCISE`, `EXPIRY_ELM` and the literal at line 826. `straddleVerdict` labels renamed. | dashboard |
| `dashboard/desk.js` | `UNDERLYINGS`/`DEMO_UNDERLYINGS`/`INDEX_SYMBOL` replaced by `underlyings.js` (the exports stay as deprecated fallbacks, §10); picker in the top bar; `EXPIRY_DAY_NOTE` from data; ticket ban gate and settlement line | dashboard |
| `dashboard/positions.js` | `INDEX_SYMBOL` removed; "Expiry and delivery" panel (§5.6); ban chips | dashboard |
| `dashboard/strategy.js`, `strategy-place.js` | Stock expiry warnings; ban gate once per basket | dashboard |
| `dashboard/vol.js`, `oi.js`, `arbitrage.js`, `chain-sheet.js`, `vol-curves.js` | `formatStrike`; stock-aware spot and history symbol; VIX tiles hidden for stocks | dashboard |
| `dashboard/screener.js`, `screens.js`, `views.js` | §5.8; page `sub` text | dashboard |
| `mcp/tools.mjs` | Three read tools | S11 |

### 2.2 Module shape (no new service contract)

Other streams do not call `fno`. Its service lives inside the module (`register` builds `universe` and `sweeper` and passes them to the routes). It requires these deps: `config, logger, bus, clock, paths, scheduler, accounts, symbols, marketData, reference`, plus optional `recorder` and `backupData` (tolerated as stubs). No cycle: nothing depends on `fno`.

Bus topics (internal, added to `core/eventBus.mjs` by the lead):
- `fno.sweep.progress` `{ jobId, status, progress }`, throttled to 1/s;
- `fno.sweep.completed` `{ jobId, status, chains, failed, durationMs }`.

P1-11 alerts can subscribe later.

### 2.3 Data model and storage on disk

Root `dataDir/fno/` (mode 0700). Every JSON file is `{ "version": 1, ... }` and written atomically. A file that fails to parse is renamed `<name>.corrupt-<ts>` and the module starts empty (BRD §7.7).

```
dataDir/fno/
  settings.json              { optIn: { stocks: [...], setAt, setBy }, autoRepeat: { background: false } }
  sweep/state.json           the running or last job: id, day, plan, keys, done, failed, startedAt, finishedAt
  sweep/<jobId>.ndjson       one line per finished chain (resume and reload); current + previous job kept
  oi-base/<YYYY-MM-DD>.json  first OI seen today per contract (quotes path ΔOI); 5 trading days kept
  hv/<YYYY-MM-DD>.json       HV20 per underlying for that IST day; 5 days kept
```

`sweep/<jobId>.ndjson` line (one chain; the `OptionChain` shape plus sweep fields, so the dashboard's `screens.js` reads it unchanged):
```json
{ "key": "RELIANCE|2026-11-23", "seq": 117, "at": "2026-11-19T10:02:41.120+05:30", "method": "quotes",
  "chain": { "underlying": "RELIANCE", "expiry": "2026-11-23", "underlyingKind": "stock", "settlement": "physical",
             "underlyingLtp": 1452.3, "atmStrike": 1460, "lotSize": 500, "tickSize": 0.05, "strikeStep": 20,
             "rows": [ { "strike": 1420, "ce": { "symbol": "NFO:RELIANCE-2026-11-23-1420-CE", "ltp": 34.0, "bid": 33.8, "ask": 34.2,
                          "oi": 1302500, "oiChange": 57500, "oiChangeBasis": "recorder", "volume": 412500, "iv": 24.1,
                          "delta": 0.71, "gamma": 0.0061, "theta": -1.92, "vega": 0.88, "greeksSource": "computed" }, "pe": { "...": "..." } } ],
             "freshness": { "source": "broker", "asOf": "2026-11-19T10:02:40.900+05:30", "stale": false, "accountId": "dhan-main", "broker": "dhan" } } }
```

`state.json`:
```json
{ "version": 1, "job": { "id": "swp_01JC…", "day": "2026-11-19", "status": "running", "requestedBy": "dashboard",
    "plan": { "account": "dhan-main", "groups": [ { "kind": "index", "method": "chain", "keys": 12 }, { "kind": "stock", "method": "quotes", "keys": 180, "calls": 12 } ] },
    "keys": ["NIFTY|2026-11-24", "…"], "done": 131, "failedKeys": { "IDEA|2026-11-23": "SYMBOL_NOT_FOUND" },
    "startedAt": "…", "finishedAt": null, "hv": { "done": 40, "total": 186 } } }
```

`oi-base/<date>.json`: `{ "version": 1, "date": "2026-11-19", "firstAt": { "NFO:RELIANCE-2026-11-23-1420-CE": ["09:21", 1250000] } }` (about 330 KB per day for ~11,000 contracts).

**Charges table additions** (P1-2 `reference/data/charges.json`; mirrored in `REF_DEFAULTS`; each row `verified: false` until checked):
```json
"physical": { "sttDelivery": 0.001, "basis": "strike × quantity (needs verification)", "stampBuy": 0.00015,
              "txn": { "NSE": 0.0000297, "BSE": 0.0000375 }, "verified": false,
              "source": "Equity delivery rates applied to physically settled F&O (Finance Act STT schedule; NSE Clearing physical settlement FAQ; needs verification)" },
"margin": { "expiryDayElmIndexShort": 0.02, "verified": false, "source": "SEBI circular 1 Oct 2024 (extra 2% ELM on short index options on expiry day; needs verification)" }
```
`margin.expiryDayElmIndexShort` is the **single** home of this rate. P1-10's rule row `EXPIRY_ELM_SHORT_INDEX` reads its value from here (`reference.charges().margin`) instead of holding its own copy.
See §8.3 for the BSE txn rate.

### 2.4 Schedulers and timers

All timers are `unref()`'d and cleared in `stop()`. Time is `deps.clock` in IST via `market/time.mjs`.

| Timer | When | Does |
|---|---|---|
| Sweep pump | While a job runs | Starts the next call when `headroom ≥ (1 − budgetShare) × limit` for the class (§2.6). Never `setInterval` faster than 50 ms. |
| Auto-repeat | Minute tick | Starts a sweep when: `autoRepeat` is leased (a dashboard `GET …/current?lease=1` in the last `leaseSeconds`) or `settings.autoRepeat.background`; the session is open (`reference.session()`); and the last job finished at least `plan.autoIntervalSec` ago |
| Day roll | First tick of an IST trading day | Drops yesterday's results cache, starts a new `oi-base` file, retention (5 days for `oi-base`/`hv`, last 2 job files) |
| Universe refresh | On `reference.updated` (lots/universe/ban) and `symbols` master reload, else every 10 min | Rebuilds the list (memory only; < 50 ms) |
| Resume | 5 s after `start()` | If `state.json` has a `running` job from today that started < 30 min ago, it continues with the keys not done; otherwise it marks the job `interrupted` |

### 2.5 Config (`fno` section; all optional; zod `.strict()`)

```jsonc
"fno": {
  "universe": {
    "indices": null,                 // null = every index with listed options in the masters (data, not constants)
    "exchanges": ["NFO"],            // BFO stock derivatives LATER
    "maxStocks": 400
  },
  "sweep": {
    "budgetShare": 0.5,              // max share of each policy window the sweep may use (BRD §7.2); 0.1–0.5
    "accountId": "auto",             // auto = marketDataCandidates() order; never pools across holders
    "maxMinutes": 10,                // the AC target; the planner shrinks the stock set to fit
    "method": "auto",                // auto | chain | quotes (quotes needs a verified adapter fixture)
    "indexExpiries": 2, "indexMonthly": true, "indexStrikes": 30,
    "stockExpiries": 1, "nextExpiryWithinDays": 7, "stockStrikes": 15,
    "hv": { "source": "auto", "candles": 40 },   // auto = backup when on, else broker at background priority
    "minIntervalSeconds": 120,       // floor between auto sweeps; the planner may raise it (daily caps)
    "leaseSeconds": 180,
    "resumeWithinMinutes": 30,
    "keepJobs": 2
  },
  "expiry": {
    "warnFromTradingDays": 4,        // E-4 (BRD AC4)
    "closeToMoneyStrikes": 1          // our display band, not an exchange definition
  },
  "ban": { "blockOpening": true },   // false turns FNO_BAN into a warning (never recommended; audited at boot)
  "retentionDays": 5,
  "demo": { "callDelayMs": 250 }     // honoured only in demo mode
}
```

Validation: `stockStrikes` 5–30; `indexStrikes` 10–60; `stockExpiries` 1–2; `budgetShare` 0.1–0.5 (the BRD cap is a ceiling); `minIntervalSeconds` ≥ 60.

### 2.6 Sweep algorithm

1. **Single flight.** If a job is `queued` or `running`, `POST /v1/options/sweeps` returns it (`joined: true`). If the last job finished less than `minIntervalSeconds` ago and `force` is not set, it returns that job (`reused: true`). So there is never a second concurrent sweep, across tabs, scripts and the scheduler.
2. **Plan.** Resolve the data account: config `accountId`, else the first `accounts.marketDataCandidates({ capability: "quotes" })`. Read `scheduler.policyFor(broker)` and the adapter's capabilities.
   - Build the key list: indices × `indexExpiries` (+ monthly), then stocks (requested set ∩ universe, minus `SYMBOL_NOT_FOUND`).
   - Stock expiry selection is in §6.10.
   - `planSweep()` picks the method per group and checks `fits` (§6.9). If not everything fits, stocks are trimmed to `optIn.stocks` first, then by name, and `limited: true` carries the message.
3. **Spots first.** One `marketData.quotes(spots, { priority: "background", accountId })` call for every stock and index spot (chunked at 200 by the route limit, merged by the batcher into `maxQuoteBatch` calls). This sets each stock's ATM, hence its ±`stockStrikes` window.
4. **Index chains** with `method: "chain"`: `marketData.optionChain({ underlying, expiry, strikes, greeks: true }, { priority: "background", accountId, maxAgeMs: 5000 })`, one key at a time through the gate.
5. **Stock chains**:
   - `chain` method: as step 4.
   - `quotes` method: the master legs in the window for all stocks (`symbols.search`, no broker call), then `marketData.quotes(legs)` in chunks of 200, all queued at once so the batcher fills `maxQuoteBatch`. Then `chainFromQuotes()` per key, which computes Greeks through the same seam as `/v1/optionchain`.
6. **Gate.** Before each scheduled call: `const h = scheduler.headroom(accountId, cls)`. Proceed only if `h.remaining − cost ≥ ceil((1 − budgetShare) × h.limit)`; else wait `h.resetMs` (capped at 2 s) and re-check.
   - Calls go at `priority: "background"`, so interactive and order traffic always goes first (scheduler priority queue).
   - On `UPSTREAM_RATE_LIMITED` the job pauses for `retryAfter`. Fyers rate errors are never retried (policy note). The job then continues with the next key.
7. **ΔOI** per leg (§6.11). The first quote seen today for a contract is written to `oi-base`.
8. **Write.** Each finished chain is appended to `sweep/<jobId>.ndjson` with a rising `seq`, added to the in-memory cache, and progress is emitted.
9. **HV pass** (after chains): for every underlying without today's HV20, call `marketData.history({ symbol: spotSymbol, interval: "1d", countback: 40 }, { priority: "background", allowBackup })`, or `backupData.history` when `hv.source` says so. The result goes into `hv/<date>.json` and is reported as `hv: { done, total }`.
10. **Finish.** `status: "done" | "partial" | "cancelled" | "failed"` (`partial` when some keys failed), `durationMs`, `calls` by class, and a `fno.sweep.completed` event.

Cancel (`DELETE …/current`) aborts in-flight calls through their `signal` and keeps finished chains.

### 2.7 Universe assembly

`underlyings()` returns:

1. **Indices**: underlyings with `instrumentType` OPTIDX in any loaded master (`symbols.search({ kind: "OPT", exchange })`, paged as `scanner/universes.mjs fnoStocks` does), or `fno.universe.indices` when set. Order: indices with a weekly expiry in the listed expiries first (found from data, never a constant), then the rest alphabetically (§6.12).
2. **Stocks**:
   - `reference.universe({ date: today, kind: "stock" })` when `coverage: "recorded"`;
   - else master underlyings with NFO `FUTSTK`/`OPTSTK` contracts (`source: "masters"`).
   - Intersect with masters, so a stock with no listed contract at this broker is dropped and counted in `missingAtBroker`.
3. **Per item**:
   - `name` from the cash instrument (`NSE:<SYMBOL>` `name`), `exchange` (`NFO`), `kind`, `settlement` (§6.1);
   - `lot` from `reference.lotFor` (current and next), else the master;
   - `tickSize` and `strikeStep` from the nearest expiry's master legs (§6.1);
   - `freezeQty` from `reference.freezeFor`;
   - `ban` from `reference.banStatus` (`inBan`, `mwplPct`, `band`, `forDate`) or `null` with the reason;
   - `events` count from `reference.events({ days: 7, underlying })`;
   - `nonStandard: true` when P1-2 inferred an adjusted contract;
   - `sweep: { covered, method, limitedReason }` from the last plan.

### 2.8 Ban gate flow (orders → safety)

```
orders.prepare(body)
  resolved = symbols.resolve(symbol)                       (existing)
  if resolved.kind ∈ {OPT, FUT} and underlying kind is stock:
     ban = reference.banStatus(resolved.underlying, today)   (memory; no I/O)
     if ban.available === false → check BAN_DATA_UNAVAILABLE (warn) "Ban list not loaded (NSE archive downloads are off); the exchange may refuse fresh positions."
     if ban.inBan:
        heldQty = paper ? paper.positions(account).netQty(symbol)            (memory)
                        : liveNetQty(account, symbol)                        (one positions read, priority "order"; reused by syncLivePnl in the same prepare)
        on read failure → heldQty = null
  safety.check(ctx, { ...intent, underlyingKind, heldQty, ban })
safety.fnoBan:
  if !ban?.inBan → pass
  signed = side === BUY ? +qty : −qty
  if heldQty === null → warn FNO_BAN_UNCONFIRMED "RELIANCE is in the F&O ban. This order is allowed only if it reduces a position; the Bridge could not read your positions, so the broker decides."
  else if |heldQty + signed| > |heldQty| or sign flips past zero → block FNO_BAN (message per §6.8)
  else pass, with warn "Closing order in a ban-period stock."
```

Only stock derivatives in ban pay the extra positions read. Index orders, cash orders and stocks not in ban are unchanged and cost nothing extra. A cancel is never blocked. A modify that raises quantity on an opening order in ban is checked with the new quantity. `ban.blockOpening: false` downgrades `FNO_BAN` to a warning, logged at boot and audited on each order.

---

## 3. API changes

All new routes belong to module `fno` (`x-stream: S19`). Responses are `{ data, meta }`. Dates are IST `YYYY-MM-DD`, times ISO with `+05:30`, money in ₹, quantities in units, rates as decimals. Nothing here can place an order or enable live trading.

### 3.1 Route table

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/v1/options/underlyings` | read | Picker list: indices and F&O stocks with contract facts and ban band |
| GET | `/v1/options/underlyings/{underlying}` | read | One underlying: facts, expiries, delivery schedule for the nearest expiry, sweep coverage |
| POST | `/v1/options/expiry-costs` | read | Pure maths: settle vs square-off, obligation, delivery schedule (§6.2–6.7) |
| POST | `/v1/options/sweeps/plan` | read | Dry run: method, calls, minutes, what fits |
| POST | `/v1/options/sweeps` | read | Start (or join) the sweep |
| GET | `/v1/options/sweeps/current` | read | Status, progress, plan; `?lease=1` keeps auto-repeat alive |
| GET | `/v1/options/sweeps/current/chains` | read | Finished chains after a cursor |
| DELETE | `/v1/options/sweeps/current` | read | Cancel the running sweep |
| GET | `/v1/options/sweeps/settings` | read | Opt-in stock list, auto-repeat |
| PUT | `/v1/options/sweeps/settings` | admin, loopback | Save the opt-in list and the background switch |
| POST | `/v1/demo/fno` | admin, loopback, **demo only** | Force a ban list for testing (§4) |

Starting and cancelling use `read` scope, as `/v1/scanner/jobs` does. A sweep is bounded (one at a time, ≤ 50 % budget, background priority) and changes no shared setting. Any key can cancel the current sweep; the next lease restarts it. This is documented.

### 3.2 Common errors

| Code | When |
|---|---|
| `VALIDATION_FAILED` 400 | Bad body or query, unknown `kind`, `legs` over 40, `asOf` not a date, `varElmPct` outside 1–100 |
| `SYMBOL_NOT_FOUND` 404 | Underlying not in the universe or masters |
| `NOT_FOUND` 404 | `GET …/current` (or `/chains`) when no sweep has run today |
| `BROKER_UNAVAILABLE` 503 | No connected account can serve quotes or chains |
| `CAPABILITY_UNSUPPORTED` 422 | `method: "quotes"` forced on a broker whose quotes path is not verified |
| `SCOPE_REQUIRED` / `LOOPBACK_ONLY` 403 | Settings write and demo route |
| `RATE_LIMITED` 429 | The existing per-key limiter |

Unavailable data is **not** an error. It returns 200 with `available: false` and `reason` (BRD D5).

### 3.3 `GET /v1/options/underlyings?kind=all|index|stock[&q=reli][&withQuotes=1]`

Memory only unless `withQuotes=1`, which adds one batched quote read (interactive priority, cached 60 s, skipped with `quotes: { loaded: false, reason: "NO_HEADROOM" }` if the quote class has < 2 tokens; a per-second window that refills within 1 s is waited for once first). The `q` filter uses the same ranking as the picker (§6.12). p95 < 10 ms without quotes.

```json
{ "data": {
    "asOf": "2026-11-19T10:02:11.000+05:30",
    "source": { "universe": "reference:fo_mktlots", "knownSince": "2026-10-29", "masters": ["dhan"] },
    "counts": { "index": 6, "stock": 182, "inBan": 3, "missingAtBroker": 1 },
    "items": [
      { "underlying": "NIFTY", "name": "NIFTY 50", "kind": "index", "exchange": "NFO", "spot": "NSE:NIFTY",
        "settlement": "cash", "lot": 65, "nextLot": null, "tickSize": 0.05, "strikeStep": 50, "freezeQty": 1800,
        "weekly": true, "ban": null, "events": 0, "nonStandard": false,
        "sweep": { "covered": true, "method": "chain" }, "quote": { "ltp": 25412.35, "changePct": 0.42 } },
      { "underlying": "RELIANCE", "name": "Reliance Industries", "kind": "stock", "exchange": "NFO", "spot": "NSE:RELIANCE",
        "settlement": "physical", "lot": 500, "nextLot": { "lot": 500, "from": null }, "tickSize": 0.05, "strikeStep": 20,
        "freezeQty": null, "weekly": false,
        "ban": { "inBan": false, "mwplPct": 84.2, "band": "high", "forDate": "2026-11-19", "asOf": "2026-11-18" },
        "events": 1, "nonStandard": false, "sweep": { "covered": true, "method": "quotes" }, "quote": null } ] },
  "meta": { "requestId": "…" } }
```

`ban` is `null` for indices. For a stock with no ban data it is `{ "available": false, "reason": "SOURCE_OFF" }`. `strikeStep` is `null` when fewer than 3 strikes are listed.

### 3.4 `GET /v1/options/underlyings/{underlying}`

Everything in the list item, plus:
```json
{ "expiries": [ { "date": "2026-11-23", "kind": "monthly", "lot": 500, "shifted": true, "ruleDate": "2026-11-24",
                  "strikeStep": 20, "strikes": 61, "tickSize": 0.05 } ],
  "deliveryMargin": { "expiry": "2026-11-23", "verified": false, "source": "…",
                      "items": [ { "day": "E-4", "date": "2026-11-17", "pct": 10 }, { "day": "E-3", "date": "2026-11-18", "pct": 25 },
                                 { "day": "E-2", "date": "2026-11-19", "pct": 45 }, { "day": "E-1", "date": "2026-11-20", "pct": 70 } ],
                      "today": { "day": "E-2", "pct": 45 } },
  "settlementPrice": { "method": "closing price of the underlying in the cash market (needs verification)", "window": "last 30 minutes (vol.clock.settlementWindowMinutes.stock)" },
  "nonStandardContracts": [ { "symbol": "NFO:…", "lot": 1875, "reason": "lot differs from the series lot 375 (inferred)" } ],
  "rules": [ "No weekly expiry for stock options.", "European exercise; physically settled.", "Extra expiry-day ELM applies to index options only." ] }
```
Indices: `deliveryMargin: { available: false, reason: "INDEX_CASH_SETTLED" }`.

### 3.5 `POST /v1/options/expiry-costs` (read; pure, stores nothing)

Request:
```json
{ "underlying": "RELIANCE", "asOf": "2026-11-19", "spot": 1452.30, "varElmPct": 20,
  "account": "paper-1",
  "legs": [ { "symbol": "NFO:RELIANCE-2026-11-23-1420-CE", "qty": 500, "bid": 33.80, "ask": 34.20 } ] }
```
- `qty` is signed units (+ long, − short).
- `spot`, `bid` and `ask` are optional; the server fills missing ones from cached quotes (no new broker call; `null` if none cached).
- `account` is optional; it is used only to read holdings, to say whether a short call's delivery is covered (one holdings read, priority interactive, cached 60 s).
- `asOf` defaults to today. Any future trading day up to the expiry gives a what-if, labelled.

Response:
```json
{ "data": {
    "asOf": "2026-11-19", "day": "E-2", "inWindow": true, "settlement": "physical", "spot": 1452.30, "strikeStep": 20,
    "rates": { "asOf": "2026-04-01", "verified": false, "source": "…" },
    "legs": [ {
      "symbol": "NFO:RELIANCE-2026-11-23-1420-CE", "qty": 500, "moneyness": "ITM", "intrinsic": 32.30,
      "obligation": { "kind": "receive-shares", "shares": 500, "cash": -710000, "text": "Buy 500 RELIANCE at 1420 (₹710000)" },
      "deliveryMargin": { "pct": 45, "indicative": 65353.5, "basis": "45% × 20% VaR+ELM × 1452.30 × 500 (your input)" },
      "settle": { "total": 842.22, "lines": [ { "key": "sttDelivery", "value": 710.0 }, { "key": "stamp", "value": 106.5 },
                  { "key": "txn", "value": 21.09 }, { "key": "sebi", "value": 0.71 }, { "key": "gst", "value": 3.92 } ],
                  "excluded": [ "Broker's physical-delivery charge" ] },
      "squareOff": { "price": 33.80, "side": "SELL", "total": 55.96, "lines": [ "…" ] },
      "covered": null } ],
    "notes": [ "Delivery STT basis and rates need verification against the Finance Act schedule." ] },
  "meta": { "requestId": "…" } }
```
- Index legs return `settlement: "cash"`, with `settle` = exercise STT on intrinsic (+ exercise brokerage per the profile) and no obligation.
- OTM legs beyond the CTM band return `moneyness: "OTM"` with zero settle cost.
- Outside the window the response still computes, with `inWindow: false`.

### 3.6 Sweep routes

`POST /v1/options/sweeps/plan` and `POST /v1/options/sweeps` take the same body (all optional):
```json
{ "underlyings": "indices+stocks", "stocks": "all", "force": false, "method": "auto" }
```
- `underlyings`: `indices` | `stocks` | `indices+stocks` | an array of names.
- `stocks`: `all` | `optIn` | an array of names.

Plan response:
```json
{ "data": { "account": { "id": "dhan-main", "broker": "dhan" }, "fits": true, "limited": false,
    "groups": [ { "kind": "index", "method": "chain", "keys": 12, "calls": 12, "class": "chain", "ratePerMin": 10, "minutes": 1.2 },
                { "kind": "stock", "method": "quotes", "keys": 182, "calls": 12, "class": "quote", "ratePerMin": 30, "minutes": 0.4 } ],
    "minutes": 1.6, "hv": { "calls": 186, "source": "broker", "minutes": 1.2 },
    "autoIntervalSec": 120, "maxStocksThatFit": 182,
    "message": "This account can sweep 6 indices and all 182 stocks in about 2 minutes (Dhan quotes, 50% budget).",
    "quotesVerified": true, "basis": "dhan policy: chain 20/min (unverified), quote 1/s × 1000 instruments" } }
```
When not everything fits:
```json
"limited": true, "maxStocksThatFit": 35,
"message": "This Fyers account can sweep 35 stocks in 10 minutes with 2 expiries each (expiry week). Your opted-in list has 40; the first 35 are covered."
```

Start returns **202** `{ data: SweepJob }` for a new job, or **200** with `joined: true` / `reused: true`.

`SweepJob`:
```json
{ "id": "swp_01JC…", "status": "running", "requestedBy": "dashboard", "startedAt": "…", "finishedAt": null,
  "plan": { "…": "as above" },
  "progress": { "total": 194, "done": 131, "failed": 1, "phase": "stock-chains", "current": "SBIN|2026-11-23",
                "etaSeconds": 22, "calls": { "quote": 9, "chain": 12 }, "hv": { "done": 0, "total": 186 } },
  "cursor": 131, "joined": false, "reused": false, "lease": { "until": "…" } }
```

`GET /v1/options/sweeps/current/chains?since=<seq>&limit=40` returns `{ items: [ { key, seq, at, method, chain } ], nextCursor, done }`. Items have `seq > since`, oldest first, at most 40 per page. `hv: { "<U>": 18.4 }` is included on the last page.

`PUT /v1/options/sweeps/settings` (admin, loopback). Body `{ "optIn": ["RELIANCE", "SBIN"], "background": false }`. `optIn` is at most `universe.maxStocks`; unknown names give 400 with the list. Stored in `settings.json` with `setBy` and `setAt`, and audited `fno.settings.updated`. In demo it applies in memory only (`persisted: false`).

### 3.7 Orders, safety and chain changes (additive)

- **Preview checks** (new codes, documented in the `Check.code` description):

  | Code | Severity | Text |
  |---|---|---|
  | `FNO_BAN` | block | "RELIANCE is in the F&O ban period (MWPL 96.2 %, 19 Nov). Only orders that reduce your position are allowed. You hold −600 of this contract: you can buy up to 600." |
  | `FNO_BAN_UNCONFIRMED` | warn | §2.8 |
  | `BAN_DATA_UNAVAILABLE` | warn | §2.8 |
  | `PHYSICAL_SETTLEMENT` | warn | From E-4, on an opening order in an ITM/CTM stock option: "Physically settled: if ITM at expiry you buy 500 RELIANCE at 1420 (₹710000). Delivery margin today: 45 % of the delivery margin (E-2)." |

  A refused place returns `422 INVALID_ORDER` with `errors[].path = "FNO_BAN"` (the existing `refusalError` mapping; no new `BridgeError` code).
- **`/v1/optionchain`** (S5): `data` gains `underlyingKind` (`index`|`stock`), `settlement` (`cash`|`physical`), `strikeStep` (number|null) and `tickSize` (number|null). `ChainLeg` gains optional `oiChangeBasis` (`broker`|`recorder`|`day-baseline`|`null`), present only on sweep chains.
- **MCP** (read only): `get_option_underlyings { kind?, q? }`, `get_option_sweep { since? }` (status plus one page), `get_expiry_costs { legs, asOf?, spot?, varElmPct? }`. There is no MCP tool to start a sweep: an AI client reads the last sweep; it does not spend the account's budget.

### 3.8 `docs/openapi.yaml` additions

- `tags`: `- name: Options desk` with description "F&O underlyings, expiry and delivery costs, and the option sweep behind the screener (stream S19)."
- `components/schemas`:
  - new: `FnoUnderlying`, `FnoUnderlyingDetail`, `FnoBan` (`inBan`, `mwplPct`, `band` enum `[ban, high, normal]`, `forDate`, `asOf`, or `available: false` + `reason`), `ExpiryCostsRequest`, `ExpiryCostsLeg`, `ExpiryCostsResult`, `SweepRequest`, `SweepPlan`, `SweepJob`, `SweepChainsPage`, `SweepSettings`;
  - `OptionChain`: the four optional fields; `ChainLeg`: `oiChangeBasis`.
- `Check.code` description: list `FNO_BAN`, `FNO_BAN_UNCONFIRMED`, `BAN_DATA_UNAVAILABLE`, `PHYSICAL_SETTLEMENT` among the known codes, documented as an open set.
- Eleven `paths` (ten in the main table; the demo route carries `x-demo-only: true`). `openapi.test.mjs` reads `x-stream: S19`, `x-scope`, `x-loopback-only`. Example:

```yaml
  /v1/options/sweeps:
    post:
      tags: [Options desk]
      operationId: startOptionSweep
      summary: Start the option sweep, or join the one already running
      description: >-
        One sweep runs at a time for the whole Bridge. It uses at most fno.sweep.budgetShare (50 %) of the data account's
        rate budget at background priority, so your own chain and order calls always go first. Returns 202 for a new
        sweep, or 200 with joined or reused set.
      x-stream: S19
      x-scope: read
      requestBody:
        required: false
        content:
          application/json:
            schema: { $ref: "#/components/schemas/SweepRequest" }
      responses:
        "200":
          description: The running sweep (joined) or a recent finished one (reused).
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { $ref: "#/components/schemas/SweepJob" }
                  meta: { $ref: "#/components/schemas/Meta" }
        "202":
          description: A new sweep was started.
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { $ref: "#/components/schemas/SweepJob" }
                  meta: { $ref: "#/components/schemas/Meta" }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }
```
- `/v1/expiries` and `/v1/optionchain` keep their parameters. `/v1/optionchain`'s description gains "Works for every F&O stock; see /v1/options/underlyings."
- **AsyncAPI**: no change this round (sweep progress is polled).

---

## 4. Demo mode

Goal: with `mc-bridge start --demo`, every P1-6 feature is visible and testable without a broker or the network.

### 4.1 Demo adapter (`demo/demoAdapter.mjs`)

| Change | Detail |
|---|---|
| Stock derivatives | Every `kind: "EQ"` demo stock gets `deriv: "NFO"`, `expiry: "monthly-tue"`, futures (`FUTSTK`) and options (`OPTSTK`) for the nearest **3** monthly expiries (last Tuesday, shifted by P1-2's demo holiday rule). Indices keep `FUTIDX`/`OPTIDX`. |
| Lots | `lot = max(25, round(750000 / base / 25) × 25)` (P1-2 §4's demo formula), e.g. RELIANCE 1418 → 525, TATASTEEL 168 → 4475, MARUTI 15900 → 50. The one table, `DEMO_STOCK_LOT`, is **owned by P1-2** (`reference/demoReference.mjs`, generated at module load) and already used by P1-1's five demo stock underlyings; this item imports it, so masters and reference agree. |
| Strike steps (demo table, labelled demo; real steps come from masters) | base < 100: 1 · 100–250: 2.5 · 250–500: 5 · 500–1000: 10 · 1000–2500: 20 · 2500–5000: 50 · 5000–10000: 100 · ≥ 10000: 250. TATASTEEL (168) therefore lists 165, **167.5**, 170: fractional strikes are always on screen. |
| Strikes listed | ±20 steps around the IST-day centre (indices keep ±60). `fetchOptionChain` returns ±20 for stocks. |
| IV | `u.iv = 0.20 + 0.25 × unit(symbol)` (20–45 %), with P1-3's time-varying `ivLevel` when that lands. Stock smile: the existing `smileVol` with a flatter put wing (`putWing 0.35` vs index 0.8). |
| OI and volume | The P1-1 time-varying `openInterest` with `oiScale` 0.15 for stocks, so OI near the money is about 1,000–2,500 lots. OI stays a multiple of the lot. Volume as today, scaled the same way. |
| Quotes for options | `fetchQuotes` returns `oi` (units), `bid`, `ask`, `bidQty`, `askQty`, `volume` for option tokens, so the **quotes path** runs in demo. No previous OI (like real brokers). |
| Non-standard series | On P1-2's demo split stock, the nearest expiry also lists 6 adjusted contracts with lot × 5 and off-grid strikes (strike / 5 rounded to 0.05), with token suffix `-ADJ`. P1-2 inference flags them and the chain marks them. |
| Delivery-window visibility | No date tricks. The positions panel and `POST /v1/options/expiry-costs` take `asOf`, so "E-2" is shown any day. The e2e uses `asOf` too. |

### 4.2 Demo services

- **Ban**: P1-2's demo rotates 2–3 stocks into ban daily. `POST /v1/demo/fno { "ban": ["RELIANCE"], "minutes": 30 }` (demo only, admin, loopback) forces a list on top. It is in memory only and listed in `/v1/options/underlyings` with `source: "demo-override"`. This makes the "close allowed, open refused" path testable after opening a paper position.
- **Sweep plan in demo** exercises both methods: indices by `chain` (demo chain 5/s → 2.5/s budget), stocks by `quotes` (batch 200: 50 × 82 legs + 53 spots ≈ 4,153 instruments → 21 calls).
  - `fno.demo.callDelayMs` (250 ms) paces calls, so the progress bar is visible for about 15 s.
  - HV comes from demo daily candles.
  - ΔOI on the quotes path: the demo seeds `oi-base` at 09:15 from the OI formula at the previous close, so ΔOI is basis `day-baseline`, labelled "since 09:15 (demo)".
- **Holdings**: the demo paper account can buy RELIANCE shares (CNC), so "covered short call" can be shown.
- Every demo value is labelled `source: "demo"`, and the top bar keeps the single demo indicator.

### 4.3 Demo screenshots (PR)

Captured at 390×844, 820×1180 and 1440×900, dark and light:
- picker with search "rel";
- RELIANCE chain with the physical-settlement chip;
- TATASTEEL chain showing 167.5;
- ticket refused for a banned stock;
- positions "Expiry and delivery" at E-2;
- screener sweep in progress;
- High IV vs history tab.

---

## 5. Dashboard

Only existing components (`sheetPopover`, `modal`, `segmented`, `alertBox`, `emptyState`, `freshnessPill`, `chip-btn`) and shared tokens are used. New classes are named; their look belongs to the restyle team. All copy is descriptive; the banned-word test (§9.4) covers new strings.

### 5.1 Shared pieces

- `format.js`: `formatStrike(v)` = `formatNumber(v, { maximumFractionDigits: 2 })`. Every strike in every Options page uses it (about 69 call sites; static test §9.4).
- `underlyings.js`:
  - `loadUnderlyings({ force })` calls `GET /v1/options/underlyings`, cached 10 minutes and refreshed on focus. If the route is missing (older Bridge), it falls back to the old `UNDERLYINGS` list, labelled.
  - `spotSymbolOf(u)` returns the item's `spot` (replaces both `INDEX_SYMBOL` maps and the screener/vol `indexSymbol`).
  - `kindOf(u)`, `settlementOf(u)`.
  - `rankUnderlyings()` (§6.12), `recent()` and `pushRecent(u)` (`localStorage` `mcb.dashboard.recentU`, max 8, try/catch).
- The desk state accepts any underlying in the list (not only indices). A saved `prefs.underlying` that is no longer listed falls back to the first index, with a toast "RELIANCE is no longer in the F&O list".

### 5.2 Underlying picker (every Options page's top bar, `ctx-u`)

Replaces the transparent `<select>` (foundation §5.2) with a button that keeps the same two-line label ("RELIANCE ▾" / "1452.30 +0.6%") and opens a **combobox** (WAI-ARIA combobox + listbox pattern).

- **Opens with**: click/tap, Enter/Space on focus, or the `U` key on any Options page (added to the chain's `?` list).
- **Search field** first and focused. Typing filters with `rankUnderlyings`. `inputmode="search"`, `autocapitalize="characters"`.
- **Sections** (when the query is empty):
  - Indices;
  - In your positions (underlyings with open legs in the selected account);
  - Recent;
  - F&O stocks (A–Z, with a count "182 stocks").
- **Row**: symbol (bold), name (quiet ink), a lot chip `Lot 500`, and chips when relevant: `Ban` (class `fno-ban`, `--neg-ink` token), `MWPL 87%` (class `fno-mwpl-high`, `--warn-ink`), `1 event`, `Adjusted`. On the right: LTP and % change once quotes load (`withQuotes=1`, after first paint).
- **Keyboard**: ↑/↓ move, PgUp/PgDn ±10, Home/End, Enter picks, Esc closes and restores focus to the button. The active row is `aria-activedescendant`. Typing in the list area moves focus to search.
- **Empty and error**: "No F&O underlying matches 'xyz'." If the list failed, "Could not load the F&O list. Showing indices only." with Retry.
- **Footer line**: "F&O list from NSE market lots, 19 Nov · 182 stocks · 3 in ban", or "from your broker's instrument master (NSE downloads are off)".
- **Picking** sets the underlying for all Options pages (shared desk state), pushes it to Recent, re-reads expiries and the reference bundle, and keeps the page.
- **Phone (< 720)**: full-height bottom sheet; search at the top; rows 52 px (two lines: symbol + name / chips + price); a sticky section header.
- **Tablet (720–1023)**: popover 420 px wide, max-height 70 vh.
- **Desktop (≥ 1024)**: popover 480 px wide anchored under `ctx-u`, max-height 560 px.
- **Performance**: the list renders up to 60 rows and then windows (virtual list with a fixed row height). Filtering 200 items is < 2 ms.

### 5.3 Top bar and contract facts

- `lotItem` keeps "Lot 500". For a stock, the capsule adds a quiet sub-line "Stock · physical" on desktop (in the ⋯ sheet on tablet/phone).
- **Ban chip** after the expiry: `Ban` when in ban, `MWPL 87%` when the band is high. Tapping either opens the P1-2 "Contract facts" popover. P1-6 adds rows to it: settlement type, strike step (with "inferred"), tick size, ban/MWPL with date and source, and, for stocks from E-4, the delivery schedule line "E-2 today: delivery margin 45 % · ITM and close-to-money positions".
- `EXPIRY_DAY_NOTE` (literal rates) is removed. The "Expiry today" chip's title comes from `expiryDayNote({ kind, rates })` in `expiry-costs.js`:
  - index: "Short index options carry an extra 2 % ELM today (rate from the charges table). Long ITM options left to settle pay exercise STT of 0.15 % of intrinsic; squaring off pays 0.15 % of the premium instead";
  - stock: "Physically settled today: ITM long calls and short puts take delivery of shares, ITM long puts and short calls give delivery."
  - Every figure is rendered from `rates`.

### 5.4 Option Chain (`desk.js`)

- Works for any listed underlying. Spot comes from `spotSymbolOf(u)` (the stock's cash quote). `FETCH_STRIKES` stays; stocks list fewer strikes, which the existing code handles.
- Summary strip, stock only: an item `Settles` = "Physical", with sub "E-3 · margin 25 %" inside the window; and a `Ban` item when in ban (value "Ban", sub "no fresh positions", class `fno-ban`).
- Rows of non-standard (adjusted) contracts carry `data-adjusted` and a small "Adj" tag on the strike cell, with the title "Lot 1875, adjusted for a corporate action (inferred)". The chain's lot column and the ticket use that contract's own lot.
- Strike search accepts decimals ("167.5").
- **0DTE claims**: "Expires today" chip logic stays. The `THETA_0DTE` warning text says "today" for any underlying (it is factual). No copy says "0DTE" for stocks or monthly-only indices (BRD §8.1).

### 5.5 Order ticket (`desk.js openTicket`) and strategy place

- **Ban gate (client side, the server decides)**: when `ban.inBan`, the ticket header shows the `Ban` chip.
  - If the order would open or increase a position (no held quantity, or same side), the Place button stays disabled and the line reads: "RELIANCE is in the F&O ban period: no fresh positions. Closing orders are allowed." The preview still runs and shows `FNO_BAN` from the server.
  - Exit tickets (`exit: true`) and closing quantities are allowed.
  - Partial cross: the quantity stepper caps at the held quantity, with the hint "max 600 to close".
- **Settlement line** (stock options only): one quiet line under the price: "Physically settled · if ITM at expiry: buy 500 shares at 1420 (₹710000)". From E-4 it adds "· delivery margin today 45 % (E-2)". It is informational and blocks nothing.
- The `EXPIRY_ELM` warning appears only for index options (`kind === "index"`) and reads its rate from `rates.margin.expiryDayElmIndexShort`. The `EXPIRY_STT` warning becomes `EXPIRY_SETTLE`, with text from `expiry-costs.js` (index: exercise STT vs square-off; stock: delivery charges and obligation vs square-off). Both are rupee figures from the rate table.
- `strategy-place.js` applies the ban gate once per basket (legs that open in a banned stock are listed and the basket cannot be sent; legs that close can).

### 5.6 Positions (`positions.js`)

- Spot from `spotSymbolOf`. The book's warnings come from the rewritten `bookWarnings(legs, { spot, now, rates, kind, calendar })`:
  - `elm` for index shorts only;
  - `settle` (was `stt`) for long ITM index options on expiry day;
  - `delivery` for stock option legs ITM/CTM from E-4: "500 RELIANCE 1420 CE is ITM, E-2: delivery margin 45 %; obligation ₹710000".
- **New panel "Expiry and delivery"** (`pos-expiry`, after the warnings strip). It is shown for any book with stock option legs and collapsed by default unless a leg is inside the E-4 window.
  - **Controls**: an "As of" segmented `Today · E-4 · E-3 · E-2 · E-1 · E` (dates in the titles; uses `reference.calendar()` E-n dates). An optional numeric field "VaR + ELM % (from your broker)" (empty by default, kept in desk prefs) that unlocks the indicative ₹ margin.
  - **Table**, one row per stock option leg: contract · qty · moneyness (ITM / Close to money / OTM, with text, not colour alone) · obligation ("Buy 500 at 1420 · ₹710000" / "Deliver 500 shares · you hold 500 in this account") · delivery margin % (and indicative ₹) · "If it settles" charges · "Square off now" charges (at bid/ask) · difference.
  - **Footer**: "Charges from the rate table (as of 1 Apr 2026, unverified). Broker's physical-delivery charge not included. Delivery margin percentages from NSE Clearing's schedule (unverified). Not advice." Plus a CSV export (K5) and a method note "?" (K3) with §6.2–6.6.
  - Calls `POST /v1/options/expiry-costs` once per book change (debounced 500 ms). The same pure module computes client-side for instant redraw; the server call is the cross-check, and a mismatch over ₹1 logs a console warning in dev.
- Position rows in a banned underlying get a `Ban` chip. The exit plan never blocks closing.
- Phone: the panel becomes cards (one per leg: obligation line, two cost lines, margin line). Tablet: table with the difference column hidden (in the card detail). Desktop: full table.

### 5.7 Strategy builder, OI, Volatility, Arbitrage

- `strategy.js`: `strategyWarnings(c)` takes `{ rates, kind, calendar }`:
  - `EXPIRY_DAY_SHORT` for index only;
  - `STT_TRAP` becomes `EXPIRY_SETTLE` for index legs (rate from the table);
  - new `PHYSICAL_SETTLEMENT` (info) for stock legs whose expiry is within the E-4 window or whose payoff at expiry is ITM: "Stock options settle by delivery: at 1460 the 1420 CE becomes 500 shares bought at 1420."
  - The payoff is unchanged (cash-equivalent P&L), with a legend note "P&L shown as cash; stock legs settle by delivery".
- `oi.js`: works unchanged with the stock's chain. Labels use `formatStrike`. The ΔOI title shows the chain's `oiChangeBasis` when present.
- `vol.js`:
  - history symbol from `spotSymbolOf`;
  - the VIX tile and the "VIX vs 30-day IV" line are hidden for stocks, replaced by an "HV20" tile;
  - the term table uses the stock's monthly expiries.
  - Empty states say "Stock options list monthly expiries only."
- `arbitrage.js`: the spot tile for stocks reads "Stock · tradable", with the existing "Cash-and-carry: LATER" note. Box and parity rows note "European exercise; dividends are inside the parity forward".

### 5.8 Option Screener (`screener.js`, `screens.js`)

**Universe.** The underlying chips row becomes a `segmented` control plus an editor:
- `Indices` (default; today's behaviour), `Indices + stocks`, `Stocks`, `My list` (the opted-in set), `Positions`.
- An "Edit list" button (only with `My list`) opens a sheet with the picker's search and checkboxes; Save calls `PUT /v1/options/sweeps/settings` on this computer, else it is kept in local prefs and sent as the `stocks` array.

**Engine.** `runSweep()` no longer fetches chains itself:
1. `POST /v1/options/sweeps/plan` → coverage line.
2. `POST /v1/options/sweeps` → job.
3. While running, poll `GET …/current?lease=1` every 2 s and `GET …/current/chains?since=<cursor>` every 2 s. Each item fills the existing `cache` map exactly as the old loop did (`cache.set(key, { chain, fetchedAt, asOf, stale, error, ms })`), so `screens.js` maths is unchanged.
4. When done, the last page's `hv` fills the HV store.

Auto mode keeps the lease alive; leaving the page stops renewing it, and the server stops auto sweeps after `leaseSeconds`. The old client loop stays for one release behind `?clientSweep=1` (dev only) and is then deleted.

**Coverage line** (above results, `scr-coverage`), for example:
- "Sweeping 6 indices and 182 stocks with Dhan (quotes, 50 % of the budget) · about 2 min · 131 of 194";
- or, limited: "This Fyers account can sweep 35 stocks in 10 minutes. Showing your first 35 opted-in stocks. Edit list".
- Progress uses the existing `scr-progress` bar (`aria-valuenow`), plus the HV sub-progress "HV 40 of 186".

**Rows and filters.**
- Every contract and underlying row of a stock shows `Ban` / `MWPL 87%` chips in the lead cell sub-line.
- New filter `ban` (`seg`: `Show · Hide`, default `Show`) on every tab. It is neutral: it hides ban-period stocks, it does not rate them.
- The Overview gains a `Settles` column (p3) for mixed universes.

**Renames (AC5).** Ids are migrated in `screenerConfig()`: saved `preset: "sell"` → `"ivhigh"`, `"buy"` → `"ivlow"`; saved sort keys `scoreSell`/`scoreBuy` are kept as column ids.

| Where | Today | After |
|---|---|---|
| Tab `sell` | "Sell premium" / "Sell" | id `ivhigh`: **"High IV vs history"** / "High IV" |
| Tab `buy` | "Buy options" / "Buy" | id `ivlow`: **"Low IV vs history"** / "Low IV" |
| Tab descriptions | "Short OTM options ranked by richness…", "Options with the most reach per rupee…" | "OTM options where IV is above its history (HV20 now; IV rank where the Bridge has it), with POP, decay and liquidity, ranked by your weights." / "Options where IV is below its history, with breakeven distance, decay and liquidity, ranked by your weights." |
| Score columns | "Score"; titles "Richness 35 % · Safety 25 %…", "Cheapness 30 %…" | "Rank"; titles "Ranked by your inputs, not a recommendation. IV − HV 35 % · POP 25 % · Decay 20 % · Liquidity 20 %…" and "IV − HV (lower ranks higher) 30 % · Breakeven distance 30 %…" |
| Detail block | "Buy score" / "Sell score" | "Rank (long side)" / "Rank (short side)" |
| Overview `verdict` | "Verdict": Rich / Fair / Cheap; "Rich vs peers"… | "IV vs HV": **Above** / **In line** / **Below**; "Above peers" / "In line with peers" / "Below peers" (`straddleVerdict` labels; thresholds unchanged) |
| Overview skew text | "Puts 2.1 pts richer" | "Put IV 2.1 pts above call IV" |
| IV outliers | "Rich ₹/lot"; filter Direction Rich/Cheap; "Min \|rich or cheap\| ₹/lot" | "vs neighbours ₹/lot"; Direction **Above / Below**; "Min \|vs neighbours\| ₹/lot" |
| Hedge filter | "Best per expiry" | "Lowest cost per expiry" |
| Method list (`screener.js:995`) | "Cheap or rich is judged against 20-day realised vol…" | "IV is compared with 20-day realised vol (HV20) from daily closes, and with IV rank where the Bridge has IV history." |
| Page `sub` (`views.js`) | "…rich or cheap premium…" | "Scan indices and F&O stocks for unusual activity, build-ups, IV above or below history, hedges and arbitrage" |

Leg-side action buttons ("Add Buy to Strategy", "Sell with 27200 wing") keep Buy/Sell. They name the order side, which BRD §8.1 allows in the order context. The banned-word test allowlists exactly these button builders.

**Phone, tablet, desktop.**
- Phone: the universe segmented control scrolls horizontally; the coverage line wraps to two lines; cards show the ban chip in the badge row.
- Tablet: the coverage line sits next to the status.
- Desktop: unchanged layout, plus the line.

### 5.9 Accessibility

- The picker follows the combobox pattern: `role="combobox"`, `aria-expanded`, `aria-controls`, `role="listbox"`/`option`, `aria-selected`, and visible focus.
- Chips carry text ("Ban", "MWPL 87%"), never colour alone.
- The expiry panel table has a `caption` and `scope` headers; the "As of" control is a radio group.
- Sweep progress is a `progressbar` with `aria-valuetext` "131 of 194 chains". The status `aria-live="polite"` announces only start, finish and limit changes, not each step.
- Touch targets are ≥ 44 px.

---

## 6. Formulas and worked examples

All functions are pure (in `dashboard/expiry-costs.js`, `dashboard/underlyings.js`, `fno/plan.mjs`, `fno/quotesChain.mjs`, `fno/universe.mjs`), each with a reference-value test. Money is computed in rupees, rounded to paise only for display. Rates come from the charges table passed in, never from literals.

Common example (all figures illustrative; rates as in `CHARGE_RATES`/`charges.json` and **unverified**):
- RELIANCE monthly expiry listed **Mon 23 Nov 2026**, shifted from Tue 24 Nov (P1-2 §6.6 example).
- Lot 500, strike step 20.
- Today **Thu 19 Nov 2026** (E-2), spot 1,452.30.

### 6.1 Contract facts

- **Settlement**: `settlementOf(kind)` = `"physical"` for stock derivatives, `"cash"` for index derivatives. Kind comes from the master `instrumentType` (`OPTSTK`/`FUTSTK` vs `OPTIDX`/`FUTIDX`), falling back to the universe kind. It is never inferred from the name.
- **Strike step**: `strikeStepOf(strikes)` = the most common positive gap between consecutive distinct listed strikes of one expiry. On a tie, the smaller gap wins. `null` with fewer than 3 strikes.
  - Example: [1360, 1380, 1400, 1410, 1420, 1440, 1460] → gaps {20: 5, 10: 1} → step 20 (the 1410 strike is off-grid, typical after a corporate action; P1-2 flags it).
  - Demo TATASTEEL: [162.5, 165, 167.5, 170] → 2.5.
- **Tick size**: the largest usable `tickSize` among the expiry's option instruments (the master's merge rule).
- **Strike display**: `formatStrike(167.5)` → "167.5"; `formatStrike(1420)` → "1420"; `formatStrike(292.50)` → "292.5".

### 6.2 Moneyness and the close-to-money band

For an option leg with strike K, right R, spot S and step s (from §6.1; if unknown, the band is empty):
- ITM: R = CE and S > K, or R = PE and S < K. Intrinsic I = max(0, S − K) for calls, max(0, K − S) for puts.
- CTM (our display band, labelled): not ITM, and |K − S| ≤ `closeToMoneyStrikes` × s.
- OTM otherwise.

Examples (S = 1,452.30, s = 20):

| Leg | Result |
|---|---|
| 1420 CE | ITM, I = 32.30 |
| 1460 CE | OTM by 7.70 ≤ 20 → CTM |
| 1480 CE | OTM by 27.70 > 20 → OTM |
| 1460 PE | ITM, I = 7.70 |
| 1440 PE | OTM by 12.30 → CTM |

At settlement the exchange uses its settlement price (for stocks, the cash-market closing price; **needs verification**), so a CTM leg can end ITM. That is why CTM legs get the warnings too.

### 6.3 E-n dates and the window

`E-n` = the n-th trading day before the expiry, from P1-2's `calendar.prevTradingDay` (P1-2 §6.9). `inWindow(asOf)` is true when `tradingDaysBetween(asOf, expiry) ≤ warnFromTradingDays` (4) and asOf ≤ expiry. `day` = "E" on the expiry date, else "E-n".

Example: expiry 23 Nov.

| Day | Date | Delivery margin % |
|---|---|---|
| E-4 | Tue 17 Nov | 10 % |
| E-3 | Wed 18 Nov | 25 % |
| E-2 | Thu 19 Nov | 45 % |
| E-1 | Fri 20 Nov | 70 % |

The percentages are from P1-2's shipped table (unverified). On 19 Nov, `day = "E-2"`, `inWindow = true`. On 16 Nov (Mon): trading days after 16 Nov up to 23 Nov = {17, 18, 19, 20, 23} = 5 > 4 → `inWindow = false`.

### 6.4 Delivery obligation (stock options, if the leg settles ITM)

With q = signed units:

| Leg | Obligation |
|---|---|
| Long call (q > 0, CE) | receive q shares, pay K × q |
| Short call (q < 0, CE) | deliver \|q\| shares, receive K × \|q\| |
| Long put (q > 0, PE) | deliver q shares, receive K × q |
| Short put (q < 0, PE) | receive \|q\| shares, pay K × \|q\| |

Example: +500 × 1420 CE → "Buy 500 RELIANCE at 1420", cash −₹7,10,000.

`covered` (short call or long put): the account's holdings of the stock ≥ shares to deliver. It is `null` when holdings could not be read or no account was given. Example: −500 × 1460 CE with 500 RELIANCE in holdings → "Deliver 500 shares · you hold 500 in this account". The penalty for short delivery (auction) is **needs verification** and is stated as "the exchange auctions undelivered shares; your broker will charge the auction difference".

### 6.5 Delivery margin (percentage always; ₹ only from the caller's VaR + ELM)

- `pct(day)` from the schedule (P1-2).
- Indicative ₹ = pct × v × S × |q|, where v = `varElmPct` / 100 is supplied by the caller (never defaulted).

Example: E-2, pct 45 %, v = 20 %, S = 1,452.30, |q| = 500.
- Base = 0.20 × 1,452.30 × 500 = ₹1,45,230.
- Indicative = 0.45 × 1,45,230 = **₹65,353.50**.
- On E-1 (70 %): **₹1,01,661**.

Labelled "indicative, from your VaR + ELM input; your broker's figure decides" (P1-10 later shows the broker figure).

### 6.6 Stock option: cost of letting it settle vs squaring off now

**Settle** (physical; per the needs-verification note in §1.3). With V = K × |q|, the delivery value at the strike:
- delivery STT = `physical.sttDelivery` × V (both sides);
- stamp = `physical.stampBuy` × V for the share buyer (long call, short put);
- txn = `physical.txn[exch]` × V;
- SEBI = V × `sebiPerCrore` / 10⁷;
- GST = `gst` × (txn + SEBI);
- the broker's physical-delivery charge is listed as excluded.

**Square off now** = the existing `orderCharges` at the bid (long) or ask (short), with the profile's brokerage.

Example: +500 × 1420 CE, bid 33.80.

| Settle | ₹ |
|---|---|
| V = 1,420 × 500 | 7,10,000 |
| STT 0.10 % | 710.00 |
| Stamp 0.015 % (buyer) | 106.50 |
| Txn 0.00297 % (NSE cash) | 21.09 |
| SEBI ₹10/crore | 0.71 |
| GST 18 % × (21.09 + 0.71) | 3.92 |
| **Total** | **842.22** |

| Square off (sell 500 at 33.80; premium ₹16,900) | ₹ |
|---|---|
| Brokerage (flat profile) | 20.00 |
| STT 0.15 % on premium | 25.35 |
| Txn 0.03503 % | 5.92 |
| SEBI | 0.02 |
| GST 18 % × (20 + 5.92 + 0.02) | 4.67 |
| **Total** | **55.96** |

Copy (neutral): "If it settles: about ₹842 in charges and ₹7,10,000 to pay for 500 shares (worth ₹7,26,150 at 1452.30). Squaring off at 33.80: about ₹56 in charges; you receive ₹16,900." The difference column shows ₹786.26. Nothing says which to choose.

### 6.7 Index option: exercise vs square-off (replaces the stale copy)

NIFTY 25000 CE, +65 (1 lot), expiry day, spot 25,080 → I = 80; bid 79.50.
- **Settle (cash)**: exercise STT = `opt.exerciseStt` (0.15 %) × 80 × 65 = ₹7.80. Plus the profile's exercise brokerage ₹20 and GST ₹3.60. **Total ₹31.40.**
- **Square off**: premium 79.50 × 65 = ₹5,167.50.

  | Line | ₹ |
  |---|---|
  | Brokerage | 20.00 |
  | STT 0.15 % | 7.75 |
  | Txn | 1.81 |
  | SEBI | 0.01 |
  | GST | 3.93 |
  | **Total** | **33.49** |

The old copy ("0.125 % of intrinsic vs 0.1 % of premium") used pre-2026 rates and implied squaring off is cheaper. With today's table the two are within ₹2. The new line shows both numbers with the table's `asOf`.

### 6.8 Ban: opening vs closing

With held quantity h (signed units in that contract, this account) and order signed quantity x (+buy, −sell), new position n = h + x:
- Closing iff |n| ≤ |h| and sign(n) ∈ {0, sign(h)}.
- Otherwise opening. The largest closing quantity is |h| in the opposite direction.

Example: ADANIENT in ban, lot 300, h = −600 in 2400 CE.

| Order | n | Result |
|---|---|---|
| BUY 600 | 0 | allowed (closing) |
| BUY 300 | −300 | allowed |
| BUY 900 | +300 | **FNO_BAN**: "you can buy up to 600" |
| SELL 300 | −900 | **FNO_BAN** |
| BUY 300 of 2500 CE (h = 0) | +300 | **FNO_BAN**: a fresh position in another contract (needs verification) |

### 6.9 Sweep feasibility (`plan.mjs`)

Notation:
- R(class) = the per-minute rate of the class's tightest window: min(perSecond × 60, perMinute, w.limit × 60000 / w.windowMs for each extra window), × `budgetShare`.
- B = `maxQuoteBatch`.
- For stocks, L = legs per stock-expiry = 2 × (2 × `stockStrikes` + 1) = 62 at ±15.
- N = stocks, E = stock expiries (1, or 2 in expiry week).
- Calls:
  - chain method: C = N × E;
  - quotes method: Q = ceil((N × E × L + N + indices) / B).
- Minutes: calls / R.
- `method: auto`: use chain for stocks if C / R(chain) ≤ `maxMinutes` **and** the broker serves an option chain (better ΔOI). Else quotes, if the adapter's quotes path is verified for OI. Else chain with `maxStocksThatFit = floor(maxMinutes × R(chain) / E)`.
- Daily caps: if the class has `perDay`, `autoIntervalSec = max(minIntervalSeconds, ceil(375 × 60 × calls / (budgetShare × perDay)))`, where 375 is the session minutes. Session minutes come from `reference.session()`, not a literal.

Worked (N = 180, E = 1, 12 index chains; policies from `brokerPolicies.mjs`, several unverified):

| Broker | Index chains | Stocks | Total | Fits ≤ 10 min | Auto interval |
|---|---|---|---|---|---|
| Dhan | chain 20/min → R 10/min: 12 calls, 1.2 min | chain would be 18 min ✗ → quotes: B 1000, ceil(11,340/1000) = 12 calls at R 30/min = 0.4 min | 1.6 min | ✓ all | 120 s |
| Zerodha | no chain endpoint; adapter builds from quotes ≈ 2 calls each → 24 calls | quotes: B 500 → 23 calls | 47 calls at R 30/min = 1.6 min | ✓ all | 120 s |
| Upstox | standard window: min(3000, 500, 2000/30 = 66.7) × 0.5 = 33.3/min | chain: 180 calls | 192 calls = 5.8 min | ✓ all (broker ΔOI) | 120 s (the 30-min window allows 1,000 calls; 192 per sweep → at most 5 sweeps per 30 min → raised to **360 s**) |
| Upstox, expiry week (E = 2) | — | chain 372 calls = 11.2 min ✗ → quotes: ceil((180 × 2 × 62 + 180)/500) = 45 calls | 57 calls = 1.7 min | ✓ all | 120 s |
| Fyers | dataApis 50/min → R 25/min | chain 180 | 192 calls = 7.7 min | ✓ all | perDay 5,000: ceil(375 × 60 × 192 / 2,500) = **1,728 s ≈ 29 min** |
| Fyers, expiry week | — | chain 372 = 14.9 min ✗; quotes B 50 → 450 calls ✗ | — | ✗: maxStocksThatFit = floor((10 × 25 − 12) / 2) = **119** stocks with 2 expiries | ~29 min |
| Conservative defaults (unknown broker, B = 1) | — | — | — | ✗: "fits N stocks", typically 10–20 | per policy |
| Demo | chain 5/s → R 150/min (limited by quoteFamily 400/min → 200/min × 0.5 = 100/min after share): 10 chains | quotes B 200: ceil((50 × 82 + 53)/200) = 21 calls | 31 calls ≈ 0.3 min (+ `callDelayMs` pacing ≈ 15 s) | ✓ | 120 s |

The Upstox 30-minute window is a second daily-style cap. The planner applies the same rule to every extra window: `interval ≥ windowMs × calls / (share × limit)` = 1,800 s × 192 / 1,000 = 346 s → 360 s.

HV pass: 186 history calls once per IST day, on the history class (Dhan 5/s, Zerodha 3/s; Upstox shares the standard window, so it is spread over the session at ≤ 10 calls/min after the chains), or 0 broker calls with backup on.

### 6.10 Expiry and strike selection for stocks

- Expiries = the nearest listed monthly expiry; add the next one when calendar days to the nearest ≤ `nextExpiryWithinDays` (7). On 19 Nov (4 days to 23 Nov) → Nov and Dec. On 10 Nov (13 days) → Nov only.
- Window = `stockStrikes` steps each side of ATM (§6.1 step; ATM = the strike nearest spot, the lower one on a tie). Listed strikes outside the master are not invented. With s = 20 and spot 1,452.30: ATM 1460, window 1160–1760 (31 strikes, as listed).

### 6.11 ΔOI basis on the quotes path

For each contract c, in order:
1. `broker`: the broker chain's own `oiChange` (chain method only).
2. `recorder`: OI_now − the last OI recorded for c on the previous trading day. Read in-process through the recorder store (`deps.recorder` read of the previous trading day's last snapshot; REST equivalent `GET /v1/options/snapshots?underlying=&expiry=&from=<prev day 15:25>&to=<prev day 15:30>&fields=oi`, last snapshot). `/v1/options/snapshots/latest` serves today only and has no `date` parameter.
3. `day-baseline`: OI_now − the first OI seen today in `oi-base`, labelled with that time.
4. `null`.

Example: RELIANCE 1420 CE, OI now 13,02,500.
- With the recorder (yesterday 15:29: 12,45,000): ΔOI = **+57,500** (115 lots), basis `recorder`.
- Without it (first sweep 09:21: 12,50,000): ΔOI = **+52,500**, basis `day-baseline`. The Build-up tab's column title reads "OI chg since 09:21 (first sweep today)".
- A chain mixes bases only if contracts were first seen at different times. The tab shows the earliest baseline time and marks later-listed contracts "since HH:MM".

### 6.12 Picker ranking (`rankUnderlyings`)

Score per item for query t (uppercased, trimmed):

| Match | Score |
|---|---|
| Symbol equals t | 100 |
| Symbol starts with t | 70 |
| A word of the name starts with t | 50 |
| Symbol contains t | 40 |
| Name contains t | 30 |
| Edit distance ≤ 1 on the symbol prefix of the same length (t ≥ 4 characters) | 15 |
| Otherwise | excluded |

Ties: indices, then underlyings in positions, then recent, then alphabetical.

Examples:
- "rel" → RELIANCE (70) first.
- "bank" → BANKNIFTY (70), BANKEX (70) (indices first), then AXISBANK, HDFCBANK, ICICIBANK, KOTAKBANK (40; alphabetical), then any name containing "Bank" (30).
- "infy" → INFY (100).
- "relaince" → RELIANCE (15).

Empty query → sections as in §5.2.

---

## 7. Rate-limit budget

| Path | Calls | Budget and rule |
|---|---|---|
| Universe list | **0** broker calls (masters and reference are in memory) | p95 < 10 ms |
| Picker prices (`withQuotes=1`) | 1 batched quote read per picker open, cached 60 s (≤ 1 call on Dhan, 1 on Zerodha/Upstox for ~190 symbols; 4 on Fyers) | Interactive priority; skipped when the quote class has < 2 tokens |
| Contract facts, expiry costs | 0 (cached quotes); expiry costs may read holdings once (portfolio class, 60 s cache) | — |
| Ban gate | 0 unless the stock is in ban; then 1 positions read per opening-or-closing order preview (live), shared with `syncLivePnl` | Order priority (it is part of an order) |
| Sweep | §6.9: Dhan ≈ 24 calls/sweep (12 chain + 12 quote), Zerodha ≈ 47, Upstox ≈ 192, Fyers ≈ 192 | ≤ `budgetShare` (50 %) of every window of the class, enforced by the headroom gate; background priority; one sweep at a time; auto only while leased; auto interval raised by daily and long windows |
| Sweep, stream-served legs | 0 | `marketData.quotes` serves from the stream first (P1-4/P1-1 subscriptions) |
| HV | ≤ 1 history call per underlying per IST day | Background; or backup with 0 broker calls |
| Dashboard → Bridge | 2 polls/2 s while a sweep runs on the screener page; 1 list load per 10 min per tab | Per-key limiter unchanged |
| Interactive impact | On 1-per-second classes (Dhan quote, Zerodha quote), a background sweep call in flight can delay a user call by ≤ 1 s. The sweep makes 12–47 such calls spread over 1–2 minutes. The status line says so on those brokers. | BRD §7.2: user calls are queued first |

A fake-broker load test (§9.2) asserts:
- the sweep never takes a class below 50 % headroom;
- a user chain call issued mid-sweep on a 5/s class starts within 200 ms, and on a 1/s class within 1,000 ms.

---

## 8. Safety and compliance gates

### 8.1 Order safety (nothing loosens `docs/guides/safety.md`)

- `FNO_BAN` adds a refusal; it never removes one. Paper and live use the same rule (D3). Cancels are never blocked. Exits are never blocked by our rule. When positions are unreadable in live, the Bridge warns and the broker decides. That is the conservative choice for exits, because the exchange and broker refuse fresh positions anyway.
- `ban.blockOpening: false` exists only for a user whose broker applies a different reading. It is logged at boot, audited per order, and shown as a warning in every preview.
- The ticket and basket gates are UI conveniences; the server check is authoritative.
- No new route sends orders. The sweep and the expiry costs are read-only. MCP gains read tools only and cannot start sweeps.
- The stale-data guard (BRD §7.5) is unchanged; sweep chains carry `freshness`, and a ticket opened from the screener reloads the quote.
- Kill switch, paper default and live gates are untouched.

### 8.2 Compliance (BRD §8)

- **RA/IA neutrality**:
  - Tab and column names per §5.8; descriptive ban and delivery copy ("in ban: no fresh positions", "if it settles…").
  - No "avoid", "safe", "opportunity", "recommend", "best", "rich", "cheap", and no "buy"/"sell" outside order-side controls.
  - Ranks say "ranked by your inputs; not a recommendation" (§8.4 disclaimer).
- **Personal use**: the sweep reads from one data account chosen by `marketDataCandidates()`, which never pools across holders. Results stay in `dataDir`. No sharing.
- **NSE terms**: ban, MWPL and the universe come only from P1-2's consented archive fetch. This module makes no NSE website calls.
- **Data honesty**:
  - `oiChangeBasis` on every swept leg; `source` on the universe;
  - "inferred" on strike step and adjusted contracts;
  - "unverified" on the delivery schedule and physical charges;
  - `available: false` with a reason instead of fake values.
- **Security**: new stores hold no secrets or account credentials (job files name the account id, as `freshness` already does). `securityReview.test.mjs` gains `dataDir/fno/` in its token scan. The settings write is admin + loopback and audited.
- **Disclaimers**: the positions expiry panel footer and `POST /v1/options/expiry-costs` `notes` carry "Calculated from the rate table and your inputs. Not tax or investment advice; your broker's contract note decides."

### 8.3 "Needs verification" register (must be cleared before any row is `verified: true`)

| Item | Where |
|---|---|
| Delivery STT on physically settled options: rate (0.1 %), basis (strike × qty vs settlement price), both sides | `charges.json physical`, §6.6 |
| Stamp duty on delivery (0.015 %) and cash-segment txn rates (NSE 0.00297 %, BSE 0.00375 %) | `charges.json physical` |
| Delivery-margin schedule % and the E-n definition | P1-2 `delivery-margin.json` |
| Stock settlement price (closing price, 30-minute VWAP) | §3.4 text, P1-3 config |
| Close-to-money definition and the DNE facility status | §1.3, §6.2 copy |
| Ban rule: per contract vs per underlying; partial crosses | §6.8, `safetyGuard` comment |
| Short-delivery auction consequences | §6.4 copy |
| Extra 2 % ELM on short index options on expiry day, index only | `charges.json margin` |
| Per-adapter quote OI, bid and ask for NFO stock options (Dhan, Zerodha, Upstox; `quotesVerified`) | `fno/__fixtures__`, §9.3 |
| Fyers per-day 5,000 and the "blocked after 3 breaches" note | `brokerPolicies.mjs` (read-only here) |

---

## 9. Test plan

All tests are vitest, next to their code, with no network (`globalThis.fetch` stubbed to throw in the module suites). Each step of §11 ends green with `npx vitest run <files>` and `node scripts/check-mjs.mjs`.

### 9.1 Unit (pure)

| File | Covers |
|---|---|
| `server/bridge/dashboard/expiry-costs.test.mjs` | §6.2 table exactly; §6.3 E-n (with P1-2's calendar fixture including the shifted 23 Nov expiry) and the window edges (E-4 in, E-5 out, E in, after expiry out); §6.4 all four obligations and `covered` true/false/null; §6.5 ₹65,353.50 and ₹1,01,661, and no ₹ without `varElmPct`; §6.6 ₹842.22 and ₹55.96; §6.7 ₹31.40 and ₹33.49; doctored rate table (all rates ×10) changes every figure proportionally; BSE txn row for a BFO stock; OTM leg cost 0; index leg has no obligation |
| `server/bridge/dashboard/underlyings.test.mjs` | `rankUnderlyings` examples (§6.12) incl. tie order and fuzzy; `spotSymbolOf` for index, NSE stock, BSE index; recent list cap 8 and `localStorage` throwing; fallback list when the route 404s |
| `server/bridge/dashboard/format.test.mjs` (add) | `formatStrike` 1420, 167.5, 292.50, 0.05, null → "--" |
| `server/bridge/dashboard/options.test.mjs` (update) | `tradeWarnings`/`bookWarnings`/`strategyWarnings` with `kind: "stock"` emit no ELM line and emit the settlement/delivery lines; `kind: "index"` ELM uses `rates.margin.expiryDayElmIndexShort`; `straddleVerdict` labels Above/In line/Below; every existing test passes explicit `rates` |
| `server/bridge/dashboard/screens.test.mjs` (update) | Migration `sell→ivhigh`, `buy→ivlow` (saved config, sort, filters kept); renamed labels; `ban` filter hide/show; ban chips on records; banned-word scan over `PRESETS` (labels, short, description, column labels, titles, filter labels and options), `verdictText`, and `FILTERS` (allowlist: the order-side button builders only) |
| `server/bridge/fno/plan.test.mjs` | Every row of the §6.9 table from a frozen policy snapshot (`__fixtures__/policies.json`), incl. the Upstox 360 s and Fyers 1,728 s intervals, Fyers expiry-week 119, unverified quotes → chain fallback, `method` forced to quotes on an unverified broker → `CAPABILITY_UNSUPPORTED` |
| `server/bridge/fno/universe.test.mjs` | Reference universe ∩ masters; masters fallback with `source: "masters"`; `missingAtBroker`; `strikeStepOf` examples (§6.1) incl. tie and < 3 strikes; settlement from instrument type; ban join incl. `available: false`; `nonStandard` from inferred actions |
| `server/bridge/fno/quotesChain.test.mjs` | Rows from quotes match `rowsFromQuotes` shape; window ±15 around ATM; ΔOI basis order (§6.11) incl. the two worked numbers; Greeks via the injected seam |

### 9.2 Service, store, gate and load

| File | Covers |
|---|---|
| `server/bridge/fno/sweep.test.mjs` | Fake clock, fake marketData/scheduler/symbols/reference, temp `dataDir`: single flight (second POST joins; POST within `minIntervalSeconds` reuses; `force` starts new only when idle); headroom gate never lets `remaining` fall below 50 % of `limit` (spy over 1,000 scheduled calls); `UPSTREAM_RATE_LIMITED` pauses; Fyers never retried; cancel aborts and keeps finished chains; resume after a simulated restart continues from `done` (no repeated keys) within 30 min and marks `interrupted` after; day roll clears the cache and rolls `oi-base`; retention; HV pass after chains with `hv.done` progress; `fno.sweep.progress` throttled to 1/s; lease expiry stops auto-repeat; background auto off by default |
| `server/bridge/fno/sweepStore.test.mjs` | Torn last line ignored; corrupt `state.json` renamed; atomic writes; job files beyond `keepJobs` deleted |
| `server/bridge/fno/load.test.mjs` | Fake broker with a 5/s and a 1/s quote class: during a 180-stock sweep, a user `optionChain` call (interactive) starts within 200 ms (5/s) and 1,000 ms (1/s) at p100 over 50 trials |
| `server/bridge/safety/safetyGuard.test.mjs` (add) | `fnoBan`: §6.8 table; `heldQty: null` → warn only; not in ban → pass; index → pass; cancel never blocked; modify raising quantity checked; `blockOpening: false` → warn and audit |
| `server/bridge/orders/orderService.flow.test.mjs` (add) | Positions read only when in ban (spy: 0 reads otherwise); paper heldQty from the paper engine; live read shared with `syncLivePnl` (1 read, not 2); refusal shape `422 INVALID_ORDER` with `errors[0].path = "FNO_BAN"`; `BAN_DATA_UNAVAILABLE` warn; `PHYSICAL_SETTLEMENT` warn from E-4 on an ITM opening stock option and not for index |
| `server/bridge/market/marketDataService.test.mjs` (add) | Chain carries `underlyingKind`, `settlement`, `strikeStep`, `tickSize` for OPTSTK and OPTIDX fixtures |
| `server/bridge/demo/demo.test.mjs` (update) | Every demo stock lists 3 monthly expiries, `OPTSTK`/`FUTSTK`, lots per formula (RELIANCE 525, TATASTEEL 4475, MARUTI 50), steps per table, TATASTEEL has 167.5, ±20 stock strikes, OI is a multiple of the lot, quotes for option tokens carry `oi`/`bid`/`ask`, the adjusted `-ADJ` series exists with lot × 5; demo lots equal `demoReference` lots |
| `server/bridge/auth/securityReview.test.mjs` (add) | No token-shaped string in `dataDir/fno/**` after a demo sweep |

### 9.3 Contract tests

- `server/bridge/core/openapi.test.mjs`: the new operations with `x-stream: S19`, scopes, `x-loopback-only` on settings and demo, `x-demo-only` on demo.
- `server/bridge/fno/routes.test.mjs`:
  - happy path and every error in §3.2 per route;
  - `available: false` shapes;
  - 202 vs 200 `joined`/`reused`;
  - settings admin + loopback refusal and audit row;
  - demo route absent when not demo;
  - each response's keys ⊆ the OpenAPI schema (the schema-walk helper P1-2 adds, else a key check).
- `server/bridge/fno/quotesFixtures.contract.test.mjs`: for Dhan, Zerodha and Upstox, the documented quote response for an OPTSTK contract (fixture from each broker's docs/SDK, `__fixtures__/`) maps through the adapter's `fetchQuotes` → `quoteFields` to non-null `oi` (a multiple of the lot, units per P1-1 M10), `bid` and `ask`. A broker whose fixture fails stays `quotesVerified: false` (the planner then uses chain or limits).
- `server/bridge/mcp/tools.test.mjs`: the three tools return the same `data` as REST; there is no start/cancel tool.
- `server/bridge/dashboard/noLiteralRates.test.mjs` (**AC4**):
  - Scans `server/bridge/dashboard/*.js` minus tests, `reference.js` and `expiry-costs.js` (which takes rates as parameters and holds none).
  - Fails on `0\.0012?5\b`, `0\.001\s*\*`, `0\.00125`, `\b0\.125\s*%`, `\b0\.1\s*%`, `[0-9.]+%\s*(of|on)\s*(premium|intrinsic)`, `\+?2%\s*ELM`, `STT_EXERCISE\s*=`, `EXPIRY_ELM\s*=\s*0\.`, and any `formatRupee\(\s*0\.\d+` (a rupee figure from a literal rate).
  - A second check runs `tradeWarnings`, `bookWarnings` and `strategyWarnings` with a doctored rate table and asserts every rupee and percent figure in their text changes.
  - Prints file:line per hit.
- `server/bridge/dashboard/strikeFormat.test.mjs`: no `formatInt(` whose argument mentions `strike`, `K`, `k`, `wingStrike`, `topStrike`, `.strike` in the Options page files (allowlisted counts are zero).
- `server/bridge/dashboard/polish.test.mjs` (update): `underlying-picker.js` in the page list (44 px targets, no new colour literals).

### 9.4 Dashboard

- `server/bridge/dashboard/underlying-picker.test.mjs` (jsdom-free: the component takes an injected `h` and a fake list):
  - keyboard model (↑↓, PgUp/PgDn, Home/End, Enter, Esc restores focus);
  - sections when empty;
  - 60-row windowing;
  - `aria-activedescendant` updates;
  - phone/desktop variant chosen by an injected media query.
- `server/bridge/dashboard/desk.test.mjs` (add):
  - underlying state accepts a stock;
  - saved stock no longer listed → first index + toast;
  - ticket ban gate truth table (in ban × held × side × exit);
  - stock settlement line text;
  - `EXPIRY_DAY_NOTE` gone.
- `server/bridge/dashboard/screener.test.mjs` (new, pure parts):
  - the sweep client fills `cache` from `/chains` pages in `seq` order;
  - lease renewals stop when the page is destroyed;
  - the coverage line for full and limited plans.

### 9.5 End-to-end

`server/bridge/e2e/stocks.e2e.test.mjs` (demo, real HTTP on an ephemeral port, as in `bridge.e2e.test.mjs`):

1. `GET /v1/options/underlyings`: indices present and ≥ 50 stocks; RELIANCE lot 525, `settlement: "physical"`, `strikeStep: 20`; TATASTEEL `strikeStep: 2.5`; 2–3 `inBan`.
2. `GET /v1/expiries?underlying=RELIANCE`: 3 monthly dates. `GET /v1/optionchain?underlying=TATASTEEL&expiry=…`: `underlyingKind: "stock"`, a strike 167.5, OI a multiple of 4475.
3. `POST /v1/options/sweeps/plan` → `fits: true`, two groups. `POST /v1/options/sweeps` → 202. A second POST → 200 `joined`. Poll until `done`: ≥ 50 stock chains, `oiChangeBasis` present, `hv` on the last page. `/v1/usage` shows the quote class never above 50 % used during the run.
4. Paper ticket: buy 1 lot RELIANCE nearest-expiry ATM CE (allowed). `POST /v1/demo/fno { ban: ["RELIANCE"] }`. Preview buy 1 more lot → `FNO_BAN` block. Preview sell 1 lot → allowed with the closing warning. Place the sell → filled. Preview sell 1 more → `FNO_BAN`.
5. Always: `POST /v1/options/expiry-costs` with the §6.6 legs, explicit spot and bid, and `asOf` = E-2 of the nearest demo expiry → ₹842.22 / ₹55.96, `day: "E-2"`. The `PHYSICAL_SETTLEMENT` preview warning depends on today's date, so it is covered by the fake-clock flow test (§9.2), not here.
6. `PUT /v1/options/sweeps/settings` with an admin key from loopback → 200 `persisted: false` (demo). With a read key → 403.
7. Back-compat: `GET /v1/expiries?underlying=NIFTY` unchanged in shape; `/v1/optionchain` for NIFTY still validates against the old required fields.

Manual check (`run` skill) at 390×844, 820×1180 and 1440×900, dark and light: the §4.3 shots. Paste the tick-to-paint numbers from P1-4's probe for a RELIANCE chain to show stocks do not regress latency (BRD D4).

---

## 10. Migration and back-compat

- **API**: additive only (§7.8).
  - New routes; optional chain fields; new check codes in an open set.
  - `FNO_BAN` blocks orders that the exchange would refuse anyway. It is a behaviour change for API users sending opening orders in banned stocks, listed in the CHANGELOG with the config switch.
- **Config**: new optional `fno` section. A config without it gets the defaults. Unknown keys are errors (strict), as for every module.
- **Dashboard state**:
  - `mcb.dashboard.desk` keeps `underlying`. Stocks are now valid values; an unlisted one falls back (§5.1).
  - `mcb.dashboard.screener` presets migrate `sell→ivhigh`, `buy→ivlow` (kept for 6 months, then removed). The saved `underlyings` array becomes `universe: "custom"` with that list.
  - `desk.js` keeps exporting `UNDERLYINGS` and `DEMO_UNDERLYINGS` (marked deprecated) for one release, because `screener.js` and tests import them. They are only the fallback when `/v1/options/underlyings` fails.
- **Charges**: `tradeWarnings` codes `EXPIRY_STT` → `EXPIRY_SETTLE` and `bookWarnings` id `stt` → `settle`. Hidden-warning ids saved in prefs (if any) are mapped once.
- **Demo**:
  - The P1-1 M13 "five stock-option underlyings" is superseded by all 50. If P1-1 lands first, its steps and lots are replaced by the tables here, and its demo tests are updated in the same PR.
  - Demo stock lots do not change: P1-1 already reads P1-2's `DEMO_STOCK_LOT`, and this item uses the same table for all 50 stocks.
- **Screener engine**: the client sweep loop is replaced by the server sweep. The client loop stays behind `?clientSweep=1` for one release for debugging, then it is deleted.
- **Data folder**: `dataDir/fno/` is created on first start. Backups include it if `backupService` copies `dataDir` (verify; else add it).
- **Docs**:
  - `docs/STREAMS.md` gains the S19 row (`fno`: routes only; consumes marketData, symbols, accounts, scheduler, reference, recorder optional);
  - `ARCHITECTURE.md` gains the module-map row and the dataDir lines;
  - `docs/guides/` gains `stock-options.md` (picker, sweep coverage per broker with the §6.9 table, ban rule, delivery panel, verification register).

---

## 11. Ordered task list (one engineer, one session; each step lands with its tests green)

Steps 1–8 are server and can ship alone. Steps 9–14 are the dashboard. Step 15 is e2e and docs.

1. **Skeleton.** Lead edits: `SafetyIntent` fields, `orders.requires += reference`, bus topics, `builtinModules`, `DASHBOARD_FILES`. Then `fno/module.mjs` with all routes as `notBuilt`, `config.mjs`, OpenAPI path stubs (`x-stream: S19`) so `openapi.test.mjs` passes.
2. **Pure maths first.** `dashboard/expiry-costs.js` + `expiry-costs.test.mjs` (§6.2–6.7). Add the `physical`/`margin` rows to P1-2 `charges.json`, `defaults.mjs` and `REF_DEFAULTS`.
3. **Demo stocks.** Demo adapter changes (§4.1) + `demo.test.mjs`. Import P1-2's `DEMO_STOCK_LOT` (do not create a second table).
4. **Chain facts (S5).** `chainMeta` fields + `marketDataService.test.mjs` additions + OpenAPI `OptionChain` fields.
5. **Universe.** `universe.mjs` + tests; `GET /v1/options/underlyings` and `/{underlying}` + `routes.test.mjs` for them; MCP `get_option_underlyings`.
6. **Ban gate.** `safetyGuard` rule + orders `heldQty` supply + flow tests; `PHYSICAL_SETTLEMENT` and the two warnings; `POST /v1/demo/fno`.
7. **Expiry-costs route** + MCP `get_expiry_costs` (imports the dashboard module).
8. **Sweep.** `plan.mjs` (+ §6.9 tests), `quotesChain.mjs`, `sweepStore.mjs`, `sweep.mjs`, the sweep routes, settings, MCP `get_option_sweep`, the load test, the quotes fixture contract tests.
9. **Formatting.** `formatStrike` + replace every strike `formatInt` + `strikeFormat.test.mjs`.
10. **`underlyings.js` + picker** (`underlying-picker.js`) + tests. Wire it into the shared top bar (`desk.js`); remove both `INDEX_SYMBOL` maps and `indexSymbol` uses (`positions.js`, `vol.js`, `screener.js`).
11. **Warnings by kind + no literal rates.** `options.js` warning functions take `{ rates, kind }`; remove `STT_EXERCISE`, `EXPIRY_ELM`, line 826 and `EXPIRY_DAY_NOTE`. `noLiteralRates.test.mjs`. Update `options.test.mjs`.
12. **Chain, ticket, strategy.** Ban chip, contract-facts rows, summary strip items, adjusted rows, ticket ban gate and settlement line, `strategy-place.js` gate, strategy warnings.
13. **Positions panel** "Expiry and delivery" (+ CSV, method note, phone cards); ban chips on rows.
14. **Screener.** Server sweep client, universe control, coverage line, ban filter and chips, renames + migration + banned-word test; vol/OI/arbitrage stock touches (§5.7); `views.js` sub text.
15. **E2E + docs.** `stocks.e2e.test.mjs`; `ARCHITECTURE.md`, `STREAMS.md`, `bridge.config.example.json`, `docs/guides/stock-options.md`, CHANGELOG; the verification register in the PR description; demo screenshots at three sizes.

**Cut line** if the session runs short: after step 11. Steps 1–11 already meet:
- AC1 server and picker;
- AC3 server-side refusal;
- AC4 maths and the literal-rate test;
- AC5 can land with step 14.

Steps 12–14 can follow in the next session without blocking P1-7 to P1-13, which consume only the routes from steps 5–8.

---

## 12. Acceptance criteria mapping

| BRD P1-6 criterion | Where it is met | Honest gap |
|---|---|---|
| 1. Picker lists the current F&O universe from S5 with search; chain, OI, vol, builder, positions and screener work for stocks with the right lot and tick sizes | §2.7, §3.3–3.4, §5.1–5.8, §6.1, §6.12; tests §9.1, §9.5 steps 1–2 | Universe history only from P1-2's first fetch; masters fallback when NSE downloads are off; strike step inferred |
| 2. Full stock sweep ≤ 10 min where feasible, with progress; elsewhere the opted-in set with the limit stated | §2.6, §3.6, §6.9, §7, §5.8; `plan.test.mjs`, `load.test.mjs`, e2e step 3 | Depends on per-broker quote OI fixtures (`quotesVerified`); ΔOI basis may be the day baseline; HV is a separate pass |
| 3. Ban-list badge; ticket refuses opening orders, closing allowed | §2.8, §3.7, §5.3, §5.5, §6.8; safety/orders tests, e2e step 4 | Per-contract reading of the rule (needs verification); live with unreadable positions warns instead of blocking |
| 4. From E-4 to E: delivery-margin schedule and exercise-STT vs square-off cost from S5 and `CHARGE_RATES`; a test fails on literal rates; stale copy removed | §5.3, §5.5–5.7, §6.2–6.7; `expiry-costs.test.mjs`, `noLiteralRates.test.mjs` | Delivery margin ₹ only indicative from user input (P1-10 later); physical delivery charges unverified; broker delivery fee excluded |
| 5. Screener tabs use neutral names | §5.8 table; `screens.test.mjs` banned-word scan | Order-side buttons keep Buy/Sell by design |

---

## 13. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A broker's quote response lacks OI or depth for NFO stock options, so the quotes path is unusable | Medium | High (sweep falls to chain-limited sets) | `quotesVerified` per broker from fixtures; the planner degrades to chain with a stated limit; never a silent gap |
| Physical-settlement charges or delivery-margin percentages are wrong | Medium | Medium | All rates in the table with `verified: false` and visible "unverified"; one data change fixes them; register in §8.3 |
| Ban rule read too strictly (per contract) blocks a user's hedge | Medium | Medium | Message names the rule and the max closing qty; config switch to warn-only; legal and broker verification |
| Ban data stale or off, so a fresh position goes to the broker | Medium | Low (the broker refuses) | `BAN_DATA_UNAVAILABLE` warning; stale ban data follows P1-2 staleness banners |
| Sweep starves the user's own calls on 1/s classes | Low | Medium | Background priority, 50 % headroom gate, a load test with a 1 s bound, status copy; auto only while leased |
| Fyers daily-cap breach blocks the user for the day | Low | High | Interval raised from `perDay`; no retries on Fyers rate errors; plan message states the cap |
| ~69 strike-format call sites missed, so 292.5 shows as 293 | Medium | Medium (wrong contract shown) | Static `strikeFormat.test.mjs`; TATASTEEL 167.5 in demo screenshots |
| Picker performance on phones with ~190 rows and live prices | Low | Low | Windowed list, quotes after first paint, 60 s cache |
| Screener engine swap regresses index scans | Medium | Medium | Same `cache` contract into `screens.js`; existing screens tests unchanged; `?clientSweep=1` escape hatch for one release |
| Spec ownership overlap (P1-2 charges table, P1-1 demo stocks, S5 chain fields) | Medium | Low | Named owner review per file in §2.1; merge order P1-2 → (P1-1) → P1-6 |
| Restyle team's screener design still says "Sell/Buy" | High | Low | Text-only change; flag to the restyle team with the §5.8 table |
| Disk growth from sweep job files and baselines | Low | Low | ≈ 0.6 MB per job (2 kept) + ≈ 0.3 MB/day `oi-base` × 5 days |
