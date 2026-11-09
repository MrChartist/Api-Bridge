# How much of each budget is used, queued and saved by streaming, caching and coalescing

`GET /v1/usage`

| | |
|---|---|
| Area | [Limits](../README.md#limits) |
| Operation | `getUsage` |
| Scope | `read` |
| This computer only | no |
| Guide | [rate-limits.md](../../guides/rate-limits.md) |

- An API key with the `read` scope (any key).

Per account and endpoint class: the binding window, every window (`windows`: this second, this minute, today) and
today's counters. `series=1` adds each account's calls per second over the last two minutes (`series`).
`view=budget` answers the dashboard's budget summary instead (the `budget` stream message). Admin keys also get
`consumers`: today's broker calls and saved calls per dashboard page, API key label, MCP, compat and background job.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `series` | query | boolean | no | Default `false`. |
| `view` | query | one of `budget` | no |  |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Usage report. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `UsageReport` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`UsageReport`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `accounts` | array of object | no |  |
| `savings` | object | no | Broker calls avoided today. |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/usage" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.usage()
print(result)
```
