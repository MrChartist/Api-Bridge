# Exchange a one-time sign-in code for a dashboard key

`POST /v1/sign-in`

| | |
|---|---|
| Area | [Keys](../README.md#keys) |
| Operation | `signIn` |
| Scope | none (no API key) |
| This computer only | yes |
| Guide | [safety.md](../../guides/safety.md) |

- No API key needed.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

Used by the dashboard when it is opened from `mc-bridge start --open` or `mc-bridge open`, whose link carries a
one-time code in the URL fragment (`/dashboard#signin=<code>`, never sent to the server in a URL). The code is
valid for 10 minutes and works once; only its SHA-256 hash is stored. A valid code creates a new admin key
(scopes admin and paper, all accounts, label "Dashboard sign-in") that expires in 30 days; audited `key.created`.
A wrong, expired or used code gets one generic 401. After 20 failed attempts in a minute the route answers 429
for the rest of that minute. No API key needed; this computer only.

## Request body

Required, `application/json`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `code` | string | yes | The code from the sign-in link. |

Example:

```json
{
  "code": "<one-time code from mc-bridge open>"
}
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
curl -s -X POST "http://127.0.0.1:4300/v1/sign-in" \
  -H "Content-Type: application/json" \
  -d '{"code":"<one-time code from mc-bridge open>"}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "POST",
    "/v1/sign-in",
    body={"code": "<one-time code from mc-bridge open>"},
)
print(response.body)
```
