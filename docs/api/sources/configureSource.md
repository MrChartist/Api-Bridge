# Store the API key of a source that needs one

`PUT /v1/sources/{id}/config`

| | |
|---|---|
| Area | [Sources](../README.md#sources) |
| Operation | `configureSource` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [sources.md](../../guides/sources.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

The key goes into the encrypted secrets store under `source:<id>` and is never returned, logged or put in the
configuration file. Only from this computer.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes | A source id from `GET /v1/sources`. |

## Request body

Required, `application/json`, schema `SourceConfigRequest`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `apiKey` | string, up to 500 characters | yes | Never echoed back, logged or written to the configuration file. |

Example:

```json
{
  "apiKey": "<source api key>"
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Stored. The answer never contains the key. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | object | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data`

| Field | Type | Required | Notes |
|---|---|---|---|
| `configured` | `true` | yes |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `LOOPBACK_ONLY` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X PUT "http://127.0.0.1:4300/v1/sources/demo/config" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"<source api key>"}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("PUT", "/v1/sources/demo/config", body={"apiKey": "<source api key>"})
print(response.body)
```
