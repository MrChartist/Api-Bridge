# Orders (newest first)

`GET /v1/orders`

| | |
|---|---|
| Area | [Orders](../README.md#orders) |
| Operation | `listOrders` |
| Scope | `read` |
| This computer only | no |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `read` scope (any key).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `account` | query | `AccountId` | no | Pin the request to this account. Without it, market data may be served from any of your accounts that allow pooling. |
| `mode` | query | one of `paper`, `live` | no | `paper` reads the account's paper book; `live` the broker's (default for portfolio reads). Default `"live"`. |
| `status` | query | `OrderStatus` | no |  |
| `limit` | query | integer, min 1, max 500 | no | Default `100`. |
| `cursor` | query | string, up to 512 characters | no | Opaque cursor from `meta.nextCursor`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | A page of orders. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `OrderResult` | yes |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data` (`OrderResult`)

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
| `ACCOUNT_FORBIDDEN` | 403 | no |
| `SESSION_EXPIRED` | 422 | no |
| `RATE_LIMITED` | 429 | yes |
| `UPSTREAM_RATE_LIMITED` | 429 | yes |
| `UPSTREAM_ERROR` | 502 | no |
| `BROKER_UNAVAILABLE` | 503 | yes |
| `UPSTREAM_TIMEOUT` | 504 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/orders?limit=20" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.orders(account="demo-paper", limit=20)
print(result)
```
