# Change a collection, or rename it (send `name`)

`PATCH /v1/collections/{name}`

| | |
|---|---|
| Area | [Collections](../README.md#collections) |
| Operation | `updateCollection` |
| Scope | `paper` |
| This computer only | no |

- An API key with the `paper` scope (or `live`).

A rename keeps the collection's id and its old name keeps working. The kind cannot change.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `name` | path | string, up to 64 characters | yes | The collection's name or id. A name it had before a rename also finds it (the answer says `viaOldName`). |

## Request body

Required, `application/json`, schema `CollectionPatch`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no | Rename. The old name keeps finding the collection. |
| `description` | string, up to 500 characters | no |  |
| `tags` | array of string | no |  |
| `symbols` | array of string | no |  |
| `universe` | `CollectionUniverse` | no | An option universe: which contracts of one underlying, worked out each time the collection is used. |

Example:

```json
{}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The changed collection. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

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
curl -s -X PATCH "http://127.0.0.1:4300/v1/collections/<name>" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("PATCH", "/v1/collections/<name>", body={})
print(response.body)
```
