# Delete a recording and its files

`DELETE /v1/recordings/{recordingId}`

| | |
|---|---|
| Area | [Recordings](../README.md#recordings) |
| Operation | `deleteRecording` |
| Scope | `admin` |
| This computer only | yes |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

A recording that belongs to a rule is deleted by deleting the rule (409 otherwise).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `recordingId` | path | string | yes |  |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 204 | Deleted. |  |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `LOOPBACK_ONLY` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X DELETE "http://127.0.0.1:4300/v1/recordings/<recordingId>" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("DELETE", "/v1/recordings/<recordingId>")
print(response.body)
```
