# Take today's P&L snapshot now

`POST /v1/paper/accounts/{accountId}/daily`

| | |
|---|---|
| Area | [Paper](../README.md#paper) |
| Operation | `paperDailySnapshot` |
| Scope | `paper` |
| This computer only | no |
| Guide | [paper-margin.md](../../guides/paper-margin.md) |

- An API key with the `paper` scope (or `live`).

Marks the book to the latest prices and stores today's row. It never replaces today's end-of-day row, which it returns instead.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `accountId` | path | `AccountId` | yes |  |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Today's row. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `PaperDailyPnl` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`PaperDailyPnl`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `day` | string (date) | yes |  |
| `at` | string | yes | When the row was taken (IST |
| `source` | one of `eod`, `manual` | yes |  |
| `equity` | number | yes |  |
| `realised` | number | no |  |
| `unrealised` | number | no |  |
| `charges` | number | no |  |
| `pnl` | number | yes | The day's change in equity (from the previous row |
| `usedMargin` | number or null | no |  |
| `openPositions` | integer | no |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `ACCOUNT_FORBIDDEN` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `ACCOUNT_NOT_FOUND` | 404 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/paper/accounts/demo-paper/daily" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("POST", "/v1/paper/accounts/demo-paper/daily")
print(response.body)
```
