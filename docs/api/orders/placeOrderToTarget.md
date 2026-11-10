# Place only the order that gets a position to a target size

`POST /v1/orders/to-target`

| | |
|---|---|
| Area | [Orders](../README.md#orders) |
| Operation | `placeOrderToTarget` |
| Scope | `paper` |
| This computer only | no |
| Idempotency-Key | send one on every write |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `paper` scope (or `live`).
- Send an `Idempotency-Key` (8 to 255 characters); a retry with the same key returns the first result.

"Be long 3 lots", "be flat", "be short 50 shares", the way a strategy alert says it. The Bridge reads the current
position (this symbol, this product), works out the difference and places only that, through the same order
service as `POST /v1/orders`: the same safety gates, price checks, mode rules, confirmation rules and
idempotency. Paper unless you send `"mode": "live"`.

A position that cannot be read, or cannot be matched with certainty, is `POSITION_UNKNOWN` (503, safe to retry)
and nothing is placed: unknown is never treated as flat. Live delivery (CNC, MTF) that shows in both today's
positions and the holdings is also `POSITION_UNKNOWN`. An open order of the Bridge in the same symbol and product that
can change the position is `STATE_CONFLICT` unless you send `"openOrders": "ignore"` (a resting stop does not
count). `action` `NONE` places nothing and answers 200. With `dryRun` everything is worked out and checked
(the `preview` is the same result as `POST /v1/orders/preview`) and nothing is placed.

The `Idempotency-Key` (or `clientOrderId`) covers the whole request: a retry with the same body gets the first
answer back, including "nothing to do". Two requests for one symbol and product are handled one at a time.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string, up to 255 characters | no | Your unique id for this write (UUID recommended). A retry with the same key and the same body returns the first result with `Idempotency-Replayed: true`; a different body is refused with 409 IDEMPOTENCY_KEY_REUSED; a retry while the first is still running gets 409 IDEMPOTENCY_IN_PROGRESS. Keys are kept until the end of the IST trading day and at least 24 hours. For POST /v1/orders, `clientOrderId` in the body works the same way when the header is absent. The create routes that are not orders honour it too, with the same rules: keys, accounts, hooks, notify targets, collections (create, import, duplicate), downloads, dataset updates, subscriptions, recordings, recording rules and recording presets. For these the stored answer is kept in memory for 24 hours and is forgotten on restart, and a request that failed is forgotten at once so it can be retried. Every other write route ignores the header and says so with `Idempotency-Ignored: true` in the answer. |

## Request body

Required, `application/json`, schema `TargetOrderRequest`. Send exactly one of: `targetQuantity` or `targetLots`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `account` | `AccountId` | yes |  |
| `symbol` | `Symbol` | yes | Canonical Bridge symbol (see the introduction). Inputs may use accepted aliases. |
| `targetQuantity` | integer, min -100000000, max 100000000 | no | Signed units: 100 long, 0 flat, -50 short. Send this or targetLots. |
| `targetLots` | integer, min -100000, max 100000 | no | Signed lots. |
| `product` | one of `CNC`, `INTRADAY`, `MARGIN`, `MTF` | yes | MIS and NRML are read as INTRADAY and MARGIN. The position is read for this product. |
| `orderType` | one of `LIMIT`, `MARKET`, `SL`, `SL-M` | yes |  |
| `price` | number, over 0 | no |  |
| `triggerPrice` | number, over 0 | no |  |
| `validity` | one of `DAY`, `IOC` | no |  |
| `marketProtectionPct` | number, over 0, max 10 | no |  |
| `mode` | one of `paper`, `live` | no | Default `"paper"`. |
| `clientOrderId` | `ClientOrderId` | no | Your own id for an order, unique per account per IST day. The Bridge maps it to the broker's shorter tag field itself. |
| `tag` | string | no |  |
| `algoId` | string, up to 32 characters | no |  |
| `confirmToken` | string | no |  |
| `dryRun` | boolean | no | Work everything out and run the checks; place nothing. Default `false`. |
| `openOrders` | one of `refuse`, `ignore` | no | refuse: an open order of the Bridge in this symbol and product that can change the position is STATE_CONFLICT (a resting SL or SL-M order does not count). ignore: size against the position only. Default `"refuse"`. |

Example:

```json
{
  "account": "demo-paper",
  "symbol": "NSE:RELIANCE",
  "targetQuantity": -100000000,
  "product": "CNC",
  "orderType": "MARKET"
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Nothing to place (`action` NONE), or a dry run. | application/json: object |
| 201 | The difference was placed. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `TargetOrderResult` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`TargetOrderResult`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `account` | `AccountId` | yes |  |
| `symbol` | `Symbol` | yes | Canonical Bridge symbol (see the introduction). Inputs may use accepted aliases. |
| `product` | one of `CNC`, `INTRADAY`, `MARGIN`, `MTF` | yes |  |
| `mode` | one of `paper`, `live` | yes |  |
| `lotSize` | integer | no |  |
| `currentQuantity` | integer | yes | Signed units held now in this symbol and product. |
| `targetQuantity` | integer | yes |  |
| `delta` | integer | yes | targetQuantity minus currentQuantity. |
| `action` | one of `BUY`, `SELL`, `NONE` | yes |  |
| `dryRun` | boolean | yes |  |
| `placed` | boolean | yes |  |
| `order` | `OrderResult` or null | yes |  |
| `preview` | `PreviewResult` or null | no | With dryRun when an order would be needed. |
| `otherProducts` | array of object | no | Positions in this symbol in other products. Reported, never added to currentQuantity. |
| `openOrders` | array of object | no | Open orders of the Bridge in this symbol and product. |
| `positionFreshness` | `Freshness` or null | no |  |
| `replayed` | boolean | no | True when this is the first answer returned again for the same idempotency key. |

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
curl -s -X POST "http://127.0.0.1:4300/v1/orders/to-target" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-order-0001" \
  -d '{"account":"demo-paper","symbol":"NSE:RELIANCE","targetQuantity":-100000000,"product":"CNC","orderType":"MARKET"}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "POST",
    "/v1/orders/to-target",
    body={
    "account": "demo-paper",
    "symbol": "NSE:RELIANCE",
    "targetQuantity": -100000000,
    "product": "CNC",
    "orderType": "MARKET",
},
    idempotency_key="my-order-0001",
)
print(response.body)
```
