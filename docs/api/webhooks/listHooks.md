# List configured hooks (never the token)

`GET /v1/hooks`

| | |
|---|---|
| Area | [Webhooks](../README.md#webhooks) |
| Operation | `listHooks` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [webhooks.md](../../guides/webhooks.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

An admin key limited to some accounts lists only the hooks of those accounts.

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Hooks. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `Hook` | yes |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data` (`Hook`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `source` | one of `generic`, `chartink`, `gocharting`, `tradingview` | yes |  |
| `label` | string | yes |  |
| `account` | `AccountId` | yes |  |
| `mode` | one of `paper`, `live` | yes |  |
| `requireConfirmation` | boolean | no |  |
| `allowedSymbols` | array of `Symbol` | no |  |
| `maxLotsPerSignal` | integer | no |  |
| `side` | one of `BUY`, `SELL`, `null` | no |  |
| `product` | one of `CNC`, `INTRADAY`, `MARGIN`, `null` | no |  |
| `orderType` | one of `LIMIT`, `MARKET` | no |  |
| `allowSourceIps` | array of string | no |  |
| `sourceIpPreset` | one of `tradingview`, `null` | no | Also accept alerts only from this published address list (see /v1/hooks/presets). |
| `maxAgeSec` | integer or null | no | An alert whose own time is older than this many seconds is refused as stale. TradingView hooks default to 120; null means no age check. |
| `hasPassphrase` | boolean | no | True for tradingview hooks: alerts must carry the passphrase shown when the hook was created. |
| `createdAt` | string (date-time) | yes |  |
| `lastSignalAt` | string (date-time) or null (date-time) | no |  |
| `readiness` | `ReadinessState` or null | no | Live hooks: the readiness state of the hook's account (orders are refused with CANNOT_TRADE while it is cannot_trade). null for paper hooks. |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `UNAUTHENTICATED` | 401 | no |
| `LOOPBACK_ONLY` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/hooks" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/hooks")
print(response.body)
```
