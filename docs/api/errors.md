# Error codes

Every error is `application/problem+json` with `code`, `status`, `detail`, `retryable` and `requestId`. The `code` is stable (codes are added, never renamed); `detail` is for people. `retryable` answers one question: is it safe to send exactly this request again? A write whose outcome is unknown is never retryable: check the order book first.

Rate-limit refusals (429) also say whose limit was hit: `scope` (`client`, `upstream`, `queue`, `consumer-cap`), `retryAfterMs` and `limit`. Read those fields, not `detail`. See [rate-limits.md](../guides/rate-limits.md).

Generated from `server/bridge/core/errors.mjs`.

| Code | HTTP | Retryable | Meaning |
|---|---|---|---|
| `INVALID_JSON` | 400 | no | The request body is not valid JSON |
| `VALIDATION_FAILED` | 400 | no | The request is not valid |
| `UNAUTHENTICATED` | 401 | no | A valid API key is required |
| `ACCOUNT_FORBIDDEN` | 403 | no | This API key may not use this account |
| `CANNOT_TRADE` | 403 | no | This account cannot trade right now (trading readiness) |
| `DAILY_LIMIT_REACHED` | 403 | no | A daily safety limit has been reached |
| `HOST_NOT_ALLOWED` | 403 | no | Requests must be addressed to an allowed host name |
| `LOOPBACK_ONLY` | 403 | no | This action is only available from this computer |
| `MARKET_CLOSED` | 403 | no | The market is closed for this instrument |
| `ORDER_GATE_CLOSED` | 403 | no | The live order gate refused this order. No order was sent |
| `ORIGIN_NOT_ALLOWED` | 403 | no | This web page origin is not on the allowlist |
| `PAPER_ONLY` | 403 | no | Live trading is not enabled for this account |
| `SCOPE_REQUIRED` | 403 | no | This API key does not have the scope this action needs |
| `ACCOUNT_NOT_FOUND` | 404 | no | No account with this id |
| `NOT_FOUND` | 404 | no | Not found |
| `ORDER_NOT_FOUND` | 404 | no | No order with this id |
| `SYMBOL_NOT_FOUND` | 404 | no | The symbol could not be resolved |
| `METHOD_NOT_ALLOWED` | 405 | no | Method not allowed |
| `DUPLICATE_CLIENT_ORDER_ID` | 409 | no | This clientOrderId was already used |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | yes | A request with this idempotency key is still running |
| `IDEMPOTENCY_KEY_REUSED` | 409 | no | This idempotency key was already used with different parameters |
| `STATE_CONFLICT` | 409 | yes | The item changed or is busy; read it again |
| `PAYLOAD_TOO_LARGE` | 413 | no | The request body is too large |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no | Send the body as application/json |
| `CAPABILITY_UNSUPPORTED` | 422 | no | This broker does not support this request |
| `CONFIRMATION_REQUIRED` | 422 | no | This order needs a human confirmation first |
| `INVALID_ORDER` | 422 | no | The order failed a pre-trade check |
| `SESSION_EXPIRED` | 422 | no | The broker session has expired. Log in again |
| `KILL_SWITCH_ACTIVE` | 423 | no | The kill switch is on. No orders are being sent |
| `ORDER_RATE_LIMITED` | 429 | yes | Order rate cap for this account reached |
| `RATE_LIMITED` | 429 | yes | Too many requests from this API key |
| `SUBSCRIPTION_LIMIT` | 429 | no | The broker feed subscription limit was reached |
| `UPSTREAM_RATE_LIMITED` | 429 | yes | The broker's rate limit was reached |
| `INTERNAL` | 500 | no | Internal error |
| `NOT_IMPLEMENTED` | 501 | no | This part of the Bridge is not built yet |
| `UPSTREAM_ERROR` | 502 | no | The broker returned an error |
| `BROKER_UNAVAILABLE` | 503 | yes | The broker is not reachable right now |
| `OUTCOME_UNKNOWN` | 504 | no | The order outcome is unknown. Check the order book before sending it again |
| `UPSTREAM_TIMEOUT` | 504 | yes | The broker did not respond in time |
