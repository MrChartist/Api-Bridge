# Server-Sent Events stream of Bridge events, with replay from a cursor

`GET /v1/events/stream`

| | |
|---|---|
| Area | [Events](../README.md#events) |
| Operation | `openEventStream` |
| Scope | none (no API key) |
| This computer only | no |

- No API key needed.

`GET /v1/events/stream?token=<stream token>&topics=order.*,download.*&since=<cursor>`. Credentials as for the price
stream: a single-use token from `POST /v1/stream/token`, or an `Authorization` / `X-API-Key` header from scripts.
The first event is `ready` (`cursor`, `oldest`, `replayed`, `gap`). Each later event has `id` = its cursor, `event` =
its topic and `data` = the envelope `{ id, topic, time, apiVersion, data }`. After a drop, EventSource sends
`Last-Event-ID` by itself and the stream replays what was missed. A read key never receives admin-only topics, and a
key limited to some accounts only receives events about those accounts. Events are read-only notifications.
Full message formats: docs/asyncapi.yaml.

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
| 200 | Event stream. | text/event-stream: string |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/events/stream"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/events/stream")
print(response.body)
```
