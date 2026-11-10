# Orders as one table, newest first

`GET /xl/orders`

| | |
|---|---|
| Area | [Spreadsheets](../README.md#spreadsheets) |
| Operation | `xlOrders` |
| Scope | `read` |
| This computer only | no |
| Guide | [excel-sheets.md](../../guides/excel-sheets.md) |

- An API key with the `read` scope (any key). A read-only key made with --allow-query may also pass `?key=`.

Columns are fixed - account, mode, order_id, client_order_id, symbol, side, product, order_type, qty, filled_qty, avg_price, price, trigger_price, status, status_message, placed_at, updated_at (IST), then as_of, age_s, class, source, stale, error. `X-Truncated: true` when more orders exist than `limit`. This route only reads; placing and changing orders stays on /v1/orders.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `account` | query | string | no | One account id. Without it, every enabled account this key may use; a logged-out broker account has an error row. |
| `status` | query | one of `pending`, `open`, `trigger_pending`, `partially_filled`, `filled`, `cancelled`, `rejected`, `expired`, ... | no |  |
| `mode` | query | one of `paper`, `live` | no |  |
| `limit` | query | integer, min 1, max 500 | no | Default `200`. |
| `format` | query | one of `csv`, `tsv`, `json` | no | csv (default, CRLF), tsv (tab separated, LF) or json (array of records). Default `"csv"`. |
| `cache` | query | boolean | no | 1 opts in to `Cache-Control: private, max-age=N` (N from `integrations.xl.cacheSeconds`, default 5) and an `ETag`. Default is `no-store`. Default `false`. |
| `errors` | query | one of `200` | no | `200` answers a refusal (wrong key, rate limit, bad request) with HTTP 200 and the same one-row table (`status,code,message,retry_after_s`), whose `status` column still holds the real status. For WEBSERVICE in Excel, which shows #VALUE! for any other HTTP status and so cannot show the reason. Leave it out everywhere else. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | One row per order. | text/csv: string |
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
curl -s "http://127.0.0.1:4300/xl/orders" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/xl/orders")
print(response.body)
```
