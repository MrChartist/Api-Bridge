// Type definitions for @mrchartist/bridge-client, written against docs/openapi.yaml (Mr. Chartist API Bridge v1).

export type Exchange = "NSE" | "BSE" | "NFO" | "BFO" | "MCX" | "CDS";
export type InstrumentKind = "INDEX" | "EQ" | "FUT" | "OPT";
export type Interval = "1m" | "3m" | "5m" | "10m" | "15m" | "30m" | "60m" | "1d" | "1w" | "1M";
export type StreamMode = "ltp" | "quote" | "depth";
export type Mode = "paper" | "live";
export type Product = "CNC" | "INTRADAY" | "MARGIN" | "MTF";
export type OrderType = "LIMIT" | "MARKET" | "SL" | "SL-M";
export type OrderStatus = "pending" | "open" | "trigger_pending" | "partially_filled" | "filled" | "cancelled" | "rejected" | "expired" | "outcome_unknown";

export interface Freshness {
  source: "stream" | "cache" | "broker" | "paper";
  asOf: string;
  ageMs: number;
  stale: boolean;
  accountId?: string | null;
  broker?: string | null;
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
  limits(o?: { account?: string }): Promise<Envelope<unknown>>;
  usage(): Promise<Envelope<unknown>>;

  searchInstruments(p: { q: string; exchange?: Exchange; kind?: InstrumentKind; underlying?: string; expiry?: string; limit?: number; cursor?: string }): Promise<Envelope<Instrument[]>>;
  instrument(symbol: string, o?: { include?: "refs" }): Promise<Envelope<Instrument>>;
  convertSymbol(input: string, o?: { from?: "auto" | "canonical" | "tradingview" | "compact" | "broker"; exchange?: string; broker?: string }): Promise<Envelope<ConvertResult>>;
  convertSymbols(items: Array<string | { input: string; from?: string; exchange?: string; broker?: string }>): Promise<Envelope<Array<ConvertResult | ItemError>>>;

  ltp(symbols: string | string[], o?: ReadOpts): Promise<Envelope<LtpItem[]>>;
  quotes(symbols: string | string[], o?: ReadOpts): Promise<Envelope<QuoteItem[]>>;
  depth(symbol: string, o?: ReadOpts): Promise<Envelope<DepthItem>>;
  history(p: { symbol: string; interval: Interval; from?: string | number; to?: string | number; countback?: number; account?: string }): Promise<Envelope<HistoryResult>>;
  history(p: { symbol: string; interval: Interval; from?: string | number; to?: string | number; countback?: number; account?: string; format: "csv" }): Promise<string>;
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
}
