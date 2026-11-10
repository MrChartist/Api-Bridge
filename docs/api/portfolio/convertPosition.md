# Convert a position between Intraday (MIS) and carry (NRML)

`POST /v1/positions/convert`

| | |
|---|---|
| Area | [Portfolio](../README.md#portfolio) |
| Operation | `convertPosition` |
| Scope | `paper` |
| This computer only | no |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `paper` scope (or `live`).

Paper: moves the quantity to the other product at its average price (no order, no fill, no charge); refused into Intraday after the square-off time, while the kill switch is on, when the other product holds the opposite side, or into a product the contract cannot be traded in (shares to MARGIN, futures and options to CNC or MTF: INVALID_ORDER, as for an order). Live: not supported through the Bridge yet (CAPABILITY_UNSUPPORTED); convert in the broker's app.

## Request body

Required, `application/json`. Send exactly one of: `quantity` or `lots`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `account` | string | yes |  |
| `symbol` | string | yes |  |
| `from` | one of `INTRADAY`, `MARGIN`, `CNC` | yes |  |
| `to` | one of `INTRADAY`, `MARGIN`, `CNC` | yes |  |
| `quantity` | integer, min 1 | no |  |
| `lots` | integer, min 1 | no |  |
| `mode` | one of `paper`, `live` | no |  |

Example:

```json
{
  "account": "demo-paper",
  "symbol": "NSE:RELIANCE",
  "from": "INTRADAY",
  "to": "CNC",
  "quantity": 1
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The conversion. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | object | yes |  |
| `meta` | `Meta` | yes |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `SCOPE_REQUIRED` | 403 | no |
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
curl -s -X POST "http://127.0.0.1:4300/v1/positions/convert" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"account":"demo-paper","symbol":"NSE:RELIANCE","from":"INTRADAY","to":"CNC","quantity":1}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "POST",
    "/v1/positions/convert",
    body={
    "account": "demo-paper",
    "symbol": "NSE:RELIANCE",
    "from": "INTRADAY",
    "to": "CNC",
    "quantity": 1,
},
)
print(response.body)
```
