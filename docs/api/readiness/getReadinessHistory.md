# Recent readiness transitions (newest first)

`GET /v1/readiness/history`

| | |
|---|---|
| Area | [Readiness](../README.md#readiness) |
| Operation | `getReadinessHistory` |
| Scope | `read` |
| This computer only | no |
| Guide | [deployment.md](../../guides/deployment.md) |

- An API key with the `read` scope (any key).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `account` | query | `AccountId` | no |  |
| `limit` | query | integer, min 1, max 200 | no | Default `50`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Transitions. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `ReadinessTransition` | yes |  |
| `meta` | `Meta` + object | yes |  |

#### Each item of `data` (`ReadinessTransition`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `at` | string (date-time) | yes |  |
| `accountId` | `AccountId` | yes |  |
| `from` | `ReadinessState` | yes | Account trading readiness. Open enum: new values may be added. |
| `to` | `ReadinessState` | yes | Account trading readiness. Open enum: new values may be added. |
| `codes` | array of string | yes |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `ACCOUNT_FORBIDDEN` | 403 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/readiness/history" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/readiness/history")
print(response.body)
```
