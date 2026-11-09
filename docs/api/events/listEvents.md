# Replay events as JSON (the polling twin of the stream)

`GET /v1/events`

| | |
|---|---|
| Area | [Events](../README.md#events) |
| Operation | `listEvents` |
| Scope | `read` |
| This computer only | no |

- An API key with the `read` scope (any key).

The same events, filters and cursor as the stream, in one answer. With `since`, the events after that cursor,
oldest first; without it, the newest `limit` events. `meta.cursor` is the cursor to ask with next time;
`meta.gap` is true when events between your cursor and the oldest kept one are gone (read your state from REST again).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `topics` | query | string, up to 1000 characters | no | Comma-separated topic filters: a topic, a prefix such as `order.*`, or `*` (default). |
| `since` | query | string | no | A cursor (an event `id`). Events after it are replayed first, then live ones. `0` = everything kept. Without it the stream is live only; SSE also reads `Last-Event-ID`. |
| `accounts` | query | string, up to 3200 characters | no | Only events about these accounts (comma-separated). A key never sees more than its own accounts. |
| `limit` | query | integer, min 1, max 500 | no | Default `100`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Events. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `EventEnvelope` | yes |  |
| `meta` | `EventsMeta` | yes |  |

#### Each item of `data` (`EventEnvelope`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | The cursor. Opaque; give it back as `since` or `Last-Event-ID`. Also the id to de-duplicate webhook deliveries on. |
| `topic` | string | yes |  |
| `time` | string (date-time) | yes | When the Bridge saw the event (UTC). |
| `apiVersion` | one of `v1` | yes |  |
| `data` | object | yes | The event's fields (see docs/guides/events.md). Anything that looked like a secret was removed. |

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
curl -s "http://127.0.0.1:4300/v1/events" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/events")
print(response.body)
```
