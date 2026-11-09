# Short-lived token for WebSocket and SSE URLs

`POST /v1/stream/token`

| | |
|---|---|
| Area | [Streaming](../README.md#streaming) |
| Operation | `createStreamToken` |
| Scope | `read` |
| This computer only | no |
| Guide | [streaming.md](../../guides/streaming.md) |

- An API key with the `read` scope (any key).

Use it as `?token=` on `/v1/stream` or `/v1/stream/sse` so your API key never appears in a URL or a log. Valid for 60 seconds to connect; the connection then lives on with the key's scopes.

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Token. | application/json: object |
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
| `token` | string | yes |  |
| `expiresAt` | string (date-time) | yes |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `UNAUTHENTICATED` | 401 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/stream/token" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.stream_token()
print(result)
```
