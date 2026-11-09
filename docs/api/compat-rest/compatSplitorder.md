# One order split into pieces

`POST /api/v1/splitorder`

| | |
|---|---|
| Area | [Compat REST](../README.md#compat-rest) |
| Operation | `compatSplitorder` |
| Scope | `apikey` in the body (read for data, paper or live for orders) |
| This computer only | no |
| Guide | [compat-api.md](../../guides/compat-api.md) |

- Send your Bridge API key as `apikey` in the JSON body (no Authorization header).

## Request body

Required, `application/json`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `apikey` | string | yes | A Bridge API key (read for data, paper or live for orders). |
| `account` | string | no | Bridge extension: the account to act on (default compat.account, then the first the key may use). |

Example:

```json
{
  "apikey": "<apikey>"
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Compat-style reply. | application/json: `CompatReply` |
| 4XX | Compat-style error reply. | application/json: `CompatReply` |
| 5XX | Compat-style error reply. | application/json: `CompatReply` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | one of `success`, `error` | yes |  |
| `message` | string | no |  |
| `mode` | one of `analyze` | no | Present while analyzer (paper) mode is on. |
| `data` | any | no |  |
| `orderid` | string or null | no |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |

## Examples

curl (set `MCB_API_KEY` to your key first; replace `YOUR_API_KEY` in the body):

```bash
curl -s -X POST "http://127.0.0.1:4300/api/v1/splitorder" \
  -H "Content-Type: application/json" \
  -d '{"apikey":"<apikey>"}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("POST", "/api/v1/splitorder", body={"apikey": "<apikey>"})
print(response.body)
```
