# Does the broker's order book match the Bridge's live orders? (read-only check)

`GET /v1/orders/drift`

| | |
|---|---|
| Area | [Orders](../README.md#orders) |
| Operation | `getOrderDrift` |
| Scope | `read` |
| This computer only | no |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `read` scope (any key).

The last result of the order-book check. While live trading is on, a live account is logged in and the market is open,
the Bridge reads the broker's order book now and then (default every 5 minutes, at the lowest priority of the rate-limit
scheduler) and compares it with its own record of live orders. This route makes no broker call: it reports what the last
check found.

The check only compares and reports. It never changes the Bridge's record, and never places, modifies or cancels an
order. A difference is for you to look at in your broker app. Paper accounts are not checked.

`differences[].kind`: `closed_at_broker` (the Bridge has the order open, the broker shows it finished), `missing_at_broker`
(the Bridge has it open, the broker has no such order), `status_mismatch`, `quantity_mismatch`, `fill_mismatch`,
`unknown_at_broker` (an open broker order the Bridge did not place) and `outcome_unknown` (the Bridge does not know
whether it placed the order; `brokerMatches` lists the broker's orders that fit it). A key sees only its own accounts.
The same result is the `orderBook` item of `GET /v1/readiness`, the bus topic `orders.drift` and a card on the Safety page.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `account` | query | `AccountId` | no | Only this account. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The last check. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `OrderDrift` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`OrderDrift`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `enabled` | boolean | yes | orders.drift.enabled in the config. |
| `state` | one of `off`, `idle`, `waiting`, `ok`, `drift`, `unavailable` | yes | off: switched off. idle: not checking now (see `paused`). waiting: no check yet. ok: the books match. drift: there are differences. unavailable: the broker's order book could not be read. |
| `stale` | boolean | yes | The last check is much older than the interval (the market is closed, or the account is logged out). |
| `summary` | string | yes |  |
| `paused` | object or null | no | Why no check is running now. |
| `readOnly` | `true` | yes |  |
| `note` | string | yes |  |
| `intervalMinutes` | integer | yes | A check is never made more often than this. |
| `marketHoursOnly` | boolean | yes |  |
| `checkedAt` | string (date-time) or null (date-time) | no | IST, the latest check of the accounts shown. |
| `nextCheckAt` | string (date-time) or null (date-time) | no |  |
| `counts` | object | yes | Differences found, in total and by kind. |
| `accounts` | array of object | yes |  |
| `differences` | array of `OrderDriftDifference` | yes |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `ACCOUNT_FORBIDDEN` | 403 | no |
| `SESSION_EXPIRED` | 422 | no |
| `RATE_LIMITED` | 429 | yes |
| `UPSTREAM_RATE_LIMITED` | 429 | yes |
| `UPSTREAM_ERROR` | 502 | no |
| `BROKER_UNAVAILABLE` | 503 | yes |
| `UPSTREAM_TIMEOUT` | 504 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/orders/drift" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/orders/drift")
print(response.body)
```
