/**
 * Service contracts: the interfaces the 11 streams build against (docs/STREAMS.md).
 *
 * Each shared service lives in `deps` under a fixed key (SERVICE_CONTRACTS below), is owned by exactly one stream,
 * and must expose exactly the listed methods. app.mjs checks every service with assertService() at boot, so a
 * stream can change HOW a method works but not WHICH methods exist; changing this file is a core change made by
 * the lead. Until a stream lands, its service is a stub from notImplementedService(): it boots, and every call
 * throws NotImplementedError (HTTP 501 NOT_IMPLEMENTED).
 *
 * Conventions every implementation follows:
 *  - Symbols at service boundaries are canonical Bridge symbols (see symbolFormat.mjs), never broker tokens.
 *  - `ctx` is a RequestContext (context.mjs). Services that act for a caller take it first and enforce
 *    ctx.requireAccountAccess() themselves; routes enforce scopes.
 *  - Errors are BridgeError (errors.mjs). Broker adapter errors go through fromBrokerError().
 *  - Every broker call goes through deps.scheduler.schedule(); nothing calls an adapter method directly except
 *    AccountManager (testConnection/login), StreamHub (createFeed), and the function passed to schedule().
 *  - Nothing logs or returns a secret. Broker credentials leave AccountManager only through creds().
 */
import { NotImplementedError } from "./errors.mjs";

// ───────────────────────────── Shared types ─────────────────────────────

/**
 * @typedef {"NSE"|"BSE"|"NFO"|"BFO"|"MCX"|"CDS"} Exchange   Same codes as the broker contract.
 * @typedef {"INDEX"|"EQ"|"FUT"|"OPT"} InstrumentKind
 * @typedef {{ canonical: string, exchange: Exchange, kind: InstrumentKind, underlying: string,
 *   expiry: string | null, strike: number | null, right: "CE"|"PE"|null }} ParsedSymbol
 * @typedef {{ token: string, exchange: Exchange, tradingSymbol: string | null }} BrokerRef
 * @typedef {ParsedSymbol & { name: string | null, lotSize: number, tickSize: number, freezeQty: number | null,
 *   isin: string | null, refs: Record<string, BrokerRef> }} ResolvedInstrument   refs keyed by broker id.
 *
 * @typedef {{ source: "stream"|"cache"|"broker"|"paper"|"backup", asOf: string, ageMs: number, stale: boolean,
 *   accountId: string | null, broker: string | null, provider?: string }} Freshness
 *   Attached to every market-data item. `asOf` is ISO-8601 with offset (+05:30). `stale` = older than the freshness
 *   target the caller asked for (maxAgeMs) or than the endpoint default. source "backup" = a free public source
 *   (BackupDataService, named in `provider`), used only when no broker account could answer; accountId/broker null.
 * @typedef {{ symbol: string, ltp: number, freshness: Freshness }} LtpItem
 * @typedef {{ symbol: string, ltp: number, open: number|null, high: number|null, low: number|null, close: number|null,
 *   change: number|null, changePct: number|null, volume: number|null, oi: number|null, bid: number|null, ask: number|null,
 *   bidQty: number|null, askQty: number|null, freshness: Freshness }} QuoteItem
 * @typedef {{ symbol: string, bids: Array<{ price: number, qty: number, orders: number|null }>,
 *   asks: Array<{ price: number, qty: number, orders: number|null }>, freshness: Freshness }} DepthItem
 * @typedef {"1m"|"3m"|"5m"|"10m"|"15m"|"30m"|"60m"|"1d"|"1w"|"1M"} Interval
 * @typedef {{ time: number, open: number, high: number, low: number, close: number, volume: number, oi?: number }} Candle  time = epoch seconds (bar open).
 * @typedef {{ symbol: string, interval: Interval, candles: Candle[], freshness: Freshness, partial: boolean }} HistoryResult
 * @typedef {{ strike: number, ce: ChainLeg | null, pe: ChainLeg | null }} ChainRow
 * @typedef {{ symbol: string, ltp: number|null, bid: number|null, ask: number|null, oi: number|null, oiChange: number|null,
 *   volume: number|null, iv: number|null, delta: number|null, gamma: number|null, theta: number|null, vega: number|null,
 *   greeksSource: "broker"|"computed"|null }} ChainLeg   iv in percent.
 * @typedef {{ underlying: string, expiry: string, underlyingLtp: number|null, atmStrike: number|null, lotSize: number|null,
 *   rows: ChainRow[], freshness: Freshness }} OptionChain
 * @typedef {{ accountId?: string, maxAgeMs?: number, priority?: Priority, signal?: AbortSignal, allowBackup?: boolean }} ReadOptions
 *   accountId pins the read to one account (no pooling). maxAgeMs: freshest acceptable data (0 = must hit stream/broker).
 *   allowBackup: an unpinned read that no broker account could answer may be served by BackupDataService. Default
 *   false, so orders, paper fills and safety checks never see backup prices; routes for people and tools opt in.
 *
 * @typedef {"order"|"quote"|"depth"|"history"|"chain"|"portfolio"|"master"|"other"} EndpointClass
 * @typedef {"order"|"live"|"interactive"|"background"} Priority   Highest first.
 * @typedef {{ perSecond?: number, perMinute?: number, perDay?: number, verified: boolean, source?: string,
 *   extraWindows?: Array<{ windowMs: number, limit: number }> }} LimitSpec
 * @typedef {{ brokerId: string, limits: Partial<Record<EndpointClass, LimitSpec>>, maxQuoteBatch: number,
 *   feed: { maxConnections: number|null, maxSubscriptions: number|null }, pooling: "allowed"|"not-allowed"|"unknown",
 *   maxModificationsPerOrder: number|null, notes?: string, groups?: Record<string, LimitSpec & { classes: EndpointClass[] }>,
 *   known?: boolean, defaulted?: boolean, derivedPerSecond?: boolean, lowered?: boolean }} BrokerPolicy
 *   groups: limits shared by several classes (one bucket). known/defaulted/derivedPerSecond/lowered are added by
 *   policyFor() to the effective policy so callers can see where each number came from.
 *   pooling: whether the broker's terms allow one user's read-only market-data calls to be spread over several of
 *   that same user's accounts. Default "unknown", which the scheduler treats as "not-allowed".
 *
 * @typedef {"connected"|"expired"|"missing"|"error"|"checking"} SessionStateName
 * @typedef {{ state: SessionStateName, expiresAt: string | null, checkedAt: string | null, message: string | null }} SessionState
 * @typedef {{ id: string, broker: string, label: string, enabled: boolean, session: SessionState, liveAllowedByConfig: boolean,
 *   pooling: boolean, capabilities: string[], authKind: string | null }} AccountSummary   No secrets, ever.
 *
 * @typedef {"pending"|"open"|"trigger_pending"|"partially_filled"|"filled"|"cancelled"|"rejected"|"expired"|"outcome_unknown"} OrderStatus
 * @typedef {"CNC"|"INTRADAY"|"MARGIN"|"MTF"} Product
 * @typedef {"LIMIT"|"MARKET"|"SL"|"SL-M"} OrderType
 * @typedef {{ account: string, symbol: string, side: "BUY"|"SELL", quantity?: number, lots?: number, product: Product,
 *   orderType: OrderType, price?: number, triggerPrice?: number, validity?: "DAY"|"IOC", marketProtectionPct?: number,
 *   disclosedQuantity?: number, mode?: "paper"|"live", clientOrderId?: string, tag?: string, algoId?: string }} OrderRequest
 *   Exactly one of quantity (units) / lots. mode defaults to "paper"; "live" must be asked for explicitly.
 * @typedef {{ brokerOrderId: string | null, quantity: number, status: OrderStatus, error: { code: string, message: string } | null }} OrderLeg
 * @typedef {{ orderId: string, clientOrderId: string | null, accountId: string, broker: string, mode: "paper"|"live",
 *   symbol: string, side: "BUY"|"SELL", quantity: number, filledQuantity: number, avgPrice: number | null, price: number | null,
 *   triggerPrice: number | null, orderType: OrderType, product: Product, validity: "DAY"|"IOC", status: OrderStatus,
 *   brokerStatus: string | null, statusMessage: string | null, legs: OrderLeg[], source: string, tag: string | null,
 *   placedAt: string, updatedAt: string }} OrderResult   orderId is the Bridge id ("ord_..." live, "PAPER-..." paper).
 * @typedef {{ code: string, message: string, severity: "block"|"warn" }} Check
 * @typedef {{ ok: boolean, mode: "paper"|"live", checks: Check[], resolved: ResolvedInstrument | null, quantity: number | null,
 *   estimatedValue: number | null, ltp: number | null, confirmToken: string | null, confirmExpiresAt: string | null,
 *   requiresHumanConfirmation: boolean, ticketId: string | null }} PreviewResult
 * @typedef {{ ok: boolean, mode: "paper"|"live", reasons: Array<{ code: string, message: string }>, warnings: string[] }} Verdict
 * @typedef {{ accountId: string, mode: "paper"|"live", action: "place"|"modify"|"cancel", order: OrderRequest | null,
 *   orderId?: string, source: string, keyId: string | null, quantity: number | null, value: number | null, ltp: number | null }} SafetyIntent
 * @typedef {{ engaged: boolean, reason: string | null, by: string | null, at: string | null }} KillSwitchState
 * @typedef {{ type: string, actor: { kind: string, id: string }, source: string, accountId?: string | null, requestId?: string | null,
 *   data?: object }} AuditInput
 * @typedef {AuditInput & { seq: number, at: string, prevHash: string, hash: string }} AuditRecord
 * @typedef {{ items: any[], nextCursor: string | null }} Page
 * @typedef {{ symbol: string, ltp: number, bid: number|null, ask: number|null, bidQty: number|null, askQty: number|null,
 *   volume: number|null, oi: number|null, open: number|null, high: number|null, low: number|null, close: number|null,
 *   exchangeTs: number | null, receivedAt: number, accountId: string, broker: string }} Tick
 * @typedef {"ltp"|"quote"|"depth"} StreamMode
 */

/** Broker contract order status -> Bridge OrderStatus. */
export const CONTRACT_STATUS_MAP = Object.freeze({
  OPEN: "open",
  TRIGGER_PENDING: "trigger_pending",
  PARTIALLY_FILLED: "partially_filled",
  COMPLETE: "filled",
  CANCELLED: "cancelled",
  REJECTED: "rejected",
  EXPIRED: "expired",
  UNKNOWN: "pending",
});

export const ENDPOINT_CLASSES = Object.freeze(["order", "quote", "depth", "history", "chain", "portfolio", "master", "other"]);
export const PRIORITIES = Object.freeze(["order", "live", "interactive", "background"]);

// ───────────────────────────── Service contracts ─────────────────────────────

/**
 * deps key -> { iface, stream, requires, methods }. `requires` lists the deps keys the factory may use (besides the
 * core deps config, logger, bus, clock, paths). The method docs are the contract; see each stub file for detail.
 */
export const SERVICE_CONTRACTS = Object.freeze({
  /**
   * SecretStore — S2. AES-256-GCM encrypted JSON file (dataDir/secrets.enc). Key from MCB_MASTER_KEY (base64, 32 bytes)
   * or a key file created with 0600 permissions. Values are JSON objects; names are like "account:<id>".
   *  get(name) -> Promise<object | null>
   *  set(name, value: object) -> Promise<void>       atomic write (temp file + rename), registers values with logger.addSecret
   *  delete(name) -> Promise<boolean>
   *  list() -> Promise<string[]>                      names only
   *  status() -> { keySource: "env"|"file"|"none", path: string, entries: number }
   */
  secrets: { iface: "SecretStore", stream: "S2", requires: [], methods: ["get", "set", "delete", "list", "status"] },

  /**
   * KeyStore — S2. API keys "mcb_<keyId>_<secret>"; only a scrypt hash is stored (dataDir/keys.json).
   *  create({ label, scopes, accounts?: string[]|"*", expiresAt?, allowQuery?, clientKind? }) -> Promise<{ key: string, record: KeyRecord }>
   *      key is returned ONCE. allowQuery only with scopes ["read"]. "live" and "admin" keys need loopback creation (CLI or admin route).
   *  list() -> Promise<KeyRecord[]>
   *  get(keyId) -> Promise<KeyRecord | null>
   *  revoke(keyId) -> Promise<KeyRecord>
   *  authenticate(rawKey: string, { ip?: string }) -> Promise<KeyRecord | null>   constant-time; null for unknown/revoked/expired
   *  issueStreamToken(record: KeyRecord, { ttlMs?: number }) -> Promise<{ token: string, expiresAt: string }>   for WS/SSE URLs
   *  verifyStreamToken(token: string) -> Promise<KeyRecord | null>                single use
   *  create(input, { loopback?: boolean }) — the second argument (default true for the CLI) gates live/admin keys;
   *      the HTTP route passes ctx.loopback. revoke() emits "key.revoked".
   */
  keyStore: {
    iface: "KeyStore",
    stream: "S2",
    requires: [],
    methods: ["create", "list", "get", "revoke", "authenticate", "issueStreamToken", "verifyStreamToken"],
  },

  /**
   * AuditLog — S9. Append-only, hash-chained JSON lines (dataDir/audit/YYYY-MM-DD.jsonl, IST days). Never rewrites a line.
   *  append(input: AuditInput) -> Promise<AuditRecord>   redacts data; emits "audit.appended"
   *  query({ from?, to?, type?, accountId?, limit?, cursor? }) -> Promise<Page>
   *  verify({ day? }) -> Promise<{ ok: boolean, checked: number, brokenAt: number | null }>
   */
  audit: { iface: "AuditLog", stream: "S9", requires: [], methods: ["append", "query", "verify"] },

  /**
   * AccountManager — S1. The user's broker accounts from config.accounts, their sessions and adapters.
   *  list() -> AccountSummary[]
   *  get(accountId) -> AccountSummary                         throws ACCOUNT_NOT_FOUND
   *  adapter(accountId) -> object                             the broker adapter module (server/brokers/registry.mjs)
   *  creds(accountId) -> Promise<Record<string, string>>      decrypted saved fields + session fields; throws SESSION_EXPIRED
   *  status(accountId) -> SessionState
   *  connect(accountId, input: { values?: object, secrets?: object }) -> Promise<SessionState>
   *      saves non-secret values + session fields in SecretStore; secrets (password/PIN/TOTP) go to adapter.login() once
   *      and are never stored; emits "account.status"
   *  disconnect(accountId) -> Promise<SessionState>
   *  testConnection(accountId) -> Promise<{ ok: boolean, message: string }>
   *  capabilities(accountId) -> { capabilities: string[], policy: BrokerPolicy | null }
   *  marketDataCandidates({ capability: string, accountId?: string }) -> string[]
   *      accounts that may serve an UNPINNED market-data read: connected, capability declared, account.marketData.pooling
   *      true and broker policy pooling "allowed". When none qualifies, the single primary account: the first enabled,
   *      connected account in config order that declares the capability (so nothing is spread, but reads still work).
   *      With accountId: just that account (if it has the capability). Empty array = no account can serve it.
   */
  accounts: {
    iface: "AccountManager",
    stream: "S1",
    requires: ["secrets"],
    methods: ["list", "get", "adapter", "creds", "status", "connect", "disconnect", "testConnection", "capabilities", "marketDataCandidates"],
  },

  /**
   * Scheduler (rate-limit engine) — S3. Per-account, per-endpoint-class token buckets (second/minute/day windows),
   * priority queues (order > live > interactive > background, with ageing), singleflight coalescing, upstream
   * back-off, and account choice for pooled reads. Never exceeds a BrokerPolicy limit.
   *  schedule({ accountId, endpointClass, priority?, coalesceKey?, cost?, signal? }, fn: () => Promise<T>) -> Promise<T>
   *      waits for budget, then runs fn; callers with the same coalesceKey share one in-flight run
   *      a session error from fn emits "account.session_rejected"; a throttling error triggers back-off; errors are rethrown
   *  tryAcquire(accountId, endpointClass, cost?) -> { ok: boolean, retryAfterMs: number }
   *  headroom(accountId, endpointClass) -> { remaining: number, limit: number, resetMs: number }
   *  pickAccount({ candidates: string[], endpointClass }) -> string | null      most headroom, healthy, not backing off
   *  noteUpstreamThrottle(accountId, endpointClass, retryAfterMs?) -> void     emits "limits.throttled"
   *  policyFor(brokerId) -> BrokerPolicy                                        conservative defaults when unknown
   *  usage() -> { accounts: Array<{ accountId, broker, classes: Record<EndpointClass, { used, limit, queued, resetMs }> }> }
   *  checkClient(ctx) -> { ok: boolean, retryAfterMs: number, headers: Record<string, string> }   inbound per-key limit
   *  Additive extras (callers must tolerate their absence): schedule() opts.maxWaitMs, and fn receives
   *  { signal, accountId, endpointClass }; recordSaving(kind, n?) counts stream/cache/batch/coalesce savings
   *  (also exported from ratelimit/scheduler.mjs); usage() adds per-class window/backoffMs/callsToday/coalescedToday/
   *  throttledToday/refusedToday, per-account healthy/inFlight/queued, savings and generatedAt. Priority is normalised:
   *  endpointClass "order" always runs at "order"; a read asking for "order" is lowered to "live".
   */
  scheduler: {
    iface: "Scheduler",
    stream: "S3",
    requires: ["accounts"],
    methods: ["schedule", "tryAcquire", "headroom", "pickAccount", "noteUpstreamThrottle", "policyFor", "usage", "checkClient"],
  },

  /**
   * SymbolService — S4. Canonical symbols <-> broker instruments, built from each connected broker's instrument master
   * (cached per IST day in dataDir/instruments/). Pure parsing lives in core/symbolFormat.mjs; this adds data.
   *  parse(input: string) -> ParsedSymbol                     canonical or alias syntax; throws VALIDATION_FAILED
   *  format(parts) -> string                                  canonical string
   *  resolve(input: string, { broker?: string, exchange?: Exchange, from?: string }) -> Promise<ResolvedInstrument>   throws SYMBOL_NOT_FOUND
   *      ResolvedInstrument also carries freezeQtySource: "master"|"exchange-list"|null
   *  toBroker(symbol: string, brokerId: string) -> Promise<BrokerRef>
   *  fromBroker(brokerId: string, ref: { token: string, exchange: Exchange }) -> Promise<string | null>
   *  search({ q, exchange?, kind?, underlying?, expiry?, limit?, cursor? }) -> Promise<Page>   items: ResolvedInstrument (refs omitted)
   *  convert({ input, from?: "auto"|"canonical"|"chart"|"compact"|"broker", broker?, exchange? }) -> Promise<{ canonical: string, aliases: Record<string, string> }>
   *  refresh({ broker? }) -> Promise<{ brokers: string[], instruments: number, errors: Array<{ broker, code, message }> }>
   *  status() -> { brokers: Array<{ broker: string, instruments: number, loadedAt: string | null, source, day, fresh, lastError }>, conflicts, freezeList }
   *  Extras: warm() (start-up load), close().
   */
  symbols: {
    iface: "SymbolService",
    stream: "S4",
    requires: ["accounts", "scheduler"],
    methods: ["parse", "format", "resolve", "toBroker", "fromBroker", "search", "convert", "refresh", "status"],
  },

  /**
   * ReferenceData — S16 (docs/spec/p1-02-reference.md §2.2). Contract calendar, sessions, holidays, lots with effective
   * dates, freeze quantities, ban list, MWPL, F&O universe by date, corporate actions, delivery-margin schedule, rate and
   * charges, from the masters (via symbols), shipped files, config and (opt-in) NSE archive files. Never calls a broker.
   * Every dataset value carries source, asOf and quality; unavailable data answers available: false with a reason.
   *  session(exchange, tMs) -> { state: "CLOSED"|"PRE_OPEN"|"OPEN"|"SPECIAL"|"HOLIDAY", label, date, open, close, preOpen,
   *      holiday: { label, verified } | null, special | null, tradingDay, source }      (times "HH:MM" IST)
   *  calendar() -> { isTradingDay(date, exch), prevTradingDay(date, exch), nextTradingDay(date, exch),
   *      tradingDaysBetween(a, b, exch), holidays: [...] }
   *  rate(atDate?) -> { value, asOf, source, quality: "user"|"config"|"default"|"demo", stale }
   *  lotFor(underlying, expiry, { exchange }) -> Promise<{ lot, effectiveFrom, previousLot, source, asOf,
   *      conflict: null | { master, reference }, stale, staleTradingDays, staleAfterTradingDays, blockWhenStale }>
   *  freezeFor(canonical) -> Promise<{ freezeQty | null, source: "master"|"exchange-list"|"config"|null, verified }>
   *  banStatus(symbol, date?) -> { inBan, mwplPct, mwpl, oi, band: "ban"|"high"|"normal"|null, forDate, asOf, source }
   *  universe({ date, kind }) -> { date, coverage: "recorded"|"not-recorded", knownSince, items: [{ symbol, kind, exchange }] }
   *  corporateActions({ symbol, from, to }) -> CorporateAction[]
   *  events({ days = 7, underlying }) -> Promise<[{ kind: "lot-revision"|"corporate-action"|"holiday-expiry-shift",
   *      underlying, effectiveOn, daysAway, text, ref }]>
   *  charges() -> statutory table (the dashboard's CHARGE_RATES shape) + brokerage from config
   *  deliveryMargin(expiry, exch) -> { expiry, items: [{ day: "E-4", date, pct }], verified, source }
   *  status() -> per-dataset sync state
   *  bundle({ underlying, exchange, now }) -> Promise<everything one page needs>
   *  sync({ datasets, reason }) -> Promise<{ jobId, results }>   (CAPABILITY_UNSUPPORTED in demo mode)
   */
  reference: {
    iface: "ReferenceData",
    stream: "S16",
    requires: ["symbols"],
    methods: ["session", "calendar", "rate", "lotFor", "freezeFor", "banStatus", "universe", "corporateActions", "events", "charges", "deliveryMargin", "status", "bundle", "sync"],
  },

  /**
   * StreamHub — S6. One upstream feed per account (adapter.createFeed), reference-counted subscriptions across all
   * local clients, mode = max demand, broker subscription caps enforced (SUBSCRIPTION_LIMIT, never silent drops),
   * resubscribe after reconnect/re-login. Emits "tick" and "stream.status".
   *  subscribe(clientId: string, symbols: string[], mode: StreamMode) -> Promise<{ accepted: string[], rejected: Array<{ symbol, code, message }> }>
   *  unsubscribe(clientId: string, symbols: string[]) -> void
   *  dropClient(clientId: string) -> void
   *  lastTick(symbol: string) -> Tick | null                 latest tick from any upstream, for streaming-first reads
   *  isLive(symbol: string) -> boolean                        an upstream is connected and subscribed for this symbol
   *  stats() -> { clients: number, symbols: number, upstreams: Array<{ accountId, broker, connected, subscriptions, limit,
   *      state, detail, reason, modes, reconnects, ticks, lastTickAt }> }
   *  Extras used by the stream endpoints only: attachSink, clientSymbols, canonicalFor, upstreamStatuses, config, stop().
   */
  streamHub: {
    iface: "StreamHub",
    stream: "S6",
    requires: ["accounts", "symbols"],
    methods: ["subscribe", "unsubscribe", "dropClient", "lastTick", "isLive", "stats"],
  },

  /**
   * BackupDataService — S12. Free public market data (Yahoo Finance chart API, NSE India website JSON) for when no
   * broker account can answer. Off unless config.backup.enabled; always off in demo mode. Per-provider pacing and a
   * circuit breaker; every result names its provider and the provider's own timestamp.
   *  quotes(symbols: string[], { maxAgeMs? }) -> Promise<{ items: Array<{ symbol, fields, at, provider }>, errors }>   cash and index only
   *  history({ symbol, interval, fromMs, toMs }) -> Promise<{ symbol, interval, candles, partial, provider, at }>
   *  expiries(underlying) -> Promise<{ underlying, expiries: string[], provider, at }>   NSE derivatives
   *  optionChain(underlying, expiry) -> Promise<{ underlying, expiry, rows, underlyingLtp, provider, at }>   legs without greeks
   *  status() -> { enabled, autoFallback, providers: [...], order, cacheMs }
   *  Extra: autoFallback() -> boolean
   */
  backupData: { iface: "BackupDataService", stream: "S12", requires: [], methods: ["quotes", "history", "expiries", "optionChain", "status"] },

  /**
   * MarketDataService — S5. Streaming-first, then freshness cache, then a scheduled broker call (batched and coalesced),
   * routed to a pinned account or a pooled candidate. Every item carries Freshness.
   *  ltp(symbols: string[], opts?: ReadOptions) -> Promise<{ items: LtpItem[], errors: Array<{ symbol, code, message }> }>
   *  quotes(symbols: string[], opts?: ReadOptions) -> Promise<{ items: QuoteItem[], errors: Array<{ symbol, code, message }> }>
   *  depth(symbol: string, opts?: ReadOptions) -> Promise<DepthItem>
   *  history({ symbol, interval, from?, to?, countback? }, opts?: ReadOptions) -> Promise<HistoryResult>   auto-chunked
   *  expiries(underlying: string, opts?: ReadOptions & { exchange?: Exchange }) -> Promise<{ underlying: string, expiries: string[], freshness: Freshness }>
   *  optionChain({ underlying, expiry, strikes?, greeks? }, opts?: ReadOptions) -> Promise<OptionChain>
   */
  marketData: {
    iface: "MarketDataService",
    stream: "S5",
    requires: ["accounts", "scheduler", "symbols", "streamHub", "backupData", "reference"],
    methods: ["ltp", "quotes", "depth", "history", "expiries", "optionChain"],
  },

  /**
   * SafetyGuard — S9. Every order intent (paper and live) passes check() before anything is sent. Persists daily
   * counters and kill-switch state in dataDir/safety/. The kill switch can be engaged by any authenticated caller and
   * released only by an admin from loopback.
   *  check(ctx, intent: SafetyIntent) -> Promise<Verdict>        kill switch, live enablement (config + key scope + source),
   *      order rate cap (default 5/s, never above 10/s), daily order count and loss, max value/lots, price band,
   *      market-order policy, market hours
   *  acquireOrderSlot(accountId) -> { ok: boolean, retryAfterMs: number }   order-rate token (place, modify and cancel all count)
   *  recordOrderEvent(accountId, event: { action, mode, status, realisedPnl?: number }) -> void
   *  killSwitchStatus() -> KillSwitchState
   *  engageKillSwitch(ctx, { reason, cancelOpenOrders?: boolean }) -> Promise<KillSwitchState>   persists, audits, emits
   *      "safety.kill_switch" (OrderService subscribes and runs cancelAll when cancelOpenOrders is true; safety does not
   *      depend on orders, which would be a cycle)
   *  releaseKillSwitch(ctx, { confirm: "RELEASE" }) -> Promise<KillSwitchState>
   *  limits(accountId) -> { limits: object, usage: { ordersToday: number, realisedPnlToday: number, ordersLastSecond: number } }
   *      usage also has byMode and day; the top-level figures are the live ones. SafetyIntent should carry lotSize.
   */
  safety: {
    iface: "SafetyGuard",
    stream: "S9",
    requires: ["audit", "accounts", "reference"],
    methods: ["check", "acquireOrderSlot", "recordOrderEvent", "killSwitchStatus", "engageKillSwitch", "releaseKillSwitch", "limits"],
  },

  /**
   * PaperEngine — S8. Local simulator priced from MarketDataService (LTP/depth), per account, persisted in dataDir/paper/.
   * Order ids start with "PAPER-". Fill model documented in docs/ARCHITECTURE.md §7.
   *  place(accountId, order: OrderRequest & { quantity: number, resolved: ResolvedInstrument }) -> Promise<OrderResult>
   *  modify(accountId, orderId, changes: { price?, triggerPrice?, quantity?, orderType? }) -> Promise<OrderResult>
   *  cancel(accountId, orderId) -> Promise<OrderResult>
   *  order(accountId, orderId) -> Promise<OrderResult | null>
   *  orders(accountId, { status?, limit?, cursor? }) -> Promise<Page>
   *  trades(accountId, { limit?, cursor? }) -> Promise<Page>
   *  positions(accountId) -> Promise<object[]>
   *  funds(accountId) -> Promise<{ availableCash: number, usedMargin: number, totalBalance: number, realisedPnl: number, unrealisedPnl: number }>
   *  account(accountId) -> Promise<{ accountId, startingCapital, createdAt, resetAt, ordersToday }>
   *  reset(accountId, { startingCapital? }) -> Promise<void>
   */
  paper: {
    iface: "PaperEngine",
    stream: "S8",
    requires: ["marketData", "symbols", "reference"],
    methods: ["place", "modify", "cancel", "order", "orders", "trades", "positions", "funds", "account", "reset"],
  },

  /**
   * OrderService — S7. The only path to an order, paper or live. preview -> safety check -> idempotency -> route to
   * PaperEngine or (live) mint an order gate (server/brokers/orderGate.mjs issueOrderGate) and call the adapter through
   * scheduler.schedule({ endpointClass: "order", priority: "order" }). Timeouts become OUTCOME_UNKNOWN and are
   * reconciled from the broker order book, never retried blindly. Everything is audited.
   *  preview(ctx, req: OrderRequest) -> Promise<PreviewResult>
   *  place(ctx, req: OrderRequest, { idempotencyKey?: string, confirmToken?: string, ticketId?: string }) -> Promise<{ order: OrderResult, replayed: boolean }>
   *      ticketId: a ticket a person has confirmed, accepted only from the principal that prepared it (webhooks, which
   *      never see the confirmToken; they listen for "ticket.confirmed"). ctx.confirmationRequired marks such hooks.
   *  modify(ctx, orderId, changes, { idempotencyKey? }) -> Promise<{ order: OrderResult, replayed: boolean }>
   *  cancel(ctx, orderId, { idempotencyKey? }) -> Promise<{ order: OrderResult, replayed: boolean }>
   *  cancelAll(ctx, { accountId?, mode? }) -> Promise<{ cancelled: string[], failed: Array<{ orderId, code, message }> }>
   *  get(ctx, orderId) -> Promise<OrderResult>                     throws ORDER_NOT_FOUND
   *  getByClientId(ctx, clientOrderId) -> Promise<OrderResult>
   *  list(ctx, { accountId?, status?, mode?, limit?, cursor? }) -> Promise<Page>
   *  trades(ctx, { accountId?, limit?, cursor? }) -> Promise<Page>
   *  positions(ctx, accountId, { mode? }) -> Promise<{ items: object[], freshness: Freshness }>
   *  holdings(ctx, accountId) -> Promise<{ items: object[], freshness: Freshness }>
   *  funds(ctx, accountId, { mode? }) -> Promise<{ funds: object, freshness: Freshness }>
   *  tickets(ctx) -> Promise<object[]>                             pending human confirmations (OpenAPI Ticket)
   *  confirmTicket(ctx, ticketId) -> Promise<{ confirmToken: string, expiresAt: string }>   human confirmation (loopback admin)
   */
  /**
   * Readiness — S20 (docs/spec/p1-05-readiness.md §3.3). Whether each live-enabled account can trade right now (H5),
   * for people (badge, notify) and for automation (guards, alert actions, webhooks). Never sends or engages anything.
   *  status({ accountIds? }) -> ReadinessSnapshot                     cached; no I/O
   *  canTrade(accountId, { mode }) -> { ok, state, reasons, checkedAt, stale }   cached; mode "paper" is always ok
   *  ensureFresh(accountId, { maxAgeMs? = 60_000, timeoutMs? = 5_000 }) -> Promise<same as canTrade>
   *  check({ accountId?, reason }) -> Promise<ReadinessSnapshot>      runs evaluate (probe subject to cooldown)
   *  registerAutomation({ id, kind, accountId, mode, label, onState? }) -> { update(patch), remove() }
   *      kind: "webhook"|"guard"|"alert"|"sample"; onState(stateObj) is called on every state change of its account
   *  `reference` and `audit` are optional: a stub reference falls back to the weekday rule, a stub audit log is skipped.
   */
  readiness: {
    iface: "Readiness",
    stream: "S20",
    requires: ["accounts", "scheduler", "safety", "audit", "reference"],
    methods: ["status", "canTrade", "ensureFresh", "check", "registerAutomation"],
  },

  orders: {
    iface: "OrderService",
    stream: "S7",
    requires: ["accounts", "scheduler", "symbols", "safety", "audit", "paper", "marketData", "reference", "readiness"],
    methods: ["preview", "place", "modify", "cancel", "cancelAll", "get", "getByClientId", "list", "trades", "positions", "holdings", "funds", "tickets", "confirmTicket"],
  },
});

/** Core deps every factory receives in addition to its `requires`. */
export const CORE_DEPS = Object.freeze(["config", "logger", "bus", "clock", "paths", "brokers"]);

export const STUB = Symbol.for("mcb.service.stub");

/**
 * A stub that satisfies a contract and throws NotImplementedError from every method.
 * @param {keyof typeof SERVICE_CONTRACTS} name
 */
export function notImplementedService(name) {
  const spec = SERVICE_CONTRACTS[name];
  if (!spec) throw new Error(`Unknown service ${name}`);
  const svc = {};
  for (const m of spec.methods) {
    svc[m] = () => {
      throw new NotImplementedError(`${spec.iface}.${m}() (stream ${spec.stream})`);
    };
  }
  Object.defineProperty(svc, STUB, { value: true });
  return Object.freeze(svc);
}

export function isStub(svc) {
  return Boolean(svc && svc[STUB]);
}

/**
 * Check that `impl` exposes every method of the named contract. Extra methods are allowed (internal helpers), but
 * other streams must only call contract methods.
 * @returns {void} throws Error listing what is missing
 */
export function assertService(name, impl) {
  const spec = SERVICE_CONTRACTS[name];
  if (!spec) throw new Error(`Unknown service ${name}`);
  if (!impl || typeof impl !== "object") throw new Error(`${spec.iface}: factory must return an object`);
  const missing = spec.methods.filter((m) => typeof impl[m] !== "function");
  if (missing.length) throw new Error(`${spec.iface} (${name}) is missing: ${missing.join(", ")}`);
}
