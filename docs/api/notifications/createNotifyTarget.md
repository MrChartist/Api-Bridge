# Add a Telegram bot (or replace the token of the same bot)

`POST /v1/notify/targets`

| | |
|---|---|
| Area | [Notifications](../README.md#notifications) |
| Operation | `createNotifyTarget` |
| Scope | `admin` |
| This computer only | yes |
| Idempotency-Key | send one on every write |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).
- Send an `Idempotency-Key` (8 to 255 characters); a retry with the same key returns the first result.

The token is checked with Telegram (getMe) and stored encrypted in the secrets store. It is never returned, logged or audited.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string, up to 255 characters | no | Your unique id for this write (UUID recommended). A retry with the same key and the same body returns the first result with `Idempotency-Replayed: true`; a different body is refused with 409 IDEMPOTENCY_KEY_REUSED; a retry while the first is still running gets 409 IDEMPOTENCY_IN_PROGRESS. Keys are kept until the end of the IST trading day and at least 24 hours. For POST /v1/orders, `clientOrderId` in the body works the same way when the header is absent. The create routes that are not orders honour it too, with the same rules: keys, accounts, hooks, notify targets, collections (create, import, duplicate), downloads, dataset updates, subscriptions, recordings, recording rules and recording presets. For these the stored answer is kept in memory for 24 hours and is forgotten on restart, and a request that failed is forgotten at once so it can be retried. Every other write route ignores the header and says so with `Idempotency-Ignored: true` in the answer. |

## Request body

Required, `application/json`, schema `NotifyTargetCreate`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `kind` | one of `telegram` | no | Default `"telegram"`. |
| `token` | string, up to 120 characters | yes | From BotFather. Accepted only from this computer. |
| `label` | string, up to 40 characters | no |  |

Example:

```json
{
  "token": "<hook token>"
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 201 | Created. 200 when the same bot already existed and its token was replaced. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 201 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `NotifyTarget` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`NotifyTarget`)

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
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `LOOPBACK_ONLY` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | yes |
| `IDEMPOTENCY_KEY_REUSED` | 409 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/notify/targets" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-order-0001" \
  -d '{"token":"<hook token>"}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "POST",
    "/v1/notify/targets",
    body={"token": "<hook token>"},
    idempotency_key="my-order-0001",
)
print(response.body)
```
