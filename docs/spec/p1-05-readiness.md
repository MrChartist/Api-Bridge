# Spec P1-5: Trading readiness and security baseline (H5, BRD §7.9)

Status: ready to build · Owner: tech lead, Options desk · Date: 29 Oct 2026 · Stream: **S20 (new) "Readiness"** (final id from the stream table in `docs/spec/README.md`), plus lead-owned core changes (§3.1) and small changes in S7 orders, S11 hooks/MCP, S15 notify, S9 safety and the dashboard.
Builds on: BRD `docs/brd/options-platform.md` §3.H (H5), §4 item 4, §5.5 "Readiness monitor", §5.6 (`GET /v1/readiness`), §6.1 P1-5 (acceptance criteria), §7.5 (order safety), §7.7 (privacy), §7.8 (API contract), §7.9 (threat model), §8.1 (retail algo framework, static IP, daily logout), §8.5 (risk "session expires or egress IP changes").
Hard dependencies: none. Soft dependencies (each has an interim behaviour here):
- **P1-2** reference data: `deps.reference.calendar().isTradingDay()` and `reference.session()` decide "trading day" and the check window. Until it lands: `lib/marketHours.mjs` weekday rule plus its special sessions; holidays are not known, so the 09:00 run also fires on exchange holidays, and its message says so (§2.3).
- **F0** shared foundations create `server/bridge/demo/routes.mjs` and the OpenAPI demo-only exclusion list; this spec adds one route there (P1-4 adds `POST /v1/demo/feed` the same way).
Consumers (later items build on the contract in §3.3): **P1-11** alerts (alert actions), **P1-12** guards (auto-exit), **P1-10** pre-trade check (H5 line), **H3** alert → action.

Not in this spec: visual styling. Another team is restyling the dashboard (near-black theme, colour tokens, motion). New UI uses existing components (`pill`, `card`, `modal`, the toolbar glass buttons, the bottom sheet used by `chain-sheet.js`) and the shared tokens in `palette.css`. State colour comes from the existing `pill(text, "ok"|"warn"|"bad")` classes in `app.js`/`app.css` (which read `--ios-green`, `--warn`, `--ios-red`). The only new CSS is the phone icon's state dot, which reuses those same tokens. No new colours, no new motion.

> **Build order and shared foundations.** This spec is steps 5–6 (P1-5a server and security baseline T1–T13, P1-5b dashboard, doctor and docs T14–T16) in `docs/spec/README.md`, after F0 (P1-2a for holidays). It uses, and does not rebuild, the F0 foundations listed there: final stream ids, bus topics and error codes pre-registered in core, the opt-in `options` MCP toolset (every MCP tool in this spec goes there), `demo/routes.mjs` plus the OpenAPI demo-only list, `server/lib/jsonl.mjs` (append, torn-line tolerance, last-wins, quarantine of corrupt files), `ratelimit/backgroundGate.mjs` (the one ≤ 50 % background-budget check), `core/ownership.mjs`, and `dashboard/copyRules.mjs` (the one banned-word list). Where this text and README disagree, README's build order and shared-module owners win.

---

## 1. Summary

Today the Bridge refuses a live order only at the moment it is sent. A broker session that expired overnight, a home IP that changed after a router restart, or a daily loss limit that is already used up are discovered by the order that fails. For a person clicking a ticket that is an annoyance. For anything automated (webhooks today; guards and alert actions in P1-11/12) it is a silent failure at the worst moment.

After this item:
- A **readiness monitor** checks every live-enabled account at **09:00 IST on trading days** and **every 4 minutes from 08:45 to 15:45 IST**. It also re-checks at once on any session change, broker session rejection, kill-switch change or config change. Each check covers: broker session (state, stated expiry, and a cheap probe call), egress IP against `live.registeredIp` (opt-in lookup), order-rate headroom, daily order and loss headroom, and the kill switch.
- Each account gets one state: `ready`, `warn`, `cannot_trade`, `paper_only` or `unknown`, with reasons in plain English.
- `GET /v1/readiness` returns it. A **toolbar badge** on every dashboard page shows it, and a "Trading readiness" card on the Safety page shows the detail.
- Any account that is failing at 09:00, or that moves into `cannot_trade` later, is **notified** through the existing notify targets (new event `trading.readiness`). Notifications carry no IP address, token or broker client code.
- **Automated live orders are gated.** Webhook orders today, and guard or alert sends later, are refused with the new code `CANNOT_TRADE` while their account is `cannot_trade`, and no broker call is made. Orders a person sends (REST, CLI, a confirmed MCP ticket) get a warning instead. Automations register with the monitor, so each one can show "cannot trade" and the reason.
- The existing per-order static-IP warning (`safety/safetyGuard.mjs`) finally gets an egress IP: the monitor feeds it.
- **Security baseline (§7.9).** Route-table-driven tests prove that every state-changing route refuses cross-site browser requests, that every route enforces its scope, and that MCP write tools do not exist without the right scope. One cheap extra defence is added (refuse `Sec-Fetch-Site: cross-site` writes). The finding behind the "per-session token" wording in the BRD is written down: the dashboard already authenticates with a per-tab bearer key in a header and never with a cookie, which is stronger than a cookie plus token pair.
- A new guide, `docs/guides/deployment.md`, covers static-IP VPS, static home IP and tunnels, and explains why a dynamic IP cannot place live orders.
- **Demo mode** shows a simulated live account with a simulated session expiry, IP and sample automations, and a demo-only control flips them into failure. Every state can be seen and tested without a broker.

---

## 2. Scope

### 2.1 MUST (this round)

| # | Item | Acceptance hook (BRD P1-5) |
|---|---|---|
| M1 | `readiness` module (`server/bridge/readiness/`): pure check functions, monitor (timers, bus triggers, persisted state), egress lookup, automation registry, routes | `GET /v1/readiness` per live account |
| M2 | Session check: `accounts.status()` state and stated expiry, plus a probe (`accounts.testConnection` through `scheduler.schedule`, background priority, cooldown 30 s) | session valid and expiry time |
| M3 | Egress check: `readiness.egressIp.mode` = `off` (default) / `lookup` / `manual`; compare with `live.registeredIp` and new optional `live.backupIp`; feed `safety.setDetectedEgressIp` | egress IP vs `live.registeredIp` |
| M4 | Order headroom: Bridge order-rate cap (from `safety.limits`), daily orders, daily loss, broker order-class headroom (`scheduler.headroom`) | order-rate headroom |
| M5 | Kill-switch state per account (global switch, shown per account) | kill-switch state |
| M6 | Pre-open run at 09:00 IST on trading days; notify failing accounts once per day; transitions into `cannot_trade` notified with cooldown; bus topic `trading.readiness`; notify event and message format | 09:00 notification |
| M7 | Automation registry + gate: `readiness.canTrade()` / `ensureFresh()` / `registerAutomation()`; OrderService blocks automated live sends with `CANNOT_TRADE`; hooks register live hooks and show their readiness | guards and alert actions move to "cannot trade" within 5 min; no order attempted |
| M8 | Dashboard: toolbar badge on every page (`#toolbar-ready`), popover (desktop/tablet) or bottom sheet (phone), Safety page "Trading readiness" card, demo simulate controls | header badge |
| M9 | Demo: simulated live account (`demo`), simulated session and IP, two sample automations, `POST /v1/demo/readiness` scenarios with auto-restore | every feature visible without a broker |
| M10 | Security baseline tests: CSRF on every non-GET route, scope on every route, WS upgrade origin, MCP write tools by scope, no cookie auth, no secrets in new stores; add the `Sec-Fetch-Site` write guard | §7.9 checks pass |
| M11 | `docs/guides/deployment.md` (new), `docs/guides/safety.md`, `compliance.md`, `notifications.md`, `ARCHITECTURE.md` §8 threat model, `STREAMS.md` S20, OpenAPI, CHANGELOG | deployment page |
| M12 | MCP parity: `get_safety_status` gains `readiness` per account (no new tool; see §4.6) | §7.8 parity |

### 2.2 LATER (not this round; named so nobody builds it now)

- **Server-side stale-price gate** for API and MCP orders (BRD §7.5, carried over from P1-4 §2.2). It needs P1-4's leg `ts` and belongs with the P1-10 pre-trade check (G3). Not here.
- **Broker-reported registered IP.** Some brokers may expose the whitelisted IP through their API (Dhan is reported to have "get IP"; **needs verification**). That would be an adapter capability (`registeredIps`) in `server/brokers/**`, which is frozen for this round. Until then we compare with the value the user typed in config.
- **Mapping broker static-IP rejections** (Samco `EOAUTH009`, Bigul 403 "static IP", and others) to a typed `STATIC_IP_REJECTED` code that flips readiness at once. Broker layer, later. Today such a rejection shows as `UPSTREAM_ERROR` on that order. If the broker also invalidates the session, the next probe catches it.
- **Push over `/v1/stream`.** The badge polls a local endpoint every 30 s (no broker calls). A `readiness` channel in AsyncAPI is not needed for that cadence.
- **One-tap kill switch as its own toolbar button** (BRD §7.5). This round it is one tap inside the badge popover, behind the existing confirmation modal. A dedicated button needs toolbar space that the restyle team owns.
- **Piggy-back probing.** Skip the probe when a scheduled call on that account succeeded in the last 4 minutes. That needs an additive scheduler extra (`lastOkAt`). The probe budget (§8) is already tiny.
- **Clock-sync check against an NTP source.** This round only reports the skew taken from the `Date` header of the egress lookup response when lookup is on (§7.6).
- **Readiness of the market-data account** used by the recorder (P1-1). Its health is the recorder's status panel.
- **Revoking the dashboard's sign-in key when the tab closes** (§3.9 finding F3). It is not reliable in browsers, and the key is tab-scoped and expires in 30 days.

### 2.3 What our data cannot do (and the honest fallback)

| Limitation | Why | Fallback in this spec |
|---|---|---|
| **The IP the broker sees cannot be known locally** | A machine does not know its public address. Only a third party can echo it, and the route to that third party can differ from the route to the broker (VPN split tunnels, dual WAN, IPv6 vs IPv4). | Lookup is **off by default** (privacy, BRD §7.9). When on, the user picks the service. The result is labelled "as seen by api.ipify.org at 10:12" and never presented as what the broker sees. If the families differ (IPv6 seen, IPv4 registered), the check is `warn` ("cannot compare"), not `fail`. The guide recommends an IPv4-only service. `manual` mode records the user's own statement ("as entered, not checked"), which can never detect a change. |
| **No broker states "session valid until" for every auth kind** | `apiKeyToken` brokers (Dhan, the demo) have `sessionExpiresAt: null` (`accounts/session.mjs`). Others state a daily expiry ("06:00 IST next day") that the broker may cut short. | Two sources: the stated expiry (shown as "until 06:00 tomorrow (broker's stated time)") and a **probe** read call. With no stated expiry the UI says "No stated expiry; accepted a read call at 10:12". A passing probe proves that reads work. It does not prove that order permission, the F&O segment or any order-time 2FA works; the method note says so. |
| **The registered IP held by the broker is not readable** | No wired adapter exposes it (see LATER) | Compared with `live.registeredIp` / `live.backupIp` from config. An empty value gives `warn` ("Set live.registeredIp so the Bridge can check"), never `ready` for that line. |
| **Broker and exchange order-rate budgets are not visible** | Brokers count per client, per PAN or per segment (**needs verification**, `compliance.md`) | We show the Bridge's own cap (5/s by default, never above 10) and the scheduler's `order`-class headroom from `brokerPolicies.mjs`, labelled "Bridge cap" and "broker limit as configured". |
| **Holidays without P1-2** | `lib/marketHours.mjs` has special sessions but no holiday list | The monitor runs on weekdays. On a holiday the 09:00 message adds "(The Bridge does not have the exchange holiday list yet; ignore this if the market is closed today.)" Once `deps.reference` is present, holidays skip the run. |
| **Demo has no live account** | Demo mode forces `safety.liveTrading = false` and the demo adapter has no order methods | The `demo` account is shown as a **simulated** live account (`simulated: true`, a "Simulated" chip on every row). Gate behaviour is shown on the two sample automations, not on real orders. |
| **"Within 5 minutes" for an IP change needs polling** | No event announces that the public IP changed | Interval 4 min, probe timeout 10 s and jitter ≤ 30 s give a worst case of 4 min 40 s (§7.5). Session expiry with a stated time, broker session rejections and kill-switch changes are event-driven and take effect in under 1 s. |

---

## 3. Architecture

### 3.1 Module map

New files:
```
server/bridge/readiness/module.mjs          defineModule({ name: "readiness", stream: "S20", configKey: "readiness",
                                            services: { readiness }, register, start, stop }) + ROUTES table
server/bridge/readiness/config.mjs          READINESS_CONFIG_SCHEMA (zod .strict()), parseReadinessConfig
server/bridge/readiness/checks.mjs          pure: sessionCheck, egressCheck, rateCheck, dailyOrdersCheck, dailyLossCheck,
                                            killSwitchCheck, liveConfigCheck, combine(), notifyKey(), shouldNotify(),
                                            inWindow(), nextPreOpenAt(), isStale()
server/bridge/readiness/ip.mjs              pure: normaliseIp(s) -> { ip, family } | null, sameIp(a, b), parseLookupBody(text, ct)
server/bridge/readiness/egress.mjs          createEgressDetector({ cfg, fetchImpl, clock }): lookup() with timeout, https only
                                            (http only to loopback), redirect "error", 1 KB body cap, Date-header skew
server/bridge/readiness/automations.mjs     createAutomationRegistry(): register/update/remove, byAccount(), notify(state)
server/bridge/readiness/monitor.mjs         createReadinessService(deps, { timers, egress, demo }): contract methods, timers,
                                            bus listeners, probe coalescing, persisted state, transitions ring
server/bridge/readiness/store.mjs           state.json read/write (writeFileAtomic from auth/fsUtil.mjs), corrupt -> fresh
server/bridge/readiness/routes.mjs          handlers (§4)
server/bridge/readiness/testkit.mjs         fakeAutomation(registry, { id, accountId, mode }) for P1-11/12 tests and e2e
server/bridge/demo/demoReadiness.mjs        simulated session/IP/limits for the "demo" account; scenarios; auto-restore
server/bridge/dashboard/readiness.js        pure view-model (badgeModel, rowsModel, copy) + render helpers (badge, popover,
                                            sheet, Safety card); node-testable view-model
docs/guides/deployment.md
tests                                       listed in §10
```

Changed files and owners:

| File | Owner | Change |
|---|---|---|
| `core/contracts.mjs` | lead | New contract `readiness` (§3.3). `orders.requires` += `"readiness"`. |
| `core/builtinModules.mjs` | lead | Add `readiness` after `safety` (registration and stop order; services build in dependency order anyway). |
| `core/eventBus.mjs` | lead | New topic `trading.readiness` (payload §3.4). |
| `core/errors.mjs` | lead | New code `CANNOT_TRADE: { status: 403, title: "This account cannot trade right now (trading readiness)", retryable: false }` (additive). |
| `core/config.mjs` | lead | `accounts[].live.backupIp` (optional string ≤ 64). `registeredIp` stays a free string, because a stricter type would refuse existing configs at boot. Readiness reports an unparsable value as `warn`. |
| `core/security.mjs`, `core/app.mjs` | lead | `assertNotCrossSiteWrite(req, cors)` called right after `assertTransportAllowed` for methods other than GET/HEAD/OPTIONS (§3.9). `DASHBOARD_FILES` += `"readiness.js"`. |
| `orders/orderService.mjs` | S7 | Readiness line in `preview` and `place` for `mode: "live"` (§6.9). |
| `orders/modeDecision.mjs` | S7 | Export `AUTOMATED_SOURCES = ["webhook", "system", "guard", "alert"]` (the last two are reserved for P1-11/12). |
| `core/context.mjs` | lead | `Source` typedef += `"guard" \| "alert"` (doc only; reserved). |
| `hooks/module.mjs`, `hooks/routes.mjs` | S11 | Register every `mode: "live"` hook as an automation; `GET /v1/hooks` items gain `readiness` (additive). |
| `notify/config.mjs`, `notify/format.mjs`, `notify/notifier.mjs` | S15 | `NOTIFY_EVENTS` += `"trading.readiness"`; default `events` becomes `["scan.alert", "safety.kill_switch", "trading.readiness"]`; `wants()` passes only payloads with `notify: true`; message format (§6.8). |
| `safety/safetyGuard.mjs` | S9 | None. `setDetectedEgressIp` already exists; readiness calls it. Only the header comment changes ("fed by the readiness monitor"). |
| `mcp/tools.mjs` | S11 | `get_safety_status` output adds `readiness` per account (§4.6). |
| `demo/routes.mjs` (from P1-4, or new), `demo/demoMode.mjs` | demo | `POST /v1/demo/readiness`; demo config defaults for `readiness` (§5). |
| `dashboard/index.html`, `app.js`, `views.js`, `app.css` | dashboard | Toolbar slot, badge mount and polling (`app.js`), Safety card and demo controls (`views.js`), three `data-ready` dot rules for the phone icon |
| `docs/openapi.yaml`, `docs/ARCHITECTURE.md`, `docs/STREAMS.md`, `docs/guides/*`, `bridge.config.example.json`, `CHANGELOG.md` | lead | §4.5, §11 |
| `core/cli.mjs` (`doctor`) | lead | Two checks: (a) a live-enabled account without `registeredIp`; (b) notify targets exist and none listens to `trading.readiness`. |

Rule: `readiness/*` never imports from `orders/` or `paper/`, and never calls an adapter's order method. A test (§10.1) greps for this. The monitor can only read state and engage nothing. It does **not** engage the kill switch.

### 3.2 Process and schedulers

All timers follow the scanner and notify pattern: `start()` arms them with `unref()`, `stop()` clears them, and time comes from `deps.clock.now()`. Timers are injectable (`{ setTimeout, clearTimeout, setInterval, clearInterval }`) for tests.

| Job | When | What | Trading days only |
|---|---|---|---|
| `tick` | every 60 s | Decides whether a `cycle` or `preopen` is due. Cheap: no I/O unless due. | — |
| `cycle` | every `intervalMinutes` (default 4) inside `window` (default 08:45–15:45 IST), first one `jitterSeconds` (0–30, `hash(dataDir) % 31`) after the window opens | `evaluate(all, { probe: true, egress: true })` | yes |
| `preopen` | `preOpenAt` (default 09:00 IST) + the same jitter, once per IST date (`state.preopen.lastRunDate`) | `evaluate(all, { probe: true, egress: true })`, then `notifyPreopen()` for every account not `ready`/`paper_only` | yes |
| `startup` | 20 s after `start()` | `evaluate(all, { probe: inWindow, egress: inWindow })` (outside the window, state only and no broker call) | no |
| bus triggers | at once (debounced 250 ms per account) | `account.status` → that account (probe when it became `connected`); `account.session_rejected` → that account, no probe (the rejection is the evidence); `safety.kill_switch` → all, no probe; `safety.limit` → that account, no probe | no |
| `ensureFresh` | on demand (automation arm, automated live order with stale state) | that account, probe subject to cooldown | no |

`evaluate()` never runs twice at once for the same account. Concurrent requests share one promise (singleflight by accountId). A probe is skipped when the last probe for that account is younger than `probeCooldownSeconds` (30); the previous probe result is reused and the check says so.

Trading day: `deps.reference.calendar().isTradingDay(istDate, "NFO")` when `deps.reference` exists and is not a stub, else weekday per `lib/marketHours.mjs` (`marketSession(date).state !== "WEEKEND"`; special sessions count as trading days).

### 3.3 Service contract (core change: the lead lands it)

```js
// core/contracts.mjs
/**
 * Readiness — S20. Whether each live-enabled account can trade right now (H5), for people (badge, notify) and for
 * automation (guards, alert actions, webhooks). Never sends or engages anything.
 *  status({ accountIds? }) -> ReadinessSnapshot                     cached; no I/O
 *  canTrade(accountId, { mode }) -> { ok, state, reasons, checkedAt, stale }   cached; mode "paper" is always ok
 *  ensureFresh(accountId, { maxAgeMs? = 60_000, timeoutMs? = 5_000 }) -> Promise<same as canTrade>
 *  check({ accountId?, reason }) -> Promise<ReadinessSnapshot>      runs evaluate (probe subject to cooldown)
 *  registerAutomation({ id, kind, accountId, mode, label, onState? }) -> { update(patch), remove() }
 *      kind: "webhook"|"guard"|"alert"|"sample"; onState(stateObj) is called on every state change of its account
 */
readiness: { iface: "Readiness", stream: "S20", requires: ["accounts", "scheduler", "safety"],
             methods: ["status", "canTrade", "ensureFresh", "check", "registerAutomation"] },
```
`orders.requires` += `"readiness"`. There is no cycle: readiness depends on safety, and orders depends on both. `reference` is read as `deps.reference` when present. It is not listed in `requires`, so P1-2 is not a hard dependency, and the code checks `isStub`.

### 3.4 Data model

**AccountReadiness** (the API shape; also what `state.json` keeps, minus `automations`):
```json
{
  "accountId": "zerodha-main", "broker": "zerodha", "brokerName": "Zerodha", "label": "Main",
  "simulated": false,
  "live": { "globalLiveTrading": true, "accountLiveEnabled": true, "allowedByConfig": true },
  "state": "cannot_trade", "since": "2026-10-29T10:12:31+05:30",
  "checkedAt": "2026-10-29T10:12:31+05:30", "stale": false,
  "reasons": [ { "check": "egress", "code": "IP_MISMATCH", "severity": "fail",
                 "message": "This computer's internet address does not match the static IP registered for Main. Live orders will be refused by Zerodha." } ],
  "checks": {
    "session":    { "status": "pass", "state": "connected", "expiresAt": "2026-10-30T06:00:00+05:30", "expiresInMinutes": 1187,
                    "expirySource": "broker-stated", "probe": "ok", "probedAt": "2026-10-29T10:12:30+05:30", "message": null },
    "egress":     { "status": "fail", "mode": "lookup", "matches": false, "registered": "set", "backup": "not-set",
                    "family": "ipv4", "detectedAt": "2026-10-29T10:12:29+05:30", "seenBy": "api.ipify.org",
                    "detectedIp": "198.51.100.23", "registeredIp": "203.0.113.10" },
    "orderRate":  { "status": "pass", "perSecond": 5, "usedLastSecond": 0, "headroom": 5,
                    "broker": { "remaining": 9, "limit": 10, "resetMs": 640, "source": "brokerPolicies (verified: false)" } },
    "dailyOrders":{ "status": "pass", "limit": 100, "used": 37, "left": 63 },
    "dailyLoss":  { "status": "warn", "limit": 10000, "pnlToday": -8250, "left": 1750 },
    "killSwitch": { "status": "pass", "engaged": false, "reason": null, "at": null }
  },
  "automations": [ { "id": "hk_abcdefghijkl", "kind": "webhook", "label": "ChartInk breakout", "mode": "live", "state": "cannot_trade" } ]
}
```
- `check.status` ∈ `pass | warn | fail | unknown | n/a`.
- `state` ∈ `ready | warn | cannot_trade | paper_only | unknown` (§7.1).
- `detectedIp`, `registeredIp` and `seenBy` are present **only** for loopback callers or keys with the `admin` scope. Other callers get `matches` and `registered`/`backup` (`set`/`not-set`/`invalid`) only (privacy, §9).
- Reason codes (closed list, documented as open in OpenAPI): `LIVE_OFF`, `SESSION_EXPIRED`, `SESSION_MISSING`, `SESSION_ERROR`, `SESSION_REJECTED`, `SESSION_EXPIRES_SOON`, `PROBE_FAILED`, `NO_STATED_EXPIRY`, `IP_MISMATCH`, `IP_NOT_REGISTERED`, `IP_INVALID_CONFIG`, `IP_FAMILY_DIFFERS`, `IP_UNCHECKED`, `IP_LOOKUP_FAILED`, `RATE_CAP_REACHED`, `BROKER_ORDER_BACKOFF`, `DAILY_ORDERS_LOW`, `DAILY_ORDERS_EXHAUSTED`, `DAILY_LOSS_NEAR`, `DAILY_LOSS_REACHED`, `KILL_SWITCH`, `STALE`.

**Bus topic `trading.readiness`** (payload safe to log; no IP, no token):
```json
{ "accountId": "zerodha-main", "broker": "zerodha", "brokerName": "Zerodha", "label": "Main",
  "state": "cannot_trade", "previous": "ready", "kind": "change",
  "reasons": [ { "check": "egress", "code": "IP_MISMATCH", "severity": "fail", "message": "…" } ],
  "automations": { "total": 2, "live": 1 }, "notify": true, "simulated": false, "at": "2026-10-29T10:12:31+05:30" }
```
`kind` ∈ `change | preopen | recovered`. `notify` is the monitor's dedupe decision (§7.7). The notifier delivers only `notify: true`. Every payload goes on the bus, so automations, the dashboard and the audit log all see every transition.

**Audit:** every state transition is appended as `readiness.changed` (`accountId`, `data: { from, to, codes }`) via `audit.append`, with the same soft-fail pattern as `softAudit` in safety. The pre-open run appends one `readiness.preopen` record per run (`data: { accounts: n, failing: [ids] }`).

### 3.5 Storage on disk

```
<dataDir>/readiness/
  state.json        { "version": 1,
                      "accounts": { "<id>": { "state", "since", "checkedAt", "reasons", "lastProbe": { "at", "result" },
                                              "lastNotifiedAt", "lastNotifiedKey" } },
                      "egress": { "at", "family", "matchesByAccount": { "<id>": true }, "seenBy" },   // NO address stored
                      "preopen": { "lastRunDate": "2026-10-29" },
                      "transitions": [ { "at", "accountId", "from", "to", "codes" } ]   // last 200, newest last
                    }
```
- Mode 0600, folder 0700, written with `writeFileAtomic`. Written on transition, after the pre-open run, and at most once per `cycle`.
- **The egress IP is not persisted.** It is kept in memory only and is lost on restart until the next lookup. Persisting it would put a personal identifier into the data folder, which users back up and sync. `matchesByAccount` is enough to restore the last known verdict.
- A corrupt or unreadable file is renamed `state.json.corrupt-<ts>` and a fresh state is used. All states start as `unknown` until the startup evaluation (BRD §7.7: a corrupted file must not stop the next day).
- No secrets, tokens or broker client codes. Test in §10.1.

### 3.6 Config (`readiness` section, all optional; zod `.strict()`)

```jsonc
"readiness": {
  "enabled": true,
  "intervalMinutes": 4,                       // 1..15; continuous checks inside `window` on trading days
  "window": { "from": "08:45", "to": "15:45" },   // IST "HH:MM"; from < to
  "preOpenAt": "09:00",                       // IST "HH:MM"; must lie inside `window`
  "probe": { "enabled": true, "timeoutMs": 10000, "cooldownSeconds": 30, "endpointClass": "portfolio" },
  "egressIp": {
    "mode": "off",                            // "off" | "lookup" | "manual"
    "lookupUrl": null,                        // required for "lookup": https://… (http:// only to 127.0.0.1/localhost/[::1])
    "manualIp": null,                         // required for "manual": the address you state this computer uses
    "timeoutMs": 5000,
    "maxSkewMs": 5000                         // warn when the lookup's Date header differs from the clock by more
  },
  "gateAutomated": true,                      // automated live sends are refused while cannot_trade (§6.9)
  "staleAfterMinutes": 10,                    // older state counts as "unknown" for automation
  "warn": { "sessionExpiresWithinMinutes": 60, "dailyOrdersLeftPct": 10, "dailyLossLeftPct": 20 },
  "notify": { "cooldownMinutes": 15, "onRecovery": true, "preopenOnlyIfFailing": true }
}
```
Demo mode defaults (`demoMode.mjs`): `egressIp.mode: "manual"` against the simulated address (§5), `probe.enabled: true` (the demo adapter answers locally), and the `window` and trading-day checks ignored, so the demo works at any hour.

### 3.7 Order gate placement

```
POST /v1/orders (or hook worker / future guard)
  └─ OrderService.place(ctx, order)
       ├─ modeDecision → mode "live"
       ├─ [NEW] readinessLine(ctx, accountId, mode):
       │     source ∈ AUTOMATED_SOURCES and cfg.gateAutomated
       │        → r = canTrade(); if r.stale or r.state==="unknown": r = await ensureFresh(accountId, { timeoutMs: 5000 })
       │        → r.state==="cannot_trade" or still unknown/stale → block CANNOT_TRADE (no safety slot taken, no broker call)
       │     otherwise (person-initiated) → r.state ∈ {cannot_trade, warn} → check severity "warn" with the reasons
       ├─ safety.check(...)          (unchanged)
       └─ broker send                (unchanged)
```
`preview()` runs the same line, so a ticket shows "Readiness: cannot trade (IP mismatch)" before the person confirms.

### 3.8 Automation registry

- In memory only. Automations re-register at boot (hooks module `start()` walks `hookStore.list()`). Later P1-11/12 rules register when they load from S7.
- `registerAutomation` refuses a duplicate `id` (throws `VALIDATION_FAILED`). `update({ mode, accountId, label })` moves it between accounts.
- On every account state change the registry calls `onState({ accountId, state, reasons, at })` for that account's automations, each in its own `queueMicrotask` with a try/catch, so one consumer cannot block another (the same rule as the bus).
- An automation with `mode: "paper"` is listed, but its state is always `ready` (paper never needs the broker session to trade). The reasons are still shown for information.
- **Guarantee used by P1-12:** a consumer that calls `canTrade()` right before sending, and also reacts to `onState`, can never send while the cached state is `cannot_trade`. The gate in §3.7 enforces this again inside OrderService, so a consumer bug cannot bypass it.

### 3.9 Security baseline: findings and the one code change

Audit of today's transport and auth (code as of 29 Oct 2026):

| # | Finding | Evidence | Verdict |
|---|---|---|---|
| F1 | No route authenticates from a cookie. The dashboard sends `Authorization: Bearer <key>` from `sessionStorage` (per tab). | `dashboard/app.js` `api()`, `setKey`; `core/app.mjs extractApiKey` | **This is the per-session token.** A browser never attaches it automatically, so a cross-site form or fetch cannot carry it. Adding a cookie session would *create* the CSRF risk. Decision: no cookies, and a test asserts it (T-sec-4). |
| F2 | Origin allowlist runs before routing, and preflight is answered only for listed origins. `Origin: null` is refused (the config regex cannot list it). | `core/security.mjs assertTransportAllowed`, `app.mjs` step 2 | Good. Tests cover only `/v1/health` and one test route today. **Gap: no test over every write route.** T-sec-1 adds it. |
| F3 | The sign-in admin key lives 30 days, though the tab forgets it on close. | `auth/signIn.mjs SIGN_IN_KEY_TTL_MS` | Acceptable (loopback-only creation, hashed at rest). LATER item noted. |
| F4 | Non-GET routes with `auth: "none"`: only `POST /v1/sign-in` (loopback only, one-time 256-bit code). `auth: "custom"`: `/hooks/:source/:token` (URL token plus optional HMAC and IP allowlist; public ingress) and `/api/v1/*` compat (key in the JSON body; default body mode is JSON, so `text/plain` gets 415). | route tables | Good. Lock it with an allowlist test (T-sec-2), so a new `auth: "none"` write route fails CI. |
| F5 | `?key=` is accepted only on routes with `allowQueryKey`, and only for read keys. All four such routes are GET. | `integrations/module.mjs`, `app.mjs` | Good. Test: no non-GET route has `allowQueryKey` (T-sec-2). |
| F6 | WebSocket upgrades run the same Host and Origin check. | `app.mjs handleUpgrade` | Good. Test every registered upgrade path, not one (T-sec-3). |
| F7 | A browser that sends `Sec-Fetch-Site: cross-site` but **no** `Origin` on a write gets past the Origin check. Modern browsers send Origin on every cross-origin POST/PUT/PATCH/DELETE, so this is defence in depth only. | `assertTransportAllowed` passes when Origin is absent | **Change:** `assertNotCrossSiteWrite`: for methods other than GET/HEAD/OPTIONS, `Sec-Fetch-Site` ∈ {`cross-site`, `same-site`} with no allowlisted or same-origin `Origin` → 403 `ORIGIN_NOT_ALLOWED`. Non-browser clients never send `Sec-Fetch-*`, so nothing legitimate breaks. `same-site` is included because `http://localhost:5173` and `http://127.0.0.1:4300` are same-site. |
| F8 | `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `script-src 'self'`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: no-store` on every response. | `BASE_HEADERS`, `DASHBOARD_CSP` | Good. A test asserts them on one route of every module (T-sec-5). |
| F9 | MCP: order tools are hidden unless config and scope `paper` allow; `mode: "live"` is not in the enum without `live`; `mcp` keys cannot hold `admin`; a hidden tool and an unknown tool answer identically. | `mcp/tools.mjs`, `auth/keyStore.mjs` | Good. Tests exist for parts. T-sec-6 makes it a matrix (read / paper / live × toolsets). |

New write endpoints in this item: `POST /v1/readiness/check` (scope `read`; it changes no state beyond a cache refresh and is bounded by cooldown) and `POST /v1/demo/readiness` (demo only). Both are covered by the generic tests.

---

## 4. API changes

All routes: `x-stream: S20`, JSON `{ data, meta }`, Problem errors as today, demo labelling as today. Account visibility follows `accountFilter(ctx)` from `safety/routes.mjs` (reuse it; do not copy it).

### 4.1 `GET /v1/readiness` (scope `read`)

Query: `account` (optional, repeatable up to 20; unknown → 404 `ACCOUNT_NOT_FOUND`; not visible to key → 403 `ACCOUNT_FORBIDDEN`).
No broker call and no lookup: it returns cached state. p95 ≤ 20 ms.

200:
```json
{
  "data": {
    "overall": "cannot_trade",
    "summary": "1 of 2 live accounts cannot trade",
    "checkedAt": "2026-10-29T10:12:31+05:30",
    "accounts": [ { "...": "AccountReadiness (§3.4)" } ],
    "paperOnly": false,
    "egress": { "mode": "lookup", "checkedAt": "2026-10-29T10:12:29+05:30", "family": "ipv4", "seenBy": "api.ipify.org",
                "ip": "198.51.100.23", "clockSkewMs": 310, "lastError": null },
    "schedule": { "intervalMinutes": 4, "window": { "from": "08:45", "to": "15:45" }, "inWindow": true,
                  "tradingDay": true, "calendarSource": "reference" , "nextCheckAt": "2026-10-29T10:16:31+05:30",
                  "preOpen": { "at": "09:00", "lastRunDate": "2026-10-29", "nextRunAt": "2026-10-30T09:00:17+05:30" } },
    "automations": { "total": 3, "live": 1, "cannotTrade": 1 },
    "notifications": { "targetsListening": ["phone"], "warning": null, "demoOff": false },
    "method": "Session: the broker's stated expiry plus a read call every 4 minutes from 08:45 to 15:45 IST on trading days. Egress IP: as seen by the lookup service you chose, which can differ from what your broker sees. Order headroom: the Bridge's own caps; broker and exchange counters are not visible."
  },
  "meta": { "requestId": "req_…" }
}
```
- `overall` is the worst state over the visible accounts with `allowedByConfig` (§7.1). It is `paper_only` when none qualify (`paperOnly: true`).
- `egress.ip` and `egress.seenBy` are only present for loopback or admin callers.
- `notifications.warning`: `"No notification target listens to trading.readiness. Add it to notify.targets[].events."` or `null`. `demoOff: true` in demo.

### 4.2 `POST /v1/readiness/check` (scope `read`)

Body (optional): `{ "account": "zerodha-main" }` (strict; omitted = every visible account).
Runs `check({ accountId, reason: "manual" })`. It probes subject to the 30 s cooldown and runs the egress lookup subject to a 30 s cooldown of its own. It waits at most 12 s, then returns what it has (the slow parts carry `status: "unknown"` with message "Still checking").
200: the same body as §4.1, plus `meta.skipped`: `["probe:zerodha-main:cooldown", "egress:cooldown"]`.
Errors: 400 `VALIDATION_FAILED`, 403 `ACCOUNT_FORBIDDEN`, 404 `ACCOUNT_NOT_FOUND`, 429 `RATE_LIMITED` (per-key client limit, as every route).

### 4.3 `GET /v1/readiness/history` (scope `read`)

Query: `account` (optional), `limit` 1..200 (default 50).
200: `{ "data": [ { "at", "accountId", "from", "to", "codes": ["IP_MISMATCH"] } ], "meta": { "requestId", "kept": 200 } }`, newest first. Only accounts visible to the key.

### 4.4 `POST /v1/demo/readiness` (demo mode only; scope `read`; registered only when `config.demo`)

Scope is `read` rather than `admin`/loopback so the public demo (`server.remoteDashboard`) can use it. It touches only simulated in-memory state and restores itself after `restoreAfterMinutes` (10).
Body: `{ "scenario": "session-expired" | "session-expiring" | "ip-changed" | "ip-unchecked" | "daily-loss-near" | "daily-orders-exhausted" | "restore" }`.
200: the §4.1 body. 404 when not in demo (the route does not exist).

### 4.5 OpenAPI additions (`docs/openapi.yaml`, disciplined layout read by `core/openapi.test.mjs`)

Tag (after Safety): `- name: Readiness` / `description: Whether each live account can trade now: session, static IP, order headroom, kill switch (H5).`

```yaml
  /v1/readiness:
    get:
      tags: [Readiness]
      operationId: getReadiness
      summary: Trading readiness of each live account (cached; no broker call)
      x-stream: S20
      x-scope: read
      parameters:
        - { name: account, in: query, required: false, schema: { type: array, maxItems: 20, items: { $ref: "#/components/schemas/AccountId" } }, style: form, explode: true }
      responses:
        "200":
          description: Readiness snapshot.
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { $ref: "#/components/schemas/Readiness" }
                  meta: { $ref: "#/components/schemas/Meta" }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }

  /v1/readiness/check:
    post:
      tags: [Readiness]
      operationId: checkReadiness
      summary: Re-check now (probe and egress lookup, each with a 30 s cooldown)
      x-stream: S20
      x-scope: read
      requestBody:
        required: false
        content:
          application/json:
            schema: { type: object, additionalProperties: false, properties: { account: { $ref: "#/components/schemas/AccountId" } } }
      responses:
        "200":
          description: Readiness snapshot after the check.
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { $ref: "#/components/schemas/Readiness" }
                  meta:
                    allOf:
                      - { $ref: "#/components/schemas/Meta" }
                      - { type: object, properties: { skipped: { type: array, items: { type: string } } } }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }

  /v1/readiness/history:
    get:
      tags: [Readiness]
      operationId: getReadinessHistory
      summary: Recent readiness transitions (newest first)
      x-stream: S20
      x-scope: read
      parameters:
        - { name: account, in: query, required: false, schema: { $ref: "#/components/schemas/AccountId" } }
        - { name: limit, in: query, required: false, schema: { type: integer, minimum: 1, maximum: 200, default: 50 } }
      responses:
        "200":
          description: Transitions.
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { type: array, items: { $ref: "#/components/schemas/ReadinessTransition" } }
                  meta: { $ref: "#/components/schemas/Meta" }
        "4XX": { $ref: "#/components/responses/Problem" }
        "5XX": { $ref: "#/components/responses/Problem" }

  /v1/demo/readiness:
    post:
      tags: [Readiness]
      operationId: demoReadinessScenario
      summary: Demo mode only - simulate a readiness failure on the demo account (restores itself after 10 minutes)
      x-stream: S20
      x-scope: read
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              required: [scenario]
              properties:
                scenario: { type: string, enum: [session-expired, session-expiring, ip-changed, ip-unchecked, daily-loss-near, daily-orders-exhausted, restore] }
      responses:
        "200":
          description: Readiness snapshot after the scenario.
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { $ref: "#/components/schemas/Readiness" }
                  meta: { $ref: "#/components/schemas/Meta" }
        "4XX": { $ref: "#/components/responses/Problem" }
```
`core/openapi.test.mjs` boots a non-demo app, so the demo route is not registered there. Add `"POST /v1/demo/readiness"` to the demo-only exclusion list that F0 creates (P1-4 adds `/v1/demo/feed` the same way). Mark the operation `x-demo-only: true`.

Schemas (components): `Readiness`, `AccountReadiness`, `ReadinessCheck` (`status` enum `[pass, warn, fail, unknown, n/a]` plus open properties), `ReadinessReason` (`check`, `code` (string; documented open enum), `severity` enum `[warn, fail]`, `message`), `ReadinessState` (enum `[ready, warn, cannot_trade, paper_only, unknown]`, documented as open), `ReadinessTransition`, `ReadinessAutomation`. `HookRecord` += `readiness` (`ReadinessState`, nullable; null for paper hooks). `SafetyStatus` is unchanged. Error code `CANNOT_TRADE` is added to the Problem `code` description list.

AsyncAPI: no change this round (LATER).

### 4.6 MCP

No new tool. The default toolsets stay at 18 tools (cap under 20); every Phase 1 options tool goes in the opt-in `options` toolset that F0 adds, so this spec only extends an existing tool. `get_safety_status` items gain `readiness: { state, reasons: [{ code, message }], checkedAt }` (IP fields never included, for any key). The description gains: "readiness says whether the account can trade now (session, static IP, limits)". The output schema is already loose (`z.looseObject`).

### 4.7 Errors

| Code | When |
|---|---|
| `CANNOT_TRADE` (403, new) | Automated live send while the account is `cannot_trade`, or `unknown`/stale after `ensureFresh`. `detail` lists the reasons. `errors: [{ path: "readiness.<check>", message }]`. |
| existing | 400 `VALIDATION_FAILED`, 401, 403 `SCOPE_REQUIRED` / `ACCOUNT_FORBIDDEN` / `ORIGIN_NOT_ALLOWED`, 404, 429 |

---

## 5. Demo mode

Goal: every state, notification and gate in this spec can be seen and clicked in `mc-bridge start --demo`, including the public demo.

`demo/demoReadiness.mjs` builds a **simulated live view** of the `demo` account. It never changes `safety.liveTrading`.

| Simulated fact | Default value | Notes |
|---|---|---|
| `live` | `{ globalLiveTrading: "simulated", accountLiveEnabled: "simulated", allowedByConfig: true }` | Row chip "Simulated live account" |
| Session | connected; `expiresAt` = next 06:00 IST (a Zerodha-like stated expiry, `expirySource: "simulated"`); probe `ok` via the demo adapter's local `testConnection` | `session-expiring` sets expiry to now + 25 min (warn); `session-expired` makes the probe answer `SESSION_LOGIN_REQUIRED` and sets the state to expired |
| Registered IP | `203.0.113.10` (TEST-NET-3, documentation range) | Never a real address |
| Egress | `203.0.113.10`, `seenBy: "demo (simulated lookup)"` | `ip-changed` → `198.51.100.23` (TEST-NET-2); `ip-unchecked` → mode off |
| Order headroom | Real `safety.limits("demo-paper")` figures (paper counters, so placing paper orders in the demo moves them), relabelled "paper counters (demo)" | `daily-loss-near` overlays `pnlToday = −0.85 × limit`; `daily-orders-exhausted` overlays `used = limit` |
| Kill switch | Real (`/v1/safety/kill-switch` works in demo) | Engaging it in the demo flips the badge at once |
| Automations | Two `kind: "sample"` automations on `demo`: "Sample guard: NIFTY short strangle, max loss ₹5,000" (mode `live`, simulated) and "Sample webhook: breakout alert" (mode `live`, simulated) | Shown with a "Sample" chip; they have no rules and never send anything |
| Notifications | Notifier is off in demo (existing rule). The monitor still computes `notify: true/false`. The Safety card lists the last 10 messages under "Would have been sent" (formatted by `notify/format.mjs`). | Shows exactly the Telegram text |
| Schedule | Window and trading-day checks are ignored; interval 1 min | So the demo works on a Sunday evening |

`restoreAfterMinutes: 10`: any scenario reverts by itself, and a timer re-evaluates. On the public demo, one visitor's scenario is visible to others for at most 10 minutes. The demo card says so: "Simulations are shared by everyone viewing this demo and reset after 10 minutes."

Deterministic day script (so a screenshot taken without clicking still shows a non-trivial state): none. The default is all `ready` except egress `IP_NOT_REGISTERED` is avoided by the simulated registration. A first-time viewer sees "Ready (simulated)" and the four buttons below it.

---

## 6. Dashboard

### 6.1 Placement

| Surface | Change |
|---|---|
| Toolbar (every page) | New slot `<span id="toolbar-ready" class="toolbar-ready" hidden></span>` in `index.html`, between `#toolbar-demo` and `#clock`. Mounted by `app.js` after sign-in. |
| Safety page (`views.js renderSafety`) | New card "Trading readiness" between the kill-switch card and "Live trading". |
| Home page | The existing Safety card (`views.js` ~l.980) adds one readiness pill next to the kill-switch pill. |
| Order ticket / strategy place | No code change: the readiness line arrives as a preview check (`severity: warn` or `block`) and renders like other checks. |
| Webhooks list (Integrations) | Live hooks show the `readiness` pill from `GET /v1/hooks`. |

### 6.2 `readiness.js` (new; pure view-model + small renderers)

- `badgeModel(snapshot, { width })` returns `{ cls: "ok"|"warn"|"bad"|"", text, short, aria, dot }`.
  - `ready` → ok, "Ready", short "Ready"; `warn` → warn, "Check: <first reason short>"; `cannot_trade` → bad, "Cannot trade: <brokerName or label>" (with 2 or more accounts: "Cannot trade: 2 accounts"); `paper_only` → neutral, "Paper only"; `unknown` → neutral, "Checking…" (or "Not checked" when stale).
  - Demo appends " (simulated)" to `aria` and `title`, not to the visible text (the toolbar already shows "Demo").
- `rowsModel(snapshot, { canSeeIp })` returns one row per account: title, state pill, up to 3 reason lines, and four fact lines:
  - Session: "Until 06:00 tomorrow (broker's stated time) · read call OK at 10:12", or "No stated expiry · read call OK at 10:12".
  - IP: "Matches registered IP", "Does not match registered IP (as seen by api.ipify.org)", "Not checked: lookup is off" or "Registered IP not set". With `canSeeIp`, "198.51.100.23 vs 203.0.113.10" follows on a second, muted line.
  - Orders: "5/s cap, 0 used · 63 of 100 orders left".
  - Loss: "₹1,750 of ₹10,000 daily loss left", using `formatRupee` from `format.js`.
  - Kill switch: "Off" or "On since 10:02 (reason)".
  - Automations: "1 live automation cannot trade: ChartInk breakout".
- Copy is descriptive (D7): no "safe", "recommended" or "you should". A test greps the module.

### 6.3 Badge interactions

- Data: `GET /v1/readiness` on mount, every 30 s while `document.visibilityState === "visible"`, on `visibilitychange` to visible, and right after any kill-switch action. Local only (no broker calls). Errors keep the last state and add "(last checked 10:12)". A 401 hides the badge.
- Click/tap/Enter opens `sheetPopover({ trigger, title: "Trading readiness", body })` from `app.js`. That existing helper is already a bottom sheet below 720 px and an anchored popover from 720 px up, traps Tab, closes on Escape and returns focus. No new popover code.
- Popover/sheet content: the `rowsModel` rows, then three buttons:
  - **Check now** (`POST /v1/readiness/check`; spinner; "Checked 10:14" toast).
  - **Stop all orders** (reuses the Safety page `engage` modal; extract that function from `renderSafety` into an exported `confirmEngageKillSwitch()` so both call one implementation).
  - **Open Safety** (`#/safety`).
  - When `notifications.warning` is set, a one-line note with a link to `docs/guides/notifications.md`.
- Keyboard: the badge is a `<button>`, Escape closes, and focus returns to the badge. Touch target ≥ 44 px. `aria-live` stays off by default (BRD §7.4). The badge `aria-label` carries the full text.

### 6.4 Safety card "Trading readiness"

- Header: overall pill, "Checked 10:12 · next 10:16 · pre-open 09:00 (ran today)", and a **Check now** button.
- Body, desktop: a table with one row per live account and columns Account | State | Session | Static IP | Orders | Daily loss | Kill switch | Automations. Each cell shows `check.status` as a pill plus a fact line. Phone and tablet: one stacked card per account (the same rows as the popover).
- "Recent changes": the last 10 items from `GET /v1/readiness/history` ("10:12 Main: ready → cannot trade (IP mismatch)").
- "How this is checked": the `method` text and links to `docs/guides/deployment.md` and `safety.md`.
- Egress settings: read-only. It shows the mode and a copyable config snippet for `readiness.egressIp` (editing config from the dashboard is not in scope). With the mode off, the copy reads: "Lookup is off, so a changed internet address is found only when the broker refuses an order. Turning it on sends a request to a service you choose every 4 minutes during market hours; that service sees your IP address."
- Demo only: a segmented control with the scenarios from §4.4 ("Expire session", "Change IP", "Use up daily loss", "Restore"), and a "Would have been sent" list.

### 6.5 Phone, tablet, desktop

| Width | Badge | Detail |
|---|---|---|
| < 720 px (phone) | 44 × 44 icon button: `power` glyph with a state dot (`data-ready="ok|warn|bad|none"`); text hidden; `aria-label` full | `sheetPopover` bottom sheet, rows stacked, buttons full-width |
| 720–1023 px (tablet) | `pill` with dot + `short` text | `sheetPopover` popover, rows stacked, scroll inside |
| ≥ 1024 px (desktop) | `pill` with dot + `text` (ellipsis at 28 ch) | `sheetPopover` popover; Safety card table |

Breakpoints follow the existing `sheetPopover` 720 px split. No horizontal page scroll at 360 px (16 px gutter). The Safety table becomes cards below 1024 px. `polish.test.mjs` gets `readiness.js` in its page list (44 px targets, no colour literals).

### 6.6 CSS (`app.css`; three rules, tokens only)

The badge on tablet and desktop is a plain `pill()` (existing `.pill.ok/.warn/.bad` rules). For the phone icon only: `.toolbar-ready[data-ready="ok"] .pdot { background: hsl(var(--ios-green)) }`, `warn` → `hsl(var(--warn))`, `bad` → `hsl(var(--ios-red))`. No other new styling. The restyle team owns the final look and may remap these to its new tokens.

### 6.7 Accessibility

State is never colour-only. The text says "Cannot trade", and pills carry the word. The phone icon button exposes the state through `aria-label`. Tables have `<th scope>`. Times are shown as "10:12" with `<time datetime>`.

### 6.8 Notification message (`notify/format.mjs`, case `trading.readiness`)

- `kind: "change"`, state `cannot_trade`: title `"<BrokerName> <label or id>: cannot trade"`. Text: the reasons joined with "; ", then "Automated orders on this account are paused." when `automations.live > 0`, then the remedy line for the first failing check:
  - Session: "Log in again: mc-bridge accounts connect <id>, or the Accounts page."
  - IP: "Check your internet connection or VPN; see the deployment guide."
  - Limits: "Daily limit reached; it resets at midnight IST."
  - Kill switch: "Release it on the Safety page if this was not intended."
- Example (the BRD's): **"Dhan dhan-main: cannot trade"** / "The broker session has expired. Automated orders on this account are paused. Log in again: mc-bridge accounts connect dhan-main, or the Accounts page."
- `kind: "preopen"`: title `"09:00 readiness: <n> account(s) cannot trade"` (or "need attention" for `warn` only). Text: one line per account.
- `kind: "recovered"` (when `notify.onRecovery`): title `"<BrokerName> <label>: ready again"`.
- Never included: IP addresses, the lookup host, tokens, broker client codes. Account id and label are the user's own local names.
- Holiday caveat (when there is no calendar): appended to `preopen` only.

### 6.9 OrderService readiness line (S7)

- `place`/`preview` with `mode: "live"` call `readinessLine(ctx, accountId)` before `safety.check`:
  - `src = effectiveSource(ctx)`.
  - If `AUTOMATED_SOURCES.includes(src)` and `cfg.gateAutomated`: get `canTrade`. If `stale` or `unknown`, `await ensureFresh(accountId, { timeoutMs: 5000 })`. If the state is `cannot_trade`, or still `unknown`/stale → **block** `CANNOT_TRADE` with path `readiness`. The audit gets `order.refused` with `data.codes` (existing refusal path).
  - Else, if the state is `cannot_trade` or `warn` → check `{ code: "READINESS", severity: "warn", message: "Readiness: <state>: <reasons>" }`.
- When `deps.readiness` is a stub (module disabled): no line. This is the back-compat path.
- Paper orders: no readiness line (paper never needs the broker session).

---

## 7. Formulas (pure functions in `readiness/checks.mjs` and `ip.mjs`, each with a reference-value test)

### 7.1 Combining checks into a state

Severity of a check: `fail` > `unknown` > `warn` > `pass`, with `n/a` ignored.
```
if !live.allowedByConfig                              → paper_only   (checks still computed and shown)
else if any check.status = fail                       → cannot_trade
else if session.status = unknown or (age(checkedAt) > staleAfterMinutes)  → unknown
else if any check.status ∈ {warn, unknown}            → warn
else                                                  → ready
overall = worst over accounts with allowedByConfig, order: cannot_trade > unknown > warn > ready; none → paper_only
```
Only the session check being `unknown` makes the account `unknown`. An unknown egress (lookup failed) is only `warn`, because the lookup is an optional, third-party aid.

### 7.2 Session check

Inputs: `s = accounts.status(id)` (`state`, `expiresAt`), the last probe `p` (`ok | rejected | error | skipped`, `at`), `now`, `W = warn.sessionExpiresWithinMinutes`, and today's session close `C` (from reference, else 15:30 IST).
```
state ∈ {expired, missing}          → fail  (SESSION_EXPIRED / SESSION_MISSING)
state = error                       → fail  (SESSION_ERROR)
p = rejected (after s connected)    → fail  (SESSION_REJECTED)        // AccountManager also marks expired
state = checking or no probe yet    → unknown
p = error (timeout, 5xx)            → warn  (PROBE_FAILED)            // a broker hiccup is not proof of expiry
expiresAt ≠ null and expiresAt − now ≤ W min and expiresAt ≤ C + 15 min   → warn (SESSION_EXPIRES_SOON)
expiresAt = null                    → pass with note NO_STATED_EXPIRY (shown, not a reason)
else                                → pass
expiresInMinutes = floor((expiresAt − now) / 60000)
```
Worked example: Upstox, connected at 08:40, `expiresAt` 03:30 IST the next day, now 10:00. That is 1,050 min left. The expiry is after C + 15 min (15:45), so → **pass**, "Until 03:30 tomorrow". Second case: a broker that states "valid until 15:00", now 14:10. That is 50 min ≤ 60 and 15:00 ≤ 15:45, so → **warn** "Session ends at 15:00 (in 50 min), before the market closes".

### 7.3 Egress check

```
mode = off                               → n/a for state; status "unknown" shown with IP_UNCHECKED (warn only if registeredIp set)
registeredIp unset and backupIp unset    → warn IP_NOT_REGISTERED
normaliseIp(registeredIp) = null         → warn IP_INVALID_CONFIG
mode = manual                            → compare manualIp; never fail on age ("as entered")
lookup failed or older than 2 × interval → warn IP_LOOKUP_FAILED
family(detected) ≠ family(registered) and ≠ family(backup)  → warn IP_FAMILY_DIFFERS
sameIp(detected, registered) or sameIp(detected, backup)    → pass
else                                     → fail IP_MISMATCH
```
`normaliseIp`: trim; strip `::ffff:` from IPv4-mapped addresses; IPv4 must be four 0–255 decimal octets without leading zeros. IPv6 is lower-cased and expanded to 8 groups for comparison (`node:net isIPv6` plus an expansion), with zone ids refused. Reference tests: `"::ffff:203.0.113.10"` = `"203.0.113.10"`; `"2001:DB8::1"` = `"2001:db8:0:0:0:0:0:1"`; `"203.0.113.010"` → null.
`parseLookupBody`: a `text/plain` body = first line trimmed. JSON = `ip` or `query` or `origin` (first token before a comma). Max 1 KB, else error.
Worked example: registered `203.0.113.10`, backup unset, lookup returns `198.51.100.23` (IPv4) → **fail** IP_MISMATCH → account `cannot_trade`. Lookup returns `2001:db8::5` → **warn** IP_FAMILY_DIFFERS ("Your lookup service answered over IPv6; brokers register IPv4. Choose an IPv4-only lookup URL.").

### 7.4 Order headroom

From `safety.limits(id)` (live figures, top level):
```
rateHeadroom = max(0, orderRatePerSecond − ordersLastSecond)       rateHeadroom = 0 → warn RATE_CAP_REACHED (transient)
ordersLeft   = max(0, dailyMaxOrders − ordersToday)
   ordersLeft = 0 → fail DAILY_ORDERS_EXHAUSTED ; ordersLeft ≤ ceil(dailyMaxOrders × dailyOrdersLeftPct/100) → warn DAILY_ORDERS_LOW
lossLeft     = max(0, dailyMaxLoss + min(0, realisedPnlToday))
   lossLeft = 0 → fail DAILY_LOSS_REACHED ; lossLeft ≤ dailyMaxLoss × dailyLossLeftPct/100 → warn DAILY_LOSS_NEAR
broker       = scheduler.headroom(id, "order") ; backoffMs > 0 (from usage()) → warn BROKER_ORDER_BACKOFF
```
Worked example: limits 5/s, 100 orders, ₹10,000. Usage: 0 in the last second, 37 orders, P&L −₹8,250.
- rateHeadroom = 5 → pass.
- ordersLeft = 63 > ceil(100 × 0.10) = 10 → pass.
- lossLeft = 10,000 + (−8,250) = 1,750 ≤ 10,000 × 0.20 = 2,000 → **warn** DAILY_LOSS_NEAR ("₹1,750 of ₹10,000 daily loss left").
- At P&L −₹10,000 or worse → lossLeft 0 → **fail** (safety would refuse the order anyway; readiness says so in advance).

The P&L used is the same "live day P&L" that safety reads: realised plus open for live (`syncDayPnl`). Readiness does not fetch P&L itself; it shows what safety last saw, with that `asOf`.

### 7.5 Detection latency bound (acceptance: "within 5 minutes")

```
T_detect ≤ intervalMinutes × 60 + jitter_max + max(probe.timeoutMs, egressIp.timeoutMs)/1000 + debounce
         = 240 + 30 + 10 + 0.25 = 280.25 s  < 300 s
```
Event-driven paths: AccountManager's expiry timer fires at `expiresAt + 5 ms` → `account.status` → re-evaluation in under 1 s. A scheduled call failing with a session error → `account.session_rejected` → under 1 s. The config validator refuses an `intervalMinutes` for which the bound exceeds 300 s, with a warning, not an error: `intervalMinutes` > 4 logs "Readiness can take up to N minutes to notice an IP change".

### 7.6 Clock skew

`skewMs = Date.parse(response.headers.date) + 500 − midpoint(requestStart, responseEnd)`. The +500 ms compensates the 1 s resolution of the header. `|skewMs| > maxSkewMs` → reason `CLOCK_SKEW` (warn, egress check): "This computer's clock is off by about 7 s. Times in orders and the 09:00 check may be wrong." Reference test: Date `Thu, 29 Oct 2026 04:42:30 GMT`, request 10:12:29.800 IST, response 10:12:30.200 IST → midpoint 10:12:30.000 → skew = 30.000 + 0.5 − 30.000 = +500 ms → pass.

### 7.7 Notification dedupe

```
key = state + ":" + sorted(failing and warning reason codes).join(",")
notify on change when:
   to = cannot_trade and (key ≠ lastNotifiedKey or now − lastNotifiedAt ≥ cooldownMinutes)
   to ∈ {ready, warn} from cannot_trade and notify.onRecovery          (kind "recovered")
   warn is never notified on change (badge and pre-open only)
pre-open: once per IST date, for accounts with state ∉ {ready, paper_only}; preopenOnlyIfFailing=false also sends "all ready"
```
Worked example: at 10:12 IP_MISMATCH → notify. At 10:16 still IP_MISMATCH → same key, 4 min < 15 → no. At 10:20 SESSION_REJECTED is added → new key → notify. At 10:24 the user logs in and the IP is fixed → `recovered` → notify.

### 7.8 Next pre-open run

`nextPreOpenAt(now)` = the first instant t > now with `istTime(t) = preOpenAt + jitter`, `isTradingDay(istDate(t))` and `lastRunDate ≠ istDate(t)`. Reference test: Friday 30 Oct 2026 16:00 IST → Monday 2 Nov 2026 09:00:jj IST. With the P1-2 calendar and a holiday on Monday → Tuesday.

### 7.9 Staleness

`stale = now − checkedAt > staleAfterMinutes × 60000` (default 10 min, which is 2.5 × the interval). Outside the window, accounts are not probed, so state goes stale overnight by design. Automated sends then call `ensureFresh`. The badge shows "Not checked since 15:44" in neutral.

---

## 8. Rate-limit and resource budget

| Activity | Per live account per trading day | Class / priority | Bound |
|---|---|---|---|
| Probe (`testConnection`, through `scheduler.schedule`) | window 420 min / 4 = 105 cycles + 1 pre-open + events (cooldown 30 s) ≈ **≤ 110 calls** | `portfolio`, `background` | ≤ 1 call per 30 s per account; never coalesced with orders; yields to user calls |
| Egress lookup (third party, not a broker) | ≤ 106 per day (once per cycle, shared by all accounts) | not scheduled (no broker) | 1 KB response, 5 s timeout, redirect refused |
| `GET /v1/readiness` from the dashboard | 2/min per open tab | local | no I/O |
| Notifications | ≤ 1 per account per 15 min on change + 1 pre-open | notify queue | existing per-target pacing |

Test (`readiness/budget.test.mjs`): for every broker in `BROKER_POLICIES`, the probe rate (1 per 30 s worst case = 2/min) is ≤ 1% of that broker's `portfolio` (or group) per-minute limit, or ≤ 2% of its per-second × 60 when only a per-second limit is set. Any broker that fails is listed in the test with its policy, and readiness raises its cooldown for that broker: `cooldownSeconds = max(30, ceil(6000 / perMinute))`. That keeps every broker at or under 1%, applied in code via `scheduler.policyFor(broker)`.

`testConnection` per adapter hits a profile, funds or limits endpoint (varies by broker; see the adapters). Where an adapter's `testConnection` is heavier than a profile call (for example one that downloads a master), the readiness probe uses `capabilities.funds` through `schedule({ endpointClass: "portfolio" })` instead. T4 lists the adapters checked; Dhan, Zerodha and Upstox must be confirmed.

Memory: state for ≤ 50 accounts, a 200-item transitions ring, ≤ 500 automations. Disk: `state.json` < 64 KB.

---

## 9. Safety, compliance and honesty gates

- **Nothing loosens safety** (BRD §7.5). Readiness only adds a block (automated live) or a warning (human live). It never engages or releases the kill switch, never cancels, never sends.
- **Paper default unchanged.** Paper orders and paper automations ignore readiness.
- **Static IP rule (§8.1):** the deployment guide and the badge say plainly that a dynamic IP cannot place live API orders. We do not claim to know what the broker sees (§2.3).
- **Daily logout (§8.1):** the session check reports the stated expiry. The Bridge never automates logins or 2FA. The remedy copy tells the person to log in.
- **Algo framework (§8.1):** the gate keeps automated sends from firing into a broken session, which reduces rejected-order noise that brokers may count. No change to the 5/s cap or tags.
- **Privacy (§7.7, §7.9):** egress lookup off by default. The user chooses the URL. The IP is kept in memory only, shown only to loopback or admin callers, and never sent in notifications, logs (`logger.addSecret(ip)` redacts it), audit records or MCP results. The guide names that the lookup service sees the IP and when.
- **Notifications (§7.9):** no account identifiers beyond the user's own local id and label; no tokens or IPs. Test T-n2.
- **Honesty (D5, §7.6):** every line says where its fact came from: "broker's stated time", "read call OK at 10:12", "as seen by <host>", "as entered", "Bridge cap", "paper counters (demo)". Unknown is shown as unknown, never as ready.
- **Neutral copy (§8.1 RA rules):** a test greps `readiness.js` and `format.mjs` additions for `recommend|best|safe to|you should|buy|sell` (except "Stop all orders").
- **Demo cannot touch money:** demo forces live off. The simulated account is only a view, and the scenario route exists only in demo mode.
- **Security tests are CI gates** (§3.9): a new write route without a scope, an `auth: "none"` write, or a GET-only `allowQueryKey` violation fails the build.

---

## 10. Test plan

### 10.1 Unit (vitest, `environment: node`, fake clock and timers, no network)

| File | Covers |
|---|---|
| `server/bridge/readiness/checks.test.mjs` | §7.1 combine table (every row); §7.2 session cases incl. both worked examples, `NO_STATED_EXPIRY`, probe error → warn not fail; §7.4 headroom incl. worked example and the 0 boundaries; §7.7 dedupe sequence (the worked example, step by step); §7.8 next pre-open (Fri → Mon, holiday via injected calendar, already-ran-today); §7.9 staleness; `inWindow` at 08:44/08:45/15:45/15:46 IST on a UTC host |
| `server/bridge/readiness/ip.test.mjs` | `normaliseIp` reference cases (§7.3), `sameIp`, families, `parseLookupBody` text/JSON/`origin` comma list/oversize/garbage |
| `server/bridge/readiness/egress.test.mjs` | Stub `fetchImpl`: https required; http only for loopback; `redirect: "error"` passed; timeout → `IP_LOOKUP_FAILED`; skew from Date (§7.6 reference); the IP is never logged (null logger spy) |
| `server/bridge/readiness/monitor.test.mjs` | Timers: cycles only in window on trading days; pre-open once per day and persisted across a restart; startup outside window → no probe; bus triggers (`account.status`, `account.session_rejected`, `safety.kill_switch`, `safety.limit`) re-evaluate within 250 ms debounce; probe cooldown and singleflight; `safety.setDetectedEgressIp` called with the detected IP and with `null` when mode off; `trading.readiness` emitted with `notify` per §7.7; audit `readiness.changed` appended (soft-fail when audit is a stub); corrupt `state.json` → renamed + fresh; no egress IP in `state.json` |
| `server/bridge/readiness/automations.test.mjs` | register/update/remove; duplicate id refused; `onState` called per change for that account only; a throwing consumer does not block others; paper automation always `ready` |
| `server/bridge/readiness/routes.test.mjs` | `GET /v1/readiness` shape vs OpenAPI schema keys; account filter by key; `ACCOUNT_NOT_FOUND`/`ACCOUNT_FORBIDDEN`; IP fields present for loopback/admin, absent for a non-loopback read key; `POST /check` cooldown → `meta.skipped`; 12 s cap; `GET /history` limit and order |
| `server/bridge/readiness/budget.test.mjs` | §8 policy budget over `BROKER_POLICIES`; derived cooldown |
| `server/bridge/readiness/static.test.mjs` | No file in `readiness/` imports `orders/`, `paper/` or calls `placeOrder`/`modifyOrder`/`cancelOrder`; no `engageKillSwitch` call |
| `server/bridge/demo/demoReadiness.test.mjs` | Each scenario → expected state and reason codes; restore after 10 min (fake timer); TEST-NET addresses only; window ignored in demo |
| `server/bridge/orders/readinessGate.test.mjs` | Webhook live + `cannot_trade` → `CANNOT_TRADE`, `acquireOrderSlot` not called, adapter `placeOrder` count 0; webhook live + stale → `ensureFresh` called once, then pass/block; REST live + `cannot_trade` → warn check, order proceeds to `safety.check`; paper → no line; `gateAutomated: false` → warn only; readiness stub → no line |
| `server/bridge/hooks/routes.test.mjs` (add) | Live hooks registered at start and on create; removed on delete; `readiness` field in `GET /v1/hooks` |
| `server/bridge/notify/notify.test.mjs` (add) | `trading.readiness` formatting for change/preopen/recovered; BRD example text; `notify:false` not delivered; default events include the topic; **T-n2:** no IPv4/IPv6 pattern, no `mcb_` key pattern, no lookup host in any formatted message |
| `server/bridge/mcp/tools.test.mjs` (add) | `get_safety_status` includes `readiness` without IP fields |
| `server/bridge/dashboard/readiness.test.mjs` | `badgeModel` for all states × widths; demo aria suffix; `rowsModel` facts (§6.2 strings, ₹ grouping); `canSeeIp` false hides IPs; neutral-copy grep |
| `server/bridge/dashboard/polish.test.mjs` (add) | `readiness.js` in the page list |
| `server/bridge/core/config.test.mjs` (add) | `live.backupIp`; readiness config defaults; `preOpenAt` outside window refused; `intervalMinutes` > 4 warning |

### 10.2 Security and contract (CI gates; §3.9)

| ID | File | Assertion |
|---|---|---|
| T-sec-1 | `server/bridge/core/csrf.test.mjs` | Boot the real app (all modules, compat enabled, demo routes in a second demo app). For **every** route with method ≠ GET: (a) `Origin: https://evil.example` + a valid admin key → 403 `ORIGIN_NOT_ALLOWED` and the handler is not reached (spy via a wrapped route table, or assert no audit/side effect); (b) `Origin: null` → 403; (c) no Origin + `Sec-Fetch-Site: cross-site` → 403 (new guard); (d) `Sec-Fetch-Site: same-origin` with the same-origin Origin → passes the transport stage (then 401 without key); (e) routes with JSON body mode refuse `text/plain`, `application/x-www-form-urlencoded`, `multipart/form-data` with 415 when a body is sent (hooks excluded: `json-or-text` by design, token-protected); (f) an OPTIONS preflight from a foreign origin → 403 and no `Access-Control-Allow-Origin` |
| T-sec-2 | `server/bridge/core/routePolicy.test.mjs` | From `router.list()`: every route has `auth: "key"` with a `scope`, or appears in an explicit allowlist (`auth: "none"`: GET `/v1/health`, `/openapi.yaml`, `/`, `/dashboard*`, POST `/v1/sign-in` (must be `loopbackOnly`); `auth: "custom"`: `/hooks/:source/:token`, `/api/v1/*`, `/v1/stream/sse`). No non-GET route has `allowQueryKey`. Every `admin` route is `loopbackOnly` except `GET /v1/notify` (listed, read-only). |
| T-sec-3 | `server/bridge/core/upgrade.test.mjs` | Every registered upgrade path refuses a foreign Origin (403) and a foreign Host. |
| T-sec-4 | `server/bridge/core/routePolicy.test.mjs` | A request carrying only `Cookie: mcb=…` (no key) → 401 on a sample of every module's routes; a static grep: no `headers.cookie` read under `server/bridge/**` (tests excluded). |
| T-sec-5 | `server/bridge/core/app.test.mjs` (add) | `BASE_HEADERS` and dashboard CSP present on one route per module and on errors. |
| T-sec-6 | `server/bridge/mcp/tools.test.mjs` (add) | Matrix read/paper/live keys × toolsets with orders: read → `prepare_order` and `submit_confirmed_order` absent from `tools/list` and calling them returns the same answer as an unknown tool; paper → `mode` enum lacks `live`; live → has it; an `mcp` client key with `admin` cannot be created (existing test referenced). |
| T-sec-7 | `server/bridge/core/scopes.test.mjs` | For every route with a scope: a key with only a lower scope (`read` < `paper` < `live`; `admin` separate) → 403 `SCOPE_REQUIRED` before the handler (generic; covers every new write endpoint now and later). |
| T-sec-8 | `server/bridge/readiness/noSecrets.test.mjs` | After an e2e-like run with a fake adapter whose creds contain `TOKEN_SENTINEL_123`: `state.json`, captured logs, `trading.readiness` payloads and the formatted notifications contain neither the sentinel nor the detected IP string. |
| C-1 | `server/bridge/core/openapi.test.mjs` | New paths, scopes and stream `S20` match; demo-only exclusion list. |
| C-2 | `server/bridge/core/contracts` boot check | `readiness` contract methods present (existing `assertService`). |

### 10.3 End-to-end (`server/bridge/e2e/readiness.e2e.test.mjs`, real app on 127.0.0.1, `fixtures.mjs` stub broker, `shiftedClock(TRADING_DAY_10AM_IST)`)

Config: `safety.liveTrading: true`; account `stub-live` (stub broker, `live.enabled`, `allowedSources: ["rest", "webhook"]`, `registeredIp: "203.0.113.10"`); `readiness.egressIp: { mode: "lookup", lookupUrl: "http://127.0.0.1:<port>/ip" }` served by a test HTTP server whose answer the test changes; `readiness.intervalMinutes: 1` (the test asserts the computed bound too); a `notify` webhook target to a local capture server with `events: ["trading.readiness"]`; a live hook (mode live, generic source, signed).

1. **Ready:** the first `GET /v1/readiness` → `ready`; the hook shows `readiness: "ready"`; a `testkit.fakeAutomation` on `stub-live` reports `ready`.
2. **Session expiry:** the stub `testConnection` starts throwing `SESSION_LOGIN_REQUIRED`. Advance to the next cycle → state `cannot_trade` with `SESSION_REJECTED`; the fake automation's `onState` got `cannot_trade`; the capture server received one `trading.readiness` with title "… cannot trade". POST a signed webhook signal → the hook's signal record is `rejected` with `CANNOT_TRADE`; stub `placeOrder` call count stays **0**; the audit has `readiness.changed` and `order.refused`. Elapsed simulated time from fault to `cannot_trade` ≤ 300 s.
3. **Recovery:** the stub is healthy again; `POST /v1/accounts/stub-live/test` (or a reconnect) → `account.status` → `ready` within 1 s; a `recovered` notification.
4. **IP change:** the lookup server answers `198.51.100.23` → the next cycle → `cannot_trade` `IP_MISMATCH`; webhook refused; `placeOrder` 0; `GET /v1/safety` order preview by REST (`POST /v1/orders/preview`, live, rest source) shows a `READINESS` warning and the existing static-IP warning (now fed).
5. **Pre-open:** set the clock to the next trading day 08:59:30 with the IP still mismatched → at 09:00 + jitter exactly one `preopen` notification; restart the app at 09:05 → no second pre-open notification (persisted `lastRunDate`).
6. **Demo:** boot with `demo: true`; `POST /v1/demo/readiness {"scenario":"ip-changed"}` → `cannot_trade` (simulated), sample automations `cannot_trade`; after 10 simulated minutes → `ready`.

### 10.4 Manual checks (results in the PR)

- Phone 360 px, tablet 768 px and desktop 1440 px screenshots of the badge in each state and the Safety card, in the demo.
- A real Dhan or Zerodha account on a home connection: lookup on with `https://api.ipify.org`; registered IP set to a wrong value → badge `cannot_trade` within one cycle; Telegram message text checked for no IP.

---

## 11. Migration and back-compat

- All API changes are additive: new routes, a new optional field `readiness` on hooks and in the MCP `get_safety_status` output, and a new error code.
- **Behaviour change (documented in CHANGELOG and `safety.md`):** a **live webhook** order is now refused with `CANNOT_TRADE` while its account cannot trade. Every reason that causes `cannot_trade` (session gone, IP mismatch, daily limits, kill switch) would already make the order fail at the broker or at `safety.check`. The new cases are (a) an IP mismatch, which was a warning before and is a refusal at the broker from 1 Apr 2026, and (b) state still unknown after a 5 s `ensureFresh`. Escape hatch: `readiness.gateAutomated: false` (warning only), or `readiness.enabled: false`.
- Notify: targets without an explicit `events` list now also receive `trading.readiness` (new default). Targets with an explicit list are unchanged. `mc-bridge doctor` and the readiness response say when no target listens.
- `live.registeredIp` keeps its type. `live.backupIp` is new and optional.
- Config without a `readiness` section: defaults apply (lookup off, so no third-party call is ever made without the user's choice).
- `Sec-Fetch-Site` guard: browsers on allowlisted origins (`cors.allowedOrigins`) are unaffected. Non-browser clients never send the header.
- `readiness.enabled: false` → the service is still built (contract), but `status()` returns `{ overall: "unknown", disabled: true }`, `canTrade` returns `ok: true` with reason "readiness checks are off", and no timers run. OrderService adds no line.
- Data folder: new `readiness/` only. Removing it resets state, with no other effect.

---

## 12. Ordered task list (one engineer, one session; each task lands with its tests green)

| # | Task | Files | Done when |
|---|---|---|---|
| T1 | Core (lead): `readiness` contract, `orders.requires`, topic `trading.readiness`, `CANNOT_TRADE`, `live.backupIp`, `Source` doc, `builtinModules` entry with a stub-safe module skeleton | `core/contracts.mjs`, `eventBus.mjs`, `errors.mjs`, `config.mjs`, `context.mjs`, `builtinModules.mjs`, `readiness/module.mjs` (skeleton) | boot + existing tests green |
| T2 | Security baseline tests first (they must pass on today's code, except the new guard): T-sec-1 (a, b, d, e, f), T-sec-2, T-sec-3, T-sec-4, T-sec-5, T-sec-7 | `core/csrf.test.mjs`, `routePolicy.test.mjs`, `upgrade.test.mjs`, `scopes.test.mjs`, `app.test.mjs` | green; any real gap found is fixed in this task and listed in the PR |
| T3 | `assertNotCrossSiteWrite` + T-sec-1(c) | `core/security.mjs`, `app.mjs`, `security.test.mjs` | green |
| T4 | Pure `ip.mjs`, `checks.mjs` + tests (§7 reference values); confirm which adapters' `testConnection` is a light call (Dhan, Zerodha, Upstox at minimum) and note them in a comment | `readiness/ip.mjs`, `checks.mjs`, tests | green |
| T5 | `config.mjs`, `store.mjs`, `egress.mjs` + tests | readiness | green |
| T6 | `automations.mjs`, `monitor.mjs` (service: timers, bus, probe via scheduler, egress, persist, audit, emit, `setDetectedEgressIp`) + tests incl. budget and static tests | readiness | green |
| T7 | Routes + module register/start/stop + OpenAPI (§4.5) + `openapi.test.mjs` demo exclusion | `routes.mjs`, `module.mjs`, `docs/openapi.yaml` | C-1 green |
| T8 | OrderService readiness line + `AUTOMATED_SOURCES` + `readinessGate.test.mjs` | `orders/orderService.mjs`, `modeDecision.mjs` | green |
| T9 | Hooks: register live hooks, `readiness` field, tests | `hooks/module.mjs`, `routes.mjs` | green |
| T10 | Notify: event, default, `notify:true` filter, format + T-n2 | `notify/*` | green |
| T11 | MCP `get_safety_status` readiness + T-sec-6 | `mcp/tools.mjs` | green |
| T12 | Demo: `demoReadiness.mjs`, scenario route, demo defaults + tests | `demo/*` | green |
| T13 | e2e `readiness.e2e.test.mjs` (§10.3 steps 1–6) + T-sec-8 | e2e | green |
| T14 | Dashboard: `readiness.js` view-model + tests; toolbar slot and badge polling; popover/sheet; extract `confirmEngageKillSwitch`; Safety card; Home pill; `DASHBOARD_FILES`; CSS 3 rules; polish list | `dashboard/*`, `core/app.mjs` | unit green; demo screenshots at 360/768/1440 |
| T15 | `mc-bridge doctor` checks | `core/cli.mjs`, `cli.test.mjs` | green |
| T16 | Docs: `deployment.md` (outline below), `safety.md` (readiness row + gate), `compliance.md` (static IP links to deployment), `notifications.md` (`trading.readiness`), `ARCHITECTURE.md` §8 (§3.9 table), `STREAMS.md` S20, `bridge.config.example.json`, CHANGELOG | docs | review |

`docs/guides/deployment.md` outline:
1. Why it matters: SEBI's retail algo framework requires API orders to come from a static IP registered with the broker (primary + optional backup; **needs verification** per broker). Data calls generally work from anywhere. A dynamic home IP or a mobile hotspot will have live orders refused.
2. Options:
   - (a) Static IP from your ISP for a home PC (cost and availability vary; ask the ISP).
   - (b) A small Linux VPS in India with a static IPv4 (approximate monthly cost; **needs verification**). Run the Bridge there, keep it on `127.0.0.1`, and reach the dashboard with `ssh -L 4300:127.0.0.1:4300`.
   - (c) A VPN or exit node with a dedicated IP (the broker sees the exit IP, so register that).
   - Never a public tunnel for `live` keys (BRD §7.9).
3. Register the IP with your broker (where to find it for Dhan, Zerodha and Upstox; **needs verification**). Set `live.registeredIp` (and `backupIp`).
4. Turn on the readiness lookup: choose an IPv4-only service, and understand that it sees your IP.
5. Daily routine: the 09:00 check, logging in each morning (daily logout), what the badge states mean.
6. Clock: keep NTP on.
7. Phones: reach the dashboard over your own VPN or SSH, not a public tunnel.
8. Troubleshooting table: reason code → what to do.

---

## 13. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Lookup sees a different IP from the broker route (split tunnel, dual WAN, IPv6), giving false `cannot_trade` that blocks webhooks | Medium | Medium | Family mismatch is warn only; "as seen by" labelling; the guide recommends IPv4-only lookup; `gateAutomated: false` escape hatch; `backupIp` |
| R2 | Probe passes but orders still fail (segment not enabled, order-time 2FA, broker-side IP check only on orders) | Medium | Medium | Copy says "read call OK", not "orders OK"; LATER typed static-IP rejection mapping; P1-10 pre-trade line |
| R3 | `testConnection` is heavy or rate-limited on some broker | Low | Medium | Through `scheduler.schedule` at background priority; derived cooldown; T4 audit of adapters; funds-call fallback |
| R4 | Gate refuses a webhook order that would have worked (stale state, monitor stuck) | Low | High (missed exit) | `ensureFresh` with a 5 s cap before refusing; the error lists reasons; audit; `gateAutomated` switch. Note for P1-12: an **exit** guard firing into `cannot_trade` must notify loudly with the prepared exit, never fail silently. |
| R5 | Notification fatigue (flapping IP or probe errors) | Medium | Low | Cooldown 15 min, warn never pushed, probe errors are warn |
| R6 | Holidays without P1-2 cause a misleading 09:00 message | High until P1-2 | Low | Holiday caveat in the message; P1-2 calendar replaces it automatically |
| R7 | Public demo visitors flip each other's simulated state | High | Low | 10-minute auto-restore, "shared by everyone" note |
| R8 | The new `Sec-Fetch-Site` guard breaks a browser-based tool on an origin the user has not allowlisted | Low | Low | Such a tool was already refused by the Origin check; allowlisted origins pass |
| R9 | Stream id clash between specs | Resolved | — | Stream ids are fixed in `docs/spec/README.md` (reference S16, recorder S17, vol S18, fno S19, readiness S20, …); this spec uses S20 |
| R10 | Regulatory facts (static IP, daily logout, 10 ops) change or differ per broker | Medium | Medium | Every rule text in guides is **needs verification**; checks are config-driven (`registeredIp`, limits), not hard-coded rules |
| R11 | Vendor classed as an algo provider because the Bridge gates automated orders | Low | High | Readiness only refuses; it never initiates. BRD §8.1 legal review still gates H2 auto-exit and H3 send |
