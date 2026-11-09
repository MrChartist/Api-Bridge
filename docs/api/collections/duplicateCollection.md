# Copy a collection under a new name

`POST /v1/collections/{name}/duplicate`

| | |
|---|---|
| Area | [Collections](../README.md#collections) |
| Operation | `duplicateCollection` |
| Scope | `paper` |
| This computer only | no |

- An API key with the `paper` scope (or `live`).

Without a name the copy is called `<name>-copy` (then `-copy2` ...).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `name` | path | string, up to 64 characters | yes |  |

## Request body

Optional, `application/json`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |

Example:

```json
{}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 201 | The copy. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 201 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `Collection` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`Collection`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Stable; survives a rename. |
| `name` | string | yes |  |
| `description` | string | yes |  |
| `tags` | array of string | yes | Lower case, sorted. |
| `kind` | one of `static`, `option-universe` | yes |  |
| `symbols` | array of `Symbol` | no | Static collections, on a single read (not in the list). |
| `symbolCount` | integer or null | no | Static collections: how many symbols. Null for an option universe (it depends on the day). |
| `universe` | `CollectionUniverse` | no | An option universe: which contracts of one underlying, worked out each time the collection is used. |
| `previousNames` | array of string | yes |  |
| `viaOldName` | boolean | no | Only when the request used a name the collection had before a rename. |
| `createdAt` | string (date-time) | yes |  |
| `updatedAt` | string (date-time) | yes |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/collections/<name>/duplicate" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("POST", "/v1/collections/<name>/duplicate", body={})
print(response.body)
```
