# One plain line about today's recording, and the numbers behind it

`GET /v1/recordings/status`

| | |
|---|---|
| Area | [Recordings](../README.md#recordings) |
| Operation | `getRecordingsStatus` |
| Scope | `read` |
| This computer only | no |

- An API key with the `read` scope (any key).

For example: Recording today: 3 rules, 41 symbols, 18 MB, last write 09:31:02.

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Status. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `RecordingStatus` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`RecordingStatus`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `line` | string | yes |  |
| `enabled` | boolean | no |  |
| `auto` | `RecordingAuto` | no |  |
| `today` | object | yes |  |
| `recordings` | object | yes |  |
| `disk` | object | yes |  |
| `apiCalls` | object | no |  |
| `budgetShare` | number | no | The share of an account's spare API budget recordings may use (recorder.maxBudgetShare). |
| `dataClass` | one of `realtime` | no |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `UNAUTHENTICATED` | 401 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/recordings/status" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/recordings/status")
print(response.body)
```
