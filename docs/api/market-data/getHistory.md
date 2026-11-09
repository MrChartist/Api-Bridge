# Historical candles, automatically split across broker limits

`GET /v1/history`

| | |
|---|---|
| Area | [Market data](../README.md#market-data) |
| Operation | `getHistory` |
| Scope | `read` |
| This computer only | no |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- An API key with the `read` scope (any key).

Give `from`+`to`, or `to`+`countback`. Ranges longer than the broker allows in one call are fetched in chunks within the rate limits. `format=csv` returns `time,open,high,low,close,volume,oi` with IST timestamps.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `symbol` | query | `Symbol` | yes |  |
| `interval` | query | `Interval` | yes |  |
| `from` | query | string | no | ISO date or date-time (IST if no offset), or epoch seconds. |
| `to` | query | string | no |  |
| `countback` | query | integer, min 1, max 5000 | no |  |
| `format` | query | one of `json`, `csv` | no | Default `"json"`. |
| `dataset` | query | string | no | Read from this dataset on this computer (needs `from`). Only the part it does not cover is fetched from the broker. `meta.source` says `local`, `mixed` or absent. The config `market.history.localFirst` does the same for any dataset that covers the range. |
| `backup` | query | boolean | no | Unpinned reads only. true lets a read that no broker account can answer fall back to the free backup sources (Yahoo Finance, NSE website; freshness.source "backup", delayed); false never does. Default from config (`sources.autoFallback`). Never available for order, risk, paper or alert purposes, and not accepted on `/xl/*` (a bare value cannot say how current it is) or the compat API (it never uses backup sources). |
| `purpose` | query | `Purpose` | no | What the read is for. `alert`, `paper`, `risk` and `order` accept only real-time data from your own broker; a delayed or end-of-day source is never used for them. `display` (default) and `analysis` accept any labelled source. A caller's `maxAgeMs` also filters: a source whose delay exceeds it cannot answer. |
| `account` | query | `AccountId` | no | Pin the request to this account. Without it, market data may be served from any of your accounts that allow pooling. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Candles, ascending. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `HistoryResult` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`HistoryResult`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `symbol` | `Symbol` | yes | Canonical Bridge symbol (see the introduction). Inputs may use accepted aliases. |
| `interval` | `Interval` | yes |  |
| `candles` | array of `Candle` | yes |  |
| `freshness` | `Freshness` | yes |  |
| `partial` | boolean | yes | True when the broker could not supply the whole range (history depth limits). |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `ACCOUNT_FORBIDDEN` | 403 | no |
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
curl -s "http://127.0.0.1:4300/v1/history?symbol=NSE:RELIANCE&interval=5m&countback=50" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.history("NSE:RELIANCE", "5m", countback=50)
print(result)
```
