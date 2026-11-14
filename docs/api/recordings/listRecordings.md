# List recordings (meta.status is a plain status line)

`GET /v1/recordings`

| | |
|---|---|
| Area | [Recordings](../README.md#recordings) |
| Operation | `listRecordings` |
| Scope | `read` |
| This computer only | no |

- An API key with the `read` scope (any key).

A recording saves this Bridge's own real-time data going forward, because brokers give no history for option chains, open interest snapshots or ticks. Every item says dataClass realtime.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `limit` | query | integer, min 1, max 500 | no | Page size, 1 to 500. Without it the whole list comes back (`meta.nextCursor` is then null). With it, send `meta.nextCursor` as `cursor` for the next page. |
| `cursor` | query | string, up to 512 characters | no | Opaque cursor from `meta.nextCursor`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The recordings, oldest first. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `Recording` | yes |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data` (`Recording`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `name` | string | yes |  |
| `kind` | one of `quotes`, `chain` | yes |  |
| `status` | one of `recording`, `waiting`, `paused`, `stopped`, `blocked` | yes | waiting: outside the session, or no login yet. blocked: a disk limit was reached; nothing is written until there is room. |
| `statusText` | string | yes | The state in a plain sentence. |
| `auto` | boolean | no | True when a rule runs it. |
| `ruleId` | string or null | no |  |
| `target` | object | no |  |
| `everySec` | integer | yes |  |
| `sessionOnly` | boolean | no |  |
| `schedule` | string or object | no | always, market-hours, or chosen days and hours. |
| `format` | one of `csv`, `jsonl` | no |  |
| `createdAt` | string | no |  |
| `dataClass` | one of `realtime` | yes |  |
| `delaySec` | integer | no |  |
| `source` | string | no |  |
| `symbols` | object | no |  |
| `rows` | integer | yes |  |
| `bytes` | integer | yes |  |
| `today` | object | no |  |
| `lastWriteAt` | string or null | no |  |
| `gaps` | object | no |  |
| `refused` | object | no | Answers that were not real-time and so were not written. |
| `apiCalls` | object | no |  |
| `disk` | object | no |  |
| `keepDays` | integer or null | no |  |
| `nextStartAt` | string or null | no |  |
| `issue` | object or null | no |  |
| `problem` | `FailureReason` or null | no | What is wrong right now (a full disk, no login, symbols that could not be chosen, a silent feed): the real text, its code and the fix. null when all is well. |
| `filesUrl` | string | no |  |
| `files` | object | no | On GET /v1/recordings/{recordingId} only. |

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
curl -s "http://127.0.0.1:4300/v1/recordings" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/recordings")
print(response.body)
```
