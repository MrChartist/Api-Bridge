# Full quotes for up to 200 symbols

`GET /v1/quotes`

| | |
|---|---|
| Area | [Market data](../README.md#market-data) |
| Operation | `getQuotes` |
| Scope | `read` |
| This computer only | no |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- An API key with the `read` scope (any key).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `symbols` | query | string, up to 8000 characters | yes | Comma-separated symbols (up to 200). |
| `backup` | query | boolean | no | Unpinned reads only. true lets a read that no broker account can answer fall back to the free backup sources (Yahoo Finance, NSE website; freshness.source "backup", delayed); false never does. Default from config (`sources.autoFallback`). Never available for order, risk, paper or alert purposes, and not accepted on `/xl/*` (a bare value cannot say how current it is) or the compat API (it never uses backup sources). |
| `purpose` | query | `Purpose` | no | What the read is for. `alert`, `paper`, `risk` and `order` accept only real-time data from your own broker; a delayed or end-of-day source is never used for them. `display` (default) and `analysis` accept any labelled source. A caller's `maxAgeMs` also filters: a source whose delay exceeds it cannot answer. |
| `account` | query | `AccountId` | no | Pin the request to this account. Without it, market data may be served from any of your accounts that allow pooling. |
| `maxAgeMs` | query | integer, min 0, max 3600000 | no | Oldest data you accept, in ms. 0 forces a live read (still within rate limits). Default depends on the endpoint (LTP 1000, quotes 2000, chain 3000). |
| `swr` | query | boolean | no | Stale-while-revalidate. When only an older cached value exists (inside market.stale.maxStaleMs), answer with it at once, labelled `freshness.stale` and `freshness.revalidating`, and refresh it in the background (one refresh however many readers ask). Default `false`. |
| `priority` | query | one of `interactive`, `background` | no | `background` for a prefetch: it waits behind every interactive read, and a read for the same thing joins it and raises its priority. Reads never run at order priority. Default `"interactive"`. |
| `strict` | query | boolean | no | `true` refuses a query parameter this route does not know (400 VALIDATION_FAILED, with a "did you mean" hint) instead of ignoring it. Without it the read goes ahead and the answer has `X-MCB-Ignored-Params` (and `X-MCB-Param-Hint`) naming what was ignored. Default `false`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Quotes. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `QuoteItem` | yes |  |
| `errors` | array of `ItemError` | no |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data` (`QuoteItem`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `symbol` | `Symbol` | yes | Canonical Bridge symbol (see the introduction). Inputs may use accepted aliases. |
| `ltp` | number | yes |  |
| `open` | number or null | no |  |
| `high` | number or null | no |  |
| `low` | number or null | no |  |
| `close` | number or null | no | Previous close. |
| `change` | number or null | no |  |
| `changePct` | number or null | no |  |
| `volume` | number or null | no |  |
| `oi` | number or null | no |  |
| `bid` | number or null | no |  |
| `ask` | number or null | no |  |
| `bidQty` | number or null | no |  |
| `askQty` | number or null | no |  |
| `freshness` | `Freshness` | yes |  |

### Example 200 answer

```json
{
  "data": [
    {
      "symbol": "NSE:RELIANCE",
      "ltp": 1460.8,
      "open": 1460.4,
      "high": 1464.1,
      "low": 1456.5,
      "close": 1460.4,
      "change": 0.4,
      "changePct": 0.0274,
      "volume": 130661,
      "oi": null,
      "bid": 1460.6,
      "ask": 1461,
      "bidQty": 29,
      "askQty": 28,
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
  ],
  "errors": [],
  "meta": {
    "requestId": "req_2f8e1a0c4b7d9e3a5c61"
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
curl -s "http://127.0.0.1:4300/v1/quotes?symbols=NSE:RELIANCE,NSE:NIFTY" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.quotes(["NSE:RELIANCE", "NSE:NIFTY"])
print(result)
```
