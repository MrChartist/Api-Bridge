# Mr. Chartist API Bridge: architecture

Status: **v2 design, frozen for the parallel build** (owner: lead architect). The code contracts this document describes live in `server/bridge/core/` and are enforced by tests; the HTTP contract is [`openapi.yaml`](openapi.yaml); who builds what is in [`STREAMS.md`](STREAMS.md). Anything marked **(needs verification)** must be checked against a primary source before it ships to users.

## 1. What the Bridge is

One local service that holds a user's connections to **several brokers and several accounts at once**, and lets every tool share them: Option Hub, charts (UDF datafeed), TradingView/ChartInk/GoCharting alerts, AmiBroker, Python and Node scripts, Excel and Google Sheets, and AI assistants over MCP.

The headline problem is **broker rate limits**. Ten tools each polling a broker that allows 1 quote request a second cannot work. The Bridge makes the broker see one careful client: it serves from live streams first, then a short freshness-labelled cache, then batched and coalesced calls inside per-account token buckets, with orders always ahead of reads, and it can spread read-only market data over the user's *own* accounts where the broker's terms allow it.

Design principles, in priority order:

1. **Safe by default.** Paper mode, loopback only, read-only keys, no market orders without protection, live trading only after three separate opt-ins in the config file plus a per-request `"mode": "live"`.
2. **Never exceed a documented limit.** Unknown limits get conservative defaults. Every number in the policy table carries a source and a `verified` flag.
3. **Honest data.** Every market-data value says where it came from and how old it is (`freshness`). No silent fallbacks to another symbol, account or stale value.
4. **One contract.** The 41 broker adapters (`server/brokers/`) already share a tested contract; the Bridge adds no second adapter model.
5. **Personal use.** One user (and family, as SEBI allows) on their own machine. Never a multi-user or public data service.

## 2. Process model

```
                         ┌──────────────────────── one Node.js 20+ process (mc-bridge start) ───────────────────────┐
 Option Hub, scripts,    │  main listener 127.0.0.1:4300                                                             │
 Excel, AmiBroker,  ───► │   REST /v1/*  ·  SSE /v1/stream/sse  ·  WS /v1/stream  ·  UDF /udf/*  ·  /xl/*  ·  POST /mcp│
 MCP relay (stdio)       │                                                                                           │
                         │  optional public-ingress listener (off by default): ONLY routes marked public (/hooks/*) │
 TradingView, ChartInk ─►│   reached through the user's tunnel or reverse proxy                                      │
 (via tunnel)            │                                                                                           │
                         │  services (deps): secrets · keyStore · audit · accounts · scheduler · symbols ·           │
                         │                   streamHub · marketData · safety · paper · orders                         │
                         │  broker layer: server/brokers/registry.mjs → 41 adapters → brokerFetch / createFeed       │
                         └───────────────────────────────────────────────┬───────────────────────────────────────────┘
                                                                         │ HTTPS / WSS (from the user's static IP for orders)
                                                                         ▼
                                                                 broker APIs and feeds
```

- **One process, one port.** REST, SSE, WebSocket upgrades, UDF, spreadsheet endpoints and MCP Streamable HTTP all share `127.0.0.1:4300`. No ZeroMQ, no second WebSocket port, no database server.
- **`mc-bridge mcp` is a relay**, not a second Bridge: it pipes stdio JSON-RPC from Claude Desktop, Claude Code or Cursor to the running Bridge's `POST /mcp` with the AI client's own key. A second process with its own broker sessions would double the rate-limit usage and bypass the shared safety state.
- **CLI commands** (`keys`, `accounts`, `doctor`) run in their own short-lived process against the same data directory. Every store writes atomically (temp file + rename) and the server re-reads a store when its file changes, so CLI edits apply without a restart.
- **Persistence is JSON files** in `dataDir` (default `./data`, created with mode 0700). No SQLite: the volumes are small, and plain files keep installs dependency-free and auditable.

```
data/
  master.key            32 random bytes, mode 0600 (unless MCB_MASTER_KEY is set)
  secrets.enc           AES-256-GCM encrypted broker credentials and session tokens   (S2)
  keys.json             API key records: scrypt hashes, scopes, accounts, expiry      (S2)
  audit/YYYY-MM-DD.jsonl  append-only, hash-chained audit log (IST days)              (S9)
  safety/               kill-switch state and daily counters                          (S9)
  instruments/<broker>-YYYY-MM-DD.json  instrument master cache                       (S4)
  orders/               idempotency records, clientOrderId map, live order index      (S7)
  paper/<accountId>.json  paper books                                                 (S8)
  hooks.json            webhook definitions (token hashes only)                       (S11)
```

## 3. Module map

`server/bridge/core/` is the shared core (lead-owned). Every other directory belongs to exactly one stream.

| Path | Stream | Provides (deps key) | HTTP surface |
|---|---|---|---|
| `core/` | lead | config, logger, bus, clock, paths, brokers; router, pipeline, errors, contracts, symbol codec, CLI | `/v1/health`, `/v1/meta`, `/openapi.yaml` |
| `accounts/` | S1 | `accounts` (AccountManager) | `/v1/brokers`, `/v1/accounts*` |
| `auth/` | S2 | `secrets` (SecretStore), `keyStore` (KeyStore) | `/v1/keys*`, `/v1/stream/token` |
| `ratelimit/` | S3 | `scheduler` (Scheduler) | `/v1/limits`, `/v1/usage` |
| `symbols/` | S4 | `symbols` (SymbolService) | `/v1/instruments/*`, `/v1/symbols/convert` |
| `market/` | S5 | `marketData` (MarketDataService) | `/v1/ltp`, `/v1/quotes`, `/v1/depth`, `/v1/history`, `/v1/expiries`, `/v1/optionchain` |
| `stream/` | S6 | `streamHub` (StreamHub) | WS `/v1/stream`, `/v1/stream/sse`, `/v1/stream/stats` |
| `orders/` | S7 | `orders` (OrderService) | `/v1/orders*`, `/v1/trades`, `/v1/positions`, `/v1/holdings`, `/v1/funds`, `/v1/tickets/*` |
| `paper/` | S8 | `paper` (PaperEngine) | `/v1/paper/*` |
| `safety/` | S9 | `safety` (SafetyGuard), `audit` (AuditLog) | `/v1/safety*`, `/v1/audit*` |
| `integrations/` | S10 | (routes only) | `/udf/*`, `/xl/*` |
| `hooks/`, `mcp/` | S11 | (routes only) | `/hooks/{source}/{token}`, `/v1/hooks*`, `/mcp`, `mc-bridge mcp` |
| `backup/` | S12 | `backupData` (BackupDataService) | `/v1/backup/status`, `/v1/backup/quotes`, `/v1/backup/history` |
| `scanner/` | S13 | (routes only) | `/v1/scanner/*`; `scan` events on the stream |
| `compat/` | S14 | (routes only) | `/api/v1/*` apikey-in-body REST, WS `/api/v1/ws` |
| `notify/` | S15 | (routes only) | `/v1/notify`, `/v1/notify/test`; Telegram, Discord, Slack, signed webhooks |
| `server/brokers/`, `server/lib/` | frozen | broker adapters and helpers (existing, tested) | none directly |

**How modules plug in** (`core/modules.mjs`): each area has one `module.mjs` exporting `defineModule({ name, stream, services, configKey?, configSchema?, register(app, deps), start?, stop? })`.

- Service factories run in dependency order taken from `SERVICE_CONTRACTS[*].requires` (`core/contracts.mjs`). A factory receives only the core deps plus the services it declared; touching anything else throws.
- `app.mjs` checks every service against its contract (`assertService`). An area that has not landed yet is a stub: it boots, and every method throws `NotImplementedError` (HTTP 501).
- `register(app, deps)` adds routes with `app.get/post/patch/delete(path, handler, options)` and WebSocket paths with `app.upgrade(path, handler)`. Route options: `auth` (`key` | `none` | `custom`), `scope`, `allowQueryKey`, `loopbackOnly`, `public`, `body` (`json` | `json-or-text` | `raw` | `none`), `bodyLimitBytes`.
- A module may own a config section (`configKey` + zod `configSchema`); unknown top-level config keys are errors.
- `core/openapi.test.mjs` fails if a registered route and `docs/openapi.yaml` disagree on path, method, scope, auth, loopback, public flag or owning stream.

**Service dependency graph** (construction order):

```
secrets ─► accounts ─► scheduler ─► symbols ─► streamHub ─► marketData ─► paper ─┐
backupData ─────────────────────────────────────────────────┘ (optional fallback)  │
keyStore                                                                          ├─► orders
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
8. Access log: method, path **without the query string**, status, ms, key id. Never bodies or keys.

**Market-data read** (`GET /v1/quotes?symbols=…`):

```
route (S5) ─► symbols.resolve (S4) ─► streamHub.lastTick fresh enough? ──yes──► item (source: stream)
                                        │ no
                                        ▼
                                  freshness cache hit (≤ maxAgeMs)? ──yes──► item (source: cache)
                                        │ no
                                        ▼
               accounts.marketDataCandidates ─► scheduler.pickAccount ─► batcher (≤ policy.maxQuoteBatch, ~25 ms window)
                                        ─► scheduler.schedule({ class: "quote", priority: "interactive", coalesceKey })
                                        ─► adapter.fetchQuotes(creds, refs) ─► normalise ─► cache ─► item (source: broker)
```

**Order** (`POST /v1/orders`):

```
route (S7, scope paper) ─► validate body (zod) ─► idempotency check (replay / 409)
  ─► symbols.resolve (lot, tick, freeze) ─► quantity = lots × lotSize or check multiple
  ─► mode = "live" only if: config.safety.liveTrading ∧ account.live.enabled ∧ key has "live"
        ∧ source ∈ account.live.allowedSources ∧ request.mode === "live" ∧ (source mcp, or a hook that requires it → confirmToken)
  ─► safety.check (kill switch, rate cap, daily count/loss, value/lots, price band, market-order policy, market hours)
  ─► paper: paper.place(...)                                     ─┐
     live:  safety.acquireOrderSlot ─► issueOrderGate (brokers/orderGate.mjs)
            ─► scheduler.schedule({ class: "order", priority: "order" }) ─► adapter.placeOrder(creds, order, lotSize, gate)
  ─► audit.append(order.placed | order.refused | order.outcome_unknown) ─► bus "order.updated" ─► response
```

**Webhook** (`POST /hooks/tradingview/<token>`): verify token hash (and HMAC + timestamp for `generic`), parse, dedupe, enqueue, **reply 202 within milliseconds** (TradingView abandons after 3 s), then a worker builds an `OrderRequest` from the hook's fixed mapping and calls `orders.preview` / `orders.place` with `source: "webhook"`.

**AI** (`POST /mcp` or the stdio relay): MCP tools call the same services with `source: "mcp"`. Order tools only prepare: `orders.preview` opens a ticket, which appears in Option Hub's Pending confirmations panel (`GET /v1/tickets`); the human confirms there (`POST /v1/tickets/{id}/confirm`, admin key, this computer only), which yields the single-use `confirmToken` without which `orders.place` refuses.

## 5. Multi-account model

- Accounts are declared in `bridge.config.json` (`accounts[]`): `id` (slug, the public handle), `broker` (adapter id or `paper`), `label`, `live`, `marketData.pooling`, `limits`. Credentials are **not** in the config: they are entered once (`POST /v1/accounts/{id}/session`, admin, loopback) and stored encrypted by SecretStore under `account:<id>`.
- Many accounts of the same broker are fine (yours, your spouse's: SEBI's retail framework allows family use; each family member's account uses their own broker app and keys).
- **Pinned vs pooled reads.** A request with `account=` is served only by that account. A request without it may be served by any account that has the capability, is connected, has `marketData.pooling: true`, names a `holder` (the same holder as the other pooled accounts), **and** whose broker policy says `pooling: "allowed"`. Default for both is off, so out of the box every read is served by the first connected capable account, and nothing is spread. Either way, only accounts the calling key may use are considered: a key limited to `["dhan-main"]` is served by `dhan-main` or not at all, never by another account's entitlement or rate budget.
- **Portfolio and orders are never pooled.** They always act on the named account.
- **Keys can be limited to accounts** (`accounts: ["dhan-main"]`), so a TradingView hook key cannot touch the family account.
- **Paper.** Every account can trade paper (`mode: "paper"`, the default). A `broker: "paper"` account is a practice account with no broker of its own; it prices from pooled market data.
- **Sessions.** Brokers end sessions daily (NSE requires API sessions to be logged out before the next trading day). AccountManager tracks expiry, emits `account.status`, and StreamHub resubscribes after a fresh login. There is no stored-TOTP auto-login: that would mean storing a second factor, which this project never does.

## 6. Rate-limit engine (S3) and streaming (S6)

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
- **Coalescing (singleflight).** Identical in-flight reads (`coalesceKey` = class + account + canonical args) share one broker call.
- **Batching.** Quote and LTP requests arriving within a short window (about 25 ms) are merged up to `maxQuoteBatch` per adapter call.
- **Freshness cache.** Per-class targets (LTP 1 s, quotes 2 s, depth 1 s, chain 3 s, expiries 5 min, history 60 s for closed bars). Callers tighten with `maxAgeMs`. When the budget is exhausted the engine may serve the cached value **labelled `stale: true`** rather than queueing past the caller's deadline; portfolio and orders are never served stale.
- **Streaming first.** If StreamHub has a live, fresh tick for a symbol, LTP and quotes come from it and cost no REST call. Option Hub and charts should subscribe rather than poll.
- **Pooled routing.** `pickAccount` chooses among eligible candidates by headroom, health and back-off state. Credentials never move between accounts; each call uses the chosen account's own session. A many-symbol unpinned quote read is split: `maxQuoteBatch` chunks go to the pooled account with the most spare quote budget (accounts in back-off or out of budget for longer than a second get none). Pooling at a broker whose policy is `unknown` needs the account's `marketData.poolingWhenTermsUnknown` as well; `not-allowed` is never pooled.
- **Backup data (S12).** An unpinned read whose caller allows it (`ReadOptions.allowBackup`: REST, UDF, /xl and the scanner by default via `backup.autoFallback`; never orders, paper or safety) and that no broker account could answer is served by BackupDataService (Yahoo Finance chart API, NSE website JSON), labelled `freshness.source: "backup"` with `provider` and the provider's own timestamp, and never written to the shared freshness cache. Per-provider pacing, circuit breaker and a short quote cache keep the Bridge a polite client.
- **Scanner (S13).** Scan jobs fetch candles at `background` priority. With several pooled candidates, one worker pool per account is pinned to it and sized to the account's history `perSecond` (capped by `scanner.perAccountConcurrency`), all pulling from one queue; the scheduler still paces every call. Conditions are parsed into a tree by a small recursive-descent parser and evaluated over candle series; nothing is ever `eval`'d.
- **Upstream back-off.** A broker 429 or rate-limit error (`UPSTREAM_RATE_LIMITED`) puts that `(account, class)` into back-off (Retry-After, else exponential from 1 s) and emits `limits.throttled`.
- **Client limits.** Each API key has its own budget (default 50 requests/s, configurable in the `ratelimit` config section), reported in `RateLimit` / `RateLimit-Policy` headers and 429 + `Retry-After`.
- **Observability.** `/v1/usage` shows used, queued and reset per class, and the calls saved by streaming, caching, coalescing and batching.

**StreamHub.** One upstream feed per account (`adapter.createFeed`), reference-counted subscriptions across all local clients, upstream mode = the highest mode any client wants, broker caps enforced (a client gets `SUBSCRIPTION_LIMIT`, never a silent drop), reconnect with back-off, resubscribe after re-login. Downstream protocol (WS and SSE): `snapshot` on subscribe, then `tick` with a per-connection `seq`, `status` (upstream up, down or stale), `heartbeat` every 15 s, `go_away` before shutdown. Clients authenticate with a 60-second stream token from `POST /v1/stream/token` (so keys never sit in URLs) or an Authorization header. Message schemas go in `docs/asyncapi.yaml` (S6).

## 7. Orders and paper trading

- **Request shape** (`OrderRequest` in openapi): `account`, `symbol`, `side`, exactly one of `quantity`/`lots`, `product` and `orderType` with **no defaults**, `price`/`triggerPrice` as the type requires, `validity`, `marketProtectionPct`, `mode` (default `paper`), `clientOrderId`, `tag`, `algoId`, `confirmToken`.
- **Idempotency.** `Idempotency-Key` header (or `clientOrderId` when the header is absent) on every write. The first request's status and body are stored before the broker call returns; a retry with the same key and same body replays it (`Idempotency-Replayed: true`); a different body gets 409 `IDEMPOTENCY_KEY_REUSED`; a concurrent retry 409 `IDEMPOTENCY_IN_PROGRESS`. Kept until the end of the IST trading day and at least 24 hours.
- **clientOrderId mapping.** Brokers allow short tags (Kite 20 characters, Upstox 40). The Bridge keeps `clientOrderId → { accountId, brokerOrderIds[], tag }` itself and writes a short derived tag where the broker supports one.
- **Pre-trade validation** (before any call): lot multiple, tick size, freeze quantity (slice above it where the adapter declares native slicing, otherwise refuse), allowed products and order types for the broker, price band against LTP.
- **Market orders.** `safety.marketOrders: "protect"` (default) sends MARKET/SL-M with broker-native market protection where the adapter supports it, or converts them to a LIMIT at LTP ± `marketProtectionPct` and says so in the response; `"reject"` refuses them. Several brokers already reject unprotected API market orders.
- **OUTCOME_UNKNOWN.** A write that times out or fails without a clear refusal is never retried. The order is stored as `outcome_unknown`, the response is 504 `OUTCOME_UNKNOWN`, and a reconciliation job (priority `live`) looks for it in the broker order book by tag and time, then resolves the status and emits `order.updated`.
- **Live path reuses the existing order gate.** Adapter `placeOrder/modifyOrder/cancelOrder` refuse without a single-use gate from `issueOrderGate()`; only OrderService mints one, right after SafetyGuard passes, for one call.
- **Paper fill model** (S8; documented in `/v1/paper/accounts/{id}`): MARKET fills at the opposite best price from depth when available, else LTP ± `slippageBps` (default 5 bps); LIMIT fills when LTP crosses the limit, at the limit; SL triggers on LTP crossing the trigger; fills are checked on every tick for subscribed symbols and at least every 2 s otherwise; no queue position, partial fills or market impact. Funds start at ₹10 lakh (configurable); intraday products are squared off at 15:20 IST for NSE/BSE F&O and cash (configurable). Order ids start with `PAPER-`.

## 8. Safety and security model

**Threats considered:** a malicious web page reaching localhost (DNS rebinding, CSRF); a leaked key in an Excel file, TradingView alert, screenshot or log; an AI assistant manipulated by prompt injection in instrument names or broker messages; a runaway TradingView alert loop; a script that retries a timed-out order; a stolen laptop; a second user on the same machine; the Bridge exposed to the internet by mistake.

| Control | Where | Detail |
|---|---|---|
| Loopback bind | core config | `127.0.0.1` default; another address needs `server.allowNonLoopback: true` in the file and logs a warning |
| Host allowlist | core security | DNS-rebinding guard on every request and upgrade |
| Origin allowlist (CORS) | core security | explicit origins only, no `*`; requests from unlisted origins are refused, not just un-CORSed |
| API keys | S2 | `mcb_<keyId>_<secret>`, 32 random bytes; only a **scrypt** hash stored (N=2^15, r=8, p=1, per-key salt, `timingSafeEqual`); shown once; expiry; revocation immediate |
| Scopes | core context + S2 | `read` ⊂ `paper` ⊂ `live`; `admin` ⊃ `read`; plus per-key account list |
| URL keys | core pipeline | `?key=` only on `/udf/*` and `/xl/*`, only for keys whose single scope is `read` and that were created with `allowQuery` |
| Stream tokens | S2 | 60-second, single-key tokens for WS/SSE URLs |
| Secrets at rest | S2 | **AES-256-GCM**, fresh 12-byte IV per write, entry name as AAD; key from `MCB_MASTER_KEY` (base64, 32 bytes) or `dataDir/master.key` (0600; refused if group/other-readable) |
| No second factors stored | S1, existing broker layer | passwords, PINs and TOTP codes are used once for the broker login and never stored, cached, logged or used as cache keys (`isForbiddenSecretKey`) |
| Log redaction | core logger | secret field names, Bridge keys, bearer tokens, JWTs and registered exact values are masked; access log never has query strings |
| Paper default + triple opt-in | core config, S7 | live needs `safety.liveTrading` + `account.live.enabled` (file only, env can never enable) + `live` key + allowed source + `"mode": "live"` |
| Order-rate cap | core config, S9 | default 5 orders/s per account, config may not exceed 10/s |
| Kill switch | S9 | any key can engage it (`POST /v1/safety/kill-switch`), optionally cancelling open orders; release needs admin from loopback and `confirm: "RELEASE"`; persisted across restarts; `MCB_KILL_SWITCH=1` engages at start |
| Daily limits | S9 | order count, realised loss, per-order value and lots; limits only ratchet down at runtime |
| Idempotency | S7 | as §7 |
| Audit log | S9 | append-only JSON lines, one `appendFileSync` per event, SHA-256 hash chain (`/v1/audit/verify`), redacted; every order, refusal, key change, session change and kill-switch action |
| Webhook auth | S11 | per-hook 128-bit+ URL token (hash stored, shown once); `generic` hooks also need `X-MCB-Signature: t=…,v1=HMAC-SHA256(secret, "t.body")` with a 5-minute window and replay cache; optional source-IP allowlist; each hook can only do what its definition allows |
| Public ingress | core | off by default; a separate listener that serves only `public` routes (webhooks), never the API |
| AI confirmation | S7, S11 | order tools prepare a ticket; a human confirms it in Option Hub with an admin key from this computer; client-side approval prompts and MCP annotations never count as confirmation; no tool can change paper/live mode, scopes or the kill switch release |
| Body limits and timeouts | core | 64 KB default bodies (16 KB for hooks), 30 s request timeout, broker calls time out via `brokerFetch` |

## 9. Symbology

Canonical format (implemented in `core/symbolFormat.mjs`, used by every stream):

```
NSE:RELIANCE                     equity          NSE:NIFTY                       index
NFO:NIFTY-2026-10-27-FUT         future          NFO:NIFTY-2026-10-27-25000-CE   option
BFO:SENSEX-2026-10-30-82500-PE   BSE option      NFO:VEDL-2026-10-27-292.5-CE    decimal strike
```

`EXCHANGE:UNDERLYING[-YYYY-MM-DD(-FUT | -STRIKE-CE | -STRIKE-PE)]`, exchange codes `NSE BSE NFO BFO MCX CDS` (the broker contract's own). **Why:** readable (what, when, which strike and side), ISO dates remove the weekly-code and DDMMMYY/YYMDD ambiguity of exchange trading symbols, parsing from the right keeps names like `BAJAJ-AUTO` and `M&M` safe, and it is reversible with no lookup. Inputs are lenient (case, `NSE:` venue form for derivatives); outputs are always canonical.

**Aliases accepted** (`/v1/symbols/convert`, and anywhere a symbol is accepted): TradingView tickers (`NSE:NIFTY`, continuous `NSE:NIFTY1!` resolved to the current expiry, options `NSE:NIFTY261027C25000` **(needs verification of TradingView's NSE option naming)**), compact trading symbols with an exchange (`NIFTY27OCT2625000CE` + `NFO`, `from=compact`), and broker-native tokens or trading symbols with a `broker` parameter.

**Resolution (S4):** instrument masters from each connected broker's `fetchInstruments`, cached per IST day, merged by canonical id into `ResolvedInstrument { lotSize, tickSize, freezeQty, isin, refs: { <broker>: { token, exchange, tradingSymbol } } }`. Expired contracts drop out (exchange tokens get reused after expiry, so a token is never an identity). Lot sizes change: never hard-code them, never guess (unknown → `SYMBOL_NOT_FOUND`). Freeze quantities come from the master where a broker publishes them, otherwise from an exchange list **(needs verification per segment)**.

## 10. Integrations

- **Charts (S10, UDF).** `/udf/config|symbols|search|history|time|quotes` in UDF format (Unix seconds, column arrays, `s: ok|no_data|error`), `Asia/Kolkata` sessions (`0915-1530` for NSE cash and F&O; special sessions from exchange data, not hard-coded **(needs verification)**), `minmov`/`pricescale` from tick size. TradingView Advanced Charts is not licensed for personal or private use, so Option Hub's bundled chart should be Lightweight Charts (Apache 2.0, attribution required); the UDF feed still serves anyone who holds their own Advanced Charts licence **(licence terms need verification)**. Live bars come from the WebSocket.
- **Spreadsheets and AmiBroker (S10).** `/xl/ltp` and `/xl/quote` return one value as plain text (Excel `WEBSERVICE` is GET-only, Windows desktop only, 2,048-character URLs, 32,767-character results); `/xl/chain` and `/xl/history` return flat CSV or JSON records for Power Query, Google Sheets and AmiBroker ASCII import (`layout=amibroker` plus a shipped `.format` file and an AFL include). CSV output guards against formula injection. Google Sheets `IMPORTDATA` and Apps Script run on Google's servers and cannot reach localhost; they need the user's tunnel and a read-only URL key, and refresh only hourly.
- **Webhooks (S11).** TradingView sends only to ports 80/443, over IPv4, from four published addresses (52.89.214.238, 34.212.75.30, 54.218.53.128, 52.32.178.7), needs 2FA on the TradingView account, and abandons requests after **3 seconds**; it cannot sign requests and advises against credentials in the body. So: per-hook URL token, optional IP allowlist, fast 202 and asynchronous processing, idempotency from `{{strategy.order.id}}`+`{{timenow}}` where the template provides it, and per-hook action mapping (account, symbols, lots cap, product, paper/live, confirmation). ChartInk posts a fixed JSON with comma-joined `stocks` and `trigger_prices` and a dateless `triggered_at`; GoCharting posts plain text. A copy-paste alert-template generator ships with the hooks UI.
- **AI (S11, MCP).** Built on `@modelcontextprotocol/sdk` with protocol-version negotiation (the spec moved to a stateless revision 2026-07-28; which revision each client speaks **needs verification**). Transports: Streamable HTTP at `POST /mcp` (loopback, Host/Origin checked, bearer key) and stdio via the `mc-bridge mcp` relay. Toolsets: market data, analytics, account, orders; fewer than 20 tools by default, listed in a fixed order, all four annotations set explicitly, `outputSchema` + `structuredContent`, results wrapped in an untrusted-data envelope (instrument names and broker messages are third-party text). Order tools exist only when the config enables them for that account and the key has the scope, and they only prepare tickets. The same tool registry is exported as strict OpenAI function schemas. Remote access (ChatGPT, claude.ai web) needs a tunnel plus OAuth and is out of scope for v1.
- **SDKs (S10).** Thin Python and Node clients generated from or hand-written against `openapi.yaml`, with idempotency keys by default and stream-token handling.

## 11. API conventions

- Base path `/v1`; additive changes only within v1. `GET /v1/meta` reports versions and routes.
- Success: `{ "data": …, "meta": { "requestId", "nextCursor"?, "accountId"?, "mode"?, "freshness"? } }`. UDF, `/xl/*` and MCP use their consumers' formats.
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
| Market data terms | Broker API terms generally forbid passing market data to others (Kite: personal use) | Personal-use notice; loopback; no multi-user or public data endpoints; pooling only across accounts with the same `holder`, only among accounts the calling key may use, and only where the broker policy allows **(needs verification per broker)** |

## 13. What we will not do

- Store passwords, PINs, MPINs or TOTP secrets/codes, or automate a broker's 2FA.
- Let any API call, environment variable, MCP tool or webhook switch on live trading, widen a key's scopes or release the kill switch remotely.
- Serve data or orders to anyone other than the user (and family accounts they configure); run as a hosted multi-user service; expose the API on a public interface by default.
- Share credentials or sessions between users, or move one account's credentials to another account's calls.
- Exceed or "burst past" a documented broker limit, retry an order write blindly, or silently drop a safety parameter.
- Send plain market orders without protection; default a product or order type.
- Place orders from Excel formulas or GET URLs; nothing under `/xl` or `/udf` can trade.
- Ship trading strategies, signals or "AI picks".
- Write an adapter from anything but the broker's official docs, SDKs and Postman collections.
- Bundle TradingView Advanced Charts.

## 14. Configuration and environment

`bridge.config.json` (see `bridge.config.example.json`). Core sections: `server`, `cors`, `dataDir`, `logging`, `accounts`, `safety`. Module sections (each validated by its module's zod schema): `ratelimit` (S3), `symbols` (S4), `market` (S5), `stream` (S6), `orders` (S7), `paper` (S8), `integrations` (S10), `hooks` and `mcp` (S11). Unknown sections are errors.

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
| Default port 4300 | avoids Option Hub's proxy (4002) and common dev ports |
