# Remove a key's override

`DELETE /v1/quotas/{keyId}`

| | |
|---|---|
| Area | [Quotas](../README.md#quotas) |
| Operation | `clearQuota` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [rate-limits.md](../../guides/rate-limits.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

The key goes back to the quota from the configuration, or the default for its client kind.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `keyId` | path | string, up to 64 characters | yes | The key id (not the secret) from `GET /v1/keys`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The key's quota as it is now. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `QuotaKey` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`QuotaKey`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `keyId` | string | yes |  |
| `label` | string | yes |  |
| `clientKind` | one of `ui`, `mcp`, `excel`, `script`, `other` | yes |  |
| `weight` | number, min 0 | yes | Share in the fair queue against other keys. |
| `perSecond` | number | yes |  |
| `burst` | number | yes |  |
| `perDay` | integer or null | yes | Daily request cap; null for none. |
| `usage` | object | yes |  |
| `source` | one of `default`, `config`, `override` | yes |  |

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
curl -s -X DELETE "http://127.0.0.1:4300/v1/quotas/<keyId>" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("DELETE", "/v1/quotas/<keyId>")
print(response.body)
```
