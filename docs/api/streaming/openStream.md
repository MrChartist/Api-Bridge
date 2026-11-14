# WebSocket stream (upgrade)

`GET /v1/stream`

| | |
|---|---|
| Area | [Streaming](../README.md#streaming) |
| Operation | `openStream` |
| Scope | none (no API key) |
| This computer only | no |
| Guide | [streaming.md](../../guides/streaming.md) |

- No API key needed.

Connect with `ws://127.0.0.1:4300/v1/stream?token=<stream token>` (or an `Authorization` header from scripts).
Client messages: `{"op":"subscribe","symbols":[...],"mode":"ltp|quote|depth"}`, `{"op":"unsubscribe",...}`,
`{"op":"subscribe_orders"}`, `{"op":"ping"}`. Server messages: `snapshot`, `tick` (with a per-connection `seq`),
`order`, `status` (upstream connected or stale), `error`, `heartbeat` every 15 s and `go_away` before a restart.
A gap in `seq` means re-subscribe for a fresh snapshot. Full message schemas: docs/asyncapi.yaml.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `token` | query | string | no |  |

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
