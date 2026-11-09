# Withdraw the pooling consent

`DELETE /v1/pooling/consent`

| | |
|---|---|
| Area | [Pooling](../README.md#pooling) |
| Operation | `revokePooling` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [rate-limits.md](../../guides/rate-limits.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

Each account serves only its own reads again.

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
| `UNAUTHENTICATED` | 401 | no |
| `LOOPBACK_ONLY` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X DELETE "http://127.0.0.1:4300/v1/pooling/consent" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("DELETE", "/v1/pooling/consent")
print(response.body)
```
