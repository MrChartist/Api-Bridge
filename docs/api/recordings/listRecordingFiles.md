# The day files of a recording

`GET /v1/recordings/{recordingId}/files`

| | |
|---|---|
| Area | [Recordings](../README.md#recordings) |
| Operation | `listRecordingFiles` |
| Scope | `read` |
| This computer only | no |

- An API key with the `read` scope (any key).

One file per symbol per IST trading day, named YYYY-MM-DD__EXCHANGE_SYMBOL.csv (or .jsonl; .gz after compression). The layout is in docs/guides/recording.md.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `recordingId` | path | string | yes |  |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Files, oldest day first. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `RecordingFile` | yes |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data` (`RecordingFile`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | YYYY-MM-DD__EXCHANGE_SYMBOL.csv or .jsonl, with .gz after compression. |
| `date` | string (date) | yes |  |
| `symbol` | `Symbol` | yes | Canonical Bridge symbol (see the introduction). Inputs may use accepted aliases. |
| `format` | one of `csv`, `jsonl` | yes |  |
| `compressed` | boolean | no |  |
| `bytes` | integer | yes |  |
| `rows` | integer | yes |  |
| `url` | string | no |  |

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
curl -s "http://127.0.0.1:4300/v1/recordings/<recordingId>/files" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/recordings/<recordingId>/files")
print(response.body)
```
