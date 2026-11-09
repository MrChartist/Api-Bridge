# The last backup, the schedule and the copies kept on this computer

`GET /v1/backup`

| | |
|---|---|
| Area | [Backup](../README.md#backup) |
| Operation | `getBackup` |
| Scope | `admin` |
| This computer only | yes |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

This computer only, admin key. Lists the archives in the backups folder inside the data folder (name, size, time, kind) and the last success or failure. The archives themselves are never served over HTTP.

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Backup status. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `BackupStatus` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`BackupStatus`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `lastBackupAt` | string (date-time) or null (date-time) | yes |  |
| `lastBackupBytes` | integer or null | yes |  |
| `lastBackupKind` | string or null | yes |  |
| `lastError` | object or null | yes | The last backup that failed, until a later backup of the same kind succeeds. |
| `schedule` | object | yes |  |
| `keep` | integer | yes | Snapshots kept per kind (before an upgrade, before a restore). |
| `folder` | string | yes |  |
| `items` | array of `BackupFile` | yes |  |
| `restoreCommand` | string | yes |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `UNAUTHENTICATED` | 401 | no |
| `LOOPBACK_ONLY` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/backup" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/backup")
print(response.body)
```
