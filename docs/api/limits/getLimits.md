# Broker limits, safety limits and current budgets per account

`GET /v1/limits`

| | |
|---|---|
| Area | [Limits](../README.md#limits) |
| Operation | `getLimits` |
| Scope | `read` |
| This computer only | no |
| Guide | [rate-limits.md](../../guides/rate-limits.md) |

- An API key with the `read` scope (any key).

With `explain=1` the report also says why a request may have been slow or refused, in numbers instead of log lines (`pools`, `consumers`).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `account` | query | `AccountId` | no | Pin the request to this account. Without it, market data may be served from any of your accounts that allow pooling. |
| `explain` | query | boolean | no | `1` or `true` adds `pools` (the shared bucket groups: spare budget, ceiling and back-off) and `consumers` (queued, in-flight and fair share per consumer) and `savedCalls` (broker calls not made today). Default `false`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Limits report. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `LimitsReport` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`LimitsReport`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `safety` | object | no | Effective safety limits per account (the stricter of global and account values). |
| `brokers` | object | no |  |
| `client` | object | no | This key's own request budget. |
| `pools` | array of `LimitsPool` | no | Only with `explain=1`. The shared bucket groups behind the broker accounts. |
| `consumers` | array of `LimitsConsumer` | no | Only with `explain=1`. Who is waiting in the fair queue and each one's share. |
| `savedCalls` | object | no | Only with `explain=1`. Broker calls not made today because the data was already on this computer, in the stream or in the cache. |

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
curl -s "http://127.0.0.1:4300/v1/limits" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.limits()
print(result)
```
