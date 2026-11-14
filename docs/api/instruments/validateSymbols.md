# Check up to 200 symbols in one call

`POST /v1/symbols/validate`

| | |
|---|---|
| Area | [Instruments](../README.md#instruments) |
| Operation | `validateSymbols` |
| Scope | `read` |
| This computer only | no |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- An API key with the `read` scope (any key).

## Request body

Required, `application/json`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `items` | array of object | yes |  |

Example:

```json
{
  "items": [
    {
      "symbol": "NSE:RELIANCE"
    }
  ]
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | One check per item, in order. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `SymbolValidation` | yes |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data` (`SymbolValidation`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `input` | string | yes |  |
| `valid` | boolean | yes |  |
| `symbol` | `Symbol` | no | Canonical Bridge symbol (see the introduction). Inputs may use accepted aliases. |
| `exchange` | `Exchange` | no |  |
| `kind` | `InstrumentKind` | no |  |
| `underlying` | string | no |  |
| `expiry` | string (date) or null (date) | no |  |
| `strike` | number or null | no |  |
| `right` | one of `CE`, `PE`, `null` | no |  |
| `name` | string or null | no |  |
| `lotSize` | integer, min 1 | no |  |
| `tickSize` | number | no |  |
| `freezeQty` | integer or null | no |  |
| `tradable` | boolean | no | False for an index: it can be read but not traded. |
| `tradableNote` | string or null | no |  |
| `normalised` | boolean | no | True when the input was written in an alternative spelling that was rewritten. |
| `rule` | string | no |  |
| `rules` | array of string | no |  |
| `confidence` | one of `exact`, `unique-name` | no |  |
| `code` | one of `SYMBOL_NOT_FOUND`, `AMBIGUOUS_SYMBOL`, `VALIDATION_FAILED` | no | Only when valid is false. |
| `message` | string | no | Only when valid is false. |
| `candidates` | array of `SymbolCandidate` | no | Only when valid is false: the closest or the ambiguous matches. |

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
curl -s -X POST "http://127.0.0.1:4300/v1/symbols/validate" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"items":[{"symbol":"NSE:RELIANCE"}]}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "POST",
    "/v1/symbols/validate",
    body={"items": [{"symbol": "NSE:RELIANCE"}]},
)
print(response.body)
```
