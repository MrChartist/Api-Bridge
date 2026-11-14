# Send a test message and report delivery per chat

`POST /v1/notify/targets/{targetId}/test`

| | |
|---|---|
| Area | [Notifications](../README.md#notifications) |
| Operation | `testNotifyTarget` |
| Scope | `admin` |
| This computer only | yes |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `targetId` | path | string | yes |  |

## Request body

Required, `application/json`, schema `NotifyTestRequest`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `chat` | string | no | A chat key; omit to test every chat of the target. |

Example:

```json
{}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Result. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `NotifyTestResult` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`NotifyTestResult`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `ok` | boolean | yes |  |
| `delivered` | integer | yes |  |
| `message` | string | no | What went wrong |
| `results` | array of object | yes |  |

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
curl -s -X POST "http://127.0.0.1:4300/v1/notify/targets/<targetId>/test" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("POST", "/v1/notify/targets/<targetId>/test", body={})
print(response.body)
```
