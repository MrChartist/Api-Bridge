# Ready to take work (503 while starting or when the disk is full)

`GET /v1/ready`

| | |
|---|---|
| Area | [System](../README.md#system) |
| Operation | `getReady` |
| Scope | none (no API key) |
| This computer only | no |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- No API key needed.

No key needed. 200 when the Bridge has finished starting and can save; 503 otherwise. Callers on this computer also see the reasons. For a Docker health check, a load balancer or a script that waits for the Bridge.

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Ready. | application/json: `Ready` |
| 503 | Not ready yet, or the disk is too full to save changes safely. | application/json: `Ready` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `ready` | boolean | yes |  |
| `reasons` | array of object | no | For callers on this computer. |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/ready"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/ready")
print(response.body)
```
