# The auto-record rules

`GET /v1/recordings/rules`

| | |
|---|---|
| Area | [Recordings](../README.md#recordings) |
| Operation | `listRecordingRules` |
| Scope | `read` |
| This computer only | no |

- An API key with the `read` scope (any key).

Rules from this computer's data folder and from recorder.autoRecord.rules in the config file (source config, read-only here).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `limit` | query | integer, min 1, max 500 | no | Page size, 1 to 500. Without it the whole list comes back (`meta.nextCursor` is then null). With it, send `meta.nextCursor` as `cursor` for the next page. |
| `cursor` | query | string, up to 512 characters | no | Opaque cursor from `meta.nextCursor`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Rules. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `RecordingRule` | yes |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data` (`RecordingRule`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `name` | string, up to 60 characters | yes |  |
| `enabled` | boolean | no | Default `true`. |
| `kind` | one of `quotes`, `chain` | yes |  |
| `symbols` | array of `Symbol` | no |  |
| `collection` | string | no |  |
| `underlying` | string or array of string | no |  |
| `universe` | `RecordingUniverse` | no |  |
| `everySec` | integer, min 1 | yes |  |
| `schedule` | `RecordingSchedule` | no | market-hours (the exchange session of each trading day, from the market calendar) or chosen days and hours (IST; trading days only for NSE, BSE, NFO and BFO). |
| `keepDays` | integer or null | no |  |
| `maxDiskMb` | integer or null | no |  |
| `compress` | boolean | no |  |
| `format` | one of `csv`, `jsonl` | no | Default `"csv"`. |
| `source` | one of `user`, `config` | no |  |
| `preset` | string | no |  |
| `recordingId` | string or null | no | The recording that carries this rule's files. |
| `state` | one of `recording`, `waiting`, `paused`, `stopped`, `blocked`, `off` | no |  |
| `statusText` | string | no |  |
| `blockedBy` | string or null | no |  |
| `createdAt` | string or null | no |  |
| `updatedAt` | string or null | no |  |

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
curl -s "http://127.0.0.1:4300/v1/recordings/rules" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/recordings/rules")
print(response.body)
```
