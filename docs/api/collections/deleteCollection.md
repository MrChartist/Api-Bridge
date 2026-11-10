# Delete a collection

`DELETE /v1/collections/{name}`

| | |
|---|---|
| Area | [Collections](../README.md#collections) |
| Operation | `deleteCollection` |
| Scope | `paper` |
| This computer only | no |

- An API key with the `paper` scope (or `live`).

Refused with 409 while a download, recording or rule that is running uses it, unless `force=true`.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `name` | path | string, up to 64 characters | yes | The collection's name or id. A name it had before a rename also finds it (the answer says `viaOldName`). |
| `force` | query | boolean | no | Default `false`. |

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
| `SCOPE_REQUIRED` | 403 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X DELETE "http://127.0.0.1:4300/v1/collections/<name>" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("DELETE", "/v1/collections/<name>")
print(response.body)
```
