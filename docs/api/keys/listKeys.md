# List API keys (never the key itself)

`GET /v1/keys`

| | |
|---|---|
| Area | [Keys](../README.md#keys) |
| Operation | `listKeys` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

An admin key limited to some accounts lists only keys limited to those same accounts.

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Keys. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `KeyRecord` | yes |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data` (`KeyRecord`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `label` | string | yes |  |
| `scopes` | array of one of `read`, `paper`, `live`, `admin` | yes |  |
| `accounts` | `*` or array of `AccountId` | yes |  |
| `allowQuery` | boolean | no |  |
| `clientKind` | one of `script`, `excel`, `mcp`, `ui`, `other` | no |  |
| `createdAt` | string (date-time) | yes |  |
| `expiresAt` | string (date-time) or null (date-time) | no |  |
| `lastUsedAt` | string (date-time) or null (date-time) | no |  |
| `revokedAt` | string (date-time) or null (date-time) | no |  |

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
curl -s "http://127.0.0.1:4300/v1/keys" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/keys")
print(response.body)
```
