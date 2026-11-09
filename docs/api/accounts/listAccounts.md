# Your configured accounts and their session state

`GET /v1/accounts`

| | |
|---|---|
| Area | [Accounts](../README.md#accounts) |
| Operation | `listAccounts` |
| Scope | `read` |
| This computer only | no |
| Guide | [accounts.md](../../guides/accounts.md) |

- An API key with the `read` scope (any key).

Only accounts this key may use are listed. Never includes credentials.

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Accounts. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `AccountSummary` | yes |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data` (`AccountSummary`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | `AccountId` | yes |  |
| `broker` | string | yes |  |
| `label` | string | yes |  |
| `enabled` | boolean | yes |  |
| `session` | `SessionState` | yes |  |
| `liveAllowedByConfig` | boolean | yes |  |
| `liveSources` | array of one of `rest`, `webhook`, `mcp`, `cli`, `guard`, `alert` | no | accounts[].live.allowedSources: the tools that may send this account live orders (live still needs liveAllowedByConfig). |
| `pooling` | boolean | yes | This account's market-data budget may serve requests that did not name an account. |
| `capabilities` | array of string | yes |  |
| `authKind` | string or null | no |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `UNAUTHENTICATED` | 401 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/accounts" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.accounts()
print(result)
```
