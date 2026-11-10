# Create the preset's rule and turn auto-record on

`POST /v1/recordings/presets/{presetId}/apply`

| | |
|---|---|
| Area | [Recordings](../README.md#recordings) |
| Operation | `applyRecordingPreset` |
| Scope | `admin` |
| This computer only | yes |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

Applying a preset again does not duplicate its rule (answers 200). my-watchlist reads a collection named watchlist unless the body names another; it needs the library of collections (422 when it is not there).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `presetId` | path | one of `index-option-chains`, `my-watchlist` | yes |  |

## Request body

Required, `application/json`, schema `RecordingPresetApply`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `collection` | string | no | my-watchlist only: the collection to record (default watchlist). |

Example:

```json
{}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 201 | Applied. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 201 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `RecordingPresetResult` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`RecordingPresetResult`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `preset` | string | no |  |
| `created` | boolean | no |  |
| `rule` | `RecordingRule` | no |  |
| `auto` | `RecordingAuto` | no |  |

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
curl -s -X POST "http://127.0.0.1:4300/v1/recordings/presets/index-option-chains/apply" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("POST", "/v1/recordings/presets/index-option-chains/apply", body={})
print(response.body)
```
