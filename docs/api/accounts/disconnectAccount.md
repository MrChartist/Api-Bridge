# Forget the broker session (saved keys stay)

`DELETE /v1/accounts/{accountId}/session`

| | |
|---|---|
| Area | [Accounts](../README.md#accounts) |
| Operation | `disconnectAccount` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [accounts.md](../../guides/accounts.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `accountId` | path | `AccountId` | yes |  |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Session state after logout. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `SessionState` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`SessionState`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `state` | one of `connected`, `expired`, `missing`, `error`, `checking` | yes |  |
| `expiresAt` | string (date-time) or null (date-time) | no |  |
| `checkedAt` | string (date-time) or null (date-time) | no |  |
| `message` | string or null | no |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `ACCOUNT_FORBIDDEN` | 403 | no |
| `LOOPBACK_ONLY` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `ACCOUNT_NOT_FOUND` | 404 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X DELETE "http://127.0.0.1:4300/v1/accounts/demo-paper/session" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("DELETE", "/v1/accounts/demo-paper/session")
print(response.body)
```
