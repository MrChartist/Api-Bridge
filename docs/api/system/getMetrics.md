# The Bridge's own numbers (Prometheus text)

`GET /v1/metrics`

| | |
|---|---|
| Area | [System](../README.md#system) |
| Operation | `getMetrics` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

This computer only, admin key. Counters and gauges as plain Prometheus text: uptime, memory, open file handles, event-loop delay, requests by status class, free disk space, failed writes, damaged files set aside, the age of the last backup, webhook queue sizes, download and recording figures. No symbol, key, account id or file name appears in it.

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Prometheus text exposition format. | text/plain: string |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

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
curl -s "http://127.0.0.1:4300/v1/metrics" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/metrics")
print(response.body)
```
