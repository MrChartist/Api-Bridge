# Funds and margin for one account

`GET /v1/funds`

| | |
|---|---|
| Area | [Portfolio](../README.md#portfolio) |
| Operation | `getFunds` |
| Scope | `read` |
| This computer only | no |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `read` scope (any key).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `account` | query | `AccountId` | yes | The account id from your config (`GET /v1/accounts` lists them). Always required here, even with one account: the Bridge never guesses whose positions, holdings or funds to show, and answers 400 VALIDATION_FAILED without it. |
| `mode` | query | one of `paper`, `live` | no | `paper` reads the account's paper book; `live` the broker's (default for portfolio reads). Default `"live"`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Funds. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `Funds` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`Funds`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `availableCash` | number | yes |  |
| `usedMargin` | number | yes |  |
| `totalBalance` | number or null | no |  |
| `collateral` | number or null | no |  |
| `withdrawable` | number or null | no |  |
| `realisedPnl` | number or null | no |  |
| `unrealisedPnl` | number or null | no |  |
| `charges` | number or null | no | Paper accounts: the estimated charges taken so far. |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `ACCOUNT_FORBIDDEN` | 403 | no |
| `SESSION_EXPIRED` | 422 | no |
| `RATE_LIMITED` | 429 | yes |
| `UPSTREAM_RATE_LIMITED` | 429 | yes |
| `UPSTREAM_ERROR` | 502 | no |
| `BROKER_UNAVAILABLE` | 503 | yes |
| `UPSTREAM_TIMEOUT` | 504 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/funds?account=demo-paper" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.funds("demo-paper")
print(result)
```
