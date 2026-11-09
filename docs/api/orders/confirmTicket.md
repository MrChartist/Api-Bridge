# Human confirmation of an order prepared by an AI assistant or webhook

`POST /v1/tickets/{ticketId}/confirm`

| | |
|---|---|
| Area | [Orders](../README.md#orders) |
| Operation | `confirmTicket` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

Used by the Bridge's own confirmation page on this computer. Returns the `confirmToken` that `POST /v1/orders` needs. Tickets expire after about 60 seconds. A ticket a person already declined answers 409 `STATE_CONFLICT` with `state: rejected` and never yields a token.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `ticketId` | path | string, up to 64 characters | yes |  |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Confirmation token. | application/json: object |
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
| `confirmToken` | string | yes |  |
| `expiresAt` | string (date-time) | yes |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `LOOPBACK_ONLY` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `NOT_FOUND` | 404 | no |
| `STATE_CONFLICT` | 409 | yes |
| `SESSION_EXPIRED` | 422 | no |
| `RATE_LIMITED` | 429 | yes |
| `UPSTREAM_RATE_LIMITED` | 429 | yes |
| `UPSTREAM_ERROR` | 502 | no |
| `BROKER_UNAVAILABLE` | 503 | yes |
| `UPSTREAM_TIMEOUT` | 504 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/tickets/<ticketId>/confirm" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("POST", "/v1/tickets/<ticketId>/confirm")
print(response.body)
```
