# Stop a recording (final; the files stay)

`POST /v1/recordings/{id}/stop`

| | |
|---|---|
| Area | [Recordings](../README.md#recordings) |
| Operation | `stopRecording` |
| Scope | `admin` |
| This computer only | yes |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

A recording that belongs to a rule is changed through the rule (409 otherwise).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | string | yes |  |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The recording. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `Recording` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`Recording`)

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
| `filesUrl` | string | no |  |
| `files` | object | no | On GET /v1/recordings/{id} only. |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `LOOPBACK_ONLY` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/recordings/demo/stop" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("POST", "/v1/recordings/demo/stop")
print(response.body)
```
