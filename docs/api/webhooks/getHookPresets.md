# Address presets, trusted-tunnel header and public hosts, for building a hook

`GET /v1/hooks/presets`

| | |
|---|---|
| Area | [Webhooks](../README.md#webhooks) |
| Operation | `getHookPresets` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [webhooks.md](../../guides/webhooks.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

What the hook creator needs to show: the editable TradingView sender-address list (with the date it was last
checked and where it came from), `hooks.clientIpHeader` (the header trusted for the real client address behind a
local tunnel; null means the address check sees the tunnel), and the public ingress hosts from the config.

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Presets. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `HookPresets` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`HookPresets`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `ipPresets` | array of `HookIpPreset` | yes |  |
| `clientIpHeader` | one of `cf-connecting-ip`, `x-forwarded-for`, `x-real-ip`, `null` | yes | hooks.clientIpHeader: trusted for the real client address only when the connection comes from this computer (a local tunnel). |
| `publicIngress` | object | yes |  |
| `tradingview` | object | no |  |
| `limits` | object | no |  |

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
curl -s "http://127.0.0.1:4300/v1/hooks/presets" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/hooks/presets")
print(response.body)
```
