# Margin of a basket against the paper book (approximate, nothing is placed)

`POST /v1/paper/accounts/{accountId}/margin`

| | |
|---|---|
| Area | [Paper](../README.md#paper) |
| Operation | `paperBasketMargin` |
| Scope | `read` |
| This computer only | no |
| Guide | [paper-margin.md](../../guides/paper-margin.md) |

- An API key with the `read` scope (any key).

Portfolio model (server/bridge/calc/span-margin.js): approximate, not the exchange's SPAN. Per underlying, a 16-scenario price and volatility scan, plus exposure margin, a calendar charge across expiries and expiry-day ELM. Without an underlying price the legs fall back to the simple per-leg model and are listed in `fallback`.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `accountId` | path | `AccountId` | yes |  |

## Request body

Required, `application/json`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `legs` | array of object | yes |  |

Example:

```json
{
  "legs": [
    {
      "symbol": "NSE:RELIANCE",
      "side": "BUY",
      "quantity": 1
    }
  ]
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Margin before and after the basket, the basket alone and each leg on its own. | application/json: object |
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
| `model` | one of `portfolio`, `simple` | yes |  |
| `before` | number | yes |  |
| `after` | number | yes |  |
| `change` | number | yes |  |
| `alone` | number | yes |  |
| `standalone` | number | yes | Each leg margined on its own |
| `breakdown` | object | no |  |
| `forwards` | object | no |  |
| `fallback` | array of string | no |  |
| `available` | number | no |  |
| `method` | string | yes |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `ACCOUNT_FORBIDDEN` | 403 | no |
| `ACCOUNT_NOT_FOUND` | 404 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/paper/accounts/demo-paper/margin" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"legs":[{"symbol":"NSE:RELIANCE","side":"BUY","quantity":1}]}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "POST",
    "/v1/paper/accounts/demo-paper/margin",
    body={"legs": [{"symbol": "NSE:RELIANCE", "side": "BUY", "quantity": 1}]},
)
print(response.body)
```
