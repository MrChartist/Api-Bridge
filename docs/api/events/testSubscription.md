# Send one signed test event now (this computer only)

`POST /v1/subscriptions/{subscriptionId}/test`

| | |
|---|---|
| Area | [Events](../README.md#events) |
| Operation | `testSubscription` |
| Scope | `admin` |
| This computer only | yes |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

One attempt, not queued and not retried; it appears in the delivery log. At most one test every two seconds per subscription.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `subscriptionId` | path | string | yes |  |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The result of the attempt (`ok` false is still a 200 here; read `code`). | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `SubscriptionTestResult` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`SubscriptionTestResult`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `ok` | boolean | no |  |
| `status` | integer or null | no | The receiver's HTTP status. |
| `code` | string or null | no | A short failure code (http_4xx, http_5xx, timeout, connect_failed, tls_failed, blocked_address ...). |
| `message` | string | no |  |
| `durationMs` | integer | no |  |
| `deliveryId` | string | no |  |
| `willRetry` | boolean | no | Always false: a test is not queued. |

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
curl -s -X POST "http://127.0.0.1:4300/v1/subscriptions/<subscriptionId>/test" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("POST", "/v1/subscriptions/<subscriptionId>/test")
print(response.body)
```
