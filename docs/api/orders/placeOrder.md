# Place an order (paper unless you ask for live)

`POST /v1/orders`

| | |
|---|---|
| Area | [Orders](../README.md#orders) |
| Operation | `placeOrder` |
| Scope | `paper` |
| This computer only | no |
| Idempotency-Key | send one on every write |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `paper` scope (or `live`).
- The example is a paper order on the demo paper account. A live order needs every opt-in in docs/guides/safety.md.
- Send an `Idempotency-Key` (8 to 255 characters); a retry with the same key returns the first result.

Every order passes the safety checks. Live needs a `live` key, an account enabled for live trading in the config
file and `"mode": "live"` in the body; orders from AI assistants also need a `confirmToken` from a human
confirmation. `quantity` is in units and must be a multiple of the lot size; or send `lots`. There is no default
product or order type. MARKET and SL-M orders get market protection (or are refused) as configured.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string, up to 255 characters | no | Your unique id for this write (UUID recommended). A retry with the same key and the same body returns the first result with `Idempotency-Replayed: true`; a different body is refused with 409 IDEMPOTENCY_KEY_REUSED; a retry while the first is still running gets 409 IDEMPOTENCY_IN_PROGRESS. Keys are kept until the end of the IST trading day and at least 24 hours. For POST /v1/orders, `clientOrderId` in the body works the same way when the header is absent. The create routes that are not orders honour it too, with the same rules: keys, accounts, hooks, notify targets, collections (create, import, duplicate), downloads, dataset updates, subscriptions, recordings, recording rules and recording presets. For these the stored answer is kept in memory for 24 hours and is forgotten on restart, and a request that failed is forgotten at once so it can be retried. The compat order routes (`/api/v1/placeorder` and the other order writes) honour it too, and a client that cannot set headers may send `idempotency_key` in the body. Every other write route ignores the header, whatever its value, and says so with `Idempotency-Ignored: true` in the answer; a malformed key is a 400 only on a route that uses it. |

## Request body

Required, `application/json`, schema `OrderRequest`. Send exactly one of: `quantity` or `lots`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `account` | `AccountId` | yes |  |
| `symbol` | `Symbol` | yes | Canonical Bridge symbol (see the introduction). Inputs may use accepted aliases. |
| `side` | one of `BUY`, `SELL` | yes |  |
| `quantity` | integer, min 1 | no | Units; must be a multiple of the lot size. Send this or lots. |
| `lots` | integer, min 1 | no |  |
| `lotSizeConfirmed` | integer, min 1 | no | The lot size (units per lot) the caller has checked; used only when reference lot data is stale or conflicts with the master (preview check LOT_SIZE_STALE). |
| `product` | one of `CNC`, `INTRADAY`, `MARGIN`, `MTF` | yes | No default. `MIS` is read as INTRADAY and `NRML` as MARGIN (case does not matter); the canonical value is in the order and in `meta.normalised`. |
| `orderType` | one of `LIMIT`, `MARKET`, `SL`, `SL-M` | yes | No default. `MKT`, `SLM` and `SL_M` are read too. |
| `price` | number, over 0 | no | Required for LIMIT and SL. |
| `triggerPrice` | number, over 0 | no | Required for SL and SL-M. |
| `validity` | one of `DAY`, `IOC` | no | Default `"DAY"`. |
| `marketProtectionPct` | number, over 0, max 10 | no | For MARKET and SL-M; defaults to the configured value. |
| `disclosedQuantity` | integer, min 0 | no |  |
| `mode` | one of `paper`, `live` | no | Default `"paper"`. |
| `clientOrderId` | `ClientOrderId` | no | Your own id for an order, unique per account per IST day. The Bridge maps it to the broker's shorter tag field itself. |
| `tag` | string | no | Strategy label, kept in the audit log and sent to the broker where supported. |
| `algoId` | string, up to 32 characters | no | Exchange algo id for a registered strategy, where the broker accepts one. |
| `confirmToken` | string | no | From a human confirmation (required for orders prepared by AI assistants). |

Example:

```json
{
  "account": "demo-paper",
  "symbol": "NSE:RELIANCE",
  "side": "BUY",
  "quantity": 1,
  "product": "CNC",
  "orderType": "MARKET",
  "mode": "paper"
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 201 | Accepted by the paper engine or the broker. `status` may still be pending. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 201 answer

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

### Example 201 answer

```json
{
  "data": {
    "orderId": "PAPER-20261110-000001",
    "clientOrderId": null,
    "accountId": "demo-paper",
    "broker": "paper",
    "mode": "paper",
    "symbol": "NSE:RELIANCE",
    "side": "BUY",
    "quantity": 1,
    "filledQuantity": 1,
    "avgPrice": 1459,
    "price": null,
    "triggerPrice": null,
    "orderType": "MARKET",
    "product": "CNC",
    "validity": "DAY",
    "status": "filled",
    "brokerStatus": null,
    "statusMessage": null,
    "legs": [
      {
        "brokerOrderId": null,
        "quantity": 1,
        "status": "filled",
        "error": null
      }
    ],
    "source": "rest",
    "tag": null,
    "placedAt": "2026-11-10T09:46:00.404+05:30",
    "updatedAt": "2026-11-10T09:46:00.404+05:30",
    "warnings": []
  },
  "meta": {
    "requestId": "req_2f8e1a0c4b7d9e3a5c61",
    "accountId": "demo-paper",
    "mode": "paper"
  }
}
```

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
curl -s -X POST "http://127.0.0.1:4300/v1/orders" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-order-0001" \
  -d '{"account":"demo-paper","symbol":"NSE:RELIANCE","side":"BUY","quantity":1,"product":"CNC","orderType":"MARKET","mode":"paper"}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

order = {
    "account": "demo-paper",
    "symbol": "NSE:RELIANCE",
    "side": "BUY",
    "quantity": 1,
    "product": "CNC",
    "orderType": "MARKET",
    "mode": "paper",
}

result = bridge.place_order(order)
print(result)
```
