# One order (refreshed from the broker for live orders)

`GET /v1/orders/{orderId}`

| | |
|---|---|
| Area | [Orders](../README.md#orders) |
| Operation | `getOrder` |
| Scope | `read` |
| This computer only | no |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `read` scope (any key).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `orderId` | path | string, up to 64 characters | yes |  |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The order. | application/json: object |
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
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `ORDER_NOT_FOUND` | 404 | no |
| `SESSION_EXPIRED` | 422 | no |
| `RATE_LIMITED` | 429 | yes |
| `UPSTREAM_RATE_LIMITED` | 429 | yes |
| `UPSTREAM_ERROR` | 502 | no |
| `BROKER_UNAVAILABLE` | 503 | yes |
| `UPSTREAM_TIMEOUT` | 504 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/orders/<orderId>" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.order("<orderId>")
print(result)
```
