# Whether auto-record is on

`GET /v1/recordings/auto`

| | |
|---|---|
| Area | [Recordings](../README.md#recordings) |
| Operation | `getRecordingAuto` |
| Scope | `read` |
| This computer only | no |

- An API key with the `read` scope (any key).

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The switch. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `RecordingAuto` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`RecordingAuto`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `enabled` | boolean | yes |  |
| `setBy` | one of `user`, `config` | no |  |
| `rules` | integer | no |  |
| `activeRules` | integer | no |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `UNAUTHENTICATED` | 401 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/recordings/auto" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/recordings/auto")
print(response.body)
```
