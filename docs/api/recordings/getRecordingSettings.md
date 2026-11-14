# The budget share recordings use now

`GET /v1/recordings/settings`

| | |
|---|---|
| Area | [Recordings](../README.md#recordings) |
| Operation | `getRecordingSettings` |
| Scope | `read` |
| This computer only | no |

- An API key with the `read` scope (any key).

The value in force (the config value unless changed here), the config default and the allowed range.

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The settings. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `RecordingSettings` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`RecordingSettings`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `maxBudgetShare` | number, min 0.05, max 0.8 | yes | The share of an account's spare API budget recordings may use now. |
| `defaults` | object | yes |  |
| `limits` | object | yes |  |
| `changed` | array of string | no |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `UNAUTHENTICATED` | 401 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/recordings/settings" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/recordings/settings")
print(response.body)
```
