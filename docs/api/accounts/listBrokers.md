# Supported brokers and what each can do

`GET /v1/brokers`

| | |
|---|---|
| Area | [Accounts](../README.md#accounts) |
| Operation | `listBrokers` |
| Scope | `read` |
| This computer only | no |
| Guide | [accounts.md](../../guides/accounts.md) |

- An API key with the `read` scope (any key).

Capabilities come from each adapter's declared contract; limits from the Bridge's broker policy table (each number marked verified or not).

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | All broker adapters. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `BrokerInfo` | yes |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data` (`BrokerInfo`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `name` | string | yes |  |
| `authKind` | one of `apiKeyToken`, `oauthRedirect`, `requestTokenExchange`, `sessionLogin` | yes |  |
| `capabilities` | array of string | yes |  |
| `verified` | boolean | yes | Checked end to end against a live account (verification.level is live-verified). |
| `verification` | object | no | Where the broker sits on the verification ladder (server/brokers/verification.json): beta (recorded samples only), contract (every contract case passes), sandbox, live-verified. |
| `singleSession` | boolean | no | Present and true when a second login for the same app ends the first session (the dashboard warns before login). |
| `credentialFields` | array of string | no | Keys to send in SessionConnectRequest.values. |
| `loginFields` | array of object | no | sessionLogin brokers only: keys to send in SessionConnectRequest.secrets (used once, never stored). |
| `tokenExpiry` | string or null | no | When the broker's session usually ends, as the broker documents it. |
| `loginUrl` | string | no | The broker's own login page, with {field} placeholders that are all credentialFields (e.g. {apiKey}). Only for brokers that declare one. |
| `policy` | `BrokerPolicy` | no |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `UNAUTHENTICATED` | 401 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/brokers" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.brokers()
print(result)
```
