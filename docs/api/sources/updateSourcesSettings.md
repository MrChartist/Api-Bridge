# Use free sources automatically when your brokers cannot answer

`PATCH /v1/sources/settings`

| | |
|---|---|
| Area | [Sources](../README.md#sources) |
| Operation | `updateSourcesSettings` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [sources.md](../../guides/sources.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

`autoFallback: true` lets a read that no broker account can answer go to a source you turned on, without the
read asking for `backup=true`. It applies to display and analysis reads only; orders, risk checks, paper fills
and alerts never use it, and every answer is labelled with its data class and delay. The choice is saved in the
Bridge's data folder and wins over `sources.autoFallback` in the configuration file. Changes are audited
(`sources.setting_changed`). Only from this computer.

## Request body

Required, `application/json`, schema `SourcesSettingsUpdate`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `autoFallback` | boolean | yes | Use free sources automatically when your brokers cannot answer a display or analysis read. |

Example:

```json
{
  "autoFallback": false
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The setting as it is now. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `SourcesSettings` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`SourcesSettings`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `autoFallback` | boolean | yes |  |
| `autoFallbackSource` | one of `setting`, `config`, `default` | yes |  |
| `persisted` | boolean | no | False when the choice holds for this run but could not be written to the data folder. |

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
curl -s -X PATCH "http://127.0.0.1:4300/v1/sources/settings" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"autoFallback":false}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("PATCH", "/v1/sources/settings", body={"autoFallback": False})
print(response.body)
```
