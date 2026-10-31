# Spec P1-11: Option alerts engine (H1)

Status: ready to build · Owner: tech lead, Options desk · Date: 29 Oct 2026 · Stream: **S24 "Alerts"** (final id from the stream table in `docs/spec/README.md`). Small changes also land in S15 notify, S6 stream, S11 MCP, demo and the dashboard, plus lead-owned core changes (§3.1).
Builds on: BRD `docs/brd/options-platform.md` §3.H (H1), §5.2 (S7 store), §5.5 "Alert evaluator", §5.6 (`GET|POST|DELETE /v1/alerts`), §6.1 P1-11 (acceptance criteria), §7.1 (alert latency), §7.2 (rate limits), §7.4 (accessibility: "announce alerts" opt-in), §7.5 (safety), §7.6 (data honesty), §7.7 (restart and privacy), §7.8 (API contract), §7.9 (threat model: notifications), §8.1 (RA/IA wording, algo framework), §8.3 (market-data terms), §8.5 ("Guard or alert auto-exit fires wrongly").

Dependencies (each has an interim behaviour, so the module builds and runs before every dependency lands):

| Spec | Hard / soft | What P1-11 uses | Without it |
|---|---|---|---|
| **P1-1** recorder | **Hard for acceptance** (the "≤ 70 s recorder-only" path, chain metrics and ΔOI windows) | Bus `recorder.snapshot`, the in-memory latest snapshot per chain, `store.read` for a snapshot at `t − window` | Chain metrics (PCR, walls, ATM straddle, chain ΔOI) poll `marketData.optionChain` at background priority (≤ 2 chains/min); ΔOI windows build from the module's own minute ring and show "collecting" after a restart |
| **P1-3** pricing core and vol store | **Hard for the IVR/IVP condition**; soft otherwise | `vol.rank()`, the vol-time clock (`vol.clock()` / `pricing.js` Black-76) | IVR/IVP conditions are refused at create time with `CAPABILITY_UNSUPPORTED`; IV and Greeks always use `pricing.js` (P1-3a lands before this item); there is no second Black-76 implementation |
| P1-2 reference data | Soft | `reference.session()`, `reference.calendar().isTradingDay()` | `lib/marketHours.mjs` weekday rule and special sessions; holidays unknown (time alerts say so) |
| P1-4 streaming | Soft | `dashboard/stream-client.js` for in-app delivery; the demo per-token tick cadence | The dashboard polls `GET /v1/alerts/inbox` every 15 s (local, no broker call). `streamHub` ticks already exist today, so the server side does not need P1-4 |
| P1-5 readiness | Soft (needed only by LATER actions) | Nothing this round. Alerts in this round notify only. H3 (alert → action) registers with `readiness.registerAutomation()` | — |
| P1-8 exposure | Soft | Bus `exposure.levels` for GEX walls (`basis: "gex"`) | Only OI walls (`basis: "oi"`) are offered; `gex` is refused with `CAPABILITY_UNSUPPORTED` |
| P1-9 multi-expiry | Soft | `dashboard/scenario.js` (pure) for multi-expiry strategy P&L marks | Strategy conditions accept single-expiry legs only (§2.3) |

Not in this spec: visual styling. Another team is restyling the dashboard (near-black theme, colour tokens, motion). New UI uses existing components (`card`, `pill(text, "ok"|"warn"|"bad")`, `modal`, `sheetPopover`, `segmented`, `toast`, `emptyState`, the chain action sheet) and the shared tokens in `palette.css` only. No new colours and no new motion. One new stroke icon (`bell`) is added to `ICONS` in `app.js` in the same 24-px stroke style as its neighbours; the restyle team may redraw it.

> **Build order and shared foundations.** This spec is steps 23–24 (P1-11a server T1–T11, P1-11b dashboard T12–T16) in `docs/spec/README.md`, after P1-1a, P1-3b (P1-8a, P1-9a soft). It uses, and does not rebuild, the F0 foundations listed there: final stream ids, bus topics and error codes pre-registered in core, the opt-in `options` MCP toolset (every MCP tool in this spec goes there), `demo/routes.mjs` plus the OpenAPI demo-only list, `server/lib/jsonl.mjs` (append, torn-line tolerance, last-wins, quarantine of corrupt files), `ratelimit/backgroundGate.mjs` (the one ≤ 50 % background-budget check), `core/ownership.mjs`, and `dashboard/copyRules.mjs` (the one banned-word list). Where this text and README disagree, README's build order and shared-module owners win.

---

## 1. Summary

Today the Bridge has one kind of alert: a saved scan that finds new symbols (`scan.alert`). Nothing watches an option contract, a chain or a strategy.

After this item:
- A server module **`alerts`** evaluates user rules **with the browser closed**. A rule has 1 to 5 **conditions** joined by **all** (AND) or **any** (OR). Twelve condition kinds are supported: contract/spot/future **price**, **IV**, **IVR/IVP**, **ΔOI over a window**, **PCR**, **wall shift**, **Greek threshold**, **straddle premium**, **strategy P&L**, **short strike tested** (X % or σ), **breakeven breach**, and **time**.
- Each input comes from the cheapest honest path: **stream ticks** (p95 ≤ 5 s from condition to notification), then the **recorder's minute snapshots** (p95 ≤ 70 s), then a **background REST poll** inside a stated budget (≤ 35 s; shown per rule). Every rule shows its path and expected latency.
- A fire is written to **S7** (`dataDir/alerts/fires/YYYY-MM.jsonl`), emitted as the bus event **`option.alert`**, and delivered **in-app** (toolbar bell, inbox, toast, `/v1/stream` message) and to the existing **notify** targets (Telegram, Discord, Slack, webhook). Each target can filter by tag, severity and underlying, and each rule can pick its targets. Messages carry **no account id, key id or token**, and strategy rupee amounts only when the user turns on "share amounts".
- **Repeat control:** once, once per trading day, or at most every N minutes. **Hysteresis** per metric, an optional hold time and a bad-tick filter stop flapping. Alerts **never fire on stale data**. A rule whose data is stale shows `blind`.
- **Cap:** 500 active rules per installation (configurable).
- **Dashboard:** a new **Alerts** page (`#/alerts`), a toolbar **bell** with an unread count, and "Alert…" entry points on the chain action sheet, chain summary tiles, OI page tiles, Vol page IVR tile, Positions group header, Strategy builder and (when P1-8 is present) Exposure levels.
- **Demo mode:** demo prices, IV (through the smile), OI (P1-1 time-varying OI), PCR, straddles and strategy P&L all move, so alerts fire naturally. Three **sample rules** are seeded with thresholds read from the demo's own future price path, so they fire within 2 to 10 minutes of start. A demo-only **simulate** route feeds any condition kind (including a wall shift, which the demo market holds steady intraday by design in P1-8) through the full fire path.
- **No orders.** The module never imports `orders/`, `paper/` or `safety/`. Alert → action is H3 (Phase 2).

---

## 2. Scope

### 2.1 MUST (this round)

| # | Item | Acceptance hook (BRD P1-11) |
|---|---|---|
| M1 | `alerts` module (`server/bridge/alerts/`): schema, pure engine (latches, hysteresis, all/any, repeat, hold, stale, sanity), pure metric functions, input planner (stream → recorder → poll), feeds, service loop, store, routes | evaluation on the server with the browser closed |
| M2 | The 12 condition kinds of §6 with their subjects and parameters; `match: "all" \| "any"`; 1–5 conditions | supported conditions; AND/OR across up to 5 |
| M3 | Input paths with per-rule path and latency label; stream share and REST budget guards (§7) | p95 ≤ 5 s streamed, ≤ 70 s recorder-only |
| M4 | Repeat `once` / `daily` / `every N minutes`; per-metric hysteresis defaults with override; `holdSeconds`; bad-tick filter; `blind` state | repeat control; hysteresis |
| M5 | S7 storage: `rules.json`, `state.json`, append-only fire log, retention; restart restores latches without re-firing | every fire written to S7; survives restart (§7.7) |
| M6 | Bus topic `option.alert`; notify: `NOTIFY_EVENTS += "option.alert"`, default events gain it, target filters (`alertTags`, `alertSeverities`, `alertUnderlyings`), rule `targets`, message format, merge of queued alert messages per target | delivered to notify targets; each target can filter; no identifiers |
| M7 | In-app: inbox endpoints, `/v1/stream` op `subscribe_alerts` (+ SSE `alerts=1`), toolbar bell, toasts (polite live region only when "announce alerts" is on) | delivered in-app |
| M8 | Cap 500 active rules (configurable 1–2,000), per-owner cap 200; `ALERT_LIMIT` error | cap 500 |
| M9 | REST routes §4, OpenAPI, AsyncAPI, MCP read tool `get_alerts` | §7.8 contract |
| M10 | Dashboard: `#/alerts` page, alert form (sheet/modal), entry points on 6 pages, bell; phone/tablet/desktop | create from any chain cell, level, position or strategy, and in a manager |
| M11 | Demo: sample rules from the demo future path, `POST /v1/demo/alerts/simulate`, `alerts-demo/` folder, "would send to" delivery preview (notify is off in demo) | every feature visible without a broker |
| M12 | Docs: `docs/guides/alerts.md` (new), `notifications.md`, `compliance.md` (data terms line), `ARCHITECTURE.md`, `STREAMS.md`, `bridge.config.example.json`, CHANGELOG | — |

### 2.2 LATER (not this round; named so nobody builds it now)

- **Alert → action (H3)**: prepare or send a basket, exit a strategy, engage the kill switch. Needs P1-5 automation registry, P1-10 pre-trade check and the §8.1 legal review. The rule schema reserves `actions: []`, and this round's validator refuses a non-empty value.
- **Nested groups** (`(A and B) or C`). This round has one operator per rule, which covers the BRD criterion "AND/OR across up to 5 conditions".
- **Reminders while true** ("tell me every 15 min while PCR stays below 0.7"). This round's `every` mode fires on each new rising edge at most once per N minutes (§6.14).
- **Replay / "would have fired at"** over recorded S1 history. It is useful for tuning hysteresis, and is the first Phase 2 add-on.
- **Positions-following strategy alerts.** This round a strategy condition holds the legs and entry prices given at creation (from the builder or a positions group). It does not follow later fills. Following live positions needs the S8 strategy groups (P1-12 / I5).
- **Multi-expiry breakevens.** They move with time and IV (§2.3).
- **MCP write tools** (`create_alert`, `delete_alert`). This round MCP gets the read tool only. Writes go through REST and the dashboard.
- **Per-fire delivery receipts** (which target delivered which fire). The notifier exposes per-target counts today. Per-fire receipts need a notifier callback.
- **Browser push notifications** (Notification API / service worker). The page must be open anyway, and the in-app toast covers it.
- **A global background-budget accountant** shared by recorder, screener, scanner and alerts (§7.4).
- **Commodity and currency sessions** (Phase 3).

### 2.3 What our data cannot do (and the honest fallback)

| Limitation | Why | Fallback in this spec |
|---|---|---|
| "≤ 5 s" needs a streamed instrument, and feed slots are finite | Broker feeds cap subscriptions (Dhan 5×5,000, Zerodha 3×3,000, Upstox 2×2,000 per `brokerPolicies.mjs`). The recorder holds up to 60 % and pages need room | Alerts hold at most `stream.share` (15 %) of the feed account's cap. Symbols beyond it use the recorder (if the chain is recorded) or the REST poll. The rule shows its path: "Live stream · usually under 5 s", "Recorder · within about 70 s", "Polling every 30 s · within about 35 s" |
| Some feeds send no OI on ticks | Tick `oi` is optional in the contract (`Tick.oi: number \| null`) | ΔOI uses tick OI when present, otherwise recorder snapshots, otherwise the poll. The rule says which |
| ΔOI over a window needs history | Without P1-1 the module only has what it saw since start | With P1-1: the snapshot at `t − window` (≤ 90 s tolerance). Without it: the module's own minute ring (in memory, per watched symbol and chain, 400 samples). After a restart the condition is `waiting_data` "collecting 15 min of OI (6 of 15 min)". "vs previous close" uses the chain's `oiChange`/previous OI when the broker sends it, else the recorder's previous-day last snapshot, else unavailable |
| PCR and walls cover the recorded strikes, not the whole chain | The recorder records ±40 strikes (indices) or ±15 (stocks) | PCR and OI walls are computed over the strikes in the snapshot. The condition text says "PCR (OI, ±40 strikes)". Users can narrow it with `strikes` |
| An OI wall is not a gamma wall | They answer different questions | `basis: "oi"` (largest OI strike, always available) or `basis: "gex"` (P1-8's Call/Put Wall, only when P1-8 is present). The text names the basis, and the disclaimer for modelled exposure (BRD §8.4) is appended for `gex` |
| IVR/IVP move slowly and may be partial | They rank a daily series (P1-3). `current` refreshes every snapshot TTL | Evaluated every `volRankEverySeconds` (300). Latency for this kind is "within about 5 min", stated in the form and the docs (outside the BRD's stream/recorder split). A partial lookback fires with "(partial: 34 of 252 days)". `COLLECTING`/`FLAT` give `waiting_data` |
| Broker Greeks and IVs use unknown models and clocks | Brokers do not publish the T, rate or forward they use | IV and Greeks are always recomputed: Black-76 on the parity forward, T from the vol-time clock (P1-3) or calendar ACT/365 (interim, labelled). Broker `iv`/`delta` fields are never used |
| Strategy alerts do not follow positions | No server-side strategy groups until S8 | The rule stores legs and entries. The form and every message say "legs as saved on 29 Oct 10:12; later trades are not included". A positions-group alert can be re-saved in one tap from Positions |
| Multi-expiry breakevens move with time and IV | They come from a model, not from fixed expiry payoff | `breakeven` accepts single-expiry option legs (futures allowed only in the same expiry). Multi-expiry legs get 400 "Breakevens of multi-expiry structures move with time and IV; use a strategy P&L or short-strike condition instead" |
| A cross that happens while the Bridge is off is not seen | No data was observed | On start, `crosses_*` conditions re-seed their latch from the first observation without firing. Level conditions (`above`, `below`, …) fire on the first observation if true and the repeat gate allows. The guide states this |
| Notifications are off in demo mode | The notifier never starts in demo (`notifier.mjs start()`) | Demo fires go in-app only. The fire record lists `delivery.wouldSendTo` with the targets that would have received it, and the form's "Test" shows the formatted message text |
| Telegram allows about 1 message per second per chat | Telegram's limits; the notifier spaces sends by `minIntervalMs` (1,100 ms) | When several `option.alert` messages wait in one target's queue, the notifier merges up to 10 into one message (§3.9). A burst of 20 fires reaches a phone in 2 messages, not 20 |
| Exchange holidays are unknown before P1-2 | `lib/marketHours.mjs` has no holiday list | Market conditions do not fire on a closed market anyway: no ticks arrive, so they stay `market_closed`/`blind`. A `time` rule on "trading days" would fire on a holiday. Its message then adds "(The Bridge does not have the exchange holiday list yet.)" |

---

## 3. Architecture

### 3.1 Module map

New files:
```
server/bridge/alerts/module.mjs        defineModule({ name: "alerts", stream: "S24", configKey: "alerts", register, start, stop })
                                       + ROUTES table + USED_SERVICES + alertsFor(deps) (for MCP, like scannerFor)
server/bridge/alerts/config.mjs        ALERTS_CONFIG_SCHEMA (zod .strict()), parseAlertsConfig
server/bridge/alerts/schema.mjs        zod schemas: ruleInput, condition (discriminated by metric), patch; sanitiseText();
                                       METRICS catalog (subjects, params, units, ops, default hysteresis, latency class)
server/bridge/alerts/metrics.mjs       pure: ivOf, greeksOf (both via dashboard/pricing.js), oiChange, wall stability rule, atmStraddle,
                                       (pcr and largest OI come from dashboard/oi-series.js; legMark/strategyPnl from dashboard/marks.js)
                                       shortStrikeDistance, breakevens, nextTimeFire, describe(cond, value) (copy)
server/bridge/alerts/engine.mjs        pure: evalCondition(cond, cstate, input, now, cfg) -> { truth, cstate', value, reason },
                                       combine(match, truths), gate(repeat, rstate, edge, now, session) -> { fire, rstate' },
                                       ruleStatus(), sanity filter
server/bridge/alerts/plan.mjs          pure: inputsFor(rule) -> InputKey[]; choosePath(inputKey, caps) -> "stream"|"recorder"|
                                       "poll"|"vol"|"exposure"|"clock"|"unavailable"; latencyLabel(path)
server/bridge/alerts/feeds.mjs         createFeeds(deps, cfg): input cache keyed by InputKey; hub client "alerts"; bus listeners
                                       (tick, recorder.snapshot, exposure.levels); poll timers; minute ring; budget guard
server/bridge/alerts/alertService.mjs  createAlertService(deps, { feeds, store, clock, timers }): CRUD, owner checks, dirty set,
                                       eval loop, fire, inbox, status, caps, key.revoked handling, demo hooks
server/bridge/alerts/store.mjs         rules.json / state.json (writeFileAtomic), fires/YYYY-MM.jsonl (append), retention,
                                       corrupt -> rename + fresh, inbox reconstruction from the fire log tail
server/bridge/alerts/routes.mjs        REST handlers (§4)
server/bridge/alerts/demoAlerts.mjs    sample rules from the demo future path; simulate() inputs
server/bridge/alerts/fake.mjs          in-memory alert service for other streams' tests (P1-12, H3)
server/bridge/dashboard/marks.js          SHARED pure (no imports): legMark(q, { basis, maxSpreadPct }), strategyPnl(legs, marks) on signed units;
                                          created here, imported by P1-12's guard-core.js so a guard and an alert on the same legs report the same P&L
server/bridge/dashboard/alerts-model.js   pure: phrase(rule), conditionText, statusPill, pathLabel, formModel(context) -> defaults,
                                          validateDraft, inboxModel, csvRows; node-tested, no DOM
server/bridge/dashboard/alerts-page.js    #/alerts page (rules list, fired timeline, status strip, filters)
server/bridge/dashboard/alert-form.js     openAlertForm({ context, onSaved }): modal (≥ 720 px) or bottom sheet (< 720 px)
server/bridge/dashboard/alerts-bell.js    toolbar bell, unread count, popover/sheet, toasts, WS-or-poll inbox
docs/guides/alerts.md
tests                                     listed in §10
```

Changed files and owners:

| File | Owner | Change |
|---|---|---|
| `core/builtinModules.mjs` | lead | Add `alerts` after `scanner` (after `recorder`, `vol`, `exposure` when present). |
| `core/eventBus.mjs` | lead | New topic `option.alert` (payload §3.4). |
| `core/errors.mjs` | lead | New code `ALERT_LIMIT: { status: 422, title: "The alert limit has been reached", retryable: false }` (additive). |
| `core/app.mjs` | lead | `DASHBOARD_FILES` += `alerts-model.js`, `alerts-page.js`, `alert-form.js`, `alerts-bell.js`. |
| `notify/config.mjs` | S15 | `NOTIFY_EVENTS` += `"option.alert"`; default `events` += `"option.alert"`; optional target keys `alertTags` (≤ 20 strings), `alertSeverities` (`info`/`warn`/`high`), `alertUnderlyings` (≤ 50). |
| `notify/notifier.mjs` | S15 | `wants()` case `option.alert` (§3.9); merge of queued `option.alert` items in `pump()`. |
| `notify/format.mjs` | S15 | Case `option.alert` (§3.9). |
| `stream/protocol.mjs`, `stream/sse.mjs` | S6 | Op `subscribe_alerts`/`unsubscribe_alerts`; message `type: "alert"`; SSE `alerts=1`. Owner filter as for scans. |
| `mcp/tools.mjs` | S11 | Read tool `get_alerts` (rules visible to the key + last 50 fires). |
| `demo/routes.mjs` (P1-4, or new), `demo/demoMode.mjs` | demo | `POST /v1/demo/alerts/simulate`; demo config defaults for `alerts` (§5). |
| `dashboard/app.js` | dashboard | `ICONS.bell`; toolbar slot `#toolbar-alerts` mounted by `alerts-bell.js`. |
| `dashboard/views.js` | dashboard | Page entry `{ id: "alerts", label: "Alerts", icon: "bell", group: "Options", layout: "desk", … }` after Positions. |
| `dashboard/chain-sheet.js`, `desk.js`, `oi.js`, `vol.js`, `positions.js`, `strategy.js` (`exposure.js` when P1-8 is present) | dashboard | "Alert…" entry points (§6.4). Each calls `openAlertForm({ context })`; no other logic changes. |
| `docs/openapi.yaml`, `docs/asyncapi.yaml`, `docs/ARCHITECTURE.md`, `docs/STREAMS.md`, `docs/guides/*`, `bridge.config.example.json`, `CHANGELOG.md`, `core/cli.mjs` (`doctor`) | lead | §4.8, §4.9; doctor check "notify targets exist and none listens to option.alert". |

`USED_SERVICES = ["streamHub", "marketData", "symbols", "accounts", "scheduler", "recorder?", "vol?", "exposure?", "reference?"]`. The `?` services are optional: absent or stub (`isStub`) means "not available", and the catalog says so. No contract change is needed: alerts is a routes module like the scanner. `alertsFor(deps)` exposes the service to `mcp/tools.mjs`.

**Rule:** no file under `server/bridge/alerts/` imports from `orders/`, `paper/` or `safety/`, and none calls `fetch`. A test greps for this (§10.1). Alerts can never place an order.

### 3.2 Data flow

```
streamHub ──bus "tick"──────────┐
recorder ──bus "recorder.snapshot"──┤        feeds.mjs (input cache by InputKey,      alertService (1 s loop)
exposure ──bus "exposure.levels"──┼──────▶ minute ring, sanity filter) ──dirty──▶ engine.evalCondition × n
vol.rank (every 300 s) ─────────┤                                                   engine.combine / gate
marketData.quotes/optionChain ──┘ (poll, background, budget guard)                  │ fire
clock (every loop) ─────────────────────────────────────────────────────────────────┤
                                                                                     ▼
                         store.appendFire (S7) ──▶ bus "option.alert" ──▶ notifier (targets, filters, merge)
                                                                     ├─▶ stream/protocol (subscribe_alerts) ──▶ dashboard bell
                                                                     └─▶ inbox (memory, from the fire log tail)
```

`InputKey` examples: `q:NFO:NIFTY26N0325150CE` (quote of one symbol), `u:NIFTY` (spot), `c:NIFTY|2026-11-03` (chain snapshot), `c:NIFTY|front`, `r:NIFTY|cm30|252` (vol rank), `l:NIFTY|front|oi` / `l:NIFTY|front|gex` (walls), `t` (clock). Each input holds `{ value(s), receivedAt, asOf, source, quality }`. Many rules share one input. A tick marks only the rules that use its symbol dirty (index `Map<symbol, Set<ruleId>>`).

### 3.3 Process and schedulers

All timers follow the scanner/notify pattern: `start()` arms them with `unref()`, `stop()` clears them, and time comes from `deps.clock.now()`. Timers are injectable for tests.

| Job | When | What |
|---|---|---|
| Eval loop | every `evalIntervalMs` (1,000 ms) | Evaluate dirty rules plus every rule with a `time` condition or a pending `every` cooldown. Each batch is capped at 200 rules per turn (`setImmediate` between batches). p95 loop time ≤ 20 ms at 500 rules (measured in `alertService.test.mjs`) |
| Subscription sync | on rule create/update/delete, on `stream.status` and `account.status`, and every 60 s | Recompute the watch set → `streamHub.subscribe("alerts", add, "quote")` / `unsubscribe`. Rejected symbols (`SUBSCRIPTION_LIMIT`) and symbols beyond `stream.share` move to the recorder/poll path |
| Poll | every `poll.everySeconds` (30) in session | One batched `marketData.quotes(symbols, { priority: "background", maxAgeMs: 20_000 })` per account for poll-path symbols (batch ≤ policy `maxQuoteBatch`). Chain-path inputs without recorder coverage: `optionChain(..., { priority: "background", maxAgeMs: 60_000 })`, at most `poll.maxChainsPerMinute` (2). Budget guard §7.3 |
| Vol rank | every `volRankEverySeconds` (300) in session, and once on start | `vol.rank({ underlying, basis, lookbacks: [lb] })` per distinct key (memory/disk only; no broker call) |
| Minute ring | on every `recorder.snapshot` and on the first loop of each minute | Append `{ minute, oi, ltp }` per watched symbol and chain total (ring of 400) |
| State flush | at most every 5 s when dirty, and on every fire | `state.json` via `writeFileAtomic` |
| Session edges | at session open and close (IST, from `reference.session()` or `lib/marketHours.mjs`) | Open: reset combined state to `unknown` (so `daily` level rules can fire again), roll `front` expiries, expire rules whose contract expired yesterday. Close (15:30): expire contract rules on their expiry day |
| Retention | 02:50 IST daily and on start | Delete fire-log months older than `fireLog.retentionDays` (400) |
| Demo samples | first start in demo when `alerts-demo/rules.json` is missing | §5 |

Market conditions are evaluated only inside the session (09:15–15:30 IST for NFO/BFO, or the `reference` session). Outside it a rule shows `market_closed`. `time` conditions are evaluated at all hours. In demo the market is always open (the demo feed never stops).

### 3.4 Data model

**AlertRule** (API shape; `rules.json` keeps the same object minus `runtime`):
```json
{
  "id": "al_9f2c1a7b3d4e5f60",
  "version": 3,
  "name": "NIFTY breaks 25,200",
  "note": null,
  "underlying": "NIFTY",
  "match": "all",
  "conditions": [
    { "id": "c1", "metric": "price", "subject": { "kind": "spot", "underlying": "NIFTY" },
      "op": "crosses_above", "value": 25200, "params": { "basis": "ltp" }, "hysteresis": null, "holdSeconds": 0 }
  ],
  "repeat": { "mode": "every", "minutes": 15 },
  "severity": "info",
  "tags": ["breakout"],
  "targets": null,
  "shareAmounts": false,
  "expiresAt": null,
  "actions": [],
  "origin": { "page": "chain", "context": "summary" },
  "owner": "local",
  "enabled": true,
  "createdAt": "2026-10-29T10:12:03+05:30",
  "updatedAt": "2026-10-29T10:14:40+05:30",
  "runtime": {
    "status": "armed",
    "path": [ { "conditionId": "c1", "path": "stream", "latency": "≤ 5 s" } ],
    "values": [ { "conditionId": "c1", "value": 25148.2, "unit": "points", "asOf": "2026-10-29T10:14:39.812+05:30",
                  "source": "stream", "truth": false, "distance": { "abs": 51.8, "pct": 0.206 } } ],
    "lastFiredAt": null, "firesToday": 0, "nextEligibleAt": null, "reason": null
  }
}
```
- `owner`: `"local"` for the operator on this computer and for dashboard sign-in keys (`clientKind: "ui"`, created only from loopback), so rules survive the sign-in key's 30-day expiry. Otherwise the API key id. Non-admin callers see `owner: "you"` for their own rules and never see other owners' rules.
- `targets`: `null` = every notify target that listens to `option.alert` and whose filters pass; or a list of target ids (≤ 20, validated against config at create time; unknown → 400).
- `severity` ∈ `info | warn | high` (only for filtering and the message prefix; no colour semantics beyond `pill` classes).
- `tags`: ≤ 8, `^[a-z0-9][a-z0-9-]{0,23}$`.
- `name` ≤ 80 and `note` ≤ 280 chars, sanitised (control characters stripped, trimmed). They are user text and are sent as quoted data, never interpreted.
- `actions`: reserved for H3; must be `[]` this round.

**Runtime status** (closed list, documented as open in OpenAPI): `armed` (evaluating), `waiting_data` (an input is not available yet: collecting, not recorded, no rank), `blind` (inside the session, an input is older than its stale limit for > 30 s), `market_closed`, `cooldown` (`every` mode, inside N minutes), `fired` (`once` mode, done; can be re-armed), `paused` (user), `expired` (contract expired or `expiresAt` passed), `disabled` (owner key revoked, or a dependency disappeared; `reason` says which).

**Condition** (discriminated by `metric`; full list in §6):
```json
{ "id": "c2", "metric": "oi_change",
  "subject": { "kind": "contract", "symbol": "NFO:NIFTY26N0325200PE" },
  "op": "above", "value": 15,
  "params": { "window": "15m", "unit": "pct" },
  "hysteresis": 1.0, "holdSeconds": 0 }
```
- `subject.kind` ∈ `spot` (`underlying`), `future` (`symbol` or `{ underlying, expiry: "front" | date }`), `contract` (`symbol`, canonical), `chain` (`underlying`, `expiry: "front" | "YYYY-MM-DD"`), `strategy` (`legs` 1–12, `label`, `savedAt`), `clock`.
- `op` ∈ `above`, `below`, `between`, `outside`, `crosses_above`, `crosses_below`, `changes` (wall only), `at` (time only), `breached` (breakeven only).
- `value`: number, `[lo, hi]` for `between`/`outside`, `"HH:MM"` or an ISO instant for `at`, absent for `changes`/`breached`.

**Strategy leg** (inside `subject.legs`):
```json
{ "symbol": "NFO:NIFTY26N0325500CE", "side": "SELL", "quantity": 65, "entry": 60.0 }
```
`quantity` in units (lots × lot size at creation, kept so a later lot revision does not change the position). `entry` per unit, > 0. Futures legs allowed (`NFO:NIFTY26NOVFUT`). No account id is stored.

**Bus topic `option.alert`** (payload safe to log; no account id, key id or token):
```json
{ "fireId": "af_1a2b3c4d5e6f7a8b", "seq": 1042, "alertId": "al_9f2c1a7b3d4e5f60", "name": "NIFTY breaks 25,200",
  "at": "2026-10-29T10:15:02.640+05:30", "severity": "info", "tags": ["breakout"], "underlying": "NIFTY",
  "match": "all", "repeat": { "mode": "every", "minutes": 15 }, "nextEligibleAt": "2026-10-29T10:30:02+05:30",
  "conditions": [ { "id": "c1", "text": "NIFTY spot crossed above 25,200", "value": 25212.35, "threshold": 25200,
                    "unit": "points", "source": "stream", "asOf": "2026-10-29T10:15:02.004+05:30", "quality": "live" } ],
  "targets": null, "shareAmounts": false, "test": false, "simulated": false, "demo": false,
  "owner": "local", "link": "/dashboard#/alerts?fire=af_1a2b3c4d5e6f7a8b" }
```
`owner` is `"local"` or `"key"` (never the key id) and is used only by the stream filter, which looks up the rule. For strategy conditions with `shareAmounts: false`, `value`/`threshold` are replaced by `null` and `text` reads "Strategy "Short strangle" P&L fell below your loss level" (§3.9).

**Fire record** (one line in the fire log; the API returns it with ISO times):
```json
{ "v": 1, "seq": 1042, "id": "af_1a2b3c4d5e6f7a8b", "alertId": "al_9f2c1a7b3d4e5f60", "ruleVersion": 3,
  "at": 1761713102640, "name": "NIFTY breaks 25,200", "owner": "local", "severity": "info", "tags": ["breakout"],
  "underlying": "NIFTY", "match": "all", "conditions": [ "…as in the bus payload, but values always kept…" ],
  "latency": { "dataToFireMs": 636, "path": "stream" },
  "delivery": { "inApp": true, "targets": ["phone"], "wouldSendTo": null },
  "test": false, "simulated": false, "demo": false }
```
The fire log keeps the real values even when `shareAmounts` is false: it is the owner's local store (BRD §5.1). Only outbound messages hide amounts.

### 3.5 Storage on disk

```
<dataDir>/alerts/                 mode 0700 (demo: <dataDir>/alerts-demo/, same layout; demo reads and writes ONLY there)
  rules.json                      { "version": 1, "rules": [AlertRule minus runtime] }        writeFileAtomic, 0600
  state.json                      { "version": 1, "seq": 1042, "rules": { "<id>": RuleState }, "inbox": { "<owner>": { "readSeq": 1040 } } }
  fires/2026-10.jsonl             append-only, one fire per line, IST month
```
- **RuleState**: `{ status, combined: true|false|null, lastFiredAt, firedDay, firesToday, nextEligibleAt, pendingEdge, conditions: { "<cid>": { latch, lastValue, lastAt, crossAt, holdSince } } }`. It is flushed at most every 5 s and on every fire, so a restart never repeats a fire that was already logged. A fire is first appended to the fire log, then the state is flushed, then the bus event is emitted. On start, any fire in the log newer than `state.seq` is applied to state (crash between append and flush).
- **Size:** 500 rules × ~2 KB = 1 MB for `rules.json`. A fire is about 600 bytes. At 1,000 fires/day that is about 13 MB per month before retention.
- Torn last line in a fire log: skipped and counted (`status().store.corruptLines`). The next append starts on a new line (the P1-1 rule). A corrupt `rules.json` or `state.json` is renamed `*.corrupt-<ts>`, and the module starts empty for that file with a `config.warning` bus event and a status banner. Rules are never silently dropped one by one: a file is valid or it is set aside whole (BRD §7.7).
- No secrets, tokens, account ids or broker client codes are stored. A test greps every file for token patterns (§10.1).
- Migration hook: `store.migrate(raw)` maps `version` → current (only `1` exists).

### 3.6 Config (`alerts` section, all optional; zod `.strict()`)

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | `false`: routes answer, rules can be edited, nothing is evaluated (status says "Alerts are off in config"). |
| `maxActive` | `500` | 1–2,000. Rules with `enabled: true` and status not `expired`/`fired`/`disabled`. |
| `maxPerOwner` | `200` | 1–2,000. |
| `evalIntervalMs` | `1000` | 250–5,000. |
| `stream.enabled` | `true` | |
| `stream.share` | `0.15` | 0–0.5. Fraction of the feed account's `feed.maxConnections × maxSubscriptions` alerts may hold. |
| `poll.enabled` | `true` | |
| `poll.everySeconds` | `30` | 10–300. |
| `poll.maxSymbols` | `200` | Poll-path symbols per account. Beyond it the condition is `waiting_data` "too many polled symbols". |
| `poll.maxChainsPerMinute` | `2` | 0–6. Chain reads for chain inputs the recorder does not cover. |
| `poll.headroomFloor` | `0.5` | Skip a poll when the class's remaining window budget is below this share (§7.3). |
| `recorderMaxAgeSeconds` | `90` | Older recorder data counts as stale. |
| `staleSeconds` | `{ "stream": 15, "recorder": 150, "poll": 90, "vol": 1800, "exposure": 180 }` | Input older than this is stale. `blind` after 30 s of staleness in session. |
| `volRankEverySeconds` | `300` | 60–3,600. |
| `crossMemorySeconds` | `60` | How long a cross counts as true for `all` rules (recorder-path conditions use max(this, 90)). |
| `sanity` | `{ "maxJumpPct": 5, "confirmMs": 3000 }` | Bad-tick filter (§6.15). |
| `fireLog.retentionDays` | `400` | 30–3,650. |
| `inbox.keep` | `200` | Fires kept in memory per owner for the inbox. |
| `notifyBlind` | `false` | When true, a rule entering `blind` sends one `option.alert` with `kind: "blind"` (deduped per rule per day). |

Demo defaults (`demoMode.mjs`): market always open, `poll.everySeconds: 10`, folder `alerts-demo/`, samples on (§5).

### 3.7 Evaluation pipeline (one rule)

1. For each condition: `input = feeds.get(key)`. Missing → `truth: null, reason: WAITING_DATA` with detail. Stale → `truth: null, reason: STALE`.
2. `metrics.*` computes the value (§6). Then `engine.evalCondition` applies the op, the hysteresis latch, the cross memory and the hold.
3. `combine(match, truths)`: `all` → `true` only if every truth is `true`; `false` if any is `false`; otherwise `null`. `any` → `true` if any is `true`; `false` if all are `false`; otherwise `null`.
4. Edge: `fire candidate` when `combined` goes from `false`/`null` to `true`.
5. `gate(repeat)` (§6.14) decides whether the edge fires now, waits (`pendingEdge`), or is ignored.
6. Fire: build texts (`metrics.describe`), append to S7, flush state, emit `option.alert`, update the inbox. Status becomes `fired` (once), `cooldown` (every) or stays `armed` (daily, with `firedDay` set).

### 3.8 Ownership and keys

- A key sees and edits only its own rules; `local` and admin keys see all (scanner `owns()` pattern, reused from `scanner/routes.mjs` by moving `seesAll`/`owns` to `core/ownership.mjs`, lead).
- `key.revoked` → that owner's rules become `disabled` (`reason: "KEY_REVOKED"`). An expired key's rules keep running until the owner deletes them (expiry is not revocation), except the `ui` sign-in keys, whose rules are owned by `local` anyway.
- Subjects are market data only. A rule never names an account, so an account-restricted key cannot use alerts to read another account's positions. Strategy legs are supplied by the caller.

### 3.9 Notify changes (S15)

**`wants(t, "option.alert", p)`** = `t.events.includes("option.alert")` and (`p.targets === null` or `p.targets.includes(t.id)`) and (`!t.alertTags` or tags intersect) and (`!t.alertSeverities` or includes `p.severity`) and (`!t.alertUnderlyings` or includes `p.underlying`). `p.test === true` bypasses the tag/severity/underlying filters (a test reaches every chosen target).

**Message** (`format.mjs`, pure; every user text clipped):
```
title: [Demo] [Test] Alert: NIFTY breaks 25,200
text:  NIFTY spot crossed above 25,200 (now 25,212.35 · stream · 10:15:02 IST)
       Repeats at most every 15 min (next from 10:30).
```
- Prefixes `[Demo]`, `[Test]`, `[Simulated]` when the flags are set. A `high` severity prefixes `[High]`.
- `any` rules list only the conditions that are true. `all` rules list all of them.
- Strategy conditions with `shareAmounts: false`: no rupee figures and no leg prices. Strike numbers and spot are shown ("Short 25,500 CE is 0.47 % from spot"), because they are not account data. BRD §7.9: "strategy names and P&L only by user choice."
- IVR partial: "(partial: 34 of 252 days)". GEX wall: appends "Modelled from open interest under the selected assumption."
- Never included: account id, broker client code, key id, order ids, the Bridge URL with a key. `link` is a relative path, so a message shows no host.
- Webhook body: `{ event: "option.alert", title, text, at, data: <bus payload> }`, signed as today.

**Merge in `pump()`:** before `deliver(head)`, if `head.topic === "option.alert"`, take further queued `option.alert` items (≤ 9 more, in order) into one message: title "3 alerts fired", text = one line per fire (`name: first condition text`), and the webhook `data.fires: [...]`. Other topics are never merged. This keeps a burst inside Telegram's pacing without dropping anything.

---

## 4. API changes

All routes: module `alerts`, `x-stream: S24`, JSON `{ data, meta }`, Problem errors as today, demo labelling as today (`meta.demo`). Units: prices in ₹ or index points as the instrument trades; IV in vol points; OI in **units** (BRD §5.1) with `lots` alongside where a lot size is known; P&L in ₹; times ISO-8601 `+05:30`.

### 4.1 Route table

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/v1/alerts` | read | List rules visible to the caller, with runtime |
| POST | `/v1/alerts` | **paper** | Create a rule (`?dryRun=1`: validate and evaluate now, store nothing) |
| GET | `/v1/alerts/catalog` | read | Metrics, subjects, ops, params, units, default hysteresis, latency classes, availability on this Bridge |
| GET | `/v1/alerts/status` | read | Counts, caps, paths, stream and poll usage, loop timing, store health, notify coverage |
| GET | `/v1/alerts/fires` | read | Fire log (cursor, `from`/`to`, `alertId`, `format=csv`) |
| GET | `/v1/alerts/inbox` | read | Unread count and latest fires for the caller's owner |
| POST | `/v1/alerts/inbox/read` | read | Mark read up to a `seq` (per-owner UI state only) |
| GET | `/v1/alerts/{alertId}` | read | One rule |
| PATCH | `/v1/alerts/{alertId}` | **paper** | Edit fields, or `action`: `pause` \| `resume` \| `rearm` |
| DELETE | `/v1/alerts/{alertId}` | **paper** | Delete |
| POST | `/v1/alerts/{alertId}/test` | **paper** | Send a test fire (`test: true`) through in-app and the chosen targets; nothing is evaluated or stored in rule state. `?preview=1` returns the formatted message text per target and sends nothing (used in demo) |
| POST | `/v1/demo/alerts/simulate` | read | Demo mode only (registered only when `config.demo`; `loopbackOnly`) |

`paper` scope for writes follows BRD §5.6 ("alerts, guards and journal writes need `paper` scope"). No alert can reach an order this round, so `live` is never required. The dashboard sign-in key holds `admin` + `paper`. Write routes are covered by P1-5's generic CSRF and scope tests (T-sec-1/2) with no extra work.

### 4.2 Common errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Schema errors, with `errors: [{ path, message }]`: unknown metric/op for a subject, > 5 conditions, `between` with lo ≥ hi, unknown target id, multi-expiry legs on `breakeven`, `actions` not empty, `time` value not `HH:MM`/ISO, expired contract, non-option symbol for `iv`/`greek` |
| 401/403 | `UNAUTHENTICATED`, `SCOPE_REQUIRED` | As today (`paper` for writes) |
| 404 | `NOT_FOUND` | Unknown rule, or a rule owned by another key (same answer, no leak) |
| 404 | `SYMBOL_NOT_FOUND` | A subject symbol does not resolve (`symbols.resolve`) |
| 409 | `VALIDATION_FAILED` with `errors[0].path = "version"` | `PATCH` with `ifVersion` that does not match (optimistic concurrency between two tabs) |
| 422 | `ALERT_LIMIT` | `maxActive` or `maxPerOwner` reached on create, resume or rearm. `detail` names the limit and the count |
| 422 | `CAPABILITY_UNSUPPORTED` | The metric needs a module this Bridge does not have (IVR without P1-3, `gex` walls without P1-8). `detail` says which |
| 429 | `RATE_LIMITED` | Client limiter, as today |

### 4.3 `POST /v1/alerts`

Request (all fields of AlertRule except `id`, `version`, `owner`, `runtime`, timestamps; `name` optional and generated from the first condition when absent):
```json
{
  "match": "any",
  "conditions": [
    { "metric": "short_strike_distance",
      "subject": { "kind": "strategy", "label": "Short strangle 3 Nov",
                   "legs": [ { "symbol": "NFO:NIFTY26N0325500CE", "side": "SELL", "quantity": 65, "entry": 60.0 },
                             { "symbol": "NFO:NIFTY26N0324800PE", "side": "SELL", "quantity": 65, "entry": 55.0 } ] },
      "op": "below", "value": 0.5, "params": { "unit": "sigma" } },
    { "metric": "strategy_pnl", "subject": { "kind": "strategy", "ref": "c1" }, "op": "below", "value": -3000 }
  ],
  "repeat": { "mode": "daily" },
  "severity": "warn",
  "shareAmounts": false,
  "origin": { "page": "positions", "context": "group" }
}
```
- `subject.ref: "c1"` reuses another condition's strategy subject (no duplicate legs).
- 201 → `{ data: AlertRule (with runtime evaluated once), meta }`, `Location: /v1/alerts/al_…`.
- `?dryRun=1` → 200 with the same body, `id: null`, nothing stored. The form uses it for the live "now" line.
- Dedupe: an identical rule (same canonical JSON of match + conditions + repeat for the same owner) returns 200 with the existing rule and `meta.duplicate: true`. This makes "alert me" taps idempotent.

### 4.4 `GET /v1/alerts`

Query: `status` (repeatable), `underlying`, `tag`, `metric`, `limit` (1–500, default 100), `cursor`. Response `{ data: { items: AlertRule[], nextCursor, counts: { active, byStatus: { armed: 41, … } }, cap: { maxActive: 500, maxPerOwner: 200 } }, meta }`. No broker call; p95 ≤ 30 ms at 500 rules.

### 4.5 `PATCH /v1/alerts/{alertId}`

Body: any of `name`, `note`, `match`, `conditions`, `repeat`, `severity`, `tags`, `targets`, `shareAmounts`, `expiresAt`, `enabled`, or `{ "action": "pause" | "resume" | "rearm" }`, plus optional `ifVersion`. Changing `conditions` or `match` resets that rule's latches (as a new rule; a level already true fires on the next evaluation if the repeat gate allows). `version` increments. Response: the rule.

### 4.6 Catalog, status, fires, inbox

`GET /v1/alerts/catalog`:
```json
{ "data": {
    "metrics": [
      { "metric": "price", "subjects": ["spot","future","contract"], "ops": ["above","below","between","outside","crosses_above","crosses_below"],
        "params": { "basis": { "enum": ["ltp","mid","bid","ask"], "default": "ltp" } }, "unit": "price",
        "hysteresis": { "default": "0.05 % of the threshold (spot/future); max(0.5 %, 2 ticks) (options)" },
        "latency": "stream", "available": true },
      { "metric": "ivr", "subjects": ["spot"], "latency": "vol", "available": false, "reason": "NEEDS_VOL_STORE",
        "detail": "IV Rank needs the volatility store (P1-3)." }
    ],
    "latencyClasses": { "stream": "usually under 5 s", "recorder": "within about 70 s", "poll": "within about 35 s",
                        "vol": "within about 5 min", "exposure": "within about 100 s", "clock": "within 2 s" },
    "limits": { "maxConditions": 5, "maxLegs": 12, "maxActive": 500, "maxPerOwner": 200 },
    "notify": { "targetsListening": ["phone"], "demo": false } },
  "meta": {} }
```
`notify.targetsListening` lists target **ids** only and only for admin/local callers (others get a count).

`GET /v1/alerts/status`: `{ enabled, demo, session: { open, nextOpen }, counts, cap, paths: { stream: 37, recorder: 9, poll: 2, vol: 3, exposure: 1, clock: 4, unavailable: 0 }, stream: { account, held: 61, allowed: 3750, rejected: 0 }, poll: { account, symbols: 2, callsLastMinute: 2, skippedForHeadroom: 0 }, loop: { p50Ms, p95Ms, lastAt }, store: { rules, firesThisMonth, bytes, corruptLines }, latency: { stream: { n, p50Ms, p95Ms }, recorder: { … } }, warnings: [] }`. `latency` is measured `dataToFireMs` over the last 500 fires per path, which is how the BRD figure is watched in production.

`GET /v1/alerts/fires`: query `from`, `to` (default: last 7 days; max 93-day span), `alertId`, `limit` (≤ 500), `cursor`, `format=json|csv`. CSV columns: `at,alertId,name,severity,tags,condition,value,threshold,unit,source,asOf,test,demo` (one row per condition). Filename `alerts-fires-2026-10-22-2026-10-29.csv`.

`GET /v1/alerts/inbox?since=<seq>`: `{ data: { unread: 3, readSeq: 1039, items: [Fire (latest 20, or after since)] } }`. `POST /v1/alerts/inbox/read` `{ "upTo": 1042 }` → `{ readSeq: 1042, unread: 0 }`. Scope `read`: this is per-owner UI state, bounded and harmless.

### 4.7 `POST /v1/demo/alerts/simulate` (demo only)

Body: `{ "kind": "wall_shift" | "price" | "pcr" | "iv" | "oi_change" | "straddle" | "strategy_pnl" | "ivr", "underlying": "NIFTY", "alertId"?: "al_…", "seconds"?: 60 }`. The simulator overlays a synthetic input value on the matching InputKey(s) for `seconds` (default 60) so the rule's condition becomes true. With `alertId`, the value is chosen to satisfy that rule's condition. Without it, a typical move is used (wall moves 2 steps up; PCR −0.15; IV +1.5 vol points). Fires carry `simulated: true`, and the UI and messages say "[Simulated]". It returns `{ inputs: [InputKey], until }`. Answers 404 outside demo.

### 4.8 `/v1/stream` and MCP

- WS op `{ "op": "subscribe_alerts" }` / `{ "op": "unsubscribe_alerts" }`. Message `{ "type": "alert", "seq": 88, "fire": <bus payload> }`, only for fires of rules the key may see. SSE: `alerts=1`. AsyncAPI version bump, message and op schemas mirror the scan ones.
- MCP `get_alerts` (read toolset): `{ status?, underlying?, firesLimit? (≤ 50) }` → rules (runtime included) + recent fires. The description states that alerts notify only and that creating them is done in the dashboard or REST.

### 4.9 `docs/openapi.yaml` additions

Tag `Alerts`. Paths follow the disciplined layout read by `core/openapi.test.mjs` (`x-stream`, `x-scope`, `x-loopback-only`). Abbreviated; the lead applies the full text:

```yaml
  /v1/alerts:
    get:
      tags: [Alerts]
      operationId: listAlerts
      summary: Alert rules visible to this key, with their current state
      x-stream: S24
      x-scope: read
      parameters:
        - { name: status, in: query, schema: { type: array, items: { $ref: "#/components/schemas/AlertStatus" } }, style: form, explode: true }
        - { name: underlying, in: query, schema: { type: string, pattern: "^[A-Z0-9&-]{1,30}$" } }
        - { name: tag, in: query, schema: { type: string } }
        - { name: metric, in: query, schema: { $ref: "#/components/schemas/AlertMetric" } }
        - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 500, default: 100 } }
        - { name: cursor, in: query, schema: { type: string } }
      responses:
        "200": { description: Rules., content: { application/json: { schema: { $ref: "#/components/schemas/AlertListEnvelope" } } } }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }
    post:
      tags: [Alerts]
      operationId: createAlert
      summary: Create an alert rule (notify only; alerts never place orders)
      x-stream: S24
      x-scope: paper
      parameters:
        - { name: dryRun, in: query, schema: { type: boolean, default: false } }
      requestBody: { required: true, content: { application/json: { schema: { $ref: "#/components/schemas/AlertRuleInput" } } } }
      responses:
        "201": { description: Created., content: { application/json: { schema: { $ref: "#/components/schemas/AlertEnvelope" } } } }
        "200": { description: Dry run, or an identical rule already exists (meta.duplicate)., content: { application/json: { schema: { $ref: "#/components/schemas/AlertEnvelope" } } } }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }

  /v1/alerts/catalog:      { get: listAlertCatalog,  x-scope: read }
  /v1/alerts/status:       { get: getAlertStatus,    x-scope: read }
  /v1/alerts/fires:        { get: listAlertFires,    x-scope: read, text/csv alternative }
  /v1/alerts/inbox:        { get: getAlertInbox,     x-scope: read }
  /v1/alerts/inbox/read:   { post: markAlertsRead,   x-scope: read }
  /v1/alerts/{alertId}:    { get: getAlert (read), patch: updateAlert (paper), delete: deleteAlert (paper) }
  /v1/alerts/{alertId}/test: { post: testAlert,      x-scope: paper }
  /v1/demo/alerts/simulate:  { post: simulateDemoAlert, x-scope: read, x-loopback-only: true }   # demo-only allowlist in openapi.test.mjs (as /v1/demo/feed)
```

Schemas (all `additionalProperties: false` on inputs; outputs documented as open for new fields):
- `AlertMetric`: enum `price, iv, ivr, ivp, oi_change, pcr, wall, greek, straddle, strategy_pnl, short_strike_distance, breakeven, time` (documented as open).
- `AlertOp`: enum `above, below, between, outside, crosses_above, crosses_below, changes, at, breached`.
- `AlertStatus`: enum `armed, waiting_data, blind, market_closed, cooldown, fired, paused, expired, disabled`.
- `AlertSubject`: `oneOf` spot / future / contract / chain / strategy (`legs` maxItems 12, or `ref`) / clock, discriminator `kind`.
- `AlertCondition`, `AlertRuleInput` (`conditions` minItems 1 maxItems 5; `actions` maxItems 0), `AlertRule` (adds `id`, `version`, `owner`, `runtime`, timestamps), `AlertRuntime`, `AlertFire`, `AlertCatalog`, `AlertStatusReport`, `AlertInbox`, envelopes.
- `ErrorCode` enum += `ALERT_LIMIT` (the test compares it with `core/errors.mjs`).
- Units in descriptions: `oi_change.value` in units, lots or percent per `params.unit`; `iv` in vol points; `strategy_pnl` in ₹.

---

## 5. Demo mode

Goal: `mc-bridge start --demo`, open `#/alerts`, and within 10 minutes see sample alerts fire with real demo data, create one from a chain cell, and fire every condition kind on demand. Nothing touches the network or the real data folder.

**What already moves in demo** (no change made here): spot and futures (`spotAt`: slow waves plus 53-, 11- and 1.6-minute wiggles of about ±0.24 %, ±0.11 % and ±0.04 %); option prices; **contract IV** (the smile is in moneyness, so a fixed strike's IV changes as spot moves: sticky-moneyness, about 0.1–0.4 vol points per 0.25 % move near the money); straddles (spot and time decay); strategy P&L and Greeks; short-strike distances; time. With P1-1 M13: time-varying **OI**, so ΔOI and PCR move intraday. With P1-3: IVR/IVP from 300 seeded days, and `demoPartial=1` for the partial state. With P1-8: walls fixed intraday and moving day to day, by design.

Changes in this item:

1. **`alerts/demoAlerts.mjs` `seedSamples(now)`** (first demo start, or when `alerts-demo/rules.json` is missing). It reads the demo future path, `spotAt("NIFTY", now + k·10 s)` for k = 1…120 (20 minutes), and picks:
   - **"Sample: NIFTY crosses up"**: `price` spot `crosses_above` T, where T = the first local maximum of the path within 2–10 minutes minus 30 % of the rise to it from now, rounded to 0.05. If the path only falls in that span, use `crosses_below` mirrored. Repeat `every 15`. Deterministic: same start instant → same threshold.
   - **"Sample: ATM straddle below X"**: `straddle` chain NIFTY front `below` = current straddle − 0.4 % (time decay plus spot movement cross it within minutes on most instants; checked in the test over 50 random instants, ≥ 45 fire within 15 min).
   - **"Sample: time reminder"**: `time` `at` the next whole 5 minutes from start (demo is always open), repeat `daily`.
   Each sample has tag `sample`, a "Sample" chip in the UI and the note "Created by demo mode. Thresholds were picked from the demo price path so it fires within minutes." Users can delete them, and they are not re-created once deleted (marker in `state.json`).
2. **Simulate route** (§4.7) for the kinds the demo market does not move fast enough: wall shift (sticky intraday by P1-8 design), IVR (daily), and a large ΔOI. The Alerts page in demo shows a "Simulate" menu on each rule row ("Make this condition true for 60 s") and in the empty state.
3. **Delivery preview:** notify is off in demo. Every demo fire computes `delivery.wouldSendTo` from the config's targets and filters (tested), and the fire detail shows "Not sent: notifications are off in demo mode. Would go to: phone, n8n." The form's **Test** button shows the exact formatted message text in a preview block (from `POST /v1/alerts/{id}/test?preview=1`, same formatter; nothing is sent) instead of sending.
4. **Demo positions for strategy alerts:** the Positions page "Alert" action works on the paper book. The guide's demo walkthrough places a paper short strangle on `demo-paper` first (as in P1-4), then creates "short strike within 0.5σ" and "P&L below −₹1,500" from the group header.
5. **Paths in demo:** the demo feed is a stream (P1-4 cadence: ATM about 4 ticks/s, far wings 13–30 s). So demo rules show the stream path for near strikes, and far wings show `blind`/stale handling naturally when `staleSeconds.stream` (15) is exceeded between ticks. To keep far-wing alerts usable, demo raises `staleSeconds.stream` to 40 (in `demoMode.mjs` defaults, stated in the status).
6. **Folder:** `dataDir/alerts-demo/`. Real `alerts/` is never read in demo.

---

## 6. Dashboard

### 6.1 Placement

- New page **Alerts** `#/alerts` in the Options group after Positions (`views.js` page entry, icon `bell`, `layout: "desk"`, sub "Alerts on prices, IV, OI, levels and your strategies. Evaluated on this computer, even with the browser closed").
- **Toolbar bell** `#toolbar-alerts` (after the readiness badge when P1-5 is present): `icon-btn` with the `bell` icon and a count `pill` (hidden at 0; "9+" above 9). Click → `sheetPopover` (desktop/tablet) or bottom sheet (phone) with the latest 10 fires (name, first condition text, time, "Demo"/"Test"/"Simulated" chips), "Mark all read" and "Open Alerts".
- **Toasts:** `toast("Alert: NIFTY breaks 25,200 · crossed above 25,200")` for each new fire while any page is open (merged as "3 alerts fired" within 2 s). Screen readers: the toast region is `aria-live="off"` unless the user turns on **Announce alerts** (Alerts page settings, stored in `localStorage` key `mcb.alerts.announce`, try/catch), then `polite` (BRD §7.4).
- **Inbox transport:** when `stream-client.js` (P1-4) is present, `subscribe_alerts` on the tab's socket. Otherwise `GET /v1/alerts/inbox?since=` every 15 s while the tab is visible and every 60 s when hidden. Both are local calls with no broker cost.

### 6.2 Alerts page (`alerts-page.js`)

Sections, top to bottom:
1. **Status strip:** "Active 41 of 500" · path counts ("Live stream 37 · Recorder 9 · Polling 2") · "Notifications: phone, n8n" or a `warn` pill "No notification target listens to alerts. Add option.alert in notify settings (guide)" · demo note. `blind` or `disabled` rules make a `warn` pill "2 alerts cannot see fresh data" that filters the list.
2. **Toolbar:** `segmented` Rules | Fired; filters (status, underlying, tag) as chips; "New alert"; "Export CSV" (Fired tab); settings (Announce alerts).
3. **Rules list:** desktop table with columns Name (+ tags), Conditions (phrase, e.g. "NIFTY spot crosses above 25,200 · and · PCR (OI) below 0.80"), Now (live value and distance, "25,148.20 · 0.21 % away"), Status (`pill`: armed ok / waiting warn / blind bad / fired / paused / expired), Path ("Live stream · under 5 s"), Repeat, Last fired, actions (⋯ menu: Edit, Pause/Resume, Re-arm, Test, Duplicate, Delete, demo: Simulate). Values refresh every 5 s from `GET /v1/alerts` while visible (local call).
4. **Fired tab:** timeline grouped by IST day: time, name, condition texts with value, source and age ("stream, 0.6 s after the tick"), chips; click → detail sheet (all conditions, delivery targets or "would send to", rule link, method notes for IV/Greeks/walls). Unread rows carry an "Unread" text chip (not colour alone). Opening the tab marks read.
5. **Empty state** (`emptyState("bell", …)`): "No alerts yet. Tap Alert… on any chain cell, OI tile, IV Rank, position group or strategy, or create one here." Buttons: "New alert", demo: "Add the samples back".

### 6.3 Alert form (`alert-form.js`)

`openAlertForm({ context, rule?, onSaved })` opens a `modal` at ≥ 720 px and a bottom sheet below it (as `chain-sheet.js`). `alerts-model.formModel(context)` pre-fills subject, metric, op and a threshold from the context:
- **Context → default:** chain cell price → `price` contract `crosses_above` at the next round level above the mid (ask side tapped) or `crosses_below` (bid side); chain IV cell → `iv` `above` current + 1 vol point; OI/ΔOI cell → `oi_change` 15m `above` 10 %; Greek cell → `greek` delta `above` 0.5 (calls) / `below` −0.5 (puts); summary PCR tile → `pcr` `crosses_below` 0.8 or `crosses_above` 1.2 (whichever is nearer); wall tile → `wall` `changes`; straddle tile → `straddle` `below` current − 5 %; IVR tile → `ivr` 252 `above` 80 or `below` 20 (whichever is nearer); positions group → strategy with the group's open legs and average prices, condition `short_strike_distance` `below` 0.5σ plus `strategy_pnl` `below` −2 % of the group's absolute entry premium (rounded to ₹100), `match: any`; builder → the builder's legs and entries, same pair; exposure level → `price` spot `crosses_*` the level.
- **Layout:** Name (auto from the phrase, editable) · up to 5 condition rows (subject chip, metric `select`, op `select`, value input with unit and a step from the metric, params row: basis/window/side/strikes/greek/unit; per row "now: 25,148.20 · 0.21 % away" from `?dryRun=1`, refreshed every 3 s while open) · "Add condition" (disabled at 5) · Match `segmented` "All of these | Any of these" (shown from 2 conditions) · Repeat `segmented` Once | Once a day | At most every [N] min · Severity · Notify: "All targets" or checkboxes (target ids from the catalog; non-admin: "All targets") · Share amounts toggle (strategy only; off by default; help text "Off: messages say that your loss level was crossed but show no rupee amounts") · Expires (date, optional; contract rules default to the contract's expiry) · Advanced (hysteresis, hold seconds), collapsed.
- **Footer:** path and latency line ("Live stream · usually under 5 s"), honesty notes from `dryRun` (e.g. "IV Rank partial: 34 of 252 days"; "Legs as saved now; later trades are not included"), buttons Save · Test (sends a test, or in demo shows the message preview) · Cancel.
- Validation mirrors the server (`alerts-model.validateDraft`). Server errors map to the field path.
- Keyboard: every control reachable, Enter saves, Esc closes, focus returns to the trigger. Touch targets ≥ 44 px. Numbers are typed (no drag-only input).

### 6.4 Entry points ("alert me when…")

| Page | Where | Context passed |
|---|---|---|
| Option Chain (`chain-sheet.js`) | Action sheet button row: "Alert…" next to Buy/Sell; also in the row's ⋯ menu on desktop | `{ page: "chain", symbol, side, strike, field: "price"\|"iv"\|"oi"\|"delta", mid, iv, oi, lot }` |
| Option Chain summary strip (`desk.js`) | ⋯ on the PCR, straddle/expected-move, max pain and OI-wall tiles | `{ page: "chain", kind: "pcr"\|"straddle"\|"wall", underlying, expiry, value }` |
| OI Analysis (`oi.js`) | ⋯ on the walls, PCR and build-up tiles, and per-strike row menu (ΔOI) | as above, plus `window` |
| Volatility (`vol.js`) | IVR/IVP tile ⋯ "Alert on IV Rank" | `{ kind: "ivr", underlying, lookback, value }` |
| Positions (`positions.js`) | Group header actions: "Alert" next to "Exit group" | `{ page: "positions", legs (open legs: symbol, side, qty, avg), label: groupTitle }` |
| Strategy Builder (`strategy.js`) | Toolbar "Alert" (enabled when ≥ 1 leg has an entry) | `{ page: "strategy", legs, label: preset name }` |
| Exposure (P1-8 present) | Level tiles ⋯ | `{ kind: "level", level: "callWall"\|…, underlying, value }` |

Each entry point is one button and one `openAlertForm` call. A chain-cell alert on a contract the recorder does not cover and the feed cannot hold says so in the form footer ("Polling every 30 s · within about 35 s").

### 6.5 Phone, tablet, desktop

| Width | Alerts page | Form | Bell |
|---|---|---|---|
| < 720 px (phone, from 360) | Rules as cards (name, phrase, now-value line, status pill, ⋯), one column; Fired as a list; the status strip wraps to two lines; filters in a sheet | Full-height bottom sheet; condition rows stack (subject, then metric+op, then value); sticky Save bar | Opens a bottom sheet; count on the icon |
| 720–1099 px (tablet) | Table with Name, Conditions, Status, Last fired; Now and Path move into the row's second line | Modal 640 px wide | Popover |
| ≥ 1100 px (desktop) | Full table; Fired tab opens a right-side detail panel (as the chain sheet) | Modal 720 px | Popover |

16-px gutter, no horizontal page scroll. The rules table scrolls inside its own card with a sticky Name column (BRD §7.3).

### 6.6 Accessibility and copy

- Status is text plus `pill` class, never colour alone. Distances carry signs. Severity is a word.
- Every condition phrase is plain and descriptive: "crosses above", "is below", "changes strike". The copy never says "buy", "sell", "signal", "bullish", "bearish", "rich" or "cheap" (a test greps `alerts-model.js` and `format.mjs` strings; BRD §8.1).
- Method notes (K3 hovers) for IV ("Black-76 on the parity forward; T from the vol-time clock"), Greeks, PCR (strikes covered), walls (basis), IVR (lookback, partial), ΔOI (reference snapshot time).
- K5: CSV export of fires.

---

## 7. Rate-limit budget

### 7.1 Rules (enforced in `feeds.mjs`; tested in `feeds.test.mjs`)

1. **Stream first.** Subscriptions as hub client `"alerts"` in `quote` mode (for bid/ask/OI), capped at `floor(stream.share × feedCap)` for the feed account (counting only symbols the recorder does not already hold, since hub reference counting makes those free; recorder 60 % + alerts 15 % is the background ceiling that P1-1 §11 and P1-4 §8.2 assume), where `feedCap = feed.maxConnections × feed.maxSubscriptions` from `scheduler.policyFor()`. Symbols are ranked by how many rules need them (then by creation time), and the top ones get stream slots.
2. **Recorder second.** An input on a chain the recorder records is read from its in-memory latest snapshot on `recorder.snapshot` (0 broker calls). Contracts inside the recorded strikes use it when they have no stream slot.
3. **Poll last.** `marketData.quotes` at `priority: "background"` with `maxAgeMs: 20_000` (served from the freshness cache when a page or the recorder read it recently: 0 calls). One batched call per account per `poll.everySeconds`. Chain inputs without recorder coverage: `optionChain` at background priority, `maxAgeMs: 60_000`, ≤ `poll.maxChainsPerMinute`.
4. **Headroom floor.** Before a poll call: `h = scheduler.headroom(accountId, class)`. Skip (and count `skippedForHeadroom`) when `h.remaining < headroomFloor × h.limit`. Alerts therefore never take the second half of any window, and user calls (`interactive`) always go first in the scheduler queue anyway.
5. **Account choice.** Market data only, through `marketData` (pooling rules unchanged). Never pinned to another holder's account.
6. **No polling outside the session.** Values are frozen then, and the rule shows `market_closed`.
7. Vol rank, exposure levels and the clock cost no broker calls.

### 7.2 Worked budgets (default config)

| Broker (policy) | Feed cap → alerts stream slots | Poll: quotes class | Alerts poll use | Chain fallback (no recorder) |
|---|---|---|---|---|
| Dhan (quote 1/s shared with depth; batch 1,000; feed 5×5,000) | 25,000 × 0.15 = **3,750** | 60/min | 2/min (batch ≤ 200 symbols) = 3.3 % | chain 20/min (unverified): 2/min = 10 % |
| Zerodha (quote/depth/chain 1/s shared; batch 500; feed 3×3,000) | 9,000 × 0.15 = **1,350** | 60/min | 2/min = 3.3 % | chain built from 1–2 quote calls: ≤ 4/min = 6.7 % of the shared class |
| Upstox (standard 50/s, 500/min shared; batch 500; feed 2×2,000 full) | 4,000 × 0.15 = **600** | 500/min | 2/min = 0.4 % | ≤ 2/min = 0.4 % |
| Demo (quote 10/s, 400/min; feed 1×500) | 500 × 0.15 = **75** | 400/min | 6/min (10-s poll) = 1.5 % | ≤ 2/min |

**Worst case at the cap:** 500 rules, average 1.6 distinct symbols each after sharing, gives about 800 symbols. That fits Dhan's and Zerodha's alert stream slots. On Upstox 600 are streamed and up to 200 are polled. Beyond that, conditions show `waiting_data` "too many polled symbols (200 is the limit)".

### 7.3 Interaction with the recorder's 50 %

The recorder holds its own ≤ 50 % REST share (P1-1 `budget.mjs`), and alerts add at most the figures above, so total background could exceed 50 % of a window on Zerodha (recorder 50 % + alerts 6.7 % chain fallback). Rule 4 prevents this in practice, because alerts skip any call when more than half the window is used. Rule 2 means that a chain the recorder covers is never polled. A shared background accountant is LATER (§2.2), and this is listed as risk R3.

### 7.4 Latency budgets

| Path | Steps | Worst typical | BRD |
|---|---|---|---|
| Stream | tick → bus (sync) → dirty → loop ≤ 1,000 ms → eval ≤ 20 ms → S7 append ≤ 5 ms → bus → notifier queue → pacing wait 0–1,100 ms (Telegram) → HTTP 200–1,500 ms | ≈ 3.6 s | p95 ≤ 5 s |
| Recorder | condition true just after a slot read → next slot (60 s) + `slotOffsetMs` 2 s + snapshot build ≤ 2 s → `recorder.snapshot` → latest read ≤ 20 ms → loop ≤ 1 s → delivery ≤ 2.6 s | ≈ 67.6 s | p95 ≤ 70 s |
| Poll | ≤ 30 s interval + call ≤ 1 s + loop 1 s + delivery 2.6 s | ≈ 34.6 s | (stated per rule) |
| Exposure (gex wall) | recorder slot ≤ 64 s + P1-8 coalescing ≤ 30 s + loop + delivery | ≈ 98 s | stated as "about 100 s" |
| Vol rank | ≤ 300 s + loop + delivery | ≈ 304 s | stated as "about 5 min" |

`holdSeconds` adds to these by definition. The form says so when it is set.

---

## 8. Formulas and worked examples

All maths is in pure functions in `alerts/metrics.mjs` and `alerts/engine.mjs`, each with a reference-value test (`metrics.test.mjs`, `engine.test.mjs`). Black-76, the forward and the clock come from P1-3's `pricing.js` (always present: P1-3a lands first). PCR and largest OI use P1-1's `dashboard/oi-series.js`; marks and strategy P&L use the shared `dashboard/marks.js` (§8.1, §8.8), which P1-12's guards import too.

### 8.1 Mark (`legMark(quote, { basis, maxSpreadPct })` in the shared `dashboard/marks.js`)
- One function for alerts and guards (P1-12 §7.1). `maxSpreadPct` defaults: **5 %** for single-contract conditions (price, IV, Greek, straddle); **15 %** for strategy P&L, the same value as `guards.mark.maxSpreadPct`, so a guard and a strategy-P&L alert on the same legs always see the same P&L.
- `ltp`: last traded price. `bid` / `ask`: that side (null if absent). `mid`: (bid + ask)/2 when both are present, `ask ≥ bid > 0` and `(ask − bid)/mid ≤ maxSpreadPct`; otherwise `ltp` with `quality: "ltp-fallback"`, shown in the message.
- Defaults: spot and futures `ltp`; options `mid` (an option's LTP can be minutes old on a quiet strike).
- Example: bid 148.30, ask 148.90 → mid 148.60, spread 0.40 %.

### 8.2 Contract IV (`ivOf`)
Black-76 on the forward F of that expiry (latest recorder snapshot `fwd`, or the parity forward from the last chain read, refreshed at least every 60 s), T from the clock, r from S5 (P1-2) or config, price = mark (§8.1), bisection then Newton to 1e-6.
Example (P1-1 fixture): F = 25,171.51, K = 25,150, T = 0.013699, r = 0.065, CE mid 148.60 → **IV = 11.72 %**. PE mid 126.30 → **11.65 %**.
A tick with no usable mark, or a price below intrinsic value discounted, gives `null` with reason `NO_IV` and is not evaluated.

### 8.3 Greeks (`greeksOf`)
`d1 = (ln(F/K) + σ²T/2)/(σ√T)`, `Δ_CE = e^{−rT} N(d1)`, `Δ_PE = Δ_CE − e^{−rT}`, `Γ = e^{−rT} n(d1)/(F σ √T)`, vega per vol point = `e^{−rT} F n(d1) √T / 100`, theta per trading-day unit from P1-3's clock (calendar day in the interim).
Example (same contract, σ = 11.72 %): d1 = 0.0692 → **Δ = 0.527**, **Γ = 0.001151 per point**, **vega = ₹11.71 per vol point per unit**.
Strategy net Greeks = Σ sign × quantity × leg Greek (sign +1 BUY, −1 SELL), in units.

### 8.4 ΔOI over a window (`oiChange`)
`ΔOI = OI_now − OI_ref`. `OI_ref` = OI in the latest snapshot at or before `now − window`, accepted only if it is no older than `window + 90 s`. Windows: `5m`, `15m`, `30m`, `60m`, `open` (first snapshot at or after 09:15), `prev` (previous session's last value). Units: `units`, `lots` (= ΔOI / lot size) or `pct` (= ΔOI / OI_ref × 100). Chain subjects sum CE, PE or both over the strikes in scope.
Example (lot 65): OI_ref at 10:00 = 6,500,000, OI_now at 10:15 = 7,475,000 → ΔOI = **975,000 units = 15,000 lots = +15.00 %**. A rule "15m ΔOI above 10 %" is true.

### 8.5 PCR (`pcr`)
`PCR_OI = Σ OI_PE / Σ OI_CE` over the strikes in scope (default: all strikes in the snapshot; `params.strikes` = N limits it to ATM ± N). `PCR_vol` uses volume. Undefined when Σ CE = 0.
Example (P1-1 S3 fixture): Σ PE OI = 104,962,500, Σ CE OI = 112,500,000 → **PCR = 0.933**. A rule "PCR crosses below 0.95" on the previous value 0.958 fires.

### 8.6 Walls (`oiWalls`, `wall` metric)
- `basis: "oi"`: the largest-call-OI and largest-put-OI strikes in scope (`oi-series.js largestOi`, the same function as the recorder's S3 `largestCallOi`/`largestPutOi`). Ties go to the strike nearer ATM. Copy says "largest call OI", never "call wall": "wall" names P1-8's gamma levels only.
- **Stability rule** (anti-flap): a new wall strike K′ replaces K only when `OI(K′) ≥ OI(K) × (1 + 5 %)` in **two consecutive** snapshots. Without the rule, two near-equal strikes would flip every minute.
- Op `changes`: true on the snapshot where the confirmed wall strike differs from the last confirmed one (`params.minSteps`, default 1, = strikes moved). Ops `above`/`below`/`crosses_*`: the wall strike against a level.
- `basis: "gex"`: P1-8's `exposure.levels` `callWall`/`putWall` for the chosen sign model (default the user's exposure default). P1-8 already emits only on change, and the stability rule is P1-8's.
- Example: call wall 25,500 (9,933,750) and 25,600 at 10,000,000 → no change (+0.7 %). Next two snapshots 25,600 at 10,450,000 and 10,500,000 against 25,500 at 9,950,000 (+5.0 %, +5.5 %) → the wall changes to 25,600 on the second → fire "NIFTY largest call OI moved from 25,500 to 25,600".

### 8.7 Straddle (`atmStraddle`)
ATM = strike nearest the forward (ties to the lower strike, as in P1-1 §6.4). Straddle = mark(CE) + mark(PE) at that strike (`mid` basis by default). `params.strike` = a number fixes the strike; `"atm"` rolls with the forward and the message names the strike used.
Example: F = 25,171.51 → ATM 25,150 (21.51 away vs 28.49 for 25,200); CE mid 148.60 + PE mid 126.30 → **straddle = 274.90**.

### 8.8 Strategy P&L (`strategyPnl` in the shared `dashboard/marks.js`)
`P&L = Σ_i s_i × q_i × (m_i − e_i)`, with s = +1 BUY and −1 SELL, q in units (the shared function takes signed units `s_i × q_i`, as P1-12 §7.2 does), m the mark (§8.1, `mid` basis, 15 % spread cap), and e the entry. If any leg has no mark, the value is `null` (never a partial sum).
Example (lot 65): short 25,500 CE @ 60.00 and short 24,800 PE @ 55.00, one lot each; marks 92.50 and 31.00 → `−(92.50 − 60.00) × 65 − (31.00 − 55.00) × 65 = −2,112.50 + 1,560.00 =` **−₹552.50**. A rule "P&L below −₹500" with hysteresis max(₹100, 2 %) = ₹100 latches true at −552.50 and resets only above −400.
Multi-expiry legs: marks are market marks, so P&L needs no model. P1-9 is not needed for P&L, only for breakevens.

### 8.9 Short strike tested (`shortStrikeDistance`)
For each **short** option leg: `pct = (K − S)/S × 100` (CE) or `(S − K)/S × 100` (PE). It is positive while out of the money. `sigma = ln(K/F)/(σ√T)` (CE) or `ln(F/K)/(σ√T)` (PE), with σ the leg's IV (§8.2) or ATM IV if the leg has none, and F, T from that leg's expiry. The metric value is the **minimum** over short legs, and the message names the leg.
Example: S = 25,380, F = 25,401, short 25,500 CE, σ = 11.5 %, T = 0.0109 → pct = **0.473 %**; σ√T = 0.012006, ln(25,500/25,401) = 0.003890 → **0.324σ**. "Below 0.5σ" is true.

### 8.10 Breakevens (`breakevens`, `breakeven` metric)
Single-expiry option legs (+ same-expiry futures). Expiry payoff `Π(S) = Σ s_i q_i (payoff_i(S) − e_i)` is piecewise linear with kinks at the strikes. Roots are found exactly on each linear segment between kinks plus the two open ends. The profit zone is the set where Π > 0. Op `breached`: spot is outside the profit zone (for credit structures), or inside a loss zone, using the last spot. `within` (param `pct`): spot within X % of the nearest breakeven.
Example: the strangle above, credit 115 → **breakevens 24,685 and 25,615**. Spot 25,630 → breached (above the upper breakeven by 0.06 %); hysteresis 0.05 % of 25,615 = 12.8 → resets below 25,602.2.

### 8.11 IVR / IVP
Values come from P1-3 `vol.rank({ underlying, basis: params.basis ?? "cm30", lookbacks: [params.lookback ?? 252] })`: `ivr = (current − min)/(max − min) × 100` and `ivp` = share of days below current × 100 (P1-3 definitions, quoted in the catalog). `reason: "COLLECTING"` or `"FLAT"` → `waiting_data`. `partial: true` → fires, labelled.

### 8.12 Time (`nextTimeFire`)
`at "HH:MM"` (IST) with `params.days: "trading" | "all"` (default trading), or an ISO instant (one-off). True during the loop tick in which `now ≥ next` (and it stays true for 60 s for `all` combinations). `next` is recomputed after each fire.
Example: "at 15:10, trading days", created Thu 29 Oct 2026 15:12 → next = **Fri 30 Oct 15:10 IST**. After that fire → Mon 2 Nov 15:10 (weekend skipped; holidays skipped when P1-2 is present).

### 8.13 Ops, hysteresis and crosses (`evalCondition`)
Latch L with threshold T and band h:
- `above`: L becomes true when v ≥ T, false when v < T − h. `below`: true when v ≤ T, false when v > T + h.
- `between [lo, hi]`: true when lo ≤ v ≤ hi, false when v < lo − h or v > hi + h. `outside` is its complement with the band applied inward.
- `crosses_above`: a **cross event** occurs when the `above` latch goes false → true **after having been observed false**. On the first observation the latch is seeded without an event. The condition's truth is true for `crossMemorySeconds` after the event (so it can combine in `all` rules), then false until the next event. `crosses_below` mirrors this.
- `holdSeconds` > 0: the raw truth must stay true for that long before it counts.

Default h (overridable per condition, ≥ 0): spot/future price 0.05 % of T; option price max(0.5 % of T, 2 ticks); IV 0.25 vol points; IVR/IVP 2 points; ΔOI 2 % of |T| (units/lots, min 1 lot) or 1 point (pct); PCR 0.02; straddle 0.3 % of T; Δ 0.01; Γ/θ/vega 2 % of |T|; strategy P&L max(₹100, 2 % of |T|); short-strike 0.05 (pct points) or 0.05σ; breakeven 0.05 % of the breakeven.

Example (spot, T = 25,200, h = 12.6): ticks 25,180 → 25,203 (cross event, fire) → 25,195 (latch stays true: 25,195 ≥ 25,187.4) → 25,201 (no event) → 25,185 (latch false) → 25,204 (**new event**). Without hysteresis the 25,195 → 25,201 pair would have fired twice.

### 8.14 Combining and repeat (`combine`, `gate`)
Edge = combined goes false/null → true.
- `once`: fire on the first edge, then status `fired`. `rearm` resets latches.
- `daily`: at most one fire per IST trading date. At each session open the combined state resets to `null`, so a level that is still true fires once on the new day. A cross needs a new cross.
- `every N`: fire on an edge when `now − lastFiredAt ≥ N min`. An edge inside the cooldown sets `pendingEdge`, and it fires when the cooldown ends **if combined is still true**. The status during the cooldown is `cooldown`, with `nextEligibleAt`.
Example (`all`: "NIFTY crosses below 25,000" and "PCR below 0.80", every 15 min): 10:02 PCR 0.78 (true), spot crosses 24,995 → edge → **fire**. 10:05 spot back to 25,020 (cross memory ends 10:03) → combined false. 10:09 crosses again → edge inside cooldown → pending. 10:17 cooldown ends; spot still below (cross memory over, so combined false) → pending dropped, no fire. That is the defined meaning of "at most every N minutes on new crossings" (reminders-while-true are LATER).

### 8.15 Bad-tick filter
A stream value that moves more than `sanity.maxJumpPct` (5 %) from the last accepted value within 10 s is held, not used, until a second tick within `confirmMs` (3 s) confirms it (within 1 % of the held value). Otherwise it is dropped and counted (`status.sanityDropped`). Index and futures are filtered. Options use 50 % (they move fast in percent) and only when the underlying moved less than 1 % in the same window.

---

## 9. Safety, compliance and privacy gates

| Gate | Rule | Enforced by |
|---|---|---|
| No orders | Alerts notify only. No import from `orders/`, `paper/`, `safety/`. `actions` must be `[]` | `module.test.mjs` grep; schema `maxItems: 0` |
| Kill switch | The kill switch does **not** mute alerts. They are information, and BRD §7.5 stops *actions*. The guide says so | Doc + test that a kill-switch event changes no alert state |
| Scopes | Writes need `paper`; reads need `read`; MCP has the read tool only; demo simulate is loopback-only and demo-only | Route table + P1-5 generic scope tests + `routes.test.mjs` |
| Ownership | A key sees only its rules; 404 for others' rules | `routes.test.mjs` |
| No identifiers outbound | Messages and bus payloads never include account ids, key ids, client codes, tokens or a host. Strategy rupee figures only with `shareAmounts` | `notify.test.mjs` (string grep on formatted output for every fixture); `alertService.test.mjs` |
| No secrets at rest | S7 files hold no tokens | `store.test.mjs` grep for `mcb_` and token patterns |
| Text injection | `name`/`note` are clipped and control-stripped, sent as data, and never interpreted (no Markdown parse mode on Telegram) | `schema.test.mjs`, `notify.test.mjs` |
| Stale data | Never fire on input older than `staleSeconds`. Show `blind`. Bad-tick filter | `engine.test.mjs` |
| Wording (§8.1 RA/IA) | Descriptive phrases only; no buy/sell/signal/rich/cheap wording. The vendor ships no rules except demo samples labelled "Sample". Context defaults are the user's own levels, not suggestions | Copy grep test; review |
| Market-data terms (§8.3) | Alerts deliver the user's own data to the user's own targets. `notifications.md` and the form's Notify help add: "Prices in alerts come from your broker for your personal use. Do not post them to shared or public channels." | Docs + form copy |
| Algo framework (§8.1) | Not applicable: no order is placed. H3 will need P1-5 readiness, opt-in and the legal review | — |
| Demo labelling | Fires in demo carry `demo: true` and "[Demo]" | `demoAlerts.test.mjs` |
| Disclaimers (§8.4) | GEX wall texts append the modelled-exposure sentence. IVR partial labelled | `metrics.test.mjs` (describe) |

---

## 10. Test plan

### 10.1 Unit tests (vitest, next to the code)

| File | Covers |
|---|---|
| `server/bridge/alerts/metrics.test.mjs` | §8 reference values: mark/mid fallback; IV 11.72 / 11.65 %; Δ 0.527, Γ 0.001151, vega 11.71; ΔOI 975,000 / 15,000 lots / 15.00 %; windows `open` and `prev`; ref older than window + 90 s → null; PCR 0.933; walls stability (no change at +0.7 %, change on the 2nd +5 %); straddle 274.90 and ATM tie rule; strategy P&L −552.50 and null on a missing mark; short strike 0.473 % / 0.324σ, minimum over legs; breakevens 24,685 / 25,615 for the strangle, an iron condor (4 roots → 2), a long call (1 root), and the refusal for multi-expiry; time next-fire across a weekend and a configured holiday; `describe()` texts for every metric (no amounts when `shareAmounts` is false) |
| `server/bridge/alerts/engine.test.mjs` | latches for every op with hysteresis (§8.13 sequence exactly); first-observation seeding for crosses; cross memory; hold seconds; all/any with nulls; edge detection; repeat once/daily/every including pending edge dropped (§8.14 example); session reset; stale → null → blind after 30 s; bad-tick held/confirmed/dropped; property test: over 10,000 random walks no rule fires twice within its `every` cooldown and no `once` rule fires twice |
| `server/bridge/alerts/schema.test.mjs` | every metric × subject × op allowed/refused; 1–5 conditions; legs ≤ 12, quantity > 0, entry > 0; `ref` resolution; `actions` non-empty refused; tags/targets/name/note limits and sanitising (control characters, 10 KB name refused); `between` lo < hi; `time` formats; expired contract refused |
| `server/bridge/alerts/plan.test.mjs` | path choice: stream slot available → stream; slot exhausted + recorded chain → recorder; neither → poll; poll over `maxSymbols` → unavailable with reason; ivr → vol; gex → exposure; latency labels |
| `server/bridge/alerts/feeds.test.mjs` | hub subscription capped at `share × feedCap` (Dhan 3,750; Zerodha 1,350; Upstox 600; demo 75) with ranking; `SUBSCRIPTION_LIMIT` rejection moves symbols to fallback; recorder snapshot updates chain inputs with 0 marketData calls; poll is batched to `maxQuoteBatch` and skipped under the headroom floor (fake scheduler); `maxChainsPerMinute`; no polling outside the session; minute ring and its 400 cap |
| `server/bridge/alerts/store.test.mjs` | atomic writes; torn last fire line skipped and counted, next append on a new line; corrupt `rules.json` → renamed + empty + warning; crash between append and flush → replayed from the log on start (no duplicate fire); retention by IST month; demo root separation; no token-like strings in any file |
| `server/bridge/alerts/alertService.test.mjs` | manual clock + fake hub/bus/recorder/marketData/vol/exposure: create → armed → fire → S7 + `option.alert` + inbox; **latency**: tick to `option.alert` ≤ 1,100 ms over 200 fires (p95), recorder snapshot to `option.alert` ≤ 1,100 ms; cap 500 → `ALERT_LIMIT`, per-owner 200; `key.revoked` disables; restart restores latches and does not re-fire a `once`/`daily` rule; contract expiry at 15:30 → expired; `front` roll; loop p95 ≤ 20 ms at 500 rules; kill-switch event changes nothing |
| `server/bridge/alerts/routes.test.mjs` | each route: validation errors with paths; scopes (read vs paper; read key POST → 403 `SCOPE_REQUIRED`); ownership (other key → 404); `dryRun` stores nothing; duplicate → 200 `meta.duplicate`; `ifVersion` conflict; `test` (and demo `preview=1`); fires cursor and CSV; inbox read; catalog availability with and without vol/exposure stubs; `CAPABILITY_UNSUPPORTED` |
| `server/bridge/alerts/module.test.mjs` | no imports from `orders/`, `paper/`, `safety/`; no `fetch`; config defaults; `stream.share > 0.5` refused; demo-only route absent outside demo |
| `server/bridge/alerts/demoAlerts.test.mjs` | `seedSamples` deterministic for a fixed instant; over 50 random demo instants the price sample fires within 10 min in ≥ 48 and the straddle sample within 15 min in ≥ 45 (manual clock driving the demo adapter); simulate makes each kind fire with `simulated: true`; `wouldSendTo` follows target filters; deleted samples are not re-created |
| `server/bridge/notify/notify.test.mjs` (update) | `option.alert` in schema and defaults; `wants()` with `targets`, tags, severities, underlyings, `test` bypass; format for single, any/all, strategy without amounts, partial IVR, gex disclaimer, demo/test/simulated prefixes; merge of 3 queued alerts into one message (Telegram, Discord, webhook `data.fires`); no account id/key id in any output |
| `server/bridge/stream/protocol.test.mjs` (update) | `subscribe_alerts`/`unsubscribe_alerts`; only own rules' fires; SSE `alerts=1` |
| `server/bridge/mcp/tools.test.mjs` (update) | `get_alerts` in the read toolset, shape, ownership |
| `server/bridge/dashboard/alerts-model.test.mjs` | `phrase()` for every metric/op; `formModel(context)` defaults for each entry point in §6.4 (exact thresholds for the fixtures); `validateDraft` mirrors server errors; status pill mapping; path labels; inbox model (unread, grouping by IST day); CSV rows; neutral-copy grep over all strings |
| `server/bridge/dashboard/format.test.mjs` (update) | `DASHBOARD_FILES` list includes the four new files |

### 10.2 Contract tests

- `core/openapi.test.mjs`: the 11 new operations (scopes, stream `S24`, loopback flag), `/v1/demo/alerts/simulate` in the demo-only allowlist, `ALERT_LIMIT` in the `ErrorCode` enum.
- `server/bridge/alerts/alerts.contract.test.mjs`: request/response bodies of every route validate against the OpenAPI component schemas (AJV over the YAML, as the existing contract tests do); `option.alert` payload validates against the AsyncAPI `alert` message.
- P1-5 generic security tests pick up the new write routes (CSRF, scope) with no change.

### 10.3 End-to-end

`server/bridge/e2e/alerts.e2e.test.mjs` (real app, real HTTP on 127.0.0.1, stub broker registry and drivable feed from `e2e/fixtures.mjs`, `shiftedClock(TRADING_DAY_10AM_IST)`, notify webhook target pointed at a local HTTP sink, no network):
1. Create a paper key; `POST /v1/alerts` "NIFTY spot crosses above 25,200, every 15 min" → 201, status `armed`, path `stream`.
2. Drive feed ticks 25,180 → 25,203 → the webhook sink receives a signed `option.alert` within **5 s** of the tick (assert p95 over 20 repetitions with different rules: ≤ 5,000 ms). `GET /v1/alerts/fires` has 1 row; `GET /v1/alerts/inbox` unread 1; a WS client with `subscribe_alerts` receives the message.
3. Ticks 25,195 → 25,201 → no second fire (hysteresis). Ticks 25,185 → 25,204 within 15 min → no fire (cooldown); status `cooldown`.
4. A contract with no stream slot (`stream.share: 0` app variant) and a fake recorder emitting `recorder.snapshot` each minute → fire within **70 s** of the condition becoming true in the fixture (manual minute driving).
5. Stop the feed → after `staleSeconds.stream` + 30 s the rule is `blind`, and a later stale value never fires.
6. Restart the app on the same data folder → the rule state is restored, and no duplicate fire appears in the sink.
7. Webhook body and every message: no account id, key id or token (string search).
8. Demo app variant (`--demo`): samples seeded; `POST /v1/demo/alerts/simulate { kind: "wall_shift" }` on a wall rule → fire with `simulated: true`, `delivery.wouldSendTo` set, nothing sent to the sink.

Manual check before merge (screenshots for the PR, demo mode): Alerts page at 360, 800 and 1280 px; form from a chain cell, a positions group and the IVR tile; bell popover with unread fires; toast; fired detail with "would send to".

---

## 11. Migration and back-compat

- **Additive only** (BRD §7.8): new routes, new bus topic, new error code, new optional config section, new optional notify target keys, new WS op and message. No existing field changes meaning.
- **Notify defaults:** `NOTIFY_EVENTS` gains `option.alert`, and the **default** `events` list gains it. Targets with an explicit `events` list are unchanged and do not receive alerts until the user adds `option.alert`. `mc-bridge doctor` and the Alerts status strip say so with the exact line to add. Targets relying on the default start receiving alert messages. That is the intended behaviour, and it is noted in the CHANGELOG.
- **`scan.alert` is unchanged.** Saved scans keep their own alert path. A later item may present them in the same inbox.
- **Without P1-1/P1-3/P1-8:** the module boots and the catalog marks the affected metrics unavailable or degraded with reasons. When those modules land, nothing in alerts changes except availability (detected at boot via `isStub`).
- **Storage versioning:** `rules.json`/`state.json` carry `version: 1`, with `store.migrate()` in place. Fire lines carry `v: 1`.
- **Removing the module** (config `alerts.enabled: false`) leaves files in place and stops evaluation.
- **Restyle team:** the new UI uses only existing components and tokens. One icon (`bell`) is added and one toolbar slot (`#toolbar-alerts`), which the restyle team may move. The PR includes a short note for them listing the four new files and the classes used.

---

## 12. Ordered task list (each task fits one engineer in one session)

| # | Task | Files | Done when |
|---|---|---|---|
| T1 | Core additions: TOPICS `option.alert`, `ALERT_LIMIT`, `builtinModules`, `DASHBOARD_FILES`, `core/ownership.mjs` (move `seesAll`/`owns` from scanner, scanner imports it) | `core/*`, `scanner/routes.mjs` | existing core and scanner tests green |
| T2 | Config schema + rule/condition schemas + METRICS catalog + sanitiser | `alerts/config.mjs`, `alerts/schema.mjs`, `schema.test.mjs` | schema tests pass |
| T3 | Pure metrics (§8.1–8.12) with reference tests; shared `dashboard/marks.js` (+ `DASHBOARD_FILES`) | `alerts/metrics.mjs`, `metrics.test.mjs`, `dashboard/marks.js`, `marks.test.mjs` | every §8 example passes; P1-12 §7.1/§7.2 examples pass on `marks.js` |
| T4 | Pure engine (latches, crosses, hold, combine, gate, stale, bad-tick) with the property test | `alerts/engine.mjs`, `engine.test.mjs` | engine tests pass |
| T5 | Store (rules, state, fire log, replay, retention, corrupt handling) | `alerts/store.mjs`, `store.test.mjs` | store tests pass |
| T6 | Planner + feeds (stream share, recorder adapter, poll with headroom floor, minute ring, vol/exposure inputs) | `alerts/plan.mjs`, `alerts/feeds.mjs`, `plan.test.mjs`, `feeds.test.mjs` | budget figures of §7.2 asserted |
| T7 | Alert service (CRUD, owners, caps, dirty loop, fire, inbox, session edges, key revoke, status, latency stats) + `fake.mjs` | `alerts/alertService.mjs`, `alerts/fake.mjs`, `alertService.test.mjs` | latency and restart tests pass |
| T8 | Routes + module + OpenAPI + contract test | `alerts/routes.mjs`, `alerts/module.mjs`, `routes.test.mjs`, `module.test.mjs`, `docs/openapi.yaml`, `alerts.contract.test.mjs` | `openapi.test.mjs` and contract tests pass |
| T9 | Notify: event, defaults, filters, format, merge | `notify/config.mjs`, `notify/notifier.mjs`, `notify/format.mjs`, `notify.test.mjs` | notify tests pass; no identifiers |
| T10 | Stream op + SSE + AsyncAPI; MCP `get_alerts` | `stream/protocol.mjs`, `stream/sse.mjs`, `docs/asyncapi.yaml`, `mcp/tools.mjs`, tests | protocol and MCP tests pass |
| T11 | Demo: samples, simulate route, would-send-to, demo defaults | `alerts/demoAlerts.mjs`, `demo/routes.mjs`, `demo/demoMode.mjs`, `demoAlerts.test.mjs` | samples fire in the test; `--demo` shows them firing |
| T12 | Dashboard pure model | `dashboard/alerts-model.js`, `alerts-model.test.mjs` | model tests pass |
| T13 | Alert form (modal/sheet, dryRun "now" line, test/preview) | `dashboard/alert-form.js` | creates every metric in demo at 360/800/1280 px |
| T14 | Alerts page + bell + toasts + inbox transport (WS or poll) + `views.js` entry + `ICONS.bell` | `dashboard/alerts-page.js`, `dashboard/alerts-bell.js`, `views.js`, `app.js` | page and bell work in demo at three widths |
| T15 | Entry points on chain sheet, chain summary, OI, Vol, Positions, Strategy (Exposure if present) | `chain-sheet.js`, `desk.js`, `oi.js`, `vol.js`, `positions.js`, `strategy.js` | each opens the form with §6.4 defaults (model tests cover the defaults) |
| T16 | E2E + docs (alerts guide, notifications, compliance line, ARCHITECTURE, STREAMS S24, example config, CHANGELOG, doctor check) | `e2e/alerts.e2e.test.mjs`, docs, `core/cli.mjs` | full `npm test` green; `npm run typecheck` clean |

T1–T8 give a working server with the REST API (usable from scripts). T9–T11 complete delivery and demo. T12–T15 are the UI. T16 closes the item.

---

## 13. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | P1-1's recorder read methods (latest snapshot, read at an instant) are not named as a contract in the P1-1 spec | High | Medium | All recorder access goes through `feeds.mjs` `recorderAdapter` (two functions). It is tested with a fake, so only that adapter changes when P1-1 fixes the names |
| R2 | Feed capacity: recorder (60 %), alerts (15 %) and pages share one account's subscriptions | Medium | Medium | Ranked slots, honest per-rule path and latency, poll fallback, status counters. Users see "Polling every 30 s" instead of a silent miss |
| R3 | Total background REST could exceed 50 % on 1/s brokers (recorder 50 % + alerts chain fallback) | Low | Medium | Headroom floor (§7.1 rule 4); never poll a chain the recorder covers. Global accountant LATER |
| R4 | Telegram pacing breaks p95 ≤ 5 s under bursts | Medium | Low | Merge queued alerts per target; latency stats per path in `/v1/alerts/status` |
| R5 | Users read alert phrases as advice | Medium | High | Descriptive copy only, grep test, no vendor rules except labelled demo samples, defaults derived from the user's own context |
| R6 | Strategy alerts drift from real positions (legs snapshot) | High | Medium | "Legs as saved on …" in the form and every message; one-tap re-save from Positions; following positions is LATER with S8 |
| R7 | Bad ticks or stale wings fire false alerts | Low | High | Bad-tick filter, stale → blind, hysteresis, hold seconds; options filter only when the underlying is calm |
| R8 | "Every N minutes" is read as "remind every N minutes while true" | Medium | Low | The definition is in the form help and the guide; reminders-while-true are LATER |
| R9 | Stream id | Resolved | — | Fixed in `docs/spec/README.md`: alerts is S24 |
| R10 | Demo cannot show wall shifts or IVR moves naturally intraday (by P1-8 and P1-3 design) | Certain | Low | Simulate route, clearly labelled "[Simulated]" |
| R11 | Default notify `events` change surprises users whose targets used defaults | Low | Low | CHANGELOG, doctor message, alerts are opt-in per rule (no rules → no messages) |
| R12 | Breakeven alerts are single-expiry only | Certain | Low | Clear 400 message pointing to P&L/short-strike conditions; LATER with P1-9 analyzer |
| R13 | Holidays before P1-2: `time` rules fire on exchange holidays | Medium | Low | Message says the holiday list is missing; P1-2 removes it |
