# Make a backup now

`POST /v1/backup`

| | |
|---|---|
| Area | [Backup](../README.md#backup) |
| Operation | `createBackup` |
| Scope | `admin` |
| This computer only | yes |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

This computer only, admin key. Writes one verified archive (tar.gz, mode 600) into the backups folder of the data folder and answers with its path on this computer. It holds the settings file, API key records, accounts, safety and quota state, source settings, pooling consent, paper books, order records and the audit log. It never holds the master key. `secrets.enc` (saved broker logins) is included only with `includeSecrets`, and is useful only with the original master key. Emits the bus events `backup.completed` or `backup.failed`. Downloads and recordings are left out by default (they are large and can be downloaded or recorded again); send `includeData: true` (or set `backup.includeData`) to add them, streamed.

## Request body

Optional, `application/json`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `includeSecrets` | boolean | no | Default `false`. |
| `includeData` | boolean | no | Also put the downloads and recordings folders in the backup. Default: the `backup.includeData` setting (false). |

Example:

```json
{}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The backup was written. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `BackupCreated` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`BackupCreated`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `path` | string | yes | Where the archive is on this computer. Copy it to another disk. |
| `name` | string | yes |  |
| `bytes` | integer | yes |  |
| `files` | integer | yes |  |
| `createdAt` | string (date-time) | yes |  |
| `kind` | one of `manual` | yes |  |
| `includesSecrets` | boolean | yes |  |
| `includesData` | boolean | no | True when the downloads and recordings folders are in the archive (includeData). |
| `masterKeyIncluded` | one of `false` | yes | Always false: the master key is never part of a backup. |
| `restoreCommand` | string | yes |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `LOOPBACK_ONLY` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/backup" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("POST", "/v1/backup", body={})
print(response.body)
```
