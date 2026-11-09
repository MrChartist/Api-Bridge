# Convert one symbol between formats

`GET /v1/symbols/convert`

| | |
|---|---|
| Area | [Instruments](../README.md#instruments) |
| Operation | `convertSymbolGet` |
| Scope | `read` |
| This computer only | no |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- An API key with the `read` scope (any key).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `input` | query | string, up to 64 characters | yes |  |
| `from` | query | `SymbolFormatName` | no |  |
| `exchange` | query | string, up to 12 characters | no | Needed for compact and broker trading symbols. |
| `broker` | query | string | no | Needed when `from` is `broker`, and to include that broker's native alias. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Canonical form and aliases. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `ConvertResult` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`ConvertResult`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `input` | string | yes |  |
| `canonical` | `Symbol` | yes | Canonical Bridge symbol (see the introduction). Inputs may use accepted aliases. |
| `aliases` | object | yes | chart (chart ticker such as NSE:NIFTY1!), compact (symbol and exchange) and, when a broker is given or connected, broker:<id>. |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `SESSION_EXPIRED` | 422 | no |
| `RATE_LIMITED` | 429 | yes |
| `UPSTREAM_RATE_LIMITED` | 429 | yes |
| `UPSTREAM_ERROR` | 502 | no |
| `BROKER_UNAVAILABLE` | 503 | yes |
| `UPSTREAM_TIMEOUT` | 504 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/symbols/convert?input=NSE:RELIANCE" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.convert_symbol("NSE:RELIANCE")
print(result)
```
