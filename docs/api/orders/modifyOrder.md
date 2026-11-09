# Modify an open order

`PATCH /v1/orders/{orderId}`

| | |
|---|---|
| Area | [Orders](../README.md#orders) |
| Operation | `modifyOrder` |
| Scope | `paper` |
| This computer only | no |
| Idempotency-Key | send one on every write |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `paper` scope (or `live`).
- Send an `Idempotency-Key` (8 to 255 characters); a retry with the same key returns the first result.

Counts towards the order-rate cap. Brokers limit modifications per order (for example 25); after that, cancel and place again.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `orderId` | path | string, up to 64 characters | yes |  |
| `Idempotency-Key` | header | string, up to 255 characters | no | Your unique id for this write (UUID recommended). A retry with the same key and the same body returns the first result with `Idempotency-Replayed: true`; a different body is refused with 409 IDEMPOTENCY_KEY_REUSED; a retry while the first is still running gets 409 IDEMPOTENCY_IN_PROGRESS. Keys are kept until the end of the IST trading day and at least 24 hours. For POST /v1/orders, `clientOrderId` in the body works the same way when the header is absent. |

## Request body

Required, `application/json`, schema `OrderChanges`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `quantity` | integer, min 1 | no |  |
| `price` | number, over 0 | no |  |
| `triggerPrice` | number, over 0 | no |  |
| `orderType` | one of `LIMIT`, `MARKET`, `SL`, `SL-M` | no |  |
| `validity` | one of `DAY`, `IOC` | no |  |

Example:

```json
{
  "price": 1400
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The order after the change was accepted. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `OrderResult` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`OrderResult`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `orderId` | string | yes | Bridge id: ord_... for live, PAPER-... for paper. |
| `clientOrderId` | string or null | no |  |
| `accountId` | `AccountId` | yes |  |
| `broker` | string | yes |  |
| `mode` | one of `paper`, `live` | yes |  |
| `symbol` | `Symbol` | yes | Canonical Bridge symbol (see the introduction). Inputs may use accepted aliases. |
| `side` | one of `BUY`, `SELL` | yes |  |
| `quantity` | integer | yes |  |
| `filledQuantity` | integer | yes |  |
| `avgPrice` | number or null | no |  |
| `price` | number or null | no |  |
| `triggerPrice` | number or null | no |  |
| `orderType` | one of `LIMIT`, `MARKET`, `SL`, `SL-M` | yes |  |
| `product` | one of `CNC`, `INTRADAY`, `MARGIN`, `MTF` | yes |  |
| `validity` | one of `DAY`, `IOC` | no |  |
| `status` | `OrderStatus` | yes |  |
| `brokerStatus` | string or null | no | The broker's own status text. |
| `statusMessage` | string or null | no |  |
| `legs` | array of `OrderLeg` | yes | One leg per broker order (orders above the freeze quantity are sliced). |
| `source` | one of `rest`, `webhook`, `mcp`, `cli`, `system` | no | "system" is used for automatic intraday square-off of paper positions. |
| `tag` | string or null | no |  |
| `placedAt` | string (date-time) | yes |  |
| `updatedAt` | string (date-time) | yes |  |

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
| `ORDER_NOT_FOUND` | 404 | no |
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
curl -s -X PATCH "http://127.0.0.1:4300/v1/orders/<orderId>" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-order-0001" \
  -d '{"price":1400}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.modify_order("<orderId>", {"price": 1400})
print(result)
```
