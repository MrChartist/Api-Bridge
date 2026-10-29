# Spec P1-1: Server chain recorder (S1 intraday snapshots, S3 daily derived)

Status: ready to build · Owner: tech lead, Options desk · Date: 29 Oct 2026 · Stream: **S17 (new) "Options recorder"**
Builds on: BRD `docs/brd/options-platform.md` §5 (data strategy), §6.1 P1-1 (acceptance criteria), §7.1–7.9 (NFRs), §8 (compliance).
Hard dependencies (build order in `docs/spec/README.md`): **F0** shared foundations, **P1-2a** (reference server: `reference.session()`, `reference.calendar()`, `reference.rate()`) and **P1-3a** (pricing core: `dashboard/pricing.js`, `vol/context.mjs`, the vol-time clock). The recorder does **not** carry its own calendar, rate or Black-76 code; earlier drafts of this spec did, and those interim copies are removed so there is one implementation of each.
Consumers: P1-3 (S2 from S1), P1-7 (OI/straddle/PCR series), P1-8 (exposure on S1), P1-9 (settlement estimate ticks), P1-11 (recorder-only alerts), Phase 2 replay (I2).

Not in this spec: visual styling. The dashboard is being restyled by another team (near-black theme, colour tokens, motion). Everything below uses existing components (`card`, `table`, `pill`, `meterRow`, `alertBox`, `emptyState`, `sheetPopover` from `app.js`) and the shared tokens in `palette.css`; no new colours, no new motion. Coordinate the two `oi.js` text changes in §7.2 with `docs/design/oi.md`.

> **Build order and shared foundations.** This spec is steps 3–4 (P1-1a server T1–T13, P1-1b dashboard and e2e T14–T16) in `docs/spec/README.md`, after F0, P1-2a, P1-3a. It uses, and does not rebuild, the F0 foundations listed there: final stream ids, bus topics and error codes pre-registered in core, the opt-in `options` MCP toolset (every MCP tool in this spec goes there), `demo/routes.mjs` plus the OpenAPI demo-only list, `server/lib/jsonl.mjs` (append, torn-line tolerance, last-wins, quarantine of corrupt files), `ratelimit/backgroundGate.mjs` (the one ≤ 50 % background-budget check), `core/ownership.mjs`, and `dashboard/copyRules.mjs` (the one banned-word list). Where this text and README disagree, README's build order and shared-module owners win.

---

## 1. Summary

A server module records every configured option chain once a minute (indices) or every five minutes (opted-in stocks) during the equity-derivatives session, with the browser closed, from **one** chosen data account. It prefers the broker WebSocket (zero REST calls), falls back to REST only inside a hard 50 % slice of the broker's budget that can never delay a user's chain request by more than 200 ms, and refuses any configuration the account cannot carry while saying exactly what it can carry. Snapshots are append-only NDJSON day files, gzipped at day end, with configurable retention. A daily job derives S3 rows (PCR, max pain, walls, top ΔOI, futures basis and rollover). Programs read it through `GET /v1/options/snapshots`, `/latest`, `/v1/options/daily` and an MCP tool; the OI page's 5m/15m/30m/1h/since-open windows read from it and `oi-store.js` becomes a cache. A new "Data recorder" page shows state, feeding account, coverage, budget, disk and settings. Demo mode records the demo adapter's chains (made more realistic here) into a separate folder, with a short synthetic back-fill, so every feature can be seen without a broker.

---

## 2. Scope

### 2.1 MUST (this round)

| # | Item | Acceptance hook (BRD P1-1) |
|---|---|---|
| M1 | Recorder module `server/bridge/recorder/` (stream S17) with config section `recorder`, service `deps.recorder`, start/stop wiring | browser closed |
| M2 | Slot calendar over P1-2's `reference.session()` / `reference.calendar()` (holidays, special sessions), plus a "holiday suspected" detector as a safety net for an unlisted or unverified holiday | trading days only |
| M3 | Planner: per-chain source (stream / REST / nse-backup / refused) from the data account's policy and feed caps; feasibility table generated from code for every broker | refuses what it cannot carry, says what it can |
| M4 | Recorder REST budget: own sliding-window limiter at ≤ 50 % of every policy window, the "never take the last token" rule, short `maxWaitMs` so nothing ages past interactive work | ≤ 50 %, ≤ 200 ms delay |
| M5 | Stream source: internal hub clients, tick book, ATM re-centring, feed-health gating | stream-first |
| M6 | Snapshot builder: per-leg raw fields, per-chain spot, parity forward, ATM, straddle, rate, `T`, Black-76 IV/Δ/Γ through P1-3a's `pricing.js` on the vol-time clock (model `b76-vt1`, versioned) | S1 fields |
| M7 | Store: NDJSON day files, gzip roll, torn-line tolerance, retention, disk cap, range reads with field projection and cursor | restart-safe, retention 365 |
| M8 | Gaps written as gap records, never interpolated; `source`, `accountId`, `ts`, `quality`, `partial` on every snapshot | gaps are gaps |
| M9 | Daily S3 job at 15:31 IST, catch-up on start | S3 |
| M10 | OI-unit table for Dhan, Zerodha, Upstox and demo, normaliser conversion, contract test per broker fixture (OI is a multiple of lot size) | `oi` in units |
| M11 | REST routes + OpenAPI additions + MCP tool `get_option_snapshots` | `GET /v1/options/snapshots` |
| M12 | Bus topics `recorder.status`, `recorder.snapshot`; error code `CAPACITY_EXCEEDED` | status, P1-11 hook |
| M13 | Demo realism: time-varying OI, `bidQty`/`askQty`, ±45-strike chains, FINNIFTY and MIDCPNIFTY, five stock-option underlyings; demo recorder folder, "always open" clock, synthetic back-fill | every feature visible in demo |
| M14 | Dashboard: new page `#/recorder` (status panel + settings + feasibility); OI page reads windows from the server, `oi-store` becomes a cache | status panel; OI windows read from it |
| M15 | Docs: `docs/guides/recorder.md` (with generated feasibility table), ARCHITECTURE.md data layout and module map, STREAMS.md S17, `bridge.config.example.json`, CHANGELOG | §5.3 table filled |

### 2.2 LATER (not this round; each has an owner item)

- §5.4 step 3: back-fill today's intraday from `/v1/history` 1-minute candles with OI when the recorder starts mid-session (per-broker support unverified; P1-3 or Phase 2).
- Bhavcopy (S6) and VIX back-fill (P1-3).
- (Removed: the exchange calendar, rate and vol-time clock are consumed from P1-2a and P1-3a, which land first.) Snapshots still keep raw prices so IV can be recomputed if the model version changes.
- GEX, zero-gamma and exposure fields in S3 (P1-8; columns reserved as `null`).
- OI-unit verification for the other 38 adapters (they record with `oiUnitVerified: false` until done).
- Fix the cost under-count of adapter-built chains (Zerodha `fetchOptionChain` makes 1–2 quote calls but is scheduled as cost 1). Not hit by the recorder by default (see §9.3), but it affects user calls today.
- Per-key history-row quota (§7.8). This round caps page size instead.
- Hub-side account pinning (`subscribe(..., { accountId })`), recorder yielding feed room to users on `SUBSCRIPTION_LIMIT`, manual purge route, streaming `recorder.snapshot` to WebSocket clients (AsyncAPI change).
- Delta/columnar binary encoding to cut disk further.
- Commodity and currency sessions (Phase 3).

### 2.3 What our data cannot do (and the honest fallback)

| Limitation | Why | Fallback in this spec |
|---|---|---|
| Exchange holidays in P1-2's shipped list may be unverified or missing | The list is release-maintained (`verified: false` until checked) | `reference.calendar()` decides trading days; the detector (§6.13) catches a day the list missed. Suspect days are kept, flagged `quality: "suspect-holiday"`, and excluded from reads by default. |
| A quiet leg and a dead leg look the same on a stream | Feeds send ticks on change only | Every leg stores its own last-tick time; feed health (hub `stream.status`) decides gaps for the whole chain; the UI shows leg age. |
| REST recording on 1-request-per-second classes would break the 200 ms promise | One token per second: if the recorder takes it, a user call waits up to 1 s | Those classes are stream-only for the recorder (Dhan chain and quotes, Zerodha quotes, most unverified brokers). A user may opt in to `allowSingleTokenRest` with a stated "user calls may wait up to 1 s" warning. |
| The BRD §5.3 table says Upstox can carry all stocks by REST | Upstox's shared 2,000-per-30-minutes window caps the recorder at 1,000 / 30 min = 33 calls/min | The generated table says "indices + about 75 stocks at 5 min (more with the stream)", not "all stocks". |
| Dhan cannot REST-record even indices | Chain 1/s and 20/min (unverified), quotes 1/s | Stream only: 18 index chains fit in 60 % of the 5,000 feed cap; stocks need `streamShare` raised. |
| History before install cannot be recovered intraday | Nobody sells Indian intraday chains cheaply | Day 1 coverage starts at install; status says so. EOD back-fill is P1-3. |
| OI unit for 38 brokers is unverified | No fixture-backed check yet | Field `oiUnitVerified: false` on those snapshots and a status warning; numbers are not converted blindly. |
| The IV model may be revised later | Clock weights are stated assumptions (P1-3) | `model: "b76-vt1"` on every snapshot; raw bid/ask/ltp/forward/rate kept for recompute. |
| Max pain and PCR are over recorded strikes only (±40 / ±15) | Far strikes are not recorded | Labelled "over recorded strikes (±40)"; strike coverage shown. |

---

## 3. Architecture

### 3.1 Module map (new files)

```
server/bridge/recorder/
  module.mjs            defineModule({ name: "recorder", stream: "S17", configKey: "recorder", services: { recorder } })
  config.mjs            RECORDER_CONFIG_SCHEMA (zod) + parseRecorderConfig
  calendar.mjs          pure: slotsFor(session, everyMinutes), holiday detector (trading days and sessions come from deps.reference)
  plan.mjs              pure: planRecording(input) -> { chains, refused, capacity, budget, message }, feasibilityRow(broker)
  budget.mjs            createRecorderBudget({ policy, share, clock }) sliding windows at share of each policy window
  snapshot.mjs          pure: buildSnapshot(legs, ctx) -> Snapshot; atmOf; straddleOf (forward, IV, Δ, Γ via dashboard/pricing.js)
  daily.mjs             pure: dailyRow(lastSnap, prevDayLastSnap, futures) -> S3 row (PCR, max pain, largest OI from dashboard/oi-series.js)
  store.mjs             createSnapshotStore({ root, clock, logger }) append / roll / read / retention / usage
  streamSource.mjs      hub clients "recorder:<n>", tick book, re-centring, feed-health
  restSource.mjs        marketData.optionChain under budget, background priority, maxWaitMs 1500
  recorderService.mjs   orchestrator: timers, plan, slot loop, daily job, status, events
  demoBackfill.mjs      synthetic back-fill for demo mode only
  routes.mjs            REST handlers
  *.test.mjs            see §12
server/bridge/dashboard/oi-series.js  SHARED pure chain maths, created here with pcr(), maxPain(), largestOi(); P1-7 extends it (buckets, VWAP, build-up)
server/bridge/market/oiUnits.mjs   data-only table { brokerId: { chain, quotes, stream: "units"|"lots", verified, source } }
server/bridge/dashboard/recorder.js  #/recorder page
scripts/recorder-feasibility.mjs     prints the §5.3 table as Markdown from code
```

Changed files: `core/builtinModules.mjs` (+recorder after `scanner`), `core/eventBus.mjs` (TOPICS +2), `core/errors.mjs` (+`CAPACITY_EXCEEDED`, 422), `core/contracts.mjs` (SERVICE_CONTRACTS.recorder), `core/app.mjs` (DASHBOARD_FILES +`recorder.js`), `market/normalise.mjs` + `market/chain.mjs` (OI unit conversion), `demo/demoAdapter.mjs`, `demo/demoMode.mjs` (policy feed note only), `mcp/tools.mjs`, `dashboard/views.js` (page entry), `dashboard/oi-store.js`, `dashboard/oi.js`, `dashboard/format.test.mjs` (file list), `accounts/configFile.mjs` (+`setConfigSection`), docs listed in M15.

`USED_SERVICES = ["marketData", "streamHub", "accounts", "scheduler", "symbols", "reference", "backupData"]` (`vol/context.mjs` is a pure import, not a service call). A test asserts no file under `server/bridge/recorder/` imports from `orders/`, `paper/` or `safety/` (as the scanner does). The recorder can never place an order.

### 3.2 Process and schedulers

All timers use `deps.clock.setTimeout`/`clearTimeout` when present (manual clock in tests), else unref'd globals.

| Timer | When | What |
|---|---|---|
| Slot loop | Every minute boundary + `slotOffsetMs` (default 2,000 ms) IST | If the session is open: build stream snapshots for due chains; dispatch REST jobs for due chains spread over `restSpreadMs` (default 40,000 ms) |
| Re-plan | On start, on `PUT` config, on `account.status` / `stream.status` change for the data account, every 5 min in session | Recompute plan; re-centre stream subscriptions when ATM moved ≥ 2 strikes |
| Day roll | 15:40 IST, and on start for any earlier day not rolled | gzip yesterday's/today's `.ndjson` to `.ndjson.gz`, write `day.json` summary |
| Daily S3 | `dailyAt` (default 15:31 IST); retry at 15:45; on start, catch up any day with S1 but no S3 | §6.8–6.11 |
| Retention | 16:00 IST and on start | delete day folders older than `retentionDays`; enforce `maxDiskMb` |
| Status emit | On state change, at most 1/s | `recorder.status` bus event |

Due chains for slot `s` (minutes since 09:15 IST): index chains every slot; stock chains when `s % stockEveryMinutes === 0` (09:15, 09:20, …, 15:25). Full day = 375 index slots (09:15–15:29) and 75 stock slots.

CPU rule (§7.1 ≤ 2 s/min, never block the loop): each chain snapshot is built and serialised in its own `setImmediate` turn; gzip uses `zlib.createGzip` streams; reads parse line by line with a `readline` interface and yield every 50 lines.

### 3.3 Data model

#### Snapshot (one NDJSON line per chain per slot; columnar)

```json
{
  "v": 1,
  "kind": "snap",
  "u": "NIFTY", "x": "2026-11-03", "ex": "NFO",
  "slot": 1761731100000,
  "ts": 1761731101412,
  "source": "stream",
  "accountId": "dhan-main", "broker": "dhan",
  "accounts": null,
  "quality": "live",
  "partial": false, "missingLegs": 0,
  "oiUnit": "units", "oiUnitVerified": true,
  "lot": 75,
  "spot": 25150.35, "fwd": 25171.51, "atm": 25150, "straddle": 274.9,
  "rate": 0.065, "t": 0.013699, "tcal": 0.013699, "model": "b76-vt1",
  "k": [24750, 24800, "... 81 strikes"],
  "ce": { "ltp": [], "bid": [], "ask": [], "bq": [], "aq": [], "oi": [], "vol": [], "iv": [], "d": [], "g": [], "age": [] },
  "pe": { "...": "same keys" }
}
```

- Times are epoch ms (UTC); responses render IST ISO strings. `slot` is the minute the snapshot belongs to; `ts` is when its data was read (stream: build time; REST: the chain's `freshness.asOf`).
- `age[i]` = `slot − lastTickReceivedAt` in ms for stream legs, `slot − ts` for REST legs. Missing values are `null`, never 0.
- `iv` in percent (2 dp), `d` Δ wrt forward (4 dp), `g` Γ wrt forward (7 dp), prices 2 dp, `oi` and `vol` integers in **units**.
- `accounts` is `null` when one account supplied every leg, else `{ "<id>": legCount }` (only possible for same-holder pooled feeds).
- `quality`: `live` | `demo` | `demo-backfill` | `suspect-holiday`. `source`: `stream` | `rest` | `nse-backup` | `backfill`.

#### Gap record (same file, same slot granularity)

```json
{ "v": 1, "kind": "gap", "u": "NIFTY", "x": "2026-11-03", "slot": 1761731160000, "reason": "stream-down", "detail": "Dhan feed stale for 74 s" }
```

Reasons: `stream-down`, `budget`, `broker-error`, `session-expired`, `not-subscribed-yet`, `bridge-down` (written on restart for the missed slots between the last record and now, within today's session), `disk-full`, `paused`.

#### Underlying line (one per underlying per slot, file `_und.ndjson`)

```json
{ "v": 1, "kind": "und", "u": "NIFTY", "slot": 1761731100000, "spot": 25150.35, "fut": [ { "x": "2026-11-24", "ltp": 25248.1, "bid": 25247.9, "ask": 25248.4, "oi": 14812500, "vol": 2133000 }, { "x": "2026-12-29", "...": "" } ] }
```

#### S3 daily row (`s3/<UNDERLYING>/<YYYY>.ndjson`, one line per (date, expiry); rewritten atomically per year file)

```json
{ "v": 1, "date": "2026-10-29", "u": "NIFTY", "x": "2026-11-03", "asOfSlot": 1761731940000, "source": "recorder", "quality": "live",
  "spot": 25162.4, "fwd": 25181.0, "atm": 25200, "straddle": 268.2,
  "pcrOi": 0.933, "pcrVol": 1.081, "maxPain": 25100, "strikesCovered": 81,
  "largestCallOi": { "k": 25500, "oi": 9933750 }, "largestPutOi": { "k": 25000, "oi": 8211000 },
  "ceOi": 112500000, "peOi": 104962500,
  "topAdds": [ { "k": 25300, "r": "CE", "dOi": 1650000 } ], "topCuts": [ { "k": 25000, "r": "CE", "dOi": -742500 } ],
  "dOiBasis": "prev-recorded",
  "fut": { "x": "2026-11-24", "ltp": 25260.0, "oi": 14812500, "basis": 97.6, "basisAnnPct": 5.45, "rolloverPct": 18.4 },
  "slots": 375, "gapSlots": 0, "partialSlots": 0,
  "gex": null, "zeroGamma": null }
```

#### Status (in memory; persisted to `state.json` for restart)

`{ lastSlot, lastPlanHash, refused[], warnings[], holidaySuspected: { date, at } | null, demoBackfilledFor: "YYYY-MM-DD" | null }`.

### 3.4 Storage on disk

```
<dataDir>/recorder/                 (real data; mode 0700)
  state.json                        recorder state (atomic write)
  s1/YYYY-MM-DD/                    one folder per IST trading day
    NIFTY/2026-11-03.ndjson         today's open file (append-only)
    NIFTY/2026-11-03.ndjson.gz      after the day roll
    NIFTY/_und.ndjson(.gz)          spot and futures lines
    day.json                        { chains: { "NIFTY|2026-11-03": { snaps, gaps, partial, bytes } }, rolledAt, quality }
  s3/NIFTY/2026.ndjson              daily rows
<dataDir>/recorder-demo/            same layout; demo mode reads and writes ONLY here
```

- Append = one `fs.promises.appendFile(path, line + "\n")` per chain per slot (single write; a line is ≤ 40 KB). A torn last line (crash mid-write) fails `JSON.parse` and is skipped and counted (`corruptLines` in status); the next append starts on a new line because the writer first checks whether the file ends in `\n` on open and writes one if not.
- Day roll: write `.ndjson.gz.tmp` via gzip stream, `fsync`, rename to `.ndjson.gz`, verify by full gunzip-and-count, then delete `.ndjson`. Readers prefer `.gz`; if both exist the `.ndjson` is a leftover and is deleted at the next roll.
- A day folder that cannot be read (corrupt gzip, permission) is reported in status and skipped; it never stops recording or reading other days (§7.7).
- Retention deletes whole day folders older than `retentionDays` (IST date compare). If `maxDiskMb` is exceeded, the recorder stops writing (gap reason `disk-full`), keeps old data, and raises a warning; it never deletes inside retention on its own.
- Disk free from `fs.statfs(dataDir)` (Node ≥ 18.15), shown on the status panel.
- **Why not SQLite:** `package.json` allows Node ≥ 22.0 and `node:sqlite` is flag-free only from 22.13 and still experimental; ARCHITECTURE.md §2 commits to dependency-free JSON files. Compressed NDJSON meets the 800 ms full-day read target (§3.6).

### 3.5 Config (`recorder` section, all optional; zod `.strict()`)

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Indices recorded by default (BRD §5.3). `false` stops timers and unsubscribes. |
| `account` | `null` | `null` = the first connected account `accounts.marketDataCandidates({ capability: "optionChain" })` returns (config order), shown as "auto". Never more than one account; never another holder's. |
| `indices` | `["NIFTY","BANKNIFTY","FINNIFTY","MIDCPNIFTY","SENSEX","BANKEX"]` | Order = priority when capacity runs out. |
| `indexExpiries` | `3` | 1–4. Nearest first. |
| `indexStrikes` | `40` | Strikes each side of ATM (1–60). |
| `stocks` | `[]` | Opt-in underlyings (max 200). |
| `stockExpiries` | `1` | 1–2. |
| `stockStrikes` | `15` | 1–30. |
| `stockEveryMinutes` | `5` | 5, 10 or 15. |
| `sources.stream` | `true` | |
| `sources.rest` | `true` | |
| `sources.nseBackup` | `false` | Turning on needs `acknowledgeNseTerms: true` in the same write (§10). Ignored in demo. |
| `budgetShare` | `0.5` | 0.05–**0.5** (schema max). Fraction of every REST window the recorder may use. |
| `streamShare` | `0.6` | 0.1–0.9. Fraction of the data account's feed subscription cap the recorder may hold. |
| `strikeBuffer` | `2` | Extra strikes subscribed each side, only when feed room allows. |
| `allowSingleTokenRest` | `false` | Allow REST on classes with < 2 requests/s (breaks the 200 ms promise; warning shown). |
| `retentionDays` | `365` | 7–3650. Demo: fixed 3. |
| `maxDiskMb` | `10240` | Stop writing beyond this. |
| `recordSpecialSessions` | `true` | Records special sessions (Muhurat) that `reference.session()` reports with times set. Holidays and session times are **not** recorder config: they come from the `reference` section (P1-2). |
| `dailyAt` | `"15:31"` | S3 job time, IST. |
| `slotOffsetMs` | `2000` | |
| `restSpreadMs` | `40000` | REST jobs are spread over this part of the minute. |
| `demo.alwaysOpen` | `true` | Demo only: record all day; 1-min cadence 09:15–15:30 IST, 5-min outside. |
| `demo.backfillDays` | `2` | Demo only: previous weekdays synthesised at 5-min cadence. |

### 3.6 Read path and performance budget

`store.read({ u, x, fromMs, toMs, fields, strikesEach, everyMinutes, cursor, limit })`: list day folders in range → for each, stream `.ndjson.gz` (or `.ndjson`) lines → keep `kind` snap/gap in range → project fields → downsample (`every`: last snapshot in each bucket) → page. Past-day files are cached decompressed in an LRU (64 MB cap). Targets (measured in `store.test.mjs` on a generated 375-snapshot NIFTY day): full day, fields `oi,ltp,vol` ≤ 300 ms from `.gz` on CI hardware (BRD ≤ 800 ms), latest snapshot ≤ 20 ms (kept in memory per chain).

---

## 4. API

All routes: `x-stream: S17`, JSON `{ data, meta }` like S5; errors are the existing Problem shape. Demo mode labels responses as today (`meta.demo`). A key's account restriction does not hide recorded data (it is the owner's local store), but `accountId`/`accounts`/`broker` fields are returned as `null` unless the principal is local, the key has accounts `"*"`, or its list includes that account.

### 4.1 `GET /v1/options/snapshots` (scope `read`)

Query:

| Param | Required | Format | Default |
|---|---|---|---|
| `underlying` | yes | `^[A-Z0-9&-]{1,30}$` | |
| `expiry` | yes | `YYYY-MM-DD` | |
| `from` | no | IST date, IST date-time or epoch (same parser as `/v1/history`, `market/time.mjs parseTimeInput`) | today's session start |
| `to` | no | same | now |
| `fields` | no | comma list of `ltp,bid,ask,bidQty,askQty,oi,volume,iv,delta,gamma,age` | `ltp,oi,volume,iv` |
| `strikes` | no | 1–60, strikes each side of each snapshot's ATM | all recorded |
| `every` | no | `1,3,5,15,30,60` minutes | `1` |
| `includeSuspect` | no | boolean | `false` |
| `format` | no | `json`, `csv` | `json` |
| `limit` | no | 1–500 snapshots per page | `400` |
| `cursor` | no | opaque (base64url of `{slot, u, x}`) | |

Range limit: `to − from` ≤ 31 days per call (use the cursor within it).

200 response (`fields=oi,ltp`, trimmed):

```json
{
  "data": {
    "underlying": "NIFTY",
    "expiry": "2026-11-03",
    "exchange": "NFO",
    "units": { "oi": "units", "volume": "units", "iv": "percent", "price": "INR", "age": "ms" },
    "fields": ["oi", "ltp"],
    "snapshots": [
      {
        "slot": "2026-10-29T10:15:00.000+05:30",
        "ts": "2026-10-29T10:15:01.412+05:30",
        "source": "stream",
        "accountId": "dhan-main",
        "broker": "dhan",
        "accounts": null,
        "quality": "live",
        "partial": false,
        "missingLegs": 0,
        "oiUnitVerified": true,
        "lotSize": 75,
        "spot": 25150.35,
        "forward": 25171.51,
        "atm": 25150,
        "straddle": 274.9,
        "rate": 0.065,
        "t": 0.013699,
        "model": "b76-vt1",
        "strikes": [25100, 25150, 25200],
        "ce": { "oi": [6187500, 7353750, 8932500], "ltp": [184.2, 148.6, 117.35] },
        "pe": { "oi": [7008750, 6412500, 4038750], "ltp": [112.4, 126.3, 145.9] }
      }
    ],
    "gaps": [ { "from": "2026-10-29T10:41:00.000+05:30", "to": "2026-10-29T10:43:00.000+05:30", "slots": 3, "reason": "stream-down", "detail": "Dhan feed stale for 74 s" } ],
    "coverage": { "expectedSlots": 61, "recordedSlots": 58, "gapSlots": 3, "partialSlots": 0, "firstSlot": "2026-10-29T09:15:00.000+05:30", "lastSlot": "2026-10-29T10:15:00.000+05:30" },
    "unavailable": null,
    "method": {
      "forward": "Median over the 5 strikes nearest spot with two-sided quotes of K + e^(rT)(C_mid − P_mid).",
      "iv": "Black-76 on the forward from the mid (last price when one side is missing), dashboard/pricing.js, model b76-vt1.",
      "t": "Vol-time clock (P1-3; weighted by default). tcal is calendar time, used for discounting.",
      "rate": "reference.rate() (P1-2), with its source and age."
    },
    "nextCursor": null
  },
  "meta": { "requestId": "req_…", "accountId": null }
}
```

When nothing was ever recorded for the chain, the response is 200 with `snapshots: []`, `coverage` zeros and `unavailable: { "reason": "not-in-plan" | "not-recorded-yet" | "refused", "detail": "NIFTY 3 Nov is not in the recorder plan. Add it on the Data recorder page." }` (D5: honest unavailability, no 404 for scripts to special-case).

`format=csv`: one row per (slot, strike, right) with columns `slot,ts,source,quality,spot,forward,strike,right,<fields…>`; gaps as rows with `right=GAP` and the reason in the last column; header `X-MCB-Next-Cursor` when more pages exist. Filename `NIFTY_2026-11-03_snapshots.csv`.

Errors: 400 `VALIDATION_FAILED` (missing/invalid param, unknown field, `to < from`, range > 31 days, bad cursor), 401/403 as usual (`UNAUTHENTICATED`, `SCOPE_REQUIRED`), 429 `RATE_LIMITED` (client limiter).

### 4.2 `GET /v1/options/snapshots/latest` (scope `read`)

Query: `underlying`, `expiry` (required), `fields`, `strikes`. Response `{ data: { underlying, expiry, exchange, units, fields, snapshot: <one snapshot as above> }, meta }`. 404 `NOT_FOUND` "No snapshot has been recorded today for NIFTY 3 Nov." Served from memory (≤ 20 ms; BRD ≤ 100 ms).

### 4.3 `GET /v1/options/daily` (scope `read`)

Query: `underlying` (required), `from`/`to` (dates, default last 30 days, max 3 years), `expiry` (optional), `format=json|csv`. Response `{ data: { underlying, rows: [S3 row with ISO times and full names: pcrOi, pcrVolume, maxPain, largestCallOi{strike,oi}, …] }, meta }`. 400 on bad params.

### 4.4 `GET /v1/options/recorder` (scope `read`)

```json
{
  "data": {
    "state": "recording",
    "stateDetail": "Recording 18 index chains (18 by stream) and 0 stocks.",
    "demo": false,
    "account": { "id": "dhan-main", "broker": "dhan", "chosen": "config", "session": "connected", "feedAccount": "dhan-main", "costNote": "Dhan data APIs may need a paid plan (needs verification)." },
    "session": { "tradingDay": true, "open": true, "date": "2026-10-29", "start": "09:15", "end": "15:30", "calendarSource": "reference", "nextSlot": "2026-10-29T10:16:00.000+05:30" },
    "plan": {
      "chains": [ { "underlying": "NIFTY", "expiry": "2026-11-03", "kind": "index", "everyMinutes": 1, "strikesEachSide": 40, "source": "stream", "legs": 162 } ],
      "refused": [ { "underlying": "TATASTEEL", "expiry": "2026-11-24", "reason": "capacity", "detail": "Feed room left: 66 legs; this chain needs 62 plus 2 futures and spot." } ],
      "capacity": { "stream": { "cap": 3000, "used": 2934, "feedLimit": 5000, "share": 0.6 }, "rest": { "endpointClass": "chain", "allowed": false, "why": "Dhan option chain is 1 request/s: recording on it could delay your own chain requests by up to 1 s." } }
    },
    "budget": { "restCallsLastMinute": 0, "restCapPerMinute": 0, "brokerPerMinute": 20, "share": 0.5 },
    "today": { "snapshots": 1098, "legRows": 177876, "gapSlots": 3, "partialSnapshots": 0, "lastSnapshotAt": "2026-10-29T10:15:01.412+05:30", "corruptLines": 0 },
    "disk": { "bytes": 1238000000, "todayBytes": 18100000, "days": 31, "oldestDay": "2026-09-29", "retentionDays": 365, "maxBytes": 10737418240, "freeBytes": 182000000000 },
    "coverage": [ { "underlying": "NIFTY", "expiry": "2026-11-03", "source": "stream", "expectedSlots": 61, "recordedSlots": 58, "gapSlots": 3, "lastSlot": "2026-10-29T10:15:00.000+05:30", "lastAgeMs": 1412 } ],
    "sources": { "stream": true, "rest": true, "nseBackup": false },
    "oiUnits": { "verified": true, "broker": "dhan" },
    "warnings": []
  },
  "meta": { "requestId": "req_…" }
}
```

`state`: `recording` | `idle-closed` (outside session or non-trading day) | `paused` (`enabled:false`) | `not-configured` (no eligible account) | `degraded` (some chains refused or a source down) | `holiday-suspected` | `disk-full` | `error`.

### 4.5 `POST /v1/options/recorder/plan` (scope `read`; dry run, no side effects)

Body: any subset of the `recorder` config. Response `{ data: { ok, message, plan, budget, capacity }, meta }` where `message` is the plain sentence the UI shows, for example "This account can carry the 18 index chains by stream and 12 of the 40 stocks you asked for (Upstox REST budget: 33 calls/min for the recorder)." 400 on schema errors.

### 4.6 `PUT /v1/options/recorder/config` (scope `admin`)

Body: the `recorder` section to save (merged over the current file section). Server: validate (zod) → plan → if any requested chain is refused for capacity, **422 `CAPACITY_EXCEEDED`** with `{ canCarry: { indices: [...], stocks: [...] }, refused: [...] }` and nothing saved. If `sources.nseBackup` turns on without `acknowledgeNseTerms: true` → 422 `CONFIRMATION_REQUIRED`. Else write `bridge.config.json` via `setConfigSection(path, "recorder", value)` (serialised, atomic, schema-checked like accounts), apply live (re-plan, resubscribe) and return the new status with `persisted: true`. In demo mode the change applies **in memory only** and the response says `persisted: false` (demo never edits the config file).

A config file loaded at boot that the account cannot carry is **not** refused wholesale (that would lose a day): the feasible part records in priority order, the rest is listed in `plan.refused`, state is `degraded`.

### 4.7 MCP tool `get_option_snapshots` (read)

Inputs `underlying, expiry, from?, to?, fields? (default "oi,ltp"), strikes? (default 10), every? (default 5)`, max 80 snapshots returned (truncated flag), same fields and units as REST. Listed in `docs/guides/mcp.md`. Parity with Sheets: `format=csv` on the REST route.

### 4.8 OpenAPI additions (`docs/openapi.yaml`)

New tag and five paths, plus schemas. Paths go after `/v1/optionchain`.

```yaml
tags:
  - name: Options data
    description: Recorded option-chain snapshots (every minute in session), daily derived statistics and the recorder's status. Stored only on this computer.

  /v1/options/snapshots:
    get:
      tags: [Options data]
      operationId: getOptionSnapshots
      summary: Recorded option-chain snapshots for one expiry over a time range
      x-stream: S17
      x-scope: read
      parameters:
        - { name: underlying, in: query, required: true, schema: { type: string, maxLength: 30 } }
        - { name: expiry, in: query, required: true, schema: { type: string, format: date } }
        - { name: from, in: query, schema: { type: string }, description: "IST date, IST date-time or epoch seconds. Default: today's session start." }
        - { name: to, in: query, schema: { type: string }, description: "Default: now. At most 31 days after from." }
        - name: fields
          in: query
          description: Comma-separated leg fields.
          schema: { type: string, default: "ltp,oi,volume,iv", pattern: "^(ltp|bid|ask|bidQty|askQty|oi|volume|iv|delta|gamma|age)(,(ltp|bid|ask|bidQty|askQty|oi|volume|iv|delta|gamma|age))*$" }
        - { name: strikes, in: query, schema: { type: integer, minimum: 1, maximum: 60 } }
        - { name: every, in: query, schema: { type: integer, enum: [1, 3, 5, 15, 30, 60], default: 1 } }
        - { name: includeSuspect, in: query, schema: { type: boolean, default: false } }
        - { name: format, in: query, schema: { type: string, enum: [json, csv], default: json } }
        - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 500, default: 400 } }
        - { name: cursor, in: query, schema: { type: string, maxLength: 200 } }
      responses:
        "200":
          description: Snapshots, gaps and coverage (CSV when format=csv).
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { $ref: "#/components/schemas/OptionSnapshotPage" }
                  meta: { $ref: "#/components/schemas/Meta" }
            text/csv:
              schema: { type: string }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }

  /v1/options/snapshots/latest:
    get:
      tags: [Options data]
      operationId: getLatestOptionSnapshot
      summary: The most recent recorded snapshot of one chain
      x-stream: S17
      x-scope: read
      parameters:
        - { name: underlying, in: query, required: true, schema: { type: string, maxLength: 30 } }
        - { name: expiry, in: query, required: true, schema: { type: string, format: date } }
        - { name: fields, in: query, schema: { type: string } }
        - { name: strikes, in: query, schema: { type: integer, minimum: 1, maximum: 60 } }
      responses:
        "200":
          description: Latest snapshot.
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data:
                    type: object
                    required: [underlying, expiry, snapshot]
                    properties:
                      underlying: { type: string }
                      expiry: { type: string, format: date }
                      exchange: { type: string }
                      units: { $ref: "#/components/schemas/SnapshotUnits" }
                      fields: { type: array, items: { type: string } }
                      snapshot: { $ref: "#/components/schemas/OptionSnapshot" }
                  meta: { $ref: "#/components/schemas/Meta" }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }

  /v1/options/daily:
    get:
      tags: [Options data]
      operationId: getOptionDaily
      summary: Daily derived option statistics (PCR, max pain, walls, top OI changes, futures basis)
      x-stream: S17
      x-scope: read
      parameters:
        - { name: underlying, in: query, required: true, schema: { type: string, maxLength: 30 } }
        - { name: expiry, in: query, schema: { type: string, format: date } }
        - { name: from, in: query, schema: { type: string, format: date } }
        - { name: to, in: query, schema: { type: string, format: date } }
        - { name: format, in: query, schema: { type: string, enum: [json, csv], default: json } }
      responses:
        "200":
          description: Daily rows, oldest first.
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data:
                    type: object
                    required: [underlying, rows]
                    properties:
                      underlying: { type: string }
                      rows: { type: array, items: { $ref: "#/components/schemas/OptionDailyRow" } }
                  meta: { $ref: "#/components/schemas/Meta" }
            text/csv:
              schema: { type: string }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }

  /v1/options/recorder:
    get:
      tags: [Options data]
      operationId: getRecorderStatus
      summary: Recorder state, feeding account, plan, budget, coverage and disk use
      x-stream: S17
      x-scope: read
      responses:
        "200":
          description: Status.
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { $ref: "#/components/schemas/RecorderStatus" }
                  meta: { $ref: "#/components/schemas/Meta" }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }

  /v1/options/recorder/plan:
    post:
      tags: [Options data]
      operationId: planRecorder
      summary: Check what a recorder configuration would record on its data account (no changes made)
      x-stream: S17
      x-scope: read
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/RecorderConfig" }
      responses:
        "200":
          description: The plan and a plain-language verdict.
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { $ref: "#/components/schemas/RecorderPlanResult" }
                  meta: { $ref: "#/components/schemas/Meta" }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }

  /v1/options/recorder/config:
    put:
      tags: [Options data]
      operationId: setRecorderConfig
      summary: Save the recorder configuration (refused when the data account cannot carry it)
      x-stream: S17
      x-scope: admin
      requestBody:
        required: true
        content:
          application/json:
            schema:
              allOf:
                - { $ref: "#/components/schemas/RecorderConfig" }
                - type: object
                  properties:
                    acknowledgeNseTerms: { type: boolean, description: "Required true to turn on sources.nseBackup." }
      responses:
        "200":
          description: Saved and applied; the new status.
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data:
                    type: object
                    properties:
                      persisted: { type: boolean }
                      status: { $ref: "#/components/schemas/RecorderStatus" }
                  meta: { $ref: "#/components/schemas/Meta" }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }

components:
  schemas:
    SnapshotUnits:
      type: object
      properties:
        oi: { type: string, const: units }
        volume: { type: string, const: units }
        iv: { type: string, const: percent }
        price: { type: string, const: INR }
        age: { type: string, const: ms }
    SnapshotSide:
      type: object
      description: Arrays aligned to `strikes`; only the requested fields are present; null = no value.
      additionalProperties:
        type: array
        items: { type: [number, "null"] }
    OptionSnapshot:
      type: object
      required: [slot, ts, source, quality, partial, strikes, ce, pe]
      properties:
        slot: { type: string, format: date-time }
        ts: { type: string, format: date-time }
        source: { type: string, enum: [stream, rest, nse-backup, backfill], description: "Open enum." }
        accountId: { type: [string, "null"] }
        broker: { type: [string, "null"] }
        accounts: { type: [object, "null"], additionalProperties: { type: integer } }
        quality: { type: string, enum: [live, demo, demo-backfill, suspect-holiday], description: "Open enum." }
        partial: { type: boolean }
        missingLegs: { type: integer }
        oiUnitVerified: { type: boolean }
        lotSize: { type: [integer, "null"] }
        spot: { type: [number, "null"] }
        forward: { type: [number, "null"] }
        atm: { type: [number, "null"] }
        straddle: { type: [number, "null"] }
        rate: { type: [number, "null"], description: "Decimal." }
        t: { type: [number, "null"], description: "Years." }
        model: { type: string }
        strikes: { type: array, items: { type: number } }
        ce: { $ref: "#/components/schemas/SnapshotSide" }
        pe: { $ref: "#/components/schemas/SnapshotSide" }
    SnapshotGap:
      type: object
      required: [from, to, slots, reason]
      properties:
        from: { type: string, format: date-time }
        to: { type: string, format: date-time }
        slots: { type: integer }
        reason: { type: string, enum: [stream-down, budget, broker-error, session-expired, not-subscribed-yet, bridge-down, disk-full, paused], description: "Open enum." }
        detail: { type: [string, "null"] }
    OptionSnapshotPage:
      type: object
      required: [underlying, expiry, units, fields, snapshots, gaps, coverage]
      properties:
        underlying: { type: string }
        expiry: { type: string, format: date }
        exchange: { type: [string, "null"] }
        units: { $ref: "#/components/schemas/SnapshotUnits" }
        fields: { type: array, items: { type: string } }
        snapshots: { type: array, items: { $ref: "#/components/schemas/OptionSnapshot" } }
        gaps: { type: array, items: { $ref: "#/components/schemas/SnapshotGap" } }
        coverage:
          type: object
          properties:
            expectedSlots: { type: integer }
            recordedSlots: { type: integer }
            gapSlots: { type: integer }
            partialSlots: { type: integer }
            firstSlot: { type: [string, "null"], format: date-time }
            lastSlot: { type: [string, "null"], format: date-time }
        unavailable:
          type: [object, "null"]
          properties:
            reason: { type: string, enum: [not-in-plan, not-recorded-yet, refused] }
            detail: { type: string }
        method: { type: object, additionalProperties: { type: string } }
        nextCursor: { type: [string, "null"] }
    OptionDailyRow:
      type: object
      required: [date, underlying, expiry, quality]
      properties:
        date: { type: string, format: date }
        underlying: { type: string }
        expiry: { type: string, format: date }
        asOf: { type: string, format: date-time }
        source: { type: string }
        quality: { type: string }
        spot: { type: [number, "null"] }
        forward: { type: [number, "null"] }
        atm: { type: [number, "null"] }
        straddle: { type: [number, "null"] }
        pcrOi: { type: [number, "null"] }
        pcrVolume: { type: [number, "null"] }
        maxPain: { type: [number, "null"] }
        strikesCovered: { type: integer }
        largestCallOi: { type: [object, "null"], description: "Strike with the largest call OI (not P1-8's gamma Call Wall).", properties: { strike: { type: number }, oi: { type: integer } } }
        largestPutOi: { type: [object, "null"], description: "Strike with the largest put OI (not P1-8's gamma Put Wall).", properties: { strike: { type: number }, oi: { type: integer } } }
        ceOi: { type: [integer, "null"] }
        peOi: { type: [integer, "null"] }
        topAdds: { type: array, items: { type: object, properties: { strike: { type: number }, right: { type: string, enum: [CE, PE] }, dOi: { type: integer } } } }
        topCuts: { type: array, items: { type: object, properties: { strike: { type: number }, right: { type: string, enum: [CE, PE] }, dOi: { type: integer } } } }
        dOiBasis: { type: string, enum: [prev-recorded, broker-prev-close, none] }
        future: { type: [object, "null"], properties: { expiry: { type: string, format: date }, ltp: { type: number }, oi: { type: integer }, basis: { type: number }, basisAnnPct: { type: number }, rolloverPct: { type: [number, "null"] } } }
        slots: { type: integer }
        gapSlots: { type: integer }
        partialSlots: { type: integer }
        gex: { type: "null", description: "Reserved for P1-8." }
        zeroGamma: { type: "null", description: "Reserved for P1-8." }
    RecorderConfig:
      type: object
      additionalProperties: false
      properties:
        enabled: { type: boolean }
        account: { type: [string, "null"] }
        indices: { type: array, items: { type: string }, maxItems: 12 }
        indexExpiries: { type: integer, minimum: 1, maximum: 4 }
        indexStrikes: { type: integer, minimum: 1, maximum: 60 }
        stocks: { type: array, items: { type: string }, maxItems: 200 }
        stockExpiries: { type: integer, minimum: 1, maximum: 2 }
        stockStrikes: { type: integer, minimum: 1, maximum: 30 }
        stockEveryMinutes: { type: integer, enum: [5, 10, 15] }
        sources: { type: object, properties: { stream: { type: boolean }, rest: { type: boolean }, nseBackup: { type: boolean } } }
        budgetShare: { type: number, minimum: 0.05, maximum: 0.5 }
        streamShare: { type: number, minimum: 0.1, maximum: 0.9 }
        strikeBuffer: { type: integer, minimum: 0, maximum: 10 }
        allowSingleTokenRest: { type: boolean }
        retentionDays: { type: integer, minimum: 7, maximum: 3650 }
        maxDiskMb: { type: integer, minimum: 100 }
        recordSpecialSessions: { type: boolean }
        dailyAt: { type: string, pattern: "^\\d{2}:\\d{2}$" }
    RecorderPlanResult:
      type: object
      required: [ok, message, plan]
      properties:
        ok: { type: boolean }
        message: { type: string }
        plan: { type: object }
        budget: { type: object }
        capacity: { type: object }
    RecorderStatus:
      type: object
      required: [state, demo, session, plan, today, disk, coverage, sources, warnings]
      properties:
        state: { type: string, enum: [recording, idle-closed, paused, not-configured, degraded, holiday-suspected, disk-full, error], description: "Open enum." }
        stateDetail: { type: string }
        demo: { type: boolean }
        account: { type: [object, "null"] }
        session: { type: object }
        plan: { type: object }
        budget: { type: object }
        today: { type: object }
        disk: { type: object }
        coverage: { type: array, items: { type: object } }
        sources: { type: object }
        oiUnits: { type: object }
        warnings: { type: array, items: { type: string } }
```

`ERROR_CODES` gains `CAPACITY_EXCEEDED` (422); the Problem schema's code list in the spec is updated in the same commit (`openapi.test.mjs` checks route parity; `errors.test.mjs` checks the code table).

AsyncAPI: no change this round (bus topics are internal).

---

## 5. Rate-limit budget

### 5.1 Rules (enforced in `budget.mjs` and `plan.mjs`)

1. **Stream first.** Chains go to the stream while recorder subscriptions ≤ `floor(streamShare × feedCap)`, where `feedCap` = the hub's per-feed cap for the account that actually feeds (`min(stream.maxSubscriptionsPerUpstream, policy.feed.maxSubscriptions)`, else `FEED_LIMITS.maxSubscriptions` = 1,500). Per hub client the cap is `stream.maxSymbolsPerClient` (500) and per call `maxSymbolsPerRequest` (200), so the recorder uses clients `recorder:0..n` of ≤ 500 symbols and subscribes in chunks of 200. Stream legs cost no REST.
2. **The feed account must be the data account** (or the same holder when pooling is on). If `marketDataCandidates({ capability: "feed" })` does not include the data account, stream capacity is 0 and the status warns: "The live feed runs on dhan-main; the recorder's account upstox-x is used for REST only."
3. **REST at ≤ `budgetShare` of every window.** For the endpoint class used (`chain` for native chains; `quote` for built chains) the recorder limiter holds, for each policy window (per second, per minute, per day, `extraWindows`) and each group window that covers the class, a cap of `floor(share × limit)`.
4. **Never take the last token.** REST is allowed on a class only if every per-second window that covers it has `limit ≥ 2` (so after the recorder's at most `floor(L/2)` calls in any second, at least `ceil(L/2) ≥ 1` token is free for a user call). Otherwise REST is disabled for that class unless `allowSingleTokenRest` is true.
5. **No queue ageing past user work.** Each recorder call is sent with `priority: "background"` and `maxWaitMs: 1500` (the queue promotes a request one rank every 2,000 ms, `priorityQueue.mjs`), and only when `scheduler.headroom(account, class).remaining ≥ ceil(limit / 2)`. A refusal (`UPSTREAM_RATE_LIMITED`) writes a `budget` gap for that chain-slot; nothing retries within the slot.
6. **Free reads first.** REST jobs call `marketData.optionChain(…, { accountId, priority: "background", maxAgeMs: 20000 })`, so a chain a user loaded in the last 20 s is reused from the cache (cost 0, `freshness.source: "cache"`, recorded `source: "rest"` with its true `ts`).
7. **Throttle back-off.** On `limits.throttled` for the data account the recorder halves its REST cap for 10 minutes and logs a warning.

### 5.2 Worked budgets (default config: 6 indices × 3 expiries × ±40 = 18 chains × 162 legs = 2,916 legs, plus 6 spots and 12 futures = 2,934 stream symbols; stocks ±15 × 1 expiry = 62 legs + 1 future + 1 spot each)

| Account | Feed cap × 0.6 | REST class and 50 % cap | Result (generated by `plan.mjs`; shown on the page) |
|---|---|---|---|
| Dhan | 5,000 × 0.6 = **3,000** | chain 1/s (+20/min unverified), quotes 1/s → **REST off** (rule 4) | All 18 index chains by stream (2,934 symbols). Stocks: 0 (66 symbols left). With `streamShare: 0.9` (4,500): +1,566 → 24 stocks. |
| Zerodha | 3,000 × 0.6 = **1,800** | chain shares the quote group 1/s → **REST off** | 11 index chains by stream (11 × 162 + 18 = 1,800): all 6 nearest, then 2nd expiry of NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX. Refused: 7 chains. With `allowSingleTokenRest` (user accepts ≤ 1 s waits): 30 quote calls/min × 500 instruments covers the rest. |
| Upstox | 2,000 × 0.6 = **1,200** | shared "standard" 50/s, 500/min, 2,000/30 min → recorder 25/s, 250/min, **1,000/30 min ≈ 33/min** | 7 index chains by stream (7 × 162 + 18 = 1,152), 11 by REST (11 calls/min). Left: 22 calls/min → **110 stocks** at 5 min. |
| Fyers (no feed in adapter) | 0 | dataApis 5/s, 50/min → 2/s, **25/min** | 18 index chains by REST (18/min); 7/min left → 35 stocks. |
| Demo | 500 × 0.6 = **300** | chain 5/s; quoteFamily 10/s, 400/min → 2/s, **200/min** | 1 chain by stream (NIFTY nearest), 14 by REST; BANKEX refused ("not offered by this account"); 5 demo stocks by REST at 5 min. Both paths are exercised. |

The full table for all 41 adapters is generated by `scripts/recorder-feasibility.mjs` into `docs/guides/recorder.md`; `plan.test.mjs` asserts the doc table equals the generated output, so it cannot drift from `brokerPolicies.mjs`. Every row inherits the policy's `verified` flags and prints "(unverified)" beside unverified limits.

---

## 6. Formulas (pure functions, each with a reference-value test)

Notation: K strike, C/P call/put, mid = (bid + ask)/2 when both > 0, r rate (decimal), T years.

### 6.1 Slots
`slotOf(t) = floor((t − sessionStart) / 60000)`; expected slots by time `t` = `min(375, slotOf(t) + 1)` for indices, `floor(that / 5)` rounded up for stocks. Worked: at 10:15:30 IST, index expected slots = 61 (09:15 … 10:15).

### 6.2 Time to expiry
`t` = vol-time T and `tcal` = calendar T, both from P1-3a's clock (`vol/context.mjs` + `pricing.js`). This spec defines no clock of its own. The worked numbers in §6.3–6.5 use the clock's **calendar mode** (T = 5/365 = 0.013699 at Thu 29 Oct 2026 15:30 IST for the Tue 3 Nov 2026 expiry), so they stay hand-checkable; the tests run them through `pricing.js` with `mode: "calendar"`.

### 6.3 Parity forward
`F = median over the 5 strikes nearest spot that have two-sided quotes on both CE and PE of K + e^(rT)(C_mid − P_mid)`. Fewer than 3 such strikes → `F = null`; IV, Δ and Γ are then `null` for that snapshot (no fallback model) and it is marked `partial`. Worked (r = 0.065, T = 5/365, e^(rT) = 1.000891):

| K | C_mid − P_mid | K + e^(rT)(C−P) |
|---|---|---|
| 25,050 | 121.4 | 25,171.51 |
| 25,100 | 71.0 | 25,171.06 |
| 25,150 | 22.3 | 25,172.32 |
| 25,200 | −27.6 | 25,172.38 |
| 25,250 | −78.9 | 25,171.03 |

Median → **F = 25,171.51**.

### 6.4 ATM and straddle
`atm = strike nearest F` (lower on a tie; spot when F is null). `straddle = C_mid(atm) + P_mid(atm)` (LTP per side when a mid is missing; null if either side has neither). Worked: |25,150 − 25,171.51| = 21.51 < 28.49 → atm = 25,150; C_mid 148.6 + P_mid 126.3 = **274.9**.

### 6.5 Black-76 IV, Δ, Γ (model `b76-vt1`, computed by `pricing.js`; restated here only for the worked example)
`C = e^(−rT)[F N(d1) − K N(d2)]`, `P = e^(−rT)[K N(−d2) − F N(−d1)]`, `d1 = [ln(F/K) + σ²T/2] / (σ√T)`, `d2 = d1 − σ√T`. IV solves price = mid (LTP if a side is missing; `null` if the price is below discounted intrinsic or above the bound) by bisection on [0.0001, 5] to 1e−6 then one Newton step. `Δ_C = e^(−rT)N(d1)`, `Δ_P = −e^(−rT)N(−d1)`, `Γ = e^(−rT) n(d1) / (F σ √T)`. Worked (F 25,171.51, K 25,150, T 5/365, r 0.065): C_mid 148.6 → **IV 11.72 %**, P_mid 126.3 → **IV 11.65 %**; at σ = 11.72 %, d1 = 0.0692, **Δ_C = 0.5271, Δ_P = −0.4720, Γ = 0.001151**. Test tolerance: IV ± 0.01 vol pt, Δ ± 0.0005, Γ ± 1 %.

### 6.6 Partial snapshot
`missingLegs` = legs in the plan with no value for `ltp` and `oi`. `partial = missingLegs > 0.05 × plannedLegs` or `F === null`. Partial snapshots are kept and labelled; consumers decide.

### 6.7 Gaps
A due chain-slot with no snapshot written by `slot + 60 s` gets one gap record with the first failing reason. Consecutive gap slots are merged in responses (`from`, `to`, `slots`). Never interpolated.

### 6.8 PCR (S3 and intraday helper)
`pcrOi = Σ PE_oi / Σ CE_oi`, `pcrVol = Σ PE_vol / Σ CE_vol`, over strikes recorded in that snapshot (both sides non-null). Worked with the 5-strike table in 6.9: Σ PE = 415, Σ CE = 445 (× 1,000 units) → **pcrOi = 0.933**.

### 6.9 Max pain
`pain(S) = Σ_K [CE_oi(K) max(0, S − K) + PE_oi(K) max(0, K − S)]`; max pain = the recorded strike S minimising it (ties: nearer F). Worked (OI in thousands of units):

| K | CE OI | PE OI | pain(S = K) |
|---|---|---|---|
| 24,900 | 20 | 140 | 54,000 |
| 25,000 | 45 | 110 | 28,500 |
| 25,100 | 80 | 90 | **18,500** |
| 25,200 | 120 | 50 | 25,500 |
| 25,300 | 180 | 25 | 49,500 |

→ **max pain = 25,100**, labelled "over recorded strikes (±40)".

### 6.10 Walls and ΔOI
`largestCallOi` = strike with the largest CE OI; `largestPutOi` = largest PE OI (ties: nearer F). These are **not** called walls anywhere (API or UI): "Call Wall"/"Put Wall" are P1-8's gamma levels. Descriptive names only ("largest call OI"), never "resistance"/"support" in UI copy. `dOi(K, side) = oi_today_last − oi_prev_day_last` for the same contract from S1; if the previous day is not recorded, the broker's `oiChange` (`dOiBasis: "broker-prev-close"`), else `none`. `topAdds` = 5 largest positive, `topCuts` = 5 most negative.

### 6.11 Futures basis and rollover
`basis = Fut_ltp − spot`; `basisAnnPct = (Fut_ltp / spot − 1) × 365 / days_to_fut_expiry × 100`; `rolloverPct = OI_next / (OI_near + OI_next) × 100` (null when either is missing). Worked: Fut 25,260.0, spot 25,162.4, 26 days → basis 97.6, annualised (25,260.0/25,162.4 − 1) × 365/26 = 0.003879 × 14.04 = **5.45 %** (the §3.3 example row).

### 6.12 Disk estimate
Per 162-leg snapshot: 162 × 11 fields × ~7 bytes ≈ **12.5 KB** raw. 18 index chains × 375 slots ≈ **84 MB/day raw**; 40 stocks × 75 × 4.8 KB ≈ 14 MB. gzip on time-ordered numeric JSON ≈ 5× → **≈ 20 MB/day**, ≈ 5 GB/year at 250 days (BRD §5.2). `store.test.mjs` asserts ≤ 3 KB gzipped per 162-leg demo snapshot averaged over a day file.

### 6.13 Holiday detector (safety net behind P1-2's calendar)
After the 6th slot of a weekday (09:20), if for every recorded index chain the spot is identical across all 6 snapshots **and** total chain volume is 0 or equal to the previous trading day's final total, set `holiday-suspected`: stop recording for the day, re-mark today's lines `quality: "suspect-holiday"` (rewrite the day files once), notify via `recorder.status`. A user can clear it from the page (records resume next slot). A holiday in `reference.calendar()` (shipped or config) skips the day without detection.

---

## 7. Dashboard

### 7.1 New page `#/recorder` ("Data recorder", Overview group, after "Rate limits", icon `clock`)

New file `server/bridge/dashboard/recorder.js` (+ `DASHBOARD_FILES`, + `format.test.mjs` list, + entry in `views.js` PAGES). Data: `GET /v1/options/recorder` every 10 s while visible (no polling when the tab is hidden), `POST /v1/options/recorder/plan` debounced 400 ms on settings edits, `PUT /v1/options/recorder/config` on Save.

Panels (existing `card`/`table`/`meterRow`/`pill` components, shared tokens only):

1. **Status strip** (4 stat tiles): State (pill: Recording / Market closed / Paused / Holiday suspected / Not configured / Degraded / Disk full, with `stateDetail`), Feeding account (id, broker, "auto" or "chosen", session state, cost note), Today (snapshots, leg rows, gap minutes, last snapshot age), Disk (used, today, days kept, free).
2. **Coverage table**: Underlying · Expiry · Every · Source (stream/REST/NSE) · Strikes · Recorded / expected minutes · Gaps · Last (age). Row click opens a `sheetPopover` with that chain's gap list (from/to/reason) and a link "Open on OI page". Refused chains are listed below in the same table with the reason, greyed via the existing muted text token.
3. **Budget**: `meterRow` "Live feed: 2,934 of 3,000 (60 % of 5,000)"; `meterRow` "REST: 9 of 10 calls/min (50 % of 20)"; when REST is off for the class, a one-line reason ("Dhan option chain is 1 request/s: recording on it could delay your own chain requests").
4. **Settings** (local/admin only; read keys see it disabled with "Change these from this computer"): account select (eligible accounts + "Auto"), index checklist with expiry and strike count steppers, stock opt-in chips with instrument search (`/v1/instruments/search?kind=FUT&exchange=NFO`: an OPT search returns one row per strike, so a page holds one underlying's ladder; futures give a few rows per underlying and NFO keeps out MCX/CDS contracts), share sliders (`budgetShare` max 50 %, `streamShare`), retention days, NSE website backup switch (turning it on opens a `modal` with the terms warning and an "I understand" checkbox that sets `acknowledgeNseTerms`), Save. Above Save, the live plan verdict line from `/plan` ("This account can carry …"). A 422 `CAPACITY_EXCEEDED` shows `alertBox` with `canCarry` and a "Use what fits" button that trims the request.
5. **Which brokers can record what** (collapsed): the generated feasibility table, with the account in use highlighted.
6. Footer copy: "Recorded on this computer from your own broker account, for your personal use. Nothing is uploaded." Demo: the existing demo banner plus "Demo recordings are sample data and are kept for 3 days in a separate folder."

Responsive:
- **Phone (< 720 px)**: tiles 2 × 2; coverage table uses `table(..., { mobile: "stack" })` (each chain a stacked card: name, source pill, "58/61 min", gaps); settings open in a full-height sheet with a sticky Save bar; 44 px targets; no horizontal page scroll.
- **Tablet (720–1099 px)**: tiles in one row of 4 if ≥ 900 px else 2 × 2; coverage full width; budget and disk side by side.
- **Desktop (≥ 1100 px)**: tiles row; coverage (2/3) beside budget + disk (1/3); settings card full width below.

Keyboard: every control reachable; table rows are buttons (Enter opens the gap sheet). Live numbers `aria-live="off"`. Every meter has a text value (no colour-only meaning).

### 7.2 OI page (`oi.js`, `oi-store.js`)

- `oi-store.js`: add pure `fromServerSnapshot(s, underlying, expiry)` → the existing record shape `{ key, t, istDate, asOf, spot, lot, k, co, po, cl, pl, cv, pv, src: "server" }` and `serverBacked(key)` / `markServerBacked(key)`. `offer()` returns false for a server-backed key (no mixed series). IndexedDB schema unchanged (v1); 400-per-key cap still fits 375.
- `oi.js`: on chain load and every 60 s, if `GET /v1/options/recorder` (cached 60 s) lists the chain in its plan, fetch `/v1/options/snapshots?underlying&expiry&from=<last t + 1 or today 09:15>&fields=oi,ltp,volume` and `store.put` each record; mark the key server-backed. The window logic (`O.pickRef`) is unchanged.
- Text only (coordinate with `docs/design/oi.md`): timeline sub-title "From the snapshots this page records" becomes "Recorded by the Bridge every minute" when server-backed; `coverageEl` reads "Server recording since 09:15 · 58 of 61 minutes · 3 missing (feed down 10:41–10:43)". When not in the plan: "The recorder is not recording NIFTY 3 Nov, so windows use what this page records while open. Data recorder →" (link to `#/recorder`).
- No visual changes; no new CSS beyond what the restyle team ships.

---

## 8. Demo mode

Goal: with `mc-bridge start --demo`, every recorder feature is visible within a minute, without a broker and without touching real data.

Changes to `server/bridge/demo/demoAdapter.mjs`:
1. **Time-varying OI.** `openInterest(u, spot, strike, right, expiry, t)` = `prevOi × (1 + a × s(t) + 0.03 sin(2π·min/47 + φ))`, where `prevOi` is today's formula at the previous close, `a ∈ [−0.15, +0.35]` per (strike, right, expiry) from `unit()` and biased so OTM calls build when the slow wave falls and OTM puts build when it rises, and `s(t)` = fraction of the demo day elapsed (09:15–15:30 IST; in "always open", the IST calendar day). Deterministic: the same instant gives the same OI. `previous_oi` and `oi_chg` in `fetchOptionChain` come from the same function at the previous close, so "Prev close" and recorded windows agree. OI stays a multiple of the lot (units).
2. **Depth sizes.** `quoteOf` returns `bidQty`/`askQty` (lots × lot size, deterministic per 5 s) so S1 has them.
3. **Chain width.** `fetchOptionChain` returns ±45 strikes (new `CHAIN_STRIKES_EACH_SIDE = 45`; instruments stay ±60). `demo.test.mjs` 61 → 91.
4. **More underlyings.** Add FINNIFTY (step 50, lot 60, monthly-tue) and MIDCPNIFTY (step 25, lot 120, monthly-tue) indices; give RELIANCE, HDFCBANK, ICICIBANK, INFY, SBIN `deriv: "NFO"`, monthly-tue options (steps 20/10/10/20/5, lots from P1-2's demo lot table `DEMO_STOCK_LOT` in `reference/demoReference.mjs`, so masters and reference agree; P1-6 later extends options to all 50 demo stocks with the same table), `instrumentType` `OPTSTK`/`FUTSTK`. BANKEX stays absent so the "not offered by this account" refusal is visible.

Recorder in demo:
- Root `<dataDir>/recorder-demo/`; `quality: "demo"`; retention fixed at 3 days; config writes are in-memory only (`persisted: false`).
- `demo.alwaysOpen`: the calendar treats every day as a trading day; 1-minute slots 09:15–15:30 IST, 5-minute slots outside it, so the recorder visibly works at any hour. Status shows "Demo clock: always open".
- **Synthetic back-fill** (`demoBackfill.mjs`, runs once per day on start, chunked with `setImmediate`, ≤ 3 s CPU total): today's slots from 09:15 IST (or the day start in always-open) up to now at 1-min for the nearest expiry of each index, and the previous `backfillDays` weekdays at 5-min for all planned chains, all from the adapter's pure functions (`quoteOf` at each slot time), `source: "backfill"`, `quality: "demo-backfill"`; then S3 rows for those days. So the OI page's 5m…1h windows, "since open" and `/v1/options/daily` work immediately.
- Plan in demo exercises both paths (1 chain stream, 14 REST, BANKEX refused, 5 stocks REST at 5 min).

---

## 9. Safety, compliance and honesty gates

| Gate | Where | Test |
|---|---|---|
| Recorder cannot reach orders/paper/safety | `USED_SERVICES`; import check | `module.test.mjs` greps imports |
| ≤ 50 % of every REST window | `budget.mjs` | `budget.test.mjs` (property test over 10,000 random call times) |
| User chain request delayed ≤ 200 ms by recorder traffic | rules 4–5 in §5.1 | `priority.test.mjs` (§12) |
| One data account; never pooled across holders | REST pinned to `accountId`; stream via `marketDataCandidates` (single holder) | `recorderService.test.mjs` with two holders |
| NSE website backup off by default; explicit opt-in with warning | config default; 422 `CONFIRMATION_REQUIRED` without `acknowledgeNseTerms` | `routes.test.mjs` |
| Data stays local; no pooling; exports to the caller only | store under `dataDir`; no outbound calls from the recorder except through `marketData`/`backupData` | `module.test.mjs` asserts no `fetch` import |
| No secrets in recorder files or logs | snapshots hold ids only | `store.test.mjs` scans written files for the fake creds' token values |
| Demo never mixes with real data | separate root; real mode never reads `recorder-demo` | `demo.test.mjs` |
| Gaps never filled | §6.7 | `snapshot.test.mjs`, `store.test.mjs` |
| Neutral copy | "largest call OI", PCR without bullish/bearish words | `recorder.test.mjs` (dashboard) greps copy for "support", "resistance", "bullish", "bearish", "buy", "sell" |
| Disclaimers | footer copy §7.1; OI page keeps "Shows position activity, not guaranteed direction." | snapshot in `recorder.test.mjs` |
| Algo framework | Not applicable: reads only, no orders | n/a |
| Data/API cost | status `costNote` per broker from `docs/guides/recorder.md` §costs; docs say recording stocks may need a paid data plan | doc review |
| Account ids hidden from restricted keys | §4 redaction rule | `routes.test.mjs` |

---

## 10. OI unit rule (M10)

`server/bridge/market/oiUnits.mjs`:

```js
export const OI_UNITS = Object.freeze({
  demo:    { chain: "units", quotes: "units", stream: "units", verified: true,  source: "server/bridge/demo/demoAdapter.mjs" },
  dhan:    { chain: "units", quotes: "units", stream: "units", verified: false, source: "https://dhanhq.co/docs/v2/option-chain/" },
  zerodha: { chain: "units", quotes: "units", stream: "units", verified: false, source: "https://kite.trade/docs/connect/v3/market-quotes/" },
  upstox:  { chain: "units", quotes: "units", stream: "units", verified: false, source: "https://upstox.com/developer/api-documentation/" },
});
```

- The three entries start `verified: false`; task T3 reads each broker's docs and fixture and flips them to `true` only when **both** the docs say units and the fixture passes the multiple-of-lot check. If a broker sends lots, set `"lots"` and `normalise.mjs` multiplies by the leg's `lotSize` (from `chainMeta` / instrument master); if the lot size is unknown the OI becomes `null` (never a guess).
- Contract test `server/bridge/market/oiUnits.contract.test.mjs`: for dhan, zerodha, upstox fixtures (and the demo adapter), every normalised leg with `oi !== null` and a known lot size has `oi % lotSize === 0` (allowing a documented exception list for lot-revision transition contracts). Adapters missing from the table: snapshots carry `oiUnitVerified: false` and the status page warns.

---

## 11. Migration and back-compat

- Additive only: new routes, new optional config section, new topics, new error code, new optional MCP tool. No `/v1` field changes; `ChainLeg` is untouched (P1-4 adds `bidQty`/`askQty`/`ts` there).
- **Behaviour change on upgrade:** the recorder starts by default for indices. It holds up to 60 % of the feed's subscriptions. Together with P1-11 alerts (at most 15 %, counted only for symbols the recorder does not already hold) background work holds at most 75 %, so users keep ≥ 25 % in the worst case (1,250 on Dhan, 750 on Zerodha, 500 on Upstox) and ≥ 40 % while alerts are unused and at most 50 % of REST windows. CHANGELOG entry, a one-time Home notice ("The Bridge now records option chains for history. Data recorder →"), and `"recorder": { "enabled": false }` to opt out.
- `oi-store.js` stays and keeps working when the recorder is off, paused or not covering a chain; its IndexedDB data is not migrated (3-day local history is simply superseded by server data where present).
- Config schema: unknown keys in `recorder` are errors (consistent with ARCHITECTURE §14).
- `/v1/optionchain` and the dashboard's 3 s polling are unchanged (P1-4 replaces polling).
- Rollback: removing the module leaves `<dataDir>/recorder/` on disk; nothing else depends on it.

---

## 12. Test plan

Unit (vitest, manual clock from `ratelimit/fake.mjs`, no network):

| File | Covers |
|---|---|
| `server/bridge/dashboard/oi-series.test.mjs` | `pcr`, `maxPain`, `largestOi` reference values (§6.8–6.10); P1-7 adds its own cases to this file |
| `server/bridge/recorder/calendar.test.mjs` | slots 375/75 from a `reference` fake (weekend, holiday, Muhurat window), IST on a UTC host, holiday detector true/false cases |
| `server/bridge/recorder/plan.test.mjs` | §5.2 rows for Dhan, Zerodha, Upstox, Fyers, demo exactly; rule 4 (1/s classes off; `allowSingleTokenRest` on); feed-account ≠ data-account → REST only; priority order; `CAPACITY_EXCEEDED` payload; doc table equals `scripts/recorder-feasibility.mjs` output |
| `server/bridge/recorder/budget.test.mjs` | caps at `floor(share × limit)` for second/minute/day/extra/group windows; property test: over 10,000 random schedules the recorder never exceeds any cap and never leaves < 1 token in a per-second window |
| `server/bridge/recorder/snapshot.test.mjs` | §6.3 forward example, < 3 two-sided strikes → null and partial; §6.4 ATM tie rule and straddle; missing legs stay null; `age` values; columnar layout; field projection |
| `server/bridge/recorder/daily.test.mjs` | §6.8 PCR 0.933; §6.9 max pain 25,100; walls ties; ΔOI with and without previous day; §6.11 basis 97.6 and 5.45 % |
| `server/bridge/recorder/store.test.mjs` | append + read range; torn last line skipped and counted; next append starts on a new line; gzip roll atomicity (kill between rename and delete); corrupt `.gz` day skipped while other days read; retention by IST date; `maxDiskMb` stops writes; cursor paging stable; `every=5` downsample; full-day read ≤ 300 ms; ≤ 3 KB gz per 162-leg demo snapshot; no secret strings in files |
| `server/bridge/recorder/recorderService.test.mjs` | with fake hub + fake marketData + manual clock: writes every minute 09:15–15:29 and stops at 15:30; weekend and config holiday write nothing; stream-down → `stream-down` gaps; REST refusal → `budget` gaps; session expiry → `session-expired` gaps and recovery; restart mid-session resumes at the next slot (≤ 60 s) and writes `bridge-down` gaps for the missed slots; ATM re-centring subscribes new strikes before unsubscribing old; two holders → only the data account's holder used; `recorder.snapshot` and `recorder.status` emitted |
| `server/bridge/recorder/priority.test.mjs` | **the 200 ms criterion**: real `createScheduler` + manual clock + fake broker policy `chain: 4/s, 120/min`; the recorder saturates its budget for 10 simulated minutes; 200 user `optionChain` calls at `interactive` priority at random instants each start within 200 ms of being asked; repeat with policy `1/s` and assert the planner put zero chains on REST |
| `server/bridge/recorder/routes.test.mjs` | every route's validation errors; scopes (`read` vs `admin`); CSV shape and cursor header; `unavailable` reasons; `CAPACITY_EXCEEDED`; `CONFIRMATION_REQUIRED` for NSE backup; account-id redaction for restricted keys; demo `persisted: false` |
| `server/bridge/recorder/module.test.mjs` | no imports from orders/paper/safety; no direct `fetch`; config schema defaults; `budgetShare > 0.5` rejected |
| `server/bridge/market/oiUnits.contract.test.mjs` | §10 per-broker fixture check |
| `server/bridge/demo/demo.test.mjs` (update) | 91 strikes; OI changes between 10:00 and 14:00 and is a multiple of the lot; `previous_oi` = formula at previous close; `bidQty`/`askQty` present; FINNIFTY/MIDCPNIFTY/stock options listed; demo recorder root separate |
| `server/bridge/dashboard/recorder.test.mjs` | pure view-model: state → pill text, coverage rows, plan verdict text, neutral-copy grep, phone stacking flag |
| `server/bridge/dashboard/oi-store.test.mjs` (update) | `fromServerSnapshot` mapping; server-backed key blocks `offer()`; merge without duplicate `t` |

Contract:
- `core/openapi.test.mjs` passes with the five new paths (scope, stream S17) and `CAPACITY_EXCEEDED` in the code table.
- `mcp/tools.test.mjs`: `get_option_snapshots` schema and output units match REST.
- OI-unit contract test above.

End-to-end (`server/bridge/e2e/recorder.e2e.test.mjs`, `bootBridge` with `shiftedClock` starting at Mon 19 Oct 2026 10:00:58 IST and a stub broker with a chain endpoint and feed):
1. Within 5 s real time a snapshot for every planned chain exists on disk and via `GET /v1/options/snapshots` with `source`, `accountId`, `ts`.
2. `GET /v1/options/recorder` shows state `recording`, coverage, disk bytes > 0.
3. Stop the app; boot again with the clock at 10:03:58; the 10:01–10:03 missed slots appear as `bridge-down` gaps and a new snapshot is written at 10:04 (resume ≤ 1 min).
4. `PUT /v1/options/recorder/config` with 300 stocks on a 1/s stub → 422 `CAPACITY_EXCEEDED` with `canCarry`; file unchanged.
5. Demo e2e (`--demo` config): within 5 s `/v1/options/snapshots` for NIFTY nearest expiry returns back-filled minutes since 09:15 and `quality: "demo-backfill"`/`"demo"`; `/v1/options/daily` has rows for 2 previous weekdays.

Manual check (documented in the PR): `mc-bridge start --demo`, open `#/recorder` at 360 px, 800 px and 1280 px; open `#/oi`, switch to 15m and Since open; confirm the timeline note says "Recorded by the Bridge".

---

## 13. Ordered task list

Each task is small and lands with its tests green. T1–T16 are one engineer's working session sequence; stop points are after T6 (store and maths complete), T11 (server complete) and T16.

| # | Task | Files | Done when |
|---|---|---|---|
| T1 | Shared chain maths: `pcr`, `maxPain`, `largestOi` (P1-7 extends this file) | `dashboard/oi-series.js`, `oi-series.test.mjs`, `DASHBOARD_FILES` | §6.8–6.10 examples pass; §6.5 example passes through `pricing.js` (calendar mode) |
| T2 | Slots over `reference.session()` + holiday detector | `recorder/calendar.mjs`, `.test.mjs` | calendar tests pass |
| T3 | OI-unit table, normaliser conversion, contract test; research Dhan/Zerodha/Upstox docs and set `verified` honestly | `market/oiUnits.mjs`, `market/normalise.mjs`, `market/chain.mjs`, `market/oiUnits.contract.test.mjs` | contract test passes; any unverified broker stays `false` |
| T4 | Snapshot builder (forward, ATM, straddle, IV, partial, columnar) | `recorder/snapshot.mjs`, `.test.mjs` | §6.3/6.4 examples pass |
| T5 | Daily S3 maths | `recorder/daily.mjs`, `.test.mjs` | §6.8–6.11 examples pass |
| T6 | Store (append, roll, read, project, cursor, retention, disk cap, usage) | `recorder/store.mjs`, `.test.mjs` | store tests incl. perf and size pass |
| T7 | Config schema + core additions (TOPICS, `CAPACITY_EXCEEDED`, SERVICE_CONTRACTS.recorder, builtinModules, `setConfigSection`) | `recorder/config.mjs`, `core/*`, `accounts/configFile.mjs` | existing core tests green |
| T8 | Budget limiter | `recorder/budget.mjs`, `.test.mjs` | property test passes |
| T9 | Planner + feasibility script + generated table | `recorder/plan.mjs`, `scripts/recorder-feasibility.mjs`, `plan.test.mjs`, `docs/guides/recorder.md` | §5.2 rows asserted; doc matches |
| T10 | Stream and REST sources | `recorder/streamSource.mjs`, `recorder/restSource.mjs` | covered by T11 tests |
| T11 | Recorder service + module + priority test | `recorder/recorderService.mjs`, `recorder/module.mjs`, `recorderService.test.mjs`, `priority.test.mjs`, `module.test.mjs` | 200 ms test passes; restart resume passes |
| T12 | Routes + OpenAPI + MCP tool | `recorder/routes.mjs`, `routes.test.mjs`, `docs/openapi.yaml`, `mcp/tools.mjs` | `openapi.test.mjs`, route and MCP tests pass |
| T13 | Demo realism + demo recorder + back-fill | `demo/demoAdapter.mjs`, `recorder/demoBackfill.mjs`, `demo/demo.test.mjs` | demo tests pass; `--demo` shows data at once |
| T14 | `#/recorder` page | `dashboard/recorder.js`, `views.js`, `core/app.mjs`, `format.test.mjs`, `dashboard/recorder.test.mjs` | page works at 360/800/1280 px in demo |
| T15 | OI page reads server snapshots; `oi-store` cache | `dashboard/oi-store.js`, `dashboard/oi.js`, `oi-store.test.mjs` | windows fill from server in demo |
| T16 | E2E + docs (ARCHITECTURE data layout and S17, STREAMS S17, example config, CHANGELOG, mcp guide) | `e2e/recorder.e2e.test.mjs`, docs | full `npm test` green; `npm run typecheck` clean |

---

## 14. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Broker feed caps or chain limits in `brokerPolicies.mjs` are wrong (many `verified: false`) | Medium | High | Planner reads only the policy table; unverified figures fall back to conservative defaults; throttle back-off halves the cap; status shows "(unverified)". |
| Default-on recording takes feed room users relied on | Medium | Medium | 60 % share cap, opt-out, CHANGELOG and Home notice; LATER: yield on user `SUBSCRIPTION_LIMIT`. |
| OI units wrong for a broker → every OI series wrong by a lot factor | Medium | High | Multiple-of-lot contract test; `oiUnitVerified` flag; no blind conversion. |
| An unlisted or unverified holiday is recorded as a flat day | Low | Low | P1-2 calendar + detector + `suspect-holiday` exclusion. |
| Clock weights are revised later | Medium | Low | Versioned `model`; raw prices kept for recompute. |
| Disk growth on small machines | Medium | Medium | ≈ 20 MB/day estimate, retention, `maxDiskMb`, free-space readout. |
| Zerodha/Dhan users get only partial index coverage | High | Medium | Honest refused list, `streamShare` up to 0.9, `allowSingleTokenRest` opt-in with warning. |
| Adapter-built chains under-count upstream calls (Zerodha) | Medium | Medium | Recorder does not REST on those classes by default; LATER cost fix in `marketDataService`. |
| Event-loop stalls from gzip or IV loops | Low | Medium | Per-chain `setImmediate`, streaming gzip, CPU test budget ≤ 2 s/min. |
| Conflict with the dashboard restyle | Medium | Low | No CSS or visual spec; new page uses existing components; two text-only edits in `oi.js` coordinated with `docs/design/oi.md`. |
