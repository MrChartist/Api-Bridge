# List Telegram bots and their chats (masked)

`GET /v1/notify/targets`

| | |
|---|---|
| Area | [Notifications](../README.md#notifications) |
| Operation | `listNotifyTargets` |
| Scope | `admin` |
| This computer only | no |

- An API key with the `admin` scope.

The bot token and chat ids are never returned: only a token hint, the bot name, a chat name and the last four digits of each chat id.

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Targets. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `NotifyTarget` | yes |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data` (`NotifyTarget`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `kind` | one of `telegram` | yes |  |
| `label` | string | yes |  |
| `bot` | object | yes |  |
| `chats` | array of `NotifyChat` | yes |  |
| `createdAt` | string (date-time) | yes |  |
| `replaced` | boolean | no | Only on POST: the same bot was already set up and its token was replaced. |
| `health` | object | yes |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `UNAUTHENTICATED` | 401 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/notify/targets" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/notify/targets")
print(response.body)
```
