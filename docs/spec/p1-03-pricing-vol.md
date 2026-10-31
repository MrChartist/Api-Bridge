# Engineering spec P1-3: pricing core (vol-time clock), daily vol store, IV Rank/Percentile and IV chart

Status: ready to build · Owner: tech lead, P1-3 · Date: 29 Oct 2026 · BRD: `docs/brd/options-platform.md` §1.4 (D1, D5, D6, D8), §3.A A15, §3.C (C1, C2, C11), §5.1–5.5 (stores S2, S6 backfill, S9 logging; vol engine), §6.1 (P1-3 acceptance criteria), §7.1–7.9, §8, §10.1, §10.2

> **Naming, read first.** The BRD calls the daily vol store **S2**, the bhavcopy store **S6** and the prediction log **S9**. In the code, S2, S6 and S9 are *build streams* (`docs/STREAMS.md`). In this spec "store S2/S6/S9" always means the BRD's stores. The new server module is build stream **S18**: S16 is P1-2's `reference` module (`docs/spec/p1-02-reference.md`) and S17 is P1-1's recorder (final ids: `docs/spec/README.md`).

> **Not legal or market advice.** Every exchange rule, URL, file layout and number below that comes from outside this repo is marked **needs verification** and is listed in §8.3. Nothing so marked becomes a blocking rule in code.

> **Styling.** Another team is restyling the dashboard (near-black theme, colour tokens, motion). This spec names panels, classes and states, and uses only the shared tokens and existing helpers. It specifies no colours, sizes or motion beyond "uses token X".

> **Build order and shared foundations.** This spec is steps 2, 8 and 9 (P1-3a pricing core; P1-3b clock, store, reads; P1-3c back-fill and UI; split in §11) in `docs/spec/README.md`, after F0, P1-2a (P1-3b also needs P1-1a and P1-2b). It uses, and does not rebuild, the F0 foundations listed there: final stream ids, bus topics and error codes pre-registered in core, the opt-in `options` MCP toolset (every MCP tool in this spec goes there), `demo/routes.mjs` plus the OpenAPI demo-only list, `server/lib/jsonl.mjs` (append, torn-line tolerance, last-wins, quarantine of corrupt files), `ratelimit/backgroundGate.mjs` (the one ≤ 50 % background-budget check), `core/ownership.mjs`, and `dashboard/copyRules.mjs` (the one banned-word list). Where this text and README disagree, README's build order and shared-module owners win.

---

## 0. Summary

Today the Bridge has **four** different option-pricing paths that disagree:

| Where | Model | Price | Time | Rate |
|---|---|---|---|---|
| `server/lib/blackScholes.mjs` (via `market/chain.mjs`, computed Greeks) | Black-Scholes on **spot** | LTP | calendar days to 15:30 ÷ 365, floor 0.25 day | `market.chain.riskFreeRate` 6.5 % |
| `dashboard/options.js` `impliedVol`, `black76Greeks`, `yearsToExpiry` (chain, builder, positions) | Black-76, r = 0 | caller's | calendar ÷ 365, no floor; theta ÷ 365 | none |
| `dashboard/options.js` vol section (`impliedVolB76`, `smilePoints`, `termRow`) | Black-76 on parity forward (3 strikes) | mid | calendar ÷ 365, `T_FLOOR` 0.25 day | `RATE` 6.5 % |
| `demo/demoAdapter.mjs` | Black-Scholes on spot | — | calendar ÷ 365, floor 10 min | `RATE` 6.5 % |

P1-3 replaces them with **one pure pricing core** (`server/bridge/dashboard/pricing.js`, imported by both the browser and the server), built on **one vol-time clock**, and then builds the first thing that needs history: a **daily vol store** written at 15:25 IST, a **bhavcopy back-fill** so IV Rank is useful before a year of recording, **IVR/IVP** on four pages and an **IV history chart**.

What we can honestly deliver, by item:

| Item | This round | Honest limit |
|---|---|---|
| One vol-time clock (A15) | Weighted (default), trading-days/252, calendar ACT/365; settlement-window aware; one function on server and client | Weights are stated assumptions, not measured (measurement is LATER) |
| One IV function | Black-76 on the 5-strike parity forward, from mids, on the clock | Broker-supplied IVs (Dhan) are kept as `brokerIv`, not used |
| S2 daily store | 15:25 IST capture per tracked underlying and expiry; 15:35 retry; gaps recorded | A day the Bridge was off is a gap; it can be filled next day only by the EOD proxy, labelled |
| Back-fill (S6 subset) | NSE F&O bhavcopy (legacy and UDiFF parsers), BSE derivatives bhavcopy, VIX daily history | Proxy quality: close prices, no bid/ask. Indices usable; stocks noisy and labelled. Needs the user's consent to NSE archive downloads (P1-2) |
| IVR / IVP (C1) | 30/90/252-day on 30-day constant-maturity ATM IV; "same-DTE" rank per listed expiry | Per-expiry 252-day rank on a weekly expiry is impossible (it lives ~5 weeks); we rank against the same days-to-expiry instead and say so |
| VIX panel (C11) | INDIA VIX value, 252-day percentile, VIX vs NIFTY 30-day IV on the same (calendar) clock | History needs Yahoo (backup consent) or a broker serving `NSE:INDIAVIX` daily candles; otherwise it starts at first capture |
| IV chart (C2) | `GET /v1/vol/history` + CSV + a purpose-built SVG line/table fallback; the owner's chart engine plugs into `chartSlot` | Intraday IV series need the P1-1 recorder (LATER) |
| K6 logging (S9) | Every probability **the server computes** (σ bands, expected move, P(ITM) at the band edges) logged at each capture | Probabilities computed only in the browser (builder PoP) are labelled "uncalibrated" and logged from P1-9, when that maths moves to the server |

---

## 1. Scope

### 1.1 MUST (this round)

1. **Pricing core** `server/bridge/dashboard/pricing.js` (pure, no imports, no DOM): normal CDF/PDF, Black-76 price and Greeks on the forward, the single IV solver, leg price basis, parity forward, smile points, ATM IV at the forward, IV at delta, skew metrics, the vol-time clock, constant-maturity interpolation, IVR/IVP and same-DTE rank, realised-vol estimators (close-to-close, Parkinson, Yang-Zhang). `options.js` re-exports the moved names so every page and test keeps working.
2. **Clock everywhere (A15)**: `options.js` `yearsToExpiry`, `T_FLOOR`, `theta / 365`, `days / 365` in scenario pricing and `termRow`'s years are replaced by the clock. The chain, builder, positions, vol and OI pages read T from it. Interest (discounting, parity growth, carry) stays on calendar time (§6.3).
3. **Server chain IV on the same function**: `GET /v1/optionchain?ivModel=b76` returns every leg's IV and Greeks from `pricing.js`, plus a chain-level `pricing` object (forward, rate, clock). The default stays the legacy model for a 6-month deprecation window (§10).
4. **Module `vol` (stream S18)** with service `vol` (`deps.vol`), config section `vol`, stores under `dataDir/vol/`, and a minute-tick scheduler: capture at session close − 5 min (15:25), retry at close + 5 min (15:35), late capture up to close + 30 min.
5. **Store S2** (daily per underlying and expiry, plus a per-underlying daily summary with 30-day constant maturity, VIX and HV).
6. **Back-fill**: NSE legacy and UDiFF F&O bhavcopy parsers, BSE derivatives bhavcopy parser, the §6.10 proxy ATM IV, VIX daily history; a resumable, user-started job.
7. **IVR/IVP and VIX percentile** with "n of N days" and `partial`.
8. **S9 prediction log** for server-computed probabilities.
9. **API**: 10 routes under `/v1/vol/*` (§3), `ivModel` on `/v1/optionchain`, OpenAPI additions, MCP read tool `get_vol`, bus topic `vol.captured`.
10. **Demo**: time-varying demo IV anchored to the demo's own realised vol, a demo `INDIAVIX`, demo pricing on the clock, and a seeded 300-day history (live and back-fill segments, one missed day) so every feature is visible without a broker or the network.
11. **Dashboard**: IV rank tile and popover, VIX tile, history panel (SVG fallback + table + CSV) and method note on the Volatility page; IVR item on the chain summary strip; an IVR/VIX context line in the order ticket; IVR and IVP columns in the screener.

### 1.2 LATER (named so nobody builds it now)

| Item | Why later | Goes with |
|---|---|---|
| Intraday ATM IV / straddle series and chart | Needs recorded intraday chains (store S1) | P1-1 / P1-7 |
| Reading the 15:25 row from the recorder instead of fetching chains | P1-1 not built. The hook is specified (§2.7) so it is a one-line switch | P1-1 |
| 7/60/90-day constant maturity, RR25/BF25 history, RR sign flip on `#/vol` | C4 | P2 |
| Skew shadow (smile vs 1d/1w/1m ago) | C5. The 9-point smile **is stored now** so the history exists when C5 starts | P2 |
| Showing Parkinson / Yang-Zhang and IV−RV z-score | C8. **Stored now**, displayed later | P2 |
| Screener IVR/IVP **filters** | E2 says after 60 live days | P2 |
| Logging browser-computed probabilities (builder PoP, chance of profit) | That maths moves server-side in P1-9; logging un-versioned client maths would be uncheckable | P1-9 |
| Calibration report (reliability diagram, Brier) | K6 report needs ≥ 60 expiries | P2 |
| Event-day weights from an events calendar | J4. Config entry exists now (`vol.clock.eventDays`) | P2 |
| Measuring the clock weights from data (overnight share from daily OHLC, weekend share from Monday gaps) | Needs a method review; the defaults are labelled assumptions | P2 |
| Changing the clock from the dashboard at runtime | Server and browser must agree, and `market` cannot read `vol` settings without a dependency cycle. Config file only this round | Later round |
| Compat/Sheets path for `/v1/vol/*` | §7.8 parity; the MCP tool ships now | Next round |
| WebSocket push of `vol.captured` | Pages re-read; P1-11 alerts will subscribe on the bus | P1-11 |
| MCX/CDS clocks and sessions | Phase 3 (§3.M) | P3 |
| Stock option chains in demo | P1-6 | P1-6 |

### 1.3 Honest fallbacks (where the acceptance criteria meet our data)

- **"IVR replaces Unavailable" before 252 days exist.** Live S2 rows start on the day this ships. Until 252 trading days exist, ranks use back-filled proxy rows (`quality: "backfill-eod"`) when the user has run the back-fill, and the tile says `partial` with "n of N days (m live)". With neither, it says "3 of 252 days collected" and shows no rank number when n < 20 (a rank over fewer than 20 points is noise; the tile shows "Collecting: 3 of 252 days").
- **Per-expiry IVR.** A NIFTY weekly is listed for about five weeks, so "52-week rank of this expiry's IV" cannot exist. The per-expiry figure is a **same-DTE rank**: today's ATM IV for that expiry against the ATM IV of past rows whose remaining vol-time was within ±0.5 trading-day units (§6.9). Labelled "vs past days at the same time to expiry".
- **Bhavcopy proxy.** Option close in bhavcopy is the last trade, often hours old away from the money, with no bid/ask. We use only strikes within 2 strike steps of the forward with at least `minContracts` traded, the same-expiry future's settle price (or the near-month future carried) as the forward, and drop the day when fewer than 2 strikes qualify. Rows are stored `backfill-eod`, drawn lighter and labelled "EOD proxy, lower quality".
- **Corporate actions in the back-fill.** IV is scale-free: price, strike and forward on one day are all in the same (adjusted or not) units, so a day's IV needs no adjustment. What can go wrong is mixing a standard and an adjusted contract on the same day, so non-standard contracts (P1-2 `nonStandard` inference: lot or strike off-grid) are excluded. The BRD's "corporate actions applied" is therefore met by exclusion, and the method note says so.
- **Missed captures.** If the Bridge is off at 15:25 and 15:35, the day is a gap (`missed: true`, reason). If it starts before close + 30 min, a late capture is taken from the closing quotes and flagged `late`. The next morning, if NSE archive downloads are on, the day can be filled from that evening's bhavcopy as `backfill-eod`. Gaps are never interpolated.
- **Clock weights.** The weighted clock's weekend and overnight weights are our assumptions (§6.1). Every method note prints them, and the API always also returns calendar and trading-day T so anyone can convert.
- **BRD formula wording.** The BRD writes the parity forward as K + e^{rT}(C − P) "with T from the vol-time clock". Interest accrues on calendar days, so we use **calendar** T for every money term (discount factor, parity growth, carry) and the **vol-time** T only inside σ√T. The difference is under 0.01 index points on NIFTY but it is the correct split, and the method note states it.
- **Chart engine.** The owner's engine has not landed. The history panel keeps its `chartSlot` and adds the BRD §10.1 fallback: a purpose-built SVG line plus a data table and CSV export.
- **Rate.** From `reference.rate()` (P1-2). While it is the 6.5 % default, the method note says "Rate: 6.50 % default, not sourced".

---

## 2. Architecture

### 2.1 New and changed files

New, `server/bridge/vol/` (stream S18):

| File | Purpose |
|---|---|
| `module.mjs` | `defineModule({ name: "vol", stream: "S18", configKey: "vol", services: { vol }, register, start, stop })` and the `ROUTES` table |
| `config.mjs` | `VOL_CONFIG_SCHEMA` (zod, strict), `parseVolConfig`, `clockSettings(config)` (also imported by `market`) |
| `context.mjs` | `pricingContext({ config, reference, exchange, kind, now })`: builds the clock context (§6.1) from `vol.clock` config plus `reference.calendar()`, `reference.session()` and `reference.rate()`; weekends-only fallback with `holidays: "unknown"` when `reference` is a stub. Pure apart from those reads. Imported by `market/chain.mjs` |
| `capture.mjs` | Pure: chains + context → S2 expiry rows and the daily summary (§6.4–6.8) |
| `store.mjs` | JSONL stores under `dataDir/vol/` (§2.3), in-memory index, retention, corrupt-line handling |
| `volService.mjs` | `createVolService(deps)`: contract methods, scheduler, capture runs, snapshot cache, rank queries |
| `backfill/legacyBhav.mjs` | Pure parser: NSE F&O bhavcopy, legacy layout (before UDiFF) |
| `backfill/udiffBhav.mjs` | Pure parser: NSE F&O bhavcopy, UDiFF layout |
| `backfill/bseBhav.mjs` | Pure parser: BSE derivatives bhavcopy |
| `backfill/proxy.mjs` | Pure: parsed day → proxy ATM IV rows and summary (§6.10) |
| `backfill/job.mjs` | The resumable job: date list, fetch through P1-2's `reference/nseArchives.mjs` client (and a BSE host entry), parse, write, progress |
| `vix.mjs` | VIX daily history load (`marketData.history` with `allowBackup`) and percentile |
| `predictions.mjs` | S9 writer and reader (§2.3) |
| `demoVol.mjs` | Demo history seeding through the real `capture.mjs` and `proxy.mjs` (§4) |
| `routes.mjs` | Handlers |
| `fake.mjs` | In-memory `vol` service for other streams' tests |
| `__fixtures__/` | `fo_legacy_sample.csv`, `udiff_fo_sample.csv`, `bse_fo_sample.csv` (hand-made in the published layouts, **needs verification** against real downloads), `chain_nifty_*.json` (demo chains frozen at fixed instants) |
| Tests | §9 |

New, dashboard (all added to `DASHBOARD_FILES` in `core/app.mjs`):

| File | Purpose |
|---|---|
| `pricing.js` | **The** pricing core (shared with the server). No imports. Header comment: "Shared with server/bridge (market, vol). Pure: no DOM, no fetch, no session literals; callers pass the clock context." |
| `vol-context.js` | Loads `/v1/vol/clock` per underlying (10-minute cache), builds the client clock context, calls `O.setPricingContext(ctx)`; exposes `clockNote(ctx)` for method notes |
| `vol-rank.js` | IVR tile content, the rank popover (shared by Volatility page, chain strip and ticket), `rankText()` copy |
| `ts-chart.js` | **Shared** time-series SVG helper (pure path builder with null gaps, `smallMultiple`, `dataTable`, `csvButton`). Created here; P1-7 extends it with bars, step lines and the class strip. There is only one line-with-gaps helper in the dashboard |
| `vol-history.js` | The history panel: range/series controls, SVG fallback line (drawn with `ts-chart.js`), data table, CSV export |

Changed:

| File | Change |
|---|---|
| `core/contracts.mjs` | Add the `vol` contract (§2.2). **Core change: the lead makes it.** |
| `core/builtinModules.mjs` | Add `vol` after `scanner` |
| `core/eventBus.mjs` | Topic `vol.captured { underlying, date, quality, partial, missed, cm30Iv, ivr252, trigger }` |
| `core/app.mjs` | Five `DASHBOARD_FILES` entries (`pricing.js`, `vol-context.js`, `vol-rank.js`, `vol-history.js`, `ts-chart.js`) |
| `market/chain.mjs` | `ivModel` (`b76-forward` \| `legacy-bs-spot`): the b76 path prices every leg through `pricing.js` with `vol/context.mjs`; adds chain `pricing`; keeps broker IV as `brokerIv` (§3.9) |
| `market/marketDataService.mjs`, `market/routes.mjs`, `market/config.mjs` | Pass `ivModel`; `market.chain.ivModelDefault` (default `legacy-bs-spot`); `Deprecation` header on legacy-by-default responses (§10) |
| `demo/demoAdapter.mjs` | `ivLevel(u, t)`; `smileVol(u, spot, K, years, level)`; prices on the clock; `INDIAVIX` underlying; `demoChainAt(symbol, expiry, t, strikes)` light chain builder (§4) |
| `mcp/tools.mjs` | Tool `get_vol` |
| `dashboard/options.js` | Moves the maths to `pricing.js` and re-exports it; `setPricingContext`; `yearsToExpiry(expiry, now, ctx?)` on the clock; `T_FLOOR` and theta `/365` removed; `forwardPrice` and `impliedForward` delegate to `parityForward` (5 strikes); `termRow` uses the clock |
| `dashboard/vol.js` | IV rank tile, VIX tile, history panel, method note |
| `dashboard/desk.js` | IVR item on the summary strip; ticket context line; context loading |
| `dashboard/screener.js`, `screens.js` | IVR / IVP columns; copy at `screener.js:990` updated |
| `dashboard/strategy.js`, `positions.js`, `oi.js`, `arbitrage.js` | Pass the context; theta labels "per trading day"; probability labels "uncalibrated" |
| `dashboard/views.js` | Nothing new (no new page) |
| `docs/openapi.yaml` | Tag `Volatility`, 10 operations, schemas; `ivModel` parameter and `pricing`/`brokerIv` fields on `/v1/optionchain` (§3.10) |
| `docs/ARCHITECTURE.md`, `docs/STREAMS.md` | S18 row; dataDir layout; ownership of `dashboard/pricing.js` (S18) |
| `bridge.config.example.json` | `vol` section; `market.chain.ivModelDefault` |
| `reference/noConstants.test.mjs` (P1-2) | Extra patterns (§9.2) |

### 2.2 Service contract

```js
// core/contracts.mjs
vol: {
  iface: "VolService",
  stream: "S18",
  requires: ["marketData", "reference", "symbols", "scheduler"],
  methods: ["clock", "snapshot", "history", "rank", "summary", "status",
            "capture", "backfill", "cancelBackfill", "predictions", "logPredictions"],
},
```

Dependency order: `accounts → scheduler → symbols → reference → marketData → vol`. There is no cycle: `market` imports the pure helpers `vol/config.mjs` and `vol/context.mjs`, and reads `deps.config.vol.clock` (already parsed by core), but never calls `deps.vol`.

| Method | Returns |
|---|---|
| `clock({ underlying, expiries?, at? })` | `{ settings, holidays, expiries: [ClockResult] }` (§3.3) |
| `snapshot({ underlying, expiries? }, opts)` | Live S2-shaped rows + cm30 + quick rank (§3.4). Cached `snapshotTtlSeconds` per underlying |
| `history({ underlying, basis, expiry?, from, to, series, quality, clock, cursor, limit })` | `{ items, gaps, coverage, nextCursor, method }` |
| `rank({ underlying, basis, lookbacks, quality, clock, expiry? })` | `{ current, lookbacks: [...], sameDte, vix, definitions }` |
| `summary({ underlyings, lookback })` | Memory-only per-underlying rank lines for the screener |
| `status()` | Capture state, coverage, capacity, sources, back-fill job, disk |
| `capture({ underlyings, replace, trigger })` | Starts a capture run; resolves with per-underlying results |
| `backfill({ sources, from, to, underlyings })` | Starts or resumes the job; `{ jobId, days, files, estimateMinutes }` |
| `cancelBackfill()` | Stops after the current file |
| `predictions({ from, to, underlying, metric })` | S9 rows |
| `logPredictions(rows)` | `{ ids }`; validates `metric` against an open list and appends S9 rows. Defined here (not added later by P1-9) so the contract lands once; P1-9 is its first external caller |

### 2.3 Data model and storage on disk

Root `dataDir/vol/` (mode 0700). JSONL files are **append-only**: one JSON object per line, written with a single `appendFile` call per row ending in `\n`. A reader skips and counts any line that fails to parse (a torn last line after a crash) and logs once; a corrupt line never stops the service (BRD §7.7). A replacement (manual recapture with `replace: true`, or a late live row replacing a back-fill row for the same key) appends a new line; **the last line for a key wins**. A nightly compaction rewrites a file through `writeFileAtomic` when more than 20 % of its lines are superseded.

```
dataDir/vol/
  state.json                         scheduler state, last runs, missed days, back-fill cursor, counters
  daily/<UNDERLYING>/expiries.jsonl  store S2: one row per (date, expiry)
  daily/<UNDERLYING>/summary.jsonl   one row per date: cm30, VIX, HV, quality, missed
  vix.jsonl                          INDIA VIX daily OHLC (date, o, h, l, c, source)
  backfill/progress.json             per (exchange, date): done | no-file | parse-failed | holiday, with sha256
  backfill/raw/<exchange>/<date>.zip only when vol.backfill.keepRaw (off by default)
  predictions/<YYYY-MM>.jsonl        store S9
```

**S2 expiry row** (`expiries.jsonl`). IVs are in **vol points (percent)**, rates decimal, prices in index points/₹ per unit, times ISO-8601 with `+05:30`:
```json
{ "v": 1, "underlying": "NIFTY", "exchange": "NFO", "date": "2026-10-29", "expiry": "2026-11-03", "kind": "weekly",
  "capturedAt": "2026-10-29T15:25:03.410+05:30", "trigger": "scheduled", "quality": "live", "late": false,
  "source": "broker", "broker": "dhan", "accountId": "dhan-main",
  "clock": { "version": "vt1", "mode": "weighted", "units": 3.26800, "T": 0.012151, "Tcal": 0.013708, "Ttd": 0.011746 },
  "rate": { "value": 0.065, "quality": "default" },
  "spot": 25120.5, "forward": 25142.49, "forwardSource": "parity", "forwardStrikes": 5,
  "atmStrike": 25150, "atmIv": 12.41, "ceIv": 12.38, "peIv": 12.45, "straddle": 296.4,
  "iv": { "p10": 16.9, "p15": 15.6, "p25": 14.1, "p35": 13.1, "c35": 11.9, "c25": 11.6, "c15": 11.5, "c10": 11.7 },
  "rr25": -2.5, "putSkew25": 2.5, "bf25": 0.44, "rr10": -5.2,
  "tv": 0.000187135, "move1s": 344.0, "band1": [24800.9, 25488.8], "eam": 274.4,
  "quoteQuality": 0.86, "strikes": 81, "flags": [] }
```
- `iv.*` is the 9-point smile by forward delta (`atmIv` is the 9th point). `rr25` = call 25Δ − put 25Δ (market convention, BRD §10.2); `putSkew25` = put − call (what `#/vol` shows today as "25Δ RR (P−C)").
- `tv` = total variance σ²·T on the stored clock. With `clock.units`, `Tcal` and `Ttd` stored, the IV on any other clock is σ_x = √(tv / T_x): history converts exactly (§6.2).
- `accountId` is stored for audit on disk but **never returned by the API** (responses carry `broker` only).
- `flags`: `WIDE_ATM` (ATM spread > 10 % of mid), `ONE_SIDED_ATM`, `FORWARD_SPOT` (no two-sided strikes; F = spot), `THIN` (< 5 OTM points with IV), `EXPIRY_DAY`, `PARTIAL_WINDOW` (captured after close − 0.5 min).
- Back-fill rows have the same shape with `quality: "backfill-eod"`, `source: "nse-bhavcopy-udiff" | "nse-bhavcopy-legacy" | "bse-bhavcopy"`, `forwardSource: "future" | "future-carried" | "parity-close"`, `contracts` per strike used, and null smile points it cannot fill.

**Daily summary row** (`summary.jsonl`):
```json
{ "v": 1, "underlying": "NIFTY", "date": "2026-10-29", "quality": "live", "missed": false, "late": false, "partial": false,
  "cm30": { "weighted": 12.86, "trading": 12.62, "calendar": 13.10, "method": "interpolated",
            "expiries": ["2026-11-17", "2026-12-01"], "targetDate": "2026-11-27" },
  "front": { "expiry": "2026-11-03", "atmIv": 12.41, "roll": false },
  "vix": { "value": 13.42, "close": 13.38, "source": "broker" },
  "spotClose": 25118.2,
  "hv": { "cc10": 10.9, "cc20": 11.75, "cc60": 12.4, "park20": 10.8, "yz20": 11.3, "source": "broker", "closes": 61 },
  "ivHv20": 1.11 }
```
A missed day is written as `{ "v":1, "underlying":"NIFTY", "date":"2026-10-20", "missed": true, "reason": "BRIDGE_OFF" | "NO_DATA_ACCOUNT" | "CHAIN_FAILED" | "NOT_TRADING", "quality": null }` at the next start or at close + 30 min, so a gap is explicit, not inferred.

**S9 prediction row** (`predictions/2026-10.jsonl`):
```json
{ "v": 1, "id": "p_NIFTY_2026-11-03_2026-10-29T15:25_band1", "metric": "band1", "modelVersion": "b76-vt1",
  "underlying": "NIFTY", "expiry": "2026-11-03", "ts": "2026-10-29T15:25:03+05:30",
  "inputs": { "forward": 25142.49, "atmIv": 12.41, "T": 0.012151, "clock": "weighted", "rate": 0.065 },
  "prediction": { "lo": 24800.9, "hi": 25488.8, "p": 0.6827 }, "outcome": null }
```
Metrics logged per capture and expiry: `band1` (±1σ, p 0.6827), `band2` (±2σ, p 0.9545), `eam` (straddle-based expected absolute move), `pItmBand` (N(d2) of the strikes nearest each 1σ edge). `outcome` stays null; the P2 calibration job joins it from the expiry-day `spotClose` (or bhavcopy settle).

Sizes: indices, 6 underlyings × ≤ 4 expiries × ~1.4 KB + summaries ≈ 40 KB a trading day ≈ 10 MB a year. A 1-year back-fill adds ≈ 3 MB. Predictions ≈ 25 KB a day. `status()` reports bytes.

In memory: per underlying, the summary rows and a slim per-expiry index `{ date, expiry, units, tv, atmIv, quality }` (≈ 60 bytes a row). Full rows are read from disk on `history(basis: "expiry")`.

### 2.4 Scheduler

Same pattern as `scanner` and `reference`: `start()` arms a 60-second `setInterval` (`unref()`), `stop()` clears it. All times IST from `deps.clock` and `market/time.mjs`. Times are derived from `reference.session(exchange, now)`; no session literal appears in `vol/`.

| Job | When | What | Trading days only |
|---|---|---|---|
| `capture` | `close − capture.minutesBeforeClose` (15:25) | Every tracked underlying: its expiries' chains, VIX quote, daily candles for HV. Must finish by `close − 0.5 min`; legs still unfetched are abandoned and the row is `partial` | Yes (`reference.session().state === "OPEN"`) |
| `retry` | `close + capture.retryMinutesAfterClose` (15:35) | Re-runs only underlyings that failed or were `partial`; fills `vix.close` and `spotClose` for all | Yes |
| `late` | At start, or on the minute tick, between close + 5 and close + `lateUntilMinutesAfterClose` (16:00) when today has no row | Capture from closing quotes, rows `late: true`; refused (missed) when no two-sided ATM quotes | Yes |
| `missed` | At close + 30 min, and at start for earlier trading days since the last row | Writes explicit missed rows (§2.3) | Yes |
| `compact` | 02:30 | Compaction, retention (`retentionDays`) | No |
| `backfill` | User-started only (`POST /v1/vol/backfill`); then resumes at start until done | §2.6 | No |

Each run emits `vol.captured` per underlying and writes predictions.

### 2.5 Config (`vol` section)

```jsonc
"vol": {
  "clock": {
    "mode": "weighted",                 // weighted | trading | calendar (one clock for the installation)
    "nonTradingDayWeight": 0.15,        // weekend and holiday days, in trading-day units (assumption, §6.1)
    "overnightShare": 0.20,             // share of a trading day's variance at the open gap (assumption)
    "eventDays": {},                    // { "2027-02-01": 1.5 } multiplies that day's weight; J4 fills this later
    "settlementWindowMinutes": { "index": 30, "stock": 30 },   // ends at the reference session close; needs verification
    "yearBasis": null                   // null = 252 + 113 × nonTradingDayWeight
  },
  "account": null,                      // data account for captures; null = the recorder's data account when P1-1 runs, else the first account (config order) with optionChain
  "underlyings": ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"],
  "stocks": [],                         // opt-in; refused beyond capacity (§7)
  "maxStocks": 50,
  "expiries": { "maxPerUnderlying": 4, "maxCalendarDays": 100 },
  "capture": { "minutesBeforeClose": 5, "retryMinutesAfterClose": 5, "lateUntilMinutesAfterClose": 30,
               "budgetShare": 0.5, "strikesEachSide": 40 },
  "snapshotTtlSeconds": 60,
  "lookbacks": [30, 90, 252],
  "minRankDays": 20,
  "sameDteBand": 0.5,                   // trading-day units either side
  "backfill": { "defaultDays": 400, "maxDays": 1100, "minContracts": { "index": 500, "stock": 50 },
                "maxFilesPerDay": 600, "keepRaw": false, "bse": true },
  "vix": { "symbol": "NSE:INDIAVIX" },
  "predictions": { "enabled": true, "retentionDays": 1100 },
  "retentionDays": 3650
}
```
`market.chain` gains `ivModelDefault: "legacy-bs-spot" | "b76-forward"` (default `legacy-bs-spot` until the deprecation date, §10). Validation: weights in [0, 1], `overnightShare` < 1, `eventDays` keys `YYYY-MM-DD` with multipliers 0.5–5, window minutes 1–60, `stocks` ⊆ symbols in the F&O universe when P1-2 data exists.

### 2.6 Back-fill job

1. **Consent.** `nse`/`bse` sources need P1-2's `reference.sources.nseArchives.enabled` (it names the files and frequency when turned on). `vix` needs a broker that serves `NSE:INDIAVIX` daily candles or `backup.enabled` with Yahoo on. Missing consent → 422 `CAPABILITY_UNSUPPORTED` with the reason and where to turn it on. Demo never touches the network (§4).
2. **Dates.** Trading days in [from, to] from `reference.calendar()` (default `to` = yesterday, `from` = `to − defaultDays` calendar days). Days already `done` in `progress.json` are skipped, so the job resumes.
3. **Fetch.** Through P1-2's archive client: one request in flight, `gapMs` (2 s) apart, timeout 15 s, `maxBytes` raised to 60 MB for these files, `safeArchive` caps (one CSV entry). Newest date first, so the most useful year arrives first. A 404 is `no-file` (holiday or not yet published), not an error. A daily cap of `maxFilesPerDay` (600) across both exchanges.
4. **Parse** with the layout chosen by date: legacy up to the switch date, UDiFF from it (**switch date needs verification**, believed 8 Jul 2024); BSE UDiFF. Parsing streams line by line and keeps only rows for tracked underlyings (index options and futures; stocks only for `vol.stocks`).
5. **Compute** proxy rows (§6.10) and a summary (cm30 when two expiries qualify, else `front` only). Rows are appended unless a `live` row exists for that key (live always wins).
6. **Progress** to `progress.json` and `status()`: `{ jobId, state: "running"|"paused"|"done"|"failed"|"cancelled", total, done, skipped, failed, current, startedAt, etaMinutes }`.
7. **VIX** history: one `marketData.history({ symbol: "NSE:INDIAVIX", interval: "1d", from, to }, { priority: "background", allowBackup: true })` call (chunked by the market module), into `vix.jsonl`.
8. The raw file is dropped after parsing unless `keepRaw`.

### 2.7 Capture algorithm (one underlying)

1. Context: `pricingContext()` for the underlying's exchange and kind at `now`.
2. Expiries: listed (`marketData.expiries`) with calendar DTE ≤ `maxCalendarDays`, nearest `maxPerUnderlying`; always include the pair that brackets the 30-day target (§6.6), even if that means dropping a middle expiry.
3. Chains: **if `deps.recorder` exists and is not a stub (P1-1), read its snapshot nearest `now`** (no broker call). Otherwise `marketData.optionChain({ underlying, expiry, strikes: strikesEachSide, greeks: false }, { priority: "background", accountId: vol.account, maxAgeMs: 30_000 })`, sequentially, stopping at `close − 0.5 min`.
4. Per expiry, `capture.mjs`: parity forward → smile points → ATM IV → deltas → skew → straddle → bands → flags (§6.3–6.8).
5. Summary: cm30 on all three clocks, front ATM IV (rolls on expiry day), VIX (`marketData.quotes(["NSE:INDIAVIX"])`), HV from `marketData.history(1d, countback 70, allowBackup)`.
6. Append rows, write predictions, emit `vol.captured`, update `state.json`.

### 2.8 Snapshot (live, on request)

`snapshot({ underlying })` computes the same rows from live chains for the **front expiry and the 30-day bracketing pair** only (≤ 3 chains). Chains are read with `priority: "background"` and `maxAgeMs: snapshotTtlSeconds × 1000`, so it reuses the chain the user's open page already fetched and never delays a user request. When the scheduler has no headroom it returns the last snapshot with its `asOf` (or the last capture), marked `stale: true`. Results are cached per underlying for `snapshotTtlSeconds`.

---

## 3. API changes

All `/v1/vol/*` routes belong to module `vol` (`x-stream: S18`). Reads are `scope: read`. The three writes are `scope: admin` with `loopbackOnly: true`: they spend broker budget or download third-party files, so only this computer's dashboard or CLI may start them. Nothing here can place an order or change a safety setting.

Every response is `{ data, meta: { requestId, ... } }`. IVs are **vol points (percent)**; rates decimals; T in years; `units` in trading-day units; dates `YYYY-MM-DD` IST; timestamps ISO-8601 `+05:30`; money ₹; OI in units. Unavailable data is **not** an error: 200 with `available: false` and `reason` (`NOT_TRACKED`, `NO_HISTORY`, `COLLECTING`, `SOURCE_OFF`, `NO_CHAIN`, `NO_DATA_ACCOUNT`, `NOT_LISTED_IN_DEMO`).

### 3.1 Route table

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/v1/vol/clock` | read | Clock settings, holidays ahead, and T for expiries with the breakdown |
| GET | `/v1/vol/snapshot` | read | Live vol rows for an underlying (front + 30-day pair), cm30, quick rank |
| GET | `/v1/vol/history` | read | Daily series (cm30, front, one expiry) with VIX and HV; JSON or CSV |
| GET | `/v1/vol/rank` | read | IVR / IVP for lookbacks, same-DTE rank, VIX percentile, definitions |
| GET | `/v1/vol/summary` | read | Rank lines for up to 200 underlyings (memory only) |
| GET | `/v1/vol/status` | read | Capture state, coverage, capacity, sources, back-fill job, disk |
| GET | `/v1/vol/predictions` | read | Store S9 rows |
| POST | `/v1/vol/capture` | admin, loopback | Capture now |
| POST | `/v1/vol/backfill` | admin, loopback | Start or resume the back-fill |
| DELETE | `/v1/vol/backfill` | admin, loopback | Cancel the running back-fill |

### 3.2 Common errors

| Code | When |
|---|---|
| `VALIDATION_FAILED` 400 | Bad date, `from > to`, range over 1,100 days, unknown series/basis/clock, `limit` over 2,000, more than 200 underlyings, `at` not ISO |
| `SYMBOL_NOT_FOUND` 404 | Underlying not in any master, the universe or the store |
| `CAPABILITY_UNSUPPORTED` 422 | Back-fill source not consented (body names it and where to turn it on); `ivModel=b76-forward` on a chain with no spot and no two-sided strikes is **not** this (it returns legs with `iv: null`) |
| `IDEMPOTENCY_IN_PROGRESS` 409 | `POST /capture` while a capture runs; `POST /backfill` while the job runs |
| `NOT_FOUND` 404 | `DELETE /backfill` with no job running |
| `SCOPE_REQUIRED` / `LOOPBACK_ONLY` 403 | Writes without admin or from elsewhere |
| `RATE_LIMITED` 429 | Per-key client limit (existing); `Retry-After` |

### 3.3 `GET /v1/vol/clock?underlying=NIFTY[&expiry=2026-11-03,2026-11-17][&at=2026-10-29T10:00:00+05:30]`

Without `expiry`, all listed expiries ≤ 100 days. `at` defaults to now (any instant is allowed, for what-if and tests).
```json
{ "data": {
    "underlying": "NIFTY", "exchange": "NFO", "at": "2026-10-29T10:00:00.000+05:30",
    "settings": { "version": "vt1", "mode": "weighted", "nonTradingDayWeight": 0.15, "overnightShare": 0.2,
                  "eventDays": {}, "yearBasis": 268.95, "settlementWindowMinutes": 30,
                  "session": { "open": "09:15", "close": "15:30", "source": "S5 default" },
                  "holidays": "reference", "source": "config" },
    "rate": { "value": 0.065, "quality": "default", "source": "default (not sourced)" },
    "holidays": [ { "date": "2026-11-24", "label": "Guru Nanak Jayanti", "verified": false } ],
    "expiries": [ {
      "expiry": "2026-11-03", "T": 0.0147289, "units": 3.96133, "Tcal": 0.0143265, "Ttd": 0.0151852,
      "parts": [ { "date": "2026-10-29", "kind": "session", "units": 0.704 },
                 { "date": "2026-10-30", "kind": "gap", "units": 0.2 }, { "date": "2026-10-30", "kind": "session", "units": 0.8 },
                 { "date": "2026-11-02", "kind": "gap", "units": 0.5, "note": "overnight 0.20 + 2 non-trading days × 0.15" },
                 { "date": "2026-11-02", "kind": "session", "units": 0.8 },
                 { "date": "2026-11-03", "kind": "gap", "units": 0.2 },
                 { "date": "2026-11-03", "kind": "session", "units": 0.75733, "note": "to 15:00, then the 30-minute settlement window counts 1/3" } ] } ] },
  "meta": { "requestId": "…" } }
```
`holidays` covers [at, at + 400 days] for the underlying's exchange: the dashboard builds its client clock from this response.

### 3.4 `GET /v1/vol/snapshot?underlying=NIFTY`

```json
{ "data": {
    "underlying": "NIFTY", "asOf": "2026-10-29T10:02:11.000+05:30", "stale": false, "spot": 25120.5,
    "rows": [ { "...": "S2 expiry row shape (§2.3) with quality \"live-snapshot\" and no accountId" } ],
    "cm30": { "iv": 12.86, "ivCal": 13.10, "method": "interpolated", "expiries": ["2026-11-17", "2026-12-01"], "targetDate": "2026-11-27" },
    "rank": { "lookback": 252, "n": 252, "liveN": 34, "partial": false, "ivr": 55.4, "ivp": 70.2 },
    "vix": { "value": 13.42, "pct252": 48.0 },
    "clock": { "version": "vt1", "mode": "weighted" } },
  "meta": { "requestId": "…" } }
```

### 3.5 `GET /v1/vol/history`

Query: `underlying` (required); `basis` = `cm30` (default) | `front` | `expiry`; `expiry` (required with `basis=expiry`); `from`, `to` (default last 400 days); `series` (comma list of `iv,ivCal,vix,hv10,hv20,hv60,park20,yz20,ivHv20,spotClose,rr25,bf25,straddle,forward`; default `iv,vix,hv20,ivHv20`); `quality` = `all` (default) | `live`; `clock` = the installation mode by default, or `weighted|trading|calendar` (converted exactly through `tv`, §6.2); `limit` ≤ 2,000 (default 500); `cursor`; `format` = `json` | `csv`.
```json
{ "data": {
    "underlying": "NIFTY", "basis": "cm30", "clock": "weighted", "units": { "iv": "vol points", "hv20": "vol points" },
    "items": [
      { "date": "2026-10-28", "iv": 12.71, "vix": 13.20, "hv20": 11.62, "ivHv20": 1.09, "quality": "live", "roll": false, "flags": [] },
      { "date": "2026-10-29", "iv": 12.86, "vix": 13.38, "hv20": 11.75, "ivHv20": 1.11, "quality": "live", "roll": false, "flags": [] } ],
    "gaps": [ { "date": "2026-10-20", "reason": "BRIDGE_OFF" } ],
    "coverage": { "liveDays": 34, "backfillDays": 218, "first": "2025-09-29", "last": "2026-10-29", "tradingDaysInRange": 270 },
    "nextCursor": null,
    "method": { "iv": "30-day constant-maturity ATM IV: total variance interpolated on the weighted clock", "clock": { "...": "settings" } } },
  "meta": { "requestId": "…" } }
```
With `basis=front`, each row is that day's nearest expiry that is not on its own expiry day; `roll: true` marks the first row after the front expiry changed (the chart draws a rule there). CSV: one header row, the same columns, dates ISO; `Content-Disposition: attachment; filename="NIFTY-vol-cm30-2025-09-29-2026-10-29.csv"`.

### 3.6 `GET /v1/vol/rank?underlying=NIFTY[&lookbacks=30,90,252][&basis=cm30][&expiry=2026-11-03][&quality=all][&clock=]`

```json
{ "data": {
    "underlying": "NIFTY", "basis": "cm30", "clock": "weighted", "available": true,
    "current": { "iv": 12.86, "asOf": "2026-10-29T10:02:11+05:30", "source": "live-snapshot" },
    "lookbacks": [
      { "days": 30, "n": 30, "liveN": 30, "partial": false, "min": { "iv": 11.2, "date": "2026-10-06" }, "max": { "iv": 14.9, "date": "2026-09-22" }, "ivr": 45.4, "ivp": 53.3 },
      { "days": 90, "...": "…" },
      { "days": 252, "n": 252, "liveN": 34, "partial": false, "backfillN": 218, "min": { "iv": 9.8, "date": "2026-03-11" }, "max": { "iv": 16.3, "date": "2026-06-04" }, "ivr": 55.4, "ivp": 70.2 } ],
    "sameDte": { "expiry": "2026-11-03", "units": 3.96, "iv": 12.41, "band": 0.5, "n": 61, "partial": true, "ivr": 48.0, "ivp": 52.5,
                 "note": "Against past days with 3.5–4.5 trading days to expiry" },
    "vix": { "value": 13.42, "n": 252, "pct252": 48.0, "rank252": 41.2, "source": "broker",
             "vsNifty30": { "vix": 13.42, "nifty30Cal": 13.10, "diff": 0.32, "note": "Both on calendar time" } },
    "definitions": { "ivr": "(current − lowest) ÷ (highest − lowest) × 100 over the lookback",
                     "ivp": "share of days in the lookback with IV below current × 100",
                     "partial": "fewer stored days than the lookback; n is shown",
                     "basis": "30-day constant-maturity ATM IV (Black-76, parity forward, weighted vol-time clock)" } },
  "meta": { "requestId": "…" } }
```
- `current` is the live snapshot when fresh (≤ `snapshotTtlSeconds` × 5), else the last capture (`source: "last-capture"`).
- When n < `minRankDays` (20): `ivr: null, ivp: null, reason: "COLLECTING"` and `n`.
- `max == min`: `ivr: null, reason: "FLAT"`; `ivp` still shown.
- `vix` is present for every underlying (INDIA VIX is NIFTY-based; the UI labels it so); `vsNifty30` only for NIFTY.

### 3.7 `GET /v1/vol/summary?underlyings=NIFTY,BANKNIFTY,RELIANCE[&lookback=252]`

Memory only, < 5 ms p95, no broker calls.
```json
{ "data": { "lookback": 252, "items": [
    { "underlying": "NIFTY", "available": true, "iv": 12.86, "asOf": "2026-10-29T10:02:11+05:30", "source": "live-snapshot",
      "n": 252, "liveN": 34, "partial": false, "ivr": 55.4, "ivp": 70.2, "hv20": 11.75, "ivHv20": 1.11 },
    { "underlying": "RELIANCE", "available": false, "reason": "NOT_TRACKED", "n": 0 } ] },
  "meta": { "requestId": "…" } }
```

### 3.8 `GET /v1/vol/status`, `GET /v1/vol/predictions`, writes

`GET /v1/vol/status`:
```json
{ "data": { "demo": false, "clock": { "version": "vt1", "mode": "weighted" },
    "account": { "broker": "dhan", "selectedBy": "first-with-optionChain" },
    "capacity": { "chainCallsPerMin": 10, "windowMinutes": 4.5, "callsNeeded": 24, "fits": true, "maxStocksThatFit": 10, "basis": "dhan chain 20/min × budgetShare 0.5 (unverified policy)" },
    "underlyings": [ { "underlying": "NIFTY", "liveDays": 34, "backfillDays": 218, "lastCapture": { "date": "2026-10-28", "at": "…", "quality": "live", "partial": false },
                       "missed": ["2026-10-20"], "nextRunAt": "2026-10-29T15:25:00+05:30" } ],
    "sources": { "nseArchives": { "enabled": true, "setBy": "dashboard" }, "vixHistory": { "provider": "yahoo", "enabled": true } },
    "backfill": { "jobId": "bf_…", "state": "running", "total": 504, "done": 211, "skipped": 6, "failed": 1, "current": "NSE 2025-12-03", "etaMinutes": 11 },
    "disk": { "bytes": 13950210 } },
  "meta": { "requestId": "…" } }
```
`GET /v1/vol/predictions?from=&to=&underlying=&metric=` returns `{ items: [PredictionRow], nextCursor }` (≤ 2,000 a page).

`POST /v1/vol/capture` (admin, loopback). Body `{ "underlyings": ["NIFTY"], "replace": false }` (both optional). Returns 202 `{ jobId, underlyings, startedAt }`. Rows get `trigger: "manual"`. Without `replace`, a date that already has a scheduled row is skipped and listed in the result. Audited `vol.capture.manual`.

`POST /v1/vol/backfill` (admin, loopback). Body `{ "sources": ["nse", "bse", "vix"], "from": "2025-09-01", "to": "2026-10-28", "underlyings": ["NIFTY","BANKNIFTY"] }` (all optional; defaults: all three sources, `defaultDays`, tracked underlyings). Returns 202 `{ jobId, days: 290, files: 580, estimateMinutes: 26 }`. Audited `vol.backfill.started`. `DELETE /v1/vol/backfill` returns 204 and audits `vol.backfill.cancelled`.

### 3.9 `/v1/optionchain` changes (stream S5, additive)

- New query `ivModel` = `b76-forward` | `legacy-bs-spot`. Default: `market.chain.ivModelDefault` (`legacy-bs-spot` until 2027-05-01, §10).
- With `b76-forward`, every leg (broker or computed) gets `iv`, `delta`, `gamma`, `theta`, `vega` from `pricing.js`, `greeksSource: "computed"`, and the broker's own IV, if it sent one, in the new optional field `brokerIv`. Theta is ₹ per **trading-day unit** per unit of the underlying (§6.5). Legs without a usable price get nulls.
- New chain field `pricing` (present with `b76-forward`):
```json
"pricing": { "model": "black76-parity-forward", "ivModel": "b76-forward", "priceBasis": "mid",
             "forward": 25142.49, "forwardSource": "parity", "forwardStrikes": 5,
             "rate": { "value": 0.065, "quality": "default" },
             "clock": { "version": "vt1", "mode": "weighted", "T": 0.0147289, "units": 3.96133, "Tcal": 0.0143265 } }
```
- With `legacy-bs-spot` chosen by default (not explicitly), the response carries `Deprecation: @1809109800` (1 May 2027 00:00 IST) and `Link: </docs/CHANGELOG.md#optionchain-ivmodel>; rel="deprecation"`.
- The dashboard always sends `ivModel=b76-forward`. MCP `get_option_chain` gains the same optional input.

### 3.10 MCP

Tool `get_vol` (read). Input `{ view: "clock"|"snapshot"|"history"|"rank"|"summary"|"status", underlying?, underlyings?, basis?, expiry?, from?, to?, series?, lookbacks? }`. Same service methods, same fields. No write tool: MCP can never start a capture or a back-fill.

### 3.11 `docs/openapi.yaml` additions

- `tags`: `- name: Volatility` — "Vol-time clock, daily ATM IV store, IV rank and percentile, IV history and VIX (stream S18). IV in vol points; every series carries quality and source."
- `components/schemas`: `VolClockSettings`, `VolClockPart`, `VolClockResult`, `VolClock`, `VolSmile9`, `VolExpiryRow`, `VolSummaryRow`, `VolCm`, `VolSnapshot`, `VolHistoryItem`, `VolHistory`, `VolRankLookback`, `VolRank`, `VolSummaryItem`, `VolStatus`, `VolBackfillRequest`, `VolBackfillJob`, `VolCaptureRequest`, `VolCaptureJob`, `VolPrediction`, `VolUnavailable` (`available: false`, `reason` open enum). `quality` enum: `[live, live-snapshot, backfill-eod]`, documented as open.
- `ChainLeg`: add `brokerIv: { type: [number, "null"], description: "The broker's own IV (percent), when it sent one and ivModel=b76-forward recomputed iv." }`. `OptionChain`: add `pricing: { $ref: "#/components/schemas/ChainPricing" }` (optional).
- `/v1/optionchain`: parameter `ivModel` (enum, description of the default and the deprecation date).
- Ten `paths`, each with `x-stream: S18`, `x-scope`, and `x-loopback-only: true` on the three writes. Example:
```yaml
  /v1/vol/rank:
    get:
      tags: [Volatility]
      operationId: getVolRank
      summary: IV rank and IV percentile over 30/90/252 days, same-DTE rank and VIX percentile
      x-stream: S18
      x-scope: read
      parameters:
        - { name: underlying, in: query, required: true, schema: { type: string, maxLength: 30 } }
        - { name: lookbacks, in: query, schema: { type: string, pattern: "^\\d{1,4}(,\\d{1,4}){0,4}$" } }
        - { name: basis, in: query, schema: { type: string, enum: [cm30, front, expiry], default: cm30 } }
        - { name: expiry, in: query, schema: { type: string, format: date } }
        - { name: quality, in: query, schema: { type: string, enum: [all, live], default: all } }
        - { name: clock, in: query, schema: { type: string, enum: [weighted, trading, calendar] } }
      responses:
        "200":
          description: Ranks. IV in vol points. available false with a reason when there is no history.
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { oneOf: [{ $ref: "#/components/schemas/VolRank" }, { $ref: "#/components/schemas/VolUnavailable" }] }
                  meta: { $ref: "#/components/schemas/Meta" }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }
```
- `docs/asyncapi.yaml`: no change (`vol.captured` is a bus topic only, not a stream channel this round).

---

## 4. Demo mode

Demo mode never touches the network: back-fill sources are synthesised, `marketData` is the demo adapter, and VIX history comes from the demo `INDIAVIX`. Every route, the scheduler, the store and the UI run unchanged, so the whole feature can be tested and screenshotted.

### 4.1 Demo adapter changes (`demo/demoAdapter.mjs`)

| Change | Detail |
|---|---|
| Time-varying IV level | `ivLevel(u, t)` = clamp(0.06, 0.60, `hv60(u, d) × (1.08 + 0.10·sin(2π·d/61 + φ(u)))` + `0.25 × (hv20(u, d) − hv60(u, d))`), where d is the IST day number and hv20/hv60 are the demo's own close-to-close realised vols over the trailing sessions (cached per symbol and IST date). This keeps **IV above realised on most days** (a positive variance premium, as in real markets) and lets IVR travel 0–100 over a year. Measured today the demo's index HV20 runs about 15–30 %, so demo index IV will run about 16–35 %: higher than real NIFTY, but internally consistent, which is what the tests need. `spotAt` is **not** changed, so prices of spot, futures and screenshots elsewhere are unaffected. |
| Smile | `smileVol(u, spot, K, years, level = u.iv)`: the existing shape around `level`. Existing tests keep passing (they call it without `level`). |
| Pricing on the clock | `optionPrice` and `futurePrice` use `pricing.js`: Black-76 with `σ√T_vt` from the demo clock context (reference demo calendar, default weights) and `df = e^(−r·T_cal)`, forward `S·e^(r·T_cal)`. So the engine recovers the demo smile vol exactly (up to tick rounding), which is the server/client agreement fixture. |
| `INDIAVIX` | Added to `DEMO_UNDERLYINGS` (`kind: "INDEX"`, no derivatives). `spotAt("INDIAVIX", t)` = 100 × NIFTY 30-day **calendar-basis** ATM vol from `ivLevel` and the term factor, × (1.03 + 0.03·sin(2π·d/17)), rounded to 0.0025. Candles and quotes follow. |
| Light chain builder | `demoChainAt(symbol, expiry, t, strikesEachSide)` returns an `OptionChain`-shaped object (ltp, bid, ask, oi, volume) using `optionPrice` only (no 26-sample high/low walk), for history seeding: ≈ 120 legs in < 1 ms. |
| Closing quotes | After close the demo keeps two-sided quotes (as today), so the `late` path is testable. |

### 4.2 Seeded history (`vol/demoVol.mjs`)

On the first start in demo (and whenever `dataDir/vol/` is empty in demo), the service seeds NIFTY, BANKNIFTY and SENSEX in background chunks (`setImmediate` per 20 days, ≤ 1.5 s CPU total):

- **300 trading days** back from yesterday on the demo calendar.
- **Days −1 … −34**: `quality: "live"`, built by running the real `capture.mjs` on `demoChainAt(..., 15:25 that day)` for that day's expiries.
- **Days −35 … −300**: `quality: "backfill-eod"`, built by running the real `proxy.mjs` on synthetic bhavcopy rows (15:30 closes from `optionPrice`, futures settle from `futurePrice`, contracts from the demo volume model).
- **One missed day** (day −12, reason `BRIDGE_OFF`), so the gap is visible on the chart and in `/history`.
- VIX history for the same days from the demo `INDIAVIX`; HV from demo daily candles.
- S9 predictions for the live days.
- `source: "demo"` and `status().demo: true`. Every UI place that shows the source says "Demo".

### 4.3 Demo-only switches

- `GET /v1/vol/rank?...&demoPartial=1` and `/snapshot?...&demoPartial=1` (honoured in demo only, ignored otherwise) rank against the 34 live days only, so the "partial: 34 of 252 days" state can be seen and screenshotted.
- `POST /v1/vol/backfill` in demo generates real **UDiFF-format CSV text** for each requested day (≤ 30 days per request in demo) and feeds it through `udiffBhav.mjs` → `proxy.mjs`, so the full parser path is exercised end to end without the network. Progress is shown as for a real job (with a 50 ms pause per file so the progress bar is visible).
- `POST /v1/vol/capture` in demo works at any time of day: it captures "now" from the demo adapter (the demo market never closes) with `trigger: "manual"`.
- BANKEX is not a demo underlying: `status` lists it as `available: false, reason: "NOT_LISTED_IN_DEMO"`. FINNIFTY and MIDCPNIFTY are demo underlyings (added by P1-1 M13, which lands earlier) and are seeded like NIFTY.

---

## 5. Dashboard

Only shared tokens and existing helpers are used (`desk-stat`, `alertBox`, `emptyState`, `chartSlot`, `sheetPopover`, `segmented`, `freshnessPill`). New classes are named; their look comes from the restyle tokens. All new copy is descriptive: no "rich", "cheap", "buy", "sell", "best" or "recommend" (test in §9.4).

### 5.1 Clock context (`vol-context.js`, every Options page)

- `loadPricingContext(underlying)`: `GET /v1/vol/clock?underlying=` (10-minute cache, refreshed on underlying change) → `O.setPricingContext(ctx)`. Until it arrives, `options.js` uses a **weighted, weekends-only** context and every method note says "Holidays not loaded yet". If the route fails (older Bridge), the fallback stays, labelled.
- `clockNote(ctx)` returns the method-note lines: "Time: weighted vol-time clock (trading day 1, weekend/holiday day 0.15, overnight share 0.20, 268.95 units a year). Expiry day: the 30-minute settlement window counts one third. Interest uses calendar days."

### 5.2 Volatility page (`#/vol`, `vol.js`)

**KPI row.** The `rank` tile becomes live and a `vix` tile is added after it (the design's scrolling KPI row already allows more tiles).

| Tile | Value | Sub | States |
|---|---|---|---|
| IV rank | `IVR 55` | `IVP 70 · 252d` | partial: sub `IVP 70 · 252d · 34 live` with class `is-partial` (quiet ink token); collecting (n < 20): value `Collecting`, sub `3 of 252 days`; no data: `Unavailable`, sub = reason ("Tracking starts at 15:25 today" / "Not tracked: add it in vol.stocks") |
| VIX | `13.42` | `pctl 48 · NIFTY 30d 13.10` | no history: sub `pctl: 3 of 252 days`; no VIX data: `--`, sub "No INDIA VIX from this data source" |

Tapping either tile opens the **rank popover** (`vol-rank.js`, `sheetPopover`; bottom sheet on phone):
- A segmented control `30d · 90d · 252d` (default 252; choice kept in desk prefs `volRankLookback`).
- For the chosen lookback: IVR, IVP, current IV and its time, min (value and date), max (value and date), n of N with live/back-fill split.
- "This expiry (same time to expiry)": the same-DTE rank for the page's selected expiry, with its band.
- VIX: value, 252-day percentile, and "VIX 13.42 vs NIFTY 30-day ATM IV 13.10 (both on calendar time)".
- Definitions (the `definitions` text) and the basis line. A "Data" link scrolls to the history panel.
- Copy example: "30-day IV is 12.86 %. Over the last 252 trading days it was lower on 70 % of days (IV percentile 70) and sits 55 % of the way from the low (9.80 %, 11 Mar) to the high (16.30 %, 4 Jun)."

**History panel (`vol-history`, `vol-history.js`).** The panel keeps the `chartSlot("ATM IV, VIX and HV20 over time", …)` box at the top (the owner's engine mounts there later) and adds, under it, the BRD §10.1 fallback:
- Controls: range `1M · 3M · 6M · 1Y · All` (`segmented`), basis `30-day · Front expiry`, series toggles `IV · VIX · HV20 · IV−HV` (checkbox chips), `Table`, `CSV`.
- SVG line (purpose-built, ≤ 120 lines of code, no library): one polyline per series; back-fill segments carry class `q-backfill` (drawn lighter by token) and a legend key "EOD proxy, lower quality"; missed days break the line (no interpolation); front-expiry rolls are vertical hairlines with class `roll` and the tooltip "Rolled to 17 Nov expiry". Hover/tap shows date, values and quality. y-axis in vol points.
- Table toggle: date, IV, VIX, HV20, IV−HV, quality, with `caption` and the same range; sticky first column; scrolls inside the panel.
- CSV: `/v1/vol/history?format=csv` with the current range, basis and series.
- Text alternative (BRD §7.4): one summary sentence under the chart ("30-day IV ranged 9.8–16.3 % over the last year; today 12.86 %, VIX 13.42, HV20 11.75").
- Empty states: no history → `emptyState` "IV history starts at 15:25 today. Back-fill a year from NSE files in Settings (needs NSE archive downloads on)." with a **Back-fill** button (visible only on this computer; calls `POST /v1/vol/backfill`); running back-fill → progress line "Back-filling 211 of 504 files (about 11 min)" from `/v1/vol/status` every 5 s while running.

**Method note.** Replace the time line with `clockNote(ctx)`, the forward line with "median of K + (C − P)·e^(r·T_cal) over the 5 two-sided strikes nearest the forward", the IVR "unavailable" line with the definitions and basis, and add "Probabilities (bands, chance figures) are model values; calibration: not yet measured" (D8).

**Customise sheet.** Shows the clock mode and weights read-only ("Set in bridge.config.json → vol.clock"), and the rank lookback.

**Phone / tablet / desktop.** Phone (< 720): tiles in the scrolling KPI row; popover as bottom sheet; history panel defaults to `3M`, chart 160 px tall, controls wrap to two rows, table opens full width. Tablet (720–1024): as phone with the popover anchored. Desktop (≥ 1024): history panel full width under the term table (existing layout slot), default range `1Y`.

### 5.3 Option Chain summary strip (`desk.js`)

- New strip item `ivr` after `iv`: value `IVR 55`, sub `IVP 70` (or `34/252d` when partial, `Collecting` when n < 20). Source: `/v1/vol/snapshot?underlying=` once a minute (only while the chain page is visible; `every()` already skips hidden tabs).
- Tap/click opens the same rank popover. Title: "IV rank of 30-day constant-maturity ATM IV over 252 trading days".
- The existing `iv` item's title gains the clock note. The 1-day move uses one trading-day unit (`σ·√(1/Y)`), labelled "1 trading day ±…".
- Phone: the strip is one scroll row; `ivr` sits after ATM IV. Not shown for underlyings with `available: false` (no empty tile on the strip).

### 5.4 Order ticket (`desk.js openTicket`)

For option tickets, one context line under the price row: `IVR 55 · IVP 70 (252d) · VIX 13.42`, or `IVR: collecting (3 of 252 days)`. It reads the cached snapshot (no new request when the chain page loaded it in the last minute). Informational only: it never blocks or changes any button. Phone: one line, truncated with the popover on tap.

### 5.5 Screener (`screener.js`, `screens.js`)

- Two optional columns `IVR` and `IVP` (tab presets: on in the "Premium" and "Vol" tabs, off elsewhere; the column picker can add them anywhere). Source: `/v1/vol/summary?underlyings=<scanned set>` once per sweep (memory only). Cells: number, or `n/N` in quiet ink when partial, or `—` with title = reason.
- Header title: "IV rank of 30-day ATM IV over 252 days, as of {asOf}. Stocks: back-filled from end-of-day files, lower quality."
- `screener.js:990` copy becomes "IV rank and percentile are shown where the Bridge has IV history (see Volatility → IV history). Filters on them come later."
- No IVR filters this round (E2, P2).

### 5.6 Builder, positions, OI, arbitrage

- `strategy.js`: T, theta, σ bands and the payoff's "T+N" dates come from the clock (via `yearsToExpiry`/`volYearsAt`). The theta row reads "Θ per trading day"; on Friday afternoon the tooltip adds "Next session decays 1.3 trading days (weekend weight 0.15 a day)". Chance-of-profit and PoP keep their values and gain the label "Model probability · uncalibrated".
- `positions.js`: leg T from the clock; the Θ tile title becomes "₹ per trading day"; `daysTo` keeps calendar days for display.
- `oi.js`, `arbitrage.js`: display days stay calendar (`timeToExpiry`); arbitrage carry and box rates stay calendar ACT/365 (money, not vol). No visible change except method notes.

---

## 6. Formulas and worked examples

All functions below are pure, live in `dashboard/pricing.js` (or `vol/capture.mjs`, `vol/backfill/proxy.mjs`), and each worked example is a reference-value test (§9.1). Default settings unless stated: weighted clock, w_nt = 0.15, φ = 0.20, Y = 252 + 113 × 0.15 = **268.95**, session 09:15–15:30, settlement window W = 30 minutes ending at the close, r = 6.5 %. Holidays in examples are **fixtures, not claims about the real calendar**.

### 6.1 The vol-time clock (A15)

Time left is a sum of variance blocks between now and the settlement. Units are trading-day equivalents.

- Each trading day D ≤ expiry E contributes, with m_D its event multiplier (default 1):
  - a **gap block** at D's open: m_D·φ + Σ w_nt·m_N over the non-trading days N between the previous trading day and D. It counts only if now is before D's open;
  - a **session block** (1 − φ)·m_D spread uniformly over D's session minutes S = close − open = 375. Remaining effective minutes:
    - an ordinary day: close − max(now, open), clipped at 0;
    - the expiry day, settlement window [A, B] = [close − W, close]:
      - now < A: (A − max(now, open)) + W/3;
      - A ≤ now < B: (B − now)³ / (3·W²);
      - now ≥ B: 0.
- U = Σ blocks; **T_w = U / Y**.

Why the window term: the settlement price is the average over [A, B] (index options; for stock options the closing price, itself the 30-minute VWAP; both **need verification**). The variance of an average over a window you have not entered is σ²·W/3; once inside, the unfixed part has variance σ²·(B − now)³/(3·W²). So T shrinks smoothly to 0 at B with no floor. Weekend and overnight weight sit at the next open: T does not change while the market is shut, so Friday-close and Monday-pre-open prices give the same IV.

Other modes: **trading** = the same with φ = 0, w_nt = 0, Y = 252; **calendar** = (B_E − now) / 365 days (ACT/365 to the close of expiry, no floor, no window).

Worked example 1 (NIFTY weekly, expiry Tue 3 Nov 2026, no holidays). At Thu 29 Oct 10:00:

| Block | Units |
|---|---|
| Thu session: 0.8 × 330/375 | 0.704 |
| Fri gap 0.2 + session 0.8 | 1.000 |
| Mon gap 0.2 + 2 × 0.15 + session 0.8 | 1.300 |
| Tue gap 0.2 + session 0.8 × (345 + 10)/375 | 0.957 |
| **U** | **3.96133** |

T_w = 3.96133 / 268.95 = **0.0147289**. Calendar: 5.229 days / 365 = 0.0143265. Trading: 3.82667 / 252 = 0.0151852.

Worked example 2 (Friday → Monday, same expiry):

| Instant | U | T_w | T_cal |
|---|---|---|---|
| Fri 15:29 | 2.25947 | 0.0084011 | 0.0109608 |
| Fri 15:30 | 2.25733 | 0.0083931 | 0.0109589 |
| Sat 12:00 | 2.25733 | 0.0083931 | 0.0086187 |
| Mon 09:14 | 2.25733 | 0.0083931 | 0.0034551 |
| Mon 09:16 | 1.75520 | 0.0065261 | 0.0034513 |

At the Monday open U drops by 0.5021 (gap 0.2 + weekend 0.3 + one session minute). With σ = 12 % held fixed, an ATM call (F = K = 25,150) is 110.30 at Fri 15:29 and 97.20 at Mon 09:16. Solving back: weighted gives **12.00 % at both**; calendar ACT/365 gives 10.51 % on Friday and 16.49 % on Monday (the weekend artefact the BRD's P persona complains about).

Worked example 3 (long weekend; fixture holiday Mon 9 Nov; expiry Tue 10 Nov). At Fri 6 Nov 15:00: session 0.8 × 30/375 = 0.064; Tue gap = 0.2 + 3 × 0.15 = 0.65; Tue session 0.75733; U = **1.47133**, T_w = 0.0054707 (calendar 0.0110160).

Worked example 4 (expiry day, Tue 3 Nov; ATM, F = K = 25,150, σ = 12 %, prices rounded to the 0.05 tick):

| Time | U | T_w | ATM call | IV weighted | IV calendar | IV calendar with today's 0.25-day floor |
|---|---|---|---|---|---|---|
| 14:00 | 0.14933 | 0.000555 | 28.35 | 11.99 | 21.59 | 10.80 |
| 15:00 | 0.02133 | 0.0000793 | 10.70 | 11.97 | 14.12 | 4.08 |
| 15:20 | 0.00079 | 0.0000029 | 2.05 | 11.92 | 4.68 | 0.78 |

No blow-up and no floor artefact on the weighted clock (the small drift is tick rounding). These three rows are the BRD's 14:00/15:00/15:20 reference tests. Rule: on expiry day inside the window, a leg whose price is within 2 ticks of its intrinsic value against the forward gets `iv: null`, reason `SETTLING`.

### 6.2 Converting between clocks

Total variance is clock-independent: σ_x² · T_x = σ_y² · T_y = tv. So σ_x = √(tv / T_x). Example: weighted 12.86 % at T_w = 0.0824242 → tv = 0.0013631; calendar T = 0.0794616 → **13.10 %**. History rows store `tv`, `T`, `Tcal`, `Ttd`, so `?clock=` converts exactly.

### 6.3 Parity forward and interest time

F_k = K + e^{r·T_cal}·(C_mid − P_mid) for the 5 strikes nearest spot with both legs two-sided (bid > 0, ask ≥ bid); F = median. Fewer than 1 such strike → F = spot, flag `FORWARD_SPOT`. Discount factor df = e^{−r·T_cal}. Volatility uses T_vol from §6.1.

Worked example 5 (Thu 29 Oct 10:00, r = 6.5 %; the e^{rT} below uses T = 0.0147289, as in the BRD's wording, so the numbers can be checked by hand; with T_cal = 0.0143265 every F moves by under 0.004):

| K | C mid | P mid | F_k |
|---|---|---|---|
| 25,050 | 205.0 | 112.6 | 25,142.49 |
| 25,100 | 176.1 | 133.8 | 25,142.34 |
| 25,150 | 149.9 | 157.3 | 25,142.59 |
| 25,200 | 126.4 | 183.9 | 25,142.44 |
| 25,250 | 105.7 | 213.1 | 25,142.50 |

Median **F = 25,142.49**.

### 6.4 IV (the single function)

Solve df·Black76(F, K, T_vol, σ, right) = price for σ: Newton on vega from the Brenner–Subrahmanyam seed, falling back to bisection on [0.5 %, 500 %] (today's `impliedVolB76`, moved). Price basis: the mid when two-sided; the LTP otherwise (flag `q: "ltp"`); nothing below df·intrinsic − 0.025. Smile point per strike = the OTM side (PE below F, CE at or above). ATM IV = linear in strike between the two strikes bracketing F, of each strike's CE/PE mean IV.

Agreement target (BRD): server (`market/chain.mjs` with `ivModel=b76-forward`) and dashboard (`options.js` vol page) produce ATM IV within **0.05 vol points** on every demo chain; in practice they are identical because both call `pricing.js` on the same JSON (the test also asserts that per-leg IVs agree to 1e-9).

### 6.5 Greeks and theta

On the forward, per unit: Δ = N(d1) (CE) or N(d1) − 1 (PE); Γ = n(d1)/(F·σ√T); vega = F·n(d1)·√T / 100 per vol point; **theta per trading-day unit** = −F·n(d1)·σ / (2√T) × (1/Y) (i.e. the decay of one unit of vol-time). The decay to the next session at the same time is θ × ΔU, where ΔU comes from the clock (1.0 from one weekday to the next, 1.3 from Friday to Monday, more across a holiday). Example: ATM, F = 25,150, σ = 12 %: decay Thu 15:00 → Fri 15:00 = **21.90** points; Fri 15:00 → Mon 15:00 = **37.62** points (weekend weight plus a full session).

### 6.6 30-day constant maturity (cm30)

Target date = today + 30 calendar days; if that is not a trading day, the previous trading day. T* = clock T to that date's close (as if it were an expiry, window included). Take the two listed expiries bracketing T*, skipping any expiry on its own expiry day:
TV* = TV₁ + (TV₂ − TV₁)·(T* − T₁)/(T₂ − T₁); σ_cm = √(TV*/T*). If no expiry lies beyond T*: flat from the last (`method: "flat-extrapolated"`); if none lies before: flat from the first.

Worked example 6 (Thu 29 Oct 15:25, no holidays): target Sat 28 Nov → Fri 27 Nov. U₁ (17 Nov) = 13.868, U₂ (1 Dec) = 24.468, U* = 22.168 → T₁ = 0.0515635, T₂ = 0.0909760, T* = 0.0824242. With σ₁ = 12.6 %, σ₂ = 12.9 %: TV₁ = 0.00081862, TV₂ = 0.00151393, TV* = 0.00136306 → **σ_cm = 12.86 %**; calendar basis (T*_cal = 0.0794616) **13.10 %**.

### 6.7 IV Rank and IV Percentile

Over the last N trading days **before today** that have a row (live, or `backfill-eod` when `quality=all`), values v₁…vₙ, current c:
- IVR = (c − min v)/(max v − min v) × 100; null when n < 20 or max = min.
- IVP = 100 × |{ i : vᵢ < c }| / n (strictly below).
- `partial` = n < N; `liveN` and `backfillN` reported.

Worked example 7: v = [11.2, 12.5, 14.1, 9.8, 13.0, 15.6, 10.4, 12.0, 16.3, 11.9], c = 13.4 → IVR = (13.4 − 9.8)/(16.3 − 9.8) = **55.38**; IVP = 7/10 = **70** (for the test the minimum-n rule is passed as 5).

VIX percentile uses the same IVP formula on `vix.jsonl` closes.

### 6.8 Bands, expected move and logged probabilities

σ_T = σ·√T_vol. 1σ band = [F·e^{−σ_T}, F·e^{σ_T}]; 1σ move = F·(e^{σ_T} − e^{−σ_T})/2; expected absolute move ≈ √(2/π)·σ·F·√T_vol (and the ATM straddle is logged beside it). Example (F = 25,142.49, σ = 12 %, T = 0.0147289): σ_T = 0.0145635 → band **24,779.0 – 25,511.3**, move **366.2**, expected absolute move **292.2**.

### 6.9 Same-DTE rank (per listed expiry)

For expiry e with U_e units left now, the comparison set = past expiry rows (any expiry of the same underlying) with |U − U_e| ≤ `sameDteBand` (0.5), one per date (the closest U), within the lookback. IVR/IVP as §6.7. Example: U_e = 3.96 → rows with 3.46–4.46 units left; NIFTY weekly rows give about one a week per weekly series, so after 252 days n ≈ 60: the popover shows "n = 61".

### 6.10 Back-fill proxy ATM IV (store S6 → S2)

For underlying u, date d and each listed expiry e with 2 ≤ trading DTE ≤ 70:
1. **Forward**: same-expiry future settle price if listed (`forwardSource: "future"`); else the near-month future's settle × e^{r·(T_cal,e − T_cal,fut)} (`future-carried`); else the parity median of §6.3 on closes of strikes with ≥ minContracts on both legs (`parity-close`).
2. **Points**: strikes within 2 strike steps of F, OTM side, contracts ≥ `minContracts` (index 500, stock 50; **needs verification of a sensible threshold** against real files), standard contracts only (P1-2 `nonStandard` false). IV by §6.4 with price = close and T at the day's close (window included).
3. **ATM IV**: linear at F between the two nearest usable points on either side; if only one side has points, the nearest point within one strike step; else no row (`THIN`).
4. **cm30** when two expiries bracket the target, else the summary keeps `front` only and `cm30.method: "unavailable"`.
5. HV from the same days' underlying closes (UDiFF `UndrlygPric`, **needs verification**; legacy files have none, so HV comes from candles/Yahoo).
Rows carry `quality: "backfill-eod"` and the contracts used.

### 6.11 Realised vol estimators

r_i = ln(C_i/C_{i−1}). **Close-to-close** HVn = stdev(r, sample) × √252 × 100 (existing `realisedVol`). Example: closes 25,000, 25,210, 25,080, 25,300, 25,190, 25,420 → r = [0.008365, −0.005170, 0.008734, −0.004357, 0.009089] → **HV5 = 11.75 %**. **Parkinson**: σ² = (1/(4·ln 2))·mean(ln(H/L)²) × 252. **Yang-Zhang**: σ² = σ_o² + k·σ_c² + (1 − k)·σ_rs², k = 0.34/(1.34 + (n+1)/(n−1)), with σ_o the open-gap variance, σ_c open-to-close, σ_rs Rogers-Satchell; each annualised by 252. Index daily candles must have real highs and lows; when a broker's index candles have H = L = C (some do), Parkinson and YZ are null with reason.

---

## 7. Rate-limit budget

| Path | Calls | Budget and rule |
|---|---|---|
| 15:25 capture (indices) | 6 underlyings × ≤ 4 expiries = **24 chain calls** + 6 daily-history calls + 1 quote call, once a day | `priority: "background"`, ≤ `budgetShare` (50 %) of the chain class, inside 15:25:00–15:29:30. Dhan (chain 20/min, **unverified**): 10/min → 2.4 min, fits. Zerodha (built chains, quote class 1/s shared): 24 quote calls at 30/min, fits. Upstox: fits |
| Stocks opt-in | 2 chains per stock | Capacity = (window × background rate − index calls) / 2: Dhan ≈ 10 stocks, Zerodha ≈ 50, Upstox 50 (cap). `PUT`-free: config beyond capacity is refused at start with "Your Dhan account can capture 10 stocks in the 15:25 window; 32 are configured". With the P1-1 recorder, 0 calls |
| 15:35 retry | Only failed/partial underlyings + 1 quote call | Same rules |
| Snapshot (live rank) | ≤ 3 chains per underlying per `snapshotTtlSeconds` (60 s), only while a page shows it | `background` priority, `maxAgeMs` 60 s so the open chain page's own fetch is reused; served stale when there is no headroom. User chain requests are never delayed (scheduler priority); a test asserts it with a fake broker |
| `summary`, `rank`, `history`, `clock`, `status` | **0 broker calls** (memory/disk) | < 5 ms p95 (`summary`, `rank`); `history` 400 days < 50 ms |
| VIX history | 1 history call (chunked by `market`) per back-fill | `background`; Yahoo through `backupData` limits (4/s) |
| NSE / BSE archives (back-fill) | 1 file per trading day per exchange: ≈ 250 + 250 for a year; user-started; resumable | One request in flight, ≥ 2 s apart (P1-2 client), ≤ 600 files a day, 60 MB cap per file. A year takes ≈ 20–30 min |
| Dashboard → Bridge | clock: 1 per underlying per 10 min; snapshot: 1/min on chain/vol pages; summary: 1 per screener sweep; status: every 5 s only while a back-fill runs and the panel is open | Per-key limiter unchanged |
| CPU | Capture compute ≤ 200 ms for 24 chains; back-fill parse ≤ 1.5 s per file in a chunked loop (`setImmediate` every 2,000 lines) so the event loop never blocks > 50 ms | §7.1 |

---

## 8. Safety and compliance gates

### 8.1 Order safety (nothing loosens `docs/guides/safety.md`)

- No new route or tool can prepare, place or modify an order, or touch the kill switch, limits or live gates.
- The ticket's IVR line is informational and never enables or blocks a button. The stale-data guard is unchanged.
- `ivModel=b76-forward` changes displayed IV and Greeks only. Order prices, paper fills and safety checks never read IV.
- Back-fill rows never feed anything that sizes or prices an order.

### 8.2 Compliance (BRD §8)

- **Neutral copy (RA/IA rules, §8.1):** ranks are described as positions in a history ("lower on 70 % of days"), never as "high/low vol, sell/buy premium", "rich" or "cheap". A test greps `vol-rank.js`, `vol-history.js` and the new strings in `vol.js`, `desk.js` and `screens.js` for the banned list used by the screener tests.
- **Probabilities (D8, §8.4):** every probability touched in this round carries "Model probability · calibration: not yet measured". S9 logging starts for server-computed ones.
- **NSE terms of use:** only the NSE **archives** host files, through P1-2's client and consent. The NSE website API is never called from this module. Back-fill is user-started, polite (≥ 2 s gap, one in flight), capped per day. The legal check of the archives host is in P1-2's register.
- **Market-data terms (§8.3):** everything stays in `dataDir`; nothing is pooled or uploaded. Captures use one data account (`vol.account` or the first capable one) and record which; they never spread one underlying's capture over another holder's account (the call is pinned with `accountId`).
- **Yahoo (backup):** used only with `backup.enabled` and the Yahoo provider on; labelled `source: "yahoo"`; personal use.
- **Data honesty (D5, §7.6):** `available: false` with reasons; `quality` on every row; back-fill drawn lighter and labelled; gaps never interpolated; "partial" and "collecting" states.
- **Security (§7.9):** writes are admin + loopback and audited; MCP is read only; responses carry `broker`, never `accountId`; stores hold no secrets (test reuses the `securityReview.test.mjs` token-shape scan on `dataDir/vol/`).
- **Disclaimer** in the history panel footer: "Implied volatility from market prices and end-of-day files as labelled. Not investment advice."

### 8.3 "Needs verification" register

| Item | Where |
|---|---|
| Index settlement = average of the last 30 minutes; stock closing price = 30-minute VWAP | `vol.clock.settlementWindowMinutes`, method note |
| NSE F&O bhavcopy URLs, legacy and UDiFF layouts, and the switch date | `backfill/legacyBhav.mjs`, `udiffBhav.mjs`, fixtures |
| BSE derivatives bhavcopy URL and layout | `backfill/bseBhav.mjs`, fixture |
| UDiFF `UndrlygPric` meaning (spot close?) | §6.10 step 5 |
| INDIA VIX uses calendar time (minutes/525,600) | VIX vs IV comparison copy |
| Yahoo `^INDIAVIX` daily history availability | `vix.mjs` |
| Dhan chain limit 20/min (policy marked unverified) | capacity copy |
| Clock weights 0.15 / 0.20 are assumptions | method notes, config docs |
| `minContracts` thresholds | `vol.backfill.minContracts` |

---

## 9. Test plan

Vitest, files next to the code, existing naming. Every pure function gets a reference-value test (BRD §7.6).

### 9.1 Unit (pure)

| File | Covers |
|---|---|
| `server/bridge/dashboard/pricing.test.mjs` | §6.1 examples 1–4 exactly (U to 1e-5, T to 1e-7); calendar and trading modes; event-day multiplier; holiday fixture; now after settlement → 0; IST correctness under `TZ=UTC` and `TZ=America/New_York`. §6.2 conversion. §6.3 example 5 (and calendar-T variant), spot fallback, one-sided strikes excluded. §6.4 IV round trip (σ 1–150 %, moneyness 0.7–1.3, T 1e-6–1) to 1e-6; `SETTLING` rule. §6.5 Greeks vs finite differences; theta decays 21.90 and 37.62. §6.6 example 6 and both extrapolation cases; expiry-day row skipped. §6.7 example 7, n < min, flat. §6.8 band numbers. §6.9 band selection. §6.11 HV5 = 11.75, Parkinson and YZ against a hand-computed 5-day fixture |
| `server/bridge/dashboard/pricing.shared.test.mjs` | `pricing.js` has no `import`, no `document`/`window`/`fetch`, no `"09:15"`/`"15:30"`/`365 * ` session literals except inside the `calendar` mode function; it imports cleanly in Node and is listed in `DASHBOARD_FILES` |
| `server/bridge/vol/capture.test.mjs` | Frozen demo chain fixtures → S2 rows (forward, atmIv, 9-point smile, rr25 = −putSkew25, bf25, flags `WIDE_ATM`, `FORWARD_SPOT`, `THIN`, `EXPIRY_DAY`); summary cm30 on three clocks equals §6.2 conversions; front roll on expiry day |
| `server/bridge/vol/backfill/legacyBhav.test.mjs`, `udiffBhav.test.mjs`, `bseBhav.test.mjs` | Header detection, BOM, quoted fields, blank strikes for futures, date formats (`28-JUN-2024`, `2024-07-08`), unknown instrument types skipped, only tracked underlyings kept, streaming over chunk boundaries |
| `server/bridge/vol/backfill/proxy.test.mjs` | Forward source order; minContracts filter; non-standard exclusion; THIN; a fixture day whose closes are Black-76 prices at 13 % → proxy ATM IV 13.00 ± 0.02 |
| `server/bridge/vol/config.test.mjs` | Defaults, strict keys, weight bounds, Y default = 268.95, eventDays validation |
| `server/bridge/vol/store.test.mjs` | Append and read; last line wins; torn last line skipped and counted; compaction through `writeFileAtomic`; retention; live beats back-fill for the same key; missed rows |

### 9.2 Service, scheduler and static

- `server/bridge/vol/volService.test.mjs` (fake clock, temp `dataDir`, `market/fake.mjs`, P1-2 `reference/fake.mjs`):
  - capture fires at close − 5 on a trading day and not on a fixture holiday or weekend;
  - stops at close − 0.5 min and marks `partial`; 15:35 retry fills only failed/partial; late capture at start between close + 5 and + 30; missed rows after + 30 and for days the Bridge was off;
  - chain calls are `background` priority and pinned to `vol.account`; capacity refusal message; with a fake `recorder` service present, zero chain calls;
  - snapshot reuses a cached chain (call counter) and serves stale without headroom;
  - **user-priority chain read during a capture is not delayed > 200 ms** (fake broker with the Dhan policy);
  - `vol.captured` payload; predictions written.
- `server/bridge/vol/backfill/job.test.mjs` (fake archive client): consent refusal; newest-first order; resume from `progress.json`; 404 → `no-file`; parse failure keeps going; daily cap; cancel after current file; VIX history loaded with `allowBackup`; no network (`globalThis.fetch` throws).
- `server/bridge/vol/demoVol.test.mjs`: same date → same seed; 300 days with 34 live, 1 missed; demo IV − HV20 mean > 0 over the year; IVR spans < 10 to > 90 over 300 days; demo IV within 6–60 %; `INDIAVIX` ≈ NIFTY cm30 calendar × 1.00–1.06; demo back-fill goes through the real UDiFF parser.
- `server/bridge/vol/agreement.test.mjs` (**acceptance criterion 2**): for NIFTY, BANKNIFTY and SENSEX demo chains at 6 fixed instants (including Friday 15:29, Monday 09:16 and expiry day 15:20), the server `/v1/optionchain?ivModel=b76-forward` ATM IV and per-leg IVs vs `options.js` `termRow`/`smilePoints` on the same JSON: |ΔATM| ≤ 0.05 vol points, per leg ≤ 1e-9; and the recovered ATM IV vs the demo's `smileVol` at the forward within 0.15 vol points (tick rounding).
- `reference/noConstants.test.mjs` (P1-2's test) gains: `\bT_FLOOR\b`, `0\.25\s*\/\s*365`, `theta[^\n]*\/\s*365`, `days\s*\/\s*365` and `\/\s*365\b` in `dashboard/options.js`, `dashboard/pricing.js` (outside the calendar-mode function), `market/chain.mjs` and `demo/demoAdapter.mjs`. Allow-list with reasons: `options.js` `carryFactor`, `boxLimit`, `futuresTerm`, `parityRows`, `boxes`, `cheaperExposure` (money accrues on calendar days); `server/lib/blackScholes.mjs` is frozen legacy, used only by `ivModel=legacy-bs-spot` and broker adapters, listed as a known exemption until the deprecation ends.

### 9.3 Contract tests

- `server/bridge/core/openapi.test.mjs` (existing) passes with the 10 operations, `x-stream: S18`, scopes, loopback flags, the `ivModel` parameter and the new fields.
- `server/bridge/vol/routes.test.mjs`: every route's happy path and §3.2 errors; `available: false` shapes and reasons; CSV header and filename; cursor paging; `clock=` conversion; `quality=live`; `demoPartial` honoured only in demo; admin + loopback refusals; audit rows; no `accountId` anywhere in any response (deep key scan); every response field present in the OpenAPI schema (schema walk).
- `server/bridge/market/ivModel.test.mjs`: legacy default unchanged byte for byte against a stored fixture; `Deprecation` and `Link` headers only when legacy is the implicit default; `b76-forward` fills `pricing`, recomputes broker legs and keeps `brokerIv`; config `ivModelDefault` flips the default.
- `server/bridge/mcp/tools.test.mjs`: `get_vol` returns the same `data` as REST for `rank` and `history`; no write path; `get_option_chain` accepts `ivModel`.
- `server/bridge/market/units.test.mjs` / `normalise.contract.test.mjs`: unchanged and green (OI units untouched).

### 9.4 Dashboard

- `options.test.mjs`: every test that relied on `/365`, `T_FLOOR` or r = 0 Greeks passes an explicit context (calendar mode reproduces old values where the test is about something else); new cases for `yearsToExpiry` on the clock and theta per trading day; re-exports from `pricing.js` are the same function objects.
- `vol.test.mjs`: rank tile states (full, partial, collecting, unavailable), VIX tile, method-note lines, no "Unavailable" when history exists.
- `vol-rank.test.mjs`: `rankText()` copy for each state; banned-word check; popover lookback switch.
- `vol-history.test.mjs`: SVG path breaks at a missed day; back-fill segments get `q-backfill`; roll markers; table rows = points; CSV URL; 360 px layout has no horizontal page scroll (DOM width check as in `polish.test.mjs`); text alternative sentence.
- `desk.test.mjs`: strip `ivr` item present only when available; ticket context line text; no extra request when the snapshot is cached.
- `screens.test.mjs`: IVR/IVP columns, partial cell, header title with `asOf`.
- `polish.test.mjs`: add `vol-history.js` and `vol-rank.js` (44 px targets, no colour literals).

### 9.5 End-to-end

`server/bridge/e2e/vol.e2e.test.mjs` (demo, real HTTP on an ephemeral port, as `bridge.e2e.test.mjs`):
- Start with `--demo`; wait for seeding (`/v1/vol/status` `liveDays` 34 for NIFTY).
- `GET /v1/vol/clock?underlying=NIFTY&at=<fixture>` matches example 1's parts.
- `GET /v1/optionchain?...&ivModel=b76-forward` has `pricing` and the ATM IV equals `/v1/vol/snapshot`'s front row within 0.05.
- `GET /v1/vol/rank?underlying=NIFTY`: three lookbacks, `partial: false` for 252 (34 live + back-fill), `sameDte` present; with `demoPartial=1`: `partial: true`, `n: 34`.
- `GET /v1/vol/history?underlying=NIFTY&format=csv`: CSV with a `backfill-eod` row, a `live` row and the missed date in `gaps` (JSON form).
- `POST /v1/vol/capture` with an admin key from loopback: 202, then a `manual` row; a read key gets 403.
- `POST /v1/vol/backfill {"sources":["nse"],"from":<-10d>,"to":<-1d>}` in demo: 202, progress to `done`, rows via the UDiFF parser.
- `GET /v1/vol/summary?underlyings=NIFTY,BANKEX`: BANKEX `NOT_LISTED_IN_DEMO`.
- `GET /v1/optionchain` without `ivModel`: legacy values and the `Deprecation` header.

Non-demo variant with fake broker + fake archive client: a capture at the fake 15:25; a Dhan-policy load test (user chain p95 delay ≤ 200 ms during capture); back-fill from the three fixtures.

Manual (`run` skill) at 390×844, 820×1180 and 1440×900, dark and light: IV rank tile and popover, VIX tile, history panel (chart fallback, table, CSV), chain strip IVR, ticket line, screener columns, back-fill progress. Screenshots in the PR.

---

## 10. Migration and back-compat

- **`/v1/optionchain` IV (§7.8).** The computed-IV model is a default, so it changes only after a 6-month deprecation:
  - Now: `ivModel` param added; default `legacy-bs-spot` (byte-for-byte today's output); responses that used the legacy default carry `Deprecation` and `Link` headers; changelog entry "optionchain-ivmodel".
  - Owners can switch now with `market.chain.ivModelDefault: "b76-forward"`.
  - From 1 May 2027 the default becomes `b76-forward`; `legacy-bs-spot` stays selectable until `/v2`.
  - The dashboard sends `ivModel=b76-forward` from this release, so pages agree with the vol store immediately.
- **Theta unit.** Dashboard theta changes from "per calendar day" to "per trading day" with relabelled headers and tooltips. API theta changes only under `ivModel=b76-forward` (documented in the parameter description).
- **Vol page numbers move slightly**: 5-strike forward instead of 3; weighted T instead of floored ACT/365. The method note says so; release notes give example 2 and 4 as the reason.
- **`options.js` exports**: every moved name is re-exported (same function object); `pricing.js` never holds a rate or session literal: every function takes `rate` and the clock context as parameters. Step 2 (P1-3a) may land before P1-2's dashboard steps (P1-2b), in which case `options.js` keeps passing its `RATE`/`RISK_FREE` until P1-2b removes them. `yearsToExpiry(expiry, now)` keeps its signature (context optional).
- **Saved desk state** (`localStorage`): untouched; one new key `volRankLookback` with try/catch.
- **Config**: `vol` is a new optional section (defaults fill it). `market.chain.riskFreeRate` deprecation is P1-2's.
- **Demo**: option prices change (time-varying IV, clock T). Demo tests asserting smile shape keep passing; any screenshot caption quoting a demo IV is updated. Spot and futures prices are unchanged.
- **Data folder**: `dataDir/vol/` is created on first start. `backup/` copies `dataDir` (verify in `backupService.mjs`; if it uses a list, add `vol/`).
- **Streams doc**: S18 row (`vol` service; requires marketData, reference, symbols, scheduler); `dashboard/pricing.js` owned by S18, read by S5 (`market`).
- **Without P1-2** (if this lands first by accident): `context.mjs` falls back to weekends-only calendar, the default session from `market/time.mjs` (labelled), and r = 6.5 % labelled "default"; back-fill refuses with `CAPABILITY_UNSUPPORTED` "needs reference data (P1-2)". This keeps the build green but P1-2 is a declared dependency.

---

## 11. Ordered task list (one engineer, one session)

Each step ends green (`npx vitest run <files>` + `node scripts/check-mjs.mjs`).

1. **Contract and skeleton.** `vol` contract, `vol.captured` topic, `vol/module.mjs` with the 10 routes as `notBuilt`, `config.mjs`, register in `builtinModules`; 10 OpenAPI path stubs (`x-stream: S18`) so `openapi.test.mjs` passes; `fake.mjs`.
2. **`pricing.js`.** Move the maths out of `options.js` (re-export), add the clock, cm30, rank, estimators; `pricing.test.mjs` with every §6 example; `pricing.shared.test.mjs`; add to `DASHBOARD_FILES`.
3. **Client clock.** `vol-context.js`; `setPricingContext`; `yearsToExpiry` on the clock; remove `T_FLOOR`, theta `/365`, scenario `days/365`; `termRow` on the clock and 5-strike forward; thread through `desk.js`, `strategy.js`, `positions.js`, `vol.js`; update `options.test.mjs`.
4. **Server chain.** `vol/context.mjs`; `market/chain.mjs` `ivModel` path, `pricing`, `brokerIv`, default + `Deprecation`; `ivModel.test.mjs`.
5. **Demo adapter.** `ivLevel`, `smileVol(level)`, clock pricing, `INDIAVIX`, `demoChainAt`; update `demo.test.mjs`; **`agreement.test.mjs`** (acceptance criterion 2).
6. **Capture and store.** `capture.mjs`, `store.mjs`, `volService.mjs` capture/retry/late/missed jobs, VIX quote, HV from candles, predictions; their tests.
7. **Read routes.** `clock`, `snapshot`, `history` (+ CSV, cursor, clock conversion), `rank` (+ same-DTE, VIX), `summary`, `status`, `predictions`; `routes.test.mjs`.
8. **Demo seeding.** `demoVol.mjs`, `demoPartial`; `demoVol.test.mjs`.
9. **Back-fill.** Three parsers + fixtures, `proxy.mjs`, `job.mjs` on P1-2's archive client, `vix.mjs`, write routes with audit; their tests; demo back-fill path.
10. **MCP and OpenAPI.** `get_vol`, `ivModel` on `get_option_chain`; full schemas (§3.11); contract tests green.
11. **Volatility page.** `vol-rank.js` (tile, popover), VIX tile, `vol-history.js` (SVG fallback, table, CSV, back-fill button and progress), method note; tests.
12. **Chain strip, ticket, screener.** `desk.js` strip item and ticket line; `screens.js` columns and copy; tests.
13. **Static and polish.** `noConstants` patterns and allow-list; banned-word checks; `polish.test.mjs` list; full suite.
14. **E2E and docs.** `vol.e2e.test.mjs`; `ARCHITECTURE.md`, `STREAMS.md`, `bridge.config.example.json`, changelog entry; the §8.3 register in the PR description; screenshots at three sizes.

**Session split (build order in `docs/spec/README.md`):** **P1-3a** = steps 1, 2, 4, 5 (contract skeleton, `pricing.js`, server chain `ivModel`, demo clock pricing and the agreement test); it lands before the recorder so the recorder uses `pricing.js` directly. **P1-3b** = steps 3, 6, 7, 8 (client clock after P1-2b, capture, store, read routes, demo seeding). **P1-3c** = steps 9–14 (back-fill, MCP, Volatility page, strip/ticket/screener, static checks, e2e). Within P1-3c the cut line is after step 11. Step 12 (strip, ticket, screener) reads only `/v1/vol/snapshot` and `/summary`, so it can land in the next session without blocking P1-6, P1-9 or P1-11. Steps 1–10 can ship alone as the server and API.

---

## 12. Acceptance criteria mapping

| BRD P1-3 criterion | Where it is met | Honest gap |
|---|---|---|
| 1. One vol-time clock used by IV, Greeks, theta, expected move and payoff on server and client; defaults and weights in every method note; Friday→Monday, long-weekend and expiry-day 14:00/15:00/15:20 reference tests | §6.1, §6.5, §5.1, `pricing.test.mjs`, `agreement.test.mjs` | Weights are assumptions, measured later; the server's legacy chain model stays the API default for 6 months (the dashboard and store use the clock now) |
| 2. Parity forward = near-ATM median with r from S5; one IV function on server and dashboard; agreement within 0.05 on the demo chain | §6.3, §6.4, `pricing.js`, `agreement.test.mjs` | Interest uses calendar T, not vol-time T (§1.3; deliberate) |
| 3. 15:25 S2 row per tracked underlying and expiry; 15:35 retry; flagged | §2.4, §2.7, `volService.test.mjs` | Days the Bridge is off are gaps (later fillable as `backfill-eod`) |
| 4. One-time back-fill from both NSE bhavcopy formats and BSE; proxy ATM IV stored `backfill-eod` and drawn lower-quality; VIX history loaded | §2.6, §6.10, §5.2, parsers and job tests | Needs NSE archive consent (P1-2) and Yahoo or broker VIX history; layouts need verification against real files; stock back-fill is noisy and labelled |
| 5. IVR/IVP (30/90/252, definitions) replace "Unavailable" on vol page, chain strip, screener and ticket; "n of N", partial | §3.6, §5.2–5.5, §6.7 | Per-expiry rank is same-DTE (§6.9); fewer than 20 days shows "Collecting" rather than a rank |
| 6. IV chart: ATM IV, VIX, HV20, expiry roll marked, owner's chart engine; `/v1/vol/history` ships regardless | §3.5, §5.2 | The engine has not landed: `chartSlot` stays, with the §10.1 SVG/table/CSV fallback |
| 7. K6 logging (S9) for every probability shown | §2.3 S9, `predictions.mjs` | Server-computed probabilities only; builder PoP and chance of profit are labelled "uncalibrated" and get logged in P1-9 |
