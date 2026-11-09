# Connect or log in to the broker

`POST /v1/accounts/{accountId}/session`

| | |
|---|---|
| Area | [Accounts](../README.md#accounts) |
| Operation | `connectAccount` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [accounts.md](../../guides/accounts.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

Saves the non-secret values (API key, client id, access token) encrypted at rest, then logs in where the broker
needs it. For session-login brokers send the password/PIN and the current 6-digit TOTP code in `secrets`: they
are used once for the broker login and never stored, cached or logged. Admin scope, this computer only.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `accountId` | path | `AccountId` | yes |  |

## Request body

Required, `application/json`, schema `SessionConnectRequest`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `values` | object | no | Non-secret fields the broker needs (apiKey, clientId, accessToken ...). Stored encrypted. |
| `secrets` | object | no | Password/PIN and the current TOTP code for session-login brokers. Used once, never stored. |

Example:

```json
{
  "values": {
    "apiKey": "<broker api key>",
    "clientId": "<client id>"
  }
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | New session state. | application/json: object |
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
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `ACCOUNT_FORBIDDEN` | 403 | no |
| `LOOPBACK_ONLY` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `ACCOUNT_NOT_FOUND` | 404 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/accounts/demo-paper/session" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"values":{"apiKey":"<broker api key>","clientId":"<client id>"}}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "POST",
    "/v1/accounts/demo-paper/session",
    body={"values": {"apiKey": "<broker api key>", "clientId": "<client id>"}},
)
print(response.body)
```
