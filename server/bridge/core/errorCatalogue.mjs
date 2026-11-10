/**
 * The error catalogue: every problem `code` the Bridge can return, with a plain explanation and the fix.
 *
 * The codes, their HTTP status and whether a retry is safe come from the real definitions in errors.mjs (ERROR_CODES);
 * this file adds only the words a developer needs: what the code means in practice (`means`) and what to do about it
 * (`fix`). A test (errorCatalogue.test.mjs) fails when a code in ERROR_CODES has no entry here, or an entry has no
 * words, so a new code cannot ship unexplained. The same catalogue feeds GET /v1/errors, the dashboard's Developers
 * page and docs/api/errors.md, so the three cannot disagree.
 */
import { ERROR_CODES } from "./errors.mjs";

/** code -> { means, fix }. Plain words. `means` says what happened; `fix` says what to do next. */
export const ERROR_GUIDE = Object.freeze({
  VALIDATION_FAILED: {
    means: "The request reached the Bridge but a field is missing, has the wrong type or is out of range. The `errors` list names each field.",
    fix: "Read `errors[].path` and `errors[].message`, correct those fields and send it again. Retrying the same body will fail the same way.",
  },
  INVALID_JSON: {
    means: "The body could not be read as JSON (a trailing comma, single quotes, or a body that was cut off).",
    fix: "Send valid JSON with the header `Content-Type: application/json`. Check the body with a JSON validator before sending.",
  },
  UNAUTHENTICATED: {
    means: "No API key was sent, the key is wrong, it has expired or it was revoked.",
    fix: "Send `Authorization: Bearer mcb_<id>_<secret>`. Check the key under Developers > Apps (status and expiry). If it is lost, revoke it and create a new one: a key is shown only once.",
  },
  SCOPE_REQUIRED: {
    means: "The key is valid, but its scope does not allow this action (for example a read key sending an order).",
    fix: "Use a key with the scope this route needs: Developers > Scope finder tells you which. Create a new app with that preset rather than widening a key you already shared.",
  },
  ACCOUNT_FORBIDDEN: {
    means: "The key is limited to some broker accounts and this request names another one.",
    fix: "Send the `account` the key may use, or create a key that includes this account.",
  },
  HOST_NOT_ALLOWED: {
    means: "The request was addressed to a host name the Bridge does not accept. This guards against web pages that point a look-alike name at your computer.",
    fix: "Call the Bridge as http://127.0.0.1:<port> or http://localhost:<port>. For a tunnel or proxy, add its host name to the allowed hosts in the configuration.",
  },
  ORIGIN_NOT_ALLOWED: {
    means: "A browser page from another site tried to call the Bridge. The Bridge only answers its own dashboard and origins you listed.",
    fix: "Call from a server or script instead of a web page. If you run your own page, add its origin to the allowed origins in the configuration.",
  },
  LOOPBACK_ONLY: {
    means: "This action (keys, admin settings, anything that could move money or open the Bridge to others) works only from the computer the Bridge runs on.",
    fix: "Run it on that computer: the dashboard, the `mc-bridge` command, or curl to 127.0.0.1. It cannot be done through a tunnel or from another machine.",
  },
  NOT_FOUND: {
    means: "There is no such route or item. On a route this is usually a typo, or the route belongs to a newer Bridge than the one you run.",
    fix: "Check the path against GET /v1/meta (the list of routes this Bridge serves) or the OpenAPI file. Update the Bridge if a documented route is missing.",
  },
  ACCOUNT_NOT_FOUND: {
    means: "No broker account has this id.",
    fix: "List accounts with GET /v1/accounts and use one of the ids it returns.",
  },
  SYMBOL_NOT_FOUND: {
    means: "The symbol could not be matched to an instrument.",
    fix: "Use the canonical form EXCHANGE:SYMBOL (for example NSE:RELIANCE). Search with GET /v1/instruments/search, or convert with POST /v1/symbols/resolve.",
  },
  AMBIGUOUS_SYMBOL: {
    means: "The text matches more than one instrument, so the Bridge will not guess.",
    fix: "Pick one of the candidates in the answer and send its full canonical symbol.",
  },
  ORDER_NOT_FOUND: {
    means: "No order has this id (or it belongs to an account this key cannot see).",
    fix: "List orders with GET /v1/orders and copy the id. To find an order you sent with your own id, use GET /v1/orders/by-client-id/{clientOrderId}.",
  },
  METHOD_NOT_ALLOWED: {
    means: "The route exists but not for this HTTP method (for example GET on a route that only accepts POST).",
    fix: "Use the method the documentation shows for this path. The `Allow` header lists the methods it accepts.",
  },
  IDEMPOTENCY_KEY_REUSED: {
    means: "You sent an `Idempotency-Key` that was already used with a different request body. The Bridge refuses it so a retry can never become a second, different order.",
    fix: "Use a new key for a new order. Reuse a key only when you resend exactly the same request.",
  },
  IDEMPOTENCY_IN_PROGRESS: {
    means: "A request with this `Idempotency-Key` is still being processed.",
    fix: "Wait a moment and send the same request with the same key again. You will get the original result, not a second action.",
  },
  DUPLICATE_CLIENT_ORDER_ID: {
    means: "Your own `clientOrderId` was already used for an order on this account.",
    fix: "Look the earlier order up with GET /v1/orders/by-client-id/{clientOrderId}. For a new order, use a new id.",
  },
  PAYLOAD_TOO_LARGE: {
    means: "The request body is bigger than the route allows.",
    fix: "Send less per request (split a long symbol list or a big batch into several calls).",
  },
  UNSUPPORTED_MEDIA_TYPE: {
    means: "The body was not sent as JSON.",
    fix: "Add the header `Content-Type: application/json` and send a JSON body.",
  },
  CAPABILITY_UNSUPPORTED: {
    means: "This broker cannot do what you asked (for example an order type or a data kind it does not offer).",
    fix: "Check the broker's abilities in the dashboard under Accounts, or use another account or order type.",
  },
  INVALID_ORDER: {
    means: "The order failed a check before it was sent (for example a bad lot size, a price outside the allowed range, or too little margin). Nothing was sent to the broker.",
    fix: "Read `detail`, correct the order and send it again. POST /v1/orders/preview checks an order without placing it.",
  },
  SESSION_EXPIRED: {
    means: "The login with the broker has ended, so the Bridge cannot read or place anything for that account.",
    fix: "Log in again: dashboard > Accounts > Log in, or `mc-bridge accounts connect <accountId>`. Most brokers need a fresh login every day.",
  },
  POSITION_UNKNOWN: {
    means: "The Bridge could not read your current position, so it did not place the order. A guess could have doubled a position.",
    fix: "Wait a few seconds and send the same request again, or check GET /v1/positions first.",
  },
  CONFIRMATION_REQUIRED: {
    means: "This order is waiting for a person to approve it on the computer running the Bridge. Approval never happens through the API.",
    fix: "Open the dashboard > Orders and approve or reject the ticket. Your program can poll GET /v1/tickets.",
  },
  STATE_CONFLICT: {
    means: "The item changed, or is busy, while you were working on it (for example an order that was filled before your change arrived).",
    fix: "Read it again, then decide. Retrying after a short wait is safe.",
  },
  PAPER_ONLY: {
    means: "This account is paper only: live trading is not switched on for it.",
    fix: "Send `mode: \"paper\"`. Live orders need several opt-ins made on the computer running the Bridge: see the safety guide.",
  },
  ORDER_GATE_CLOSED: {
    means: "A rule that guards live orders said no, so the order was not sent.",
    fix: "Read `detail` for which rule it was. The live-order conditions are listed in the dashboard under Safety.",
  },
  DAILY_LIMIT_REACHED: {
    means: "A daily safety limit (orders, loss or value) has been reached.",
    fix: "Nothing to retry today unless you raise the limit on the computer running the Bridge. The limits and what counted are under Safety.",
  },
  MARKET_CLOSED: {
    means: "The exchange is closed for this instrument, so an order would not be accepted.",
    fix: "Send it when the market is open. GET /v1/calendar/status says whether it is open and when it next opens.",
  },
  KILL_SWITCH_ACTIVE: {
    means: "The kill switch is on. No orders are sent until it is released.",
    fix: "Release it on the computer running the Bridge (dashboard > Safety, or `mc-bridge kill release`). It cannot be released through a tunnel.",
  },
  CANNOT_TRADE: {
    means: "The account is not ready to trade right now (for example a missing static IP registration or a closed session).",
    fix: "Open dashboard > Safety > Trading readiness for the exact reason and what to do.",
  },
  RATE_LIMITED: {
    means: "This key sent too many requests: its own rate, daily cap or number of requests waiting. Other keys are not affected.",
    fix: "Wait `retryAfterMs` (the `Retry-After` header has the same wait in seconds), then retry. Send fewer requests, batch symbols into one call, or raise this key's quota under Sources > Quotas (on this computer).",
  },
  ORDER_RATE_LIMITED: {
    means: "The account reached its order-rate cap. The cap protects you from a runaway program and the broker from too many orders.",
    fix: "Wait `retryAfterMs`, then retry. Slow the program down: do not loop on orders.",
  },
  UPSTREAM_RATE_LIMITED: {
    means: "The broker's shared request budget is used up, or the shared queue is full. This is not about your key: every tool on this Bridge shares that budget.",
    fix: "Wait `retryAfterMs` and retry. `scope` says why (`upstream` or `queue`). Ask for fewer or larger batches, and read the budget with GET /v1/limits.",
  },
  SUBSCRIPTION_LIMIT: {
    means: "The broker's live feed allows only so many symbols at once and the limit is reached.",
    fix: "Unsubscribe from symbols you no longer need, or use fewer symbols. Waiting alone will not clear it.",
  },
  DISK_FULL: {
    means: "The disk the Bridge keeps its data on has no room left, so the change could not be saved. Nothing was accepted that could not be stored (a paper order is not placed unless it is saved).",
    fix: "Free space on that disk (old downloads and recordings are the usual cause: delete them on the Data page), then repeat the request. `mc-bridge doctor` shows free space and what uses it.",
  },
  ORDER_STATE_DAMAGED: {
    means: "The file that records which orders the Bridge sent was damaged (for example after a power cut) and was set aside. Without it the Bridge cannot tell whether a retried live order was already sent, so live orders are refused. Paper orders still work.",
    fix: "Open your broker's order book and check what is open. Then, on this computer, run `mc-bridge orders acknowledge-state` (or POST /v1/orders/state/acknowledge with an admin key) to allow live orders again.",
  },
  INTERNAL: {
    means: "Something went wrong inside the Bridge. The message is hidden on purpose: it could contain private details.",
    fix: "Quote the `requestId` when you report it. The Bridge log on the computer has the cause. Retrying the same request is not guaranteed to help.",
  },
  NOT_IMPLEMENTED: {
    means: "This part of the Bridge is not built in this version.",
    fix: "Update the Bridge, or use another route. Check the changelog for when it arrives.",
  },
  UPSTREAM_ERROR: {
    means: "The broker returned an error. `broker.code` and `broker.message` carry the broker's own words.",
    fix: "Read `broker.message`. For a read, retry later. For an order, check the order book before sending it again.",
  },
  BROKER_UNAVAILABLE: {
    means: "The Bridge could not reach the broker (their servers are down or the connection failed).",
    fix: "Retry after a short wait, with backoff. Check your internet connection and the broker's status page.",
  },
  UPSTREAM_TIMEOUT: {
    means: "The broker did not answer in time. For a read nothing is lost.",
    fix: "Retry after a short wait. If it happens often, ask for less data per call.",
  },
  OUTCOME_UNKNOWN: {
    means: "An order was sent but the broker did not confirm whether it went through. It may or may not exist.",
    fix: "Do not send it again. Check GET /v1/orders (or by client order id) and the broker's own order book first, then decide.",
  },
});

/**
 * The full catalogue, sorted by HTTP status then code.
 * @returns {Array<{ code: string, status: number, title: string, retryable: boolean, retry: string, means: string, fix: string }>}
 */
export function errorCatalogue() {
  return Object.entries(ERROR_CODES)
    .map(([code, spec]) => {
      const g = ERROR_GUIDE[code] ?? { means: "", fix: "" };
      return {
        code,
        status: spec.status,
        title: spec.title,
        retryable: spec.retryable,
        retry: retryAdvice(code, spec),
        means: g.means,
        fix: g.fix,
      };
    })
    .sort((a, b) => a.status - b.status || a.code.localeCompare(b.code));
}

/** One short sentence on whether sending the same request again is safe. */
export function retryAdvice(code, spec = ERROR_CODES[code]) {
  if (!spec) return "";
  if (code === "OUTCOME_UNKNOWN") return "Never retry blindly: check the order book first.";
  if (spec.status === 429) return "Wait for Retry-After, then retry.";
  if (spec.retryable) return "Safe to retry after a short wait.";
  return "Do not retry unchanged: fix the cause first.";
}

/** Codes that exist in errors.mjs but have no words here (the test expects an empty list). */
export function undocumentedCodes() {
  return Object.keys(ERROR_CODES).filter((c) => !ERROR_GUIDE[c]?.means?.trim() || !ERROR_GUIDE[c]?.fix?.trim());
}
