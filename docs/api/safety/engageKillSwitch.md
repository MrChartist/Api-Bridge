# Stop all orders now (any key may do this)

`POST /v1/safety/kill-switch`

| | |
|---|---|
| Area | [Safety](../README.md#safety) |
| Operation | `engageKillSwitch` |
| Scope | `read` |
| This computer only | no |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `read` scope (any key).

Any key may stop trading; an empty body works (reason "manual"). cancelOpenOrders needs a live key (or admin from this computer) and cancels only orders the Bridge placed on the caller's accounts; includeExternal (admin from this computer) also cancels orders placed outside the Bridge. Without the needed scope the switch is still engaged and the response carries a warning.

## Request body

Optional, `application/json`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `reason` | string, up to 200 characters | no | Default `"manual"`. |
| `cancelOpenOrders` | boolean | no | Default `false`. |
| `includeExternal` | boolean | no | Default `false`. |

Example:

```json
{
  "reason": "Stopping for the day"
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Kill switch state. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `KillSwitchState` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`KillSwitchState`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `engaged` | boolean | yes |  |
| `reason` | string or null | no |  |
| `by` | string or null | no |  |
| `at` | string (date-time) or null (date-time) | no |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/safety/kill-switch" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Stopping for the day"}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.engage_kill_switch("Stopping for the day")
print(result)
```
