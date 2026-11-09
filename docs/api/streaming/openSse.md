# Server-Sent Events stream (same messages as the WebSocket)

`GET /v1/stream/sse`

| | |
|---|---|
| Area | [Streaming](../README.md#streaming) |
| Operation | `openSse` |
| Scope | none (no API key) |
| This computer only | no |
| Guide | [streaming.md](../../guides/streaming.md) |

- No API key needed.

`GET /v1/stream/sse?token=<stream token>&symbols=NSE:NIFTY,NSE:RELIANCE&mode=ltp`. Each event's `id` is its `seq`; a reconnect gets a fresh snapshot first.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `token` | query | string | no |  |
| `symbols` | query | string, up to 8000 characters | yes | Comma-separated symbols (up to 200). |
| `mode` | query | `StreamMode` | no |  |
| `orders` | query | one of `1` | no | 1 to also receive `order` messages for the accounts the key may use. The key may instead be sent in an Authorization header. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Event stream. | text/event-stream: string |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `SYMBOL_NOT_FOUND` | 404 | no |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/stream/sse?symbols=NSE:RELIANCE,NSE:NIFTY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/stream/sse", query={"symbols": "NSE:RELIANCE,NSE:NIFTY"})
print(response.body)
```
