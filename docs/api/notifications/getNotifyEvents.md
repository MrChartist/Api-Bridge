# Every event with its plain label and whether it is on

`GET /v1/notify/events`

| | |
|---|---|
| Area | [Notifications](../README.md#notifications) |
| Operation | `getNotifyEvents` |
| Scope | `admin` |
| This computer only | no |

- An API key with the `admin` scope.

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Events. | application/json: object |
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
| `UNAUTHENTICATED` | 401 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/notify/events" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/notify/events")
print(response.body)
```
