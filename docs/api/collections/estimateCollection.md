# Size of downloading a collection (symbols x intervals x days)

`GET /v1/collections/{name}/estimate`

| | |
|---|---|
| Area | [Collections](../README.md#collections) |
| Operation | `estimateCollection` |
| Scope | `read` |
| This computer only | no |

- An API key with the `read` scope (any key).

Rows, bytes and broker calls before you start. An option universe is resolved first (a stale price is accepted for a
count and is labelled in `atmSource`). An estimate: a recently listed contract has fewer days than asked, and a broker
may keep less intraday history than you ask for.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `name` | path | string, up to 64 characters | yes |  |
| `intervals` | query | string | yes | Comma separated, for example 5m,1d. |
| `days` | query | integer, min 1, max 3650 | yes | Calendar days back from today (1 to 3650). |
| `allowStale` | query | boolean | no | Default `true`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The estimate. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `CollectionEstimate` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`CollectionEstimate`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | no |  |
| `name` | string | yes |  |
| `kind` | string | no |  |
| `resolvedAt` | string (date-time) | no |  |
| `atmSource` | string | no |  |
| `symbols` | integer | yes |  |
| `intervals` | array of string | yes |  |
| `days` | integer | yes |  |
| `tradingDays` | integer | yes |  |
| `rows` | integer | yes |  |
| `bytes` | integer | yes | As CSV, about 70 bytes a row. |
| `brokerCalls` | integer | yes | One per history chunk per symbol per interval (an upper bound). |
| `perInterval` | array of object | no |  |
| `notes` | array of string | yes |  |
| `warnings` | array of string | no |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/collections/large-caps/estimate?intervals=<intervals>&days=1" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "GET",
    "/v1/collections/large-caps/estimate",
    query={"intervals": "<intervals>", "days": "1"},
)
print(response.body)
```
