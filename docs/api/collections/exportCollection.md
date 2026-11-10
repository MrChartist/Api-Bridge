# A collection as a CSV or JSON file

`GET /v1/collections/{name}/export`

| | |
|---|---|
| Area | [Collections](../README.md#collections) |
| Operation | `exportCollection` |
| Scope | `read` |
| This computer only | no |

- An API key with the `read` scope (any key).

JSON is the definition (a universe stays a universe) and imports back with `POST /v1/collections/import`. CSV is the
symbols; for an option universe it is the symbols as they resolve now (`X-Resolved-At`).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `name` | path | string, up to 64 characters | yes |  |
| `format` | query | one of `json`, `csv` | no | Default `"json"`. |
| `resolved` | query | boolean | no | JSON only: write a universe as the static list of this moment. Default `false`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The file. | application/json: object |
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
curl -s "http://127.0.0.1:4300/v1/collections/large-caps/export" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/collections/large-caps/export")
print(response.body)
```
