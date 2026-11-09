# Margin for up to 50 prospective positions (read only)

`POST /v1/margin/basket`

| | |
|---|---|
| Area | [Portfolio](../README.md#portfolio) |
| Operation | `marginBasket` |
| Scope | `read` |
| This computer only | no |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `read` scope (any key).

What the positions would need together, before anything is placed. `source` says where the figure came from:
`broker` (the broker's own calculator, for an adapter that has one; no shipped adapter does yet) or
`paper-model` (the paper engine's approximate portfolio model: not the exchange's SPAN, and hedges between the
legs are counted). All figures are JSON numbers in rupees. Nothing is stored and no order is created. The same
calculation answers the compat-style `margin` call.

## Request body

Required, `application/json`, schema `MarginBasketRequest`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `account` | `AccountId` | no |  |
| `positions` | array of object | yes |  |

Example:

```json
{
  "positions": [
    {
      "symbol": "NSE:RELIANCE",
      "side": "BUY"
    }
  ]
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The basket's margin. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `MarginBasket` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`MarginBasket`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `total` | number | yes | Rupees, for the basket on its own with hedges between its legs counted. |
| `span` | number or null | no |  |
| `exposure` | number or null | no |  |
| `hedgeBenefit` | number or null | no | What the legs would need alone, minus total. |
| `source` | one of `broker`, `paper-model` | yes |  |
| `account` | `AccountId` | yes |  |
| `legs` | integer | yes |  |
| `asOf` | string (date-time) | yes |  |
| `note` | string or null | no | Says plainly when the figure is the approximate paper model, and why. |
| `model` | string or null | no |  |
| `method` | string or null | no |  |
| `breakdown` | object or null | no | paper-model only: premium, span, exposure, calendar, elm. |
| `fallback` | array of string | no | paper-model only: underlyings margined by the simple per-leg rule because no price was available. |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
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
curl -s -X POST "http://127.0.0.1:4300/v1/margin/basket" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"positions":[{"symbol":"NSE:RELIANCE","side":"BUY"}]}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "POST",
    "/v1/margin/basket",
    body={"positions": [{"symbol": "NSE:RELIANCE", "side": "BUY"}]},
)
print(response.body)
```
