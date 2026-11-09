# Find chats that recently wrote to the bot

`POST /v1/notify/targets/{targetId}/find-chat`

| | |
|---|---|
| Area | [Notifications](../README.md#notifications) |
| Operation | `findNotifyChat` |
| Scope | `admin` |
| This computer only | yes |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

The person sends the bot a message (for example /start); the Bridge reads it and offers the chat to confirm. Messages from chats that are not on the list are never answered.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `targetId` | path | string | yes |  |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Chats waiting to be confirmed. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `NotifyFoundChat` | yes |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data` (`NotifyFoundChat`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `ref` | string | yes | Pass this to POST .../chats to confirm the chat. |
| `name` | string | yes |  |
| `type` | string | yes |  |
| `idHint` | string | yes |  |
| `seenAt` | string (date-time) | yes |  |

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
curl -s -X POST "http://127.0.0.1:4300/v1/notify/targets/<targetId>/find-chat" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("POST", "/v1/notify/targets/<targetId>/find-chat")
print(response.body)
```
