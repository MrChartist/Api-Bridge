# Spec P1-8: Modelled exposure and key levels (D6, D7)

Status: ready to build · Owner: tech lead, Options desk · Date: 29 Oct 2026 · Stream: **S21 (new) "Exposure"** (final id from the stream table in `docs/spec/README.md`)
Builds on: BRD `docs/brd/options-platform.md` §1.4 (D1, D5, D7, D8), §3.D rows D6/D7, §4 item 3, §5.1–5.5 (stores S1, S3, S4; exposure engine), §6.1 P1-8 (acceptance criteria), §7.1–7.9, §8.1, §8.4, §8.5, §10.1, §10.2 (GEX, zero-gamma).
Hard dependency: **P1-1** (recorder: S1 snapshots feed the minute loop, `at=` reads and the 10-day level history). Live exposure works without it through the REST fallback (§3.6), so the page is usable before P1-1 merges, but acceptance criterion 5 ("10-day history") is met only with P1-1.
Also required and landed earlier in the build order (`docs/spec/README.md`): **P1-3** (vol-time clock, `dashboard/pricing.js`, `ivModel=b76-forward` chains), **P1-2** (risk-free rate, sessions, expiry calendar) and **P1-13a** participants (store S4, `deps.participants`, specified in `docs/spec/p1-12-guard-participants.md` §4.2.1 and built in its own session before this item). The fallbacks below apply only when one of those services is turned off (stub).
Consumers: P1-9 (levels on the payoff and price-slice rows), P1-11 (alert conditions "wall shift" and "zero-gamma cross" subscribe to `exposure.levels`), Phase 2 D8 (pressure heatmap reuses `exposure/greeks.mjs` and the per-side curves).

> **Naming.** "Store S1/S3/S4" are the BRD's stores (§5.2), not build streams. "Call Wall"/"Put Wall" (capitalised) are the **gamma** levels this spec adds. The existing chain and OI-page tags that mark the largest **OI** strike are renamed "Most call OI" / "Most put OI" here (§6.4), so the two never share a name.

> **Styling.** Another team is restyling the dashboard (near-black theme, colour tokens, motion). This spec names panels, classes and states and uses only existing components (`card`, `table`, `segmented`, `sheetPopover`, `alertBox`, `emptyState`, `chartSlot`, `desk-stat`) and the shared tokens in `palette.css` (`--call`, `--put`, ink and muted-ink tokens). It specifies no colours, sizes, fonts or motion. New SVG elements carry classes only; their look comes from the restyle.

> **Not advice.** Everything here is a model of hedging flows under a stated assumption. India has no designated delta-hedging dealers and the holder of any contract is unknown. All copy is descriptive (§9).

> **Build order and shared foundations.** This spec is steps 17–18 (P1-8a server T1–T11, P1-8b dashboard T12–T16) in `docs/spec/README.md`, after P1-1a, P1-3b, P1-13a. It uses, and does not rebuild, the F0 foundations listed there: final stream ids, bus topics and error codes pre-registered in core, the opt-in `options` MCP toolset (every MCP tool in this spec goes there), `demo/routes.mjs` plus the OpenAPI demo-only list, `server/lib/jsonl.mjs` (append, torn-line tolerance, last-wins, quarantine of corrupt files), `ratelimit/backgroundGate.mjs` (the one ≤ 50 % background-budget check), `core/ownership.mjs`, and `dashboard/copyRules.mjs` (the one banned-word list). Where this text and README disagree, README's build order and shared-module owners win.

---

## 1. Summary

A new server module `exposure` computes, for the six index underlyings, **per-strike modelled exposure** (GEX, DEX, vanna, charm) from open interest in units, Black-76 Greeks on the forward, and a **sign model** the user switches (US-style, All OI short, Naive), optionally multiplied by a **participant scale** from NSE participant OI. From the same per-strike numbers it derives four **key levels**: Call Wall, Put Wall, Zero-gamma (re-priced root search) and HVL (strike-level sign flip). It reads the recorder's latest snapshot (zero broker calls) and falls back to a background-priority chain read. It recomputes once a minute from `recorder.snapshot`, emits `exposure.levels` on change, and writes one daily row per underlying and scope so a 10-day level history exists. Programs read `GET /v1/options/exposure` and `GET /v1/options/levels` and an MCP tool. The dashboard gains an **Exposure** page (mirrored SVG bars, level tiles, gamma-vs-price curve, history table, method note), level markers on the chain rows and the strategy payoff, and one summary-strip tile. Demo mode gives the demo chains a realistic writer structure, synthetic participant OI and 10 days of seeded history, so every feature can be seen and tested without a broker.

---

## 2. Scope

### 2.1 MUST (this round)

| # | Item | BRD P1-8 criterion |
|---|---|---|
| M1 | Module `server/bridge/exposure/` (stream S21), service `deps.exposure`, config section `exposure`, start/stop | all |
| M2 | Pure Greeks on the forward: Δ, Γ, vanna, charm (`greeks.mjs`), consistent with the IV's own clock | AC2 |
| M3 | Pure profile: per-strike, per-side GEX/DEX/vanna/charm in ₹ crore, totals, sign models, participant scale (`profile.mjs`) | AC1, AC2, AC3 |
| M4 | Pure levels: Call Wall, Put Wall, Zero-gamma (grid ±5 %, 0.05 % steps, then bisection), HVL (`levels.mjs`) | AC4 |
| M5 | Scopes: one expiry (incl. 0DTE weekly), `front`, and `all` = every expiry the recorder records (default nearest 3, max 4) | AC1 |
| M6 | Sources: recorder latest (≤ 90 s) → REST background chain; `at=` from S1 | AC1 |
| M7 | Participant-scale provider over `deps.participants` (P1-13a, landed earlier); demo provider in demo; "unavailable" with reason when the service is off or stale; BSE always unavailable | AC3 |
| M8 | Minute loop on `recorder.snapshot`; bus topic `exposure.levels` (on change) | P1-11 hook |
| M9 | Daily store `dataDir/exposure/daily/<U>.jsonl` at 15:31 IST + catch-up from S1 for the last 10 trading days; read-time fill of P1-1's reserved S3 columns `gex`/`zeroGamma` | AC5 |
| M10 | Routes `GET /v1/options/exposure`, `GET /v1/options/levels` (+ CSV), OpenAPI, MCP tool `get_exposure` | API |
| M11 | Dashboard: page `#/exposure` (`exposure.js`); chain row markers + summary tile (`desk.js`); payoff vertical rules (`strategy.js`, `payoff.js`, `options.js` model); OI page link; OI-wall tag renames | AC1, AC5, AC7 |
| M12 | Demo: writer-structured OI anchored to the previous close, 0DTE day shape, demo participant OI, 10-day seeded history, `at=` for any past instant | demo realism |
| M13 | Hand-computed fixture tests: per-strike GEX within 0.5 %, zero-gamma within 0.1 % of the forward (§7) | AC6 |
| M14 | Neutral copy, disclaimers (§8.4 texts), method note on every response and panel | AC2, AC7 |
| M15 | Docs: `docs/guides/exposure.md` (method, assumptions, limits), ARCHITECTURE module map and data layout, STREAMS S21, example config, CHANGELOG, `docs/guides/mcp.md` | — |

### 2.2 LATER (named so nobody builds it now)

| Item | Why later | Goes with |
|---|---|---|
| Expiry-day pressure heatmap (strike × minute) | D8, Phase 2. `greeks.mjs` and per-side curves are written to be reused | P2 D8 |
| Intraday level path chart (zero-gamma vs spot through the day) | Needs the owner's chart engine; the API `at=` gives any minute now | P1-7 chart engine / P2 |
| Far-dated expiries in "all" (beyond the recorder's set) | Needs either 10+ extra chain reads a minute or full-OI EOD rows from bhavcopy; P1-3 stores only near-ATM rows. "All" states its coverage instead (§2.3) | P2 (bhavcopy full-OI store) |
| Stock-option exposure | OI-unit verification per stock, thin chains, 5-min cadence; levels on stocks are mostly noise | P2 |
| Exposure inside the settlement window on expiry day | Averaging settlement changes the hedge maths; we exclude rather than mislead (§2.3) | P2 D8 |
| Per-side participant weights (separate CE/PE scale) | BRD wording is one global weight; per-side weights would reshape the profile | Product decision (OQ3) |
| Server-side user default for the sign model via API | Config file only; per-viewer choice lives in desk prefs | Later round |
| Calibration of levels (how often price respected a level) | K6 needs ≥ 60 expiries of history | P2 K6 |
| Compat/Sheets path for the two routes | §7.8 parity; CSV and MCP ship now | Next round |
| `exposure.levels` on the WebSocket (AsyncAPI) | Bus is internal; P1-11 subscribes on the bus | P1-11 / later |

### 2.3 What our data cannot do (and the honest fallback)

| Limitation | Why | Fallback in this spec |
|---|---|---|
| Who holds each contract is unknown; India has no designated hedging dealers | Exchanges publish OI per contract, not per holder; participant OI (S4) is aggregated over all strikes and expiries | Sign model is a visible switch; every number carries `assumption`; the §8.4 disclaimer is on every panel and response |
| The BRD's "US-style" and "Naive" give **identical numbers** | SpotGamma's assumption is customers sell calls and buy puts, so the modelled hedger is long calls, short puts: signs (+CE, −PE), which is exactly "calls +, puts −" | Both positions ship as the BRD asks; picking Naive shows "Same signs as US-style; no holder claim". OQ1 asks the owner to replace or drop one (the API enum is open, so a change is additive) |
| Participant scale cannot set a sign per strike | S4 is one row per participant per instrument class, summed over every strike, expiry and NSE index | One global weight w ∈ [0, 1] multiplies every ₹ value. **Levels never move with it** (scaling does not move argmax or sign changes), and the note says so |
| No participant data for SENSEX and BANKEX | BSE publishes no participant-wise OI file (needs verification) | Switch disabled with "Not available for BSE indices (no BSE participant file)" |
| S4 may be empty (NSE archive downloads off, or no file fetched yet) | P1-13a only fetches with the user's archive consent (P1-2) | Provider interface (§3.5). Without data: `available: false, reason: "NO_PARTICIPANT_DATA"` (or `SOURCE_OFF`), "Turn on NSE archive downloads to fetch participant OI". Demo: synthetic rows, labelled |
| S4 is yesterday's file | NSE publishes after close (about 19:00 IST, needs verification) | Weight carries `asOfDate`; older than 1 trading day → `PARTICIPANT_STALE`, scale off |
| "All expiries" cannot mean every listed expiry | NIFTY lists 15+ expiries; the recorder records the nearest 3 (max 4); reading the rest every minute would break the 50 % background budget on most brokers | `all` = the recorded expiries, with `coverage.expiriesUsed` / `expiriesListed` and the copy "Includes 3 of 14 listed expiries (the recorded ones)". Without the recorder, at most `allExpiries.maxRest` (3) chains |
| Strikes outside the recorded band are missing | Recorder keeps ±40 (indices) | Zero-gamma grid is clipped to the strike range covered; `coverage` gives the band; far-OTM gamma is small, but the note says "over recorded strikes" |
| OI unit not verified for a broker (`oiUnitVerified: false`, P1-1 §10) | A lots-vs-units mix-up multiplies every ₹ value by the lot size (BRD §8.5 risk "High") | Levels are unit-free and still shown. ₹ sizes become `null` with `OI_UNIT_UNVERIFIED`; bars are drawn on a relative scale with "Relative sizes: this broker's OI unit is not verified". Config `showUnverifiedSizes` (default false) |
| Inside the expiry-day settlement window the 0DTE Greeks stop meaning "hedge now" | Index options settle on the average of the last 30 minutes (needs verification) | From window start (default 15:00 IST on the expiry day), that expiry is excluded: single-expiry scope returns `available: false, reason: "SETTLING"`; `all` excludes it and lists it in `coverage.excludedExpiries` |
| Legs with no usable IV (no quote, below intrinsic, settling) | Pricing returns `null` | Leg excluded; its OI is counted in `coverage.excludedOi` with reasons; never a substituted IV |
| Clock weights are assumptions; a recorded day may carry an older model version | Recorder snapshots carry `t` (vol-time), `tcal` and `model` (`b76-vt1`) | Greeks always use the **T the IV was solved with** (Γ and Δ depend only on σ²T, so GEX and DEX are clock-free given a consistent pair). Vanna and charm are clock-relative and labelled with the clock in use |
| Levels history before install | Nobody sells Indian intraday chains | History shows "n of 10 days"; catch-up uses S1 days only; gaps are gaps |

### 2.4 Open questions (default chosen so the build is not blocked)

| # | Question | Default in this spec |
|---|---|---|
| OQ1 | BRD "US-style" = "Naive" numerically (§2.3). Keep both, drop Naive, or replace Naive with "Writers short calls, long puts" (−CE, +PE)? | Keep both as the BRD says; Naive shows the "same signs" note |
| OQ2 | HVL has no public standard definition (MenthorQ's is not published). Accept "strike-level net-GEX sign flip nearest the forward"? | Yes (§7.6), named "HVL (strike flip)" in the method note |
| OQ3 | Hedger groups for the participant scale: FII + Pro (writers), or Pro only? | FII + Pro, config `participantScale.hedgers` |
| OQ4 | Default sign model: US-style (familiar, has a zero-gamma) or All OI short (closer to Indian reality, never has a zero-gamma) | US-style, labelled "assumption: US convention" |

---

## 3. Architecture

### 3.1 Module map

New, `server/bridge/exposure/` (stream S21):

```
module.mjs            defineModule({ name: "exposure", stream: "S21", configKey: "exposure", services: { exposure } }), ROUTES
config.mjs            EXPOSURE_CONFIG_SCHEMA (zod .strict()), parseExposureConfig
greeks.mjs            pure: legGreeks({ F, K, sigma, T, Tcal, rate, units, right }) -> { delta, gamma, vanna, charm }
profile.mjs           pure: buildProfile(chains, { sign, weight, greeks, showSizes }) -> { strikes[], totals, coverage }
levels.mjs            pure: walls(profile), gammaCurve(chains, grid) -> per-side arrays, zeroGamma(curve, sign), hvl(profile)
signs.mjs             data + pure: SIGN_MODELS { us, short, naive } -> { CE, PE, label, note, sameAs }
participants.mjs      pure: participantWeight(rows, { hedgers, exchange, today }) ; provider: createParticipantsProvider(deps)
sources.mjs           chain inputs: fromRecorder(latest|at), fromRest(marketData), toInputs(chain|snapshot) -> ExposureInput
store.mjs             JSONL daily rows (append, last-wins, torn-line tolerant, retention, compaction)
exposureService.mjs   createExposureService(deps): profile(), levels(), dailyFor(), status(); minute loop; daily job; cache
demoParticipants.mjs  demo S4 rows (deterministic per IST date), NSE only
demoSeed.mjs          demo history seeding (10 weekdays) through the real compute path
routes.mjs            REST handlers (JSON + CSV)
fake.mjs              in-memory exposure service for other streams' tests
__fixtures__/nifty_2026-10-29T10-00.json   the §7 hand-computed chain (8 strikes)
*.test.mjs            §11
```

New dashboard file: `server/bridge/dashboard/exposure.js` (page + pure view-models; added to `DASHBOARD_FILES` in `core/app.mjs` and to the file list in `format.test.mjs`).

Changed files:

| File | Change | Owner |
|---|---|---|
| `core/contracts.mjs` | `SERVICE_CONTRACTS.exposure` (§3.3) | lead |
| `core/builtinModules.mjs` | `exposure` after `recorder` (and after `vol` when present) | lead |
| `core/eventBus.mjs` | TOPICS `exposure.levels` + JSDoc payload | lead |
| `core/app.mjs` | `DASHBOARD_FILES["exposure.js"]` | lead |
| `recorder/routes.mjs` (P1-1) | `/v1/options/daily`: fill reserved `gex`, `zeroGamma` from `deps.exposure.dailyFor()` when the service is real (3 lines) | S21 with S17 review |
| `demo/demoAdapter.mjs` | Writer-structured OI (§5.1) | S21 |
| `mcp/tools.mjs` | Tool `get_exposure` | S21 with S11 review |
| `dashboard/views.js` | PAGES entry `exposure` after `oi` | S21 |
| `dashboard/desk.js` | `kind === "exposure"` wiring; chain tags + summary tile; OI-wall tag renames and copy | S21 |
| `dashboard/options.js` | `payoffModel` accepts `levels`; pure `levelMarks(levels, strikes)`; glossary strings | S21 |
| `dashboard/payoff.js` | Draw level rules | S21 |
| `dashboard/strategy.js` | Load levels; builder setting `levels` | S21 |
| `dashboard/oi.js` | "Modelled exposure →" link in the Walls block head; tag title copy (no "support"/"resistance") | S21, coordinate `docs/design/oi.md` |
| `docs/openapi.yaml` | §4.4 | lead merges |
| `docs/ARCHITECTURE.md`, `docs/STREAMS.md`, `bridge.config.example.json`, `CHANGELOG.md` | M15 | S21 |

`USED_SERVICES = ["marketData", "recorder", "vol", "reference", "participants", "symbols", "scheduler"]`, each optional except `marketData` (stub services are detected with the existing `isStub` check and treated as absent). A test asserts no file in `exposure/` imports from `orders/`, `paper/`, `safety/`, and none calls `fetch`. The module can never place an order.

### 3.2 Data flow

```
recorder.snapshot (bus, each minute) ─┐
GET /v1/options/exposure ─────────────┼─> sources.mjs ─> ExposureInput[] ─> profile.mjs ─┬─> levels.mjs ─> response / cache
GET /v1/options/levels  ──────────────┘   (recorder latest ≤ 90 s,          (per strike,  │   (walls, curve, zero-gamma, HVL)
                                            else marketData.optionChain       per side)    │
                                            background, maxAgeMs 60 s)                    └─> exposure.levels (on change)
daily 15:31 IST ─> last S1 snapshot of the day per chain ─> profile + levels for every sign model ─> store (daily/<U>.jsonl)
participants provider (P1-13a | demo | none) ─> weight w (yesterday's file) ─> multiplies ₹ values only
```

**ExposureInput** (one per expiry, built from either source; all prices per unit, OI in units):

```js
{ underlying: "NIFTY", exchange: "NFO", expiry: "2026-11-03",
  asOf: 1761712200000, source: "recorder" | "rest" | "rest-cache" | "demo" | "demo-seed",
  quality: "live" | "demo" | "demo-backfill", partial: false, oiUnitVerified: true,
  spot: 25120.5, forward: 25142.49, rate: 0.065, rateSource: "reference" | "config",
  clock: { model: "b76-vt1", T: 0.0147289, Tcal: 0.0143265, units: 3.96134, Y: 268.95 },
  settling: false,                       // true inside the expiry-day settlement window
  strikes: [24800, ...],
  sigma: [0.146, ...],                   // per-strike smile IV (decimal): OTM side (PE below F, CE at/above), other side if missing, null if both missing
  ceOi: [1300000, ...], peOi: [9750000, ...],
  excluded: { NO_IV: 0, SETTLING: 0 } }
```

- One σ per strike for both legs (the OTM side's IV). That is how sticky-strike smile pricing works and avoids noisy ITM IVs; put-call parity makes Γ equal for CE and PE at the same σ.
- `clock.T` is the T the IV was solved with (recorder snapshot `t`; or the chain's `pricing.clock.T` when P1-3's `ivModel=b76-forward` exists). `Tcal` is for the discount factor only. If P1-3's `deps.vol.clock()` exists, `units` and `Y` come from it; otherwise `Y = 365`, `units = T × 365` and the clock is labelled "calendar (interim)".

### 3.3 Service contract (core change: the lead lands it)

```js
exposure: {
  iface: "ExposureService",
  stream: "S21",
  requires: ["marketData"],
  methods: ["profile", "levels", "dailyFor", "status"],
},
```

| Method | Returns |
|---|---|
| `profile({ underlying, expiry, sign, participantScale, greeks, strikes, include, at }, ctx)` | The §4.1 `data` object |
| `levels({ underlying, expiry, sign, participantScale, days }, ctx)` | The §4.2 `data` object |
| `dailyFor({ underlying, date, expiry, sign })` | One stored daily row or `null` (used by `/v1/options/daily`) |
| `status()` | `{ enabled, underlyings, lastLoop: { at, ms }, lastDaily, participants: { available, reason, asOfDate }, store: { bytes, rows } }` |

### 3.4 Schedulers

All timers use `deps.clock` (manual clock in tests); all times IST; session times from `reference.session()` when present, else the recorder's interim session, else 09:15–15:30 labelled.

| Timer / trigger | When | What |
|---|---|---|
| Minute loop | Each `recorder.snapshot` event for a configured underlying (coalesced: at most one compute per underlying per 30 s, in its own `setImmediate`) | Rebuild the cached `front` and `all` profiles for the default sign; recompute levels for all sign models (cheap, §3.7); emit `exposure.levels` when any level changed (§3.8) |
| Daily job | `dailyAt` (15:31 IST, after the recorder's 15:29 slot); retry 15:45 | For each underlying: last S1 snapshot of the day per recorded expiry → rows for scopes `front`, `all` and each recorded expiry, every sign model, with participant weight if available. Without the recorder: chains read with `maxAgeMs: 600000` so P1-3's 15:25 capture chains are reused (0 calls), else 1 background read per chain |
| Catch-up | On start (after 20 s) | For each of the last `historyDays` trading days with S1 data and no row: compute from that day's last snapshot (`source: "recorder"`, `late: true`) |
| Compaction / retention | 02:40 IST | Rewrite a file when > 20 % of lines are superseded; drop rows older than `retentionDays` |
| Demo seed | First start in demo when `dataDir/exposure-demo/` is empty | §5.4 |

No timer runs when `exposure.enabled` is false. Nothing runs on non-trading days except retention and catch-up.

### 3.5 Participant-scale provider

```js
// participants.mjs
createParticipantsProvider({ participants, demo, clock }) -> {
  latest({ exchange: "NSE" }): Promise<{ available: true, asOfDate: "2026-10-28", source: "nse-participant-oi" | "demo",
      rows: [{ participant: "FII"|"PRO"|"CLIENT"|"DII", instrument: "IDX_CE"|"IDX_PE", long: number, short: number }] }
    | { available: false, reason: "NO_PARTICIPANT_DATA" | "PARTICIPANT_STALE" | "NOT_FOR_BSE", detail: string }>
}
```

- Real mode: `deps.participants.latest({ exchange: "NSE" })` (P1-13a, `p1-12-guard-participants.md` §4.2.1; it returns exactly the shape above). A stub service gives `NO_PARTICIPANT_DATA`.
- Demo: `demoParticipants.mjs`.
- BSE underlyings (SENSEX, BANKEX): always `NOT_FOR_BSE`.
- Stale: `asOfDate` older than the previous trading day → `PARTICIPANT_STALE`.
- Units: contracts as published; only ratios are used, so units cancel.

### 3.6 Source selection (per expiry)

1. `at` given → recorder `read({ underlying, expiry, from: at − 59 s, to: at, limit: 1 })` (latest snapshot at or before `at`, at most 1 minute old). None → `NOT_RECORDED`. Demo: if not recorded, build the chain synthetically for that instant (§5.3), `source: "demo"`.
2. Recorder has the chain in its plan and its in-memory latest is ≤ `recorderMaxAgeSeconds` (90) old → use it (0 broker calls).
3. Else `marketData.optionChain({ underlying, expiry, strikes: restStrikes, greeks: false, ivModel: "b76-forward" when supported }, { priority: "background", maxAgeMs: liveTtlSeconds × 1000 })`. A chain the user's page fetched in the last 60 s answers from cache. On `UPSTREAM_RATE_LIMITED` or timeout, serve the last cached profile with `stale: true`, or `available: false, reason: "NO_CHAIN"` if none.
4. IV for REST chains: always read with `ivModel=b76-forward`, so every leg's `iv` and the chain's `pricing.clock.T` come from P1-3's `pricing.js` and the IV/T pair is consistent. The exposure module has no IV solver of its own. Broker-supplied IVs are never used (their T and model are unknown).

The selected account follows the recorder's data account, or for REST the market module's normal choice; responses carry `broker` and never `accountId` (P1-1 §4 redaction rule).

### 3.7 Compute cost and layout

- Per expiry, `levels.gammaCurve` evaluates, for each grid point x (201 points on ±5 %) and each strike, Γ at F·(1+x) **once per side-independent strike** (Γ is the same for CE and PE at one σ) and accumulates two arrays: `G_CE[x] = Σ OI_CE·Γ·F_x²·0.01` and `G_PE[x] = Σ OI_PE·Γ·F_x²·0.01`. Any sign model's curve is `s_CE·G_CE + s_PE·G_PE`, so all three models cost one pass.
- "All" sums the per-expiry arrays (each expiry shifted by the same x on its own forward).
- Cost: 81 strikes × 201 points ≈ 16,300 Γ evaluations per expiry; 18 recorded chains ≈ 0.3 M per minute ≈ 20–40 ms in V8. Under the BRD §7.1 recorder CPU budget; each underlying in its own `setImmediate`.
- Cache: key `(underlying, scope, asOfSlot)`; holds per-side profiles and curves. Sign model, participant weight, greeks subset and strike band are applied on read (microseconds). Cache size ≤ 6 underlyings × 5 scopes × 2 slots.

### 3.8 `exposure.levels` bus event

```
exposure.levels { underlying, scope: "front"|"all"|"<expiry>", expiry, sign, at, forward,
                  callWall, putWall, zeroGamma, hvl,           // numbers or null
                  previous: { callWall, putWall, zeroGamma, hvl }, changed: ["callWall", ...] }
```

Emitted from the minute loop only, for `front` and `all`, for every sign model whose levels changed: a wall moved to another strike, or zero-gamma/HVL moved by ≥ `emitMinMovePct` (0.1 %) of the forward or appeared/disappeared. No account ids, no OI sizes. P1-11 consumes it.

### 3.9 Storage on disk

```
<dataDir>/exposure/                    (mode 0700; demo uses <dataDir>/exposure-demo/, never mixed)
  state.json                           { lastDaily, lastCatchUp, corruptLines, demoSeededFor }
  daily/NIFTY.jsonl                    one line per (date, scope); last line for a key wins
```

Daily row (values from the §7 fixture for illustration; one line, ~1.2 KB; 6 underlyings × 5 scopes × 250 days ≈ 9 MB a year):

```json
{ "v": 1, "date": "2026-10-29", "u": "NIFTY", "scope": "front", "expiries": ["2026-11-03"],
  "asOf": "2026-10-29T15:29:01.412+05:30", "source": "recorder", "quality": "live", "late": false,
  "spot": 25120.5, "forward": 25142.49, "clock": "b76-vt1", "oiUnitVerified": true,
  "models": {
    "us":    { "callWall": 25300, "putWall": 25000, "zeroGamma": 25065.80, "hvl": 25156.45, "net": { "gex": 2941.26, "dex": 93524.9, "vanna": 1853.77, "charm": -3035.80 } },
    "short": { "callWall": 25300, "putWall": 25000, "zeroGamma": null, "hvl": null, "net": { "gex": -54137.32, "dex": -2498.7, "vanna": -449.75, "charm": 459.52 } } },
  "participant": { "weight": 0.13721, "asOfDate": "2026-10-28", "source": "nse-participant-oi" },
  "coverage": { "strikes": 81, "from": 23150, "to": 27150, "excludedOiPct": 0.4, "expiriesListed": 14 } }
```

- `naive` is not stored (it equals `us`; the reader maps it). Values in ₹ crore, 2 dp; `null` sizes when OI units are unverified.
- Same append/torn-line/last-wins rules as P1-3 §2.3 and P1-1 §3.4. A corrupt line is skipped and counted; it never stops the service.
- No account ids, tokens or broker credentials are written (test).

### 3.10 Config (`exposure` section, all optional; zod `.strict()`)

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Read-only module; on by default |
| `underlyings` | `["NIFTY","BANKNIFTY","FINNIFTY","MIDCPNIFTY","SENSEX","BANKEX"]` | Index options only this round; others → `NOT_SUPPORTED` |
| `defaultSign` | `"us"` | `us` \| `short` \| `naive` (OQ4) |
| `zeroGamma.rangePct` | `5` | 1–15. Grid half-width |
| `zeroGamma.stepPct` | `0.05` | 0.01–0.5 |
| `zeroGamma.tolPct` | `0.0005` | Bisection stop (of the forward) |
| `allExpiries.maxRest` | `3` | Chains read by REST for `all` when there is no recorder (1–4) |
| `restStrikes` | `40` | Strikes each side on REST reads (1–60) |
| `liveTtlSeconds` | `60` | Cache and `maxAgeMs` on REST reads (15–300) |
| `recorderMaxAgeSeconds` | `90` | Older recorder data falls through to REST |
| `participantScale.hedgers` | `["FII","PRO"]` | Subset of `FII`,`PRO`,`CLIENT`,`DII` (OQ3) |
| `participantScale.maxAgeTradingDays` | `1` | |
| (no `settlementWindowMinutes` key) | — | The window is P1-3's `vol.clock.settlementWindowMinutes.index`; one setting for the clock, exposure and the settlement estimate (P1-9) |
| `showUnverifiedSizes` | `false` | Show ₹ sizes when `oiUnitVerified` is false |
| `emitMinMovePct` | `0.1` | §3.8 |
| `dailyAt` | `"15:31"` | IST |
| `historyDays` | `10` | 1–60 (catch-up depth and default `days`) |
| `retentionDays` | `3650` | |
| `demo.seedDays` | `10` | Demo only |

Not configurable on purpose: the GEX formula, units, the sign-model definitions, the level definitions (they are the method note).

---

## 4. API changes

All routes: module `exposure`, `x-stream: S21`, scope `read`, JSON `{ data, meta }`, errors in the existing Problem shape. Nothing here can place an order, change config or enable live trading. Units: OI in units; money in ₹ **crore** (1 crore = 10,000,000) to 3 dp; levels in index points; times ISO-8601 `+05:30`. "No data" is not an error: 200 with `available: false`, `reason`, `detail` (D5).

Reasons (open enum): `NOT_SUPPORTED`, `NO_CHAIN`, `NO_OI`, `NO_FORWARD`, `NOT_RECORDED`, `SETTLING`, `NOT_LISTED_IN_DEMO`, `DISABLED`.

Common 400 `VALIDATION_FAILED`: bad `underlying` (`^[A-Z0-9&-]{1,30}$`), `expiry` not a date / `front` / `all`, unknown `sign`, `greeks` item, `include` item, `strikes` out of 1–60, `days` out of 0–60, `at` unparsable or in the future, `format` not `json|csv`. 401/403/429 as usual.

### 4.1 `GET /v1/options/exposure`

| Param | Required | Format | Default |
|---|---|---|---|
| `underlying` | yes | index symbol | |
| `expiry` | no | `YYYY-MM-DD` \| `front` \| `all` | `front` |
| `sign` | no | `us` \| `short` \| `naive` | config `defaultSign` |
| `participantScale` | no | boolean | `false` |
| `greeks` | no | comma list of `gex,dex,vanna,charm` | all four |
| `strikes` | no | strikes each side of the forward's ATM to return (computation always uses every available strike) | all |
| `include` | no | comma list of `curve` | none |
| `at` | no | IST date-time or epoch (same parser as `/v1/history`) | now |
| `format` | no | `json` \| `csv` | `json` |

200 (`expiry=2026-11-03`, the §7 fixture, `include=curve`, trimmed to 2 strikes and 3 curve points):

```json
{
  "data": {
    "available": true, "reason": null,
    "underlying": "NIFTY", "exchange": "NFO", "scope": "expiry", "expiry": "2026-11-03", "expiries": ["2026-11-03"],
    "asOf": "2026-10-29T10:00:01.412+05:30", "source": "recorder", "broker": "dhan", "quality": "live", "stale": false,
    "spot": 25120.5, "forward": 25142.49,
    "rate": { "value": 0.065, "source": "reference" },
    "clock": { "model": "b76-vt1", "mode": "weighted", "T": 0.0147289, "Tcal": 0.0143265, "units": 3.96134, "yearUnits": 268.95 },
    "assumption": {
      "sign": "us", "label": "US-style", "signs": { "CE": 1, "PE": -1 }, "sameAs": null,
      "text": "Modelled hedger is long calls and short puts (the US convention where customers sell calls and buy puts). An assumption, not observed positions.",
      "participantScale": { "on": false, "available": true, "weight": null, "asOfDate": "2026-10-28", "hedgers": ["FII", "PRO"], "reason": null }
    },
    "units": { "oi": "units", "gex": "INR crore per 1% move of the forward", "dex": "INR crore of delta notional", "vanna": "INR crore of delta notional per 1 vol point", "charm": "INR crore of delta notional per trading day of vol-time", "level": "index points (forward)" },
    "strikes": [
      { "strike": 25300,
        "ce": { "oi": 9100000, "iv": 12.1, "gex": 5690.569, "dex": 7726.07, "vanna": 298.78, "charm": -456.31 },
        "pe": { "oi": 2600000, "iv": 12.1, "gex": -1625.877, "dex": 4323.52, "vanna": -85.36, "charm": 130.37 },
        "net": { "gex": 4064.692, "dex": 12049.58, "vanna": 213.41, "charm": -325.94 } },
      { "strike": 25000,
        "ce": { "oi": 4550000, "iv": 13.3, "gex": 2647.395, "dex": 7322.02, "vanna": -110.54, "charm": 185.56 },
        "pe": { "oi": 11050000, "iv": 13.3, "gex": -6429.387, "dex": 9974.55, "vanna": 268.45, "charm": -450.65 },
        "net": { "gex": -3781.992, "dex": 17296.56, "vanna": 157.91, "charm": -265.09 } }
    ],
    "totals": { "gex": 2941.255, "ceGex": 28539.287, "peGex": -25598.032, "dex": 93524.91, "vanna": 1853.77, "charm": -3035.80 },
    "levels": {
      "callWall": { "strike": 25300, "gex": 5690.569, "oi": 9100000, "largestOiStrike": 25500 },
      "putWall": { "strike": 25000, "gex": -6429.387, "oi": 11050000, "largestOiStrike": 25000 },
      "zeroGamma": { "available": true, "level": 25065.80, "movePct": -0.3050, "spotEquivalent": 25043.87, "roots": [25065.80], "reason": null },
      "hvl": { "available": true, "level": 25156.45, "between": [25100, 25200], "flips": [25156.45], "reason": null }
    },
    "curve": [ { "movePct": -0.35, "forward": 25054.49, "gex": -419.5 }, { "movePct": -0.30, "forward": 25067.06, "gex": 47.3 }, { "movePct": 0, "forward": 25142.49, "gex": 2941.255 } ],
    "coverage": { "strikes": 81, "from": 23150, "to": 27150, "legsUsed": 162, "legsExcluded": 0, "excludedOi": { "ce": 0, "pe": 0 }, "excludedReasons": {}, "excludedExpiries": [], "expiriesUsed": 1, "expiriesListed": 14, "gridPct": [-5, 5], "oiUnitVerified": true },
    "warnings": [],
    "method": {
      "gex": "GEX per strike = OI (units) × Γ × F² × 0.01 × sign, in ₹ crore per 1% move of the forward. Γ from Black-76 on the forward, discounted (df = e^(−r·T_cal)).",
      "dex": "DEX = OI × Δ × F × sign. Vanna = OI × ∂Δ/∂σ × 0.01 × F × sign (per vol point). Charm = OI × ∂Δ/∂t × F × sign, per trading day of vol-time.",
      "iv": "One IV per strike: the out-of-the-money side (put below the forward, call at or above), held fixed (sticky-strike).",
      "zeroGamma": "The forward level where total modelled GEX changes sign when every Γ is recomputed at that level with IV and time held fixed. Searched on ±5% in 0.05% steps, then refined; the root nearest the forward is shown.",
      "hvl": "HVL (strike flip): where per-strike net GEX at today's forward changes sign between adjacent strikes, nearest the forward, interpolated.",
      "walls": "Call Wall: strike with the largest modelled call gamma. Put Wall: largest modelled put gamma. They do not depend on the sign model.",
      "participantScale": "NSE participant OI is summed over all strikes, expiries and NSE indices. It can only scale sizes; it never moves a level. Not available for SENSEX and BANKEX.",
      "coverage": "Over recorded strikes 23,150–27,150 and 1 of 14 listed expiries."
    },
    "disclaimer": "Modelled from open interest under the selected assumption. Actual positions are unknown, and India has no designated hedging dealers."
  },
  "meta": { "requestId": "req_…" }
}
```

Notes:
- `ce.gex` is reported **with the sign applied** (so `net = ce + pe` for every Greek). `ce.dex` and `pe.dex` in the example: the put's Δ is negative and its sign −1, so its DEX is positive under US-style.
- `sameAs: "us"` and `text` "Same signs as US-style; shown because many tools use calls +, puts − without a holder model." when `sign=naive`.
- `participantScale=true`: every ₹ value is multiplied by `weight`; `assumption.participantScale` carries `weight`, the per-side figures (`netShortCe`, `netShortPe`, `totalCe`, `totalPe`), `asOfDate` and `source`. When unavailable the request still succeeds, the scale is off, and `participantScale.reason` says why.
- `oiUnitVerified: false` and `showUnverifiedSizes: false`: every ₹ field is `null`, `strikes[].*.rel` (−1…1, value / max |value| on that side) is added for drawing, `warnings: ["OI_UNIT_UNVERIFIED"]`; levels are unaffected.
- `format=csv`: one row per (strike, side ∈ CE, PE, NET) with columns `asOf,underlying,scope,expiries,sign,weight,strike,side,oi,iv,gex,dex,vanna,charm`; then level rows with `side=LEVEL` and the level name in `strike`'s place. Filename `NIFTY_2026-11-03_exposure_us.csv`.
- The response for `expiry=all` uses `scope: "all"`, `expiry: null`, `expiries: [...]`; per-strike rows sum all expiries at that strike; `forward` and `movePct` refer to the **front** included expiry, and the curve shifts every expiry's forward by the same %.

### 4.2 `GET /v1/options/levels`

Query: `underlying` (required), `expiry` (`front` default \| `all` \| date), `sign`, `participantScale` (affects only `netGex` sizes), `days` (0–60, default `historyDays`), `format`.

```json
{
  "data": {
    "available": true, "underlying": "NIFTY", "scope": "front", "sign": "us",
    "current": { "asOf": "2026-10-29T10:00:01.412+05:30", "forward": 25142.49, "spot": 25120.5,
      "callWall": 25300, "putWall": 25000, "zeroGamma": 25065.80, "hvl": 25156.45, "netGex": 2941.255,
      "largestCallOi": 25500, "largestPutOi": 25000 },
    "history": [
      { "date": "2026-10-28", "expiries": ["2026-11-03"], "asOf": "2026-10-28T15:29:01+05:30", "quality": "live", "spot": 25088.1, "forward": 25110.3,
        "callWall": 25300, "putWall": 25000, "zeroGamma": 25041.5, "hvl": 25120.0, "netGex": 2410.7 },
      { "date": "2026-10-27", "missing": true, "reason": "NOT_RECORDED" }
    ],
    "coverage": { "days": 10, "rows": 7, "missingDates": ["2026-10-27", "2026-10-21", "2026-10-20"] },
    "method": { "...": "same keys as /exposure" },
    "disclaimer": "Calculated from your inputs and market data. Not a recommendation. Modelled from open interest under the selected assumption. Actual positions are unknown, and India has no designated hedging dealers."
  },
  "meta": { "requestId": "req_…" }
}
```

`days=0` returns `current` only (the chain page and builder use this; served from the minute-loop cache in ≤ 5 ms). History is newest first, one row per trading day in range, missing days explicit. `history[].zeroGamma` is `null` with `zeroGammaReason` when the day had no sign change. CSV: one row per day.

### 4.3 MCP tool `get_exposure` (read)

Inputs `underlying`, `expiry?` (default `front`), `sign?`, `participantScale?`, `strikes?` (default 10, max 20), `history?` (boolean, default false → adds 10-day levels). Output: `available`, `assumption`, `levels`, `totals`, the ±`strikes` rows (gex and dex only), `disclaimer`, `method.gex`. Same units as REST. Listed in `docs/guides/mcp.md`. Read keys only (no admin needed); the tool cannot reach any write path.

### 4.4 `docs/openapi.yaml` additions

Tag: reuse `Options data` (added by P1-1); if P1-1 has not merged, add it with the P1-1 description. Paths go after `/v1/options/daily`.

```yaml
  /v1/options/exposure:
    get:
      tags: [Options data]
      operationId: getOptionExposure
      summary: Modelled dealer exposure (GEX, DEX, vanna, charm) per strike, totals and key levels, under a stated sign assumption
      description: >-
        Modelled from open interest in units under the selected sign assumption. Actual positions are unknown and India has no
        designated hedging dealers. Money in INR crore. Not a recommendation.
      x-stream: S21
      x-scope: read
      parameters:
        - { name: underlying, in: query, required: true, schema: { type: string, maxLength: 30, pattern: "^[A-Z0-9&-]{1,30}$" } }
        - { name: expiry, in: query, schema: { type: string, default: front, pattern: "^(front|all|\\d{4}-\\d{2}-\\d{2})$" } }
        - { name: sign, in: query, schema: { type: string, enum: [us, short, naive] }, description: "Open enum. Default from config (us)." }
        - { name: participantScale, in: query, schema: { type: boolean, default: false } }
        - { name: greeks, in: query, schema: { type: string, default: "gex,dex,vanna,charm", pattern: "^(gex|dex|vanna|charm)(,(gex|dex|vanna|charm))*$" } }
        - { name: strikes, in: query, schema: { type: integer, minimum: 1, maximum: 60 } }
        - { name: include, in: query, schema: { type: string, pattern: "^(curve)(,(curve))*$" } }
        - { name: at, in: query, schema: { type: string }, description: "IST date-time or epoch seconds; reads the recorded snapshot at or up to 1 minute before it." }
        - { name: format, in: query, schema: { type: string, enum: [json, csv], default: json } }
      responses:
        "200":
          description: Exposure profile (CSV when format=csv). available=false with a reason when it cannot be computed.
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { $ref: "#/components/schemas/ExposureProfile" }
                  meta: { $ref: "#/components/schemas/Meta" }
            text/csv:
              schema: { type: string }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }

  /v1/options/levels:
    get:
      tags: [Options data]
      operationId: getOptionLevels
      summary: Current modelled key levels (Call Wall, Put Wall, zero-gamma, HVL) and their daily history
      x-stream: S21
      x-scope: read
      parameters:
        - { name: underlying, in: query, required: true, schema: { type: string, maxLength: 30, pattern: "^[A-Z0-9&-]{1,30}$" } }
        - { name: expiry, in: query, schema: { type: string, default: front, pattern: "^(front|all|\\d{4}-\\d{2}-\\d{2})$" } }
        - { name: sign, in: query, schema: { type: string, enum: [us, short, naive] } }
        - { name: participantScale, in: query, schema: { type: boolean, default: false } }
        - { name: days, in: query, schema: { type: integer, minimum: 0, maximum: 60, default: 10 } }
        - { name: format, in: query, schema: { type: string, enum: [json, csv], default: json } }
      responses:
        "200":
          description: Levels now and per trading day.
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { $ref: "#/components/schemas/ExposureLevelsPage" }
                  meta: { $ref: "#/components/schemas/Meta" }
            text/csv:
              schema: { type: string }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }

components:
  schemas:
    ExposureGreeks:
      type: object
      description: INR crore, sign applied; null when OI units are unverified. `rel` only when sizes are null.
      properties:
        oi: { type: [integer, "null"], description: "Units." }
        iv: { type: [number, "null"], description: "Percent." }
        gex: { type: [number, "null"] }
        dex: { type: [number, "null"] }
        vanna: { type: [number, "null"] }
        charm: { type: [number, "null"] }
        rel: { type: [object, "null"], additionalProperties: { type: number, minimum: -1, maximum: 1 } }
    ExposureStrikeRow:
      type: object
      required: [strike, ce, pe, net]
      properties:
        strike: { type: number }
        ce: { $ref: "#/components/schemas/ExposureGreeks" }
        pe: { $ref: "#/components/schemas/ExposureGreeks" }
        net: { $ref: "#/components/schemas/ExposureGreeks" }
    ExposureAssumption:
      type: object
      required: [sign, label, signs, text, participantScale]
      properties:
        sign: { type: string, enum: [us, short, naive], description: "Open enum." }
        label: { type: string }
        signs: { type: object, properties: { CE: { type: integer, enum: [-1, 1] }, PE: { type: integer, enum: [-1, 1] } } }
        sameAs: { type: [string, "null"] }
        text: { type: string }
        participantScale:
          type: object
          properties:
            on: { type: boolean }
            available: { type: boolean }
            weight: { type: [number, "null"], minimum: 0, maximum: 1 }
            asOfDate: { type: [string, "null"], format: date }
            hedgers: { type: array, items: { type: string } }
            source: { type: [string, "null"] }
            netShortCe: { type: [number, "null"] }
            netShortPe: { type: [number, "null"] }
            totalCe: { type: [number, "null"] }
            totalPe: { type: [number, "null"] }
            reason: { type: [string, "null"], enum: [NO_PARTICIPANT_DATA, PARTICIPANT_STALE, NOT_FOR_BSE, null], description: "Open enum." }
    ExposureLevel:
      type: object
      properties:
        available: { type: boolean }
        level: { type: [number, "null"] }
        strike: { type: [number, "null"] }
        movePct: { type: [number, "null"] }
        spotEquivalent: { type: [number, "null"] }
        between: { type: [array, "null"], items: { type: number } }
        roots: { type: array, items: { type: number } }
        flips: { type: array, items: { type: number } }
        gex: { type: [number, "null"] }
        oi: { type: [integer, "null"] }
        largestOiStrike: { type: [number, "null"] }
        reason: { type: [string, "null"], description: "Open enum: NO_SIGN_CHANGE_IN_RANGE, NO_STRIKE_FLIP, NO_OI." }
    ExposureLevels:
      type: object
      properties:
        callWall: { $ref: "#/components/schemas/ExposureLevel" }
        putWall: { $ref: "#/components/schemas/ExposureLevel" }
        zeroGamma: { $ref: "#/components/schemas/ExposureLevel" }
        hvl: { $ref: "#/components/schemas/ExposureLevel" }
    ExposureProfile:
      type: object
      required: [available, underlying, scope, assumption, units, disclaimer]
      properties:
        available: { type: boolean }
        reason: { type: [string, "null"], description: "Open enum: NOT_SUPPORTED, NO_CHAIN, NO_OI, NO_FORWARD, NOT_RECORDED, SETTLING, NOT_LISTED_IN_DEMO, DISABLED." }
        detail: { type: [string, "null"] }
        underlying: { type: string }
        exchange: { type: [string, "null"] }
        scope: { type: string, enum: [expiry, front, all] }
        expiry: { type: [string, "null"], format: date }
        expiries: { type: array, items: { type: string, format: date } }
        asOf: { type: [string, "null"], format: date-time }
        source: { type: [string, "null"], description: "Open enum: recorder, rest, rest-cache, demo, demo-seed." }
        broker: { type: [string, "null"] }
        quality: { type: [string, "null"] }
        stale: { type: boolean }
        spot: { type: [number, "null"] }
        forward: { type: [number, "null"] }
        rate: { type: object, properties: { value: { type: number, description: "Decimal." }, source: { type: string } } }
        clock: { type: object, properties: { model: { type: string }, mode: { type: string }, T: { type: number }, Tcal: { type: number }, units: { type: number }, yearUnits: { type: number } } }
        assumption: { $ref: "#/components/schemas/ExposureAssumption" }
        units: { type: object, additionalProperties: { type: string } }
        strikes: { type: array, items: { $ref: "#/components/schemas/ExposureStrikeRow" } }
        totals: { type: object, additionalProperties: { type: [number, "null"] } }
        levels: { $ref: "#/components/schemas/ExposureLevels" }
        curve: { type: array, items: { type: object, properties: { movePct: { type: number }, forward: { type: number }, gex: { type: [number, "null"] } } } }
        coverage: { type: object }
        warnings: { type: array, items: { type: string }, description: "Open enum: OI_UNIT_UNVERIFIED, PARTIAL_SNAPSHOT, INTERIM_CLOCK, STALE." }
        method: { type: object, additionalProperties: { type: string } }
        disclaimer: { type: string }
    ExposureLevelsPage:
      type: object
      required: [available, underlying, scope, sign, history, coverage, disclaimer]
      properties:
        available: { type: boolean }
        reason: { type: [string, "null"] }
        underlying: { type: string }
        scope: { type: string }
        sign: { type: string }
        current: { type: [object, "null"] }
        history:
          type: array
          items:
            type: object
            required: [date]
            properties:
              date: { type: string, format: date }
              missing: { type: boolean }
              reason: { type: [string, "null"] }
              expiries: { type: array, items: { type: string, format: date } }
              asOf: { type: string, format: date-time }
              quality: { type: string }
              spot: { type: [number, "null"] }
              forward: { type: [number, "null"] }
              callWall: { type: [number, "null"] }
              putWall: { type: [number, "null"] }
              zeroGamma: { type: [number, "null"] }
              zeroGammaReason: { type: [string, "null"] }
              hvl: { type: [number, "null"] }
              netGex: { type: [number, "null"] }
        coverage: { type: object }
        method: { type: object, additionalProperties: { type: string } }
        disclaimer: { type: string }
```

P1-1's `OptionDailyRow.gex` and `.zeroGamma` change from `type: "null"` ("Reserved for P1-8") to `type: [number, "null"]` with descriptions "Net modelled GEX for this expiry under the US-style assumption, INR crore per 1%" and "Zero-gamma forward level, US-style; null when no sign change". That widens the type (additive within `/v1`).

AsyncAPI: no change (the bus topic is internal).

---

## 5. Demo mode

Goal: `mc-bridge start --demo` shows every exposure feature within seconds, on any day and at any hour, without a broker and without touching real data.

### 5.1 Demo adapter (`demo/demoAdapter.mjs`)

Today `openInterest(u, spot, strike, right, expiry)` is a Gaussian centred on the **current** spot, so walls and zero-gamma would follow the price tick by tick, which no real market does. Change (on top of P1-1 M13's time-varying OI, which multiplies whatever this returns):

1. **Anchor.** `anchor(u, expiry, istDate)` = previous session close (`spotAt` at the previous 15:30 IST) rounded to `2 × step`. Fixed for the day, so levels are sticky intraday and drift day to day.
2. **Writer structure.** Per (underlying, expiry, IST date), from `unit()`: call-writing centre `Cc = anchor × (1 + c)`, c ∈ [1.0 %, 2.8 %]; put-writing centre `Cp = anchor × (1 − p)`, p ∈ [0.8 %, 2.6 %]; widths `w = step × (6 + 4·unit)`.
   `lots_CE(K) = base × [0.25·e^(−((K−anchor)/(2.5w))²) + 1.0·e^(−((K−Cc)/w)²)] × round(K) × noise`
   `lots_PE(K) = base × [0.25·e^(−((K−anchor)/(2.5w))²) + 1.1·e^(−((K−Cp)/w)²)] × round(K) × noise`
   with the existing round-strike multipliers (×1.8 at 10-step strikes, ×1.2 at 2-step) and `noise ∈ [0.85, 1.15]`. Result: the largest call OI usually sits on a far round strike while the Call Wall (gamma) sits nearer the forward (the §7 lesson), and under US-style the zero-gamma lands between Cp and Cc.
3. **Expiry-day shape.** On an expiry's own day the ATM hump weight rises 0.25 → 0.6 (straddle writing), so 0DTE profiles look different on NIFTY Tuesdays and SENSEX Thursdays.
4. **Far expiries** (≥ 20 days): base × 1.4 and round-strike multiplier × 1.5 (positional OI at round numbers).
5. OI stays a whole multiple of the lot (units) and `previous_oi` comes from the same function at the previous close (P1-1 rule).

`spotAt` is not changed, so every other page's screenshots and tests are unaffected. A demo test asserts: for 20 instants over 5 demo days and NIFTY/BANKNIFTY/SENSEX front expiries, US-style zero-gamma exists within ±5 %, the Call Wall is above the anchor, the Put Wall below, and walls do not change between 10:00 and 14:00 on one day.

### 5.2 Demo participant OI (`exposure/demoParticipants.mjs`)

Deterministic rows per weekday (IST date) for `IDX_CE` and `IDX_PE`, participants CLIENT/DII/FII/PRO, totals balanced (Σ long = Σ short per instrument). Hedger (FII + PRO) net short share swings 5–25 % with a 9-day cycle. One weekday in seven has FII + PRO net **long** calls (so `netShortCe < 0`), which exercises the clamp and its copy. `source: "demo"`; NSE only (SENSEX/BANKEX show `NOT_FOR_BSE` as in real mode).

### 5.3 Demo `at=` for any instant

In demo, `at` reads the demo recorder (`<dataDir>/recorder-demo/`) when the minute is recorded; otherwise the input is built synthetically for that instant from the adapter's pure functions (`quoteOf`/`priceOf` at `at`; P1-3's `demoChainAt` when present), `source: "demo"`. So "NIFTY 0DTE at 14:30 last Tuesday" can be viewed on any day. Future `at` is a 400 in demo as in real mode.

### 5.4 Seeded history (`exposure/demoSeed.mjs`)

On first demo start (or empty `exposure-demo/`), in `setImmediate` chunks (≤ 1 s CPU): for each demo index and the previous `demo.seedDays` (10) weekdays, build the 15:29 IST inputs for that day's recorded expiries with the same synthetic builder, run the **real** `profile.mjs`/`levels.mjs`, and append daily rows with `quality: "demo-backfill"`, `source: "demo-seed"`. Day −6 is left missing (reason `NOT_RECORDED`) so the history gap is visible. Real mode never reads `exposure-demo/`.

### 5.5 Demo coverage of states

| State | How to see it in demo |
|---|---|
| Normal profile, all four Greeks, three sign models | `#/exposure`, NIFTY, any time |
| All OI short → no zero-gamma | Sign switch → "All OI short" |
| Participant scale on / clamp / BSE unavailable | NIFTY toggle on; the weekly clamp day; SENSEX |
| `all` scope with coverage line | Scope "All recorded" |
| 0DTE profile and settlement exclusion | NIFTY on a Tuesday, or `at=` a past Tuesday 14:30 and 15:10 |
| OI unit unverified | Demo-only query `demoUnverified=1` on both routes (ignored outside demo): sizes null, relative bars |
| BANKEX not offered | BANKEX → `NOT_LISTED_IN_DEMO` |
| 10-day history with a gap | Levels history panel |

---

## 6. Dashboard

Only existing components and shared tokens; all numbers through `format.js`; all maths in pure, node-tested functions (`exposure.js` view-models and `options.js`). New classes: `exp-*`, `lvl-*`. No new colours or motion.

### 6.1 New page `#/exposure` ("Exposure", Options group, after OI Analysis)

`views.js` PAGES entry: `{ id: "exposure", label: "Exposure", icon: "bars", group: "Options", layout: "desk", title: "Modelled exposure", sub: "Modelled gamma, delta, vanna and charm by strike, with key levels, under an assumption you choose", render: renderExposurePage }`. `desk.js` gains `kind === "exposure"` the same way as `vol` (own panels, no shared summary strip, no chain table). For this kind the desk loads expiries and the spot quote only (no `/v1/optionchain` of its own) and refreshes every 60 s (30 s → 300 s when the market is closed, as `CLOSED_REFRESH_MS` scaled); the page reads `GET /v1/options/exposure?…&include=curve` and `GET /v1/options/levels?…&days=10` (history once per 5 minutes).

Underlying picker: the six indices only; non-index underlyings in the desk list are shown disabled with "Exposure is computed for index options".

Desk prefs key `exposure` (validated like `oiConfig`): `{ greek: "gex", scope: "expiry", sign: null /* server default */, pscale: false, band: "20", view: "split" }`.

Panels, top to bottom:

1. **Assumption bar** (always visible above the numbers, never collapsed): `segmented` Sign model `US-style · All OI short · Naive`; switch "Participant scale" with the weight when on ("× 0.137, FII + Pro net short, 28 Oct") or disabled with the reason; one sentence `assumption.text`; Naive adds "Same signs as US-style; no holder claim". Changing it re-reads the profile (cheap: cached server-side).
2. **Level tiles** (`desk-stat` row): Call Wall `25,300` (sub "Most call OI 25,500" when different), Put Wall `25,000`, Zero-gamma `25,066` (sub "−0.31 % from forward"; "None in ±5 %" when null), HVL `25,156` (sub "between 25,100 and 25,200"), Net GEX `₹2,941 cr / 1 %` (sub "₹404 cr scaled" when the scale is on; "Relative only" when sizes are null). Every tile `title` is the method sentence. Tap a level tile → the bars scroll to that strike and the level rule pulses via the restyle's existing focus treatment (no new motion).
3. **Controls row**: `segmented` Greek `GEX · DEX · Vanna · Charm`; `segmented` Scope `This expiry · All recorded`; `segmented` View `Calls | Puts · Net`; band `±10 · ±20 · ±40`; `CSV` button (`format=csv`); `Table` toggle.
4. **Mirrored bars** (purpose-built SVG, `exposure.js drawBars`, ≤ 200 lines): one row per strike, descending (same orientation as the OI ladder). Split view: call value bar extends left from a centre axis, put value bar right, value text at the bar end; Net view: one bar left/right of the axis by sign. Bars use `--call`/`--put` tokens in split view and the ink token by sign in net view, plus a sign glyph in the text (colour never the only signal, BRD §7.4). Horizontal rules with labels for Forward, Call Wall, Put Wall, Zero-gamma, HVL (`lvl-fwd`, `lvl-cw`, `lvl-pw`, `lvl-zg`, `lvl-hvl`); the zero-gamma and HVL rules sit at their interpolated price between rows. Hover/tap a row: popover with strike, OI both sides, IV, and the four Greeks both sides; "Open in chain" (existing `openInChain`). x-scale: symmetric, max |value| in band; "Relative sizes" axis label when sizes are null. Keyboard: the SVG is focusable, ↑/↓ move a row highlight, Enter opens the popover.
5. **Gamma vs price** (small SVG line, `drawCurve`, ≤ 120 lines): total modelled GEX across −5 %…+5 % of the forward (`curve`), zero line, current-forward marker, zero-gamma root dot; under All OI short the line stays below zero and the caption says "No sign change within ±5 %". Hidden for Greeks other than GEX.
6. **Levels history** (`chartSlot("Key levels over 10 days")` for the owner's engine, plus the §10.1 fallback): a table date · spot close · Put Wall · Zero-gamma · HVL · Call Wall · Net GEX · quality, with missing days as rows reading "Not recorded"; per-column 10-point SVG sparklines in the header; CSV. "n of 10 days" when short.
7. **Method note** (collapsible card, closed by default on phone, open on desktop first visit): every `method` string, the inputs line ("Forward 25,142.49 · T 3.96 trading days (weighted clock) · rate 6.50 % · IV: OTM side per strike · OI in units · source: recorder 10:00:01 · broker Dhan"), coverage line, warnings, and both disclaimers (§9).
8. **Empty and unavailable states** (`emptyState`): `NOT_SUPPORTED`, `NO_CHAIN` ("No chain from your data account yet"), `SETTLING` ("Today's expiry is inside its settlement window (from 15:00). Choose All recorded or a later expiry."), `NOT_LISTED_IN_DEMO`.

Text alternative (BRD §7.4): one sentence under the bars, e.g. "Under the US-style assumption, modelled call gamma is largest at 25,300 and put gamma at 25,000; total modelled gamma changes sign at 25,066, 0.31 % below the forward." Live numbers `aria-live="off"`.

Responsive:
- **Phone (< 720 px)**: assumption bar first, segmented controls wrap to two rows (44 px targets); tiles in the scrolling KPI row; bars full width with band default ±10, value text inside bars hidden (shown in the row popover, opened as a bottom sheet); curve 140 px tall under the bars; history as stacked cards (date, ZG, CW, PW); no horizontal page scroll.
- **Tablet (720–1099 px)**: tiles one row; bars full width (band ±20); curve and history side by side below.
- **Desktop (≥ 1100 px)**: bars (2/3 width) beside a column with the curve and the method note (1/3); history full width below; band ±20 default, ±40 available.

### 6.2 Option Chain (`desk.js`)

- **Row markers** (`tagsFor`): after max pain, new tags when `cfg().tags.levels` (default **on** for the six indices; Customise switch "Modelled levels (gamma)"): `["lcw", "Call Wall", "Largest modelled call gamma (US-style assumption) · Exposure →"]`, `["lpw", "Put Wall", …]`. Zero-gamma and HVL are prices, not strikes: they tag the nearest strike row with `["lzg", "Zero-γ 25,066", "Modelled gamma changes sign at 25,066 (between 25,050 and 25,100)"]` and `["lhvl", "HVL 25,156", …]`. Tag priority: ATM > Max pain > Call/Put Wall > Most OI > Zero-γ > HVL > ±1σ > ±2σ.
- **Renamed OI tags** (text only, keys unchanged so saved prefs keep working): "Call wall" → "Most call OI", "Put wall" → "Most put OI"; titles drop "resistance"/"support": "Strike with the most call OI of the 81 loaded". Same rename on the summary-strip tiles `cw`/`pw` (labels "Most call OI"/"Most put OI"). Coordinate with `docs/design/chain.md` and the restyle team (copy only).
- **Summary strip**: one new tile `lv` "Modelled levels": value `ZG 25,066`, sub `CW 25,300 · PW 25,000`; title "Modelled from OI under US-style; tap for the Exposure page". Not shown for non-index underlyings or when `available: false`.
- Data: `GET /v1/options/levels?underlying&expiry=<selected>&days=0&sign=<desk pref or default>` every 60 s while the chain is visible (the desk's `every()` already skips hidden tabs). 0 broker calls with the recorder.
- Phone: tags collapse to the existing first-tag-plus-count pattern; the tile sits after PCR in the scroll row.

### 6.3 Strategy Builder payoff (`strategy.js`, `payoff.js`, `options.js`)

- `options.js`: `payoffModel(legs, m)` accepts `m.levels = { callWall, putWall, zeroGamma, hvl }` and returns `levels: [{ x, kind, label }]` for those inside the x-range (pure; tested). New pure `levelMarks(levels, strikes)` for the chain (nearest row, between-row text).
- `payoff.js`: vertical rules `line.lvl.lvl-<kind>` with a short top label ("CW", "PW", "ZG", "HVL"), patched like the existing markers; legend item "Modelled levels" only when present; hover over a rule shows the full label and "Modelled, not a forecast".
- `strategy.js`: reads `/v1/options/levels?days=0` for the builder's underlying and first expiry every 60 s; `strategyConfig` gains `levels: true` with a settings switch "Show modelled levels". Nothing about levels changes any metric, PoP, button or order.

### 6.4 OI page (`oi.js`)

Walls block head gains a text link "Modelled exposure →" (`#/exposure`). Ladder tag titles change from "(resistance)/(support)" to neutral wording; the walls block keeps its OI-based meaning and title "Most OI". Copy change coordinated with `docs/design/oi.md`; no layout change.

### 6.5 Glossary (K3)

`options.js GLOSSARY` entries (hover on every label): GEX, DEX, Vanna, Charm, Sign model (with the three definitions), Participant scale, Call Wall, Put Wall, Zero-gamma, HVL, "Most call/put OI". Each entry is one or two descriptive sentences; the neutral-copy test covers them.

---

## 7. Formulas and worked examples

All pure; each worked example is a reference-value test. Notation: F forward, K strike, σ IV (decimal), T vol-time in years (the T the IV was solved with), T_cal calendar years (discounting only), r rate, df = e^(−r·T_cal), n/N standard normal pdf/cdf, OI in **units**, Y year units of the clock (268.95 weighted, 365 calendar), U = T·Y (trading-day units left).

### 7.1 Greeks on the forward (`greeks.mjs`)

d1 = [ln(F/K) + σ²T/2] / (σ√T), d2 = d1 − σ√T
- Δ_CE = df·N(d1), Δ_PE = df·(N(d1) − 1)
- Γ = df·n(d1) / (F·σ·√T) (same for CE and PE)
- Vanna = ∂Δ/∂σ = −df·n(d1)·d2 / σ (same for CE and PE), per 1.00 of σ
- Charm per vol-time unit = −∂Δ/∂T × (1/Y) = df·n(d1)·d2 / (2U) (same for CE and PE). Derivation: ∂d1/∂T = −d2/(2T).
- Signs check: an OTM call (K > F, d2 < 0) has negative charm (its delta decays toward 0); an ITM call has positive charm.

These use `pricing.js`'s normal functions (`greeks.mjs` adds only vanna and charm on top). Tests also check each against a central finite difference of `b76Price` to 1e−6 relative.

### 7.2 Exposure per strike and side (`profile.mjs`)

For side X ∈ {CE, PE} with sign s_X from the model and weight w (1 when the scale is off):
- GEX_X(K) = w · s_X · OI_X(K) · Γ(K) · F² · 0.01 / 10⁷  (₹ crore per 1 % move of F)
- DEX_X(K) = w · s_X · OI_X(K) · Δ_X(K) · F / 10⁷  (₹ crore of delta notional)
- VEX_X(K) = w · s_X · OI_X(K) · Vanna(K) · 0.01 · F / 10⁷  (per vol point)
- CEX_X(K) = w · s_X · OI_X(K) · Charm(K) · F / 10⁷  (per trading day of vol-time)
- net(K) = CE + PE; totals sum over strikes (and expiries for `all`).

Sign models (`signs.mjs`, from the modelled hedger's side):

| Key | Label | s_CE | s_PE | Text |
|---|---|---|---|---|
| `us` | US-style | +1 | −1 | Hedger long calls, short puts (US convention: customers sell calls and buy puts) |
| `short` | All OI short | −1 | −1 | The writer of every contract hedges: sellers' view |
| `naive` | Naive | +1 | −1 | Calls +, puts −, no holder claim; same signs as US-style (OQ1) |

### 7.3 Worked example 1: the fixture (AC6)

NIFTY, Thu 29 Oct 2026 10:00 IST, expiry Tue 3 Nov 2026. F = 25,142.49 (P1-3 §6.3 example), T = 0.0147289 (weighted clock, P1-3 §6.1 example 1, U = 3.96134, Y = 268.95), T_cal = 0.0143265, r = 6.5 % → df = 0.999069. OI in units (multiples of the 65 lot). US-style, no scale. File `exposure/__fixtures__/nifty_2026-10-29T10-00.json`.

| K | σ % | CE OI | PE OI | d1 | Γ | Γ·F²·0.01 (₹/unit) | GEX_CE | GEX_PE | Net GEX | Cumulative |
|---|---|---|---|---|---|---|---|---|---|---|
| 24,800 | 14.6 | 1,300,000 | 9,750,000 | 0.7829 | 6.58499e−4 | 4,162.67 | 541.147 | −4,058.599 | −3,517.453 | −3,517.453 |
| 24,900 | 13.9 | 1,950,000 | 7,150,000 | 0.5829 | 7.92882e−4 | 5,012.16 | 977.372 | −3,583.696 | −2,606.324 | −6,123.777 |
| 25,000 | 13.3 | 4,550,000 | 11,050,000 | 0.3602 | 9.20430e−4 | 5,818.45 | 2,647.395 | −6,429.387 | −3,781.992 | −9,905.770 |
| 25,100 | 12.7 | 5,200,000 | 7,800,000 | 0.1174 | 1.02144e−3 | 6,456.99 | 3,357.633 | −5,036.450 | −1,678.817 | −11,584.586 |
| 25,200 | 12.3 | 7,800,000 | 5,850,000 | −0.1456 | 1.05076e−3 | 6,642.34 | 5,181.022 | −3,885.766 | 1,295.255 | −10,289.331 |
| 25,300 | 12.1 | 9,100,000 | 2,600,000 | −0.4179 | 9.89231e−4 | 6,253.37 | **5,690.569** | −1,625.877 | 4,064.692 | −6,224.638 |
| 25,400 | 12.2 | 8,450,000 | 1,300,000 | −0.6808 | 8.49186e−4 | 5,368.08 | 4,536.030 | −697.851 | 3,838.179 | −2,386.459 |
| 25,500 | 12.5 | 13,000,000 | 650,000 | −0.9231 | 6.82429e−4 | 4,313.94 | 5,608.121 | −280.406 | 5,327.715 | 2,941.255 |

GEX in ₹ crore per 1 % move. Hand check, 25,300: d1 = [ln(25,142.49/25,300) + 0.121²·0.0147289/2] / (0.121·0.121363) = (−0.0062451 + 0.0001078)/0.0146849 = −0.4179; n(d1) = 0.36557; Γ = 0.999069 × 0.36557 / (25,142.49 × 0.0146849) = 9.8923e−4; × 25,142.49² × 0.01 = 6,253.37 ₹ per unit; × 9,100,000 / 10⁷ = **5,690.57 cr**.

Totals (US-style): Net GEX **+2,941.255**, call GEX 28,539.287, put GEX −25,598.032, DEX **+93,524.9**, vanna **+1,853.77**, charm **−3,035.80** (all ₹ crore). Per-strike vanna and charm at 25,500: Vanna = −df·n(−0.9231)·(−0.9383)/0.125 = 1.9538 → (13,000,000 − 650,000) × 0.019538 × 25,142.49 / 10⁷ = **606.69**; Charm/unit = df·n(d1)·(−0.9383)/(2 × 3.96134) = −0.030827 → 12,350,000 × −0.030827 × 25,142.49 / 10⁷ = **−957.20**.

Levels:
- **Call Wall = 25,300** (largest GEX_CE, 5,690.6), although the largest call OI is at **25,500** (13.0 M units). This is why the two are named differently.
- **Put Wall = 25,000** (largest |GEX_PE|, 6,429.4); here it is also the largest put OI.
- **Zero-gamma = 25,065.80** (§7.5): x* = −0.3050 %; spot-equivalent 25,120.5 × (1 − 0.003050) = 25,043.87.
- **HVL = 25,156.45** (§7.6): net GEX flips from −1,678.817 at 25,100 to +1,295.255 at 25,200 → 25,100 + 100 × 1,678.817 / 2,974.072.

Under **All OI short** the same strikes give net GEX −54,137.32 at x = 0 and the curve stays negative over ±5 % (−1,128.9 at −5 %, −1,207.1 at +5 %): zero-gamma `null`, reason `NO_SIGN_CHANGE_IN_RANGE`; every per-strike net is negative, HVL `null`, reason `NO_STRIKE_FLIP`; walls unchanged (25,300 and 25,000).

Test tolerances (AC6, tighter than the BRD): per-strike GEX within **0.5 %** (BRD) and asserted to 0.01 %; zero-gamma within **0.1 % of F** (25 points, BRD) and asserted to ±0.5 point; HVL ±0.01; totals 0.01 %.

### 7.4 Gamma curve (`levels.gammaCurve`)

For grid x_j = −R + j·step (R = 5 %, step = 0.05 % → 201 points), each expiry e: F_e(x) = F_e·(1 + x), σ_K and T fixed (sticky-strike, frozen time):
G_CE(x) = Σ_e Σ_K OI_CE,e(K)·Γ(F_e(x), K, σ, T_e)·F_e(x)²·0.01 and likewise G_PE. Curve_sign(x) = w·(s_CE·G_CE(x) + s_PE·G_PE(x)). Grid limited to x where F_front(x) lies inside [min strike, max strike] of the front expiry (`coverage.gridPct`).

Worked (fixture, US-style, ₹ crore): x = −5 % → −707.4; −2 % → −7,868.8; −1 % → −5,473.4; −0.35 % → −419.5; −0.30 % → +47.3; 0 → +2,941.3; +1 % → 10,994.5; +2 % → 12,025.2; +5 % → 824.4.

### 7.5 Zero-gamma

1. Scan adjacent grid points for a sign change (a zero value counts as a root).
2. Refine each bracket by bisection on the exact curve until the bracket is < `tolPct` (0.0005 %) of F (≈ 22 iterations).
3. `roots` = all roots in range, ascending; `level` = the root nearest x = 0 (ties: the lower). `movePct` = x*·100; `level` = F_front·(1 + x*) (the selected expiry's forward for single-expiry scope); `spotEquivalent` = spot·(1 + x*).
4. No sign change → `available: false`, `reason: "NO_SIGN_CHANGE_IN_RANGE"`, and `detail` names the sign ("Modelled gamma is negative across ±5 %").

Worked: bracket [−0.35 %, −0.30 %] (−419.5 → +47.3); bisection → x* = −0.30503 % → **25,065.80**.

### 7.6 HVL (strike flip)

At the current forward, with net(K) the per-strike net GEX sorted by strike: every adjacent pair (K_i, K_{i+1}) with net(K_i)·net(K_{i+1}) < 0 is a flip at K_i + (K_{i+1} − K_i)·|net(K_i)| / (|net(K_i)| + |net(K_{i+1})|). `flips` = all, ascending; `level` = nearest the forward; `between` = the pair. None → `NO_STRIKE_FLIP`. Why both levels: zero-gamma re-prices the whole book at each price (what hedging would look like *if* price moved there); HVL reads today's per-strike profile only. They differ (fixture: 25,066 vs 25,156), and the method note says what each is.

### 7.7 Walls

Call Wall = argmax_K |GEX_CE(K)| over the scope (for `all`, per-strike sums across expiries); Put Wall = argmax_K |GEX_PE(K)|; ties → nearer the forward, then lower strike. Independent of the sign model and the participant scale (both multiply a whole side by a constant). `largestOiStrike` is reported beside each for contrast. No OI on a side → `NO_OI`.

### 7.8 Participant scale (`participants.mjs`)

From the latest S4 file (date d − 1), hedger set H (default FII, PRO), for X ∈ {IDX_CE, IDX_PE}:
netShort_X = Σ_{p∈H} (short_{p,X} − long_{p,X}); total_X = Σ_all long_{p,X} (= Σ short).
**w = clamp((netShort_CE + netShort_PE) / (total_CE + total_PE), 0, 1).**

Worked (contracts, 28 Oct 2026, illustrative):

| | FII long | FII short | Pro long | Pro short | Client long | Client short | DII long | DII short |
|---|---|---|---|---|---|---|---|---|
| Index CE | 180,000 | 260,000 | 410,000 | 690,000 | 1,520,000 | 1,090,000 | 0 | 70,000 |
| Index PE | 300,000 | 210,000 | 520,000 | 840,000 | 1,350,000 | 1,140,000 | 20,000 | 0 |

netShort_CE = 950,000 − 590,000 = 360,000; netShort_PE = 1,050,000 − 820,000 = 230,000; totals 2,110,000 + 2,190,000 = 4,300,000 → **w = 590,000 / 4,300,000 = 0.13721**. Scaled fixture net GEX = 2,941.255 × 0.13721 = **403.57** ₹ crore; levels unchanged (25,300 / 25,000 / 25,065.80 / 25,156.45). If H is net long overall, w = 0 and the copy reads "FII + Pro were net long index options on 28 Oct, so the scale is 0 under this assumption."

### 7.9 Multi-expiry (`all`)

Per-strike rows sum each expiry's per-strike values at the same strike (each priced on its own F_e, σ_e(K), T_e). Walls and HVL on the summed rows; zero-gamma on the summed curve with every forward shifted by the same x. Front expiry inside its settlement window is excluded (§2.3). Test: `all` over two copies of the fixture with OI halved equals the single fixture (levels identical, sizes identical).

### 7.10 Settling window

`settling = isExpiryDay(expiry) && now ≥ close − settlementWindowMinutes` (session close from `reference.session()`). Default window start 15:00 IST for index options (needs verification, as in P1-3).

---

## 8. Rate-limit budget

| Path | Broker calls | Rule |
|---|---|---|
| Minute loop (recorder present) | **0** | Reads recorder memory; ≤ 40 ms CPU a minute for 18 chains |
| `GET /exposure`, `/levels` with recorder (≤ 90 s) | **0** | Cache per (underlying, scope, slot) |
| `GET /exposure` without recorder, one expiry | ≤ 1 chain read per underlying per `liveTtlSeconds` (60 s) | `priority: "background"`, `maxAgeMs: 60000` (reuses any chain read by a page in the last minute); never delays interactive calls (scheduler priority, test) |
| `GET /exposure?expiry=all` without recorder | ≤ `allExpiries.maxRest` (3) chain reads per 60 s | Same rule; on refusal serves the last profile `stale: true` |
| Daily 15:31 job | **0** with recorder; else 0 when P1-3's 15:25 chains are in the cache (`maxAgeMs: 600000`), else ≤ 18 background chain reads once a day | Dhan background slice 10/min (unverified) → < 2 min |
| Catch-up, demo seed | **0** | Disk / pure functions |
| Participant data | **0** broker calls | P1-13a fetches S4 (NSE archive, its own budget) |
| Dashboard → Bridge | Exposure page: 1 `/exposure` per 60 s + 1 `/levels` per 5 min while visible; chain page and builder: 1 `/levels?days=0` per 60 s each while visible | Per-key limiter unchanged; hidden tabs make no calls |
| CPU | Per request ≤ 15 ms (`all`, 4 expiries × 81 strikes × 201 points); responses served from cache ≤ 5 ms p95 | BRD §7.1 (no long task; work in `setImmediate`) |

Worked (no recorder, Zerodha, built chains on the 1/s quote class): one user on the Exposure page with `all` → 3 background chain reads a minute, each 1–2 quote calls (P1-1 §2.2 cost note) ≈ 6 calls/min out of the 30/min background share; the chain page's own 3 s fetch for the selected expiry answers one of them from cache.

---

## 9. Safety, compliance and honesty gates

| Gate | Where | Test |
|---|---|---|
| Module cannot reach orders, paper or safety; no outbound `fetch` | `USED_SERVICES`; imports | `module.test.mjs` greps imports |
| Read-only API: every route `scope: read`, no write routes, MCP tool read-only | `ROUTES`, `mcp/tools.mjs` | `routes.test.mjs`, `openapi.test.mjs`, `tools.test.mjs` |
| §8.4 disclaimer "Modelled from open interest under the selected assumption. Actual positions are unknown, and India has no designated hedging dealers." on every exposure response, the Exposure page footer, the method note, and the chain/payoff level tooltips (short form "Modelled, not a forecast · Exposure →") | `profile.mjs`, `exposure.js` | `profile.test.mjs`, `exposure.test.mjs` snapshot |
| §8.4 levels disclaimer "Calculated from your inputs and market data. Not a recommendation." on `/levels`, the tiles' popover and the history panel | `routes.mjs`, `exposure.js` | same |
| Descriptive copy only ("largest modelled call gamma at 25,300"), never "support", "resistance", "magnet", "pin", "bullish", "bearish", "buy", "sell", "target", "recommend", "expect", "will move", "best" | all new strings and the renamed OI tags | `exposure.test.mjs` and `desk.test.mjs` grep the copy tables and GLOSSARY entries |
| Assumption always visible: sign model and scale shown above every number, never hidden behind a menu, in every response's `assumption` | UI §6.1 panel 1 | view-model test |
| Participant scale cannot set signs or move levels | `profile.mjs` multiplies sizes only | `profile.test.mjs` asserts levels equal with w ∈ {0.1, 0.5, 1} |
| No values faked: missing IV → leg excluded and counted; no interpolated IV; gaps in history are rows reading "Not recorded" | `sources.mjs`, `store.mjs` | `profile.test.mjs`, `store.test.mjs` |
| OI unit unverified → sizes null by default | `profile.mjs` | `profile.test.mjs` |
| Data stays local, never pooled across holders; account ids never returned | recorder data account only; responses carry `broker` | `routes.test.mjs` (restricted key), `store.test.mjs` scans for fake token strings |
| Demo never mixes with real data | separate root `exposure-demo/` | `exposureService.test.mjs` |
| RA/IA rules (BRD §8.1): no ranking, scoring or "signal" from levels; levels never feed an order, a ticket default or a button | `payoff`/`chain` read-only overlays | `strategy.test.mjs` asserts `levels` changes no metric |
| Algo framework | Not applicable: no orders | n/a |
| Exposure levels misread as signals (BRD §8.5) | visible switch, method notes, descriptive copy, "Modelled" prefix on every chart label | review checklist in the PR |
| SEBI education rule on live data in public material | Docs screenshots use demo data only | doc review |

---

## 10. Migration and back-compat

- Additive: new module, config section, service, two routes, MCP tool, bus topic, dashboard page and file. No `/v1` field is removed or renamed.
- P1-1 `OptionDailyRow.gex`/`zeroGamma` widen from `null` to `number | null` (filled at read time when the exposure service exists); clients that ignored them are unaffected.
- **Visible copy change:** chain and OI "Call wall"/"Put wall" (OI-based) become "Most call OI"/"Most put OI" and lose "support"/"resistance". Pref keys (`tags.walls`, tile ids `cw`/`pw`) are unchanged, so saved Customise settings keep working. CHANGELOG entry explains the rename and that "Call Wall"/"Put Wall" now mean modelled gamma.
- New pref `tags.levels` defaults to on for index underlyings; `strategyConfig.levels` defaults on. Both validated with fallbacks (old saved prefs without them get the default).
- `exposure.enabled: false` removes the minute loop and daily job; routes then return `available: false, reason: "DISABLED"`; the page shows the empty state; chain and payoff draw no levels.
- No data migration: `dataDir/exposure/` is new. Rollback = remove the module; nothing else reads its files (the P1-1 read-time join checks for a stub).
- Before P1-3 merges: interim clock labelled `INTERIM_CLOCK` in `warnings`; after P1-3, rows record `clock: "b76-vt1"`. GEX/DEX/levels from the two are comparable (σ²T-consistent); vanna/charm are labelled with their clock. History rows keep their `clock` field.

---

## 11. Test plan

Unit (vitest, manual clock, no network):

| File | Covers |
|---|---|
| `server/bridge/exposure/greeks.test.mjs` | §7.1 closed forms vs finite differences of `b76Price` (Δ, Γ, vanna, charm; CE and PE; moneyness ±10 %; T from 1 hour to 1 year); charm sign for OTM/ITM; σ²T invariance of Γ and Δ (ACT/365 vs weighted pairs with the same price give equal Γ to 1e−9) |
| `server/bridge/exposure/profile.test.mjs` | **AC6** fixture table §7.3 (each per-strike GEX to 0.01 %, totals, vanna and charm at 25,500); sign models (`naive` equals `us`, `sameAs`); participant weight scales every ₹ value and no level; OTM-side σ selection; missing IV excluded and counted; `oiUnitVerified: false` → sizes null + `rel`; `greeks` subset; disclaimer present |
| `server/bridge/exposure/levels.test.mjs` | **AC6** zero-gamma 25,065.80 (±0.5 pt; BRD 0.1 % of F), curve values §7.4, bracket choice with two roots (nearest wins), grid clipped by strike coverage, All OI short → `NO_SIGN_CHANGE_IN_RANGE`; HVL 25,156.45, multiple flips, none; walls 25,300 / 25,000, ties; `all` = halved duplicate fixture |
| `server/bridge/exposure/participants.test.mjs` | §7.8 w = 0.13721; clamp at 0 with the net-long copy; `NOT_FOR_BSE`; `PARTICIPANT_STALE` after 1 trading day; no provider → `NO_PARTICIPANT_DATA`; balanced-totals check |
| `server/bridge/exposure/sources.test.mjs` | recorder snapshot → input (fields, units, `t` used as T); REST chain → input with self-solved IV; recorder older than 90 s falls through; settling detection at 14:59/15:00 on an expiry day; `at` reads the slot or `NOT_RECORDED` |
| `server/bridge/exposure/store.test.mjs` | append, torn last line skipped and counted, last-wins per (date, scope), history with missing days, compaction, retention, no secrets in files |
| `server/bridge/exposure/exposureService.test.mjs` | fake recorder + fake marketData + manual clock: minute loop computes on `recorder.snapshot`, coalesces, emits `exposure.levels` only on change and with `previous`; daily job at 15:31 writes 5 scopes × 6 underlyings; catch-up for 10 days with 3 missing; REST fallback uses `priority: "background"` and `maxAgeMs`; cache hit is 0 calls; demo root separation; demo seed writes 9 rows + 1 gap per index |
| `server/bridge/exposure/routes.test.mjs` | every validation error; all routes `read`; CSV columns and filename; `available: false` reasons (`NOT_SUPPORTED`, `NO_CHAIN`, `SETTLING`, `DISABLED`, `NOT_LISTED_IN_DEMO`); `broker` shown, `accountId` never; `demoUnverified` ignored outside demo |
| `server/bridge/exposure/module.test.mjs` | no imports from orders/paper/safety; no `fetch`; config defaults and `.strict()`; `rangePct` bounds |
| `server/bridge/exposure/priority.test.mjs` | real `createScheduler` + fake broker `chain: 4/s`: 50 exposure REST reads in background while 100 interactive `optionChain` calls arrive; every interactive call starts within 200 ms |
| `server/bridge/demo/demo.test.mjs` (update) | §5.1 assertions (zero-gamma in range at 20 instants; Call Wall above anchor, Put Wall below; walls stable 10:00–14:00; OI multiple of lot; expiry-day hump); `spotAt` unchanged (existing snapshot values) |
| `server/bridge/exposure/demoParticipants.test.mjs` | balanced totals; weight range 5–25 %; one clamp day per week; deterministic |
| `server/bridge/dashboard/exposure.test.mjs` | pure view-models: tiles text (incl. null and partial states), bars model (split/net, band, relative mode, level rule positions between rows), curve model, history rows with gaps, prefs validation, phone flags, neutral-copy grep, disclaimer strings |
| `server/bridge/dashboard/desk.test.mjs` (update) | `tagsFor` with levels (priority, between-row zero-gamma text), renamed OI tags, `lv` tile text; `tags.levels` default and old-pref fallback |
| `server/bridge/dashboard/options.test.mjs` / `strategy.test.mjs` (update) | `payoffModel` returns `levels` inside the range only; `levelMarks`; levels change no metric (PoP, max loss, breakevens identical with and without) |

Contract:
- `core/openapi.test.mjs` passes with the two paths (`x-stream: S21`, `x-scope: read`) and the widened P1-1 daily fields.
- `server/bridge/exposure/exposure.contract.test.mjs`: for the same demo instant, the recorder-snapshot path and the REST-chain path give per-strike GEX within 0.5 % and identical walls (proves both source adapters agree).
- `mcp/tools.test.mjs`: `get_exposure` schema; output units equal REST; read-key only.
- P1-1's `oiUnits.contract.test.mjs` is the OI-unit gate this feature relies on (no change).

End-to-end (`server/bridge/e2e/exposure.e2e.test.mjs`, `bootBridge` in demo with `shiftedClock` at Tue 3 Nov 2026 10:00:58 IST):
1. Within 5 s, `GET /v1/options/exposure?underlying=NIFTY` returns `available: true`, `source: "recorder"` (or `demo`), four levels, a non-empty `strikes`.
2. `sign=short` → `zeroGamma.available: false`, walls identical to `us`.
3. `participantScale=true` → `weight` in [0.05, 0.25], totals scaled, levels identical; `underlying=SENSEX&participantScale=true` → `reason: "NOT_FOR_BSE"`.
4. `GET /v1/options/levels?underlying=NIFTY&days=10` → 10 rows, 1 `missing`.
5. Advance the clock to 15:01 → `expiry=front` (0DTE Tuesday) → `reason: "SETTLING"`; `expiry=all` excludes it in `coverage.excludedExpiries`.
6. `GET /v1/options/daily?underlying=NIFTY` (P1-1) shows `gex` and `zeroGamma` filled for seeded days.
7. Subscribe to `exposure.levels` on the bus; push a demo snapshot that moves the Call Wall → one event with `changed: ["callWall"]`.

Manual check (in the PR, demo): `#/exposure` at 360, 800 and 1280 px; switch each sign model, scale, scope and Greek; chain shows the level tags and the `lv` tile; builder payoff shows the rules; keyboard through the bars; screen-reader summary sentence present; no horizontal page scroll.

---

## 12. Ordered task list (one engineer, one session; each task lands with its tests green)

Stop points: after T5 (all maths proven on the fixture), after T10 (server complete, API usable), after T15.

| # | Task | Files | Done when |
|---|---|---|---|
| T1 | Fixture + Greeks | `exposure/__fixtures__/nifty_2026-10-29T10-00.json`, `greeks.mjs`, `greeks.test.mjs` | §7.1 tests pass, finite-difference checks pass |
| T2 | Sign models + profile | `signs.mjs`, `profile.mjs`, `profile.test.mjs` | §7.3 table to 0.01 %; unverified-units and exclusion cases pass |
| T3 | Curve, zero-gamma, HVL, walls | `levels.mjs`, `levels.test.mjs` | 25,065.80 / 25,156.45 / 25,300 / 25,000; All-short nulls |
| T4 | Participant weight + provider | `participants.mjs`, `participants.test.mjs` | w = 0.13721; clamp; BSE; stale |
| T5 | Core additions (lead): contract, topic, builtin module order, `DASHBOARD_FILES` | `core/contracts.mjs`, `core/eventBus.mjs`, `core/builtinModules.mjs`, `core/app.mjs` | existing core tests green |
| T6 | Config + module skeleton + two OpenAPI paths and schemas (+P1-1 field widening) | `config.mjs`, `module.mjs`, `docs/openapi.yaml`, `module.test.mjs` | `openapi.test.mjs` passes with routes returning `DISABLED` |
| T7 | Sources (recorder, REST, `at`, settling) | `sources.mjs`, `sources.test.mjs` | source tests pass with fakes |
| T8 | Store | `store.mjs`, `store.test.mjs` | store tests pass |
| T9 | Service: cache, minute loop, `exposure.levels`, daily job, catch-up, priority | `exposureService.mjs`, `exposureService.test.mjs`, `priority.test.mjs`, `fake.mjs` | service + 200 ms priority test pass |
| T10 | Routes (JSON + CSV), MCP tool, P1-1 daily read-time join | `routes.mjs`, `routes.test.mjs`, `mcp/tools.mjs`, `recorder/routes.mjs` | route, MCP and contract tests pass |
| T11 | Demo: adapter OI structure, demo participants, `at` synthesis, seed | `demo/demoAdapter.mjs`, `demoParticipants.mjs`, `demoSeed.mjs`, tests | demo tests pass; `--demo` shows levels at once |
| T12 | `exposure.js` page (view-models first, then DOM), `views.js` entry, `desk.js` kind wiring | `dashboard/exposure.js`, `views.js`, `desk.js`, `exposure.test.mjs`, `format.test.mjs` | page works in demo at 360/800/1280 px |
| T13 | Chain tags + `lv` tile + OI-tag renames | `desk.js`, `options.js` (`levelMarks`, GLOSSARY), `desk.test.mjs` | tags and tile render; copy test passes |
| T14 | Payoff rules + builder setting | `options.js` (`payoffModel`), `payoff.js`, `strategy.js`, tests | rules drawn; metrics unchanged test passes |
| T15 | OI-page link and copy; E2E | `oi.js`, `e2e/exposure.e2e.test.mjs` | e2e steps 1–7 pass |
| T16 | Docs: `docs/guides/exposure.md` (method, assumptions, limits, worked example), ARCHITECTURE (module map, `dataDir/exposure/`), STREAMS S21, `bridge.config.example.json`, CHANGELOG, `docs/guides/mcp.md` | docs | `npm test` green; `npm run typecheck` clean |

If P1-1 has not merged when T7 starts: build `sources.mjs` against `recorder/fake` shape (latest/read), ship with the REST path live, and leave AC5 (history) and the minute loop behind the `deps.recorder` stub check; they switch on when P1-1 lands with no code change.

---

## 13. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Users read modelled levels as trading signals (BRD §8.5) | High | Medium | Assumption bar above every number; "Modelled" on every label; descriptive copy test; both §8.4 disclaimers; no level feeds any order path |
| R2 | The sign model is wrong for India (no designated dealers; retail net long both sides) | Certain | Medium | It is a visible switch with stated assumptions; All OI short offered; participant scale sizes only; OQ4 default reviewed by the owner |
| R3 | BRD's US-style vs Naive duplication confuses users | High | Low | "Same signs as US-style" note; OQ1 for the owner; open enum lets a third distinct model land additively |
| R4 | OI unit wrong for a broker → ₹ sizes off by the lot size | Medium | High | Levels are unit-free; sizes null when unverified (P1-1 contract test is the gate) |
| R5 | "All expiries" omits far-dated OI with large round-strike positions | High | Medium | Coverage stated in every response and the UI ("3 of 14 listed expiries"); far-dated EOD fill is LATER |
| R6 | 0DTE gamma near the close dominates and swings levels | High | Medium | Settlement-window exclusion from 15:00; vol-time clock (P1-3) avoids the ACT/365 blow-up before that; demo lets this be inspected |
| R7 | S4 empty (archive downloads off) | Medium | Low | Provider interface; honest `NO_PARTICIPANT_DATA`; demo exercises the full path |
| R8 | Stream id clash | Resolved | — | Fixed in `docs/spec/README.md`: exposure is S21 |
| R9 | IV/T mismatch between sources (interim recorder clock vs P1-3 clock) silently skews vanna/charm | Medium | Low | Greeks always use the IV's own T; clock in every response; σ²T-invariance test for Γ/Δ |
| R10 | Copy rename of the OI walls collides with the restyle team's work in `desk.js`/`oi.js` | Medium | Low | Text-only change, keys unchanged; coordinate through `docs/design/chain.md` and `oi.md` before T13 |
| R11 | Minute-loop CPU on a slow machine | Low | Medium | One pass for all sign models (§3.7), per-underlying `setImmediate`, coalescing; measured in `exposureService.test.mjs` (≤ 60 ms for 18 chains on CI) |
| R12 | Competitor-style "levels" history is short at launch (needs the recorder running) | Certain | Low | "n of 10 days" label; catch-up from any recorded day; demo shows the full panel |
