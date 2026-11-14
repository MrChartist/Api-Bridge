# Events that could not be delivered, newest first

`GET /v1/subscriptions/{subscriptionId}/dead-letters`

| | |
|---|---|
| Area | [Events](../README.md#events) |
| Operation | `listSubscriptionDeadLetters` |
| Scope | `admin` |
| This computer only | no |

- An API key with the `admin` scope.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `subscriptionId` | path | string | yes |  |
| `limit` | query | integer, min 1, max 500 | no | Page size, 1 to 500. Without it the whole list comes back (`meta.nextCursor` is then null). With it, send `meta.nextCursor` as `cursor` for the next page. |
| `cursor` | query | string, up to 512 characters | no | Opaque cursor from `meta.nextCursor`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Dead letters. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `DeadLetter` | yes |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data` (`DeadLetter`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | no |  |
| `eventId` | string | no |  |
| `topic` | string | no |  |
| `attempts` | integer | no |  |
| `createdAt` | string (date-time) | no |  |
| `deadAt` | string (date-time) | no |  |
| `reason` | string | no | http_4xx, redirect_refused, blocked_address, overflow, expired, or the last retryable failure. |
| `status` | integer or null | no |  |
| `message` | string | no |  |

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
curl -s "http://127.0.0.1:4300/v1/subscriptions/<subscriptionId>/dead-letters" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/subscriptions/<subscriptionId>/dead-letters")
print(response.body)
```
