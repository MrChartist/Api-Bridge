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
| `status` | one of `ok`, `degraded` | yes | `degraded` when something needs attention: little free disk space, a file that could not be saved, a damaged file set aside, the order records damaged, or the kill switch on. The HTTP status stays 200; callers on this computer see `problems`. |
| `version` | string | yes |  |
| `apiVersion` | string | yes |  |
| `problems` | array of object | no | For callers on this computer. What is wrong, in plain words. Empty when status is ok. |
| `storage` | object | no | For callers on this computer. Free space on the data folder's disk and how many files could not be saved. |
| `startedAt` | string (date-time) | no |  |
| `uptimeSeconds` | integer | no |  |
| `sources` | object | no | How many data sources there are and how many are switched on. |
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
