# Check an order without sending it

`POST /v1/orders/preview`

| | |
|---|---|
| Area | [Orders](../README.md#orders) |
| Operation | `previewOrder` |
| Scope | `paper` |
| This computer only | no |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `paper` scope (or `live`).
- The example is a paper order on the demo paper account. A live order needs every opt-in in docs/guides/safety.md.

Resolves the symbol and lot size, runs every safety check, and returns warnings and the estimated value. When a human must confirm (orders from AI assistants, or hooks set to require it), it opens a ticket that you confirm in the dashboard (Orders, Pending confirmations); the confirmation yields the `confirmToken` that `POST /v1/orders` needs.

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
| 200 | Preview. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `PreviewResult` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`PreviewResult`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `ok` | boolean | yes |  |
| `mode` | one of `paper`, `live` | yes |  |
| `checks` | array of `Check` | yes |  |
| `margin` | object or null | no | The margin this order would block. Paper orders (a paper account, or any account in paper mode): the paper engine's own model on the exposure the order adds (a quantity that closes a held position blocks nothing), the same figure its fill will use. Live orders: null (the broker decides). Each leg of a basket is sized alone, with no hedge benefit. |
| `resolved` | `Instrument` or null | no |  |
| `quantity` | integer or null | no |  |
| `estimatedValue` | number or null | no |  |
| `ltp` | number or null | no |  |
| `confirmToken` | string or null | no |  |
| `confirmExpiresAt` | string (date-time) or null (date-time) | no |  |
| `requiresHumanConfirmation` | boolean | yes |  |
| `ticketId` | string or null | no | Set when a human must confirm; the ticket appears in GET /v1/tickets (the dashboard's Pending confirmations panel). |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `CANNOT_TRADE` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `INVALID_ORDER` | 422 | no |
| `SESSION_EXPIRED` | 422 | no |
| `RATE_LIMITED` | 429 | yes |
| `UPSTREAM_RATE_LIMITED` | 429 | yes |
| `UPSTREAM_ERROR` | 502 | no |
| `BROKER_UNAVAILABLE` | 503 | yes |
| `UPSTREAM_TIMEOUT` | 504 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/orders/preview" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
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

result = bridge.preview_order(order)
print(result)
```
