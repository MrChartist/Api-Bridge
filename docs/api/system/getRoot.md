# Redirect to the local dashboard

`GET /`

| | |
|---|---|
| Area | [System](../README.md#system) |
| Operation | `getRoot` |
| Scope | none (no API key) |
| This computer only | yes |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- No API key needed.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

## Responses

| Status | Meaning | Body |
|---|---|---|
| 302 | Redirect to /dashboard. |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `LOOPBACK_ONLY` | 403 | no |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/")
print(response.body)
```
