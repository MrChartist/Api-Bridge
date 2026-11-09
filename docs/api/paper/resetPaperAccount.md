# Clear paper orders and positions and start again

`POST /v1/paper/accounts/{accountId}/reset`

| | |
|---|---|
| Area | [Paper](../README.md#paper) |
| Operation | `resetPaperAccount` |
| Scope | `paper` |
| This computer only | no |
| Guide | [paper-margin.md](../../guides/paper-margin.md) |

- An API key with the `paper` scope (or `live`).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `accountId` | path | `AccountId` | yes |  |

## Request body

Optional, `application/json`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `startingCapital` | number, min 10000, max 1000000000 | no |  |

Example:

```json
{
  "startingCapital": 1000000
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The fresh paper account. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `PaperAccount` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`PaperAccount`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `accountId` | `AccountId` | yes |  |
| `startingCapital` | number | yes |  |
| `createdAt` | string (date-time) | no |  |
| `resetAt` | string (date-time) or null (date-time) | no |  |
| `ordersToday` | integer | no |  |
| `funds` | `Funds` | yes |  |
| `fillModel` | string | no | Short description of how paper fills are simulated. |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `ACCOUNT_FORBIDDEN` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `ACCOUNT_NOT_FOUND` | 404 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/paper/accounts/demo-paper/reset" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"startingCapital":1000000}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.reset_paper_account("demo-paper", starting_capital=1000000)
print(result)
```
