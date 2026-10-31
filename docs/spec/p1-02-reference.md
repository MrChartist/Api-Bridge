# Engineering spec P1-2: reference data, contract calendar, corporate actions and F&O universe

Status: ready to build · Owner: tech lead, P1-2 · Date: 29 Oct 2026 · BRD: `docs/brd/options-platform.md` §3.J (J3, J8, J9), §5.2 (store S5), §5.5 (reference sync), §6.1 (P1-2 acceptance criteria), §7, §8

> **Naming collision, read first.** The BRD calls the reference-data store **S5**. In the code, **S5** is the *build stream* that owns `market/` (`docs/STREAMS.md`). In this spec, "store S5" always means the BRD's reference-data store. The new module is build stream **S16** (the next free stream id; S1–S15 are taken). Final ids for every Phase 1 module are in `docs/spec/README.md`.

> **Not legal or market advice.** Every exchange rule, URL, file layout and number below that comes from outside this repo is marked **needs verification**. Nothing marked that way may become a blocking rule in code until a person has checked it against the primary NSE/BSE/SEBI source and set `verified: true` on the data row (see §7.3).

> **Build order and shared foundations.** This spec is steps 1 and 7 (P1-2a server tasks 1–9; P1-2b dashboard tasks 10–15) in `docs/spec/README.md`, after F0. It uses, and does not rebuild, the F0 foundations listed there: final stream ids, bus topics and error codes pre-registered in core, the opt-in `options` MCP toolset (every MCP tool in this spec goes there), `demo/routes.mjs` plus the OpenAPI demo-only list, `server/lib/jsonl.mjs` (append, torn-line tolerance, last-wins, quarantine of corrupt files), `ratelimit/backgroundGate.mjs` (the one ≤ 50 % background-budget check), `core/ownership.mjs`, and `dashboard/copyRules.mjs` (the one banned-word list). Where this text and README disagree, README's build order and shared-module owners win.

---

## 0. Summary

P1-2 turns the contract facts the Options pages guess today (rate 6.5 %, 09:15–15:30, lot sizes from whichever broker master loaded, no holidays, no ban list) into **one dated, sourced, local reference store** with a server service (`deps.reference`), a `/v1/reference/*` API, a demo generator, banners on the Options pages and a static test that keeps the constants out.

What we can honestly get, by dataset:

| Dataset | Source this round | Quality | If missing |
|---|---|---|---|
| Expiries (listed) | Connected brokers' instrument masters (already loaded by `symbols`) | Authoritative per contract | "No master loaded" |
| Lot size per contract and its effective date | NSE `fo_mktlots.csv` (NSE archives) + masters (per contract, both exchanges) | Authoritative (master); dated (NSE file) | Master value only, `effectiveFrom: null` |
| Freeze quantity | Masters where published (`freezeQtySource: "master"`), else the existing dated index list (`symbols/freezeQuantities.mjs`), else config override | Partial | `null`, "freeze qty unknown" |
| Sessions | Shipped defaults + config (special sessions such as Muhurat in config) | Config, dated | Defaults |
| Holidays | Shipped dated file `reference/data/holidays.json` (from the NSE/BSE annual circular, **needs verification**) + config add/remove | Curated | Weekends only, labelled |
| Ban list | NSE `fo_secban` CSV (archives) | Authoritative | "Unavailable: NSE archive downloads are off" |
| MWPL % | NSE combined-OI zip (archives, CSV inside) | Authoritative, end of day | Unavailable |
| F&O membership by date (J9) | Daily snapshot of `fo_mktlots.csv` → membership intervals, from the day we first fetched | Point-in-time **from first fetch only** | Older dates "not recorded" (bhavcopy backfill is LATER, with P1-3 S6) |
| Corporate actions (J8) | (a) curated entries (shipped or user-entered), (b) **inferred** non-standard contracts from masters, (c) pure adjustment calculator | Curated + inferred, labelled | No automatic NSE feed (see §1.3) |
| Stock-option delivery-margin schedule | Shipped dated table | Curated, **needs verification** | Defaults |
| Risk-free rate | Config / dashboard entry with `asOf` and `source`; default 6.5 % labelled "default, not sourced" | Manual | Default, warning after 14 days |
| Statutory charges | Shipped dated table (moves today's two client copies to the server) | Curated | Defaults |

Two things in the acceptance criteria **cannot be met from free, allowed, machine-readable sources** and get honest fallbacks (§1.3): an automatic daily risk-free rate, and an automatic corporate-actions feed with exchange adjustment factors.

---

## 1. Scope

### 1.1 MUST (this round)

1. **Module `reference` (stream S16)** with contract service `reference` (`deps.reference`), config section `reference`, JSON stores under `dataDir/reference/`, and a minute-tick scheduler (morning and evening syncs).
2. **Calendar core** (pure): trading-day functions over the holiday calendar and sessions (`isTradingDay`, `prevTradingDay`, `nextTradingDay`, `tradingDaysBetween`, `sessionAt`, `expiryShift`).
3. **Datasets**: expiries, sessions, holidays, lots (with effective dates), freeze quantity, ban list, MWPL %, F&O universe intervals, corporate actions (curated + inferred + calculator), delivery-margin schedule, rate, charges. Each value carries `source`, `asOf`, `quality` and, where it came from outside the repo, `verified`.
4. **NSE archive fetcher** for three files (market lots, ban list, combined OI/MWPL). Off until the user turns it on (same stance as `backup`: a fresh install calls no third-party site). Polite rate, size caps, raw copies kept for audit.
5. **Demo generator**: every dataset produced deterministically, with a rolling upcoming lot revision, an upcoming corporate action, a ban list, near-ban MWPL, universe entries/exits and one holiday-shifted expiry, so every feature can be seen without a broker or the network.
6. **API**: 20 routes under `/v1/reference/*` (§3), OpenAPI additions, one MCP read tool `get_reference`.
7. **Consumers wired**:
   - `market`: computed Greeks use `reference.rate()`; `market.chain.riskFreeRate` becomes a deprecated override.
   - `safety`: on a **verified** NSE/BSE holiday, live NFO/BFO orders are blocked with `MARKET_CLOSED`; on an unverified one they get a warning.
   - `scanner`: `marketHoursOnly` uses `reference.session()` (holiday-aware).
   - `paper`: `sessionEnd.time` default comes from the reference session close.
   - `orders` preview: `LOT_SIZE_STALE` warning check; optional block via config.
   - `demo`: rate and holiday shifting read from reference defaults.
8. **Dashboard**: a new `reference.js` client module, a reference chip in the Options top bar, banners for events within 7 days, a stale-data warning, lot-size confirmation in the order ticket when stale, ban/MWPL chips, a new **Market calendar** page, and removal of `RISK_FREE`, `RATE = 0.065`, both `brokeragePerOrder: 20` literals and the 09:15/15:30 session literals from the Options pages.
9. **Static test** `reference/noConstants.test.mjs` (the BRD's grep criterion) and the fixture tests in §9.

### 1.2 LATER (named so nobody builds it now)

| Item | Why later | Goes with |
|---|---|---|
| Freeze quantities from NSE `qtyfreeze.xls` | It is a binary XLS (**needs verification**). We have no XLS parser and no new runtime dependencies (`package.json` has three). | A later round, or when NSE publishes a CSV |
| Point-in-time universe before our first fetch | Needs bhavcopy history (S6). | P1-3 (S6 backfill) |
| Applying corporate-action factors to price/IV history | Needs S2/S6 history to exist. | P1-3 |
| Automatic corporate-actions feed | The only machine-readable source is the NSE website API, which NSE's terms prohibit automating (§8.1). The F&O adjustment circulars are PDFs. | Opt-in through the existing `backup.providers.nse` consent, later round |
| Automatic risk-free rate | No allowed free machine-readable source has been identified (RBI/FBIL publish web pages; **needs verification**). | Later round, after a source and licence check |
| BSE ban list / MWPL for BSE-only stock derivatives | No BSE archive file located (**needs verification**). NSE's combined OI file already covers both exchanges for stocks traded on both. | Later |
| Brokerage per account plan (G9) | Owned by P1-10. This round moves the default brokerage into reference config only. | P1-10 |
| Removing `T_FLOOR`, `/365`, `theta/365` | The vol-time clock is P1-3. | P1-3 |
| Stale STT copy (`options.js` `tradeWarnings`, `desk.js` `EXPIRY_DAY_NOTE`, "0.125 %") | Owned by P1-6 acceptance criteria. | P1-6 |
| Underlying picker from the F&O universe, ban refusal in the ticket, stock option chains in demo | P1-6 acceptance criteria. This round ships the data and the API it needs. | P1-6 |
| Events calendar (results, RBI MPC, macro) | J4, Phase 2. | P2 |
| Compat / Sheets path for reference reads | §7.8 parity; the MCP tool ships now. | Next round |
| WebSocket delivery of `reference.updated` | The dashboard re-reads every 10 minutes; nothing needs push yet. | P1-11 (alerts) |
| MCX/CDS sessions and holidays | Phase 3 (§3.M). The `SESSION_WINDOWS` in `safetyGuard.mjs` stay. | P3 |

### 1.3 Honest fallbacks (where the acceptance criteria meet reality)

- **"Risk-free rate loaded daily from an official source."** We cannot do this this round. Instead:
  - `reference.rate()` returns the user's entered rate (config or the dashboard **Market calendar** page), with its `asOf` and free-text `source` (for example "91-day T-bill cut-off, RBI auction 28 Oct 2026").
  - With nothing entered, it returns `0.065` with `source: "default (not sourced)"` and `quality: "default"`.
  - Every method note that uses the rate shows it this way. When the rate is a default or older than `rateStaleDays` (14), the Volatility and Arbitrage pages show "Rate: 6.50 % default, not sourced. Set it in Market calendar".
- **"Corporate actions with adjustment factors loaded daily."** No allowed automated source exists today. We ship three things:
  - a curated list (`reference/data/corporate-actions.json`, release-maintained, each row `verified` or not);
  - user entry (`POST /v1/reference/corporate-actions`);
  - **inference**: a contract whose lot size differs from the series' standard lot in `fo_mktlots.csv`, or whose strike is off the series' strike grid, is flagged `nonStandard: true, quality: "inferred"` with "probably adjusted for a corporate action".

  The calculator (§6.1) then turns a curated or entered action into the exchange-method adjusted strikes and lots. The fixture test proves the maths against the circular example (acceptance criterion 5).
- **Freeze quantities.** Where no master publishes one and the index list has no entry (stocks), we show "freeze qty unknown: slicing is not checked". We never invent a value.
- **F&O membership "by date".** Membership is point-in-time only from the first successful `fo_mktlots` fetch on this Bridge (`knownSince` in every response). Asking for an earlier date returns `coverage: "not-recorded"`, never today's list.
- **Holidays.** We ship the published list in the repo, and a release updates it each December. We also expose the list on the calendar page so the user can add or remove a day. A holiday row only **blocks** live orders when `verified: true`. Otherwise it warns, because a wrong holiday that blocks trading is worse than none (the stance in `server/lib/marketHours.mjs`).

---

## 2. Architecture

### 2.1 New and changed files

New, `server/bridge/reference/`:

| File | Purpose |
|---|---|
| `module.mjs` | `defineModule({ name: "reference", stream: "S16", configKey: "reference", services: { reference }, register, start, stop })`, plus the `ROUTES` table |
| `config.mjs` | `REFERENCE_CONFIG_SCHEMA` (zod, strict), `parseReferenceConfig` |
| `defaults.mjs` | **The only server file allowed to hold the S5 default literals**: `DEFAULT_RATE`, `DEFAULT_SESSIONS`, `DEFAULT_BROKERAGE` (exported, frozen, each with `source`) |
| `calendar.mjs` | Pure trading-day maths (§6.4–6.6) over `{ holidays, specialSessions, sessions }` |
| `corporateActions.mjs` | Pure adjustment calculator (§6.1) and the non-standard inference (§6.2) |
| `lots.mjs` | Pure: `parseMktLots(csv)`, lot history and effective dates (§6.3), and the universe-interval update (§6.8) |
| `parsers.mjs` | Pure: `parseSecBan(csv)`, `parseCombineOi(csv)`, MWPL % (§6.7) |
| `nseArchives.mjs` | HTTP fetch of the three archive files: polite gap, size cap, timeout, raw copy to disk. Uses `backup/httpClient.mjs`'s UA and timeout conventions and `server/lib/safeArchive.mjs` for the zip. |
| `store.mjs` | JSON stores under `dataDir/reference/` (atomic writes via `auth/fsUtil.mjs writeFileAtomic`) and retention |
| `referenceService.mjs` | `createReferenceService(deps)`: contract methods, scheduler, sync jobs and demo switch |
| `demoReference.mjs` | Deterministic demo datasets (§4) |
| `routes.mjs` | Handlers |
| `data/holidays.json` | Shipped holiday list (§2.3) |
| `data/delivery-margin.json` | Shipped E-n schedule (§2.3) |
| `data/charges.json` | Shipped statutory charges (moved from `options.js`) |
| `data/corporate-actions.json` | Shipped curated actions (may start empty plus fixture-only rows marked `illustrative: true`) |
| `__fixtures__/fo_mktlots.csv`, `fo_secban.csv`, `combineoi.csv`, `combineoi.zip`, `mktlots-revision.csv` | Parser fixtures (hand-made in the published layout, **needs verification** against a real download before the parsers are marked done) |
| Tests | listed in §9 |

New, dashboard: `server/bridge/dashboard/reference.js` (client module; add to `DASHBOARD_FILES` in `core/app.mjs`) and `server/bridge/dashboard/calendar.js` (the Market calendar page; add to `DASHBOARD_FILES`).

Changed:

| File | Change |
|---|---|
| `core/contracts.mjs` | Add the `reference` service contract (§2.2). Add `"reference"` to `requires` of `marketData` and `safety`. **Core change: the lead makes it.** |
| `core/builtinModules.mjs` | Add `reference` after `symbols` |
| `core/eventBus.mjs` | Add topic `reference.updated` `{ dataset, asOf, source, changed: boolean }` |
| `market/marketDataService.mjs` | Rate: `deps.reference.rate().value`. If `market.chain.riskFreeRate` was set explicitly in the file, it wins and logs a deprecation warning once. |
| `market/config.mjs` | `riskFreeRate` becomes `.optional()`, with no default (the default moves to `reference/defaults.mjs`) |
| `safety/safetyGuard.mjs` | NFO/BFO/NSE/BSE: `reference.session(exchange, t)` replaces `libMarketSession` when the service is not a stub. Holiday handling as in §7.1. |
| `scanner/scanService.mjs` | `due()` uses `deps.reference` when present (scanner registers with `reference` passed in) |
| `paper/config.mjs` + `paperEngine.mjs` | `sessionEnd.time` default `null` = "reference session close" |
| `orders/orderValidation.mjs` / `orderService.mjs` | Preview check `LOT_SIZE_STALE`, plus optional `lotSizeConfirmed` request field (§3.6) |
| `demo/demoAdapter.mjs` | `RATE` imported from `reference/defaults.mjs`; `expiriesFor` shifts holiday expiries to the previous trading day through `calendar.mjs`; per-contract `lotSize` follows the demo lot schedule (§4) |
| `mcp/tools.mjs` | Tool `get_reference` |
| `dashboard/options.js` | Remove `RISK_FREE`, `RATE`, `SESSION_OPEN`/`SESSION_CLOSE` and both charge literals. Functions take `rate`, `session`, `calendar` and `rates` as parameters (§5.6). |
| `dashboard/desk.js`, `vol.js`, `arbitrage.js`, `oi.js`, `strategy.js`, `screener.js`, `positions.js` | Pass reference values into those functions; banners and chips |
| `dashboard/views.js` | New `PAGES` entry `calendar`; `ICONS.calendar` glyph in `app.js` |
| `docs/openapi.yaml` | New tag `Reference data`, 20 operations and schemas (§3.8) |
| `docs/ARCHITECTURE.md`, `docs/STREAMS.md` | S16 row and dataDir layout |
| `bridge.config.example.json` | `reference` section |
| `core/cli.mjs` (`init`) | One question: "Download NSE's public F&O reference files (lot sizes, ban list, MWPL) once or twice a day?" |

### 2.2 Service contract

```js
// core/contracts.mjs
reference: {
  iface: "ReferenceData",
  stream: "S16",
  requires: ["symbols"],
  methods: ["session", "calendar", "rate", "lotFor", "freezeFor", "banStatus", "universe",
            "corporateActions", "events", "charges", "deliveryMargin", "status", "bundle", "sync"],
},
```

Dependency order: `accounts → scheduler → symbols → reference → marketData`. `safety` requires `audit, accounts, reference`. There is no cycle, because `reference` does not require `marketData`.

Signatures. Each returns plain data; every dataset value has `meta: { source, asOf, quality, verified?, stale?, staleTradingDays? }`.

| Method | Returns |
|---|---|
| `session(exchange, tMs)` | `{ state: "CLOSED"\|"PRE_OPEN"\|"OPEN"\|"SPECIAL"\|"HOLIDAY", label, date, open, close, preOpen, holiday: { label, verified } \| null, special \| null }` (times "HH:MM" IST) |
| `calendar()` | `{ isTradingDay(date, exch), prevTradingDay(date, exch), nextTradingDay(date, exch), tradingDaysBetween(a, b, exch), holidays: [...] }` (bound pure functions) |
| `rate(atDate?)` | `{ value, asOf, source, quality: "user"\|"config"\|"default", stale }` |
| `lotFor(underlying, expiry, { exchange })` | `{ lot, effectiveFrom, previousLot, source, asOf, conflict: null \| { master, reference } }` |
| `freezeFor(canonical)` | `{ freezeQty \| null, source: "master"\|"exchange-list"\|"config"\|null, verified }` |
| `banStatus(symbol, date?)` | `{ inBan, mwplPct, mwpl, oi, band: "ban"\|"high"\|"normal"\|null, forDate, asOf, source }` |
| `universe({ date, kind })` | `{ date, coverage: "recorded"\|"not-recorded", knownSince, items: [{ symbol, kind, exchange }] }` |
| `corporateActions({ symbol, from, to })` | `[CorporateAction]` (§2.4) |
| `events({ days = 7, underlying })` | `[{ kind: "lot-revision"\|"corporate-action"\|"holiday-expiry-shift", underlying, effectiveOn, daysAway, text, ref }]` |
| `charges()` | Statutory table (shape of today's `CHARGE_RATES`) + `brokerage` from config |
| `deliveryMargin(expiry, exch)` | `[{ date, label: "E-4", pct, verified }]` |
| `status()` | Per-dataset sync state (§2.4 `state.json`) |
| `bundle({ underlying, exchange, now })` | Everything one page needs (§3.3) |
| `sync({ datasets, reason })` | Starts a sync; resolves with per-dataset results (used by the route and the scheduler) |

### 2.3 Data model and storage on disk

Root: `dataDir/reference/` (mode 0700, created on start). Every write is atomic (`writeFileAtomic`). Every file has a top-level `{ "version": 1, ... }`. A file that fails to parse is renamed to `<name>.corrupt-<ts>` and the dataset restarts empty with a logged warning (§7.7 of the BRD: a corrupted file must not stop the next day).

```
dataDir/reference/
  state.json                  per-dataset sync state
  settings.json               choices made in the dashboard: { nseArchives: { enabled, at, by }, rate: {...} }
  lots.json                   lot history per (exchange, underlying, expiryMonth)
  universe.json               membership intervals
  ban.json                    ban list per forDate (last retentionDays)
  mwpl.json                   MWPL rows per forDate (last 30 days; the raw zip has the rest)
  corporate-actions.json      user-entered actions (shipped ones stay in the repo file)
  raw/YYYY-MM-DD/             raw downloads as fetched: fo_mktlots.csv, fo_secban.csv, combineoi.zip (+ .sha256)
```

`state.json`:
```json
{ "version": 1,
  "datasets": {
    "lots":     { "lastSuccessAt": "2026-10-29T08:20:41.120+05:30", "lastAttemptAt": "...", "asOf": "2026-10-29", "source": "nse-archives:fo_mktlots.csv", "sha256": "…", "rows": 214, "error": null, "nextRunAt": "2026-10-29T19:35:00.000+05:30" },
    "ban":      { "...": "..." },
    "mwpl":     { "...": "..." },
    "universe": { "knownSince": "2026-10-29", "...": "..." }
  } }
```

`lots.json` row (one row per exchange, underlying and expiry month; history is never deleted):
```json
{ "exchange": "NFO", "underlying": "NIFTY", "kind": "index", "expiryMonth": "2026-01", "lot": 65,
  "firstSeen": "2025-10-29", "lastSeen": "2026-10-29", "source": "nse-archives:fo_mktlots.csv" }
```
BFO rows come from masters (`source: "master:<broker>"`), because there is no BSE file this round.

`universe.json`:
```json
{ "version": 1, "knownSince": "2026-10-29",
  "intervals": [ { "symbol": "RELIANCE", "kind": "stock", "exchange": "NFO", "from": "2026-10-29", "to": null, "fromIsFirstFetch": true } ] }
```
`fromIsFirstFetch: true` means "a member on our first fetch". The true entry date is earlier and unknown; the API says so.

`CorporateAction` (shipped file, user file and API share the shape):
```json
{ "id": "ca_RELIANCE_2024-10-28_bonus", "symbol": "RELIANCE", "exchange": "NSE", "type": "bonus",
  "ratio": { "new": 1, "held": 1 }, "exDate": "2024-10-28",
  "subscriptionPrice": null, "cumPrice": null, "dividend": null, "fv": null,
  "factor": 2, "lotRule": "round", "strikeTick": 0.05,
  "source": "curated: NSE F&O adjustment circular (number to be filled)", "verified": false, "illustrative": true,
  "origin": "shipped" }
```
`type`: `bonus | split | consolidation | rights | dividend | other`. `origin`: `shipped | user | inferred`. `factor` is computed by `corporateActions.mjs`. It is never trusted from input; input only carries the ratio and prices.

Shipped `data/holidays.json` (the release updates it each December):
```json
{ "version": 1, "asOf": "2025-12-15", "source": "NSE circular on trading holidays for 2026 (number to be filled); BSE notice (number to be filled)",
  "years": { "2026": [ { "date": "2026-01-26", "label": "Republic Day", "exchanges": ["NSE","BSE"], "verified": false } ] },
  "special": [ { "date": "2026-11-08", "label": "Muhurat trading", "exchanges": ["NSE","BSE"], "open": null, "close": null, "verified": false } ] }
```
A special session with `open: null` has an unannounced time. It counts as closed until the user enters the times in config (the existing behaviour of `setSpecialSessions`).

Shipped `data/delivery-margin.json` (**needs verification**; the figures are the commonly cited NSE schedule and must be checked against the current NSCCL circular):
```json
{ "version": 1, "asOf": "2026-10-29", "source": "NSE Clearing circular on physical settlement margins (number to be filled)", "verified": false,
  "appliesTo": "stock derivatives, in-the-money and close-to-money long and short positions",
  "schedule": [ { "day": "E-4", "pct": 10 }, { "day": "E-3", "pct": 25 }, { "day": "E-2", "pct": 45 }, { "day": "E-1", "pct": 70 } ] }
```

Shipped `data/charges.json` holds exactly today's `options.js CHARGE_RATES` figures, minus brokerage, with `asOf: "2026-04-01"` and `source: "Union Budget 2026 STT; exchange and SEBI fee schedules (verify against contract note)"`.

### 2.4 Scheduler

Pattern: same as `scanner` and `notify`: `start()` arms a 60-second `setInterval` (`unref()`), and `stop()` clears it. All times are IST, read with `market/time.mjs istParts` and `deps.clock`.

| Job | When (IST, config) | Datasets | Retry | Trading days only |
|---|---|---|---|---|
| `morning` | `08:20`, retry `08:50` | lots, universe (from the same file), ban (for today, if the evening run missed), inferred corporate actions (from masters) | Once at the retry time, then the evening job | Yes (skips holidays) |
| `evening` | `19:35`, retry `21:05` | ban (for the next trading day), mwpl, lots (catches mid-day revisions) | Once | Yes |
| `startup` | 30 s after `start()` | Any dataset whose `lastSuccessAt` is older than its `staleAfterTradingDays` | No | No |
| `retention` | inside `morning` | Removes `raw/` folders older than `retentionDays` and trims `ban.json`/`mwpl.json` | — | — |

Minutes are deliberately off :00/:30, so many Bridges do not hit NSE at the same instant. Each Bridge also adds a deterministic jitter of `hash(dataDir) % 240` seconds.

Masters: `reference` never downloads masters itself. It reads `symbols.search()` and `symbols.status()` (already warmed daily by `symbols`). Inference re-runs whenever `symbols.status()` shows a newer `loadedAt`, checked on the minute tick.

### 2.5 Config (`reference` section)

```jsonc
"reference": {
  "sources": {
    "nseArchives": {
      "enabled": false,            // a fresh install calls no third-party site; `mc-bridge init` or the Market calendar page turns it on
      "baseUrl": "https://nsearchives.nseindia.com",   // needs verification
      "gapMs": 2000,               // at least this long between two requests
      "timeoutMs": 15000,
      "maxBytes": 20971520         // 20 MB per file, before and after unzip
    }
  },
  "schedule": { "morning": "08:20", "morningRetry": "08:50", "evening": "19:35", "eveningRetry": "21:05" },
  "staleAfterTradingDays": 1,      // BRD: stale = over 1 trading day
  "bannerDays": 7,                 // BRD: effective within 7 days
  "blockLotsWhenStale": false,     // true: API orders sent in lots are refused when lots are stale and not confirmed
  "rate": { "value": null, "asOf": null, "source": null },   // decimal, e.g. 0.0571
  "rateStaleDays": 14,
  "sessions": {                     // IST "HH:MM"; null keeps the S5 default in defaults.mjs
    "NFO": { "preOpen": null, "open": null, "close": null },
    "BFO": { "preOpen": null, "open": null, "close": null }
  },
  "specialSessions": { },          // { "2026-11-08": { "open": "18:00", "close": "19:00", "label": "Muhurat", "exchanges": ["NSE","BSE"] } }
  "holidays": { "add": [], "remove": [] },   // [{ "date": "2026-11-24", "label": "...", "exchanges": ["NSE"], "verified": true }]
  "freeze": { },                   // { "NFO:NIFTY": 1800 } overrides (units)
  "brokerage": { "kind": "flat", "perOrder": 20 },   // moved from options.js; per-account plans are P1-10
  "extraordinaryDividendPct": 2,   // threshold for dividend adjustments, needs verification
  "retentionDays": 400
}
```

Defaults come from `reference/defaults.mjs`: `DEFAULT_SESSIONS = { NFO: { preOpen: "09:00", open: "09:15", close: "15:30" }, BFO: {...same} }`, `DEFAULT_RATE = 0.065`, `DEFAULT_BROKERAGE = { kind: "flat", perOrder: 20 }`. Each carries `source: "S5 default (equity-derivatives session per NSE/BSE; needs verification)"`.

Precedence for the archive switch and the rate: `settings.json` (a dashboard choice, which records who made it and when) overrides config, and config overrides defaults. `GET /v1/reference/status` reports which one is in force.

### 2.6 Sync algorithm (one dataset)

1. Skip if `nseArchives.enabled` is false. Record `error: { code: "SOURCE_OFF" }`, which tells the API and UI the reason.
2. Fetch through the archive client: one request in flight, `gapMs` apart, `timeoutMs`, body capped at `maxBytes`, and a zip inflated with `safeArchive` caps (one entry, CSV only).
3. Write the raw file to `raw/<date>/` with its sha256. If the sha256 equals the last success, update `lastSuccessAt` only (`changed: false`).
4. Parse with the pure parser. A parse failure keeps the previous dataset in force, records `error: { code: "PARSE_FAILED", detail }` and logs once.
5. Merge (lots history, universe intervals, ban for `forDate`), write the store atomically, update `state.json`, and emit `reference.updated`.
6. Errors map to `BridgeError` codes the rest of the Bridge knows (`UPSTREAM_TIMEOUT`, `UPSTREAM_RATE_LIMITED`, `UPSTREAM_ERROR`). After two consecutive failures a dataset waits for the next scheduled job and is not hammered.

---

## 3. API changes

All routes belong to module `reference` (`x-stream: S16`). Reads use `scope: read`. Writes use `scope: admin` with `loopbackOnly: true`: they change shared reference data that pricing reads, so only this computer's dashboard or CLI may make them. Nothing here can place an order or switch on live trading.

Every response is `{ data, meta: { requestId, ... } }`, as for other routes. Each dataset object has `source`, `asOf`, `quality` and `stale`. Dates are `YYYY-MM-DD` in IST, times `HH:MM` IST, timestamps ISO-8601 with `+05:30`, rates are decimals, quantities are units, and lots are units per lot.

### 3.1 Route table

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/v1/reference/status` | read | Sync state per dataset; which sources are on |
| GET | `/v1/reference/bundle` | read | One call per page: everything for an underlying |
| GET | `/v1/reference/expiries` | read | Listed expiries with kind, shift flag and lot |
| GET | `/v1/reference/sessions` | read | Session for a date and exchange |
| GET | `/v1/reference/holidays` | read | Holidays in a range |
| GET | `/v1/reference/lots` | read | Lot history and effective dates; freeze qty |
| GET | `/v1/reference/ban` | read | Ban list for a trading date |
| GET | `/v1/reference/mwpl` | read | MWPL % per stock for a date |
| GET | `/v1/reference/fno-universe` | read | Point-in-time F&O membership |
| GET | `/v1/reference/corporate-actions` | read | Curated, user and inferred actions |
| POST | `/v1/reference/corporate-actions/preview` | read | Pure calculator: adjusted strikes and lot |
| POST | `/v1/reference/corporate-actions` | admin, loopback | Add a user action |
| DELETE | `/v1/reference/corporate-actions/{id}` | admin, loopback | Remove a user action |
| GET | `/v1/reference/rate` | read | Current rate with source |
| PUT | `/v1/reference/rate` | admin, loopback | Set rate, asOf, source |
| GET | `/v1/reference/charges` | read | Statutory charges + default brokerage |
| GET | `/v1/reference/delivery-margin` | read | E-n schedule with dates for an expiry |
| GET | `/v1/reference/events` | read | Lot revisions, corporate actions and expiry shifts within N days |
| PUT | `/v1/reference/sources` | admin, loopback | Turn NSE archive downloads on or off |
| POST | `/v1/reference/sync` | admin, loopback | Run a sync now |

(20 operations; the BRD's indicative list in §5.6 is a subset.)

### 3.2 Common errors

| Code | When |
|---|---|
| `VALIDATION_FAILED` 400 | Bad date, unknown exchange, `from > to`, range over 400 days, unknown dataset |
| `SYMBOL_NOT_FOUND` 404 | `underlying`/`symbol` not in any master and not in the universe |
| `NOT_FOUND` 404 | `DELETE` of an unknown or non-user corporate action |
| `CAPABILITY_UNSUPPORTED` 422 | `PUT /sources` or `POST /sync` in demo mode ("demo mode never downloads") |
| `LOOPBACK_ONLY` / `SCOPE_REQUIRED` 403 | Writes from elsewhere or without admin |
| `RATE_LIMITED` 429 | Per-key client limit (existing) |
| `IDEMPOTENCY_IN_PROGRESS` 409 | `POST /sync` while a sync is running (body names the running job) |

A dataset that is unavailable is **not** an error. It returns 200 with `available: false` and `reason` (`SOURCE_OFF`, `NEVER_FETCHED`, `NOT_RECORDED`, `PARSE_FAILED`, `NO_MASTER`), as BRD D5 requires.

### 3.3 `GET /v1/reference/bundle?underlying=NIFTY[&exchange=NFO]`

The dashboard calls this once per page load and per underlying change, and then every 10 minutes.
```json
{ "data": {
    "underlying": "NIFTY", "exchange": "NFO", "kind": "index", "now": "2026-10-29T10:02:11.000+05:30",
    "session": { "state": "OPEN", "date": "2026-10-29", "preOpen": "09:00", "open": "09:15", "close": "15:30", "holiday": null, "special": null,
                 "source": "S5 default", "asOf": "2026-10-29" },
    "nextTradingDay": "2026-10-30", "prevTradingDay": "2026-10-28",
    "holidays": [ { "date": "2026-11-24", "label": "Guru Nanak Jayanti", "exchanges": ["NSE","BSE"], "verified": false } ],
    "rate": { "value": 0.065, "asOf": null, "source": "default (not sourced)", "quality": "default", "stale": true },
    "expiries": [
      { "date": "2026-11-03", "kind": "weekly", "lot": 65, "shifted": false },
      { "date": "2026-11-23", "kind": "monthly", "lot": 65, "shifted": true, "ruleDate": "2026-11-24", "reason": "2026-11-24 is a holiday (unverified)" } ],
    "lots": { "current": 65, "next": { "lot": 65, "from": null }, "source": "nse-archives:fo_mktlots.csv", "asOf": "2026-10-29",
              "stale": false, "staleTradingDays": 0, "conflict": null },
    "freeze": { "freezeQty": 1800, "source": "exchange-list", "verified": false },
    "ban": null,
    "events": [],
    "deliveryMargin": null,
    "charges": { "asOf": "2026-04-01", "...": "..." },
    "warnings": [ "Rate is the 6.50 % default, not sourced." ] },
  "meta": { "requestId": "…" } }
```
For a stock, `ban` is `{ "inBan": false, "mwplPct": 84.2, "band": "high", "forDate": "2026-10-29", "asOf": "2026-10-28", "source": "nse-archives:combineoi" }` and `deliveryMargin` covers the nearest expiry.

The `shifted`/`ruleDate` fields compare the listed date against the usual weekday seen in the listed expiries (§6.6). They are explanation only; the listed date always wins.

### 3.4 Other read routes (shapes)

- `GET /v1/reference/expiries?underlying=&exchange=` returns `{ underlying, exchange, expiries: [ { date, kind, lot, shifted, ruleDate?, reason?, source } ], source, asOf }`. `kind` is `monthly` when the date is the last listed expiry of its calendar month (the existing `isMonthlyExpiry` rule), else `weekly`. Futures-only underlyings return `kind: "monthly"`.
- `GET /v1/reference/sessions?date=2026-11-08&exchange=NFO` returns `{ date, exchange, state, preOpen, open, close, holiday, special, tradingDay: false, source }`.
- `GET /v1/reference/holidays?from=2026-01-01&to=2026-12-31&exchange=NSE` returns `{ items: [ { date, label, exchanges, verified, origin: "shipped"|"config" } ], source, asOf }`.
- `GET /v1/reference/lots?underlying=NIFTY[&exchange=NFO][&from=2025-10-01]` returns `{ underlying, history: [ { expiryMonth, lot, effectiveFrom, lastOldExpiry, source } ], current, next, freeze, stale, staleTradingDays }`.
- `GET /v1/reference/ban?date=2026-10-30` returns `{ forDate, items: [ { symbol, mwplPct } ], available, reason?, asOf, source }`.
- `GET /v1/reference/mwpl?date=&symbol=` returns `{ forDate, items: [ { symbol, mwpl, oi, mwplPct, band, limitNextDay } ], available, asOf }`. With `symbol` it returns one item.
- `GET /v1/reference/fno-universe?date=2026-10-29&kind=stock|index|all` returns `{ date, coverage, knownSince, items: [ { symbol, kind, exchange, since, sinceIsFirstFetch } ], count, changes: [ { date, symbol, change: "added"|"removed" } ] }` (changes within the last 90 days).
- `GET /v1/reference/corporate-actions?symbol=&from=&to=&origin=` returns `{ items: [CorporateAction & { adjusted?: { exampleStrikes: [...], lotBefore, lotAfter } }] }`.
- `GET /v1/reference/rate` returns `{ value, asOf, source, quality, stale, setBy?: "dashboard"|"config" }`.
- `GET /v1/reference/charges` returns `{ asOf, source, opt: {...}, fut: {...}, sebiPerCrore, ipftPerCrore, gst, brokerage: { kind, perOrder } }`.
- `GET /v1/reference/delivery-margin?underlying=RELIANCE&expiry=2026-11-23` returns `{ expiry, items: [ { day: "E-4", date: "2026-11-17", pct: 10 } ], verified: false, source, appliesTo }`. Index underlyings return `available: false, reason: "INDEX_CASH_SETTLED"`.
- `GET /v1/reference/events?days=7[&underlying=]` returns `{ items: [ { kind, underlying, effectiveOn, daysAway, text, ref } ] }` with `days` 1–30.
- `GET /v1/reference/status` returns `{ demo, sources: { nseArchives: { enabled, setBy, setAt } }, datasets: { <name>: { available, asOf, source, lastSuccessAt, lastAttemptAt, nextRunAt, stale, error } }, knownSince }`.

### 3.5 Write routes

`POST /v1/reference/corporate-actions/preview` (read; pure maths, stores nothing)
```json
// request
{ "type": "rights", "ratio": { "new": 1, "held": 5 }, "subscriptionPrice": 100, "cumPrice": 250,
  "lot": 1000, "strikes": [240, 250, 260], "strikeTick": 0.05 }
// response
{ "data": { "factor": 1.111111, "terp": 225, "lotAfter": 1111, "lotExact": 1111.111, "nonStandardLot": true,
            "strikes": [ { "before": 240, "after": 216 }, { "before": 250, "after": 225 }, { "before": 260, "after": 234 } ],
            "method": "NSE ratio method: factor = cum / TERP; strike / factor rounded to the tick; lot × factor rounded (needs verification)" } }
```

`POST /v1/reference/corporate-actions` (admin, loopback). Body: `CorporateAction` minus `id`, `factor`, `origin` and `verified` (the server sets `origin: "user"`, `verified: true`, because the user vouches for their own entry). Returns 201 with the stored row. Duplicate (`symbol`, `type`, `exDate`) gives `VALIDATION_FAILED`. Written to the audit log as `reference.corporate_action.added`.

`DELETE /v1/reference/corporate-actions/{id}` returns 204. Only `origin: "user"` rows can be deleted. Audited.

`PUT /v1/reference/rate` (admin, loopback). Body `{ "value": 0.0571, "asOf": "2026-10-28", "source": "91-day T-bill cut-off, RBI auction" }`. `value` must be a decimal in 0–0.25 and `source` 3–120 chars. Stored in `settings.json` and audited. Returns the new `rate` object.

`PUT /v1/reference/sources` (admin, loopback). Body `{ "nseArchives": true }`. Stored in `settings.json` with `setBy: principal`, `setAt`, and audited. Turning it on queues a `startup`-style sync.

`POST /v1/reference/sync` (admin, loopback). Body `{ "datasets": ["lots","ban","mwpl"] }` (optional). Returns 202 `{ jobId, datasets, startedAt }`. Progress is visible on `/status`.

### 3.6 Orders change (S7, additive)

- `OrderRequest` gains the optional `lotSizeConfirmed: integer` (units per lot). Documented as "the lot size the caller has checked; used only when reference lot data is stale".
- Preview adds check `LOT_SIZE_STALE`. It is a warning by default. It becomes a block when `reference.blockLotsWhenStale` is true, the request uses `lots`, the underlying's lot data is stale (`staleTradingDays > staleAfterTradingDays`) or has a master/reference conflict, and `lotSizeConfirmed` is missing or differs from the resolved lot. Message: "Lot size for NIFTY is from 27 Oct (2 trading days old). Confirm 65 units per lot or send quantity in units."
- Requests that send `quantity` are never blocked by this check.

### 3.7 MCP

Tool `get_reference` (read). Input `{ dataset: "bundle"|"expiries"|"sessions"|"holidays"|"lots"|"ban"|"mwpl"|"fno-universe"|"corporate-actions"|"rate"|"charges"|"delivery-margin"|"events"|"status", underlying?, symbol?, date?, from?, to?, days? }`. It calls the same service methods and returns the same fields. It has no write tool: MCP can never set the rate, add actions or switch sources.

### 3.8 `docs/openapi.yaml` additions

- `tags:` add `- name: Reference data` with description "Contract calendar, lots, ban list, MWPL, F&O universe, corporate actions, rate and charges (stream S16). Every value carries source and asOf."
- `components/schemas` add: `RefMeta` (`source`, `asOf`, `quality` enum `[exchange, master, curated, user, config, default, inferred, demo]`, `verified`, `stale`, `staleTradingDays`), `RefSession`, `RefHoliday`, `RefExpiry`, `RefLotRow`, `RefBanItem`, `RefMwplItem`, `RefUniverseItem`, `CorporateAction`, `CorporateActionPreviewRequest`, `CorporateActionPreview`, `RefRate`, `RefCharges`, `RefDeliveryMarginItem`, `RefEvent`, `RefDatasetStatus`, `RefBundle`, and `RefUnavailable` (`available: false`, `reason` enum open-ended).
- `components/schemas/OrderRequest`: add `lotSizeConfirmed: { type: integer, minimum: 1 }`.
- Twenty `paths` entries in the file's layout. `openapi.test.mjs` reads `x-stream: S16`, `x-scope`, and `x-loopback-only: true` on the five writes. Example for one:

```yaml
  /v1/reference/lots:
    get:
      tags: [Reference data]
      operationId: getReferenceLots
      summary: Lot size history with effective dates, and the freeze quantity
      x-stream: S16
      x-scope: read
      parameters:
        - { name: underlying, in: query, required: true, schema: { type: string, maxLength: 30 } }
        - { name: exchange, in: query, schema: { type: string, enum: [NFO, BFO] } }
        - { name: from, in: query, schema: { type: string, format: date } }
      responses:
        "200":
          description: Lot history, newest last. Lots are units per lot.
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { $ref: "#/components/schemas/RefLots" }
                  meta: { $ref: "#/components/schemas/Meta" }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }
```
- `/v1/expiries` stays unchanged (back-compat); its description gains "See /v1/reference/expiries for kind, lot and holiday shifts."

---

## 4. Demo mode

Demo mode never touches the network: `PUT /sources` and `POST /sync` answer `CAPABILITY_UNSUPPORTED`, and the archive client is not constructed. `createReferenceService` checks `config.demo` and installs `demoReference.mjs` as the dataset provider. Everything else runs unchanged (calendar, routes, banners and the order check), so the whole feature can be tested.

Every demo value has `source: "demo"`, `quality: "demo"` and `verified: true`. It is deterministic for a given IST date: `hash32` and `unit` from `demoAdapter.mjs`, seeded by `date + symbol`.

| Dataset | Demo behaviour |
|---|---|
| Holidays | The shipped real `holidays.json` (so the calendar looks real), treated as `verified: true` in demo only, except the last holiday of each year (Christmas), which stays unverified so the "unverified" label, mark and order-check warning can be seen. `expiriesFor()` in the demo adapter shifts an expiry that lands on a holiday to the previous trading day, so the "shifted" flag can be seen (for example 24 Nov 2026 → 23 Nov, if the list has it). |
| Sessions | Defaults. A demo special session on the shipped Muhurat date with `open: "18:00", close: "19:00"`, labelled demo. |
| Lots | Current demo lots become NIFTY 65, BANKNIFTY 30, SENSEX 20 (today's demo uses 75/35, which predate the Jan 2026 revision). **Rolling demo revision**: BANKNIFTY moves 30 → 35 for contracts in the month after the next monthly expiry. The demo adapter's `demoInstruments()` gives those contracts the new lot, so masters and reference agree, and the banner shows in the 7 days before each monthly expiry. |
| Stock F&O universe | The NIFTY 50 demo stocks are all members, each with a demo lot (round(₹7.5 lakh / base price) rounded to a multiple of 25, minimum 25). These lots are exported as **`DEMO_STOCK_LOT`** from `demoReference.mjs`: the one table that P1-1 (five demo stock underlyings) and P1-6 (all 50) import into the demo adapter, so masters and reference always agree. History: two stocks show as "added" 20 and 45 days ago, and one demo-only symbol `DEMOEXIT` as "removed" 30 days ago, with `knownSince` = today − 120 days. |
| Ban list / MWPL | Per IST date, 2–3 stocks with `mwplPct` 95.2–99.0 (in ban), 3 between 80 and 95 ("high"), and the rest 15–79. The choice rotates daily by hash, so ban chips change from day to day. |
| Corporate actions | One rolling upcoming action: a 1:1 bonus on the demo stock picked by `hash(weekStart) % 50`, ex-date = today + 4 trading days, so a banner is always present. One past split (FV 10 → 2) 60 days ago on another stock, with adjusted strikes shown. One `inferred` non-standard contract (lot 1,875 vs standard 375) on that split stock. |
| Rate | 0.065, `source: "demo"`, `stale: false`. The demo adapter prices with the same value through `reference/defaults.mjs`. |
| Delivery margin | Shipped schedule, dated from the nearest monthly expiry. |
| Status | All datasets `available: true`, `asOf` today 08:20, `nextRunAt` tomorrow 08:20. A query flag `?demoStale=1` on `/v1/reference/bundle` (honoured in demo only) reports lots as 2 trading days old, so the stale banner and ticket confirmation can be tested and screenshotted. *As built:* the demo-only `PUT /v1/demo/reference { lotsStale }` does the same for every read (status included: `datasets.lots` turns stale and `demoLotsStale: true`), and the Market calendar status strip has a "Show stale lot data" switch for it (demo, this computer). |

Demo stock option chains are **not** added in this round (P1-6). The demo shows stock reference data on the Market calendar page and in the API only.

---

## 5. Dashboard

The restyle team owns colours, type and motion. This section uses only the shared tokens (`--ios-orange`, `--ios-orange-ink`, `--ios-red-ink`, `--mat-separator`, `--foreground` with `--a-label`/`--a-quiet`) and existing classes and helpers (`alertBox`, `emptyState`, `freshnessPill`, `modal`, `sheetPopover`, `segmented`). It adds no new colours. New CSS classes are named, and their visual treatment is left to the restyle tokens.

### 5.1 `reference.js` (new client module)

- `REF_DEFAULTS`: the fallback values used only if `/v1/reference/bundle` fails (rate 0.065, sessions 09:15/15:30, brokerage 20, the charge table). **It is the only dashboard file allowed to hold these literals.** Every value is tagged `source: "dashboard fallback"`, and the UI says so.
- `loadReference(underlying, { force })`: fetches the bundle. It is cached per underlying for 10 minutes and refreshed on underlying change. Returns the bundle or `{ fallback: true, ...REF_DEFAULTS }`.
- `refRate(b)`, `refSession(b)`, `refCalendar(b)` (a holiday set + `isTradingDay` for the client, built from `b.holidays`), `refCharges(b)`.
- `refChip(b)`: the compact chip in the Options top bar.
- `refBanners(b, { positions })`: returns zero or more banner nodes (§5.3).
- `lotConfirmGate(b, lot)`: `{ needed, text }` for the ticket.

### 5.2 Options top bar: reference chip

On every Options page (chain, strategy, OI, vol, screener, arb, positions), the compact top bar from the foundation spec gets one chip after the expiry select:
- Content: `Lot 65 · Freeze 1,800` and, when relevant, `· 1 event`, `· Stale`, or `· Holiday tomorrow`.
- Tap or click: a `sheetPopover` "Contract facts" listing session today (open/close), next trading day, lot (with the next lot and date if one is scheduled), freeze qty and its source, rate with source and age, ban/MWPL (stocks), upcoming events, and each item's `source` and `asOf`. There is a link to the Market calendar page.
- States: `stale` (orange ink token), `fallback` ("Reference data unavailable: using dashboard defaults", red ink token), normal (label ink).
- Phone (<720 px): the chip shows only the lot (`Lot 65`) and a dot when there is a warning or event. The popover opens as a bottom sheet. Tablet (720–1024): as phone plus the event count. Desktop: full text.
- Keyboard: focusable, Enter opens. `aria-label` reads the full text.

### 5.3 Banners (acceptance criterion 3)

- `refBanners()` renders above the page body (below the top bar), one per event, at most 2 visible, with "+N more" opening the popover.
- Text is descriptive only. Examples:
  - "NIFTY lot size changes from 75 to 65 for contracts from the Jan 2026 series (first trading day 31 Dec, in 5 days). Source: NSE market lots, 24 Dec."
  - "RELIANCE 1:1 bonus, ex-date 4 Nov (in 4 trading days). Strikes halve and lots double on that day."
- Shown on every Options page for the selected underlying.
- **Positions page**: every position row whose underlying has an event within `bannerDays` gets an inline chip "Lot change 5 Nov" or "Bonus ex 4 Nov" (class `ref-event-chip`). A single banner above the book lists the affected underlyings. Positions keep the lot size they opened with (BRD §8.1): the row's lot is the contract's master lot, not the new one.
- Dismiss: "Hide until tomorrow" per event id, stored in `localStorage` (`mcb.dashboard.refHidden`, try/catch). Hidden events still show in the chip count.
- Stale warning (acceptance criterion 4): when `lots.stale` or `ban` data is older than allowed, an `alertBox` (warn) reads "Contract data is 2 trading days old (lot sizes from 27 Oct). Check the lot size before ordering in lots." Also on all Options pages.

### 5.4 Order ticket (`desk.js openTicket`)

- When `lotConfirmGate(b, lotSize).needed` (stale lots or a master/reference conflict), the lots field shows a required checkbox: "Lot size 65 units, from 27 Oct (2 trading days old). I have checked it." **Place** and **Preview** stay disabled until it is ticked.
- Switching the ticket to units (the existing odd-quantity mode) removes the gate.
- The checked lot is sent as `lotSizeConfirmed`.
- The strategy builder's place flow (`strategy-place.js`) uses the same gate once per basket.

### 5.5 Market calendar page (new, `calendar.js`)

`PAGES` entry: `{ id: "calendar", label: "Market calendar", icon: "calendar", tint: "teal", group: "Options", layout: "desk", title: "Market calendar", sub: "Expiries, holidays, lot sizes, ban list and corporate actions, with their sources" }`. Add `ICONS.calendar` (an outline calendar glyph in the same stroke style).

Panels, top to bottom on phone; two columns from 1024 px (left: calendar and expiries; right: data status, rate and sources):

1. **Status strip**: one tile per dataset (Lots, Ban, MWPL, Universe, Holidays, Rate). Each tile shows `asOf` age and a state word: "Current", "1 day old", "Stale", "Off", "Not fetched". Tap shows source, last attempt and error. With the archives off, one notice: "NSE archive downloads are off. Lot sizes come from your broker's master; ban list, MWPL and universe history are unavailable." with a **Turn on** button (calls `PUT /v1/reference/sources`; it is hidden unless the page is on this computer, and the server enforces that anyway).
2. **Month calendar** (`table` with a 7-column grid): trading days, holidays (label, with "unverified" in quiet ink), special sessions, and markers for the selected underlying's expiries (weekly/monthly) and shifted expiries ("moved from Tue 24"). Previous/next month buttons. Phone: a vertical list of the month's non-ordinary days instead of the grid.
3. **Expiries and lots** for the selected underlying: table of date, kind, lot, freeze, shifted. Below it, the lot history (expiry month → lot) with the effective date.
4. **Ban list and MWPL** (stocks): today's ban list, then a sortable MWPL table (symbol, MWPL %, band) with a search box. Copy: "In ban: no fresh positions; closing is allowed. Source: NSE combined OI, end of day 28 Oct." Neutral wording only.
5. **F&O universe**: count, `knownSince`, and the changes in the last 90 days. A date picker shows membership on a date. Dates before `knownSince` show "Not recorded on this Bridge before 29 Oct 2026".
6. **Corporate actions**: upcoming and recent, each with type, ratio, ex-date, factor, origin (shipped/user/inferred), verified. **Add** opens a form (type, ratio, ex-date, prices). A live preview from `POST /corporate-actions/preview` shows adjusted strikes for the five strikes around ATM and the new lot. Save calls the admin route.
7. **Risk-free rate**: current value, source, age. The edit form takes value %, as-of date and source text. Copy: "Used for forwards, IV and Greeks on every page. Enter the 91-day T-bill or your preferred rate."
8. **Charges**: read-only table of statutory charges with `asOf` and source; brokerage default.

Every panel has CSV export (K5) and a "?" method note (K3) with the definitions in §6. Tables scroll inside their panel with a sticky first column, with no horizontal page scroll at 360 px.

### 5.6 Constant removal in the Options pages

| Today | After |
|---|---|
| `options.js` `RISK_FREE = 0.065`; `parityGrowth(years, rate = RISK_FREE)` | `parityGrowth(years, rate)` with `rate` required (returns 1 if not finite). Callers pass `refRate(bundle).value`. *As built:* `parityGrowth` stays a plain number for the maths; the `rateMissing` flag is the companion `rateMissing(rate)` / `parityGrowthInfo(years, rate)` → `{ growth, rateMissing }`, and `reference.test.mjs` checks that every page call site passes the rate. |
| `options.js:2658` `RATE = 0.065` (vol page) | Removed. The vol functions take `rate` in their options object, and `vol.js` passes it. The method note shows rate, source and age. |
| `options.js` `SESSION_OPEN/SESSION_CLOSE`, `marketSession(nowMs)`, `sessionsLeft(expiry, now)` | `marketSession(nowMs, session)` and `sessionsLeft(expiry, now, { session, isTradingDay })`. Holidays are skipped. Labels come from `session.holiday?.label`. |
| `options.js` `expiryCloseMs`, `timeToExpiry` (15:30 literal) | Take `close` from the session. Default `REF_DEFAULTS` only through `reference.js`. |
| `options.js` `CHARGE_RATES` and `CHARGES` (two copies, both with `brokeragePerOrder: 20`) | One table from `refCharges(bundle)`. `CHARGES` (percent form, used by the screener) becomes `chargesPct(rates)`, derived from it. Brokerage comes from `bundle.charges.brokerage`. The screener's own brokerage setting still overrides. |
| `desk.js` `UNDERLYINGS` | **Unchanged this round** (P1-6 swaps it for `/v1/reference/fno-universe`). |

The pure functions stay pure and keep their tests: the tests pass explicit `rate`/`session` values and gain cases for holidays.

### 5.7 Responsive summary

| Element | Phone (<720) | Tablet (720–1024) | Desktop (≥1024) |
|---|---|---|---|
| Reference chip | `Lot 65` + dot; bottom sheet | + event count; popover | full text; popover |
| Banners | One line, truncated, tap to expand; max 1 visible | max 2 | max 2 |
| Ticket gate | checkbox under lots, full width, 44 px target | same | inline |
| Calendar page | single column; month as list | single column; grid | two columns; grid |

---

## 6. Formulas and worked examples

All the functions below are pure (`calendar.mjs`, `corporateActions.mjs`, `lots.mjs`, `parsers.mjs`) with reference-value tests.

### 6.1 Corporate-action adjustment (J8; exchange method, needs verification)

Notation: lot L, strike K, adjustment factor AF. Adjusted strike K′ = round_tick(K / AF). Adjusted lot L′ = L × AF, rounded to the nearest integer; a non-integer L × AF marks the contract **non-standard**. Price history (LATER, P1-3): P′ = P / AF.

| Type | Input | AF |
|---|---|---|
| Bonus a:b (a new for every b held) | ratio | (a + b) / b |
| Split, face value x → y | fv | x / y |
| Consolidation, x → y (y > x) | fv | x / y (< 1) |
| Rights a:b at subscription S, cum price P (close before ex-date) | ratio, S, P | P / TERP, where TERP = (b·P + a·S) / (a + b) |
| Extraordinary dividend D (above `extraordinaryDividendPct` of the cum price) | D, P | none. K′ = K − D; L′ = L. |

Worked examples (each is a fixture in `corporateActions.test.mjs`):

1. **Bonus 1:1**: RELIANCE, ex-date 28 Oct 2024. This is the known real case, used as the acceptance fixture; **verify against the NSE circular before marking the row `verified`**.
   - AF = (1 + 1)/1 = 2.
   - Lot 250 → 500.
   - Strike 2,800 → 1,400. Strike 2,820 → 1,410. Strike 2,830 → 1,415.
2. **Split** FV ₹10 → ₹2 (illustrative):
   - AF = 5.
   - Lot 375 → 1,875.
   - Strike 2,410 → 482. Strike 2,415 → 483.
3. **Rights** 1:5 at ₹100, cum price ₹250 (illustrative):
   - TERP = (5·250 + 1·100)/6 = 1,350/6 = 225. AF = 250/225 = 1.1111.
   - Strike 260 → 260/1.1111 = 234.00. Strike 250 → 225.00.
   - Lot 1,000 → 1,111.11 → 1,111 (non-standard).
4. **Dividend** ₹40 on cum price ₹1,000 (4 % ≥ 2 %, illustrative): strike 1,000 → 960; lot unchanged.

Rounding: strikes are rounded to the nearest `strikeTick` (default 0.05; **needs verification**), with half rounded away from zero. The maths runs in integer paise to avoid float drift: `Math.round(K * 100 / AF / 5) * 5 / 100`.

### 6.2 Non-standard contract inference (J8, inferred)

For each listed stock option contract c in the masters, with the series' standard lot L_std (from `fo_mktlots` for c's expiry month):
- `lotMismatch` = c.lot ≠ L_std.
- `offGrid` = the strike is not on the series' modal strike step. The step is the most common gap between consecutive listed strikes for that expiry.
- Flag `nonStandard = lotMismatch || offGrid`, `quality: "inferred"`, text "Probably adjusted for a corporate action".

Example: split stock, standard lot 375, contract lot 1,875 → lotMismatch, flagged. Strikes 482, 483 on a grid with modal step 5 → offGrid, flagged.

### 6.3 Lot effective date

`fo_mktlots.csv` gives a lot per underlying for each listed expiry month (columns such as `OCT-26`, `NOV-26`, `DEC-26`; **layout needs verification**). The lot is a property of the contract's expiry month: `lotFor(u, expiry) = lots[u][month(expiry)]`.

When month m has lot L₁ and month m+1 has L₂ ≠ L₁:
- `lastOldExpiry` = the last listed expiry with lot L₁ (the monthly expiry of month m).
- `effectiveFrom` = `nextTradingDay(lastOldExpiry)`: the first day on which the nearest listed contract carries L₂.

Banner shows when `0 ≤ calendarDays(today, effectiveFrom) ≤ bannerDays (7)`.

Example (the Jan 2026 revision; **dates need verification**): DEC-25 = 75, JAN-26 = 65. `lastOldExpiry` = Tue 30 Dec 2025 → `effectiveFrom` = Wed 31 Dec 2025. Banner from 24 Dec 2025: "NIFTY lot 75 → 65 from the Jan 2026 series (31 Dec, in 7 days)".

Conflict: if a master's contract lot ≠ `lotFor()`, the master wins for orders (it is the broker's contract), `conflict` is set, and the ticket gate (§5.4) applies.

### 6.4 Trading days and staleness

- `isTradingDay(d, exch)` = weekday(d) ∉ {Sat, Sun} and d ∉ holidays(exch) (minus config `remove`, plus config `add`), **or** d has a special session with times set.
- `tradingDaysBetween(a, b)` = |{ d : a < d ≤ b, isTradingDay(d) }|.
- `staleTradingDays(dataset)` = `tradingDaysBetween(asOfDate, today)`.
- Stale when `staleTradingDays > staleAfterTradingDays` (1).

Example:
- Lots fetched Thu 29 Oct 2026 08:20. On Mon 2 Nov 10:00, with both Monday syncs failed: trading days after 29 Oct up to 2 Nov = {Fri 30 Oct, Mon 2 Nov} = 2 > 1 → **stale**.
- If Fri 30 Oct were a holiday, the count is 1 → not stale; the chip says "1 day old".

### 6.5 Sessions

`session(exch, t)`:
- Holiday → `HOLIDAY`.
- Special session today → `SPECIAL` inside [open, close), else `CLOSED`.
- Weekend → `CLOSED`.
- Otherwise `PRE_OPEN` in [preOpen, open), `OPEN` in [open, close), `CLOSED` otherwise.

Times come from config or `DEFAULT_SESSIONS`. Example: 8 Nov 2026 (Sunday, Muhurat). With no times configured: `CLOSED`, label "Muhurat trading: time not announced". With `{ open: "18:00", close: "19:00" }`: `SPECIAL` at 18:30.

### 6.6 Expiry shift explanation

For underlying u, the "usual weekday" w is the most common weekday among its listed weekly expiries; if none are weekly, it is the monthly ones. For a listed expiry e with weekday(e) ≠ w:
- `ruleDate` = the nearest date after e with weekday w within 6 days.
- If `ruleDate` is not a trading day, set `shifted: true` and `reason: "<ruleDate> is a holiday"`.

Example: NIFTY usual weekday Tue. Listed 23 Nov 2026 (Mon). Tue 24 Nov is in the holiday list (**needs verification**) → shifted. The listed date is always used for pricing and settlement; this is explanation only. (D6: the weekday is derived from data, never hard-coded.)

### 6.7 MWPL % and band

- `mwplPct` = 100 × combinedOI / MWPL (both in shares, from the combined-OI file).
- Band:
  - `ban` if the symbol is in `fo_secban` for the date. The ban list is the authority, not our computed %.
  - Else `high` if mwplPct ≥ 80.
  - Else `normal`.

The exchange rule is: enter the ban above 95 %, leave below 80 % (**needs verification**). The 80 % "high" threshold is our neutral display band, not an exchange status.

Example: MWPL 10,00,00,000; OI 9,62,00,000 → 96.2 %. In `fo_secban` → band `ban`. With OI 8,42,00,000 → 84.2 % → `high`.

### 6.8 F&O universe intervals (J9)

On each successful `fo_mktlots` parse at date d, with S = set of stock symbols:
- For each open interval whose symbol ∉ S, set `to = prevTradingDay(d)`.
- For each s ∈ S without an open interval, add `{ from: d, to: null, fromIsFirstFetch: (d == knownSince) }`.

`universe({ date })`:
- If date < `knownSince`, return `coverage: "not-recorded"` with an empty list.
- Otherwise return the symbols whose interval contains date.

Example: first fetch 29 Oct (knownSince). XYZ absent on 2 Nov → interval `29 Oct–30 Oct`. A query for 1 Nov excludes XYZ; a query for 30 Oct includes it; a query for 1 Oct returns not-recorded.

### 6.9 Delivery-margin dates

`E-n` = the n-th trading day before the expiry. With the expiry 23 Nov 2026 (shifted, see §6.6):
- E-1 = Fri 20 Nov (70 %)
- E-2 = Thu 19 Nov (45 %)
- E-3 = Wed 18 Nov (25 %)
- E-4 = Tue 17 Nov (10 %)

The percentages are from the shipped table, **needs verification**.

---

## 7. Safety and compliance gates

### 7.1 Order safety (nothing loosens `docs/guides/safety.md`)

- **Holiday block** (`safetyGuard`): on a holiday for the order's exchange:
  - `verified: true` (user config, a release-verified row, or demo) → live orders get `MARKET_CLOSED` "NSE is closed today (Guru Nanak Jayanti)". Paper gets the existing closed warning.
  - `verified: false` → live orders get a **warning** only: "Today may be an exchange holiday (unverified); the broker will refuse the order if so".
  - This only tightens behaviour. It never opens a window `lib/marketHours` would have closed: the guard takes the stricter of the two.
- **Lot gate**: as in §3.6 and §5.4. Off by default for API orders (back-compat), always on in the dashboard ticket.
- **Fallback values are never used to place orders.** `reference.rate()` feeds only display pricing and Greeks. Lots for orders always come from the resolved master contract (`orderValidation` is unchanged); reference lots only explain and gate.
- **Ban list**: this round shows the chip and banner only. Refusing opening orders in banned stocks is P1-6's acceptance criterion and is built on `reference.banStatus()`.
- **Kill switch, paper default, live gates**: untouched. No new route can send an order.

### 7.2 Compliance (BRD §8)

- **NSE terms of use**: we only fetch files from the NSE **archives** host, which the BRD treats as public files fetched at a polite rate (§8.3). This is **needs verification** by counsel, as is the host's own terms. We never call the NSE website API from this module. Downloads are off until the user turns them on, with copy that names the files and how often. Each Bridge makes at most 3 files × 2 jobs + retries ≈ ≤ 12 requests a day (§8), with a `gapMs` of at least 2 s and the browser UA from `backup/httpClient.mjs`.
- **Personal use**: everything stays in `dataDir`. Nothing is pooled, uploaded or redistributed. Export is CSV for the user's own use.
- **RA/IA neutrality** (§8.1): copy describes facts ("in ban", "MWPL 96 %", "lot changes"). It never says "avoid", "safe" or "opportunity". A test greps `calendar.js` and `reference.js` for the banned words list used by the screener tests (`recommend`, `best`, `buy`, `sell`, `rich`, `cheap`). The only exception is the existing order-ticket context.
- **Data honesty** (D5, §7.6): `available: false` with a reason, never a fake value. `quality` on every value; `inferred` and `default` are labelled in the UI.
- **Security** (§7.9): the new stores hold no secrets. The writes are admin + loopback and audited. MCP is read only. Responses carry no account ids. A test asserts that no store file contains a token-shaped string (reuse the `securityReview.test.mjs` helper).
- **Disclaimers**: the Market calendar footer reads "Reference data from the sources shown. Check exchange circulars before acting. Not investment advice."

### 7.3 "Needs verification" register (must be cleared before `verified: true`)

| Item | Where |
|---|---|
| NSE archive URLs and layouts for `fo_mktlots.csv`, `fo_secban*.csv`, `combineoi_*.zip` | `nseArchives.mjs`, fixtures |
| Holiday list 2026/2027 rows, Muhurat times | `data/holidays.json` |
| Delivery-margin percentages and the E-n definition | `data/delivery-margin.json` |
| Corporate-action rounding rules, rights method, dividend threshold | `corporateActions.mjs`, config |
| Ban entry 95 % / exit 80 % | method note copy |
| Index freeze quantities (existing list) | `symbols/freezeQuantities.mjs` |
| Pre-open window 09:00–09:15 for derivatives | `defaults.mjs` |
| Legal: automated fetching from the archives host | §7.2 |

---

## 8. Rate-limit budget

| Path | Calls | Budget |
|---|---|---|
| Broker APIs | **Zero new calls.** Masters are already loaded daily by `symbols` (scheduler class `master`, background). `reference` reads the in-memory store only. | 0 % of any broker policy |
| NSE archives | Morning: up to 2 files (`fo_mktlots`, and `fo_secban` only if the evening run missed). Evening: 3 files. One retry each. ≤ 10 requests/day typical, hard cap 20/day (`state.json` counter; above it the dataset waits for tomorrow) | One request in flight; ≥ `gapMs` (2 s) apart; `timeoutMs` 15 s; ≤ 20 MB each |
| Dashboard → Bridge | 1 bundle per page load/underlying change, then one per 10 min per tab. ≈ 40 calls/day per open page | Per-key client limiter unchanged |
| API users | Normal per-key limits. `/bundle` is cheap (memory only, < 5 ms p95). | §7.8 quotas |
| CPU/disk | Parsing < 50 ms per file. Raw files ≈ 300 KB/day → ≈ 120 MB at 400-day retention (shown on the calendar page). | — |

---

## 9. Test plan

All tests are vitest, next to their code, and follow the repo's existing naming.

### 9.1 Unit (pure)

| File | Covers |
|---|---|
| `server/bridge/reference/calendar.test.mjs` | Everything below |
| `server/bridge/reference/corporateActions.test.mjs` | §6.1 examples 1–4 exactly; tick rounding; paise maths; non-standard lot flag; invalid ratios rejected; §6.2 inference on a fixture master (lot mismatch and off-grid) |
| `server/bridge/reference/lots.test.mjs` | `parseMktLots` on the fixture (index and stock rows, blank months, whitespace, a BOM); the revision fixture gives `effectiveFrom` 31 Dec 2025 (§6.3); banner window edges (7 days in, 8 out, 0 on the day); conflict detection; universe intervals (§6.8) including not-recorded |
| `server/bridge/reference/parsers.test.mjs` | `parseSecBan` (header line with date, empty list "NIL" form, trailing commas); `parseCombineOi` from the zip fixture through `safeArchive` (size cap and multi-entry refusal); MWPL % and band (§6.7) |
| `server/bridge/reference/config.test.mjs` | Defaults; strict unknown keys; `HH:MM` validation; rate bounds; precedence of settings.json over config |

`calendar.test.mjs` covers:
- `isTradingDay` on weekend, holiday, config `add`/`remove`, and a special session with and without times;
- `tradingDaysBetween` (the §6.4 example both ways);
- `session()` at 08:59, 09:00, 09:14, 09:15, 15:29 and 15:30 IST, on a holiday, and on Muhurat;
- `expiryShift` (the §6.6 example);
- E-n dates (§6.9);
- IST correctness with the host TZ set to UTC and America/New_York (run under `process.env.TZ` overrides).

### 9.2 Service and store

`server/bridge/reference/referenceService.test.mjs` (fake clock, temp `dataDir`, fake fetch):
- The scheduler runs the morning job at 08:20 IST on a trading day, skips holidays, and retries at 08:50 after a failure.
- `SOURCE_OFF` when archives are off, with no fetch made (spy asserts zero calls).
- An unchanged sha256 leaves `changed: false`. A parse failure keeps the previous data.
- A corrupt `lots.json` is renamed and the service starts.
- Retention deletes old `raw/` folders. The daily cap of 20 requests is respected.
- `reference.updated` is emitted with the documented payload.

`server/bridge/reference/demoReference.test.mjs`:
- The same IST date gives the same data.
- A rolling corporate action is always within 7 days.
- 2–3 stocks in ban each day.
- BANKNIFTY revision banner appears in the 7 days before each monthly expiry.
- The demo adapter lots agree with demo reference lots for every listed contract.
- No network: `globalThis.fetch` is stubbed to throw.

`server/bridge/reference/noConstants.test.mjs` (**acceptance criterion 2**):
- Scans `server/bridge/**/*.{mjs,js}` minus tests, `__fixtures__`, `reference/defaults.mjs`, `reference/data/*` and `dashboard/reference.js`.
- Fails on:
  - `\bRISK_FREE\b`
  - `\bRATE\s*=\s*0\.0\d+`
  - `0\.065\b`
  - `brokeragePerOrder\s*:\s*\d`
  - `["'\`]0?9:15` and `["'\`]15:30` (and `9 \* 60 \+ 15`, `15 \* 60 \+ 30`)
  - lot literals `\blot(Size)?\s*:\s*\d{2,}` outside the demo underlying table
- Excludes `server/brokers/*`, because adapters format broker request times and that is wire format, not policy. The exclusion is documented in the test with this reason.
- `server/lib/marketHours.mjs` is legacy proxy code outside `server/bridge`. It is out of scope and listed in the test as a known exemption, with a pointer to this spec.
- Prints file:line for each hit.

### 9.3 Contract tests

- `server/bridge/core/openapi.test.mjs` (existing) must pass with the 20 new operations: same scope, `x-stream: S16`, loopback flags.
- `server/bridge/reference/routes.test.mjs`:
  - every route's happy path and its errors from §3.2;
  - `available: false` shapes;
  - admin + loopback refusal for the five writes (`SCOPE_REQUIRED`, `LOOPBACK_ONLY`);
  - `CAPABILITY_UNSUPPORTED` for `/sources` and `/sync` in demo;
  - audit rows written for writes;
  - every response field is in the OpenAPI schema (reuse the existing schema-walk helper if one exists, else a small key check against the YAML).
- `server/bridge/mcp/tools.test.mjs`: `get_reference` returns the same `data` as the REST route for `bundle` and `lots`, and has no write path.
- `server/bridge/orders/orderService.flow.test.mjs` additions:
  - `LOT_SIZE_STALE` is a warn by default;
  - it blocks with `blockLotsWhenStale`;
  - `lotSizeConfirmed` clears it;
  - `quantity` requests are unaffected.
- `server/bridge/safety/safetyGuard.test.mjs` additions:
  - verified holiday blocks live with `MARKET_CLOSED`;
  - unverified holiday warns;
  - paper warns;
  - stub reference falls back to `lib/marketHours`.
- `server/bridge/market/marketDataService.test.mjs` addition: computed Greeks use the reference rate; the deprecated config override wins and warns once.

### 9.4 Dashboard

- `server/bridge/dashboard/options.test.mjs`: update every test that relied on `RISK_FREE`/`RATE`/`CHARGE_RATES` defaults to pass explicit values. Add `marketSession` and `sessionsLeft` holiday cases, and `chargesPct(rates)` equality with the old `CHARGES` figures.
- `server/bridge/dashboard/reference.test.mjs`: `refBanners` text for each event kind (descriptive, no banned words); `lotConfirmGate` truth table; fallback when the bundle fails; the 10-minute cache; `localStorage` throwing.
- `server/bridge/dashboard/calendar.test.mjs`: month grid on 360 px (list mode) vs desktop (grid); holiday and shifted-expiry markers; CSV export columns; corporate-action preview wiring (fetch stub).
- `server/bridge/dashboard/polish.test.mjs` (existing): add `calendar.js` to the page list it checks (44 px targets, no new colour literals).

### 9.5 End-to-end

`server/bridge/e2e/reference.e2e.test.mjs` (demo mode, real HTTP on an ephemeral port, as in `bridge.e2e.test.mjs`):
- Start with `--demo`.
- `GET /v1/reference/status`: all datasets available, `source: "demo"`.
- `GET /bundle?underlying=NIFTY`: session, lot 65, holidays, rate.
- `GET /events?days=7`: at least one corporate action.
- `GET /ban`: 2–3 symbols.
- `POST /corporate-actions/preview` for example 1: strikes 1,400/1,410, lot 500.
- `PUT /rate` from loopback with an admin key: 200. A read key gets 403.
- `GET /bundle?underlying=NIFTY&demoStale=1` shows stale.
- `POST /v1/orders/preview` with `lots` and `blockLotsWhenStale: true` (config) gives `LOT_SIZE_STALE` block. With `lotSizeConfirmed: 65` the preview is OK.
- `PUT /sources` in demo gives 422.
- `GET /v1/expiries` is unchanged in shape (back-compat).

A non-demo variant with a fake fetch serving the fixtures:
- sync, then `/lots` history and `/fno-universe` intervals;
- a second sync with the revision fixture shows the event;
- with archives off, `available: false, reason: "SOURCE_OFF"` and zero fetch calls.

Manual check (`run` skill) at 390×844, 820×1180 and 1440×900, dark and light: chip, banner, ticket gate and calendar page in demo. Screenshots go in the PR.

---

## 10. Migration and back-compat

- **API**: additive only (§7.8). `/v1/expiries` and `/v1/instruments/{symbol}` are unchanged. `OrderRequest.lotSizeConfirmed` is optional. `LOT_SIZE_STALE` is a warning unless the user opts in to blocking.
- **Config**:
  - `market.chain.riskFreeRate` still works. If present it overrides the reference rate (`quality: "config"`, `source: "config: market.chain.riskFreeRate (deprecated, use reference.rate)"`), and a warning is logged once at boot.
  - The zod schema drops the default so "not set" can be told apart.
  - Removal happens no earlier than 6 months later, with a changelog entry.
- **Paper**: `paper.sessionEnd.time` keeps working when set. Unset now means "reference close" (the same 15:30 by default, so behaviour is unchanged).
- **Safety**: holiday blocks need verified rows, and the shipped file starts with `verified: false`, so no trading day can newly be blocked by an unchecked list. Behaviour only tightens once someone verifies.
- **Dashboard**:
  - Saved `localStorage` desk state is untouched.
  - Strategies saved with leg `lotSize` keep it (positions keep their opening lot).
  - If the Bridge is older than the dashboard (impossible in the same install, but defensive), a missing `/v1/reference/bundle` falls back to `REF_DEFAULTS` with the "dashboard defaults" label.
- **Demo**: lots change from 75/35 to 65/30 (and BANKNIFTY's rolling 35). Any demo screenshot or test that asserts 75 must be updated (`demo.test.mjs`, `options.test.mjs` fixtures, `docs/screenshots` captions). Paper positions in `demo-paper` opened at 75 keep 75.
- **Data folder**: `dataDir/reference/` is created on first start. Backups (`backup/`) include it automatically if they copy `dataDir` (verify in `backupService.mjs`; if not, add the folder to its list).
- **Stream docs**: `docs/STREAMS.md` gains the S16 row (`reference` service; requires `symbols`), and the merge order puts S16 after S4.

---

## 11. Ordered task list (one engineer, one session)

Each step ends green (`npx vitest run <files>` + `npm run -s check:mjs`). Steps 1–9 are the server and can ship alone. Steps 10–14 are the UI. Step 15 is the docs.

1. **Contract + skeleton.**
   - Add the `reference` contract, the `requires` edits and the `reference.updated` topic.
   - Add `reference/module.mjs` with all 20 routes as `notBuilt` placeholders, `config.mjs`, `defaults.mjs`, and register in `builtinModules`.
   - Add the 20 OpenAPI path stubs with `x-stream: S16` so `openapi.test.mjs` passes.
2. **Calendar core**: `calendar.mjs` + `data/holidays.json` (2026 rows, `verified: false`) + `calendar.test.mjs` (§6.4–6.6, 6.9).
3. **Corporate-action maths**: `corporateActions.mjs` + `corporateActions.test.mjs` (§6.1, 6.2), the `preview` route, and `data/corporate-actions.json` with the RELIANCE fixture row (`illustrative: true`).
4. **Parsers**: `lots.mjs`, `parsers.mjs` + fixtures + tests (§6.3, 6.7, 6.8).
5. **Store + service (no network)**: `store.mjs`, `referenceService.mjs` with masters-only lots/expiries/freeze, shipped holidays, delivery margin and charges, the config rate, and `status`/`bundle`/`events`. Wire every read route. `routes.test.mjs` for reads.
6. **Demo provider**: `demoReference.mjs`; demo adapter changes (lots 65/30/20, rolling revision, holiday shift, `RATE` from defaults); `demoReference.test.mjs`; update the demo tests that assert 75.
7. **NSE archive fetcher + scheduler**: `nseArchives.mjs`, the jobs, `settings.json`, the `/sources`, `/sync`, `/rate` and corporate-action write routes with audit, and `referenceService.test.mjs`.
8. **Consumers**: market rate (+ deprecation), safety holiday rule, scanner, paper session end, orders `LOT_SIZE_STALE` + `lotSizeConfirmed` (+ OpenAPI field), and their tests.
9. **MCP tool** `get_reference` + test. Fill the OpenAPI schemas (§3.8). Pass the contract tests.
10. **`reference.js`** client module + `reference.test.mjs`. Add to `DASHBOARD_FILES`.
11. **`options.js` constant removal** (§5.6) + update `options.test.mjs`. Thread `rate`/`session`/`charges` through `desk.js`, `vol.js`, `arbitrage.js`, `oi.js`, `strategy.js`, `screener.js`, `positions.js`.
12. **Chip, banners, stale warning, positions chips, ticket gate** (`desk.js`, `positions.js`, `strategy-place.js`).
13. **Market calendar page** `calendar.js` + `PAGES` entry + `ICONS.calendar` + `calendar.test.mjs` + the `polish.test.mjs` list.
14. **`noConstants.test.mjs`** (acceptance criterion 2). Fix any remaining hits. Run the full suite.
15. **E2E + docs**: `reference.e2e.test.mjs`; `ARCHITECTURE.md`/`STREAMS.md`/`bridge.config.example.json`/`cli init` question; the needs-verification register in the PR description; demo screenshots at three sizes.

If the session runs short, the cut line is after step 12. Step 13 (calendar page) can follow in the next session without blocking P1-1, P1-3 or P1-6: they consume only the service and API from steps 1–9.

---

## 12. Acceptance criteria mapping

| BRD P1-2 criterion | Where it is met | Honest gap |
|---|---|---|
| 1. Datasets loaded daily with source and asOf | §2.3–2.6, §3 | Rate and corporate actions are manual/curated + inferred (§1.3); freeze qty is masters + dated list; universe history starts at first fetch |
| 2. No hard-coded constants; static grep test | §5.6, §9.2 `noConstants.test.mjs` | `T_FLOOR` and `/365` belong to P1-3; the STT copy belongs to P1-6 (not in this grep) |
| 3. 7-day banner on pages and positions | §5.3, §6.3, `events()` | — |
| 4. Stale > 1 trading day → warning; ticket blocks lots until confirmed | §5.3, §5.4, §3.6, §6.4 | API orders block only with `blockLotsWhenStale` (back-compat) |
| 5. Fixture split/bonus matches the circular | §6.1, `corporateActions.test.mjs`, e2e preview | The fixture row stays `verified: false` until checked against the circular text |
