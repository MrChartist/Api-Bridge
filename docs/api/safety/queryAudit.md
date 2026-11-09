# Read the append-only audit log

`GET /v1/audit`

| | |
|---|---|
| Area | [Safety](../README.md#safety) |
| Operation | `queryAudit` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `from` | query | string (date-time) | no |  |
| `to` | query | string (date-time) | no |  |
| `type` | query | string, up to 64 characters | no |  |
| `account` | query | `AccountId` | no | Pin the request to this account. Without it, market data may be served from any of your accounts that allow pooling. |
| `limit` | query | integer, min 1, max 500 | no | Default `100`. |
| `cursor` | query | string, up to 512 characters | no | Opaque cursor from `meta.nextCursor`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | A page of audit records. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `AuditRecord` | yes |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data` (`AuditRecord`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `seq` | integer | yes |  |
| `at` | string (date-time) | yes |  |
| `type` | string | yes |  |
| `actor` | object | yes |  |
| `source` | string | yes |  |
| `accountId` | string or null | no |  |
| `requestId` | string or null | no |  |
| `data` | object | no |  |
| `prevHash` | string | yes |  |
| `hash` | string | yes |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `ACCOUNT_FORBIDDEN` | 403 | no |
| `LOOPBACK_ONLY` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/audit" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/audit")
print(response.body)
```
