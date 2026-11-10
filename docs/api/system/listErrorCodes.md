# Every error code, what it means and how to fix it

`GET /v1/errors`

| | |
|---|---|
| Area | [System](../README.md#system) |
| Operation | `listErrorCodes` |
| Scope | `read` |
| This computer only | no |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- An API key with the `read` scope (any key).

The catalogue of every problem `code` the Bridge can return, with its HTTP status, whether sending the same request again is safe, a plain explanation and the fix. Generated from the Bridge's own error definitions, so it always matches the version you run.

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The error catalogue, by HTTP status then code. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `ErrorCatalogueEntry` | yes |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data` (`ErrorCatalogueEntry`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `code` | string | yes | The stable `code` in a problem answer. |
| `status` | integer | yes | The HTTP status that goes with it. |
| `title` | string | yes |  |
| `retryable` | boolean | yes | Whether sending exactly the same request again can succeed. |
| `retry` | string | yes | One sentence on whether and when to retry. |
| `means` | string | yes | What happened, in plain words. |
| `fix` | string | yes | What to do about it. |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `UNAUTHENTICATED` | 401 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/errors" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/errors")
print(response.body)
```
