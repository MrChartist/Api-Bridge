# Turn a source on or off

`PATCH /v1/sources/{id}`

| | |
|---|---|
| Area | [Sources](../README.md#sources) |
| Operation | `updateSource` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [sources.md](../../guides/sources.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

`enabled: true` turns a source on. An `opt-in` source (unofficial or terms-sensitive) also needs `acknowledge`
equal to its `noticeVersion`, which records that you read the notice; a `byok` source needs its key stored
first (`PUT /v1/sources/{id}/config`). A stale or missing acknowledgement is refused. `enabled: false`
turns it off at once. Your broker accounts (`builtin`) cannot be switched off here. The answer also repeats the
source's fields at the top level of the body, as older clients read them there; read `data`.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes | A source id from `GET /v1/sources`. |

## Request body

Required, `application/json`, schema `SourceUpdate`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `enabled` | boolean | no |  |
| `acknowledge` | string, up to 64 characters | no | The source's `noticeVersion`, to turn on an opt-in source. |

Example:

```json
{
  "enabled": false
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The source as it is now. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `DataSource` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`DataSource`)

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
| `needsAcknowledgement` | boolean | no | Opt-in sources: true until the notice has been accepted. |
| `consent` | object or null | no | When you acknowledged the notice, or null. |
| `version` | string | no | Plugins only: the plugin's own version. |
| `flags` | array of string | no | Labels every answer from this source carries, for example `plugin`, `unofficial`, `delayed`. |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `LOOPBACK_ONLY` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X PATCH "http://127.0.0.1:4300/v1/sources/demo" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"enabled":false}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("PATCH", "/v1/sources/demo", body={"enabled": False})
print(response.body)
```
