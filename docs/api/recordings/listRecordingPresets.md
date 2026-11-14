# The one-click presets

`GET /v1/recordings/presets`

| | |
|---|---|
| Area | [Recordings](../README.md#recordings) |
| Operation | `listRecordingPresets` |
| Scope | `read` |
| This computer only | no |

- An API key with the `read` scope (any key).

Record index option chains, and Record my watchlist.

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Presets. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `RecordingPreset` | yes |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data` (`RecordingPreset`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | one of `index-option-chains`, `my-watchlist` | no |  |
| `title` | string | no |  |
| `about` | string | no |  |
| `needs` | string | no |  |
| `rule` | `RecordingRuleCreate` | no | Give exactly one of symbols, collection or underlying (with universe). |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `UNAUTHENTICATED` | 401 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/recordings/presets" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/recordings/presets")
print(response.body)
```
