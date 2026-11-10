// Type definitions for @mrchartist/bridge-client, written against docs/openapi.yaml (Mr. Chartist API Bridge v1).

export type Exchange = "NSE" | "BSE" | "NFO" | "BFO" | "MCX" | "CDS";
export type InstrumentKind = "INDEX" | "EQ" | "FUT" | "OPT";
export type Interval = "1m" | "3m" | "5m" | "10m" | "15m" | "30m" | "60m" | "1d" | "1w" | "1M";
export type StreamMode = "ltp" | "quote" | "depth";
export type Mode = "paper" | "live";
export type Product = "CNC" | "INTRADAY" | "MARGIN" | "MTF";
export type OrderType = "LIMIT" | "MARKET" | "SL" | "SL-M";
export type OrderStatus = "pending" | "open" | "trigger_pending" | "partially_filled" | "filled" | "cancelled" | "rejected" | "expired" | "outcome_unknown";

export type DataClass = "realtime" | "delayed" | "eod";
export interface Freshness {
  /** "local" and "backup" appear on history read from the Bridge's own disk or from a free source. */
  source: "stream" | "cache" | "broker" | "paper" | "local" | "backup" | (string & {});
  asOf: string;
  ageMs: number;
  stale: boolean;
  accountId?: string | null;
  broker?: string | null;
  /** Absent on older Bridges: treat as "realtime" only for stream, cache, broker and paper. */
  class?: DataClass;
  delaySec?: number;
  official?: boolean;
  provider?: string | null;
  confidence?: "high" | "medium" | "low";
  flags?: string[];
}
export interface Meta {
  requestId: string;
  nextCursor?: string | null;
  accountId?: string | null;
  mode?: Mode;
  freshness?: Freshness;
}
export interface ItemError {
  symbol?: string;
  orderId?: string;
  input?: string;
  code: string;
  message: string;
}
export interface Envelope<T> {
  data: T;
  meta: Meta;
  errors?: ItemError[];
}
export interface WriteResult<T> extends Envelope<T> {
  /** true when the Bridge returned the stored result of an earlier request with the same Idempotency-Key. */
  replayed: boolean;
  /** The Idempotency-Key that was sent (generated unless you passed one). Reuse it to retry safely. */
  idempotencyKey: string;
}
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code: string;
  retryable: boolean;
  requestId?: string;
  retryAfterMs?: number;
  broker?: { id?: string; code?: string; message?: string };
  errors?: Array<{ path: string; message: string }>;
}

export interface Instrument {
  symbol?: string;
  canonical?: string;
  exchange: Exchange;
  kind: InstrumentKind;
  underlying: string;
  name?: string | null;
  expiry?: string | null;
  strike?: number | null;
  right?: "CE" | "PE" | null;
  lotSize: number;
  tickSize: number;
  freezeQty?: number | null;
  isin?: string | null;
  refs?: Record<string, { token: string; exchange: string; tradingSymbol: string | null }>;
}
export interface ConvertResult {
  input: string;
  canonical: string;
  aliases: Record<string, string | null>;
}
export interface LtpItem {
  symbol: string;
  ltp: number;
  freshness: Freshness;
}
export interface QuoteItem extends LtpItem {
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  change: number | null;
  changePct: number | null;
  volume: number | null;
  oi: number | null;
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
}
export interface DepthLevel {
  price: number;
  qty: number;
  orders: number | null;
}
export interface DepthItem {
  symbol: string;
  bids: DepthLevel[];
  asks: DepthLevel[];
  freshness: Freshness;
}
export interface Candle {
  /** Bar open, epoch seconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi?: number;
}
export interface HistoryResult {
  symbol: string;
  interval: Interval;
  candles: Candle[];
  freshness: Freshness;
  partial: boolean;
}
export interface ChainLeg {
  symbol: string;
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  oi: number | null;
  oiChange: number | null;
  volume: number | null;
  /** Percent. */
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  greeksSource: "broker" | "computed" | null;
}
export interface OptionChain {
  underlying: string;
  expiry: string;
  underlyingLtp: number | null;
  atmStrike: number | null;
  lotSize: number | null;
  rows: Array<{ strike: number; ce: ChainLeg | null; pe: ChainLeg | null }>;
  freshness: Freshness;
}

export interface Position {
  symbol: string;
  product: Product | "CO" | "BO";
  netQty: number;
  avgPrice: number;
  ltp?: number | null;
  pnl: number;
  realisedPnl?: number | null;
  unrealisedPnl?: number | null;
}
export interface Holding {
  symbol: string;
  isin?: string | null;
  qty: number;
  avgPrice: number;
  ltp?: number | null;
  pnl?: number | null;
}
export interface Funds {
  availableCash: number;
  usedMargin: number;
  totalBalance?: number | null;
  collateral?: number | null;
  withdrawable?: number | null;
  realisedPnl?: number | null;
  unrealisedPnl?: number | null;
}

export interface OrderRequestBase {
  account: string;
  symbol: string;
  side: "BUY" | "SELL";
  /** No default. */
  product: Product;
  /** No default. */
  orderType: OrderType;
  price?: number;
  triggerPrice?: number;
  validity?: "DAY" | "IOC";
  marketProtectionPct?: number;
  disclosedQuantity?: number;
  /** Paper unless you say "live" (which also needs a live key and a live-enabled account). */
  mode?: Mode;
  clientOrderId?: string;
  tag?: string;
  algoId?: string;
  confirmToken?: string;
}
/** Exactly one of quantity (units) or lots. */
export type OrderRequest = (OrderRequestBase & { quantity: number; lots?: never }) | (OrderRequestBase & { lots: number; quantity?: never });
export interface OrderChanges {
  quantity?: number;
  price?: number;
  triggerPrice?: number;
  orderType?: OrderType;
  validity?: "DAY" | "IOC";
}
export interface OrderLeg {
  brokerOrderId?: string | null;
  quantity: number;
  status: OrderStatus;
  error?: { code: string; message: string } | null;
}
export interface OrderResult {
  orderId: string;
  clientOrderId?: string | null;
  accountId: string;
  broker: string;
  mode: Mode;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  filledQuantity: number;
  avgPrice?: number | null;
  price?: number | null;
  triggerPrice?: number | null;
  orderType: OrderType;
  product: Product;
  validity?: "DAY" | "IOC";
  status: OrderStatus;
  brokerStatus?: string | null;
  statusMessage?: string | null;
  legs: OrderLeg[];
  source?: "rest" | "webhook" | "mcp" | "cli";
  tag?: string | null;
  placedAt: string;
  updatedAt: string;
}
export interface PreviewResult {
  ok: boolean;
  mode: Mode;
  checks: Array<{ code: string; message: string; severity: "block" | "warn" }>;
  resolved?: Instrument | null;
  quantity?: number | null;
  estimatedValue?: number | null;
  ltp?: number | null;
  confirmToken?: string | null;
  confirmExpiresAt?: string | null;
  requiresHumanConfirmation: boolean;
  ticketId?: string | null;
}
export interface KillSwitchState {
  engaged: boolean;
  reason?: string | null;
  by?: string | null;
  at?: string | null;
}

export interface ClientOptions {
  /** Default $MCB_BRIDGE_URL or http://127.0.0.1:4300. */
  baseUrl?: string;
  /** Default $MCB_API_KEY. Never logged or enumerable on the client. */
  apiKey?: string;
  timeoutMs?: number;
  /** Retries for retryable errors and for network failures of reads (default 2). Writes without a reply are never retried. */
  maxRetries?: number;
  retryBaseMs?: number;
  fetch?: typeof fetch;
  WebSocket?: unknown;
  userAgent?: string;
  /** Waits between retries and polls (tests pass a fake). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Clock in epoch milliseconds, used by `downloads.wait` timeouts (default Date.now). */
  now?: () => number;
}
export interface ReadOpts {
  account?: string;
  maxAgeMs?: number;
}
export interface WriteOpts {
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export declare const DEFAULT_BASE_URL: string;
export declare function newIdempotencyKey(): string;
export declare function toQuery(params: Record<string, unknown>): string;

export declare class BridgeError extends Error {}
export declare class BridgeApiError extends BridgeError {
  status: number;
  code: string;
  title?: string;
  detail?: string;
  retryable: boolean;
  requestId?: string;
  retryAfterMs?: number;
  broker?: { id?: string; code?: string; message?: string };
  errors?: Array<{ path: string; message: string }>;
  idempotencyKey?: string;
  problem: Problem;
}
export declare class BridgeConnectionError extends BridgeError {
  method: string;
  path: string;
  /** true for writes: the Bridge may have acted on the request. */
  outcomeUnknown: boolean;
  timedOut: boolean;
  idempotencyKey?: string;
}

export declare class DownloadFailedError extends BridgeError {
  /** The job's final state; `job.reason` says why it stopped. */
  job: DownloadJob;
}
export declare class WaitTimeoutError extends BridgeError {
  /** The last known state: the thing waited for keeps going in the Bridge. */
  last: unknown;
}
export declare class ChecksumMismatchError extends BridgeError {
  expected: string;
  actual: string;
}
export declare class SignatureInvalidError extends BridgeError {
  reason: SignatureFailure;
}

// ── Data you keep: downloads, datasets, recordings, collections, subscriptions, events ──

export type JobStatus = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";
export type DownloadFormat = "csv" | "jsonl" | "amibroker";
export interface DataFile {
  name: string;
  symbol?: string;
  interval?: string;
  rows?: number;
  bytes?: number;
  firstBar?: string;
  lastBar?: string;
  sha256?: string;
  /** Recording day files. */
  day?: string;
}
export interface DownloadRequest {
  /** Canonical symbols, up to 500. Give this or `collection`. */
  symbols?: string | string[];
  collection?: string;
  intervals: string | string[];
  /** Required unless `dataset` continues an existing dataset. */
  from?: string | Date;
  to?: string | Date;
  name?: string;
  format?: DownloadFormat;
  layout?: "per-symbol" | "combined";
  dataset?: string;
  account?: string;
  /** Let a free source serve it (labelled delayed or end-of-day). */
  backup?: boolean;
  tags?: string[];
}
export interface DownloadJob {
  id: string;
  name: string;
  status: JobStatus;
  progress: { total: number; done: number; failed: number; rows: number; bytes: number; etaSec: number | null; current: { symbol: string; interval: string } | null };
  items: Array<{ symbol: string; interval: string; status: string; rows: number; error?: string }>;
  request: Record<string, unknown>;
  dataClass: DataClass;
  source: string | null;
  official?: boolean;
  delaySec?: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  manifestUrl: string;
  /** Why a job stopped when it did not finish on its own (kill switch, login lost, disk full ...). */
  reason?: string;
  /** Present once the job is done. */
  files?: DataFile[];
  tags?: string[];
  notes?: string[];
}
export interface SavedFile {
  name: string;
  path: string;
  bytes: number;
  sha256: string;
  /** true when an identical file was already there. */
  skipped: boolean;
}
export interface SaveOptions {
  names?: string[];
  overwrite?: boolean;
  verify?: boolean;
  signal?: AbortSignal;
}
export interface Dataset {
  name: string;
  /** The Bridge's free-text label (the older name is `description`). */
  title?: string | null;
  description?: string | null;
  tags: string[];
  dataClass: DataClass;
  source: string | null;
  official?: boolean;
  delaySec?: number;
  symbols?: string[];
  intervals?: string[];
  rows?: number;
  bytes?: number;
  /** Not sent by the Bridge on the dataset itself: read them from `files[]`. */
  firstBar?: string;
  lastBar?: string;
  updatedAt?: string;
  files: DataFile[];
  collection?: string | null;
}
export interface Recording {
  id: string;
  name: string;
  kind: "quotes" | "chain";
  status: string;
  symbols: string[];
  underlying?: string | null;
  expiry?: string | null;
  everySec: number;
  sessionOnly: boolean;
  format: "csv" | "jsonl";
  rows: number;
  bytes: number;
  lastWriteAt: string | null;
  /** Times the feed was silent while the recording was due to write. */
  gaps: Array<Record<string, unknown>>;
  diskBytes?: number;
  dataClass: DataClass;
  source: string | null;
  ruleId?: string;
  collection?: string | null;
  files?: DataFile[];
}
export interface RecordingRequest {
  kind: "quotes" | "chain";
  /** quotes: symbols or collection (at least 1 s apart); chain: underlying (+ expiry) or collection (at least 15 s apart). */
  symbols?: string | string[];
  collection?: string;
  underlying?: string;
  expiry?: string;
  everySec: number;
  /** Default true: only inside market hours. */
  sessionOnly?: boolean;
  format?: "csv" | "jsonl";
  name?: string;
}
export type RecordingSchedule = "market-hours" | { days: string[]; start: string; end: string };
export interface RecordingRule {
  id: string;
  name: string;
  enabled: boolean;
  kind: "quotes" | "chain";
  everySec: number;
  schedule: RecordingSchedule;
  collection?: string;
  symbols?: string[];
  underlying?: string;
  universe?: OptionUniverse;
  keepDays?: number;
  format?: "csv" | "jsonl";
}
export interface RecordingRuleInput {
  name: string;
  kind: "quotes" | "chain";
  everySec: number;
  /** Exactly one of collection, symbols or underlying (with universe). */
  collection?: string;
  symbols?: string[];
  underlying?: string;
  universe?: OptionUniverse;
  schedule?: RecordingSchedule;
  enabled?: boolean;
  keepDays?: number;
  format?: "csv" | "jsonl";
}
export interface OptionUniverse {
  underlying: string;
  expiries: "current-weekly" | "next-weekly" | "current-monthly" | "all-weekly" | string[];
  strikes: { around: "atm"; count: number } | { from: number; to: number };
  sides: Array<"CE" | "PE">;
  includeUnderlying: boolean;
  includeFuture: boolean;
}
export interface OptionUniverseParams {
  underlying: string;
  expiries?: OptionUniverse["expiries"];
  /** Strikes either side of ATM (default 10). */
  count?: number;
  fromStrike?: number;
  toStrike?: number;
  sides?: Array<"CE" | "PE">;
  includeUnderlying?: boolean;
  includeFuture?: boolean;
}
export interface Collection {
  /** Stable `col_` id: a renamed collection keeps it. */
  id?: string;
  name: string;
  description: string | null;
  tags: string[];
  kind: "static" | "option-universe";
  symbols: string[];
  universe: OptionUniverse | null;
  updatedAt?: string;
}
export interface Resolution {
  name: string;
  symbols: string[];
  resolvedAt?: string;
  /** How an option universe was worked out (expiry, ATM strike and the price it came from). */
  rule?: unknown;
  atm?: number;
  /** Where the price behind the ATM came from. */
  atmSource?: unknown;
  freshness?: Freshness;
  /** Non-empty when the price behind the ATM was delayed or unavailable: never use such a resolution silently. */
  warnings: string[];
}
export interface Subscription {
  id: string;
  /** The target as the Bridge shows it (without its path). */
  url?: string;
  host?: string;
  label?: string | null;
  topics: string[];
  active: boolean;
  /** ok, unverified, failing, paused or needs-secret. */
  state?: string;
}
export interface DeadLetter {
  id: string;
  eventId?: string;
  topic?: string;
  reason?: string;
  [k: string]: unknown;
}
export type SignatureFailure = "missing_header" | "malformed_header" | "timestamp_out_of_range" | "signature_mismatch";
export interface BridgeEvent {
  topic: string;
  data: Record<string, any>;
  /** The position to resume from: pass it as `since` after a restart of your own program. */
  cursor?: string;
  time?: string;
  raw: unknown;
}
export interface SubscribeOptions {
  /** "download.*", ["recording.gap", "order.*"]; none means every topic the key may see. */
  topics?: string | string[];
  since?: string;
  reconnect?: boolean;
  maxBackoffMs?: number;
  idleTimeoutMs?: number;
  maxReconnects?: number;
  /** Called when the Bridge says events were lost between your cursor and what it still keeps. */
  onGap?: (reason?: string) => void;
}
export declare class EventSubscription implements AsyncIterable<BridgeEvent> {
  cursor?: string;
  reconnects: number;
  connected: boolean;
  closed: boolean;
  /** The Bridge's last `ready` message (cursor, oldest, replayed, gap, gapReason, topics). */
  ready?: { cursor: string; oldest: string | null; replayed: number; gap: boolean; gapReason: string | null; topics: string[] };
  /** true when events were lost: read the current state from the API again, then carry on. */
  gap: boolean;
  gapReason?: string;
  close(): void;
  [Symbol.asyncIterator](): AsyncIterator<BridgeEvent>;
}
export interface VerifyOptions {
  /** Default 300. */
  toleranceSec?: number;
  /** Epoch seconds (tests). */
  now?: number;
  throwOnFail?: boolean;
}
type Bytes = string | Uint8Array;
/** The request headers of a delivery (plain object or Headers), or the two values themselves. */
type SignedHeaders = Headers | Record<string, string | string[] | undefined> | { timestamp?: string | number; signature?: string };
export declare const SIGNATURE_HEADER: "X-Bridge-Signature";
export declare const TIMESTAMP_HEADER: "X-Bridge-Timestamp";
export declare const EVENT_ID_HEADER: "X-Bridge-Event-Id";
export declare const EVENT_TOPIC_HEADER: "X-Bridge-Event-Topic";
export declare const DELIVERY_HEADER: "X-Bridge-Delivery";
export declare const ATTEMPT_HEADER: "X-Bridge-Attempt";
export declare function computeSignature(secret: Bytes, timestamp: number, body: Bytes): string;
/** The two headers the Bridge sends with a delivery, for sending your own test deliveries to a receiver. */
export declare function signPayload(secret: Bytes, body: Bytes, timestamp?: number): { "X-Bridge-Timestamp": string; "X-Bridge-Signature": string };
export declare function explainSignature(secret: Bytes | Bytes[], body: Bytes, headers: SignedHeaders, o?: { toleranceSec?: number; now?: number }): { ok: boolean; reason: "ok" | SignatureFailure };
/** True when X-Bridge-Signature (`v1=<hex>`) is the HMAC-SHA256 of `"<X-Bridge-Timestamp>." + the exact raw body`, within the replay window. */
export declare function verifySignature(secret: Bytes | Bytes[], body: Bytes, headers: SignedHeaders, o?: VerifyOptions): boolean;
export declare function verifyRequest(secret: Bytes | Bytes[], headers: SignedHeaders, body: Bytes, o?: VerifyOptions): boolean;
export declare function topicMatches(pattern: string, topic: string): boolean;
export declare function eventFrom(sseId: string | undefined, sseEvent: string | undefined, payload: string): BridgeEvent;
export declare function parseSse(chunks: AsyncIterable<string>): AsyncGenerator<{ id?: string; event?: string; data: string; retry?: number }>;
export declare function describeDataClass(x: { dataClass?: DataClass; source?: string | null; delaySec?: number }): string;
export declare function optionUniverse(p: OptionUniverseParams): OptionUniverse;
export declare function parseTable(text: string, fmt?: "csv" | "jsonl"): Array<Record<string, any>>;
export declare function toCsv(rows: Array<Record<string, any>>, columns?: string[]): string;

export interface WaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  onProgress?: (job: DownloadJob) => void;
  /** Default true: a failed or cancelled job throws DownloadFailedError. */
  throwOnFailure?: boolean;
  signal?: AbortSignal;
}
type JobRef = string | { id: string };
export interface DownloadEstimate {
  symbols: number;
  intervals: number;
  items: number;
  brokerCalls: number;
  callsSaved: number;
  rows: number;
  rowsToFetch: number;
  bytes: number;
  etaSec: number | null;
  budgetShare: number;
  account: string | null;
  alreadyStored: boolean;
  disk: { usedBytes: number; maxBytes: number; wouldExceed: boolean };
  notes: string[];
  [k: string]: unknown;
}
/** The share of an account's spare API budget background work may use (0.05 to 0.8), as the Bridge applies it now. */
export interface BudgetSettings {
  maxBudgetShare: number;
  /** Downloads only; recordings have no after-hours switch. */
  afterHoursOnly?: boolean;
  defaults: { maxBudgetShare: number; afterHoursOnly?: boolean };
  limits: { minBudgetShare: number; maxBudgetShare: number };
  /** What was changed at run time (not the config file). */
  changed: string[];
}
export interface RecordingStatus {
  line: string;
  enabled: boolean;
  auto: { enabled: boolean; rules: number; activeRules: number };
  today: { rows: number; bytes: number; symbols: number; gaps: number; lastWriteAt: string | null; [k: string]: unknown };
  disk: { usedBytes: number; limitMb: number; [k: string]: unknown };
  apiCalls: { made: number; saved: number };
  budgetShare: number;
  dataClass: "realtime";
  [k: string]: unknown;
}
export interface RecordingPreset {
  id: string;
  title: string;
  about: string;
  needs: string | null;
  rule: Record<string, unknown>;
}
export interface SavedCalls {
  day: string | null;
  /** Reads served from datasets and recordings. */
  total: number;
  byReason: Record<string, number>;
  /** The scheduler's own savings: servedFromStream, servedFromCache, coalesced, batched. */
  scheduler: Record<string, number>;
  totalToday: number;
}
export declare class Downloads {
  create(p: DownloadRequest): Promise<DownloadJob>;
  /** What a download would cost, without starting it (POST /v1/downloads?dryRun=1). Same fields as `create`. */
  estimate(p: DownloadRequest): Promise<DownloadEstimate>;
  settings(): Promise<BudgetSettings>;
  /** An admin key from this computer. The share is 0.05 to 0.8; it applies at once and is kept across restarts. */
  setSettings(changes: { maxBudgetShare?: number; afterHoursOnly?: boolean }): Promise<BudgetSettings>;
  get(job: JobRef): Promise<DownloadJob>;
  list(o?: { status?: JobStatus; limit?: number; cursor?: string }): Promise<DownloadJob[]>;
  pause(job: JobRef): Promise<DownloadJob>;
  resume(job: JobRef): Promise<DownloadJob>;
  cancel(job: JobRef): Promise<DownloadJob>;
  delete(job: JobRef): Promise<void>;
  rename(job: JobRef, p: { name?: string; tags?: string[] }): Promise<DownloadJob>;
  wait(job: JobRef, o?: WaitOptions): Promise<DownloadJob>;
  files(job: JobRef): Promise<DataFile[]>;
  manifest(job: JobRef): Promise<Record<string, unknown> & { files: DataFile[] }>;
  save(job: JobRef, directory: string, o?: SaveOptions): Promise<SavedFile[]>;
  read(job: JobRef, name?: string): Promise<Array<Record<string, any>>>;
  exportInstruments(o?: { dest?: string; exchange?: string; kind?: string; format?: "csv" | "jsonl" }): Promise<string>;
}
export declare class Datasets {
  list(o?: { tag?: string }): Promise<Dataset[]>;
  get(name: string): Promise<Dataset>;
  update(name: string, o?: { wait?: boolean } & WaitOptions): Promise<DownloadJob>;
  edit(name: string, p: { newName?: string; tags?: string[]; title?: string; /** An older name for `title`. */ description?: string }): Promise<Dataset>;
  read(name: string, o?: { symbol?: string; interval?: string; from?: string | number | Date; to?: string | number | Date; account?: string }): Promise<HistoryAllResult>;
  readAll(name: string, o?: { from?: string | number | Date; to?: string | number | Date }): Promise<HistoryAllResult[]>;
}
export declare class RecordingRules {
  list(): Promise<RecordingRule[]>;
  get(idOrName: string): Promise<RecordingRule>;
  create(r: RecordingRuleInput): Promise<RecordingRule>;
  update(id: string, changes: Partial<Omit<RecordingRuleInput, "name">> & { name?: string }): Promise<RecordingRule>;
  enable(id: string): Promise<RecordingRule>;
  disable(id: string): Promise<RecordingRule>;
  delete(id: string): Promise<void>;
}
export declare class Recordings {
  readonly rules: RecordingRules;
  create(p: RecordingRequest): Promise<Recording>;
  get(rec: JobRef): Promise<Recording>;
  status(): Promise<RecordingStatus>;
  settings(): Promise<BudgetSettings>;
  setSettings(changes: { maxBudgetShare: number }): Promise<BudgetSettings>;
  presets(): Promise<RecordingPreset[]>;
  /** Makes the preset's rule (once) and turns auto-record on. `collection` picks the list for `my-watchlist`. */
  applyPreset(preset: string | RecordingPreset, o?: { collection?: string }): Promise<{ preset: string; created: boolean; rule: RecordingRule; auto: { enabled: boolean; rules: number; activeRules: number } }>;
  list(o?: { status?: string }): Promise<Recording[]>;
  pause(rec: JobRef): Promise<Recording>;
  resume(rec: JobRef): Promise<Recording>;
  stop(rec: JobRef): Promise<Recording>;
  delete(rec: JobRef): Promise<void>;
  files(rec: JobRef): Promise<DataFile[]>;
  save(rec: JobRef, directory: string, o?: SaveOptions): Promise<SavedFile[]>;
  read(rec: JobRef, name?: string): Promise<Array<Record<string, any>>>;
}
export declare class Collections {
  list(o?: { tag?: string; kind?: "static" | "option-universe" }): Promise<Collection[]>;
  get(name: string): Promise<Collection>;
  create(name: string, p?: { symbols?: string[]; universe?: OptionUniverse; description?: string; tags?: string[] }): Promise<Collection>;
  update(name: string, p: { symbols?: string[]; universe?: OptionUniverse; description?: string; tags?: string[]; newName?: string }): Promise<Collection>;
  rename(name: string, newName: string): Promise<Collection>;
  tag(name: string, tags?: string[], o?: { remove?: string[] }): Promise<Collection>;
  duplicate(name: string, newName: string): Promise<Collection>;
  delete(name: string): Promise<void>;
  /** A delayed or end-of-day ATM price is refused (422) and a stale one (503) unless `allowStale` (then labelled). */
  resolve(name: string, o?: { allowStale?: boolean }): Promise<Resolution>;
  isReliable(resolution: Resolution): boolean;
  symbols(name: string, o?: { allowStale?: boolean }): Promise<string[]>;
  usage(name: string): Promise<{ downloads?: string[]; recordings?: string[]; datasets?: string[]; [k: string]: unknown }>;
  estimate(name: string, o?: { intervals?: string | string[]; days?: number }): Promise<Record<string, unknown>>;
  export(name: string, o?: { format?: "json" | "csv"; path?: string }): Promise<string>;
  importFrom(source: string, o?: { name?: string; format?: "json" | "csv"; tags?: string[]; description?: string }): Promise<Collection>;
}
export declare class Subscriptions {
  list(): Promise<Subscription[]>;
  get(id: string): Promise<Subscription>;
  create(p: { url: string; topics: string[]; secret: string; active?: boolean; label?: string; accounts?: string | string[] }): Promise<Subscription>;
  update(id: string, p: { url?: string; topics?: string[]; secret?: string; active?: boolean; label?: string }): Promise<Subscription>;
  delete(id: string): Promise<void>;
  test(id: string): Promise<Record<string, unknown>>;
  deliveries(id: string, o?: { limit?: number; outcome?: "delivered" | "retry" | "dead" | "failed" }): Promise<Array<Record<string, unknown>>>;
  deadLetters(id: string): Promise<DeadLetter[]>;
  retryDeadLetter(id: string, letter: string | DeadLetter): Promise<Record<string, unknown>>;
  retryAllDeadLetters(id: string): Promise<Array<Record<string, unknown>>>;
  /** Returns how many were removed. */
  clearDeadLetters(id: string): Promise<number>;
}
export declare class Events {
  subscribe(o?: SubscribeOptions): EventSubscription;
  topics(): Promise<Array<{ topic: string; scope: string; accountScoped: boolean; description: string }>>;
  poll(o?: { since?: string; topics?: string | string[]; limit?: number }): Promise<{ events: BridgeEvent[]; cursor?: string; gap: boolean; gapReason?: string; hasMore: boolean }>;
  waitFor(topic: string, predicate?: (ev: BridgeEvent) => boolean, o?: { timeoutMs?: number; since?: string }): Promise<BridgeEvent | undefined>;
  verifySignature: typeof verifySignature;
  signPayload: typeof signPayload;
}

export interface HistoryAllParams {
  symbol: string;
  interval: Interval;
  from: string | number | Date;
  to?: string | number | Date;
  /** Window size per call (default 120 for intraday, 1500 for daily and longer). */
  chunkDays?: number;
  /** Serve bars the Bridge already stored and fetch only the rest (saves API calls). */
  localFirst?: boolean;
  dataset?: string;
  account?: string;
  /** Let a free source serve it (the result is labelled delayed or end-of-day). */
  backup?: boolean;
}
export interface HistoryAllResult {
  symbol: string;
  interval: string;
  candles: Candle[];
  /** The least current label of all windows. */
  freshness: Freshness;
  partial: boolean;
  windows: number;
  sources: Record<string, number>;
  gaps: Array<[string, string]>;
}
export declare class HistoryAll implements AsyncIterable<Candle> {
  constructor(client: BridgeClient, p: HistoryAllParams);
  readonly calls: number;
  readonly localWindows: number;
  readonly brokerWindows: number;
  readonly sources: Record<string, number>;
  readonly gaps: Array<[number, number]>;
  readonly partial: boolean;
  readonly count: number;
  readonly chunkDays: number;
  readonly freshness: Freshness | undefined;
  [Symbol.asyncIterator](): AsyncIterator<Candle>;
  toHistory(): Promise<HistoryAllResult>;
  toArray(): Promise<Candle[]>;
  records(o?: { freshness?: boolean }): Promise<Array<Record<string, any>>>;
  toCsv(o?: { file?: string; freshness?: boolean }): Promise<string>;
  /** Throws unless every window was real-time. */
  requireRealtime(): this;
}
export declare function toEpochSeconds(v: string | number | Date | undefined, o?: { end?: boolean; now?: number }): number;
export declare function istIso(sec: number): string;
export declare function leastCurrent(labels: Freshness[]): Freshness | undefined;

export type StreamMessage =
  | { type: "heartbeat"; seq: number; time: number; conflated?: number; clientId?: string; heartbeatMs?: number; id?: string | number }
  | { type: "snapshot"; seq: number; mode: StreamMode; symbols: string[]; ticks: Array<Record<string, unknown>>; pending: string[]; id?: string | number }
  | ({ type: "tick"; seq: number; symbol: string; ltp: number; exchangeTs: number | null; receivedAt: number; accountId: string; broker: string } & Partial<QuoteItem>)
  | { type: "order"; seq: number; order: OrderResult }
  | { type: "status"; seq: number; accountId: string; broker: string; state: "up" | "stale" | "down"; connected: boolean; reason?: string | null; subscriptions?: number }
  | { type: "error"; seq: number; code: string; message: string; retryable: boolean; id?: string | number; op?: string; symbols?: string[] }
  | { type: "go_away"; seq: number; reason: string; message: string; reconnectAfterMs: number };

export interface StreamOptions {
  symbols?: string[];
  mode?: StreamMode;
  /** true for all accounts the key may use, or a list of account ids. */
  orders?: boolean | string[];
  reconnect?: boolean;
  maxBackoffMs?: number;
}

export declare class BridgeStream implements AsyncIterable<StreamMessage> {
  readonly subscriptions: Map<string, StreamMode>;
  on(event: "tick", fn: (m: Extract<StreamMessage, { type: "tick" }>) => void): () => void;
  on(event: "order", fn: (m: Extract<StreamMessage, { type: "order" }>) => void): () => void;
  on(event: "gap", fn: (g: { expected: number; got: number }) => void): () => void;
  on(event: "reconnecting", fn: (r: { attempt: number; waitMs: number }) => void): () => void;
  on(event: "failure", fn: (err: unknown) => void): () => void;
  on(event: string, fn: (payload: any) => void): () => void;
  connect(): Promise<void>;
  subscribe(symbols: string | string[], mode?: StreamMode): void;
  unsubscribe(symbols: string | string[]): void;
  ping(): void;
  close(): void;
  [Symbol.asyncIterator](): AsyncIterator<StreamMessage>;
}

export declare class BridgeClient {
  constructor(opts?: ClientOptions);
  readonly baseUrl: string;
  request(method: string, path: string, o?: { query?: Record<string, unknown>; body?: unknown; idempotencyKey?: string; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; retries?: number }): Promise<{ status: number; headers: Headers; body: any }>;

  health(): Promise<{ status: "ok"; version: string; apiVersion: string; [k: string]: unknown }>;
  meta(): Promise<Envelope<Record<string, unknown>>>;
  brokers(): Promise<Envelope<Array<Record<string, unknown>>>>;
  accounts(): Promise<Envelope<Array<Record<string, unknown>>>>;
  account(accountId: string): Promise<Envelope<Record<string, unknown>>>;
  testAccount(accountId: string): Promise<Envelope<{ ok: boolean; message: string }>>;
  limits(o?: { account?: string; explain?: boolean }): Promise<Envelope<unknown>>;
  /** Broker calls not made today (data already stored, streamed, cached or shared), from GET /v1/limits?explain=1. */
  savedCalls(): Promise<SavedCalls>;
  usage(): Promise<Envelope<unknown>>;

  searchInstruments(p: { q: string; exchange?: Exchange; kind?: InstrumentKind; underlying?: string; expiry?: string; limit?: number; cursor?: string }): Promise<Envelope<Instrument[]>>;
  instrument(symbol: string, o?: { include?: "refs" }): Promise<Envelope<Instrument>>;
  convertSymbol(input: string, o?: { from?: "auto" | "canonical" | "chart" | "compact" | "broker"; exchange?: string; broker?: string }): Promise<Envelope<ConvertResult>>;
  convertSymbols(items: Array<string | { input: string; from?: string; exchange?: string; broker?: string }>): Promise<Envelope<Array<ConvertResult | ItemError>>>;

  ltp(symbols: string | string[], o?: ReadOpts): Promise<Envelope<LtpItem[]>>;
  quotes(symbols: string | string[], o?: ReadOpts): Promise<Envelope<QuoteItem[]>>;
  depth(symbol: string, o?: ReadOpts): Promise<Envelope<DepthItem>>;
  history(p: { symbol: string; interval: Interval; from?: string | number; to?: string | number; countback?: number; account?: string; localFirst?: boolean; dataset?: string; backup?: boolean }): Promise<Envelope<HistoryResult>>;
  history(p: { symbol: string; interval: Interval; from?: string | number; to?: string | number; countback?: number; account?: string; format: "csv" }): Promise<string>;
  /** Candles over any length of time: `for await (const c of bridge.historyAll({ symbol, interval, from, to }))`. */
  historyAll(p: HistoryAllParams): HistoryAll;
  expiries(underlying: string, o?: { exchange?: Exchange; account?: string }): Promise<Envelope<{ underlying: string; expiries: string[]; freshness: Freshness }>>;
  optionChain(p: { underlying: string; expiry: string; strikes?: number; greeks?: boolean } & ReadOpts): Promise<Envelope<OptionChain>>;
  streamStats(): Promise<Envelope<Record<string, unknown>>>;

  positions(account: string, o?: { mode?: Mode }): Promise<Envelope<Position[]>>;
  holdings(account: string): Promise<Envelope<Holding[]>>;
  funds(account: string, o?: { mode?: Mode }): Promise<Envelope<Funds>>;

  orders(p?: { account?: string; mode?: Mode; status?: OrderStatus; limit?: number; cursor?: string }): Promise<Envelope<OrderResult[]>>;
  order(orderId: string): Promise<Envelope<OrderResult>>;
  orderByClientId(clientOrderId: string): Promise<Envelope<OrderResult>>;
  trades(p?: { account?: string; mode?: Mode; limit?: number; cursor?: string }): Promise<Envelope<Array<Record<string, unknown>>>>;
  previewOrder(order: OrderRequest, o?: { signal?: AbortSignal }): Promise<Envelope<PreviewResult>>;
  placeOrder(order: OrderRequest, o?: WriteOpts): Promise<WriteResult<OrderResult>>;
  modifyOrder(orderId: string, changes: OrderChanges, o?: WriteOpts): Promise<WriteResult<OrderResult>>;
  cancelOrder(orderId: string, o?: WriteOpts): Promise<WriteResult<OrderResult>>;
  cancelAllOrders(p?: { account?: string; mode?: Mode }, o?: WriteOpts): Promise<WriteResult<{ cancelled: string[]; failed: ItemError[] }>>;

  paperAccount(accountId: string): Promise<Envelope<Record<string, unknown>>>;
  resetPaperAccount(accountId: string, o?: { startingCapital?: number }): Promise<Envelope<Record<string, unknown>>>;
  safety(): Promise<Envelope<{ killSwitch: KillSwitchState; liveTrading: boolean; accounts?: unknown[] }>>;
  engageKillSwitch(p: { reason: string; cancelOpenOrders?: boolean }): Promise<Envelope<KillSwitchState>>;

  paginate<T>(fn: (params: any) => Promise<Envelope<T[]>>, params?: Record<string, unknown>): AsyncGenerator<T>;

  streamToken(): Promise<{ token: string; expiresAt: string }>;
  streamUrl(): Promise<string>;
  stream(opts?: StreamOptions): BridgeStream;

  /** Open a reply that is read piece by piece (a file or an event stream); a problem reply throws BridgeApiError. */
  openStream(method: string, path: string, o?: { query?: Record<string, unknown>; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; accept?: string }): Promise<Response>;

  // Friendly groups (they return the reply's `data`; the calls below return the whole envelope).
  readonly downloads: Downloads;
  readonly datasets: Datasets;
  readonly recordings: Recordings;
  readonly collections: Collections;
  readonly subscriptions: Subscriptions;
  readonly events: Events;

  createDownload(request: DownloadRequest, o?: { dryRun?: false }): Promise<Envelope<DownloadJob>>;
  createDownload(request: DownloadRequest, o: { dryRun: true }): Promise<Envelope<DownloadEstimate>>;
  downloadSettings(): Promise<Envelope<BudgetSettings>>;
  setDownloadSettings(changes: { maxBudgetShare?: number; afterHoursOnly?: boolean }): Promise<Envelope<BudgetSettings>>;
  recordingStatus(): Promise<Envelope<RecordingStatus>>;
  recordingSettings(): Promise<Envelope<BudgetSettings>>;
  setRecordingSettings(changes: { maxBudgetShare: number }): Promise<Envelope<BudgetSettings>>;
  recordingPresets(): Promise<Envelope<RecordingPreset[]>>;
  applyRecordingPreset(id: string, body?: { collection?: string }): Promise<Envelope<unknown>>;
  listDownloads(p?: { status?: JobStatus; limit?: number; cursor?: string }): Promise<Envelope<DownloadJob[]>>;
  download(id: string): Promise<Envelope<DownloadJob>>;
  pauseDownload(id: string): Promise<Envelope<DownloadJob>>;
  resumeDownload(id: string): Promise<Envelope<DownloadJob>>;
  cancelDownload(id: string): Promise<Envelope<DownloadJob>>;
  deleteDownload(id: string): Promise<unknown>;
  editDownload(id: string, changes: { name?: string; tags?: string[] }): Promise<Envelope<DownloadJob>>;
  downloadFiles(id: string): Promise<Envelope<DataFile[]>>;
  listDatasets(p?: { tag?: string }): Promise<Envelope<Dataset[]>>;
  dataset(name: string): Promise<Envelope<Dataset>>;
  updateDataset(name: string, body?: Record<string, unknown>): Promise<Envelope<DownloadJob>>;
  editDataset(name: string, changes: { name?: string; tags?: string[]; description?: string }): Promise<Envelope<Dataset>>;
  listRecordings(p?: { status?: string }): Promise<Envelope<Recording[]>>;
  createRecording(request: RecordingRequest): Promise<Envelope<Recording>>;
  recording(id: string): Promise<Envelope<Recording>>;
  pauseRecording(id: string): Promise<Envelope<Recording>>;
  resumeRecording(id: string): Promise<Envelope<Recording>>;
  stopRecording(id: string): Promise<Envelope<Recording>>;
  deleteRecording(id: string): Promise<unknown>;
  recordingFiles(id: string): Promise<Envelope<DataFile[]>>;
  recordingRules(): Promise<Envelope<RecordingRule[]>>;
  createRecordingRule(rule: RecordingRuleInput): Promise<Envelope<RecordingRule>>;
  updateRecordingRule(id: string, changes: Record<string, unknown>): Promise<Envelope<RecordingRule>>;
  deleteRecordingRule(id: string): Promise<unknown>;
  listCollections(p?: { tag?: string; kind?: string }): Promise<Envelope<Collection[]>>;
  collection(name: string): Promise<Envelope<Collection>>;
  createCollection(collection: Record<string, unknown>): Promise<Envelope<Collection>>;
  updateCollection(name: string, changes: Record<string, unknown>): Promise<Envelope<Collection>>;
  deleteCollection(name: string): Promise<unknown>;
  resolveCollection(name: string, o?: { allowStale?: boolean }): Promise<Envelope<Resolution>>;
  collectionUsage(name: string): Promise<Envelope<Record<string, unknown>>>;
  collectionEstimate(name: string, o?: { intervals?: string | string[]; days?: number }): Promise<Envelope<Record<string, unknown>>>;
  listSubscriptions(): Promise<Envelope<Subscription[]>>;
  createSubscription(subscription: { url: string; topics: string[]; secret: string; active?: boolean; label?: string; accounts?: string | string[] }): Promise<Envelope<Subscription>>;
  updateSubscription(id: string, changes: Record<string, unknown>): Promise<Envelope<Subscription>>;
  deleteSubscription(id: string): Promise<unknown>;
  testSubscription(id: string): Promise<Envelope<Record<string, unknown>>>;
  subscription(id: string): Promise<Envelope<Subscription>>;
  subscriptionDeliveries(id: string, o?: { limit?: number; outcome?: string }): Promise<Envelope<Array<Record<string, unknown>>>>;
  subscriptionDeadLetters(id: string): Promise<Envelope<DeadLetter[]>>;
  retryDeadLetter(id: string, deliveryId: string): Promise<Envelope<Record<string, unknown>>>;
  clearDeadLetters(id: string): Promise<Envelope<{ removed: number }>>;
}
