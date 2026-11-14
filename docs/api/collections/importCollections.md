# Make collections from CSV or JSON

`POST /v1/collections/import`

| | |
|---|---|
| Area | [Collections](../README.md#collections) |
| Operation | `importCollections` |
| Scope | `read` |
| This computer only | no |
| Idempotency-Key | send one on every write |

- An API key with the `read` scope (any key).
- Send an `Idempotency-Key` (8 to 255 characters); a retry with the same key returns the first result.

JSON: a collection (`{ name, kind, symbols | universe }`), a plain list of symbols (with `name` in the query), a file
that `GET /v1/collections/{name}/export` wrote, or `{ collections: [...] }`. CSV: send the text as `text/plain` with
`name` in the query (or as JSON `{ format: "csv", csv, name }`); the symbols are in a column named `symbol`, or the
first column when there is no header. Everything is checked first: one bad entry imports nothing, unless `skipInvalid`
is true for a CSV. `replace=true` (replace collections that already exist) needs an admin key, from this computer.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string, up to 255 characters | no | Your unique id for this write (UUID recommended). A retry with the same key and the same body returns the first result with `Idempotency-Replayed: true`; a different body is refused with 409 IDEMPOTENCY_KEY_REUSED; a retry while the first is still running gets 409 IDEMPOTENCY_IN_PROGRESS. Keys are kept until the end of the IST trading day and at least 24 hours. For POST /v1/orders, `clientOrderId` in the body works the same way when the header is absent. The create routes that are not orders honour it too, with the same rules: keys, accounts, hooks, notify targets, collections (create, import, duplicate), downloads, dataset updates, subscriptions, recordings, recording rules and recording presets. For these the stored answer is kept in memory for 24 hours and is forgotten on restart, and a request that failed is forgotten at once so it can be retried. The compat order routes (`/api/v1/placeorder` and the other order writes) honour it too, and a client that cannot set headers may send `idempotency_key` in the body. Every other write route ignores the header, whatever its value, and says so with `Idempotency-Ignored: true` in the answer; a malformed key is a 400 only on a route that uses it. |
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
{
  "name": "from-a-file",
  "symbols": [
    "NSE:RELIANCE",
    "NSE:INFY"
  ]
}
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
| `IDEMPOTENCY_IN_PROGRESS` | 409 | yes |
| `IDEMPOTENCY_KEY_REUSED` | 409 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/collections/import" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-order-0001" \
  -d '{"name":"from-a-file","symbols":["NSE:RELIANCE","NSE:INFY"]}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "POST",
    "/v1/collections/import",
    body={"name": "from-a-file", "symbols": ["NSE:RELIANCE", "NSE:INFY"]},
    idempotency_key="my-order-0001",
)
print(response.body)
```
