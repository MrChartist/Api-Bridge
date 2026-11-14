# Sign the dashboard on this computer in without a key

`POST /v1/sign-in/local`

| | |
|---|---|
| Area | [Keys](../README.md#keys) |
| Operation | `signInLocal` |
| Scope | none (no API key) |
| This computer only | yes |
| Guide | [safety.md](../../guides/safety.md) |

- No API key needed.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

Used by the dashboard when it is opened on the computer the Bridge runs on with no key and no sign-in link.
Being on this computer stands in for the credential: the request must come from a loopback address, be
addressed to a loopback host name, carry no proxy headers and not arrive on the public listener, and it must
carry the Bridge's own `Origin` (so only the dashboard page the Bridge serves can ask, not another web site
and not a script). It creates a new admin key (scopes admin and paper, all accounts, label "Dashboard on this
computer") that expires in 30 days; audited `key.created`. Only the newest 5 such keys stay valid. At most
20 a minute. Switched off with `server.keylessSignIn: false`, and off by default when `server.localPeers` is
set or the dashboard is served to other computers; then it answers 403 and the dashboard asks for a key.

## Request body

Optional, `application/json`.

A JSON object.

Example:

```json
{}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 201 | Signed in. The key is shown once. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 201 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `KeyCreated` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`KeyCreated`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `key` | string | yes | Shown once. |
| `record` | `KeyRecord` | yes |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `LOOPBACK_ONLY` | 403 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/sign-in/local" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("POST", "/v1/sign-in/local", body={})
print(response.body)
```
