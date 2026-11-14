# Notification health: queue, last delivery, last error per target

`GET /v1/notify/status`

| | |
|---|---|
| Area | [Notifications](../README.md#notifications) |
| Operation | `getNotifyStatus` |
| Scope | `admin` |
| This computer only | no |

- An API key with the `admin` scope.

Plain-words state for the dashboard and `mc-bridge doctor`. No secrets.

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Status. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `NotifyStatus` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`NotifyStatus`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `enabled` | boolean | yes |  |
| `targets` | array of object | yes |  |
| `queue` | object | yes |  |
| `lastDeliveryAt` | string (date-time) or null (date-time) | no |  |
| `counters` | object | yes |  |
| `quietHours` | object | no |  |
| `reminders` | object | no |  |

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
curl -s "http://127.0.0.1:4300/v1/notify/status" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/notify/status")
print(response.body)
```
