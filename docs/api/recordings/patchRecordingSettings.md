# Change the budget share while the Bridge runs

`PATCH /v1/recordings/settings`

| | |
|---|---|
| Area | [Recordings](../README.md#recordings) |
| Operation | `patchRecordingSettings` |
| Scope | `admin` |
| This computer only | yes |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

Applies at the next broker read, is kept in recordings/settings.json in the data folder and survives a restart. There is
no after-hours switch: recordings run during market hours.

## Request body

Required, `application/json`, schema `RecordingSettingsUpdate`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `maxBudgetShare` | number, min 0.05, max 0.8 | yes |  |

Example:

```json
{
  "maxBudgetShare": 0.05
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Saved. The settings now in force. | application/json: object |
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
curl -s -X PATCH "http://127.0.0.1:4300/v1/recordings/settings" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"maxBudgetShare":0.05}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("PATCH", "/v1/recordings/settings", body={"maxBudgetShare": 0.05})
print(response.body)
```
