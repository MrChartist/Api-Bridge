# Resolve one instrument (lot size, tick size, freeze quantity)

`GET /v1/instruments/{symbol}`

| | |
|---|---|
| Area | [Instruments](../README.md#instruments) |
| Operation | `getInstrument` |
| Scope | `read` |
| This computer only | no |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- An API key with the `read` scope (any key).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `symbol` | path | string, up to 64 characters | yes | Any accepted symbol form; URL-encode it. |
| `include` | query | one of `refs` | no | `refs` adds each broker's native token and trading symbol. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The instrument. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `Instrument` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`Instrument`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `symbol` | `Symbol` | yes | Canonical Bridge symbol (see the introduction). Inputs may use accepted aliases. |
| `exchange` | `Exchange` | yes |  |
| `kind` | `InstrumentKind` | yes |  |
| `underlying` | string | yes |  |
| `name` | string or null | no |  |
| `expiry` | string (date) or null (date) | no |  |
| `strike` | number or null | no |  |
| `right` | one of `CE`, `PE`, `null` | no |  |
| `lotSize` | integer, min 1 | yes |  |
| `tickSize` | number, over 0 | yes |  |
| `freezeQty` | integer or null | no |  |
| `freezeQtySource` | one of `master`, `exchange-list`, `null` | no | Where freezeQty came from. "exchange-list" is the Bridge's dated list and is marked needs-verification. |
| `isin` | string or null | no |  |
| `refs` | object | no | Present with include=refs. Keyed by broker id. |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `SYMBOL_NOT_FOUND` | 404 | no |
| `SESSION_EXPIRED` | 422 | no |
| `RATE_LIMITED` | 429 | yes |
| `UPSTREAM_RATE_LIMITED` | 429 | yes |
| `UPSTREAM_ERROR` | 502 | no |
| `BROKER_UNAVAILABLE` | 503 | yes |
| `UPSTREAM_TIMEOUT` | 504 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/instruments/NSE:RELIANCE" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.instrument("NSE:RELIANCE")
print(result)
```
