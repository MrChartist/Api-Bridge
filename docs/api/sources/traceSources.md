# Why a read would be served by one source and not another (dry run)

`GET /v1/sources/trace`

| | |
|---|---|
| Area | [Sources](../README.md#sources) |
| Operation | `traceSources` |
| Scope | `read` |
| This computer only | no |
| Guide | [sources.md](../../guides/sources.md) |

- An API key with the `read` scope (any key).

Runs the router's decision for a read and explains it: every candidate (your pooled broker accounts and the
enabled sources), with the verdict (`chosen`, `fallback` or `skipped`), the reason, the score and the spare
budget. Nothing is fetched and no upstream call is made, so it costs no quota. `class` is the data class the
answer would carry.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `capability` | query | `SourceCapability` | yes |  |
| `symbols` | query | string, up to 8000 characters | yes | Comma-separated symbols (for expiries and option chains, the underlying). |
| `purpose` | query | `Purpose` | no | What the read is for. `alert`, `paper`, `risk` and `order` accept only real-time data from your own broker; a delayed or end-of-day source is never used for them. `display` (default) and `analysis` accept any labelled source. A caller's `maxAgeMs` also filters: a source whose delay exceeds it cannot answer. |
| `maxAgeMs` | query | integer, min 0, max 3600000 | no | The oldest data the caller would accept, in ms. A delayed or end-of-day source whose delay is longer cannot answer. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The routing decision. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `RoutingTrace` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`RoutingTrace`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `request` | object | yes |  |
| `considered` | array of object | yes |  |
| `class` | `DataClass` or null | yes | The data class the answer would carry; null when nothing can serve the read. |
| `note` | string | no |  |

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
curl -s "http://127.0.0.1:4300/v1/sources/trace?capability=quotes&symbols=NSE:RELIANCE,NSE:NIFTY" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "GET",
    "/v1/sources/trace",
    query={"capability": "quotes", "symbols": "NSE:RELIANCE,NSE:NIFTY"},
)
print(response.body)
```
