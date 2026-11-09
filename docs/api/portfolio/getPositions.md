# Positions for one account (live from the broker, or paper)

`GET /v1/positions`

| | |
|---|---|
| Area | [Portfolio](../README.md#portfolio) |
| Operation | `getPositions` |
| Scope | `read` |
| This computer only | no |
| Guide | [safety.md](../../guides/safety.md) |

- An API key with the `read` scope (any key).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `account` | query | `AccountId` | yes |  |
| `mode` | query | one of `paper`, `live` | no | `paper` reads the account's paper book; `live` the broker's (default for portfolio reads). Default `"live"`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Positions. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `Position` | yes |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data` (`Position`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `symbol` | `Symbol` | yes | Canonical Bridge symbol (see the introduction). Inputs may use accepted aliases. |
| `product` | one of `CNC`, `INTRADAY`, `MARGIN`, `MTF`, `CO`, `BO` | yes |  |
| `netQty` | number | yes |  |
| `avgPrice` | number | yes |  |
| `ltp` | number or null | no |  |
| `pnl` | number | yes |  |
| `realisedPnl` | number or null | no |  |
| `unrealisedPnl` | number or null | no |  |
| `charges` | number or null | no | Paper accounts only; estimated brokerage and taxes. |

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
curl -s "http://127.0.0.1:4300/v1/positions?account=demo-paper" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.positions("demo-paper")
print(result)
```
