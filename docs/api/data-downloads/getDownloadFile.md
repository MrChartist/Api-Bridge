# Stream one file of a job (or manifest.json)

`GET /v1/downloads/{downloadId}/files/{name}`

| | |
|---|---|
| Area | [Data downloads](../README.md#data-downloads) |
| Operation | `getDownloadFile` |
| Scope | `read` |
| This computer only | no |

- An API key with the `read` scope (any key).

The file as the Bridge wrote it. The response headers say what the data is: X-Data-Class (realtime, delayed or eod), X-Data-Source, X-Data-Official and X-Data-Delay-Sec. Data that is delayed or end-of-day must never feed orders, risk checks, paper fills or alerts.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `downloadId` | path | string | yes |  |
| `name` | path | string, up to 100 characters | yes | A file name from the job's file list, or manifest.json. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The file. | text/csv: string (binary) |
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
curl -s "http://127.0.0.1:4300/v1/downloads/<downloadId>/files/NSE_RELIANCE_1d.csv" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/downloads/<downloadId>/files/NSE_RELIANCE_1d.csv")
print(response.body)
```
