# Revoke a key (takes effect immediately)

`DELETE /v1/keys/{keyId}`

| | |
|---|---|
| Area | [Keys](../README.md#keys) |
| Operation | `revokeKey` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

An admin key limited to some accounts can revoke only keys limited to those accounts; any other key answers 404, as an unknown id does.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `keyId` | path | string | yes |  |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The revoked key. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `KeyRecord` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`KeyRecord`)

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
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `LOOPBACK_ONLY` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X DELETE "http://127.0.0.1:4300/v1/keys/<keyId>" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("DELETE", "/v1/keys/<keyId>")
print(response.body)
```
