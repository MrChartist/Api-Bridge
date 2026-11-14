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

Give `from`+`to`, or `to`+`countback`. Ranges longer than the broker allows in one call are fetched in chunks within the rate limits. `format=csv` returns `time,open,high,low,close,volume,oi` with IST timestamps. Each candle's `time` is epoch seconds; daily, weekly and monthly candles also carry `date`, the IST trading date (a daily bar opens at IST midnight, so the UTC date of `time` is the day before). `timeIso=true` or `tz` adds `timeIso`, the same instant as an ISO string. For times in this API, see "Times and time zones" in the Developers guide.

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
| `strict` | query | boolean | no | `true` refuses a query parameter this route does not know (400 VALIDATION_FAILED, with a "did you mean" hint) instead of ignoring it. Without it the read goes ahead and the answer has `X-MCB-Ignored-Params` (and `X-MCB-Param-Hint`) naming what was ignored. Default `false`. |
| `fields` | query | string | no | Comma-separated columns to keep in each candle, for example `close` or `close,date`. `time` is always kept. Naming `timeIso` turns it on. JSON only. An unknown name is a 400 that lists the allowed ones. `meta.fields` echoes the list. The history answer's own `freshness` and `partial` do not change. |
| `timeIso` | query | boolean | no | `true` adds `timeIso` to each candle: the epoch `time` as an ISO-8601 string (IST `+05:30` unless `tz=UTC`). JSON only. Default `false`. |
| `tz` | query | one of `IST`, `UTC` | no | Zone of `timeIso`: `IST` (default, `+05:30`) or `UTC` (`Z`). Sending it turns `timeIso` on. JSON only. The epoch `time` and the IST `date` do not change. Default `"IST"`. |
| `localFirst` | query | boolean | no | `true` serves the range from a dataset on this computer that covers it, and fetches only the rest from the broker (the answer says so in `meta.source`). `dataset` picks one dataset; the config `market.history.localFirst` turns it on for every read. Not with `countback`. Default `false`. |

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

### Example 200 answer

```json
{
  "data": {
    "symbol": "NSE:RELIANCE",
    "interval": "1d",
    "candles": [
      {
        "time": 1794162600,
        "open": 1453.2,
        "high": 1468.7,
        "low": 1450.2,
        "close": 1460.4,
        "volume": 215004,
        "date": "2026-11-09"
      },
      {
        "time": 1794249000,
        "open": 1460.4,
        "high": 1463.9,
        "low": 1455.9,
        "close": 1460.8,
        "volume": 38459,
        "date": "2026-11-10"
      }
    ],
    "partial": false,
    "freshness": {
      "source": "broker",
      "asOf": "2026-11-10T09:46:00.381+05:30",
      "ageMs": 1,
      "stale": false,
      "accountId": "my-zerodha",
      "broker": "zerodha",
      "class": "realtime",
      "delaySec": 0,
      "official": true,
      "confidence": "high",
      "flags": []
    }
  },
  "meta": {
    "requestId": "req_2f8e1a0c4b7d9e3a5c61",
    "accountId": null,
    "freshness": {
      "source": "broker",
      "asOf": "2026-11-10T09:46:00.381+05:30",
      "ageMs": 1,
      "stale": false,
      "accountId": "my-zerodha",
      "broker": "zerodha",
      "class": "realtime",
      "delaySec": 0,
      "official": true,
      "confidence": "high",
      "flags": []
    }
  }
}
```

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
