# Rename a dataset or change its tags and title

`PATCH /v1/datasets/{name}`

| | |
|---|---|
| Area | [Data downloads](../README.md#data-downloads) |
| Operation | `updateDatasetInfo` |
| Scope | `read` |
| This computer only | no |

- An API key with the `read` scope (any key).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `name` | path | string | yes |  |

## Request body

Required, `application/json`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | no |  |
| `title` | string, up to 120 characters or null | no |  |
| `tags` | array of string, up to 32 characters | no |  |

Example:

```json
{}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The dataset. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `Dataset` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`Dataset`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes |  |
| `title` | string or null | no |  |
| `tags` | array of string | no |  |
| `format` | one of `csv`, `jsonl`, `amibroker` | yes |  |
| `createdAt` | string (date-time) | no |  |
| `updatedAt` | string (date-time) or null (date-time) | no |  |
| `request` | object | no |  |
| `dataClass` | `DataClass` | no | How current an answer is. `realtime`: from your own broker account (or its live stream). `delayed`: the source is slow by nature (usually about 15 minutes). `eod`: end-of-day values only. A composite answer (an option chain, a many-symbol quote) takes the least current class of its parts. `delayed` is not the same as `freshness.stale`: stale means older than the freshness target for that source. |
| `source` | string or null | no |  |
| `official` | boolean or null | no |  |
| `delaySec` | integer or null | no |  |
| `series` | integer | yes | Number of symbol and interval files. |
| `rows` | integer | yes |  |
| `bytes` | integer | yes |  |
| `gaps` | integer | no | Stretches with missing bars, over all files. |
| `lastJobId` | string or null | no |  |
| `createdBy` | string or null | no | The key that created the dataset. Only that key, or an admin, may write into it with a new job, rename it or tag it; any read key may ask for its update. |
| `activeJobId` | string or null | no | A job that is queued, running or paused for this dataset. |
| `files` | array of object | no | Only on GET /v1/datasets/{name}. |
| `notes` | array of string | no |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X PATCH "http://127.0.0.1:4300/v1/datasets/<name>" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("PATCH", "/v1/datasets/<name>", body={})
print(response.body)
```
