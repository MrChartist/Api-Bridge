# Flat option chain table (CSV or JSON records) for Power Query and Sheets

`GET /xl/chain`

| | |
|---|---|
| Area | [Spreadsheets](../README.md#spreadsheets) |
| Operation | `xlChain` |
| Scope | `read` |
| This computer only | no |
| Guide | [excel-sheets.md](../../guides/excel-sheets.md) |

- An API key with the `read` scope (any key). A read-only key made with --allow-query may also pass `?key=`.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `underlying` | query | string | yes |  |
| `expiry` | query | string (date) | yes |  |
| `format` | query | one of `csv`, `json` | no | Default `"csv"`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | One row per strike. | text/csv: string |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

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
curl -s "http://127.0.0.1:4300/xl/chain?underlying=NIFTY&expiry=2026-11-24&format=csv" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "GET",
    "/xl/chain",
    query={"underlying": "NIFTY", "expiry": "2026-11-24", "format": "csv"},
)
print(response.body)
```
