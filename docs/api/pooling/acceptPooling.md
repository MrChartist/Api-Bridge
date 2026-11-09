# Accept the pooling notice for chosen accounts

`PUT /v1/pooling/consent`

| | |
|---|---|
| Area | [Pooling](../README.md#pooling) |
| Operation | `acceptPooling` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [rate-limits.md](../../guides/rate-limits.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

`acknowledge` must equal the current `notice.version`. Only accounts of one holder with a policy other than
`not-allowed` are accepted. Only from this computer.

## Request body

Required, `application/json`, schema `PoolingConsentRequest`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `acknowledge` | string | yes | The current `notice.version`. |
| `accounts` | array of `AccountId` | yes |  |

Example:

```json
{
  "acknowledge": "<notice version from GET /v1/pooling>",
  "accounts": [
    "demo-paper"
  ]
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Pooling state after the change. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `PoolingState` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`PoolingState`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `consent` | object or null | yes | Null while pooling is off. |
| `groups` | array of object | yes | Accounts grouped by holder. Only accounts of one holder are ever pooled. |
| `notice` | object | yes |  |

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
curl -s -X PUT "http://127.0.0.1:4300/v1/pooling/consent" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"acknowledge":"<notice version from GET /v1/pooling>","accounts":["demo-paper"]}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "PUT",
    "/v1/pooling/consent",
    body={
    "acknowledge": "<notice version from GET /v1/pooling>",
    "accounts": ["demo-paper"],
},
)
print(response.body)
```
