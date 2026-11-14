/**
 * Errors raised by the Mr. Chartist API Bridge Node client.
 *
 *  - BridgeApiError: the Bridge answered with an RFC 9457 problem (or another non-2xx reply). `code` is the stable
 *    Bridge error code and `retryable` says whether exactly the same request may be sent again.
 *  - BridgeConnectionError: no usable reply (connection refused, reset, timeout). For a write, `outcomeUnknown` is
 *    true: the Bridge may have acted on it. Check the order book (or resend with the SAME idempotencyKey, which the
 *    Bridge de-duplicates) instead of sending a fresh order.
 */

export class BridgeError extends Error {}

export class BridgeApiError extends BridgeError {
  /**
   * @param {{ status: number, code: string, title?: string, detail?: string, retryable?: boolean, requestId?: string,
   *   retryAfterMs?: number, broker?: object, errors?: Array<{ path: string, code?: string, message: string, allowed?: unknown[] }> }} problem
   * @param {{ idempotencyKey?: string, headers?: Record<string, string> }} [extra]
   */
  constructor(problem, extra = {}) {
    super(problem.detail || problem.title || `HTTP ${problem.status}`);
    this.name = "BridgeApiError";
    this.status = problem.status;
    this.code = problem.code || "UNKNOWN";
    this.title = problem.title;
    this.detail = problem.detail;
    this.retryable = problem.retryable === true;
    this.requestId = problem.requestId;
    if (problem.retryAfterMs !== undefined) this.retryAfterMs = problem.retryAfterMs;
    if (problem.broker) this.broker = problem.broker;
    if (problem.errors) this.errors = problem.errors;
    if (extra.idempotencyKey) this.idempotencyKey = extra.idempotencyKey;
    this.problem = problem;
  }
}

export class BridgeConnectionError extends BridgeError {
  /**
   * @param {string} message
   * @param {{ cause?: unknown, method: string, path: string, outcomeUnknown: boolean, idempotencyKey?: string, timedOut?: boolean }} info
   */
  constructor(message, info) {
    super(message, info.cause !== undefined ? { cause: info.cause } : undefined);
    this.name = "BridgeConnectionError";
    this.method = info.method;
    this.path = info.path;
    this.outcomeUnknown = info.outcomeUnknown;
    this.timedOut = info.timedOut === true;
    if (info.idempotencyKey) this.idempotencyKey = info.idempotencyKey;
  }
}

/** A download job ended failed or cancelled. `job` is its final state; `job.reason` says why (kill switch, lost login, full disk ...). */
export class DownloadFailedError extends BridgeError {
  constructor(message, job) {
    super(message);
    this.name = "DownloadFailedError";
    this.job = job;
  }
}

/** A wait ran out of time. The thing waited for keeps going in the Bridge: look again. `last` is its last known state. */
export class WaitTimeoutError extends BridgeError {
  constructor(message, last) {
    super(message);
    this.name = "WaitTimeoutError";
    this.last = last;
  }
}

/** A downloaded file's SHA-256 is not the one in the manifest. The partial file is deleted. */
export class ChecksumMismatchError extends BridgeError {
  constructor(message, { expected, actual }) {
    super(message);
    this.name = "ChecksumMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

/** A webhook delivery failed verification. `reason`: missing_header, malformed_header, timestamp_out_of_range or signature_mismatch. */
export class SignatureInvalidError extends BridgeError {
  constructor(message, reason) {
    super(message);
    this.name = "SignatureInvalidError";
    this.reason = reason;
  }
}
