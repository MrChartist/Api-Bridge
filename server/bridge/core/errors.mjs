/**
 * Error taxonomy for the Bridge, mapped to HTTP and to RFC 9457 Problem Details.
 *
 * Every error a client can see has a stable string `code`, an HTTP status and a `retryable` flag. The flag
 * answers one question for scripts, webhooks and AI clients: "is it safe to send exactly this request again?"
 * A write whose outcome is unknown is NEVER retryable; the client must check the order book first.
 *
 * Wire format (application/problem+json):
 *   { type, title, status, detail, code, retryable, requestId, broker?: { id, code, message }, errors?: [...] }
 *
 * Rate-limit refusals (HTTP 429) say WHOSE limit was hit, so a client can react correctly:
 *   RATE_LIMITED           the caller's own quota or caps (scope "client": the key's rate, daily cap or concurrency;
 *                          scope "consumer-cap": too many of its own requests waiting for the broker)
 *   UPSTREAM_RATE_LIMITED  the shared broker budget (scope "upstream": the budget cannot serve the request in time;
 *                          scope "queue": the shared queue is full)
 *   + scope, retryAfterMs (the true wait, in ms) and limit: { name, remaining, resetMs } (the budget that said no).
 * The Retry-After header is the same wait in whole seconds, jittered 0 to 25 % upward so waiting clients do not
 * all come back in the same second, and never below the true wait. Clients must not parse `detail`.
 *
 * Broker adapter errors (server/brokers/contract.mjs BrokerError: 422 = we refused, 502 = upstream) are
 * converted with fromBrokerError(), which keeps the broker's own code in `broker.code`.
 */

/** @typedef {{ status: number, title: string, retryable: boolean }} ErrorSpec */

/** code -> { status, title, retryable }. Codes are part of the public API: add, never rename. */
export const ERROR_CODES = Object.freeze({
  // Request problems (never retry unchanged)
  VALIDATION_FAILED: { status: 400, title: "The request is not valid", retryable: false },
  INVALID_JSON: { status: 400, title: "The request body is not valid JSON", retryable: false },
  UNAUTHENTICATED: { status: 401, title: "A valid API key is required", retryable: false },
  SCOPE_REQUIRED: { status: 403, title: "This API key does not have the scope this action needs", retryable: false },
  ACCOUNT_FORBIDDEN: { status: 403, title: "This API key may not use this account", retryable: false },
  HOST_NOT_ALLOWED: { status: 403, title: "Requests must be addressed to an allowed host name", retryable: false },
  ORIGIN_NOT_ALLOWED: { status: 403, title: "This web page origin is not on the allowlist", retryable: false },
  LOOPBACK_ONLY: { status: 403, title: "This action is only available from this computer", retryable: false },
  NOT_FOUND: { status: 404, title: "Not found", retryable: false },
  ACCOUNT_NOT_FOUND: { status: 404, title: "No account with this id", retryable: false },
  SYMBOL_NOT_FOUND: { status: 404, title: "The symbol could not be resolved", retryable: false },
  AMBIGUOUS_SYMBOL: { status: 409, title: "The symbol matches more than one instrument. Choose one of the candidates", retryable: false },
  ORDER_NOT_FOUND: { status: 404, title: "No order with this id", retryable: false },
  METHOD_NOT_ALLOWED: { status: 405, title: "Method not allowed", retryable: false },
  IDEMPOTENCY_KEY_REUSED: { status: 409, title: "This idempotency key was already used with different parameters", retryable: false },
  IDEMPOTENCY_IN_PROGRESS: { status: 409, title: "A request with this idempotency key is still running", retryable: true },
  DUPLICATE_CLIENT_ORDER_ID: { status: 409, title: "This clientOrderId was already used", retryable: false },
  PAYLOAD_TOO_LARGE: { status: 413, title: "The request body is too large", retryable: false },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, title: "Send the body as application/json", retryable: false },
  CAPABILITY_UNSUPPORTED: { status: 422, title: "This broker does not support this request", retryable: false },
  INVALID_ORDER: { status: 422, title: "The order failed a pre-trade check", retryable: false },
  SESSION_EXPIRED: { status: 422, title: "The broker session has expired. Log in again", retryable: false },
  POSITION_UNKNOWN: { status: 503, title: "The current position could not be read, so nothing was placed", retryable: true },
  CONFIRMATION_REQUIRED: { status: 422, title: "This order needs a human confirmation first", retryable: false },
  STATE_CONFLICT: { status: 409, title: "The item changed or is busy; read it again", retryable: true },
  // Safety refusals
  PAPER_ONLY: { status: 403, title: "Live trading is not enabled for this account", retryable: false },
  ORDER_GATE_CLOSED: { status: 403, title: "The live order gate refused this order. No order was sent", retryable: false },
  DAILY_LIMIT_REACHED: { status: 403, title: "A daily safety limit has been reached", retryable: false },
  MARKET_CLOSED: { status: 403, title: "The market is closed for this instrument", retryable: false },
  KILL_SWITCH_ACTIVE: { status: 423, title: "The kill switch is on. No orders are being sent", retryable: false },
  CANNOT_TRADE: { status: 403, title: "This account cannot trade right now (trading readiness)", retryable: false },
  // Throttling (retry after Retry-After)
  RATE_LIMITED: { status: 429, title: "Too many requests from this API key", retryable: true },
  ORDER_RATE_LIMITED: { status: 429, title: "Order rate cap for this account reached", retryable: true },
  UPSTREAM_RATE_LIMITED: { status: 429, title: "The broker's rate limit was reached", retryable: true },
  SUBSCRIPTION_LIMIT: { status: 429, title: "The broker feed subscription limit was reached", retryable: false },
  // Server and upstream
  INTERNAL: { status: 500, title: "Internal error", retryable: false },
  NOT_IMPLEMENTED: { status: 501, title: "This part of the Bridge is not built yet", retryable: false },
  UPSTREAM_ERROR: { status: 502, title: "The broker returned an error", retryable: false },
  BROKER_UNAVAILABLE: { status: 503, title: "The broker is not reachable right now", retryable: true },
  UPSTREAM_TIMEOUT: { status: 504, title: "The broker did not respond in time", retryable: true },
  OUTCOME_UNKNOWN: { status: 504, title: "The order outcome is unknown. Check the order book before sending it again", retryable: false },
});

/** Where a rate-limit refusal came from (see the file comment). */
export const REFUSAL_SCOPES = Object.freeze(["client", "upstream", "queue", "consumer-cap"]);

/**
 * Retry-After in whole seconds for a wait of `retryAfterMs`: rounded up, then 0 to 25 % added so that clients that
 * were refused together do not retry together. Never less than the true wait.
 * @param {number} retryAfterMs
 * @param {() => number} [random] 0 <= r < 1 (tests)
 */
export function jitteredRetryAfterSeconds(retryAfterMs, random = Math.random) {
  const ms = Math.max(0, Number(retryAfterMs) || 0);
  return Math.max(1, Math.ceil((ms * (1 + 0.25 * random())) / 1000));
}

export const PROBLEM_TYPE_BASE = "https://bridge.mrchartist.local/errors/";

/** The one error class handlers throw. Anything else becomes INTERNAL (and its message is not shown). */
export class BridgeError extends Error {
  /**
   * @param {keyof typeof ERROR_CODES | string} code
   * @param {string} [detail] Human text in Indian English. Clients must not parse it.
   * @param {{ status?: number, retryable?: boolean, retryAfterMs?: number, scope?: "client"|"upstream"|"queue"|"consumer-cap",
   *           limit?: { name: string, remaining: number, resetMs: number }, broker?: { id?: string, code?: string, message?: string },
   *           errors?: Array<{ path: string, message: string }>, headers?: Record<string, string>, cause?: unknown,
   *           fields?: Record<string, unknown> }} [extra]
   *   fields: extra documented problem members for one code; they never replace the standard members.
   */
  constructor(code, detail, extra = {}) {
    const spec = ERROR_CODES[code] ?? ERROR_CODES.INTERNAL;
    super(detail ?? spec.title, extra.cause !== undefined ? { cause: extra.cause } : undefined);
    this.name = "BridgeError";
    this.code = ERROR_CODES[code] ? code : "INTERNAL";
    this.status = extra.status ?? spec.status;
    this.retryable = extra.retryable ?? spec.retryable;
    this.detail = detail ?? spec.title;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
    if (extra.scope !== undefined) {
      if (!REFUSAL_SCOPES.includes(extra.scope)) throw new RangeError(`Unknown refusal scope "${extra.scope}"`);
      this.scope = extra.scope;
    }
    if (extra.limit) this.limit = extra.limit;
    if (extra.broker) this.broker = extra.broker;
    if (extra.errors) this.errors = extra.errors;
    if (extra.headers) this.headers = extra.headers;
    if (extra.fields && typeof extra.fields === "object") this.fields = extra.fields;
  }
}

/** Thrown by stub services until the owning module builds them. */
export class NotImplementedError extends BridgeError {
  constructor(what) {
    super("NOT_IMPLEMENTED", `${what} is not built yet.`);
    this.name = "NotImplementedError";
  }
}

/** Broker contract code -> Bridge code. `write` decides what a timeout means. */
const BROKER_CODE_MAP = Object.freeze({
  SESSION_LOGIN_REQUIRED: "SESSION_EXPIRED",
  UPSTREAM_AUTH: "SESSION_EXPIRED",
  ORDER_GATE_CLOSED: "ORDER_GATE_CLOSED",
  BROKER_INPUT_INVALID: "VALIDATION_FAILED",
  CAPABILITY_UNSUPPORTED: "CAPABILITY_UNSUPPORTED",
  UPSTREAM_RATE_LIMIT: "UPSTREAM_RATE_LIMITED",
  UPSTREAM_RATE_LIMITED: "UPSTREAM_RATE_LIMITED",
  UPSTREAM_REDIRECT_REFUSED: "UPSTREAM_ERROR",
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
});

/**
 * Convert an error thrown by a broker adapter into a BridgeError.
 * @param {any} err
 * @param {{ brokerId?: string, write?: boolean }} [opts] write=true turns timeouts into OUTCOME_UNKNOWN.
 */
export function fromBrokerError(err, { brokerId, write = false } = {}) {
  if (err instanceof BridgeError) return err;
  const brokerCode = typeof err?.code === "string" ? err.code : "UPSTREAM_ERROR";
  let code;
  if (brokerCode === "UPSTREAM_TIMEOUT") code = write ? "OUTCOME_UNKNOWN" : "UPSTREAM_TIMEOUT";
  else code = BROKER_CODE_MAP[brokerCode] ?? (err?.statusCode === 422 ? "VALIDATION_FAILED" : "UPSTREAM_ERROR");
  // A write that failed upstream without a clear refusal may still have reached the exchange.
  if (write && code === "UPSTREAM_ERROR") code = "OUTCOME_UNKNOWN";
  const message = typeof err?.message === "string" ? err.message.slice(0, 240) : undefined;
  return new BridgeError(code, message, { broker: { id: brokerId, code: brokerCode, message }, cause: err });
}

/**
 * Turn any thrown value into a Problem Details object. Unknown errors never leak their message.
 * @param {unknown} err
 * @param {{ requestId?: string, instance?: string }} [opts]
 */
export function toProblem(err, { requestId, instance } = {}) {
  const e = err instanceof BridgeError ? err : new BridgeError("INTERNAL");
  const spec = ERROR_CODES[e.code];
  const problem = {
    type: PROBLEM_TYPE_BASE + e.code.toLowerCase().replace(/_/g, "-"),
    title: spec.title,
    status: e.status,
    detail: e.detail,
    code: e.code,
    retryable: e.retryable,
  };
  if (requestId) problem.requestId = requestId;
  if (instance) problem.instance = instance;
  if (e.retryAfterMs !== undefined) problem.retryAfterMs = e.retryAfterMs;
  if (e.scope !== undefined) problem.scope = e.scope;
  if (e.limit) problem.limit = e.limit;
  if (e.broker) problem.broker = e.broker;
  if (e.errors) problem.errors = e.errors;
  if (e.fields) for (const [k, v] of Object.entries(e.fields)) if (!(k in problem)) problem[k] = v;
  return problem;
}

/**
 * Response headers that go with an error (Retry-After in whole seconds, plus anything the thrower set). Rate-limit
 * refusals that carry a `scope` get the jittered Retry-After (jitteredRetryAfterSeconds); other errors the plain one.
 */
export function problemHeaders(err) {
  const h = { ...(err instanceof BridgeError && err.headers ? err.headers : {}) };
  if (err instanceof BridgeError && err.retryAfterMs !== undefined) {
    h["Retry-After"] = String(err.scope !== undefined ? jitteredRetryAfterSeconds(err.retryAfterMs) : Math.max(1, Math.ceil(err.retryAfterMs / 1000)));
  }
  // RFC 9110: a 401 names the way to authenticate.
  if (err instanceof BridgeError && err.status === 401 && h["WWW-Authenticate"] === undefined) h["WWW-Authenticate"] = 'Bearer realm="mc-bridge"';
  return h;
}

/** Convert a zod error (or any { issues: [{ path, message }] }) into VALIDATION_FAILED. */
export function fromValidation(zodError, detail = "Some fields are missing or not valid.") {
  const errors = (zodError?.issues ?? []).slice(0, 20).map((i) => ({ path: (i.path ?? []).join(".") || "(root)", message: String(i.message) }));
  return new BridgeError("VALIDATION_FAILED", detail, { errors });
}
