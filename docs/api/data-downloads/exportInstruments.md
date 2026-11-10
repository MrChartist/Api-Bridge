# The instrument master as a CSV or JSONL file

`GET /v1/instruments/export`

| | |
|---|---|
| Area | [Data downloads](../README.md#data-downloads) |
| Operation | `exportInstruments` |
| Scope | `read` |
| This computer only | no |

- An API key with the `read` scope (any key).

Streams every instrument the connected brokers' masters hold (symbol, exchange, kind, underlying, name, expiry, strike, right, lot size, tick size, freeze quantity, ISIN), optionally for one exchange or kind. It reads the master the Bridge already loaded; it makes no broker call.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `exchange` | query | one of `NSE`, `BSE`, `NFO`, `BFO`, `MCX`, `CDS` | no |  |
| `kind` | query | one of `INDEX`, `EQ`, `FUT`, `OPT` | no |  |
| `format` | query | one of `csv`, `jsonl` | no | Default `"csv"`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The file, streamed. | text/csv: string (binary) |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/instruments/export" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/instruments/export")
print(response.body)
```
