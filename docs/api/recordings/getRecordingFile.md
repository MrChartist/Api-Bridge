# Download one day file as it is on disk

`GET /v1/recordings/{recordingId}/files/{name}`

| | |
|---|---|
| Area | [Recordings](../README.md#recordings) |
| Operation | `getRecordingFile` |
| Scope | `read` |
| This computer only | no |

- An API key with the `read` scope (any key).

Only names from the file list open. The answer carries X-Data-Class realtime.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `recordingId` | path | string | yes |  |
| `name` | path | string | yes |  |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The file (CSV, JSON lines, or gzip for a compressed day). | text/csv: string |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/recordings/<recordingId>/files/large-caps" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/recordings/<recordingId>/files/large-caps")
print(response.body)
```
