# Place up to 20 independent orders in one call

`POST /v1/orders/batch`

| | |
|---|---|
| Area | [Orders](../README.md#orders) |
| Operation | `placeOrderBatch` |
| Scope | `paper` |
| This computer only | no |
| Idempotency-Key | send one on every write |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `paper` scope (or `live`).
- Send an `Idempotency-Key` (8 to 255 characters); a retry with the same key returns the first result.

A convenience for alerts that need two legs (a hedge and a main order), not a strategy engine: the legs do not
know about each other and nothing is rolled back. Every leg goes through the same order service as
`POST /v1/orders` (same checks, safety gates, mode and confirmation rules), one after another, and each gets its
own entry in `results`, always in the order sent.

Nothing is hidden. The HTTP status is 201 only when every leg was placed; 207 when at least one leg went out (or
may have, `outcome_unknown`) and at least one did not; 422 when no leg went out. `data.ok`, `data.summary` and
each leg's `status` say the same. Leg `i` uses the request's `Idempotency-Key` plus `:i` as its own key, so a
retry cannot place a leg twice; a retry of the whole request with the same body gets the first answer back. A
batch where nothing went out may be retried with the same key. A live leg needs the key (or its own
`clientOrderId`). With `stopOnError`, legs after the first that did not go out are `skipped`.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string, up to 255 characters | no | Your unique id for this write (UUID recommended). A retry with the same key and the same body returns the first result with `Idempotency-Replayed: true`; a different body is refused with 409 IDEMPOTENCY_KEY_REUSED; a retry while the first is still running gets 409 IDEMPOTENCY_IN_PROGRESS. Keys are kept until the end of the IST trading day and at least 24 hours. For POST /v1/orders, `clientOrderId` in the body works the same way when the header is absent. The create routes that are not orders honour it too, with the same rules: keys, accounts, hooks, notify targets, collections (create, import, duplicate), downloads, dataset updates, subscriptions, recordings, recording rules and recording presets. For these the stored answer is kept in memory for 24 hours and is forgotten on restart, and a request that failed is forgotten at once so it can be retried. The compat order routes (`/api/v1/placeorder` and the other order writes) honour it too, and a client that cannot set headers may send `idempotency_key` in the body. Every other write route ignores the header, whatever its value, and says so with `Idempotency-Ignored: true` in the answer; a malformed key is a 400 only on a route that uses it. |

## Request body

Required, `application/json`, schema `OrderBatchRequest`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `account` | `AccountId` | yes |  |
| `orders` | array of object | yes | Orders as for POST /v1/orders, without `account` (a leg may repeat the batch account, no other). |
| `stopOnError` | boolean | no | Default `false`. |
| `legOrder` | one of `as-sent`, `buys-first` | no | Order of sending. Results stay in the order sent. Default `"as-sent"`. |
| `mode` | one of `paper`, `live` | no | Applies to every leg that does not set its own. |

Example:

```json
{
  "account": "demo-paper",
  "orders": [
    {
      "symbol": "NSE:RELIANCE",
      "side": "BUY",
      "quantity": 1,
      "product": "CNC",
      "orderType": "MARKET"
    },
    {
      "symbol": "NSE:INFY",
      "side": "BUY",
      "quantity": 1,
      "product": "CNC",
      "orderType": "MARKET"
    }
  ],
  "mode": "paper"
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 201 | Every leg was placed. | application/json: object |
| 207 | Some legs were placed (or may have been) and some were not. Read `results`. | application/json: object |
| 422 | No leg went out. The body is the same envelope (`data.ok` false), or a problem for a malformed request. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 201 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `OrderBatchResult` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`OrderBatchResult`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `account` | `AccountId` | yes |  |
| `ok` | boolean | yes | True only when every leg was placed. |
| `summary` | object | yes |  |
| `stopOnError` | boolean | no |  |
| `legOrder` | string | no |  |
| `results` | array of `OrderBatchLeg` | yes |  |
| `replayed` | boolean | no |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | yes |
| `IDEMPOTENCY_KEY_REUSED` | 409 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `SESSION_EXPIRED` | 422 | no |
| `RATE_LIMITED` | 429 | yes |
| `UPSTREAM_RATE_LIMITED` | 429 | yes |
| `UPSTREAM_ERROR` | 502 | no |
| `BROKER_UNAVAILABLE` | 503 | yes |
| `UPSTREAM_TIMEOUT` | 504 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/orders/batch" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-order-0001" \
  -d '{"account":"demo-paper","orders":[{"symbol":"NSE:RELIANCE","side":"BUY","quantity":1,"product":"CNC","orderType":"MARKET"},{"symbol":"NSE:INFY","side":"BUY","quantity":1,"product":"CNC","orderType":"MARKET"}],"mode":"paper"}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "POST",
    "/v1/orders/batch",
    body={
    "account": "demo-paper",
    "orders": [
        {
            "symbol": "NSE:RELIANCE",
            "side": "BUY",
            "quantity": 1,
            "product": "CNC",
            "orderType": "MARKET",
        },
        {
            "symbol": "NSE:INFY",
            "side": "BUY",
            "quantity": 1,
            "product": "CNC",
            "orderType": "MARKET",
        },
    ],
    "mode": "paper",
},
    idempotency_key="my-order-0001",
)
print(response.body)
```
