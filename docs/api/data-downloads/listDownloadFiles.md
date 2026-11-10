# The files of a job, as listed in its manifest

`GET /v1/downloads/{downloadId}/files`

| | |
|---|---|
| Area | [Data downloads](../README.md#data-downloads) |
| Operation | `listDownloadFiles` |
| Scope | `read` |
| This computer only | no |

- An API key with the `read` scope (any key).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `downloadId` | path | string | yes |  |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The files (name, symbol, interval, rows, bytes, first and last bar, sha256). | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `DownloadFile` | yes |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data` (`DownloadFile`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes |  |
| `symbol` | string or null | no | null for a combined file. |
| `interval` | string | no |  |
| `rows` | integer | yes |  |
| `bytes` | integer | yes |  |
| `firstBar` | string or null | no | IST bar-open time of the first bar. |
| `lastBar` | string or null | no |  |
| `sha256` | string or null | yes |  |

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
curl -s "http://127.0.0.1:4300/v1/downloads/<downloadId>/files" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/downloads/<downloadId>/files")
print(response.body)
```
