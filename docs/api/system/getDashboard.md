# Local dashboard (HTML; this computer only)

`GET /dashboard`

| | |
|---|---|
| Area | [System](../README.md#system) |
| Operation | `getDashboard` |
| Scope | none (no API key) |
| This computer only | yes |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- No API key needed.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

Welcome checklist, accounts and the broker directory, a test console, live rate-limit usage, orders and pending confirmations, the kill switch, API keys, integration snippets and the request and audit logs. The page asks for an API key and keeps it in the browser tab only.

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The dashboard page. | text/html: string |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `LOOPBACK_ONLY` | 403 | no |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/dashboard"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/dashboard")
print(response.body)
```
