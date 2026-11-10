# Create a collection

`POST /v1/collections`

| | |
|---|---|
| Area | [Collections](../README.md#collections) |
| Operation | `createCollection` |
| Scope | `read` |
| This computer only | no |
| Idempotency-Key | send one on every write |

- An API key with the `read` scope (any key).
- Send an `Idempotency-Key` (8 to 255 characters); a retry with the same key returns the first result.

A static collection holds a list of symbols. An option universe holds a rule that is worked out each time it is used
(`GET /v1/collections/{name}/resolve`). Names are letters, digits and `_ . -`, unique without regard to case.
Writing needs the `paper` scope.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string, up to 255 characters | no | Your unique id for this write (UUID recommended). A retry with the same key and the same body returns the first result with `Idempotency-Replayed: true`; a different body is refused with 409 IDEMPOTENCY_KEY_REUSED; a retry while the first is still running gets 409 IDEMPOTENCY_IN_PROGRESS. Keys are kept until the end of the IST trading day and at least 24 hours. For POST /v1/orders, `clientOrderId` in the body works the same way when the header is absent. The create routes that are not orders honour it too, with the same rules: keys, accounts, hooks, notify targets, collections (create, import, duplicate), downloads, dataset updates, subscriptions, recordings, recording rules and recording presets. For these the stored answer is kept in memory for 24 hours and is forgotten on restart, and a request that failed is forgotten at once so it can be retried. Every other write route ignores the header and says so with `Idempotency-Ignored: true` in the answer. |

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
  "name": "large-caps",
  "description": "My core list",
  "tags": [
    "core"
  ],
  "symbols": [
    "NSE:RELIANCE",
    "NSE:INFY",
    "NSE:TCS"
  ]
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

### Example 201 answer

```json
{
  "data": {
    "id": "col_geh4as5cz7",
    "name": "large-caps",
    "description": "My core list",
    "tags": [
      "core"
    ],
    "kind": "static",
    "createdAt": "2026-11-10T04:05:33.784Z",
    "updatedAt": "2026-11-10T04:05:33.784Z",
    "previousNames": [],
    "symbolCount": 3,
    "symbols": [
      "NSE:RELIANCE",
      "NSE:INFY",
      "NSE:TCS"
    ]
  },
  "meta": {
    "requestId": "req_2f8e1a0c4b7d9e3a5c61"
  }
}
```

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
curl -s -X POST "http://127.0.0.1:4300/v1/collections" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-order-0001" \
  -d '{"name":"large-caps","description":"My core list","tags":["core"],"symbols":["NSE:RELIANCE","NSE:INFY","NSE:TCS"]}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "POST",
    "/v1/collections",
    body={
    "name": "large-caps",
    "description": "My core list",
    "tags": ["core"],
    "symbols": ["NSE:RELIANCE", "NSE:INFY", "NSE:TCS"],
},
    idempotency_key="my-order-0001",
)
print(response.body)
```
