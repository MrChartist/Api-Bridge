# Expiry dates for an underlying

`GET /v1/expiries`

| | |
|---|---|
| Area | [Market data](../README.md#market-data) |
| Operation | `getExpiries` |
| Scope | `read` |
| This computer only | no |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- An API key with the `read` scope (any key).

See /v1/reference/expiries for kind, lot and holiday shifts.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `underlying` | query | string, up to 30 characters | yes | NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX, BANKEX or a stock symbol. |
| `exchange` | query | one of `NFO`, `BFO`, `MCX`, `CDS` | no |  |
| `backup` | query | boolean | no | Unpinned reads only. true lets a read that no broker account can answer fall back to the free backup sources (Yahoo Finance, NSE website; freshness.source "backup", delayed); false never does. Default from config (`sources.autoFallback`). Never available for order, risk, paper or alert purposes, and not accepted on `/xl/*` (a bare value cannot say how current it is) or the compat API (it never uses backup sources). |
| `purpose` | query | `Purpose` | no | What the read is for. `alert`, `paper`, `risk` and `order` accept only real-time data from your own broker; a delayed or end-of-day source is never used for them. `display` (default) and `analysis` accept any labelled source. A caller's `maxAgeMs` also filters: a source whose delay exceeds it cannot answer. |
| `account` | query | `AccountId` | no | Pin the request to this account. Without it, market data may be served from any of your accounts that allow pooling. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | ISO dates, ascending. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | object | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data`

| Field | Type | Required | Notes |
|---|---|---|---|
| `underlying` | string | yes |  |
| `expiries` | array of string (date) | yes |  |
| `freshness` | `Freshness` | yes |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `ACCOUNT_FORBIDDEN` | 403 | no |
| `SESSION_EXPIRED` | 422 | no |
| `RATE_LIMITED` | 429 | yes |
| `UPSTREAM_RATE_LIMITED` | 429 | yes |
| `UPSTREAM_ERROR` | 502 | no |
| `BROKER_UNAVAILABLE` | 503 | yes |
| `UPSTREAM_TIMEOUT` | 504 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/expiries?underlying=NIFTY" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.expiries("NIFTY")
print(result)
```
