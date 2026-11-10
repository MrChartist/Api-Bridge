# Create an API key

`POST /v1/keys`

| | |
|---|---|
| Area | [Keys](../README.md#keys) |
| Operation | `createKey` |
| Scope | `admin` |
| This computer only | yes |
| Idempotency-Key | send one on every write |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).
- Send an `Idempotency-Key` (8 to 255 characters); a retry with the same key returns the first result.

The key is in the response once and cannot be shown again; only a scrypt hash is stored.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string, up to 255 characters | no | Your unique id for this write (UUID recommended). A retry with the same key and the same body returns the first result with `Idempotency-Replayed: true`; a different body is refused with 409 IDEMPOTENCY_KEY_REUSED; a retry while the first is still running gets 409 IDEMPOTENCY_IN_PROGRESS. Keys are kept until the end of the IST trading day and at least 24 hours. For POST /v1/orders, `clientOrderId` in the body works the same way when the header is absent. The create routes that are not orders honour it too, with the same rules: keys, accounts, hooks, notify targets, collections (create, import, duplicate), downloads, dataset updates, subscriptions, recordings, recording rules and recording presets. For these the stored answer is kept in memory for 24 hours and is forgotten on restart, and a request that failed is forgotten at once so it can be retried. The compat order routes (`/api/v1/placeorder` and the other order writes) honour it too, and a client that cannot set headers may send `idempotency_key` in the body. Every other write route ignores the header, whatever its value, and says so with `Idempotency-Ignored: true` in the answer; a malformed key is a 400 only on a route that uses it. |

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
| `IDEMPOTENCY_IN_PROGRESS` | 409 | yes |
| `IDEMPOTENCY_KEY_REUSED` | 409 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/keys" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-order-0001" \
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
    idempotency_key="my-order-0001",
)
print(response.body)
```
