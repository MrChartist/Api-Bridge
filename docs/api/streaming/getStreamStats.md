# Upstream feeds, subscriptions and clients

`GET /v1/stream/stats`

| | |
|---|---|
| Area | [Streaming](../README.md#streaming) |
| Operation | `getStreamStats` |
| Scope | `read` |
| This computer only | no |
| Guide | [streaming.md](../../guides/streaming.md) |

- An API key with the `read` scope (any key).

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Stats. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `StreamStats` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`StreamStats`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `clients` | integer | no |  |
| `symbols` | integer | no |  |
| `upstreams` | array of object | no |  |
| `downstream` | object | no |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `UNAUTHENTICATED` | 401 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/stream/stats" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.stream_stats()
print(result)
```
