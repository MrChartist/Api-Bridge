# List collections (static lists and option universes)

`GET /v1/collections`

| | |
|---|---|
| Area | [Collections](../README.md#collections) |
| Operation | `listCollections` |
| Scope | `read` |
| This computer only | no |

- An API key with the `read` scope (any key).

Summaries without symbol lists, ordered by name. `tag` may repeat or be comma separated; a collection must have every tag asked for.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `tag` | query | string | no | Tags to match, all of them (comma separated, or repeat the parameter). |
| `kind` | query | one of `static`, `option-universe` | no |  |
| `q` | query | string, up to 64 characters | no | Text found in the name, description or a tag. |
| `limit` | query | integer, min 1, max 500 | no | Page size, 1 to 500. Without it the whole list comes back (`meta.nextCursor` is then null). With it, send `meta.nextCursor` as `cursor` for the next page. |
| `cursor` | query | string, up to 512 characters | no | Opaque cursor from `meta.nextCursor`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Collections. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `Collection` | yes |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data` (`Collection`)

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
| `createdBy` | string or null | no | Who made it (key:<id> or local). Only that key, or an admin key, may change or delete it. Null for one made before owners were recorded (admin only). |
| `viaOldName` | boolean | no | Only when the request used a name the collection had before a rename. |
| `createdAt` | string (date-time) | yes |  |
| `updatedAt` | string (date-time) | yes |  |

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
curl -s "http://127.0.0.1:4300/v1/collections" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/collections")
print(response.body)
```
