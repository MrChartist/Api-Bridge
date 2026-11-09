# This document

`GET /openapi.yaml`

| | |
|---|---|
| Area | [System](../README.md#system) |
| Operation | `getOpenApi` |
| Scope | none (no API key) |
| This computer only | no |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- No API key needed.

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | OpenAPI 3.1 YAML. | application/yaml: string |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/openapi.yaml"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/openapi.yaml")
print(response.body)
```
