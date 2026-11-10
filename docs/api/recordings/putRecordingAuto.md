# Turn auto-record on or off

`PUT /v1/recordings/auto`

| | |
|---|---|
| Area | [Recordings](../README.md#recordings) |
| Operation | `putRecordingAuto` |
| Scope | `admin` |
| This computer only | yes |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

Off until a person turns it on. Turning it off stops every rule's recording (the files stay); turning it on starts the enabled rules at their next session.

## Request body

Required, `application/json`, schema `RecordingAutoUpdate`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `enabled` | boolean | yes |  |

Example:

```json
{
  "enabled": false
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Saved. | application/json: object |
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
curl -s -X PUT "http://127.0.0.1:4300/v1/recordings/auto" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"enabled":false}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("PUT", "/v1/recordings/auto", body={"enabled": False})
print(response.body)
```
