# Check the audit log's hash chain

`GET /v1/audit/verify`

| | |
|---|---|
| Area | [Safety](../README.md#safety) |
| Operation | `verifyAudit` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `day` | query | string (date) | no |  |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Verification result. | application/json: object |
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
| `ok` | boolean | yes |  |
| `checked` | integer | yes |  |
| `brokenAt` | integer or null | yes |  |

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
curl -s "http://127.0.0.1:4300/v1/audit/verify" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/audit/verify")
print(response.body)
```
