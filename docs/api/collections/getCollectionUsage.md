# What is made from this collection

`GET /v1/collections/{name}/usage`

| | |
|---|---|
| Area | [Collections](../README.md#collections) |
| Operation | `getCollectionUsage` |
| Scope | `read` |
| This computer only | no |

- An API key with the `read` scope (any key).

The downloads, recordings, auto-record rules and datasets that use it. A kind marked `not-available` in `sources` is kept by a part of the Bridge that is off, so it is not counted.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `name` | path | string, up to 64 characters | yes |  |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Usage. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `CollectionUsage` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`CollectionUsage`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `name` | string | yes |  |
| `lastResolvedAt` | string or null | no | Since the Bridge started. |
| `downloads` | array of object | yes |  |
| `recordings` | array of object | yes |  |
| `rules` | array of object | yes |  |
| `datasets` | array of object | yes |  |
| `total` | integer | yes |  |
| `sources` | object | yes |  |
| `note` | string or null | no |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/collections/<name>/usage" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/collections/<name>/usage")
print(response.body)
```
