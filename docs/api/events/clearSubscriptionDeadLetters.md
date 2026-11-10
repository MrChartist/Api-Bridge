# Forget this subscription's dead letters

`DELETE /v1/subscriptions/{subscriptionId}/dead-letters`

| | |
|---|---|
| Area | [Events](../README.md#events) |
| Operation | `clearSubscriptionDeadLetters` |
| Scope | `admin` |
| This computer only | no |

- An API key with the `admin` scope.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `subscriptionId` | path | string | yes |  |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | How many were removed. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | object | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data`

| Field | Type | Required | Notes |
|---|---|---|---|
| `removed` | integer | yes |  |

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
curl -s -X DELETE "http://127.0.0.1:4300/v1/subscriptions/<subscriptionId>/dead-letters" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("DELETE", "/v1/subscriptions/<subscriptionId>/dead-letters")
print(response.body)
```
