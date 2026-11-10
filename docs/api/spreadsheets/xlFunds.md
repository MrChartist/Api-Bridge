# Funds, one row per account

`GET /xl/funds`

| | |
|---|---|
| Area | [Spreadsheets](../README.md#spreadsheets) |
| Operation | `xlFunds` |
| Scope | `read` |
| This computer only | no |
| Guide | [excel-sheets.md](../../guides/excel-sheets.md) |

- An API key with the `read` scope (any key). A read-only key made with --allow-query may also pass `?key=`.

Columns are fixed - account, mode, available_cash, used_margin, total_balance, collateral, withdrawable, realised_pnl, unrealised_pnl, as_of, age_s, class, source, stale, error.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `account` | query | string | no | One account id. Without it, every enabled account this key may use; a logged-out broker account has an error row. |
| `mode` | query | one of `paper`, `live` | no |  |
| `limit` | query | integer, min 1, max 5000 | no | Keep the first N rows. When rows are left out the table ends with one visible row (account `(more rows)`, error `SHOWING N OF TOTAL ROWS: ...`) and the reply has `X-Truncated: true` and `X-Total-Rows`. Without it every row is returned. |
| `format` | query | one of `csv`, `tsv`, `json` | no | csv (default, CRLF), tsv (tab separated, LF) or json (array of records). Default `"csv"`. |
| `cache` | query | boolean | no | 1 opts in to `Cache-Control: private, max-age=N` (N from `integrations.xl.cacheSeconds`, default 5) and an `ETag`. Default is `no-store`. Default `false`. |
| `errors` | query | one of `200` | no | `200` answers a refusal (wrong key, rate limit, bad request) with HTTP 200 and the same one-row table (`status,code,message,retry_after_s`), whose `status` column still holds the real status. For WEBSERVICE in Excel, which shows #VALUE! for any other HTTP status and so cannot show the reason. Leave it out everywhere else. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | One row per account. | text/csv: string |
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
curl -s "http://127.0.0.1:4300/xl/funds" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/xl/funds")
print(response.body)
```
