# Mr. Chartist API Bridge: architecture

Status: **v2 design**. The code contracts this document describes live in `server/bridge/core/` and are enforced by tests; the HTTP contract is [`openapi.yaml`](openapi.yaml). Anything marked **(needs verification)** must be checked against a primary source before it ships to users.

## 1. What the Bridge is

One local service that holds a user's connections to **several brokers and several accounts at once**, and lets every tool share them: trading front ends, ChartInk/GoCharting and signed webhook alerts, AmiBroker, Python and Node scripts, Excel and Google Sheets, and AI assistants over MCP.

The headline problem is **broker rate limits**. Ten tools each polling a broker that allows 1 quote request a second cannot work. The Bridge makes the broker see one careful client: it serves from live streams first, then a short freshness-labelled cache, then batched and coalesced calls inside per-account token buckets, with orders always ahead of reads, and it can spread read-only market data over the user's *own* accounts once the user has accepted a notice that names the risk. Beyond the brokers, it can read from optional free sources and plugins the owner switched on, and labels every such answer with its data class and delay.

Design principles, in priority order:

1. **Safe by default.** Paper mode, loopback only, read-only keys, no market orders without protection, live trading only after three separate opt-ins in the config file plus a per-request `"mode": "live"`.
2. **Never exceed a documented limit.** Unknown limits get conservative defaults. Every number in the policy table carries a source and a `verified` flag.
3. **Honest data.** Every market-data value says where it came from, how old it is and how far to trust it (`freshness`: source, `class` realtime, delayed or eod, `delaySec`, `official`, `confidence`, `flags`). No silent fallbacks to another symbol, account, source or stale value. A delayed or end-of-day value never reaches an order, a risk check, a paper fill or an alert.
4. **One contract.** The 41 broker adapters (`server/brokers/`) already share a tested contract; the Bridge adds no second adapter model.
5. **Personal use.** One user (and family, as SEBI allows) on their own machine. Never a multi-user or public data service.

## 2. Process model

```
                         ┌──────────────────────── one Node.js 22+ process (mc-bridge start) ───────────────────────┐
 Web apps, scripts,      │  main listener 127.0.0.1:4300                                                             │
 Excel, AmiBroker,  ───► │   REST /v1/*  ·  SSE /v1/stream/sse  ·  WS /v1/stream  ·  /xl/*  ·  POST /mcp             │
 MCP relay (stdio)       │                                                                                           │
                         │  optional public-ingress listener (off by default): ONLY routes marked public (/hooks/*) │
 ChartInk, GoCharting  ─►│   reached through the user's tunnel or reverse proxy                                      │
 (via tunnel)            │                                                                                           │
                         │  services (deps): secrets · keyStore · audit · accounts · scheduler · symbols ·           │
                         │                   streamHub · marketData · safety · paper · orders                         │
                         │  broker layer: server/brokers/registry.mjs → 41 adapters → brokerFetch / createFeed       │
                         └───────────────────────────────────────────────┬───────────────────────────────────────────┘
                                                                         │ HTTPS / WSS (from the user's static IP for orders)
                                                                         ▼
                                                                 broker APIs and feeds
```

- **One process, one port.** REST, SSE, WebSocket upgrades, spreadsheet endpoints and MCP Streamable HTTP all share `127.0.0.1:4300`. No ZeroMQ, no second WebSocket port, no database server.
- **`mc-bridge mcp` is a relay**, not a second Bridge: it pipes stdio JSON-RPC from Claude Desktop, Claude Code or Cursor to the running Bridge's `POST /mcp` with the AI client's own key. A second process with its own broker sessions would double the rate-limit usage and bypass the shared safety state.
- **CLI commands** (`keys`, `accounts`, `doctor`) run in their own short-lived process against the same data directory. Every store writes atomically (temp file + rename) and the server re-reads a store when its file changes, so CLI edits apply without a restart.
- **Persistence is JSON files** in `dataDir` (default `./data`, created with mode 0700). No SQLite: the volumes are small, and plain files keep installs dependency-free and auditable.

```
data/
  master.key            32 random bytes, mode 0600 (unless MCB_MASTER_KEY is set)
  secrets.enc           AES-256-GCM encrypted broker credentials and session tokens   (auth)
  keys.json             API key records: scrypt hashes, scopes, accounts, expiry      (auth)
  audit/YYYY-MM-DD.jsonl  append-only, hash-chained audit log (IST days)              (safety)
  safety/               kill-switch state and daily counters                          (safety)
  readiness/state.json  last readiness state per live account                          (readiness)
  instruments/<broker>-YYYY-MM-DD.json  instrument master cache                       (symbols)
  orders/               idempotency records, clientOrderId map, live order index      (orders)
  paper/<accountId>.json  paper books                                                 (paper)
  hooks.json            webhook definitions (token hashes only)                       (hooks)
```

## 3. Module map

`server/bridge/core/` is the shared core. Every other directory belongs to exactly one module group. Each route in `openapi.yaml` names the module that registers it (`x-module`).

| Path | Module | Provides (deps key) | HTTP surface |
|---|---|---|---|
| `core/` | core | config, logger, bus, clock, paths, brokers; router, pipeline, errors, contracts, symbol codec, CLI | `/v1/health`, `/v1/meta`, `/openapi.yaml` |
| `accounts/` | accounts | `accounts` (AccountManager) | `/v1/brokers`, `/v1/accounts*` |
| `auth/` | auth | `secrets` (SecretStore), `keyStore` (KeyStore) | `/v1/keys*`, `/v1/stream/token` |
| `ratelimit/` | ratelimit | `scheduler` (Scheduler) | `/v1/limits` (`?explain=1`), `/v1/usage`, `/v1/quotas*` |
| `symbols/` | symbols | `symbols` (SymbolService) | `/v1/instruments/*`, `/v1/symbols/convert` |
| `market/` | market | `marketData` (MarketDataService) | `/v1/ltp`, `/v1/quotes`, `/v1/depth`, `/v1/history`, `/v1/expiries`, `/v1/optionchain` (all take `purpose`) |
| `stream/` | stream | `streamHub` (StreamHub) | WS `/v1/stream`, `/v1/stream/sse`, `/v1/stream/stats` |
| `events/` | events | (routes only; listens to the event bus) | WS `/v1/events/ws`, `/v1/events/stream` (SSE), `/v1/events*`, `/v1/subscriptions*` (signed webhooks out) |
| `orders/` | orders | `orders` (OrderService) | `/v1/orders*`, `/v1/trades`, `/v1/positions`, `/v1/holdings`, `/v1/funds`, `/v1/tickets/*` |
| `paper/` | paper | `paper` (PaperEngine) | `/v1/paper/*` |
| `safety/` | safety | `safety` (SafetyGuard), `audit` (AuditLog) | `/v1/safety*`, `/v1/audit*` |
| `integrations/` | integrations | (routes only) | `/xl/*` |
| `hooks/`, `mcp/` | hooks, mcp | (routes only) | `/hooks/{source}/{token}`, `/v1/hooks*`, `/mcp`, `mc-bridge mcp` |
| `sources/` | sources | `backupData` (BackupDataService: the sources service, with its router, health and failure memory) | `/v1/sources*` (list, switch on or off, key, test, trace), `/v1/pooling*` (consent) |
| `compat/` | compat | (routes only) | `/api/v1/*` apikey-in-body REST, WS `/api/v1/ws` |
| `readiness/` | readiness | `readiness` | `/v1/readiness*`: session, static IP, headroom, kill switch per live account; automated-send gate |
| `demo/` | core | demo adapter and config; `routes.mjs`: demo-only routes (`/v1/demo/*`, registered only in demo mode, `x-demo-only: true` in OpenAPI) | `/v1/demo/*` (demo mode only) |
| `server/brokers/`, `server/lib/` | | broker adapters and helpers; `server/lib/jsonl.mjs` is the shared append-only store helper | none directly |

**How modules plug in** (`core/modules.mjs`): each area has one `module.mjs` exporting `defineModule({ name, services, configKey?, configSchema?, register(app, deps), start?, stop? })`.

- Service factories run in dependency order taken from `SERVICE_CONTRACTS[*].requires` (`core/contracts.mjs`). A factory receives only the core deps plus the services it declared; touching anything else throws.
- `app.mjs` checks every service against its contract (`assertService`). An area that has not landed yet is a stub: it boots, and every method throws `NotImplementedError` (HTTP 501).
- `register(app, deps)` adds routes with `app.get/post/patch/delete(path, handler, options)` and WebSocket paths with `app.upgrade(path, handler)`. Route options: `auth` (`key` | `none` | `custom`), `scope`, `allowQueryKey`, `loopbackOnly`, `public`, `body` (`json` | `json-or-text` | `raw` | `none`), `bodyLimitBytes`.
- A module may own a config section (`configKey` + zod `configSchema`); unknown top-level config keys are errors.
- `core/openapi.test.mjs` fails if a registered route and `docs/openapi.yaml` disagree on path, method, scope, auth, loopback, public flag or owning module tag.

**Service dependency graph** (construction order):

```
secrets ─► accounts ─► scheduler ─► symbols ─► streamHub ─► marketData ─► paper ─┐
keyStore                                  backupData (sources) ─┘                 ├─► orders
audit ─────────────────────────────────────────────────────► safety ─────────────┘
```

## 4. Request pipeline and data flow

Every HTTP request (`core/app.mjs`):

1. Request id (`X-Request-Id` if sane) and baseline headers (`nosniff`, `no-store`, `DENY` framing, `no-referrer`).
2. **Host allowlist** (DNS rebinding) and **Origin allowlist** (CORS, no wildcard); `OPTIONS` answered here.
3. Route match (404, or 405 with `Allow`). On the public listener only `public` routes exist.
4. `loopbackOnly` routes refuse non-loopback peers (never trusts `X-Forwarded-For`).
5. Auth (`key` routes): `Authorization: Bearer`, `X-API-Key`, or `?key=` only where allowed and only for read-only URL keys → `keyStore.authenticate()` → scope check → per-key client limit (`scheduler.checkClient`).
6. Body: size-capped, JSON (or text for webhooks), raw bytes kept for signature checks.
7. Handler → JSON `{ data, meta }`, a typed `Reply` (text, CSV), 204, or a stream.
8. Access log: method, path **without the query string**, status, ms, key id. Never bodies or keys. The last 200 are also kept in memory for the dashboard (`GET /v1/requests`, this computer only); an entry for a market-data read also carries `route`, a short record of what answered it (stream, cache, a shared call, a live call or a stale value, with the source, its class and delay), built from the freshness labels the read already returned.

**Market-data read** (`GET /v1/quotes?symbols=…`):

```
route (market) ─► symbols.resolve ─► streamHub.lastTick fresh enough? ──yes──► item (source: stream)
                                        │ no
                                        ▼
                                  freshness cache hit (≤ maxAgeMs)? ──yes──► item (source: cache)
                                        │ no
                                        ▼
               source router.select ─► candidates: broker accounts (accounts.marketDataCandidates: pooling consent, the key's accounts)
                                        and, only when the read allows backup, enabled data sources
                                        ─► at most two tried (failover is the retry)
                                        ─► batcher (per consumer, ≤ policy.maxQuoteBatch, ~25 ms window)
                                        ─► scheduler.schedule({ class: "quote", priority: "interactive", coalesceKey })
                                        ─► adapter.fetchQuotes(creds, refs) ─► normalise ─► cache ─► item (source: broker)
                                           or backupData.quotes(symbols, { sourceId }) ─► item (source: backup, class delayed or eod)
```

**Order** (`POST /v1/orders`):

```
route (orders, scope paper) ─► validate body (zod) ─► idempotency check (replay / 409)
  ─► symbols.resolve (lot, tick, freeze) ─► quantity = lots × lotSize or check multiple
  ─► mode = "live" only if: config.safety.liveTrading ∧ account.live.enabled ∧ key has "live"
        ∧ source ∈ account.live.allowedSources ∧ request.mode === "live" ∧ (source mcp, or a hook that requires it → confirmToken)
  ─► safety.check (kill switch, rate cap, daily count/loss, value/lots, price band, market-order policy, market hours)
  ─► paper: paper.place(...)                                     ─┐
     live:  safety.acquireOrderSlot ─► issueOrderGate (brokers/orderGate.mjs)
            ─► scheduler.schedule({ class: "order", priority: "order" }) ─► adapter.placeOrder(creds, order, lotSize, gate)
  ─► audit.append(order.placed | order.refused | order.outcome_unknown) ─► bus "order.updated" ─► response
```

**Webhook** (`POST /hooks/<source>/<token>`): verify token hash (and HMAC + timestamp for `generic`), parse, dedupe, enqueue, **reply 202 within milliseconds** (alert services abandon slow requests after a few seconds), then a worker builds an `OrderRequest` from the hook's fixed mapping and calls `orders.preview` / `orders.place` with `source: "webhook"`.

**AI** (`POST /mcp` or the stdio relay): MCP tools call the same services with `source: "mcp"`. Order tools only prepare: `orders.preview` opens a ticket, which appears in the dashboard's Pending confirmations panel on the Orders page (`GET /v1/tickets`); the human confirms there (`POST /v1/tickets/{id}/confirm`, admin key, this computer only), which yields the single-use `confirmToken` without which `orders.place` refuses, or declines (`POST /v1/tickets/{id}/reject`), after which the ticket can never be confirmed.

## 5. Multi-account model

- Accounts are declared in `bridge.config.json` (`accounts[]`): `id` (slug, the public handle), `broker` (adapter id or `paper`), `label`, `live`, `marketData.pooling`, `limits`. Credentials are **not** in the config: they are entered once (`POST /v1/accounts/{id}/session`, admin, loopback) and stored encrypted by SecretStore under `account:<id>`.
- Many accounts of the same broker are fine (yours, your spouse's: SEBI's retail framework allows family use; each family member's account uses their own broker app and keys).
- **Pinned vs pooled reads.** A request with `account=` is served only by that account. A request without it may be served by any account that has the capability, is connected, has `marketData.pooling: true`, names a `holder` (the same holder as the other pooled accounts), whose broker policy says `pooling: "allowed"` (or `"unknown"` with the account's `poolingWhenTermsUnknown`), **and** that the owner has named in a pooling consent (`PUT /v1/pooling/consent`, admin, this computer only, versioned: a changed notice needs a new consent). Default is off, so out of the box every read is served by the first connected capable account, and nothing is spread. Either way, only accounts the calling key may use are considered: a key limited to `["dhan-main"]` is served by `dhan-main` or not at all, never by another account's entitlement or rate budget.
- **Portfolio and orders are never pooled.** They always act on the named account.
- **Keys can be limited to accounts** (`accounts: ["dhan-main"]`), so a key made for one tool cannot touch the family account.
- **Paper.** Every account can trade paper (`mode: "paper"`, the default). A `broker: "paper"` account is a practice account with no broker of its own; it prices from pooled market data.
- **Sessions.** Brokers end sessions daily (NSE requires API sessions to be logged out before the next trading day). AccountManager tracks expiry, emits `account.status`, and StreamHub resubscribes after a fresh login. There is no stored-TOTP auto-login: that would mean storing a second factor, which this project never does.

## 6. Rate-limit engine and streaming

**Endpoint classes.** Every broker call is tagged: `order` (place, modify, cancel), `quote`, `depth`, `history`, `chain`, `portfolio`, `master` (instrument downloads), `other`.

**Policy table** (`ratelimit/brokerPolicies.mjs`): per broker, per class `{ perSecond, perMinute, perDay, verified, source }`, plus `maxQuoteBatch`, feed caps (`maxConnections`, `maxSubscriptions`), `pooling` (`allowed` | `not-allowed` | `unknown`) and `maxModificationsPerOrder`. Unknown or unverified numbers fall back to conservative defaults: 1 request/s for quote, depth, history and chain; 2/s for portfolio; 5/s orders; pooling `unknown` (treated as not allowed). Starting points from research, all **(needs verification against each broker's current page)**:

| Broker | Known limits (research, Oct 2026) |
|---|---|
| Zerodha Kite | quotes 1/s, historical 3/s, orders 10/s and 400/min, 5,000 orders/day, 25 modifications per order, 3 WebSocket connections × 3,000 instruments |
| Dhan | orders 10/s, 250/min, 1,000/hour, 7,000/day; data 5/s; quote 1/s; non-trading 20/s; 25 modifications per order |
| Upstox | v3 feed: 2 connections, LTPC 5,000 / Greeks 3,000 / Full 2,000 instruments; REST order limits unclear (older 25/s figure likely superseded) |
| Angel One | orders 10/s per exchange segment from 1 Apr 2026 (earlier 9/s figures superseded) |

**Mechanics.**

- **Token buckets** per `(accountId, class)` with all three windows; a call needs a token from each window. Orders also pass SafetyGuard's own per-account cap (default 5/s, never above 10/s; place, modify and cancel all count), which is independent of the broker's limit.
- **Priority queue** per account: `order` > `live` (stream recovery, OUTCOME_UNKNOWN reconciliation) > `interactive` (a client is waiting) > `background` (prefetch, masters). Waiting requests age upwards so background work is delayed, never starved. A request whose `signal` aborts leaves the queue.
- **Fair queue.** Inside each lane, consumers (one per API key, one per background job) share the budget by weight (key kind: ui 4, mcp 2, excel 1, script 1, other 1; changeable per key) with start-time fair queueing, so a flood from one key waits behind other keys' requests. A consumer has a cap on queued requests and, while others wait, on in-flight calls; a full queue drops the newest request of the biggest consumer.
- **Coalescing (singleflight).** Identical in-flight reads (`coalesceKey` = class + account + canonical args) share one broker call.
- **Batching.** Quote and LTP requests arriving within a short window (about 25 ms) are merged up to `maxQuoteBatch` per adapter call. A batch belongs to one consumer, because a batch is credited to whoever opened it: merging two consumers' symbols would make the light one wait in the heavy one's place. The cost is one extra call when two consumers ask for different symbols in the same window; the same symbol still shares the call in flight.
- **Freshness cache.** Per-class targets (LTP 1 s, quotes 2 s, depth 1 s, chain 3 s, expiries 5 min, history 60 s for closed bars). Callers tighten with `maxAgeMs`. When the budget is exhausted the engine may serve the cached value **labelled `stale: true`** rather than queueing past the caller's deadline; portfolio and orders are never served stale.
- **Streaming first.** If StreamHub has a live, fresh tick for a symbol, LTP and quotes come from it and cost no REST call. An option chain whose whole strike window is streamed is built from the ticks over the day's broker chain (previous OI from it), also with no REST call. Front ends and charts should subscribe rather than poll: the dashboard keeps one WebSocket per tab (`dashboard/live.js`) shared by every page.
- **Pooled routing.** `pickAccount` chooses among eligible candidates by headroom, health and back-off state. Credentials never move between accounts; each call uses the chosen account's own session. A many-symbol unpinned quote read is split: `maxQuoteBatch` chunks go to the pooled account with the most spare quote budget (accounts in back-off or out of budget for longer than a second get none). Pooling at a broker whose policy is `unknown` needs the account's `marketData.poolingWhenTermsUnknown` as well; `not-allowed` is never pooled.
- **Upstream back-off and adaptive budget.** A broker 429 or rate-limit error (`UPSTREAM_RATE_LIMITED`) puts the whole budget pool of that account (the classes that share a bucket) into back-off (Retry-After, else exponential from 1 s, plus jitter) and emits `limits.throttled`. Each pool also has a scale below the policy ceiling that a throttle halves (floor 0.25) and clean minutes give back 5 percent at a time (additive increase, multiplicative decrease); three throttles in an hour hold it lower for a day. It never rises above the policy.
- **Client quotas.** Each API key has a quota: a token bucket (default 50 requests/s), an optional daily cap, a weight and a cap on requests in flight. Defaults and per-key values are in the `ratelimit.client` config section; an admin can override one key at run time (`PUT /v1/quotas/{keyId}`, kept in `quotas.json`). Quotas are reported in `RateLimit` / `RateLimit-Policy` headers.
- **Refusals say why.** Every 429 carries `scope` (`client`, `consumer-cap`, `queue`, `upstream`), `retryAfterMs` and `limit: { name, remaining, resetMs }`, so a client can tell its own quota from the broker's budget. `Retry-After` is the same wait in seconds with a little jitter.
- **Observability.** `/v1/usage` shows used, queued and reset per class, every window (this second, this minute, today), two minutes of calls per second (`?series=1`), the calls saved by streaming, caching, coalescing and batching, and (admin keys) today's calls and saved calls per consumer: the dashboard page, API key label, MCP, compat or background job that caused them (`ratelimit/consumer.mjs`, AsyncLocalStorage). `GET /v1/limits?explain=1` adds the budget pools (spare room, scale, back-off) and the consumers in the queue with their shares, and `GET /v1/quotas` lists every key's quota and use. The dashboard's Sources page shows all of it.

**Data sources and the router** (`sources/`, design in [sources-architecture.md](sources-architecture.md)). A source is a read-only provider with a descriptor (id, kind, tier, data class, delay, official, capabilities, limits, terms): the built-in free providers (Yahoo, Alpha Vantage, Twelve Data), the demo sources, and plugins the owner granted. All are off until the owner switches them on (`PATCH /v1/sources/{id}`; an opt-in source needs its notice acknowledged, a key-based one needs its key, which is kept in the secrets store and never returned). For a read that is not pinned, `router.select` builds candidates from the key's broker accounts and, only when the read allows backup (`?backup=true` or `sources.autoFallback`), the enabled sources. Hard filters come first: capability, data class against `purpose`, `maxAgeMs`, circuit breaker, deadline. Reads for `order`, `risk`, `paper` and `alert` accept only trusted real-time data. The rest are ordered by spare budget, error rate and latency, and at most two are tried. Streams and the cache always come first. Health is tracked per source with decaying averages; repeated hard failures eject a source for a cooldown that doubles up to five minutes, and a 429, an auth error or a not-found never trips it. `GET /v1/sources/trace` runs the same decision as a dry run. A plugin runs in its own process with brokered, allow-listed network access and a hash pin ([source-contract.md](source-contract.md)).

**StreamHub.** One upstream feed per account (`adapter.createFeed`), reference-counted subscriptions across all local clients, upstream mode = the highest mode any client wants, broker caps enforced (a client gets `SUBSCRIPTION_LIMIT`, never a silent drop), reconnect with back-off, resubscribe after re-login. Downstream protocol (WS and SSE): `snapshot` on subscribe, then `tick` with a per-connection `seq`, `status` (upstream up, down or stale), `heartbeat` every 15 s, `go_away` before shutdown. Clients authenticate with a 60-second stream token from `POST /v1/stream/token` (so keys never sit in URLs) or an Authorization header. Message schemas are in `docs/asyncapi.yaml`.

## 7. Orders and paper trading

- **Request shape** (`OrderRequest` in openapi): `account`, `symbol`, `side`, exactly one of `quantity`/`lots`, `product` and `orderType` with **no defaults**, `price`/`triggerPrice` as the type requires, `validity`, `marketProtectionPct`, `mode` (default `paper`), `clientOrderId`, `tag`, `algoId`, `confirmToken`.
- **Idempotency.** `Idempotency-Key` header (or `clientOrderId` when the header is absent) on every write. The first request's status and body are stored before the broker call returns; a retry with the same key and same body replays it (`Idempotency-Replayed: true`); a different body gets 409 `IDEMPOTENCY_KEY_REUSED`; a concurrent retry 409 `IDEMPOTENCY_IN_PROGRESS`. Kept until the end of the IST trading day and at least 24 hours.
- **clientOrderId mapping.** Brokers allow short tags (Kite 20 characters, Upstox 40). The Bridge keeps `clientOrderId → { accountId, brokerOrderIds[], tag }` itself and writes a short derived tag where the broker supports one.
- **Pre-trade validation** (before any call): lot multiple, tick size, freeze quantity (slice above it where the adapter declares native slicing, otherwise refuse), allowed products and order types for the broker, price band against LTP.
- **Market orders.** `safety.marketOrders: "protect"` (default) sends MARKET/SL-M with broker-native market protection where the adapter supports it, or converts them to a LIMIT at LTP ± `marketProtectionPct` and says so in the response; `"reject"` refuses them. Several brokers already reject unprotected API market orders.
- **OUTCOME_UNKNOWN.** A write that times out or fails without a clear refusal is never retried. The order is stored as `outcome_unknown`, the response is 504 `OUTCOME_UNKNOWN`, and a reconciliation job (priority `live`) looks for it in the broker order book by tag and time, then resolves the status and emits `order.updated`.
- **Live path reuses the existing order gate.** Adapter `placeOrder/modifyOrder/cancelOrder` refuse without a single-use gate from `issueOrderGate()`; only OrderService mints one, right after SafetyGuard passes, for one call.
- **Paper fill model** (documented in `/v1/paper/accounts/{id}`): MARKET fills at the opposite best price from depth when available, else LTP ± `slippageBps` (default 5 bps); LIMIT fills when LTP crosses the limit, at the limit; SL triggers on LTP crossing the trigger; fills are checked on every tick for subscribed symbols and at least every 2 s otherwise; no queue position, partial fills or market impact. Funds start at ₹10 lakh (configurable); intraday products are squared off at 15:20 IST for NSE/BSE F&O and cash (configurable). Order ids start with `PAPER-`.

## 8. Safety and security model

**Threats considered:** a malicious web page reaching localhost (DNS rebinding, CSRF); a leaked key in an Excel file, alert message, screenshot or log; an AI assistant manipulated by prompt injection in instrument names or broker messages; a runaway alert loop; a script that retries a timed-out order; a stolen laptop; a second user on the same machine; the Bridge exposed to the internet by mistake.

| Control | Where | Detail |
|---|---|---|
| Loopback bind | core config | `127.0.0.1` default; another address needs `server.allowNonLoopback: true` in the file and logs a warning |
| Host allowlist | core security | DNS-rebinding guard on every request and upgrade |
| Origin allowlist (CORS) | core security | explicit origins only, no `*`; requests from unlisted origins are refused, not just un-CORSed |
| API keys | auth | `mcb_<keyId>_<secret>`, 32 random bytes; only a **scrypt** hash stored (N=2^15, r=8, p=1, per-key salt, `timingSafeEqual`); shown once; expiry; revocation immediate |
| Scopes | core context + auth | `read` ⊂ `paper` ⊂ `live`; `admin` ⊃ `read`; plus per-key account list |
| URL keys | core pipeline | `?key=` only on `/xl/*`, only for keys whose single scope is `read` and that were created with `allowQuery` |
| Stream tokens | auth | 60-second, single-key tokens for WS/SSE URLs |
| Secrets at rest | auth | **AES-256-GCM**, fresh 12-byte IV per write, entry name as AAD; key from `MCB_MASTER_KEY` (base64, 32 bytes) or `dataDir/master.key` (0600; refused if group/other-readable) |
| No second factors stored | accounts, broker layer | passwords, PINs and TOTP codes are used once for the broker login and never stored, cached, logged or used as cache keys (`isForbiddenSecretKey`) |
| Log redaction | core logger | secret field names, Bridge keys, bearer tokens, JWTs and registered exact values are masked; access log never has query strings |
| Paper default + triple opt-in | core config, orders | live needs `safety.liveTrading` + `account.live.enabled` (file only, env can never enable) + `live` key + allowed source + `"mode": "live"` |
| Order-rate cap | core config, safety | default 5 orders/s per account, config may not exceed 10/s |
| Kill switch | safety | any key can engage it (`POST /v1/safety/kill-switch`), optionally cancelling open orders; release needs admin from loopback and `confirm: "RELEASE"`; persisted across restarts; `MCB_KILL_SWITCH=1` engages at start |
| Daily limits | safety | order count, realised loss, per-order value and lots; limits only ratchet down at runtime |
| Idempotency | orders | as §7 |
| Audit log | safety | append-only JSON lines, one `appendFileSync` per event, SHA-256 hash chain (`/v1/audit/verify`), redacted; every order, refusal, key change, session change and kill-switch action |
| Webhook auth | hooks | per-hook 128-bit+ URL token (hash stored, shown once); `generic` hooks also need `X-MCB-Signature: t=…,v1=HMAC-SHA256(secret, "t.body")` with a 5-minute window and replay cache; optional source-IP allowlist; each hook can only do what its definition allows |
| Public ingress | core | off by default; a separate listener that serves only `public` routes (webhooks), never the API |
| AI confirmation | orders, mcp | order tools prepare a ticket; a human confirms it in the dashboard with an admin key from this computer; client-side approval prompts and MCP annotations never count as confirmation; no tool can change paper/live mode, scopes or the kill switch release |
| Body limits and timeouts | core | 64 KB default bodies (16 KB for hooks), 30 s request timeout, broker calls time out via `brokerFetch` |
| Cross-site writes | core security | besides the Origin allowlist, a non-GET request with `Sec-Fetch-Site: cross-site` or `same-site` and no allowlisted Origin is refused (`ORIGIN_NOT_ALLOWED`) |
| Trading readiness | readiness | per live account: session (stated expiry + read call), egress IP vs `live.registeredIp` (opt-in lookup, IP in memory only), headroom, kill switch; automated live sends refused with `CANNOT_TRADE` while `cannot_trade`; it never sends or engages anything |

**Security baseline, audited 29 Oct 2026:**

| # | Finding | Verdict and test |
|---|---|---|
| F1 | No route authenticates from a cookie; the dashboard sends a per-tab bearer key from `sessionStorage` | This is the per-session token: a browser never attaches it on its own, so CSRF cannot carry it. No cookies (T-sec-4) |
| F2 | The Origin allowlist runs before routing; preflight only for listed origins; `Origin: null` refused | Every non-GET route is tested (T-sec-1) |
| F3 | The sign-in admin key lives 30 days, though the tab forgets it on close | Acceptable (loopback-only creation, hashed at rest); revoking on tab close is not reliable |
| F4 | Non-GET `auth: "none"` only `POST /v1/sign-in` (loopback, one-time code); `auth: "custom"` only hooks and `/api/v1/*` | Locked by an allowlist test (T-sec-2) |
| F5 | `?key=` only on GET routes with `allowQueryKey`, read keys only | Tested (T-sec-2) |
| F6 | WebSocket upgrades run the same Host and Origin check | Every upgrade path tested (T-sec-3) |
| F7 | A write with `Sec-Fetch-Site: cross-site` and no Origin passed the Origin check | Fixed: `assertNotCrossSiteWrite` (T-sec-1c) |
| F8 | `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `script-src 'self'`, CORP, `no-store` on every response | Asserted per module (T-sec-5) |
| F9 | MCP order tools hidden without config and `paper` scope; `live` mode only with a live key; MCP keys cannot hold `admin` | Matrix test (T-sec-6) |

## 9. Symbology

Canonical format (implemented in `core/symbolFormat.mjs`, used by every module):

```
NSE:RELIANCE                     equity          NSE:NIFTY                       index
NFO:NIFTY-2026-10-27-FUT         future          NFO:NIFTY-2026-10-27-25000-CE   option
BFO:SENSEX-2026-10-30-82500-PE   BSE option      NFO:VEDL-2026-10-27-292.5-CE    decimal strike
```

`EXCHANGE:UNDERLYING[-YYYY-MM-DD(-FUT | -STRIKE-CE | -STRIKE-PE)]`, exchange codes `NSE BSE NFO BFO MCX CDS` (the broker contract's own). **Why:** readable (what, when, which strike and side), ISO dates remove the weekly-code and DDMMMYY/YYMDD ambiguity of exchange trading symbols, parsing from the right keeps names like `BAJAJ-AUTO` and `M&M` safe, and it is reversible with no lookup. Inputs are lenient (case, `NSE:` venue form for derivatives); outputs are always canonical.

**Aliases accepted** (`/v1/symbols/convert`, and anywhere a symbol is accepted): chart tickers (`from=chart`: `NSE:NIFTY`, `NSE:M_M`, continuous `NSE:NIFTY1!` resolved to the current expiry, options `NSE:NIFTY261027C25000` **(needs verification of the option naming)**), compact trading symbols with an exchange (`NIFTY27OCT2625000CE` + `NFO`, `from=compact`), and broker-native tokens or trading symbols with a `broker` parameter.

**Resolution (symbols):** instrument masters from each connected broker's `fetchInstruments`, cached per IST day, merged by canonical id into `ResolvedInstrument { lotSize, tickSize, freezeQty, isin, refs: { <broker>: { token, exchange, tradingSymbol } } }`. Expired contracts drop out (exchange tokens get reused after expiry, so a token is never an identity). Lot sizes change: never hard-code them, never guess (unknown → `SYMBOL_NOT_FOUND`). Freeze quantities come from the master where a broker publishes them, otherwise from an exchange list **(needs verification per segment)**.

## 10. Integrations

- **Spreadsheets and AmiBroker (integrations).** `/xl/ltp` and `/xl/quote` return one value as plain text (Excel `WEBSERVICE` is GET-only, Windows desktop only, 2,048-character URLs, 32,767-character results); `/xl/chain` and `/xl/history` return flat CSV or JSON records for Power Query, Google Sheets and AmiBroker ASCII import (`layout=amibroker` plus a shipped `.format` file and an AFL include). CSV output guards against formula injection. Google Sheets `IMPORTDATA` and Apps Script run on Google's servers and cannot reach localhost; they need the user's tunnel and a read-only URL key, and refresh only hourly.
- **Webhooks (hooks).** Hosted alert services (ChartInk, GoCharting) post from the internet, cannot sign requests and give up on slow answers. So: per-hook URL token, optional IP allowlist, fast 202 and asynchronous processing, idempotency from `id`+`time` where the alert provides them, and per-hook action mapping (account, symbols, lots cap, product, paper/live, confirmation). ChartInk posts a fixed JSON with comma-joined `stocks` and `trigger_prices` and a dateless `triggered_at`; GoCharting posts plain text. Scripts use `generic` hooks, signed with HMAC (`X-MCB-Signature`). A copy-paste alert-template generator ships with the hooks UI.
- **AI (mcp).** Built on `@modelcontextprotocol/sdk` with protocol-version negotiation (the spec moved to a stateless revision 2026-07-28; which revision each client speaks **needs verification**). Transports: Streamable HTTP at `POST /mcp` (loopback, Host/Origin checked, bearer key) and stdio via the `mc-bridge mcp` relay. Fewer than 20 tools by default, listed in a fixed order, all four annotations set explicitly, `outputSchema` + `structuredContent`, results wrapped in an untrusted-data envelope (instrument names and broker messages are third-party text). Order tools exist only when the config enables them for that account and the key has the scope, and they only prepare tickets. The same tool registry is exported as strict OpenAI function schemas. Remote access (ChatGPT, claude.ai web) needs a tunnel plus OAuth and is out of scope.
- **SDKs.** Thin Python and Node clients generated from or hand-written against `openapi.yaml`, with idempotency keys by default and stream-token handling.

## 11. API conventions

- Base path `/v1`; additive changes only within v1. `GET /v1/meta` reports versions and routes.
- Success: `{ "data": …, "meta": { "requestId", "nextCursor"?, "accountId"?, "mode"?, "freshness"? } }`. `/xl/*` and MCP use their consumers' formats.
- Errors: RFC 9457 `application/problem+json` with `code` (stable, see `core/errors.mjs`), `retryable`, `requestId`, optional `broker { id, code, message }` and field `errors[]`. Broker contract errors map through `fromBrokerError` (writes that time out become `OUTCOME_UNKNOWN`).
- Times: ISO-8601 with `+05:30` in JSON; candles in epoch seconds; IST is computed with `Asia/Kolkata`, never from the host's time zone.
- Pagination: `limit` (≤ 500) + opaque `cursor`.
- Validation: zod schemas at every route boundary (zod is a dependency for exactly this); OpenAPI is the reviewed contract.

## 12. Compliance notes

These shape the design. None of this is legal advice; items flagged **(needs verification)** must be confirmed against the primary SEBI, NSE and BSE circulars and each broker's current notice before the feature they affect ships.

| Topic | What we understand | Design response |
|---|---|---|
| SEBI retail algo framework | SEBI circular SEBI/HO/MIRSD/MIRSD-PoD/P/CIR/2025/0000013 (4 Feb 2025); NSE implementation standards NSE/INVG/67858 (5 May 2025); fully mandatory from 1 Apr 2026 after extensions (CIR/2025/108, CIR/2025/132). No later relaxation found as of Oct 2026 **(needs verification)** | Bridge is self-hosted personal software; the user runs their own logic with their own broker app and keys |
| Order threshold | Unregistered client algos must stay at or below 10 orders/s per exchange segment, measured by the broker; brokers may set lower limits and count modify/cancel **(needs verification per broker)** | Default cap 5/s per account, config cannot exceed 10/s, all order actions count |
| Static IP | API orders must come from a static IP registered with the broker (primary + optional secondary, changeable about once a week) under CIR/2025/0000013 and NSE/INVG/67858; data and portfolio calls generally work from any IP **(needs verification: the IP rules and how often they can change, per broker)** | `registeredIp` per account for a pre-order egress check (`doctor` and preview warn on mismatch); docs say a tunnel to a dynamic-IP PC cannot place orders |
| Algo-ID tagging | Every algo order carries an exchange-issued tag, applied by the broker (generic ID below the threshold) | Bridge never invents tags; optional `algoId` passes a registered strategy's id where a broker API accepts one **(needs verification per broker)** |
| No open APIs; broker liability | Open APIs are banned; brokers must trace orders to the client | Loopback bind, per-client scoped keys, audit log naming the client and key behind every order |
| Daily logout | API sessions must be logged out before the next trading day (CIR/2025/0000013; brokers apply it as a daily re-login) **(needs verification per broker)** | Sessions expire daily; clear `SESSION_EXPIRED`; no stored-TOTP auto-login |
| Order types | Plain market, SL-M and (at some brokers) IOC orders are restricted for API orders | Market protection by default, `reject` option, IOC capability per broker |
| Family use | A retail algo may be used by self, spouse, dependent children and dependent parents (CIR/2025/0000013, NSE/INVG/67858) **(needs verification: the exact family definition)** | Multi-account supports family accounts; no use by anyone else. Each account names its `holder`; market-data pooling never spreads reads across different holders, because each family member is a separate user under the brokers' personal-use terms |
| Algo provider risk | Hosting the Bridge or strategies for other people, or selling signals, would likely make the operator an exchange-empanelled algo provider; black-box strategies may need Research Analyst registration | The Bridge ships no strategies, hosts nothing for others, and stays single-user **(legal review before any hosted offering)** |
| AI-placed orders | No regulator or broker source covers AI agents placing orders; an AI order through the user's key is still an API algo order | Read-only by default; every AI order needs human confirmation; the audit log records the client (API key label and principal) and the exact order prepared and sent (`ticket.created`, `order.placed`). The Bridge never sees the user's prompt, so no prompt context is logged **(gray area)** |
| Market data terms | Broker API terms generally forbid passing market data to others (Kite: personal use) | Personal-use notice; loopback; no multi-user or public data endpoints; pooling only across accounts with the same `holder`, only among accounts the calling key may use, only where the broker policy allows, and only after the owner accepts a versioned notice that says no broker's published terms clearly allow or forbid it **(needs verification per broker)**. Free sources and plugins are labelled delayed or end of day, are never redistributed, and show the vendor's terms before they are switched on |

## 13. What we will not do

- Store passwords, PINs, MPINs or TOTP secrets/codes, or automate a broker's 2FA.
- Let any API call, environment variable, MCP tool or webhook switch on live trading, widen a key's scopes or release the kill switch remotely.
- Serve data or orders to anyone other than the user (and family accounts they configure); run as a hosted multi-user service; expose the API on a public interface by default.
- Share credentials or sessions between users, or move one account's credentials to another account's calls.
- Exceed or "burst past" a documented broker limit, retry an order write blindly, or silently drop a safety parameter.
- Send plain market orders without protection; default a product or order type.
- Place orders from Excel formulas or GET URLs; nothing under `/xl` can trade.
- Ship trading strategies, signals or "AI picks".
- Write an adapter from anything but the broker's official docs, SDKs and Postman collections.

## 14. Configuration and environment

`bridge.config.json` (see `bridge.config.example.json`). Core sections: `server`, `cors`, `dataDir`, `logging`, `accounts`, `safety`. Module sections (each validated by its module's zod schema): `ratelimit`, `symbols`, `market`, `stream`, `orders`, `paper`, `integrations`, `hooks`, `mcp`, `compat`, `readiness`. Unknown sections are errors.

| Variable | Effect |
|---|---|
| `MCB_CONFIG` | config file path |
| `MCB_HOST`, `MCB_PORT` | listener (a non-loopback host still needs `allowNonLoopback` in the file) |
| `MCB_DATA_DIR`, `MCB_LOG_LEVEL` | data directory, log level |
| `MCB_MASTER_KEY` / `MCB_MASTER_KEY_FILE` | encryption key (base64 32 bytes) or key file path |
| `MCB_PAPER_ONLY=1` | forces paper only (tighten) |
| `MCB_KILL_SWITCH=1` | engages the kill switch at start (tighten) |
| `MCB_API_KEY` | key used by `mc-bridge mcp` |

## 15. Decisions

| Decision | Why |
|---|---|
| node:http + a ~100-line router, no framework | exact control over the safety pipeline (Host, Origin, auth, body caps) with nothing hidden; tested in `core/app.test.mjs` |
| zod | one validation library for config and every route body; also what the MCP SDK uses |
| `@modelcontextprotocol/sdk` | the MCP spec changes quickly (stateless 2026-07-28 revision); the official SDK handles negotiation and transports |
| `ws` (existing) | WebSocket server for `/v1/stream` and broker feeds |
| JSON files, atomic writes | small data, zero native dependencies, easy to inspect and back up |
| Canonical symbols with ISO expiry and contract exchange codes | §9 |
| RFC 9457 errors with `retryable` | scripts, webhooks and AI clients need one machine-readable answer to "may I retry?" |
| Default port 4300 | avoids common dev ports (3000, 4002, 5173, 8080) |
