# WebSocket stream of Bridge events (upgrade), same events and cursor as the SSE stream

`GET /v1/events/ws`

| | |
|---|---|
| Area | [Events](../README.md#events) |
| Operation | `openEventSocket` |
| Scope | none (no API key) |
| This computer only | no |

- No API key needed.

`ws://127.0.0.1:4300/v1/events/ws?token=<stream token>&topics=order.*&since=<cursor>`. Server frames:
`ready`, `event` (the envelope plus `type: "event"`), `go_away`, `pong`, `error`. The only message a client may send
is `{"op":"ping"}`; nothing a client sends changes the Bridge.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `token` | query | string | no |  |
| `topics` | query | string, up to 1000 characters | no | Comma-separated topic filters: a topic, a prefix such as `order.*`, or `*` (default). |
| `since` | query | string | no | A cursor (an event `id`). Events after it are replayed first, then live ones. `0` = everything kept. Without it the stream is live only; SSE also reads `Last-Event-ID`. |
| `accounts` | query | string, up to 3200 characters | no | Only events about these accounts (comma-separated). A key never sees more than its own accounts. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 101 | Switching to the WebSocket protocol. |  |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |

## Examples

A WebSocket upgrade, not a plain request. Get a single-use token first (`POST /v1/stream/token`), then connect to `ws://127.0.0.1:4300/v1/stream?token=<token>`. Message formats: docs/asyncapi.yaml and [streaming.md](../../guides/streaming.md).

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

with bridge.stream(["NSE:RELIANCE"], mode="ltp") as s:
    for msg in s:
        if msg["type"] == "tick":
            print(msg["symbol"], msg["ltp"])
```
