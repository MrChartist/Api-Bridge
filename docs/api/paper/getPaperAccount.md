# Paper account summary

`GET /v1/paper/accounts/{accountId}`

| | |
|---|---|
| Area | [Paper](../README.md#paper) |
| Operation | `getPaperAccount` |
| Scope | `read` |
| This computer only | no |
| Guide | [paper-margin.md](../../guides/paper-margin.md) |

- An API key with the `read` scope (any key).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `accountId` | path | `AccountId` | yes |  |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Summary. | application/json: object |
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
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `ACCOUNT_FORBIDDEN` | 403 | no |
| `ACCOUNT_NOT_FOUND` | 404 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/paper/accounts/demo-paper" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.paper_account("demo-paper")
print(result)
```
