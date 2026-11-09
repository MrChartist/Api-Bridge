# Recent requests to this Bridge (newest first)

`GET /v1/requests`

| | |
|---|---|
| Area | [System](../README.md#system) |
| Operation | `listRecentRequests` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

The last 200 requests, kept in memory only (method, path without the query string, status, time taken, key id). Requests the dashboard makes for itself carry client "dashboard". Webhook paths are shown as their pattern, never with their token. A market-data read that returned something also carries `route`, a short record of what answered it.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `limit` | query | integer, min 1, max 200 | no | Default `100`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Recent requests. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of object | yes |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data`

| Field | Type | Required | Notes |
|---|---|---|---|
| `at` | string (date-time) | no |  |
| `method` | string | no |  |
| `path` | string | no |  |
| `status` | integer | no |  |
| `ms` | integer | no |  |
| `keyId` | string or null | no |  |
| `client` | string or null | no |  |
| `requestId` | string | no |  |
| `route` | `RequestRoute` | no | What answered a market-data read (`/v1/ltp`, `/v1/quotes`, `/v1/depth`, `/v1/history`, `/v1/expiries`, `/v1/optionchain`), on its entry in `GET /v1/requests`. It is built from the freshness labels the read already returned, so it costs no extra upstream call, and it is one record per request, never a list per symbol. A read of several symbols is summed up: `from` is the least current verdict and `class` the least current data class. Absent for other routes and for a read that answered nothing. |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `LOOPBACK_ONLY` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/requests" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/requests")
print(response.body)
```
