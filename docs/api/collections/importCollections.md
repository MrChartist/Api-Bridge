# Make collections from CSV or JSON

`POST /v1/collections/import`

| | |
|---|---|
| Area | [Collections](../README.md#collections) |
| Operation | `importCollections` |
| Scope | `paper` |
| This computer only | no |

- An API key with the `paper` scope (or `live`).

JSON: a collection (`{ name, kind, symbols | universe }`), a plain list of symbols (with `name` in the query), a file
that `GET /v1/collections/{name}/export` wrote, or `{ collections: [...] }`. CSV: send the text as `text/plain` with
`name` in the query (or as JSON `{ format: "csv", csv, name }`); the symbols are in a column named `symbol`, or the
first column when there is no header. Everything is checked first: one bad entry imports nothing, unless `skipInvalid`
is true for a CSV.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `name` | query | string | no | Name of the new collection (required for CSV and for a plain list). |
| `format` | query | one of `csv`, `json` | no |  |
| `tags` | query | string | no | Comma separated tags for a single collection. |
| `description` | query | string, up to 500 characters | no |  |
| `replace` | query | boolean | no | Replace a collection of the same name instead of answering 409. Default `false`. |
| `skipInvalid` | query | boolean | no | CSV only: skip lines that are not symbols and import the rest. Default `false`. |

## Request body

Required, `application/json`.

A JSON object.

Example:

```json
{}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 201 | Imported. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 201 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | object | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data`

| Field | Type | Required | Notes |
|---|---|---|---|
| `created` | array of `Collection` | yes |  |
| `replaced` | array of `Collection` | yes |  |
| `warnings` | array of string | yes |  |

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
curl -s -X POST "http://127.0.0.1:4300/v1/collections/import" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("POST", "/v1/collections/import", body={})
print(response.body)
```
