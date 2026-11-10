# Market depth (5 levels where the broker offers it)

`GET /v1/depth`

| | |
|---|---|
| Area | [Market data](../README.md#market-data) |
| Operation | `getDepth` |
| Scope | `read` |
| This computer only | no |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- An API key with the `read` scope (any key).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `symbol` | query | `Symbol` | yes |  |
| `account` | query | `AccountId` | no | Pin the request to this account. Without it, market data may be served from any of your accounts that allow pooling. |
| `maxAgeMs` | query | integer, min 0, max 3600000 | no | Oldest data you accept, in ms. 0 forces a live read (still within rate limits). Default depends on the endpoint (LTP 1000, quotes 2000, chain 3000). |
| `priority` | query | one of `interactive`, `background` | no | `background` for a prefetch: it waits behind every interactive read, and a read for the same thing joins it and raises its priority. Reads never run at order priority. Default `"interactive"`. |
| `strict` | query | boolean | no | `true` refuses a query parameter this route does not know (400 VALIDATION_FAILED, with a "did you mean" hint) instead of ignoring it. Without it the read goes ahead and the answer has `X-MCB-Ignored-Params` (and `X-MCB-Param-Hint`) naming what was ignored. Default `false`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Depth. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `DepthItem` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`DepthItem`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `symbol` | `Symbol` | yes | Canonical Bridge symbol (see the introduction). Inputs may use accepted aliases. |
| `bids` | array of `DepthLevel` | yes |  |
| `asks` | array of `DepthLevel` | yes |  |
| `freshness` | `Freshness` | yes |  |

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
curl -s "http://127.0.0.1:4300/v1/depth?symbol=NSE:RELIANCE" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.depth("NSE:RELIANCE")
print(result)
```
