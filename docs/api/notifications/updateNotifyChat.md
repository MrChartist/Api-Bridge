# Allow or stop commands from a chat

`PATCH /v1/notify/targets/{targetId}/chats/{chatKey}`

| | |
|---|---|
| Area | [Notifications](../README.md#notifications) |
| Operation | `updateNotifyChat` |
| Scope | `admin` |
| This computer only | yes |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `targetId` | path | string | yes |  |
| `chatKey` | path | string | yes |  |

## Request body

Required, `application/json`, schema `NotifyChatPatch`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `commands` | boolean | yes |  |

Example:

```json
{
  "commands": false
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Updated. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `NotifyChat` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`NotifyChat`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `key` | string | yes | Short stable key of the chat (a hash of its id). Used instead of the id. |
| `name` | string | yes |  |
| `type` | one of `private`, `group`, `supergroup`, `channel`, `unknown` | yes |  |
| `idHint` | string | yes | Only the last four digits of the chat id. |
| `commands` | boolean | yes | On the allow-list for the read-only commands. Off by default for groups. |
| `state` | object | no | Present when Telegram refused this chat: kind and a plain message. |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `LOOPBACK_ONLY` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X PATCH "http://127.0.0.1:4300/v1/notify/targets/<targetId>/chats/<chatKey>" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"commands":false}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "PATCH",
    "/v1/notify/targets/<targetId>/chats/<chatKey>",
    body={"commands": False},
)
print(response.body)
```
