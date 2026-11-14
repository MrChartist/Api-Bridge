# A person declines an order prepared by an AI assistant or webhook

`POST /v1/tickets/{ticketId}/reject`

| | |
|---|---|
| Area | [Orders](../README.md#orders) |
| Operation | `rejectTicket` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

The "no" that goes with confirm. Only an open ticket can be declined; it leaves the pending list at once and can never be confirmed afterwards. Declining a ticket that is already declined is a no-op that answers 200 with the same ticket. A ticket that was already confirmed, used to send its order, or has expired answers 409 `STATE_CONFLICT` with `state` (`confirmed`, `consumed` or `expired`); one the Bridge does not know answers 404. The decline is audited (`ticket.rejected`) and announced on the event bus. The assistant that prepared the order sees `status: rejected` and the reason (MCP tool `check_order_ticket`). Admin scope, this computer only, and not from an AI assistant, a webhook or any other automation.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `ticketId` | path | string, up to 64 characters | yes |  |

## Request body

Optional, `application/json`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `reason` | string, up to 200 characters | no | Optional, in the person's own words. The assistant that prepared the order can read it. |

Example:

```json
{
  "reason": "Not the order I meant"
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The declined ticket (`status: rejected`). | application/json: object |
| 409 | The ticket is not open any more. `state` says why (`confirmed`, `consumed`, `expired`). | application/problem+json: `Problem` |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `Ticket` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`Ticket`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `ticketId` | string | yes |  |
| `order` | `OrderRequest` | yes |  |
| `source` | one of `mcp`, `webhook`, `rest` | yes |  |
| `client` | string | no | Key label or hook label that prepared it. |
| `checks` | array of `Check` | yes |  |
| `estimatedValue` | number or null | no |  |
| `createdAt` | string (date-time) | yes |  |
| `expiresAt` | string (date-time) | yes |  |
| `status` | one of `open`, `rejected` | no | `open` while it waits for a person; `rejected` once a person declined it. |
| `rejectedAt` | string (date-time) | no | Declined tickets only. |
| `reason` | string, up to 200 characters or null | no | Declined tickets only: the person's reason, when they gave one. |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `LOOPBACK_ONLY` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `NOT_FOUND` | 404 | no |
| `STATE_CONFLICT` | 409 | yes |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `SESSION_EXPIRED` | 422 | no |
| `RATE_LIMITED` | 429 | yes |
| `UPSTREAM_RATE_LIMITED` | 429 | yes |
| `UPSTREAM_ERROR` | 502 | no |
| `BROKER_UNAVAILABLE` | 503 | yes |
| `UPSTREAM_TIMEOUT` | 504 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/tickets/<ticketId>/reject" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Not the order I meant"}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "POST",
    "/v1/tickets/<ticketId>/reject",
    body={"reason": "Not the order I meant"},
)
print(response.body)
```
