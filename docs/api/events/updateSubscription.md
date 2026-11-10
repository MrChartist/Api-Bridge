# Change a subscription (this computer only)

`PATCH /v1/subscriptions/{subscriptionId}`

| | |
|---|---|
| Area | [Events](../README.md#events) |
| Operation | `updateSubscription` |
| Scope | `admin` |
| This computer only | yes |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

Only the fields sent change. A new `url` or `secret` is a new target, so this works from this computer only.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `subscriptionId` | path | string | yes |  |

## Request body

Required, `application/json`, schema `SubscriptionUpdate`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `url` | string, up to 2048 characters | no |  |
| `topics` | array of string | no |  |
| `secret` | string, up to 256 characters | no |  |
| `active` | boolean | no | false pauses delivery; queued events wait. |
| `label` | string, up to 60 characters or null | no |  |
| `accounts` | one of `*` or array of `AccountId` | no |  |

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
curl -s -X PATCH "http://127.0.0.1:4300/v1/subscriptions/<subscriptionId>" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("PATCH", "/v1/subscriptions/<subscriptionId>", body={})
print(response.body)
```
