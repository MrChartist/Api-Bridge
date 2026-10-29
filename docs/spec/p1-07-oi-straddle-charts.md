# Spec P1-7: Live OI and straddle charts pack (D2, D3, D4, D5, A9)

Status: ready to build once P1-1 has landed · Owner: tech lead, Options desk · Date: 29 Oct 2026 · Stream: the **recorder stream, S17** (final id from the stream table in `docs/spec/README.md`). Dashboard work is in the files listed in §3.1.
Builds on: BRD `docs/brd/options-platform.md` §3.A (A9), §3.D (D2, D3, D4, D5), §5.1–5.5 (data strategy, store S1/S3), §6.1 P1-7 (acceptance criteria), §7.1–7.8 (NFRs, API contract), §8 (compliance), §10.1 (chart policy).

**Hard dependency: P1-1** (`docs/spec/p1-01-recorder.md`). This item uses its S1 snapshot store, its S3 daily rows (`GET /v1/options/daily`), its recorder status (`GET /v1/options/recorder`), its demo realism (time-varying OI, `bidQty`/`askQty`, the `recorder-demo` folder and its synthetic back-fill) and its `recorder.snapshot` bus topic. Nothing here works without it. Build against P1-1's `store.mjs` and a fixture day file if P1-1 is still in review.

Soft dependencies (each has an interim behaviour here):
- **P1-3** pricing core (lands earlier, build order in `docs/spec/README.md`): straddle IV (A9) calls one seam, `straddleContext(chain, now)` (§5.10), which reads `pricing.js` (parity forward, vol-time clock) and `reference.rate()`. `ts-chart.js` is created by P1-3c; this item extends it.
- **P1-2** reference data (lands earlier): "previous trading day" and holidays from `reference.calendar()`.
- **P1-4** streaming chain: the A9 straddle view redraws on every chain update, whether that comes from 3 s polling today or from stream patches later. No change is needed either way.
- **P1-6** stocks: stock chains appear on the charts page once they are recorded (5-minute cadence; §2.3).

Consumers: P1-11 alerts (straddle premium, ΔOI over a window and PCR-cross conditions read the same series functions), Phase 2 replay (I2), the owner's chart engine (it plugs into `chartSlot` and reads `series()`).

Not in this spec: visual styling. Another team is restyling the dashboard (near-black theme, colour tokens, motion). Everything below uses existing components (`card`, `table`, `segmented`, `pill`, `alertBox`, `emptyState`, `loadingState`, `chartSlot`, `sheetPopover`, `modal` from `app.js`; `svgEl`, `legend`, `scrubber`, `heatCell` from `viz.js`), the existing build-up classes `.obu-*`, and the shared data-viz tokens (`data-dv="call|put|spot|pos|neg|today|…"`). It adds no colours, no sizes beyond layout rules and no motion. The restyle team owns the final look.

> **Build order and shared foundations.** This spec is steps 15–16 (P1-7a server T1–T8, P1-7b dashboard T9–T15) in `docs/spec/README.md`, after P1-1b, P1-3c. It uses, and does not rebuild, the F0 foundations listed there: final stream ids, bus topics and error codes pre-registered in core, the opt-in `options` MCP toolset (every MCP tool in this spec goes there), `demo/routes.mjs` plus the OpenAPI demo-only list, `server/lib/jsonl.mjs` (append, torn-line tolerance, last-wins, quarantine of corrupt files), `ratelimit/backgroundGate.mjs` (the one ≤ 50 % background-budget check), `core/ownership.mjs`, and `dashboard/copyRules.mjs` (the one banned-word list). Where this text and README disagree, README's build order and shared-module owners win.

---

## 1. Summary

The OI page today records snapshots only while it is open in a browser, and it shows "now versus a window", never a picture over time. After this item, a trader can see the day's story from the server recorder (P1-1) with the browser closed, minute by minute:

1. **Strike OI over time (D2):** up to 10 strikes, a strike range or a band around ATM. Shows CE and PE OI, ΔOI and premium at 1-minute resolution, with the interval selector `1m · 5m · 15m · 30m · 1h · Since open · vs Prev close`.
2. **Straddles and strangles over time (D4):** up to 6 pairs, including a **rolling-ATM straddle** and rolling strangles, each with an approximate **VWAP** line.
3. **PCR and max pain timelines (D3):** PCR (OI and volume) and max pain intraday, plus daily history from S3.
4. **Build-up timeline (D5):** each strike, and the near future, classed per interval (long build-up, short build-up, short covering, long unwinding, churn) in a strike × time strip.
5. **Straddle chain (A9):** a "Straddles" view on the Option Chain page. One row per strike shows the straddle price, its change, the straddle IV and the breakevens.

All maths is in one pure, import-free file shared by the server and the browser (`dashboard/oi-series.js`), so the API and the page always show the same numbers. The server exposes five read routes under `/v1/options/series/*` (JSON and CSV) and one MCP tool. The dashboard gets a new **Live charts** page (`#/charts`). Its panels are purpose-built SVG small multiples plus a data table and CSV export, with a `chartSlot` kept for the owner's engine. The OI page's timeline panel also reads the server series. These panels make zero broker calls: they read what the recorder already wrote. Demo mode adds a realistic intraday volume profile, deterministic "day stories" for OI and 20 days of daily history, so every panel can be seen and tested without a broker.

---

## 2. Scope

### 2.1 MUST (this round)

| # | Item | BRD P1-7 acceptance hook |
|---|---|---|
| M1 | `dashboard/oi-series.js`: shared pure maths (buckets, ΔOI per interval, strike sets, rolling ATM with hysteresis, straddle/strangle, VWAP, PCR, max pain, build-up per interval, downsampling). `options.js` re-exports `classifyBuildup` and `BUILDUP_DEFAULTS` from it | one maths for page and API |
| M2 | Derived line per chain per minute (`*.drv.ndjson`: totals, PCR, max pain, largest OI, ATM, straddle), written by the recorder beside each snapshot and back-filled on read for older days | PCR/max pain intraday; ≤ 800 ms |
| M3 | Store extensions in P1-1's `store.mjs`: absolute strike-set projection and tail reads of today's file | ≤ 800 ms |
| M4 | `seriesService` (`recorder/series/`): a day-column cache, read paths for OI, straddle, PCR and build-up, "vs prev close" baselines (§5.2) | all four series |
| M5 | Routes `GET /v1/options/series/{catalog,oi,straddle,pcr,buildup}` (scope `read`, JSON + CSV), OpenAPI, MCP tool `get_option_series` | K5/K7 cross-cutting |
| M6 | Multi-strike OI / ΔOI / premium: up to 10 strikes, a strike range (≤ 81 strikes) or ±n around a rolling ATM; interval `1m,5m,15m,30m,1h,open,prev` | criterion 1 |
| M7 | Up to 6 straddle/strangle pairs: fixed strikes, rolling ATM straddle, rolling ATM±n strangle; VWAP per pair | criterion 2 |
| M8 | PCR (OI, volume cumulative and per interval) and max pain intraday; daily history from S3 (`/v1/options/daily`, nearest-expiry stitched) | criterion 3 |
| M9 | Build-up class per strike (±n around ATM) and for the near future, per interval, with a timeline strip and per-bucket counts | criterion 4 |
| M10 | Straddle chain view on the chain page (`straddle-chain.js`): straddle, change, straddle IV, breakevens, % of spot, ATM and lowest-premium markers | criterion 5 |
| M11 | New page `#/charts` "Live charts" (four panels), purpose-built SVG small multiples (`ts-chart.js`) + table + CSV, `chartSlot` kept with `series()` prepared | criterion 6 |
| M12 | OI page timeline panel reads server series (PCR, max pain, totals) with a link to the charts page | OI page time axis |
| M13 | Demo realism: intraday volume profile, deterministic OI day stories, baseline lines, 20-day S3 back-fill | every feature visible in demo |
| M14 | Docs: `docs/guides/recorder.md` "Charts and series" section, `docs/guides/mcp.md`, ARCHITECTURE data layout (`.drv`, `base`), CHANGELOG | |

### 2.2 LATER (not this round)

- The owner's chart engine. Panels keep `chartSlot` and expose `series()`; wiring the engine is that item's work.
- Cross-expiry pairs (calendar straddles) and "strangle by delta" (for example a rolling 20Δ strangle). Both need recorded Δ, which S1 has, but they need P1-3's final model first.
- Straddle IV over time on the server (needs P1-3's vol-time clock; S1 keeps the raw prices so this can be computed later).
- Multi-day intraday ranges in one request (this round: one IST trading day per request; daily history comes from S3).
- A browser-recorder fallback (`oi-store`) for chains the server is not recording. This round says so and links to the Data recorder page (§2.3).
- A straddle-chain change over windows (5m/15m/…). This round has change vs prev close only.
- Alert creation from a chart point ("alert me when this straddle crosses X"). That belongs to P1-11, which reuses these series functions.
- Fixing the existing OI page copy that uses "support"/"resistance"/"bullish"/"bearish" (pre-existing, see R7). It needs coordinating with `docs/design/oi.md`.
- Per-key history-row quota (§7.8 of the BRD; same LATER as P1-1).

### 2.3 What our data cannot do (and the honest fallback)

| Limitation | Why | Fallback in this spec |
|---|---|---|
| No true VWAP | Indian broker feeds have no trade tape. S1 has, per leg per minute, the last price and the cumulative day volume | "VWAP (approx.)": each minute's volume increment is priced at that minute's last traded price (§5.6). The label, method note and CSV header say "approximate, from 1-minute samples". |
| VWAP is incomplete when recording starts late | The cumulative volume at the first snapshot includes trades at unknown prices | VWAP starts at the first increment after the first snapshot. If the first snapshot is after 09:20 IST, the line is labelled "VWAP since 11:02 (recording started late)" and `vwapPartial: true`. |
| 1-minute ΔOI is lumpy | Exchanges and brokers publish OI in batches (cadence per broker **needs verification**), so most 1-minute ΔOI values are 0 followed by a jump | `1m` is offered for OI and premium, but the build-up strip defaults to `15m` and its `1m` option carries the note "OI arrives in batches; 1-minute build-up is mostly churn or blank". |
| Build-up says nothing about who traded | OI is net and batched. Price and OI changes only suggest a class | Every build-up output carries `inferred: true`. The UI labels it "inferred from OI and price change". Class names only, no direction words (§9). |
| No history before the recorder started | Indian intraday chains cannot be bought cheaply (BRD §5.1) | `coverage` and `unavailable` say when recording began. LATER: `/v1/history` 1-minute candles with OI where the broker supports them (P1-1 LATER item). |
| "vs Prev close" needs yesterday | S1 legs carry no previous OI or close | Baseline order (§5.2): (1) the previous trading day's last S1 snapshot, but only if that day *is* the previous trading day by the calendar; (2) a `base` line built from the broker's `oiChange`/`close` (written once per chain per day, from a REST chain read the user already paid for, or one read made for this request); (3) otherwise `unavailable: { reason: "no-baseline" }`. It is never guessed. |
| PCR and max pain cover recorded strikes only (±40 indices, ±15 stocks) | Far strikes are not recorded | Labelled "over recorded strikes (±40)"; `strikesCovered` is in every point; max pain flags `edge: true` when it falls on the first or last recorded strike. |
| Stocks are recorded every 5 minutes | P1-1 stock cadence | For stock chains `1m` is refused (400 with a plain message) and the UI hides it; `every` is ≥ 5. |
| A chain the recorder refused or does not plan | Data account capacity (P1-1 §5.2) | `unavailable: { reason: "not-in-plan" | "refused" }` and an empty state with the recorder's own reason and a "Data recorder →" link. No browser fallback this round. |
| Rolling ATM near a strike midpoint flips every minute | The forward wanders around the midpoint between strikes | Hysteresis band (default 10 % of the strike step, §5.5). Every roll is listed with its time. |
| The forward is missing on partial snapshots | Fewer than 3 two-sided strikes (P1-1 §6.3) | The rolling ATM uses spot for that minute; the point carries `atmBasis: "spot"`. |
| Straddle IV depends on the clock model | Clock weights are stated assumptions (P1-3) | Method note "Black-76 on the parity forward, vol-time clock (weights shown), rate from reference". One seam (§5.10). |
| Daily history spans expiries | Each S3 row belongs to one (date, expiry) | Daily charts show a "nearest expiry" series stitched by date, with a vertical roll marker and the expiry named at each roll (§5.11). |

---

## 3. Architecture

### 3.1 Module map

New files:

```
server/bridge/dashboard/oi-series.js      SHARED pure maths (no imports; Node + browser). **Created by P1-1** with `pcr`, `maxPain`, `largestOi`; this item extends it. Header: "Shared with server/bridge/recorder/series. Pure: no DOM, no fetch, no clock reads; callers pass times."
server/bridge/dashboard/oi-series.test.mjs
server/bridge/dashboard/oi-series.shared.test.mjs   no imports, no DOM/fetch/Date.now, listed in DASHBOARD_FILES, options.js re-exports are the same objects
server/bridge/dashboard/ts-chart.js       **created by P1-3c** (line with gaps, small multiple, table, CSV); this item adds bars (ΔOI), step lines and the class strip
server/bridge/dashboard/ts-chart.test.mjs
server/bridge/dashboard/charts-model.js   pure: request URLs, response → view model, summary sentences, table rows, daily stitching, prefs validation
server/bridge/dashboard/charts-model.test.mjs
server/bridge/dashboard/charts.js         the #/charts page (four panels, toolbar, refresh loop)
server/bridge/dashboard/straddle-chain.js A9 straddle view model + table (mounted by desk.js on the chain page)
server/bridge/dashboard/straddle-chain.test.mjs
server/bridge/recorder/series/derive.mjs        pure: drvLine(snapshot) → derived line; baseFromChain(chain) → base line
server/bridge/recorder/series/params.mjs        zod query schemas, pair grammar, strike-set grammar
server/bridge/recorder/series/dayCache.mjs      LRU of decoded day columns (Float64Array) + tail refresh
server/bridge/recorder/series/seriesService.mjs catalog(), oi(), straddle(), pcr(), buildup(); baselines; unavailable reasons
server/bridge/recorder/series/csv.mjs           CSV writers (formula-injection safe, same guard as /xl)
server/bridge/recorder/series/routes.mjs        REST handlers
server/bridge/recorder/series/*.test.mjs        see §10
```

Changed files:

| File | Change |
|---|---|
| `recorder/module.mjs` | `ROUTES` += the five series routes; `register` builds `seriesService` from the store, bus, clock, config and `marketData` (baseline read only) |
| `recorder/config.mjs` | `series` sub-object and `demo.dailyBackfillDays` (§3.6) |
| `recorder/store.mjs` | `read({ …, strikeSet })` absolute-strike projection; `tail(u, x, day, offset)`; `listDays()`; `readDerived(u, x, day)`; `appendDerived(line)` |
| `recorder/recorderService.mjs` | After each snapshot or gap write, append the derived line or gap mirror (`derive.mjs`); write the `base` line the first time a REST chain for (u, x, day) is read |
| `recorder/daily.mjs` | Already uses `oi-series.js` `pcr`, `maxPain`, `largestOi` (P1-1); add the test that the 15:29 point equals the S3 row |
| `recorder/demoBackfill.mjs` | Derived lines for back-filled days; S3-only back-fill for `dailyBackfillDays` |
| `demo/demoAdapter.mjs` | Volume profile, OI day stories, `previous_oi`/`close` consistent with the base line (§6) |
| `mcp/tools.mjs` | Tool `get_option_series` |
| `core/app.mjs` | `DASHBOARD_FILES` += `charts-model.js`, `charts.js`, `straddle-chain.js` (`oi-series.js` and `ts-chart.js` are already listed by P1-1 and P1-3) (**lead-owned core file**) |
| `docs/openapi.yaml` | §4.8 (**lead-owned**) |
| `dashboard/views.js` | `PAGES` += `charts` after `oi` (one line) |
| `dashboard/options.js` | `classifyBuildup` and `BUILDUP_DEFAULTS` move to `oi-series.js`; `options.js` imports and re-exports them (two lines). **Lands after the restyle team's chain round 2 is merged** (R2) |
| `dashboard/desk.js` | Chain page: a `Chain · Straddles` toggle that mounts `straddle-chain.js` (≈ 20 lines). **Lands last, after the restyle merge** (R2) |
| `dashboard/oi.js` | Timeline panel: server series line + "Open in Live charts →" (§7.2) |
| `dashboard/format.test.mjs` | File list (as P1-1 did for `recorder.js`) |

`USED_SERVICES` for the recorder is unchanged (`marketData`, `streamHub`, `accounts`, `scheduler`, `symbols`, `backupData`). P1-1's `module.test.mjs` import check (no `orders/`, `paper/`, `safety/`, no direct `fetch`) is extended to cover `recorder/series/**`.

### 3.2 Data flow

```
broker stream / REST ─▶ recorder (P1-1) ─▶ s1/<day>/<U>/<x>.ndjson        snap | gap | base lines
                                        └▶ s1/<day>/<U>/<x>.drv.ndjson    drv | gap lines (this item)
                                        └▶ s3/<U>/<yyyy>.ndjson           daily rows (P1-1; maths shared)
                                        └▶ bus recorder.snapshot {u, x, slot}
seriesService ◀── store.read / tail / readDerived ◀── dayCache (LRU, refreshed on recorder.snapshot)
   │  (oi-series.js maths)
   ├─▶ GET /v1/options/series/*  (JSON / CSV) ─▶ charts.js, oi.js, scripts, Sheets
   └─▶ MCP get_option_series
chain page: /v1/optionchain (existing) ─▶ straddle-chain.js (oi-series.js + options.js pricing seam)
```

### 3.3 Data model

#### Derived line (one per chain per recorded slot; this item)

File `s1/<YYYY-MM-DD>/<UNDERLYING>/<expiry>.drv.ndjson`, append-only, gzipped at the day roll with the snapshot file.

```json
{ "v": 1, "kind": "drv", "u": "NIFTY", "x": "2026-11-03", "slot": 1761731100000, "model": "oi-series-v1",
  "quality": "live", "partial": false, "strikesCovered": 81,
  "spot": 25150.35, "fwd": 25171.51, "atm": 25150, "straddle": 274.9,
  "ceOi": 112500000, "peOi": 104962500, "ceVol": 38600000, "peVol": 41200000,
  "pcrOi": 0.933, "pcrVol": 1.067,
  "maxPain": 25100, "mpEdge": false,
  "largestCallOi": { "k": 25500, "oi": 9933750 }, "largestPutOi": { "k": 25000, "oi": 8211000 },
  "fut": { "x": "2026-11-24", "ltp": 25248.1, "oi": 14812500, "vol": 2133000 } }
```

- Written by `recorderService` right after the snapshot line, from the in-memory snapshot (no re-read). A gap record is mirrored as `{ "v": 1, "kind": "gap", "slot", "reason" }`, so the PCR timeline can show gaps without opening the large file.
- `fut` comes from the same slot's `_und` line (near-month future). It is `null` when the line is absent.
- Days recorded before this item have no `.drv` file. `seriesService` derives the lines on first read and writes the file atomically (`.tmp` + rename) under a per-file lock. If the day is already gzipped, it writes `.drv.ndjson.gz`. Re-derivation is skipped when the file's `model` equals `oi-series-v1`.
- Size: about 420 bytes a line → 18 index chains × 375 slots ≈ 2.8 MB/day raw, about 0.5 MB gzipped (≈ 2.5 % of S1).

#### Baseline line (`kind: "base"`, at most one per chain per IST day, in the snapshot file)

```json
{ "v": 1, "kind": "base", "u": "NIFTY", "x": "2026-11-03", "day": "2026-10-29", "ts": 1761710700000,
  "source": "broker-prev-close", "via": "recorder-rest" ,
  "k": [25100, 25150, 25200],
  "ce": { "oi": [6105000, 7140000, 8865000], "close": [190.1, 152.35, 119.8] },
  "pe": { "oi": [6900000, 6337500, 4110000], "close": [109.6, 123.15, 142.0] } }
```

- `oi[i] = leg.oi − leg.oiChange` and `close[i] = leg.close` from an `/v1/optionchain` response (`ChainLeg.oiChange`, `ChainLeg.close`). A leg missing either value stays `null`.
- `via`: `recorder-rest` (the recorder's own REST read, or a user's chain served from cache inside P1-1 rule 6) or `series-request` (one interactive chain read made by `seriesService` for a `prev` request, §8). Never from the NSE website.
- Readers that predate this item ignore unknown `kind` values (P1-1's reader keeps `snap` and `gap` only; this is asserted in `store.test.mjs`).

#### Day cache (memory only)

`dayCache` key `(u, x, day)` → `{ slots: Float64Array, strikes: number[], fields: { ceOi, peOi, ceLtp, peLtp, ceBid, peBid, ceAsk, peAsk, ceVol, peVol }: Float64Array[strikes × slots] (NaN = null), atm, fwd, spot, partial, gaps[], base | null, fut: {ltp, oi, vol}, offset, model }`. Strikes are the union of strikes seen that day (the ATM band moves). A strike absent from a snapshot is `NaN` in that slot, never 0.
- Memory: 10 fields × 2 × 8 B × 100 strikes × 375 slots ≈ 6 MB per chain-day. LRU of `series.cacheChains` (default 6) ≈ 36 MB.
- Past days are immutable once rolled. Today's entry is refreshed lazily: on `recorder.snapshot { u, x, slot }` the entry is marked dirty, and the next read calls `store.tail(u, x, day, offset)` and appends the new lines (≤ 2 lines per minute, so no full re-parse).

### 3.4 Storage on disk

```
<dataDir>/recorder/s1/2026-10-29/NIFTY/
  2026-11-03.ndjson(.gz)        P1-1 snapshots + gaps + (new) one "base" line
  2026-11-03.drv.ndjson(.gz)    (new) derived lines + gap mirrors
  _und.ndjson(.gz)              P1-1
<dataDir>/recorder/s3/NIFTY/2026.ndjson      P1-1 (maths now from oi-series.js)
<dataDir>/recorder-demo/…                    same layout, demo only
```

No new store and no new folder. Retention, the day roll, disk caps and corrupt-file handling are P1-1's. The day roll gzips `.drv.ndjson` with the snapshot file, and a corrupt `.drv` is deleted and re-derived from the snapshots. The `maxDiskMb` check counts `.drv` files.

### 3.5 Schedulers

None of its own. Derived lines ride P1-1's slot loop; back-derivation runs on first read (chunked with `setImmediate` every 25 lines). The dashboard refreshes at `slot + 5 s` while visible (§7.1). The demo daily back-fill runs inside P1-1's demo back-fill (once a day on start).

### 3.6 Config (`recorder.series` and one demo key; zod `.strict()`, all optional)

| Key | Default | Notes |
|---|---|---|
| `series.enabled` | `true` | `false` removes the routes' data (they answer `unavailable: recorder-off`) and stops derived writes |
| `series.writeDerived` | `true` | Write `.drv` lines at record time (else derive on read only) |
| `series.cacheChains` | `6` | 1–24 chain-days kept decoded |
| `series.rollBandPct` | `10` | 0–25. Rolling-ATM hysteresis as % of the strike step (§5.5) |
| `series.straddleBasis` | `"mid"` | `mid` \| `ltp`. Default price basis of straddle series (mid when two-sided, else LTP) |
| `series.buildup.minLots` | `10` | Same defaults as the OI page noise filter (`BUILDUP_DEFAULTS`) |
| `series.buildup.minOiPct` | `1` | |
| `series.buildup.minPxPct` | `0.5` | |
| `series.buildup.churnX` | `5` | |
| `series.baselineFetch` | `true` | Allow one interactive chain read per chain per day for a `prev` request with no other baseline (§5.2, §8) |
| `series.maxPoints` | `400` | Points per response page (a 1-minute day is 375) |
| `demo.dailyBackfillDays` | `20` | 0–60. Demo only: weekdays of S3 rows synthesised for daily history |

Dashboard preferences (localStorage `mcb.dashboard.charts`, validated by `chartsConfig()` in `charts-model.js` the way `oiConfig()` is): `{ underlying, expiry, date: "today"|"YYYY-MM-DD", panel, oi: { mode: "strikes"|"range"|"atm", strikes: [], lo, hi, atmEach, sides: "both"|"ce"|"pe", metric: "oi"|"dOi"|"premium", interval }, straddle: { pairs: [], basis, perLot }, pcr: { band: "all"|"10"|"20", days: 10|30|90 }, buildup: { interval, strikesEach, th } }`. The first load seeds `underlying`/`expiry` from `mcb.dashboard.desk` (read only).

### 3.7 Read path and performance budget (BRD ≤ 800 ms full day from S1)

| Request | Cold (not cached) | Warm | How |
|---|---|---|---|
| `pcr` full day | ≤ 60 ms | ≤ 10 ms | reads `.drv` only (375 × 420 B) |
| `oi` 10 strikes, full day | ≤ 300 ms | ≤ 30 ms | one pass over the snapshot day file → day cache |
| `straddle` 6 pairs incl. rolling | ≤ 300 ms | ≤ 30 ms | day cache |
| `buildup` ±10, 15m | ≤ 300 ms | ≤ 20 ms | day cache |
| `catalog` | ≤ 30 ms | ≤ 5 ms | `day.json` files |

Measured in `series.perf.test.mjs` on a generated 375-slot, 162-leg NIFTY day (gzip), on CI hardware. The test fails above **800 ms cold** for any route (the BRD number) and above the cold targets × 2 as a warning. Client: building the view model plus paths for 6 small multiples × 375 points must take ≤ 30 ms (`ts-chart.test.mjs`, Node, pure path builder).

---

## 4. API

Every route: scope `read`, `x-stream` = the recorder's stream, a `{ data, meta }` JSON body or CSV (`format=csv`), and errors in the existing Problem shape. Demo responses carry `meta.demo` as today. The account-id redaction rule is P1-1's (§4): `accountId`/`broker` are `null` unless the principal is local, the key has accounts `"*"`, or its list includes that account. Times are IST ISO strings (`2026-10-29T10:15:00.000+05:30`), as in P1-1.

### 4.0 Common query parameters

| Param | Required | Format | Default |
|---|---|---|---|
| `underlying` | yes | `^[A-Z0-9&-]{1,30}$` | |
| `expiry` | yes (not on `catalog`) | `YYYY-MM-DD` | |
| `date` | no | IST trading date `YYYY-MM-DD` | today (IST) |
| `since` | no | IST date-time or epoch ms; returns points from the bucket that contains it | none (whole day) |
| `format` | no | `json`, `csv` | `json` |

Common response fields (`SeriesCommon`): `underlying, expiry, date, exchange, cadenceMinutes (1|5), lotSize, times[] (one per point), replaceFrom (ISO|null; with since: the client replaces its points from here), gaps[] (P1-1 SnapshotGap, merged), coverage { expectedSlots, recordedSlots, gapSlots, partialSlots, firstSlot, lastSlot }, quality ("live"|"demo"|"demo-backfill"|"mixed"), units, method {…}, unavailable (null | { reason, detail })`.

`unavailable.reason` (open enum): `recorder-off`, `not-in-plan`, `refused`, `not-recorded-yet`, `outside-retention`, `no-baseline`, `not-a-trading-day`. An `unavailable` response is **200** with empty arrays (as in P1-1: scripts do not have to special-case a 404).

Arrays are aligned to `times`; `null` means no value (gap, missing leg, or not computable). Values are never interpolated.

### 4.1 `GET /v1/options/series/catalog` (scope `read`)

What is recorded and on which days, for the page's pickers.

Query: `underlying` (optional), `date` (optional; default today), `days` (1–60, default 20).

```json
{ "data": {
    "date": "2026-10-29",
    "days": ["2026-10-29", "2026-10-28", "2026-10-27"],
    "chains": [
      { "underlying": "NIFTY", "expiry": "2026-11-03", "cadenceMinutes": 1, "recordedSlots": 61, "firstSlot": "2026-10-29T09:15:00.000+05:30", "lastSlot": "2026-10-29T10:15:00.000+05:30", "quality": "live", "strikesEachSide": 40, "baseline": "prev-recorded" }
    ],
    "recorder": { "state": "recording", "stateDetail": "Recording 18 index chains (18 by stream) and 0 stocks." }
  },
  "meta": { "requestId": "req_…" } }
```

`baseline`: `prev-recorded` | `broker-prev-close` | `none` (what a `prev` request would use).

### 4.2 `GET /v1/options/series/oi` (scope `read`)

Query (plus §4.0):

| Param | Format | Default | Rule |
|---|---|---|---|
| `strikes` | comma list of strikes, e.g. `25000,25100,25200` | | ≤ 10; mode `strikes` |
| `strikeFrom`, `strikeTo` | numbers | | inclusive range, ≤ 81 recorded strikes; mode `range` (summed) |
| `atm` | integer 0–20 | | ±n strikes around each minute's rolling ATM, summed; mode `atm` |
| `sides` | `ce,pe` / `ce` / `pe` | `ce,pe` | |
| `interval` | `1m,5m,15m,30m,1h,open,prev` | `5m` | `1m` refused on 5-minute (stock) chains |
| `every` | `1,3,5,15,30` minutes | cadence | only for `open`/`prev` (point spacing); minute intervals space points by the interval |
| `fields` | `oi,dOi,premium,volume` | all | |
| `basis` | `ltp`, `mid` | `ltp` | premium basis |

Exactly one of `strikes`, `strikeFrom`+`strikeTo`, `atm` is required (400 otherwise).

200 (`strikes=25100,25200&interval=5m&fields=oi,dOi,premium`, trimmed):

```json
{ "data": {
    "underlying": "NIFTY", "expiry": "2026-11-03", "date": "2026-10-29", "exchange": "NFO",
    "cadenceMinutes": 1, "lotSize": 75, "mode": "strikes", "interval": "5m",
    "intervalBasis": { "kind": "bucket", "minutes": 5 },
    "times": ["2026-10-29T10:04:00.000+05:30", "2026-10-29T10:09:00.000+05:30"],
    "bucketPartial": [false, true],
    "series": [
      { "id": "25200CE", "strike": 25200, "right": "CE", "oi": [6112500, 6187500], "dOi": [150000, 75000], "premium": [118.4, 115.9] },
      { "id": "25200PE", "strike": 25200, "right": "PE", "oi": [4852500, 4890000], "dOi": [52500, 37500], "premium": [124.1, 126.5] }
    ],
    "spot": [25158.2, 25149.6], "forward": [25179.4, 25170.8], "atm": [25200, 25150],
    "replaceFrom": null,
    "gaps": [{ "from": "2026-10-29T10:06:00.000+05:30", "to": "2026-10-29T10:06:00.000+05:30", "slots": 1, "reason": "stream-down", "detail": "Dhan feed stale for 64 s" }],
    "coverage": { "expectedSlots": 55, "recordedSlots": 54, "gapSlots": 1, "partialSlots": 0, "firstSlot": "2026-10-29T09:15:00.000+05:30", "lastSlot": "2026-10-29T10:09:00.000+05:30" },
    "quality": "live",
    "units": { "oi": "units", "dOi": "units", "premium": "INR per unit", "volume": "units" },
    "method": {
      "interval": "5-minute buckets on the 09:15 grid; each point is the last snapshot in its bucket; ΔOI is that point minus the previous bucket's point.",
      "premium": "Last traded price at the snapshot.",
      "oi": "Open interest in units (shares or index units), as recorded each minute."
    },
    "unavailable": null },
  "meta": { "requestId": "req_…", "accountId": null } }
```

Mode `range`: `series` has two entries `{ "id": "CE", "right": "CE", "strikes": "24900–25300", "oi": [], "dOi": [], "volume": [] }` (premium is not summed: `premium` absent, with `method.premium` saying "not defined for a range"). Mode `atm`: the same, plus `band: [[24950, 25350], …]` per point.

`interval=prev`: `intervalBasis: { "kind": "prev", "basis": "prev-recorded" | "broker-prev-close", "baseDay": "2026-10-28" }`. With no baseline: 200 + `unavailable.reason: "no-baseline"` and `detail` "28 Oct was not recorded and the broker's previous OI was not available. Since open works."

CSV: one row per (time, series) with columns `time,id,strike,right,oi,dOi,premium,volume,bucketPartial,quality`; gaps as rows with `id=GAP` and the reason. File name `NIFTY_2026-11-03_2026-10-29_oi_5m.csv`.

### 4.3 `GET /v1/options/series/straddle` (scope `read`)

Query (plus §4.0):

| Param | Format | Default | Rule |
|---|---|---|---|
| `pairs` | comma list of pair tokens (grammar below) | `S:atm` | ≤ 6, no duplicates |
| `basis` | `mid`, `ltp` | `series.straddleBasis` | |
| `every` | `1,3,5,15,30` | cadence | point spacing (last snapshot in each bucket) |

Pair grammar (URL-safe; `params.mjs`):
- `S:<K>`: straddle at fixed strike K (`S:25150`).
- `S:atm`: rolling ATM straddle.
- `G:<Kc>-<Kp>`: fixed strangle, call strike then put strike (`G:25300-24900`); `Kc ≥ Kp` required.
- `G:atm<n>`: rolling strangle, CE at ATM + n steps and PE at ATM − n steps, n 1–10 (`G:atm2`).

200 (`pairs=S:atm,S:25150&every=1`, trimmed to 4 points):

```json
{ "data": {
    "underlying": "NIFTY", "expiry": "2026-11-03", "date": "2026-10-29", "cadenceMinutes": 1, "lotSize": 75, "basis": "mid",
    "times": ["2026-10-29T09:15:00.000+05:30", "2026-10-29T09:16:00.000+05:30", "2026-10-29T09:17:00.000+05:30", "2026-10-29T09:18:00.000+05:30"],
    "pairs": [
      { "id": "S:25150", "label": "25150 straddle", "kind": "fixed", "ceStrike": 25150, "peStrike": 25150,
        "premium": [275.0, 275.3, 275.4, 275.3], "ce": [150.0, 152.4, 149.8, 147.2], "pe": [125.0, 122.9, 125.6, 128.1],
        "vwap": [null, 275.3, 275.09, 276.0], "vwapStart": "2026-10-29T09:16:00.000+05:30", "vwapPartial": false,
        "open": 275.0, "high": 275.4, "low": 275.0, "last": 275.3,
        "prevClose": 276.0, "prevCloseBasis": "broker-prev-close", "change": -0.7, "ltpFallbackPoints": 0 },
      { "id": "S:atm", "label": "Rolling ATM straddle", "kind": "rolling",
        "ceStrikes": [25150, 25150, 25150, 25150], "peStrikes": [25150, 25150, 25150, 25150],
        "premium": [275.0, 275.3, 275.4, 275.3], "vwap": [null, 275.3, 275.09, 276.0],
        "rolls": [], "atmBasis": ["forward", "forward", "forward", "forward"] }
    ],
    "spot": [25150.4, 25152.1, 25149.0, 25146.3], "forward": [25171.5, 25173.2, 25170.0, 25167.4],
    "gaps": [], "coverage": { "…": "…" }, "quality": "live",
    "units": { "premium": "INR per unit", "vwap": "INR per unit" },
    "method": {
      "premium": "Call mid + put mid at the minute (last price when a side has no two-sided quote).",
      "vwap": "Approximate: each leg's volume traded in a minute priced at that minute's last price, summed from the first recorded minute; straddle VWAP = call VWAP + put VWAP. Not the exchange VWAP.",
      "rolling": "ATM = strike nearest the parity forward, switching only when the forward is 10% of a strike step past the midpoint (hysteresis)."
    },
    "unavailable": null },
  "meta": { "requestId": "req_…" } }
```

A rolling pair's `rolls` entries look like `{ "time": "…10:02…", "from": 25150, "to": 25200, "forward": 25183.4 }`. CSV columns: `time,pair,ceStrike,peStrike,ce,pe,premium,vwap,atmBasis,quality`.

### 4.4 `GET /v1/options/series/pcr` (scope `read`)

Query (plus §4.0): `band` (`all` | 1–40 strikes each side of each minute's ATM; default `all`), `interval` (`1m,5m,15m,30m,1h`; default `1m`; sets `pcrVolInterval` buckets and point spacing).

```json
{ "data": {
    "underlying": "NIFTY", "expiry": "2026-11-03", "date": "2026-10-29", "band": "all", "interval": "5m",
    "times": ["2026-10-29T09:59:00.000+05:30", "2026-10-29T10:04:00.000+05:30"],
    "pcrOi": [0.931, 0.933], "pcrVol": [1.067, 1.026], "pcrVolInterval": [0.982, 0.545],
    "maxPain": [25100, 25100], "maxPainEdge": [false, false],
    "ceOi": [112125000, 112500000], "peOi": [104385000, 104962500],
    "largestCallOi": [25500, 25500], "largestPutOi": [25000, 25000],
    "spot": [25161.0, 25150.35], "strikesCovered": [81, 81],
    "gaps": [], "coverage": { "…": "…" }, "quality": "live",
    "method": {
      "pcrOi": "Σ put OI ÷ Σ call OI over recorded strikes (±40) at the minute.",
      "pcrVol": "Σ put volume ÷ Σ call volume, day so far.",
      "pcrVolInterval": "Same ratio on the volume traded inside each interval.",
      "maxPain": "Recorded strike where Σ CE_OI·max(0, S − K) + Σ PE_OI·max(0, K − S) is lowest (over recorded strikes; edge = first or last recorded strike)."
    },
    "unavailable": null },
  "meta": { "requestId": "req_…" } }
```

`band=all` reads `.drv` only. A numeric band reads the day cache. Daily history is the existing `GET /v1/options/daily` (P1-1 §4.3); this item adds no daily route.

### 4.5 `GET /v1/options/series/buildup` (scope `read`)

Query (plus §4.0): `interval` (`1m,5m,15m,30m,1h`; default `15m`), `strikesEach` (1–20, default 10; around the latest snapshot's ATM, fixed for the whole strip), `futures` (boolean, default `true`), `minLots`, `minOiPct`, `minPxPct` (optional overrides; defaults from config).

```json
{ "data": {
    "underlying": "NIFTY", "expiry": "2026-11-03", "date": "2026-10-29", "interval": "15m", "inferred": true,
    "filter": { "minLots": 10, "minOiPct": 1, "minPxPct": 0.5, "churnX": 5, "lotSize": 75 },
    "buckets": [ { "from": "2026-10-29T09:15:00.000+05:30", "to": "2026-10-29T09:30:00.000+05:30", "partial": false } ],
    "rows": [
      { "strike": 25200, "ce": ["SB"], "pe": ["LB"], "ceD": [150000], "peD": [90000], "ceDLtp": [-6.2], "peDLtp": [6.5] }
    ],
    "futures": { "expiry": "2026-11-24", "classes": ["LB"], "d": [37500], "dLtp": [21.4] },
    "summary": [ { "LB": { "n": 3, "lots": 4200 }, "SB": { "n": 7, "lots": 9100 }, "SC": { "n": 1, "lots": 800 }, "LU": { "n": 2, "lots": 2600 }, "CH": { "n": 4, "lots": 0 } } ],
    "gaps": [], "coverage": { "…": "…" }, "quality": "live",
    "method": { "classes": "Per bucket: OI change and last-price change versus the previous bucket's last snapshot, with the noise filter. LB price↑ OI↑, SB price↓ OI↑, SC price↑ OI↓, LU price↓ OI↓, CH heavy volume with little OI or price change. Inferred from net OI; not who traded." },
    "unavailable": null },
  "meta": { "requestId": "req_…" } }
```

Class values: `LB`, `SB`, `SC`, `LU`, `CH`, `null` (nothing passed the filter or data missing). The first bucket compares with the day's first snapshot (`buckets[0].ref = "first-snapshot"`).

### 4.6 Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | missing or invalid param; > 10 strikes; range > 81 recorded strikes or `strikeFrom > strikeTo`; more than one strike mode; > 6 pairs; bad pair token ("Pair 'G:25300-25400' needs the call strike first and not below the put strike."); `1m` on a 5-minute chain ("RELIANCE 24 Nov is recorded every 5 minutes; choose 5m or more."); `date` in the future; bad `since` |
| 401/403 | `UNAUTHENTICATED`, `SCOPE_REQUIRED` | as usual |
| 429 | `RATE_LIMITED` | client limiter (existing) |
| 200 + `unavailable` | — | every data-availability case (§4.0) |

No new error codes.

### 4.7 MCP tool `get_option_series` (read)

Inputs: `kind` (`oi`|`straddle`|`pcr`|`buildup`), `underlying`, `expiry`, `date?`, and the kind's params (`strikes?`, `atm?`, `interval?` default `15m`, `pairs?` default `"S:atm"`, `band?`). The output is downsampled to at most **60 points** (`truncated: true` plus `every` used), with the same field names and units as REST, wrapped in the existing untrusted-data envelope. It is listed in `docs/guides/mcp.md`. Sheets parity: `format=csv` on each REST route (tunnel caveats in `compliance.md` apply).

### 4.8 OpenAPI additions (`docs/openapi.yaml`; lead applies)

Tag `Options data` (P1-1 creates it). Paths go after `/v1/options/daily`.

```yaml
  /v1/options/series/catalog:
    get:
      tags: [Options data]
      operationId: getOptionSeriesCatalog
      summary: Recorded chains and days available for series
      x-stream: S17
      x-scope: read
      parameters:
        - { name: underlying, in: query, schema: { type: string, maxLength: 30 } }
        - { name: date, in: query, schema: { type: string, format: date } }
        - { name: days, in: query, schema: { type: integer, minimum: 1, maximum: 60, default: 20 } }
      responses:
        "200":
          description: Catalog.
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { $ref: "#/components/schemas/SeriesCatalog" }
                  meta: { $ref: "#/components/schemas/Meta" }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }

  /v1/options/series/oi:
    get:
      tags: [Options data]
      operationId: getOptionSeriesOi
      summary: OI, OI change and premium over one day for chosen strikes, a strike range or a band around ATM
      x-stream: S17
      x-scope: read
      parameters:
        - $ref: "#/components/parameters/SeriesUnderlying"
        - $ref: "#/components/parameters/SeriesExpiry"
        - $ref: "#/components/parameters/SeriesDate"
        - $ref: "#/components/parameters/SeriesSince"
        - $ref: "#/components/parameters/SeriesFormat"
        - { name: strikes, in: query, schema: { type: string, pattern: "^\\d+(\\.\\d+)?(,\\d+(\\.\\d+)?){0,9}$" }, description: "Up to 10 strikes." }
        - { name: strikeFrom, in: query, schema: { type: number } }
        - { name: strikeTo, in: query, schema: { type: number } }
        - { name: atm, in: query, schema: { type: integer, minimum: 0, maximum: 20 }, description: "± strikes around each minute's ATM, summed." }
        - { name: sides, in: query, schema: { type: string, enum: ["ce,pe", ce, pe], default: "ce,pe" } }
        - { name: interval, in: query, schema: { type: string, enum: [1m, 5m, 15m, 30m, 1h, open, prev], default: 5m } }
        - { name: every, in: query, schema: { type: integer, enum: [1, 3, 5, 15, 30] } }
        - { name: fields, in: query, schema: { type: string, pattern: "^(oi|dOi|premium|volume)(,(oi|dOi|premium|volume))*$" } }
        - { name: basis, in: query, schema: { type: string, enum: [ltp, mid], default: ltp } }
      responses:
        "200":
          description: Series (CSV when format=csv).
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { $ref: "#/components/schemas/OiSeries" }
                  meta: { $ref: "#/components/schemas/Meta" }
            text/csv: { schema: { type: string } }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }

  /v1/options/series/straddle:
    get:
      tags: [Options data]
      operationId: getOptionSeriesStraddle
      summary: Straddle and strangle premium over one day, including rolling ATM, with approximate VWAP
      x-stream: S17
      x-scope: read
      parameters:
        - $ref: "#/components/parameters/SeriesUnderlying"
        - $ref: "#/components/parameters/SeriesExpiry"
        - $ref: "#/components/parameters/SeriesDate"
        - $ref: "#/components/parameters/SeriesSince"
        - $ref: "#/components/parameters/SeriesFormat"
        - name: pairs
          in: query
          description: "Up to 6: S:<strike>, S:atm, G:<callStrike>-<putStrike>, G:atm<n> (n 1–10)."
          schema: { type: string, default: "S:atm", pattern: "^(S:(atm|\\d+(\\.\\d+)?)|G:(atm([1-9]|10)|\\d+(\\.\\d+)?-\\d+(\\.\\d+)?))(,(S:(atm|\\d+(\\.\\d+)?)|G:(atm([1-9]|10)|\\d+(\\.\\d+)?-\\d+(\\.\\d+)?))){0,5}$" }
        - { name: basis, in: query, schema: { type: string, enum: [mid, ltp] } }
        - { name: every, in: query, schema: { type: integer, enum: [1, 3, 5, 15, 30] } }
      responses:
        "200":
          description: Pairs (CSV when format=csv).
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { $ref: "#/components/schemas/StraddleSeries" }
                  meta: { $ref: "#/components/schemas/Meta" }
            text/csv: { schema: { type: string } }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }

  /v1/options/series/pcr:
    get:
      tags: [Options data]
      operationId: getOptionSeriesPcr
      summary: PCR (OI and volume), max pain, OI totals and largest-OI strikes over one day
      x-stream: S17
      x-scope: read
      parameters:
        - $ref: "#/components/parameters/SeriesUnderlying"
        - $ref: "#/components/parameters/SeriesExpiry"
        - $ref: "#/components/parameters/SeriesDate"
        - $ref: "#/components/parameters/SeriesSince"
        - $ref: "#/components/parameters/SeriesFormat"
        - { name: band, in: query, schema: { type: string, pattern: "^(all|[1-9]|[1-3][0-9]|40)$", default: all } }
        - { name: interval, in: query, schema: { type: string, enum: [1m, 5m, 15m, 30m, 1h], default: 1m } }
      responses:
        "200":
          description: Series (CSV when format=csv).
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { $ref: "#/components/schemas/PcrSeries" }
                  meta: { $ref: "#/components/schemas/Meta" }
            text/csv: { schema: { type: string } }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }

  /v1/options/series/buildup:
    get:
      tags: [Options data]
      operationId: getOptionSeriesBuildup
      summary: Inferred build-up class per strike and for the near future, per interval, over one day
      x-stream: S17
      x-scope: read
      parameters:
        - $ref: "#/components/parameters/SeriesUnderlying"
        - $ref: "#/components/parameters/SeriesExpiry"
        - $ref: "#/components/parameters/SeriesDate"
        - $ref: "#/components/parameters/SeriesSince"
        - $ref: "#/components/parameters/SeriesFormat"
        - { name: interval, in: query, schema: { type: string, enum: [1m, 5m, 15m, 30m, 1h], default: 15m } }
        - { name: strikesEach, in: query, schema: { type: integer, minimum: 1, maximum: 20, default: 10 } }
        - { name: futures, in: query, schema: { type: boolean, default: true } }
        - { name: minLots, in: query, schema: { type: number, minimum: 0, maximum: 100000 } }
        - { name: minOiPct, in: query, schema: { type: number, minimum: 0, maximum: 100 } }
        - { name: minPxPct, in: query, schema: { type: number, minimum: 0, maximum: 100 } }
      responses:
        "200":
          description: Strip (CSV when format=csv).
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { $ref: "#/components/schemas/BuildupSeries" }
                  meta: { $ref: "#/components/schemas/Meta" }
            text/csv: { schema: { type: string } }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }

components:
  parameters:
    SeriesUnderlying: { name: underlying, in: query, required: true, schema: { type: string, maxLength: 30 } }
    SeriesExpiry: { name: expiry, in: query, required: true, schema: { type: string, format: date } }
    SeriesDate: { name: date, in: query, schema: { type: string, format: date }, description: "IST trading day. Default: today." }
    SeriesSince: { name: since, in: query, schema: { type: string }, description: "IST date-time or epoch ms. Points from the bucket containing it; see replaceFrom." }
    SeriesFormat: { name: format, in: query, schema: { type: string, enum: [json, csv], default: json } }
  schemas:
    NullableNumbers: { type: array, items: { type: [number, "null"] } }
    SeriesUnavailable:
      type: [object, "null"]
      properties:
        reason: { type: string, enum: [recorder-off, not-in-plan, refused, not-recorded-yet, outside-retention, no-baseline, not-a-trading-day], description: "Open enum." }
        detail: { type: string }
    SeriesCommon:
      type: object
      required: [underlying, date, times, gaps, coverage, quality, method, unavailable]
      properties:
        underlying: { type: string }
        expiry: { type: string, format: date }
        date: { type: string, format: date }
        exchange: { type: [string, "null"] }
        cadenceMinutes: { type: integer, enum: [1, 5] }
        lotSize: { type: [integer, "null"] }
        times: { type: array, items: { type: string, format: date-time } }
        replaceFrom: { type: [string, "null"], format: date-time }
        gaps: { type: array, items: { $ref: "#/components/schemas/SnapshotGap" } }
        coverage: { type: object, additionalProperties: true }
        quality: { type: string, enum: [live, demo, demo-backfill, mixed], description: "Open enum." }
        units: { type: object, additionalProperties: { type: string } }
        method: { type: object, additionalProperties: { type: string } }
        unavailable: { $ref: "#/components/schemas/SeriesUnavailable" }
    SeriesCatalog:
      type: object
      required: [date, days, chains]
      properties:
        date: { type: string, format: date }
        days: { type: array, items: { type: string, format: date } }
        chains:
          type: array
          items:
            type: object
            required: [underlying, expiry, cadenceMinutes, recordedSlots]
            properties:
              underlying: { type: string }
              expiry: { type: string, format: date }
              cadenceMinutes: { type: integer }
              recordedSlots: { type: integer }
              firstSlot: { type: [string, "null"], format: date-time }
              lastSlot: { type: [string, "null"], format: date-time }
              quality: { type: string }
              strikesEachSide: { type: integer }
              baseline: { type: string, enum: [prev-recorded, broker-prev-close, none] }
        recorder: { type: object, properties: { state: { type: string }, stateDetail: { type: string } } }
    OiSeries:
      allOf:
        - $ref: "#/components/schemas/SeriesCommon"
        - type: object
          required: [mode, interval, series]
          properties:
            mode: { type: string, enum: [strikes, range, atm] }
            interval: { type: string, enum: [1m, 5m, 15m, 30m, 1h, open, prev] }
            intervalBasis: { type: object, properties: { kind: { type: string, enum: [bucket, open, prev] }, minutes: { type: integer }, basis: { type: string, enum: [prev-recorded, broker-prev-close] }, baseDay: { type: string, format: date } } }
            bucketPartial: { type: array, items: { type: boolean } }
            series:
              type: array
              items:
                type: object
                required: [id, right]
                properties:
                  id: { type: string }
                  strike: { type: [number, "null"] }
                  right: { type: string, enum: [CE, PE] }
                  strikes: { type: string, description: "Range or band label (range/atm modes)." }
                  oi: { $ref: "#/components/schemas/NullableNumbers" }
                  dOi: { $ref: "#/components/schemas/NullableNumbers" }
                  premium: { $ref: "#/components/schemas/NullableNumbers" }
                  volume: { $ref: "#/components/schemas/NullableNumbers" }
            band: { type: array, items: { type: array, items: { type: [number, "null"] }, minItems: 2, maxItems: 2 } }
            spot: { $ref: "#/components/schemas/NullableNumbers" }
            forward: { $ref: "#/components/schemas/NullableNumbers" }
            atm: { $ref: "#/components/schemas/NullableNumbers" }
    StraddleSeries:
      allOf:
        - $ref: "#/components/schemas/SeriesCommon"
        - type: object
          required: [basis, pairs]
          properties:
            basis: { type: string, enum: [mid, ltp] }
            pairs:
              type: array
              maxItems: 6
              items:
                type: object
                required: [id, label, kind, premium, vwap]
                properties:
                  id: { type: string }
                  label: { type: string }
                  kind: { type: string, enum: [fixed, rolling] }
                  ceStrike: { type: number }
                  peStrike: { type: number }
                  ceStrikes: { $ref: "#/components/schemas/NullableNumbers" }
                  peStrikes: { $ref: "#/components/schemas/NullableNumbers" }
                  premium: { $ref: "#/components/schemas/NullableNumbers" }
                  ce: { $ref: "#/components/schemas/NullableNumbers" }
                  pe: { $ref: "#/components/schemas/NullableNumbers" }
                  vwap: { $ref: "#/components/schemas/NullableNumbers" }
                  vwapStart: { type: [string, "null"], format: date-time }
                  vwapPartial: { type: boolean }
                  open: { type: [number, "null"] }
                  high: { type: [number, "null"] }
                  low: { type: [number, "null"] }
                  last: { type: [number, "null"] }
                  prevClose: { type: [number, "null"] }
                  prevCloseBasis: { type: [string, "null"], enum: [prev-recorded, broker-prev-close, null] }
                  change: { type: [number, "null"] }
                  rolls: { type: array, items: { type: object, properties: { time: { type: string, format: date-time }, from: { type: number }, to: { type: number }, forward: { type: [number, "null"] } } } }
                  atmBasis: { type: array, items: { type: [string, "null"], enum: [forward, spot, null] } }
                  ltpFallbackPoints: { type: integer }
            spot: { $ref: "#/components/schemas/NullableNumbers" }
            forward: { $ref: "#/components/schemas/NullableNumbers" }
    PcrSeries:
      allOf:
        - $ref: "#/components/schemas/SeriesCommon"
        - type: object
          required: [band, interval, pcrOi, pcrVol, maxPain]
          properties:
            band: { type: string }
            interval: { type: string }
            pcrOi: { $ref: "#/components/schemas/NullableNumbers" }
            pcrVol: { $ref: "#/components/schemas/NullableNumbers" }
            pcrVolInterval: { $ref: "#/components/schemas/NullableNumbers" }
            maxPain: { $ref: "#/components/schemas/NullableNumbers" }
            maxPainEdge: { type: array, items: { type: [boolean, "null"] } }
            ceOi: { $ref: "#/components/schemas/NullableNumbers" }
            peOi: { $ref: "#/components/schemas/NullableNumbers" }
            largestCallOi: { $ref: "#/components/schemas/NullableNumbers" }
            largestPutOi: { $ref: "#/components/schemas/NullableNumbers" }
            spot: { $ref: "#/components/schemas/NullableNumbers" }
            strikesCovered: { type: array, items: { type: [integer, "null"] } }
    BuildupClass: { type: [string, "null"], enum: [LB, SB, SC, LU, CH, null] }
    BuildupSeries:
      allOf:
        - $ref: "#/components/schemas/SeriesCommon"
        - type: object
          required: [interval, inferred, filter, buckets, rows]
          properties:
            interval: { type: string }
            inferred: { type: boolean, const: true }
            filter: { type: object, properties: { minLots: { type: number }, minOiPct: { type: number }, minPxPct: { type: number }, churnX: { type: number }, lotSize: { type: [integer, "null"] } } }
            buckets: { type: array, items: { type: object, properties: { from: { type: string, format: date-time }, to: { type: string, format: date-time }, partial: { type: boolean }, ref: { type: string } } } }
            rows:
              type: array
              items:
                type: object
                required: [strike, ce, pe]
                properties:
                  strike: { type: number }
                  ce: { type: array, items: { $ref: "#/components/schemas/BuildupClass" } }
                  pe: { type: array, items: { $ref: "#/components/schemas/BuildupClass" } }
                  ceD: { $ref: "#/components/schemas/NullableNumbers" }
                  peD: { $ref: "#/components/schemas/NullableNumbers" }
                  ceDLtp: { $ref: "#/components/schemas/NullableNumbers" }
                  peDLtp: { $ref: "#/components/schemas/NullableNumbers" }
            futures: { type: [object, "null"], properties: { expiry: { type: string, format: date }, classes: { type: array, items: { $ref: "#/components/schemas/BuildupClass" } }, d: { $ref: "#/components/schemas/NullableNumbers" }, dLtp: { $ref: "#/components/schemas/NullableNumbers" } } }
            summary: { type: array, items: { type: object, additionalProperties: { type: object, properties: { n: { type: integer }, lots: { type: number } } } } }
```

`x-stream` is set to whatever the lead assigns the recorder (R9). `core/openapi.test.mjs` checks route parity. AsyncAPI: no change (no new client stream; `recorder.snapshot` stays an internal bus topic).

---

## 5. Formulas (pure functions in `oi-series.js`, each with a reference-value test)

Notation: slot = a recorded minute (P1-1); `x(t)` = a recorded value at slot t; `null` propagates (any arithmetic with null gives null). Lot = 75 in the examples (the demo NIFTY lot; real lots come from data).

### 5.1 Buckets and points

Minute intervals I ∈ {1, 5, 15, 30, 60}: bucket j covers slots `[09:15 + j·I, 09:15 + (j+1)·I)` IST (session start from the calendar; P1-2 later). The point of a bucket is **the last recorded snapshot in it**, and the point time is that snapshot's slot. An empty bucket has a `null` point and is listed in `gaps`. `bucketPartial[j] = recordedSlots < expectedSlots` within the bucket. Cumulative intervals (`open`, `prev`) use `every`-minute buckets for spacing in the same way.

`bucketsOf(slots[], I, sessionStartMs) → [{ from, to, last: index | -1, n, expected }]`. Worked (I = 5): slots 10:00, 10:01, 10:02, 10:03, 10:04 → bucket 10:00–10:05, last = 10:04, partial = false. Slots 10:05, 10:07, 10:08, 10:09 (10:06 a gap) → bucket 10:05–10:10, last = 10:09, partial = **true**.

### 5.2 ΔOI per interval, and baselines

- Minute interval: `dOi_j = oi(last_j) − oi(last_{j−1})`. For j = 0, it is relative to the day's first snapshot (`ref: "first-snapshot"`).
- `open`: `dOi(t) = oi(t) − oi(firstSnapshotOfDay)`. If the first snapshot is after 09:20, `intervalBasis.lateStart` is that time ("since 11:02").
- `prev`: `dOi(t) = oi(t) − oiPrev`, where `oiPrev` comes from the first source that exists:
  1. **prev-recorded**: the last snapshot of `prevTradingDay(date)` (P1-1 calendar, later P1-2), *only if* that day folder exists and its last slot is ≥ 15:25 IST. A missing yesterday is never replaced by an older day.
  2. **broker-prev-close**: the day's `base` line (`oi − oiChange` from a REST chain).
  3. Otherwise `unavailable: no-baseline`.

Worked (25200 CE, 5m; OI in units, so 37,500 = 500 lots, a typical batched step):

| Slot | 09:59 | 10:00 | 10:01 | 10:02 | 10:03 | 10:04 | 10:05 | 10:06 | 10:07 | 10:08 | 10:09 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| OI | 5,962,500 | 6,000,000 | 6,000,000 | 6,075,000 | 6,075,000 | 6,112,500 | 6,112,500 | gap | 6,150,000 | 6,150,000 | 6,187,500 |

Bucket 09:55–10:00 point = 5,962,500. Bucket 10:00–10:05 point = 6,112,500 → **dOi = +150,000 (2,000 lots)**. Bucket 10:05–10:10 point = 6,187,500 → **dOi = +75,000**, `bucketPartial = true`. This matches the §4.2 example.

### 5.3 Strike sets

- `strikes`: each strike K is its own series; a strike not recorded at a slot is null.
- `range [lo, hi]`: `OI_CE(t) = Σ_{lo ≤ K ≤ hi} ce.oi(K, t)`. If any strike in the range is null at t, the sum is **null** (no partial sums that would look like an unwind), and the point is listed in `coverage.partialSlots`.
- `atm n`: the same sum over `[A(t) − n·step, A(t) + n·step]`, where A(t) is the rolling ATM (§5.5). The band moves with A(t), so the method note says "band follows ATM; ΔOI includes strikes entering and leaving the band". Range PCR (shown in the table) = PE sum ÷ CE sum.

Worked (OI in thousands of units, P1-1's max-pain table): range 24,900–25,100 → CE 20 + 45 + 80 = **145**, PE 140 + 110 + 90 = **340**, range PCR = **2.34**.

### 5.4 Premium basis

`price(leg) = mid` when `bid > 0 && ask ≥ bid` (`basis=mid`), else LTP (counted in `ltpFallbackPoints`). `basis=ltp` always uses LTP. OI and build-up series use LTP (a trade price). Straddle series default to mid (`series.straddleBasis`).

### 5.5 Straddles, strangles and the rolling ATM (hysteresis)

- Fixed straddle at K: `P(t) = price(CE_K, t) + price(PE_K, t)`. Fixed strangle (Kc, Kp): `price(CE_Kc) + price(PE_Kp)`.
- Rolling ATM `A(t)`: `A(t0)` = the snapshot's `atm` (nearest forward, lower on a tie: P1-1 §6.4). Then, with `b = rollBandPct/100 × step`, the reference `R(t) = fwd(t)` (`spot(t)` when fwd is null; `atmBasis` records which) and `A(t)` moves up one step while `R(t) ≥ A + step/2 + b`, and down while `R(t) ≤ A − step/2 − b` (it can move several steps in one minute). Rolling straddle `P(t) = price(CE_{A(t)}) + price(PE_{A(t)})`. Rolling strangle n: `price(CE_{A+n·step}) + price(PE_{A−n·step})`.

Worked (NIFTY, step 50, rollBandPct 10 → b = 5 points; up threshold from 25150 is 25180, down threshold from 25200 is 25170):

| Time | Forward | Nearest strike | A(t) | Roll |
|---|---|---|---|---|
| 10:00 | 25,171.5 | 25,150 | 25,150 | — |
| 10:01 | 25,177.9 | 25,200 | **25,150** (below 25,180) | — |
| 10:02 | 25,183.4 | 25,200 | **25,200** | 25,150 → 25,200 |
| 10:03 | 25,172.6 | 25,150 | **25,200** (above 25,170) | — |
| 10:04 | 25,168.0 | 25,150 | **25,150** | 25,200 → 25,150 |

Without hysteresis 10:01 and 10:03 would also flip. The test asserts exactly these two rolls.

### 5.6 Approximate VWAP

Per leg: `ΔV(t) = vol(t) − vol(t_prev)`, where t_prev is the previous recorded slot; ΔV < 0 (a broker reset) counts as 0 and is logged. `VWAP_leg(t) = Σ_{s ≤ t} price_ltp(s)·ΔV(s) ÷ Σ ΔV(s)`, summed from the first increment after the day's first snapshot. A gap's volume lands on the next recorded slot at that slot's price, and the method note says so. Fixed straddle `VWAP = VWAP_CE + VWAP_PE` (each leg weighted by its own volume). Rolling pair: `VWAP(t) = Σ P_A(s)·(ΔV_CE,A(s) + ΔV_PE,A(s)) ÷ Σ (ΔV_CE,A(s) + ΔV_PE,A(s))`, using the legs that were ATM in that minute. Both are labelled "approx.".

Worked (25150 straddle; LTP in ₹, cumulative volume in units):

| Time | CE LTP | CE vol | PE LTP | PE vol | Straddle | VWAP CE | VWAP PE | VWAP |
|---|---|---|---|---|---|---|---|---|
| 09:15 | 150.0 | 0 | 125.0 | 0 | 275.00 | — | — | — |
| 09:16 | 152.4 | 60,000 | 122.9 | 45,000 | 275.30 | 152.40 | 122.90 | **275.30** |
| 09:17 | 149.8 | 150,000 | 125.6 | 90,000 | 275.40 | 150.84 | 124.25 | **275.09** |
| 09:18 | 147.2 | 195,000 | 128.1 | 165,000 | 275.30 | 150.00 | 126.00 | **276.00** |

(09:17 CE: (152.4·60,000 + 149.8·90,000) ÷ 150,000 = 150.84. 09:18 PE: (122.9·45,000 + 125.6·45,000 + 128.1·75,000) ÷ 165,000 = 126.00.)

### 5.7 PCR intraday

`pcrOi(t) = Σ PE_oi ÷ Σ CE_oi` and `pcrVol(t) = Σ PE_vol ÷ Σ CE_vol` (cumulative day volume), over strikes with both sides non-null at t (all recorded strikes, or the `band` around A(t)). `pcrVolInterval_j = Σ ΔPE_vol ÷ Σ ΔCE_vol` over bucket j; null when the call increment is 0. These are the same functions the S3 job uses (`daily.mjs` now calls them), so the 15:29 point equals the S3 row.

Worked: at 09:59 ΣPE vol 41.2 M, ΣCE vol 38.6 M → pcrVol **1.067**. At 10:04 ΣPE 43.0 M, ΣCE 41.9 M → cumulative **1.026**; the interval ratio (43.0 − 41.2) ÷ (41.9 − 38.6) = 1.8 ÷ 3.3 = **0.545** (the §4.4 example). The PCR OI example is P1-1 §6.8 (**0.933**).

### 5.8 Max pain and largest OI

`maxPain(strikes, ceOi, peOi, ref)`: the array form of `options.js maxPainCurve` (same definition and tie rule: nearest `ref`, then the lower strike), with `ref = fwd ?? spot`. `edge` = the first or last recorded strike. `largestOi`: the strike with the largest CE OI or PE OI (ties nearer `ref`), fields `largestCallOi`/`largestPutOi`, described as "largest call OI"/"largest put OI". The word "wall" is reserved for P1-8's gamma Call/Put Wall. Reference test: P1-1 §6.9 table → **25,100**. A parity test asserts `maxPain` equals `options.maxPainCurve(...).strike` on 200 random demo snapshots.

### 5.9 Build-up per interval

For bucket j, strike K and side s: the leg `{ d = oi_j − oi_{j−1}, oiRef = oi_{j−1}, dLtp = ltp_j − ltp_{j−1}, ltpRef = ltp_{j−1}, v = vol_j − vol_{j−1} }` → `classifyBuildup(leg, { lot, minLots, minOiPct, minPxPct, tick, churnX })`. This is the existing function, moved unchanged into `oi-series.js`. Rule: OI significant when |d| ≥ max(minOiPct% × oiRef, minLots × lot); price significant when |dLtp| ≥ max(minPxPct% × ltpRef, 2 ticks); churn when heavy volume moves neither. Futures: the same rule on the `_und` near-month future (`fut.ltp`, `fut.oi`, `fut.vol`). Summary per bucket: count and |d|/lot per class.

Worked (15m bucket, lot 75, default filter; values from `node` against the current `classifyBuildup`):

| Leg | OI ref → now | d (units) | d % | LTP ref → now | ΔLTP % | v | Class |
|---|---|---|---|---|---|---|---|
| 25200 CE | 6,000,000 → 6,150,000 | +150,000 | +2.50 | 148.6 → 142.4 | −4.17 | 900,000 | **SB** |
| 25200 PE | 4,800,000 → 4,890,000 | +90,000 | +1.88 | 120.0 → 126.5 | +5.42 | 700,000 | **LB** |
| 25000 PE | 7,200,000 → 7,050,000 | −150,000 | −2.08 | 60.0 → 52.1 | −13.17 | 500,000 | **LU** |
| 25400 CE | 5,000,000 → 4,920,000 | −80,000 | −1.60 | 70.0 → 74.5 | +6.43 | 300,000 | **SC** |
| 25300 CE | 2,000,000 → 2,030,000 | +30,000 | +1.50 | 60.0 → 60.05 | +0.08 | 400,000 | **CH** (price below 2 ticks = 0.10; v ≥ 5 × 30,000) |

### 5.10 Straddle chain (A9, client only, from the live chain)

Per strike K with both legs present:
- `straddle = mid(CE) + mid(PE)` (`options.js strikeStraddle`, the restyle team's function, reused).
- `change = (ce.ltp + pe.ltp) − (ce.close + pe.close)` (LTP basis; null without both closes); `changePct = change ÷ (ce.close + pe.close) × 100`.
- `straddleIv`: σ solving `B76_C(F, K, T, σ, r) + B76_P(F, K, T, σ, r) = straddle` by bisection on [0.0001, 5] to 1e−6. The sum is strictly increasing in σ (both vegas > 0). `null` when `straddle ≤ e^(−rT)·|F − K| + 0.025` (at or below discounted intrinsic) or when F or T is missing. `F`, `T`, `r` come from `straddleContext(chain, now)`: `pricing.js` `parityForward` and the vol-time clock context, with `reference.rate()` (a test pins the seam).
- Breakevens at expiry: `K − straddle`, `K + straddle`. `widthPct = straddle ÷ spot × 100`.
- Markers: ATM row (nearest F) and "lowest premium" row (the strike with the smallest straddle; a tie goes to the nearest F).

Worked (F 25,171.51, K 25,150, T 5/365, r 0.065; P1-1 §6.5 legs: C_mid 148.6 → IV 11.72 %, P_mid 126.3 → IV 11.65 %): straddle **274.9**, **straddle IV 11.69 %** (between the two leg IVs, as expected), breakevens **24,875.1 / 25,424.9**, width 274.9 ÷ 25,150.35 = **1.09 %** of spot. Lower bound check: e^(−rT)·|F − K| = 21.49 < 274.9, so it is solvable. With prev closes CE 152.35 and PE 123.15 and LTPs 148.6 and 126.3: change = 274.9 − 275.5 = **−0.6** (−0.22 %).

### 5.11 Daily history stitching (D3 daily)

From `GET /v1/options/daily?underlying=&from=&to=` rows (P1-1): for each date, take the row with the smallest `expiry ≥ date` (nearest expiry). When the chosen expiry changes from one date to the next, emit `roll { date, from, to }`. Series: `pcrOi`, `pcrVolume`, `maxPain`, `spot`. Missing dates break the line. Worked: rows (27 Oct, x 28 Oct), (28 Oct, x 28 Oct), (29 Oct, x 3 Nov) → rolls at 29 Oct "28 Oct → 3 Nov".

### 5.12 Downsampling (MCP and phone)

`downsample(times, values, maxPoints)`: the last value per bucket of `ceil(n / maxPoints)` points. A null bucket stays null. ΔOI is **recomputed** on the downsampled OI, never summed from 1-minute ΔOI, so it stays consistent with the interval rule.

---

## 6. Demo mode

Goal: with `mc-bridge start --demo`, open `#/charts`. Within a few seconds every panel has a full day (P1-1's back-fill since 09:15) and 20 days of daily history. You see at least one ATM roll, all four build-up classes, a VWAP visibly different from the straddle line, and a PCR line that moves. All of this happens without a broker and without touching real data.

Builds on P1-1 §8 (time-varying OI `openInterest(..., t)`, `bidQty`/`askQty`, ±45 strikes, FINNIFTY/MIDCPNIFTY, five stock-option underlyings, `recorder-demo` root, "always open" clock, back-fill). Changes in `demo/demoAdapter.mjs`:

1. **Intraday volume profile.** Cumulative volume to time t is `V(t) = perMinute × lot × [ U(m) + Σ_{blocks ≤ m} 0.35·(unit(token:day:block) − 0.5)·5 ]`, with m = minutes since 09:15 and `U(m) = m + 40·(1 − e^(−m/25)) + 27·(e^((m−375)/30) − e^(−375/30))` (a U-shaped intensity: busy open and close). Each 5-minute block carries a deterministic ±17 % noise term, and a 75-block prefix sum is memoised per (token, IST day). It is monotonic because each block's increment stays > 0 (asserted). `quoteOf().volume` and `candles()` volume both call `volumeBetween(token, a, b)`, so chain volume and 1-minute candles agree (today they do not). Deterministic: the same instant gives the same volume.
2. **OI day stories.** A deterministic day type per (underlying, IST date), `hash32("story:" + u + date) % 4`: `range` (calls above and puts below are written: SB on both sides), `drift-up` (put writing, call short covering), `drift-down` (call writing, put long unwinding) and `quiet`. Implemented as an additive multiplier on P1-1's OI formula, `1 + k·story(strike, right, s(t))`, with |k| ≤ 0.25, rounded to whole lots (OI stays a multiple of lot). Because option prices follow the existing spot waves, combining these with the price moves produces LB, SB, SC and LU across strikes and buckets. On a NIFTY demo expiry day (Tuesday) OI near ATM unwinds after 14:00 (`k` ramps to −0.3), so expiry-day behaviour is visible in back-filled Tuesdays.
3. **Consistent previous close.** `previous_oi` and `previous_close_price` in `fetchOptionChain` are the formula at the previous weekday's 15:30 (P1-1 item 1). The demo recorder writes a `base` line from them at the first slot of each day, so `interval=prev` works on day 1 of a fresh demo install. Back-filled previous days make `prev-recorded` work from the second day.
4. **Daily history.** `demoBackfill.mjs` synthesises S3 rows (one synthetic 15:29 snapshot per chain per day, no S1 written) for `demo.dailyBackfillDays` (20) previous weekdays, `quality: "demo-backfill"`, ≤ 1 s CPU, chunked. The PCR and max-pain daily charts and the roll markers are then visible at once.
5. **Derived lines** are written for back-filled S1 days (P1-1 back-fills today since 09:15 at 1 minute and 2 previous weekdays at 5 minutes), so the 800 ms path is the one exercised in demo too.

The demo plan (P1-1 §5.2) records 1 chain by stream and 14 by REST, refuses BANKEX, and records 5 stocks at 5 minutes. So the catalog shows a refused chain (empty state with reason), a 5-minute stock chain (1m hidden) and 1-minute index chains: every UI state is reachable. The demo banner and "Demo recordings are sample data" footer (P1-1) apply. No `prev-recorded` baseline is ever read from the real `recorder/` folder in demo, and vice versa (`demo.test.mjs`).

Demo acceptance tests (deterministic, fixed dates):
- Over 09:15–15:30 on Mon 19 Oct 2026 for NIFTY nearest expiry ±10 strikes at 15m: every class LB, SB, SC, LU appears at least once, and CH at least once.
- The rolling ATM straddle has ≥ 1 roll on at least one of 19–23 Oct 2026.
- For `S:atm` at 15:29, |VWAP − TWAP| ÷ TWAP ≥ 0.3 % (the volume profile matters).
- Volume is non-decreasing per leg across the day; OI % lot = 0; the S3 15:29 row equals the last `.drv` point.

---

## 7. Dashboard

Shared rules: existing components and tokens only (header note). Every SVG has a text alternative (a summary sentence plus a "Show as table" toggle). Live numbers use `aria-live="off"`. Colour is never the only signal: CE/PE text labels, class letters in the build-up strip, a dashed VWAP plus its legend label, roll markers with text. Touch targets are ≥ 44 px. Reduced motion: no animation is added. All numbers are formatted through `format.js`.

### 7.1 New page `#/charts` ("Live charts", Options group, after "OI Analysis")

`PAGES` entry: `{ id: "charts", label: "Live charts", short: "Charts", icon: <an existing glyph; the restyle team picks>, group: "Options", layout: "desk", title: "OI and straddle charts", sub: "Straddles, strike OI, PCR and build-up through the day, from the Bridge's recordings", render: renderChartsPage }`. It is not in the phone tab bar (it is in the More sheet).

`charts.js` is a **standalone page** (it does not go through `renderDesk`). It has its own compact toolbar and reuses the desk toolbar look through existing classes, so it does not depend on the in-flight `desk.js` rework. The page makes no `/v1/optionchain` calls: everything comes from `/v1/options/series/*`, `/v1/options/daily` and `/v1/options/recorder`.

**Toolbar:** Underlying ▾ and Expiry ▾, both listing **only recorded chains** for the chosen day (from `catalog`). The first load prefers `mcb.dashboard.desk`'s underlying/expiry when they are recorded. There is also a Day ▾ ("Today", then recorded days, newest first, from `catalog.days`), a coverage pill ("Recorded 09:15–10:15 · 3 min missing", or "Not recorded" with the reason) and an "Export" menu (CSV of the visible panel).

**Panels** (`desk-panel` sections; order = default order):

1. **Straddles** (`charts-straddle`).
   - Pair chips: "Rolling ATM" by default, plus up to 5 more. "+ Add" opens a `sheetPopover` with three choices: *Straddle at strike* (strike select, ATM marked), *Rolling strangle* (n steps 1–10), *Strangle* (call strike, put strike). Chips can be removed (×) and reordered by keyboard (Alt+←/→).
   - Each pair is one small multiple: premium line, VWAP dashed line, roll markers (a vertical hairline with the "25150→25200" label in the tooltip), prev-close reference line when available, and a header showing last value, change vs prev close, day high/low and "VWAP 276.00 (approx.)".
   - Controls: `Mid | LTP` basis, `Per unit | Per lot` (× lotSize; display only).
   - Method note link: "How these are calculated" opens a `modal` with §5.4–5.6 in plain words.
2. **Strike OI** (`charts-oi`).
   - Strike picker with three modes, `Strikes | Range | Around ATM`. *Strikes*: chips (≤ 10) plus a "Quick pick" for ATM ±1/±2/±3. *Range*: two strike selects with a strike-count readout (≤ 81). *Around ATM*: a ±n stepper (0–20).
   - Controls: Metric `OI | ΔOI | Premium`; Sides `CE+PE | CE | PE`; Interval segmented `1m 5m 15m 30m 1h · Since open · vs Prev close` (a select on phones). Disabled options carry their reason in `title`: `1m` on stock chains, `vs Prev close` without a baseline ("28 Oct was not recorded and no broker previous OI is available").
   - Rendering: one small multiple per strike with CE and PE lines (or ΔOI bars per bucket: positive above and negative below the zero line, CE and PE side by side with text labels) in OI units or lots (`Lots | Qty` toggle, lots by default as on the OI page). Range/ATM modes show two lines (Σ CE, Σ PE) with the band label.
3. **PCR and max pain** (`charts-pcr`).
   - Two stacked small multiples sharing the time axis: (a) PCR OI line with PCR Vol (cumulative) as a second line, plus a `Vol per interval` toggle; (b) max pain as a step line, with spot as a thin line on the same strike axis and an `edge` marker (hollow point plus a tooltip "max pain at the edge of recorded strikes").
   - Controls: Band `All | ±10 | ±20`, and `Today | 10D | 30D | 90D`. The day ranges switch both charts to the daily history (§5.11) with roll markers.
4. **Build-up timeline** (`charts-buildup`).
   - A strip of rows = strikes (±10 around ATM, ATM row marked, `strikesEach` stepper 5–20) plus a "FUT" row, and columns = buckets.
   - Each cell is a `.obu .obu-XX` chip carrying the class letters (LB/SB/SC/LU/CH) or blank. CE and PE are two half-rows per strike, labelled "CE" and "PE".
   - Controls: Interval `5m 15m 30m 1h` (`1m` behind "More", with the batching note) and "Filter: 10 lots · 1 % · 0.5 %" (opens the same noise-filter fields as the OI page's help, stored separately in `charts.buildup.th`).
   - Column footer: per-bucket counts (n per class). Cell tap opens a popover with the leg's numbers ("25200 CE · 10:00–10:15 · OI +2,000 lots (+2.5 %) · LTP −6.20 (−4.2 %) · Short build-up: price down, OI up").
   - Panel note: "Inferred from OI and price change; not who traded."

Each panel has, in order:
- a head (title and controls);
- the `chartSlot(label)` box, shown 64 px tall with "Chart engine slot · N points ready" (it grows only when the engine mounts);
- the purpose-built SVG (`ts-chart.js`);
- the summary sentence (for example "Rolling ATM straddle 275.0 → 241.6 today (−12.1 %); VWAP 258.4 (approx.); 2 rolls; 3 minutes missing");
- a "Show as table" `details` (newest first, sticky time column, scrolls inside the panel);
- a "CSV" button (the same request with `format=csv`);
- a foot line with coverage and gaps.

**Shared crosshair:** a `scrubber()` (viz.js) on each small multiple. Moving it on one moves the time cursor on every small multiple in the same panel, and the head values show the values at the cursor. Keyboard: ←/→ one point, Home/End, Esc clears. Touch: drag. Each multiple has `role="img"` with an `aria-label`, plus the table.

**Refresh:** when Day = Today and the page is visible, at each `slot + 5 s` (IST minute + 5 s) every visible panel requests `since=<last point time>` and replaces points from `replaceFrom`. When hidden, no requests are made (the `every()` helper in views.js skips hidden tabs). Past days load once. Each panel's state is `loading` (skeleton via `loadingState`) → data, `unavailable` (`emptyState` with `unavailable.detail`, plus a "Data recorder →" link for `not-in-plan`/`refused`/`recorder-off`) or `error` (`errorState` with retry).

**`series()` for the chart engine:** `page.series(panelId)` returns the prepared view model (`{ times, lines: [{ id, label, token, values }], markers: [...] }`). The engine can mount into the slot without new requests.

**Responsive:**
- **Phone (< 720 px):** a panel switcher (`segmented`: Straddles · Strikes · PCR · Build-up) shows one panel at a time; only that panel fetches. Small multiples are 1 column, 120 px tall, axis labels at the start/end only. Controls collapse into one row: the main select (interval or basis), plus ⚙ opening a `sheetPopover` with the rest. Pair and strike chips scroll horizontally inside the panel with an edge fade. The build-up strip has a sticky strike column and scrolls sideways inside its panel (no page scroll), showing the last 8 buckets first, scrolled to the right. Tables open full width. No horizontal page scroll; 16 px gutter.
- **Tablet (720–1099 px):** two panels per row at ≥ 900 px (Straddles | Strikes, PCR | Build-up); otherwise one per row. Small multiples in 2 columns, 140 px tall.
- **Desktop (≥ 1100 px):** Straddles and Strike OI full width with small multiples in 3 columns (160 px); PCR (5fr) beside Build-up (7fr).

**Keyboard:** `1`–`4` focus panels, `i` cycles the interval of the focused panel, `t` toggles its table, `e` exports CSV, `?` opens how-to-read. Shortcuts follow the desk's `onKey` pattern and are ignored while typing in inputs.

### 7.2 OI page (`oi.js`): the timeline panel reads the server

When `GET /v1/options/recorder` (already cached 60 s by P1-1's change) lists the chain:
- the timeline panel requests `/v1/options/series/pcr?interval=1m` (incremental with `since`, every minute) and draws one `ts-chart` small multiple (PCR OI, with max pain as a step line on a second multiple) under the existing `chartSlot`;
- the existing `series()` export now returns server points (same shape `{ t, spot, ceOi, peOi, pcr, maxPain, r1, s1 }`, with r1/s1 from `largestCallOi`/`largestPutOi`);
- `wallMigrationText` reads the server series;
- a link "Open in Live charts →" goes to `#/charts?u=NIFTY&x=2026-11-03`. `charts.js` reads these hash params and then clears them.

When the chain is not recorded, nothing changes from P1-1 behaviour (`oi-store` snapshots and the existing copy). This must be coordinated with `docs/design/oi.md` §7.8: the "Show as table" of the last 10 points there uses this same series.

### 7.3 Chain page: Straddles view (A9; `straddle-chain.js` + a small `desk.js` hook)

- **Toggle:** in the chain panel head, a `segmented("View", [["chain","Chain"],["straddle","Straddles"]])`, saved in `st.cfg.view` (validated by `chainConfig`; default `chain`). The rest of the toolbar (underlying, expiry, ±strikes, search) applies to both views.
- **Table** (`table(columns, rows, …, { mobile: "stack", caption })`), from the same chain object the chain view uses (no new request): Strike · Straddle · Chg · Chg % · Straddle IV · Lower BE · Upper BE · % of spot. The ATM row has `aria-current="true"` and a text "ATM" tag; the lowest-premium row has a text "Lowest" tag. The strike column is sticky. The table scrolls inside its panel. Strike search (`/`) scrolls to and selects the strike.
- **Row action:** Enter/tap opens a `sheetPopover` with the row's numbers, the two leg mids and IVs, "Chart this straddle →" (to `#/charts?u=&x=&pair=S:<K>`), and "Add straddle to Strategy Builder" (the existing multi-select hand-off, with paper as default; nothing is sent).
- **Phone:** columns Strike · Straddle · Chg · IV. The breakevens and % of spot move into the row sheet.
- **Updates:** `draw(chain)` patches rows in place by signature (the same pattern as `oi.js`), so it works with today's 3 s refresh and with P1-4 stream patches.
- **Copy:** the column title for IV says "IV implied by the straddle price (Black-76 on the forward)", and the method line says "Breakevens at expiry, before charges".

`desk.js` change (≈ 20 lines, landed after the restyle team's chain round 2 merges): mount the view, pass the chain on each draw, and save `st.cfg.view`.

### 7.4 `ts-chart.js` (shared SVG for time series)

- Pure part: `scaleTime(times, width)`, `scaleY(values[], height, { zero, pad })`, `pathFor(xs, ys)`. Nulls break the path (`M` restarts); there is no interpolation. Also `barsFor`, `stepPathFor`, `ticksFor` (reusing `niceTicks` from options.js).
- DOM part: `smallMultiple({ title, lines: [{ values, token, dash, label }], bars?, markers?, refLine?, height })` built from `svgEl`, with `legend()` and `scrubber()`. It also provides `classStrip({ rows, buckets, cellText, cellClass })` (an HTML table, not SVG, so text stays selectable and accessible), `dataTable(...)` and `csvButton(url)`.
- `ts-chart.js` already exists (P1-3c created it for `vol-history.js`). This item adds `barsFor`, `stepPathFor` and `classStrip` to it; it never adds a second line helper.

### 7.5 Copy and disclaimers

- Panel foot (all four): "Recorded on this computer from your broker account. Shows position activity, not guaranteed direction."
- Straddles: "Premium history; not a forecast. VWAP is approximate (1-minute samples)."
- Build-up: "Inferred from OI and price change; not who traded."
- PCR/max pain: "Over recorded strikes (±40). Max pain is a settlement where option buyers collect least; not a forecast."
- Global footer (BRD §8.4) unchanged. No "bullish", "bearish", "support", "resistance", "buy", "sell", "rich", "cheap", "signal" or "recommend" in any new string (§9 test).

---

## 8. Rate-limit budget

| Path | Broker calls | Bridge calls |
|---|---|---|
| Series routes (`oi`, `straddle`, `pcr`, `buildup`, `catalog`) | **0**: they read S1/S3 from disk and the day cache | client limiter as usual (default 50 req/s per key) |
| Baseline for `interval=prev` (only when there is no prev-recorded day and no `base` line, and `series.baselineFetch`) | **≤ 1 chain read per (underlying, expiry, day)**, through `marketData.optionChain(…, { accountId: <recorder data account>, priority: "interactive", maxAgeMs: 60000 })`, user-initiated, deduplicated by an in-flight promise, then written as the `base` line. Worst case 18 a day (6 indices × 3 expiries), all from user actions | — |
| Recorder `base` capture | 0 extra: taken from REST chains the recorder already reads (P1-1 REST source) or a user chain found in the cache (P1-1 rule 6) | — |
| Derived line write | 0 broker calls; ≤ 5 ms CPU per minute for 18 chains (81² max-pain loop ≈ 6.5k ops a chain) | — |
| Charts page (visible, Today) | 0 | ≤ 4 series requests a minute (one per visible panel; 1 on phones) + `catalog` every 5 min + `daily` once per load |
| OI page timeline | 0 | 1 `pcr` request a minute while visible |
| Straddle chain view | 0 (reuses the chain the page already loads) | 0 |
| MCP `get_option_series` | 0 | counts toward the key's limiter; ≤ 60 points returned |

User-facing priority is unaffected: the only broker call this item adds is interactive and user-triggered, and it falls under the existing scheduler and policy table (no recorder budget is used). A history-row quota per key is LATER (P1-1); until then responses are bounded by one day per request, ≤ 10 strikes or ≤ 6 pairs, and `series.maxPoints`.

---

## 9. Safety, compliance and honesty gates

| Gate | Where | Test |
|---|---|---|
| Read only: cannot place or prepare orders | `recorder/series/**` imports nothing from `orders/`, `paper/`, `safety/`; no `fetch` | P1-1 `module.test.mjs` import check extended to `series/**` |
| Only one broker call path, user-initiated | baseline read via `marketData` at `interactive`, ≤ 1 per chain-day | `seriesService.test.mjs` (fake marketData counts calls: 1 for two concurrent requests, 0 on the next day's second request) |
| One data account; no pooling across holders | baseline read pinned to the recorder's data account | `seriesService.test.mjs` with two holders |
| Data stays local; exports go to the caller only | no outbound calls; CSV is formula-injection safe (`=`, `+`, `-`, `@` prefixed with `'`) | `csv.test.mjs` |
| Gaps never filled | nulls propagate; paths break; range sums null when any strike missing | `oi-series.test.mjs`, `ts-chart.test.mjs` |
| Inferred data labelled | `inferred: true` on build-up; UI note; VWAP "approx." in label, method and CSV header | `routes.test.mjs`, `charts-model.test.mjs` |
| Baseline honesty | prev-recorded only when it is the previous trading day; never an older day; `no-baseline` otherwise | `seriesService.test.mjs` (yesterday missing → `broker-prev-close` or `no-baseline`, never day-before) |
| Neutral copy (BRD §8.1 RA rules, D7) | new strings in `charts.js`, `charts-model.js`, `straddle-chain.js`, `ts-chart.js`, `series/*.mjs` | `charts-model.test.mjs` greps those files' string literals for bullish, bearish, support, resistance, buy, sell, rich, cheap, signal, recommend (allow-list: the Strategy Builder hand-off label "Add straddle to Strategy Builder") |
| Disclaimers present | panel feet §7.5 | `charts-model.test.mjs` snapshot of foot strings |
| Demo never mixes with real data | demo reads/writes only `recorder-demo`; baselines never cross roots | `demo.test.mjs` |
| Account ids hidden from restricted keys | P1-1 redaction rule on `catalog` and series | `routes.test.mjs` |
| No secrets in new files | `.drv` and `base` lines hold ids only | P1-1 `store.test.mjs` secret scan includes the new files |
| Probabilities | none shown by this item (straddle IV is a model input, not a probability); K6 logging n/a | — |
| Algo framework | not applicable: no orders | — |
| Market-data terms (BRD §8.3) | personal local store; no sharing feature; Sheets via the user's own tunnel and read key (compliance.md caveats) | doc review |

---

## 10. Test plan

Unit (vitest, no network, manual clock from `ratelimit/fake.mjs` where time matters):

| File | Covers |
|---|---|
| `server/bridge/dashboard/oi-series.test.mjs` | §5.1 bucket example (partial flag); §5.2 ΔOI table (+150,000, +75,000), `open` late start, `prev` baseline order; §5.3 range sum 145/340/2.34, null when any strike missing, ATM band moves; §5.4 mid/LTP fallback count; §5.5 hysteresis table (exactly two rolls), multi-step roll, spot fallback; §5.6 VWAP table (275.30, 275.09, 276.00), negative ΔV → 0, gap volume lands on next slot, late start → `vwapPartial`; §5.7 PCR 0.933, 1.067, 1.026, 0.545, zero call increment → null; §5.8 max pain 25,100 and parity with `options.maxPainCurve` on 200 demo snapshots; §5.9 build-up table (SB, LB, LU, SC, CH); futures classification; §5.11 stitching and rolls; §5.12 downsample recomputes ΔOI |
| `server/bridge/dashboard/oi-series.shared.test.mjs` | no `import`, no `document`/`window`/`fetch`/`Date.now`; listed in `DASHBOARD_FILES`; `options.classifyBuildup === oiSeries.classifyBuildup` and `BUILDUP_DEFAULTS` the same object |
| `server/bridge/dashboard/straddle-chain.test.mjs` | §5.10 example: straddle 274.9, IV 11.69 % (± 0.01), BEs 24,875.1/25,424.9, width 1.09 %, change −0.6; null IV at/below intrinsic, one side missing, no forward; ATM and lowest markers and tie rules; `straddleContext` seam pinned; phone column set |
| `server/bridge/dashboard/ts-chart.test.mjs` | `pathFor` breaks on null; scales with constant series (no NaN); bars above/below zero; step path; 6 × 375 points built ≤ 30 ms |
| `server/bridge/dashboard/charts-model.test.mjs` | `chartsConfig` validation (bad prefs → defaults; > 10 strikes trimmed; > 6 pairs trimmed); URL builders; response → view model; summary sentences; table rows newest first; disabled-interval reasons; unavailable → empty-state copy; daily stitching; neutral-copy grep; disclaimers |
| `server/bridge/recorder/series/derive.test.mjs` | `drvLine` from a fixture snapshot equals hand values; gap mirror; `baseFromChain` (`oi − oiChange`, `close`; nulls kept); the 15:29 `drv` equals `daily.mjs` S3 row on a demo day |
| `server/bridge/recorder/series/params.test.mjs` | pair grammar (valid, invalid order, n out of range, duplicates, > 6); strike modes (exactly one); interval vs cadence; `since` parsing |
| `server/bridge/recorder/series/seriesService.test.mjs` | read paths over a fixture day (fake store): oi strikes/range/atm, straddle fixed/rolling/strangle, pcr all/band, buildup with futures; `.drv` derived on first read for an old day and written once (lock: two concurrent reads → one write); `.drv` re-derived when corrupt; cache LRU eviction at `cacheChains`; tail refresh on `recorder.snapshot`; `since` + `replaceFrom`; every `unavailable` reason; stock chain `1m` → 400; baseline order and the single interactive read; two holders |
| `server/bridge/recorder/series/csv.test.mjs` | column sets per route; gap rows; formula-injection guard; file names |
| `server/bridge/recorder/series/routes.test.mjs` | validation errors with `errors[].path`; scope `read`; CSV content type; account-id redaction; demo `meta.demo` |
| `server/bridge/recorder/series/perf.test.mjs` | §3.7: generated 375-slot 162-leg gz day; each route cold ≤ 800 ms (fail), warm ≤ 50 ms |
| `server/bridge/recorder/store.test.mjs` (update) | `strikeSet` projection; `tail` returns only new complete lines and the new offset (torn last line not consumed); `readDerived`; `listDays`; old readers ignore `base` lines |
| `server/bridge/recorder/recorderService.test.mjs` (update) | a `drv` line is written per snapshot and a gap mirror per gap; `base` written once per chain-day from a REST read |
| `server/bridge/demo/demo.test.mjs` (update) | §6 acceptance tests; volume monotonic; candles volume = quote volume over the same span; base line in demo; 20 S3 days |
| `server/bridge/mcp/tools.test.mjs` (update) | `get_option_series` schema; ≤ 60 points; same units as REST |

Contract:
- `core/openapi.test.mjs` passes with the five new paths (scope, stream) and the new schemas.
- A response-schema check: `routes.test.mjs` validates each route's JSON against the OpenAPI schema (the same validator the P1-1 tests use).
- P1-1's OI-unit contract test is unchanged; this item reads units only.

End-to-end (`server/bridge/e2e/series.e2e.test.mjs`, `bootBridge` with `--demo` config and `shiftedClock` at Tue 20 Oct 2026 11:30:58 IST):
1. `GET /v1/options/series/catalog` lists NIFTY nearest expiry at 1-minute cadence, a stock chain at 5 minutes, and `days` with 2 back-filled weekdays.
2. `straddle?pairs=S:atm,G:atm2` returns 136 points from 09:15, with VWAP non-null from 09:16; the response time is ≤ 800 ms.
3. `oi?atm=2&interval=prev` returns `intervalBasis.basis: "prev-recorded"`; `interval=prev` on a fresh root with no back-fill returns `broker-prev-close` (demo base line).
4. `buildup?interval=15m` contains each of LB, SB, SC, LU at least once (§6).
5. After 1 simulated minute, `since=<last>` returns `replaceFrom` and one new point.
6. `pcr` last point equals `GET /v1/options/daily` after the day's S3 job (clock moved to 15:32).
7. The dashboard files are served (`/dashboard/charts.js` 200 with CSP).

Manual check (written up in the PR, with screenshots): `mc-bridge start --demo`, open `#/charts` at 360, 800 and 1280 px. Add a rolling strangle; switch the interval to 15m; open the build-up popover; export CSV; open a back-filled day; then the chain page Straddles view, chart a straddle, and confirm the hand-off. Then the OI page timeline shows the server line and the link.

---

## 11. Migration and back-compat

- Additive only: new routes, new optional config keys (`recorder.series.*`, `recorder.demo.dailyBackfillDays`), a new MCP tool, new dashboard files and one new page. No `/v1` field changes; no new error codes; no new bus topics.
- S1 gains a new line kind (`base`) in the snapshot file and a sibling `.drv` file. P1-1 readers ignore unknown kinds (test added). Rolling back this item leaves harmless extra lines and files; P1-1's retention deletes them with their day folders.
- Days recorded before upgrade get `.drv` files derived on first read. Nothing else is migrated.
- `classifyBuildup`/`BUILDUP_DEFAULTS` move to `oi-series.js` and are re-exported from `options.js` as the same objects, so every current import keeps working. `oi.js`, `desk.js`, `screener.js` and the tests are unchanged by the move.
- The OI page keeps working without the recorder (P1-1 behaviour: `oi-store`). `series()` keeps its shape.
- The chain page defaults to the existing Chain view; Straddles is opt-in via the toggle and remembered.
- `S3` values may change slightly for P1-1 days if the tie rules in `daily.mjs` change when it switches to the shared functions. Both use "nearer forward, then lower strike" (P1-1 §6.9/6.10 and §5.8 here agree), so no change is expected; a test asserts it on the demo days.
- Config schema stays strict: unknown keys under `recorder.series` are errors (ARCHITECTURE §14).

---

## 12. Ordered task list

Each task lands with its tests green. Stop points: after T5 (server maths and reads done), T8 (API complete in demo), T12 (charts page complete), T15 (done). Tasks marked ⏸ wait for the restyle team's merge (R2); do them last or hand them over.

| # | Task | Files | Done when |
|---|---|---|---|
| T1 | Extend P1-1's `oi-series.js`: buckets, ΔOI, strike sets, rolling ATM, straddle/strangle, VWAP, PCR per interval, `classifyBuildup` (moved copy), stitching, downsample | `dashboard/oi-series.js`, `oi-series.test.mjs`, `oi-series.shared.test.mjs` (minus the re-export assertion) | every §5 example passes |
| T2 | Store extensions: `strikeSet`, `tail`, `listDays`, `readDerived`/`appendDerived` | `recorder/store.mjs`, `store.test.mjs` | store tests pass, incl. torn-line tail |
| T3 | Derived and base lines: `derive.mjs`; recorder writes `drv` + gap mirrors + `base`; `daily.mjs` uses shared maths | `recorder/series/derive.mjs`, `derive.test.mjs`, `recorder/recorderService.mjs`, `recorder/daily.mjs` | 15:29 `drv` = S3 row; recorder tests green |
| T4 | Params and pair grammar; config keys | `recorder/series/params.mjs`, `params.test.mjs`, `recorder/config.mjs` | params tests pass; `budgetShare`-style schema checks unchanged |
| T5 | Day cache + `seriesService` (oi, straddle, pcr, buildup, catalog, baselines, unavailable) | `recorder/series/dayCache.mjs`, `seriesService.mjs`, `seriesService.test.mjs` | service tests pass |
| T6 | Routes, CSV, module wiring; OpenAPI (lead) | `recorder/series/routes.mjs`, `csv.mjs`, `routes.test.mjs`, `csv.test.mjs`, `recorder/module.mjs`, `docs/openapi.yaml` | `openapi.test.mjs` and route tests pass |
| T7 | MCP tool | `mcp/tools.mjs`, `tools.test.mjs` | tool test passes |
| T8 | Demo realism: volume profile, day stories, base line, 20-day S3 back-fill, `drv` for back-filled days; perf test | `demo/demoAdapter.mjs`, `recorder/demoBackfill.mjs`, `demo/demo.test.mjs`, `recorder/series/perf.test.mjs` | §6 tests and ≤ 800 ms pass |
| T9 | Extend `ts-chart.js` (bars, step lines, class strip) | `dashboard/ts-chart.js`, `ts-chart.test.mjs` | pure tests pass |
| T10 | `charts-model.js` | `dashboard/charts-model.js`, `charts-model.test.mjs` | model tests, copy grep pass |
| T11 | Charts page: toolbar, Straddles and Strike OI panels, refresh loop, states; `PAGES` entry; `DASHBOARD_FILES` (lead) | `dashboard/charts.js`, `views.js`, `core/app.mjs`, `format.test.mjs` | works in demo at 360/800/1280 px |
| T12 | Charts page: PCR/max pain (intraday + daily) and Build-up strip | `dashboard/charts.js` | works in demo; build-up popover; daily rolls drawn |
| T13 | OI page timeline on server series + link | `dashboard/oi.js` | OI page shows server line in demo; unrecorded chain unchanged |
| T14 ⏸ | Straddle chain view + desk hook; `options.js` re-export of `classifyBuildup`/`BUILDUP_DEFAULTS` (finish `oi-series.shared.test.mjs`) | `dashboard/straddle-chain.js`, `straddle-chain.test.mjs`, `dashboard/desk.js`, `dashboard/options.js` | toggle works; chart hand-off works; re-export identity test passes |
| T15 | E2E + docs: `docs/guides/recorder.md` "Charts and series", `docs/guides/mcp.md`, ARCHITECTURE data layout (`.drv`, `base`), CHANGELOG | `e2e/series.e2e.test.mjs`, docs | `npx vitest run`, `node scripts/check-mjs.mjs`, `npm run typecheck` clean |

---

## 13. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | P1-1 is not merged, or its store API differs from its spec | Medium | High | Hard dependency stated; T2 extends P1-1's store in the same stream; build against a fixture day file; series code talks to the store only through `read/tail/readDerived/listDays`. |
| R2 | Merge conflicts with the restyle team (desk.js has a ~1,000-line uncommitted rework; options.js, oi.js, views.js, app.css are shared) | High | Medium | Standalone `charts.js` page (no `renderDesk`); no CSS of our own beyond layout using existing classes; desk.js and options.js edits are small and last (T14 ⏸); oi.js change confined to the timeline panel and coordinated with `docs/design/oi.md` §7.8. |
| R3 | 1-minute ΔOI and build-up look like signals but reflect exchange batching | High | Medium | Build-up defaults to 15m; `1m` behind "More" with the batching note; `inferred` labels; per-broker OI cadence marked **needs verification** in the guide. |
| R4 | The approximate VWAP is read as the exchange VWAP | Medium | Medium | "approx." in the label, legend, method note and CSV header; method modal; `vwapPartial` on late starts. |
| R5 | Day-cache memory on small machines (≈ 6 MB per chain-day) | Low | Medium | `cacheChains` default 6 (≈ 36 MB), configurable; Float64Array columns; PCR reads `.drv` without the cache. |
| R6 | 800 ms target missed on slow disks or large stock days | Low | Medium | `.drv` fast path for PCR; one-pass decode; perf test in CI; `since` keeps refreshes small. |
| R7 | Existing OI page copy ("support", "resistance", "bullish", "bearish" in titles and `BUILDUP_READ`) conflicts with the neutral-copy rule the new panels follow | Existing | Medium (RA rules) | Not changed here (out of scope, restyle-owned page); flagged as LATER with `docs/design/oi.md`; the new panels use class names and mechanical definitions only. |
| R8 | Two time-series SVG helpers | Resolved | — | One helper, `ts-chart.js`, created by P1-3c and extended here (§7.4). |
| R9 | Stream numbering | Resolved | — | The recorder is S17 (`docs/spec/README.md`); `x-stream: S17` in §4.8 |
| R10 | Straddle IV clock weights are assumptions | Certain | Low | One seam (`straddleContext`) on `pricing.js`; method note prints the weights. |
| R11 | Demo OI "stories" change numbers that existing demo-dependent tests (OI page, screener) assert | Medium | Low | Stories are multiplicative within ±25 % and lot-rounded; run the full suite in T8; update fixtures only where a test asserts exact demo OI. |
| R12 | The owner's chart engine needs a different series shape | Medium | Low | `series(panelId)` is a thin adapter over the view model; engines plug into `chartSlot`; the API is engine-independent. |
| R13 | A baseline from `oi − oiChange` is wrong for brokers whose `oiChange` is not versus the previous close | Medium | Medium | `prevCloseBasis` is shown; prev-recorded wins whenever yesterday was recorded; per-broker semantics **needs verification** and is listed in the guide; contract fixtures for Dhan/Zerodha/Upstox checked in T3. |

---

## 14. Open questions for the owner

1. **Placement.** This spec adds a new "Live charts" page rather than tabs on the OI page, to keep the OI page fast and its round-2 design intact. If the owner prefers tabs, the panels move into `oi.js` unchanged; only §7.1's page shell changes.
2. **Pair limits.** The BRD says 6 pairs. This spec allows mixing fixed and rolling pairs within those 6. Confirm whether cross-expiry pairs (calendars) should be pulled into this round (§2.2 says LATER).
3. **Default build-up interval.** This spec uses 15m (honest given OI batching). Sensibull-style users may expect 5m; it is a one-line config default.
