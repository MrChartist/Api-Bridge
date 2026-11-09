# Check that only the intended routes answer on the public listeners

`POST /v1/expose/check`

| | |
|---|---|
| Area | [System](../README.md#system) |
| Operation | `checkExposure` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

Sends a few probe requests from this computer to each enabled public listener on 127.0.0.1 and reports whether the
dashboard and the API stay hidden, foreign host names and web pages are refused and the body cap holds. With
`publicUrl` it also looks up that host name and calls the public address from this computer, but only when
`allowOutbound` is true; otherwise no name lookup and no outbound request is made.

## Request body

Optional, `application/json`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `kinds` | array of one of `alerts`, `sheets` | no |  |
| `publicUrl` | string | no | Your public address |
| `allowOutbound` | boolean | no | Must be true to test publicUrl. |

Example:

```json
{}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The result. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | object | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data`

| Field | Type | Required | Notes |
|---|---|---|---|
| `verdict` | one of `good`, `notes`, `not_working`, `unsafe`, `not_exposed` | yes |  |
| `headline` | string | yes |  |
| `items` | array of object | yes |  |

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
curl -s -X POST "http://127.0.0.1:4300/v1/expose/check" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("POST", "/v1/expose/check", body={})
print(response.body)
```
