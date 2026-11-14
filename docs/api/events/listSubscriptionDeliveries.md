# The delivery log, newest first

`GET /v1/subscriptions/{subscriptionId}/deliveries`

| | |
|---|---|
| Area | [Events](../README.md#events) |
| Operation | `listSubscriptionDeliveries` |
| Scope | `admin` |
| This computer only | no |

- An API key with the `admin` scope.

Every attempt with its outcome, HTTP status and a short failure code. No receiver answer text, URL path or secret.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `subscriptionId` | path | string | yes |  |
| `outcome` | query | one of `delivered`, `retry`, `dead`, `failed` | no |  |
| `limit` | query | integer, min 1, max 500 | no | Default `100`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Attempts. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `DeliveryRecord` | yes |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data` (`DeliveryRecord`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | no |  |
| `deliveryId` | string | no |  |
| `eventId` | string | no |  |
| `topic` | string | no |  |
| `attempt` | integer | no |  |
| `at` | string (date-time) | no |  |
| `outcome` | one of `delivered`, `retry`, `dead`, `failed` | no |  |
| `ok` | boolean | no |  |
| `status` | integer or null | no |  |
| `code` | string or null | no |  |
| `message` | string or null | no |  |
| `durationMs` | integer or null | no |  |
| `nextAttemptAt` | string (date-time) or null (date-time) | no |  |
| `test` | boolean | no |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/subscriptions/<subscriptionId>/deliveries" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/subscriptions/<subscriptionId>/deliveries")
print(response.body)
```
