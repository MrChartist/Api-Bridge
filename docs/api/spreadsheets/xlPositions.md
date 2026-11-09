# Positions of every account the key may use, as one table

`GET /xl/positions`

| | |
|---|---|
| Area | [Spreadsheets](../README.md#spreadsheets) |
| Operation | `xlPositions` |
| Scope | `read` |
| This computer only | no |
| Guide | [excel-sheets.md](../../guides/excel-sheets.md) |

- An API key with the `read` scope (any key). A read-only key made with --allow-query may also pass `?key=`.

Columns are fixed - account, mode, symbol, product, qty, avg_price, ltp, pnl, realised_pnl, unrealised_pnl, as_of, age_s, class, source, stale, error. An account that cannot answer gives one row with its name and an `error` text; the others are unaffected. Read-only.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `account` | query | string | no | One account id. Without it, every account this key may use that can answer (paper, and logged-in broker accounts). |
| `open` | query | boolean | no | 1 hides closed positions (quantity 0). |
| `mode` | query | one of `paper`, `live` | no |  |
| `format` | query | one of `csv`, `tsv`, `json` | no | csv (default, CRLF), tsv (tab separated, LF) or json (array of records). Default `"csv"`. |
| `cache` | query | boolean | no | 1 opts in to `Cache-Control: private, max-age=N` (N from `integrations.xl.cacheSeconds`, default 5) and an `ETag`. Default is `no-store`. Default `false`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | One row per position. | text/csv: string |
| 304 | Only with `?cache=1` and a matching `If-None-Match`. |  |
| 4XX | A one-row table (`status,code,message,retry_after_s`) in the format asked for, with the real status, `Retry-After` and `X-Error-Code`. | text/csv: string |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `ACCOUNT_FORBIDDEN` | 403 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/xl/positions" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/xl/positions")
print(response.body)
```
