# One webhook subscription with its health

`GET /v1/subscriptions/{subscriptionId}`

| | |
|---|---|
| Area | [Events](../README.md#events) |
| Operation | `getSubscription` |
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
| 200 | The subscription. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `Subscription` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`Subscription`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `label` | string or null | no |  |
| `target` | string | yes | Scheme and host, with an ellipsis when the URL has a path or query (which may be a secret). |
| `host` | string | yes |  |
| `topics` | array of string | yes |  |
| `accounts` | one of `*` or array of string | yes |  |
| `active` | boolean | yes |  |
| `signing` | object | yes |  |
| `createdAt` | string (date-time) | yes |  |
| `updatedAt` | string (date-time) | yes |  |
| `health` | object | yes |  |
| `pending` | integer | yes | Events waiting to be sent or retried. |
| `deadLetters` | integer | yes |  |

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
curl -s "http://127.0.0.1:4300/v1/subscriptions/<subscriptionId>" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/subscriptions/<subscriptionId>")
print(response.body)
```
