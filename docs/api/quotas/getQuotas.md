# Each API key's share of the Bridge

`GET /v1/quotas`

| | |
|---|---|
| Area | [Quotas](../README.md#quotas) |
| Operation | `getQuotas` |
| Scope | `read` |
| This computer only | no |
| Guide | [rate-limits.md](../../guides/rate-limits.md) |

- An API key with the `read` scope (any key).

Every key has a request quota (a token bucket) and a weight in the fair queue, so one runaway spreadsheet cannot
starve an AI assistant. `kinds` are the default weights by client kind (`ui`, `mcp`, `excel`, `script`, `other`);
`keys[].source` says whether a key's figures are the default, from the configuration, or an override set with
`PUT /v1/quotas/{keyId}`. `usage` counts requests and how often the key was throttled.

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Quotas. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `QuotasReport` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`QuotasReport`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `default` | object | yes |  |
| `kinds` | object | yes | Default fair-queue weight by client kind. |
| `keys` | array of `QuotaKey` | yes |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `UNAUTHENTICATED` | 401 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/quotas" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/quotas")
print(response.body)
```
