# Stream one file of a dataset

`GET /v1/datasets/{name}/files/{file}`

| | |
|---|---|
| Area | [Data downloads](../README.md#data-downloads) |
| Operation | `getDatasetFile` |
| Scope | `read` |
| This computer only | no |

- An API key with the `read` scope (any key).

One series file, by the name (and `url`) that GET /v1/datasets/{name} lists. The response headers carry the dataset's own data class, source, official flag and delay (X-Data-Class and so on): they follow the least current data the dataset holds. Data that is delayed or end-of-day must never feed orders, risk checks, paper fills or alerts.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `name` | path | string | yes |  |
| `file` | path | string, up to 100 characters | yes | A file name from the dataset's file list. |

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
curl -s "http://127.0.0.1:4300/v1/datasets/large-caps/files/<file>" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/datasets/large-caps/files/<file>")
print(response.body)
```
