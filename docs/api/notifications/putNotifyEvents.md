# Choose which events are sent, quiet hours and the morning reminder

`PUT /v1/notify/events`

| | |
|---|---|
| Area | [Notifications](../README.md#notifications) |
| Operation | `putNotifyEvents` |
| Scope | `admin` |
| This computer only | yes |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

Only the fields sent change.

## Request body

Required, `application/json`, schema `NotifyEventsUpdate`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `events` | object | no | Event key to on/off. Unknown keys are refused. |
| `quietHours` | object | no |  |
| `morning` | object | no |  |

Example:

```json
{}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Saved. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `NotifyEvents` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`NotifyEvents`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `events` | array of object | yes |  |
| `quietHours` | object | yes |  |
| `morning` | object | yes |  |

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
curl -s -X PUT "http://127.0.0.1:4300/v1/notify/events" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("PUT", "/v1/notify/events", body={})
print(response.body)
```
