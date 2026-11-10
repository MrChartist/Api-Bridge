# Lot size, tick size and freeze quantity

`GET /xl/instrument`

| | |
|---|---|
| Area | [Spreadsheets](../README.md#spreadsheets) |
| Operation | `xlInstrument` |
| Scope | `read` |
| This computer only | no |
| Guide | [excel-sheets.md](../../guides/excel-sheets.md) |

- An API key with the `read` scope (any key). A read-only key made with --allow-query may also pass `?key=`.

One symbol with one `field` and no `format` gives a bare value (text/plain, `#N/A` on error) for a single cell. Several symbols, several fields or an explicit `format` give a table (symbol, the fields, error).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `symbol` | query | string | yes | One symbol or a comma-separated list. `symbols` is accepted too. |
| `field` | query | string | no | lot, tick, freeze, name or kind; comma-separated for a table. Default all five. |
| `format` | query | one of `csv`, `tsv`, `json` | no | csv (default, CRLF), tsv (tab separated, LF) or json (array of records). Default `"csv"`. |
| `cache` | query | boolean | no | 1 opts in to `Cache-Control: private, max-age=N` (N from `integrations.xl.cacheSeconds`, default 5) and an `ETag`. Default is `no-store`. Default `false`. |
| `errors` | query | one of `200` | no | `200` answers a refusal (wrong key, rate limit, bad request) with HTTP 200 and the same one-row table (`status,code,message,retry_after_s`), whose `status` column still holds the real status. For WEBSERVICE in Excel, which shows #VALUE! for any other HTTP status and so cannot show the reason. Leave it out everywhere else. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | A bare number (text/plain) for one symbol and one field, otherwise a table. | text/csv: string |
| 304 | Only with `?cache=1` and a matching `If-None-Match`. |  |
| 4XX | A one-row table (`status,code,message,retry_after_s`) in the format asked for, with the real status, `Retry-After` and `X-Error-Code`. | text/csv: string |

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
curl -s "http://127.0.0.1:4300/xl/instrument?symbol=NSE:RELIANCE" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/xl/instrument", query={"symbol": "NSE:RELIANCE"})
print(response.body)
```
