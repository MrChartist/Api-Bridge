/**
 * Service contracts: the interfaces the modules build against.
 *
 * Each shared service lives in `deps` under a fixed key (SERVICE_CONTRACTS below), is owned by exactly one module group,
 * and must expose exactly the listed methods. app.mjs checks every service with assertService() at boot, so a
 * module can change HOW a method works but not WHICH methods exist; changing this file is a core change made by
 * the maintainers. Until a module lands, its service is a stub from notImplementedService(): it boots, and every call
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
 * @typedef {"realtime"|"delayed"|"eod"} DataClass
 * @typedef {{ source: "stream"|"cache"|"broker"|"paper"|"backup", asOf: string, ageMs: number, stale: boolean,
 *   accountId: string | null, broker: string | null, provider?: string, class: DataClass, delaySec: number | null,
 *   official: boolean, confidence: "high"|"medium"|"low", flags: string[] }} Freshness
 *   Attached to every market-data item. `asOf` is ISO-8601 with offset (+05:30). `stale` = older than the freshness
 *   target the caller asked for (maxAgeMs) or than the endpoint default; it is a different label from `class`.
 *   source "backup" = a data source other than the user's broker accounts (BackupDataService, named in `provider`):
 *   used only when the read allows backup (or sources.autoFallback is on) and the data class fits the read's purpose;
 *   accountId/broker are null. `class`: realtime (broker, stream, cache), delayed (slow by nature, `delaySec` says by
 *   how much) or eod; a composite answer (a chain, a many-symbol quote) takes the least current class of its parts.
 *   `official` = a documented API from the data's owner. `confidence` and `flags` (for example "unofficial", "plugin",
 *   "stale") say how far to trust it.
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
 * @typedef {"display"|"analysis"|"alert"|"paper"|"risk"|"order"} Purpose   What a read is for. The last four accept only
 *   trusted real-time data: never a delayed or end-of-day source, never a stale cached value.
 * @typedef {{ accountId?: string, maxAgeMs?: number, priority?: Priority, signal?: AbortSignal, allowBackup?: boolean,
 *   purpose?: Purpose, allowedAccounts?: string[] }} ReadOptions
 *   accountId pins the read to one account (no pooling, never a data source). maxAgeMs: freshest acceptable data
 *   (0 = must hit stream/broker); a source whose delay exceeds it cannot answer. allowBackup: an unpinned read may
 *   be served by an enabled data source when no broker account can answer (or a source ranks first); the source
 *   router decides which. Default false, so orders, paper fills and safety checks never see backup prices; routes for
 *   people and tools opt in (?backup=true, or sources.autoFallback). purpose defaults to "display". allowedAccounts:
 *   the accounts the caller's key may use for an unpinned read.
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
 *   liveSources?: string[], pooling: boolean, capabilities: string[], authKind: string | null }} AccountSummary   No secrets, ever.
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
 * @typedef {{ ok: boolean, mode: "paper"|"live", reasons: Array<{ code: string, message: string }>, warnings: string[],
 *   checks?: Array<{ code: string, message: string }> }} Verdict   checks: warnings that carry their own code (the F&O ban rule)
 * @typedef {{ accountId: string, mode: "paper"|"live", action: "place"|"modify"|"cancel", order: OrderRequest | null,
 *   orderId?: string, source: string, keyId: string | null, quantity: number | null, value: number | null, ltp: number | null,
 *   underlyingKind?: "stock"|"index"|null, underlying?: string, heldQty?: number | null, banQuantity?: number,
 *   ban?: { inBan: boolean, mwplPct?: number|null, forDate?: string|null } | null }} SafetyIntent
 *   underlyingKind/underlying/ban/heldQty: set for NFO/BFO derivatives; heldQty (signed units held in that
 *   contract, null when unreadable) only when the stock is in the F&O ban period. banQuantity (modify only): the
 *   order's unfilled remainder, the quantity the ban rule weighs against heldQty.
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
 * deps key -> { iface, requires, methods }. `requires` lists the deps keys the factory may use (besides the
 * core deps config, logger, bus, clock, paths). The method docs are the contract; see each stub file for detail.
 */
export const SERVICE_CONTRACTS = Object.freeze({
  /**
   * SecretStore. AES-256-GCM encrypted JSON file (dataDir/secrets.enc). Key from MCB_MASTER_KEY (base64, 32 bytes)
   * or a key file created with 0600 permissions. Values are JSON objects; names are like "account:<id>".
   *  get(name) -> Promise<object | null>
   *  set(name, value: object) -> Promise<void>       atomic write (temp file + rename), registers values with logger.addSecret
   *  delete(name) -> Promise<boolean>
   *  list() -> Promise<string[]>                      names only
   *  status() -> { keySource: "env"|"file"|"none", path: string, entries: number }
   */
  secrets: { iface: "SecretStore", requires: [], methods: ["get", "set", "delete", "list", "status"] },

  /**
   * KeyStore. API keys "mcb_<keyId>_<secret>"; only a scrypt hash is stored (dataDir/keys.json).
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
    requires: [],
    methods: ["create", "list", "get", "revoke", "authenticate", "issueStreamToken", "verifyStreamToken"],
  },

  /**
   * AuditLog. Append-only, hash-chained JSON lines (dataDir/audit/YYYY-MM-DD.jsonl, IST days). Never rewrites a line.
   *  append(input: AuditInput) -> Promise<AuditRecord>   redacts data; emits "audit.appended"
   *  query({ from?, to?, type?, accountId?, limit?, cursor? }) -> Promise<Page>
   *  verify({ day? }) -> Promise<{ ok: boolean, checked: number, brokenAt: number | null }>
   */
  audit: { iface: "AuditLog", requires: [], methods: ["append", "query", "verify"] },

  /**
   * AccountManager. The user's broker accounts from config.accounts, their sessions and adapters.
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
   *  marketDataCandidates({ capability: string, accountId?: string, allowedAccounts?: string[] }) -> string[]
   *      accounts that may serve an UNPINNED market-data read: connected, capability declared, account.marketData.pooling
   *      true, a holder named, broker policy pooling "allowed" (or "unknown" with poolingWhenTermsUnknown; never
   *      "not-allowed"), and the owner's versioned pooling consent covering the account (sources/pooling.mjs). When none
   *      qualifies, the single primary account: the first enabled, connected account in config order that declares the
   *      capability (so nothing is spread, but reads still work). allowedAccounts limits the answer to the calling key's accounts.
   *      With accountId: just that account (if it has the capability). Empty array = no account can serve it.
   */
  accounts: {
    iface: "AccountManager",
    requires: ["secrets"],
    methods: ["list", "get", "adapter", "creds", "status", "connect", "disconnect", "testConnection", "capabilities", "marketDataCandidates"],
  },

  /**
   * Scheduler (rate-limit engine). Per-account, per-endpoint-class token buckets (second/minute/day windows),
   * priority queues (order > live > interactive > background, with ageing) that share each lane fairly between
   * consumers (API keys, background jobs) by weight, singleflight coalescing, upstream back-off per budget pool with an
   * adaptive scale below the policy ceiling (halved by a throttle, restored slowly), per-key client quotas (rate, burst,
   * daily cap, weight, concurrency; runtime overrides in quotaStore.mjs), and account choice for pooled reads. Never
   * exceeds a BrokerPolicy limit. A refusal is a BridgeError with `scope` ("client" | "consumer-cap" | "queue" |
   * "upstream"), `retryAfterMs` and `limit: { name, remaining, resetMs }`.
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
    requires: ["accounts"],
    methods: ["schedule", "tryAcquire", "headroom", "pickAccount", "noteUpstreamThrottle", "policyFor", "usage", "checkClient"],
  },

  /**
   * SymbolService. Canonical symbols <-> broker instruments, built from each connected broker's instrument master
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
    requires: ["accounts", "scheduler"],
    methods: ["parse", "format", "resolve", "toBroker", "fromBroker", "search", "convert", "refresh", "status"],
  },

  /**
   * ReferenceData. Contract calendar, sessions, holidays, lots with effective
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
   *  archives() -> { enabled: boolean, setBy: "config"|"user"|"demo"|null, client: NseArchiveClient | null }
   *      (the NSE archive switch and the shared, rate-limited archive client; client is null while the switch is off.
   *      Any module that fetches NSE archive files goes through this client only.)
   */
  reference: {
    iface: "ReferenceData",
    requires: ["symbols"],
    methods: ["session", "calendar", "rate", "lotFor", "freezeFor", "banStatus", "universe", "corporateActions", "events", "charges", "deliveryMargin", "status", "bundle", "sync", "archives"],
  },

  /**
   * StreamHub. One upstream feed per account (adapter.createFeed), reference-counted subscriptions across all
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
    requires: ["accounts", "symbols"],
    methods: ["subscribe", "unsubscribe", "dropClient", "lastTick", "isLive", "stats"],
  },

  /**
   * BackupDataService, provided by the sources module (server/bridge/sources/). Market data from sources other than the
   * user's own broker accounts: the enabled, configured, non-broker sources in the source registry (built-in free
   * providers, demo sources and plugins the owner granted). The market service asks the source router which source to
   * use and passes its choice as `sourceId`; the facade then asks that source only (it must still be enabled, able to
   * do the thing, fit the `purpose` and the delay fit `maxAgeMs`). Every answer names its source in `provider` and
   * carries `class` (realtime|delayed|eod), `delaySec` and `official`, so callers label it honestly. Orders, risk
   * checks, paper fills and alerts never get anything but a realtime source. The same service also has the management
   * API (list, describe, setEnabled, setConfig, test, consentFor) used by the /v1/sources routes, and attachHealth(tracker)
   * so `list()` shows the health of real calls (a plugin's own health() is merged in). Keys live in the secrets store
   * under `source:<id>` and are never returned or logged.
   *  quotes(symbols: string[], { maxAgeMs?, purpose?, sourceId?, signal? }) -> Promise<{ items: Array<{ symbol, fields, at, provider, class, delaySec, official }>, errors: Array<{ symbol, code, message }> }>   cash and index only
   *  history({ symbol, interval, fromMs, toMs, sourceId? }, { purpose?, sourceId?, signal? }) -> Promise<{ symbol, interval, candles, partial, provider, at, class, delaySec, official }>
   *  expiries(underlying, { purpose?, sourceId?, signal? }) -> Promise<{ underlying, expiries: string[], provider, at, class, delaySec, official }>
   *  optionChain(underlying, expiry, { purpose?, sourceId?, signal? }) -> Promise<{ underlying, expiry, rows, underlyingLtp, provider, at, class, delaySec, official }>   legs without greeks
   *  status() -> { enabled, autoFallback, providers: [...], order, cacheMs }
   *  autoFallback() -> boolean
   */
  backupData: { iface: "BackupDataService", requires: ["secrets"], methods: ["quotes", "history", "expiries", "optionChain", "status", "autoFallback"] },

  /**
   * MarketDataService. Streaming-first, then freshness cache, then a scheduled broker call (batched per consumer and
   * coalesced), routed to a pinned account or, for an unpinned read, to the candidates the source router picks: the
   * caller's broker accounts (pooling only with the owner's consent) and, when the read allows backup, enabled data
   * sources. At most two are tried. Every item carries Freshness (source, class, delay, official, confidence, flags).
   * Non-contract: sourceRouter, sourceHealth and failureCache, shared with GET /v1/sources/trace.
   *  ltp(symbols: string[], opts?: ReadOptions) -> Promise<{ items: LtpItem[], errors: Array<{ symbol, code, message }> }>
   *  quotes(symbols: string[], opts?: ReadOptions) -> Promise<{ items: QuoteItem[], errors: Array<{ symbol, code, message }> }>
   *  depth(symbol: string, opts?: ReadOptions) -> Promise<DepthItem>
   *  history({ symbol, interval, from?, to?, countback? }, opts?: ReadOptions) -> Promise<HistoryResult>   auto-chunked
   *  expiries(underlying: string, opts?: ReadOptions & { exchange?: Exchange }) -> Promise<{ underlying: string, expiries: string[], freshness: Freshness }>
   *  optionChain({ underlying, expiry, strikes?, greeks? }, opts?: ReadOptions) -> Promise<OptionChain>
   */
  marketData: {
    iface: "MarketDataService",
    requires: ["accounts", "scheduler", "symbols", "streamHub", "backupData", "reference"],
    methods: ["ltp", "quotes", "depth", "history", "expiries", "optionChain"],
  },

  /**
   * SafetyGuard. Every order intent (paper and live) passes check() before anything is sent. Persists daily
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
    requires: ["audit", "accounts", "reference"],
    methods: ["check", "acquireOrderSlot", "recordOrderEvent", "killSwitchStatus", "engageKillSwitch", "releaseKillSwitch", "limits"],
  },

  /**
   * PaperEngine. Local simulator priced from MarketDataService (LTP/depth), per account, persisted in dataDir/paper/.
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
    requires: ["marketData", "symbols", "reference"],
    methods: ["place", "modify", "cancel", "order", "orders", "trades", "positions", "funds", "account", "reset"],
  },

  /**
   * OrderService. The only path to an order, paper or live. preview -> safety check -> idempotency -> route to
   * PaperEngine or (live) mint an order gate (server/brokers/orderGate.mjs issueOrderGate) and call the adapter through
   * scheduler.schedule({ endpointClass: "order", priority: "order" }). Timeouts become OUTCOME_UNKNOWN and are
   * reconciled from the broker order book, never retried blindly. Everything is audited.
   *  preview(ctx, req: OrderRequest) -> Promise<PreviewResult>
   *  place(ctx, req: OrderRequest, { idempotencyKey?: string, confirmToken?: string, ticketId?: string }) -> Promise<{ order: OrderResult, replayed: boolean }>
   *      ticketId: a ticket a person has confirmed, accepted only from the principal that prepared it (webhooks, which
   *      never see the confirmToken; they listen for "ticket.confirmed"). ctx.confirmationRequired marks such hooks.
   *  modify(ctx, orderId, changes, { idempotencyKey? }) -> Promise<{ order: OrderResult, replayed: boolean }>
   *  cancel(ctx, orderId, { idempotencyKey? }) -> Promise<{ order: OrderResult, replayed: boolean }>
   *  cancelAll(ctx, { accountId?, mode?, bridgeOnly?, dryRun? }) -> Promise<{ cancelled: string[], failed: Array<{ orderId, code, message }>,
   *      bridge: { cancelled: string[], open? }, external: { cancelled: string[], left: string[], open? }, dryRun? }>
   *      (bridge: orders the Bridge placed; external: live orders placed outside it, left open when bridgeOnly)
   *  get(ctx, orderId) -> Promise<OrderResult>                     throws ORDER_NOT_FOUND
   *  getByClientId(ctx, clientOrderId) -> Promise<OrderResult>
   *  list(ctx, { accountId?, status?, mode?, limit?, cursor? }) -> Promise<Page>
   *  trades(ctx, { accountId?, limit?, cursor? }) -> Promise<Page>
   *  positions(ctx, accountId, { mode? }) -> Promise<{ items: object[], freshness: Freshness }>
   *  holdings(ctx, accountId) -> Promise<{ items: object[], freshness: Freshness }>
   *  funds(ctx, accountId, { mode? }) -> Promise<{ funds: object, freshness: Freshness }>
   *  tickets(ctx, { state? }) -> Promise<object[]>                 pending human confirmations (OpenAPI Ticket); state "rejected": recently declined
   *  confirmTicket(ctx, ticketId) -> Promise<{ confirmToken: string, expiresAt: string }>   human confirmation (loopback admin)
   *  rejectTicket(ctx, ticketId, { reason? }) -> Promise<object>   human decline of an open ticket (loopback admin); 409 otherwise
   *  ticketStatus(ctx, ticketId) -> Promise<{ ticketId, status, reason, expiresAt }>   open|confirmed|consumed|rejected|expired|unknown
   */
  /**
   * Readiness. Whether each live-enabled account can trade right now,
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
    requires: ["accounts", "scheduler", "safety", "audit", "reference"],
    methods: ["status", "canTrade", "ensureFresh", "check", "registerAutomation"],
  },

  orders: {
    iface: "OrderService",
    requires: ["accounts", "scheduler", "symbols", "safety", "audit", "paper", "marketData", "reference", "readiness"],
    methods: ["preview", "place", "modify", "cancel", "cancelAll", "get", "getByClientId", "list", "trades", "positions", "holdings", "funds", "tickets", "confirmTicket", "rejectTicket", "ticketStatus"],
  },

  /**
   * NotifyService. Bridge events to Telegram (a durable outbox, retries, pacing, digests, quiet hours) and a few
   * read-only commands back. Nothing depends on it: it listens to the event bus. Tokens and chat ids live in the secret
   * store and never leave it (responses carry masked hints and a short chat key).
   *  status() -> Promise<{ enabled, targets, queue: { depth, held, dropped, oldestAt }, lastDeliveryAt, counters, quietHours, reminders }>
   *  listTargets() -> Promise<Target[]>                       masked
   *  events() -> { events: Array<{ key, label, help, enabled, default, critical }>, quietHours, morning }
   *  publish({ key, text, group?, dedupe? }, { critical?, bypassQuiet?, noCoalesce? }) -> Promise<{ queued: number, reason?: string }>
   *      queue a ready-made message through the same switches (a module that wants to say something)
   *  testTarget(targetId, { chatKey? }) -> Promise<{ ok, delivered, results, message }>
   *  Extras: addTarget, removeTarget, findChats, addChat, removeChat, setChatCommands, setEvents, pump, start, stop.
   */
  notify: {
    iface: "NotifyService",
    requires: ["secrets", "audit", "accounts", "safety", "marketData", "orders", "readiness", "backupData"],
    methods: ["status", "listTargets", "events", "publish", "testTarget"],
  },

  /**
   * LibraryService. Named, tagged collections of instruments: static lists, and option universes that are worked out when
   * they are used (rolling expiries, the at-the-money strike from the live price). Downloads, recordings, the Excel and
   * Sheets routes and the Python library call resolve() when they run. Stored in dataDir/collections.json.
   *  list({ tag?, kind?, q? }) -> Collection[]                       summaries, no symbol lists
   *  get(nameOrId) -> Collection                                     throws NOT_FOUND; an earlier name of a renamed collection still finds it
   *  resolve(nameOrId, { spot?, allowStale?, requireLive?, priority?, signal?, accountId?, allowedAccounts? }) -> Promise<{ id, name, kind,
   *      resolvedAt, rule, symbols: string[], count, atmSource, underlying, expiries, strikeSource, warnings: string[] }>
   *      atmSource: "not-needed" | "live" | "last-close" | "supplied" | "stale" | "delayed" | "eod"; a stale, delayed or end-of-day
   *      price is refused (an error) unless allowStale is true, and then it is labelled. requireLive refuses anything but live.
   *  estimate(nameOrId, intervals: string[] | string, days: number) -> Promise<{ symbols, rows, bytes, brokerCalls, ... }>
   *  Extras: create, update, remove, duplicate, exportData, importData, usage, registerUsageProvider(kind, fn), status.
   *  Emits the bus topic "collection.changed".
   */
  library: {
    iface: "LibraryService",
    requires: ["symbols", "marketData"],
    methods: ["list", "get", "resolve", "estimate"],
  },

  /**
   * DownloadService (module downloads). History downloads that run in the background and save files under
   * dataDir/downloads/, and datasets that grow by incremental updates. Every broker call goes through
   * deps.marketData.history() at priority "background", paced to downloads.maxBudgetShare of the account's budget; a
   * job is saved after every window and continues after a pause, a restart, a kill switch or a lost session.
   *  estimate(request, { allowedAccounts? }) -> Promise<{ brokerCalls, callsSaved, rows, bytes, etaSec, ... }>   starts nothing
   *  create(request, { allowedAccounts? }) -> Promise<{ job: Job, existing: boolean }>
   *  get(id) -> Job                                      throws NOT_FOUND
   *  list({ status?, tag?, items? }) -> Job[]            newest first
   *  pause(id) | resume(id) | cancel(id) -> Promise<Job>
   *  remove(id) -> Promise<void>                          deletes the job's files (never a dataset's)
   *  updateDataset(name, { allowedAccounts? }) -> Promise<{ job: Job, existing: boolean }>   continues from the last stored bar
   *  Extras: files, fileOf, patchJob, listDatasets, getDataset, patchDataset, removeDataset, attachLibrary, start, stop.
   */
  downloads: {
    iface: "DownloadService",
    requires: ["accounts", "scheduler", "marketData", "safety"],
    methods: ["estimate", "create", "get", "list", "pause", "resume", "cancel", "remove", "updateDataset"],
  },
});

/** Core deps every factory receives in addition to its `requires`. */
/**
 * API Bridge v2 has no provider for these contract services. Kept code may still list them in `requires` and reads
 * them as an optional extra (the order, paper, safety and readiness services all work without them); they resolve to
 * stubs. Health, doctor and the module tests skip them.
 */
export const SERVICES_NOT_IN_V2 = Object.freeze(["reference"]);

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
      throw new NotImplementedError(`${spec.iface}.${m}()`);
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
 * other modules must only call contract methods.
 * @returns {void} throws Error listing what is missing
 */
export function assertService(name, impl) {
  const spec = SERVICE_CONTRACTS[name];
  if (!spec) throw new Error(`Unknown service ${name}`);
  if (!impl || typeof impl !== "object") throw new Error(`${spec.iface}: factory must return an object`);
  const missing = spec.methods.filter((m) => typeof impl[m] !== "function");
  if (missing.length) throw new Error(`${spec.iface} (${name}) is missing: ${missing.join(", ")}`);
}
