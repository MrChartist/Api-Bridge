# Download jobs, newest first

`GET /v1/downloads`

| | |
|---|---|
| Area | [Data downloads](../README.md#data-downloads) |
| Operation | `listDownloads` |
| Scope | `read` |
| This computer only | no |

- An API key with the `read` scope (any key).

The list leaves out each job's `items` unless `include=items`.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `status` | query | `DownloadStatus` | no |  |
| `tag` | query | string, up to 32 characters | no |  |
| `include` | query | one of `items` | no |  |
| `limit` | query | integer, min 1, max 500 | no | Default `100`. |
| `cursor` | query | string, up to 512 characters | no | Opaque cursor from `meta.nextCursor`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Jobs. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `DownloadJob` | yes |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data` (`DownloadJob`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `name` | string | yes |  |
| `status` | `DownloadStatus` | yes |  |
| `reason` | string or null | no | Why a job is paused or failed: user, kill_switch, session_lost, market_hours, disk_limit, items_failed, restart or internal. |
| `message` | string or null | no | A plain sentence about the reason. |
| `progress` | object | yes |  |
| `items` | array of object | no | Left out of the list answer unless include=items. |
| `request` | object | yes | The request as the Bridge understood it. |
| `dataset` | string or null | no |  |
| `collection` | object | no | Present when the symbols came from a collection. |
| `tags` | array of string | no |  |
| `dataClass` | `DataClass` | yes | How current an answer is. `realtime`: from your own broker account (or its live stream). `delayed`: the source is slow by nature (usually about 15 minutes). `eod`: end-of-day values only. A composite answer (an option chain, a many-symbol quote) takes the least current class of its parts. `delayed` is not the same as `freshness.stale`: stale means older than the freshness target for that source. |
| `source` | string or null | no | Where the bars came from (broker id or data source). |
| `official` | boolean or null | no |  |
| `delaySec` | integer or null | no |  |
| `callsSaved` | integer | no | Broker calls this job did not need because the data was already stored. |
| `notes` | array of string | no | Gaps found, bars served from a dataset, and the data-class warning. |
| `createdAt` | string (date-time) | yes |  |
| `startedAt` | string (date-time) or null (date-time) | no |  |
| `finishedAt` | string (date-time) or null (date-time) | no |  |
| `manifestUrl` | string | yes |  |

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
curl -s "http://127.0.0.1:4300/v1/downloads" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/downloads")
print(response.body)
```
