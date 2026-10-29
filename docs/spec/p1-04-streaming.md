# Spec P1-4: Streaming chain and positions (A3, A11, A14)

Status: ready to build · Owner: tech lead, Options desk · Date: 29 Oct 2026 · Streams touched: S5 (market), S6 (stream), dashboard, demo; lead-owned core and broker-layer changes listed in §3.1 and §3.7.
Builds on: BRD `docs/brd/options-platform.md` §3.A (A3, A11, A14), §4 item 9, §6.1 P1-4 (acceptance criteria), §7.1–7.5 (latency, rate limits, mobile, accessibility, order safety), §8 (compliance).
Hard dependencies: none in code, but the build order (`docs/spec/README.md`) puts P1-1, P1-2a and P1-3a before this item, so the "interim" paths below are fallbacks for a stub service only, not work to build:
- **P1-1** recorder: OI-unit table `market/oiUnits.mjs` (used by the unit check in §7.9 when present), demo realism item 1 (time-varying OI) and item 2 (`bidQty`/`askQty`). Recorder stream subscriptions share upstream slots with this item through the hub's reference counting.
- **P1-2** reference data: the session/holiday calendar that decides "market hours" for stale dimming. Until then: `lib/marketHours.mjs` plus the holiday heuristic in §2.3.
- **P1-3** pricing core: the one IV/Greeks function. The chain view calls `withComputedGreeks` from `market/chain.mjs` through a single seam (`greeksFor()` in §3.3), and P1-3 swaps it there.

Not in this spec: visual styling. The dashboard is being restyled by another team (near-black theme, colour tokens, motion). Everything below uses existing components and the shared tokens in `palette.css`. New visual states are expressed as `data-*` attributes with one CSS rule each that reads existing tokens (`--c-warn`, the stale treatment of `docs/design/chain.md` §8). The restyle team owns the final look. No new colours and no new motion: cell flashes reuse `flashValue` from `motion.js`, which already honours reduced motion.

> **Build order and shared foundations.** This spec is steps 10–11 (P1-4a server T1–T7, P1-4b dashboard T8–T16) in `docs/spec/README.md`, after F0, P1-1a, P1-3a. It uses, and does not rebuild, the F0 foundations listed there: final stream ids, bus topics and error codes pre-registered in core, the opt-in `options` MCP toolset (every MCP tool in this spec goes there), `demo/routes.mjs` plus the OpenAPI demo-only list, `server/lib/jsonl.mjs` (append, torn-line tolerance, last-wins, quarantine of corrupt files), `ratelimit/backgroundGate.mjs` (the one ≤ 50 % background-budget check), `core/ownership.mjs`, and `dashboard/copyRules.mjs` (the one banned-word list). Where this text and README disagree, README's build order and shared-module owners win.

---

## 1. Summary

Today the chain and positions pages poll REST every 3 s. After this item they get a **server-side chain view** over the existing `/v1/stream` WebSocket:
- The Bridge builds one view per (underlying, expiry, account scope) from a single `optionChain` read.
- The view subscribes its legs, the index and the same-expiry future on the stream hub. Hub reference counting means the recorder's subscriptions cost nothing extra.
- Ticks are merged into the view. IV and Greeks are recomputed on the server with the same function REST uses.
- Clients receive **field-level patches** every 100 ms. Patches are conflated per chain, so a slow client never grows memory.

The dashboard paints changed cells inside one animation frame (fast path). Every 1 s it recomputes the derived parts (summary strip, ATM, walls, bars, positions totals) on a slow path.

REST polling stays as the fallback. It starts only after 5 s without stream data in market hours, and stops after 3 s of continuous stream data. The freshness pill shows which mode is active ("Live" or "Polling 3 s") and why.

`ChainLeg` gains `bidQty`, `askQty`, `ts` and `tsKind` (additive). Strike sides older than 10 s in market hours are dimmed with an age tooltip. Illiquid sides (wide spread, one-sided, no trades) are dimmed with their reason. A "Bid / ask qty" column and a depth section in the action sheet deliver A14. The order ticket asks for an explicit confirmation when its price is older than 10 s (BRD §7.5).

Leaving a page releases its subscriptions within 1 s, visible on `/v1/stream/stats`. Demo mode gets a realistic feed: ATM legs tick about 4 times a second and far wings every 15–30 s, spreads widen in the wings, some wings never trade, and quantities sit at the touch. A demo-only route stalls the feed so the fallback can be seen and tested without a broker.

---

## 2. Scope

### 2.1 MUST (this round)

| # | Item | Acceptance hook (BRD P1-4) |
|---|---|---|
| M1 | `ChainLeg` += `bidQty`, `askQty`, `ts`, `tsKind` on every chain path: broker chain, built chain, stream-cache, backup. Dhan chain `top_bid_quantity`/`top_ask_quantity` mapped in `normalise.mjs`. OpenAPI updated. | `ChainLeg` gains `bidQty`, `askQty`, `ts` |
| M2 | Chain view manager `market/chainView.mjs` + pure state `market/chainViewState.mjs`: baseline, hub subscription, tick merge, server-side Greeks (throttled), broker-Greeks re-baseline, ATM re-centring, unit check, state (`live`/`stalled`/`down`), lag stats, release on last client | patch cells on tick |
| M3 | Stream protocol ops `subscribe_chain` / `unsubscribe_chain`; messages `chain_snapshot`, `chain_patch`, `chain_status`; per-chain conflating merge; per-client `minIntervalMs`; `maxChainsPerClient`; AsyncAPI updated | subscribe through `/v1/stream` |
| M4 | `/v1/stream/stats` += `chains[]` and `downstream.chainSubscriptions` | unsubscribe verified on stats |
| M5 | Dashboard `stream-client.js` (one WebSocket per tab, token, reconnect, resubscribe, idle close) and `chain-live.js` (pure: apply snapshot/patch, feed state machine, clock skew, leg age, dim reasons, latency stats) | fallback after 5 s, switch visible |
| M6 | Chain page (`desk.js`, kind `chain`): stream-first, fast path `patchLegs` per frame, slow path 1 s, polling only in fallback, pill modes, hidden-tab release, cleanup on leave | p95 ≤ 250 ms, no long task > 50 ms, unsubscribe ≤ 1 s |
| M7 | Stale and illiquid dimming per strike side, with reasons in tooltip and accessible description (A11) | rows > 10 s dimmed; illiquid dimmed with reason |
| M8 | "Bid / ask qty" chain column (Customise only; presets unchanged) and a depth section in the action sheet (A14) | quantity at the touch, 5-level depth |
| M9 | Positions page (`positions.js`): chain views per held expiry (narrow window), quote subscriptions for futures/index/out-of-window legs, order events trigger a positions re-read, 30 s reconcile, fast/slow paths | positions subscribe and patch on tick |
| M10 | Ticket stale-price confirmation (BRD §7.5): price age shown; > 10 s in market hours needs an explicit tick box before Place | safety gate |
| M11 | Demo: per-token tick cadence, realistic spreads, zero-volume and one-sided wings, `bidQty`/`askQty` on ticks (formula from P1-1), `exchangeTs`, feed stall hook + `POST /v1/demo/feed` (in the `demo/routes.mjs` file F0 creates) | every feature visible and testable without a broker |
| M12 | In-page performance probe (`#/chain?perf=1`): tick-to-paint p50/p95 split into server lag and client lag, long-task counter, conflation counter | measure the 250 ms / 50 ms criteria |
| M13 | Core (lead): CSP `connect-src` allows this origin's `ws:`/`wss:`, `DASHBOARD_FILES` += 2 files, `SERVICE_CONTRACTS.marketData` += `chainView`, `chainViewStats` | — |
| M14 | Docs: STREAMS.md (S5/S6 additions), ARCHITECTURE.md (chain view in the read path), `docs/guides/streaming.md` (chain streaming for API users, with a Python example), CHANGELOG, MCP tool description | — |

### 2.2 LATER (not this round; named so nobody builds it now)

- Streaming on the OI, Strategy, Volatility, Arbitrage and Screener pages. They keep 3 s polling. The OI page reads 100 strikes, above the 40-strike view cap.
- `subscribe_chain` over SSE (`?chains=`). WebSocket only this round; the AsyncAPI marks it WS-only.
- Server-side stale-price gate for API and MCP orders (S9 `safety.check`). This round gates the dashboard ticket only (M10). Tracked with P1-5.
- Broker-layer mapping of depth arrays from feeds (Dhan full packet, Zerodha full mode) into `tick.depth`. Until then the action sheet's depth comes from `GET /v1/depth`, polled every 2 s only while the sheet is open (§6.6).
- Views wider than ±40 strikes; multi-expiry chain (A12).
- Bid/ask/mid IV (A4) and fitted theo (A5): P2.
- Per-key quota for chain views (§7.8 quotas). This round has hard caps (`maxChainsPerClient`, `maxViews`).
- A sample paper book in demo positions (today the user places a paper order first; the e2e test does it by API).

### 2.3 What our data cannot do (and the honest fallback)

| Limitation | Why | Fallback in this spec |
|---|---|---|
| Feeds do not carry bid/ask **quantities** today | `dhanFeed.mjs`, `zerodhaFeed.mjs` and `upstoxFeed.mjs` parse them (Dhan depth level 0, Kite `bids[0].qty`, Upstox `bidQ`) but do not copy them into the tick. `zerodhaData.toQuote` and `upstoxData` REST quotes drop them too. `server/brokers/**` is frozen. | Lead-landed broker change **BL-1** (§3.7). Until it lands: Dhan REST chain has `top_bid_quantity` (mapped in M1) and is used for the baseline. Stream patches leave the field untouched, so it ages with the baseline. Other brokers show "—" with the title "Your broker's feed does not send quantities to the Bridge yet". |
| No **exchange timestamps** on ticks | Same adapters drop `ltt` / exchange timestamp; `tick.exchangeTs` is null | `ts` = when the Bridge received the change, `tsKind: "received"`. Tooltip says "time the Bridge received it". BL-1 adds exchange time where the packet has it (`tsKind: "exchange"`). |
| A quiet strike and a dead feed look the same per leg | Feeds send on change only | Leg age is shown as fact ("No update for 13 s"). Feed health is shown once, in the pill and the view `state`. Wings that rarely trade are expected to dim. That is information, not an error. |
| **Broker Greeks** (Dhan chain) are not on the feed | Feeds carry prices, not Greeks | Legs with `greeksSource: "broker"` keep the broker values and re-baseline every 60 s (background priority, coalesced). `chain_status.greeks.asOf` drives the method note: "IV and Greeks from Dhan, refreshed every 60 s; prices live". Legs with computed Greeks are recomputed live (≤ 1/s). |
| OI or volume **units** may differ between the REST chain and the feed for a broker | Unverified per broker (P1-1 §10) | First-tick ratio check per view (§7.9). On mismatch the view stops applying streamed OI/volume and keeps REST values via the 60 s re-baseline. `chain_status.notes` gets `"oi-unit-mismatch"` and the chain shows "OI updates every 60 s on this account". |
| Brokers do **not stream positions** | Only orders placed through the Bridge emit `order.updated`. Trades made in the broker's own app are invisible until polled. | Positions list re-read on every `order` message for the account, plus a 30 s reconcile and funds every 60 s. Prices and Greeks of held legs stream. **This deviates from BRD §7.2 "zero REST polls per page"**: book membership is not market data. Product to confirm (risk R7). |
| **Holidays** look like a dead feed | `lib/marketHours.mjs` has no holiday list until P1-2 | If, in "market hours", the REST fallback also returns `freshness.asOf` older than 60 s for 3 polls in a row, the page treats the session as closed: pill "No trading today?" with a tooltip explaining. Polling drops to 30 s and dimming turns off. |
| Tick-to-paint **cannot be measured in CI** | No browser runner in the repo (vitest `environment: node`); adding Playwright is a dependency change | Server lag is measured in tests and exposed in stats. Client work is budget-tested on the pure reducer in node. The end-to-end p95 is measured by the in-page probe (M12) with a written manual protocol (§10.4), and the numbers go in the PR. |
| Feed capacity for Zerodha/Upstox is unverified | `brokerPolicies.mjs` notes | §8.2 sizes worst cases. When the hub returns `SUBSCRIPTION_LIMIT`, the view streams what fits and lists the rest as `unstreamed`, and those legs show "Not streamed: the live feed is full". |

---

## 3. Architecture

### 3.1 Module map

New files:
```
server/bridge/market/chainViewState.mjs   pure: createViewState(baseline), applyTick(state, tick) -> changedFields,
                                          drainPatch(state) -> patch|null, unitCheck(), lagStats ring buffer
server/bridge/market/chainView.mjs        createChainViews(deps, cfg): manager (open/share/release views, one bus "tick"
                                          listener + symbol->views index, timers, Greeks throttle, re-baseline, re-centre, status)
server/bridge/dashboard/stream-client.js  one WebSocket per tab: token, connect, reconnect, ops, resubscribe, idle close
server/bridge/dashboard/chain-live.js     pure: applySnapshot, applyPatch, createFeedState, createSkew, legAge,
                                          dimReasons, createLatency
server/bridge/demo/demoFeed.mjs           pure: tickPeriodMs(token, t), shouldEmit(token, prevT, t); stall state
server/bridge/demo/routes.mjs             POST /v1/demo/feed (registered only in demo mode)
docs/guides/streaming.md
*.test.mjs                                see §10
```

Changed files and owners:

| File | Owner | Change |
|---|---|---|
| `market/normalise.mjs` | S5 | `chainLegFields`: `bidQty`, `askQty` (aliases `top_bid_quantity`, `top_ask_quantity`, `bid_qty`, `ask_qty`, `bidQty`, `askQty`). `quoteFields`: fall back to `row.depth?.bids?.[0]?.qty` / `asks[0].qty` when `bidQty` is absent. |
| `market/chain.mjs` | S5 | `finishLeg` stamps `ts` and `tsKind` (§3.3). `rowsFromQuotes` copies `bidQty`, `askQty` and the per-quote time. |
| `market/marketDataService.mjs` | S5 | Pass read times into rows. Expose `chainView`, `chainViewStats` (delegating to `chainView.mjs`). |
| `market/config.mjs` | S5 | `market.chainView` section (§3.5) |
| `stream/protocol.mjs` | S6 | Ops, messages, merge slot, throttle, close releases views |
| `stream/config.mjs` | S6 | `stream.maxChainsPerClient` |
| `stream/module.mjs` | S6 | Stats add `chains` |
| `docs/asyncapi.yaml` | S6 | §4.5 |
| `demo/demoAdapter.mjs`, `demo/demoMode.mjs` | demo | §5 |
| `dashboard/desk.js`, `positions.js`, `chain-sheet.js`, `options.js`, `app.js` (`liveControl` gains `via`), `app.css` (three `data-*` rules) | dashboard | §6 |
| `core/contracts.mjs`, `core/app.mjs` (CSP, `DASHBOARD_FILES`), `docs/openapi.yaml`, `docs/STREAMS.md`, `docs/ARCHITECTURE.md` | lead | §3.6, §4 |
| `mcp/tools.mjs` | S11 | `get_option_chain` description mentions `bidQty`, `askQty`, `ts`. The output schema is already loose. |

Rule: `chainView.mjs` imports only `market/*`, `core/*` and `lib/*`. A test asserts that no file under `market/` imports from `orders/`, `paper/` or `safety/`. Streaming can never place an order.

### 3.2 Read path (where the view sits)

```
broker feed ──► streamHub (ref-counted upstream subs; emits bus "tick")
                    ▲ subscribe(viewClientId, legs+index+future, "quote")
                    │
           chainView manager ◄── bus "tick" (one listener; Map<symbol, Set<view>>)
             │  baseline: marketData.optionChain({ underlying, expiry, strikes: W, greeks }, { allowedAccounts, priority })
             │  every patchMs: drainPatch() ──► listeners (one per subscribed WS session)
             ▼
   stream/protocol.mjs session ──► queue slot "p:<chainId>" (merge, never drop) ──► WebSocket ──► dashboard
```

The baseline read goes through `optionChain`, so it hits the freshness cache: a chain the page just loaded over REST costs no broker call. For built chains (Zerodha and other brokers without a chain endpoint), `readPrices` is stream-first, so once the hub holds the legs every later re-baseline is served from ticks with zero broker calls.

### 3.3 Data model

**View key**: `${underlying}|${expiry}|${greeks ? "g" : "n"}|${accountsSig}`. `accountsSig` is `"*"` or the sorted, comma-joined `allowedAccounts` of the key, plus the pinned `account` if one was given. Views are shared by every session with the same key. The hub client id is `chainview:<sha1(key).slice(0,12)>`.

**View state** (in memory only):
```js
{
  key, chainId: "NIFTY|2026-11-03",            // chainId is what clients see (no account info)
  underlying, expiry, exchange, lotSize, greeks,
  windowStrikes: W,                            // max(strikes) over current subscribers, ≤ maxStrikes
  atmStrike, spot: { symbol: "NSE:NIFTY", ltp, ts }, future: { symbol, ltp, ts } | null,
  legs: Map<symbol, Leg>,                      // Leg = ChainLeg fields + { strike, right, prevOi, prevVolumeBase, dirty: Set<field> }
  unstreamed: Set<symbol>,                     // hub refused (feed full) or not resolvable
  state: "live" | "stalled" | "down", stateReason, lastTickAt,
  greeksSource: "computed" | "broker" | "mixed", greeksAsOf, nextRebaselineAt,
  notes: Set<"oi-unit-mismatch"|"volume-unit-mismatch"|"partial-feed">,
  rev,                                          // increments per drained patch
  lag: ring buffer (500) of patch lag ms
}
```

**Leg field rules on tick** (pure, `applyTick`):

| Field | Source | Rule |
|---|---|---|
| `ltp`, `bid`, `ask` | tick | copy when non-null |
| `bidQty`, `askQty` | tick | copy when the tick has the key with a non-null value. Never null an existing value: an absent field means "not sent", not "zero". |
| `oi` | tick | copy (units, §7.9) unless `oi-unit-mismatch` |
| `oiChange` | derived | `oi − prevOi` when `prevOi` is known, else stays null (§7.1) |
| `volume` | tick | copy unless `volume-unit-mismatch` |
| `change` | derived | `ltp − close` (4 dp) when `close` is known (§7.2) |
| `ts` | tick | `exchangeTs ?? receivedAt` (epoch ms on the wire, ISO on REST) |
| `tsKind` | tick | `"exchange"` if `exchangeTs` was present, else `"received"` |
| `iv`, `delta`, `gamma`, `theta`, `vega` | `greeksFor()` | only when `greeksSource === "computed"`, at most once per `greeksMinIntervalMs` per leg, also when the spot moved (§7.6) |

`greeksFor(leg, ctx)` is the one seam. It calls the same `market/chain.mjs` path as `GET /v1/optionchain?ivModel=b76-forward` (P1-3a's `pricing.js` on the parity forward and the vol-time clock, rate from `reference.rate()`), so REST and stream agree to the last digit at the same inputs. The dashboard always streams with the `b76-forward` model, as it always requests it over REST (P1-3 §3.9).

**REST `ts` / `tsKind` per chain path** (M1):

| Path | `ts` | `tsKind` |
|---|---|---|
| Broker chain (`brokerChain`) | the chain read time (`got.at`), same for every leg | `"snapshot"` |
| Built chain from quotes | each quote's `freshness.asOf`. A stream-served quote uses the tick's `exchangeTs ?? receivedAt`. | `"exchange"` / `"received"` / `"snapshot"` |
| Cache hit | the cached value's own `ts` (never the time of the cache read) | unchanged |
| Backup (NSE) | provider time `b.at` | `"snapshot"` |

### 3.4 Timers

All timers use `deps.clock.setTimeout`/`clearTimeout` when present (manual clock in tests), else unref'd globals.

| Timer | Period | What |
|---|---|---|
| Patch drain | `patchMs` (100 ms), only while the view has subscribers | `drainPatch()` and send to listeners if non-empty. Records lag. |
| Greeks pass | `greeksMinIntervalMs` (1,000 ms) | recompute computed-Greeks legs whose price changed, or all of them if spot moved ≥ 1 tick since the last pass |
| State check | 1,000 ms | `live` if `now − lastTickAt ≤ stallMs` (5,000); `stalled` otherwise; `down` if the hub status for the view's account is `stale`/`down` or the session expired. Emits `chain_status` on change only. |
| Re-baseline | `rebaselineMs` (60,000 ms), only while subscribed | `optionChain(..., { priority: "background", maxAgeMs: rebaselineMs / 2 })`. Refreshes broker Greeks, `close`, `prevOi`, new strikes, and OI/volume when mismatched. Applies its values only where they are newer than the leg's `ts`; broker Greeks always. Failure: keep going, `greeksAsOf` ages, one `logger.warn` per 10 min. |
| Re-centre | in the Greeks pass | if `|atm − atmAtBaseline| ≥ recentreStrikes` (2): read a new baseline, subscribe new legs **before** unsubscribing old ones, send `chain_snapshot` `reason: "recentre"` |
| Release | on the last listener off | `streamHub.dropClient(viewClientId)` after `lingerMs` (default 0), delete the view |

### 3.5 Config (all optional; zod `.strict()`)

`market.chainView`:

| Key | Default | Range | Meaning |
|---|---|---|---|
| `enabled` | `true` | bool | `false`: `subscribe_chain` answers `CAPABILITY_UNSUPPORTED` "Chain streaming is turned off in this Bridge's config." |
| `patchMs` | `100` | 50–1000 | server batch interval |
| `greeksMinIntervalMs` | `1000` | 250–10,000 | computed-Greeks throttle |
| `rebaselineMs` | `60000` | 15,000–600,000 | REST re-read while streaming |
| `stallMs` | `5000` | 2,000–30,000 | no tick for this long → `stalled` |
| `recentreStrikes` | `2` | 1–10 | ATM move that triggers re-centring |
| `maxStrikes` | `40` | 5–60 | per side, per view |
| `maxViews` | `24` | 1–200 | across the Bridge |
| `lingerMs` | `0` | 0–60,000 | keep a view after its last client. Above 1,000 breaks the "unsubscribe ≤ 1 s" check; the config parser warns. |
| `unitCheck` | `true` | bool | §7.9 |

`stream.maxChainsPerClient`: default `6`, range 1–50.

Dashboard constants (exported from `chain-live.js` for tests; not config): `FALLBACK_AFTER_MS = 5000`, `RESUME_AFTER_MS = 3000`, `STALE_MS = 10000`, `DERIVED_MS = 1000`, `HIDDEN_GRACE_MS = 15000`, `IDLE_CLOSE_MS = 10000`, `ILLIQUID = { spreadPct: 5, spreadTicks: 3 }`, `MIN_INTERVAL = { phone: 250, other: 100 }`.

### 3.6 Storage on disk

None. Streaming state is ephemeral and lives in memory. Persistence of market data belongs to the P1-1 recorder, and this item writes nothing under `dataDir`.
- **Dashboard:** one new key in the existing `mcb.dashboard.desk` localStorage slot, `stream: true|false` (escape hatch "Use live streaming", default true).
- **Performance probe:** keeps its samples in memory only and never sends them anywhere (BRD §7.7, no telemetry).

### 3.7 Broker-layer change BL-1 (lead lands; not blocking)

`server/brokers/**` is frozen (STREAMS rule 3). The lead lands one PR, with a fixture test per adapter, that:
- `dhanFeed.mjs` `emit`: `bidQty = depth[0].bidQty`, `askQty = depth[0].askQty` (when > 0, else null); `exchangeTs = ltt` from codes 2/4/8 (Dhan `ltt` epoch-seconds convention **needs verification**; convert to ms only when the docs confirm UTC epoch).
- `zerodhaFeed.mjs`: `bidQty = bids[0].qty`, `askQty = asks[0].qty`, `exchangeTs` from the full-mode exchange timestamp (seconds → ms).
- `upstoxFeed.mjs`: `bidQty = bidQ`, `askQty = askQ`, `exchangeTs = ltt` (ms).
- `zerodhaData.toQuote`, `upstoxData` quotes: `bidQty`/`askQty` from `depth.buy[0].quantity` / `depth.sell[0].quantity`.

`quoteToTick` and `quoteFields` already read these keys, so nothing else changes. Everything in this spec works without BL-1 (the fields are null).

---

## 4. API changes

### 4.1 REST: `GET /v1/optionchain` (scope `read`; parameters unchanged)

`ChainLeg` gains four optional fields. Example leg (Dhan broker chain, 10:15:03 IST):
```json
{
  "symbol": "NFO:NIFTY-2026-11-03-25150-CE",
  "ltp": 151.85, "bid": 151.8, "ask": 151.95,
  "bidQty": 1125, "askQty": 675,
  "oi": 1240350, "oiChange": 50850, "volume": 18234525,
  "iv": 12.41, "close": 142.3, "change": 9.55,
  "delta": 0.52, "gamma": 0.00071, "theta": -18.2, "vega": 11.9, "greeksSource": "broker",
  "ts": "2026-10-29T10:15:03.120+05:30", "tsKind": "snapshot"
}
```
`bidQty`/`askQty` are in **units** (shares or index units), like `oi`; `null` when the source does not send them. Errors are unchanged.

### 4.2 REST: `GET /v1/stream/stats` (scope `read`)

`data` gains:
```json
"chains": [
  { "chainId": "NIFTY|2026-11-03", "underlying": "NIFTY", "expiry": "2026-11-03", "clients": 1, "symbols": 165,
    "unstreamed": 0, "state": "live", "greeksSource": "computed", "lastTickAt": "2026-10-29T10:15:03.180+05:30",
    "lagMs": { "p50": 52, "p95": 96 }, "rev": 3812 }
],
"downstream": { "...existing...": 0, "chainSubscriptions": 1 }
```
`accountId` is not listed per view, so keys restricted to some accounts learn nothing new. Acceptance check "leaving the page unsubscribes within 1 s": the view disappears from `chains` (or its `clients` drops by one) and `downstream.chainSubscriptions` drops, within 1 s of the page change.

### 4.3 REST: `POST /v1/demo/feed` (demo mode only; scope `admin`; `loopbackOnly`; registered only when `config.demo`)

Request: `{ "mode": "silent" | "disconnect" | "resume", "ms": 8000 }`. `ms` is 1,000–120,000 and required except for `resume`.
- `silent`: the demo feed stays "connected" but sends no ticks (the silent-stall failure).
- `disconnect`: the feed reports `connected: false` and reconnects after `ms`.

Response 200: `{ "data": { "mode": "silent", "until": "2026-10-29T10:15:11.000+05:30" }, "meta": { "requestId": "…" } }`.
Errors: 400 `VALIDATION_FAILED`; 404 `NOT_FOUND` outside demo mode (the route does not exist); 403 `SCOPE_REQUIRED` / `LOOPBACK_ONLY`.

### 4.4 WebSocket protocol additions (`/v1/stream`, read scope; WS only this round)

**Client → server**
```json
{ "op": "subscribe_chain", "id": "c7", "underlying": "NIFTY", "expiry": "2026-11-03",
  "strikes": 40, "greeks": true, "account": null, "minIntervalMs": 100 }
{ "op": "unsubscribe_chain", "id": "c8", "chainId": "NIFTY|2026-11-03" }
```
Zod schema:
- `underlying`: string 1–30.
- `expiry`: `YYYY-MM-DD`.
- `strikes`: int 1–`maxStrikes`, default 40.
- `greeks`: bool, default true.
- `account`: account id regex or null. It must be in the key's accounts, else `ACCOUNT_FORBIDDEN`.
- `minIntervalMs`: int `patchMs`–2,000, default `patchMs`.

Subscribing to a chain the connection already holds means **resync**: a fresh `chain_snapshot`, and the new `strikes` and `minIntervalMs` apply.

**Server → client** (every message has `type` and the per-connection `seq`; times are epoch ms, as in `tick`)
```json
{ "type": "chain_snapshot", "seq": 12, "id": "c7", "chainId": "NIFTY|2026-11-03",
  "reason": "subscribe" | "resync" | "recentre", "at": 1761712503120,
  "chain": { "underlying": "NIFTY", "expiry": "2026-11-03", "underlyingLtp": 25153.4, "atmStrike": 25150,
             "lotSize": 75, "rows": [ { "strike": 25150, "ce": { "...ChainLeg, ts as epoch ms...": 0 }, "pe": {} } ],
             "freshness": { "...Freshness...": 0 } },
  "future": { "symbol": "NFO:NIFTY-2026-11-25-FUT", "ltp": 25261.0, "ts": 1761712503090 } ,
  "unstreamed": [], "status": { "...chain_status body...": 0 } }

{ "type": "chain_patch", "seq": 13, "chainId": "NIFTY|2026-11-03", "rev": 42, "at": 1761712503220, "lagMs": 64,
  "spot": { "ltp": 25153.4, "ts": 1761712503190 },
  "future": { "ltp": 25261.0, "ts": 1761712503090 },
  "legs": {
    "NFO:NIFTY-2026-11-03-25150-CE": { "ltp": 151.85, "bid": 151.8, "ask": 151.95, "bidQty": 1125, "askQty": 675,
                                       "oi": 1240350, "oiChange": 50850, "volume": 18234525, "change": 9.55,
                                       "ts": 1761712503180, "tsKind": "received" },
    "NFO:NIFTY-2026-11-03-25150-PE": { "iv": 12.6, "delta": -0.47, "gamma": 0.00071, "theta": -17.9, "vega": 11.9 }
  } }

{ "type": "chain_status", "seq": 14, "chainId": "NIFTY|2026-11-03", "state": "live" | "stalled" | "down",
  "reason": null, "accountId": "dhan-main", "broker": "dhan", "lastTickAt": 1761712503180,
  "greeks": { "source": "computed" | "broker" | "mixed", "asOf": 1761712500000, "refreshMs": 60000 },
  "notes": [] }
```
Rules:
- `legs` holds only changed fields. A patch with only Greek fields has no `ts` change: `ts` is price time.
- `spot`/`future` appear only when changed.
- A patch exists only when something changed. There are no empty patches; liveness comes from heartbeats and `chain_status`.
- `rev` is per view. A client that sees `rev` go backwards (a view re-created on the server) resubscribes.
- `accountId` in `chain_status` follows the existing `status` message, which already shows it to every key.

**Conflation**: a session keeps at most one queued `chain_patch` per `chainId` (queue key `p:<chainId>`), and newer patches are **merged** into it field by field (§7.8). `chain_snapshot` and `chain_status` messages go through the normal control FIFO; a queued patch for that chain is discarded when a snapshot is queued. Memory per client stays bounded by the chain size.

**Errors** (existing `error` message, `op: "subscribe_chain"`, `id` echoed):

| Code | When |
|---|---|
| `VALIDATION_FAILED` | bad fields; `strikes > maxStrikes` |
| `SYMBOL_NOT_FOUND` | no options for underlying/expiry (from `optionChain`) |
| `ACCOUNT_FORBIDDEN` | `account` not allowed for the key |
| `SUBSCRIPTION_LIMIT` | `maxChainsPerClient` reached ("This connection already streams 6 chains, the most allowed. Unsubscribe one first."), `maxViews` reached, or the hub refused **every** leg |
| `CAPABILITY_UNSUPPORTED` | streaming off in config, or no account allowed for the key has a live feed ("Your connected accounts have no live feed, so this chain updates by polling.") |
| `SESSION_EXPIRED`, `BROKER_UNAVAILABLE`, `UPSTREAM_RATE_LIMITED` | baseline read failed (retryable per the existing table) |

Unknown chain on `unsubscribe_chain`: ignored, as `unsubscribe` already is. A closed connection releases every chain it held.

### 4.5 AsyncAPI additions (`docs/asyncapi.yaml`, version `0.2.0`)

Add messages `subscribeChain`, `unsubscribeChain`, `chainSnapshot`, `chainPatch` and `chainStatus` under `channels.stream.messages` (not under `sse`), and operations `receiveSubscribeChain` (reply `chainSnapshot`) and `receiveUnsubscribeChain`. Payload schemas follow §4.4, using `op: { const: subscribe_chain }` and `type: { const: chain_patch }` in the same style the doc test greps. `chainPatch.legs` is `{ type: object, additionalProperties: { $ref: "#/components/schemas/ChainLegPatch" } }`, where `ChainLegPatch` has the `ChainLeg` properties, all optional, with `ts` as integer epoch ms. The channel description notes "chain ops are WebSocket-only in 0.2.0".

`stream/protocol.test.mjs`'s doc test gains the two ops and three message types.

### 4.6 OpenAPI additions (`docs/openapi.yaml`)

```yaml
    ChainLeg:
      # ... existing properties unchanged ...
        bidQty: { type: [number, "null"], description: "Quantity at the best bid, in units (shares or index units). Null when the source does not send it." }
        askQty: { type: [number, "null"], description: "Quantity at the best ask, in units. Null when the source does not send it." }
        ts:
          type: [string, "null"]
          format: date-time
          description: "When this leg's price fields were last known to be current (IST). See tsKind."
        tsKind:
          type: [string, "null"]
          enum: [exchange, received, snapshot, null]
          description: "exchange = exchange time from the feed; received = when the Bridge received the change; snapshot = time of the chain or quote read that produced it."

    StreamStats:
      # ... existing properties unchanged ...
        chains:
          type: array
          items:
            type: object
            required: [chainId, underlying, expiry, clients, symbols, state]
            properties:
              chainId: { type: string }
              underlying: { type: string }
              expiry: { type: string, format: date }
              clients: { type: integer, minimum: 0 }
              symbols: { type: integer, minimum: 0 }
              unstreamed: { type: integer, minimum: 0 }
              state: { type: string, enum: [live, stalled, down] }
              greeksSource: { type: string, enum: [computed, broker, mixed] }
              lastTickAt: { type: [string, "null"], format: date-time }
              lagMs: { type: object, properties: { p50: { type: [integer, "null"] }, p95: { type: [integer, "null"] } } }
              rev: { type: integer }
        # downstream gains:
              chainSubscriptions: { type: integer }

  /v1/demo/feed:
    post:
      tags: [Demo]
      operationId: setDemoFeed
      summary: Stall or resume the demo live feed (demo mode only)
      x-stream: demo
      x-scope: admin
      x-loopback-only: true
      description: Exists only when the Bridge runs in demo mode. Lets you see and test the dashboard's polling fallback without a broker.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [mode]
              additionalProperties: false
              properties:
                mode: { type: string, enum: [silent, disconnect, resume] }
                ms: { type: integer, minimum: 1000, maximum: 120000 }
      responses:
        "200":
          description: Feed state.
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { type: object, required: [mode], properties: { mode: { type: string }, until: { type: [string, "null"], format: date-time } } }
                  meta: { $ref: "#/components/schemas/Meta" }
        "4XX": { $ref: "#/components/responses/Problem" }
```
The `/v1/stream` description gains one paragraph pointing to `subscribe_chain` in the AsyncAPI document. `core/openapi.test.mjs` must pass. It knows demo-only routes through the existing `x-stream` mechanism; if the test enumerates routes from a non-demo app, list `/v1/demo/feed` in its demo-only allowlist (lead).

### 4.7 MCP

No new tool: MCP has no streaming. `get_option_chain` returns the new fields automatically (loose schema), and its description is updated.

---

## 5. Demo mode

Goal: `mc-bridge start --demo`, open `#/chain`, and every behaviour in this spec is visible within 10 seconds at any hour. That covers live ticks with flashes, wings that go stale and dim, illiquid wings with reasons, quantities, depth, the fallback and the recovery.

Changes in `server/bridge/demo/`:

1. **Per-token tick cadence** (`demoFeed.mjs`, pure). The feed's internal timer runs every 100 ms (`tickMs` default 1000 → 100). A token emits only when its own slot advances:
   - `w = exp(−((K − S)/(step × 8))²)`, the existing `near` weight.
   - `period(token) = clamp(250 / max(w, 1e-6), 250, 30000)` ms for options; 250 ms for spots; 500 ms for futures.
   - `offset(token) = unit(token + ":ph") × period`.
   - Emit when `floor((t + offset)/period) > floor((tPrev + offset)/period)`.
   - Worked values (NIFTY, step 50): ATM → 250 ms (4/s); 8 strikes away → `w = e^−1 = 0.368` → 679 ms; 16 away → `e^−4 = 0.0183` → 13.6 s (dims as stale between ticks); 24 away → 30 s.
2. **Spreads** (`quoteOf`, options only):
   - `spreadPct = 0.004 + 0.06 × (1 − w)`; `spread = max(0.05, toTick(ltp × spreadPct, 0.05))`.
   - Options under ₹2: `spread = 0.05 × (2 + floor(4 × unit(token + ":sp")))`, i.e. ₹0.10–0.25.
   - `bid = ltp − spread/2`, `ask = ltp + spread/2`, each on the tick.
   - ATM ₹150 → spread `0.6` (0.4 %). A ₹0.60 wing with the 0.25 spread is "wide" (§7.4).
3. **Wings that do not trade**: if `w < 0.02` and `unit(token + ":dead") < 0.5`, then `volume = 0`. If `w < 0.005` and `unit(token + ":os") < 0.3`, then `bid = null`, giving "No bid".
4. **Quantities**: P1-1 T13 (landed earlier) already gives `quoteOf` `bidQty`/`askQty`. This item only routes the same function into the feed ticks and `fetchOptionChain` (`top_bid_quantity`/`top_ask_quantity`), so the feed and REST agree. Do not add a second quantity formula.
5. **Exchange time**: ticks carry `exchangeTs = t`, so demo shows `tsKind: "exchange"`.
6. **Time-varying OI**: already landed by P1-1 T13 (`p1-01-recorder.md` §8); nothing to build here. The feed emits the same `openInterest(…, t)` values.
7. **Stall hook**: the adapter exposes a non-contract `demoControl.stall({ mode, ms })` / `resume()`; `demoMode.mjs` keeps a handle. The route in §4.3 calls it.
   - `silent`: `emit` returns early and status stays connected.
   - `disconnect`: `onStatus({ connected: false, reason: "Demo feed paused for testing" })`, then reconnects and calls `onStatus({ connected: true })` after `ms`.
8. **Dashboard in demo**: the ⋯ sheet shows a demo-only row "Test the fallback: pause the live feed for 10 s" that calls the route (`mode: "silent", ms: 10000`). The row is hidden outside demo mode.

**Positions in demo**: the paper book starts empty. Docs and the e2e test place a paper short strangle and a long future through `POST /v1/orders` on `demo-paper`, then open `#/positions`. A sample book is LATER.

`demo.test.mjs` additions are in §10.1.

---

## 6. Dashboard

### 6.1 `stream-client.js` (new; no DOM; `WebSocket` and `api` injected for tests)

- `connect()`: `POST /v1/stream/token` with the tab's key → `new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/stream?token=…`)`. Reconnect with jittered back-off 1 s → 30 s (50–100 % of `min(30 s, 1 s × 2^n)`), a fresh token each time.
- Watchdog: no message for `2 × heartbeatMs` (from the first heartbeat) → close and reconnect.
- `go_away`: wait `reconnectAfterMs`; for `null` (`key_revoked`), stop and surface "Sign in again".
- API: `subscribeChain(params, { onSnapshot, onPatch, onStatus, onError }) → { close(), resync(params?) }`; `subscribeSymbols(symbols, mode, onTick) → { close() }`; `subscribeOrders(accounts, onOrder) → { close() }`; `state() → "connecting" | "open" | "closed"`; `onState(cb)`.
- `close()` sends the unsubscribe op **synchronously** when the socket is open (no batching), so leaving a page releases at once.
- After a reconnect, every live handle re-sends its subscribe op. The snapshot replaces state.
- Idle: no handles for `IDLE_CLOSE_MS` (10 s) → close the socket.
- One instance per tab (module singleton); pages share it.

### 6.2 `chain-live.js` (new; pure; node-tested)

- `applySnapshot(msg) → chain`: the REST `OptionChain` shape, with `ts` converted to ms, plus a `bySymbol` index `{ row, side }`.
- `applyPatch(chain, msg) → { dirty: Set<symbol>, spotChanged, futureChanged, tickBearing }`: mutates leg objects in place. `tickBearing` is true when any leg `ts` or the spot/future `ts` changed.
- `createFeedState({ now, marketOpen })` → `{ onData(t), onWs(state, t), onNoChainSupport(), tick(t) → { mode: "stream" | "rest" | "connecting", since, reason } }` (§7.5).
- `createSkew()` → `{ sample(serverAt, clientRecv), offset() }` (§7.3).
- `legAge(leg, nowServer)`.
- `dimReasons(leg, { open, nowServer, tick, unstreamed })` → ordered list of `{ code, text }` (§7.4).
- `createLatency(size = 500)` → `{ add(ms), p(q) }` (§7.7).

### 6.3 Chain page (`desk.js`, kind `chain` only)

**Lifecycle.**
1. The first paint keeps today's path: `loadExpiries` → REST `loadChain` (first paint ≤ 1.2 s unchanged). In parallel, `live = streamClient.subscribeChain({ underlying, expiry, strikes: FETCH_STRIKES /* 40 */, greeks: true, minIntervalMs: phone ? 250 : 100 })` and `streamClient.subscribeSymbols([INDEX_SYMBOL[u], ...futures], "quote", onQuote)` for the spot row.
2. `onSnapshot` → `st.chain = chain-live.applySnapshot(msg)`, `st.freshness.source = "stream"`, then `drawAll()` (slow path).
3. `onPatch` → `applyPatch`; add the dirty symbols to `pending`; `feed.onData(now)` when `tickBearing`; `requestAnimationFrame(frame)` if one is not queued.
4. `frame()`: `chain.patchLegs(pending, lastX)` (fast path), clear `pending`, record client latency. If `now − lastDerived ≥ DERIVED_MS` and anything changed since, run `drawAll()` (slow path: `context()`, summary strip, tags, bars, `syncRows`).
5. Underlying or expiry change → `live.close()` then subscribe anew. Strikes `±10/±20/All` only changes the visible window (the view stays ±40).
6. `cleanup()` (already called on route change and when the page leaves the DOM) → `live.close()`, the symbols handle `close()`, `stopTimer()`.

**Fast path `chain.patchLegs(symbols, x)`** (new method on `createChain`):
- `build()` also builds `bySym: Map<symbol, { b, side }>`.
- For each dirty symbol, run `patchCell` on that side's cells only (existing signature check skips unchanged cells), queue LTP flashes, update `data-dim` (§6.4), then flush flashes once.
- Columns whose value depends on `x` (forward, ATM IV, ranks) use the last slow-path `x`. They are at most 1 s behind for derived figures and exact for raw prices.
- **Budget:** ≤ 4 ms for 160 dirty legs × 7 columns on the reference laptop. A node test bounds the pure part (§10.1).

**Polling** (`startTimer`): `every(REFRESH_MS, refresh)` runs only while `feed.mode === "rest"`. Entering `rest` triggers an immediate REST refresh. Leaving it calls `stopTimer()` and `live.resync()` (snapshot resync, §7.5). In `stream` mode positions are re-read on `order` messages and every 30 s (held lots column), not every 3 s.

**Freshness pill.** `liveControl.update` gains `via: "stream" | "poll"` and `reason`. `data-via` drives one CSS rule (warn token for `poll`). The label and title are the restyle team's to place; the words are fixed here:

| State | Label | Title |
|---|---|---|
| stream, live | `Live` + time of last tick | "Streaming from {broker}: prices update as they change. P to pause." |
| connecting | `Connecting` | "Opening the live stream; showing the last refresh." |
| rest (fallback) | `Polling 3 s` | "No live prices for {n} s ({reason}). Refreshing every 3 s until the stream is back." |
| rest (no feed) | `Polling 3 s` | "Your broker account has no live feed on the Bridge, so this page refreshes every 3 s." |
| closed / holiday heuristic | `Market closed` / `No trading today?` | existing / §2.3 text |

Reasons, in plain words: "stream disconnected", "{broker} feed down: {status.reason}", "no ticks from {broker}".

**Hidden tab**: after `HIDDEN_GRACE_MS` (15 s) hidden, close the handles. On visible, resubscribe (snapshot), no REST call.

**Escape hatch**: ⋯ sheet toggle "Use live streaming" (saved as `stream` in the desk prefs). Off means today's 3 s polling.

### 6.4 Dimming (A11) and the age tooltip

- Per strike **side** (the CE cells or the PE cells of a row). `data-dim="stale"` or `data-dim="illiquid"` is set on each cell of that side. Stale wins when both apply.
- CSS: one rule per value using the stale treatment of `docs/design/chain.md` §8 (opacity 0.72) until the restyle team sets it. Focused and hovered rows are undimmed (CSS `:focus-within`, `:hover`).
- The strike cell `title` and `aria-description` list the reasons for both sides, e.g. "Calls: no update for 13 s (time the Bridge received it). Puts: wide spread ₹0.25 (43 % of mid)."
- A non-colour signal (BRD §7.4 "colour never the only signal"): dimmed sides get a small "◷" (stale) or "·" (illiquid) glyph after the LTP. This uses the existing `.tag` style, `aria-hidden`, with the meaning in the description.
- Recomputed for dirty legs on the fast path and for all legs on the slow path (ages advance without ticks).
- Outside market hours nothing dims (§7.4).

### 6.5 "Bid / ask qty" column (A14)

- New entry in `CHAIN_COLUMNS`: `["touch", "Bid / ask qty"]`, `cls: "opt-x"`.
- Cell: two lines, `bid × bidQty` over `ask × askQty`, with quantities in **lots** when `lotSize` is known (`formatInt(qty / lot)` + " lots"), else units. The title says which.
- Not added to any preset, so saved preset recognition (`presetOf`) is unchanged; users add it in Customise.
- Null quantities render "—" with the title from §2.3.

### 6.6 Action sheet depth (`chain-sheet.js`)

While the sheet is open for a contract:
- Subscribe the symbol in mode `depth` through `stream-client`.
- If a tick carries `depth`, render 5 levels (price, qty in lots, orders) for bids and asks.
- If not (all brokers until the feed-depth LATER item), call `GET /v1/depth?symbol=` once, then every 2 s while open. The section note reads "Polled every 2 s".
- Close: unsubscribe and stop the timer.
- Phone: the section sits below the quote line in the bottom sheet. Tablet and desktop: in the popover.

### 6.7 Ticket stale-price confirmation (BRD §7.5)

`openTicket` reads the leg's `ts`. Its existing 1 s `quoteTimer` updates a line "Price as of 10:15:03 (2 s ago)". If `open` and age > `STALE_MS`:
- The line gets `data-stale` and reads "Price is 14 s old".
- A tick box "Place with this older price" appears, and Place is disabled until it is ticked.
- The box resets when the price refreshes.

Paper and live both apply it (BRD D3). The server still decides everything else.

### 6.8 Positions page (`positions.js`)

1. Book membership: `GET /v1/positions` on load, on every `order` message for `st.account` (via `subscribeOrders`), and every 30 s; funds every 60 s (from 15 s).
2. Per held option expiry (nearest `maxChainsPerClient − 1 = 5`; further ones join the quote subscription), call `subscribeChain` with `strikes = W` (§7.10) and `minIntervalMs` as on the chain page. The hedge expiry is included.
3. `subscribeSymbols([...futures held, hedge future, index, option legs outside every window], "quote")`.
4. Patches update `d.chains.get(expiry).chain` in place (via `applyPatch`) and ticks update `d.quotes`. Fast path: per-leg mark, P&L and age cells for dirty symbols. Slow path every `DERIVED_MS`: `price(all)` then `draw()`. The payoff SVG and scenario grid redraw at most every 3 s (as today) to keep frames short.
5. Leg staleness: `l.stale = open && legAge > STALE_MS`, replacing the `_at`/`QUOTE_STALE_MS` logic. The tooltip uses the same text as §6.4.
6. Fallback: the same feed state machine. In `rest` mode the existing `tick()` runs on the 3 s timer. `CHAIN_CAP` and `SLOW_EVERY` stay for that mode only.
7. `destroy()` closes every handle.

### 6.9 Phone, tablet, desktop

| | Phone (< 720 px) | Tablet (720–1279 px) | Desktop (≥ 1280 px) |
|---|---|---|---|
| Patch rate | `minIntervalMs: 250` | 100 | 100 |
| Subscription | both sides (the side switch is instant, no resubscribe) | both | both |
| Dim glyph | yes; reasons in the action sheet header (no hover) | tooltip + long-press opens the sheet | tooltip |
| Touch column | in Customise; two lines collapse to `bidQty/askQty` in lots | full | full |
| Pill | word only ("Live" / "Polling") in the compact bar; reason in the ⋯ sheet | word + time | word + time + title |
| Hidden tab | release after 15 s (battery) | 15 s | 15 s |

Touch targets and the 16 px gutter are unchanged (no new controls in the table).

### 6.10 Performance probe (M12)

Turn it on with `#/chain?perf=1` or `#/positions?perf=1`. It is off by default, local only, and never stored or sent anywhere. A small fixed panel (existing `card` component) shows:
- server lag p50/p95 (from `chain_patch.lagMs`);
- client lag p50/p95 (message receipt → `performance.now()` at the end of the frame that painted it, via a double `requestAnimationFrame`);
- the sum of the two p95 figures, an upper bound for tick-to-paint on loopback;
- `PerformanceObserver({ type: "longtask" })` count and maximum duration;
- conflated patches since open;
- legs per frame.

It also exposes `window.__mcbPerf` for the manual protocol (§10.4).

### 6.11 Accessibility

- Live cells keep `aria-live="off"`. The polite live region announces only mode switches, once each: "Live prices paused; refreshing every 3 seconds" / "Live prices back".
- Flashes use `flashValue`, which honours reduced motion (2 px mark instead of the wash).
- Dim reasons are in `aria-description` and titles. Keyboard focus undims the row.
- `forced-colors`: dimming falls back to the glyph (opacity is ignored), so the glyph is required (§6.4).

---

## 7. Formulas (pure functions, each with a reference-value test)

### 7.1 OI change on a tick
`prevOi = baselineOi − baselineOiChange` (both known), then on each tick `oiChange = oi − prevOi`.
Example (lot 75): baseline `oi = 12,34,500`, `oiChange = 45,000` → `prevOi = 11,89,500` (15,860 lots). Tick `oi = 12,40,350` → `oiChange = 50,850` (678 lots). If the baseline has `oiChange: null`, it stays null on every tick. It is never set to 0.

### 7.2 Price change
`change = round4(ltp − close)`, `changePct = change / close × 100`.
Example: `close = 142.30`, tick `ltp = 151.85` → `change = 9.55`, `changePct = 6.7112 %`.

### 7.3 Clock skew and leg age
Each patch gives a sample `s = at_server − t_client_receipt = skew − transit`. Transit is ≥ 0, so `offset = max(s)` over the last 20 samples, and `nowServer = Date.now() + offset`, `age = nowServer − ts`.
Example: patch `at` = 10:15:03.120 received at client clock 10:15:01.950 → `s = +1,170 ms`, and say that is the max. Leg `ts` = 10:14:50.400; client now 10:15:02.500 → `nowServer` = 10:15:03.670 → `age` = 13.27 s → stale (> 10 s). Without the correction it would read 12.10 s.

### 7.4 Dim reasons (shown only when the market is open, or always open in demo)
In order: `stale` if `age > 10 s` ("No update for {age} s"); `unstreamed` ("Not streamed: the live feed is full"); `one-sided` if `bid` or `ask` is null ("No bid" / "No ask"); `no-trades` if `volume === 0` ("No trades today"; a null volume means unknown and gives no reason); `wide` if `ask − bid > max(spreadPct/100 × mid, spreadTicks × tick)` with `spreadPct = 5`, `spreadTicks = 3`, `tick = 0.05` (from the instrument when known) ("Wide spread ₹{spread} ({pct} % of mid)").

| bid | ask | spread | mid | 5 % × mid | 3 ticks | limit | wide? | text |
|---|---|---|---|---|---|---|---|---|
| 120.00 | 121.50 | 1.50 | 120.75 | 6.04 | 0.15 | 6.04 | no | — |
| 0.45 | 0.70 | 0.25 | 0.575 | 0.029 | 0.15 | 0.15 | yes | Wide spread ₹0.25 (43 % of mid) |
| 3.10 | 3.60 | 0.50 | 3.35 | 0.1675 | 0.15 | 0.1675 | yes | Wide spread ₹0.50 (15 % of mid) |

### 7.5 Feed state machine (client)
Inputs: WebSocket state; `tickBearing` data times; `marketOpen` (server freshness, demo = true); chain support.
- `connecting` → `stream` on the first snapshot.
- `stream` → `rest` when `marketOpen` and (`now − lastData ≥ 5,000` **or** the WS has not been open for 5,000 ms). Immediate `rest` on `CAPABILITY_UNSUPPORTED` or an unknown op (an older Bridge).
- `rest` → `stream` when stream data has arrived with every gap ≤ 1,000 ms for 3,000 ms; then resync (re-send `subscribe_chain`) and stop polling.
- Market closed: never `rest` because of silence. The 30 s closed refresh stays as today.

Timeline example (demo stall `silent`, 10 s, at t = 0, last data t = 0):

| t | event | mode | pill |
|---|---|---|---|
| 0.0 s | last patch | stream | Live 10:15:03 |
| 5.0 s | silence ≥ 5 s | rest; REST poll now, then every 3 s | Polling 3 s ("no ticks from Demo") |
| 10.0 s | feed resumes; patches every 100 ms | rest | Polling 3 s |
| 13.0 s | 3 s of continuous data | stream; resync; polling stops | Live 10:15:16 |

The server marks the view `stalled` at t ≈ 5 s and `live` at t ≈ 10 s (status messages only; the client decides on data).

### 7.6 Server Greeks throttle
A leg with `greeksSource: "computed"` is recomputed when (its `ltp` changed or the spot moved ≥ 1 tick since its last compute) and `now − lastGreeksAt ≥ greeksMinIntervalMs`.
Load example: NIFTY spot ticks 4/s and the view has 162 legs → at most 162 IV solves/s per view. At 24 views that is ≤ 3,900/s, about 4 ms of CPU per second with the existing solver (measured in `chainView.test.mjs`, bound 20 ms/s).

### 7.7 Lag and percentiles
`lagMs` of a patch = `emitAt − min(receivedAt of the ticks merged into it)`. Example: ticks received at .020, .055, .090 and emit at .100 → `lagMs = 80`. Percentile over a ring of n samples: sort ascending, `p(q) = v[ceil(q × n) − 1]`. Example: n = 200 → p95 = the 190th smallest value.

### 7.8 Patch merge (conflation)
Merge B into queued A per leg and field: `A.legs[s][f] = B.legs[s][f]`; `A.spot = B.spot ?? A.spot`; `A.at = B.at`; `A.rev = B.rev`; `A.lagMs = max(A.lagMs, B.lagMs)`.
Example: A = `{ X: { ltp: 10, oi: 5 } }`, B = `{ X: { ltp: 11 }, Y: { bid: 2 } }` → `{ X: { ltp: 11, oi: 5 }, Y: { bid: 2 } }`.

### 7.9 Unit check (first tick per leg with both values > 0; also run on re-baseline)
`r = tickOi / baselineOi`.
- `0.8 ≤ r ≤ 1.25` → consistent.
- `|r × lot − 1| ≤ 0.2` → the feed sends lots, so flag `oi-unit-mismatch` and stop applying streamed OI on this view.
- Anything else → accept (a real OI jump) and count it.

The same check applies to volume. If `market/oiUnits.mjs` (P1-1) declares the stream unit for the broker, convert first and skip the check.
Example: baseline `12,40,350` units, tick `16,540`, lot 75 → `r = 0.013335`, `r × 75 = 1.0001` → mismatch flagged.

### 7.10 Positions window
`W = clamp(maxDistanceInStrikes(held legs of that expiry, ATM) + 2, 5, 15)`.
Example: NIFTY ATM 25,150, step 50, held 25,800 CE (13 strikes) and 24,600 PE (11) → `W = 15`. A held 26,500 CE (27 strikes) does not fit: W stays 15 and that leg joins the quote subscription.

---

## 8. Rate-limit and capacity budget

### 8.1 REST

| Activity | Before (per open page) | After, stream mode | After, fallback |
|---|---|---|---|
| Chain page chain reads | 20/min (3 s) | 1 at load (REST first paint; the view's baseline then hits the 3 s cache) + 1/min re-baseline per view, background priority | 20/min (as today) |
| Chain page quotes (index + futures) | 20/min | 0 (stream) | 20/min |
| Chain page positions | 20/min | on order events + 2/min | 20/min |
| Positions page chains | up to 4 every 3 s + the rest every 15 s | 1/min per view (re-baseline) | as today |
| Positions page positions / funds | 20/min / 4/min | order events + 2/min / 1/min | as today |

- Re-baselines are coalesced across clients (one per view) and use `priority: "background"`, so a user request always goes first.
- For built chains (no chain endpoint) the re-baseline is served from stream ticks once the hub holds the legs: zero broker calls.
- Dhan chain policy: 20/min and one unique request every 3 s. Six views re-baselining at 60 s use 6/min.

### 8.2 Feed subscriptions (per tab)

| Page | Symbols |
|---|---|
| Chain | 81 strikes × 2 = 162 legs + index + ≤ 2 futures = **165** |
| Positions | ≤ 5 views × (2 × 31) = 310 + ≤ 20 quotes = **≤ 330** (typical one-expiry book: 62 + 4) |
| Action sheet depth | +1 |

- Shared with the P1-1 recorder through hub reference counting: legs the recorder already holds add 0 upstream subscriptions.
- Capacity (policy notes; Zerodha and Upstox **need verification**): Dhan 5 × 5,000; Zerodha about 3,000 per connection; the recorder may hold up to 60 % and P1-11 alerts up to 15 % more (only symbols the recorder does not hold). Worst case with both at their caps on Zerodha leaves 750 for users, enough for about two chain tabs or one chain plus one positions tab; with alerts unused, 1,200 (about three tabs). Most chain-page legs are already held by the recorder, so they cost 0 extra upstream slots.
- Over capacity: legs the hub refuses are reported in `unstreamed` (§4.4) and dimmed with the reason. The page never silently freezes.

### 8.3 Downstream

- Chain patch size: about 160 bytes per changed leg. A busy NIFTY chain changes about 60 legs per 100 ms → about 10 KB per patch → about 100 KB/s per chain on loopback. On a phone with `minIntervalMs: 250`, merging cuts that to about 40 KB/s.
- The existing `highWaterMarkBytes` (1 MiB) and the per-chain merge slot bound memory; a slow client sees fewer, larger patches and is never dropped for chain traffic.
- Ops: subscribe/unsubscribe stay well under `maxOpsPerSecond` (20).

---

## 9. Safety, compliance and honesty gates

| Gate | Where | Test |
|---|---|---|
| Streaming cannot place orders | `chainView.mjs` imports; protocol ops are read-only | `market/chainView.test.mjs` import grep (no `orders/`, `paper/`, `safety/`) |
| Read scope and account scoping | WS auth needs `read`; `subscribe_chain` passes the key's `accounts` as `allowedAccounts`; `account` param checked | `protocol.test.mjs`: key limited to account A cannot stream via B (`ACCOUNT_FORBIDDEN`), and its view key differs from a `*` key's |
| Stale-price confirmation (BRD §7.5) | ticket (M10) | `chain-live.test.mjs` decision function; manual check in demo with `stall` |
| Kill switch untouched | no change | existing tests |
| Honest unavailability (D5) | nulls stay null; "—" with reasons; `tsKind`; `unstreamed`; broker Greeks age in the method note | `chainViewState.test.mjs` (never writes 0 for missing), `normalise` tests |
| Data stays local, no redistribution (§8.3) | nothing persisted; no outbound calls except through `marketData`; perf probe local only | `chainView.test.mjs` asserts no `fetch` import; `stream-client.test.mjs` asserts the only URLs are same-origin |
| Tunnels and remote phones | unchanged: `wss` follows the page protocol; compliance.md tunnel caveats apply; `remoteDashboard` stays demo-only | CSP test in `core/app.test.mjs` |
| Neutral copy | dim reasons are descriptive ("Wide spread", "No trades today"), never "avoid" or "illiquid trap" | `options.test.mjs` grep of reason texts for buy/sell/avoid/rich/cheap |
| Accessibility | §6.11 | manual check list in the PR |
| Demo isolation | `/v1/demo/feed` exists only in demo mode, admin + loopback | `demo.test.mjs` (404 when not demo) |
| CSRF | the new write route is admin + loopback and goes through the core pipeline's same-origin check | existing core tests cover the route class |

---

## 10. Test plan

### 10.1 Unit (vitest, `environment: node`, manual clock, no network)

| File | Covers |
|---|---|
| `server/bridge/market/normalise.contract.test.mjs` (update) | Dhan fixture `top_bid_quantity`/`top_ask_quantity` → `bidQty` 150 / `askQty` 75; quote `depth.bids[0].qty` fallback; null stays null |
| `server/bridge/market/marketDataService.test.mjs` (update) | `ts`/`tsKind` per path (§3.3 table): broker chain = read time `snapshot`; built chain from a stream tick = tick time `received` (or `exchange`); cache hit keeps the original `ts` |
| `server/bridge/market/chainViewState.test.mjs` | §7.1, §7.2, §7.7, §7.8, §7.9 examples exactly; `bidQty` absent in a tick leaves the value; Greek-only patches carry no `ts`; `drainPatch` returns null when nothing changed; 160 dirty legs drained in < 2 ms (budget test, median of 20 runs) |
| `server/bridge/market/chainView.test.mjs` | fake hub + bus + fake `optionChain` + manual clock: two sessions share one view; release on the last one calls `dropClient` within the same turn (`lingerMs: 0`); re-centre subscribes new legs before dropping old ones and emits `recentre`; broker Greeks kept and refreshed at 60 s; computed Greeks throttled to ≤ 1/s/leg (§7.6 CPU bound); state transitions live → stalled at 5 s → live; hub `stream.status` down → `down`; partial `SUBSCRIPTION_LIMIT` → `unstreamed`; `maxViews`; no forbidden imports |
| `server/bridge/stream/protocol.test.mjs` (update) | op schema validation; snapshot reply with `id`; merge slot conflation (100 patches with the transport blocked → one merged patch, correct fields); snapshot discards the queued patch; `minIntervalMs` honoured; `maxChainsPerClient`; resync; `unsubscribe_chain`; close releases all; `ACCOUNT_FORBIDDEN`; AsyncAPI doc test lists the new ops and types |
| `server/bridge/stream/endpoints.test.mjs` (update) | `/v1/stream/stats` has `chains` and `chainSubscriptions`; both drop within one turn of unsubscribe |
| `server/bridge/demo/demo.test.mjs` (update) | §5 cadence (ATM ≥ 3.5 ticks/s, 16-strike wing ≤ 1 per 10 s over a simulated minute); spreads at ATM and wing; zero-volume and one-sided wings exist and are deterministic; `bidQty`/`askQty` are lot multiples and match the REST chain at the same instant; `exchangeTs` set; stall `silent` emits nothing while status stays connected; `disconnect` toggles status; route 404 outside demo, 403 without admin |
| `server/bridge/dashboard/chain-live.test.mjs` | §7.3, §7.4 table, §7.5 timeline exactly (fake time), §7.10; `applySnapshot`/`applyPatch` round-trip equals the REST shape; holiday heuristic (§2.3) after 3 old fallback polls |
| `server/bridge/dashboard/stream-client.test.mjs` | fake `WebSocket` + fake `api`: token fetched per connect; back-off sequence bounds; resubscribe after reconnect; `close()` sends unsubscribe synchronously; idle close at 10 s; `go_away` with `null` stops; watchdog reconnect |
| `server/bridge/dashboard/options.test.mjs` (update) | ticket staleness decision; neutral-copy grep on reason texts |
| `server/bridge/dashboard/desk.test.mjs` (update) | `CHAIN_COLUMNS` has `touch`; presets unchanged; `chainConfig` keeps old saves; `stream` pref defaults to true |
| `server/bridge/dashboard/format.test.mjs` / `core/app.test.mjs` (update) | `DASHBOARD_FILES` includes `stream-client.js` and `chain-live.js`; dashboard CSP `connect-src` includes `ws://<host>` and `wss://<host>` for the request's validated Host, and nothing wider |

### 10.2 Contract
- `core/openapi.test.mjs` green with the `ChainLeg`, `StreamStats` and `/v1/demo/feed` additions.
- AsyncAPI doc test (in `protocol.test.mjs`) green.
- BL-1 fixture tests per adapter (lead).
- MCP: `mcp/tools.test.mjs` `get_option_chain` output still validates with the new fields.

### 10.3 End-to-end (`server/bridge/e2e/stream-chain.e2e.test.mjs`, `bootBridge` in demo config, real WebSocket client from `ws`)
1. Get a stream token; `subscribe_chain` NIFTY nearest, `strikes: 40` → `chain_snapshot` with 81 rows; every leg has `bidQty`, `askQty`, `ts`, `tsKind: "exchange"`.
2. Within 1 s at least 5 `chain_patch` messages arrive. Their `lagMs` p95 is ≤ 150 ms. `/v1/stream/stats` shows the chain with `clients: 1` and `state: "live"`.
3. `POST /v1/demo/feed { mode: "silent", ms: 8000 }` → a `chain_status` `stalled` within 6 s; `live` within 2 s of the stall ending.
4. `{ mode: "disconnect", ms: 4000 }` → `chain_status` `down`, then `live`.
5. `unsubscribe_chain` → poll `/v1/stream/stats` every 100 ms: the chain is gone within 1 s, and `downstream.chainSubscriptions` is 0.
6. Subscribe again, then close the socket → same check within 1 s.
7. Paper positions: place a short strangle on `demo-paper`, open a second connection with `subscribe_orders` and `subscribe_chain` for that expiry with `strikes: 15`; patches arrive for the held legs.
8. A read key restricted to `demo-paper` (no market-data or feed account) → an `error` for `subscribe_chain`: `CAPABILITY_UNSUPPORTED`, or the same code `GET /v1/optionchain` returns for that key, asserted to be identical. No view is created.

### 10.4 Manual performance protocol (results pasted in the PR)
1. Reference machine: a mid-range laptop (4-core, 8 GB). Chrome stable, DevTools CPU throttling **4×** to approximate it on a faster machine (state which). Phone: a 4-year-old mid-range Android over LAN to a demo Bridge (`remoteDashboard`).
2. `mc-bridge start --demo`, open `#/chain?perf=1`, NIFTY nearest, strikes "All" (81 rows, 162 legs streaming), preset "Greeks" (7 columns).
3. Wait 60 s, then read `window.__mcbPerf`. **Pass**: `serverP95 + clientP95 ≤ 250 ms` (desktop) / ≤ 400 ms (phone), and `longTasks.max ≤ 50 ms` with `longTasks.count = 0` above 50 ms.
4. Scroll the table top to bottom for 10 s while recording a DevTools Performance trace. **Pass**: no frame over 16.7 ms attributable to `frame()`/`patchLegs`, and a steady 60 fps on the FPS meter.
5. Stall test: ⋯ → "Test the fallback". The pill shows "Polling 3 s" at about 5 s and "Live" about 3 s after the stall ends. The network panel shows `/v1/optionchain` only during the polling window.
6. Navigate to `#/positions` and open `/v1/stream/stats` in another tab. The chain view is gone within 1 s.

---

## 11. Migration and back-compat

- REST: additive optional fields only (`/v1` rule, BRD §7.8). Clients that ignore unknown fields are unaffected.
- WebSocket: additive ops and messages; AsyncAPI 0.1.0 → 0.2.0. Existing clients never receive chain messages unless they ask.
- Version skew: a dashboard served by a newer file set against an older server gets `VALIDATION_FAILED` for `subscribe_chain`. The client treats an unknown op as "no chain support" and polls as today.
- Default on: the dashboard streams by default. Turn it off with the ⋯ toggle (per browser) or server-wide with `market.chainView.enabled: false`.
- CSP: `connect-src` widens from `'self'` to `'self' ws://<host> wss://<host>` for the validated Host only (some browsers do not treat `ws:` as `'self'`).
- Demo feed timer from 1 s to 100 ms: the cost per token falls (most tokens skip most slots). The `createDemoAdapter({ tickMs })` option keeps working; tests that passed `tickMs` keep their meaning as the timer period.
- `positions.js` funds refresh moves from 15 s to 60 s (it is not market data). Noted in CHANGELOG.
- Rollback: set `market.chainView.enabled: false`. Nothing is persisted, so there is no data migration.

---

## 12. Ordered task list (one engineer, one session; each task lands with its tests green)

Stop points: after T6 (server complete and testable by API), T11 (chain page complete), T15.

| # | Task | Files | Done when |
|---|---|---|---|
| T1 | `ChainLeg` `bidQty`/`askQty`/`ts`/`tsKind` on every chain path + OpenAPI | `market/normalise.mjs`, `market/chain.mjs`, `market/marketDataService.mjs`, tests, `docs/openapi.yaml` | §10.1 rows 1–2 pass; `openapi.test` green |
| T2 | Demo realism (cadence, spreads, dead and one-sided wings, P1-1's quantities on ticks, `exchangeTs`) + stall hook | `demo/demoFeed.mjs`, `demo/demoAdapter.mjs`, `demo/demo.test.mjs` | demo tests pass |
| T3 | Pure view state | `market/chainViewState.mjs`, test | §7.1/7.2/7.7/7.8/7.9 examples pass; drain budget passes |
| T4 | View manager + config + contract methods (`chainView`, `chainViewStats`) | `market/chainView.mjs`, `market/config.mjs`, `market/marketDataService.mjs`, `core/contracts.mjs` (lead), test | `chainView.test.mjs` passes |
| T5 | Protocol ops, merge slot, throttle, stats, `maxChainsPerClient` + AsyncAPI | `stream/protocol.mjs`, `stream/config.mjs`, `stream/module.mjs`, `docs/asyncapi.yaml`, tests | protocol and endpoint tests pass |
| T6 | `POST /v1/demo/feed` + OpenAPI | `demo/routes.mjs`, `demo/demoMode.mjs`, `docs/openapi.yaml`, test | route tests pass; e2e steps 1–6 pass |
| T7 | Core: CSP, `DASHBOARD_FILES` (lead review) | `core/app.mjs`, `core/app.test.mjs`, `format.test.mjs` | tests pass |
| T8 | `chain-live.js` | dashboard + test | §7.3/7.4/7.5/7.10 pass |
| T9 | `stream-client.js` | dashboard + test | fake-WS tests pass |
| T10 | Chain page streaming: subscribe, fast path `patchLegs`, slow path, fallback timer, pill `via`, hidden tab, cleanup, ⋯ toggle and demo stall row | `desk.js`, `app.js` (`liveControl`), `app.css` (`data-via`) | demo: ticks flash, stall → Polling → Live |
| T11 | Dimming + glyph + reasons + touch column | `desk.js`, `options.js`, `app.css` (`data-dim`), `desk.test.mjs` | wings dim with reasons in demo; presets unchanged |
| T12 | Action sheet depth | `chain-sheet.js` | depth shows, polled label, stops on close |
| T13 | Ticket stale confirmation | `desk.js` (`openTicket`), `options.test.mjs` | stall demo → ticket needs the tick box |
| T14 | Positions streaming | `positions.js` | demo paper book updates live; fallback works; leaving releases |
| T15 | Perf probe + manual protocol run | `desk.js` (probe), PR notes | §10.4 numbers recorded and passing |
| T16 | E2E + docs (STREAMS, ARCHITECTURE, `guides/streaming.md`, CHANGELOG, MCP description) | `e2e/stream-chain.e2e.test.mjs`, docs, `mcp/tools.mjs` | full `npx vitest run` and `node scripts/check-mjs.mjs` green |

BL-1 (broker layer) is a separate lead PR, in parallel, not blocking.

---

## 13. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | The fast path still blows the 250 ms / 50 ms budget on a real mid-range laptop (slow-path `context()` over 81 rows, bar resizes) | Medium | High | Fast/slow split; slow path ≤ 1 Hz; probe first (T15) before polish; fallback lever: raise `minIntervalMs` to 200 ms and `DERIVED_MS` to 2 s, documented |
| R2 | Feed quantities and exchange times stay null until BL-1 lands | High | Medium | Dhan REST chain quantities; honest "—" and `tsKind: "received"`; BL-1 sized as one small lead PR |
| R3 | OI/volume units differ between feed and REST for a broker → wrong ΔOI live | Medium | High | §7.9 check per view; P1-1 OI-unit table; fall back to REST OI at 60 s with a visible note |
| R4 | Broker Greeks (Dhan) 60 s old while prices are live → IV and price disagree briefly | Certain | Low | Method note with the age; P1-3 replaces with one live model |
| R5 | Feed capacity (Zerodha/Upstox unverified) with the recorder at 60 % → partial streaming | Medium | Medium | `unstreamed` reporting and dimming; positions windows narrow (≤ 15); hub ref-counting with the recorder |
| R6 | Silent feed stalls not detected by the hub for 60 s (`staleAfterMs`) | Medium | Medium | View `stallMs` 5 s and the client data clock decide, not hub status; demo `silent` mode tests exactly this |
| R7 | Product rejects the positions 30 s reconcile as a "REST poll" (§7.2) | Low | Low | It is book membership, not market data; documented deviation; order events cover Bridge-placed orders |
| R8 | Merge conflicts with the dashboard restyle (`desk.js`, `positions.js`, `app.css` are being edited now) | High | Medium | No visual spec; three `data-*` CSS rules only; land T10–T14 after the restyle's current PR or rebase onto it; changes kept to named functions (`patchLegs`, `startTimer`, `cleanup`, `openTicket`) |
| R9 | Holidays look like a dead feed until P1-2 | Medium (a few days a year) | Low | §2.3 heuristic drops to 30 s polling and says so |
| R10 | Browser CSP treats `ws:` differently from `'self'` | Low | High (no streaming at all) | Explicit `ws://host`/`wss://host` in `connect-src`; core test; client falls back to polling on connect failure |
| R11 | Demo cadence at 100 ms with many tokens costs CPU in demo | Low | Low | Per-token slot check is O(subscribed); a test bounds one minute of 500 tokens at < 200 ms CPU |
