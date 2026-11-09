# Delete a job and its files

`DELETE /v1/downloads/{id}`

| | |
|---|---|
| Area | [Data downloads](../README.md#data-downloads) |
| Operation | `deleteDownload` |
| Scope | `admin` |
| This computer only | yes |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

This computer only, admin key. Stops the job if it runs and removes its folder with the files and the manifest. The files of a dataset are never removed by this call; delete the dataset instead.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |

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
curl -s -X DELETE "http://127.0.0.1:4300/v1/downloads/demo" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("DELETE", "/v1/downloads/demo")
print(response.body)
```
