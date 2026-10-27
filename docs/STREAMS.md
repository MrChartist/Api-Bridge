# Build streams

Eleven streams build the Bridge in parallel on top of the shared core. Read [ARCHITECTURE.md](ARCHITECTURE.md) first; the HTTP contract is [openapi.yaml](openapi.yaml) and the code contracts are `server/bridge/core/contracts.mjs`.

## Rules for every stream

1. **File ownership is strict.** You may create and edit only the paths listed under your stream. Everything else is read-only to you. If you need a change elsewhere, ask its owner (or the lead for core).
2. **Lead-owned (core) files:** `server/bridge/core/**`, `bin/**`, `docs/ARCHITECTURE.md`, `docs/openapi.yaml`, `docs/STREAMS.md`, `package.json`, `package-lock.json`, `vitest.config.mjs`, `scripts/check-mjs.mjs`, `bridge.config.example.json`, `README.md`, `.gitignore`, `LICENSE` (never changes). Contract changes (a method, a route, a scope, a config key in a core section, a dependency) go through the lead, who updates `contracts.mjs`, `openapi.yaml` and tests together.
3. **Frozen broker layer:** `server/brokers/**` and `server/lib/**` are reused, not edited. Report adapter bugs to the lead with a failing fixture; the lead lands broker-layer fixes separately. Reuse is encouraged: `brokers/registry.mjs` (via `deps.brokers`), `brokers/contract.mjs` errors and `redactSecrets`, `brokers/orderGate.mjs` (S7 only mints gates), `brokers/upstreamFeedLimits.mjs` (S6), `lib/marketHours.mjs` (S9), `lib/blackScholes.mjs` (S5), `lib/boundedCache.mjs`.
4. **Keep the contract.** Your service must expose exactly the methods in `SERVICE_CONTRACTS` (extra internal helpers are fine; other streams call only contract methods). Keep each route's method, path and options as registered in your `module.mjs`; `core/openapi.test.mjs` fails on drift. Replace `notBuilt(...)` handlers with real ones.
5. **Use the core:** `BridgeError` codes from `core/errors.mjs` (add none yourself; ask the lead), `fromBrokerError` for adapter errors, `ctx.requireAccountAccess`, `deps.logger` (never `console`), `deps.bus` topics from `core/eventBus.mjs`, `deps.clock.now()` (testable time), zod for input validation, `json/text/csv` replies from `core/http.mjs`, canonical symbols from `core/symbolFormat.mjs`.
6. **Every broker call goes through `deps.scheduler.schedule()`** with the right endpoint class and priority. Never call `fetch` or an adapter directly from a route.
7. **Secrets:** never log, return, cache-key or persist (outside SecretStore) a credential. Passwords, PINs and TOTP codes are never stored anywhere.
8. **Tests:** Vitest, files next to the code (`*.test.mjs`). No live network calls: stub adapters, use `contractHarness.mjs` fixtures, or the fakes other streams publish. Each stream publishes **`server/bridge/<dir>/fake.mjs`** in its first PR: an in-memory implementation of its service contract for other streams' tests.
9. **Copy:** user-facing text in Indian English, plain and specific ("Log in again from the Bridge; your Zerodha session ended at 6 am."). Amounts in rupees with Indian grouping where formatted (₹2,00,000).
10. **Licence and sources:** see `LICENSE`. Broker facts come only from each broker's official docs, SDKs and Postman collections. No git write commands in agent sessions.
11. **Definition of done:** `npx vitest run` and `node scripts/check-mjs.mjs` pass; your stub is gone (`/v1/health` shows `ready`); routes answer per `openapi.yaml`; acceptance criteria below hold; your section of the stream checklist is ticked in the PR description.

## Dependency and merge order

All streams can start on day one against fakes. Merge order (each stream rebases on the previous): **S2 → S9 → S1 → S3 → S4 → S6 → S5 → S8 → S7 → S10 → S11**.

| Stream | Builds | Consumes |
|---|---|---|
| S1 | accounts | secrets, brokers |
| S2 | secrets, keyStore | none |
| S3 | scheduler | accounts |
| S4 | symbols | accounts, scheduler |
| S5 | marketData | accounts, scheduler, symbols, streamHub, backupData (optional) |
| S6 | streamHub | accounts, symbols (keyStore for WS auth) |
| S7 | orders | accounts, scheduler, symbols, safety, audit, paper, marketData |
| S8 | paper | marketData, symbols |
| S9 | safety, audit | accounts |
| S10 | (routes) | marketData, symbols, keyStore |
| S11 | (routes, MCP relay) | orders, marketData, symbols, accounts, safety, audit, keyStore |
| S12 | backupData (Yahoo Finance, NSE website) | none (core deps only) |
| S13 | (routes: scanner) | marketData, accounts, scheduler, symbols, backupData |
| S15 | (routes: notify, outbound alerts) | bus events only |
| S14 | (routes: compat `/api/v1`, WS `/api/v1/ws`) | orders, marketData, symbols, accounts, keyStore, streamHub, backupData |

---

## S1 — Accounts and broker sessions

**Owns:** `server/bridge/accounts/**` (`module.mjs`, `accountManager.mjs`, `fake.mjs`, any helpers and tests).
**Implements:** `AccountManager` (`deps.accounts`). **Routes:** `GET /v1/brokers`, `GET /v1/accounts`, `GET /v1/accounts/{accountId}`, `POST|DELETE /v1/accounts/{accountId}/session`, `POST /v1/accounts/{accountId}/test`.

Tasks:
- Build account summaries from `config.accounts` and `deps.brokers` (adapter `capabilities`, `auth.kind`); the virtual `paper` broker has no adapter.
- `connect`: validate `values` against the adapter's `credentialFields` (reject secret-looking keys with `isForbiddenSecretKey`); for `sessionLogin` adapters pass `secrets` to `adapter.login()` once (reuse `brokers/sessionLogin.mjs` helpers) and keep only `auth.sessionFields`; store `{ values, session, sessionExpiresAt }` in `deps.secrets` under `account:<id>`; for `requestTokenExchange`/`oauthRedirect` follow the adapter's documented exchange.
- `creds(id)`: decrypted values + session fields; throw `SESSION_EXPIRED` when expired or missing (map `SessionRequiredError`).
- Session state machine (`missing → connected → expired | error`), expiry timers, `account.status` events. Listen for `account.session_rejected` (emitted by the scheduler when a broker call fails with a session error) and mark the account expired.
- `marketDataCandidates` exactly as documented in the contract. Read each broker's `pooling` flag from `BROKER_POLICIES` in `../ratelimit/brokerPolicies.mjs` (a data-only module S3 publishes in its first PR; import it, do not edit it; until it exists treat every broker as `unknown`). Keep the result order stable (config order).
- Filter `/v1/accounts` by the key's `accounts` list. Audit `account.connected` / `account.disconnected` (via `deps.audit` once S9 lands; tolerate the stub in tests).
- `/v1/brokers`: id, name, authKind, capabilities, `verified` (only Dhan today), policy (from S3).

Acceptance: no secret ever appears in a response, log or audit line (test with a capturing logger); session-login secrets never reach SecretStore (assert on the fake); a store change made by the CLI is picked up by the server (re-read on file change).

## S2 — API keys, secrets and stream tokens

**Owns:** `server/bridge/auth/**` (`module.mjs`, `keyStore.mjs`, `secretStore.mjs`, `hmac.mjs`, `fake.mjs`, tests).
**Implements:** `SecretStore` (`deps.secrets`), `KeyStore` (`deps.keyStore`). **Routes:** `GET|POST /v1/keys`, `DELETE /v1/keys/{keyId}`, `POST /v1/stream/token`.

Tasks:
- SecretStore: AES-256-GCM, 12-byte random IV per write, entry name as AAD, versioned file header, atomic writes, key from `MCB_MASTER_KEY` (base64 of exactly 32 bytes) or `MCB_MASTER_KEY_FILE` / `dataDir/master.key` (generate with 0600 on first use; refuse a group/other-readable file on POSIX); `logger.addSecret` for every decrypted string ≥ 6 chars; tamper → clear error, never partial data.
- KeyStore: key format `mcb_<keyId>_<secret>` (keyId 10 lowercase base32; secret 32 random bytes base64url); store only `scrypt(secret, salt, N=2^15, r=8, p=1, 32)`; `timingSafeEqual`; expiry; revocation; `lastUsedAt` written at most once a minute; verified-key cache keyed by an HMAC of the full key with a per-process random key, 60 s TTL, cleared on revoke; reload `keys.json` when it changes on disk (CLI edits).
- Rules: `allowQuery` only when scopes are exactly `["read"]`; creating `live` or `admin` keys only from loopback (route is already `loopbackOnly`).
- Stream tokens: random 32 bytes, in memory, bound to the key record, 60 s to connect, single use.
- `hmac.mjs`: `sign(secret, timestamp, rawBody)` and `verify(header, secret, rawBody, { now, toleranceS: 300, seen })` for `X-MCB-Signature: t=…,v1=…` with a replay cache. S11 imports it.
- Audit `key.created` / `key.revoked` from the routes.

Acceptance: a wrong key costs the same time as a right one (no early exit on prefix); keys never appear in logs (capture test); a revoked key fails on the very next request; tampered `secrets.enc` is detected.

## S3 — Rate-limit engine and routing

**Owns:** `server/bridge/ratelimit/**` (`module.mjs`, `scheduler.mjs`, `brokerPolicies.mjs`, `tokenBucket.mjs`, `priorityQueue.mjs`, `fake.mjs`, tests).
**Implements:** `Scheduler` (`deps.scheduler`). **Routes:** `GET /v1/limits`, `GET /v1/usage`. **Config section:** `ratelimit` (client requests per second per key, default 50; per-broker overrides that may only LOWER limits).

Tasks:
- `brokerPolicies.mjs`: one entry per adapter id (all 41) with per-class `{ perSecond, perMinute, perDay, verified, source }`, `maxQuoteBatch`, feed caps, `pooling` (`unknown` unless a broker's terms clearly allow spreading one user's reads across that user's accounts), `maxModificationsPerOrder`. Start from ARCHITECTURE §6 and each broker's official docs; anything not verified gets the conservative defaults. Export it early (S1 and S5 read it).
- Token buckets with second/minute/day windows; IST day boundaries for daily caps; per `(accountId, endpointClass)`.
- Priority queue per account with ageing; abort via `signal`; bounded queue length per class (reject with `UPSTREAM_RATE_LIMITED` + `retryAfterMs` when a request could not start before its deadline).
- Singleflight coalescing by `coalesceKey`; back-off on upstream throttling; `pickAccount` by headroom and health.
- When a scheduled call fails with a session error (`SessionRequiredError`, `UPSTREAM_AUTH`, `SESSION_EXPIRED`), emit `account.session_rejected` so S1 can mark the account expired; rethrow the error unchanged.
- `checkClient(ctx)`: per-key budget with `RateLimit` / `RateLimit-Policy` headers.
- `usage()` plus savings counters (S5 reports stream/cache/batch hits through an exported `recordSaving(kind)` helper or the bus).

Acceptance (fake clock, no sleeps): no window ever exceeds its limit under a 1,000-request burst; an order queued behind 500 reads starts first; background work completes under sustained interactive load; 50 identical concurrent reads make one call; a broker 429 pauses only that account and class.

## S4 — Symbology and instruments

**Owns:** `server/bridge/symbols/**` (`module.mjs`, `symbolService.mjs`, `instrumentStore.mjs`, `aliases.mjs`, `fake.mjs`, tests).
**Implements:** `SymbolService` (`deps.symbols`). **Routes:** `GET /v1/instruments/search`, `GET /v1/instruments/{symbol}`, `GET|POST /v1/symbols/convert`.

Tasks:
- Delegate `parse`/`format` to `core/symbolFormat.mjs` (do not fork the format).
- Load each connected broker's master through `scheduler.schedule({ endpointClass: "master", priority: "background" })`, map contract `Instrument` rows to canonical ids (index underlyings via `CANONICAL_UNDERLYINGS`), merge across brokers into `ResolvedInstrument`, cache per broker per IST day in `dataDir/instruments/`, refresh after 08:30 IST and on demand.
- `resolve`: canonical, venue form, TradingView (continuous `1!`/`2!` → nearest/next expiry), compact (`NIFTY27OCT2625000CE` + exchange), broker-native (`broker` + token or trading symbol). Kind correction for cash symbols (index vs equity) from the master.
- Search with ranking (exact symbol, underlying, then fuzzy), cursor pagination.
- Freeze quantities: from masters where present, else a dated exchange list file you own (mark `verified`).

Acceptance: round-trip canonical ↔ every connected broker ref for fixture masters of at least Dhan, Zerodha, Upstox, Angel One and Fyers; expired contracts never resolve; unknown lot size gives `SYMBOL_NOT_FOUND`, never a guess.

## S5 — Market data service and REST

**Owns:** `server/bridge/market/**` (`module.mjs`, `marketDataService.mjs`, `freshnessCache.mjs`, `batcher.mjs`, `normalise.mjs`, `fake.mjs`, tests).
**Implements:** `MarketDataService` (`deps.marketData`). **Routes:** `GET /v1/ltp`, `/v1/quotes`, `/v1/depth`, `/v1/history`, `/v1/expiries`, `/v1/optionchain`. **Config section:** `market` (freshness targets: may be tightened freely, or loosened only up to documented maximums).

Tasks:
- Read path per ARCHITECTURE §4: stream tick → freshness cache → batched, coalesced, scheduled broker call; pinned vs pooled accounts; `Freshness` on every item; `stale: true` labelling when serving cache under budget pressure (never for depth older than 5 s).
- Normalise adapter shapes (`Quote`, `Depth`, `Candle`, Dhan-shaped chain legs via `brokers/contractShapes.mjs toOptionData`) into the OpenAPI shapes; canonical symbols out.
- History: interval mapping, chunking by each broker's max span (respect `HISTORICAL_MAX_SPAN_DAYS`-style bounds), merge, de-duplicate, `partial` flag; CSV output with IST times.
- Option chain: broker chain where declared, else built from master + quotes; computed Greeks via `lib/blackScholes.mjs` with stated inputs; `greeksSource`.
- Per-item errors in `errors[]` instead of failing the whole batch.

Acceptance: with a fake adapter that counts calls, 20 clients polling the same 50 symbols every second cause at most the broker's quote limit of calls; a live tick is served with `source: "stream"` and zero REST calls.

## S6 — Live streaming (WebSocket and SSE)

**Owns:** `server/bridge/stream/**` (`module.mjs`, `streamHub.mjs`, `wsServer.mjs`, `sse.mjs`, `protocol.mjs`, `candles.mjs`, `fake.mjs`, tests) and `docs/asyncapi.yaml`.
**Implements:** `StreamHub` (`deps.streamHub`). **Routes:** WS upgrade `/v1/stream`, `GET /v1/stream/sse` (auth custom), `GET /v1/stream/stats`. **Config section:** `stream` (heartbeat, max clients, max symbols per client).

Tasks:
- Upstream manager: one `adapter.createFeed(creds, { onTick, onStatus })` per account, map adapter `Quote` ticks to canonical `Tick`, reference-counted subscriptions, mode upgrade/downgrade, caps from policy and `upstreamFeedLimits.mjs`, reconnect with jittered back-off, resubscribe on `account.status` connected; emit `tick` and `stream.status`.
- Downstream protocol (AsyncAPI 3.0 in `docs/asyncapi.yaml`): auth by stream token (`keyStore.verifyStreamToken`) or `Authorization` header; ops `subscribe`, `unsubscribe`, `subscribe_orders`, `ping`; messages `snapshot`, `tick` (per-connection `seq`), `order` (from `order.updated`, filtered by key accounts), `status`, `error`, `heartbeat`, `go_away`; backpressure (drop to latest-value per symbol for slow clients, never unbounded buffers).
- SSE with the same messages; `go_away` on shutdown (`stop()`).
- Tick-to-candle aggregator (1m and up, IST session aligned) for S10's live bars.

Acceptance: two clients subscribing the same symbol create one upstream subscription; unsubscribing both removes it; a broker cap overflow returns `SUBSCRIPTION_LIMIT` to the client that crossed it; a reconnect resubscribes everything; a slow client cannot grow memory without bound.

## S7 — Orders, idempotency and portfolio

**Owns:** `server/bridge/orders/**` (`module.mjs`, `orderService.mjs`, `idempotencyStore.mjs`, `orderValidation.mjs`, `reconcile.mjs`, `tickets.mjs`, `portfolio.mjs`, `fake.mjs`, tests). **Config section:** `orders` (ticket TTL, reconciliation interval).
**Implements:** `OrderService` (`deps.orders`). **Routes:** `/v1/orders` (GET, POST), `/v1/orders/preview`, `/v1/orders/cancel-all`, `/v1/orders/by-client-id/{id}`, `/v1/orders/{orderId}` (GET, PATCH, DELETE), `/v1/trades`, `/v1/positions`, `/v1/holdings`, `/v1/funds`, `GET /v1/tickets`, `POST /v1/tickets/{ticketId}/confirm`.

Tasks:
- zod schema for `OrderRequest` matching openapi exactly (no defaults for product/orderType; exactly one of quantity/lots).
- Mode decision (triple opt-in + explicit `mode: "live"` + allowed source + confirmation for `mcp` and confirmation-required hooks); otherwise paper or `PAPER_ONLY`.
- Pre-trade validation: lot multiple, tick, freeze quantity (slice only where the adapter supports it), product/order-type support, market-order policy (`protect` → native protection or LIMIT at LTP ± pct with a warning; `reject`).
- Idempotency store (persisted, IST-day retention), `clientOrderId` map and short broker tags.
- Live path: `safety.check` → `safety.acquireOrderSlot` → `issueOrderGate` → `scheduler.schedule(order, priority order)` → adapter call → `fromBrokerError(..., { write: true })`; `OUTCOME_UNKNOWN` records and the reconciliation job; `order.updated` events; audit every step.
- Paper path delegates to `deps.paper`. Portfolio reads: live through the scheduler (`portfolio` class, never cached), paper through `deps.paper`; symbols mapped back to canonical.
- Tickets: created by `preview` when confirmation is required, listed by `tickets`, confirmed by an admin from loopback, single-use `confirmToken` bound to the exact order body, 60 s TTL.
- Subscribe to `safety.kill_switch` and run `cancelAll` when `cancelOpenOrders` is set.

Acceptance: the same Idempotency-Key never reaches the adapter twice (concurrency test); a timed-out live call is never retried and becomes `outcome_unknown`, then resolves from a fixture order book; a live request without each opt-in fails with the right code; an AI-sourced order without a confirmed ticket never reaches the adapter.

## S8 — Paper trading engine

**Owns:** `server/bridge/paper/**` (`module.mjs`, `paperEngine.mjs`, `fillModel.mjs`, `paperStore.mjs`, `fake.mjs`, tests). **Config section:** `paper` (starting capital default ₹10,00,000, slippage bps default 5, intraday square-off time default 15:20 IST, brokerage model).
**Implements:** `PaperEngine` (`deps.paper`). **Routes:** `GET /v1/paper/accounts/{accountId}`, `POST /v1/paper/accounts/{accountId}/reset`.

Tasks: order book and state machine (open, trigger_pending, filled, cancelled, rejected, expired at end of day; v1 fills are whole, never partial); fill model from ARCHITECTURE §7 using `deps.marketData` and `tick` events; positions with average price and realised/unrealised P&L; funds and simple margin blocking (premium for option buys, a configurable percentage for futures and option sells; documented as approximate); intraday square-off; persistence with atomic writes; `PAPER-` ids; report fills to `deps.bus` as `order.updated` with `mode: "paper"`.

Acceptance: deterministic fills with a fake clock and fake prices; restart restores state; P&L reconciles to trades in tests.

## S9 — Safety guard and audit log

**Owns:** `server/bridge/safety/**` (`module.mjs`, `safetyGuard.mjs`, `auditLog.mjs`, `killSwitch.mjs`, `dailyCounters.mjs`, `fake.mjs`, tests).
**Implements:** `SafetyGuard` (`deps.safety`), `AuditLog` (`deps.audit`). **Routes:** `GET /v1/safety`, `POST|DELETE /v1/safety/kill-switch`, `GET /v1/audit`, `GET /v1/audit/verify`.

Tasks:
- `check()`: kill switch, live enablement (`liveAllowedByConfig`, key scope, allowed source), order-rate cap (`effectiveAccountLimits`, never above 10/s), daily order count and realised loss (IST day), max value and lots, price band against LTP, market-order policy, market hours (`lib/marketHours.mjs`), static-IP warning when `registeredIp` is set and the detected egress differs (detection is best-effort and only warns); returns all reasons, not just the first.
- `acquireOrderSlot()` sliding-window per account counting place, modify and cancel.
- Kill switch: persisted, audited, `MCB_KILL_SWITCH` / `killSwitchOnStart`, release only admin + loopback + `confirm: "RELEASE"`, `safety.kill_switch` event with `cancelOpenOrders`.
- Audit log: hash chain per ARCHITECTURE §8, IST-day files, `query` with cursor, `verify`; redact with `core/logger.mjs redact`.

Acceptance: limits only ratchet down at runtime; a restart keeps the kill switch and today's counters; editing any audit line makes `verify` report the exact line; no secret reaches the audit file (capture test).

## S10 — Charting datafeed, spreadsheets, AmiBroker and SDKs

**Owns:** `server/bridge/integrations/**` (`module.mjs`, `udf.mjs`, `xl.mjs`, `fake.mjs` if needed, tests), `integrations/` at the repo root (AmiBroker `.format` file and AFL include, Excel and Google Sheets examples, Lightweight Charts example page), `sdk/python/**`, `sdk/node/**`. **Config section:** `integrations` (UDF supported resolutions, CSV defaults).
**Routes:** `/udf/config`, `/udf/symbols`, `/udf/search`, `/udf/history`, `/udf/time`, `/udf/quotes`, `/xl/ltp`, `/xl/quote`, `/xl/chain`, `/xl/history`.

Tasks: UDF per the TradingView UDF spec (Unix seconds, column arrays, `no_data` with `nextTime`, `countback`, IST sessions, `minmov`/`pricescale` from tick size, daily bars at 00:00 UTC); `/xl/*` plain-text single values (`#N/A` on errors with a 4xx), flat CSV/JSON tables with formula-injection guarding (`core/http.mjs csv`), AmiBroker layout; AFL include that reads the key from a file or environment (never inline in strategy files); Python and Node SDKs (typed models from openapi, idempotency keys by default, stream-token WebSocket helper, retry only when `retryable`), each with tests against a local fake server.

Acceptance: a UDF conformance test with recorded TradingView request sequences; Excel WEBSERVICE results stay under 32,767 characters; nothing in this stream can place an order.

## S11 — Webhooks and MCP for AI assistants

**Owns:** `server/bridge/hooks/**` (`module.mjs`, `hookStore.mjs`, `receivers/tradingview.mjs`, `receivers/chartink.mjs`, `receivers/gocharting.mjs`, `receivers/generic.mjs`, `worker.mjs`, `templates.mjs`, tests) and `server/bridge/mcp/**` (`module.mjs`, `server.mjs`, `tools.mjs`, `stdio.mjs`, `openaiSchemas.mjs`, tests). **Config sections:** `hooks` (signal queue size, dedupe window, allowed source IPs) and `mcp` (enabled toolsets, whether order tools exist per account; default read-only).
**Routes:** `POST /hooks/{source}/{token}` (public, auth custom), `GET|POST /v1/hooks`, `DELETE /v1/hooks/{hookId}`, `POST /mcp`; CLI `mc-bridge mcp` via `runStdio`.

Tasks (webhooks): hook definitions with token hashes (shown once), per-hook mapping and caps, receivers for TradingView (JSON or text, `{{…}}` placeholders, idempotency from strategy order id + time), ChartInk (comma-joined lists, dateless time stamped in IST), GoCharting (text), generic (HMAC via `auth/hmac.mjs`, 5-minute window, replay cache); optional source-IP allowlist (TradingView's four published IPs as a preset); reply 202 fast, process in a bounded queue through `orders.preview`/`orders.place` with `source: "webhook"`; template generator for alert messages.

Tasks (MCP): `@modelcontextprotocol/sdk` server with version negotiation; Streamable HTTP on `POST /mcp` (core has already checked Host, Origin and the key); stdio relay (`runStdio`) to the running Bridge; tool registry with toolsets (market data, analytics, account, orders), explicit annotations, `outputSchema` + `structuredContent`, an untrusted-data envelope around third-party text, pagination for big results, fixed tool order, under 20 default tools; order tools only prepare tickets (never place directly) and exist only when config and key allow; no tool for modes, scopes or kill-switch release; export the same registry as strict OpenAI function schemas.

Acceptance: a webhook acknowledged within 50 ms under load; a replayed or stale signed request is refused; a TradingView double-fire creates one order; an MCP session with a `read` key lists no order tools; an AI-prepared order cannot reach a broker without a ticket confirmed through `/v1/tickets`.

---

## Stream checklist (copy into your PR description)

```
Stream: S__ — <name>                engineer: <name>
[ ] Only owned files changed (git diff --stat checked)
[ ] Contract methods all implemented; stub removed; /v1/health shows ready
[ ] Routes match docs/openapi.yaml (core/openapi.test.mjs green); handlers validate input with zod
[ ] fake.mjs published for other streams
[ ] Every broker call through deps.scheduler.schedule (class + priority)
[ ] No secret in logs, responses, audit lines, cache keys or fixtures (capture test included)
[ ] Errors use core codes; broker errors through fromBrokerError (writes: { write: true })
[ ] Tests use fixtures/fakes only; no network; fake clock where time matters
[ ] Copy in Indian English; needs-verification facts marked in code comments with a source URL
[ ] npx vitest run · node scripts/check-mjs.mjs
```
