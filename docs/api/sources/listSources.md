# Data sources, what each one is, and whether it is on

`GET /v1/sources`

| | |
|---|---|
| Area | [Sources](../README.md#sources) |
| Operation | `listSources` |
| Scope | `read` |
| This computer only | no |
| Guide | [sources.md](../../guides/sources.md) |

- An API key with the `read` scope (any key).

Every place the Bridge can read market data from: your broker accounts (`kind: broker`, always first for
real-time data), the built-in free providers, and plugins you granted. Each row says how current its data is
(`class`, `delaySec`), whether it is `official`, what it may be asked (`capabilities`), the vendor's documented
`limits`, how much of them the Bridge used (`usage`), its `health`, and the terms you accept by turning it on.
API keys of sources that need one are never returned; `configured` only says whether one is stored.

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Sources. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `DataSource` | yes |  |
| `meta` | `Meta` + object | yes |  |

#### Each item of `data` (`DataSource`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `name` | string | yes |  |
| `kind` | one of `broker`, `free`, `plugin` | yes |  |
| `tier` | one of `builtin`, `byok`, `opt-in`, `plugin` | yes | `builtin` your own broker accounts (on); `byok` you hold the vendor account and a key; `opt-in` unofficial or terms-sensitive, off until you acknowledge a notice; `plugin` third-party code you granted. |
| `enabled` | boolean | yes |  |
| `configured` | boolean | yes | Ready to use: it has its key when it needs one. |
| `class` | `DataClass` | yes | How current an answer is. `realtime`: from your own broker account (or its live stream). `delayed`: the source is slow by nature (usually about 15 minutes). `eod`: end-of-day values only. A composite answer (an option chain, a many-symbol quote) takes the least current class of its parts. `delayed` is not the same as `freshness.stale`: stale means older than the freshness target for that source. |
| `delaySec` | integer or null | yes | Typical delay of a delayed source; 0 for real-time; null where it does not apply. |
| `official` | boolean | yes | True only for a documented API from the data's owner or your own broker. Plugins are never official. |
| `capabilities` | array of `SourceCapability` | yes |  |
| `limits` | object | yes | The vendor's documented limits. The Bridge never goes above them. |
| `usage` | object | yes |  |
| `health` | `SourceHealth` | yes |  |
| `terms` | object or null | no | The vendor's terms. Null for your own broker accounts. |
| `noticeVersion` | string | no | Opt-in sources: the notice version `acknowledge` must equal to turn it on. |
| `needsKey` | boolean | yes |  |
| `consent` | object or null | no | When you acknowledged the notice, or null. |
| `version` | string | no | Plugins only: the plugin's own version. |
| `flags` | array of string | no | Labels every answer from this source carries, for example `plugin`, `unofficial`, `delayed`. |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `UNAUTHENTICATED` | 401 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/sources" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/sources")
print(response.body)
```
