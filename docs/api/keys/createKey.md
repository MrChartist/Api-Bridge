# Create an API key

`POST /v1/keys`

| | |
|---|---|
| Area | [Keys](../README.md#keys) |
| Operation | `createKey` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

The key is in the response once and cannot be shown again; only a scrypt hash is stored.

## Request body

Required, `application/json`, schema `KeyCreateRequest`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `label` | string, up to 60 characters | yes |  |
| `scopes` | array of one of `read`, `paper`, `live`, `admin` | yes |  |
| `accounts` | `*` or array of `AccountId` | no |  |
| `expiresAt` | string (date-time) or null (date-time) | no |  |
| `allowQuery` | boolean | no | Allow ?key= use. Only for keys whose only scope is read. Default `false`. |
| `clientKind` | one of `script`, `excel`, `mcp`, `ui`, `other` | no |  |

Example:

```json
{
  "label": "my-script",
  "scopes": [
    "read",
    "paper"
  ],
  "accounts": "*",
  "clientKind": "script"
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 201 | Created. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 201 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `KeyCreated` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`KeyCreated`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `key` | string | yes | Shown once. |
| `record` | `KeyRecord` | yes |  |

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
curl -s -X POST "http://127.0.0.1:4300/v1/keys" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"label":"my-script","scopes":["read","paper"],"accounts":"*","clientKind":"script"}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "POST",
    "/v1/keys",
    body={
    "label": "my-script",
    "scopes": ["read", "paper"],
    "accounts": "*",
    "clientKind": "script",
},
)
print(response.body)
```
