# The budget share and the after-hours switch downloads use now

`GET /v1/downloads/settings`

| | |
|---|---|
| Area | [Data downloads](../README.md#data-downloads) |
| Operation | `getDownloadSettings` |
| Scope | `read` |
| This computer only | no |

- An API key with the `read` scope (any key).

The values in force (the config values unless changed here), the config defaults and the allowed range.

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The settings. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `DownloadSettings` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`DownloadSettings`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `maxBudgetShare` | number, min 0.05, max 0.8 | yes | The share of an account's spare API budget downloads may use now. |
| `afterHoursOnly` | boolean | yes | Jobs wait for the market to close (unless a job says otherwise). |
| `defaults` | object | yes | The values in bridge.config.json (or the built-in defaults). |
| `limits` | object | yes |  |
| `changed` | array of string | no | The fields changed at run time. |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `UNAUTHENTICATED` | 401 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/downloads/settings" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/downloads/settings")
print(response.body)
```
