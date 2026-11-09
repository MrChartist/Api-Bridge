# Option chain with IV and Greeks

`GET /v1/optionchain`

| | |
|---|---|
| Area | [Market data](../README.md#market-data) |
| Operation | `getOptionChain` |
| Scope | `read` |
| This computer only | no |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- An API key with the `read` scope (any key).

Works for every F&O stock; see /v1/options/underlyings.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `underlying` | query | string, up to 30 characters | yes |  |
| `expiry` | query | string (date) | yes |  |
| `strikes` | query | integer, min 1, max 100 | no | Strikes on each side of ATM (default all). |
| `greeks` | query | boolean | no | Default `true`. |
| `ivModel` | query | one of `b76-forward`, `legacy-bs-spot` | no | b76-forward: every leg's IV and Greeks from Black-76 on the 5-strike parity forward, mid prices and the vol-time clock (theta per trading-day unit), the broker's own IV kept as brokerIv, and a chain-level pricing object. legacy-bs-spot: Black-Scholes on spot with calendar days (theta per calendar day). Default: market.chain.ivModelDefault (legacy-bs-spot until 2027-05-01); a response that used the legacy default carries Deprecation and Link headers. |
| `backup` | query | boolean | no | Unpinned reads only. true lets a read that no broker account can answer fall back to the free backup sources (Yahoo Finance, NSE website; freshness.source "backup", delayed); false never does. Default from config (`sources.autoFallback`). Never available for order, risk, paper or alert purposes, and not accepted on `/xl/*` (a bare value cannot say how current it is) or the compat API (it never uses backup sources). |
| `purpose` | query | `Purpose` | no | What the read is for. `alert`, `paper`, `risk` and `order` accept only real-time data from your own broker; a delayed or end-of-day source is never used for them. `display` (default) and `analysis` accept any labelled source. A caller's `maxAgeMs` also filters: a source whose delay exceeds it cannot answer. |
| `account` | query | `AccountId` | no | Pin the request to this account. Without it, market data may be served from any of your accounts that allow pooling. |
| `maxAgeMs` | query | integer, min 0, max 3600000 | no | Oldest data you accept, in ms. 0 forces a live read (still within rate limits). Default depends on the endpoint (LTP 1000, quotes 2000, chain 3000). |
| `swr` | query | boolean | no | Stale-while-revalidate. When only an older cached value exists (inside market.stale.maxStaleMs), answer with it at once, labelled `freshness.stale` and `freshness.revalidating`, and refresh it in the background (one refresh however many readers ask). Default `false`. |
| `priority` | query | one of `interactive`, `background` | no | `background` for a prefetch: it waits behind every interactive read, and a read for the same thing joins it and raises its priority. Reads never run at order priority. Default `"interactive"`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Chain. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `OptionChain` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`OptionChain`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `underlying` | string | yes |  |
| `expiry` | string (date) | yes |  |
| `underlyingLtp` | number or null | no |  |
| `atmStrike` | number or null | no |  |
| `lotSize` | integer or null | no |  |
| `underlyingKind` | one of `index`, `stock`, `null` | no | From the master (OPTSTK vs OPTIDX: the spot row's kind). |
| `settlement` | one of `cash`, `physical`, `null` | no | physical for stock derivatives, cash for index derivatives. |
| `strikeStep` | number or null | no | Most common gap between listed strikes of this expiry (inferred); null with fewer than 3 strikes. |
| `tickSize` | number or null | no | Largest option tick size of this expiry in the master. |
| `rows` | array of object | yes |  |
| `freshness` | `Freshness` | yes |  |
| `pricing` | `ChainPricing` | no | How every leg's IV and Greeks were computed (present with ivModel=b76-forward). |

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
curl -s "http://127.0.0.1:4300/v1/optionchain?underlying=NIFTY&expiry=2026-11-24&strikes=5" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.option_chain("NIFTY", "2026-11-24", strikes=5)
print(result)
```
