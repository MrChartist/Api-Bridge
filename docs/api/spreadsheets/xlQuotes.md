# Prices for a whole sheet as one table (one request, one row per symbol)

`GET /xl/quotes`

| | |
|---|---|
| Area | [Spreadsheets](../README.md#spreadsheets) |
| Operation | `xlQuotes` |
| Scope | `read` |
| This computer only | no |
| Guide | [excel-sheets.md](../../guides/excel-sheets.md) |

- An API key with the `read` scope (any key). A read-only key made with --allow-query may also pass `?key=`.

`symbols` is a comma-separated list (at most `integrations.xl.maxSymbols`, default 100); one row per symbol in the order asked, duplicates included. A symbol that cannot be priced gets blank values and a text in `error`; it never fails the table. Every row carries `as_of` (IST), `age_s`, `class`, `source` and `stale`; in demo mode also `demo` = DEMO. Prices never come from a backup data source (`?backup=true` is refused).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `symbols` | query | string | no | Comma-separated Bridge symbols, for example NSE:RELIANCE,NSE:NIFTY. `symbol` is accepted too and may repeat. Give `symbols` or `collection`. |
| `collection` | query | string, up to 64 characters | no | A collection name from `GET /v1/collections` instead of `symbols`. An option universe is worked out at the time of the request from a live price; a price that is not live is refused. The collection must resolve to at most `integrations.xl.maxSymbols` symbols. Response headers `X-Collection-Resolved-At`, `X-Collection-Atm-Source`, `X-Collection-Rule` and (when there are any) `X-Collection-Warnings` say when and how. |
| `fields` | query | string | no | Value columns in the order wanted (default ltp,chg,pct,volume). Freshness columns are always added. |
| `format` | query | one of `csv`, `tsv`, `json` | no | csv (default, CRLF), tsv (tab separated, LF) or json (array of records). Default `"csv"`. |
| `cache` | query | boolean | no | 1 opts in to `Cache-Control: private, max-age=N` (N from `integrations.xl.cacheSeconds`, default 5) and an `ETag`. Default is `no-store`. Default `false`. |
| `errors` | query | one of `200` | no | `200` answers a refusal (wrong key, rate limit, bad request) with HTTP 200 and the same one-row table (`status,code,message,retry_after_s`), whose `status` column still holds the real status. For WEBSERVICE in Excel, which shows #VALUE! for any other HTTP status and so cannot show the reason. Leave it out everywhere else. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | One row per requested symbol. Columns - symbol, then the requested fields (ltp open high low close chg pct volume oi bid ask), then as_of age_s class source stale, then error (and demo in demo mode). | text/csv: string |
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
curl -s "http://127.0.0.1:4300/xl/quotes?symbols=NSE:RELIANCE,NSE:NIFTY" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/xl/quotes", query={"symbols": "NSE:RELIANCE,NSE:NIFTY"})
print(response.body)
```
