# Liveness check

`GET /v1/health`

| | |
|---|---|
| Area | [System](../README.md#system) |
| Operation | `getHealth` |
| Scope | none (no API key) |
| This computer only | no |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- No API key needed.

No key needed. Callers on this computer also see which services are built.

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The Bridge is running. | application/json: `Health` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | one of `ok` | yes |  |
| `version` | string | yes |  |
| `apiVersion` | string | yes |  |
| `startedAt` | string (date-time) | no |  |
| `uptimeSeconds` | integer | no |  |
| `demo` | boolean | no | Present and true only in demo mode (sample data, no real broker). |
| `dataNotice` | string | no | In demo mode: a plain sentence saying the data is sample data. |
| `services` | object | no |  |
| `backup` | object | no | For callers on this computer. When the last backup was made, whether the last one failed, and whether the daily schedule is on. |
| `startup` | object | no | Present only while the Bridge is starting and holds positions, funds, orders, trades and the book (at most 20 s) until its start-up jobs finish (in demo mode, the demo book seed), so no client reads a partial book. Each job's progress lets a page show it instead of a silent wait. Absent once those reads answer. |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/health"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.health()
print(result)
```
