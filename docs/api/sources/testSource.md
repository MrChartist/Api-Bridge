# Check that a source answers

`POST /v1/sources/{id}/test`

| | |
|---|---|
| Area | [Sources](../README.md#sources) |
| Operation | `testSource` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [sources.md](../../guides/sources.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

Makes one small call through the source's own `test` (a status or sample request) and reports the result. It counts against the source's quota.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes | A source id from `GET /v1/sources`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The result. A failing source is still a 200 with `ok: false`. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `SourceTestResult` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`SourceTestResult`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `ok` | boolean | yes |  |
| `latencyMs` | number | no |  |
| `detail` | string, up to 200 characters | no |  |

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
curl -s -X POST "http://127.0.0.1:4300/v1/sources/demo/test" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("POST", "/v1/sources/demo/test")
print(response.body)
```
