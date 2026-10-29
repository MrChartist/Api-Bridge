# Engineering spec P1-10: broker basket margin, rule-aware pre-trade checks and slicing

Status: ready to build once P1-2 steps 1–9 have landed (§1.4) · Owner: tech lead, P1-10 · Date: 29 Oct 2026 · Stream: **S23 (new) "Margin and pre-trade checks"** (final id from the stream table in `docs/spec/README.md`).

BRD: `docs/brd/options-platform.md` §3.F (F9), §3.G (G2, G3, G8, G9), §5.5 (margin service), §5.6, §5.7 ("Basket margin API" column), §6.1 (P1-10 acceptance criteria), §7.1 (basket margin ≤ 1 s), §7.2, §7.5, §7.6, §7.8, §8.1, §8.2, §8.5 ("Broker margin APIs differ or are missing", "Exits or rolls trigger short-margin penalties").

> **Not legal or market advice.** Every exchange rule, broker endpoint, field name and number below that comes from outside this repo is marked **needs verification**. A rule marked that way ships with `verified: false`. It may warn, but it never blocks an order until a person has checked it against the primary SEBI/NSE/BSE circular or the broker's own API page and set `verified: true` (§9.3).

> **Styling.** Another team is restyling the dashboard (near-black theme, colour tokens, motion). This spec describes structure, states and interactions only. New visual states are `data-*` attributes with one rule each that reads the existing tokens in `palette.css` (`--c-warn`, `--c-bad`, `--c-ok`, `--c-muted` and the rest). It adds no new colours and no new motion.

> **Build order and shared foundations.** This spec is steps 21–22 (P1-10a server tasks 1–12, P1-10b dashboard, MCP and e2e tasks 13–17) in `docs/spec/README.md`, after P1-2a, P1-5a, P1-6a. It uses, and does not rebuild, the F0 foundations listed there: final stream ids, bus topics and error codes pre-registered in core, the opt-in `options` MCP toolset (every MCP tool in this spec goes there), `demo/routes.mjs` plus the OpenAPI demo-only list, `server/lib/jsonl.mjs` (append, torn-line tolerance, last-wins, quarantine of corrupt files), `ratelimit/backgroundGate.mjs` (the one ≤ 50 % background-budget check), `core/ownership.mjs`, and `dashboard/copyRules.mjs` (the one banned-word list). Where this text and README disagree, README's build order and shared-module owners win.

---

## 0. Summary

P1-10 answers three questions before any multi-leg send: **"What will my broker block?"**, **"Will any leg be refused or leave me short of margin part-way?"** and **"What rules apply to this basket today?"**. It also makes every charge figure use **the account's own brokerage plan**.

| BRD item | What ships this round | What our data allows |
|---|---|---|
| G2 broker basket margin | `POST /v1/margin/basket` on Zerodha, Dhan, Upstox and the demo broker, through a new adapter capability `basketMargin`. Cached 5 s per basket. Each answer is labelled "broker figure at HH:MM:SS". | Only these three real brokers are in scope. Every other account, and any failure, gets `broker: null` with a `reason`, plus **our estimate** labelled "estimate" with an error band. The band is a rough default until local calibration has measured it (§7.6). |
| G3 rule-aware pre-trade check | `POST /v1/margin/check` returns one line per applicable rule: plain-English text, the rule's source and date, and whether it is verified. The ticket, the builder, the placement sheet and the positions exit plan all show it. | Some rules depend on data no broker gives us: the exchange's dynamic price band for options and the far-OTM strike rule. These ship as **warn-only, unverified** lines, with the honest fallbacks in §1.3. |
| F9 margin after each leg | Simulates the send order leg by leg with broker figures for each prefix (capped by budget), flags "short of margin after leg k", and proposes a **margin-covered order**. | Brokers do not say how their RMS treats an exit that briefly raises margin. The copy says "risk", never "will". |
| G8 freeze slicing (check only) | The check names the method: the broker's native slicing (capability flag, reported but **not used** this round), else paced bridge slices under the order-rate cap. It also states the slice count, the time to send at the cap, the daily order count used, and how this interacts with `maxLotsPerOrder`. | The freeze quantities are unverified (`symbols/freezeQuantities.mjs`, P1-2). Stock freeze quantities may be unknown, and then the check says so. |
| G9 per-account brokerage plans | A `chargePlans` service with per-account plans (flat, per lot, % capped, zero), shipped broker defaults marked **needs verification**, and a dashboard editor on the Accounts page. Builder, ticket, arbitrage, positions and **paper fills** all use it. | — |

---

## 1. Scope

### 1.1 MUST (this round)

| # | Item | Acceptance link |
|---|---|---|
| M1 | Module `server/bridge/margin/` (stream S23) with two services, `margin` and `chargePlans`, a config section `margin`, and stores under `dataDir/margin/` | all |
| M2 | Adapter capability `basketMargin` (`fetchBasketMargin`) in `brokers/contract.mjs` and `contractShapes.mjs`, with fixtures and contract tests, for **zerodha, dhan, upstox** and the **demo** adapter | AC1 |
| M3 | Legacy order-feature key `slicing` (`{ native, maxLegs, verified, source }`), declared for zerodha, dhan, upstox and demo. Every other adapter stays `null` ("unknown") | AC3 (G8) |
| M4 | Pure maths in `server/bridge/dashboard/margin-core.js`, shared by server and browser: estimate, error band, prefix headroom, margin-covered order, slicing plan, expiry-day ELM, calendar detection, plan brokerage, netting | AC1, AC3, AC5 |
| M5 | `POST /v1/margin/basket`: broker figure or `null` + `reason` + estimate; 5 s cache; per-account call budget; ≤ 1 s p95 | AC1, AC2 |
| M6 | `POST /v1/margin/check`: every rule line in §3.4, including F9 sequence and G8 slicing | AC3, AC4 |
| M7 | Rule table `margin/data/rules.json`: dated, sourced, `verified` per rule | AC3 |
| M8 | Charge plans: `GET /v1/charges/plans`, `PUT`/`DELETE /v1/charges/plans/{account}` (admin, loopback), shipped broker defaults, and paper fills use the plan | AC5 |
| M9 | Optional quote fields `upperCircuit` / `lowerCircuit` mapped for zerodha, dhan, upstox and demo (additive), so the price-band line can use the exchange band | AC3 |
| M10 | Demo: the demo adapter answers `fetchBasketMargin` with a SPAN-like sample model; `POST /v1/demo/margin` scenarios; paper accounts in demo get "demo broker figure (sample)" | demo |
| M11 | Dashboard: `margin.js` client module. Builder margin tile and check panel; placement-sheet check and sequence column; ticket margin line and check; positions exit-plan check; plan editor on Accounts; arbitrage default from the account plan | AC2, AC3, AC5 |
| M12 | Fixture set of 20 rejection and penalty cases, with a test asserting ≥ 18 flagged | AC4 |
| M13 | MCP read tools `get_basket_margin` and `check_basket`; compat `/api/v1/margin` wired (replacing `CAPABILITY_UNSUPPORTED`) | §7.8 parity |
| M14 | Local calibration log (estimate vs broker figure), used to replace the default band once n ≥ 30 per class | AC1 ("known error band") |
| M15 | Docs: OpenAPI, ARCHITECTURE (S23, data layout), STREAMS, `docs/guides/margin.md`, `bridge.config.example.json`, CHANGELOG | §7.8 |

### 1.2 LATER (named so nobody builds it now)

| Item | Why later | Goes with |
|---|---|---|
| Basket margin for Angel One, Fyers, Groww, Shoonya/Noren, XTS family, Kotak and others | Each needs an endpoint check and recorded fixtures. The BRD acceptance criterion names Dhan, Zerodha and Upstox only. | P2, one adapter at a time (template in §2.6) |
| **Sending** through native iceberg or broker autoslice | G8 send is P2 in the BRD. This round reports the capability and keeps today's bridge slices. | P2 (G4 legging panel) |
| Server-side enforcement of the check inside `OrderService.place` | Calling broker margin inside every place adds latency and a new failure path to the only order path. This round the dashboard blocks on `block` lines, and the existing safety gates stay authoritative. The `margin.check()` service method is ready for P1-12 guards and H3 alert actions, which **must** call it (§9.1). | P1-12 |
| Hedge-aware paper engine margin | The paper engine blocks margin per leg with no hedge benefit (`paper/fillModel.mjs marginFor`), so a hedged paper basket can be refused while the margin panel says it fits. The panel says "paper blocks per leg" (as `strategy.js` does today). | P2 |
| Legging panel with rollback and live re-check after a partial fill | G4 is P2. This round the placement sheet re-runs `check` with the filled legs as positions when it pauses (§6.3), which covers "partial fill" for F9. | P2 (G4) |
| Our own SPAN from NSE SPAN risk-parameter files | The files are large XML/zip downloads under unclear terms (**needs verification**), with no parser in the repo. The estimate stays the existing PRD 02 heuristic plus calibration. | Later, after a licence check |
| Peak-margin snapshot simulation for intraday MTM | Needs broker MTM and exchange snapshot times we do not get. | — |
| Position-limit / MWPL / FutEq checks (F6) | P2 in the BRD. | P2 |
| Charge plans from the broker's own contract-note API (Kite `/charges/orders`, **needs verification**) | One more broker call per check. The plan model is enough for P1. | P2 |
| Roll builder UI | No roll feature exists yet. `check` accepts `intent: "roll"` now, so the roll builder only has to call it. | P2 |
| Compat parity for the check (`/api/v1/...`) | No compat-API equivalent exists. MCP covers it. | — |

### 1.3 Honest fallbacks (where the acceptance criteria meet our data)

- **Broker cannot answer** (no capability, paper account with no source account, session expired, timeout, rate limit, budget used): `broker: null`, `reason` from the closed list in §3.2, and `estimate: { required, band, method, bandQuality }`. The UI shows "≈ ₹1,74,818 estimate (₹1,04,891 – ₹2,09,781, rough band)". It never shows the word "broker" next to an estimate (BRD §8.2).
- **Error band.** We have no measured error for our estimate today. Until the local calibration log holds 30 comparisons for a structure class, the band is a **default, labelled "rough band, not measured"**: defined-risk 0.85–1.10× and undefined-risk 0.60–1.20× (config). After that, it is the 10th–90th percentile of `brokerFinal / estimate` over the last 90 days, labelled "measured on this computer, n = 42" (§7.6). This is the honest reading of "its known error band".
- **Exchange price band for options.** NSE/BSE apply dynamic operating ranges to options that brokers do not publish as an API (**needs verification**). Where a quote carries circuit limits (M9), the check uses them and says "exchange band". Otherwise it uses the Bridge's own `safety.priceBandPct` against LTP and says "exchange band unknown for this contract: checked against the Bridge's ±3 % band only".
- **Far-OTM range rule.** We could not pin down the exact exchange rule from a primary source (**needs verification**). It ships as a dated config rule (`FAR_OTM_RANGE`, `verified: false`, default `index: 0.10`, `stock: 0.30` of the underlying), and only ever **warns**: "Far from the money (12.4 % from spot). Exchanges restrict some far strikes; check that this contract is open for fresh positions." A strike missing from the broker's instrument master blocks for the separate reason `SYMBOL_NOT_FOUND`, as today.
- **Ban list.** We read P1-2 `reference.banStatus()`. When the NSE archive downloads are off, the line says "Ban list unavailable: NSE archive downloads are off" (warn). P1-6's `FNO_BAN` safety gate still decides.
- **H5 readiness.** We read P1-5 `readiness.canTrade()` when the service is present. Without it, the line says "Trading readiness not available on this Bridge" (info).
- **Stale price.** We use the leg's `ts` from P1-4 when present, else the `freshness` of `marketData.quotes()`. With neither, the line says "price age unknown" (info).
- **Which RMS rule bites.** Some rejections come from a broker's own RMS policy: blocked deep-OTM stock options, broker MTM cut-offs, segment not enabled. We cannot see these. One of the 20 fixtures is such a case and is expected to be missed (§10.4).
- **Prefix figures (F9).** A broker figure per prefix costs one call per leg. Above `sequence.maxBrokerCalls` (8), the remaining prefixes are estimated, **scaled by the ratio of broker to estimate on the full basket**, and labelled "scaled estimate".

### 1.4 Dependencies

| Spec | Kind | What we use | If absent |
|---|---|---|---|
| **P1-2** reference | **Hard for full acceptance**, soft at runtime | `freezeFor`, `lotFor` (effective dates), `banStatus`, `session`, `calendar`, `charges()` (statutory table), `events` | `isStub` → `symbols` `resolved.freezeQty`, `REF_DEFAULTS` (client, `reference.js`) / `reference/defaults.mjs` (server; P1-2 lands first, so this is only the stub path), `lib/marketHours.mjs`; lines say "reference data not loaded" |
| **P1-5** readiness | Hard for the H5 line, soft at runtime | `readiness.canTrade(accountId, { mode })` | Info line |
| **P1-6** stocks | Soft | `FNO_BAN` gate semantics; stock lots, steps and freeze | Ban line reads `reference.banStatus` only |
| **P1-4** streaming | Soft | Leg `ts` for the stale-price line | Quote `freshness` |
| P1-3 pricing | None | — | The estimate uses expiry payoff only (no IV) |

Build order: you may start M1–M5, M7 and M10 before P1-2 lands. Start the M6 lines that read reference data only after P1-2 steps 1–9.

---

## 2. Architecture

### 2.1 New and changed files

New, `server/bridge/margin/`:

| File | Purpose |
|---|---|
| `module.mjs` | `defineModule({ name: "margin", stream: "S23", configKey: "margin", configSchema, services: { margin, chargePlans }, register, start, stop })` and the `ROUTES` table (§3.1). Registers `/v1/demo/margin` only when `config.demo`. |
| `config.mjs` | `MARGIN_CONFIG_SCHEMA` (zod, `.strict()`), `MARGIN_DEFAULTS`, `parseMarginConfig` (§2.5) |
| `marginService.mjs` | `createMarginService(deps, { clock, timers })`: `basket`, `check`, `rules`, `status`; cache, budget, singleflight, source resolution, calibration writes |
| `sources.mjs` | Pure: `resolveSource(account, cfg, { demo })`. Picks `broker` (own adapter), `paper-source` (another account's adapter for a paper account), `demo-broker` or `none` + reason. |
| `rules.mjs` | Pure rule evaluators, one function per line in §3.4. Each takes a plain `facts` object and returns `CheckLine[]`. No I/O. |
| `facts.mjs` | Gathers facts for `rules.mjs`: resolve legs, positions, funds, quotes, reference, readiness, safety limits and daily counters. Every read is `Promise.allSettled` with per-read timeouts. |
| `budget.mjs` | Per-account sliding-minute counter for margin broker calls (§8) |
| `cache.mjs` | TTL map keyed by basket hash, with singleflight for identical concurrent requests |
| `calibration.mjs` | Append-only JSONL writer and reader, with percentile band per class (§7.6) |
| `chargePlans.mjs` | `createChargePlans(deps)`: `planFor`, `list`, `set`, `remove`; layers are user file → config → broker default → global default |
| `store.mjs` | `plans.json` read/write (`writeFileAtomic` from `auth/fsUtil.mjs`); a corrupt file is renamed to `plans.json.corrupt-<ts>` and the service starts empty |
| `routes.mjs` | Handlers (§3) |
| `demoMargin.mjs` | Demo scenarios (§5): funds override, capability off, slow broker, expiry-day clock |
| `data/rules.json` | Dated rule table (§2.4) |
| `data/brokerage-defaults.json` | Per-broker default plans, every row `verified: false` (§2.4) |
| `__fixtures__/rejections/01-freeze.json` … `20-broker-rms.json` | The 20 acceptance cases (§10.4) |
| Tests | §10 |

New, brokers:

| File | Purpose |
|---|---|
| `brokers/zerodhaMargin.mjs` | `fetchBasketMargin` → Kite `POST /margins/basket?consider_positions=true&mode=compact` (**needs verification**: path, params, `initial`/`final` objects, `option_premium`) |
| `brokers/dhanMargin.mjs` | `fetchBasketMargin` → Dhan multi-order margin calculator (**needs verification**: `POST /v2/margincalculator/multi` and fields `total_margin`, `span_margin`, `exposure_margin`, `hedge_benefit`). If only the single-order `POST /v2/margincalculator` exists, the adapter calls it once for the whole basket only when it has one leg. Otherwise it returns `CAPABILITY_UNSUPPORTED` with "Dhan's API prices one order at a time; hedge benefit unavailable". |
| `brokers/upstoxMargin.mjs` | `fetchBasketMargin` → Upstox `POST /v2/charges/margin` (**needs verification**: `instruments[]`, `required_margin`, `final_margin`, `margins[]`) |
| `brokers/__fixtures__/{zerodha,dhan,upstox}/basketMargin*.json` | Recorded or hand-made in the documented layout. Hand-made ones carry `"illustrative": true` until replaced by a real capture. |

New, dashboard:

| File | Purpose |
|---|---|
| `dashboard/margin-core.js` | Pure shared maths (M4): no DOM, no imports except `format.js`. The server imports it as `../dashboard/margin-core.js`, as P1-3 does for `pricing.js`. Add to `DASHBOARD_FILES`. |
| `dashboard/margin.js` | Client: `marginClient` (debounce, in-flight single, cancel stale), view models (`marginTileModel`, `checkRowsModel`, `sequenceModel`) and renderers (`marginLine`, `checkPanel`, `sequenceList`, `planEditor`). Add to `DASHBOARD_FILES`. |

Changed:

| File | Owner | Change |
|---|---|---|
| `core/contracts.mjs` | lead | Contracts `margin` and `chargePlans` (§2.2); `paper.requires` += `"chargePlans"` |
| `core/builtinModules.mjs` | lead | Add `margin` after `orders` (services build in dependency order anyway) |
| `core/app.mjs` | lead | `DASHBOARD_FILES` += `"margin-core.js"`, `"margin.js"` |
| `core/eventBus.mjs` | lead | Topic `charges.plan_changed` `{ accountId }` (the dashboard re-reads; paper picks up the new plan) |
| `brokers/contract.mjs` | brokers lead | `CAPABILITIES.basketMargin = { methods: ["fetchBasketMargin"] }`; `LEGACY_ORDER_FEATURE_KEYS` += `"slicing"`; `Quote` typedef gains optional `upperCircuit`, `lowerCircuit` |
| `brokers/contractShapes.mjs`, `contractHarness.mjs` | brokers lead | `basketMargin` shape check (§2.3); fixture scenario `basketMargin` |
| `brokers/zerodha.mjs`, `dhan.mjs`, `upstox.mjs` | brokers | Export `fetchBasketMargin`; `capabilities.basketMargin = { considerPositions: true, maxLegs: 20 }` (values **needs verification**); `slicing` in the order features; circuit fields mapped in `zerodhaData.mjs`, `dhanMarket.mjs`, `upstoxData.mjs` |
| `brokers/brokerCapabilitiesSnapshot.test.mjs` | brokers | Snapshot update |
| `market/normalise.mjs` | S5 | Pass through `upperCircuit` / `lowerCircuit` on quotes when finite (additive) |
| `paper/fillModel.mjs`, `paper/paperEngine.mjs` | S8 | `brokerageFor` accepts a plan (§7.7); the engine asks `deps.chargePlans.planFor(accountId)` at fill time; falls back to `cfg.brokerage` when the service is a stub |
| `orders/orderService.mjs` | S7 | None in behaviour. Exports `previewLegs(p)` (the existing freeze slicing, made pure) so `rules.mjs` reuses the exact slicing, not a copy. |
| `demo/demoAdapter.mjs` | demo | `fetchBasketMargin`, `slicing`, circuit limits on quotes (§5) |
| `compat/handlers.mjs` | S14 | `margin()` calls `deps.margin.basket` and maps the result to the compat-API shape (§3.7) |
| `mcp/tools.mjs` | S11 | Two read tools (§3.8) |
| `dashboard/options.js` | dashboard | `charges()`, `exitCharges()`, `strategyCharges()` take `{ profile }` and use `brokerageFor(…, profile)`, never a brokerage literal: P1-2 removed `brokeragePerOrder` from `options.js` (its `noConstants` test forbids it). With no profile passed they use `REF_DEFAULTS.charges.brokerage` from `reference.js`. `strategyWarnings()` keeps `SHORTFALL` and `FREEZE` as the offline fallback, used only when `/v1/margin/check` is unavailable. |
| `dashboard/strategy.js`, `strategy-place.js`, `desk.js`, `positions.js`, `arbitrage.js`, `views.js` | dashboard | §6 |
| `docs/openapi.yaml`, `docs/ARCHITECTURE.md`, `docs/STREAMS.md`, `docs/broker-contract.md`, `docs/guides/margin.md` (new), `bridge.config.example.json`, `CHANGELOG.md` | lead | §3.9, §11 |

Rules:

- `margin/*` never imports `brokers/orderGate.mjs` and never calls `placeOrder`, `modifyOrder` or `cancelOrder`. `margin/noOrders.test.mjs` greps for this, as `integrations/noOrders.test.mjs` does.
- Broker calls go only through `deps.scheduler.schedule({ endpointClass: "other", priority: "interactive" })` (§8).

### 2.2 Service contracts (core change: the lead lands it)

```js
// core/contracts.mjs
/**
 * Margin — S23. Broker basket margin with hedge benefit, our estimate when the broker cannot answer, and the
 * rule-aware pre-trade check (G2, G3, F9, G8 check). Reads only; never sends, modifies or cancels anything.
 *  basket(ctx, BasketRequest) -> BasketResult             cached 5 s per basket hash; never throws for broker failure
 *  check(ctx, CheckRequest) -> CheckResult                 lines + sequence; used by the dashboard, MCP and (P1-12) guards
 *  rules() -> RuleRow[]                                    the dated rule table with verification state
 *  status({ accountIds? }) -> MarginStatus[]               per account: source, reason, budget left, calibration n
 */
margin: { iface: "MarginService", stream: "S23",
          requires: ["accounts", "scheduler", "symbols", "marketData", "orders", "safety", "chargePlans"],
          methods: ["basket", "check", "rules", "status"] },
/**
 * ChargePlans — S23. Brokerage plan per account (G9). Statutory rates come from reference.charges() (P1-2).
 *  planFor(accountId) -> Plan & { origin: "user"|"config"|"broker-default"|"global-default", verified }
 *  list() -> Array<{ accountId, plan }>    set(accountId, plan) / remove(accountId)  (persisted; emit charges.plan_changed)
 */
chargePlans: { iface: "ChargePlans", stream: "S23", requires: ["accounts"],
               methods: ["planFor", "list", "set", "remove"] },
```

`paper.requires` += `"chargePlans"`. There is no cycle: `chargePlans → accounts`; `margin → orders → paper → chargePlans`. `deps.reference` and `deps.readiness` are read when present and not stubs. They are not listed in `requires`, so a Bridge without P1-2/P1-5 still boots (the same pattern P1-5 uses for `reference`).

### 2.3 Data model

**Adapter call** (normalised, checked by `contractShapes.mjs`):

```js
// fetchBasketMargin(creds, orders, { considerPositions = true, positions = null }) ->
//   { status: "success", data: BasketMarginData }
// orders: [{ tradingSymbol, exchange, token, side: "BUY"|"SELL", qty /* units */, product, orderType, price|null, triggerPrice|null }]
// positions: only the demo adapter reads it (paper positions); real brokers use their own book server-side.
/** @typedef {{
 *   required: number,            // ₹, sum of standalone requirements (no hedge benefit); Kite initial.total, Upstox required_margin
 *   final: number,               // ₹, with hedge benefit (and positions when includesPositions); Kite final.total, Upstox final_margin
 *   span: number|null, exposure: number|null, premium: number|null, elm: number|null,  // components when the broker splits them
 *   hedgeBenefit: number|null,   // ₹; when null the service derives required − final
 *   includesPositions: boolean,  // the figure already nets the account's open positions
 *   incremental: boolean,        // final is the ADDITIONAL margin of this basket (true) or the account total after it (false)
 *   perLeg: Array<{ required: number|null }>|null,
 *   at: number                   // epoch ms of the broker's answer (our clock at response)
 * }} BasketMarginData */
```

`incremental` is per broker and **needs verification**: does Kite's `final` with `consider_positions=true` give the basket's own margin or the account total? The adapter normalises to incremental when it can, by subtracting `funds.usedMargin` read in the same call window. Otherwise it reports `incremental: false`, and the service does the subtraction and says so in `meta.notes`.

**Service result** (`BasketResult`):

```json
{
  "account": "zerodha-main",
  "mode": "live",
  "source": "broker",
  "sourceLabel": "Zerodha (zerodha-main)",
  "broker": {
    "required": 182340.0, "final": 41210.5, "hedgeBenefit": 141129.5,
    "span": 28650.0, "exposure": 9010.5, "premium": 3550.0, "elm": 0,
    "includesPositions": true, "at": "2026-10-29T10:15:03.412+05:30"
  },
  "available": 250000.0,
  "availableAt": "2026-10-29T10:15:02.980+05:30",
  "shortfall": 0,
  "estimate": {
    "required": 39650.0, "band": [33702.5, 43615.0], "bandQuality": "default",
    "class": "defined", "method": "PRD 02 §6.11: defined risk = |max loss| + premium; else price scan ±9 % + 2 % exposure + net debit (+2 % ELM on expiry day)"
  },
  "reason": null,
  "legs": [
    { "symbol": "NFO:NIFTY-2026-11-03-25600-CE", "side": "SELL", "units": 65, "lots": 1, "lotSize": 65,
      "price": 60.0, "freezeQty": 1800, "freezeQtySource": "exchange-list", "standalone": 110250.0 }
  ],
  "cache": { "hit": false, "ageMs": 0 },
  "notes": ["Blocked margin can differ later: SPAN files update during the day, expiry-day ELM, premium and MTM, peak snapshots."]
}
```

- `source`: `"broker" | "paper-source" | "demo-broker" | "none"`. `broker` is `null` when `source` is `"none"` or the call failed. Then `reason` is set (§3.2).
- `available` is `funds.availableCash` of the **account the order would use** (for a paper account, the paper engine's funds), never the source account's.
- `estimate` is **always** present when the legs resolve. The UI shows it only when `broker` is null, or as a secondary line in the method note.

**Check request and result** (`CheckRequest` / `CheckResult`), in full in §3.4.

### 2.4 Storage on disk (`dataDir/margin/`, mode 0700)

```
margin/
  plans.json                  { "v": 1, "plans": { "<accountId>": Plan }, "updatedAt": "…" }   user edits (dashboard/API)
  calibration/2026-10.jsonl   one row per comparison (below); monthly files; retention 180 days
```

Plan (also the config shape, and the same fields as `options.js DEFAULT_PROFILE`, so the client maths needs no translation):

```json
{ "brokerage": "flat", "value": 20, "futPct": 0.0003, "pct": 0.0003, "cap": 20,
  "exerciseBrokerage": true, "physicalPct": null, "note": "Discount broker, F&O" }
```

`brokerage` is one of `"flat" | "perLot" | "pct" | "zero"`. In `flat`, futures pay min(value, futPct × turnover). `physicalPct` (broker's own fee on physical delivery, P1-6) is optional, `null` = unknown.

Calibration row (no account id, no symbols beyond the underlying, no prices; BRD §7.7):

```json
{ "ts": "2026-10-29T10:15:03+05:30", "broker": "zerodha", "underlying": "NIFTY", "class": "undefined",
  "expiryDay": false, "legs": 2, "estimate": 174817.5, "brokerFinal": 151240.0, "ratio": 0.8651, "includesPositions": false }
```

A row is written only when the broker figure has `includesPositions: false` or the account had no open positions in that underlying, so that positions do not pollute the ratio. At most one row per basket hash per 10 minutes.

`data/rules.json` (shipped, release-maintained; a user override in config `margin.rules` may only **add** rows or set `enabled: false`):

```json
[
  { "id": "EXPIRY_ELM_SHORT_INDEX", "valueFrom": "reference.charges().margin.expiryDayElmIndexShort", "effectiveFrom": "2024-11-20",
    "source": "SEBI circular of 1 Oct 2024 on equity index derivatives (needs verification of circular number)", "verified": false },
  { "id": "NO_CALENDAR_BENEFIT_EXPIRY_DAY", "effectiveFrom": "2025-02-01", "source": "same circular", "verified": false },
  { "id": "UPFRONT_PREMIUM", "effectiveFrom": "2025-02-01", "source": "same circular", "verified": false },
  { "id": "FREEZE_QTY", "source": "reference.freezeFor (P1-2) / symbols/freezeQuantities.mjs", "verified": false },
  { "id": "ALGO_OPS_CEILING", "value": 10, "effectiveFrom": "2026-04-01", "source": "SEBI retail algo framework, 4 Feb 2025; NSE standards 5 May 2025", "verified": false },
  { "id": "FAR_OTM_RANGE", "value": { "index": 0.10, "stock": 0.30 }, "source": "exchange strike-availability rules (needs verification)", "verified": false },
  { "id": "PEAK_MARGIN_PENALTY", "source": "exchange short-collection penalty on peak margin snapshots (needs verification)", "verified": false }
]
```

`data/brokerage-defaults.json` (every row `verified: false`, `asOf`, `source`):

```json
{ "asOf": "2026-10-01",
  "brokers": {
    "zerodha": { "brokerage": "flat", "value": 20, "futPct": 0.0003, "verified": false, "source": "broker pricing page (needs verification)" },
    "dhan":    { "brokerage": "flat", "value": 20, "futPct": 0.0003, "verified": false, "source": "broker pricing page (needs verification)" },
    "upstox":  { "brokerage": "flat", "value": 20, "futPct": 0.0005, "verified": false, "source": "broker pricing page (needs verification)" },
    "paper":   { "brokerage": "flat", "value": 20, "futPct": 0.0003, "verified": true,  "source": "Bridge default for paper accounts (§11.2)" }
  },
  "global": "reference" }
```

`"global": "reference"` means the global-default layer is P1-2's `reference.charges().brokerage` (config `reference.brokerage`, default `DEFAULT_BROKERAGE` in `reference/defaults.mjs`). There is one global brokerage default in the Bridge, not one per module.

The cache, the budget counters and the singleflight map are in memory only.

### 2.5 Config (`margin` section; all optional; zod `.strict()`)

```jsonc
"margin": {
  "enabled": true,
  "cacheTtlMs": 5000,                  // BRD §5.5 "cached per basket hash for 5 s"
  "brokerTimeoutMs": 2500,             // one basket call; the ≤ 1 s target is p95, this is the hard stop
  "maxLegs": 20,
  "considerPositions": true,           // ask the broker to net open positions where it can
  "creditSellPremium": false,          // F9: do not count sell premium as margin until it is received (conservative)
  "paperSourceAccount": null,          // e.g. "zerodha-main": price paper baskets with this account's broker API
  "budget": { "perMinutePerAccount": 60 },          // margin calls only; far below every in-scope broker's "other" class
  "sequence": { "enabled": true, "maxBrokerCalls": 8 },
  "estimate": { "bandDefined": [0.85, 1.10], "bandUndefined": [0.60, 1.20],
                "calibrationMinN": 30, "calibrationDays": 90 },
  "calibration": { "enabled": true, "retentionDays": 180 },
  "staleMs": 10000,                    // BRD §7.5
  "rules": [],                          // extra rows or { "id": "FAR_OTM_RANGE", "enabled": false }
  "plans": { "zerodha-main": { "brokerage": "flat", "value": 20 } }
}
```

Bounds: `cacheTtlMs` 1,000–60,000; `brokerTimeoutMs` 500–10,000; `maxLegs` 1–40; `budget.perMinutePerAccount` 6–300; `sequence.maxBrokerCalls` 0–20; bands each `[lo, hi]` with 0.1 ≤ lo ≤ 1 ≤ hi ≤ 3. `paperSourceAccount` must name an enabled non-paper account **of the same holder** as the paper account's `holder` when both are set, because data is never pooled across holders (BRD §8.3). Otherwise config parsing fails with a clear message.

Demo defaults (`demoMode.mjs`): `paperSourceAccount: "demo"`.

### 2.6 Adding a broker later (template)

1. Write `brokers/<id>Margin.mjs` with `fetchBasketMargin`, plus a fixture with `illustrative` set honestly.
2. Add `capabilities.basketMargin`.
3. Add a contract-harness scenario.
4. Update the snapshot.

No service change is needed.

### 2.7 Schedulers

None in the market-hours path: margin work is on demand only. Two housekeeping timers, both `unref()`'d with injectable timers:

| Job | When | What |
|---|---|---|
| `sweep` | every 30 s | Drop expired cache entries; trim budget windows |
| `retention` | at start + daily 02:10 IST | Delete calibration files older than `retentionDays` |

---

## 3. API changes

### 3.1 Route table (module `margin`, `x-stream: S23`)

| Method | Path | Scope | Notes |
|---|---|---|---|
| POST | `/v1/margin/basket` | read | G2 |
| POST | `/v1/margin/check` | read | G3 + F9 + G8 check; opens no ticket and places nothing |
| GET | `/v1/margin/rules` | read | Rule table with `verified` |
| GET | `/v1/margin/status?accounts=a,b` | read | Per account: `source`, `reason`, `basketMargin` capability, `slicing`, budget left, calibration n per class |
| GET | `/v1/charges/plans` | read | Plans for the accounts the key may use, with `origin` |
| PUT | `/v1/charges/plans/{account}` | admin, loopback | Body = Plan. Audited `charges.plan_set`. |
| DELETE | `/v1/charges/plans/{account}` | admin, loopback | Back to config/default. Audited `charges.plan_removed`. |
| POST | `/v1/demo/margin` | read | **Demo mode only** (not registered otherwise) |

Why `read` for basket and check: they only read broker margin, positions and funds, which `read` keys can already read (`/v1/positions`, `/v1/funds`). This matches BRD §5.6. Account restrictions on the key apply (`ctx.requireAccountAccess`). For `paper-source`, the key needs access to the **paper** account only. The source account is used on the owner's behalf, and its id is returned as a label only to principals that may use it; otherwise `sourceLabel` reads "your linked broker account".

### 3.2 Common errors and reasons

HTTP errors use the existing Problem shape and codes. No new error code is needed.

| Status / code | When |
|---|---|
| 400 `VALIDATION_FAILED` | Bad body: empty `legs`, more than `maxLegs`, units not positive, `lots` and `quantity` both given, unknown `intent`. `errors[].path` such as `legs[2].lots`. |
| 403 `ACCOUNT_FORBIDDEN`, 404 `ACCOUNT_NOT_FOUND` | As elsewhere |
| 404 `SYMBOL_NOT_FOUND` | A leg does not resolve. `errors[].path = legs[i].symbol`. The whole request fails, because a partial basket margin would mislead. |
| 403 `SCOPE_REQUIRED`, `LOOPBACK_ONLY` | Plan writes |
| 503 `NOT_IMPLEMENTED` | `margin.enabled: false` |

**Broker failures are not HTTP errors.** They return 200 with `broker: null` and `reason`, one of:

`NOT_SUPPORTED` (the adapter has no `basketMargin`) · `PAPER_NO_SOURCE` (paper account, no `paperSourceAccount`) · `SESSION_EXPIRED` · `TIMEOUT` · `RATE_LIMITED` (broker 429) · `BUDGET_USED` (our per-minute budget; `retryAfterMs` given) · `BROKER_ERROR` (with the broker's message, ≤ 200 chars, redacted) · `UNSUPPORTED_LEG` (for example MCX/CDS legs or a broker's single-order API with several legs) · `DISABLED_IN_DEMO_SCENARIO`.

The OpenAPI enum is documented as open (§7.8: new values are additive).

### 3.3 `POST /v1/margin/basket`

Request:

```json
{
  "account": "zerodha-main",
  "mode": "live",
  "legs": [
    { "symbol": "NFO:NIFTY-2026-11-03-25600-CE", "side": "SELL", "lots": 1, "product": "MARGIN", "orderType": "LIMIT", "price": 60 },
    { "symbol": "NFO:NIFTY-2026-11-03-25800-CE", "side": "BUY",  "lots": 1, "product": "MARGIN", "orderType": "LIMIT", "price": 25 }
  ],
  "considerPositions": true
}
```

- `account` is required. `mode` is optional: default `"paper"` for paper accounts, else `"live"`. It is used only to choose the funds book and is never a trading switch.
- Each leg takes `symbol` (canonical or anything `symbols.resolve` accepts), `side`, either `lots` or `quantity` (units), `product` (`INTRADAY | MARGIN`), and optionally `orderType` (default `LIMIT`), `price` (default: current LTP, flagged in `notes`) and `triggerPrice`.
- `considerPositions` defaults to the config value.

Response: `{ data: BasketResult, meta: { requestId, accountId, demo? } }` (§2.3).

Behaviour, in order:

1. Validate, then resolve every leg (`symbols.resolve`; lot, tick, freeze).
2. Compute the estimate (pure).
3. Resolve the source (§2.1 `sources.mjs`).
4. Check the cache (key §7.8): on a hit, recompute premium-dependent fields from the request prices (§7.8) and return.
5. Check the budget: if used, return `reason: BUDGET_USED`.
6. Make one call through the scheduler with `brokerTimeoutMs`.
7. Normalise the answer and read funds (portfolio class, coalesced with the dashboard's own 15 s funds read).
8. Write the calibration row when eligible.
9. Cache and return.

Concurrent identical requests share one call (singleflight).

### 3.4 `POST /v1/margin/check`

Request: `BasketRequest` plus:

```json
{ "intent": "entry", "sendOrder": [1, 0], "stale": { "legTs": ["2026-10-29T10:15:01.200+05:30", null] } }
```

- `intent`: `"entry" | "exit" | "roll" | "adjust" | "guardExit"`. It decides the margin-covered order and the F9 wording.
- `sendOrder`: indices in the order the client will send. Default: the margin-covered order from `sendOrderFor(legs, intent)`.
- `stale.legTs`: optional per-leg quote timestamps (P1-4). Without it, quote freshness is used.

Response `data` (`CheckResult`):

```json
{
  "ok": false,
  "blocking": 1, "warnings": 2,
  "margin": { "...": "BasketResult (§2.3), identical to /v1/margin/basket for the same body" },
  "sequence": {
    "order": [0, 1], "intent": "entry", "available": 100000.0, "creditSellPremium": false,
    "steps": [
      { "k": 1, "leg": 0, "label": "SELL 25600 CE ×1", "margin": 110250.0, "premiumPaid": 0, "headroom": -10250.0,
        "basis": "broker", "flag": "short" },
      { "k": 2, "leg": 1, "label": "BUY 25800 CE ×1",  "margin": 18200.0,  "premiumPaid": 1625.0, "headroom": 80175.0,
        "basis": "broker", "flag": null }
    ],
    "risk": "leg-reject",
    "covered": { "order": [1, 0], "worstHeadroom": 80175.0, "basis": "broker", "steps": [ "…" ] },
    "brokerCalls": 4
  },
  "lines": [
    { "code": "SEQUENCE_SHORT", "severity": "block", "legs": [0],
      "title": "Short of margin after leg 1",
      "text": "Sending SELL 25600 CE first needs ₹1,10,250 with ₹1,00,000 free: the broker is likely to reject it and leave the basket part-filled. Sending BUY 25800 CE first keeps margin covered at every step (lowest free ₹80,175).",
      "action": { "kind": "useOrder", "order": [1, 0], "label": "Use margin-covered order" },
      "rule": { "id": "PEAK_MARGIN_PENALTY", "source": "…", "effectiveFrom": null, "verified": false } },
    { "code": "SLICED", "severity": "info", "legs": [0], "title": "Goes as 2 orders",
      "text": "40 lots (2,600) is above the freeze quantity 1,800. The Bridge sends 1,755 + 845, paced at 5 orders a second (under 1 s). Your broker supports its own slicing; the Bridge does not use it yet. Uses 2 of your 100 orders today.",
      "rule": { "id": "FREEZE_QTY", "source": "exchange list (snapshot 2025-03-01)", "effectiveFrom": "2025-03-01", "verified": false } }
  ],
  "asOf": "2026-10-29T10:15:03.480+05:30",
  "disclaimer": "Checks run on this computer from your broker's figures and dated exchange rules. Brokers can still refuse an order for reasons not shown here."
}
```

`ok` = no `block` line. `severity` is one of `block | warn | info | ok`. Lines sort blocks first, then by leg. Every line carries `rule`, and the UI prints "Rule: … · from 20 Nov 2024 · not yet verified" from it.

**Line catalogue** (each a pure function in `rules.mjs`; facts from `facts.mjs`):

| Code | Severity | When | Text pattern (plain English; no advice words) |
|---|---|---|---|
| `LOT_MULTIPLE` | block | units % lotSize ≠ 0 | "100 is not a multiple of the lot size 65. Use 65 or 130." |
| `LOT_REVISION` | warn | `reference.lotFor` has a revision effective within 7 days, or the leg uses the old lot | "NIFTY lot size changes from 75 to 65 on 30 Dec 2025 (contracts expiring after …)." |
| `SLICED` | info | units > freeze and `orders.sliceAboveFreeze` | §7.4 numbers; native capability named, not used |
| `FREEZE_BLOCK` | block | units > freeze and slicing off, or slices > `maxSlices` | "…above the freeze quantity 1,800. Turn on orders.sliceAboveFreeze or send 1,755 or less per order." |
| `FREEZE_UNKNOWN` | info | no freeze figure | "Freeze quantity unknown for this contract: slicing is not checked." |
| `LOTS_CAP` | block | lots > the safety `maxLotsPerOrder` (whole order, as SafetyGuard counts today) | "40 lots is above your per-order limit of 10 lots (safety.maxLotsPerOrder). Slicing does not change this limit." |
| `ORDER_COUNT` | warn/block | broker orders (with slices) > remaining daily count | "This basket sends 9 orders; 4 remain today." |
| `PRICE_BAND` | block (exchange band, live) / warn (Bridge band) | limit outside the circuit limits, or outside `priceBandPct` vs LTP | names which band |
| `FAR_OTM_RANGE` | warn (unverified) | \|K/S − 1\| > rule value | §1.3 |
| `BAN` | block (opening leg) / info (closing) / warn (data unavailable) | `reference.banStatus().inBan` | "RBLBANK is in the F&O ban period: new positions are not allowed; closing trades are." |
| `EXPIRY_ELM` | info (+ ₹) | short index option expiring today | "Expiry day: +2 % ELM on this short, ≈ ₹32,695 (included in the broker figure)." |
| `EXPIRY_CALENDAR` | warn | an expiring-today leg and a later-expiry leg of the same underlying, on opposite sides | "Expiry day: no calendar-spread margin benefit between the 3 Nov and 10 Nov legs." |
| `UPFRONT_PREMIUM` | info | any buy leg | "Premium for buys is collected up front: ₹3,575." |
| `SHORTFALL` | block (broker figure, or paper engine) / warn (estimate) | final + premium > available | as `strategyWarnings` today |
| `SEQUENCE_SHORT` | block (entry, broker basis) / warn (exit, or estimate basis) | any step headroom < 0 | §7.3; the action offers the covered order |
| `SEQUENCE_UNCHECKED` | info | sequence disabled, or no figures at all | "Margin after each leg not checked (no broker figure or estimate)." |
| `READINESS` | block (`cannot_trade`, live) / warn (`warn`) / info (paper or unavailable) | P1-5 | the reasons from readiness |
| `STALE_PRICE` | warn | market open and age > `staleMs` | "Price of 25600 CE is 14 s old." |
| `SESSION` | block (live, closed) / warn (pre-open) | `reference.session` or `lib/marketHours` | |
| `NETTING` | info | a leg reduces or flips an open position | "Leg 2 closes 1 of your 2 short lots of 24700 PE." |
| `MARGIN_SOURCE` | info | always | "Broker figure at 10:15:03 (Zerodha)." or "Estimate: broker figure unavailable (session expired)." |

The check never refuses for a missing optional fact. Each missing fact becomes an `info` line saying which check did not run (BRD §7.6).

### 3.5 Plans

`GET /v1/charges/plans` returns `data: [{ accountId, broker, plan, origin, verified, asOf }]`.

`PUT /v1/charges/plans/{account}` takes a Plan body (strict; `value` 0–1,000; `pct` 0–0.05; `cap` 0–1,000; `futPct` 0–0.05; `physicalPct` null or 0–0.05). It returns the stored plan with `origin: "user"`.

`DELETE /v1/charges/plans/{account}` returns 204.

Writes emit `charges.plan_changed` and are audited. They need `admin` scope and loopback, like other settings that change what figures every client sees (the same stance as P1-2 reference writes).

### 3.6 `POST /v1/demo/margin` (demo only)

Body `{ "scenario": "normal" | "no-api" | "slow" | "error" | "tight-funds" | "expiry-day" | "session-expired" }`. Returns `{ data: { scenario, until } }`. A scenario auto-resets after 30 minutes or on `"normal"`. §5 says what each one shows.

### 3.7 Compat `/api/v1/margin` (S14)

The compat-API request is `{ apikey, positions: [{ symbol, exchange, action, quantity, product, pricetype, price }] }`. It is mapped to `margin.basket`. The reply is:

```json
{ "status": "success", "data": { "total_margin_required": 41210.5, "span_margin": 28650.0, "exposure_margin": 9010.5,
  "source": "broker", "as_of": "…" } }
```

With `broker: null`, the reply is `{ status: "success", data: { total_margin_required: <estimate>, source: "estimate", reason } }`. The field names follow the compat API (**needs verification** against its reference); the `source` and `reason` extras are Bridge extensions, documented as such.

### 3.8 MCP (read tools only)

- `get_basket_margin({ account, legs, considerPositions? })` returns `BasketResult`.
- `check_basket({ account, legs, intent?, sendOrder? })` returns `CheckResult` without `action` objects. An assistant can read the margin-covered order, but it cannot apply it. It may only prepare orders through the existing ticket flow, which a person confirms.
- Both tools are listed in `mcp/tools.mjs` with `readOnlyHint: true`. `tools.test.mjs` asserts that neither can reach orders.

### 3.9 `docs/openapi.yaml` additions

- Add a tag: `- name: Margin` with description "Broker basket margin, our estimate when the broker cannot answer, rule-aware pre-trade checks and brokerage plans (stream S23). Reads only; nothing here places an order."
- Add eight `paths` entries in the file's disciplined layout. `openapi.test.mjs` reads `x-stream: S23`, `x-scope` and `x-loopback-only: true` on the two plan writes. Example:

```yaml
  /v1/margin/basket:
    post:
      tags: [Margin]
      operationId: basketMargin
      summary: Margin for a basket of legs, with hedge benefit
      description: >-
        Asks the account's broker for the margin of the whole basket (required without hedge benefit, final with it)
        and returns it with the broker's answer time. When the broker cannot answer, `broker` is null, `reason` says
        why and `estimate` carries our figure with an error band. Cached for 5 seconds per basket. Places nothing.
      x-stream: S23
      x-scope: read
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/BasketMarginRequest" }
      responses:
        "200":
          description: Basket margin.
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { $ref: "#/components/schemas/BasketMarginResult" }
                  meta: { $ref: "#/components/schemas/Meta" }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }
```

- Add schemas (units in descriptions: ₹ for money; quantities in units; `lots` integer):
  - `MarginLeg`: `symbol`, `side`, `lots` | `quantity` (oneOf), `product` enum [INTRADAY, MARGIN], `orderType` enum [LIMIT, MARKET, SL, SL-M], `price`, `triggerPrice`
  - `BasketMarginRequest`: `account`, `mode`, `legs` (1–40), `considerPositions`
  - `BrokerMargin`: `required`, `final`, `hedgeBenefit`, `span`, `exposure`, `premium`, `elm` (number|null), `includesPositions`, `at`
  - `MarginEstimate`: `required`, `band` (2 numbers), `bandQuality` enum [default, measured], `class` enum [defined, undefined], `method`, `n`
  - `BasketMarginResult`: as §2.3; `source` enum [broker, paper-source, demo-broker, none]; `reason` (string|null, open enum listed in the description)
  - `PretradeCheckRequest`: `BasketMarginRequest` + `intent`, `sendOrder`, `stale`
  - `CheckLine`: `code` (open enum), `severity` enum [block, warn, info, ok], `legs`, `title`, `text`, `action` (nullable), `rule` (`RuleRef`)
  - `SequenceStep`, `PretradeCheckResult`
  - `RuleRow`: `id`, `value`, `effectiveFrom`, `source`, `verified`, `enabled`
  - `ChargePlan`, `ChargePlanEntry`
- `PreviewResult.margin` is unchanged (paper-model). Its description gains one sentence: "For basket margin with hedge benefit use POST /v1/margin/basket."
- `/api/v1/margin`: change the summary from "(not available yet)" to "Basket margin (broker figure or estimate)" and document `positions`.
- `Quote`: add `upperCircuit`, `lowerCircuit` (number|null, optional; "the exchange price band where the broker publishes it").
- `BrokerCapabilities`: add `basketMargin` and `slicing`.

---

## 4. How it works (request flow)

```
Builder edit ──400 ms debounce──▶ POST /v1/margin/basket ─┐
Placement sheet open / mode change ─▶ POST /v1/margin/check ┤
Ticket qty/price change ──400 ms──▶ POST /v1/margin/check   ┤
                                                             ▼
                     margin.basket(): resolve legs ─ estimate (pure, margin-core.js)
                        │  source = broker | paper-source | demo-broker | none
                        ├─ cache hit (≤ 5 s) ─▶ reprice premium ─▶ result
                        ├─ budget? ─ no ─▶ reason BUDGET_USED + estimate
                        └─ scheduler.schedule({ accountId: source, endpointClass: "other", priority: "interactive",
                               coalesceKey: "margin:"+hash }) → adapter.fetchBasketMargin → normalise
                     margin.check(): facts (allSettled, 1.5 s cap each) ─▶ rules.mjs lines
                        └─ sequence: prefixes P1…Pn in sendOrder → broker (≤ maxBrokerCalls) / scaled estimate
                           → headroom per step → if any < 0: sendOrderFor(intent) → evaluate the covered order
```

---

## 5. Demo mode

Goal: `mc-bridge start --demo`, open `#/strategy`, build an iron condor, and every behaviour in this spec is visible within a minute at any hour, with no broker and no network.

### 5.1 Demo adapter (`demo/demoAdapter.mjs`)

- `capabilities.basketMargin = { considerPositions: true, maxLegs: 20 }` and order feature `slicing = { native: "autoslice", maxLegs: 10, verified: true, source: "demo" }`. The capability is shown, never used.
- Quotes gain `upperCircuit` / `lowerCircuit`. Options use `max(0.05, round(prevClose × (1 ± band)))`, with band 40 % beyond 10 strikes from ATM and 20 % nearer (sample values). Futures and indices use ±10 %. This makes the price-band line testable: a limit of 3 × LTP on a near strike trips it.
- `fetchBasketMargin(creds, orders, { positions })` uses the **demo SPAN-like model** in §7.5, valued with the adapter's own `optionPrice`/`smileVol`/`futurePrice` at `now()`. It is deterministic for a given `now`. `at = now()`. `includesPositions: true` when `positions` are given, and `incremental: true`.
- `fetchFunds` is unchanged (₹2,50,000 available on the `demo` account).

### 5.2 Paper accounts in demo

Demo mode sets `margin.paperSourceAccount = "demo"`. The `demo-paper` account (paper engine, ₹10,00,000 starting capital) then gets `source: "demo-broker"`. The service passes the **paper** positions in `positions`, and the label is "Demo broker figure (sample) at 10:15:03". `available` is the paper engine's free funds.

### 5.3 Scenarios (`POST /v1/demo/margin`, also buttons on the Safety page's existing demo card)

| Scenario | What changes | What the user sees |
|---|---|---|
| `normal` | — | Broker-labelled figures, hedge benefit, sequence all green for hedges-first |
| `no-api` | `basketMargin` treated as unsupported | "≈ estimate", rough band, `MARGIN_SOURCE` reason "Not supported by this broker" |
| `slow` | Adapter waits 1,800 ms | Spinner then figure; the e2e latency test uses `normal` |
| `error` | Adapter throws `UPSTREAM_ERROR` | Estimate with reason `BROKER_ERROR` |
| `tight-funds` | Available overridden to ₹1,00,000 for the demo-paper account in margin figures only (the paper engine is untouched; labelled "demo: funds lowered") | Iron condor entered sells-first → `SEQUENCE_SHORT` with "Use margin-covered order"; naked strangle → `SHORTFALL` |
| `expiry-day` | The margin service and the demo model treat NIFTY's nearest expiry as today | `EXPIRY_ELM` with ₹, `EXPIRY_CALENDAR` on a calendar, higher broker figure |
| `session-expired` | Adapter throws `SessionRequiredError` | Reason `SESSION_EXPIRED`; with P1-5 present, the `READINESS` line also shows |

Also visible without scenarios:

- **Slicing**: 30 lots of NIFTY (demo lot 75 → 2,250 > freeze 1,800). Note that `LOTS_CAP` blocks at the default 10 lots, which demonstrates both lines.
- **Far-OTM**: any strike more than 10 % from spot (the demo chain has ±30 strikes; NIFTY step 50 reaches ±6 %, BANKNIFTY step 100 reaches ±5.3 %). The demo builder therefore cannot reach the threshold, so the demo scenario `expiry-day` also lowers `FAR_OTM_RANGE` to 0.04 **in demo only**, labelled "demo threshold".
- **Ban**: P1-2's demo ban list (once P1-6 gives demo stocks options).
- **Stale price**: P1-4's demo `stall`.

Demo plans: `demo-paper` defaults to flat ₹20 (§11.2); the Accounts page editor works against `dataDir-demo`.

---

## 6. Dashboard

All new UI comes from `margin.js` renderers, so the four surfaces look and read the same. Copy is descriptive and uses no advice words (the banned list in `screens.test.mjs`).

### 6.1 Builder (`#/strategy`, `strategy.js`)

- **Margin tile** (`case "margin"`):
  - Replaces the per-leg `/v1/orders/preview` loop in `runPreviews` with **one** `POST /v1/margin/basket` (debounced 400 ms on leg structure changes and on price changes > 1 %). The 400 ms `pvTimer` already exists.
  - Freeze quantities now come from `legs[].freezeQty` in the result.
  - Value: broker `final` + premium (₹). Sub-line: "broker figure at 10:15:03 · hedge benefit ₹1,41,130 · ₹2,08,790 free". On a paper source: "broker figure from Zerodha · your paper positions not included". In demo: "demo broker figure (sample)". On estimate: "≈ ₹1,74,818 · estimate · ₹1,04,891 – ₹2,09,781 (rough band)".
  - Tooltip: the BRD notes on later differences (SPAN updates, ELM, MTM, peak snapshots), the reason when estimated, and the method.
  - While loading, the tile keeps the last value with `data-pending` (no spinner flash).
- **Return on margin** uses the same figure.
- **Pre-trade panel**: a disclosure under the warnings list, titled "Before you send: 1 blocked · 2 to note". It calls `POST /v1/margin/check` (`intent` from the builder: `exit` when `R.exit`, else `entry`) only when opened or when the Place button is focused. Each line is a row: severity glyph (✕ / ! / i / ✓; colour is never the only signal), title, text, and a "Rule" sub-line with source, date and "not yet verified" when applicable. A `useOrder` action renders as a button that reorders the placement plan.
- **Charges**: `O.charges(act, rates, { lotSize, profile: plan })`, with the plan from `GET /v1/charges/plans` (cached per page load, re-read on `charges.plan_changed` via the existing event stream, else every 10 min). The tooltip names the plan: "Brokerage: flat ₹20 per order (Zerodha default, not verified)".

### 6.2 Ticket (`desk.js openTicket`)

- Under the existing preview checks, one **margin line**: "Margin ₹1,10,250 · broker figure at 10:15:03 · ₹1,39,750 free after", or the estimate wording.
- One compact check list. It shows only `block` and `warn` lines plus `SLICED`. The full list sits behind "All checks (6)".
- Triggered by the existing preview call path, debounced 400 ms on qty/price. The ticket sends `/v1/orders/preview` (unchanged; it still decides tickets and safety) and `/v1/margin/check` in parallel.
- A `block` line from the check disables Place, as preview blocks do today, with the reason in the button's description.
- Exit tickets (`exit: true`) pass `intent: "exit"`, and the margin line reads "releases ≈ ₹…" when the broker figure is negative incremental.

### 6.3 Placement sheet (`strategy-place.js openPlacement`)

- `preflight()` also calls `POST /v1/margin/check` with `sendOrder` = the sheet's row order and `intent` (`entry`/`exit`).
- The check's lines replace `o.warnings` (keeping `strategyWarnings` blocks as a fallback when the call fails).
- A new column **"Free after"** shows `sequence.steps[k].headroom` per row. A negative value gets `data-short` and a "short" text tag.
- If `sequence.risk` is set and `covered` exists, a bar above the table reads "Send order leaves you short of margin after leg 1. [Use margin-covered order]". Pressing it reorders `rows` (only in phase `confirm`) and re-runs preflight.
- The Place button label already says "hedges first" / "shorts first", and stays.
- When the state machine pauses (hedge timeout) or stops part-way, a "Re-check remaining legs" button calls `check` with the unsent legs. The filled legs now count as positions, because the broker sees them. This covers F9 "partial fill" this round.

### 6.4 Positions exit plan (`positions.js`)

- The exit-plan sheet (`O.exitPlan`, shorts first) calls `check` with `intent: "exit"` and shows the same panel and "Free after" column.
- The exit charges line uses the account plan.
- The book strip's Margin tile is unchanged (account-wide funds).

### 6.5 Accounts page (`views.js renderAccounts`): brokerage plan editor

- Each account card gets a row "Brokerage plan: Flat ₹20 per order · Zerodha default (not verified)" and an **Edit** button. The editor opens a sheet with:
  - a segmented control: Flat / Per lot / % capped / Zero;
  - numeric fields for the chosen model;
  - "futures: lower of ₹20 and 0.03 %";
  - a checkbox "Charge brokerage on exercise / assignment";
  - "Physical delivery fee %" (optional).
- **Save** sends `PUT`; **Reset to default** sends `DELETE`. The editor is shown only to the local dashboard (loopback). A remote demo dashboard sees it read-only.
- `arbitrage.js` defaults its `conf.profile` from the selected account's plan. It shows "Using the account plan" with an override toggle, so its existing per-page profile settings keep working (back-compat §11).

### 6.6 Phone, tablet, desktop

| Width | Builder tile and panel | Placement sheet | Ticket |
|---|---|---|---|
| Phone (< 600 px) | Tile sub-line truncates to "broker 10:15:03"; full text in the tile's tap sheet. Panel collapses to a chip "1 blocked · 2 to note" that opens a bottom sheet with the list. | "Free after" becomes a second line under each leg row ("Free after: −₹10,250 short"). The reorder bar is sticky above the buttons. | Margin line on its own row; checks as a chip that expands inline. Touch targets ≥ 44 px. |
| Tablet (600–1023 px) | Panel inline under the metrics grid, two columns (blocks and warnings left, info right) | Table with the extra column; horizontal scroll inside `.table-wrap` only | As desktop |
| Desktop (≥ 1024 px) | Panel inline, one column, rule sub-lines visible | Full table | Inline list |

There is no horizontal page scroll, and the 16 px gutter is kept (BRD §7.3).

### 6.7 CSS and accessibility

`app.css` gets four rules, tokens only:

- `[data-severity="block"]` → `--c-bad`
- `[data-severity="warn"]` → `--c-warn`
- `[data-short]` → `--c-bad`
- `[data-pending]` → opacity token

The restyle team owns final looks.

- The check list is a `<ul>` with each line's severity as visible text ("Blocked:", "Note:") and the glyph `aria-hidden`.
- The panel summary is `role="status"` and `aria-live="polite"`, announced only when the blocked count changes.
- The reorder button has a full description ("Reorder legs: buys first, then sells").

---

## 7. Formulas and worked examples

All functions live in `dashboard/margin-core.js`. Each has a reference-value test with the numbers below (`margin-core.test.mjs`). Money is ₹, quantities in units, rounding only at display.

### 7.1 Estimate (unchanged model, moved and extended)

This is the existing `options.js marginEstimate` (PRD 02 §6.11), re-exported from `margin-core.js`. `options.js` re-exports it, so existing callers and tests keep working. Inputs: legs, lot size, forward F, `expiryToday`. Then:

- Defined risk (option legs only, max loss finite, no net short puts below the lowest strike): `required = |maxLoss|`.
- Otherwise: `required = scanLoss(F ± 9 %) + 0.02 × (short-option notional + futures notional) + net debit`.
- Plus `0.02 × short-option notional` on expiry day.

New in P1-10:

- **Premium**: `premium = Σ_buy price × units`. Shown separately. The estimate's net debit already contains it, so it is not added twice.
- **Expiry-day calendar**: on expiry day, legs expiring today and later legs are estimated as **two separate baskets** and summed (no cross-expiry offset).

*Example A (defined risk).* Sell NIFTY 25000 PE @ 80 and buy 24800 PE @ 40, 1 lot of 65. Max loss = (200 − 40) × 65 = **₹10,400** → estimate ₹10,400 (credit ₹2,600).

*Example B (undefined risk).* F = 25,150. Sell 25600 CE @ 60 and 24700 PE @ 70, 1 lot of 65 each.

- Scan lo = 22,886.5 and hi = 27,413.5. At lo, the put is 1,813.5 in the money, so P&L = (130 − 1,813.5) × 65 = −₹1,09,427.5. The hi side is the same by symmetry. scanLoss = **₹1,09,427.5**.
- Short-option notional = 2 × 65 × 25,150 = ₹32,69,500. Exposure 2 % = **₹65,390**. Debit = 0.
- **Required ≈ ₹1,74,817.5.**
- On expiry day, +ELM 2 % × 32,69,500 = ₹65,390, giving **₹2,40,207.5**.

### 7.2 Margin-covered send order (`sendOrderFor(legs, intent)`)

One function replaces the two orderings in the code today (`strategy-place.js` phases and `options.js exitPlan` sort):

- **entry / adjust / roll-open part**:
  - Phase 1: option buys, nearest-to-ATM first. Within the same expiry, the buy that caps a short comes first: the same right, beyond that short's strike, with the smallest distance.
  - Phase 2: futures that reduce |net Δ|.
  - Phase 3: option sells, smallest standalone margin first (this needs the estimate's standalone figure).
  - Phase 4: remaining futures.
- **exit / guardExit / roll-close part**:
  - Phase 1: buy-backs of shorts, largest |Δ| first (as `exitPlan`).
  - Phase 2: sells of long options.
  - Phase 3: futures last.
- **roll**: close part first (exit rules), then open part (entry rules).

Ties keep input order (stable).

### 7.3 Margin after each leg (F9)

For send order (i₁…iₙ), prefix basket P_k = {i₁…i_k}, with A₀ = available before sending:

- M_k = incremental margin of P_k (broker `final` with positions considered; normalised to incremental, §2.3).
- Pay_k = Σ premium of buys in P_k.
- Cr_k = Σ premium of sells in P_k if `creditSellPremium`, else 0.
- **H_k = A₀ − M_k − Pay_k + Cr_k**.
- The flag on step k is `short` when H_k < 0.
- `risk` is set as follows:
  - `"shortfall"` if H_n < 0. That is the `SHORTFALL` line; there is no sequence line.
  - Otherwise `"leg-reject"` (entry: the broker RMS is likely to refuse leg k) or `"penalty"` (exit: if accepted, the account is short until later legs fill) if any H_k < 0 for k < n.
  - Otherwise `null`.
- **basis** per step is `broker` for the first `maxBrokerCalls` prefixes (P_n always first, because it is the basket call). Prefixes beyond that use the **scaled estimate**: M_k ≈ est(P_k) × (M_n / est(P_n)), labelled.
- When `risk` is set, the service evaluates `sendOrderFor(legs, intent)` the same way and returns it as `covered`, with its worst headroom. If that order is also short, the line says so ("No order keeps margin covered with ₹… free; the basket needs ₹… more") and offers no action.

*Example C (iron condor entry, tight funds; prefix figures are broker answers given as test inputs).* A₀ = ₹1,00,000, 1 lot of 65. Legs:

- 0: sell 25600 CE @ 60
- 1: sell 24700 PE @ 70
- 2: buy 25800 CE @ 25
- 3: buy 24500 PE @ 30

| Order | k | M_k | Pay_k | H_k |
|---|---|---|---|---|
| typed 0,1,2,3 | 1 | 1,10,000 | 0 | **−10,000** short |
| | 2 | 1,25,000 | 0 | **−25,000** short |
| | 3 | 72,000 | 1,625 | 26,375 |
| | 4 | 36,000 | 3,575 | 60,425 |
| covered 2,3,0,1 | 1 | 0 | 1,625 | 98,375 |
| | 2 | 0 | 3,575 | 96,425 |
| | 3 | 18,000 | 3,575 | 78,425 |
| | 4 | 36,000 | 3,575 | 60,425 |

Result: `risk: "leg-reject"`, line `SEQUENCE_SHORT` (block, broker basis), action "Use margin-covered order" [2, 3, 0, 1], worst headroom ₹60,425. Broker calls = 4 + 4 = 8 (= `maxBrokerCalls`). The covered order's P_4 equals the typed P_4 and comes from the cache, so it costs 7 calls.

*Example D (exit, penalty).* Same condor held, exit typed as sell longs first (2, 3, then buy back 0, 1). With A₀ = ₹20,000 and current blocked ₹36,000:

- After leg 2 the call side is naked: M rises by ₹38,000 (incremental) → H₁ = 20,000 − 38,000 = **−18,000**.
- `risk: "penalty"`, severity `warn` (exit), action → covered order [0, 1, 2, 3], where every step releases margin (H_k ≥ 20,000).

### 7.4 Slicing plan (G8 check)

This reuses `orderValidation.checkInstrumentOrder` through `previewLegs` (one implementation):

- perSlice = ⌊freeze / lot⌋ × lot
- slices = ⌈units / perSlice⌉
- time at the cap ≈ ⌈slices / orderRatePerSecond⌉ s

**Example E.** NIFTY lot 65, freeze 1,800 (snapshot list, unverified). perSlice = 27 × 65 = 1,755.

- 40 lots = 2,600 units → 2 slices (1,755 + 845), < 1 s at 5/s, uses 2 daily orders.
- 100 lots = 6,500 → 4 slices (1,755 × 3 + 1,235).

But `LOTS_CAP` blocks both at the default `maxLotsPerOrder` of 10. The check states both lines, because SafetyGuard counts lots for the whole order.

### 7.5 Demo SPAN-like model (sample, not exchange SPAN)

Per underlying u, with price scan range PSR_u (NIFTY 8 %, BANKNIFTY 9 %, SENSEX 8 %; sample values) and vol scan VSR = 4 vol points:

- **Scenarios**: price moves m ∈ {0, ±⅓, ±⅔, ±1} × PSR × F, each with vol −VSR and +VSR (14), plus two extremes ±2 × PSR at vol 0 weighted 35 % (16 in all, SPAN-style). The basket (plus `positions`) is valued with Black-Scholes at scenario spot/vol and the same T. Futures are linear.
- SPAN = max(0, max over scenarios of loss). On expiry day, legs expiring today form their own group (no calendar offset).
- Exposure = 2 % × F × units for short options and futures.
- ELM = 2 % × F × units on short index options expiring today.
- final = SPAN + exposure + ELM + premium (buys).
- required = Σ standalone(final of each leg alone).
- hedgeBenefit = required − final.

**Example F (futures only, exact).** Short 1 lot NIFTY futures at demo F = 25,150, lot 75:

- Worst scenario is +8 %: SPAN = 0.08 × 25,150 × 75 = ₹1,50,900. The extreme ±16 % × 35 % = 5.6 % is smaller.
- Exposure = 0.02 × 25,150 × 75 = ₹37,725.
- **final = required = ₹1,88,625**, hedge benefit 0.

Option baskets are tested by property, not by value: final ≤ required, a vertical spread's final ≤ width × units + premium, the expiry-day figure > the normal-day figure, and the same `now` gives the same figure.

### 7.6 Error band and calibration

The class is `defined` | `undefined`, combined with `expiryDay` (four classes). Over calibration rows of the last `calibrationDays` (90) for the class:

- n ≥ 30: band = [estimate × q₁₀(ratio), estimate × q₉₀(ratio)], `bandQuality: "measured"`. q is linear-interpolated on the sorted ratios.
- Otherwise: band = estimate × config default, `bandQuality: "default"`.

**Example G.** Estimate ₹1,74,817.5 (undefined), n = 12 → default [0.60, 1.20] → **₹1,04,890.5 – ₹2,09,781**, "rough band, not measured".

**Example H.** n = 40 measured ratios with q₁₀ = 0.78 and q₉₀ = 0.97 → ₹1,36,357.7 – ₹1,69,573.0, "measured on this computer, n = 40".

### 7.7 Brokerage under a plan (G9) and the charges acceptance test

`brokerageFor({ kind, turnover, lots }, plan)` is the existing `options.js` function, with plan = profile. Statutory lines come from `chargeLines` with `reference.charges()` (fallback `REF_DEFAULTS` in `reference.js`).

**Example I.** Sell 1 lot NIFTY 25600 CE @ 60 × 65 = turnover ₹3,900, NSE. STT 0.15 % = 5.85; txn 0.03503 % = 1.36617; SEBI ₹10/crore = 0.0039; stamp 0 (sell); GST 18 % on (brokerage + txn + SEBI).

| Plan | Brokerage | GST | **Total** |
|---|---|---|---|
| Zero | 0 | 0.246613 | **₹7.47** (7.466683) |
| Flat ₹20 | 20 | 3.846613 | **₹31.07** (31.066683) |
| 0.03 % capped at ₹20 | 1.17 | 0.457213 | **₹8.85** (8.847283) |

The % plan cap binds at turnover ≥ ₹66,666.67: for example 0.03 % × 1,00,000 = 30 → 20.

Paper fills use the same plan. `paper/fillModel.brokerageFor(turnover, b)` is replaced by `planBrokerage({ kind, turnover, lots }, plan)` (imported from `margin-core.js`). When `chargePlans` is a stub, `cfg.brokerage` is mapped as before: perOrder + pct, capped by maxPerOrder.

### 7.8 Cache key and premium repricing

key = sha256 of canonical JSON: `{ v: 1, source: <accountId used>, positions: considerPositions, legs: sorted by (symbol, side) → [symbol, side, units, product, orderType, priceBucket] }`.

- For **sell** legs, priceBucket = `null`: SPAN and exposure do not depend on the limit price.
- For **buy** legs, priceBucket is `null` when the broker reports `premium` separately. On a hit, final = cached (final − premium) + Σ buy price × units at the request prices. Otherwise priceBucket = price rounded to the tick.
- Keys differ for a paper account priced through a source account (`source`), so two holders never share a cache entry.
- TTL is `cacheTtlMs` (5 s), with an LRU cap of 500 entries.

### 7.9 Expiry-day ELM line

ELM = rate × F × units for each short index-option leg expiring today, where the rate is `reference.charges().margin.expiryDayElmIndexShort` (the single home of this figure, added by P1-6). For example, 2 lots NIFTY (130 units) at F = 25,150 gives 0.02 × 25,150 × 130 = **₹65,390**.

---

## 8. Rate-limit budget

| Call | Class (policy table) | Priority | Per action | Cap |
|---|---|---|---|---|
| Basket margin | `other` (Kite 10/s verified; Dhan 20/s verified; Upstox shared "standard" 50/s, 500/min verified) | `interactive` | 1 per edit after the 400 ms debounce; 0 on a cache hit | `budget.perMinutePerAccount` 60 (≤ 10 % of Kite's other class per minute; 12 % of Upstox's shared minute) |
| Prefix margins (F9) | `other` | `interactive` | ≤ `maxBrokerCalls` (8) per check, only when the check runs (sheet open, ticket edit) | same budget |
| Funds | `portfolio` | `interactive` | 1 per check, coalesced with the page's own read | existing |
| Positions | `portfolio` | `interactive` | 1 per check | existing |
| Quotes (circuit, stale) | quote group | `interactive` | 0 when streamed (P1-4); else 1 batched call per check | existing |

- Nothing runs in the background, so the §7.2 "≤ 50 % background budget" is untouched.
- User-facing order calls (`order` priority) always outrank margin calls in the scheduler's priority queue (`order > live > interactive > background`).
- A user who edits fast cannot exceed the 60-calls-per-minute budget. Past it, the figure falls back to the estimate with `BUDGET_USED` and `retryAfterMs`, and the tile says "Broker figure in 12 s".
- Latency target (AC2, BRD §7.1): basket round trip ≤ 1 s p95 after the last edit = 400 ms debounce + scheduler wait (~0 at interactive) + broker (Kite p95 **needs measuring**; budgeted 500 ms) + < 20 ms of our own work. `brokerTimeoutMs` 2,500 is the hard stop. The e2e test asserts ≤ 1 s with a 300 ms fake broker.

---

## 9. Safety, compliance and honesty gates

### 9.1 Order safety (BRD §7.5; nothing loosens `docs/guides/safety.md`)

- **Reads only.** `margin/*` never imports `orderGate.mjs` and never calls an order method (grep test). MCP tools are read-only and cannot apply an action.
- **Advisory this round, with one hard edge.** The dashboard disables Place on any `block` line. The server's existing gates (safety, mode decision, tickets, P1-6 ban gate, P1-5 readiness gate) remain authoritative and unchanged. A check that cannot run never blocks: it shows `info` lines saying what did not run.
- **Automation contract (binding on P1-12 / H3).** Any automated multi-leg send (guard exit, alert action) **must** call `margin.check({ intent: "guardExit" | … })` first. It sends in `sequence.covered.order ?? sequence.order` and refuses to start if `ok` is false. P1-12's spec references this paragraph.
- **Slicing** stays bridge-paced through `safety.acquireOrderSlot` (default 5/s, clamped ≤ 10/s, under the ALGO_OPS_CEILING rule). Native slicing is reported, never used, this round.
- **Kill switch.** When it is on, `check` adds a `block` line `KILL_SWITCH` ("The kill switch is on. No orders are being sent").
- **Stale data** (BRD §7.5): the `STALE_PRICE` warn line; the ticket's explicit confirmation stays P1-4's M10.

### 9.2 Compliance (BRD §8)

- **Paper vs live labels (§8.2).** "Broker figure" appears only when `source` is `broker` or `paper-source`. "Demo broker figure (sample)" is used for demo. Everything else is "estimate". A test asserts that no string containing "broker figure" renders when `broker` is null.
- **Market-data terms (§8.3).** `paperSourceAccount` must share the paper account's holder (config check). The calibration log holds no account ids or contract symbols. Nothing leaves the machine.
- **RA/IA (§8.1).** Copy says "margin-covered order", "rule", "note", "blocked". It never says "recommended", "best", "safe trade" or "should". The existing banned-word test is extended to `margin.js` and `margin/rules.mjs` strings.
- **Algo framework (§8.1).** Checks do not send anything, so they are not algo activity. The automation contract above keeps P1-12 inside the existing opt-ins.
- **Disclaimers.** The check footer carries the `disclaimer` (§3.4). The margin tooltip carries the BRD's "Blocked margin can later differ…" sentence.

### 9.3 "Needs verification" register (each blocks `verified: true` until a person checks the primary source)

| Item | Where | Primary source to check |
|---|---|---|
| Kite basket endpoint, params, `initial`/`final`, `option_premium`, incremental vs total with `consider_positions` | `zerodhaMargin.mjs`, fixture | kite.trade Connect v3 docs, "Margin calculation" |
| Dhan multi-order margin endpoint and fields | `dhanMargin.mjs` | dhanhq.co v2 docs, "Margin Calculator" |
| Upstox `/v2/charges/margin` fields | `upstoxMargin.mjs` | upstox.com developer docs, "Margin" |
| Circuit fields on quotes per broker | `*Data.mjs`/`*Market.mjs` | each broker's quote docs |
| Native slicing (Kite iceberg/autoslice, Dhan slicing endpoint, Upstox `slice`) and their caps | `slicing` flags | broker docs |
| Expiry-day ELM 2 % and dates; calendar-benefit removal; upfront premium | `rules.json` | SEBI circular of 1 Oct 2024; NSE/BSE implementation circulars |
| Far-OTM strike rule | `rules.json` `FAR_OTM_RANGE` | NSE/BSE F&O circulars |
| Peak-margin short-collection penalty | `rules.json` | NSE clearing circulars on peak margin |
| Broker default plans | `brokerage-defaults.json` | each broker's pricing page |
| Freeze quantities | P1-2 register | NSE/BSE freeze circulars |

---

## 10. Test plan

### 10.1 Unit (vitest, `environment: node`, fake clock and timers, no network)

| File | Covers |
|---|---|
| `server/bridge/dashboard/margin-core.test.mjs` | Examples A, B (+ expiry day), C, D, E, G, H, I exactly. Example C covered order and call count. `sendOrderFor` per intent, including roll and ties. Prefix scaling. `risk` classification. Calendar split on expiry day. Premium not double-counted. The cap boundary at turnover ₹66,666.67. |
| `server/bridge/margin/rules.test.mjs` | Each line in §3.4: fires, does not fire, severity by mode/basis/verified (an unverified rule never yields `block`), text contains no banned words, and `rule` is present on every line |
| `server/bridge/margin/sources.test.mjs` | broker / paper-source / demo-broker / none. A holder mismatch is rejected at config parse. A disabled source account gives `PAPER_NO_SOURCE`. |
| `server/bridge/margin/marginService.test.mjs` | Cache hit within 5 s and miss after; premium repricing on a hit; singleflight (10 concurrent → 1 adapter call); budget exhaustion → `BUDGET_USED` with `retryAfterMs`; every reason code from a fake adapter (unsupported, session, timeout at `brokerTimeoutMs`, 429, error); `incremental: false` normalisation; `available` from the trading account, not the source; sequence `maxBrokerCalls` honoured; `considerPositions` passthrough; `check` with missing reference/readiness gives `info` lines and never throws |
| `server/bridge/margin/calibration.test.mjs` | Eligibility rules, 10-minute dedupe, percentile band, retention delete, no account id or symbol in rows (assert on the file text) |
| `server/bridge/margin/chargePlans.test.mjs` | Layering user → config → broker default → global; strict validation; corrupt `plans.json` recovery; event emitted; `origin`/`verified` |
| `server/bridge/margin/routes.test.mjs` | Validation paths; scopes (`read` can basket/check; `read`/`paper` cannot PUT plans; non-loopback admin refused); key account restrictions; 404 for an unresolved leg; demo route absent outside demo |
| `server/bridge/margin/noOrders.test.mjs` | No `orderGate`, `placeOrder`, `modifyOrder`, `cancelOrder` in `margin/*` or `dashboard/margin*.js` |
| `server/bridge/paper/fillModel.test.mjs` (update) | `planBrokerage`: zero, flat ₹20, % capped, per lot, futures min. The legacy mapping is unchanged when there is no plan. |
| `server/bridge/paper/paperEngine.test.mjs` (update) | A fill charges the account's plan; a plan change applies to the next fill only |
| `server/bridge/demo/demo.test.mjs` (update) | Example F exact; option-basket properties (§7.5); determinism; circuit limits present; the `slicing` flag |
| `server/bridge/dashboard/margin.test.mjs` | View models: tile text per source (broker/paper-source/demo/estimate/pending); "broker figure" never with `broker: null`; check rows sort and summary chip; sequence list; phone truncation text |
| `server/bridge/dashboard/options.test.mjs` (update) | `charges`/`strategyCharges`/`exitCharges` with `profile`; default behaviour without `profile` unchanged |
| `server/bridge/dashboard/strategy.test.mjs` (update) | One basket call per structure change (not per leg); fallback to `strategyWarnings` when the check fails |

### 10.2 Contract tests

- `server/brokers/contractShapes.mjs` + `contract.test.mjs`: the `basketMargin` shape (required numbers, nullable components, `at`, booleans). A declared capability without the method fails.
- `server/brokers/{zerodha,dhan,upstox}.test.mjs`:
  - The fixture through `runContractHarness` scenario `basketMargin`.
  - The request body maps legs correctly: units, product, transaction type, exchange and token from `toBroker`.
  - HTTP errors map to `SESSION_EXPIRED` / `UPSTREAM_RATE_LIMITED` / `UPSTREAM_ERROR`.
  - No credential appears in an error message.
- `server/brokers/brokerCapabilitiesSnapshot.test.mjs`: snapshot with `basketMargin` and `slicing`.
- `server/bridge/market/normalise.contract.test.mjs`: circuit fields pass through as finite numbers or are absent.
- `server/bridge/core/openapi.test.mjs` (existing) passes with the 8 operations (`x-stream: S23`, scopes, loopback flags); schemas list every field the handlers return (CI fails on an undocumented field, BRD §7.8).
- `server/bridge/mcp/tools.test.mjs`: two tools, read-only.
- `server/bridge/compat/handlers.test.mjs`: `/api/v1/margin` maps both the broker and estimate replies.

### 10.3 End-to-end (`server/bridge/e2e/margin.e2e.test.mjs`, real app on 127.0.0.1, demo mode)

1. `POST /v1/margin/basket` on `demo-paper` with an iron condor: `source: "demo-broker"`, `final < required`, `at` set, `meta.demo: true`.
2. Round trip p95 ≤ 1 s over 20 runs, with the adapter slowed to 300 ms (AC2 timing) and cache busting by lots.
3. A second identical call within 5 s gives `cache.hit: true` and no adapter call (spy).
4. Scenario `no-api`: `broker: null`, `reason: "NOT_SUPPORTED"`, estimate with band.
5. Scenario `tight-funds`: `check` with sells first gives `SEQUENCE_SHORT` and `covered.order` hedges first; with `sendOrder` = covered there is no sequence line.
6. 30 lots NIFTY: `SLICED` + `LOTS_CAP` lines.
7. `PUT /v1/charges/plans/demo-paper` from loopback with an admin key: 200; from a `read` key: 403. A paper fill afterwards charges the new brokerage.
8. Scenario `expiry-day`: `EXPIRY_ELM` with ₹, and `EXPIRY_CALENDAR` for a calendar.
9. The live-mode check on `demo-paper` reports `PAPER_ONLY` through readiness/safety lines and places nothing (order book unchanged).

### 10.4 Acceptance fixture set (AC4: ≥ 18 of 20 flagged)

`server/bridge/margin/rejections.test.mjs` loads `margin/__fixtures__/rejections/*.json`. Each file holds `{ facts, request, expect: { flagged: true|false, codes: [...] }, origin }`, where facts are positions, funds, quotes, reference, readiness, broker prefix figures, limits and clock. It runs `check` with fakes and counts a case as flagged when a `block` or `warn` line with one of `codes` appears.

The cases are **reconstructed** from broker error strings, circular examples and the BRD's penalty cases. We hold no real historical rejection logs. Each file says `origin: "reconstructed"`, and the owner is asked (§13 R3) to add real cases from their audit log over time.

| # | Case | Expected codes |
|---|---|---|
| 1 | NIFTY 2,000 units in one order, slicing off | `FREEZE_BLOCK` |
| 2 | 100 units with lot 65 | `LOT_MULTIPLE` |
| 3 | Old lot 75 used after the revision to 65 | `LOT_MULTIPLE`, `LOT_REVISION` |
| 4 | Limit above the exchange circuit | `PRICE_BAND` |
| 5 | Limit 6 % from LTP (Bridge band 3 %) | `PRICE_BAND` |
| 6 | Fresh short in a banned stock | `BAN` |
| 7 | Naked strangle, free funds below the broker final | `SHORTFALL` |
| 8 | Iron condor entry sells first, tight funds (Example C) | `SEQUENCE_SHORT` |
| 9 | Iron condor exit hedges first (Example D) | `SEQUENCE_SHORT` |
| 10 | Expiry-day short, ELM pushes over free funds | `EXPIRY_ELM`, `SHORTFALL` |
| 11 | Calendar on expiry day loses the benefit | `EXPIRY_CALENDAR`, `SHORTFALL` |
| 12 | Long straddle, premium above free funds | `SHORTFALL`, `UPFRONT_PREMIUM` |
| 13 | Broker session expired | `READINESS` |
| 14 | Egress IP mismatch | `READINESS` |
| 15 | Slices exceed today's remaining order count | `ORDER_COUNT` |
| 16 | 40 lots above `maxLotsPerOrder` | `LOTS_CAP` |
| 17 | Order at 15:45 (market closed, live) | `SESSION` |
| 18 | Strike 14 % OTM | `FAR_OTM_RANGE` |
| 19 | Price 14 s old in market hours | `STALE_PRICE` |
| 20 | Broker RMS blocks a deep-OTM stock option by its own policy | expected **miss** (`flagged: false`) |

The test asserts flagged ≥ 18, case 20 is not flagged (so nobody "fixes" it by inventing a rule), and every expected-flagged case is flagged (19/20).

### 10.5 Manual checks (results in the PR)

- Demo on a phone at 360 px: builder chip, bottom sheet, placement "Free after" second line; no horizontal scroll.
- Screen reader announces the blocked-count change once.
- One live read-only check per in-scope broker by the owner (basket margin only; nothing sent), with the figure compared to the broker's own web basket. Record the differences in `docs/guides/margin.md`.

---

## 11. Migration and back-compat

### 11.1 API and contract

- All routes are new; `/v1` changes are additive. `PreviewResult.margin` keeps its meaning (paper-model, per leg).
- `/api/v1/margin` changes from a 422 `CAPABILITY_UNSUPPORTED` to a working reply. This is called out in CHANGELOG as a behaviour change. Scripts that expected the error get data.
- The broker contract stays version 1. `basketMargin`, `slicing` and the quote circuit fields are optional. Adapters that do not declare them are unaffected.
- The config section `margin` is optional. `{}` gives the defaults, and unknown keys fail as for every module.

### 11.2 Charges

- **Dashboard.** `REF_DEFAULTS.charges.brokerage` (P1-2's `reference.js`, flat ₹20) is the fallback when no plan is loaded (older Bridge, offline). With plans loaded, every page uses the account plan. For an account with no user or config plan, the broker default is flat ₹20 for the three in-scope brokers and the global default flat ₹20 for others. The figures users see today therefore do not change until they edit a plan.
- **Arbitrage page.** A saved `conf.profile` that differs from `DEFAULT_PROFILE` is kept as an explicit override ("Using page settings"). Otherwise the page follows the account plan.
- **Paper fills: visible change.** Today the paper engine charges `paper.brokerage` (default **₹0**). After P1-10, a paper account with no plan uses the paper default flat ₹20, matching what the builder has always shown. **Exception:** if `paper.brokerage` is set explicitly in the config file, it becomes that paper account's plan (`origin: "config"`), so explicit setups keep their behaviour. Past fills are never re-priced. CHANGELOG and the paper guide say this plainly. A one-line notice shows on the Paper page the first time after upgrade ("Paper brokerage now follows the account's plan (flat ₹20). Change it in Accounts.").

### 11.3 Dashboard and data

- **Builder.** The per-leg `/v1/orders/preview` loop for margin is replaced by one basket call. Previews are still used for freeze/tick resolution when the margin endpoint returns 404 (older Bridge serving a newer dashboard is impossible, since both ship together, but the code degrades anyway).
- **Data.** New files only (`dataDir/margin/`). Nothing is migrated. Deleting the folder resets plans to config/defaults and clears calibration.

---

## 12. Ordered task list (one engineer, one session; each task lands with its tests green)

1. **Contracts and stubs.** `core/contracts.mjs` (`margin`, `chargePlans`, paper requires), `builtinModules.mjs`, the `margin/module.mjs` skeleton with `ROUTES` returning `NOT_IMPLEMENTED`, `config.mjs` with the zod schema and bounds, and 8 OpenAPI path stubs with `x-stream: S23`, so that `openapi.test.mjs` passes. *(tests: config parse, openapi)*
2. **Pure core.** `dashboard/margin-core.js` with `estimate` (moved, re-exported from `options.js`), `band`, `sendOrderFor`, `prefixHeadroom`, `classifyRisk`, `slicePlan`, `expiryElm`, `calendarSplit`, `planBrokerage`, `netting`; `DASHBOARD_FILES`. *(margin-core.test.mjs, Examples A–I)*
3. **Charge plans.** `chargePlans.mjs`, `store.mjs`, `data/brokerage-defaults.json`, plan routes (admin, loopback), audit and event. *(chargePlans.test, routes plan cases)*
4. **Paper uses plans.** `fillModel.planBrokerage` and the engine lookup with the legacy mapping. *(fillModel, paperEngine updates)*
5. **Adapter capability.** `contract.mjs`, `contractShapes.mjs`, harness scenario, demo `fetchBasketMargin` (§7.5), `slicing`, circuit limits. *(contract.test, demo.test Example F + properties)*
6. **Service: basket.** `sources.mjs`, `cache.mjs`, `budget.mjs`, `marginService.basket`, route, demo paper-source wiring. *(marginService basket cases, routes)*
7. **Real adapters.** `zerodhaMargin.mjs`, `upstoxMargin.mjs`, `dhanMargin.mjs` with fixtures (`illustrative` until captured), capability flags, `slicing`, circuit mapping, snapshot. *(per-broker tests, snapshot, normalise contract)*
8. **Rules and facts.** `data/rules.json`, `rules.mjs` (every line in §3.4), `facts.mjs` with allSettled and timeouts, `previewLegs` export from orders. *(rules.test)*
9. **Service: check and sequence.** `marginService.check`, prefix evaluation with `maxBrokerCalls`, covered order, kill-switch line, route. *(marginService check cases)*
10. **Acceptance fixtures.** The 20 rejection cases and `rejections.test.mjs`. *(≥ 18 flagged, case 20 missed)*
11. **Calibration.** `calibration.mjs`, writes in `basket`, band from the log, retention timer. *(calibration.test)*
12. **Demo scenarios.** `demoMargin.mjs`, `/v1/demo/margin`, buttons on the Safety demo card. *(routes demo cases)*
13. **Dashboard client.** `margin.js` client and view models. Builder tile, panel and charges with the plan (`strategy.js`). *(margin.test, strategy.test)*
14. **Placement sheet.** Check, "Free after" column, reorder bar, re-check remaining legs (`strategy-place.js`).
15. **Ticket and positions.** `desk.js` margin line and checks; `positions.js` exit-plan check; `arbitrage.js` plan default; `views.js` plan editor; four CSS rules.
16. **MCP and compat.** Two tools, `/api/v1/margin`. *(tools.test, compat handlers test)*
17. **E2E and docs.** `margin.e2e.test.mjs`; full OpenAPI schemas; ARCHITECTURE (S23, data layout), STREAMS, `broker-contract.md`, `guides/margin.md` (with the verification register), example config, CHANGELOG (paper brokerage change, compat change). Run the full `npm test` and `npm run typecheck`.

**Cut line if the session runs short:** tasks 1–10 and 13–14 are the acceptance core. Tasks 15 (positions part), 16 and 11 can move to the next session without failing an acceptance criterion: AC1's band then stays "default" and is labelled so.

---

## 13. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Broker margin endpoints or fields differ from what we expect (especially Dhan multi-leg, and Kite incremental vs total) | High | Medium | Fixtures marked `illustrative`; the owner's one live read-only check per broker before `verified`; `incremental` normalisation with a note; unsupported → estimate, never a wrong "broker figure" |
| R2 | The estimate is far from the broker figure (the heuristic overstates undefined-risk baskets) | High | Medium | Labelled estimate with a wide default band; local calibration replaces the band; never shown as broker |
| R3 | The acceptance fixtures are reconstructed, not real historical rejections | High | Medium | Stated in the files and the PR; owner asked to contribute real cases from audit logs; case 20 documents a known blind spot |
| R4 | F9 prefix calls exhaust the broker's "other" budget or slow the sheet | Medium | Medium | 60/min/account budget, `maxBrokerCalls` 8, cache shares P_n, scaled estimate beyond the cap, interactive priority below orders |
| R5 | Users read "margin-covered order" as advice | Low | Medium | Descriptive copy, banned-word tests, rule sources shown |
| R6 | Paper brokerage default changes from ₹0 to ₹20 and surprises paper users | Medium | Low | Explicit `paper.brokerage` respected; one-time notice; CHANGELOG |
| R7 | The paper engine refuses a hedged basket the panel says fits (per-leg paper margin) | Medium | Low | Panel sub-line "paper blocks per leg"; hedge-aware paper margin is LATER |
| R8 | Unverified exchange rules (ELM, calendar, far-OTM, freeze) are wrong or change | Medium | Medium | Dated rule table, `verified: false` → warn only, register in §9.3 |
| R9 | Stream id | Resolved | — | Fixed in `docs/spec/README.md`: margin is S23 |
| R10 | P1-2/P1-5 land late | Medium | Medium | Soft runtime deps with explicit `info` lines; the hard parts (G2, F9, G9) do not need them |
| R11 | Dashboard restyle conflicts in `strategy.js`/`desk.js`/`app.css` | Medium | Low | Structural changes only, four token-based CSS rules, renderers isolated in `margin.js` |
