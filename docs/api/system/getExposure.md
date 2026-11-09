# What is set up to be reached from outside this computer

`GET /v1/expose`

| | |
|---|---|
| Area | [System](../README.md#system) |
| Operation | `getExposure` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

Plain-words state of the two optional public listeners (`server.publicIngress` for webhook alerts, `server.sheetsIngress`
for Google Sheets), the address patterns to use, and the exposure checks that `mc-bridge doctor` also runs, each with
a one-line fix. It reads the settings the Bridge started with; it changes nothing and calls nothing outside this
computer. Setting up is the terminal command `mc-bridge expose`.

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The exposure state. | application/json: object |
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
| `state` | one of `off`, `on` | yes |  |
| `exposed` | array of one of `alerts`, `sheets` | yes |  |
| `headline` | string | yes |  |
| `tone` | one of `ok`, `warn`, `bad` | yes |  |
| `alerts` | `ExposeListener` | yes |  |
| `sheets` | `ExposeListener` | yes |  |
| `checks` | array of object | yes |  |
| `restartNote` | string | no |  |
| `guide` | string (uri) | no |  |

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
curl -s "http://127.0.0.1:4300/v1/expose" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/expose")
print(response.body)
```
