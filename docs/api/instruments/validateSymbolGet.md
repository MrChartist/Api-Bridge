# Check one symbol (canonical form, lot size, tradable)

`GET /v1/symbols/validate`

| | |
|---|---|
| Area | [Instruments](../README.md#instruments) |
| Operation | `validateSymbolGet` |
| Scope | `read` |
| This computer only | no |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- An API key with the `read` scope (any key).

For a spreadsheet or an alert author: type a symbol, see the exact canonical form the Bridge will use and its lot
size. A symbol the Bridge cannot use is `valid: false` with the reason in `code` and `message`, not an error
response. Only a malformed request is a 4XX.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `symbol` | query | string, up to 64 characters | yes |  |
| `exchange` | query | `Exchange` | no |  |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The check. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `SymbolValidation` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`SymbolValidation`)

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
curl -s "http://127.0.0.1:4300/v1/symbols/validate?symbol=NSE:RELIANCE" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/symbols/validate", query={"symbol": "NSE:RELIANCE"})
print(response.body)
```
