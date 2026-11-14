# Candles as CSV (layout=amibroker matches the shipped AmiBroker import format)

`GET /xl/history`

| | |
|---|---|
| Area | [Spreadsheets](../README.md#spreadsheets) |
| Operation | `xlHistory` |
| Scope | `read` |
| This computer only | no |
| Guide | [excel-sheets.md](../../guides/excel-sheets.md) |

- An API key with the `read` scope (any key). A read-only key made with --allow-query may also pass `?key=`.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `symbol` | query | `Symbol` | yes |  |
| `interval` | query | `Interval` | yes |  |
| `from` | query | string | no |  |
| `to` | query | string | no |  |
| `layout` | query | one of `standard`, `amibroker` | no | Default `"standard"`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | CSV. | text/csv: string |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `SYMBOL_NOT_FOUND` | 404 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/xl/history?symbol=NSE:RELIANCE&interval=5m&layout=standard" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "GET",
    "/xl/history",
    query={"symbol": "NSE:RELIANCE", "interval": "5m", "layout": "standard"},
)
print(response.body)
```
