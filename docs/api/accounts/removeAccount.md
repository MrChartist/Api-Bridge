# Remove an account (from the config file and the running Bridge)

`DELETE /v1/accounts/{accountId}`

| | |
|---|---|
| Area | [Accounts](../README.md#accounts) |
| Operation | `removeAccount` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [accounts.md](../../guides/accounts.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

For an account added by mistake. Removes it from the config file and the running Bridge and deletes its saved
keys and session from the encrypted store; its paper-trading history stays in the data folder. Refuses an
account with live trading set up in the config file (remove those in the file, on purpose) and the last paper
account. Admin scope with an admin key that may use every account, this computer only. Refused in demo mode.
Audited as `account.removed`.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `accountId` | path | `AccountId` | yes |  |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The account was removed. | application/json: object |
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
| `id` | string | yes |  |
| `removed` | boolean | yes |  |
| `savedKeysDeleted` | boolean | yes |  |
| `restartNeeded` | boolean | yes |  |

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
curl -s -X DELETE "http://127.0.0.1:4300/v1/accounts/demo-paper" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("DELETE", "/v1/accounts/demo-paper")
print(response.body)
```
