# Create a collection

`POST /v1/collections`

| | |
|---|---|
| Area | [Collections](../README.md#collections) |
| Operation | `createCollection` |
| Scope | `paper` |
| This computer only | no |

- An API key with the `paper` scope (or `live`).

A static collection holds a list of symbols. An option universe holds a rule that is worked out each time it is used
(`GET /v1/collections/{name}/resolve`). Names are letters, digits and `_ . -`, unique without regard to case.
Writing needs the `paper` scope.

## Request body

Required, `application/json`, schema `CollectionCreate`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes |  |
| `description` | string, up to 500 characters | no |  |
| `tags` | array of string | no |  |
| `kind` | one of `static`, `option-universe` | no | Optional: a body with `universe` is an option universe, otherwise static. |
| `symbols` | array of string, up to 80 characters | no | Static: canonical symbols (a lenient spelling is rewritten to canonical). |
| `universe` | `CollectionUniverse` | no | An option universe: which contracts of one underlying, worked out each time the collection is used. |

Example:

```json
{
  "name": "<name>"
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 201 | Created. | application/json: object |
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
curl -s -X POST "http://127.0.0.1:4300/v1/collections" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"<name>"}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("POST", "/v1/collections", body={"name": "<name>"})
print(response.body)
```
