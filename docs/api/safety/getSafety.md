# Kill switch, live-trading state and today's safety counters

`GET /v1/safety`

| | |
|---|---|
| Area | [Safety](../README.md#safety) |
| Operation | `getSafety` |
| Scope | `read` |
| This computer only | no |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `read` scope (any key).

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Safety status. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `SafetyStatus` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`SafetyStatus`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `killSwitch` | `KillSwitchState` | yes |  |
| `liveTrading` | boolean | yes | Global config switch. |
| `accounts` | array of object | no |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `UNAUTHENTICATED` | 401 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/safety" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.safety()
print(result)
```
