# Daily P&L snapshots of a paper account, oldest first

`GET /v1/paper/accounts/{accountId}/daily`

| | |
|---|---|
| Area | [Paper](../README.md#paper) |
| Operation | `paperDailyPnl` |
| Scope | `read` |
| This computer only | no |
| Guide | [paper-margin.md](../../guides/paper-margin.md) |

- An API key with the `read` scope (any key).

One row per IST day: equity, realised, unrealised, charges, the day's change in equity (`pnl`), used margin and open positions. Taken at the end of each session (the first maintenance pass after the session end, or the day roll) and on demand.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `accountId` | path | `AccountId` | yes |  |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The snapshots. | application/json: object |
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
| `items` | array of `PaperDailyPnl` | yes |  |

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
curl -s "http://127.0.0.1:4300/v1/paper/accounts/demo-paper/daily" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/paper/accounts/demo-paper/daily")
print(response.body)
```
