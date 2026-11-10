# Cancel every open order for an account (or all accounts this key may use)

`POST /v1/orders/cancel-all`

| | |
|---|---|
| Area | [Orders](../README.md#orders) |
| Operation | `cancelAllOrders` |
| Scope | `paper` |
| This computer only | no |
| Idempotency-Key | send one on every write |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `paper` scope (or `live`).
- Send an `Idempotency-Key` (8 to 255 characters); a retry with the same key returns the first result.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string, up to 255 characters | no | Your unique id for this write (UUID recommended). A retry with the same key and the same body returns the first result with `Idempotency-Replayed: true`; a different body is refused with 409 IDEMPOTENCY_KEY_REUSED; a retry while the first is still running gets 409 IDEMPOTENCY_IN_PROGRESS. Keys are kept until the end of the IST trading day and at least 24 hours. For POST /v1/orders, `clientOrderId` in the body works the same way when the header is absent. The create routes that are not orders honour it too, with the same rules: keys, accounts, hooks, notify targets, collections (create, import, duplicate), downloads, dataset updates, subscriptions, recordings, recording rules and recording presets. For these the stored answer is kept in memory for 24 hours and is forgotten on restart, and a request that failed is forgotten at once so it can be retried. Every other write route ignores the header and says so with `Idempotency-Ignored: true` in the answer. |

## Request body

Required, `application/json`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `account` | `AccountId` | no |  |
| `mode` | one of `paper`, `live` | no |  |
| `bridgeOnly` | boolean | no | Leave live orders placed outside the Bridge (in the broker's app or terminal) open. The dashboard's Cancel all sends true unless you tick the box to cancel those too. Default `false`. |
| `dryRun` | boolean | no | Cancel nothing; list what is open in each group (bridge.open, external.open). Default `false`. |

Example:

```json
{
  "account": "demo-paper",
  "mode": "paper"
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | What was cancelled, in two groups. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | object | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data`

| Field | Type | Required | Notes |
|---|---|---|---|
| `cancelled` | array of string | yes | Every order cancelled (both groups). |
| `failed` | array of `ItemError` | yes |  |
| `dryRun` | boolean | no |  |
| `bridge` | object | yes | Orders the Bridge placed (paper and live). |
| `external` | object | yes | Live orders placed outside the Bridge (broker order ids). |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `CANNOT_TRADE` | 403 | no |
| `DAILY_LIMIT_REACHED` | 403 | no |
| `MARKET_CLOSED` | 403 | no |
| `ORDER_GATE_CLOSED` | 403 | no |
| `PAPER_ONLY` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `DUPLICATE_CLIENT_ORDER_ID` | 409 | no |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | yes |
| `IDEMPOTENCY_KEY_REUSED` | 409 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `CONFIRMATION_REQUIRED` | 422 | no |
| `INVALID_ORDER` | 422 | no |
| `SESSION_EXPIRED` | 422 | no |
| `KILL_SWITCH_ACTIVE` | 423 | no |
| `ORDER_RATE_LIMITED` | 429 | yes |
| `RATE_LIMITED` | 429 | yes |
| `UPSTREAM_RATE_LIMITED` | 429 | yes |
| `UPSTREAM_ERROR` | 502 | no |
| `BROKER_UNAVAILABLE` | 503 | yes |
| `OUTCOME_UNKNOWN` | 504 | no |
| `UPSTREAM_TIMEOUT` | 504 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/orders/cancel-all" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-order-0001" \
  -d '{"account":"demo-paper","mode":"paper"}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.cancel_all_orders(account="demo-paper", mode="paper")
print(result)
```
