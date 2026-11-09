# Orders waiting for a human confirmation

`GET /v1/tickets`

| | |
|---|---|
| Area | [Orders](../README.md#orders) |
| Operation | `listTickets` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

The dashboard's "Pending confirmations" panel polls this (or listens on the stream) and shows each ticket's full order, its source (AI assistant or webhook) and its checks. Admin scope, this computer only. Only open tickets are listed; `state=rejected` lists the ones a person declined in the last 15 minutes (newest first), which the dashboard shows as "Declined".

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `state` | query | one of `open`, `rejected` | no | `open` (default): tickets waiting for a person. `rejected`: tickets a person declined recently. Default `"open"`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Tickets in the asked state (open: oldest first; rejected: newest first). | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `Ticket` | yes |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data` (`Ticket`)

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
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `LOOPBACK_ONLY` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `SESSION_EXPIRED` | 422 | no |
| `RATE_LIMITED` | 429 | yes |
| `UPSTREAM_RATE_LIMITED` | 429 | yes |
| `UPSTREAM_ERROR` | 502 | no |
| `BROKER_UNAVAILABLE` | 503 | yes |
| `UPSTREAM_TIMEOUT` | 504 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/tickets" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/tickets")
print(response.body)
```
