# Create a hook; the URL with its token is shown once

`POST /v1/hooks`

| | |
|---|---|
| Area | [Webhooks](../README.md#webhooks) |
| Operation | `createHook` |
| Scope | `admin` |
| This computer only | yes |
| Idempotency-Key | send one on every write |
| Guide | [webhooks.md](../../guides/webhooks.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).
- Send an `Idempotency-Key` (8 to 255 characters); a retry with the same key returns the first result.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string, up to 255 characters | no | Your unique id for this write (UUID recommended). A retry with the same key and the same body returns the first result with `Idempotency-Replayed: true`; a different body is refused with 409 IDEMPOTENCY_KEY_REUSED; a retry while the first is still running gets 409 IDEMPOTENCY_IN_PROGRESS. Keys are kept until the end of the IST trading day and at least 24 hours. For POST /v1/orders, `clientOrderId` in the body works the same way when the header is absent. The create routes that are not orders honour it too, with the same rules: keys, accounts, hooks, notify targets, collections (create, import, duplicate), downloads, dataset updates, subscriptions, recordings, recording rules and recording presets. For these the stored answer is kept in memory for 24 hours and is forgotten on restart, and a request that failed is forgotten at once so it can be retried. The compat order routes (`/api/v1/placeorder` and the other order writes) honour it too, and a client that cannot set headers may send `idempotency_key` in the body. Every other write route ignores the header, whatever its value, and says so with `Idempotency-Ignored: true` in the answer; a malformed key is a 400 only on a route that uses it. |

## Request body

Required, `application/json`, schema `HookCreate`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `source` | one of `generic`, `chartink`, `gocharting`, `tradingview` | yes |  |
| `label` | string, up to 60 characters | yes |  |
| `account` | `AccountId` | yes |  |
| `mode` | one of `paper`, `live` | no | Default `"paper"`. |
| `requireConfirmation` | boolean | no | Default `false`. |
| `allowedSymbols` | array of `Symbol` | no |  |
| `maxLotsPerSignal` | integer, min 1 | no | Default `1`. |
| `product` | one of `CNC`, `INTRADAY`, `MARGIN` | no |  |
| `orderType` | one of `LIMIT`, `MARKET`, `SL`, `SL-M` | no | SL and SL-M (stop-loss) hooks need a triggerPrice in every alert; not available for chartink. Default `"LIMIT"`. |
| `side` | one of `BUY`, `SELL` | no | Fix the side for every signal (needed for ChartInk, whose alerts carry no side). |
| `allowSourceIps` | array of string | no | Optional allowlist of sender IP addresses or IPv4 CIDR blocks. |
| `acknowledgeUnsignedLive` | boolean | no | Live mode on an unsigned source (chartink, gocharting, tradingview) needs allowSourceIps, sourceIpPreset, requireConfirmation or this acknowledgement. Default `false`. |
| `maxAgeSec` | integer, min 5, max 3600 or null | no | Refuse alerts older than this many seconds (from the alert's `time`). Default 120 for tradingview; a live tradingview hook must have one. |
| `sourceIpPreset` | one of `tradingview`, `null` | no | Accept alerts only from TradingView's published sender addresses (the editable list in /v1/hooks/presets), in addition to allowSourceIps. Behind a tunnel this needs hooks.clientIpHeader. |

Example:

```json
{
  "source": "generic",
  "label": "my alert",
  "account": "demo-paper",
  "mode": "paper"
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 201 | Created. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 201 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `Hook` + object | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data`

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
| `orderType` | one of `LIMIT`, `MARKET`, `SL`, `SL-M` | no |  |
| `allowSourceIps` | array of string | no |  |
| `sourceIpPreset` | one of `tradingview`, `null` | no | Also accept alerts only from this published address list (see /v1/hooks/presets). |
| `maxAgeSec` | integer or null | no | An alert whose own time is older than this many seconds is refused as stale. TradingView hooks default to 120; null means no age check. |
| `hasPassphrase` | boolean | no | True for tradingview hooks: alerts must carry the passphrase shown when the hook was created. |
| `acknowledgeUnsignedLive` | boolean | no | A live hook on an unsigned source was acknowledged as such when it was made. |
| `createdByKeyId` | string or null | no | The key that made the hook. |
| `templates` | array of `HookTemplate` | no | Ready-to-paste alert message templates for this source (for tradingview a plain alert |
| `createdAt` | string (date-time) | yes |  |
| `lastSignalAt` | string (date-time) or null (date-time) | no |  |
| `readiness` | `ReadinessState` or null | no | Live hooks: the readiness state of the hook's account (orders are refused with CANNOT_TRADE while it is cannot_trade). null for paper hooks. |
| `url` | string | yes | Full hook URL including the secret token. Shown once. |
| `path` | string | no | The URL path alone (for tunnels and public ingress). Shown once. |
| `signingSecret` | string | no | For generic hooks only. Shown once. |
| `passphrase` | string | no | For tradingview hooks only. Shown once; only its hash is stored. It goes inside the alert message. |
| `ipPreset` | `HookIpPreset` | no |  |
| `warnings` | array of string | no |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `LOOPBACK_ONLY` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | yes |
| `IDEMPOTENCY_KEY_REUSED` | 409 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/hooks" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-order-0001" \
  -d '{"source":"generic","label":"my alert","account":"demo-paper","mode":"paper"}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "POST",
    "/v1/hooks",
    body={
    "source": "generic",
    "label": "my alert",
    "account": "demo-paper",
    "mode": "paper",
},
    idempotency_key="my-order-0001",
)
print(response.body)
```
