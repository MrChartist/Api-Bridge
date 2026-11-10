# Start a history download, or only estimate it with dryRun=1

`POST /v1/downloads`

| | |
|---|---|
| Area | [Data downloads](../README.md#data-downloads) |
| Operation | `createDownload` |
| Scope | `read` |
| This computer only | no |
| Idempotency-Key | send one on every write |

- An API key with the `read` scope (any key).
- Send an `Idempotency-Key` (8 to 255 characters); a retry with the same key returns the first result.

Saves candles to files on this computer as a background job. Give `symbols` (canonical, at most 500) or the name of a `collection`, one or more `intervals`, and `from`. Every broker call goes through the rate-limit scheduler at the lowest priority and within `downloads.maxBudgetShare` of the account's budget (default 0.3), so live reads, order checks and other keys always go first. The job is saved after every window and continues after a pause, a restart, the kill switch or a lost login. With `dataset`, the job continues from the last stored bar of that dataset. Ranges already stored in a dataset of this Bridge are copied from disk instead of fetched again. With `dryRun=1` nothing starts and the answer is the estimate (broker calls, rows, bytes, time at your share). The bar still forming is never stored.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string, up to 255 characters | no | Your unique id for this write (UUID recommended). A retry with the same key and the same body returns the first result with `Idempotency-Replayed: true`; a different body is refused with 409 IDEMPOTENCY_KEY_REUSED; a retry while the first is still running gets 409 IDEMPOTENCY_IN_PROGRESS. Keys are kept until the end of the IST trading day and at least 24 hours. For POST /v1/orders, `clientOrderId` in the body works the same way when the header is absent. The create routes that are not orders honour it too, with the same rules: keys, accounts, hooks, notify targets, collections (create, import, duplicate), downloads, dataset updates, subscriptions, recordings, recording rules and recording presets. For these the stored answer is kept in memory for 24 hours and is forgotten on restart, and a request that failed is forgotten at once so it can be retried. Every other write route ignores the header and says so with `Idempotency-Ignored: true` in the answer. |
| `dryRun` | query | boolean | no | `1` or `true` returns the estimate and starts nothing. Default `false`. |

## Request body

Required, `application/json`, schema `DownloadRequest`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string, up to 80 characters | no |  |
| `symbols` | array of string, up to 64 characters | no | Canonical symbols such as NSE:NIFTY. |
| `collection` | string, up to 64 characters | no | The name of a collection; it is resolved when the job starts. |
| `intervals` | array of `Interval` | yes |  |
| `from` | string | yes | ISO date or date-time (IST when no offset), or epoch seconds. For an existing dataset the job continues from its last stored bar. |
| `to` | string | no | Default: now. The bar still forming is never stored. |
| `format` | one of `csv`, `jsonl`, `amibroker` | no | Default `"csv"`. |
| `layout` | one of `per-symbol`, `combined` | no | combined writes one file per interval with a symbol column. A dataset is always per-symbol. Default `"per-symbol"`. |
| `dataset` | string | no | Continue (or create) this dataset instead of writing a one-off set of files. |
| `account` | string | no | Use only this broker account. |
| `backup` | boolean | no | Allow data sources other than your broker accounts. The files then carry the source's data class (delayed or eod). Default `false`. |
| `afterHoursOnly` | boolean | no | Wait outside market hours. Default: follows the downloads setting when the job runs (downloads.afterHoursOnly, or GET /v1/downloads/settings). |
| `allowExpired` | boolean | no | Accept symbols of contracts that have already expired (they are in no instrument master) to download their history. Without it an unknown or expired symbol is refused with 400 VALIDATION_FAILED, the unknown symbols are named in `unknownSymbols`, each with suggestions. Default `false`. |
| `tags` | array of string, up to 32 characters | no |  |

Example:

```json
{
  "symbols": [
    "NSE:RELIANCE",
    "NSE:INFY"
  ],
  "intervals": [
    "1d"
  ],
  "from": "2026-10-01",
  "dataset": "large-caps-1d"
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The estimate (dryRun only). | application/json: object |
| 202 | The job was accepted and is queued. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `DownloadEstimate` | yes | What a download will cost. Rows assume every trading minute has a bar, so a thin stock has fewer; the time assumes the broker's published limit is the only limit. |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`DownloadEstimate`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `symbols` | integer | no |  |
| `intervals` | integer | no |  |
| `items` | integer | no |  |
| `brokerCalls` | integer | no | Calls the broker will see, after what is already stored on this computer. |
| `callsSaved` | integer | no | Calls not needed because that part is already stored. |
| `rows` | integer | no |  |
| `rowsToFetch` | integer | no |  |
| `bytes` | integer | no |  |
| `bytesPerRow` | integer | no |  |
| `etaSec` | integer or null | no | Seconds at your budget share; null when no account is known. |
| `callsPerSecond` | number or null | no |  |
| `limitingWindow` | string or null | no | The broker window that sets the pace (1s, 1m, 1h or day). |
| `budgetShare` | number | no |  |
| `account` | string or null | no |  |
| `broker` | string or null | no |  |
| `alreadyStored` | integer | no | Items that need no broker call at all. |
| `disk` | object | no |  |
| `notes` | array of string | no |  |

### Example 202 answer

```json
{
  "data": {
    "id": "dl_435e6691d280",
    "name": "large-caps-1d",
    "status": "queued",
    "reason": null,
    "message": null,
    "progress": {
      "total": 2,
      "done": 0,
      "failed": 0,
      "rows": 0,
      "bytes": 0,
      "etaSec": null,
      "current": null,
      "waiting": null
    },
    "request": {
      "symbols": [
        "NSE:RELIANCE",
        "NSE:INFY"
      ],
      "intervals": [
        "1d"
      ],
      "from": "2026-10-01",
      "to": null,
      "format": "csv",
      "layout": "per-symbol",
      "dataset": "large-caps-1d",
      "account": null,
      "backup": false,
      "afterHoursOnly": false
    },
    "dataset": "large-caps-1d",
    "tags": [],
    "dataClass": "realtime",
    "source": null,
    "official": null,
    "delaySec": null,
    "callsSaved": 0,
    "notes": [],
    "createdAt": "2026-11-10T04:05:25.794Z",
    "startedAt": null,
    "finishedAt": null,
    "manifestUrl": "/v1/downloads/dl_435e6691d280/files/manifest.json",
    "items": [
      {
        "symbol": "NSE:RELIANCE",
        "interval": "1d",
        "status": "pending",
        "rows": 0
      },
      {
        "symbol": "NSE:INFY",
        "interval": "1d",
        "status": "pending",
        "rows": 0
      }
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
curl -s -X POST "http://127.0.0.1:4300/v1/downloads" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-order-0001" \
  -d '{"symbols":["NSE:RELIANCE","NSE:INFY"],"intervals":["1d"],"from":"2026-10-01","dataset":"large-caps-1d"}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "POST",
    "/v1/downloads",
    body={
    "symbols": ["NSE:RELIANCE", "NSE:INFY"],
    "intervals": ["1d"],
    "from": "2026-10-01",
    "dataset": "large-caps-1d",
},
    idempotency_key="my-order-0001",
)
print(response.body)
```
