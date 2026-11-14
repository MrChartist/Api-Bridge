# Versions, brokers, modules and routes

`GET /v1/meta`

| | |
|---|---|
| Area | [System](../README.md#system) |
| Operation | `getMeta` |
| Scope | `read` |
| This computer only | no |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- An API key with the `read` scope (any key).

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Meta information. | application/json: `MetaInfo` |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `bridgeVersion` | string | yes |  |
| `apiVersion` | string | yes |  |
| `brokerContractVersion` | integer | no |  |
| `installDir` | string | no | For callers on this computer: the folder the Bridge runs from. |
| `dataDir` | string | no | For callers on this computer: the data folder. |
| `cliCommand` | string | no | For callers on this computer: how to run a Bridge command in this setup (`mc-bridge`, or `npm run bridge --` from a checkout). |
| `brokers` | array of string | yes |  |
| `modules` | array of object | yes |  |
| `routes` | array of object | yes |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `UNAUTHENTICATED` | 401 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/meta" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

result = bridge.meta()
print(result)
```
